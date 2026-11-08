// pane 머리줄 끌어 옮기기 — 같은 탭 안 다른 pane 의 위 · 아래 · 왼쪽 · 오른쪽에 끼워 넣는다. 트리 계산은 StudioLayout, 저장은 데몬(pane move)
// 놓으면 트리만 바뀌고 pane 요소 · xterm · pty 는 그대로다 — layoutPanes 가 자리만 옮긴다.
// 파일 미리보기 칸도 같은 끌기로 옮긴다(paneId = PREVIEW_ID) — 배치는 미리보기까지 합친 트리로 재고, 미리보기 자리는 화면이 · 터미널 자리는 데몬이 바꾼다(moveWithPreview)
import * as StudioLayout from '../lib/layout.mts'
import type { DropSide, Rect, Tree } from '../lib/layout.mts'
import { $, showToast } from './core.ts'
import { PANE_GAP } from './terminal.ts'
import { activeTab } from './tabs.ts'
import * as PreviewLayout from '../lib/preview-layout.mts'
import type { PreviewMove } from '../lib/preview-layout.mts'
import { layoutTree, previewSpot, setPreviewSpot } from './preview-pane.ts'
import { layoutPanes } from './pane-layout.ts'

// tree · area 는 놓을 자리를 잰 그때의 트리 · pane 칸(표시를 결과와 같은 계산으로 그린다)
// move 는 미리보기가 열려 있을 때 놓으면 바뀌는 미리보기 자리 · 데몬 옮기기
type DropTarget = { paneId: string; side: DropSide; tree: Tree; area: Rect; move: PreviewMove | null }
type PaneDrag = { paneId: string; tabId: string; head: HTMLElement; pointerId: number; startX: number; startY: number; x: number; y: number; moving: boolean; finish: () => void }

// 이만큼 움직여야 옮기기로 본다 — 그 전에 놓으면 그냥 누르기
const START_DISTANCE = 4

let drag: PaneDrag | null = null
let preview: HTMLDivElement | null = null

export function startPaneDrag(event: PointerEvent, paneId: string, head: HTMLElement): void {
  // ctrl+누르기는 맥에서 우클릭 · 머리줄의 [상세] 단추는 단추대로
  if (event.button !== 0 || event.ctrlKey || drag || (event.target as Element).closest('button')) return
  const tab = activeTab()
  const ids = tab ? StudioLayout.paneIds(layoutTree(tab)) : []
  if (!tab || ids.length < 2 || !ids.includes(paneId)) return
  // preventDefault 는 하지 않는다 — mousedown 이 그대로 와야 눌렀을 때 포커스가 지금처럼 옮겨 간다.
  // 캡처하면 터미널 · 경계 위로 지나가도 이벤트는 머리줄로만 온다(xterm 의 마우스 보고로 새지 않는다)
  head.setPointerCapture(event.pointerId)
  const { pointerId } = event
  const move = (moveEvent: PointerEvent) => {
    if (!drag || moveEvent.pointerId !== pointerId) return
    drag.x = moveEvent.clientX
    drag.y = moveEvent.clientY
    if (!drag.moving) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < START_DISTANCE) return
      drag.moving = true
      document.body.classList.add('pane-dragging')
      window.addEventListener('keydown', onKey, true)
    }
    renderPreview()
  }
  const up = (upEvent: PointerEvent) => {
    if (!drag || upEvent.pointerId !== pointerId) return
    const paneToMove = drag.paneId
    const target = drag.moving ? dropTarget(upEvent.clientX, upEvent.clientY) : null
    cancelPaneDrag()
    if (target) void commitMove(paneToMove, target)
  }
  const lost = (lostEvent: PointerEvent) => {
    if (lostEvent.pointerId === pointerId) cancelPaneDrag()
  }
  head.addEventListener('pointermove', move)
  head.addEventListener('pointerup', up)
  head.addEventListener('pointercancel', lost)
  head.addEventListener('lostpointercapture', lost)
  drag = {
    paneId,
    tabId: tab.id,
    head,
    pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    moving: false,
    finish: () => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', up)
      head.removeEventListener('pointercancel', lost)
      head.removeEventListener('lostpointercapture', lost)
    },
  }
}

// 아무것도 바꾸지 않고 끝낸다. 캡처는 일부러 놓지 않는다 — Esc 뒤 아직 누른 채면 놓을 때까지 터미널이 마우스를 받지 않게(놓으면 저절로 풀린다)
function cancelPaneDrag(): void {
  if (!drag) return
  drag.finish()
  drag = null
  document.body.classList.remove('pane-dragging')
  window.removeEventListener('keydown', onKey, true)
  if (preview) preview.hidden = true
}

// 터미널이 포커스를 갖고 있어도 Esc 가 안 프로그램으로 가지 않게 먼저 받는다
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopImmediatePropagation()
  cancelPaneDrag()
}

// 끄는 중에 배치가 바뀌면 — 탭이 바뀌었거나 끄는 pane 이 없어졌거나 혼자 남으면 취소, 아니면 놓을 자리를 다시 잰다(layoutPanes 가 부른다)
export function syncPaneDrag(tab: ScreenTab | null): void {
  if (!drag) return
  const ids = tab && tab.id === drag.tabId ? StudioLayout.paneIds(layoutTree(tab)) : []
  if (ids.length < 2 || !ids.includes(drag.paneId)) return cancelPaneDrag()
  if (drag.moving) renderPreview()
}

// 포인터 아래 놓을 자리 — 자기 자신 · 탭 밖 · pane 사이 틈이면 null
function dropTarget(clientX: number, clientY: number): DropTarget | null {
  const tab = activeTab()
  const tree = tab && drag && tab.id === drag.tabId ? layoutTree(tab) : null
  if (!tab || !tree || !drag) return null
  const container = $('panes')
  // 옆 브라우저처럼 pane 칸을 덮은 곳은 탭 밖으로 본다 — 가려진 pane 에 보이지 않는 표시로 놓이지 않게
  const under = document.elementFromPoint(clientX, clientY)
  if (!under || !container.contains(under)) return null
  const origin = container.getBoundingClientRect()
  const x = clientX - origin.left
  const y = clientY - origin.top
  const area = { x: 0, y: 0, width: container.clientWidth, height: container.clientHeight }
  const rects = StudioLayout.computeRects(tree, area, PANE_GAP)
  const paneId = StudioLayout.paneAt(rects, x, y)
  if (!paneId || paneId === drag.paneId) return null
  const side = StudioLayout.dropSide(rects[paneId] as Rect, x, y)
  // 미리보기가 열려 있으면 — 데몬이 pane 옆 옮기기 한 번으로 못 만드는 자리는 놓을 수 없다(표시도 안 한다)
  const move = previewSpot ? PreviewLayout.moveWithPreview(tab.tree, previewSpot, drag.paneId, paneId, side) : null
  if (previewSpot && !move) return null
  return { paneId, side, tree, area, move }
}

function renderPreview(): void {
  if (!drag) return
  const target = dropTarget(drag.x, drag.y)
  if (!preview) {
    preview = document.createElement('div')
    preview.className = 'pane-drop-preview'
    $('panes').append(preview)
  }
  // 표시 = 놓았을 때 끄는 pane 의 자리 — 옮긴 트리를 실제 배치(computeRects)로 재서 형제에 놓아도 결과와 같다
  const moved = target && StudioLayout.movePane(target.tree, drag.paneId, target.paneId, target.side)
  const area = moved && StudioLayout.computeRects(moved, target.area, PANE_GAP)[drag.paneId]
  preview.hidden = !area
  if (!area) return
  Object.assign(preview.style, { left: `${area.x}px`, top: `${area.y}px`, width: `${area.width}px`, height: `${area.height}px` })
}

// 화면은 데몬이 알리는 새 상태로 다시 그린다
// 미리보기가 열려 있으면 미리보기 자리는 화면이 바로 바꾸고, 터미널 자리가 바뀔 때만 데몬에 옮기기를 보낸다(데몬이 된 뒤 미리보기 자리를 맞춘다)
async function commitMove(paneId: string, target: DropTarget): Promise<void> {
  const { move } = target
  if (move && !move.daemonMove) {
    setPreviewSpot(move.spot)
    return layoutPanes()
  }
  const daemonMove = move ? move.daemonMove! : { target: target.paneId, side: target.side }
  const result = await studio.paneMove(paneId, daemonMove.target, daemonMove.side)
  if (result.error) return showToast(result.error)
  if (move && previewSpot) {
    setPreviewSpot(move.spot)
    layoutPanes()
  }
}
