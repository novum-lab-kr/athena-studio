// 사람에게 묻는 요청 — 코어 `athena request …` 결과를 화면 모양으로(코어 정본: athena/docs/requests.md).
// 요청은 에이전트가 사람 판단을 기다릴 때만 생긴다 — "확인 필요" 는 이것만 센다(상태 글자로 추측하지 않는다)
const LIVE: readonly string[] = ['open', 'answered']
const KINDS: readonly string[] = ['decision', 'question']
// request 명령이 없는 옛 코어의 오류 코드
const OLD_CORE_ERRORS: readonly string[] = ['usage', 'bad-output']

export type RequestOption = { label: string; desc: string; recommended: boolean }

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
