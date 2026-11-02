#!/usr/bin/env node
// @ts-check
/**
 * git 없는 프로젝트의 뒷일 — 맥에서 전체 검증 → 완료 표시(결정 D4). git 레포는 받지 않는다(commit.sh · ship.sh 몫).
 *
 *   node scripts/local-finish.mjs --plan <계획서> --dir <폴더> [--repo <이름>]
 *
 * 부르면 뒤에서 돌도록 띄우고 바로 끝난다 — 에이전트는 기다리지 않고 다음 일을 받는다.
 * 통과: Status 를 done 으로(단계 칸이 남았거나 blocked 면 그대로 두고 pane 에 알린다)
 * 실패: Status 는 그대로 · 실패 원문(비밀값 가림)을 부른 pane 으로, 그 pane 이 없으면 Lead pane 으로
 * 검증 스크립트는 scripts/verify/<이름>.sh, 없으면 _generic.sh · 엄격 모드라 건너뛴 단계는 실패다(아무것도 안 돌고 완료되지 않게)
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkpointOf, hasOpenSteps, progressOf } from './board/plan-bind.mjs'
import { paths } from './lib/config.mjs'
import { isMainModule } from './lib/is-main.mjs'
import { maskText } from './lib/mask.mjs'
import { updatePlan } from './lib/plan-update.mjs'
import { callerPane, SCREEN } from './lib/screen.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_LINES = 40
const LOG_CHARS = 3000

const stateDir = () => {
  const where = paths(ROOT)
  return where.mode === 'packs' ? join(where.state, 'local-finish') : join(ROOT, '.local-finish')
}
const stamp = () => new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
/** @param {string} dir */
const insideGit = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }).status === 0
/** @param {number} pid */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'
  }
}

/** 계획서 인자 → 논리 경로(plans/…md). 검증 스크립트의 Validation 기록이 이 모양만 받는다.
 * plans 가 링크일 수 있어(팩 데이터) 경로를 글자로 견주지 않고, 이 본체의 같은 파일인지 파일 번호로 본다 @param {string} plan */
export const logicalPlan = (plan, root = ROOT) => {
  const start = isAbsolute(plan) ? plan.lastIndexOf('/plans/') + 1 : 0
  const rel = plan.slice(start)
  if (!/^plans\/.+\.md$/.test(rel)) return ''
  try {
    return statSync(join(root, rel)).ino === statSync(isAbsolute(plan) ? plan : join(root, rel)).ino ? rel : ''
  } catch {
    return ''
  }
}

/** Progress 절 — 현황판과 같은 기준으로 단계 칸을 센다 @param {string} text */
const progressSection = (text) => checkpointOf(text).split(/^### Progress\s*$/m)[1]?.split(/^### /m)[0] ?? ''

/** 완료로 바꿔도 되는지 — 안 되면 이유 글 @param {string} text */
export const holdReason = (text) => {
  const status = text.match(/^- Status:\s*(\S+)/m)?.[1] ?? ''
  if (!status) return '계획서 Checkpoint 에 Status 줄이 없음'
  if (status === 'blocked') return 'Status 가 blocked'
  if (hasOpenSteps(progressOf(progressSection(text)))) return 'Progress 에 안 끝난 단계 칸이 남음'
  return ''
}

/** Status 를 done 으로 · 왜 끝났는지 뒤에 적는다 — 현황판 setPlanStatus 와 같은 줄 모양 @param {string} text @param {string} repo */
export const withDoneStatus = (text, repo) => text
  .replace(/^- Status:.*$/m, `- Status: done — 자동 — ${repo} 맥 전체 검증 통과(git 없는 프로젝트)`)
  .replace(/^- Updated:.*$/m, `- Updated: ${stamp()} / 맥 실행기(local-finish)`)

/** 검증 출력에서 pane 으로 보낼 끝부분 — 비밀값 가림 · 한 줄 @param {string} raw */
export const failureText = (raw) => maskText(String(raw).trim().split('\n').slice(-LOG_LINES).join(' | ')).slice(-LOG_CHARS)

/** @param {string[]} panes @param {string} text */
const notify = (panes, text) => {
  for (const pane of panes.filter(Boolean)) {
    const sent = spawnSync(SCREEN, ['pane', 'send-text', pane, text, '--enter'], { stdio: 'ignore', timeout: 30000 })
    if (sent.status === 0) return true
  }
  return false
}

/** @param {{ plan: string, dir: string, repo: string, pane: string, marker: string }} job */
const run = ({ plan, dir, repo, pane, marker }) => {
  const planPath = join(ROOT, plan)
  const own = join(ROOT, 'scripts', 'verify', `${repo}.sh`)
  const hasOwn = existsSync(own)
  const result = spawnSync(hasOwn ? own : join(ROOT, 'scripts', 'verify', '_generic.sh'), hasOwn ? [] : [repo], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ATHENA_VERIFY_DIR: dir, ATHENA_VERIFY_GITLESS: '1', ATHENA_VERIFY_STRICT: '1', ATHENA_PLAN: plan },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)
  try {
    const planText = existsSync(planPath) ? readFileSync(planPath, 'utf8') : ''
    const lead = planText.match(/^- Lead pane:\s*(\S+)/m)?.[1] ?? ''
    const head = `[맥 실행기 → ${pane || lead || '작업 pane'}] ${repo} (${dir})`
    if (result.status !== 0) {
      const sent = notify([pane, lead], `${head} 전체 검증 실패 — 계획서 ${plan}. 고친 뒤 다시 local-finish 를 부른다. 원문: ${failureText(output)}`)
      console.log(`❌ 검증 실패 — Status 는 그대로${sent ? '' : ' · pane 에 전하지 못함'}`)
      return 1
    }
    // 잠금 안에서 지금 내용으로 다시 판단한다 — 검증하는 동안 계획서가 바뀌었을 수 있다
    let held = ''
    updatePlan(planPath, (/** @type {string} */ text) => {
      held = holdReason(text)
      return held ? null : withDoneStatus(text, repo)
    })
    if (held) {
      notify([pane, lead], `${head} 전체 검증은 통과했지만 완료로 바꾸지 않았다 — ${held}. 계획서 ${plan}`)
      console.log(`⏸ 완료 표시 보류 — ${held}`)
      return 0
    }
    console.log(`✅ 완료 표시 — ${plan}`)
    return 0
  } finally {
    // 표시가 사라지면 관찰자는 완료로 본다 — 계획서 갱신·알림·출력을 마친 뒤 지운다.
    rmSync(marker, { force: true })
  }
}

/** @param {{ plan: string, dir: string, repo: string }} job */
const start = ({ plan, dir, repo }) => {
  const logical = logicalPlan(plan)
  if (!logical) return `계획서를 찾지 못했다(이 본체의 plans/…md 만): ${plan}`
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return `폴더가 없다: ${dir}`
  const folder = resolve(dir)
  if (insideGit(folder)) return `git 레포다 — 이 실행기는 git 없는 폴더만 받는다. commit.sh · ship.sh 를 쓴다: ${folder}`
  const name = repo || basename(folder)
  if (!/^[\w.-]+$/.test(name)) return `레포 이름이 올바르지 않다: ${name}`
  const home = stateDir()
  mkdirSync(home, { recursive: true })
  const key = `${name}-${basename(logical, '.md')}`.replace(/[^\w.가-힣-]/g, '_')
  const marker = join(home, `${key}.pid`)
  // 같은 일이 이미 돌면 또 띄우지 않는다 — 앞선 결과가 고친 뒤의 상태를 덮으면 안 된다
  if (existsSync(marker) && isAlive(Number(readFileSync(marker, 'utf8')))) return `이미 도는 중이다 — 끝나면 다시 부른다(기록 ${join(home, `${key}.log`)})`
  const logPath = join(home, `${key}.log`)
  const logFd = openSync(logPath, 'w')
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '--run', '--plan', logical, '--dir', folder, '--repo', name, '--pane', callerPane({ stdio: ['ignore', 'pipe', 'ignore'] }), '--marker', marker,
  ], { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd] })
  closeSync(logFd)
  writeFileSync(marker, String(child.pid))
  child.unref()
  console.log(`🚀 맥 실행기로 넘겼다 — ${name} 전체 검증 → 완료 표시. 기다리지 않아도 된다(실패만 pane 으로 온다 · 기록 ${logPath})`)
  return ''
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (/** @type {string} */ name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] ?? '' : ''
  }
  const options = { plan: value('--plan'), dir: value('--dir'), repo: value('--repo') }
  if (args.includes('--run')) {
    process.exit(run({ ...options, pane: value('--pane'), marker: value('--marker') }))
  }
  if (!options.plan || !options.dir) {
    console.error('사용: local-finish.mjs --plan <계획서> --dir <폴더> [--repo <이름>]')
    process.exit(2)
  }
  const error = start(options)
  if (error) {
    console.error(`❌ ${error}`)
    process.exit(1)
  }
}
