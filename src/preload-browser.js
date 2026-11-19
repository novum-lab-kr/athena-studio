// @ts-check
// 떼어 낸 서랍 창(src/renderer/browser-window.html — [웹] · [시뮬레이터] 두 탭)에 열어 주는 기능 — 막대 · 탭 줄 · 알림 줄 · 시뮬레이터 칸에 필요한 것만.
// 메인 창 preload 와 같은 studio 이름 · 같은 채널이라 ui/browser-bar.tsx · ui/sim-bar.tsx 를 그대로 쓴다. Node 는 넘기지 않는다
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
  // 보는 탭이 바뀌었다 — 창을 닫으면 서랍이 이 탭으로 열린다
  drawerMode: (mode) => ipcRenderer.send('drawer:mode', mode),
  browserPlace: (rect) => ipcRenderer.send('browser:place', rect),
  browserHide: () => ipcRenderer.send('browser:hide'),
  browserCommand: (name, value) => ipcRenderer.invoke('browser:command', name, value),
  onBrowserOpen: listen('browser:open'),
  onBrowserState: listen('browser:state'),
  onBrowserError: listen('browser:error'),
  onBrowserTabs: listen('browser:tabs'),
  simCurrent: () => ipcRenderer.invoke('sim:current'),
  simCommand: (name) => ipcRenderer.send('sim:command', name),
  simList: () => ipcRenderer.invoke('sim:list'),
  simStart: (id) => ipcRenderer.invoke('sim:start', id),
  simPlace: (rect) => ipcRenderer.send('sim:place', rect),
  simHide: () => ipcRenderer.send('sim:hide'),
  simShot: (id) => ipcRenderer.invoke('sim:shot', id),
  simFrame: (id) => ipcRenderer.invoke('sim:frame', id),
  simTap: (id, x, y) => ipcRenderer.invoke('sim:tap', id, x, y),
  simSwipe: (id, from, to) => ipcRenderer.invoke('sim:swipe', id, from, to),
}))
