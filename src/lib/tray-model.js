// 맥 상단 메뉴 막대(Tray) — 무엇을 보여 주고 언제 알릴지. Electron 없이 돌아 `npm test` 로 검사한다
// 재료: 데몬 pane 목록(agent · agent_status) · 작업 공간 이름 · 아테나 현황판 /api/state(cards · header.usage)
const BLOCKED_HOLD_MS = 8000 // 막힘이 이만큼 이어져야 알린다(잠깐 묻고 바로 넘어가는 것은 빼고)
const IDLE_HOLD_MS = 10000 // 일하다 멈춘 뒤 이만큼 조용해야 "응답이 끝났어요"

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
function summarize({ panes = [], workspaces = [], cards = [], usage = [], boardUp = false, now = Date.now() } = {}) {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.label]))
  const agents = panes
    .filter((pane) => pane && pane.agent)
    .map((pane) => ({ id: pane.id, name: agentName(pane), workspace: names.get(pane.workspace_id) || '', status: pane.agent_status || 'idle' }))
  // 일하는 것 · 막힌 것 먼저
  const rank = { blocked: 0, working: 1 }
  agents.sort((left, right) => (rank[left.status] ?? 2) - (rank[right.status] ?? 2))
  const plans = liveCards(cards)
  const blockedCards = plans.filter((card) => card.status === 'blocked')
  const reviewCards = plans.filter((card) => card.status === 'ready_for_review')
  const attention = [
    ...agents.filter((agent) => agent.status === 'blocked').map((agent) => ({ kind: 'pane', mark: '!', id: agent.id, text: `${agent.name} — 입력을 기다려요` })),
    ...blockedCards.map((card) => ({ kind: 'card', mark: '!', id: card.id, html: card.html || null, text: `${card.title} — 막힘` })),
    ...reviewCards.map((card) => ({ kind: 'card', mark: '?', id: card.id, html: card.html || null, text: `${card.title} — 리뷰 대기` })),
  ]
  const counts = {
    working: agents.filter((agent) => agent.status === 'working').length,
    blocked: agents.filter((agent) => agent.status === 'blocked').length + blockedCards.length,
    review: reviewCards.length,
  }
  const columns = columnCounts(cards)
  const idle = agents.filter((agent) => agent.status !== 'working' && agent.status !== 'blocked').length
  return {
    counts,
    // 패널이 몇 줄 보일지 정한다(확인 필요 3줄 + n개 더 · 에이전트는 작업 공간별로 전부, 칸 안 스크롤)
    attention,
    agents,
    usageItems: usageItems(usage, now),
    done24: doneByHour(cards, now),
    columns,
    idleAgents: idle,
    blockedAgents: agents.filter((agent) => agent.status === 'blocked').length,
    boardUp,
  }
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const HOUR_MS = 3600000

// 리셋 시각 — 오늘이면 'HH:MM', 내일이면 '내일 HH:MM', 그 뒤면 '월 HH:MM'(없거나 못 읽으면 '')
function resetClock(resetsAt, now = Date.now()) {
  const date = resetsAt ? new Date(typeof resetsAt === 'number' && resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  const days = Math.round((day.getTime() - today.getTime()) / (24 * HOUR_MS))
  if (days <= 0) return time
  if (days === 1) return `내일 ${time}`
  return `${WEEKDAYS[date.getDay()]} ${time}`
}

// 최근 24시간 완료 — 완료 칸 카드를 마지막으로 바뀐 시각(mtime)으로 한 시간씩 24칸(마지막 칸이 지금)
function doneByHour(cards, now = Date.now()) {
  const hours = new Array(24).fill(0)
  let total = 0
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.archived || card.column !== 'done' || typeof card.mtime !== 'number') continue
    const age = now - card.mtime
    if (age < 0 || age >= 24 * HOUR_MS) continue
    hours[23 - Math.floor(age / HOUR_MS)] += 1
    total += 1
  }
  return { hours, total }
}

// 현황판 header.usage → [{ tool, toolId, window, percent, reset }] — 패널 막대용(toolId 로 도구 색)
function usageItems(usage, now = Date.now()) {
  const items = []
  for (const tool of Array.isArray(usage) ? usage : []) {
    const label = tool.label || tool.id
    for (const window of tool.windows || []) {
      if (typeof window.percent !== 'number') continue
      items.push({ tool: label, toolId: String(tool.id || ''), window: window.label, percent: Math.max(0, Math.min(100, Math.round(window.percent))), reset: resetClock(window.resetsAt, now) })
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
  }

  // 반환: [{ kind, title, body, target }] — target 은 { pane } 또는 { card, html }. 묶기(bundle)는 부르는 쪽이 거른 뒤에.
  // cards 가 없으면(현황판이 꺼졌거나 아직 못 받음) 카드는 비교하지 않고 기억도 그대로 둔다
  update({ panes = [], cards = null, names = new Map() }, now) {
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
      if (status === 'blocked' && now - before.since >= BLOCKED_HOLD_MS) {
        found.push({ kind: 'blocked', title: '확인이 필요해요', body: `${who} — 입력을 기다리고 있어요`, target: { pane: pane.id } })
        before.notified = true
      } else if (status === 'idle' && before.was === 'working' && now - before.since >= IDLE_HOLD_MS) {
        found.push({ kind: 'idle', title: '응답이 끝났어요', body: `${who} — 결과를 확인해 주세요`, target: { pane: pane.id } })
        before.notified = true
      } else if (status !== 'blocked' && status !== 'idle') {
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
      if (card.status === 'ready_for_review') found.push({ kind: 'review', title: '리뷰를 기다려요', body: card.title, target: { card: card.id, html: card.html || null } })
      if (card.status === 'done') found.push({ kind: 'done', title: '작업이 완료됐어요', body: card.title, target: { card: card.id, html: card.html || null } })
    }
    for (const id of [...this.cards.keys()]) if (!alive.has(id)) this.cards.delete(id)
    this.ready = true
    return found
  }
}

// 같은 종류가 여러 건이면 하나로 — '응답이 끝났어요 (3건)'
function bundle(found) {
  const byKind = new Map()
  for (const item of found) byKind.set(item.kind, [...(byKind.get(item.kind) || []), item])
  return [...byKind.values()].map((items) =>
    items.length === 1 ? items[0] : { ...items[0], title: `${items[0].title} (${items.length}건)`, body: items.map((item) => item.body.split(' — ')[0]).join(', ') },
  )
}

module.exports = { BLOCKED_HOLD_MS, IDLE_HOLD_MS, agentName, liveCards, summarize, usageItems, resetClock, doneByHour, Notifier, bundle }
