// 폰 푸시 판정(src/lib/push-model.mts) — 확인 요청 · 입력 대기 → request · working → idle → done(같은 pane 60초 묶기)
// 사건마다 글(제목 · 본문) · id — 한 사건은 한 번(계획서 plans/feature/20261119-폰-알림-내용-암호화-A3.md D1 · D3 · D4)
const test = require('node:test')
const assert = require('node:assert/strict')
const { PushWatch, PushMemory, PushMissed, openRequestIds, DONE_HOLD_MS, ASK_HOLD_MS, RESEND_WINDOW_MS, MISSED_MAX, TITLE_MAX, BODY_MAX, PANE_MAX, clipText } = require('../src/lib/push-model.mts')
const { WAIT_HOLD_MS } = require('../src/lib/tray-model.mts')

const pane = (id, status, agent = 'claude', label) => ({ id, agent, agent_status: status, workspace_id: 'w1', ...(label ? { label } : {}) })
const kinds = (events) => events.map((event) => event.kind)
const open = { muted: false, lookingAt: () => false }

test('일 끝남: 켤 때 본 것은 기준만 · working → idle 이면 pane 마다 done 하나', () => {
  const watch = new PushWatch()
  // 켤 때 이미 쉬던 것 · 일하던 것은 알리지 않는다
  assert.deepEqual(watch.panes([pane('p1', 'working'), pane('p2', 'working'), pane('p3', 'idle')], 0), [])
  const done = watch.panes([pane('p1', 'idle'), pane('p2', 'idle'), pane('p3', 'idle')], 4000)
  assert.deepEqual(kinds(done), ['done', 'done'])
  assert.notEqual(done[0].id, done[1].id, '사건마다 다른 id')
  // idle → idle · idle → working 은 아무것도 아니다
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'working'), pane('p3', 'working')], 8000), [])
  // 에이전트가 없는 pane(셸)은 보지 않는다
  assert.deepEqual(watch.panes([{ id: 'p9', agent: null, agent_status: 'working' }], 12000), [])
})

test('일 끝남: 같은 pane 은 알린 뒤 60초 안에 또 끝나도 한 번 · 60초가 지나면 다시', () => {
  const watch = new PushWatch()
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(kinds(watch.panes([pane('p1', 'idle')], 1000)), ['done'])
  watch.panes([pane('p1', 'working')], 2000)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 1000 + DONE_HOLD_MS - 1), [])
  watch.panes([pane('p1', 'working')], 1000 + DONE_HOLD_MS)
  assert.deepEqual(kinds(watch.panes([pane('p1', 'idle')], 1000 + DONE_HOLD_MS + 1)), ['done'])
  // 다른 pane 은 따로 센다
  watch.panes([pane('p1', 'working'), pane('p2', 'working')], 70_000)
  assert.deepEqual(kinds(watch.panes([pane('p1', 'idle'), pane('p2', 'idle')], 71_000)), ['done'])
})

test('일 끝남: working → waiting 은 done 이 아니다 · 입력 대기가 이어지면 request 한 번', () => {
  const watch = new PushWatch()
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 1000), [])
  assert.deepEqual(kinds(watch.panes([pane('p1', 'waiting')], 1000 + WAIT_HOLD_MS)), ['request'])
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 2000 + WAIT_HOLD_MS), [], '풀릴 때까지 한 번')
  // 입력 대기가 풀려 쉬면 done 도 아니다(working 에서 온 것만)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 9000), [])
})

test('확인 요청: 처음 본 목록은 기준만 · 새로 열린 것마다 하나 · 못 읽음(null)은 기억 그대로', () => {
  const watch = new PushWatch()
  assert.deepEqual(watch.requests([{ id: 'r1', title: '옛 질문', state: 'open' }], open, 0), [])
  assert.deepEqual(watch.requests(null, open, 0), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: '옛 질문', state: 'open' }], open, 0), [])
  const found = watch.requests([{ id: 'r1', title: '옛 질문', state: 'open' }, { id: 'r2', title: 'a', state: 'open' }, { id: 'r3', title: 'b', state: 'open' }], open, 0)
  assert.deepEqual(found.map((event) => [event.kind, event.title, event.body]), [['request', '확인 요청', 'a'], ['request', '확인 요청', 'b']])
  assert.deepEqual(watch.requests([{ id: 'r4', title: '닫힘', state: 'answered' }], open, 0), [])
})

test('확인 요청: 허락 창 요청을 알린 pane 이 이어 입력 대기여도 한 번(메뉴 막대와 같은 묶기)', () => {
  const watch = new PushWatch()
  watch.requests([], open, 0)
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(kinds(watch.requests([{ id: 'r1', title: '권한', state: 'open', permission: true, pane: 'p1' }], open, 0)), ['request'])
  watch.panes([pane('p1', 'waiting')], 1000)
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 1000 + WAIT_HOLD_MS), [])
})

test('글(D1): 제목 = 에이전트 · 확인 요청|일 끝남 · 본문 = 요청 제목 / pane 이름표 · id 는 base64url 22자', () => {
  const watch = new PushWatch()
  const labeled = (status) => pane('p1', status, 'claude', '🤖 athena-studio-fe · feat/studio-push-enc')
  watch.requests([], open, 0)
  watch.panes([labeled('working'), pane('p2', 'working', 'codex')], 0)
  // 일 끝남 — 이름표가 있으면 ' · ' 앞이 에이전트 · 없으면 agent
  const done = watch.panes([labeled('idle'), pane('p2', 'idle', 'codex')], 1000)
  assert.deepEqual(done.map((event) => [event.kind, event.title, event.body]), [
    ['done', 'athena-studio-fe · 일 끝남', 'athena-studio-fe · feat/studio-push-enc'],
    ['done', 'codex · 일 끝남', 'codex'],
  ])
  for (const event of done) assert.match(event.id, /^[A-Za-z0-9_-]{22}$/)
  // 그 푸시를 낸 pane — 일 끝남은 끝난 pane
  assert.deepEqual(done.map((event) => event.pane), ['p1', 'p2'])
  // 요청 — pane 이 붙었으면 그 에이전트 · 본문은 요청 제목(없으면 이름표) · pane 을 모르면 '확인 요청'
  const asked = watch.requests([{ id: 'r1', title: '배포해도 될까요?', state: 'open', pane: 'p2' }, { id: 'r2', title: '', state: 'open', pane: 'p1' }, { id: 'r3', title: '질문', state: 'open', pane: 'gone' }], open, DONE_HOLD_MS + 2000)
  assert.deepEqual(asked.map((event) => [event.title, event.body]), [['codex · 확인 요청', '배포해도 될까요?'], ['athena-studio-fe · 확인 요청', 'athena-studio-fe · feat/studio-push-enc'], ['확인 요청', '질문']])
  // 확인 요청은 요청을 연 pane(목록에 안 보여도 요청에 적힌 그대로) · pane 이 없는 요청 · 너무 긴 pane id 는 칸 자체가 없다
  assert.deepEqual(asked.map((event) => event.pane), ['p2', 'p1', 'gone'])
  const loose = watch.requests([{ id: 'r4', title: 'pane 모름', state: 'open' }, { id: 'r5', title: '긴 pane', state: 'open', pane: 'p'.repeat(PANE_MAX + 1) }, { id: 'r6', title: '딱 맞는 pane', state: 'open', pane: 'p'.repeat(PANE_MAX) }], open, DONE_HOLD_MS + 3000)
  assert.deepEqual(loose.map((event) => ['pane' in event, event.pane]), [[false, undefined], [false, undefined], [true, 'p'.repeat(PANE_MAX)]])
  // 입력 대기 — 본문은 이름표
  const other = new PushWatch()
  other.panes([labeled('working')], 0)
  other.panes([labeled('waiting')], 1000)
  assert.deepEqual(other.panes([labeled('waiting')], 1000 + WAIT_HOLD_MS).map((event) => [event.kind, event.title, event.body, event.pane]), [['request', 'athena-studio-fe · 확인 요청', 'athena-studio-fe · feat/studio-push-enc', 'p1']])
})

test('글 자르기: 제목 60 · 본문 160 글자(코드포인트)에서 자르고 제어 글자는 뺀다', () => {
  assert.equal(clipText('가'.repeat(200), BODY_MAX), '가'.repeat(160))
  assert.equal(Array.from(clipText('🚀'.repeat(100), TITLE_MAX)).length, 60, '이모지를 반으로 자르지 않는다')
  assert.equal(clipText(' 한 줄\n두 줄\u0007 ', 20), '한 줄 두 줄')
  assert.equal(clipText(null, 10), '')
  const watch = new PushWatch()
  watch.requests([], open, 0)
  watch.panes([pane('p1', 'working', 'claude', `🤖 ${'긴'.repeat(100)} · 브랜치`)], 0)
  const [event] = watch.requests([{ id: 'r1', title: '제'.repeat(300), state: 'open', pane: 'p1' }], open, 0)
  assert.equal(Array.from(event.title).length, TITLE_MAX)
  assert.equal(Array.from(event.body).length, BODY_MAX)
})

test('한 사건 한 번(D3): 같은 pane 의 요청이 다른 id 로 또 열려도 · 요청 뒤 곧 쉬어도(done) 한 번 · 다시 일하면 풀린다', () => {
  const watch = new PushWatch()
  watch.requests([], open, 0)
  watch.panes([pane('p1', 'working')], 0)
  const first = { id: 'r1', title: '질문', state: 'open', pane: 'p1' }
  assert.deepEqual(kinds(watch.requests([first], open, 1000)), ['request'])
  // 같은 건이 다른 id 로(화면 감지 → 코어 요청) · 허락 창이 아니어도 같은 pane 이면 묶는다
  assert.deepEqual(watch.requests([first, { id: 'r2', title: '질문', state: 'open', pane: 'p1' }], open, 2000), [])
  // 요청을 연 에이전트가 차례를 끝내 쉰다 — 일 끝남을 또 보내지 않는다
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 4000), [])
  // 입력 대기로 보여도 같은 사건
  watch.panes([pane('p1', 'waiting')], 8000)
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 8000 + WAIT_HOLD_MS), [])
  // 답을 받아 다시 일하면 앞 사건은 끝 — 60초 안이어도 새 요청 · 일 끝남은 보낸다
  watch.panes([pane('p1', 'working')], 16_000)
  assert.deepEqual(kinds(watch.requests([first, { id: 'r3', title: '또 질문', state: 'open', pane: 'p1' }], open, 17_000)), ['request'])
  const next = new PushWatch()
  next.requests([], open, 0)
  next.panes([pane('p1', 'working')], 0)
  next.requests([first], open, 1000)
  next.panes([pane('p1', 'waiting')], 2000)
  next.panes([pane('p1', 'working')], 6000)
  assert.deepEqual(kinds(next.panes([pane('p1', 'idle')], 10_000)), ['done'])
  // 일 끝남 뒤의 확인 요청은 보낸다
  assert.deepEqual(kinds(next.requests([first, { id: 'r4', title: '끝난 뒤 질문', state: 'open', pane: 'p1' }], open, 11_000)), ['request'])
  // pane 이 없는 요청은 서로 묶지 않는다 · 같은 pane 도 60초가 지나면 다시
  const plain = new PushWatch()
  plain.requests([], open, 0)
  assert.equal(plain.requests([{ id: 'a', title: 'a', state: 'open' }, { id: 'b', title: 'b', state: 'open' }, { id: 'c', title: 'c', state: 'open', pane: 'p5' }], open, 0).length, 3)
  assert.deepEqual(plain.requests([{ id: 'd', title: 'd', state: 'open', pane: 'p5' }], open, ASK_HOLD_MS - 1), [])
  assert.equal(plain.requests([{ id: 'e', title: 'e', state: 'open', pane: 'p5' }], open, ASK_HOLD_MS).length, 1)
})

test('기억 이어 가기(D3): 판정을 새로 만들어도(앞 창이 바뀜) 같은 pane 60초 묶기 · 보낸 요청은 그대로', () => {
  const memory = new PushMemory()
  const first = new PushWatch(memory)
  first.requests([], open, 0)
  first.panes([pane('p1', 'working'), pane('p2', 'working')], 0)
  assert.deepEqual(kinds(first.panes([pane('p1', 'idle'), pane('p2', 'working')], 1000)), ['done'])
  const sent = first.requests([{ id: 'r1', title: '질문', state: 'open' }], open, 2000)
  assert.equal(sent.length, 1)
  // 다른 창을 보다 돌아왔다 — 새 판정 · 그 창 목록에는 p1 이 안 보였어도 기억은 남는다
  const away = new PushWatch(memory)
  away.panes([pane('p8', 'working')], 3000)
  const second = new PushWatch(memory)
  second.requests([], open, 4000)
  second.panes([pane('p1', 'working')], 5000)
  assert.deepEqual(second.panes([pane('p1', 'idle')], 9000), [], '60초 안의 같은 pane 끝남')
  // 같은 요청이 새 판정에 새것으로 보여도 같은 id 는 다시 보내지 않는다
  assert.deepEqual(second.requests([{ id: 'r1', title: '질문', state: 'open' }], open, 10_000), [])
  // 60초가 지나면 다시
  second.panes([pane('p1', 'working')], 1000 + DONE_HOLD_MS)
  assert.deepEqual(kinds(second.panes([pane('p1', 'idle')], 2000 + DONE_HOLD_MS)), ['done'])
})

test('거르기: [알림 끄기] 동안은 아무것도 안 보낸다 · 끄기가 풀려도 그 사이 것을 몰아 보내지 않는다', () => {
  const watch = new PushWatch()
  const muted = { muted: true, lookingAt: () => false }
  watch.requests([], open, 0)
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 1000, muted), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: 'a', state: 'open' }], muted, 1000), [])
  // 풀린 뒤 — 끈 사이 끝난 것 · 열린 요청은 다시 오지 않는다
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 2000), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: 'a', state: 'open' }], open, 2000), [])
  // 그 뒤 새로 생긴 것은 보낸다
  watch.panes([pane('p1', 'working')], 3000)
  assert.deepEqual(kinds(watch.panes([pane('p1', 'idle')], 1000 + DONE_HOLD_MS + 1)), ['done'])
})

test('거르기(D4): Studio 창이 앞(active)이면 아무것도 안 보낸다 · 풀린 뒤 몰아 보내지 않는다 · 그 뒤 것은 보낸다', () => {
  const watch = new PushWatch()
  const active = { muted: false, active: true, lookingAt: () => false }
  watch.requests([], open, 0)
  watch.panes([pane('p1', 'working'), pane('p2', 'working')], 0)
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'working')], 1000, active), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: 'a', state: 'open' }], active, 1000), [])
  // 다른 앱으로 갔다 · 화면이 잠겼다(active 가 꺼짐) — 그 사이 것은 다시 오지 않고 새것만
  const away = { muted: false, active: false, lookingAt: () => false }
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'working')], 2000, away), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: 'a', state: 'open' }], away, 2000), [])
  assert.deepEqual(kinds(watch.panes([pane('p1', 'idle'), pane('p2', 'idle')], 3000, away)), ['done'])
  assert.deepEqual(kinds(watch.requests([{ id: 'r1', title: 'a', state: 'open' }, { id: 'r2', title: 'b', state: 'open' }], away, 3000)), ['request'])
})

test('거르기: 지금 보고 있는 pane 의 일 끝남 · 입력 대기 · 허락 창 요청은 빼고 다른 pane · pane 없는 요청은 보낸다', () => {
  const watch = new PushWatch()
  const looking = { muted: false, lookingAt: (id) => id === 'p1' }
  watch.requests([], looking, 0)
  watch.panes([pane('p1', 'working'), pane('p2', 'working')], 0)
  // 보고 있는 p1 만 끝남 → 없음 · p2 도 끝나면 done
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'working')], 1000, looking), [])
  assert.deepEqual(kinds(watch.panes([pane('p1', 'idle'), pane('p2', 'idle')], 2000, looking)), ['done'])
  // 보고 있는 pane 의 입력 대기
  watch.panes([pane('p1', 'waiting'), pane('p2', 'idle')], 3000, looking)
  assert.deepEqual(watch.panes([pane('p1', 'waiting'), pane('p2', 'idle')], 3000 + WAIT_HOLD_MS, looking), [])
  // 보고 있는 pane 의 허락 창 요청은 빼고 · pane 이 없는 요청은 보고 있어도 보낸다(메뉴 막대와 같다)
  assert.deepEqual(watch.requests([{ id: 'r1', title: '권한', state: 'open', permission: true, pane: 'p1' }], looking, 7000), [])
  assert.deepEqual(kinds(watch.requests([{ id: 'r1', title: '권한', state: 'open', permission: true, pane: 'p1' }, { id: 'r2', title: '질문', state: 'open' }], looking, 7000)), ['request'])
  assert.deepEqual(kinds(watch.requests([{ id: 'r3', title: '권한', state: 'open', permission: true, pane: 'p2' }], looking, 7000)), ['request'])
})

// 끊길 때 다시 보내기(사용자 결정 2026-11-20) — 직접 길로 붙어 있어 푸시 대상에서 빠진 사건은 그 기기 직접 길이 닫힐 때 그 기기에만
test('끊길 때 다시 보내기: 빠진 기기에만 한 번 · 끊기기 전 60초 안 것만 · 답했거나 닫힌 요청은 빼고', () => {
  const watch = new PushWatch()
  watch.requests([], open, 0)
  watch.panes([pane('p1', 'working')], 0)
  const requests = [{ id: 'r1', title: '옛 질문', state: 'open' }, { id: 'r2', title: '답한 질문', state: 'open' }]
  const [old, answered] = watch.requests(requests, open, 1000)
  // 확인 요청 사건은 요청 id 를 들고 있다(맥 안에서만 — 다시 보낼 때 아직 열려 있는지 본다) · 일 끝남은 없다
  assert.deepEqual([old.request, answered.request], ['r1', 'r2'])
  const [done] = watch.panes([pane('p1', 'idle')], 2000)
  assert.equal('request' in done, false)
  const [fresh] = watch.requests([...requests, { id: 'r3', title: '새 질문', state: 'open' }], open, 50_000)
  const missed = new PushMissed()
  // phone-a 가 직접 길로 붙어 있어 네 사건이 모두 빠졌다 · phone-b 는 푸시를 받았으니 적지 않는다
  missed.note(['phone-a'], old, 1000)
  missed.note(['phone-a'], answered, 1000)
  missed.note(['phone-a'], done, 2000)
  missed.note(['phone-a'], fresh, 50_000)
  missed.note([], fresh, 50_000)
  const closedAt = 1000 + RESEND_WINDOW_MS // old · answered 는 딱 60초 — 넘은 것으로 친다
  // 그 사이 r2 는 답했다(목록에서 open 이 아님)
  const openNow = openRequestIds([{ id: 'r1', state: 'open' }, { id: 'r2', state: 'answered' }, { id: 'r3', state: 'open' }])
  assert.deepEqual(missed.take('phone-b', closedAt, openNow), [], '빠진 적 없는 기기에는 안 보낸다')
  assert.deepEqual(missed.take('phone-a', closedAt, openNow).map((event) => event.id), [done.id, fresh.id])
  assert.deepEqual(missed.take('phone-a', closedAt, openNow), [], '같은 사건을 두 번 보내지 않는다')
})

test('끊길 때 다시 보내기: 답한 요청은 60초 안이어도 안 감 · 요청 목록을 못 읽으면 확인 요청은 안 보냄 · 기기별 기억은 작게', () => {
  const event = (id, request) => ({ kind: request ? 'request' : 'done', id, title: 't', body: 'b', ...(request ? { request } : {}) })
  const missed = new PushMissed()
  missed.note(['phone-a', 'phone-b'], event('e1', 'r1'), 0)
  missed.note(['phone-a', 'phone-b'], event('e2'), 0)
  assert.deepEqual(missed.take('phone-a', 1000, openRequestIds([{ id: 'r1', state: 'answered' }])).map((item) => item.id), ['e2'])
  // 못 읽음(null) — 아직 열려 있는지 모르는 확인 요청은 보내지 않는다 · 일 끝남은 보낸다
  assert.equal(openRequestIds(null), null)
  assert.deepEqual(missed.take('phone-b', 1000, null).map((item) => item.id), ['e2'])
  // 같은 사건을 두 번 적어도 한 번 · 60초 지난 것은 적을 때 버린다 · 기기마다 MISSED_MAX 개까지(오래된 것부터 버림)
  missed.note(['phone-c'], event('old'), 0)
  missed.note(['phone-d'], event('dup'), RESEND_WINDOW_MS)
  missed.note(['phone-d'], event('dup'), RESEND_WINDOW_MS)
  assert.deepEqual(missed.peers(), ['phone-d'], '오래된 것만 남은 기기는 지운다')
  assert.deepEqual(missed.take('phone-d', RESEND_WINDOW_MS, null).map((item) => item.id), ['dup'])
  for (let index = 0; index < MISSED_MAX + 5; index += 1) missed.note(['phone-e'], event(`e${index}`), index)
  const kept = missed.take('phone-e', MISSED_MAX + 5, null).map((item) => item.id)
  assert.equal(kept.length, MISSED_MAX)
  assert.equal(kept[0], 'e5')
})
