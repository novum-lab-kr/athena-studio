#!/usr/bin/env node
// @ts-check
/**
 * PR 자동 리뷰 측정 — PR 마다 push(PR 생성) → 머지 시간 · 리뷰 횟수 · 검증 횟수 · scope · 리뷰 토큰을 한 줄로(계산 scripts/lib/pr-measure.mjs · 사건 docs/events.md)
 *
 *   node scripts/pr-measure.mjs                    # 최근 7일
 *   node scripts/pr-measure.mjs --days 30          # --all 전체
 *   node scripts/pr-measure.mjs --pr athena-studio#267   # PR 하나(비교할 때 여러 번 줘도 된다)
 *   node scripts/pr-measure.mjs --json
 */
import { spawnSync } from 'node:child_process'
import { ATHENA_ROOT, githubOrg, loadConfig } from './lib/config.mjs'
import { readEvents } from './lib/events.mjs'
import { measureLine, measurePr, measurePrs } from './lib/pr-measure.mjs'

const args = process.argv.slice(2)
const valueOf = (/** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : null)
const targets = args.flatMap((arg, index) => (arg === '--pr' ? [args[index + 1] ?? ''] : []))
const events = readEvents(ATHENA_ROOT)

// 사건에 머지가 없으면(아테나 · 사람이 직접 머지 — #267) GitHub 의 머지 시각으로 — --pr 로 고른 PR 만 묻는다(목록은 gh 를 부르지 않는다)
const githubMergedAt = (/** @type {string} */ repo, /** @type {string} */ pr) => {
  let org = ''
  try { org = githubOrg(loadConfig(ATHENA_ROOT)) } catch { return null }
  if (!org) return null
  const run = spawnSync('gh', ['pr', 'view', pr, '--repo', `${org}/${repo}`, '--json', 'mergedAt', '-q', '.mergedAt'], { encoding: 'utf8', timeout: 30_000 })
  return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : null
}

let rows
if (targets.length) {
  rows = targets.map((target) => {
    const match = /^([^#\s]+)#(\d+)$/.exec(target)
    if (!match) {
      console.error(`--pr 는 <레포>#<번호> 로 적어 주세요: ${target}`)
      process.exit(1)
    }
    const repo = match[1] ?? ''
    const pr = match[2] ?? ''
    const row = measurePr(events, { repo, pr })
    return row.merged ? row : measurePr(events, { repo, pr, mergedAt: githubMergedAt(repo, pr) })
  })
} else {
  const days = args.includes('--all') ? null : Number(valueOf('--days') ?? 7) || 7
  rows = measurePrs(events, { since: days === null ? null : Date.now() - days * 24 * 60 * 60 * 1000 })
}

if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2))
else if (!rows.length) console.log('기록 없음 (docs/events.md)')
else for (const row of rows) console.log(measureLine(row))
