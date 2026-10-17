// 앱 화면 — 탭 두 개(작업 창 · 현황판) · 작업 창 안의 데몬 탭·pane · 처음 켤 때 아테나 받기 · 에이전트(claude · codex) 고르기
// studio 는 preload 의 contextBridge 가 만든 전역이다 — 같은 이름으로 다시 선언하면 이 파일 전체가 SyntaxError 로 죽는다
/* global studio, Terminal, FitAddon, WebLinksAddon, Unicode11Addon, StudioLayout */
const $ = (id) => document.getElementById(id)

const panels = { setup: $('setup'), work: $('work'), board: $('board') }
const tabs = [...document.querySelectorAll('.tab')]

let state = null
let currentTab = 'work'

// ── 작업 창 (데몬의 탭 · pane) ───────────────────────────────
// pane 은 데몬이 갖는다 — 앱을 닫았다 켜도 같은 배치·화면으로 다시 붙는다. 분할 트리는 StudioLayout(src/lib/layout.js)
const PANE_GAP = 2
const HEAD_HEIGHT = 18
const views = new Map() // paneId → { term, fit, el, head, shown, sent: {cols, rows}, dock }
let screen = { workspaces: [], activeWorkspace: null, tabs: [], focused: null, panes: [] }
let paneInfo = new Map() // paneId → 납작한 Pane(agent · agent_status) — main 이 2초마다 보낸다
let branches = {} // 작업 공간 id → git 브랜치(없으면 null) — main 이 5초마다
let attached = false
let attaching = null
let reattachOnKey = false
let lastTabSize = null

function makeTerminal() {
  const term = new Terminal({
    allowProposedApi: true, // unicode11 에 필요
    // Nerd Font 는 아이콘(사이드바 Explorer 등)용 — 기본 글꼴에 없는 글자만 그 글꼴로 그린다
    fontFamily: '"SF Mono", Menlo, "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "D2Coding", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true, // 안의 프로그램이 마우스를 잡아도 Option+드래그로 고를 수 있게
    theme: { background: '#14161a', foreground: '#d8dbe0' },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => studio.openUrl(uri)))
  // 이모지(🤖 🧭)를 두 칸으로 — 데몬의 화면 버퍼와 같은 규칙
  term.loadAddon(new Unicode11Addon.Unicode11Addon())
  term.unicode.activeVersion = '11'
  return { term, fit }
}

function ensureView(paneId, dock = false) {
  if (views.has(paneId)) return views.get(paneId)
  const el = document.createElement('div')
  el.className = 'pane'
  const head = document.createElement('div')
  head.className = 'pane-head'
  const body = document.createElement('div')
  body.className = 'pane-body'
  el.append(head, body)
  // 고정 칸(dock)은 가운데 맨 아래에, 나머지는 분할 영역에
  $(dock ? 'dock' : 'panes').append(el)
  const { term, fit } = makeTerminal()
  term.open(body)
  term.onData((data) => {
    if (reattachOnKey) return reattach()
    return studio.paneInput(paneId, data)
  })
  // 누른 pane 으로 포커스(데몬에도 알려 pane current · split --target focused 가 맞게)
  el.addEventListener('mousedown', () => focusPane(paneId))
  const view = { term, fit, el, head, shown: false, sent: null, dock }
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
  const alive = new Set(screen.panes.map((pane) => pane.id))
  for (const paneId of [...views.keys()]) if (!alive.has(paneId)) disposeView(paneId)
  for (const pane of screen.panes) ensureView(pane.id, Boolean(pane.dock))
  renderTabs()
  renderSides()
  layoutPanes()
  ensureSomeTab()
  ensureMonitor()
}

// 모니터 칸이 없어졌으면(셸에서 exit 등) 다시 띄운다 — 처음 켤 때는 startScreen 이 띄운다
let openingMonitor = false
function ensureMonitor() {
  if (starting || openingMonitor || !attached || screen.panes.some((pane) => pane.dock === 'monitor')) return
  openingMonitor = true
  studio.dockMonitor().finally(() => (openingMonitor = false))
}

// 탭이 하나도 없으면(마지막 셸을 닫음 · 새 데몬) 아테나 폴더에서 셸 탭 하나 — 에이전트를 고르는 중이면 고른 뒤 athena 탭이 생긴다
let openingTab = false
let starting = false // 처음 켤 때는 에이전트 판단(athena 탭)이 끝난 뒤에 본다
function ensureSomeTab() {
  if (screen.tabs.length || openingTab || starting || !state || !state.valid || !$('agent-picker').hidden) return
  openingTab = true
  newTab().finally(() => (openingTab = false))
}

// 가운데 탭 줄 — 지금 작업 공간의 탭만. ✕ 로 닫는다(에이전트가 돌면 main 이 묻는다)
function renderTabs() {
  const bar = $('studio-tabs')
  const current = activeTab()
  const buttons = screen.tabs
    .filter((tab) => tab.workspace === screen.activeWorkspace)
    .map((tab, index) => {
      const button = document.createElement('button')
      button.className = 'studio-tab'
      button.setAttribute('aria-selected', String(Boolean(current) && tab.id === current.id))
      button.addEventListener('click', () => studio.tabSelect(tab.id))
      const name = document.createElement('span')
      name.textContent = tab.label || `탭 ${index + 1}`
      const close = document.createElement('span')
      close.className = 'close'
      close.textContent = '✕'
      close.title = `탭 닫기 (${state.tabKey}⌥W)`
      close.addEventListener('click', (event) => {
        event.stopPropagation()
        studio.tabClose(tab.id)
      })
      button.append(name, close)
      return button
    })
  const add = document.createElement('button')
  add.className = 'studio-tab add'
  add.textContent = '＋'
  add.title = `새 탭 (${state.tabKey}T)`
  add.addEventListener('click', newTab)
  bar.replaceChildren(...buttons, add)
}

// ── 왼쪽 spaces · 오른쪽 패널 ──
function agentPanes() {
  return screen.panes.map((pane) => paneInfo.get(pane.id)).filter((pane) => pane && pane.agent)
}

// 접기·펴기 버튼(« ») — 칸 머리에 붙는다
function foldButton(text, title, onClick) {
  const button = document.createElement('button')
  button.className = 'fold-button'
  button.textContent = text
  button.title = title
  button.addEventListener('click', onClick)
  return button
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

// 접힌 왼쪽 — 작업 공간마다 아이콘 하나(에이전트는 가운데 맨 위 카드에서 보여 준다)
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
  add.title = `새 작업 공간 (${state.tabKey}⇧T)`
  add.addEventListener('click', () => runCommand('new-workspace'))
  return [foldButton('»', `작업 공간 펴기 (${state.tabKey}B)`, () => setSpacesCollapsed(false)), ...rows, add]
}

// 가운데 맨 위 에이전트 — 아바타 카드를 옆으로(사용자가 시안 3 을 고름). 일하는 것 먼저, 그다음 작업 공간 순
function renderAgentList(agents) {
  const order = new Map(screen.workspaces.map((workspace, index) => [workspace.id, index]))
  const sorted = [...agents].sort((left, right) => {
    const working = Number(right.agent_status === 'working') - Number(left.agent_status === 'working')
    return working || (order.get(left.workspace_id) ?? 99) - (order.get(right.workspace_id) ?? 99)
  })
  const rows = sorted.map((pane) => {
    const card = document.createElement('button')
    card.className = `agent-card${pane.id === screen.focused ? ' current' : ''}`
    const workspace = screen.workspaces.find((entry) => entry.id === pane.workspace_id)
    const delegated = (pane.label || '').match(/^🤖\s*(\S+)/)
    const working = pane.agent_status === 'working'
    // 아바타 — 작업 공간 색 동그라미 + 이름 두 글자(접힌 왼쪽 아이콘과 같은 규칙) · 오른쪽 아래 상태 점
    const avatar = document.createElement('span')
    avatar.className = `agent-avatar${working ? ' working' : ''}`
    avatar.style.setProperty('--space-color', spaceColor(workspace ? workspace.label : pane.agent))
    avatar.textContent = spaceInitials(workspace ? workspace.label : pane.agent)
    const text = document.createElement('span')
    text.className = 'agent-text'
    const name = document.createElement('span')
    name.className = 'agent-name'
    name.textContent = delegated ? delegated[1] : pane.label || pane.agent
    const sub = document.createElement('span')
    sub.className = 'agent-sub'
    const status = working ? '일하는 중' : '대기'
    sub.textContent = workspace ? `${workspace.label} · ${status}` : status
    text.append(name, sub)
    card.append(avatar, text)
    // 브랜치·주제(지금 하는 일)는 마우스를 올리면
    card.title = [pane.label || pane.agent, workspacePlace(workspace), pane.title].filter(Boolean).join('\n')
    card.addEventListener('click', () => {
      if (currentTab !== 'work') switchTab('work')
      studio.paneFocus(pane.id)
    })
    return card
  })
  if (!rows.length) rows.push(Object.assign(document.createElement('div'), { className: 'side-empty', textContent: '돌고 있는 에이전트가 없어요' }))
  $('agent-list-rows').replaceChildren(...rows)
}

// '작업 공간 · 브랜치'(브랜치를 모르면 이름만)
function workspacePlace(workspace) {
  if (!workspace) return ''
  return branches[workspace.id] ? `${workspace.label} · ${branches[workspace.id]}` : workspace.label
}

function renderSides() {
  renderAgentList(agentPanes())
  const spaces = $('spaces')
  if (spaces.classList.contains('collapsed')) {
    spaces.replaceChildren(...spaceRail())
    if (explorerView.workspace !== screen.activeWorkspace) resetExplorer()
    return
  }
  // 왼쪽: 작업 공간(레포)만 — 에이전트는 가운데 맨 위 카드에서 보여 준다
  const title = document.createElement('div')
  title.className = 'side-title with-fold'
  const titleText = document.createElement('span')
  titleText.textContent = '작업 공간'
  title.append(titleText, foldButton('«', `작업 공간 접기 (${state.tabKey}B)`, () => setSpacesCollapsed(true)))
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
  const add = document.createElement('button')
  add.className = 'space add-space'
  add.textContent = `＋ 새 작업 공간 (${state.tabKey}⇧T)`
  add.addEventListener('click', () => runCommand('new-workspace'))
  spaces.replaceChildren(title, ...rows, add)

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

function treeRow({ depth, label, mark, markClass, dotfile, onClick, title, icon }) {
  const row = document.createElement('button')
  row.className = `tree-row${dotfile ? ' dotfile' : ''}`
  row.style.paddingLeft = `${6 + depth * 12}px`
  row.title = title || label
  const name = document.createElement('span')
  name.className = 'label'
  name.textContent = label
  const tail = document.createElement('span')
  tail.className = `mark ${markClass || ''}`
  tail.textContent = mark || ''
  row.append(...(icon ? [icon] : []), name, tail)
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
      rows.push(treeRow({ depth, label: '읽는 중…', onClick: () => {} }))
      return
    }
    if (entries.error) {
      rows.push(treeRow({ depth, label: entries.error, onClick: () => {} }))
      return
    }
    for (const entry of entries) {
      const relative = joinPath(folder, entry.name)
      if (entry.dir) {
        const open = explorerView.expanded.has(relative)
        rows.push(
          treeRow({
            depth,
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
          treeRow({ depth, icon: iconElement(entry), label: entry.name, mark: code, markClass: code ? `code-${code}` : '', dotfile: entry.name.startsWith('.'), onClick: () => openPreview(relative) }),
        )
      }
    }
  }
  walk('.', 0)
  return rows
}

function changeRows() {
  if (!explorerView.git) return [treeRow({ depth: 0, label: 'git 레포가 아니에요', onClick: () => {} })]
  if (!explorerView.changes.length) return [treeRow({ depth: 0, label: '바뀐 파일이 없어요', onClick: () => {} })]
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
    empty.textContent = '작업 공간이 없어요'
    panel.replaceChildren(empty)
    return
  }
  const head = document.createElement('div')
  head.className = 'explorer-head'
  const name = document.createElement('span')
  name.className = 'explorer-name'
  name.textContent = workspace.label
  name.title = `${workspace.cwd} (${state.tabKey}⌥B 접기)`
  const viewButton = (mode, label) => {
    const button = document.createElement('button')
    button.className = 'view-button'
    button.textContent = label
    button.setAttribute('aria-pressed', String(explorerView.mode === mode))
    button.addEventListener('click', () => {
      explorerView.mode = mode
      renderExplorer()
    })
    return button
  }
  const count = explorerView.changes.length
  head.append(name, viewButton('files', '파일'), viewButton('changes', count ? `변경 ${count}` : '변경'), foldButton('»', `Explorer 접기 (${state.tabKey}⌥B)`, () => setPanelHidden(true)))
  const scroll = panel.scrollTop
  panel.replaceChildren(head, ...(explorerView.mode === 'files' ? fileRows() : changeRows()))
  panel.scrollTop = scroll
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
  else if (result.kind === 'binary') body.replaceChildren(note(`바이너리 파일이라 보여 주지 않아요 (${result.size} 바이트)`))
  else if (result.kind === 'image') {
    const image = document.createElement('img')
    image.className = 'viewer-image'
    image.alt = result.path
    image.src = result.src
    body.className = 'preview-body image'
    body.replaceChildren(image)
  } else {
    const diff = result.kind === 'diff'
    if (result.bg) body.style.background = result.bg
    if (result.fg) body.style.color = result.fg
    body.replaceChildren(...result.rows.map((row) => viewerLine(row, diff)))
    if (result.untracked) body.prepend(note('새 파일(git 에 아직 없음)'))
    if (result.truncated) body.append(note('… 512KB 까지만 보여 줘요'))
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
  // 숨긴 칸의 터미널에 키 입력이 남지 않게 — 커서를 뺀다(그 뒤 pane 을 누르면 다시 잡힌다)
  if (!showDock && $('dock').contains(document.activeElement)) document.activeElement.blur()
  const container = $('panes')
  const tab = activeTab()
  const rects = tab ? StudioLayout.computeRects(tab.tree, { x: 0, y: 0, width: container.clientWidth, height: container.clientHeight }, PANE_GAP) : {}
  const meta = new Map(screen.panes.map((pane) => [pane.id, pane]))
  for (const [paneId, view] of views) {
    const rect = rects[paneId]
    // 고정 칸은 배치 트리 밖 — athena 작업 공간에서만 보이고 칸을 꽉 채운다. 숨긴 동안은 크기를 맞추지 않는다(모니터는 데몬에서 계속 돈다)
    view.el.hidden = view.dock ? !showDock : !rect
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
    if (!view.sent || view.sent.cols !== cols || view.sent.rows !== rows) {
      view.sent = { cols, rows }
      studio.paneResize(paneId, cols, rows)
    }
  }
  reportTabSize(tab, container)
  const focused = views.get(screen.focused)
  if (focused && !focused.el.hidden && currentTab === 'work') focused.term.focus()
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
  const sample = [...views.values()].find((view) => !view.el.hidden && !view.dock && view.term.cols > 1)
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
    for (const pane of screen.panes) {
      const view = ensureView(pane.id, Boolean(pane.dock))
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
  if (result.error) showToast(`새 탭을 열지 못했어요: ${result.error}`)
}

// 메뉴 단축키(⌘T · ⌘D · ⌘⇧D · ⌘W · ⌘⌥방향 · ⌘⇧[ ]) — Ctrl 은 pane 안으로 간다
async function runCommand(name) {
  if (!state || !state.valid || !attached) return
  if (currentTab !== 'work') switchTab('work')
  // 나누기·닫기·이동의 기준은 지금 탭의 pane — 모니터 칸(dock)에 포커스가 있으면 탭의 첫 pane
  const focused = tabPaneForCommand()
  if (name === 'new-tab') return newTab()
  if (name === 'split-right' || name === 'split-down') {
    if (!focused) return newTab()
    const result = await studio.paneSplit(focused, name === 'split-down' ? 'down' : 'right')
    if (result.error) showToast(`나누지 못했어요: ${result.error}`)
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
    if (result.error) showToast(`작업 공간을 만들지 못했어요: ${result.error}`)
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
    await openAgent()
    await studio.dockMonitor()
  } finally {
    starting = false
  }
  // 에이전트를 못 켰어도 셸 탭 하나는 있게(고르는 중이면 건너뛴다)
  ensureSomeTab()
}

// athena 탭에서 claude · codex 를 켠다(이미 있으면 그 탭으로). 둘 다 깔려 있으면 고르게 한다
async function openAgent(chosen) {
  const result = await studio.openAgent(chosen, estimateCells($('panes')))
  if (result.choose) showAgentPicker(result.choose)
  else if (result.error) showToast(result.error)
  return result
}

// 알림은 pane 위에 따로 띄운다(누르면 닫힘)
function showToast(message) {
  const toast = $('toast')
  toast.textContent = message
  toast.hidden = false
  toast.onclick = () => (toast.hidden = true)
}

const AGENT_LABELS = { claude: 'Claude', codex: 'Codex' }

function showAgentPicker(agents) {
  const picker = $('agent-picker')
  const options = $('agent-options')
  options.replaceChildren(
    ...agents.map((agent) => {
      const button = document.createElement('button')
      button.className = 'primary'
      button.textContent = AGENT_LABELS[agent] || agent
      button.addEventListener('click', () => {
        picker.hidden = true
        openAgent(agent)
      })
      return button
    }),
  )
  picker.hidden = false
  options.firstChild.focus()
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
  status.textContent = '현황판을 여는 중…'
  status.hidden = false
  try {
    const result = await studio.ensureBoard()
    if (!result.ok) {
      status.className = 'status error'
      status.textContent = `${result.error}${result.log ? `\n로그: ${result.log}` : ''}\n\n${state.tabKey}R 로 다시 시도해요.`
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

// ── 탭 ──────────────────────────────────────────────────
function switchTab(name) {
  if (!state || !state.valid) return
  currentTab = name
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name))
  panels.work.hidden = name !== 'work'
  panels.board.hidden = name !== 'board'
  if (name === 'work') {
    requestAnimationFrame(layoutPanes)
  } else {
    // 작업 창이 숨으면 모든 칸이 안 보이는 것 — 돌아올 때 다시 그리도록(layoutPanes) 표시만 해 둔다
    for (const view of views.values()) view.shown = false
    loadBoard()
    $('board-frame').focus()
  }
}

// ── 아테나 폴더 ────────────────────────────────────────────
function renderState() {
  document.body.dataset.platform = state.platform
  // rtl 로 앞을 줄이는 칸이라 맨 앞 / 가 뒤로 붙지 않게 LRM 을 앞에 둔다
  $('athena-dir').textContent = state.athenaDir ? `‎${state.athenaDir}` : ''
  $('install-dir').textContent = state.installDir || ''
  for (const kbd of document.querySelectorAll('kbd[data-key]')) kbd.textContent = `${state.tabKey}${kbd.dataset.key}`
  const ready = state.valid
  panels.setup.hidden = ready
  for (const tab of tabs) tab.disabled = !ready
  if (!ready) {
    panels.work.hidden = true
    panels.board.hidden = true
  }
}

const pickAthenaDir = () => applyAthenaResult(studio.pickAthenaDir())

// 처음 켤 때 아테나가 없으면 묻지 않고 받는다. 실패했을 때만 [다시 받기] · [폴더 고르기] 를 보여 준다
async function installAthena() {
  const buttons = [$('install'), $('pick')]
  const progress = $('setup-progress')
  for (const button of buttons) button.hidden = true
  $('setup-error').hidden = true
  $('spinner').hidden = false
  $('setup-title').textContent = '아테나 설치 중…'
  $('setup-note').hidden = false
  progress.textContent = ''
  progress.hidden = false
  try {
    await applyAthenaResult(studio.installAthena())
  } finally {
    $('spinner').hidden = true
    progress.hidden = true
    if (!state.valid) {
      $('setup-title').textContent = '아테나를 설치하지 못했어요'
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
  }
}

async function init() {
  state = await studio.athenaState()
  renderState()
  for (const tab of tabs) tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  $('pick').addEventListener('click', pickAthenaDir)
  $('install').addEventListener('click', installAthena)
  studio.onInstallProgress((line) => ($('setup-progress').textContent = line))
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
  studio.onScreenPanes((panes) => {
    paneInfo = new Map(panes.map((pane) => [pane.id, pane]))
    if (attached) renderSides()
  })
  const panelHidden = localStorage.getItem('studio.panelHidden') === '1'
  $('side-panel').hidden = panelHidden
  $('side-rail').hidden = !panelHidden
  $('side-open').addEventListener('click', () => setPanelHidden(false))
  $('spaces').classList.toggle('collapsed', localStorage.getItem('studio.spacesCollapsed') === '1')
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
    showScreenStatus('작업 창 데몬과 연결이 끊겼어요 — pane 을 누르고 아무 키나 누르면 다시 붙어요(메뉴 [보기 → 작업 창 다시 붙기])')
  })
  studio.onScreenCommand(runCommand)
  new ResizeObserver(() => layoutPanes()).observe($('panes'))
  new ResizeObserver(() => layoutPanes()).observe($('dock'))
  if (state.valid) {
    switchTab('work')
    startScreen()
  } else {
    installAthena()
  }
}

init()
