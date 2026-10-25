// 맥 상단 메뉴 막대(Tray) — 무엇을 보여 주고 언제 알릴지. Electron 없이 돌아 `npm test` 로 검사한다
// 재료: 데몬 pane 목록(agent · agent_status) · 작업 공간 이름 · 아테나 현황판 /api/state(cards · header.usage) · 사람에게 묻는 요청(request list)
const i18n = require('./i18n')
const KOREAN = require('../i18n/ko.json')

// 문구는 사전(src/i18n)에서 — main 이 지금 언어의 say 를 넘긴다(없으면 한국어 · 테스트)
const koreanSay = i18n.translator(KOREAN, KOREAN)
const IDLE_HOLD_MS = 10000 // 일하다 멈춘 뒤 이만큼 조용해야 "응답이 끝났어요"
// 입력 대기(권한 질문 · 고르기 창)가 이만큼 이어져야 알린다 — 메뉴 막대가 4초마다 보니 두 번 잇달아 보여야 한다(잠깐 묻고 바로 넘어간 것은 빼고)
const WAIT_HOLD_MS = 3000

// pane 이름 — delegate 가 붙인 '🤖 에이전트 · 브랜치' 이름표가 있으면 그것, 없으면 agent
function agentName(pane) {
  const label = String(pane.label || '').replace(/^🤖\s*/, '').trim()
  return label || pane.agent || pane.id
}

// 계획서 단위로 펴기 — 계획서 카드 + 이슈 카드에 합쳐진 계획서(issue.linkedPlan · 제목은 이슈 것)
function liveCards(cards) {
  const plans = []
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.archived) continue
    if (card.kind === 'plan') plans.push({ id: card.id, title: card.title, status: card.status, html: card.html || null })
    else if (card.kind === 'issue' && card.linkedPlan) {
      const plan = card.linkedPlan
      // 정식 계획서만 결정 콘솔(html)이 있다
      const html = plan.grade === 'formal' && typeof plan.id === 'string' ? plan.id.replace(/\.md$/, '.html') : null
      plans.push({ id: plan.id, title: card.title, status: plan.status, html })
    }
  }
  return plans
}

// 칸반 칸별 수 — 현황판이 보여 주는 카드(이슈 · 계획서) 그대로
function columnCounts(cards) {
  const columns = {}
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.archived || !card.column) continue
    columns[card.column] = (columns[card.column] || 0) + 1
  }
  return columns
}

// 메뉴 · 아이콘 제목에 쓸 요약
function summarize({ panes = [], workspaces = [], cards = [], requests = [], usage = [], boardUp = false, waitMs = null, now = Date.now(), say = koreanSay } = {}) {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.label]))
  const agents = panes
    .filter((pane) => pane && pane.agent)
    .map((pane) => ({ id: pane.id, name: agentName(pane), workspace: names.get(pane.workspace_id) || '', status: pane.agent_status || 'idle' }))
  // 입력 대기 먼저, 그다음 일하는 것 — 데몬은 작업 중 · 대기 · 모름만 정하고, 입력 대기(waiting)는 메뉴 막대가 에이전트 pane 의 화면을 읽어 덧붙인다
  const rank = { waiting: 0, working: 1 }
  agents.sort((left, right) => (rank[left.status] ?? 2) - (rank[right.status] ?? 2))
  const plans = liveCards(cards)
  const blockedCards = plans.filter((card) => card.status === 'blocked')
  const reviewCards = plans.filter((card) => card.status === 'ready_for_review')
  // 확인 필요 = 사람에게 묻는 요청(아직 답하지 않은 것)만 — 막힌 계획서 · 리뷰 상태는 칸반 숫자에서만 보인다(상태 글자로 추측하지 않는다)
  const waiting = (Array.isArray(requests) ? requests : []).filter((request) => request && request.state === 'open')
  const attention = waiting.map((request) => ({ kind: 'request', mark: '?', id: request.id, requestKind: request.kind, text: request.title }))
  const counts = {
    working: agents.filter((agent) => agent.status === 'working').length,
    blocked: blockedCards.length,
    review: reviewCards.length,
    asking: waiting.length,
  }
  const columns = columnCounts(cards)
  const idle = agents.filter((agent) => agent.status !== 'working' && agent.status !== 'waiting').length
  return {
    counts,
    // 지난 7일 평균 답 대기(현황판 지표) — 확인 필요 머리줄에 붙인다. 현황판이 꺼졌거나 기록이 없으면 ''
    avgWait: boardUp && typeof waitMs === 'number' ? say('tray.attention.avgWait', { time: waitText(waitMs, say) }) : '',
    // 패널이 몇 줄 보일지 정한다(확인 필요 3줄 + n개 더 · 에이전트는 작업 공간별로 전부, 칸 안 스크롤)
    attention,
    agents,
    usageItems: usageItems(usage, now, say),
    done24: doneByHour(cards, now),
    columns,
    idleAgents: idle,
    waitingAgents: agents.filter((agent) => agent.status === 'waiting').length,
    boardUp,
  }
}

const HOUR_MS = 3600000

// 리셋 시각 — 오늘이면 'HH:MM', 내일이면 '내일 HH:MM', 그 뒤면 '월 HH:MM'(없거나 못 읽으면 '')
function resetClock(resetsAt, now = Date.now(), say = koreanSay) {
  const date = resetsAt ? new Date(typeof resetsAt === 'number' && resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  const days = Math.round((day.getTime() - today.getTime()) / (24 * HOUR_MS))
  if (days <= 0) return time
  if (days === 1) return say('time.tomorrow', { time })
  return `${say(`time.weekday.${date.getDay()}`)} ${time}`
}

// 걸린 시간 짧게 — 1시간 안은 분, 2일 안은 시간(소수 한 자리), 그 뒤는 일
function waitText(ms, say = koreanSay) {
  if (ms < HOUR_MS) return say('time.minutes', { n: Math.max(1, Math.round(ms / 60000)) })
  if (ms < 48 * HOUR_MS) return say('time.hours', { n: Math.round(ms / HOUR_MS * 10) / 10 })
  return say('time.days', { n: Math.round(ms / (24 * HOUR_MS) * 10) / 10 })
}

// 최근 24시간 완료 — 완료 칸 카드를 완료로 바뀐 시각(doneAt · 이슈는 붙은 계획서 것)으로 한 시간씩 24칸(마지막 칸이 지금).
// doneAt 이 없으면(사건 기록 전에 끝난 것) 마지막으로 바뀐 시각(mtime)
function doneByHour(cards, now = Date.now()) {
  const hours = new Array(24).fill(0)
  let total = 0
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.archived || card.column !== 'done') continue
    const at = Number(card.doneAt || card.linkedPlan?.doneAt) || card.mtime
    if (typeof at !== 'number') continue
    const age = now - at
    if (age < 0 || age >= 24 * HOUR_MS) continue
    hours[23 - Math.floor(age / HOUR_MS)] += 1
    total += 1
  }
  return { hours, total }
}

// 현황판 header.usage → [{ tool, toolId, window, percent, reset }] — 패널 막대용(toolId 로 도구 색)
function usageItems(usage, now = Date.now(), say = koreanSay) {
  const items = []
  for (const tool of Array.isArray(usage) ? usage : []) {
    const label = tool.label || tool.id
    for (const window of tool.windows || []) {
      if (typeof window.percent !== 'number') continue
      items.push({ tool: label, toolId: String(tool.id || ''), window: window.label, percent: Math.max(0, Math.min(100, Math.round(window.percent))), reset: resetClock(window.resetsAt, now, say) })
    }
  }
  return items
}


// 알림 — 처음 본 상태는 알리지 않고(켤 때 기준만 잡는다), 같은 변화는 한 번만, 한 번에 여러 건이면 묶는다
class Notifier {
  constructor() {
    this.ready = false
    this.panes = new Map() // id → { status, since, was, notified }
    this.cards = new Map() // id → status
    this.requests = null // 본 요청 id — 처음 본 목록은 알리지 않는다(켤 때 기준)
  }

  // 새로 열린 요청만 한 번 — [{ kind: 'request', title, body, target: { request } }]. requests 가 null 이면(못 읽음) 기억 그대로
  updateRequests(requests, say = koreanSay) {
    if (!Array.isArray(requests)) return []
    const open = requests.filter((request) => request && request.state === 'open')
    const known = this.requests
    this.requests = new Set(open.map((request) => request.id))
    if (known === null) return []
    return open.filter((request) => !known.has(request.id)).map((request) => ({ kind: 'request', title: say(`notify.request.${request.kind === 'decision' ? 'decision' : 'question'}`), body: request.title, target: { request: request.id } }))
  }

  // 반환: [{ kind, title, body, target }] — target 은 { pane } 또는 { card, html }. 묶기(bundle)는 부르는 쪽이 거른 뒤에.
  // cards 가 없으면(현황판이 꺼졌거나 아직 못 받음) 카드는 비교하지 않고 기억도 그대로 둔다
  update({ panes = [], cards = null, names = new Map(), say = koreanSay }, now) {
    const found = []
    const seen = new Set()
    for (const pane of panes) {
      if (!pane || !pane.agent) continue
      seen.add(pane.id)
      const status = pane.agent_status || 'idle'
      const before = this.panes.get(pane.id)
      if (!before || before.status !== status) {
        this.panes.set(pane.id, { status, since: now, was: before ? before.status : null, notified: !this.ready })
        continue
      }
      if (before.notified) continue
      const name = agentName(pane)
      const where = names.get(pane.workspace_id)
      const who = where ? `${name} · ${where}` : name
      if (status === 'waiting' && now - before.since >= WAIT_HOLD_MS) {
        // 풀릴 때까지(상태가 바뀔 때까지) 한 번 — 켤 때 이미 기다리던 것은 알리지 않는다(위 notified)
        found.push({ kind: 'waiting', title: say('notify.waiting.title'), body: say('notify.waiting.body', { who }), target: { pane: pane.id } })
        before.notified = true
      } else if (status === 'idle' && before.was === 'working' && now - before.since >= IDLE_HOLD_MS) {
        found.push({ kind: 'idle', title: say('notify.idle.title'), body: say('notify.idle.body', { who }), target: { pane: pane.id } })
        before.notified = true
      } else if (status !== 'idle' && status !== 'waiting') {
        before.notified = true
      }
    }
    for (const id of [...this.panes.keys()]) if (!seen.has(id)) this.panes.delete(id)

    if (cards === null) {
      this.ready = true
      return found
    }
    const alive = new Set()
    for (const card of liveCards(cards)) {
      alive.add(card.id)
      const before = this.cards.get(card.id)
      this.cards.set(card.id, card.status)
      if (!this.ready || before === undefined || before === card.status) continue
      if (card.status === 'ready_for_review') found.push({ kind: 'review', title: say('notify.review.title'), body: card.title, target: { card: card.id, html: card.html || null } })
      if (card.status === 'done') found.push({ kind: 'done', title: say('notify.done.title'), body: card.title, target: { card: card.id, html: card.html || null } })
    }
    for (const id of [...this.cards.keys()]) if (!alive.has(id)) this.cards.delete(id)
    this.ready = true
    return found
  }
}

// 같은 종류가 여러 건이면 하나로 — '응답이 끝났어요 (3건)'
// 묶은 본문은 이름만 — 알림 본문은 사전에서 '<누구> — <내용>' 꼴이다(네 언어 모두 ' — ')
function bundle(found, say = koreanSay) {
  const byKind = new Map()
  for (const item of found) byKind.set(item.kind, [...(byKind.get(item.kind) || []), item])
  return [...byKind.values()].map((items) =>
    items.length === 1 ? items[0] : { ...items[0], title: say('notify.bundle', { title: items[0].title, count: items.length }), body: items.map((item) => item.body.split(' — ')[0]).join(', ') },
  )
}

module.exports = { IDLE_HOLD_MS, WAIT_HOLD_MS, agentName, liveCards, summarize, usageItems, resetClock, doneByHour, waitText, Notifier, bundle }
