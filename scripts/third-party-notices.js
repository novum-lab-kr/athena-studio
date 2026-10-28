// @ts-check
// 배포판에 넣는 THIRD_PARTY_NOTICES.txt 만들기 — 손으로 쓴 목록이 아니라 package-lock.json · node_modules 를 읽어서
//   node scripts/third-party-notices.js [--out <파일>] [--version X.Y.Z]   (없으면 표준 출력)
//   대상: package-lock.json 의 운영 의존성 전부(dev · devOptional 빼고 · 하위 의존성 포함) 중 node_modules 에 실제로 깔린 것.
//         화면 번들(dist/renderer)에 묶여 node_modules 째로는 빠지는 것(react · shiki · xterm …)도 배포판 안에 들어가니 같이 적는다
//   각 패키지: 이름 · 버전 · package.json license · 저장소 주소 · 패키지 안 LICENSE / LICENCE / COPYING / NOTICE 파일 원문
//   Electron: npm 패키지의 LICENSE 원문 + Chromium(Node.js 포함) 고지는 electron-builder 가 앱 Contents/Resources 로 옮겨 두는
//             LICENSES.chromium.html · LICENSE.electron.txt 를 가리킨다(app-builder-lib ElectronFramework retainElectronLicenseFiles)
//   package-mac.js 가 빌드 때 dist/package/ 에 만들어 extraResources 로 앱 Contents/Resources/THIRD_PARTY_NOTICES.txt 에 넣는다
// 순수 부분(listProductionPackages · readPackage · renderNotices)은 test/third-party-notices.test.js 가 가짜 node_modules 로 본다
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FILE_NAME = 'THIRD_PARTY_NOTICES.txt'
// 패키지 폴더 맨 위에서 고지 원문으로 읽는 파일 이름
const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i

/**
 * package-lock.json(lockfileVersion 2 · 3)의 운영 의존성 — dev · devOptional 은 배포판에 들어가지 않는다
 * @param {{ packages?: Record<string, { version?: string, dev?: boolean, devOptional?: boolean }> }} lock
 * @returns {string[]} node_modules/… 경로(정렬)
 */
function listProductionPackages(lock) {
  if (!lock || !lock.packages) throw new Error('package-lock.json 에 packages 가 없다(lockfileVersion 2 이상이 필요)')
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && !entry.devOptional)
    .map(([key]) => key)
    .sort()
}

/** @param {unknown} repository @returns {string} */
function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository && typeof repository === 'object' && 'url' in repository ? String(repository.url) : ''
  return raw.replace(/^git\+/, '').replace(/\.git$/, '')
}

/**
 * 깔린 패키지 하나 읽기 — 없으면(다른 OS 용 선택 의존성) null
 * @param {string} dir 패키지 폴더
 * @returns {{ name: string, version: string, license: string, repository: string, files: { name: string, text: string }[] } | null}
 */
function readPackage(dir) {
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) return null
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const license = typeof manifest.license === 'string' ? manifest.license : manifest.license && manifest.license.type ? String(manifest.license.type) : 'UNKNOWN'
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim() }))
  return { name: String(manifest.name), version: String(manifest.version), license, repository: repositoryUrl(manifest.repository), files }
}

/**
 * 레포의 운영 의존성 + Electron 을 모은다(같은 이름 · 버전이 여러 자리에 있으면 하나만)
 * @param {{ root: string }} options
 */
function collectPackages({ root }) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  /** @type {Map<string, NonNullable<ReturnType<typeof readPackage>>>} */
  const found = new Map()
  for (const key of listProductionPackages(lock)) {
    const pkg = readPackage(path.join(root, key))
    if (pkg) found.set(`${pkg.name}@${pkg.version}`, pkg)
  }
  const electron = readPackage(path.join(root, 'node_modules', 'electron'))
  if (!electron) throw new Error('node_modules/electron 이 없다 — npm ci 를 먼저')
  return { packages: [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)), electron }
}

const RULE = '='.repeat(78)
const THIN = '-'.repeat(78)

/** @param {NonNullable<ReturnType<typeof readPackage>>} pkg @param {string[]} [extra] */
function section(pkg, extra = []) {
  const head = [RULE, `${pkg.name} ${pkg.version}`, `License: ${pkg.license}`, ...(pkg.repository ? [`Source: ${pkg.repository}`] : []), ...extra, RULE]
  const body = pkg.files.length
    ? pkg.files.map((file) => (pkg.files.length > 1 ? `${file.name}\n${THIN}\n${file.text}` : file.text))
    : ['(This package does not include a license file. It is distributed under the license identified above; see the source repository for the full text.)']
  return [...head, '', body.join(`\n\n${THIN}\n`), ''].join('\n')
}

/**
 * 고지 파일 본문(손님용 · 영어)
 * @param {{ packages: NonNullable<ReturnType<typeof readPackage>>[], electron: NonNullable<ReturnType<typeof readPackage>>, appVersion?: string | null }} options
 */
function renderNotices({ packages, electron, appVersion = null }) {
  const intro = [
    `Athena Studio${appVersion ? ` ${appVersion}` : ''} — Third-Party Notices`,
    '',
    'Athena Studio includes the third-party software listed below. Each component is',
    'licensed under its own terms, reproduced here from the files the component ships.',
    'These terms apply to that component only, not to Athena Studio itself.',
    '',
    `Components: ${packages.length + 1} (Electron and ${packages.length} npm packages)`,
    '',
  ].join('\n')
  const electronNote = [
    'Electron bundles Chromium, Node.js, and other open source software.',
    'Their license notices are in this app: Contents/Resources/LICENSES.chromium.html',
    '(Electron license: Contents/Resources/LICENSE.electron.txt).',
  ]
  return [intro, section(electron, electronNote), ...packages.map((pkg) => section(pkg))].join('\n').replace(/\n+$/, '\n')
}

/**
 * 파일로 쓰기 — 라이선스 파일이 없는 패키지 이름을 돌려준다(부르는 쪽이 로그에 남긴다)
 * @param {{ root: string, out: string, appVersion?: string | null }} options
 */
function writeNotices({ root, out, appVersion = null }) {
  const { packages, electron } = collectPackages({ root })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, renderNotices({ packages, electron, appVersion }))
  return { count: packages.length + 1, withoutFile: [electron, ...packages].filter((pkg) => !pkg.files.length).map((pkg) => `${pkg.name}@${pkg.version}`) }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  /** @param {string} name */
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] || '' : '')
  const out = value('--out')
  if (out) {
    const result = writeNotices({ root: ROOT, out: path.resolve(out), appVersion: value('--version') || null })
    console.log(`[notices] ${out} · ${result.count}개${result.withoutFile.length ? ` · 라이선스 파일 없음: ${result.withoutFile.join(' · ')}` : ''}`)
  } else {
    process.stdout.write(renderNotices({ ...collectPackages({ root: ROOT }), appVersion: value('--version') || null }))
  }
}

module.exports = { FILE_NAME, LICENSE_FILE_RE, listProductionPackages, readPackage, collectPackages, renderNotices, writeNotices }
