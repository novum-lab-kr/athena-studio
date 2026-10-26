#!/usr/bin/env node
/**
 * TypeSafe Jev(System One 모델) 호출 — 아테나에서 Jev 를 부르는 곳은 이 파일 하나다.
 * Jev 는 글을 쓰지 않고 판정만 한다: choice(보기 중 하나) · score(루브릭 점수) · noul(참일 정도 0~1). 문서 https://docs.typesafe.ai/
 *
 *   askJev({ purpose, state, questions, meta }) → { model, answers, usage } | null
 *     키가 없거나(ATHENA_JEV=off 포함) 실패·시간 초과면 null — 부르는 쪽은 null 이면 Jev 없이 원래대로 돈다
 *   jevEnabled() → 키가 있고 꺼져 있지 않은가
 *   logJev(entry) → 기록에 한 줄 더(측정용 결과 — 예: 배우기 검토 나란히 판정의 실제 결과)
 *
 *   node scripts/lib/jev.mjs --report      # 쓰임새별 호출 수·실패·입력 토큰·추정 비용, 배우기 검토 나란히 판정 표
 *
 * 쓰는 곳 (도입 2026-10-15 — 틀려도 되돌릴 수 있고 눈에 띄는 곳만 Jev 단독)
 *   qa-explain       QA 미분류 오류의 원인 추정(scripts/qa/explain.mjs · board/server.mjs) — 표시만, 원문·판정은 그대로
 *   learn-dedupe     학습 후보가 공책 기존 줄과 같은지(scripts/board/learn.mjs) — 아주 높으면 휴지통, 중간이면 [학습] 탭 힌트
 *   learn-review     배우기 검토 나란히 판정(scripts/learn-review.mjs) — 건너뛰지 않고 기록만, 놓치는 비율을 잰 뒤 바꾼다
 *
 * 키 — 사람마다 본인 키(나눠 쓰지 않는다 — 사용량은 키 주인에게, SaaS 에서도 고객이 자기 키를 넣는 방식). 값은 어디에도 출력하지 않는다
 *   등록: node scripts/jev-key.mjs (사용자가 직접 치는 입력 창 — 대화창에 키를 받지 않는다) → ~/.config/athena/typesafe.key (권한 600)
 *   환경 변수 TYPESAFE_API_KEY 가 있으면 그게 먼저다. 둘 다 없으면 Jev 를 부르지 않는다
 *   부를 때마다 다시 읽는다 — 등록·지우기가 일감·배우기 검토를 다시 켜지 않아도 바로 먹는다
 * 설정(환경 변수)
 *   ATHENA_JEV=off     키가 있어도 끈다
 *   TYPESAFE_API_URL   주소 바꾸기(시험용 가짜 서버) — 기본 https://api.typesafe.ai/v1/systemone
 *
 * 보내는 글은 비밀값 모양(key=값 · "key":"값" · Bearer · JWT)을 한 번 더 가린다(qa/live.mjs maskText). 보내는 글 자체는 기록하지 않는다
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { maskText } from '../qa/live.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const JEV_LOG = join(ROOT, '.jev-log.jsonl')
const API_URL = process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'
// 입력 한도는 문서에 없다 — 넘치면 앞부분만 보낸다(부르는 쪽이 중요한 것을 앞에 둔다)
const MAX_STATE_CHARS = 60_000
// 블로그 공개 가격(2026-10-15 확인) — 입력 $0.042 / 100만 토큰, 출력 무료. 보고용 추정일 뿐이다
const INPUT_USD_PER_TOKEN = 0.042 / 1_000_000

// 레포 밖, 이 사람 컴퓨터에만 — 이름이 .key 라 비밀값 보호 훅(scripts/hooks/secret-guard.py)이 에이전트의 읽기를 막는다
export const JEV_KEY_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'athena', 'typesafe.key')
const readKeyFile = () => {
  try { return readFileSync(JEV_KEY_FILE, 'utf8').trim() } catch { return '' }
}
// 키가 어디서 오나 — 'env' | 'file' | ''
export const jevKeySource = () => (process.env.TYPESAFE_API_KEY ? 'env' : readKeyFile() ? 'file' : '')
const jevKey = () => process.env.TYPESAFE_API_KEY || readKeyFile()

export const jevEnabled = () => Boolean(jevKeySource()) && process.env.ATHENA_JEV !== 'off'

// 키가 맞는지 — 아주 작은 질문 하나로 HTTP 상태만 본다(키 값은 돌려주지 않는다). 네트워크 실패면 0
export async function checkJevKey(key = jevKey()) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: '키 확인', model: MODEL, questions: { ok: { type: 'noul', instructions: '이 글은 비어 있지 않다' } } }),
      signal: AbortSignal.timeout(15_000),
    })
    return response.status
  } catch {
    return 0
  }
}

export const logJev = (entry) => {
  try {
    appendFileSync(JEV_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // 기록을 못 남겨도 판정은 쓴다
  }
}

// 답에서 기록에 남길 것만 — 확률표 전체는 길어서 choice·score·noul·confidence 만
const compactAnswers = (answers = {}) => Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, Object.fromEntries(['choice', 'score', 'noul', 'confidence'].filter((key) => answer?.[key] !== undefined).map((key) => [key, answer[key]]))]))

export async function askJev({ purpose, state, questions, meta = {}, timeoutMs = 15_000 }) {
  if (!jevEnabled()) return null
  const startedAt = Date.now()
  const text = maskText(typeof state === 'string' ? state : JSON.stringify(state)).slice(0, MAX_STATE_CHARS)
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jevKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: text, model: MODEL, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (!body?.answers || typeof body.answers !== 'object') throw new Error('답에 answers 가 없다')
    logJev({ purpose, ok: true, model: body.model ?? '', ms: Date.now() - startedAt, chars: text.length, usage: body.usage ?? null, answers: compactAnswers(body.answers), ...meta })
    return { model: body.model ?? '', answers: body.answers, usage: body.usage ?? null }
  } catch (error) {
    // 오류 문구에 키가 섞일 일은 없지만(헤더는 문구에 안 나온다) 가린 뒤 남긴다
    logJev({ purpose, ok: false, ms: Date.now() - startedAt, chars: text.length, error: maskText(String(error?.message ?? error)).slice(0, 200), ...meta })
    return null
  }
}

// ── 보고 ──────────────────────────────────────────────────────────────
const readLog = () => (existsSync(JEV_LOG) ? readFileSync(JEV_LOG, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } }) : [])

function report() {
  const entries = readLog()
  if (!entries.length) {
    console.log(`Jev 기록이 아직 없다 (${JEV_LOG}) — 키: ${jevEnabled() ? '있음' : '없음 또는 꺼짐'} (node scripts/jev-key.mjs --status)`)
    return
  }
  const calls = entries.filter((entry) => entry.ok !== undefined)
  const byPurpose = new Map()
  for (const entry of calls) {
    const row = byPurpose.get(entry.purpose) ?? { calls: 0, failed: 0, input: 0, ms: 0 }
    row.calls += 1
    if (!entry.ok) row.failed += 1
    row.input += Number(entry.usage?.input_tokens ?? 0)
    row.ms += Number(entry.ms ?? 0)
    byPurpose.set(entry.purpose, row)
  }
  console.log(`Jev 호출 (${calls[0]?.at?.slice(0, 10) ?? '?'} ~ ${calls.at(-1)?.at?.slice(0, 10) ?? '?'})`)
  console.log('| 쓰임새 | 호출 | 실패 | 입력 토큰 | 추정 비용 | 평균 응답 |')
  console.log('|---|---|---|---|---|---|')
  for (const [purpose, row] of byPurpose) console.log(`| ${purpose} | ${row.calls} | ${row.failed} | ${row.input} | $${(row.input * INPUT_USD_PER_TOKEN).toFixed(4)} | ${Math.round(row.ms / row.calls)}ms |`)
  const discarded = entries.filter((entry) => entry.purpose === 'learn-dedupe-discard')
  if (discarded.length) console.log(`\n학습 후보 자동 버림 ${discarded.length}건 — 되살리려면 .board-trash/<날짜>/issues/ 에서 issues/ 로 옮긴다`)
  // 배우기 검토 나란히 판정 — Jev 점수와 Claude 검토자가 실제로 낸 후보 수. 점수가 낮은데 후보가 나온 줄이 "놓칠 뻔한 것"
  const outcomes = entries.filter((entry) => entry.purpose === 'learn-review-outcome')
  if (outcomes.length) {
    console.log('\n배우기 검토 나란히 판정 (Jev 는 건너뛰지 않았다 — 기록만)')
    console.log('| 날짜 | 계획서 | Jev 점수 | 검토자 후보 | 이슈로 씀 |')
    console.log('|---|---|---|---|---|')
    for (const entry of outcomes) console.log(`| ${entry.at.slice(0, 10)} | ${entry.plan} | ${entry.jev ?? '실패'} | ${entry.items} | ${entry.written} |`)
    console.log('\n후보가 나왔는데(이슈로 씀 ≥1) Jev 점수가 낮았던 줄이 거름망이 놓쳤을 작업이다. 기준선은 그 줄들보다 낮게 잡는다')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--report')) report()
