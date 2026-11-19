// 떼어 낸 시뮬레이터 창 — 막대(ui/sim-bar.tsx 를 detached 로 · ✕ 대신 [되돌리기]) · 칸(안내 글 · Android 화면 그림) · iOS 페이지 자리 알리기.
// iOS 페이지 뷰는 main(src/main/simulator.mts detach)이 이 창에 붙인다. preload 는 preload-sim.js(시뮬레이터 채널만)
import * as StudioI18n from '../lib/i18n.mts'
import { connect, textsChanged } from './ui/bridge.ts'
import * as sim from './ui/sim-bar.tsx'

let i18nState: I18nPayload = studio.i18n()
const say = (key: string, values?: Record<string, unknown>): string => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)
connect({ say, showToast: () => {} })

const slot = document.getElementById('browser-slot') as HTMLElement

// iOS 페이지 자리 — 창 크기가 바뀔 때마다 다시 알린다. iOS 기기가 열려 있지 않으면 뗀다
function place(): void {
  const rect = slot.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  if (sim.wantsView()) studio.simPlace({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  else studio.simHide()
  sim.shown()
}

document.documentElement.lang = i18nState.language
sim.mountWindow(document.querySelector('.browser-bar') as HTMLElement, document.getElementById('sim-screen') as HTMLElement, place)
studio.onLanguage((next) => {
  i18nState = next
  document.documentElement.lang = next.language
  textsChanged()
})
// 서랍에서 보던 기기를 이어 받은 뒤 자리를 알린다(목록 읽기 · 켜진 기기 열기는 shown 이)
void sim.adopt().then(place)
new ResizeObserver(place).observe(slot)
