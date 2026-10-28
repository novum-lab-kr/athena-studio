// ── pane [상세] · pane 목록 갱신(점 · 걸린 시간 · 브랜치) — 팩 창 ──
// main.js 에서 옮겼다(PR3e) — createPackWindow 의 ctx 에 같은 이름으로 붙인다(installPaneWatch). 데몬 요청은 ctx.daemonCall(daemon-link) 로.
// 쓰는 것(모니터 상태 — 에이전트가 도는 폴더 · 대화 기록 토큰)은 인자로 받는다
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as core from '../lib/core.mts'
import * as paneDetail from '../lib/pane-detail.mts'
import * as tokenUsage from '../lib/token-usage.mts'
import type { TokenUsage, Usage } from '../lib/token-usage.mts'
import { runGit } from './files.mts'
import { fetchBoardJson } from './board.mts'
import type { Monitor } from './monitor-logs.mts'
import type { DaemonPane, PackCtx } from './daemon-link.mts'

// screen-model 은 JS — main 과 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const screenModel: typeof import('../lib/screen-model.js') = require('../lib/screen-model.js')

// 현황판 /api/state · /api/history · /api/card — 읽는 칸만
type BoardState = { cards?: unknown; panes?: paneDetail.LeadOptions['panes'] }
type BoardHistory = { items?: unknown[] }
type BoardCard = { text?: unknown }

// monitor — 이 창의 모니터 상태(에이전트가 도는 폴더를 적는다) · paneTokens — 대화 기록 토큰(창 사이에 같이 쓴다)
export function installPaneWatch(ctx: PackCtx, { monitor, paneTokens }: { monitor: Monitor; paneTokens: TokenUsage }): void {
  const send = ctx.send
  const daemonCall = ctx.daemonCall
  let branchCache: { at: number; value: Record<string, string | null> | null } = { at: 0, value: null }

  // ── pane [상세] ─────────────────────────────────────────────────────
  // 지금 상태가 된 시각(걸린 시간) — pane 목록을 볼 때마다 상태가 바뀐 pane 만 고친다
  const paneSince = new Map<string, { status: unknown; at: number }>() // pane id → { status, at }
  const trackPaneSince = (panes: DaemonPane[]) => {
    const alive = new Set()
    for (const pane of panes) {
      alive.add(pane.id)
      const status = pane.agent ? pane.agent_status : null
      const known = paneSince.get(pane.id)
      if (!known || known.status !== status) paneSince.set(pane.id, { status, at: Date.now() })
    }
    for (const id of paneSince.keys()) if (!alive.has(id)) paneSince.delete(id)
  }
  // 계획서에 묶인 pane(머리 줄 [상세] 아이콘) — 현황판이 떠 있을 때만 읽는다(띄우지는 않는다). 꺼졌으면 지난 값을 둔다
  const PANE_BOUND_MS = 5000
  let paneBound = {}
  let paneBoundAt = 0
  const refreshPaneBound = async () => {
    const state = (await fetchBoardJson(ctx.boardPortNow(), '/api/state')) as BoardState | null
    if (!state || !Array.isArray(state.cards)) return
    const next = paneDetail.bindings(state.cards, state.panes)
    if (JSON.stringify(next) === JSON.stringify(paneBound)) return
    paneBound = next
    send('screen:pane-bound', paneBound)
  }
  ctx.paneBound = () => paneBound
  // 아카이브 목록은 무겁다(보관 폴더를 다 읽는다) — 아테나 pane 상세가 열려 있어도 30초에 한 번만
  const HISTORY_CACHE_MS = 30000
  let historyCache: { at: number; items: unknown[] } = { at: 0, items: [] }
  const recentHistory = async () => {
    if (Date.now() - historyCache.at < HISTORY_CACHE_MS) return historyCache.items
    const history = (await fetchBoardJson(ctx.boardPortNow(), '/api/history')) as BoardHistory | null
    historyCache = { at: Date.now(), items: history && Array.isArray(history.items) ? history.items : historyCache.items }
    return historyCache.items
  }
  // 상세 토큰 — 대화 기록 usage 합계(파일만 읽음 · 파일마다 늘어난 부분만 · 기다리지 않고 아는 값). 기록을 못 찾으면 null → 화면에서 숨긴다
  const tokenView = (sum: Usage | null) => (sum && sum.io + sum.cache > 0 ? { io: sum.io, cache: sum.cache, ioText: tokenUsage.formatTokens(sum.io), cacheText: tokenUsage.formatTokens(sum.cache) } : null)
  // 아테나 pane 의 지금 대화 — 훅 pane-session.py 가 적는 <팩 데이터>/state/pane-sessions/<pane>.json 의 session
  const paneSession = async (paneId: string) => {
    if (!ctx.athenaDir) return ''
    const record: { session?: unknown } | null = await fs.promises.readFile(path.join(core.realDir(path.join(ctx.athenaDir, '.pack-data')), 'state', 'pane-sessions', `${paneId.split(':').pop()}.json`), 'utf8').then(JSON.parse).catch(() => null)
    return record && typeof record.session === 'string' ? record.session : ''
  }
  // 상세 한 번 — 에이전트 pane 이면 그 계획서의 지금 · 결과 · 내가 할 일 · PR · 기록, 아테나 pane 이면 맡긴 일 목록.
  // 재료: 현황판 /api/state · /api/card(계획서 원문) · pane 화면 글(pane read) · 열린 요청. 요약용 모델은 부르지 않는다
  ctx.paneDetail = async (paneId: string) => {
    if (!/^[\w:]+$/.test(paneId)) return { ok: false, error: 'bad-id' }
    const port = ctx.boardPortNow()
    const state = (await fetchBoardJson(port, '/api/state')) as BoardState | null
    if (!state || !Array.isArray(state.cards)) return { ok: false, error: 'board-down' }
    const listed = await daemonCall<{ panes?: unknown }>('pane list')
    const panes = listed.result && Array.isArray(listed.result.panes) ? (listed.result.panes as DaemonPane[]) : []
    const pane = panes.find((entry) => entry.id === paneId)
    if (!pane) return { ok: false, error: 'no-pane' }
    const label = pane.label || pane.name || pane.title || paneId
    const open = ctx.requestsNow().requests.filter((request) => request.state === 'open')
    const since = Object.fromEntries([...paneSince].map(([id, entry]) => [id, entry.at]))
    const plan = paneDetail.agentPlan(state.cards, paneId) as (paneDetail.DetailPlan & { html?: string; created?: unknown }) | null
    if (!plan) {
      const status = Object.fromEntries(panes.map((entry) => [entry.id, entry.agent ? entry.agent_status : null]))
      const rows = paneDetail.leadRows(state.cards, await recentHistory(), paneId, { panes: state.panes || [], since, status, waitingPlans: new Set(open.map((request) => request.plan).filter(Boolean)), now: Date.now() })
      return { ok: true, mode: 'lead', paneId, label, rows, tokens: tokenView(paneTokens.peekSession(await paneSession(paneId))) }
    }
    const [visible, recent, card] = await Promise.all([
      daemonCall<{ text?: unknown }>('pane read', { pane: paneId, lines: 40, source: 'visible' }),
      daemonCall<{ text?: unknown }>('pane read', { pane: paneId, lines: 400, source: 'recent' }),
      fetchBoardJson(port, `/api/card?id=${encodeURIComponent(plan.id as string)}`) as Promise<BoardCard | null>,
    ])
    const visibleText = visible.result && typeof visible.result.text === 'string' ? visible.result.text : ''
    const digest = paneDetail.screenDigest(recent.result && typeof recent.result.text === 'string' ? recent.result.text : '')
    const record = paneDetail.planRecord(card && typeof card.text === 'string' ? card.text : '')
    const waiting = screenModel.waitingForInput(visibleText)
    const todo = open.filter((request) => request.plan === plan.id || request.pane === paneId).map((request) => ({ id: request.id, kind: request.kind, title: request.title }))
    const now = paneDetail.nowState({
      agentStatus: pane.agent ? pane.agent_status : null,
      waiting,
      heavy: digest.heavy,
      hasRequest: todo.length > 0,
      planStatus: record.status || plan.status,
    })
    const known = paneSince.get(paneId)
    return {
      ok: true,
      mode: 'agent',
      paneId,
      label,
      now: { ...now, sinceMs: known ? Date.now() - known.at : 0, line: digest.now },
      report: digest.report,
      todo,
      // 이 계획서에 묶인 대화 기록 전부(작업 · 리뷰 세션) — 계획서 → 기록 찾기는 코어 learn-review.mjs findTranscripts 와 같은 규칙
      tokens: tokenView(paneTokens.peekPlan([ctx.athenaDir, core.realDir(ctx.athenaDir as string)], plan.id)),
      plan: paneDetail.detailPlan(plan, record, Boolean(card)),
    }
  }

  // 보일 때만(startPanesPolling 이 2초마다 부른다) pane 목록(에이전트가 도는 폴더 → 모니터)과 작업 공간 브랜치를 갱신한다
  ctx.pollPanes = async () => {
    if (!ctx.win || ctx.win.isDestroyed() || !ctx.win.isVisible() || ctx.win.isMinimized() || !ctx.isAttached()) return
    const listed = await daemonCall<{ panes: DaemonPane[] }>('pane list')
    if (listed.result) {
      monitor.agentCwds = listed.result.panes.filter((pane) => pane.agent).map((pane) => pane.foreground_cwd || pane.cwd).filter((dir): dir is string => Boolean(dir))
      // spaces pane 줄 앞 점 — 에이전트가 없는 pane 은 null
      send('screen:pane-status', Object.fromEntries(listed.result.panes.map((pane) => [pane.id, pane.agent ? pane.agent_status : null])))
      trackPaneSince(listed.result.panes)
    }
    if (Date.now() - paneBoundAt > PANE_BOUND_MS) {
      paneBoundAt = Date.now()
      refreshPaneBound().catch(() => {})
    }
    const branches = await workspaceBranches()
    if (branches) send('screen:branches', branches)
    ctx.catchUpBody(listed.result ? listed.result.panes : null).catch(() => {})
  }

  // 작업 공간마다 git 브랜치(이름 아래에) — 5초에 한 번만 묻는다
  async function workspaceBranches() {
    if (branchCache.value && Date.now() - branchCache.at < 5000) return branchCache.value
    const state = await daemonCall<{ workspaces: { id: string; cwd: string }[] }>('state')
    if (!state.result) return null
    const pairs = await Promise.all(
      state.result.workspaces.map(async (workspace) => {
        const branch = await runGit(workspace.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
        return [workspace.id, branch ? branch.trim() : null] as const
      }),
    )
    branchCache = { at: Date.now(), value: Object.fromEntries(pairs) }
    return branchCache.value
  }
  // 팩을 바꿨다(rebindBody) — 새 본체 작업 공간 브랜치를 다음 poll 에서 바로 다시 묻는다
  ctx.resetBranches = () => {
    branchCache = { at: 0, value: null }
  }
}
