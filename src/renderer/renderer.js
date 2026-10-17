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
const views = new Map() // paneId → { term, fit, el, head, shown, sent: {cols, rows} }
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

// 탭이 하나도 없으면(마지막 셸을 닫음 · 새 데몬) 아테나 폴더에서 셸 탭 하나 — 에이전트를 고르는 중이면 고른 뒤 athena 탭이 생긴다
let openingTab = false
let starting = false // 처음 켤 때는 에이전트 판단(athena 탭)이 끝난 뒤에 본다
function ensureSomeTab() {
  if (screen.tabs.length || openingTab || starting || !state || !state.valid || !$('agent-picker').hidden) return
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
      button.title = '더블클릭하면 이름 바꾸기'
      button.addEventListener('dblclick', () => startTabRename(button, tab, name.textContent))
      return button
    })
  const add = document.createElement('button')
  add.className = 'studio-tab add'
  add.textContent = '＋'
  add.title = `새 탭 (${state.tabKey}T)`
  add.setAttribute('aria-label', '새 탭') // ＋ 글자는 아이콘으로 가려져 있어 읽기용 이름을 따로
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
  input.setAttribute('aria-label', '탭 이름')
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
        showToast(`탭 이름을 바꾸지 못했어요 — ${result.error}`)
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
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  return `${Math.floor(minutes / 60)}시간 전`
}

function sessionLabelOf(sessionId) {
  const session = monitorView.sessions.find((entry) => entry.id === sessionId)
  return session ? session.label : '?'
}

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
    ['monitor-text', event.text],
  ]
  for (const [className, text] of cells) {
    const cell = document.createElement('span')
    cell.className = className
    cell.textContent = text
    row.append(cell)
  }
  row.title = `${label} · ${event.name ? `${event.name} · ` : ''}${event.text}`
  return row
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
    chip.title = `${session.label}\n${session.pane ? 'pane 세션' : session.finished ? '서브에이전트 · 끝남' : '서브에이전트'} · 도구 ${session.tools}개 · 마지막 ${sinceText(session.lastAt)}\n누르면 이 세션만 보기`
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
    const empty = Object.assign(document.createElement('div'), { className: 'monitor-empty', textContent: monitorView.sessions.length ? '아직 보일 활동이 없어요' : '돌고 있는 에이전트가 없어요 — 뜨면 여기에 붙어요' })
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
      element.title = '끌어서 크기 바꾸기 · 더블클릭하면 반반'
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
    if (!ratioUnsupportedNoticed) showToast('지금 데몬이 예전 버전이라 이 크기는 앱을 다시 켜면 돌아가요 — [보기 → 작업 창 데몬 다시 띄우기] 뒤로는 저장돼요')
    ratioUnsupportedNoticed = true
    return
  }
  if (result.error) {
    ratioOverrides.delete(key)
    showToast(`크기를 저장하지 못했어요: ${result.error}`)
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
  if (result.error) showToast(`새 탭을 열지 못했어요: ${result.error}`)
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

// ── 옆 브라우저 ──────────────────────────────────────────
// 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그린다 — 화면 위에 따로 떠 있어서
// 다 나온 뒤에 자리(#browser-slot)를 알려 붙이고, 닫을 땐 먼저 떼고 미끄러져 들어간다
const BROWSER_SLIDE_MS = 240
let browserOpen = false
let browserTimer = null
let urlFocusTimer = null

function openBrowserPanel() {
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
  $('browser-reload').title = next.loading ? '멈추기' : '새로고침'
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
  studio.onBrowserToggle(toggleBrowserPanel)
  studio.onBrowserState(applyBrowserState)
  studio.onBrowserError(showBrowserError)
  // 창 크기가 바뀌면 서랍(너비 46%)도 바뀐다 — 다 나와 있을 때만 다시 붙인다
  new ResizeObserver(() => placeBrowserView()).observe($('browser-slot'))
}

// ── 탭 ──────────────────────────────────────────────────
function switchTab(name) {
  if (!state || !state.valid) return
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

// ── 아테나 폴더 ────────────────────────────────────────────
function renderState() {
  document.body.dataset.platform = state.platform
  $('install-dir').textContent = state.installDir || ''
  for (const kbd of document.querySelectorAll('kbd[data-key]')) kbd.textContent = `${state.tabKey}${kbd.dataset.key}`
  $('browser-toggle').title = `옆 브라우저 열기·닫기 (${state.tabKey}⇧B)`
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
  initBrowser()
  initMonitor()
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
