// pane 배치 — 분할 트리를 픽셀 사각형으로 · 크기 요청(pane 마다 하나씩) · 크기를 바꾸는 동안 옛 화면 덮기 · 지금 pane 으로 포커스 · 에이전트 모니터 칸 껍데기
// renderer.js 에서 옮김(R3b · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 경계(분할선)는 dividers.ts
import * as StudioLayout from '../lib/layout.mts'
import { $, currentTab, panels } from './core.ts'
import { PANE_GAP, redrawAfterHidden, views } from './terminal.ts'
import type { PaneView } from './terminal.ts'
import { screen } from './screen.ts'
import { activeTab, activeWorkspace, renamingTab } from './tabs.ts'
import { renderDividers, reportTabSize, treeForLayout } from './dividers.ts'
import { StudioUi } from './ui/index.ts'
import { browserOpen } from './browser.ts'
import { syncDetailButton } from './detail.ts'
import { spaceColor } from './renderer.js'

// 크기를 비교할 pane 메타 — 데몬 상태의 pane(없으면 빈 것 · 답이 늦어 다시 볼 때는 null)
type PaneSizeInfo = { cols?: number; rows?: number } | null | undefined

// 트리 → 픽셀 사각형. 보이는 pane 만 fit 하고, 칸 수가 바뀐 것만 데몬에 알린다
export function layoutPanes(): void {
  if (panels.work.hidden) return
  // 하단 칸(에이전트 모니터)은 작업 공간이 있으면 어느 공간이든 — 공간이 없으면 그 높이만큼 pane 이 길어진다. 높이를 재기 전에 정한다
  const showDock = Boolean(activeWorkspace())
  $('dock').hidden = !showDock
  if (!showDock && $('dock').contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
  setMonitorVisible(showDock)
  const container = $('panes')
  const tab = activeTab()
  const tree = tab ? treeForLayout(tab) : null
  const area = { x: 0, y: 0, width: container.clientWidth, height: container.clientHeight }
  const rects = tree ? StudioLayout.computeRects(tree, area, PANE_GAP) : {}
  renderDividers(tab, tree, area)
  const meta = new Map(screen.panes.map((pane) => [pane.id, pane]))
  for (const [paneId, view] of views) {
    const rect = rects[paneId]
    view.el.hidden = !rect
    if (view.el.hidden) {
      view.shown = false
      continue
    }
    if (rect) Object.assign(view.el.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    view.el.classList.toggle('focused', paneId === screen.focused)
    const info: Partial<ScreenPane> = meta.get(paneId) || {}
    view.headLabel.textContent = info.label || info.title || paneId
    syncDetailButton(paneId, view)
    if (!view.shown) redrawAfterHidden(view)
    view.shown = true
    // 크기는 재기만 하고 xterm 은 데몬이 pty · 화면 버퍼에 적용했다고 답할 때(pane:resized) 바꾼다.
    // 여기서 먼저 바꾸면 그 사이 출력이 이 창과 데몬 버퍼에서 다른 폭으로 그려져 갈라진다 — Claude Code 가 다시 그릴 때 엉뚱한 줄을 지워 화면이 겹친다
    let size: CellSize | undefined | null = null
    try {
      size = view.fit.proposeDimensions()
    } catch {}
    if (!size || !(size.cols > 1) || !(size.rows > 1)) continue
    // 경계를 끄는 동안 · 창 크기를 바꾸는 동안에도 보낸다 — 한 pane 에 하나씩만 날아가고 답이 오면 그 사이 바뀐 최신 크기만 이어서(sendPaneSize)
    view.want = { cols: size.cols, rows: size.rows }
    sendPaneSize(paneId, view, info)
  }
  reportTabSize(tab, container)
  if (!renamingTab) focusCurrentTerminal() // 탭 이름을 고치는 중이면 글자 칸 포커스를 뺏지 않는다
}

// 크기 요청은 pane 마다 하나만 날아간다 — 답(pane:resized)이 오기 전에 바뀐 크기는 view.want 에 최신 것만 남기고 중간 크기는 건너뛴다.
// 그래서 끄는 동안에도 xterm 은 데몬이 적용한 크기로만, 보낸 순서대로 바뀌고(갈라짐 없음) 셸 · Claude Code 는 왕복 한 번에 한 번만 다시 그린다.
// 답이 끝내 안 오면(데몬이 거절 · 끊김) 이만큼 뒤에 막힘을 풀고 최신 크기를 다시 본다
const RESIZE_REPLY_TIMEOUT_MS = 1000

export function sendPaneSize(paneId: string, view: PaneView, info: PaneSizeInfo): void {
  const want = view.want
  // 날아간 요청이 있거나 앞 크기의 다시 그리기를 기다리는 중(holdForRedraw)이면 나중에 — 답 · releaseHold 가 최신 크기로 다시 부른다
  if (!want || view.resizing || view.hold) return
  // 데몬이 스스로 바꾼 크기(분할 · pane 종료 때 탭 크기로 어림한 fitTab — pane 머리 줄을 빼지 않아 몇 줄 크다)도 다시 맞춘다
  const drifted = Boolean(info) && info!.cols! > 1 && (info!.cols !== want.cols || info!.rows !== want.rows)
  if (view.sent && view.sent.cols === want.cols && view.sent.rows === want.rows && !drifted) return
  view.sent = { cols: want.cols, rows: want.rows }
  view.resizing = setTimeout(() => {
    if (views.get(paneId) !== view) return
    view.resizing = null
    // 답을 못 받은 크기는 적용됐는지 모른다 — 보낸 기록을 지워 지금 크기를 다시 보낸다(같은 크기여도)
    view.sent = null
    sendPaneSize(paneId, view, null)
  }, RESIZE_REPLY_TIMEOUT_MS)
  studio.paneResize(paneId, want.cols, want.rows)
}

// 크기를 바꾼 뒤 안 프로그램이 다시 그린 출력을 다 받을 때까지 마지막으로 그린 화면을 그대로 보여 준다 — 그 화면(.xterm-screen)을 복제해 위에 덮고, 출력이 조용해지면 걷는다.
// 안 덮으면 다시 그리기(Claude Code 는 크기마다 화면을 지우고(2J) 다 다시 그린다)가 두 조각으로 올 때 반쪽만 그린 프레임이 끼어 덜컹거린다.
// 동기 출력(DEC 2026)으로는 못 막는다 — xterm DOM 렌더러가 resize · 선택 영역 다시 그리기 때는 그 모드를 거치지 않고 바로 그린다(xterm 6.0 실측). 복제는 DOM 렌더러라서 된다.
// 다음 크기는 걷은 뒤에 보낸다(releaseHold) — 다시 그리는 도중에 다음 크기가 오면 걷는 순간 그 반쪽이 보인다. 그래서 끄는 동안 크기는 다시 그리기 한 번에 한 번씩 간다
// 출력이 이만큼 조용하면 걷는다 — 다시 그리기 조각 사이 간격 실측 p90 13~21ms · 최대 24ms(main 이 출력을 8ms 마다 묶어 보낸다)
const RESIZE_HOLD_QUIET_MS = 24
// 출력이 이어지거나(셸이 계속 찍음) 아무 출력이 없어도 크기를 적용하고 이만큼 지나면 걷는다 — 크기 → 첫 출력 실측 최대 24ms(계속 찍는 셸 48ms)
const RESIZE_HOLD_MAX_MS = 60

// 크기를 적용하기 직전에 부른다 — 덮었으면 true(다음 크기는 releaseHold 가 보낸다)
export function holdForRedraw(paneId: string, view: PaneView): boolean {
  if (!view.hold) {
    const live = view.term.element && view.term.element.querySelector('.xterm-screen')
    if (!live) return false
    // 복제한 화면을 칸 전체를 덮는 틀에 넣는다 — 글을 아래에 붙인 화면(screen-bottom)이면 틀 아래에 붙여서 덮는 순간 · 걷는 순간 위아래로 안 튄다
    const still = document.createElement('div')
    still.className = 'pane-still'
    still.style.background = view.term.options.theme!.background as string
    still.append(live.cloneNode(true))
    view.term.element!.append(still)
    view.hold = { still }
  }
  // 덮은 중에 또 크기가 오면(답이 늦어 다시 보낸 것 등) 걷으려던 것을 멈추고 이번 크기부터 다시 센다
  view.hold.releasing = false
  clearTimeout(view.hold.timer)
  view.hold.start = performance.now()
  view.hold.timer = setTimeout(() => releaseHold(paneId, view), RESIZE_HOLD_MAX_MS)
  return true
}

export function holdOutputArrived(paneId: string, view: PaneView): void {
  clearTimeout(view.hold!.timer)
  const left = RESIZE_HOLD_MAX_MS - (performance.now() - (view.hold!.start as number))
  view.hold!.timer = setTimeout(() => releaseHold(paneId, view), Math.max(0, Math.min(RESIZE_HOLD_QUIET_MS, left)))
}

function releaseHold(paneId: string, view: PaneView): void {
  const hold = view.hold
  if (!hold || hold.releasing) return
  clearTimeout(hold.timer)
  hold.releasing = true
  // 받은 출력을 다 읽고 xterm 이 그린 뒤에 걷는다 — 읽는 중에 xterm 이 먼저 요청한 프레임 콜백이 이것보다 먼저 돈다.
  // 걷을 때까지 view.hold 를 남겨 두어 그 사이 크기를 보내지 않는다. 걷고 나서 기다리는 사이 바뀐 최신 크기를 이어서 보낸다
  view.term.write('', () => requestAnimationFrame(() => {
    if (!hold.releasing || views.get(paneId) !== view) return
    hold.still.remove()
    view.hold = null
    sendPaneSize(paneId, view, screen.panes.find((pane) => pane.id === paneId))
  }))
}

// 지금 pane 의 터미널로 입력을 돌려준다(작업 창이 보이고 옆 브라우저를 쓰지 않을 때)
export function focusCurrentTerminal(): void {
  const focused = views.get(screen.focused as string)
  if (focused && !focused.el.hidden && currentTab === 'work' && !usingBrowser()) focused.term.focus()
}

// 옆 브라우저를 쓰는 중인가 — 주소창에 치는 중이거나 서랍 안 페이지(앱 화면 밖이라 문서가 포커스를 잃는다)를 보는 중이면 터미널로 포커스를 뺏지 않는다
function usingBrowser(): boolean {
  return browserOpen && (!document.hasFocus() || $('browser').contains(document.activeElement))
}

// ── 에이전트 모니터(가운데 맨 아래) ─────────────────────────
// main 이 Claude 기록을 따라 읽어 세션 · 이벤트를 보낸다(보일 때만). 칩 · 로그 그리기는 React(ui/monitor.tsx) — 여기는 껍데기(보이기 · 접기 · 알림 받기 · 타이머)
let monitorVisible: boolean | null = null

function setMonitorVisible(visible: boolean): void {
  if (monitorVisible === visible) return
  monitorVisible = visible
  studio.monitorWatch(visible)
}

export function initMonitor(): void {
  const dock = $('dock')
  dock.classList.toggle('collapsed', localStorage.getItem('studio.monitorCollapsed') === '1')
  $('monitor-fold').addEventListener('click', () => {
    const collapsed = !dock.classList.contains('collapsed')
    dock.classList.toggle('collapsed', collapsed)
    localStorage.setItem('studio.monitorCollapsed', collapsed ? '1' : '0')
  })
  // spaceColor 는 아직 renderer.js(JS) — 추론 타입이 string | undefined 라 캐스트만(R3c 에서 옮기며 타입)
  StudioUi.monitor.mount($('monitor-sessions'), $('monitor-feed'), { spaceColor: spaceColor as (label: string) => string })
  studio.onMonitorUpdate(StudioUi.monitor.update)
  // 'n분 전' 을 새로 쓰고, 조용해진 에이전트의 칩을 뺀다(고른 칩이 빠지면 전체 로그로)
  setInterval(() => {
    if (!monitorVisible) return
    StudioUi.monitor.tick()
  }, 30000)
}
