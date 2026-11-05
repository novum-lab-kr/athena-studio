#!/usr/bin/env node
// @ts-check
/**
 * 계획서 '## 지시' 칸 검사 — 경고만 하고 막지 않는다(언제나 종료 0 · 인자가 틀렸을 때만 2). 기준은 scripts/lib/plan-check.mjs · 칸 형식은 docs/plan-template-light.md "지시 칸"
 *
 *   node scripts/plan-check.mjs --plan <plans/…md> [--agent <에이전트> | --repo <레포>] [--ship <올리는 방식>] [--dir <작업 트리>] [--orig <원본 파일>] [--log] [--json]
 *     --agent / --repo : 팩 레포 설정(prBase · direct · autoMerge · autoPr)과 레포 파일 목록으로 맞춰 본다(없으면 그 검사만 건너뜀)
 *     --ship  : delegate.sh 의 올리는 방식(handoff · pr-off · auto-pr · direct · manual) — 주면 레포 설정 대신 이것으로 받은 뒤 ship.sh 옵션을 본다
 *     --dir   : 적힌 경로를 찾을 트리(기본 repos/<레포>)
 *     --orig  : 줄이기 전 원본 — 주면 (←N) 대조를 한다
 *     --log   : 검사 결과를 사건 기록(plan.check)에 남긴다 — 지표 탭이 센다. 새 칸이 없어 건너뛴 계획서는 남기지 않는다
 *   출력: 경고가 있을 때만 "⚠ 지시 칸 경고 N개 …" + 한 줄씩. 새 칸이 없는 옛 계획서는 아무것도 찍지 않는다
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ATHENA_ROOT, loadConfig, repoOfAgent } from './lib/config.mjs'
import { logEvent } from './lib/events.mjs'
import { checkPlan, countKinds, listRepoFiles } from './lib/plan-check.mjs'

const argv = process.argv.slice(2)
const option = (/** @type {string} */ name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] ?? '' : ''
}
const flag = (/** @type {string} */ name) => argv.includes(`--${name}`)

const planArg = option('plan')
if (!planArg) {
  console.error('사용: node scripts/plan-check.mjs --plan <plans/…md> [--agent <에이전트> | --repo <레포>] [--ship <방식>] [--dir <트리>] [--orig <원본>] [--log] [--json]')
  process.exit(2)
}
const planFile = isAbsolute(planArg) ? planArg : join(ATHENA_ROOT, planArg)
if (!existsSync(planFile)) {
  console.error(`계획서가 없다: ${planArg}`)
  process.exit(2)
}
// 사건 기록 · 출력에는 본체 기준 논리 경로(plans/…)로 — 절대 경로로 받았으면 본체 아래일 때만 줄인다
const planRel = planFile.startsWith(`${ATHENA_ROOT}/`) ? planFile.slice(ATHENA_ROOT.length + 1) : planArg

/** @type {{ repos: Array<Record<string, unknown>>, packDir?: string } | null} */
let config = null
try { config = loadConfig(ATHENA_ROOT) } catch { /* 팩이 없으면 레포 설정 검사만 건너뛴다 */ }
const agent = option('agent')
const repoName = option('repo') || (config && agent ? String(repoOfAgent(config, agent)?.name ?? '') : '')
const repo = config?.repos.find((entry) => entry.name === repoName) ?? null
const dir = option('dir') ? resolve(option('dir')) : (repoName ? join(ATHENA_ROOT, 'repos', repoName) : '')
const origFile = option('orig')

const result = checkPlan(readFileSync(planFile, 'utf8'), {
  repo,
  ship: option('ship') || undefined,
  roots: [ATHENA_ROOT, ...(config?.packDir ? [config.packDir] : [])],
  repoFiles: dir && existsSync(dir) ? listRepoFiles(dir) : null,
  orig: origFile ? readFileSync(origFile, 'utf8') : null,
})

if (result.checked && flag('log')) {
  logEvent(ATHENA_ROOT, 'plan.check', { plan: planRel, agent: agent || null, repo: repoName || null, warnings: result.warnings.length, kinds: countKinds(result.warnings) })
}
if (flag('json')) {
  console.log(JSON.stringify({ plan: planRel, ...result }))
} else if (result.warnings.length) {
  console.log(`⚠ 지시 칸 경고 ${result.warnings.length}개 — ${planRel} (경고만 · 띄우기는 그대로 · 줄 번호는 '## 지시' 다음 줄이 1)`)
  for (const warning of result.warnings) console.log(`  - ${warning.line ? `${warning.line}줄 ` : ''}${warning.message} [${warning.kind}]`)
}
