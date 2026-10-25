#!/usr/bin/env node
/**
 * 작업 지표 — 이 본체 팩의 사건 기록(state/events.jsonl · docs/events.md)을 계획서마다 묶어 보여 준다. 현황판 [지표] 탭과 같은 계산
 *
 *   node scripts/metrics.mjs              # 최근 7일 · 지난 7일과 비교
 *   node scripts/metrics.mjs --days 30
 *   node scripts/metrics.mjs --all        # 전체 기간
 *   node scripts/metrics.mjs --json
 */
import { ATHENA_ROOT } from './lib/config.mjs'
import { readEvents } from './lib/events.mjs'
import { formatDuration, formatRate, summarize } from './lib/metrics.mjs'

const args = process.argv.slice(2)
const daysIndex = args.indexOf('--days')
const days = args.includes('--all') ? null : Number(daysIndex >= 0 ? args[daysIndex + 1] : 7) || 7
const summary = summarize(readEvents(ATHENA_ROOT), { days })

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
console.log(`기간: ${days ? `최근 ${days}일` : '전체'} · 기록 시작 ${summary.since.slice(0, 10)} · 사건 ${summary.events}개`)
console.log(`  완료           ${compare(current.done, previous?.done, count)}`)
console.log(`  평균 소요      ${compare(current.leadMs, previous?.leadMs, formatDuration)}${current.done > current.leadKnown ? ` — 시작 기록 ${current.leadKnown}개 기준` : ''}`)
console.log(`  작업당 질문    ${compare(current.asksPerDone, previous?.asksPerDone, count)}`)
console.log(`  평균 응답 대기 ${compare(current.waitMs, previous?.waitMs, formatDuration)}`)
console.log(`  검증 실패율    ${compare(current.verifyFailRate, previous?.verifyFailRate, formatRate)} · ${current.verifyRuns}회`)
console.log(`  리뷰 반려율    ${compare(current.reviewRejectRate, previous?.reviewRejectRate, formatRate)} · ${current.reviewRuns}회`)
console.log()
console.log('계획서 | 상태 | 소요 | 질문 | 응답 대기 | 막힘 | 검증 실패/전체 | 리뷰 반려/전체 | 커밋')
for (const plan of summary.plans) {
  console.log([plan.plan, plan.status ?? '—', formatDuration(plan.leadMs), plan.asks, formatDuration(plan.answered ? plan.waitMs : null), plan.blocked,
    `${plan.verify.fails}/${plan.verify.runs}`, `${plan.reviews.rejects}/${plan.reviews.runs}`, plan.commits].join(' | '))
}
