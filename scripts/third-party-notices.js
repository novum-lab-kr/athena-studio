// @ts-check
// 배포판에 넣는 THIRD_PARTY_NOTICES.txt 만들기 — 손으로 쓴 목록이 아니라 package-lock.json · node_modules 를 읽어서
//   node scripts/third-party-notices.js [--out <파일>] [--version X.Y.Z]   (없으면 표준 출력)
//   대상: package-lock.json 의 운영 의존성 전부(dev · devOptional 빼고 · 하위 의존성 포함) 중 node_modules 에 실제로 깔린 것.
//         화면 번들(dist/renderer)에 묶여 node_modules 째로는 빠지는 것(react · shiki · xterm …)도 배포판 안에 들어가니 같이 적는다
//   각 패키지: 이름 · 버전 · package.json license · 저장소 주소 · 패키지 안 LICENSE / LICENCE / COPYING / NOTICE 파일 원문
//   npm 패키지에 라이선스 파일이 없으면 build/third-party-licenses/<이름(/ → __)>@<버전>.LICENSE(그 버전 upstream 저장소의 원문을 넣어 둔 것)를 쓴다.
//   그것도 없고 package.json license 가 MIT 면 MIT 표준 문구 + package.json author 로 원문을 만든다(2026-10-28 결정 A — 연도는 package.json 에 없으니 뺀다 ·
//     고지에 "reconstructed from package.json" 표시 · 빌드 로그에 목록). author 도 없으면 저작권자를 알 수 없으니 만들지 않는다
//   그 밖은 만들지 않는다(원문 없이 이름만 적은 고지는 '저작권 · 허가 문구를 함께 배포' 조건을 못 지킨다) — 버전을 올리면 그 버전 원문을 다시 넣는다
//     지금 넣어 둔 것: @xterm/addon-serialize@0.14.0 · @xterm/headless@6.0.0 — 둘 다 github.com/xtermjs/xterm.js 태그 6.0.0 의 루트 LICENSE(하위 폴더에 LICENSE 없음)
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
// 패키지에 라이선스 파일이 없을 때 쓰는 upstream 원문 자리
const VENDORED_DIR = path.join('build', 'third-party-licenses')

// MIT 표준 문구(SPDX MIT) — 원문 파일이 없는 MIT 패키지에 package.json author 를 저작권자로 넣어 쓴다
const MIT_TEMPLATE = `MIT License

Copyright (c) {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

// package.json author 의 이름 — "이름 <메일> (주소)" 문자열 · { name } 객체 모두. 없으면 ''
/** @param {unknown} author @returns {string} */
function authorName(author) {
  const raw = typeof author === 'string' ? author : author && typeof author === 'object' && 'name' in author ? String(author.name) : ''
  return raw.replace(/<[^>]*>/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
}

// 넣어 둔 원문 파일 이름 — @xterm/headless 6.0.0 → @xterm__headless@6.0.0.LICENSE
/** @param {string} name @param {string} version */
function vendoredFileName(name, version) {
  return `${name.replace(/\//g, '__')}@${version}.LICENSE`
}

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
 * 패키지 안에 라이선스 파일이 없으면 vendoredDir 의 그 이름@버전 원문(vendored: true) · 그것도 없고 MIT + author 면 표준 문구로 만든 원문(reconstructed: true) · 그것도 아니면 files 가 빈다
 * @param {string} dir 패키지 폴더
 * @param {{ vendoredDir?: string | null }} [options]
 * @returns {{ name: string, version: string, license: string, repository: string, files: { name: string, text: string }[], vendored: boolean, reconstructed: boolean } | null}
 */
function readPackage(dir, { vendoredDir = null } = {}) {
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) return null
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const license = typeof manifest.license === 'string' ? manifest.license : manifest.license && manifest.license.type ? String(manifest.license.type) : 'UNKNOWN'
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: readText(path.join(dir, name)) }))
  const base = { name: String(manifest.name), version: String(manifest.version), license, repository: repositoryUrl(manifest.repository) }
  const vendored = !files.length && vendoredDir ? path.join(vendoredDir, vendoredFileName(base.name, base.version)) : ''
  if (vendored && fs.existsSync(vendored)) return { ...base, files: [{ name: 'LICENSE', text: readText(vendored) }], vendored: true, reconstructed: false }
  const holder = authorName(manifest.author)
  if (!files.length && license === 'MIT' && holder) return { ...base, files: [{ name: 'LICENSE', text: MIT_TEMPLATE.replace('{holder}', holder) }], vendored: false, reconstructed: true }
  return { ...base, files, vendored: false, reconstructed: false }
}

/** @param {string} file */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim()
}

/**
 * 레포의 운영 의존성 + Electron 을 모은다(같은 이름 · 버전이 여러 자리에 있으면 하나만)
 * 라이선스 원문을 끝내 못 찾은 패키지가 있으면 던진다(이름 · 넣을 파일 자리를 알린다)
 * @param {{ root: string }} options
 */
function collectPackages({ root }) {
  const vendoredDir = path.join(root, VENDORED_DIR)
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  /** @type {Map<string, NonNullable<ReturnType<typeof readPackage>>>} */
  const found = new Map()
  for (const key of listProductionPackages(lock)) {
    const pkg = readPackage(path.join(root, key), { vendoredDir })
    if (pkg) found.set(`${pkg.name}@${pkg.version}`, pkg)
  }
  const electron = readPackage(path.join(root, 'node_modules', 'electron'), { vendoredDir })
  if (!electron) throw new Error('node_modules/electron 이 없다 — npm ci 를 먼저')
  const missing = [electron, ...found.values()].filter((pkg) => !pkg.files.length)
  if (missing.length) {
    const lines = missing.map((pkg) => `${pkg.name}@${pkg.version} → ${path.join(VENDORED_DIR, vendoredFileName(pkg.name, pkg.version))}${pkg.repository ? ` (${pkg.repository})` : ''}`)
    throw new Error(`라이선스 원문이 없는 패키지가 있다(MIT + author 가 아니라 표준 문구로도 만들 수 없다) — 그 버전 upstream 저장소의 LICENSE 원문을 아래 자리에 넣는다:\n  - ${lines.join('\n  - ')}`)
  }
  return { packages: [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)), electron }
}

const RULE = '='.repeat(78)
const THIN = '-'.repeat(78)

/** @param {NonNullable<ReturnType<typeof readPackage>>} pkg @param {string[]} [extra] */
function section(pkg, extra = []) {
  const vendoredNote = pkg.vendored ? ['License text: from the source repository (the npm package does not include a license file).'] : []
  if (pkg.reconstructed) vendoredNote.push('License text: reconstructed from package.json (standard MIT text with the package author; the npm package does not include a license file).')
  const head = [RULE, `${pkg.name} ${pkg.version}`, `License: ${pkg.license}`, ...(pkg.repository ? [`Source: ${pkg.repository}`] : []), ...vendoredNote, ...extra, RULE]
  const body = pkg.files.map((file) => (pkg.files.length > 1 ? `${file.name}\n${THIN}\n${file.text}` : file.text))
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
 * 파일로 쓰기 — 넣어 둔 upstream 원문 · package.json 으로 만든 원문을 쓴 패키지 이름을 돌려준다(부르는 쪽이 로그에 남긴다) · 원문이 없는 패키지가 있으면 던진다(collectPackages)
 * @param {{ root: string, out: string, appVersion?: string | null }} options
 */
function writeNotices({ root, out, appVersion = null }) {
  const { packages, electron } = collectPackages({ root })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, renderNotices({ packages, electron, appVersion }))
  const all = [electron, ...packages]
  const names = (/** @type {typeof all} */ list) => list.map((pkg) => `${pkg.name}@${pkg.version}`)
  return { count: all.length, vendored: names(all.filter((pkg) => pkg.vendored)), reconstructed: names(all.filter((pkg) => pkg.reconstructed)) }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  /** @param {string} name */
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] || '' : '')
  const out = value('--out')
  if (out) {
    const result = writeNotices({ root: ROOT, out: path.resolve(out), appVersion: value('--version') || null })
    console.log(`[notices] ${out} · ${result.count}개${result.vendored.length ? ` · 넣어 둔 upstream 원문: ${result.vendored.join(' · ')}` : ''}${result.reconstructed.length ? ` · package.json 으로 만든 MIT 원문: ${result.reconstructed.join(' · ')}` : ''}`)
  } else {
    process.stdout.write(renderNotices({ ...collectPackages({ root: ROOT }), appVersion: value('--version') || null }))
  }
}

module.exports = { FILE_NAME, LICENSE_FILE_RE, VENDORED_DIR, vendoredFileName, authorName, listProductionPackages, readPackage, collectPackages, renderNotices, writeNotices }
