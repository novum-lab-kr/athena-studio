// ── 모바일 relay 클라이언트 — 맥 브리지를 relay(athena-app `relay/`)에 붙이고 짝 기기마다 암호 세션 · 브리지를 둔다 ──
// 바깥 계약: athena-app relay/docs/protocol.md(v1 · 정본 코드 relay/src/protocol.ts). 안쪽 암호: src/lib/mobile-crypto.mts(계획서 4-7 암호 연결 v1).
// electron 을 import 하지 않는다 — 부르는 쪽이 자리 · 브리지 만들기를 넘긴다. 기본 꺼짐: 지금은 개발판의 개발용 길(src/main.mts)만 만든다.
// 로그인: 웹 로그인(mobile-login.mts)으로 받은 세션 토큰을 signIn 으로 넘기면 /ws 에 auth.resume 으로 붙는다. 토큰이 없으면 붙지 않는다(로그아웃 상태).
// 연결 허용: 인증번호 미리 약속 v1(계획서 4-7) — pair.key 뒤 약속 → 앱 난수 → 열기가 끝나야 [허용] 창에 번호가 뜬다.
//
// 남기는 것: 상태 폴더(0700) 안 mac-key.json(맥 고정 X25519 열쇠) · relay.json(세션 토큰 · 기기 id · 계정 · 이름 · 허용한 기기의 공개 열쇠 · 이름 · 마지막 접속) — 모두 0600.
// 로그에는 기기 id · 크기 · 개수 · 오류 코드만(세션 토큰 · 비밀 열쇠 · 난수 · 인증번호 · 메시지 본문은 남기지 않는다).
import fs from 'node:fs'
import path from 'node:path'
import * as mobileCrypto from '../lib/mobile-crypto.mts'
import type { KeyPair } from '../lib/mobile-crypto.mts'
import type { Transport } from './mobile-bridge.mts'
import { mobileLog } from './mobile-log.mts'
import { answerHello, createSecureChannel } from './mobile-session.mts'
import type { BridgeHandle, SecureChannel } from './mobile-session.mts'

export type { BridgeHandle }

export const HEARTBEAT_MS = 30_000 // 살아 있나 — 30초마다 devices.list(브라우저식 WebSocket 은 ping 을 못 보내고 relay ping 에는 pong 을 저절로 한다)
export const REPLY_TIMEOUT_MS = 10_000
export const RESYNC_DELAY_MS = 1000 // msg.dropped 뒤 그 기기의 열린 pane 다시 맞추기(Q5)
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] // 다시 붙기(최대 30초 · 4-7)
const KEY_FILE = 'mac-key.json'
const STATE_FILE = 'relay.json'
export const PAIR_TTL_MS = 5 * 60_000 // relay 연결 요청 만료(5분) — [허용] 창의 남은 시간
const LABEL_MAX = 64 // relay label 상한
export const CLOSE_ACCOUNT_DELETED = 4003 // 웹에서 계정 삭제 — 토큰 · 짝 열쇠를 버린다
export const CLOSE_LOGGED_OUT = 4004 // auth.logout 답 뒤 relay 가 끊음 — 로그아웃 결과라 다시 붙지 않고 오류로 알리지 않는다
export const LOGOUT_WAIT_MS = 3000 // 맥 로그아웃 때 relay 답을 기다리는 한도 — 넘으면 relay 쪽은 두고 로컬만 지운다

// [허용] 창에 보일 것 — 번호는 열기(reveal)를 보낸 뒤에만 생긴다
export type PendingPair = { requestId: string; from: string; label: string | null; code: string; at: string; expiresAt: string }
export type PeerView = { peer: string; label: string | null; online: boolean; lastSeen: string | null }
type PeerRecord = { publicKey: string; addedAt: string; label: string | null; lastSeen: string | null }
type SavedState = { token: string | null; deviceId: string | null; account: string | null; name: string | null; peers: Record<string, PeerRecord> }
// 웹 로그인 교환 결과(relay POST /api/login/token) 중 맥이 쓰는 칸
export type SignInResult = { token: string; deviceId: string; account: string; name: string | null }
type PairStage = { requestId: string; from: string; label: string | null; publicKey: string; appPublic: Uint8Array; macNonce: Uint8Array; nonceSeen: boolean; code: string | null; at: string; expiresAt: string }
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
  dir: string // 상태 폴더
  createBridge: (transport: Transport, peer: string) => BridgeHandle
  onPairRequest?: (request: PendingPair) => void // 번호가 뜰 때(열기를 보낸 뒤) 한 번
  onChange?: () => void // 연결 · 로그인 · 기기 · 기다리는 요청이 바뀜(화면 다시 그리기)
  onSignedOut?: (why: 'expired' | 'account_deleted') => void // relay 가 세션을 끝냄 — 토큰 · 짝 열쇠를 버린 뒤
  // 맥 로그아웃 때 relay 에서 이 세션을 지우는 요청 — 붙어 있을 때 로컬을 지우기 전에 한 번 부른다(실패 · 시간 초과여도 로컬은 지운다).
  // op 이름 · 응답 모양은 relay 계약(protocol.md)이 정한다 — 부르는 쪽이 계약대로 넘기고, 없으면 relay 에는 보내지 않는다
  remoteLogout?: (call: (op: string, args: object) => Promise<unknown>) => Promise<unknown>
  logoutWaitMs?: number
  onSessionOpen?: (peer: string, send: (message: object) => void) => void // 그 기기 relay 세션이 열림(hello 답 뒤) — 직접 길 닫기 · lan.info
  onPeersChanged?: () => void // 허용 목록이 줄었다(해제 · 로그아웃 · 토큰 끝남 · 새 로그인) — 직접 길이 그 기기를 끊는다
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

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
// 기기 이름 — 줄바꿈 · 제어 글자를 빼고 64자까지(relay 가 넘긴 그대로 믿지 않는다)
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LABEL_MAX)
  return text || null
}
const EMPTY_STATE = (): SavedState => ({ token: null, deviceId: null, account: null, name: null, peers: {} })

function loadState(dir: string): SavedState {
  const saved = readJson(path.join(dir, STATE_FILE)) || {}
  const peers: Record<string, PeerRecord> = {}
  const rawPeers = saved.peers && typeof saved.peers === 'object' ? (saved.peers as Record<string, unknown>) : {}
  for (const [peer, record] of Object.entries(rawPeers)) {
    const value = record as Record<string, unknown> | null
    if (value && mobileCrypto.keyFrom(value.publicKey)) peers[peer] = { publicKey: String(value.publicKey), addedAt: String(value.addedAt || ''), label: cleanLabel(value.label), lastSeen: textOrNull(value.lastSeen) }
  }
  return { token: textOrNull(saved.token), deviceId: textOrNull(saved.deviceId), account: textOrNull(saved.account), name: cleanLabel(saved.name), peers }
}

type PeerSession = {
  channel: SecureChannel
  bridge: BridgeHandle | null
  resyncTimer: NodeJS.Timeout | null
}

export function createMobileRelay(deps: RelayDeps) {
  const log = deps.log || mobileLog
  const WebSocketImpl = deps.WebSocketImpl || (globalThis.WebSocket as unknown as WebSocketCtor)
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
  const replyTimeoutMs = deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS
  const logoutWaitMs = deps.logoutWaitMs ?? LOGOUT_WAIT_MS
  let signingOut: Promise<void> | null = null // 로그아웃이 겹쳐 눌려도 한 번만
  let loggedOutByRelay = false // 로그아웃 중 relay 가 4004 로 끊음(답보다 먼저 와도 성공으로 친다)
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
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  const sessions = new Map<string, PeerSession>()
  const pendingPairs = new Map<string, PairStage>()
  const changed = () => deps.onChange && deps.onChange()

  const saveState = () => writeSecret(path.join(deps.dir, STATE_FILE), state)
  const pendingView = (): PendingPair[] =>
    [...pendingPairs.values()].flatMap(({ requestId, from, label, code, at, expiresAt }) => (code ? [{ requestId, from, label, code, at, expiresAt }] : []))

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

  function stopSession(peer: string, why: string) {
    const session = sessions.get(peer)
    if (!session) return
    sessions.delete(peer)
    session.channel.close()
    if (session.resyncTimer) clearTimeout(session.resyncTimer)
    if (session.bridge) session.bridge.stop().catch(() => {})
    const record = state.peers[peer]
    if (record) {
      record.lastSeen = new Date().toISOString()
      saveState()
    }
    log(`[mobile-relay] 세션 닫음 peer=${peer} 까닭=${why}`)
    changed()
  }

  // 앱 hello → 일회 열쇠로 답하고 새 세션(마지막 hello 가 이긴다 · 그 기기 브리지도 새로 — Q3)
  function onHello(peer: string, appStatic: Uint8Array, appEphemeral: Uint8Array) {
    if (!macKey) return
    const opened = answerHello(macKey, appStatic, appEphemeral)
    if (!opened) {
      log(`[mobile-relay] hello 버림 peer=${peer} 까닭=bad_key`)
      return
    }
    stopSession(peer, 'new_hello')
    // 봉인한 조각은 그 세션이 아직 그 기기의 세션일 때만 msg 로
    const channel = createSecureChannel(opened.keys, (data) => {
      if (sessions.get(peer) === session) rawSend({ op: 'msg', args: { to: peer, data } })
    })
    const session: PeerSession = { channel, bridge: null, resyncTimer: null }
    sessions.set(peer, session)
    sendHandshake(peer, opened.reply)
    session.bridge = deps.createBridge(channel.transport, peer)
    log(`[mobile-relay] 세션 열림 peer=${peer}`)
    changed()
    if (deps.onSessionOpen) deps.onSessionOpen(peer, channel.send)
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
    const opened = session ? session.channel.open(incoming.bytes) : null
    if (!session || opened === null) {
      // 세션이 없거나 복호화 실패 · 순번 역행 — 세션을 버리고 앱에 hello 부터 다시 하라고(Q3)
      stopSession(peer, session ? 'bad_cipher' : 'no_session')
      sendHandshake(peer, mobileCrypto.RESET)
      return
    }
    session.channel.deliver(opened.message)
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

  // 기다리는 요청을 거둔다(약속 단계가 깨짐) — 상대는 pair.cancelled 를 받는다. 이미 끝났으면(not_found) 그대로 둔다
  function cancelPair(requestId: string, why: string) {
    if (pendingPairs.delete(requestId)) changed()
    log(`[mobile-relay] 연결 요청 거둠 requestId=${requestId} why=${why}`)
    call('pair.cancel', { requestId }).catch((error) => log(`[mobile-relay] pair.cancel 실패 requestId=${requestId} code=${(error as RelayCallError).code}`))
  }

  // 연결 요청 — 맥 공개 열쇠를 보내고 바로 새 난수 Nm 에 약속한다(번호는 앱 난수를 받은 뒤 · 4-7 인증번호 미리 약속 v1)
  async function onPairRequest(event: Record<string, unknown>) {
    const requestId = String(event.requestId || '')
    const from = String(event.from || '')
    const appPublic = mobileCrypto.keyFrom(event.publicKey)
    if (!requestId || !from || !appPublic || !macKey || pendingPairs.has(requestId)) return
    const at = new Date()
    const stage: PairStage = {
      requestId,
      from,
      label: cleanLabel(event.label),
      publicKey: String(event.publicKey),
      appPublic,
      macNonce: mobileCrypto.newPairNonce(),
      nonceSeen: false,
      code: null,
      at: at.toISOString(),
      expiresAt: new Date(at.getTime() + PAIR_TTL_MS).toISOString(),
    }
    pendingPairs.set(requestId, stage)
    try {
      await call('pair.key', { requestId, publicKey: mobileCrypto.toBase64Url(macKey.publicKey) })
      const commit = mobileCrypto.pairCommit(macKey.publicKey, appPublic, stage.macNonce)
      await call('pair.data', { requestId, data: mobileCrypto.encodePairData({ pc: 'commit', v: 1, c: mobileCrypto.toBase64(commit) }) })
    } catch (error) {
      log(`[mobile-relay] 연결 요청 처리 실패 requestId=${requestId} code=${(error as RelayCallError).code}`)
      return cancelPair(requestId, 'commit_failed')
    }
    log(`[mobile-relay] 연결 요청 requestId=${requestId} from=${from} — 앱 난수를 기다려요`)
  }

  // 앱 난수(한 번만 · 약속을 보낸 뒤에만) → 맥 난수를 열고 번호를 만든다.
  // 모르는 요청 · 다른 보낸이는 버리고, 그 요청의 상대가 약속 단계를 어기면(난수가 아님 · 두 번째 난수) 요청을 거둔다
  async function onPairData(event: Record<string, unknown>) {
    const requestId = String(event.requestId || '')
    const stage = pendingPairs.get(requestId)
    if (!stage || !macKey || String(event.from || '') !== stage.from) return log(`[mobile-relay] pair.data 버림 requestId=${requestId}`)
    const data = mobileCrypto.decodePairData(event.data)
    if (!data || data.kind !== 'nonce' || stage.nonceSeen) return cancelPair(requestId, 'bad_pair_data')
    stage.nonceSeen = true // 열기를 기다리는 사이 온 두 번째 난수도 버린다
    const code = mobileCrypto.pairCode(macKey.publicKey, stage.appPublic, data.value, stage.macNonce)
    try {
      await call('pair.data', { requestId, data: mobileCrypto.encodePairData({ pc: 'reveal', v: 1, n: mobileCrypto.toBase64(stage.macNonce) }) })
    } catch (error) {
      log(`[mobile-relay] 열기 실패 requestId=${requestId} code=${(error as RelayCallError).code}`)
      return cancelPair(requestId, 'reveal_failed')
    }
    if (pendingPairs.get(requestId) !== stage) return // 그사이 취소됨
    stage.code = code
    log(`[mobile-relay] 연결 요청 번호 준비 requestId=${requestId} from=${stage.from}`)
    changed()
    const view = pendingView().find((each) => each.requestId === requestId)
    if (view && deps.onPairRequest) deps.onPairRequest(view)
  }

  // 토큰 · 짝 열쇠를 버리고 로그아웃 상태로(맥 고정 열쇠는 둔다 — 새 기기로 다시 허용받으면 된다)
  function forget() {
    state = EMPTY_STATE()
    saveState()
    if (deps.onPeersChanged) deps.onPeersChanged()
  }

  // relay 에 먼저(붙어 있고 remoteLogout 이 있을 때만 · logoutWaitMs 까지) → 그 답과 상관없이 로컬을 지운다
  async function signOutNow() {
    if (deps.remoteLogout && socket && authed) {
      loggedOutByRelay = false
      let waitTimer: NodeJS.Timeout | null = null
      const waited = new Promise<'timeout'>((resolve) => {
        waitTimer = setTimeout(() => resolve('timeout'), logoutWaitMs)
      })
      try {
        const outcome = await Promise.race([deps.remoteLogout(call).then(() => 'ok' as const), waited])
        log(`[mobile-relay] relay 로그아웃 ${outcome}`)
      } catch (error) {
        if (loggedOutByRelay) log('[mobile-relay] relay 로그아웃 ok(4004)')
        else log(`[mobile-relay] relay 로그아웃 실패 code=${(error as RelayCallError | null)?.code || 'error'} — 로컬만 지운다`)
      } finally {
        if (waitTimer) clearTimeout(waitTimer)
      }
    }
    const own = socket
    socket = null
    clearConnection()
    if (own) own.close()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    forget()
    log('[mobile-relay] 로그아웃')
    changed()
  }

  function signedOutByRelay(why: 'expired' | 'account_deleted') {
    forget()
    const own = socket
    socket = null
    clearConnection()
    if (own) own.close()
    log(`[mobile-relay] relay 가 세션을 끝냈어요 — 로그아웃(${why})`)
    changed()
    if (deps.onSignedOut) deps.onSignedOut(why)
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
          if (deps.onPeersChanged) deps.onPeersChanged()
        }
        log(`[mobile-relay] 기기 해제 peer=${peer}`)
        return changed()
      case 'pair.request':
        return void onPairRequest(event)
      case 'pair.data':
        return void onPairData(event)
      case 'pair.cancelled': {
        // 5분 지남 · 상대 끊김 · 상대가 거둠 — 허용 창을 닫는다(모르는 reason 도 취소로)
        const requestId = String(event.requestId || '')
        if (!pendingPairs.delete(requestId)) return
        log(`[mobile-relay] 연결 요청 취소됨 requestId=${requestId} reason=${String(event.reason || 'cancelled').slice(0, 20)}`)
        return changed()
      }
      case 'account.deleted':
        return signedOutByRelay('account_deleted')
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

  // 저장한 토큰으로만 붙는다(로그인은 웹 — signIn). 끝난 토큰이면 relay 가 그 기기와 쌍을 지웠다 → 로그아웃
  async function authenticate(): Promise<boolean> {
    if (!state.token) return false
    try {
      const result = (await call('auth.resume', { token: state.token })) as { deviceId?: unknown; account?: unknown }
      state.deviceId = String(result.deviceId || state.deviceId || '')
      state.account = textOrNull(result.account) || state.account
      return true
    } catch (error) {
      if ((error as RelayCallError).code !== 'invalid_token') throw error
      signedOutByRelay('expired')
      return false
    }
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
    pendingPairs.clear()
    changed()
  }

  function scheduleReconnect() {
    if (stopped || replaced || reconnectTimer || !state.token) return
    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 30000
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect() {
    if (stopped || socket || !state.token) return
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
      if (event && event.code === CLOSE_ACCOUNT_DELETED && state.token) return signedOutByRelay('account_deleted')
      if (event && event.code === CLOSE_LOGGED_OUT) {
        loggedOutByRelay = true
        // 로그아웃 결과 — 다시 붙지 않는다. 맥에서 누른 로그아웃이면 로컬은 signOut 이 지운다.
        // 누르지 않았는데 왔으면 relay 가 이미 이 기기 토큰을 지운 것 — 로컬도 지우고 로그아웃 상태로(오류 알림 없음)
        if (!signingOut && state.token) {
          forget()
          log('[mobile-relay] relay 가 로그아웃시킴(4004) — 로컬 토큰 · 허용 기기 지움')
          changed()
        }
        return
      }
      scheduleReconnect()
    }
    own.onopen = () => {
      if (socket !== own) return
      authenticate()
        .then((ok) => {
          if (socket !== own || !ok) return
          authed = true
          attempt = 0
          log(`[mobile-relay] 붙음 device=${state.deviceId} 허용 기기 ${Object.keys(state.peers).length}개`)
          changed()
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
    // 번호가 뜨기 전(열기 전)에는 허용할 수 없다
    if (!pending || (accept && !pending.code)) throw new RelayCallError('not_found', '기다리는 연결 요청이 아니에요')
    pendingPairs.delete(requestId)
    changed()
    if (!accept) {
      await call('pair.reject', { requestId })
      return log(`[mobile-relay] 연결 거절 requestId=${requestId}`)
    }
    const result = (await call('pair.accept', { requestId })) as { peer?: unknown }
    const peer = String(result.peer || pending.from)
    state.peers[peer] = { publicKey: pending.publicKey, addedAt: new Date().toISOString(), label: pending.label, lastSeen: null }
    saveState()
    log(`[mobile-relay] 연결 허용 requestId=${requestId} peer=${peer}`)
    changed()
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
    // 웹 로그인으로 받은 토큰 — 저장하고 붙는다(로그인할 때마다 새 기기라 앞 짝은 버린다)
    signIn(result: SignInResult) {
      const own = socket
      socket = null
      clearConnection()
      if (own) own.close()
      state = { token: result.token, deviceId: result.deviceId, account: result.account, name: cleanLabel(result.name), peers: {} }
      saveState()
      if (deps.onPeersChanged) deps.onPeersChanged()
      replaced = false
      attempt = 0
      changed()
      connect()
    },
    // 맥에서 로그아웃 — 붙어 있으면 relay 에 먼저 이 세션을 지워 달라고 하고(remoteLogout · 실패해도 계속) 끊고 토큰 · 짝 열쇠를 버린다
    signOut(): Promise<void> {
      if (!signingOut) signingOut = signOutNow().finally(() => (signingOut = null))
      return signingOut
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
      changed()
      if (deps.onPeersChanged) deps.onPeersChanged()
      await call('pair.remove', { peer }).catch((error) => {
        if ((error as RelayCallError).code !== 'not_found') throw error
      })
    },
    pending: pendingView,
    peers: () => Object.keys(state.peers),
    devices: (): PeerView[] => Object.entries(state.peers).map(([peer, record]) => ({ peer, label: record.label, online: sessions.has(peer), lastSeen: record.lastSeen })),
    // 직접 길 — hello 의 고정 공개 열쇠가 허용한 기기 것인지(그 기기 id · 없으면 null)
    peerOfKey(publicKey: Uint8Array): string | null {
      for (const [peer, record] of Object.entries(state.peers)) {
        const saved = mobileCrypto.keyFrom(record.publicKey)
        if (saved && Buffer.from(saved).equals(Buffer.from(publicKey))) return peer
      }
      return null
    },
    // 그 기기가 직접 길로 붙었다 — relay 세션은 쉰다(끊기면 앱이 relay 로 다시 hello)
    pauseSession: (peer: string) => stopSession(peer, 'direct'),
    // 열린 relay 세션 모두에 맥 알림 하나(lan.info — 주소가 바뀌었을 때)
    broadcast(message: object) {
      for (const session of sessions.values()) session.channel.send(message)
    },
    status: () => ({ connected: authed, signedIn: Boolean(state.token), deviceId: state.deviceId, account: state.account, name: state.name, sessions: [...sessions.keys()] }),
  }
}
