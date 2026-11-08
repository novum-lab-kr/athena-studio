// @ts-check
// 좌측 하단 앱 업데이트 팝업이 뜰지 · 무엇으로 뜰지(src/lib/update-corner.mts)
const test = require('node:test')
const assert = require('node:assert/strict')
const { cornerView } = require('../src/lib/update-corner.mts')

/** @typedef {import('../src/lib/update-corner.mts').CornerStatus} CornerStatus */

/** @param {Partial<CornerStatus>} [over] @returns {CornerStatus} */
const dev = (over) => ({ state: 'behind', behind: 3, latest: null, phase: null, ...over })
// 배포판 상태(release-update.mts ReleaseStatus) — behind 는 늘 0
/** @param {Partial<CornerStatus>} [over] @returns {CornerStatus} */
const release = (over) => ({ state: 'behind', behind: 0, latest: '0.56.0', phase: null, ...over })

test('개발판 새 커밋 · 새 태그면 [업데이트] 팝업 — 열쇠는 따로 표시', () => {
  assert.deepEqual(cornerView(dev(), null), { kind: 'available', key: 'available:behind:3' })
  assert.deepEqual(cornerView(dev({ latest: '0.56.0' }), null), { kind: 'available', key: 'available:0.56.0' })
  // 받는 중 · 설치 중에도 같은 팝업(버튼만 막힌다)
  assert.deepEqual(cornerView(dev({ phase: 'installing' }), null), { kind: 'available', key: 'available:behind:3' })
})

test('설치 끝(phase ready)이면 배포판 · 개발판 모두 다시 시작 팝업 — 열쇠는 전과 같다', () => {
  assert.deepEqual(cornerView(dev({ phase: 'ready', latest: '0.56.0' }), null), { kind: 'ready', key: '0.56.0' })
  assert.deepEqual(cornerView(release({ phase: 'ready' }), null), { kind: 'ready', key: '0.56.0' })
})

test('배포판 behind(뒤에서 받는 중 · 받기 실패) · 최신 · 못 쓰는 상태는 안 뜬다', () => {
  assert.equal(cornerView(release(), null), null)
  assert.equal(cornerView(dev({ state: 'current', behind: 0 }), null), null)
  assert.equal(cornerView(dev({ state: 'unavailable', behind: 0 }), null), null)
  assert.equal(cornerView(null, null), null)
})

test('[나중에] 한 같은 새 판에는 다시 안 뜬다 — 새 판 안내를 닫아도 다시 시작 안내는 뜬다', () => {
  assert.equal(cornerView(dev({ latest: '0.56.0' }), 'available:0.56.0'), null)
  assert.equal(cornerView(dev(), 'available:behind:3'), null)
  // 커밋이 더 쌓이거나 새 태그면 다시
  assert.deepEqual(cornerView(dev({ behind: 4 }), 'available:behind:3'), { kind: 'available', key: 'available:behind:4' })
  assert.deepEqual(cornerView(dev({ latest: '0.57.0' }), 'available:0.56.0'), { kind: 'available', key: 'available:0.57.0' })
  assert.deepEqual(cornerView(dev({ latest: '0.56.0', phase: 'ready' }), 'available:0.56.0'), { kind: 'ready', key: '0.56.0' })
  assert.equal(cornerView(release({ phase: 'ready' }), '0.56.0'), null)
})
