// 화면(renderer)에 열어 주는 기능 — Node 는 넘기지 않고 이 함수들만
const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel) => (callback) => {
  const handler = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('studio', {
  // 언어 사전 { language, dictionary, fallback } — 동기로 받는다(첫 그림 전에) · 메뉴 [보기 → 언어] 로 바꾸면 onLanguage
  i18n: () => ipcRenderer.sendSync('i18n:get'),
  onLanguage: listen('i18n:changed'),
  athenaState: () => ipcRenderer.invoke('athena:state'),
  pickAthenaDir: () => ipcRenderer.invoke('athena:pick'),
  installAthena: () => ipcRenderer.invoke('athena:install'),
  // 회사 팩 — 본체 명령 결과만(파일 · 폴더 고르기는 main 의 대화상자)
  packList: () => ipcRenderer.invoke('pack:list'),
  // 팩 열기 — 이 창을 그 팩으로 바꾼다(다른 창이 보고 있으면 그 창이 앞으로) · options.newWindow 면 새 창으로
  packOpen: (id, options) => ipcRenderer.invoke('pack:open', id, options),
  packNew: () => ipcRenderer.invoke('pack:new'),
  packCancel: () => ipcRenderer.invoke('pack:cancel'),
  packInspect: (kind, source) => ipcRenderer.invoke('pack:inspect', kind, source),
  packImport: (token, choice) => ipcRenderer.invoke('pack:import', token, choice),
  packExport: (kind) => ipcRenderer.invoke('pack:export', kind),
  packReveal: () => ipcRenderer.invoke('pack:reveal'),
  packIcon: (id) => ipcRenderer.invoke('pack:icon', id),
  packSetName: (id, name) => ipcRenderer.invoke('pack:set-name', id, name),
  packSetIcon: (id, clear, usePicked) => ipcRenderer.invoke('pack:set-icon', id, clear, usePicked),
  packPickIcon: () => ipcRenderer.invoke('pack:pick-icon'),
  packContextMenu: (id, point) => ipcRenderer.invoke('pack:context-menu', id, point),
  // 이 창 닫기 — 시작 화면에서 다른 팩 창을 연 뒤(창이 하나뿐이면 닫지 않는다)
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onPackState: listen('pack:state'),
  onPackProgress: listen('pack:progress'),
  onPackChanged: listen('pack:changed'),
  onPackCommand: listen('pack:command'),
  // 작업 창 — 데몬의 탭·pane(모든 함수가 pane id 를 단다)
  screenAttach: () => ipcRenderer.invoke('screen:attach'),
  openAgent: (size, options) => ipcRenderer.invoke('agent:open', size, options),
  packRestoreArm: (id) => ipcRenderer.invoke('pack:restore-arm', id),
  packRestoreDisarm: () => ipcRenderer.invoke('pack:restore-disarm'),
  onPackRestored: (handler) => ipcRenderer.on('pack:restored', (_event, result) => handler(result)),
  packRestoreNow: () => ipcRenderer.invoke('pack:restore-now'),
  packRestoreDiscard: () => ipcRenderer.invoke('pack:restore-discard'),
  tabNew: (size) => ipcRenderer.invoke('tab:new', size),
  tabSelect: (tabId) => ipcRenderer.invoke('tab:select', tabId),
  tabClose: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  tabRename: (tabId, label) => ipcRenderer.invoke('tab:rename', tabId, label),
  workspaceSelect: (workspaceId) => ipcRenderer.invoke('workspace:select', workspaceId),
  workspaceNew: (size) => ipcRenderer.invoke('workspace:new', size),
  // 가운데 맨 아래 에이전트 모니터 — 보일 때만 main 이 Claude 기록을 따라 읽는다
  monitorWatch: (on) => ipcRenderer.send('monitor:watch', on),
  onMonitorUpdate: listen('monitor:update'),
  // 오른쪽 Explorer — 작업 공간 폴더 안만(main 이 루트를 정한다)
  explorerList: (workspaceId, relative) => ipcRenderer.invoke('explorer:list', workspaceId, relative),
  explorerStatus: (workspaceId) => ipcRenderer.invoke('explorer:status', workspaceId),
  explorerOpen: (workspaceId, relative) => ipcRenderer.invoke('explorer:open', workspaceId, relative),
  tabSize: (tabId, size) => ipcRenderer.send('tab:size', tabId, size),
  tabRatio: (tabId, path, ratio) => ipcRenderer.invoke('tab:ratio', tabId, path, ratio),
  paneSplit: (paneId, direction) => ipcRenderer.invoke('pane:split', paneId, direction),
  paneClose: (paneId) => ipcRenderer.invoke('pane:close', paneId),
  paneFocus: (paneId) => ipcRenderer.send('pane:focus', paneId),
  paneInput: (paneId, data) => ipcRenderer.send('pane:input', paneId, data),
  paneResize: (paneId, cols, rows) => ipcRenderer.send('pane:resize', paneId, cols, rows),
  openBoard: () => ipcRenderer.invoke('board:open'),
  // [작업] 팝업 — 목록 · 계획서 상세 · 요청이 바뀌면 { supported, requests }
  workGet: () => ipcRenderer.invoke('work:get'),
  workRequests: () => ipcRenderer.invoke('work:requests'),
  workAnswer: (id, answer) => ipcRenderer.invoke('work:answer', id, answer),
  workRedeliver: (id) => ipcRenderer.invoke('work:redeliver', id),
  workOpenPlan: (id, html) => ipcRenderer.invoke('work:open-plan', id, html),
  openBoardSection: (section) => ipcRenderer.invoke('board:section', section),
  workDetail: (id) => ipcRenderer.invoke('work:detail', id),
  onWorkRequests: listen('work:requests'),
  // 메뉴 막대 · 맥 알림에서 — 요청 id(없으면 [작업] 팝업만)
  onWorkOpen: listen('work:open'),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  // 지금 탭(work · board) — 메뉴 막대 알림이 보고 있는 pane 을 건너뛸 때 쓴다
  reportTab: (tab) => ipcRenderer.send('ui:tab', tab),
  // 옆 브라우저 — 페이지는 main 이 그리고 화면은 서랍 자리만 알린다
  browserPlace: (rect) => ipcRenderer.send('browser:place', rect),
  browserHide: () => ipcRenderer.send('browser:hide'),
  browserCommand: (name, value) => ipcRenderer.invoke('browser:command', name, value),
  onBrowserOpen: listen('browser:open'),
  onBrowserReset: listen('browser:reset'),
  onBrowserToggle: listen('browser:toggle'),
  onBrowserState: listen('browser:state'),
  onBrowserError: listen('browser:error'),
  onBrowserClose: listen('browser:close'),
  onPaneData: listen('pane:data'),
  onPaneResized: listen('pane:resized'),
  onPaneExit: listen('pane:exit'),
  onScreenState: listen('screen:state'),
  onScreenBranches: listen('screen:branches'),
  onScreenPaneStatus: listen('screen:pane-status'),
  onScreenResync: listen('screen:resync'),
  onScreenDisconnected: listen('screen:disconnected'),
  onScreenCommand: listen('screen:command'),
  onTabSwitch: listen('tab:switch'),
  onPickRequest: listen('athena:pick'),
})
