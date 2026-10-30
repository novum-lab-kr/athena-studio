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
  const state = { hold: false, released: [] }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const client = { socket, finish: () => socket.end() }
    clients.push(client)
    socket.setEncoding('utf8')
    socket.on('data', protocol.createDecoder((message) => {
      socket.write(protocol.encode({ id: message.id, ok: true, result: message.op === 'hello' ? { protocol: protocol.PROTOCOL } : {} }))
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
  const ctx = { athenaDir, win: null, send: (channel, ...args) => sent.push([channel, ...args]) }
  installDaemonLink(ctx, {
    say: (key) => key,
    daemonPaths: () => ({ socket, log: path.join(dir, 'daemon.log'), endpoint: path.join(dir, 'endpoint.json') }),
    daemonErrorText: (error) => error.message,
    askRestartDaemon: async () => false,
    setDaemonOld: () => {},
    releaseHeldWindows: () => {},
    openUrl: () => {},
  })
  const cleanup = async () => {
    await ctx.detachScreen()
    await daemon.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { ctx, daemon, sent, cleanup }
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
