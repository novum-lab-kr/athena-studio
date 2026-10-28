// [작업] 팝업 — 현황판 서버 `/api/state` 의 카드(계획서 · 이슈)를 목록으로, `/api/card` 의 계획서 원문을 상세로.
// 칸반 칸 대신 "진행 중 · 최근 끝난 것" 두 묶음과 한 줄 요약만 — 자세한 건 계획서 · pane 으로 간다
const RECENT_DONE_MS = 24 * 3600000
const RECENT_DONE_MAX = 5

// 현황판 카드에서 여기서 읽는 칸만(main 이 /api/state 를 그대로 넘긴다 — 모양은 검사하지 않는다)
export type BoardCard = {
  id?: string
  kind?: string
  archived?: boolean
  title?: string
  status?: string
  column?: string
  working?: boolean
  blocked?: string
  statusNote?: string
  next?: string
  progress?: { checked: number; total: number }
  grade?: string
  scope?: string
  html?: string | null
  agents?: unknown
  mtime?: unknown
  doneAt?: unknown
  linkedPlan?: BoardCard
}
type PlanCard = BoardCard & { planId?: string }
// 사람에게 묻는 요청 — plan 이 있는 것만 본다
type WaitingRequest = { plan?: unknown }

export type WorkState = 'wait' | 'work' | 'blocked' | 'idle' | 'done'
export type WorkItem = {
  id: string | undefined
  title: string
  line: string
  state: WorkState
  grade: 'formal' | 'light'
  maintenance: boolean
  html: string | null
  agents: unknown[]
  mtime: number
  doneAt: number
}

// 카드 → 계획서 모양 하나로. 이슈에 붙은 계획서(linkedPlan)는 그 계획서 기준으로 본다
function planOf(card: BoardCard | null | undefined): PlanCard | null {
  if (!card || card.archived) return null
  if (card.kind === 'plan') return { ...card, planId: card.id }
  if (card.kind === 'issue' && card.linkedPlan) return { ...card.linkedPlan, title: card.title, planId: card.linkedPlan.id, html: card.linkedPlan.html || null, column: card.column }
  return null
}

// 지금 상태 — 답을 기다림(그 계획서에 열린 요청) · 일하는 중 · 막힘 · 쉬는 중 · 완료
function stateOf(plan: PlanCard, waitingPlans: ReadonlySet<unknown>): WorkState {
  if (plan.status === 'done' || plan.column === 'done') return 'done'
  if (waitingPlans.has(plan.planId)) return 'wait'
  if (plan.working) return 'work'
  if (plan.status === 'blocked') return 'blocked'
  return 'idle'
}

// 한 줄 — 막힌 이유 → 상태 메모 → 다음 → 진행률 순으로 있는 것
function lineOf(plan: PlanCard): string {
  if (plan.status === 'blocked' && plan.blocked) return plan.blocked
  const progress = plan.progress && plan.progress.total ? `${plan.progress.checked}/${plan.progress.total}` : ''
  const text = plan.statusNote || plan.next || ''
  return [text, progress].filter(Boolean).join(' · ')
}

// cards(/api/state) + 열린 요청 → { doing, done, counts }. 서비스 · 정비 구분 없이 한 목록(정비는 표시만)
export function workList(cards: unknown, requests: unknown = [], now: number = Date.now()): { doing: WorkItem[]; done: WorkItem[]; counts: { doing: number } } {
  const requestList: WaitingRequest[] = Array.isArray(requests) ? requests : []
  const waitingPlans = new Set(requestList.filter((request) => request.plan).map((request) => request.plan))
  const cardList: (BoardCard | null | undefined)[] = Array.isArray(cards) ? cards : []
  const plans = cardList.map(planOf).filter((plan): plan is PlanCard => Boolean(plan))
  const items = plans.map((plan): WorkItem => ({
    id: plan.planId,
    title: String(plan.title || plan.planId),
    line: lineOf(plan),
    state: stateOf(plan, waitingPlans),
    grade: plan.grade === 'formal' ? 'formal' : 'light',
    maintenance: plan.scope === 'hermes',
    html: plan.html || null,
    agents: Array.isArray(plan.agents) ? plan.agents : [],
    mtime: Number(plan.mtime) || 0,
    // 완료로 바뀐 시각(현황판 사건 기록) — 없으면(기록 전에 끝난 것) 파일을 마지막으로 고친 시각
    doneAt: Number(plan.doneAt) || Number(plan.mtime) || 0,
  }))
  // done 은 진행 중 묶음에 들지 않는다 — 칸을 채워 두는 것뿐
  const rank: Record<WorkState, number> = { wait: 0, blocked: 1, work: 2, idle: 3, done: 4 }
  const doing = items.filter((item) => item.state !== 'done').sort((left, right) => rank[left.state] - rank[right.state] || right.mtime - left.mtime)
  const done = items.filter((item) => item.state === 'done' && now - item.doneAt < RECENT_DONE_MS).sort((left, right) => right.doneAt - left.doneAt).slice(0, RECENT_DONE_MAX)
  return { doing, done, counts: { doing: doing.length } }
}

// ── 상세 — 계획서 md 에서 몇 줄만 ────────────────────────────────────────
const plain = (value: unknown): string => String(value || '').replace(/\*\*/g, '').replace(/`/g, '').trim()
function section(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^#{2,3}\\s*${heading}\\s*$`).test(line.trim()))
  if (start < 0) return []
  // 찾은 줄은 #{2,3} 로 시작한다
  const depth = (lines[start] ?? '').trim().match(/^#+/)?.[0].length ?? 0
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const head = line.match(/^(#+)\s/)
    if (head && (head[1] ?? '').length <= depth) break
    body.push(line)
  }
  return body
}
const bullets = (lines: readonly string[]): string[] => lines.map((line) => line.trim()).filter((line) => /^(-|\d+\.)\s+/.test(line)).map((line) => plain(line.replace(/^(-|\d+\.)\s+(\[[ xX]\]\s+)?/, '')))
const field = (text: string, name: string): string => plain((text.match(new RegExp(`^\\s*-\\s*${name}:\\s*(.+)$`, 'm')) || [])[1] || '')
const isNone = (value: string): boolean => !value || /^(없음|\(확정 전\)|아직 없음|none)/i.test(value)

export type PlanDetail = {
  why: string
  decided: string[]
  progress: { checked: number; total: number; now: string }
  validation: string
  results: string[]
  next: string
  blocked: string
}

// 계획서 원문 → { why, decided, progress: { checked, total, now }, validation, results, next, blocked }
export function planDetail(text: unknown): PlanDetail {
  const source = String(text || '')
  // 왜 — 개요의 "요청 사항:" 줄, 없으면 제목 아래 첫 문단(Checkpoint 전)
  let why = field(source, '요청 사항')
  if (!why) {
    const intro = (source.split(/^## /m)[0] ?? '').split('\n').slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith('>') && !line.startsWith('#'))
    why = plain(intro[0] || '')
  }
  const progressLines = section(source, 'Progress').map((line) => line.trim()).filter((line) => /^-\s+\[[ xX]\]/.test(line))
  const checked = progressLines.filter((line) => /^-\s+\[[xX]\]/.test(line)).length
  const current = progressLines.find((line) => /^-\s+\[ \]/.test(line))
  const decided = bullets(section(source, 'Decisions')).filter((line) => !isNone(line))
  const validation = bullets(section(source, 'Validation')).filter((line) => !isNone(line))
  const blocked = bullets(section(source, 'Blocked')).filter((line) => !isNone(line))
  const results = [...source.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)].map((match) => match[0]).filter((url, index, all) => all.indexOf(url) === index)
  return {
    why,
    decided,
    progress: { checked, total: progressLines.length, now: current ? plain(current.replace(/^-\s+\[ \]\s+/, '')) : '' },
    validation: validation[0] || '',
    results,
    next: bullets(section(source, 'Next'))[0] || '',
    blocked: blocked[0] || '',
  }
}
