// 칸 크기 끌기 — 왼쪽 작업 공간 너비 · 오른쪽 Explorer(옆 브라우저가 열려 있으면 웹) 너비 · 아래 에이전트 모니터 높이
// 손잡이를 끌면 바뀌고 · 놓으면 localStorage 에 기억 · 더블클릭하면 기본 크기.
// 크기는 CSS 변수(--spaces-width · --side-width · --dock-height)로 넘긴다 — 접힘(.collapsed) 규칙이 그대로 이긴다.
// pane(터미널) 크기는 #panes · #dock 의 ResizeObserver → layoutPanes 가 다시 맞춘다(main.ts)
import { $ } from './core.ts'
import { browserOpen, hideBrowserView, placeBrowserView } from './browser.ts'

type Edge = {
  handle: HTMLElement
  target: HTMLElement
  axis: 'x' | 'y'
  sign: 1 | -1 // 손잡이를 오른쪽(아래)으로 끌 때 크기가 커지면 1
  cssVar: string
  storageKey: string
  defaultSize: () => number // style.css 의 var() 기본값과 같게
  min: number
  max: number
  room: () => number // 지금 창에서 줄 수 있는 가장 큰 크기
  when?: () => boolean // 손잡이 하나를 칸 둘이 나눠 쓸 때 — 지금 이 칸 차례인지(오른쪽 손잡이: Explorer · 옆 브라우저)
  varTarget?: HTMLElement // 크기 변수를 걸 곳(없으면 target) — 옆 브라우저는 main 에 걸어 화면 칸(.panel)도 같은 값으로 비운다
}

// 가운데(pane 칸)에 이만큼은 남긴다 — 창을 줄여도
const CENTER_MIN_WIDTH = 320
const CENTER_MIN_HEIGHT = 200 // 가운데 탭 줄 + pane 칸

const edges: Edge[] = []

// #work 너비에서 가운데 최소 폭과 자기 · 가운데를 뺀 다른 칸(팩 줄 · 반대쪽 칸 · 접힌 줄)을 뺀 나머지.
// 옆 브라우저는 #work 밖(main 오른쪽)이고 열리면 #work 가 그만큼 좁아지니, 옆 브라우저 자신은 main 너비에서 잰다.
// 열려 있는 동안 Explorer · 접힌 줄은 숨어 폭이 0 이라 서로를 빼지 않는다(한 번에 하나만 보인다)
function widthRoom(self: HTMLElement): number {
  const work = $('work')
  const total = self === $('browser') ? (work.parentElement as HTMLElement).clientWidth : work.clientWidth
  let others = 0
  for (const child of work.children) {
    if (child === self || child.classList.contains('center')) continue
    others += (child as HTMLElement).getBoundingClientRect().width
  }
  return total - CENTER_MIN_WIDTH - others
}

function heightRoom(): number {
  const center = document.querySelector<HTMLElement>('#work .center')
  return center ? center.clientHeight - CENTER_MIN_HEIGHT : 0
}

function clampSize(edge: Edge, size: number): number {
  const upper = Math.max(edge.min, Math.min(edge.max, edge.room()))
  return Math.round(Math.min(Math.max(size, edge.min), upper))
}

function savedSize(edge: Edge): number {
  const saved = Number(localStorage.getItem(edge.storageKey))
  return saved > 0 ? saved : 0
}

// 기억한 크기(없으면 기본)를 지금 창에 맞춰 입힌다 — 기본 크기가 그대로 들어가면 변수를 지워 CSS 기본값을 쓴다
function applySize(edge: Edge): void {
  const saved = savedSize(edge)
  const size = clampSize(edge, saved || edge.defaultSize())
  const host = edge.varTarget ?? edge.target
  if (!saved && size === edge.defaultSize()) host.style.removeProperty(edge.cssVar)
  else host.style.setProperty(edge.cssVar, `${size}px`)
}

// 창 크기 · 접기가 바뀐 뒤 — 최소 · 최대 안으로 다시 맞춘다
export function fitEdgeSizes(): void {
  for (const edge of edges) applySize(edge)
}

function bindEdge(edge: Edge): void {
  edges.push(edge)
  const { handle, target, axis } = edge
  let drag: { pointerId: number; start: number; startSize: number } | null = null
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || (edge.when && !edge.when())) return
    const rect = target.getBoundingClientRect()
    drag = { pointerId: event.pointerId, start: axis === 'x' ? event.clientX : event.clientY, startSize: axis === 'x' ? rect.width : rect.height }
    handle.setPointerCapture(event.pointerId)
    document.body.classList.add(axis === 'x' ? 'edge-resizing-x' : 'edge-resizing-y')
    handle.classList.add('dragging')
    // 끄는 동안은 옆 브라우저 페이지(화면 위에 떠 있는 뷰)를 떼어 둔다 — 마우스가 페이지 위로 지나가도 끌기가 이어지게
    if (browserOpen) hideBrowserView()
    event.preventDefault()
  })
  handle.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const moved = (axis === 'x' ? event.clientX : event.clientY) - drag.start
    const host = edge.varTarget ?? target
    host.style.setProperty(edge.cssVar, `${clampSize(edge, drag.startSize + edge.sign * moved)}px`)
  })
  // 놓기 · 취소 · 캡처를 잃음 모두 여기로 — 끈 크기를 기억한다
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag = null
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    document.body.classList.remove('edge-resizing-x', 'edge-resizing-y')
    handle.classList.remove('dragging')
    const rect = target.getBoundingClientRect()
    localStorage.setItem(edge.storageKey, String(clampSize(edge, axis === 'x' ? rect.width : rect.height)))
    applySize(edge)
    if (browserOpen) placeBrowserView()
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('lostpointercapture', finish)
  handle.addEventListener('dblclick', () => {
    if (edge.when && !edge.when()) return
    localStorage.removeItem(edge.storageKey)
    applySize(edge)
    if (browserOpen) requestAnimationFrame(placeBrowserView)
  })
}

export function initEdgeResize(): void {
  bindEdge({
    handle: $('spaces-resize'),
    target: $('spaces'),
    axis: 'x',
    sign: 1,
    cssVar: '--spaces-width',
    storageKey: 'studio.spacesWidth',
    defaultSize: () => 224,
    min: 160,
    max: 480,
    room: () => widthRoom($('spaces')),
  })
  bindEdge({
    handle: $('side-resize'),
    target: $('side-panel'),
    axis: 'x',
    sign: -1,
    cssVar: '--side-width',
    storageKey: 'studio.panelWidth',
    defaultSize: () => 248,
    min: 180,
    max: 560,
    room: () => widthRoom($('side-panel')),
    when: () => !browserOpen,
  })
  // 옆 브라우저가 열려 있으면 같은 손잡이가 웹 너비를 끈다 — 기본은 main 폭의 46%(style.css .browser), 최대는 가운데 최소 폭까지.
  // 변수는 main 에 — #browser 너비와 화면 칸(.panel)의 오른쪽 비움이 같은 값을 읽는다
  bindEdge({
    handle: $('side-resize'),
    target: $('browser'),
    varTarget: $('work').parentElement as HTMLElement,
    axis: 'x',
    sign: -1,
    cssVar: '--browser-width',
    storageKey: 'studio.browserWidth',
    defaultSize: () => Math.round(($('work').parentElement as HTMLElement).clientWidth * 0.46),
    min: 320,
    max: Infinity,
    room: () => widthRoom($('browser')),
    when: () => browserOpen,
  })
  bindEdge({
    handle: $('dock-resize'),
    target: $('dock'),
    axis: 'y',
    sign: -1,
    cssVar: '--dock-height',
    storageKey: 'studio.monitorHeight',
    defaultSize: () => 170,
    min: 80,
    max: 560,
    room: heightRoom,
  })
  fitEdgeSizes()
  window.addEventListener('resize', fitEdgeSizes)
}
