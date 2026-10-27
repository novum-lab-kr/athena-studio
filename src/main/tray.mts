// ── 메뉴 막대(Tray) — 앞에 있는 창의 팩만 ───────────────────
// main.js 에서 옮겼다(PR3d) — 화면 문구(say) · 앞 창 찾기(frontCtx) · 열린 팩 창(packWindows) · 지난 창 다시 열기(openSavedWindows)는 setupTray 인자로 받는다
// 맥 상단 메뉴 막대 아이콘 — 누르면 확인 필요 · 에이전트 · 사용량 · 바로가기. 막힘 · 응답 끝 · 리뷰 대기 · 완료는 맥 알림.
// 창이 숨어 있어도 4초마다 pane 목록, 15초마다 일감 상태(/api/state — 일감을 띄우지는 않는다)를 본다.
// 알림 문구에는 이름 · 작업 공간 · 계획서 제목만(명령 · 지시 내용은 넣지 않는다)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, nativeTheme } from 'electron'
import type { IpcMainEvent, MenuItemConstructorOptions, NativeImage } from 'electron'
import * as core from '../lib/core.mts'
import * as trayModel from '../lib/tray-model.mts'
import * as trayBadge from '../lib/tray-icon.mts'
import { fetchBoardJson } from './board.mts'
import type { Say, TrayPane, Notice } from '../lib/tray-model.mts'

// screen-model 은 JS — main 과 같은 require 캐시의 것을 쓴다. electron.screen 은 앱이 준비된 뒤에만 읽을 수 있어 쓸 때 꺼낸다(옛 main.js 와 같다)
const require = createRequire(import.meta.url)
const screenModel: typeof import('../lib/screen-model.js') = require('../lib/screen-model.js')
const electronScreen = (): typeof import('electron').screen => require('electron').screen

// 데몬 답에서 읽는 칸만(모양은 검사하지 않는다 — 옛 main.js 와 같다)
type Workspace = { id: string; label: string }
type PeekReply = { result?: { panes: TrayPane[]; workspaces: Workspace[]; focused: string | null; text?: unknown } }
type RequestsState = { supported: boolean; requests: unknown[] }
// 일감 /api/state · /api/metrics 에서 읽는 칸만
type BoardState = { cards?: unknown[]; header?: { usage?: unknown[] } }
type BoardMetrics = { current?: { waitMs?: unknown } }
// 알림 대상 — 묶인 알림(trayModel.bundle)의 target 에 계획서 결정 콘솔(html)이 올 수도 있다
type TrayNotice = Notice & { target: Notice['target'] & { html?: string | null } }

// 팩 창 문맥(main.js createPackWindow) 중 메뉴 막대가 쓰는 것만
export type TrayCtx = {
  win: BrowserWindow | null
  athenaDir: string | null
  uiTab: string
  isAttached(): boolean
  peekCall(op: string, args?: Record<string, unknown>): Promise<PeekReply>
  daemonCall(op: string, args?: Record<string, unknown>): Promise<unknown>
  requestsNow(): RequestsState
  boardPortNow(): number
  screenDetached(): boolean
  send(channel: string, ...values: unknown[]): void
  show(tab?: string): void
  openInBrowser(url: string): void
}

type TrayDeps = { say: Say; frontCtx: () => TrayCtx | null; packWindows: Set<TrayCtx>; openSavedWindows: () => void }

const TRAY_ICON_DIR = path.join(import.meta.dirname, '..', 'renderer', 'assets', 'logo')
const TRAY_WIDTH = 340

export function setupTray({ say, frontCtx, packWindows, openSavedWindows }: TrayDeps) {
  const trayState = {
    ctx: null as TrayCtx | null,
    dir: null as string | null,
    panes: [] as TrayPane[],
    workspaces: [] as Workspace[],
    focused: null as string | null,
    boardOkAt: 0,
    cards: null as unknown[] | null,
    usage: [] as unknown[],
    waitMs: null as number | null,
    metricsAt: 0,
    boardUp: false,
    boardAt: 0,
    pausedUntil: 0,
    polling: false,
  }
  let trayNotifier = new trayModel.Notifier()
  let tray: Tray | null = null
  let trayWindow: BrowserWindow | null = null
  const trayHistory: { at: number; working: number }[] = [] // 최근 30분 일하는 에이전트 수(4초마다) — 패널 그래프

  function trayIcon(): NativeImage {
    // 흰 로고를 템플릿으로 — 맥이 밝은 · 어두운 메뉴 막대에 맞춰 칠한다
    const image = nativeImage.createFromPath(path.join(TRAY_ICON_DIR, 'athena-white-16.png'))
    const retina = path.join(TRAY_ICON_DIR, 'athena-white-32.png')
    if (fs.existsSync(retina)) image.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(retina) })
    image.setTemplateImage(true)
    return image
  }

  // 막힘이 있으면 빨간 점 — 템플릿은 색을 못 써서, 메뉴 막대 색(어두우면 흰색 · 밝으면 검정)으로 칠한 로고에 점을 그린다
  let badgeCache: { dark: boolean | null; image: NativeImage | null } = { dark: null, image: null }
  function blockedIcon(): NativeImage {
    const dark = nativeTheme.shouldUseDarkColors
    if (badgeCache.image && badgeCache.dark === dark) return badgeCache.image
    const tint: trayBadge.Rgb = dark ? [255, 255, 255] : [0, 0, 0]
    const image = nativeImage.createEmpty()
    for (const [file, scaleFactor] of [['athena-white-16.png', 1], ['athena-white-32.png', 2]] as const) {
      const source = nativeImage.createFromPath(path.join(TRAY_ICON_DIR, file))
      if (source.isEmpty()) continue
      const { width, height } = source.getSize()
      image.addRepresentation({ scaleFactor, width, height, buffer: trayBadge.badgeBitmap(source.toBitmap(), width, height, tint) })
    }
    badgeCache = { dark, image }
    return image
  }

  let trayBlocked: boolean | null = null
  function setTrayIcon(blocked: boolean) {
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
    const created = new Tray(trayIcon())
    tray = created
    created.setToolTip('Athena')
    // 누르면 아이콘 아래로 패널(RunCat 처럼). 오른쪽 클릭은 짧은 메뉴
    created.on('click', toggleTrayWindow)
    created.on('right-click', () => created.popUpContextMenu(Menu.buildFromTemplate(trayShortMenu())))
    // 패널은 미리 만들어 둔다(처음 열 때 빈 화면이 잠깐 보이지 않게)
    createTrayWindow()
    pollTray()
    setInterval(pollTray, 4000)
  }

  function createTrayWindow(): BrowserWindow {
    const created = new BrowserWindow({
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
      webPreferences: { preload: path.join(import.meta.dirname, '..', 'preload-tray.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    trayWindow = created
    created.loadFile(path.join(import.meta.dirname, '..', 'renderer', 'tray.html'))
    // 로드가 끝나야 받는 쪽이 생긴다 — 그때 한 번 보낸다(다시 만든 직후 비어 보이지 않게)
    created.webContents.on('did-finish-load', sendTrayUpdate)
    // 다른 곳을 누르면 닫힌다(메뉴처럼)
    created.on('blur', () => trayWindow && !trayWindow.webContents.isDevToolsOpened() && trayWindow.hide())
    created.on('closed', () => (trayWindow = null))
    // 패널 안 링크 · 이동은 막는다
    created.webContents.on('will-navigate', (event) => event.preventDefault())
    return created
  }

  function toggleTrayWindow() {
    const panel = trayWindow || createTrayWindow()
    if (panel.isVisible()) return panel.hide()
    placeTrayWindow()
    sendTrayUpdate()
    panel.show()
    panel.focus()
    return undefined
  }

  // 아이콘 바로 아래 가운데 — 화면 밖으로 나가지 않게
  function placeTrayWindow() {
    const panel = trayWindow as BrowserWindow
    const icon = (tray as Tray).getBounds()
    const displays = electronScreen()
    const area = displays.getDisplayNearestPoint({ x: icon.x, y: icon.y }).workArea
    const [width = 0, height = 0] = panel.getSize()
    const x = Math.round(Math.min(Math.max(icon.x + icon.width / 2 - width / 2, area.x + 6), area.x + area.width - width - 6))
    const y = Math.round(icon.y + icon.height + 4)
    panel.setPosition(x, Math.max(y, area.y + 4))
    panel.setSize(width, Math.min(height, area.height - 12))
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
  const fromTrayPanel = (event: IpcMainEvent) => Boolean(trayWindow) && event.sender === trayWindow?.webContents && event.senderFrame === event.sender.mainFrame
  ipcMain.on('tray:height', (event, height: unknown) => {
    if (!fromTrayPanel(event) || typeof height !== 'number' || !Number.isFinite(height)) return
    const panel = trayWindow as BrowserWindow
    const area = electronScreen().getDisplayNearestPoint(panel.getBounds()).workArea
    panel.setSize(TRAY_WIDTH, Math.round(Math.min(Math.max(height, 120), area.height - 12)))
  })
  ipcMain.on('tray:action', (event, name: unknown, value: unknown) => {
    if (!fromTrayPanel(event)) return
    if (name === 'focus-pane' && typeof value === 'string') focusPaneFromTray(value)
    if (name === 'open-card') openCardFromTray(typeof value === 'string' ? value : null)
    if (name === 'open-request' && typeof value === 'string') openRequestFromTray(value)
    if (name === 'open-work') openRequestFromTray(null)
    if (name === 'show') showWindow(value === 'work' || value === 'board' ? value : undefined)
    if (name === 'menu') (tray as Tray).popUpContextMenu(Menu.buildFromTemplate(trayShortMenu()))
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
      if (listed.result && state.result) {
        trayState.panes = await markWaiting(ctx, listed.result.panes, trayState.panes)
        if (ctx !== trayState.ctx) return
        trayState.workspaces = state.result.workspaces
        trayState.focused = state.result.focused
        trayHistory.push({ at: Date.now(), working: trayState.panes.filter((pane) => pane.agent && pane.agent_status === 'working').length })
        while (trayHistory.length && Date.now() - (trayHistory[0]?.at ?? 0) > 30 * 60000) trayHistory.shift()
      }
      if (Date.now() - trayState.boardAt > 15000) {
        trayState.boardAt = Date.now()
        const board = (await fetchBoardState(ctx.boardPortNow())) as BoardState | null
        trayState.boardUp = Boolean(board)
        if (board) {
          trayState.boardOkAt = Date.now()
          trayState.cards = board.cards || []
          trayState.usage = (board.header && board.header.usage) || []
          // 평균 답 대기(지난 7일 · 일감 지표) — 자주 바뀌지 않아 5분마다만. 옛 코어(지표 없음)면 404 → 없음
          if (Date.now() - trayState.metricsAt > 5 * 60000) {
            trayState.metricsAt = Date.now()
            const metrics = (await fetchBoardJson(ctx.boardPortNow(), '/api/metrics?days=7')) as BoardMetrics | null
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
  async function markWaiting(ctx: TrayCtx, panes: TrayPane[], before: TrayPane[] = []): Promise<TrayPane[]> {
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

  // 일감이 떠 있으면 그 상태를 읽는다 — 어떤 실패든 한 번 null(0건으로 치지 않는다)
  function fetchBoardState(port: number): Promise<unknown> {
    return fetchBoardJson(port, '/api/state')
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
  function trayShortMenu(): MenuItemConstructorOptions[] {
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

  function setTrayPause(until: number) {
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
  function showWindow(tab?: string) {
    let ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : frontCtx()
    if (!ctx) {
      openSavedWindows()
      ctx = frontCtx()
    }
    if (ctx) ctx.show(tab)
  }

  async function focusPaneFromTray(paneId: string) {
    const ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : frontCtx()
    if (!ctx) return
    ctx.show('work')
    // 데몬과 화면 연결이 끊겨 있었으면 다시 붙인다
    if (ctx.screenDetached()) ctx.send('screen:resync')
    await ctx.daemonCall('focus', { pane: String(paneId) })
  }

  // 계획서 결정 콘솔이 있으면 옆 브라우저로, 없으면 일감 탭
  function openCardFromTray(html: string | null | undefined) {
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
  function openRequestFromTray(id: string | null) {
    const ctx = trayState.ctx && packWindows.has(trayState.ctx) ? trayState.ctx : frontCtx()
    if (!ctx) return
    ctx.show('work')
    ctx.send('work:open', id)
  }

  // 앞 창(메뉴 막대가 보는 창)의 요청이 바뀌면 — 새로 열린 것만 맥 알림 한 번(창이 여럿이어도 메뉴 막대가 보는 창 것만) · 메뉴 막대 다시 그리기
  function trayRequestsChanged(ctx: TrayCtx) {
    if (!tray || ctx !== trayState.ctx) return
    const now = ctx.requestsNow()
    for (const item of trayModel.bundle(trayNotifier.updateRequests(now.supported ? now.requests : null, say), say)) notify(item)
    refreshTray()
    if (trayWindow && trayWindow.isVisible()) sendTrayUpdate()
  }

  // 지금 보고 있는 pane 이면(그 창이 앞에 있고 작업 창 탭 · 그 pane 포커스) 알리지 않는다
  function lookingAt(item: Notice) {
    const ctx = trayState.ctx
    if (!item.target.pane || !ctx || !ctx.win) return false
    return ctx.win.isVisible() && ctx.win.isFocused() && ctx.uiTab === 'work' && trayState.focused === item.target.pane
  }

  function notify(item: TrayNotice) {
    if (trayState.pausedUntil > Date.now() || !Notification.isSupported()) return
    const notification = new Notification({ title: item.title, body: item.body, silent: true })
    notification.on('click', () => {
      if (item.target.request) openRequestFromTray(item.target.request)
      else if (item.target.pane) focusPaneFromTray(item.target.pane)
      else openCardFromTray(item.target.html)
    })
    notification.show()
  }

  // main.js 가 부르는 것 — tray · trayWindow 는 바뀌는 값이라 함수로 읽는다
  return {
    createTray,
    refreshTray,
    sendTrayUpdate,
    pollTray,
    trayRequestsChanged,
    showWindow,
    hasTray: () => Boolean(tray),
    trayPanel: () => trayWindow,
  }
}
