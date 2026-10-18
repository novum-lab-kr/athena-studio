// 앱 화면 — 탭 두 개(작업 창 · 현황판) · 작업 창 안의 데몬 탭·pane · 처음 켤 때 아테나 받기 · 에이전트(claude · codex) 고르기
// studio 는 preload 의 contextBridge 가 만든 전역이다 — 같은 이름으로 다시 선언하면 이 파일 전체가 SyntaxError 로 죽는다
/* global studio, Terminal, FitAddon, WebLinksAddon, Unicode11Addon, StudioLayout, StudioI18n */
const $ = (id) => document.getElementById(id)

// ── 언어 ──────────────────────────────────────────────────
// 문구는 사전(src/i18n) — main 이 preload 로 넘긴다(StudioI18n 은 src/lib/i18n.js). 정적 문구는 index.html 의 data-i18n* 속성
let i18nState = studio.i18n()
const say = (key, values) => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)

function applyStaticTexts() {
  document.documentElement.lang = i18nState.language
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = say(node.dataset.i18n)
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = say(node.dataset.i18nTitle)
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', say(node.dataset.i18nAriaLabel))
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = say(node.dataset.i18nPlaceholder)
}
applyStaticTexts()

const panels = { setup: $('setup'), work: $('work'), board: $('board') }
const tabs = [...document.querySelectorAll('[data-tab]')] // 오른쪽 현황판 토글 아이콘 하나(작업 창은 그 아이콘을 다시 누르거나 ⌘1)

let state = null
let currentTab = 'work'

// ── 작업 창 (데몬의 탭 · pane) ───────────────────────────────
// pane 은 데몬이 갖는다 — 앱을 닫았다 켜도 같은 배치·화면으로 다시 붙는다. 분할 트리는 StudioLayout(src/lib/layout.js)
const PANE_GAP = 2
const HEAD_HEIGHT = 22 // pane 머리줄 높이(style.css .pane-head 와 같은 값)
const views = new Map() // paneId → { term, fit, el, head, shown, sent: {cols, rows} }
let screen = { workspaces: [], activeWorkspace: null, tabs: [], focused: null, panes: [] }
let branches = {} // 작업 공간 id → git 브랜치(없으면 null) — main 이 5초마다
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
  const body = document.createElement('div')
  body.className = 'pane-body'
  el.append(head, body)
  $('panes').append(el)
  const { term, fit } = makeTerminal()
  term.open(body)
  term.onData((data) => {
    if (reattachOnKey) return reattach()
    return studio.paneInput(paneId, data)
  })
  // 누른 pane 으로 포커스(데몬에도 알려 pane current · split --target focused 가 맞게)
  el.addEventListener('mousedown', () => focusPane(paneId))
  const view = { term, fit, el, head, shown: false, sent: null }
  views.set(paneId, view)
  return view
}

// 숨었던 칸이 다시 보일 때 — xterm DOM 렌더러는 글자 폭을 DOM 으로 재서 글자 간격(셀 폭 − 글자 폭)을 정하는데,
// 숨은 칸(display:none — 다른 작업 공간의 하단 칸 · 현황판 탭)에서는 0 으로 재져 간격이 셀 폭만큼 벌어진다.
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
// 접기·펴기 버튼 — 칸 머리에 붙는다. 패널 아이콘(네모 + 세로선 · 사용자가 시안 5 를 고름) · 접힌 칸은 그쪽을 칠한다
const PANEL_ICONS = {
  left: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18'],
  right: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18'],
}

const PANEL_FILLS = {
  left: 'M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  right: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z',
}

function foldButton(side, title, onClick, collapsed = false) {
  const button = document.createElement('button')
  button.className = 'fold-button'
  const icon = lineIcon(PANEL_ICONS[side])
  if (collapsed) {
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    fill.setAttribute('class', 'panel-fill')
    fill.setAttribute('d', PANEL_FILLS[side])
    icon.prepend(fill)
  }
  button.append(icon)
  button.title = title
  button.setAttribute('aria-label', title)
  button.addEventListener('click', onClick)
  return button
}

// spaces 머리줄의 + — 새 작업 공간(⌘⇧T · [파일] 메뉴와 같다)
function addSpaceButton() {
  const button = document.createElement('button')
  button.className = 'fold-button'
  button.append(lineIcon(['M12 5v14', 'M5 12h14']))
  button.dataset.tip = say('spaces.newTitle', { key: state.tabKey })
  button.setAttribute('aria-label', button.dataset.tip)
  button.addEventListener('click', () => runCommand('new-workspace'))
  return button
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
    // 옆 브라우저 바는 기본 title 그대로(R1 A) — 아래로 띄우면 페이지 자리의 네이티브 뷰에 가려진다
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

// 접힌 왼쪽 — 작업 공간마다 아이콘 하나
function spaceRail() {
  const rows = screen.workspaces.map((workspace) => {
    const button = document.createElement('button')
    button.className = 'space-icon'
    button.setAttribute('aria-current', String(workspace.id === screen.activeWorkspace))
    button.style.setProperty('--space-color', spaceColor(workspace.label))
    button.textContent = spaceInitials(workspace.label)
    button.title = [workspace.label, branches[workspace.id]].filter(Boolean).join('\n')
    button.addEventListener('click', () => {
      if (currentTab !== 'work') switchTab('work')
      studio.workspaceSelect(workspace.id)
    })
    return button
  })
  const add = document.createElement('button')
  add.className = 'space-icon add'
  add.textContent = '＋'
  add.dataset.tip = say('spaces.newTitle', { key: state.tabKey })
  add.setAttribute('aria-label', add.dataset.tip)
  add.addEventListener('click', () => runCommand('new-workspace'))
  return [foldButton('left', say('spaces.expand', { key: state.tabKey }), () => setSpacesCollapsed(false), true), ...rows, add]
}

function renderSides() {
  const spaces = $('spaces')
  if (spaces.classList.contains('collapsed')) {
    spaces.replaceChildren(...spaceRail())
    if (explorerView.workspace !== screen.activeWorkspace) resetExplorer()
    return
  }
  // 왼쪽: 작업 공간(레포)만
  const title = document.createElement('div')
  title.className = 'side-title with-fold'
  const titleText = document.createElement('span')
  titleText.textContent = 'spaces'
  const actions = document.createElement('span')
  actions.className = 'side-title-actions'
  actions.append(addSpaceButton(), foldButton('left', say('spaces.collapse', { key: state.tabKey }), () => setSpacesCollapsed(true)))
  title.append(titleText, actions)
  const rows = screen.workspaces.map((workspace) => {
    const button = document.createElement('button')
    button.className = 'space'
    button.setAttribute('aria-current', String(workspace.id === screen.activeWorkspace))
    button.title = workspace.cwd || ''
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.textContent = workspace.id === screen.activeWorkspace ? '●' : '○'
    const text = document.createElement('span')
    text.className = 'space-text'
    const label = document.createElement('span')
    label.className = 'space-label'
    label.textContent = workspace.label
    text.append(label)
    // 이름 오른쪽에 브랜치(한 줄)
    if (branches[workspace.id]) {
      const branch = document.createElement('span')
      branch.className = 'space-branch'
      branch.textContent = branches[workspace.id]
      text.append(branch)
    }
    button.append(dot, text)
    button.addEventListener('click', () => {
      if (currentTab !== 'work') switchTab('work')
      studio.workspaceSelect(workspace.id)
    })
    return button
  })
  spaces.replaceChildren(title, ...rows)

  // 오른쪽: 지금 작업 공간의 Explorer — 작업 공간이 바뀌면 따라간다
  if (explorerView.workspace !== screen.activeWorkspace) resetExplorer()
}

// ── 오른쪽 Explorer (파일 · 변경) ──
// 파일은 main 이 작업 공간 폴더 안만 읽어 준다. 폴더는 펼칠 때 읽고, git 변경은 보일 때 3초마다
const explorerView = { workspace: null, mode: 'files', children: new Map(), expanded: new Set(), changes: [], git: false, statusKey: '' }

function resetExplorer() {
  explorerView.workspace = screen.activeWorkspace
  explorerView.children = new Map()
  explorerView.expanded = new Set(['.'])
  explorerView.changes = []
  explorerView.git = false
  explorerView.statusKey = ''
  renderExplorer()
  if (!explorerView.workspace) return
  loadFolder('.')
  refreshStatus()
}

async function loadFolder(relative) {
  const workspace = explorerView.workspace
  const result = await studio.explorerList(workspace, relative)
  if (workspace !== explorerView.workspace) return
  explorerView.children.set(relative, result.error ? { error: result.error } : result.entries)
  renderExplorer()
}

async function refreshStatus() {
  const workspace = explorerView.workspace
  if (!workspace) return
  const result = await studio.explorerStatus(workspace)
  if (workspace !== explorerView.workspace || result.error) return
  const key = JSON.stringify(result)
  if (key === explorerView.statusKey) return
  const first = !explorerView.statusKey
  explorerView.statusKey = key
  explorerView.git = result.git
  explorerView.changes = result.changes
  renderExplorer()
  // 파일이 생기거나 지워졌을 수 있다 — 펼쳐 둔 폴더를 다시 읽는다(처음 읽을 때는 이미 읽는 중)
  if (!first) for (const folder of explorerView.expanded) loadFolder(folder)
}

const joinPath = (folder, name) => (folder === '.' ? name : `${folder}/${name}`)

// 아이콘 — VSCode Material Icon Theme 의 SVG(main 이 이름으로 골라 준다). 폴더는 열림·닫힘 아이콘이 화살표를 대신한다
const ICON_ROOT = '../../node_modules/material-icon-theme/icons'

function iconElement(entry, open) {
  const name = open && entry.iconOpen ? entry.iconOpen : entry.icon
  const image = document.createElement('img')
  image.className = 'file-icon'
  image.alt = ''
  if (typeof name === 'string' && /^[\w.-]+$/.test(name)) image.src = `${ICON_ROOT}/${name}.svg`
  return image
}

// 폴더 열기·닫기 표시 — 둥근 단추 꺾쇠(›, 열리면 아래로 돈다 · 마우스를 올리면 동그란 바탕) · 'none' 은 파일 줄의 빈 자리(이름 줄 맞춤)
function twistyElement(state) {
  const twisty = document.createElement('span')
  twisty.className = `twisty${state === 'open' ? ' open' : ''}${state === 'none' ? ' none' : ''}`
  if (state === 'none') return twisty
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 10 10')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M3.5 1.5L7 5L3.5 8.5')
  svg.append(path)
  twisty.append(svg)
  return twisty
}

function treeRow({ depth, label, mark, markClass, dotfile, onClick, title, icon, twisty }) {
  const row = document.createElement('button')
  row.className = `tree-row${dotfile ? ' dotfile' : ''}`
  row.style.paddingLeft = `${6 + depth * 12}px`
  row.title = title || label
  if (twisty === 'open' || twisty === 'closed') row.setAttribute('aria-expanded', String(twisty === 'open'))
  const name = document.createElement('span')
  name.className = 'label'
  name.textContent = label
  const tail = document.createElement('span')
  tail.className = `mark ${markClass || ''}`
  tail.textContent = mark || ''
  row.append(...(twisty ? [twistyElement(twisty)] : []), ...(icon ? [icon] : []), name, tail)
  row.addEventListener('click', onClick)
  return row
}

// 펼친 폴더만 따라 내려가며 줄을 만든다(펼친 만큼만 — 큰 레포도 처음엔 한 단계)
function fileRows() {
  const codes = new Map(explorerView.changes.map((change) => [change.path, change.code]))
  const folders = new Set()
  for (const change of explorerView.changes) {
    let dir = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''
    while (dir) {
      folders.add(dir)
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    }
  }
  const rows = []
  const walk = (folder, depth) => {
    const entries = explorerView.children.get(folder)
    if (!entries) {
      rows.push(treeRow({ depth, twisty: 'none', label: say('explorer.loading'), onClick: () => {} }))
      return
    }
    if (entries.error) {
      rows.push(treeRow({ depth, twisty: 'none', label: entries.error, onClick: () => {} }))
      return
    }
    for (const entry of entries) {
      const relative = joinPath(folder, entry.name)
      if (entry.dir) {
        const open = explorerView.expanded.has(relative)
        rows.push(
          treeRow({
            depth,
            twisty: open ? 'open' : 'closed',
            icon: iconElement(entry, open),
            label: entry.name,
            mark: folders.has(relative) ? '●' : '',
            markClass: 'code-M',
            dotfile: entry.name.startsWith('.'),
            onClick: () => toggleFolder(relative),
          }),
        )
        if (open) walk(relative, depth + 1)
      } else {
        const code = codes.get(relative)
        rows.push(
          treeRow({ depth, twisty: 'none', icon: iconElement(entry), label: entry.name, mark: code, markClass: code ? `code-${code}` : '', dotfile: entry.name.startsWith('.'), onClick: () => openPreview(relative) }),
        )
      }
    }
  }
  walk('.', 0)
  return rows
}

function changeRows() {
  if (!explorerView.git) return [treeRow({ depth: 0, label: say('explorer.notGit'), onClick: () => {} })]
  if (!explorerView.changes.length) return [treeRow({ depth: 0, label: say('explorer.noChanges'), onClick: () => {} })]
  return explorerView.changes.map((change) =>
    treeRow({ depth: 0, icon: iconElement(change), label: change.path, mark: change.code, markClass: `code-${change.code}`, onClick: () => openPreview(change.path), title: change.path }),
  )
}

function toggleFolder(relative) {
  if (explorerView.expanded.has(relative)) explorerView.expanded.delete(relative)
  else {
    explorerView.expanded.add(relative)
    if (!explorerView.children.has(relative)) loadFolder(relative)
  }
  renderExplorer()
}

function renderExplorer() {
  const panel = $('side-panel')
  const workspace = screen.workspaces.find((entry) => entry.id === explorerView.workspace)
  if (!workspace) {
    const empty = document.createElement('div')
    empty.className = 'side-empty'
    empty.textContent = say('explorer.noWorkspace')
    panel.replaceChildren(empty)
    return
  }
  const head = document.createElement('div')
  head.className = 'explorer-head'
  const name = document.createElement('span')
  name.className = 'explorer-name'
  name.textContent = workspace.label
  name.title = say('explorer.cwdTitle', { path: workspace.cwd, key: state.tabKey })
  // 파일 · 변경 — 글자 없이 아이콘만(이름은 마우스를 올리면 · 변경 수는 작은 숫자)
  const viewButton = (mode, label, badge) => {
    const button = document.createElement('button')
    button.className = 'view-button icon'
    button.title = label
    button.setAttribute('aria-label', label)
    button.append(lineIcon(VIEW_ICONS[mode]))
    if (badge) button.append(Object.assign(document.createElement('span'), { className: 'view-badge', textContent: String(badge) }))
    button.setAttribute('aria-pressed', String(explorerView.mode === mode))
    button.addEventListener('click', () => {
      explorerView.mode = mode
      renderExplorer()
    })
    return button
  }
  const count = explorerView.changes.length
  head.append(name, viewButton('files', say('explorer.files')), viewButton('changes', count ? say('explorer.changesCount', { count }) : say('explorer.changes'), count), foldButton('right', say('explorer.collapse', { key: state.tabKey }), () => setPanelHidden(true)))
  const scroll = panel.scrollTop
  panel.replaceChildren(head, ...(explorerView.mode === 'files' ? fileRows() : changeRows()))
  panel.scrollTop = scroll
}

// 선 아이콘(24 격자 · 글자색을 따름) — 파일은 겹친 문서, 변경은 git 갈래
const VIEW_ICONS = {
  files: ['M15 2H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z', 'M15 2v5h5', 'M4 7v13a2 2 0 0 0 2 2h9'],
  changes: ['M6 3v12', 'M18 9a9 9 0 0 1-9 9', 'M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0', 'M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0'],
}

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
  const result = await studio.explorerOpen(explorerView.workspace, relative)
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
  if (!hidden) renderExplorer()
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
  if (!panelHidden) renderExplorer()
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
  // 하단 칸(에이전트 모니터)은 athena 작업 공간에서만 — 다른 공간은 그 높이만큼 pane 이 길어진다. 높이를 재기 전에 정한다
  const showDock = isAthenaWorkspace(activeWorkspace())
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
    view.head.textContent = info.label || info.title || paneId
    if (!view.shown) redrawAfterHidden(view)
    view.shown = true
    try {
      view.fit.fit()
    } catch {}
    const { cols, rows } = view.term
    // 경계를 끄는 동안은 셸에 크기를 알리지 않는다(놓을 때 한 번)
    if (dividerDrag) continue
    if (!view.sent || view.sent.cols !== cols || view.sent.rows !== rows) {
      view.sent = { cols, rows }
      studio.paneResize(paneId, cols, rows)
    }
  }
  reportTabSize(tab, container)
  if (!renamingTab) focusCurrentTerminal() // 탭 이름을 고치는 중이면 글자 칸 포커스를 뺏지 않는다
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
// main 이 Claude 기록을 따라 읽어 세션 · 이벤트를 보낸다(보일 때만). 칩을 누르면 그 세션만 걸러 본다
const MONITOR_ROWS = 300
const monitorView = { visible: null, sessions: [], events: [], filter: null }

function setMonitorVisible(visible) {
  if (monitorView.visible === visible) return
  monitorView.visible = visible
  studio.monitorWatch(visible)
}

function monitorTime(at) {
  const date = at ? new Date(at) : null
  if (!date || Number.isNaN(date.getTime())) return '--:--'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function sinceText(ms) {
  const minutes = Math.floor((Date.now() - ms) / 60000)
  if (minutes < 1) return say('time.justNow')
  if (minutes < 60) return say('time.minutesAgo', { n: minutes })
  return say('time.hoursAgo', { n: Math.floor(minutes / 60) })
}

function sessionLabelOf(sessionId) {
  const session = monitorView.sessions.find((entry) => entry.id === sessionId)
  return session ? session.label : '?'
}

// 서브에이전트 보고(SubagentHandback)는 입력이 없어 main(agent-feed)이 고정 문구를 준다 — 화면 언어로 바꿔 보인다
const eventText = (event) => (event.kind === 'tool' && event.name === 'SubagentHandback' ? say('monitor.finalReport') : event.text)

function monitorRow(event) {
  const row = document.createElement('div')
  row.className = `monitor-row ${event.kind}`
  const label = sessionLabelOf(event.session)
  row.style.setProperty('--label-color', spaceColor(label))
  const cells = [
    ['monitor-time', monitorTime(event.at)],
    ['monitor-label', `[${label}]`],
    ['monitor-icon', event.icon],
    ['monitor-name', event.name],
    ['monitor-text', eventText(event)],
  ]
  for (const [className, text] of cells) {
    const cell = document.createElement('span')
    cell.className = className
    cell.textContent = text
    row.append(cell)
  }
  row.title = `${label} · ${event.name ? `${event.name} · ` : ''}${eventText(event)}`
  return row
}

function sessionKind(session) {
  if (session.pane) return say('monitor.paneSession')
  return session.finished ? say('monitor.subagentDone') : say('monitor.subagent')
}

function renderMonitorSessions() {
  const chips = monitorView.sessions.map((session) => {
    const chip = document.createElement('button')
    const live = !session.finished && Date.now() - session.lastAt < 2 * 60000
    chip.className = `monitor-chip${live ? ' live' : ''}${monitorView.filter === session.id ? ' active' : ''}`
    chip.style.setProperty('--label-color', spaceColor(session.label))
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = session.label
    chip.append(name)
    const count = document.createElement('span')
    count.className = 'count'
    count.textContent = `${session.tools} · ${sinceText(session.lastAt)}`
    chip.append(count)
    chip.title = say('monitor.sessionTitle', { label: session.label, kind: sessionKind(session), tools: session.tools, since: sinceText(session.lastAt) })
    chip.addEventListener('click', () => {
      monitorView.filter = monitorView.filter === session.id ? null : session.id
      renderMonitorSessions()
      renderMonitorFeed()
    })
    return chip
  })
  $('monitor-sessions').replaceChildren(...chips)
}

function shownEvents() {
  return monitorView.filter ? monitorView.events.filter((event) => event.session === monitorView.filter) : monitorView.events
}

// keepScroll — 위쪽을 읽던 중이면 그 자리를 지킨다(맨 아래였으면 따라 내려간다)
function renderMonitorFeed(keepScroll = false) {
  const feed = $('monitor-feed')
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24
  const scrollTop = feed.scrollTop
  const events = shownEvents()
  if (!events.length) {
    const empty = Object.assign(document.createElement('div'), { className: 'monitor-empty', textContent: monitorView.sessions.length ? say('monitor.empty') : say('monitor.noAgents') })
    feed.replaceChildren(empty)
    return
  }
  feed.replaceChildren(...events.map(monitorRow))
  feed.scrollTop = keepScroll && !atBottom ? scrollTop : feed.scrollHeight
}

const byEventTime = (left, right) => String(left.at).localeCompare(String(right.at)) || left.id - right.id

// 새 이벤트는 덧붙인다 — 맨 아래를 보고 있을 때만 따라 내려간다
function applyMonitorUpdate(update) {
  const feed = $('monitor-feed')
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24
  monitorView.sessions = update.sessions || []
  // 고른 세션이 빠졌으면 필터를 풀고 전체를 다시 그린다
  const filterGone = monitorView.filter && !monitorView.sessions.some((session) => session.id === monitorView.filter)
  if (filterGone) monitorView.filter = null
  if (update.reset) {
    monitorView.events = [...(update.events || [])].sort(byEventTime).slice(-MONITOR_ROWS)
    renderMonitorSessions()
    return renderMonitorFeed()
  }
  const fresh = update.events || []
  const last = monitorView.events[monitorView.events.length - 1]
  // 늦게 찾은 세션의 이전 줄이 섞이면 시각 순으로 다시 세워 전부 다시 그린다
  const outOfOrder = last && fresh.some((event) => String(event.at) < String(last.at))
  monitorView.events = [...monitorView.events, ...fresh].sort(byEventTime).slice(-MONITOR_ROWS)
  renderMonitorSessions()
  if (outOfOrder || filterGone) return renderMonitorFeed(true)
  const visible = monitorView.filter ? fresh.filter((event) => event.session === monitorView.filter) : fresh
  if (!visible.length) return undefined
  if (feed.querySelector('.monitor-empty')) return renderMonitorFeed()
  feed.append(...visible.map(monitorRow))
  while (feed.childElementCount > MONITOR_ROWS) feed.firstElementChild.remove()
  if (atBottom) feed.scrollTop = feed.scrollHeight
  return undefined
}

function initMonitor() {
  const dock = $('dock')
  dock.classList.toggle('collapsed', localStorage.getItem('studio.monitorCollapsed') === '1')
  $('monitor-fold').addEventListener('click', () => {
    const collapsed = !dock.classList.contains('collapsed')
    dock.classList.toggle('collapsed', collapsed)
    localStorage.setItem('studio.monitorCollapsed', collapsed ? '1' : '0')
  })
  studio.onMonitorUpdate(applyMonitorUpdate)
  renderMonitorFeed()
  // 'n분 전' 을 새로 쓴다
  setInterval(() => monitorView.visible && renderMonitorSessions(), 30000)
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
    if (!ratioUnsupportedNoticed) showToast(say('pane.sizeOldDaemon'))
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

// 메뉴 단축키(⌘T · ⌘D · ⌘⇧D · ⌘W · ⌘⌥방향 · ⌘⇧[ ]) — Ctrl 은 pane 안으로 간다
async function runCommand(name) {
  if (!state || !state.valid || !attached) return
  if (currentTab !== 'work') switchTab('work')
  // 나누기·닫기·이동의 기준은 지금 탭의 pane — 포커스가 탭 밖이면 탭의 첫 pane
  const focused = tabPaneForCommand()
  if (name === 'new-tab') return newTab()
  if (name === 'split-right' || name === 'split-down') {
    if (!focused) return newTab()
    const result = await studio.paneSplit(focused, name === 'split-down' ? 'down' : 'right')
    if (result.error) showToast(say('pane.splitFailed', { message: result.error }))
    return undefined
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
    const index = screen.workspaces.findIndex((workspace) => workspace.id === screen.activeWorkspace)
    if (index < 0) return undefined
    const step = name === 'workspace-next' ? 1 : -1
    return studio.workspaceSelect(screen.workspaces[(index + step + screen.workspaces.length) % screen.workspaces.length].id)
  }
  if (name === 'close-tab') {
    const current = activeTab()
    if (current) await studio.tabClose(current.id)
    return undefined
  }
  if (name === 'new-workspace') {
    const result = await studio.workspaceNew(estimateCells($('panes')))
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

// athena 탭에서 아테나 에이전트를 켠다(이미 있으면 그 탭으로) — 묻지 않고 claude, 없으면 깔린 것 중 첫 번째
async function openAgent(options) {
  const result = await studio.openAgent(estimateCells($('panes')), options)
  if (result.error) showToast(result.error)
  return result
}

// 알림은 pane 위에 따로 띄운다(누르면 닫힘)
function showToast(message) {
  const toast = $('toast')
  toast.textContent = message
  toast.hidden = false
  toast.onclick = () => (toast.hidden = true)
}

// ── 현황판 ────────────────────────────────────────────────
let boardLoaded = false
let boardLoading = false

async function loadBoard(force = false) {
  const frame = $('board-frame')
  const status = $('board-status')
  if (boardLoading) return
  if (boardLoaded && !force) return
  boardLoading = true
  status.className = 'status'
  status.textContent = say('board.opening')
  status.hidden = false
  try {
    const result = await studio.ensureBoard()
    if (!result.ok) {
      status.className = 'status error'
      status.textContent = `${result.error}${result.log ? `\n${say('board.logLine', { log: result.log })}` : ''}\n\n${say('board.retryHint', { key: state.tabKey })}`
      frame.hidden = true
      boardLoaded = false
      return
    }
    status.hidden = true
    frame.hidden = false
    // 같은 주소를 다시 넣어도 새로 불러온다(새로고침은 첫 화면으로)
    frame.src = result.url
    boardLoaded = true
  } finally {
    boardLoading = false
  }
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
  // 창 크기가 바뀌면 서랍(너비 46%)도 바뀐다 — 다 나와 있을 때만 다시 붙인다
  new ResizeObserver(() => placeBrowserView()).observe($('browser-slot'))
}

// ── 탭 ──────────────────────────────────────────────────
function switchTab(name) {
  if (!state || !state.valid) return
  if (name === 'board' && welcomeShown()) return // 팩을 고르기 전에는 현황판을 열지 않는다(⌘2 · 트레이 포함)
  currentTab = name
  studio.reportTab(name)
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name))
  panels.work.hidden = name !== 'work'
  panels.board.hidden = name !== 'board'
  if (name === 'work') {
    requestAnimationFrame(layoutPanes)
  } else {
    // 작업 창이 숨으면 모든 칸이 안 보이는 것 — 돌아올 때 다시 그리도록(layoutPanes) 표시만 해 둔다
    for (const view of views.values()) view.shown = false
    setMonitorVisible(false)
    loadBoard()
    $('board-frame').focus()
  }
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

// 대화상자 하나 — actions: [{ label, value, kind: 'primary'|'danger'|'link' }] · Esc 는 null.
// 이미 열린 것이 있으면 null 로 닫고 연다(앞 흐름이 영영 기다리지 않게)
let closeOpenDialog = null
function packDialog({ title, body = [], actions = [], input = null }) {
  if (closeOpenDialog) closeOpenDialog(null)
  const dialog = $('pack-dialog')
  $('pack-dialog-title').textContent = title
  const bodyNode = $('pack-dialog-body')
  bodyNode.replaceChildren(...body.map((part) => (typeof part === 'string' ? el('p', null, part) : part)))
  let field = null
  if (input) {
    field = el('input', 'pack-input')
    field.placeholder = input.placeholder || ''
    field.value = input.value || ''
    if (input.maxLength) field.maxLength = input.maxLength
    field.spellcheck = false
    field.autocomplete = 'off'
    bodyNode.append(field)
  }
  return new Promise((resolve) => {
    const finish = (value) => {
      if (closeOpenDialog !== finish) return
      closeOpenDialog = null
      dialog.hidden = true
      dialog.onkeydown = null
      resolve(field && value !== null ? { value, text: field.value } : value)
    }
    const buttons = actions.map((action) => {
      const button = el('button', action.kind === 'primary' ? 'primary' : `pack-button${action.kind === 'danger' ? ' danger' : ''}`, action.label)
      button.addEventListener('click', () => finish(action.value))
      return button
    })
    $('pack-dialog-actions').replaceChildren(...buttons)
    // 목록 줄(팩 고르기)도 같은 끝내기로
    for (const node of bodyNode.querySelectorAll('[data-value]')) node.addEventListener('click', () => finish(node.dataset.value))
    closeOpenDialog = finish
    dialog.onkeydown = (event) => {
      if (event.key === 'Escape') finish(null)
      if (event.key === 'Enter' && field && document.activeElement === field) finish(actions[0] && actions[0].value)
    }
    dialog.hidden = false
    const focus = field || buttons.find((button) => button.classList.contains('primary')) || buttons[0]
    if (focus) focus.focus()
  })
}

const packAlert = (title, text) => packDialog({ title, body: String(text || '').split('\n'), actions: [{ label: say('common.ok'), value: 'ok', kind: 'primary' }] })

// 진행 표시 — cancellable 이면 [취소](기다리는 중 · 검사 중에만 — 본체가 바꾸기 시작한 뒤에는 없다)
function showPackProgress(title, cancellable) {
  $('pack-progress-title').textContent = title
  $('pack-progress-step').textContent = ''
  const cancel = $('pack-progress-cancel')
  cancel.hidden = !cancellable
  cancel.onclick = () => studio.packCancel()
  $('pack-progress').hidden = false
}
const hidePackProgress = () => ($('pack-progress').hidden = true)

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

// 팩 이름 · 이미지 한 번에(아이콘 더블클릭) — 미리보기 + [이미지 고르기…] [이미지 지우기](바로 바뀐다) + 이름 칸(저장 때).
// 이름을 비우면 원래 이름으로(--clear). 이름 · 이미지는 팩 안에 저장돼 팀과 같이 쓴다(5.7)
async function editPackLookDialog(id) {
  const find = () => [...(packs.packs || []), packs.current].find((item) => item && item.id === id)
  const pack = find()
  if (!pack) return
  const preview = el('span', 'space-icon pack-icon pack-look-preview')
  preview.style.setProperty('--space-color', spaceColor(id))
  const paintPreview = async () => {
    const now = find() || pack
    const result = now.iconPath ? await studio.packIcon(id) : null
    if (result && result.dataUrl) {
      const image = el('img', 'pack-icon-image')
      image.src = result.dataUrl
      image.alt = ''
      preview.replaceChildren(image)
    } else {
      preview.replaceChildren(document.createTextNode(spaceInitials(packLabel(now))))
    }
    clearIcon.hidden = !now.iconPath
  }
  const chooseIcon = el('button', 'pack-button', say('pack.menu.icon'))
  const clearIcon = el('button', 'pack-button', say('pack.menu.clearIcon'))
  const changeIcon = async (clear) => {
    const result = await studio.packSetIcon(id, clear)
    if (result && !result.ok && !result.canceled) return showToast(result.text || result.message || say('pack.look.failed'))
    if (result && result.ok) {
      await refreshPackList()
      await paintPreview()
    }
  }
  chooseIcon.addEventListener('click', () => changeIcon(false))
  clearIcon.addEventListener('click', () => changeIcon(true))
  const imageRow = el('div', 'pack-look-row')
  const imageButtons = el('div', 'pack-look-buttons')
  imageButtons.append(chooseIcon, clearIcon)
  imageRow.append(preview, imageButtons)
  await paintPreview()
  const answer = await packDialog({
    title: say('pack.look.title'),
    body: [el('p', 'muted', say('pack.look.body', { id, name: pack.name || id })), el('p', 'pack-look-label', say('pack.look.image')), imageRow, el('p', 'pack-look-label', say('pack.look.name'))],
    input: { value: packLabel(find() || pack), placeholder: pack.name || id, maxLength: PACK_NAME_MAX },
    actions: [
      { label: say('pack.look.save'), value: 'save', kind: 'primary' },
      { label: say('common.cancel'), value: null },
    ],
  })
  if (!answer || answer.value !== 'save') return
  const now = find() || pack
  const text = answer.text.trim()
  if (text === packLabel(now)) return // 이름은 그대로
  const result = await studio.packSetName(id, text ? text : null)
  if (result && !result.ok) return packAlert(say('pack.look.failed'), result.text || result.message)
}

// 팩 세로 줄 — 팩마다 이름 두 글자 + 이름 색(접힌 spaces 아이콘과 같은 모양) · 지금 팩 강조 · 누르면 갈아 끼우기
function renderPackRail() {
  renderPackWelcome()
  const rail = $('pack-rail')
  rail.hidden = !packs.supported || !state || !state.valid || hasNoPacks()
  if (rail.hidden) return
  // 옛 구조 본체는 목록이 비고 지금 팩만 있다 — 그 하나라도 보이게
  const rows = packs.packs.length ? packs.packs : [packs.current].filter(Boolean)
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
    button.setAttribute('aria-current', String(isCurrent))
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

async function refreshPackList() {
  if (!state || !state.valid) return packs
  packs = await studio.packList()
  renderPackRail()
  return packs
}

// 팩 대화상자 아래 줄 — 새로 만들기 · 가져오기 · 내보내기 · 내 백업
function packLinks() {
  const links = el('div', 'pack-links')
  for (const value of ['new', 'import', 'export', 'backup']) {
    const link = el('button', 'link', say(`pack.link.${value}`))
    link.dataset.value = value
    links.append(link)
  }
  return links
}

// 팩 세로 줄의 + — 목록 없이 만들기 · 가져오기 · 내보내기 · 내 백업만
async function openPackActions() {
  const choice = await packDialog({ title: say('pack.title'), body: [packLinks()], actions: [{ label: say('common.close'), value: null }] })
  if (choice) return packCommand(choice)
}

// 회사 팩 고르기 — 목록 + 새로 만들기 · 가져오기 · 내보내기 · 내 백업
async function openPackPicker() {
  await refreshPackList()
  if (!packs.supported) return packAlert(say('pack.title'), say('pack.unsupported'))
  if (hasNoPacks()) return openNoPacks()
  const list = el('div', 'pack-list')
  // 옛 구조 본체는 목록이 비고 지금 팩만 있다 — 그 한 줄이라도 보이게
  const rows = packs.packs.length ? packs.packs : [packs.current].filter(Boolean)
  for (const item of rows) {
    const row = el('button', 'pack-row')
    const isCurrent = Boolean(packs.current) && packs.current.id === item.id
    row.setAttribute('aria-current', String(isCurrent))
    row.dataset.value = `pack:${item.id}`
    const meta = [isCurrent ? say('pack.meta.current') : '', item.repos !== undefined ? say('pack.meta.repos', { count: item.repos }) : '', item.source === 'git' ? 'git' : '', item.hasWork ? say('pack.meta.hasWork') : ''].filter(Boolean).join(' · ')
    row.append(el('span', null, `${isCurrent ? '● ' : '○ '}${packLabel(item)}`), el('span', 'meta', meta))
    list.append(row)
  }
  const choice = await packDialog({ title: say('pack.title'), body: [list, packLinks()], actions: [{ label: say('common.close'), value: null }] })
  if (!choice) return
  if (choice.startsWith('pack:')) return switchPack(choice.slice(5))
  return packCommand(choice) // 이미 흐름 안 — runPackCommand 를 다시 부르면 자기 잠금에 막힌다
}

// 팩 흐름은 한 번에 하나 — 진행 중에 메뉴로 또 열면 알리기만
let packFlow = false
async function runPackFlow(work) {
  if (packFlow) return showToast(say('pack.flowBusy'))
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
  if (name === 'export' || name === 'backup') return exportPack(name)
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
  // 현황판 · 브라우저 아이콘은 팩에 들어간 뒤에만 — 시작 화면이 뜨면 끄고, 열려 있었으면 닫는다
  for (const tab of tabs) tab.disabled = !state || !state.valid || on
  $('browser-toggle').disabled = on
  if (on && currentTab === 'board') switchTab('work')
  if (on && browserOpen) closeBrowserPanel()
  // 처음 뜰 때만 접는다(시작 화면에서 직접 펴면 그대로 · 저장된 접기 설정은 건드리지 않는다)
  if (on && !welcomeWasOn) $('dock').classList.add('collapsed')
  if (on !== welcomeWasOn) {
    welcomeWasOn = on
    applySideFolds() // 시작 화면이 뜨면 양쪽을 접고, 들어가면 저장된 대로
  }
  if (on) renderWelcomeRecent()
}

// '내 팩' — 지금 팩 맨 위 · 최근 순 · 최대 5개(main 의 packs.recent) · 고르면 그 팩으로 들어간다
function renderWelcomeRecent() {
  const recent = (!hasNoPacks() && Array.isArray(packs.recent) && packs.recent) || []
  $('pack-welcome-recent').hidden = !recent.length
  const cartridge = $('cartridge-icon').content.querySelector('svg')
  const rows = recent.map((item) => {
    const row = el('button', 'pack-welcome-recent-row')
    row.dataset.packId = item.id
    if (item.current) row.setAttribute('aria-current', 'true')
    const icon = el('span', 'icon')
    icon.setAttribute('aria-hidden', 'true')
    if (cartridge) icon.append(cartridge.cloneNode(true))
    const date = item.updatedAt ? new Date(item.updatedAt) : null
    const when = date && !Number.isNaN(date.getTime()) ? `${date.getMonth() + 1}/${date.getDate()}` : ''
    const meta = [item.current ? say('pack.meta.current') : '', Number.isFinite(item.repos) ? say('pack.meta.repos', { count: item.repos }) : '', item.current ? '' : when].filter(Boolean).join(' · ')
    row.append(icon, el('span', 'name', item.name), el('span', 'meta', meta))
    row.addEventListener('click', () => runPackFlow(() => enterPack(item.id)))
    return row
  })
  $('pack-welcome-recent-list').replaceChildren(...rows)
}

// 시작 화면에서 들어가기 — 시작 화면을 닫고 모니터를 펼친다. 시작 화면이 떠 있지 않았으면(칩으로 갈아 끼움) 모니터는 그대로
function enterWelcome() {
  const wasShown = welcomeShown()
  welcomeEntered = true
  if (wasShown) $('dock').classList.remove('collapsed')
  renderPackWelcome()
}

// 목록에서 고름 — 이 창의 팩이면 바로 들어가 아테나를 켜고, 다른 팩이면 이 창에서 그 팩으로 바꾼다(D4 바꿈).
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

// 팩 바꾸기 — 그 팩 본체를 준비하고(처음이면 본체를 만든다) 이 창을 그 팩으로 다시 붙인다(D4 바꿈 — 한 창에서 바꿔 보기).
// 이전 팩의 pane · 에이전트는 닫지 않는다(데몬에서 계속 돌고, 다시 누르면 보던 자리 그대로). newWindow 면 새 창으로(우클릭 [새 창으로 열기])
async function switchPack(id, { newWindow = false } = {}) {
  if (packs.current && packs.current.id === id) return { ok: true, same: true }
  const target = (packs.packs || []).find((item) => item.id === id)
  const name = target ? packLabel(target) : id
  showPackProgress(say(newWindow ? 'pack.open.progress' : 'pack.switch.progress', { name }), true)
  const result = await studio.packOpen(id, { newWindow })
  hidePackProgress()
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

// 이 창이 다른 본체로 다시 묶였다 — 상태 · 현황판 · 옆 브라우저 · 작업 창을 그 팩 것으로. 처음 온 팩이면 아테나 에이전트를 켜고(/setup 포함),
// 다녀온 팩이면 보던 자리 그대로(keepView)
async function applySwitchedPack(next) {
  state = next
  enterWelcome() // 시작 화면에서 바꿨으면 닫고 모니터를 펼친다
  if (browserOpen) closeBrowserPanel()
  boardLoaded = false
  renderState()
  if (currentTab === 'board') loadBoard(true)
  starting = true
  try {
    if (await attach()) await openAgent({ keepView: true })
  } finally {
    starting = false
  }
  ensureSomeTab()
  await refreshPackList()
}

// 새 팩 — 빈 자리 + 본체를 만들고 이 창에서 그 팩으로 바꾼다(D4 바꿈 — 그 본체 아테나가 /setup)
async function newPack() {
  showPackProgress(say('pack.new.progress'), true)
  const result = await studio.packNew()
  hidePackProgress()
  if (result.canceled || result.error === 'canceled') return
  if (!result.ok) return packAlert(say('pack.new.failed'), result.text || result.message)
  if (result.switched) await applySwitchedPack(result.state)
  showToast(say('pack.new.opened'))
}

// 가져오기 — 종류 고르기 → 검사(main 이 대화상자) → 같은 이름이면 나란히 비교 → 등록 → "지금 바꿀까요?"
async function importPack(kind = null, source = null) {
  let chosen = kind
  let target = source
  if (!chosen) {
    chosen = await packDialog({
      title: say('pack.import.title'),
      body: [say('pack.import.where')],
      actions: [...['file', 'folder', 'git', 'athena'].map((value) => ({ label: say(`pack.import.kind.${value}`), value })), { label: say('common.cancel'), value: null }],
    })
    if (!chosen) return
  }
  // 기존 아테나는 git 설정(.git)을 그대로 가져온다(R4 A) — 내 컴퓨터에서 쓰던 것만 고르게 먼저 알린다
  if (chosen === 'athena' && !target) {
    const ok = await packDialog({
      title: say('pack.import.athena.title'),
      body: [say('pack.import.athena.body'), el('p', 'muted', say('pack.import.athena.note'))],
      actions: [{ label: say('pack.import.athena.pick'), value: 'go', kind: 'primary' }, { label: say('common.cancel'), value: null }],
    })
    if (!ok) return
  }
  if (chosen === 'git' && !target) {
    const answer = await packDialog({
      title: say('pack.import.git.title'),
      body: [say('pack.import.git.body')],
      input: { placeholder: say('pack.import.git.placeholder') },
      actions: [{ label: say('pack.import.git.inspect'), value: 'go', kind: 'primary' }, { label: say('common.cancel'), value: null }],
    })
    if (!answer || !answer.value) return
    target = answer.text
  }
  showPackProgress(say('pack.import.inspecting'), true)
  const inspected = await studio.packInspect(chosen, target)
  hidePackProgress()
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
  const imported = result.imported
  // R4 A — 폴더 · 압축에서 온 .git 은 코어가 지웠다(inspect 결과 gitRemoved)
  const gitNote = inspected.gitRemoved ? `\n${say('pack.import.gitRemoved')}` : ''
  const backupNote = `${result.backup ? `\n${say('pack.import.backedUp', { path: result.backup })}` : ''}${gitNote}`
  if (!imported || (packs.current && packs.current.id === imported.id)) return packAlert(say('pack.import.done'), `${say('pack.import.intoCurrent')}${backupNote}`)
  const openNow = await packDialog({
    title: say('pack.import.done'),
    body: [`${say('pack.import.registered', { name: imported.name || imported.id })}${backupNote}`, say('pack.import.openNow')],
    actions: [{ label: say('pack.verb.open'), value: 'yes', kind: 'primary' }, { label: say('common.later'), value: null }],
  })
  if (openNow) return switchPack(imported.id)
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
  const actions = [{ label: say('pack.compare.replace'), value: 'replace', kind: 'primary' }, { label: say('pack.compare.keep'), value: 'keep' }]
  if (inspected.conflict.reason === 'name') actions.splice(1, 0, { label: say('pack.compare.both'), value: 'new' })
  actions.push({ label: say('common.cancel'), value: null })
  const sameTitle = inspected.conflict.reason === 'name' ? say('pack.compare.sameName', { name }) : say('pack.compare.same', { name })
  return packDialog({ title: sameTitle, body, actions })
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
    body: [`${result.file}`, `${say('pack.result.files', { count: result.files || 0 })}${size}`, el('p', 'muted', say(`${prefix}.note`))],
    actions: [{ label: say('pack.reveal'), value: 'reveal', kind: 'primary' }, { label: say('common.close'), value: null }],
  })
  if (reveal) studio.packReveal()
}

// 이 창의 팩이 가져오기로 바뀌었다(교체) — 목록 · 현황판을 새로(창의 본체 · pane 은 그대로)
function onPackChanged() {
  refreshPackList()
  boardLoaded = false
  if (currentTab === 'board') loadBoard(true)
}

async function initPacks() {
  studio.onPackState((next) => {
    packs = next
    renderPackRail()
  })
  studio.onPackProgress((step) => {
    $('pack-progress-step').textContent = step.text || ''
    // 정리를 시작하면 더는 취소할 수 없다
    if (step.cancellable === false) $('pack-progress-cancel').hidden = true
  })
  studio.onPackChanged(onPackChanged)
  studio.onPackCommand((name) => state && state.valid && runPackCommand(name))
  for (const button of document.querySelectorAll('[data-pack-command]')) button.addEventListener('click', () => runPackCommand(button.dataset.packCommand))
  await afterAthenaReady()
}

// 본체가 정해진 뒤 — 시작할 때 "옮기기" 를 골랐으면 기존 아테나 가져오기를 이어서, 팩이 하나도 없으면 두 가지만 보여 준다
async function afterAthenaReady() {
  if (!state || !state.valid) return
  await refreshPackList()
  if (!packs.supported) return
  const pending = await studio.packPendingImport()
  if (pending) return runPackFlow(() => importPack('athena', pending))
  if (hasNoPacks()) openNoPacks()
}

// ── 아테나 폴더 ────────────────────────────────────────────
function renderState() {
  document.body.dataset.platform = state.platform
  $('install-dir').textContent = state.installDir || ''
  $('browser-toggle').dataset.tip = say('browser.toggleTitle', { key: state.tabKey })
  $('board-tab').dataset.tip = `${say('board.title')} (${state.tabKey}2)`
  const ready = state.valid
  panels.setup.hidden = ready
  for (const tab of tabs) tab.disabled = !ready || welcomeShown() // 시작 화면(팩 고르기) 동안은 현황판을 못 연다
  renderPackRail()
  if (!ready) {
    panels.work.hidden = true
    panels.board.hidden = true
  }
}

const pickAthenaDir = () => applyAthenaResult(studio.pickAthenaDir())

// 처음 화면 제목 — 사전 키를 기억해 두어 언어를 바꾸면 다시 쓴다(키가 없으면 제품 이름 그대로)
let setupTitleKey = null
function setSetupTitle(key) {
  setupTitleKey = key
  $('setup-title').textContent = key ? say(key) : 'Athena Studio'
}

// 처음 켤 때 아테나 폴더가 안 정해졌으면 묻지 않고 레포의 athena/ 를 쓴다. 안 됐을 때만 [다시 시도] · [폴더 고르기] 를 보여 준다
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
    boardLoaded = false
    switchTab('work')
    startScreen()
    afterAthenaReady()
  }
}

// 메뉴 [보기 → 언어] — 정적 문구와 지금 보이는 것만 다시 그린다(열린 대화상자 · 토스트는 다음에 열 때부터)
function applyLanguage(next) {
  i18nState = next
  applyStaticTexts()
  if (setupTitleKey) setSetupTitle(setupTitleKey)
  if (!state) return
  renderState()
  if (attached) {
    renderTabs()
    renderSides()
    renderExplorer()
  }
  renderMonitorSessions()
  renderMonitorFeed(true)
}

async function init() {
  state = await studio.athenaState()
  renderState()
  // 현황판 아이콘은 토글 — 현황판이면 작업 창으로 돌아간다
  $('board-tab').addEventListener('click', () => switchTab(currentTab === 'board' ? 'work' : 'board'))
  initTips()
  initBrowser()
  initMonitor()
  $('pick').addEventListener('click', pickAthenaDir)
  $('install').addEventListener('click', installAthena)
  studio.onTabSwitch(switchTab)
  studio.onPickRequest(pickAthenaDir)
  studio.onBoardReload(() => state.valid && loadBoard(true))
  // 데몬 알림 — 붙는 중에 온 출력은 되살릴 화면에 이미 들어 있어 버린다
  studio.onPaneData((paneId, data) => {
    if (attached && !attaching) views.get(paneId)?.term.write(data)
  })
  studio.onScreenState((next) => attached && !attaching && applyState(next))
  studio.onScreenBranches((next) => {
    if (JSON.stringify(next) === JSON.stringify(branches)) return
    branches = next
    if (attached) renderSides()
  })
  applySideFolds()
  $('side-open').addEventListener('click', () => setPanelHidden(false))
  $('preview-close').addEventListener('click', closePreview)
  $('preview').addEventListener('keydown', (event) => event.key === 'Escape' && closePreview())
  // git 변경은 Explorer 가 보일 때만 3초마다
  setInterval(() => {
    if (currentTab === 'work' && !$('side-panel').hidden && attached) refreshStatus()
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
