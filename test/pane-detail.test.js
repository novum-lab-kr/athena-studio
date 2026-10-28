const test = require('node:test')
const assert = require('node:assert/strict')
const detail = require('../src/lib/pane-detail.mts')

const NOW = Date.parse('2026-10-26T14:00:00+09:00')
const plan = (id, extra = {}) => ({ kind: 'plan', id, title: id, status: 'in_progress', agents: [], mtime: NOW - 60000, ...extra })

test('묶인 pane: 에이전트 pane 은 agent · 맡긴 아테나 pane 은 lead(옛 w2:p33 은 끝 부분으로) · 둘 다면 agent', () => {
  const cards = [
    plan('plans/task/a.md', { agents: ['p87'], leadPane: 'p67' }),
    plan('plans/feature/b.md', { leadPane: 'w2:p33' }),
    { kind: 'issue', id: 'issues/x.md', title: '이슈', linkedPlan: { id: 'plans/task/c.md', status: 'in_progress', agents: ['p90'], leadPane: 'p87' } },
    plan('plans/archive/old.md', { archived: true, agents: ['p1'] }),
  ]
  assert.deepEqual(detail.bindings(cards), { p87: 'agent', p67: 'lead', p33: 'lead', p90: 'agent' })
  assert.equal(detail.samePane('w2:p33', 'p33'), true)
  assert.equal(detail.samePane('p333', 'p33'), false)
})

test('아테나 pane(일감 role hermes)은 맡긴 일이 다 보관돼 카드에 없어도 lead · 에이전트 · 그 밖 pane 은 그대로', () => {
  const cards = [plan('plans/task/a.md', { status: 'done', agents: ['p82'] })]
  const panes = [
    { kind: 'pane', id: 'p67', role: 'hermes' },
    { kind: 'pane', id: 'p82', role: 'agent' },
    { kind: 'pane', id: 'p90', role: 'other' },
  ]
  assert.deepEqual(detail.bindings(cards, panes), { p82: 'agent', p67: 'lead' })
  assert.deepEqual(detail.bindings([], null), {})
})

test('에이전트 pane 의 계획서: 끝나지 않은 것 먼저, 그다음 최근에 고친 것', () => {
  const cards = [
    plan('plans/task/done.md', { status: 'done', agents: ['p5'], mtime: NOW }),
    plan('plans/task/old.md', { agents: ['p5'], mtime: NOW - 999999 }),
    plan('plans/task/new.md', { agents: ['p5'], mtime: NOW - 10 }),
  ]
  assert.equal(detail.agentPlan(cards, 'p5').id, 'plans/task/new.md')
  assert.equal(detail.agentPlan(cards, 'p6'), null)
})

test('아테나 pane 이 맡긴 일: 나를 기다림 → 지금 → 오늘 끝남(보관한 것 포함) · 어제 끝난 것은 뺀다', () => {
  const cards = [
    plan('plans/task/now.md', { leadPane: 'p67', agents: ['p87'], statusNote: '고치는 중' }),
    plan('plans/task/wait.md', { leadPane: 'p67', status: 'blocked', blocked: '키가 없다' }),
    plan('plans/task/today.md', { leadPane: 'p67', status: 'done', doneAt: NOW - 3600000 }),
    plan('plans/task/yesterday.md', { leadPane: 'p67', status: 'done', doneAt: NOW - 86400000 }),
    plan('plans/task/other.md', { leadPane: 'p9' }),
  ]
  const history = [
    { dir: 'archive/kept', title: '보관한 일', archivedAt: '2026-10-26 10:00', leadPane: 'p67' },
    { dir: 'archive/older', title: '지난 일', archivedAt: '2026-10-25 10:00', leadPane: 'p67' },
  ]
  const rows = detail.leadRows(cards, history, 'p67', { panes: [{ id: 'p87', agent: 'web-fe' }], since: { p87: NOW - 5 * 60000 }, now: NOW })
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [
    ['plans/task/wait.md', 'wait'],
    ['plans/task/now.md', 'now'],
    ['plans/task/today.md', 'done'],
    ['archive/kept', 'done'],
  ])
  assert.equal(rows[0].what, '키가 없다')
  assert.deepEqual([rows[1].who, rows[1].what, rows[1].paneId, rows[1].sinceMs], ['web-fe', '고치는 중', 'p87', 5 * 60000])
  // 열린 요청이 있는 계획서도 나를 기다림
  assert.equal(detail.leadRows(cards, [], 'p67', { waitingPlans: new Set(['plans/task/now.md']), now: NOW })[0].id, 'plans/task/now.md')
})

// 실제 Claude Code 화면 모양(2026-10-26 pane read) — 말은 '⏺ ' 로 시작하고 둘째 줄부터 두 칸 들여 쓴다
const SCREEN = [
  '❯ 이거 고쳐줘',
  '',
  '⏺ 먼저 **현재 상태**를 확인합니다.',
  '',
  '⏺ Bash(git status --short)',
  '  ⎿  (No content)',
  '',
  '  Ran 2 shell commands',
  '',
  '⏺ 고쳤습니다. `npm test` 통과입니다.',
  '',
  '  - 바꾼 파일: src/a.js',
  '  Read 3 files',
  '  - 남은 일: 없음',
  '',
  '✻ Crunched for 2m 8s · done 11:15 PM',
  '─────',
  '❯ ',
].join('\n')

test('화면 글: 지금 하는 일 한 줄은 마지막 말의 첫 줄 · 최근 보고는 그 말 전체(접힌 도구 줄은 뺀다)', () => {
  const digest = detail.screenDigest(SCREEN)
  assert.equal(digest.now, '고쳤습니다. npm test 통과입니다.')
  assert.deepEqual(digest.report, ['고쳤습니다. npm test 통과입니다.', '', '- 바꾼 파일: src/a.js', '- 남은 일: 없음'])
  assert.equal(digest.heavy, false)
  // 한 줄짜리 말은 보고로 치지 않는다 — 마지막 말이 한 줄이면 그 앞의 여러 줄 보고를, 없으면 비운다
  assert.deepEqual(detail.screenDigest('⏺ 확인 중입니다.\n✻ Working… (esc to interrupt)').report, [])
  const later = detail.screenDigest(`${SCREEN}\n⏺ 검증을 돌리는 중입니다.\n✻ Working… (esc to interrupt)`)
  assert.equal(later.now, '검증을 돌리는 중입니다.')
  assert.equal(later.report[0], '고쳤습니다. npm test 통과입니다.')
  assert.equal(detail.screenDigest('⏺ Bash(npm test)\n  ⎿  ⏳ 대기 30초 — 다른 무거운 명령이 도는 중').heavy, true)
  // 모르는 화면(codex 등)은 비운다
  assert.deepEqual(detail.screenDigest('• codex says hi'), { now: '', report: [], heavy: false })
})

test('지금 상태: 고르기 질문 · 요청 · 무거운 명령 대기 · 막힘은 멈춤, 에이전트가 없으면 gone', () => {
  assert.deepEqual(detail.nowState({ agentStatus: 'working' }), { state: 'work', reason: null })
  assert.deepEqual(detail.nowState({ agentStatus: 'working', heavy: true }), { state: 'stop', reason: 'heavy' })
  assert.deepEqual(detail.nowState({ agentStatus: 'idle', waiting: true }), { state: 'stop', reason: 'question' })
  assert.deepEqual(detail.nowState({ agentStatus: 'idle', hasRequest: true }), { state: 'stop', reason: 'request' })
  assert.deepEqual(detail.nowState({ agentStatus: 'idle', planStatus: 'blocked' }), { state: 'stop', reason: 'blocked' })
  assert.deepEqual(detail.nowState({ agentStatus: 'idle' }), { state: 'idle', reason: null })
  assert.deepEqual(detail.nowState({ agentStatus: null }), { state: 'gone', reason: null })
})

test('계획서 기록: 요청(## 지시) · 진행 · 다음 · 막힘(없음 · 자리 글은 뺀다) · 검증 · PR · 자동 리뷰 줄', () => {
  const text = [
    '# 버튼 고치기',
    '',
    '## Checkpoint',
    '- Status: ready_for_review — 리뷰 대기',
    '- PR: https://github.com/acme/web/pull/12 (fix → main)',
    '- Auto review: web#12 @abc1234 · 승인',
    '- Review result: 승인 @abc1234',
    '',
    '### Progress',
    '- [x] 재현',
    '- [ ] 고치기',
    '',
    '### Next',
    '1. 리뷰 받기',
    '',
    '### Blocked',
    '- 없음',
    '',
    '### Validation',
    '- (검증 스크립트 출력 표)',
    '- npm test 통과',
    '',
    '## 지시',
    '> 버튼이 안 눌려요',
    '',
    '### 요청 2',
    '> 색도 바꿔줘',
  ].join('\n')
  const record = detail.planRecord(text)
  assert.equal(record.title, '버튼 고치기')
  assert.equal(record.status, 'ready_for_review')
  assert.equal(record.statusNote, '리뷰 대기')
  assert.deepEqual(record.request, ['버튼이 안 눌려요', '요청 2', '색도 바꿔줘'])
  assert.deepEqual(record.progress, [{ done: true, text: '재현' }, { done: false, text: '고치기' }])
  assert.deepEqual(record.next, ['리뷰 받기'])
  assert.deepEqual(record.blocked, [])
  assert.deepEqual(record.validation, ['npm test 통과'])
  assert.deepEqual(record.prs, ['https://github.com/acme/web/pull/12'])
  assert.deepEqual(record.autoReview, ['web#12 @abc1234 · 승인'])
  assert.equal(record.reviewResult, '승인 @abc1234')
  // 정식 계획서 — 개요의 요청 사항 아래 번호 줄
  const formal = detail.planRecord('# 큰 일\n## 1. 개요\n- 요청 사항(사용자):\n  1. 이름 바꾸기\n  2. 상세 보기\n- 대상: x\n')
  assert.deepEqual(formal.request, ['이름 바꾸기', '상세 보기'])
})

test('상세 계획서 칸: 원문 제목이 비면 일감 카드 제목 · 있으면 원문 제목 · 나머지 원문 칸은 그대로', () => {
  const card = plan('plans/task/a.md', { title: '카드 제목', created: 5, html: 'plans/task/a.html' })
  // 원문을 못 읽음 — 빈 제목이 카드 제목을 덮지 않는다
  const unread = detail.detailPlan(card, detail.planRecord(''), false)
  assert.equal(unread.title, '카드 제목')
  assert.equal(unread.readable, false)
  assert.deepEqual(unread.progress, [])
  // 원문 제목이 있으면 그쪽
  const read = detail.detailPlan(card, detail.planRecord('# 원문 제목\n## Checkpoint\n- Status: done\n'), true)
  assert.equal(read.title, '원문 제목')
  assert.equal(read.status, 'done')
  assert.equal(read.id, 'plans/task/a.md')
  assert.equal(read.html, 'plans/task/a.html')
  assert.equal(read.created, 5)
})
