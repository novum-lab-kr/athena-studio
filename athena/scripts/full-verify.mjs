#!/usr/bin/env node
// @ts-check
/**
 * 재사용 없는 전체 검증 — 머지를 막지 않는다 · 진짜 실패면 high 이슈 하나(판정 scripts/lib/full-verify.mjs · docs/pr-auto.md "머지 뒤 전체 검증")
 *
 *   node scripts/full-verify.mjs --shadow --repo <레포> --sha <커밋> [--pr <번호>] [--plan plans/…md]
 *       그림자 — pr-auto.mjs 가 PR 을 머지한 뒤 띄운다. 머지 전 검증(닿는 시험만)을 통과한 같은 커밋을 전체로 다시(SHADOW_SINCE 부터 1주 · "shadowVerify")
 *   node scripts/full-verify.mjs --daily [--repo <레포>] [--force]
 *       하루 한 번 — 현황판이 한 시간마다 띄운다. 자동 PR 레포(Actions 로 넘기는 레포 빼고)의 prBase 끝을 오늘 아직 안 돌렸으면("dailyVerify": false 면 끔)
 *
 * 레포 커밋을 상태 폴더의 따로 둔 워크트리(<상태>/full-verify/<레포>-<종류> · git worktree add --detach)에 꺼내 돌린다 —
 * PR 워크트리는 머지 뒤 정리되고 · 사용자가 고치는 중일 수 있어서. 검증은 reuse.sh 를 거치지 않고 scripts/verify/<레포>.sh 를 바로(재사용 없음)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ATHENA_ROOT, loadConfig, paths } from './lib/config.mjs'
import { logEvent } from './lib/events.mjs'
import { maskSecrets } from './lib/mask.mjs'
import { autoMergeRepos, prBaseOf } from './lib/pr-auto.mjs'
import { handoffOn } from './lib/handoff.mjs'
import { dailyDue, failIssue, failIssueName, seoulDate, shadowOn, verifyOutcome } from './lib/full-verify.mjs'

const ROOT = ATHENA_ROOT
const args = process.argv.slice(2)
const valueOf = (/** @type {string} */ name) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : '')
const where = paths(ROOT)
const STATE_DIR = join(where.state, 'full-verify')
const DAILY_FILE = join(STATE_DIR, 'daily.json')
const TAIL_LINES = 60

/** @param {string} dir @param {string[]} gitArgs */
const git = (dir, gitArgs) => {
  const run = spawnSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8' })
  return { ok: run.status === 0, out: (run.stdout ?? '').trim(), err: (run.stderr ?? '').trim() }
}
const isAlive = (/** @type {number} */ pid) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM' }
}
// 같은 레포 · 종류는 한 번에 하나 — 한 시간마다 띄우는 하루 검증이 앞 실행과 겹치지 않게
const takeLock = (/** @type {string} */ name) => {
  const lock = join(STATE_DIR, `${name}.lock`)
  mkdirSync(STATE_DIR, { recursive: true })
  try { mkdirSync(lock) } catch {
    let owner = 0
    try { owner = Number(readFileSync(join(lock, 'pid'), 'utf8')) || 0 } catch { /* 막 만들어지는 중 */ }
    if (isAlive(owner)) return null
    rmSync(lock, { recursive: true, force: true })
    try { mkdirSync(lock) } catch { return null }
  }
  writeFileSync(join(lock, 'pid'), String(process.pid))
  return () => rmSync(lock, { recursive: true, force: true })
}

// 따로 둔 워크트리를 그 커밋으로 — 있으면 그 자리에서 바꾸고(node_modules 를 남긴다) · 없으면 만든다
/** @param {string} repoDir @param {string} worktree @param {string} sha */
const checkout = (repoDir, worktree, sha) => {
  if (!git(repoDir, ['cat-file', '-e', `${sha}^{commit}`]).ok) git(repoDir, ['fetch', '--quiet', 'origin', sha])
  if (existsSync(join(worktree, '.git'))) {
    const moved = git(worktree, ['checkout', '--quiet', '--force', '--detach', sha])
    if (moved.ok) { git(worktree, ['clean', '-fdq']); return moved }
    rmSync(worktree, { recursive: true, force: true })
    git(repoDir, ['worktree', 'prune'])
  }
  return git(repoDir, ['worktree', 'add', '--quiet', '--detach', worktree, sha])
}

// 레포 준비 스크립트(new-branch.sh 와 같은 것 · 의존성 설치) — 없으면 건너뜀 · ATHENA_SKIP_WT_SETUP=1 이면 건너뜀(시험)
const setup = (/** @type {string} */ worktree) => {
  if (!existsSync(join(worktree, 'scripts/worktree-setup.sh')) || process.env.ATHENA_SKIP_WT_SETUP === '1') return true
  const run = spawnSync(join(ROOT, 'scripts/heavy.sh'), ['bash', 'scripts/worktree-setup.sh'], { cwd: worktree, stdio: 'ignore' })
  return run.status === 0
}

// 재사용 없는 엄격 전체 검증 — 계획서 · 위임 표시는 걷어 낸다(Validation 줄을 남의 계획서에 쓰지 않게)
const runVerify = (/** @type {string} */ repo, /** @type {string} */ worktree) => {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ATHENA_VERIFY_DIR: worktree, ATHENA_VERIFY_FULL: '1', ATHENA_VERIFY_NO_REUSE_CORE: '1', ATHENA_VERIFY_STRICT: '1' }
  for (const name of ['ATHENA_VERIFY_ALLOW_SKIP', 'ATHENA_PLAN', 'ATHENA_AGENT']) delete env[name]
  const script = join(ROOT, 'scripts/verify', `${repo}.sh`)
  const run = spawnSync('bash', ['-c', 'exec bash "$0" 2>&1', script], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 2 * 60 * 60 * 1000 })
  return { code: run.status, output: run.stdout ?? '' }
}

/**
 * 하나 돌리기 — 결과는 pass · fail(이슈) · unrun(실행 못 함 — 이슈 없이 사건만)
 * @param {{ kind: 'shadow' | 'daily', repo: string, sha: string, pr?: string, plan?: string }} target
 */
const runOne = ({ kind, repo, sha, pr = '', plan = '' }) => {
  const started = Date.now()
  const base = { kind, repo, sha: sha.slice(0, 7), ...(pr ? { pr: Number(pr) } : {}) }
  const finish = (/** @type {string} */ outcome, /** @type {Record<string, unknown>} */ extra = {}) => {
    logEvent(ROOT, 'verify.full', { ...base, outcome, ms: Date.now() - started, ...extra })
    console.log(`${outcome === 'pass' ? '✅' : outcome === 'fail' ? '❌' : '⚠️'} 전체 검증(${kind}) ${repo} @${sha.slice(0, 7)} — ${outcome}${extra.why ? ` · ${extra.why}` : ''}${extra.issue ? ` → ${extra.issue}` : ''}`)
    return outcome
  }
  const repoDir = join(ROOT, 'repos', repo)
  if (!existsSync(join(ROOT, 'scripts/verify', `${repo}.sh`))) return finish('unrun', { why: '검증 스크립트 없음' })
  if (!existsSync(repoDir)) return finish('unrun', { why: 'repos/ 에 레포 없음' })
  const release = takeLock(`${repo}-${kind}`)
  if (!release) return finish('unrun', { why: '앞 실행이 아직 도는 중' })
  try {
    const worktree = join(STATE_DIR, `${repo}-${kind}`)
    const placed = checkout(repoDir, worktree, sha)
    if (!placed.ok) return finish('unrun', { why: `워크트리를 못 만듦(${maskSecrets(placed.err.split('\n')[0] ?? '').masked.slice(0, 160)})` })
    if (!setup(worktree)) return finish('unrun', { why: '워크트리 준비 실패(scripts/worktree-setup.sh)' })
    const { code, output } = runVerify(repo, worktree)
    // 도는 사이 워크트리가 다른 커밋으로 바뀌었으면 결과를 믿지 않는다
    if (!git(worktree, ['rev-parse', 'HEAD']).out.startsWith(sha)) return finish('unrun', { why: '도는 사이 워크트리가 바뀜' })
    const outcome = verifyOutcome(code, output)
    if (outcome !== 'fail') return finish(outcome, outcome === 'unrun' ? { why: '엄격 모드 건너뜀' } : {})
    const date = seoulDate()
    const name = failIssueName({ kind, repo, sha, date })
    const file = join(where.issues, name)
    if (!existsSync(file)) {
      mkdirSync(where.issues, { recursive: true })
      const tail = maskSecrets(output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')).masked
      writeFileSync(file, failIssue({ kind, repo, sha, date, pr, plan, tail }))
    }
    return finish('fail', { issue: `issues/${name}` })
  } finally {
    release()
  }
}

let config
try { config = loadConfig(ROOT) } catch (error) {
  console.error(`⚠️ 설정을 못 읽음: ${/** @type {Error} */ (error).message}`)
  process.exit(1)
}

if (args.includes('--shadow')) {
  const repo = valueOf('--repo')
  const sha = valueOf('--sha')
  if (!repo || !/^[0-9a-f]{7,40}$/.test(sha)) {
    console.error('사용: full-verify.mjs --shadow --repo <레포> --sha <커밋> [--pr <번호>] [--plan <계획서>]')
    process.exit(1)
  }
  if (!shadowOn(config)) {
    console.log('그림자 전체 검증 꺼짐(기간 지남 · shadowVerify: false)')
    process.exit(0)
  }
  runOne({ kind: 'shadow', repo, sha, pr: valueOf('--pr'), plan: valueOf('--plan') })
} else if (args.includes('--daily')) {
  if (config.dailyVerify === false) {
    console.log('하루 한 번 전체 검증 꺼짐(dailyVerify: false)')
    process.exit(0)
  }
  const only = valueOf('--repo')
  const repos = [...autoMergeRepos(config)].filter((repo) => !handoffOn(config, repo) && (!only || repo === only))
  /** @type {Record<string, unknown>} */
  let state = {}
  try { state = JSON.parse(readFileSync(DAILY_FILE, 'utf8')) } catch { /* 처음 */ }
  for (const repo of repos) {
    if (!args.includes('--force') && !dailyDue(state, repo)) continue
    const branch = prBaseOf(config, repo)
    const repoDir = join(ROOT, 'repos', repo)
    if (!branch || !existsSync(repoDir)) continue
    git(repoDir, ['fetch', '--quiet', 'origin', branch])
    const sha = git(repoDir, ['rev-parse', `origin/${branch}`]).out
    if (!/^[0-9a-f]{40}$/.test(sha)) continue
    // 실행 못 함도 그날은 다시 돌지 않는다(한 시간마다 무거운 준비를 되풀이하지 않게) — 사건 verify.full outcome unrun 으로 남는다
    state = { ...state, [repo]: seoulDate() }
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(DAILY_FILE, JSON.stringify(state, null, 2))
    runOne({ kind: 'daily', repo, sha })
  }
} else {
  console.error('사용: full-verify.mjs --shadow --repo <레포> --sha <커밋> | --daily [--repo <레포>] [--force]')
  process.exit(1)
}
