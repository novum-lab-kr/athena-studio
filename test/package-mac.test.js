// 맥 배포판 설정(scripts/package-mac.js) — electron-builder 를 부르지 않고 설정 모양만 본다
const test = require('node:test')
const assert = require('node:assert/strict')
const pkg = require('../scripts/package-mac')
const studioHome = require('../src/lib/studio-home')

const base = { appVersion: '0.13.36', coreBundle: '/tmp/stage/athena-core.bundle', signed: false }

test('파일 이름은 홈페이지 고정 주소와 같은 꼴 — Athena-Studio-mac-<arch>.<ext>', () => {
  assert.equal(pkg.artifactName('arm64', 'dmg'), 'Athena-Studio-mac-arm64.dmg')
  assert.equal(pkg.artifactName('x64', 'zip'), 'Athena-Studio-mac-x64.zip')
  const config = pkg.builderConfig(base)
  // electron-builder 가 ${arch} · ${ext} 를 채운다 — 같은 꼴인지
  const expand = (pattern, arch, ext) => pattern.replace('${arch}', arch).replace('${ext}', ext)
  assert.equal(expand(config.mac.artifactName, 'x64', 'zip'), pkg.artifactName('x64', 'zip'))
  assert.equal(expand(config.dmg.artifactName, 'arm64', 'dmg'), pkg.artifactName('arm64', 'dmg'))
})

test('이름 · 번들 ID · 최소 macOS(Electron 44 = 13.0)', () => {
  const config = pkg.builderConfig(base)
  assert.equal(config.appId, 'kr.novum-lab.athena-studio')
  // 앱 데이터 폴더 이름(appIdentity 배포판)과 같아야 한다
  assert.equal(config.productName, studioHome.appIdentity({ packaged: true }).name)
  assert.equal(config.mac.minimumSystemVersion, '13.0')
})

test('코어 번들은 배포판 coreBundlePath 자리(resourcesPath/athena-core.bundle)로 들어간다', () => {
  const config = pkg.builderConfig(base)
  assert.deepEqual(config.extraResources, [{ from: base.coreBundle, to: studioHome.CORE_BUNDLE_NAME }])
  assert.equal(studioHome.coreBundlePath({ appRoot: '/x', packaged: true, resourcesPath: '/R' }), `/R/${config.extraResources[0].to}`)
})

test('RunAsNode 퓨즈는 켜 둔다 — 데몬 · CLI 가 ELECTRON_RUN_AS_NODE 로 돈다 · asar 없음', () => {
  const config = pkg.builderConfig(base)
  assert.equal(config.electronFuses.runAsNode, true)
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, false)
  assert.equal(config.asar, false)
  // 화면 빌드 · 데몬 CLI 가 들어가야 한다
  for (const pattern of ['dist/renderer/**', 'bin/**', 'src/**']) assert.ok(config.files.includes(pattern), pattern)
})

test('서명 — 인증서가 없으면 ad-hoc(-) · 있으면 identity 를 비워 electron-builder 가 CSC_LINK 로 찾는다 · hardened runtime 은 늘', () => {
  const adhoc = pkg.builderConfig(base)
  assert.equal(adhoc.mac.identity, '-')
  assert.equal(adhoc.mac.hardenedRuntime, true)
  const signed = pkg.builderConfig({ ...base, signed: true })
  assert.equal('identity' in signed.mac, false)
  assert.equal(signed.mac.entitlements, signed.mac.entitlementsInherit)
  // .dmg 는 Developer ID 판일 때만 서명(공증 · staple 은 워크플로) — ad-hoc 판은 서명하지 않는다
  assert.equal(adhoc.dmg.sign, false)
  assert.equal(signed.dmg.sign, true)
  // electron-builder 공증은 끈다 — staple 이 지면 빌드가 멈춰서 afterSign 훅(notarize-mac.js)이 공증 · staple 한다
  assert.equal(signed.mac.notarize, false)
})

test('--require-signing — 서명 · 공증 값 다섯 중 빈 것의 이름만 돌려준다', () => {
  const full = Object.fromEntries(pkg.SIGNING_ENV.map((name) => [name, 'x']))
  assert.deepEqual(pkg.signingMissing(full), [])
  assert.deepEqual(pkg.signingMissing({ ...full, CSC_KEY_PASSWORD: '', APPLE_API_ISSUER: undefined }), ['CSC_KEY_PASSWORD', 'APPLE_API_ISSUER'])
  assert.deepEqual(pkg.signingMissing({}), ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
})

test('버전 — 명시값 > git 태그 · CFBundleVersion 은 +N 을 뗀 숫자', () => {
  assert.equal(pkg.resolveVersion({ explicit: 'v0.14.0', described: '0.13.36' }), '0.14.0')
  assert.equal(pkg.resolveVersion({ described: '0.13.36+2' }), '0.13.36+2')
  assert.equal(pkg.resolveVersion({}), null)
  assert.equal(pkg.resolveVersion({ explicit: 'latest' }), null)
  const config = pkg.builderConfig({ ...base, appVersion: '0.13.36+2' })
  assert.equal(config.extraMetadata.version, '0.13.36+2')
  assert.equal(config.buildVersion, '0.13.36')
})
