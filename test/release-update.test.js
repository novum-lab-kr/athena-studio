// 배포판 앱 업데이트(src/lib/release-update.mts) — 가짜 updater · native 로 흐름을, 진짜 electron-updater 코드로 피드 계약을 본다
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const release = require('../src/lib/release-update.mts')
const files = require('../scripts/release-files')
const packageMac = require('../scripts/package-mac')

// 가짜 electron-updater — check · download · quitAndInstall 의 결과를 테스트가 정한다
function fakeUpdater({ check = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.15.9' } }), download = async () => ['/cache/update.zip'], install = () => {} } = {}) {
  const updater = new EventEmitter()
  Object.assign(updater, { autoDownload: true, autoInstallOnAppQuit: true, disableDifferentialDownload: false, allowDowngrade: true, allowPrerelease: true, logger: null })
  updater.calls = []
  updater.checkForUpdates = () => (updater.calls.push('check'), check())
  updater.downloadUpdate = () => (updater.calls.push('download'), download())
  updater.quitAndInstall = () => (updater.calls.push('install'), install(updater))
  return updater
}
const quietLog = () => ({ lines: [], info() {}, warn(line) { this.lines.push(line) }, error(line) { this.lines.push(String(line)) } })

function setup(options = {}, extra = {}) {
  const updater = fakeUpdater(options)
  const native = new EventEmitter()
  let changes = 0
  const log = quietLog()
  const controller = release.createReleaseUpdate({ updater, native, version: '0.15.8', onChange: () => changes++, log, ...extra })
  return { updater, native, log, controller, changes: () => changes }
}

test('자동으로는 아무것도 하지 않게 설정한다 — 받기 · 끌 때 설치 · 차등 받기 · 낮추기 · 시험판 끔 · 기록은 넘긴 log', () => {
  const { updater, log } = setup()
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.disableDifferentialDownload, true)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(updater.allowPrerelease, false)
  assert.equal(updater.logger, log)
})

test('확인 전에는 줄을 숨기고(unavailable) · 새 버전이 있으면 behind + latest · 없으면 current', async () => {
  const { controller } = setup()
  assert.deepEqual(controller.view(), { state: 'unavailable', behind: 0, branch: null, reason: null, version: '0.15.8', latest: null, running: false })
  assert.deepEqual(await controller.check(), { state: 'behind', behind: 0, branch: null, reason: null, version: '0.15.8', latest: '0.15.9', running: false })
  const none = setup({ check: async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.15.8' } }) })
  assert.equal((await none.controller.check()).state, 'current')
  // updater 가 꺼져 있으면(배포판이 아님) null
  const off = setup({ check: async () => null })
  assert.equal((await off.controller.check()).state, 'unavailable')
})

test('확인 실패 — 처음이면 줄을 보이고 까닭(check-failed) · 앞서 본 새 버전은 그대로', async () => {
  let fail = true
  const { controller } = setup({ check: async () => (fail ? Promise.reject(new Error('offline')) : { isUpdateAvailable: true, updateInfo: { version: '0.15.9' } }) })
  assert.deepEqual(await controller.check(), { state: 'current', behind: 0, branch: null, reason: 'check-failed', version: '0.15.8', latest: null, running: false })
  fail = false
  await controller.check()
  fail = true
  const after = await controller.check()
  assert.equal(after.state, 'behind')
  assert.equal(after.latest, '0.15.9')
  assert.equal(after.reason, 'check-failed')
})

test('[업데이트] — 받기 → quitAndInstall · 교체가 시작되면(before-quit-for-update) ok · 그동안 running', async () => {
  const { controller, updater, native } = setup({ install: () => setImmediate(() => native.emit('before-quit-for-update')) })
  await controller.check()
  const pending = controller.run()
  assert.equal(controller.view().running, true)
  assert.deepEqual(await controller.run(), { ok: false, reason: 'running' })
  assert.deepEqual(await pending, { ok: true })
  assert.deepEqual(updater.calls, ['check', 'download', 'install'])
  assert.equal(native.listenerCount('before-quit-for-update'), 0)
})

test('새 버전이 없거나 확인 전이면 받지 않는다', async () => {
  const before = setup()
  assert.deepEqual(await before.controller.run(), { ok: false, reason: 'unavailable' })
  const current = setup({ check: async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.15.8' } }) })
  await current.controller.check()
  assert.deepEqual(await current.controller.run(), { ok: false, reason: 'current' })
  assert.deepEqual(current.updater.calls, ['check'])
})

test('받기 실패 — 체크섬이 틀리면 checksum-failed · 그 밖은 download-failed · 설치하지 않고 다시 누를 수 있다', async () => {
  const checksum = setup({ download: async () => Promise.reject(Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' })) })
  await checksum.controller.check()
  assert.deepEqual(await checksum.controller.run(), { ok: false, reason: 'checksum-failed' })
  assert.deepEqual(checksum.updater.calls, ['check', 'download'])
  assert.equal(checksum.controller.view().running, false)
  assert.equal(checksum.controller.view().reason, 'checksum-failed')
  assert.equal(checksum.controller.view().state, 'behind')
  const network = setup({ download: async () => Promise.reject(new Error('ECONNRESET')) })
  await network.controller.check()
  assert.deepEqual(await network.controller.run(), { ok: false, reason: 'download-failed' })
})

test('설치 실패 — Squirrel.Mac 서명 검사 등 오류(updater error) · 시간 넘김 · 던짐이면 install-failed · 앱은 그대로', async () => {
  // MacUpdater 는 nativeUpdater 'error'(서명이 안 맞음 등)를 updater 'error' 로 넘긴다
  const signature = setup({ install: (updater) => setImmediate(() => updater.emit('error', new Error('Code signature at URL … did not pass validation'))) })
  await signature.controller.check()
  assert.deepEqual(await signature.controller.run(), { ok: false, reason: 'install-failed' })
  assert.equal(signature.controller.view().running, false)
  assert.equal(signature.native.listenerCount('before-quit-for-update'), 0)
  assert.ok(signature.log.lines.some((line) => /did not pass validation/.test(line)))
  // 다시 누를 수 있다
  assert.equal(signature.controller.view().state, 'behind')

  const slow = setup({}, { installTimeoutMs: 20 })
  await slow.controller.check()
  assert.deepEqual(await slow.controller.run(), { ok: false, reason: 'install-failed' })

  const thrown = setup({ install: () => { throw new Error('boom') } })
  await thrown.controller.check()
  assert.deepEqual(await thrown.controller.run(), { ok: false, reason: 'install-failed' })
})

test('설치 중이 아닐 때 온 error 는 기록만 — 던지지 않는다(듣는 쪽이 늘 있다)', () => {
  const { updater, log, controller } = setup()
  updater.emit('error', new Error('later'))
  assert.ok(log.lines.some((line) => /later/.test(line)))
  assert.equal(controller.view().reason, null)
})

test('받기 까닭 고르기', () => {
  assert.equal(release.downloadReason(Object.assign(new Error('x'), { code: 'ERR_CHECKSUM_MISMATCH' })), 'checksum-failed')
  assert.equal(release.downloadReason(new Error('x')), 'download-failed')
  assert.equal(release.downloadReason(null), 'download-failed')
})

// ── 계약: 우리가 만드는 app-update.yml · latest-mac.yml 을 진짜 electron-updater 코드가 그렇게 읽는지 ──
const updaterOut = (name) => require(require.resolve(`electron-updater/out/${name}`))

test('electron-updater — latest-mac.yml(JSON 꼴)을 읽고 파일 주소를 피드 주소에 붙인다 · 맥 채널 이름은 latest-mac.yml', () => {
  const { parseUpdateInfo, resolveFiles } = updaterOut('providers/Provider')
  const { newBaseUrl } = updaterOut('util')
  const feed = files.buildUpdaterFeed({ appVersion: '0.15.9', releaseDate: '2026-10-28T12:00:00.000Z', files: [{ arch: 'arm64', size: 5, sha512: 'A+/=' }, { arch: 'x64', size: 6, sha512: 'B+/=' }] })
  const info = parseUpdateInfo(JSON.stringify(feed, null, 2), files.UPDATER_FEED, new URL(`${packageMac.UPDATE_FEED_URL}/${files.UPDATER_FEED}`))
  assert.equal(info.version, '0.15.9')
  const resolved = resolveFiles(info, newBaseUrl(packageMac.UPDATE_FEED_URL))
  assert.deepEqual(resolved.map((file) => file.url.href), [
    'https://github.com/novum-lab-kr/athena-studio-releases/releases/latest/download/Athena-Studio-mac-arm64.zip',
    'https://github.com/novum-lab-kr/athena-studio-releases/releases/latest/download/Athena-Studio-mac-x64.zip',
  ])
  assert.equal(resolved[0].info.sha512, 'A+/=')
  // generic provider 의 맥 채널 파일 이름
  const { GenericProvider } = updaterOut('providers/GenericProvider')
  const provider = new GenericProvider({ provider: 'generic', url: packageMac.UPDATE_FEED_URL }, { channel: null, isAddNoCacheQuery: false }, { platform: 'darwin', executor: null, isUseMultipleRangeRequest: true })
  assert.equal(`${provider.channel}.yml`, files.UPDATER_FEED)
})

test('electron-updater — 칩마다 맞는 .zip 을 고른다(애플 실리콘 → arm64 · 인텔 → x64)', () => {
  const { resolveFiles } = updaterOut('providers/Provider')
  const { newBaseUrl } = updaterOut('util')
  const { MacUpdater } = updaterOut('MacUpdater')
  const feed = files.buildUpdaterFeed({ appVersion: '0.15.9', releaseDate: 'x', files: [{ arch: 'arm64', size: 5, sha512: 'A' }, { arch: 'x64', size: 6, sha512: 'B' }] })
  const resolved = resolveFiles(feed, newBaseUrl(packageMac.UPDATE_FEED_URL))
  assert.deepEqual(MacUpdater.filterFilesForArch(resolved, true).map((file) => file.info.url), ['Athena-Studio-mac-arm64.zip'])
  assert.deepEqual(MacUpdater.filterFilesForArch(resolved, false).map((file) => file.info.url), ['Athena-Studio-mac-x64.zip'])
})

test('electron-updater — 앱 안 app-update.yml 을 generic 설정으로 읽는다(받기 캐시 이름 포함)', () => {
  const yaml = require(require.resolve('js-yaml', { paths: [require.resolve('electron-updater')] }))
  assert.deepEqual(yaml.load(packageMac.updateConfig()), { provider: 'generic', url: packageMac.UPDATE_FEED_URL, updaterCacheDirName: packageMac.UPDATER_CACHE_DIR })
})
