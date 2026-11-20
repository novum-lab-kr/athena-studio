// 폰 휠 묶음 나눠 넣기 판정 · 일정(src/lib/wheel-spread.mts) — 폰 앱 wheel.ts wheelInput 이 만드는 모양
const test = require('node:test')
const assert = require('node:assert/strict')
const { isWheelInput, splitWheel, spreadOffsets } = require('../src/lib/wheel-spread.mts')

test('splitWheel — 같은 휠 보고 · 화살표 반복이면 한 번씩 나눈다(SGR · 픽셀 · 옛 모양 · 일반 · 응용 커서)', () => {
  const up = '\x1b[<64;40;15M'
  assert.deepEqual(splitWheel(up.repeat(8)), Array(8).fill(up))
  assert.deepEqual(splitWheel('\x1b[<65;300;420M'.repeat(3)), Array(3).fill('\x1b[<65;300;420M'))
  const legacy = '\x1b[M`!!' // 64+32 · 칸 1,1
  assert.deepEqual(splitWheel(legacy.repeat(4)), Array(4).fill(legacy))
  assert.deepEqual(splitWheel('\x1b[Ma~~'.repeat(2)), ['\x1b[Ma~~', '\x1b[Ma~~'])
  for (const arrow of ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB']) assert.deepEqual(splitWheel(arrow.repeat(32)), Array(32).fill(arrow))
})

test('splitWheel — 한 번뿐이거나 다른 입력이 섞이면 null(그대로 한 번에)', () => {
  assert.equal(splitWheel('\x1b[<64;1;1M'), null, '한 번은 나눌 것이 없다')
  assert.equal(splitWheel('\x1b[A'), null, '화살표 키 한 번')
  assert.equal(splitWheel('\x1b[<64;1;1M\x1b[<64;1;2M'), null, '칸이 다르면 같은 반복이 아니다')
  assert.equal(splitWheel('\x1b[<64;1;1M\x1b[<65;1;1M'), null, '방향이 섞이면')
  assert.equal(splitWheel('\x1b[A\x1b[B'), null)
  assert.equal(splitWheel('\x1b[A\x1b[Ax'), null, '끝에 글자')
  assert.equal(splitWheel('\x1b[<0;1;1M\x1b[<0;1;1M'), null, '휠이 아닌 마우스 누름')
  assert.equal(splitWheel('\x1b[C\x1b[C'), null, '좌우 화살표는 휠이 아니다')
  assert.equal(splitWheel('\x1b[M !!\x1b[M !!'), null, '옛 모양 누름')
  assert.equal(splitWheel('aa'), null)
  assert.equal(splitWheel(''), null)
})

test('spreadOffsets — 첫 것은 바로 · 간격 안에 고르게 · 마지막은 간격보다 앞', () => {
  assert.deepEqual(spreadOffsets(8, 120), [0, 15, 30, 45, 60, 75, 90, 105])
  assert.deepEqual(spreadOffsets(2, 50), [0, 25])
  const offsets = spreadOffsets(32, 50)
  assert.equal(offsets.length, 32)
  assert.ok((offsets.at(-1) ?? 0) < 50)
})

test('isWheelInput — 휠 · 화살표만으로 된 입력이면 한 번짜리도 쓸기 · 글자나 다른 마우스가 섞이면 아니다', () => {
  for (const unit of ['\x1b[<64;1;1M', '\x1b[<65;300;420M', '\x1b[M`!!', '\x1b[A', '\x1bOB']) {
    assert.equal(isWheelInput(unit), true, '한 번')
    assert.equal(isWheelInput(unit.repeat(5)), true, '반복')
  }
  for (const other of ['x', '\r', '\x1b[C', '\x1b[<0;1;1M', '\x1b[A\x1b[B', '\x1b[Ax', 'x\x1b[A', '']) assert.equal(isWheelInput(other), false, JSON.stringify(other))
})
