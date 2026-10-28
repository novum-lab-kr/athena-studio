// @ts-check
// 맥 배포판 만들기 — electron-builder 로 .dmg · .zip(칩마다 따로). 결과는 dist/release/(git 무시)
//   npm run package:mac [-- --arch arm64|x64|all] [--version X.Y.Z]
//     1. 화면 빌드(vite → dist/renderer · scripts/dev-app.js 와 같은 설정)
//     2. 코어 번들 — 레포 athena/ 의 커밋된 기록(HEAD:athena)을 git 번들로 dist/package/ 에 만들고 extraResources 로
//        앱 Contents/Resources/athena-core.bundle 에 넣는다(src/lib/studio-home.js coreBundlePath 의 배포판 자리)
//     3. electron-builder — 이름 Athena Studio · 번들 ID kr.novum-lab.athena-studio · 파일 이름 Athena-Studio-mac-<arch>.dmg · .zip
//   버전: --version 이 없으면 git 태그(git describe — 태그 커밋이면 0.13.35, 뒤 커밋이 있으면 0.13.35+1). 앱 app.getVersion() 이 이 번호
//   서명: CSC_LINK(+ CSC_KEY_PASSWORD) 가 있으면 그 Developer ID 인증서로, 없으면 이 컴퓨터용(ad-hoc '-') — 1단계는 ad-hoc
//         공증: APPLE_API_KEY(.p8 파일 경로) · APPLE_API_KEY_ID · APPLE_API_ISSUER 가 모두 있으면 electron-builder 가 notarytool 로(2단계)
// 순수 부분(builderConfig · artifactName · resolveVersion)은 test/package-mac.test.js 가 Electron · electron-builder 없이 본다
const fs = require('fs')
const path = require('path')
const studioHome = require('../src/lib/studio-home')
const version = require('../src/lib/version')

const ROOT = path.join(__dirname, '..')
const OUTPUT = path.join(ROOT, 'dist', 'release')
const STAGING = path.join(ROOT, 'dist', 'package')
const ARCHES = ['arm64', 'x64']

const APP_ID = 'kr.novum-lab.athena-studio'
const PRODUCT_NAME = 'Athena Studio' // src/lib/studio-home.js appIdentity({ packaged: true }).name 과 같다(앱 데이터 폴더 이름)
// Electron 44 는 macOS 13(Ventura) 이상 — Electron v44 breaking-changes "Removed: macOS 12 support" · Electron.app Info.plist LSMinimumSystemVersion 13.0
const MINIMUM_MACOS = '13.0'
const ICON = path.join(ROOT, 'src', 'renderer', 'assets', 'logo', 'athena-app-icon.png') // 1024 · 개발 앱과 같은 아이콘
const ENTITLEMENTS = path.join(ROOT, 'build', 'entitlements.mac.plist')

// 배포판에 들고 갈 파일 — 화면은 dist/renderer(빌드) · main 이 여는 로고 · src(main · 데몬 · lib · i18n) · 데몬 CLI(bin)
// node_modules 는 electron-builder 가 dependencies 만 담는다. 그중 화면 번들에 이미 들어간 것 · node-pty 의 빌드 재료 · 윈도 prebuild 는 뺀다
// (material-icon-theme 은 남긴다 — main(file-icons.js)과 화면(explorer.tsx ICON_ROOT)이 아이콘 파일을 실행 중에 읽는다)
const FILES = [
  'package.json',
  'bin/**',
  'dist/renderer/**',
  'src/**',
  '!src/renderer/**',
  'src/renderer/assets/logo/**',
  '!node_modules/{react,react-dom,scheduler,shiki,@shikijs}/**',
  '!node_modules/@xterm/{xterm,addon-fit,addon-web-links}/**',
  '!node_modules/node-pty/{deps,third_party,src,scripts,binding.gyp}',
  '!node_modules/node-pty/{deps,third_party,src,scripts}/**',
  '!node_modules/node-pty/prebuilds/win32-*/**',
]

// 파일 이름은 홈페이지가 고정 주소로 건다(계획서 3절) — Athena-Studio-mac-arm64.dmg · -x64.dmg · .zip
/** @param {string} arch @param {string} ext */
function artifactName(arch, ext) {
  return `Athena-Studio-mac-${arch}.${ext}`
}

// 버전 — 명시값 > git 태그(describe) · 모양이 아니면 null(부르는 쪽이 멈춘다 — package.json 의 0.1.0 으로 만들지 않는다)
/** @param {{ explicit?: string | null, described?: string | null }} options */
function resolveVersion({ explicit = null, described = null }) {
  const value = String(explicit || described || '').replace(/^v/, '')
  return version.DISPLAY_RE.test(value) ? value : null
}

/**
 * electron-builder 설정. 서명 · 공증은 환경 변수로 갈린다(위 머리 주석)
 * @param {{ appVersion: string, coreBundle: string, signed: boolean }} options
 * @returns {import('electron-builder').Configuration}
 */
function builderConfig({ appVersion, coreBundle, signed }) {
  const split = version.splitDisplay(appVersion)
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    // 앱 버전(Info.plist CFBundleShortVersionString · app.getVersion()) = git 태그 번호. CFBundleVersion 은 숫자만 받으니 +N 을 뗀다
    extraMetadata: { version: appVersion },
    buildVersion: split ? split.tag : appVersion,
    directories: { output: path.relative(ROOT, OUTPUT), buildResources: 'build' },
    files: FILES,
    // 코어 번들 — process.resourcesPath/athena-core.bundle(studio-home.js coreBundlePath · CORE_BUNDLE_NAME)
    extraResources: [{ from: coreBundle, to: studioHome.CORE_BUNDLE_NAME }],
    // asar 를 쓰지 않는다 — 데몬(src/daemon/main.mts) · CLI(bin/athena-studio-cli 셸 스크립트 → src/daemon/cli.js) 를
    // 경로로 띄우고, 코어(파이썬 screen.py)가 그 CLI 경로를 셸로 실행한다. asar 안 파일은 셸 · 다른 프로세스가 실행할 수 없다
    asar: false,
    // node-pty 는 N-API prebuild(darwin-arm64 · darwin-x64)를 들고 온다 — Electron 용으로 다시 컴파일하지 않는다(x64 를 arm64 맥에서 만들 때도)
    npmRebuild: false,
    // 퓨즈 — RunAsNode 는 켜 둔다(데몬 · 데몬 CLI · 일감 · 코어 명령을 node 가 없으면 이 앱의 Electron 으로 ELECTRON_RUN_AS_NODE=1 로 돌린다).
    // 나머지는 이 앱이 쓰지 않는 바깥 손잡이라 끈다(NODE_OPTIONS · --inspect). asar 를 안 쓰니 asar 관련은 끈 채로
    electronFuses: {
      runAsNode: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: false,
      onlyLoadAppFromAsar: false,
      // 퓨즈를 바꾸면 Electron 원래 서명이 깨진다 — ad-hoc 으로 다시 서명해 둔다(애플 실리콘은 서명 없는 실행 파일을 켜지 않는다 · 뒤에서 서명이 또 덮는다)
      resetAdHocDarwinSignature: true,
    },
    mac: {
      category: 'public.app-category.developer-tools',
      icon: ICON,
      minimumSystemVersion: MINIMUM_MACOS,
      target: ['dmg', 'zip'],
      artifactName: 'Athena-Studio-mac-${arch}.${ext}',
      // 인증서(CSC_LINK)가 없으면 ad-hoc — 있으면 electron-builder 가 그 인증서를 찾는다(identity 를 비워 둔다)
      ...(signed ? {} : { identity: '-' }),
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS,
      entitlementsInherit: ENTITLEMENTS,
    },
    dmg: { artifactName: 'Athena-Studio-mac-${arch}.${ext}' },
    publish: null,
  }
}

/** @param {string[]} args @param {string} name */
function argValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || '' : ''
}

async function buildRenderer() {
  const vite = await import('vite')
  await vite.build({ configFile: path.join(ROOT, 'vite.config.mts'), logLevel: 'warn' })
}

/** @param {string[]} args */
async function main(args) {
  if (process.platform !== 'darwin') throw new Error('맥 배포판은 맥에서만 만든다')
  const archArg = argValue(args, '--arch') || 'all'
  const arches = archArg === 'all' ? ARCHES : [archArg]
  if (!arches.every((arch) => ARCHES.includes(arch))) throw new Error(`--arch 는 ${ARCHES.join(' · ')} · all 중 하나: ${archArg}`)
  const appVersion = resolveVersion({ explicit: argValue(args, '--version'), described: version.describeVersion({ repoRoot: ROOT, env: studioHome.gitEnv() }) })
  if (!appVersion) throw new Error('버전을 정하지 못했다 — git 태그(v*)를 받거나(git fetch --tags) --version X.Y.Z 를 준다')

  console.log(`[package] 화면 빌드`)
  await buildRenderer()

  const coreBundle = path.join(STAGING, studioHome.CORE_BUNDLE_NAME)
  const made = studioHome.makeCoreBundle({ repoRoot: ROOT, out: coreBundle, version: appVersion, log: (line) => console.log(`[package] ${line}`) })
  if (!made.ok) throw new Error(`코어 번들을 만들지 못했다(${made.error}) — ${made.message || ''}`)
  console.log(`[package] 코어 번들 ${String(made.commit).slice(0, 12)} · ${appVersion}`)

  const signed = Boolean(process.env.CSC_LINK)
  console.log(`[package] ${appVersion} · ${arches.join(' · ')} · 서명 ${signed ? 'Developer ID(CSC_LINK)' : 'ad-hoc(이 컴퓨터용 — 손님 맥에서는 Gatekeeper 가 막는다)'}`)
  fs.rmSync(OUTPUT, { recursive: true, force: true })
  const builder = require('electron-builder')
  const config = builderConfig({ appVersion, coreBundle, signed })
  // 칩마다 따로 — 한 번에 넘기면 universal 이 아니라 각자 만든다(파일 이름에 ${arch})
  const archEnum = { arm64: builder.Arch.arm64, x64: builder.Arch.x64 }
  const targets = builder.Platform.MAC.createTarget(['dmg', 'zip'], ...arches.map((arch) => archEnum[/** @type {'arm64' | 'x64'} */ (arch)]))
  const files = await builder.build({ targets, config, publish: 'never' })
  for (const file of files) if (/\.(dmg|zip)$/.test(file)) console.log(`[package] ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)}MB)`)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[package] 실패: ${error && error.message ? error.message : error}`)
    process.exit(1)
  })
}

module.exports = { APP_ID, PRODUCT_NAME, MINIMUM_MACOS, artifactName, resolveVersion, builderConfig }
