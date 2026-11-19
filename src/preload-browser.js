// @ts-check
// 떼어 낸 옆 브라우저 창(src/renderer/browser-window.html)에 열어 주는 기능 — 막대 · 탭 줄 · 알림 줄에 필요한 것만.
// 메인 창 preload 와 같은 studio 이름 · 같은 채널이라 ui/browser-bar.tsx 를 그대로 쓴다. Node 는 넘기지 않는다
const { contextBridge, ipcRenderer } = require('electron')

/** @param {string} channel */
const listen = (channel) => (/** @type {(...values: unknown[]) => void} */ callback) => {
  const handler = (/** @type {import('electron').IpcRendererEvent} */ _event, /** @type {unknown[]} */ ...args) => callback(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// 매개변수는 그대로 넘기는 값이라 unknown(main 이 받아 검사한다)
contextBridge.exposeInMainWorld('studio', /** @type {Record<string, (...values: unknown[]) => unknown>} */ ({
  // 언어 사전 { language, dictionary, fallback } — 메인 창과 같은 채널 · 바꾸면 onLanguage
  i18n: () => ipcRenderer.sendSync('i18n:get'),
  onLanguage: listen('i18n:changed'),
  browserPlace: (rect) => ipcRenderer.send('browser:place', rect),
  browserCommand: (name, value) => ipcRenderer.invoke('browser:command', name, value),
  onBrowserState: listen('browser:state'),
  onBrowserError: listen('browser:error'),
  onBrowserTabs: listen('browser:tabs'),
}))
