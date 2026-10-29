#!/usr/bin/env node
// @ts-check
// red-check 실행기 — 이번 변경의 테스트가 구현 없이(base)도 통과하는지 본다. 순수 로직 · 결과 뜻은 scripts/lib/red-check.mjs
// 보통은 줄 서기 래퍼 scripts/verify/red-check.sh 로 부른다(테스트를 한 번 더 돌리니 heavy.sh 로 한 대에 하나) · ship.sh 가 PR 올릴 때 부른다
//
// 사용: node scripts/red-check.mjs --dir <워크트리> [--repo <레포>] [--base <ref>] [--committed] [--json] [--spec '<redCheck JSON>']
//   --dir    검사할 작업 트리(레포 맨 위 · 워크트리)
//   --repo   팩 레포 이름 — 없으면 --dir 의 메인 체크아웃이 가리키는 repos/<레포> 링크로 찾는다
//   --base   기준 ref — 없으면 origin/<팩 prBase>. base 커밋 = merge-base <기준 ref> HEAD (fetch 하지 않는다 — ship.sh 가 먼저 한다)
//   --committed  바뀐 파일 · 테스트 내용 · 인라인 테스트 판별을 모두 HEAD 트리에서(작업 트리의 미커밋 수정 · 삭제는 보지 않는다)
//                — ship.sh 가 PR 에 올라가는 것만 보려고
//   --json   { result, text, row, seconds, base, files } 한 줄(ship.sh 가 읽는다). 없으면 검증 표와 같은 모양 한 줄
//   --spec   팩 redCheck 칸 대신 쓸 값(시험용 — test/red-check-test.sh)
// 바뀐 파일 = base..작업 트리(커밋 + 미커밋 + 미추적 · 무시 제외) · --committed 면 base..HEAD
// 테스트 경로가 심볼릭 링크를 거치면(원본 · base 임시 워크트리 어느 쪽이든) 복사하지 않고 unsupported — 링크를 따라 구현 · 바깥 파일을 덮지 않게
// 임시 워크트리 = <워크트리 자리>/.red-check/<레포>-<임의> (ATHENA_WORKTREE_ROOT → 팩 데이터 worktrees → <athena>/.worktrees — new-branch.sh 와 같은 자리) · 끝나면(실패 · 끊김도) 지운다
// 자세한 진행(파일마다 결과 · 실패 로그 끝)은 stderr. exit 0 = ok · no-tests · test-only · skip / 1 = non-discriminating · unsupported · error / 2 = 사용법
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { ATHENA_ROOT, loadConfig, paths } from './lib/config.mjs'
import { ATTENTION, DEP_DIRS, TIMEOUT_SECONDS, classify, commandFor, isInlineTest, parseSpec, resultText, splitChanged, summarize, tableRow } from './lib/red-check.mjs'

/** @type {Record<string, string | boolean>} */
const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const name = process.argv[index] ?? ''
  if (name === '--json') args.json = true
  else if (name === '--committed') args.committed = true
  else if (['--dir', '--repo', '--base', '--spec'].includes(name)) { args[name.slice(2)] = process.argv[index + 1] ?? ''; index += 1 }
  else { console.error(`모르는 옵션: ${name}`); process.exit(2) }
}
if (typeof args.dir !== 'string' || !args.dir) { console.error('사용: node scripts/red-check.mjs --dir <워크트리> [--repo <레포>] [--base <ref>] [--json]'); process.exit(2) }

const started = Date.now()
/** @param {string} cwd @param {string[]} gitArgs */
const git = (cwd, gitArgs) => {
  const run = spawnSync('git', ['-c', 'core.quotePath=false', '-C', cwd, ...gitArgs], { encoding: 'utf8' })
  return { ok: run.status === 0, out: (run.stdout ?? '').trim(), err: (run.stderr ?? '').trim() }
}
/** @param {string} path */
const real = (path) => { try { return realpathSync(path) } catch { return path } }
/** @param {string} path */
const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }

/**
 * 결과를 찍고 끝낸다
 * @param {{ result: string, detail?: string, files?: string[], kinds?: Record<string, number>, impl?: number, base?: string }} report
 * @returns {never}
 */
function finish(report) {
  const seconds = Math.round((Date.now() - started) / 1000)
  const text = resultText(report)
  const row = tableRow(text, seconds)
  if (args.json) console.log(JSON.stringify({ result: report.result, text, row, seconds, base: report.base ?? '', files: report.files ?? [] }))
  else console.log(row)
  return process.exit(ATTENTION.includes(report.result) ? 1 : 0)
}

// ── 대상 트리 · 레포 ───────────────────────────────────────────────────
const topRun = git(args.dir, ['rev-parse', '--show-toplevel'])
if (!topRun.ok) finish({ result: 'error', detail: `git 트리가 아니다: ${basename(args.dir)}` })
const top = real(topRun.out)
let repo = typeof args.repo === 'string' ? args.repo : ''
if (!repo) {
  const main = git(top, ['worktree', 'list', '--porcelain']).out.split('\n').find((row) => row.startsWith('worktree '))?.slice(9) ?? top
  repo = basename(real(main))
  const reposDir = join(ATHENA_ROOT, 'repos')
  if (isDir(reposDir)) {
    const linked = spawnSync('ls', [reposDir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).find((name) => real(join(reposDir, name)) === real(main))
    if (linked) repo = linked
  }
}

// ── 팩 칸 ──────────────────────────────────────────────────────────────
/** @type {{ name?: string, prBase?: string, redCheck?: unknown, apps?: Record<string, { prBase?: string }> } | undefined} */
let entry
/** @type {ReturnType<typeof parseSpec>} */
let spec
try {
  entry = typeof args.spec === 'string' ? undefined : (loadConfig().repos ?? []).find((/** @type {{ name?: string }} */ item) => item.name === repo)
  spec = parseSpec(typeof args.spec === 'string' ? JSON.parse(args.spec) : entry?.redCheck)
} catch (error) {
  finish({ result: 'error', detail: `redCheck 설정을 읽지 못했다 — ${error instanceof Error ? error.message : String(error)}` })
}
if (!spec) finish({ result: 'skip', detail: `팩 ${repo} 에 redCheck 칸 없음` })

// ── base · 바뀐 파일 ───────────────────────────────────────────────────
const prBase = entry?.prBase ?? Object.values(entry?.apps ?? {}).find((app) => app.prBase)?.prBase ?? ''
const baseRef = typeof args.base === 'string' && args.base ? args.base : (prBase ? `origin/${prBase}` : '')
if (!baseRef) finish({ result: 'error', detail: `기준 ref 를 정하지 못했다(팩 ${repo} 에 prBase 없음 · --base 도 없음)` })
const mergeBase = git(top, ['merge-base', baseRef, 'HEAD'])
if (!mergeBase.ok || !mergeBase.out) finish({ result: 'error', detail: `기준 ref(${baseRef})와의 merge-base 를 찾지 못했다 — fetch 했는지 확인` })
const base = mergeBase.out
const changed = (args.committed
  ? git(top, ['diff', '--name-only', '--no-renames', base, 'HEAD']).out.split('\n')
  : [...git(top, ['diff', '--name-only', '--no-renames', base]).out.split('\n'), ...git(top, ['ls-files', '--others', '--exclude-standard']).out.split('\n')]
).filter(Boolean)
/** @typedef {{ kind: 'file', data: Buffer, mode: number } | { kind: 'link' } | { kind: 'missing' }} Source */
/** @type {Map<string, Source>} */
const sources = new Map()
/**
 * 파일 원본 — --committed 면 HEAD 트리, 아니면 작업 트리. 경로가 심볼릭 링크(작업 트리는 경로 중간 칸 포함)면 link
 * @param {string} path
 * @returns {Source}
 */
const sourceOf = (path) => {
  const known = sources.get(path)
  if (known) return known
  /** @type {Source} */
  let found = { kind: 'missing' }
  if (args.committed) {
    // "<mode> <type> <sha>\t<경로>" — 120000 = 심볼릭 링크 · 그 밖(서브모듈 등)은 파일이 아니다
    const mode = git(top, ['ls-tree', 'HEAD', '--', path]).out.split(/\s/)[0] ?? ''
    if (mode === '120000') found = { kind: 'link' }
    else if (mode === '100644' || mode === '100755') {
      const blob = spawnSync('git', ['-C', top, 'cat-file', 'blob', `HEAD:${path}`])
      if (blob.status === 0) found = { kind: 'file', data: blob.stdout, mode: mode === '100755' ? 0o755 : 0o644 }
    }
  } else {
    let current = top
    let linked = false
    for (const part of path.split('/')) {
      current = join(current, part)
      try { if (lstatSync(current).isSymbolicLink()) { linked = true; break } } catch { current = ''; break }
    }
    if (linked) found = { kind: 'link' }
    else if (current) {
      try {
        const stat = statSync(current)
        if (stat.isFile()) found = { kind: 'file', data: readFileSync(current), mode: stat.mode & 0o777 }
      } catch { /* 없음 */ }
    }
  }
  sources.set(path, found)
  return found
}
const { groups, tests, impl } = splitChanged(changed, spec, (path) => sourceOf(path).kind !== 'missing')

const inline = impl.filter((path) => {
  if (!/\.(py|rs)$/.test(path)) return false
  const source = sourceOf(path)
  return source.kind === 'file' && isInlineTest(path, source.data.toString('utf8'))
})
if (inline.length) finish({ result: 'unsupported', files: inline, base })
const linkedTests = tests.filter((path) => sourceOf(path).kind === 'link')
if (linkedTests.length) finish({ result: 'unsupported', detail: '테스트 경로가 심볼릭 링크', files: linkedTests, base })
if (!tests.length) finish({ result: 'no-tests', impl: impl.length, base })
if (!impl.length) finish({ result: 'test-only', files: tests, base })

// ── 임시 워크트리 — base 그대로 + 이번 테스트 파일만 지금 내용으로 ─────────────────
const scratchRoot = join(process.env.ATHENA_WORKTREE_ROOT || paths().worktrees, '.red-check')
const scratch = join(scratchRoot, `${repo}-${randomBytes(4).toString('hex')}`)
let cleaned = true   // 임시 워크트리를 만들기 시작하면 false — 그 전에 끝나면 지울 것이 없다
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  git(top, ['worktree', 'remove', '--force', scratch])
  rmSync(scratch, { recursive: true, force: true })
  git(top, ['worktree', 'prune'])
}
// 돌고 있는 테스트 프로세스 묶음(detached — 우리가 끄지 않으면 부모가 끝나도 남는다)
let runningGroup = 0
const stopRunning = () => {
  if (!runningGroup) return
  try { process.kill(-runningGroup, 'SIGKILL') } catch { /* 이미 끝남 */ }
  runningGroup = 0
}
// 끊기면(heavy.sh 감시 · Ctrl+C) 테스트 묶음을 끄고 임시 워크트리를 지운 뒤 끝낸다 — 잠금이 풀린 뒤 테스트가 남아 다른 일과 겹치지 않게
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(signal, () => { stopRunning(); cleanup(); process.exit(130) })
process.on('exit', cleanup)

mkdirSync(scratchRoot, { recursive: true })
cleaned = false
const added = git(top, ['worktree', 'add', '--detach', '--quiet', scratch, base])
if (!added.ok) finish({ result: 'error', detail: `임시 워크트리를 만들지 못했다 — ${added.err.split('\n')[0] ?? ''}`, base })
// base 쪽 경로가 심볼릭 링크를 거치면 쓰지 않는다(링크를 따라 구현 · 임시 워크트리 밖을 덮는다) — 하나라도 있으면 unsupported
/** @param {string} path */
const linkedInScratch = (path) => {
  let current = scratch
  for (const part of path.split('/')) {
    current = join(current, part)
    try { if (lstatSync(current).isSymbolicLink()) return true } catch { return false }
  }
  return false
}
const linkedBase = tests.filter(linkedInScratch)
if (linkedBase.length) finish({ result: 'unsupported', detail: 'base 에서 테스트 경로가 심볼릭 링크', files: linkedBase, base })
for (const file of tests) {
  const source = sourceOf(file)
  if (source.kind !== 'file') continue
  const target = join(scratch, file)
  try {
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { force: true })
    // wx = 새로 만들 때만(O_EXCL) — 그 사이 링크가 생겨도 따라가지 않는다
    writeFileSync(target, source.data, { flag: 'wx', mode: source.mode })
  } catch (error) {
    finish({ result: 'error', detail: `테스트 파일을 임시 워크트리에 쓰지 못했다(${file}) — ${error instanceof Error ? error.message : String(error)}`, base })
  }
}
// 의존성 — 레포 맨 위와 테스트 파일이 든 폴더들(모노레포 앱 · 하위 패키지)의 node_modules · .venv 를 지금 트리 것으로 링크
const depRoots = new Set([''])
for (const file of tests) {
  let folder = dirname(file)
  while (folder && folder !== '.') { depRoots.add(folder); folder = dirname(folder) }
}
for (const folder of depRoots) {
  for (const name of DEP_DIRS) {
    const source = join(top, folder, name)
    const target = join(scratch, folder, name)
    if (!isDir(source) || existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, 'dir')
  }
}

/**
 * 한 파일 돌리기 — 시간이 넘으면 프로세스 묶음째 끈다
 * @param {string} command
 * @returns {Promise<{ code: number | null, timedOut: boolean, output: string }>}
 */
const runOne = (command) => new Promise((done) => {
  const child = spawn('sh', ['-c', command], { cwd: scratch, env: { ...process.env, CI: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  runningGroup = child.pid ?? 0
  let output = ''
  /** @param {Buffer} chunk */
  const take = (chunk) => { output = (output + chunk.toString('utf8')).slice(-200_000) }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { process.kill(-(child.pid ?? 0), 'SIGKILL') } catch { child.kill('SIGKILL') }
  }, TIMEOUT_SECONDS * 1000)
  child.on('error', (error) => { clearTimeout(timer); runningGroup = 0; done({ code: 127, timedOut, output: `${output}\n${error.message}` }) })
  child.on('close', (code) => { clearTimeout(timer); runningGroup = 0; done({ code, timedOut, output }) })
})

/** @type {{ file: string, outcome: 'fail' | 'pass' | 'error', kind?: string, reason?: string }[]} */
const runs = []
for (const group of groups) {
  for (const file of group.files) {
    const run = await runOne(commandFor(group.entry.run, [file]))
    const tail = run.output.trim().split('\n').slice(-20).join('\n')
    if (run.timedOut) {
      runs.push({ file, outcome: 'error', reason: `${TIMEOUT_SECONDS}초를 넘겨 껐다` })
    } else if (run.code === 0) {
      runs.push({ file, outcome: 'pass' })
    } else if (run.code === null || run.code === 126 || run.code === 127) {
      runs.push({ file, outcome: 'error', reason: run.code === null ? '신호로 끝났다' : `명령을 실행하지 못했다(exit ${run.code})` })
    } else {
      runs.push({ file, outcome: 'fail', kind: classify(run.output) })
    }
    const last = runs.at(-1)
    console.error(`  ${{ pass: '⚠️ base 에서도 통과', fail: `✔ base 에서 실패(${last?.kind})`, error: `✖ 오류(${last?.reason})` }[last?.outcome ?? 'error']}: ${file}`)
    if (last?.outcome === 'error' && tail) console.error(tail.replace(/^/gm, '      '))
  }
}
cleanup()
const summary = summarize(runs)
finish({ result: summary.result, files: summary.files, kinds: summary.kinds, base, detail: summary.result === 'error' ? summary.errors.map((item) => item.reason).filter(Boolean)[0] : undefined })
