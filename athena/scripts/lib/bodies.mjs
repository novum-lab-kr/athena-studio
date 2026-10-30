// 팩마다 본체 — 본체 열기·만들기 · 일괄 업데이트 · 되돌리기(약속: docs/pack.md "여러 팩")
//
//   주 본체   ~/.athena-studio/core   git 저장소 주인(앱이 들고 온 번들에서 clone) · main 브랜치 · 설치본(코어 정비는 코어 정본 레포에서 브랜치 · PR — 여기서 고치지 않는다)
//   팩 본체   <bodiesDir>/<id>        같은 저장소의 워크트리(브랜치 없이 detached) · .pack-data 가 그 팩에 고정
//             bodiesDir 는 레지스트리 값(스튜디오는 ~/.athena-studio/bodies) · 없으면 <주 본체>-<id>
//   배포 커밋 레지스트리 deploy.commit(update --from 이 정한다 · 없으면 주 본체의 origin/main — 처음 clone 한 번들) · deploy.source 는 받아 온 곳(bundle · 옛 기록은 origin)
//   기록      <데이터>/updates/<operationId>.json · 되돌릴 커밋은 refs/athena/rollback/<operationId>/<팩 id> 로 보존(gc 에 안 지워진다)
//   포트      레지스트리 portBase(없으면 4700) — 주 본체 기본 · 팩 본체는 +2 부터 2씩
//
// 명령 입구는 scripts/athena.mjs(pack open · new · discard · use · update · update --rollback · version)
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { ACTIVE_LINK, DATA_FORMATS, PACK_FORMAT_VERSION, bodiesDirOf, bodyConfig, bodyIdOf, dataDir, paths, portBaseOf, readRegistry } from './config.mjs'
import { PackError, alive, gitLockDir, takeLock } from './lock.mjs'
import { packLook } from './pack-look.mjs'
import {
  BLOCKING, bodyOf, busyScan, readPanesState, runningCoreScripts, settleIdleSessions, checkDataFormat, claimSlot, gitBodies, headOf, readJson, realOr, relinkIn, runInBody, scanProcesses,
  takePackLock, updateRegistry, writeWorkBackup,
} from './packs.mjs'

// 약속 번호 — 2 팩마다 본체 · 3 pack set-auto-merge(레포별 자동 머지) · 오류 코드 not-applicable. 스튜디오 src/lib/pack.js CONTRACT 와 같이 올린다
export const CONTRACT = 3
// update-from-bundle 부터는 하위 호환으로 더한 것 — 스튜디오는 이 이름으로 손잡이를 아는 코어인지 본다
// idle-panes — update --panes-state <파일>(쉬는 pane 의 세션은 일하는 중으로 세지 않는다 · 결정 D1)
// update-busy — update 가 일하는 세션이 있어도 본체를 올린다(entry.working · 2026-10-26) · repo-look — pack set-repo-name · set-repo-icon
// pr-off-merge — pack set-auto-merge --auto direct(PR 끔 바로 머지 — 약속 번호는 그대로 · 옛 off 는 자동 흐름 없음 그대로) · pack.json "autoPr"
// (앱은 모르는 명령에 옛 코어가 사용법만 찍으면 이 이름들로 "본체 코어가 옛 버전" 을 가린다 — 앱 src/lib/pack.js COMMAND_CAPABILITIES)
export const CAPABILITIES = ['open', 'update', 'rollback', 'discard', 'contract', 'update-from-bundle', 'backup-dirty', 'bodies-dir', 'port-base', 'idle-panes', 'update-busy', 'repo-look', 'merge-flow', 'pr-off-merge']

const git = (dir, args, { quiet = true } = {}) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}).trim()
const gitOk = (dir, args) => spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).status === 0
const gitTry = (dir, args) => { try { return git(dir, args) } catch { return null } }
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
const now = () => new Date().toISOString()
const stampId = (prefix) => {
  const date = new Date(); const pad = (value) => String(value).padStart(2, '0')
  return `${prefix}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${randomBytes(2).toString('hex')}`
}
const validId = (id) => /^[a-z0-9][a-z0-9-]*$/.test(id ?? '')

// 주 본체 — 같은 저장소 체크아웃 목록의 첫째(git worktree list 의 main worktree)
export const mainBody = (root) => gitBodies(root)[0] ?? null
const isMainBody = (main, body) => Boolean(main) && realOr(main) === realOr(body)
// 팩 본체인가 — 주 본체가 따로 있고 이 본체가 그것이 아니다(팩 본체는 코어를 고치지 않는다 — 현황판 [정비] 탭을 숨긴다)
export const isPackBody = (root) => {
  const main = mainBody(root)
  return Boolean(main) && !isMainBody(main, root)
}
export const isDirty = (body) => (gitTry(body, ['status', '--porcelain', '--untracked-files=no']) ?? 'x') !== ''

// 대상 커밋의 코어가 다루는 데이터 형식 범위 — 그 커밋의 config.mjs 의 DATA_FORMATS 줄(없으면 [1, 1] — 이 줄이 생기기 전 코어)
export const formatsAt = (main, commit) => {
  const text = gitTry(main, ['show', `${commit}:scripts/lib/config.mjs`]) ?? ''
  const match = text.match(/export const DATA_FORMATS = \[(\d+),\s*(\d+)\]/)
  return match ? [Number(match[1]), Number(match[2])] : [1, 1]
}
const formatOk = (formats, version) => version >= formats[0] && version <= formats[1]

// ── 포트 ────────────────────────────────────────────────────────────────
const listeners = (port) => { try { return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map(Number) } catch { return [] } }
const argsOf = (pid) => { try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
// 그 포트를 그 본체 현황판이 쓰나(인자의 server.mjs 경로로) — 그러면 "쓰는 중"이 아니다
const portFreeFor = (port, body) => listeners(port).every((pid) => [join(body, 'scripts', 'board', 'server.mjs'), join(realOr(body), 'scripts', 'board', 'server.mjs')].some((script) => argsOf(pid).includes(script)))
// 새 포트 — portBase+2 부터 2씩(기본 4702~4798). 레지스트리에 있거나 주 본체 포트이거나 지금 듣고 있으면 건너뛴다(레지스트리 잠금 안에서 불러 예약까지 한 번에)
const pickPort = (registry, main) => {
  const base = portBaseOf(registry)
  const used = new Set([base, Number(main ? bodyConfig(main).boardPort || base : base), ...Object.values(registry.packs ?? {}).map((entry) => Number(entry.boardPort)).filter(Boolean)])
  for (let port = base + 2; port < base + 100; port += 2) if (!used.has(port) && listeners(port).length === 0) return port
  throw new PackError('port-in-use', `현황판에 쓸 빈 포트가 없다(${base + 2}~${base + 98})`)
}
const writeBodyConfig = (body, patch) => {
  const file = join(body, 'athena.config.json')
  const before = readJson(file) ?? {}
  const next = { ...before, ...patch }
  if (JSON.stringify(before) !== JSON.stringify(next)) writeJson(file, next)
}

// ── pack open ───────────────────────────────────────────────────────────
// 본체를 준비하고 경로를 돌려준다. claude·현황판 띄우기는 부른 쪽(스튜디오) 몫
export const openPack = async (root, id, { report = () => {}, allowEmpty = false } = {}) => {
  const data = dataDir(root)
  if (!validId(id)) throw new PackError('not-found', `팩 id 가 올바르지 않다: ${id}`)
  checkDataFormat(readRegistry(data))
  const slot = join(data, 'packs', id)
  if (!existsSync(slot)) throw new PackError('not-found', `그런 팩이 없다: ${id}`)
  const pack = readJson(join(slot, 'pack', 'pack.json'))
  if (!pack && !allowEmpty) throw new PackError('invalid-pack', `팩 자리에 pack.json 이 없다: ${id}`)
  if (pack && (pack.formatVersion ?? 1) > PACK_FORMAT_VERSION) throw new PackError('format-unknown', `모르는 팩 형식 버전 ${pack.formatVersion} — 아테나 본체를 업데이트한다`)
  report('lock', `팩 잠금 — ${id}`)
  const release = takePackLock(data, id, `pack open ${id}`)
  try {
    report('check', '본체 찾기')
    const registry = readRegistry(data)
    const entry = registry.packs?.[id] ?? {}
    const main = mainBody(root)
    let body = bodyOf(root, data, id, registry)
    if (!body && entry.body && existsSync(entry.body)) {
      // 등록된 본체가 다른 팩을 가리킨다 — 덮지 않는다
      throw new PackError('body-mismatch', `등록된 본체(${entry.body})가 팩 ${id} 를 가리키지 않는다 — 손으로 확인한다`, { body: entry.body })
    }
    let created = false
    let unlinkedRepos = []
    let updated = null
    let state = 'ready'
    if (!body) {
      ({ body, unlinkedRepos } = await createBody(root, data, id, main, registry, report))
      created = true
    } else {
      // 배포 커밋보다 뒤처졌고 비어 있으면 지금 옮긴다("끝나면 업데이트" · 주 본체는 update 만)
      updated = catchUpBody({ main, body, id, data, registry, report })
      // 이미 있는 본체도 소유·링크를 검증하고 고칠 수 있으면 고친다(그 본체 코드로) — 못 고치면 repair-required
      report('verify', `본체 확인 — ${body}`)
      const relinked = relinkIn(body, data)
      unlinkedRepos = relinked.unlinkedRepos ?? []
      if (!relinked.ok) state = 'repair-required'
    }
    report('port', '현황판 포트')
    const port = assignPort(data, id, body, main)
    const after = readRegistry(data)
    report('done', `본체 ${body}${created ? ' (새로 만듦)' : ''}`)
    return {
      ok: true, id, packId: pack?.id ?? null, ...packLook(join(slot, 'pack'), readJson(join(slot, 'pack', 'pack.json')) ?? {}), bodyId: bodyIdOf(body), body, dataDir: data, boardPort: port.port,
      generation: after.packs?.[id]?.generation ?? 0, core: headOf(body), contract: CONTRACT, unlinkedRepos, state, created,
      ...(updated ? { updated } : {}), ...(port.changed ? { portChanged: port.changed } : {}),
    }
  } finally {
    release()
  }
}

// 새 본체 — <주 본체>-<id>(레지스트리 bodiesDir 가 있으면 <bodiesDir>/<id>)에 worktree add --detach <배포 커밋> → 본체 설정 → 그 본체 코드로 pack attach. 실패하면 본체를 지운다
const bodyPlace = (data, registry, main, id) => {
  const bodiesDir = bodiesDirOf(data, registry)
  return bodiesDir ? join(bodiesDir, id) : join(dirname(main), `${basename(main)}-${id}`)
}
const createBody = async (root, data, id, main, registry, report) => {
  if (!main) throw new PackError('unsafe', '주 본체가 git 체크아웃이 아니라 본체를 만들 수 없다')
  const body = bodyPlace(data, registry, main, id)
  if (existsSync(body)) throw new PackError('body-conflict', `본체 자리에 이미 폴더가 있다: ${body} — 덮지 않는다`, { body })
  // 배포 커밋 — 레지스트리 deploy.commit → origin/main. 주 본체 로컬 HEAD 는 쓰지 않는다(push 안 한 정비 커밋이 팩 본체로 새지 않게 · 5.4 · 리뷰 1차)
  const commit = registry.deploy?.commit ?? gitTry(main, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'])
  if (!commit) throw new PackError('unsafe', '배포 커밋을 정하지 못했다(deploy 없음 · origin/main 없음) — 앱을 다시 켜 코어를 update --from <번들> 로 맞춘 뒤 다시')
  // 그 커밋의 코어가 팩마다 본체를 아나(pack attach) — 모르면 만들지 않는다. 옛 pack use 로 우회하면 옛 코드가 다른 본체의 빈 자리를 지울 수 있다(리뷰 1차)
  if (!gitOk(main, ['cat-file', '-e', `${commit}:scripts/lib/bodies.mjs`])) throw new PackError('contract-mismatch', `배포 커밋 ${commit.slice(0, 7)} 의 코어는 팩마다 본체(약속 ${CONTRACT})를 모른다 — 앱을 다시 켜 코어를 update --from <번들> 로 올린 뒤 다시`, { contract: CONTRACT })
  const version = readRegistry(data).formatVersion ?? 1
  if (!formatOk(formatsAt(main, commit), version)) throw new PackError('data-incompatible', `배포 커밋 ${commit.slice(0, 7)} 의 코어는 데이터 형식 ${version} 을 다루지 못한다`)
  report('body', `본체 만들기 — ${body} @ ${commit.slice(0, 7)}`)
  const releaseGit = takeLock(gitLockDir(data), `worktree add ${body}`, { waitMs: 30_000 })
  try { mkdirSync(dirname(body), { recursive: true }); git(main, ['worktree', 'add', '--quiet', '--detach', body, commit], { quiet: false }) } catch (error) {
    throw new PackError('rollback', `본체를 만들지 못했다 — ${String(error.stderr ?? error.message).trim().slice(0, 300)}`, { rolledBack: true })
  } finally { releaseGit() }
  try {
    report('link', '본체에 팩 걸기(그 본체 코드로)')
    if (process.env.ATHENA_PACK_FAIL_AT === 'open') throw new Error('시험용 실패(ATHENA_PACK_FAIL_AT=open)')
    const port = updateRegistry(data, (registry) => {
      const value = pickPort(registry, main)
      registry.packs[id] = { ...(registry.packs[id] ?? {}), body, boardPort: value }
      return value
    })
    writeBodyConfig(body, { dataDir: data, boardPort: port })
    const run = runInBody(body, ['pack', 'attach', id, '--json'], data)
    if (!run.json?.ok) throw new Error(run.json?.message ?? run.stderr ?? '팩을 걸지 못했다')
    return { body, unlinkedRepos: run.json.unlinkedRepos ?? [] }
  } catch (error) {
    report('rollback', `실패 — 만들던 본체를 지운다: ${error.message}`)
    removeBody(main, body, data)
    updateRegistry(data, (registry) => {
      if (registry.packs[id]?.body === body) { delete registry.packs[id].body; delete registry.packs[id].boardPort }
    })
    throw new PackError('rollback', `본체를 만들지 못해 지웠다 — ${error.message}`, { rolledBack: true })
  }
}

const removeBody = (main, body, data) => {
  const releaseGit = takeLock(gitLockDir(data), `worktree remove ${body}`, { waitMs: 30_000 })
  try {
    // 본체 폴더만 지운다 — repos/ · .worktrees 등은 링크라 따라가지 않는다(서비스 워크트리·레포는 그대로)
    if (!gitOk(main, ['worktree', 'remove', '--force', body])) rmSync(body, { recursive: true, force: true })
    gitOk(main, ['worktree', 'prune'])
  } finally { releaseGit() }
}

// 포트 — 레지스트리가 정본. 없으면(주 본체 처음) 본체 설정 → portBase(기본 4700) 를 등록. 다른 프로세스가 쓰고 있으면 새 포트(portChanged)
const assignPort = (data, id, body, main) => updateRegistry(data, (registry) => {
  const entry = registry.packs[id] ?? {}
  const before = Number(entry.boardPort || bodyConfig(body).boardPort || (isMainBody(main, body) ? portBaseOf(registry) : 0)) || null
  let port = before
  let changed = null
  if (!port || !portFreeFor(port, body)) {
    port = pickPort({ ...registry, packs: Object.fromEntries(Object.entries(registry.packs).filter(([key]) => key !== id)) }, main)
    if (before) changed = { from: before, to: port }
  }
  registry.packs[id] = { ...entry, body, boardPort: port }
  writeBodyConfig(body, { boardPort: port })
  return { port, changed }
})

// 열 때 따라잡기 — 배포 커밋이 있고 그보다 뒤이고 비어 있으면 옮긴다(팩 본체만)
const catchUpBody = ({ main, body, id, data, registry, report }) => {
  const target = registry.deploy?.commit
  const head = headOf(body)
  if (!target || isMainBody(main, body) || head === target) return null
  // 앞으로만 — 배포 커밋이 지금 커밋의 후손일 때만 옮긴다(되돌리기·옛 deploy 로 본체를 내리지 않는다 · 리뷰 3차)
  if (!head || !gitOk(main, ['merge-base', '--is-ancestor', head, target])) return null
  report('body', `배포 커밋으로 옮기기 — ${target.slice(0, 7)}`)
  const result = moveBody({ main, body, id, data, target, requestedTo: target, operationId: registry.deploy.operationId ?? stampId('open'), mode: 'catch-up', lockHeld: true })
  // boardStopped — 따라잡으며 그 본체 현황판을 껐으면 포트(부른 쪽이 다시 띄운다 · 리뷰 1차)
  return result.status === 'updated' ? { from: result.from, to: result.to, boardStopped: result.services.boardStopped } : null
}

// ── 본체 하나 옮기기(update · rollback · 따라잡기 공용) ─────────────────────
// 팩 잠금(새 위임·브랜치·QA 를 막는다) → busy 다시(부른 쪽 포함 · 모르면 건너뜀) → dirty(backupDirty 면 사본 뒤 되돌림) → (update) 이전 커밋 ref 보존
// → 현황판 끄기 → checkout(팩 본체 --detach · 주 본체 merge --ff-only) → 새 코드로 relink → 실패하면 이 본체만 이전 커밋으로
// rollback · 따라잡기는 무엇이든 돌면 건너뛴다. update 만 아래(사용자 결정 2026-10-26 "일해도 바로 올리기" — 데이터가 깨지는 것만 막는다):
//   기다림  commit(commit.sh · ship.sh) · heavy(heavy.sh 잠금) — waitUntil 까지(업데이트 하나에 한 번 · UPDATE_WAIT_MS). 그래도 돌면 건너뜀(busy)
//   막음    switch(그 팩 작업 잠금 — 다른 열기 · 바꾸기 · 업데이트) · 그 밖의 모르는 종류 · ps 를 못 읽음(busy-unknown)
//   끔      learn-review · qa — 팩 바꾸기처럼 끄고 올린다. 학습 검토는 대기열에 일이 남았으면 새 코드로 다시 띄운다(learn-review --kick)
//   올림    athena · agent · codex · unknown(작업 폴더 · 인자를 못 읽은 세션) — entry.working 에 남긴다(panes 로 쉬는 pane 의 세션은 뺀다 · settleIdleSessions)
// 기다리는 상한 — 같은 update 가 git 잠금을 기다리는 값(takeLock waitMs 60_000)과 같다. 시험은 ATHENA_UPDATE_WAIT_MS 로 줄인다
export const UPDATE_WAIT_MS = 60_000
const UPDATE_WAIT_KINDS = new Set(['commit', 'heavy'])
const UPDATE_STOP_KINDS = new Set(['learn-review', 'qa'])
const UPDATE_SESSION_KINDS = new Set(['athena', 'agent', 'codex', 'unknown'])
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const updateScan = (body) => {
  const scan = scanProcesses()
  const others = busyScan(body, scan, { includeSelf: true }).busy.filter((item) => item.pid !== process.pid)
  return { scan, all: [...others, ...runningCoreScripts(body, scan)] }
}
// 학습 검토 다시 띄우기 — 옮긴 본체의 새 코드로(대기열에 일이 없으면 learn-review 가 아무것도 안 한다)
const kickLearnReview = (body) => spawnSync(process.execPath, [join(body, 'scripts', 'learn-review.mjs'), '--kick'], { cwd: body, stdio: 'ignore', timeout: 15_000 }).status === 0
export const moveBody = ({ main, body, id, data, target, requestedTo, operationId, mode, isMain = false, lockHeld = false, backupDirty = false, panes = null, waitUntil = Date.now() + UPDATE_WAIT_MS }) => {
  const from = headOf(body)
  const entry = { id, body, main: isMain, status: 'skipped', from, requestedTo, to: from, rollbackTo: null, services: { boardStopped: [] } }
  let release = () => {}
  if (!lockHeld) {
    try { release = takePackLock(data, id, `${mode} ${operationId}`) } catch (error) {
      if (error.code === 'locked') return { ...entry, reason: 'busy', busy: [{ kind: 'switch', what: error.message }] }
      throw error
    }
  }
  try {
    let toStop = []
    let table = []
    if (mode === 'update') {
      let { scan, all } = updateScan(body)
      while (scan.known && all.some((item) => UPDATE_WAIT_KINDS.has(item.kind)) && Date.now() < waitUntil) {
        sleepSync(1000)
        ;({ scan, all } = updateScan(body))
      }
      if (!scan.known) return { ...entry, reason: 'busy-unknown', busy: all }
      const blocking = all.filter((item) => !UPDATE_SESSION_KINDS.has(item.kind) && !UPDATE_STOP_KINDS.has(item.kind))
      if (blocking.length) return { ...entry, reason: 'busy', busy: blocking }
      toStop = all.filter((item) => UPDATE_STOP_KINDS.has(item.kind))
      table = scan.table
      const working = settleIdleSessions(all.filter((item) => UPDATE_SESSION_KINDS.has(item.kind)), scan.table, panes)
      if (working.length) entry.working = working
    } else {
      const scanned = busyScan(body, scanProcesses(), { includeSelf: true })
      const busy = scanned.busy.filter((item) => item.pid !== process.pid)
      if (!scanned.known) return { ...entry, reason: 'busy-unknown', busy }
      if (busy.length) return { ...entry, reason: 'busy', busy }
    }
    if (from === target) return { ...entry, status: 'same' }
    // 코어 파일을 고쳐 둔 본체 — 기본은 건너뜀(dirty). update --backup-dirty 면 아래 검사를 다 통과한 뒤 사본을 두고 되돌린다(D4)
    const dirty = isDirty(body)
    if (dirty && !(backupDirty && mode === 'update')) return { ...entry, reason: 'dirty' }
    if (isMain) {
      if (mode !== 'update') return { ...entry, reason: 'main' }
      const branch = gitTry(body, ['symbolic-ref', '-q', '--short', 'HEAD'])
      if (!branch || !gitOk(body, ['merge-base', '--is-ancestor', from, target])) return { ...entry, reason: 'diverged', ...(branch ? { branch } : {}) }
    }
    // 학습 검토 · QA 는 옛 코드라 끈다 — 건너뛸 수 있는 검사(busy · same · dirty · diverged)를 다 지난 뒤, 본체를 건드리기(사본 · reset · rollback ref) 전에.
    // 검토하다 끊긴 일(*.json.working)은 다음 감시자가 대기열로 되돌린다(learn-review watch). 학습 검토는 claude -p 를 동기로 불러
    // SIGTERM 을 그 뒤에야 받으니 바로 아래 자식(claude · gh)부터 끈다 — 남기면 결과를 받을 곳 없이 끝까지 돈다
    for (const item of toStop) {
      if (item.kind === 'learn-review') for (const row of table.filter((each) => each.ppid === item.pid)) stopPidSync(row.pid)
      stopPidSync(item.pid)
      const key = item.kind === 'qa' ? 'qaStopped' : 'learnStopped'
      entry.services[key] = [...(entry.services[key] ?? []), item.pid]
    }
    // 학습 검토를 껐으면 어떻게 끝나든(올림 · 실패 · 이전 커밋으로 되돌림) 그때 본체에 있는 코드로 다시 띄운다 — 꺼진 채 두면 대기열이 멈춘다
    const finish = (result) => {
      if (entry.services.learnStopped?.length) result.services = { ...result.services, learnKicked: kickLearnReview(body) }
      return result
    }
    if (dirty) {
      const saved = backupCoreEdits({ body, id, data, operationId })
      if (!saved.ok) return finish({ ...entry, status: 'failed', error: 'backup-failed', message: saved.message })
      Object.assign(entry, { backedUp: saved.files, backupDir: saved.dir })
      if (!gitOk(body, ['reset', '--quiet', '--hard', 'HEAD'])) return finish({ ...entry, status: 'failed', error: 'reset-failed' })
    }
    if (mode === 'update' || mode === 'catch-up') gitOk(main, ['update-ref', `refs/athena/rollback/${operationId}/${id}`, from])
    const stopped = stopBoard(body)
    entry.services.boardStopped = stopped
    const moved = isMain ? gitOk(body, ['merge', '--ff-only', '--quiet', target]) : gitOk(body, ['checkout', '--quiet', '--detach', target])
    if (!moved) return finish({ ...entry, status: 'failed', error: 'checkout-failed', to: headOf(body) })
    const relinked = relinkIn(body, data)
    if (relinked.ok) return finish({ ...entry, status: 'updated', to: headOf(body), rollbackTo: from, unlinkedRepos: relinked.unlinkedRepos ?? [] })
    // 새 코드로 맞추지 못했다 — 이 본체만 이전 커밋으로(D7)
    const back = isMain ? gitOk(body, ['reset', '--keep', from]) : gitOk(body, ['checkout', '--quiet', '--detach', from])
    const again = back ? relinkIn(body, data) : { ok: false }
    return finish({ ...entry, status: 'failed', error: 'verify-failed', message: relinked.message ?? relinked.error, to: headOf(body), rolledBack: Boolean(back && again.ok), ...(back && again.ok ? {} : { recoveryRequired: true }) })
  } finally {
    release()
  }
}
// 고쳐 둔 코어 파일 사본 — <데이터>/backups/core-edits/<operationId>/<팩 id>/ 에 files/(지금 내용) · changes.patch(HEAD 와의 차이) · meta.json.
// 추적 파일만(git diff HEAD — 스테이징·작업 트리 둘 다). 무시된 파일(athena.config.json · 상태 파일 · 팩 링크)은 git 이 건드리지 않으니 담지 않는다
const backupCoreEdits = ({ body, id, data, operationId }) => {
  const dir = join(data, 'backups', 'core-edits', operationId, id)
  try {
    const names = git(body, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']).split('\0').filter(Boolean)
    const files = []
    for (const name of names) {
      const from = join(body, name)
      let exists = false
      try { exists = lstatSync(from).isFile() || lstatSync(from).isSymbolicLink() } catch { /* 지운 파일 */ }
      if (exists) cpSync(from, join(dir, 'files', name), { verbatimSymlinks: true })
      files.push({ path: name, state: exists ? 'changed' : 'deleted' })
    }
    mkdirSync(dir, { recursive: true })
    const patch = spawnSync('git', ['-C', body, 'diff', '--binary', '--no-renames', 'HEAD'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (patch.status !== 0) throw new Error(String(patch.stderr ?? '').trim().slice(0, 200) || 'git diff 실패')
    writeFileSync(join(dir, 'changes.patch'), patch.stdout)
    writeJson(join(dir, 'meta.json'), { kind: 'core-edits', operationId, id, body, head: headOf(body), at: now(), files })
    // 사본이 다 있는지 다시 본다 — 하나라도 없으면 되돌리지 않는다
    const missing = files.filter((file) => file.state === 'changed' && !existsSync(join(dir, 'files', file.path)) && !isLinkAt(join(dir, 'files', file.path)))
    if (missing.length) throw new Error(`사본이 없다: ${missing.map((file) => file.path).slice(0, 5).join(', ')}`)
    return { ok: true, dir, files: files.map((file) => file.path) }
  } catch (error) {
    return { ok: false, message: `고친 코어 파일 사본을 만들지 못해 건드리지 않았다 — ${error.message}` }
  }
}
const isLinkAt = (path) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }

// 그 본체 현황판만 끈다(포트를 듣는 프로세스가 그 본체 server.mjs 일 때만). 다시 띄우는 것은 부른 쪽
const stopBoard = (body) => {
  const config = paths(body)
  const registry = readRegistry(config.dataDir)
  const port = Number(registry.packs?.[config.packId]?.boardPort || bodyConfig(body).boardPort || portBaseOf(registry))
  const scripts = [join(body, 'scripts', 'board', 'server.mjs'), join(realOr(body), 'scripts', 'board', 'server.mjs')]
  const pids = listeners(port).filter((pid) => scripts.some((script) => argsOf(pid).includes(script)))
  for (const pid of pids) stopPidSync(pid)
  return pids.length ? [port] : []
}
// SIGTERM → 3초 기다려도 살아 있으면 SIGKILL
const stopPidSync = (pid) => {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (let index = 0; index < 30 && alive(pid); index += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝 */ } }
}

// 데이터 폴더에 묶인 본체들 — 같은 저장소 체크아웃 중 .pack-data 가 <데이터>/packs/<id> 인 것 + 레지스트리에만 있고 폴더가 없는 것(missing)
export const collectBodies = (root, data, registry = readRegistry(data)) => {
  const packsReal = realOr(join(data, 'packs'))
  const found = []
  const seen = new Set()
  const all = gitBodies(root)
  for (const body of all) {
    const link = join(body, ACTIVE_LINK)
    if (!existsSync(link)) continue
    const real = realOr(link)
    if (realOr(dirname(real)) !== packsReal) continue
    const id = basename(real)
    seen.add(id)
    found.push({ id, body, isMain: body === all[0] })
  }
  for (const [id, entry] of Object.entries(registry.packs ?? {})) {
    if (!seen.has(id) && entry.body && !existsSync(entry.body)) found.push({ id, body: entry.body, missing: true })
  }
  return found
}

// 되돌리기에서 주 본체 건너뜀(main)은 설계대로라 완료 판정에서 뺀다(정비 체크아웃은 손으로)
const rollup = (all) => {
  const bodies = all.filter((entry) => entry.reason !== 'main')
  const updated = bodies.filter((entry) => entry.status === 'updated').length
  const failed = bodies.filter((entry) => entry.status === 'failed').length
  if (bodies.every((entry) => ['updated', 'same'].includes(entry.status))) return 'complete'
  if (!updated && failed) return 'failed'
  return 'partial'
}
const finish = (result, failCode) => {
  if (result.status === 'complete') return { ok: true, ...result }
  const error = result.status === 'partial' ? 'partial' : failCode
  const skipped = result.bodies.filter((entry) => entry.status !== 'updated' && entry.status !== 'same' && entry.reason !== 'main').map((entry) => `${entry.id}(${entry.reason ?? entry.error})`)
  return { ok: false, error, message: `${result.status === 'partial' ? '일부 본체만' : '본체를'} 옮기지 못했다 — ${skipped.join(' · ')}`, ...result }
}
const opDir = (data) => join(data, 'updates')
const saveOp = (data, record) => writeJson(join(opDir(data), `${record.operationId}.json`), record)

// ── update ──────────────────────────────────────────────────────────────
// from: git 번들 파일(앱이 들고 온 코어) — 그 번들의 main 을 refs/athena/bundle/main 으로 받아 그 커밋으로. 원격(origin)에서 받는 길은 없다 — 코어는 앱과 함께 온다
// backupDirty: 코어 파일을 고쳐 둔 본체도 사본(<데이터>/backups/core-edits/<operationId>/)을 두고 옮긴다(D4 · 기본은 dirty 로 건너뜀)
export const BUNDLE_REF = 'refs/athena/bundle/main'
// 스튜디오 버전 — 앱이 번들에 refs/athena/version/<버전>(0.2.1 · 0.2.1+3) → 코어 커밋으로 싣는다(앱 src/lib/studio-home.js).
// 같은 코어 커밋을 여러 앱 버전이 실을 수 있어 그 커밋을 가리키는 것 중 가장 높은 것 · 없으면(옛 번들 · 고친 코어) null
const VERSION_REF_PREFIX = 'refs/athena/version/'
const VERSION_REFSPEC = `+${VERSION_REF_PREFIX}*:${VERSION_REF_PREFIX}*`
const versionKey = (name) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/.exec(name)
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : null
}
const studioVersionOf = (root) => {
  const head = headOf(root)
  if (!head) return null
  const names = (gitTry(root, ['for-each-ref', '--points-at', head, '--format=%(refname)', VERSION_REF_PREFIX]) ?? '').split('\n').map((ref) => ref.slice(VERSION_REF_PREFIX.length)).filter((name) => versionKey(name))
  const higher = (left, right) => {
    const [first, second] = [versionKey(left), versionKey(right)]
    const index = first.findIndex((part, at) => part !== second[at])
    return index >= 0 && first[index] > second[index]
  }
  return names.reduce((best, name) => (best === null || higher(name, best) ? name : best), null)
}
const fetchEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' })
const fetchBundle = (main, file) => {
  let isFile = false
  try { isFile = statSync(file).isFile() } catch { /* 없음 */ }
  if (!isFile) throw new PackError('not-found', `번들 파일이 없다: ${file}`)
  const heads = spawnSync('git', ['-C', main, 'bundle', 'list-heads', file, 'refs/heads/main'], { encoding: 'utf8', env: fetchEnv() })
  if (heads.status !== 0 || !/\srefs\/heads\/main$/m.test(heads.stdout ?? '')) throw new PackError('fetch-failed', `git 번들이 아니거나 main 이 없다: ${file}`)
  const fetched = spawnSync('git', ['-C', main, 'fetch', '--quiet', '--no-tags', file, `+refs/heads/main:${BUNDLE_REF}`, VERSION_REFSPEC], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 180_000, env: fetchEnv() })
  if (fetched.status !== 0) throw new PackError('fetch-failed', `번들에서 받아 오지 못했다 — ${String(fetched.stderr ?? '').trim().slice(0, 200)}`)
  return gitTry(main, ['rev-parse', BUNDLE_REF]) ?? null
}
// panesState: 스튜디오가 넘긴 데몬 pane 상태 파일(--panes-state · readPanesState) — 쉬는 pane 의 세션은 working 에서 뺀다. 없거나 오래됐으면 모든 세션을 일하는 중으로 센다
export const updateBodies = (root, { to = '', from = '', backupDirty = false, panesState = '', report = () => {} } = {}) => {
  if (!from) throw new PackError('usage', 'update 는 --from <git 번들> 이 필요하다 — 코어는 Athena Studio 앱이 들고 온 번들로 업데이트한다')
  const data = dataDir(root)
  const registry = readRegistry(data)
  checkDataFormat(registry)
  const main = mainBody(root)
  if (!main) throw new PackError('unsafe', '주 본체가 git 체크아웃이 아니다')
  const operationId = stampId('upd')
  const source = 'bundle'
  const bundle = resolve(from)
  report('lock', '팩마다 잠금은 본체를 옮길 때 잡는다')
  report('fetch', `받아 오기 — 번들 ${bundle}`)
  const releaseGit = takeLock(gitLockDir(data), `update fetch ${operationId}`, { waitMs: 60_000 })
  let fetchedCommit = null
  try { fetchedCommit = fetchBundle(main, bundle) } finally { releaseGit() }
  const requestedTo = to || BUNDLE_REF
  const target = gitTry(main, ['rev-parse', '--verify', '--quiet', `${requestedTo}^{commit}`])
  if (!target) throw new PackError('not-found', `그런 커밋이 없다: ${requestedTo}`)
  const bodies = collectBodies(root, data, registry)
  const panes = readPanesState(panesState)
  if (panesState && !panes) report('panes', 'pane 상태 파일을 쓸 수 없다(없음 · 형식 · 2분 넘음) — 모든 세션을 일하는 중으로 센다')
  const version = registry.formatVersion ?? 1
  // 데이터 형식이 바뀌는 업데이트(대상 코어가 지금 형식을 못 다룸) — 모든 본체가 비었을 때만(D10)
  if (!formatOk(formatsAt(main, target), version)) {
    const scan = scanProcesses()
    const busyBodies = bodies.filter((item) => !item.missing).filter((item) => { const scanned = busyScan(item.body, scan, { includeSelf: true }); return !scanned.known || scanned.busy.some((busy) => busy.pid !== process.pid) })
    if (busyBodies.length) throw new PackError('data-incompatible', `데이터 형식이 바뀌는 업데이트라 모든 본체가 비어 있어야 한다 — 일하는 본체: ${busyBodies.map((item) => item.id).join(', ')}`, { bodies: busyBodies.map((item) => item.id) })
  }
  // 도는 커밋 · 무거운 명령을 기다리는 상한 — 업데이트 하나에 한 번(본체마다 따로 기다리면 늘어난다)
  const waitMs = Number(process.env.ATHENA_UPDATE_WAIT_MS ?? UPDATE_WAIT_MS)
  const waitUntil = Date.now() + (Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : UPDATE_WAIT_MS)
  const results = bodies.map((item) => {
    if (item.missing) return { id: item.id, body: item.body, main: false, status: 'skipped', reason: 'missing', from: null, requestedTo, to: null, rollbackTo: null, services: { boardStopped: [] } }
    report('body', `${item.id} — ${item.body}`)
    return moveBody({ main, body: item.body, id: item.id, data, target, requestedTo, operationId, mode: 'update', isMain: item.isMain, backupDirty, panes, waitUntil })
  })
  const status = rollup(results)
  const previousDeploy = registry.deploy?.commit ?? null
  const previousSource = registry.deploy?.source ?? null
  // 고친 코어 파일 사본 — 본체마다(backupDirty 일 때만 필드를 더한다 · contract 2 하위 호환)
  const backedUp = results.filter((entry) => entry.backedUp?.length).map((entry) => ({ id: entry.id, dir: entry.backupDir, files: entry.backedUp }))
  const extra = { source, bundle, ...(backupDirty ? { backedUp } : {}) }
  saveOp(data, { kind: 'update', operationId, at: now(), requestedTo, targetCore: target, fetched: fetchedCommit, previousDeploy, previousSource, status, ...extra, bodies: results })
  // 배포 커밋은 한 본체라도 대상에 닿았을 때만 옮긴다 — 모두 실패했는데 옮기면 열 때마다 따라잡기를 다시 시도하고 현황판을 끈다(리뷰 1차)
  if (status !== 'failed') updateRegistry(data, (next) => { next.deploy = { commit: target, previous: previousDeploy, at: now(), operationId, source } })
  report('done', `업데이트 ${status} — ${results.map((entry) => `${entry.id}:${entry.status}${entry.reason ? `(${entry.reason})` : ''}`).join(' · ')}`)
  return finish({ operationId, status, fetched: fetchedCommit, targetCore: target, requestedTo, ...extra, bodies: results }, 'failed')
}

// ── update --rollback [<operationId>] ────────────────────────────────────
// 그 실행이 바꾼 본체만, 지금도 그 실행의 to 에 있을 때 보존 ref 로. 주 본체는 되돌리지 않는다(main)
export const rollbackUpdate = (root, { operationId: wanted = '', report = () => {} } = {}) => {
  const data = dataDir(root)
  const registry = readRegistry(data)
  checkDataFormat(registry)
  const main = mainBody(root)
  if (!main) throw new PackError('unsafe', '주 본체가 git 체크아웃이 아니다')
  // 되돌릴 것 — 본체를 하나라도 바꾼 update 기록. 대상을 안 주면 그런 기록 중 마지막(실패·바꾼 것 없는 기록은 건너뛴다 · 리뷰 2차)
  const changedSomething = (record) => record?.kind === 'update' && (record.bodies ?? []).some((entry) => entry.status === 'updated')
  const records = existsSync(opDir(data)) ? readdirSync(opDir(data)).filter((name) => name.startsWith('upd-') && name.endsWith('.json')).sort() : []
  const op = wanted
    ? readJson(join(opDir(data), `${wanted}.json`))
    : records.map((name) => readJson(join(opDir(data), name))).filter(changedSomething).at(-1) ?? null
  if (!op || op.kind !== 'update') throw new PackError('rollback-unavailable', wanted ? `그런 업데이트 기록이 없다: ${wanted}` : '되돌릴 업데이트 기록이 없다')
  if (!changedSomething(op)) throw new PackError('rollback-unavailable', `그 업데이트(${op.operationId})는 바꾼 본체가 없다(${op.status}) — 되돌릴 것이 없다`)
  const operationId = stampId('rb')
  const version = registry.formatVersion ?? 1
  const results = op.bodies.filter((entry) => entry.status === 'updated').map((entry) => {
    const base = { id: entry.id, body: entry.body, main: Boolean(entry.main), status: 'skipped', from: existsSync(entry.body) ? headOf(entry.body) : null, requestedTo: entry.from, to: null, rollbackTo: null, services: { boardStopped: [] } }
    base.to = base.from
    if (!existsSync(entry.body)) return { ...base, reason: 'missing' }
    if (entry.main) return { ...base, reason: 'main' }
    if (base.from !== entry.to) return { ...base, reason: 'moved' }
    const ref = gitTry(main, ['rev-parse', '--verify', '--quiet', `refs/athena/rollback/${op.operationId}/${entry.id}^{commit}`])
    if (!ref) return { ...base, status: 'failed', error: 'rollback-unavailable' }
    if (!formatOk(formatsAt(main, ref), version)) return { ...base, reason: 'data-incompatible' }
    report('body', `${entry.id} — ${ref.slice(0, 7)} 로`)
    return moveBody({ main, body: entry.body, id: entry.id, data, target: ref, requestedTo: ref, operationId, mode: 'rollback' })
  })
  const status = results.length ? rollup(results) : 'complete'
  saveOp(data, { kind: 'rollback', operationId, rollbackOf: op.operationId, at: now(), status, bodies: results })
  // 배포 커밋은 본체를 하나라도 실제로 되돌렸고, 지금 배포 커밋이 그 실행의 것일 때만 그 실행 이전으로 —
  // 아무것도 못 되돌렸거나 그 뒤 다른 update 가 있었으면 그대로 둔다(옛 deploy 로 따라잡기가 본체를 내리지 않게 · 리뷰 3차)
  if (results.some((entry) => entry.status === 'updated')) {
    updateRegistry(data, (next) => {
      if (next.deploy?.commit !== op.targetCore) return
      if (op.previousDeploy) next.deploy = { commit: op.previousDeploy, previous: null, at: now(), operationId, ...(op.previousSource ? { source: op.previousSource } : {}) }
      else delete next.deploy
    })
  }
  report('done', `되돌리기 ${status}`)
  return finish({ operationId, rollbackOf: op.operationId, status, fetched: null, targetCore: op.previousDeploy ?? null, requestedTo: null, bodies: results }, 'rollback-failed')
}

// ── pack new · discard · use ─────────────────────────────────────────────
// pack new — 빈 자리 + 그 본체. 그 본체에서 claude 를 켜면 /setup
export const newPackBody = async (root, { report = () => {} } = {}) => {
  const data = dataDir(root)
  checkDataFormat(readRegistry(data))
  const { id, slot } = claimSlot(data, stampId('new').slice(0, 19))
  writeJson(join(slot, 'local.json'), { reposRoot: resolve(root, bodyConfig(root).reposRoot ?? '..') })
  try {
    const opened = await openPack(root, id, { report, allowEmpty: true })
    return { ...opened, previous: paths(root).packId ?? null }
  } catch (error) {
    rmSync(slot, { recursive: true, force: true })
    throw error
  }
}

// pack discard — 빈 자리(팩·작업 기록 없음)와 그 본체만. 주 본체는 지우지 않는다
export const discardPack = (root, id, { report = () => {} } = {}) => {
  const data = dataDir(root)
  if (!validId(id)) throw new PackError('not-found', `팩 id 가 올바르지 않다: ${id}`)
  const slot = join(data, 'packs', id)
  if (!existsSync(slot)) throw new PackError('not-found', `그런 팩 자리가 없다: ${id}`)
  if (existsSync(join(slot, 'pack', 'pack.json'))) throw new PackError('unsafe', `팩이 있는 자리는 지우지 않는다: ${id}`)
  const hasWork = ['plans', 'issues'].some((sub) => existsSync(join(slot, sub)) && spawnSync('find', [join(slot, sub), '-name', '*.md', '-type', 'f'], { encoding: 'utf8' }).stdout.trim() !== '')
  if (hasWork) throw new PackError('unsafe', `작업 기록이 있는 자리는 지우지 않는다: ${id}`)
  const release = takePackLock(data, id, `pack discard ${id}`)
  try {
    const main = mainBody(root)
    const body = bodyOf(root, data, id)
    if (body) {
      if (isMainBody(main, body) || realOr(body) === realOr(root)) throw new PackError('unsafe', `이 본체(${body})는 지우지 않는다 — 다른 본체에서 부른다`)
      const scanned = busyScan(body, scanProcesses())
      if (!scanned.known || scanned.busy.some((item) => BLOCKING.has(item.kind) && item.pid !== process.pid)) throw new PackError('busy', `그 본체에서 도는 작업이 있다 — ${body}`, { busy: scanned.busy })
      report('body', `본체 지우기 — ${body}`)
      stopBoard(body)
      removeBody(main, body, data)
    }
    rmSync(slot, { recursive: true, force: true })
    updateRegistry(data, (registry) => { delete registry.packs[id]; if (registry.current === id) registry.current = null })
    report('done', `지움 — ${id}`)
    return { ok: true, id, removedBody: body ?? null }
  } finally {
    release()
  }
}

// pack delete — 팩 하나를 지운다(팩 · 작업 기록 · 워크트리 · 본체 · 레지스트리). 레포 폴더는 그대로.
// 먼저 "팩 + 작업 기록 + 워크트리 변경" 백업(pack import 로 되살린다) · 그 본체에서 일하는 중이면 busy · 워크트리가 있으면 withWorktrees 가 있어야
export const deletePack = (root, id, { withWorktrees = false, report = () => {} } = {}) => {
  const data = dataDir(root)
  if (!validId(id)) throw new PackError('not-found', `팩 id 가 올바르지 않다: ${id}`)
  const slot = join(data, 'packs', id)
  if (!existsSync(slot)) throw new PackError('not-found', `그런 팩이 없다: ${id}`)
  const release = takePackLock(data, id, `pack delete ${id}`)
  try {
    const main = mainBody(root)
    const body = bodyOf(root, data, id)
    if (body && (isMainBody(main, body) || realOr(body) === realOr(root))) throw new PackError('unsafe', `이 본체(${body})의 팩은 여기서 지우지 않는다 — 주 본체(~/.athena-studio/core)에서 부른다`)
    if (body) {
      const scanned = busyScan(body, scanProcesses())
      const blocking = scanned.busy.filter((item) => BLOCKING.has(item.kind) && item.pid !== process.pid)
      if (!scanned.known || blocking.length) throw new PackError('busy', `그 팩 본체에서 도는 작업이 있다 — ${blocking.map((item) => item.what).join(' · ') || '확인 못 함'}`, { busy: blocking })
    }
    // 워크트리(<팩 데이터>/worktrees/<레포>/<이름> · .git 이 파일) — 미커밋 수와 함께 알린다
    const trees = []
    const base = join(slot, 'worktrees')
    if (existsSync(base)) for (const repo of readdirSync(base)) {
      if (!lstatSync(join(base, repo)).isDirectory()) continue
      for (const name of readdirSync(join(base, repo))) {
        const path = join(base, repo, name)
        try { if (lstatSync(join(path, '.git')).isFile()) trees.push({ name: `${repo}/${name}`, path, dirty: (gitTry(path, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length }) } catch { /* 워크트리 아님 */ }
      }
    }
    if (trees.length && !withWorktrees) throw new PackError('has-worktrees', `워크트리가 ${trees.length}개 있다 — 같이 지우려면 --with-worktrees(변경은 백업에 담긴다)`, { worktrees: trees.map(({ name, dirty }) => ({ name, dirty })) })
    report('backup', `백업 — ${id}`)
    const pack = readJson(join(slot, 'pack', 'pack.json')) ?? {}
    const backup = existsSync(join(slot, 'pack', 'pack.json'))
      ? writeWorkBackup({ root: body ?? slot, packDir: join(slot, 'pack'), id, data, packData: slot, report, prefix: 'before-delete' }).file
      : null
    if (body) { report('body', `현황판 끄기 · 본체 지우기 — ${body}`); stopBoard(body) }
    for (const tree of trees) {
      const common = gitTry(tree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (!(common && gitOk(dirname(common), ['worktree', 'remove', '--force', tree.path]))) rmSync(tree.path, { recursive: true, force: true })
    }
    if (body) removeBody(main, body, data)
    rmSync(slot, { recursive: true, force: true })
    updateRegistry(data, (registry) => { delete registry.packs[id]; if (registry.current === id) registry.current = null })
    report('done', `지움 — ${id}`)
    return { ok: true, id, name: pack.displayName ?? pack.name ?? id, backup, removedBody: body ?? null, worktrees: trees.length }
  } finally {
    release()
  }
}

// pack use — 팩마다 본체에서는 "그 팩 본체 열기". 활성 링크를 바꾸지 않는다. 1단계 필드를 덧붙인다
export const useAsOpen = async (root, id, options = {}) => {
  const previous = paths(root).packId ?? null
  const opened = await openPack(root, id, options)
  const unchanged = realOr(opened.body) === realOr(root)
  return {
    ...opened, current: { id, generation: opened.generation }, previous, unchanged, bodyChanged: !unchanged, opened: { ...opened }, boardStopped: [],
  }
}

// version — 디스크의 코어
export const versionInfo = (root) => {
  const registry = readRegistry(dataDir(root))
  return {
    ok: true, core: headOf(root), version: studioVersionOf(root), contract: CONTRACT, dirty: isDirty(root), dataFormats: DATA_FORMATS, capabilities: CAPABILITIES,
    body: resolve(root), bodyId: bodyIdOf(root), deploy: registry.deploy ? { commit: registry.deploy.commit, operationId: registry.deploy.operationId ?? null, source: registry.deploy.source ?? 'origin' } : null,
  }
}
