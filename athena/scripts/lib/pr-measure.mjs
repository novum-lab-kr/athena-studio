// @ts-check
// PR 자동 리뷰 측정(2026-11-08 #267 — 46분) — 사건 기록(docs/events.md)을 PR 마다 묶는다. scripts/pr-measure.mjs · pr-auto.mjs --no-merge 가 같이 쓴다.
// 새 사건을 만들지 않고 이미 있는 것만 읽는다 — pr.open(시작) · review(by auto — 횟수 · ms · tokens) · verify(같은 레포 · 브랜치 — 횟수 · scope · ms) · auto.merge(ok — mergedAt)
// 그래서 이 측정 전에 머지된 PR(#267 등)도 같은 칸으로 비교된다(tokens 는 그때 기록이 없어 모름)

/** @typedef {Record<string, unknown>} Event */

const text = (/** @type {unknown} */ value) => (value === undefined || value === null ? '' : String(value))
const timeOf = (/** @type {unknown} */ value) => {
  const at = Date.parse(text(value))
  return Number.isFinite(at) ? at : null
}
const samePr = (/** @type {Event} */ event, /** @type {string} */ repo, /** @type {string} */ pr) => text(event.repo) === repo && text(event.pr) === pr

/**
 * PR 하나의 측정값
 * @param {Event[]} events
 * @param {{ repo: string, pr: string | number, now?: number, mergedAt?: string | null }} target — mergedAt: 사건에 머지가 없을 때(사람 · 아테나가 직접 머지) GitHub 의 머지 시각
 */
export const measurePr = (events, { repo, pr, now = Date.now(), mergedAt = null }) => {
  const number = text(pr)
  const mine = events.filter((event) => samePr(event, repo, number))
  const opened = mine.find((event) => event.type === 'pr.open') ?? null
  const merged = mine.find((event) => event.type === 'auto.merge' && event.ok === true) ?? null
  const reviews = mine.filter((event) => event.type === 'review' && event.by === 'auto')
  const start = timeOf(opened?.at) ?? timeOf(reviews[0]?.at)
  const end = timeOf(merged?.mergedAt) ?? timeOf(merged?.at) ?? timeOf(mergedAt)
  // 검증 사건에는 PR 번호가 없다 — 이 PR 의 자동 리뷰 · 수정 사건에 적힌 브랜치로 잇고, 시작 ~ 머지(없으면 지금) 사이만
  const branches = new Set(mine.map((event) => text(event.branch)).filter(Boolean))
  const verifies = events.filter((event) => {
    if (event.type !== 'verify' || text(event.repo) !== repo || !branches.has(text(event.branch))) return false
    const at = timeOf(event.at)
    return at !== null && (start === null || at >= start) && at <= (end ?? now)
  })
  const knownTokens = reviews.map((event) => event.tokens).filter((value) => typeof value === 'number' && Number.isFinite(value))
  const scopes = verifies.map((event) => text(event.scope) || '모름')
  return {
    repo,
    pr: number,
    plan: text(opened?.plan ?? reviews[0]?.plan) || null,
    merged: Boolean(merged) || timeOf(mergedAt) !== null,
    // push(PR 생성) → 머지 · 머지 전이면 지금까지 · 시작 기록이 없으면 모름
    elapsedMs: start === null ? null : (end ?? now) - start,
    reviews: reviews.length,
    reviewMs: reviews.reduce((/** @type {number} */ sum, event) => sum + (typeof event.ms === 'number' ? event.ms : 0), 0),
    tokens: knownTokens.length ? knownTokens.reduce((/** @type {number} */ sum, value) => sum + Number(value), 0) : null,
    verifies: verifies.length,
    verifyMs: verifies.reduce((/** @type {number} */ sum, event) => sum + (typeof event.ms === 'number' ? event.ms : 0), 0),
    scopes,
    fast: mine.some((event) => event.fast === true),
  }
}

/**
 * 기간 안에 자동 리뷰나 PR 생성이 있었던 PR 모두(최근 것부터)
 * @param {Event[]} events
 * @param {{ since?: number | null, now?: number }} [options]
 */
export const measurePrs = (events, { since = null, now = Date.now() } = {}) => {
  /** @type {Map<string, { repo: string, pr: string, last: number }>} */
  const seen = new Map()
  for (const event of events) {
    if (!['pr.open', 'review', 'auto.merge'].includes(text(event.type)) || !event.pr || !event.repo) continue
    if (event.type === 'review' && event.by !== 'auto') continue
    const at = timeOf(event.at) ?? 0
    if (since !== null && at < since) continue
    const key = `${text(event.repo)}#${text(event.pr)}`
    const before = seen.get(key)
    seen.set(key, { repo: text(event.repo), pr: text(event.pr), last: Math.max(before?.last ?? 0, at) })
  }
  return [...seen.values()].sort((left, right) => right.last - left.last).map((item) => measurePr(events, { ...item, now }))
}

const minutes = (/** @type {number | null} */ ms) => (ms === null ? '모름' : `${Math.round(ms / 6000) / 10}분`)
/** 한 줄 — `web#7 · 12.3분(머지) · 리뷰 2번 · 검증 1번(scoped) · 토큰 12345` */
export const measureLine = (/** @type {ReturnType<typeof measurePr>} */ row) => [
  `${row.repo}#${row.pr}`,
  `${minutes(row.elapsedMs)}(${row.merged ? '머지' : '머지 전'})`,
  `리뷰 ${row.reviews}번`,
  `검증 ${row.verifies}번${row.scopes.length ? `(${row.scopes.join(',')})` : ''}`,
  `토큰 ${row.tokens ?? '모름'}`,
].join(' · ')
