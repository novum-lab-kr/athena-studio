// ── 모바일 직접 길 — 같은 Wi-Fi(· Tailscale)에서 폰이 relay 를 거치지 않고 맥에 붙는 WebSocket 서버 ──
// 계획서 plans/feature/20261114-폰-맥-같은-Wi-Fi-직접-연결.md 5절 "공통 스펙". relay 길(mobile-relay.mts)과 같은 암호 세션(mobile-session.mts).
//
// 받는 곳: LAN 사설 IPv4 · Tailscale 100.64/10 주소마다 따로 연다(0.0.0.0 · 127.0.0.1 에 열지 않는다) — ws://<주소>:<포트>/athena
// WebSocket 글 하나 = relay msg.data 와 같은 base64 글 하나(핸드셰이크 JSON 또는 순번 8B ‖ 암호문).
// 첫 글은 hello 에 폰 고정 공개 열쇠를 더한 것 — {hs:'hello', v:1, eph, pub}. pub 이 relay.json peers 에 없으면 끊는다(4401).
// hello 만으로는 그 열쇠의 주인인지 모른다(공개 열쇠는 비밀이 아니다) — 첫 암호문이 열려야 "붙음"으로 치고 그때 브리지를 만들고
// 그 기기의 relay 세션을 쉬게 한다(onDirectOpen). 그래서 열쇠만 아는 사람은 relay 세션을 끊지 못한다.
// 로그에는 기기 id · 주소 · 닫힘 코드만(열쇠 · 본문은 남기지 않는다).
import os from 'node:os'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import * as mobileCrypto from '../lib/mobile-crypto.mts'
import type { KeyPair } from '../lib/mobile-crypto.mts'
import type { Transport } from './mobile-bridge.mts'
import { answerHello, createSecureChannel } from './mobile-session.mts'
import type { BridgeHandle, SecureChannel } from './mobile-session.mts'

// 47390 — IANA 등록 없음(/etc/services) · 맥 임시 포트(49152~) 아래 · 현황판(4700 부터 2씩) · 개발 서버 흔한 자리와 멀다(2026-11-14 확인)
export const DEFAULT_PORT = 47390
export const PATH = '/athena'
export const HELLO_TIMEOUT_MS = 5000 // 붙고 나서 hello 까지
export const CONFIRM_TIMEOUT_MS = 10_000 // hello 뒤 첫 암호문까지(앱은 붙자마자 snapshot 을 묻는다)
export const PING_MS = 15_000 // 살아 있나 — 다음 ping 때까지 pong 이 없으면 끊는다
export const ADDRESS_POLL_MS = 5000 // 맥 주소가 바뀌었나(노드에는 바뀜 알림이 없다)
export const MAX_FRAME_BYTES = 4 * 1024 * 1024 // 조각 하나(JSON 2 MiB) 봉인 · base64 의 넉넉한 위
export const DIRECT_FLUSH_MS = 16 // 직접 길 출력 묶음 — relay 의 초당 msg 상한이 없다(relay 길은 mobile-bridge FLUSH_MS 그대로)

// 닫힘 코드 — 앱이 고른다(바꾸면 앱도)
export const CLOSE = {
  goingAway: 1001, // 맥이 멈춤 · 그 주소가 사라짐
  badHello: 4400, // 첫 글이 v1 hello(eph · pub)가 아님 · hello 를 두 번
  unknownKey: 4401, // pub 이 허용한 기기 열쇠가 아님
  badCipher: 4402, // 복호화 실패 · 순번 역행(재전송)
  timeout: 4408, // hello 5초 · 첫 암호문 10초 · pong 없음
  replaced: 4409, // 같은 기기가 새로 붙음(직접 길 다시 · relay hello)
  removed: 4410, // 기기 해제
} as const

const PRIVATE_V4 = [
  [0x0a000000, 8], // 10/8
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
] as const
const TAILSCALE_V4: readonly [number, number] = [0x64400000, 10] // 100.64/10(CGNAT — Tailscale 이 쓰는 자리)

function v4Number(address: string): number | null {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return parts.reduce((sum, part) => sum * 256 + part, 0)
}
const inRange = (value: number, [base, bits]: readonly [number, number]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits))

// 받을 주소 — 루프백 · 링크 로컬 · 공인 주소 · IPv6 는 빼고 사설 IPv4 와 Tailscale 100.x 만(정렬 · 겹침 없음)
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const found = new Set<string>()
  for (const list of Object.values(interfaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const value = v4Number(info.address)
      if (value === null) continue
      if (PRIVATE_V4.some((range) => inRange(value, range)) || inRange(value, TAILSCALE_V4)) found.add(info.address)
    }
  }
  return [...found].sort()
}

// 앱 설정(userData/config.json)의 mobileLanPort — 1024~65535 정수가 아니면 기본값
export function lanPortOf(config: { [key: string]: unknown } | null | undefined): number {
  const value = config ? config.mobileLanPort : undefined
  return Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535 ? (value as number) : DEFAULT_PORT
}

// 첫 글 — 직접 길 hello(일회 · 고정 공개 열쇠). 모양이 틀리면 null
export function directHello(data: unknown): { ephemeral: Uint8Array; publicKey: Uint8Array } | null {
  const incoming = mobileCrypto.decodeData(data)
  if (!incoming || incoming.kind !== 'handshake') return null
  const ephemeral = mobileCrypto.helloEphemeral(incoming.message)
  const publicKey = mobileCrypto.keyFrom(incoming.message.pub)
  return ephemeral && publicKey ? { ephemeral, publicKey } : null
}

export type LanInfo = { event: 'lan.info'; addrs: string[]; port: number; macId: string | null }

export type LanDeps = {
  port: number // 0 이면 주소마다 아무 포트(시험)
  macKey: () => KeyPair | null
  peerOfKey: (publicKey: Uint8Array) => string | null
  peerAllowed: (peer: string) => boolean
  createBridge: (transport: Transport, peer: string) => BridgeHandle
  onDirectOpen?: (peer: string) => void // 첫 암호문이 열렸다 — 그 기기 relay 세션을 쉬게
  onAddressesChanged?: (info: LanInfo) => void // 받는 주소가 바뀌었다 — relay 세션에도 lan.info
  macId: () => string | null
  addresses?: () => string[]
  log?: (line: string) => void
  helloTimeoutMs?: number
  confirmTimeoutMs?: number
  pingMs?: number
  addressPollMs?: number
}

type Conn = {
  socket: WebSocket
  address: string // 받은 맥 주소(그 주소가 사라지면 닫는다)
  peer: string | null
  channel: SecureChannel | null
  bridge: BridgeHandle | null
  confirmed: boolean
  timer: NodeJS.Timeout | null
  alive: boolean
}

export function createMobileLan(deps: LanDeps) {
  const log = deps.log || ((line: string) => console.log(line))
  const addresses = deps.addresses || (() => lanAddresses())
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS
  const servers = new Map<string, { server: WebSocketServer; port: number }>() // 주소 → 그 주소에서 받는 서버
  const failed = new Set<string>() // 열지 못한 주소 — 사라졌다 다시 생길 때까지 다시 열지 않는다(로그가 쌓이지 않게)
  const conns = new Set<Conn>()
  const active = new Map<string, Conn>() // 기기 → 붙은(첫 암호문이 열린) 직접 연결 하나
  let stopped = true
  let pollTimer: NodeJS.Timeout | null = null
  let pingTimer: NodeJS.Timeout | null = null
  let lastKey = ''
  let reconciling: Promise<void> | null = null

  function closeConn(conn: Conn, code: number, why: string) {
    if (!conns.delete(conn)) return
    if (conn.timer) clearTimeout(conn.timer)
    conn.timer = null
    if (conn.channel) conn.channel.close()
    if (conn.peer && active.get(conn.peer) === conn) active.delete(conn.peer)
    if (conn.bridge) conn.bridge.stop().catch(() => {})
    try {
      conn.socket.close(code)
    } catch {
      conn.socket.terminate()
    }
    if (conn.peer) log(`[mobile-lan] 끊음 peer=${conn.peer} code=${code} 까닭=${why}`)
  }

  function info(): LanInfo {
    const addrs = [...servers.keys()].sort()
    const first = addrs[0]
    const port = deps.port || (first ? (servers.get(first)?.port ?? 0) : 0)
    return { event: 'lan.info', addrs, port, macId: deps.macId() }
  }

  function onHello(conn: Conn, data: string) {
    const hello = directHello(data)
    const macKey = deps.macKey()
    if (!hello || !macKey) return closeConn(conn, CLOSE.badHello, 'bad_hello')
    const peer = deps.peerOfKey(hello.publicKey)
    if (!peer) {
      log('[mobile-lan] 모르는 열쇠 — 끊음 code=4401')
      return closeConn(conn, CLOSE.unknownKey, 'unknown_key')
    }
    const opened = answerHello(macKey, hello.publicKey, hello.ephemeral)
    if (!opened) return closeConn(conn, CLOSE.badHello, 'bad_key')
    conn.peer = peer
    conn.channel = createSecureChannel(opened.keys, (sealed) => {
      if (conns.has(conn) && conn.socket.readyState === conn.socket.OPEN) conn.socket.send(sealed)
    })
    conn.socket.send(mobileCrypto.encodeHandshake(opened.reply))
    if (conn.timer) clearTimeout(conn.timer)
    conn.timer = setTimeout(() => closeConn(conn, CLOSE.timeout, 'confirm_timeout'), confirmTimeoutMs)
  }

  // 첫 암호문이 열렸다 — 이 연결이 그 기기의 길(옛 직접 연결은 replaced · relay 세션은 쉼)
  function confirm(conn: Conn, peer: string, channel: SecureChannel) {
    conn.confirmed = true
    if (conn.timer) clearTimeout(conn.timer)
    conn.timer = null
    const previous = active.get(peer)
    if (previous && previous !== conn) closeConn(previous, CLOSE.replaced, 'new_direct')
    active.set(peer, conn)
    if (deps.onDirectOpen) deps.onDirectOpen(peer)
    conn.bridge = deps.createBridge(channel.transport, peer)
    channel.send(info())
    log(`[mobile-lan] 붙음 peer=${peer}`)
  }

  function onFrame(conn: Conn, raw: unknown, isBinary: boolean) {
    if (!conns.has(conn)) return
    const data = isBinary ? null : String(raw)
    if (data === null) return closeConn(conn, CLOSE.badHello, 'binary')
    if (!conn.channel || !conn.peer) return onHello(conn, data)
    const incoming = mobileCrypto.decodeData(data)
    // hello 를 또 보내는 것은 새 연결로 — 한 연결에 세션 하나
    if (!incoming || incoming.kind !== 'cipher') return closeConn(conn, CLOSE.badHello, 'second_handshake')
    const opened = conn.channel.open(incoming.bytes)
    if (opened === null) return closeConn(conn, CLOSE.badCipher, 'bad_cipher')
    if (!conn.confirmed) {
      // 열쇠를 확인하는 사이 해제됐으면 받지 않는다
      if (!deps.peerAllowed(conn.peer)) return closeConn(conn, CLOSE.removed, 'removed')
      confirm(conn, conn.peer, conn.channel)
    }
    conn.channel.deliver(opened.message)
  }

  function onConnection(socket: WebSocket, address: string) {
    if (stopped) return socket.terminate()
    const conn: Conn = { socket, address, peer: null, channel: null, bridge: null, confirmed: false, timer: null, alive: true }
    conns.add(conn)
    conn.timer = setTimeout(() => closeConn(conn, CLOSE.timeout, 'hello_timeout'), helloTimeoutMs)
    socket.on('message', (raw, isBinary) => onFrame(conn, raw, isBinary))
    socket.on('pong', () => void (conn.alive = true))
    socket.on('close', () => closeConn(conn, CLOSE.goingAway, 'closed'))
    socket.on('error', () => {})
  }

  function openServer(address: string): Promise<void> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({ host: address, port: deps.port, path: PATH, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, clientTracking: false })
      let listening = false
      server.once('listening', () => {
        listening = true
        const bound = server.address()
        servers.set(address, { server, port: typeof bound === 'object' && bound ? bound.port : deps.port })
        log(`[mobile-lan] 받음 ${address}:${servers.get(address)?.port}${PATH}`)
        resolve()
      })
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (listening) return log(`[mobile-lan] 서버 오류 ${address} code=${error.code || 'error'}`)
        failed.add(address)
        log(`[mobile-lan] 열지 못함 ${address}:${deps.port} code=${error.code || 'error'}`)
        server.close()
        resolve()
      })
      server.on('connection', (socket) => onConnection(socket, address))
    })
  }

  function closeServer(address: string) {
    const entry = servers.get(address)
    if (!entry) return
    servers.delete(address)
    entry.server.close()
    // 그 주소로 붙은 연결도 닫는다
    for (const conn of [...conns]) if (conn.address === address) closeConn(conn, CLOSE.goingAway, 'address_gone')
    log(`[mobile-lan] 닫음 ${address}`)
  }

  // 주소 맞추기 — 새 주소는 열고 사라진 주소는 닫는다. 받는 주소 목록이 바뀌었으면 알린다(겹쳐 부르면 도는 것을 기다린다)
  function reconcile(): Promise<void> {
    if (!reconciling) reconciling = reconcileOnce().finally(() => (reconciling = null))
    return reconciling
  }
  async function reconcileOnce() {
    if (stopped) return
    const wanted = new Set(addresses())
    for (const address of [...failed]) if (!wanted.has(address)) failed.delete(address)
    for (const address of [...servers.keys()]) if (!wanted.has(address)) closeServer(address)
    for (const address of wanted) if (!servers.has(address) && !failed.has(address)) await openServer(address)
    if (stopped) return
    const now = info()
    const key = `${now.addrs.join(',')}:${now.port}`
    if (key === lastKey) return
    lastKey = key
    for (const conn of active.values()) if (conn.channel) conn.channel.send(now)
    if (deps.onAddressesChanged) deps.onAddressesChanged(now)
  }

  function ping() {
    for (const conn of [...conns]) {
      if (!conn.alive) {
        closeConn(conn, CLOSE.timeout, 'no_pong')
        continue
      }
      conn.alive = false
      try {
        conn.socket.ping()
      } catch {}
    }
  }

  return {
    async start() {
      if (!stopped) return
      stopped = false
      lastKey = ''
      await reconcile()
      pollTimer = setInterval(() => void reconcile(), deps.addressPollMs ?? ADDRESS_POLL_MS)
      pollTimer.unref()
      pingTimer = setInterval(ping, deps.pingMs ?? PING_MS)
      pingTimer.unref()
    },
    async stop() {
      stopped = true
      if (pollTimer) clearInterval(pollTimer)
      if (pingTimer) clearInterval(pingTimer)
      pollTimer = null
      pingTimer = null
      for (const conn of [...conns]) closeConn(conn, CLOSE.goingAway, 'stop')
      for (const address of [...servers.keys()]) closeServer(address)
      failed.clear()
    },
    // relay 로 hello 가 왔다 — 그 기기 직접 연결을 닫는다(마지막 hello 가 이긴다 · 한 기기 한 길)
    dropPeer(peer: string) {
      const conn = active.get(peer)
      if (conn) closeConn(conn, CLOSE.replaced, 'relay_hello')
    },
    // 허용 목록이 줄었다 — 빠진 기기의 연결(붙었든 확인 중이든)을 닫는다
    dropRemoved() {
      for (const conn of [...conns]) if (conn.peer && !deps.peerAllowed(conn.peer)) closeConn(conn, CLOSE.removed, 'removed')
    },
    info,
    reconcile,
    status: () => ({ addrs: info().addrs, peers: [...active.keys()] }),
  }
}
