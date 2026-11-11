// ── 모바일 암호 연결 v1 — 맥 브리지 ↔ 앱이 relay 를 거쳐 주고받는 안쪽 메시지의 열쇠 · 봉인 · 나누기 ──
// 정본은 계획서 plans/feature/20261110-아테나-모바일-앱.md 4-7 "시험 2 공통 스펙 — 암호 연결 v1" · "빈 곳 메움"(Q1~Q7).
// 앱(athena-app `app/src/connection/`)이 똑같이 구현한다 — 확인 숫자 · 세션 열쇠 시험 벡터는 test/mobile-crypto.test.js 에 고정한다.
// libsodium(libsodium-wrappers) — 쓰기 전에 ready() 를 한 번 기다린다. HKDF 는 node:crypto(RFC 5869 표준 — libsodium 과 같은 결과)
import crypto from 'node:crypto'
import sodium from 'libsodium-wrappers'

export const INFO = 'athena-mobile v1' // HKDF info · AEAD 덧붙인 자료(AAD)
export const KEY_BYTES = 32
export const CHUNK_BYTES = 2 * 1024 * 1024 // 조각 메시지 JSON 상한 — 앱도 같다(Q4)
export const ASSEMBLE_MAX_BYTES = 16 * 1024 * 1024 // 모으는 메시지 하나의 합계 상한
export const ASSEMBLE_TIMEOUT_MS = 30_000 // 다 안 오면 버린다
const MAX_CHUNKS = 64 // 16 MiB / 2 MiB 의 넉넉한 위 — 이보다 많다고 하면 모양이 틀린 것
const OPEN_BRACE = 0x7b // 핸드셰이크 JSON 의 첫 바이트("{") — 암호문은 순번 첫 바이트가 0(Q1)

export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array }
export type SessionKeys = { send: Uint8Array; receive: Uint8Array }
export type Role = 'mac' | 'app'

export const ready = () => sodium.ready

export function newKeyPair(): KeyPair {
  const pair = sodium.crypto_box_keypair()
  return { publicKey: pair.publicKey, privateKey: pair.privateKey }
}

// 비밀 열쇠에서 공개 열쇠 — 저장한 열쇠 파일을 읽을 때 맞는지 본다
export const publicKeyOf = (privateKey: Uint8Array): Uint8Array => sodium.crypto_scalarmult_base(privateKey)

// base64 — 보낼 때는 표준(= 채움), 받을 때는 표준 · url 둘 다(Q2). relay publicKey 만 base64url 43자(relay 계약)
export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const BASE64_TEXT = /^[A-Za-z0-9+/_-]+={0,2}$/
export function fromBase64(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || !text || !BASE64_TEXT.test(text)) return null
  return new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}
// 정확히 32바이트인 열쇠만
export function keyFrom(text: unknown): Uint8Array | null {
  const bytes = fromBase64(text)
  return bytes && bytes.length === KEY_BYTES ? bytes : null
}

// 확인 숫자: SHA-256(맥 공개 32B ‖ 앱 공개 32B) 앞 4바이트 big-endian % 1000000 → 6자리
export function confirmCode(macPublic: Uint8Array, appPublic: Uint8Array): string {
  const digest = crypto.createHash('sha256').update(macPublic).update(appPublic).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

// 4DH → HKDF-SHA256. ikm = DH(맥 고정, 앱 고정) ‖ DH(맥 일회, 앱 일회) ‖ DH(맥 고정, 앱 일회) ‖ DH(맥 일회, 앱 고정)
// salt = 맥 일회 공개 ‖ 앱 일회 공개 · 64B 의 앞 32B = 앱→맥 · 뒤 32B = 맥→앱. 낮은 차수 점이면 libsodium 이 던진다(그 hello 는 버린다)
export function deriveSessionKeys({ role, staticKey, ephemeralKey, peerStatic, peerEphemeral }: { role: Role; staticKey: KeyPair; ephemeralKey: KeyPair; peerStatic: Uint8Array; peerEphemeral: Uint8Array }): SessionKeys {
  const dh = (secret: Uint8Array, pub: Uint8Array) => sodium.crypto_scalarmult(secret, pub)
  const mac = role === 'mac'
  const parts = mac
    ? [dh(staticKey.privateKey, peerStatic), dh(ephemeralKey.privateKey, peerEphemeral), dh(staticKey.privateKey, peerEphemeral), dh(ephemeralKey.privateKey, peerStatic)]
    : [dh(staticKey.privateKey, peerStatic), dh(ephemeralKey.privateKey, peerEphemeral), dh(ephemeralKey.privateKey, peerStatic), dh(staticKey.privateKey, peerEphemeral)]
  const macEphemeral = mac ? ephemeralKey.publicKey : peerEphemeral
  const appEphemeral = mac ? peerEphemeral : ephemeralKey.publicKey
  const okm = new Uint8Array(crypto.hkdfSync('sha256', Buffer.concat(parts), Buffer.concat([macEphemeral, appEphemeral]), INFO, 64))
  const appToMac = okm.slice(0, 32)
  const macToApp = okm.slice(32, 64)
  return mac ? { send: macToApp, receive: appToMac } : { send: appToMac, receive: macToApp }
}

// 핸드셰이크(평문) — UTF-8 JSON 을 base64 로 msg.data 에(Q1)
export type Handshake = { hs: 'hello'; v: 1; eph: string } | { hs: 'reset'; v: 1 }
export const helloMessage = (ephemeralPublic: Uint8Array): Handshake => ({ hs: 'hello', v: 1, eph: toBase64(ephemeralPublic) })
export const RESET: Handshake = { hs: 'reset', v: 1 }
export const encodeHandshake = (message: Handshake): string => Buffer.from(JSON.stringify(message), 'utf8').toString('base64')

// msg.data 풀기 — 핸드셰이크 JSON 이거나 암호문(순번 8B ‖ 암호문) 바이트. 모양이 틀리면 null
export type Incoming = { kind: 'handshake'; message: Record<string, unknown> } | { kind: 'cipher'; bytes: Uint8Array }
export function decodeData(data: unknown): Incoming | null {
  const bytes = fromBase64(data)
  if (!bytes || !bytes.length) return null
  if (bytes[0] === OPEN_BRACE) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { kind: 'handshake', message: parsed as Record<string, unknown> } : null
    } catch {
      return null
    }
  }
  return bytes.length > 8 ? { kind: 'cipher', bytes } : null
}

// 핸드셰이크 hello 의 일회 공개 열쇠 — v1 hello 가 아니면 null
export function helloEphemeral(message: Record<string, unknown>): Uint8Array | null {
  if (message.hs !== 'hello' || message.v !== 1) return null
  return keyFrom(message.eph)
}

const nonceOf = (seq: bigint): Uint8Array => {
  const nonce = new Uint8Array(24) // 16B 0 ‖ 순번 8B big-endian
  new DataView(nonce.buffer).setBigUint64(16, seq, false)
  return nonce
}

// 세션 하나 — 방향마다 순번 0부터. open 은 복호화 실패 · 순번 역행이면 null(부르는 쪽이 세션을 버리고 reset)
export function createCipherSession(keys: SessionKeys) {
  let sendSeq = 0n
  let lastReceived = -1n
  return {
    seal(plain: string): string {
      const seq = sendSeq
      sendSeq += 1n
      const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(Buffer.from(plain, 'utf8'), INFO, null, nonceOf(seq), keys.send)
      const out = new Uint8Array(8 + sealed.length)
      new DataView(out.buffer).setBigUint64(0, seq, false)
      out.set(sealed, 8)
      return toBase64(out)
    },
    open(bytes: Uint8Array): string | null {
      if (bytes.length <= 8) return null
      const seq = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, false)
      if (seq <= lastReceived) return null
      try {
        const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.subarray(8), INFO, nonceOf(seq), keys.receive)
        lastReceived = seq
        return Buffer.from(plain).toString('utf8')
      } catch {
        return null
      }
    },
  }
}

// JSON 문자열 안에서 글자 하나(코드 유닛 또는 짝)가 차지하는 바이트 — JSON.stringify 의 escape 와 같게
function escapedBytes(text: string, index: number): { units: number; bytes: number } {
  const code = text.charCodeAt(index)
  if (code === 0x22 || code === 0x5c) return { units: 1, bytes: 2 }
  if (code < 0x20) return { units: 1, bytes: code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6 }
  if (code < 0x80) return { units: 1, bytes: 1 }
  if (code < 0x800) return { units: 1, bytes: 2 }
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return { units: 2, bytes: 4 }
    return { units: 1, bytes: 6 } // 짝 없는 반쪽 — JSON.stringify 는 \udxxx 로 쓴다
  }
  if (code >= 0xdc00 && code <= 0xdfff) return { units: 1, bytes: 6 }
  return { units: 1, bytes: 3 }
}

// 안쪽 메시지 JSON 글 → 보낼 평문 목록. 2 MiB 이하면 그대로 하나, 넘으면 {chunk:{id,seq,total,data}} 조각들(각 조각 JSON 이 limit 이하 · Q4)
export function splitMessage(text: string, id: string, limit = CHUNK_BYTES): string[] {
  if (Buffer.byteLength(text, 'utf8') <= limit) return [text]
  // 감싸는 칸(id · seq · total)이 차지할 자리를 빼 둔다
  const room = limit - Buffer.byteLength(JSON.stringify({ chunk: { id, seq: MAX_CHUNKS, total: MAX_CHUNKS, data: '' } }), 'utf8')
  const pieces: string[] = []
  let start = 0
  let used = 0
  let index = 0
  while (index < text.length) {
    const { units, bytes } = escapedBytes(text, index)
    if (used + bytes > room) {
      pieces.push(text.slice(start, index))
      start = index
      used = 0
    }
    used += bytes
    index += units
  }
  pieces.push(text.slice(start))
  if (pieces.length > MAX_CHUNKS) throw new Error(`메시지가 너무 커요(${pieces.length} 조각)`)
  return pieces.map((data, seq) => JSON.stringify({ chunk: { id, seq, total: pieces.length, data } }))
}

type PartialMessage = { total: number; parts: (string | undefined)[]; count: number; bytes: number; startedAt: number }

// 조각 모으기 — add 에 복호화한 안쪽 메시지(파싱한 것)를 넣으면 완성된 메시지를 돌려준다(조각이 아니면 그대로 · 아직이면 null)
export function createAssembler({ now = Date.now, maxBytes = ASSEMBLE_MAX_BYTES, timeoutMs = ASSEMBLE_TIMEOUT_MS }: { now?: () => number; maxBytes?: number; timeoutMs?: number } = {}) {
  const partials = new Map<string, PartialMessage>()
  const sweep = () => {
    const at = now()
    for (const [id, entry] of partials) if (at - entry.startedAt > timeoutMs) partials.delete(id)
  }
  return {
    add(message: unknown): unknown {
      sweep()
      if (!message || typeof message !== 'object' || !('chunk' in message)) return message
      const chunk = (message as { chunk: unknown }).chunk as Record<string, unknown> | null
      if (!chunk || typeof chunk !== 'object') return null
      const { id, seq, total, data } = chunk
      if (typeof id !== 'string' || !id || id.length > 64 || typeof data !== 'string') return null
      if (!Number.isInteger(total) || (total as number) < 1 || (total as number) > MAX_CHUNKS) return null
      if (!Number.isInteger(seq) || (seq as number) < 0 || (seq as number) >= (total as number)) return null
      let entry = partials.get(id)
      if (!entry) {
        entry = { total: total as number, parts: new Array(total as number), count: 0, bytes: 0, startedAt: now() }
        partials.set(id, entry)
      }
      if (entry.total !== total) {
        partials.delete(id)
        return null
      }
      if (entry.parts[seq as number] !== undefined) return null // 같은 조각을 또 — 무시
      entry.bytes += Buffer.byteLength(data, 'utf8')
      if (entry.bytes > maxBytes) {
        partials.delete(id)
        return null
      }
      entry.parts[seq as number] = data
      entry.count += 1
      if (entry.count < entry.total) return null
      partials.delete(id)
      try {
        return JSON.parse(entry.parts.join(''))
      } catch {
        return null
      }
    },
    pending: () => partials.size,
  }
}
