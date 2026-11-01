const test = require('node:test')
const assert = require('node:assert')
const { isConsoleUrl, planOpen, afterClose } = require('../src/lib/browser-tabs.mts')

const consoleA = 'http://127.0.0.1:4/plans/a.html'
const consoleB = 'http://127.0.0.1:4/plans/b.html'
const page = 'http://localhost:3000/'

test('isConsoleUrl: /plans/….html 만', () => {
  assert.equal(isConsoleUrl(consoleA), true)
  assert.equal(isConsoleUrl(page), false)
  assert.equal(isConsoleUrl(''), false)
})

test('planOpen: 에이전트가 연 새 콘솔은 뒤 탭으로 쌓인다', () => {
  const tabs = [{ id: 1, url: consoleA }]
  assert.deepEqual(planOpen({ tabs, activeId: 1, url: consoleB, fromUser: false, showing: true }), { tabId: null, navigate: true, activate: false })
  // 서랍이 닫혀 있어도 답을 기다리던 콘솔이 먼저
  assert.equal(planOpen({ tabs, activeId: 1, url: consoleB, fromUser: false, showing: false }).activate, false)
})

test('planOpen: 일반 페이지를 보는 중이면 콘솔은 뒤로 · 서랍이 닫혀 있으면 앞으로', () => {
  const tabs = [{ id: 1, url: page }]
  assert.deepEqual(planOpen({ tabs, activeId: 1, url: consoleA, fromUser: false, showing: true }), { tabId: null, navigate: true, activate: false })
  assert.equal(planOpen({ tabs, activeId: 1, url: consoleA, fromUser: false, showing: false }).activate, true)
})

test('planOpen: 이미 열린 콘솔은 다시 읽지 않는다 · 사용자가 열면 그 탭을 앞으로', () => {
  const tabs = [{ id: 1, url: consoleA }, { id: 2, url: consoleB }]
  assert.deepEqual(planOpen({ tabs, activeId: 1, url: `${consoleB}?x=1`, fromUser: true, showing: true }), { tabId: 2, navigate: false, activate: true })
  assert.deepEqual(planOpen({ tabs, activeId: 1, url: consoleB, fromUser: false, showing: true }), { tabId: 2, navigate: false, activate: false })
})

test('planOpen: 빈 탭 · 탭 없음은 그 자리에 앞으로', () => {
  assert.deepEqual(planOpen({ tabs: [{ id: 1, url: '' }], activeId: 1, url: consoleA, fromUser: false, showing: true }), { tabId: 1, navigate: true, activate: true })
  assert.deepEqual(planOpen({ tabs: [], activeId: null, url: consoleA, fromUser: false, showing: false }), { tabId: null, navigate: true, activate: true })
})

test('planOpen: 일반 페이지는 콘솔 탭을 덮어쓰지 않고 페이지 탭 하나를 같이 쓴다', () => {
  const tabs = [{ id: 1, url: consoleA }, { id: 2, url: page }]
  const next = 'http://localhost:3000/next'
  assert.deepEqual(planOpen({ tabs, activeId: 1, url: next, fromUser: false, showing: true }), { tabId: 2, navigate: true, activate: false })
  assert.deepEqual(planOpen({ tabs, activeId: 1, url: next, fromUser: true, showing: true }), { tabId: 2, navigate: true, activate: true })
  assert.deepEqual(planOpen({ tabs: [{ id: 1, url: consoleA }], activeId: 1, url: next, fromUser: true, showing: true }), { tabId: null, navigate: true, activate: true })
})

test('afterClose: 보내면 다음 콘솔로 · 남은 콘솔이 없으면 서랍을 닫는다', () => {
  const tabs = [{ id: 1, url: page }, { id: 2, url: consoleA }, { id: 3, url: consoleB }]
  assert.deepEqual(afterClose({ tabs, closedId: 3, activeId: 3, sent: true }), { activeId: 2, closeDrawer: false })
  assert.deepEqual(afterClose({ tabs: tabs.slice(0, 2), closedId: 2, activeId: 2, sent: true }), { activeId: 1, closeDrawer: true })
  assert.deepEqual(afterClose({ tabs: [tabs[1]], closedId: 2, activeId: 2, sent: true }), { activeId: null, closeDrawer: true })
})

test('afterClose: 뒤 탭이 닫히면 보던 화면은 그대로 · 손으로 닫으면 서랍을 두고 옆 탭으로', () => {
  const tabs = [{ id: 1, url: consoleA }, { id: 2, url: page }, { id: 3, url: consoleB }]
  assert.deepEqual(afterClose({ tabs, closedId: 1, activeId: 3, sent: true }), { activeId: 3, closeDrawer: false })
  assert.deepEqual(afterClose({ tabs, closedId: 1, activeId: 1, sent: false }), { activeId: 2, closeDrawer: false })
  assert.deepEqual(afterClose({ tabs: tabs.slice(0, 2), closedId: 2, activeId: 2, sent: false }), { activeId: 1, closeDrawer: false })
})
