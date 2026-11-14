// 모바일 직접 길(src/main/mobile-lan.mts) — 127.0.0.1 에 연 진짜 WebSocket 서버와 가짜 폰(Node WebSocket)으로.
// 등록한 열쇠 → snapshot · lan.info / 모르는 열쇠 → 4401 / 순번 거꾸로(재전송) → 4402 / 열쇠만 아는 hello → relay 세션을 끊지 못함 / 한 기기 한 길(4409).
// 데몬은 가짜(유닉스 소켓) — Electron · pty 없이 돈다. 출력에 열쇠 · 본문을 찍지 않는다.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const path = require('path')
const protocol = require('../src/lib/protocol')
const mobileCrypto = require('../src/lib/mobile-crypto.mts')
const { createMobileLan, lanAddresses, lanPortOf, directHello, CLOSE, DEFAULT_PORT, PATH } = require('../src/main/mobile-lan.mts')
const { createMobileBridge } = require('../src/main/mobile-bridge.mts')

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
  const state = { inputs: [], panes: [{ id: 'p1', label: '아테나', agent: 'claude', agent_status: 'working', cols: 120, rows: 40 }] }
  const sockets = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    socket.setEncoding('utf8')
    socket.on('data', protocol.createDecoder((message) => {
      let result = {}
      if (message.op === 'hello') result = { protocol: protocol.PROTOCOL, codeVersion: protocol.DAEMON_CODE }
      else if (message.op === 'attach') result = { state: { panes: [{ id: 'p1', cols: 120, rows: 40 }] }, snapshots: { p1: 'P1-화면' } }
      else if (message.op === 'state') result = { panes: [{ id: 'p1', cols: 120, rows: 40 }] }
      else if (message.op === 'pane list') result = { panes: state.panes }
      else if (message.op === 'input') state.inputs.push(message.args)
      socket.write(protocol.encode({ id: message.id, ok: true, result }))
    }))
    socket.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ state, close: () => new Promise((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()) }) })))
}

// ── 가짜 폰 — 직접 길 hello(eph · pub) · 봉인한 안쪽 요청. sealOnly 로 보내지 않고 봉인만 해 둘 수 있다(재전송 시험)
function connectPhone(url, keys) {
  const socket = new WebSocket(url)
  const inner = []
  let handshake = null
  let cipher = null
  let closed = null
  socket.onmessage = (event) => {
    const decoded = mobileCrypto.decodeData(String(event.data))
    if (decoded && decoded.kind === 'handshake') handshake = decoded.message
    else if (decoded && cipher) {
      const plain = cipher.open(decoded.bytes)
      if (plain !== null) inner.push(JSON.parse(plain))
    }
  }
  socket.onclose = (event) => (closed = { code: event.code })
  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  return {
    inner,
    closed: () => closed,
    raw: (data) => socket.send(data),
    async hello(macStatic, pub = keys.publicKey) {
      await opened
      const ephemeral = mobileCrypto.newKeyPair()
      const message = { ...mobileCrypto.helloMessage(ephemeral.publicKey), pub: mobileCrypto.toBase64(pub) }
      socket.send(Buffer.from(JSON.stringify(message), 'utf8').toString('base64'))
      const reply = await waitFor(() => handshake || closed, '맥 hello 또는 끊김')
      if (!handshake) return false
      cipher = mobileCrypto.createCipherSession(mobileCrypto.deriveSessionKeys({ role: 'app', staticKey: keys, ephemeralKey: ephemeral, peerStatic: macStatic, peerEphemeral: mobileCrypto.helloEphemeral(reply) }))
      return true
    },
    seal: (id, op, args = {}) => cipher.seal(JSON.stringify({ id, op, args })),
    async ask(id, op, args = {}) {
      socket.send(cipher.seal(JSON.stringify({ id, op, args })))
      return waitFor(() => inner.find((message) => message.id === id), `${op} 답`)
    },
    close: () => socket.close(),
  }
}

async function setup(t) {
  await mobileCrypto.ready()
  const work = fs.mkdtempSync('/tmp/asd-mlan-')
  const daemon = await startFakeDaemon(path.join(work, 'd.sock'))
  const macKey = mobileCrypto.newKeyPair()
  const phoneKeys = mobileCrypto.newKeyPair()
  const peers = new Map([['dev-phone', phoneKeys.publicKey]])
  const direct = []
  const bridges = []
  const lines = []
  const lan = createMobileLan({
    port: 0,
    addresses: () => ['127.0.0.1'],
    macKey: () => macKey,
    peerOfKey: (publicKey) => [...peers].find(([, key]) => Buffer.from(key).equals(Buffer.from(publicKey)))?.[0] ?? null,
    peerAllowed: (peer) => peers.has(peer),
    onDirectOpen: (peer) => direct.push(peer),
    macId: () => 'dev-mac',
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
        packs: () => ({ current: null, packs: [] }), // 브리지 필수 칸(snapshot 의 otherPacks)
        logEvent: () => {},
        flushMs: 16,
        sizePollMs: 60_000,
      })
      bridges.push(bridge)
      return bridge
    },
  })
  await lan.start()
  const info = lan.info()
  const phones = []
  const phone = (keys = phoneKeys) => {
    const made = connectPhone(`ws://127.0.0.1:${info.port}${PATH}`, keys)
    phones.push(made)
    return made
  }
  t.after(async () => {
    for (const made of phones) made.close()
    await lan.stop()
    for (const bridge of bridges) await bridge.stop()
    await daemon.close()
    fs.rmSync(work, { recursive: true, force: true })
  })
  return { lan, info, macKey, phoneKeys, peers, direct, lines, phone, daemon }
}

test('받을 주소 — 사설 IPv4 · Tailscale 100.64/10 만(루프백 · 링크 로컬 · 공인 · IPv6 빼고)', () => {
  const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null })
  const interfaces = {
    lo0: [v4('127.0.0.1', true), { address: '::1', family: 'IPv6', internal: true, netmask: '', mac: '', cidr: null, scopeid: 0 }],
    en0: [v4('192.168.0.12'), { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 4 }],
    en1: [v4('10.1.2.3'), v4('172.16.5.5'), v4('172.32.0.1'), v4('169.254.10.10')],
    utun4: [v4('100.101.102.103'), v4('100.128.0.1')],
    en9: [v4('8.8.8.8'), v4('192.168.0.12')],
  }
  assert.deepEqual(lanAddresses(interfaces), ['10.1.2.3', '100.101.102.103', '172.16.5.5', '192.168.0.12'])
})

test('포트 — 기본 47390 · 설정 mobileLanPort(1024~65535 정수만)', () => {
  assert.equal(DEFAULT_PORT, 47390)
  assert.equal(lanPortOf(null), 47390)
  assert.equal(lanPortOf({ mobileLanPort: 50123 }), 50123)
  for (const bad of [80, 70000, '50123', 50123.5, null]) assert.equal(lanPortOf({ mobileLanPort: bad }), 47390, String(bad))
})

test('첫 글 모양 — base64(JSON {hs:hello, v:1, eph, pub}) 만', async () => {
  await mobileCrypto.ready()
  const key = mobileCrypto.toBase64(mobileCrypto.newKeyPair().publicKey)
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  assert.ok(directHello(encode({ hs: 'hello', v: 1, eph: key, pub: key })))
  assert.equal(directHello(encode({ hs: 'hello', v: 1, eph: key })), null, 'pub 없음')
  assert.equal(directHello(encode({ hs: 'hello', v: 2, eph: key, pub: key })), null, 'v2')
  assert.equal(directHello(encode({ hs: 'reset', v: 1 })), null, 'reset')
  assert.equal(directHello('not base64!'), null)
})

test('등록한 열쇠 → hello 답 · 첫 암호문이 열리면 붙음 · snapshot · lan.info · pane.input', { timeout: 15_000 }, async (t) => {
  const { info, macKey, direct, phone, daemon, lines } = await setup(t)
  assert.deepEqual(info.addrs, ['127.0.0.1'])
  assert.equal(info.macId, 'dev-mac')
  const own = phone()
  assert.equal(await own.hello(macKey.publicKey), true)
  assert.deepEqual(direct, [], 'hello 만으로는 붙음이 아니다')
  const snapshot = await own.ask(1, 'snapshot')
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.result.panes.map((pane) => [pane.id, pane.cols, pane.rows]), [['p1', 120, 40]])
  assert.deepEqual(direct, ['dev-phone'])
  const lanInfo = await waitFor(() => own.inner.find((message) => message.event === 'lan.info'), 'lan.info')
  assert.deepEqual(lanInfo, { event: 'lan.info', addrs: ['127.0.0.1'], port: info.port, macId: 'dev-mac' })
  assert.equal((await own.ask(2, 'pane.input', { pane: 'p1', data: 'ls\r' })).ok, true)
  await waitFor(() => daemon.state.inputs.length, '데몬 input')
  assert.deepEqual(daemon.state.inputs[0], { pane: 'p1', data: 'ls\r' })
  assert.ok(!lines.some((line) => line.includes(mobileCrypto.toBase64(macKey.privateKey))), '로그에 비밀 열쇠가 없다')
})

test('모르는 열쇠 → hello 답 없이 4401 로 끊음', { timeout: 10_000 }, async (t) => {
  const { macKey, direct, phone } = await setup(t)
  const stranger = phone(mobileCrypto.newKeyPair())
  assert.equal(await stranger.hello(macKey.publicKey), false)
  assert.equal(stranger.closed().code, CLOSE.unknownKey)
  assert.deepEqual(direct, [])
})

test('첫 글이 hello 가 아니면 4400', { timeout: 10_000 }, async (t) => {
  const { phone } = await setup(t)
  const other = phone()
  await sleep(50)
  other.raw(Buffer.alloc(40, 1).toString('base64'))
  assert.equal((await waitFor(() => other.closed(), '끊김')).code, CLOSE.badHello)
})

test('순번 거꾸로(재전송) → 그 글은 버리고 4402 로 끊음', { timeout: 10_000 }, async (t) => {
  const { macKey, phone } = await setup(t)
  const own = phone()
  await own.hello(macKey.publicKey)
  const first = own.seal(1, 'snapshot') // 순번 0
  const second = own.seal(2, 'snapshot') // 순번 1
  own.raw(second)
  await waitFor(() => own.inner.find((message) => message.id === 2), '순번 1 답')
  own.raw(first) // 순번 0 — 이미 지난 순번
  assert.equal((await waitFor(() => own.closed(), '끊김')).code, CLOSE.badCipher)
  assert.equal(own.inner.find((message) => message.id === 1), undefined, '거꾸로 온 글에는 답하지 않는다')
})

test('등록한 공개 열쇠만 아는 hello — 첫 암호문이 안 열려 4402 · relay 세션은 그대로', { timeout: 10_000 }, async (t) => {
  const { macKey, phoneKeys, direct, phone } = await setup(t)
  const forger = phone(mobileCrypto.newKeyPair()) // 비밀 열쇠가 다르다
  assert.equal(await forger.hello(macKey.publicKey, phoneKeys.publicKey), true)
  forger.raw(forger.seal(1, 'snapshot'))
  assert.equal((await waitFor(() => forger.closed(), '끊김')).code, CLOSE.badCipher)
  assert.deepEqual(direct, [], 'onDirectOpen(relay 세션 쉬기)을 부르지 않는다')
})

test('한 기기 한 길 — 새 직접 연결이 붙으면 옛 것 4409 · relay hello(dropPeer)도 4409 · 해제되면 4410', { timeout: 15_000 }, async (t) => {
  const { lan, macKey, peers, phone } = await setup(t)
  const first = phone()
  await first.hello(macKey.publicKey)
  await first.ask(1, 'snapshot')
  const second = phone()
  await second.hello(macKey.publicKey)
  assert.equal(first.closed(), null, '두 번째가 hello 만 했을 때는 그대로')
  await second.ask(1, 'snapshot')
  assert.equal((await waitFor(() => first.closed(), '옛 연결 끊김')).code, CLOSE.replaced)
  lan.dropPeer('dev-phone')
  assert.equal((await waitFor(() => second.closed(), 'relay hello 로 끊김')).code, CLOSE.replaced)
  const third = phone()
  await third.hello(macKey.publicKey)
  await third.ask(1, 'snapshot')
  peers.delete('dev-phone')
  lan.dropRemoved()
  assert.equal((await waitFor(() => third.closed(), '해제로 끊김')).code, CLOSE.removed)
})

test('hello 가 5초(여기선 짧게) 안에 없으면 4408', { timeout: 10_000 }, async (t) => {
  await mobileCrypto.ready()
  const lan = createMobileLan({ port: 0, addresses: () => ['127.0.0.1'], macKey: () => null, peerOfKey: () => null, peerAllowed: () => false, createBridge: () => ({ stop: async () => {}, openPanes: () => [], resyncPane: async () => {} }), macId: () => null, log: () => {}, helloTimeoutMs: 100 })
  await lan.start()
  t.after(() => lan.stop())
  const socket = new WebSocket(`ws://127.0.0.1:${lan.info().port}${PATH}`)
  const closed = await new Promise((resolve) => (socket.onclose = (event) => resolve(event.code)))
  assert.equal(closed, CLOSE.timeout)
})
