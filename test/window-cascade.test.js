const test = require('node:test')
const assert = require('node:assert/strict')
const { CASCADE_STEP, cascadePosition } = require('../src/lib/window-cascade.mts')

const area = { x: 0, y: 25, width: 2560, height: 1415 }
const size = { width: 1400, height: 900 }
const at = (x, y) => ({ x, y, ...size })

test('창 계단식: 열린 창이 없으면 위치를 정하지 않는다(가운데)', () => {
  assert.equal(cascadePosition(null, [], area, size), null)
})

test('창 계단식: 기준 창에서 오른쪽 아래로 한 칸 · 이미 있는 자리는 건너뛴다', () => {
  const first = at(580, 282)
  assert.deepEqual(cascadePosition(first, [first], area, size), { x: 580 + CASCADE_STEP, y: 282 + CASCADE_STEP })
  // 첫 창이 앞에 있는데 그 한 칸 자리에 둘째 창이 있으면 한 칸 더
  const second = at(580 + CASCADE_STEP, 282 + CASCADE_STEP)
  assert.deepEqual(cascadePosition(first, [first, second], area, size), { x: 580 + CASCADE_STEP * 2, y: 282 + CASCADE_STEP * 2 })
})

test('창 계단식: 작업 영역을 넘으면 왼쪽 위로 돌아가고, 빈자리가 없으면 기준 창에서 한 칸만 비킨다', () => {
  const corner = at(area.x + area.width - size.width, area.y + area.height - size.height)
  assert.deepEqual(cascadePosition(corner, [corner], area, size), { x: area.x, y: area.y })
  // 창 크기가 작업 영역과 거의 같은 좁은 화면 — 왼쪽 위도 차 있으면 한 칸만 비킨다
  const small = { x: 0, y: 37, width: 1470, height: 919 }
  const top = at(small.x, small.y)
  assert.deepEqual(cascadePosition(top, [top], small, size), { x: small.x + CASCADE_STEP, y: small.y + CASCADE_STEP })
})
