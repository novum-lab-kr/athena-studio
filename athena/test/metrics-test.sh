#!/usr/bin/env bash
# 측정 요약 시험 — 정해 둔 사건 기록으로 scripts/lib/metrics.mjs 의 숫자를 본다(파일 · 본체를 건드리지 않는다 · 몇 초)
#
# 사용: test/metrics-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#
# 보는 것(docs/events.md): 개입 수(열린 채 고친 것은 안 셈) · 답 대기 · 걸린 시간(처음 본 때 → done) · 시작을 모르면 빼기 ·
# done 뒤 다시 열리면 안 끝난 것 · 검증을 레포 · 브랜치로 계획서에 잇기 · 리뷰 반려 · 기간 · 지난 기간 비교 ·
# 구간별 시간(작업 · 검증 · 리뷰 · 머지 대기 — 옛 기록은 null) · 리뷰 라운드 · 정확도(머지당 수정 · 되돌림은 기록 없음) ·
# 리뷰 구간은 PR 올림(pr.open)부터(없는 옛 기록은 첫 리뷰 결론부터)
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
node --input-type=module - <<'EOF'
import { summarize, groupByPlan, formatDuration, STAGES } from './scripts/lib/metrics.mjs'
const H = 3_600_000
const NOW = Date.parse('2026-10-25T12:00:00Z')
const at = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString()
const A = 'plans/task/a.md', B = 'plans/task/b.md', C = 'plans/task/c.md', D = 'plans/task/d.md', E = 'plans/task/e.md'
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
  // d — 새 기록: ready_for_review 로 작업 구간 · plan 칸 든 verify 의 ms 합이 검증 구간 · 자동 리뷰 2라운드 · 수정 1 · 머지 1
  //   작업 = 처음 본 때(16h) → ready(12h) = 4시간 · 검증 = 1500 + 2500 ms · 리뷰 = 첫 리뷰(11h) → 마지막(9h) = 2시간 · 머지 대기 = 9h → 8h = 1시간
  { at: at(16), type: 'plan.status', plan: D, from: null, to: 'in_progress' },
  { at: at(15), type: 'verify', repo: 'web', branch: 'feat/d', ok: true, plan: D, ms: 1500, scope: 'scoped' },
  { at: at(14), type: 'verify', repo: 'web', branch: 'feat/d', ok: true, plan: D, ms: '2500', scope: 'full' },
  { at: at(13), type: 'verify', repo: 'web', branch: 'feat/d', ok: true, plan: D, scope: 'full' },   // 소요를 모르는 줄은 합에서 뺀다
  { at: at(12), type: 'plan.status', plan: D, from: 'in_progress', to: 'ready_for_review' },
  { at: at(11), type: 'review', plan: D, repo: 'web', branch: 'feat/d', verdict: '수정 필요', by: 'auto', pr: 7 },
  { at: at(10.5), type: 'auto.fix', plan: D, repo: 'web', branch: 'feat/d', pr: 7 },
  { at: at(9), type: 'review', plan: D, repo: 'web', branch: 'feat/d', verdict: '승인', by: 'auto', pr: 7 },
  { at: at(8), type: 'auto.merge', plan: D, repo: 'web', pr: 7, ok: true },
  { at: at(7), type: 'plan.status', plan: D, from: 'ready_for_review', to: 'done' },
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
  // e — 두 기간 밖(옛날)의 ⚡ 빠른 길: PR 올림(pr.open) 1시간 뒤 리뷰 한 번(수정 필요) → 고친 HEAD 는 리뷰 없이 이어받아 머지. 리뷰 구간은 pr.open 부터
  { at: at(400), type: 'plan.status', plan: E, from: null, to: 'in_progress' },
  { at: at(396), type: 'plan.status', plan: E, from: 'in_progress', to: 'ready_for_review' },
  { at: at(395), type: 'pr.open', plan: E, repo: 'web', pr: '9', sha: 'e000001', fast: true },
  { at: at(394), type: 'review', plan: E, repo: 'web', branch: 'feat/e', verdict: '수정 필요', by: 'auto', pr: '9', fast: true },
  { at: at(393.5), type: 'auto.fix', plan: E, repo: 'web', branch: 'feat/e', pr: '9', fast: true },
  { at: at(393), type: 'auto.takeover', plan: E, repo: 'web', branch: 'feat/e', pr: '9', fast: true },
  { at: at(392), type: 'auto.merge', plan: E, repo: 'web', pr: '9', ok: true, fast: true },
  { at: at(391), type: 'plan.status', plan: E, from: 'ready_for_review', to: 'done' },
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

console.log('\n구간별 시간 · 리뷰 라운드 · 정확도')
const d = plans[D]
check('작업 4시간 · 검증 4초(plan · ms 든 verify 만 합) · 리뷰 2시간 · 머지 대기 1시간', d.stages.work === 4 * H && d.stages.verify === 4000 && d.stages.review === 2 * H && d.stages.mergeWait === 1 * H, JSON.stringify(d.stages))
check('plan 칸 든 verify 는 레포 · 브랜치의 커밋 없이도 계획서에 붙는다(3번)', d.verify.runs === 3 && d.verify.fails === 0, JSON.stringify(d.verify))
check('자동 리뷰 라운드 2 · 머지당 수정 1/1', d.reviewRounds === 2 && d.autoFixes === 1 && d.autoMerges === 1 && d.fixRate === 1, JSON.stringify(d))
check('되돌림은 기록 없음(null)', d.reverts === null)
check('옛 기록(ready · 자동 리뷰 · ms 없음) — 작업 · 검증 null · 리뷰는 첫 → 마지막 리뷰 1시간 · 머지 대기는 머지가 없어 마지막 리뷰 → done 8시간 · 라운드 0', a.stages.work === null && a.stages.verify === null && a.stages.review === 1 * H && a.stages.mergeWait === 8 * H && a.reviewRounds === 0 && a.fixRate === null, JSON.stringify(a.stages))
check('구간 순서', STAGES.join() === 'work,verify,review,mergeWait')
const e = plans[E]
check('빠른 길(pr.open 있음) — 리뷰 구간은 PR 올림 → 마지막 리뷰 결론 1시간(리뷰 1번이어도 0 이 아니다) · 머지 대기 2시간 · 라운드 1 · 머지당 수정 1', e.stages.review === 1 * H && e.stages.mergeWait === 2 * H && e.reviewRounds === 1 && e.autoFixes === 1 && e.autoMerges === 1, JSON.stringify(e.stages))

console.log('\n기간(최근 7일)')
const week = summarize(events, { now: NOW, days: 7 })
check('사건 수 — 시각 없는 줄은 뺀다', week.events === events.length - 1, String(week.events))
check('끝낸 작업 3(a · b · d) · 걸린 시간은 아는 2개로 평균 (20 + 9) / 2 시간', week.current.done === 3 && week.current.leadKnown === 2 && week.current.leadMs === 14.5 * H, JSON.stringify(week.current))
check('작업당 개입 2/3(a 2 · b 0 · d 0)', Math.abs(week.current.asksPerDone - 2 / 3) < 1e-9)
check('구간 평균은 아는 것만 — 작업 4시간(d 1개) · 검증 4초(d) · 리뷰 1.5시간(a · d) · 머지 대기 4.5시간(a 8 · d 1)', week.current.stageMs.work === 4 * H && week.current.stageKnown.work === 1 && week.current.stageMs.verify === 4000 && week.current.stageKnown.verify === 1 && week.current.stageMs.review === 1.5 * H && week.current.stageKnown.review === 2 && week.current.stageMs.mergeWait === 4.5 * H && week.current.stageKnown.mergeWait === 2, JSON.stringify(week.current.stageMs))
check('리뷰 라운드 평균 2(자동 리뷰가 있는 d 만) · 머지당 수정 1 · 되돌림 null', week.current.reviewRounds === 2 && week.current.reviewRoundsKnown === 1 && week.current.fixRate === 1 && week.current.autoFixes === 1 && week.current.autoMerges === 1 && week.current.reverts === null, JSON.stringify(week.current))
check('기간 안의 질문 5번(계획서 없는 것 · 아직 답 없는 것 포함) · 평균 답 대기 2시간', week.current.asks === 5 && week.current.waitMs === 2 * H, JSON.stringify(week.current))
check('검증 실패율 2/6 · 리뷰 반려율 2/4', Math.abs(week.current.verifyFailRate - 2 / 6) < 1e-9 && week.current.reviewRejectRate === 0.5)
check('지난 기간 — c 는 다시 열려 끝낸 작업 0 · 구간 평균 없음', week.previous.done === 0 && week.previous.verifyFailRate === null && week.previous.stageMs.work === null && week.previous.reviewRounds === null)
check('표에는 이번 기간에 움직인 계획서만(최근 것부터)', week.plans.map((plan) => plan.plan).join() === [C, B, D, A].join(), week.plans.map((plan) => plan.plan).join())

console.log('\n전체 · 빈 기록 · 글자')
const all = summarize(events, { now: NOW })
check('전체 — 지난 기간 비교 없음 · 계획서 5개', all.previous === null && all.plans.length === 5)
const empty = summarize([], { now: NOW, days: 7 })
check('빈 기록 — 0 과 빈 값', empty.events === 0 && empty.since === null && empty.current.done === 0 && empty.current.leadMs === null && empty.current.stageMs.verify === null && empty.current.fixRate === null && empty.plans.length === 0)
check('시간 글자', formatDuration(null) === '—' && formatDuration(4000) === '4초' && formatDuration(20 * 60_000) === '20분' && formatDuration(20 * H) === '20.0시간' && formatDuration(72 * H) === '3.0일')

console.log(`\n통과 ${pass} · 실패 ${fail}`)
process.exit(fail ? 1 : 0)
EOF
