// 폰 알림 내용 암호화(src/lib/push-crypto.mts) — athena-push v1(계획서 plans/feature/20261119-폰-알림-내용-암호화-A3.md 5절)
// 교차 시험 벡터: 아래 고정 값(VECTOR)은 앱(athena-app · 알림 확장) 쪽 시험과 같은 값이다 — 한쪽만 바꾸지 않는다
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { sealPush, PUSH_INFO, PUSH_ENC_MAX } = require('../src/lib/push-crypto.mts')

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const privateKeyOf = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(raw)]), format: 'der', type: 'pkcs8' })
const publicRawOf = (privateKey) => Buffer.from(crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x, 'base64url')
const publicKeyOf = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' })

// 폰 쪽 풀기를 여기서 따로 쓴다(봉인 코드를 거치지 않는다) — 알림 확장이 하는 것과 같은 순서
function openPush(enc, phonePrivateRaw) {
  const bytes = Buffer.from(enc, 'base64url')
  assert.equal(bytes[0], 0x01, '버전 1B')
  const ephemeralPublic = bytes.subarray(1, 33)
  const nonce = bytes.subarray(33, 45)
  const sealed = bytes.subarray(45, bytes.length - 16)
  const tag = bytes.subarray(bytes.length - 16)
  const phonePrivate = privateKeyOf(phonePrivateRaw)
  const shared = crypto.diffieHellman({ privateKey: phonePrivate, publicKey: publicKeyOf(ephemeralPublic) })
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, publicRawOf(phonePrivate)]), PUSH_INFO, 32))
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  decipher.setAAD(Buffer.from(PUSH_INFO, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8')
}

// 고정 열쇠 · 고정 nonce — 폰 푸시 비밀 열쇠 0x40…0x5f · 맥 일회 비밀 열쇠 0x80…0x9f · nonce 0xa0…0xab
const VECTOR = {
  phonePrivate: '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
  phonePublic: '79a631eede1bf9c98f12032cdeadd0e7a079398fc786b88cc846ec89af85a51a',
  ephemeralPrivate: '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
  nonce: 'a0a1a2a3a4a5a6a7a8a9aaab',
  plain: '{"t":"athena-studio-fe · 확인 요청","b":"배포 전에 relay 주소를 확인해 주세요 🚀","k":"request"}',
  enc: 'AUk-gvx0RkpZJogXYj0gU8XrjizEqYi0_uF57GsBDVMdoKGio6SlpqeoqaqrqTHf_BiTTbi7I4TGwPg6QFiUSMIqaUKrnHNo04GN1Es2aG5e3vb0TgDLE4030KXkXGBjWkJxmaXduj0ifIcUZymzG7RBGKydt4di9mkIOQDc3gT7NyLwb3JC-hOqAdR34TPRJCVsVg8ROIksc8cKpD0__FB2HjiO9a4f70A4W8Hn4zPV',
}
// pane 칸(p)이 든 벡터 — 열쇠 · nonce 는 위와 같고 평문만 다르다(시험용 고정 값이라 같은 nonce 를 또 쓴다 — 실제로는 매번 새로 뽑는다)
const VECTOR_PANE = {
  plain: '{"t":"athena-studio-fe · 일 끝남","b":"athena-studio-fe · feat/studio-push-pane","k":"done","p":"p1fl"}',
  enc: 'AUk-gvx0RkpZJogXYj0gU8XrjizEqYi0_uF57GsBDVMdoKGio6SlpqeoqaqrqTHf_BiTTbi7I4TGwPg6QFiUSMIqaUKrnHNp16hBonKLb3ZiEGh7Dg7TU855mis6jaCfghf5UE4cS8gizFVYYDXygziOgF91NU3zpvHixMExB4cLoS4-p-yUXM8p9SV1PY47hj1iBFVVbokjZhUNiBF5Fyts_nrX981m4Q',
}
const hex = (text) => new Uint8Array(Buffer.from(text, 'hex'))

test('교차 시험 벡터: 고정 열쇠 · 고정 nonce 로 봉인한 enc 가 정해 둔 값과 같고 폰 열쇠로 풀면 기대 평문', () => {
  assert.equal(publicRawOf(privateKeyOf(hex(VECTOR.phonePrivate))).toString('hex'), VECTOR.phonePublic)
  const enc = sealPush(hex(VECTOR.phonePublic), JSON.parse(VECTOR.plain), { ephemeralPrivate: hex(VECTOR.ephemeralPrivate), nonce: hex(VECTOR.nonce) })
  assert.equal(enc, VECTOR.enc)
  assert.equal(openPush(VECTOR.enc, hex(VECTOR.phonePrivate)), VECTOR.plain)
})

test('교차 시험 벡터(pane): p 가 있으면 평문 끝에 "p" 한 칸 · 없거나 비면 칸이 없다(앞 벡터와 같은 모양)', () => {
  const fixed = { ephemeralPrivate: hex(VECTOR.ephemeralPrivate), nonce: hex(VECTOR.nonce) }
  const enc = sealPush(hex(VECTOR.phonePublic), JSON.parse(VECTOR_PANE.plain), fixed)
  assert.equal(enc, VECTOR_PANE.enc)
  assert.equal(openPush(VECTOR_PANE.enc, hex(VECTOR.phonePrivate)), VECTOR_PANE.plain)
  assert.equal(sealPush(hex(VECTOR.phonePublic), { ...JSON.parse(VECTOR.plain), p: '' }, fixed), VECTOR.enc)
  assert.equal(sealPush(hex(VECTOR.phonePublic), { ...JSON.parse(VECTOR.plain), p: undefined }, fixed), VECTOR.enc)
})

test('봉인: 매번 새 일회 열쇠 · nonce — 같은 글도 enc 가 다르고 둘 다 풀린다 · base64url 글자만 · 상한 안', () => {
  const text = { t: '제목', b: '본문', k: 'done' }
  const first = sealPush(hex(VECTOR.phonePublic), text)
  const second = sealPush(hex(VECTOR.phonePublic), text)
  assert.notEqual(first, second)
  for (const enc of [first, second]) {
    assert.match(enc, /^[A-Za-z0-9_-]+$/)
    assert.deepEqual(JSON.parse(openPush(enc, hex(VECTOR.phonePrivate))), text)
  }
  // 가장 긴 글(제목 60 · 본문 160 · pane 64 글자가 모두 4바이트 글자)도 relay 상한 안
  const longest = sealPush(hex(VECTOR.phonePublic), { t: '🚀'.repeat(60), b: '🚀'.repeat(160), k: 'request', p: '🚀'.repeat(64) })
  assert.ok(longest && longest.length <= PUSH_ENC_MAX, `enc ${longest && longest.length}자`)
})

test('봉인: 글 · AAD · 열쇠가 다르면 풀리지 않는다 · 열쇠 모양이 틀리거나 상한을 넘으면 null', () => {
  const enc = sealPush(hex(VECTOR.phonePublic), { t: 'a', b: 'b', k: 'done' })
  const bytes = Buffer.from(enc, 'base64url')
  bytes[bytes.length - 1] ^= 1
  assert.throws(() => openPush(bytes.toString('base64url'), hex(VECTOR.phonePrivate)))
  assert.throws(() => openPush(enc, hex(VECTOR.ephemeralPrivate)), '다른 비밀 열쇠')
  assert.equal(sealPush(new Uint8Array(31), { t: 'a', b: 'b', k: 'done' }), null)
  assert.equal(sealPush(new Uint8Array(32), { t: 'a', b: 'b', k: 'done' }), null, '낮은 차수 점(모두 0)')
  assert.equal(sealPush(hex(VECTOR.phonePublic), { t: 'a', b: '가'.repeat(2000), k: 'done' }), null, 'enc 2048자 넘음')
})
