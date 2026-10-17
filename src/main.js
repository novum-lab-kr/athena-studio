// Athena Studio 메인 프로세스 — 창 · 메뉴(단축키) · 작업 창(데몬에 붙기) · 현황판 서버 · 아테나 폴더 설정
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, session, shell } = require('electron')
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const core = require('./lib/core')
const agentFeed = require('./lib/agent-feed')
const daemonClient = require('./daemon-client')
const explorer = require('./lib/explorer')
const fileIcons = require('./lib/file-icons')
const viewer = require('./lib/viewer')

const isMac = process.platform === 'darwin'
// 앱 아이콘(화이트 로고) — Dock(맥) · 창 아이콘(그 밖)
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'logo', 'athena-white-512.png')
// Ctrl 조합은 pane 안(셸·에이전트) 몫이라 앱 단축키는 Cmd(맥) · Alt(그 밖)로만 건다
const TAB_KEY = isMac ? 'Command' : 'Alt'

let mainWindow = null
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
    installDir: core.installTarget(app.getPath('userData')).dir,
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
  core.daemonPaths({ userData: app.getPath('userData'), home: app.getPath('home'), tmpdir: app.getPath('temp'), uid: process.getuid() })

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
function onDaemonClosed() {
  daemon = null
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
    message: '작업 창 데몬이 이 앱과 버전이 달라요',
    detail: `데몬을 다시 띄우면 지금 열린 pane ${count}개(그 안의 에이전트 포함)가 모두 닫혀요.\n나중에 하면 옛 데몬으로 계속 쓰고, 새 기능 일부가 동작하지 않을 수 있어요.`,
    buttons: ['나중에', '지금 다시 띄우기'],
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
  if (!check.ok) return { error: '아테나 폴더가 정해지지 않았어요' }
  try {
    const connection = await connectDaemon()
    flushOutput()
    dropOutput = true
    try {
      const attached = await connection.call('attach', {}, () => {
        dropOutput = false
        outputQueue.clear()
      })
      // 예전 터미널 모니터 칸이 남아 있으면 닫는다(이제 모니터는 앱 화면)
      closeMonitorDock().catch(() => {})
      return attached
    } finally {
      dropOutput = false
    }
  } catch (error) {
    return { error: `작업 창 데몬에 붙지 못했어요: ${error.message}` }
  }
}

// 앱 종료·창 닫기 — 연결만 끊는다(데몬·셸·에이전트는 계속 돈다)
function detachScreen() {
  if (!daemon) return
  const current = daemon
  daemon = null
  current.close()
}

async function daemonCall(op, args) {
  try {
    const connection = await connectDaemon()
    return { result: await connection.call(op, args) }
  } catch (error) {
    return { error: error.message, code: error.code }
  }
}

// 개발용 — 데몬 파일을 고쳤을 때 새로 띄운다(모든 pane 이 닫힌다)
async function restartDaemon() {
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    message: '작업 창 데몬을 다시 띄울까요?',
    detail: '지금 열린 pane 이 모두 닫혀요(그 안의 에이전트 포함).',
    buttons: ['취소', '다시 띄우기'],
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
      message: `이 pane 에서 ${pane.agent} 가 돌고 있어요. 닫을까요?`,
      buttons: ['취소', '닫기'],
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
const MONITOR_LABEL = '🛰 에이전트 모니터'
const MONITOR_MINUTES = 120
const MONITOR_BACKLOG = 5 // 처음 붙을 때 세션마다 마지막 몇 개만
const MONITOR_HEAD_BYTES = 64 * 1024 // 처음 붙을 때 파일 끝에서 이만큼만 읽는다
const MONITOR_CHUNK_BYTES = 4 * 1024 * 1024
const MONITOR_KEEP = 300
const MONITOR_TEXT_MAX = 300
const monitor = { watching: false, timer: null, ticking: false, lastScan: 0, lastFullScan: 0, tails: new Map(), tailSeq: 0, events: [], seq: 0, agentCwds: [] }

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
  const since = Date.now() - MONITOR_MINUTES * 60000
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
  if (!monitor.watching || monitor.ticking) return
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
      message: `이 탭에서 ${agents.map((pane) => pane.agent).join(' · ')} 가 돌고 있어요. 탭을 닫을까요?`,
      buttons: ['취소', '닫기'],
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
    title: '새 작업 공간 — 폴더 고르기',
    properties: ['openDirectory'],
    // 아테나는 앱 데이터 폴더에 있으니 레포 고르기는 홈에서 시작한다
    defaultPath: app.getPath('home'),
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const dir = result.filePaths[0]
  return daemonCall('workspace create', { label: path.basename(dir), cwd: dir, focus: true, ...size })
}

// 에이전트 상태(agent · agent_status) — 보일 때만 2초마다 pane 목록을 받아 사이드바에 보낸다
let panesTimer = null
function startPanesPolling() {
  clearInterval(panesTimer)
  panesTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized() || !daemon) return
    const listed = await daemonCall('pane list')
    if (listed.result) {
      send('screen:panes', listed.result.panes)
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
  if (!workspace) throw new Error('없는 작업 공간이에요')
  return fs.promises.realpath(workspace.cwd)
}

// 상대 경로를 풀어(심볼릭 링크 포함) 루트 안인지 본다
async function resolveInside(root, relative) {
  const clean = explorer.cleanRelative(relative)
  if (clean === null) throw new Error('읽을 수 없는 경로예요')
  const real = await fs.promises.realpath(path.join(root, clean))
  if (!explorer.isInside(root, real)) throw new Error('작업 공간 밖이에요')
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
  if (!stat.isFile()) throw new Error('파일이 아니에요')
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
  if (decision.error) return { error: decision.error }
  if (decision.choose) return { choose: decision.choose }

  const created = await daemonCall('workspace create', { label: core.ATHENA_WORKSPACE, cwd: config.athenaDir, focus: true, ...size })
  if (created.error) return { error: `athena 작업 공간을 만들지 못했어요: ${created.error}` }
  if (decision.none) return { error: 'claude · codex 를 찾지 못했어요 — 설치한 뒤 athena 작업 공간에서 직접 켜 주세요' }
  const run = await daemonCall('pane run', { pane: created.result.root_pane.id, text: decision.agent })
  if (run.error) return { error: `${decision.agent} 을 켜지 못했어요` }
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
  if (!core.checkAthenaDir(config.athenaDir).ok) return Promise.resolve({ ok: false, url: core.boardUrl(config.boardPort), error: '아테나 폴더가 정해지지 않았어요' })
  return queueBoard(() => findOrStartBoard(config.athenaDir))
}

// 현황판은 띄우지 않고 포트만 미리 정해 적는다(앱 시작 · 아테나 폴더를 정할 때) — 현황판 탭을 열기 전에도 아테나가 콘솔을 맞는 포트로 띄우게
function prepareBoardPort() {
  if (!core.checkAthenaDir(config.athenaDir).ok) return
  const athenaDir = config.athenaDir
  queueBoard(() => findBoardPort(athenaDir)).catch(() => {})
}

// 저장된 포트부터 차례로 — 이 아테나 폴더에서 도는 현황판이면 그대로 쓰고, 비었으면 거기 띄우고, 다른 것(herdr 용 ~/athena 현황판 등)이나
// 주인을 모르는 것(lsof 실패)이 쥐고 있으면 다음 번호. 고른 포트는 스튜디오 아테나 설정(boardPort)과 앱 설정에 적는다 — pane 안의 아테나가 그 값으로 현황판을 찾는다
async function findBoardPort(athenaDir) {
  const ports = core.boardPortCandidates(config.boardPort)
  for (const port of ports) {
    const owner = await boardOwner(port, athenaDir)
    if (owner === 'other') continue
    // 찾는 사이 아테나 폴더가 바뀌었으면 이 결과는 버린다
    if (config.athenaDir !== athenaDir) return { error: '아테나 폴더가 바뀌었어요 — 다시 시도해요' }
    const saved = rememberBoardPort(port, athenaDir)
    if (saved.error) return saved
    return { port, owner }
  }
  return { error: `현황판 포트 ${ports[0]}~${ports[ports.length - 1]} 가 모두 쓰이고 있어요` }
}

async function findOrStartBoard(athenaDir) {
  const result = await findOrStartBoardFor(athenaDir)
  // 띄우거나 기다리는 사이 아테나 폴더가 바뀌었으면 예전 폴더의 현황판을 보여 주지 않는다
  if (config.athenaDir !== athenaDir) return { ok: false, url: core.boardUrl(config.boardPort), error: `아테나 폴더가 바뀌었어요 — ${isMac ? '⌘' : 'Alt+'}R 로 다시 열어요` }
  return result
}

async function findOrStartBoardFor(athenaDir) {
  const found = await findBoardPort(athenaDir)
  if (found.error) return { ok: false, url: core.boardUrl(config.boardPort), error: found.error }
  if (found.owner === 'free') return startBoard(found.port, athenaDir)
  const url = core.boardUrl(found.port)
  if (await isBoardUp(found.port)) return { ok: true, url, started: false }
  return { ok: false, url, error: `현황판(포트 ${found.port})이 떠 있지만 답하지 않아요` }
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
    return { error: `아테나 설정(athena.config.json)에 현황판 포트를 적지 못했어요: ${error.message}` }
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
    return { ok: false, url, error: `현황판을 띄우지 못했어요: ${error.message}`, log: logFile }
  } finally {
    fs.closeSync(log)
  }

  for (let i = 0; i < 40; i++) {
    if (exited !== null) break
    // 답하는 서버가 방금 띄운 이 아테나의 것인지까지 본다(그사이 다른 것이 그 포트를 잡았을 수 있다)
    if (await isBoardUp(port)) {
      if ((await boardOwner(port, athenaDir)) === 'ours') return { ok: true, url, started: true }
      return { ok: false, url, error: `포트 ${port} 를 다른 프로그램이 먼저 잡았어요`, log: logFile }
    }
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
  return useAthenaDir(result.filePaths[0])
}

function useAthenaDir(dir) {
  const check = core.checkAthenaDir(dir)
  if (!check.ok) return { ...athenaState(), error: `아테나 폴더가 아니에요 — 없는 파일: ${check.missing.join(', ')}`, picked: dir }
  try {
    core.ensureAthenaConfig(dir, athenaReposRoot(dir))
  } catch (error) {
    return { ...athenaState(), error: `athena.config.json 을 만들지 못했어요: ${error.message}`, picked: dir }
  }
  const changed = dir !== config.athenaDir
  config = { ...config, athenaDir: dir }
  core.saveConfig(configFile(), config)
  prepareBoardPort()
  return { ...athenaState(), changed }
}

// 새로 만드는 athena.config.json 의 reposRoot — 앱 데이터 폴더에 받은 아테나면 홈, 직접 고른 폴더면 ..
const athenaReposRoot = (dir) => core.reposRootFor(dir, { userData: app.getPath('userData'), home: app.getPath('home') })

// 아테나 받기 — 묻지 않고 앱 데이터 폴더의 athena/ 에 코어 레포를 clone 하고 바로 쓴다(herdr 용 ~/athena 는 찾지 않는다)
let installing = false

async function installAthena() {
  if (installing) return { ...athenaState(), error: '이미 받는 중이에요' }
  const target = core.installTarget(app.getPath('userData'))
  if (target.action === 'use') return useAthenaDir(target.dir)
  if (target.action === 'conflict') {
    return { ...athenaState(), error: `${target.dir} 에 아테나가 아닌 것이 있어서 받지 않았어요 — 그 폴더를 치우고 다시 받거나, 받아 둔 아테나 폴더를 골라 주세요` }
  }
  const gitPath = core.findExecutable('git', process.env.PATH)
  if (!gitPath) return { ...athenaState(), error: 'git 이 없어요 — 터미널에서 xcode-select --install 로 설치한 뒤 다시 눌러 주세요' }

  installing = true
  try {
    const failure = await cloneAthena(gitPath, target.dir)
    if (failure) return { ...athenaState(), error: `아테나를 받지 못했어요 — ${failure}` }
    return useAthenaDir(target.dir)
  } finally {
    installing = false
  }
}

// 예전처럼 herdr 용 ~/athena 를 쓰고 있으면 한 번 묻는다 — 받기로 하면 아테나 폴더를 비워 화면이 앱 데이터 폴더에 받게 한다.
// ~/athena 와 거기서 도는 작업 공간 · 에이전트는 건드리지 않는다
async function offerStudioAthena() {
  if (!core.shouldOfferStudioAthena(config, app.getPath('home'))) return
  // 창을 만들기 전이라 대화상자가 다른 앱 뒤에 숨는다(터미널 · Dock 에서 켠 직후) — 앱을 앞으로 가져온다
  app.focus({ steal: true })
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: '스튜디오 전용 아테나를 받을까요?',
    detail: [
      `지금은 herdr 용 아테나(${config.athenaDir})를 같이 쓰고 있어요.`,
      `받으면 스튜디오는 앱 데이터 폴더(${core.installTarget(app.getPath('userData')).dir})의 아테나를 따로 쓰고, 팩은 처음 켤 때 /setup 으로 새로 등록해요. 현황판은 ${core.moveToStudioAthena(config).boardPort} 포트로 따로 떠요.`,
      '~/athena 와 그 작업 공간 · 에이전트는 그대로 둬요. [지금 그대로] 를 고르면 다시 묻지 않아요(바꾸려면 [파일 → 아테나 폴더 바꾸기…]).',
    ].join('\n\n'),
    buttons: ['받기', '지금 그대로'],
    defaultId: 0,
    cancelId: 1,
  })
  config = response === 0 ? core.moveToStudioAthena(config) : { ...config, studioAthenaAsked: true }
  core.saveConfig(configFile(), config)
}

// 성공하면 null, 실패하면 이유
function cloneAthena(gitPath, dir) {
  return new Promise((resolve) => {
    let tail = ''
    const child = spawn(gitPath, ['clone', '--progress', core.ATHENA_REPO, dir], {
      env: core.childEnv(process.env, { GIT_TERMINAL_PROMPT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onData = (chunk) => {
      tail = (tail + chunk).slice(-2000)
      const line = core.lastProgressLine(chunk)
      if (line) send('athena:install-progress', line)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => resolve(error.message))
    child.on('close', (code) => resolve(code === 0 ? null : core.lastProgressLine(tail) || `git 이 ${code} 로 끝났어요`))
  })
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
    if (!url) return { error: '열 수 없는 주소예요 — http(s) 주소만 열어요' }
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
  mainWindow.on('closed', () => {
    mainWindow = null
    // 서랍에서 떼어 둔 뷰는 창과 함께 정리되지 않는다 — 직접 닫는다
    if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close()
    browserView = null
    browserAttached = false
    detachScreen()
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
        { label: '새 탭', accelerator: `${TAB_KEY}+T`, click: () => send('screen:command', 'new-tab') },
        { label: '새 작업 공간…', accelerator: `${TAB_KEY}+Shift+T`, click: () => send('screen:command', 'new-workspace') },
        { label: 'pane 닫기', accelerator: `${TAB_KEY}+W`, click: () => send('screen:command', 'close-pane') },
        { label: '탭 닫기', accelerator: `${TAB_KEY}+Alt+W`, click: () => send('screen:command', 'close-tab') },
        { type: 'separator' },
        // ⌘W 는 pane 닫기라 창 닫기는 ⌘⇧W(S6)
        isMac ? { role: 'close', accelerator: 'Command+Shift+W' } : { role: 'quit' },
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
        { label: '🌐 옆 브라우저 열기·닫기', accelerator: `${TAB_KEY}+Shift+B`, click: () => send('browser:toggle') },
        { label: '작업 창 다시 붙기', click: () => send('screen:resync') },
        { label: '작업 창 데몬 다시 띄우기(pane 모두 닫힘)…', click: () => restartDaemon() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'pane',
      submenu: [
        { label: '오른쪽으로 나누기', accelerator: `${TAB_KEY}+D`, click: () => send('screen:command', 'split-right') },
        { label: '아래로 나누기', accelerator: `${TAB_KEY}+Shift+D`, click: () => send('screen:command', 'split-down') },
        { type: 'separator' },
        { label: '왼쪽 pane', accelerator: `${TAB_KEY}+Alt+Left`, click: () => send('screen:command', 'focus-left') },
        { label: '오른쪽 pane', accelerator: `${TAB_KEY}+Alt+Right`, click: () => send('screen:command', 'focus-right') },
        { label: '위 pane', accelerator: `${TAB_KEY}+Alt+Up`, click: () => send('screen:command', 'focus-up') },
        { label: '아래 pane', accelerator: `${TAB_KEY}+Alt+Down`, click: () => send('screen:command', 'focus-down') },
        { type: 'separator' },
        { label: '이전 탭', accelerator: `${TAB_KEY}+Shift+[`, click: () => send('screen:command', 'tab-prev') },
        { label: '다음 탭', accelerator: `${TAB_KEY}+Shift+]`, click: () => send('screen:command', 'tab-next') },
        { label: '이전 작업 공간', accelerator: `${TAB_KEY}+Shift+Up`, click: () => send('screen:command', 'workspace-prev') },
        { label: '다음 작업 공간', accelerator: `${TAB_KEY}+Shift+Down`, click: () => send('screen:command', 'workspace-next') },
        { type: 'separator' },
        // VSCode 와 같게 — ⌘B 왼쪽 · ⌘⌥B 오른쪽
        { label: '왼쪽 작업 공간 접기·펴기', accelerator: `${TAB_KEY}+B`, click: () => send('screen:command', 'toggle-spaces') },
        { label: '오른쪽 Explorer 접기·펴기', accelerator: `${TAB_KEY}+Alt+B`, click: () => send('screen:command', 'toggle-panel') },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC ──────────────────────────────────────────────────
ipcMain.handle('athena:state', () => athenaState())
ipcMain.handle('athena:pick', () => pickAthenaDir())
ipcMain.handle('athena:install', () => installAthena())
ipcMain.handle('screen:attach', () => attachScreen())
ipcMain.handle('agent:open', (_event, chosen, size) => openAthenaAgent(typeof chosen === 'string' ? chosen : null, cellSize(size)))
ipcMain.handle('tab:new', (_event, size) => daemonCall('tab new', { defaultCwd: config.athenaDir, ...cellSize(size) }))
ipcMain.handle('tab:select', (_event, tabId) => daemonCall('tab select', { tab: String(tabId) }))
ipcMain.handle('tab:close', (_event, tabId) => closeTab(String(tabId)))
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
  app.setName('Athena Studio')
  // npm start 로 켜도 Dock 에 Electron 대신 아테나 로고(화이트) — 패키징하면 .icns 가 맡는다
  if (isMac && app.dock) app.dock.setIcon(APP_ICON)
  config = core.loadConfig(configFile())
  await offerStudioAthena()
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
  app.on('activate', () => {
    if (!mainWindow) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => detachScreen())

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
