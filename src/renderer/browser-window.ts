// 떼어 낸 옆 브라우저 창 — 막대(ui/browser-bar.tsx 를 detached 로) · 탭 줄 · 알림 줄 · 페이지 자리 알리기.
// 탭 뷰는 main(src/main/side-browser.mts detach)이 이 창으로 옮겨 붙인다. preload 는 preload-browser.js(막대에 필요한 것만)
import * as StudioI18n from '../lib/i18n.mts'
import { connect, textsChanged } from './ui/bridge.ts'
import * as bar from './ui/browser-bar.tsx'

let i18nState: I18nPayload = studio.i18n()
const say = (key: string, values?: Record<string, unknown>): string => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)
connect({ say, showToast: () => {} })

const panel = document.getElementById('browser') as HTMLElement
const slot = document.getElementById('browser-slot') as HTMLElement

// 페이지 자리 — 창 크기 · 탭 줄 · 알림 줄이 바뀔 때마다 다시 알린다
function place(): void {
  const rect = slot.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  studio.browserPlace({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
}

document.documentElement.lang = i18nState.language
bar.mount(panel.querySelector('.browser-bar') as HTMLElement, document.getElementById('browser-error') as HTMLElement, document.getElementById('browser-tabs') as HTMLElement, {
  close: () => {},
  place,
  detached: true,
})
studio.onBrowserState((next) => {
  panel.classList.toggle('loading', Boolean(next.loading))
  document.title = next.title || 'Athena'
  bar.applyState(next)
})
studio.onBrowserError(bar.showError)
studio.onBrowserTabs(bar.applyTabs)
studio.onLanguage((next) => {
  i18nState = next
  document.documentElement.lang = next.language
  textsChanged()
})
new ResizeObserver(place).observe(slot)
