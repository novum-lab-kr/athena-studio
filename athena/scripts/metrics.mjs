#!/usr/bin/env node
/**
 * 작업 지표 — 이 본체 팩의 사건 기록(state/events.jsonl · docs/events.md)을 계획서마다 묶어 보여 준다. 현황판 [지표] 탭과 같은 계산
 *
 *   node scripts/metrics.mjs              # 최근 7일 · 지난 7일과 비교
 *   node scripts/metrics.mjs --days 30
 *   node scripts/metrics.mjs --all        # 전체 기간
 *   node scripts/metrics.mjs --since 2026-11-01   # 그날부터
 *   node scripts/metrics.mjs --review with        # 리뷰 있었던 계획서만(without — 없었던 것만)
 *   node scripts/metrics.mjs --json
 */
import { ATHENA_ROOT } from './lib/config.mjs'
import { readEvents } from './lib/events.mjs'
import { STAGES, formatDuration, formatRate, parseSinceDate, summarize } from './lib/metrics.mjs'

const args = process.argv.slice(2)
const daysIndex = args.indexOf('--days')
const days = args.includes('--all') ? null : Number(daysIndex >= 0 ? args[daysIndex + 1] : 7) || 7
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const sinceText = valueOf('--since')
const since = parseSinceDate(sinceText)
if (sinceText !== null && since === null) {
  console.error('--since 는 YYYY-MM-DD 로 적어 주세요')
  process.exit(1)
}
const summary = summarize(readEvents(ATHENA_ROOT), { days, since, review: valueOf('--review') })

if (args.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}
if (!summary.events) {
  console.log('기록 없음 (docs/events.md)')
  process.exit(0)
}

const { current, previous } = summary
const compare = (value, before, format) => (previous ? `${format(value)} (이전 ${format(before)})` : format(value))
const count = (value) => (value === null || value === undefined ? '—' : String(Math.round(value * 10) / 10))
const periodText = () => {
  if (since !== null) return `${sinceText}부터`
  return days ? `최근 ${days}일` : '전체'
}
const known = (ms) => (ms === null ? '모름' : formatDuration(ms))
const spreadText = (item) => `평균 ${known(item.avgMs)} · 중앙값 ${known(item.p50Ms)} · p75 ${known(item.p75Ms)}`
console.log(`기간: ${periodText()} · 기록 시작 ${summary.since.slice(0, 10)} · 사건 ${summary.events}개`)
console.log(`  완료           ${compare(current.done, previous?.done, count)}`)
console.log(`  소요(시작→첫 머지) ${spreadText(current.lead)} — 머지 ${current.merged} · done 기준 ${current.doneOnly} · 시작 기록 없어 빠짐 ${current.noStart}`)
if (current.handoffToMerge.count) console.log(`  넘김→머지 ${spreadText(current.handoffToMerge)} — ${current.handoffToMerge.count}건`)
console.log(`  머지→완료 표시 ${spreadText(current.mergeToDone)} — ${current.mergeToDone.count}건 · 첫 머지 뒤 커밋 ${current.followUps}건`)
console.log(`  작업당 질문    ${compare(current.asksPerDone, previous?.asksPerDone, count)}`)
console.log(`  평균 답 대기   ${compare(current.waitMs, previous?.waitMs, formatDuration)}`)
console.log(`  검증 실패율    ${compare(current.verifyFailRate, previous?.verifyFailRate, formatRate)} · ${current.verifyRuns}회`)
console.log(`  리뷰 반려율    ${compare(current.reviewRejectRate, previous?.reviewRejectRate, formatRate)} · ${current.reviewRuns}회`)
// 구간 — 끝낸 계획서 중 그 구간이 있었던 것(had) · 그중 시간을 아는 것만
const STAGE_LABEL = { work: '작업', verify: '검증', wait: '답 대기', review: '리뷰', mergeWait: '머지 대기' }
for (const stage of STAGES) {
  const item = current.stages[stage]
  console.log(`  ${STAGE_LABEL[stage]}  ${spreadText(item)} — ${current.done}건 중 ${item.had}건 · 시간 아는 것 ${item.count}건`)
}
console.log(`  리뷰 라운드    ${compare(current.reviewRounds, previous?.reviewRounds, count)}${current.done > current.reviewRoundsKnown ? ` — 자동 리뷰 기록 ${current.reviewRoundsKnown}개 기준` : ''}`)
console.log(`  머지당 수정    ${compare(current.fixRate, previous?.fixRate, count)} · 수정 ${current.autoFixes} / 머지 ${current.autoMerges}`)
console.log('  되돌림         기록 없음 (되돌림 사건이 아직 없다)')
console.log()
console.log('계획서 | 상태 | 소요 | 작업 | 검증 | 답 대기 | 리뷰 | 머지 대기 | 라운드 | 질문 | 답 대기 | 막힘 | 검증 실패/전체 | 리뷰 반려/전체 | 커밋')
for (const plan of summary.plans) {
  console.log([plan.plan, plan.status ?? '—', formatDuration(plan.leadMs), ...STAGES.map((stage) => (plan.stageHad[stage] ? known(plan.stages[stage]) : '—')), plan.reviewRounds,
    plan.asks, formatDuration(plan.answered ? plan.waitMs : null), plan.blocked,
    `${plan.verify.fails}/${plan.verify.runs}`, `${plan.reviews.rejects}/${plan.reviews.runs}`, plan.commits].join(' | '))
}
