// 옆 브라우저 서랍 껍데기 — 열기 · 닫기 · 스르륵 · 자리 알리기(placeBrowserView) · 너비 끌기 · main 알림 받기(initBrowser)
// renderer.js 에서 옮김(R3d · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 막대 · 알림 줄은 React(ui/browser-bar.tsx)
import { $, currentTab } from './core.ts'
import { views } from './terminal.ts'
import { screen } from './screen.ts'
import { modalOpen } from './pack-dialogs.ts'
import { popOpen } from './work.ts'
import { welcomeShown } from './pack-switch.ts'
import { StudioUi } from './ui/index.ts'
import { fitEdgeSizes } from './edge-resize.ts'
import type { BrowserState } from './ui/browser-bar.tsx'

// ── 옆 브라우저 ──────────────────────────────────────────
// 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그린다 — 화면 위에 따로 떠 있어서
// 다 나온 뒤에 자리(#browser-slot)를 알려 붙이고, 닫을 땐 먼저 떼고 미끄러져 들어간다.
// 막대(앞뒤 · 새로고침 · 주소 칸 · 기본 브라우저 · 닫기)와 알림 줄은 React(ui/browser-bar.tsx) — 서랍 껍데기 · 너비 끌기는 여기
// 열려 있는 동안 배치는 작업 공간 | 터미널 | 웹(서랍) | Explorer — 작업 창 안 자리 칸(#browser-space)이 서랍 너비만큼 비고
// 서랍은 그 자리에 붙는다(main.browser-docked · --browser-right = 자리 칸 오른쪽의 Explorer 폭 · style.css). 터미널도 Explorer 도 덮지 않고,
// Explorer 를 접으면 서랍이 접힌 줄 옆 오른쪽 끝까지 온다.
// 작업 창이 줄면 #panes ResizeObserver → layoutPanes 가 pane 을 새 크기로 맞춘다(크기 요청은 pane 마다 하나씩만 — sendPaneSize)
const BROWSER_SLIDE_MS = 240
const mainEl = (): HTMLElement => document.querySelector('main') as HTMLElement

// 서랍 양옆에 남길 폭 — 작업 화면이면 왼쪽은 가운데(터미널) 앞 칸(팩 줄 · 작업 공간 · 손잡이), 오른쪽은 자리 칸 뒤(Explorer 손잡이 · 패널 · 접힌 줄).
// 다른 화면(설정 등)이면 0
function siblingsWidth(from: Element | null, step: (el: Element) => Element | null): number {
  let width = 0
  for (let el = from; el; el = step(el)) width += el.getBoundingClientRect().width
  return Math.round(width)
}
function dockGap(): number {
  if ($('work').hidden) return 0
  return siblingsWidth($('browser-space').nextElementSibling, (el) => el.nextElementSibling)
}
function dockLeft(): number {
  const center = $('work').querySelector('.center')
  if ($('work').hidden || !center) return 0
  return siblingsWidth(center.previousElementSibling, (el) => el.previousElementSibling)
}

// Explorer · 작업 공간을 접거나 펴거나 너비를 바꾸면 서랍도 따라 옮겨 붙이고 최대 너비를 다시 잡는다(style.css --browser-dock)
function syncDockGap(): void {
  const main = mainEl()
  const right = `${dockGap()}px`
  const left = `${dockLeft()}px`
  if (main.style.getPropertyValue('--browser-right') === right && main.style.getPropertyValue('--browser-left') === left) return
  main.style.setProperty('--browser-right', right)
  main.style.setProperty('--browser-left', left)
  if (browserOpen) placeBrowserView()
}

// 작업 창 안에 서랍 자리를 비우거나(열 때) 원래 너비로(닫을 때)
function dockWork(docked: boolean): void {
  mainEl().classList.toggle('browser-docked', docked)
  syncDockGap()
  fitEdgeSizes() // 작업 창 폭이 바뀌면 양옆 칸이 쓸 수 있는 폭도 바뀐다
}
export let browserOpen = false
// 탭들을 새 창으로 떼어 낸 동안(main browser:detached) — 서랍은 닫혀 있고 웹 버튼(⌘⇧B)은 그 창을 앞으로 가져온다
let browserDetached = false
let browserTimer: number | null = null
let urlFocusTimer: number | null = null

function openBrowserPanel(): void {
  if (welcomeShown()) return // 팩을 고르기 전에는 옆 브라우저를 열지 않는다(⌘⇧B · 링크 열기 포함)
  const panel = $('browser')
  if (browserOpen) return placeBrowserView()
  browserOpen = true
  clearTimeout(browserTimer as number | undefined)
  panel.hidden = false
  dockWork(true) // 작업 창이 먼저 비켜서고 그 자리로 서랍이 미끄러져 들어온다
  $('browser-toggle').classList.add('active')
  $('browser-toggle').setAttribute('aria-expanded', 'true')
  void panel.offsetWidth // 숨김을 푼 뒤 한 번 그려야 transform 이 스르륵 움직인다
  panel.classList.add('open')
  browserTimer = setTimeout(() => {
    browserTimer = null
    placeBrowserView()
  }, BROWSER_SLIDE_MS)
}

export function closeBrowserPanel(): void {
  const panel = $('browser')
  if (!browserOpen) return
  browserOpen = false
  clearTimeout(browserTimer as number | undefined)
  clearTimeout(urlFocusTimer as number | undefined)
  hideBrowserView()
  panel.classList.remove('open', 'resizing')
  dockWork(false) // 작업 창은 바로 원래 너비로 — 서랍은 그 위로 미끄러져 나간다
  $('browser-toggle').classList.remove('active')
  $('browser-toggle').setAttribute('aria-expanded', 'false')
  // 닫으면 작업 창 터미널로 입력을 돌려준다
  const focused = views.get(screen.focused as string)
  if (currentTab === 'work' && focused && !focused.el.hidden) focused.term.focus()
  browserTimer = setTimeout(() => {
    browserTimer = null
    panel.hidden = true
  }, BROWSER_SLIDE_MS)
}

// 다 나온 서랍의 자리 — 슬라이드 중(transform)이면 아직 붙이지 않는다
export function placeBrowserView(): void {
  if (modalOpen()) return // 대화상자 위를 덮지 않게 — 닫힐 때 syncModal 이 다시 붙인다
  if (popOpen()) return // 탭 줄 팝업 위를 덮지 않게 — 닫힐 때 closePops 가 다시 붙인다
  if (!browserOpen || browserTimer || $('browser').hidden || $('browser').classList.contains('resizing')) return
  const rect = $('browser-slot').getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  const slot = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  // [시뮬레이터] 탭 — 웹 페이지는 떼고, iOS 기기가 열려 있으면 serve-sim 페이지 뷰를 붙인다(ui/sim-bar.tsx)
  if (StudioUi.sim.mode.get() === 'sim') {
    studio.browserHide()
    if (StudioUi.sim.wantsView()) studio.simPlace(slot)
    else studio.simHide()
    StudioUi.sim.shown()
    return
  }
  studio.simHide()
  studio.browserPlace(slot)
}

// 서랍의 네이티브 뷰(웹 페이지 · 시뮬레이터 페이지)를 잠깐 뗀다 — 대화상자 · 팝업 · 너비 끌기 동안. 다시 붙이는 것은 placeBrowserView
export function hideBrowserView(): void {
  studio.browserHide()
  studio.simHide()
}

// 모드에 따라 서랍 줄을 고친다 — 시뮬레이터면 탭 줄 · 알림 줄을 감춘다(CSS .browser.sim)
function applyMode(): void {
  $('browser').classList.toggle('sim', StudioUi.sim.mode.get() === 'sim')
}

function toggleBrowserPanel(): void {
  if (browserDetached) return void studio.browserCommand('focus-detached')
  if (browserOpen) return closeBrowserPanel()
  openBrowserPanel()
  // 처음이면 주소창부터 — 다 나온 뒤에, 스크롤 없이(나오는 중에 포커스를 주면 뒤 화면이 밀린다).
  // 그사이 닫았거나 다른 곳을 눌렀으면 하지 않는다
  if (StudioUi.browser.url() || StudioUi.sim.mode.get() === 'sim') return
  clearTimeout(urlFocusTimer as number | undefined)
  const before = document.activeElement
  urlFocusTimer = setTimeout(() => {
    if (browserOpen && document.activeElement === before) StudioUi.browser.focusUrl()
  }, BROWSER_SLIDE_MS)
}

// main 알림(browser:state) — 서랍의 읽는 중 표시 · 제목은 여기, 막대는 React
function applyBrowserState(next: BrowserState): void {
  $('browser').classList.toggle('loading', Boolean(next.loading))
  $('browser').title = next.title || ''
  StudioUi.browser.applyState(next)
}

// 너비 끌기 — 끄는 동안은 페이지(화면 위에 떠 있는 뷰)를 떼어 둔다. 마우스가 페이지 위로 지나가도 끌기가 이어지게
const BROWSER_MIN_WIDTH = 320
const BROWSER_EDGE_GAP = 120 // 터미널 칸에 이만큼은 남긴다(양옆 칸 폭은 따로 뺀다)

function clampBrowserWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, BROWSER_MIN_WIDTH), Math.max(BROWSER_MIN_WIDTH, window.innerWidth - BROWSER_EDGE_GAP - dockGap() - dockLeft())))
}

// 너비는 main 의 --browser-width 로 — 서랍과 작업 창(비우는 폭)이 같은 값을 쓴다(style.css --browser-dock)
function setWidthVar(width: number | null): void {
  if (width === null) mainEl().style.removeProperty('--browser-width')
  else mainEl().style.setProperty('--browser-width', `${clampBrowserWidth(width)}px`)
}

function setBrowserWidth(width: number | null): void {
  setWidthVar(width)
  if (width === null) localStorage.removeItem('studio.browserWidth')
  else localStorage.setItem('studio.browserWidth', String(clampBrowserWidth(width)))
}

function initBrowserResize(): void {
  const panel = $('browser')
  const handle = $('browser-resize')
  // 저장된 너비(없으면 기본 46%)
  const applySaved = () => {
    const saved = Number(localStorage.getItem('studio.browserWidth'))
    setWidthVar(saved > 0 ? saved : null)
  }
  applySaved()
  let dragging = false
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !browserOpen) return
    dragging = true
    handle.setPointerCapture(event.pointerId)
    panel.classList.add('resizing')
    hideBrowserView()
    event.preventDefault()
  })
  handle.addEventListener('pointermove', (event) => {
    // 끄는 중에 서랍을 닫으면(resizing 이 지워짐) 끌기도 끝난 것 · 작업 창도 따라 줄고 는다
    if (dragging && panel.classList.contains('resizing')) setWidthVar(window.innerWidth - dockGap() - event.clientX)
  })
  // 놓기 · 취소 · 캡처를 잃음 모두 여기로. 그사이 서랍을 닫았으면 너비는 저장하지 않는다
  const finish = (event: PointerEvent) => {
    if (!dragging) return
    dragging = false
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    const stillResizing = panel.classList.contains('resizing')
    panel.classList.remove('resizing')
    // 끄다가 서랍을 닫았으면 끌던 너비는 버리고 저장된 너비로
    if (!browserOpen || !stillResizing) return applySaved()
    setBrowserWidth(panel.getBoundingClientRect().width)
    fitEdgeSizes()
    placeBrowserView()
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('lostpointercapture', finish)
  // 너비를 px 로 정해 두면 창을 늘려도 서랍 크기는 그대로라 ResizeObserver 가 안 불린다 — 창 크기가 바뀌면 다시 맞춰 붙인다(넘치는 너비는 CSS clamp 가 자른다)
  window.addEventListener('resize', () => placeBrowserView())
  handle.addEventListener('dblclick', () => {
    setBrowserWidth(null)
    fitEdgeSizes()
    requestAnimationFrame(placeBrowserView)
  })
  // 작업 공간 · Explorer 접기 · 펴기 · 너비 끌기 · 작업 화면 전환 · 창 크기 — 서랍 양옆 폭을 다시 잰다
  const watch = new ResizeObserver(syncDockGap)
  for (const id of ['work', 'spaces', 'side-panel', 'side-rail']) watch.observe($(id))
}

export function initBrowser(): void {
  initBrowserResize()
  StudioUi.browser.mount($('browser').querySelector('.browser-bar') as HTMLElement, $('browser-error'), $('browser-tabs'), { close: closeBrowserPanel, place: placeBrowserView })
  StudioUi.sim.mount($('sim-screen'), { close: closeBrowserPanel, place: placeBrowserView, isOpen: () => browserOpen })
  applyMode()
  StudioUi.sim.mode.subscribe(applyMode)
  $('browser-toggle').addEventListener('click', toggleBrowserPanel)
  studio.onBrowserOpen((url) => {
    // 링크로 열면 웹 탭으로
    StudioUi.sim.setMode('web')
    StudioUi.browser.setUrl(url)
    StudioUi.browser.showError('')
    openBrowserPanel()
  })
  // 팩을 바꿨다 — 서랍을 닫고 주소 칸을 비운다(새 팩에서 열면 그 팩에서 보던 페이지로)
  studio.onBrowserReset(() => {
    if (browserOpen) closeBrowserPanel()
    StudioUi.browser.setUrl('')
    StudioUi.browser.showError('')
  })
  studio.onBrowserToggle(toggleBrowserPanel)
  studio.onBrowserState(applyBrowserState)
  studio.onBrowserError(StudioUi.browser.showError)
  studio.onBrowserClose(closeBrowserPanel) // 결정 콘솔 [이대로 진행] 을 보내 남은 콘솔이 없을 때 · 마지막 탭을 닫았을 때(main 이 알린다)
  studio.onBrowserTabs(StudioUi.browser.applyTabs)
  // 떼어 내면 서랍을 닫고 터미널이 원래 너비로(탭은 새 창으로 옮겨 감). 돌아올 때 서랍 열기는 main 이 browser:open 으로
  studio.onBrowserDetached((detached) => {
    browserDetached = detached
    if (detached && browserOpen) closeBrowserPanel()
  })
  // 창 크기가 바뀌면 서랍(너비 46%)도 바뀐다 — 다 나와 있을 때만 다시 붙인다
  new ResizeObserver(() => placeBrowserView()).observe($('browser-slot'))
}
