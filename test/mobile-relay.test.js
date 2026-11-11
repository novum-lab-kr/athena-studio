// 모바일 relay 클라이언트(src/main/mobile-relay.mts) — 진짜 로컬 relay(athena-app `relay/` 의 startRelay)와 가짜 폰으로 끝까지 한 바퀴.
// 로그인 → 연결 요청 → 맥 허용(확인 숫자) → hello → snapshot · pane.open · pane.input 왕복 → 해제 뒤 거절.
// relay 는 고치지 않고 실행만 한다 — 자리는 ATHENA_RELAY_DIR(athena-app 의 relay 폴더 · npm install 된 것). 없으면 이 파일의 relay 시험은 건너뛴다.
//   ATHENA_RELAY_DIR=<athena-app>/relay node --test test/mobile-relay.test.js
// 데몬은 가짜(유닉스 소켓)로 — Electron · pty 없이 돈다. 출력 · 로그에 열쇠 · 토큰 · 본문을 찍지 않는다.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const protocol = require('../src/lib/protocol')
const mobileCrypto = require('../src/lib/mobile-crypto.mts')
const { createMobileRelay, loadMacKey } = require('../src/main/mobile-relay.mts')
const { createLoginFlow, relayWebBase } = require('../src/main/mobile-login.mts')
const { createMobileBridge } = require('../src/main/mobile-bridge.mts')

const RELAY_DIR = process.env.ATHENA_RELAY_DIR || ''
const relayReady = RELAY_DIR && fs.existsSync(path.join(RELAY_DIR, 'src', 'server.ts')) && fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'ws'))
const skipRelay = relayReady ? false : 'ATHENA_RELAY_DIR(athena-app relay · npm install 된 것)가 없어 건너뜀'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check, what, limitMs = 5000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    const value = await check()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`${what} 를 기다리다 시간 초과`)
}

// ── 가짜 데몬 — hello · attach · state · pane list · input
function startFakeDaemon(socketPath) {
  const state = { inputs: [], snapshots: { p1: 'P1-화면' }, panes: [{ id: 'p1', label: '아테나', agent: 'claude', agent_status: 'working', cols: 120, rows: 40 }] }
  const daemonState = () => ({ panes: [{ id: 'p1', tab: 't1', cols: 120, rows: 40 }] })
  const sockets = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    socket.setEncoding('utf8')
    socket.on('data', protocol.createDecoder((message) => {
      let result = {}
      if (message.op === 'hello') result = { protocol: protocol.PROTOCOL, codeVersion: protocol.DAEMON_CODE }
      else if (message.op === 'attach') result = { state: daemonState(), snapshots: state.snapshots }
      else if (message.op === 'state') result = daemonState()
      else if (message.op === 'pane list') result = { panes: state.panes }
      else if (message.op === 'input') state.inputs.push(message.args)
      socket.write(protocol.encode({ id: message.id, ok: true, result }))
    }))
    socket.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ state, close: () => new Promise((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()) }) })))
}

// ── 가짜 폰 — relay 봉투 · 연결 요청 · hello · 봉인한 안쪽 요청(앱 쪽이 할 일을 그대로)
function createFakePhone(url) {
  const socket = new WebSocket(url)
  const received = []
  const waiting = new Map()
  let nextId = 1
  let cipher = null
  let lastHandshake = null
  const inner = []
  const keys = mobileCrypto.newKeyPair()
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.event === 'msg') {
      const decoded = mobileCrypto.decodeData(message.data)
      if (decoded && decoded.kind === 'handshake') lastHandshake = decoded.message
      else if (decoded && cipher) {
        const plain = cipher.open(decoded.bytes)
        if (plain !== null) inner.push(JSON.parse(plain))
      }
      return
    }
    if (message.event) return void received.push(message)
    const entry = waiting.get(message.id)
    if (entry) {
      waiting.delete(message.id)
      entry(message)
    }
  }
  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const call = async (op, args) => {
    await opened
    const id = nextId++
    return new Promise((resolve) => {
      waiting.set(id, resolve)
      socket.send(JSON.stringify({ id, op, args }))
    })
  }
  return {
    keys,
    received,
    inner,
    call,
    handshake: () => lastHandshake,
    clearHandshake: () => (lastHandshake = null),
    send: (to, data) => socket.send(JSON.stringify({ op: 'msg', args: { to, data } })),
    // hello 를 보내고 맥 일회 열쇠가 오면 세션 열쇠를 만든다
    async hello(mac, macStatic) {
      const ephemeral = mobileCrypto.newKeyPair()
      lastHandshake = null
      this.send(mac, mobileCrypto.encodeHandshake(mobileCrypto.helloMessage(ephemeral.publicKey)))
      const reply = await waitFor(() => lastHandshake, '맥 hello')
      const macEphemeral = mobileCrypto.helloEphemeral(reply)
      cipher = mobileCrypto.createCipherSession(mobileCrypto.deriveSessionKeys({ role: 'app', staticKey: keys, ephemeralKey: ephemeral, peerStatic: macStatic, peerEphemeral: macEphemeral }))
    },
    // 봉인한 안쪽 요청 하나 → 같은 id 답
    async ask(mac, id, op, args = {}) {
      this.send(mac, cipher.seal(JSON.stringify({ id, op, args })))
      return waitFor(() => inner.find((message) => message.id === id), `${op} 답`)
    },
    close: () => socket.close(),
  }
}

async function startLocalRelay(dataDir) {
  const server = await import(pathToFileURL(path.join(RELAY_DIR, 'src', 'server.ts')).href)
  const { Store } = await import(pathToFileURL(path.join(RELAY_DIR, 'src', 'store.ts')).href)
  return server.startRelay({
    host: '127.0.0.1',
    port: 0,
    devLogin: true,
    verifier: null,
    store: new Store(path.join(dataDir, 'relay.json')),
    log: () => {},
    maxMessageBytes: 4 * 1024 * 1024,
    sessionDays: 30,
    pairRequestMs: 60_000,
    authTimeoutMs: 10_000,
    heartbeatMs: 30_000,
    maxConnections: 100,
    maxMessagesPerSecond: 50,
    web: { publicUrl: 'http://127.0.0.1', termsUrl: 'https://example.com/terms', privacyUrl: null, apple: null, google: null },
    webLimits: { loginTtlMs: 60_000, codeTtlMs: 60_000, sessionTtlMs: 60_000, maxAttempts: 100, maxSessions: 100 },
  })
}

// 맥 웹 로그인 그대로 — 로그인 흐름(mobile-login)이 연 주소를 "브라우저"가 열고 개발 계정 칸으로 마친다 → 상태 조회가 done → 토큰 교환 → relay.signIn
async function webSignIn(relay, wsUrl, account) {
  const base = relayWebBase(wsUrl)
  const flow = createLoginFlow({
    base,
    fetch: (url, init) => fetch(url, init),
    openBrowser: async (url) => {
      const page = await fetch(url)
      assert.equal(page.status, 200, '로그인 페이지')
      const state = new URL(url).searchParams.get('state')
      const done = await fetch(`${base}/auth/dev/start`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, challenge: new URL(url).searchParams.get('challenge'), account }).toString(), redirect: 'manual' })
      assert.ok(done.status < 400, `개발 로그인 ${done.status}`)
    },
    onSignedIn: (result) => relay.signIn(result),
    onFailed: (why) => assert.fail(`로그인 실패 ${why}`),
    deviceName: () => '민창의 MacBook Pro',
    log: () => {},
    pollMs: 30,
  })
  flow.start()
  await waitFor(() => relay.status().connected, '웹 로그인 뒤 relay 붙기')
}

// 앱 쪽 미리 약속(4-7 "인증번호 미리 약속 v1") — pair.key · 약속을 받고 난수를 보낸 뒤 열기를 받아 약속을 확인하고 번호를 만든다
async function phonePair(phone, macId, label) {
  const asked = await phone.call('pair.request', { to: macId, publicKey: mobileCrypto.toBase64Url(phone.keys.publicKey), label })
  assert.equal(asked.ok, true)
  const requestId = asked.result.requestId
  const keyEvent = await waitFor(() => phone.received.find((event) => event.event === 'pair.key' && event.requestId === requestId), 'pair.key')
  const macPublic = mobileCrypto.keyFrom(keyEvent.publicKey)
  const commitEvent = await waitFor(() => phone.received.find((event) => event.event === 'pair.data' && mobileCrypto.decodePairData(event.data)?.kind === 'commit'), '약속')
  const commit = mobileCrypto.decodePairData(commitEvent.data).value
  const appNonce = mobileCrypto.newPairNonce()
  const sent = await phone.call('pair.data', { requestId, data: mobileCrypto.encodePairData({ pc: 'nonce', v: 1, n: mobileCrypto.toBase64(appNonce) }) })
  assert.equal(sent.ok, true)
  const revealEvent = await waitFor(() => phone.received.find((event) => event.event === 'pair.data' && mobileCrypto.decodePairData(event.data)?.kind === 'reveal'), '열기')
  const macNonce = mobileCrypto.decodePairData(revealEvent.data).value
  assert.deepEqual(Buffer.from(mobileCrypto.pairCommit(macPublic, phone.keys.publicKey, macNonce)), Buffer.from(commit), '약속과 열린 난수가 맞다')
  return { requestId, code: mobileCrypto.pairCode(macPublic, phone.keys.publicKey, appNonce, macNonce) }
}

test('맥 열쇠 파일 — 0600 으로 만들고 다시 켜도 같은 열쇠 · 틀린 파일이면 새로', async () => {
  await mobileCrypto.ready()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-mobkey-'))
  try {
    const first = loadMacKey(path.join(dir, 'mobile'))
    const file = path.join(dir, 'mobile', 'mac-key.json')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(dir, 'mobile')).mode & 0o777, 0o700)
    assert.deepEqual(loadMacKey(path.join(dir, 'mobile')).publicKey, first.publicKey)
    fs.writeFileSync(file, '{"v":1,"privateKey":"AAAA"}')
    assert.notDeepEqual(loadMacKey(path.join(dir, 'mobile')).publicKey, first.publicKey)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('로컬 relay — 웹 로그인 → 연결 요청 · 미리 약속 → 허용 → hello → snapshot · pane.open · pane.input → 해제 뒤 거절', { skip: skipRelay, timeout: 30_000 }, async () => {
  const work = fs.mkdtempSync('/tmp/asd-mrel-')
  const stateDir = path.join(work, 'mobile')
  const daemon = await startFakeDaemon(path.join(work, 'd.sock'))
  const relayServer = await startLocalRelay(work)
  const url = `ws://127.0.0.1:${relayServer.port}/ws`
  const lines = []
  const bridges = []
  const asked = []
  const relay = createMobileRelay({
    url,
    dir: stateDir,
    log: (line) => lines.push(line),
    onPairRequest: (request) => asked.push(request),
    createBridge: (transport) => {
      const bridge = createMobileBridge({
        daemonPaths: () => ({ socket: path.join(work, 'd.sock'), log: path.join(work, 'daemon.log'), endpoint: path.join(work, 'endpoint.json') }),
        transport,
        inputAllowed: () => true,
        requests: () => [],
        servers: () => [],
        events: () => [],
        answerRequest: async () => ({ ok: true }),
        leadPaneOf: () => null,
        postDecision: async () => ({ status: 200, body: {} }),
        logEvent: () => {},
        flushMs: 20,
        sizePollMs: 60_000,
      })
      bridges.push(bridge)
      return bridge
    },
  })
  const phone = createFakePhone(url)
  const stranger = createFakePhone(url)
  try {
    await relay.start()
    assert.equal(relay.status().signedIn, false, '토큰이 없으면 붙지 않는다')
    await webSignIn(relay, url, 'tester')
    assert.equal(relay.status().account, 'dev:tester')
    const macId = relay.status().deviceId
    const macStatic = loadMacKey(stateDir).publicKey
    for (const name of ['relay.json', 'mac-key.json']) assert.equal(fs.statSync(path.join(stateDir, name)).mode & 0o777, 0o600, name)

    const login = await phone.call('auth.login', { provider: 'dev', account: 'tester', kind: 'app' })
    assert.equal(login.ok, true)
    const phoneId = login.result.deviceId
    const paired = await phonePair(phone, macId, '시험 폰')
    // 맥은 앱 난수를 받은 뒤에만 번호를 보인다 — 폰과 같은 번호 · 알림 한 번 · 로그에는 번호가 없다
    const pending = await waitFor(() => relay.pending()[0], '맥 쪽 기다리는 요청')
    assert.equal(pending.requestId, paired.requestId)
    assert.equal(pending.code, paired.code)
    assert.equal(pending.label, '시험 폰')
    assert.equal(asked.length, 1)
    assert.ok(!lines.some((line) => line.includes(paired.code)), '맥 로그에 번호가 없다')
    await relay.accept(pending.requestId)
    await waitFor(() => phone.received.find((event) => event.event === 'pair.accepted'), 'pair.accepted')
    assert.deepEqual(relay.peers(), [phoneId])
    assert.deepEqual(relay.devices().map((device) => [device.peer, device.label]), [[phoneId, '시험 폰']])

    await phone.hello(macId, macStatic)
    await waitFor(() => relay.status().sessions.includes(phoneId), '맥 세션')
    const snapshot = await phone.ask(macId, 1, 'snapshot')
    assert.equal(snapshot.ok, true)
    assert.deepEqual(snapshot.result.panes.map((pane) => [pane.id, pane.cols, pane.rows]), [['p1', 120, 40]])
    const opened = await phone.ask(macId, 2, 'pane.open', { pane: 'p1' })
    assert.deepEqual(opened.result, { pane: 'p1', snapshot: 'P1-화면', cols: 120, rows: 40 })
    const typed = await phone.ask(macId, 3, 'pane.input', { pane: 'p1', data: 'ls\r' })
    assert.equal(typed.ok, true)
    await waitFor(() => daemon.state.inputs.length, '데몬 input')
    assert.deepEqual(daemon.state.inputs[0], { pane: 'p1', data: 'ls\r' })

    // 망가진 암호문 → 맥이 세션을 버리고 reset · 다시 hello 하면 이어진다
    phone.clearHandshake()
    phone.send(macId, Buffer.alloc(40, 1).toString('base64'))
    assert.deepEqual(await waitFor(() => phone.handshake(), 'reset'), { hs: 'reset', v: 1 })
    await phone.hello(macId, macStatic)
    assert.equal((await phone.ask(macId, 4, 'snapshot')).ok, true)

    // 짝이 아닌 같은 계정 기기 — relay 가 넘기지 않는다(not_paired)
    await stranger.call('auth.login', { provider: 'dev', account: 'tester', kind: 'app' })
    stranger.send(macId, mobileCrypto.encodeHandshake(mobileCrypto.helloMessage(mobileCrypto.newKeyPair().publicKey)))
    const strangerDrop = await waitFor(() => stranger.received.find((event) => event.event === 'msg.dropped'), '짝 아님 msg.dropped')
    assert.equal(strangerDrop.code, 'not_paired')

    // 폰에서 해제 → 맥은 그 기기 세션 · 브리지를 멈추고 열쇠를 버린다 → 그 뒤 메시지는 relay 가 거절
    const removed = await phone.call('pair.remove', { peer: macId })
    assert.equal(removed.ok, true)
    await waitFor(() => relay.peers().length === 0, '맥 쪽 해제')
    assert.deepEqual(relay.status().sessions, [])
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'relay.json'), 'utf8'))
    assert.deepEqual(saved.peers, {})
    phone.send(macId, mobileCrypto.encodeHandshake(mobileCrypto.helloMessage(mobileCrypto.newKeyPair().publicKey)))
    const dropped = await waitFor(() => phone.received.find((event) => event.event === 'msg.dropped'), '해제 뒤 msg.dropped')
    assert.equal(dropped.code, 'not_paired')

    // 로그에 열쇠 · 토큰이 없다(기기 id 만)
    const keyFile = JSON.parse(fs.readFileSync(path.join(stateDir, 'mac-key.json'), 'utf8'))
    for (const secret of [JSON.parse(fs.readFileSync(path.join(stateDir, 'relay.json'), 'utf8')).token, keyFile.privateKey]) assert.ok(!lines.some((line) => line.includes(secret)), '로그에 비밀이 섞이지 않는다')
  } finally {
    phone.close()
    stranger.close()
    await relay.stop()
    for (const bridge of bridges) await bridge.stop()
    await relayServer.close()
    await daemon.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('로컬 relay — 연결 요청 거두기: 폰이 pair.cancel 하면 허용 창이 닫히고 · 약속 단계를 어기면 맥이 pair.cancel', { skip: skipRelay, timeout: 20_000 }, async () => {
  const work = fs.mkdtempSync('/tmp/asd-mcan-')
  const relayServer = await startLocalRelay(work)
  const url = `ws://127.0.0.1:${relayServer.port}/ws`
  const lines = []
  const relay = createMobileRelay({ url, dir: path.join(work, 'mobile'), log: (line) => lines.push(line), createBridge: () => ({ stop: async () => {}, openPanes: () => [], resyncPane: async () => {} }) })
  const phone = createFakePhone(url)
  try {
    await relay.start()
    await webSignIn(relay, url, 'cancel')
    const macId = relay.status().deviceId
    assert.equal((await phone.call('auth.login', { provider: 'dev', account: 'cancel', kind: 'app' })).ok, true)

    // ① 번호가 뜬 뒤 폰이 거둠 → 맥은 pair.cancelled 를 받고 기다리는 요청을 지운다 · 그 뒤 허용은 안 된다
    const first = await phonePair(phone, macId, '폰')
    await waitFor(() => relay.pending()[0], '맥 쪽 요청')
    assert.equal((await phone.call('pair.cancel', { requestId: first.requestId })).ok, true)
    await waitFor(() => relay.pending().length === 0, '폰이 거둔 뒤 맥 창 닫힘')
    await assert.rejects(relay.accept(first.requestId), (error) => error.code === 'not_found')

    // ② 약속을 받은 폰이 난수 대신 다른 것을 보냄 → 맥이 거두고 폰은 pair.cancelled(cancelled) 를 받는다 · 번호는 뜨지 않는다
    const asked = await phone.call('pair.request', { to: macId, publicKey: mobileCrypto.toBase64Url(phone.keys.publicKey), label: '폰' })
    const requestId = asked.result.requestId
    await waitFor(() => phone.received.find((event) => event.event === 'pair.data' && event.requestId === requestId && mobileCrypto.decodePairData(event.data)?.kind === 'commit'), '두 번째 약속')
    assert.equal((await phone.call('pair.data', { requestId, data: mobileCrypto.encodePairData({ pc: 'reveal', v: 1, n: mobileCrypto.toBase64(mobileCrypto.newPairNonce()) }) })).ok, true)
    const cancelled = await waitFor(() => phone.received.find((event) => event.event === 'pair.cancelled' && event.requestId === requestId), '맥이 거둠')
    assert.equal(cancelled.reason, 'cancelled')
    assert.equal(relay.pending().length, 0)
    assert.ok(lines.some((line) => line.includes('bad_pair_data')))
    // 한 요청에 맥이 보낸 pair.data 는 약속 · 열기 2개뿐(relay 한도 4)
    assert.equal(phone.received.filter((event) => event.event === 'pair.data' && event.requestId === first.requestId).length, 2)
  } finally {
    phone.close()
    await relay.stop()
    await relayServer.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('로컬 relay — 다시 켜면 저장한 토큰으로 resume · 같은 기기 id · 로그아웃은 relay 에서도 토큰을 지운다(auth.logout)', { skip: skipRelay, timeout: 20_000 }, async () => {
  const work = fs.mkdtempSync('/tmp/asd-mres-')
  const relayServer = await startLocalRelay(work)
  const url = `ws://127.0.0.1:${relayServer.port}/ws`
  const options = { url, dir: path.join(work, 'mobile'), log: () => {}, createBridge: () => ({ stop: async () => {}, openPanes: () => [], resyncPane: async () => {} }) }
  try {
    const first = createMobileRelay(options)
    await first.start()
    await webSignIn(first, url, 'resume')
    const deviceId = first.status().deviceId
    await first.stop()
    const lines = []
    const second = createMobileRelay({ ...options, log: (line) => lines.push(line), remoteLogout: (call) => call('auth.logout', {}) })
    await second.start()
    await waitFor(() => second.status().connected, 'resume')
    assert.equal(second.status().deviceId, deviceId)
    const oldToken = JSON.parse(fs.readFileSync(path.join(options.dir, 'relay.json'), 'utf8')).token
    // 맥에서 로그아웃 — relay 에 auth.logout(답 뒤 4004) → 토큰을 버리고 다시 켜도 붙지 않는다
    await second.signOut()
    assert.equal(second.status().signedIn, false)
    assert.ok(lines.includes('[mobile-relay] relay 로그아웃 ok'), lines.join(' / '))
    // relay 에서도 지워졌다 — 옛 토큰으로 resume 하면 invalid_token
    const probe = new WebSocket(url)
    await new Promise((resolve, reject) => { probe.onopen = resolve; probe.onerror = reject })
    const answer = new Promise((resolve) => { probe.onmessage = (event) => resolve(JSON.parse(String(event.data))) })
    probe.send(JSON.stringify({ id: 1, op: 'auth.resume', args: { token: oldToken } }))
    assert.equal((await answer).error?.code, 'invalid_token')
    probe.close()
    await second.stop()
    const third = createMobileRelay(options)
    await third.start()
    await sleep(200)
    assert.equal(third.status().connected, false)
    await third.stop()
  } finally {
    await relayServer.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})

// ── 가짜 relay 소켓 — 맥 로그아웃(remoteLogout · relay 계약 auth.logout {} → {} · 답 뒤 close 4004)만 본다. 로그인 말고는 답하지 않고 받은 op 를 적는다
//   logoutReply: 답(없으면 null) · closeAfter: 답 뒤(또는 답 없이) relay 가 4004 로 끊는지
function fakeRelaySocket({ logoutReply, closeAfter = false }) {
  const seen = { ops: [], closed: [] }
  class FakeSocket {
    constructor() {
      this.readyState = 0
      this.onopen = this.onmessage = this.onclose = this.onerror = null
      setTimeout(() => {
        this.readyState = 1
        if (this.onopen) this.onopen({})
      }, 0)
    }
    send(data) {
      const message = JSON.parse(data)
      seen.ops.push(message.op)
      const reply = (body) => setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ id: message.id, ...body }) }), 0)
      if (message.op === 'auth.resume') reply({ ok: true, result: { deviceId: 'mac-1', account: 'dev:tester' } })
      else if (message.op === 'auth.logout') {
        if (logoutReply) reply(logoutReply)
        if (closeAfter) setTimeout(() => this.relayClose(4004), 5)
      }
    }
    relayClose(code) {
      this.readyState = 3
      if (this.onclose) this.onclose({ code })
    }
    close(code) {
      seen.closed.push(code ?? null)
      this.readyState = 3
      setTimeout(() => this.onclose && this.onclose({ code: code ?? 1000 }), 0)
    }
  }
  return { seen, FakeSocket }
}

async function signedInRelay(work, extra) {
  const dir = path.join(work, 'mobile')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ token: 'tok-시험', deviceId: 'mac-1', account: 'dev:tester', name: null, peers: {} }), { mode: 0o600 })
  const lines = []
  const relay = createMobileRelay({ url: 'ws://127.0.0.1:1/ws', dir, log: (line) => lines.push(line), createBridge: () => ({ stop: async () => {}, openPanes: () => [], resyncPane: async () => {} }), heartbeatMs: 60_000, ...extra })
  await relay.start()
  await waitFor(() => relay.status().connected, '가짜 relay 에 붙음')
  return { relay, dir, lines }
}
const savedToken = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8')).token

test('맥 로그아웃 — remoteLogout 이 있으면 relay 에 먼저 보내고 · 답이 와도 실패해도 시간이 넘어도 로컬을 지운다', async () => {
  const cases = [
    { what: '성공 · 답 뒤 4004', logoutReply: { ok: true, result: {} }, closeAfter: true, outcome: 'relay 로그아웃 ok' },
    { what: '답 없이 4004', logoutReply: null, closeAfter: true, outcome: 'relay 로그아웃 ok(4004)' },
    { what: 'relay 오류', logoutReply: { ok: false, error: { code: 'unauthenticated', message: '' } }, outcome: 'relay 로그아웃 실패 code=unauthenticated' },
    { what: '답 없음', logoutReply: null, outcome: 'relay 로그아웃 timeout' },
  ]
  for (const { what, logoutReply, closeAfter, outcome } of cases) {
    const work = fs.mkdtempSync('/tmp/asd-mlo-')
    const { seen, FakeSocket } = fakeRelaySocket({ logoutReply, closeAfter })
    let signedOutEvents = 0
    let calledWhileSignedIn = null
    try {
      const { relay, dir, lines } = await signedInRelay(work, {
        WebSocketImpl: FakeSocket,
        logoutWaitMs: 100,
        onSignedOut: () => signedOutEvents++,
        remoteLogout: (call) => {
          calledWhileSignedIn = relay.status().signedIn && seen.closed.length === 0
          return call('auth.logout', {})
        },
      })
      // 겹쳐 눌러도 relay 에는 한 번
      await Promise.all([relay.signOut(), relay.signOut()])
      assert.equal(calledWhileSignedIn, true, `${what}: 로컬을 지우기 전 · 끊기 전에 불림`)
      assert.equal(seen.ops.filter((op) => op === 'auth.logout').length, 1, what)
      assert.equal(relay.status().signedIn, false, what)
      assert.equal(relay.status().connected, false, what)
      assert.equal(savedToken(dir), null, `${what}: 저장한 토큰 지움`)
      assert.ok(lines.includes(`[mobile-relay] ${outcome}`) || lines.some((line) => line.startsWith(`[mobile-relay] ${outcome} `)), `${what}: ${lines.join(' / ')}`)
      await sleep(30) // 4004 가 뒤에 와도
      assert.equal(signedOutEvents, 0, `${what}: 4004 는 오류 알림(onSignedOut)이 아니다`)
      assert.ok(!lines.some((line) => line.includes('tok-시험')), '로그에 토큰 없음')
      await sleep(30)
      assert.equal(seen.ops.filter((op) => op === 'auth.resume').length, 1, `${what}: 지운 뒤 다시 붙지 않음`)
      await relay.stop()
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  }
})

test('맥 로그아웃 — 누르지 않았는데 relay 가 4004 로 끊으면 로컬 토큰 · 허용 기기를 지우고 다시 붙지 않는다(오류 알림 없음)', async () => {
  const work = fs.mkdtempSync('/tmp/asd-mlo-')
  try {
    const { seen, FakeSocket } = fakeRelaySocket({ logoutReply: null })
    let socket = null
    class Tracked extends FakeSocket {
      constructor(url) {
        super(url)
        socket = this
      }
    }
    let signedOutEvents = 0
    const peerKey = mobileCrypto.toBase64Url(mobileCrypto.newKeyPair().publicKey)
    const { relay, dir } = await signedInRelay(work, { WebSocketImpl: Tracked, onSignedOut: () => signedOutEvents++ })
    // 허용 기기 하나를 저장해 둔 상태로 — 다시 읽게 relay.json 에 넣고 새로 붙인다
    await relay.stop()
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'))
    fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ ...saved, peers: { 'app-1': { publicKey: peerKey, addedAt: '', label: '폰', lastSeen: null } } }), { mode: 0o600 })
    const again = createMobileRelay({ url: 'ws://127.0.0.1:1/ws', dir, log: () => {}, WebSocketImpl: Tracked, heartbeatMs: 60_000, backoffMs: [5], onSignedOut: () => signedOutEvents++, createBridge: () => ({ stop: async () => {}, openPanes: () => [], resyncPane: async () => {} }) })
    await again.start()
    await waitFor(() => again.status().connected, '다시 붙음')
    assert.equal(again.devices().length, 1)
    socket.relayClose(4004)
    await sleep(50)
    assert.equal(again.status().signedIn, false)
    assert.equal(again.status().connected, false)
    assert.equal(again.devices().length, 0)
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'))
    assert.equal(after.token, null)
    assert.deepEqual(after.peers, {})
    assert.equal(signedOutEvents, 0, '오류 알림 없음')
    assert.equal(seen.ops.filter((op) => op === 'auth.resume').length, 2, '다시 붙지 않음')
    await again.stop()
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('맥 로그아웃 — remoteLogout 이 없거나 relay 에 안 붙어 있으면 relay 에는 아무것도 보내지 않고 로컬만 지운다', async () => {
  const work = fs.mkdtempSync('/tmp/asd-mlo-')
  try {
    // 넘기지 않음
    const plain = fakeRelaySocket({ logoutReply: null })
    const { relay, dir } = await signedInRelay(work, { WebSocketImpl: plain.FakeSocket })
    await relay.signOut()
    assert.deepEqual(plain.seen.ops, ['auth.resume'])
    assert.equal(savedToken(dir), null)
    await relay.stop()
    // 붙어 있지 않음 — 시작 전(소켓 없음)
    fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ token: 'tok-시험', deviceId: 'mac-1', account: 'dev:tester', name: null, peers: {} }), { mode: 0o600 })
    let called = false
    const offline = createMobileRelay({ url: 'ws://127.0.0.1:1/ws', dir, log: () => {}, createBridge: () => ({ stop: async () => {}, openPanes: () => [], resyncPane: async () => {} }), remoteLogout: async () => { called = true } })
    await offline.signOut()
    assert.equal(called, false)
    assert.equal(offline.status().signedIn, false)
    assert.equal(savedToken(dir), null)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('개발용 길 문 — 개발판 · 격리 집 · 루프백 ws 가 모두 있을 때만 켠다', async () => {
  const { mobileDevOptions } = require('../src/main/mobile-dev.mts')
  const env = { ATHENA_STUDIO_MOBILE_RELAY: 'ws://127.0.0.1:3131/ws' }
  assert.deepEqual(mobileDevOptions({ env, packaged: false, homeOverride: '/tmp/iso' }), { url: 'ws://127.0.0.1:3131/ws', base: 'http://127.0.0.1:3131', dir: path.join('/tmp/iso', 'mobile') })
  assert.equal(mobileDevOptions({ env, packaged: true, homeOverride: '/tmp/iso' }), null, '배포판')
  assert.equal(mobileDevOptions({ env, packaged: false, homeOverride: null }), null, '격리 집 없음')
  assert.equal(mobileDevOptions({ env: {}, packaged: false, homeOverride: '/tmp/iso' }), null, '주소 없음')
  for (const relay of ['wss://relay.example.com/ws', 'ws://10.0.0.5:3131/ws', 'http://127.0.0.1:3131/ws', '깨진 주소']) {
    assert.equal(mobileDevOptions({ env: { ...env, ATHENA_STUDIO_MOBILE_RELAY: relay }, packaged: false, homeOverride: '/tmp/iso' }), null, relay)
  }
})

test('화면 이름 — 공급자 이름 · 이메일 먼저, 없으면 개발 계정 이름만(apple · google sub 은 안 보인다)', () => {
  const { displayName } = require('../src/main/mobile-dev.mts')
  assert.equal(displayName('민창', 'google:123'), '민창')
  assert.equal(displayName(null, 'dev:tester'), 'tester')
  assert.equal(displayName(null, 'google:123'), null)
  assert.equal(displayName(null, null), null)
})
