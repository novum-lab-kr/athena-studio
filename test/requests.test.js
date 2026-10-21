const test = require('node:test')
const assert = require('node:assert/strict')
const requests = require('../src/lib/requests')

const sample = (extra = {}) => ({
  id: 'r-20261021-141520-1080', kind: 'question', title: '필드가 있나요?', body: '근거', state: 'open', rev: 2,
  options: [{ label: '있다', desc: '표시' }, { label: '없다', recommended: true }, { desc: '라벨 없음' }],
  links: { plan: 'plans/task/x.md', html: null }, pane: 'w1:p3', createdAt: '2026-10-21T05:15:20.000Z', ...extra,
})

test('목록: 열린 것(open · answered)만 · 오래된 것 먼저 · 화면 모양', () => {
  const result = requests.normalizeRequests({ ok: true, requests: [
    sample({ id: 'r-2', createdAt: '2026-10-21T06:00:00.000Z' }),
    sample({ id: 'r-1', state: 'answered' }),
    sample({ id: 'r-3', state: 'delivered' }),
    sample({ id: 'r-4', kind: 'other' }),
  ] })
  assert.equal(result.supported, true)
  assert.deepEqual(result.requests.map((request) => request.id), ['r-1', 'r-2'])
  const first = result.requests[0]
  assert.equal(first.plan, 'plans/task/x.md')
  assert.equal(first.pane, 'w1:p3')
  assert.deepEqual(first.options.map((option) => option.label), ['있다', '없다'])
  assert.equal(first.options[1].recommended, true)
})

test('목록: request 명령이 없는 옛 코어는 supported:false · 일시 실패는 supported 유지', () => {
  assert.equal(requests.normalizeRequests({ ok: false, error: 'usage' }).supported, false)
  assert.equal(requests.normalizeRequests({ ok: false, error: 'bad-output' }).supported, false)
  assert.equal(requests.normalizeRequests({ ok: false, error: 'locked' }).supported, true)
  assert.deepEqual(requests.normalizeRequests(null).requests, [])
})

test('배지 숫자는 아직 답하지 않은 것(open)만', () => {
  assert.equal(requests.waitingCount([{ state: 'open' }, { state: 'answered' }, { state: 'open' }]), 2)
  assert.equal(requests.waitingCount(null), 0)
})

test('기다린 시간', () => {
  const now = Date.parse('2026-10-21T06:00:00.000Z')
  assert.equal(requests.waitedLabel('2026-10-21T05:59:50.000Z', now), '1분')
  assert.equal(requests.waitedLabel('2026-10-21T05:48:00.000Z', now), '12분')
  assert.equal(requests.waitedLabel('2026-10-21T03:00:00.000Z', now), '3시간')
  assert.equal(requests.waitedLabel('2026-10-18T06:00:00.000Z', now), '3일')
  assert.equal(requests.waitedLabel('모름', now), '')
})

test('답하기 인자 — 빈 값은 빼고 rev 는 정수일 때만', () => {
  assert.deepEqual(requests.answerArgs('r-1', { choice: ' 없다 ', text: '', rev: 2 }), ['request', 'answer', 'r-1', '--by', 'app', '--choice', '없다', '--rev', '2'])
  assert.deepEqual(requests.answerArgs('r-1', { text: '이름은 cancel_note' }), ['request', 'answer', 'r-1', '--by', 'app', '--text', '이름은 cancel_note'])
})

test('pane 에 넣을 한 줄 — 요청 번호 · 줄바꿈 없음', () => {
  const line = requests.deliveryLine(sample(), { choice: '있다', text: '이름은\ncancel_note' })
  assert.equal(line, '[요청 r-20261021-141520-1080] 필드가 있나요? — 답: 있다 · 이름은 cancel_note')
})

test('새로 생긴 open 요청만(알림용)', () => {
  const list = [{ id: 'a', state: 'open' }, { id: 'b', state: 'open' }, { id: 'c', state: 'answered' }]
  assert.deepEqual(requests.newlyOpened(['a'], list).map((request) => request.id), ['b'])
  assert.deepEqual(requests.newlyOpened(new Set(), list).map((request) => request.id), ['a', 'b'])
})
