// 사람에게 묻는 요청 — 코어 `athena request …` 결과를 화면 모양으로(코어 정본: athena/docs/requests.md).
// 요청은 에이전트가 사람 판단을 기다릴 때만 생긴다 — "확인 필요" 는 이것만 센다(상태 글자로 추측하지 않는다)
const LIVE = ['open', 'answered']
const KINDS = ['decision', 'question']

// `request list --json` → { supported, requests }. request 명령이 없는 옛 코어(usage · bad-output)는 supported:false — 화면은 "요청 없음" 으로
function normalizeRequests(result) {
  if (!result || result.ok !== true || !Array.isArray(result.requests)) {
    return { supported: !(result && ['usage', 'bad-output'].includes(result.error)), requests: [], error: (result && result.error) || 'bad-output' }
  }
  const requests = result.requests
    .filter((request) => request && typeof request.id === 'string' && KINDS.includes(request.kind) && LIVE.includes(request.state))
    .map((request) => ({
      id: request.id,
      kind: request.kind,
      title: String(request.title || ''),
      body: String(request.body || ''),
      options: Array.isArray(request.options) ? request.options.filter((option) => option && option.label).map((option) => ({ label: String(option.label), desc: String(option.desc || ''), recommended: option.recommended === true })) : [],
      plan: (request.links && request.links.plan) || null,
      html: (request.links && request.links.html) || null,
      pane: request.pane || null,
      state: request.state,
      rev: Number(request.rev) || 0,
      createdAt: String(request.createdAt || ''),
      answer: request.answer || null,
    }))
    // 오래 기다린 것 먼저
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return { supported: true, requests }
}

// 아직 답하지 않은 것(open) — 배지 숫자. answered(전달 전)는 목록에는 남지만 세지 않는다
function waitingCount(requests) {
  return (Array.isArray(requests) ? requests : []).filter((request) => request.state === 'open').length
}

// 기다린 시간 — 'n분' · 'n시간' · 'n일'(화면은 say 로 'n분 기다림' 문구)
function waitedLabel(createdAt, now = Date.now(), say = (key, values) => `${values.n}${{ 'work.waited.minutes': '분', 'work.waited.hours': '시간', 'work.waited.days': '일' }[key]}`) {
  const at = Date.parse(createdAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 60) return say('work.waited.minutes', { n: Math.max(1, minutes) })
  if (minutes < 24 * 60) return say('work.waited.hours', { n: Math.floor(minutes / 60) })
  return say('work.waited.days', { n: Math.floor(minutes / (24 * 60)) })
}

// 앱에서 답하기 → `request answer` 인자. 고른 것 · 덧붙인 말 · 본 rev(그사이 바뀌었으면 코어가 conflict)
function answerArgs(id, { choice = '', text = '', rev = null } = {}) {
  const argv = ['request', 'answer', String(id), '--by', 'app']
  if (String(choice).trim()) argv.push('--choice', String(choice).trim())
  if (String(text).trim()) argv.push('--text', String(text).trim())
  if (Number.isInteger(rev)) argv.push('--rev', String(rev))
  return argv
}

// pane 에 넣을 한 줄 — 에이전트는 [요청 <id>] 를 보고 ack 한다(athena/docs/requests.md "에이전트가 할 일")
function deliveryLine(request, answer) {
  const parts = [answer.choice, answer.text].map((part) => String(part || '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
  return `[요청 ${request.id}] ${request.title} — 답: ${parts.join(' · ')}`.slice(0, 2000)
}

// 지난번에 없던 open 요청 — 맥 알림은 새로 생긴 것만 한 번
function newlyOpened(knownIds, requests) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || [])
  return (Array.isArray(requests) ? requests : []).filter((request) => request.state === 'open' && !known.has(request.id))
}

module.exports = { normalizeRequests, waitingCount, waitedLabel, answerArgs, deliveryLine, newlyOpened }
