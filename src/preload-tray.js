// @ts-check
// 메뉴 막대 패널(src/renderer/tray.html)에 열어 주는 기능 — Node 는 넘기지 않고 이 함수들만
const { contextBridge, ipcRenderer } = require('electron')

// 매개변수는 그대로 넘기는 값이라 unknown(main 이 받아 검사한다)
contextBridge.exposeInMainWorld('trayPanel', /** @type {Record<string, (...values: unknown[]) => unknown>} */ ({
  // 언어 사전 { language, dictionary, fallback } — 메인 창과 같은 채널 · 바꾸면 onLanguage
  i18n: () => ipcRenderer.sendSync('i18n:get'),
  onLanguage: (/** @type {(payload: unknown) => void} */ callback) => {
    const handler = (/** @type {import('electron').IpcRendererEvent} */ _event, /** @type {unknown} */ payload) => callback(payload)
    ipcRenderer.on('i18n:changed', handler)
    return () => ipcRenderer.removeListener('i18n:changed', handler)
  },
  // main 이 보내는 요약(에이전트 · 확인 필요 · 사용량 · 칸반 · 일감)
  onUpdate: (/** @type {(data: unknown) => void} */ callback) => {
    const handler = (/** @type {import('electron').IpcRendererEvent} */ _event, /** @type {unknown} */ data) => callback(data)
    ipcRenderer.on('tray:update', handler)
    return () => ipcRenderer.removeListener('tray:update', handler)
  },
  // 누른 것 — focus-pane · open-card · show · menu
  action: (name, value) => ipcRenderer.send('tray:action', name, value),
  // 내용 높이에 맞춰 창 높이를
  reportHeight: (height) => ipcRenderer.send('tray:height', height),
}))
