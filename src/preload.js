// @ts-check
// 화면(renderer)에 열어 주는 기능 — Node 는 넘기지 않고 이 함수들만
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// 화면에 넘기는 값은 main 이 받아 검사한다 — 여기서는 그대로 넘긴다(그래서 매개변수는 unknown)
/** @typedef {Record<string, (...values: unknown[]) => unknown>} Bridge */

/** @param {string} channel */
const listen = (channel) => (/** @type {(...values: unknown[]) => void} */ callback) => {
  const handler = (/** @type {import('electron').IpcRendererEvent} */ _event, /** @type {unknown[]} */ ...args) => callback(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('studio', /** @type {Bridge} */ ({
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
  packPickIcon: (kind) => ipcRenderer.invoke('pack:pick-icon', kind),
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
  packRepos: () => ipcRenderer.invoke('pack:repos'),
  // 레포 표시 이름 · 이미지(사이드바만 — 코어 pack set-repo-name · set-repo-icon)
  repoIcon: (name) => ipcRenderer.invoke('repo:icon', name),
  repoSetName: (name, displayName) => ipcRenderer.invoke('repo:set-name', name, displayName),
  repoSetIcon: (name, clear, usePicked) => ipcRenderer.invoke('repo:set-icon', name, clear, usePicked),
  // ⚙ 설정 — 이 창 팩의 레포별 자동 머지(읽기 · 바꾸기 — 바꾸기는 코어 pack set-auto-merge)
  mergeSettings: () => ipcRenderer.invoke('settings:merge'),
  setAutoMerge: (repo, values) => ipcRenderer.invoke('settings:set-merge', repo, values),
  // ⚙ 설정 맨 아래 — 앱 업데이트(개발 앱 체크아웃이 origin/main 보다 뒤처졌는지 · 받기 → 다시 켜기)
  appUpdateStatus: () => ipcRenderer.invoke('app-update:status'),
  checkAppUpdate: () => ipcRenderer.invoke('app-update:check'),
  runAppUpdate: () => ipcRenderer.invoke('app-update:run'),
  onAppUpdate: listen('app-update:status'),
  packCallInfo: (name) => ipcRenderer.invoke('pack:call-info', name),
  packCallStart: (name, options) => ipcRenderer.invoke('pack:call-start', name, options),
  packRestoreArm: (id) => ipcRenderer.invoke('pack:restore-arm', id),
  packRestoreDisarm: () => ipcRenderer.invoke('pack:restore-disarm'),
  onPackCaughtUp: listen('pack:caught-up'),
  onPackRestored: listen('pack:restored'),
  packRestoreNow: () => ipcRenderer.invoke('pack:restore-now'),
  packRestoreDiscard: () => ipcRenderer.invoke('pack:restore-discard'),
  tabNew: (size) => ipcRenderer.invoke('tab:new', size),
  tabSelect: (tabId) => ipcRenderer.invoke('tab:select', tabId),
  tabClose: (tabId) => ipcRenderer.invoke('tab:close', tabId),
  tabRename: (tabId, label) => ipcRenderer.invoke('tab:rename', tabId, label),
  workspaceSelect: (workspaceId) => ipcRenderer.invoke('workspace:select', workspaceId),
  workspaceNew: (size) => ipcRenderer.invoke('workspace:new', size),
  workspaceOpenDir: (dir, size) => ipcRenderer.invoke('workspace:open-dir', dir, size),
  packAddRepo: (dir, name) => ipcRenderer.invoke('pack:add-repo', dir, name),
  packRemoveRepo: (name) => ipcRenderer.invoke('pack:remove-repo', name),
  packBodyBehind: () => ipcRenderer.invoke('pack:body-behind'),
  packDelete: (id, options) => ipcRenderer.invoke('pack:delete', id, options),
  workspaceClose: (id) => ipcRenderer.invoke('workspace:close', id),
  spaceContextMenu: (target, point) => ipcRenderer.invoke('space:context-menu', target, point),
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
  paneContextMenu: (point, title) => ipcRenderer.invoke('pane:context-menu', point, title),
  paneFocus: (paneId) => ipcRenderer.send('pane:focus', paneId),
  paneInput: (paneId, data) => ipcRenderer.send('pane:input', paneId, data),
  // pane 에 끌어다 놓은 파일의 경로(File.path 는 Electron 32 에서 빠졌다 — webUtils) · 디스크 파일이 아니면 ''
  pathForFile: (file) => webUtils.getPathForFile(/** @type {File} */ (file)),
  paneResize: (paneId, cols, rows) => ipcRenderer.send('pane:resize', paneId, cols, rows),
  openBoard: () => ipcRenderer.invoke('board:open'),
  // [작업] 팝업 — 목록 · 계획서 상세 · 요청이 바뀌면 { supported, requests }
  workGet: () => ipcRenderer.invoke('work:get'),
  workRequests: () => ipcRenderer.invoke('work:requests'),
  workAnswer: (id, answer) => ipcRenderer.invoke('work:answer', id, answer),
  workRedeliver: (id) => ipcRenderer.invoke('work:redeliver', id),
  workOpenPlan: (id, html) => ipcRenderer.invoke('work:open-plan', id, html),
  openBoardSection: (section) => ipcRenderer.invoke('board:section', section),
  openDiagrams: () => ipcRenderer.invoke('board:diagrams'),
  workDetail: (id) => ipcRenderer.invoke('work:detail', id),
  // pane [상세] — 계획서에 묶인 pane id → agent · lead / 그 pane 의 상세(열려 있는 동안 화면이 다시 부른다)
  paneBound: () => ipcRenderer.invoke('pane:bound'),
  paneDetail: (paneId) => ipcRenderer.invoke('pane:detail', paneId),
  onPaneBound: listen('screen:pane-bound'),
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
}))
