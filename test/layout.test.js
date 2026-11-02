const test = require('node:test')
const assert = require('node:assert/strict')
const layout = require('../src/lib/layout.mts')

const area = { x: 0, y: 0, width: 100, height: 40 }

test('분할: ratio 는 원래 pane 몫 · 대상이 없으면 null · 원래 트리는 그대로', () => {
  const root = layout.leaf('p1')
  const split = layout.splitPane(root, 'p1', 'p2', 'right', 0.25)
  assert.deepEqual(split, { split: 'right', ratio: 0.25, first: { pane: 'p1' }, second: { pane: 'p2' } })
  assert.deepEqual(root, { pane: 'p1' })
  assert.equal(layout.splitPane(root, 'p9', 'p2', 'right'), null)
  assert.throws(() => layout.splitPane(root, 'p1', 'p2', 'left'), /분할 방향/)
})

test('분할: 이상한 ratio 는 0.5', () => {
  for (const ratio of [undefined, 0, 1, -1, 2, 'x', NaN]) {
    assert.equal(layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'down', ratio).ratio, 0.5)
  }
})

test('분할: 안쪽 pane 을 나누면 그 자리만 바뀐다', () => {
  let tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right')
  tree = layout.splitPane(tree, 'p2', 'p3', 'down', 0.3)
  assert.deepEqual(layout.paneIds(tree), ['p1', 'p2', 'p3'])
  assert.deepEqual(tree.second, { split: 'down', ratio: 0.3, first: { pane: 'p2' }, second: { pane: 'p3' } })
  assert.equal(layout.hasPane(tree, 'p3'), true)
  assert.equal(layout.hasPane(tree, 'p4'), false)
})

test('빼기: 형제가 자리를 차지 · 마지막이면 null · 없는 pane 은 그대로', () => {
  let tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right')
  tree = layout.splitPane(tree, 'p2', 'p3', 'down')
  const removed = layout.removePane(tree, 'p2')
  assert.deepEqual(removed, { split: 'right', ratio: 0.5, first: { pane: 'p1' }, second: { pane: 'p3' } })
  assert.deepEqual(layout.removePane(removed, 'p1'), { pane: 'p3' })
  assert.equal(layout.removePane(layout.leaf('p1'), 'p1'), null)
  assert.equal(layout.removePane(tree, 'p9'), tree)
  assert.equal(layout.removePane(null, 'p1'), null)
})

test('사각형: 칸 단위 · 반올림 · gap', () => {
  let tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right', 0.25)
  tree = layout.splitPane(tree, 'p2', 'p3', 'down')
  assert.deepEqual(layout.computeRects(tree, area), {
    p1: { x: 0, y: 0, width: 25, height: 40 },
    p2: { x: 25, y: 0, width: 75, height: 20 },
    p3: { x: 25, y: 20, width: 75, height: 20 },
  })
  // 경계선 1칸을 빼고 나눈다 — 전체 폭은 그대로
  const rects = layout.computeRects(tree, area, 1)
  assert.equal(rects.p1.width + 1 + rects.p2.width, 100)
  assert.equal(rects.p2.height + 1 + rects.p3.height, 40)
  assert.equal(rects.p2.x, rects.p1.width + 1)
})

test('사각형: 좁아도 양쪽 1칸 이상 · area 시작점 반영', () => {
  const tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right', 0.01)
  const rects = layout.computeRects(tree, { x: 10, y: 5, width: 3, height: 2 })
  assert.deepEqual(rects.p1, { x: 10, y: 5, width: 1, height: 2 })
  assert.deepEqual(rects.p2, { x: 11, y: 5, width: 2, height: 2 })
  assert.deepEqual(layout.computeRects(layout.leaf('p1'), area), { p1: area })
})

test('이웃: 방향으로 맞닿은 가장 가까운 pane', () => {
  // p1 | p2
  //    | p3
  let tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right')
  tree = layout.splitPane(tree, 'p2', 'p3', 'down')
  assert.equal(layout.neighbor(tree, area, 'p1', 'right'), 'p2') // 둘 다 맞닿으면 위쪽 중심이 가까운 쪽 — 같으면 먼저 나온 것
  assert.equal(layout.neighbor(tree, area, 'p3', 'left'), 'p1')
  assert.equal(layout.neighbor(tree, area, 'p2', 'down'), 'p3')
  assert.equal(layout.neighbor(tree, area, 'p3', 'up'), 'p2')
  assert.equal(layout.neighbor(tree, area, 'p1', 'left'), null)
  assert.equal(layout.neighbor(tree, area, 'p9', 'left'), null)
  assert.throws(() => layout.neighbor(tree, area, 'p1', 'sideways'), /방향/)
})

test('경계: 가지마다 하나 · 비율 바꾸기 · 끈 위치 → 비율', () => {
  let tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right')
  tree = layout.splitPane(tree, 'p2', 'p3', 'down', 0.3)
  const area = { x: 0, y: 0, width: 102, height: 52 }
  const found = layout.dividers(tree, area, 2)
  assert.deepEqual(found.map((entry) => [entry.path.join('.'), entry.split]), [['', 'right'], ['second', 'down']])
  // 가운데 경계 자리는 gap(2) — 첫째 50칸 뒤
  assert.deepEqual(found[0].line, { x: 50, y: 0, width: 2, height: 52 })

  const moved = layout.setRatio(tree, ['second'], 0.7)
  assert.equal(moved.second.ratio, 0.7)
  assert.equal(tree.second.ratio, 0.3) // 원래 트리는 그대로
  assert.equal(layout.setRatio(tree, [], 0.99).ratio, layout.MAX_RATIO)
  assert.equal(layout.setRatio(tree, [], 0).ratio, layout.MIN_RATIO)
  assert.equal(layout.setRatio(tree, ['first'], 0.5), null) // 잎
  assert.equal(layout.setRatio(tree, ['third'], 0.5), null) // 이상한 길
  assert.equal(layout.setRatio(tree, [], Number.NaN), null)
  for (const bad of ['0.5', null, true, [], Infinity]) assert.equal(layout.setRatio(tree, [], bad), null)

  // 첫 경계를 x=26 으로 끌면 (26 - 1) / 100 = 0.25
  assert.equal(layout.ratioAt(found[0], 26, 2), 0.25)
  assert.equal(layout.ratioAt(found[0], -50, 2), layout.MIN_RATIO)
  assert.equal(layout.ratioAt(found[0], 500, 2), layout.MAX_RATIO)
})

test('옮기기: 대상을 반으로 나눠 그 쪽에 끼운다 — 왼쪽 · 위는 first · 형제가 빈자리를 차지', () => {
  // p1 | p2
  //    | p3
  let tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right', 0.3)
  tree = layout.splitPane(tree, 'p2', 'p3', 'down')
  const p1 = { pane: 'p1' }
  const p2 = { pane: 'p2' }
  const p3 = { pane: 'p3' }
  assert.deepEqual(layout.movePane(tree, 'p3', 'p1', 'left'), { split: 'right', ratio: 0.3, first: { split: 'right', ratio: 0.5, first: p3, second: p1 }, second: p2 })
  assert.deepEqual(layout.movePane(tree, 'p3', 'p1', 'right'), { split: 'right', ratio: 0.3, first: { split: 'right', ratio: 0.5, first: p1, second: p3 }, second: p2 })
  assert.deepEqual(layout.movePane(tree, 'p3', 'p1', 'up'), { split: 'right', ratio: 0.3, first: { split: 'down', ratio: 0.5, first: p3, second: p1 }, second: p2 })
  assert.deepEqual(layout.movePane(tree, 'p3', 'p1', 'down'), { split: 'right', ratio: 0.3, first: { split: 'down', ratio: 0.5, first: p1, second: p3 }, second: p2 })
  // 대상이 빠지는 pane 의 형제여도 된다 — 형제가 가지 자리로 올라온 뒤 나눈다
  assert.deepEqual(layout.movePane(tree, 'p3', 'p2', 'left').second, { split: 'right', ratio: 0.5, first: p3, second: p2 })
  // 두 pane 이면 뿌리가 바뀐다
  assert.deepEqual(layout.movePane(layout.splitPane(p1, 'p1', 'p2', 'right'), 'p2', 'p1', 'up'), { split: 'down', ratio: 0.5, first: p2, second: p1 })
  assert.deepEqual(layout.paneIds(tree), ['p1', 'p2', 'p3']) // 원래 트리는 그대로
})

test('옮기기: 자기 자신 · 없는 pane · 모르는 쪽은 null', () => {
  const tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right')
  assert.equal(layout.movePane(tree, 'p1', 'p1', 'left'), null)
  assert.equal(layout.movePane(tree, 'p9', 'p1', 'left'), null)
  assert.equal(layout.movePane(tree, 'p1', 'p9', 'left'), null)
  assert.equal(layout.movePane(null, 'p1', 'p2', 'left'), null)
  for (const bad of ['center', undefined, null, 0]) assert.equal(layout.movePane(tree, 'p1', 'p2', bad), null)
})

test('놓을 자리: 점이 든 pane · 가까운 쪽 · 나눌 자리', () => {
  const tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right')
  const rects = layout.computeRects(tree, { x: 0, y: 0, width: 102, height: 40 }, 2)
  assert.equal(layout.paneAt(rects, 10, 10), 'p1')
  assert.equal(layout.paneAt(rects, 60, 10), 'p2')
  assert.equal(layout.paneAt(rects, 50, 10), null) // 사이 gap
  assert.equal(layout.paneAt(rects, 10, 40), null) // 영역 밖

  const rect = { x: 100, y: 200, width: 400, height: 100 }
  assert.equal(layout.dropSide(rect, 110, 250), 'left')
  assert.equal(layout.dropSide(rect, 490, 250), 'right')
  assert.equal(layout.dropSide(rect, 300, 205), 'up')
  assert.equal(layout.dropSide(rect, 300, 295), 'down')
  // 칸 크기로 나눠 잰다 — 넓은 칸의 왼쪽 위 안쪽은 픽셀로는 위가 가깝지만 비율로는 왼쪽
  assert.equal(layout.dropSide(rect, 120, 240), 'left')
  assert.ok(['left', 'right', 'up', 'down'].includes(layout.dropSide(rect, 300, 250))) // 정가운데도 어느 한 쪽
})

test('놓을 자리: 세 pane 탭에서 형제에 놓으면 형제가 빈자리를 차지한 뒤 나눈 자리 — 대상 칸의 절반이 아니다', () => {
  // p1 | p2
  //    | p3   ← p3 을 형제 p2 의 왼쪽에
  let tree = layout.splitPane(layout.leaf('p1'), 'p1', 'p2', 'right')
  tree = layout.splitPane(tree, 'p2', 'p3', 'down')
  const area = { x: 0, y: 0, width: 102, height: 42 }
  const before = layout.computeRects(tree, area, 2)
  assert.deepEqual(before.p2, { x: 52, y: 0, width: 50, height: 20 })
  const moved = layout.movePane(tree, 'p3', 'p2', 'left')
  const rects = layout.computeRects(moved, area, 2)
  // 화면 표시가 쓰는 계산(옮긴 트리의 끄는 pane 자리) — p2 가 오른쪽 세로 전체로 올라온 뒤 왼쪽 절반
  assert.deepEqual(rects.p3, { x: 52, y: 0, width: 24, height: 42 })
  assert.deepEqual(rects.p2, { x: 78, y: 0, width: 24, height: 42 })
  assert.notEqual(rects.p3.height, before.p2.height) // 대상 칸(높이 20)만 반으로 나눈 것과 다르다
})
