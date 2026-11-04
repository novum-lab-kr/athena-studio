// 메뉴 막대 최근 7일 토큰 — 날짜별 · Claude 답 id 한 번(파일을 넘어서도) · 서브에이전트 기록 포함 · Codex 요청마다(중복 줄 · 이어 쓴 누적은 빼고) · 늘어난 부분만
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const daily = require('../src/lib/daily-tokens.mts')
const { tempDir } = require('./temp-dirs')

// 현지 시각 문자열(Z 없음)을 ISO 로 — 날짜 경계를 이 맥 시간대로 시험한다
const at = (local) => new Date(local).toISOString()
const claude = (id, local, usage) => JSON.stringify({ type: 'assistant', timestamp: at(local), message: { id, content: [{ type: 'text' }], usage } })
const codex = (local, total, last) => JSON.stringify({ type: 'event_msg', timestamp: at(local), payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } } })
// 입력 10 + 캐시 생성 1000 + 출력 90 = 1100 (캐시 읽기 4000 은 뺀다)
const USAGE = { input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000 }

test('날짜 칸: 오늘을 끝으로 7일 · 현지 날짜', () => {
  const now = new Date('2026-11-04T09:00:00').getTime()
  assert.deepEqual(daily.lastDays(now), ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'])
  assert.equal(daily.dayKey(new Date('2026-11-04T23:59:00').getTime()), '2026-11-04')
  assert.equal(daily.startOfDay('2026-11-04'), new Date('2026-11-04T00:00:00').getTime())
})

test('Claude: 입력 + 캐시 생성 + 출력 · 같은 답은 여러 줄 · 여러 파일(서브에이전트 · 이어 하기)이어도 한 번', () => {
  const tally = new daily.DailyTokens()
  tally.feed('/a.jsonl', 'claude', [claude('m1', '2026-11-03T10:00:00', USAGE), claude('m1', '2026-11-03T10:00:00', USAGE), claude('m2', '2026-11-04T01:00:00', { input_tokens: 1, output_tokens: 2 }), '{깨진 줄'].join('\n'))
  tally.feed('/a/subagents/agent-1.jsonl', 'claude', [claude('m1', '2026-11-03T10:00:00', USAGE), claude('s1', '2026-11-04T02:00:00', { input_tokens: 5, output_tokens: 5 })].join('\n'))
  assert.deepEqual(tally.totals(['2026-11-03', '2026-11-04']), [{ day: '2026-11-03', claude: 1100, codex: 0 }, { day: '2026-11-04', claude: 13, codex: 0 }])
  // 파일을 잊으면 그 파일이 센 답 id 도 놓아준다(다시 읽으면 다시 센다)
  tally.drop('/a.jsonl')
  assert.equal(tally.seen.has('m1'), false)
  assert.equal(tally.seen.has('s1'), true)
})

test('Codex: 요청마다 입력 - 캐시 읽기 + 출력 · 누적이 그대로인 줄은 한 번 · 이어 쓴 파일의 첫 누적은 더하지 않는다', () => {
  const tally = new daily.DailyTokens()
  const last = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } // 250
  // 첫 줄 누적 5,000,000 — 앞 세션 몫이 든 이어 쓴 파일이어도 이번 요청(250)만
  tally.feed('/rollout-1.jsonl', 'codex', [codex('2026-11-04T09:00:00', 5000000, last), codex('2026-11-04T09:00:01', 5000000, last), codex('2026-11-04T09:10:00', 5001050, last)].join('\n'))
  assert.deepEqual(tally.totals(['2026-11-04']), [{ day: '2026-11-04', claude: 0, codex: 500 }])
})

test('훑기: 늘어난 부분만 · 쓰다 만 줄은 다음에 · 기간 밖 파일은 안 읽고 · 없어진 파일은 잊는다', async () => {
  const root = tempDir('daily-tokens-')
  const claudeDir = path.join(root, 'projects')
  const codexDir = path.join(root, 'sessions')
  fs.mkdirSync(path.join(claudeDir, '-p', 's1', 'subagents'), { recursive: true })
  fs.mkdirSync(path.join(codexDir, '2026', '11', '04'), { recursive: true })
  const main = path.join(claudeDir, '-p', 's1.jsonl')
  const sub = path.join(claudeDir, '-p', 's1', 'subagents', 'agent-1.jsonl')
  const old = path.join(claudeDir, '-p', 'old.jsonl')
  const roll = path.join(codexDir, '2026', '11', '04', 'rollout-x.jsonl')
  fs.writeFileSync(main, `${claude('m1', '2026-11-04T10:00:00', USAGE)}\n${claude('m2', '2026-11-04T10:01:00', USAGE).slice(0, 30)}`)
  fs.writeFileSync(sub, `${claude('s1', '2026-11-04T10:02:00', { output_tokens: 7 })}\n`)
  fs.writeFileSync(old, `${claude('o1', '2026-11-04T10:00:00', USAGE)}\n`)
  fs.utimesSync(old, new Date('2026-10-01T00:00:00'), new Date('2026-10-01T00:00:00'))
  fs.writeFileSync(roll, `${codex('2026-11-04T11:00:00', 100, { input_tokens: 60, cached_input_tokens: 10, output_tokens: 40 })}\n{깨진 줄\n`)
  fs.writeFileSync(path.join(codexDir, '2026', '11', '04', 'other.jsonl'), `${codex('2026-11-04T11:00:00', 100, { input_tokens: 60, output_tokens: 40 })}\n`)
  const since = new Date('2026-10-29T00:00:00').getTime()
  const tally = new daily.DailyTokens()
  await tally.scan({ claudeDir, codexDir, since })
  assert.deepEqual(tally.totals(['2026-11-04']), [{ day: '2026-11-04', claude: 1107, codex: 90 }])
  // 쓰다 만 줄을 마저 쓰면 그 줄부터
  fs.writeFileSync(main, `${claude('m1', '2026-11-04T10:00:00', USAGE)}\n${claude('m2', '2026-11-04T10:01:00', USAGE)}\n`)
  await tally.scan({ claudeDir, codexDir, since })
  assert.deepEqual(tally.totals(['2026-11-04']), [{ day: '2026-11-04', claude: 2207, codex: 90 }])
  // 없어진 파일은 잊는다
  fs.rmSync(sub)
  await tally.scan({ claudeDir, codexDir, since })
  assert.deepEqual(tally.totals(['2026-11-04']), [{ day: '2026-11-04', claude: 2200, codex: 90 }])
  // 다시 쓴 파일(더 짧다) — 처음부터
  fs.writeFileSync(main, `${claude('m3', '2026-11-04T12:00:00', { output_tokens: 1 })}\n`)
  await tally.scan({ claudeDir, codexDir, since })
  assert.deepEqual(tally.totals(['2026-11-04']), [{ day: '2026-11-04', claude: 1, codex: 90 }])
})
