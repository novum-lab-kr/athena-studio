// Athena Studio 메인 프로세스 — 창 · 메뉴(단축키) · 작업 창(데몬에 붙기) · 일감 서버 · 아테나 폴더 설정
// 창마다 팩 하나 — 창마다 그 팩 본체(athenaDir) · 데몬 연결(본체로 묶임) · 일감 · 옆 브라우저 · 모니터를 따로 갖는다(createPackWindow).
// 앱 전체에 하나인 것: 언어 · 앱 설정 · 데몬 프로세스 · 메뉴 · 메뉴 막대(Tray — 앞에 있는 창의 팩만)
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, session, shell } = require('electron')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const core = require('./lib/core.mts')
const studioHome = require('./lib/studio-home')
const packModel = require('./lib/pack.mts')
const screenModel = require('./lib/screen-model')
const daemonClient = require('./daemon-client.mts')
const i18n = require('./lib/i18n')
const agentLanguage = require('./lib/agent-language.mts')
const paneDetail = require('./lib/pane-detail.mts')
const tokenUsage = require('./lib/token-usage.mts')
const layout = require('./lib/layout')

const isMac = process.platform === 'darwin'
// 앱 신원 — 개발 앱(npm start)과 배포판이 앱 데이터(설정 · 데몬 소켓) · 데몬 접속 파일을 같이 쓰지 않는다.
// 앱 데이터 자리는 ready 전에 정해야 한다. ATHENA_STUDIO_HOME — 격리 실행(시험): 스튜디오 집 · 앱 데이터를 그 아래로
const IDENTITY = studioHome.appIdentity({ packaged: app.isPackaged })
const STUDIO_HOME_OVERRIDE = process.env.ATHENA_STUDIO_HOME || null
app.setName(IDENTITY.name)
// --user-data-dir 로 직접 준 자리는 그대로 둔다(AGENTS.md '격리 실행')
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', studioHome.userDataDir({ appData: app.getPath('appData'), identity: IDENTITY, override: STUDIO_HOME_OVERRIDE }))
}
// 스튜디오 집 — ~/.athena-studio/{core,bodies,data,daemon.json}. 본체 · 데이터 · 포트를 모두 이 아래에 둔다
const STUDIO = studioHome.studioLayout({ home: app.getPath('home'), override: STUDIO_HOME_OVERRIDE, identity: IDENTITY })
// pane [상세] 토큰 — 대화 기록 읽은 자리 · 합계를 창 사이에 같이 쓴다(기록 파일은 팩 · 창과 상관없는 Claude Code 자리)
const paneTokens = tokenUsage.createTokenUsage({ projectsDir: path.join(app.getPath('home'), '.claude', 'projects') })
// 앱이 들고 온 아테나 코어(git 번들) — 앱 리소스 자리 하나(개발 앱은 npm start 가 레포 athena/ 에서 만든다)
const CORE_BUNDLE = studioHome.coreBundlePath({ appRoot: path.join(__dirname, '..'), packaged: app.isPackaged, resourcesPath: process.resourcesPath })
// 앱 아이콘 — 둥근 사각형 앱 아이콘(1024 · Dock · 윈도우·리눅스 창). 화면 안 로고는 화이트판(athena-logo-white.png)
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'logo', 'athena-app-icon.png')
// 창 · 빈 옆 브라우저 바탕 — renderer style.css --bg 와 같은 값
const APP_BACKGROUND = '#16171a'
// Ctrl 조합은 pane 안(셸·에이전트) 몫이라 앱 단축키는 Cmd(맥) · Alt(그 밖)로만 건다
const TAB_KEY = isMac ? 'Command' : 'Alt'

let config = null // 앱 설정(언어 · 열린 팩 창 목록 windows · 옛 일감 포트 …)
const packWindows = new Set() // 열린 팩 창 — createPackWindow 의 문맥
let lastFocused = null // 마지막으로 앞에 있던 팩 창(메뉴 · 메뉴 막대가 이 창 기준)

// ── 언어 ──────────────────────────────────────────────────
// 사전은 src/i18n/<언어>.json. 앱 설정 language → 없으면 시스템 언어(app.getLocale()) → 네 언어 밖이면 영어.
// 화면 · 트레이 창은 preload 가 i18n:get 으로 사전을 받고, 바꾸면 i18n:changed 로 다시 받는다
const DICTIONARIES = Object.fromEntries(i18n.LANGUAGES.map((lang) => [lang, require(`./i18n/${lang}.json`)]))
let language = i18n.FALLBACK_LANGUAGE
const say = (key, values) => i18n.t(DICTIONARIES[language], key, values, DICTIONARIES[i18n.FALLBACK_LANGUAGE])
const i18nPayload = () => ({ language, dictionary: DICTIONARIES[language], fallback: DICTIONARIES[i18n.FALLBACK_LANGUAGE] })
const reloadKey = () => (isMac ? '⌘' : 'Alt+')

// 메뉴 [보기 → 언어] — 고른 언어를 앱 설정에 적고 메뉴 · 트레이 · 창을 다시 그린다
function setLanguage(next) {
  if (!i18n.LANGUAGES.includes(next) || next === language) return
  language = next
  config = { ...config, language: next }
  core.saveConfig(configFile(), config)
  buildMenu()
  refreshTray()
  for (const window of [...[...packWindows].map((ctx) => ctx.win), trayPanel()]) {
    if (window && !window.isDestroyed()) window.webContents.send('i18n:changed', i18nPayload())
  }
  if (trayPanel() && trayPanel().isVisible()) sendTrayUpdate()
  for (const ctx of packWindows) syncAgentLanguage(ctx.athenaDir)
}

// 에이전트 답 언어 — 앱 언어를 본체 .claude/settings.local.json 의 language 로(lib/agent-language.mts).
// 코어 훅이 메시지마다 다시 읽어서 켜 둔 세션에도 다음 메시지부터 먹는다. .claude 가 없는 폴더(본체 아님)는 건드리지 않는다
function syncAgentLanguage(dir) {
  if (!dir || !fs.existsSync(path.join(dir, '.claude'))) return
  const file = agentLanguage.settingsFile(dir)
  try {
    const next = agentLanguage.withLanguage(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, language)
    if (next !== null) fs.writeFileSync(file, next)
  } catch (error) {
    console.error(`[agent-language] ${file}: ${error.message}`)
  }
}

const configFile = () => path.join(app.getPath('userData'), 'config.json')
const boardLogFile = () => path.join(app.getPath('userData'), 'board.log')

// 맥에서 Finder · Dock 으로 켠 앱은 PATH 가 /usr/bin:/bin 뿐이다. 로그인 셸의 PATH 를 받아 쓴다
function loadLoginPath() {
  const loginShell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      loginShell,
      ['-ilc', `printf '%s%s%s' '${core.PATH_MARK}' "$PATH" '${core.PATH_MARK}'`],
      // 대화형 zsh 는 SIGTERM 을 무시해서 시간이 넘어도 안 끝난다(셸이 느리면 창이 그만큼 늦게 뜬다) — SIGKILL 로 끊는다
      { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' },
      (error, stdout) => resolve(core.parseMarkedPath(stdout || '')),
    )
  })
}

// ── 팩 창 찾기 ─────────────────────────────────────────────
// IPC 는 보낸 창 기준 — 맨 위 프레임(앱 화면)에서 온 것만. 하위 프레임 · 서랍 안 페이지는 창 문맥을 얻지 못한다
function ctxOf(event) {
  for (const ctx of packWindows) {
    if (ctx.win && !ctx.win.isDestroyed() && event.sender === ctx.win.webContents && event.senderFrame === event.sender.mainFrame) return ctx
  }
  return null
}

// 메뉴 · 메뉴 막대가 다룰 창 — 앞에 있는 팩 창, 없으면 마지막으로 앞에 있던 창, 그것도 없으면 아무 창
function frontCtx() {
  const focused = BrowserWindow.getFocusedWindow()
  for (const ctx of packWindows) if (ctx.win === focused) return ctx
  if (lastFocused && packWindows.has(lastFocused)) return lastFocused
  return [...packWindows][0] || null
}

function ctxOfBody(dir) {
  return [...packWindows].find((ctx) => ctx.athenaDir && core.sameDir(ctx.athenaDir, dir)) || null
}

// 열린 창 목록을 앱 설정에 — 다음에 켤 때 다시 연다. 끄는 중(⌘Q)에는 닫히는 창을 빼지 않는다
function saveWindows() {
  if (quitting) return
  const dirs = [...packWindows].map((ctx) => ctx.athenaDir).filter(Boolean)
  // 옛 데몬이라 아직 열지 않은 창도 목록에 남긴다 — 데몬을 새로 띄우면 연다
  for (const dir of heldDirs) if (!dirs.some((other) => core.sameDir(other, dir))) dirs.push(dir)
  config = core.withWindows(config, dirs)
  core.saveConfig(configFile(), config)
}

// ── 작업 창 (데몬) — 프로세스는 앱 전체에 하나 ───────────────────────
// 옛 데몬(protocol 이 다른 데몬)에 [나중에] 로 그대로 붙어 쓰는 중 — 창을 본체로 묶지 못해 팩 창이 여럿이면 pane 이 섞인다.
// 그동안은 새 팩 창을 열지 않는다. 창 하나일 때는 지금 그대로 쓴다
let daemonOld = false
const browserUrls = new Map() // 본체 실제 경로 → 옆 브라우저에서 마지막으로 보던 주소(팩을 바꿨다 돌아오면)
let heldDirs = [] // 옛 데몬이라 켤 때 다시 열지 않은 팩 창 본체 — 맞는 데몬에 붙으면 연다

// 맞는 데몬에 붙었다 — 미뤄 둔 팩 창을 연다
function releaseHeldWindows() {
  if (!heldDirs.length) return
  const dirs = heldDirs
  heldDirs = []
  setImmediate(() => {
    for (const dir of dirs) if (core.checkAthenaDir(dir).ok) openBody(dir)
    saveWindows()
  })
}

// 셸 pane 은 데몬이 갖는다(src/daemon) — 앱은 붙어서 보여 주기만 한다. 앱을 닫아도 데몬·셸·에이전트는 계속 돈다
const daemonPaths = () =>
  core.daemonPaths({
    userData: app.getPath('userData'),
    home: app.getPath('home'),
    tmpdir: app.getPath('temp'),
    uid: process.getuid(),
    endpoint: process.env.ATHENA_STUDIO_ENDPOINT || STUDIO.endpoint,
    socketTag: IDENTITY.socketTag,
  })

// 데몬 쪽 오류 중 화면에 보이는 것 — 연결 끊김 · 붙기 실패는 사전 문구로(나머지 데몬 오류는 데몬이 쓴 글 그대로)
function daemonErrorText(error) {
  if (error.code === 'unavailable') return say('error.daemonDisconnected')
  if (error.code === 'attach-failed') return say('error.daemonAttach', { path: error.log })
  return error.message
}

// 데몬과 앱의 프로토콜이 다르다 — 다시 띄우면 모든 pane·에이전트가 닫히므로 묻는다(S3). 창이 여럿이어도 한 번만 묻는다
let restartAsking = null
function askRestartDaemon(result, parentWindow) {
  if (!restartAsking) {
    restartAsking = (async () => {
      const count = (result.hello && result.hello.panes) || 0
      const choice = await dialog.showMessageBox(parentWindow, {
        type: 'warning',
        message: say('dialog.daemonVersion.message'),
        detail: say('dialog.daemonVersion.detail', { count }),
        buttons: [say('common.later'), say('dialog.daemonVersion.restart')],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice.response !== 1) return false
      await result.connection.call('shutdown').catch(() => null)
      result.connection.close()
      await daemonClient.waitDaemonGone(daemonPaths().socket)
      return true
    })().finally(() => setTimeout(() => (restartAsking = null), 0))
  }
  return restartAsking
}

// 개발용 — 데몬 파일을 고쳤을 때 새로 띄운다(모든 창의 pane 이 닫힌다)
async function restartDaemon() {
  const ctx = frontCtx()
  const choice = await dialog.showMessageBox(ctx ? ctx.win : null, {
    type: 'warning',
    message: say('dialog.daemonRestart.message'),
    detail: say('dialog.daemonRestart.detail'),
    buttons: [say('common.cancel'), say('dialog.daemonRestart.confirm')],
    defaultId: 0,
    cancelId: 0,
  })
  if (choice.response !== 1) return
  const connection = ctx ? await ctx.connectDaemon().catch(() => null) : null
  if (connection) await connection.call('shutdown').catch(() => null)
  for (const each of packWindows) each.detachScreen()
  await daemonClient.waitDaemonGone(daemonPaths().socket)
  for (const each of packWindows) each.send('screen:resync')
}

// 스튜디오 초기화(메뉴 보기) — 처음 켠 것처럼: 일감 · 데몬(모든 pane · 에이전트)을 끄고 스튜디오 집의 코어 · 본체 · 팩 데이터 ·
// 이 앱의 데몬 파일을 지운 뒤 창 목록을 비우고 앱을 다시 띄운다. 회사 레포 클론 · 언어 설정 · 다른 앱의 접속 파일은 둔다
async function resetStudio() {
  const ctx = frontCtx()
  const plan = studioHome.resetPlan(STUDIO)
  const choice = await dialog.showMessageBox(ctx ? ctx.win : null, {
    type: 'warning',
    message: say('dialog.studioReset.message'),
    detail: say('dialog.studioReset.detail', { packs: plan.packs.join(', ') || say('dialog.studioReset.noPacks'), path: STUDIO.root }),
    buttons: [say('common.cancel'), say('dialog.studioReset.confirm')],
    defaultId: 0,
    cancelId: 0,
  })
  if (choice.response !== 1) return
  quitting = true // 창이 닫히며 창 목록을 다시 적지 않게
  // 일감은 본체가 있을 때 그 토큰으로 끈다(지운 뒤에는 끌 방법이 없다)
  for (const board of plan.boards) await stopStaleBoard(board.port, board.dir).catch(() => false)
  const connection = ctx ? await ctx.connectDaemon().catch(() => null) : null
  if (connection) await connection.call('shutdown').catch(() => null)
  for (const each of packWindows) each.detachScreen()
  await daemonClient.waitDaemonGone(daemonPaths().socket)
  try {
    studioHome.resetHome(STUDIO, plan)
  } catch (error) {
    dialog.showErrorBox(say('dialog.studioReset.message'), say('error.studioReset', { message: error.message }))
  }
  config = core.withWindows(config, [])
  core.saveConfig(configFile(), config)
  app.relaunch()
  app.exit(0)
}

// ── 공용 도우미 — src/main/*.mts(에이전트 모니터 기록 읽기 · Explorer · 파일 뷰어 · 일감) ─────
// 쓰는 것(기록 폴더 · 화면 문구 · 일감 로그 · 데몬 자리 · 팩 명령)은 인자로 넘긴다. runPack 은 아래(코어 · 팩 명령)에서 정의돼 부를 때 찾는다
const { MONITOR_LABEL, MONITOR_MINUTES, MONITOR_KEEP, newMonitor, createMonitorLogs, readNewLines, tailEvents, readSubagentMeta, openTail, monitorSessions } = require('./main/monitor-logs.mts')
const { findMonitorLogs } = createMonitorLogs({ projectsDir: path.join(app.getPath('home'), '.claude', 'projects') })
const { createFiles, iconDataUrl, runGit, guarded } = require('./main/files.mts')
const { resolveInside } = createFiles({ say })
const { createBoard } = require('./main/board.mts')
const { startBoard, stopStaleBoard } = createBoard({ say, boardLogFile, daemonPaths, runPack: (args, options) => runPack(args, options) })
// 팩 창 묶음(Explorer · 아테나 에이전트 · 되살리기 · 팩 레포 · 일감 · 요청 · [작업]) — createPackWindow 안에서 installX(ctx, deps) 로 ctx 에 붙인다
const { installExplorer } = require('./main/explorer-panel.mts')
const { installAthenaAgent } = require('./main/athena-agent.mts')
const { installPackRepos } = require('./main/pack-repos.mts')
const { installWork } = require('./main/work.mts')

// ── 앱 업데이트(⚙ 설정 팝업 맨 아래 · 개발 앱 체크아웃만 — 결정 D2) — src/main/app-updater.mts ─────────────
// 쓰는 것(electron app · dialog · 화면 문구 · 스튜디오 집 자리 · 팩 창 목록)은 인자로 넘긴다
const { APP_UPDATE_CHECK_MS, createAppUpdater } = require('./main/app-updater.mts')
const { appVersion, appUpdateView, checkAppUpdate, runAppUpdate, showAppUpdateNotice } = createAppUpdater({ app, dialog, say, studio: STUDIO, packWindows })

// ── 회사 팩 — 본체 명령(공용) ────────────────────────────────
// 팩 일은 아테나 본체가 한다 — 스튜디오는 `node scripts/athena.mjs pack … --json` 을 부르고, 기다리고, 결과를 보여 준다.
// 약속: 코어 `pack … --json` 출력(contract 3 · 코어는 athena/). 팩 파일 · 링크는 직접 만지지 않는다.
// 가져오기에서 [열고 작업 되살리기] — 되살릴 팩 id. 그 팩을 연 창이 아테나를 켤 때(openAthenaAgent) 한 번 되살리고 지운다
let restoreArmedFor = null
// 사람에게 묻는 요청 — 요청 폴더 감시를 놓칠 때를 대비해 이만큼마다 한 번 더 읽는다
const REQUESTS_POLL_MS = 30000
const packLogFile = () => path.join(app.getPath('userData'), 'pack.log')

// 아테나 폴더 · 스튜디오 코어 준비 · 코어 · 팩 명령 실행 — src/main/core-runner.mts(PACK_TIMEOUTS 도 거기 — 팩을 바꾸는 명령은 시간이 넘어도 끊지 않는다).
// 쓰는 것(electron app · dialog · 화면 문구 · 지금 언어 · 스튜디오 집 자리 · 코어 번들 · 데몬 자리 · 팩 로그 자리)은 인자로 넘긴다
const { createCoreRunner } = require('./main/core-runner.mts')
const { athenaReposRoot, prepareStudioCore, showCoreUpdateNotice, coreInstallError, runCore, runPack, contractBlock } = createCoreRunner({ app, dialog, say, language: () => language, studio: STUDIO, coreBundle: CORE_BUNDLE, daemonPaths, packLogFile })

// [Finder 에서 보기] — 방금 만든 파일만
let lastPackFile = null
function packReveal() {
  if (lastPackFile && fs.existsSync(lastPackFile)) shell.showItemInFolder(lastPackFile)
}

// 열린 팩 창들의 팩 id — 팩 줄이 '열려 있음' 을 보여 준다
const openPackIds = () => [...packWindows].map((ctx) => ctx.packState.current && ctx.packState.current.id).filter(Boolean)

// 레지스트리가 바뀌었다(이름 · 이미지 · 가져오기 · 새 팩) — 모든 팩 창의 목록을 새로
function refreshAllPacks() {
  for (const ctx of packWindows) ctx.refreshPacks().catch(() => {})
}

// ── 팩 창 ─────────────────────────────────────────────────
// 창 하나 = 팩 본체 하나. welcome — 앱을 켤 때 첫 창이면 시작 화면 규칙(launchWelcome)을 본다
function createPackWindow(athenaDir, { welcome = false } = {}) {
  const ctx = {
    athenaDir: athenaDir || null,
    win: null,
    packState: { supported: false },
    packBusy: null, // 지금 하는 일(가져오기 · 내보내기 …) — 창마다 한 번에 하나
    packAbort: null, // 기다리는 중 · 검사 중이면 취소할 수 있다
    uiTab: 'work',
  }
  syncAgentLanguage(ctx.athenaDir)
  // ── 데몬 연결 — 창마다 하나, 이 창의 본체로 묶인다(protocol 5) ──
  let daemon = null // DaemonConnection
  let connecting = null
  const outputQueue = new Map() // paneId → 모아 둔 출력(8ms 마다 한 번에 보낸다)
  let flushTimer = null
  let dropOutput = false // attach 답이 오기 전 출력 — 되살릴 화면에 이미 들어 있다
  let screenDetached = false
  let launchWelcome = welcome ? null : false // 켤 때 시작 화면 — 첫 창만 정한다(null = 아직 안 정함)
  let branchCache = { at: 0, value: null }
  let packBoardPort = null // 이 본체 일감 포트(pack status) — 옛 본체면 null(앱 설정 boardPort)
  const monitor = newMonitor()
  let browserView = null
  let browserAttached = false

  const send = (channel, ...args) => {
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, ...args)
  }
  ctx.send = send
  ctx.packProgress = (step) => send('pack:progress', step)

  ctx.athenaState = () => {
    const check = core.checkAthenaDir(ctx.athenaDir)
    return {
      athenaDir: ctx.athenaDir,
      valid: check.ok,
      missing: check.missing,
      boardUrl: core.boardUrl(boardPortNow()),
      installDir: STUDIO.core, // 처음 켤 때 앱이 코어를 푸는 자리(~/.athena-studio/core)
      tabKey: isMac ? '⌘' : 'Alt+',
      platform: process.platform,
      athenaWorkspace: core.ATHENA_WORKSPACE, // 하단 에이전트 모니터는 이 이름이고 아테나 폴더인 작업 공간에서만 보인다
      athenaRealDir: ctx.athenaDir ? core.realDir(ctx.athenaDir) : null, // 화면은 심볼릭 링크를 못 풀어서 main 이 푼 경로도 준다
    }
  }

  function onDaemonEvent(message) {
    if (message.event === 'data') {
      if (dropOutput) return
      outputQueue.set(message.pane, (outputQueue.get(message.pane) || '') + message.data)
      if (!flushTimer) flushTimer = setTimeout(flushOutput, 8)
    } else if (message.event === 'state') {
      flushOutput() // 배치가 바뀌기 전 출력부터
      send('screen:state', message.state)
    } else if (message.event === 'exit') {
      flushOutput()
      send('pane:exit', message.pane)
    } else if (message.event === 'resync') {
      send('screen:resync')
    } else if (message.event === 'open-url' && typeof message.url === 'string') {
      openUrl(ctx, message.url) // 아테나 화면 계층 open-url — 계획서 · 선택 화면을 이 창 옆 브라우저로(localhost 아니면 기본 브라우저)
    }
  }

  function flushOutput() {
    clearTimeout(flushTimer)
    flushTimer = null
    for (const [paneId, data] of outputQueue) send('pane:data', paneId, data)
    outputQueue.clear()
  }

  // 연결이 끊기면 화면에 알린다(앱이 스스로 끊은 detachScreen 은 daemon 을 먼저 비운다)
  function onDaemonClosed() {
    daemon = null
    screenDetached = true
    send('screen:disconnected')
  }

  ctx.connectDaemon = () => {
    if (daemon) return Promise.resolve(daemon)
    if (connecting) return connecting
    connecting = (async () => {
      const paths = daemonPaths()
      const options = { paths, env: core.childEnv(process.env), onEvent: onDaemonEvent, onClose: onDaemonClosed }
      let result = await daemonClient.ensureDaemon(options)
      if (result.status === 'mismatch' && (await askRestartDaemon(result, ctx.win))) result = await daemonClient.ensureDaemon(options)
      if (result.status === 'ok') {
        daemonOld = false
        releaseHeldWindows()
      } else if (result.status === 'mismatch') daemonOld = true
      daemon = daemon || result.connection
      return daemon
    })().finally(() => (connecting = null))
    return connecting
  }
  ctx.isAttached = () => Boolean(daemon)

  // 화면이 붙는다 — 지금 상태 + pane 마다 되살릴 화면. 이 뒤로 실시간 출력이 이어진다
  ctx.attachScreen = async () => {
    const check = core.checkAthenaDir(ctx.athenaDir)
    if (!check.ok) return { error: say('error.athenaDirMissing') }
    try {
      const connection = await ctx.connectDaemon()
      flushOutput()
      dropOutput = true
      try {
        // 이 창의 본체로 묶는다(protocol 5) — 다른 팩 창의 작업 공간 · 출력은 오지 않는다
        const attached = await connection.call('attach', { body: core.realDir(ctx.athenaDir) }, () => {
          dropOutput = false
          outputQueue.clear()
        })
        screenDetached = false
        // 예전 터미널 모니터 칸이 남아 있으면 닫는다(이제 모니터는 앱 화면)
        closeMonitorDock().catch(() => {})
        return attached
      } finally {
        dropOutput = false
      }
    } catch (error) {
      return { error: say('error.daemonConnect', { message: daemonErrorText(error) }) }
    }
  }

  // 창 닫기 · 앱 종료 — 연결만 끊는다(데몬·셸·에이전트는 계속 돈다)
  ctx.detachScreen = () => {
    if (!daemon) return
    const current = daemon
    daemon = null
    current.close()
  }

  const daemonCall = async (op, args) => {
    try {
      const connection = await ctx.connectDaemon()
      return { result: await connection.call(op, args) }
    } catch (error) {
      return { error: daemonErrorText(error), code: error.code }
    }
  }
  ctx.daemonCall = daemonCall
  // 메뉴 막대 폴링 전용 — 이미 붙은 연결로만 묻는다(daemonCall 은 끊겼으면 데몬을 다시 띄우거나 버전 확인창을 띄운다)
  ctx.peekCall = async (op, args = {}) => {
    const connection = daemon
    if (!connection) return { error: say('tray.daemonOffline') }
    try {
      return { result: await connection.call(op, args) }
    } catch (error) {
      return { error: error.message }
    }
  }
  ctx.notifyDaemon = (op, args) => daemon && daemon.notify(op, args)
  // pane 크기 — 답을 받는 그 자리(같은 소켓의 뒤 출력보다 먼저)에서 앞 출력을 내보내고 화면에 '적용됨'을 알린다.
  // 화면은 그 알림을 받아 앞 출력을 다 읽은 뒤 xterm 크기를 바꾼다 — 데몬이 pty 를 바꾼 출력 지점과 같다(데몬 버퍼도 앞 출력을 다 읽은 뒤 바꾼다 · Pane.resize).
  // 데몬이 스스로 바꾸는 크기(분할 · pane 종료의 fitTab)는 알리지 않는다 — 곧 화면이 자기 크기를 다시 요청한다
  ctx.resizePane = (paneId, cols, rows) => {
    if (!daemon) return
    daemon
      .call('resize', { pane: paneId, cols, rows }, (reply) => {
        if (!reply.ok) return
        flushOutput()
        send('pane:resized', paneId, cols, rows)
      })
      .catch(() => {})
  }
  ctx.screenDetached = () => screenDetached

  // pane 닫기(⌘W) — 에이전트가 돌고 있으면 묻는다(S6)
  ctx.closePane = async (paneId) => {
    const info = await daemonCall('pane get', { pane: paneId })
    const pane = info.result && info.result.pane
    if (pane && pane.agent) {
      const choice = await dialog.showMessageBox(ctx.win, {
        type: 'warning',
        message: say('dialog.closePane.message', { agent: pane.agent }),
        buttons: [say('common.cancel'), say('common.close')],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice.response !== 1) return { canceled: true }
    }
    return daemonCall('pane close', { pane: paneId })
  }

  // 예전엔 데몬 고정 칸에서 agent-monitor.py 를 돌렸다 — 남아 있으면 닫는다(보기만 하는 칸이라 잃는 것이 없다)
  async function closeMonitorDock() {
    const listed = await daemonCall('pane list')
    for (const pane of (listed.result && listed.result.panes) || []) {
      if (!pane.tab_id && pane.label === MONITOR_LABEL) await daemonCall('pane close', { pane: pane.id })
    }
  }

  // ── 에이전트 모니터 ──
  async function monitorTick() {
    // 창이 숨었으면(메뉴 막대로 내려감) 기록을 읽지 않는다
    if (!monitor.watching || monitor.ticking || !ctx.win || ctx.win.isDestroyed() || !ctx.win.isVisible()) return
    monitor.ticking = true
    try {
      const fresh = []
      let changed = false
      // 10초마다 새 세션을 찾고, 120분 넘게 조용한 세션은 뺀다
      if (Date.now() - monitor.lastScan > 10000) {
        monitor.lastScan = Date.now()
        const allSessions = Date.now() - monitor.lastFullScan > 60000
        if (allSessions) monitor.lastFullScan = Date.now()
        const found = await findMonitorLogs(monitor, allSessions, ctx.athenaDir)
        for (const item of found) {
          if (monitor.tails.has(item.file)) continue
          fresh.push(...(await openTail(monitor, item)))
          changed = true
        }
        for (const tail of monitor.tails.values()) {
          const before = tail.finished
          await readSubagentMeta(tail)
          if (tail.finished !== before) changed = true
        }
        const since = Date.now() - MONITOR_MINUTES * 60000
        for (const [file, tail] of monitor.tails) {
          if (tail.mtime < since) {
            monitor.tails.delete(file)
            changed = true
          }
        }
      }
      for (const tail of monitor.tails.values()) {
        // 한 파일이 사라지거나 못 읽어도 다른 세션은 계속
        try {
          fresh.push(...tailEvents(monitor, tail, await readNewLines(tail)))
        } catch {}
      }
      const events = fresh.sort((left, right) => String(left.at).localeCompare(String(right.at)))
      if (events.length) {
        monitor.events = [...monitor.events, ...events].sort((left, right) => String(left.at).localeCompare(String(right.at)) || left.id - right.id).slice(-MONITOR_KEEP)
        changed = true
      }
      if (changed) send('monitor:update', { sessions: monitorSessions(monitor), events })
    } catch (error) {
      send('monitor:update', { sessions: monitorSessions(monitor), events: [], error: error.message })
    } finally {
      monitor.ticking = false
    }
  }

  ctx.setMonitorWatch = (on) => {
    monitor.watching = Boolean(on)
    clearInterval(monitor.timer)
    if (!monitor.watching) return
    monitor.lastScan = 0
    monitor.lastFullScan = 0
    // 다시 보이면 지금까지 모은 것을 한 번에 보내고 이어서 따라간다
    send('monitor:update', { reset: true, sessions: monitorSessions(monitor), events: monitor.events })
    monitorTick()
    monitor.timer = setInterval(monitorTick, 1000)
  }

  // 탭 닫기 — 안에 에이전트가 돌고 있으면 묻는다
  ctx.closeTab = async (tabId) => {
    const listed = await daemonCall('pane list')
    const agents = ((listed.result && listed.result.panes) || []).filter((pane) => pane.tab_id === tabId && pane.agent)
    if (agents.length) {
      const choice = await dialog.showMessageBox(ctx.win, {
        type: 'warning',
        message: say('dialog.closeTab.message', { agents: agents.map((pane) => pane.agent).join(' · ') }),
        buttons: [say('common.cancel'), say('common.close')],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice.response !== 1) return { canceled: true }
    }
    return daemonCall('tab close', { tab: tabId })
  }

  // 새 작업 공간 — 폴더를 고르면 그 이름으로(레포 하나 = 작업 공간 하나)
  // spaces + — 폴더를 고른다. 팩 본체이고 고른 것이 팩에 없는 git 레포면 바로 열지 않고 돌려준다(화면이 "팩에 더할까요?" 를 묻는다)
  ctx.newWorkspace = async (size) => {
    const result = await dialog.showOpenDialog(ctx.win, {
      title: say('dialog.newWorkspace.title'),
      properties: ['openDirectory'],
      // 아테나는 앱 데이터 폴더에 있으니 레포 고르기는 홈에서 시작한다
      defaultPath: app.getPath('home'),
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const dir = result.filePaths[0]
    const packBody = fs.existsSync(path.join(ctx.athenaDir || '', '.pack-data'))
    if (packBody && fs.existsSync(path.join(dir, '.git'))) {
      const real = core.realDir(dir)
      const inPack = (await ctx.packRepos()).some((repo) => repo.linked && core.realDir(path.join(ctx.athenaDir, 'repos', repo.name)) === real)
      if (!inPack) return { askAdd: true, dir, name: path.basename(dir) }
    }
    return ctx.openWorkspaceDir(dir, size)
  }
  ctx.openWorkspaceDir = (dir, size) => daemonCall('workspace create', { label: path.basename(dir), cwd: dir, focus: true, ...size })

  // 팩에 레포 하나 더하기 — 코어 repo add(pack.json · 자리 · 링크 · 뼈대) 뒤 아테나에게 뼈대 채우기를 맡긴다(docs/setup.md "레포 하나 더하기")
  // 레포 더하기 · 빼기는 이 본체의 코어 명령이다 — 본체가 배포 코어보다 뒤처졌으면(아테나가 계속 일해 자동 따라잡기를 못 했으면) 먼저 따라잡는다.
  // 옛 본체는 명령을 몰라 사용법만 찍고 끝났다(2026-10-23 — "알 수 없는 답")
  // 이 창 본체가 배포 코어보다 뒤처졌나 — 화면이 레포 더하기 · 빼기 확인창에 "에이전트를 멈췄다 다시 켜요" 를 붙인다
  ctx.bodyBehind = async () => {
    const body = ctx.athenaDir
    if (!body || core.sameDir(body, STUDIO.core) || !fs.existsSync(path.join(body, '.pack-data'))) return false
    const registry = await fs.promises.readFile(path.join(STUDIO.data, 'config.json'), 'utf8').then(JSON.parse, () => null)
    const target = registry && registry.deploy && registry.deploy.commit
    const mine = ((await runGit(body, ['rev-parse', 'HEAD'])) || '').trim()
    if (!target || !mine || mine === target) return false
    return (await runGit(STUDIO.core, ['merge-base', '--is-ancestor', mine, target])) !== null
  }
  const freshBody = async () => {
    const listed = await daemonCall('pane list')
    const caught = await ctx.catchUpBody(listed.result ? listed.result.panes : null, { force: true })
    if (!caught || caught.ok) return null
    return { ok: false, error: 'body-behind', text: say(`pack.catchUp.${caught.reason === 'unknown-session' ? 'unknownSession' : caught.reason === 'working' ? 'working' : 'failed'}`) }
  }
  ctx.addRepo = async (dir, name) => {
    const stale = await freshBody()
    if (stale) return stale
    const args = ['repo', 'add', String(dir), ...(name ? ['--name', String(name)] : [])]
    const result = await ctx.packTask(say('pack.task.addRepo'), () => runCore(args, { dir: ctx.athenaDir }))
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    if (!result.already) await sendToAthena(say('spaces.addRepoAsk', { repo: result.repo.name, path: result.path }))
    return result
  }
  // 팩에서 레포 빼기 — 코어 repo remove(팩 백업 · pack.json · 자리 · 링크 · 에이전트 · 지식 · 검증) 뒤 아테나에게 ROUTING · services 줄 정리를 맡긴다
  ctx.removeRepo = async (name) => {
    const stale = await freshBody()
    if (stale) return stale
    const result = await ctx.packTask(say('pack.task.removeRepo'), () => runCore(['repo', 'remove', String(name)], { dir: ctx.athenaDir }))
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    await sendToAthena(say('spaces.removeRepoAsk', { repo: result.removed }))
    return result
  }
  // 작업 공간 닫기 — 그 작업 공간의 탭을 모두 닫는다(pane 이 다 닫히면 데몬이 작업 공간도 지운다 · 팩은 그대로)
  ctx.closeWorkspace = async (workspaceId) => {
    const state = await daemonCall('state')
    const tabs = ((state.result && state.result.tabs) || []).filter((tab) => tab.workspace === workspaceId)
    for (const tab of tabs) await daemonCall('tab close', { tab: tab.id })
    return { ok: true, closed: tabs.length }
  }
  // spaces 레포 줄 우클릭 — 고른 동작 이름(repo-look · repo-reset-name · repo-clear-icon · remove-repo · close-workspace · null).
  // 이름 · 이미지는 팩 이름 · 이미지와 같은 대화상자(화면) · 되돌리기는 바꿔 둔 것이 있을 때만
  // 아테나 작업 공간 줄은 레포 항목(이름 · 이미지 · 팩에서 빼기)을 띄우지 않는다 — 팩에 같은 이름 레포가 있어도 아테나 로고 고정
  ctx.spaceContextMenu = async ({ repo = null, workspace = null } = {}, point = null) => {
    if (repo && workspace) {
      const state = await daemonCall('state')
      const athena = state.result && core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir)
      if (athena && athena.id === workspace) repo = null
    }
    const info = repo ? (await ctx.packRepos()).find((item) => item.name === repo) : null
    return spaceMenuPopup({ repo, workspace, info }, point)
  }
  const spaceMenuPopup = ({ repo, workspace, info }, point) => new Promise((resolve) => {
    let chosen = null
    const pick = (action) => () => {
      chosen = action
      resolve(action)
    }
    const items = []
    if (workspace) items.push({ label: say('spaces.menu.closeWorkspace'), click: pick('close-workspace') })
    if (info) {
      items.push(...(items.length ? [{ type: 'separator' }] : []), { label: say('spaces.menu.look'), click: pick('repo-look') })
      if (info.displayName) items.push({ label: say('spaces.menu.resetName'), click: pick('repo-reset-name') })
      if (info.iconPath) items.push({ label: say('spaces.menu.clearIcon'), click: pick('repo-clear-icon') })
    }
    if (repo) items.push(...(items.length ? [{ type: 'separator' }] : []), { label: say('spaces.menu.removeRepo'), click: pick('remove-repo') })
    if (!items.length || !ctx.win) return resolve(null)
    const menu = Menu.buildFromTemplate(items)
    menu.once('menu-will-close', () => setTimeout(() => resolve(chosen), 100))
    const at = point && Number.isInteger(point.x) && Number.isInteger(point.y) ? { x: point.x, y: point.y } : {}
    menu.popup({ window: ctx.win, ...at, callback: () => setTimeout(() => resolve(chosen), 100) })
  })

  // pane(터미널) 우클릭 — 고른 동작 이름(split-right · split-down · close-pane · null). 동작은 화면이 우클릭한 그 pane 으로 한다.
  // 단축키는 앱 메뉴(보기 · 파일)에 이미 걸려 있어 여기서는 보여 주기만 한다
  ctx.paneContextMenu = (point = null) => new Promise((resolve) => {
    if (!ctx.win) return resolve(null)
    let chosen = null
    const pick = (action) => () => {
      chosen = action
      resolve(action)
    }
    const menu = Menu.buildFromTemplate([
      { label: say('menu.pane.splitRight'), accelerator: `${TAB_KEY}+D`, registerAccelerator: false, click: pick('split-right') },
      { label: say('menu.pane.splitDown'), accelerator: `${TAB_KEY}+Shift+D`, registerAccelerator: false, click: pick('split-down') },
      { type: 'separator' },
      { label: say('menu.file.closePane'), accelerator: `${TAB_KEY}+W`, registerAccelerator: false, click: pick('close-pane') },
    ])
    menu.once('menu-will-close', () => setTimeout(() => resolve(chosen), 100))
    const at = point && Number.isInteger(point.x) && Number.isInteger(point.y) ? { x: point.x, y: point.y } : {}
    menu.popup({ window: ctx.win, ...at, callback: () => setTimeout(() => resolve(chosen), 100) })
  })

  // 아테나 pane(이 창 아테나 작업 공간의 첫 pane)에 글 한 줄 + Enter — 없으면 false
  async function sendToAthena(text) {
    const state = await daemonCall('state')
    const athena = state.result && core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir)
    const tab = athena && state.result.tabs.find((entry) => entry.workspace === athena.id)
    const pane = tab && layout.paneIds(tab.tree)[0]
    if (!pane) return false
    await daemonCall('workspace select', { workspace: athena.id })
    const typed = await daemonCall('pane send-text', { pane, text })
    if (typed.error) return false
    await daemonCall('pane send-keys', { pane, keys: ['Enter'] })
    return true
  }

  // ── pane [상세] ─────────────────────────────────────────────────────
  // 지금 상태가 된 시각(걸린 시간) — pane 목록을 볼 때마다 상태가 바뀐 pane 만 고친다
  const paneSince = new Map() // pane id → { status, at }
  const trackPaneSince = (panes) => {
    const alive = new Set()
    for (const pane of panes) {
      alive.add(pane.id)
      const status = pane.agent ? pane.agent_status : null
      const known = paneSince.get(pane.id)
      if (!known || known.status !== status) paneSince.set(pane.id, { status, at: Date.now() })
    }
    for (const id of paneSince.keys()) if (!alive.has(id)) paneSince.delete(id)
  }
  // 계획서에 묶인 pane(머리 줄 [상세] 아이콘) — 일감이 떠 있을 때만 읽는다(띄우지는 않는다). 꺼졌으면 지난 값을 둔다
  const PANE_BOUND_MS = 5000
  let paneBound = {}
  let paneBoundAt = 0
  const refreshPaneBound = async () => {
    const state = await fetchBoardJson(ctx.boardPortNow(), '/api/state')
    if (!state || !Array.isArray(state.cards)) return
    const next = paneDetail.bindings(state.cards, state.panes)
    if (JSON.stringify(next) === JSON.stringify(paneBound)) return
    paneBound = next
    send('screen:pane-bound', paneBound)
  }
  ctx.paneBound = () => paneBound
  // 아카이브 목록은 무겁다(보관 폴더를 다 읽는다) — 아테나 pane 상세가 열려 있어도 30초에 한 번만
  const HISTORY_CACHE_MS = 30000
  let historyCache = { at: 0, items: [] }
  const recentHistory = async () => {
    if (Date.now() - historyCache.at < HISTORY_CACHE_MS) return historyCache.items
    const history = await fetchBoardJson(ctx.boardPortNow(), '/api/history')
    historyCache = { at: Date.now(), items: history && Array.isArray(history.items) ? history.items : historyCache.items }
    return historyCache.items
  }
  // 상세 토큰 — 대화 기록 usage 합계(파일만 읽음 · 파일마다 늘어난 부분만 · 기다리지 않고 아는 값). 기록을 못 찾으면 null → 화면에서 숨긴다
  const tokenView = (sum) => (sum && sum.io + sum.cache > 0 ? { io: sum.io, cache: sum.cache, ioText: tokenUsage.formatTokens(sum.io), cacheText: tokenUsage.formatTokens(sum.cache) } : null)
  // 아테나 pane 의 지금 대화 — 훅 pane-session.py 가 적는 <팩 데이터>/state/pane-sessions/<pane>.json 의 session
  const paneSession = async (paneId) => {
    if (!ctx.athenaDir) return ''
    const record = await fs.promises.readFile(path.join(core.realDir(path.join(ctx.athenaDir, '.pack-data')), 'state', 'pane-sessions', `${paneId.split(':').pop()}.json`), 'utf8').then(JSON.parse).catch(() => null)
    return record && typeof record.session === 'string' ? record.session : ''
  }
  // 상세 한 번 — 에이전트 pane 이면 그 계획서의 지금 · 결과 · 내가 할 일 · PR · 기록, 아테나 pane 이면 맡긴 일 목록.
  // 재료: 일감 /api/state · /api/card(계획서 원문) · pane 화면 글(pane read) · 열린 요청. 요약용 모델은 부르지 않는다
  ctx.paneDetail = async (paneId) => {
    if (!/^[\w:]+$/.test(paneId)) return { ok: false, error: 'bad-id' }
    const port = ctx.boardPortNow()
    const state = await fetchBoardJson(port, '/api/state')
    if (!state || !Array.isArray(state.cards)) return { ok: false, error: 'board-down' }
    const listed = await daemonCall('pane list')
    const panes = listed.result && Array.isArray(listed.result.panes) ? listed.result.panes : []
    const pane = panes.find((entry) => entry.id === paneId)
    if (!pane) return { ok: false, error: 'no-pane' }
    const label = pane.label || pane.name || pane.title || paneId
    const open = requestsState.requests.filter((request) => request.state === 'open')
    const since = Object.fromEntries([...paneSince].map(([id, entry]) => [id, entry.at]))
    const plan = paneDetail.agentPlan(state.cards, paneId)
    if (!plan) {
      const status = Object.fromEntries(panes.map((entry) => [entry.id, entry.agent ? entry.agent_status : null]))
      const rows = paneDetail.leadRows(state.cards, await recentHistory(), paneId, { panes: state.panes || [], since, status, waitingPlans: new Set(open.map((request) => request.plan).filter(Boolean)), now: Date.now() })
      return { ok: true, mode: 'lead', paneId, label, rows, tokens: tokenView(paneTokens.peekSession(await paneSession(paneId))) }
    }
    const [visible, recent, card] = await Promise.all([
      daemonCall('pane read', { pane: paneId, lines: 40, source: 'visible' }),
      daemonCall('pane read', { pane: paneId, lines: 400, source: 'recent' }),
      fetchBoardJson(port, `/api/card?id=${encodeURIComponent(plan.id)}`),
    ])
    const visibleText = visible.result && typeof visible.result.text === 'string' ? visible.result.text : ''
    const digest = paneDetail.screenDigest(recent.result && typeof recent.result.text === 'string' ? recent.result.text : '')
    const record = paneDetail.planRecord(card && typeof card.text === 'string' ? card.text : '')
    const waiting = screenModel.waitingForInput(visibleText)
    const todo = open.filter((request) => request.plan === plan.id || request.pane === paneId).map((request) => ({ id: request.id, kind: request.kind, title: request.title }))
    const now = paneDetail.nowState({
      agentStatus: pane.agent ? pane.agent_status : null,
      waiting,
      heavy: digest.heavy,
      hasRequest: todo.length > 0,
      planStatus: record.status || plan.status,
    })
    const known = paneSince.get(paneId)
    return {
      ok: true,
      mode: 'agent',
      paneId,
      label,
      now: { ...now, sinceMs: known ? Date.now() - known.at : 0, line: digest.now },
      report: digest.report,
      todo,
      // 이 계획서에 묶인 대화 기록 전부(작업 · 리뷰 세션) — 계획서 → 기록 찾기는 코어 learn-review.mjs findTranscripts 와 같은 규칙
      tokens: tokenView(paneTokens.peekPlan([ctx.athenaDir, core.realDir(ctx.athenaDir)], plan.id)),
      plan: { id: plan.id, html: plan.html || null, title: record.title || plan.title, created: Number(plan.created) || 0, readable: Boolean(card), ...record },
    }
  }

  // 보일 때만(startPanesPolling 이 2초마다 부른다) pane 목록(에이전트가 도는 폴더 → 모니터)과 작업 공간 브랜치를 갱신한다
  ctx.pollPanes = async () => {
    if (!ctx.win || ctx.win.isDestroyed() || !ctx.win.isVisible() || ctx.win.isMinimized() || !daemon) return
    const listed = await daemonCall('pane list')
    if (listed.result) {
      monitor.agentCwds = listed.result.panes.filter((pane) => pane.agent).map((pane) => pane.foreground_cwd || pane.cwd).filter(Boolean)
      // spaces pane 줄 앞 점 — 에이전트가 없는 pane 은 null
      send('screen:pane-status', Object.fromEntries(listed.result.panes.map((pane) => [pane.id, pane.agent ? pane.agent_status : null])))
      trackPaneSince(listed.result.panes)
    }
    if (Date.now() - paneBoundAt > PANE_BOUND_MS) {
      paneBoundAt = Date.now()
      refreshPaneBound().catch(() => {})
    }
    const branches = await workspaceBranches()
    if (branches) send('screen:branches', branches)
    ctx.catchUpBody(listed.result ? listed.result.panes : null).catch(() => {})
  }

  // 팩 본체가 주 본체 코어보다 뒤처졌으면 따라잡는다 — 앱 업데이트는 일하는 본체를 건너뛰고, 그 뒤에는 앱이 새 번들을 들고 오지 않는 한 다시 하지 않는다.
  // 30초에 한 번 HEAD 둘만 본다. 뒤처졌을 때: 본체 안 에이전트(워크트리)가 있거나 아테나가 일하는 중이면 기다린다.
  // 아테나가 쉬는 중이면 그 대화를 기억하고 잠깐 끄고(/exit) → pack open(본체 따라잡기) → 같은 대화로 다시 켠다(claude --resume) — 사용자가 손댈 일 없게
  let catchUpAt = 0
  let catchUpBackoff = 0 // 해 봤는데 못 옮겼으면 10분 쉰다 — 아테나를 30초마다 껐다 켜지 않게
  let catchingUp = false
  // 코어가 보는 바쁨(pack busy — 본체 · 레포 · 워크트리 안 claude · codex · 무거운 명령 …) — 코어가 옮길지 말지를 이걸로 정한다
  const coreBusy = async () => {
    const result = await runPack(['busy'], { dir: ctx.athenaDir })
    return result.ok && result.busyKnown !== false ? result.busy || [] : null
  }
  // force — 사용자가 고른 일(레포 더하기 · 빼기)이 새 코어 명령을 써야 할 때: 30초 · 10분 쉬기를 건너뛴다(나머지 안전 검사는 그대로).
  // 돌려주는 것: { ok, same } 이미 같음 · { ok:false, reason } working(누가 일하는 중 · 질문 창 · 쓰다 만 글) | unknown-session | still-busy | failed
  ctx.catchUpBody = async (panes, { force = false } = {}) => {
    // 자동 따라잡기가 도는 중이면 — 사용자가 고른 일은 끝날 때까지(최대 1분) 기다렸다 다시 본다(이미 옮겼으면 same)
    for (let tries = 0; force && catchingUp && tries < 60; tries += 1) await new Promise((resolve) => setTimeout(resolve, 1000))
    if (catchingUp) return { ok: false, reason: 'working' }
    if (!force && (!panes || Date.now() - catchUpAt < 30000 || Date.now() < catchUpBackoff)) return null
    if (!force) catchUpAt = Date.now()
    if (!panes) return { ok: false, reason: 'failed' }
    const body = ctx.athenaDir
    const packId = ctx.packState.current && ctx.packState.current.id
    if (!body || !packId || (!force && ctx.packBusy) || core.sameDir(body, STUDIO.core) || !fs.existsSync(path.join(body, '.pack-data'))) return { ok: true, same: true }
    // 기준은 코어와 같다(bodies.mjs catchUpBody) — 레지스트리 deploy.commit 이 이 본체 커밋의 후손일 때만(주 본체 HEAD 가 아니다 · 정비 커밋으로 앞서도 옮기지 않는다)
    const registry = await fs.promises.readFile(path.join(STUDIO.data, 'config.json'), 'utf8').then(JSON.parse, () => null)
    const target = registry && registry.deploy && registry.deploy.commit
    const mine = ((await runGit(body, ['rev-parse', 'HEAD'])) || '').trim()
    if (!target || !mine || mine === target) return { ok: true, same: true }
    if ((await runGit(STUDIO.core, ['merge-base', '--is-ancestor', mine, target])) === null) return { ok: true, same: true }
    const realBody = core.realDir(body)
    const packData = core.realDir(path.join(body, '.pack-data'))
    const under = (dir, root) => Boolean(dir) && core.isInside(core.realDir(dir), root)
    const inBody = panes.filter((pane) => pane.agent && (under(pane.foreground_cwd || pane.cwd, realBody) || under(pane.foreground_cwd || pane.cwd, packData)))
    const athenaPanes = inBody.filter((pane) => under(pane.foreground_cwd || pane.cwd, realBody))
    // force(사용자가 고른 일) — 일하는 중이어도 이 팩의 에이전트를 모두 멈추고 옮긴다(화면이 미리 알린다). 아래 기다리기 검사는 건너뛴다
    // 워크트리 에이전트가 있거나 · 누가 일하는 중이거나 · claude 가 아니면(되살릴 수 없다) 다음에
    if (!force && (inBody.length !== athenaPanes.length || athenaPanes.some((pane) => pane.agent !== 'claude' || pane.agent_status !== 'idle'))) return { ok: false, reason: 'working' }
    // 화면으로도 — 질문 · 고르기 창이 떠 있거나 쓰다 만 글이 있으면 건드리지 않는다
    for (const pane of force ? [] : athenaPanes) {
      const read = await daemonCall('pane read', { pane: pane.id, lines: 40 })
      if (!read.result || !core.claudeAtEmptyPrompt(read.result.text)) return { ok: false, reason: 'working' }
    }
    // 코어 기준으로도 아테나 말고 바쁜 것이 없어야 시작한다(레포 · 워크트리 에이전트 · 무거운 명령)
    const before = await coreBusy()
    if (!force && (!before || before.some((item) => item.kind !== 'athena'))) return { ok: false, reason: 'working' }
    const sessions = []
    for (const pane of force ? inBody : athenaPanes) {
      const record = await fs.promises.readFile(path.join(packData, 'state', 'pane-sessions', `${pane.id}.json`), 'utf8').then(JSON.parse, () => null)
      // 어느 대화인지 모르면 끄지 않는다 — force 면 끄고 다시 켜지는 않는다
      if (!record || !record.session) {
        if (!force) return { ok: false, reason: 'unknown-session' }
        sessions.push({ pane: pane.id, session: null })
      } else sessions.push({ pane: pane.id, session: record.session })
    }
    catchingUp = true
    try {
      for (const item of sessions) {
        if (force) {
          // 일하는 중이면 /exit 가 줄만 선다 — 멈추고(Esc) 입력 창을 비우고(C-c) 끈다(C-c 두 번)
          await daemonCall('pane send-keys', { pane: item.pane, keys: ['Escape'] })
          await new Promise((resolve) => setTimeout(resolve, 300))
          await daemonCall('pane send-keys', { pane: item.pane, keys: ['C-c'] })
          await new Promise((resolve) => setTimeout(resolve, 300))
          await daemonCall('pane send-keys', { pane: item.pane, keys: ['C-c'] })
          continue
        }
        await daemonCall('pane send-text', { pane: item.pane, text: '/exit' })
        await daemonCall('pane send-keys', { pane: item.pane, keys: ['Enter'] })
      }
      // 코어가 보기에 다 끝날 때까지(최대 30초) — pane 은 셸로 돌아와도 claude 의 딸린 프로세스가 잠깐 남는다(2026-10-23 실측)
      let quiet = false
      for (let tries = 0; tries < 30; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const busy = await coreBusy()
        if (busy && !busy.length) {
          quiet = true
          break
        }
      }
      const opened = quiet ? await runPack(['open', packId], { dir: STUDIO.core }) : { ok: false, error: 'still-busy' }
      if (!opened.ok || !opened.updated) catchUpBackoff = Date.now() + 10 * 60000
      fs.appendFile(packLogFile(), `\n── ${new Date().toISOString()} catch-up ${packId} ${JSON.stringify({ ok: opened.ok, updated: opened.updated || null, error: opened.error || null })}\n`, () => {})
      for (const item of sessions) if (item.session) await daemonCall('pane run', { pane: item.pane, text: core.resumeCommand(item.session) })
      if (opened.ok && opened.updated) send('pack:caught-up', { pack: ctx.packState.current.displayName || ctx.packState.current.name || packId })
      return opened.ok && opened.updated ? { ok: true } : { ok: false, reason: opened.error === 'still-busy' ? 'still-busy' : 'failed' }
    } finally {
      catchingUp = false
    }
  }

  // 작업 공간마다 git 브랜치(이름 아래에) — 5초에 한 번만 묻는다
  async function workspaceBranches() {
    if (branchCache.value && Date.now() - branchCache.at < 5000) return branchCache.value
    const state = await daemonCall('state')
    if (!state.result) return null
    const pairs = await Promise.all(
      state.result.workspaces.map(async (workspace) => {
        const branch = await runGit(workspace.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
        return [workspace.id, branch ? branch.trim() : null]
      }),
    )
    branchCache = { at: Date.now(), value: Object.fromEntries(pairs) }
    return branchCache.value
  }

  // ── 오른쪽 Explorer · 아테나 에이전트 · 되살리기 · 팩 레포 · 일감 · 요청 · [작업] — src/main/*.mts ──
  // ctx 에 같은 이름으로 붙는다(부르는 쪽 · IPC 는 그대로). 쓰는 것(화면 문구 · 코어 명령 · 일감 · 앱 설정)은 인자로 넘긴다
  installExplorer(ctx, { say, resolveInside })
  installAthenaAgent(ctx, { say, runPack, disarmRestore: () => (restoreArmedFor = null) })
  installPackRepos(ctx, { say, runPack, daemonPaths })
  // 요청 목록은 이 창 변수 그대로 — pane [상세] 도 읽는다
  let requestsState = { supported: false, requests: [] }
  installWork(ctx, {
    say,
    runCore,
    runPack,
    startBoard,
    stopStaleBoard,
    reloadKey,
    requestsPollMs: REQUESTS_POLL_MS,
    trayRequestsChanged: (target) => trayRequestsChanged(target),
    appConfig: () => config,
    saveAppConfig: (next) => {
      config = next
      core.saveConfig(configFile(), config)
    },
    packBoardPort: () => packBoardPort,
    setPackBoardPort: (port) => (packBoardPort = port),
    requestsState: () => requestsState,
    setRequestsState: (next) => (requestsState = next),
  })
  const boardPortNow = ctx.boardPortNow

  // ── 아테나 폴더 ──
  ctx.pickAthenaDir = async () => {
    const result = await dialog.showOpenDialog(ctx.win, {
      title: say('dialog.pickAthena.title'),
      message: say('dialog.pickAthena.message'),
      properties: ['openDirectory'],
      defaultPath: ctx.athenaDir || app.getPath('home'),
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true, ...ctx.athenaState() }
    return useAthenaDir(result.filePaths[0])
  }

  function useAthenaDir(dir) {
    // 팩 작업 중에는 본체를 바꾸지 않는다
    if (ctx.packBusy) return { ...ctx.athenaState(), error: say('error.packBusyAthena', { task: ctx.packBusy }) }
    const check = core.checkAthenaDir(dir)
    if (!check.ok) return { ...ctx.athenaState(), error: say('error.notAthenaDir', { files: check.missing.join(', ') }), picked: dir }
    // 다른 창이 이미 그 본체면 그 창으로(창 하나 = 본체 하나)
    const other = ctxOfBody(dir)
    if (other && other !== ctx) {
      other.show()
      return { ...ctx.athenaState(), error: say('pack.open.alreadyOpen') }
    }
    try {
      core.ensureAthenaConfig(dir, athenaReposRoot(dir))
    } catch (error) {
      return { ...ctx.athenaState(), error: say('error.configCreate', { message: error.message }), picked: dir }
    }
    const changed = dir !== ctx.athenaDir
    if (changed) return rebindBody(dir)
    syncAgentLanguage(dir)
    saveWindows()
    ctx.prepareBoardPort()
    return { ...ctx.athenaState(), changed }
  }

  // 이 창을 다른 본체(팩)로 다시 묶는다(한 창에서 팩을 바꿔 본다).
  // 이전 본체의 pane · 에이전트는 닫지 않는다(데몬에서 계속 돌고, 다시 오면 그 본체의 보던 자리 그대로). 화면은 돌려준 상태로 다시 붙는다(attach{body}) —
  // 작업 공간 · 일감 포트 · 옆 브라우저 · 에이전트 모니터 · 팩 상태가 새 본체 것으로
  function rebindBody(dir) {
    try {
      core.ensureAthenaConfig(dir, athenaReposRoot(dir))
    } catch {}
    ctx.detachScreen() // 화면이 다시 붙을 때 새 본체로 묶인다
    rememberBrowser()
    ctx.athenaDir = dir
    syncAgentLanguage(dir)
    ctx.watchRequests()
    packBoardPort = null
    branchCache = { at: 0, value: null }
    resetMonitor()
    saveWindows()
    ctx.prepareBoardPort()
    if (hasTray()) pollTray()
    return { ...ctx.athenaState(), changed: true }
  }
  ctx.rebindBody = rebindBody

  // 옆 브라우저 — 지금 본체에서 보던 주소를 기억하고 뷰를 닫는다(새 본체에서 서랍을 열면 그 본체 주소로 · ensureBrowserView)
  function rememberBrowser() {
    if (browserView && !browserView.webContents.isDestroyed()) {
      const url = browserView.webContents.getURL()
      if (ctx.athenaDir && core.isWebUrl(url)) browserUrls.set(core.realDir(ctx.athenaDir), url)
      if (browserAttached && ctx.win) ctx.win.contentView.removeChildView(browserView)
      browserView.webContents.close()
    }
    browserView = null
    browserAttached = false
    send('browser:reset')
  }

  // 에이전트 모니터 — 새 본체 기록부터 다시 모은다(보고 있었으면 바로 이어서)
  function resetMonitor() {
    const watching = monitor.watching
    clearInterval(monitor.timer)
    Object.assign(monitor, newMonitor())
    if (watching) ctx.setMonitorWatch(true)
  }

  // 처음 켤 때 · [다시 시도] — 앱이 들고 온 코어를 ~/.athena-studio/core 로 풀어 쓴다
  ctx.installAthena = async () => {
    const prepared = await prepareStudioCore({ update: false })
    if (!prepared.ok) return { ...ctx.athenaState(), error: coreInstallError(prepared) }
    return useAthenaDir(STUDIO.core)
  }

  // ── 회사 팩 ──
  // 켤 때 시작 화면을 띄울지 — 첫 창이 처음 목록을 읽을 때 한 번만 정한다(그 뒤로는 화면이 '들어갔음' 을 기억한다)
  async function decideLaunchWelcome(listed) {
    if (launchWelcome !== null || !listed.supported) return
    const listedPanes = await daemonCall('pane list')
    const agentPanes = ((listedPanes.result && listedPanes.result.panes) || []).filter((pane) => pane.agent).length
    launchWelcome = packModel.welcomeOnLaunch({ list: listed, agentPanes })
  }

  ctx.refreshPacks = async () => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) {
      ctx.packState = { supported: false }
    } else {
      const listed = packModel.normalizePackList(await runPack(['list'], { dir: ctx.athenaDir }))
      await decideLaunchWelcome(listed)
      // welcome — 팩이 하나도 없을 때 시작 화면 · launchWelcome — 켤 때 시작 화면(팩이 있어도) · recent — 시작 화면 '내 팩' 목록. 규칙은 pack.js 한 곳에서만
      ctx.packState = { ...listed, welcome: packModel.showPackWelcome(listed), launchWelcome: launchWelcome === true, recent: packModel.recentPacks(listed) }
    }
    // 열린 팩 창들 — 팩 줄의 '열려 있음' 점(다른 창 목록이 바뀌어도 보이게 모든 창에)
    for (const each of packWindows) each.send('pack:state', { ...each.packState, openIds: openPackIds() })
    return { ...ctx.packState, openIds: openPackIds() }
  }

  // 한 번에 하나 — 같은 요청이 두 번 와도 두 번째는 busy
  ctx.packTask = async (name, work) => {
    if (ctx.packBusy) return { ok: false, error: 'locked', message: say('pack.error.taskBusy', { task: ctx.packBusy }) }
    ctx.packBusy = name
    ctx.packAbort = new AbortController()
    try {
      return await work(ctx.packAbort.signal)
    } finally {
      ctx.packBusy = null
      ctx.packAbort = null
    }
  }

  // 팩을 만들고 여는 명령(new · open)을 돌릴 본체 — 스튜디오 집 안 본체면 코어(주 본체), 밖에서 연결한 본체면 그 본체.
  // 코어는 앱을 켤 때마다 새 코드로 가지만 팩 본체는 claude 가 켜져 있으면 업데이트를 건너뛰어 옛 코드에 남는다 —
  // 지금 본체로 돌리면 고친 열기(빈 자리 다시 열기 등)가 들어오지 않는다. 약속 검사(contractBlock)도 같은 본체로.
  // new 는 처음부터 코어에서 — 새 팩 local.json 의 reposRoot 를 부른 본체 설정에서 옮겨 적는데,
  // 팩 본체 설정에는 reposRoot 가 없어 '..'(= bodies 폴더)로 잡혀 /setup 레포 찾기가 회사 레포를 못 찾았다. 코어 설정에는 홈이 있다
  const packManagerDir = () => (core.isInside(ctx.athenaDir, STUDIO.root) ? STUDIO.core : ctx.athenaDir)

  // 새 팩 — 빈 자리 + 그 본체(pack new)를 만들고 이 창을 그 본체로 바꾼다. 그 본체에서 claude 가 켜지면 /setup.
  // 옛 데몬이면 만들기 전에 막는다(바꿔 보면 팩끼리 pane 이 섞인다)
  ctx.packNew = async () => {
    if (daemonOld) return { ok: false, error: 'old-daemon', text: say('pack.switch.oldDaemon') }
    const dir = packManagerDir()
    const blocked = await contractBlock(dir)
    if (blocked) return blocked
    return ctx.packTask(say('pack.task.new'), async (signal) => {
      const result = await runPack(['new'], { dir, onProgress: ctx.packProgress, signal })
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      if (typeof result.body !== 'string' || !path.isAbsolute(result.body) || !core.checkAthenaDir(result.body).ok) return { ok: false, error: 'invalid-pack', text: say('pack.open.badBody') }
      const state = rebindBody(result.body)
      refreshAllPacks()
      return { ok: true, id: result.id, body: result.body, switched: true, state }
    })
  }

  // 가져오기 검사 — 파일 · 폴더 · 기존 아테나는 main 이 대화상자를 연다(화면이 경로를 만들지 않게), git 은 주소를 검사해 넘긴다
  ctx.packInspect = async (kind, source) => {
    const blocked = await contractBlock(ctx.athenaDir)
    if (blocked) return blocked
    let target = null
    if (kind === 'git') {
      target = packModel.validGitUrl(source)
      if (!target) return { ok: false, error: 'invalid-url', text: say('pack.error.invalidGitUrl') }
    } else {
      const options = {
        file: { title: say('dialog.packFile.title'), properties: ['openFile'], filters: [{ name: say('dialog.packFile.filter'), extensions: ['gz', 'tgz'] }] },
        folder: { title: say('dialog.packFolder.title'), properties: ['openDirectory'] },
        athena: { title: say('dialog.packAthena.title'), properties: ['openDirectory'] },
      }[kind]
      if (!options) return { ok: false, error: 'invalid-pack', text: say('pack.error.unknownImportKind') }
      const picked = await dialog.showOpenDialog(ctx.win, { ...options, defaultPath: app.getPath('home') })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      target = picked.filePaths[0]
    }
    return ctx.packTask(say('pack.task.inspect'), async (signal) => {
      const result = await runPack([kind === 'athena' ? 'import-athena' : 'inspect', target], { dir: ctx.athenaDir, onProgress: ctx.packProgress, signal })
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      return {
        ...result,
        source: kind === 'git' ? target : path.basename(target),
        summary: { incoming: packModel.packSummary({ ...result.pack, source: kind === 'git' ? 'git' : null }, say), existing: packModel.packSummary(result.conflict, say) },
        current: Boolean(result.conflict && ctx.packState.current && result.conflict.id === ctx.packState.current.id),
      }
    })
  }

  // 검사한 임시본 등록 — keep(버림) · replace(기존 자동 백업 후 교체) · new.
  // 교체는 본체가 그 팩 본체 기준으로 막거나(일하는 중이면 busy) 링크를 다시 건다 — 스튜디오는 pane 을 닫지 않는다
  ctx.packImport = async (token, choice) => {
    if (typeof token !== 'string' || !['keep', 'replace', 'new'].includes(choice)) return { ok: false, error: 'invalid-pack', text: say('pack.error.badImportRequest') }
    if (choice !== 'keep') {
      const blocked = await contractBlock(ctx.athenaDir)
      if (blocked) return blocked
    }
    return ctx.packTask(say('pack.task.import'), async () => {
      const result = await runPack(['import', token, `--${choice}`], { dir: ctx.athenaDir, onProgress: ctx.packProgress })
      refreshAllPacks()
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      // 열린 창의 팩을 바꿨으면 그 창 일감을 새로
      const replaced = result.imported && result.imported.id
      for (const each of packWindows) if (replaced && each.packState.current && each.packState.current.id === replaced) each.send('pack:changed', { ok: true, replaced })
      return result
    })
  }

  // 내보내기(팀에 주는 것 — 허용 목록만) · 내 백업(팩 + 작업 기록) — 저장 폴더를 고르고 명령 → 결과
  ctx.packExport = async (kind) => {
    const picked = await dialog.showOpenDialog(ctx.win, {
      title: kind === 'backup' ? say('dialog.packBackup.title') : say('dialog.packExport.title'),
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('downloads'),
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    const args = kind === 'backup' ? ['backup', '--with-work', '--out', picked.filePaths[0]] : ['export', '--out', picked.filePaths[0]]
    // 내 백업 — 이 창의 살아 있는 pane(데몬 상태는 이 본체 것만)을 넘겨 그 pane 의 에이전트 대화를 담게(코어 lib/restore.mjs)
    // claude 가 도는 pane 만 — 기록이 없는 pane 은 결과 restore.missing 으로 돌아온다(훅이 생기기 전에 켠 세션)
    if (kind === 'backup') {
      const listed = await daemonCall('pane list').catch(() => null)
      const panes = ((listed && listed.result && listed.result.panes) || []).filter((pane) => pane.agent === 'claude').map((pane) => pane.id)
      if (panes.length) args.push('--panes', panes.join(','))
    }
    return ctx.packTask(kind === 'backup' ? say('pack.task.backup') : say('pack.task.export'), async () => {
      const result = await runPack(args, { dir: ctx.athenaDir, onProgress: ctx.packProgress })
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      lastPackFile = typeof result.file === 'string' ? result.file : null
      return result
    })
  }

  // 팩 열기 — 그 팩 본체를 준비하고(pack open) 이 창을 그 본체로 바꾼다(한 창에서 바꿔 보기).
  // 다른 창이 이미 그 팩을 보고 있으면 그 창으로(한 팩을 두 창이 같이 보지 않게). newWindow 면 새 창으로(우클릭 [새 창으로 열기])
  ctx.packOpen = async (id, { newWindow = false } = {}) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    if (ctx.packState.current && ctx.packState.current.id === id) return { ok: true, same: true }
    const elsewhere = [...packWindows].find((other) => other !== ctx && other.packState.current && other.packState.current.id === id)
    if (elsewhere) {
      elsewhere.show()
      // 되살리기로 열었는데 다른 창이 이미 그 팩이면 — 그 창에서 되살린다(아테나는 그 창 아테나 옆에서)
      if (restoreArmedFor === id) elsewhere.restoreNow().then((result) => elsewhere.send('pack:restored', result))
      return { ok: true, id, existing: true }
    }
    // 옛 데몬이면 바꾸기 · 새 창 모두 막는다 — 창을 본체로 묶지 못해 팩끼리 pane 이 섞인다
    if (daemonOld) return { ok: false, error: 'old-daemon', text: say(newWindow ? 'pack.open.oldDaemon' : 'pack.switch.oldDaemon') }
    const dir = packManagerDir()
    const blocked = await contractBlock(dir)
    if (blocked) return blocked
    return ctx.packTask(say('pack.task.open'), async (signal) => {
      const result = await runPack(['open', id], { dir, onProgress: ctx.packProgress, signal })
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      if (result.created) refreshAllPacks()
      const notes = { unlinkedRepos: result.unlinkedRepos || [], repair: result.state === 'repair-required', created: result.created === true }
      const other = typeof result.body === 'string' ? ctxOfBody(result.body) : null
      if (newWindow || (other && other !== ctx)) {
        const opened = openBody(result.body)
        if (opened.error) return { ok: false, error: opened.code || 'invalid-pack', text: opened.error }
        return { ok: true, id, existing: opened.existing, ...notes }
      }
      if (other === ctx) return { ok: true, same: true }
      if (typeof result.body !== 'string' || !path.isAbsolute(result.body) || !core.checkAthenaDir(result.body).ok) return { ok: false, error: 'invalid-pack', text: say('pack.open.badBody') }
      const state = rebindBody(result.body)
      // 되살리기로 연 팩이면 이 창에 넘긴다 — 아테나를 켤 때(openAthenaAgent) 되살린다. 팩 목록(packState)은 그 뒤에 새로 읽혀서 그걸로는 못 본다
      if (restoreArmedFor === id) {
        ctx.restoreForPack = id
        restoreArmedFor = null
      }
      return { ok: true, id, switched: true, state, ...notes }
    })
  }

  // ── 팩 표시 이름 · 이미지 ──
  // 이미지는 본체가 준 iconPath(마지막 pack list)만 읽어 data URL 로 넘긴다 — 화면이 경로를 정하지 않고, CSP(img-src 'self' data:)와 맞는다
  ctx.packIcon = async (id) => iconDataUrl(packModel.packIconPath(ctx.packState, id))
  // 레포 이미지 — packRepos 가 확인한 iconPath(팩 안 · assets/repos/<레포>.*)만
  ctx.repoIcon = async (name) => {
    const repo = (await ctx.packRepos()).find((item) => item.name === name)
    return iconDataUrl(repo ? repo.iconPath : null)
  }

  // 이름 바꾸기 — name 이 없으면 원래 이름으로(--clear). 끝나면 모든 창의 목록을 새로
  ctx.packSetName = async (id, name) => {
    const result = await runPack(name === null ? ['set-name', '--clear', '--id', id] : ['set-name', name, '--id', id], { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    refreshAllPacks()
    return result
  }

  // 이미지 미리 고르기 — 이름 · 이미지 대화상자용. 고른 파일은 main 이 들고 있고(화면은 경로를 모른다) 미리보기만 넘긴다.
  // [저장] 때 packSetIcon(id, false, true) 로 붙인다 — 취소하면 아무것도 바뀌지 않는다
  ctx.packPickIcon = async (kind = 'pack') => {
    ctx.pickedIcon = null
    const picked = await dialog.showOpenDialog(ctx.win, {
      title: say(kind === 'repo' ? 'spaces.icon.title' : 'pack.icon.title'),
      properties: ['openFile'],
      filters: [{ name: say('pack.icon.filter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      defaultPath: app.getPath('pictures'),
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    try {
      const stat = await fs.promises.stat(picked.filePaths[0])
      if (stat.size > packModel.ICON_MAX_BYTES) return { ok: false, text: say('pack.icon.tooBig') }
      const bytes = await fs.promises.readFile(picked.filePaths[0])
      const mime = packModel.iconMime(bytes.subarray(0, 12))
      if (!mime) return { ok: false, text: say('pack.icon.unsupported') }
      ctx.pickedIcon = picked.filePaths[0]
      return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    } catch (error) {
      return { ok: false, text: error.message }
    }
  }

  // 이미지 고르기 — 파일 대화상자는 main 이 연다(png · jpg · webp 만 보이게). clear 면 지우기 · usePicked 면 packPickIcon 으로 고른 것
  ctx.packSetIcon = async (id, clear, usePicked = false) => {
    let args = ['set-icon', '--clear', '--id', id]
    if (usePicked) {
      if (!ctx.pickedIcon) return { canceled: true }
      args = ['set-icon', ctx.pickedIcon, '--id', id]
      ctx.pickedIcon = null
    } else if (!clear) {
      const picked = await dialog.showOpenDialog(ctx.win, {
        title: say('pack.icon.title'),
        properties: ['openFile'],
        filters: [{ name: say('pack.icon.filter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        defaultPath: app.getPath('pictures'),
      })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      args = ['set-icon', picked.filePaths[0], '--id', id]
    }
    const result = await runPack(args, { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    refreshAllPacks()
    return result
  }

  // 레포 표시 이름 · 이미지 — 이 창 본체의 팩(코어 pack set-repo-name · set-repo-icon). name 이 null 이면 원래 이름으로(--clear).
  // 이미지는 이름 · 이미지 대화상자에서 미리 고른 것(usePicked)이나 지우기만 — 바뀐 목록은 화면이 다시 읽는다(refreshPackRepos)
  ctx.repoSetName = async (repo, name) => {
    if (!/^[\w.-]+$/.test(repo)) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    const result = await runPack(name === null ? ['set-repo-name', repo, '--clear'] : ['set-repo-name', repo, name], { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }
  ctx.repoSetIcon = async (repo, clear, usePicked = false) => {
    if (!/^[\w.-]+$/.test(repo)) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    let args = ['set-repo-icon', repo, '--clear']
    if (!clear) {
      if (!usePicked || !ctx.pickedIcon) return { canceled: true }
      args = ['set-repo-icon', repo, ctx.pickedIcon]
      ctx.pickedIcon = null
    }
    const result = await runPack(args, { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }

  // 팩 지우기 — 열린 창이 없는 팩만. 코어 pack delete(먼저 팩 + 작업 기록 + 워크트리 변경 백업 · 일하는 중이면 busy · 워크트리가 있으면 has-worktrees)를
  // 팩 관리 본체에서 — 팩 본체는 자기 팩을 지우지 못한다. 레포 폴더(코드)는 그대로
  ctx.deletePack = async (id, { withWorktrees = false } = {}) => {
    if (openPackIds().includes(id)) return { ok: false, error: 'open', text: say('pack.delete.open') }
    const dir = packManagerDir()
    const blocked = await contractBlock(dir)
    if (blocked) return blocked
    const result = await ctx.packTask(say('pack.task.delete'), (signal) => runPack(['delete', id, ...(withWorktrees ? ['--with-worktrees'] : [])], { dir, onProgress: ctx.packProgress, signal }))
    if (result.ok) {
      lastPackFile = typeof result.backup === 'string' ? result.backup : null
      refreshAllPacks()
      return result
    }
    if (result.error === 'has-worktrees') return { ok: false, error: 'has-worktrees', worktrees: Array.isArray(result.worktrees) ? result.worktrees : [] }
    if (result.error === 'unsafe') return { ...result, text: say('pack.delete.unsafe') }
    return { ...result, text: packModel.packErrorText(result, say) }
  }

  // 팩 아이콘 우클릭 메뉴 — 고른 동작 이름을 돌려준다(이름 입력은 화면이 받는다). 아무것도 안 고르면 null
  ctx.packContextMenu = (id, point) => {
    const pack = [...(ctx.packState.packs || []), ctx.packState.current].find((item) => item && item.id === id)
    if (!pack || !ctx.win) return Promise.resolve(null)
    return new Promise((resolve) => {
      let chosen = null
      const pick = (action) => () => {
        chosen = action
        resolve(action)
      }
      const items = []
      // 지금 팩이 아니면 — 따로 띄우고 싶을 때만 새 창으로(누르면 이 창에서 바꿔 본다)
      if (!(ctx.packState.current && ctx.packState.current.id === id)) items.push({ label: say('pack.menu.newWindow'), click: pick('new-window') }, { type: 'separator' })
      items.push({ label: say('pack.menu.rename'), click: pick('rename') })
      if (pack.displayName) items.push({ label: say('pack.menu.resetName'), click: pick('reset-name') })
      items.push({ type: 'separator' }, { label: say('pack.menu.icon'), click: pick('icon') })
      if (pack.iconPath) items.push({ label: say('pack.menu.clearIcon'), click: pick('clear-icon') })
      // 내보내기(담을 것은 화면이 묻는다) — 코어 명령이 이 본체의 팩(지금 팩)만 다룬다(--id 가 없다)
      if (ctx.packState.current && ctx.packState.current.id === id) items.push({ type: 'separator' }, { label: say('pack.link.export'), click: pick('export') })
      // 지우기 — 어느 창도 보고 있지 않은 팩만(보는 창이 있으면 그 창에서 다른 팩으로 바꾼 뒤)
      if (!openPackIds().includes(id)) items.push({ type: 'separator' }, { label: say('pack.menu.delete'), click: pick('delete') })
      // 메뉴가 닫힌 뒤 click 이 늦게 올 수 있어 잠깐 기다렸다 null
      const menu = Menu.buildFromTemplate(items)
      menu.once('menu-will-close', () => setTimeout(() => resolve(chosen), 100))
      // 누른 자리에 — 안 주면 OS 커서 자리(다른 화면일 수도)에 뜬다
      const at = point && Number.isInteger(point.x) && Number.isInteger(point.y) ? { x: point.x, y: point.y } : {}
      menu.popup({ window: ctx.win, ...at, callback: () => setTimeout(() => resolve(chosen), 100) })
    })
  }

  // ── 옆 브라우저 — 창마다 서랍 하나 ──
  // 작업 창 · 일감 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그리고(아무 사이트 · 로그인 쿠키 유지 — 창끼리 같은 저장소),
  // 화면은 서랍 안 자리(#browser-slot)의 사각형만 알려 준다. 페이지에는 preload · Node 를 넘기지 않는다
  function ensureBrowserView() {
    if (browserView && !browserView.webContents.isDestroyed()) return browserView
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    // 카메라 · 마이크 · 알림 · 위치 같은 권한은 묻지 않고 거절한다
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserView = new WebContentsView({
      webPreferences: { partition: BROWSER_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    // 빈 페이지일 땐 앱 배경색(흰 판이 튀지 않게). 웹 페이지로 가면 흰색 — 배경을 안 정한 사이트가 어두운 바탕에 검은 글씨가 되지 않게
    const view = browserView
    const fitBackground = (url) => view.setBackgroundColor(core.isWebUrl(url) ? '#ffffff' : APP_BACKGROUND)
    fitBackground('')
    watchConsoleSends(browserSession)
    const contents = browserView.webContents
    contents.on('did-navigate', (_event, url) => fitBackground(url))
    // 이 팩에서 보던 페이지가 있으면 그걸로(팩을 바꿨다 돌아오면)
    const remembered = ctx.athenaDir ? browserUrls.get(core.realDir(ctx.athenaDir)) : null
    if (remembered) contents.loadURL(remembered)
    // http(s) 밖으로는 움직이지 않는다 — 안쪽 프레임까지
    contents.on('will-frame-navigate', (event) => {
      if (!core.isWebUrl(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!core.isWebUrl(url)) event.preventDefault()
    })
    for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
      contents.on(name, sendBrowserState)
    }
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 은 이동이 취소된 것(새 주소로 바로 넘어감) — 알리지 않는다
      if (isMainFrame && code !== -3) send('browser:error', `${description} (${code}) — ${url}`)
    })
    return browserView
  }
  ctx.isBrowserContents = (contents) => Boolean(browserView) && !browserView.webContents.isDestroyed() && contents === browserView.webContents

  function sendBrowserState() {
    if (!browserView || browserView.webContents.isDestroyed()) return
    const contents = browserView.webContents
    const history = contents.navigationHistory
    send('browser:state', {
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      loading: contents.isLoading(),
    })
  }

  // 화면이 서랍을 열고, 다 나오면 browser:place 로 자리를 알려 준다
  ctx.openInBrowser = (url) => {
    ensureBrowserView().webContents.loadURL(url)
    send('browser:open', url)
    if (ctx.win) ctx.win.show()
  }

  // 화면 좌표(CSS 픽셀)는 확대·축소 비율을 곱해야 창 좌표가 된다. 창 안으로 자른다
  ctx.placeBrowser = (rect) => {
    if (!ctx.win || !rect) return
    const view = ensureBrowserView()
    const zoom = ctx.win.webContents.getZoomFactor()
    const [contentWidth, contentHeight] = ctx.win.getContentSize()
    const x = Math.min(Math.max(0, Math.round(rect.x * zoom)), contentWidth)
    const y = Math.min(Math.max(0, Math.round(rect.y * zoom)), contentHeight)
    const width = Math.min(Math.max(0, Math.round(rect.width * zoom)), contentWidth - x)
    const height = Math.min(Math.max(0, Math.round(rect.height * zoom)), contentHeight - y)
    view.setBounds({ x, y, width, height })
    if (!browserAttached) {
      ctx.win.contentView.addChildView(view)
      browserAttached = true
    }
  }

  // 서랍을 닫기 시작할 때 먼저 뗀다(페이지가 화면 위에 떠 있으니 슬라이드 전에 치운다). 페이지는 그대로 두어 다시 열면 이어 본다
  ctx.hideBrowser = () => {
    if (!ctx.win || !browserView || !browserAttached) return
    ctx.win.contentView.removeChildView(browserView)
    browserAttached = false
  }

  ctx.browserCommand = (name, value) => {
    if (name === 'navigate') {
      const url = core.normalizeAddress(value)
      if (!url) return { error: say('error.urlNotAllowed') }
      ensureBrowserView().webContents.loadURL(url)
      return { url }
    }
    if (!browserView || browserView.webContents.isDestroyed()) return {}
    const contents = browserView.webContents
    if (name === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    if (name === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    if (name === 'reload') contents.reload()
    if (name === 'stop') contents.stop()
    if (name === 'external' && core.isWebUrl(contents.getURL())) shell.openExternal(contents.getURL())
    return {}
  }

  // ── 창 ──
  ctx.show = (tab) => {
    if (!ctx.win || ctx.win.isDestroyed()) return
    // 일감은 창을 앞으로 가져오지 않고 기본 브라우저로 — 화면(시작 화면이면 열지 않음)이 정한다
    if (tab === 'board') return send('tab:switch', 'board')
    if (ctx.win.isMinimized()) ctx.win.restore()
    ctx.win.show()
    ctx.win.focus()
    if (tab) send('tab:switch', tab)
  }

  // 그 창만 닫기 — 시작 화면에서 다른 팩을 열면 이 창은 접는다(창 하나 = 팩 하나)
  ctx.close = () => {
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.destroy()
  }

  ctx.win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'Athena',
    titleBarStyle: isMac ? 'hiddenInset' : 'default', // 맥은 탭 줄이 제목 줄을 겸한다
    backgroundColor: APP_BACKGROUND,
    icon: APP_ICON, // 맥은 무시한다(Dock 은 whenReady 에서) — 윈도우·리눅스 창 아이콘
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  ctx.win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // 맨 위 페이지는 앱 화면에서 벗어나지 않는다 — 이동하려는 주소는 openUrl 이 옆 브라우저 · 기본 브라우저로 돌린다
  ctx.win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openUrl(ctx, url)
  })
  ctx.win.on('focus', () => {
    lastFocused = ctx
    if (hasTray()) pollTray() // 메뉴 막대는 앞 창의 팩만 — 창을 바꾸면 바로 다시 읽는다
  })
  // 맥은 마지막 창을 닫아도 메뉴 막대에 남는다(숨기기) — 완전히 끄는 것은 [Athena 종료] · ⌘Q. 창이 여럿이면 그 창만 닫는다
  ctx.win.on('close', (event) => {
    if (!isMac || quitting || packWindows.size > 1) return
    event.preventDefault()
    ctx.win.hide()
  })
  ctx.win.on('closed', () => {
    ctx.win = null
    clearInterval(monitor.timer)
    ctx.stopRequests()
    // 서랍에서 떼어 둔 뷰는 창과 함께 정리되지 않는다 — 직접 닫는다
    if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close()
    browserView = null
    browserAttached = false
    ctx.detachScreen()
    packWindows.delete(ctx)
    if (lastFocused === ctx) lastFocused = null
    saveWindows()
    for (const each of packWindows) each.send('pack:state', { ...each.packState, openIds: openPackIds() })
  })
  packWindows.add(ctx)
  ctx.prepareBoardPort()
  ctx.watchRequests()
  return ctx
}

// 본체 경로 → 그 창(있으면 앞으로, 없으면 새로). 창 하나 = 본체 하나
function openBody(body) {
  if (typeof body !== 'string' || !path.isAbsolute(body) || !core.checkAthenaDir(body).ok) return { error: say('pack.open.badBody') }
  const existing = ctxOfBody(body)
  if (existing) {
    existing.show()
    return { existing: true }
  }
  if (daemonOld) return { error: say('pack.open.oldDaemon'), code: 'old-daemon' }
  try {
    core.ensureAthenaConfig(body, athenaReposRoot(body))
  } catch {}
  const ctx = createPackWindow(body)
  saveWindows()
  ctx.show()
  return { existing: false }
}

// ── 새 창 · 링크 ──────────────────────────────────────────
// 터미널 링크 · 맨 위 페이지 이동 — localhost(계획서 · 테스트 화면)는 그 창 옆 브라우저, 그 밖 http(s) 는 기본 브라우저
function openUrl(ctx, url) {
  const target = core.openTarget(url)
  if (target === 'external') shell.openExternal(url)
  if (target === 'panel' && ctx) ctx.openInBrowser(url)
  return target
}

// 새 창 요청 — 팩 창 · 그 밖 화면에서 온 것은 링크와 같은 규칙(localhost 는 그 창 옆 브라우저, 그 밖 http(s) 는 기본 브라우저).
// 옆 브라우저 안에서 연 새 창은 같은 뷰로. 새 BrowserWindow 는 만들지 않는다
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    const owner = [...packWindows].find((ctx) => ctx.isBrowserContents(contents))
    if (owner) {
      if (core.isWebUrl(url)) contents.loadURL(url)
    } else {
      const fromWindow = [...packWindows].find((ctx) => ctx.win && contents === ctx.win.webContents)
      openUrl(fromWindow || frontCtx(), url)
    }
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

const BROWSER_PARTITION = 'persist:studio-browser'
const CONSOLE_CLOSE_MS = 1200 // [이대로 진행] 뒤 '✅ 보냄' 을 잠깐 보여 주고 서랍을 닫는다

// 결정 콘솔이 보내기를 마치면 그 창의 옆 브라우저 서랍을 닫는다(사용자 요청 2026-10-19). 세션은 창끼리 같이 쓰니 한 번만 건다
let consoleWatched = false
function watchConsoleSends(browserSession) {
  if (consoleWatched) return
  consoleWatched = true
  browserSession.webRequest.onCompleted((details) => {
    const contents = details.webContents
    if (!contents || contents.isDestroyed()) return
    const owner = [...packWindows].find((ctx) => ctx.isBrowserContents(contents))
    if (!owner) return
    if (!core.isConsoleSent({ method: details.method, url: details.url, statusCode: details.statusCode, pageUrl: contents.getURL() })) return
    setTimeout(() => owner.send('browser:close'), CONSOLE_CLOSE_MS)
  })
}

// 보일 때만 2초마다 창마다 pane 목록 · 브랜치
let panesTimer = null
function startPanesPolling() {
  clearInterval(panesTimer)
  panesTimer = setInterval(() => {
    for (const ctx of packWindows) ctx.pollPanes().catch(() => {})
  }, 2000)
}

// ── 메뉴 막대(Tray) — 앞에 있는 창의 팩만 — src/main/tray.mts ───────────────────
// 쓰는 것(화면 문구 · 앞 창 찾기 · 열린 팩 창 · 지난 창 다시 열기)은 인자로 넘긴다. tray · 패널 창은 바뀌는 값이라 hasTray() · trayPanel() 로 읽는다
const { fetchBoardJson } = require('./main/board.mts')
const { setupTray } = require('./main/tray.mts')
const { createTray, refreshTray, sendTrayUpdate, pollTray, trayRequestsChanged, showWindow, hasTray, trayPanel } = setupTray({ say, frontCtx, packWindows, openSavedWindows })

// ── 창 · 메뉴 ─────────────────────────────────────────────
// 지난번에 열려 있던 팩 창들을 다시 연다 — 첫 창만 시작 화면 규칙을 본다. 본체가 없으면 처음 화면(아테나 폴더 고르기) 창 하나.
// 첫 창은 바로 만든다(showWindow 가 곧바로 찾는다). 두 번째 창부터는 데몬 버전을 본 뒤 — 옛 데몬이면 열지 않고 남겨 둔다
function openSavedWindows() {
  const dirs = core.windowDirs(config, core.sameDir).filter((dir) => core.checkAthenaDir(dir).ok)
  if (!dirs.length) {
    createPackWindow(config.athenaDir || null, { welcome: true })
    return
  }
  const first = createPackWindow(dirs[0], { welcome: true })
  if (dirs.length === 1) return
  heldDirs = dirs.slice(1)
  first
    .connectDaemon()
    .catch(() => null)
    .then(() => {
      if (!daemonOld) return releaseHeldWindows()
      if (!heldDirs.length) return undefined
      const notice = { type: 'info', message: say('pack.open.heldWindows', { count: heldDirs.length }) }
      return (first.win ? dialog.showMessageBox(first.win, notice) : dialog.showMessageBox(notice)).catch(() => null)
    })
}

// 메뉴 [보기 → 언어] — 언어 이름은 그 언어로, 검수 전 사전은 그 언어의 '검수 전' 표시를 붙인다
function languageMenu() {
  return i18n.LANGUAGES.map((lang) => {
    const dictionary = DICTIONARIES[lang]
    const draft = dictionary['meta.status'] === 'draft' ? ` (${dictionary['meta.draftLabel']})` : ''
    return { label: `${dictionary['meta.name']}${draft}`, type: 'radio', checked: lang === language, click: () => setLanguage(lang) }
  })
}

// Electron role 항목도 라벨을 사전에서 준다(role 기본 라벨은 영어 고정이라 앱 언어와 어긋난다)
function appMenu() {
  const name = 'Athena' // 보이는 이름(트레이 · 정보 창과 같다) — app.getName() 은 데이터 폴더 이름 Athena Studio
  return {
    role: 'appMenu',
    submenu: [
      { role: 'about', label: say('menu.app.about', { name }) },
      { type: 'separator' },
      { role: 'services', label: say('menu.app.services') },
      { type: 'separator' },
      { role: 'hide', label: say('menu.app.hide', { name }) },
      { role: 'hideOthers', label: say('menu.app.hideOthers') },
      { role: 'unhide', label: say('menu.app.unhide') },
      { type: 'separator' },
      { role: 'quit', label: say('menu.app.quit', { name }) },
    ],
  }
}

function windowMenu() {
  const items = isMac
    ? [{ role: 'minimize', label: say('menu.window.minimize') }, { role: 'zoom', label: say('menu.window.zoom') }, { type: 'separator' }, { role: 'front', label: say('menu.window.front') }]
    : [{ role: 'minimize', label: say('menu.window.minimize') }, { role: 'close', label: say('menu.window.close') }]
  return { role: 'windowMenu', label: say('menu.window'), submenu: items }
}

// 메뉴는 앞에 있는 팩 창에 보낸다
const toFront = (channel, ...args) => () => {
  const ctx = frontCtx()
  if (ctx) ctx.send(channel, ...args)
}

function buildMenu() {
  const template = [
    ...(isMac ? [appMenu()] : []),
    {
      label: say('menu.file'),
      submenu: [
        { label: say('menu.file.pack'), accelerator: `${TAB_KEY}+Shift+P`, click: toFront('pack:command', 'picker') },
        { label: say('menu.file.packImport'), click: toFront('pack:command', 'import') },
        { label: say('menu.file.packExport'), click: toFront('pack:command', 'export') },
        { type: 'separator' },
        { label: say('menu.file.pickAthena'), click: toFront('athena:pick') },
        { type: 'separator' },
        { label: say('menu.file.newTab'), accelerator: `${TAB_KEY}+T`, click: toFront('screen:command', 'new-tab') },
        { label: say('menu.file.newWorkspace'), accelerator: `${TAB_KEY}+Shift+T`, click: toFront('screen:command', 'new-workspace') },
        { label: say('menu.file.closePane'), accelerator: `${TAB_KEY}+W`, click: toFront('screen:command', 'close-pane') },
        { label: say('menu.file.closeTab'), accelerator: `${TAB_KEY}+Alt+W`, click: toFront('screen:command', 'close-tab') },
        { type: 'separator' },
        // ⌘W 는 pane 닫기라 창 닫기는 ⌘⇧W(S6)
        isMac ? { role: 'close', label: say('menu.file.closeWindow'), accelerator: 'Command+Shift+W' } : { role: 'quit', label: say('menu.file.quit') },
      ],
    },
    {
      label: say('menu.edit'),
      submenu: [
        { role: 'copy', label: say('menu.edit.copy') },
        { role: 'paste', label: say('menu.edit.paste') },
        { role: 'selectAll', label: say('menu.edit.selectAll') },
      ],
    },
    {
      label: say('menu.view'),
      submenu: [
        { label: say('menu.view.work'), accelerator: `${TAB_KEY}+1`, click: toFront('tab:switch', 'work') },
        { label: say('menu.view.board'), accelerator: `${TAB_KEY}+2`, click: toFront('tab:switch', 'board') },
        { type: 'separator' },
        { label: say('menu.view.browser'), accelerator: `${TAB_KEY}+Shift+B`, click: toFront('browser:toggle') },
        { label: say('menu.view.reattach'), click: toFront('screen:resync') },
        { label: say('menu.view.restartDaemon'), click: () => restartDaemon() },
        { label: say('menu.view.resetStudio'), click: () => resetStudio() },
        { type: 'separator' },
        { label: say('menu.view.language'), submenu: languageMenu() },
        { type: 'separator' },
        { role: 'resetZoom', label: say('menu.view.resetZoom') },
        { role: 'zoomIn', label: say('menu.view.zoomIn') },
        { role: 'zoomOut', label: say('menu.view.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: say('menu.view.fullscreen') },
        { role: 'toggleDevTools', label: say('menu.view.devTools') },
      ],
    },
    {
      label: say('menu.pane'),
      submenu: [
        { label: say('menu.pane.splitRight'), accelerator: `${TAB_KEY}+D`, click: toFront('screen:command', 'split-right') },
        { label: say('menu.pane.splitDown'), accelerator: `${TAB_KEY}+Shift+D`, click: toFront('screen:command', 'split-down') },
        { type: 'separator' },
        { label: say('menu.pane.focusLeft'), accelerator: `${TAB_KEY}+Alt+Left`, click: toFront('screen:command', 'focus-left') },
        { label: say('menu.pane.focusRight'), accelerator: `${TAB_KEY}+Alt+Right`, click: toFront('screen:command', 'focus-right') },
        { label: say('menu.pane.focusUp'), accelerator: `${TAB_KEY}+Alt+Up`, click: toFront('screen:command', 'focus-up') },
        { label: say('menu.pane.focusDown'), accelerator: `${TAB_KEY}+Alt+Down`, click: toFront('screen:command', 'focus-down') },
        { type: 'separator' },
        { label: say('menu.pane.tabPrev'), accelerator: `${TAB_KEY}+Shift+[`, click: toFront('screen:command', 'tab-prev') },
        { label: say('menu.pane.tabNext'), accelerator: `${TAB_KEY}+Shift+]`, click: toFront('screen:command', 'tab-next') },
        { label: say('menu.pane.workspacePrev'), accelerator: `${TAB_KEY}+Shift+Up`, click: toFront('screen:command', 'workspace-prev') },
        { label: say('menu.pane.workspaceNext'), accelerator: `${TAB_KEY}+Shift+Down`, click: toFront('screen:command', 'workspace-next') },
        { type: 'separator' },
        // VSCode 와 같게 — ⌘B 왼쪽 · ⌘⌥B 오른쪽
        { label: say('menu.pane.toggleSpaces'), accelerator: `${TAB_KEY}+B`, click: toFront('screen:command', 'toggle-spaces') },
        { label: say('menu.pane.togglePanel'), accelerator: `${TAB_KEY}+Alt+B`, click: toFront('screen:command', 'toggle-panel') },
      ],
    },
    windowMenu(),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC — 모두 보낸 창의 문맥으로 ─────────────────────────────
// 언어 사전 — preload 가 처음 한 번 동기로 받는다(화면이 첫 글자를 그리기 전에). 읽기 전용 데이터
ipcMain.on('i18n:get', (event) => (event.returnValue = i18nPayload()))

// handle(채널, (ctx, ...args) => …) — 팩 창 화면에서 온 것만. 문맥이 없으면(하위 프레임 · 닫힌 창) 거절
const NO_WINDOW = '앱 화면에서만 부를 수 있어요'
function handle(channel, work) {
  ipcMain.handle(channel, (event, ...args) => {
    const ctx = ctxOf(event)
    if (!ctx) return { error: NO_WINDOW }
    return work(ctx, ...args)
  })
}
function listen(channel, work) {
  ipcMain.on(channel, (event, ...args) => {
    const ctx = ctxOf(event)
    if (ctx) work(ctx, ...args)
  })
}

handle('athena:state', (ctx) => ctx.athenaState())
handle('athena:pick', (ctx) => ctx.pickAthenaDir())
handle('athena:install', (ctx) => ctx.installAthena())
// 회사 팩 — 본체 명령을 부르고 결과만 화면에. 문자열 · 고른 값만 받는다
handle('pack:list', (ctx) => ctx.refreshPacks())
handle('pack:open', (ctx, id, options) => ctx.packOpen(String(id), { newWindow: Boolean(options && options.newWindow) }))
handle('pack:new', (ctx) => ctx.packNew())
handle('pack:cancel', (ctx) => {
  if (ctx.packAbort) ctx.packAbort.abort()
  return { ok: true }
})
handle('pack:inspect', (ctx, kind, source) => ctx.packInspect(String(kind), typeof source === 'string' ? source : null))
handle('pack:import', (ctx, token, choice) => ctx.packImport(String(token), String(choice)))
handle('pack:export', (ctx, kind) => ctx.packExport(kind === 'backup' ? 'backup' : 'share'))
handle('pack:reveal', () => packReveal())
handle('pack:icon', (ctx, id) => ctx.packIcon(String(id)))
handle('pack:set-name', (ctx, id, name) => ctx.packSetName(String(id), typeof name === 'string' ? name : null))
handle('pack:set-icon', (ctx, id, clear, usePicked) => ctx.packSetIcon(String(id), clear === true, usePicked === true))
handle('pack:pick-icon', (ctx, kind) => ctx.packPickIcon(kind === 'repo' ? 'repo' : 'pack'))
handle('repo:icon', (ctx, name) => ctx.repoIcon(String(name)))
handle('repo:set-name', (ctx, name, displayName) => ctx.repoSetName(String(name), typeof displayName === 'string' ? displayName : null))
handle('repo:set-icon', (ctx, name, clear, usePicked) => ctx.repoSetIcon(String(name), clear === true, usePicked === true))
handle('pack:context-menu', (ctx, id, point) => ctx.packContextMenu(String(id), point && typeof point === 'object' ? point : null))
// 이 창 닫기 — 시작 화면에서 다른 팩을 열고 나면(창이 하나뿐이면 닫지 않는다)
handle('window:close', (ctx) => {
  if (packWindows.size > 1) setImmediate(() => ctx.close())
  return { closed: packWindows.size > 1 }
})
handle('screen:attach', (ctx) => ctx.attachScreen())
handle('pack:repos', (ctx) => ctx.packRepos())
handle('app-update:status', () => appUpdateView())
handle('app-update:check', () => checkAppUpdate())
handle('app-update:run', () => runAppUpdate())
handle('settings:merge', (ctx) => ctx.mergeSettings())
handle('settings:set-merge', (ctx, repo, values) => ctx.setAutoMerge(String(repo || ''), {
  autoMerge: values && typeof values.autoMerge === 'boolean' ? values.autoMerge : null,
  confirm: values && typeof values.confirm === 'boolean' ? values.confirm : null,
}))
handle('pack:call-info', (ctx, name) => ctx.callInfo(String(name || '')))
handle('pack:call-start', (ctx, name, options) => ctx.callStart(String(name || ''), { branch: String((options && options.branch) || ''), reuse: Boolean(options && options.reuse) }))
handle('pack:restore-arm', (ctx, id) => (restoreArmedFor = typeof id === 'string' && id ? id : null))
handle('pack:restore-disarm', () => (restoreArmedFor = null))
handle('pack:restore-now', (ctx) => ctx.restoreNow())
handle('pack:restore-discard', (ctx) => ctx.packRestore({ discard: true }))
handle('agent:open', (ctx, size, options) => ctx.openAthenaAgent(cellSize(size), { keepView: Boolean(options && options.keepView) }))
handle('tab:new', (ctx, size) => ctx.daemonCall('tab new', { defaultCwd: ctx.athenaDir, ...cellSize(size) }))
handle('tab:select', (ctx, tabId) => ctx.daemonCall('tab select', { tab: String(tabId) }))
handle('tab:close', (ctx, tabId) => ctx.closeTab(String(tabId)))
// 탭 이름 바꾸기 — 비우면 데몬이 이름을 지워 화면이 기본 이름(탭 N)을 쓴다
handle('tab:rename', (ctx, tabId, label) => ctx.daemonCall('tab rename', { tab: String(tabId), label: typeof label === 'string' ? label.trim().slice(0, 60) : '' }))
handle('workspace:select', (ctx, workspaceId) => ctx.daemonCall('workspace select', { workspace: String(workspaceId) }))
handle('workspace:new', (ctx, size) => ctx.newWorkspace(cellSize(size)))
handle('workspace:open-dir', (ctx, dir, size) => (typeof dir === 'string' && path.isAbsolute(dir) ? ctx.openWorkspaceDir(dir, cellSize(size)) : { error: 'bad dir' }))
handle('pack:delete', (ctx, id, options) => ctx.deletePack(String(id), { withWorktrees: Boolean(options && options.withWorktrees) }))
handle('pack:body-behind', (ctx) => ctx.bodyBehind())
handle('pack:remove-repo', (ctx, name) => (typeof name === 'string' && /^[\w.-]+$/.test(name) ? ctx.removeRepo(name) : { ok: false, error: 'usage' }))
handle('workspace:close', (ctx, workspaceId) => ctx.closeWorkspace(String(workspaceId || '')))
handle('space:context-menu', (ctx, target, point) => ctx.spaceContextMenu({ repo: target && typeof target.repo === 'string' ? target.repo : null, workspace: target && typeof target.workspace === 'string' ? target.workspace : null }, point && typeof point === 'object' ? point : null))
handle('pack:add-repo', (ctx, dir, name) => (typeof dir === 'string' && path.isAbsolute(dir) ? ctx.addRepo(dir, typeof name === 'string' && name ? name : null) : { ok: false, error: 'usage' }))
listen('monitor:watch', (ctx, on) => ctx.setMonitorWatch(on === true))
handle('explorer:list', (ctx, workspaceId, relative) => guarded(() => ctx.explorerList(workspaceId, relative)))
handle('explorer:status', (ctx, workspaceId) => guarded(() => ctx.explorerStatus(workspaceId)))
handle('explorer:open', (ctx, workspaceId, relative) => guarded(() => ctx.explorerOpen(workspaceId, relative)))
handle('pane:split', (ctx, paneId, direction) => ctx.daemonCall('pane split', { target: String(paneId), direction: direction === 'down' ? 'down' : 'right' }))
handle('pane:close', (ctx, paneId) => ctx.closePane(String(paneId)))
handle('pane:context-menu', (ctx, point) => ctx.paneContextMenu(point && typeof point === 'object' ? point : null))
listen('pane:focus', (ctx, paneId) => ctx.notifyDaemon('focus', { pane: String(paneId) }))
listen('pane:input', (ctx, paneId, data) => {
  if (typeof data === 'string') ctx.notifyDaemon('input', { pane: String(paneId), data })
})
listen('pane:resize', (ctx, paneId, cols, rows) => {
  if (cols > 1 && rows > 1) ctx.resizePane(String(paneId), cols | 0, rows | 0)
})
listen('tab:size', (ctx, tabId, size) => {
  const cells = cellSize(size)
  if (cells.cols) ctx.notifyDaemon('tab size', { tab: String(tabId), ...cells })
})
// pane 경계를 끈 결과를 데몬 탭 트리에 — 옛 데몬은 이 동작을 몰라 usage 로 답한다(그땐 화면이 임시로 기억한다)
handle('tab:ratio', async (ctx, tabId, path, ratio) => {
  if (typeof tabId !== 'string' || !Array.isArray(path) || !path.every((step) => step === 'first' || step === 'second') || typeof ratio !== 'number') {
    return { error: '잘못된 경계 값' }
  }
  const reply = await ctx.daemonCall('tab ratio', { tab: tabId, path, ratio })
  if (reply.error && reply.code === 'usage' && /모르는 동작/.test(reply.error)) return { unsupported: true }
  return reply
})
handle('board:open', (ctx) => ctx.openBoardExternal())
// [작업] 팝업 — 목록(요청 + 계획서) · 상세(계획서 id 만 받는다)
handle('work:get', (ctx) => ctx.workState())
handle('work:requests', (ctx) => ctx.refreshRequests())
handle('work:answer', (ctx, id, answer) => ctx.answerRequest(String(id || ''), { choice: String((answer && answer.choice) || '').slice(0, 500), text: String((answer && answer.text) || '').slice(0, 1500) }))
handle('work:redeliver', (ctx, id) => ctx.redeliverRequest(String(id || '')))
handle('work:open-plan', (ctx, id, html) => ctx.openPlan(String(id || ''), html ? String(html) : null))
handle('board:section', (ctx, section) => ctx.openBoardSection(String(section || '')))
handle('board:diagrams', (ctx) => ctx.openDiagrams())
handle('work:detail', (ctx, id) => ctx.workDetail(String(id || '')))
// pane [상세] — 계획서에 묶인 pane(머리 줄 아이콘) · 그 pane 의 상세
handle('pane:bound', (ctx) => ctx.paneBound())
handle('pane:detail', (ctx, paneId) => ctx.paneDetail(String(paneId || '')))
listen('ui:tab', (ctx, tab) => (ctx.uiTab = tab === 'board' ? 'board' : 'work'))
handle('open:url', (ctx, url) => openUrl(ctx, String(url)))
// 옆 브라우저 IPC 도 그 창 앱 화면(맨 위 프레임)에서 온 것만 — 하위 프레임 · 서랍 안 페이지는 못 부른다(ctxOf 가 가린다)
listen('browser:place', (ctx, rect) => ctx.placeBrowser(browserRect(rect)))
listen('browser:hide', (ctx) => ctx.hideBrowser())
handle('browser:command', (ctx, name, value) => ctx.browserCommand(String(name), typeof value === 'string' ? value : ''))

app.whenReady().then(async () => {
  // 앱 데이터 폴더 이름(IDENTITY.name)은 맨 위에서 정했다 — 바꾸면 설정 · 데몬이 옮겨진다
  // 보이는 이름은 Athena(메뉴 막대 · Dock 은 개발용 Athena.app — scripts/dev-app.js)
  // 버전은 ⚙ 앱 업데이트 줄과 같은 번호(version 도 같게 — 괄호 안 Electron 번호가 붙지 않게)
  app.setAboutPanelOptions({ applicationName: 'Athena', applicationVersion: appVersion(), version: appVersion() })
  // Dock 아이콘을 앱 아이콘으로(개발용 Athena.app 번들 아이콘과 같다 — 원본 Electron 으로 켜졌을 때도)
  if (isMac && app.dock) app.dock.setIcon(APP_ICON)
  config = core.loadConfig(configFile())
  // 예전 설정(athenaDir 하나)은 창 목록 하나로(그 뒤로는 windows 가 기준)
  if (!Array.isArray(config.windows)) config = core.withWindows(config, core.windowDirs(config, core.sameDir))
  language = i18n.pickLanguage(config.language, app.getLocale())
  // 코어 준비 · 업데이트는 git · node 를 부르므로 로그인 셸 PATH 를 받은 뒤에
  const loginPath = await loadLoginPath()
  if (loginPath) process.env.PATH = core.mergePath(loginPath, process.env.PATH)
  // 스튜디오 코어 — 처음이면 번들에서 풀고, 있던 본체면 번들이 앞일 때 업데이트(창을 열기 전 · 일하는 본체는 코어가 건너뛴다)
  const prepared = await prepareStudioCore({ update: true })
  if (prepared.ok && !core.windowDirs(config, core.sameDir).length) {
    config = core.withWindows(config, [STUDIO.core])
    core.saveConfig(configFile(), config)
  }
  for (const dir of core.windowDirs(config, core.sameDir)) {
    if (!core.checkAthenaDir(dir).ok) continue
    try {
      core.ensureAthenaConfig(dir, athenaReposRoot(dir))
    } catch {}
  }
  buildMenu()
  openSavedWindows()
  const first = frontCtx()
  showCoreUpdateNotice(first && first.win)
  showAppUpdateNotice(first && first.win)
  checkAppUpdate()
  setInterval(checkAppUpdate, APP_UPDATE_CHECK_MS)
  startPanesPolling()
  // 메뉴 막대는 맥에서만(다른 OS 는 숨은 패널 창이 남아 창을 닫아도 앱이 안 꺼진다)
  if (isMac) createTray()
  app.on('activate', () => showWindow())
})

let quitting = false
app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
app.on('before-quit', () => {
  quitting = true
  for (const ctx of packWindows) ctx.detachScreen()
})

// 화면이 준 서랍 자리 — 숫자(문자열 아님)이고 화면 크기쯤(0~100000)이 아니면 버린다
function browserRect(rect) {
  if (!rect || typeof rect !== 'object') return null
  const values = ['x', 'y', 'width', 'height'].map((key) => rect[key])
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)) return null
  const [x, y, width, height] = values
  return { x, y, width, height }
}

// 화면이 준 크기(칸) — 숫자가 아니면 버린다(데몬 기본 크기를 쓴다)
function cellSize(size) {
  const cols = size && size.cols | 0
  const rows = size && size.rows | 0
  return cols > 1 && rows > 1 ? { cols, rows } : {}
}
