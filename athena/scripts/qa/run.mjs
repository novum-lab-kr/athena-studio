#!/usr/bin/env node
// @ts-check
/**
 * QA 실행기 — 레포 docs/flows/ 의 TC 를 층별로 돌려 .qa-runs/<id>/run.json 에 남긴다(현황판 QA 탭이 읽는다).
 * FE = Playwright · BE = HTTP 요청, 둘 다 로컬에 띄운 서버에 대고(결정 D6). 앱은 체크리스트 문서라 돌리지 않는다.
 * 형식 정본: docs/knowledge/common/qa-flows.md
 *
 *   scripts/heavy.sh node scripts/qa/run.mjs --service <이름>[,<이름>] | --all
 *       [--layer fe|be] [--flow <흐름>]
 *       [--cwd <작업 트리>]     기본은 운영 기준 ref 를 받아 둔 .worktrees/<레포>/qa-base. 머지 전 브랜치를 볼 때
 *       [--reuse-server]       qa.json url 에 이미 떠 있는 서버를 그대로 쓴다(내가 띄운 서버일 때만)
 *       [--if-tc]              TC 가 없는 서비스는 조용히 건너뛴다(싱크 뒤 자동 실행)
 * 끝 코드: 0 모두 통과 · 1 실패나 오류가 있음 · 2 사용법
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSwitching, loadConfig } from '../lib/config.mjs'
import { maskText } from '../lib/mask.mjs'
import { errorText, runBeCase, runFeCase } from './cases.mjs'
import { checkLayerSettings, checkTc, FLOWS_DIR, flowsOfFiles, listFlowFiles, listServices, listTreeFiles, RUN_LAYERS } from './flows.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUNS_DIR = join(ROOT, '.qa-runs')
const KEEP_RUNS = 30
const READY_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 600_000
const STAMP_FILE = '.qa-installed'

const argv = process.argv.slice(2)
const flag = (/** @type {string} */ name) => argv.includes(`--${name}`)
const option = (/** @type {string} */ name) => { const at = argv.indexOf(`--${name}`); return at < 0 ? '' : argv[at + 1] ?? '' }

/** @type {any} */
let run = null
/** @type {(() => Promise<void>) | null} */
let stopCurrentServer = null

const saveRun = () => {
  const file = join(RUNS_DIR, run.id, 'run.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2))
  renameSync(`${file}.tmp`, file)
}

// 오래된 실행 기록은 지운다 — 흐름마다 마지막 결과만 쓰니 쌓아 둘 까닭이 없다
const pruneRuns = () => {
  const names = readdirSync(RUNS_DIR).filter((name) => existsSync(join(RUNS_DIR, name, 'run.json'))).sort().reverse()
  for (const name of names.slice(KEEP_RUNS)) rmSync(join(RUNS_DIR, name), { recursive: true, force: true })
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

// 운영 기준 ref 를 그대로 받아 둔 작업 트리 — 메인 체크아웃은 건드리지 않는다
/** @param {import('./flows.mjs').Service} service */
function baseTree(service) {
  const repoDir = join(ROOT, 'repos', service.repo)
  const tree = join(ROOT, '.worktrees', service.repo, 'qa-base')
  const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
  git(repoDir, ['fetch', '--quiet', 'origin', service.branch])
  const ref = `origin/${service.branch}`
  if (existsSync(join(tree, '.git'))) {
    git(tree, ['checkout', '--quiet', '--detach', '--force', ref])
    return tree
  }
  mkdirSync(dirname(tree), { recursive: true })
  git(repoDir, ['worktree', 'add', '--quiet', '--detach', tree, ref])
  execFileSync(join(ROOT, 'scripts', 'wt-copy-local.sh'), [repoDir, tree], { stdio: 'ignore' })
  return tree
}

// 기준 트리가 이 커밋으로 설치된 적이 없으면 install 을 돌린다(--cwd 는 그 트리 주인이 설치해 둔다)
/** @param {string} tree @param {string} workDir @param {string} commit @param {string | undefined} install */
function installIfNeeded(tree, workDir, commit, install) {
  if (!install) return
  const file = join(tree, STAMP_FILE)
  if (existsSync(file) && readFileSync(file, 'utf8').trim() === commit) return
  const done = spawnSync('/bin/sh', ['-c', install], { cwd: workDir, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS })
  if (done.status !== 0) throw new Error(`install 실패(${install}):\n${maskText(`${done.stdout}${done.stderr}`).slice(-1500)}`)
  writeFileSync(file, `${commit}\n`)
}

/** @param {string} url */
const answers = async (url) => {
  try { await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) }); return true } catch { return false }
}

/**
 * qa.json 대로 서버를 띄운다 — 프로세스 묶음째 끌 수 있게. 돌려주는 함수가 끄기
 * @param {any} settings @param {string} workDir @param {string} logFile
 */
async function startServer(settings, workDir, logFile) {
  const readyUrl = new URL(settings.ready ?? '/', settings.url).href
  if (await answers(readyUrl)) {
    if (flag('reuse-server')) return async () => {}
    throw new Error(`${settings.url} 에 이미 서버가 떠 있어요 — 다른 코드일 수 있어 돌리지 않아요(그 서버를 끄거나, 내가 띄운 서버면 --reuse-server)`)
  }
  const log = openSync(logFile, 'a')
  const child = spawn('/bin/sh', ['-c', settings.start], { cwd: workDir, detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...settings.env } })
  closeSync(log)
  let exited = child.exitCode !== null
  child.on('exit', () => { exited = true })
  const stop = async () => {
    if (exited || !child.pid) return
    try { process.kill(-child.pid, 'SIGTERM') } catch { return }
    for (let tries = 0; tries < 30 && !exited; tries += 1) await new Promise((done) => setTimeout(done, 100))
    if (!exited) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* 이미 꺼졌다 */ } }
  }
  const deadline = Date.now() + (settings.readyTimeoutSec ? settings.readyTimeoutSec * 1000 : READY_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (await answers(readyUrl)) return stop
    if (exited) throw new Error(`서버가 바로 꺼졌어요(${settings.start}):\n${maskText(readFileSync(logFile, 'utf8')).slice(-1500)}`)
    await new Promise((done) => setTimeout(done, 500))
  }
  await stop()
  throw new Error(`서버가 시간 안에 뜨지 않았어요(${readyUrl}):\n${maskText(readFileSync(logFile, 'utf8')).slice(-1500)}`)
}

/** Playwright 를 코어 쪽 설치에서 불러 브라우저를 켠다 */
async function openBrowser() {
  const installed = join(ROOT, 'scripts', 'qa', 'node_modules', 'playwright', 'index.mjs')
  if (!existsSync(installed)) throw new Error('Playwright 가 없어요 — scripts/setup.sh 를 한 번 돌려 주세요')
  const { chromium } = await import(installed)
  return chromium.launch()
}

/**
 * 흐름 하나
 * @param {any} entry 결과 칸 @param {any} tc @param {string} layer @param {string} baseUrl @param {any} browser
 */
async function runFlow(entry, tc, layer, baseUrl, browser) {
  for (const item of tc.cases) {
    /** @type {any} */
    const outcome = { id: item.id, branch: item.branch, title: item.title ?? '', status: 'running', error: '' }
    entry.cases.push(outcome)
    saveRun()
    const started = Date.now()
    if (item.manual) Object.assign(outcome, { status: 'manual', error: String(item.manual) })
    else Object.assign(outcome, await (layer === 'fe' ? runFeCase(item, browser, baseUrl) : runBeCase(item, baseUrl)))
    outcome.ms = Date.now() - started
    console.log(`  ${{ pass: '✅', fail: '❌', manual: '✋' }[/** @type {'pass'} */ (outcome.status)] ?? ''} ${item.id} ${item.branch}${outcome.status === 'fail' ? `\n     ${outcome.error.replaceAll('\n', '\n     ')}` : ''}`)
  }
  const statuses = entry.cases.map((/** @type {any} */ item) => item.status)
  if (statuses.includes('fail')) entry.status = 'fail'
  else entry.status = statuses.includes('pass') ? 'pass' : 'manual'
}

/**
 * 서비스 하나의 한 층 — 서버를 띄우고 흐름을 차례로. 서버 · 설정 문제는 그 층 흐름 모두에 오류로 남긴다
 * @param {import('./flows.mjs').Service} service @param {string} layer @param {string} tree @param {string} commit
 */
async function runLayer(service, layer, tree, commit) {
  const workDir = service.dir ? join(tree, service.dir) : tree
  const flowsRoot = join(workDir, FLOWS_DIR)
  const wanted = option('flow')
  const flows = flowsOfFiles(listTreeFiles(flowsRoot)).filter((item) => item.layer === layer && item.tc && (!wanted || item.flow === wanted))
  if (!flows.length) return
  console.log(`\n${service.name} · ${layer} — 흐름 ${flows.length}개`)
  const entries = flows.map((item) => ({ service: service.name, layer, flow: item.flow, doc: item.doc, ref: commit.slice(0, 12), tree: option('cwd') ? 'cwd' : 'base', ranAt: new Date().toISOString(), status: 'running', error: '', cases: /** @type {any[]} */ ([]) }))
  run.flows.push(...entries)
  saveRun()
  const failAll = (/** @type {string} */ message) => {
    console.log(`  ❌ ${message}`)
    for (const entry of entries) if (entry.status === 'running') Object.assign(entry, { status: 'error', error: maskText(message) })
  }
  let qaConfig = null
  try { qaConfig = JSON.parse(readFileSync(join(flowsRoot, 'qa.json'), 'utf8')) } catch { /* 아래 검사가 알린다 */ }
  const settings = qaConfig?.[layer]
  const problem = checkLayerSettings(settings, layer)
  if (problem) return failAll(problem)

  /** @type {any} */
  let browser = null
  try {
    installIfNeeded(tree, workDir, commit, option('cwd') ? undefined : settings.install)
    if (layer === 'fe') browser = await openBrowser()
    stopCurrentServer = await startServer(settings, workDir, join(RUNS_DIR, run.id, `server-${service.name}-${layer}.log`))
    for (const [index, item] of flows.entries()) {
      const entry = /** @type {any} */ (entries[index])
      console.log(` ${item.flow}`)
      try {
        const tc = JSON.parse(readFileSync(join(flowsRoot, /** @type {string} */ (item.tc)), 'utf8'))
        const errors = checkTc(tc, layer, readFileSync(join(flowsRoot, item.doc), 'utf8'))
        if (errors.length) throw new Error(`TC 형식 오류:\n${errors.join('\n')}`)
        await runFlow(entry, tc, layer, settings.url, browser)
      } catch (error) {
        console.log(`  ❌ ${errorText(error)}`)
        Object.assign(entry, { status: 'error', error: errorText(error) })
      }
      saveRun()
    }
  } catch (error) {
    failAll(errorText(error))
  } finally {
    await browser?.close()
    await stopCurrentServer?.()
    stopCurrentServer = null
    saveRun()
  }
}

const finish = () => {
  run.finishedAt = new Date().toISOString()
  saveRun()
  pruneRuns()
}

async function main() {
  const config = loadConfig(ROOT)
  const all = listServices(config)
  const names = option('service').split(',').filter(Boolean)
  const layerArg = option('layer')
  if ((!names.length && !flag('all')) || (layerArg && !RUN_LAYERS.includes(/** @type {'fe'} */ (layerArg))) || (option('cwd') && names.length !== 1)) {
    console.error('사용: node scripts/qa/run.mjs --service <이름>[,<이름>] | --all [--layer fe|be] [--flow <흐름>] [--cwd <트리 — 서비스 하나일 때만>] [--reuse-server] [--if-tc]')
    return 2
  }
  const unknown = names.filter((name) => !all.some((service) => service.name === name))
  if (unknown.length) { console.error(`모르는 서비스: ${unknown.join(', ')} — 있는 것: ${all.map((service) => service.name).join(', ')}`); return 2 }
  if (isSwitching(ROOT)) { console.error('팩을 바꾸는 중이에요 — 끝난 뒤에 돌려 주세요'); return 1 }
  let services = names.length ? all.filter((service) => names.includes(service.name)) : all
  if (flag('if-tc')) {
    services = services.filter((service) => flowsOfFiles(listFlowFiles(ROOT, service).files).some((item) => item.tc))
    if (!services.length) { console.log('돌릴 TC 가 없어요'); return 0 }
  }

  const id = `${stamp()}-qa`
  mkdirSync(join(RUNS_DIR, id), { recursive: true })
  run = { id, pid: process.pid, startedAt: new Date().toISOString(), finishedAt: null, request: { services: services.map((service) => service.name), layer: layerArg, flow: option('flow') }, flows: [] }
  saveRun()
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(signal, () => {
      Promise.resolve(stopCurrentServer?.()).finally(() => { finish(); process.exit(1) })
    })
  }

  for (const service of services) {
    let tree = ''
    try {
      tree = option('cwd') ? resolve(option('cwd')) : baseTree(service)
    } catch (error) {
      // 기준 트리를 못 만들면 문서 목록으로 흐름마다 오류를 남긴다 — QA 탭에서 보이게
      const message = `작업 트리를 준비하지 못했어요: ${errorText(error)}`
      console.log(`\n${service.name} ❌ ${message}`)
      for (const item of flowsOfFiles(listFlowFiles(ROOT, service).files).filter((flow) => flow.tc)) {
        run.flows.push({ service: service.name, layer: item.layer, flow: item.flow, doc: item.doc, ref: '', tree: 'base', ranAt: new Date().toISOString(), status: 'error', error: message, cases: [] })
      }
      saveRun()
      continue
    }
    const commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    for (const layer of RUN_LAYERS) {
      if (!layerArg || layerArg === layer) await runLayer(service, layer, tree, commit)
    }
  }
  finish()
  const bad = run.flows.filter((/** @type {any} */ entry) => ['fail', 'error'].includes(entry.status))
  console.log(`\n흐름 ${run.flows.length}개 · 문제 ${bad.length}개 · 기록 .qa-runs/${id}/run.json`)
  return bad.length ? 1 : 0
}


process.exit(await main())
