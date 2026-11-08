// @ts-check
const test = require('node:test')
const assert = require('node:assert/strict')
const layout = require('../src/lib/layout.mts')
const preview = require('../src/lib/preview-layout.mts')

const { PREVIEW_ID } = preview
/** @typedef {import('../src/lib/layout.mts').Tree} Tree */
/** @typedef {import('../src/lib/preview-layout.mts').Spot} Spot */
const p1 = layout.leaf('p1')
const p2 = layout.leaf('p2')
const p3 = layout.leaf('p3')
// p1 | (p2 / p3)
/** @type {Tree} */
const tree = { split: 'right', ratio: 0.5, first: p1, second: { split: 'down', ratio: 0.5, first: p2, second: p3 } }

test('처음 열 때: 터미널 칸 전체 오른쪽에 45%', () => {
  const composite = preview.composeTree(tree, preview.defaultSpot(tree))
  assert.deepEqual(composite, { split: 'right', ratio: 0.55, first: tree, second: layout.leaf(PREVIEW_ID) })
  const rects = layout.computeRects(composite, { width: 1000, height: 100 })
  assert.equal(rects[PREVIEW_ID]?.width, 450)
})

test('pane 이 없으면 미리보기만 · anchor 칸이 없으면 트리 전체 옆에', () => {
  assert.deepEqual(preview.composeTree(null, preview.defaultSpot(null)), layout.leaf(PREVIEW_ID))
  /** @type {Spot} */
  const spot = { anchor: ['p9'], split: 'down', previewFirst: true, ratio: 0.3 }
  assert.deepEqual(preview.composeTree(tree, spot), { split: 'down', ratio: 0.3, first: layout.leaf(PREVIEW_ID), second: tree })
})

test('합친 트리 ↔ 데몬 트리 + 자리', () => {
  /** @type {Spot} */
  const spot = { anchor: ['p2'], split: 'right', previewFirst: true, ratio: 0.4 }
  const composite = preview.composeTree(tree, spot)
  assert.deepEqual(preview.nodeAt(composite, ['second', 'first']), { split: 'right', ratio: 0.4, first: layout.leaf(PREVIEW_ID), second: p2 })
  assert.deepEqual(preview.splitTree(composite), { tree, spot })
  assert.deepEqual(preview.previewBranchPath(composite), ['second', 'first'])
})

test('경계 길: 미리보기 가지는 null · 나머지는 데몬 트리의 같은 경계', () => {
  const composite = preview.composeTree(tree, /** @type {Spot} */ ({ anchor: ['p2'], split: 'right', previewFirst: false, ratio: 0.5 }))
  assert.equal(preview.daemonPath(composite, ['second', 'first']), null)
  assert.deepEqual(preview.daemonPath(composite, []), [])
  assert.deepEqual(preview.daemonPath(composite, ['second']), ['second'])
  // 트리 전체 옆이면 뿌리가 미리보기 가지 — 데몬 경계는 한 칸 아래
  const whole = preview.composeTree(tree, preview.defaultSpot(tree))
  assert.equal(preview.daemonPath(whole, []), null)
  assert.deepEqual(preview.daemonPath(whole, ['first']), [])
  assert.deepEqual(preview.daemonPath(whole, ['first', 'second']), ['second'])
})

test('미리보기 옮기기는 화면만 — 데몬 트리는 그대로', () => {
  const result = preview.moveWithPreview(tree, preview.defaultSpot(tree), PREVIEW_ID, 'p3', 'up')
  assert.deepEqual(result, { spot: { anchor: ['p3'], split: 'down', previewFirst: true, ratio: 0.5 }, daemonMove: null })
})

test('터미널을 미리보기 옆에 — 데몬 옮기기 한 번으로 되면 그 옮기기', () => {
  /** @type {Spot} */
  const spot = { anchor: ['p2'], split: 'right', previewFirst: false, ratio: 0.5 }
  // p3 을 미리보기 아래로 → 데몬에서는 p3 이 p2 오른쪽
  const result = preview.moveWithPreview(tree, spot, 'p3', PREVIEW_ID, 'down')
  assert.ok(result)
  assert.deepEqual(result.daemonMove, { target: 'p2', side: 'right' })
  // 미리보기는 p3 위에 붙는다 — p1 | (p2 | (미리보기 / p3))
  assert.deepEqual(result.spot, { anchor: ['p3'], split: 'down', previewFirst: true, ratio: 0.5 })
  const after = layout.movePane(tree, 'p3', 'p2', 'right')
  assert.deepEqual(layout.paneIds(preview.composeTree(after, result.spot)), ['p1', 'p2', PREVIEW_ID, 'p3'])
})

test('터미널끼리 옮기기는 데몬 옮기기 그대로 · 미리보기 자리는 따라간다', () => {
  /** @type {Spot} */
  const spot = { anchor: ['p2'], split: 'right', previewFirst: false, ratio: 0.5 }
  const result = preview.moveWithPreview(tree, spot, 'p1', 'p3', 'down')
  assert.ok(result)
  assert.deepEqual(result.daemonMove, { target: 'p3', side: 'down' })
  assert.deepEqual(result.spot.anchor, ['p2'])
})

test('데몬 한 번으로 못 만드는 자리는 null', () => {
  // 트리 전체 옆 미리보기의 왼쪽에 p1 을 놓으면 데몬에서는 p1 이 (p2 / p3) 전체 오른쪽 — pane 옆이 아니다
  assert.equal(preview.moveWithPreview(tree, preview.defaultSpot(tree), 'p1', PREVIEW_ID, 'left'), null)
})
