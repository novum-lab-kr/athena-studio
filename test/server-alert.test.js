// 서버 문제 알림 판정(src/lib/server-alert.mts) — 계획서 plans/feature/20261125-서버-문제-알림.md D1 · 5절 · 7절
// 가짜 읽기 결과로: 멈춤 → 알림 1번 · 같은 상태 반복 → 0번 · 회복 → 1번 · 연속 2번 조건 · 볼 수 없는 것은 회복으로 치지 않음
const test = require('node:test')
const assert = require('node:assert/strict')
const { observe, issuesOf, memoryFrom, alertText, MIN_GAP_MS, REMIND_MS } = require('../src/lib/server-alert.mts')

const MINUTE = 60_000
const BASE = 1_800_000_000_000 // 실제 시각처럼(0 은 '아직 안 읽음')
const healthy = (extra = {}) => ({ ok: true, failed: [], disks: [{ mount: '/', percent: 40 }], diskPercent: 40, memPercent: 30, ...extra })
const reading = (at, status = healthy(), web = null, name = 'web1') => ({ name, host: 'web1', status, web, at: BASE + at })
const okWeb = (extra = {}) => ({ ok: true, code: 200, ms: 120, certDate: '2027-01-01', certDays: 60, ...extra })

// 읽기를 차례로 넣고 읽기마다 사건 목록(type:kind:target)
function run(readings, memory = {}) {
  return readings.map((item) => observe(memory, [item], item.at).map((event) => `${event.type}:${event.kind}:${event.target}`))
}

test('서비스 멈춤 — 처음 1번 · 같은 상태 0번 · 풀리면 회복 1번 · 다시 생기면 다시', () => {
  const stopped = healthy({ failed: ['nginx'] })
  const steps = run([reading(0, stopped), reading(5 * MINUTE, stopped), reading(10 * MINUTE, stopped), reading(15 * MINUTE), reading(20 * MINUTE), reading(25 * MINUTE, stopped)])
  assert.deepEqual(steps, [['problem:failed:nginx'], [], [], ['recovered:failed:nginx'], [], ['problem:failed:nginx']])
})

test('서비스는 이름마다 따로 — 하나가 풀려도 다른 하나는 남는다', () => {
  const steps = run([reading(0, healthy({ failed: ['nginx', 'redis'] })), reading(5 * MINUTE, healthy({ failed: ['redis'] }))])
  assert.deepEqual(steps, [['problem:failed:nginx', 'problem:failed:redis'], ['recovered:failed:nginx']])
})

test('접속 안 됨 — 한 번 실패는 알리지 않고 연속 2번부터 · 한 번 실패 뒤 성공이면 아무것도', () => {
  const down = { ok: false, reason: 'timeout' }
  assert.deepEqual(run([reading(0, down), reading(5 * MINUTE), reading(10 * MINUTE, down), reading(15 * MINUTE)]), [[], [], [], []])
  assert.deepEqual(run([reading(0, down), reading(5 * MINUTE, down), reading(10 * MINUTE, down), reading(15 * MINUTE)]), [[], ['problem:down:'], [], ['recovered:down:']])
})

test('코어가 옛것(core-old)은 서버 문제가 아니다', () => {
  const old = { ok: false, reason: 'core-old' }
  assert.deepEqual(run([reading(0, old), reading(5 * MINUTE, old), reading(10 * MINUTE, old)]), [[], [], []])
})

test('메모리 90% 넘음 — 연속 2번 읽기에서만 · 90% 는 넘음이 아니다', () => {
  const high = healthy({ memPercent: 95 })
  assert.deepEqual(run([reading(0, high), reading(5 * MINUTE), reading(10 * MINUTE, high)]), [[], [], []])
  assert.deepEqual(run([reading(0, high), reading(5 * MINUTE, high), reading(10 * MINUTE, high), reading(15 * MINUTE)]), [[], ['problem:mem:'], [], ['recovered:mem:']])
  assert.deepEqual(run([reading(0, healthy({ memPercent: 90 })), reading(5 * MINUTE, healthy({ memPercent: 90 }))]), [[], []])
})

test('디스크 90% 넘음 — 마운트마다 · 마운트 목록이 없으면 diskPercent 를 / 로', () => {
  const full = healthy({ disks: [{ mount: '/', percent: 50 }, { mount: '/var', percent: 93 }] })
  assert.deepEqual(run([reading(0, full), reading(5 * MINUTE, full), reading(10 * MINUTE)]), [['problem:disk:/var'], [], ['recovered:disk:/var']])
  assert.deepEqual(issuesOf(reading(0, healthy({ disks: [], diskPercent: 91 }))), [{ kind: 'disk', target: '/', value: 91 }])
})

test('사이트 응답 없음 — 응답 확인이 실패하면 · 응답이 오면 회복', () => {
  const failing = { ok: false, reason: 'unreachable' }
  assert.deepEqual(run([reading(0, healthy(), failing), reading(5 * MINUTE, healthy(), failing), reading(10 * MINUTE, healthy(), okWeb())]), [['problem:web:'], [], ['recovered:web:']])
})

test('사이트 5xx — 문제 한 번 · 코드가 바뀌어도 같은 문제 · 닿지 않음으로 바뀌어도 같은 문제 · 4xx 는 문제 아님 · 2xx 면 회복', () => {
  const steps = run([
    reading(0, healthy(), okWeb({ code: 503 })),
    reading(5 * MINUTE, healthy(), okWeb({ code: 502 })),
    reading(10 * MINUTE, healthy(), { ok: false, reason: 'timeout' }),
    reading(15 * MINUTE, healthy(), okWeb({ code: 200 })),
    reading(20 * MINUTE, healthy(), okWeb({ code: 404 })),
    reading(25 * MINUTE, healthy(), okWeb({ code: 500 })),
  ])
  assert.deepEqual(steps, [['problem:web:'], [], [], ['recovered:web:'], [], ['problem:web:']])
})

test('인증서 14일 안 — 처음 한 번 · 남아 있으면 하루에 한 번 다시 · 갱신되면 회복', () => {
  const memory = {}
  const soon = okWeb({ certDays: 10 })
  const at = (time, web) => observe(memory, [reading(time, healthy(), web)], BASE + time).map((event) => `${event.type}:${event.kind}:${event.value}`)
  assert.deepEqual(at(0, soon), ['problem:cert:10'])
  assert.deepEqual(at(5 * MINUTE, soon), [])
  assert.deepEqual(at(REMIND_MS - MINUTE, okWeb({ certDays: 9 })), [])
  assert.deepEqual(at(REMIND_MS, okWeb({ certDays: 9 })), ['problem:cert:9'])
  assert.deepEqual(at(REMIND_MS + 5 * MINUTE, okWeb({ certDays: 9 })), [])
  assert.deepEqual(at(REMIND_MS + 10 * MINUTE, okWeb({ certDays: 89 })), ['recovered:cert:9'])
})

test('볼 수 없는 문제는 회복으로 치지 않는다 — 접속 실패 중의 디스크 · 응답 실패 중의 인증서', () => {
  const memory = {}
  const full = healthy({ disks: [{ mount: '/', percent: 95 }] })
  const down = { ok: false, reason: 'unreachable' }
  const steps = run([reading(0, full, okWeb({ certDays: 3 })), reading(5 * MINUTE, down, { ok: false, reason: 'timeout' }), reading(10 * MINUTE, down, { ok: false, reason: 'timeout' }), reading(15 * MINUTE, full, okWeb({ certDays: 3 }))], memory)
  assert.deepEqual(steps, [['problem:disk:/', 'problem:cert:'], ['problem:web:'], ['problem:down:'], ['recovered:web:', 'recovered:down:']])
})

test('같은 서버를 1분 안에 또 읽은 것은 세지 않는다(같은 팩 창 둘)', () => {
  const down = { ok: false, reason: 'timeout' }
  assert.deepEqual(run([reading(0, down), reading(MIN_GAP_MS - 1000, down), reading(5 * MINUTE, down)]), [[], [], ['problem:down:']])
})

test('팩에서 빠진 서버는 조용히 잊는다 — 회복 알림 없음', () => {
  const memory = {}
  assert.equal(observe(memory, [reading(0, healthy({ failed: ['nginx'] }))], BASE).length, 1)
  assert.deepEqual(observe(memory, [reading(5 * MINUTE, healthy(), null, 'other')], BASE + 5 * MINUTE), [])
  assert.equal(memory.web1, undefined)
})

test('기억 파일을 다시 읽어도 같은 문제는 다시 알리지 않는다 · 모양이 틀린 기억은 빈 기억', () => {
  const memory = {}
  const stopped = healthy({ failed: ['nginx'] })
  observe(memory, [reading(0, stopped)], BASE)
  const again = memoryFrom(JSON.parse(JSON.stringify(memory)))
  assert.deepEqual(observe(again, [reading(5 * MINUTE, stopped)], BASE + 5 * MINUTE), [])
  assert.deepEqual(memoryFrom('broken'), {})
  assert.deepEqual(memoryFrom({ web1: { active: { 'failed:x': { since: 'a' } } } }), { web1: { at: 0, streak: {}, active: {} } })
})

test('알림 글 — 서버 이름 · 무엇이 문제인지만(주소 · 원문 없음)', () => {
  const say = (key, values = {}) => `${key}${Object.keys(values).length ? ` ${JSON.stringify(values)}` : ''}`
  const event = (type, kind, target, value) => ({ type, server: 'web1', kind, target, value })
  assert.deepEqual(alertText(event('problem', 'failed', 'nginx', 'nginx'), say), { title: 'serverAlert.problem {"server":"web1"}', body: 'serverAlert.failed {"name":"nginx"}' })
  assert.equal(alertText(event('problem', 'down', '', 'timeout'), say).body, 'serverAlert.down {"reason":"server.reason.timeout"}')
  assert.equal(alertText(event('problem', 'web', '', 'cert'), say).body, 'serverAlert.web {"reason":"server.web.cert"}')
  assert.equal(alertText(event('problem', 'web', '', 503), say).body, 'server.warn.http {"code":503}')
  assert.equal(alertText(event('problem', 'cert', '', -2), say).body, 'server.warn.certGone')
  assert.deepEqual(alertText(event('recovered', 'disk', '/var', 95), say), { title: 'serverAlert.recovered {"server":"web1"}', body: 'serverAlert.ok.disk {"name":"/var","mount":"/var"}' })
})
