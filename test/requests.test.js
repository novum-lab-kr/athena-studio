const test = require('node:test')
const assert = require('node:assert/strict')
const requests = require('../src/lib/requests.mts')

const sample = (extra = {}) => ({
  id: 'r-20261021-141520-1080', kind: 'question', title: '필드가 있나요?', body: '근거', state: 'open', rev: 2,
  options: [{ label: '있다', desc: '표시' }, { label: '없다', recommended: true }, { desc: '라벨 없음' }],
  links: { plan: 'plans/task/x.md', html: null }, pane: 'w1:p3', createdAt: '2026-10-21T05:15:20.000Z', ...extra,
})

test('목록: 열린 것(open · answered)만 · 오래된 것 먼저 · 화면 모양', () => {
  const result = requests.normalizeRequests({ ok: true, requests: [
    sample({ id: 'r-2', createdAt: '2026-10-21T06:00:00.000Z' }),
    sample({ id: 'r-1', state: 'answered' }),
    sample({ id: 'r-3', state: 'delivered' }),
    sample({ id: 'r-4', kind: 'other' }),
  ] })
  assert.equal(result.supported, true)
  assert.deepEqual(result.requests.map((request) => request.id), ['r-1', 'r-2'])
  const first = result.requests[0]
  assert.equal(first.plan, 'plans/task/x.md')
  assert.equal(first.pane, 'w1:p3')
  // 36진수 pane id(2026-10-28 — p6f)도 그대로 옮긴다(앱은 pane list 의 id 와 글자 그대로 비교해 넣는다 — main/work.mts deliverToPane)
  assert.equal(requests.normalizeRequests({ ok: true, requests: [sample({ pane: 'p6f' })] }).requests[0].pane, 'p6f')
  assert.deepEqual(first.options.map((option) => option.label), ['있다', '없다'])
  assert.equal(first.options[1].recommended, true)
})

test('목록: 허락 창 알림(코어 키 perm:<pane>)이면 permission · 다른 키 · 키 없음은 아님', () => {
  const [perm, other, none] = requests.normalizeRequests({ ok: true, requests: [
    sample({ id: 'r-1', dedupeKey: 'perm:p3', createdAt: '2026-10-21T01:00:00.000Z' }),
    sample({ id: 'r-2', dedupeKey: 'plan:plans/task/x.md', createdAt: '2026-10-21T02:00:00.000Z' }),
    sample({ id: 'r-3', createdAt: '2026-10-21T03:00:00.000Z' }),
  ] }).requests
  assert.deepEqual([perm.permission, other.permission, none.permission], [true, false, false])
})

test('목록: request 명령이 없는 옛 코어는 supported:false · 일시 실패는 supported 유지', () => {
  assert.equal(requests.normalizeRequests({ ok: false, error: 'usage' }).supported, false)
  assert.equal(requests.normalizeRequests({ ok: false, error: 'bad-output' }).supported, false)
  assert.equal(requests.normalizeRequests({ ok: false, error: 'locked' }).supported, true)
  assert.deepEqual(requests.normalizeRequests(null).requests, [])
})

test('배지 숫자는 아직 답하지 않은 것(open)만', () => {
  assert.equal(requests.waitingCount([{ state: 'open' }, { state: 'answered' }, { state: 'open' }]), 2)
  assert.equal(requests.waitingCount(null), 0)
})

test('기다린 시간', () => {
  const now = Date.parse('2026-10-21T06:00:00.000Z')
  assert.equal(requests.waitedLabel('2026-10-21T05:59:50.000Z', now), '1분')
  assert.equal(requests.waitedLabel('2026-10-21T05:48:00.000Z', now), '12분')
  assert.equal(requests.waitedLabel('2026-10-21T03:00:00.000Z', now), '3시간')
  assert.equal(requests.waitedLabel('2026-10-18T06:00:00.000Z', now), '3일')
  assert.equal(requests.waitedLabel('모름', now), '')
})

test('답하기 인자 — 빈 값은 빼고 rev 는 정수일 때만', () => {
  assert.deepEqual(requests.answerArgs('r-1', { choice: ' 없다 ', text: '', rev: 2 }), ['request', 'answer', 'r-1', '--by', 'app', '--choice', '없다', '--rev', '2'])
  assert.deepEqual(requests.answerArgs('r-1', { text: '이름은 cancel_note' }), ['request', 'answer', 'r-1', '--by', 'app', '--text', '이름은 cancel_note'])
})

test('답하기 충돌 — 보여 준 rev 와 지금 rev 가 다르면 conflict · rev 를 안 보낸 호출은 지금처럼', () => {
  assert.equal(requests.answerRevChanged(2, 3), true)
  assert.equal(requests.answerRevChanged(2, 2), false)
  assert.equal(requests.answerRevChanged(undefined, 3), false)
  assert.equal(requests.answerRevChanged(null, 3), false)
  assert.equal(requests.answerRevChanged('2', 3), false)
  assert.equal(requests.answerRevChanged(1.5, 3), false)
})

test('화면 요청에 rev 가 실린다(답할 때 돌려보낸다)', () => {
  assert.equal(requests.normalizeRequests({ ok: true, requests: [sample({ rev: 7 })] }).requests[0].rev, 7)
})

test('pane 에 넣을 한 줄 — 요청 번호 · 줄바꿈 없음', () => {
  const line = requests.deliveryLine(sample(), { choice: '있다', text: '이름은\ncancel_note' })
  assert.equal(line, '[요청 r-20261021-141520-1080] 필드가 있나요? — 답: 있다 · 이름은 cancel_note')
})

test('새로 생긴 open 요청만(알림용)', () => {
  const list = [{ id: 'a', state: 'open' }, { id: 'b', state: 'open' }, { id: 'c', state: 'answered' }]
  assert.deepEqual(requests.newlyOpened(['a'], list).map((request) => request.id), ['b'])
  assert.deepEqual(requests.newlyOpened(new Set(), list).map((request) => request.id), ['a', 'b'])
})

// 실제 installWork를 Electron 없이 실행한다. 제품 소스의 타입·import만 떼고 경계 의존성을 가짜로 넣는다.
const makePermissionWork = () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
  const { stripTypeScriptTypes } = require('node:module')
  const screenModel = require('../src/lib/screen-model.js')
  const file = process.env.ATHENA_PERMISSION_BASE_WORK || path.join(__dirname, '../src/main/work.mts')
  const source = stripTypeScriptTypes(fs.readFileSync(file, 'utf8')).replace(/^import .*$/gm, '').replace(/^const screenModel\s*=.*$/gm, '').replace('export function installWork', 'function installWork')
  let approvals = []
  let now = 0, state = { supported: true, requests: [], error: null }, rows = [], failed = false
  const panes = new Map(), intervals = new Map(), calls = [], sent = []
  class Clock extends Date { static now() { return now } }
  const { installWork } = vm.runInNewContext(source + '\n({installWork})', {
    fs, path, Date: Clock, requestsModel: requests, screenModel,
    pendingApprovals: async () => approvals, respondApproval: async (...args) => { calls.push(['approval', ...args]); return true },
    core: { checkAthenaDir: () => ({ ok: true }) },
    setInterval: (callback, ms) => { intervals.set(ms, callback); return ms }, clearInterval: (ms) => intervals.delete(ms),
    setTimeout, clearTimeout,
  })
  const ctx = { athenaDir: '/fixture/body', send: (...args) => sent.push(args),
    peekCall: async (op, args) => {
      if (op === 'pane list') return { result: { panes: [...panes.keys()].map((id) => ({ id, agent: 'codex' })) } }
      if (failed) return { error: 'unavailable' }
      return { result: { text: panes.get(args.pane) || '' } }
    }, daemonCall: async (...args) => { calls.push(['daemon', ...args]); return { result: {} } },
  }
  installWork(ctx, { say: (key, values) => key + (values?.pane || ''),
    runCore: async (args) => {
      calls.push(args)
      if (args[1] === 'list') return { ok: true, requests: rows }
      if (args[1] === 'cancel') { rows = rows.filter((row) => row.id !== args[2]); return { ok: true } }
      return { ok: true, request: { answer: { choice: '선택' } } }
    }, requestsPollMs: 30000, trayRequestsChanged: () => {}, requestsState: () => state, setRequestsState: (next) => { state = next }, logRequestsError: () => {},
  })
  return { ctx, calls, sent, panes, intervals,
    setApprovals: (value) => { approvals = value },
    setRows: (value) => { rows = value }, fail: (value) => { failed = value }, state: () => state,
    async start() { ctx.watchRequests(); await new Promise(setImmediate); await ctx.refreshRequests(); await new Promise(setImmediate) },
    async tick(ms) { now += ms; const poll = intervals.get(2000); if (poll) await poll(); await new Promise(setImmediate) },
  }
}
const browserPrompt = ['Field 1/1', 'Allow Browser use to access https://example.com/private?token=SHOULD_NOT_LEAK?', '1. Allow Run the tool and continue', '2. Always allow Run the tool and remember this choice for future tool calls', '3. Cancel Cancel this tool call', 'enter to submit | esc to cancel'].join('\n')
const trustPrompt = ['permission settings. Folder settings can run code automatically, even without a model request.', 'Your trust decision will be saved.', '1. Trust and continue', '2. Quit', 'enter continue · esc quit'].join('\n')

test('실제 작업 경로: Browser·시작 신뢰 자동 알림, 민감 화면 미수집·중복 방지·일반 답변 차단', async () => {
  const fixture = makePermissionWork()
  fixture.panes.set('fixture-browser', browserPrompt); fixture.panes.set('fixture-trust', trustPrompt)
  await fixture.start(); assert.equal(fixture.state().requests.length, 0)
  await fixture.tick(4000)
  const visible = fixture.state().requests
  assert.equal(visible.length, 2)
  assert.deepEqual(Array.from(visible, (item) => item.permissionKind).sort(), ['browser', 'trust'])
  assert.ok(!JSON.stringify(visible).includes('SHOULD_NOT_LEAK'))
  assert.ok(!JSON.stringify(visible).includes('/private'))
  assert.ok(visible.every((item) => item.permission && item.options.length === 0))
  const ids = Array.from(visible, (item) => item.id)
  await fixture.tick(2000); assert.deepEqual(Array.from(fixture.state().requests, (item) => item.id), ids)
  for (const request of visible) {
    const result = await fixture.ctx.answerRequest(request.id, { choice: 'Allow', rev: request.rev })
    assert.equal(result.ok, false)
  }
  assert.ok(!fixture.calls.some((args) => args[1] === 'answer' || args[0] === 'daemon'))
  fixture.ctx.stopRequests()
})

test('실제 작업 경로: 옛 수동 권한 알림은 현재 창이 닫힌 두 읽기 뒤 거두며, 읽기 실패는 닫힘이 아님', async () => {
  const fixture = makePermissionWork()
  fixture.setRows([
    sample({ id: 'old-browser', pane: 'fixture-pv4', dedupeKey: 'perm:fixture-pv4', options: [{ label: 'Allow' }] }),
    sample({ id: 'old-trust', pane: 'fixture-pv7', dedupeKey: 'perm:fixture-pv7' }),
    sample({ id: 'normal', pane: 'normal-pane' }),
  ])
  fixture.panes.set('fixture-pv4', browserPrompt); fixture.panes.set('fixture-pv7', trustPrompt)
  await fixture.start(); await fixture.tick(4000)
  assert.equal(fixture.state().requests.length, 3, '훅 알림과 화면 알림을 중복 표시하지 않음')
  assert.equal((await fixture.ctx.answerRequest('old-browser', { choice: 'Allow', rev: 2 })).ok, false)
  assert.ok(!fixture.calls.some((args) => args[1] === 'answer'))
  fixture.panes.set('fixture-pv4', '› Ask Codex to do anything'); fixture.panes.set('fixture-pv7', '')
  await fixture.tick(2000)
  fixture.fail(true); await fixture.tick(2000); await fixture.tick(2000)
  assert.equal(fixture.calls.filter((args) => args[1] === 'cancel').length, 0)
  fixture.fail(false); await fixture.tick(2000)
  assert.equal(fixture.calls.filter((args) => args[1] === 'cancel').length, 0, '읽기 실패는 연속 닫힘 횟수를 끊음')
  await fixture.tick(2000)
  assert.deepEqual(fixture.calls.filter((args) => args[1] === 'cancel').map((args) => args[2]).sort(), ['old-browser', 'old-trust'])
  assert.deepEqual(Array.from(fixture.state().requests, (item) => item.id), ['normal'])
  assert.ok(!fixture.calls.some((args) => args[0] === 'daemon'), '알림 정리는 원래 pane에 어떤 키도 보내지 않음')
  fixture.ctx.stopRequests()
})

test('권한 알림 tracker: 창 교체·종료·재시작·다른 pane 분리, 모르는 읽기는 새 확인이 아님', () => {
  const tracker = requests.createPermissionTracker()
  const seen = (kind) => [{ pane: 'test-pane', kind }]
  assert.equal(tracker.observe(seen('browser'), 0).requests.length, 0)
  assert.equal(tracker.observe(seen(undefined), 4000).requests.length, 0)
  const before = tracker.observe(seen('browser'), 5000).requests[0]
  assert.ok(before)
  assert.equal(tracker.observe(seen('trust'), 6000).requests.length, 0)
  const after = tracker.observe(seen('trust'), 10000).requests[0]
  assert.notEqual(before.id, after.id)
  assert.equal(tracker.observe([], 11000).requests.length, 0)
  tracker.observe(seen('browser'), 12000); tracker.reset()
  assert.equal(tracker.observe(seen('browser'), 16000).requests.length, 0)
})

test('실제 작업 경로: 종료한 pane 알림 제거·팩 재연결 뒤 지난 비동기 화면 결과 폐기', async () => {
  const fixture = makePermissionWork()
  fixture.panes.set('fixture-only', browserPrompt)
  await fixture.start(); await fixture.tick(4000)
  assert.equal(fixture.state().requests.length, 1)
  fixture.panes.clear(); await fixture.tick(2000)
  assert.equal(fixture.state().requests.length, 0)
  fixture.panes.set('fixture-only', trustPrompt)
  let release
  const original = fixture.ctx.peekCall
  fixture.ctx.peekCall = async (op, args) => {
    if (op === 'pane read') await new Promise((resolve) => { release = resolve })
    return original(op, args)
  }
  const stale = fixture.tick(4000)
  await new Promise(setImmediate)
  fixture.ctx.stopRequests(); fixture.ctx.athenaDir = '/fixture/other'
  fixture.ctx.peekCall = original
  await fixture.start()
  release(); await stale
  assert.equal(fixture.state().requests.length, 0)
  fixture.ctx.stopRequests()
})

test('이전 answered 권한 알림 재전송도 금지 · 일반 질문 응답 경로 보존', async () => {
  const fixture = makePermissionWork()
  fixture.panes.set('normal-pane', '')
  fixture.setRows([sample({ id: 'normal', pane: 'normal-pane' }), sample({ id: 'old-answered', dedupeKey: 'perm:normal-pane', pane: 'normal-pane', state: 'answered', answer: { choice: 'Allow' } })])
  await fixture.start()
  assert.equal((await fixture.ctx.redeliverRequest('old-answered')).ok, false)
  assert.equal((await fixture.ctx.answerRequest('normal', { choice: '선택', rev: 2 })).ok, true)
  assert.equal(fixture.calls.filter((args) => args[1] === 'answer').length, 1)
  assert.equal(fixture.calls.filter((args) => args[0] === 'daemon').length, 1)
  fixture.ctx.stopRequests()
})

test('긴 승인창: 제목이 화면 밖으로 밀려도 waiting이면 기존 알림과 감지 알림을 취소하지 않음', async () => {
  const fixture = makePermissionWork()
  fixture.setRows([sample({ id: 'long-permission', pane: 'long-pane', dedupeKey: 'perm:long-pane' })])
  fixture.panes.set('long-pane', browserPrompt)
  fixture.panes.set('detected-pane', browserPrompt)
  await fixture.start(); await fixture.tick(4000)
  const longApproval = [...Array.from({ length: 45 }, () => '  command output'), '› 1. Yes, proceed (y)', "  2. Yes, and don’t ask again", '  3. No (esc)', 'Press enter to confirm or esc to cancel'].join('\n')
  const longBrowser = [...Array.from({ length: 45 }, () => '  scope detail'), '1. Allow Run the tool and continue', '2. Always allow Run the tool and remember this choice for future tool calls', '3. Cancel Cancel this tool call', 'enter to submit | esc to cancel'].join('\n')
  fixture.panes.set('long-pane', longApproval); fixture.panes.set('detected-pane', longBrowser)
  await fixture.tick(2000); await fixture.tick(2000)
  assert.equal(fixture.state().requests.length, 2)
  assert.equal(fixture.calls.filter((args) => args[1] === 'cancel').length, 0)
  fixture.ctx.stopRequests()
})


test('실제 작업 경로: 공식 승인은 전용 응답만 사용 · 일반 질문/PTY 우회 차단', async () => {
  const fixture = makePermissionWork()
  fixture.panes.set('p1', browserPrompt)
  const approval = { token: 'token1', generation: 'generation1', pane: 'p1', body: '/fixture/body',
    method: 'item/commandExecution/requestApproval', params: { command: 'echo fixture' }, choices: [{ key: 'accept' }] }
  fixture.setApprovals([approval])
  await fixture.start(); await fixture.tick(4000)
  const visible = fixture.state().requests
  assert.equal(visible.length, 1)
  assert.ok(visible[0].codexApproval)
  assert.equal((await fixture.ctx.answerRequest(visible[0].id, { choice: 'accept', rev: 1 })).ok, false)
  assert.equal((await fixture.ctx.approveRequest(visible[0].id, 'old-generation', 0)).ok, false)
  assert.equal((await fixture.ctx.approveRequest(visible[0].id, approval.generation, 0)).ok, true)
  assert.equal(fixture.calls.filter((args) => args[0] === 'approval').length, 1)
  assert.ok(!fixture.calls.some((args) => args[0] === 'daemon' || args[1] === 'answer'))
  fixture.ctx.athenaDir = '/other'
  fixture.ctx.stopRequests()
  assert.equal((await fixture.ctx.approveRequest(visible[0].id, approval.generation, 0)).ok, false)
})

// 검수 #5 — Codex 승인 알림 제목에 명령 원문이 그대로 나갔다(맥 알림 · 트레이 · [작업] 목록이 제목을 쓴다).
// Claude 허락 알림과 같은 제목(work.permission.title.permission)으로 가리고, 원문은 승인 대화상자 본문(자세히)에만
test('Codex 승인: 제목은 Claude 허락과 같은 가린 제목 · 명령 원문은 본문(승인 대화상자)에만', async () => {
  const fixture = makePermissionWork()
  fixture.panes.set('p1', '')
  const command = 'curl -H "Authorization: Bearer FIXTURE_SECRET_VALUE" https://example.com'
  fixture.setApprovals([{ token: 'token5', generation: 'g5', pane: 'p1', body: '/fixture/body',
    method: 'item/commandExecution/requestApproval', params: { command, cwd: '/w' }, choices: [{ key: 'accept' }] }])
  await fixture.start(); await fixture.tick(2000)
  const [visible] = fixture.state().requests
  assert.equal(visible.title, 'work.permission.title.permissionp1')
  assert.ok(!JSON.stringify({ title: visible.title }).includes('FIXTURE_SECRET_VALUE'), '제목(알림 · 트레이)에 원문이 없다')
  assert.ok(visible.body.includes(command), '승인 대화상자 본문에는 무엇을 허락하는지 보인다')
  fixture.ctx.stopRequests()
})

// 검수 #13 — Codex 도 PermissionRequest 훅을 불러 코어 perm:<pane> 요청이 같이 열린다. 승인이 떠 있는 동안은 숨겼다가
// 앱에서 답해 승인이 사라지면 같은 건의 코어 요청 · 화면 감지 요청이 다시 보여 가짜 허락 알림이 한 번 더 났다
test('Codex 승인에 답한 뒤 같은 건의 코어 perm 요청 · 화면 감지 요청을 다시 보이지 않는다 · 나중의 새 허락은 보인다', async () => {
  const fixture = makePermissionWork()
  const approvalPrompt = ['Would you like to run the following command?', '› 1. Yes, proceed (y)', "  2. Yes, and don’t ask again", '  3. No (esc)', 'Press enter to confirm or esc to cancel'].join('\n')
  fixture.panes.set('p1', approvalPrompt)
  const approval = { token: 'token13', generation: 'g13', pane: 'p1', body: '/fixture/body',
    method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf build' }, choices: [{ key: 'accept' }] }
  fixture.setApprovals([approval])
  fixture.setRows([sample({ id: 'perm-p1', pane: 'p1', dedupeKey: 'perm:p1', createdAt: new Date(4000).toISOString() })])
  await fixture.start(); await fixture.tick(2000); await fixture.tick(2000); await fixture.tick(2000)
  assert.deepEqual(Array.from(fixture.state().requests, (item) => item.id), ['codex-approval:token13'])
  assert.equal((await fixture.ctx.approveRequest('codex-approval:token13', 'g13', 0)).ok, true)
  fixture.setApprovals([])
  await fixture.tick(2000)
  assert.deepEqual(Array.from(fixture.state().requests, (item) => item.id), [], '답한 건의 코어 · 화면 요청은 다시 보이지 않는다')
  fixture.panes.set('p1', ''); await fixture.tick(2000); await fixture.tick(2000)
  assert.deepEqual(Array.from(fixture.state().requests, (item) => item.id), [])
  // 한참 뒤 같은 pane 의 새 허락(코어 요청)은 그대로 보인다
  await fixture.tick(30000)
  fixture.setRows([sample({ id: 'perm-p1-new', pane: 'p1', dedupeKey: 'perm:p1', createdAt: new Date(60000).toISOString() })])
  await fixture.ctx.refreshRequests(); await new Promise(setImmediate)
  assert.deepEqual(Array.from(fixture.state().requests, (item) => item.id), ['perm-p1-new'])
  fixture.ctx.stopRequests()
})

// 검수 #15 — Codex request_user_input 은 훅(ask-to-request.py · 코어 질문)과 app-server(item/tool/requestUserInput)로 두 번 잡혔다.
// Claude AskUserQuestion 과 같은 자리(코어 질문)를 남기고, 같은 pane 의 같은 질문이 코어에 있으면 app-server 쪽은 숨긴다
test('Codex 질문: 같은 pane 같은 질문이 코어에 있으면 하나만 · 코어에 없으면 app-server 질문을 보인다', async () => {
  const fixture = makePermissionWork()
  fixture.panes.set('p1', '')
  const question = { token: 'token15', generation: 'g15', pane: 'p1', body: '/fixture/body', method: 'item/tool/requestUserInput',
    params: { threadId: 't', turnId: 'u', itemId: 'i', questions: [{ id: 'q', header: '고르기', question: '어느 쪽으로 할까요?', options: [{ label: 'A' }, { label: 'B' }] }] },
    choices: [{ key: 'answer', label: 'A' }, { key: 'answer', label: 'B' }] }
  fixture.setApprovals([question])
  await fixture.start(); await fixture.tick(2000)
  assert.deepEqual(Array.from(fixture.state().requests, (item) => [item.id, item.title]), [['codex-approval:token15', '어느 쪽으로 할까요?']])
  fixture.setRows([sample({ id: 'core-q', pane: 'p1', title: '어느 쪽으로 할까요?' })])
  await fixture.ctx.refreshRequests(); await new Promise(setImmediate); await fixture.tick(2000)
  assert.deepEqual(Array.from(fixture.state().requests, (item) => item.id), ['core-q'])
  fixture.ctx.stopRequests()
})
