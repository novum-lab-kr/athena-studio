// Athena Studio 데몬 — pane(셸 pty)을 갖고 앱보다 오래 산다. 앱을 닫아도 셸·에이전트는 계속 돈다(rules.md 필수).
// 앱이 떼어 띄운다(detached · unref, 현황판과 같은 방식). 앱·CLI 는 유닉스 소켓으로 말한다(src/lib/protocol.js).
// 띄우기: <node> src/daemon/main.js --socket <경로> --endpoint <경로> [--cli <athena-studio-cli 경로>]
//   (앱은 Electron 을 node 로 — ELECTRON_RUN_AS_NODE=1, S2. 표준 출력·오류는 앱이 daemon.log 로 돌린다)
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { execFile, execFileSync } = require('child_process')
const core = require('../lib/core')
const layout = require('../lib/layout')
const model = require('../lib/screen-model')
const protocol = require('../lib/protocol')
const { Pane } = require('./pane')

const APP_ROOT = path.join(__dirname, '..', '..')
const DAEMON_VERSION = require(path.join(APP_ROOT, 'package.json')).version
const IDLE_EXIT_MS = 10 * 60 * 1000 // pane 0개 · 붙은 앱 없음이 이만큼 이어지면 끝
const BACKLOG_LIMIT = 8 * 1024 * 1024 // 앱이 못 따라오면 실시간 출력을 멈추고 resync(다시 attach)
const PROCESS_CACHE_MS = 1000
const DEFAULT_SIZE = { cols: 120, rows: 36 }

const log = (...words) => console.log(new Date().toISOString(), ...words)

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!key || !key.startsWith('--') || index + 1 >= argv.length) throw new Error(`인자를 읽지 못했다: ${argv.join(' ')}`)
    args[key.slice(2)] = argv[index + 1]
  }
  return args
}

// 맥 userData 자리(Electron app.getPath('userData') 와 같게) — 앱 없이 손으로 띄울 때의 기본값
function defaultPaths() {
  const home = os.homedir()
  const userData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Athena Studio') : path.join(home, '.config', 'Athena Studio')
  return core.daemonPaths({ userData, home, tmpdir: os.tmpdir(), uid: process.getuid() })
}

class Daemon {
  constructor({ socket, endpoint, cli }) {
    this.socketPath = socket
    this.endpointPath = endpoint
    this.cliPath = cli || path.join(APP_ROOT, 'bin', 'athena-studio-cli')
    this.ids = model.createIdGen()
    this.panes = new Map()
    this.workspaces = [] // {id, label, cwd, activeTab} — 레포마다 하나(코어 delegate 가 만든다)
    this.tabs = [] // {id, workspaceId, label, tree, size: {cols, rows}}
    this.docks = new Map() // 이름 → pane id — 탭 밖에 늘 붙어 있는 칸(앱 하단 에이전트 모니터 등)
    this.activeWorkspace = null
    this.focusedPane = null
    this.clients = new Set()
    this.startedAt = new Date().toISOString()
    this.processCache = null
    this.idleSince = Date.now()
  }

  // ── 시작 · 끝 ───────────────────────────────────────────────
  async start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
    if (await canConnect(this.socketPath)) throw new Error(`이미 데몬이 떠 있다: ${this.socketPath}`)
    try {
      fs.unlinkSync(this.socketPath) // 죽은 데몬이 남긴 소켓
    } catch {}
    this.server = net.createServer((socket) => this.accept(socket))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socketPath, resolve)
    })
    fs.chmodSync(this.socketPath, 0o600)
    this.writeEndpoint()
    this.idleTimer = setInterval(() => this.checkIdle(), 30 * 1000)
    this.idleTimer.unref()
    log(`데몬 시작 pid ${process.pid} · 소켓 ${this.socketPath} · 프로토콜 ${protocol.PROTOCOL}`)
  }

  // pane 밖(앱이 띄우지 않은 현황판 · 일반 터미널)에서 데몬을 찾는 접속 파일(S4)
  writeEndpoint() {
    if (!this.endpointPath) return
    fs.mkdirSync(path.dirname(this.endpointPath), { recursive: true, mode: 0o700 })
    const body = { socket: this.socketPath, cli: this.cliPath, node: process.execPath, pid: process.pid, protocol: protocol.PROTOCOL, startedAt: this.startedAt }
    const tmp = `${this.endpointPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.endpointPath)
  }

  removeEndpoint() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.endpointPath, 'utf8'))
      if (saved.pid === process.pid) fs.unlinkSync(this.endpointPath) // 다른 데몬이 쓴 것은 건드리지 않는다
    } catch {}
  }

  shutdown(reason) {
    log(`데몬 끝: ${reason}`)
    for (const pane of this.panes.values()) pane.close()
    this.removeEndpoint()
    try {
      fs.unlinkSync(this.socketPath)
    } catch {}
    process.exit(0)
  }

  checkIdle() {
    const appAttached = [...this.clients].some((client) => client.attached)
    if (this.panes.size > 0 || appAttached) {
      this.idleSince = Date.now()
      return
    }
    if (Date.now() - this.idleSince >= IDLE_EXIT_MS) this.shutdown('pane 도 앱도 없이 10분')
  }

  // ── 연결 ───────────────────────────────────────────────────
  accept(socket) {
    const client = { socket, attached: false }
    this.clients.add(client)
    socket.setEncoding('utf8')
    socket.on('data', protocol.createDecoder((message) => this.handle(client, message), (line) => log('깨진 줄', line.slice(0, 200))))
    socket.on('error', () => {})
    socket.on('close', () => this.clients.delete(client))
  }

  reply(client, message) {
    if (client.socket.destroyed) return
    client.socket.write(protocol.encode(message))
  }

  // 붙은 앱에 알림. 못 따라오면(쌓인 글이 너무 많으면) 실시간을 멈추고 resync 를 보낸다
  broadcast(message) {
    const line = protocol.encode(message)
    for (const client of this.clients) {
      if (!client.attached || client.socket.destroyed) continue
      if (client.socket.writableLength > BACKLOG_LIMIT) {
        client.attached = false
        client.socket.write(protocol.encode({ event: 'resync' }))
        continue
      }
      client.socket.write(line)
    }
  }

  broadcastState() {
    this.broadcast({ event: 'state', state: this.state() })
  }

  async handle(client, message) {
    const { id, op, args = {} } = message || {}
    try {
      const result = await this.dispatch(client, op, args, message)
      if (id !== undefined) this.reply(client, { id, ok: true, result: result === undefined ? null : result })
    } catch (error) {
      const code = error.code && protocol.ERROR_CODES.includes(error.code) ? error.code : 'internal'
      if (code === 'internal') log(`${op} 실패`, error.stack || error)
      if (id !== undefined) this.reply(client, protocol.errorReply(id, code, error.message))
    }
  }

  async dispatch(client, op, args, message) {
    switch (op) {
      case 'hello':
        return { protocol: protocol.PROTOCOL, daemonVersion: DAEMON_VERSION, pid: process.pid, startedAt: this.startedAt, panes: this.panes.size }
      // ── 앱 전용 ──
      case 'attach':
        return this.attach(client)
      case 'state':
        return this.state()
      case 'input':
        this.paneOf(args.pane).write(String(args.data))
        return undefined
      case 'resize':
        this.paneOf(args.pane).resize(args.cols | 0, args.rows | 0)
        return undefined
      case 'focus':
        return this.focus(args.pane)
      case 'tab new':
        return this.newTab(args)
      case 'tab select':
        return this.selectTab(args.tab)
      case 'workspace select':
        return this.selectWorkspace(args.workspace)
      case 'dock ensure':
        return this.ensureDock(args)
      case 'tab ratio':
        return this.setTabRatio(args.tab, args.path, args.ratio)
      case 'tab size':
        return this.setTabSize(args.tab, args.cols | 0, args.rows | 0)
      case 'shutdown':
        setImmediate(() => this.shutdown('앱이 요청'))
        return { panes: this.panes.size }
      // ── 화면 계층(CLI) ──
      case 'pane list':
        return { panes: await this.flatPanes([...this.panes.values()]) }
      case 'pane get':
        return { pane: (await this.flatPanes([this.paneOf(args.pane)]))[0] }
      case 'pane current': {
        const pane = this.panes.get(this.focusedPane)
        if (!pane) throw failure('not_found', '포커스된 pane 이 없다')
        return { pane: (await this.flatPanes([pane]))[0] }
      }
      case 'pane split':
        return this.split(args, message.caller)
      case 'pane run':
        this.paneOf(args.pane).write(`${args.text}\r`)
        return undefined
      case 'pane send-text':
        this.paneOf(args.pane).write(String(args.text))
        return undefined
      case 'pane send-keys':
        return this.sendKeys(args)
      case 'pane rename':
        this.paneOf(args.pane).label = args.label || null
        this.broadcastState()
        return undefined
      case 'pane read': {
        const pane = this.paneOf(args.pane)
        return { text: model.formatRead(pane.lines(args.source), args.lines) }
      }
      case 'pane wait-output':
        return this.waitOutput(args)
      case 'pane is-shell': {
        const pane = this.paneOf(args.pane)
        return { shell: model.isShellIdle(await this.processes(), pane.pid) }
      }
      // 팩 바꾸기용(앱만 쓴다) — pane 셸 pid. 화면 계층 pane 모양(12개 키)은 그대로 두고 따로 준다
      case 'pane pids':
        return { pids: Object.fromEntries([...this.panes.values()].map((pane) => [pane.id, pane.pid])) }
      case 'pane close':
        this.paneOf(args.pane).close()
        return undefined
      case 'workspace list':
        return { workspaces: this.workspaces.map((workspace) => this.flatWorkspace(workspace)) }
      case 'workspace get':
        return { workspace: this.flatWorkspace(this.workspaceOf(args.workspace)) }
      case 'workspace create':
        return this.createWorkspace(args)
      case 'tab list':
        return { tabs: this.tabs.filter((tab) => !args.workspace || tab.workspaceId === args.workspace).map(flatTab) }
      case 'tab get':
        return { tab: flatTab(this.tabOf(args.tab)) }
      case 'tab rename':
        this.tabOf(args.tab).label = args.label || null
        this.broadcastState()
        return undefined
      case 'tab close':
        return this.closeTab(args.tab)
      default:
        throw failure('usage', `모르는 동작: ${op}`)
    }
  }

  // ── 상태 ───────────────────────────────────────────────────
  paneOf(paneId) {
    const pane = this.panes.get(paneId)
    if (!pane) throw failure('not_found', `없는 pane: ${paneId}`)
    return pane
  }

  // 앱 화면이 그릴 상태 — 작업 공간 · 탭(트리) · pane 메타
  state() {
    return {
      workspaces: this.workspaces.map((workspace) => ({ id: workspace.id, label: workspace.label, cwd: workspace.cwd, activeTab: workspace.activeTab })),
      activeWorkspace: this.activeWorkspace,
      tabs: this.tabs.map((tab) => ({ id: tab.id, workspace: tab.workspaceId, label: tab.label, tree: tab.tree })),
      focused: this.focusedPane,
      panes: [...this.panes.values()].map((pane) => ({ id: pane.id, tab: pane.tabId, dock: pane.dock || null, label: pane.label, title: pane.title, cols: pane.size.cols, rows: pane.size.rows })),
    }
  }

  // 화면 계층 Workspace 모양(screen.py _workspace)
  flatWorkspace(workspace) {
    return { id: workspace.id, label: workspace.label, active_tab_id: workspace.activeTab, focused: workspace.id === this.activeWorkspace }
  }

  workspaceOf(workspaceId) {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId)
    if (!workspace) throw failure('not_found', `없는 작업 공간: ${workspaceId}`)
    return workspace
  }

  // 지금 상태 + pane 마다 되살릴 화면. 이 응답 뒤로 같은 소켓에 실시간 출력이 이어진다(빈틈 없음)
  attach(client) {
    const snapshots = {}
    for (const pane of this.panes.values()) snapshots[pane.id] = pane.snapshot()
    client.attached = true
    return { state: this.state(), snapshots }
  }

  focus(paneId) {
    const pane = this.paneOf(paneId)
    // 고정 칸은 탭이 없다 — 포커스만 옮긴다(보고 있던 작업 공간·탭은 그대로)
    if (pane.dock) this.focusedPane = pane.id
    else this.activate(this.tabOf(pane.tabId), pane.id)
    this.broadcastState()
    return undefined
  }

  // 그 탭을 보이게(작업 공간까지) 하고 포커스를 옮긴다 — paneId 가 없으면 탭의 첫 pane
  activate(tab, paneId) {
    const workspace = this.workspaceOf(tab.workspaceId)
    workspace.activeTab = tab.id
    this.activeWorkspace = workspace.id
    this.focusedPane = paneId || layout.paneIds(tab.tree)[0] || null
  }

  // ── 탭 · 분할 ──────────────────────────────────────────────
  // 작업 공간 하나 + 셸 탭 하나. 화면 계층 workspace create 는 {workspace, root_pane}
  async createWorkspace({ label, cwd, focus, cols, rows }) {
    const workdir = cwd && isDirectory(cwd) ? cwd : os.homedir()
    const workspace = { id: this.ids.next('w'), label: label || path.basename(workdir), cwd: workdir, activeTab: null }
    this.workspaces.push(workspace)
    const previous = { workspace: this.activeWorkspace, pane: this.focusedPane }
    const { pane } = this.addTab({ workspace, cwd: workdir, cols, rows })
    // --no-focus 면 보고 있던 곳 그대로
    if (focus === false && previous.workspace) {
      this.activeWorkspace = previous.workspace
      this.focusedPane = previous.pane
    }
    this.broadcastState()
    return { workspace: this.flatWorkspace(workspace), root_pane: (await this.flatPanes([pane]))[0] }
  }

  // 앱의 ＋ · ⌘T — 작업 공간을 주지 않으면 지금 작업 공간(없으면 cwd · defaultCwd 이름으로 하나 만든다).
  // 새 탭 폴더는 cwd 를 주지 않으면 그 작업 공간 폴더
  newTab({ workspace: workspaceId, label, cwd, defaultCwd, cols, rows }) {
    let workspace = this.workspaces.find((entry) => entry.id === (workspaceId || this.activeWorkspace))
    if (!workspace) {
      const wanted = cwd || defaultCwd
      const workdir = wanted && isDirectory(wanted) ? wanted : os.homedir()
      workspace = { id: this.ids.next('w'), label: path.basename(workdir), cwd: workdir, activeTab: null }
      this.workspaces.push(workspace)
    }
    const { tab, pane } = this.addTab({ workspace, label, cwd: cwd || workspace.cwd, cols, rows })
    this.broadcastState()
    return { workspace: workspace.id, tab: tab.id, pane: pane.id }
  }

  addTab({ workspace, label, cwd, cols, rows }) {
    const tab = { id: this.ids.next('t'), workspaceId: workspace.id, label: label || null, tree: null, size: sizeOr({ cols, rows }) }
    this.tabs.push(tab) // pane 환경(ATHENA_STUDIO_WORKSPACE_ID)이 탭을 찾을 수 있게 먼저 넣는다
    const pane = this.spawnPane({ tabId: tab.id, cwd, cols: tab.size.cols, rows: tab.size.rows })
    tab.tree = layout.leaf(pane.id)
    this.activate(tab, pane.id)
    return { tab, pane }
  }

  selectTab(tabId) {
    const tab = this.tabOf(tabId)
    const ids = layout.paneIds(tab.tree)
    this.activate(tab, ids.includes(this.focusedPane) ? this.focusedPane : null)
    this.broadcastState()
    return undefined
  }

  selectWorkspace(workspaceId) {
    const workspace = this.workspaceOf(workspaceId)
    const tab = this.tabs.find((entry) => entry.id === workspace.activeTab) || this.tabs.find((entry) => entry.workspaceId === workspace.id)
    if (tab) this.activate(tab, null)
    else this.activeWorkspace = workspace.id
    this.broadcastState()
    return undefined
  }

  // 탭 안의 pane 을 모두 닫는다 — 마지막 pane 이 끝나면 탭이 빠진다(paneExited)
  closeTab(tabId) {
    const tab = this.tabOf(tabId)
    for (const paneId of layout.paneIds(tab.tree)) this.panes.get(paneId)?.close()
    return undefined
  }

  // 앱에서 pane 경계를 끈 결과 — path 의 가지 비율을 바꾼다
  setTabRatio(tabId, path, ratio) {
    const tab = this.tabOf(tabId)
    const tree = layout.setRatio(tab.tree, path, ratio)
    if (!tree) throw failure('usage', `없는 경계: ${JSON.stringify(path)}`)
    tab.tree = tree
    this.broadcastState()
    return undefined
  }

  setTabSize(tabId, cols, rows) {
    const tab = this.tabOf(tabId)
    if (cols > 1 && rows > 1) tab.size = { cols, rows }
    return undefined
  }

  tabOf(tabId) {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    if (!tab) throw failure('not_found', `없는 탭: ${tabId}`)
    return tab
  }

  // target: self = 부른 pane(CLI 가 ATHENA_STUDIO_PANE_ID 를 caller 로 보낸다, 없으면 포커스) · focused · pane id
  async split({ target, direction, ratio, cwd, env, focus }, caller) {
    let targetId = target
    if (target === 'self') targetId = caller && this.panes.has(caller) ? caller : this.focusedPane
    if (target === 'focused') targetId = this.focusedPane
    const base = this.paneOf(targetId)
    if (base.dock) throw failure('usage', `고정 칸(${base.dock})은 나눌 수 없다 — 탭의 pane 을 주세요`)
    const tab = this.tabOf(base.tabId)
    const pane = this.spawnPane({ tabId: tab.id, cwd: cwd || base.cwd, env, ...base.size })
    tab.tree = layout.splitPane(tab.tree, base.id, pane.id, direction, ratio)
    this.fitTab(tab)
    if (focus !== false) this.activate(tab, pane.id)
    this.broadcastState()
    return { pane: (await this.flatPanes([pane]))[0] }
  }

  // 앱이 없을 때도 크기가 맞게 탭 크기를 트리대로 나눠 pty 크기를 정한다(앱이 붙어 있으면 앱이 실제 크기로 다시 알린다)
  fitTab(tab) {
    const rects = layout.computeRects(tab.tree, { x: 0, y: 0, width: tab.size.cols, height: tab.size.rows }, 1)
    for (const [paneId, rect] of Object.entries(rects)) {
      const pane = this.panes.get(paneId)
      if (pane) pane.resize(Math.max(2, rect.width), Math.max(2, rect.height))
    }
  }

  spawnPane({ tabId, cwd, env = {}, cols, rows }) {
    const id = this.ids.next('p')
    const workdir = cwd && isDirectory(cwd) ? cwd : os.homedir()
    const pane = new Pane({
      id,
      tabId,
      cwd: workdir,
      shell: process.env.SHELL || '/bin/zsh',
      cols: cols || DEFAULT_SIZE.cols,
      rows: rows || DEFAULT_SIZE.rows,
      env: this.paneEnv(id, tabId, env),
      onData: (data) => this.broadcast({ event: 'data', pane: id, data }),
      onExit: (code) => this.paneExited(id, code),
    })
    this.panes.set(id, pane)
    log(`pane ${id} 시작 (탭 ${tabId} · ${workdir})`)
    return pane
  }

  // pane 셸 환경 — 화면 계층 auto 감지가 herdr 보다 먼저 본다(ATHENA_STUDIO*). HERDR_* · ELECTRON_RUN_AS_NODE 는 지운다
  paneEnv(paneId, tabId, extra) {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    return {
      ...core.terminalEnv(process.env),
      ATHENA_STUDIO: '1',
      ATHENA_STUDIO_PANE_ID: paneId,
      ATHENA_STUDIO_TAB_ID: tabId || '', // 고정 칸(dock)은 탭이 없다
      ATHENA_STUDIO_WORKSPACE_ID: tab ? tab.workspaceId : '',
      ATHENA_STUDIO_SOCKET: this.socketPath,
      ATHENA_STUDIO_CLI: this.cliPath,
      ATHENA_STUDIO_NODE: process.execPath,
      ...extra,
    }
  }

  paneExited(paneId, code) {
    const pane = this.panes.get(paneId)
    if (!pane) return
    this.panes.delete(paneId)
    if (pane.dock && this.docks.get(pane.dock) === paneId) this.docks.delete(pane.dock)
    log(`pane ${paneId} 끝 (${code})`)
    const tab = this.tabs.find((entry) => entry.id === pane.tabId)
    if (tab) {
      tab.tree = layout.removePane(tab.tree, paneId)
      if (tab.tree) this.fitTab(tab)
      else this.removeTab(tab)
    }
    if (this.focusedPane === paneId || !this.panes.has(this.focusedPane)) this.refocus()
    this.broadcast({ event: 'exit', pane: paneId, code })
    this.broadcastState()
  }

  // 탭 밖 고정 칸 — 이름마다 하나. 없으면 셸을 띄우고 그 셸에서 command 를 실행한다(명령이 끝나도 칸은 남는다)
  ensureDock({ name, cwd, command, label, cols, rows }) {
    if (!name || typeof name !== 'string') throw failure('usage', 'dock 이름이 없다')
    const existing = this.panes.get(this.docks.get(name))
    if (existing) return { pane: existing.id, created: false }
    const size = sizeOr({ cols, rows })
    const pane = this.spawnPane({ tabId: null, cwd, cols: size.cols, rows: size.rows })
    pane.dock = name
    pane.label = label || null
    this.docks.set(name, pane.id)
    if (command) pane.write(`${command}\r`)
    this.broadcastState()
    return { pane: pane.id, created: true }
  }

  // 빈 탭을 빼고, 탭이 없어진 작업 공간도 뺀다
  removeTab(tab) {
    this.tabs = this.tabs.filter((entry) => entry !== tab)
    const workspace = this.workspaces.find((entry) => entry.id === tab.workspaceId)
    if (!workspace) return
    const rest = this.tabs.filter((entry) => entry.workspaceId === workspace.id)
    if (!rest.length) this.workspaces = this.workspaces.filter((entry) => entry !== workspace)
    else if (workspace.activeTab === tab.id) workspace.activeTab = rest[rest.length - 1].id
  }

  // 포커스가 사라졌으면 — 지금 작업 공간의 활성 탭 → 다른 작업 공간 순으로
  refocus() {
    const workspace = this.workspaces.find((entry) => entry.id === this.activeWorkspace) || this.workspaces[this.workspaces.length - 1]
    if (!workspace) {
      this.activeWorkspace = null
      this.focusedPane = null
      return
    }
    const tab = this.tabs.find((entry) => entry.id === workspace.activeTab) || this.tabs.find((entry) => entry.workspaceId === workspace.id)
    this.activeWorkspace = workspace.id
    this.focusedPane = tab ? layout.paneIds(tab.tree)[0] : null
  }

  // ── 쓰기 · 읽기 ────────────────────────────────────────────
  sendKeys({ pane: paneId, keys }) {
    const pane = this.paneOf(paneId)
    const bytes = keys.map((key) => {
      const value = model.keyBytes(key)
      if (value === null) throw failure('usage', `모르는 키: ${key}`)
      return value
    })
    pane.write(bytes.join(''))
    return undefined
  }

  waitOutput({ pane: paneId, match, regex, lines, timeout }) {
    const pane = this.paneOf(paneId)
    return new Promise((resolve, reject) => {
      let timer = null
      const waiter = {
        check: () => {
          let found
          try {
            found = model.findMatch(model.formatRead(pane.lines('recent'), lines), { match, regex })
          } catch (error) {
            waiter.fail('usage', error.message)
            return true
          }
          if (found === null) return false
          clearTimeout(timer)
          resolve({ text: `${found}\n` })
          return true
        },
        fail: (code, text) => {
          clearTimeout(timer)
          reject(failure(code, text))
        },
      }
      if (waiter.check()) return
      const remove = pane.addWaiter(waiter)
      if (timeout) {
        timer = setTimeout(() => {
          remove()
          reject(failure('timeout', `${timeout}ms 안에 맞는 출력이 없다`))
        }, timeout)
      }
    })
  }

  // ── 납작한 Pane (agent · 앞쪽 cwd 는 ps · lsof 로, 1초 캐시) ─────────────
  async flatPanes(panes) {
    const processes = await this.processes()
    const foreground = panes.map((pane) => {
      const group = model.foregroundGroup(processes, pane.pid)
      const leader = group === null ? null : processes.find((row) => row.pid === group)
      return leader ? leader.pid : pane.pid
    })
    const cwds = await foregroundCwds(foreground)
    const now = Date.now()
    return panes.map((pane, index) => {
      const agent = model.detectAgent(processes, pane.pid, nodeArgs)
      const tab = this.tabs.find((entry) => entry.id === pane.tabId)
      return model.flatPane({
        id: pane.id,
        tabId: pane.tabId,
        workspaceId: tab ? tab.workspaceId : null,
        label: pane.label,
        cwd: pane.cwd,
        foregroundCwd: cwds[foreground[index]] || null,
        focused: pane.id === this.focusedPane,
        agent,
        agentStatus: model.agentStatus({ agent, screenLines: pane.lines('visible'), lastOutputAt: pane.lastOutputAt, now }),
        title: pane.title,
      })
    })
  }

  processes() {
    if (this.processCache && Date.now() - this.processCache.at < PROCESS_CACHE_MS) return this.processCache.rows
    const rows = new Promise((resolve) => {
      execFile('ps', ['-axo', 'pid=,pgid=,tpgid=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : model.parsePs(stdout)))
    })
    this.processCache = { at: Date.now(), rows }
    return rows
  }
}

// node 로 도는 앞쪽 프로세스만 인자를 본다(npm 판 codex) — 앞쪽 그룹 밖은 묻지 않는다
function nodeArgs(pid) {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 })
  } catch {
    return null
  }
}

// pid → cwd. lsof 한 번으로 묶는다
function foregroundCwds(pids) {
  const unique = [...new Set(pids.filter(Boolean))]
  if (!unique.length) return Promise.resolve({})
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', unique.join(',')], { timeout: 2000 }, (_error, stdout) => {
      const cwds = {}
      let current = null
      for (const line of String(stdout || '').split('\n')) {
        if (line.startsWith('p')) current = Number(line.slice(1))
        else if (line.startsWith('n') && current) cwds[current] = line.slice(1)
      }
      resolve(cwds)
    })
  })
}

function canConnect(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function sizeOr({ cols, rows }) {
  return { cols: cols > 1 ? cols | 0 : DEFAULT_SIZE.cols, rows: rows > 1 ? rows | 0 : DEFAULT_SIZE.rows }
}

// 화면 계층 Tab 모양
function flatTab(tab) {
  return { id: tab.id, workspace_id: tab.workspaceId, label: tab.label }
}

function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function main() {
  process.title = 'athena-studio-daemon'
  const args = parseArgs(process.argv.slice(2))
  const defaults = defaultPaths()
  const daemon = new Daemon({ socket: args.socket || defaults.socket, endpoint: args.endpoint || defaults.endpoint, cli: args.cli })
  // 예외 하나로 데몬이 죽으면 모든 셸이 SIGHUP 으로 같이 죽는다 — 로그만 남기고 계속 돈다
  process.on('uncaughtException', (error) => log('잡히지 않은 예외', error.stack || error))
  process.on('unhandledRejection', (error) => log('처리 안 된 거절', (error && error.stack) || error))
  process.on('SIGTERM', () => daemon.shutdown('SIGTERM'))
  process.on('SIGHUP', () => {}) // 띄운 터미널이 닫혀도 산다
  await daemon.start()
}

if (require.main === module) {
  main().catch((error) => {
    log('데몬 시작 실패', error.message)
    process.exit(1)
  })
}

module.exports = { Daemon }
