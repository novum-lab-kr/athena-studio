// pane 경계(분할선) — 그리기 · 끌어 비율 바꾸기 · 두 번 눌러 반으로 · 데몬에 저장(옛 데몬이면 임시로) · 탭 전체 크기 알리기
// renderer.js 에서 옮김(R3b · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 배치(layoutPanes)는 pane-layout.ts
import * as StudioLayout from '../lib/layout.mts'
import type { Area, Divider, Tree } from '../lib/layout.mts'
import { $, say, showToast } from './core.ts'
import { PANE_GAP } from './terminal.ts'
import { estimateCells, screen } from './screen.ts'
import { activeTab } from './tabs.ts'
import { layoutPanes } from './pane-layout.ts'

// 경계 요소 — element.divider 가 지금 경계
type DividerElement = HTMLDivElement & { divider?: Divider }
type DividerDrag = { tabId: string; shape: string; element: DividerElement; pointerId: number; ratio: number | null; cancel: () => void }

// ── pane 경계 끌기 ───────────────────────────────────────
// 비율은 데몬 탭 트리에 저장한다(tab ratio). 끄는 동안과, 옛 데몬이 그 동작을 모를 때는 화면이 임시로 기억한다(ratioOverrides).
// 임시 비율은 트리 모양(비율 뺀)이 같을 때만 쓴다 — 나누거나 닫아 모양이 바뀌면 버린다
const ratioOverrides = new Map<string, { ratio: number; shape: string }>() // `${tabId}|${path}` → { ratio, shape }
let dividerDrag: DividerDrag | null = null // { tabId, shape, element, pointerId, ratio, cancel }
let ratioUnsupportedNoticed = false
let lastTabSize: ({ tab: string } & CellSize) | null = null

const treeShape = (tree: Tree | null): string => JSON.stringify(tree, (key, value) => (key === 'ratio' ? undefined : value))

export function treeForLayout(tab: ScreenTab): Tree | null {
  let tree = tab.tree
  const shape = treeShape(tab.tree)
  for (const [key, override] of ratioOverrides) {
    const [tabId, path] = key.split('|') as [string, string]
    if (tabId !== tab.id) continue
    if (override.shape !== shape) {
      ratioOverrides.delete(key)
      continue
    }
    tree = StudioLayout.setRatio(tree, path ? path.split('.') : [], override.ratio) || tree
  }
  return tree
}

// 경계 요소는 경로마다 하나를 계속 쓴다(새로 만들면 더블클릭 · 끌기 중 포인터 캡처가 끊긴다)
const dividerElements = new Map<string, DividerElement>() // path → element(element.divider 가 지금 경계)

export function renderDividers(tab: ScreenTab | null, tree: Tree | null, area: Area): void {
  const container = $('panes')
  // 닫힌 탭의 임시 비율은 버린다
  const tabIds = new Set(screen.tabs.map((entry) => entry.id))
  for (const key of ratioOverrides.keys()) if (!tabIds.has(key.split('|')[0] as string)) ratioOverrides.delete(key)
  // 끄는 중에 탭이 바뀌었거나 pane 이 생기고 닫혀 트리 모양이 바뀌면 끌기를 취소한다(다른 경계에 저장되지 않게)
  if (dividerDrag && (!tab || tab.id !== dividerDrag.tabId || treeShape(tab.tree) !== dividerDrag.shape)) cancelDividerDrag()
  const found = tab && tree ? StudioLayout.dividers(tree, area, PANE_GAP) : []
  const alive = new Set<string>()
  for (const divider of found) {
    const key = divider.path.join('.')
    alive.add(key)
    let element = dividerElements.get(key)
    if (!element) {
      element = document.createElement('div') as DividerElement
      element.title = say('pane.resizeHint')
      element.addEventListener('pointerdown', (event) => startDividerDrag(event, element!))
      element.addEventListener('dblclick', () => {
        const current = activeTab()
        if (current && element!.divider) commitRatio(current, element!.divider.path, StudioLayout.DEFAULT_RATIO)
      })
      dividerElements.set(key, element)
      container.append(element)
    }
    element.className = `pane-divider ${divider.split}${dividerDrag && dividerDrag.element === element ? ' dragging' : ''}`
    element.divider = divider
    placeDivider(element, divider)
  }
  for (const [key, element] of dividerElements) {
    if (alive.has(key)) continue
    element.remove()
    dividerElements.delete(key)
  }
}

// 잡기 쉽게 gap 양옆으로 3px 씩 넓힌다
function placeDivider(element: DividerElement, divider: Divider): void {
  const { line } = divider
  const grab = 3
  const box = divider.split === 'right'
    ? { left: line.x - grab, top: line.y, width: line.width + grab * 2, height: line.height }
    : { left: line.x, top: line.y - grab, width: line.width, height: line.height + grab * 2 }
  Object.assign(element.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
}

function startDividerDrag(event: PointerEvent, element: DividerElement): void {
  const tab = activeTab()
  if (event.button !== 0 || !tab || !element.divider || dividerDrag) return
  event.preventDefault()
  element.setPointerCapture(event.pointerId)
  element.classList.add('dragging')
  const path = element.divider.path
  const key = `${tab.id}|${path.join('.')}`
  const shape = treeShape(tab.tree)
  let frame = 0
  const move = (moveEvent: PointerEvent) => {
    if (!dividerDrag || moveEvent.pointerId !== dividerDrag.pointerId) return
    const origin = $('panes').getBoundingClientRect()
    const divider = element.divider as Divider
    const pos = divider.split === 'right' ? moveEvent.clientX - origin.left : moveEvent.clientY - origin.top
    dividerDrag.ratio = StudioLayout.ratioAt(divider, pos, PANE_GAP)
    ratioOverrides.set(key, { ratio: dividerDrag.ratio, shape })
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      layoutPanes()
    })
  }
  const abort = (cancelEvent: PointerEvent) => {
    if (dividerDrag && dividerDrag.element === element && cancelEvent.pointerId === dividerDrag.pointerId) cancelDividerDrag()
    layoutPanes()
  }
  const detach = () => {
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', finish)
    element.removeEventListener('pointercancel', abort)
    element.removeEventListener('lostpointercapture', abort)
    if (frame) cancelAnimationFrame(frame)
    element.classList.remove('dragging')
  }
  // 같은 포인터를 놓았을 때만 저장 — 취소 · 캡처를 잃음은 저장 없이 원래대로
  const finish = (upEvent: PointerEvent) => {
    if (!dividerDrag || dividerDrag.element !== element || upEvent.pointerId !== dividerDrag.pointerId) return
    const { ratio } = dividerDrag
    dividerDrag = null
    detach()
    if (ratio === null) return layoutPanes()
    commitRatio(tab, path, ratio)
  }
  dividerDrag = {
    tabId: tab.id,
    shape,
    element,
    pointerId: event.pointerId,
    ratio: null,
    // 취소 — 임시 비율을 버리고 원래대로(저장하지 않는다)
    cancel: () => {
      dividerDrag = null
      detach()
      ratioOverrides.delete(key)
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    },
  }
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', finish)
  element.addEventListener('pointercancel', abort)
  element.addEventListener('lostpointercapture', abort)
}

function cancelDividerDrag(): void {
  if (dividerDrag) dividerDrag.cancel()
}

// 데몬에 저장 — 되면 임시 비율을 지우고(데몬 상태에 들어 있다), 옛 데몬이면 임시로 두고 한 번 알린다
async function commitRatio(tab: ScreenTab, path: Divider['path'], ratio: number): Promise<void> {
  const key = `${tab.id}|${path.join('.')}`
  ratioOverrides.set(key, { ratio, shape: treeShape(tab.tree) })
  layoutPanes()
  const result = await studio.tabRatio(tab.id, path, ratio)
  if (result.unsupported) {
    if (!ratioUnsupportedNoticed) showToast(say('pane.sizeOldDaemon'), 'info')
    ratioUnsupportedNoticed = true
    return
  }
  if (result.error) {
    ratioOverrides.delete(key)
    showToast(say('pane.sizeSaveFailed', { message: result.error }))
  } else if (ratioOverrides.get(key) && ratioOverrides.get(key)!.ratio === ratio) {
    ratioOverrides.delete(key)
  }
  layoutPanes()
}

// 탭 전체 크기(칸) — 앱이 없을 때 CLI 로 나눠도 데몬이 크기를 맞게 나누도록
export function reportTabSize(tab: ScreenTab | null, container: HTMLElement): void {
  const size = estimateCells(container)
  if (!tab || !size) return
  if (lastTabSize && lastTabSize.tab === tab.id && lastTabSize.cols === size.cols && lastTabSize.rows === size.rows) return
  lastTabSize = { tab: tab.id, ...size }
  studio.tabSize(tab.id, size)
}
