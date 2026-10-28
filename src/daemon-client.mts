// Electron main 쪽 데몬 클라이언트 — 데몬이 없으면 떼어 띄우고(현황판과 같은 방식) 소켓 하나로 붙는다.
// 앱을 닫아도 데몬·셸·에이전트는 계속 돈다 — 앱이 끊는 것은 이 연결뿐이다.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// protocol 은 JS(데몬 CLI 가 PATH 의 node 로도 부른다) — main 과 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const protocol: typeof import('./lib/protocol.js') = require('./lib/protocol.js')

const DAEMON_MAIN = path.join(import.meta.dirname, 'daemon', 'main.mts')
export const CLI = path.join(import.meta.dirname, '..', 'bin', 'athena-studio-cli')

// 데몬 답 한 줄 — 응답 {id, ok, result | error} · 알림 {event, ...}(소켓 JSON 그대로 · 모양 검사는 하지 않는다)
export type Reply = { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: string }
// checkHello 가 받는 모양(protocol.js JSDoc)
type Hello = Parameters<typeof protocol.checkHello>[0]
type DaemonPaths = { socket: string; log: string; endpoint: string }
type Handlers = { onEvent: (message: Reply) => unknown; onClose: () => void }

class DaemonConnection {
  // declare — 타입만(실행 코드에 칸을 만들지 않는다 · 값은 constructor 가 넣는다)
  declare socket: net.Socket
  declare pending: Map<number | undefined, (message: Reply) => void>
  declare nextId: number

  constructor(socket: net.Socket, { onEvent, onClose }: Handlers) {
    this.socket = socket
    this.pending = new Map()
    this.nextId = 1
    socket.setEncoding('utf8')
    socket.on(
      'data',
      protocol.createDecoder((decoded) => {
        const message = decoded as Reply
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
  async call(op: string, args: object = {}, onReply: ((message: Reply) => void) | null = null): Promise<unknown> {
    const reply = await this.request(op, args, onReply)
    if (reply.ok) return reply.result
    const error = reply.error as { code: string; message: string }
    throw Object.assign(new Error(error.message), { code: error.code })
  }

  request(op: string, args: object = {}, onReply: ((message: Reply) => void) | null = null): Promise<Reply> {
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
  notify(op: string, args: object = {}): void {
    if (!this.socket.destroyed) this.socket.write(protocol.encode({ op, args }))
  }

  // 닫기 — 소켓이 실제로 닫히면(위 close 처리 · onClose 가 돈 뒤) 풀리는 약속을 돌려준다
  close(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      if (this.socket.destroyed) resolve()
      else this.socket.once('close', () => resolve())
    })
    this.socket.end()
    return closed
  }

  // 답 없는 데몬 — 상대가 닫아 주지 않아도 바로 끊는다(반쯤 열린 소켓이 쌓이지 않게)
  destroy(): void {
    this.socket.destroy()
  }
}

function connectSocket(socketPath: string): Promise<net.Socket> {
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
function launchDaemon({ paths, env }: { paths: DaemonPaths; env: NodeJS.ProcessEnv }): void {
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
export async function ensureDaemon({ paths, env, onEvent, onClose }: { paths: DaemonPaths; env: NodeJS.ProcessEnv } & Handlers) {
  let socket: net.Socket | null = null
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
  return { connection, hello: reply.result || null, status: protocol.checkHello(reply as Hello), launched }
}

// 떠 있는 데몬에만 붙는다(없으면 띄우지 않고 null) · 프로토콜이 다르면 끊고 null — 켤 때 코어 업데이트 전 pane 상태 읽기용
export async function peekDaemon({ paths }: { paths: DaemonPaths }): Promise<DaemonConnection | null> {
  const socket = await connectSocket(paths.socket).catch(() => null)
  if (!socket) return null
  const connection = new DaemonConnection(socket, { onEvent: () => {}, onClose: () => {} })
  const reply = await connection.request('hello', { protocol: protocol.PROTOCOL })
  if (protocol.checkHello(reply as Hello) === 'ok') return connection
  connection.destroy()
  return null
}

// 소켓이 사라질 때까지(데몬이 끝날 때까지) 기다린다 — 다시 띄우기 전에
export async function waitDaemonGone(socketPath: string, limitMs: number = 5000): Promise<boolean> {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    const socket = await connectSocket(socketPath).catch(() => null)
    if (!socket) return true
    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

