// Athena Studio 메인 프로세스 — 창 · 메뉴(단축키) · 작업 창(데몬에 붙기) · 현황판 서버 · 아테나 폴더 설정
// 창마다 팩 하나 — 창마다 그 팩 본체(athenaDir) · 데몬 연결(본체로 묶임) · 현황판 · 옆 브라우저 · 모니터를 따로 갖는다(createPackWindow).
// 앱 전체에 하나인 것: 언어 · 앱 설정 · 데몬 프로세스 · 메뉴 · 메뉴 막대(Tray — 앞에 있는 창의 팩만)
// Electron main 진입점(package.json main) — ES 모듈(.mts · 빌드 없음 · Electron 44 가 타입만 지우고 읽는다).
// Electron 은 이 파일을 끝까지 읽은 뒤에 ready 를 낸다(2026-10-27 실측 — 맨 위 await 1.5초를 넣어도 ready 전) — 아래 app.setName · setPath 는 그대로 ready 전이다.
// 가져온 모듈은 이 파일 본문보다 먼저 돈다 — src/main/*.mts 는 맨 위에서 함수 · 상수만 만든다(app 자리를 읽지 않는다)
import { app, autoUpdater, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions, Session, WebContents } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as core from './lib/core.mts'
import * as daemonClient from './daemon-client.mts'
import * as agentLanguage from './lib/agent-language.mts'
import * as tokenUsage from './lib/token-usage.mts'
import * as i18n from './lib/i18n.mts'
import type { AppConfig } from './lib/core.mts'
import { newMonitor, createMonitorLogs } from './main/monitor-logs.mts'
import { createFiles, guarded } from './main/files.mts'
import { createBoard } from './main/board.mts'
import { installExplorer } from './main/explorer-panel.mts'
import { installAthenaAgent } from './main/athena-agent.mts'
import { installPackRepos } from './main/pack-repos.mts'
import { installWork } from './main/work.mts'
import { installAthenaDir } from './main/athena-dir.mts'
import { installPacks } from './main/packs.mts'
import { installSideBrowser } from './main/side-browser.mts'
import { installPackWindow } from './main/pack-window.mts'
import { APP_UPDATE_CHECK_MS, createAppUpdater } from './main/app-updater.mts'
import { createCoreRunner } from './main/core-runner.mts'
import { installDaemonLink } from './main/daemon-link.mts'
import { installWorkspaces } from './main/workspaces.mts'
import { installAgentMonitor } from './main/agent-monitor.mts'
import { installPaneWatch } from './main/pane-watch.mts'
import { installCatchUp } from './main/catch-up.mts'
import { setupTray } from './main/tray.mts'
import type { PackCtx, Size } from './main/daemon-link.mts'
import type { ExplorerCtx } from './main/explorer-panel.mts'
import type { AthenaAgentCtx } from './main/athena-agent.mts'
import type { PackReposCtx } from './main/pack-repos.mts'
import type { WorkCtx, RequestsState } from './main/work.mts'
import type { AthenaDirCtx } from './main/athena-dir.mts'
import type { PacksCtx } from './main/packs.mts'
import type { SideBrowserCtx } from './main/side-browser.mts'
import type { PackWindowCtx } from './main/pack-window.mts'
import type { TrayCtx } from './main/tray.mts'

// studio-home 은 JS · 사전은 JSON — 다른 src/main/*.mts 와 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const studioHome: typeof import('./lib/studio-home.js') = require('./lib/studio-home.js')
type Dictionary = Record<string, string>
type Ensured = Awaited<ReturnType<typeof daemonClient.ensureDaemon>>

// 팩 창 문맥(createPackWindow 의 ctx) — 각 묶음(src/main/*.mts)이 읽고 붙이는 칸을 모두 합친 것 + 아래 IPC · 메뉴가 부르는 것
// (묶음 쪽 타입이 unknown 으로 둔 칸은 여기서 부르는 모양만 적는다 — 모양은 그 묶음의 구현과 같다)
type Loose = { [key: string]: unknown } | null | undefined
type Point = { x?: unknown; y?: unknown } | null
type MainCalls = {
  uiTab: string
  packAbort: AbortController | null
  athenaState(): unknown
  pickAthenaDir(): Promise<unknown>
  installAthena(): Promise<unknown>
  refreshPacks(): Promise<unknown>
  packOpen(id: string, options: { newWindow: boolean }): Promise<unknown>
  packNew(): Promise<unknown>
  packInspect(kind: string, source: string | null): Promise<unknown>
  packImport(token: string, choice: string): Promise<unknown>
  packExport(kind: string): Promise<unknown>
  packIcon(id: string): Promise<unknown>
  packSetName(id: string, name: string | null): Promise<unknown>
  packSetIcon(id: string, clear: boolean, usePicked: boolean): Promise<unknown>
  packPickIcon(kind: string): Promise<unknown>
  repoIcon(name: string): Promise<unknown>
  repoSetName(name: string, displayName: string | null): Promise<unknown>
  repoSetIcon(name: string, clear: boolean, usePicked: boolean): Promise<unknown>
  packContextMenu(id: string, point: Point): unknown
  show(tab?: string): void
  close(): void
  mergeSettings(): Promise<unknown>
  setAutoMerge(repo: string, values: { autoMerge: boolean | null; confirm: boolean | null }): Promise<unknown>
  callInfo(name: string): Promise<unknown>
  callStart(name: string, options: { branch: string; reuse: boolean }): Promise<unknown>
  packRestore(options: { discard: boolean }): Promise<unknown>
  openAthenaAgent(size: Record<string, unknown>, options: { keepView: boolean }): Promise<unknown>
  newTab(size: Size): Promise<unknown>
  closeTab(tabId: string): Promise<unknown>
  newWorkspace(size: Size): Promise<unknown>
  deletePack(id: string, options: { withWorktrees: boolean }): Promise<unknown>
  bodyBehind(): Promise<unknown>
  removeRepo(name: string): Promise<unknown>
  closeWorkspace(workspaceId: string): Promise<unknown>
  spaceContextMenu(target: { repo: string | null; workspace: string | null }, point: Point): Promise<unknown>
  addRepo(dir: string, name: string | null): Promise<unknown>
  explorerList(workspaceId: unknown, relative: unknown): Promise<unknown>
  explorerStatus(workspaceId: unknown): Promise<unknown>
  explorerOpen(workspaceId: unknown, relative: unknown): Promise<unknown>
  closePane(paneId: string): Promise<unknown>
  paneContextMenu(point: Point, title?: string): Promise<unknown>
  openBoardExternal(): Promise<unknown>
  workState(): Promise<unknown>
  refreshRequests(): Promise<unknown>
  answerRequest(id: string, answer: { choice: string; text: string }): Promise<unknown>
  redeliverRequest(id: string): Promise<unknown>
  openPlan(id: string, html: string | null): Promise<unknown>
  openBoardSection(section: string): Promise<unknown>
  openDiagrams(): Promise<unknown>
  workDetail(id: string): Promise<unknown>
  paneBound(): unknown
  paneDetail(paneId: string): Promise<unknown>
  pollPanes(): Promise<unknown>
  prepareBoardPort(): void
  watchRequests(): void
  isBrowserContents(contents: WebContents): boolean
  openInBrowser(url: string): void
  placeBrowser(rect: { x: number; y: number; width: number; height: number } | null): void
  hideBrowser(): void
  browserCommand(name: string, value: string): unknown
}
type PackWindow = PackCtx & ExplorerCtx & AthenaAgentCtx & PackReposCtx & WorkCtx & AthenaDirCtx & PacksCtx & SideBrowserCtx & PackWindowCtx & TrayCtx & MainCalls

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
const CORE_BUNDLE = studioHome.coreBundlePath({ appRoot: path.join(import.meta.dirname, '..'), packaged: app.isPackaged, resourcesPath: process.resourcesPath })
// 앱 아이콘 — 둥근 사각형 앱 아이콘(1024 · Dock · 윈도우·리눅스 창). 화면 안 로고는 화이트판(athena-logo-white.png)
const APP_ICON = path.join(import.meta.dirname, 'renderer', 'assets', 'logo', 'athena-app-icon.png')
// 창 · 빈 옆 브라우저 바탕 — renderer style.css --bg 와 같은 값
const APP_BACKGROUND = '#16171a'
// Ctrl 조합은 pane 안(셸·에이전트) 몫이라 앱 단축키는 Cmd(맥) · Alt(그 밖)로만 건다
const TAB_KEY = isMac ? 'Command' : 'Alt'

// 앱 설정(언어 · 열린 팩 창 목록 windows · 옛 현황판 포트 …) — 켤 때(whenReady) 읽는다. 그 전에는 null 이고 쓰는 곳은 모두 그 뒤
let config = null as unknown as AppConfig
const packWindows = new Set<PackWindow>() // 열린 팩 창 — createPackWindow 의 문맥
let lastFocused: PackWindow | null = null // 마지막으로 앞에 있던 팩 창(메뉴 · 메뉴 막대가 이 창 기준)

// ── 언어 ──────────────────────────────────────────────────
// 사전은 src/i18n/<언어>.json. 앱 설정 language → 없으면 시스템 언어(app.getLocale()) → 네 언어 밖이면 영어.
// 화면 · 트레이 창은 preload 가 i18n:get 으로 사전을 받고, 바꾸면 i18n:changed 로 다시 받는다
const DICTIONARIES: Record<string, Dictionary> = Object.fromEntries(i18n.LANGUAGES.map((lang) => [lang, require(`./i18n/${lang}.json`) as Dictionary]))
let language = i18n.FALLBACK_LANGUAGE
const say = (key: string, values?: Record<string, unknown>): string => i18n.t(DICTIONARIES[language], key, values, DICTIONARIES[i18n.FALLBACK_LANGUAGE])
const i18nPayload = () => ({ language, dictionary: DICTIONARIES[language], fallback: DICTIONARIES[i18n.FALLBACK_LANGUAGE] })
const reloadKey = () => (isMac ? '⌘' : 'Alt+')

// 메뉴 [보기 → 언어] — 고른 언어를 앱 설정에 적고 메뉴 · 트레이 · 창을 다시 그린다
function setLanguage(next: string): void {
  if (!i18n.LANGUAGES.includes(next) || next === language) return
  language = next
  config = { ...config, language: next }
  core.saveConfig(configFile(), config)
  buildMenu()
  refreshTray()
  for (const window of [...[...packWindows].map((ctx) => ctx.win), trayPanel()]) {
    if (window && !window.isDestroyed()) window.webContents.send('i18n:changed', i18nPayload())
  }
  if (trayPanel() && trayPanel()!.isVisible()) sendTrayUpdate()
  for (const ctx of packWindows) syncAgentLanguage(ctx.athenaDir)
}

// 에이전트 답 언어 — 앱 언어를 본체 .claude/settings.local.json 의 language 로(lib/agent-language.mts).
// 코어 훅이 메시지마다 다시 읽어서 켜 둔 세션에도 다음 메시지부터 먹는다. .claude 가 없는 폴더(본체 아님)는 건드리지 않는다
function syncAgentLanguage(dir: string | null): void {
  if (!dir || !fs.existsSync(path.join(dir, '.claude'))) return
  const file = agentLanguage.settingsFile(dir)
  try {
    const next = agentLanguage.withLanguage(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, language)
    if (next !== null) fs.writeFileSync(file, next)
  } catch (error) {
    console.error(`[agent-language] ${file}: ${(error as Error).message}`)
  }
}

const configFile = () => path.join(app.getPath('userData'), 'config.json')
const boardLogFile = () => path.join(app.getPath('userData'), 'board.log')

// 맥에서 Finder · Dock 으로 켠 앱은 PATH 가 /usr/bin:/bin 뿐이다. 로그인 셸의 PATH 를 받아 쓴다
function loadLoginPath(): Promise<string | null> {
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
function ctxOf(event: IpcMainEvent | IpcMainInvokeEvent): PackWindow | null {
  for (const ctx of packWindows) {
    if (ctx.win && !ctx.win.isDestroyed() && event.sender === ctx.win.webContents && event.senderFrame === event.sender.mainFrame) return ctx
  }
  return null
}

// 메뉴 · 메뉴 막대가 다룰 창 — 앞에 있는 팩 창, 없으면 마지막으로 앞에 있던 창, 그것도 없으면 아무 창
function frontCtx(): PackWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  for (const ctx of packWindows) if (ctx.win === focused) return ctx
  if (lastFocused && packWindows.has(lastFocused)) return lastFocused
  return [...packWindows][0] || null
}

function ctxOfBody(dir: string): PackWindow | null {
  return [...packWindows].find((ctx) => ctx.athenaDir && core.sameDir(ctx.athenaDir, dir)) || null
}

// 열린 창 목록을 앱 설정에 — 다음에 켤 때 다시 연다. 끄는 중(⌘Q)에는 닫히는 창을 빼지 않는다
function saveWindows(): void {
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
let heldDirs: string[] = [] // 옛 데몬이라 켤 때 다시 열지 않은 팩 창 본체 — 맞는 데몬에 붙으면 연다

// 맞는 데몬에 붙었다 — 미뤄 둔 팩 창을 연다
function releaseHeldWindows(): void {
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
    uid: process.getuid!(),
    endpoint: process.env.ATHENA_STUDIO_ENDPOINT || STUDIO.endpoint,
    socketTag: IDENTITY.socketTag,
  })

// 데몬 쪽 오류 중 화면에 보이는 것 — 연결 끊김 · 붙기 실패는 사전 문구로(나머지 데몬 오류는 데몬이 쓴 글 그대로)
function daemonErrorText(error: Error & { code?: unknown; log?: unknown }): string {
  if (error.code === 'unavailable') return say('error.daemonDisconnected')
  if (error.code === 'attach-failed') return say('error.daemonAttach', { path: error.log })
  return error.message
}

// 데몬과 앱의 프로토콜이 다르다 — 다시 띄우면 모든 pane·에이전트가 닫히므로 묻는다(S3). 창이 여럿이어도 한 번만 묻는다
let restartAsking: Promise<boolean> | null = null
function askRestartDaemon(result: Ensured, parentWindow: BrowserWindow | null): Promise<boolean> {
  if (!restartAsking) {
    restartAsking = (async () => {
      const hello = result.hello as { panes?: number } | null
      const count = (hello && hello.panes) || 0
      const choice = await dialog.showMessageBox(parentWindow as BrowserWindow, {
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
async function restartDaemon(): Promise<void> {
  const ctx = frontCtx()
  const choice = await dialog.showMessageBox((ctx ? ctx.win : null) as BrowserWindow, {
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
  // 옛 연결이 닫혀 화면이 screen:disconnected 를 먼저 받은 뒤에 resync 를 보낸다 — 거꾸로 가면 다시 붙는 중에 끊김 표시로 덮인다
  // (옛 데몬이 빨리 내려가면 waitDaemonGone 이 바로 돌아와 resync 가 앞섰다 · 2026-10-28 화면 확인에서 재현). 답 없는 소켓이면 1초만 기다린다
  const detached = [...packWindows].map((each) => each.detachScreen())
  await Promise.race([Promise.all(detached), new Promise((resolve) => setTimeout(resolve, 1000))])
  await daemonClient.waitDaemonGone(daemonPaths().socket)
  for (const each of packWindows) each.send('screen:resync')
}

// 스튜디오 초기화(메뉴 보기) — 처음 켠 것처럼: 현황판 · 데몬(모든 pane · 에이전트)을 끄고 스튜디오 집의 코어 · 본체 · 팩 데이터 ·
// 이 앱의 데몬 파일을 지운 뒤 창 목록을 비우고 앱을 다시 띄운다. 회사 레포 클론 · 언어 설정 · 다른 앱의 접속 파일은 둔다
async function resetStudio(): Promise<void> {
  const ctx = frontCtx()
  const plan = studioHome.resetPlan(STUDIO)
  const choice = await dialog.showMessageBox((ctx ? ctx.win : null) as BrowserWindow, {
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
    dialog.showErrorBox(say('dialog.studioReset.message'), say('error.studioReset', { message: (error as Error).message }))
  }
  config = core.withWindows(config, [])
  core.saveConfig(configFile(), config)
  app.relaunch()
  app.exit(0)
}

// ── 공용 도우미 — src/main/*.mts(에이전트 모니터 기록 읽기 · Explorer · 파일 뷰어 · 현황판) ─────
// 쓰는 것(기록 폴더 · 화면 문구 · 현황판 로그 · 데몬 자리 · 팩 명령)은 인자로 넘긴다. runPack 은 아래(코어 · 팩 명령)에서 정의돼 부를 때 찾는다
const { findMonitorLogs } = createMonitorLogs({ projectsDir: path.join(app.getPath('home'), '.claude', 'projects') })
const { resolveInside } = createFiles({ say })
const { startBoard, stopStaleBoard } = createBoard({ say, boardLogFile, daemonPaths, runPack: (args, options) => runPack(args, options) })

// ── 앱 업데이트(⚙ 설정 팝업 맨 아래 · 개발 앱 체크아웃만 — 결정 D2) — src/main/app-updater.mts ─────────────
// 쓰는 것(electron app · dialog · 화면 문구 · 스튜디오 집 자리 · 팩 창 목록)은 인자로 넘긴다
const { appVersion, appUpdateView, checkAppUpdate, runAppUpdate, showAppUpdateNotice } = createAppUpdater({ app, dialog, say, language: () => language, studio: STUDIO, packWindows })

// ── 회사 팩 — 본체 명령(공용) ────────────────────────────────
// 팩 일은 아테나 본체가 한다 — 스튜디오는 `node scripts/athena.mjs pack … --json` 을 부르고, 기다리고, 결과를 보여 준다.
// 약속: 코어 `pack … --json` 출력(contract 3 · 코어는 athena/). 팩 파일 · 링크는 직접 만지지 않는다.
// 가져오기에서 [열고 작업 되살리기] — 되살릴 팩 id. 그 팩을 연 창이 아테나를 켤 때(openAthenaAgent) 한 번 되살리고 지운다
let restoreArmedFor: string | null = null
// 사람에게 묻는 요청 — 요청 폴더 감시를 놓칠 때를 대비해 이만큼마다 한 번 더 읽는다
const REQUESTS_POLL_MS = 30000
const packLogFile = () => path.join(app.getPath('userData'), 'pack.log')

// 아테나 폴더 · 스튜디오 코어 준비 · 코어 · 팩 명령 실행 — src/main/core-runner.mts(PACK_TIMEOUTS 도 거기 — 팩을 바꾸는 명령은 시간이 넘어도 끊지 않는다).
// 쓰는 것(electron app · dialog · 화면 문구 · 지금 언어 · 스튜디오 집 자리 · 코어 번들 · 데몬 자리 · 팩 로그 자리)은 인자로 넘긴다
const { athenaReposRoot, prepareStudioCore, showCoreUpdateNotice, coreInstallError, runCore, runPack, contractBlock } = createCoreRunner({ app, dialog, say, language: () => language, studio: STUDIO, coreBundle: CORE_BUNDLE, daemonPaths, packLogFile })

// [Finder 에서 보기] — 방금 만든 파일만
let lastPackFile: string | null = null
function packReveal(): void {
  if (lastPackFile && fs.existsSync(lastPackFile)) shell.showItemInFolder(lastPackFile)
}

// 열린 팩 창들의 팩 id — 팩 줄이 '열려 있음' 을 보여 준다
const openPackIds = (): string[] => [...packWindows].map((ctx) => ctx.packState.current && ctx.packState.current.id).filter((id): id is string => Boolean(id))

// 레지스트리가 바뀌었다(이름 · 이미지 · 가져오기 · 새 팩) — 모든 팩 창의 목록을 새로
function refreshAllPacks(): void {
  for (const ctx of packWindows) ctx.refreshPacks().catch(() => {})
}

// ── 팩 창 ─────────────────────────────────────────────────
// 창 하나 = 팩 본체 하나. welcome — 앱을 켤 때 첫 창이면 시작 화면 규칙(launchWelcome)을 본다
function createPackWindow(athenaDir: string | null, { welcome = false }: { welcome?: boolean } = {}): PackWindow {
  // 처음 칸만 — 나머지(send · athenaState · daemonCall …)는 아래에서 붙인다
  const start: Pick<PackWindow, 'athenaDir' | 'win' | 'packState' | 'packBusy' | 'packAbort' | 'uiTab'> = {
    athenaDir: athenaDir || null,
    win: null,
    packState: { supported: false },
    packBusy: null, // 지금 하는 일(가져오기 · 내보내기 …) — 창마다 한 번에 하나
    packAbort: null, // 기다리는 중 · 검사 중이면 취소할 수 있다
    uiTab: 'work',
  }
  const ctx = start as PackWindow
  syncAgentLanguage(ctx.athenaDir)
  // ── 데몬 연결 · pane · 작업 공간 · 에이전트 모니터 · pane [상세] · 따라잡기 — src/main/*.mts(ctx 에 같은 이름으로 붙는다) ──
  let launchWelcome: boolean | null = welcome ? null : false // 켤 때 시작 화면 — 첫 창만 정한다(null = 아직 안 정함)
  let packBoardPort: number | null = null // 이 본체 현황판 포트(pack status) — 옛 본체면 null(앱 설정 boardPort)
  const monitor = newMonitor()

  const send = (channel: string, ...args: unknown[]): void => {
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send(channel, ...args)
  }
  ctx.send = send
  ctx.packProgress = (step: unknown) => send('pack:progress', step)

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

  // 데몬 연결(창마다 하나 · 이 창의 본체로 묶인다 · protocol 5) — 옛 데몬 표시(daemonOld)는 main.mts 가 갖는다
  installDaemonLink(ctx, { say, daemonPaths, daemonErrorText, askRestartDaemon, setDaemonOld: (old) => (daemonOld = old), releaseHeldWindows, openUrl })
  const daemonCall = ctx.daemonCall
  // pane · 탭 · 작업 공간 닫기 · 새 작업 공간 · 팩 레포 더하기 · 빼기 · 우클릭 메뉴
  // 묶음은 runCore · runPack 답에서 읽는 칸만 적은 모양으로 받는다(같은 함수)
  installWorkspaces(ctx, { app, dialog, Menu, say, studio: STUDIO, tabKey: TAB_KEY, runCore: runCore as unknown as Parameters<typeof installWorkspaces>[1]['runCore'] })
  // 에이전트 모니터 — monitor 는 위(팩을 바꿀 때 resetMonitor 가 비운다)
  installAgentMonitor(ctx, { monitor, findMonitorLogs })
  // pane [상세] · pane 목록 갱신(pollPanes) · 작업 공간 브랜치
  installPaneWatch(ctx, { monitor, paneTokens })
  // 팩 본체가 주 본체 코어보다 뒤처졌으면 따라잡기(catchUpBody)
  installCatchUp(ctx, { studio: STUDIO, runPack: runPack as unknown as Parameters<typeof installCatchUp>[1]['runPack'], packLogFile })

  // ── 오른쪽 Explorer · 아테나 에이전트 · 되살리기 · 팩 레포 · 현황판 · 요청 · [작업] — src/main/*.mts ──
  // ctx 에 같은 이름으로 붙는다(부르는 쪽 · IPC 는 그대로). 쓰는 것(화면 문구 · 코어 명령 · 현황판 · 앱 설정)은 인자로 넘긴다
  installExplorer(ctx, { say, resolveInside })
  installAthenaAgent(ctx, { say, runPack, disarmRestore: () => (restoreArmedFor = null) })
  installPackRepos(ctx, { say, runPack, daemonPaths })
  // 요청 목록은 이 창 변수 그대로 — pane [상세] 도 읽는다
  let requestsState: RequestsState = { supported: false, requests: [] }
  installWork(ctx, {
    say,
    runCore,
    runPack,
    startBoard,
    stopStaleBoard,
    reloadKey,
    requestsPollMs: REQUESTS_POLL_MS,
    trayRequestsChanged: (target) => trayRequestsChanged(target as PackWindow),
    appConfig: () => config,
    saveAppConfig: (next) => {
      config = next as AppConfig
      core.saveConfig(configFile(), config)
    },
    packBoardPort: () => packBoardPort,
    setPackBoardPort: (port) => (packBoardPort = port),
    requestsState: () => requestsState,
    setRequestsState: (next) => (requestsState = next),
  })
  const boardPortNow = ctx.boardPortNow

  // ── 아테나 폴더 · 회사 팩 · 팩 표시 이름 · 이미지 · 옆 브라우저 · 창 — src/main/*.mts ──
  // ctx 에 같은 이름으로 붙는다(부르는 쪽 · IPC 는 그대로). 쓰는 것(electron · 화면 문구 · 코어 명령 · 창 찾기 · 앱 값)은 인자로 넘긴다
  installAthenaDir(ctx, {
    app,
    dialog,
    say,
    studio: STUDIO,
    athenaReposRoot,
    prepareStudioCore,
    coreInstallError,
    ctxOfBody,
    saveWindows,
    syncAgentLanguage,
    monitor,
    setPackBoardPort: (port) => (packBoardPort = port),
    hasTray,
    pollTray,
  })
  installPacks(ctx, {
    app,
    dialog,
    Menu,
    say,
    studio: STUDIO,
    runPack,
    contractBlock,
    packWindows,
    openPackIds,
    refreshAllPacks,
    ctxOfBody,
    openBody,
    daemonOld: () => daemonOld,
    restoreArmedFor: () => restoreArmedFor,
    disarmRestore: () => (restoreArmedFor = null),
    setLastPackFile: (file) => (lastPackFile = file),
    launchWelcome: () => launchWelcome,
    setLaunchWelcome: (value) => (launchWelcome = value),
  })
  // 옆 브라우저 — 창마다 서랍 하나(뷰는 그 안에 · 본체별 마지막 주소 browserUrls 는 창끼리 같이 쓴다)
  installSideBrowser(ctx, { say, browserUrls, browserPartition: BROWSER_PARTITION, watchConsoleSends, appBackground: APP_BACKGROUND })
  // 창 — 만들고 focus · close · closed 를 건다
  installPackWindow(ctx, {
    packWindows,
    openPackIds,
    saveWindows,
    openUrl,
    hasTray,
    pollTray,
    monitor,
    appIcon: APP_ICON,
    appBackground: APP_BACKGROUND,
    quitting: () => quitting,
    lastFocused: () => lastFocused,
    setLastFocused: (next) => (lastFocused = next as PackWindow | null),
  })
  packWindows.add(ctx)
  ctx.prepareBoardPort()
  ctx.watchRequests()
  return ctx
}

// 본체 경로 → 그 창(있으면 앞으로, 없으면 새로). 창 하나 = 본체 하나
function openBody(body: unknown): { error?: string; code?: string; existing?: boolean } {
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
// ctx — 링크를 연 팩 창(묶음마다 문맥 타입이 달라 object 로 받는다 · 들어오는 것은 모두 createPackWindow 의 ctx)
function openUrl(ctx: object | null, url: string): 'deny' | 'panel' | 'external' {
  const target = core.openTarget(url)
  if (target === 'external') shell.openExternal(url)
  if (target === 'panel' && ctx) (ctx as PackWindow).openInBrowser(url)
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
function watchConsoleSends(browserSession: Session): void {
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
let panesTimer: ReturnType<typeof setInterval> | undefined = undefined
function startPanesPolling(): void {
  clearInterval(panesTimer)
  panesTimer = setInterval(() => {
    for (const ctx of packWindows) ctx.pollPanes().catch(() => {})
  }, 2000)
}

// ── 메뉴 막대(Tray) — 앞에 있는 창의 팩만 — src/main/tray.mts ───────────────────
// 쓰는 것(화면 문구 · 앞 창 찾기 · 열린 팩 창 · 지난 창 다시 열기)은 인자로 넘긴다. tray · 패널 창은 바뀌는 값이라 hasTray() · trayPanel() 로 읽는다
const { createTray, refreshTray, sendTrayUpdate, pollTray, trayRequestsChanged, showWindow, hasTray, trayPanel } = setupTray({ say, frontCtx, packWindows, openSavedWindows })

// ── 창 · 메뉴 ─────────────────────────────────────────────
// 지난번에 열려 있던 팩 창들을 다시 연다 — 첫 창만 시작 화면 규칙을 본다. 본체가 없으면 처음 화면(아테나 폴더 고르기) 창 하나.
// 첫 창은 바로 만든다(showWindow 가 곧바로 찾는다). 두 번째 창부터는 데몬 버전을 본 뒤 — 옛 데몬이면 열지 않고 남겨 둔다
function openSavedWindows(): void {
  const dirs = core.windowDirs(config, core.sameDir).filter((dir) => core.checkAthenaDir(dir).ok)
  if (!dirs.length) {
    createPackWindow(config.athenaDir || null, { welcome: true })
    return
  }
  const first = createPackWindow(dirs[0] as string, { welcome: true })
  if (dirs.length === 1) return
  heldDirs = dirs.slice(1)
  first
    .connectDaemon()
    .catch(() => null)
    .then((): unknown => {
      if (!daemonOld) return releaseHeldWindows()
      if (!heldDirs.length) return undefined
      const notice = { type: 'info' as const, message: say('pack.open.heldWindows', { count: heldDirs.length }) }
      return (first.win ? dialog.showMessageBox(first.win, notice) : dialog.showMessageBox(notice)).catch(() => null)
    })
}

// 메뉴 [보기 → 언어] — 언어 이름은 그 언어로, 검수 전 사전은 그 언어의 '검수 전' 표시를 붙인다
function languageMenu(): MenuItemConstructorOptions[] {
  return i18n.LANGUAGES.map((lang) => {
    const dictionary = DICTIONARIES[lang] as Dictionary
    const draft = dictionary['meta.status'] === 'draft' ? ` (${dictionary['meta.draftLabel']})` : ''
    return { label: `${dictionary['meta.name']}${draft}`, type: 'radio', checked: lang === language, click: () => setLanguage(lang) }
  })
}

// 배포판 Resources 의 THIRD_PARTY_NOTICES.txt 를 기본 앱(텍스트 편집기)으로 연다 — 못 열면 이유를 알림 창으로
function openThirdPartyNotices(): void {
  const file = path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
  shell.openPath(file).then((error) => {
    if (error) dialog.showMessageBox({ type: 'warning', message: say('menu.app.notices'), detail: `${file}\n${error}` }).catch(() => null)
  })
}

// Electron role 항목도 라벨을 사전에서 준다(role 기본 라벨은 영어 고정이라 앱 언어와 어긋난다)
function appMenu(): MenuItemConstructorOptions {
  const name = 'Athena' // 보이는 이름(트레이 · 정보 창과 같다) — app.getName() 은 데이터 폴더 이름 Athena Studio
  return {
    role: 'appMenu',
    submenu: [
      { role: 'about', label: say('menu.app.about', { name }) },
      // 제3자 고지 — 배포판에만 있다(scripts/package-mac.js 가 Resources 에 넣는다 · 약관 EULA 5절이 가리킨다)
      ...(app.isPackaged ? [{ label: say('menu.app.notices'), click: () => openThirdPartyNotices() }] : []),
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

function windowMenu(): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = isMac
    ? [{ role: 'minimize', label: say('menu.window.minimize') }, { role: 'zoom', label: say('menu.window.zoom') }, { type: 'separator' }, { role: 'front', label: say('menu.window.front') }]
    : [{ role: 'minimize', label: say('menu.window.minimize') }, { role: 'close', label: say('menu.window.close') }]
  return { role: 'windowMenu', label: say('menu.window'), submenu: items }
}

// 메뉴는 앞에 있는 팩 창에 보낸다
const toFront = (channel: string, ...args: unknown[]) => (): void => {
  const ctx = frontCtx()
  if (ctx) ctx.send(channel, ...args)
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
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
// 화면이 넘긴 값은 믿지 않는다 — 받는 쪽 매개변수 타입은 그 코드가 다루는 모양(문자열로 바꾸기 · 칸 검사는 그 자리에서 한다)
function handle<Args extends unknown[]>(channel: string, work: (ctx: PackWindow, ...args: Args) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    const ctx = ctxOf(event)
    if (!ctx) return { error: NO_WINDOW }
    return work(ctx, ...(args as Args))
  })
}
function listen<Args extends unknown[]>(channel: string, work: (ctx: PackWindow, ...args: Args) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    const ctx = ctxOf(event)
    if (ctx) work(ctx, ...(args as Args))
  })
}

handle('athena:state', (ctx) => ctx.athenaState())
handle('athena:pick', (ctx) => ctx.pickAthenaDir())
handle('athena:install', (ctx) => ctx.installAthena())
// 회사 팩 — 본체 명령을 부르고 결과만 화면에. 문자열 · 고른 값만 받는다
handle('pack:list', (ctx) => ctx.refreshPacks())
handle('pack:open', (ctx, id: unknown, options: Loose) => ctx.packOpen(String(id), { newWindow: Boolean(options && options.newWindow) }))
handle('pack:new', (ctx) => ctx.packNew())
handle('pack:cancel', (ctx) => {
  if (ctx.packAbort) ctx.packAbort.abort()
  return { ok: true }
})
handle('pack:inspect', (ctx, kind: unknown, source: unknown) => ctx.packInspect(String(kind), typeof source === 'string' ? source : null))
handle('pack:import', (ctx, token: unknown, choice: unknown) => ctx.packImport(String(token), String(choice)))
handle('pack:export', (ctx, kind: unknown) => ctx.packExport(kind === 'backup' ? 'backup' : 'share'))
handle('pack:reveal', () => packReveal())
handle('pack:icon', (ctx, id: unknown) => ctx.packIcon(String(id)))
handle('pack:set-name', (ctx, id: unknown, name: unknown) => ctx.packSetName(String(id), typeof name === 'string' ? name : null))
handle('pack:set-icon', (ctx, id: unknown, clear: unknown, usePicked: unknown) => ctx.packSetIcon(String(id), clear === true, usePicked === true))
handle('pack:pick-icon', (ctx, kind: unknown) => ctx.packPickIcon(kind === 'repo' ? 'repo' : 'pack'))
handle('repo:icon', (ctx, name: unknown) => ctx.repoIcon(String(name)))
handle('repo:set-name', (ctx, name: unknown, displayName: unknown) => ctx.repoSetName(String(name), typeof displayName === 'string' ? displayName : null))
handle('repo:set-icon', (ctx, name: unknown, clear: unknown, usePicked: unknown) => ctx.repoSetIcon(String(name), clear === true, usePicked === true))
handle('pack:context-menu', (ctx, id: unknown, point: unknown) => ctx.packContextMenu(String(id), point && typeof point === 'object' ? (point as Point) : null))
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
handle('settings:set-merge', (ctx, repo: unknown, values: Loose) => ctx.setAutoMerge(String(repo || ''), {
  autoMerge: values && typeof values.autoMerge === 'boolean' ? values.autoMerge : null,
  confirm: values && typeof values.confirm === 'boolean' ? values.confirm : null,
}))
handle('pack:call-info', (ctx, name: unknown) => ctx.callInfo(String(name || '')))
handle('pack:call-start', (ctx, name: unknown, options: Loose) => ctx.callStart(String(name || ''), { branch: String((options && options.branch) || ''), reuse: Boolean(options && options.reuse) }))
handle('pack:restore-arm', (ctx, id: unknown) => (restoreArmedFor = typeof id === 'string' && id ? id : null))
handle('pack:restore-disarm', () => (restoreArmedFor = null))
handle('pack:restore-now', (ctx) => ctx.restoreNow())
handle('pack:restore-discard', (ctx) => ctx.packRestore({ discard: true }))
// 아테나 켜기 · 새 탭은 아테나 폴더마다 하나씩 — 데몬이 새로 뜬 뒤 다시 붙기 · 빈 창 셸 탭 · 여러 창이 겹쳐도 아테나 작업 공간 · 에이전트를 둘 만들지 않는다
const screenQueue = core.keyedQueue()
const screenKey = (ctx: PackWindow) => core.realDir(ctx.athenaDir || '')
handle('agent:open', (ctx, size: Loose, options: Loose) => screenQueue(screenKey(ctx), () => ctx.openAthenaAgent(cellSize(size), { keepView: Boolean(options && options.keepView) })))
handle('tab:new', (ctx, size: Loose) => screenQueue(screenKey(ctx), () => ctx.newTab(cellSize(size))))
handle('tab:select', (ctx, tabId: unknown) => ctx.daemonCall('tab select', { tab: String(tabId) }))
handle('tab:close', (ctx, tabId: unknown) => ctx.closeTab(String(tabId)))
// 탭 이름 바꾸기 — 비우면 데몬이 이름을 지워 화면이 기본 이름(탭 N)을 쓴다
handle('tab:rename', (ctx, tabId: unknown, label: unknown) => ctx.daemonCall('tab rename', { tab: String(tabId), label: typeof label === 'string' ? label.trim().slice(0, 60) : '' }))
handle('workspace:select', (ctx, workspaceId: unknown) => ctx.daemonCall('workspace select', { workspace: String(workspaceId) }))
handle('workspace:new', (ctx, size: Loose) => ctx.newWorkspace(cellSize(size)))
handle('workspace:open-dir', (ctx, dir: unknown, size: Loose) => (typeof dir === 'string' && path.isAbsolute(dir) ? ctx.openWorkspaceDir(dir, cellSize(size)) : { error: 'bad dir' }))
handle('pack:delete', (ctx, id: unknown, options: Loose) => ctx.deletePack(String(id), { withWorktrees: Boolean(options && options.withWorktrees) }))
handle('pack:body-behind', (ctx) => ctx.bodyBehind())
handle('pack:remove-repo', (ctx, name: unknown) => (typeof name === 'string' && /^[\w.-]+$/.test(name) ? ctx.removeRepo(name) : { ok: false, error: 'usage' }))
handle('workspace:close', (ctx, workspaceId: unknown) => ctx.closeWorkspace(String(workspaceId || '')))
handle('space:context-menu', (ctx, target: Loose, point: unknown) => ctx.spaceContextMenu({ repo: target && typeof target.repo === 'string' ? target.repo : null, workspace: target && typeof target.workspace === 'string' ? target.workspace : null }, point && typeof point === 'object' ? (point as Point) : null))
handle('pack:add-repo', (ctx, dir: unknown, name: unknown) => (typeof dir === 'string' && path.isAbsolute(dir) ? ctx.addRepo(dir, typeof name === 'string' && name ? name : null) : { ok: false, error: 'usage' }))
listen('monitor:watch', (ctx, on: unknown) => ctx.setMonitorWatch(on === true))
handle('explorer:list', (ctx, workspaceId: unknown, relative: unknown) => guarded(() => ctx.explorerList(workspaceId, relative)))
handle('explorer:status', (ctx, workspaceId: unknown) => guarded(() => ctx.explorerStatus(workspaceId)))
handle('explorer:open', (ctx, workspaceId: unknown, relative: unknown) => guarded(() => ctx.explorerOpen(workspaceId, relative)))
handle('pane:split', (ctx, paneId: unknown, direction: unknown) => ctx.daemonCall('pane split', { target: String(paneId), direction: direction === 'down' ? 'down' : 'right' }))
handle('pane:close', (ctx, paneId: unknown) => ctx.closePane(String(paneId)))
handle('pane:context-menu', (ctx, point: unknown, title: unknown) => ctx.paneContextMenu(point && typeof point === 'object' ? (point as Point) : null, typeof title === 'string' ? title.slice(0, 200) : ''))
listen('pane:focus', (ctx, paneId: unknown) => ctx.notifyDaemon('focus', { pane: String(paneId) }))
listen('pane:input', (ctx, paneId: unknown, data: unknown) => {
  if (typeof data === 'string') ctx.notifyDaemon('input', { pane: String(paneId), data })
})
listen('pane:resize', (ctx, paneId: unknown, cols: number, rows: number) => {
  if (cols > 1 && rows > 1) ctx.resizePane(String(paneId), cols | 0, rows | 0)
})
listen('tab:size', (ctx, tabId: unknown, size: Loose) => {
  const cells = cellSize(size)
  if (cells.cols) ctx.notifyDaemon('tab size', { tab: String(tabId), ...cells })
})
// pane 경계를 끈 결과를 데몬 탭 트리에 — 옛 데몬은 이 동작을 몰라 usage 로 답한다(그땐 화면이 임시로 기억한다)
handle('tab:ratio', async (ctx, tabId: unknown, path: unknown, ratio: unknown) => {
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
handle('work:answer', (ctx, id: unknown, answer: Loose) => ctx.answerRequest(String(id || ''), { choice: String((answer && answer.choice) || '').slice(0, 500), text: String((answer && answer.text) || '').slice(0, 1500) }))
handle('work:redeliver', (ctx, id: unknown) => ctx.redeliverRequest(String(id || '')))
handle('work:open-plan', (ctx, id: unknown, html: unknown) => ctx.openPlan(String(id || ''), html ? String(html) : null))
handle('board:section', (ctx, section: unknown) => ctx.openBoardSection(String(section || '')))
handle('board:diagrams', (ctx) => ctx.openDiagrams())
handle('work:detail', (ctx, id: unknown) => ctx.workDetail(String(id || '')))
// pane [상세] — 계획서에 묶인 pane(머리 줄 아이콘) · 그 pane 의 상세
handle('pane:bound', (ctx) => ctx.paneBound())
handle('pane:detail', (ctx, paneId: unknown) => ctx.paneDetail(String(paneId || '')))
listen('ui:tab', (ctx, tab: unknown) => (ctx.uiTab = tab === 'board' ? 'board' : 'work'))
handle('open:url', (ctx, url: unknown) => openUrl(ctx, String(url)))
// 옆 브라우저 IPC 도 그 창 앱 화면(맨 위 프레임)에서 온 것만 — 하위 프레임 · 서랍 안 페이지는 못 부른다(ctxOf 가 가린다)
listen('browser:place', (ctx, rect: unknown) => ctx.placeBrowser(browserRect(rect)))
listen('browser:hide', (ctx) => ctx.hideBrowser())
handle('browser:command', (ctx, name: unknown, value: unknown) => ctx.browserCommand(String(name), typeof value === 'string' ? value : ''))

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
// 배포판 업데이트(Squirrel.Mac quitAndInstall — src/lib/release-update.mts)는 창을 먼저 다 닫고 끈다 —
// 맥 마지막 창 닫기를 숨기기로 바꾸는 가로채기(pack-window.mts 'close')에 막혀 교체가 멈추지 않게 그 전에 끄는 중으로
autoUpdater.on('before-quit-for-update', () => {
  quitting = true
  for (const ctx of packWindows) ctx.detachScreen()
})

// 화면이 준 서랍 자리 — 숫자(문자열 아님)이고 화면 크기쯤(0~100000)이 아니면 버린다
function browserRect(rect: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!rect || typeof rect !== 'object') return null
  const values = ['x', 'y', 'width', 'height'].map((key) => (rect as Record<string, unknown>)[key])
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)) return null
  const [x, y, width, height] = values as [number, number, number, number]
  return { x, y, width, height }
}

// 화면이 준 크기(칸) — 숫자가 아니면 버린다(데몬 기본 크기를 쓴다)
function cellSize(size: Loose): { cols?: number; rows?: number } {
  // 옛 main.js 와 같은 식 — size 가 없으면 cols · rows 는 그 값(null · undefined)이고 아래 비교가 거짓
  const cols = (size && (size.cols as number) | 0) as number
  const rows = (size && (size.rows as number) | 0) as number
  return cols > 1 && rows > 1 ? { cols, rows } : {}
}
