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
