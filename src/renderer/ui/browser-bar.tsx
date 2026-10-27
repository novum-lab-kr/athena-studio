// 옆 브라우저 막대(.browser-bar — 뒤로 · 앞으로 · 새로고침 · 주소 칸 · 기본 브라우저 · 닫기)와 알림 줄(#browser-error)
// PR-R12. 서랍 껍데기(열기 · 닫기 · 스르륵 · 너비 끌기 · 페이지 자리 알리기 placeBrowserView · 탭 줄 열기 단추 · 서랍의 loading 클래스 · 제목)는 renderer.js 그대로.
// 실제 페이지는 main 의 WebContentsView(src/main/side-browser.mts)라 여기서는 막대 · 알림 줄만 그린다.
// 다른 팝업과 달리 열고 닫지 않는다 — 켤 때 한 번 띄워 두고 계속 쓴다(서랍을 닫아도 주소 칸은 남는다)
import { flushSync } from 'react-dom'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'

// main 이 보내는 browser:state(src/main/side-browser.mts sendBrowserState)
export type BrowserState = { url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean; loading?: boolean }

// 바닐라가 넘긴다 — 서랍 닫기(Esc · ✕) · 페이지 자리 다시 알리기(알림 줄이 생기거나 없어지면 자리가 바뀐다)
export type BrowserActions = { close: () => void; place: () => void }

type BarView = { url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean; error: string }
const view = createStore<BarView>({ url: '', canGoBack: false, canGoForward: false, loading: false, error: '' })

let urlInput: HTMLInputElement | null = null
let errorBox: HTMLElement | null = null
let actions: BrowserActions = { close: () => {}, place: () => {} }

// 바닐라가 바로 DOM 을 고치던 때처럼 그리기는 바로(flushSync)
function commit(next: Partial<BarView>): void {
  flushSync(() => view.set({ ...view.get(), ...next }))
}

// 켤 때 한 번 — 막대 칸 · 알림 줄 칸에 각각 띄운다(내리지 않는다)
export function mount(bar: HTMLElement, error: HTMLElement, next: BrowserActions): void {
  actions = next
  errorBox = error
  mountIsland(bar, <Bar />)
  mountIsland(error, <ErrorLine />)
}

// 주소 칸의 글 — 비었으면 처음 여는 것(renderer.js toggleBrowserPanel 이 주소 칸부터 포커스)
export function url(): string {
  return view.get().url
}

export function focusUrl(): void {
  urlInput?.focus({ preventScroll: true })
}

// 링크로 열기 · 팩 바꾸기(비우기) — 포커스와 상관없이 바꾼다
export function setUrl(next: string): void {
  commit({ url: next })
}

export function showError(message: string): void {
  commit({ error: message })
  if (errorBox) errorBox.hidden = !message
  // 알림 줄이 생기거나 없어지면 페이지 자리가 바뀐다
  requestAnimationFrame(actions.place)
}

// main 알림(browser:state) — 주소 칸을 고치는 중이면 그 글은 그대로 둔다
export function applyState(next: BrowserState): void {
  const typing = Boolean(urlInput) && document.activeElement === urlInput
  commit({
    ...(typing ? {} : { url: next.url || '' }),
    canGoBack: Boolean(next.canGoBack),
    canGoForward: Boolean(next.canGoForward),
    loading: Boolean(next.loading),
  })
  if (next.loading) showError('')
}

async function navigate(): Promise<void> {
  const result = await studio.browserCommand('navigate', view.get().url)
  showError(result.error || '')
  if (!result.error) urlInput?.blur()
}

function Bar() {
  const say = useSay()
  const { url: address, canGoBack, canGoForward, loading } = useStore(view)
  return (
    <>
      <button id="browser-back" title={say('browser.back')} disabled={!canGoBack} onClick={() => studio.browserCommand('back')}>
        ◀
      </button>
      <button id="browser-forward" title={say('browser.forward')} disabled={!canGoForward} onClick={() => studio.browserCommand('forward')}>
        ▶
      </button>
      <button id="browser-reload" title={loading ? say('browser.stop') : say('common.reload')} onClick={() => studio.browserCommand(loading ? 'stop' : 'reload')}>
        {loading ? '✕' : '⟳'}
      </button>
      <input
        id="browser-url"
        ref={(node) => {
          urlInput = node
        }}
        className="browser-url"
        spellCheck={false}
        autoComplete="off"
        placeholder={say('browser.urlPlaceholder')}
        value={address}
        onChange={(event) => view.set({ ...view.get(), url: event.currentTarget.value })}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void navigate()
          if (event.key === 'Escape') actions.close()
        }}
      />
      <button id="browser-external" title={say('browser.external')} onClick={() => studio.browserCommand('external')}>
        ↗
      </button>
      <button id="browser-close" title={say('common.close')} onClick={() => actions.close()}>
        ✕
      </button>
    </>
  )
}

function ErrorLine() {
  return <>{useStore(view).error}</>
}
