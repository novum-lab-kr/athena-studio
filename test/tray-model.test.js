const test = require('node:test')
const assert = require('node:assert/strict')
const tray = require('../src/lib/tray-model.mts')

const pane = (id, status, label = null, workspace = 'w1') => ({ id, agent: 'claude', agent_status: status, label, workspace_id: workspace })
const card = (id, status, title = id, extra = {}) => ({ kind: 'plan', id, status, title, column: { ready_for_review: 'review', done: 'done' }[status] || 'doing', html: null, archived: false, ...extra })

test('요약: 일하는 에이전트 수 · 에이전트(작업 중 먼저 · 자르지 않음) · 사용량', () => {
  const summary = tray.summarize({
    panes: [pane('p3', 'idle'), pane('p1', 'working', '🤖 web-fe · feature/x'), pane('p2', 'idle'), { id: 'p4', agent: null }],
    workspaces: [{ id: 'w1', label: 'athena' }],
    usage: [{ id: 'codex', label: 'Codex', windows: [{ label: '주간', percent: 41.6, resetsAt: '2026-10-18T09:30:00' }] }, { id: 'claude', label: 'Claude', windows: [] }],
    boardUp: true,
    now: new Date('2026-10-18T08:00:00').getTime(),
  })
  // 막힘 · 리뷰 수는 툴팁에서도 뺐다 — 일하는 에이전트 수만(사용자 2026-11-04)
  assert.deepEqual(summary.counts, { working: 1 })
  // 확인할 일 · 칸반 숫자 · 완료 24h · 평균 대기는 패널에서 뺐다(사용자 2026-11-04)
  for (const gone of ['attention', 'avgWait', 'columns', 'done24']) assert.equal(gone in summary, false)
  assert.deepEqual(summary.agents.map((agent) => [agent.name, agent.workspace, agent.status]), [['web-fe · feature/x', 'athena', 'working'], ['claude', 'athena', 'idle'], ['claude', 'athena', 'idle']])
  assert.deepEqual(summary.usageItems, [{ tool: 'Codex', toolId: 'codex', window: '주간', percent: 42, reset: '09:30' }])
  assert.equal(summary.idleAgents, 2)
  assert.equal('blockedAgents' in summary, false)
  // 많아도 자르지 않는다(패널이 칸 안에서 스크롤)
  assert.equal(tray.summarize({ panes: Array.from({ length: 8 }, (_, index) => pane(`p${index}`, 'working')) }).agents.length, 8)
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
  assert.equal(bundled[0].title, '입력을 기다립니다 (2건)')
})

test('입력 대기: 에이전트 줄 맨 위 · 머리줄 수 · 대기 수에서 빼고 · 이어지면 한 번 알리고 풀릴 때까지 다시 안 알린다', () => {
  const summary = tray.summarize({ panes: [pane('p1', 'working'), pane('p2', 'idle'), pane('p3', 'waiting', '🤖 web-fe · feature/x')], workspaces: [{ id: 'w1', label: 'athena' }] })
  assert.deepEqual(summary.agents.map((agent) => [agent.id, agent.status]), [['p3', 'waiting'], ['p1', 'working'], ['p2', 'idle']])
  assert.deepEqual([summary.counts.working, summary.idleAgents, summary.waitingAgents], [1, 1, 1])

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
  assert.deepEqual(waiting, [{ kind: 'waiting', title: '입력을 기다립니다', body: 'claude · athena — 권한 질문이나 고르기 창이 떠 있습니다', target: { pane: 'p2' } }])
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

test('일한 시간: 10분 칸마다 일하는 에이전트 수 × 4초를 분으로 더한다 · 3일치만 남긴다', () => {
  const at = (stamp) => new Date(stamp).getTime()
  assert.equal(tray.daySlot(at('2026-11-04T00:00:00')), 0)
  assert.equal(tray.daySlot(at('2026-11-04T13:29:59')), 80) // 13시 20분 칸
  assert.equal(tray.daySlot(at('2026-11-04T23:59:59')), 143)
  assert.deepEqual(tray.activityDays(at('2026-11-04T13:00:00')), ['2026-11-04', '2026-11-03', '2026-11-02'])
  let log = tray.recordActivity(null, at('2026-11-02T10:00:00'), 1)
  log = tray.recordActivity(log, at('2026-11-04T13:21:00'), 3) // 3개 × 4초 = 0.2분
  log = tray.recordActivity(log, at('2026-11-04T13:25:00'), 0) // 아무도 안 일하면 그대로
  log = tray.recordActivity(log, at('2026-11-04T13:29:00'), -1) // 음수는 0 으로
  log = tray.recordActivity(log, at('2026-11-04T13:30:00'), 1, 60) // 간격을 주면 그만큼(1분)
  assert.equal(log.format, tray.ACTIVITY_FORMAT)
  assert.deepEqual(log.days.map((day) => day.day), ['2026-11-04', '2026-11-02'])
  const today = log.days[0].bins
  assert.equal(today.length, 144)
  assert.ok(Math.abs(today[80] - 0.2) < 1e-9)
  assert.equal(today[81], 1)
  // 날짜가 넘어가면 오늘 칸을 새로 · 3일 밖(11-02)은 버린다
  log = tray.recordActivity(log, at('2026-11-05T00:05:00'), 2)
  assert.deepEqual(log.days.map((day) => day.day), ['2026-11-05', '2026-11-04'])
  const view = tray.activityView(log, at('2026-11-05T00:06:00'))
  assert.ok(Math.abs(view.today[0] - 8 / 60) < 1e-9)
  assert.equal(view.yesterday, log.days[1].bins)
  assert.equal(view.before, null) // 기록 없는 날은 null — 패널이 그 겹을 안 그린다
  assert.deepEqual(tray.activityView(null, at('2026-11-05T00:06:00')), { today: new Array(144).fill(0), yesterday: null, before: null })
})

test('일한 시간 저장: 다시 읽으면 3일 안의 날만 그대로 · 옛 형식 · 깨진 글은 버리고 모양이 다른 날만 뺀다', () => {
  const now = new Date('2026-11-04T13:21:00').getTime()
  const log = tray.recordActivity(tray.recordActivity(null, new Date('2026-11-03T09:00:00').getTime(), 2), now, 3)
  const text = tray.serializeActivity(log)
  assert.ok(text.endsWith('\n'))
  assert.match(text, /"bins":\[[^\]]*0\.133/) // 소수 셋째 자리까지
  const back = tray.parseActivity(text, now)
  assert.deepEqual(back.days.map((day) => day.day), ['2026-11-04', '2026-11-03'])
  assert.equal(back.days[0].bins[80], 0.2)
  // 사흘 지나면 다 빠진다
  assert.deepEqual(tray.parseActivity(text, new Date('2026-11-07T08:00:00').getTime()).days, [])
  // 옛 동시 최대 기록(형식 표시 없음) · 쓰다 끊긴 글 · null 은 버린다
  assert.equal(tray.parseActivity(JSON.stringify({ day: '2026-11-04', bins: new Array(144).fill(1) }), now), null)
  assert.equal(tray.parseActivity('{"format":2,"days":[', now), null)
  assert.equal(tray.parseActivity('null', now), null)
  // 모양이 다른 날은 그날만
  const mixed = JSON.stringify({ format: 2, days: [{ day: '2026-11-04', bins: [1, 2] }, { day: '2026-11-03', bins: new Array(144).fill(0.5) }, { day: '2026-11-02', bins: new Array(144).fill('1') }] })
  assert.deepEqual(tray.parseActivity(mixed, now).days.map((day) => day.day), ['2026-11-03'])
})

test('에이전트 브랜치: delegate 이름표 🤖 에이전트 · 브랜치 의 뒤쪽 · 이름표가 없거나 브랜치가 없으면 빈 값', () => {
  assert.equal(tray.agentBranch({ id: 'p1r', label: '🤖 web-fe · feature/a · b' }), 'feature/a · b')
  assert.equal(tray.agentBranch({ id: 'p1r', label: '🤖 reviewer' }), '')
  assert.equal(tray.agentBranch({ id: 'p1r', label: 'my · pane' }), '')
  assert.equal(tray.agentBranch({ id: 'p1r', agent: 'claude' }), '')
})

test('알림: 새로 열린 요청만 한 번 · 처음 본 목록은 알리지 않는다 · 못 읽으면 기억 그대로', () => {
  const notifier = new tray.Notifier()
  const open = (id, kind = 'question') => ({ id, kind, state: 'open', title: `제목 ${id}` })
  assert.deepEqual(notifier.updateRequests([open('a')]), [])
  assert.deepEqual(notifier.updateRequests(null), [])
  const found = notifier.updateRequests([open('a'), open('b', 'decision'), { id: 'c', state: 'answered', title: 'x' }])
  assert.deepEqual(found, [{ kind: 'request', title: '결정이 필요합니다', body: '제목 b', target: { request: 'b' } }])
  assert.deepEqual(notifier.updateRequests([open('a'), open('b', 'decision')]), [])
})

test('알림: 허락 창 요청(perm: 키)만 target 에 pane 을 싣는다 — 보고 있는 pane 이면 부르는 쪽(tray.mts lookingAt)이 거른다', () => {
  const notifier = new tray.Notifier()
  notifier.updateRequests([])
  const found = notifier.updateRequests([
    { id: 'p', kind: 'question', state: 'open', title: '허락', pane: 'p3', permission: true },
    { id: 'q', kind: 'question', state: 'open', title: '질문', pane: 'p3', permission: false },
    { id: 'n', kind: 'question', state: 'open', title: 'pane 없음', pane: null, permission: true },
  ])
  assert.deepEqual(found.map((item) => item.target), [{ request: 'p', pane: 'p3' }, { request: 'q' }, { request: 'n' }])
})

test('사용량 창 이름: 현황판이 준 창 길이(분)로 지금 언어에 맞춰 짓고, 길이가 없으면(옛 코어) label 그대로', () => {
  const i18n = require('../src/lib/i18n.mts')
  const korean = require('../src/i18n/ko.json')
  const englishSay = i18n.translator(require('../src/i18n/en.json'), korean)
  const usage = [{ id: 'claude', label: 'Claude', windows: [{ label: '5시간', minutes: 300, percent: 42 }, { label: '주간', minutes: 10080, percent: 18 }] },
    { id: 'codex', label: 'Codex', windows: [{ label: '2일', minutes: 2880, percent: 1 }, { label: '3시간', minutes: 180, percent: 2 }, { label: '90분', minutes: 90, percent: 3 }, { label: '주간', percent: 9 }] }]
  assert.deepEqual(tray.usageItems(usage, 0, englishSay).map((item) => item.window), ['5h', 'Weekly', '2d', '3h', '90m', '주간'])
  assert.deepEqual(tray.usageItems(usage, 0).map((item) => item.window), ['5시간', '주간', '2일', '3시간', '90분', '주간'])
})

test('메뉴 막대 요약: 아테나 작업 공간은 옛 폴더 이름이어도 athena 로 보인다', () => {
  const core = require('../src/lib/core.mts')
  const dir = '/Users/me/.athena-studio/bodies/new-20261025-184407'
  const workspaces = core.displayWorkspaces([{ id: 'w1', label: 'new-20261025-184407', cwd: dir }], dir)
  const summary = tray.summarize({ panes: [{ id: 'p1', agent: 'claude', agent_status: 'working', workspace_id: 'w1', label: 'athena' }], workspaces })
  assert.equal(summary.agents[0].workspace, 'athena')
})

// 검수 #14 — Claude 허락 하나에 알림이 세 번 났다: 화면 감지 요청(permission-pane:…) → 몇 초 뒤 코어 perm 요청이 같은 건을 새 id 로 바꿔 받음 → pane 입력 대기.
// pane 마다 한 건(허락 창이 열려 있거나 입력을 기다리는 동안)은 한 번만 알린다 — [작업] 목록 · 트레이 표시는 그대로
test('알림: 같은 pane 의 허락 한 건은 화면 감지 · 코어 perm · 입력 대기 중 한 번만 · 풀린 뒤 새 허락은 다시 알린다', () => {
  const notifier = new tray.Notifier()
  const names = new Map([['w1', 'athena']])
  const permission = (id) => ({ id, kind: 'question', state: 'open', title: 'p1 · 권한 확인', pane: 'p1', permission: true })
  notifier.updateRequests([])
  notifier.update({ panes: [pane('p1', 'working')], names }, 0)
  const found = [...notifier.updateRequests([permission('permission-pane:p1:1000')])]
  found.push(...notifier.updateRequests([permission('perm-p1')]))
  notifier.update({ panes: [pane('p1', 'waiting')], names }, 1000)
  found.push(...notifier.update({ panes: [pane('p1', 'waiting')], names }, 1000 + tray.WAIT_HOLD_MS))
  assert.deepEqual(found.map((item) => item.kind), ['request'])
  // 다른 pane 의 요청은 따로 알린다
  assert.equal(notifier.updateRequests([permission('perm-p1'), { ...permission('perm-p2'), pane: 'p2' }]).length, 1)
  // 답해서 허락 창이 닫히고 일하기 시작하면 한 건이 끝난다 — 다음 허락은 다시 알린다
  notifier.updateRequests([])
  notifier.update({ panes: [pane('p1', 'working')], names }, 10000)
  assert.equal(notifier.updateRequests([permission('perm-p1-next')]).length, 1)
  // 입력 대기가 먼저 알렸으면 이어 열린 같은 pane 의 허락 요청은 알리지 않는다
  const waitingFirst = new tray.Notifier()
  waitingFirst.updateRequests([])
  waitingFirst.update({ panes: [pane('p1', 'working')], names }, 0)
  waitingFirst.update({ panes: [pane('p1', 'waiting')], names }, 1000)
  assert.equal(waitingFirst.update({ panes: [pane('p1', 'waiting')], names }, 1000 + tray.WAIT_HOLD_MS).length, 1)
  assert.deepEqual(waitingFirst.updateRequests([permission('perm-p1')]), [])
  // 허락이 아닌 질문은 그대로 알린다
  assert.equal(waitingFirst.updateRequests([permission('perm-p1'), { id: 'q', kind: 'question', state: 'open', title: '질문', pane: 'p1', permission: false }]).length, 1)
})
