// 앱 화면 — 탭 두 개(작업 창 · 현황판)와 처음 켤 때 아테나 폴더 고르기
// studio 는 preload 의 contextBridge 가 만든 전역이다 — 같은 이름으로 다시 선언하면 이 파일 전체가 SyntaxError 로 죽는다
/* global studio, Terminal, FitAddon, WebLinksAddon, Unicode11Addon */
const $ = (id) => document.getElementById(id)

const panels = { setup: $('setup'), work: $('work'), board: $('board') }
const tabs = [...document.querySelectorAll('.tab')]

let state = null
let currentTab = 'work'

// ── 작업 창 ────────────────────────────────────────────────
let term = null
let fit = null
let termRunning = false
let restartOnKey = false

function createTerminal() {
  term = new Terminal({
    allowProposedApi: true, // unicode11 에 필요
    fontFamily: '"SF Mono", Menlo, "D2Coding", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true, // herdr 가 마우스를 잡아도 Option+드래그로 고를 수 있게
    theme: { background: '#14161a', foreground: '#d8dbe0' },
  })
  fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event, uri) => studio.openUrl(uri)))
  // herdr 가 이모지(🤖 🧭)를 두 칸으로 세는 것과 맞춘다
  term.loadAddon(new Unicode11Addon.Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.open($('terminal'))

  term.onData((data) => {
    if (restartOnKey) {
      restartOnKey = false
      term.reset()
      startTerminal()
      return
    }
    studio.termInput(data)
  })
  term.onResize(({ cols, rows }) => studio.termResize(cols, rows))

  studio.onTermData((data) => term.write(data))
  studio.onTermExit(() => {
    termRunning = false
    restartOnKey = true
    term.write('\r\n\x1b[2m[작업 창이 끝났어요 — 아무 키나 누르면 다시 시작해요. herdr 의 에이전트는 계속 돌고 있어요]\x1b[0m\r\n')
  })

  new ResizeObserver(() => {
    if (currentTab === 'work') fitTerminal()
  }).observe($('terminal'))
}

function fitTerminal() {
  if (!fit || panels.work.hidden) return
  try {
    fit.fit()
  } catch {}
}

async function startTerminal() {
  if (!term) createTerminal()
  fitTerminal()
  if (termRunning) return
  const result = await studio.termStart(term.cols, term.rows)
  if (result.error) {
    term.write(`\x1b[31m${result.error}\x1b[0m\r\n`)
    return
  }
  termRunning = true
  // pty 를 띄운 뒤 크기를 한 번 더 알려 herdr 가 맞게 다시 그리게 한다
  studio.termResize(term.cols, term.rows)
  if (currentTab === 'work') term.focus()
}

async function restartTerminal() {
  await studio.termStop()
  termRunning = false
  restartOnKey = false
  if (term) term.reset()
  startTerminal()
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
    requestAnimationFrame(() => {
      fitTerminal()
      if (term) term.focus()
    })
  } else {
    loadBoard()
    $('board-frame').focus()
  }
}

// ── 아테나 폴더 ────────────────────────────────────────────
function renderState() {
  document.body.dataset.platform = state.platform
  $('athena-dir').textContent = state.athenaDir || ''
  for (const kbd of document.querySelectorAll('kbd[data-key]')) kbd.textContent = `${state.tabKey}${kbd.dataset.key}`
  const ready = state.valid
  panels.setup.hidden = ready
  for (const tab of tabs) tab.disabled = !ready
  if (!ready) {
    panels.work.hidden = true
    panels.board.hidden = true
  }
}

async function pickAthenaDir() {
  const result = await studio.pickAthenaDir()
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
    // 폴더가 바뀌었으면 작업 창은 새 폴더에서 다시 연다
    termRunning = false
    restartOnKey = false
    if (term) term.reset()
    boardLoaded = false
    switchTab('work')
    startTerminal()
  }
}

async function init() {
  state = await studio.athenaState()
  renderState()
  for (const tab of tabs) tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  $('pick').addEventListener('click', pickAthenaDir)
  studio.onTabSwitch(switchTab)
  studio.onPickRequest(pickAthenaDir)
  studio.onTermRestart(() => state.valid && restartTerminal())
  studio.onBoardReload(() => state.valid && loadBoard(true))
  if (state.valid) {
    switchTab('work')
    startTerminal()
  }
}

init()
