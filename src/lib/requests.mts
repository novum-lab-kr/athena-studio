// 사람에게 묻는 요청 — 코어 `athena request …` 결과를 화면 모양으로(코어 정본: athena/docs/requests.md).
// 요청은 에이전트가 사람 판단을 기다릴 때만 생긴다 — "확인 필요" 는 이것만 센다(상태 글자로 추측하지 않는다)
const LIVE: readonly string[] = ['open', 'answered']
const KINDS: readonly string[] = ['decision', 'question']
// request 명령이 없는 옛 코어의 오류 코드
const OLD_CORE_ERRORS: readonly string[] = ['usage', 'bad-output']

export type RequestOption = { label: string; desc: string; recommended: boolean }
export type PermissionKind = 'browser' | 'trust' | 'permission'

// 화면 모양 — 코어 출력에서 그대로 옮기는 칸(plan · html · pane · answer)은 모양을 검사하지 않는다(unknown)
export type StudioRequest = {
  id: string
  kind: string
  title: string
  body: string
  options: RequestOption[]
  plan: unknown
  html: unknown
  pane: unknown
  // 허락 창 알림인지 — 코어 허락 훅이 여는 요청(키 perm:<pane> · athena/scripts/lib/pane_request.py watch_permission)
  permission: boolean
  permissionKind?: PermissionKind
  codexApproval?: { token: string; generation: string; thread: string; choices: { key: string; label?: string; description?: string; detail?: unknown }[] }
  state: string
  rev: number
  createdAt: string
  answer: unknown
}

export type NormalizedRequests = { supported: boolean; requests: StudioRequest[]; error?: unknown }

// 답 문구 — 화면은 say(key, { n }) 로 'n분 기다림'
export type Say = (key: string, values: { n: number }) => string

// 코어 JSON 의 객체 하나(모양은 칸마다 따로 본다)
type Loose = Record<string, unknown>

function isLoose(value: unknown): value is Loose {
  return Boolean(value) && typeof value === 'object'
}

// `request list --json` → { supported, requests }. request 명령이 없는 옛 코어(usage · bad-output)는 supported:false — 화면은 "요청 없음" 으로
export function normalizeRequests(result: unknown): NormalizedRequests {
  const record = isLoose(result) ? result : null
  if (!record || record.ok !== true || !Array.isArray(record.requests)) {
    const error = record ? record.error : undefined
    return { supported: !(typeof error === 'string' && OLD_CORE_ERRORS.includes(error)), requests: [], error: error || 'bad-output' }
  }
  const items: unknown[] = record.requests
  const requests = items
    .filter((request): request is Loose & { id: string; kind: string; state: string } =>
      isLoose(request) && typeof request.id === 'string' && typeof request.kind === 'string' && KINDS.includes(request.kind) && typeof request.state === 'string' && LIVE.includes(request.state))
    .map((request): StudioRequest => {
      const options: unknown[] = Array.isArray(request.options) ? request.options : []
      const links = isLoose(request.links) ? request.links : null
      return {
        id: request.id,
        kind: request.kind,
        title: String(request.title || ''),
        body: String(request.body || ''),
        options: options.filter((option): option is Loose => isLoose(option) && Boolean(option.label)).map((option) => ({ label: String(option.label), desc: String(option.desc || ''), recommended: option.recommended === true })),
        plan: (links && links.plan) || null,
        html: (links && links.html) || null,
        pane: request.pane || null,
        permission: typeof request.dedupeKey === 'string' && request.dedupeKey.startsWith('perm:'),
        state: request.state,
        rev: Number(request.rev) || 0,
        createdAt: String(request.createdAt || ''),
        answer: request.answer || null,
      }
    })
    // 오래 기다린 것 먼저
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return { supported: true, requests }
}

// 아직 답하지 않은 것(open) — 배지 숫자. answered(전달 전)는 목록에는 남지만 세지 않는다
export function waitingCount(requests: readonly { state: unknown }[] | null | undefined): number {
  return (Array.isArray(requests) ? requests : []).filter((request) => request.state === 'open').length
}

const WAITED_UNITS: Readonly<Record<string, string>> = { 'work.waited.minutes': '분', 'work.waited.hours': '시간', 'work.waited.days': '일' }

// 기다린 시간 — 'n분' · 'n시간' · 'n일'(화면은 say 로 'n분 기다림' 문구)
export function waitedLabel(createdAt: string, now: number = Date.now(), say: Say = (key, values) => `${values.n}${WAITED_UNITS[key]}`): string {
  const at = Date.parse(createdAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 60) return say('work.waited.minutes', { n: Math.max(1, minutes) })
  if (minutes < 24 * 60) return say('work.waited.hours', { n: Math.floor(minutes / 60) })
  return say('work.waited.days', { n: Math.floor(minutes / (24 * 60)) })
}

// 앱에서 답하기 → `request answer` 인자. 고른 것 · 덧붙인 말 · 본 rev(그사이 바뀌었으면 코어가 conflict)
export function answerArgs(id: unknown, { choice = '', text = '', rev = null }: { choice?: unknown; text?: unknown; rev?: unknown } = {}): string[] {
  const argv = ['request', 'answer', String(id), '--by', 'app']
  if (String(choice).trim()) argv.push('--choice', String(choice).trim())
  if (String(text).trim()) argv.push('--text', String(text).trim())
  if (Number.isInteger(rev)) argv.push('--rev', String(rev))
  return argv
}

// 대화상자가 보여 준 rev 와 지금 rev 가 다른가 — rev 를 안 보낸 호출(정수가 아님)은 비교하지 않는다
export function answerRevChanged(shownRev: unknown, currentRev: number): boolean {
  return Number.isInteger(shownRev) && shownRev !== currentRev
}

// pane 에 넣을 한 줄 — 에이전트는 [요청 <id>] 를 보고 ack 한다(athena/docs/requests.md "에이전트가 할 일")
export function deliveryLine(request: { id: string; title: string }, answer: { choice?: unknown; text?: unknown }): string {
  const parts = [answer.choice, answer.text].map((part) => String(part || '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
  return `[요청 ${request.id}] ${request.title} — 답: ${parts.join(' · ')}`.slice(0, 2000)
}

// 지난번에 없던 open 요청 — 맥 알림은 새로 생긴 것만 한 번
export function newlyOpened<T extends { id: unknown; state: unknown }>(knownIds: Iterable<unknown> | null | undefined, requests: readonly T[] | null | undefined): T[] {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || [])
  return (Array.isArray(requests) ? requests : []).filter((request) => request.state === 'open' && !known.has(request.id))
}

// 화면 원문·명령은 저장하지 않는다. 알림만 다루며 응답 권한이나 키 바인딩은 갖지 않는다.
// 같은 종류를 3초 이상 두 번 확인한 뒤 표시하고, 닫힌 읽기가 2회 이어질 때까지 다시 그리기를 기다린다.
export function createPermissionTracker() {
  const prompts = new Map<string, { kind: PermissionKind; since: number; misses: number; seen: number }>()
  const closedReads = new Map<string, number>()
  return {
    reset() { prompts.clear(); closedReads.clear() },
    observe(observations: { pane: string; kind: PermissionKind | null | undefined }[], now: number) {
      const alive = new Set(observations.map((item) => item.pane))
      for (const pane of prompts.keys()) if (!alive.has(pane)) prompts.delete(pane)
      for (const pane of closedReads.keys()) if (!alive.has(pane)) closedReads.delete(pane)
      for (const { pane, kind } of observations) {
        if (kind === undefined) {
          closedReads.delete(pane) // 읽기 실패는 닫힘의 근거가 아니며 연속 읽기도 끊는다
          const before = prompts.get(pane)
          if (before) before.misses = 0
          continue
        }
        const before = prompts.get(pane)
        if (kind) {
          closedReads.delete(pane)
          if (!before || before.kind !== kind) prompts.set(pane, { kind, since: now, misses: 0, seen: 1 })
          else { before.misses = 0; before.seen += 1 }
        } else {
          closedReads.set(pane, (closedReads.get(pane) || 0) + 1)
          if (before && ++before.misses >= 2) prompts.delete(pane)
        }
      }
      const requests: StudioRequest[] = []
      for (const [pane, prompt] of prompts) {
        if (now - prompt.since < 3000 || prompt.seen < 2) continue
        requests.push({ id: `permission-pane:${pane}:${prompt.since}`, kind: 'question', title: '', body: '', options: [], plan: null, html: null, pane,
          permission: true, permissionKind: prompt.kind, state: 'open', rev: 1, createdAt: new Date(prompt.since).toISOString(), answer: null })
      }
      return { requests, closed: new Set([...closedReads].filter(([, count]) => count >= 2).map(([pane]) => pane)), alive }
    },
  }
}

// 옛 코어 알림도 같은 안전한 표시로 맞춘다. 도구 입력·화면 원문을 표시나 로그로 복사하지 않는다.
export function permissionView(request: StudioRequest, say: (key: string, values?: Record<string, unknown>) => string): StudioRequest {
  if (!request.permission || request.codexApproval) return request
  const kind = request.permissionKind || 'permission'
  return { ...request, title: say(`work.permission.title.${kind}`, { pane: String(request.pane || '') }),
    body: `${say(`work.permission.body.${kind}`)}\n\n${say('work.permission.unavailable')}`, options: [], answer: null }
}

// Codex app-server 승인 · 질문(src/lib/codex-approvals.mts)을 화면 요청으로. 제목은 맥 알림 · 트레이 · [작업] 목록이 그대로 쓰므로
// 명령 · 경로 원문을 넣지 않는다 — 승인은 Claude 허락과 같은 가린 제목, 질문은 코어 질문(Claude AskUserQuestion)과 같은 질문 글.
// 무엇을 허락하는지는 승인 대화상자(src/renderer/detail.ts)가 body 로 보여 준다
type ApprovalLike = { token: string; generation: string; pane: string; method: string; params: Record<string, unknown>; receivedAtMs?: number; item?: unknown; choices: NonNullable<StudioRequest['codexApproval']>['choices'] }
const APPROVAL_BODY_SKIP: readonly string[] = ['threadId', 'turnId', 'itemId', 'approvalId', 'startedAtMs', 'reason', 'message', 'command', 'cwd', 'availableDecisions', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'questions', 'isBlocking', 'autoResolutionMs']

function questionTexts(params: Record<string, unknown>): string[] {
  const questions: unknown[] = Array.isArray(params.questions) ? params.questions : []
  return questions.map((question) => isLoose(question) && 'question' in question ? String(question.question) : '')
}

export function codexApprovalRequest(approval: ApprovalLike, say: (key: string, values?: Record<string, unknown>) => string, now: number): StudioRequest {
  const { params } = approval
  const firstQuestion = (questionTexts(params)[0] || '').trim()
  const asking = approval.method === 'item/tool/requestUserInput' && firstQuestion
  const extra = JSON.stringify(Object.fromEntries(Object.entries(params).filter(([key]) => !APPROVAL_BODY_SKIP.includes(key))), null, 2)
  return {
    id: `codex-approval:${approval.token}`, kind: 'question', permission: true, pane: approval.pane,
    title: asking ? firstQuestion : say('work.permission.title.permission', { pane: approval.pane }),
    body: [params.reason, params.message, params.command, params.cwd, ...questionTexts(params), extra, approval.item && JSON.stringify(approval.item, null, 2)]
      .filter((value) => typeof value === 'string' && value !== '{}').join('\n\n'),
    options: [], plan: null, html: null, state: 'open', rev: 1,
    createdAt: new Date(typeof params.startedAtMs === 'number' ? params.startedAtMs : approval.receivedAtMs ?? now).toISOString(), answer: null,
    codexApproval: { token: approval.token, generation: approval.generation, thread: String(params.threadId), choices: approval.choices },
  }
}

// Codex 도 PermissionRequest 훅(permission-to-request.py)을 불러 같은 건의 코어 perm:<pane> 요청이 몇 초 뒤 열리고(GRACE 4초),
// 메뉴가 사라진 뒤 두 번 읽어야 닫힌다(POLL 2초 · pane_request.py). 그 사이의 화면 감지 요청도 같은 건이다
export const CODEX_PAIR_SLACK_MS = 10_000

// 화면에 보일 요청 — Codex 승인(app-server)이 정본이고 같은 건의 코어 허락 요청 · 화면 감지 요청은 숨긴다.
// seen 은 pane 마다 Codex 승인이 마지막으로 떠 있던 때 — 답해서 승인이 사라진 뒤에도 그때까지 생긴 허락 요청은 같은 건으로 본다(검수 #13)
export function mergeRequests(input: { core: StudioRequest[]; tracker: StudioRequest[]; approvals: ApprovalLike[]; seen: Map<string, number>; now: number; say: (key: string, values?: Record<string, unknown>) => string }): StudioRequest[] {
  const { core, tracker, approvals, seen, now, say } = input
  for (const approval of approvals) seen.set(approval.pane, now)
  const livePanes = new Set(approvals.map((approval) => approval.pane))
  const sameCase = (request: StudioRequest) => {
    const pane = String(request.pane || '')
    if (livePanes.has(pane)) return true
    const last = seen.get(pane)
    return last !== undefined && Date.parse(request.createdAt) <= last + CODEX_PAIR_SLACK_MS
  }
  const hidden = new Set<string>()
  const visibleCore: StudioRequest[] = []
  const visibleTracker: StudioRequest[] = []
  for (const request of core) {
    if (request.permission && sameCase(request)) hidden.add(String(request.pane))
    else visibleCore.push(request)
  }
  for (const request of tracker) {
    if (sameCase(request)) hidden.add(String(request.pane))
    else visibleTracker.push(request)
  }
  // 승인이 없고 숨길 것도 남지 않은 pane 은 잊는다 — 그 뒤의 새 허락은 그대로 보인다
  for (const pane of [...seen.keys()]) if (!livePanes.has(pane) && !hidden.has(pane)) seen.delete(pane)
  // Codex request_user_input 은 훅(ask-to-request.py → 코어 질문)과 app-server 로 두 번 온다 — 같은 pane 같은 질문이 코어에 있으면 코어 쪽만(검수 #15)
  const coreQuestions = new Set(core.filter((request) => !request.permission).map((request) => `${request.pane}\n${request.title}`))
  const codex = approvals.map((approval) => codexApprovalRequest(approval, say, now))
    .filter((request, index) => approvals[index]?.method !== 'item/tool/requestUserInput' || !coreQuestions.has(`${request.pane}\n${request.title}`))
  const notified = new Set(visibleCore.filter((request) => request.permission).map((request) => request.pane))
  const kinds = new Map(tracker.map((request) => [request.pane, request.permissionKind]))
  return [...codex,
    ...visibleCore.map((request) => request.permission ? { ...request, permissionKind: kinds.get(request.pane) || request.permissionKind } : request),
    ...visibleTracker.filter((request) => !notified.has(request.pane))]
}
