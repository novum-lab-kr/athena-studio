// 옆 브라우저 서랍 껍데기 — 열기 · 닫기 · 자리 알리기(placeBrowserView) · main 알림 받기(initBrowser). 너비 끌기는 edge-resize.ts
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
// 열면 오른쪽 칸(Explorer · 접힌 줄) 자리를 웹이 대신 쓴다 — 배치는 작업 공간 | 터미널 | 웹(#work.browser-docked · style.css).
// Explorer 는 가려질 뿐 접힘 설정은 그대로라 닫으면 원래대로(펴 있었으면 Explorer · 접혀 있었으면 접힌 줄) 돌아온다.
// 너비는 웹과 Explorer 가 따로 기억하고 손잡이는 같은 #side-resize(edge-resize.ts — 열려 있으면 웹 너비 studio.browserWidth 를 끈다).
// 움직이는 효과 없이 그 자리에서 바뀌고, 페이지(main 의 WebContentsView — 화면 위에 따로 떠 있다)도 같은 순간에 #browser-slot 자리에 붙인다.
// 터미널 칸 폭이 바뀌면 #panes ResizeObserver → layoutPanes 가 pane 을 새 크기로 맞춘다(크기 요청은 pane 마다 하나씩만 — sendPaneSize)
export let browserOpen = false
// 탭들을 새 창으로 떼어 낸 동안(main browser:detached) — 서랍은 닫혀 있고 웹 버튼(⌘⇧B)은 그 창을 앞으로 가져온다
let browserDetached = false

// 오른쪽 칸을 웹으로(열 때) · Explorer 로(닫을 때) — 칸 폭이 바뀌니 양옆 칸이 쓸 수 있는 폭도 다시 잰다
function dockWork(docked: boolean): void {
  $('browser').hidden = !docked
  $('work').classList.toggle('browser-docked', docked)
  fitEdgeSizes()
}

function openBrowserPanel(): void {
  if (welcomeShown()) return // 팩을 고르기 전에는 옆 브라우저를 열지 않는다(⌘⇧B · 링크 열기 포함)
  if (browserOpen) return placeBrowserView()
  browserOpen = true
  dockWork(true)
  $('browser-toggle').classList.add('active')
  $('browser-toggle').setAttribute('aria-expanded', 'true')
  placeBrowserView()
}

export function closeBrowserPanel(): void {
  if (!browserOpen) return
  browserOpen = false
  hideBrowserView()
  dockWork(false)
  $('browser-toggle').classList.remove('active')
  $('browser-toggle').setAttribute('aria-expanded', 'false')
  // 닫으면 작업 창 터미널로 입력을 돌려준다
  const focused = views.get(screen.focused as string)
  if (currentTab === 'work' && focused && !focused.el.hidden) focused.term.focus()
}

// 서랍 페이지 자리 알리기 — 칸 손잡이를 끄는 동안은 붙이지 않는다(edge-resize.ts 가 떼어 두고 놓을 때 다시 부른다)
export function placeBrowserView(): void {
  if (modalOpen()) return // 대화상자 위를 덮지 않게 — 닫힐 때 syncModal 이 다시 붙인다
  if (popOpen()) return // 탭 줄 팝업 위를 덮지 않게 — 닫힐 때 closePops 가 다시 붙인다
  if (!browserOpen || $('browser').hidden || document.body.classList.contains('edge-resizing-x')) return
  const rect = $('browser-slot').getBoundingClientRect()
  // 자리가 없다(작업 창이 가려짐 — 처음 화면 등) — 떠 있는 페이지도 뗀다
  if (rect.width < 1 || rect.height < 1) return hideBrowserView()
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
  // 떼어 낸 창이 보는 탭이면 그 창을 앞으로(웹 · 시뮬레이터 따로)
  const simMode = StudioUi.sim.mode.get() === 'sim'
  if (simMode && StudioUi.sim.detachedStore.get()) return void studio.simCommand('focus-detached')
  if (!simMode && browserDetached) return void studio.browserCommand('focus-detached')
  if (browserOpen) return closeBrowserPanel()
  openBrowserPanel()
  // 처음이면 주소창부터(스크롤 없이)
  if (browserOpen && !StudioUi.browser.url() && StudioUi.sim.mode.get() !== 'sim') StudioUi.browser.focusUrl()
}

// main 알림(browser:state) — 서랍의 읽는 중 표시 · 제목은 여기, 막대는 React
function applyBrowserState(next: BrowserState): void {
  $('browser').classList.toggle('loading', Boolean(next.loading))
  $('browser').title = next.title || ''
  StudioUi.browser.applyState(next)
}

export function initBrowser(): void {
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
  // 떼어 내면 서랍을 닫고 오른쪽 칸은 Explorer 로(탭은 새 창으로 옮겨 감). 돌아올 때 서랍 열기는 main 이 browser:open 으로
  studio.onBrowserDetached((detached) => {
    browserDetached = detached
    if (detached && browserOpen) closeBrowserPanel()
  })
  // 시뮬레이터를 떼어 내면 서랍이 그 탭을 보고 있었으면 닫는다. 그 창을 닫으면(되돌리기) 그 창에서 보던 기기로 서랍의 [시뮬레이터] 탭을 연다
  studio.onSimDetached((detached) => {
    StudioUi.sim.detachedStore.set(detached)
    if (detached) {
      if (browserOpen && StudioUi.sim.mode.get() === 'sim') closeBrowserPanel()
      return
    }
    void StudioUi.sim.adopt().then(() => {
      StudioUi.sim.setMode('sim')
      openBrowserPanel()
    })
  })
  // 칸 크기가 바뀌면(창 크기 · 너비 끌기 · 탭 줄 · 알림 줄) 다시 붙인다. 너비를 px 로 정해 두면 창을 늘려도 칸 크기는 그대로라 자리(x)만 바뀐다 — 창 크기도 본다
  new ResizeObserver(() => placeBrowserView()).observe($('browser-slot'))
  window.addEventListener('resize', () => placeBrowserView())
}
