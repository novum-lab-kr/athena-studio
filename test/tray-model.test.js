const test = require('node:test')
const assert = require('node:assert/strict')
const tray = require('../src/lib/tray-model.mts')

const pane = (id, status, label = null, workspace = 'w1') => ({ id, agent: 'claude', agent_status: status, label, workspace_id: workspace })
const card = (id, status, title = id, extra = {}) => ({ kind: 'plan', id, status, title, column: { ready_for_review: 'review', done: 'done' }[status] || 'doing', html: null, archived: false, ...extra })

test('요약: 확인 필요(요청만) · 막힘은 계획서만 · 에이전트(작업 중 먼저 · 자르지 않음) · 사용량 · 칸반', () => {
  const summary = tray.summarize({
    panes: [pane('p3', 'idle'), pane('p1', 'working', '🤖 web-fe · feature/x'), pane('p2', 'idle'), { id: 'p4', agent: null }],
    workspaces: [{ id: 'w1', label: 'athena' }],
    cards: [card('a', 'blocked', '로그인'), card('b', 'ready_for_review', '버튼'), card('c', 'done'), card('d', 'in_progress', 'x', { archived: true })],
    usage: [{ id: 'codex', label: 'Codex', windows: [{ label: '주간', percent: 41.6, resetsAt: '2026-10-18T09:30:00' }] }, { id: 'claude', label: 'Claude', windows: [] }],
    boardUp: true,
    now: new Date('2026-10-18T08:00:00').getTime(),
  })
  // 막힘 = 계획서 Status blocked 만(pane 의 입력 대기는 에이전트 줄 · 맥 알림에서만)
  assert.deepEqual(summary.counts, { working: 1, blocked: 1, review: 1, asking: 0 })
  // 확인 필요는 요청만 — 막힌 계획서 · 리뷰 대기는 넣지 않는다
  assert.deepEqual(summary.attention, [])
  const asked = tray.summarize({ requests: [{ id: 'r1', kind: 'question', state: 'open', title: '필드가 있나요?' }, { id: 'r2', kind: 'decision', state: 'answered', title: '전달 전' }] })
  assert.deepEqual(asked.attention, [{ kind: 'request', mark: '?', id: 'r1', requestKind: 'question', text: '필드가 있나요?' }])
  assert.equal(asked.counts.asking, 1)
  assert.deepEqual(summary.agents.map((agent) => [agent.name, agent.workspace, agent.status]), [['web-fe · feature/x', 'athena', 'working'], ['claude', 'athena', 'idle'], ['claude', 'athena', 'idle']])
  assert.deepEqual(summary.usageItems, [{ tool: 'Codex', toolId: 'codex', window: '주간', percent: 42, reset: '09:30' }])
  assert.equal(summary.idleAgents, 2)
  // 평균 답 대기 — 일감이 떠 있고 값이 있을 때만 확인 필요 머리줄에
  assert.equal(summary.avgWait, '')
  assert.equal(tray.summarize({ boardUp: true, waitMs: 3.2 * 3600000 }).avgWait, ' · 평균 대기 3.2시간')
  assert.equal(tray.summarize({ boardUp: false, waitMs: 3600000 }).avgWait, '')
  assert.deepEqual([tray.waitText(20 * 60000), tray.waitText(30 * 1000), tray.waitText(72 * 3600000)], ['20분', '1분', '3일'])
  assert.equal('blockedAgents' in summary, false)
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

test('알림: 사람이 고를 것만 — 일하다 멈춤 · 카드 리뷰·완료는 알리지 않고 · 여러 건은 묶음', () => {
  const notifier = new tray.Notifier()
  const names = new Map([['w1', 'athena']])
  // 켤 때 상태는 기준만
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'idle'), pane('p2', 'working')], names }, 0), [])
  // 일하다 멈춰도(응답 끝남) 알리지 않는다 — 오래 지나도
  notifier.update({ panes: [pane('p1', 'idle'), pane('p2', 'idle')], names }, 61000)
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'idle'), pane('p2', 'idle')], names }, 61000 + 600000), [])
  // 모르는 상태(unknown)로 바뀌어도 알리지 않는다
  notifier.update({ panes: [pane('p1', 'unknown'), pane('p2', 'idle')], names }, 700000)
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'unknown'), pane('p2', 'idle')], names }, 760000), [])
  // 카드가 리뷰 · 완료로 바뀌어도 알리지 않는다(카드는 받지도 않는다)
  assert.deepEqual(notifier.update({ panes: [], cards: [card('a', 'in_progress', '로그인')] }, 800000), [])
  assert.deepEqual(notifier.update({ panes: [], cards: [card('a', 'ready_for_review', '로그인'), card('b', 'done', '새 카드')] }, 810000), [])
  // 입력 대기 여러 건은 묶는다
  const busy = new tray.Notifier()
  busy.update({ panes: [pane('p1', 'working'), pane('p2', 'working')], names }, 0)
  busy.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 1000)
  const bundled = tray.bundle(busy.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 1000 + tray.WAIT_HOLD_MS))
  assert.equal(bundled.length, 1)
  assert.equal(bundled[0].title, '입력을 기다려요 (2건)')
})

test('입력 대기: 에이전트 줄 맨 위 · 머리줄 수 · 대기 수에서 빼고 · 이어지면 한 번 알리고 풀릴 때까지 다시 안 알린다', () => {
  const summary = tray.summarize({ panes: [pane('p1', 'working'), pane('p2', 'idle'), pane('p3', 'waiting', '🤖 web-fe · feature/x')], workspaces: [{ id: 'w1', label: 'athena' }] })
  assert.deepEqual(summary.agents.map((agent) => [agent.id, agent.status]), [['p3', 'waiting'], ['p1', 'working'], ['p2', 'idle']])
  assert.deepEqual([summary.counts.working, summary.idleAgents, summary.waitingAgents], [1, 1, 1])
  // 확인 필요(요청) · 막힘(계획서) 숫자에는 넣지 않는다
  assert.deepEqual([summary.counts.blocked, summary.counts.asking], [0, 0])

  const notifier = new tray.Notifier()
  const names = new Map([['w1', 'athena']])
  // 켤 때 이미 기다리던 것은 알리지 않는다
  notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'working')], names }, 0)
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'working')], names }, 60000), [])
  // 잠깐 묻고 바로 넘어간 것(유지 시간 전에 풀림)은 알리지 않는다
  notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 61000)
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 61000 + tray.WAIT_HOLD_MS - 1), [])
  notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'working')], names }, 63000)
  // 이어지면 한 번(누르면 그 pane)
  notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 70000)
  const waiting = notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 70000 + tray.WAIT_HOLD_MS)
  assert.deepEqual(waiting, [{ kind: 'waiting', title: '입력을 기다려요', body: 'claude · athena — 권한 질문이나 고르기 창이 떠 있어요', target: { pane: 'p2' } }])
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 200000), [])
  // 풀린 뒤(작업 중) 다시 막히면 또 한 번
  notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'working')], names }, 210000)
  notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 220000)
  assert.equal(notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'waiting')], names }, 220000 + tray.WAIT_HOLD_MS).length, 1)
  // 입력 대기가 풀려 대기(idle)가 되면 알리지 않는다
  notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'idle')], names }, 300000)
  assert.deepEqual(notifier.update({ panes: [pane('p1', 'waiting'), pane('p2', 'idle')], names }, 360000), [])
})

test('사용량 리셋 시각: 오늘은 시각만 · 내일 · 그 뒤는 요일', () => {
  const now = new Date('2026-10-18T08:00:00').getTime() // 일요일
  assert.equal(tray.resetClock('2026-10-18T23:30:00', now), '23:30')
  assert.equal(tray.resetClock('2026-10-19T09:30:00', now), '내일 09:30')
  assert.equal(tray.resetClock('2026-10-20T09:00:00', now), '화 09:00')
  assert.equal(tray.resetClock(null, now), '')
  assert.equal(tray.resetClock('읽을 수 없음', now), '')
})

test('최근 24시간 완료: 완료로 바뀐 시각(doneAt · 없으면 mtime)으로 한 시간씩 · 마지막 칸이 지금 · 24시간 밖 · 보관 · 다른 칸은 빼고', () => {
  const now = new Date('2026-10-18T12:00:00').getTime()
  const hour = 3600000
  const done = (mtime, extra = {}) => ({ kind: 'plan', id: String(mtime), column: 'done', mtime, ...extra })
  const result = tray.doneByHour([done(now - 10 * 60000), done(now - 30 * 60000), done(now - 5 * hour), done(now - 25 * hour), done(now - hour, { archived: true }), { column: 'doing', mtime: now }], now)
  assert.equal(result.total, 3)
  assert.equal(result.hours.length, 24)
  assert.equal(result.hours[23], 2)
  assert.equal(result.hours[18], 1)
  // 완료 뒤에 계획서를 고쳐 mtime 이 지금이어도 doneAt(30시간 전)이 먼저 — 다시 "방금 완료" 로 세지 않는다
  const edited = tray.doneByHour([done(now - 60000, { doneAt: now - 30 * hour }), { kind: 'issue', id: 'i', column: 'done', mtime: now - 60000, linkedPlan: { doneAt: now - 2 * hour } }], now)
  assert.equal(edited.total, 1)
  assert.equal(edited.hours[21], 1)
})

test('알림: 새로 열린 요청만 한 번 · 처음 본 목록은 알리지 않는다 · 못 읽으면 기억 그대로', () => {
  const notifier = new tray.Notifier()
  const open = (id, kind = 'question') => ({ id, kind, state: 'open', title: `제목 ${id}` })
  assert.deepEqual(notifier.updateRequests([open('a')]), [])
  assert.deepEqual(notifier.updateRequests(null), [])
  const found = notifier.updateRequests([open('a'), open('b', 'decision'), { id: 'c', state: 'answered', title: 'x' }])
  assert.deepEqual(found, [{ kind: 'request', title: '결정이 필요해요', body: '제목 b', target: { request: 'b' } }])
  assert.deepEqual(notifier.updateRequests([open('a'), open('b', 'decision')]), [])
})
