// 모바일 relay 클라이언트(src/main/mobile-relay.mts) — 진짜 로컬 relay(athena-app `relay/` 의 startRelay)와 가짜 폰으로 끝까지 한 바퀴.
// 로그인 → 연결 요청 → 맥 허용(확인 숫자) → hello → snapshot · pane.open · pane.input 왕복 → 해제 뒤 거절.
// relay 는 고치지 않고 실행만 한다 — 자리는 ATHENA_RELAY_DIR(athena-app 의 relay 폴더 · npm install 된 것). 없으면 이 파일의 relay 시험은 등록하지 않는다(skip 으로 세지 않는다 — Actions 넘기기 검사가 skip 0 을 요구한다).
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
const { createMobileBridge } = require('../src/main/mobile-bridge.mts')

const RELAY_DIR = process.env.ATHENA_RELAY_DIR || ''
const relayReady = RELAY_DIR && fs.existsSync(path.join(RELAY_DIR, 'src', 'server.ts')) && fs.existsSync(path.join(RELAY_DIR, 'node_modules', 'ws'))
// relay 가 있을 때만 등록한다 — 없으면 왜 안 도는지 한 줄만 남긴다
const relayTest = relayReady ? test : () => {}
if (!relayReady) console.log('ℹ 로컬 relay 시험 2개는 돌지 않는다 — ATHENA_RELAY_DIR(athena-app relay · npm install 된 것)가 없다')

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
  })
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

relayTest('로컬 relay — 로그인 → 연결 요청 → 허용 → hello → snapshot · pane.open · pane.input → 해제 뒤 거절', { timeout: 30_000 }, async () => {
  const work = fs.mkdtempSync('/tmp/asd-mrel-')
  const stateDir = path.join(work, 'mobile')
  const daemon = await startFakeDaemon(path.join(work, 'd.sock'))
  const relayServer = await startLocalRelay(work)
  const url = `ws://127.0.0.1:${relayServer.port}/ws`
  const lines = []
  const bridges = []
  const relay = createMobileRelay({
    url,
    login: { provider: 'dev', account: 'tester@example.com' },
    dir: stateDir,
    log: (line) => lines.push(line),
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
    await waitFor(() => relay.status().connected, '맥 relay 로그인')
    const macId = relay.status().deviceId
    const macStatic = loadMacKey(stateDir).publicKey
    for (const name of ['relay.json', 'mac-key.json']) assert.equal(fs.statSync(path.join(stateDir, name)).mode & 0o777, 0o600, name)

    const login = await phone.call('auth.login', { provider: 'dev', account: 'tester@example.com', kind: 'app' })
    assert.equal(login.ok, true)
    const phoneId = login.result.deviceId
    const asked = await phone.call('pair.request', { to: macId, publicKey: mobileCrypto.toBase64Url(phone.keys.publicKey) })
    assert.equal(asked.ok, true)
    // 맥이 공개 열쇠를 보내면 폰도 같은 확인 숫자를 계산한다
    const keyEvent = await waitFor(() => phone.received.find((event) => event.event === 'pair.key'), 'pair.key')
    const phoneCode = mobileCrypto.confirmCode(mobileCrypto.keyFrom(keyEvent.publicKey), phone.keys.publicKey)
    const pending = await waitFor(() => relay.pending()[0], '맥 쪽 기다리는 요청')
    assert.equal(pending.code, phoneCode)
    assert.ok(lines.some((line) => line.includes(`확인 숫자 ${phoneCode}`)), '맥 로그에 확인 숫자')
    assert.equal(fs.statSync(path.join(stateDir, 'pair-pending.json')).mode & 0o777, 0o600)
    await relay.accept(pending.requestId)
    await waitFor(() => phone.received.find((event) => event.event === 'pair.accepted'), 'pair.accepted')
    assert.deepEqual(relay.peers(), [phoneId])

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
    await stranger.call('auth.login', { provider: 'dev', account: 'tester@example.com', kind: 'app' })
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

    // 로그에 열쇠 · 토큰이 없다(기기 id · 확인 숫자만)
    const keyFile = JSON.parse(fs.readFileSync(path.join(stateDir, 'mac-key.json'), 'utf8'))
    for (const secret of [saved.token, keyFile.privateKey]) assert.ok(!lines.some((line) => line.includes(secret)), '로그에 비밀이 섞이지 않는다')
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

relayTest('로컬 relay — 다시 켜면 저장한 토큰으로 resume · 같은 기기 id', { timeout: 20_000 }, async () => {
  const work = fs.mkdtempSync('/tmp/asd-mres-')
  const relayServer = await startLocalRelay(work)
  const options = { url: `ws://127.0.0.1:${relayServer.port}/ws`, login: { provider: 'dev', account: 'resume@example.com' }, dir: path.join(work, 'mobile'), log: () => {}, createBridge: () => ({ stop: async () => {}, openPanes: () => [], resyncPane: async () => {} }) }
  try {
    const first = createMobileRelay(options)
    await first.start()
    await waitFor(() => first.status().connected, '첫 로그인')
    const deviceId = first.status().deviceId
    await first.stop()
    const second = createMobileRelay(options)
    await second.start()
    await waitFor(() => second.status().connected, 'resume')
    assert.equal(second.status().deviceId, deviceId)
    await second.stop()
  } finally {
    await relayServer.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('개발용 길 문 — 개발판 · 격리 집 · 루프백 ws · 개발 계정이 모두 있을 때만 켠다', async () => {
  const { mobileDevOptions } = require('../src/main/mobile-dev.mts')
  const env = { ATHENA_STUDIO_MOBILE_RELAY: 'ws://127.0.0.1:3130/ws', ATHENA_STUDIO_MOBILE_DEV_ACCOUNT: 'tester@example.com' }
  assert.deepEqual(mobileDevOptions({ env, packaged: false, homeOverride: '/tmp/iso' }), { url: 'ws://127.0.0.1:3130/ws', account: 'tester@example.com', dir: path.join('/tmp/iso', 'mobile') })
  assert.equal(mobileDevOptions({ env, packaged: true, homeOverride: '/tmp/iso' }), null, '배포판')
  assert.equal(mobileDevOptions({ env, packaged: false, homeOverride: null }), null, '격리 집 없음')
  for (const relay of ['wss://relay.example.com/ws', 'ws://10.0.0.5:3130/ws', 'http://127.0.0.1:3130/ws', '깨진 주소']) {
    assert.equal(mobileDevOptions({ env: { ...env, ATHENA_STUDIO_MOBILE_RELAY: relay }, packaged: false, homeOverride: '/tmp/iso' }), null, relay)
  }
  for (const account of ['', 'a b', 'x'.repeat(65)]) {
    assert.equal(mobileDevOptions({ env: { ...env, ATHENA_STUDIO_MOBILE_DEV_ACCOUNT: account }, packaged: false, homeOverride: '/tmp/iso' }), null, `계정 ${account.length}`)
  }
})

// relay 서버 없이 — 가짜 relay 소켓(WebSocketImpl)으로 공통 세션(mobile-session.mts)을 쓰는 relay 길과 직접 길용 훅을 본다
test('relay 세션 — hello 답 · 봉인 그대로 · onSessionOpen(lan.info) · broadcast · peerOfKey · pauseSession · 해제 때 onPeersChanged', { timeout: 10_000 }, async () => {
  await mobileCrypto.ready()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-mrhook-'))
  const phoneKeys = mobileCrypto.newKeyPair()
  // 허용 기기를 relay.json 저장 형식 그대로 미리 적어 둔다
  fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ token: null, deviceId: null, peers: { 'dev-phone': { publicKey: mobileCrypto.toBase64(phoneKeys.publicKey), addedAt: '2026-11-14T00:00:00.000Z' } } }))
  const sockets = []
  class FakeRelaySocket {
    constructor() {
      this.readyState = 0
      this.sent = []
      sockets.push(this)
      setTimeout(() => {
        this.readyState = 1
        if (this.onopen) this.onopen({})
      })
    }
    send(data) {
      const message = JSON.parse(data)
      this.sent.push(message)
      if (message.op === 'auth.login') setTimeout(() => this.onmessage({ data: JSON.stringify({ id: message.id, ok: true, result: { token: 'fake-token', deviceId: 'dev-mac' } }) }))
    }
    close() {
      this.readyState = 3
    }
  }
  const opened = []
  const stopped = []
  let peersChanged = 0
  const relay = createMobileRelay({
    url: 'ws://127.0.0.1:1/ws',
    login: { provider: 'dev', account: 'tester@example.com' },
    dir,
    log: () => {},
    WebSocketImpl: FakeRelaySocket,
    heartbeatMs: 60_000,
    createBridge: (transport, peer) => ({ stop: async () => void stopped.push(peer), openPanes: () => [], resyncPane: async () => {} }),
    onSessionOpen: (peer, send) => {
      opened.push(peer)
      send({ event: 'lan.info', addrs: ['192.168.0.2'], port: 47390, macId: 'dev-mac' })
    },
    onPeersChanged: () => (peersChanged += 1),
  })
  try {
    await relay.start()
    await waitFor(() => relay.status().connected, '가짜 relay 로그인')
    const socket = sockets[0]
    assert.equal(relay.peerOfKey(phoneKeys.publicKey), 'dev-phone')
    assert.equal(relay.peerOfKey(mobileCrypto.newKeyPair().publicKey), null)

    const ephemeral = mobileCrypto.newKeyPair()
    socket.onmessage({ data: JSON.stringify({ event: 'msg', from: 'dev-phone', data: mobileCrypto.encodeHandshake(mobileCrypto.helloMessage(ephemeral.publicKey)) }) })
    relay.broadcast({ event: 'lan.info', addrs: [], port: 47390, macId: 'dev-mac' })
    const toPhone = socket.sent.filter((message) => message.op === 'msg' && message.args.to === 'dev-phone').map((message) => mobileCrypto.decodeData(message.args.data))
    assert.equal(toPhone[0].kind, 'handshake', '첫 글은 맥 hello 답')
    const macStatic = loadMacKey(dir).publicKey
    const cipher = mobileCrypto.createCipherSession(mobileCrypto.deriveSessionKeys({ role: 'app', staticKey: phoneKeys, ephemeralKey: ephemeral, peerStatic: macStatic, peerEphemeral: mobileCrypto.helloEphemeral(toPhone[0].message) }))
    const plain = toPhone.slice(1).map((entry) => JSON.parse(cipher.open(entry.bytes)))
    assert.deepEqual(plain, [
      { event: 'lan.info', addrs: ['192.168.0.2'], port: 47390, macId: 'dev-mac' },
      { event: 'lan.info', addrs: [], port: 47390, macId: 'dev-mac' },
    ])
    assert.deepEqual(opened, ['dev-phone'])
    assert.deepEqual(relay.status().sessions, ['dev-phone'])

    // 직접 길이 붙었다 — relay 세션은 쉬고 그 브리지를 멈춘다. 그 뒤 relay 로 온 암호문에는 reset(앱이 hello 부터)
    relay.pauseSession('dev-phone')
    assert.deepEqual(relay.status().sessions, [])
    assert.deepEqual(stopped, ['dev-phone'])
    socket.sent.length = 0
    socket.onmessage({ data: JSON.stringify({ event: 'msg', from: 'dev-phone', data: Buffer.alloc(40, 1).toString('base64') }) })
    const reset = socket.sent.map((message) => mobileCrypto.decodeData(message.args.data))
    assert.deepEqual(reset.map((entry) => entry.message), [{ hs: 'reset', v: 1 }])

    socket.onmessage({ data: JSON.stringify({ event: 'pair.removed', peer: 'dev-phone' }) })
    assert.equal(peersChanged, 1)
    assert.deepEqual(relay.peers(), [])
  } finally {
    await relay.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
