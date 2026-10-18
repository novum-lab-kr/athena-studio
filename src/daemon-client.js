// Electron main 쪽 데몬 클라이언트 — 데몬이 없으면 떼어 띄우고(현황판과 같은 방식) 소켓 하나로 붙는다.
// 앱을 닫아도 데몬·셸·에이전트는 계속 돈다 — 앱이 끊는 것은 이 연결뿐이다.
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const protocol = require('./lib/protocol')

const DAEMON_MAIN = path.join(__dirname, 'daemon', 'main.js')
const CLI = path.join(__dirname, '..', 'bin', 'athena-studio-cli')

class DaemonConnection {
  constructor(socket, { onEvent, onClose }) {
    this.socket = socket
    this.pending = new Map()
    this.nextId = 1
    socket.setEncoding('utf8')
    socket.on(
      'data',
      protocol.createDecoder((message) => {
        if (message.event) return onEvent(message)
        const done = this.pending.get(message.id)
        if (!done) return undefined
        this.pending.delete(message.id)
        return done(message)
      }),
    )
    socket.on('error', () => {})
    socket.on('close', () => {
      for (const done of this.pending.values()) done({ ok: false, error: { code: 'unavailable', message: '데몬 연결이 끊겼어요' } })
      this.pending.clear()
      onClose()
    })
  }

  // 답을 기다리는 요청 — 실패하면 Error(code). onReply 는 답 줄을 읽은 그 자리에서 곧바로(같은 소켓의 뒤 알림보다 먼저) 부른다
  async call(op, args = {}, onReply = null) {
    const reply = await this.request(op, args, onReply)
    if (reply.ok) return reply.result
    throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
  }

  request(op, args = {}, onReply = null) {
    const id = this.nextId++
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve({ ok: false, error: { code: 'unavailable', message: '데몬 연결이 끊겼어요' } })
      this.pending.set(id, (message) => {
        if (onReply) onReply(message)
        resolve(message)
      })
      this.socket.write(protocol.encode({ id, op, args }))
      return undefined
    })
  }

  // 답이 필요 없는 것(입력·크기) — 빠르게 흘려보낸다
  notify(op, args = {}) {
    if (!this.socket.destroyed) this.socket.write(protocol.encode({ op, args }))
  }

  close() {
    this.socket.end()
  }

  // 답 없는 데몬 — 상대가 닫아 주지 않아도 바로 끊는다(반쯤 열린 소켓이 쌓이지 않게)
  destroy() {
    this.socket.destroy()
  }
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => {
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

// 데몬을 떼어 띄운다 — 앱의 Electron 을 node 로(S2). 출력은 daemon.log
function launchDaemon({ paths, env }) {
  fs.mkdirSync(path.dirname(paths.log), { recursive: true })
  const log = fs.openSync(paths.log, 'a')
  fs.writeSync(log, `\n── ${new Date().toISOString()} 데몬 시작\n`)
  try {
    const child = spawn(process.execPath, [DAEMON_MAIN, '--socket', paths.socket, '--endpoint', paths.endpoint, '--cli', CLI], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: ['ignore', log, log],
    })
    child.unref()
  } finally {
    fs.closeSync(log)
  }
}

// 붙기 — 없으면 띄우고 5초까지 기다린다. → { connection, hello, launched }
async function ensureDaemon({ paths, env, onEvent, onClose }) {
  let socket = null
  let launched = false
  try {
    socket = await connectSocket(paths.socket)
  } catch {
    launchDaemon({ paths, env })
    launched = true
    for (let attempt = 0; attempt < 50 && !socket; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      socket = await connectSocket(paths.socket).catch(() => null)
    }
  }
  // code · log 는 앱이 화면 문구(사전)를 고를 때 쓴다 — 글은 CLI · 로그용
  if (!socket) throw Object.assign(new Error(`데몬에 붙지 못했어요 — 로그: ${paths.log}`), { code: 'attach-failed', log: paths.log })
  const connection = new DaemonConnection(socket, { onEvent, onClose })
  const reply = await connection.request('hello', { protocol: protocol.PROTOCOL })
  return { connection, hello: reply.result || null, status: protocol.checkHello(reply), launched }
}

// 답을 limitMs 안에 — 넘으면 Error(code timeout). 보기만 하는 연결이 답 없는 데몬에 묶여 멈추지 않게
function withTimeout(promise, limitMs) {
  let timer = null
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('데몬이 답하지 않아요'), { code: 'timeout' })), limitMs)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// 떠 있는 데몬에만 붙기 — 없으면 띄우지 않고, 프로토콜이 다르거나 답이 없으면 끊고 null(앱이 보기만 하는 연결 · 팩 줄 '도는 중')
async function connectExisting({ paths, onEvent = () => {}, onClose = () => {}, limitMs = 3000 }) {
  const socket = await connectSocket(paths.socket).catch(() => null)
  if (!socket) return null
  const connection = new DaemonConnection(socket, { onEvent, onClose })
  const reply = await withTimeout(connection.request('hello', { protocol: protocol.PROTOCOL }), limitMs).catch(() => null)
  if (protocol.checkHello(reply) === 'ok') return connection
  if (reply) connection.close()
  else connection.destroy() // 시간 초과
  return null
}

// 소켓이 사라질 때까지(데몬이 끝날 때까지) 기다린다 — 다시 띄우기 전에
async function waitDaemonGone(socketPath, limitMs = 5000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    const socket = await connectSocket(socketPath).catch(() => null)
    if (!socket) return true
    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

module.exports = { ensureDaemon, connectExisting, withTimeout, waitDaemonGone, CLI }
