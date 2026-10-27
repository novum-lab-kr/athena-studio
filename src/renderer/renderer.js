// 앱 화면 — 탭 두 개(작업 창 · 일감) · 작업 창 안의 데몬 탭·pane · 처음 켤 때 아테나 받기 · 에이전트(claude · codex) 고르기
// studio 는 preload 의 contextBridge 가 만든 전역이다 — 같은 이름으로 다시 선언하면 이 파일 전체가 SyntaxError 로 죽는다
/* global studio, Terminal, FitAddon, WebLinksAddon, Unicode11Addon, StudioLayout, StudioI18n, StudioUi */
const $ = (id) => document.getElementById(id)

// ── 언어 ──────────────────────────────────────────────────
// 문구는 사전(src/i18n) — main 이 preload 로 넘긴다(StudioI18n 은 src/lib/i18n.mts). 정적 문구는 index.html 의 data-i18n* 속성
let i18nState = studio.i18n()
const say = (key, values) => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)
// React 화면(ui/)도 같은 say · 토스트를 쓴다(ui/bridge.ts)
StudioUi.connect({ say, showToast })

function applyStaticTexts() {
  document.documentElement.lang = i18nState.language
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = say(node.dataset.i18n)
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = say(node.dataset.i18nTitle)
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', say(node.dataset.i18nAriaLabel))
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = say(node.dataset.i18nPlaceholder)
}
applyStaticTexts()

const panels = { setup: $('setup'), work: $('work') }

let state = null
let currentTab = 'work'

// ── 작업 창 (데몬의 탭 · pane) ───────────────────────────────
// pane 은 데몬이 갖는다 — 앱을 닫았다 켜도 같은 배치·화면으로 다시 붙는다. 분할 트리는 StudioLayout(src/lib/layout.mts)
const PANE_GAP = 2
const HEAD_HEIGHT = 22 // pane 머리줄 높이(style.css .pane-head 와 같은 값)
const views = new Map() // paneId → { term, fit, el, head, shown, sent: {cols, rows} }
let screen = { workspaces: [], activeWorkspace: null, tabs: [], focused: null, panes: [] }
let branches = {} // 작업 공간 id → git 브랜치(없으면 null) — main 이 5초마다
let paneStatus = {} // pane id → 에이전트 상태(working · idle · …, 에이전트 없으면 null) — main 이 2초마다
let attached = false
let attaching = null
let reattachOnKey = false
let lastTabSize = null

function makeTerminal() {
  const term = new Terminal({
    allowProposedApi: true, // unicode11 에 필요
    // Nerd Font 는 아이콘(사이드바 Explorer 등)용 — 기본 글꼴에 없는 글자만 그 글꼴로 그린다
    fontFamily: '"D2Coding", "SF Mono", Menlo, "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true, // 안의 프로그램이 마우스를 잡아도 Option+드래그로 고를 수 있게
    theme: { background: '#16171a', foreground: '#e8e6e1' },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => studio.openUrl(uri)))
  // 이모지(🤖 🧭)를 두 칸으로 — 데몬의 화면 버퍼와 같은 규칙
  term.loadAddon(new Unicode11Addon.Unicode11Addon())
  term.unicode.activeVersion = '11'
  return { term, fit }
}

// 탭 밖 고정 칸(dock — 예전 터미널 모니터)은 그리지 않는다. 모니터는 이제 앱 화면(#dock)이다
const isTabPane = (pane) => Boolean(pane.tab)

function ensureView(paneId) {
  if (views.has(paneId)) return views.get(paneId)
  const el = document.createElement('div')
  el.className = 'pane'
  const head = document.createElement('div')
  head.className = 'pane-head'
  const headLabel = document.createElement('span')
  headLabel.className = 'pane-head-label'
  const detailButton = paneDetailButton(paneId)
  head.append(headLabel, detailButton)
  const body = document.createElement('div')
  body.className = 'pane-body'
  el.append(head, body)
  $('panes').append(el)
  const { term, fit } = makeTerminal()
  term.open(body)
  const sendInput = (data) => {
    if (reattachOnKey) return reattach()
    return studio.paneInput(paneId, data)
  }
  term.onData(sendInput)
  // 조합 중 누른 ⌘← · ⌘→ 는 조합이 확정된 뒤 보낸다(StudioPaneKeys.createComposingKeys). 확정 소식은 xterm 보다 늦게 건 이 처리로
  const composingKeys = StudioPaneKeys.createComposingKeys({ send: sendInput })
  term.textarea.addEventListener('compositionend', () => composingKeys.compositionEnd())
  // xterm 기본과 다르게 보내는 키. 한글 조합 중(isComposing)이면 xterm 에 맡긴다 — 둘만 빼고:
  //   ⌘ 키 자체 — xterm 6.0.0 은 조합 중 Shift · Ctrl · Alt 만 수정키로 보고 ⌘ 는 조합을 바로 끝내 글자를 보낸 뒤, 진짜 조합 끝에 한 번 더 보낸다(글자 반복)
  //   줄 처음 · 끝(⌘← · ⌘→) — 기본 커서 이동을 막고 신호를 조합 확정 뒤로 미룬다. 조합 마무리는 compositionend 로 xterm 이 한다
  // keydown 에서만 보내고 keypress · keyup 의 같은 키도 막아 기본 신호가 새지 않게 한다
  term.attachCustomKeyEventHandler((event) => {
    if (event.isComposing && event.key === 'Meta') return false
    const data = StudioPaneKeys.paneKeyOverride(event)
    if (data === null) return true
    if (event.isComposing) {
      if (!StudioPaneKeys.holdWhileComposing(data)) return true
      if (event.type === 'keydown') {
        event.preventDefault()
        composingKeys.hold(data)
      }
      return false
    }
    if (event.type === 'keydown') {
      event.preventDefault()
      sendInput(data)
    }
    return false
  })
  // 누른 pane 으로 포커스(데몬에도 알려 pane current · split --target focused 가 맞게)
  el.addEventListener('mousedown', () => focusPane(paneId))
  // 우클릭 메뉴 — 나누기 · 닫기. xterm 의 우클릭 단어 선택(맥 기본)은 그대로 두고 메뉴만 덧띄운다
  el.addEventListener('contextmenu', (event) => paneMenu(paneId, event))
  const view = { term, fit, el, head, headLabel, detailButton, body, shown: false, sent: null }
  term.onWriteParsed(() => scheduleScreenAnchor(paneId, view))
  views.set(paneId, view)
  return view
}

// 칸 높이로 나누고 남는 몇 px 를 어디에 두나 — 화면이 차 있으면 위에 두고 글을 pane 아래에 붙인다(.pane-body.screen-bottom).
// 셸 · Claude Code 처럼 마지막 줄(프롬프트 · 입력창)이 맨 아래에 있는 화면을 위에 붙여 두면, 위아래로 크기를 바꿀 때
// 상자는 px 단위로 움직이는데 줄 수는 한 줄(약 14px)씩만 바뀌어 아래쪽 글이 밀렸다 한 줄씩 되튄다(톱니). 아래에 붙이면 아래쪽 글이 제자리에 있다.
// 아직 덜 찬 화면(새 셸 · 막 켠 Claude Code)은 지금처럼 위에 붙인다.
// 출력 중간(다시 그리기 조각 사이)에 바꾸면 남는 px 만큼 흔들리니 출력이 이만큼 조용할 때 · 덮어 두지 않을 때만 바꾼다
const SCREEN_ANCHOR_SETTLE_MS = 150

function scheduleScreenAnchor(paneId, view) {
  clearTimeout(view.anchorTimer)
  view.anchorTimer = setTimeout(() => {
    if (views.get(paneId) !== view) return
    if (view.hold) return scheduleScreenAnchor(paneId, view)
    return view.body.classList.toggle('screen-bottom', screenIsFull(view.term))
  }, SCREEN_ANCHOR_SETTLE_MS)
}

// 전체 화면 프로그램 · 스크롤백이 있는 화면 · 맨 아래 줄까지 글이 있는 화면
function screenIsFull(term) {
  const buffer = term.buffer.active
  if (buffer.type === 'alternate' || buffer.baseY > 0) return true
  const lastRow = buffer.getLine(buffer.baseY + term.rows - 1)
  return Boolean(lastRow && lastRow.translateToString(true))
}

// 숨었던 칸이 다시 보일 때 — xterm DOM 렌더러는 글자 폭을 DOM 으로 재서 글자 간격(셀 폭 − 글자 폭)을 정하는데,
// 숨은 칸(display:none — 다른 작업 공간의 하단 칸 · 일감 탭)에서는 0 으로 재져 간격이 셀 폭만큼 벌어진다.
// (A) 숨은 채 열면 기본 간격이 그렇게 굳고 (B) 숨는 순간의 한 프레임에 그려진 줄도 그대로 남는다.
// 옵션이 바뀌면 렌더러가 기본 간격을 다시 정하고(같은 값은 무시돼서 바꿨다 되돌린다) 0 으로 잰 글자 폭은 캐시에 남지 않으니, 보일 때 다시 재고 전부 다시 그린다.
// open 을 미루면 그 전에 온 OSC 색 설정이 버려져서(테마 서비스가 open 때 생긴다) 열기는 그대로 둔다
function redrawAfterHidden(view) {
  const { term } = view
  const sensitivity = term.options.scrollSensitivity
  term.options.scrollSensitivity = sensitivity + 1
  term.options.scrollSensitivity = sensitivity
  term.refresh(0, term.rows - 1)
}

function disposeView(paneId) {
  const view = views.get(paneId)
  if (!view) return
  clearTimeout(view.resizing)
  clearTimeout(view.anchorTimer)
  if (view.hold) clearTimeout(view.hold.timer)
  view.term.dispose()
  view.el.remove()
  views.delete(paneId)
}

function activeWorkspace() {
  return screen.workspaces.find((workspace) => workspace.id === screen.activeWorkspace) || null
}

// 아테나 폴더의 작업 공간인가 — 이름이 athena 이고 지금 아테나 폴더인 것(main 의 core.findAthenaWorkspace 와 같은 규칙).
// 아테나 폴더를 바꿔 예전 폴더의 athena 작업 공간이 남아 있으면 그쪽엔 모니터를 안 보인다.
// 화면은 심볼릭 링크를 못 풀어서 적어 둔 경로 · main 이 푼 경로(athenaRealDir) 둘 중 하나와 글자로 맞춰 본다.
// 폴더가 맞는 것이 하나도 없으면(새 작업 공간을 만들기 전 잠깐 등) 예전처럼 이름만 본다
const trimSlash = (dir) => String(dir || '').replace(/\/+$/, '')

function isAthenaWorkspace(workspace) {
  if (!workspace || !state || workspace.label !== state.athenaWorkspace) return false
  const wanted = [state.athenaDir, state.athenaRealDir].filter(Boolean).map(trimSlash)
  const sameFolder = (entry) => wanted.includes(trimSlash(entry.cwd))
  const anyMatch = screen.workspaces.some((entry) => entry.label === state.athenaWorkspace && sameFolder(entry))
  return anyMatch ? sameFolder(workspace) : true
}

function activeTab() {
  const workspace = activeWorkspace()
  return (workspace && screen.tabs.find((tab) => tab.id === workspace.activeTab)) || null
}

// 데몬이 준 상태로 탭 줄 · pane 을 다시 그린다
function applyState(next) {
  screen = next
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
let starting = false // 처음 켤 때는 에이전트 판단(athena 탭)이 끝난 뒤에 본다
function ensureSomeTab() {
  // 시작 화면이 떠 있으면 만들지 않는다 — 고를 때 닫을 pane 이 생겨 확인 창이 뜨지 않게(들어가면 아테나 탭이 생긴다)
  if (screen.tabs.length || openingTab || starting || !state || !state.valid || welcomeShown()) return
  openingTab = true
  newTab().finally(() => (openingTab = false))
}

// 가운데 탭 줄 — 지금 작업 공간의 탭만. ✕ 로 닫는다(에이전트가 돌면 main 이 묻는다) · 더블클릭하면 이름 바꾸기
let renamingTab = null // 이름을 고치는 중인 탭 id — 그동안은 탭 줄을 다시 그리지 않는다(글자 칸이 사라지지 않게)
function renderTabs() {
  const bar = $('studio-tabs')
  if (renamingTab && bar.querySelector('.studio-tab-input')) return
  const current = activeTab()
  const buttons = screen.tabs
    .filter((tab) => tab.workspace === screen.activeWorkspace)
    .map((tab, index) => {
      const button = document.createElement('button')
      button.className = 'studio-tab'
      const selected = Boolean(current) && tab.id === current.id
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
      close.title = say('tab.closeTitle', { key: state.tabKey })
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        studio.tabClose(tab.id)
      })
      button.append(name, close)
      button.title = say('tab.renameHint')
      button.addEventListener('dblclick', () => startTabRename(button, tab, name.textContent))
      return button
    })
  const add = document.createElement('button')
  add.className = 'studio-tab add'
  add.textContent = '＋'
  add.title = say('tab.newTitle', { key: state.tabKey })
  add.setAttribute('aria-label', say('tab.new')) // ＋ 글자는 아이콘으로 가려져 있어 읽기용 이름을 따로
  add.addEventListener('click', newTab)
  bar.replaceChildren(...buttons, add)
}

// 탭 자리에 글자 칸을 띄운다 — Enter·칸 밖 누르기 저장 · Esc 취소 · 비우면 기본 이름으로
function startTabRename(button, tab, shown) {
  const input = document.createElement('input')
  input.className = 'studio-tab studio-tab-input'
  input.value = tab.label || ''
  input.placeholder = shown
  input.maxLength = 60
  input.spellcheck = false
  input.setAttribute('aria-label', say('tab.nameLabel'))
  renamingTab = tab.id
  let done = false
  const finish = (save) => {
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

// ── 왼쪽 spaces · 오른쪽 패널 ──
// 접기·펴기 버튼 아이콘 — 칸 머리에 붙는다(그리기는 React — 왼쪽 ui/spaces.tsx · 오른쪽 ui/explorer.tsx). 패널 아이콘(네모 + 세로선 · 사용자가 시안 5 를 고름) · 접힌 칸은 그쪽을 칠한다
const PANEL_ICONS = {
  left: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18'],
  right: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18'],
}

const PANEL_FILLS = {
  left: 'M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  right: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z',
}

// 툴팁 — data-tip 버튼 위에 잠깐 머물면 버튼 아래 가운데에 띄운다(화면 밖으로 나가면 안쪽으로 당기고, 아래가 모자라면 위로 · 세로 아이콘 줄은 오른쪽)
// 아이콘 버튼(글자가 거의 없는 button)의 title 도 여기로 옮겨 같은 툴팁으로 — 기본 title 툴팁은 탭 줄 등에서 안 뜬다
const TIP_SELECTOR = '[data-tip], button[title], .studio-tab .close[title]' // 탭의 ✕ 는 button 이 아니라 span
const ICON_TEXT_MAX = 2 // ＋ · ✕ · 접힌 작업 공간 머리글자(두 글자)까지
function tipTarget(element) {
  const node = element instanceof Element ? element.closest(TIP_SELECTOR) : null
  if (!node) return null
  if (node.hasAttribute('title')) {
    if (!node.dataset.tip && node.textContent.trim().length > ICON_TEXT_MAX) return null // 글자 버튼은 기본 title 그대로
    // 옆 브라우저 바는 기본 title 그대로 — 아래로 띄우면 페이지 자리의 네이티브 뷰에 가려진다
    if (node.closest('#browser')) return null
    // 코드가 title 을 다시 넣었을 수도 있어(언어 바꿈 · 상태 바뀜) 볼 때마다 옮긴다
    node.dataset.tip = node.title
    if (!node.hasAttribute('aria-label')) node.setAttribute('aria-label', node.title)
    node.removeAttribute('title')
  }
  return node.dataset.tip ? node : null
}
const TIP_DELAY_MS = 350
const TIP_GAP = 6
function initTips() {
  const tip = $('tip')
  let target = null
  let timer = null
  const hide = () => {
    clearTimeout(timer)
    tip.hidden = true
    target = null
  }
  const show = (node) => {
    tip.textContent = node.dataset.tip
    tip.hidden = false
    const rect = node.getBoundingClientRect()
    const box = tip.getBoundingClientRect()
    // 세로 아이콘 줄(팩 줄 · 접힌 spaces)은 아래로 띄우면 다음 아이콘을 가려서 오른쪽에
    if (node.closest('.pack-rail, .spaces.collapsed')) {
      tip.style.left = `${rect.right + TIP_GAP}px`
      tip.style.top = `${Math.max(4, Math.min(rect.top + rect.height / 2 - box.height / 2, innerHeight - box.height - 4))}px`
      return
    }
    const left = rect.left + rect.width / 2 - box.width / 2
    tip.style.left = `${Math.max(4, Math.min(left, innerWidth - box.width - 4))}px`
    // 아래 자리가 모자라면(맨 아래 접힌 에이전트 모니터 등) 버튼 위로
    const below = rect.bottom + TIP_GAP
    tip.style.top = `${below + box.height > innerHeight - 4 ? rect.top - TIP_GAP - box.height : below}px`
  }
  // 띄울 때는 그 자리의 버튼을 다시 찾는다 — 왼쪽 spaces 는 데몬 상태마다 다시 그려져 기다리는 사이 버튼이 바뀐다
  const tipAt = (point) => tipTarget(document.elementFromPoint(point.x, point.y))
  document.addEventListener('mouseover', (event) => {
    const node = tipTarget(event.target)
    if (node === target) return
    // 다시 그려져 같은 버튼이 새 요소로 바뀐 것뿐이면(탭 줄 · spaces) 툴팁을 그대로 둔다
    if (node && target && node.dataset.tip === target.dataset.tip) {
      target = node
      return
    }
    hide()
    if (!node) return
    target = node
    const point = { x: event.clientX, y: event.clientY }
    timer = setTimeout(() => {
      const now = node.isConnected ? node : tipAt(point)
      if (!now) return
      target = now
      show(now)
    }, TIP_DELAY_MS)
  })
  document.addEventListener('mousedown', hide)
  window.addEventListener('blur', hide)
  // 창 밖이나 옆 브라우저 화면(네이티브 뷰) 위로 바로 나가면 mouseover 가 안 온다 — 남지 않게
  document.documentElement.addEventListener('mouseleave', hide)
}

// 작업 공간 아이콘 — 이름 앞 두 글자 + 이름으로 고른 색(같은 이름은 늘 같은 색)
const SPACE_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#7dcfff', '#ff9e64', '#73daca']

function spaceColor(label) {
  let hash = 0
  for (const character of String(label)) hash = (hash * 31 + character.codePointAt(0)) >>> 0
  return SPACE_COLORS[hash % SPACE_COLORS.length]
}

function spaceInitials(label) {
  const words = String(label).split(/[-_\s.]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : String(label).slice(0, 2)
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()
}

// 작업 공간 순서 — 아테나(본체) 작업 공간은 늘 맨 위, 나머지는 데몬 순서 그대로
function orderedWorkspaces() {
  const athena = screen.workspaces.filter(isAthenaWorkspace)
  return [...athena, ...screen.workspaces.filter((workspace) => !athena.includes(workspace))]
}

// 작업 공간의 pane 들 — 탭 순서, 탭 안은 분할 순서(왼쪽 작업 공간 목록 · 작업 공간 닫기)
function workspacePanes(workspaceId) {
  const meta = new Map(screen.panes.filter(isTabPane).map((pane) => [pane.id, pane]))
  return screen.tabs
    .filter((tab) => tab.workspace === workspaceId)
    .flatMap((tab) => StudioLayout.paneIds(tab.tree).filter((id) => meta.has(id)).map((id) => ({ ...meta.get(id), tab: tab.id })))
}

// 팩 레포 중 아직 작업 공간(에이전트 pane)이 없는 것 — 흐리게. 누르면 아테나에게 /call <그 레포 에이전트>
let packRepos = []
async function refreshPackRepos() {
  const next = (await studio.packRepos().catch(() => [])) || []
  if (JSON.stringify(next) === JSON.stringify(packRepos)) return
  packRepos = next
  if (attached) renderSides()
}
// 레포 표시 이름(pack set-repo-name) — 사이드바만. 레포 name 은 그대로(작업 공간 이름 · 경로가 이것으로 찾는다)
function repoLabel(repo) {
  return (repo && (repo.displayName || repo.name)) || ''
}
function packRepoOf(label) {
  return packRepos.find((repo) => repo.name === label) || null
}

// 후보 브랜치 설명 — 로컬 · 10/18 · 마지막 커밋 제목(없으면 "아직 커밋 없음") · 워크트리 있음
function candidateNote(item) {
  const day = item.date ? `${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8, 10))}` : ''
  return [say(`spaces.place.${item.place}`), day, item.noCommits ? say('spaces.noCommits') : item.subject, item.worktree ? say('spaces.hasWorktree') : ''].filter(Boolean).join(' · ')
}

// 부르기 팝업 위 두 줄 — 담당 에이전트 · 메인 체크아웃(브랜치 · 원격과 비교 · 바뀐 파일). git 글자 그대로 보이지 않게 풀어 쓴다
function callMeta(info) {
  const meta = el('dl', 'call-meta')
  const row = (key, value) => meta.append(el('dt', null, key), el('dd', null, value))
  row(say('spaces.callAgentKey'), info.agent)
  const main = info.main
  if (main) {
    const sync = !main.upstream ? say('spaces.syncNone')
      : main.gone ? say('spaces.syncGone')
      : main.ahead && main.behind ? say('spaces.syncBoth', { ahead: main.ahead, behind: main.behind })
      : main.ahead ? say('spaces.syncAhead', { count: main.ahead })
      : main.behind ? say('spaces.syncBehind', { count: main.behind })
      : say('spaces.syncSame')
    const dirty = main.dirty ? say('spaces.dirtyCount', { count: main.dirty }) : say('spaces.dirtyNone')
    row(say('spaces.callMainKey'), [main.branch, sync, dirty].join(' · '))
  }
  return meta
}

// spaces 레포 줄 우클릭 메뉴(main) — 작업 공간 닫기 · 팩에서 레포 빼기
async function spaceMenu({ workspace, repo }, event) {
  const action = await studio.spaceContextMenu({ workspace: workspace ? workspace.id : null, repo }, { x: Math.round(event.clientX), y: Math.round(event.clientY) })
  if (action === 'close-workspace') return closeWorkspace(workspace)
  if (action === 'repo-look') return runPackFlow(() => editRepoLookDialog(repo))
  if (action === 'repo-reset-name' || action === 'repo-clear-icon') return runPackFlow(() => resetRepoLook(repo, action))
  if (action === 'remove-repo') return runPackFlow(() => removeRepoFromPack(repo))
}

// 레포 이름 · 이미지 — 팩 이름 · 이미지와 같은 대화상자(lookDialog). 레포 name 은 그대로, 화면 표시만(팀과 같이 쓰는 팩 안에 저장)
async function editRepoLookDialog(name) {
  await refreshPackRepos()
  const repo = packRepoOf(name)
  if (!repo) return
  const image = repo.iconPath ? ((await studio.repoIcon(name)) || {}).dataUrl || null : null
  const answer = await lookDialog({ title: say('spaces.look.title'), color: name, image, value: repoLabel(repo), placeholder: name, pickKind: 'repo' })
  if (!answer) return
  const now = packRepoOf(name) || repo
  const results = []
  if (answer.text !== repoLabel(now)) results.push(await studio.repoSetName(name, answer.text ? answer.text : null))
  if (answer.iconChange) results.push(await studio.repoSetIcon(name, answer.iconChange === 'clear', answer.iconChange === 'picked'))
  await refreshPackRepos()
  const failed = results.find((result) => result && !result.ok && !result.canceled)
  if (failed) return packAlert(say('pack.look.failed'), failed.text || failed.message)
}

// 레포 우클릭 [원래 이름으로] · [이미지 지우기]
async function resetRepoLook(name, action) {
  const result = action === 'repo-reset-name' ? await studio.repoSetName(name, null) : await studio.repoSetIcon(name, true)
  await refreshPackRepos()
  if (result && !result.ok && !result.canceled) return packAlert(say('pack.look.failed'), result.text || result.message)
}

// 작업 공간 닫기 — 에이전트가 도는 pane 이 있으면 한 번 묻는다
async function closeWorkspace(workspace) {
  const panes = workspacePanes(workspace.id)
  const agents = panes.filter((pane) => paneStatus[pane.id])
  if (agents.length) {
    const ok = await packDialog({ title: say('spaces.closeWorkspaceTitle', { name: workspace.label }), body: [el('p', 'muted', say('spaces.closeWorkspaceNote', { count: agents.length }))], actions: [{ label: say('spaces.closeWorkspaceYes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }] })
    if (!ok) return
  }
  const result = await studio.workspaceClose(workspace.id)
  if (result.error) showToast(result.error)
}

// 팩에서 레포 빼기 — 무엇이 지워지는지 · 레포 폴더는 그대로 · 자동 백업을 알리고 확인
async function removeRepoFromPack(name) {
  const behind = await studio.packBodyBehind()
  const ok = await packDialog({
    title: say('spaces.removeRepoTitle', { repo: name }),
    body: [el('p', null, say('spaces.removeRepoBody')), el('p', 'muted', say('spaces.removeRepoNote')), ...(behind ? [el('p', 'muted', say('pack.catchUp.notice'))] : [])],
    actions: [{ label: say('spaces.removeRepoYes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }],
  })
  if (!ok) return
  showPackProgress(say('spaces.removeRepoProgress', { repo: name }), false)
  const result = await studio.packRemoveRepo(name)
  hidePackProgress()
  if (!result.ok) return packAlert(say('spaces.removeRepoFailed'), result.text || result.message)
  await refreshPackRepos()
  showToast(say('spaces.removeRepoDone', { repo: name }), 'success')
}

// spaces + 로 팩에 없는 git 레포를 골랐다 — 팩에 더할지(에이전트 · 지식 뼈대 · 아테나가 채움) 터미널만 열지
async function offerAddRepo({ dir, name }) {
  const behind = await studio.packBodyBehind()
  const choice = await packDialog({
    title: say('spaces.addRepoTitle', { repo: name }),
    subtitle: say('spaces.addRepoNote'),
    body: [el('p', 'muted', dir), ...(behind ? [el('p', 'muted', say('pack.catchUp.notice'))] : [])],
    actions: [{ label: say('spaces.addRepoYes'), value: 'add', kind: 'primary' }, { label: say('spaces.addRepoTerminal'), value: 'open' }, { label: say('common.cancel'), value: null }],
  })
  if (choice === 'open') {
    const opened = await studio.workspaceOpenDir(dir, estimateCells($('panes')))
    if (opened.error) showToast(say('spaces.createFailed', { message: opened.error }))
    return
  }
  if (choice !== 'add') return
  showPackProgress(say('spaces.addRepoProgress', { repo: name }), false)
  const result = await studio.packAddRepo(dir, null)
  hidePackProgress()
  if (!result.ok) return packAlert(say('spaces.addRepoFailed'), result.text || result.message)
  await refreshPackRepos()
  showToast(say(result.already ? 'spaces.addRepoAlready' : 'spaces.addRepoDone', { repo: result.repo.name }), 'success')
}

// 레포 에이전트 부르기 — 브랜치를 앱 팝업에서 고르고(최근 작업 브랜치 이어 쓰기 · 새 브랜치) 워크트리에 바로 띄운다. main 직접 레포는 묻지 않는다
async function callRepoAgent(repo) {
  const info = await studio.packCallInfo(repo.name)
  if (info.error) return showToast(info.error)
  let choice = { branch: '', reuse: false }
  if (!info.direct) {
    const rows = el('div', 'pack-links')
    for (const item of info.candidates) rows.append(popupOption('pack-command', `reuse:${item.branch}`, 'git', say('spaces.callReuse', { branch: item.branch }), candidateNote(item)))
    const meta = callMeta(info)
    const label = el('label', 'pack-look-label', say('spaces.callNewLabel'))
    label.htmlFor = 'pack-dialog-input'
    const slot = el('div')
    slot.dataset.inputSlot = ''
    const answer = await packDialog({
      title: say('spaces.callTitle', { repo: repo.name }),
      body: [meta, ...(info.candidates.length ? [rows] : []), label, slot],
      input: { placeholder: say('spaces.callNewPlaceholder'), code: true, label: say('spaces.callNewLabel') },
      actions: [{ label: say('spaces.callStart'), value: 'new', kind: 'primary' }, { label: say('common.cancel'), value: null }],
    })
    if (!answer) return
    const value = typeof answer === 'string' ? answer : answer.value
    if (value.startsWith('reuse:')) choice = { branch: value.slice(6), reuse: true }
    else if (answer.text && answer.text.trim()) choice = { branch: answer.text.trim(), reuse: false }
    else return showToast(say('spaces.callBadBranch'))
  }
  showPackProgress(say('spaces.callProgress', { agent: info.agent }), false)
  let result = await studio.packCallStart(repo.name, choice)
  hidePackProgress()
  // 새 이름인데 이미 있는 브랜치 — 이어 쓸지 한 번 더
  if (result.exists) {
    const again = await packDialog({ title: say('spaces.callExists', { branch: choice.branch }), body: [el('p', 'muted', result.message || '')], actions: [{ label: say('spaces.callReuseYes'), value: 'yes', kind: 'primary' }, { label: say('common.cancel'), value: null }] })
    if (!again) return
    showPackProgress(say('spaces.callProgress', { agent: info.agent }), false)
    result = await studio.packCallStart(repo.name, { branch: choice.branch, reuse: true })
    hidePackProgress()
  }
  if (result.error) return packAlert(say('spaces.callFailed'), result.error)
  showToast(say('spaces.called', { agent: result.agent, branch: result.branch || say('spaces.callDirect') }), 'success')
}

function renderSides() {
  // 왼쪽: 작업 공간(레포)만 — 그리기는 React(ui/spaces.tsx). 접기 · 펴기(collapsed 클래스)는 여기서
  const labels = new Set(screen.workspaces.map((workspace) => workspace.label))
  StudioUi.spaces.render({
    collapsed: $('spaces').classList.contains('collapsed'),
    tabKey: state.tabKey,
    active: screen.activeWorkspace,
    focused: screen.focused,
    workspaces: orderedWorkspaces().map((workspace) => {
      const athena = isAthenaWorkspace(workspace)
      // 아테나 작업 공간은 같은 이름 팩 레포가 있어도 그 이름 · 이미지 · 메뉴를 쓰지 않는다
      const repo = athena ? null : packRepoOf(workspace.label)
      return { id: workspace.id, label: workspace.label, cwd: workspace.cwd, athena, repo, branch: branches[workspace.id] || null, panes: workspacePanes(workspace.id) }
    }),
    idleRepos: packRepos.filter((repo) => !labels.has(repo.name)),
    paneStatus,
  })

  // 오른쪽: 지금 작업 공간의 Explorer — 작업 공간이 바뀌면 따라간다
  if (StudioUi.explorer.workspace() !== screen.activeWorkspace) StudioUi.explorer.reset(screen.activeWorkspace)
}

// 왼쪽 작업 공간 목록(React)에 넘기는 바닐라 도우미 · 누른 뒤의 일
function spacesActions() {
  return {
    spaceColor,
    spaceInitials,
    paneRow: StudioSpaceNames.paneRow,
    foldIcons: { paths: PANEL_ICONS.left, fill: PANEL_FILLS.left },
    toWork: () => {
      if (currentTab !== 'work') switchTab('work')
    },
    selectWorkspace: (id) => studio.workspaceSelect(id),
    selectPane: async (pane) => {
      await studio.tabSelect(pane.tab)
      focusPane(pane.id)
    },
    newWorkspace: () => runCommand('new-workspace'),
    setCollapsed: setSpacesCollapsed,
    menu: (target, event) => spaceMenu({ workspace: screen.workspaces.find((workspace) => workspace.id === target.workspace) || null, repo: target.repo }, event),
    callRepo: (repo) => runPackFlow(() => callRepoAgent(repo)),
    iconLoaded: () => {
      if (attached) renderSides()
    },
  }
}

// ── 오른쪽 Explorer (파일 · 변경) ──
// 칸 몸통(머리줄 · 폴더 트리 · 변경 목록)과 그 상태 · 읽기는 React(ui/explorer.tsx · PR-R9). 여기는 껍데기 — 접기 · 펴기 · 3초 타이머 · 미리보기(뷰어)
function explorerActions() {
  return {
    workspaceOf: (id) => screen.workspaces.find((entry) => entry.id === id),
    tabKey: () => state.tabKey,
    foldIcon: PANEL_ICONS.right,
    openPreview,
    collapse: () => setPanelHidden(true),
  }
}

// 선 아이콘(24 격자 · 글자색을 따름)
function lineIcon(paths) {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const shape of paths) {
    const path = document.createElementNS(svgNs, 'path')
    path.setAttribute('d', shape)
    svg.append(path)
  }
  return svg
}

// 미리보기(뷰어) — VSCode 처럼 확장자에 맞는 색(Dark+)과 줄 번호. 바뀐 파일은 diff(옛·새 번호 · 추가 초록 · 삭제 빨강), 이미지는 그림.
// 터미널 pane 옆에 나눠 띄우고(터미널은 줄어든 폭으로 다시 맞춘다) Esc · ✕ 로 닫는다
const FONT_STYLE = { italic: 1, bold: 2, underline: 4 }

function viewerLine(row, diff) {
  const line = document.createElement('div')
  line.className = `vl ${row.kind}`
  const number = (value) => {
    const cell = document.createElement('span')
    cell.className = 'no'
    cell.textContent = value === undefined ? '' : String(value)
    return cell
  }
  const code = document.createElement('span')
  code.className = 'code'
  if (row.kind === 'hunk' || !row.tokens) {
    code.textContent = row.code || ' '
  } else {
    for (const [text, color, style] of row.tokens) {
      const piece = document.createElement('span')
      piece.textContent = text
      if (color) piece.style.color = color
      if (style & FONT_STYLE.italic) piece.style.fontStyle = 'italic'
      if (style & FONT_STYLE.bold) piece.style.fontWeight = 'bold'
      if (style & FONT_STYLE.underline) piece.style.textDecoration = 'underline'
      code.append(piece)
    }
    if (!row.tokens.length) code.textContent = ' '
  }
  const sign = document.createElement('span')
  sign.className = 'sign'
  sign.textContent = { add: '+', del: '-' }[row.kind] || ''
  line.append(...(diff ? [number(row.oldNo), number(row.newNo), sign] : [number(row.newNo)]), code)
  return line
}

async function openPreview(relative) {
  const result = await studio.explorerOpen(StudioUi.explorer.workspace(), relative)
  const body = $('preview-body')
  const preview = $('preview')
  $('preview-title').textContent = result.path || relative
  const note = (text) => {
    const line = document.createElement('div')
    line.className = 'note'
    line.textContent = text
    return line
  }
  body.className = 'preview-body'
  body.style.background = ''
  body.style.color = ''
  if (result.error) body.replaceChildren(note(result.error))
  else if (result.kind === 'binary') body.replaceChildren(note(say('preview.binary', { size: result.size })))
  else if (result.kind === 'image') {
    const image = document.createElement('img')
    image.className = 'viewer-image'
    image.alt = result.path
    image.src = result.src
    body.className = 'preview-body image'
    body.replaceChildren(image)
  } else {
    const diff = result.kind === 'diff'
    // 바탕은 터미널과 같게(CSS --bg) — 글자색만 테마(Shiki)를 따른다
    if (result.fg) body.style.color = result.fg
    body.replaceChildren(...result.rows.map((row) => viewerLine(row, diff)))
    if (result.untracked) body.prepend(note(say('preview.untracked')))
    if (result.truncated) body.append(note(say('preview.truncated')))
  }
  preview.hidden = false
  body.scrollTop = 0
  preview.focus()
}

function closePreview() {
  $('preview').hidden = true
  const focused = views.get(screen.focused)
  if (focused) focused.term.focus()
}

// 오른쪽 Explorer 접기·펴기(⌘⌥B) — 접으면 좁은 줄만 남는다. 앱을 다시 켜도 기억한다
function setPanelHidden(hidden) {
  $('side-panel').hidden = hidden
  $('side-rail').hidden = !hidden
  localStorage.setItem('studio.panelHidden', hidden ? '1' : '0')
  if (!hidden) StudioUi.explorer.render()
  requestAnimationFrame(layoutPanes)
}

// 저장된 접기 설정대로 양쪽을 맞춘다 — 시작 화면(팩 고르기) 동안은 저장값과 상관없이 양쪽을 접는다(저장은 안 바꾼다 · 들어가면 원래대로)
function applySideFolds() {
  const welcome = welcomeShown()
  const panelHidden = welcome || localStorage.getItem('studio.panelHidden') === '1'
  $('spaces').classList.toggle('collapsed', welcome || localStorage.getItem('studio.spacesCollapsed') === '1')
  $('side-panel').hidden = panelHidden
  $('side-rail').hidden = !panelHidden
  if (!attached) return
  renderSides()
  if (!panelHidden) StudioUi.explorer.render()
  requestAnimationFrame(layoutPanes)
}

// 왼쪽 작업 공간 접기·펴기(⌘B) — 접으면 아이콘 줄
function setSpacesCollapsed(collapsed) {
  $('spaces').classList.toggle('collapsed', collapsed)
  localStorage.setItem('studio.spacesCollapsed', collapsed ? '1' : '0')
  renderSides()
  requestAnimationFrame(layoutPanes)
}

// 트리 → 픽셀 사각형. 보이는 pane 만 fit 하고, 칸 수가 바뀐 것만 데몬에 알린다
function layoutPanes() {
  if (panels.work.hidden) return
  // 하단 칸(에이전트 모니터)은 작업 공간이 있으면 어느 공간이든 — 공간이 없으면 그 높이만큼 pane 이 길어진다. 높이를 재기 전에 정한다
  const showDock = Boolean(activeWorkspace())
  $('dock').hidden = !showDock
  if (!showDock && $('dock').contains(document.activeElement)) document.activeElement.blur()
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
    const info = meta.get(paneId) || {}
    view.headLabel.textContent = info.label || info.title || paneId
    syncDetailButton(paneId, view)
    if (!view.shown) redrawAfterHidden(view)
    view.shown = true
    // 크기는 재기만 하고 xterm 은 데몬이 pty · 화면 버퍼에 적용했다고 답할 때(pane:resized) 바꾼다.
    // 여기서 먼저 바꾸면 그 사이 출력이 이 창과 데몬 버퍼에서 다른 폭으로 그려져 갈라진다 — Claude Code 가 다시 그릴 때 엉뚱한 줄을 지워 화면이 겹친다
    let size = null
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

function sendPaneSize(paneId, view, info) {
  const want = view.want
  // 날아간 요청이 있거나 앞 크기의 다시 그리기를 기다리는 중(holdForRedraw)이면 나중에 — 답 · releaseHold 가 최신 크기로 다시 부른다
  if (!want || view.resizing || view.hold) return
  // 데몬이 스스로 바꾼 크기(분할 · pane 종료 때 탭 크기로 어림한 fitTab — pane 머리 줄을 빼지 않아 몇 줄 크다)도 다시 맞춘다
  const drifted = Boolean(info) && info.cols > 1 && (info.cols !== want.cols || info.rows !== want.rows)
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
function holdForRedraw(paneId, view) {
  if (!view.hold) {
    const live = view.term.element && view.term.element.querySelector('.xterm-screen')
    if (!live) return false
    // 복제한 화면을 칸 전체를 덮는 틀에 넣는다 — 글을 아래에 붙인 화면(screen-bottom)이면 틀 아래에 붙여서 덮는 순간 · 걷는 순간 위아래로 안 튄다
    const still = document.createElement('div')
    still.className = 'pane-still'
    still.style.background = view.term.options.theme.background
    still.append(live.cloneNode(true))
    view.term.element.append(still)
    view.hold = { still }
  }
  // 덮은 중에 또 크기가 오면(답이 늦어 다시 보낸 것 등) 걷으려던 것을 멈추고 이번 크기부터 다시 센다
  view.hold.releasing = false
  clearTimeout(view.hold.timer)
  view.hold.start = performance.now()
  view.hold.timer = setTimeout(() => releaseHold(paneId, view), RESIZE_HOLD_MAX_MS)
  return true
}

function holdOutputArrived(paneId, view) {
  clearTimeout(view.hold.timer)
  const left = RESIZE_HOLD_MAX_MS - (performance.now() - view.hold.start)
  view.hold.timer = setTimeout(() => releaseHold(paneId, view), Math.max(0, Math.min(RESIZE_HOLD_QUIET_MS, left)))
}

function releaseHold(paneId, view) {
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
function focusCurrentTerminal() {
  const focused = views.get(screen.focused)
  if (focused && !focused.el.hidden && currentTab === 'work' && !usingBrowser()) focused.term.focus()
}

// 옆 브라우저를 쓰는 중인가 — 주소창에 치는 중이거나 서랍 안 페이지(앱 화면 밖이라 문서가 포커스를 잃는다)를 보는 중이면 터미널로 포커스를 뺏지 않는다
function usingBrowser() {
  return browserOpen && (!document.hasFocus() || $('browser').contains(document.activeElement))
}

// ── 에이전트 모니터(가운데 맨 아래) ─────────────────────────
// main 이 Claude 기록을 따라 읽어 세션 · 이벤트를 보낸다(보일 때만). 칩 · 로그 그리기는 React(ui/monitor.tsx) — 여기는 껍데기(보이기 · 접기 · 알림 받기 · 타이머)
let monitorVisible = null

function setMonitorVisible(visible) {
  if (monitorVisible === visible) return
  monitorVisible = visible
  studio.monitorWatch(visible)
}

function initMonitor() {
  const dock = $('dock')
  dock.classList.toggle('collapsed', localStorage.getItem('studio.monitorCollapsed') === '1')
  $('monitor-fold').addEventListener('click', () => {
    const collapsed = !dock.classList.contains('collapsed')
    dock.classList.toggle('collapsed', collapsed)
    localStorage.setItem('studio.monitorCollapsed', collapsed ? '1' : '0')
  })
  StudioUi.monitor.mount($('monitor-sessions'), $('monitor-feed'), { spaceColor })
  studio.onMonitorUpdate(StudioUi.monitor.update)
  // 'n분 전' 을 새로 쓰고, 조용해진 에이전트의 칩을 뺀다(고른 칩이 빠지면 전체 로그로)
  setInterval(() => {
    if (!monitorVisible) return
    StudioUi.monitor.tick()
  }, 30000)
}

// ── pane 경계 끌기 ───────────────────────────────────────
// 비율은 데몬 탭 트리에 저장한다(tab ratio). 끄는 동안과, 옛 데몬이 그 동작을 모를 때는 화면이 임시로 기억한다(ratioOverrides).
// 임시 비율은 트리 모양(비율 뺀)이 같을 때만 쓴다 — 나누거나 닫아 모양이 바뀌면 버린다
const ratioOverrides = new Map() // `${tabId}|${path}` → { ratio, shape }
let dividerDrag = null // { tabId, shape, element, pointerId, ratio, cancel }
let ratioUnsupportedNoticed = false

const treeShape = (tree) => JSON.stringify(tree, (key, value) => (key === 'ratio' ? undefined : value))

function treeForLayout(tab) {
  let tree = tab.tree
  const shape = treeShape(tab.tree)
  for (const [key, override] of ratioOverrides) {
    const [tabId, path] = key.split('|')
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
const dividerElements = new Map() // path → element(element.divider 가 지금 경계)

function renderDividers(tab, tree, area) {
  const container = $('panes')
  // 닫힌 탭의 임시 비율은 버린다
  const tabIds = new Set(screen.tabs.map((entry) => entry.id))
  for (const key of ratioOverrides.keys()) if (!tabIds.has(key.split('|')[0])) ratioOverrides.delete(key)
  // 끄는 중에 탭이 바뀌었거나 pane 이 생기고 닫혀 트리 모양이 바뀌면 끌기를 취소한다(다른 경계에 저장되지 않게)
  if (dividerDrag && (!tab || tab.id !== dividerDrag.tabId || treeShape(tab.tree) !== dividerDrag.shape)) cancelDividerDrag()
  const found = tab && tree ? StudioLayout.dividers(tree, area, PANE_GAP) : []
  const alive = new Set()
  for (const divider of found) {
    const key = divider.path.join('.')
    alive.add(key)
    let element = dividerElements.get(key)
    if (!element) {
      element = document.createElement('div')
      element.title = say('pane.resizeHint')
      element.addEventListener('pointerdown', (event) => startDividerDrag(event, element))
      element.addEventListener('dblclick', () => {
        const current = activeTab()
        if (current && element.divider) commitRatio(current, element.divider.path, StudioLayout.DEFAULT_RATIO)
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
function placeDivider(element, divider) {
  const { line } = divider
  const grab = 3
  const box = divider.split === 'right'
    ? { left: line.x - grab, top: line.y, width: line.width + grab * 2, height: line.height }
    : { left: line.x, top: line.y - grab, width: line.width, height: line.height + grab * 2 }
  Object.assign(element.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
}

function startDividerDrag(event, element) {
  const tab = activeTab()
  if (event.button !== 0 || !tab || !element.divider || dividerDrag) return
  event.preventDefault()
  element.setPointerCapture(event.pointerId)
  element.classList.add('dragging')
  const path = element.divider.path
  const key = `${tab.id}|${path.join('.')}`
  const shape = treeShape(tab.tree)
  let frame = 0
  const move = (moveEvent) => {
    if (!dividerDrag || moveEvent.pointerId !== dividerDrag.pointerId) return
    const origin = $('panes').getBoundingClientRect()
    const divider = element.divider
    const pos = divider.split === 'right' ? moveEvent.clientX - origin.left : moveEvent.clientY - origin.top
    dividerDrag.ratio = StudioLayout.ratioAt(divider, pos, PANE_GAP)
    ratioOverrides.set(key, { ratio: dividerDrag.ratio, shape })
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      layoutPanes()
    })
  }
  const abort = (cancelEvent) => {
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
  const finish = (upEvent) => {
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

function cancelDividerDrag() {
  if (dividerDrag) dividerDrag.cancel()
}

// 데몬에 저장 — 되면 임시 비율을 지우고(데몬 상태에 들어 있다), 옛 데몬이면 임시로 두고 한 번 알린다
async function commitRatio(tab, path, ratio) {
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
  } else if (ratioOverrides.get(key) && ratioOverrides.get(key).ratio === ratio) {
    ratioOverrides.delete(key)
  }
  layoutPanes()
}

// 탭 전체 크기(칸) — 앱이 없을 때 CLI 로 나눠도 데몬이 크기를 맞게 나누도록
function reportTabSize(tab, container) {
  const size = estimateCells(container)
  if (!tab || !size) return
  if (lastTabSize && lastTabSize.tab === tab.id && lastTabSize.cols === size.cols && lastTabSize.rows === size.rows) return
  lastTabSize = { tab: tab.id, ...size }
  studio.tabSize(tab.id, size)
}

// 보이는 터미널 하나로 글자 칸 크기를 재서 영역을 칸으로. 아직 없으면 대략(13px 글꼴)
function estimateCells(container) {
  const sample = [...views.values()].find((view) => !view.el.hidden && view.term.cols > 1)
  const cellWidth = sample ? sample.term.element.querySelector('.xterm-screen').clientWidth / sample.term.cols : 7.8
  const cellHeight = sample ? sample.term.element.querySelector('.xterm-screen').clientHeight / sample.term.rows : 17
  if (!cellWidth || !cellHeight) return null
  return { cols: Math.max(2, Math.floor(container.clientWidth / cellWidth)), rows: Math.max(2, Math.floor((container.clientHeight - HEAD_HEIGHT) / cellHeight)) }
}

function focusPane(paneId) {
  if (!views.has(paneId)) return
  screen = { ...screen, focused: paneId }
  studio.paneFocus(paneId)
  for (const [id, view] of views) view.el.classList.toggle('focused', id === paneId)
  StudioUi.spaces.focus(paneId) // 왼쪽 pane 줄 표시(React)
  views.get(paneId).term.focus()
}

// 데몬에 붙기 — 상태 + pane 마다 되살릴 화면. 그동안 온 출력은 화면에 이미 들어 있어 버린다
async function attach() {
  if (attaching) return attaching
  attaching = (async () => {
    const result = await studio.screenAttach()
    if (result.error) {
      showScreenStatus(result.error)
      return false
    }
    for (const paneId of [...views.keys()]) disposeView(paneId)
    // 되살릴 화면은 데몬이 가진 크기로 직렬화됐다 — 그 크기로 먼저 쓰고, 그다음 창에 맞춰 다시 맞춘다(먼저 맞추면 줄이 다른 폭에서 꺾여 깨진다)
    screen = result.state
    for (const pane of screen.panes.filter(isTabPane)) {
      const view = ensureView(pane.id)
      if (pane.cols > 1 && pane.rows > 1) view.term.resize(pane.cols, pane.rows)
      if (result.snapshots[pane.id]) view.term.write(result.snapshots[pane.id])
    }
    applyState(result.state)
    attached = true
    reattachOnKey = false
    $('screen-status').hidden = true
    return true
  })().finally(() => (attaching = null))
  return attaching
}

function reattach() {
  reattachOnKey = false
  attach()
}

function showScreenStatus(message) {
  const status = $('screen-status')
  status.textContent = message
  status.hidden = false
}

async function newTab() {
  const result = await studio.tabNew(estimateCells($('panes')))
  if (result.error) showToast(say('tab.openFailed', { message: result.error }))
}

async function splitPane(paneId, direction) {
  const result = await studio.paneSplit(paneId, direction)
  if (result.error) showToast(say('pane.splitFailed', { message: result.error }))
}

// pane 우클릭 메뉴(main) — 대상은 포커스된 pane 이 아니라 우클릭한 그 pane
async function paneMenu(paneId, event) {
  if (!state || !state.valid || !attached) return
  const action = await studio.paneContextMenu({ x: Math.round(event.clientX), y: Math.round(event.clientY) })
  if (action === 'split-right' || action === 'split-down') return splitPane(paneId, action === 'split-down' ? 'down' : 'right')
  if (action === 'close-pane') return studio.paneClose(paneId)
}

// 메뉴 단축키(⌘T · ⌘D · ⌘⇧D · ⌘W · ⌘⌥방향 · ⌘⇧[ ]) — Ctrl 은 pane 안으로 간다
async function runCommand(name) {
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
    return studio.tabSelect(tabsHere[(index + step + tabsHere.length) % tabsHere.length].id)
  }
  if (name === 'workspace-prev' || name === 'workspace-next') {
    const ordered = orderedWorkspaces()
    const index = ordered.findIndex((workspace) => workspace.id === screen.activeWorkspace)
    if (index < 0) return undefined
    const step = name === 'workspace-next' ? 1 : -1
    return studio.workspaceSelect(ordered[(index + step + ordered.length) % ordered.length].id)
  }
  if (name === 'close-tab') {
    const current = activeTab()
    if (current) await studio.tabClose(current.id)
    return undefined
  }
  if (name === 'new-workspace') {
    const result = await studio.workspaceNew(estimateCells($('panes')))
    if (result.askAdd) return runPackFlow(() => offerAddRepo(result))
    if (result.error) showToast(say('spaces.createFailed', { message: result.error }))
    return undefined
  }
  if (name === 'toggle-panel') return setPanelHidden(!$('side-panel').hidden)
  if (name === 'toggle-spaces') return setSpacesCollapsed(!$('spaces').classList.contains('collapsed'))
  return undefined
}

function tabPaneForCommand() {
  const tab = activeTab()
  if (!tab) return null
  const ids = StudioLayout.paneIds(tab.tree)
  return ids.includes(screen.focused) ? screen.focused : ids[0] || null
}

async function startScreen() {
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
let restoreArmed = false
async function openAgent(options) {
  const restoring = restoreArmed
  restoreArmed = false
  if (restoring) showPackProgress(say('pack.restore.progress'), false)
  const result = await studio.openAgent(estimateCells($('panes')), options)
  if (restoring) hidePackProgress()
  if (result.error) showToast(result.error)
  if (result.restore) showRestoreResult(result.restore)
  return result
}

// 되살린 결과 — 다 됐으면 알림 한 줄, 못 한 것이 있으면 항목마다 이유
function showRestoreResult(result) {
  if (!result.ok) return packAlert(say('pack.restore.failed'), result.text || result.message)
  const worktrees = result.worktrees || []
  const sessions = result.sessions || []
  const counts = {
    worktrees: worktrees.filter((item) => item.status === 'done').length,
    agents: sessions.filter((item) => item.status === 'done').length,
    athena: (result.athena || []).length,
  }
  const problems = [...worktrees, ...sessions].filter((item) => item.status !== 'done')
  const renamed = worktrees.filter((item) => item.renamed).map((item) => say('pack.restore.renamed', { name: item.name, branch: item.renamed }))
  if (!problems.length && !renamed.length) return showToast(say('pack.restore.done', counts), 'success')
  const lines = problems.map((item) => `· ${item.name || item.agent}: ${item.message || item.reason}`)
  return packAlert(problems.length ? say('pack.restore.partial') : say('pack.restore.done', counts), [say('pack.restore.done', counts), ...renamed, ...lines].join('\n'))
}

// 알림은 pane 위에 따로 띄운다 — kind: error(기본 · ✕ 로 닫을 때까지) · success(4초) · info(6초). 마우스를 올려 두면 기다린다
const TOAST_MS = { success: 4000, info: 6000 }
let toastTimer = null
function showToast(message, kind = 'error') {
  const toast = $('toast')
  clearTimeout(toastTimer)
  const icon = el('span', 'toast-icon', kind === 'success' ? '✓' : kind === 'info' ? 'i' : '!')
  icon.setAttribute('aria-hidden', 'true')
  const text = el('span', 'toast-message', message)
  const close = el('button', 'toast-close')
  close.append(lineIcon(POPUP_ICONS.close))
  close.type = 'button'
  close.setAttribute('aria-label', say('common.close'))
  const hide = () => {
    clearTimeout(toastTimer)
    toast.hidden = true
  }
  close.addEventListener('click', hide)
  const wait = () => {
    clearTimeout(toastTimer)
    if (TOAST_MS[kind]) toastTimer = setTimeout(hide, TOAST_MS[kind])
  }
  toast.onmouseenter = () => clearTimeout(toastTimer)
  toast.onmouseleave = wait
  toast.dataset.kind = kind
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  toast.replaceChildren(icon, text, close)
  toast.hidden = false
  wait()
}

// ── 옆 브라우저 ──────────────────────────────────────────
// 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그린다 — 화면 위에 따로 떠 있어서
// 다 나온 뒤에 자리(#browser-slot)를 알려 붙이고, 닫을 땐 먼저 떼고 미끄러져 들어간다
const BROWSER_SLIDE_MS = 240
let browserOpen = false
let browserTimer = null
let urlFocusTimer = null

function openBrowserPanel() {
  if (welcomeShown()) return // 팩을 고르기 전에는 옆 브라우저를 열지 않는다(⌘⇧B · 링크 열기 포함)
  const panel = $('browser')
  if (browserOpen) return placeBrowserView()
  browserOpen = true
  clearTimeout(browserTimer)
  panel.hidden = false
  $('browser-toggle').classList.add('active')
  $('browser-toggle').setAttribute('aria-expanded', 'true')
  void panel.offsetWidth // 숨김을 푼 뒤 한 번 그려야 transform 이 스르륵 움직인다
  panel.classList.add('open')
  browserTimer = setTimeout(() => {
    browserTimer = null
    placeBrowserView()
  }, BROWSER_SLIDE_MS)
}

function closeBrowserPanel() {
  const panel = $('browser')
  if (!browserOpen) return
  browserOpen = false
  clearTimeout(browserTimer)
  clearTimeout(urlFocusTimer)
  studio.browserHide()
  panel.classList.remove('open', 'resizing')
  $('browser-toggle').classList.remove('active')
  $('browser-toggle').setAttribute('aria-expanded', 'false')
  // 닫으면 작업 창 터미널로 입력을 돌려준다
  const focused = views.get(screen.focused)
  if (currentTab === 'work' && focused && !focused.el.hidden) focused.term.focus()
  browserTimer = setTimeout(() => {
    browserTimer = null
    panel.hidden = true
  }, BROWSER_SLIDE_MS)
}

// 다 나온 서랍의 자리 — 슬라이드 중(transform)이면 아직 붙이지 않는다
function placeBrowserView() {
  if (modalOpen()) return // 대화상자 위를 덮지 않게 — 닫힐 때 syncModal 이 다시 붙인다
  if (!browserOpen || browserTimer || $('browser').hidden || $('browser').classList.contains('resizing')) return
  const rect = $('browser-slot').getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  studio.browserPlace({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
}

function toggleBrowserPanel() {
  if (browserOpen) return closeBrowserPanel()
  openBrowserPanel()
  // 처음이면 주소창부터 — 다 나온 뒤에, 스크롤 없이(나오는 중에 포커스를 주면 뒤 화면이 밀린다).
  // 그사이 닫았거나 다른 곳을 눌렀으면 하지 않는다
  if ($('browser-url').value) return
  clearTimeout(urlFocusTimer)
  const before = document.activeElement
  urlFocusTimer = setTimeout(() => {
    if (browserOpen && document.activeElement === before) $('browser-url').focus({ preventScroll: true })
  }, BROWSER_SLIDE_MS)
}

async function browserNavigate() {
  const input = $('browser-url')
  const result = await studio.browserCommand('navigate', input.value)
  showBrowserError(result.error || '')
  if (!result.error) input.blur()
}

function showBrowserError(message) {
  const error = $('browser-error')
  error.textContent = message
  error.hidden = !message
  // 알림 줄이 생기거나 없어지면 페이지 자리가 바뀐다
  requestAnimationFrame(placeBrowserView)
}

function applyBrowserState(next) {
  const input = $('browser-url')
  if (document.activeElement !== input) input.value = next.url || ''
  $('browser-back').disabled = !next.canGoBack
  $('browser-forward').disabled = !next.canGoForward
  $('browser-reload').textContent = next.loading ? '✕' : '⟳'
  $('browser-reload').title = next.loading ? say('browser.stop') : say('common.reload')
  $('browser').classList.toggle('loading', Boolean(next.loading))
  $('browser').title = next.title || ''
  if (next.loading) showBrowserError('')
}

// 너비 끌기 — 끄는 동안은 페이지(화면 위에 떠 있는 뷰)를 떼어 둔다. 마우스가 페이지 위로 지나가도 끌기가 이어지게
const BROWSER_MIN_WIDTH = 320
const BROWSER_EDGE_GAP = 120 // 왼쪽에 이만큼은 남긴다

function clampBrowserWidth(width) {
  return Math.round(Math.min(Math.max(width, BROWSER_MIN_WIDTH), Math.max(BROWSER_MIN_WIDTH, window.innerWidth - BROWSER_EDGE_GAP)))
}

function setBrowserWidth(width) {
  const panel = $('browser')
  if (width === null) {
    panel.style.width = ''
    localStorage.removeItem('studio.browserWidth')
  } else {
    panel.style.width = `${clampBrowserWidth(width)}px`
    localStorage.setItem('studio.browserWidth', String(clampBrowserWidth(width)))
  }
}

function initBrowserResize() {
  const panel = $('browser')
  const handle = $('browser-resize')
  // 저장된 너비(없으면 기본 46%)
  const applySaved = () => {
    const saved = Number(localStorage.getItem('studio.browserWidth'))
    panel.style.width = saved > 0 ? `${clampBrowserWidth(saved)}px` : ''
  }
  applySaved()
  let dragging = false
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !browserOpen) return
    dragging = true
    handle.setPointerCapture(event.pointerId)
    panel.classList.add('resizing')
    studio.browserHide()
    event.preventDefault()
  })
  handle.addEventListener('pointermove', (event) => {
    // 끄는 중에 서랍을 닫으면(resizing 이 지워짐) 끌기도 끝난 것
    if (dragging && panel.classList.contains('resizing')) panel.style.width = `${clampBrowserWidth(window.innerWidth - event.clientX)}px`
  })
  // 놓기 · 취소 · 캡처를 잃음 모두 여기로. 그사이 서랍을 닫았으면 너비는 저장하지 않는다
  const finish = (event) => {
    if (!dragging) return
    dragging = false
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    const stillResizing = panel.classList.contains('resizing')
    panel.classList.remove('resizing')
    // 끄다가 서랍을 닫았으면 끌던 너비는 버리고 저장된 너비로
    if (!browserOpen || !stillResizing) return applySaved()
    setBrowserWidth(panel.getBoundingClientRect().width)
    placeBrowserView()
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('lostpointercapture', finish)
  // 너비를 px 로 정해 두면 창을 늘려도 서랍 크기는 그대로라 ResizeObserver 가 안 불린다 — 창 크기가 바뀌면 다시 맞춰 붙인다
  window.addEventListener('resize', () => {
    if (panel.style.width) panel.style.width = `${clampBrowserWidth(parseFloat(panel.style.width))}px`
    placeBrowserView()
  })
  handle.addEventListener('dblclick', () => {
    setBrowserWidth(null)
    requestAnimationFrame(placeBrowserView)
  })
}

function initBrowser() {
  initBrowserResize()
  $('browser-toggle').addEventListener('click', toggleBrowserPanel)
  $('browser-close').addEventListener('click', closeBrowserPanel)
  $('browser-back').addEventListener('click', () => studio.browserCommand('back'))
  $('browser-forward').addEventListener('click', () => studio.browserCommand('forward'))
  $('browser-reload').addEventListener('click', () => studio.browserCommand($('browser').classList.contains('loading') ? 'stop' : 'reload'))
  $('browser-external').addEventListener('click', () => studio.browserCommand('external'))
  $('browser-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') browserNavigate()
    if (event.key === 'Escape') closeBrowserPanel()
  })
  $('browser-url').addEventListener('focus', () => $('browser-url').select())
  studio.onBrowserOpen((url) => {
    $('browser-url').value = url
    showBrowserError('')
    openBrowserPanel()
  })
  // 팩을 바꿨다 — 서랍을 닫고 주소 칸을 비운다(새 팩에서 열면 그 팩에서 보던 페이지로)
  studio.onBrowserReset(() => {
    if (browserOpen) closeBrowserPanel()
    $('browser-url').value = ''
    showBrowserError('')
  })
  studio.onBrowserToggle(toggleBrowserPanel)
  studio.onBrowserState(applyBrowserState)
  studio.onBrowserError(showBrowserError)
  studio.onBrowserClose(closeBrowserPanel) // 결정 콘솔 [이대로 진행] 을 보낸 뒤(main 이 알린다)
  // 창 크기가 바뀌면 서랍(너비 46%)도 바뀐다 — 다 나와 있을 때만 다시 붙인다
  new ResizeObserver(() => placeBrowserView()).observe($('browser-slot'))
}

// ── 탭 ──────────────────────────────────────────────────
// 일감은 앱 안에 띄우지 않고 기본 브라우저로 연다(⌘2 · 탭 줄 아이콘 · 트레이) — 작업 창에서는 작업만
function switchTab(name) {
  if (!state || !state.valid) return
  if (name === 'board') {
    if (!welcomeShown()) studio.openBoard() // 팩을 고르기 전에는 일감을 열지 않는다
    return
  }
  currentTab = 'work'
  studio.reportTab('work')
  panels.work.hidden = false
  requestAnimationFrame(layoutPanes)
}

// ── [작업] 팝업 · 일감 페이지 메뉴 ────────────────────────────
// 칸반 대신 탭 줄 [작업] — 나를 기다리는 것(사람에게 묻는 요청) · 진행 중 · 최근 끝난 것. 작업을 누르면 상세, 질문을 누르면 앱 안에서 바로 답한다.
// 요청 수는 main 이 요청 폴더를 보다가 바뀔 때 알린다(onWorkRequests) · 목록 전체는 팝업을 열 때 읽는다(일감을 띄운다)
let workRequests = { supported: false, requests: [] }
let workData = null // 마지막으로 읽은 목록(workGet) — 진행 중 숫자
const WORK_STATES = ['wait', 'work', 'blocked', 'idle', 'done']

function renderWorkTab() {
  const waiting = workRequests.requests.filter((request) => request.state === 'open').length
  // 숫자는 두지 않는다(사용자) — 있다는 것만 점으로, 수는 툴팁에
  $('work-ask').hidden = !waiting
  const doing = workData ? workData.counts.doing : 0
  $('work-tab').classList.toggle('asking', waiting > 0)
  $('work-tab').dataset.tip = say('work.tip', { doing, waiting })
}

// 탭 줄 버튼 아래에 붙인다 — 오른쪽 끝을 버튼 오른쪽에 맞춘다
function placeUnder(pop, button) {
  const rect = button.getBoundingClientRect()
  pop.style.top = `${Math.round(rect.bottom + 6)}px`
  pop.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`
}

let popBefore = null
function closePops() {
  for (const [pop, button] of [['work-pop', 'work-tab'], ['board-menu', 'board-tab'], ['settings-pop', 'settings-tab']]) {
    if ($(pop).hidden) continue
    $(pop).hidden = true
    if (pop === 'settings-pop') StudioUi.settings.close() // React 몸통을 내린다(다음에 열 때 읽는 중부터)
    if (pop === 'work-pop') StudioUi.work.close()
    $(button).setAttribute('aria-expanded', 'false')
    $(button).classList.remove('active')
  }
  if (popBefore instanceof HTMLElement && popBefore.isConnected) popBefore.focus({ preventScroll: true })
  popBefore = null
}
function openPop(pop, button) {
  closePops()
  popBefore = document.activeElement
  placeUnder($(pop), $(button))
  $(pop).hidden = false
  $(button).setAttribute('aria-expanded', 'true')
  $(button).classList.add('active')
}

// 몸통(work-pop-body)은 React(ui/work-pop.tsx) — 여기는 머리줄 팩 이름과 그릴 값 넘기기만
function renderWorkPop() {
  $('work-pop-title').textContent = say('work.popTitle', { pack: (packs.current && packLabel(packs.current)) || '' })
  StudioUi.work.setWork(workData, workData ? workData.requests : workRequests.requests)
}

async function toggleWorkPop() {
  if (!$('work-pop').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('work-pop', 'work-tab')
  renderWorkPop()
  StudioUi.work.open($('work-pop-body'), { openRequest, openWorkDetail })
  const first = $('work-pop-body').querySelector('button')
  if (first) first.focus({ preventScroll: true })
  workData = await studio.workGet()
  if ($('work-pop').hidden) return renderWorkTab()
  if (workData && Array.isArray(workData.requests)) workRequests = { supported: workData.supported, requests: workData.requests }
  renderWorkTab()
  renderWorkPop()
}

function toggleBoardMenu() {
  if (!$('board-menu').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('board-menu', 'board-tab')
  $('board-menu').querySelector('button').focus({ preventScroll: true })
}

// 작업 상세 — 계획서에서 왜 · 정한 것 · 진행 · 검증 · 결과 · 다음
async function openWorkDetail(item) {
  closePops()
  const detail = await studio.workDetail(item.id)
  const body = []
  if (!detail || !detail.ok) body.push(el('p', 'muted', say('work.detail.unreadable')))
  else {
    const field = (key, value) => {
      if (!value || (Array.isArray(value) && !value.length)) return
      const row = el('div', 'work-field')
      row.append(el('span', 'work-field-key', say(`work.detail.${key}`)))
      const text = el('span', 'work-field-value')
      if (Array.isArray(value)) text.append(...value.map((line) => el('span', 'work-field-line', line)))
      else text.textContent = value
      row.append(text)
      body.push(row)
    }
    field('why', detail.why)
    field('blocked', detail.blocked)
    field('decided', detail.decided)
    if (detail.progress.total) {
      const row = el('div', 'work-field')
      row.append(el('span', 'work-field-key', say('work.detail.progress')))
      const value = el('span', 'work-field-value', `${detail.progress.checked}/${detail.progress.total}${detail.progress.now ? ` · ${detail.progress.now}` : ''}`)
      const bar = el('span', 'work-steps')
      for (let index = 0; index < detail.progress.total; index += 1) bar.append(el('i', index < detail.progress.checked ? 'done' : index === detail.progress.checked ? 'now' : ''))
      value.append(bar)
      row.append(value)
      body.push(row)
    }
    field('validation', detail.validation)
    field('results', detail.results)
    field('next', detail.next)
  }
  const actions = [{ label: say('work.detail.openPlan'), value: 'plan' }]
  if (item.html) actions.push({ label: say('work.detail.console'), value: 'console' })
  const pane = item.agents.find(paneLive)
  if (pane) actions.push({ label: say('work.detail.goPane'), value: 'pane', kind: 'primary' })
  const choice = await packDialog({ title: item.title, subtitle: say(`work.state.${item.state}`), body, actions, close: true })
  if (choice === 'plan') studio.workOpenPlan(item.id, null)
  else if (choice === 'console') studio.workOpenPlan(item.id, item.html)
  else if (choice === 'pane') goToPane(pane)
}

// ── pane [상세] ─────────────────────────────────────────────
// 계획서에 묶인 pane(그 계획서를 하는 에이전트 · 맡긴 아테나) 머리 줄 오른쪽 아이콘 → 작업 창 위에 오른쪽에서 뜨는 팝업.
// 팝업은 레이아웃에 끼지 않는다(position: fixed) — pane · spaces · Explorer · 모니터 크기와 터미널 크기는 그대로.
// 몸통은 React(ui/pane-detail.tsx — 3초마다 다시 읽기 · [더 보기] · 뒤로 간 스크롤) · 여기는 껍데기(아이콘 · 열기 · 닫기 · 머리줄 · [← 맡긴 일])
let paneBound = {} // pane id → 'agent' | 'lead'
let detailPane = null
// 아테나 목록에서 들어온 상세면 돌아갈 자리 — { paneId, scroll } · 에이전트 pane 에서 바로 열면 null
let detailBack = null
// 아이콘 — 체크리스트 모양(사용자 확정 2026-10-27 · 시안 B)
const PANE_DETAIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2"/><circle cx="5" cy="18" r="1"/></svg>'

function paneDetailButton(paneId) {
  const button = el('button', 'pane-detail-btn')
  button.type = 'button'
  button.hidden = true
  button.innerHTML = PANE_DETAIL_ICON
  button.title = say('pane.detail.open')
  button.setAttribute('aria-label', say('pane.detail.open'))
  button.setAttribute('aria-controls', 'pane-detail')
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    togglePaneDetail(paneId)
  })
  return button
}

function syncDetailButton(paneId, view) {
  view.detailButton.hidden = !paneBound[paneId]
  view.detailButton.setAttribute('aria-expanded', String(detailPane === paneId))
  view.detailButton.classList.toggle('active', detailPane === paneId)
}
function syncDetailButtons() {
  for (const [paneId, view] of views) syncDetailButton(paneId, view)
}

function togglePaneDetail(paneId) {
  if (detailPane === paneId) return closePaneDetail()
  return openPaneDetail(paneId)
}

// from: 아테나 목록에서 들어올 때 돌아갈 자리 · restore: 뒤로 가기로 돌아올 때 맞출 스크롤
function openPaneDetail(paneId, { from = null, restore = null } = {}) {
  closePops()
  const pop = $('pane-detail')
  const first = detailPane === null
  detailPane = paneId
  detailBack = from
  $('pane-detail-back').hidden = !detailBack
  const bar = document.querySelector('.tabbar')
  pop.style.top = `${Math.round(bar ? bar.getBoundingClientRect().bottom : 0)}px`
  // 처음이거나 다른 pane 이면 읽는 중부터 · 같은 pane 이면 그린 것을 두고 바로 다시 읽는다
  StudioUi.paneDetail.open($('pane-detail-body'), paneId, restore, paneDetailActions)
  if (first) {
    pop.hidden = false
    requestAnimationFrame(() => pop.classList.add('open'))
  }
  $('pane-detail-body').scrollTop = 0
  syncDetailButtons()
  $(detailBack ? 'pane-detail-back' : 'pane-detail-close').focus({ preventScroll: true })
}

function backPaneDetail() {
  if (!detailBack) return
  const { paneId, scroll } = detailBack
  // 그사이 아테나 pane 이 닫혔으면 돌아갈 목록이 없다 — 들어갈 때(paneLive)와 같이 본다
  if (!paneLive(paneId)) return closePaneDetail()
  return openPaneDetail(paneId, { restore: scroll })
}

function closePaneDetail() {
  if (detailPane === null) return
  detailPane = null
  detailBack = null
  // 다시 읽기는 바로 멈추고, 몸통은 미끄러져 나간 뒤 내린다
  StudioUi.paneDetail.stop()
  const pop = $('pane-detail')
  pop.classList.remove('open')
  setTimeout(() => {
    if (detailPane !== null) return
    pop.hidden = true
    StudioUi.paneDetail.close()
  }, 180)
  syncDetailButtons()
  focusCurrentTerminal()
}

// React 몸통이 부르는 바닐라 쪽 — 다른 pane 상세 · pane 으로 가기 · 요청 대화상자 · 머리줄 이름
const paneDetailActions = {
  openPane: (paneId, from) => openPaneDetail(paneId, { from }),
  goToPane: (paneId) => {
    closePaneDetail()
    goToPane(paneId)
  },
  paneLive: (paneId) => paneLive(paneId),
  openRequest: (id) => {
    const known = workRequests.requests.find((entry) => entry.id === id)
    if (known) openRequest(known)
  },
  setLabel: (text) => {
    $('pane-detail-pane').textContent = text
  },
}

// pane 이 다른 탭 · 작업 공간에 있어도 — 왼쪽 목록에서 누른 것과 같다
const paneLive = (paneId) => Boolean(paneId) && screen.panes.some((pane) => pane.id === paneId)
async function goToPane(paneId) {
  const pane = screen.panes.find((entry) => entry.id === paneId)
  if (!pane) return
  await studio.tabSelect(pane.tab)
  focusPane(pane.id)
}

// 질문 · 결정 — 질문은 앱 안에서 바로 답하고, 결정(정식 계획서)은 결정 콘솔로
async function openRequest(request) {
  closePops()
  if (request.kind === 'decision') {
    const choice = await packDialog({
      title: request.title,
      subtitle: say('work.kind.decision'),
      body: [el('p', 'work-request-body', request.body), el('p', 'muted', say('work.decisionNote'))],
      actions: [{ label: say('work.detail.console'), value: 'console', kind: 'primary' }],
      close: true,
    })
    if (choice === 'console') studio.workOpenPlan(request.plan || '', request.html)
    return
  }
  if (request.state === 'answered') {
    const answer = [request.answer && request.answer.choice, request.answer && request.answer.text].filter(Boolean).join(' · ')
    const choice = await packDialog({
      title: request.title,
      subtitle: say('work.notDelivered'),
      body: [el('p', null, say('work.answeredNote', { answer }))],
      actions: [{ label: say('work.resend'), value: 'resend', kind: 'primary' }],
      close: true,
    })
    if (choice === 'resend') reportDelivery(await studio.workRedeliver(request.id))
    return
  }
  const body = []
  if (request.body) body.push(el('p', 'work-request-body', request.body))
  let picked = (request.options.find((option) => option.recommended) || request.options[0] || {}).label || ''
  if (request.options.length) {
    const list = el('div', 'work-options')
    list.setAttribute('role', 'radiogroup')
    for (const option of request.options) {
      const row = el('button', 'work-option')
      row.type = 'button'
      row.setAttribute('role', 'radio')
      const sync = () => {
        for (const node of list.children) node.setAttribute('aria-checked', String(node === row))
      }
      const label = el('span', 'work-option-label', option.label)
      if (option.recommended) label.append(el('span', 'work-rec', say('work.recommended')))
      const text = el('span', null)
      text.append(label)
      if (option.desc) text.append(el('small', null, option.desc))
      row.append(el('span', 'work-radio'), text)
      row.setAttribute('aria-checked', String(option.label === picked))
      row.addEventListener('click', () => {
        picked = option.label
        sync()
      })
      list.append(row)
    }
    body.push(list)
  }
  const note = el('textarea', 'work-note')
  note.placeholder = say('work.notePlaceholder')
  note.maxLength = 1500
  body.push(note)
  const meta = [request.waited ? say('work.waited', { time: request.waited }) : ''].filter(Boolean).join(' · ')
  const actions = [{ label: say('work.send'), value: 'send', kind: 'primary' }]
  if (paneLive(request.pane)) actions.unshift({ label: say('work.detail.goPane'), value: 'pane' })
  const choice = await packDialog({ title: request.title, subtitle: [say('work.kind.question'), meta].filter(Boolean).join(' · '), body, actions, close: true })
  if (choice === 'pane') return goToPane(request.pane)
  if (choice !== 'send') return
  if (!picked && !note.value.trim()) return showToast(say('work.needAnswer'), 'info')
  const result = await studio.workAnswer(request.id, { choice: picked, text: note.value })
  if (!result || !result.ok) return showToast(say(result && result.error === 'conflict' ? 'work.answerConflict' : 'work.answerFailed', { message: (result && result.message) || '' }))
  reportDelivery(result)
}

// ── ⚙ 설정 팝업 — 이 창 팩의 레포별 PR 자동 리뷰 · 머지 + 앱 업데이트 ─────────────────────
// 몸통(settings-pop-body)은 React(ui/settings-pop.tsx) — 여기는 껍데기(열기 · 닫기 · 머리줄 팩 이름)와 ⚙ 의 업데이트 점만
function applyAppUpdate(next) {
  $('settings-tab').classList.toggle('has-update', Boolean(next && next.state === 'behind'))
  StudioUi.settings.setAppUpdate(next || null)
}

function toggleSettingsPop() {
  if (!$('settings-pop').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('settings-pop', 'settings-tab')
  $('settings-pop-pack').textContent = (packs.current && packLabel(packs.current)) || ''
  StudioUi.settings.open($('settings-pop-body'))
}

function reportDelivery(result) {
  if (!result || !result.ok) return showToast(say('work.answerFailed', { message: (result && result.message) || '' }))
  showToast(say(result.delivered ? 'work.sent' : 'work.savedNoPane'), result.delivered ? 'success' : 'info')
}

function initWork() {
  $('work-tab').addEventListener('click', toggleWorkPop)
  $('board-tab').addEventListener('click', toggleBoardMenu)
  $('settings-tab').addEventListener('click', toggleSettingsPop)
  studio.onAppUpdate(applyAppUpdate)
  studio.appUpdateStatus().then((next) => next && !next.error && applyAppUpdate(next))
  for (const item of document.querySelectorAll('#board-menu [data-section]')) {
    item.addEventListener('click', () => {
      closePops()
      studio.openBoardSection(item.dataset.section)
    })
  }
  $('diagrams-open').addEventListener('click', async () => {
    closePops()
    const result = await studio.openDiagrams()
    if (result && result.ok) return
    showToast(result && result.error === 'missing' ? say('board.diagramsMissing') : say('board.diagramsFailed', { message: (result && result.message) || '' }))
  })
  $('work-pop-pages').addEventListener('click', () => {
    closePops()
    openPop('board-menu', 'board-tab')
  })
  // 바깥을 누르거나 Esc — 닫는다(대화상자가 떠 있으면 대화상자가 Esc 를 먼저 받는다)
  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('#work-pop, #board-menu, #settings-pop, #work-tab, #board-tab, #settings-tab')) return
    closePops()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (!$('work-pop').hidden || !$('board-menu').hidden || !$('settings-pop').hidden)) {
      event.preventDefault()
      closePops()
    }
  })
  window.addEventListener('resize', closePops)
  // pane [상세] — 바깥을 누르거나 Esc 면 닫는다(다른 팝업과 같은 관례). 아이콘을 다시 눌러도 닫힌다
  document.addEventListener('mousedown', (event) => {
    if (detailPane === null || event.target.closest('#pane-detail, .pane-detail-btn')) return
    closePaneDetail()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || detailPane === null) return
    event.preventDefault()
    closePaneDetail()
  })
  $('pane-detail-close').addEventListener('click', closePaneDetail)
  $('pane-detail-back').addEventListener('click', backPaneDetail)
  studio.onPaneBound((next) => {
    paneBound = next && typeof next === 'object' ? next : {}
    syncDetailButtons()
  })
  studio.paneBound().then((next) => {
    paneBound = next && typeof next === 'object' ? next : {}
    syncDetailButtons()
  }).catch(() => {})
  studio.onWorkRequests((next) => {
    workRequests = next && Array.isArray(next.requests) ? next : { supported: false, requests: [] }
    if (workData) workData = { ...workData, requests: workRequests.requests.map((request) => ({ ...request, waited: (workData.requests.find((known) => known.id === request.id) || {}).waited || '' })) }
    renderWorkTab()
    if (!$('work-pop').hidden) renderWorkPop()
  })
  studio.onWorkOpen((id) => {
    const request = id && workRequests.requests.find((entry) => entry.id === id)
    if (request) return openRequest(request)
    if ($('work-pop').hidden) toggleWorkPop()
  })
  studio.workRequests().then((next) => {
    if (next && Array.isArray(next.requests)) workRequests = next
    renderWorkTab()
  })
  renderWorkTab()
}

// ── 회사 팩 ────────────────────────────────────────────────
// 본체가 여러 팩을 지원할 때만 보인다(packs.supported). 일은 main → 아테나 본체 명령이 하고, 화면은 묻고 · 기다리고 · 결과를 보여 준다
let packs = { supported: false }

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// 대화상자 · 진행 표시가 떠 있는 동안 — 뒤 화면은 inert(포커스 · 클릭 막기), 옆 브라우저는 네이티브 뷰라 위를 덮어서 잠깐 뗀다
const modalOpen = () => !$('pack-dialog').hidden || !$('pack-progress').hidden
function syncModal() {
  const open = modalOpen()
  for (const node of document.querySelectorAll('body > header, body > main')) node.inert = open
  if (!browserOpen) return
  if (open) studio.browserHide()
  else placeBrowserView()
}

// 대화상자 하나 — actions: [{ label, value, kind: 'primary'|'danger'|'link' }] · Esc 는 null.
// 버튼은 맥처럼 취소(value null) → 다른 것 → 확인 · 위험(맨 오른쪽) 순서로 놓는다. 위험이 있으면 처음 포커스는 취소에
// input: { value, placeholder, maxLength, label, code } — Enter 는 확인(primary) 버튼(한글 조합 중이면 무시)
// 이미 열린 것이 있으면 null 로 닫고 연다(앞 흐름이 영영 기다리지 않게)
let closeOpenDialog = null
function packDialog({ title, subtitle = '', body = [], actions = [], input = null, close = false }) {
  if (closeOpenDialog) closeOpenDialog(null)
  const dialog = $('pack-dialog')
  const before = document.activeElement
  $('pack-dialog-title').textContent = title
  const sub = $('pack-dialog-subtitle')
  sub.textContent = subtitle
  sub.hidden = !subtitle
  const bodyNode = $('pack-dialog-body')
  bodyNode.replaceChildren(...body.map((part) => (typeof part === 'string' ? el('p', null, part) : part)))
  let field = null
  if (input) {
    field = el('input', `pack-input${input.code ? ' code' : ''}`)
    field.id = 'pack-dialog-input'
    field.placeholder = input.placeholder || ''
    field.value = input.value || ''
    if (input.maxLength) field.maxLength = input.maxLength
    field.spellcheck = false
    field.autocomplete = 'off'
    field.setAttribute('aria-label', input.label || title)
    let place = field
    // input.error — 칸 아래 빨간 한 줄(고쳐 쓰면 사라진다)
    if (input.error) {
      place = el('div', 'pack-field')
      const error = el('p', 'pack-field-error', input.error)
      error.id = 'pack-dialog-input-error'
      error.setAttribute('role', 'alert')
      place.append(field, error)
      field.setAttribute('aria-invalid', 'true')
      field.setAttribute('aria-describedby', error.id)
      field.addEventListener('input', () => {
        error.remove()
        field.removeAttribute('aria-invalid')
      }, { once: true })
    }
    // 본문에 [data-input-slot] 이 있으면 그 자리에(이름 · 이미지처럼 칸이 옆에 붙는 대화상자)
    ;(bodyNode.querySelector('[data-input-slot]') || bodyNode).append(place)
  }
  const rank = (action) => (action.value === null ? 0 : action.kind === 'primary' || action.kind === 'danger' ? 2 : 1)
  const ordered = actions.map((action, index) => ({ action, index })).sort((a, b) => rank(a.action) - rank(b.action) || a.index - b.index).map((item) => item.action)
  return new Promise((resolve) => {
    const finish = (value) => {
      if (closeOpenDialog !== finish) return
      closeOpenDialog = null
      dialog.hidden = true
      dialog.onkeydown = null
      syncModal()
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
      resolve(field && value !== null ? { value, text: field.value } : value)
    }
    const buttons = ordered.map((action) => {
      const kind = action.kind === 'primary' ? 'primary' : action.kind === 'danger' ? 'pack-button danger' : action.kind === 'link' ? 'link' : 'pack-button'
      const button = el('button', kind, action.label)
      button.type = 'button'
      button.dataset.kind = action.kind || ''
      if (action.value === null) button.dataset.cancel = ''
      button.addEventListener('click', () => finish(action.value))
      return button
    })
    $('pack-dialog-actions').replaceChildren(...buttons)
    // close — 머리 오른쪽 ✕(Esc 와 같다) · 아래 [닫기] 버튼 대신
    const closeButton = $('pack-dialog-close')
    closeButton.hidden = !close
    closeButton.onclick = () => finish(null)
    // 목록 줄(팩 고르기) · 고르기 카드도 같은 끝내기로
    for (const node of bodyNode.querySelectorAll('[data-value]')) node.addEventListener('click', () => finish(node.dataset.value))
    closeOpenDialog = finish
    dialog.onkeydown = (event) => {
      if (event.isComposing) return
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(null)
      } else if (event.key === 'Enter' && field && document.activeElement === field) {
        event.preventDefault()
        const primary = buttons.find((button) => button.dataset.kind === 'primary') || buttons.find((button) => !('cancel' in button.dataset))
        if (primary) primary.click()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        // 목록 · 고르기 카드 안에서는 위아래 화살표로
        const group = document.activeElement && document.activeElement.closest('.pack-list, .pack-links')
        if (!group) return
        const items = [...group.querySelectorAll('button:not(:disabled)')]
        const at = items.indexOf(document.activeElement)
        event.preventDefault()
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus()
      }
    }
    dialog.hidden = false
    syncModal()
    const cancel = buttons.find((button) => 'cancel' in button.dataset)
    const danger = buttons.some((button) => button.dataset.kind === 'danger')
    const focus = field || (danger && cancel) || bodyNode.querySelector('[data-value]') || buttons.find((button) => button.dataset.kind === 'primary') || cancel || buttons[0] || (close && $('pack-dialog-close'))
    if (focus) focus.focus({ preventScroll: true })
  })
}

const packAlert = (title, text) => packDialog({ title, body: String(text || '').split('\n'), actions: [{ label: say('common.ok'), value: 'ok', kind: 'primary' }] })

// 진행 표시 — cancellable 이면 [취소](기다리는 중 · 검사 중에만 — 본체가 바꾸기 시작한 뒤에는 없다)
let progressBefore = null // 닫으면 포커스를 돌려줄 곳
function showPackProgress(title, cancellable) {
  const progress = $('pack-progress')
  if (progress.hidden) progressBefore = document.activeElement
  $('pack-progress-title').textContent = title
  $('pack-progress-step').textContent = ''
  const cancel = $('pack-progress-cancel')
  cancel.hidden = !cancellable
  cancel.onclick = () => studio.packCancel()
  $('pack-progress').hidden = false
  syncModal()
  $('pack-progress').focus({ preventScroll: true })
}
// 단계 하나 — 지금 하는 일 한 줄
function updatePackProgress(step) {
  $('pack-progress-step').textContent = step.text || ''
  // 정리를 시작하면 더는 취소할 수 없다
  if (step.cancellable === false) $('pack-progress-cancel').hidden = true
}
const hidePackProgress = () => {
  $('pack-progress').hidden = true
  syncModal()
  // 이어서 대화상자가 떴으면 그쪽 포커스 그대로
  if ($('pack-dialog').hidden && progressBefore instanceof HTMLElement && progressBefore.isConnected) progressBefore.focus({ preventScroll: true })
  progressBefore = null
}

// 지금 팩 이름 — pack new 로 만든 빈 자리(5.4 current.empty)는 /setup 중
function packCurrentLabel() {
  if (!packs.current) return say('pack.none')
  if (packs.current.empty) return say('pack.newSetup')
  return packLabel(packs.current)
}

const PACK_NAME_MAX = 40 // 표시 이름 1~40자(본체가 다시 검사한다)
const DOUBLE_CLICK_MS = 260 // 팩 아이콘 — 이 안에 다시 누르면 더블클릭(열기 대신 이름 · 이미지 바꾸기)

// 화면에 보일 팩 이름 — 표시 이름(팩 안에 저장 · 팀과 같이) → 이름 → id
const packLabel = (pack) => (pack && (pack.displayName || pack.name || pack.id)) || ''

// 팩 이미지 — main 이 iconPath 를 읽어 data URL 로 준다. iconUpdatedAt 이 바뀌면 다시 받는다(캐시 깨기)
const packIconCache = new Map() // id → { stamp, dataUrl }
const packIconPending = new Set()
function packIconImage(item) {
  if (!item.iconPath) return null
  const stamp = `${item.iconPath}|${item.iconUpdatedAt || ''}`
  const cached = packIconCache.get(item.id)
  if (cached && cached.stamp === stamp) {
    if (!cached.dataUrl) return null
    const image = el('img', 'pack-icon-image')
    image.src = cached.dataUrl
    image.alt = ''
    image.draggable = false
    return image
  }
  if (!packIconPending.has(item.id)) {
    packIconPending.add(item.id)
    studio
      .packIcon(item.id)
      .then((result) => packIconCache.set(item.id, { stamp, dataUrl: (result && result.dataUrl) || null }))
      .catch(() => packIconCache.set(item.id, { stamp, dataUrl: null })) // 실패도 적어 둔다 — 안 그러면 다시 그릴 때마다 또 요청한다
      .finally(() => {
        packIconPending.delete(item.id)
        renderPackRail()
      })
  }
  return null // 받는 동안은 두 글자
}

// 팩 지우기 — 무엇이 지워지고 무엇이 남는지 · 자동 백업을 알리고 확인. 워크트리가 있으면 목록을 보여 주고 한 번 더 묻는다
async function deletePack(id) {
  const pack = [...packs.packs, packs.current].find((item) => item && item.id === id)
  const name = packLabel(pack) || id
  const ok = await packDialog({
    title: say('pack.delete.title', { name }),
    body: [el('p', null, say('pack.delete.body')), el('p', 'muted', say('pack.delete.note'))],
    actions: [{ label: say('pack.delete.yes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }],
  })
  if (!ok) return
  showPackProgress(say('pack.delete.progress', { name }), false)
  let result = await studio.packDelete(id)
  hidePackProgress()
  if (result.error === 'has-worktrees') {
    const lines = result.worktrees.map((tree) => el('p', 'muted', tree.dirty ? say('pack.delete.treeDirty', { name: tree.name, count: tree.dirty }) : tree.name))
    const again = await packDialog({
      title: say('pack.delete.treesTitle', { count: result.worktrees.length }),
      body: [el('p', null, say('pack.delete.treesBody')), ...lines],
      actions: [{ label: say('pack.delete.treesYes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }],
    })
    if (!again) return
    showPackProgress(say('pack.delete.progress', { name }), false)
    result = await studio.packDelete(id, { withWorktrees: true })
    hidePackProgress()
  }
  if (!result.ok) return packAlert(say('pack.delete.failed'), result.text || result.message)
  await refreshPackList()
  const reveal = await packDialog({
    title: say('pack.delete.done', { name }),
    body: [el('p', 'muted', say('pack.delete.doneNote')), el('p', 'muted', result.backup)],
    actions: [{ label: say('pack.reveal'), value: 'reveal', kind: 'primary' }, { label: say('common.ok'), value: null }],
  })
  if (reveal) studio.packReveal()
}

// 팩 아이콘 우클릭 — main 메뉴(이름 바꾸기 · 원래 이름으로 · 이미지 고르기 · 이미지 지우기)에서 고른 것을 한다
async function editPackLook(id, action) {
  let result = null
  if (action === 'rename') {
    const pack = [...packs.packs, packs.current].find((item) => item && item.id === id)
    const answer = await packDialog({
      title: say('pack.rename.title'),
      body: [say('pack.rename.body', { id })],
      input: { value: packLabel(pack), placeholder: (pack && pack.name) || id, maxLength: PACK_NAME_MAX },
      actions: [
        { label: say('common.ok'), value: 'ok', kind: 'primary' },
        { label: say('common.cancel'), value: null },
      ],
    })
    if (!answer || !answer.text.trim()) return
    result = await studio.packSetName(id, answer.text.trim())
  }
  if (action === 'reset-name') result = await studio.packSetName(id, null)
  if (action === 'icon' || action === 'clear-icon') result = await studio.packSetIcon(id, action === 'clear-icon')
  if (result && !result.ok && !result.canceled) return packAlert(say('pack.look.failed'), result.text || result.message)
}

// 팩 이름 · 이미지 한 번에(아이콘 더블클릭) — lookDialog. 이름을 비우면 원래 이름으로(--clear). 둘 다 팩 안에 저장돼 팀과 같이 쓴다
async function editPackLookDialog(id) {
  const find = () => [...(packs.packs || []), packs.current].find((item) => item && item.id === id)
  const pack = find()
  if (!pack) return
  const image = pack.iconPath ? ((await studio.packIcon(id)) || {}).dataUrl || null : null
  const answer = await lookDialog({ title: say('pack.look.title'), color: id, image, value: packLabel(pack), placeholder: pack.name || id, pickKind: 'pack' })
  if (!answer) return
  const now = find() || pack
  const results = []
  if (answer.text !== packLabel(now)) results.push(await studio.packSetName(id, answer.text ? answer.text : null))
  if (answer.iconChange) results.push(await studio.packSetIcon(id, answer.iconChange === 'clear', answer.iconChange === 'picked'))
  const failed = results.find((result) => result && !result.ok && !result.canceled)
  if (failed) return packAlert(say('pack.look.failed'), failed.text || failed.message)
}

// 이름 · 이미지 대화상자(팩 · 레포 같이) — 왼쪽 큰 아이콘(누르면 이미지 고르기 · 오른쪽 위 지우기) + 오른쪽 이름 칸.
// 이미지도 이름처럼 [저장] 때 바뀐다(고른 파일은 main 이 들고 있다). 돌려주는 것: null(취소) · { text(앞뒤 공백 뺀 이름), iconChange: null(그대로) · 'picked' · 'clear' }
async function lookDialog({ title, color, image: startImage, value, placeholder, pickKind }) {
  let image = startImage
  let iconChange = null
  const avatar = el('button', 'space-icon pack-icon pack-look-avatar')
  avatar.type = 'button'
  avatar.style.setProperty('--space-color', spaceColor(color))
  avatar.setAttribute('aria-label', say('pack.menu.icon'))
  avatar.dataset.tip = say('pack.menu.icon')
  // 지우기 — 아이콘 오른쪽 위 작은 휴지통(이미지가 있을 때만)
  const remove = el('button', 'pack-look-remove')
  remove.type = 'button'
  remove.append(lineIcon(POPUP_ICONS.trash))
  remove.setAttribute('aria-label', say('pack.menu.clearIcon'))
  remove.dataset.tip = say('pack.menu.clearIcon')
  const error = el('p', 'pack-look-error')
  error.setAttribute('role', 'alert')
  const nameField = () => document.getElementById('pack-dialog-input')
  const paint = () => {
    if (image) {
      const node = el('img', 'pack-icon-image')
      node.src = image
      node.alt = ''
      avatar.replaceChildren(node)
    } else {
      const field = nameField()
      avatar.replaceChildren(document.createTextNode(spaceInitials((field && field.value.trim()) || placeholder)))
    }
    const edit = el('span', 'pack-look-edit')
    edit.append(lineIcon(POPUP_ICONS.camera))
    avatar.append(edit)
    remove.hidden = !image
  }
  avatar.addEventListener('click', async () => {
    error.textContent = ''
    const result = await studio.packPickIcon(pickKind)
    if (!result || result.canceled) return
    if (!result.ok) {
      error.textContent = result.text || say('pack.look.failed')
      return
    }
    image = result.dataUrl
    iconChange = 'picked'
    paint()
  })
  remove.addEventListener('click', () => {
    image = null
    iconChange = 'clear'
    paint()
    avatar.focus()
  })
  const side = el('div', 'pack-look-side')
  side.append(avatar, remove)
  const name = el('div', 'pack-look-name')
  const label = el('label', 'pack-look-label', say('pack.look.name'))
  label.htmlFor = 'pack-dialog-input'
  const slot = el('div')
  slot.dataset.inputSlot = ''
  name.append(label, slot, error)
  const look = el('div', 'pack-look')
  look.append(side, name)
  look.addEventListener('input', () => !image && paint()) // 이미지가 없으면 머리글자가 이름을 따라간다
  const pending = packDialog({
    title,
    body: [look],
    input: { value, placeholder, maxLength: PACK_NAME_MAX, label: say('pack.look.name') },
    actions: [
      { label: say('pack.look.save'), value: 'save', kind: 'primary' },
      { label: say('common.cancel'), value: null },
    ],
  })
  paint()
  nameField().select()
  const answer = await pending
  if (!answer || answer.value !== 'save') return null
  return { text: answer.text.trim(), iconChange }
}

// 팩 줄 · 팩 메뉴의 줄 — 목록에 지금 팩이 없으면(옛 구조 본체는 목록이 빈다) 지금 팩을 앞에 더한다
function packRows() {
  const current = packs.current && !packs.packs.some((item) => item.id === packs.current.id) ? [packs.current] : []
  return [...current, ...packs.packs]
}

// 팩 세로 줄 — 팩마다 이름 두 글자 + 이름 색(접힌 spaces 아이콘과 같은 모양) · 지금 팩 강조 · 누르면 갈아 끼우기
function renderPackRail() {
  renderPackWelcome()
  const rail = $('pack-rail')
  rail.hidden = !packs.supported || !state || !state.valid || hasNoPacks()
  if (rail.hidden) return
  const rows = packRows()
  const icons = rows.map((item) => {
    const isCurrent = Boolean(packs.current) && packs.current.id === item.id
    const name = isCurrent ? packCurrentLabel() : packLabel(item)
    const button = el('button', 'space-icon pack-icon')
    // 다른 창에 열려 있는 팩 — 작은 점(누르면 그 창이 앞으로)
    if (!isCurrent && Array.isArray(packs.openIds) && packs.openIds.includes(item.id)) button.classList.add('open-elsewhere')
    const image = packIconImage(item)
    if (image) button.append(image)
    else button.textContent = spaceInitials(packLabel(item))
    button.style.setProperty('--space-color', spaceColor(item.id)) // 색은 id 로 — 이름을 바꿔도 그대로
    button.dataset.packId = item.id
    button.setAttribute('aria-current', String(item.id === selectedPackId()))
    button.setAttribute('aria-label', name)
    button.dataset.tip = name // 툴팁은 팩 이름만
    // 한 번 누르면 이 창에서 그 팩으로 바꾼다(조금 기다렸다 — 더블클릭이면 이름 · 이미지 바꾸기로)
    let clickTimer = null
    if (!isCurrent) {
      button.addEventListener('click', () => {
        clearTimeout(clickTimer)
        clickTimer = setTimeout(() => runPackFlow(() => switchPack(item.id)), DOUBLE_CLICK_MS)
      })
    }
    button.addEventListener('dblclick', (event) => {
      event.preventDefault()
      clearTimeout(clickTimer)
      runPackFlow(() => editPackLookDialog(item.id))
    })
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault()
      // 메뉴는 팩 흐름 잠금 밖에서 — 메뉴가 끝내 닫힘 알림을 안 주면(창이 뒤에 있을 때 등) 잠금이 풀리지 않아 팩 일을 다 막는다
      const action = await studio.packContextMenu(item.id, { x: Math.round(event.clientX), y: Math.round(event.clientY) })
      if (action === 'new-window') runPackFlow(() => switchPack(item.id, { newWindow: true }))
      else if (action === 'export') runPackFlow(chooseExport)
      else if (action === 'delete') runPackFlow(() => deletePack(item.id))
      else if (action) runPackFlow(() => editPackLook(item.id, action))
    })
    return button
  })
  const add = el('button', 'space-icon add pack-add', '＋')
  add.dataset.tip = say('pack.rail.add')
  add.setAttribute('aria-label', add.dataset.tip)
  add.addEventListener('click', () => runPackFlow(openPackActions))
  rail.replaceChildren(...icons, add)
}

// 팩 줄 선택 표시 — 바꾸는 중인 팩이 있으면 그 팩(진행 팝업이 닫히면), 없으면 지금 팩
let packPendingId = null
const selectedPackId = () => packPendingId || (packs.current && packs.current.id) || null
// 버튼을 다시 그리지 않고 표시만 바꾼다(다시 그리면 두 번째 클릭이 다른 버튼에 떨어져 더블클릭이 안 된다)
function markPackSelection() {
  const selected = selectedPackId()
  for (const button of $('pack-rail').querySelectorAll('.pack-icon[data-pack-id]')) button.setAttribute('aria-current', String(button.dataset.packId === selected))
}

async function refreshPackList() {
  if (!state || !state.valid) return packs
  packs = await studio.packList()
  renderPackRail()
  return packs
}

// 대화상자 안 아이콘 줄(24 격자 선 아이콘)
const POPUP_ICONS = {
  new: ['M12 5v14', 'M5 12h14'],
  import: ['M12 3v10', 'M8 9.5l4 4l4-4', 'M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14'],
  export: ['M12 14V4', 'M8 7.5l4-4l4 4', 'M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14'],
  backup: ['M3 5h18v4H3z', 'M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9', 'M10 13h4'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M10 12h1M10 15h1M10 18h1'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  git: ['M6 3v12', 'M18 9a9 9 0 0 1-9 9', 'M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0', 'M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0'],
  athena: ['M12 8v4l3 2', 'M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  camera: ['M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M15.5 13a3.5 3.5 0 1 1-7 0a3.5 3.5 0 0 1 7 0'],
  trash: ['M4 7h16', 'M9 7V4.5h6V7', 'M6.5 7l1 13h9l1-13'],
}

// 아이콘 · 이름 · 한 줄 설명 버튼(고르면 data-value 로 대화상자를 끝낸다) — 팩 명령 줄 · 가져오기 종류
function popupOption(className, value, icon, title, note) {
  const button = el('button', className)
  button.type = 'button'
  button.dataset.value = value
  const mark = el('span', 'popup-icon')
  mark.append(lineIcon(POPUP_ICONS[icon]))
  const copy = el('span', 'popup-option-copy')
  copy.append(el('b', null, title), el('small', null, note))
  button.append(mark, copy)
  return button
}

// 팩 대화상자 아래 줄 — 새로 만들기 · 가져오기 · 내보내기 · 내 백업
function packLinks() {
  const links = el('div', 'pack-links')
  for (const value of ['new', 'import', 'export']) links.append(popupOption('pack-command', value, value, say(`pack.link.${value}`), say(`pack.link.${value}Note`)))
  return links
}

// 팩 세로 줄의 + — 목록 없이 만들기 · 가져오기 · 내보내기 · 내 백업만
async function openPackActions() {
  const choice = await packDialog({ title: say('pack.title'), body: [packLinks()], close: true })
  if (choice) return packCommand(choice)
}

// 회사 팩 고르기 — 목록 + 새로 만들기 · 가져오기 · 내보내기 · 내 백업
async function openPackPicker() {
  await refreshPackList()
  if (!packs.supported) return packAlert(say('pack.title'), say('pack.unsupported'))
  if (hasNoPacks()) return openNoPacks()
  const list = el('div', 'pack-list')
  const rows = packRows()
  for (const item of rows) {
    const row = el('button', 'pack-row')
    const isCurrent = Boolean(packs.current) && packs.current.id === item.id
    row.setAttribute('aria-current', String(isCurrent))
    row.dataset.value = `pack:${item.id}`
    const meta = [isCurrent ? say('pack.meta.current') : '', item.repos !== undefined ? say('pack.meta.repos', { count: item.repos }) : '', item.source === 'git' ? 'git' : '', item.empty ? say('pack.meta.empty') : '', item.hasWork ? say('pack.meta.hasWork') : ''].filter(Boolean).join(' · ')
    const avatar = el('span', 'space-icon pack-icon pack-avatar')
    avatar.setAttribute('aria-hidden', 'true')
    avatar.style.setProperty('--space-color', spaceColor(item.id))
    const image = packIconImage(item)
    if (image) avatar.append(image)
    else avatar.textContent = spaceInitials(packLabel(item))
    const check = el('span', 'pack-current', isCurrent ? '✓' : '')
    check.setAttribute('aria-hidden', 'true')
    row.append(avatar, el('span', 'name', packLabel(item)), el('span', 'meta', meta), check)
    list.append(row)
  }
  const choice = await packDialog({ title: say('pack.title'), body: [list, packLinks()], close: true })
  if (!choice) return
  if (choice.startsWith('pack:')) return switchPack(choice.slice(5))
  return packCommand(choice) // 이미 흐름 안 — runPackCommand 를 다시 부르면 자기 잠금에 막힌다
}

// 팩 흐름은 한 번에 하나 — 진행 중에 메뉴로 또 열면 알리기만
let packFlow = false
async function runPackFlow(work) {
  if (packFlow) return showToast(say('pack.flowBusy'), 'info')
  packFlow = true
  try {
    return await work()
  } finally {
    packFlow = false
  }
}
const runPackCommand = (name) => runPackFlow(() => packCommand(name))

function packCommand(name) {
  if (name === 'picker') return openPackPicker()
  if (name === 'new') return newPack()
  if (name === 'import') return importPack()
  if (name === 'export') return chooseExport()
}

// 시작 화면 — 작업 창 가운데(VS Code 처럼). 두 경우(규칙은 main 이 pack.js 로 계산해 넘긴다):
//   welcome — 팩이 하나도 없을 때(만들기 · 가져오기만) · launchWelcome — 앱을 켤 때마다(팩이 있어도 · 도는 에이전트가 없으면) + '내 팩' 목록
// 켤 때 시작 화면은 팩을 고르거나 · 만들거나 · 가져와 들어가면(welcomeEntered) 닫힌다. 떠 있는 동안 에이전트 모니터는 접어 두고, 들어가면 펼친다
const hasNoPacks = () => packs.welcome === true
let welcomeEntered = false
const welcomeShown = () => Boolean(state && state.valid) && (hasNoPacks() || (packs.launchWelcome === true && !welcomeEntered))
let welcomeWasOn = false
function renderPackWelcome() {
  const on = welcomeShown()
  $('pack-welcome').hidden = !on
  document.body.classList.toggle('pack-welcome-on', on)
  // 일감 · 브라우저 아이콘은 팩에 들어간 뒤에만 — 시작 화면이 뜨면 끄고, 열려 있었으면 닫는다
  $('board-tab').disabled = !state || !state.valid || on
  $('diagrams-open').disabled = !state || !state.valid || on
  $('browser-toggle').disabled = on
  if (on && browserOpen) closeBrowserPanel()
  // 처음 뜰 때만 접는다(시작 화면에서 직접 펴면 그대로 · 저장된 접기 설정은 건드리지 않는다)
  if (on && !welcomeWasOn) $('dock').classList.add('collapsed')
  if (on !== welcomeWasOn) {
    welcomeWasOn = on
    applySideFolds() // 시작 화면이 뜨면 양쪽을 접고, 들어가면 저장된 대로
  }
  // 몸통(로고 · 만들기 · 가져오기 · '내 팩')은 React(ui/pack-welcome.tsx) — 떠 있는 동안 목록을 넘기고, 닫히면 내린다
  if (on) StudioUi.welcome.open($('pack-welcome').querySelector('.pack-welcome-inner'), welcomeRecent(), welcomeActions())
  else StudioUi.welcome.close()
}

// '내 팩' — 지금 팩 맨 위 · 최근 순 · 최대 5개(main 의 packs.recent) · 팩이 없으면 비운다(만들기 · 가져오기만)
function welcomeRecent() {
  return (!hasNoPacks() && Array.isArray(packs.recent) && packs.recent) || []
}
// 시작 화면에서 누르면 — 만들기 · 가져오기 · 모두 보기는 팩 흐름 그대로, '내 팩' 줄을 고르면 그 팩으로 들어간다
function welcomeActions() {
  return { command: (name) => runPackCommand(name), enter: (id) => runPackFlow(() => enterPack(id)) }
}

// 시작 화면에서 들어가기 — 시작 화면을 닫고 모니터를 펼친다. 시작 화면이 떠 있지 않았으면(칩으로 갈아 끼움) 모니터는 그대로
function enterWelcome() {
  const wasShown = welcomeShown()
  welcomeEntered = true
  if (wasShown) $('dock').classList.remove('collapsed')
  renderPackWelcome()
}

// 목록에서 고름 — 이 창의 팩이면 바로 들어가 아테나를 켜고, 다른 팩이면 이 창에서 그 팩으로 바꾼다.
// 그 팩을 다른 창이 이미 보고 있으면 그 창이 앞으로 오고 이 시작 화면 창은 접는다
async function enterPack(id) {
  if (packs.current && packs.current.id === id) {
    enterWelcome()
    await openAgent()
    return
  }
  const result = await switchPack(id)
  if (result && result.ok && result.existing && welcomeShown()) studio.closeWindow()
}
function openNoPacks() {
  renderPackWelcome()
  if (currentTab !== 'work') switchTab('work')
}

// 팩 바꾸기 — 그 팩 본체를 준비하고(처음이면 본체를 만든다) 이 창을 그 팩으로 다시 붙인다(한 창에서 바꿔 보기).
// 이전 팩의 pane · 에이전트는 닫지 않는다(데몬에서 계속 돌고, 다시 누르면 보던 자리 그대로). newWindow 면 새 창으로(우클릭 [새 창으로 열기])
async function switchPack(id, { newWindow = false } = {}) {
  if (packs.current && packs.current.id === id) return { ok: true, same: true }
  const target = (packs.packs || []).find((item) => item.id === id)
  const name = target ? packLabel(target) : id
  try {
    return await openOrSwitchPack(id, { newWindow, name })
  } finally {
    // 끝나면(실패 · 취소 · 다른 창으로 감 포함) 실제 지금 팩으로 맞춘다
    if (packPendingId === id) {
      packPendingId = null
      markPackSelection()
    }
  }
}

async function openOrSwitchPack(id, { newWindow, name }) {
  showPackProgress(say(newWindow ? 'pack.open.progress' : 'pack.switch.progress', { name }), true)
  const result = await studio.packOpen(id, { newWindow })
  hidePackProgress()
  // 선택 표시는 진행 팝업이 닫힐 때 옮긴다 — 다시 붙기 · 목록 읽기가 끝날 때까지 기다리지 않게
  if (result.switched) {
    packPendingId = id
    markPackSelection()
  }
  if (result.same || result.canceled || result.error === 'canceled') return result
  if (!result.ok) {
    await packAlert(say(newWindow ? 'pack.open.failed' : 'pack.switch.failed'), result.text || result.message)
    return result
  }
  if (result.switched) await applySwitchedPack(result.state)
  const notes = []
  if (result.unlinkedRepos && result.unlinkedRepos.length) notes.push(say('pack.switch.unlinked', { repos: result.unlinkedRepos.join(', ') }))
  if (result.repair) notes.push(say('pack.open.repair'))
  if (notes.length) packAlert(say(result.switched ? 'pack.switch.done' : 'pack.open.done', { name }), notes.join('\n'))
  return result
}

// 이 창이 다른 본체로 다시 묶였다 — 상태 · 일감 · 옆 브라우저 · 작업 창을 그 팩 것으로. 처음 온 팩이면 아테나 에이전트를 켜고(/setup 포함),
// 다녀온 팩이면 보던 자리 그대로(keepView)
async function applySwitchedPack(next) {
  state = next
  enterWelcome() // 시작 화면에서 바꿨으면 닫고 모니터를 펼친다
  if (browserOpen) closeBrowserPanel()
  renderState()
  starting = true
  try {
    if (await attach()) await openAgent({ keepView: true })
  } finally {
    starting = false
  }
  ensureSomeTab()
  await refreshPackList()
}

// 새 팩 — 빈 자리 + 본체를 만들고 이 창에서 그 팩으로 바꾼다(그 본체 아테나가 /setup)
async function newPack() {
  showPackProgress(say('pack.new.progress'), true)
  const result = await studio.packNew()
  hidePackProgress()
  if (result.canceled || result.error === 'canceled') return
  if (!result.ok) return packAlert(say('pack.new.failed'), result.text || result.message)
  if (result.switched) await applySwitchedPack(result.state)
  showToast(say('pack.new.opened'), 'success')
}

// 가져오기 — 종류 고르기 → 검사(main 이 대화상자) → 같은 이름이면 나란히 비교 → 등록 → "지금 바꿀까요?"
async function importPack() {
  let target = null
  const options = el('div', 'pack-links')
  for (const value of ['file', 'folder', 'git', 'athena']) options.append(popupOption('pack-command', value, value, say(`pack.import.kind.${value}`), say(`pack.import.kind.${value}Note`)))
  const chosen = await packDialog({
    title: say('pack.import.title'),
    subtitle: say('pack.import.where'),
    body: [options],
    close: true,
  })
  if (!chosen) return
  // 기존 아테나는 git 설정(.git)을 그대로 가져온다(R4 A) — 내 컴퓨터에서 쓰던 것만 고르게 먼저 알린다
  if (chosen === 'athena') {
    const ok = await packDialog({
      title: say('pack.import.athena.title'),
      subtitle: say('pack.import.athena.body'),
      body: [el('p', 'muted', say('pack.import.athena.note'))],
      actions: [{ label: say('pack.import.athena.pick'), value: 'go', kind: 'primary' }, { label: say('common.cancel'), value: null }],
    })
    if (!ok) return
  }
  // git 주소 — 잘못된 주소면(main 이 검사) 쓴 그대로 다시 열고 칸 아래 오류
  let inspected = null
  let gitError = ''
  for (;;) {
    if (chosen === 'git') {
      const answer = await packDialog({
        title: say('pack.import.git.title'),
        subtitle: say('pack.import.git.body'),
        input: { placeholder: say('pack.import.git.placeholder'), value: target || '', code: true, label: say('pack.import.git.title'), error: gitError },
        actions: [{ label: say('pack.import.git.inspect'), value: 'go', kind: 'primary' }, { label: say('common.cancel'), value: null }],
      })
      if (!answer || !answer.value) return
      target = answer.text.trim()
    }
    showPackProgress(say('pack.import.inspecting'), true)
    inspected = await studio.packInspect(chosen, target)
    hidePackProgress()
    if (chosen !== 'git' || inspected.error !== 'invalid-url') break
    gitError = inspected.text || inspected.message
  }
  if (inspected.canceled || inspected.error === 'canceled') return
  if (!inspected.ok) return packAlert(say('pack.import.failed'), inspected.text || inspected.message)
  const choice = await chooseImport(inspected, chosen)
  if (!choice) return studio.packImport(inspected.token, 'keep')
  // 교체는 본체가 그 팩 본체 기준으로 판단한다(일하는 중이면 busy 로 막는다) — pane 을 닫지 않는다
  showPackProgress(say('pack.import.registering'), false)
  const result = await studio.packImport(inspected.token, choice)
  hidePackProgress()
  if (!result.ok) return packAlert(say('pack.import.failed'), result.text || result.message)
  if (choice === 'keep') return
  // 끝 — 팩 한 줄(아이콘 · 이름 · 레포) · 백업 · git 안내 · [나중에] [열기]
  const imported = result.imported
  const intoCurrent = !imported || (packs.current && packs.current.id === imported.id)
  const body = []
  if (imported) {
    const name = imported.name || imported.id
    const card = el('div', 'pack-result-card')
    const avatar = el('span', 'space-icon pack-icon pack-avatar', spaceInitials(name))
    avatar.setAttribute('aria-hidden', 'true')
    avatar.style.setProperty('--space-color', spaceColor(imported.id))
    const copy = el('div')
    copy.append(el('b', null, name))
    const repos = inspected.pack && inspected.pack.repos
    if (Number.isInteger(repos)) copy.append(el('small', null, say('pack.meta.repos', { count: repos })))
    card.append(avatar, copy)
    body.push(card)
  }
  if (result.backup) body.push(el('p', 'pack-result-note', say('pack.import.backedUp', { path: result.backup })))
  // 백업 때 하던 작업(에이전트 대화 · 워크트리)이 함께 왔으면 — 열면서 되살릴지 고른다(안 고르면 남겨 둔다)
  const restore = inspected.restore
  if (restore) body.push(el('p', 'pack-result-note', say('pack.restore.offer', restore)), el('p', 'pack-result-note', say('pack.restore.note')))
  // R4 A — 폴더 · 압축에서 온 .git 은 코어가 지웠다(inspect 결과 gitRemoved)
  if (inspected.gitRemoved) body.push(el('p', 'pack-result-note', say('pack.import.gitRemoved')))
  const openNow = await packDialog({
    title: say('pack.import.done'),
    subtitle: say(intoCurrent ? 'pack.import.intoCurrent' : 'pack.import.openNow'),
    body,
    actions: restoreActions(intoCurrent, Boolean(restore)),
  })
  if (openNow === 'restore') {
    if (intoCurrent) {
      showPackProgress(say('pack.restore.progress'), false)
      const restored = await studio.packRestoreNow()
      hidePackProgress()
      return showRestoreResult(restored)
    }
    await studio.packRestoreArm(imported.id)
    restoreArmed = true
    const opened = await switchPack(imported.id)
    // 열지 못했거나 다른 창으로 갔으면 이 창의 예약은 지운다(main 의 예약은 그 팩을 연 창이 쓰거나 여기서 지운다)
    if (!packs.current || packs.current.id !== imported.id) {
      restoreArmed = false
      studio.packRestoreDisarm()
    }
    return opened
  }
  if (openNow === 'yes') return switchPack(imported.id)
}

// 가져오기 끝 버튼 — 되살릴 작업이 있으면 [열고 작업 되살리기](지금 팩이면 [작업 되살리기])가 확인 자리
function restoreActions(intoCurrent, restore) {
  if (intoCurrent) return restore ? [{ label: say('pack.restore.now'), value: 'restore', kind: 'primary' }, { label: say('common.later'), value: null }] : [{ label: say('common.ok'), value: 'ok', kind: 'primary' }]
  const actions = [{ label: say('pack.verb.open'), value: 'yes', kind: restore ? undefined : 'primary' }, { label: say('common.later'), value: null }]
  if (restore) actions.unshift({ label: say('pack.restore.openAndRestore'), value: 'restore', kind: 'primary' })
  return actions
}

// 같은 이름이면 나란히(사용자 결정 3) · 기존 아테나면 가져올 작업 기록도 보여 준다. 반환: new · replace · keep(null 은 취소)
async function chooseImport(inspected, kind) {
  const name = (inspected.pack && inspected.pack.name) || say('pack.import.defaultName')
  const body = []
  if (inspected.work) {
    const work = inspected.work
    const worktrees = work.worktrees || []
    const dirty = worktrees.filter((tree) => tree.dirty).length
    body.push(say('pack.import.work', { plans: work.plans || 0, issues: work.issues || 0, archive: work.archive || 0 }))
    if (worktrees.length) body.push(el('p', 'muted', say('pack.import.worktrees', { count: worktrees.length, dirty })))
  }
  if (!inspected.conflict) {
    if (kind !== 'athena') return 'new'
    const ok = await packDialog({ title: say('pack.import.athenaTitle', { name }), body, actions: [{ label: say('pack.import.go'), value: 'new', kind: 'primary' }, { label: say('common.cancel'), value: null }] })
    return ok
  }
  const compare = el('div', 'pack-compare')
  const existing = el('div')
  existing.append(el('b', null, say('pack.compare.existing')), el('span', null, inspected.summary.existing || '-'))
  const incoming = el('div')
  incoming.append(el('b', null, say('pack.compare.incoming')), el('span', null, `${inspected.summary.incoming || '-'}${inspected.source ? ` · ${inspected.source}` : ''}`))
  compare.append(existing, incoming)
  body.unshift(compare)
  body.push(el('p', 'muted', [say('pack.compare.note'), inspected.current ? say('pack.compare.noteCurrent') : ''].filter(Boolean).join(' ')))
  // reason: packId(같은 팩 — 하나만) · name(이름만 같은 다른 팩 — 둘 다 둘 수 있다 · 5.4)
  const actions = [{ label: say('pack.compare.replace'), value: 'replace', kind: 'danger' }, { label: say('pack.compare.keep'), value: 'keep' }]
  if (inspected.conflict.reason === 'name') actions.splice(1, 0, { label: say('pack.compare.both'), value: 'new' })
  actions.push({ label: say('common.cancel'), value: null })
  const sameTitle = inspected.conflict.reason === 'name' ? say('pack.compare.sameName', { name }) : say('pack.compare.same', { name })
  return packDialog({ title: sameTitle, body, actions })
}

// 내보내기 — 담을 것을 먼저 묻는다: 팩 + 내 작업 기록(백업 · 위) · 팩만(팀에 줄 것)
async function chooseExport() {
  const options = el('div', 'pack-links')
  options.append(
    popupOption('pack-command', 'backup', 'backup', say('pack.export.withWork'), say('pack.export.withWorkNote')),
    popupOption('pack-command', 'share', 'export', say('pack.export.packOnly'), say('pack.export.packOnlyNote')),
  )
  const kind = await packDialog({ title: say('pack.export.title'), subtitle: say('pack.export.ask'), body: [options], close: true })
  if (kind) return exportPack(kind)
}

// 내 백업에 담긴 되살리기 정보 — 에이전트 대화 · 워크트리 수 · 대화를 못 담은 pane · 뺀 것(큰 파일 등)
function backupNotes(result) {
  const restore = result.restore
  if (!restore) return []
  const notes = [el('p', null, say('pack.restore.saved', { sessions: restore.sessions || 0, worktrees: restore.worktrees || 0 }))]
  if ((restore.missing || []).length) notes.push(el('p', 'muted', say('pack.restore.missing', { count: restore.missing.length })))
  for (const warning of result.warnings || []) notes.push(el('p', 'muted', warning))
  return notes
}

async function exportPack(kind) {
  const prefix = kind === 'backup' ? 'pack.backup' : 'pack.export'
  const title = say(`${prefix}.title`)
  showPackProgress(say(`${prefix}.progress`), false)
  const result = await studio.packExport(kind)
  hidePackProgress()
  if (result.canceled) return
  if (!result.ok) return packAlert(say('pack.result.failed', { title }), result.text || result.message)
  const size = result.bytes ? ` · ${Math.max(1, Math.round(result.bytes / 1024))}KB` : ''
  const reveal = await packDialog({
    title: say('pack.result.done', { title }),
    body: [`${result.file}`, `${say('pack.result.files', { count: result.files || 0 })}${size}`, ...backupNotes(result), el('p', 'muted', say(`${prefix}.note`))],
    actions: [{ label: say('pack.reveal'), value: 'reveal', kind: 'primary' }],
    close: true,
  })
  if (reveal) studio.packReveal()
}

// 이 창의 팩이 가져오기로 바뀌었다(교체) — 목록 · 일감을 새로(창의 본체 · pane 은 그대로)
function onPackChanged() {
  refreshPackList()
}

async function initPacks() {
  studio.onPackState((next) => {
    refreshPackRepos()
    packs = next
    renderPackRail()
  })
  studio.onPackProgress(updatePackProgress)
  studio.onPackRestored(showRestoreResult)
  studio.onPackCaughtUp((info) => showToast(say('pack.caughtUp', info), 'info'))
  studio.onPackChanged(onPackChanged)
  studio.onPackCommand((name) => state && state.valid && runPackCommand(name))
  await afterAthenaReady()
}

// 본체가 정해진 뒤 — 팩이 하나도 없으면 두 가지만 보여 준다
async function afterAthenaReady() {
  if (!state || !state.valid) return
  await refreshPackList()
  if (!packs.supported) return
  if (hasNoPacks()) openNoPacks()
}

// ── 아테나 폴더 ────────────────────────────────────────────
function renderState() {
  document.body.dataset.platform = state.platform
  $('install-dir').textContent = state.installDir || ''
  $('browser-toggle').dataset.tip = say('browser.toggleTitle', { key: state.tabKey })
  $('board-tab').dataset.tip = say('board.openTitle')
  const ready = state.valid
  panels.setup.hidden = ready
  $('board-tab').disabled = !ready || welcomeShown() // 시작 화면(팩 고르기) 동안은 일감을 못 연다
  $('diagrams-open').disabled = !ready || welcomeShown() // 다이어그램도 팩에 들어간 뒤에만
  $('work-tab').disabled = !ready || welcomeShown()
  $('settings-tab').disabled = !ready || welcomeShown() // 설정은 팩에 들어간 뒤에만(그 팩의 pack.json)
  renderPackRail()
  if (!ready) {
    panels.work.hidden = true
  }
}

const pickAthenaDir = () => applyAthenaResult(studio.pickAthenaDir())

// 처음 화면 제목 — 사전 키를 기억해 두어 언어를 바꾸면 다시 쓴다(키가 없으면 제품 이름 그대로)
let setupTitleKey = null
function setSetupTitle(key) {
  setupTitleKey = key
  $('setup-title').textContent = key ? say(key) : 'Athena Studio'
}

// 처음 켤 때 아테나 폴더가 안 정해졌으면 묻지 않고 앱이 들고 온 코어를 풀어 쓴다(~/.athena-studio/core). 안 됐을 때만 [다시 시도] · [폴더 고르기] 를 보여 준다
async function installAthena() {
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
    if (!state.valid) {
      setSetupTitle('setup.notFound')
      $('setup-note').hidden = true
      for (const button of buttons) button.hidden = false
    }
  }
}

async function applyAthenaResult(pending) {
  const result = await pending
  const error = $('setup-error')
  if (result.canceled) return
  if (result.error) {
    if (state.valid) {
      alert(result.error)
    } else {
      error.textContent = result.error
      error.hidden = false
    }
    return
  }
  error.hidden = true
  const wasValid = state.valid
  state = result
  renderState()
  if (!wasValid || result.changed) {
    // 처음 정했거나 폴더가 바뀌었으면 작업 창을 연다(이미 있는 데몬 탭은 그대로 — athena 탭이 없을 때만 새로 켠다)
    switchTab('work')
    startScreen()
    afterAthenaReady()
  }
}

// 메뉴 [보기 → 언어] — 정적 문구와 지금 보이는 것만 다시 그린다(열린 대화상자 · 토스트는 다음에 열 때부터)
function applyLanguage(next) {
  i18nState = next
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

async function init() {
  state = await studio.athenaState()
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
    clearTimeout(view.resizing)
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
  studio.onScreenResync(() => state.valid && attach())
  studio.onScreenDisconnected(() => {
    attached = false
    reattachOnKey = true
    showScreenStatus(say('screen.disconnected'))
  })
  studio.onScreenCommand(runCommand)
  studio.onLanguage(applyLanguage)
  const packsReady = initPacks()
  new ResizeObserver(() => layoutPanes()).observe($('panes'))
  new ResizeObserver(() => layoutPanes()).observe($('dock'))
  if (state.valid) {
    switchTab('work')
    // 팩 목록(켤 때 시작 화면인지)을 먼저 — 시작 화면이면 고를 때까지 아테나 에이전트를 켜지 않는다(startScreen)
    packsReady.finally(startScreen)
  } else {
    installAthena()
  }
}

init()
