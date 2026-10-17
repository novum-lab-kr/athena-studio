// 탭 하나의 분할 트리 — 데몬(칸 단위)과 화면(픽셀 단위)이 같이 쓴다.
// 화면(renderer)은 Node 도 번들러도 없어서 <script> 로 싣는다 — module 이 있으면 module.exports, 없으면 전역 StudioLayout.
//
// 트리: 잎 { pane: '<id>' } · 가지 { split: 'right' | 'down', ratio, first, second }
//   right = first 왼쪽 · second 오른쪽, down = first 위 · second 아래.
//   ratio 는 first(원래 pane)가 가질 몫 — herdr `pane split --ratio` 와 같다(2026-10-17 실측: 0.25 → 원래 pane 이 1/4).
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.StudioLayout = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DIRECTIONS = ['right', 'down']
  const DEFAULT_RATIO = 0.5

  function leaf(paneId) {
    return { pane: paneId }
  }

  function isLeaf(node) {
    return Boolean(node) && typeof node.pane === 'string'
  }

  // 0 과 1 사이가 아니면 기본값 — 끝값이면 한쪽이 0칸이 된다
  function normalizeRatio(ratio) {
    const value = Number(ratio)
    return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_RATIO
  }

  function paneIds(node) {
    if (!node) return []
    if (isLeaf(node)) return [node.pane]
    return [...paneIds(node.first), ...paneIds(node.second)]
  }

  function hasPane(node, paneId) {
    return paneIds(node).includes(paneId)
  }

  // target 자리를 나눠 newId 를 붙인 새 트리. target 이 없으면 null(원래 트리는 바꾸지 않는다)
  function splitPane(node, targetId, newId, direction, ratio) {
    if (!DIRECTIONS.includes(direction)) throw new Error(`모르는 분할 방향: ${direction}`)
    if (!node) return null
    if (isLeaf(node)) {
      if (node.pane !== targetId) return null
      return { split: direction, ratio: normalizeRatio(ratio), first: leaf(targetId), second: leaf(newId) }
    }
    const first = splitPane(node.first, targetId, newId, direction, ratio)
    if (first) return { ...node, first }
    const second = splitPane(node.second, targetId, newId, direction, ratio)
    if (second) return { ...node, second }
    return null
  }

  // pane 을 뺀 새 트리 — 형제가 그 자리를 다 차지한다. 마지막 pane 이면 null
  function removePane(node, paneId) {
    if (!node) return null
    if (isLeaf(node)) return node.pane === paneId ? null : node
    if (!hasPane(node, paneId)) return node
    const first = removePane(node.first, paneId)
    const second = removePane(node.second, paneId)
    if (!first) return second
    if (!second) return first
    return { ...node, first, second }
  }

  // 길이 total 을 ratio 로 나눈다(사이 gap 을 빼고). 양쪽 모두 1 이상 — 칸이 모자라면 0 도 나온다
  function divide(total, ratio, gap) {
    const usable = Math.max(0, total - gap)
    if (usable < 2) return [usable, 0]
    const firstSize = Math.min(usable - 1, Math.max(1, Math.round(usable * ratio)))
    return [firstSize, usable - firstSize]
  }

  // 트리 → { [paneId]: {x, y, width, height} }. area 는 {x, y, width, height}(칸이든 픽셀이든 정수)
  function computeRects(node, area, gap = 0) {
    const rects = {}
    const walk = (current, box) => {
      if (!current) return
      if (isLeaf(current)) {
        rects[current.pane] = box
        return
      }
      const ratio = normalizeRatio(current.ratio)
      if (current.split === 'right') {
        const [firstWidth, secondWidth] = divide(box.width, ratio, gap)
        walk(current.first, { x: box.x, y: box.y, width: firstWidth, height: box.height })
        walk(current.second, { x: box.x + firstWidth + gap, y: box.y, width: secondWidth, height: box.height })
      } else {
        const [firstHeight, secondHeight] = divide(box.height, ratio, gap)
        walk(current.first, { x: box.x, y: box.y, width: box.width, height: firstHeight })
        walk(current.second, { x: box.x, y: box.y + firstHeight + gap, width: box.width, height: secondHeight })
      }
    }
    walk(node, { x: area.x || 0, y: area.y || 0, width: area.width, height: area.height })
    return rects
  }

  // 경계 드래그 — 비율은 이 범위 안으로(한쪽이 사라지지 않게)
  const MIN_RATIO = 0.05
  const MAX_RATIO = 0.95
  const SIDES = ['first', 'second']

  // 가지마다 경계 하나: { path, split, box(그 가지 전체), line(사이 gap 자리) }. path 는 뿌리에서 'first' · 'second' 로 내려가는 길
  function dividers(node, area, gap = 0) {
    const found = []
    const walk = (current, box, path) => {
      if (!current || isLeaf(current)) return
      const ratio = normalizeRatio(current.ratio)
      if (current.split === 'right') {
        const [firstWidth, secondWidth] = divide(box.width, ratio, gap)
        found.push({ path, split: 'right', box, line: { x: box.x + firstWidth, y: box.y, width: gap, height: box.height } })
        walk(current.first, { x: box.x, y: box.y, width: firstWidth, height: box.height }, [...path, 'first'])
        walk(current.second, { x: box.x + firstWidth + gap, y: box.y, width: secondWidth, height: box.height }, [...path, 'second'])
      } else {
        const [firstHeight, secondHeight] = divide(box.height, ratio, gap)
        found.push({ path, split: 'down', box, line: { x: box.x, y: box.y + firstHeight, width: box.width, height: gap } })
        walk(current.first, { x: box.x, y: box.y, width: box.width, height: firstHeight }, [...path, 'first'])
        walk(current.second, { x: box.x, y: box.y + firstHeight + gap, width: box.width, height: secondHeight }, [...path, 'second'])
      }
    }
    walk(node, { x: area.x || 0, y: area.y || 0, width: area.width, height: area.height }, [])
    return found
  }

  function isValidPath(path) {
    return Array.isArray(path) && path.length <= 64 && path.every((step) => SIDES.includes(step))
  }

  // path 의 가지 비율을 바꾼 새 트리. 길이 잎이나 없는 곳이면 null(원래 트리는 바꾸지 않는다)
  function setRatio(node, path, ratio) {
    // 숫자(문자열 · null · true 아님)이고 유한해야 한다 — 소켓으로 바로 오는 값도 있다
    if (!isValidPath(path) || !node || isLeaf(node) || typeof ratio !== 'number' || !Number.isFinite(ratio)) return null
    const value = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
    if (path.length === 0) return { ...node, ratio: value }
    const [step, ...rest] = path
    const child = setRatio(node[step], rest, value)
    return child ? { ...node, [step]: child } : null
  }

  // 경계를 끈 위치(pos — right 면 x, down 이면 y) → 그 가지의 비율
  function ratioAt(divider, pos, gap = 0) {
    const horizontal = divider.split === 'right'
    const start = horizontal ? divider.box.x : divider.box.y
    const usable = Math.max(1, (horizontal ? divider.box.width : divider.box.height) - gap)
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, (pos - start - gap / 2) / usable))
  }

  // 방향(left · right · up · down)으로 맞닿은 pane 중 가장 가까운 것. 없으면 null
  function neighbor(node, area, paneId, direction) {
    const rects = computeRects(node, area)
    const from = rects[paneId]
    if (!from) return null
    const horizontal = direction === 'left' || direction === 'right'
    const center = (rect) => (horizontal ? rect.y + rect.height / 2 : rect.x + rect.width / 2)
    const fromCenter = center(from)
    let best = null
    let bestScore = Infinity
    for (const [id, rect] of Object.entries(rects)) {
      if (id === paneId) continue
      if (!isAhead(from, rect, direction)) continue
      // 다른 축으로 겹쳐야 이웃이다
      const overlaps = horizontal
        ? rect.y < from.y + from.height && from.y < rect.y + rect.height
        : rect.x < from.x + from.width && from.x < rect.x + rect.width
      if (!overlaps) continue
      const score = gapBetween(from, rect, direction) * 10000 + Math.abs(center(rect) - fromCenter)
      if (score < bestScore) {
        best = id
        bestScore = score
      }
    }
    return best
  }

  function isAhead(from, rect, direction) {
    if (direction === 'left') return rect.x + rect.width <= from.x
    if (direction === 'right') return rect.x >= from.x + from.width
    if (direction === 'up') return rect.y + rect.height <= from.y
    if (direction === 'down') return rect.y >= from.y + from.height
    throw new Error(`모르는 방향: ${direction}`)
  }

  function gapBetween(from, rect, direction) {
    if (direction === 'left') return from.x - (rect.x + rect.width)
    if (direction === 'right') return rect.x - (from.x + from.width)
    if (direction === 'up') return from.y - (rect.y + rect.height)
    return rect.y - (from.y + from.height)
  }

  return { DIRECTIONS, DEFAULT_RATIO, MIN_RATIO, MAX_RATIO, leaf, isLeaf, paneIds, hasPane, splitPane, removePane, computeRects, dividers, setRatio, ratioAt, neighbor }
})
