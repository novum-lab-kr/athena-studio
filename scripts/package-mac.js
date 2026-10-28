// @ts-check
// 맥 배포판 만들기 — electron-builder 로 .dmg · .zip(칩마다 따로). 결과는 dist/release/(git 무시)
//   npm run package:mac [-- --arch arm64|x64|all] [--version X.Y.Z] [--require-signing]
//     1. 화면 빌드(vite → dist/renderer · scripts/dev-app.js 와 같은 설정)
//     2. 코어 번들 — 레포 athena/ 의 커밋된 기록(HEAD:athena)을 git 번들로 dist/package/ 에 만들고 extraResources 로
//        앱 Contents/Resources/athena-core.bundle 에 넣는다(src/lib/studio-home.js coreBundlePath 의 배포판 자리)
//     2-1. 앱 안 업데이트 설정 — dist/package/app-update.yml(피드 = 공개 레포 최신 Release 고정 주소)을 Contents/Resources/ 에.
//          electron-updater 가 피드 · 받기 캐시 자리를 여기서 읽는다(src/main/app-updater.mts). electron-builder publish 설정은 쓰지 않는다 —
//          켜면 .dmg 항목까지 든 latest-mac.yml · blockmap 을 같이 만드는데, latest-mac.yml 은 release-files.js updater 가 최종 .zip 으로 만든다
//     3. 제3자 고지 — scripts/third-party-notices.js 가 package-lock · node_modules 를 읽어 dist/package/THIRD_PARTY_NOTICES.txt 를 만들고
//        extraResources 로 앱 Contents/Resources/ 에(약관 docs/release/EULA.md 5절 · LICENSE 가 가리킨다)
//     4. electron-builder — 이름 Athena Studio · 번들 ID kr.novum-lab.athena-studio · 파일 이름 Athena-Studio-mac-<arch>.dmg · .zip
//   버전: --version 이 없으면 git 태그(git describe — 태그 커밋이면 0.13.35, 뒤 커밋이 있으면 0.13.35+1). 앱 app.getVersion() 이 이 번호
//   서명: CSC_LINK(+ CSC_KEY_PASSWORD) 가 있으면 그 Developer ID 인증서로, 없으면 이 컴퓨터용(ad-hoc '-') — 1단계는 ad-hoc
//         공증: APPLE_API_KEY(.p8 파일 경로) · APPLE_API_KEY_ID · APPLE_API_ISSUER 가 모두 있으면 afterSign 훅(scripts/notarize-mac.js)이 notarytool 로
//         — 앱(.app)만 공증하고 staple 은 다시 시도하되 끝내 못 붙여도 멈추지 않는다(dist/release/staple.json 에 false · electron-builder 의 공증은 끈다 — mac.notarize).
//         .dmg 는 같은 인증서로 서명만 하고(dmg.sign) 공증 · staple 은 워크플로(.github/workflows/release-mac.yml)가 한다
//         --require-signing: 위 다섯 값 중 하나라도 비면 만들지 않는다(CI 에서 Secrets 가 빠져 ad-hoc 판이 조용히 나오지 않게 — 값은 찍지 않고 이름만)
// 순수 부분(builderConfig · artifactName · resolveVersion · signingMissing)은 test/package-mac.test.js 가 Electron · electron-builder 없이 본다
const fs = require('fs')
const path = require('path')
const studioHome = require('../src/lib/studio-home')
const version = require('../src/lib/version')
const notarizeMac = require('./notarize-mac')
const notices = require('./third-party-notices')

const ROOT = path.join(__dirname, '..')
const OUTPUT = path.join(ROOT, 'dist', 'release')
const STAGING = path.join(ROOT, 'dist', 'package')
const ARCHES = ['arm64', 'x64']
// 서명 · 공증에 필요한 환경 변수 — electron-builder 관례 이름(계획서 3절 · Secrets 이름과 같다. APPLE_API_KEY 만 Secret APPLE_API_KEY_P8 을 파일로 쓴 경로)
const SIGNING_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

const APP_ID = 'kr.novum-lab.athena-studio'
// 공개 자리(홈페이지 고정 주소와 같은 곳) — 앱 안 업데이트 피드는 그 최신 Release 의 파일(latest-mac.yml · .zip)
const RELEASES_REPO = 'novum-lab-kr/athena-studio-releases'
const UPDATE_FEED_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download`
const UPDATE_CONFIG_NAME = 'app-update.yml'
// 받은 .zip 을 두는 캐시 폴더 이름(~/Library/Caches/<이것>) — electron-builder 가 쓰는 꼴(<이름>-updater)과 같게
const UPDATER_CACHE_DIR = 'athena-studio-updater'
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

// 앱 안 app-update.yml — electron-updater generic provider(AppUpdater.loadUpdateConfig 가 YAML 로 읽는다 · JSON 도 YAML 이다)
function updateConfig() {
  return `${JSON.stringify({ provider: 'generic', url: UPDATE_FEED_URL, updaterCacheDirName: UPDATER_CACHE_DIR }, null, 2)}\n`
}

// 서명 · 공증 환경 변수 중 빈 것의 이름 — 값은 보지 않고 있는지만
/** @param {Record<string, string | undefined>} env */
function signingMissing(env) {
  return SIGNING_ENV.filter((name) => !env[name])
}

/**
 * electron-builder 설정. 서명 · 공증은 환경 변수로 갈린다(위 머리 주석)
 * @param {{ appVersion: string, coreBundle: string, updateConfigFile: string, noticesFile: string, signed: boolean }} options
 * @returns {import('electron-builder').Configuration}
 */
function builderConfig({ appVersion, coreBundle, updateConfigFile, noticesFile, signed }) {
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
    // 업데이트 설정 — process.resourcesPath/app-update.yml(electron-updater 가 읽는 자리 · 서명 전에 들어가 서명에 포함된다)
    // 제3자 고지 — process.resourcesPath/THIRD_PARTY_NOTICES.txt(Electron · Chromium 고지 LICENSE.electron.txt · LICENSES.chromium.html 은 electron-builder 가 같은 자리에 옮긴다)
    extraResources: [
      { from: coreBundle, to: studioHome.CORE_BUNDLE_NAME },
      { from: updateConfigFile, to: UPDATE_CONFIG_NAME },
      { from: noticesFile, to: notices.FILE_NAME },
    ],
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
      // electron-builder(@electron/notarize)는 공증 뒤 staple 이 지면 빌드를 멈춘다 — 공증 · staple 은 main 이 거는 afterSign 훅(notarize-mac.js)이 한다
      notarize: false,
    },
    // Developer ID 판이면 .dmg 도 같은 인증서로 서명한다(만드는 동안만 있는 임시 키체인이라 여기서) — 공증 · staple 은 워크플로
    dmg: { artifactName: 'Athena-Studio-mac-${arch}.${ext}', sign: signed },
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
  // 화면 빌드 · 코어 번들 전에 — CI 분을 쓰기 전에 멈춘다
  if (args.includes('--require-signing')) {
    const missing = signingMissing(process.env)
    if (missing.length) throw new Error(`서명 · 공증 값이 비었다: ${missing.join(' · ')} — --require-signing 이라 ad-hoc 으로 만들지 않는다`)
  }
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
  const updateConfigFile = path.join(STAGING, UPDATE_CONFIG_NAME)
  fs.writeFileSync(updateConfigFile, updateConfig())

  const noticesFile = path.join(STAGING, notices.FILE_NAME)
  const written = notices.writeNotices({ root: ROOT, out: noticesFile, appVersion })
  console.log(`[package] 제3자 고지 ${written.count}개${written.vendored.length ? ` · 넣어 둔 upstream 원문: ${written.vendored.join(' · ')}` : ''}${written.reconstructed.length ? ` · package.json 으로 만든 MIT 원문: ${written.reconstructed.join(' · ')}` : ''}`)

  const signed = Boolean(process.env.CSC_LINK)
  console.log(`[package] ${appVersion} · ${arches.join(' · ')} · 서명 ${signed ? 'Developer ID(CSC_LINK)' : 'ad-hoc(이 컴퓨터용 — 손님 맥에서는 Gatekeeper 가 막는다)'}`)
  fs.rmSync(OUTPUT, { recursive: true, force: true })
  const builder = require('electron-builder')
  // .app 서명 직후 공증 · staple(Developer ID 판만) — staple 결과는 이 .app 을 담을 .zip 이름으로 staple.json 에
  /** @param {import('electron-builder').AfterPackContext} context */
  const afterSign = (context) => notarizeMac.afterSign(context, { recordName: artifactName(builder.Arch[context.arch], 'zip') })
  const config = { ...builderConfig({ appVersion, coreBundle, updateConfigFile, noticesFile, signed }), ...(signed ? { afterSign } : {}) }
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

module.exports = { APP_ID, PRODUCT_NAME, MINIMUM_MACOS, SIGNING_ENV, RELEASES_REPO, UPDATE_FEED_URL, UPDATE_CONFIG_NAME, UPDATER_CACHE_DIR, artifactName, resolveVersion, signingMissing, updateConfig, builderConfig }
