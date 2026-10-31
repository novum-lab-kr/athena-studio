// 데몬 연결(src/main/daemon-link.mts) — 옛 연결의 닫힘이 새 연결이 붙은 뒤에 와도 연결이 하나만 남는다(gh170)
// 가짜 데몬(유닉스 소켓)으로 실제 daemon-client 를 태운다 — Electron · pty 없이 돈다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const path = require('path')
const protocol = require('../src/lib/protocol')
const { installDaemonLink } = require('../src/main/daemon-link.mts')

// 소켓 경로 104바이트 제한 — /tmp 아래 짧게
const workDir = () => fs.mkdtempSync('/tmp/asd-link-')

// 가짜 데몬 — hello · attach 에 ok 로 답하고, 클라이언트가 end 해도 hold 동안은 자기 쪽을 닫지 않는다(느린 닫힘)
function startFakeDaemon(socketPath) {
  const clients = []
  const state = { hold: false, released: [], helloDelay: 0, hello: { protocol: protocol.PROTOCOL, codeVersion: protocol.DAEMON_CODE }, ops: [], onReload: null }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const client = { socket, finish: () => socket.end() }
    clients.push(client)
    socket.setEncoding('utf8')
    socket.on('data', protocol.createDecoder((message) => {
      state.ops.push(message.op)
      if (message.op === 'daemon reload' && state.onReload) state.onReload()
      const reply = () => socket.write(protocol.encode({ id: message.id, ok: true, result: message.op === 'hello' ? state.hello : {} }))
      if (message.op === 'hello' && state.helloDelay) setTimeout(reply, state.helloDelay)
      else reply()
    }))
    socket.on('error', () => {})
    socket.on('end', () => {
      if (state.hold) state.released.push(client)
      else client.finish()
    })
  })
  return new Promise((resolve) =>
    server.listen(socketPath, () =>
      resolve({
        state,
        clients,
        // 살아 있는(아직 닫히지 않은) 연결 수
        live: () => clients.filter((client) => !client.socket.destroyed).length,
        broadcastData: (pane, data) => {
          for (const client of clients) if (!client.socket.destroyed) client.socket.write(protocol.encode({ event: 'data', pane, data }))
        },
        releaseHeld: () => {
          state.hold = false
          for (const client of state.released.splice(0)) client.finish()
        },
        close: () => new Promise((done) => { for (const client of clients) client.socket.destroy(); server.close(() => done()) }),
      }),
    ),
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, what, limitMs = 3000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    if (await check()) return
    await sleep(20)
  }
  throw new Error(`${what} 를 기다리다 시간 초과`)
}

async function setup() {
  const dir = workDir()
  const athenaDir = path.join(dir, 'body')
  fs.mkdirSync(path.join(athenaDir, 'scripts', 'board'), { recursive: true })
  fs.writeFileSync(path.join(athenaDir, 'CLAUDE.md'), '')
  fs.writeFileSync(path.join(athenaDir, 'scripts', 'board', 'server.mjs'), '')
  const socket = path.join(dir, 'd.sock')
  const daemon = await startFakeDaemon(socket)
  const sent = []
  const notices = []
  const ctx = { athenaDir, win: null, send: (channel, ...args) => sent.push([channel, ...args]) }
  installDaemonLink(ctx, {
    say: (key) => key,
    daemonPaths: () => ({ socket, log: path.join(dir, 'daemon.log'), endpoint: path.join(dir, 'endpoint.json') }),
    daemonErrorText: (error) => error.message,
    askRestartDaemon: async () => false,
    setDaemonOld: () => {},
    noticeOldCode: () => notices.push('old'),
    releaseHeldWindows: () => {},
    openUrl: () => {},
  })
  const cleanup = async () => {
    await ctx.detachScreen()
    await daemon.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { ctx, daemon, sent, notices, cleanup }
}

const dataChunks = (sent) => sent.filter(([channel]) => channel === 'pane:data').map(([, , data]) => data)

test('기본: attach 한 번이면 연결 1개 · 출력 한 번', async () => {
  const { ctx, daemon, sent, cleanup } = await setup()
  try {
    await ctx.attachScreen()
    assert.equal(daemon.live(), 1)
    daemon.broadcastData('p1', 'hello')
    await waitFor(() => dataChunks(sent).length > 0, '출력')
    await sleep(40)
    assert.deepEqual(dataChunks(sent), ['hello'])
  } finally {
    await cleanup()
  }
})

test('gh170: 옛 연결의 닫힘이 새 연결이 붙은 뒤에 와도 연결은 하나 · 출력은 한 번', async () => {
  const { ctx, daemon, sent, cleanup } = await setup()
  try {
    await ctx.attachScreen() // 연결 A
    daemon.state.hold = true // A 의 닫힘이 늦다
    const detaching = ctx.detachScreen() // 팩 바꾸기 — 기다리지 않는다(rebindBody)
    await ctx.attachScreen() // 연결 B
    daemon.releaseHeld() // 이제야 A 가 닫힌다
    await detaching
    await sleep(40)
    // 새 연결이 살아 있는데 앱이 잃어버렸으면 다음 요청이 연결을 하나 더 만든다
    await ctx.attachScreen()
    await waitFor(() => daemon.live() >= 1, '연결')
    assert.equal(daemon.live(), 1, '살아 있는 연결이 하나여야 한다')
    sent.length = 0
    daemon.broadcastData('p1', 'x')
    await waitFor(() => dataChunks(sent).length > 0, '출력')
    await sleep(60)
    assert.deepEqual(dataChunks(sent), ['x'], '출력이 한 번만 와야 한다')
  } finally {
    await cleanup()
  }
})

test('gh170: 떼어 낸 옛 연결이 새 연결이 붙는 중에 닫혀도 끊김 알림은 나가지 않는다', async () => {
  const { ctx, daemon, sent, cleanup } = await setup()
  try {
    await ctx.attachScreen() // 연결 A
    daemon.state.hold = true
    const detaching = ctx.detachScreen()
    daemon.state.helloDelay = 300 // B 의 hello 가 늦다 — 붙는 중
    const attaching = ctx.attachScreen()
    await sleep(50)
    daemon.releaseHeld() // 붙는 중에 A 가 닫힌다
    await detaching
    await attaching
    assert.equal(sent.filter(([channel]) => channel === 'screen:disconnected').length, 0)
    assert.equal(ctx.screenDetached(), false)
    assert.equal(daemon.live(), 1)
  } finally {
    await cleanup()
  }
})

test('gh170: 떼어 낸 뒤 새 연결이 붙기 전에 옛 연결이 보낸 출력은 버린다', async () => {
  const { ctx, daemon, sent, cleanup } = await setup()
  try {
    await ctx.attachScreen() // 연결 A
    daemon.state.hold = true // A 의 소켓은 한동안 살아 있다
    const detaching = ctx.detachScreen() // 기다리지 않는다 — 새 연결은 아직 없다
    daemon.broadcastData('p1', 'late')
    await sleep(60)
    assert.deepEqual(dataChunks(sent), [], '떼어 낸 연결의 출력이 화면으로 가면 안 된다')
    daemon.releaseHeld()
    await detaching
  } finally {
    await cleanup()
  }
})

test('앱이 스스로 끊고 새 연결이 없으면 닫힘을 화면에 알린다(데몬 다시 띄우기가 기댄다)', async () => {
  const { ctx, sent, cleanup } = await setup()
  try {
    await ctx.attachScreen()
    await ctx.detachScreen()
    assert.equal(sent.filter(([channel]) => channel === 'screen:disconnected').length, 1)
    assert.equal(ctx.screenDetached(), true)
  } finally {
    await cleanup()
  }
})

test('코드 판 없는 옛 데몬: 교체를 요청하지 않고 안내만 한다', async () => {
  const { ctx, daemon, notices, cleanup } = await setup()
  try {
    daemon.state.hello = { protocol: protocol.PROTOCOL }
    await ctx.attachScreen()
    assert.equal(daemon.state.ops.includes('daemon reload'), false)
    assert.equal(daemon.state.ops.includes('shutdown'), false)
    assert.deepEqual(notices, ['old'])
  } finally {
    await cleanup()
  }
})

test('코드 판이 낮은 데몬: 교체를 요청하고 성공하면 안내하지 않는다', async () => {
  const { ctx, daemon, notices, cleanup } = await setup()
  try {
    daemon.state.hello = { protocol: protocol.PROTOCOL, codeVersion: protocol.DAEMON_CODE - 1 }
    daemon.state.onReload = () => (daemon.state.hello = { protocol: protocol.PROTOCOL, codeVersion: protocol.DAEMON_CODE })
    await ctx.attachScreen()
    assert.equal(daemon.state.ops.filter((op) => op === 'daemon reload').length, 1)
    assert.deepEqual(notices, [])
  } finally {
    await cleanup()
  }
})

test('코드 판이 낮고 교체가 실패하면(판 그대로) 안내하고 끄지 않는다', async () => {
  const { ctx, daemon, notices, cleanup } = await setup()
  try {
    daemon.state.hello = { protocol: protocol.PROTOCOL, codeVersion: protocol.DAEMON_CODE - 1 }
    await ctx.attachScreen()
    assert.deepEqual(notices, ['old'])
    assert.equal(daemon.state.ops.includes('shutdown'), false)
  } finally {
    await cleanup()
  }
})

test('최신 데몬: 교체도 안내도 없다', async () => {
  const { ctx, daemon, notices, cleanup } = await setup()
  try {
    await ctx.attachScreen()
    assert.equal(daemon.state.ops.includes('daemon reload'), false)
    assert.deepEqual(notices, [])
  } finally {
    await cleanup()
  }
})
