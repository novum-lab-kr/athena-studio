const test = require('node:test')
const assert = require('node:assert/strict')
const work = require('../src/lib/work-model.mts')

const NOW = Date.parse('2026-10-21T06:00:00.000Z')
const plan = (id, extra = {}) => ({ kind: 'plan', id, title: id, status: 'in_progress', column: 'doing', grade: 'light', mtime: NOW - 60000, ...extra })

test('목록: 진행 중은 답 기다림 → 막힘 → 일하는 중 → 쉬는 중 · 같으면 최근 것 먼저', () => {
  const cards = [
    plan('plans/task/idle.md', { mtime: NOW - 1000, agents: ['p1'] }),
    plan('plans/task/work.md', { working: true }),
    plan('plans/task/blocked.md', { status: 'blocked', blocked: '키가 없다', agents: ['p2'] }),
    plan('plans/feature/wait.md', { grade: 'formal', status: 'planned', column: 'plan' }),
    plan('plans/task/idle-old.md', { mtime: NOW - 99999, agents: ['p3'] }),
  ]
  const result = work.workList(cards, [{ plan: 'plans/feature/wait.md' }], NOW)
  assert.deepEqual(result.doing.map((item) => item.state), ['wait', 'blocked', 'work', 'idle', 'idle'])
  assert.deepEqual(result.doing.slice(-2).map((item) => item.id), ['plans/task/idle.md', 'plans/task/idle-old.md'])
  assert.equal(result.doing[1].line, '키가 없다')
  assert.equal(result.doing[0].grade, 'formal')
  assert.equal(result.counts.doing, 5)
})

test('목록: 진행 중은 pane 이나 요청이 있을 때만 — 없으면 Status 와 상관없이 빠진다', () => {
  const cards = [
    plan('plans/task/none.md'),
    plan('plans/task/blocked-none.md', { status: 'blocked', blocked: '키가 없다' }),
    plan('plans/task/review-none.md', { status: 'ready_for_review', column: 'review' }),
    plan('plans/task/idle-pane.md', { agents: ['p1'] }),
    plan('plans/task/asked.md'),
    plan('plans/task/done-pane.md', { status: 'done', column: 'done', agents: ['p2'], mtime: NOW - 1000 }),
  ]
  const result = work.workList(cards, [{ plan: 'plans/task/asked.md' }], NOW)
  assert.deepEqual(result.doing.map((item) => item.id), ['plans/task/asked.md', 'plans/task/idle-pane.md'])
  assert.equal(result.counts.doing, 2)
  assert.deepEqual(result.done.map((item) => item.id), ['plans/task/done-pane.md'])
})

test('목록: 한 줄 요약 — 상태 메모 또는 다음 + 진행률', () => {
  const [item] = work.workList([plan('plans/task/a.md', { next: 'web 맞추기', progress: { checked: 2, total: 3 }, agents: ['p1'] })], [], NOW).doing
  assert.equal(item.line, 'web 맞추기 · 2/3')
  const [noted] = work.workList([plan('plans/task/b.md', { statusNote: '리뷰 대기', next: '무시', agents: ['p1'] })], [], NOW).doing
  assert.equal(noted.line, '리뷰 대기')
})

test('목록: 최근 끝난 것은 24시간 안 · 최근 순 · 보관한 것과 계획서 없는 이슈는 뺀다', () => {
  const cards = [
    plan('plans/task/old.md', { status: 'done', column: 'done', mtime: NOW - 25 * 3600000 }),
    plan('plans/task/new.md', { status: 'done', column: 'done', mtime: NOW - 3600000 }),
    plan('plans/task/archived.md', { archived: true }),
    { kind: 'issue', id: 'issues/x.md', title: '이슈만', column: 'issue' },
  ]
  const result = work.workList(cards, [], NOW)
  assert.deepEqual(result.done.map((item) => item.id), ['plans/task/new.md'])
  assert.equal(result.doing.length, 0)
  // 완료로 바뀐 시각(doneAt)이 있으면 그것으로 — 끝난 뒤 계획서를 고쳐 mtime 이 지금이어도 다시 "방금 완료" 가 아니다
  const edited = work.workList([
    plan('plans/task/edited.md', { status: 'done', column: 'done', mtime: NOW - 1000, doneAt: NOW - 30 * 3600000 }),
    plan('plans/task/fresh.md', { status: 'done', column: 'done', mtime: NOW - 26 * 3600000, doneAt: NOW - 3600000 }),
  ], [], NOW)
  assert.deepEqual(edited.done.map((item) => item.id), ['plans/task/fresh.md'])
})

test('목록: 이슈에 붙은 계획서는 이슈 제목 · 계획서 id 로', () => {
  const cards = [{ kind: 'issue', id: 'issues/i.md', title: '이슈 제목', column: 'doing', linkedPlan: { id: 'plans/task/p.md', status: 'in_progress', working: true, mtime: NOW } }]
  const [item] = work.workList(cards, [], NOW).doing
  assert.equal(item.id, 'plans/task/p.md')
  assert.equal(item.title, '이슈 제목')
  assert.equal(item.state, 'work')
})

const PLAN_MD = `# 쿠폰 적용 순서 바꾸기

## Checkpoint
- Updated: 2026-10-21 / 아테나
- Status: in_progress
- PR: https://github.com/acme/acme-api/pull/97 (머지)

### Progress
- [x] api 수정 — 머지
- [ ] web 할인 표시 순서 맞추기
- [ ] 리뷰

### Next
1. web 할인 표시 순서 맞추기

### Blocked
- 없음

### Validation
- api: lint · tsc · test(118) 통과
- web: 아직

### Decisions
- D1 쿠폰 먼저 계산
- D2 이미 발급한 쿠폰은 그대로

## 1. 개요
- 작업 유형: feature
- 요청 사항: 할인이 쿠폰보다 먼저 계산돼 결제 금액이 화면과 다르다
`

test('상세: 왜 · 정한 것 · 진행 · 검증 · 결과 · 다음', () => {
  const detail = work.planDetail(PLAN_MD)
  assert.equal(detail.why, '할인이 쿠폰보다 먼저 계산돼 결제 금액이 화면과 다르다')
  assert.deepEqual(detail.decided, ['D1 쿠폰 먼저 계산', 'D2 이미 발급한 쿠폰은 그대로'])
  assert.deepEqual(detail.progress, { checked: 1, total: 3, now: 'web 할인 표시 순서 맞추기' })
  assert.equal(detail.validation, 'api: lint · tsc · test(118) 통과')
  assert.deepEqual(detail.results, ['https://github.com/acme/acme-api/pull/97'])
  assert.equal(detail.next, 'web 할인 표시 순서 맞추기')
  assert.equal(detail.blocked, '')
})

test('상세: 요청 사항이 없으면 제목 아래 첫 문단 · 비어 있어도 깨지지 않는다', () => {
  assert.equal(work.planDetail('# 일\n\n로그인 오류 고치기\n\n## Checkpoint\n- Status: planned\n').why, '로그인 오류 고치기')
  const empty = work.planDetail('')
  assert.equal(empty.why, '')
  assert.deepEqual(empty.progress, { checked: 0, total: 0, now: '' })
  assert.deepEqual(empty.decided, [])
})

test('상세: 고치지 않은 템플릿 자리 줄은 진행 칸으로 세지 않는다(코어가 알려 준 줄)', () => {
  const placeholder = '- [ ] (작업) → 확인: (방법) → 성공 조건: (기대 결과)'
  const text = `# 일\n\n## Checkpoint\n- Status: done\n\n### Progress\n- [x] 구현\n${placeholder}\n\n### Next\n1. 없음\n`
  assert.deepEqual(work.planDetail(text).progress, { checked: 1, total: 2, now: '(작업) → 확인: (방법) → 성공 조건: (기대 결과)' })
  assert.deepEqual(work.planDetail(text, [placeholder]).progress, { checked: 1, total: 1, now: '' })
})

test('다이어그램 목록: 앱 언어 목록이 있으면 그것 · 없거나 한국어면 index.html', () => {
  const files = new Set(['index.html', 'index.en.html', 'index.ja.html'])
  const exists = (file) => files.has(file)
  assert.equal(work.diagramIndexFile('ko', exists), 'index.html')
  assert.equal(work.diagramIndexFile('en', exists), 'index.en.html')
  assert.equal(work.diagramIndexFile('ja', exists), 'index.ja.html')
  // 언어별 목록을 만들지 않는 옛 코어 · 이상한 값은 한국어 목록
  assert.equal(work.diagramIndexFile('zh', exists), 'index.html')
  assert.equal(work.diagramIndexFile('../x', () => true), 'index.html')
})

test('폰 목록(mobileWork): 맥 [작업] 과 같은 묶음 · 순서 · 칸 — html 경로만 빼고 agents 는 pane id 문자열만', () => {
  const cards = [
    plan('plans/task/work.md', { working: true, html: '/abs/plans/task/work.html', agents: ['p1', { id: 'p9' }, 7], next: '시험 추가', progress: { checked: 1, total: 4 } }),
    plan('plans/feature/wait.md', { grade: 'formal', scope: 'hermes' }),
    plan('plans/task/none.md'),
    plan('plans/task/done.md', { status: 'done', column: 'done', doneAt: NOW - 5000, html: '/abs/plans/task/done.html' }),
  ]
  const requests = [{ plan: 'plans/feature/wait.md', state: 'answered' }]
  const mac = work.workList(cards, requests, NOW)
  const phone = work.mobileWork(cards, requests, NOW)
  assert.deepEqual(phone.doing.map((item) => item.id), mac.doing.map((item) => item.id))
  assert.deepEqual(phone.done.map((item) => item.id), mac.done.map((item) => item.id))
  assert.deepEqual(phone.doing, [
    { id: 'plans/feature/wait.md', title: 'plans/feature/wait.md', line: '', state: 'wait', grade: 'formal', maintenance: true, agents: [], mtime: NOW - 60000, doneAt: NOW - 60000 },
    { id: 'plans/task/work.md', title: 'plans/task/work.md', line: '시험 추가 · 1/4', state: 'work', grade: 'light', maintenance: false, agents: ['p1'], mtime: NOW - 60000, doneAt: NOW - 60000 },
  ])
  assert.deepEqual(phone.done, [{ id: 'plans/task/done.md', title: 'plans/task/done.md', line: '', state: 'done', grade: 'light', maintenance: false, agents: [], mtime: NOW - 60000, doneAt: NOW - 5000 }])
  assert.equal(JSON.stringify(phone).includes('/abs/'), false, 'html 절대 경로는 싣지 않는다')
  assert.deepEqual(work.mobileWork(null, null, NOW), { doing: [], done: [] })
})

test('폰 작업 읽기(createWorkPeek): 맥처럼 현황판을 띄워 읽는다 · 겹친 부름은 한 번 · 띄운 뒤 잠깐은 읽기만 · 꺼졌으면 다시 띄운다', async () => {
  const cards = [plan('plans/task/work.md', { working: true })]
  let clock = NOW, ensures = 0, reads = 0, up = false, release = null
  const peek = work.createWorkPeek({
    dir: () => '/body',
    ensure: async () => {
      ensures += 1
      if (release) await release
      up = true
      return { ok: true }
    },
    cards: async () => {
      reads += 1
      return up ? cards : null
    },
    requests: () => [],
    now: () => clock,
    reuseMs: 1000,
  })
  // 겹친 부름 셋 — 띄우기 한 번을 같이 기다린다
  let open
  release = new Promise((resolve) => (open = resolve))
  const together = [peek(), peek(), peek()]
  open()
  const results = await Promise.all(together)
  assert.equal(ensures, 1)
  for (const result of results) assert.deepEqual(result.doing.map((item) => item.id), ['plans/task/work.md'])
  assert.equal(results[0].boardUp, true)
  assert.equal(results[0].boardError, null)
  release = null
  // 재사용 시간 안 — 띄우기(pack status)를 다시 돌리지 않고 읽기만
  clock += 500
  await peek()
  assert.equal(ensures, 1)
  // 그 사이 현황판이 꺼졌으면 바로 다시 띄운다
  up = false
  assert.equal((await peek()).boardUp, true)
  assert.equal(ensures, 2)
  // 재사용 시간이 지나면 다시 확인한다
  clock += 1001
  await peek()
  assert.equal(ensures, 3)
  assert.ok(reads >= 4)
})

test('폰 작업 읽기(createWorkPeek): 못 띄우면 던지지 않고 boardUp:false + 이유 한 줄 · 읽는 사이 팩이 바뀌면 지난 팩 카드를 안 보낸다', async () => {
  const failed = work.createWorkPeek({ dir: () => '/body', ensure: async () => ({ ok: false, error: '포트 4814 를 다른 프로그램이 쓰고 있어요' }), cards: async () => null, requests: () => [] })
  assert.deepEqual(await failed(), { boardUp: false, boardError: '포트 4814 를 다른 프로그램이 쓰고 있어요', doing: [], done: [] })
  const thrown = work.createWorkPeek({ dir: () => '/body', ensure: async () => { throw new Error('boom') }, cards: async () => null, requests: () => [] })
  assert.deepEqual(await thrown(), { boardUp: false, boardError: null, doing: [], done: [] })
  // 띄웠다는데 못 읽음
  const unreadable = work.createWorkPeek({ dir: () => '/body', ensure: async () => ({ ok: true }), cards: async () => null, requests: () => [] })
  assert.deepEqual(await unreadable(), { boardUp: false, boardError: null, doing: [], done: [] })
  let dir = '/body-a'
  const switched = work.createWorkPeek({
    dir: () => dir,
    ensure: async () => ({ ok: true }),
    cards: async () => {
      dir = '/body-b'
      return [plan('plans/task/a.md', { working: true })]
    },
    requests: () => [],
  })
  assert.deepEqual(await switched(), { boardUp: false, boardError: null, doing: [], done: [] })
})
