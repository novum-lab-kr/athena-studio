// ── 옆 브라우저 — 팩 창마다 서랍 하나 ─────────────────────────
// main.js createPackWindow 에서 옮겼다(PR3g) — 화면 문구(say) · 본체별 마지막 주소(browserUrls — 창끼리 같이 쓰는 Map) · 세션 이름(browserPartition) ·
// 결정 콘솔 감시(watchConsoleSends) · 빈 페이지 바탕색(appBackground)은 인자로 받고,
// ctx 에 같은 이름(rememberBrowser · isBrowserContents · openInBrowser · placeBrowser · hideBrowser · browserCommand)으로 붙인다.
// 뷰(browserView)와 붙어 있는지(browserAttached)는 이 창 것이라 이 안에 둔다 — 창이 닫힐 때 정리는 dropBrowser
import { session, shell, WebContentsView } from 'electron'
import type { BrowserWindow, Session, WebContents } from 'electron'
import * as core from '../lib/core.mts'
import type { Say } from '../lib/pack.mts'

// 화면이 알려 주는 서랍 자리(CSS 픽셀 — main.mts browserRect 가 숫자로 걸렀다)
type Rect = { x: number; y: number; width: number; height: number }

// 팩 창 문맥(main.mts createPackWindow) 중 옆 브라우저가 읽는 것 · 붙이는 것
export type SideBrowserCtx = {
  athenaDir: string | null
  win: BrowserWindow | null
  send(channel: string, ...values: unknown[]): void
  rememberBrowser?: () => void
  dropBrowser?: () => void
  isBrowserContents?: (contents: WebContents) => boolean
  openInBrowser?: (url: string) => void
  placeBrowser?: (rect: Rect | null) => void
  hideBrowser?: () => void
  browserCommand?: (name: string, value: string) => { url?: string; error?: string }
}

type SideBrowserDeps = {
  say: Say
  browserUrls: Map<string, string>
  browserPartition: string
  watchConsoleSends: (browserSession: Session) => void
  appBackground: string
}

export function installSideBrowser(ctx: SideBrowserCtx, { say, browserUrls, browserPartition, watchConsoleSends, appBackground }: SideBrowserDeps): void {
  const send = ctx.send
  let browserView: WebContentsView | null = null
  let browserAttached = false

  // 옆 브라우저 — 지금 본체에서 보던 주소를 기억하고 뷰를 닫는다(새 본체에서 서랍을 열면 그 본체 주소로 · ensureBrowserView)
  function rememberBrowser(): void {
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
  ctx.rememberBrowser = rememberBrowser

  // 창이 닫혔다 — 서랍에서 떼어 둔 뷰는 창과 함께 정리되지 않는다 — 직접 닫는다
  ctx.dropBrowser = () => {
    if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close()
    browserView = null
    browserAttached = false
  }

  // 작업 창 · 일감 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그리고(아무 사이트 · 로그인 쿠키 유지 — 창끼리 같은 저장소),
  // 화면은 서랍 안 자리(#browser-slot)의 사각형만 알려 준다. 페이지에는 preload · Node 를 넘기지 않는다
  function ensureBrowserView(): WebContentsView {
    if (browserView && !browserView.webContents.isDestroyed()) return browserView
    const browserSession = session.fromPartition(browserPartition)
    // 카메라 · 마이크 · 알림 · 위치 같은 권한은 묻지 않고 거절한다
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserView = new WebContentsView({
      webPreferences: { partition: browserPartition, contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    // 빈 페이지일 땐 앱 배경색(흰 판이 튀지 않게). 웹 페이지로 가면 흰색 — 배경을 안 정한 사이트가 어두운 바탕에 검은 글씨가 되지 않게
    const view = browserView
    const fitBackground = (url: string) => view.setBackgroundColor(core.isWebUrl(url) ? '#ffffff' : appBackground)
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
    for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      contents.on(name as 'did-stop-loading', sendBrowserState)
    }
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 은 이동이 취소된 것(새 주소로 바로 넘어감) — 알리지 않는다
      if (isMainFrame && code !== -3) send('browser:error', `${description} (${code}) — ${url}`)
    })
    return browserView
  }
  ctx.isBrowserContents = (contents) => Boolean(browserView) && !browserView!.webContents.isDestroyed() && contents === browserView!.webContents

  function sendBrowserState(): void {
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
    const [contentWidth = 0, contentHeight = 0] = ctx.win.getContentSize()
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
}
