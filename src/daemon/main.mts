// Athena Studio 데몬 — pane(셸 pty)을 갖고 앱보다 오래 산다. 앱을 닫아도 셸·에이전트는 계속 돈다(rules.md 필수).
// 앱이 떼어 띄운다(detached · unref, 일감과 같은 방식). 앱·CLI 는 유닉스 소켓으로 말한다(src/lib/protocol.js).
// 띄우기: <node> src/daemon/main.mts --socket <경로> --endpoint <경로> [--cli <athena-studio-cli 경로>]
//   (앱은 Electron 을 node 로 — ELECTRON_RUN_AS_NODE=1, S2. 표준 출력·오류는 앱이 daemon.log 로 돌린다)
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as core from '../lib/core.mts'
import { Pane } from './pane.mts'
import type { Waiter } from './pane.mts'
import * as layout from '../lib/layout.mts'
import type { Tree } from '../lib/layout.mts'

// screen-model · protocol 은 JS — 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const model: typeof import('../lib/screen-model.js') = require('../lib/screen-model.js')
const protocol: typeof import('../lib/protocol.js') = require('../lib/protocol.js')

type ProcessRow = ReturnType<typeof model.parsePs>[number]
type Size = { cols: number; rows: number }
// body = 그 작업 공간이 속한 아테나 본체(팩) 실제 경로, 모르면 null(모든 본체에 보임)
type Workspace = { id: string; label: string; cwd: string; activeTab: string | null; body: string | null }
type Tab = { id: string; workspaceId: string; label: string | null; tree: Tree | null; size: Size }
type View = { activeWorkspace: string | null; focusedPane: string | null | undefined }
// body — attach 때 앱 창이 알린 본체(묶이지 않으면 null = 전부)
type Client = { socket: net.Socket; attached: boolean; body: string | null }
// 본체 범위 — null · undefined 면 전부
type Scope = string | null | undefined
// 요청 인자 — 소켓 JSON 그대로(모양 검사는 하지 않는다). 동작마다 읽는 칸만
type Args = {
  pane?: string
  tab?: string
  workspace?: string
  data?: unknown
  text?: unknown
  url?: unknown
  name?: unknown
  body?: unknown
  cols?: number
  rows?: number
  path?: unknown
  ratio?: unknown
  label?: string | null
  cwd?: string
  defaultCwd?: string
  focus?: boolean
  command?: string
  target?: string
  direction?: string
  env?: Record<string, string>
  keys?: string[]
  source?: string
  lines?: number
  match?: unknown
  regex?: unknown
  timeout?: number
}
type Message = { id?: unknown; op?: string; args?: Args; caller?: string | null; body?: unknown }
type Failure = Error & { code: string }

const APP_ROOT = path.join(import.meta.dirname, '..', '..')
const DAEMON_VERSION: string = require(path.join(APP_ROOT, 'package.json')).version
const IDLE_EXIT_MS = 10 * 60 * 1000 // pane 0개 · 붙은 앱 없음이 이만큼 이어지면 끝
const BACKLOG_LIMIT = 8 * 1024 * 1024 // 앱이 못 따라오면 실시간 출력을 멈추고 resync(다시 attach)
const PROCESS_CACHE_MS = 1000
const DEFAULT_SIZE = { cols: 120, rows: 36 }

const log = (...words: unknown[]) => console.log(new Date().toISOString(), ...words)

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!key || !key.startsWith('--') || index + 1 >= argv.length) throw new Error(`인자를 읽지 못했다: ${argv.join(' ')}`)
    args[key.slice(2)] = argv[index + 1] as string
  }
  return args
}

// 맥 userData 자리(Electron app.getPath('userData') 와 같게) — 앱 없이 손으로 띄울 때의 기본값
function defaultPaths() {
  const home = os.homedir()
  const userData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Athena Studio') : path.join(home, '.config', 'Athena Studio')
  return core.daemonPaths({ userData, home, tmpdir: os.tmpdir(), uid: process.getuid!() })
}

export class Daemon {
  // declare — 타입만(실행 코드에 칸을 만들지 않는다 · 값은 constructor · start 가 넣는다)
  declare socketPath: string
  declare endpointPath: string
  declare cliPath: string
  declare idsPath: string
  declare ids: ReturnType<typeof model.createIdGen>
  // id 가 없을 수 있는 값(요청 인자 · 포커스)으로 그대로 찾는다 — 없으면 undefined
  declare panes: Map<string | null | undefined, Pane>
  declare workspaces: Workspace[]
  declare tabs: Tab[]
  declare docks: Map<string, string>
  declare views: Map<string, View>
  declare lastKey: string
  declare clients: Set<Client>
  declare startedAt: string
  declare processCache: { at: number; rows: Promise<ProcessRow[]> } | null
  declare idleSince: number
  declare server: net.Server
  declare idleTimer: NodeJS.Timeout

  constructor({ socket, endpoint, cli }: { socket: string; endpoint: string; cli?: string }) {
    this.socketPath = socket
    this.endpointPath = endpoint
    this.cliPath = cli || path.join(APP_ROOT, 'bin', 'athena-studio-cli')
    this.idsPath = model.idsPath(endpoint)
    this.ids = model.createIdGen(readIds(this.idsPath), (counters) => writeIds(this.idsPath, counters))
    this.panes = new Map()
    this.workspaces = [] // {id, label, cwd, activeTab, body} — 레포마다 하나(코어 delegate 가 만든다) · body = 그 작업 공간이 속한 아테나 본체(팩) 실제 경로, 모르면 null(모든 본체에 보임)
    this.tabs = [] // {id, workspaceId, label, tree, size: {cols, rows}}
    this.docks = new Map() // '<본체>\0<이름>' → pane id — 탭 밖에 늘 붙어 있는 칸(앱 하단 에이전트 모니터 등) · 본체마다 따로
    // 보는 자리(활성 작업 공간 · 포커스)는 본체마다 — 팩 창마다 따로 고른다. 키 = 본체 경로('' = 본체 모름)
    this.views = new Map()
    this.lastKey = '' // 마지막으로 포커스가 움직인 본체 — 묶이지 않은 CLI 의 '지금 포커스'
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
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socketPath, resolve)
    })
    fs.chmodSync(this.socketPath, 0o600)
    this.writeEndpoint()
    this.idleTimer = setInterval(() => this.checkIdle(), 30 * 1000)
    this.idleTimer.unref()
    log(`데몬 시작 pid ${process.pid} · 소켓 ${this.socketPath} · 프로토콜 ${protocol.PROTOCOL}`)
  }

  // pane 밖(앱이 띄우지 않은 일감 · 일반 터미널)에서 데몬을 찾는 접속 파일(S4)
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

  shutdown(reason: string): void {
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
  accept(socket: net.Socket): void {
    const client: Client = { socket, attached: false, body: null } // body — attach 때 앱 창이 알린 본체(묶이지 않으면 null = 전부)
    this.clients.add(client)
    socket.setEncoding('utf8')
    socket.on('data', protocol.createDecoder((message) => this.handle(client, message), (line) => log('깨진 줄', line.slice(0, 200))))
    socket.on('error', () => {})
    socket.on('close', () => this.clients.delete(client))
  }

  reply(client: Client, message: unknown): void {
    if (client.socket.destroyed) return
    client.socket.write(protocol.encode(message))
  }

  // 붙은 앱에 알림. 못 따라오면(쌓인 글이 너무 많으면) 실시간을 멈추고 resync 를 보낸다.
  // body 를 주면 그 본체를 보는 연결(과 묶이지 않은 연결)에만 — pane 출력이 다른 팩 창으로 새지 않게
  broadcast(message: unknown, body: Scope = undefined): void {
    const line = protocol.encode(message)
    for (const client of this.clients) {
      if (!client.attached || client.socket.destroyed) continue
      if (body !== undefined && !this.sees(client.body, body)) continue
      if (client.socket.writableLength > BACKLOG_LIMIT) {
        client.attached = false
        client.socket.write(protocol.encode({ event: 'resync' }))
        continue
      }
      client.socket.write(line)
    }
  }

  // 연결마다 자기 본체 상태만 — 같은 본체끼리는 한 번만 만든다
  broadcastState() {
    const made = new Map<string | null, string>()
    for (const client of this.clients) {
      if (!client.attached || client.socket.destroyed) continue
      const key = client.body === null ? null : client.body
      if (!made.has(key)) made.set(key, protocol.encode({ event: 'state', state: this.state(key) }))
      if (client.socket.writableLength > BACKLOG_LIMIT) {
        client.attached = false
        client.socket.write(protocol.encode({ event: 'resync' }))
        continue
      }
      client.socket.write(made.get(key) as string)
    }
  }

  // ── 본체(팩) 묶음 ───────────────────────────────────────────
  // scope 가 null 이면 전부 본다(묶이지 않은 연결) · 본체 모르는 작업 공간(body null)은 누구에게나 보인다
  sees(scope: Scope, body: string | null | undefined): boolean {
    return scope === null || scope === undefined || !body || body === scope
  }

  view(key: string | null | undefined): View {
    const name = key || ''
    if (!this.views.has(name)) this.views.set(name, { activeWorkspace: null, focusedPane: null })
    return this.views.get(name) as View
  }

  workspaceBody(workspaceId: string | null | undefined): string | null {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId)
    return workspace ? workspace.body : null
  }

  paneBody(pane: Pane | null | undefined): string | null {
    if (!pane) return null
    if (pane.dock) return pane.body || null
    const tab = this.tabs.find((entry) => entry.id === pane.tabId)
    return tab ? this.workspaceBody(tab.workspaceId) : null
  }

  // 이 요청이 보는 본체 — 묶인 앱 연결이면 그 본체, CLI 는 부른 pane(ATHENA_STUDIO_PANE_ID)의 본체,
  // pane 밖(일감)이면 CLI 가 실어 온 ATHENA_STUDIO_BODY, 다 없으면 null(전부)
  scopeOf(client: Client, message: Message): string | null {
    if (client.body) return client.body
    const caller = message && message.caller ? this.panes.get(message.caller) : null
    if (caller) return this.paneBody(caller) || null
    return message && typeof message.body === 'string' && message.body ? message.body : null
  }

  // 포커스 · 활성 작업 공간을 바꿀 자리 — scope 가 없으면 마지막으로 움직인 본체
  viewKeyOf(scope: Scope): string {
    return scope === null || scope === undefined ? this.lastKey : scope
  }

  // 이미 있는 것(pane · 탭 · 작업 공간)을 고를 때의 자리 — 묶이지 않은 호출이면 그것이 속한 본체(모르면 마지막으로 움직인 본체).
  // lastKey 로만 고르면 다른 본체 창의 활성 작업 공간 · 포커스를 덮는다(리뷰 제안 1)
  viewKeyFor(scope: Scope, body: string | null): string {
    return scope === null || scope === undefined ? body || this.lastKey : scope
  }

  // scope 가 보는 것만 — 목록 응답 · 상태
  visibleWorkspaces(scope: Scope): Workspace[] {
    return this.workspaces.filter((workspace) => this.sees(scope, workspace.body))
  }

  visiblePanes(scope: Scope): Pane[] {
    return [...this.panes.values()].filter((pane) => this.sees(scope, this.paneBody(pane)))
  }

  // 다른 본체의 pane · 탭 · 작업 공간을 고르지 못하게(없는 것처럼)
  checkVisible(scope: Scope, body: string | null, what: string): void {
    if (!this.sees(scope, body)) throw failure('not_found', `이 창(팩)에 없는 ${what}`)
  }

  // 주소 열기(아테나 화면 계층 open-url) — 그 본체에 붙은 앱 창 하나에 알린다. 여는 건 앱(main openUrl — localhost 는 옆 브라우저 · 그 밖 http(s) 는 기본 브라우저)
  // 고르는 곳: 그 본체에 묶인 연결. 본체를 모르는 호출(부른 pane · ATHENA_STUDIO_BODY 없음)이면 붙은 창이 하나일 때만 그 창.
  // 못 고르면 not_found — 아테나 화면 계층이 기본 브라우저로 떨어진다
  openUrl(scope: Scope, url: unknown): { ok: true; target: 'panel' | 'external' } {
    const target = core.openTarget(String(url || ''))
    if (target === 'deny') throw failure('usage', `http(s) 주소만 열 수 있다: ${url}`)
    const app = this.appFor(scope)
    if (!app) throw failure('not_found', scope ? '이 본체에 붙은 앱 창이 없다' : '어느 앱 창에서 열지 모르겠다(붙은 창이 없거나 여럿)')
    app.socket.write(protocol.encode({ event: 'open-url', url: String(url) }))
    return { ok: true, target }
  }

  appFor(scope: Scope): Client | null {
    const apps = [...this.clients].filter((client) => client.attached && !client.socket.destroyed)
    if (scope) return apps.find((client) => client.body === scope) || null
    return apps.length === 1 ? (apps[0] as Client) : null
  }

  async handle(client: Client, message: unknown): Promise<void> {
    const { id, op, args = {} } = (message || {}) as Message
    try {
      const result = await this.dispatch(client, op, args, message as Message)
      if (id !== undefined) this.reply(client, { id, ok: true, result: result === undefined ? null : result })
    } catch (caught) {
      const error = caught as { code?: string; stack?: string; message?: string }
      const code = error.code && protocol.ERROR_CODES.includes(error.code) ? error.code : 'internal'
      if (code === 'internal') log(`${op} 실패`, error.stack || error)
      if (id !== undefined) this.reply(client, protocol.errorReply(id, code, error.message))
    }
  }

  async dispatch(client: Client, op: string | undefined, args: Args, message: Message): Promise<unknown> {
    const scope = this.scopeOf(client, message)
    switch (op) {
      case 'hello':
        return { protocol: protocol.PROTOCOL, daemonVersion: DAEMON_VERSION, pid: process.pid, startedAt: this.startedAt, panes: this.panes.size }
      // ── 앱 전용 ──
      case 'attach':
        return this.attach(client, args)
      case 'state':
        return this.state(scope)
      case 'input':
        this.paneIn(scope, args.pane).write(String(args.data))
        return undefined
      case 'resize':
        this.paneIn(scope, args.pane).resize((args.cols as number) | 0, (args.rows as number) | 0)
        return undefined
      case 'focus':
        return this.focus(scope, args.pane)
      case 'tab new':
        return this.newTab(scope, args)
      case 'tab select':
        return this.selectTab(scope, args.tab)
      case 'workspace select':
        return this.selectWorkspace(scope, args.workspace)
      case 'dock ensure':
        return this.ensureDock(scope, args)
      case 'tab ratio':
        return this.setTabRatio(this.tabIn(scope, args.tab).id, args.path, args.ratio)
      case 'tab size':
        return this.setTabSize(this.tabIn(scope, args.tab).id, (args.cols as number) | 0, (args.rows as number) | 0)
      case 'shutdown':
        setImmediate(() => this.shutdown('앱이 요청'))
        return { panes: this.panes.size }
      // ── 화면 계층(CLI) — 주소 열기 ──
      case 'open-url':
        return this.openUrl(scope, args.url)
      // ── 화면 계층(CLI) ──
      case 'pane list':
        return { panes: await this.flatPanes(this.visiblePanes(scope)) }
      case 'pane get':
        return { pane: (await this.flatPanes([this.paneIn(scope, args.pane)]))[0] }
      case 'pane current': {
        const pane = this.panes.get(this.view(this.viewKeyOf(scope)).focusedPane)
        if (!pane) throw failure('not_found', '포커스된 pane 이 없다')
        return { pane: (await this.flatPanes([pane]))[0] }
      }
      case 'pane split':
        return this.split(scope, args, message.caller)
      case 'pane run':
        this.paneIn(scope, args.pane).write(`${args.text}\r`)
        return undefined
      case 'pane send-text':
        this.paneIn(scope, args.pane).write(String(args.text))
        return undefined
      case 'pane send-keys':
        this.paneIn(scope, args.pane)
        return this.sendKeys(args)
      case 'pane rename':
        this.paneIn(scope, args.pane).label = args.label || null
        this.broadcastState()
        return undefined
      case 'pane read': {
        const pane = this.paneIn(scope, args.pane)
        return { text: model.formatRead(pane.lines(args.source), args.lines) }
      }
      case 'pane wait-output':
        this.paneIn(scope, args.pane)
        return this.waitOutput(args)
      case 'pane is-shell': {
        const pane = this.paneIn(scope, args.pane)
        return { shell: model.isShellIdle(await this.processes(), pane.pid) }
      }
      // 팩 바꾸기용(앱만 쓴다) — pane 셸 pid. 화면 계층 pane 모양(12개 키)은 그대로 두고 따로 준다
      case 'pane pids':
        return { pids: Object.fromEntries(this.visiblePanes(scope).map((pane) => [pane.id, pane.pid])) }
      case 'pane close':
        this.paneIn(scope, args.pane).close()
        return undefined
      case 'workspace list':
        return { workspaces: this.visibleWorkspaces(scope).map((workspace) => this.flatWorkspace(workspace)) }
      case 'workspace get':
        return { workspace: this.flatWorkspace(this.workspaceIn(scope, args.workspace)) }
      case 'workspace create':
        return this.createWorkspace(scope, args)
      case 'tab list':
        return { tabs: this.tabs.filter((tab) => (!args.workspace || tab.workspaceId === args.workspace) && this.sees(scope, this.workspaceBody(tab.workspaceId))).map(flatTab) }
      case 'tab get':
        return { tab: flatTab(this.tabIn(scope, args.tab)) }
      case 'tab rename':
        this.tabIn(scope, args.tab).label = args.label || null
        this.broadcastState()
        return undefined
      case 'tab close':
        return this.closeTab(this.tabIn(scope, args.tab).id)
      default:
        throw failure('usage', `모르는 동작: ${op}`)
    }
  }

  // ── 상태 ───────────────────────────────────────────────────
  paneOf(paneId: string | null | undefined): Pane {
    const pane = this.panes.get(paneId)
    if (!pane) throw failure('not_found', `없는 pane: ${paneId}`)
    return pane
  }

  paneIn(scope: Scope, paneId: string | null | undefined): Pane {
    const pane = this.paneOf(paneId)
    this.checkVisible(scope, this.paneBody(pane), 'pane')
    return pane
  }

  tabIn(scope: Scope, tabId: string | undefined): Tab {
    const tab = this.tabOf(tabId)
    this.checkVisible(scope, this.workspaceBody(tab.workspaceId), '탭')
    return tab
  }

  workspaceIn(scope: Scope, workspaceId: string | undefined): Workspace {
    const workspace = this.workspaceOf(workspaceId)
    this.checkVisible(scope, workspace.body, '작업 공간')
    return workspace
  }

  // 앱 화면이 그릴 상태 — 작업 공간 · 탭(트리) · pane 메타. scope 가 있으면 그 본체 것만(창마다 자기 팩)
  state(scope: Scope = null) {
    const view = this.view(this.viewKeyOf(scope))
    const workspaces = this.visibleWorkspaces(scope)
    const ids = new Set(workspaces.map((workspace) => workspace.id))
    return {
      workspaces: workspaces.map((workspace) => ({ id: workspace.id, label: workspace.label, cwd: workspace.cwd, activeTab: workspace.activeTab, body: workspace.body || null })),
      activeWorkspace: ids.has(view.activeWorkspace as string) ? view.activeWorkspace : null,
      tabs: this.tabs.filter((tab) => ids.has(tab.workspaceId)).map((tab) => ({ id: tab.id, workspace: tab.workspaceId, label: tab.label, tree: tab.tree })),
      focused: this.panes.has(view.focusedPane) && this.sees(scope, this.paneBody(this.panes.get(view.focusedPane))) ? view.focusedPane : null,
      panes: this.visiblePanes(scope).map((pane) => ({ id: pane.id, tab: pane.tabId, dock: pane.dock || null, label: pane.label, title: pane.title, cols: pane.size.cols, rows: pane.size.rows })),
    }
  }

  // 화면 계층 Workspace 모양(screen.py _workspace) — focused 는 그 작업 공간 본체의 보는 자리 기준
  flatWorkspace(workspace: Workspace): { id: string; label: string; active_tab_id: string | null; focused: boolean } {
    return { id: workspace.id, label: workspace.label, active_tab_id: workspace.activeTab, focused: workspace.id === this.view(workspace.body || this.lastKey).activeWorkspace }
  }

  workspaceOf(workspaceId: string | undefined): Workspace {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId)
    if (!workspace) throw failure('not_found', `없는 작업 공간: ${workspaceId}`)
    return workspace
  }

  // 지금 상태 + pane 마다 되살릴 화면. 이 응답 뒤로 같은 소켓에 실시간 출력이 이어진다(빈틈 없음)
  // 앱 창이 붙는다 — body(그 창의 아테나 본체 실제 경로)를 주면 그 본체 것만 보고 받는다(protocol 5). 안 주면 전부
  attach(client: Client, { body }: Args = {}) {
    client.body = typeof body === 'string' && body ? body : null
    const snapshots: Record<string, string> = {}
    for (const pane of this.visiblePanes(client.body)) snapshots[pane.id] = pane.snapshot()
    client.attached = true
    return { state: this.state(client.body), snapshots }
  }

  focus(scope: Scope, paneId: string | undefined): undefined {
    const pane = this.paneIn(scope, paneId)
    const key = this.viewKeyFor(scope, this.paneBody(pane))
    // 고정 칸은 탭이 없다 — 포커스만 옮긴다(보고 있던 작업 공간·탭은 그대로)
    if (pane.dock) {
      this.view(key).focusedPane = pane.id
      this.lastKey = key
    } else this.activate(key, this.tabOf(pane.tabId as string), pane.id)
    this.broadcastState()
    return undefined
  }

  // 그 탭을 보이게(작업 공간까지) 하고 포커스를 옮긴다 — paneId 가 없으면 탭의 첫 pane. key = 바꿀 보는 자리(본체)
  activate(key: string, tab: Tab, paneId: string | null | undefined): void {
    const workspace = this.workspaceOf(tab.workspaceId)
    workspace.activeTab = tab.id
    // 본체가 정해진 작업 공간은 그 본체 자리만 바꾼다 — 다른 본체 창의 화면을 덮지 않게
    const viewKey = workspace.body || key
    const view = this.view(viewKey)
    view.activeWorkspace = workspace.id
    view.focusedPane = paneId || layout.paneIds(tab.tree)[0] || null
    this.lastKey = viewKey || ''
  }

  // ── 탭 · 분할 ──────────────────────────────────────────────
  // 작업 공간 하나 + 셸 탭 하나. 화면 계층 workspace create 는 {workspace, root_pane}
  // 새 작업 공간은 부른 쪽 본체에 속한다(앱 창이면 그 창 · CLI 면 부른 pane 의 작업 공간 본체)
  async createWorkspace(scope: Scope, { label, cwd, focus, cols, rows }: Args) {
    const workdir = cwd && isDirectory(cwd) ? cwd : os.homedir()
    const workspace: Workspace = { id: this.ids.next('w'), label: label || path.basename(workdir), cwd: workdir, activeTab: null, body: scope || null }
    this.workspaces.push(workspace)
    const key = this.viewKeyOf(scope)
    const view = this.view(key)
    const previous = { workspace: view.activeWorkspace, pane: view.focusedPane, lastKey: this.lastKey }
    const { pane } = this.addTab({ key, workspace, cwd: workdir, cols, rows })
    // --no-focus 면 보고 있던 곳 그대로
    if (focus === false && previous.workspace) {
      view.activeWorkspace = previous.workspace
      view.focusedPane = previous.pane
      this.lastKey = previous.lastKey
    }
    this.broadcastState()
    return { workspace: this.flatWorkspace(workspace), root_pane: (await this.flatPanes([pane]))[0] }
  }

  // 앱의 ＋ · ⌘T — 작업 공간을 주지 않으면 지금 작업 공간(없으면 cwd · defaultCwd 이름으로 하나 만든다).
  // 새 탭 폴더는 cwd 를 주지 않으면 그 작업 공간 폴더
  newTab(scope: Scope, { workspace: workspaceId, label, cwd, defaultCwd, cols, rows }: Args): { workspace: string; tab: string; pane: string } {
    const key = this.viewKeyOf(scope)
    let workspace = this.visibleWorkspaces(scope).find((entry) => entry.id === (workspaceId || this.view(key).activeWorkspace))
    if (!workspace) {
      const wanted = cwd || defaultCwd
      const workdir = wanted && isDirectory(wanted) ? wanted : os.homedir()
      workspace = { id: this.ids.next('w'), label: path.basename(workdir), cwd: workdir, activeTab: null, body: scope || null }
      this.workspaces.push(workspace)
    }
    const { tab, pane } = this.addTab({ key, workspace, label, cwd: cwd || workspace.cwd, cols, rows })
    this.broadcastState()
    return { workspace: workspace.id, tab: tab.id, pane: pane.id }
  }

  addTab({ key, workspace, label, cwd, cols, rows }: { key: string; workspace: Workspace; label?: string | null; cwd: string; cols?: number; rows?: number }): { tab: Tab; pane: Pane } {
    const tab: Tab = { id: this.ids.next('t'), workspaceId: workspace.id, label: label || null, tree: null, size: sizeOr({ cols, rows }) }
    this.tabs.push(tab) // pane 환경(ATHENA_STUDIO_WORKSPACE_ID)이 탭을 찾을 수 있게 먼저 넣는다
    const pane = this.spawnPane({ tabId: tab.id, cwd, cols: tab.size.cols, rows: tab.size.rows })
    tab.tree = layout.leaf(pane.id)
    this.activate(key, tab, pane.id)
    return { tab, pane }
  }

  selectTab(scope: Scope, tabId: string | undefined): undefined {
    const tab = this.tabIn(scope, tabId)
    const key = this.viewKeyFor(scope, this.workspaceBody(tab.workspaceId))
    const ids = layout.paneIds(tab.tree)
    const focused = this.view(key).focusedPane
    this.activate(key, tab, ids.includes(focused as string) ? focused : null)
    this.broadcastState()
    return undefined
  }

  selectWorkspace(scope: Scope, workspaceId: string | undefined): undefined {
    const workspace = this.workspaceIn(scope, workspaceId)
    const key = this.viewKeyFor(scope, workspace.body)
    const tab = this.tabs.find((entry) => entry.id === workspace.activeTab) || this.tabs.find((entry) => entry.workspaceId === workspace.id)
    if (tab) this.activate(key, tab, null)
    else {
      this.view(key).activeWorkspace = workspace.id
      this.lastKey = key || ''
    }
    this.broadcastState()
    return undefined
  }

  // 탭 안의 pane 을 모두 닫는다 — 마지막 pane 이 끝나면 탭이 빠진다(paneExited)
  closeTab(tabId: string): undefined {
    const tab = this.tabOf(tabId)
    for (const paneId of layout.paneIds(tab.tree)) this.panes.get(paneId)?.close()
    return undefined
  }

  // 앱에서 pane 경계를 끈 결과 — path 의 가지 비율을 바꾼다
  setTabRatio(tabId: string, path: unknown, ratio: unknown): undefined {
    const tab = this.tabOf(tabId)
    const tree = layout.setRatio(tab.tree, path, ratio)
    if (!tree) throw failure('usage', `없는 경계: ${JSON.stringify(path)}`)
    tab.tree = tree
    this.broadcastState()
    return undefined
  }

  setTabSize(tabId: string, cols: number, rows: number): undefined {
    const tab = this.tabOf(tabId)
    if (cols > 1 && rows > 1) tab.size = { cols, rows }
    return undefined
  }

  tabOf(tabId: string | undefined): Tab {
    const tab = this.tabs.find((entry) => entry.id === tabId)
    if (!tab) throw failure('not_found', `없는 탭: ${tabId}`)
    return tab
  }

  // target: self = 부른 pane(CLI 가 ATHENA_STUDIO_PANE_ID 를 caller 로 보낸다, 없으면 포커스) · focused · pane id
  async split(scope: Scope, { target, direction, ratio, cwd, env, focus }: Args, caller: string | null | undefined) {
    const focusedNow = this.view(this.viewKeyOf(scope)).focusedPane
    let targetId: string | null | undefined = target
    if (target === 'self') targetId = caller && this.panes.has(caller) ? caller : focusedNow
    if (target === 'focused') targetId = focusedNow
    const base = this.paneIn(scope, targetId)
    if (base.dock) throw failure('usage', `고정 칸(${base.dock})은 나눌 수 없다 — 탭의 pane 을 주세요`)
    const tab = this.tabOf(base.tabId as string)
    const pane = this.spawnPane({ tabId: tab.id, cwd: cwd || base.cwd, env, ...base.size })
    tab.tree = layout.splitPane(tab.tree, base.id, pane.id, direction, ratio)
    this.fitTab(tab)
    // 나눈 pane 의 본체 보는 자리로(부른 쪽이 다른 본체를 볼 수는 없다 — paneIn 이 막는다)
    if (focus !== false) this.activate(this.paneBody(base) || this.viewKeyOf(scope), tab, pane.id)
    this.broadcastState()
    return { pane: (await this.flatPanes([pane]))[0] }
  }

  // 앱이 없을 때도 크기가 맞게 탭 크기를 트리대로 나눠 pty 크기를 정한다(앱이 붙어 있으면 앱이 실제 크기로 다시 알린다)
  fitTab(tab: Tab): void {
    const rects = layout.computeRects(tab.tree, { x: 0, y: 0, width: tab.size.cols, height: tab.size.rows }, 1)
    for (const [paneId, rect] of Object.entries(rects)) {
      const pane = this.panes.get(paneId)
      if (pane) pane.resize(Math.max(2, rect.width), Math.max(2, rect.height))
    }
  }

  spawnPane({ tabId, cwd, env = {}, cols, rows }: { tabId: string | null; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number }): Pane {
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
      onData: (data) => this.broadcast({ event: 'data', pane: id, data }, this.paneBody(this.panes.get(id)) || null),
      onExit: (code) => this.paneExited(id, code),
    })
    this.panes.set(id, pane)
    log(`pane ${id} 시작 (탭 ${tabId} · ${workdir})`)
    return pane
  }

  // pane 셸 환경 — 아테나 화면 계층이 스튜디오 pane 인 것을 ATHENA_STUDIO* 로 안다. ELECTRON_RUN_AS_NODE 등 물려받은 세션 표시는 지운다
  paneEnv(paneId: string, tabId: string | null, extra: Record<string, string>): Record<string, string | undefined> {
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

  paneExited(paneId: string, code: number): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    this.panes.delete(paneId)
    if (pane.dock && this.docks.get(pane.dockKey as string) === paneId) this.docks.delete(pane.dockKey as string)
    log(`pane ${paneId} 끝 (${code})`)
    const tab = this.tabs.find((entry) => entry.id === pane.tabId)
    if (tab) {
      tab.tree = layout.removePane(tab.tree, paneId)
      if (tab.tree) this.fitTab(tab)
      else this.removeTab(tab)
    }
    // 보는 자리마다 — 포커스가 사라졌으면 그 본체 안에서 다시 고른다
    for (const [key, view] of this.views) if (view.focusedPane === paneId || !this.panes.has(view.focusedPane) || !this.workspaces.some((entry) => entry.id === view.activeWorkspace)) this.refocus(key)
    this.broadcast({ event: 'exit', pane: paneId, code }, this.paneBody(pane) || null)
    this.broadcastState()
  }

  // 탭 밖 고정 칸 — 이름마다 하나. 없으면 셸을 띄우고 그 셸에서 command 를 실행한다(명령이 끝나도 칸은 남는다)
  ensureDock(scope: Scope, { name, cwd, command, label, cols, rows }: Args): { pane: string; created: boolean } {
    if (!name || typeof name !== 'string') throw failure('usage', 'dock 이름이 없다')
    const dockKey = `${scope || ''}\0${name}` // 본체마다 따로
    const existing = this.panes.get(this.docks.get(dockKey))
    if (existing) return { pane: existing.id, created: false }
    const size = sizeOr({ cols, rows })
    const pane = this.spawnPane({ tabId: null, cwd, cols: size.cols, rows: size.rows })
    pane.dock = name
    pane.dockKey = dockKey
    pane.body = scope || null
    pane.label = label || null
    this.docks.set(dockKey, pane.id)
    if (command) pane.write(`${command}\r`)
    this.broadcastState()
    return { pane: pane.id, created: true }
  }

  // 빈 탭을 빼고, 탭이 없어진 작업 공간도 뺀다
  removeTab(tab: Tab): void {
    this.tabs = this.tabs.filter((entry) => entry !== tab)
    const workspace = this.workspaces.find((entry) => entry.id === tab.workspaceId)
    if (!workspace) return
    const rest = this.tabs.filter((entry) => entry.workspaceId === workspace.id)
    if (!rest.length) this.workspaces = this.workspaces.filter((entry) => entry !== workspace)
    else if (workspace.activeTab === tab.id) workspace.activeTab = (rest[rest.length - 1] as Tab).id
  }

  // 포커스가 사라졌으면 — 그 본체 안에서 지금 작업 공간의 활성 탭 → 다른 작업 공간 순으로
  refocus(key: string): void {
    const view = this.view(key)
    const own = this.visibleWorkspaces(key || null)
    const workspace = own.find((entry) => entry.id === view.activeWorkspace) || own[own.length - 1]
    if (!workspace) {
      view.activeWorkspace = null
      view.focusedPane = null
      return
    }
    const tab = this.tabs.find((entry) => entry.id === workspace.activeTab) || this.tabs.find((entry) => entry.workspaceId === workspace.id)
    view.activeWorkspace = workspace.id
    view.focusedPane = tab ? layout.paneIds(tab.tree)[0] : null
  }

  // ── 쓰기 · 읽기 ────────────────────────────────────────────
  sendKeys({ pane: paneId, keys }: Args): undefined {
    const pane = this.paneOf(paneId)
    const bytes = (keys as string[]).map((key) => {
      const value = model.keyBytes(key)
      if (value === null) throw failure('usage', `모르는 키: ${key}`)
      return value
    })
    pane.write(bytes.join(''))
    return undefined
  }

  waitOutput({ pane: paneId, match, regex, lines, timeout }: Args): Promise<{ text: string }> {
    const pane = this.paneOf(paneId)
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const waiter: Waiter = {
        check: () => {
          let found: string | null
          try {
            found = model.findMatch(model.formatRead(pane.lines('recent'), lines), { match, regex })
          } catch (error) {
            waiter.fail('usage', (error as Error).message)
            return true
          }
          if (found === null) return false
          clearTimeout(timer as NodeJS.Timeout)
          resolve({ text: `${found}\n` })
          return true
        },
        fail: (code, text) => {
          clearTimeout(timer as NodeJS.Timeout)
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
  async flatPanes(panes: Pane[]) {
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
        foregroundCwd: cwds[foreground[index] as number] || null,
        focused: pane.id === this.view(this.paneBody(pane) || this.lastKey).focusedPane,
        agent,
        agentStatus: model.agentStatus({ agent, screenLines: pane.lines('visible'), lastOutputAt: pane.lastOutputAt, now }),
        title: pane.title,
        cols: pane.size.cols,
        rows: pane.size.rows,
      })
    })
  }

  processes(): Promise<ProcessRow[]> {
    if (this.processCache && Date.now() - this.processCache.at < PROCESS_CACHE_MS) return this.processCache.rows
    const rows = new Promise<ProcessRow[]>((resolve) => {
      execFile('ps', ['-axo', 'pid=,pgid=,tpgid=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : model.parsePs(stdout)))
    })
    this.processCache = { at: Date.now(), rows }
    return rows
  }
}

// node 로 도는 앞쪽 프로세스만 인자를 본다(npm 판 codex) — 앞쪽 그룹 밖은 묻지 않는다
function nodeArgs(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 })
  } catch {
    return null
  }
}

// pid → cwd. lsof 한 번으로 묶는다
function foregroundCwds(pids: number[]): Promise<Record<number, string>> {
  const unique = [...new Set(pids.filter(Boolean))]
  if (!unique.length) return Promise.resolve({})
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', unique.join(',')], { timeout: 2000 }, (_error, stdout) => {
      const cwds: Record<number, string> = {}
      let current: number | null = null
      for (const line of String(stdout || '').split('\n')) {
        if (line.startsWith('p')) current = Number(line.slice(1))
        else if (line.startsWith('n') && current) cwds[current] = line.slice(1)
      }
      resolve(cwds)
    })
  })
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// 지난 데몬이 남긴 id 번호 — 없거나 깨졌으면 처음부터
function readIds(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

// 못 써도 데몬은 계속 돈다(그 데몬 안에서는 번호가 겹치지 않는다) — 로그만
function writeIds(file: string, counters: Record<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(counters))
  } catch (error) {
    log('id 번호를 남기지 못했다', file, (error as Error).message)
  }
}

function sizeOr({ cols, rows }: { cols?: number; rows?: number }): Size {
  return { cols: (cols as number) > 1 ? (cols as number) | 0 : DEFAULT_SIZE.cols, rows: (rows as number) > 1 ? (rows as number) | 0 : DEFAULT_SIZE.rows }
}

// 화면 계층 Tab 모양
function flatTab(tab: Tab): { id: string; workspace_id: string; label: string | null } {
  return { id: tab.id, workspace_id: tab.workspaceId, label: tab.label }
}

function failure(code: string, message: string): Failure {
  const error = new Error(message) as Failure
  error.code = code
  return error
}

async function main(): Promise<void> {
  process.title = 'athena-studio-daemon'
  const args = parseArgs(process.argv.slice(2))
  const defaults = defaultPaths()
  const daemon = new Daemon({ socket: args.socket || defaults.socket, endpoint: args.endpoint || defaults.endpoint, cli: args.cli })
  // 예외 하나로 데몬이 죽으면 모든 셸이 SIGHUP 으로 같이 죽는다 — 로그만 남기고 계속 돈다
  process.on('uncaughtException', (error) => log('잡히지 않은 예외', error.stack || error))
  process.on('unhandledRejection', (error) => log('처리 안 된 거절', (error && (error as Error).stack) || error))
  process.on('SIGTERM', () => daemon.shutdown('SIGTERM'))
  process.on('SIGHUP', () => {}) // 띄운 터미널이 닫혀도 산다
  await daemon.start()
}

// 바로 띄웠을 때만(require.main === module 과 같다)
if (import.meta.main) {
  main().catch((error: Error) => {
    log('데몬 시작 실패', error.message)
    process.exit(1)
  })
}
