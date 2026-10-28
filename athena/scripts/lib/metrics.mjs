// 작업 지표 — 사건 기록(state/events.jsonl · docs/events.md)을 계획서마다 묶고 기간 숫자를 낸다.
// 현황판 [지표] 탭(/api/metrics)과 scripts/metrics.mjs 가 같이 쓴다. 파일을 읽지 않는 순수 계산이다
//
//   summarize(events, { now, days })   days 가 없으면 전체 기간(지난 기간 비교 없음)
//
// 계획서마다
//   asks       사람에게 물은 횟수 — 요청이 open 이 된 횟수(열린 채로 고친 것은 세지 않는다)
//   waitMs     사람 답을 기다린 시간 합 — open → answered · delivered
//   leadMs     걸린 시간 — 처음 본 때(plan.status from null) → 마지막으로 done 이 된 때. 처음 본 때를 모르면 null
//   blocked    blocked 로 간 횟수
//   verify     검증 { runs, fails } — 계획서를 모르니 같은 레포 · 브랜치의 커밋 · 리뷰로 잇는다
//   reviews    리뷰 { runs, rejects } — 수정 필요가 rejects
//   commits    커밋 수
//   waiting    지금 사람 답을 기다리는 요청 수 · waitingSince 그중 가장 오래된 open 시각
const HOUR = 3_600_000
const DAY = 24 * HOUR
const time = (event) => Date.parse(event.at) || 0

const emptyPlan = (id) => ({
  plan: id, status: null, firstAt: null, lastAt: null, startAt: null, doneAt: null, leadMs: null,
  asks: 0, answered: 0, waitMs: 0, waiting: 0, waitingSince: null, blocked: 0, verify: { runs: 0, fails: 0 }, reviews: { runs: 0, rejects: 0 }, commits: 0,
})

// 사건 → 계획서별 묶음. 시각 순으로 한 번 훑는다
export const groupByPlan = (events) => {
  const sorted = events.filter((event) => event && event.type && time(event)).sort((left, right) => time(left) - time(right))
  const plans = new Map()
  const planOf = (id) => {
    if (!plans.has(id)) plans.set(id, emptyPlan(id))
    return plans.get(id)
  }
  // 검증은 계획서를 모른다 — 레포 · 브랜치 → 계획서(커밋 · 리뷰 기록에서)
  const branchPlan = new Map()
  for (const event of sorted) {
    if ((event.type === 'commit' || event.type === 'review') && event.plan && event.repo && event.branch) branchPlan.set(`${event.repo}\t${event.branch}`, event.plan)
  }
  const requestState = new Map()   // 요청 id → { state, openedAt, plan }
  const touch = (plan, at) => {
    plan.firstAt ??= at
    plan.lastAt = at
  }
  for (const event of sorted) {
    const at = time(event)
    if (event.type === 'request') {
      const before = requestState.get(event.id) ?? { state: null, openedAt: null, plan: null }
      const planId = event.plan || before.plan
      const after = { state: event.state, openedAt: before.openedAt, plan: planId }
      const plan = planId ? planOf(planId) : null
      if (event.state === 'open' && before.state !== 'open') {
        after.openedAt = at
        if (plan) plan.asks += 1
      }
      if ((event.state === 'answered' || event.state === 'delivered') && before.openedAt !== null) {
        if (plan) { plan.waitMs += at - before.openedAt; plan.answered += 1 }
        after.openedAt = null
      }
      if (event.state === 'cancelled' || event.state === 'expired') after.openedAt = null
      requestState.set(event.id, after)
      if (plan) touch(plan, at)
      continue
    }
    if (event.type === 'plan.status' && event.plan) {
      const plan = planOf(event.plan)
      if (event.from === null && plan.startAt === null) plan.startAt = at
      if (event.to === 'blocked') plan.blocked += 1
      if (event.to === 'done') plan.doneAt = at
      plan.status = event.to
      touch(plan, at)
      continue
    }
    if (event.type === 'verify') {
      const planId = branchPlan.get(`${event.repo}\t${event.branch}`)
      if (!planId) continue
      const plan = planOf(planId)
      plan.verify.runs += 1
      if (event.ok === false) plan.verify.fails += 1
      touch(plan, at)
      continue
    }
    if (event.type === 'review' && event.plan) {
      const plan = planOf(event.plan)
      plan.reviews.runs += 1
      if (event.verdict === '수정 필요') plan.reviews.rejects += 1
      touch(plan, at)
      continue
    }
    if (event.type === 'commit' && event.plan) {
      const plan = planOf(event.plan)
      plan.commits += 1
      touch(plan, at)
    }
  }
  // 아직 답이 안 온 요청(open) — 계획서마다
  for (const request of requestState.values()) {
    if (request.state !== 'open' || !request.plan || request.openedAt === null) continue
    const plan = planOf(request.plan)
    plan.waiting += 1
    plan.waitingSince = plan.waitingSince === null ? request.openedAt : Math.min(plan.waitingSince, request.openedAt)
  }
  for (const plan of plans.values()) {
    // done 뒤에 다시 열렸으면(done → in_progress) 아직 안 끝난 것
    if (plan.status !== 'done') plan.doneAt = null
    plan.leadMs = plan.startAt !== null && plan.doneAt !== null ? plan.doneAt - plan.startAt : null
  }
  return [...plans.values()]
}

const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
const ratio = (part, whole) => (whole ? part / whole : null)

// 한 기간 [from, to) 의 숫자 — 끝낸 작업은 그 기간에 done 이 된 계획서, 비율은 그 기간에 일어난 사건으로
const windowTotals = (events, plans, from, to) => {
  const inside = (at) => at >= from && at < to
  const done = plans.filter((plan) => plan.doneAt !== null && inside(plan.doneAt))
  const happened = events.filter((event) => inside(time(event)))
  const verify = happened.filter((event) => event.type === 'verify')
  const reviews = happened.filter((event) => event.type === 'review')
  const leads = done.map((plan) => plan.leadMs).filter((value) => value !== null)
  // 질문 — 이 기간에 open 이 된 횟수(열린 채 고친 것은 안 센다) · 답 대기 — 이 기간에 답이 온 요청만(open 시각은 기간 밖이어도 된다)
  const opened = new Map()
  const waits = []
  let asks = 0
  for (const event of events.filter((item) => item.type === 'request').sort((left, right) => time(left) - time(right))) {
    if (event.state === 'open' && !opened.has(event.id)) {
      opened.set(event.id, time(event))
      if (inside(time(event))) asks += 1
    }
    if ((event.state === 'answered' || event.state === 'delivered') && opened.has(event.id)) {
      if (inside(time(event))) waits.push(time(event) - opened.get(event.id))
      opened.delete(event.id)
    }
    if (event.state === 'cancelled' || event.state === 'expired') opened.delete(event.id)
  }
  return {
    done: done.length,
    leadMs: average(leads),
    leadKnown: leads.length,
    asksPerDone: done.length ? average(done.map((plan) => plan.asks)) : null,
    asks,
    waitMs: average(waits),
    verifyRuns: verify.length,
    verifyFailRate: ratio(verify.filter((event) => event.ok === false).length, verify.length),
    reviewRuns: reviews.length,
    reviewRejectRate: ratio(reviews.filter((event) => event.verdict === '수정 필요').length, reviews.length),
  }
}

export const summarize = (events, { now = Date.now(), days = null } = {}) => {
  const valid = events.filter((event) => event && event.type && time(event))
  const plans = groupByPlan(valid)
  const firstAt = valid.length ? Math.min(...valid.map(time)) : null
  const span = days ? days * DAY : null
  const from = span ? now - span : -Infinity
  return {
    days,
    since: firstAt === null ? null : new Date(firstAt).toISOString(),
    events: valid.length,
    current: windowTotals(valid, plans, from, Infinity),
    previous: span ? windowTotals(valid, plans, now - 2 * span, from) : null,
    // 이 기간에 무슨 일이든 있었던 계획서 — 최근에 움직인 것부터
    plans: plans.filter((plan) => plan.lastAt !== null && plan.lastAt >= from).sort((left, right) => right.lastAt - left.lastAt),
  }
}

export const formatDuration = (ms) => {
  if (ms === null || ms === undefined) return '—'
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))}분`
  if (ms < 2 * DAY) return `${(ms / HOUR).toFixed(1)}시간`
  return `${(ms / DAY).toFixed(1)}일`
}
export const formatRate = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`)
