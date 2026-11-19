// @ts-check
// 모바일 브리지 기록(src/main/mobile-log.mts) — 터미널 쓰기 실패가 잡히지 않은 예외로 올라오지 않는지
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { quietStream, mobileLog, mobileError, relayMissingNote, MOBILE_RELAY_MISSING } = require('../src/main/mobile-log.mts')

const writeFailure = () => Object.assign(new Error('write EIO'), { code: 'EIO' })

test('듣는 쪽이 없는 스트림은 쓰기 실패가 예외로 올라온다(고치기 전 꼴)', () => {
  const stream = new EventEmitter()
  assert.throws(() => stream.emit('error', writeFailure()), /write EIO/)
})

test('quietStream 을 건 스트림은 쓰기 실패를 삼킨다 · 두 번 걸지 않는다', () => {
  const stream = new EventEmitter()
  quietStream(stream)
  quietStream(stream)
  assert.equal(stream.listenerCount('error'), 1)
  assert.doesNotThrow(() => stream.emit('error', writeFailure()))
})

test('mobileLog · mobileError 는 쓰기 전에 stdout · stderr 에 건다', (t) => {
  const logged = t.mock.method(console, 'log', () => {})
  const errored = t.mock.method(console, 'error', () => {})
  const before = { out: process.stdout.listenerCount('error'), err: process.stderr.listenerCount('error') }
  mobileLog('[mobile-relay] 시험')
  mobileError('[mobile-bridge] 시험', new Error('x'))
  mobileLog('[mobile-relay] 시험 2')
  assert.equal(process.stdout.listenerCount('error'), before.out + 1)
  assert.equal(process.stderr.listenerCount('error'), before.err + 1)
  assert.equal(logged.mock.callCount(), 2)
  assert.equal(errored.mock.callCount(), 1)
})

test('relay 주소 없이 켜졌고 짝 지은 기록이 있으면 한 줄 · 개발판에서만', () => {
  const paired = () => true
  assert.equal(relayMissingNote({ packaged: false, relay: undefined, pairedFileExists: paired }), MOBILE_RELAY_MISSING)
  assert.equal(relayMissingNote({ packaged: false, relay: '', pairedFileExists: paired }), MOBILE_RELAY_MISSING)
  assert.equal(relayMissingNote({ packaged: false, relay: 'ws://127.0.0.1:8787/ws', pairedFileExists: paired }), null)
  assert.equal(relayMissingNote({ packaged: true, relay: undefined, pairedFileExists: paired }), null)
  assert.equal(relayMissingNote({ packaged: false, relay: undefined, pairedFileExists: () => false }), null)
})
