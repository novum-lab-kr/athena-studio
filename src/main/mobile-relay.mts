// ── 모바일 relay 클라이언트 — 맥 브리지를 relay(athena-app `relay/`)에 붙이고 짝 기기마다 암호 세션 · 브리지를 둔다 ──
// 바깥 계약: athena-app relay/docs/protocol.md(v1 · 정본 코드 relay/src/protocol.ts). 안쪽 암호: src/lib/mobile-crypto.mts(계획서 4-7 암호 연결 v1).
// electron 을 import 하지 않는다 — 부르는 쪽이 자리 · 브리지 만들기를 넘긴다. 기본 꺼짐: 지금은 격리 시험 앱의 개발용 길(src/main.mts)만 만든다.
//
// 남기는 것: 상태 폴더(0700) 안 mac-key.json(맥 고정 X25519 열쇠) · relay.json(세션 토큰 · 기기 id · 허용한 기기의 공개 열쇠) — 모두 0600.
// 로그에는 기기 id · 크기 · 개수 · 오류 코드 · 확인 숫자만(세션 토큰 · 비밀 열쇠 · 메시지 본문은 남기지 않는다).
import fs from 'node:fs'
import path from 'node:path'
import * as mobileCrypto from '../lib/mobile-crypto.mts'
import type { KeyPair } from '../lib/mobile-crypto.mts'
import type { Transport } from './mobile-bridge.mts'

export const HEARTBEAT_MS = 30_000 // 살아 있나 — 30초마다 devices.list(브라우저식 WebSocket 은 ping 을 못 보내고 relay ping 에는 pong 을 저절로 한다)
export const REPLY_TIMEOUT_MS = 10_000
export const RESYNC_DELAY_MS = 1000 // msg.dropped 뒤 그 기기의 열린 pane 다시 맞추기(Q5)
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] // 다시 붙기(최대 30초 · 4-7)
const KEY_FILE = 'mac-key.json'
const STATE_FILE = 'relay.json'
const PENDING_FILE = 'pair-pending.json' // 개발용 허용 길 — 지금 기다리는 연결 요청(확인 숫자 포함)
const ANSWER_FILE = 'pair-answer.json' // 개발용 허용 길 — scripts/mobile-pair.js 가 적는 답

export type BridgeHandle = { stop(): Promise<void>; openPanes(): string[]; resyncPane(pane: string): Promise<void> }
export type PendingPair = { requestId: string; from: string; code: string; at: string }
type PeerRecord = { publicKey: string; addedAt: string }
type SavedState = { token: string | null; deviceId: string | null; peers: Record<string, PeerRecord> }
type WebSocketLike = {
  readyState: number
  send(data: string): void
  close(code?: number): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}
type WebSocketCtor = new (url: string) => WebSocketLike

export type RelayDeps = {
  url: string
  login: { provider: 'dev'; account: string } // 시험 2 는 개발 로그인만 — 진짜 Apple · Google 은 시험 5
  dir: string // 상태 폴더
  createBridge: (transport: Transport, peer: string) => BridgeHandle
  onPairRequest?: (request: PendingPair) => void
  log?: (line: string) => void
  WebSocketImpl?: WebSocketCtor
  heartbeatMs?: number
  replyTimeoutMs?: number
  resyncDelayMs?: number
  backoffMs?: number[]
}

class RelayCallError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// 비밀이 든 파일 — 폴더 0700 · 파일 0600 · 임시 파일에 쓰고 바꿔 끼운다
function writeSecret(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const staging = `${file}.tmp`
  fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(staging, 0o600)
  fs.renameSync(staging, file)
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// 맥 고정 열쇠 — 있으면 읽고(비밀 열쇠에서 다시 계산한 공개 열쇠와 맞아야) 없으면 만든다. mobileCrypto.ready() 뒤에 부른다
export function loadMacKey(dir: string): KeyPair {
  const file = path.join(dir, KEY_FILE)
  const saved = readJson(file)
  const privateKey = saved ? mobileCrypto.keyFrom(saved.privateKey) : null
  if (privateKey) {
    const publicKey = mobileCrypto.publicKeyOf(privateKey)
    const savedPublic = mobileCrypto.keyFrom(saved && saved.publicKey)
    if (savedPublic && Buffer.from(savedPublic).equals(Buffer.from(publicKey))) {
      fs.chmodSync(file, 0o600)
      return { publicKey, privateKey }
    }
  }
  const pair = mobileCrypto.newKeyPair()
  writeSecret(file, { v: 1, publicKey: mobileCrypto.toBase64(pair.publicKey), privateKey: mobileCrypto.toBase64(pair.privateKey) })
  return pair
}

function loadState(dir: string): SavedState {
  const saved = readJson(path.join(dir, STATE_FILE)) || {}
  const peers: Record<string, PeerRecord> = {}
  const rawPeers = saved.peers && typeof saved.peers === 'object' ? (saved.peers as Record<string, unknown>) : {}
  for (const [peer, record] of Object.entries(rawPeers)) {
    const value = record as Partial<PeerRecord> | null
    if (value && mobileCrypto.keyFrom(value.publicKey)) peers[peer] = { publicKey: String(value.publicKey), addedAt: String(value.addedAt || '') }
  }
  return { token: typeof saved.token === 'string' && saved.token ? saved.token : null, deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : null, peers }
}

type PeerSession = {
  cipher: ReturnType<typeof mobileCrypto.createCipherSession>
  assembler: ReturnType<typeof mobileCrypto.createAssembler>
  bridge: BridgeHandle | null
  handler: ((message: unknown) => void) | null
  resyncTimer: NodeJS.Timeout | null
}

export function createMobileRelay(deps: RelayDeps) {
  const log = deps.log || ((line: string) => console.log(line))
  const WebSocketImpl = deps.WebSocketImpl || (globalThis.WebSocket as unknown as WebSocketCtor)
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
  const replyTimeoutMs = deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS
  const resyncDelayMs = deps.resyncDelayMs ?? RESYNC_DELAY_MS
  const backoffMs = deps.backoffMs ?? BACKOFF_MS
  let macKey: KeyPair | null = null
  let state: SavedState = loadState(deps.dir)
  let socket: WebSocketLike | null = null
  let authed = false
  let stopped = true
  let replaced = false
  let attempt = 0
  let reconnectTimer: NodeJS.Timeout | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  let nextCallId = 1
  let nextChunkId = 1
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  const sessions = new Map<string, PeerSession>()
  const pendingPairs = new Map<string, PendingPair & { publicKey: string }>()

  const saveState = () => writeSecret(path.join(deps.dir, STATE_FILE), state)
  const writePending = () => writeSecret(path.join(deps.dir, PENDING_FILE), { pending: [...pendingPairs.values()].map(({ requestId, from, code, at }) => ({ requestId, from, code, at })) })

  function rawSend(message: object): boolean {
    if (!socket || socket.readyState !== 1) return false
    socket.send(JSON.stringify(message))
    return true
  }

  function call(op: string, args: object): Promise<unknown> {
    const id = nextCallId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(id)
        reject(new RelayCallError('timeout', `${op} 답이 없어요`))
      }, replyTimeoutMs)
      calls.set(id, { resolve, reject, timer })
      if (!rawSend({ id, op, args })) {
        clearTimeout(timer)
        calls.delete(id)
        reject(new RelayCallError('offline', 'relay 에 붙어 있지 않아요'))
      }
    })
  }

  // 평문 핸드셰이크(hello 답 · reset) — base64 JSON 을 msg.data 에(Q1)
  const sendHandshake = (peer: string, message: mobileCrypto.Handshake) => rawSend({ op: 'msg', args: { to: peer, data: mobileCrypto.encodeHandshake(message) } })

  // 안쪽 메시지 하나 → JSON → 2 MiB 조각(필요하면) → 조각마다 봉인해 msg 로
  function sendInner(peer: string, session: PeerSession, message: object) {
    if (sessions.get(peer) !== session) return
    const pieces = mobileCrypto.splitMessage(JSON.stringify(message), `m${nextChunkId++}`)
    for (const piece of pieces) rawSend({ op: 'msg', args: { to: peer, data: session.cipher.seal(piece) } })
  }

  function stopSession(peer: string, why: string) {
    const session = sessions.get(peer)
    if (!session) return
    sessions.delete(peer)
    if (session.resyncTimer) clearTimeout(session.resyncTimer)
    if (session.bridge) session.bridge.stop().catch(() => {})
    log(`[mobile-relay] 세션 닫음 peer=${peer} 까닭=${why}`)
  }

  // 앱 hello → 일회 열쇠로 답하고 새 세션(마지막 hello 가 이긴다 · 그 기기 브리지도 새로 — Q3)
  function onHello(peer: string, appStatic: Uint8Array, appEphemeral: Uint8Array) {
    if (!macKey) return
    const ephemeralKey = mobileCrypto.newKeyPair()
    let keys: mobileCrypto.SessionKeys
    try {
      keys = mobileCrypto.deriveSessionKeys({ role: 'mac', staticKey: macKey, ephemeralKey, peerStatic: appStatic, peerEphemeral: appEphemeral })
    } catch {
      log(`[mobile-relay] hello 버림 peer=${peer} 까닭=bad_key`)
      return
    }
    stopSession(peer, 'new_hello')
    const session: PeerSession = { cipher: mobileCrypto.createCipherSession(keys), assembler: mobileCrypto.createAssembler(), bridge: null, handler: null, resyncTimer: null }
    sessions.set(peer, session)
    sendHandshake(peer, mobileCrypto.helloMessage(ephemeralKey.publicKey))
    const transport: Transport = {
      send: (message) => sendInner(peer, session, message),
      onMessage: (handler) => void (session.handler = handler),
      close: () => {},
    }
    session.bridge = deps.createBridge(transport, peer)
    log(`[mobile-relay] 세션 열림 peer=${peer}`)
  }

  function onPeerMessage(peer: string, data: unknown) {
    const record = state.peers[peer]
    // 허용 목록에 없는 기기는 hello 든 무엇이든 버린다(Q6)
    if (!record) return log(`[mobile-relay] 버림 peer=${peer} 까닭=not_allowed`)
    const appStatic = mobileCrypto.keyFrom(record.publicKey)
    const incoming = mobileCrypto.decodeData(data)
    if (!appStatic || !incoming) return
    if (incoming.kind === 'handshake') {
      const ephemeral = mobileCrypto.helloEphemeral(incoming.message)
      if (ephemeral) onHello(peer, appStatic, ephemeral)
      return
    }
    const session = sessions.get(peer)
    const plain = session ? session.cipher.open(incoming.bytes) : null
    if (!session || plain === null) {
      // 세션이 없거나 복호화 실패 · 순번 역행 — 세션을 버리고 앱에 hello 부터 다시 하라고(Q3)
      stopSession(peer, session ? 'bad_cipher' : 'no_session')
      sendHandshake(peer, mobileCrypto.RESET)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(plain)
    } catch {
      return
    }
    const message = session.assembler.add(parsed)
    if (message !== null && session.handler) session.handler(message)
  }

  // 맥 → 앱 출력이 버려졌다 — 1초 뒤 그 기기의 열린 pane 을 한 번씩 다시 맞춘다(1초 안 여러 번은 한 번 · Q5)
  function onDropped(peer: string, code: unknown) {
    log(`[mobile-relay] 버려짐 peer=${peer} code=${String(code)}`)
    const session = sessions.get(peer)
    if (!session || session.resyncTimer) return
    session.resyncTimer = setTimeout(() => {
      session.resyncTimer = null
      if (sessions.get(peer) !== session || !session.bridge) return
      for (const pane of session.bridge.openPanes()) session.bridge.resyncPane(pane).catch(() => {})
    }, resyncDelayMs)
  }

  async function onPairRequest(event: Record<string, unknown>) {
    const requestId = String(event.requestId || '')
    const from = String(event.from || '')
    const appPublic = mobileCrypto.keyFrom(event.publicKey)
    if (!requestId || !from || !appPublic || !macKey) return
    try {
      await call('pair.key', { requestId, publicKey: mobileCrypto.toBase64Url(macKey.publicKey) })
    } catch (error) {
      return log(`[mobile-relay] pair.key 실패 requestId=${requestId} code=${(error as RelayCallError).code}`)
    }
    const pending = { requestId, from, code: mobileCrypto.confirmCode(macKey.publicKey, appPublic), at: new Date().toISOString(), publicKey: String(event.publicKey) }
    pendingPairs.set(requestId, pending)
    writePending()
    log(`[mobile-relay] 연결 요청 requestId=${requestId} from=${from} 확인 숫자 ${pending.code}`)
    if (deps.onPairRequest) deps.onPairRequest({ requestId, from, code: pending.code, at: pending.at })
  }

  function onEvent(event: Record<string, unknown>) {
    const peer = typeof event.peer === 'string' ? event.peer : ''
    switch (event.event) {
      case 'msg':
        return onPeerMessage(String(event.from || ''), event.data)
      case 'msg.dropped':
        return onDropped(String(event.to || ''), event.code)
      case 'peer.offline':
        return stopSession(peer, 'peer_offline')
      case 'peer.online':
        return // 앱이 hello 를 먼저 보낸다
      case 'pair.removed':
        stopSession(peer, 'pair_removed')
        if (state.peers[peer]) {
          delete state.peers[peer]
          saveState()
        }
        return log(`[mobile-relay] 기기 해제 peer=${peer}`)
      case 'pair.request':
        return void onPairRequest(event)
      case 'pair.cancelled':
        pendingPairs.delete(String(event.requestId || ''))
        return writePending()
      case 'session.replaced':
        replaced = true
        return log('[mobile-relay] 같은 기기가 다른 곳에서 붙었어요 — 다시 붙지 않아요')
      default:
        return
    }
  }

  function onFrame(raw: unknown) {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    if (typeof message.event === 'string') return onEvent(message)
    const waiting = typeof message.id === 'number' ? calls.get(message.id) : undefined
    if (!waiting) return
    calls.delete(message.id as number)
    clearTimeout(waiting.timer)
    if (message.ok === true) waiting.resolve(message.result)
    else {
      const error = (message.error || {}) as { code?: unknown; message?: unknown }
      waiting.reject(new RelayCallError(String(error.code || 'failed'), String(error.message || '')))
    }
  }

  async function authenticate() {
    if (state.token) {
      try {
        const result = (await call('auth.resume', { token: state.token })) as { deviceId?: unknown }
        state.deviceId = String(result.deviceId || state.deviceId || '')
        return
      } catch (error) {
        if ((error as RelayCallError).code !== 'invalid_token') throw error
        // 끝난 토큰 — relay 가 그 기기와 쌍을 지웠다. 새 기기로 다시 로그인하고 허용 목록도 비운다
        log('[mobile-relay] 세션이 끝나 새로 로그인해요 — 허용한 기기를 비워요')
        state = { token: null, deviceId: null, peers: {} }
      }
    }
    const result = (await call('auth.login', { ...deps.login, kind: 'mac' })) as { token?: unknown; deviceId?: unknown }
    state.token = String(result.token || '')
    state.deviceId = String(result.deviceId || '')
    saveState()
  }

  function clearConnection() {
    authed = false
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    for (const [id, waiting] of calls) {
      clearTimeout(waiting.timer)
      waiting.reject(new RelayCallError('offline', 'relay 연결이 끊겼어요'))
      calls.delete(id)
    }
    for (const peer of [...sessions.keys()]) stopSession(peer, 'relay_closed')
    // relay 는 끊긴 쪽의 연결 요청을 취소한다 — 다시 붙으면 앱이 새로 요청한다
    if (pendingPairs.size) {
      pendingPairs.clear()
      writePending()
    }
  }

  function scheduleReconnect() {
    if (stopped || replaced || reconnectTimer) return
    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 30000
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect() {
    if (stopped) return
    let own: WebSocketLike
    try {
      own = new WebSocketImpl(deps.url)
    } catch {
      return scheduleReconnect()
    }
    socket = own
    own.onmessage = (event) => {
      if (socket === own) onFrame(event.data)
    }
    own.onerror = () => {}
    own.onclose = (event) => {
      if (socket !== own) return
      socket = null
      clearConnection()
      log(`[mobile-relay] relay 끊김 code=${event && event.code}`)
      if (event && event.code === 4001) replaced = true
      scheduleReconnect()
    }
    own.onopen = () => {
      if (socket !== own) return
      authenticate()
        .then(() => {
          if (socket !== own) return
          authed = true
          attempt = 0
          log(`[mobile-relay] 붙음 device=${state.deviceId} 허용 기기 ${Object.keys(state.peers).length}개`)
          heartbeatTimer = setInterval(() => {
            call('devices.list', {}).catch(() => {
              // 답이 없으면 반쯤 끊긴 연결 — 끊고 다시 붙는다
              if (socket === own) own.close()
            })
          }, heartbeatMs)
        })
        .catch((error) => {
          log(`[mobile-relay] 로그인 실패 code=${(error as RelayCallError).code}`)
          if (socket === own) own.close()
        })
    }
  }

  async function answerPair(requestId: string, accept: boolean) {
    const pending = pendingPairs.get(requestId)
    if (!pending) throw new RelayCallError('not_found', '기다리는 연결 요청이 아니에요')
    pendingPairs.delete(requestId)
    writePending()
    if (!accept) {
      await call('pair.reject', { requestId })
      return log(`[mobile-relay] 연결 거절 requestId=${requestId}`)
    }
    const result = (await call('pair.accept', { requestId })) as { peer?: unknown }
    const peer = String(result.peer || pending.from)
    state.peers[peer] = { publicKey: pending.publicKey, addedAt: new Date().toISOString() }
    saveState()
    log(`[mobile-relay] 연결 허용 requestId=${requestId} peer=${peer}`)
  }

  return {
    async start() {
      if (!stopped) return
      await mobileCrypto.ready()
      macKey = loadMacKey(deps.dir)
      stopped = false
      replaced = false
      connect()
    },
    async stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      const own = socket
      socket = null
      clearConnection()
      if (own) own.close()
    },
    accept: (requestId: string) => answerPair(requestId, true),
    reject: (requestId: string) => answerPair(requestId, false),
    // 맥에서 해제 — relay 에서 지우고 열쇠를 버린다
    async removePeer(peer: string) {
      stopSession(peer, 'removed_here')
      delete state.peers[peer]
      saveState()
      await call('pair.remove', { peer }).catch((error) => {
        if ((error as RelayCallError).code !== 'not_found') throw error
      })
    },
    pending: () => [...pendingPairs.values()].map(({ requestId, from, code, at }) => ({ requestId, from, code, at })),
    peers: () => Object.keys(state.peers),
    status: () => ({ connected: authed, deviceId: state.deviceId, sessions: [...sessions.keys()] }),
  }
}

// 개발용 허용 길 — scripts/mobile-pair.js 가 상태 폴더에 적은 답(pair-answer.json)을 0.5초마다 읽어 허용/거절한다. 격리 시험 앱에서만 부른다
export function watchPairAnswers(relay: ReturnType<typeof createMobileRelay>, dir: string, everyMs = 500): () => void {
  const file = path.join(dir, ANSWER_FILE)
  const timer = setInterval(() => {
    const answer = readJson(file)
    if (!answer) return
    fs.rmSync(file, { force: true })
    const requestId = String(answer.requestId || '')
    const accept = answer.answer === 'accept'
    if (!requestId || (!accept && answer.answer !== 'reject')) return
    relay[accept ? 'accept' : 'reject'](requestId).catch((error) => console.log(`[mobile-relay] 답 실패 requestId=${requestId} code=${(error as RelayCallError).code}`))
  }, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}

export const PAIR_FILES = { pending: PENDING_FILE, answer: ANSWER_FILE }
