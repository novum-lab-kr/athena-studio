// 화면(renderer)에 열어 주는 기능 — Node 는 넘기지 않고 이 함수들만
const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel) => (callback) => {
  const handler = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('studio', {
  athenaState: () => ipcRenderer.invoke('athena:state'),
  pickAthenaDir: () => ipcRenderer.invoke('athena:pick'),
  termStart: (cols, rows) => ipcRenderer.invoke('term:start', cols, rows),
  termStop: () => ipcRenderer.invoke('term:stop'),
  termInput: (data) => ipcRenderer.send('term:input', data),
  termResize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
  ensureBoard: () => ipcRenderer.invoke('board:ensure'),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  onTermData: listen('term:data'),
  onTermExit: listen('term:exit'),
  onTermRestart: listen('term:restart'),
  onTabSwitch: listen('tab:switch'),
  onBoardReload: listen('board:reload'),
  onPickRequest: listen('athena:pick'),
})
