// 파일 미리보기 칸 — pane 배치 트리의 한 칸으로 다룬다(배치 · 경계 · 끌어 옮기기는 pane 과 같은 코드).
// 데몬 트리에는 넣지 않고 화면이 합친다(src/lib/preview-layout.mts) — 자리(옆 칸 · 방향 · 비율)는 여기만 기억하고 앱을 다시 켜면 닫힌 채다
import * as PreviewLayout from '../lib/preview-layout.mts'
import type { Spot } from '../lib/preview-layout.mts'
import type { Tree } from '../lib/layout.mts'
import { treeForLayout } from './dividers.ts'

export const PREVIEW_ID = PreviewLayout.PREVIEW_ID

// 열려 있으면 자리 · 닫혀 있으면 null
export let previewSpot: Spot | null = null

export function setPreviewSpot(spot: Spot | null): void {
  previewSpot = spot
}

// 배치에 쓰는 트리 — 데몬 트리(임시 비율 포함)에 미리보기가 열려 있으면 그 칸을 합친다
export function layoutTree(tab: ScreenTab | null): Tree | null {
  const tree = tab ? treeForLayout(tab) : null
  return previewSpot ? PreviewLayout.composeTree(tree, previewSpot) : tree
}
