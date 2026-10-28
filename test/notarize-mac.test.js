// 맥 배포판 공증 · staple(scripts/notarize-mac.js) — xcrun 을 부르지 않고 다시 시도 · 출력 읽기 · staple.json 만 본다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const notarize = require('../scripts/notarize-mac')

const quiet = { sleep: async () => {}, log: () => {} }

test('다시 시도 — 성공하면 그 자리에서 true · 모두 지면 던지지 않고 false', async () => {
  let calls = 0
  const waits = []
  const ok = await notarize.retry(async () => ++calls === 3, { tries: 5, delayMs: 60_000, sleep: async (ms) => { waits.push(ms) }, log: () => {} })
  assert.equal(ok, true)
  assert.equal(calls, 3)
  assert.deepEqual(waits, [60_000, 60_000])
  calls = 0
  assert.equal(await notarize.retry(async () => { calls += 1; return false }, { tries: 4, delayMs: 1, ...quiet }), false)
  assert.equal(calls, 4)
})

test('CI 다시 시도 — 60초 간격 · 5번', () => {
  assert.deepEqual(notarize.CI_RETRY, { tries: 5, delayMs: 60_000 })
})

test('notarytool 출력 — Accepted 줄 · 제출 id(실행 40636468435 로그 꼴)', () => {
  const output = ['Submission ID received', '  id: 9bfd1ce4-5367-413e-8576-851b03dfee89', 'Current status: Accepted........', 'Processing complete', '  id: 9bfd1ce4-5367-413e-8576-851b03dfee89', '  status: Accepted', ''].join('\n')
  assert.equal(notarize.accepted(output), true)
  assert.equal(notarize.submissionId(output), '9bfd1ce4-5367-413e-8576-851b03dfee89')
  // 진행 줄(Current status: Accepted…)만으로는 Accepted 로 보지 않는다
  assert.equal(notarize.accepted('Current status: Accepted........\n  status: Invalid\n'), false)
  assert.equal(notarize.submissionId('no id here'), null)
})

test('공증 키 — 셋 다 · 하나도 없음 · 일부만(빠진 이름)', () => {
  assert.equal(notarize.notaryEnv({ APPLE_API_KEY: '/k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's' }), 'all')
  assert.equal(notarize.notaryEnv({}), 'none')
  assert.deepEqual(notarize.notaryEnv({ APPLE_API_KEY: '/k' }), ['APPLE_API_KEY_ID', 'APPLE_API_ISSUER'])
})

test('staple — 한 번 시도 = staple 다음 validate · 끝내 지면 false(Error 68 이어도 던지지 않는다)', async () => {
  const calls = []
  let stapleFails = 2
  const runner = async (command, args) => {
    calls.push(args.slice(0, 2).join(' '))
    if (args[1] === 'staple' && stapleFails-- > 0) return { code: 68, output: 'NSURLError -1005' }
    return { code: 0, output: '' }
  }
  assert.equal(await notarize.staple('/x/A.dmg', { tries: 5, delayMs: 1, runner, ...quiet }), true)
  assert.deepEqual(calls, ['stapler staple', 'stapler staple', 'stapler staple', 'stapler validate'])
  const never = async () => ({ code: 68, output: '' })
  assert.equal(await notarize.staple('/x/A.dmg', { tries: 2, delayMs: 1, runner: never, ...quiet }), false)
})

test('staple.json — 이름마다 true · false 를 더하고 바꾼다 · 없거나 깨지면 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-test-'))
  try {
    assert.equal(notarize.readStaple(dir), null)
    notarize.recordStaple(dir, 'Athena-Studio-mac-arm64.zip', false)
    notarize.recordStaple(dir, 'Athena-Studio-mac-arm64.dmg', true)
    notarize.recordStaple(dir, 'Athena-Studio-mac-arm64.zip', true)
    assert.deepEqual(notarize.readStaple(dir), { 'Athena-Studio-mac-arm64.zip': true, 'Athena-Studio-mac-arm64.dmg': true })
    fs.writeFileSync(path.join(dir, notarize.STATUS_FILE), 'not json')
    assert.equal(notarize.readStaple(dir), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('afterSign — 공증 키가 없으면 건너뛴다 · 일부만이면 멈춘다', async () => {
  const context = { appOutDir: '/nowhere/mac-arm64', outDir: '/nowhere', packager: { appInfo: { productFilename: 'Athena Studio' } } }
  await notarize.afterSign(context, { recordName: 'Athena-Studio-mac-arm64.zip', env: {} })
  await assert.rejects(notarize.afterSign(context, { recordName: 'x.zip', env: { APPLE_API_KEY: '/k' } }), /APPLE_API_KEY_ID · APPLE_API_ISSUER/)
})
