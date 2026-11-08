// pane [상세] 토큰 — 대화 기록 usage 합계 · 같은 답 id 는 한 번 · 늘어난 부분만 · 계획서 → 기록 찾기
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tokens = require('../src/lib/token-usage.mts')
const { tempDir } = require('./temp-dirs')

const answer = (id, usage, block = 'text') => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: block }], usage } })
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const USAGE = { input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000 }

// 값이 준비될 때까지 짧은 간격으로 다시 본다(고정 시간만 기다리면 맥이 바쁠 때 흔들린다)
async function waitUntil(check, what, limitMs = 2000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error(`${what} 를 기다리다 시간 초과`)
}

function tempProjects() {
  const root = tempDir('token-usage-')
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
  await waitUntil(() => usage.peekSession(session) !== null, 'peekSession 값')
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
  await waitUntil(() => usage.peekPlan(['/bodies/acme'], plan) !== null && usage.peekPlan(['/bodies/globex'], plan) !== null, 'peekPlan 값')
  assert.deepEqual(usage.peekPlan(['/bodies/acme'], plan), { io: 100, cache: 5000 })
  assert.deepEqual(usage.peekPlan(['/bodies/globex'], plan), { io: 3, cache: 0 })
})

// Codex rollout(~/.codex/sessions/YYYY/MM/DD/rollout-<시각>-<세션>.jsonl) — 2026-11-04 실제 기록 203개의 키 모양:
// event_msg token_count 의 info.total_token_usage 는 세션 누적(파일 안에서 줄지 않음)이고 cached_input_tokens 는 input_tokens 안에 든다(넘는 줄 0개)
const codexMeta = (id, extra = {}) => JSON.stringify({ timestamp: '2026-11-04T00:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, cwd: '/w', source: 'cli', ...extra } })
const codexUser = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const codexCount = (input, cached, output) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } } })
function tempCodex() {
  const root = tempDir('token-usage-codex-')
  fs.mkdirSync(path.join(root, '2026/11/04'), { recursive: true })
  return root
}

test('Codex: 세션 id → rollout 파일 · 마지막 누적 값(입력+출력은 캐시 뺀 입력 + 출력)', async () => {
  const projectsDir = tempProjects()
  const codexSessionsDir = tempCodex()
  const session = '01a1a478-3430-7180-8b5f-6ea3162b0773'
  const file = path.join(codexSessionsDir, '2026/11/04', `rollout-2026-11-04T11-51-43-${session}.jsonl`)
  fs.writeFileSync(file, `${codexMeta(session)}\n${codexCount(1000, 600, 50)}\n${codexCount(3000, 2000, 200)}\n`)
  const usage = tokens.createTokenUsage({ projectsDir, codexSessionsDir })
  assert.deepEqual(await usage.sessionUsage(session), { io: 1000 + 200, cache: 2000 })
  fs.appendFileSync(file, `${codexCount(5000, 4000, 300)}\n`)
  assert.deepEqual(await usage.sessionUsage(session), { io: 1000 + 300, cache: 4000 }, '늘어난 부분의 마지막 누적 값')
})

test('Codex: 계획서 → rollout — AGENTS.md 문맥 뒤 첫 지시로 찾고, 하위 에이전트(parent_thread_id) rollout 은 넣지 않는다', async () => {
  const projectsDir = tempProjects()
  const codexSessionsDir = tempCodex()
  const plan = 'plans/task/x.md'
  const head = `${codexUser('# AGENTS.md instructions for /w\n…')}\n${codexUser(`이 작업의 계획서: /bodies/acme/${plan} — 먼저`)}\n`
  fs.writeFileSync(path.join(codexSessionsDir, '2026/11/04', 'rollout-a-11111111-aaaa.jsonl'), `${codexMeta('11111111-aaaa')}\n${head}${codexCount(100, 40, 10)}\n`)
  fs.writeFileSync(path.join(codexSessionsDir, '2026/11/04', 'rollout-b-22222222-bbbb.jsonl'), `${codexMeta('22222222-bbbb', { parent_thread_id: '11111111-aaaa' })}\n${head}${codexCount(9000, 0, 9000)}\n`)
  fs.writeFileSync(path.join(projectsDir, '-a', 'claude.jsonl'), `${user(`이 작업의 계획서: /bodies/acme/${plan} — `)}\n${answer('a1', USAGE)}\n`)
  const usage = tokens.createTokenUsage({ projectsDir, codexSessionsDir })
  assert.deepEqual(await usage.planUsage(['/bodies/acme'], plan), { io: 100 + 60 + 10, cache: 5000 + 40 }, 'Claude + Codex 를 더한다')
})
