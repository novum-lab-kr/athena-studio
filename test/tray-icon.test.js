const test = require('node:test')
const assert = require('node:assert/strict')
const { RED, badgeBitmap } = require('../src/lib/tray-icon')

test('빨간 점 아이콘: 로고는 메뉴 막대 색으로 · 오른쪽 아래 빨간 점 · 점 둘레는 비움 · 원본은 그대로', () => {
  const width = 16
  const height = 16
  const source = Buffer.alloc(width * height * 4)
  for (let offset = 0; offset < source.length; offset += 4) source.writeUInt32LE(0xffffffff, offset) // 흰 로고(불투명)
  const out = badgeBitmap(source, width, height, [0, 0, 0])
  const pixel = (col, row) => [...out.subarray((row * width + col) * 4, (row * width + col) * 4 + 4)]
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 255]) // 왼쪽 위 — 검정으로 칠한 로고
  assert.deepEqual(pixel(width - 3, height - 3), [RED[2], RED[1], RED[0], 255]) // 점 안
  assert.equal(source.readUInt32LE(0), 0xffffffff)
  // 점과 로고 사이 1px 은 투명
  const ring = [...Array(width).keys()].some((col) => out[((height - 4) * width + col) * 4 + 3] === 0)
  assert.equal(ring, true)
  // 반투명 픽셀은 색에 알파를 곱한다(premultiplied)
  const soft = Buffer.alloc(16 * 16 * 4)
  soft.writeUInt32LE(0x80808080, 0)
  assert.deepEqual([...badgeBitmap(soft, 16, 16, [255, 255, 255]).subarray(0, 4)], [128, 128, 128, 128])
})
