// preload(src/preload.js)의 studio 전역 중 React 화면이 부르는 것만 — renderer.js 를 .ts 로 옮길 때(PR-R3) preload API 타입 한 곳으로 합친다
declare global {
  type MergeRepo = { name: string; autoMerge: boolean; confirm: boolean; releaseOnMerge: boolean; prBase: string }
  // main 의 appUpdateView(src/main/app-updater.mts) — src/lib/app-update.mts UpdateStatus + running. 그 파일은 Node 모듈이라 화면 타입 검사로 가져오지 않는다
  type AppUpdateView = { state: 'behind' | 'current' | 'unavailable'; behind: number; branch: string | null; reason: string | null; version: string | null; latest: string | null; running: boolean }

  // main 의 explorerList · explorerStatus(src/main/explorer-panel.mts — 실패는 guarded 가 { error }) · 아이콘 이름은 src/lib/file-icons.js iconFor(없으면 null)
  type ExplorerEntry = { name: string; dir: boolean; icon: string | null; iconOpen?: string | null }
  type ExplorerChange = { path: string; code: string; icon: string | null; iconOpen?: string | null }

  interface StudioApi {
    explorerList(workspaceId: string | null, relative: string): Promise<{ entries: ExplorerEntry[] } | { error: string }>
    explorerStatus(workspaceId: string): Promise<{ git: boolean; changes: ExplorerChange[] } | { error: string }>
    mergeSettings(): Promise<{ ok: boolean; repos: MergeRepo[] } | undefined>
    setAutoMerge(repo: string, values: { autoMerge?: boolean; confirm?: boolean }): Promise<{ ok: boolean; text?: string } | undefined>
    checkAppUpdate(): Promise<unknown>
    runAppUpdate(): Promise<{ ok: boolean; reason?: string } | undefined>
  }

  const studio: StudioApi
}

export {}
