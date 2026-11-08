const test = require('node:test')
const assert = require('node:assert/strict')
const { choiceKey, deliverAnswer, promptClosed } = require('../src/lib/answer-delivery.mts')

// 실측 화면(2026-11-08 · Claude Code 2.1.319 · codex-cli 0.166.0 — pane read --source visible)을 줄인 것
const CLAUDE_ONE = [
  '❯ AskUserQuestion 도구로 질문 하나만 해',
  '─────────────',
  ' ☐ Color',
  '',
  'Which color do you like?',
  '',
  '❯ 1. Red',
  '     The color red',
  '  2. Blue',
  '     The color blue',
  '  3. Green',
  '     The color green',
  '  4. Type something.',
  '─────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')
const CLAUDE_MANY = CLAUDE_ONE.replace(' ☐ Color', '←  ☐ Color  ☐ Size  ✔ Submit  →').replace('↑/↓ to navigate', 'Tab/Arrow keys to navigate')
const CODEX_ONE = [
  '  Question 1/1 (1 unanswered)',
  '  Which color do you like?',
  '',
  '  › 1. Red                The color red',
  '    2. Blue               The color blue',
  '    3. Green              The color green',
  '    4. None of the above  Optionally, add details in notes (tab)',
  '',
  '  tab to add notes | enter to submit answer | esc to interrupt',
].join('\n')
const CLAUDE_IDLE = '⏺ Blue\n─────\n❯ \n─────\n  Haiku 5.5\n'
const request = {
  id: 'r-1',
  title: 'Which color do you like?',
  body: '지금 그 pane 에도 같은 선택 프롬프트가 떠 있어요.\n\n[Color]',
  options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }],
}
const line = '[요청 r-1] Which color do you like? — 답: Blue'

// 데몬 흉내 — 선택 창이 떠 있으면 pane run 은 쓰기 전에 unavailable(실제 데몬 응답 · pane-submit.mts)
function fakePane({ agent = 'claude', screen = CLAUDE_ONE, closesOnKey = true, after = [CLAUDE_IDLE], acked = true } = {}) {
  let now = screen
  let reads = []
  const calls = []
  return {
    calls,
    io: {
      panes: async () => [{ id: 'p1', agent }],
      // 고른 뒤에는 after 를 차례로 읽힌다(마지막 것이 계속)
      read: async () => (reads.length > 1 ? reads.shift() : reads[0] ?? now),
      run: async (pane, text) => {
        calls.push(['run', text])
        return now.includes('Enter to select') || now.includes('enter to submit answer') ? { code: 'unavailable' } : null
      },
      type: async (pane, text) => {
        calls.push(['type', text])
        if (closesOnKey) reads = [...after]
        return true
      },
      ack: async () => { calls.push(['ack']); return acked },
      sleep: async () => {},
    },
  }
}

test('같은 질문의 선택 창이면 고른 선택지 숫자 하나로 고르고 받음(ack)까지 — 재현: 예전엔 pane run 이 거절돼 "pane 없음"', async () => {
  const pane = fakePane()
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, pane.io), { delivered: true, chose: true })
  assert.deepEqual(pane.calls, [['type', '2'], ['ack']])
})

test('Codex 질문 하나 창도 같은 판단', async () => {
  assert.equal(choiceKey(CODEX_ONE, 'codex', request, { choice: 'Green' }), '3')
  const pane = fakePane({ agent: 'codex', screen: CODEX_ONE })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Red' }, line, pane.io), { delivered: true, chose: true })
  assert.deepEqual(pane.calls, [['type', '1'], ['ack']])
})

test('같은 질문인지 모르면 키를 누르지 않는다 — 질문 · 선택지 · 머리 · 질문 여럿 · 메모 · 모르는 답', () => {
  const blue = { choice: 'Blue' }
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', request, blue), '2')
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', { ...request, title: 'Which size?' }, blue), null)
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', { ...request, options: [{ label: 'Blue' }, { label: 'Red' }, { label: 'Green' }] }, blue), null)
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', { ...request, options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Black' }] }, blue), null)
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', { ...request, body: '[Size]' }, blue), null)
  assert.equal(choiceKey(CLAUDE_MANY, 'claude', request, blue), null)
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', request, { choice: 'Blue', text: '메모' }), null)
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', request, { choice: 'Purple' }), null)
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', request, { text: '직접 쓴 답' }), null)
  assert.equal(choiceKey(CLAUDE_ONE, null, request, blue), null)
  assert.equal(choiceKey(CODEX_ONE, 'claude', request, blue), null)
  assert.equal(choiceKey(CLAUDE_IDLE, 'claude', request, blue), null)
})

test('고르지 못하는 선택 창이면 아무것도 쓰지 않고 prompt-open', async () => {
  for (const [screen, answer] of [[CLAUDE_MANY, { choice: 'Blue' }], [CLAUDE_ONE, { choice: 'Blue', text: '메모' }]]) {
    const pane = fakePane({ screen })
    assert.deepEqual(await deliverAnswer('p1', request, answer, line, pane.io), { delivered: false, reason: 'prompt-open' })
    assert.deepEqual(pane.calls, [])
  }
})

test('골랐는데 창이 그대로면 키를 더 누르지 않고 unconfirmed · ack 안 함', async () => {
  const pane = fakePane({ closesOnKey: false })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, pane.io), { delivered: false, reason: 'unconfirmed' })
  assert.deepEqual(pane.calls, [['type', '2']])
})

test('선택 창이 아니면 입력칸에 한 줄 · pane 없음 · 전송 실패를 나눈다', async () => {
  const idle = fakePane({ screen: CLAUDE_IDLE })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, idle.io), { delivered: true })
  assert.deepEqual(idle.calls, [['run', line]])
  assert.deepEqual(await deliverAnswer(null, request, { choice: 'Blue' }, line, idle.io), { delivered: false, reason: 'no-pane' })
  assert.deepEqual(await deliverAnswer('p9', request, { choice: 'Blue' }, line, idle.io), { delivered: false, reason: 'no-pane' })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, { ...idle.io, panes: async () => null }), { delivered: false, reason: 'no-pane' })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, { ...idle.io, run: async () => ({ code: 'timeout' }) }), { delivered: false, reason: 'unconfirmed' })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, { ...idle.io, run: async () => ({ code: 'not_found' }) }), { delivered: false, reason: 'no-pane' })
  // 읽을 땐 아니었는데 보내는 사이 선택 창이 떴다 — 데몬이 쓰기 전에 거절했다
  let reads = 0
  const raced = { ...idle.io, read: async () => (reads++ ? CLAUDE_MANY : CLAUDE_IDLE), run: async () => ({ code: 'unavailable' }) }
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, raced), { delivered: false, reason: 'prompt-open' })
})

test('화면 선택지가 요청보다 많으면(앞부분만 같아도) 키를 누르지 않는다 — 덧붙는 항목만 빼고 개수까지 같아야', async () => {
  const twoOptions = { ...request, options: [{ label: 'Red' }, { label: 'Blue' }] }
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', twoOptions, { choice: 'Blue' }), null)
  assert.equal(choiceKey(CODEX_ONE, 'codex', twoOptions, { choice: 'Blue' }), null)
  // 덧붙는 항목(Type something. · Chat about this · None of the above)은 요청 선택지가 아니다
  assert.equal(choiceKey(CLAUDE_ONE, 'claude', request, { choice: 'Green' }), '3')
  const pane = fakePane()
  assert.deepEqual(await deliverAnswer('p1', twoOptions, { choice: 'Blue' }, line, pane.io), { delivered: false, reason: 'prompt-open' })
  assert.deepEqual(pane.calls, [])
})

test('고른 뒤 조각 화면(다시 그리는 중)만 읽히면 닫힘으로 치지 않고 ack 하지 않는다', async () => {
  const lines = CLAUDE_ONE.split('\n')
  const pieces = [
    lines.slice(0, 6).join('\n'), // 머리 · 제목만
    lines.slice(6, 12).join('\n'), // 선택지만
    lines.slice(-1).join('\n'), // 맺음만
    '',
  ]
  for (const piece of pieces) assert.equal(promptClosed(piece, request), false, JSON.stringify(piece))
  assert.equal(promptClosed(null, request), false)
  assert.equal(promptClosed(CLAUDE_IDLE, request), true)
  const stuck = fakePane({ after: [lines.slice(6, 12).join('\n')] })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, stuck.io), { delivered: false, reason: 'unconfirmed' })
  assert.deepEqual(stuck.calls, [['type', '2']])
  // 닫힌 화면 한 번 뒤 다시 조각이면 아직 — 두 번 잇달아 닫혀야 ack
  const flicker = fakePane({ after: [CLAUDE_IDLE, pieces[0], CLAUDE_IDLE, CLAUDE_IDLE] })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, flicker.io), { delivered: true, chose: true })
})

test('ack 가 기록되지 않으면 delivered 가 아니라 unconfirmed', async () => {
  const pane = fakePane({ acked: false })
  assert.deepEqual(await deliverAnswer('p1', request, { choice: 'Blue' }, line, pane.io), { delivered: false, reason: 'unconfirmed' })
  assert.deepEqual(pane.calls, [['type', '2'], ['ack']])
})
