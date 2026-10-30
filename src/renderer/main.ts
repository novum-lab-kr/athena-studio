// 작업 창 시작 — 팩 알림 받기 · 본체가 정해진 뒤 · 아테나 폴더(처음 화면 · 고르기 · 받기) · 언어 바꾸기 · init(맨 끝에 한 번)
// renderer.js 에서 옮김(R3f · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 진입점(entry.ts)이 마지막에 싣는다 — 이 파일 맨 끝 init() 은 다른 묶음을 다 읽은 뒤에 돈다
import { $, applyStaticTexts, currentTab, panels, say, setI18nState, setState, showToast, state } from './core.ts'
import { views } from './terminal.ts'
import { attached, attaching, reattachScreen, runCommand, screen, setAttached, setReattachOnKey, showRestoreResult, startScreen } from './screen.ts'
import { applyState, renderTabs, switchTab } from './tabs.ts'
import { holdForRedraw, holdOutputArrived, initMonitor, layoutPanes, sendPaneSize } from './pane-layout.ts'
import { initEdgeResize } from './edge-resize.ts'
import { packs, setPacks, showCoreUpdate } from './pack-dialogs.ts'
import { hasNoPacks, openNoPacks, packRailActions, refreshPackList, renderPackRail, runPackCommand } from './pack-switch.ts'
import { initTips } from './tips.ts'
import { refreshPackRepos, renderSides, spaceColor, spaceInitials, spacesActions } from './space-actions.ts'
import { applySideFolds, closePreview, explorerActions, setPanelHidden } from './side-panels.ts'
import { initBrowser } from './browser.ts'
import { initWork } from './work.ts'
import { StudioUi } from './ui/index.ts'

export let branches: Record<string, string | null> = {} // 작업 공간 id → git 브랜치(없으면 null) — main 이 5초마다
export let paneStatus: Record<string, string | null> = {} // pane id → 에이전트 상태(working · idle · …, 에이전트 없으면 null) — main 이 2초마다

// 이 창의 팩이 가져오기로 바뀌었다(교체) — 목록 · 현황판을 새로(창의 본체 · pane 은 그대로)
function onPackChanged(): void {
  refreshPackList()
}

async function initPacks(): Promise<void> {
  StudioUi.packRail.mount($('pack-rail'), packRailActions, { spaceColor, spaceInitials })
  StudioUi.packProgress.mount($('pack-progress').querySelector('.pack-box') as HTMLElement)
  studio.onPackState((next) => {
    refreshPackRepos()
    setPacks(next)
    renderPackRail()
  })
  studio.onPackProgress(StudioUi.packProgress.step)
  studio.onPackRestored(showRestoreResult)
  studio.onPackCaughtUp((info) => showToast(say('pack.caughtUp', info), 'info'))
  studio.onPackChanged(onPackChanged)
  studio.onPackCommand((name) => state && state.valid && runPackCommand(name))
  await afterAthenaReady()
}

// 본체가 정해진 뒤 — 팩이 하나도 없으면 두 가지만 보여 준다
async function afterAthenaReady(): Promise<void> {
  if (!state || !state.valid) return
  await refreshPackList()
  if (!packs.supported) return
  if (hasNoPacks()) openNoPacks()
}

// ── 아테나 폴더 ────────────────────────────────────────────
// state 는 init 이 맨 먼저 채운다(athenaState) — 그 뒤에만 부른다
export function renderState(): void {
  document.body.dataset.platform = state!.platform
  $('install-dir').textContent = state!.installDir || ''
  $('browser-toggle').dataset.tip = say('browser.toggleTitle', { key: state!.tabKey })
  $('board-tab').dataset.tip = say('board.openTitle')
  const ready = state!.valid
  panels.setup.hidden = ready
  renderPackRail() // 오른쪽 위 현황판 · 다이어그램 · 작업 · 설정 버튼도 여기서(pack-switch.ts renderPackWelcome — 시작 화면과 한 규칙)
  if (!ready) {
    panels.work.hidden = true
  }
}

const pickAthenaDir = (): Promise<void> => applyAthenaResult(studio.pickAthenaDir())

// 처음 화면 제목 — 사전 키를 기억해 두어 언어를 바꾸면 다시 쓴다(키가 없으면 제품 이름 그대로)
let setupTitleKey: string | null = null
function setSetupTitle(key: string | null): void {
  setupTitleKey = key
  $('setup-title').textContent = key ? say(key) : 'Athena Studio'
}

// 처음 켤 때 아테나 폴더가 안 정해졌으면 묻지 않고 앱이 들고 온 코어를 풀어 쓴다(~/.athena-studio/core). 안 됐을 때만 [다시 시도] · [폴더 고르기] 를 보여 준다
async function installAthena(): Promise<void> {
  const buttons = [$('install'), $('pick')]
  for (const button of buttons) button.hidden = true
  $('setup-error').hidden = true
  $('spinner').hidden = false
  setSetupTitle('setup.preparing')
  $('setup-note').hidden = false
  try {
    await applyAthenaResult(studio.installAthena())
  } finally {
    $('spinner').hidden = true
    if (!state!.valid) {
      setSetupTitle('setup.notFound')
      $('setup-note').hidden = true
      for (const button of buttons) button.hidden = false
    }
  }
}

async function applyAthenaResult(pending: Promise<AthenaResult>): Promise<void> {
  const result = await pending
  const error = $('setup-error')
  if (result.canceled) return
  if (result.error) {
    if (state!.valid) {
      alert(result.error)
    } else {
      error.textContent = result.error
      error.hidden = false
    }
    return
  }
  error.hidden = true
  const wasValid = state!.valid
  setState(result)
  renderState()
  if (!wasValid || result.changed) {
    // 처음 정했거나 폴더가 바뀌었으면 작업 창을 연다(이미 있는 데몬 탭은 그대로 — athena 탭이 없을 때만 새로 켠다)
    switchTab('work')
    startScreen()
    afterAthenaReady()
  }
}

// 메뉴 [보기 → 언어] — 정적 문구와 지금 보이는 것만 다시 그린다(열린 대화상자는 다음에 열 때부터 · React 화면은 textsChanged 로 바로)
function applyLanguage(next: I18nPayload): void {
  setI18nState(next)
  applyStaticTexts()
  StudioUi.textsChanged()
  if (setupTitleKey) setSetupTitle(setupTitleKey)
  if (!state) return
  renderState()
  if (attached) {
    renderTabs()
    renderSides()
    StudioUi.explorer.render()
  }
  StudioUi.monitor.refresh()
}

async function init(): Promise<void> {
  // 코어 업데이트 결과 — main 이 화면을 다 읽자마자(did-finish-load) 한 번 보내므로 첫 await 전에 받을 준비를 한다
  StudioUi.coreUpdate.mount($('core-update').querySelector('.pack-box') as HTMLElement)
  studio.onCoreUpdate(showCoreUpdate)
  // 코어 업데이트 중 표시 — 바뀔 때 알림을 받고, 처음 값은 한 번 묻는다
  studio.onCoreUpdateState((running) => ($('core-updating').hidden = !running))
  studio.coreUpdateRunning().then((running) => ($('core-updating').hidden = !running)).catch(() => {})
  setState(await studio.athenaState())
  renderState()
  initWork()
  initTips()
  initBrowser()
  initMonitor()
  StudioUi.explorer.setup($('side-panel'), explorerActions())
  $('pick').addEventListener('click', pickAthenaDir)
  $('install').addEventListener('click', installAthena)
  studio.onTabSwitch(switchTab)
  studio.onPickRequest(pickAthenaDir)
  // 데몬 알림 — 붙는 중에 온 출력은 되살릴 화면에 이미 들어 있어 버린다
  studio.onPaneData((paneId, data) => {
    if (!attached || attaching) return
    const view = views.get(paneId)
    if (!view) return
    view.term.write(data)
    if (view.hold && !view.hold.releasing) holdOutputArrived(paneId, view)
  })
  // 데몬이 크기를 적용한 자리 — 그 앞 출력(이미 보낸 것)을 다 읽은 뒤에 바꾼다(빈 write 의 콜백 = 앞선 write 다음 차례).
  // 붙는 중이면 버린다 — 새 view 는 attach 가 준 크기(이 요청이 이미 반영된)로 만든다
  studio.onPaneResized((paneId, cols, rows) => {
    const view = views.get(paneId)
    if (!view || !attached || attaching || !(cols > 1 && rows > 1)) return
    clearTimeout(view.resizing as number | undefined)
    view.resizing = null
    // 받은 상태의 크기도 고쳐 둔다 — 다음 상태가 올 때까지 옛 크기로 보고 다시 요청하지 않게
    const known = screen.panes.find((pane) => pane.id === paneId)
    if (known) Object.assign(known, { cols, rows })
    const held = holdForRedraw(paneId, view)
    view.term.write('', () => views.get(paneId) === view && view.term.resize(cols, rows))
    // 기다리는 사이 크기가 또 바뀌었으면 최신 크기만 이어서 — 덮었으면 다시 그리기를 다 받은 뒤(releaseHold), 아니면 다음 프레임에
    if (!held && view.want && (view.want.cols !== cols || view.want.rows !== rows)) {
      requestAnimationFrame(() => views.get(paneId) === view && sendPaneSize(paneId, view, known))
    }
  })
  studio.onScreenState((next) => attached && !attaching && applyState(next))
  studio.onScreenBranches((next) => {
    if (JSON.stringify(next) === JSON.stringify(branches)) return
    branches = next
    if (attached) renderSides()
  })
  studio.onScreenPaneStatus((next) => {
    if (JSON.stringify(next) === JSON.stringify(paneStatus)) return
    paneStatus = next
    if (attached) renderSides()
  })
  StudioUi.spaces.setup($('spaces'), spacesActions())
  applySideFolds()
  $('side-open').addEventListener('click', () => setPanelHidden(false))
  $('preview-close').addEventListener('click', closePreview)
  $('preview').addEventListener('keydown', (event) => event.key === 'Escape' && closePreview())
  // git 변경 · 펼친 폴더는 Explorer 가 보일 때만 3초마다
  setInterval(() => {
    if (currentTab === 'work' && !$('side-panel').hidden && attached) StudioUi.explorer.refresh()
    // 팩 레포 목록 — /setup 이 레포를 더하거나 연결이 바뀌면 spaces 의 흐린 레포 줄도 따라간다(작은 파일 하나 읽기)
    if (attached) refreshPackRepos()
  }, 3000)
  studio.onScreenResync(() => state!.valid && reattachScreen())
  studio.onScreenDisconnected(() => {
    setAttached(false)
    setReattachOnKey(true)
    StudioUi.notices.showScreenStatus(say('screen.disconnected'))
  })
  studio.onScreenCommand(runCommand)
  studio.onLanguage(applyLanguage)
  const packsReady = initPacks()
  new ResizeObserver(() => layoutPanes()).observe($('panes'))
  new ResizeObserver(() => layoutPanes()).observe($('dock'))
  initEdgeResize()
  // 파일을 pane 밖(창 아무 데)에 놓아도 페이지가 그 파일로 이동하지 않게 — pane 위에 놓으면 terminal.ts 가 경로를 넣는다
  for (const type of ['dragover', 'drop'] as const) {
    document.addEventListener(type, (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    })
  }
  if (state!.valid) {
    switchTab('work')
    // 데몬에 붙어 pane 을 먼저 보여 주고, 팩 목록(켤 때 시작 화면인지)을 본 뒤 — 시작 화면이면 고를 때까지 아테나 에이전트를 켜지 않는다(startScreen)
    void startScreen(packsReady)
  } else {
    installAthena()
  }
}

init()
