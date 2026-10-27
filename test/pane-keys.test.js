const test = require('node:test')
const assert = require('node:assert/strict')
const { paneKeyOverride, holdWhileComposing, createComposingKeys, FALLBACK_MS } = require('../src/lib/pane-keys')

const key = (name, mods = {}) => ({ key: name, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods })

test('Shift+Enter → ESC CR(줄바꿈)', () => {
  assert.equal(paneKeyOverride(key('Enter', { shiftKey: true })), '\x1b\r')
})

test('⌘Backspace → Ctrl+U(커서 앞 줄 지우기)', () => {
  assert.equal(paneKeyOverride(key('Backspace', { metaKey: true })), '\x15')
})

test('⌘← · ⌘→ → Ctrl+A · Ctrl+E(줄 처음 · 끝 — 숨은 입력칸 커서를 옮기지 않게)', () => {
  assert.equal(paneKeyOverride(key('ArrowLeft', { metaKey: true })), '\x01')
  assert.equal(paneKeyOverride(key('ArrowRight', { metaKey: true })), '\x05')
  assert.equal(paneKeyOverride(key('ArrowLeft')), null)
  assert.equal(paneKeyOverride(key('ArrowLeft', { metaKey: true, shiftKey: true })), null)
  assert.equal(paneKeyOverride(key('ArrowLeft', { metaKey: true, altKey: true })), null)
  assert.equal(paneKeyOverride(key('ArrowRight', { metaKey: true, ctrlKey: true })), null)
})

test('수정키가 없거나 다른 수정키가 섞이면 바꾸지 않는다', () => {
  assert.equal(paneKeyOverride(key('Enter')), null)
  assert.equal(paneKeyOverride(key('Enter', { shiftKey: true, ctrlKey: true })), null)
  assert.equal(paneKeyOverride(key('Enter', { shiftKey: true, altKey: true })), null)
  assert.equal(paneKeyOverride(key('Enter', { shiftKey: true, metaKey: true })), null)
  assert.equal(paneKeyOverride(key('Backspace')), null)
  assert.equal(paneKeyOverride(key('Backspace', { metaKey: true, shiftKey: true })), null)
  assert.equal(paneKeyOverride(key('Backspace', { metaKey: true, ctrlKey: true })), null)
  assert.equal(paneKeyOverride(key('Backspace', { metaKey: true, altKey: true })), null)
  assert.equal(paneKeyOverride(key('Backspace', { altKey: true })), null)
})

test('다른 키는 바꾸지 않는다', () => {
  assert.equal(paneKeyOverride(key('A', { shiftKey: true })), null)
  assert.equal(paneKeyOverride(key('Delete', { metaKey: true })), null)
})

test('조합 중에 미루는 신호는 줄 처음 · 끝뿐(Enter · ⌘⌫ 는 xterm 에 맡긴다)', () => {
  assert.equal(holdWhileComposing('\x01'), true)
  assert.equal(holdWhileComposing('\x05'), true)
  assert.equal(holdWhileComposing('\x15'), false)
  assert.equal(holdWhileComposing('\x1b\r'), false)
})

// 가짜 타이머 — 등록 순서 · 시각대로 돈다(xterm 이 확정 글자를 보내는 setTimeout(0) 과 줄 서는 순서를 본다)
function fakeTimers() {
  let now = 0
  let seq = 0
  const queue = new Map()
  const defer = (fn, ms) => {
    seq += 1
    queue.set(seq, { fn, at: now + ms, seq })
    return seq
  }
  const cancel = (id) => queue.delete(id)
  const advance = (ms) => {
    const until = now + ms
    for (;;) {
      const next = [...queue.values()].filter((timer) => timer.at <= until).sort((left, right) => left.at - right.at || left.seq - right.seq)[0]
      if (!next) break
      queue.delete(next.seq)
      now = next.at
      next.fn()
    }
    now = until
  }
  return { defer, cancel, advance }
}

test('조합 중 ⌘← — 확정 글자가 먼저, 줄 처음 신호는 그 뒤(마지막 글자 조합 중 · 뒤이은 입력까지)', () => {
  const timers = fakeTimers()
  const sent = []
  const keys = createComposingKeys({ send: (data) => sent.push(data), defer: timers.defer, cancel: timers.cancel })
  sent.push('안녕하세') // 앞 글자들은 이미 확정돼 나갔다
  keys.hold('\x01') // '요' 조합 중 ⌘← keydown
  // compositionend — xterm 처리가 먼저 걸려 있어 확정 글자 setTimeout(0) 이 앞에 선다
  timers.defer(() => sent.push('요'), 0)
  keys.compositionEnd()
  timers.advance(0)
  for (const syllable of ['반', '가', '워']) sent.push(syllable)
  timers.advance(FALLBACK_MS * 2)
  assert.equal(sent.join(''), '안녕하세요\x01반가워')
})

test('조합 확정 소식이 안 오면 FALLBACK_MS 뒤에 한 번만 보낸다 · 둘 이상이면 누른 순서대로', () => {
  const timers = fakeTimers()
  const sent = []
  const keys = createComposingKeys({ send: (data) => sent.push(data), defer: timers.defer, cancel: timers.cancel })
  keys.hold('\x01')
  keys.hold('\x05')
  timers.advance(FALLBACK_MS - 1)
  assert.deepEqual(sent, [])
  timers.advance(1)
  assert.deepEqual(sent, ['\x01\x05'])
  keys.compositionEnd() // 늦게 온 확정 소식 — 더 보내지 않는다
  timers.advance(FALLBACK_MS)
  assert.deepEqual(sent, ['\x01\x05'])
})

test('미룬 신호가 없으면 조합 끝에 아무것도 안 보낸다', () => {
  const timers = fakeTimers()
  const sent = []
  const keys = createComposingKeys({ send: (data) => sent.push(data), defer: timers.defer, cancel: timers.cancel })
  keys.compositionEnd()
  timers.advance(FALLBACK_MS)
  assert.deepEqual(sent, [])
})
