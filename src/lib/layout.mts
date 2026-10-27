// 탭 하나의 분할 트리 — 데몬(칸 단위)과 화면(픽셀 단위)이 같이 쓴다.
// ES 모듈 — 데몬 · main 은 import, 화면은 나눈 .ts(screen · dividers · pane-layout · space-actions)가 이름공간째(StudioLayout) import 한다.
//
// 트리: 잎 { pane: '<id>' } · 가지 { split: 'right' | 'down', ratio, first, second }
//   right = first 왼쪽 · second 오른쪽, down = first 위 · second 아래.
//   ratio 는 first(원래 pane)가 가질 몫(0.25 → 원래 pane 이 1/4).
export type Direction = 'right' | 'down'
export type Leaf = { pane: string }
export type Branch = { split: Direction; ratio: number; first: Tree; second: Tree }
export type Tree = Leaf | Branch
export type Rect = { x: number; y: number; width: number; height: number }
// 나눌 넓이 — x · y 가 없으면 0
export type Area = { x?: number; y?: number; width: number; height: number }
type Side = 'first' | 'second'
// 가지마다 경계 하나 — path 는 뿌리에서 'first' · 'second' 로 내려가는 길
export type Divider = { path: Side[]; split: Direction; box: Rect; line: Rect }
type Node = Tree | null | undefined

export const DIRECTIONS: readonly Direction[] = ['right', 'down']
export const DEFAULT_RATIO = 0.5

const isDirection = (value: unknown): value is Direction => (DIRECTIONS as readonly unknown[]).includes(value)

export function leaf(paneId: string): Leaf {
  return { pane: paneId }
}

export function isLeaf(node: Node): node is Leaf {
  return Boolean(node) && typeof (node as Leaf).pane === 'string'
}

// 0 과 1 사이가 아니면 기본값 — 끝값이면 한쪽이 0칸이 된다
function normalizeRatio(ratio: unknown): number {
  const value = Number(ratio)
  return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_RATIO
}

export function paneIds(node: Node): string[] {
  if (!node) return []
  if (isLeaf(node)) return [node.pane]
  return [...paneIds(node.first), ...paneIds(node.second)]
}

export function hasPane(node: Node, paneId: string): boolean {
  return paneIds(node).includes(paneId)
}

// target 자리를 나눠 newId 를 붙인 새 트리. target 이 없으면 null(원래 트리는 바꾸지 않는다)
// direction · ratio 는 소켓으로 바로 오는 값도 있다 — 모르는 방향이면 던지고, 비율은 0 과 1 사이가 아니면 기본값
export function splitPane(node: Node, targetId: string, newId: string, direction: unknown, ratio?: unknown): Tree | null {
  if (!isDirection(direction)) throw new Error(`모르는 분할 방향: ${direction}`)
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
export function removePane(node: Node, paneId: string): Tree | null {
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
function divide(total: number, ratio: number, gap: number): [number, number] {
  const usable = Math.max(0, total - gap)
  if (usable < 2) return [usable, 0]
  const firstSize = Math.min(usable - 1, Math.max(1, Math.round(usable * ratio)))
  return [firstSize, usable - firstSize]
}

// 트리 → { [paneId]: {x, y, width, height} }. area 는 {x, y, width, height}(칸이든 픽셀이든 정수)
export function computeRects(node: Node, area: Area, gap = 0): Record<string, Rect> {
  const rects: Record<string, Rect> = {}
  const walk = (current: Node, box: Rect) => {
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
export const MIN_RATIO = 0.05
export const MAX_RATIO = 0.95
const SIDES: readonly Side[] = ['first', 'second']

// 가지마다 경계 하나: { path, split, box(그 가지 전체), line(사이 gap 자리) }. path 는 뿌리에서 'first' · 'second' 로 내려가는 길
export function dividers(node: Node, area: Area, gap = 0): Divider[] {
  const found: Divider[] = []
  const walk = (current: Node, box: Rect, path: Side[]) => {
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

function isValidPath(path: unknown): path is Side[] {
  return Array.isArray(path) && path.length <= 64 && path.every((step) => SIDES.includes(step))
}

// path 의 가지 비율을 바꾼 새 트리. 길이 잎이나 없는 곳이면 null(원래 트리는 바꾸지 않는다)
export function setRatio(node: Node, path: unknown, ratio: unknown): Tree | null {
  // 숫자(문자열 · null · true 아님)이고 유한해야 한다 — 소켓으로 바로 오는 값도 있다
  if (!isValidPath(path) || !node || isLeaf(node) || typeof ratio !== 'number' || !Number.isFinite(ratio)) return null
  const value = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
  if (path.length === 0) return { ...node, ratio: value }
  const [step, ...rest] = path as [Side, ...Side[]]
  const child = setRatio(node[step], rest, value)
  return child ? { ...node, [step]: child } : null
}

// 경계를 끈 위치(pos — right 면 x, down 이면 y) → 그 가지의 비율
export function ratioAt(divider: Pick<Divider, 'split' | 'box'>, pos: number, gap = 0): number {
  const horizontal = divider.split === 'right'
  const start = horizontal ? divider.box.x : divider.box.y
  const usable = Math.max(1, (horizontal ? divider.box.width : divider.box.height) - gap)
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, (pos - start - gap / 2) / usable))
}

// 방향(left · right · up · down)으로 맞닿은 pane 중 가장 가까운 것. 없으면 null
export function neighbor(node: Node, area: Area, paneId: string, direction: string): string | null {
  const rects = computeRects(node, area)
  const from = rects[paneId]
  if (!from) return null
  const horizontal = direction === 'left' || direction === 'right'
  const center = (rect: Rect) => (horizontal ? rect.y + rect.height / 2 : rect.x + rect.width / 2)
  const fromCenter = center(from)
  let best: string | null = null
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

function isAhead(from: Rect, rect: Rect, direction: string): boolean {
  if (direction === 'left') return rect.x + rect.width <= from.x
  if (direction === 'right') return rect.x >= from.x + from.width
  if (direction === 'up') return rect.y + rect.height <= from.y
  if (direction === 'down') return rect.y >= from.y + from.height
  throw new Error(`모르는 방향: ${direction}`)
}

function gapBetween(from: Rect, rect: Rect, direction: string): number {
  if (direction === 'left') return from.x - (rect.x + rect.width)
  if (direction === 'right') return rect.x - (from.x + from.width)
  if (direction === 'up') return from.y - (rect.y + rect.height)
  return rect.y - (from.y + from.height)
}
