// 파일 미리보기를 pane 배치 트리의 한 칸으로 — 화면에서만 합친다(데몬 트리는 그대로).
// 데몬 탭 트리(layout.mts)의 잎은 데몬 pane 번호뿐이라 미리보기 칸을 넣을 수 없다. 그래서 화면이
// "데몬 트리 + 미리보기 잎" 을 합친 트리를 만들어 기존 배치 · 경계 · 끌어 옮기기 계산에 그대로 넘기고,
// 미리보기 자리(옆 칸 · 방향 · 비율 — Spot)만 따로 기억한다. 화면(.ts)만 import 한다.
import * as layout from './layout.mts'
import type { Direction, DropSide, Tree } from './layout.mts'

type Side = 'first' | 'second'

// 데몬 pane 번호(p1 …)와 겹치지 않는 미리보기 잎 이름
export const PREVIEW_ID = '@preview'

// 미리보기 자리 — anchor 칸(그 pane 번호들로 이뤄진 가지 · 잎) 옆에 split 방향으로 붙는다.
// ratio 는 layout 과 같이 first 몫. previewFirst 면 미리보기가 왼쪽(위)
export type Spot = { anchor: string[]; split: Direction; previewFirst: boolean; ratio: number }

// 처음 열 때 — 터미널 칸 전체의 오른쪽에 45%(나눠 띄우던 옛 미리보기 기본 너비와 같게)
export const DEFAULT_PREVIEW_SHARE = 0.45

export function defaultSpot(tree: Tree | null): Spot {
  return { anchor: layout.paneIds(tree), split: 'right', previewFirst: false, ratio: 1 - DEFAULT_PREVIEW_SHARE }
}

const sameIds = (left: string[], right: string[]): boolean => left.length === right.length && left.every((id) => right.includes(id))

// 잎 · 가지 중 pane 번호 묶음이 ids 와 같은 곳의 길. 없으면 null(이진 트리라 같은 묶음은 한 곳뿐이다)
export function pathOf(node: Tree | null, ids: string[], path: Side[] = []): Side[] | null {
  if (!node) return null
  if (sameIds(layout.paneIds(node), ids)) return path
  if (layout.isLeaf(node)) return null
  return pathOf(node.first, ids, [...path, 'first']) || pathOf(node.second, ids, [...path, 'second'])
}

export function nodeAt(node: Tree | null, path: Side[]): Tree | null {
  let current = node
  for (const step of path) {
    if (!current || layout.isLeaf(current)) return null
    current = current[step]
  }
  return current
}

function replaceAt(node: Tree, path: Side[], next: Tree): Tree {
  if (path.length === 0 || layout.isLeaf(node)) return next
  const [step, ...rest] = path as [Side, ...Side[]]
  return { ...node, [step]: replaceAt(node[step], rest, next) }
}

// 데몬 트리 + 미리보기 잎. anchor 칸이 없으면(pane 이 닫혔거나 다른 탭) 트리 전체 옆에 같은 방향 · 비율로
export function composeTree(tree: Tree | null, spot: Spot): Tree {
  const preview = layout.leaf(PREVIEW_ID)
  if (!tree) return preview
  const path = pathOf(tree, spot.anchor) || []
  const anchor = nodeAt(tree, path) as Tree
  const branch: Tree = { split: spot.split, ratio: spot.ratio, first: spot.previewFirst ? preview : anchor, second: spot.previewFirst ? anchor : preview }
  return replaceAt(tree, path, branch)
}

// 합친 트리에서 미리보기 잎의 부모 가지 길. 미리보기가 없거나 뿌리 잎이면 null
export function previewBranchPath(node: Tree | null, path: Side[] = []): Side[] | null {
  if (!node || layout.isLeaf(node)) return null
  if ((layout.isLeaf(node.first) && node.first.pane === PREVIEW_ID) || (layout.isLeaf(node.second) && node.second.pane === PREVIEW_ID)) return path
  return previewBranchPath(node.first, [...path, 'first']) || previewBranchPath(node.second, [...path, 'second'])
}

// 합친 트리 → 데몬 트리 + 미리보기 자리. 미리보기가 혼자(뿌리 잎)면 자리는 기본값
export function splitTree(composite: Tree): { tree: Tree | null; spot: Spot } {
  const tree = layout.removePane(composite, PREVIEW_ID)
  const path = previewBranchPath(composite)
  const branch = path && nodeAt(composite, path)
  if (!branch || layout.isLeaf(branch)) return { tree, spot: defaultSpot(tree) }
  const previewFirst = layout.isLeaf(branch.first) && branch.first.pane === PREVIEW_ID
  const anchor = previewFirst ? branch.second : branch.first
  return { tree, spot: { anchor: layout.paneIds(anchor), split: branch.split, previewFirst, ratio: branch.ratio } }
}

// 합친 트리의 경계 길 → 데몬 트리의 같은 경계 길(pane 번호 묶음으로 찾는다). 미리보기 가지의 경계면 null
export function daemonPath(composite: Tree, path: Side[]): Side[] | null {
  const branch = nodeAt(composite, path)
  if (!branch || layout.isLeaf(branch)) return null
  const own = previewBranchPath(composite)
  if (own && own.join('.') === path.join('.')) return null
  // 미리보기를 품은 위 가지는 미리보기를 빼면 데몬의 같은 가지다
  const ids = layout.paneIds(branch).filter((id) => id !== PREVIEW_ID)
  return pathOf(layout.removePane(composite, PREVIEW_ID), ids)
}

// 비율 뺀 모양 — 같은 배치인지 비교할 때
const shapeOf = (tree: Tree | null): string => JSON.stringify(tree, (key, value) => (key === 'ratio' ? undefined : value))

// 합친 트리에서 paneId 를 target 의 side 쪽으로 옮긴 결과 — 새 미리보기 자리와 데몬에 보낼 옮기기(없으면 화면만 바뀜).
// 데몬은 pane 을 pane 옆으로만 옮길 수 있다 — 결과 데몬 트리를 그 한 번으로 만들 수 없으면 null(놓을 수 없는 자리)
export type PreviewMove = { spot: Spot; daemonMove: { target: string; side: DropSide } | null }

export function moveWithPreview(tree: Tree | null, spot: Spot, paneId: string, targetId: string, side: DropSide): PreviewMove | null {
  const moved = layout.movePane(composeTree(tree, spot), paneId, targetId, side)
  if (!moved) return null
  const result = splitTree(moved)
  if (shapeOf(result.tree) === shapeOf(tree)) return { spot: result.spot, daemonMove: null }
  if (paneId === PREVIEW_ID) return null
  // 탭 하나의 pane 은 몇 개뿐이라 모든 자리를 대 본다
  const want = shapeOf(result.tree)
  for (const candidate of layout.paneIds(tree)) {
    for (const candidateSide of ['left', 'right', 'up', 'down'] as const) {
      if (shapeOf(layout.movePane(tree, paneId, candidate, candidateSide)) === want) return { spot: result.spot, daemonMove: { target: candidate, side: candidateSide } }
    }
  }
  return null
}
