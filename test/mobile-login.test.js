// 맥 웹 로그인(src/main/mobile-login.mts) — 가짜 fetch · 브라우저로. 바깥 계약: athena-app relay/docs/protocol.md "웹 로그인 (맥 · HTTP)"
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createLoginFlow, newLoginSecrets, parseLoginLink, relayWebBase, describeLink, loginDeviceName, LOGIN_TTL_MS } = require('../src/main/mobile-login.mts')

const BASE = 'http://127.0.0.1:3130'
const CODE = 'A'.repeat(43)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const reply = (status, body) => ({ status, json: async () => body })
const GOOD = { token: 'tok', account: 'dev:tester', deviceId: 'mac-1', kind: 'mac', expiresAt: '2026-12-11T00:00:00Z', protocol: 1, profile: { provider: 'dev', name: '민창' } }

// 가짜 relay — 상태 조회 답은 status(), 토큰 교환은 token() 이 정한다. 받은 요청을 적는다
function fakeRelay({ status = () => reply(200, { status: 'pending' }), token = () => reply(200, GOOD) } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body: init && init.body ? JSON.parse(init.body) : null })
    if (parsed.pathname === '/api/login/status') return status(parsed.searchParams.get('state'))
    if (parsed.pathname === '/api/login/token') return token()
    throw new Error(`모르는 길 ${parsed.pathname}`)
  }
  return { calls, fetch }
}

function flowWith(relay, extra = {}) {
  const opened = []
  const signedIn = []
  const failed = []
  const lines = []
  const flow = createLoginFlow({
    base: BASE,
    fetch: relay.fetch,
    openBrowser: (url) => opened.push(url),
    onSignedIn: (result) => signedIn.push(result),
    onFailed: (why) => failed.push(why),
    log: (line) => lines.push(line),
    pollMs: 5,
    ...extra,
  })
  const state = () => new URL(opened[opened.length - 1]).searchParams.get('state')
  return { flow, opened, signedIn, failed, lines, state }
}

test('PKCE 짝 — verifier 43자 · challenge = base64url(SHA-256(verifier)) · state 43자', () => {
  const { verifier, challenge, state } = newLoginSecrets()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.match(state, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'))
})

test('relay 바탕 주소 — ws → http · wss → https · /ws 를 뗀다', () => {
  assert.equal(relayWebBase('ws://127.0.0.1:3130/ws'), 'http://127.0.0.1:3130')
  assert.equal(relayWebBase('wss://relay.example.com/ws'), 'https://relay.example.com')
  assert.equal(relayWebBase('wss://relay.example.com/sub/ws/'), 'https://relay.example.com/sub')
  assert.equal(relayWebBase('http://127.0.0.1/ws'), null)
  assert.equal(relayWebBase('깨진'), null)
})

test('맥 이름 칸 — 제어 · 서식 문자 빼기 · 64자(UTF-16)로 자르되 이모지를 가르지 않기 · 빈 것은 null', () => {
  assert.equal(loginDeviceName('민창의 MacBook Pro'), '민창의 MacBook Pro')
  assert.equal(loginDeviceName('  가\n나\u202Eevil\u200B  '), '가 나 evil')
  assert.equal(loginDeviceName('a'.repeat(80)).length, 64)
  const cut = loginDeviceName(`${'a'.repeat(63)}😀`)
  assert.equal(cut, 'a'.repeat(63), '서로게이트 짝을 가르지 않는다')
  for (const empty of ['', '   ', '\u0000\u200B', null, 42]) assert.equal(loginDeviceName(empty), null)
})

test('로그인 주소 — device 칸은 이름이 있을 때만 · relay 모양(1~64자 · 제어 · 서식 없음)', () => {
  const named = flowWith(fakeRelay(), { deviceName: () => '맥\u0007 미니', pollMs: 10_000 })
  named.flow.start()
  assert.equal(new URL(named.opened[0]).searchParams.get('device'), '맥 미니')
  named.flow.cancel()
  const nameless = flowWith(fakeRelay(), { deviceName: () => null, pollMs: 10_000 })
  nameless.flow.start()
  assert.equal(new URL(nameless.opened[0]).searchParams.has('device'), false)
  nameless.flow.cancel()
})

test('athena://login 읽기 — 모양이 맞는 것만 · 로그 모양에는 값이 없다', () => {
  const state = 'S'.repeat(22)
  assert.deepEqual(parseLoginLink(`athena://login?code=${CODE}&state=${state}`), { code: CODE, state })
  for (const bad of [`athena://other?code=${CODE}&state=${state}`, `https://login?code=${CODE}&state=${state}`, `athena://login?code=short&state=${state}`, `athena://login?code=${CODE}&state=x`, `athena://login/extra?code=${CODE}&state=${state}`, 42, `athena://login?code=${CODE}&state=${'S'.repeat(600)}`]) {
    assert.equal(parseLoginLink(bad), null, String(bad).slice(0, 40))
  }
  const described = describeLink(`athena://login?code=${CODE}&state=${state}`)
  assert.ok(!described.includes(CODE) && !described.includes(state))
  assert.match(described, /code,state/)
})

test('상태 조회가 done → 한 번 교환 → 로그인 · 로그에 코드 · verifier · state · 토큰이 없다', async () => {
  let done = false
  const relay = fakeRelay({ status: () => reply(200, done ? { status: 'done', code: CODE } : { status: 'pending' }) })
  const { flow, opened, signedIn, failed, lines, state } = flowWith(relay)
  flow.start()
  assert.equal(opened.length, 1)
  const url = new URL(opened[0])
  assert.equal(`${url.origin}${url.pathname}`, `${BASE}/login`)
  assert.equal(flow.pending(), true)
  await sleep(20)
  done = true
  await sleep(30)
  assert.deepEqual(failed, [])
  assert.deepEqual(signedIn, [{ token: 'tok', deviceId: 'mac-1', account: 'dev:tester', name: '민창' }])
  assert.equal(flow.pending(), false)
  const exchanges = relay.calls.filter((call) => call.path === '/api/login/token')
  assert.equal(exchanges.length, 1)
  const body = exchanges[0].body
  assert.equal(body.code, CODE)
  assert.equal(body.state, state())
  assert.equal(body.kind, 'mac')
  assert.equal(crypto.createHash('sha256').update(body.verifier).digest('base64url'), url.searchParams.get('challenge'))
  for (const secret of [CODE, body.verifier, body.state, 'tok']) assert.ok(!lines.some((line) => line.includes(secret)), '로그에 값이 없다')
})

test('athena:// 가 먼저 오면 그것으로 한 번만 교환 · state 가 다르면 버린다 · 늦게 온 같은 링크도 버린다', async () => {
  const relay = fakeRelay({ status: () => reply(200, { status: 'done', code: CODE }) })
  const { flow, signedIn, state } = flowWith(relay, { pollMs: 10_000 })
  flow.start()
  assert.equal(flow.handleLink(`athena://login?code=${CODE}&state=${'Z'.repeat(43)}`), false, '다른 state')
  assert.equal(flow.handleLink(`athena://login?code=${CODE}&state=${state()}`), true)
  assert.equal(flow.handleLink(`athena://login?code=${CODE}&state=${state()}`), true, '교환 중 — 같은 시도라 받기는 하지만 다시 바꾸지 않는다')
  await sleep(20)
  assert.equal(relay.calls.filter((call) => call.path === '/api/login/token').length, 1)
  assert.equal(signedIn.length, 1)
  assert.equal(flow.handleLink(`athena://login?code=${CODE}&state=${state()}`), false, '끝난 뒤')
  assert.equal(relay.calls.filter((call) => call.path === '/api/login/status').length, 0, '상태 조회 전에 끝남')
})

test('다시 누르면 10분 안에는 같은 로그인 페이지 · 지나면 새 시도', () => {
  let now = 1_000_000
  const relay = fakeRelay()
  const { flow, opened } = flowWith(relay, { now: () => now, pollMs: 10_000 })
  flow.start()
  flow.start()
  assert.equal(opened[0], opened[1])
  now += LOGIN_TTL_MS + 1
  flow.start()
  assert.notEqual(opened[2], opened[0])
  flow.cancel()
  assert.equal(flow.pending(), false)
})

test('실패 — 상태 404 는 expired · 교환 오류 코드 · 모양 틀린 답 · 네트워크', async () => {
  const cases = [
    [{ status: () => reply(404, { code: 'not_found' }) }, 'expired'],
    [{ status: () => reply(200, { status: 'done', code: CODE }), token: () => reply(400, { code: 'invalid_grant' }) }, 'invalid_grant'],
    [{ status: () => reply(200, { status: 'done', code: CODE }), token: () => reply(409, { code: 'device_limit' }) }, 'device_limit'],
    [{ status: () => reply(200, { status: 'done', code: CODE }), token: () => reply(503, { code: 'busy' }) }, 'busy'],
    [{ status: () => reply(200, { status: 'done', code: CODE }), token: () => reply(200, { token: 'tok' }) }, 'bad_reply'],
    [{ status: () => reply(200, { status: 'done', code: CODE }), token: () => Promise.reject(new Error('down')) }, 'network'],
  ]
  for (const [answers, why] of cases) {
    const { flow, signedIn, failed } = flowWith(fakeRelay(answers))
    flow.start()
    await sleep(30)
    assert.deepEqual(failed, [why], why)
    assert.deepEqual(signedIn, [])
    assert.equal(flow.pending(), false)
  }
})

test('상태 조회가 잠깐 못 닿으면 계속 묻는다 · 10분이 지나면 expired', async () => {
  let now = 0
  let reachable = false
  const relay = fakeRelay({ status: () => (reachable ? reply(200, { status: 'pending' }) : Promise.reject(new Error('down'))) })
  const { flow, failed } = flowWith(relay, { now: () => now })
  flow.start()
  await sleep(25)
  assert.deepEqual(failed, [])
  reachable = true
  now = LOGIN_TTL_MS + 1
  await sleep(25)
  assert.deepEqual(failed, ['expired'])
})
