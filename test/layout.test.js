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
