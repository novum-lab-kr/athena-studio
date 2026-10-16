// Athena Studio 메인 프로세스 — 창 · 메뉴(단축키) · 작업 창 pty · 현황판 서버 · 아테나 폴더 설정
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const pty = require('node-pty')
const core = require('./lib/core')

const isMac = process.platform === 'darwin'
// Ctrl 조합은 herdr 몫이라 탭 전환은 Cmd(맥) · Alt(그 밖)로만 건다
const TAB_KEY = isMac ? 'Command' : 'Alt'

let mainWindow = null
let term = null // 작업 창 pty (한 개)
let config = null

const configFile = () => path.join(app.getPath('userData'), 'config.json')
const boardLogFile = () => path.join(app.getPath('userData'), 'board.log')

// 맥에서 Finder · Dock 으로 켠 앱은 PATH 가 /usr/bin:/bin 뿐이다. 로그인 셸의 PATH 를 받아 쓴다
function loadLoginPath() {
  const loginShell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      loginShell,
      ['-ilc', `printf '%s%s%s' '${core.PATH_MARK}' "$PATH" '${core.PATH_MARK}'`],
      { timeout: 5000, encoding: 'utf8' },
      (error, stdout) => resolve(core.parseMarkedPath(stdout || '')),
    )
  })
}

function athenaState() {
  const check = core.checkAthenaDir(config.athenaDir)
  return {
    athenaDir: config.athenaDir,
    valid: check.ok,
    missing: check.missing,
    boardUrl: core.boardUrl(config.boardPort),
    tabKey: isMac ? '⌘' : 'Alt+',
    platform: process.platform,
  }
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

// ── 작업 창 ────────────────────────────────────────────────
function startTerminal(cols, rows) {
  if (term) return { running: true }
  const check = core.checkAthenaDir(config.athenaDir)
  if (!check.ok) return { error: '아테나 폴더가 정해지지 않았어요' }

  const herdrPath = core.findExecutable('herdr', process.env.PATH)
  const launch = core.terminalLaunch({ herdrPath, shell: process.env.SHELL })
  if (launch.notice) send('term:data', launch.notice)

  try {
    term = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols | 0) || 80,
      rows: Math.max(2, rows | 0) || 24,
      cwd: config.athenaDir,
      env: core.terminalEnv(process.env),
    })
  } catch (error) {
    term = null
    return { error: `작업 창을 띄우지 못했어요: ${error.message}` }
  }
  const current = term
  current.onData((data) => send('term:data', data))
  current.onExit(({ exitCode }) => {
    if (term === current) term = null
    send('term:exit', exitCode)
  })
  return { running: true, herdr: Boolean(herdrPath) }
}

// herdr 클라이언트만 끈다 — herdr 서버와 에이전트는 계속 돈다
function stopTerminal() {
  if (!term) return
  const current = term
  term = null
  try {
    current.kill()
  } catch {}
}

// ── 현황판 ────────────────────────────────────────────────
function isBoardUp(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (response) => {
      response.resume()
      resolve(response.statusCode < 500)
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

// scripts/board.sh 는 브라우저를 열고 herdr pane 을 가르므로 쓰지 않고 server.mjs 를 직접 띄운다.
// 앱을 닫아도 현황판은 계속 돈다(board.sh 의 백그라운드 실행과 같다)
let boardStarting = null

async function ensureBoard() {
  const port = config.boardPort
  const url = core.boardUrl(port)
  if (await isBoardUp(port)) return { ok: true, url, started: false }
  if (!core.checkAthenaDir(config.athenaDir).ok) return { ok: false, url, error: '아테나 폴더가 정해지지 않았어요' }
  if (!boardStarting) boardStarting = startBoard(port).finally(() => (boardStarting = null))
  return boardStarting
}

async function startBoard(port) {
  const url = core.boardUrl(port)
  const logFile = boardLogFile()
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.openSync(logFile, 'a')
  fs.writeSync(log, `\n── ${new Date().toISOString()} 현황판 시작 (포트 ${port})\n`)

  // node 가 PATH 에 없으면 Electron 을 node 로 돌린다
  const nodePath = core.findExecutable('node', process.env.PATH)
  const extra = { ATHENA_BOARD_PORT: String(port) }
  if (!nodePath) extra.ELECTRON_RUN_AS_NODE = '1'
  const env = core.childEnv(process.env, extra)

  let exited = null
  try {
    const child = spawn(nodePath || process.execPath, [path.join(config.athenaDir, 'scripts', 'board', 'server.mjs')], {
      cwd: config.athenaDir,
      env,
      detached: true,
      stdio: ['ignore', log, log],
    })
    child.on('exit', (code) => (exited = code))
    child.on('error', (error) => (exited = error.message))
    child.unref()
  } catch (error) {
    return { ok: false, url, error: `현황판을 띄우지 못했어요: ${error.message}`, log: logFile }
  } finally {
    fs.closeSync(log)
  }

  for (let i = 0; i < 40; i++) {
    if (await isBoardUp(port)) return { ok: true, url, started: true }
    if (exited !== null) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const why = exited !== null ? `서버가 바로 끝났어요(${exited})` : '10초 안에 뜨지 않았어요'
  return { ok: false, url, error: `현황판을 띄우지 못했어요 — ${why}`, log: logFile }
}

// ── 아테나 폴더 ────────────────────────────────────────────
async function pickAthenaDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '아테나 폴더 고르기',
    message: 'CLAUDE.md 와 scripts/board/server.mjs 가 있는 아테나 폴더를 골라 주세요',
    properties: ['openDirectory'],
    defaultPath: config.athenaDir || app.getPath('home'),
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true, ...athenaState() }
  const dir = result.filePaths[0]
  const check = core.checkAthenaDir(dir)
  if (!check.ok) return { ...athenaState(), error: `아테나 폴더가 아니에요 — 없는 파일: ${check.missing.join(', ')}`, picked: dir }
  const changed = dir !== config.athenaDir
  config = { ...config, athenaDir: dir }
  core.saveConfig(configFile(), config)
  if (changed) stopTerminal()
  return { ...athenaState(), changed }
}

// ── 새 창 · 링크 ──────────────────────────────────────────
function openUrl(url) {
  const kind = core.classifyOpen(url, config.boardPort)
  if (kind === 'external') shell.openExternal(url)
  if (kind === 'app') new BrowserWindow(childWindowOptions()).loadURL(url)
  return kind
}

function childWindowOptions() {
  return {
    width: 1200,
    height: 860,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  }
}

// 결정 콘솔 같은 현황판 주소는 앱 안 새 창, 그 밖은 기본 브라우저
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (core.classifyOpen(url, config.boardPort) === 'app') {
      return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions() }
    }
    openUrl(url)
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

// ── 창 · 메뉴 ─────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'Athena Studio',
    titleBarStyle: isMac ? 'hiddenInset' : 'default', // 맥은 탭 줄이 제목 줄을 겸한다
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // 맨 위 페이지는 앱 화면에서 벗어나지 않는다(현황판은 iframe 안에서만 움직인다)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openUrl(url)
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    stopTerminal()
  })
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '파일',
      submenu: [
        { label: '아테나 폴더 바꾸기…', click: () => send('athena:pick') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '편집',
      submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: '보기',
      submenu: [
        { label: '🖥 작업 창', accelerator: `${TAB_KEY}+1`, click: () => send('tab:switch', 'work') },
        { label: '📋 현황판', accelerator: `${TAB_KEY}+2`, click: () => send('tab:switch', 'board') },
        { type: 'separator' },
        { label: '현황판 새로고침', accelerator: 'CmdOrCtrl+R', click: () => send('board:reload') },
        { label: '작업 창 다시 시작', click: () => send('term:restart') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC ──────────────────────────────────────────────────
ipcMain.handle('athena:state', () => athenaState())
ipcMain.handle('athena:pick', () => pickAthenaDir())
ipcMain.handle('term:start', (_event, cols, rows) => startTerminal(cols, rows))
ipcMain.handle('term:stop', () => stopTerminal())
ipcMain.on('term:input', (_event, data) => {
  if (term && typeof data === 'string') term.write(data)
})
ipcMain.on('term:resize', (_event, cols, rows) => {
  if (term && cols > 1 && rows > 1) {
    try {
      term.resize(cols | 0, rows | 0)
    } catch {}
  }
})
ipcMain.handle('board:ensure', () => ensureBoard())
ipcMain.handle('open:url', (_event, url) => openUrl(url))

app.whenReady().then(async () => {
  app.setName('Athena Studio')
  config = core.loadConfig(configFile())
  const loginPath = await loadLoginPath()
  if (loginPath) process.env.PATH = core.mergePath(loginPath, process.env.PATH)
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (!mainWindow) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => stopTerminal())
