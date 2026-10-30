// ── 창 — 팩 창 하나의 BrowserWindow ─────────────────────────────
// main.js createPackWindow 에서 옮겼다(PR3g) — 열린 팩 창(packWindows · openPackIds) · 창 목록 저장(saveWindows) · 링크 열기(openUrl) · 메뉴 막대(hasTray · pollTray) ·
// 에이전트 모니터(monitor — main.mts 의 창 변수 그대로) · 앱 아이콘 · 바탕색은 인자로 받는다.
// main.mts 의 값 — 끄는 중(quitting) · 마지막으로 앞에 있던 창(lastFocused)은 읽기 · 쓰기 함수로 받는다.
// ctx 에 같은 이름(show · close · win)으로 붙인다
import path from 'node:path'
import { BrowserWindow } from 'electron'
import type { Monitor } from './monitor-logs.mts'

const isMac = process.platform === 'darwin'

// 팩 창 문맥(main.mts createPackWindow) 중 창이 읽는 것 · 붙이는 것
export type PackWindowCtx = {
  win: BrowserWindow | null
  packState: Record<string, unknown>
  send(channel: string, ...values: unknown[]): void
  stopRequests(): void
  dropBrowser(): void
  detachScreen(): void
  refreshPacks?: () => Promise<unknown>
  show?: (tab?: string) => void
  close?: () => void
}

type PackWindowDeps = {
  packWindows: Set<PackWindowCtx>
  openPackIds: () => string[]
  saveWindows: () => void
  openUrl: (ctx: PackWindowCtx, url: string) => unknown
  hasTray: () => boolean
  pollTray: () => unknown
  monitor: Monitor
  appIcon: string
  appBackground: string
  quitting: () => boolean
  lastFocused: () => PackWindowCtx | null
  setLastFocused: (ctx: PackWindowCtx | null) => void
}

export function installPackWindow(ctx: PackWindowCtx, deps: PackWindowDeps): void {
  const { packWindows, openPackIds, saveWindows, openUrl, hasTray, pollTray, monitor, appIcon, appBackground, quitting, lastFocused, setLastFocused } = deps
  const send = ctx.send

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

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: 'Athena',
    titleBarStyle: isMac ? 'hiddenInset' : 'default', // 맥은 탭 줄이 제목 줄을 겸한다
    backgroundColor: appBackground,
    icon: appIcon, // 맥은 무시한다(Dock 은 whenReady 에서) — 윈도우·리눅스 창 아이콘
    webPreferences: {
      preload: path.join(import.meta.dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  ctx.win = win
  // 화면은 Vite 빌드 결과(dist/renderer — scripts/dev-app.js start 가 켤 때 만든다 · vite.config.mts)
  win.loadFile(path.join(import.meta.dirname, '..', '..', 'dist', 'renderer', 'index.html'))
  // 맨 위 페이지는 앱 화면에서 벗어나지 않는다 — 이동하려는 주소는 openUrl 이 옆 브라우저 · 기본 브라우저로 돌린다
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openUrl(ctx, url)
  })
  win.on('focus', () => {
    setLastFocused(ctx)
    if (hasTray()) pollTray() // 메뉴 막대는 앞 창의 팩만 — 창을 바꾸면 바로 다시 읽는다
    // 팩 목록도 다시 읽는다 — pane 안 /setup 이 임시 id(new-…)를 회사 이름으로 바꾸는 것은 앱을 거치지 않아 알 길이 이것뿐이다
    if (ctx.refreshPacks) ctx.refreshPacks().catch(() => {})
  })
  // 맥은 마지막 창을 닫아도 메뉴 막대에 남는다(숨기기) — 완전히 끄는 것은 [Athena 종료] · ⌘Q. 창이 여럿이면 그 창만 닫는다
  win.on('close', (event) => {
    if (!isMac || quitting() || packWindows.size > 1) return
    event.preventDefault()
    ;(ctx.win as BrowserWindow).hide()
  })
  win.on('closed', () => {
    ctx.win = null
    clearInterval(monitor.timer as NodeJS.Timeout)
    ctx.stopRequests()
    // 서랍에서 떼어 둔 뷰는 창과 함께 정리되지 않는다 — 직접 닫는다
    ctx.dropBrowser()
    ctx.detachScreen()
    packWindows.delete(ctx)
    if (lastFocused() === ctx) setLastFocused(null)
    saveWindows()
    for (const each of packWindows) each.send('pack:state', { ...each.packState, openIds: openPackIds() })
  })
}
