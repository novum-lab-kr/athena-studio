#!/usr/bin/env bash
# 측정 요약 시험 — 정해 둔 사건 기록으로 scripts/lib/metrics.mjs 의 숫자를 본다(파일 · 본체를 건드리지 않는다 · 몇 초)
#
# 사용: test/metrics-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#
# 보는 것(docs/events.md): 개입 수(열린 채 고친 것은 안 셈) · 답 대기 · 걸린 시간(처음 본 때 → done) · 시작을 모르면 빼기 ·
# done 뒤 다시 열리면 안 끝난 것 · 검증을 레포 · 브랜치로 계획서에 잇기 · 리뷰 반려 · 기간 · 지난 기간 비교
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
node --input-type=module - <<'EOF'
import { summarize, groupByPlan, formatDuration } from './scripts/lib/metrics.mjs'
const H = 3_600_000
const NOW = Date.parse('2026-10-25T12:00:00Z')
const at = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString()
const A = 'plans/task/a.md', B = 'plans/task/b.md', C = 'plans/task/c.md'
const events = [
  // a — 이번 주에 시작해 끝남: 질문 2번(하나는 열린 채 고침) · 답 대기 1시간 + 3시간 · 막힘 1번 · 검증 2번 중 1번 실패 · 리뷰 반려 1번 · 커밋 1번
  { at: at(30), type: 'plan.status', plan: A, from: null, to: 'planned' },
  { at: at(29), type: 'plan.status', plan: A, from: 'planned', to: 'in_progress' },
  { at: at(28), type: 'request', id: 'r1', state: 'open', plan: A },
  { at: at(27.5), type: 'request', id: 'r1', state: 'open', plan: A },
  { at: at(27), type: 'request', id: 'r1', state: 'answered', by: 'app' },
  { at: at(26.5), type: 'request', id: 'r1', state: 'delivered' },
  { at: at(26), type: 'plan.status', plan: A, from: 'in_progress', to: 'blocked' },
  { at: at(25), type: 'request', id: 'r2', state: 'open', plan: A },
  { at: at(22), type: 'request', id: 'r2', state: 'delivered', by: 'chat' },
  { at: at(21), type: 'verify', repo: 'web', branch: 'feat/a', ok: false },
  { at: at(20), type: 'verify', repo: 'web', branch: 'feat/a', ok: true },
  { at: at(19), type: 'review', plan: A, repo: 'web', branch: 'feat/a', verdict: '수정 필요' },
  { at: at(18), type: 'review', plan: A, repo: 'web', branch: 'feat/a', verdict: '승인' },
  { at: at(17), type: 'commit', plan: A, repo: 'web', branch: 'feat/a' },
  { at: at(10), type: 'plan.status', plan: A, from: 'ready_for_review', to: 'done' },
  // b — 시작은 기록 전(처음 본 때 모름) · 이번 주에 done → 끝낸 작업에는 세고 걸린 시간에서는 뺀다
  { at: at(5), type: 'plan.status', plan: B, from: 'in_progress', to: 'done' },
  // c — 지난주에 끝났다가 이번 주에 다시 열림 → 안 끝난 것
  { at: at(200), type: 'plan.status', plan: C, from: null, to: 'in_progress' },
  { at: at(190), type: 'plan.status', plan: C, from: 'in_progress', to: 'done' },
  { at: at(2), type: 'plan.status', plan: C, from: 'done', to: 'in_progress' },
  // 계획서 없는 질문 · 모르는 브랜치의 검증 — 계획서에는 안 붙지만 기간 숫자에는 든다
  { at: at(3), type: 'request', id: 'r3', state: 'open' },
  { at: at(1), type: 'verify', repo: 'web', branch: 'other', ok: false },
  { at: 'not a date', type: 'commit', plan: A },
  // c 에 아직 답이 안 온 질문 둘 — 기다리는 중 2 · 가장 오래된 것부터
  { at: at(4), type: 'request', id: 'r4', state: 'open', plan: C },
  { at: at(1.5), type: 'request', id: 'r5', state: 'open', plan: C },
]
let pass = 0, fail = 0
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✔ ${name}`) } else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ''}`) } }

console.log('\n계획서별')
const plans = Object.fromEntries(groupByPlan(events).map((plan) => [plan.plan, plan]))
const a = plans[A]
check('개입 2번(열린 채 고친 것은 안 셈)', a.asks === 2, JSON.stringify(a))
check('답 대기 1시간 + 3시간', a.waitMs === 4 * H && a.answered === 2, String(a.waitMs / H))
check('걸린 시간 = 처음 본 때 → done (20시간)', a.leadMs === 20 * H, String(a.leadMs / H))
check('막힘 1 · 검증 1/2 실패(레포 · 브랜치로 이음) · 리뷰 반려 1/2 · 커밋 1(시각 없는 줄은 버림)', a.blocked === 1 && a.verify.fails === 1 && a.verify.runs === 2 && a.reviews.rejects === 1 && a.reviews.runs === 2 && a.commits === 1, JSON.stringify(a))
check('시작을 모르면 걸린 시간 없음', plans[B].leadMs === null && plans[B].doneAt !== null)
check('답이 온 요청은 기다리는 중이 아님', a.waiting === 0 && a.waitingSince === null)
check('done 뒤 다시 열리면 안 끝난 것', plans[C].status === 'in_progress' && plans[C].doneAt === null && plans[C].leadMs === null)
check('지금 기다리는 요청 2 · 가장 오래된 open 시각', plans[C].waiting === 2 && plans[C].waitingSince === Date.parse(at(4)), JSON.stringify(plans[C]))

console.log('\n기간(최근 7일)')
const week = summarize(events, { now: NOW, days: 7 })
check('사건 수 — 시각 없는 줄은 뺀다', week.events === events.length - 1, String(week.events))
check('끝낸 작업 2(a · b) · 걸린 시간은 아는 1개로 20시간', week.current.done === 2 && week.current.leadKnown === 1 && week.current.leadMs === 20 * H, JSON.stringify(week.current))
check('작업당 개입 1(a 2 · b 0)', week.current.asksPerDone === 1)
check('기간 안의 질문 5번(계획서 없는 것 · 아직 답 없는 것 포함) · 평균 답 대기 2시간', week.current.asks === 5 && week.current.waitMs === 2 * H, JSON.stringify(week.current))
check('검증 실패율 2/3 · 리뷰 반려율 1/2', Math.abs(week.current.verifyFailRate - 2 / 3) < 1e-9 && week.current.reviewRejectRate === 0.5)
check('지난 기간 — c 는 다시 열려 끝낸 작업 0', week.previous.done === 0 && week.previous.verifyFailRate === null)
check('표에는 이번 기간에 움직인 계획서만(최근 것부터)', week.plans.map((plan) => plan.plan).join() === [C, B, A].join(), week.plans.map((plan) => plan.plan).join())

console.log('\n전체 · 빈 기록 · 글자')
const all = summarize(events, { now: NOW })
check('전체 — 지난 기간 비교 없음 · 계획서 3개', all.previous === null && all.plans.length === 3)
const empty = summarize([], { now: NOW, days: 7 })
check('빈 기록 — 0 과 빈 값', empty.events === 0 && empty.since === null && empty.current.done === 0 && empty.current.leadMs === null && empty.plans.length === 0)
check('시간 글자', formatDuration(null) === '—' && formatDuration(20 * 60_000) === '20분' && formatDuration(20 * H) === '20.0시간' && formatDuration(72 * H) === '3.0일')

console.log(`\n통과 ${pass} · 실패 ${fail}`)
process.exit(fail ? 1 : 0)
EOF
