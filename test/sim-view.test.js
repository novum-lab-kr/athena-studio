// @ts-check
// 시뮬레이터 칸 판정(src/lib/sim-view.mts) — 첫 열기 '기기 없음' · ⟳ 뒤 '켜진 기기가 없어요' 회귀
const test = require('node:test')
const assert = require('node:assert/strict')
const { pickSelected, screenNote } = require('../src/lib/sim-view.mts')

const iphone = { id: 'IPHONE', booted: true }
const ipad = { id: 'IPAD', booted: false }
const avd = { id: 'avd:syung36', booted: false }
/** @param {Partial<import('../src/lib/sim-view.mts').ScreenState>} part */
const state = (part) => ({ loaded: true, busy: '', error: '', running: false, frameMissing: false, devices: [iphone, ipad], ...part })

test('첫 목록을 읽기 전 · 읽는 중에는 "기기 찾는 중" — "기기 없음" 이 아니다', () => {
  assert.equal(screenNote(state({ loaded: false, busy: '', devices: [] })), 'loading')
  assert.equal(screenNote(state({ loaded: false, busy: 'list', devices: [] })), 'loading')
  // 다 읽었는데 정말 없을 때만
  assert.equal(screenNote(state({ devices: [] })), 'noDevices')
})

test('켜진 기기가 있는데 열려 있지 않으면 [열기] 안내 · 켜진 것이 없을 때만 "켜진 기기가 없어요"', () => {
  assert.equal(screenNote(state({})), 'pickBooted')
  assert.equal(screenNote(state({ devices: [ipad, avd] })), 'noRunning')
})

test('여는 중 · 오류 · 열림 · Android 첫 그림 기다림', () => {
  assert.equal(screenNote(state({ busy: 'start' })), 'starting')
  assert.equal(screenNote(state({ error: '시간이 넘어 멈췄어요' })), 'error')
  assert.equal(screenNote(state({ running: true })), '')
  assert.equal(screenNote(state({ running: true, frameMissing: true })), 'loading')
})

test('고를 기기: 고르던 것 → 열어 둔 것 → 켜진 것 → 첫 기기 · 목록에 없는 id 는 남기지 않는다', () => {
  assert.equal(pickSelected([iphone, ipad], 'IPAD', 'IPHONE'), 'IPAD')
  assert.equal(pickSelected([iphone, ipad], '', 'IPHONE'), 'IPHONE')
  assert.equal(pickSelected([ipad, iphone], '', ''), 'IPHONE')
  assert.equal(pickSelected([ipad, avd], '', ''), 'IPAD')
  assert.equal(pickSelected([], '', ''), '')
  // 열어 둔 Android 가 밖에서 꺼져 목록에서 빠졌다 — 그 일련번호를 고른 채 두지 않는다
  assert.equal(pickSelected([iphone, ipad, avd], 'emulator-5554', 'emulator-5554'), 'IPHONE')
})
