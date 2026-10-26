// pane [상세] — 일감 `/api/state` 카드 · pane 화면 글 · 계획서 원문으로 "지금 · 결과 · 내가 할 일 · PR · 기록"을 만든다.
// 요약을 위해 모델을 부르지 않는다 — 화면에 이미 있는 글과 계획서 줄만 고른다. Electron 없이 돌아 `npm test` 로 검사한다
const REPORT_MAX_LINES = 30
const LINE_MAX = 160

const plain = (value) => String(value || '').replace(/\*\*/g, '').replace(/`/g, '').trim()
const clip = (value, max = LINE_MAX) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

// 계획서 · 결정 콘솔에 적힌 pane id 가 이 pane 인가 — 옛 화면 id(w2:p33)는 끝 부분으로 맞춘다
function samePane(value, paneId) {
  if (!value || !paneId) return false
  const text = String(value)
  return text === paneId || text.endsWith(`:${paneId}`)
}
const paneKey = (value) => String(value).split(':').pop()

// 카드 → 계획서 모양 하나로. 이슈에 붙은 계획서(linkedPlan)는 이슈 제목으로
function planCards(cards) {
  const plans = []
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.archived) continue
    if (card.kind === 'plan') plans.push({ ...card, agents: Array.isArray(card.agents) ? card.agents : [] })
    else if (card.kind === 'issue' && card.linkedPlan) {
      const linked = card.linkedPlan
      plans.push({ ...linked, title: card.title, statusNote: '', agents: Array.isArray(linked.agents) ? linked.agents : [], issue: card.id })
    }
  }
  return plans
}

// pane id → 'agent'(그 계획서를 하는 에이전트 pane) | 'lead'(그 계획서를 맡긴 아테나 pane). 둘 다면 agent
function bindings(cards) {
  const result = {}
  for (const plan of planCards(cards)) {
    for (const paneId of plan.agents) result[paneId] = 'agent'
    if (plan.leadPane) {
      const key = paneKey(plan.leadPane)
      if (!result[key]) result[key] = 'lead'
    }
  }
  return result
}

// 에이전트 pane 이 하는 계획서 — 끝나지 않은 것, 그다음 최근에 고친 것
function agentPlan(cards, paneId) {
  const mine = planCards(cards).filter((plan) => plan.agents.includes(paneId))
  mine.sort((left, right) => Number(left.status === 'done') - Number(right.status === 'done') || (Number(right.mtime) || 0) - (Number(left.mtime) || 0))
  return mine[0] || null
}

const sameDay = (left, right) => new Date(left).toDateString() === new Date(right).toDateString()
// 보관 시각(일감 archive.mjs — 'YYYY-MM-DD HH:MM' 서울 시각) → ms
const archivedMs = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00`) : 0
}

// 아테나 pane 이 맡긴 일 — 계획서마다 한 줄: 나를 기다림(wait) · 지금(now) · 끝남(done — 오늘 끝난 것과 오늘 보관한 것)
// panes: 일감 /api/state panes(에이전트 이름) · since: pane id → 지금 상태가 된 시각(ms) · waitingPlans: 열린 요청이 있는 계획서 id
function leadRows(cards, history, paneId, { panes = [], since = {}, status = {}, waitingPlans = new Set(), now = Date.now() } = {}) {
  const rows = []
  const seen = new Set()
  for (const plan of planCards(cards)) {
    if (!samePane(plan.leadPane, paneId) || seen.has(plan.id)) continue
    seen.add(plan.id)
    const agentPane = plan.agents.map((id) => panes.find((pane) => pane.id === id)).find(Boolean) || null
    const row = { id: plan.id, title: String(plan.title || plan.id), paneId: agentPane ? agentPane.id : null, who: agentPane ? agentPane.agent : '', what: plain(plan.statusNote || plan.next || ''), sinceMs: 0, state: 'now' }
    if (plan.status === 'done') {
      if (!sameDay(Number(plan.doneAt) || Number(plan.mtime) || 0, now)) continue
      row.state = 'done'
    } else if (waitingPlans.has(plan.id) || plan.status === 'blocked' || (agentPane && status[agentPane.id] === 'waiting')) {
      row.state = 'wait'
      if (plan.status === 'blocked' && plan.blocked) row.what = plain(plan.blocked)
    }
    if (agentPane && since[agentPane.id]) row.sinceMs = now - since[agentPane.id]
    rows.push(row)
  }
  for (const item of Array.isArray(history) ? history : []) {
    if (!item || !samePane(item.leadPane, paneId)) continue
    const at = archivedMs(item.archivedAt)
    if (!at || !sameDay(at, now)) continue
    rows.push({ id: item.dir, title: String(item.title || item.dir), paneId: null, who: '', what: plain(item.summary || ''), sinceMs: 0, state: 'done', archived: true })
  }
  const rank = { wait: 0, now: 1, done: 2 }
  return rows.sort((left, right) => rank[left.state] - rank[right.state])
}

// ── 화면 글 → 지금 하는 일 한 줄 · 최근 보고 ─────────────────────────────
// Claude Code 화면: 에이전트의 말과 도구는 '⏺ ' 로 시작하고, 말의 둘째 줄부터는 두 칸 들여 쓴다.
// 도구 줄은 '⏺ Bash(…)' · '⏺ User answered …' 모양, 접힌 도구는 '  Ran 2 shell commands' 같은 한 줄이다.
// 다른 도구(codex 등)는 모양을 모르니 비워 둔다(지금 상태 · 계획서 기록은 그대로 보인다)
const TOOL_BLOCK = /^⏺ ([A-Za-z][\w-]*\(|User answered\b)/
const COLLAPSED_TOOL = /^(Ran|Read|Made|Searched for|Listed|Wrote|Edited|Updated|Found|Fetched) \d+\b/
const HEAVY_WAIT = /⏳ 대기 \d+초/

function sayBlocks(lines) {
  const blocks = []
  let current = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.startsWith('⏺ ')) {
      current = TOOL_BLOCK.test(line) ? null : [line.slice(2)]
      if (current) blocks.push(current)
      continue
    }
    if (!current) continue
    // 첫 칸에 글자가 오면(입력 줄 ❯ · 상태 줄 ✻ · 구분선) 말이 끝났다
    if (line && !/^\s/.test(line)) {
      current = null
      continue
    }
    const text = line.replace(/^ {2}/, '')
    if (COLLAPSED_TOOL.test(text.trim())) continue
    current.push(text)
  }
  return blocks.map((block) => {
    const trimmed = [...block]
    while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop()
    return trimmed
  })
}

function screenDigest(text) {
  const lines = String(text || '').split('\n')
  const blocks = sayBlocks(lines)
  const last = blocks[blocks.length - 1] || []
  const first = last.find((line) => line.trim()) || ''
  // 최근 보고 — 가장 최근의 여러 줄짜리 말(마지막 말이 '돌리는 중입니다' 같은 한 줄이어도 앞의 보고를 보여 준다)
  const report = [...blocks].reverse().find((block) => block.filter((line) => line.trim()).length >= 2) || []
  return {
    now: clip(plain(first)),
    report: report.slice(0, REPORT_MAX_LINES).map((line) => plain(line)),
    heavy: lines.slice(-30).some((line) => HEAVY_WAIT.test(line)),
  }
}

// 입력창(❯)에 쳐 두고 보내지 않은 글 — Claude Code 화면 맨 아래 몇 줄에서. 빈 칸 · 안내 글('Try "…"')은 없는 것으로
function unsentInput(text) {
  const lines = String(text || '').split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim())
  const prompt = [...lines.slice(-12)].reverse().find((line) => /^\s*❯/.test(line))
  if (!prompt) return ''
  const typed = prompt.replace(/^\s*❯\s?/, '').trim()
  return typed && !/^Try "/.test(typed) ? typed : ''
}

// 지금 — 일하는 중(work) · 쉬는 중(idle) · 멈춤(stop + 까닭) · 에이전트 없음(gone)
// agentStatus: 데몬 상태(working · idle · null) · waiting: 화면이 고르기 · 권한 질문 · unsent: 입력창에 보내지 않은 글
function nowState({ agentStatus, waiting = false, unsent = false, heavy = false, hasRequest = false, planStatus = '' }) {
  if (!agentStatus) return { state: 'gone', reason: null }
  if (waiting) return { state: 'stop', reason: 'question' }
  if (hasRequest) return { state: 'stop', reason: 'request' }
  if (agentStatus === 'working') return heavy ? { state: 'stop', reason: 'heavy' } : { state: 'work', reason: null }
  if (unsent) return { state: 'stop', reason: 'unsent' }
  if (planStatus === 'blocked') return { state: 'stop', reason: 'blocked' }
  return { state: 'idle', reason: null }
}

// ── 계획서 원문 → 기록(요청 · 진행 · 다음 · 막힘 · 검증) · PR · 자동 리뷰 ─────────
function section(text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^#{2,3}\\s*${heading}(?:\\s|$)`).test(line.trim()))
  if (start < 0) return []
  const depth = lines[start].trim().match(/^#+/)[0].length
  const body = []
  for (const line of lines.slice(start + 1)) {
    const head = line.match(/^(#+)\s/)
    if (head && head[1].length <= depth) break
    body.push(line)
  }
  return body
}
const isNone = (value) => !value || /^(없음|\(확정 전\)|아직 없음|none)/i.test(value) || /^\(.*\)$/.test(value)
const items = (lines) => lines.map((line) => line.trim()).filter((line) => /^(-|\d+\.)\s+/.test(line)).map((line) => plain(line.replace(/^(-|\d+\.)\s+(\[[ xX]\]\s+)?/, ''))).filter((line) => !isNone(line))
const field = (text, name) => plain((text.match(new RegExp(`^\\s*-\\s*${name}:\\s*(.+)$`, 'm')) || [])[1] || '')

// 요청 — 경량은 '## 지시'(> 인용 · 요청마다 ### 절), 정식은 개요의 '요청 사항' 아래 번호 줄
function requestLines(source) {
  const instruction = section(source, '지시').map((line) => plain(line.replace(/^>\s?/, '').replace(/^#+\s*/, ''))).filter(Boolean)
  if (instruction.length) return instruction.slice(-10).map((line) => clip(line, 400))
  const lines = source.split('\n')
  const start = lines.findIndex((line) => /^\s*-\s*요청 사항/.test(line))
  if (start < 0) return []
  const out = []
  for (const line of lines.slice(start + 1)) {
    if (!/^\s{2,}\S/.test(line)) break
    out.push(clip(plain(line.trim().replace(/^(\d+\.|-)\s+/, '')), 400))
  }
  return out
}

function planRecord(text) {
  const source = String(text || '')
  const checkpoint = section(source, 'Checkpoint').join('\n')
  const statusRaw = field(checkpoint, 'Status')
  const progress = section(source, 'Progress').map((line) => line.trim()).filter((line) => /^-\s+\[[ xX]\]/.test(line))
    .map((line) => ({ done: /^-\s+\[[xX]\]/.test(line), text: plain(line.replace(/^-\s+\[[ xX]\]\s+/, '')) }))
  const prs = [...checkpoint.matchAll(/^\s*-\s*PR:\s*(.+)$/gm)].flatMap((match) => [...match[1].matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)].map((url) => url[0]))
  return {
    title: plain((source.match(/^#\s+(.+)$/m) || [])[1] || ''),
    status: (statusRaw.match(/planned|in_progress|blocked|ready_for_review|done/) || [''])[0],
    statusNote: plain(statusRaw.replace(/^(planned|in_progress|blocked|ready_for_review|done)\s*[—-]?\s*/, '')),
    request: requestLines(source),
    progress,
    next: items(section(source, 'Next')),
    blocked: items(section(source, 'Blocked')),
    validation: items(section(source, 'Validation')).slice(0, 8),
    prs: [...new Set(prs)],
    // PR 마다 한 줄씩 있을 수 있다
    autoReview: [...checkpoint.matchAll(/^\s*-\s*Auto review:\s*(.+)$/gm)].map((match) => plain(match[1])),
    reviewResult: field(checkpoint, 'Review result'),
  }
}

module.exports = { samePane, bindings, agentPlan, leadRows, screenDigest, unsentInput, nowState, planRecord }
