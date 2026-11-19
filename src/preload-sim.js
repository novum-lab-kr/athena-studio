// @ts-check
// 떼어 낸 시뮬레이터 창(src/renderer/sim-window.html)에 열어 주는 기능 — 시뮬레이터 막대 · 칸에 필요한 것만.
// 메인 창 preload 와 같은 studio 이름 · 같은 채널이라 ui/sim-bar.tsx 를 그대로 쓴다. Node 는 넘기지 않는다
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
