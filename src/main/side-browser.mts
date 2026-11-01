// ── 옆 브라우저 — 팩 창마다 서랍 하나 ─────────────────────────
// main.js createPackWindow 에서 옮겼다(PR3g) — 화면 문구(say) · 본체별 열어 둔 탭 주소(browserUrls — 창끼리 같이 쓰는 Map) · 세션 이름(browserPartition) ·
// 결정 콘솔 감시(watchConsoleSends) · 빈 페이지 바탕색(appBackground)은 인자로 받고,
// ctx 에 같은 이름(rememberBrowser · isBrowserContents · openInBrowser · closeSentConsole · placeBrowser · hideBrowser · browserCommand)으로 붙인다.
// 탭 뷰들(tabs)과 붙어 있는지(browserAttached)는 이 창 것이라 이 안에 둔다 — 창이 닫힐 때 정리는 dropBrowser
import { session, shell, WebContentsView } from 'electron'
import type { BrowserWindow, Session, WebContents } from 'electron'
import * as core from '../lib/core.mts'
import { afterClose, planOpen } from '../lib/browser-tabs.mts'
import type { Say } from '../lib/pack.mts'

// 화면이 알려 주는 서랍 자리(CSS 픽셀 — main.mts browserRect 가 숫자로 걸렀다)
type Rect = { x: number; y: number; width: number; height: number }

// 탭 하나 — requestedUrl 은 첫 페이지가 확정되기 전 주소(그동안 getURL 이 비어 있다)
type Tab = { id: number; view: WebContentsView; requestedUrl: string }

// 팩 창 문맥(main.mts createPackWindow) 중 옆 브라우저가 읽는 것 · 붙이는 것
export type SideBrowserCtx = {
  athenaDir: string | null
  win: BrowserWindow | null
  send(channel: string, ...values: unknown[]): void
  rememberBrowser?: () => void
  dropBrowser?: () => void
  isBrowserContents?: (contents: WebContents) => boolean
  openInBrowser?: (url: string, options?: { background?: boolean }) => void
  closeSentConsole?: (contents: WebContents) => void
  placeBrowser?: (rect: Rect | null) => void
  hideBrowser?: () => void
  boardPortNow?: () => number
  browserCommand?: (name: string, value: string) => { url?: string; error?: string }
}

type SideBrowserDeps = {
  say: Say
  browserUrls: Map<string, { urls: string[]; active: number }>
  browserPartition: string
  watchConsoleSends: (browserSession: Session) => void
  appBackground: string
}

export function installSideBrowser(ctx: SideBrowserCtx, { say, browserUrls, browserPartition, watchConsoleSends, appBackground }: SideBrowserDeps): void {
  const send = ctx.send
  // 탭마다 뷰 하나 · 화면에는 보는 탭(activeId) 뷰만 붙인다. 뒤 탭 페이지는 떼어 둔 채 살아 있어 고르던 것이 남는다
  let tabs: Tab[] = []
  let activeId: number | null = null
  let nextTabId = 1
  let browserAttached = false
  let lastBounds: Rect | null = null

  const activeTab = () => tabs.find((tab) => tab.id === activeId) || null
  const tabUrl = (tab: Tab) => tab.view.webContents.getURL() || tab.requestedUrl
  const tabList = () => tabs.map((tab) => ({ id: tab.id, url: tabUrl(tab) }))

  function closeView(tab: Tab): void {
    if (tab.view.webContents.isDestroyed()) return
    if (browserAttached && tab.id === activeId && ctx.win) ctx.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }

  function closeAll(): void {
    for (const tab of tabs) closeView(tab)
    tabs = []
    activeId = null
    browserAttached = false
  }

  // 옆 브라우저 — 지금 본체에서 열어 둔 탭 주소를 기억하고 뷰를 닫는다(돌아오면 그 탭들로 · restoreTabs)
  function rememberBrowser(): void {
    const urls = tabs.map(tabUrl)
    const webUrls = urls.filter((url) => core.isWebUrl(url))
    const activeUrl = activeTab() ? tabUrl(activeTab()!) : ''
    if (ctx.athenaDir && webUrls.length) browserUrls.set(core.realDir(ctx.athenaDir), { urls: webUrls, active: Math.max(0, webUrls.indexOf(activeUrl)) })
    closeAll()
    send('browser:reset')
    sendTabs()
  }
  ctx.rememberBrowser = rememberBrowser

  // 창이 닫혔다 — 서랍에서 떼어 둔 뷰는 창과 함께 정리되지 않는다 — 직접 닫는다
  ctx.dropBrowser = closeAll

  // 작업 창 · 현황판 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그리고(아무 사이트 · 로그인 쿠키 유지 — 창끼리 같은 저장소),
  // 화면은 서랍 안 자리(#browser-slot)의 사각형만 알려 준다. 페이지에는 preload · Node 를 넘기지 않는다
  function createTab(): Tab {
    const browserSession = session.fromPartition(browserPartition)
    // 카메라 · 마이크 · 알림 · 위치 같은 권한은 묻지 않고 거절한다
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    const view = new WebContentsView({
      webPreferences: { partition: browserPartition, contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    const tab: Tab = { id: nextTabId++, view, requestedUrl: '' }
    tabs.push(tab)
    // 뒤 탭도 서랍 크기로 그려 둔다 — 앞으로 꺼낼 때 다시 맞추지 않게
    if (lastBounds) view.setBounds(lastBounds)
    // 빈 페이지 · 이 창 현황판 서버 페이지는 앱 배경색(흰 판이 튀지 않게). 그 밖(바깥 사이트 · 사용자 localhost 앱)은 흰색 — core.browserBackground
    const fitBackground = (url: string) => view.setBackgroundColor(core.browserBackground(url, appBackground, ctx.boardPortNow?.() ?? 0))
    fitBackground('')
    watchConsoleSends(browserSession)
    const contents = view.webContents
    contents.on('did-navigate', (_event, url) => fitBackground(url))
    // 불러오기 시작 때 미리 칠한다 — 이동이 확정(did-navigate)되기 전 첫 그림이 흰색으로 나오지 않게
    contents.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) fitBackground(url)
    })
    // http(s) 밖으로는 움직이지 않는다 — 안쪽 프레임까지
    contents.on('will-frame-navigate', (event) => {
      if (!core.isWebUrl(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!core.isWebUrl(url)) event.preventDefault()
    })
    const announce = () => {
      if (tab.id === activeId) sendBrowserState()
      sendTabs()
    }
    for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      contents.on(name as 'did-stop-loading', announce)
    }
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 은 이동이 취소된 것(새 주소로 바로 넘어감) — 알리지 않는다
      if (isMainFrame && code !== -3 && tab.id === activeId) send('browser:error', `${description} (${code}) — ${url}`)
    })
    return tab
  }

  function loadInTab(tab: Tab, url: string): void {
    tab.requestedUrl = url
    tab.view.webContents.loadURL(url)
  }

  // 이 팩에서 열어 두었던 탭이 있으면 그걸로(팩을 바꿨다 돌아오면) — 한 번 쓰면 지운다(그 뒤 탭을 다 닫았을 때 되살아나지 않게)
  function restoreTabs(): void {
    if (tabs.length || !ctx.athenaDir) return
    const dir = core.realDir(ctx.athenaDir)
    const remembered = browserUrls.get(dir)
    if (!remembered) return
    browserUrls.delete(dir)
    for (const url of remembered.urls) loadInTab(createTab(), url)
    activeId = tabs[remembered.active]?.id ?? tabs[0]?.id ?? null
  }

  function ensureActiveTab(): Tab {
    restoreTabs()
    const current = activeTab()
    if (current) return current
    const tab = tabs[0] || createTab()
    activeId = tab.id
    return tab
  }

  ctx.isBrowserContents = (contents) => tabs.some((tab) => tab.view.webContents === contents)

  function sendBrowserState(): void {
    const tab = activeTab()
    if (!tab || tab.view.webContents.isDestroyed()) {
      send('browser:state', {})
      return
    }
    const contents = tab.view.webContents
    const history = contents.navigationHistory
    send('browser:state', {
      url: tabUrl(tab),
      title: contents.getTitle(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      loading: contents.isLoading(),
    })
  }

  function sendTabs(): void {
    send('browser:tabs', tabs.filter((tab) => !tab.view.webContents.isDestroyed()).map((tab) => ({ id: tab.id, url: tabUrl(tab), title: tab.view.webContents.getTitle(), active: tab.id === activeId })))
  }

  // 보는 탭 바꾸기 — 서랍에 붙어 있으면 뷰도 바꿔 끼운다
  function activate(id: number | null): void {
    const before = activeTab()
    activeId = id
    const after = activeTab()
    if (before !== after && browserAttached && ctx.win) {
      if (before && !before.view.webContents.isDestroyed()) ctx.win.contentView.removeChildView(before.view)
      if (after) {
        if (lastBounds) after.view.setBounds(lastBounds)
        ctx.win.contentView.addChildView(after.view)
      } else {
        browserAttached = false
      }
    }
    if (before !== after) send('browser:error', '')
    sendBrowserState()
    sendTabs()
  }

  function closeTab(id: number, sent: boolean): void {
    const tab = tabs.find((item) => item.id === id)
    if (!tab) return
    const next = afterClose({ tabs: tabList(), closedId: id, activeId, sent })
    const wasActive = id === activeId
    closeView(tab) // 보던 탭이면 화면에서도 뗀다
    tabs = tabs.filter((item) => item !== tab)
    activeId = next.activeId
    if (wasActive) {
      const after = activeTab()
      if (browserAttached && after && ctx.win) {
        if (lastBounds) after.view.setBounds(lastBounds)
        ctx.win.contentView.addChildView(after.view)
      }
      if (!after) browserAttached = false
      send('browser:error', '')
    }
    // 서랍 닫기를 먼저 — 알림 줄을 지우며 잡힌 자리 알리기(browser:place)가 빈 탭을 새로 만들지 않게
    if (next.closeDrawer) send('browser:close')
    sendBrowserState()
    sendTabs()
  }

  // 결정 콘솔을 보냈다 — 그 탭만 닫고 다음 콘솔로(남은 콘솔이 없으면 서랍도 닫는다)
  ctx.closeSentConsole = (contents) => {
    const tab = tabs.find((item) => item.view.webContents === contents)
    if (tab) closeTab(tab.id, true)
  }

  function openPage(url: string, fromUser: boolean): void {
    restoreTabs()
    const plan = planOpen({ tabs: tabList(), activeId, url, fromUser, showing: browserAttached })
    const tab = tabs.find((item) => item.id === plan.tabId) || createTab()
    if (plan.navigate) loadInTab(tab, url)
    if (plan.activate) activate(tab.id)
    else sendTabs()
  }

  // 화면이 서랍을 열고, 다 나오면 browser:place 로 자리를 알려 준다.
  // background — 에이전트가 연 것(새 콘솔이 보던 화면을 뺏지 않는다). 주소 칸은 보는 탭 주소로
  ctx.openInBrowser = (url, options = {}) => {
    openPage(url, !options.background)
    send('browser:open', tabUrl(ensureActiveTab()))
    if (ctx.win) ctx.win.show()
  }

  // 화면 좌표(CSS 픽셀)는 확대·축소 비율을 곱해야 창 좌표가 된다. 창 안으로 자른다
  ctx.placeBrowser = (rect) => {
    if (!ctx.win || !rect) return
    const tab = ensureActiveTab()
    const zoom = ctx.win.webContents.getZoomFactor()
    const [contentWidth = 0, contentHeight = 0] = ctx.win.getContentSize()
    const x = Math.min(Math.max(0, Math.round(rect.x * zoom)), contentWidth)
    const y = Math.min(Math.max(0, Math.round(rect.y * zoom)), contentHeight)
    const width = Math.min(Math.max(0, Math.round(rect.width * zoom)), contentWidth - x)
    const height = Math.min(Math.max(0, Math.round(rect.height * zoom)), contentHeight - y)
    lastBounds = { x, y, width, height }
    tab.view.setBounds(lastBounds)
    if (!browserAttached) {
      ctx.win.contentView.addChildView(tab.view)
      browserAttached = true
      sendBrowserState()
      sendTabs()
    }
  }

  // 서랍을 닫기 시작할 때 먼저 뗀다(페이지가 화면 위에 떠 있으니 슬라이드 전에 치운다). 페이지는 그대로 두어 다시 열면 이어 본다
  ctx.hideBrowser = () => {
    const tab = activeTab()
    if (!ctx.win || !tab || !browserAttached) return
    ctx.win.contentView.removeChildView(tab.view)
    browserAttached = false
  }

  ctx.browserCommand = (name, value) => {
    if (name === 'navigate') {
      const url = core.normalizeAddress(value)
      if (!url) return { error: say('error.urlNotAllowed') }
      openPage(url, true)
      return { url }
    }
    if (name === 'tab-select') {
      if (tabs.some((tab) => tab.id === Number(value))) activate(Number(value))
      return {}
    }
    if (name === 'tab-close') {
      closeTab(Number(value), false)
      return {}
    }
    const tab = activeTab()
    if (!tab || tab.view.webContents.isDestroyed()) return {}
    const contents = tab.view.webContents
    if (name === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    if (name === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    if (name === 'reload') contents.reload()
    if (name === 'stop') contents.stop()
    if (name === 'external' && core.isWebUrl(contents.getURL())) shell.openExternal(contents.getURL())
    return {}
  }
}
