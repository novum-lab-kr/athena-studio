// 폰 알림 내용 암호화 — athena-push v1(계획서 plans/feature/20261119-폰-알림-내용-암호화-A3.md 5절).
// 맥이 알림 글을 폰 푸시 공개 열쇠로 봉인하고 relay 는 풀지 못한 채 넘긴다. iPhone 알림 확장(CryptoKit)이 푼다 — 표준 조합만 쓴다.
//   일회 X25519 열쇠 e → shared = X25519(e, pushPub) → key = HKDF-SHA256(shared, salt = ePub ‖ pushPub, info = 'athena-push v1', 32B)
//   → ChaCha20-Poly1305(평문, nonce 12B 난수, AAD = 'athena-push v1')
//   enc = base64url( 0x01 ‖ ePub 32B ‖ nonce 12B ‖ 암호문 ‖ tag 16B )
// 평문 = JSON {"t":"<제목>","b":"<본문>","k":"request|done"} — 글 자르기는 만드는 쪽(push-model.mts).
//   그 푸시를 낸 pane 을 알면 끝에 "p":"<pane id>" 한 칸(폰이 알림을 누르면 그 pane 으로 간다 — relay 는 모른다) · 모르면 칸이 없다
// X25519 · HKDF 는 node:crypto, AEAD 만 libsodium(IETF ChaCha20-Poly1305 — 결과 바이트는 node:crypto 와 같다):
//   Electron(BoringSSL)의 node:crypto 에는 chacha20-poly1305 가 없어 createCipheriv 가 던진다(시스템 node 에서는 된다 — 2026-11-20 실측 · Electron 44).
//   그래서 쓰기 전에 pushCryptoReady() 를 한 번 기다린다(mobile-crypto.mts 의 ready 와 같은 것)
// Electron 없이 돌아 `npm test` 로 검사한다(test/push-crypto.test.js — 앱 쪽과 같은 교차 시험 벡터 · Electron 실행기로도 한 번 봉인해 본다)
import crypto from 'node:crypto'
import sodium from 'libsodium-wrappers'

export const PUSH_INFO = 'athena-push v1' // HKDF info · AEAD 덧붙인 자료(AAD)
export const PUSH_VERSION = 0x01
export const PUSH_ENC_MAX = 2048 // relay push.send enc 글자 상한
const KEY_BYTES = 32
const NONCE_BYTES = 12
// X25519 비밀 열쇠 raw 32B 앞에 붙는 PKCS#8 머리(RFC 8410)
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')

export type PushText = { t: string; b: string; k: 'request' | 'done'; p?: string }
// 시험용 — 고정 일회 비밀 열쇠 · nonce(교차 시험 벡터). 실제로는 넘기지 않는다(매번 새로 뽑는다)
export type SealFixed = { ephemeralPrivate?: Uint8Array; nonce?: Uint8Array }

export const pushCryptoReady = () => sodium.ready

const publicFromRaw = (raw: Uint8Array) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' })
const privateFromRaw = (raw: Uint8Array) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(raw)]), format: 'der', type: 'pkcs8' })
const rawPublicOf = (key: crypto.KeyObject): Buffer => Buffer.from(String(crypto.createPublicKey(key).export({ format: 'jwk' }).x), 'base64url')

// 알림 글 하나를 그 기기의 푸시 공개 열쇠(raw 32B)로 봉인 → enc 글. 못 만들면 null(열쇠 모양 · 낮은 차수 점 · 상한 넘음 · 암호 단계 실패) — 부르는 쪽은 enc 없이 보내고 까닭을 로그에 남긴다
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
    const plain = Buffer.from(JSON.stringify({ t: text.t, b: text.b, k: text.k, ...(text.p ? { p: text.p } : {}) }), 'utf8')
    // 암호문 ‖ tag 16B
    const sealed = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(plain, PUSH_INFO, null, nonce, key)
    const enc = Buffer.concat([Buffer.from([PUSH_VERSION]), ephemeralPublic, nonce, sealed]).toString('base64url')
    return enc.length <= PUSH_ENC_MAX ? enc : null
  } catch {
    return null
  }
}
