// @ts-check
// 재사용 없는 전체 검증 — 그림자(머지 뒤 · 1주) · 하루 한 번(2026-11-08 #267 — 머지 전 검증을 닿는 시험만으로 줄인 대신 놓친 시험을 뒤에서 잡는다).
// scripts/full-verify.mjs 가 돌리고 pr-auto.mjs(그림자 띄우기) · 현황판(하루 한 번 띄우기)이 같이 쓴다. 머지를 막지 않는다 — 실패하면 high 이슈 하나

const DAY_MS = 24 * 60 * 60 * 1000
// 그림자 검증 시작 날짜와 기간 — 기간이 지나면 저절로 꺼진다. athena.config.json "shadowVerify": false 면 바로 끔 · true 면 기간 뒤에도 켬
export const SHADOW_SINCE = '2026-11-08'
export const SHADOW_DAYS = 7
/** @param {{ shadowVerify?: unknown } | null | undefined} config */
export const shadowOn = (config, now = Date.now()) => {
  if (config?.shadowVerify === false) return false
  if (config?.shadowVerify === true) return true
  const since = Date.parse(`${SHADOW_SINCE}T00:00:00+09:00`)
  return now >= since && now < since + SHADOW_DAYS * DAY_MS
}

// 하루 한 번 — 마지막으로 돈 날(서울 날짜)이 오늘이 아니면 돈다
export const seoulDate = (now = Date.now()) => new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10)
/** @param {Record<string, unknown>} state @param {string} repo */
export const dailyDue = (state, repo, now = Date.now()) => state?.[repo] !== seoulDate(now)

// 검증 출력 판정 — 진짜 실패(❌ 단계)가 있으면 fail · 엄격 모드 건너뜀만으로 실패했으면 unrun(실행 못 함 — 통과도 실패도 아니다 · 이슈를 만들지 않는다)
/** @param {number | null} code @param {string} output */
export const verifyOutcome = (code, output) => {
  if (code === 0) return 'pass'
  const failed = String(output).split('\n').filter((line) => line.includes('❌') && !line.includes('❌ 건너뜀(엄격 모드)'))
  return failed.length ? 'fail' : 'unrun'
}

export const KIND_LABEL = { shadow: '그림자(머지 뒤)', daily: '하루 한 번' }
/** @param {{ kind: 'shadow' | 'daily', repo: string, sha: string, date: string }} target */
export const failIssueName = ({ kind, repo, sha, date }) => `${date.replaceAll('-', '')}-${repo}-전체-검증-실패-${kind}-${String(sha).slice(0, 7)}.md`
/**
 * 실패 이슈 본문 — severity high(docs/issues.md "바로 등록")
 * @param {{ kind: 'shadow' | 'daily', repo: string, sha: string, date: string, pr?: string, plan?: string, scoped?: string, tail: string }} target
 */
export const failIssue = ({ kind, repo, sha, date, pr = '', plan = '', scoped = '', tail }) => `---
title: ${repo} 전체 검증 실패(${KIND_LABEL[kind]}) @${String(sha).slice(0, 7)}
status: open
repo: ${repo}
kind: code
severity: high
source: ${KIND_LABEL[kind]} 전체 검증 ${date}${plan ? ` · ${plan}` : ''}
plan:
pr: ${pr}
---

${kind === 'shadow'
    ? `머지 전 검증(${scoped || '골라 돌림'})은 통과였는데 같은 커밋을 재사용 없이 전체로 돌리니 실패했다 — 시험 고르기(athena/scripts/verify/scope-tests.mjs)가 놓친 시험이 있거나 머지된 코드에 문제가 있다.`
    : `기준 브랜치 @${String(sha).slice(0, 7)} 을 재사용 없이 전체로 검증하니 실패했다 — 머지 전 검증이 놓친 것이 들어갔다.`}

## 근거
- 커밋 ${sha} · ${KIND_LABEL[kind]} 전체 검증(ATHENA_VERIFY_FULL=1 · 코어 시험 재사용 끔 · 엄격)

\`\`\`
${tail}
\`\`\`

## 할 일
- 실패 원인을 고친다${kind === 'shadow' ? ' · 놓친 시험이면 scope-tests.mjs 의 고르기 규칙도 고친다' : ''}
`
