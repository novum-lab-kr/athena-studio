// 떼어 낸 서랍 창 — 서랍과 같은 [웹 | 시뮬레이터] 탭 · 막대(ui/browser-bar.tsx 를 detached 로) · 탭 줄 · 알림 줄 · 시뮬레이터 칸(ui/sim-bar.tsx) · 페이지 자리 알리기.
// 웹 탭 뷰 · iOS 페이지 뷰는 main(src/main/drawer-window.mts 가 띄운 이 창 — side-browser.mts · simulator.mts)이 옮겨 붙인다.
// 탭을 바꾸면 보는 쪽 뷰만 붙이고 다른 쪽은 뗀다(페이지 · 기기는 main 에 그대로 살아 있다 — 서랍과 같다). preload 는 preload-browser.js
import * as StudioI18n from '../lib/i18n.mts'
import { connect, textsChanged } from './ui/bridge.ts'
import * as bar from './ui/browser-bar.tsx'
import * as sim from './ui/sim-bar.tsx'
import type { DrawerMode } from './ui/sim-bar.tsx'

let i18nState: I18nPayload = studio.i18n()
const say = (key: string, values?: Record<string, unknown>): string => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)
connect({ say, showToast: () => {} })

const panel = document.getElementById('browser') as HTMLElement
const slot = document.getElementById('browser-slot') as HTMLElement
// 처음 볼 탭 — 떼어 낼 때 보던 탭(main 이 주소 query 로 준다)
const first: DrawerMode = new URLSearchParams(location.search).get('mode') === 'sim' ? 'sim' : 'web'

// 페이지 자리 — 창 크기 · 탭 줄 · 알림 줄 · 탭이 바뀔 때마다 다시 알린다(서랍 browser.ts placeBrowserView 와 같은 갈래)
function place(): void {
  const rect = slot.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  const box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  if (sim.mode.get() === 'sim') {
    studio.browserHide()
    if (sim.wantsView()) studio.simPlace(box)
    else studio.simHide()
    sim.shown()
    return
  }
  studio.simHide()
  studio.browserPlace(box)
}

// 창 제목 — 웹 탭은 페이지 제목, 시뮬레이터 탭은 탭 이름
let webTitle = 'Athena'
const applyTitle = (): void => {
  document.title = sim.mode.get() === 'sim' ? say('sim.modeSim') : webTitle
}

// 탭이 바뀌면 줄을 고치고(시뮬레이터면 탭 줄 · 알림 줄을 감춘다 — CSS .browser.sim) main 에 알린다(닫으면 서랍이 이 탭으로)
function applyMode(): void {
  const current = sim.mode.get()
  panel.classList.toggle('sim', current === 'sim')
  applyTitle()
  studio.drawerMode(current)
}

document.documentElement.lang = i18nState.language
sim.mountWindow(document.getElementById('sim-screen') as HTMLElement, place, first)
bar.mount(panel.querySelector('.browser-bar') as HTMLElement, document.getElementById('browser-error') as HTMLElement, document.getElementById('browser-tabs') as HTMLElement, {
  close: () => {},
  place,
  detached: true,
})
applyMode()
sim.mode.subscribe(applyMode)
studio.onBrowserState((next) => {
  panel.classList.toggle('loading', Boolean(next.loading))
  webTitle = next.title || 'Athena'
  applyTitle()
  bar.applyState(next)
})
studio.onBrowserError(bar.showError)
studio.onBrowserTabs(bar.applyTabs)
// 떼어 낸 동안 링크로 열었다 — 서랍처럼 [웹] 탭으로
studio.onBrowserOpen(() => {
  sim.setMode('web')
  bar.showError('')
})
studio.onLanguage((next) => {
  i18nState = next
  document.documentElement.lang = next.language
  applyTitle()
  textsChanged()
})
// 서랍에서 보던 기기를 이어 받은 뒤 자리를 알린다(목록 읽기 · 켜진 기기 열기는 shown 이)
void sim.adopt().then(place)
new ResizeObserver(place).observe(slot)
