#!/usr/bin/env bash
# 측정 요약 시험 — 정해 둔 사건 기록으로 scripts/lib/metrics.mjs 의 숫자를 본다(파일 · 본체를 건드리지 않는다 · 몇 초)
#
# 사용: test/metrics-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#
# 보는 것(docs/events.md): 개입 수(열린 채 고친 것은 안 셈) · 답 대기 · 소요(처음 본 때 → 첫 머지 · 없으면 done) · 시작을 모르면 빼기 ·
# done 뒤 다시 열리면 안 끝난 것 · 검증을 레포 · 브랜치로 계획서에 잇기 · 리뷰 반려 · 기간 · 시작 날짜 · 리뷰 있음/없음 · 지난 기간 비교 ·
# 구간 나누기(겹침 없음 · 합 = 소요 · 모르면 null) · 평균 · 중앙값 · p75 · 리뷰 라운드 · 정확도 · 세션 기록으로 작업 안쪽 나누기
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
node --input-type=module - <<'EOF'
import { summarize, groupByPlan, formatDuration, parseSinceDate, partition, spread, STAGES } from './scripts/lib/metrics.mjs'
import { createSessionReader, scanSessions, toolKind, workTotals } from './scripts/lib/session-work.mjs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  // d — 16h 시작 → 8h 첫 머지 → 7h done. 검증 5초 · 작업 끝 12h(ready) · 리뷰 12h→11h · 10h→9h(자동 2라운드) · 머지 대기는 12h→8h 에서 리뷰를 뺀 2시간
  { at: at(16), type: 'plan.status', plan: D, from: null, to: 'in_progress' },
  { at: at(15), type: 'verify', repo: 'web', branch: 'feat/d', ok: true, plan: D, ms: 1500, scope: 'scoped' },
  { at: at(14), type: 'verify', repo: 'web', branch: 'feat/d', ok: true, plan: D, ms: '2500', scope: 'full' },
  { at: at(13), type: 'verify', repo: 'web', branch: 'feat/d', ok: true, plan: D, ms: 1000, scope: 'full' },
  { at: at(12), type: 'plan.status', plan: D, from: 'in_progress', to: 'ready_for_review' },
  { at: at(12), type: 'pr.open', plan: D, repo: 'web', pr: '7' },
  { at: at(11), type: 'review', plan: D, repo: 'web', branch: 'feat/d', verdict: '수정 필요', by: 'auto', pr: 7 },
  { at: at(10.5), type: 'auto.fix', plan: D, repo: 'web', branch: 'feat/d', pr: 7 },
  { at: at(10), type: 'auto.push', plan: D, repo: 'web', pr: 7 },
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
  // e — 두 기간 밖(옛날)의 ⚡ 빠른 길: PR 올림(pr.open) 1시간 뒤 리뷰 한 번(수정 필요) → 고친 HEAD 는 상한 뒤 이어받아 머지(짧은 리뷰 전의 옛 기록이라 그 HEAD 의 review 사건은 없다). 리뷰 구간은 pr.open 부터
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
check('머지 없으면 소요 = 처음 본 때 → done (20시간)', a.leadMs === 20 * H, String(a.leadMs / H))
check('머지 있으면 소요 = 처음 본 때 → 첫 머지(8시간) · 머지 → 완료 표시 1시간은 따로', plans[D].leadMs === 8 * H && plans[D].mergeToDoneMs === 1 * H, String(plans[D].leadMs / H))
check('막힘 1 · 검증 1/2 실패(레포 · 브랜치로 이음) · 리뷰 반려 1/2 · 커밋 1(시각 없는 줄은 버림)', a.blocked === 1 && a.verify.fails === 1 && a.verify.runs === 2 && a.reviews.rejects === 1 && a.reviews.runs === 2 && a.commits === 1, JSON.stringify(a))
check('시작을 모르면 걸린 시간 없음', plans[B].leadMs === null && plans[B].doneAt !== null)
check('답이 온 요청은 기다리는 중이 아님', a.waiting === 0 && a.waitingSince === null)
check('done 뒤 다시 열리면 안 끝난 것', plans[C].status === 'in_progress' && plans[C].doneAt === null && plans[C].leadMs === null)
check('지금 기다리는 요청 2 · 가장 오래된 open 시각', plans[C].waiting === 2 && plans[C].waitingSince === Date.parse(at(4)), JSON.stringify(plans[C]))

console.log('\n구간별 시간 · 리뷰 라운드 · 정확도')
const d = plans[D]
check('작업 4시간-5초 · 검증 5초 · 리뷰 2시간 · 머지 대기 2시간 · 답 대기 없음 — 합 = 소요', d.stages.work === 4 * H - 5000 && d.stages.verify === 5000 && d.stages.review === 2 * H && d.stages.mergeWait === 2 * H && d.stages.wait === 0 && !d.stageHad.wait && STAGES.reduce((sum, stage) => sum + d.stages[stage], 0) === d.leadMs, JSON.stringify(d.stages))
check('plan 칸 든 verify 는 레포 · 브랜치의 커밋 없이도 계획서에 붙는다(3번)', d.verify.runs === 3 && d.verify.fails === 0, JSON.stringify(d.verify))
check('자동 리뷰 라운드 2 · 머지당 수정 1/1', d.reviewRounds === 2 && d.autoFixes === 1 && d.autoMerges === 1 && d.fixRate === 1, JSON.stringify(d))
check('되돌림은 기록 없음(null)', d.reverts === null)
check('옛 기록(ms 없는 검증 · 시작 모르는 수동 리뷰) — 작업 · 검증 · 리뷰는 0 이 아니라 null · 머지 없어 머지 대기도 null · 답 대기 4시간', a.stages.work === null && a.stages.verify === null && a.stages.review === null && a.stages.mergeWait === null && !a.stageHad.mergeWait && a.stages.wait === 4 * H && a.reviewRounds === 0 && a.fixRate === null, JSON.stringify(a.stages))
check('구간 순서', STAGES.join() === 'work,verify,wait,review,mergeWait')
const e = plans[E]
check('빠른 길(pr.open 있음) — 리뷰 구간은 PR 올림 → 결론 1시간 · 머지 대기 3시간(작업 끝 396h → 머지 392h 에서 리뷰 뺌) · 라운드 1 · 머지당 수정 1', e.stages.review === 1 * H && e.stages.mergeWait === 3 * H && e.reviewRounds === 1 && e.autoFixes === 1 && e.autoMerges === 1, JSON.stringify(e.stages))

// f — 짧은 리뷰가 생긴 뒤의 상한 뒤 이어받음: 상한 라운드(수정 필요) → 고친 HEAD 의 짧은 리뷰(review short:true · 승인)도 자동 리뷰 한 번으로 센다. 위 기간 숫자에 섞지 않게 따로
const F = 'plans/task/f.md'
const shortEvents = [
  { at: at(50), type: 'plan.status', plan: F, from: null, to: 'in_progress' },
  { at: at(48), type: 'pr.open', plan: F, repo: 'web', pr: '11', sha: 'f000001' },
  { at: at(47), type: 'review', plan: F, repo: 'web', branch: 'feat/f', verdict: '수정 필요', by: 'auto', pr: '11' },
  { at: at(46), type: 'auto.fix', plan: F, repo: 'web', branch: 'feat/f', pr: '11' },
  { at: at(45), type: 'review', plan: F, repo: 'web', branch: 'feat/f', verdict: '승인', by: 'auto', pr: '11', short: true },
  { at: at(45), type: 'auto.takeover', plan: F, repo: 'web', branch: 'feat/f', pr: '11', review: '승인' },
  { at: at(44), type: 'auto.merge', plan: F, repo: 'web', pr: '11', ok: true },
]
const f = Object.fromEntries(groupByPlan(shortEvents).map((plan) => [plan.plan, plan]))[F]
check('짧은 리뷰(review short:true)도 자동 리뷰 라운드 · 리뷰 횟수로 센다 — 라운드 2 · 리뷰 2 중 반려 1 · 머지 1', f.reviewRounds === 2 && f.reviews.runs === 2 && f.reviews.rejects === 1 && f.autoMerges === 1, JSON.stringify({ rounds: f.reviewRounds, reviews: f.reviews, merges: f.autoMerges }))

console.log('\n기간(최근 7일)')
const week = summarize(events, { now: NOW, days: 7 })
check('사건 수 — 시각 없는 줄은 뺀다', week.events === events.length - 1, String(week.events))
check('끝낸 작업 3(a · b · d) — 머지 1 · done 기준 2 · 시작 없어 빠짐 1 · 소요 평균 (20 + 8) / 2 시간', week.current.done === 3 && week.current.merged === 1 && week.current.doneOnly === 2 && week.current.noStart === 1 && week.current.lead.count === 2 && week.current.lead.avgMs === 14 * H, JSON.stringify(week.current))
check('작업당 개입 2/3(a 2 · b 0 · d 0)', Math.abs(week.current.asksPerDone - 2 / 3) < 1e-9)
check('구간은 있었던 건만 · 시간 아는 것 따로 — 리뷰 3건 중 2건(시간은 d 1건) · 답 대기 1건 4시간 · 머지 대기 1건', week.current.stages.review.had === 2 && week.current.stages.review.count === 1 && week.current.stages.review.p50Ms === 2 * H && week.current.stages.wait.had === 1 && week.current.stages.wait.avgMs === 4 * H && week.current.stages.mergeWait.had === 1, JSON.stringify(week.current.stages))
check('리뷰 라운드 평균 2(자동 리뷰가 있는 d 만) · 머지당 수정 1 · 되돌림 null', week.current.reviewRounds === 2 && week.current.reviewRoundsKnown === 1 && week.current.fixRate === 1 && week.current.autoFixes === 1 && week.current.autoMerges === 1 && week.current.reverts === null, JSON.stringify(week.current))
check('기간 안의 질문 5번(계획서 없는 것 · 아직 답 없는 것 포함) · 평균 답 대기 2시간', week.current.asks === 5 && week.current.waitMs === 2 * H, JSON.stringify(week.current))
check('검증 실패율 2/6 · 리뷰 반려율 2/4', Math.abs(week.current.verifyFailRate - 2 / 6) < 1e-9 && week.current.reviewRejectRate === 0.5)
check('지난 기간 — c 는 다시 열려 끝낸 작업 0 · 구간 값 없음', week.previous.done === 0 && week.previous.verifyFailRate === null && week.previous.stages.work.p50Ms === null && week.previous.reviewRounds === null)
check('표에는 이번 기간에 움직인 계획서만(최근 것부터)', week.plans.map((plan) => plan.plan).join() === [C, B, D, A].join(), week.plans.map((plan) => plan.plan).join())

console.log('\n전체 · 빈 기록 · 글자')
const all = summarize(events, { now: NOW })
check('전체 — 지난 기간 비교 없음 · 계획서 5개', all.previous === null && all.plans.length === 5)
const empty = summarize([], { now: NOW, days: 7 })
check('빈 기록 — 0 과 빈 값', empty.events === 0 && empty.since === null && empty.current.done === 0 && empty.current.lead.avgMs === null && empty.current.stages.verify.p50Ms === null && empty.current.fixRate === null && empty.plans.length === 0)
check('시간 글자', formatDuration(null) === '—' && formatDuration(4000) === '4초' && formatDuration(20 * 60_000) === '20분' && formatDuration(20 * H) === '20.0시간' && formatDuration(72 * H) === '3.0일')

console.log('\n구간 나누기')
const pieces = partition([{ label: 'low', from: 0, to: 10 }, { label: 'high', from: 2, to: 4 }, { label: 'high', from: 3, to: 5 }], ['high', 'low'])
check('겹치면 앞쪽 칸이 가져가고 한 순간은 한 칸에만', JSON.stringify(pieces) === JSON.stringify([{ label: 'low', from: 0, to: 2 }, { label: 'high', from: 2, to: 5 }, { label: 'low', from: 5, to: 10 }]), JSON.stringify(pieces))
const P = 'plans/task/p.md', Q = 'plans/task/q.md', R = 'plans/task/r.md', S = 'plans/task/s.md'
const more = Object.fromEntries(groupByPlan([
  // p — 리뷰 없는 머지 · 머지 확인 요청이 머지 대기와 겹침 · 검증이 답 대기와 겹침
  { at: at(10), type: 'plan.status', plan: P, from: null, to: 'in_progress' },
  { at: at(8), type: 'request', id: 'p1', state: 'open', plan: P },
  { at: at(7), type: 'verify', plan: P, ok: true, ms: 0.5 * H, wait_ms: 0.5 * H },
  { at: at(6), type: 'request', id: 'p1', state: 'delivered' },
  { at: at(5), type: 'commit', plan: P },
  { at: at(4.5), type: 'request', id: 'p2', state: 'open', plan: P },
  { at: at(4), type: 'auto.merge', plan: P, ok: true },
  { at: at(3), type: 'request', id: 'p2', state: 'answered' },
  { at: at(1), type: 'commit', plan: P },   // 머지 뒤 이어 한 일
  // q — 수동 리뷰: 결론 없이 끝난 reviewer 뒤 새 reviewer → 결론 직전 것으로 잇는다 · ms 칸이 있으면 그걸로
  { at: at(10), type: 'plan.status', plan: Q, from: null, to: 'in_progress' },
  { at: at(9), type: 'delegate', agent: 'reviewer', plan: Q },
  { at: at(8), type: 'delegate', agent: 'reviewer', plan: Q },
  { at: at(7.5), type: 'review', plan: Q, verdict: '수정 필요' },
  { at: at(7), type: 'commit', plan: Q },
  { at: at(6), type: 'review', plan: Q, verdict: '승인', by: 'auto', ms: 0.25 * H },
  { at: at(5), type: 'auto.merge', plan: Q, ok: true },
  // r — 작업 끝 뒤의 검증 소요를 모르면 머지 대기도 모름 · 앞쪽만 모르면 머지 대기는 안다
  { at: at(10), type: 'plan.status', plan: R, from: null, to: 'in_progress' },
  { at: at(9), type: 'commit', plan: R },
  { at: at(8), type: 'verify', plan: R, ok: true },
  { at: at(7), type: 'auto.merge', plan: R, ok: true },
  { at: at(10), type: 'plan.status', plan: S, from: null, to: 'in_progress' },
  { at: at(9), type: 'verify', plan: S, ok: true },
  { at: at(8), type: 'commit', plan: S },
  { at: at(7), type: 'auto.merge', plan: S, ok: true },
]).map((plan) => [plan.plan, plan]))
const noReview = more[P]
check('리뷰 없는 머지도 머지 대기를 잰다(5h → 4h) · 요청과 겹치면 머지 대기 · 검증(줄서기 포함 1시간)과 겹친 답 대기는 1시간만', noReview.stages.mergeWait === 1 * H && noReview.stages.verify === 1 * H && noReview.stages.wait === 1 * H && noReview.stages.review === 0 && !noReview.stageHad.review && !noReview.reviewed, JSON.stringify(noReview.stages))
check('구간 합 = 소요(겹침 이중 계산 없음)', STAGES.reduce((sum, stage) => sum + noReview.stages[stage], 0) === noReview.leadMs && noReview.leadMs === 6 * H, JSON.stringify(noReview.stages))
check('첫 머지 뒤 커밋 표시 · waitMs 는 예전처럼 요청 시간 합(2 + 1.5시간)', noReview.followUp === true && noReview.waitMs === 3.5 * H)
const manual = more[Q]
check('수동 리뷰는 결론 직전 reviewer 부터(8h → 7.5h) · ms 칸 0.25시간 — 합 0.75시간 · reviewed', manual.stages.review === 0.75 * H && manual.reviewed === true, JSON.stringify(manual.stages))
check('머지 대기 안쪽 검증 소요 모름 → 머지 대기 · 작업 · 검증 null', more[R].stages.mergeWait === null && more[R].stages.work === null && more[R].stages.verify === null, JSON.stringify(more[R].stages))
check('작업 중 검증 소요만 모름 → 머지 대기는 안다', more[S].stages.mergeWait === 1 * H && more[S].stages.verify === null && more[S].stages.work === null, JSON.stringify(more[S].stages))

console.log('\n분포 · 시작 날짜 · 리뷰 있음/없음')
const shape = spread([4, 1, 3, 2])
check('평균 2.5 · 중앙값 2.5 · p75 3.25 · 건수 4', shape.avgMs === 2.5 && shape.p50Ms === 2.5 && shape.p75Ms === 3.25 && shape.count === 4, JSON.stringify(shape))
check('빈 분포는 모름(null)', spread([]).p50Ms === null && spread([]).avgMs === null)
check('시작 날짜 — 형식이 틀리거나 없는 날짜는 null', parseSinceDate('2026-11-01') === new Date(2026, 10, 1).getTime() && parseSinceDate('2026-02-31') === null && parseSinceDate('어제') === null && parseSinceDate(null) === null)
const fromDay = summarize(events, { now: NOW, since: NOW - 9 * H })
check('since — 그때부터 · 끝낸 작업 d(8h) · b · 지난 기간은 같은 길이 · days 빈 값', fromDay.current.done === 2 && fromDay.days === null && fromDay.previous.done === 1 && fromDay.from === new Date(NOW - 9 * H).toISOString(), JSON.stringify(fromDay.current.done))
const withReview = summarize(events, { now: NOW, days: 7, review: 'with' })
const withoutReview = summarize(events, { now: NOW, days: 7, review: 'without' })
check('리뷰 있음 — a · d · 없음 — b(건수 합이 전체) · 비율도 그 계획서 사건만', withReview.current.done === 2 && withoutReview.current.done === 1 && withReview.current.reviewRuns === 4 && withoutReview.current.reviewRuns === 0 && withReview.current.verifyRuns === 5, JSON.stringify(withReview.current.verifyRuns))

console.log('\nPR 생성 → 성공 머지 · 평균 카드의 집계 근거')
const prPlan = 'plans/task/pr-reviewed.md', plainPrPlan = 'plans/task/pr-plain.md'
const prEvent = (hoursAgo, type, repo, pr, plan = prPlan, extra = {}) => ({ at: at(hoursAgo), type, repo, pr, plan, ...extra })
const prEvents = [
  { at: at(100), type: 'plan.status', plan: prPlan, from: null, to: 'in_progress' },
  { at: at(400), type: 'plan.status', plan: plainPrPlan, from: null, to: 'in_progress' },
  { at: at(15), type: 'review', plan: prPlan, ms: H, verdict: '승인' },
  prEvent(60, 'pr.open', 'web', 1), prEvent(50, 'pr.open', 'web', '1'),
  prEvent(10, 'auto.merge', 'web', '1', prPlan, { ok: true }),
  prEvent(9, 'auto.merge', 'web', 1, prPlan, { ok: true }),
  prEvent(40, 'pr.open', 'web', 2), prEvent(8, 'auto.merge', 'web', 2, prPlan, { ok: true }),
  prEvent(30, 'pr.open', 'api', 1, plainPrPlan), prEvent(7, 'auto.merge', 'api', 1, plainPrPlan, { ok: true }),
  prEvent(6, 'auto.merge', 'web', 3, prPlan, { ok: true }),
  prEvent(5, 'pr.open', 'web', 4), prEvent(6.5, 'auto.merge', 'web', 4, prPlan, { ok: true }),
  prEvent(4, 'pr.open', 'web', 5), prEvent(3, 'auto.merge', 'web', 5, prPlan, { ok: false }),
  prEvent(3, 'pr.open', 'web', 6), prEvent(0, 'auto.merge', 'web', 6, prPlan, { ok: true }),
  prEvent(200, 'pr.open', 'web', 7, plainPrPlan), prEvent(168, 'auto.merge', 'web', 7, plainPrPlan, { ok: true }),
  prEvent(370, 'pr.open', 'web', 8, plainPrPlan), prEvent(200, 'auto.merge', 'web', 8, plainPrPlan, { ok: true }),
  prEvent(20, 'pr.open', 'web', 10), prEvent(1, 'auto.merge', 'web', 10, prPlan, { ok: true, mergedAt: at(12) }),
  prEvent(2, 'pr.open', 'web', 11), prEvent(2, 'auto.merge', 'web', 11, prPlan, { ok: true }),
  prEvent(1, 'auto.merge', '', '', prPlan, { ok: true }),
]
const prWeek = summarize(prEvents.toReversed(), { now: NOW, days: 7 })
check('PR은 repo+번호로 연결 · 복수 PR 각각 · 숫자/문자 번호와 중복 생성/머지는 한 번 · 기간 밖 생성 포함', prWeek.current.pr.count === 6 && prWeek.current.pr.had === 8 && prWeek.current.pr.avgMs === 145 / 6 * H, JSON.stringify(prWeek.current.pr))
check('PR 생성 누락·역전은 0 아닌 제외 · 실패 머지는 완료 아님 · PR 없는 직접 머지는 제외', prWeek.current.pr.missingOpen === 1 && prWeek.current.pr.invalidOrder === 1 && prWeek.current.pr.unmerged === 1)
check('PR 시작 경계 포함·끝 경계 제외 · 이전 같은 기간도 성공 머지 시각 기준', prWeek.previous.pr.count === 1 && prWeek.previous.pr.avgMs === 170 * H)
check('PR은 mergedAt 우선 · 0초 정상 · 평균/중앙값/p75 별도', prWeek.current.pr.p50Ms === 27.5 * H && prWeek.current.pr.p75Ms === 32 * H)
const reviewedPrs = summarize(prEvents, { now: NOW, days: 7, review: 'with' })
const plainPrs = summarize(prEvents, { now: NOW, days: 7, review: 'without' })
check('PR 리뷰 필터는 기존 작업 리뷰 유무 기준 · 현재/이전 동일 적용', reviewedPrs.current.pr.count === 4 && plainPrs.current.pr.count === 2 && reviewedPrs.previous.pr.count === 0 && plainPrs.previous.pr.count === 1)
check('빈 PR 기록은 평균 null · 집계/누락 0', empty.current.pr.avgMs === null && empty.current.pr.count === 0 && empty.current.pr.had === 0)
const noPlanPrs = [prEvent(2, 'pr.open', 'web', 20, null), prEvent(1, 'auto.merge', 'web', 20, null, { ok: true })]
check('계획서 연결 없는 PR은 전체에만 · 필터에서는 추측하지 않음', summarize(noPlanPrs, { now: NOW }).current.pr.count === 1 && summarize(noPlanPrs, { now: NOW, review: 'with' }).current.pr.count === 0)
const conflictingPrs = [prEvent(2, 'pr.open', 'web', 20), prEvent(1, 'auto.merge', 'web', 20, plainPrPlan, { ok: true })]
check('생성/머지의 계획서 연결이 서로 다르면 필터에서 제외', summarize(conflictingPrs, { now: NOW, review: 'without' }).current.pr.count === 0)
const overlapEvents = [
  { at: at(10), type: 'plan.status', plan: prPlan, from: null, to: 'in_progress' },
  { at: at(5), type: 'verify', plan: prPlan, ms: H, wait_ms: H, ok: true },
  { at: at(5), type: 'verify', plan: prPlan, ms: H, wait_ms: H, ok: true },
  { at: at(4), type: 'review', plan: prPlan, ms: 3 * H, verdict: '승인' },
  { at: at(4), type: 'review', plan: prPlan, ms: 3 * H, verdict: '승인' },
  { at: at(1), type: 'plan.status', plan: prPlan, from: 'in_progress', to: 'done' },
]
const overlap = summarize(overlapEvents, { now: NOW }).current
check('검증 줄서기 포함·동일 중복 구간 한 번·검증/리뷰 겹침은 검증 우선 · 작업당 누적', overlap.stages.verify.avgMs === 2 * H && overlap.stages.review.avgMs === H && overlap.stages.verify.count === 1 && overlap.stages.review.count === 1)

console.log('\n작업 안쪽(세션 기록)')
const T0 = Date.parse('2026-10-25T00:00:00Z')
const stamp = (seconds) => new Date(T0 + seconds * 1000).toISOString()
const user = (seconds, content, extra = {}) => ({ type: 'user', timestamp: stamp(seconds), message: { content }, ...extra })
const said = (seconds, id, content = [{ type: 'text', text: '.' }], extra = {}) => ({ type: 'assistant', timestamp: stamp(seconds), message: { id, content }, ...extra })
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input })
const result = (id) => [{ type: 'tool_result', tool_use_id: id }]
const reader = createSessionReader()
for (const entry of [
  user(0, '이 작업의 계획서: /x/bodies/y/plans/task/one.md — 먼저 읽고'),
  said(10, 'm1'),                                                       // 첫 응답 0~20 — 같은 id 두 줄과 그 사이가 생각·작성
  said(20, 'm1', [tool('t1', 'Bash', { command: 'until grep -q ok a; do sleep 5; done' })]),
  user(50, result('t1')),                                                // 기다리기 20~50
  said(60, 'm2', [tool('t2', 'Bash', { command: 'ATHENA_VERIFY_DIR=/w /a/scripts/verify/x.sh' }), tool('t3', 'Bash', { command: 'ls' })]),
  user(70, result('t3')),                                                // 생각 50~60 · 그 밖의 명령 60~70
  user(90, result('t2')),                                                // 검증·커밋 60~90 — 앞쪽이 겹침을 가져간다
  said(95, 'm3', [tool('t4', 'Read', { file_path: '/a' }), tool('t5', 'AskUserQuestion', {})]),
  user(100, result('t4')),                                               // 생각 90~95 · 읽기 95~100
  user(500, result('t5')),                                               // 사람 답 대기는 안 센다
  said(501, 'side', [tool('t6', 'Bash', { command: 'ls' })], { isSidechain: true }),   // 서브에이전트 줄은 안 센다
  user(600, '[아테나 pg1 → x] 새 요청 — 새 계획서: /x/plans/task/two.md . 앞 계획서와 별개다'),
  said(610, 'm4'),
]) reader.add(entry)
const one = reader.finish()
const sessionTotals = workTotals([one])
const seconds = (kinds, kind) => kinds[kind] / 1000
const firstPlan = sessionTotals.plans['plans/task/one.md']
check('연결된 세션 · 응답 안 줄 사이도 생각·작성 · 겹침 없음', one.kind === 'linked' && seconds(firstPlan, 'think') === 20 + 10 + 5 + 400 + 1 - 400 - 1, JSON.stringify(firstPlan))
check('기다리기 30 · 검증·커밋 30 · 읽기 5 — 도구를 나눠 잰다', seconds(firstPlan, 'wait') === 30 && seconds(firstPlan, 'check') === 30 && seconds(firstPlan, 'other') === 0 && seconds(firstPlan, 'read') === 5, JSON.stringify(firstPlan))
check('중간에 받은 새 계획서로 뒤 줄을 옮긴다', seconds(sessionTotals.plans['plans/task/two.md'], 'think') === 10, JSON.stringify(sessionTotals.plans))
const cut = workTotals([one], { from: T0 + 10_000, to: T0 + 30_000 })
check('기간 밖 줄은 잘라 낸다(10~20 생각 · 20~30 기다리기)', cut.totals.think === 10_000 && cut.totals.wait === 10_000, JSON.stringify(cut.totals))
const reviewSession = createSessionReader()
reviewSession.add(user(0, '리뷰할 계획서: /x/plans/task/one.md — 읽기 전용'))
reviewSession.add(said(10, 'r1'))
const plainSession = createSessionReader()
plainSession.add(user(0, '그냥 질문 — 이 작업의 계획서: /x/plans/task/one.md 를 봐 줘'))
plainSession.add(said(10, 'u1'))
const others = [reviewSession.finish(), plainSession.finish()].map((item) => ({ ...item, lastAt: T0 }))
const otherTotals = workTotals(others)
check('reviewer · 표시 없는 세션은 시간에 안 들고 건수만(첫머리 표시만 믿는다)', otherTotals.totals.think === 0 && otherTotals.sessions.reviewer === 1 && otherTotals.sessions.unlinked === 1, JSON.stringify(otherTotals))
check('압축 요약 속 옛 지시는 계획서 표시가 아니다', (() => {
  const compact = createSessionReader()
  compact.add(user(0, '이 작업의 계획서: /x/plans/task/one.md', { isCompactSummary: true }))
  compact.add(said(5, 'c1'))
  return compact.finish().kind === 'unlinked'
})())
check('명령 나누기', toolKind('Bash', { command: 'sleep 30 && gh pr view' }) === 'wait' && toolKind('Bash', { command: 'npm run typecheck' }) === 'check' && toolKind('Bash', { command: 'git status' }) === 'other' && toolKind('Edit', {}) === 'think' && toolKind('Grep', {}) === 'read' && toolKind('AskUserQuestion', {}) === null)

console.log('\n작업 안쪽 — Codex rollout(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl · 2026-11-04 실제 기록의 키 모양)')
{
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'metrics-codex-')))
  try {
    const worktrees = join(tmp, 'packs/demo/worktrees')
    const projectsDir = join(tmp, '.claude/projects')
    const codexSessionsDir = join(tmp, '.codex/sessions')
    mkdirSync(join(worktrees, 'shop/fix'), { recursive: true })
    mkdirSync(projectsDir, { recursive: true })
    const at = (seconds) => new Date(T0 + seconds * 1000).toISOString()
    const item = (seconds, payload) => ({ timestamp: at(seconds), type: 'response_item', payload })
    const talk = (seconds, role, text) => item(seconds, { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
    const rollout = (name, meta, records) => {
      const file = join(codexSessionsDir, '2026/10/25', `rollout-2026-10-25T00-00-00-${name}.jsonl`)
      mkdirSync(join(file, '..'), { recursive: true })
      const head = { timestamp: at(0), type: 'session_meta', payload: { id: name, session_id: name, source: 'cli', thread_source: 'user', ...meta } }
      writeFileSync(file, [head, ...records].map((record) => JSON.stringify(record)).join('\n') + '\n')
    }
    const work = [
      talk(0, 'user', '# AGENTS.md instructions for /w\n…'),                        // Codex 가 지시 앞에 넣는 문맥 — 표시가 아니다
      talk(0, 'user', '이 작업의 계획서: /x/bodies/y/plans/task/cx.md — 먼저 읽고'),
      item(5, { type: 'reasoning', summary: [] }),
      item(10, { type: 'custom_tool_call', call_id: 'k1', name: 'exec', input: 'await tools.exec_command({ cmd: "npm test" })' }),
      item(40, { type: 'custom_tool_call_output', call_id: 'k1', output: '' }),     // 검증 10~40
      talk(50, 'assistant', '확인했다'),                                              // 생각 0~10 · 40~50
      item(50, { type: 'function_call', call_id: 'k2', name: 'sleep', arguments: '{"duration_ms":30000}' }),
      item(80, { type: 'function_call_output', call_id: 'k2', output: '' }),        // 기다리기 50~80
      item(81, { type: 'function_call', call_id: 'k3', name: 'request_user_input', arguments: '{"questions":[]}' }),
      item(500, { type: 'function_call_output', call_id: 'k3', output: '' }),       // 사람 답 대기는 안 센다
    ]
    rollout('c-main', { cwd: join(worktrees, 'shop/fix') }, work)
    // 하위 에이전트(session_meta.parent_thread_id — 실제 기록 27개 모두 있음)는 Claude 서브에이전트(isSidechain)처럼 안 센다
    rollout('c-sub', { cwd: join(worktrees, 'shop/fix'), parent_thread_id: 'c-main', source: { subagent: { thread_spawn: { parent_thread_id: 'c-main' } } }, thread_source: 'subagent' }, work)
    // 이 팩 워크트리 밖에서 켠 세션은 안 센다
    rollout('c-other', { cwd: join(tmp, 'elsewhere') }, work)
    const claudeDir = join(projectsDir, `${join(worktrees, 'shop/fix').replace(/[^a-zA-Z0-9]/g, '-')}`)
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 's1.jsonl'), [user(0, '이 작업의 계획서: /x/bodies/y/plans/task/cl.md — 먼저'), said(10, 'm1')].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const cachePath = join(tmp, 'cache.json')
    const scan = () => scanSessions({ projectsDir, codexSessionsDir, worktrees, cachePath })
    const sessions = await scan()
    const totals = workTotals(sessions)
    const codexPlan = totals.plans['plans/task/cx.md']
    check('Codex 세션도 계획서에 이어 센다 — 검증 30 · 생각 21(0~10 · 40~50 · 80~81) · 기다리기 30 · 사람 답 대기 0', Boolean(codexPlan) && seconds(codexPlan, 'check') === 30 && seconds(codexPlan, 'think') === 21 && seconds(codexPlan, 'wait') === 30 && seconds(codexPlan, 'other') === 0, JSON.stringify(totals.plans))
    check('Claude 세션은 그대로 · 엔진별 건수(하위 에이전트 · 팩 밖 세션은 빠짐)', seconds(totals.plans['plans/task/cl.md'] ?? {}, 'think') === 10 && totals.sessions.linked === 2 && totals.engines?.codex === 1 && totals.engines?.claude === 1, JSON.stringify({ sessions: totals.sessions, engines: totals.engines }))
    const again = workTotals(await scan())
    check('캐시로 다시 읽어도 같은 값(엔진 포함)', JSON.stringify(again) === JSON.stringify(totals), JSON.stringify(again.engines))
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

console.log(`\n통과 ${pass} · 실패 ${fail}`)
process.exit(fail ? 1 : 0)
EOF
