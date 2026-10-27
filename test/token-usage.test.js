// pane [상세] 토큰 — 대화 기록 usage 합계 · 같은 답 id 는 한 번 · 늘어난 부분만 · 계획서 → 기록 찾기
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tokens = require('../src/lib/token-usage')

const answer = (id, usage, block = 'text') => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: block }], usage } })
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const USAGE = { input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000 }

function tempProjects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-'))
  fs.mkdirSync(path.join(root, '-a'))
  fs.mkdirSync(path.join(root, '-b'))
  return root
}

test('한 답이 내용 조각마다 여러 줄로 적혀도 한 번만 센다 · 입력+출력과 캐시를 따로', () => {
  const tally = tokens.newTally()
  tokens.feedLines(tally, [answer('m1', USAGE, 'thinking'), answer('m1', USAGE, 'tool_use'), answer('m2', { input_tokens: 1, output_tokens: 2 }), user('안녕'), '깨진 줄 {'].join('\n'))
  assert.deepEqual(tokens.totalsOf(tally), { io: 103, cache: 5000 })
})

test('늘어난 부분만 읽는다 · 쓰다 만 줄은 다음에 · 파일이 줄면 처음부터', async () => {
  const root = tempProjects()
  const file = path.join(root, '-a', 's1.jsonl')
  fs.writeFileSync(file, `${answer('m1', USAGE)}\n${answer('m2', USAGE).slice(0, 20)}`)
  const tally = tokens.newTally()
  await tokens.readGrowth(file, tally)
  assert.deepEqual(tokens.totalsOf(tally), { io: 100, cache: 5000 })
  const offset = tally.offset
  // 쓰다 만 줄을 마저 쓰면 그 줄부터 이어 읽는다
  fs.writeFileSync(file, `${answer('m1', USAGE)}\n${answer('m2', USAGE)}\n`)
  await tokens.readGrowth(file, tally)
  assert.ok(tally.offset > offset)
  assert.deepEqual(tokens.totalsOf(tally), { io: 200, cache: 10000 })
  // 새로 쓴 파일(더 짧다) — 처음부터 다시
  fs.writeFileSync(file, `${answer('m9', { input_tokens: 5, output_tokens: 5 })}\n`)
  await tokens.readGrowth(file, tally)
  assert.deepEqual(tokens.totalsOf(tally), { io: 10, cache: 0 })
})

test('계획서 → 기록: 첫 사용자 글이 "이 작업의 계획서: <본체>/<계획서> —" · "리뷰할 계획서:" 로 시작하는 것만', async () => {
  const root = tempProjects()
  const body = '/home/me/.athena-studio/bodies/acme'
  const plan = 'plans/task/20261027-x.md'
  const reminder = '<system-reminder>훅 글</system-reminder>\n'
  fs.writeFileSync(path.join(root, '-a', 'work.jsonl'), `${user(`${reminder}이 작업의 계획서: ${body}/${plan} — 먼저 읽고`)}\n${answer('w1', USAGE)}\n`)
  fs.writeFileSync(path.join(root, '-b', 'review.jsonl'), `${user(`리뷰할 계획서: ${body}/${plan} — 보고`)}\n${answer('r1', { input_tokens: 1, output_tokens: 1 })}\n`)
  // 다른 계획서를 언급만 한 세션 · 다른 계획서
  fs.writeFileSync(path.join(root, '-b', 'other.jsonl'), `${user(`이것 봐 — 이 작업의 계획서: ${body}/${plan} — `)}\n${answer('o1', USAGE)}\n`)
  fs.writeFileSync(path.join(root, '-b', 'else.jsonl'), `${user(`이 작업의 계획서: ${body}/plans/task/else.md — `)}\n${answer('e1', USAGE)}\n`)
  const usage = tokens.createTokenUsage({ projectsDir: root })
  assert.deepEqual(await usage.planUsage([body], plan), { io: 102, cache: 5000 })
  // 기록이 없는 계획서는 null(화면에서 숨긴다 — 0 으로 보이지 않게)
  assert.equal(await usage.planUsage([body], 'plans/task/none.md'), null)
})

test('세션 하나: <세션>.jsonl 을 어느 폴더에서든 찾는다 · 없으면 null', async () => {
  const root = tempProjects()
  const session = '0b1c2d3e-aaaa-bbbb-cccc-1234567890ab'
  fs.writeFileSync(path.join(root, '-b', `${session}.jsonl`), `${user('안녕')}\n${answer('a1', USAGE)}\n${answer('a1', USAGE)}\n`)
  const usage = tokens.createTokenUsage({ projectsDir: root })
  assert.deepEqual(await usage.sessionUsage(session), { io: 100, cache: 5000 })
  assert.equal(await usage.sessionUsage('ffffffff-0000-0000-0000-000000000000'), null)
})

test('peek: 기다리지 않고 아는 값을 준다 — 처음엔 null, 다 읽은 뒤엔 그 값 · 이상한 세션 id 는 null', async () => {
  const root = tempProjects()
  const session = '0b1c2d3e-aaaa-bbbb-cccc-1234567890ab'
  fs.writeFileSync(path.join(root, '-a', `${session}.jsonl`), `${answer('a1', USAGE)}\n`)
  const usage = tokens.createTokenUsage({ projectsDir: root })
  assert.equal(usage.peekSession(session), null)
  await new Promise((done) => setTimeout(done, 50))
  assert.deepEqual(usage.peekSession(session), { io: 100, cache: 5000 })
  assert.equal(usage.peekSession('../../etc'), null)
})

test('숫자 줄이기: 42k · 3.1M', () => {
  assert.equal(tokens.formatTokens(0), '0')
  assert.equal(tokens.formatTokens(950), '950')
  assert.equal(tokens.formatTokens(1234), '1.2k')
  assert.equal(tokens.formatTokens(42000), '42k')
  assert.equal(tokens.formatTokens(3100000), '3.1M')
  assert.equal(tokens.formatTokens(10290779), '10M')
})

test('peekPlan: 본체가 다르면 같은 계획서 경로라도 값을 따로 둔다', async () => {
  const root = tempProjects()
  const plan = 'plans/task/same.md'
  fs.writeFileSync(path.join(root, '-a', 'acme.jsonl'), `${user(`이 작업의 계획서: /bodies/acme/${plan} — `)}\n${answer('a1', USAGE)}\n`)
  fs.writeFileSync(path.join(root, '-b', 'globex.jsonl'), `${user(`이 작업의 계획서: /bodies/globex/${plan} — `)}\n${answer('g1', { input_tokens: 1, output_tokens: 2 })}\n`)
  const usage = tokens.createTokenUsage({ projectsDir: root })
  usage.peekPlan(['/bodies/acme'], plan)
  usage.peekPlan(['/bodies/globex'], plan)
  await new Promise((done) => setTimeout(done, 80))
  assert.deepEqual(usage.peekPlan(['/bodies/acme'], plan), { io: 100, cache: 5000 })
  assert.deepEqual(usage.peekPlan(['/bodies/globex'], plan), { io: 3, cache: 0 })
})
