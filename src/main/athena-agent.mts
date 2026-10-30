// ── 아테나 에이전트 · 백업에서 되살리기 — 팩 창 ─────────────────
// main.js createPackWindow 에서 옮겼다(PR3f) — 화면 문구(say) · 코어 팩 명령(runPack) · 되살리기 표시 지우기(disarmRestore — main.js 의 restoreArmedFor)는 인자로 받고,
// ctx 에 같은 이름(openAthenaAgent · restoreStatus · packRestore · restoreNow)으로 붙인다
import * as core from '../lib/core.mts'
import * as packModel from '../lib/pack.mts'
import * as layout from '../lib/layout.mts'
import type { Tree } from '../lib/layout.mts'
import type { PackResult, Say } from '../lib/pack.mts'
import type { RunCoreOptions } from './core-runner.mts'

// 데몬 답에서 읽는 칸만(모양은 검사하지 않는다 — 옛 main.js 와 같다)
type Workspace = { id: string; label?: unknown; cwd?: string }
type StateReply = { result?: { workspaces: Workspace[]; tabs: { workspace: string; tree: Tree | null }[] }; error?: string }
type CreatedReply = { result: { root_pane: { id: string }; workspace: { id: string } }; error?: string }
type SplitReply = { result?: { pane?: { id: string } } }
type RunReply = { error?: string }
// pack restore-work 결과 — 되살린 아테나 대화(athena[] · 세션 id 는 코어가 모양을 본 값)만 더 읽는다
type Restore = PackResult & { athena?: { session: unknown }[] }
type RunPack = (args: string[], options: RunCoreOptions) => Promise<PackResult>

// 팩 창 문맥(main.mts createPackWindow) 중 아테나 에이전트 · 되살리기가 읽는 것 · 붙이는 것
export type AthenaAgentCtx = {
  athenaDir: string | null
  restoreForPack?: string | null
  daemonCall(op: string, args?: Record<string, unknown>): Promise<unknown>
  packTask(name: string, work: () => Promise<PackResult>): Promise<PackResult>
  packProgress(step: unknown): void
  studioEnv(): Record<string, string>
  openAthenaAgent?: unknown
  restoreStatus?: unknown
  packRestore?: (options?: { discard?: boolean }) => Promise<Restore>
  restoreNow?: unknown
}

type AthenaAgentDeps = { say: Say; runPack: RunPack; waitCoreUpdate: () => Promise<void>; disarmRestore: () => void }

export function installAthenaAgent(ctx: AthenaAgentCtx, { say, runPack, waitCoreUpdate, disarmRestore }: AthenaAgentDeps): void {
  // 옛 main.js 의 지역 daemonCall 과 같은 함수(ctx.daemonCall 은 창을 만들 때 한 번 붙고 바뀌지 않는다)
  const daemonCall = ctx.daemonCall
  // ── 아테나 에이전트 ──
  // athena 작업 공간(이 창의 아테나 폴더)이 있으면 그리로 옮기기만 하고, 없으면 만들어 묻지 않고 claude(없으면 codex)를 켠다
  // keepView — 팩을 바꿔 돌아왔을 때: 이미 있으면 옮기지 않는다(그 본체에서 보던 자리 그대로)
  // 같은 창 문맥에서 '찾기 → (업데이트 대기) → 재확인 → 작업 공간 만들기 → 에이전트 시작' 은 한 번에 하나만 — 대기하던 두 호출이 함께 풀려도 둘 다 '없음'으로 보고 둘 만들지 않게
  let agentTail: Promise<unknown> = Promise.resolve()
  ctx.openAthenaAgent = (size: Record<string, unknown>, options: { keepView?: boolean } = {}) => {
    const run = agentTail.then(() => openAthenaAgentNow(size, options))
    agentTail = run.catch(() => {})
    return run
  }
  const openAthenaAgentNow = async (size: Record<string, unknown>, { keepView = false }: { keepView?: boolean } = {}) => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return { skipped: true }
    const state = (await daemonCall('state')) as StateReply
    if (state.error) return { error: state.error }
    const existing = core.findAthenaWorkspace(state.result!.workspaces, ctx.athenaDir as string)
    // 백업에서 되살리기로 열었으면 — 워크트리 · 대화 기록 · 에이전트 pane 을 먼저 되살리고, 아테나는 그 대화로 잇는다
    const restore = ctx.restoreForPack ? await (ctx.packRestore as NonNullable<AthenaAgentCtx['packRestore']>)() : null
    const athenaSessions = (restore && restore.athena) || []
    if (existing && athenaSessions.length) await resumeAthenaBeside(existing, athenaSessions)
    if (existing && keepView) return { existing: true, restore }
    if (existing) {
      await daemonCall('workspace select', { workspace: existing.id })
      return { focused: true, restore }
    }
    // agentDecision 은 { none } | { agent } — 읽는 칸을 같이 적는다
    // 새 에이전트 pane 을 시작하기 전 — 코어 업데이트가 도는 중이면 끝날 때까지(옛 코어로 시작한 에이전트를 업데이트가 막거나 건너뛰지 않게). 있던 작업 공간으로 옮기기만 하는 위 경로는 기다리지 않는다
    await waitCoreUpdate()
    // 기다리는 사이 다른 호출이 작업 공간을 만들었을 수 있다 — 다시 확인해 있으면 새로 만들지 않고 그리로(중복 아테나 방지)
    const after = (await daemonCall('state')) as StateReply
    const createdMeanwhile = after.error ? null : core.findAthenaWorkspace(after.result!.workspaces, ctx.athenaDir as string)
    if (createdMeanwhile) {
      if (keepView) return { existing: true, restore }
      await daemonCall('workspace select', { workspace: createdMeanwhile.id })
      return { focused: true, restore }
    }
    const decision = core.agentDecision(core.availableAgents(process.env.PATH)) as { none?: true; agent?: string }
    const created = (await daemonCall('workspace create', { label: core.ATHENA_WORKSPACE, cwd: ctx.athenaDir, focus: true, ...size })) as CreatedReply
    if (created.error) return { error: say('error.athenaWorkspaceCreate', { message: created.error }) }
    if (decision.none) return { error: say('error.agentNotInstalled') }
    // 되살린 아테나 대화가 있으면 첫 것을 이 pane 에서 잇는다(claude 만 — 세션 id 는 코어가 모양을 본 값)
    const [first, ...rest] = decision.agent === 'claude' ? athenaSessions : []
    const text = first ? core.resumeCommand(first.session) : decision.agent
    const run = (await daemonCall('pane run', { pane: created.result.root_pane.id, text })) as RunReply
    if (run.error) return { error: say('error.agentStart', { agent: decision.agent }) }
    if (first) await ackRestore([first.session])
    if (rest.length) await resumeAthenaBeside({ id: created.result.workspace.id }, rest)
    return { started: decision.agent, restore }
  }

  // 아테나 작업 공간이 이미 있으면 — 되살린 아테나 대화마다 첫 pane 옆에 pane 을 하나 쪼개 잇는다
  async function resumeAthenaBeside(workspace: { id: string }, sessions: { session: unknown }[]): Promise<void> {
    const state = (await daemonCall('state')) as StateReply
    const tab = state.result && state.result.tabs.find((entry) => entry.workspace === workspace.id)
    const base = tab && layout.paneIds(tab.tree)[0]
    if (!base) return
    for (const item of sessions) {
      const split = (await daemonCall('pane split', { target: base, direction: 'right', ratio: 0.5, cwd: ctx.athenaDir, focus: false })) as SplitReply
      const run = split.result && split.result.pane ? ((await daemonCall('pane run', { pane: split.result.pane.id, text: core.resumeCommand(item.session) })) as RunReply) : null
      if (run && !run.error) await ackRestore([item.session])
    }
  }
  // 아테나 대화를 pane 에서 켰다고 코어에 알린다 — 그 전에는 되살리기 정보를 지우지 않는다
  const ackRestore = (sessions: unknown[]) => runPack(['restore-work', ...sessions.flatMap((session) => ['--ack', session as string])], { dir: ctx.athenaDir })

  // ── 백업에서 되살리기 ──
  // 코어 pack restore-work(본체에서) — 워크트리(미커밋 변경 · push 안 한 커밋) → 대화 기록 → 에이전트 pane(delegate.sh --resume).
  // 에이전트 pane 을 띄우니 데몬 접속 값을 넘긴다(현황판과 같은 값 + 화면 계층 studio). 결과의 athena[] 는 위 openAthenaAgent 가 잇는다
  ctx.restoreStatus = () => runPack(['restore-work', '--dry-run'], { dir: ctx.athenaDir })
  ctx.packRestore = async ({ discard = false }: { discard?: boolean } = {}): Promise<Restore> => {
    disarmRestore()
    ctx.restoreForPack = null
    if (discard) return runPack(['restore-work', '--discard'], { dir: ctx.athenaDir })
    // ATHENA_STUDIO=1 — delegate.sh 가 화면 계층 안인지(screen inside) 본다
    const extraEnv = ctx.studioEnv()
    const result = await ctx.packTask(say('pack.task.restore'), () => runPack(['restore-work'], { dir: ctx.athenaDir, onProgress: ctx.packProgress, extraEnv }))
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }
  // 지금 창의 팩에 바로(가져오기로 지금 팩을 바꾼 뒤) — 아테나 대화는 아테나 작업 공간 옆에서 잇는다
  ctx.restoreNow = async () => {
    const result = await (ctx.packRestore as NonNullable<AthenaAgentCtx['packRestore']>)()
    if (!result.ok || !(result.athena || []).length) return result
    const state = (await daemonCall('state')) as StateReply
    const existing = state.result && core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir as string)
    if (existing) await resumeAthenaBeside(existing, result.athena as { session: unknown }[])
    return result
  }
}
