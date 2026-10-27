// 데몬 연결(붙기 · 다시 붙기) · 작업 창 명령(새 탭 · 나누기 · 닫기 · 이동 · 메뉴 단축키) · 아테나 에이전트 켜기 — 그 상태(screen · attached …)
// renderer.js 에서 옮김(R3a · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 다른 묶음이 바꾸는 값은 setX(읽는 쪽은 이름 그대로)
import * as StudioLayout from '../lib/layout.mts'
import { $, currentTab, say, showToast, state } from './core.ts'
import { hidePackProgress, packAlert, showPackProgress } from './pack-dialogs.ts'
import { runPackFlow, welcomeShown } from './pack-switch.ts'
import { HEAD_HEIGHT, disposeView, ensureView, isTabPane, views } from './terminal.ts'
import { StudioUi } from './ui/index.ts'
import type { RestoreResult } from './ui/notices.tsx'
import { activeTab, applyState, ensureSomeTab, offerAddRepo, orderedWorkspaces, setPanelHidden, setSpacesCollapsed, switchTab } from './renderer.js'

export let screen: ScreenState = { workspaces: [], activeWorkspace: null, tabs: [], focused: null, panes: [] }
export const setScreen = (next: ScreenState): void => {
  screen = next
}
export let attached = false
export const setAttached = (next: boolean): void => {
  attached = next
}
export let attaching: Promise<boolean> | null = null
export let reattachOnKey = false
export const setReattachOnKey = (next: boolean): void => {
  reattachOnKey = next
}
export let starting = false // 처음 켤 때는 에이전트 판단(athena 탭)이 끝난 뒤에 본다
export const setStarting = (next: boolean): void => {
  starting = next
}

// 보이는 터미널 하나로 글자 칸 크기를 재서 영역을 칸으로. 아직 없으면 대략(13px 글꼴)
export function estimateCells(container: HTMLElement): CellSize | null {
  const sample = [...views.values()].find((view) => !view.el.hidden && view.term.cols > 1)
  const cellWidth = sample ? sample.term.element!.querySelector('.xterm-screen')!.clientWidth / sample.term.cols : 7.8
  const cellHeight = sample ? sample.term.element!.querySelector('.xterm-screen')!.clientHeight / sample.term.rows : 17
  if (!cellWidth || !cellHeight) return null
  return { cols: Math.max(2, Math.floor(container.clientWidth / cellWidth)), rows: Math.max(2, Math.floor((container.clientHeight - HEAD_HEIGHT) / cellHeight)) }
}

export function focusPane(paneId: string): void {
  if (!views.has(paneId)) return
  screen = { ...screen, focused: paneId }
  studio.paneFocus(paneId)
  for (const [id, view] of views) view.el.classList.toggle('focused', id === paneId)
  StudioUi.spaces.focus(paneId) // 왼쪽 pane 줄 표시(React)
  views.get(paneId)!.term.focus()
}

// 데몬에 붙기 — 상태 + pane 마다 되살릴 화면. 그동안 온 출력은 화면에 이미 들어 있어 버린다
export async function attach(): Promise<boolean> {
  if (attaching) return attaching
  attaching = (async () => {
    const result = await studio.screenAttach()
    if (result.error) {
      StudioUi.notices.showScreenStatus(result.error)
      return false
    }
    for (const paneId of [...views.keys()]) disposeView(paneId)
    // 되살릴 화면은 데몬이 가진 크기로 직렬화됐다 — 그 크기로 먼저 쓰고, 그다음 창에 맞춰 다시 맞춘다(먼저 맞추면 줄이 다른 폭에서 꺾여 깨진다)
    screen = result.state
    for (const pane of screen.panes.filter(isTabPane)) {
      const view = ensureView(pane.id)
      if (pane.cols > 1 && pane.rows > 1) view.term.resize(pane.cols, pane.rows)
      if (result.snapshots[pane.id]) view.term.write(result.snapshots[pane.id]!)
    }
    applyState(result.state)
    attached = true
    reattachOnKey = false
    StudioUi.notices.hideScreenStatus()
    return true
  })().finally(() => (attaching = null))
  return attaching
}

export function reattach(): void {
  reattachOnKey = false
  attach()
}

export async function newTab(): Promise<void> {
  const result = await studio.tabNew(estimateCells($('panes')))
  if (result.error) showToast(say('tab.openFailed', { message: result.error }))
}

async function splitPane(paneId: string, direction: 'right' | 'down'): Promise<void> {
  const result = await studio.paneSplit(paneId, direction)
  if (result.error) showToast(say('pane.splitFailed', { message: result.error }))
}

// pane 우클릭 메뉴(main) — 대상은 포커스된 pane 이 아니라 우클릭한 그 pane
export async function paneMenu(paneId: string, event: MouseEvent): Promise<unknown> {
  if (!state || !state.valid || !attached) return
  const action = await studio.paneContextMenu({ x: Math.round(event.clientX), y: Math.round(event.clientY) })
  if (action === 'split-right' || action === 'split-down') return splitPane(paneId, action === 'split-down' ? 'down' : 'right')
  if (action === 'close-pane') return studio.paneClose(paneId)
}

// 메뉴 단축키(⌘T · ⌘D · ⌘⇧D · ⌘W · ⌘⌥방향 · ⌘⇧[ ]) — Ctrl 은 pane 안으로 간다
export async function runCommand(name: string): Promise<unknown> {
  if (!state || !state.valid || !attached) return
  if (currentTab !== 'work') switchTab('work')
  // 나누기·닫기·이동의 기준은 지금 탭의 pane — 포커스가 탭 밖이면 탭의 첫 pane
  const focused = tabPaneForCommand()
  if (name === 'new-tab') return newTab()
  if (name === 'split-right' || name === 'split-down') {
    if (!focused) return newTab()
    return splitPane(focused, name === 'split-down' ? 'down' : 'right')
  }
  if (name === 'close-pane') {
    if (focused) await studio.paneClose(focused)
    return undefined
  }
  if (name.startsWith('focus-')) {
    const tab = activeTab()
    const container = $('panes')
    const target = tab && focused && StudioLayout.neighbor(tab.tree, { x: 0, y: 0, width: container.clientWidth, height: container.clientHeight }, focused, name.slice(6))
    if (target) focusPane(target)
    return undefined
  }
  if (name === 'tab-prev' || name === 'tab-next') {
    const current = activeTab()
    const tabsHere = screen.tabs.filter((tab) => tab.workspace === screen.activeWorkspace)
    const index = current ? tabsHere.findIndex((tab) => tab.id === current.id) : -1
    if (index < 0) return undefined
    const step = name === 'tab-next' ? 1 : -1
    return studio.tabSelect(tabsHere[(index + step + tabsHere.length) % tabsHere.length]!.id)
  }
  if (name === 'workspace-prev' || name === 'workspace-next') {
    const ordered = orderedWorkspaces()
    const index = ordered.findIndex((workspace) => workspace.id === screen.activeWorkspace)
    if (index < 0) return undefined
    const step = name === 'workspace-next' ? 1 : -1
    return studio.workspaceSelect(ordered[(index + step + ordered.length) % ordered.length]!.id)
  }
  if (name === 'close-tab') {
    const current = activeTab()
    if (current) await studio.tabClose(current.id)
    return undefined
  }
  if (name === 'new-workspace') {
    const result = await studio.workspaceNew(estimateCells($('panes')))
    if (result.askAdd) return runPackFlow(() => offerAddRepo(result as { dir: string; name: string }))
    if (result.error) showToast(say('spaces.createFailed', { message: result.error }))
    return undefined
  }
  if (name === 'toggle-panel') return setPanelHidden(!$('side-panel').hidden)
  if (name === 'toggle-spaces') return setSpacesCollapsed(!$('spaces').classList.contains('collapsed'))
  return undefined
}

function tabPaneForCommand(): string | null {
  const tab = activeTab()
  if (!tab) return null
  const ids = StudioLayout.paneIds(tab.tree)
  return ids.includes(screen.focused as string) ? screen.focused : ids[0] || null
}

export async function startScreen(): Promise<void> {
  starting = true
  try {
    if (!(await attach())) return
    // 시작 화면이 떠 있으면 팩을 고를 때까지 아테나를 켜지 않는다(enterPack 이 켠다)
    if (!welcomeShown()) await openAgent()
  } finally {
    starting = false
  }
  // 에이전트를 못 켰어도 셸 탭 하나는 있게
  ensureSomeTab()
}

// athena 탭에서 아테나 에이전트를 켠다(이미 있으면 그 탭으로) — 묻지 않고 claude, 없으면 깔린 것 중 첫 번째.
// 가져오기에서 [열고 작업 되살리기] 를 골랐으면(restoreArmed) main 이 그 사이에 백업 때 작업을 되살린다 — 진행 표시 · 결과
export let restoreArmed = false
export const setRestoreArmed = (next: boolean): void => {
  restoreArmed = next
}
export async function openAgent(options?: { keepView?: boolean }): Promise<OpenAgentResult> {
  const restoring = restoreArmed
  restoreArmed = false
  if (restoring) showPackProgress(say('pack.restore.progress'), false)
  const result = await studio.openAgent(estimateCells($('panes')), options)
  if (restoring) hidePackProgress()
  if (result.error) showToast(result.error)
  if (result.restore) showRestoreResult(result.restore)
  return result
}

// 되살린 결과 — 다 됐으면 알림 한 줄, 못 한 것이 있으면 항목마다 이유(ui/notices.tsx)
export function showRestoreResult(result: RestoreResult): unknown {
  return StudioUi.notices.showRestoreResult(result, packAlert)
}

