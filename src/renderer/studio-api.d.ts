// preload(src/preload.js)의 studio 전역 타입 한 곳 — 화면 .ts · .tsx 가 부르는 것.
// 새로 부르는 메서드는 여기에 더한다. 응답 모양은 main 쪽 코드(src/main.mts handle · src/main/*.mts)에서 확인해 적는다
declare global {
  // 언어 사전(main.mts i18nPayload) — i18n:get 동기 · i18n:changed
  type I18nPayload = { language: string; dictionary: Record<string, unknown>; fallback: Record<string, unknown> }
  // 아테나 폴더 상태(main.mts ctx.athenaState) — 폴더를 고르거나 받은 결과(applyAthenaResult)에는 changed 가 더 붙는다
  type AthenaState = {
    athenaDir: string | null
    valid: boolean
    missing: string[]
    boardUrl: string
    installDir: string
    tabKey: string
    platform: string
    athenaWorkspace: string
    athenaRealDir: string | null
    changed?: boolean
  }
  // 폴더 고르기 · 코어 받기(src/main/athena-dir.mts pickAthenaDir · installAthena) — 상태 + 그만두면 canceled · 못 쓰면 error(고른 폴더 picked)
  type AthenaResult = AthenaState & { canceled?: boolean; error?: string; picked?: string }

  // 데몬이 앱 화면에 주는 상태(src/daemon/main.mts Daemon.state) — 작업 공간 · 탭(분할 트리) · pane 메타
  type CellSize = { cols: number; rows: number }
  type ScreenWorkspace = { id: string; label: string; cwd: string; activeTab: string | null; body: string | null }
  type ScreenTab = { id: string; workspace: string; label: string | null; tree: import('../lib/layout.mts').Tree | null }
  type ScreenPane = { id: string; tab: string | null; dock: string | null; label: string | null; title: string | null; cols: number; rows: number }
  type ScreenState = { workspaces: ScreenWorkspace[]; activeWorkspace: string | null; tabs: ScreenTab[]; focused: string | null; panes: ScreenPane[] }
  // 데몬 명령 답(src/main/daemon-link.mts daemonCall) · 창이 없을 때(main.mts handle)는 { error }
  type DaemonReply = { result?: unknown; error?: string; code?: unknown }
  // 묻고 닫기(src/main/workspaces.mts closePane · closeTab) — 취소하면 { canceled }
  type CloseReply = DaemonReply & { canceled?: boolean }
  // 새 작업 공간(workspaces.mts newWorkspace) — 팩에 없는 git 레포면 { askAdd, dir, name }(화면이 "팩에 더할까요?")
  type WorkspaceNewReply = DaemonReply & { canceled?: boolean; askAdd?: boolean; dir?: string; name?: string }
  // 데몬에 붙기(src/main/daemon-link.mts attachScreen) — 상태 + pane 마다 되살릴 화면. 못 붙으면 { error } 만 온다(부르는 쪽이 error 를 먼저 본다)
  type AttachReply = { state: ScreenState; snapshots: Record<string, string>; error?: string }
  // 아테나 에이전트 켜기(src/main/athena-agent.mts openAthenaAgent)
  type OpenAgentResult = { error?: string; skipped?: boolean; existing?: boolean; focused?: boolean; started?: string; restore?: import('./ui/notices.tsx').RestoreResult | null }

  type MergeRepo = { name: string; autoMerge: boolean; confirm: boolean; releaseOnMerge: boolean; prBase: string }
  // main 의 appUpdateView(src/main/app-updater.mts) — src/lib/app-update.mts UpdateStatus + running. 그 파일은 Node 모듈이라 화면 타입 검사로 가져오지 않는다
  type AppUpdateView = { state: 'behind' | 'current' | 'unavailable'; behind: number; branch: string | null; reason: string | null; version: string | null; latest: string | null; running: boolean }

  // main 의 ctx.paneDetail(src/main/pane-watch.mts) — 계획서 기록은 src/lib/pane-detail.mts planRecord · 맡긴 일 줄은 leadRows
  type PaneDetailTokens = { io: number; cache: number; ioText: string; cacheText: string }
  type PaneDetailLeadRow = { id: string | undefined; title: string; paneId: string | null; who: string | undefined; what: string; sinceMs: number; state: 'wait' | 'now' | 'done'; archived?: boolean }
  type PaneDetailPlan = {
    id: string
    html: string | null
    title: string
    created: number
    readable: boolean
    request: string[]
    progress: { done: boolean; text: string }[]
    next: string[]
    blocked: string[]
    validation: string[]
    prs: string[]
    autoReview: string[]
    reviewResult: string
  }
  type PaneDetailAgent = {
    ok: true
    mode: 'agent'
    paneId: string
    label: string
    now: { state: 'gone' | 'stop' | 'work' | 'idle'; reason: 'question' | 'request' | 'heavy' | 'blocked' | null; sinceMs: number; line: string }
    report: string[]
    todo: { id: string; kind: string; title: string }[]
    tokens: PaneDetailTokens | null
    plan: PaneDetailPlan
  }
  type PaneDetailLead = { ok: true; mode: 'lead'; paneId: string; label: string; rows: PaneDetailLeadRow[]; tokens: PaneDetailTokens | null }
  type PaneDetailView = PaneDetailAgent | PaneDetailLead | { ok: false; error?: string }

  // main 의 explorerList · explorerStatus(src/main/explorer-panel.mts — 실패는 guarded 가 { error }) · 아이콘 이름은 src/lib/file-icons.js iconFor(없으면 null)
  type ExplorerEntry = { name: string; dir: boolean; icon: string | null; iconOpen?: string | null }
  type ExplorerChange = { path: string; code: string; icon: string | null; iconOpen?: string | null }
  // main 의 explorerOpen(explorer-panel.mts — 실패는 guarded 가 { error }) · 줄은 src/lib/viewer.mts ColoredRow(Node 모듈이라 가져오지 않는다) · 색은 files.mts colorRows
  type ViewerRow = { kind: 'context' | 'add' | 'del' | 'hunk'; oldNo?: number; newNo?: number; code: string; tokens?: [string, string | null, number][] }
  type ExplorerPreview = { error?: string; kind?: 'binary' | 'image' | 'diff' | 'file'; path?: string; size?: number; src?: string; rows?: ViewerRow[]; lang?: string; fg?: string; bg?: string; truncated?: boolean; untracked?: boolean }

  // 레포 이름 · 이미지(src/main/packs.mts repoSetName · repoSetIcon — 코어 pack 결과 · 실패면 text) · 이미지를 안 골랐으면 { canceled }
  type RepoLookReply = { ok?: boolean; canceled?: boolean; error?: string; text?: string; message?: string }
  // 팩에 레포 더하기 · 빼기(src/main/workspaces.mts addRepo · removeRepo — 코어 repo add · remove 결과 · 실패면 text)
  type RepoAddReply = { ok: true; already?: boolean; repo: { name: string }; path: string } | { ok: false; error?: string; text?: string; message?: string }
  type RepoRemoveReply = { ok: boolean; removed?: string; error?: string; text?: string; message?: string }
  // 레포 에이전트 부르기(src/main/pack-repos.mts callInfo · callStart — 브랜치 정보는 src/lib/pack.mts parseCallInfo)
  type CallCandidate = { branch: string; place: 'both' | 'local' | 'remote'; date: string; subject: string; noCommits: boolean; worktree: string | null }
  type CallMain = { status: string; dirty: number; branch: string; upstream: string | null; ahead: number; behind: number; gone?: boolean }
  // 실패면 { error } 만 온다(부르는 쪽이 error 를 먼저 본다)
  type CallInfo = { error?: string; agent: string; repo: string; target: string; main: CallMain | null; candidates: CallCandidate[]; direct: string | null }
  type CallStartReply = { error?: string; exists?: boolean; message?: string; ok?: boolean; agent?: string; pane?: string | null; worktree?: string; branch?: string | null }

  // 이 창 팩 상태(src/main/packs.mts ctx.refreshPacks — pack list 를 다듬은 것 + 시작 화면 칸 + 열린 팩 openIds). 지원하지 않으면 { supported: false } 만
  type PackState = {
    supported: boolean
    current?: import('./ui/pack-rail.tsx').PackItem | null
    packs?: import('./ui/pack-rail.tsx').PackItem[]
    welcome?: boolean
    launchWelcome?: boolean
    recent?: import('./ui/pack-welcome.tsx').WelcomePack[]
    openIds?: string[]
    error?: string
  }
  // 팩 명령 답(packs.mts — 실패는 { ok: false, error, text }(packErrorText) · 고르기를 그만두면 { canceled } · 그 밖의 칸은 코어 결과 그대로)
  type PackReply = { [key: string]: unknown; ok?: boolean; error?: string; text?: string; message?: string; canceled?: boolean }
  // 팩 열기 · 바꾸기(packs.mts ctx.packOpen) — 이 창에서 바꿨으면 switched + 새 상태(athena-dir.mts rebindBody) · 다른 창이 보던 팩이면 existing
  type PackOpenReply = PackReply & { id?: string; same?: boolean; existing?: boolean; switched?: boolean; state?: AthenaState; unlinkedRepos?: string[]; repair?: boolean; created?: boolean }
  // 팩 지우기(packs.mts ctx.deletePack) — 워크트리가 있으면 { error: 'has-worktrees', worktrees }(코어 bodies.mjs — dirty 는 바뀐 파일 수) · 끝나면 백업 파일 backup
  type PackDeleteReply = PackReply & { worktrees?: { name: string; dirty: number }[]; backup?: string }
  // 새 팩(packs.mts ctx.packNew) — 이 창을 새 본체로 바꿨으면 switched + 새 상태
  type PackNewReply = PackReply & { id?: string; body?: string; switched?: boolean; state?: AthenaState }
  // 가져오기 검사(packs.mts ctx.packInspect — 코어 athena/scripts/lib/packs.mjs inspect 결과 + source · summary · current). git 주소가 틀리면 { error: 'invalid-url' }
  type PackInspectReply = PackReply & {
    token?: string
    pack?: { name?: string | null; repos?: number } | null
    conflict?: { id?: string; reason?: 'packId' | 'name' } | null
    work?: { plans?: number; issues?: number; archive?: number; worktrees?: { dirty?: boolean }[] } | null
    restore?: Record<string, unknown> | null
    gitRemoved?: boolean
    source?: string
    summary?: { incoming: string; existing: string }
    current?: boolean
  }
  // 가져오기 등록(packs.mts ctx.packImport — 코어 import 결과) — 교체면 기존 팩 백업 파일 backup
  type PackImportReply = PackReply & { imported?: { id: string; name?: string } | null; backup?: string }
  // 내보내기 · 내 백업(packs.mts ctx.packExport — 코어 export · backup 결과) — 백업이면 되살리기 정보 restore · 뺀 것 warnings
  type PackExportReply = PackReply & { file?: string; files?: number; bytes?: number; restore?: { sessions?: number; worktrees?: number; missing?: unknown[] }; warnings?: string[] }
  // 이미지 미리 고르기(packs.mts ctx.packPickIcon) — 미리보기 dataUrl 만(파일은 main 이 들고 있다)
  type PackPickIconReply = { ok?: boolean; canceled?: boolean; dataUrl?: string; text?: string }

  // 사람에게 묻는 요청(src/lib/requests.mts StudioRequest — main work.mts requestsState) · [작업] 목록으로 읽으면 waited(기다린 시간 글)가 더 붙는다.
  // plan · html · pane · answer 는 코어 출력을 모양 검사 없이 옮긴 칸이라 unknown(answer 는 work.mts deliveryLine 이 읽는 모양)
  type WorkRequestView = {
    id: string
    kind: string
    title: string
    body: string
    options: { label: string; desc: string; recommended: boolean }[]
    plan: unknown
    html: unknown
    pane: unknown
    state: string
    rev: number
    createdAt: string
    answer: { choice?: unknown; text?: unknown } | null
    waited?: string
  }
  type WorkRequestsState = { supported: boolean; requests: WorkRequestView[] }
  // [작업] 목록의 작업 하나(src/lib/work-model.mts WorkItem)
  type WorkItemView = {
    id: string | undefined
    title: string
    line: string
    state: 'wait' | 'work' | 'blocked' | 'idle' | 'done'
    grade: 'formal' | 'light'
    maintenance: boolean
    html: string | null
    agents: unknown[]
    mtime: number
    doneAt: number
  }
  // [작업] 팝업 목록(src/main/work.mts ctx.workState — 요청 + work-model.mts workList)
  type WorkView = { supported: boolean; requests: WorkRequestView[]; boardUp: boolean; boardError: string | null; doing: WorkItemView[]; done: WorkItemView[]; counts: { doing: number } }
  // 작업 상세(work.mts ctx.workDetail — 계획서 원문에서 몇 줄 · work-model.mts planDetail)
  type WorkDetailReply =
    | { ok: false; error: string }
    | { ok: true; id: string; why: string; decided: string[]; progress: { checked: number; total: number; now: string }; validation: string; results: string[]; next: string; blocked: string }
  // 앱에서 답하기 · 다시 보내기(work.mts answerRequest · redeliverRequest) — delivered: 그 pane 에 넣었는지(없으면 답만 저장)
  type WorkAnswerReply = { ok: boolean; error?: string; message?: string; delivered?: boolean }

  interface StudioApi {
    // 화면 · 언어 — preload 가 sendSync · send 로 부르는 것은 값이 없다
    i18n(): I18nPayload
    screenAttach(): Promise<AttachReply>
    openAgent(size: CellSize | null, options?: { keepView?: boolean }): Promise<OpenAgentResult>
    tabNew(size: CellSize | null): Promise<DaemonReply>
    tabSelect(tabId: string): Promise<DaemonReply>
    tabClose(tabId: string): Promise<CloseReply>
    // 탭 이름(main.mts tab:rename → 데몬 tab rename) · 탭 전체 크기 알리기(tab:size — 답 없음)
    tabRename(tabId: string, label: string): Promise<DaemonReply>
    tabSize(tabId: string, size: CellSize): void
    // pane 경계 비율(main.mts tab:ratio) — 옛 데몬이 동작을 모르면 { unsupported: true } · 값이 잘못되면 { error }
    tabRatio(tabId: string, path: string[], ratio: number): Promise<DaemonReply & { unsupported?: boolean }>
    workspaceSelect(workspaceId: string): Promise<DaemonReply>
    workspaceNew(size: CellSize | null): Promise<WorkspaceNewReply>
    paneSplit(paneId: string, direction: 'right' | 'down'): Promise<DaemonReply>
    paneClose(paneId: string): Promise<CloseReply>
    // 우클릭 메뉴(workspaces.mts paneContextMenu) — 고른 항목 이름 · 안 고르면 null
    paneContextMenu(point: { x: number; y: number }): Promise<string | null | { error: string }>
    paneFocus(paneId: string): void
    paneInput(paneId: string, data: string): void
    // 크기 요청(main.mts pane:resize — 답은 pane:resized 알림으로 온다)
    paneResize(paneId: string, cols: number, rows: number): void
    // 에이전트 모니터 — 보일 때만 main 이 따라 읽는다(src/main/agent-monitor.mts setMonitorWatch · monitor:update). 돌려준 함수는 듣기 그만
    monitorWatch(on: boolean): void
    onMonitorUpdate(callback: (update: import('./ui/monitor.tsx').MonitorUpdate) => void): () => void
    // 일감을 기본 브라우저로(src/main/work.mts openBoardExternal) · 지금 탭 알리기(ui:tab — 답 없음)
    openBoard(): Promise<{ ok: boolean }>
    reportTab(tab: string): void

    explorerList(workspaceId: string | null, relative: string): Promise<{ entries: ExplorerEntry[] } | { error: string }>
    explorerStatus(workspaceId: string): Promise<{ git: boolean; changes: ExplorerChange[] } | { error: string }>
    mergeSettings(): Promise<{ ok: boolean; repos: MergeRepo[] } | undefined>
    setAutoMerge(repo: string, values: { autoMerge?: boolean; confirm?: boolean }): Promise<{ ok: boolean; text?: string } | undefined>
    checkAppUpdate(): Promise<unknown>
    runAppUpdate(): Promise<{ ok: boolean; reason?: string } | undefined>
    paneDetail(paneId: string): Promise<PaneDetailView | undefined>
    workOpenPlan(id: string, html: string | null): Promise<unknown>
    openUrl(url: string): Promise<unknown>
    // main 의 ctx.repoIcon(src/main/packs.mts → files.mts iconDataUrl)
    repoIcon(name: string): Promise<{ dataUrl: string | null } | undefined>
    // main 의 browserCommand(src/main/side-browser.mts) — navigate 는 { url } 또는 { error }, 나머지는 {}
    browserCommand(name: 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'external', value?: string): Promise<{ url?: string; error?: string }>
    // main 의 ctx.packIcon(src/main/packs.mts → files.mts iconDataUrl) · pack:cancel(도는 팩 명령 멈추기)
    packIcon(id: string): Promise<{ dataUrl: string | null } | undefined>
    packCancel(): Promise<unknown>
    // 회사 팩(src/main.mts handle('pack:…') → src/main/packs.mts) — 창이 없으면 { error }
    packList(): Promise<PackState>
    packOpen(id: string, options: { newWindow?: boolean }): Promise<PackOpenReply>
    packDelete(id: string, options?: { withWorktrees?: boolean }): Promise<PackDeleteReply>
    packReveal(): Promise<unknown>
    packSetName(id: string, name: string | null): Promise<PackReply>
    packSetIcon(id: string, clear: boolean, usePicked?: boolean): Promise<PackReply>
    packPickIcon(kind: 'pack' | 'repo'): Promise<PackPickIconReply | undefined>
    // 우클릭 메뉴(packs.mts packContextMenu) — 고른 동작 이름 · 안 고르면 null
    packContextMenu(id: string, point: { x: number; y: number }): Promise<string | null | { error: string }>
    // 이 창 닫기(main.mts window:close — 창이 하나뿐이면 닫지 않는다)
    closeWindow(): Promise<unknown>
    // 옆 브라우저 뷰를 잠깐 떼기(대화상자가 위를 덮을 때 — src/main/side-browser.mts)
    browserHide(): void
    // 왼쪽 작업 공간 목록 · Explorer 미리보기(R3c) — main.mts handle(pack:repos · repo:set-name · repo:set-icon · space:context-menu · workspace:close · pack:body-behind ·
    // pack:remove-repo · pack:add-repo · workspace:open-dir · pack:call-info · pack:call-start · explorer:open)
    packRepos(): Promise<import('./ui/spaces.tsx').SpaceRepo[]>
    repoSetName(name: string, displayName: string | null): Promise<RepoLookReply>
    repoSetIcon(name: string, clear: boolean, usePicked?: boolean): Promise<RepoLookReply>
    // 레포 줄 우클릭(workspaces.mts spaceContextMenu) — 고른 동작 이름 · 안 고르면 null
    spaceContextMenu(target: { workspace: string | null; repo: string | null }, point: { x: number; y: number }): Promise<string | null | { error: string }>
    workspaceClose(workspaceId: string): Promise<{ ok?: boolean; closed?: number; error?: string }>
    packBodyBehind(): Promise<boolean>
    packRemoveRepo(name: string): Promise<RepoRemoveReply>
    packAddRepo(dir: string, name: string | null): Promise<RepoAddReply>
    workspaceOpenDir(dir: string, size: CellSize | null): Promise<DaemonReply>
    packCallInfo(name: string): Promise<CallInfo>
    packCallStart(name: string, options: { branch: string; reuse: boolean }): Promise<CallStartReply>
    explorerOpen(workspaceId: string | null, relative: string): Promise<ExplorerPreview>
    // 시작 · 아테나 폴더 · 팩 만들기 · 가져오기 · 내보내기(R3f — main.ts · pack-transfer.ts) — main.mts handle(athena:state · athena:pick · athena:install ·
    // pack:new · pack:inspect · pack:import · pack:export · pack:restore-now · pack:restore-arm · pack:restore-disarm)
    athenaState(): Promise<AthenaState>
    pickAthenaDir(): Promise<AthenaResult>
    installAthena(): Promise<AthenaResult>
    packNew(): Promise<PackNewReply>
    packInspect(kind: string, source: string | null): Promise<PackInspectReply>
    packImport(token: string, choice: string): Promise<PackImportReply>
    packExport(kind: string): Promise<PackExportReply>
    packRestoreNow(): Promise<import('./ui/notices.tsx').RestoreResult>
    packRestoreArm(id: string): Promise<unknown>
    packRestoreDisarm(): Promise<unknown>
    // main 이 보내는 알림(preload listen — 돌려준 함수는 듣기 그만) · 값 모양은 보내는 곳(src/main.mts · src/main/*.mts 의 send('<이름>', …))
    onPackState(callback: (next: PackState) => void): () => void
    onPackProgress(callback: (step: import('./ui/pack-progress.tsx').PackProgressStep) => void): () => void
    onPackRestored(callback: (result: import('./ui/notices.tsx').RestoreResult) => void): () => void
    onPackCaughtUp(callback: (info: { pack: string }) => void): () => void
    onPackChanged(callback: (info: { ok: boolean; replaced: string }) => void): () => void
    onPackCommand(callback: (name: string) => void): () => void
    onTabSwitch(callback: (name: string) => void): () => void
    onPickRequest(callback: () => void): () => void
    onPaneData(callback: (paneId: string, data: string) => void): () => void
    onPaneResized(callback: (paneId: string, cols: number, rows: number) => void): () => void
    onScreenState(callback: (next: ScreenState) => void): () => void
    onScreenBranches(callback: (next: Record<string, string | null>) => void): () => void
    onScreenPaneStatus(callback: (next: Record<string, string | null>) => void): () => void
    onScreenResync(callback: () => void): () => void
    onScreenDisconnected(callback: () => void): () => void
    onScreenCommand(callback: (name: string) => void): () => void
    onLanguage(callback: (next: I18nPayload) => void): () => void
    // 옆 브라우저(src/main/side-browser.mts) — 다 나온 서랍 자리 알리기(main.mts browserRect 가 숫자를 본다) · main 알림들
    browserPlace(rect: { x: number; y: number; width: number; height: number }): void
    onBrowserOpen(callback: (url: string) => void): () => void
    onBrowserReset(callback: () => void): () => void
    onBrowserToggle(callback: () => void): () => void
    onBrowserState(callback: (next: import('./ui/browser-bar.tsx').BrowserState) => void): () => void
    onBrowserError(callback: (message: string) => void): () => void
    onBrowserClose(callback: () => void): () => void
    // [작업] 팝업 · 요청(src/main/work.mts) — 창이 없을 때의 { error } 는 이 창에서 부르면 오지 않는다
    workGet(): Promise<WorkView>
    workRequests(): Promise<WorkRequestsState>
    onWorkRequests(callback: (next: WorkRequestsState) => void): () => void
    workAnswer(id: string, answer: { choice: string; text: string }): Promise<WorkAnswerReply>
    workRedeliver(id: string): Promise<WorkAnswerReply>
    workDetail(id: string): Promise<WorkDetailReply>
    // 트레이에서 요청을 누르면(src/main/tray.mts openRequestFromTray) — id 가 없으면 [작업] 팝업
    onWorkOpen(callback: (id: string | null) => void): () => void
    // 일감 페이지 메뉴(work.mts openBoardSection · openDiagrams)
    openBoardSection(section: string): Promise<unknown>
    openDiagrams(): Promise<{ ok: boolean; error?: string; message?: string }>
    // pane [상세] 아이콘을 달 pane(src/main/pane-watch.mts paneBound — lib/pane-detail.mts bindings)
    paneBound(): Promise<Record<string, 'agent' | 'lead'>>
    onPaneBound(callback: (next: Record<string, 'agent' | 'lead'>) => void): () => void
    // ⚙ 앱 업데이트 상태(src/main/app-updater.mts appUpdateView) — 창이 없으면 { error }(main.mts handle)
    appUpdateStatus(): Promise<AppUpdateView & { error?: string }>
    onAppUpdate(callback: (next: AppUpdateView) => void): () => void
  }

  const studio: StudioApi
}

export {}
