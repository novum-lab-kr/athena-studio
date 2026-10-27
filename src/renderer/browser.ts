// 옆 브라우저 서랍 껍데기 — 열기 · 닫기 · 스르륵 · 자리 알리기(placeBrowserView) · 너비 끌기 · main 알림 받기(initBrowser)
// renderer.js 에서 옮김(R3d · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 막대 · 알림 줄은 React(ui/browser-bar.tsx)
import { $, currentTab } from './core.ts'
import { views } from './terminal.ts'
import { screen } from './screen.ts'
import { modalOpen } from './pack-dialogs.ts'
import { welcomeShown } from './pack-switch.ts'
import { StudioUi } from './ui/index.ts'
import type { BrowserState } from './ui/browser-bar.tsx'

// ── 옆 브라우저 ──────────────────────────────────────────
// 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그린다 — 화면 위에 따로 떠 있어서
// 다 나온 뒤에 자리(#browser-slot)를 알려 붙이고, 닫을 땐 먼저 떼고 미끄러져 들어간다.
// 막대(앞뒤 · 새로고침 · 주소 칸 · 기본 브라우저 · 닫기)와 알림 줄은 React(ui/browser-bar.tsx) — 서랍 껍데기 · 너비 끌기는 여기
const BROWSER_SLIDE_MS = 240
export let browserOpen = false
let browserTimer: number | null = null
let urlFocusTimer: number | null = null

function openBrowserPanel(): void {
  if (welcomeShown()) return // 팩을 고르기 전에는 옆 브라우저를 열지 않는다(⌘⇧B · 링크 열기 포함)
  const panel = $('browser')
  if (browserOpen) return placeBrowserView()
  browserOpen = true
  clearTimeout(browserTimer as number | undefined)
  panel.hidden = false
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
  studio.browserHide()
  panel.classList.remove('open', 'resizing')
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
  if (!browserOpen || browserTimer || $('browser').hidden || $('browser').classList.contains('resizing')) return
  const rect = $('browser-slot').getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  studio.browserPlace({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
}

function toggleBrowserPanel(): void {
  if (browserOpen) return closeBrowserPanel()
  openBrowserPanel()
  // 처음이면 주소창부터 — 다 나온 뒤에, 스크롤 없이(나오는 중에 포커스를 주면 뒤 화면이 밀린다).
  // 그사이 닫았거나 다른 곳을 눌렀으면 하지 않는다
  if (StudioUi.browser.url()) return
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
const BROWSER_EDGE_GAP = 120 // 왼쪽에 이만큼은 남긴다

function clampBrowserWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, BROWSER_MIN_WIDTH), Math.max(BROWSER_MIN_WIDTH, window.innerWidth - BROWSER_EDGE_GAP)))
}

function setBrowserWidth(width: number | null): void {
  const panel = $('browser')
  if (width === null) {
    panel.style.width = ''
    localStorage.removeItem('studio.browserWidth')
  } else {
    panel.style.width = `${clampBrowserWidth(width)}px`
    localStorage.setItem('studio.browserWidth', String(clampBrowserWidth(width)))
  }
}

function initBrowserResize(): void {
  const panel = $('browser')
  const handle = $('browser-resize')
  // 저장된 너비(없으면 기본 46%)
  const applySaved = () => {
    const saved = Number(localStorage.getItem('studio.browserWidth'))
    panel.style.width = saved > 0 ? `${clampBrowserWidth(saved)}px` : ''
  }
  applySaved()
  let dragging = false
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !browserOpen) return
    dragging = true
    handle.setPointerCapture(event.pointerId)
    panel.classList.add('resizing')
    studio.browserHide()
    event.preventDefault()
  })
  handle.addEventListener('pointermove', (event) => {
    // 끄는 중에 서랍을 닫으면(resizing 이 지워짐) 끌기도 끝난 것
    if (dragging && panel.classList.contains('resizing')) panel.style.width = `${clampBrowserWidth(window.innerWidth - event.clientX)}px`
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
    placeBrowserView()
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('lostpointercapture', finish)
  // 너비를 px 로 정해 두면 창을 늘려도 서랍 크기는 그대로라 ResizeObserver 가 안 불린다 — 창 크기가 바뀌면 다시 맞춰 붙인다
  window.addEventListener('resize', () => {
    if (panel.style.width) panel.style.width = `${clampBrowserWidth(parseFloat(panel.style.width))}px`
    placeBrowserView()
  })
  handle.addEventListener('dblclick', () => {
    setBrowserWidth(null)
    requestAnimationFrame(placeBrowserView)
  })
}

export function initBrowser(): void {
  initBrowserResize()
  StudioUi.browser.mount($('browser').querySelector('.browser-bar') as HTMLElement, $('browser-error'), { close: closeBrowserPanel, place: placeBrowserView })
  $('browser-toggle').addEventListener('click', toggleBrowserPanel)
  studio.onBrowserOpen((url) => {
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
  studio.onBrowserClose(closeBrowserPanel) // 결정 콘솔 [이대로 진행] 을 보낸 뒤(main 이 알린다)
  // 창 크기가 바뀌면 서랍(너비 46%)도 바뀐다 — 다 나와 있을 때만 다시 붙인다
  new ResizeObserver(() => placeBrowserView()).observe($('browser-slot'))
}
