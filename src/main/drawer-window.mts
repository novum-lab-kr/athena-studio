// ── 떼어 낸 서랍 창 — 옆 브라우저 서랍의 [웹] · [시뮬레이터] 두 탭을 새 창 하나로(팩 창마다 하나) ─────────────
// 서랍 막대의 [새 창으로] ⧉(어느 탭에서든)를 누르면 이 창을 띄우고, 웹 탭 뷰(side-browser.mts)와 iOS 페이지 뷰(simulator.mts)가 모두 이 창에 붙는다.
// 창 화면(browser-window.html)은 서랍과 같은 [웹 | 시뮬레이터] 탭으로 바꾸고, 바꿀 때마다 보던 탭을 알려 준다(drawer:mode).
// 창을 닫으면(또는 [되돌리기] ◨) 뷰들이 서랍으로 돌아오고 서랍은 그때 보던 탭으로 열린다(drawer:detached false).
// 창을 만들고 닫는 것만 여기서 하고, 뷰를 옮겨 붙이는 것은 각 모듈이 onDrawerMove 로 받아 한다
import path from 'node:path'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'

export type DrawerMode = 'web' | 'sim'
// win — 옮겨 가는 창(떼어 낼 때는 새 창 · 돌아올 때는 닫히는 창). 떼어 낼 때는 아직 팩 창이 host, 돌아올 때는 이미 팩 창이 host 다
export type DrawerMove = (win: BrowserWindow, detached: boolean) => void

export type DrawerWindowCtx = {
  win: BrowserWindow | null
  send(channel: string, ...values: unknown[]): void
  drawerWin?: () => BrowserWindow | null
  isDrawerWindow?: (contents: WebContents) => boolean
  detachDrawer?: (mode: DrawerMode) => void
  // reopen — 돌아올 때 서랍을 다시 열지(팩 바꾸기 · 탭을 다 닫았을 때는 열지 않는다)
  closeDrawer?: (reopen: boolean) => void
  focusDrawer?: () => void
  setDrawerMode?: (mode: DrawerMode) => void
  onDrawerMove?: (listener: DrawerMove) => void
  // 웹 탭이 남았는지(side-browser.mts) — 웹 탭을 보다 돌아올 때 빈 서랍을 열지 않게
  hasBrowserTabs?: () => boolean
}

export function installDrawerWindow(ctx: DrawerWindowCtx, { appBackground }: { appBackground: string }): void {
  let detachedWin: BrowserWindow | null = null
  let mode: DrawerMode = 'web'
  let reopenOnClose = true
  const listeners: DrawerMove[] = []

  const alive = () => (detachedWin && !detachedWin.isDestroyed() ? detachedWin : null)
  ctx.drawerWin = alive
  ctx.isDrawerWindow = (contents) => alive()?.webContents === contents
  ctx.onDrawerMove = (listener) => void listeners.push(listener)
  ctx.setDrawerMode = (next) => (mode = next)

  // 창이 닫힌다 — host 를 팩 창으로 돌린 뒤 각 모듈이 이 창에서 뷰를 뗀다(창과 함께 정리되지 않게). 그다음 서랍에 보던 탭으로 열라고 알린다
  function backToDrawer(win: BrowserWindow): void {
    detachedWin = null
    for (const listener of listeners) listener(win, false)
    if (!ctx.win || ctx.win.isDestroyed()) return
    const reopen = reopenOnClose && (mode === 'sim' || Boolean(ctx.hasBrowserTabs?.()))
    ctx.send('drawer:detached', false, mode, reopen)
    if (reopen) ctx.win.show()
  }

  // [새 창으로] — 각 모듈이 팩 창에 붙은 뷰를 먼저 떼고, 새 창 화면이 자리를 알리면(browser:place · sim:place) 거기 붙는다
  ctx.detachDrawer = (from) => {
    const open = alive()
    if (open) return void open.focus()
    if (!ctx.win || ctx.win.isDestroyed()) return
    mode = from
    reopenOnClose = true
    // 크기는 떼어 낸 탭에 맞춘다(웹은 넓게 · 시뮬레이터는 기기 모양으로 좁고 길게)
    const size = from === 'sim' ? { width: 480, height: 860 } : { width: 1100, height: 800 }
    const win = new BrowserWindow({
      ...size,
      minWidth: 320,
      minHeight: 320,
      title: 'Athena',
      backgroundColor: appBackground,
      webPreferences: {
        preload: path.join(import.meta.dirname, '..', 'preload-browser.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    for (const listener of listeners) listener(win, true)
    detachedWin = win
    // 서랍은 닫는다(두 탭 모두 새 창으로 옮겨 감 · 두 곳에 동시에 있지 않음)
    ctx.send('drawer:detached', true, mode, false)
    // 처음 볼 탭은 주소 query 로 — 화면이 켜지자마자 그 탭으로 그린다
    win.loadFile(path.join(import.meta.dirname, '..', '..', 'dist', 'renderer', 'browser-window.html'), { query: { mode } })
    // 맨 위 페이지(막대 화면)는 벗어나지 않는다
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.on('close', () => {
      if (detachedWin === win) backToDrawer(win)
    })
  }

  ctx.closeDrawer = (reopen) => {
    const win = alive()
    if (!win) return
    reopenOnClose = reopen
    win.close()
  }

  // 떼어 낸 동안 웹 버튼(⌘⇧B) · 서랍의 [시뮬레이터] — 그 창을 앞으로
  ctx.focusDrawer = () => {
    const win = alive()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}
