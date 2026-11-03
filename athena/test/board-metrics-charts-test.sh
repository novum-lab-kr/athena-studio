#!/usr/bin/env bash
# 실제 지표 집계와 차트·작업 목록 렌더를 VM에서 검사한다. 브라우저·서버·사용자 데이터는 열지 않는다.
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
node --input-type=module - <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { summarize } from './scripts/lib/metrics.mjs'
const hourMs = 3_600_000, NOW = new Date(2026, 10, 3, 13).getTime(), FROM = NOW - 7 * 24 * hourMs
const at = (ms) => new Date(ms).toISOString()
const event = (ms, type, rest) => ({ at: at(ms), type, ...rest })
const previousPlan = 'plans/task/a.md', completedPlan = 'plans/task/b.md', missingStartPlan = 'plans/task/c.md', unknownStatusPlan = 'plans/task/d.md'
const events = [
  event(FROM - 2 * hourMs, 'plan.status', { plan: previousPlan, from: null, to: 'in_progress' }),
  event(FROM - hourMs, 'plan.status', { plan: previousPlan, from: 'in_progress', to: 'done' }),
  event(NOW - hourMs, 'plan.status', { plan: completedPlan, from: null, to: 'in_progress' }),
  event(NOW - 1, 'plan.status', { plan: completedPlan, from: 'in_progress', to: 'done' }),
  event(NOW - hourMs / 2, 'verify', { plan: completedPlan, ok: true, ms: 1000 }),
  event(NOW - hourMs / 3, 'verify', { plan: completedPlan, ok: false, ms: 1000 }),
  event(NOW - hourMs / 4, 'verify', { plan: completedPlan, ms: 1000 }),
  event(NOW - 2 * hourMs, 'plan.status', { plan: missingStartPlan, from: 'in_progress', to: 'done' }),
  event(NOW - hourMs, 'plan.status', { plan: unknownStatusPlan, from: null, to: 'unknown-status' }),
]
let count = 0
const check = (name, test) => { test(); count++; console.log(`  ✔ ${name}`) }
const summary = summarize(events, { now: NOW, days: 7 })
summary.plans.forEach((plan) => { plan.title = `제목 ${plan.plan.at(-4)}`; plan.exists = true })
const html = readFileSync('./scripts/board/index.html', 'utf8')
const esc = html.match(/  const esc = .+;/)[0]
const functions = html.slice(html.indexOf('  const metricDuration ='), html.indexOf('  let metricsController'))
const api = runInNewContext(`${esc}\n${functions}\n({metricCharts,metricBuckets,metricHistogram,metricStates,metricVerify,metricStages})`, { Date })
check('기준 시각은 입력 now, 이전 완료 목록은 이전 집계 개수와 일치', () => {
  assert.equal(summary.until, at(NOW)); assert.equal(summary.previousCompleted.length, summary.previous.done)
  assert.deepEqual(summary.previousCompleted, [FROM - hourMs])
})
check('검증 통과/실패/미확인 실행은 실제 사건대로 나뉨', () => {
  assert.equal(summary.current.verifyRuns, 3); assert.equal(summary.current.verifyPasses, 1); assert.equal(summary.current.verifyFails, 1)
  assert.equal(summary.current.verifyFailRate, 1 / 3)
})
check('리뷰 필터는 현재/이전 완료 그래프에 같은 기준 적용', () => {
  const withReview = summarize(events, { now: NOW, days: 7, review: 'with' })
  assert.equal(withReview.current.done, 0); assert.equal(withReview.previousCompleted.length, 0)
  const without = summarize(events, { now: NOW, days: 7, review: 'without' })
  assert.equal(without.current.done, 2); assert.equal(without.previousCompleted.length, 1)
})
check('최근7일의 부분 첫날/끝날은 고유 날짜로 나뉘고 합계 일치', () => {
  const buckets = api.metricBuckets(summary)
  assert.equal(buckets.length, 8); assert.equal(new Set(buckets.map((item) => item.from)).size, 8)
  assert.equal(buckets.reduce((total, item) => total + item.count, 0), summary.current.done)
  assert.equal(buckets.reduce((total, item) => total + item.previous, 0), summary.previous.done)
})
check('오래된 전체 기간은 최대14개 구간, 미래 시작일은 빈 구간', () => {
  assert.ok(api.metricBuckets({ ...summary, from: new Date(2026, 0, 1).toISOString() }).length <= 14)
  assert.equal(api.metricBuckets({ ...summary, from: at(NOW + hourMs) }).length, 0)
})
check('분포는 시간을 아는 완료 작업만 개수·비중으로 표시', () => {
  const hist = api.metricHistogram(summary, 600)
  assert.match(hist, /시간 기록 1개 \/ 완료 2개/)
  assert.equal((hist.match(/class="metric-distribution-row"/g) || []).length, 6)
  assert.match(hist, /1개<\/b> · 100%/); assert.match(hist, /시간 미기록 1개/); assert.ok(!hist.includes('<circle'))
})
check('많은 작업의 시간대 집계는 선형으로 계산', () => {
  const copy = structuredClone(summary)
  const planCount = 200
  let leadReads = 0
  const template = copy.plans[0]
  copy.plans = Array.from({ length: planCount }, (_, index) => ({
    ...template, endAt: NOW - hourMs,
    get leadMs() { leadReads++; return (25 + index % 8) * hourMs },
  }))
  copy.current.lead = { p50Ms: 28 * hourMs, p75Ms: 30 * hourMs, count: planCount }
  api.metricHistogram(copy, 600)
  assert.ok(leadReads < planCount * 30, `소요 필드 접근 ${leadReads}회`)
})
check('시간대 경계는 다음 구간에 한 번만 포함하고 비중의 분모는 시간 기록 수', () => {
  const copy = structuredClone(summary)
  copy.plans = [0, hourMs, 2 * hourMs, 4 * hourMs, 8 * hourMs, 24 * hourMs, null].map((leadMs) => ({ ...copy.plans[0], endAt: NOW - 1, leadMs }))
  copy.current.done = 7
  const output = api.metricHistogram(copy)
  assert.equal((output.match(/<b>1개<\/b> · 17%/g) || []).length, 6)
  assert.match(output, /시간 기록 6개 \/ 완료 7개/)
  assert.match(output, /시간 미기록 1개/)
})
check('현재 상태는 미확인 상태까지 포함하며 선택기간임을 명시', () => {
  const states = api.metricStates(summary)
  assert.match(states, /상태 모름/); assert.match(states, /선택 기간에 기록된 3개 작업/)
})
check('검증 도넛은 통과/실패/모름의 배타적 개수', () => {
  const verify = api.metricVerify(summary)
  assert.match(verify, /통과 1회·실패 1회·모름 1회/)
  assert.match(verify, /33%/)
})
check('단계 없음과 시간 모름, 0초를 구별', () => {
  const copy = structuredClone(summary)
  copy.current.stages.work = { had: 1, count: 0, avgMs: null, p50Ms: null, p75Ms: null }
  copy.current.stages.verify = { had: 1, count: 1, avgMs: 0, p50Ms: 0, p75Ms: 0 }
  const stages = api.metricStages(copy)
  assert.match(stages, /시간 모름/); assert.match(stages, /없었던 단계/); assert.match(stages, /0초/)
})
check('평균 카드 네 개와 계산 기준 · 타임라인 제거', () => {
  const copy = structuredClone(summary)
  copy.current.lead = { avgMs: 3 * hourMs, p50Ms: hourMs, p75Ms: 4 * hourMs, count: 3 }
  copy.previous.lead = { avgMs: 6 * hourMs, p50Ms: hourMs, p75Ms: 8 * hourMs, count: 3 }
  const output = api.metricCharts(copy, 1000)
  assert.equal((output.match(/class="metric-kpi"/g) || []).length, 4)
  assert.match(output, /전체 작업 평균<\/span><strong>3시간/)
  assert.match(output, /PR 평균/); assert.match(output, /리뷰 평균 · 작업당/); assert.match(output, /검증 평균 · 작업당/)
  assert.match(output, /중앙값 1시간 · p75 4시간/); assert.match(output, /이전 평균 6시간/); assert.match(output, /▼ 50%/)
  assert.match(output, /줄서기 포함/); assert.match(output, /겹친 구간은 한 번/); assert.match(output, /repo\+pr/)
  assert.ok(!output.includes('작업 타임라인')); assert.ok(!html.includes('const metricTimeline'))
})
check('단계 막대도 평균을 표시 · 평균이 p75보다 커도 범위 안', () => {
  const copy = structuredClone(summary)
  copy.current.stages.review = { had: 1, count: 1, avgMs: 10 * hourMs, p50Ms: hourMs, p75Ms: 2 * hourMs }
  const output = api.metricStages(copy)
  assert.match(output, /검토받기<\/b><span>10시간/)
  assert.match(output, /중앙값 1시간/); assert.ok([...output.matchAll(/<rect[^>]*width="([\d.]+)"/g)].every((match) => Number(match[1]) <= 1000))
})
check('완료 없는 열린 작업은 분포에 넣지 않음', () => {
  const copy = structuredClone(summary)
  copy.plans = [{ ...copy.plans[0], startAt: NOW - hourMs, endAt: null, status: 'in_progress', leadMs: null }]
  copy.current.done = 0
  assert.match(api.metricHistogram(copy, 320), /끝낸 작업이 없어요/)
})
check('0초 완료는 분포의 첫 구간에 포함', () => {
  const copy = structuredClone(summary)
  copy.plans = [{ ...copy.plans[0], startAt: NOW - hourMs, endAt: NOW - hourMs, leadMs: 0, mergedAt: null }]
  copy.current.lead = { p50Ms: 0, p75Ms: 0, count: 1 }
  const hist = api.metricHistogram(copy, 320)
  assert.match(hist, /0초/); assert.match(hist, /1개<\/b> · 100%/)
})
check('제목은 이스케이프하고 파일명을 대체 표시하지 않음', () => {
  const copy = structuredClone(summary); copy.plans[0].title = '<img onerror="boom">'
  copy.plans[1].title = ''
  const output = api.metricCharts(copy, 390)
  assert.ok(!output.includes('<img'))
  assert.ok(!output.includes('plans/task/'))
})
check('데스크톱/모바일 및 빈/전체/미래기간에 비정상 SVG 수치 없음', () => {
  const empty = summarize([], { now: NOW, days: 7 })
  for (const sample of [summary, { ...summary, previous: null, previousCompleted: null, from: null }, { ...summary, from: at(NOW + hourMs), plans: [] }, empty]) {
    for (const width of [320, 390, 1400]) {
      const output = api.metricCharts(sample, width)
      assert.ok(!/NaN|Infinity|undefined|Invalid Date/.test(output), output.slice(0, 200))
      assert.ok(!/(?:width|height)="-/.test(output))
    }
  }
})
// 실제 fetch 제어도 브라우저 없이 확인한다. DOM은 쓰는 자리만 가진 가짜 객체다.
const nodes = new Map()
const node = (id) => {
  if (!nodes.has(id)) nodes.set(id, { value: id === 'metrics-days' ? '7' : '', clientWidth: 1000, innerHTML: '', outerHTML: '', attrs: {}, setAttribute(key, value) { this.attrs[key] = value } })
  return nodes.get(id)
}
const requests = []
const fetch = (url, options = {}) => {
  if (url.startsWith('/api/metrics/work')) return Promise.resolve({ ok: true, json: async () => ({ totals: {}, sessions: { linked: 0, reviewer: 0, unlinked: 0 }, plans: {} }) })
  return new Promise((resolve, reject) => {
    requests.push({ url, signal: options.signal, resolve })
    options.signal.addEventListener('abort', () => { const error = new Error('취소'); error.name = 'AbortError'; reject(error) })
  })
}
const loadSource = html.slice(html.indexOf('  let metricsController'), html.indexOf("  document.getElementById('metrics-days').addEventListener"))
const loader = runInNewContext(`${esc}\n${functions}\n${loadSource}\n({loadMetrics})`, { Date, AbortController, URLSearchParams, fetch, document: { getElementById: node, querySelectorAll: () => [] } })
await (async () => {
  const first = loader.loadMetrics(), second = loader.loadMetrics()
  check('기간을 바꾸면 이전 fetch를 취소', () => assert.equal(requests[0].signal.aborted, true))
  requests[1].resolve({ ok: true, json: async () => summary }); await Promise.all([first, second])
  check('취소된 오류는 새 화면을 덮지 않음', () => { assert.match(node('metrics').innerHTML, /작업별 걸린 시간 분포/); assert.equal(node('metrics').attrs['aria-busy'], 'false') })
  check('전체 작업은 기본 펼침 · 전체 경과와 다섯 단계는 숫자/미기록으로 표시', () => {
    const output = node('metrics').innerHTML
    assert.match(output, /<details open class="metric-details metric-all-plans"/)
    assert.match(output, /전체 경과 60분/); assert.match(output, /전체 경과 미기록/)
    assert.match(output, /<dt>검증<\/dt><dd>3초/)
    assert.match(output, /<dt>작업<\/dt><dd>시간 모름/)
    assert.match(output, /<dt>리뷰<\/dt><dd>없음/)
    assert.equal((output.match(/class="metric-plan-stages"/g) || []).length, summary.plans.length)
  })
  node('metrics-review').value = 'with'; node('metrics-since').value = '2026-11-01'
  const third = loader.loadMetrics()
  requests[2].resolve({ ok: false, status: 500 }); await third
  check('날짜/리뷰 필터를 전달하고 HTTP 오류를 표시', () => { assert.match(requests[2].url, /review=with/); assert.match(requests[2].url, /since=2026-11-01/); assert.ok(!requests[2].url.includes('days=')); assert.match(node('metrics').innerHTML, /HTTP 500/) })
  const escapedSummary = structuredClone(summary)
  escapedSummary.plans[0].title = '<img onerror="boom">'
  const escapedLoad = loader.loadMetrics(); requests.at(-1).resolve({ ok: true, json: async () => escapedSummary }); await escapedLoad
  check('작업 목록 제목을 이스케이프', () => { assert.match(node('metrics').innerHTML, /&lt;img/); assert.ok(!node('metrics').innerHTML.includes('<img')) })
  const zeroSummary = structuredClone(summary)
  zeroSummary.plans = [{ ...summary.plans[0], leadMs: 0, stages: { work: 0, verify: null, wait: null, review: null, mergeWait: null }, stageHad: { work: true, verify: true } }]
  const zeroLoad = loader.loadMetrics(); requests.at(-1).resolve({ ok: true, json: async () => zeroSummary }); await zeroLoad
  check('전체 경과·단계의 0초는 미기록과 구분', () => {
    assert.match(node('metrics').innerHTML, /전체 경과 0초/)
    assert.match(node('metrics').innerHTML, /<dt>작업<\/dt><dd>0초/)
    assert.match(node('metrics').innerHTML, /<dt>검증<\/dt><dd>시간 모름/)
    assert.ok(!/NaN|Infinity/.test(node('metrics').innerHTML))
  })
  const partialSummary = structuredClone(zeroSummary)
  partialSummary.plans[0].leadMs = null; partialSummary.plans[0].stages.work = 1000
  const partialLoad = loader.loadMetrics(); requests.at(-1).resolve({ ok: true, json: async () => partialSummary }); await partialLoad
  check('단계 일부만 알려져도 단계 합을 전체 경과로 표시하지 않음', () => {
    assert.match(node('metrics').innerHTML, /전체 경과 미기록/)
    assert.ok(!node('metrics').innerHTML.includes('전체 경과 1초'))
    assert.match(node('metrics').innerHTML, /<dt>작업<\/dt><dd>1초/)
  })
  const manySummary = structuredClone(summary)
  manySummary.plans = Array.from({ length: 294 }, (_, index) => ({ ...summary.plans[0], plan: `plans/task/${index}.md` }))
  const manyLoad = loader.loadMetrics(); requests.at(-1).resolve({ ok: true, json: async () => manySummary }); await manyLoad
  check('294개 작업을 기본 목록에서 모두 표시', () => {
    assert.match(node('metrics').innerHTML, /전체 작업 294개/)
    assert.equal((node('metrics').innerHTML.match(/data-plan=/g) || []).length, 294)
  })
  const fourth = loader.loadMetrics(); requests.at(-1).resolve({ ok: true, json: async () => ({ events: 0 }) }); await fourth
  check('빈 기록은 오류 없이 빈 상태로 표시', () => assert.match(node('metrics').innerHTML, /아직 작업 기록이 없어요/))
})()
console.log(`✅ 통과 ${count}`)
JS
