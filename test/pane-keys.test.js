const test = require('node:test')
const assert = require('node:assert/strict')
const { paneKeyOverride } = require('../src/lib/pane-keys')

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
