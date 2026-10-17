const test = require('node:test')
const assert = require('node:assert/strict')
const tray = require('../src/lib/tray-model')

const pane = (id, status, label = null, workspace = 'w1') => ({ id, agent: 'claude', agent_status: status, label, workspace_id: workspace })
const card = (id, status, title = id, extra = {}) => ({ kind: 'plan', id, status, title, column: { ready_for_review: 'review', done: 'done' }[status] || 'doing', html: null, archived: false, ...extra })

test('요약: 확인 필요(막힘 · 리뷰 대기) · 에이전트(막힘 먼저 · 자르지 않음) · 사용량 · 칸반', () => {
  const summary = tray.summarize({
    panes: [pane('p1', 'working', '🤖 web-fe · feature/x'), pane('p2', 'blocked'), pane('p3', 'idle'), { id: 'p4', agent: null }],
    workspaces: [{ id: 'w1', label: 'athena' }],
    cards: [card('a', 'blocked', '로그인'), card('b', 'ready_for_review', '버튼'), card('c', 'done'), card('d', 'in_progress', 'x', { archived: true })],
    usage: [{ id: 'codex', label: 'Codex', windows: [{ label: '주간', percent: 41.6, resetsAt: '2026-10-18T09:30:00' }] }, { id: 'claude', label: 'Claude', windows: [] }],
    boardUp: true,
    now: new Date('2026-10-18T08:00:00').getTime(),
  })
  assert.deepEqual(summary.counts, { working: 1, blocked: 2, review: 1 })
  assert.deepEqual(summary.attention.map((item) => `${item.mark} ${item.text}`), ['! claude — 입력을 기다려요', '! 로그인 — 막힘', '? 버튼 — 리뷰 대기'])
  assert.deepEqual(summary.agents.map((agent) => [agent.name, agent.workspace, agent.status]), [['claude', 'athena', 'blocked'], ['web-fe · feature/x', 'athena', 'working'], ['claude', 'athena', 'idle']])
  assert.deepEqual(summary.usageItems, [{ tool: 'Codex', toolId: 'codex', window: '주간', percent: 42, reset: '09:30' }])
  assert.deepEqual([summary.idleAgents, summary.blockedAgents], [1, 1])
  assert.equal(summary.columns.done, 1)
  // 많아도 자르지 않는다(패널이 칸 안에서 스크롤)
  assert.equal(tray.summarize({ panes: Array.from({ length: 8 }, (_, index) => pane(`p${index}`, 'working')) }).agents.length, 8)
  // 이슈에 합쳐진 계획서도 계획서로 본다(제목은 이슈 것 · 정식이면 결정 콘솔)
  const linked = tray.liveCards([{ kind: 'issue', id: 'issues/a.md', title: '이슈 제목', column: 'review', linkedPlan: { id: 'plans/feature/a.md', grade: 'formal', status: 'ready_for_review' } }, { kind: 'issue', id: 'issues/b.md', title: '열린 이슈', column: 'issue' }])
  assert.deepEqual(linked, [{ id: 'plans/feature/a.md', title: '이슈 제목', status: 'ready_for_review', html: 'plans/feature/a.html' }])
  const counted = tray.summarize({ cards: [{ kind: 'issue', id: 'i1', title: 't', column: 'issue' }, { kind: 'issue', id: 'i2', title: 't', column: 'review', linkedPlan: { id: 'p', grade: 'light', status: 'ready_for_review' } }] })
  assert.deepEqual(counted.columns, { issue: 1, review: 1 })
  assert.equal(counted.counts.review, 1)
})

test('알림: 처음 상태는 알리지 않고 · 막힘은 이어질 때 한 번 · 일하다 멈춤 · 카드 리뷰·완료 · 여러 건은 묶음', () => {
  const notifier = new tray.Notifier()
  const names = new Map([['w1', 'athena']])
  // 켤 때 이미 막혀 있던 것은 알리지 않는다
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'working')], cards: [card('a', 'in_progress', '로그인')], names }, 0), [])
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'working')], cards: [card('a', 'in_progress', '로그인')], names }, 60000), [])
  // p2 가 멈춤 → 10초 지나야 한 번
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'idle')], names }, 61000), [])
  const idle = notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'idle')], names }, 61000 + tray.IDLE_HOLD_MS)
  assert.deepEqual(idle, [{ kind: 'idle', title: '응답이 끝났어요', body: 'claude · athena — 결과를 확인해 주세요', target: { pane: 'p2' } }])
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'idle')], names }, 90000), [])
  // 새로 막힘 → 잠깐이면 안 알리고, 이어지면 한 번
  notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'blocked')], names }, 100000)
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'blocked')], names }, 100000 + 3000), [])
  assert.equal(notifier.update({ panes: [pane('p1', 'blocked'), pane('p2', 'blocked')], names }, 100000 + tray.BLOCKED_HOLD_MS)[0].kind, 'blocked')
  // 카드 — 리뷰 대기 · 완료(카드 목록이 같이 와야 비교한다)
  const cards = notifier.update({ panes: [], cards: [card('a', 'ready_for_review', '로그인'), card('b', 'done', '새 카드')] }, 200000)
  assert.deepEqual(cards.map((item) => item.kind), ['review'])
  assert.deepEqual(notifier.update({ panes: [], cards: [card('a', 'done', '로그인'), card('b', 'done', '새 카드')] }, 210000).map((item) => item.kind), ['done'])
  // 여러 건은 묶는다
  const busy = new tray.Notifier()
  busy.update({ panes: [pane('p1', 'working'), pane('p2', 'working')], names }, 0)
  busy.update({ panes: [pane('p1', 'idle'), pane('p2', 'idle')], names }, 1000)
  const bundled = tray.bundle(busy.update({ panes: [pane('p1', 'idle'), pane('p2', 'idle')], names }, 1000 + tray.IDLE_HOLD_MS))
  assert.equal(bundled.length, 1)
  assert.equal(bundled[0].title, '응답이 끝났어요 (2건)')
})

test('사용량 리셋 시각: 오늘은 시각만 · 내일 · 그 뒤는 요일', () => {
  const now = new Date('2026-10-18T08:00:00').getTime() // 일요일
  assert.equal(tray.resetClock('2026-10-18T23:30:00', now), '23:30')
  assert.equal(tray.resetClock('2026-10-19T09:30:00', now), '내일 09:30')
  assert.equal(tray.resetClock('2026-10-20T09:00:00', now), '화 09:00')
  assert.equal(tray.resetClock(null, now), '')
  assert.equal(tray.resetClock('읽을 수 없음', now), '')
})

test('최근 24시간 완료: 완료 칸 카드를 mtime 으로 한 시간씩 · 마지막 칸이 지금 · 24시간 밖 · 보관 · 다른 칸은 빼고', () => {
  const now = new Date('2026-10-18T12:00:00').getTime()
  const hour = 3600000
  const done = (mtime, extra = {}) => ({ kind: 'plan', id: String(mtime), column: 'done', mtime, ...extra })
  const result = tray.doneByHour([done(now - 10 * 60000), done(now - 30 * 60000), done(now - 5 * hour), done(now - 25 * hour), done(now - hour, { archived: true }), { column: 'doing', mtime: now }], now)
  assert.equal(result.total, 3)
  assert.equal(result.hours.length, 24)
  assert.equal(result.hours[23], 2)
  assert.equal(result.hours[18], 1)
})
