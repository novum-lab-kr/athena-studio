// 메뉴 막대 패널(src/renderer/tray.html)에 열어 주는 기능 — Node 는 넘기지 않고 이 함수들만
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('trayPanel', {
  // 언어 사전 { language, dictionary, fallback } — 메인 창과 같은 채널 · 바꾸면 onLanguage
  i18n: () => ipcRenderer.sendSync('i18n:get'),
  onLanguage: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('i18n:changed', handler)
    return () => ipcRenderer.removeListener('i18n:changed', handler)
  },
  // main 이 보내는 요약(에이전트 · 확인 필요 · 사용량 · 칸반 · 현황판)
  onUpdate: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('tray:update', handler)
    return () => ipcRenderer.removeListener('tray:update', handler)
  },
  // 누른 것 — focus-pane · open-card · show · menu
  action: (name, value) => ipcRenderer.send('tray:action', name, value),
  // 내용 높이에 맞춰 창 높이를
  reportHeight: (height) => ipcRenderer.send('tray:height', height),
})
