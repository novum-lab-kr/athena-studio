// Athena Studio 메인 프로세스 — 창 · 메뉴(단축키) · 작업 창(데몬에 붙기) · 현황판 서버 · 아테나 폴더 설정
// 창마다 팩 하나 — 창마다 그 팩 본체(athenaDir) · 데몬 연결(본체로 묶임) · 현황판 · 옆 브라우저 · 모니터를 따로 갖는다(createPackWindow).
// 앱 전체에 하나인 것: 언어 · 앱 설정 · 데몬 프로세스 · 메뉴 · 메뉴 막대(Tray — 앞에 있는 창의 팩만)
const { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, session, shell } = require('electron')
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const core = require('./lib/core')
const studioHome = require('./lib/studio-home')
const packModel = require('./lib/pack')
const agentFeed = require('./lib/agent-feed')
const trayModel = require('./lib/tray-model')
const screenModel = require('./lib/screen-model')
const trayBadge = require('./lib/tray-icon')
const daemonClient = require('./daemon-client')
const explorer = require('./lib/explorer')
const fileIcons = require('./lib/file-icons')
const viewer = require('./lib/viewer')
const i18n = require('./lib/i18n')
const agentLanguage = require('./lib/agent-language')
const requestsModel = require('./lib/requests')
const workModel = require('./lib/work-model')
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
// 앱이 들고 온 아테나 코어(git 번들) — 앱 리소스 자리 하나(개발 앱은 npm start 가 레포 athena/ 에서 만든다)
const CORE_BUNDLE = studioHome.coreBundlePath({ appRoot: path.join(__dirname, '..'), packaged: app.isPackaged, resourcesPath: process.resourcesPath })
// 앱 아이콘 — 둥근 사각형 앱 아이콘(1024 · Dock · 윈도우·리눅스 창). 화면 안 로고는 화이트판(athena-logo-white.png)
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'logo', 'athena-app-icon.png')
// 창 · 빈 옆 브라우저 바탕 — renderer style.css --bg 와 같은 값
const APP_BACKGROUND = '#16171a'
// Ctrl 조합은 pane 안(셸·에이전트) 몫이라 앱 단축키는 Cmd(맥) · Alt(그 밖)로만 건다
const TAB_KEY = isMac ? 'Command' : 'Alt'

let config = null // 앱 설정(언어 · 열린 팩 창 목록 windows · 옛 현황판 포트 …)
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
  for (const window of [...[...packWindows].map((ctx) => ctx.win), trayWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('i18n:changed', i18nPayload())
  }
  if (trayWindow && trayWindow.isVisible()) sendTrayUpdate()
  for (const ctx of packWindows) syncAgentLanguage(ctx.athenaDir)
}

// 에이전트 답 언어 — 앱 언어를 본체 .claude/settings.local.json 의 language 로(lib/agent-language.js).
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

// 스튜디오 초기화(메뉴 보기) — 처음 켠 것처럼: 현황판 · 데몬(모든 pane · 에이전트)을 끄고 스튜디오 집의 코어 · 본체 · 팩 데이터 ·
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
  // 현황판은 본체가 있을 때 그 토큰으로 끈다(지운 뒤에는 끌 방법이 없다)
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

// ── 에이전트 모니터 — 기록 읽기(창마다 따로 따라간다) ───────────────
// Claude Code 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl)을 따라 읽어 화면에 이벤트로 보낸다 — 아테나 agent-monitor.py 와 같은 대상:
// 서브에이전트(<세션>/subagents/agent-*.jsonl) · 워크트리 세션 · 지금 에이전트가 도는 pane 폴더의 세션. 최근 120분 안에 바뀐 것만.
// 팩 창마다 그 본체(·그 안 .worktrees) 폴더의 세션만 — 다른 팩 본체의 세션은 그 팩 창 몫이다
// 예전 터미널 모니터 칸의 이름표 — 이미 떠 있는 pane 을 찾는 값이라 번역하지 않는다
const MONITOR_LABEL = '🛰 에이전트 모니터'
const MONITOR_MINUTES = 120
const MONITOR_BACKLOG = 5 // 처음 붙을 때 세션마다 마지막 몇 개만
const MONITOR_HEAD_BYTES = 64 * 1024 // 처음 붙을 때 파일 끝에서 이만큼만 읽는다
const MONITOR_CHUNK_BYTES = 4 * 1024 * 1024
const MONITOR_KEEP = 300
const MONITOR_TEXT_MAX = 300
const newMonitor = () => ({ watching: false, timer: null, ticking: false, lastScan: 0, lastFullScan: 0, tails: new Map(), tailSeq: 0, events: [], seq: 0, agentCwds: [], floor: 0 })

async function readDir(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function recentFile(file, since) {
  try {
    const stat = await fs.promises.stat(file)
    return stat.isFile() && stat.mtimeMs >= since ? stat : null
  } catch {
    return null
  }
}

// 이 본체의 세션 폴더인가 — 본체 자체 · 그 안 워크트리(<본체>/.worktrees/… → '<이름>--worktrees-…')
function ownProject(name, bodyName) {
  return Boolean(bodyName) && (name === bodyName || name.startsWith(`${bodyName}--`))
}

// allSessions — 부모 세션이 조용해도 서브에이전트는 오래 돌 수 있어서, 가끔(1분)은 모든 세션의 서브에이전트를 자기 수정 시각으로 본다
async function findMonitorLogs(monitor, allSessions, athenaDir) {
  const root = path.join(app.getPath('home'), '.claude', 'projects')
  const since = Math.max(Date.now() - MONITOR_MINUTES * 60000, monitor.floor)
  const wanted = new Set(monitor.agentCwds.map(agentFeed.projectDirName))
  const bodyName = athenaDir ? agentFeed.projectDirName(core.realDir(athenaDir)) : null
  const found = []
  for (const project of await readDir(root)) {
    if (!project.isDirectory()) continue
    const own = ownProject(project.name, bodyName)
    const paneSessions = wanted.has(project.name) || own
    // 이 팩과 상관없는 폴더는 서브에이전트도 보지 않는다
    if (!paneSessions) continue
    const dir = path.join(root, project.name)
    for (const entry of await readDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = path.join(dir, entry.name)
      const stat = await recentFile(file, since)
      if (stat) found.push({ file, pane: true, stat })
      // 서브에이전트 — 평소엔 최근에 움직인 세션만(모든 세션 폴더를 자주 뒤지지 않게)
      if (!stat && !allSessions) continue
      const subDir = path.join(dir, entry.name.replace(/\.jsonl$/, ''), 'subagents')
      for (const sub of await readDir(subDir)) {
        if (!sub.isFile() || !/^agent-.*\.jsonl$/.test(sub.name)) continue
        const subFile = path.join(subDir, sub.name)
        const subStat = await recentFile(subFile, since)
        if (subStat) found.push({ file: subFile, pane: false, stat: subStat })
      }
    }
  }
  return found
}

// 새로 붙은 줄들 — 줄바꿈 바이트에서 끊어 한글이 반쪽으로 잘리지 않게 한다.
// 파일이 바뀌었으면(inode) 처음 붙을 때처럼 끝부분부터, 줄바꿈 없이 너무 긴 줄은 버린다(메모리가 끝없이 늘지 않게)
const MONITOR_LINE_MAX = 1024 * 1024

async function readNewLines(tail) {
  const stat = await fs.promises.stat(tail.file)
  tail.mtime = stat.mtimeMs
  if (tail.ino !== undefined && stat.ino !== tail.ino) {
    tail.offset = Math.max(0, stat.size - MONITOR_HEAD_BYTES)
    tail.rest = Buffer.alloc(0)
    tail.skipPartial = tail.offset > 0
  } else if (stat.size < tail.offset) {
    tail.offset = 0
    tail.rest = Buffer.alloc(0)
    tail.skipPartial = false
  }
  tail.ino = stat.ino
  if (stat.size === tail.offset) return []
  const length = Math.min(stat.size - tail.offset, MONITOR_CHUNK_BYTES)
  const buffer = Buffer.alloc(length)
  const handle = await fs.promises.open(tail.file, 'r')
  let bytesRead = 0
  try {
    ;({ bytesRead } = await handle.read(buffer, 0, length, tail.offset))
  } finally {
    await handle.close()
  }
  tail.offset += bytesRead
  const combined = Buffer.concat([tail.rest, buffer.subarray(0, bytesRead)])
  const cut = combined.lastIndexOf(10)
  if (cut < 0) {
    // 줄바꿈 없이 너무 길면 그 줄은 버리고 다음 줄바꿈부터
    if (combined.length > MONITOR_LINE_MAX) {
      tail.rest = Buffer.alloc(0)
      tail.skipPartial = true
    } else {
      tail.rest = Buffer.from(combined)
    }
    return []
  }
  // 남은 조각은 복사해 둔다(큰 읽기 버퍼를 붙잡지 않게)
  tail.rest = Buffer.from(combined.subarray(cut + 1))
  let lines = combined.subarray(0, cut).toString('utf8').split('\n')
  if (tail.skipPartial) {
    lines = lines.slice(1)
    tail.skipPartial = false
  }
  return lines.filter((line) => line.trim() && line.length <= MONITOR_LINE_MAX)
}

function tailEvents(monitor, tail, lines) {
  const events = []
  for (const line of lines) {
    const record = agentFeed.parseLine(line)
    if (!record) continue
    if (!tail.label) tail.label = agentFeed.sessionLabel(record)
    for (const event of agentFeed.eventsFromRecord(record)) {
      if (event.kind === 'tool') tail.tools += 1
      // 서브에이전트는 사용자 지시 대신 아테나가 보낸 지시라 빼고, 도구 · 말만
      if (!tail.pane && event.kind === 'user') continue
      events.push({
        id: ++monitor.seq,
        session: tail.id,
        ...event,
        text: event.text.length > MONITOR_TEXT_MAX ? `${event.text.slice(0, MONITOR_TEXT_MAX)}…` : event.text,
      })
    }
  }
  return events
}

// 서브에이전트는 옆의 meta.json 으로 이름 · 끝남을 안다(없거나 깨졌으면 그냥 둔다)
async function readSubagentMeta(tail) {
  if (tail.pane) return
  try {
    const info = agentFeed.subagentInfo(JSON.parse(await fs.promises.readFile(tail.file.replace(/\.jsonl$/, '.meta.json'), 'utf8')))
    if (info.label) tail.label = info.label
    tail.finished = info.finished
  } catch {}
}

async function openTail(monitor, item) {
  const tail = { id: `s${++monitor.tailSeq}`, file: item.file, pane: item.pane, label: null, finished: false, tools: 0, mtime: item.stat.mtimeMs, offset: Math.max(0, item.stat.size - MONITOR_HEAD_BYTES), rest: Buffer.alloc(0), skipPartial: item.stat.size > MONITOR_HEAD_BYTES }
  await readSubagentMeta(tail)
  const lines = await readNewLines(tail).catch(() => [])
  const events = tailEvents(monitor, tail, lines).slice(-MONITOR_BACKLOG)
  monitor.tails.set(item.file, tail)
  return events
}

function monitorSessions(monitor) {
  return [...monitor.tails.values()]
    .sort((left, right) => right.mtime - left.mtime)
    .map((tail) => ({ id: tail.id, label: tail.label || (tail.pane ? 'pane' : 'agent'), pane: tail.pane, finished: tail.finished, tools: tail.tools, lastAt: tail.mtime }))
}

// ── 오른쪽 Explorer · 파일 뷰어 — 공용 도우미 ───────────────────────
// 읽어도 되는 곳 — 작업 공간 폴더 + 여러 팩 본체면 지금 팩 데이터(.pack-data 가 가리키는 곳).
// plans · issues · archive · repos 는 .pack-data 를 거친 링크라, 데이터 쪽을 빼면 Explorer 에 아예 안 보인다
async function explorerRoots(root) {
  const data = await fs.promises.realpath(path.join(root, '.pack-data')).catch(() => null)
  return data ? [root, data] : [root]
}

// 상대 경로를 풀어(심볼릭 링크 포함) 읽어도 되는 곳 안인지 본다
async function resolveInside(root, relative) {
  const clean = explorer.cleanRelative(relative)
  if (clean === null) throw new Error(say('error.pathUnreadable'))
  const real = await fs.promises.realpath(path.join(root, clean))
  if (!explorer.isInsideAny(await explorerRoots(root), real)) throw new Error(say('error.outsideWorkspace'))
  return { real, clean }
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: core.childEnv(process.env, { GIT_OPTIONAL_LOCKS: '0' }) }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

// VSCode 처럼 확장자에 맞는 색(Shiki · Dark+ 테마)과 줄 번호.
// Shiki 는 ESM 이라 처음 열 때 한 번 불러오고, 언어는 그 언어 파일을 처음 열 때만 불러온다
const VIEWER_THEME = 'dark-plus'
let highlighterLoading = null

function loadHighlighter() {
  if (!highlighterLoading) {
    highlighterLoading = import('shiki').then(async (shiki) => ({
      highlighter: await shiki.createHighlighter({ themes: [VIEWER_THEME], langs: [] }),
      known: new Set(Object.keys(shiki.bundledLanguages)),
    }))
    highlighterLoading.catch(() => (highlighterLoading = null)) // 실패하면 다음에 다시
  }
  return highlighterLoading
}

// 줄에 색 조각을 싣는다. 너무 크거나 실패하면 색 없이(글자는 그대로)
async function colorRows(rows, name) {
  const code = viewer.codeOf(rows)
  try {
    const { highlighter, known } = await loadHighlighter()
    const lang = viewer.languageFor(name, known)
    if (lang === 'text' || code.length > viewer.HIGHLIGHT_LIMIT) return { rows, lang }
    await highlighter.loadLanguage(lang)
    const { tokens, fg, bg } = highlighter.codeToTokens(code, { lang, theme: VIEWER_THEME })
    return { rows: viewer.attachTokens(rows, tokens), lang, fg, bg }
  } catch {
    return { rows, lang: 'text' }
  }
}

// IPC 결과 — 실패는 {error}
async function guarded(work) {
  try {
    return await work()
  } catch (error) {
    return { error: error.message }
  }
}

// ── 현황판 — 공용 도우미 ────────────────────────────────────
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

// scripts/board.sh 는 브라우저를 열므로 쓰지 않고 server.mjs 를 직접 띄운다.
// 앱을 닫아도 현황판은 계속 돈다(board.sh 의 백그라운드 실행과 같다)
// 포트 정하기 · 띄우기가 겹치지 않게 한 줄로 세운다(창이 여럿이어도 — 포트를 서로 고르다 겹치지 않게)
let boardQueue = Promise.resolve()
function queueBoard(work) {
  const run = boardQueue.then(work)
  boardQueue = run.catch(() => {})
  return run
}

// 그 포트를 쥔 프로세스가 이 아테나 폴더에서 돌면 ours, 아무도 없으면 free, 다른 폴더이거나 알아볼 수 없으면 other(쓰지 않는다).
// 맥은 lsof 로 그 프로세스의 작업 폴더를 본다
const LSOF = '/usr/sbin/lsof'

async function boardOwner(port, athenaDir) {
  const listening = await runLsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  if (listening.failed) return 'other'
  const pid = listening.stdout.split('\n').find(Boolean)
  if (!pid) return 'free'
  const where = await runLsof(['-a', '-p', pid, '-d', 'cwd', '-Fn'])
  const cwd = where.failed ? null : core.parseLsofPath(where.stdout)
  return cwd && core.sameDir(cwd, athenaDir) ? 'ours' : 'other'
}

// lsof 는 찾은 것이 없으면 종료 1 + 빈 출력이다 — 그건 '없음', 그 밖의 실패(lsof 없음 · 시간 초과 등)는 failed
function runLsof(args) {
  return new Promise((resolve) =>
    execFile(LSOF, args, { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
      const empty = !String(stdout || '').trim()
      if (error && !(error.code === 1 && empty)) return resolve({ failed: true, stdout: '' })
      resolve({ failed: false, stdout: stdout || '' })
    }),
  )
}

async function startBoard(port, athenaDir) {
  const url = core.boardUrl(port)
  const logFile = boardLogFile()
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.openSync(logFile, 'a')
  fs.writeSync(log, `\n── ${new Date().toISOString()} 현황판 시작 (포트 ${port})\n`)

  // node 가 PATH 에 없으면 Electron 을 node 로 돌린다
  const nodePath = core.findExecutable('node', process.env.PATH)
  // 현황판은 pane 밖에서 pane 목록을 묻는다 — 화면 계층이 studio 데몬을 고르게 자리를 넘긴다(S4)
  const paths = daemonPaths()
  // ATHENA_STUDIO_BODY — 현황판이 CLI 로 띄우는 pane 이 이 본체(팩) 창에 속하게(protocol 5 · pane 밖이라 부른 pane 이 없다)
  const extra = { ATHENA_BOARD_PORT: String(port), ATHENA_STUDIO_SOCKET: paths.socket, ATHENA_STUDIO_CLI: daemonClient.CLI, ATHENA_STUDIO_NODE: process.execPath, ATHENA_STUDIO_BODY: core.realDir(athenaDir) }
  if (!nodePath) extra.ELECTRON_RUN_AS_NODE = '1'
  const env = core.childEnv(process.env, extra)

  let exited = null
  try {
    const child = spawn(nodePath || process.execPath, [path.join(athenaDir, 'scripts', 'board', 'server.mjs')], {
      cwd: athenaDir,
      env,
      detached: true,
      stdio: ['ignore', log, log],
    })
    child.on('exit', (code) => (exited = code))
    child.on('error', (error) => (exited = error.message))
    child.unref()
  } catch (error) {
    return { ok: false, url, error: say('error.boardStart', { message: error.message }), log: logFile }
  } finally {
    fs.closeSync(log)
  }

  for (let i = 0; i < 40; i++) {
    if (exited !== null) break
    // 답하는 서버가 방금 띄운 이 아테나의 것인지까지 본다(그사이 다른 것이 그 포트를 잡았을 수 있다)
    if (await isBoardUp(port)) {
      if ((await boardOwner(port, athenaDir)) === 'ours') return { ok: true, url, started: true }
      return { ok: false, url, error: say('error.boardPortTaken', { port }), log: logFile }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const why = exited !== null ? say('error.boardExited', { code: exited }) : say('error.boardTimeout')
  return { ok: false, url, error: say('error.boardStartReason', { reason: why }), log: logFile }
}

// 현황판이 지금 팩 · 세대 것인지(옛 본체면 legacy — 지금처럼). 아니면 토큰으로 끄고 다시 띄운다
function boardJson(port, pathName, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathName, method, headers, timeout: 3000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(body) })
        } catch {
          resolve({ status: response.statusCode, body: null })
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve({ status: 0, body: null }))
    request.end(method === 'POST' ? '{}' : undefined)
  })
}

async function stopStaleBoard(port, athenaDir) {
  const token = await runPack(['board-token'], { dir: athenaDir })
  if (!token.ok || typeof token.token !== 'string') return false
  const origin = `http://localhost:${port}`
  await boardJson(port, '/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-board-token': token.token } })
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await isBoardUp(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

// ── 아테나 폴더 — 공용 ──────────────────────────────────────
// 새로 만드는 athena.config.json 의 reposRoot — 스튜디오 집 안 본체면 홈(회사 레포 클론 · 두 앱이 같이 쓴다), 직접 고른 폴더면 ..
const athenaReposRoot = (dir) => core.reposRootFor(dir, { studioRoot: STUDIO.root, home: app.getPath('home') })

// 스튜디오 코어 준비 — 없으면 들고 온 번들에서 ~/.athena-studio/core 로 풀고, 본체 설정(dataDir · screen) · 레지스트리 손잡이(bodiesDir · portBase)를 채운다.
// update: 이미 있던 본체면 번들이 앞일 때 업데이트(켤 때만 — 창을 열기 전, 아무 창도 본체를 쓰지 않을 때). 결과 기록은 pack.log
let coreUpdateNotice = null // 켤 때 업데이트에서 알릴 것(건너뛴 본체 · 백업 · 실패) — 첫 창이 뜬 뒤 보여 준다
// 예외(git 이 없음 · 쓰기 실패 등)도 결과로 — 켤 때 창이 안 뜨는 일이 없게
async function prepareStudioCore({ update }) {
  let result
  try {
    result = await studioHome.prepareCore({
      layout: STUDIO,
      bundle: CORE_BUNDLE,
      home: app.getPath('home'),
      update,
      runCore: (argv) => runCore(argv, { dir: STUDIO.core }),
    })
  } catch (error) {
    result = { ok: fs.existsSync(STUDIO.core), error: 'prepare-failed', message: error.message, update: null }
  }
  logCore(`prepare ${JSON.stringify({ ok: result.ok, created: result.created, error: result.error, update: result.update && { state: result.update.state, head: result.update.head, target: result.update.target, error: result.update.error } })}`)
  const updated = result.update
  if (updated && updated.summary && updated.summary.notify) coreUpdateNotice = updated
  else if (updated && ['unsupported', 'ff-failed', 'diverged', 'fetch-failed'].includes(updated.state)) coreUpdateNotice = updated
  return result
}

// 켤 때 업데이트 결과 — 일하는 본체를 건너뛰었거나 · 고친 코어 파일을 백업했거나 · 못 했으면 한 번 알린다
function showCoreUpdateNotice(parentWindow) {
  const notice = coreUpdateNotice
  coreUpdateNotice = null
  if (!notice) return
  const lines = []
  const summary = notice.summary
  if (summary) {
    if (summary.skipped.length) lines.push(say('dialog.coreUpdate.skipped', { bodies: summary.skipped.map((entry) => `${entry.id}(${entry.reason})`).join(', ') }))
    for (const entry of summary.backedUp) lines.push(say('dialog.coreUpdate.backedUp', { body: entry.id, path: entry.dir }))
    if (summary.failed.length) lines.push(say('dialog.coreUpdate.failed', { bodies: summary.failed.map((entry) => `${entry.id}(${entry.error})`).join(', ') }))
  } else {
    lines.push(say(notice.state === 'unsupported' ? 'dialog.coreUpdate.unsupported' : 'dialog.coreUpdate.notMoved', { reason: notice.error || notice.state }))
  }
  if (!lines.length) return
  lines.push(say('dialog.coreUpdate.log', { path: packLogFile() }))
  const options = { type: 'info', message: say('dialog.coreUpdate.message'), detail: lines.join('\n\n') }
  ;(parentWindow ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options)).catch(() => null)
}

// 코어를 풀지 못한 까닭 — 화면 문구로
function coreInstallError(prepared) {
  if (prepared.error === 'bundle-missing') return say('error.coreBundleMissing', { path: CORE_BUNDLE })
  return say('error.coreInstall', { message: prepared.message || prepared.file || prepared.error })
}

function logCore(line) {
  fs.mkdir(path.dirname(packLogFile()), { recursive: true }, () => fs.appendFile(packLogFile(), `\n── ${new Date().toISOString()} studio-core ${line}\n`, () => {}))
}

// ── 회사 팩 — 본체 명령(공용) ────────────────────────────────
// 팩 일은 아테나 본체가 한다 — 스튜디오는 `node scripts/athena.mjs pack … --json` 을 부르고, 기다리고, 결과를 보여 준다.
// 약속: 코어 `pack … --json` 출력(contract 3 · 코어는 athena/). 팩 파일 · 링크는 직접 만지지 않는다.
// ATHENA_STUDIO_FAKE_PACK=1 이면 본체 대신 scripts/fake-pack.js(같은 약속의 가짜)를 부른다 — 화면 확인용
// 가져오기에서 [열고 작업 되살리기] — 되살릴 팩 id. 그 팩을 연 창이 아테나를 켤 때(openAthenaAgent) 한 번 되살리고 지운다
let restoreArmedFor = null
const PACK_TIMEOUTS = { repo: 120000, 'restore-work': 300000, update: 300000, list: 20000, status: 20000, busy: 30000, use: 180000, inspect: 300000, 'import-athena': 300000, import: 180000, export: 180000, backup: 300000, delete: 300000, new: 180000, open: 180000, version: 15000, 'board-token': 15000, request: 15000 }
// 사람에게 묻는 요청 — 요청 폴더 감시를 놓칠 때를 대비해 이만큼마다 한 번 더 읽는다
const REQUESTS_POLL_MS = 30000
const packLogFile = () => path.join(app.getPath('userData'), 'pack.log')

function packScript(dir) {
  if (process.env.ATHENA_STUDIO_FAKE_PACK === '1') return path.join(__dirname, '..', 'scripts', 'fake-pack.js')
  return path.join(dir, 'scripts', 'athena.mjs')
}

// 셸을 거치지 않고 실행 · progress 줄은 그때그때 화면에 · 원문(stderr)은 화면에 넘기지 않고 pack.log 에만
// 본체 명령 — `athena.mjs <argv…> --json`. 늘 약속 번호를 알린다(ATHENA_CONTRACT — 다르면 본체가 contract-mismatch).
// dir = 그 명령을 부를 본체(창마다 다르다 — '지금 팩' 은 부른 본체의 팩)
// extraEnv — 화면 계층(데몬)을 써야 하는 명령(restore-work 가 delegate.sh 로 pane 을 띄운다)만 데몬 접속 값을 넘긴다
function runCore(argv, { dir, onProgress = null, signal = null, extraEnv = null } = {}) {
  return new Promise((resolve) => {
    if (!dir) return resolve({ ok: false, error: 'not-found', message: say('error.athenaCoreUnset') })
    const nodePath = core.findExecutable('node', process.env.PATH)
    const env = core.childEnv(process.env, { ATHENA_CONTRACT: String(packModel.CONTRACT), ...(nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' }), ...(extraEnv || {}) })
    let child
    try {
      child = spawn(nodePath || process.execPath, [packScript(dir), ...argv, '--json'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return resolve({ ok: false, error: 'bad-output', message: error.message })
    }
    let output = ''
    let rest = ''
    let errors = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(timer)
      if (errors.trim()) fs.appendFile(packLogFile(), `\n── ${new Date().toISOString()} ${argv.slice(0, 2).join(' ')}\n${errors.slice(-20000)}`, () => {})
      resolve(result)
    }
    // 시간 초과 · 취소는 SIGTERM — 본체가 임시본을 지우거나 되돌리고 끝낸다. 결과는 프로세스가 실제로 끝난 뒤에(그 전에 다음 단계로 가지 않게).
    // 15초 안에 안 끝나면 SIGKILL
    let forced = null
    const stop = (reason) => {
      if (forced) return
      forced = { ok: false, error: reason }
      child.kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 15000).unref()
    }
    // R3 — 팩을 바꾸거나 본체를 만들거나 옮기는 명령(use · new · open · import --replace · update)은 시간이 넘어도 끄지 않는다(중간에 끊으면 반쯤 바뀐다). "오래 걸려요" 만 알리고 기다린다
    const sub = argv[0] === 'pack' ? argv[1] : argv[0] // 시간 초과는 pack 하위 명령(또는 version 같은 최상위 명령) 이름으로
    // restore-work 도 — 워크트리를 만들고 pane 을 띄우는 중에 끊으면 반쯤 된다
    const changesPack = ['use', 'new', 'open', 'update', 'restore-work', 'delete'].includes(sub) || (sub === 'import' && argv.includes('--replace'))
    const slow = () => onProgress && onProgress({ step: 'slow', text: say('pack.step.slow') })
    const timer = changesPack ? setInterval(slow, PACK_TIMEOUTS[sub] || 60000) : setTimeout(() => stop('timeout'), PACK_TIMEOUTS[sub] || 60000)
    if (signal) signal.addEventListener('abort', () => stop('canceled'), { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      const split = packModel.splitLines(rest, chunk)
      rest = split.rest
      for (const line of split.lines) {
        const step = packModel.parseProgressLine(line, say)
        // 본체 설명은 한국어(번역 범위 밖) — 한국어가 아니면 아는 단계는 사전 이름으로 보인다
        if (step && language !== i18n.FALLBACK_LANGUAGE) step.text = packModel.stepLabel(step.step, say) || step.text
        if (step && onProgress) onProgress(step)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => (errors += chunk))
    child.on('error', (error) => finish({ ok: false, error: 'bad-output', message: error.message }))
    child.on('close', () => {
      const parsed = packModel.parsePackOutput(output, say)
      if (!forced && parsed.result.error === 'bad-output' && parsed.raw) errors += `\n[JSON 이 아닌 마지막 줄] ${parsed.raw}`
      finish(forced || parsed.result)
    })
  })
}

const runPack = (args, options) => runCore(['pack', ...args], options)

// 본체의 약속 번호 — `version --json`. 명령이 없으면(옛 코어 · 사용법 오류) 1 · 일시 실패면 null.
// 본체를 업데이트하면 바뀌므로 기억하지 않고 부를 때마다 묻는다(팩을 열거나 만들거나 가져올 때만 — 가볍다)
async function coreContract(dir) {
  if (!dir) return { contract: null, core: null }
  return packModel.contractOf(await runCore(['version'], { dir }))
}

// 옛 코어(약속 1 · version 명령 없음)면 팩을 열거나 · 만들거나 · 가져오는 일은 막고 업데이트를 안내한다.
// 본체를 바꾸는 명령보다 **먼저** 부른다
async function contractBlock(dir) {
  const known = await coreContract(dir)
  if (known.contract === packModel.CONTRACT) return null
  if (known.contract === null) return { ok: false, error: 'contract-unknown', text: say('pack.contract.unknown') } // 확인 못 함 — 옛 코어라고 단정하지 않는다
  // 본체 약속이 낮으면 본체 업데이트 안내 · 높으면 스튜디오 업데이트 안내
  return { ok: false, error: 'contract-mismatch', contract: known.contract, text: say(known.contract < packModel.CONTRACT ? 'pack.contract.old' : 'pack.contract.other', { contract: known.contract }) }
}

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
  let packBoardPort = null // 이 본체 현황판 포트(pack status) — 옛 본체면 null(앱 설정 boardPort)
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
  // spaces 레포 줄 우클릭 — 고른 동작 이름(remove-repo · close-workspace · null)
  ctx.spaceContextMenu = ({ repo = null, workspace = null } = {}, point = null) => new Promise((resolve) => {
    let chosen = null
    const pick = (action) => () => {
      chosen = action
      resolve(action)
    }
    const items = []
    if (workspace) items.push({ label: say('spaces.menu.closeWorkspace'), click: pick('close-workspace') })
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

  // 보일 때만(startPanesPolling 이 2초마다 부른다) pane 목록(에이전트가 도는 폴더 → 모니터)과 작업 공간 브랜치를 갱신한다
  ctx.pollPanes = async () => {
    if (!ctx.win || ctx.win.isDestroyed() || !ctx.win.isVisible() || ctx.win.isMinimized() || !daemon) return
    const listed = await daemonCall('pane list')
    if (listed.result) {
      monitor.agentCwds = listed.result.panes.filter((pane) => pane.agent).map((pane) => pane.foreground_cwd || pane.cwd).filter(Boolean)
      // spaces pane 줄 앞 점 — 에이전트가 없는 pane 은 null
      send('screen:pane-status', Object.fromEntries(listed.result.panes.map((pane) => [pane.id, pane.agent ? pane.agent_status : null])))
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

  // ── 오른쪽 Explorer ──
  // 화면은 파일에 손대지 않는다 — main 이 읽어 준다. 루트는 화면이 준 경로가 아니라 데몬 상태(이 창 본체)의 작업 공간 폴더다
  async function workspaceRoot(workspaceId) {
    const state = await daemonCall('state')
    const workspace = state.result && state.result.workspaces.find((entry) => entry.id === String(workspaceId))
    if (!workspace) throw new Error(say('error.workspaceMissing'))
    return fs.promises.realpath(workspace.cwd)
  }

  ctx.explorerList = async (workspaceId, relative) => {
    const root = await workspaceRoot(workspaceId)
    const { real, clean } = await resolveInside(root, relative)
    const roots = await explorerRoots(root)
    const dirents = await fs.promises.readdir(real, { withFileTypes: true })
    const entries = await Promise.all(
      dirents.map(async (dirent) => {
        let dir = dirent.isDirectory()
        if (dirent.isSymbolicLink()) {
          // 읽어도 되는 곳 밖을 가리키는 링크는 열 수 없으니 목록에서 뺀다(끊긴 링크는 그대로 둔다)
          const target = await fs.promises.realpath(path.join(real, dirent.name)).catch(() => null)
          if (target && !explorer.isInsideAny(roots, target)) return null
          dir = await fs.promises.stat(path.join(real, dirent.name)).then((stat) => stat.isDirectory(), () => false)
        }
        return { name: dirent.name, dir, ...fileIcons.iconFor(fileIcons.loadManifest(), dirent.name, dir) }
      }),
    )
    const shown = entries.filter(Boolean)
    // 팩 본체면 맨 위는 팩 내용만(코어 · 본체 설정은 사용자가 볼 것이 아니다)
    return { entries: explorer.sortEntries(clean === '.' && roots.length > 1 ? explorer.packBodyEntries(shown) : shown) }
  }

  // 작업 공간 폴더 기준 git 변경. git 레포가 아니면 git: false
  ctx.explorerStatus = async (workspaceId) => {
    const root = await workspaceRoot(workspaceId)
    const top = await runGit(root, ['rev-parse', '--show-toplevel'])
    if (top === null) return { git: false, changes: [] }
    const prefix = path.relative(await fs.promises.realpath(top.trim()), root)
    // 새 폴더는 한 줄(`dir/`)로 — 안의 파일을 다 세면 .omc/ 같은 폴더 하나로 수백 줄이 된다(git 기본과 같다)
    const output = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    if (output === null) return { git: true, changes: [] }
    const all = explorer.relativeToWorkspace(explorer.parseGitStatus(output), prefix.split(path.sep).join('/'))
    // 팩 본체의 git 은 코어 레포다 — 코어 변경은 빼고 팩 내용 쪽만
    const changes = (await explorerRoots(root)).length > 1 ? explorer.packBodyChanges(all) : all
    // 변경 목록에도 아이콘 — 새 폴더(`dir/`)는 폴더 아이콘
    const manifest = fileIcons.loadManifest()
    return {
      git: true,
      changes: changes.map((change) => ({ ...change, ...fileIcons.iconFor(manifest, change.path.split('/').filter(Boolean).pop(), change.path.endsWith('/')) })),
    }
  }

  // 미리보기 — 이미지는 그림, 바뀐 파일은 diff(옛·새 줄 번호), 그 밖은 내용(앞 512KB). 바이너리는 안내만
  ctx.explorerOpen = async (workspaceId, relative) => {
    const root = await workspaceRoot(workspaceId)
    const { real, clean } = await resolveInside(root, relative)
    const stat = await fs.promises.stat(real)
    if (!stat.isFile()) throw new Error(say('error.notFile'))
    const image = viewer.imageType(clean)
    if (image) {
      if (stat.size > viewer.IMAGE_LIMIT) return { kind: 'binary', path: clean, size: stat.size }
      const data = await fs.promises.readFile(real)
      return { kind: 'image', path: clean, src: `data:${image};base64,${data.toString('base64')}`, size: stat.size }
    }
    const status = await runGit(root, ['status', '--porcelain=v1', '-z', '--', clean])
    const tracked = status && status.length > 3 && !status.startsWith('??')
    if (tracked) {
      const diff = await runGit(root, ['diff', 'HEAD', '--', clean])
      if (diff) {
        const colored = await colorRows(viewer.diffRows(diff.slice(0, explorer.PREVIEW_LIMIT)), clean)
        return { kind: 'diff', path: clean, ...colored, truncated: diff.length > explorer.PREVIEW_LIMIT }
      }
    }
    const handle = await fs.promises.open(real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, explorer.PREVIEW_LIMIT))
      await handle.read(buffer, 0, buffer.length, 0)
      if (explorer.looksBinary(buffer)) return { kind: 'binary', path: clean, size: stat.size }
      const colored = await colorRows(viewer.fileRows(buffer.toString('utf8')), clean)
      return { kind: 'file', path: clean, ...colored, truncated: stat.size > explorer.PREVIEW_LIMIT, untracked: Boolean(status && status.startsWith('??')) }
    } finally {
      await handle.close()
    }
  }

  // ── 아테나 에이전트 ──
  // athena 작업 공간(이 창의 아테나 폴더)이 있으면 그리로 옮기기만 하고, 없으면 만들어 묻지 않고 claude(없으면 codex)를 켠다
  // keepView — 팩을 바꿔 돌아왔을 때: 이미 있으면 옮기지 않는다(그 본체에서 보던 자리 그대로)
  ctx.openAthenaAgent = async (size, { keepView = false } = {}) => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return { skipped: true }
    const state = await daemonCall('state')
    if (state.error) return { error: state.error }
    const existing = core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir)
    // 백업에서 되살리기로 열었으면 — 워크트리 · 대화 기록 · 에이전트 pane 을 먼저 되살리고, 아테나는 그 대화로 잇는다
    const restore = ctx.restoreForPack ? await ctx.packRestore() : null
    const athenaSessions = (restore && restore.athena) || []
    if (existing && athenaSessions.length) await resumeAthenaBeside(existing, athenaSessions)
    if (existing && keepView) return { existing: true, restore }
    if (existing) {
      await daemonCall('workspace select', { workspace: existing.id })
      return { focused: true, restore }
    }
    const decision = core.agentDecision(core.availableAgents(process.env.PATH))
    const created = await daemonCall('workspace create', { label: core.ATHENA_WORKSPACE, cwd: ctx.athenaDir, focus: true, ...size })
    if (created.error) return { error: say('error.athenaWorkspaceCreate', { message: created.error }) }
    if (decision.none) return { error: say('error.agentNotInstalled') }
    // 되살린 아테나 대화가 있으면 첫 것을 이 pane 에서 잇는다(claude 만 — 세션 id 는 코어가 모양을 본 값)
    const [first, ...rest] = decision.agent === 'claude' ? athenaSessions : []
    const text = first ? core.resumeCommand(first.session) : decision.agent
    const run = await daemonCall('pane run', { pane: created.result.root_pane.id, text })
    if (run.error) return { error: say('error.agentStart', { agent: decision.agent }) }
    if (first) await ackRestore([first.session])
    if (rest.length) await resumeAthenaBeside({ id: created.result.workspace.id }, rest)
    return { started: decision.agent, restore }
  }

  // 아테나 작업 공간이 이미 있으면 — 되살린 아테나 대화마다 첫 pane 옆에 pane 을 하나 쪼개 잇는다
  async function resumeAthenaBeside(workspace, sessions) {
    const state = await daemonCall('state')
    const tab = state.result && state.result.tabs.find((entry) => entry.workspace === workspace.id)
    const base = tab && layout.paneIds(tab.tree)[0]
    if (!base) return
    for (const item of sessions) {
      const split = await daemonCall('pane split', { target: base, direction: 'right', ratio: 0.5, cwd: ctx.athenaDir, focus: false })
      const run = split.result && split.result.pane ? await daemonCall('pane run', { pane: split.result.pane.id, text: core.resumeCommand(item.session) }) : null
      if (run && !run.error) await ackRestore([item.session])
    }
  }
  // 아테나 대화를 pane 에서 켰다고 코어에 알린다 — 그 전에는 되살리기 정보를 지우지 않는다
  const ackRestore = (sessions) => runPack(['restore-work', ...sessions.flatMap((session) => ['--ack', session])], { dir: ctx.athenaDir })

  // ── 팩 레포 — spaces 에 에이전트 없는 레포도 흐리게 · 누르면 아테나에게 /call ──
  // 레포 목록은 이 본체 팩의 pack.json(여러 팩이면 pack 링크) · 이어졌는지는 본체 repos/<이름> 이 git 레포인지
  ctx.packRepos = async () => {
    const pack = await fs.promises.readFile(path.join(ctx.athenaDir || '', 'pack', 'pack.json'), 'utf8').then(JSON.parse, () => null)
    if (!pack || !Array.isArray(pack.repos)) return []
    return pack.repos
      .filter((repo) => repo && /^[\w.-]+$/.test(String(repo.name || '')))
      .map((repo) => ({ name: repo.name, agent: packModel.repoAgent(repo), linked: fs.existsSync(path.join(ctx.athenaDir, 'repos', repo.name, '.git')) }))
  }
  // ⚙ 설정 — 이 창 본체 팩의 레포별 자동 머지. 읽기는 pack.json 을 바로(packRepos 와 같은 자리), 쓰기는 코어 명령(pack set-auto-merge)으로만.
  // 현황판 · pr-auto 는 확인할 때마다 pack.json 을 새로 읽으므로 따로 알리지 않는다
  ctx.mergeSettings = async () => {
    // 읽기 실패 · 망가진 JSON 모두 null — 팝업이 '읽지 못했어요' 를 보이게(then 의 두 번째 인자는 JSON.parse 오류를 못 잡는다)
    const pack = await fs.promises.readFile(path.join(ctx.athenaDir || '', 'pack', 'pack.json'), 'utf8').then(JSON.parse).catch(() => null)
    return { ok: Boolean(pack), repos: packModel.mergeSettings(pack) }
  }
  ctx.setAutoMerge = async (repo, { autoMerge, confirm }) => {
    if (!/^[\w.-]+$/.test(repo)) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    const args = ['set-auto-merge', repo]
    if (typeof autoMerge === 'boolean') args.push('--auto', autoMerge ? 'on' : 'off')
    if (typeof confirm === 'boolean') args.push('--confirm', confirm ? 'on' : 'off')
    const result = await runPack(args, { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }
  // 데몬 접속 값 — 본체 스크립트(delegate.sh)가 화면 계층으로 pane 을 띄울 때(현황판과 같은 값 + studio · pane 안 표시)
  ctx.studioEnv = () => {
    const paths = daemonPaths()
    return { ATHENA_SCREEN: 'studio', ATHENA_STUDIO: '1', ATHENA_STUDIO_SOCKET: paths.socket, ATHENA_STUDIO_CLI: daemonClient.CLI, ATHENA_STUDIO_NODE: process.execPath, ATHENA_STUDIO_BODY: core.realDir(ctx.athenaDir) }
  }
  // 본체 스크립트 하나 — 셸을 거치지 않고 인자로만
  const runBodyScript = (script, args, { studioEnv = false, timeout = 120000 } = {}) => new Promise((resolve) => {
    const env = core.childEnv(process.env, studioEnv ? ctx.studioEnv() : {})
    execFile('bash', [path.join(ctx.athenaDir, 'scripts', script), ...args], { cwd: ctx.athenaDir, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', code: error ? error.code : 0 }),
    )
  })
  // 레포 에이전트 부르기 1 — 브랜치 정보(scripts/call-branch-info.sh — /call 스킬과 같은 것): 메인 체크아웃 상태 · 최근 작업 브랜치 · main 직접이면 그 자리
  ctx.callInfo = async (name) => {
    const repo = (await ctx.packRepos()).find((item) => item.name === name)
    if (!repo || !repo.agent) return { error: say('spaces.callNoAgent', { repo: name }) }
    const run = await runBodyScript('call-branch-info.sh', [repo.agent])
    if (!run.ok) return { error: (run.stderr || run.stdout).trim().slice(-300) || say('spaces.callFailed') }
    return { agent: repo.agent, repo: name, ...packModel.parseCallInfo(run.stdout) }
  }
  // 레포 에이전트 부르기 2 — 고른 브랜치로 워크트리(new-branch.sh · 이어 쓰기면 --reuse) → 그 자리에 에이전트 pane(delegate.sh · 빈 지시 경량 계획서)
  ctx.callStart = async (name, { branch = '', reuse = false } = {}) => {
    const info = await ctx.callInfo(name)
    if (info.error) return info
    let worktree = info.direct || ''
    if (!worktree) {
      if (!packModel.validBranchInput(branch)) return { error: say('spaces.callBadBranch') }
      const made = await runBodyScript('new-branch.sh', [branch, info.target, ...(reuse ? ['--reuse'] : [])])
      const parsed = packModel.parseNewBranch(made.stdout)
      if (parsed.exists) return { exists: true, branch, message: parsed.message }
      if (!parsed.worktree) return { error: (parsed.message || made.stderr || made.stdout).trim().slice(-300) || say('spaces.callFailed') }
      worktree = parsed.worktree
    }
    const run = await runBodyScript('delegate.sh', [info.agent, '--cwd', worktree, '--plan', 'new', say('spaces.callPlanTitle', { agent: info.agent })], { studioEnv: true })
    if (!run.ok) return { error: (run.stdout + run.stderr).trim().slice(-300) || say('spaces.callFailed') }
    const pane = (run.stdout.match(/^(\S+)\s+\(/m) || [])[1] || null
    return { ok: true, agent: info.agent, pane, worktree, branch: info.direct ? null : branch }
  }

  // ── 백업에서 되살리기 ──
  // 코어 pack restore-work(본체에서) — 워크트리(미커밋 변경 · push 안 한 커밋) → 대화 기록 → 에이전트 pane(delegate.sh --resume).
  // 에이전트 pane 을 띄우니 데몬 접속 값을 넘긴다(현황판과 같은 값 + 화면 계층 studio). 결과의 athena[] 는 위 openAthenaAgent 가 잇는다
  ctx.restoreStatus = () => runPack(['restore-work', '--dry-run'], { dir: ctx.athenaDir })
  ctx.packRestore = async ({ discard = false } = {}) => {
    restoreArmedFor = null
    ctx.restoreForPack = null
    if (discard) return runPack(['restore-work', '--discard'], { dir: ctx.athenaDir })
    // ATHENA_STUDIO=1 — delegate.sh 가 화면 계층 안인지(screen inside) 본다
    const extraEnv = ctx.studioEnv()
    const result = await ctx.packTask(say('pack.task.restore'), () => runPack(['restore-work'], { dir: ctx.athenaDir, onProgress: ctx.packProgress, extraEnv }))
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }
  // 지금 창의 팩에 바로(가져오기로 지금 팩을 바꾼 뒤) — 아테나 대화는 아테나 작업 공간 옆에서 잇는다
  ctx.restoreNow = async () => {
    const result = await ctx.packRestore()
    if (!result.ok || !(result.athena || []).length) return result
    const state = await daemonCall('state')
    const existing = state.result && core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir)
    if (existing) await resumeAthenaBeside(existing, result.athena)
    return result
  }

  // ── 현황판 ──
  // 지금 현황판 포트 — 팩 지원 본체면 본체가 정한 값(pack status · 본체마다 다르다), 옛 본체면 앱 설정
  const boardPortNow = () => packBoardPort || config.boardPort
  ctx.boardPortNow = boardPortNow

  // 현황판을 띄우거나(이미 떠 있으면 그대로) 기본 브라우저로 연다 — 못 열면 이 창에 알린다
  ctx.openBoardExternal = async () => {
    const result = await ctx.ensureBoard()
    if (result.ok) {
      await shell.openExternal(result.url)
      return { ok: true }
    }
    const detail = [result.error, result.log && say('board.logLine', { log: result.log })].filter(Boolean).join('\n')
    const options = { type: 'warning', message: say('board.openFailed'), detail }
    if (ctx.win && !ctx.win.isDestroyed()) dialog.showMessageBox(ctx.win, options)
    else dialog.showMessageBox(options)
    return { ok: false }
  }

  ctx.ensureBoard = () => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return Promise.resolve({ ok: false, url: core.boardUrl(boardPortNow()), error: say('error.athenaDirMissing') })
    return queueBoard(() => findOrStartBoard(ctx.athenaDir))
  }

  // ── 사람에게 묻는 요청 · [작업] 팝업 데이터 ──
  // 요청은 코어 명령(request list)으로 읽는다 — 현황판이 꺼져 있어도 센다. 요청 폴더(팩 데이터 state/requests · 옛 구조 .requests)가
  // 바뀌면 바로, 놓칠 때를 대비해 REQUESTS_POLL_MS 마다. request 명령이 없는 옛 코어면 supported:false(요청 없음)
  let requestsState = { supported: false, requests: [] }
  let requestsWatch = null
  let requestsTimer = null
  let requestsKick = null
  let requestsBusy = null
  let requestsAgain = false
  ctx.refreshRequests = async () => {
    if (requestsBusy) {
      requestsAgain = true
      return requestsBusy
    }
    const dir = ctx.athenaDir
    if (!core.checkAthenaDir(dir).ok) return requestsState
    requestsBusy = (async () => {
      const next = requestsModel.normalizeRequests(await runCore(['request', 'list'], { dir }))
      // 그새 팩을 바꿨거나 일시 실패(잠금 · 시간 초과)면 지난 목록을 그대로 둔다
      if (dir !== ctx.athenaDir || (next.error && next.supported)) return requestsState
      const changed = next.supported !== requestsState.supported || JSON.stringify(next.requests) !== JSON.stringify(requestsState.requests)
      requestsState = { supported: next.supported, requests: next.requests }
      if (changed) {
        send('work:requests', requestsState)
        trayRequestsChanged(ctx)
      }
      return requestsState
    })()
    try {
      return await requestsBusy
    } finally {
      requestsBusy = null
      if (requestsAgain) {
        requestsAgain = false
        ctx.refreshRequests()
      }
    }
  }
  // 요청 폴더 감시 — 폴더는 첫 요청이 생길 때 만들어지므로, 없으면 주기마다 다시 걸어 본다
  const watchRequestsDir = () => {
    if (requestsWatch || !ctx.athenaDir) return
    for (const dir of [path.join(ctx.athenaDir, '.pack-data', 'state', 'requests'), path.join(ctx.athenaDir, '.requests')]) {
      try {
        requestsWatch = fs.watch(fs.realpathSync(dir), () => {
          clearTimeout(requestsKick)
          requestsKick = setTimeout(() => ctx.refreshRequests(), 300)
        })
        requestsWatch.on('error', () => {
          if (requestsWatch) requestsWatch.close()
          requestsWatch = null
        })
        return
      } catch {}
    }
  }
  ctx.requestsNow = () => requestsState
  ctx.stopRequests = () => {
    if (requestsWatch) requestsWatch.close()
    requestsWatch = null
    clearInterval(requestsTimer)
    clearTimeout(requestsKick)
  }
  // 창이 본체를 열 때 · 다른 팩으로 다시 묶을 때 — 지난 팩의 요청은 지우고 새로 읽는다
  ctx.watchRequests = () => {
    ctx.stopRequests()
    requestsState = { supported: false, requests: [] }
    send('work:requests', requestsState)
    if (!ctx.athenaDir) return
    watchRequestsDir()
    requestsTimer = setInterval(() => {
      watchRequestsDir()
      ctx.refreshRequests()
    }, REQUESTS_POLL_MS)
    ctx.refreshRequests()
  }

  // [작업] 팝업 — 현황판을 띄우고(이미 떠 있으면 그대로) 카드를 읽어 목록으로. 요청은 그때 한 번 더 읽는다
  ctx.workState = async () => {
    const board = await ctx.ensureBoard()
    const state = board.ok ? await fetchBoardJson(boardPortNow(), '/api/state') : null
    const requests = await ctx.refreshRequests()
    return {
      supported: requests.supported,
      requests: requests.requests.map((request) => ({ ...request, waited: requestsModel.waitedLabel(request.createdAt, Date.now(), say) })),
      boardUp: Boolean(state),
      boardError: board.ok ? null : board.error || null,
      ...workModel.workList(state && Array.isArray(state.cards) ? state.cards : [], requests.requests),
    }
  }
  // 답을 그 pane 에 한 줄로 넣는다 — 에이전트는 [요청 <id>] 를 보고 ack 한다. pane 이 지금 없으면 false(답은 저장돼 있다 · 다시 보내기)
  const deliverToPane = async (paneId, line) => {
    if (!paneId) return false
    const listed = await ctx.peekCall('pane list')
    const panes = listed.result && Array.isArray(listed.result.panes) ? listed.result.panes : []
    if (!panes.some((pane) => pane.id === paneId)) return false
    ctx.notifyDaemon('input', { pane: paneId, data: line })
    // 입력창이 붙여 넣은 글을 받은 뒤에 Enter — 같이 보내면 줄바꿈으로 들어가는 에이전트가 있다
    await new Promise((resolve) => setTimeout(resolve, 150))
    ctx.notifyDaemon('input', { pane: paneId, data: '\r' })
    return true
  }
  // 앱에서 답하기 — 코어에 답을 적고(본 rev 그대로 — 그사이 바뀌었으면 conflict) 그 pane 에 넣는다
  ctx.answerRequest = async (id, answer) => {
    const known = requestsState.requests.find((request) => request.id === id)
    if (!known) return { ok: false, error: 'not-found' }
    const result = await runCore(requestsModel.answerArgs(id, { choice: answer && answer.choice, text: answer && answer.text, rev: known.rev }), { dir: ctx.athenaDir })
    if (!result.ok || !result.request) {
      ctx.refreshRequests()
      return { ok: false, error: result.error || 'failed', message: result.message || '' }
    }
    const delivered = await deliverToPane(known.pane, requestsModel.deliveryLine(known, result.request.answer || {}))
    ctx.refreshRequests()
    return { ok: true, delivered }
  }
  // 답은 했는데 전달 못 한 것(answered) — 다시 보내기
  ctx.redeliverRequest = async (id) => {
    const known = requestsState.requests.find((request) => request.id === id && request.state === 'answered')
    if (!known || !known.answer) return { ok: false, error: 'not-found' }
    return { ok: true, delivered: await deliverToPane(known.pane, requestsModel.deliveryLine(known, known.answer)) }
  }
  // 계획서 열기 — 결정 콘솔(html)이 있으면 현황판 주소로 브라우저에, 없으면 md 를 기본 앱으로
  ctx.openPlan = async (id, html) => {
    const safe = (value, ext) => typeof value === 'string' && value.startsWith('plans/') && value.endsWith(ext) && !value.split('/').includes('..')
    if (safe(html, '.html')) {
      const board = await ctx.ensureBoard()
      if (board.ok) return shell.openExternal(`${board.url.replace(/\/$/, '')}/${html.split('/').map(encodeURIComponent).join('/')}`)
    }
    if (safe(id, '.md') && ctx.athenaDir) return shell.openPath(path.join(ctx.athenaDir, id))
    return null
  }
  // 현황판 페이지(칸반 · QA · 학습 · 지표 · 아카이브) — 현황판 탭 이름을 주소 끝 #<탭> 으로
  const BOARD_SECTIONS = ['now', 'qa', 'learn', 'metrics', 'history']
  ctx.openBoardSection = async (section) => {
    const result = await ctx.ensureBoard()
    if (!result.ok) return ctx.openBoardExternal()
    return shell.openExternal(`${result.url.replace(/\/$/, '')}/${BOARD_SECTIONS.includes(section) && section !== 'now' ? `#${section}` : ''}`)
  }
  // 다이어그램 목록 — 이 창 본체의 docs/diagrams/index.html 을 기본 앱으로(/guide 그림 과 같은 파일 · 같은 방식). 없으면 missing
  ctx.openDiagrams = async () => {
    if (!ctx.athenaDir) return { ok: false, error: 'missing' }
    const file = path.join(ctx.athenaDir, 'docs', 'diagrams', 'index.html')
    if (!fs.existsSync(file)) return { ok: false, error: 'missing' }
    const failure = await shell.openPath(file)
    return failure ? { ok: false, error: 'failed', message: failure } : { ok: true }
  }

  // 작업 상세 — 계획서 원문(현황판 /api/card)에서 몇 줄만. plans/ 안의 .md 만
  ctx.workDetail = async (id) => {
    if (!/^plans\/[^\0]+\.md$/.test(id) || id.split('/').includes('..')) return { ok: false, error: 'bad-id' }
    const card = await fetchBoardJson(boardPortNow(), `/api/card?id=${encodeURIComponent(id)}`)
    if (!card || typeof card.text !== 'string') return { ok: false, error: 'not-found' }
    return { ok: true, id, ...workModel.planDetail(card.text) }
  }

  // 현황판은 띄우지 않고 포트만 미리 정해 적는다(창을 열 때 · 아테나 폴더를 정할 때) — 현황판 탭을 열기 전에도 아테나가 콘솔을 맞는 포트로 띄우게.
  // 팩 지원 본체면 포트는 본체가 정하니 읽기만 하고 본체 설정에 쓰지 않는다(setAthenaBoardPort 는 옛 본체에서만)
  ctx.prepareBoardPort = () => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return
    const dir = ctx.athenaDir
    queueBoard(async () => {
      if (await refreshPackStatus(dir)) return null
      return findBoardPort(dir)
    }).catch(() => {})
  }

  // 옛 본체 — 저장된 포트부터 차례로. 이 아테나 폴더에서 도는 현황판이면 그대로 쓰고, 비었으면 거기 띄우고, 다른 것이 쥐고 있으면 다음 번호
  async function findBoardPort(dir) {
    const ports = core.boardPortCandidates(config.boardPort)
    for (const port of ports) {
      const owner = await boardOwner(port, dir)
      if (owner === 'other') continue
      // 찾는 사이 아테나 폴더가 바뀌었으면 이 결과는 버린다
      if (ctx.athenaDir !== dir) return { error: say('error.athenaDirChanged') }
      const saved = rememberBoardPort(port, dir)
      if (saved.error) return saved
      return { port, owner }
    }
    return { error: say('error.boardPortsBusy', { from: ports[0], to: ports[ports.length - 1] }) }
  }

  async function findOrStartBoard(dir) {
    const result = await findOrStartBoardFor(dir)
    // 띄우거나 기다리는 사이 아테나 폴더가 바뀌었으면 예전 폴더의 현황판을 보여 주지 않는다
    if (ctx.athenaDir !== dir) return { ok: false, url: core.boardUrl(boardPortNow()), error: say('error.athenaDirChangedReload', { key: reloadKey() }) }
    return result
  }

  // 팩 지원 본체인지 · 현황판 포트 — pack status(가볍다). 옛 본체면 null
  async function refreshPackStatus(dir) {
    const status = await runPack(['status'], { dir })
    packBoardPort = packModel.statusBoardPort(status)
    // current 도 같이 — 현황판 판단은 방금 읽은 이 값으로(목록을 못 읽었거나 시작 직후에도 멀쩡한 현황판을 끄지 않게)
    return packBoardPort ? { boardPort: packBoardPort, current: status.current || null } : null
  }

  // 팩 지원 본체의 현황판 — 포트는 본체가 정한다(본체 하나에 현황판 하나). 떠 있는 현황판이 이 본체 팩 · 세대 것이면
  // 누가 띄웠든(board.sh · 스튜디오) 같이 쓰고, 다른 팩 것이면 토큰으로 끄고 다시 띄운다. 그 포트를 현황판이 아닌 것이 쥐고 있으면 오류
  async function packBoard(port, dir, current) {
    const url = core.boardUrl(port)
    if (await isBoardUp(port)) {
      const reply = await boardJson(port, '/api/state')
      if (reply.status !== 200 || !reply.body) return { ok: false, url, error: say('error.boardStateUnreadable', { port, key: reloadKey() }) }
      if (packModel.boardIdentity(reply.body, current) !== 'stale') return { ok: true, url, started: false }
      if (await stopStaleBoard(port, dir)) return startBoard(port, dir)
      return { ok: false, url, error: say('error.boardStaleStopFailed', { port }) }
    }
    if ((await boardOwner(port, dir)) === 'free') return startBoard(port, dir)
    return { ok: false, url, error: say('error.boardPortBusyCore', { port }) }
  }

  async function findOrStartBoardFor(dir) {
    const status = await refreshPackStatus(dir)
    if (status) return packBoard(status.boardPort, dir, status.current)
    // 옛 본체 — 지금까지처럼 앱 설정 boardPort 부터 비어 있는 포트를 골라 적는다
    const found = await findBoardPort(dir)
    if (found.error) return { ok: false, url: core.boardUrl(config.boardPort), error: found.error }
    if (found.owner === 'free') return startBoard(found.port, dir)
    const url = core.boardUrl(found.port)
    if (await isBoardUp(found.port)) return { ok: true, url, started: false }
    return { ok: false, url, error: say('error.boardNoAnswer', { port: found.port }) }
  }

  // 아테나 설정에 먼저 적고, 되면 앱 설정에 — 둘이 다른 포트를 가리키지 않게(옛 본체만)
  function rememberBoardPort(port, dir) {
    try {
      core.setAthenaBoardPort(dir, port)
    } catch (error) {
      return { error: say('error.boardPortSave', { message: error.message }) }
    }
    if (config.boardPort !== port) {
      config = { ...config, boardPort: port }
      core.saveConfig(configFile(), config)
    }
    return {}
  }

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
  // 작업 공간 · 현황판 포트 · 옆 브라우저 · 에이전트 모니터 · 팩 상태가 새 본체 것으로
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
    if (tray) pollTray()
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
      // 열린 창의 팩을 바꿨으면 그 창 현황판을 새로
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
  ctx.packIcon = async (id) => {
    const iconPath = packModel.packIconPath(ctx.packState, id)
    if (!iconPath) return { dataUrl: null }
    try {
      const stat = await fs.promises.stat(iconPath)
      if (!stat.isFile() || stat.size > packModel.ICON_MAX_BYTES) return { dataUrl: null }
      const bytes = await fs.promises.readFile(iconPath)
      const mime = packModel.iconMime(bytes.subarray(0, 12))
      return { dataUrl: mime ? `data:${mime};base64,${bytes.toString('base64')}` : null }
    } catch {
      return { dataUrl: null }
    }
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
  ctx.packPickIcon = async () => {
    ctx.pickedIcon = null
    const picked = await dialog.showOpenDialog(ctx.win, {
      title: say('pack.icon.title'),
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
  // 작업 창 · 현황판 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그리고(아무 사이트 · 로그인 쿠키 유지 — 창끼리 같은 저장소),
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
    // 현황판은 창을 앞으로 가져오지 않고 기본 브라우저로 — 화면(시작 화면이면 열지 않음)이 정한다
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
    if (tray) pollTray() // 메뉴 막대는 앞 창의 팩만 — 창을 바꾸면 바로 다시 읽는다
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

// ── 메뉴 막대(Tray) — 앞에 있는 창의 팩만 ───────────────────
// 맥 상단 메뉴 막대 아이콘 — 누르면 확인 필요 · 에이전트 · 사용량 · 바로가기. 막힘 · 응답 끝 · 리뷰 대기 · 완료는 맥 알림.
// 창이 숨어 있어도 4초마다 pane 목록, 15초마다 현황판 상태(/api/state — 현황판을 띄우지는 않는다)를 본다.
// 알림 문구에는 이름 · 작업 공간 · 계획서 제목만(명령 · 지시 내용은 넣지 않는다)
const TRAY_ICON_DIR = path.join(__dirname, 'renderer', 'assets', 'logo')
const trayState = { ctx: null, panes: [], workspaces: [], focused: null, boardOkAt: 0, cards: null, usage: [], waitMs: null, metricsAt: 0, boardUp: false, boardAt: 0, pausedUntil: 0, polling: false }
let trayNotifier = new trayModel.Notifier()
let tray = null
let trayWindow = null
const TRAY_WIDTH = 340
const trayHistory = [] // 최근 30분 일하는 에이전트 수(4초마다) — 패널 그래프

function trayIcon() {
  // 흰 로고를 템플릿으로 — 맥이 밝은 · 어두운 메뉴 막대에 맞춰 칠한다
  const image = nativeImage.createFromPath(path.join(TRAY_ICON_DIR, 'athena-white-16.png'))
  const retina = path.join(TRAY_ICON_DIR, 'athena-white-32.png')
  if (fs.existsSync(retina)) image.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(retina) })
  image.setTemplateImage(true)
  return image
}

// 막힘이 있으면 빨간 점 — 템플릿은 색을 못 써서, 메뉴 막대 색(어두우면 흰색 · 밝으면 검정)으로 칠한 로고에 점을 그린다
let badgeCache = { dark: null, image: null }
function blockedIcon() {
  const dark = nativeTheme.shouldUseDarkColors
  if (badgeCache.image && badgeCache.dark === dark) return badgeCache.image
  const tint = dark ? [255, 255, 255] : [0, 0, 0]
  const image = nativeImage.createEmpty()
  for (const [file, scaleFactor] of [['athena-white-16.png', 1], ['athena-white-32.png', 2]]) {
    const source = nativeImage.createFromPath(path.join(TRAY_ICON_DIR, file))
    if (source.isEmpty()) continue
    const { width, height } = source.getSize()
    image.addRepresentation({ scaleFactor, width, height, buffer: trayBadge.badgeBitmap(source.toBitmap(), width, height, tint) })
  }
  badgeCache = { dark, image }
  return image
}

let trayBlocked = null
function setTrayIcon(blocked) {
  if (!tray || trayBlocked === blocked) return
  trayBlocked = blocked
  tray.setImage(blocked ? blockedIcon() : trayIcon())
}

function createTray() {
  if (tray) return
  // 메뉴 막대가 밝음 · 어두움으로 바뀌면 빨간 점 아이콘을 다시 칠한다
  nativeTheme.on('updated', () => {
    if (!trayBlocked) return
    trayBlocked = null
    setTrayIcon(true)
  })
  tray = new Tray(trayIcon())
  tray.setToolTip('Athena')
  // 누르면 아이콘 아래로 패널(RunCat 처럼). 오른쪽 클릭은 짧은 메뉴
  tray.on('click', toggleTrayWindow)
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(trayShortMenu())))
  // 패널은 미리 만들어 둔다(처음 열 때 빈 화면이 잠깐 보이지 않게)
  createTrayWindow()
  pollTray()
  setInterval(pollTray, 4000)
}

function createTrayWindow() {
  trayWindow = new BrowserWindow({
    width: TRAY_WIDTH,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 배경 없이 맥 반투명 재질만(어두운 HUD) — 둥근 모서리도 창이 맡는다
    vibrancy: 'hud',
    visualEffectState: 'active',
    roundedCorners: true,
    webPreferences: { preload: path.join(__dirname, 'preload-tray.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  trayWindow.loadFile(path.join(__dirname, 'renderer', 'tray.html'))
  // 로드가 끝나야 받는 쪽이 생긴다 — 그때 한 번 보낸다(다시 만든 직후 비어 보이지 않게)
  trayWindow.webContents.on('did-finish-load', sendTrayUpdate)
  // 다른 곳을 누르면 닫힌다(메뉴처럼)
  trayWindow.on('blur', () => trayWindow && !trayWindow.webContents.isDevToolsOpened() && trayWindow.hide())
  trayWindow.on('closed', () => (trayWindow = null))
  // 패널 안 링크 · 이동은 막는다
  trayWindow.webContents.on('will-navigate', (event) => event.preventDefault())
}

function toggleTrayWindow() {
  if (!trayWindow) createTrayWindow()
  if (trayWindow.isVisible()) return trayWindow.hide()
  placeTrayWindow()
  sendTrayUpdate()
  trayWindow.show()
  trayWindow.focus()
  return undefined
}

// 아이콘 바로 아래 가운데 — 화면 밖으로 나가지 않게
function placeTrayWindow() {
  const icon = tray.getBounds()
  const { screen: displays } = require('electron')
  const area = displays.getDisplayNearestPoint({ x: icon.x, y: icon.y }).workArea
  const [width, height] = trayWindow.getSize()
  const x = Math.round(Math.min(Math.max(icon.x + icon.width / 2 - width / 2, area.x + 6), area.x + area.width - width - 6))
  const y = Math.round(icon.y + icon.height + 4)
  trayWindow.setPosition(x, Math.max(y, area.y + 4))
  trayWindow.setSize(width, Math.min(height, area.height - 12))
}

function sendTrayUpdate() {
  if (!trayWindow || trayWindow.isDestroyed()) return
  trayWindow.webContents.send('tray:update', {
    summary: traySummary(),
    history: trayHistory.map((entry) => entry.working),
    boardAt: trayState.boardOkAt,
    pausedUntil: trayState.pausedUntil,
  })
}

// 패널에서 온 것만 받는다
const fromTrayPanel = (event) => Boolean(trayWindow) && event.sender === trayWindow.webContents && event.senderFrame === event.sender.mainFrame
ipcMain.on('tray:height', (event, height) => {
  if (!fromTrayPanel(event) || typeof height !== 'number' || !Number.isFinite(height)) return
  const area = require('electron').screen.getDisplayNearestPoint(trayWindow.getBounds()).workArea
  trayWindow.setSize(TRAY_WIDTH, Math.round(Math.min(Math.max(height, 120), area.height - 12)))
})
ipcMain.on('tray:action', (event, name, value) => {
  if (!fromTrayPanel(event)) return
  if (name === 'focus-pane' && typeof value === 'string') focusPaneFromTray(value)
  if (name === 'open-card') openCardFromTray(typeof value === 'string' ? value : null)
  if (name === 'open-request' && typeof value === 'string') openRequestFromTray(value)
  if (name === 'open-work') openRequestFromTray(null)
  if (name === 'show') showWindow(value === 'work' || value === 'board' ? value : undefined)
  if (name === 'menu') tray.popUpContextMenu(Menu.buildFromTemplate(trayShortMenu()))
  if (name !== 'menu' && trayWindow) trayWindow.hide()
})

function trayNames() {
  return new Map(trayState.workspaces.map((workspace) => [workspace.id, workspace.label]))
}

async function pollTray() {
  const ctx = frontCtx()
  // 앞 창이 바뀌면(다른 팩) 그 팩 기준으로 처음부터 — 알림 판단 · 그래프가 섞이지 않게
  if (ctx !== trayState.ctx || (ctx && ctx.athenaDir !== trayState.dir)) {
    trayState.ctx = ctx
    trayState.dir = ctx ? ctx.athenaDir : null
    trayState.panes = []
    trayState.workspaces = []
    trayState.cards = null
    trayState.usage = []
    trayState.boardAt = 0
    trayHistory.length = 0
    trayNotifier = new trayModel.Notifier()
    if (ctx) trayNotifier.updateRequests(ctx.requestsNow().supported ? ctx.requestsNow().requests : null, say)
  }
  // 이미 붙은 데몬만 읽는다 — 끊겼을 때 숨은 채로 데몬을 띄우거나 버전 확인 대화상자를 띄우지 않게(화면이 다시 붙으면 이어서)
  if (trayState.polling || !ctx || !ctx.isAttached() || !core.checkAthenaDir(ctx.athenaDir).ok) return
  trayState.polling = true
  try {
    const listed = await ctx.peekCall('pane list')
    const state = await ctx.peekCall('state')
    if (ctx !== trayState.ctx) return
    // 못 읽었으면 이번엔 알림 판단을 건너뛴다(예전 목록으로 시간을 재지 않게)
    const panesOk = Boolean(listed.result && state.result)
    if (panesOk) {
      trayState.panes = await markWaiting(ctx, listed.result.panes, trayState.panes)
      if (ctx !== trayState.ctx) return
      trayState.workspaces = state.result.workspaces
      trayState.focused = state.result.focused
      trayHistory.push({ at: Date.now(), working: trayState.panes.filter((pane) => pane.agent && pane.agent_status === 'working').length })
      while (trayHistory.length && Date.now() - trayHistory[0].at > 30 * 60000) trayHistory.shift()
    }
    if (Date.now() - trayState.boardAt > 15000) {
      trayState.boardAt = Date.now()
      const board = await fetchBoardState(ctx.boardPortNow())
      trayState.boardUp = Boolean(board)
      if (board) {
        trayState.boardOkAt = Date.now()
        trayState.cards = board.cards || []
        trayState.usage = (board.header && board.header.usage) || []
        // 평균 답 대기(지난 7일 · 현황판 지표) — 자주 바뀌지 않아 5분마다만. 옛 코어(지표 없음)면 404 → 없음
        if (Date.now() - trayState.metricsAt > 5 * 60000) {
          trayState.metricsAt = Date.now()
          const metrics = await fetchBoardJson(ctx.boardPortNow(), '/api/metrics?days=7')
          trayState.waitMs = metrics && metrics.current && typeof metrics.current.waitMs === 'number' ? metrics.current.waitMs : null
        }
      } else {
        // 꺼졌으면 예전 카드 · 사용량 · 평균 대기를 지금 값처럼 보이지 않게
        trayState.cards = null
        trayState.usage = []
        trayState.waitMs = null
        trayState.metricsAt = 0
      }
    }
    refreshTray()
    if (panesOk) {
      const due = trayNotifier.update({ panes: trayState.panes, names: trayNames(), say }, Date.now())
      // 지금 보고 있는 pane 은 빼고 묶는다
      for (const item of trayModel.bundle(due.filter((entry) => !lookingAt(entry)), say)) notify(item)
    }
    if (trayWindow && trayWindow.isVisible()) sendTrayUpdate()
  } catch {
  } finally {
    trayState.polling = false
  }
}

// 입력 대기 — 에이전트 pane 의 지금 화면을 읽어 권한 질문 · 고르기 창이면 agent_status 를 waiting 으로(판정 screen-model.waitingForInput).
// 데몬이 작업 중으로 본 pane 도 읽는다 — Claude 는 권한 질문을 띄운 채 화면을 계속 다시 그려 데몬의 '방금 출력' 판정에 작업 중으로 걸린다(2026-10-25 실측).
// 데몬은 그대로 두고 이미 있는 pane read 로만 묻는다(데몬 · 프로토콜을 바꾸면 켤 때 데몬을 다시 띄워 pane 이 모두 닫힌다).
// 못 읽으면 모르는 것 — 지난번에 입력 대기였으면 그대로 둔다(데몬 상태로 되돌리면 알림 기억이 풀려 같은 질문을 다시 알린다). 풀림은 읽은 화면으로만 정한다
async function markWaiting(ctx, panes, before = []) {
  const wasWaiting = new Set(before.filter((pane) => pane && pane.agent_status === 'waiting').map((pane) => pane.id))
  return Promise.all(
    panes.map(async (pane) => {
      if (!pane || !pane.agent) return pane
      const read = await ctx.peekCall('pane read', { pane: pane.id, lines: 40, source: 'visible' })
      if (!read.result || typeof read.result.text !== 'string') return wasWaiting.has(pane.id) ? { ...pane, agent_status: 'waiting' } : pane
      return screenModel.waitingForInput(read.result.text) ? { ...pane, agent_status: 'waiting' } : pane
    }),
  )
}

// 현황판이 떠 있으면 그 상태를 읽는다 — 어떤 실패든 한 번 null(0건으로 치지 않는다)
function fetchBoardState(port) {
  return fetchBoardJson(port, '/api/state')
}
// 현황판 GET 하나 → JSON(실패면 null)
function fetchBoardJson(port, pathName) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 2000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 5 * 1024 * 1024) {
          request.destroy()
          finish(null)
        }
      })
      response.on('end', () => {
        try {
          finish(response.statusCode === 200 ? JSON.parse(body) : null)
        } catch {
          finish(null)
        }
      })
      response.on('aborted', () => finish(null))
      response.on('error', () => finish(null))
      response.on('close', () => finish(null))
    })
    request.on('timeout', () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
  })
}

function traySummary() {
  const ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : null
  const requests = ctx ? ctx.requestsNow().requests : []
  return trayModel.summarize({ panes: trayState.panes, workspaces: trayState.workspaces, cards: trayState.cards || [], requests, usage: trayState.usage, boardUp: trayState.boardUp, waitMs: trayState.waitMs, say })
}

function refreshTray() {
  if (!tray) return
  const summary = traySummary()
  // 아이콘 옆 숫자는 두지 않는다(사용자) — 막힘이 있으면 빨간 점만
  setTrayIcon(summary.counts.blocked > 0 || summary.counts.asking > 0)
  const { working, blocked, review } = summary.counts
  tray.setToolTip(say('tray.tooltip', { working, blocked, review }))
}

// ☰ · 오른쪽 클릭 — 짧은 메뉴
function trayShortMenu() {
  const paused = trayState.pausedUntil > Date.now()
  return [
    { label: say('tray.menu.open'), click: () => showWindow() },
    { label: say('tray.menu.board'), click: () => showWindow('board') },
    { type: 'separator' },
    {
      label: paused ? say('tray.menu.paused') : say('tray.menu.pause'),
      submenu: [
        { label: say('tray.menu.pauseHour'), click: () => setTrayPause(Date.now() + 3600000) },
        { label: say('tray.menu.pauseMorning'), click: () => setTrayPause(nextMorning()) },
        { type: 'separator' },
        { label: say('tray.menu.resume'), enabled: paused, click: () => setTrayPause(0) },
      ],
    },
    { type: 'separator' },
    { label: say('tray.menu.quit'), click: () => app.quit() },
  ]
}

function setTrayPause(until) {
  trayState.pausedUntil = until
  sendTrayUpdate()
}

function nextMorning() {
  const morning = new Date()
  morning.setHours(9, 0, 0, 0)
  if (morning.getTime() <= Date.now()) morning.setDate(morning.getDate() + 1)
  return morning.getTime()
}

// 창을 다시 보이게 — 메뉴 막대가 보던 팩 창(없으면 첫 창 · 그것도 없으면 지난 설정대로 연다). tab 을 주면 그 탭으로(work · board)
function showWindow(tab) {
  let ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : frontCtx()
  if (!ctx) {
    openSavedWindows()
    ctx = frontCtx()
  }
  if (ctx) ctx.show(tab)
}

async function focusPaneFromTray(paneId) {
  const ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : frontCtx()
  if (!ctx) return
  ctx.show('work')
  // 데몬과 화면 연결이 끊겨 있었으면 다시 붙인다
  if (ctx.screenDetached()) ctx.send('screen:resync')
  await ctx.daemonCall('focus', { pane: String(paneId) })
}

// 계획서 결정 콘솔이 있으면 옆 브라우저로, 없으면 현황판 탭
function openCardFromTray(html) {
  const ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : frontCtx()
  if (!ctx) return
  if (html) {
    ctx.show()
    ctx.openInBrowser(`${core.boardUrl(ctx.boardPortNow()).replace(/\/$/, '')}/${html.split('/').map(encodeURIComponent).join('/')}`)
  } else {
    ctx.show('board')
  }
}

// 요청 — 창을 앞으로 가져와 그 요청(id 가 없으면 [작업] 팝업)을 연다
function openRequestFromTray(id) {
  const ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : frontCtx()
  if (!ctx) return
  ctx.show('work')
  ctx.send('work:open', id)
}

// 앞 창(메뉴 막대가 보는 창)의 요청이 바뀌면 — 새로 열린 것만 맥 알림 한 번(창이 여럿이어도 메뉴 막대가 보는 창 것만) · 메뉴 막대 다시 그리기
function trayRequestsChanged(ctx) {
  if (!tray || ctx !== trayState.ctx) return
  const now = ctx.requestsNow()
  for (const item of trayModel.bundle(trayNotifier.updateRequests(now.supported ? now.requests : null, say), say)) notify(item)
  refreshTray()
  if (trayWindow && trayWindow.isVisible()) sendTrayUpdate()
}

// 지금 보고 있는 pane 이면(그 창이 앞에 있고 작업 창 탭 · 그 pane 포커스) 알리지 않는다
function lookingAt(item) {
  const ctx = trayState.ctx
  return Boolean(item.target.pane) && Boolean(ctx && ctx.win) && ctx.win.isVisible() && ctx.win.isFocused() && ctx.uiTab === 'work' && trayState.focused === item.target.pane
}

function notify(item) {
  if (trayState.pausedUntil > Date.now() || !Notification.isSupported()) return
  const notification = new Notification({ title: item.title, body: item.body, silent: true })
  notification.on('click', () => {
    if (item.target.request) openRequestFromTray(item.target.request)
    else if (item.target.pane) focusPaneFromTray(item.target.pane)
    else openCardFromTray(item.target.html)
  })
  notification.show()
}

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
handle('pack:pick-icon', (ctx) => ctx.packPickIcon())
handle('pack:context-menu', (ctx, id, point) => ctx.packContextMenu(String(id), point && typeof point === 'object' ? point : null))
// 이 창 닫기 — 시작 화면에서 다른 팩을 열고 나면(창이 하나뿐이면 닫지 않는다)
handle('window:close', (ctx) => {
  if (packWindows.size > 1) setImmediate(() => ctx.close())
  return { closed: packWindows.size > 1 }
})
handle('screen:attach', (ctx) => ctx.attachScreen())
handle('pack:repos', (ctx) => ctx.packRepos())
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
listen('ui:tab', (ctx, tab) => (ctx.uiTab = tab === 'board' ? 'board' : 'work'))
handle('open:url', (ctx, url) => openUrl(ctx, String(url)))
// 옆 브라우저 IPC 도 그 창 앱 화면(맨 위 프레임)에서 온 것만 — 하위 프레임 · 서랍 안 페이지는 못 부른다(ctxOf 가 가린다)
listen('browser:place', (ctx, rect) => ctx.placeBrowser(browserRect(rect)))
listen('browser:hide', (ctx) => ctx.hideBrowser())
handle('browser:command', (ctx, name, value) => ctx.browserCommand(String(name), typeof value === 'string' ? value : ''))

app.whenReady().then(async () => {
  // 앱 데이터 폴더 이름(IDENTITY.name)은 맨 위에서 정했다 — 바꾸면 설정 · 데몬이 옮겨진다
  // 보이는 이름은 Athena(메뉴 막대 · Dock 은 개발용 Athena.app — scripts/dev-app.js)
  app.setAboutPanelOptions({ applicationName: 'Athena' })
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
