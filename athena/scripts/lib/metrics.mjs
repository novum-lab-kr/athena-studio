// 작업 지표 — 사건 기록(state/events.jsonl · docs/events.md)을 계획서마다 묶고 기간 숫자를 낸다.
// 현황판 [지표] 탭(/api/metrics)과 scripts/metrics.mjs 가 같이 쓴다. 파일을 읽지 않는 순수 계산이다
//
//   summarize(events, { now, days, since, review })
//     days 가 없으면 전체 기간 · since(ms)가 있으면 그때부터(지난 기간은 같은 길이) · review 'with' | 'without' 은 리뷰 있었던 · 없었던 계획서만
//
// 계획서마다
//   asks       사람에게 물은 횟수 — 요청이 open 이 된 횟수(열린 채로 고친 것은 세지 않는다)
//   waitMs     사람 답을 기다린 시간 합 — open → answered · delivered
//   leadMs     대표 소요 — 처음 본 때(plan.status from null) → 첫 머지(auto.merge ok · 머지가 없으면 마지막 done). 처음 본 때를 모르면 null
//   mergeToDoneMs  마지막 머지 → done(완료 표시가 늦어진 시간 · 대표 소요와 따로)
//   reviewed   끝(첫 머지 · done) 전에 리뷰가 있었나
//   blocked    blocked 로 간 횟수
//   verify     검증 { runs, fails } — plan 칸이 있으면 그걸로, 없으면(옛 기록) 같은 레포 · 브랜치의 커밋 · 리뷰로 잇는다
//   reviews    리뷰 { runs, rejects } — 수정 필요가 rejects
//   commits    커밋 수
//   waiting    지금 사람 답을 기다리는 요청 수 · waitingSince 그중 가장 오래된 open 시각
//   stages     구간별 시간(ms · 모르면 null) — 시작 → 끝을 나눈 것이라 다 알면 합이 leadMs 와 같다. 겹치면 STAGE_PRIORITY 앞쪽이 가져간다
//                verify    verify 사건의 줄서기(wait_ms) + 소요(ms) — 사건은 끝날 때 남으니 at 에서 거슬러 잰다
//                review    한 번의 리뷰 시작 → 결론. 시작은 ms 칸 · 없으면 수동은 직전 reviewer delegate, 자동은 직전 커밋 · auto.push · pr.open
//                mergeWait 작업 끝(첫 머지 전 마지막 커밋 · ready_for_review) → 첫 머지
//                wait      요청 open → 닫힘(지금 열려 있으면 끝까지)
//                work      나머지
//   stageHad   그 구간이 있었나(리뷰 없는 계획서는 review 가 false — 모름과 다르다)
//   reviewRounds  PR 자동 리뷰 라운드 수(review 사건 중 by: auto — 라운드마다 한 줄)
//   fixRate    정확도 — auto.fix 수 ÷ auto.merge(ok) 수(머지 1건당 고친 횟수 · 머지가 없으면 null)
//   reverts    머지 뒤 되돌림 수 — 되돌림 사건이 아직 없어 null(기록 없음). 커밋 메시지로 세지 않는다
const HOUR = 3_600_000
const DAY = 24 * HOUR
const time = (event) => Date.parse(event.at) || 0

const emptyPlan = (id) => ({
  plan: id, status: null, firstAt: null, lastAt: null, startAt: null, doneAt: null, leadMs: null,
  asks: 0, answered: 0, waitMs: 0, waiting: 0, waitingSince: null, blocked: 0, verify: { runs: 0, fails: 0 }, reviews: { runs: 0, rejects: 0 }, commits: 0,
  mergedAt: null, lastMergeAt: null, endAt: null, mergeToDoneMs: null, reviewed: false, followUp: false,
  stages: { work: null, verify: null, wait: null, review: null, mergeWait: null },
  stageHad: { work: false, verify: false, wait: false, review: false, mergeWait: false },
  raw: { verifies: [], reviews: [], requests: [], workMarks: [], commitAts: [], lastMark: null, reviewerAt: null, lastReviewAt: null },
  reviewRounds: 0, autoFixes: 0, autoMerges: 0, fixRate: null, reverts: null,
})

// 사건의 ms 칸 — 숫자(또는 숫자 글자)일 때만. 옛 기록(칸 없음)은 null
const msOf = (event, field = 'ms') => {
  if (event[field] === null || event[field] === undefined || event[field] === '') return null
  const value = Number(event[field])
  return Number.isFinite(value) && value >= 0 ? value : null
}

const branchPlans = (events) => {
  const found = new Map()
  for (const event of events) {
    if ((event.type === 'commit' || event.type === 'review') && event.plan && event.repo && event.branch) found.set(`${event.repo}\t${event.branch}`, event.plan)
  }
  return found
}

// 사건 → 계획서별 묶음. 시각 순으로 한 번 훑는다
export const groupByPlan = (events) => {
  const sorted = events.filter((event) => event && event.type && time(event)).sort((left, right) => time(left) - time(right))
  const plans = new Map()
  const planOf = (id) => {
    if (!plans.has(id)) plans.set(id, emptyPlan(id))
    return plans.get(id)
  }
  // 검증은 계획서를 모른다 — 레포 · 브랜치 → 계획서(커밋 · 리뷰 기록에서)
  const branchPlan = branchPlans(sorted)
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
        if (plan) {
          plan.waitMs += at - before.openedAt
          plan.answered += 1
          plan.raw.requests.push({ from: before.openedAt, to: at })
        }
        after.openedAt = null
      }
      if ((event.state === 'cancelled' || event.state === 'expired') && before.openedAt !== null) {
        if (plan) plan.raw.requests.push({ from: before.openedAt, to: at })
        after.openedAt = null
      }
      requestState.set(event.id, after)
      if (plan) touch(plan, at)
      continue
    }
    if (event.type === 'plan.status' && event.plan) {
      const plan = planOf(event.plan)
      if (event.from === null && plan.startAt === null) plan.startAt = at
      if (event.to === 'blocked') plan.blocked += 1
      if (event.to === 'done') plan.doneAt = at
      if (event.to === 'ready_for_review') plan.raw.workMarks.push(at)
      plan.status = event.to
      touch(plan, at)
      continue
    }
    if (event.type === 'verify') {
      // 새 기록은 plan 칸으로 바로, 옛 기록은 레포 · 브랜치로
      const planId = event.plan || branchPlan.get(`${event.repo}\t${event.branch}`)
      if (!planId) continue
      const plan = planOf(planId)
      plan.verify.runs += 1
      if (event.ok === false) plan.verify.fails += 1
      plan.raw.verifies.push({ at, ms: msOf(event), waitMs: msOf(event, 'wait_ms') ?? 0 })
      touch(plan, at)
      continue
    }
    if (event.type === 'pr.open' && event.plan) {
      // 옛 자동 리뷰의 시작점
      const plan = planOf(event.plan)
      plan.raw.lastMark = at
      touch(plan, at)
      continue
    }
    // 수동 리뷰의 시작 — reviewer pane 을 띄운 때(세션 첫 줄과 1~2초 차이 · 실측). 결론 없이 끝난 reviewer 가 있으니 결론 직전 것을 쓴다
    if (event.type === 'delegate' && event.agent === 'reviewer' && event.plan) {
      planOf(event.plan).raw.reviewerAt = at
      continue
    }
    if (event.type === 'auto.push' && event.plan) {
      planOf(event.plan).raw.lastMark = at
      continue
    }
    if (event.type === 'review' && event.plan) {
      const plan = planOf(event.plan)
      plan.reviews.runs += 1
      if (event.verdict === '수정 필요') plan.reviews.rejects += 1
      if (event.by === 'auto') plan.reviewRounds += 1
      plan.raw.reviews.push({ at, from: reviewStart(plan, event, at) })
      plan.raw.reviewerAt = null
      plan.raw.lastReviewAt = at
      touch(plan, at)
      continue
    }
    if (event.type === 'commit' && event.plan) {
      const plan = planOf(event.plan)
      plan.commits += 1
      plan.raw.workMarks.push(at)
      plan.raw.commitAts.push(at)
      plan.raw.lastMark = at
      touch(plan, at)
      continue
    }
    if (event.type === 'auto.fix' && event.plan) {
      const plan = planOf(event.plan)
      plan.autoFixes += 1
      touch(plan, at)
      continue
    }
    if (event.type === 'auto.merge' && event.plan && event.ok === true) {
      const plan = planOf(event.plan)
      plan.autoMerges += 1
      // 넘긴 작업은 현황판이 늦게 볼 수 있어 Actions 가 머지를 끝낸 시각을 쓴다
      const mergedAt = Date.parse(event.mergedAt ?? '') || at
      plan.mergedAt ??= mergedAt
      plan.lastMergeAt = mergedAt
      touch(plan, mergedAt)
    }
  }
  // 아직 답이 안 온 요청(open) — 계획서마다
  for (const request of requestState.values()) {
    if (request.state !== 'open' || !request.plan || request.openedAt === null) continue
    const plan = planOf(request.plan)
    plan.raw.requests.push({ from: request.openedAt, to: Infinity })
    plan.waiting += 1
    plan.waitingSince = plan.waitingSince === null ? request.openedAt : Math.min(plan.waitingSince, request.openedAt)
  }
  for (const plan of plans.values()) {
    // done 뒤에 다시 열렸으면(done → in_progress) 아직 안 끝난 것
    if (plan.status !== 'done') plan.doneAt = null
    plan.endAt = plan.mergedAt ?? plan.doneAt
    plan.leadMs = plan.startAt !== null && plan.endAt !== null ? plan.endAt - plan.startAt : null
    plan.mergeToDoneMs = plan.lastMergeAt !== null && plan.doneAt !== null && plan.doneAt >= plan.lastMergeAt ? plan.doneAt - plan.lastMergeAt : null
    const end = plan.endAt ?? Infinity
    plan.reviewed = plan.raw.reviews.some((review) => review.at <= end)
    plan.followUp = plan.mergedAt !== null && plan.raw.commitAts.some((at) => at > plan.mergedAt)
    Object.assign(plan, planStages(plan))
    plan.fixRate = ratio(plan.autoFixes, plan.autoMerges)
    delete plan.raw
  }
  return [...plans.values()]
}

// 한 번의 리뷰가 시작된 때 — 모르면 null
const reviewStart = (plan, event, at) => {
  const ms = msOf(event)
  if (ms !== null) return at - ms
  if (event.by === 'auto') {
    // 옛 자동 리뷰 — 직전 코드 변경 뒤에 돌았다. 앞 리뷰 뒤로 코드가 안 바뀌었으면(다시 돌린 라운드) 시작을 모른다
    const mark = plan.raw.lastMark
    return mark !== null && (plan.raw.lastReviewAt === null || mark > plan.raw.lastReviewAt) ? mark : null
  }
  return plan.raw.reviewerAt
}

// 겹치는 시간 나누기 — 한 순간은 order 앞쪽의 칸 하나에만. [{ label, from, to }] → 겹치지 않는 [{ label, from, to }](시각 순)
export const partition = (intervals, order) => {
  const rank = new Map(order.map((label, index) => [label, index]))
  const points = []
  for (const item of intervals) {
    if (!(item.to > item.from)) continue
    points.push({ at: item.from, label: item.label, step: 1 }, { at: item.to, label: item.label, step: -1 })
  }
  points.sort((left, right) => left.at - right.at)
  const active = order.map(() => 0)
  const pieces = []
  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    active[rank.get(point.label)] += point.step
    const next = points[index + 1]
    if (!next || next.at === point.at) continue
    const top = active.findIndex((count) => count > 0)
    if (top < 0) continue
    const last = pieces.at(-1)
    if (last && last.label === order[top] && last.to === point.at) last.to = next.at
    else pieces.push({ label: order[top], from: point.at, to: next.at })
  }
  return pieces
}

// 겹치면 앞쪽이 가져간다 — 머지 확인을 기다리는 요청은 답 대기가 아니라 머지 대기로 든다
export const STAGE_PRIORITY = ['verify', 'review', 'mergeWait', 'wait', 'work']

// 구간별 시간 — 시작 → 끝을 나눈다. 소요를 모르는 줄이 끼면 그 구간(과 나머지인 작업)은 0 이 아니라 null
const planStages = (plan) => {
  const stages = { work: null, verify: null, wait: null, review: null, mergeWait: null }
  const stageHad = { work: false, verify: false, wait: false, review: false, mergeWait: false }
  if (plan.endAt === null) return { stages, stageHad }
  const end = plan.endAt
  const start = plan.startAt ?? -Infinity
  const inSpan = (at) => at >= start && at <= end
  const verifies = plan.raw.verifies.filter((item) => inSpan(item.at))
  const reviews = plan.raw.reviews.filter((item) => inSpan(item.at))
  const requests = plan.raw.requests.filter((item) => item.from <= end && item.to >= start)
  const marks = plan.raw.workMarks.filter((at) => inSpan(at))
  const workEnd = plan.mergedAt !== null && marks.length ? Math.max(...marks) : null
  stageHad.work = true
  stageHad.verify = verifies.length > 0
  stageHad.review = reviews.length > 0
  stageHad.wait = requests.length > 0
  stageHad.mergeWait = plan.mergedAt !== null
  if (plan.startAt === null) return { stages, stageHad }
  const unknownVerify = verifies.filter((item) => item.ms === null)
  const unknownReview = reviews.filter((item) => item.from === null)
  const clip = (label, from, to) => ({ label, from: Math.max(from, start), to: Math.min(to, end) })
  const intervals = [
    clip('work', start, end),
    ...verifies.filter((item) => item.ms !== null).map((item) => clip('verify', item.at - item.ms - item.waitMs, item.at)),
    ...reviews.filter((item) => item.from !== null).map((item) => clip('review', item.from, item.at)),
    ...requests.map((item) => clip('wait', item.from, item.to)),
    ...(workEnd !== null ? [clip('mergeWait', workEnd, end)] : []),
  ]
  const totals = { work: 0, verify: 0, wait: 0, review: 0, mergeWait: 0 }
  for (const piece of partition(intervals, STAGE_PRIORITY)) totals[piece.label] += piece.to - piece.from
  const unknownAny = unknownVerify.length > 0 || unknownReview.length > 0
  const unknownAfter = (from) => unknownVerify.some((item) => item.at >= from) || unknownReview.some((item) => item.at >= from)
  stages.verify = unknownVerify.length ? null : totals.verify
  stages.review = unknownReview.length ? null : totals.review
  stages.wait = totals.wait
  stages.mergeWait = workEnd === null || unknownAfter(workEnd) ? null : totals.mergeWait
  stages.work = unknownAny ? null : totals.work
  return { stages, stageHad }
}

const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)
const ratio = (part, whole) => (whole ? part / whole : null)
export const STAGES = ['work', 'verify', 'wait', 'review', 'mergeWait']

// 값 하나 또는 두 값 사이 — 표본이 적어도 지어내지 않고 있는 값에서 잰다
const percentile = (sorted, share) => {
  if (!sorted.length) return null
  const place = (sorted.length - 1) * share
  const below = Math.floor(place)
  const above = Math.ceil(place)
  return sorted[below] + (sorted[above] - sorted[below]) * (place - below)
}
// 평균만 보면 소수의 긴 작업에 끌려간다 — 중앙값 · p75 를 같이
export const spread = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return { avgMs: average(sorted), p50Ms: percentile(sorted, 0.5), p75Ms: percentile(sorted, 0.75), count: sorted.length }
}

// 한 기간 [from, to) 의 숫자 — 끝낸 작업은 그 기간에 끝(첫 머지 · 머지 없으면 done)이 든 계획서, 비율은 그 기간에 일어난 사건으로.
// picked 가 있으면 그 계획서들만(리뷰 있음 · 없음) — 계획서를 모르는 사건은 뺀다
const windowTotals = (events, plans, from, to, picked = null) => {
  const inside = (at) => at >= from && at < to
  const kept = (planId) => picked === null || (planId && picked.has(planId))
  const done = plans.filter((plan) => plan.endAt !== null && inside(plan.endAt) && kept(plan.plan))
  const branchPlan = branchPlans(events)
  const happened = events.filter((event) => inside(time(event)) && kept(event.plan || branchPlan.get(`${event.repo}\t${event.branch}`)))
  const verify = happened.filter((event) => event.type === 'verify')
  const reviews = happened.filter((event) => event.type === 'review')
  // 질문 — 이 기간에 open 이 된 횟수(열린 채 고친 것은 안 센다) · 답 대기 — 이 기간에 답이 온 요청만(open 시각은 기간 밖이어도 된다)
  const opened = new Map()
  const requestPlan = new Map()
  const waits = []
  let asks = 0
  for (const event of events.filter((item) => item.type === 'request').sort((left, right) => time(left) - time(right))) {
    if (event.plan) requestPlan.set(event.id, event.plan)
    const counted = kept(requestPlan.get(event.id))
    if (event.state === 'open' && !opened.has(event.id)) {
      opened.set(event.id, time(event))
      if (inside(time(event)) && counted) asks += 1
    }
    if ((event.state === 'answered' || event.state === 'delivered') && opened.has(event.id)) {
      if (inside(time(event)) && counted) waits.push(time(event) - opened.get(event.id))
      opened.delete(event.id)
    }
    if (event.state === 'cancelled' || event.state === 'expired') opened.delete(event.id)
  }
  // 구간 — 그 구간이 있었던 계획서(had) 중 시간을 아는 것만(count). 리뷰는 "done 건 중 had 건"
  const stages = {}
  for (const stage of STAGES) {
    const had = done.filter((plan) => plan.stageHad[stage])
    stages[stage] = { ...spread(had.map((plan) => plan.stages[stage]).filter((value) => value !== null)), had: had.length }
  }
  const rounds = done.map((plan) => plan.reviewRounds).filter((value) => value > 0)
  const autoFixes = happened.filter((event) => event.type === 'auto.fix').length
  const autoMerges = happened.filter((event) => event.type === 'auto.merge' && event.ok === true).length
  return {
    done: done.length,
    merged: done.filter((plan) => plan.mergedAt !== null).length,
    doneOnly: done.filter((plan) => plan.mergedAt === null).length,
    noStart: done.filter((plan) => plan.leadMs === null).length,
    followUps: done.filter((plan) => plan.followUp).length,
    lead: spread(done.map((plan) => plan.leadMs).filter((value) => value !== null)),
    mergeToDone: spread(done.map((plan) => plan.mergeToDoneMs).filter((value) => value !== null)),
    handoffToMerge: spread(happened.filter((event) => event.type === 'auto.merge' && event.ok === true && typeof event.handoffMs === 'number').map((event) => event.handoffMs)),
    stages,
    reviewRounds: average(rounds),
    reviewRoundsKnown: rounds.length,
    autoFixes,
    autoMerges,
    fixRate: ratio(autoFixes, autoMerges),
    reverts: null,
    asksPerDone: done.length ? average(done.map((plan) => plan.asks)) : null,
    asks,
    waitMs: average(waits),
    verifyRuns: verify.length,
    verifyPasses: verify.filter((event) => event.ok === true).length,
    verifyFails: verify.filter((event) => event.ok === false).length,
    verifyFailRate: ratio(verify.filter((event) => event.ok === false).length, verify.length),
    reviewRuns: reviews.length,
    reviewRejectRate: ratio(reviews.filter((event) => event.verdict === '수정 필요').length, reviews.length),
  }
}

export const summarize = (events, { now = Date.now(), days = null, since = null, review = null } = {}) => {
  const valid = events.filter((event) => event && event.type && time(event))
  const plans = groupByPlan(valid)
  const firstAt = valid.length ? Math.min(...valid.map(time)) : null
  const from = since ?? (days ? now - days * DAY : -Infinity)
  const span = from === -Infinity ? null : Math.max(0, now - from)
  const picked = review === 'with' || review === 'without'
    ? new Set(plans.filter((plan) => plan.reviewed === (review === 'with')).map((plan) => plan.plan))
    : null
  return {
    until: new Date(now).toISOString(),
    days: since === null ? days : null,
    from: from === -Infinity ? null : new Date(from).toISOString(),
    review: picked ? review : null,
    since: firstAt === null ? null : new Date(firstAt).toISOString(),
    events: valid.length,
    current: windowTotals(valid, plans, from, Infinity, picked),
    previous: span ? windowTotals(valid, plans, from - span, from, picked) : null,
    // 선 그래프의 이전 기간 비교에 필요한 완료 시각만 보낸다(원문·전체 계획서 중복 없음).
    previousCompleted: span ? plans.filter((plan) => plan.endAt !== null && plan.endAt >= from - span && plan.endAt < from && (picked === null || picked.has(plan.plan))).map((plan) => plan.endAt) : null,
    // 이 기간에 무슨 일이든 있었던 계획서 — 최근에 움직인 것부터
    plans: plans.filter((plan) => plan.lastAt !== null && plan.lastAt >= from && (picked === null || picked.has(plan.plan))).sort((left, right) => right.lastAt - left.lastAt),
  }
}

// 지표 기간 인자 — 현황판 · 명령이 같이 쓴다. 'YYYY-MM-DD' 는 이 컴퓨터 시간대의 그날 0시 · 형식이 틀리거나 없는 날짜면 null
export const parseSinceDate = (text) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.getMonth() === Number(match[2]) - 1 ? date.getTime() : null
}

export const formatDuration = (ms) => {
  if (ms === null || ms === undefined) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`
  if (ms < HOUR) return `${Math.round(ms / 60_000)}분`
  if (ms < 2 * DAY) return `${(ms / HOUR).toFixed(1)}시간`
  return `${(ms / DAY).toFixed(1)}일`
}
export const formatRate = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`)
