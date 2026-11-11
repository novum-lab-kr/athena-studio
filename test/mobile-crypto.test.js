// 모바일 암호 연결 v1(src/lib/mobile-crypto.mts) — 앱(athena-app)과 맞출 고정 시험 벡터 · 봉인/열기 · 조각 나누기/모으기
// 벡터는 고정 비밀 열쇠(아래 fill)로 만든다 — 앱 쪽 시험이 같은 입력으로 같은 값을 내야 한다(계획서 4-7 "암호 연결 v1")
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const mobileCrypto = require('../src/lib/mobile-crypto.mts')

// 32바이트 [start, start+1, …] — 맥 고정 0x01.. · 맥 일회 0x21.. · 앱 고정 0x41.. · 앱 일회 0x61..
const fill = (start) => new Uint8Array(32).map((_, index) => (start + index) & 0xff)
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const pairOf = (start) => {
  const privateKey = fill(start)
  return { privateKey, publicKey: mobileCrypto.publicKeyOf(privateKey) }
}

const VECTOR = {
  macStatic: '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c',
  macEphemeral: '5869aff450549732cbaaed5e5df9b30a6da31cb0e5742bad5ad4a1a768f1a67b',
  appStatic: '64b101b1d0be5a8704bd078f9895001fc03e8e9f9522f188dd128d9846d48466',
  appEphemeral: '244fe3b963e899dd295baffce248d3530f3a9a7479ba063002680ebfe7adad49',
  confirmCode: '056221',
  appToMac: '7c3f64b85a5819d8239cf97b4a9452b7e567e328f5781e6a8dad50433f81f6d7',
  macToApp: 'c22b64ba7c2040121569c5522132ca9a4b909c4d6237a6a8c5d4f25534797069',
  // 맥 → 앱 봉인(seq 0 · 1) — 평문 PLAIN · base64(seq 8B ‖ XChaCha20-Poly1305(평문, AAD INFO, nonce 16B 0 ‖ seq))
  plain: '{"event":"changed","parts":["panes"]}',
  sealed0: 'AAAAAAAAAAC/Z/MIAtbzSfK4JCItj6pQgIc/NUt4XsA55K1zQuP28QVXcPtNH07kq1bFiVx2vZ3CeQsQDw==',
  sealed1: 'AAAAAAAAAAEMYewj/oxo8kPT0h6p2NHF/cvEDp4keM5YFX3Lh7+ozA0MfFa2NPJVnTMu7zy7Sm+5h2eY4A==',
}

test.before(() => mobileCrypto.ready())

function sessionPair() {
  const macStatic = pairOf(0x01)
  const macEphemeral = pairOf(0x21)
  const appStatic = pairOf(0x41)
  const appEphemeral = pairOf(0x61)
  const mac = mobileCrypto.deriveSessionKeys({ role: 'mac', staticKey: macStatic, ephemeralKey: macEphemeral, peerStatic: appStatic.publicKey, peerEphemeral: appEphemeral.publicKey })
  const app = mobileCrypto.deriveSessionKeys({ role: 'app', staticKey: appStatic, ephemeralKey: appEphemeral, peerStatic: macStatic.publicKey, peerEphemeral: macEphemeral.publicKey })
  return { macStatic, macEphemeral, appStatic, appEphemeral, mac, app }
}

test('고정 벡터 — 공개 열쇠 · 확인 숫자 · 세션 열쇠(양쪽이 같은 값) · 봉인', () => {
  const keys = sessionPair()
  assert.equal(hex(keys.macStatic.publicKey), VECTOR.macStatic)
  assert.equal(hex(keys.macEphemeral.publicKey), VECTOR.macEphemeral)
  assert.equal(hex(keys.appStatic.publicKey), VECTOR.appStatic)
  assert.equal(hex(keys.appEphemeral.publicKey), VECTOR.appEphemeral)
  assert.equal(mobileCrypto.confirmCode(keys.macStatic.publicKey, keys.appStatic.publicKey), VECTOR.confirmCode)
  assert.equal(hex(keys.mac.receive), VECTOR.appToMac)
  assert.equal(hex(keys.app.send), VECTOR.appToMac)
  assert.equal(hex(keys.mac.send), VECTOR.macToApp)
  assert.equal(hex(keys.app.receive), VECTOR.macToApp)
  const sealer = mobileCrypto.createCipherSession(keys.mac)
  assert.equal(sealer.seal(VECTOR.plain), VECTOR.sealed0)
  assert.equal(sealer.seal(VECTOR.plain), VECTOR.sealed1)
})

test('확인 숫자 · 세션 열쇠를 node:crypto 로 따로 계산해도 같다(libsodium 과 표준 X25519 · HKDF 가 맞물리는지)', () => {
  // 원시 X25519 비밀 열쇠 → PKCS#8 DER(고정 머리 16B)
  const nodeKey = (raw) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(raw)]), format: 'der', type: 'pkcs8' })
  const nodePublic = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(raw)]), format: 'der', type: 'spki' })
  const dh = (secret, pub) => crypto.diffieHellman({ privateKey: nodeKey(secret), publicKey: nodePublic(pub) })
  const macStatic = fill(0x01)
  const macEphemeral = fill(0x21)
  const appStatic = Buffer.from(VECTOR.appStatic, 'hex')
  const appEphemeral = Buffer.from(VECTOR.appEphemeral, 'hex')
  const ikm = Buffer.concat([dh(macStatic, appStatic), dh(macEphemeral, appEphemeral), dh(macStatic, appEphemeral), dh(macEphemeral, appStatic)])
  const okm = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.concat([Buffer.from(VECTOR.macEphemeral, 'hex'), appEphemeral]), 'athena-mobile v1', 64))
  assert.equal(okm.subarray(0, 32).toString('hex'), VECTOR.appToMac)
  assert.equal(okm.subarray(32).toString('hex'), VECTOR.macToApp)
  const digest = crypto.createHash('sha256').update(Buffer.from(VECTOR.macStatic, 'hex')).update(appStatic).digest()
  assert.equal(String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0'), VECTOR.confirmCode)
})

test('봉인/열기 — 순서대로 열리고, 같은 것 다시 · 순번 역행 · 바꾼 암호문 · 다른 방향 열쇠는 null', () => {
  const keys = sessionPair()
  const mac = mobileCrypto.createCipherSession(keys.mac)
  const app = mobileCrypto.createCipherSession(keys.app)
  const first = mobileCrypto.decodeData(app.seal('{"id":1,"op":"snapshot"}'))
  const second = mobileCrypto.decodeData(app.seal('{"id":2,"op":"snapshot"}'))
  assert.equal(first.kind, 'cipher')
  assert.equal(mac.open(first.bytes), '{"id":1,"op":"snapshot"}')
  assert.equal(mac.open(first.bytes), null, '다시 보낸 같은 암호문')
  assert.equal(mac.open(second.bytes), '{"id":2,"op":"snapshot"}')
  assert.equal(mac.open(first.bytes), null, '순번 역행')
  const tampered = mobileCrypto.decodeData(app.seal('{"id":3}')).bytes
  tampered[tampered.length - 1] ^= 1
  assert.equal(mac.open(tampered), null)
  const own = mobileCrypto.decodeData(mobileCrypto.createCipherSession(keys.mac).seal('{"x":1}')).bytes
  assert.equal(mobileCrypto.createCipherSession(keys.mac).open(own), null, '맥이 보낸 것을 맥 열쇠로 못 연다')
})

test('decodeData · helloEphemeral — 첫 바이트 { 면 핸드셰이크, 표준 · url base64 둘 다 받는다', () => {
  const ephemeral = fill(0x61)
  const hello = mobileCrypto.encodeHandshake(mobileCrypto.helloMessage(ephemeral))
  const decoded = mobileCrypto.decodeData(hello)
  assert.equal(decoded.kind, 'handshake')
  assert.deepEqual(mobileCrypto.helloEphemeral(decoded.message), ephemeral)
  const urlSafe = Buffer.from(JSON.stringify({ hs: 'hello', v: 1, eph: Buffer.from(ephemeral).toString('base64url') })).toString('base64url')
  assert.deepEqual(mobileCrypto.helloEphemeral(mobileCrypto.decodeData(urlSafe).message), ephemeral)
  assert.equal(mobileCrypto.helloEphemeral({ hs: 'hello', v: 2, eph: Buffer.from(ephemeral).toString('base64') }), null)
  assert.deepEqual(mobileCrypto.decodeData(mobileCrypto.encodeHandshake(mobileCrypto.RESET)).message, { hs: 'reset', v: 1 })
  assert.equal(mobileCrypto.decodeData('***'), null)
  assert.equal(mobileCrypto.decodeData(Buffer.from('{깨진').toString('base64')), null)
  assert.equal(mobileCrypto.keyFrom(Buffer.alloc(31).toString('base64')), null)
})

test('splitMessage · createAssembler — 조각마다 한도 이하 · 순서가 바뀌어도 모은다 · 한글 · 이스케이프 · 서로게이트를 자르지 않는다', () => {
  const limit = 300
  const text = JSON.stringify({ event: 'pane.resync', pane: 'p1', snapshot: `한글\u001b[31m"따옴표"\\😀`.repeat(40) })
  const pieces = mobileCrypto.splitMessage(text, 'm1', limit)
  assert.ok(pieces.length > 3)
  for (const piece of pieces) assert.ok(Buffer.byteLength(piece, 'utf8') <= limit, `${Buffer.byteLength(piece)} > ${limit}`)
  for (const piece of pieces) assert.ok(!/[\ud800-\udbff]$/.test(JSON.parse(piece).chunk.data), '서로게이트 반쪽으로 끝나지 않는다')
  const assembler = mobileCrypto.createAssembler()
  const shuffled = [...pieces].reverse()
  for (const piece of shuffled.slice(0, -1)) assert.equal(assembler.add(JSON.parse(piece)), null)
  assert.deepEqual(assembler.add(JSON.parse(shuffled.at(-1))), JSON.parse(text))
  assert.equal(assembler.pending(), 0)
  assert.deepEqual(mobileCrypto.splitMessage('{"a":1}', 'm2', limit), ['{"a":1}'])
  assert.deepEqual(assembler.add({ a: 1 }), { a: 1 }, '조각이 아니면 그대로')
})

test('splitMessage — 최악의 이스케이프(제어 문자 6바이트)에서도 조각 JSON 이 한도 이하', () => {
  const text = JSON.stringify({ data: '\u0001'.repeat(2000) })
  for (const piece of mobileCrypto.splitMessage(text, 'm9', 500)) assert.ok(Buffer.byteLength(piece, 'utf8') <= 500)
})

test('createAssembler — 30초 넘게 안 끝난 메시지 · 16 MiB 넘는 합계 · 모양 틀린 조각은 버린다', () => {
  let clock = 0
  const assembler = mobileCrypto.createAssembler({ now: () => clock, maxBytes: 10, timeoutMs: 1000 })
  assert.equal(assembler.add({ chunk: { id: 'a', seq: 0, total: 2, data: '{"' } }), null)
  assert.equal(assembler.pending(), 1)
  clock = 1001
  assert.equal(assembler.add({ chunk: { id: 'b', seq: 0, total: 2, data: '0123456789AB' } }), null)
  assert.equal(assembler.pending(), 0, '시간 지난 a 는 버리고 · 한도 넘은 b 도 버린다')
  assert.equal(assembler.add({ chunk: { id: 'c', seq: 2, total: 2, data: '' } }), null)
  assert.equal(assembler.add({ chunk: { id: 'c', seq: 0, total: 65, data: '' } }), null)
  assert.equal(assembler.pending(), 0)
})
