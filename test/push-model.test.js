// 폰 푸시 판정(src/lib/push-model.mts) — 확인 요청 · 입력 대기 → request · working → idle → done(같은 pane 60초 묶기)
const test = require('node:test')
const assert = require('node:assert/strict')
const { PushWatch, DONE_HOLD_MS } = require('../src/lib/push-model.mts')
const { WAIT_HOLD_MS } = require('../src/lib/tray-model.mts')

const pane = (id, status, agent = 'claude') => ({ id, agent, agent_status: status, workspace_id: 'w1' })

test('일 끝남: 켤 때 본 것은 기준만 · working → idle 이면 done · 일하던 pane 여럿이 끝나도 한 번', () => {
  const watch = new PushWatch()
  // 켤 때 이미 쉬던 것 · 일하던 것은 알리지 않는다
  assert.deepEqual(watch.panes([pane('p1', 'working'), pane('p2', 'working'), pane('p3', 'idle')], 0), [])
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'idle'), pane('p3', 'idle')], 4000), ['done'])
  // idle → idle · idle → working 은 아무것도 아니다
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'working'), pane('p3', 'working')], 8000), [])
  // 에이전트가 없는 pane(셸)은 보지 않는다
  assert.deepEqual(watch.panes([{ id: 'p9', agent: null, agent_status: 'working' }], 12000), [])
})

test('일 끝남: 같은 pane 은 알린 뒤 60초 안에 또 끝나도 한 번 · 60초가 지나면 다시', () => {
  const watch = new PushWatch()
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 1000), ['done'])
  watch.panes([pane('p1', 'working')], 2000)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 1000 + DONE_HOLD_MS - 1), [])
  watch.panes([pane('p1', 'working')], 1000 + DONE_HOLD_MS)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 1000 + DONE_HOLD_MS + 1), ['done'])
  // 다른 pane 은 따로 센다
  watch.panes([pane('p1', 'working'), pane('p2', 'working')], 70_000)
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'idle')], 71_000), ['done'])
})

test('일 끝남: working → waiting 은 done 이 아니다 · 입력 대기가 이어지면 request 한 번', () => {
  const watch = new PushWatch()
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 1000), [])
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 1000 + WAIT_HOLD_MS), ['request'])
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 2000 + WAIT_HOLD_MS), [], '풀릴 때까지 한 번')
  // 입력 대기가 풀려 쉬면 done 도 아니다(working 에서 온 것만)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 9000), [])
})

test('확인 요청: 처음 본 목록은 기준만 · 새로 열린 것만 · 못 읽음(null)은 기억 그대로', () => {
  const watch = new PushWatch()
  assert.deepEqual(watch.requests([{ id: 'r1', title: '옛 질문', state: 'open' }]), [])
  assert.deepEqual(watch.requests(null), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: '옛 질문', state: 'open' }]), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: '옛 질문', state: 'open' }, { id: 'r2', title: 'a', state: 'open' }, { id: 'r3', title: 'b', state: 'open' }]), ['request'])
  assert.deepEqual(watch.requests([{ id: 'r4', title: '닫힘', state: 'answered' }]), [])
})

test('확인 요청: 허락 창 요청을 알린 pane 이 이어 입력 대기여도 한 번(메뉴 막대와 같은 묶기)', () => {
  const watch = new PushWatch()
  watch.requests([])
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(watch.requests([{ id: 'r1', title: '권한', state: 'open', permission: true, pane: 'p1' }]), ['request'])
  watch.panes([pane('p1', 'waiting')], 1000)
  assert.deepEqual(watch.panes([pane('p1', 'waiting')], 1000 + WAIT_HOLD_MS), [])
})

test('거르기: [알림 끄기] 동안은 아무것도 안 보낸다 · 끄기가 풀려도 그 사이 것을 몰아 보내지 않는다', () => {
  const watch = new PushWatch()
  const muted = { muted: true, lookingAt: () => false }
  watch.requests([])
  watch.panes([pane('p1', 'working')], 0)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 1000, muted), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: 'a', state: 'open' }], muted), [])
  // 풀린 뒤 — 끈 사이 끝난 것 · 열린 요청은 다시 오지 않는다
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 2000), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: 'a', state: 'open' }]), [])
  // 그 뒤 새로 생긴 것은 보낸다
  watch.panes([pane('p1', 'working')], 3000)
  assert.deepEqual(watch.panes([pane('p1', 'idle')], 1000 + DONE_HOLD_MS + 1), ['done'])
})

test('거르기: 지금 보고 있는 pane 의 일 끝남 · 입력 대기 · 허락 창 요청은 빼고 다른 pane · pane 없는 요청은 보낸다', () => {
  const watch = new PushWatch()
  const looking = { muted: false, lookingAt: (id) => id === 'p1' }
  watch.requests([])
  watch.panes([pane('p1', 'working'), pane('p2', 'working')], 0)
  // 보고 있는 p1 만 끝남 → 없음 · p2 도 끝나면 done
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'working')], 1000, looking), [])
  assert.deepEqual(watch.panes([pane('p1', 'idle'), pane('p2', 'idle')], 2000, looking), ['done'])
  // 보고 있는 pane 의 입력 대기
  watch.panes([pane('p1', 'waiting'), pane('p2', 'idle')], 3000, looking)
  assert.deepEqual(watch.panes([pane('p1', 'waiting'), pane('p2', 'idle')], 3000 + WAIT_HOLD_MS, looking), [])
  // 보고 있는 pane 의 허락 창 요청은 빼고 · pane 이 없는 요청은 보고 있어도 보낸다(메뉴 막대와 같다)
  assert.deepEqual(watch.requests([{ id: 'r1', title: '권한', state: 'open', permission: true, pane: 'p1' }], looking), [])
  assert.deepEqual(watch.requests([{ id: 'r1', title: '권한', state: 'open', permission: true, pane: 'p1' }, { id: 'r2', title: '질문', state: 'open' }], looking), ['request'])
  assert.deepEqual(watch.requests([{ id: 'r3', title: '권한', state: 'open', permission: true, pane: 'p2' }], looking), ['request'])
})
