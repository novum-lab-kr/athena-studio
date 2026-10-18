// Athena Studio 메인 프로세스 — 창 · 메뉴(단축키) · 작업 창(데몬에 붙기) · 현황판 서버 · 아테나 폴더 설정
const { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, session, shell } = require('electron')
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const core = require('./lib/core')
const packModel = require('./lib/pack')
const agentFeed = require('./lib/agent-feed')
const trayModel = require('./lib/tray-model')
const trayBadge = require('./lib/tray-icon')
const daemonClient = require('./daemon-client')
const explorer = require('./lib/explorer')
const fileIcons = require('./lib/file-icons')
const viewer = require('./lib/viewer')
const i18n = require('./lib/i18n')

const isMac = process.platform === 'darwin'
// 앱 아이콘 — 둥근 사각형 앱 아이콘(1024 · Dock · 윈도우·리눅스 창). 화면 안 로고는 화이트판(athena-logo-white.png)
// 스튜디오용 아테나 — 이 레포의 athena/(git subtree)
const STUDIO_ATHENA = core.studioAthenaDir(path.join(__dirname, '..'))
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'logo', 'athena-app-icon.png')
// Ctrl 조합은 pane 안(셸·에이전트) 몫이라 앱 단축키는 Cmd(맥) · Alt(그 밖)로만 건다
const TAB_KEY = isMac ? 'Command' : 'Alt'

let mainWindow = null
let config = null

// ── 언어 ──────────────────────────────────────────────────
// 사전은 src/i18n/<언어>.json. 앱 설정 language → 없으면 시스템 언어(app.getLocale()) → 네 언어 밖이면 영어(D3).
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
  for (const window of [mainWindow, trayWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('i18n:changed', i18nPayload())
  }
  if (trayWindow && trayWindow.isVisible()) sendTrayUpdate()
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
    boardUrl: core.boardUrl(boardPortNow()),
    installDir: homeAthena(), // 처음 켤 때 쓰는 본체(~/athena · 사용자 결정 1)
    tabKey: isMac ? '⌘' : 'Alt+',
    platform: process.platform,
    athenaWorkspace: core.ATHENA_WORKSPACE, // 하단 에이전트 모니터는 이 이름이고 아테나 폴더인 작업 공간에서만 보인다
    athenaRealDir: config.athenaDir ? core.realDir(config.athenaDir) : null, // 화면은 심볼릭 링크를 못 풀어서 main 이 푼 경로도 준다
  }
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

// ── 작업 창 (데몬) ──────────────────────────────────────────
// 셸 pane 은 데몬이 갖는다(src/daemon) — 앱은 붙어서 보여 주기만 한다. 앱을 닫아도 데몬·셸·에이전트는 계속 돈다
let daemon = null // DaemonConnection
let connecting = null
const outputQueue = new Map() // paneId → 모아 둔 출력(8ms 마다 한 번에 보낸다)
let flushTimer = null
let dropOutput = false // attach 답이 오기 전 출력 — 되살릴 화면에 이미 들어 있다

const daemonPaths = () =>
  core.daemonPaths({ userData: app.getPath('userData'), home: app.getPath('home'), tmpdir: app.getPath('temp'), uid: process.getuid(), endpoint: process.env.ATHENA_STUDIO_ENDPOINT || null })

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
  }
}

function flushOutput() {
  clearTimeout(flushTimer)
  flushTimer = null
  for (const [paneId, data] of outputQueue) send('pane:data', paneId, data)
  outputQueue.clear()
}

// 연결이 끊기면 화면에 알린다(앱이 스스로 끊은 detachScreen 은 daemon 을 먼저 비운다)
let screenDetached = false
function onDaemonClosed() {
  daemon = null
  screenDetached = true
  send('screen:disconnected')
}

async function connectDaemon() {
  if (daemon) return daemon
  if (connecting) return connecting
  connecting = (async () => {
    const paths = daemonPaths()
    const result = await daemonClient.ensureDaemon({ paths, env: core.childEnv(process.env), onEvent: onDaemonEvent, onClose: onDaemonClosed })
    if (result.status === 'mismatch') await askRestartDaemon(result, paths)
    daemon = daemon || result.connection
    return daemon
  })().finally(() => (connecting = null))
  return connecting
}

// 데몬과 앱의 프로토콜이 다르다 — 다시 띄우면 모든 pane·에이전트가 닫히므로 묻는다(S3)
async function askRestartDaemon(result, paths) {
  const count = (result.hello && result.hello.panes) || 0
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    message: say('dialog.daemonVersion.message'),
    detail: say('dialog.daemonVersion.detail', { count }),
    buttons: [say('common.later'), say('dialog.daemonVersion.restart')],
    defaultId: 0,
    cancelId: 0,
  })
  if (choice.response !== 1) return
  await result.connection.call('shutdown').catch(() => null)
  result.connection.close()
  await daemonClient.waitDaemonGone(paths.socket)
  const fresh = await daemonClient.ensureDaemon({ paths, env: core.childEnv(process.env), onEvent: onDaemonEvent, onClose: onDaemonClosed })
  daemon = fresh.connection
}

// 화면이 붙는다 — 지금 상태 + pane 마다 되살릴 화면. 이 뒤로 실시간 출력이 이어진다
async function attachScreen() {
  const check = core.checkAthenaDir(config.athenaDir)
  if (!check.ok) return { error: say('error.athenaDirMissing') }
  try {
    const connection = await connectDaemon()
    flushOutput()
    dropOutput = true
    try {
      const attached = await connection.call('attach', {}, () => {
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

// 앱 종료·창 닫기 — 연결만 끊는다(데몬·셸·에이전트는 계속 돈다)
function detachScreen() {
  if (!daemon) return
  const current = daemon
  daemon = null
  current.close()
}

// 데몬 쪽 오류 중 화면에 보이는 것 — 연결 끊김 · 붙기 실패는 사전 문구로(나머지 데몬 오류는 데몬이 쓴 글 그대로)
function daemonErrorText(error) {
  if (error.code === 'unavailable') return say('error.daemonDisconnected')
  if (error.code === 'attach-failed') return say('error.daemonAttach', { path: error.log })
  return error.message
}

async function daemonCall(op, args) {
  try {
    const connection = await connectDaemon()
    return { result: await connection.call(op, args) }
  } catch (error) {
    return { error: daemonErrorText(error), code: error.code }
  }
}

// 개발용 — 데몬 파일을 고쳤을 때 새로 띄운다(모든 pane 이 닫힌다)
async function restartDaemon() {
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    message: say('dialog.daemonRestart.message'),
    detail: say('dialog.daemonRestart.detail'),
    buttons: [say('common.cancel'), say('dialog.daemonRestart.confirm')],
    defaultId: 0,
    cancelId: 0,
  })
  if (choice.response !== 1) return
  const connection = await connectDaemon().catch(() => null)
  if (connection) {
    await connection.call('shutdown').catch(() => null)
    connection.close()
  }
  daemon = null
  await daemonClient.waitDaemonGone(daemonPaths().socket)
  send('screen:resync')
}

// pane 닫기(⌘W) — 에이전트가 돌고 있으면 묻는다(S6)
async function closePane(paneId) {
  const info = await daemonCall('pane get', { pane: paneId })
  const pane = info.result && info.result.pane
  if (pane && pane.agent) {
    const choice = await dialog.showMessageBox(mainWindow, {
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

// ── 에이전트 모니터(가운데 맨 아래 · 앱 화면) ─────────────
// Claude Code 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl)을 따라 읽어 화면에 이벤트로 보낸다 — 아테나 agent-monitor.py 와 같은 대상:
// 서브에이전트(<세션>/subagents/agent-*.jsonl) · 워크트리 세션 · 지금 에이전트가 도는 pane 폴더의 세션. 최근 120분 안에 바뀐 것만.
// 화면에 모니터가 보일 때(monitor:watch)만 읽는다
// 예전 터미널 모니터 칸의 이름표 — 이미 떠 있는 pane 을 찾는 값이라 번역하지 않는다
const MONITOR_LABEL = '🛰 에이전트 모니터'
const MONITOR_MINUTES = 120
const MONITOR_BACKLOG = 5 // 처음 붙을 때 세션마다 마지막 몇 개만
const MONITOR_HEAD_BYTES = 64 * 1024 // 처음 붙을 때 파일 끝에서 이만큼만 읽는다
const MONITOR_CHUNK_BYTES = 4 * 1024 * 1024
const MONITOR_KEEP = 300
const MONITOR_TEXT_MAX = 300
// floor — 팩을 바꾼 시각. 그 전 세션은 다른 팩 것일 수 있어(본체 하나 · 같은 폴더) 읽지 않는다
const monitor = { watching: false, timer: null, ticking: false, lastScan: 0, lastFullScan: 0, tails: new Map(), tailSeq: 0, events: [], seq: 0, agentCwds: [], floor: 0 }

// 예전엔 데몬 고정 칸에서 agent-monitor.py 를 돌렸다 — 남아 있으면 닫는다(보기만 하는 칸이라 잃는 것이 없다)
async function closeMonitorDock() {
  const listed = await daemonCall('pane list')
  for (const pane of (listed.result && listed.result.panes) || []) {
    if (!pane.tab_id && pane.label === MONITOR_LABEL) await daemonCall('pane close', { pane: pane.id })
  }
}

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

// allSessions — 부모 세션이 조용해도 서브에이전트는 오래 돌 수 있어서, 가끔(1분)은 모든 세션의 서브에이전트를 자기 수정 시각으로 본다
async function findMonitorLogs(allSessions) {
  const root = path.join(app.getPath('home'), '.claude', 'projects')
  const since = Math.max(Date.now() - MONITOR_MINUTES * 60000, monitor.floor)
  const wanted = new Set(monitor.agentCwds.map(agentFeed.projectDirName))
  const found = []
  for (const project of await readDir(root)) {
    if (!project.isDirectory()) continue
    const dir = path.join(root, project.name)
    const paneSessions = wanted.has(project.name) || project.name.includes('--worktrees-')
    for (const entry of await readDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = path.join(dir, entry.name)
      const stat = await recentFile(file, since)
      if (stat && paneSessions) found.push({ file, pane: true, stat })
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

function tailEvents(tail, lines) {
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

async function openTail(item) {
  const tail = { id: `s${++monitor.tailSeq}`, file: item.file, pane: item.pane, label: null, finished: false, tools: 0, mtime: item.stat.mtimeMs, offset: Math.max(0, item.stat.size - MONITOR_HEAD_BYTES), rest: Buffer.alloc(0), skipPartial: item.stat.size > MONITOR_HEAD_BYTES }
  await readSubagentMeta(tail)
  const lines = await readNewLines(tail).catch(() => [])
  const events = tailEvents(tail, lines).slice(-MONITOR_BACKLOG)
  monitor.tails.set(item.file, tail)
  return events
}

function monitorSessions() {
  return [...monitor.tails.values()]
    .sort((left, right) => right.mtime - left.mtime)
    .map((tail) => ({ id: tail.id, label: tail.label || (tail.pane ? 'pane' : 'agent'), pane: tail.pane, finished: tail.finished, tools: tail.tools, lastAt: tail.mtime }))
}

async function monitorTick() {
  // 창이 숨었으면(메뉴 막대로 내려감) 기록을 읽지 않는다
  if (!monitor.watching || monitor.ticking || packBusy || !mainWindow || !mainWindow.isVisible()) return
  monitor.ticking = true
  try {
    const fresh = []
    let changed = false
    // 10초마다 새 세션을 찾고, 120분 넘게 조용한 세션은 뺀다
    if (Date.now() - monitor.lastScan > 10000) {
      monitor.lastScan = Date.now()
      const allSessions = Date.now() - monitor.lastFullScan > 60000
      if (allSessions) monitor.lastFullScan = Date.now()
      const found = await findMonitorLogs(allSessions)
      for (const item of found) {
        if (monitor.tails.has(item.file)) continue
        fresh.push(...(await openTail(item)))
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
        fresh.push(...tailEvents(tail, await readNewLines(tail)))
      } catch {}
    }
    const events = fresh.sort((left, right) => String(left.at).localeCompare(String(right.at)))
    if (events.length) {
      monitor.events = [...monitor.events, ...events].sort((left, right) => String(left.at).localeCompare(String(right.at)) || left.id - right.id).slice(-MONITOR_KEEP)
      changed = true
    }
    if (changed) send('monitor:update', { sessions: monitorSessions(), events })
  } catch (error) {
    send('monitor:update', { sessions: monitorSessions(), events: [], error: error.message })
  } finally {
    monitor.ticking = false
  }
}

function setMonitorWatch(on) {
  monitor.watching = Boolean(on)
  clearInterval(monitor.timer)
  if (!monitor.watching) return
  monitor.lastScan = 0
  monitor.lastFullScan = 0
  // 다시 보이면 지금까지 모은 것을 한 번에 보내고 이어서 따라간다
  send('monitor:update', { reset: true, sessions: monitorSessions(), events: monitor.events })
  monitorTick()
  monitor.timer = setInterval(monitorTick, 1000)
}

// 탭 닫기 — 안에 에이전트가 돌고 있으면 묻는다
async function closeTab(tabId) {
  const listed = await daemonCall('pane list')
  const agents = ((listed.result && listed.result.panes) || []).filter((pane) => pane.tab_id === tabId && pane.agent)
  if (agents.length) {
    const choice = await dialog.showMessageBox(mainWindow, {
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
async function newWorkspace(size) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: say('dialog.newWorkspace.title'),
    properties: ['openDirectory'],
    // 아테나는 앱 데이터 폴더에 있으니 레포 고르기는 홈에서 시작한다
    defaultPath: app.getPath('home'),
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const dir = result.filePaths[0]
  return daemonCall('workspace create', { label: path.basename(dir), cwd: dir, focus: true, ...size })
}

// 보일 때만 2초마다 pane 목록(에이전트가 도는 폴더 → 모니터)과 작업 공간 브랜치를 갱신한다
let panesTimer = null
function startPanesPolling() {
  clearInterval(panesTimer)
  panesTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized() || !daemon) return
    const listed = await daemonCall('pane list')
    if (listed.result) {
      monitor.agentCwds = listed.result.panes.filter((pane) => pane.agent).map((pane) => pane.foreground_cwd || pane.cwd).filter(Boolean)
    }
    const branches = await workspaceBranches()
    if (branches) send('screen:branches', branches)
  }, 2000)
}

// 작업 공간마다 git 브랜치(herdr spaces 처럼 이름 아래에) — 5초에 한 번만 묻는다
let branchCache = { at: 0, value: null }
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

// ── 오른쪽 Explorer ────────────────────────────────────────
// 화면은 파일에 손대지 않는다 — main 이 읽어 준다. 루트는 화면이 준 경로가 아니라 데몬 상태의 작업 공간 폴더다
async function workspaceRoot(workspaceId) {
  const state = await daemonCall('state')
  const workspace = state.result && state.result.workspaces.find((entry) => entry.id === String(workspaceId))
  if (!workspace) throw new Error(say('error.workspaceMissing'))
  return fs.promises.realpath(workspace.cwd)
}

// 상대 경로를 풀어(심볼릭 링크 포함) 루트 안인지 본다
async function resolveInside(root, relative) {
  const clean = explorer.cleanRelative(relative)
  if (clean === null) throw new Error(say('error.pathUnreadable'))
  const real = await fs.promises.realpath(path.join(root, clean))
  if (!explorer.isInside(root, real)) throw new Error(say('error.outsideWorkspace'))
  return { real, clean }
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: core.childEnv(process.env, { GIT_OPTIONAL_LOCKS: '0' }) }, (error, stdout) =>
      resolve(error ? null : stdout),
    )
  })
}

async function explorerList(workspaceId, relative) {
  const root = await workspaceRoot(workspaceId)
  const { real } = await resolveInside(root, relative)
  const dirents = await fs.promises.readdir(real, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      let dir = dirent.isDirectory()
      if (dirent.isSymbolicLink()) dir = await fs.promises.stat(path.join(real, dirent.name)).then((stat) => stat.isDirectory(), () => false)
      return { name: dirent.name, dir, ...fileIcons.iconFor(fileIcons.loadManifest(), dirent.name, dir) }
    }),
  )
  return { entries: explorer.sortEntries(entries) }
}

// 작업 공간 폴더 기준 git 변경. git 레포가 아니면 git: false
async function explorerStatus(workspaceId) {
  const root = await workspaceRoot(workspaceId)
  const top = await runGit(root, ['rev-parse', '--show-toplevel'])
  if (top === null) return { git: false, changes: [] }
  const prefix = path.relative(await fs.promises.realpath(top.trim()), root)
  // 새 폴더는 한 줄(`dir/`)로 — 안의 파일을 다 세면 .omc/ 같은 폴더 하나로 수백 줄이 된다(git 기본과 같다)
  const output = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  if (output === null) return { git: true, changes: [] }
  const changes = explorer.relativeToWorkspace(explorer.parseGitStatus(output), prefix.split(path.sep).join('/'))
  // 변경 목록에도 아이콘 — 새 폴더(`dir/`)는 폴더 아이콘
  const manifest = fileIcons.loadManifest()
  return {
    git: true,
    changes: changes.map((change) => ({ ...change, ...fileIcons.iconFor(manifest, change.path.split('/').filter(Boolean).pop(), change.path.endsWith('/')) })),
  }
}

// ── 파일 뷰어 — VSCode 처럼 확장자에 맞는 색(Shiki · Dark+ 테마)과 줄 번호 ──
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

// 미리보기 — 이미지는 그림, 바뀐 파일은 diff(옛·새 줄 번호), 그 밖은 내용(앞 512KB). 바이너리는 안내만
async function explorerOpen(workspaceId, relative) {
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

// IPC 결과 — 실패는 {error}
async function guarded(work) {
  try {
    return await work()
  } catch (error) {
    return { error: error.message }
  }
}

// ── 아테나 에이전트 ────────────────────────────────────────
// athena 작업 공간(아테나 폴더)이 있으면 그리로 옮기기만 하고, 없으면 만들어 claude · codex 를 켠다
async function openAthenaAgent(chosen, size) {
  if (!core.checkAthenaDir(config.athenaDir).ok) return { skipped: true }
  const state = await daemonCall('state')
  if (state.error) return { error: state.error }
  const existing = core.findAthenaWorkspace(state.result.workspaces, config.athenaDir)
  if (existing) {
    await daemonCall('workspace select', { workspace: existing.id })
    return { focused: true }
  }

  const decision = core.agentDecision(core.availableAgents(process.env.PATH), chosen)
  if (decision.error) return { error: say('error.agentMissing', { agent: chosen }) }
  if (decision.choose) return { choose: decision.choose }

  const created = await daemonCall('workspace create', { label: core.ATHENA_WORKSPACE, cwd: config.athenaDir, focus: true, ...size })
  if (created.error) return { error: say('error.athenaWorkspaceCreate', { message: created.error }) }
  if (decision.none) return { error: say('error.agentNotInstalled') }
  const run = await daemonCall('pane run', { pane: created.result.root_pane.id, text: decision.agent })
  if (run.error) return { error: say('error.agentStart', { agent: decision.agent }) }
  return { started: decision.agent }
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
// 포트 정하기 · 띄우기가 겹치지 않게 한 줄로 세운다(아테나 폴더를 바꾸는 사이 결과가 섞이지 않게)
let boardQueue = Promise.resolve()
function queueBoard(work) {
  const run = boardQueue.then(work)
  boardQueue = run.catch(() => {})
  return run
}

function ensureBoard() {
  if (!core.checkAthenaDir(config.athenaDir).ok) return Promise.resolve({ ok: false, url: core.boardUrl(boardPortNow()), error: say('error.athenaDirMissing') })
  return queueBoard(() => findOrStartBoard(config.athenaDir))
}

// 현황판은 띄우지 않고 포트만 미리 정해 적는다(앱 시작 · 아테나 폴더를 정할 때) — 현황판 탭을 열기 전에도 아테나가 콘솔을 맞는 포트로 띄우게.
// 팩 지원 본체면 포트는 본체가 정하니 읽기만 하고 본체 설정에 쓰지 않는다(setAthenaBoardPort 는 옛 본체에서만)
function prepareBoardPort() {
  if (!core.checkAthenaDir(config.athenaDir).ok) return
  const athenaDir = config.athenaDir
  queueBoard(async () => {
    if (await refreshPackStatus(athenaDir)) return null
    return findBoardPort(athenaDir)
  }).catch(() => {})
}

// 저장된 포트부터 차례로 — 이 아테나 폴더에서 도는 현황판이면 그대로 쓰고, 비었으면 거기 띄우고, 다른 것(herdr 용 ~/athena 현황판 등)이나
// 주인을 모르는 것(lsof 실패)이 쥐고 있으면 다음 번호. 고른 포트는 스튜디오 아테나 설정(boardPort)과 앱 설정에 적는다 — pane 안의 아테나가 그 값으로 현황판을 찾는다
async function findBoardPort(athenaDir) {
  const ports = core.boardPortCandidates(config.boardPort)
  for (const port of ports) {
    const owner = await boardOwner(port, athenaDir)
    if (owner === 'other') continue
    // 찾는 사이 아테나 폴더가 바뀌었으면 이 결과는 버린다
    if (config.athenaDir !== athenaDir) return { error: say('error.athenaDirChanged') }
    const saved = rememberBoardPort(port, athenaDir)
    if (saved.error) return saved
    return { port, owner }
  }
  return { error: say('error.boardPortsBusy', { from: ports[0], to: ports[ports.length - 1] }) }
}

async function findOrStartBoard(athenaDir) {
  const result = await findOrStartBoardFor(athenaDir)
  // 띄우거나 기다리는 사이 아테나 폴더가 바뀌었으면 예전 폴더의 현황판을 보여 주지 않는다
  if (config.athenaDir !== athenaDir) return { ok: false, url: core.boardUrl(boardPortNow()), error: say('error.athenaDirChangedReload', { key: reloadKey() }) }
  return result
}

// 지금 현황판 포트 — 팩 지원 본체면 본체가 정한 값(pack status), 옛 본체면 앱 설정
let packBoardPort = null
let packDataDir = null // R1 — pack status 의 dataDir
const boardPortNow = () => packBoardPort || config.boardPort

// 팩 지원 본체인지 · 현황판 포트 — pack status(가볍다). 옛 본체면 null
async function refreshPackStatus(athenaDir) {
  const status = await runPack(['status'], { dir: athenaDir })
  packBoardPort = packModel.statusBoardPort(status)
  packDataDir = packModel.statusDataDir(status)
  // current 도 같이 — 현황판 판단은 방금 읽은 이 값으로(목록을 못 읽었거나 시작 직후에도 멀쩡한 현황판을 끄지 않게)
  return packBoardPort ? { boardPort: packBoardPort, current: status.current || null } : null
}

// 팩 지원 본체의 현황판 — 포트는 본체가 정한다(계획서 5.3 · 본체 하나에 현황판 하나). 떠 있는 현황판이 지금 팩 · 세대 것이면
// 누가 띄웠든(herdr board.sh · 스튜디오) 같이 쓰고, 다른 팩 것이면 토큰으로 끄고 다시 띄운다. 그 포트를 현황판이 아닌 것이 쥐고 있으면 오류
async function packBoard(port, athenaDir, current) {
  const url = core.boardUrl(port)
  if (await isBoardUp(port)) {
    const reply = await boardJson(port, '/api/state')
    if (reply.status !== 200 || !reply.body) return { ok: false, url, error: say('error.boardStateUnreadable', { port, key: reloadKey() }) }
    if (packModel.boardIdentity(reply.body, current) !== 'stale') return { ok: true, url, started: false }
    if (await stopStaleBoard(port)) return startBoard(port, athenaDir)
    return { ok: false, url, error: say('error.boardStaleStopFailed', { port }) }
  }
  if ((await boardOwner(port, athenaDir)) === 'free') return startBoard(port, athenaDir)
  return { ok: false, url, error: say('error.boardPortBusyCore', { port }) }
}

async function findOrStartBoardFor(athenaDir) {
  const status = await refreshPackStatus(athenaDir)
  if (status) return packBoard(status.boardPort, athenaDir, status.current)
  // 옛 본체 — 지금까지처럼 앱 설정 boardPort 부터 비어 있는 포트를 골라 적는다
  const found = await findBoardPort(athenaDir)
  if (found.error) return { ok: false, url: core.boardUrl(config.boardPort), error: found.error }
  if (found.owner === 'free') return startBoard(found.port, athenaDir)
  const url = core.boardUrl(found.port)
  if (await isBoardUp(found.port)) return { ok: true, url, started: false }
  return { ok: false, url, error: say('error.boardNoAnswer', { port: found.port }) }
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

// 아테나 설정에 먼저 적고, 되면 앱 설정에 — 둘이 다른 포트를 가리키지 않게
function rememberBoardPort(port, athenaDir) {
  try {
    core.setAthenaBoardPort(athenaDir, port)
  } catch (error) {
    return { error: say('error.boardPortSave', { message: error.message }) }
  }
  if (config.boardPort !== port) {
    config = { ...config, boardPort: port }
    core.saveConfig(configFile(), config)
  }
  return {}
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
  const extra = { ATHENA_BOARD_PORT: String(port), ATHENA_STUDIO_SOCKET: paths.socket, ATHENA_STUDIO_CLI: daemonClient.CLI, ATHENA_STUDIO_NODE: process.execPath }
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

// ── 아테나 폴더 ────────────────────────────────────────────
async function pickAthenaDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: say('dialog.pickAthena.title'),
    message: say('dialog.pickAthena.message'),
    properties: ['openDirectory'],
    defaultPath: config.athenaDir || app.getPath('home'),
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true, ...athenaState() }
  return useAthenaDir(result.filePaths[0])
}

function useAthenaDir(dir) {
  // 회사 팩 작업 중에는 본체를 바꾸지 않는다(정리는 A 본체에서, 바꾸기는 B 본체에서 — 섞인다)
  if (packBusy) return { ...athenaState(), error: say('error.packBusyAthena', { task: packBusy }) }
  const check = core.checkAthenaDir(dir)
  if (!check.ok) return { ...athenaState(), error: say('error.notAthenaDir', { files: check.missing.join(', ') }), picked: dir }
  try {
    core.ensureAthenaConfig(dir, athenaReposRoot(dir))
  } catch (error) {
    return { ...athenaState(), error: say('error.configCreate', { message: error.message }), picked: dir }
  }
  const changed = dir !== config.athenaDir
  config = { ...config, athenaDir: dir }
  core.saveConfig(configFile(), config)
  prepareBoardPort()
  return { ...athenaState(), changed }
}

// 새로 만드는 athena.config.json 의 reposRoot — 스튜디오 레포의 athena/ 면 홈, 직접 고른 폴더면 ..
const athenaReposRoot = (dir) => core.reposRootFor(dir, { studioAthena: STUDIO_ATHENA, home: app.getPath('home') })

// 처음 켤 때 — 받지 않고 ~/athena 를 본체로 쓴다(여러 회사 팩 · 사용자 결정 1). 없으면 폴더를 고르게 한다(본체 받기는 범위 밖)
async function installAthena() {
  const found = packModel.defaultAthenaDir(config, homeAthena(), (dir) => core.checkAthenaDir(dir).ok)
  if (!found) return { ...athenaState(), error: say('error.homeAthenaMissing', { path: homeAthena() }) }
  return useAthenaDir(found)
}

const homeAthena = () => path.join(app.getPath('home'), 'athena')

// 스튜디오 레포 athena/ 를 쓰던 사람 — ~/athena 가 여러 팩을 지원하면 한 번 묻는다.
// 옮기기로 하면 본체를 ~/athena 로 바꾸고, 화면이 뜬 뒤 그 폴더의 팩 · 작업 기록 가져오기(import-athena)를 이어서 연다. 옛 폴더는 건드리지 않는다
let pendingAthenaImport = null
async function offerMoveToHome() {
  // 가짜 본체(화면 확인용)는 어느 폴더에 물어도 '여러 팩 지원' 이라 답한다 — 진짜 설정(athenaDir)을 바꾸지 않게 묻지 않는다
  if (process.env.ATHENA_STUDIO_FAKE_PACK === '1') return
  if (config.homeAthenaAsked || !core.checkAthenaDir(homeAthena()).ok || !core.sameDir(config.athenaDir, STUDIO_ATHENA)) return
  const listed = packModel.normalizePackList(await runPack(['list'], { dir: homeAthena() }))
  if (!packModel.shouldOfferMoveToHome({ config, studioAthena: STUDIO_ATHENA, homeSupportsPacks: listed.supported && !listed.legacy, sameDir: core.sameDir })) return
  // 창을 만들기 전이라 대화상자가 다른 앱 뒤에 숨는다 — 앱을 앞으로 가져온다
  app.focus({ steal: true })
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: say('dialog.moveToHome.message'),
    detail: [say('dialog.moveToHome.current', { path: STUDIO_ATHENA }), say('dialog.moveToHome.detail'), say('dialog.moveToHome.laterNote')].join('\n\n'),
    buttons: [say('dialog.moveToHome.confirm'), say('common.later')],
    defaultId: 0,
    cancelId: 1,
  })
  config = { ...config, homeAthenaAsked: true }
  if (response === 0) {
    config = { ...config, athenaDir: homeAthena() }
    pendingAthenaImport = STUDIO_ATHENA
  }
  core.saveConfig(configFile(), config)
}

// ── 회사 팩 ────────────────────────────────────────────────
// 정본은 아테나 본체 — 스튜디오는 `node scripts/athena.mjs pack … --json` 을 부르고, 기다리고, 화면을 정리하고, 결과를 보여 준다.
// 약속: 아테나 계획서 plans/feature/20261018-여러-회사-팩.md "5. 공통 스펙". 팩 파일 · 링크는 직접 만지지 않는다.
// ATHENA_STUDIO_FAKE_PACK=1 이면 본체 대신 scripts/fake-pack.js(같은 약속의 가짜)를 부른다 — 코어 명령이 나오기 전 화면 확인용
const PACK_TIMEOUTS = { list: 20000, status: 20000, busy: 30000, use: 180000, inspect: 300000, 'import-athena': 300000, import: 180000, export: 180000, backup: 300000, new: 60000, 'board-token': 15000 }
const packLogFile = () => path.join(app.getPath('userData'), 'pack.log')
let packState = { supported: false }
let packBusy = null // 지금 하는 일(바꾸기 · 가져오기 …) — 한 번에 하나
let packAbort = null // 기다리는 중 · 검사 중이면 취소할 수 있다

function packScript(dir) {
  if (process.env.ATHENA_STUDIO_FAKE_PACK === '1') return path.join(__dirname, '..', 'scripts', 'fake-pack.js')
  return path.join(dir, 'scripts', 'athena.mjs')
}

// 셸을 거치지 않고 실행 · progress 줄은 그때그때 화면에 · 원문(stderr)은 화면에 넘기지 않고 pack.log 에만
function runPack(args, { dir = config.athenaDir, onProgress = null, signal = null } = {}) {
  return new Promise((resolve) => {
    if (!dir) return resolve({ ok: false, error: 'not-found', message: say('error.athenaCoreUnset') })
    const nodePath = core.findExecutable('node', process.env.PATH)
    const env = core.childEnv(process.env, nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' })
    let child
    try {
      child = spawn(nodePath || process.execPath, [packScript(dir), 'pack', ...args, '--json'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
      if (errors.trim()) fs.appendFile(packLogFile(), `\n── ${new Date().toISOString()} pack ${args[0]}\n${errors.slice(-20000)}`, () => {})
      resolve(result)
    }
    // 시간 초과 · 취소는 SIGTERM — 본체가 임시본을 지우거나 되돌리고 끝낸다(5절). 결과는 프로세스가 실제로 끝난 뒤에(그 전에 다음 단계로 가지 않게).
    // 15초 안에 안 끝나면 SIGKILL
    let forced = null
    const stop = (reason) => {
      if (forced) return
      forced = { ok: false, error: reason }
      child.kill('SIGTERM')
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 15000).unref()
    }
    // R3 — 팩을 바꾸는 명령(use · new · import --replace)은 시간이 넘어도 끄지 않는다(중간에 끊으면 반쯤 바뀐다). "오래 걸려요" 만 알리고 기다린다
    const changesPack = ['use', 'new'].includes(args[0]) || (args[0] === 'import' && args.includes('--replace'))
    const slow = () => onProgress && onProgress({ step: 'slow', text: say('pack.step.slow') })
    const timer = changesPack ? setInterval(slow, PACK_TIMEOUTS[args[0]] || 60000) : setTimeout(() => stop('timeout'), PACK_TIMEOUTS[args[0]] || 60000)
    if (signal) signal.addEventListener('abort', () => stop('canceled'), { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      const split = packModel.splitLines(rest, chunk)
      rest = split.rest
      for (const line of split.lines) {
        const step = packModel.parseProgressLine(line, say)
        // 본체 설명은 한국어(D4 밖) — 한국어가 아니면 아는 단계는 사전 이름으로 보인다
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

// 켤 때 시작 화면을 띄울지 — 창을 만든 뒤 처음 목록을 읽을 때 한 번만 정한다(그 뒤로는 화면이 '들어갔음' 을 기억한다 · createWindow 가 비운다)
let launchWelcome = null
async function decideLaunchWelcome(listed) {
  if (launchWelcome !== null || !listed.supported) return
  const listedPanes = await daemonCall('pane list')
  const agentPanes = ((listedPanes.result && listedPanes.result.panes) || []).filter((pane) => pane.agent).length
  launchWelcome = packModel.welcomeOnLaunch({ list: listed, agentPanes })
}

async function refreshPacks() {
  if (!core.checkAthenaDir(config.athenaDir).ok) {
    packState = { supported: false }
  } else {
    const listed = packModel.normalizePackList(await runPack(['list']))
    await decideLaunchWelcome(listed)
    // welcome — 팩이 하나도 없을 때 시작 화면 · launchWelcome — 켤 때 시작 화면(팩이 있어도) · recent — 시작 화면 '내 팩' 목록. 규칙은 pack.js 한 곳에서만
    packState = { ...listed, welcome: packModel.showPackWelcome(listed), launchWelcome: launchWelcome === true, recent: packModel.recentPacks(listed) }
  }
  send('pack:state', packState)
  return packState
}

const packProgress = (step) => send('pack:progress', step)

// 본체 busy 의 에이전트가 스튜디오 pane 안인지 가릴 재료 — pane 셸 pid(데몬 'pane pids' · 옛 데몬은 없음) + 프로세스 부모 표(ps 의 pid · ppid 만)
async function packEvidence() {
  const listed = await daemonCall('pane list')
  const state = await daemonCall('state')
  if (listed.error || state.error) return null
  const pids = await daemonCall('pane pids')
  const pidOf = (pids.result && pids.result.pids) || {}
  const panes = (listed.result.panes || []).map((pane) => ({ ...pane, pid: Number.isInteger(pidOf[pane.id]) ? pidOf[pane.id] : null }))
  const parentOf = await new Promise((resolve) =>
    execFile('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null)
      const table = new Map()
      for (const line of stdout.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number)
        if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid)
      }
      resolve(table)
    }),
  )
  return { panes, workspaces: state.result.workspaces || [], parentOf }
}

// 스튜디오가 끌 수 없는 에이전트 줄 — 밖에서 도는 것 · 가릴 수 없는 것(옛 데몬이면 pane pid 를 모른다)
function outsideItems(check) {
  if (check.unknownAgents) return [{ kind: 'outside', what: say('pack.outside.unknown') }]
  return check.externalAgents ? [{ kind: 'outside', what: say('pack.outside.count', { count: check.externalAgents }) }] : []
}

// 닫을 pane 을 가리는 폴더 — 본체 + 데이터 폴더. 데이터 폴더는 코어 pack status 의 dataDir(R1), 옛 응답이면 ATHENA_DATA_DIR → ~/athena-data
const packDirs = () => [config.athenaDir, packDataDir || process.env.ATHENA_DATA_DIR || path.join(app.getPath('home'), 'athena-data')]

// 바꾸기 · 새로 만들기 · 지금 팩 교체 전에 — 일하는 에이전트를 기다리거나 멈추고, 팩에 묶인 pane 을 닫고, 남은 작업이 없는지 본체에 묻는다.
// 화면의 working/idle 은 안내일 뿐 — 마지막 판단은 본체 busy(스튜디오 밖 에이전트 · 무거운 명령 · 바꾸기 중. QA · 배우기 검토는 코어가 끈다)
async function quiesceForPack(mode, signal) {
  const listPanes = packEvidence
  await refreshPackStatus(config.athenaDir) // 데이터 폴더(R1)를 새로
  const checkWith = (screenState, busy) => packModel.switchCheck({ panes: screenState.panes, busy, parentOf: screenState.parentOf, workspaces: screenState.workspaces, athenaDirs: packDirs(), resolve: core.realDir })
  let screenNow = await listPanes()
  if (!screenNow) return { ok: false, error: 'busy', message: say('pack.error.paneListUnreadable') }

  // 1) 스튜디오도 코어도 끄지 않는 것(무거운 명령 · 바꾸기 중 · 밖에서 도는 에이전트)이 있으면 아무것도 닫지 않고 멈춘다
  const busyFirst = await runPack(['busy'])
  if (!busyFirst.ok) return busyFirst
  const first = checkWith(screenNow, busyFirst.busy)
  if (!first.canProceed) return { ok: false, error: 'busy', busy: [...first.blockers, ...outsideItems(first)] }

  // 2) 일하는 에이전트 — 끝나길 기다리거나(Esc 로) 멈춘다
  if (first.working.length && mode === 'stop') {
    packProgress({ step: 'studio-stop', text: say('pack.progress.stopping', { count: first.working.length }) })
    for (const paneId of first.working) await daemonCall('input', { pane: paneId, data: '\x1b' })
  }
  // 기다리기 · 멈추기는 닫을 pane 안의 에이전트만(R2 — 다른 프로젝트 claude 는 기다리지 않는다)
  const targets = new Set(first.close)
  const deadline = mode === 'stop' ? Date.now() + 30000 : Infinity
  for (;;) {
    if (signal && signal.aborted) return { ok: false, error: 'canceled' }
    const working = screenNow.panes.filter((pane) => targets.has(pane.id) && pane.agent && pane.agent_status === 'working')
    if (!working.length) break
    if (Date.now() > deadline) return { ok: false, error: 'busy', message: say('pack.error.stopTimeout', { count: working.length }) }
    if (mode !== 'stop') packProgress({ step: 'studio-wait', text: say('pack.progress.waiting', { count: working.length }) })
    await new Promise((resolve) => setTimeout(resolve, 2000))
    screenNow = (await listPanes()) || screenNow
  }

  // 3) 닫기 직전에 다시 — 기다리는 사이 무거운 명령 · 밖의 에이전트 같은 막는 작업이 생겼으면 아무것도 닫지 않고 멈춘다
  const fresh = await listPanes()
  const busyAgain = await runPack(['busy'])
  if (!fresh || !busyAgain.ok) return busyAgain.ok ? { ok: false, error: 'busy', message: say('pack.error.paneListUnreadable') } : busyAgain
  const again = checkWith(fresh, busyAgain.busy)
  if (!again.canProceed) return { ok: false, error: 'busy', busy: [...again.blockers, ...outsideItems(again)] }
  if (again.working.length) return { ok: false, error: 'busy', message: say('pack.error.restarted', { count: again.working.length }) }
  // 팩에 묶인 pane 닫기(1단계는 저장 없이 — 돌아오면 계획서 Checkpoint 로). 여기부터는 취소할 수 없다
  if (signal && signal.aborted) return { ok: false, error: 'canceled' }
  packProgress({ step: 'studio-close', text: say('pack.step.studio-close'), cancellable: false })
  const closing = again.close
  packProgress({ step: 'studio-close', text: say('pack.progress.closing', { count: closing.length }) })
  for (const paneId of closing) await daemonCall('pane close', { pane: paneId })

  // 4) 정말 끝났는지 — pane 이 사라지고 본체 busy 가 빌 때까지(최대 20초)
  packProgress({ step: 'studio-busy', text: say('pack.step.studio-busy') })
  let lastBusy = []
  for (let attempt = 0; attempt < 20; attempt++) {
    const now = await listPanes()
    const remaining = now ? now.panes.filter((pane) => closing.includes(pane.id)).length : closing.length
    const busy = await runPack(['busy'])
    lastBusy = busy.ok ? packModel.remainingBusy(busy.busy) : lastBusy
    // QA · 배우기 검토는 코어가 pack use 때 끈다(5.2 · Q7) — 기다리지 않는다
    if (!remaining && busy.ok && !packModel.remainingBusy(busy.busy).length) return { ok: true, closed: closing.length }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return { ok: false, error: 'busy', message: say('pack.error.notFinished'), busy: lastBusy }
}

// 바꾸는 동안 멈추는 것 — 트레이 폴링 · 에이전트 모니터. 끝나면 모니터 기록을 비우고 바꾼 뒤 시각부터 다시 읽는다
function pausePackWatchers(on) {
  trayState.packPaused = on
  if (on) return
  monitor.tails.clear()
  monitor.events = []
  monitor.floor = Date.now()
  trayHistory.length = 0
  send('monitor:update', { reset: true, sessions: [], events: [] })
}

// 한 번에 하나 — 같은 요청이 두 번 와도 두 번째는 busy
async function packTask(name, work) {
  if (packBusy) return { ok: false, error: 'locked', message: say('pack.error.taskBusy', { task: packBusy }) }
  packBusy = name
  packAbort = new AbortController()
  try {
    return await work(packAbort.signal)
  } finally {
    packBusy = null
    packAbort = null
  }
}

// 바꾸기 전 점검 — 화면이 [끝나면 바꾸기] · [멈추고 바꾸기] 를 물을지 정하게
async function packCheck() {
  const evidence = await packEvidence()
  if (!evidence) return { ok: false, error: 'busy', message: say('pack.error.paneListUnreadable') }
  await refreshPackStatus(config.athenaDir)
  const busy = await runPack(['busy'])
  if (!busy.ok) return { ...busy, text: packModel.packErrorText(busy, say) }
  const check = packModel.switchCheck({ panes: evidence.panes, busy: busy.busy, parentOf: evidence.parentOf, workspaces: evidence.workspaces, athenaDirs: packDirs(), resolve: core.realDir })
  return { ok: true, working: check.working.length, closing: check.close.length, canProceed: check.canProceed, blockers: packModel.busyLines([...check.blockers, ...outsideItems(check)], say) }
}

// 팩 바꾸기 · 새로 만들기 공통 — 정리(quiesce) → 본체 명령 → 현황판 다시 → 화면에 알림. 실패하면 본체가 되돌린 팩으로 다시 맞춘다
async function packChange(command, mode, signal) {
  const athenaDir = config.athenaDir
  pausePackWatchers(true)
  try {
    const quiet = await quiesceForPack(mode, signal)
    if (!quiet.ok) return { ...quiet, text: packModel.packErrorText(quiet, say) }
    const result = await runPack(command, { dir: athenaDir, onProgress: packProgress })
    await refreshPacks()
    // 성공이든 되돌림이든 지금 팩의 현황판으로(코어는 끄기만 한다 — 다시 띄우는 건 스튜디오)
    packProgress({ step: 'studio-board', text: say('pack.step.studio-board') })
    const board = await ensureBoard()
    send('pack:changed', { ok: result.ok, current: packState.current })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return { ...result, board: board.ok ? null : board.error }
  } finally {
    pausePackWatchers(false)
  }
}

const packSwitch = (id, mode) =>
  packTask(say('pack.task.switch'), async (signal) => {
    if (typeof id !== 'string' || !packState.packs || !packState.packs.some((item) => item.id === id)) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    if (packState.current && packState.current.id === id) return { ok: true, same: true }
    return packChange(['use', id], mode === 'stop' ? 'stop' : 'wait', signal)
  })

const packNew = (mode) => packTask(say('pack.task.new'), (signal) => packChange(['new'], mode === 'stop' ? 'stop' : 'wait', signal))

// 가져오기 검사 — 파일 · 폴더 · 기존 아테나는 main 이 대화상자를 연다(화면이 경로를 만들지 않게), git 은 주소를 검사해 넘긴다
async function packInspect(kind, source) {
  let target = null
  if (kind === 'git') {
    target = packModel.validGitUrl(source)
    if (!target) return { ok: false, error: 'invalid-url', text: say('pack.error.invalidGitUrl') }
  } else if (kind === 'athena' && typeof source === 'string' && source === pendingAthenaImport) {
    target = source // 시작할 때 고른 "옮기기" — 대화상자 없이
    pendingAthenaImport = null
  } else {
    const options = {
      file: { title: say('dialog.packFile.title'), properties: ['openFile'], filters: [{ name: say('dialog.packFile.filter'), extensions: ['gz', 'tgz'] }] },
      folder: { title: say('dialog.packFolder.title'), properties: ['openDirectory'] },
      athena: { title: say('dialog.packAthena.title'), properties: ['openDirectory'] },
    }[kind]
    if (!options) return { ok: false, error: 'invalid-pack', text: say('pack.error.unknownImportKind') }
    const picked = await dialog.showOpenDialog(mainWindow, { ...options, defaultPath: app.getPath('home') })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    target = picked.filePaths[0]
  }
  return packTask(say('pack.task.inspect'), async (signal) => {
    const result = await runPack([kind === 'athena' ? 'import-athena' : 'inspect', target], { onProgress: packProgress, signal })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return {
      ...result,
      source: kind === 'git' ? target : path.basename(target),
      summary: { incoming: packModel.packSummary({ ...result.pack, source: kind === 'git' ? 'git' : null }, say), existing: packModel.packSummary(result.conflict, say) },
      current: Boolean(result.conflict && packState.current && result.conflict.id === packState.current.id),
    }
  })
}

// 검사한 임시본 등록 — keep(버림) · replace(기존 자동 백업 후 교체) · new. 지금 켜진 팩을 교체하면 바꾸기와 같은 정리를 먼저
async function packImport(token, choice, mode) {
  if (typeof token !== 'string' || !['keep', 'replace', 'new'].includes(choice)) return { ok: false, error: 'invalid-pack', text: say('pack.error.badImportRequest') }
  return packTask(say('pack.task.import'), async (signal) => {
    if (choice === 'replace' && mode) return packChange(['import', token, '--replace'], mode, signal) // 지금 켜진 팩 교체 — 바꾸기와 같은 정리 먼저
    const result = await runPack(['import', token, `--${choice}`], { onProgress: packProgress })
    await refreshPacks()
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  })
}

// 내보내기(팀에 주는 것 — 허용 목록만) · 내 백업(팩 + 작업 기록) — 저장 폴더를 고르고 명령 → 결과
async function packExport(kind) {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'backup' ? say('dialog.packBackup.title') : say('dialog.packExport.title'),
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('downloads'),
  })
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
  const args = kind === 'backup' ? ['backup', '--with-work', '--out', picked.filePaths[0]] : ['export', '--out', picked.filePaths[0]]
  return packTask(kind === 'backup' ? say('pack.task.backup') : say('pack.task.export'), async () => {
    const result = await runPack(args, { onProgress: packProgress })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    lastPackFile = typeof result.file === 'string' ? result.file : null
    return result
  })
}

// [Finder 에서 보기] — 방금 만든 파일만
let lastPackFile = null
function packReveal() {
  if (lastPackFile && fs.existsSync(lastPackFile)) shell.showItemInFolder(lastPackFile)
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

async function stopStaleBoard(port) {
  const token = await runPack(['board-token'])
  if (!token.ok || typeof token.token !== 'string') return false
  const origin = `http://localhost:${port}`
  await boardJson(port, '/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-board-token': token.token } })
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await isBoardUp(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

// ── 새 창 · 링크 ──────────────────────────────────────────
// 터미널 링크 · 맨 위 페이지 이동 — localhost(계획서 · 테스트 화면)는 옆 브라우저, 그 밖 http(s) 는 기본 브라우저
function openUrl(url, { fromBoard = false } = {}) {
  const target = core.openTarget(url, { fromBoard })
  if (target === 'external') shell.openExternal(url)
  if (target === 'panel') openInBrowser(url)
  return target
}

// 새 창 요청 — 메인 창에서 온 것은 현황판 iframe 이 연 것이라 http(s) 면 모두 옆 브라우저.
// 옆 브라우저 안에서 연 새 창은 같은 뷰로. 새 BrowserWindow 는 만들지 않는다
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (browserView && contents === browserView.webContents) {
      if (core.isWebUrl(url)) contents.loadURL(url)
    } else {
      openUrl(url, { fromBoard: Boolean(mainWindow) && contents === mainWindow.webContents })
    }
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

// ── 옆 브라우저 ───────────────────────────────────────────
// 작업 창 · 현황판 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그리고(아무 사이트 · 로그인 쿠키 유지),
// 화면은 서랍 안 자리(#browser-slot)의 사각형만 알려 준다. 페이지에는 preload · Node 를 넘기지 않는다
const BROWSER_PARTITION = 'persist:studio-browser'
let browserView = null
let browserAttached = false

function ensureBrowserView() {
  if (browserView && !browserView.webContents.isDestroyed()) return browserView
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  // 카메라 · 마이크 · 알림 · 위치 같은 권한은 묻지 않고 거절한다
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  browserView = new WebContentsView({
    webPreferences: { partition: BROWSER_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  browserView.setBackgroundColor('#ffffff')
  const contents = browserView.webContents
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
function openInBrowser(url) {
  ensureBrowserView().webContents.loadURL(url)
  send('browser:open', url)
  if (mainWindow) mainWindow.show()
}

// 화면 좌표(CSS 픽셀)는 확대·축소 비율을 곱해야 창 좌표가 된다. 창 안으로 자른다
function placeBrowser(rect) {
  if (!mainWindow || !rect) return
  const view = ensureBrowserView()
  const zoom = mainWindow.webContents.getZoomFactor()
  const [contentWidth, contentHeight] = mainWindow.getContentSize()
  const x = Math.min(Math.max(0, Math.round(rect.x * zoom)), contentWidth)
  const y = Math.min(Math.max(0, Math.round(rect.y * zoom)), contentHeight)
  const width = Math.min(Math.max(0, Math.round(rect.width * zoom)), contentWidth - x)
  const height = Math.min(Math.max(0, Math.round(rect.height * zoom)), contentHeight - y)
  view.setBounds({ x, y, width, height })
  if (!browserAttached) {
    mainWindow.contentView.addChildView(view)
    browserAttached = true
  }
}

// 서랍을 닫기 시작할 때 먼저 뗀다(페이지가 화면 위에 떠 있으니 슬라이드 전에 치운다). 페이지는 그대로 두어 다시 열면 이어 본다
function hideBrowser() {
  if (!mainWindow || !browserView || !browserAttached) return
  mainWindow.contentView.removeChildView(browserView)
  browserAttached = false
}

function browserCommand(name, value) {
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

// ── 메뉴 막대(Tray) ─────────────────────────────────────────
// 맥 상단 메뉴 막대 아이콘 — 누르면 확인 필요 · 에이전트 · 사용량 · 바로가기. 막힘 · 응답 끝 · 리뷰 대기 · 완료는 맥 알림.
// 창이 숨어 있어도 4초마다 pane 목록, 15초마다 현황판 상태(/api/state — 현황판을 띄우지는 않는다)를 본다.
// 알림 문구에는 이름 · 작업 공간 · 계획서 제목만(명령 · 지시 내용은 넣지 않는다)
const TRAY_ICON_DIR = path.join(__dirname, 'renderer', 'assets', 'logo')
const trayState = { panes: [], workspaces: [], focused: null, uiTab: 'work', boardOkAt: 0, cards: null, usage: [], boardUp: false, boardAt: 0, pausedUntil: 0, polling: false, packPaused: false }
const trayNotifier = new trayModel.Notifier()
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
  if (name === 'show') showWindow(value === 'work' || value === 'board' ? value : undefined)
  if (name === 'menu') tray.popUpContextMenu(Menu.buildFromTemplate(trayShortMenu()))
  if (name !== 'menu' && trayWindow) trayWindow.hide()
})

function trayNames() {
  return new Map(trayState.workspaces.map((workspace) => [workspace.id, workspace.label]))
}

async function pollTray() {
  // 이미 붙은 데몬만 읽는다 — 끊겼을 때 숨은 채로 데몬을 띄우거나 버전 확인 대화상자를 띄우지 않게(화면이 다시 붙으면 이어서)
  if (trayState.polling || trayState.packPaused || !daemon || !core.checkAthenaDir(config.athenaDir).ok) return
  trayState.polling = true
  try {
    const listed = await trayCall('pane list')
    const state = await trayCall('state')
    // 못 읽었으면 이번엔 알림 판단을 건너뛴다(예전 목록으로 시간을 재지 않게)
    const panesOk = Boolean(listed.result && state.result)
    if (panesOk) {
      trayState.panes = listed.result.panes
      trayState.workspaces = state.result.workspaces
      trayState.focused = state.result.focused
      trayHistory.push({ at: Date.now(), working: trayState.panes.filter((pane) => pane.agent && pane.agent_status === 'working').length })
      while (trayHistory.length && Date.now() - trayHistory[0].at > 30 * 60000) trayHistory.shift()
    }
    let cards = null
    if (Date.now() - trayState.boardAt > 15000) {
      trayState.boardAt = Date.now()
      const board = await fetchBoardState()
      trayState.boardUp = Boolean(board)
      if (board) {
        trayState.boardOkAt = Date.now()
        trayState.cards = board.cards || []
        trayState.usage = (board.header && board.header.usage) || []
        cards = trayState.cards
      } else {
        // 꺼졌으면 예전 카드 · 사용량을 지금 값처럼 보이지 않게
        trayState.cards = null
        trayState.usage = []
      }
    }
    refreshTray()
    if (panesOk) {
      const due = trayNotifier.update({ panes: trayState.panes, cards, names: trayNames(), say }, Date.now())
      // 지금 보고 있는 pane 은 빼고 묶는다
      for (const item of trayModel.bundle(due.filter((entry) => !lookingAt(entry)), say)) notify(item)
    }
    if (trayWindow && trayWindow.isVisible()) sendTrayUpdate()
  } catch {
  } finally {
    trayState.polling = false
  }
}

// 메뉴 막대 폴링 전용 — 이미 붙은 연결로만 묻는다(daemonCall 은 끊겼으면 데몬을 다시 띄우거나 버전 확인창을 띄운다)
async function trayCall(op) {
  const connection = daemon
  if (!connection) return { error: say('tray.daemonOffline') }
  try {
    return { result: await connection.call(op, {}) }
  } catch (error) {
    return { error: error.message }
  }
}

// 현황판이 떠 있으면 그 상태를 읽는다 — 어떤 실패든 한 번 null(0건으로 치지 않는다)
function fetchBoardState() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = http.get({ host: '127.0.0.1', port: boardPortNow(), path: '/api/state', timeout: 2000 }, (response) => {
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
  return trayModel.summarize({ panes: trayState.panes, workspaces: trayState.workspaces, cards: trayState.cards || [], usage: trayState.usage, boardUp: trayState.boardUp, say })
}

function refreshTray() {
  if (!tray) return
  const summary = traySummary()
  // 아이콘 옆 숫자는 두지 않는다(사용자) — 막힘이 있으면 빨간 점만
  setTrayIcon(summary.counts.blocked > 0)
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

// 창을 다시 보이게 — tab 을 주면 그 탭으로(work · board)
function showWindow(tab) {
  if (!mainWindow) createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (tab) send('tab:switch', tab)
}

async function focusPaneFromTray(paneId) {
  showWindow('work')
  // 데몬과 화면 연결이 끊겨 있었으면 다시 붙인다
  if (screenDetached) send('screen:resync')
  await daemonCall('focus', { pane: String(paneId) })
}

// 계획서 결정 콘솔이 있으면 옆 브라우저로, 없으면 현황판 탭
function openCardFromTray(html) {
  if (html) {
    showWindow()
    openInBrowser(`${core.boardUrl(boardPortNow()).replace(/\/$/, '')}/${html.split('/').map(encodeURIComponent).join('/')}`)
  } else {
    showWindow('board')
  }
}

// 지금 보고 있는 pane 이면(앱이 앞에 있고 작업 창 탭 · 그 pane 포커스) 알리지 않는다
function lookingAt(item) {
  return Boolean(item.target.pane) && Boolean(mainWindow) && mainWindow.isVisible() && mainWindow.isFocused() && trayState.uiTab === 'work' && trayState.focused === item.target.pane
}

function notify(item) {
  if (trayState.pausedUntil > Date.now() || !Notification.isSupported()) return
  const notification = new Notification({ title: item.title, body: item.body, silent: true })
  notification.on('click', () => (item.target.pane ? focusPaneFromTray(item.target.pane) : openCardFromTray(item.target.html)))
  notification.show()
}

// ── 창 · 메뉴 ─────────────────────────────────────────────
function createWindow() {
  // 창을 새로 만들 때마다(맥에서 창만 닫았다 다시 열기 포함) 켤 때 시작 화면을 다시 정한다 — 그 사이 에이전트가 돌기 시작했으면 건너뛰게
  launchWelcome = null
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'Athena',
    titleBarStyle: isMac ? 'hiddenInset' : 'default', // 맥은 탭 줄이 제목 줄을 겸한다
    backgroundColor: '#16171a',
    icon: APP_ICON, // 맥은 무시한다(Dock 은 whenReady 에서) — 윈도우·리눅스 창 아이콘
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
  // 맥은 창을 닫아도 메뉴 막대에 남는다(숨기기) — 완전히 끄는 것은 [Athena 종료] · ⌘Q
  mainWindow.on('close', (event) => {
    if (!isMac || quitting) return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // 서랍에서 떼어 둔 뷰는 창과 함께 정리되지 않는다 — 직접 닫는다
    if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close()
    browserView = null
    browserAttached = false
    detachScreen()
  })
}

// 메뉴 [보기 → 언어] — 언어 이름은 그 언어로, 검수 전 사전은 그 언어의 '검수 전' 표시를 붙인다(D5)
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

function buildMenu() {
  const template = [
    ...(isMac ? [appMenu()] : []),
    {
      label: say('menu.file'),
      submenu: [
        { label: say('menu.file.pack'), accelerator: `${TAB_KEY}+Shift+P`, click: () => send('pack:command', 'picker') },
        { label: say('menu.file.packImport'), click: () => send('pack:command', 'import') },
        { label: say('menu.file.packExport'), click: () => send('pack:command', 'export') },
        { label: say('menu.file.backup'), click: () => send('pack:command', 'backup') },
        { type: 'separator' },
        { label: say('menu.file.pickAthena'), click: () => send('athena:pick') },
        { type: 'separator' },
        { label: say('menu.file.newTab'), accelerator: `${TAB_KEY}+T`, click: () => send('screen:command', 'new-tab') },
        { label: say('menu.file.newWorkspace'), accelerator: `${TAB_KEY}+Shift+T`, click: () => send('screen:command', 'new-workspace') },
        { label: say('menu.file.closePane'), accelerator: `${TAB_KEY}+W`, click: () => send('screen:command', 'close-pane') },
        { label: say('menu.file.closeTab'), accelerator: `${TAB_KEY}+Alt+W`, click: () => send('screen:command', 'close-tab') },
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
        { label: say('menu.view.work'), accelerator: `${TAB_KEY}+1`, click: () => send('tab:switch', 'work') },
        { label: say('menu.view.board'), accelerator: `${TAB_KEY}+2`, click: () => send('tab:switch', 'board') },
        { type: 'separator' },
        { label: say('menu.view.reloadBoard'), accelerator: 'CmdOrCtrl+R', click: () => send('board:reload') },
        { label: say('menu.view.browser'), accelerator: `${TAB_KEY}+Shift+B`, click: () => send('browser:toggle') },
        { label: say('menu.view.reattach'), click: () => send('screen:resync') },
        { label: say('menu.view.restartDaemon'), click: () => restartDaemon() },
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
        { label: say('menu.pane.splitRight'), accelerator: `${TAB_KEY}+D`, click: () => send('screen:command', 'split-right') },
        { label: say('menu.pane.splitDown'), accelerator: `${TAB_KEY}+Shift+D`, click: () => send('screen:command', 'split-down') },
        { type: 'separator' },
        { label: say('menu.pane.focusLeft'), accelerator: `${TAB_KEY}+Alt+Left`, click: () => send('screen:command', 'focus-left') },
        { label: say('menu.pane.focusRight'), accelerator: `${TAB_KEY}+Alt+Right`, click: () => send('screen:command', 'focus-right') },
        { label: say('menu.pane.focusUp'), accelerator: `${TAB_KEY}+Alt+Up`, click: () => send('screen:command', 'focus-up') },
        { label: say('menu.pane.focusDown'), accelerator: `${TAB_KEY}+Alt+Down`, click: () => send('screen:command', 'focus-down') },
        { type: 'separator' },
        { label: say('menu.pane.tabPrev'), accelerator: `${TAB_KEY}+Shift+[`, click: () => send('screen:command', 'tab-prev') },
        { label: say('menu.pane.tabNext'), accelerator: `${TAB_KEY}+Shift+]`, click: () => send('screen:command', 'tab-next') },
        { label: say('menu.pane.workspacePrev'), accelerator: `${TAB_KEY}+Shift+Up`, click: () => send('screen:command', 'workspace-prev') },
        { label: say('menu.pane.workspaceNext'), accelerator: `${TAB_KEY}+Shift+Down`, click: () => send('screen:command', 'workspace-next') },
        { type: 'separator' },
        // VSCode 와 같게 — ⌘B 왼쪽 · ⌘⌥B 오른쪽
        { label: say('menu.pane.toggleSpaces'), accelerator: `${TAB_KEY}+B`, click: () => send('screen:command', 'toggle-spaces') },
        { label: say('menu.pane.togglePanel'), accelerator: `${TAB_KEY}+Alt+B`, click: () => send('screen:command', 'toggle-panel') },
      ],
    },
    windowMenu(),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC ──────────────────────────────────────────────────
// 언어 사전 — preload 가 처음 한 번 동기로 받는다(화면이 첫 글자를 그리기 전에). 읽기 전용 데이터
ipcMain.on('i18n:get', (event) => (event.returnValue = i18nPayload()))
ipcMain.handle('athena:state', () => athenaState())
ipcMain.handle('athena:pick', () => pickAthenaDir())
ipcMain.handle('athena:install', () => installAthena())
// 회사 팩 — 본체 명령을 부르고 결과만 화면에(5절 약속). 문자열 · 고른 값만 받는다
ipcMain.handle('pack:list', () => refreshPacks())
ipcMain.handle('pack:check', () => packCheck())
ipcMain.handle('pack:switch', (_event, id, mode) => packSwitch(String(id), String(mode)))
ipcMain.handle('pack:new', (_event, mode) => packNew(String(mode)))
ipcMain.handle('pack:cancel', () => {
  if (packAbort) packAbort.abort()
  return { ok: true }
})
ipcMain.handle('pack:inspect', (_event, kind, source) => packInspect(String(kind), typeof source === 'string' ? source : null))
ipcMain.handle('pack:import', (_event, token, choice, mode) => packImport(String(token), String(choice), mode === 'wait' || mode === 'stop' ? mode : null))
ipcMain.handle('pack:export', (_event, kind) => packExport(kind === 'backup' ? 'backup' : 'share'))
ipcMain.handle('pack:reveal', () => packReveal())
// 시작할 때 "옮기기" 를 골랐으면 화면이 붙은 뒤 기존 아테나 가져오기를 이어서 연다
ipcMain.handle('pack:pending-import', () => pendingAthenaImport)
ipcMain.handle('screen:attach', () => attachScreen())
ipcMain.handle('agent:open', (_event, chosen, size) => openAthenaAgent(typeof chosen === 'string' ? chosen : null, cellSize(size)))
ipcMain.handle('tab:new', (_event, size) => daemonCall('tab new', { defaultCwd: config.athenaDir, ...cellSize(size) }))
ipcMain.handle('tab:select', (_event, tabId) => daemonCall('tab select', { tab: String(tabId) }))
ipcMain.handle('tab:close', (_event, tabId) => closeTab(String(tabId)))
// 탭 이름 바꾸기 — 비우면 데몬이 이름을 지워 화면이 기본 이름(탭 N)을 쓴다
ipcMain.handle('tab:rename', (_event, tabId, label) => daemonCall('tab rename', { tab: String(tabId), label: typeof label === 'string' ? label.trim().slice(0, 60) : '' }))
ipcMain.handle('workspace:select', (_event, workspaceId) => daemonCall('workspace select', { workspace: String(workspaceId) }))
ipcMain.handle('workspace:new', (_event, size) => newWorkspace(cellSize(size)))
ipcMain.on('monitor:watch', (_event, on) => setMonitorWatch(on === true))
ipcMain.handle('explorer:list', (_event, workspaceId, relative) => guarded(() => explorerList(workspaceId, relative)))
ipcMain.handle('explorer:status', (_event, workspaceId) => guarded(() => explorerStatus(workspaceId)))
ipcMain.handle('explorer:open', (_event, workspaceId, relative) => guarded(() => explorerOpen(workspaceId, relative)))
ipcMain.handle('pane:split', (_event, paneId, direction) => daemonCall('pane split', { target: String(paneId), direction: direction === 'down' ? 'down' : 'right' }))
ipcMain.handle('pane:close', (_event, paneId) => closePane(String(paneId)))
ipcMain.on('pane:focus', (_event, paneId) => daemon && daemon.notify('focus', { pane: String(paneId) }))
ipcMain.on('pane:input', (_event, paneId, data) => {
  if (daemon && typeof data === 'string') daemon.notify('input', { pane: String(paneId), data })
})
ipcMain.on('pane:resize', (_event, paneId, cols, rows) => {
  if (daemon && cols > 1 && rows > 1) daemon.notify('resize', { pane: String(paneId), cols: cols | 0, rows: rows | 0 })
})
ipcMain.on('tab:size', (_event, tabId, size) => {
  const cells = cellSize(size)
  if (daemon && cells.cols) daemon.notify('tab size', { tab: String(tabId), ...cells })
})
// pane 경계를 끈 결과를 데몬 탭 트리에 — 옛 데몬은 이 동작을 몰라 usage 로 답한다(그땐 화면이 임시로 기억한다)
ipcMain.handle('tab:ratio', async (_event, tabId, path, ratio) => {
  if (typeof tabId !== 'string' || !Array.isArray(path) || !path.every((step) => step === 'first' || step === 'second') || typeof ratio !== 'number') {
    return { error: '잘못된 경계 값' }
  }
  const reply = await daemonCall('tab ratio', { tab: tabId, path, ratio })
  if (reply.error && reply.code === 'usage' && /모르는 동작/.test(reply.error)) return { unsupported: true }
  return reply
})
ipcMain.handle('board:ensure', () => ensureBoard())
ipcMain.on('ui:tab', (_event, tab) => (trayState.uiTab = tab === 'board' ? 'board' : 'work'))
ipcMain.handle('open:url', (_event, url) => openUrl(String(url)))
// 옆 브라우저 IPC 는 앱 화면(메인 창의 맨 위 프레임)에서 온 것만 받는다 — 현황판 iframe · 서랍 안 페이지는 못 부른다
const fromAppScreen = (event) => Boolean(mainWindow) && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame
ipcMain.on('browser:place', (event, rect) => {
  if (fromAppScreen(event)) placeBrowser(browserRect(rect))
})
ipcMain.on('browser:hide', (event) => {
  if (fromAppScreen(event)) hideBrowser()
})
ipcMain.handle('browser:command', (event, name, value) => {
  if (!fromAppScreen(event)) return { error: '앱 화면에서만 부를 수 있어요' }
  return browserCommand(String(name), typeof value === 'string' ? value : '')
})

app.whenReady().then(async () => {
  app.setName('Athena Studio') // 앱 데이터 폴더 이름 — 바꾸면 설정 · 데몬 · 스튜디오 아테나가 옮겨진다
  // 보이는 이름은 Athena(메뉴 막대 · Dock 은 개발용 Athena.app — scripts/dev-app.js)
  app.setAboutPanelOptions({ applicationName: 'Athena' })
  // Dock 아이콘을 앱 아이콘으로(개발용 Athena.app 번들 아이콘과 같다 — 원본 Electron 으로 켜졌을 때도)
  if (isMac && app.dock) app.dock.setIcon(APP_ICON)
  config = core.loadConfig(configFile())
  language = i18n.pickLanguage(config.language, app.getLocale())
  await offerMoveToHome()
  if (core.checkAthenaDir(config.athenaDir).ok) {
    try {
      core.ensureAthenaConfig(config.athenaDir, athenaReposRoot(config.athenaDir))
    } catch {}
  }
  const loginPath = await loadLoginPath()
  if (loginPath) process.env.PATH = core.mergePath(loginPath, process.env.PATH)
  prepareBoardPort()
  buildMenu()
  createWindow()
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
  detachScreen()
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
