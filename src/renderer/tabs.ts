// 가운데 탭 줄 — 지금 작업 공간 · 탭 고르기 · 데몬 상태 받기(applyState) · 빈 창이면 셸 탭 하나 · 탭 이름 바꾸기 · 작업 창 탭으로 가기(switchTab)
// renderer.js 에서 옮김(R3b · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 바깥은 renamingTab 을 읽기만 한다
import { $, panels, say, setCurrentTab, showToast, state } from './core.ts'
import { disposeView, ensureView, isTabPane, views } from './terminal.ts'
import { newTab, screen, setScreen, starting } from './screen.ts'
import { focusCurrentTerminal, layoutPanes } from './pane-layout.ts'
import { welcomeShown } from './pack-switch.ts'
import { renderSides } from './space-actions.ts'

export function activeWorkspace(): ScreenWorkspace | null {
  return screen.workspaces.find((workspace) => workspace.id === screen.activeWorkspace) || null
}

// 아테나 폴더의 작업 공간인가 — 이름이 athena 이고 지금 아테나 폴더인 것(main 의 core.findAthenaWorkspace 와 같은 규칙).
// 아테나 폴더를 바꿔 예전 폴더의 athena 작업 공간이 남아 있으면 그쪽엔 모니터를 안 보인다.
// 화면은 심볼릭 링크를 못 풀어서 적어 둔 경로 · main 이 푼 경로(athenaRealDir) 둘 중 하나와 글자로 맞춰 본다.
// 폴더가 맞는 것이 하나도 없으면(새 작업 공간을 만들기 전 잠깐 등) 예전처럼 이름만 본다
const trimSlash = (dir: string | null | undefined): string => String(dir || '').replace(/\/+$/, '')

export function isAthenaWorkspace(workspace: ScreenWorkspace | null | undefined): boolean {
  if (!workspace || !state || workspace.label !== state.athenaWorkspace) return false
  const wanted = [state.athenaDir, state.athenaRealDir].filter(Boolean).map(trimSlash)
  const sameFolder = (entry: ScreenWorkspace) => wanted.includes(trimSlash(entry.cwd))
  const anyMatch = screen.workspaces.some((entry) => entry.label === state!.athenaWorkspace && sameFolder(entry))
  return anyMatch ? sameFolder(workspace) : true
}

export function activeTab(): ScreenTab | null {
  const workspace = activeWorkspace()
  return (workspace && screen.tabs.find((tab) => tab.id === workspace.activeTab)) || null
}

// 데몬이 준 상태로 탭 줄 · pane 을 다시 그린다
export function applyState(next: ScreenState): void {
  setScreen(next)
  const alive = new Set(screen.panes.filter(isTabPane).map((pane) => pane.id))
  for (const paneId of [...views.keys()]) if (!alive.has(paneId)) disposeView(paneId)
  for (const pane of screen.panes.filter(isTabPane)) ensureView(pane.id)
  renderTabs()
  renderSides()
  layoutPanes()
  ensureSomeTab()
}

// 탭이 하나도 없으면(마지막 셸을 닫음 · 새 데몬) 아테나 폴더에서 셸 탭 하나
let openingTab = false
export function ensureSomeTab(): void {
  // 시작 화면이 떠 있으면 만들지 않는다 — 고를 때 닫을 pane 이 생겨 확인 창이 뜨지 않게(들어가면 아테나 탭이 생긴다)
  if (screen.tabs.length || openingTab || starting || !state || !state.valid || welcomeShown()) return
  openingTab = true
  newTab().finally(() => (openingTab = false))
}

// 가운데 탭 줄 — 지금 작업 공간의 탭만. ✕ 로 닫는다(에이전트가 돌면 main 이 묻는다) · 더블클릭하면 이름 바꾸기
export let renamingTab: string | null = null // 이름을 고치는 중인 탭 id — 그동안은 탭 줄을 다시 그리지 않는다(글자 칸이 사라지지 않게)
export function renderTabs(): void {
  const bar = $('studio-tabs')
  if (renamingTab && bar.querySelector('.studio-tab-input')) return
  const current = activeTab()
  const buttons = screen.tabs
    .filter((tab) => tab.workspace === screen.activeWorkspace)
    .map((tab, index) => {
      const button = document.createElement('button')
      button.className = 'studio-tab'
      const selected = Boolean(current) && tab.id === current!.id
      button.setAttribute('aria-selected', String(selected))
      button.addEventListener('click', (event) => {
        // 이미 고른 탭은 데몬에 다시 묻지 않는다 — 다시 물으면 상태가 새로 와 더블클릭 직후 글자 칸이 포커스를 잃는다
        if (!selected) studio.tabSelect(tab.id)
        else if (event.detail === 1) focusCurrentTerminal()
      })
      const name = document.createElement('span')
      name.textContent = tab.label || say('tab.default', { n: index + 1 })
      const close = document.createElement('span')
      close.className = 'close'
      close.textContent = '✕'
      close.title = say('tab.closeTitle', { key: state!.tabKey })
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        studio.tabClose(tab.id)
      })
      button.append(name, close)
      button.title = say('tab.renameHint')
      button.addEventListener('dblclick', () => startTabRename(button, tab, name.textContent as string))
      return button
    })
  const add = document.createElement('button')
  add.className = 'studio-tab add'
  add.textContent = '＋'
  add.title = say('tab.newTitle', { key: state!.tabKey })
  add.setAttribute('aria-label', say('tab.new')) // ＋ 글자는 아이콘으로 가려져 있어 읽기용 이름을 따로
  add.addEventListener('click', newTab)
  bar.replaceChildren(...buttons, add)
}

// 탭 자리에 글자 칸을 띄운다 — Enter·칸 밖 누르기 저장 · Esc 취소 · 비우면 기본 이름으로
function startTabRename(button: HTMLButtonElement, tab: ScreenTab, shown: string): void {
  const input = document.createElement('input')
  input.className = 'studio-tab studio-tab-input'
  input.value = tab.label || ''
  input.placeholder = shown
  input.maxLength = 60
  input.spellcheck = false
  input.setAttribute('aria-label', say('tab.nameLabel'))
  renamingTab = tab.id
  let done = false
  const finish = (save: boolean) => {
    if (done) return
    done = true
    renamingTab = null
    const label = input.value.trim()
    if (save && label !== (tab.label || '')) {
      const before = tab.label
      tab.label = label || null // 데몬이 새 상태를 보내기 전에도 바로 보이게
      studio.tabRename(tab.id, label).then((result) => {
        if (!result || !result.error) return
        // 못 바꿨으면 원래 이름으로 되돌리고 알린다
        tab.label = before
        renderTabs()
        showToast(say('tab.renameFailed', { message: result.error }))
      })
    }
    renderTabs()
  }
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return // 한글 조합 중 Enter 는 글자 확정용
    if (event.key === 'Enter') finish(true)
    if (event.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  button.replaceWith(input)
  input.focus()
  input.select()
}

// ── 탭 ──────────────────────────────────────────────────
// 일감은 앱 안에 띄우지 않고 기본 브라우저로 연다(⌘2 · 탭 줄 아이콘 · 트레이) — 작업 창에서는 작업만
export function switchTab(name: string): void {
  if (!state || !state.valid) return
  if (name === 'board') {
    if (!welcomeShown()) studio.openBoard() // 팩을 고르기 전에는 일감을 열지 않는다
    return
  }
  setCurrentTab('work')
  studio.reportTab('work')
  panels.work.hidden = false
  requestAnimationFrame(layoutPanes)
}
