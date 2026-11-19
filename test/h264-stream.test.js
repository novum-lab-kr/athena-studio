// @ts-check
// Android 화면 영상 나누기(src/lib/h264-stream.mts) — adb 조각이 NAL 중간에서 잘려 와도 프레임을 그대로 맞춘다
const test = require('node:test')
const assert = require('node:assert/strict')
const { codecFromSps, createH264Splitter, sameBytes } = require('../src/lib/h264-stream.mts')

const start4 = [0, 0, 0, 1]
const start3 = [0, 0, 1]
// screenrecord 첫 조각 모양 — SPS(6742c032…) · PPS · IDR, 그다음 P 슬라이스들
const sps = [...start4, 0x67, 0x42, 0xc0, 0x32, 0x8d, 0x68]
const pps = [...start4, 0x68, 0xce, 0x01]
const idr = [...start4, 0x65, 0x88, 0x84, 0x10, 0x20, 0x30, 0x40]
const slice1 = [...start4, 0x41, 0x9a, 0x11, 0x22]
const slice2 = [...start3, 0x41, 0x9a, 0x33, 0x44, 0x55]
const stream = Uint8Array.from([...sps, ...pps, ...idr, ...slice1, ...slice2])

/** @param {import('../src/lib/h264-stream.mts').AccessUnit[]} units */
const summary = (units) => units.map((unit) => ({ key: unit.key, length: unit.data.length, sps: unit.sps ? Array.from(unit.sps.slice(0, 4)) : null }))

test('한 번에 받으면 마지막 프레임은 다음 시작 코드나 flush 를 기다린다', () => {
  const splitter = createH264Splitter()
  const units = splitter.push(stream)
  assert.deepEqual(summary(units), [
    { key: true, length: sps.length + pps.length + idr.length, sps: [0x67, 0x42, 0xc0, 0x32] },
    { key: false, length: slice1.length, sps: null },
  ])
  assert.equal(splitter.pending(), true)
  assert.deepEqual(summary(splitter.flush()), [{ key: false, length: slice2.length, sps: null }])
  assert.equal(splitter.pending(), false)
})

test('어느 자리에서 잘려 와도(NAL 중간 · 시작 코드 중간) 같은 프레임이 나온다', () => {
  const whole = createH264Splitter()
  const expected = summary([...whole.push(stream), ...whole.flush()])
  for (let cut = 1; cut < stream.length; cut++) {
    const splitter = createH264Splitter()
    const units = [...splitter.push(stream.slice(0, cut)), ...splitter.push(stream.slice(cut)), ...splitter.flush()]
    assert.deepEqual(summary(units), expected, `자른 자리 ${cut}`)
    assert.deepEqual(Array.from(units[0]?.data || []), [...sps, ...pps, ...idr])
  }
})

test('앞이 잘린 조각(시작 코드 전)은 버리고 다음 시작 코드부터', () => {
  const splitter = createH264Splitter()
  const units = [...splitter.push(Uint8Array.from([0x12, 0x34, 0x56, ...slice1, ...slice2])), ...splitter.flush()]
  assert.deepEqual(summary(units), [
    { key: false, length: slice1.length, sps: null },
    { key: false, length: slice2.length, sps: null },
  ])
  // 시작 코드가 하나도 없이 쌓이기만 해도 버퍼가 커지지 않는다
  const empty = createH264Splitter()
  assert.deepEqual(empty.push(new Uint8Array(1000).fill(7)), [])
  assert.deepEqual(empty.flush(), [])
})

test('SPS → codec 문자열 · 같은 SPS 판정', () => {
  assert.equal(codecFromSps(Uint8Array.from([0x67, 0x42, 0xc0, 0x32, 0x8d])), 'avc1.42c032')
  assert.equal(codecFromSps(Uint8Array.from([0x67, 0x64, 0x00, 0x28])), 'avc1.640028')
  assert.equal(sameBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2])), true)
  assert.equal(sameBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3])), false)
  assert.equal(sameBytes(null, Uint8Array.from([1])), false)
})
