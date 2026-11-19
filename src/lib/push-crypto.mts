// 폰 알림 내용 암호화 — athena-push v1(계획서 plans/feature/20261119-폰-알림-내용-암호화-A3.md 5절).
// 맥이 알림 글을 폰 푸시 공개 열쇠로 봉인하고 relay 는 풀지 못한 채 넘긴다. iPhone 알림 확장(CryptoKit)이 푼다 — 그래서 libsodium 없이 node:crypto 만 쓴다.
//   일회 X25519 열쇠 e → shared = X25519(e, pushPub) → key = HKDF-SHA256(shared, salt = ePub ‖ pushPub, info = 'athena-push v1', 32B)
//   → ChaCha20-Poly1305(평문, nonce 12B 난수, AAD = 'athena-push v1')
//   enc = base64url( 0x01 ‖ ePub 32B ‖ nonce 12B ‖ 암호문 ‖ tag 16B )
// 평문 = JSON {"t":"<제목>","b":"<본문>","k":"request|done"} — 글 자르기는 만드는 쪽(push-model.mts)
// Electron 없이 돌아 `npm test` 로 검사한다(test/push-crypto.test.js — 앱 쪽과 같은 교차 시험 벡터)
import crypto from 'node:crypto'

export const PUSH_INFO = 'athena-push v1' // HKDF info · AEAD 덧붙인 자료(AAD)
export const PUSH_VERSION = 0x01
export const PUSH_ENC_MAX = 2048 // relay push.send enc 글자 상한
const KEY_BYTES = 32
const NONCE_BYTES = 12
// X25519 비밀 열쇠 raw 32B 앞에 붙는 PKCS#8 머리(RFC 8410)
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')

export type PushText = { t: string; b: string; k: 'request' | 'done' }
// 시험용 — 고정 일회 비밀 열쇠 · nonce(교차 시험 벡터). 실제로는 넘기지 않는다(매번 새로 뽑는다)
export type SealFixed = { ephemeralPrivate?: Uint8Array; nonce?: Uint8Array }

const publicFromRaw = (raw: Uint8Array) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' })
const privateFromRaw = (raw: Uint8Array) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(raw)]), format: 'der', type: 'pkcs8' })
const rawPublicOf = (key: crypto.KeyObject): Buffer => Buffer.from(String(crypto.createPublicKey(key).export({ format: 'jwk' }).x), 'base64url')

// 알림 글 하나를 그 기기의 푸시 공개 열쇠(raw 32B)로 봉인 → enc 글. 못 만들면 null(열쇠 모양 · 낮은 차수 점 · 상한 넘음) — 부르는 쪽은 enc 없이 보낸다
export function sealPush(pushPublic: Uint8Array, text: PushText, fixed: SealFixed = {}): string | null {
  if (pushPublic.length !== KEY_BYTES) return null
  if (fixed.ephemeralPrivate && fixed.ephemeralPrivate.length !== KEY_BYTES) return null
  if (fixed.nonce && fixed.nonce.length !== NONCE_BYTES) return null
  try {
    const ephemeral = fixed.ephemeralPrivate ? privateFromRaw(fixed.ephemeralPrivate) : crypto.generateKeyPairSync('x25519').privateKey
    const ephemeralPublic = rawPublicOf(ephemeral)
    const shared = crypto.diffieHellman({ privateKey: ephemeral, publicKey: publicFromRaw(pushPublic) })
    // 낮은 차수 점이면 shared 가 모두 0 — 열쇠가 아니다
    if (shared.every((byte) => byte === 0)) return null
    const salt = Buffer.concat([ephemeralPublic, Buffer.from(pushPublic)])
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, PUSH_INFO, KEY_BYTES))
    const nonce = fixed.nonce ? Buffer.from(fixed.nonce) : crypto.randomBytes(NONCE_BYTES)
    const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
    const plain = Buffer.from(JSON.stringify({ t: text.t, b: text.b, k: text.k }), 'utf8')
    cipher.setAAD(Buffer.from(PUSH_INFO, 'utf8'), { plaintextLength: plain.length })
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    const enc = Buffer.concat([Buffer.from([PUSH_VERSION]), ephemeralPublic, nonce, sealed]).toString('base64url')
    return enc.length <= PUSH_ENC_MAX ? enc : null
  } catch {
    return null
  }
}
