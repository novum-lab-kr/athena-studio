// ── 아테나 폴더 — 팩 창 ───────────────────────────────────────
// main.js createPackWindow 에서 옮겼다(PR3g) — electron(app · dialog) · 화면 문구(say) · 스튜디오 집 자리(studio) · 코어 준비(athenaReposRoot · prepareStudioCore · coreInstallError) ·
// 창 찾기(ctxOfBody) · 창 목록 저장(saveWindows) · 에이전트 답 언어(syncAgentLanguage) · 메뉴 막대(hasTray · pollTray)는 인자로 받는다.
// 이 창 현황판 포트(packBoardPort) · 에이전트 모니터(monitor)는 main.mts 의 창 변수 그대로 — 쓰기 함수(setPackBoardPort) · 같은 객체로 받는다. 작업 공간 브랜치 캐시는 ctx.resetBranches(pane-watch.mts)로 비운다.
// ctx 에 같은 이름(pickAthenaDir · rebindBody · installAthena)으로 붙인다
import type { BrowserWindow } from 'electron'
import * as core from '../lib/core.mts'
import { newMonitor } from './monitor-logs.mts'
import type { Monitor } from './monitor-logs.mts'
import type { Say } from '../lib/pack.mts'
import type { createCoreRunner } from './core-runner.mts'

type CoreRunner = ReturnType<typeof createCoreRunner>
type Layout = { core: string }
// 화면에 돌려주는 이 창 본체 상태(ctx.athenaState — 칸은 main.mts 가 정한다)
type AthenaState = Record<string, unknown>

// 팩 창 문맥(main.mts createPackWindow) 중 아테나 폴더가 읽는 것 · 붙이는 것
export type AthenaDirCtx = {
  athenaDir: string | null
  win: BrowserWindow | null
  packBusy: string | null
  athenaState(): AthenaState
  detachScreen(): void
  watchRequests(): void
  prepareBoardPort(): void
  setMonitorWatch(on: boolean): void
  resetBranches(): void
  rememberBrowser(): void
  pickAthenaDir?: () => Promise<AthenaState>
  rebindBody?: (dir: string) => AthenaState
  installAthena?: () => Promise<AthenaState>
}

type AthenaDirDeps = {
  app: Pick<typeof import('electron').app, 'getPath'>
  dialog: Pick<typeof import('electron').dialog, 'showOpenDialog'>
  say: Say
  studio: Layout
  athenaReposRoot: CoreRunner['athenaReposRoot']
  prepareStudioCore: CoreRunner['prepareStudioCore']
  coreInstallError: CoreRunner['coreInstallError']
  ctxOfBody: (dir: string) => (AthenaDirCtx & { show(): void }) | null
  saveWindows: () => void
  syncAgentLanguage: (dir: string | null) => void
  monitor: Monitor
  setPackBoardPort: (port: number | null) => void
  hasTray: () => boolean
  pollTray: () => unknown
}

export function installAthenaDir(ctx: AthenaDirCtx, deps: AthenaDirDeps): void {
  const { app, dialog, say, studio, athenaReposRoot, prepareStudioCore, coreInstallError, ctxOfBody, saveWindows, syncAgentLanguage, monitor, setPackBoardPort, hasTray, pollTray } = deps

  ctx.pickAthenaDir = async () => {
    const result = await dialog.showOpenDialog(ctx.win as BrowserWindow, {
      title: say('dialog.pickAthena.title'),
      message: say('dialog.pickAthena.message'),
      properties: ['openDirectory'],
      defaultPath: ctx.athenaDir || app.getPath('home'),
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true, ...ctx.athenaState() }
    return useAthenaDir(result.filePaths[0])
  }

  function useAthenaDir(dir: string): AthenaState {
    // 팩 작업 중에는 본체를 바꾸지 않는다
    if (ctx.packBusy) return { ...ctx.athenaState(), error: say('error.packBusyAthena', { task: ctx.packBusy }) }
    const check = core.checkAthenaDir(dir)
    if (!check.ok) return { ...ctx.athenaState(), error: say('error.notAthenaDir', { files: check.missing.join(', ') }), picked: dir }
    // 다른 창이 이미 그 본체면 그 창으로(창 하나 = 본체 하나)
    const other = ctxOfBody(dir)
    if (other && other !== ctx) {
      other.show()
      return { ...ctx.athenaState(), error: say('pack.open.alreadyOpen') }
    }
    try {
      core.ensureAthenaConfig(dir, athenaReposRoot(dir))
    } catch (error) {
      return { ...ctx.athenaState(), error: say('error.configCreate', { message: (error as Error).message }), picked: dir }
    }
    const changed = dir !== ctx.athenaDir
    if (changed) return rebindBody(dir)
    syncAgentLanguage(dir)
    saveWindows()
    ctx.prepareBoardPort()
    return { ...ctx.athenaState(), changed }
  }

  // 이 창을 다른 본체(팩)로 다시 묶는다(한 창에서 팩을 바꿔 본다).
  // 이전 본체의 pane · 에이전트는 닫지 않는다(데몬에서 계속 돌고, 다시 오면 그 본체의 보던 자리 그대로). 화면은 돌려준 상태로 다시 붙는다(attach{body}) —
  // 작업 공간 · 현황판 포트 · 옆 브라우저 · 에이전트 모니터 · 팩 상태가 새 본체 것으로
  function rebindBody(dir: string): AthenaState {
    try {
      core.ensureAthenaConfig(dir, athenaReposRoot(dir))
    } catch {}
    ctx.detachScreen() // 화면이 다시 붙을 때 새 본체로 묶인다
    ctx.rememberBrowser()
    ctx.athenaDir = dir
    syncAgentLanguage(dir)
    ctx.watchRequests()
    setPackBoardPort(null)
    ctx.resetBranches()
    resetMonitor()
    saveWindows()
    ctx.prepareBoardPort()
    if (hasTray()) pollTray()
    return { ...ctx.athenaState(), changed: true }
  }
  ctx.rebindBody = rebindBody

  // 에이전트 모니터 — 새 본체 기록부터 다시 모은다(보고 있었으면 바로 이어서)
  function resetMonitor(): void {
    const watching = monitor.watching
    clearInterval(monitor.timer as NodeJS.Timeout)
    Object.assign(monitor, newMonitor())
    if (watching) ctx.setMonitorWatch(true)
  }

  // 처음 켤 때 · [다시 시도] — 앱이 들고 온 코어를 ~/.athena-studio/core 로 풀어 쓴다
  ctx.installAthena = async () => {
    const prepared = await prepareStudioCore({ update: false })
    if (!prepared.ok) return { ...ctx.athenaState(), error: coreInstallError(prepared) }
    return useAthenaDir(studio.core)
  }
}
