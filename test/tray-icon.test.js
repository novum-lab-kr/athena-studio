const test = require('node:test')
const assert = require('node:assert/strict')
const { GREEN, owlBitmap } = require('../src/lib/tray-icon.mts')

// 32px 로고 자리 — 눈 가운데(가로 0.305 · 세로 0.39 비율)와 눈에서 먼 곳
const width = 32
const height = 32
const EYE = [9, 12]
const FAR = [1, 30]
const pixelOf = (buffer, [col, row]) => [...buffer.subarray((row * width + col) * 4, (row * width + col) * 4 + 4)]

test('부엉이 눈 아이콘: 로고는 메뉴 막대 색 · 눈 자리만 눈 색 · 원본은 그대로', () => {
  const source = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < source.length; offset += 4) source.writeUInt32LE(0xffffffff, offset) // 흰 로고(불투명)
  const working = owlBitmap(source, width, height, [0, 0, 0], GREEN, true)
  assert.deepEqual(pixelOf(working, FAR), [0, 0, 0, 255]) // 밝은 메뉴 막대 — 검정 로고
  assert.deepEqual(pixelOf(working, EYE), [GREEN[2], GREEN[1], GREEN[0], 255]) // 초록 눈
  // 쉴 때는 main 이 로고 색을 눈 색으로 넘긴다 — 밝은 막대면 검정 눈(로고 모양 그대로 · 사용자 2026-11-04)
  const idle = owlBitmap(source, width, height, [0, 0, 0], [0, 0, 0], false)
  assert.deepEqual(pixelOf(idle, EYE), [0, 0, 0, 255])
  const idleDark = owlBitmap(source, width, height, [255, 255, 255], [255, 255, 255], false)
  assert.deepEqual(pixelOf(idleDark, EYE), [255, 255, 255, 255]) // 어두운 막대 — 하얀 눈
  assert.equal(source.readUInt32LE(0), 0xffffffff)
})

test('부엉이 눈 아이콘: 빛 번짐은 눈 둘레 빈 픽셀에만 · 끄면 빈 픽셀은 그대로 투명', () => {
  const empty = Buffer.alloc(width * height * 4)
  const near = [EYE[0] + 4, EYE[1]] // 켠 눈 원(32px 로 반지름 약 3.4) 바로 바깥
  const glowing = owlBitmap(empty, width, height, [255, 255, 255], GREEN, true)
  const [blue, green, red, alpha] = pixelOf(glowing, near)
  assert.ok(alpha > 0 && alpha < 255) // 옅은 초록
  assert.ok(green > red && green > blue)
  assert.deepEqual(pixelOf(glowing, FAR), [0, 0, 0, 0]) // 먼 곳은 번지지 않는다
  assert.deepEqual(pixelOf(owlBitmap(empty, width, height, [255, 255, 255], [255, 255, 255], false), near), [0, 0, 0, 0])
})

test('부엉이 눈 아이콘: 켠 눈은 로고 빈 틈까지 꽉 찬 초록 원 — 16px 에서도 보이게 · 끈 눈은 빈 틈 그대로', () => {
  // 회오리 빈 틈(투명) 위의 눈 가운데도 초록으로 덮는다 — 로고 픽셀만 칠하면 16px 에서 눈마다 1px 남짓이었다
  const empty = Buffer.alloc(width * height * 4)
  assert.deepEqual(pixelOf(owlBitmap(empty, width, height, [255, 255, 255], GREEN, true), EYE), [GREEN[2], GREEN[1], GREEN[0], 255])
  assert.deepEqual(pixelOf(owlBitmap(empty, width, height, [255, 255, 255], [255, 255, 255], false), EYE), [0, 0, 0, 0])
  // 16px 로고에서 눈마다 진한 초록이 몇 픽셀 이상
  const small = 16
  const lit = owlBitmap(Buffer.alloc(small * small * 4), small, small, [0, 0, 0], GREEN, true)
  let solid = 0
  for (let offset = 0; offset < lit.length; offset += 4) if ((lit[offset + 3] ?? 0) >= 200) solid++
  assert.ok(solid >= 12, `진한 초록 ${solid}px`)
})

test('부엉이 눈 아이콘: 반투명 픽셀은 색에 알파를 곱한다(premultiplied)', () => {
  const soft = Buffer.alloc(width * height * 4)
  soft.writeUInt32LE(0x80808080, 0)
  assert.deepEqual(pixelOf(owlBitmap(soft, width, height, [255, 255, 255], [255, 255, 255], false), [0, 0]), [128, 128, 128, 128])
})
