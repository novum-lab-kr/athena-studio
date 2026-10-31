// 여러 팩 — 팩마다 본체(docs/pack.md "여러 팩").
//
//   <본체>/.pack-data → <데이터>/packs/<id>       그 본체의 팩(본체를 만들 때 한 번 걸고 바꾸지 않는다 — attachPack)
//   <본체>/pack · plans · issues · repos · …     고정 링크(.pack-data/… — 설치 때 한 번)
//   <데이터>/config.json                          팩 목록(packs.<id>: 본체 body · 포트 boardPort · 세대 generation) · 배포(deploy)
//   <데이터>/registry.lock · locks/<id>.lock      레지스트리 잠금(읽기→수정→저장) · 팩마다 작업 잠금(열기·업데이트) — scripts/lib/lock.mjs
//   <데이터>/switch.log                            단계 기록
//   <데이터>/packs/<id>/{pack,plans,issues,repos,worktrees,state,local.json}
//
// 명령 입구는 scripts/athena.mjs. 본체 만들기·업데이트는 scripts/lib/bodies.mjs. 실패는 PackError(code) — 코드는 계획서 5.7
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { ACTIVE_LINK, DATA_FORMATS, PACK_FORMAT_VERSION, bodyConfig, bodyIdOf, boardPort, dataDir, defaultBackupDir, paths, portBaseOf, readRegistry } from './config.mjs'
import { PackError, alive, lockOwnerAt, packLockDir, packLockOwner, registryLockDir, takeLock } from './lock.mjs'
import { isLink, linkOverlay, removeLink, unlinkOverlay } from './overlay.mjs'
import { captureRestore, checkRestore, discardRestore, restoreWork } from './restore.mjs'
import { inspectLook, packLook } from './pack-look.mjs'
import { dropRepoIcons } from './pack-repo-look.mjs'

export { PackError, alive }

// ── 고정 링크 · 팩 자리 ─────────────────────────────────────────────────
// 본체 이름 → 팩 데이터 안 자리. 상태 파일(현황판 휴지통·학습 수·Jev 캐시·QA 결과)도 팩마다 따로
export const FIXED_LINKS = [
  ['pack', 'pack'], ['plans', 'plans'], ['issues', 'issues'], ['repos', 'repos'], ['.worktrees', 'worktrees'],
  ['archive', 'pack/archive'], ['.sync', 'pack/sync'],
  ['.board-trash', 'state/board-trash'], ['.board-learn-stats.json', 'state/board-learn-stats.json'],
  ['.board-jev-qa.json', 'state/board-jev-qa.json'], ['.board-jev-learn.json', 'state/board-jev-learn.json'],
  ['.jev-log.jsonl', 'state/jev-log.jsonl'],
  ['.qa-runs', 'state/qa-runs'], ['.qa-auth', 'state/qa-auth'], ['.qa-baselines', 'state/qa-baselines'],
]
const SLOT_DIRS = ['pack/archive', 'pack/sync', 'plans/bugfix', 'plans/feature', 'plans/refactor', 'plans/task', 'issues', 'repos', 'worktrees',
  'state/board-trash', 'state/qa-runs', 'state/qa-auth', 'state/qa-baselines']

export const ensureSlot = (slot) => { for (const sub of SLOT_DIRS) mkdirSync(join(slot, sub), { recursive: true }) }

// 비어 있다고 봐도 되는 폴더(.gitkeep · .DS_Store · README.md 뿐) — 옛 클론의 plans/ · issues/ 자리
const emptyish = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (lstatSync(path).isDirectory() && !isLink(path)) { if (!emptyish(path)) return false; continue }
    if (!['.gitkeep', '.DS_Store'].includes(name) && !(name === 'README.md' && basename(dir) === 'issues')) return false
  }
  return true
}

// 본체에 고정 링크를 건다(이미 맞으면 그대로). 옛 작업 기록이 든 실제 폴더가 있으면 멈춘다 — pack migrate 몫.
// .worktrees 는 예외: 옛 워크트리가 든 실제 폴더면 그대로 둔다(D4 — 기존 워크트리는 제자리, 새 것은 paths().worktrees)
export const checkBodyLinks = (root) => ensureBodyLinks(root, { dryRun: true })
export const ensureBodyLinks = (root, { dryRun = false } = {}) => {
  const blocked = []
  const plan = []
  for (const [name, inner] of FIXED_LINKS) {
    const path = join(root, name)
    const want = join(ACTIVE_LINK, inner)
    if (isLink(path)) { if (readlinkSync(path) !== want) plan.push({ path, want, replace: true }); continue }
    if (!existsSync(path)) { plan.push({ path, want }); continue }
    const isDir = lstatSync(path).isDirectory()
    if (name === '.worktrees' && isDir) continue
    if (isDir && emptyish(path)) { plan.push({ path, want, clear: true }); continue }
    blocked.push(name)
  }
  if (blocked.length) throw new PackError('unsafe', `본체에 옛 작업 기록이 든 실제 폴더·파일이 있다(${blocked.join(', ')}) — 먼저 bin/athena pack migrate 로 옮긴다`, { blocked })
  if (dryRun) return plan.length
  for (const { path, want, replace, clear } of plan) {
    if (replace || clear) rmSync(path, { recursive: true, force: true })
    symlinkSync(want, path)
  }
  return plan.length
}

// ── 레지스트리(<데이터>/config.json) · 잠금 · 기록 ─────────────────────
const writeJsonAtomic = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}
const saveRegistry = (data, registry) => writeJsonAtomic(join(data, 'config.json'), { formatVersion: 1, ...registry })
export const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

// 데이터 폴더 형식이 이 코어가 다루는 범위인가 — 밖이면 쓰지 않는다(D10)
export const checkDataFormat = (registry) => {
  const version = registry.formatVersion ?? 1
  if (version < DATA_FORMATS[0] || version > DATA_FORMATS[1]) throw new PackError('data-incompatible', `데이터 폴더 형식 ${version} 을 이 코어(${DATA_FORMATS.join('~')})가 다루지 못한다 — 앱을 업데이트해 코어를 맞춘다(update --from <번들>)`, { dataFormat: version, dataFormats: DATA_FORMATS })
}
// 레지스트리 고치기 — 잠금 안에서 읽기→수정→저장(동시에 고쳐도 잃지 않게). mutate 의 반환값을 돌려준다
export const updateRegistry = (data, mutate) => {
  mkdirSync(data, { recursive: true })
  const release = takeLock(registryLockDir(data), `registry ${process.pid}`, { waitMs: 10_000, message: (owner) => `레지스트리 잠금을 10초 안에 잡지 못했다(pid ${owner.pid})` })
  try {
    const registry = readRegistry(data)
    checkDataFormat(registry)
    registry.packs ??= {}
    const result = mutate(registry)
    saveRegistry(data, registry)
    return result
  } finally { release() }
}
// 그 팩의 세대 +1(팩에 링크를 처음 걸 때 · 팩이 바뀔 때) — 그 팩을 연 현황판·학습 검토만 stale 이 된다
export const bumpGeneration = (registry, id) => {
  registry.packs[id] = { ...(registry.packs[id] ?? {}) }
  registry.packs[id].generation = (registry.packs[id].generation ?? 0) + 1
  return registry.packs[id].generation
}
const stamp = () => new Date().toISOString()
const fileStamp = () => {
  const now = new Date(); const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
const logSwitch = (data, text) => { try { mkdirSync(data, { recursive: true }); appendFileSync(join(data, 'switch.log'), `${stamp()} ${text}\n`) } catch { /* 기록 못 해도 작업은 계속 */ } }

// 팩 작업 잠금(팩마다) — 잡혀 있으면 바로 locked. allowParent: pack open 이 띄운 새 본체의 pack attach
export const takePackLock = (data, id, what, { allowParent = false } = {}) => takeLock(packLockDir(data, id), what, {
  allowParent, message: (owner) => `그 팩(${id})에 다른 작업이 진행 중이다(pid ${owner.pid}${owner.what ? ` · ${owner.what}` : ''})`,
})

// ── 팩 정보 ────────────────────────────────────────────────────────────
const slug = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
const uniqueId = (data, base) => {
  const start = slug(base) || 'pack'
  let id = start
  for (let index = 2; existsSync(join(data, 'packs', id)); index += 1) id = `${start}-${index}`
  return id
}
const newPackId = (name) => `${slug(name) || 'pack'}-${randomBytes(4).toString('hex')}`
// 원격 주소의 사용자·토큰 부분은 지운다(https://<토큰>@github.com/… 이 출력·JSON 으로 새지 않게)
export const maskRemote = (url) => (url ? url.replace(/(\w+:\/\/)[^@/]+@/, '$1') : url)
const gitRemote = (dir) => {
  if (!existsSync(join(dir, '.git'))) return null
  try { return maskRemote(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || null } catch { return null }
}
const walkFiles = (dir, keep = () => true) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) return walkFiles(path, keep)
    return keep(path) ? [{ path, mtime: stat.mtimeMs, size: stat.size }] : []
  })
}
const workCounts = (slot) => ({
  plans: walkFiles(join(slot, 'plans'), (path) => path.endsWith('.md')).length,
  issues: walkFiles(join(slot, 'issues'), (path) => path.endsWith('.md') && basename(path) !== 'README.md').length,
  archive: existsSync(join(slot, 'pack', 'archive')) ? readdirSync(join(slot, 'pack', 'archive')).filter((name) => !name.startsWith('.')).length : 0,
})
const readPackJson = (packDir) => readJson(join(packDir, 'pack.json'))
const summarize = (pack) => ({
  packId: pack.id ?? null,
  name: pack.name ?? null,
  formatVersion: pack.formatVersion ?? 1,
  repos: (pack.repos ?? []).length,
  repoNames: (pack.repos ?? []).map((repo) => repo.name),
  createdAt: pack.createdAt ?? null,
})
export const packInfo = (data, id, registry = readRegistry(data)) => {
  const slot = join(data, 'packs', id)
  const pack = readPackJson(join(slot, 'pack'))
  if (!pack) return null
  const files = [...walkFiles(join(slot, 'plans')), ...walkFiles(join(slot, 'issues')), ...walkFiles(join(slot, 'pack'), (path) => basename(path) === 'pack.json')]
  const updated = Math.max(0, ...files.map((file) => file.mtime))
  const work = workCounts(slot)
  const entry = registry.packs?.[id] ?? {}
  const remote = entry.remote ?? gitRemote(join(slot, 'pack'))
  return {
    id, packId: pack.id ?? entry.packId ?? null, name: pack.name ?? entry.name ?? id,
    repos: (pack.repos ?? []).length, repoNames: (pack.repos ?? []).map((repo) => repo.name),
    updatedAt: updated ? new Date(updated).toISOString() : null,
    hasWork: work.plans + work.issues > 0,
    // 표시 이름 · 아이콘(팩 안 · 5.7) — 화면은 displayName ?? name
    ...packLook(join(slot, 'pack'), pack),
    source: remote ? 'git' : (entry.source === 'git' ? 'git' : 'local'),
    ...(remote ? { remote } : {}),
  }
}

// 지금 팩 — 부른 본체의 팩(활성 링크가 정본). 세대는 그 팩 것
const currentOf = (root) => {
  const where = paths(root)
  if (where.mode !== 'packs') return null
  const json = readPackJson(join(where.packDataReal, 'pack'))
  const pack = json ?? {}
  // empty — pack new 로 만든 빈 자리(/setup 전)
  return { id: where.packId, packId: pack.id ?? null, name: pack.name ?? where.packId, ...packLook(join(where.packDataReal, 'pack'), pack), generation: where.generation, ...(json ? {} : { empty: true }) }
}

// ── 팩마다 본체 ─────────────────────────
// 본체 = 그 팩에 .pack-data 가 고정된 코어 체크아웃. 정본은 레지스트리 packs.<id>.body, 비어 있으면(주 본체 처음)
// 부른 본체 → 같은 저장소의 체크아웃 목록(git worktree list)에서 .pack-data 가 그 팩인 것을 찾는다(레지스트리에 쓰지 않는다)
export const realOr = (path) => { try { return realpathSync(path) } catch { return path } }
export const bodyHasPack = (body, data, id) => isLink(join(body, ACTIVE_LINK)) && realOr(join(body, ACTIVE_LINK)) === realOr(join(data, 'packs', id))
export const gitBodies = (root) => {
  try {
    return execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
  } catch { return [] }   // git 체크아웃이 아닌 복사본
}
export const bodyOf = (root, data, id, registry = readRegistry(data), bodies = null) => {
  const saved = registry.packs?.[id]?.body
  if (saved && bodyHasPack(saved, data, id)) return saved
  if (bodyHasPack(root, data, id)) return resolve(root)
  return (bodies ?? gitBodies(root)).find((body) => bodyHasPack(body, data, id)) ?? null
}
export const headOf = (dir) => { try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } catch { return null } }
// 고정 링크가 모두 그 팩을 가리키나(읽기만 — pack list 용. 고치는 것은 relink)
export const bodyLinksOk = (body) => isLink(join(body, ACTIVE_LINK)) && FIXED_LINKS.every(([name, inner]) => {
  const path = join(body, name)
  if (name === '.worktrees' && existsSync(path) && !isLink(path)) return true
  return isLink(path) && readlinkSync(path) === join(ACTIVE_LINK, inner)
})
// 본체 현황판 포트 — 그 본체에서 boardPort() 가 돌려줄 값(레지스트리 정본 → 본체 설정 → portBase). 부른 본체는 env 까지
const bodyBoardPort = (root, body, entry, registry) => {
  if (!body) return entry?.boardPort ?? null
  if (realOr(body) === realOr(root)) return boardPort(root)
  return Number(entry?.boardPort || bodyConfig(body).boardPort || portBaseOf(registry))
}
const bodyStateOf = (body, entry) => {
  if (!body) return entry?.body && !existsSync(entry.body) ? 'missing' : 'none'
  return bodyLinksOk(body) ? 'ready' : 'repair-required'
}
const withBody = (root, data, registry, scan, bodies) => (info) => {
  const entry = registry.packs?.[info.id]
  const body = bodyOf(root, data, info.id, registry, bodies)
  const core = body ? headOf(body) : null
  const targetCore = registry.deploy?.commit ?? null
  const scanned = body ? busyScan(body, scan) : { busy: [], known: true }
  return {
    ...info, body, bodyId: body ? bodyIdOf(body) : null, bodyState: bodyStateOf(body, entry), boardPort: bodyBoardPort(root, body, entry, registry),
    core, targetCore, updatePending: Boolean(body && core && targetCore && core !== targetCore),
    busy: scanned.busy, busyKnown: scanned.known, bodyBusy: scanned.busy.length > 0 || !scanned.known,
  }
}

// pack list — pack.json 이 아직 없는 빈 자리(pack new · /setup 전)는 packs 에 넣지 않고 emptySlots 로
export const listPacks = (root) => {
  const where = paths(root)
  const data = where.dataDir
  const switching = where.mode === 'packs' ? Boolean(packLockOwner(data, where.packId)?.alive) : false
  if (where.mode === 'legacy') {
    // 옛 구조 본체 — 지금 팩 하나를 보여 준다(데이터 폴더에 등록된 것도 같이)
    const pack = where.packDir ? readPackJson(where.packDir) : null
    const packs = existsSync(join(data, 'packs')) ? readdirSync(join(data, 'packs')).map((id) => packInfo(data, id)).filter(Boolean) : []
    return { ok: true, legacy: true, dataDir: data, current: pack ? { id: basename(where.packDir), packId: pack.id ?? null, name: pack.name ?? basename(where.packDir), generation: 0 } : null, switching, packs }
  }
  const registry = readRegistry(data)
  const ids = existsSync(join(data, 'packs')) ? readdirSync(join(data, 'packs')).filter((name) => !name.startsWith('.')) : []
  const bodies = gitBodies(root)
  const scan = scanProcesses()
  const emptySlots = ids.filter((id) => !readPackJson(join(data, 'packs', id, 'pack'))).map((id) => ({ id, body: bodyOf(root, data, id, registry, bodies) }))
  // dataDir — 실제 데이터 폴더(ATHENA_DATA_DIR → 본체 설정 dataDir → ~/.athena-studio/data)
  return { ok: true, dataDir: data, current: currentOf(root), switching, packs: ids.map((id) => packInfo(data, id, registry)).filter(Boolean).map(withBody(root, data, registry, scan, bodies)), emptySlots }
}

export const packStatus = (root) => {
  const where = paths(root)
  const list = listPacks(root)
  return { ok: true, current: list.current, switching: list.switching, boardPort: boardPort(root), dataDir: list.dataDir, body: resolve(root), bodyId: bodyIdOf(root), core: headOf(root), ...(where.mode === 'legacy' ? { legacy: true } : {}) }
}

// ── 지금 도는 것(busy) ─────────────────────────────────────────────────
// ps 는 pid·부모·실행 파일 이름만 읽는다(인자 전체·환경 변수는 출력하지 않는다 — 비밀값이 섞일 수 있다).
// 인자는 우리 스크립트를 찾을 때만 프로세스 하나씩 읽고 화면에는 내보내지 않는다
const processTable = () => execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
  .map(([, pid, ppid, comm]) => ({ pid: Number(pid), ppid: Number(ppid), comm: basename(comm.trim()) }))
const ancestorsOf = (table, pid) => {
  const parent = new Map(table.map((row) => [row.pid, row.ppid]))
  const seen = new Set()
  for (let current = pid; current && !seen.has(current); current = parent.get(current)) seen.add(current)
  return seen
}
// 모든 프로세스의 인자 — 못 읽으면 비어 있다(찾지 못함). 안에서 비교만 하고 어디에도 출력하지 않는다
const allArgs = () => {
  try {
    const rows = execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\n')
    return new Map(rows.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, args]) => [Number(pid), args.trim()]))
  } catch { return new Map() }
}
const argsOf = (pid) => { try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
const cwdsOf = (pids) => {
  const map = new Map()
  if (!pids.length) return map
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    parseLsof(out, map)
  } catch (error) { parseLsof(String(error.stdout ?? ''), map) }   // 일부 pid 를 못 읽으면 종료 코드 1 — 읽은 것만 쓴다(못 읽은 것은 unknown)
  return map
}
const parseLsof = (out, map) => {
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1))
  }
}
const inside = (path, dir) => Boolean(dir) && (path === dir || path.startsWith(dir + sep))
// 에이전트로 보는 실행 파일 — Claude Code · Codex
const AGENT_COMMS = new Set(['claude', 'codex'])
// delegate.sh 가 붙이는 인자(--agent <이름> · 워크트리면 --agents <JSON> 도) — 인자 안 값은 보지 않고 있는지만
const AGENT_FLAG = /(^|\s)--agents?(\s|=|$)/

// 프로세스 표 · 에이전트 작업 폴더를 한 번만 읽는다(pack list 가 본체 여럿의 busy 를 볼 때 같이 쓴다).
// ps 를 못 읽으면 known:false — 비어 있다고 보지 않는다
export const scanProcesses = () => {
  let table = []
  let known = true
  try { table = processTable() } catch { known = false }
  const mine = ancestorsOf(table, process.pid)
  const agents = table.filter((row) => AGENT_COMMS.has(row.comm))
  return { table, mine, agents, cwds: cwdsOf(agents.map((row) => row.pid)), known }
}

// 이 본체 · 그 팩에서 도는 것 → { busy:[{kind, what, pid}], known }. 다른 본체에서 도는 것은 이 본체를 막지 않는다.
// includeSelf: 이 명령을 부른 조상(셸·세션)도 센다 — update 는 자기를 부른 아테나 세션의 본체도 일하는 중으로 본다
export const busyScan = (root, scan = scanProcesses(), { includeSelf = false } = {}) => {
  const where = paths(root)
  const { table, mine, agents, cwds } = scan
  let known = scan.known
  const busy = []
  const skip = (pid) => pid === process.pid || (!includeSelf && mine.has(pid))
  const rootReal = realOr(root)
  const dataReal = where.packDataReal ? realOr(where.packDataReal) : null
  const legacyWorktrees = realOr(join(root, '.worktrees'))
  const repoMains = []
  const reposDir = join(root, 'repos')
  if (existsSync(reposDir)) for (const name of readdirSync(reposDir)) repoMains.push(realOr(join(reposDir, name)))
  const ours = (real) => inside(real, rootReal) || inside(real, legacyWorktrees) || inside(real, dataReal) || repoMains.some((main) => inside(real, main))
  // 레포 메인 체크아웃 안이고 본체 · 데이터 · 옛 워크트리 안은 아닌 자리
  const onlyRepoMain = (real) => !inside(real, rootReal) && !inside(real, legacyWorktrees) && !inside(real, dataReal) && repoMains.some((main) => inside(real, main))
  for (const row of agents) {
    if (skip(row.pid)) continue
    const cwd = cwds.get(row.pid)
    if (!cwd) {
      // 작업 폴더를 못 읽은 에이전트 — 이 본체 일인지 모른다
      if (alive(row.pid)) { known = false; busy.push({ kind: 'unknown', what: `작업 폴더를 읽지 못한 ${row.comm}`, pid: row.pid }) }
      continue
    }
    const real = realOr(cwd)
    if (!ours(real)) continue
    if (row.comm === 'codex') busy.push({ kind: 'codex', what: `Codex 세션 — ${real}`, pid: row.pid })
    else if (inside(real, rootReal) && !inside(real, legacyWorktrees)) busy.push({ kind: 'athena', what: `본체에서 도는 아테나 세션(claude) — ${real}`, pid: row.pid })
    else if (onlyRepoMain(real)) {
      // 레포 메인 체크아웃 안 claude 는 아테나가 띄운 에이전트(delegate.sh — --agent/--agents 인자)일 때만 센다.
      // 사용자가 그 폴더에서 직접 켠 claude 는 이 본체 일이 아니다(결정 D1 · 2026-10-25). 인자를 못 읽으면 모른다(보수적)
      const args = argsOf(row.pid)
      if (!args) { if (alive(row.pid)) { known = false; busy.push({ kind: 'unknown', what: `인자를 읽지 못한 claude — ${real}`, pid: row.pid }) } }
      else if (AGENT_FLAG.test(args)) busy.push({ kind: 'agent', what: `위임 에이전트(claude) — ${real}`, pid: row.pid })
    } else busy.push({ kind: 'agent', what: `위임 에이전트(claude) — ${real}`, pid: row.pid })
  }
  // QA 런 — 이 본체 팩 상태의 run.json 이 running 이고 그 pid 가 살아 있으면
  const runs = join(root, '.qa-runs')
  if (existsSync(runs)) {
    for (const name of readdirSync(runs)) {
      const run = readJson(join(runs, name, 'run.json')) ?? readJson(join(runs, name, 'group.json'))
      if (run && !run.finishedAt && alive(run.pid) && !skip(run.pid)) busy.push({ kind: 'qa', what: `QA 실행 ${name}`, pid: run.pid })
    }
  }
  // 학습 검토 — 이 본체의 scripts/learn-review.mjs 를 도는 node
  const learnScript = join(rootReal, 'scripts', 'learn-review.mjs')
  for (const row of table.filter((item) => item.comm === 'node' && !skip(item.pid))) {
    const args = argsOf(row.pid)
    if (args.includes(learnScript) || args.includes(join(root, 'scripts', 'learn-review.mjs'))) busy.push({ kind: 'learn-review', what: '학습 검토(learn-review.mjs)', pid: row.pid })
  }
  // 무거운 명령 잠금(scripts/heavy.sh — 한 대 공용 · 자리 여럿: 1번 <잠금>, 2번부터 <잠금>.2 …). 잠금에 적힌 본체(root)가 이 본체일 때만 이 본체 일 —
  // root 가 없는 옛 잠금이면 주인의 작업 폴더로 본다(못 읽으면 보수적으로 이 본체 일)
  const heavyLock = process.env.ATHENA_HEAVY_LOCK || '/tmp/hermes-heavy.lock'
  for (const slotDir of [heavyLock, ...[2, 3, 4, 5, 6, 7, 8].map((slot) => `${heavyLock}.${slot}`)]) {
    const heavy = lockOwnerAt(slotDir)
    if (!heavy?.alive || skip(heavy.pid)) continue
    let owner = ''
    try { owner = readFileSync(join(slotDir, 'root'), 'utf8').trim() } catch { /* 옛 잠금 */ }
    const cwd = owner ? null : realOr(cwdsOf([heavy.pid]).get(heavy.pid) ?? '')
    if (owner ? realOr(owner) === rootReal : (!cwd || ours(cwd))) busy.push({ kind: 'heavy', what: `무거운 명령 잠금(heavy.sh)${heavy.what ? ` — ${heavy.what}` : ''}`, pid: heavy.pid })
  }
  // 이 본체 팩의 작업 잠금(열기·업데이트 중)
  const owner = where.mode === 'packs' ? packLockOwner(where.dataDir, where.packId) : null
  if (owner?.alive && !skip(owner.pid)) busy.push({ kind: 'switch', what: `팩 작업 중${owner.what ? ` — ${owner.what}` : ''}`, pid: owner.pid })
  return { busy, known }
}
export const busyList = (root, scan, options) => busyScan(root, scan, options).busy
// 자동 리뷰 처리기 — 이 본체의 scripts/pr-auto.mjs --watch 를 도는 node · Electron. 손으로 돌린 한 번(--plan · --direct-merge)은 머지 도중일 수 있어 세지 않는다.
// busyScan 에 넣지 않는다 — 처리기는 일이 없어도 팩이 바뀔 때까지 살아 있어, 넣으면 pack busy · 되돌리기 · 따라잡기 · 데이터 형식 검사가 늘 "일하는 중" 으로 멈춘다.
// 그래서 코어를 옮기거나 팩을 갈아 끼우는 쪽이 이 함수로 찾아 직접 끈다
// 프로세스 이름 목록으로 고르지 않는다 — PATH 에 node 가 없으면 앱의 Electron 으로 돌아 이름이 앱마다 다르다. 인자 모양이 정확히 "<실행 파일> <스크립트> --watch" 인 것만 본다.
// 실행 파일 자리가 그 프로세스 이름과 같아야 하므로, 인자에 경로를 적었을 뿐인 셸 · claude -p 는 걸리지 않는다
// 인자는 한 번에 읽는다(allArgs) — 프로세스마다 ps 를 부르면 수백 번 돈다
export const prAutoWatchers = (root, scan = scanProcesses()) => {
  const suffixes = [join(realOr(root), 'scripts', 'pr-auto.mjs'), join(root, 'scripts', 'pr-auto.mjs')].map((script) => ` ${script} --watch`)
  const argsByPid = allArgs()
  return scan.table.filter((row) => row.pid !== process.pid).filter((row) => {
    const args = argsByPid.get(row.pid) ?? ''
    const suffix = suffixes.find((each) => args.endsWith(each))
    return Boolean(suffix) && basename(args.slice(0, -suffix.length)) === row.comm
  }).map((row) => ({ kind: 'pr-auto', what: '자동 리뷰 처리기(pr-auto.mjs --watch)', pid: row.pid }))
}
// ── 업데이트만 — 일하는 중이던 세션 가려내기(결정 D1 · 2026-10-26) ─────────────────────
// 업데이트는 세션이 있어도 본체를 올린다(사용자 결정 2026-10-26 "일해도 바로 올리기") — 이건 기록 · 알림에 "일하는 중이던 세션" 을 셀 때만 쓴다.
// panes: 스튜디오가 update --panes-state <파일> 로 넘긴 데몬 pane 상태 [{ id, label, pid(pane 셸), agent, status }].
// 세션(athena · agent · codex) 프로세스의 조상에 pane 셸이 있고 그 pane 이 입력을 기다리는(status idle) 같은 종류 에이전트면 쉬는 세션이라 뺀다.
// 일하는 pane(working) · 질문 대기(waiting) · 모르는 상태 · pane 밖 세션 · 못 짝지은 세션은 남긴다(확인이 안 되면 일하는 쪽).
// 남긴 세션에는 짝지은 pane 이름(pane)을 붙인다 — 스튜디오가 어느 세션이었는지 보인다. 세션이 아닌 것(heavy · switch · unknown 등)은 그대로 둔다
export const SESSION_KINDS = new Set(['athena', 'agent', 'codex'])
const paneAgentOf = (kind) => (kind === 'codex' ? 'codex' : 'claude')
export const settleIdleSessions = (busy, table, panes) => {
  if (!Array.isArray(panes) || !panes.length) return busy
  const byShell = new Map(panes.filter((pane) => pane && Number.isInteger(pane.pid) && pane.pid > 0).map((pane) => [pane.pid, pane]))
  const parent = new Map((table ?? []).map((row) => [row.pid, row.ppid]))
  const paneOf = (pid) => {
    const seen = new Set()
    for (let current = pid; current && current > 1 && !seen.has(current); current = parent.get(current)) {
      seen.add(current)
      if (byShell.has(current)) return byShell.get(current)
    }
    return null
  }
  const kept = []
  for (const item of busy) {
    if (!SESSION_KINDS.has(item.kind) || !item.pid) { kept.push(item); continue }
    const pane = paneOf(item.pid)
    if (!pane) { kept.push(item); continue }
    if (pane.status === 'idle' && pane.agent === paneAgentOf(item.kind)) continue
    kept.push({ ...item, pane: String(pane.label || pane.id || ''), paneStatus: String(pane.status || 'unknown') })
  }
  return kept
}
// ── 업데이트만 — 도는 커밋 · 올리기(commit.sh · ship.sh) ─────────────────────────────
// 이 본체의 scripts/commit.sh · ship.sh 를 도는 셸 → [{ kind:'commit', what, pid }]. 업데이트는 끝날 때까지 잠깐 기다린다(사용자 결정 2026-10-26).
// 셸 인자 중 이름이 commit.sh · ship.sh 인 것을 그 셸의 작업 폴더 기준으로 절대 경로로 풀어(bash commit.sh · bash ../<본체>/scripts/ship.sh 도)
// 이 본체 scripts/ 의 그 파일과 같은지 본다(링크는 실제 경로로). 인자 · 작업 폴더를 못 읽은 셸은 세지 않는다(셸은 많고 대부분 우리 일이 아니다).
// ps 인자 줄은 argv 를 공백으로 이어 붙여 원래 인자 경계를 잃는다 — 그래서 스크립트 이름으로 끝나는 자리마다 그 앞의 공백 경계를
// 하나씩 시작점으로 잡아 후보를 만든다(bash "../My Body/scripts/commit.sh" → "Body/scripts/commit.sh" · "../My Body/scripts/commit.sh" · …).
// 후보 중 하나라도 풀어서 이 본체 스크립트면 센다
const SHELL_COMMS = new Set(['bash', 'sh', 'zsh', 'dash'])
const CORE_SCRIPTS = ['commit.sh', 'ship.sh']
const SCRIPT_END = /(?:commit|ship)\.sh(?=\s|$)/g
const scriptCandidates = (args) => {
  const starts = [0]
  for (let index = 0; index < args.length; index += 1) if (/\s/.test(args[index])) starts.push(index + 1)
  const found = []
  for (const match of args.matchAll(SCRIPT_END)) {
    const end = match.index + match[0].length
    for (const start of starts) {
      if (start > match.index) break
      const candidate = args.slice(start, end)
      if (CORE_SCRIPTS.includes(basename(candidate))) found.push(candidate)
    }
  }
  return found
}
export const runningCoreScripts = (root, scan = scanProcesses()) => {
  const targets = new Map(CORE_SCRIPTS.map((name) => [realOr(join(root, 'scripts', name)), name]))
  const literal = CORE_SCRIPTS.flatMap((name) => [join(realOr(root), 'scripts', name), join(root, 'scripts', name)].map((path) => [path, name]))
  const found = []
  const pending = []
  for (const row of scan.table.filter((item) => SHELL_COMMS.has(item.comm) && item.pid !== process.pid && !scan.mine.has(item.pid))) {
    const args = argsOf(row.pid)
    if (!args) continue
    const hit = literal.find(([path]) => args.includes(path))
    if (hit) { found.push({ kind: 'commit', what: `${hit[1]} 실행 중`, pid: row.pid }); continue }
    const words = scriptCandidates(args)
    if (words.length) pending.push({ pid: row.pid, words })
  }
  const cwds = cwdsOf(pending.filter((item) => item.words.some((word) => !word.startsWith('/'))).map((item) => item.pid))
  for (const item of pending) {
    const cwd = cwds.get(item.pid)
    const name = item.words.map((word) => (word.startsWith('/') ? word : cwd ? resolve(cwd, word) : null)).filter(Boolean).map((path) => targets.get(realOr(path))).find(Boolean)
    if (name) found.push({ kind: 'commit', what: `${name} 실행 중`, pid: item.pid })
  }
  return found
}
// 스튜디오가 넘긴 pane 상태 파일 — 형식이 틀렸거나 오래됐으면(2분) 없는 것으로(= 모든 세션을 일하는 중으로 센다)
export const PANES_STATE_MAX_AGE_MS = 120_000
export const readPanesState = (file, nowMs = Date.now()) => {
  if (!file) return null
  const state = readJson(file)
  const at = Date.parse(state?.at ?? '')
  if (!state || !Array.isArray(state.panes) || !Number.isFinite(at) || nowMs - at > PANES_STATE_MAX_AGE_MS || at - nowMs > PANES_STATE_MAX_AGE_MS) return null
  return state.panes
}

// 팩을 바꾸면(attach · import --replace) 안 되는 것 — QA·학습 검토는 코어가 끈다. 모르면(unknown) 막는다
export const BLOCKING = new Set(['agent', 'athena', 'codex', 'heavy', 'switch', 'unknown'])

// ── 현황판 · 학습 검토 · QA 끄기 ────────────────────────────────────────
// 현황판은 포트로 찾되, 그 프로세스가 **이 본체**의 server.mjs 인지 인자로 확인한 뒤에만 끈다(다른 본체 현황판을 끄지 않게)
const boardPids = (root) => {
  const port = boardPort(root)
  let pids = []
  try { pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map(Number) } catch { return { port, pids: [] } }
  const scripts = [join(realOr(root), 'scripts', 'board', 'server.mjs'), join(root, 'scripts', 'board', 'server.mjs')]
  return { port, pids: pids.filter((pid) => scripts.some((script) => argsOf(pid).includes(script))) }
}
const stopPid = async (pid) => {
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (let index = 0; index < 30 && alive(pid); index += 1) await new Promise((done) => setTimeout(done, 100))
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝났다 */ } }
}
export const stopServices = async (root, busy) => {
  const stopped = { boardStopped: [], learnStopped: [], qaStopped: [], prAutoStopped: [] }
  const board = boardPids(root)
  for (const pid of board.pids) await stopPid(pid)
  if (board.pids.length) stopped.boardStopped.push(board.port)
  for (const item of busy) {
    if (item.kind === 'learn-review') { await stopPid(item.pid); stopped.learnStopped.push(item.pid) }
    if (item.kind === 'qa') { await stopPid(item.pid); stopped.qaStopped.push(item.pid) }
  }
  for (const item of prAutoWatchers(root)) { await stopPid(item.pid); stopped.prAutoStopped.push(item.pid) }
  return stopped
}

export const busyNow = (root) => { const { busy, known } = busyScan(root); return { ok: true, busy, busyKnown: known } }

// ── 레포 링크(repos/) 맞추기 ────────────────────────────────────────────
// git 주소 비교용 — 프로토콜 · 사용자 · .git 꼬리를 떼고 host:path 를 host/path 로(https · ssh · git@ 로 받은 같은 레포가 같게)
export const remoteKey = (url) => String(url ?? '').trim()
  .replace(/^[a-z][\w+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):(?!\d+\/)/, '$1/')
  .replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase()
// 팩에 적을 git 주소 — https 주소에 든 사용자 · 토큰은 뗀다(팩은 팀과 같이 쓴다)
export const shareableRemote = (url) => String(url ?? '').trim().replace(/^(https?:\/\/)[^/@]+@/i, '$1')
const originOf = (dir) => { try { return execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
const isRepoDir = (path) => existsSync(join(path, '.git'))

// git 주소로 레포 찾기 — base 아래 depth 단계까지 git 레포를 훑어 keys(remoteKey) 와 같은 것 → Map(key → 경로).
// 레포를 찾으면 그 안으로 내려가지 않는다 · 숨김 · node_modules · 맥 시스템 폴더는 건너뛴다(홈을 훑어도 빠르게)
const SKIP_SCAN = new Set(['node_modules', 'Library', 'Applications', 'Movies', 'Music', 'Pictures'])
const findReposByRemote = (base, keys, depth = 3) => {
  const found = new Map()
  const walk = (dir, level) => {
    let names = []
    try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of names) {
      if (found.size === keys.size) return
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_SCAN.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (isRepoDir(path)) {
        const key = remoteKey(originOf(path))
        if (keys.has(key) && !found.has(key)) found.set(key, path)
        continue
      }
      if (level < depth) walk(path, level + 1)
    }
  }
  if (existsSync(base)) walk(base, 1)
  return found
}

// 예상 목록(pack.json repos)과 실제 링크를 전부 대조 — 목록에 없는 링크는 지우고, 잇지 못한 레포는 unlinked 로 돌려준다.
// 레포 자리 찾는 순서: local.json repoPaths(없으면 reposRoot/<이름>) → 지금 링크가 가리키는 레포(손으로 이은 것) → git 주소(pack.json repos[].remote)로 reposRoot 아래에서.
// 뒤의 둘로 찾으면 local.json repoPaths 에 적는다(다음부터는 바로)
export const syncRepos = (root) => {
  const where = paths(root)
  const pack = readPackJson(where.packDir)
  if (!pack) return { linked: [], unlinked: [], removed: [] }
  const localFile = join(where.packData, 'local.json')
  const local = readJson(localFile) ?? {}
  const reposRoot = resolve(root, local.reposRoot ?? bodyConfig(root).reposRoot ?? '..')
  const dir = join(root, 'repos')
  mkdirSync(dir, { recursive: true })
  const wanted = new Set((pack.repos ?? []).map((repo) => repo.name))
  const removed = []
  for (const name of readdirSync(dir)) {
    if (!wanted.has(name) && isLink(join(dir, name))) { removeLink(join(dir, name)); removed.push(name) }
  }
  const repoPaths = { ...(local.repoPaths ?? {}) }
  const remember = (name, path) => {
    const rel = relative(reposRoot, path)
    repoPaths[name] = rel.startsWith('..') || rel === '' ? path : rel
  }
  const targets = new Map()
  const missing = []
  for (const repo of pack.repos ?? []) {
    const configured = resolve(reposRoot, repoPaths[repo.name] ?? repo.name)
    const link = join(dir, repo.name)
    const current = isLink(link) ? resolve(dir, readlinkSync(link)) : null
    if (isRepoDir(configured)) targets.set(repo.name, configured)
    else if (current && isRepoDir(current)) { targets.set(repo.name, current); remember(repo.name, current) }
    else missing.push(repo)
  }
  const byRemote = missing.filter((repo) => repo.remote)
  if (byRemote.length) {
    const found = findReposByRemote(reposRoot, new Set(byRemote.map((repo) => remoteKey(repo.remote))))
    for (const repo of byRemote) {
      const path = found.get(remoteKey(repo.remote))
      if (path) { targets.set(repo.name, path); remember(repo.name, path) }
    }
  }
  if (JSON.stringify(repoPaths) !== JSON.stringify(local.repoPaths ?? {})) writeJsonAtomic(localFile, { ...local, repoPaths })
  const linked = []; const unlinked = []
  for (const repo of pack.repos ?? []) {
    const target = targets.get(repo.name)
    const link = join(dir, repo.name)
    if (!target) {
      if (isLink(link)) removeLink(link)
      unlinked.push(repo.name)
      continue
    }
    if (isLink(link) && resolve(dir, readlinkSync(link)) === target) { linked.push(repo.name); continue }
    if (existsSync(link) || isLink(link)) removeLink(link)
    symlinkSync(target, link)
    linked.push(repo.name)
  }
  return { linked, unlinked, removed }
}

// 팩에서 레포 하나 빼기(bin/athena repo remove) — 팩 자동 백업 → pack.json 항목 · local.json 자리 · repos/ 링크 · 그 레포 에이전트 · 지식 · 검증 스크립트.
// 레포 폴더는 그대로. 그 레포 워크트리가 남아 있으면(미커밋 작업일 수 있다) 빼지 않는다. 팩 링크 정리는 부르는 쪽(link)이
export const removeRepo = (root, name, { report = () => {} } = {}) => {
  const where = paths(root)
  if (where.mode !== 'packs' || !where.packDataReal) throw new PackError('not-found', '여러 팩 본체가 아니다 — 팩 데이터가 없다')
  const packDir = join(where.packDataReal, 'pack')
  const pack = readPackJson(packDir)
  const entry = (pack?.repos ?? []).find((repo) => repo.name === name)
  if (!entry) throw new PackError('not-found', `팩에 그런 레포가 없다: ${name}`)
  const trees = join(where.packDataReal, 'worktrees', name)
  const left = existsSync(trees) ? readdirSync(trees).filter((item) => !item.startsWith('.')) : []
  if (left.length) throw new PackError('busy', `그 레포 워크트리가 남아 있다 — ${left.join(', ')} · 정리한 뒤 다시(git -C repos/${name} worktree remove <경로>)`, { worktrees: left })
  report('backup', `팩 백업 — ${where.packId}`)
  const backup = tarPack(packDir, join(where.dataDir, 'backups'), `${where.packId}-pack-before-repo-remove`)
  // 이 레포 에이전트 — 다른 레포도 쓰는 이름이면 두기
  const agentsOf = (repo) => [...(repo.agents ?? []), ...Object.values(repo.apps ?? {}).map((app) => app?.agent), repo.packagesAgent].filter((agent) => typeof agent === 'string' && /^[\w-]+$/.test(agent))
  const others = new Set((pack.repos ?? []).filter((repo) => repo !== entry).flatMap(agentsOf))
  const removed = []
  const drop = (rel) => { const path = join(packDir, rel); if (existsSync(path) || isLink(path)) { rmSync(path, { recursive: true, force: true }); removed.push(rel) } }
  for (const agent of agentsOf(entry)) if (!others.has(agent)) drop(`agents/${agent}.md`)
  drop(`knowledge/${name}`)
  drop(`verify/${name}.sh`)
  // 그 레포 표시 아이콘(assets/repos/<레포>.*) — assets 가 링크 등이라 못 지우면(unsafe) 아이콘만 건너뛰고 경고, 빼기는 이어 간다
  const warnings = []
  try {
    removed.push(...dropRepoIcons(packDir, name))
  } catch (error) {
    if (error?.code !== 'unsafe') throw error
    warnings.push(`그 레포 아이콘은 지우지 않았다 — ${error.message}`)
    report('warn', warnings[warnings.length - 1])
  }
  writeJsonAtomic(join(packDir, 'pack.json'), { ...pack, repos: pack.repos.filter((repo) => repo !== entry) })
  const localFile = join(where.packDataReal, 'local.json')
  const local = readJson(localFile)
  if (local?.repoPaths?.[name] !== undefined) {
    const { [name]: _gone, ...repoPaths } = local.repoPaths
    writeJsonAtomic(localFile, { ...local, repoPaths })
  }
  const repos = syncRepos(root)
  report('done', `뺐다 — ${name}`)
  return { ok: true, removed: name, backup, files: removed, unlinked: repos.removed.includes(name), ...(warnings.length ? { warnings } : {}) }
}

// 내보내기 · 백업 사본의 pack.json 에 레포 git 주소를 채운다(원본 팩은 그대로) — 받은 컴퓨터가 git 주소로 레포를 찾게
const addRemotes = (packJsonPath, reposDir) => {
  const pack = readJson(packJsonPath)
  if (!pack || !Array.isArray(pack.repos)) return
  let changed = false
  for (const repo of pack.repos) {
    if (repo.remote || !repo.name) continue
    const url = shareableRemote(originOf(join(reposDir, repo.name)))
    if (url) { repo.remote = url; changed = true }
  }
  if (changed) writeJsonAtomic(packJsonPath, pack)
}

// 이 컴퓨터의 레포 자리(백업용) — local.json 에 지금 이어진 링크의 실제 자리를 더한 것(절대 경로)
const localForBackup = (where) => {
  const local = readJson(join(where.packData, 'local.json')) ?? {}
  const reposRoot = local.reposRoot ? resolve(local.reposRoot) : null
  const repoPaths = {}
  for (const [name, path] of Object.entries(local.repoPaths ?? {})) if (typeof path === 'string') repoPaths[name] = resolve(reposRoot ?? '/', path)
  const reposDir = join(where.packData, 'repos')
  if (existsSync(reposDir)) {
    for (const name of readdirSync(reposDir)) {
      const target = realOr(join(reposDir, name))
      if (isRepoDir(target)) repoPaths[name] = target
    }
  }
  return { ...(reposRoot ? { reposRoot } : {}), ...(Object.keys(repoPaths).length ? { repoPaths } : {}) }
}

// 백업에 든 레포 자리 — 이름 · 경로 모양만 믿는다(경로는 링크를 걸 때 .git 이 있는지 다시 본다)
const cleanLocal = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const okPath = (path) => typeof path === 'string' && path.startsWith('/') && !path.includes('\0')
  const repoPaths = Object.fromEntries(Object.entries(value.repoPaths ?? {}).filter(([name, path]) => /^[\w.-]+$/.test(name) && okPath(path)))
  return { ...(okPath(value.reposRoot) ? { reposRoot: value.reposRoot } : {}), ...(Object.keys(repoPaths).length ? { repoPaths } : {}) }
}

// 링크 대조 — 고정 링크가 활성 팩을 가리키고 OVERLAY 링크가 모두 열리는가
const verifyBody = (root) => {
  const problems = []
  for (const [name, inner] of FIXED_LINKS) {
    const path = join(root, name)
    if (name === '.worktrees' && existsSync(path) && !isLink(path)) continue
    if (!isLink(path) || readlinkSync(path) !== join(ACTIVE_LINK, inner)) problems.push(`고정 링크가 다르다: ${name}`)
  }
  const result = linkOverlay(root)
  if (result.clash.length) problems.push(`코어에 같은 이름의 실제 파일: ${result.clash.join(', ')}`)
  return problems
}

const failAt = (step) => {
  // 시험용 — 일부러 그 단계에서 실패시켜 되돌리기를 확인한다(docs/pack.md "여러 팩 테스트")
  if (process.env.ATHENA_PACK_FAIL_AT === step) throw new Error(`시험용 실패(ATHENA_PACK_FAIL_AT=${step})`)
}

// 활성 링크를 원자적으로 바꾼다 — 임시 이름 링크 → rename
const swapActive = (root, target) => {
  const temp = join(root, `${ACTIVE_LINK}.tmp-${process.pid}`)
  rmSync(temp, { force: true })
  symlinkSync(target, temp)
  renameSync(temp, join(root, ACTIVE_LINK))
}

const rebuildDiagramIndex = (root) => {
  if (!existsSync(join(root, 'scripts', 'build-diagram-index.mjs'))) return
  spawnSync(process.execPath, [join(root, 'scripts', 'build-diagram-index.mjs')], { cwd: root, stdio: 'ignore' })
}

// ── pack attach — 본체에 팩을 처음 건다(팩마다 본체 · 한 번 걸면 바꾸지 않는다) ─────────────────
// 부르는 곳: pack open 이 새로 만든 본체(그 본체 코드로 `pack attach <id>`) · test-setup.
// 1 팩 잠금(allowParent — open 이 쥔 잠금) → 2 검사(대상 팩 · 형식 · 이 본체가 다른 팩에 묶였나) → 3 활성 링크 · 고정 링크 · 팩 링크
// → 4 repos/ 대조 → 5 확인 · 그 팩 세대 +1 → 끝. 3 이후 실패하면 걸던 링크를 걷는다(rollback)
export const attachPack = async (root, id, { report = () => {}, allowEmpty = false } = {}) => {
  const where = paths(root)
  const data = where.dataDir
  if (where.dataMismatch) throw new PackError('unsafe', `활성 링크(${where.packDataReal})가 지금 데이터 폴더(${data}) 밖을 가리킨다 — ATHENA_DATA_DIR 확인`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id ?? '')) throw new PackError('not-found', `팩 id 가 올바르지 않다: ${id}`)
  checkDataFormat(readRegistry(data))
  report('lock', '팩 잠금')
  const release = takePackLock(data, id, `pack attach ${id} · ${root}`, { allowParent: true })
  try {
    report('check', `대상 팩 확인 — ${id}`)
    const slot = join(data, 'packs', id)
    if (!existsSync(slot)) throw new PackError('not-found', `그런 팩이 없다: ${id}`)
    const pack = readPackJson(join(slot, 'pack'))
    if (!pack && !allowEmpty) throw new PackError('invalid-pack', `팩 자리에 pack.json 이 없다: ${id}`)
    if (pack && (pack.formatVersion ?? 1) > PACK_FORMAT_VERSION) throw new PackError('format-unknown', `모르는 팩 형식 버전 ${pack.formatVersion} — 아테나 본체를 업데이트한다`)
    if (where.mode === 'legacy' && bodyConfig(root).pack) throw new PackError('unsafe', `옛 구조 본체(athena.config.json 의 pack = ${bodyConfig(root).pack}) — 먼저 bin/athena pack migrate`)
    if (where.mode === 'packs' && where.packId === id) {
      report('done', `이미 이 본체의 팩이다 — ${id}`)
      return { ok: true, id, current: { id, generation: where.generation }, unlinkedRepos: syncRepos(root).unlinked, unchanged: true }
    }
    // 팩마다 본체 — 이미 다른 팩에 묶인 본체는 바꾸지 않는다(그 팩은 pack open 으로 그 팩 본체에서)
    if (where.mode === 'packs') throw new PackError('body-mismatch', `이 본체는 이미 팩 ${where.packId} 에 묶여 있다 — 팩 ${id} 는 bin/athena pack open ${id}`)
    checkBodyLinks(root)
    const scanned = busyScan(root)
    const blocking = scanned.busy.filter((item) => BLOCKING.has(item.kind) && item.pid !== process.pid && item.pid !== process.ppid)
    if (blocking.length) throw new PackError('busy', `이 본체에서 도는 작업이 있다 — ${blocking.map((item) => item.what).join(' · ')}`, { busy: blocking })
    logSwitch(data, `attach ${id} → ${root}`)
    try {
      report('link', '활성 링크 · 고정 링크 · 팩 링크')
      ensureSlot(slot)
      swapActive(root, slot)
      ensureBodyLinks(root)
      failAt('link')
      const overlay = linkOverlay(root)
      if (overlay.clash.length) throw new Error(`코어에 같은 이름의 실제 파일이 있어 링크하지 못했다: ${overlay.clash.join(', ')}`)

      report('repos', '레포 링크 대조')
      const repos = syncRepos(root)
      failAt('repos')

      report('verify', '팩 준비 확인')
      const problems = verifyBody(root)
      failAt('verify')
      if (problems.length) throw new Error(problems.join(' · '))

      const generation = updateRegistry(data, (registry) => {
        if (pack) registry.packs[id] = { ...(registry.packs[id] ?? {}), packId: pack.id ?? null, name: pack.name ?? id }
        registry.current = id   // 옛 읽기(1단계 스튜디오) 호환 — 정본은 각 본체의 .pack-data
        return bumpGeneration(registry, id)
      })
      rebuildDiagramIndex(root)
      logSwitch(data, `attach 끝 → ${id} · 세대 ${generation}${repos.unlinked.length ? ` · 못 이은 레포 ${repos.unlinked.join(',')}` : ''}`)
      report('done', `이 본체의 팩: ${id} (세대 ${generation})`)
      return { ok: true, id, current: { id, generation }, unlinkedRepos: repos.unlinked }
    } catch (error) {
      report('rollback', `실패 — 걸던 링크를 걷는다: ${error.message}`)
      logSwitch(data, `attach 실패(${error.message}) → 걷음`)
      removeLink(join(root, ACTIVE_LINK))
      try { unlinkOverlay(root) } catch { /* 팩 링크 걷기 실패 — 본체를 지우면 같이 사라진다 */ }
      throw new PackError('rollback', `팩을 걸지 못해 되돌렸다 — ${error.message}`, { rolledBack: true, current: null })
    }
  } finally {
    release()
  }
}

// 본체가 다시 맞춘다 — 고정 링크 · 팩 링크 · repos/ · 확인(update 뒤 새 코드로 · pack open 의 고치기). 팩은 바꾸지 않는다
export const relinkBody = (root) => {
  const where = paths(root)
  if (where.mode !== 'packs') throw new PackError('not-found', '이 본체에 팩이 없다(.pack-data) — bin/athena pack open <id>')
  ensureBodyLinks(root)
  const overlay = linkOverlay(root)
  if (overlay.clash.length) throw new PackError('verify-failed', `코어에 같은 이름의 실제 파일: ${overlay.clash.join(', ')}`)
  const repos = syncRepos(root)
  rebuildDiagramIndex(root)
  const problems = verifyBody(root)
  if (problems.length) throw new PackError('verify-failed', problems.join(' · '), { problems })
  return { ok: true, id: where.packId, unlinkedRepos: repos.unlinked }
}

// /setup 의 athena init 이 빈 자리(new-…)에 팩을 만든 뒤 — 자리 이름을 회사 이름으로 바꾼다(작업 기록이 아직 없을 때만).
// 본체 폴더 이름(<bodiesDir>/new-…)은 그대로 둔다 — 그 본체에서 /setup 세션이 돌고 있다(정본은 레지스트리 body)
export const renameNewSlot = (root, company) => {
  const where = paths(root)
  if (where.mode !== 'packs' || !where.packId.startsWith('new-')) return null
  const data = where.dataDir
  const old = where.packId
  // 그 자리 작업 잠금 — /setup 중에 같은 자리로 pack open 이 들어와 경쟁하지 않게(리뷰 1차)
  const release = takePackLock(data, old, `rename ${old} → ${company}`)
  try { return renameSlotLocked(root, where, data, old, company) } finally { release() }
}
const renameSlotLocked = (root, where, data, old, company) => {
  return updateRegistry(data, (registry) => {
    const id = uniqueId(data, company)
    renameSync(where.packDataReal, join(data, 'packs', id))
    swapActive(root, join(data, 'packs', id))
    const pack = readPackJson(join(data, 'packs', id, 'pack')) ?? {}
    const entry = registry.packs[old] ?? {}
    delete registry.packs[old]
    registry.packs[id] = { ...entry, packId: pack.id ?? null, name: pack.name ?? id, source: 'local', addedAt: stamp(), ...(entry.body ? { body: entry.body } : {}) }
    bumpGeneration(registry, id)
    if (registry.current === old) registry.current = id
    return id
  })
}

// ── 가져오기 검사(임시본) ──────────────────────────────────────────────
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 300 * 1024 * 1024
const MAX_FILES = 50_000
const SECRET_NAME = /^(\.env(\..+)?|\.npmrc|\.netrc|\.pypirc|id_rsa.*|id_ed25519.*|.*\.(pem|key|p12|pfx))$/i
const SECRET_OK = /^\.env\.(example|sample|template)$/i
const STRIP_NAMES = new Set(['.DS_Store', '.omc', 'node_modules', '__pycache__'])
const KNOWN_TOP = new Set(['pack.json', 'ROUTING.md', 'README.md', 'assets', 'agents', 'skills', 'knowledge', 'docs', 'diagrams', 'verify', 'scripts', 'qa', 'sync', 'archive', 'hooks', '.git', '.gitignore', '.gitattributes', '.gitkeep', 'LICENSE'])
export const validGitUrl = (text) => /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+|ssh:\/\/([\w.-]+@)?[\w.-]+(:\d+)?\/[\w./~-]+|[\w.-]+@[\w.-]+:[\w./~-]+)$/.test(text) && !text.includes('..')

const tmpRoot = (data) => join(data, 'tmp')
// 검사 중 SIGTERM — 임시본을 지우고 끝낸다
const withTemp = (data, work) => {
  const token = randomBytes(12).toString('hex')
  const dir = join(tmpRoot(data), token)
  mkdirSync(dir, { recursive: true })
  const onTerm = () => { rmSync(dir, { recursive: true, force: true }); process.exit(143) }
  process.once('SIGTERM', onTerm)
  process.once('SIGINT', onTerm)
  try {
    return work(dir, token)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  } finally {
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onTerm)
  }
}

// 압축 파일 항목 검사 — 절대 경로 · .. 가 하나라도 있으면 풀지 않는다
const archiveEntries = (file) => {
  let listing
  try { listing = execFileSync('tar', ['-tf', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { throw new PackError('invalid-pack', `압축 파일을 읽지 못했다: ${file}`) }
  const entries = listing.split('\n').filter(Boolean)
  const bad = entries.find((entry) => entry.startsWith('/') || entry.split('/').includes('..'))
  if (bad) throw new PackError('unsafe', `압축 안에 밖을 가리키는 경로가 있다 — 풀지 않는다: ${bad}`)
  if (entries.length > MAX_FILES) throw new PackError('invalid-pack', `파일이 너무 많다(${entries.length}개 > ${MAX_FILES})`)
  return entries
}

// 풀어 놓은 트리 검사 — 링크는 그 트리 안을 가리키는 상대 링크만 · 일반 파일·폴더·링크 말고는 거부 · 비밀 파일 거부 · 크기
const inspectTree = (top, { trustGit = false, dropGit = false } = {}) => {
  const realTop = realpathSync.native(top)
  let bytes = 0; let files = 0; let gitRemoved = false
  const warnings = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (STRIP_NAMES.has(name)) { rmSync(path, { recursive: true, force: true }); continue }
      // 최상위 .git — git clone 으로 이 명령이 받은 진짜 폴더만 검사 없이 둔다(원격 정보).
      // 폴더·압축에서 온 .git 은 믿지 않는다(리뷰 2026-10-18 — .git → /etc 링크 재현): 링크면 아래 링크 검사가 거부,
      // 파일(gitdir: 다른 곳을 가리키는 워크트리 표시)이면 지우고, 폴더면 다른 파일처럼 검사한다
      // 최상위 .git 이 링크면 어디를 가리키든 거부 — 팩 안 폴더를 가리켜도 그 안의 config(core.fsmonitor)가 git 명령 때 실행된다(리뷰 5차 재현)
      if (name === '.git' && dir === top && stat.isSymbolicLink()) throw new PackError('unsafe', `최상위 .git 이 링크다 — 가져오지 않는다: .git → ${readlinkSync(path)}`)
      if (name === '.git' && dir === top && trustGit && stat.isDirectory()) continue
      // 압축·폴더에서 온 .git 은 통째로 지운다 — .git/config(core.fsmonitor 등)·hooks 가 나중 git 명령(아카이브 커밋)에서 실행된다(리뷰 4차 재현).
      // 압축은 잃는 것 없음(export·백업은 원래 .git 을 뺀다). 폴더의 git 팩은 원격·이력을 잃는다 → 결과 gitRemoved 로 알리고 "git 주소로 가져오기" 를 안내한다
      if (name === '.git' && dir === top && dropGit && !stat.isSymbolicLink()) { rmSync(path, { recursive: true, force: true }); gitRemoved = true; continue }
      if (name === '.git' && dir === top && stat.isFile()) { rmSync(path, { force: true }); gitRemoved = true; continue }
      if (SECRET_NAME.test(name) && !SECRET_OK.test(name)) throw new PackError('unsafe', `비밀값이 들 수 있는 파일이 있다 — 가져오지 않는다: ${relative(top, path)}`)
      if (stat.isSymbolicLink()) {
        // 글자만 보지 않고 실제 경로로 푼다 — 링크 폴더를 거치는 우회(d → . · x → d/d/../..)도 잡는다(리뷰 2026-10-18). 풀리지 않는 링크도 거부
        const text = readlinkSync(path)
        let real = ''
        // realpathSync.native — OS 가 실제로 여는 곳. JS 판 realpathSync 는 링크 글자의 .. 를 글자로 먼저 접어(d/d/../.. → .) 우회를 놓친다
        try { real = realpathSync.native(path) } catch { throw new PackError('unsafe', `가리키는 곳이 없는 링크가 있다: ${relative(top, path)} → ${text}`) }
        if (text.startsWith('/') || !(real === realTop || real.startsWith(realTop + sep))) throw new PackError('unsafe', `팩 밖을 가리키는 링크가 있다: ${relative(top, path)} → ${text}`)
        continue
      }
      if (stat.isDirectory()) { walk(path); continue }
      if (!stat.isFile()) throw new PackError('unsafe', `일반 파일이 아니다: ${relative(top, path)}`)
      bytes += stat.size; files += 1
      if (bytes > MAX_BYTES) throw new PackError('invalid-pack', `팩이 너무 크다(${Math.round(MAX_BYTES / 1024 / 1024)}MB 초과)`)
    }
  }
  walk(top)
  const unknown = readdirSync(top).filter((name) => !KNOWN_TOP.has(name))
  if (unknown.length) warnings.push(`팩 형식에 없는 최상위 항목: ${unknown.join(', ')}`)
  return { bytes, files, warnings, gitRemoved }
}

// 팩 루트 찾기 — 맨 위에 pack.json, 또는 맨 위 폴더 하나 안에 pack.json(백업 파일 모양)
const findPackRoot = (dir) => {
  if (existsSync(join(dir, 'pack.json'))) return { pack: dir }
  const tops = readdirSync(dir).filter((name) => !name.startsWith('.'))
  if (tops.length === 1) {
    const inner = join(dir, tops[0])
    if (existsSync(join(inner, 'pack.json'))) return { pack: inner }
    // 작업 기록 백업(pack backup --with-work) — <id>/athena-backup.json · pack/ · plans/ · issues/
    if (existsSync(join(inner, 'athena-backup.json')) && existsSync(join(inner, 'pack', 'pack.json'))) return { pack: join(inner, 'pack'), work: inner }
  }
  if (existsSync(join(dir, 'athena.config.json'))) throw new PackError('invalid-pack', '아테나 본체 폴더다 — 팩이 아니라 기존 아테나면 pack import-athena 로 가져온다')
  throw new PackError('invalid-pack', '팩이 아니다 — pack.json 을 찾지 못했다')
}

const validatePack = (packRoot) => {
  let pack
  try { pack = JSON.parse(readFileSync(join(packRoot, 'pack.json'), 'utf8')) } catch (error) { throw new PackError('invalid-pack', `pack.json 을 읽지 못했다 — ${error.message}`) }
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) throw new PackError('invalid-pack', 'pack.json 이 객체가 아니다')
  const version = pack.formatVersion ?? 1
  if (typeof version !== 'number' || version > PACK_FORMAT_VERSION) throw new PackError('format-unknown', `모르는 팩 형식 버전 ${pack.formatVersion} — 아테나 본체를 업데이트한다`)
  if (pack.repos !== undefined && !Array.isArray(pack.repos)) throw new PackError('invalid-pack', 'pack.json 의 repos 가 목록이 아니다')
  for (const repo of pack.repos ?? []) if (!repo?.name || !/^[\w.-]+$/.test(repo.name)) throw new PackError('invalid-pack', `레포 이름이 올바르지 않다: ${JSON.stringify(repo?.name)}`)
  return pack
}

// 같은 팩이 이미 있나 — 같은 packId 면 conflict(같은 팩), 이름만 같으면 conflict(reason: name — 나란히 두기 가능)
const findConflict = (data, pack) => {
  const dir = join(data, 'packs')
  if (!existsSync(dir)) return null
  const registry = readRegistry(data)
  for (const id of readdirSync(dir)) {
    const info = packInfo(data, id, registry)
    if (!info) continue
    if (pack.id && info.packId === pack.id) return { ...pickConflict(info), reason: 'packId' }
  }
  for (const id of readdirSync(dir)) {
    const info = packInfo(data, id, registry)
    if (info && pack.name && String(info.name).toLowerCase() === String(pack.name).toLowerCase()) return { ...pickConflict(info), reason: 'name' }
  }
  return null
}
const pickConflict = (info) => ({ id: info.id, name: info.name, repos: info.repos, repoNames: info.repoNames, updatedAt: info.updatedAt, hasWork: info.hasWork })

const finishInspect = (data, dir, token, meta, report) => {
  report('check', '팩 형식·파일 검사')
  const found = findPackRoot(join(dir, 'in'))
  const pack = validatePack(found.pack)
  // .git 을 믿는 곳: git clone 으로 이 명령이 받은 폴더 · 내 옛 아테나(import-athena). 압축·폴더에서 온 것은 지운다
  const trustGit = (meta.kind === 'git' && found.pack === join(dir, 'in')) || meta.kind === 'athena'
  const tree = inspectTree(found.pack, { trustGit, dropGit: !trustGit })
  // 표시 이름 · 아이콘 — icon 경로 모양 · assets/ 이미지 형식·크기(링크 검사는 위 inspectTree 가 먼저 했다)
  tree.warnings.push(...inspectLook(found.pack, pack))
  // 검사한 팩을 정해진 자리로 모은다 — <tmp>/pack (+ 작업 기록 <tmp>/work)
  renameSync(found.pack, join(dir, 'pack'))
  if (found.work) {
    // 작업 기록 백업에 든 이 컴퓨터의 레포 자리 — 등록 때 local.json 으로(--replace 는 빈 자리만 채운다)
    const backupLocal = cleanLocal(readJson(join(found.work, 'local.json')))
    if (backupLocal && !meta.local) meta.local = backupLocal
    mkdirSync(join(dir, 'work'), { recursive: true })
    for (const sub of ['plans', 'issues']) if (existsSync(join(found.work, sub))) { inspectTree(join(found.work, sub)); renameSync(join(found.work, sub), join(dir, 'work', sub)) }
    // 되살리기 정보(에이전트 대화 · 워크트리) — 모양 · 이름 · 링크를 본 뒤 함께 둔다(lib/restore.mjs)
    if (existsSync(join(found.work, 'restore'))) {
      meta.restore = checkRestore(join(found.work, 'restore'))
      renameSync(join(found.work, 'restore'), join(dir, 'work', 'restore'))
    }
  }
  rmSync(join(dir, 'in'), { recursive: true, force: true })
  const work = existsSync(join(dir, 'work')) ? workCounts(join(dir, 'work')) : null
  const conflict = findConflict(data, pack)
  writeJsonAtomic(join(dir, 'meta.json'), { ...meta, token, createdAt: stamp(), packId: pack.id ?? null, name: pack.name ?? null, conflict, work })
  if (tree.gitRemoved) report('check', 'git 정보(.git)는 지웠다 — 팀과 git 으로 같이 쓰는 팩이면 git 주소로 가져온다')
  report('done', `검사 끝 — ${pack.name ?? '(이름 없음)'}${conflict ? ' · 같은 팩이 이미 있다' : ''}`)
  return {
    ok: true, token,
    pack: summarize(pack),
    ...(conflict ? { conflict } : {}),
    ...(work ? { work } : {}),
    ...(meta.restore ? { restore: meta.restore } : {}),
    files: tree.files, bytes: tree.bytes,
    // gitRemoved — 가져온 폴더·압축의 .git 을 지웠다(팀과 git 으로 같이 쓰는 팩이면 git 주소로 가져오기 안내)
    ...(tree.gitRemoved ? { gitRemoved: true } : {}),
    ...(tree.warnings.length ? { warnings: tree.warnings } : {}),
  }
}

// pack inspect <파일|폴더|git 주소>
export const inspectSource = (root, source, { report = () => {} } = {}) => {
  const data = dataDir(root)
  if (!source) throw new PackError('usage', '사용: pack inspect <파일|폴더|git 주소>')
  cleanExpired(data)
  return withTemp(data, (dir, token) => {
    const incoming = join(dir, 'in')
    // git 의 특수 전송(ext:: · file:// · fd::)은 받지 않는다 — 경로로 오해하지 않게 먼저 거른다
    if (/::|^file:|^git:|^http:/i.test(source)) throw new PackError('unsafe', `git 주소는 https:// · ssh:// · git@host:path 만 — ${maskRemote(source)}`)
    if (/^(https:|ssh:|[\w.-]+@[\w.-]+:)/.test(source)) {
      if (!validGitUrl(source)) throw new PackError('unsafe', `git 주소는 https:// · ssh:// · git@host:path 만 — ${maskRemote(source)}`)
      report('fetch', `git 에서 받기 — ${maskRemote(source)}`)
      const cloned = spawnSync('git', ['clone', '--quiet', '--', source, incoming], {
        stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 180_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' },
      })
      if (cloned.status !== 0) throw new PackError('clone-failed', `git 에서 받지 못했다(주소·권한 확인) — ${maskRemote(source)}`)
      return finishInspect(data, dir, token, { kind: 'git', source: maskRemote(source) }, report)
    }
    const path = resolve(source)
    if (!existsSync(path)) throw new PackError('not-found', `없다: ${path}`)
    if (statSync(path).isDirectory()) {
      report('copy', `폴더 복사 — ${path}`)
      cpSync(path, incoming, { recursive: true, verbatimSymlinks: true, filter: (from) => !STRIP_NAMES.has(basename(from)) })
      return finishInspect(data, dir, token, { kind: 'folder', source: path }, report)
    }
    report('extract', `압축 풀기 — ${basename(path)}`)
    archiveEntries(path)
    mkdirSync(incoming, { recursive: true })
    const extracted = spawnSync('tar', ['-xf', path, '-C', incoming], { stdio: ['ignore', 'ignore', 'pipe'] })
    if (extracted.status !== 0) throw new PackError('invalid-pack', `압축을 풀지 못했다: ${basename(path)}`)
    return finishInspect(data, dir, token, { kind: 'file', source: path }, report)
  })
}

// 24시간 지난 임시본은 지운다
const cleanExpired = (data) => {
  const dir = tmpRoot(data)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const meta = readJson(join(dir, name, 'meta.json'))
    const created = meta?.createdAt ? Date.parse(meta.createdAt) : statSync(join(dir, name)).mtimeMs
    if (Date.now() - created > TOKEN_TTL_MS) rmSync(join(dir, name), { recursive: true, force: true })
  }
}

// pack import-athena <옛 아테나 폴더> — 팩 + 계획서·이슈(·보관함은 팩 안)를 임시본으로. 원본은 건드리지 않는다
export const inspectAthena = (root, oldDir, { report = () => {} } = {}) => {
  const data = dataDir(root)
  const source = resolve(oldDir ?? '')
  if (!oldDir || !existsSync(join(source, 'athena.config.json'))) throw new PackError('not-found', `아테나 폴더가 아니다(athena.config.json 없음): ${source}`)
  const config = readJson(join(source, 'athena.config.json')) ?? {}
  if (!config.pack) throw new PackError('invalid-pack', '그 아테나에는 팩이 없다(athena.config.json 의 pack)')
  const packSource = resolve(source, config.pack)
  if (!existsSync(join(packSource, 'pack.json'))) throw new PackError('invalid-pack', `팩이 없다: ${packSource}/pack.json`)
  cleanExpired(data)
  return withTemp(data, (dir, token) => {
    report('copy', `팩 복사 — ${packSource}`)
    cpSync(packSource, join(dir, 'in'), { recursive: true, verbatimSymlinks: true, filter: (from) => !STRIP_NAMES.has(basename(from)) })
    report('copy', '계획서·이슈 복사')
    const work = join(dir, 'work')
    const realPlans = realOr(join(source, 'plans'))
    if (existsSync(realPlans)) cpSync(realPlans, join(work, 'plans'), { recursive: true, filter: (from) => !STRIP_NAMES.has(basename(from)) && basename(from) !== '.gitkeep' })
    const realIssues = realOr(join(source, 'issues'))
    if (existsSync(realIssues)) cpSync(realIssues, join(work, 'issues'), { recursive: true, filter: (from) => from === realIssues || (from.endsWith('.md') && basename(from) !== 'README.md') })
    for (const sub of ['plans', 'issues']) if (existsSync(join(work, sub))) inspectTree(join(work, sub))
    // 이 컴퓨터 설정 — 레포 위치(옛 본체 기준 상대 경로를 절대 경로로)
    const local = { reposRoot: resolve(source, config.reposRoot ?? '..'), ...(config.repoPaths ? { repoPaths: config.repoPaths } : {}) }
    const worktrees = listWorktrees(join(source, '.worktrees'))
    const result = finishInspect(data, dir, token, { kind: 'athena', source, local, worktrees }, report)
    return { ...result, work: { ...(result.work ?? { plans: 0, issues: 0, archive: 0 }), worktrees } }
  })
}

// 옛 본체의 워크트리 목록 — 복사하지 않는다(제자리 유지 · D4). 경로 · 브랜치 · 미커밋 여부만
export const listWorktrees = (dir) => {
  if (!existsSync(dir)) return []
  const found = []
  for (const repo of readdirSync(dir)) {
    const repoDir = join(dir, repo)
    if (!lstatSync(repoDir).isDirectory()) continue
    for (const name of readdirSync(repoDir)) {
      const path = join(repoDir, name)
      if (!existsSync(join(path, '.git'))) continue
      const git = (args) => { try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
      found.push({ path, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || '?', dirty: git(['status', '--porcelain']) !== '' })
    }
  }
  return found
}

// pack import <token> --keep|--replace|--new
export const importToken = async (root, token, mode, { report = () => {} } = {}) => {
  const data = dataDir(root)
  if (!/^[0-9a-f]{24}$/.test(token ?? '')) throw new PackError('not-found', '가져오기 token 이 올바르지 않다')
  const dir = join(tmpRoot(data), token)
  const meta = readJson(join(dir, 'meta.json'))
  if (!meta) throw new PackError('token-expired', '검사한 임시본이 없다 — 다시 pack inspect')
  if (Date.now() - Date.parse(meta.createdAt) > TOKEN_TTL_MS) { rmSync(dir, { recursive: true, force: true }); throw new PackError('token-expired', '검사한 지 24시간이 지났다 — 다시 pack inspect') }
  if (!['keep', 'replace', 'new'].includes(mode)) throw new PackError('usage', '--keep | --replace | --new 중 하나')
  if (mode === 'keep') { rmSync(dir, { recursive: true, force: true }); report('done', '임시본을 버렸다'); return { ok: true } }
  // 지금 상태로 다시 대조한다(검사 뒤에 다른 팩이 등록됐을 수 있다)
  const pack = validatePack(join(dir, 'pack'))
  const conflict = findConflict(data, pack)
  if (mode === 'new' && conflict?.reason === 'packId') throw new PackError('conflict', `같은 팩(packId ${pack.id})이 이미 있다 — ${conflict.id}. --replace 또는 --keep`, { conflict })
  if (mode === 'replace' && !conflict) throw new PackError('not-found', '바꿀 같은 팩이 없다 — --new 로 등록')

  // 공유 ID 가 없는 옛 팩은 지금 붙인다(형식 버전도)
  // 써 넣었으면 결과에 알린다(packJsonUpdated) — git 팩이면 그 팩 레포에 미커밋 변경으로 보인다
  let packJsonUpdated = null
  if (!pack.id || !pack.formatVersion) {
    const text = JSON.parse(readFileSync(join(dir, 'pack', 'pack.json'), 'utf8'))
    const added = [...(text.id ? [] : ['id']), ...(text.formatVersion ? [] : ['formatVersion'])]
    text.formatVersion ??= PACK_FORMAT_VERSION
    text.id ??= newPackId(text.name)
    writeFileSync(join(dir, 'pack', 'pack.json'), `${JSON.stringify(text, null, 2)}\n`)
    pack.id = text.id
    packJsonUpdated = { added, id: text.id }
    report('check', `pack.json 에 ${added.join('·')} 를 써 넣었다(${text.id})${gitRemote(join(dir, 'pack')) ? ' — 팩 레포에 미커밋 변경으로 보인다' : ''}`)
  }
  const source = meta.kind === 'git' ? 'git' : 'local'
  const remote = gitRemote(join(dir, 'pack'))

  if (mode === 'new') {
    // 자리 잡기는 mkdir(원자적) — 동시에 가져와도 같은 id 를 두 번 쓰지 않는다
    const { id, slot } = claimSlot(data, pack.name ?? 'pack')
    report('copy', `등록 — ${id}`)
    renameSync(join(dir, 'pack'), join(slot, 'pack'))
    for (const sub of ['plans', 'issues']) if (existsSync(join(dir, 'work', sub))) renameSync(join(dir, 'work', sub), join(slot, sub))
    placeRestore(dir, slot)
    ensureSlot(slot)
    const defaultRoot = resolve(root, bodyConfig(root).reposRoot ?? '..')
    const reposRoot = meta.local?.reposRoot && existsSync(meta.local.reposRoot) ? meta.local.reposRoot : defaultRoot
    writeJsonAtomic(join(slot, 'local.json'), { ...(meta.local ?? {}), reposRoot })
    updateRegistry(data, (registry) => {
      registry.packs[id] = { packId: pack.id, name: pack.name ?? id, source, ...(remote ? { remote } : {}), addedAt: stamp(), ...(meta.kind === 'athena' ? { importedFrom: meta.source } : {}) }
    })
    rmSync(dir, { recursive: true, force: true })
    report('done', `가져옴 — ${id}`)
    return { ok: true, imported: { id, name: pack.name ?? id }, ...(packJsonUpdated ? { packJsonUpdated } : {}) }
  }

  // --replace — 기존 팩을 자동 백업한 뒤 팩 폴더만 바꾼다(작업 기록은 그대로 이어서).
  // 그 팩의 본체(어느 본체에서 불렀든)를 기준으로 팩 잠금·busy 검사·현황판 끄기·링크 다시
  const id = conflict.id
  const slot = join(data, 'packs', id)
  const release = takePackLock(data, id, `pack import --replace ${id}`)
  try {
    const body = bodyOf(root, data, id)
    if (body) {
      const blocking = busyList(body).filter((item) => BLOCKING.has(item.kind) && item.pid !== process.pid)
      if (blocking.length) throw new PackError('busy', `그 팩 본체(${body})에서 도는 작업이 있다 — ${blocking.map((item) => item.what).join(' · ')}`, { busy: blocking, body })
    }
    report('backup', `기존 팩 백업 — ${id}`)
    const backup = tarPack(join(slot, 'pack'), join(data, 'backups'), `${id}-pack-before-replace`)
    const stopped = body ? await stopServices(body, busyList(body)) : { boardStopped: [] }
    const old = join(slot, `pack.old-${process.pid}`)
    renameSync(join(slot, 'pack'), old)
    try {
      renameSync(join(dir, 'pack'), join(slot, 'pack'))
      ensureSlot(slot)
    } catch (error) {
      renameSync(old, join(slot, 'pack'))
      throw error
    }
    // 보관함(archive)은 작업 기록이다 — 옛 팩의 것을 새 팩 자리로 옮겨 잇는다
    if (existsSync(join(old, 'archive'))) {
      for (const name of readdirSync(join(old, 'archive'))) {
        if (!existsSync(join(slot, 'pack', 'archive', name))) renameSync(join(old, 'archive', name), join(slot, 'pack', 'archive', name))
      }
    }
    rmSync(old, { recursive: true, force: true })
    // 작업 기록 백업의 레포 자리 — 이 컴퓨터 설정에 없는 레포만 채운다(있는 것은 덮지 않는다)
    if (meta.local?.repoPaths) {
      const current = readJson(join(slot, 'local.json')) ?? {}
      const repoPaths = { ...meta.local.repoPaths, ...(current.repoPaths ?? {}) }
      if (JSON.stringify(repoPaths) !== JSON.stringify(current.repoPaths ?? {})) writeJsonAtomic(join(slot, 'local.json'), { ...current, repoPaths })
    }
    for (const sub of ['plans', 'issues']) {
      // 작업 기록 백업을 되살리는 --replace — 기존 기록 위에 없는 파일만 더한다(덮지 않는다)
      if (existsSync(join(dir, 'work', sub))) cpSync(join(dir, 'work', sub), join(slot, sub), { recursive: true, force: false, errorOnExist: false })
    }
    placeRestore(dir, slot)
    updateRegistry(data, (registry) => {
      registry.packs[id] = { ...(registry.packs[id] ?? {}), packId: pack.id, name: pack.name ?? id, source, ...(remote ? { remote } : {}), replacedAt: stamp() }
      bumpGeneration(registry, id)
    })
    // 그 본체의 코드로 링크를 다시 맞춘다(본체마다 코어 커밋이 다를 수 있다)
    const relinked = body ? relinkIn(body, data) : null
    if (relinked && !relinked.ok) report('verify', `⚠️ 그 팩 본체 링크를 다시 맞추지 못했다 — ${relinked.message ?? relinked.error}`)
    rmSync(dir, { recursive: true, force: true })
    report('done', `바꿈 — ${id}${body ? ` (본체 ${body} · 링크 다시 맞춤)` : ''}`)
    return {
      ok: true, imported: { id, name: pack.name ?? id }, backup, ...(packJsonUpdated ? { packJsonUpdated } : {}),
      ...(body ? { body, boardStopped: stopped.boardStopped, unlinkedRepos: relinked?.unlinkedRepos ?? [], ...(relinked && !relinked.ok ? { relinkError: relinked.error } : {}) } : {}),
    }
  } finally {
    release()
  }
}

// 본체 자기 코드로 `pack relink` — 본체마다 코어 커밋이 다를 수 있어 그 본체의 링크 규칙을 쓴다.
// 그 코드에 relink 가 없으면(옛 코어 — 사용법 오류 2) 이 프로세스 코드로 맞춘다
export const relinkIn = (body, data) => {
  const run = runInBody(body, ['pack', 'relink', '--json'], data)
  if (run.status === 2) { try { return relinkBody(body) } catch (error) { return { ok: false, error: error.code ?? 'failed', message: error.message } } }
  return run.json ?? { ok: false, error: 'failed', message: run.stderr || '본체 명령이 JSON 을 내지 않았다' }
}
// 본체의 bin/athena(scripts/athena.mjs)를 그 본체에서 돌린다 → { status, json(마지막 줄), stderr }
export const runInBody = (body, args, data, { timeout = 120_000 } = {}) => {
  const env = { ...process.env, ATHENA_DATA_DIR: data }
  delete env.ATHENA_BOARD_PORT   // 포트는 본체·레지스트리가 정한다
  const run = spawnSync(process.execPath, [join(body, 'scripts', 'athena.mjs'), ...args], { cwd: body, encoding: 'utf8', env, timeout })
  const last = String(run.stdout ?? '').trim().split('\n').pop() ?? ''
  let json = null
  try { json = JSON.parse(last) } catch { /* JSON 아님 */ }
  return { status: run.status, json, stderr: String(run.stderr ?? '').trim().slice(0, 400) }
}

// 새 팩 자리 — 이름에서 id 를 만들고 mkdir(원자적)로 잡는다. 있으면 -2 · -3 …
export const claimSlot = (data, base) => {
  const start = slug(base) || 'pack'
  mkdirSync(join(data, 'packs'), { recursive: true })
  for (let index = 1; index < 1000; index += 1) {
    const id = index === 1 ? start : `${start}-${index}`
    const slot = join(data, 'packs', id)
    try { mkdirSync(slot); return { id, slot } } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  throw new PackError('conflict', `팩 자리를 정하지 못했다: ${start}`)
}

// ── 내보내기 · 백업 ────────────────────────────────────────────────────
// 내보내기 허용 목록(설계 ⑦-1 이 정본) — 회사 내용만. 작업 기록·결과물·비밀값·이 컴퓨터 설정은 뺀다
// 옛 팩의 diagrams · qa 폴더도 그대로 넣는다(지우는 것은 사람 몫). 목록 index.html 만 뺀다(다시 만든다)
const EXPORT_ALLOW = ['pack.json', 'ROUTING.md', 'README.md', 'assets', 'agents', 'knowledge', 'verify', 'skills', 'docs', 'scripts', 'qa', 'hooks', 'sync/snapshots', 'diagrams']
const EXPORT_DENY = (rel) => {
  const name = basename(rel)
  if (STRIP_NAMES.has(name) || name === '.git') return true
  if (SECRET_NAME.test(name) && !SECRET_OK.test(name)) return true
  if (rel === 'diagrams/index.html' || rel === 'sync/last-report.md' || rel.startsWith('sync/pending')) return true
  return false
}
const collect = (base, allow) => {
  const files = []
  const walk = (rel) => {
    const path = join(base, rel)
    if (!existsSync(path) && !isLink(path)) return
    if (EXPORT_DENY(rel)) return
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      // 팩 안을 가리키는 링크만 — 실제 경로로 풀어 본다(링크 폴더를 거치는 우회도 빠지게)
      try { if (realpathSync.native(path).startsWith(realpathSync.native(base) + sep)) files.push(rel) } catch { /* 가리키는 곳이 없는 링크는 뺀다 */ }
      return
    }
    if (stat.isDirectory()) { for (const name of readdirSync(path)) walk(rel ? join(rel, name) : name); return }
    if (stat.isFile()) files.push(rel)
  }
  for (const entry of allow) walk(entry)
  return files
}
// 목록대로 임시 폴더에 모은 뒤 tar — 만든 뒤 항목을 다시 읽어 허용 목록 밖이 없는지 확인한다
const tarFiles = (stage, top, out, prefix) => {
  mkdirSync(out, { recursive: true })
  let file = join(out, `${prefix}-${fileStamp()}.tar.gz`)
  for (let index = 2; existsSync(file); index += 1) file = join(out, `${prefix}-${fileStamp()}-${index}.tar.gz`)
  execFileSync('tar', ['-czf', file, '-C', stage, top], { stdio: ['ignore', 'ignore', 'inherit'] })
  return file
}
const stageCopy = (base, files, stageTop) => {
  for (const rel of files) {
    mkdirSync(dirname(join(stageTop, rel)), { recursive: true })
    cpSync(join(base, rel), join(stageTop, rel), { verbatimSymlinks: true })
  }
}
const tarPack = (packDir, out, prefix, top = 'pack') => {
  const files = collect(packDir, readdirSync(packDir))
  const stage = join(dirname(out), 'tmp', `stage-${randomBytes(6).toString('hex')}`)
  try {
    stageCopy(packDir, files, join(stage, top))
    return tarFiles(stage, top, out, prefix)
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

const requireCurrent = (root) => {
  const where = paths(root)
  if (where.mode === 'packs') return { where, packDir: where.packDataReal ? join(where.packDataReal, 'pack') : null, id: where.packId }
  if (where.packDir) return { where, packDir: where.packDir, id: basename(where.packDir) }
  throw new PackError('not-found', '지금 팩이 없다')
}

export const exportPack = (root, out) => {
  if (!out) throw new PackError('usage', '사용: pack export --out <폴더>')
  const { packDir, id, where } = requireCurrent(root)
  if (!existsSync(join(packDir, 'pack.json'))) throw new PackError('not-found', '지금 팩에 pack.json 이 없다')
  const files = collect(packDir, EXPORT_ALLOW)
  const stage = join(where.dataDir, 'tmp', `export-${randomBytes(6).toString('hex')}`)
  try {
    stageCopy(packDir, files, join(stage, id))
    addRemotes(join(stage, id, 'pack.json'), join(root, 'repos'))
    const file = tarFiles(stage, id, resolve(out), `${id}-pack`)
    // 만든 파일을 다시 읽어 허용 목록 밖·비밀 파일이 없는지 확인(만든 쪽과 다른 길로 한 번 더)
    const entries = archiveEntries(file).filter((entry) => !entry.endsWith('/')).map((entry) => entry.split('/').slice(1).join('/')).filter(Boolean)
    const outside = entries.filter((entry) => !EXPORT_ALLOW.some((allow) => entry === allow || entry.startsWith(`${allow}/`)) || EXPORT_DENY(entry))
    if (outside.length) { rmSync(file, { force: true }); throw new PackError('unsafe', `허용 목록 밖 파일이 섞였다 — 만들지 않았다: ${outside.slice(0, 5).join(', ')}`) }
    return { ok: true, file, files: entries.length, bytes: statSync(file).size }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

// 내 백업 — 팩 + 작업 기록(계획서 · 이슈 · 보관함). 비밀값 · 결과물(상태 · 워크트리 · 레포)은 뺀다
export const backupWithWork = (root, out, { panes = [], report = () => {} } = {}) => {
  const { packDir, id, where } = requireCurrent(root)
  return writeWorkBackup({ root, packDir, id, data: where.dataDir, packData: where.packDataReal ?? where.packData ?? null, out, panes, report })
}

// 팩 + 작업 기록(+ 되살리기 정보) 압축 하나 — 내 백업 · 팩 삭제 전 백업이 같이 쓴다. root 는 repos/ · plans/ · issues/ 를 읽는 자리
// (본체 — 여러 팩이면 팩 데이터 링크 · 본체가 없으면 팩 데이터 자체도 된다). packData 가 없으면(옛 구조) 레포 자리 · 되살리기 정보는 뺀다
export const writeWorkBackup = ({ root, packDir, id, data, packData, out, panes = [], report = () => {}, prefix = 'work' }) => {
  const where = { packData, packDataReal: packData }
  const target = resolve(out || defaultBackupDir(data))
  const stage = join(data, 'tmp', `backup-${randomBytes(6).toString('hex')}`)
  try {
    const top = join(stage, id)
    const packFiles = collect(packDir, readdirSync(packDir))
    stageCopy(packDir, packFiles, join(top, 'pack'))
    addRemotes(join(top, 'pack', 'pack.json'), join(root, 'repos'))
    let count = packFiles.length
    // 이 컴퓨터의 레포 자리 — 같은 컴퓨터로 되살리면 레포를 그대로 잇는다(팀에 주는 내보내기에는 넣지 않는다)
    if (where.packData) {
      writeJsonAtomic(join(top, 'local.json'), localForBackup(where))
      count += 1
    }
    for (const sub of ['plans', 'issues']) {
      const base = realOr(join(root, sub))
      if (!existsSync(base)) continue
      const files = collect(base, readdirSync(base)).filter((rel) => !(sub === 'issues' && rel === 'README.md'))
      stageCopy(base, files, join(top, sub))
      count += files.length
    }
    // 되살리기 정보 — 이 창의 에이전트 대화(panes) · 워크트리(미커밋 변경 · push 안 한 커밋) — lib/restore.mjs
    const captured = where.packData ? captureRestore(root, where.packDataReal ?? where.packData, top, { panes, report }) : null
    const restore = captured && !captured.empty ? captured : null
    const pack = readPackJson(packDir) ?? {}
    writeJsonAtomic(join(top, 'athena-backup.json'), { kind: 'with-work', version: restore ? 2 : 1, id, packId: pack.id ?? null, name: pack.name ?? id, createdAt: stamp() })
    const file = tarFiles(stage, id, target, `${id}-${prefix}`)
    return { ok: true, file, files: count + 1, bytes: statSync(file).size, ...(restore ? { restore: { sessions: restore.sessions, worktrees: restore.worktrees, missing: restore.missing }, ...(restore.warnings.length ? { warnings: restore.warnings } : {}) } : {}) }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

// 가져온 되살리기 정보를 그 팩 데이터 state/restore 로(이전 것은 버린다) — 실제로 되살리는 것은 pack restore-work
const placeRestore = (dir, slot) => {
  if (!existsSync(join(dir, 'work', 'restore'))) return
  mkdirSync(join(slot, 'state'), { recursive: true })
  rmSync(join(slot, 'state', 'restore'), { recursive: true, force: true })
  renameSync(join(dir, 'work', 'restore'), join(slot, 'state', 'restore'))
}

// pack restore-work — 이 본체 팩의 되살리기 정보(state/restore)로 워크트리 · 대화 기록 · 에이전트 pane 을 되살린다.
// --dry-run 은 요약만 · --no-agents 는 에이전트 pane 을 띄우지 않는다 · --discard 는 버린다
export const restoreWorkCommand = (root, { dryRun = false, agents = true, discard = false, ack = [], report = () => {} } = {}) => {
  const where = paths(root)
  if (where.mode !== 'packs' || !where.packDataReal) throw new PackError('not-found', '여러 팩 본체가 아니다 — 되살릴 팩 데이터가 없다')
  if (discard) return discardRestore(where.packDataReal)
  return restoreWork(root, where.packDataReal, { dryRun, agents, ack, report })
}

// 작업 기록 백업 되살리기 — 검사(inspect) 뒤 같은 팩이 없으면 새로 등록, 있으면 conflict(--replace|--new 로 다시)
export const restoreWithWork = async (root, file, mode, options = {}) => {
  if (!file) throw new PackError('usage', '사용: pack restore --with-work <백업 파일> [--new|--replace]')
  const inspected = inspectSource(root, file, options)
  if (!inspected.work) {
    await importToken(root, inspected.token, 'keep')
    throw new PackError('invalid-pack', '작업 기록 백업이 아니다(athena-backup.json 없음) — 팩만 있는 파일은 pack inspect/import')
  }
  if (inspected.conflict && !mode) return { ...inspected, ok: false, error: 'conflict', message: `같은 팩이 이미 있다 — ${inspected.conflict.id}. --replace 또는 --new 로 다시` }
  try {
    const result = await importToken(root, inspected.token, mode || 'new', options)
    return { ...result, work: inspected.work }
  } catch (error) {
    // 실패하면 임시본을 남기지 않는다(token 을 돌려주지 않았으니 다시 쓸 길이 없다)
    rmSync(join(tmpRoot(dataDir(root)), inspected.token), { recursive: true, force: true })
    throw error
  }
}

// ── 현황판 토큰 ────────────────────────────────────────────────────────
export const boardToken = (root) => {
  const where = paths(root)
  const file = join(where.mode === 'packs' ? where.state : root, where.mode === 'packs' ? 'board-token' : '.board-token')
  const saved = readJson(file)
  if (!saved || !alive(saved.pid)) throw new PackError('not-found', '떠 있는 현황판이 없다')
  return { ok: true, token: saved.token, port: saved.port ?? boardPort(root) }
}

// ── 옮기기(pack migrate) — 옛 구조 본체를 여러 팩 구조로 ───────────────────
// 자동 백업 → (--yes 없으면 계획만 보여 줌) → 복사 → 대조 → 링크 전환. 원본(packs/<회사> · 옛 plans·issues)은
// 본체의 .migrate-<시각>/ 로 옮겨 둘 뿐 지우지 않는다. 두 번 돌리면 "이미 옮김" 으로 끝난다
const LEGACY_STATE = [
  ['.board-trash', 'state/board-trash'], ['.board-learn-stats.json', 'state/board-learn-stats.json'], ['.board-jev-qa.json', 'state/board-jev-qa.json'],
  ['.board-jev-learn.json', 'state/board-jev-learn.json'], ['.jev-log.jsonl', 'state/jev-log.jsonl'],
  ['.qa-runs', 'state/qa-runs'], ['.qa-auth', 'state/qa-auth'], ['.qa-baselines', 'state/qa-baselines'],
  ['.events.jsonl', 'state/events.jsonl'],
]
export const migrate = async (root, { yes = false, report = () => {} } = {}) => {
  const where = paths(root)
  const data = where.dataDir
  if (where.mode === 'packs') return { ok: true, already: true, current: currentOf(root) }
  const config = bodyConfig(root)
  if (!config.pack || !where.packDir || !existsSync(join(where.packDir, 'pack.json'))) throw new PackError('not-found', '옮길 팩이 없다(athena.config.json 의 pack)')
  const pack = readPackJson(where.packDir)
  const id = uniqueId(data, basename(where.packDir))
  const counts = {
    plans: walkFiles(realOr(join(root, 'plans')), (path) => path.endsWith('.md') || path.endsWith('.html')).length,
    issues: walkFiles(realOr(join(root, 'issues')), (path) => path.endsWith('.md') && basename(path) !== 'README.md').length,
    archive: existsSync(join(where.packDir, 'archive')) ? readdirSync(join(where.packDir, 'archive')).filter((name) => !name.startsWith('.')).length : 0,
  }
  const worktrees = listWorktrees(join(root, '.worktrees'))
  const planned = {
    pack: { from: where.packDir, to: join(data, 'packs', id, 'pack') },
    plans: { from: join(root, 'plans'), to: join(data, 'packs', id, 'plans'), count: counts.plans },
    issues: { from: join(root, 'issues'), to: join(data, 'packs', id, 'issues'), count: counts.issues },
    archive: counts.archive,
    state: LEGACY_STATE.filter(([name]) => existsSync(join(root, name))).map(([name]) => name),
    worktrees: { stay: join(root, '.worktrees'), list: worktrees },
    screen: config.screen ? `athena.config.json 의 "screen": "${config.screen}" 고정값을 지운다(화면은 pane 안 표시로 고른다)` : null,
  }
  if (!yes) return { ok: true, dryRun: true, id, planned }

  report('lock', '잠금')
  const release = takeLock(join(data, 'locks', '_migrate.lock'), `pack migrate ${root}`, { message: (owner) => `다른 옮기기가 진행 중이다(pid ${owner.pid})` })
  try {
    const blocking = busyList(root).filter((item) => ['agent', 'athena', 'heavy'].includes(item.kind))
    if (blocking.length) throw new PackError('busy', `갈아 끼우면 안 되는 작업이 돌고 있다 — ${blocking.map((item) => item.what).join(' · ')}`, { busy: blocking })
    report('backup', '자동 백업')
    const stampText = fileStamp()
    const backupDir = join(data, 'backups')
    mkdirSync(backupDir, { recursive: true })
    const backupFile = join(backupDir, `migrate-${basename(where.packDir)}-${stampText}.tar.gz`)
    const items = ['athena.config.json', ...['plans', 'issues'].filter((name) => existsSync(join(root, name))), ...planned.state]
    execFileSync('tar', ['-czhf', backupFile, ...['.env*', '*.key', '*.pem', '.npmrc', '.netrc', 'node_modules', '.git', '.qa-auth'].flatMap((pattern) => ['--exclude', pattern]), '-C', root, ...items], { stdio: ['ignore', 'ignore', 'ignore'] })
    const packBackup = tarPack(where.packDir, backupDir, `${basename(where.packDir)}-pack-before-migrate`)

    report('copy', `복사 — ${id}`)
    const slot = join(data, 'packs', id)
    if (existsSync(slot)) throw new PackError('conflict', `데이터 폴더에 같은 자리가 있다: ${slot}`)
    mkdirSync(slot, { recursive: true })
    cpSync(where.packDir, join(slot, 'pack'), { recursive: true, verbatimSymlinks: true, filter: (from) => basename(from) !== '.omc' })
    if (existsSync(join(root, 'plans'))) cpSync(realOr(join(root, 'plans')), join(slot, 'plans'), { recursive: true, filter: (from) => basename(from) !== '.gitkeep' })
    if (existsSync(join(root, 'issues'))) cpSync(realOr(join(root, 'issues')), join(slot, 'issues'), { recursive: true, filter: (from) => basename(from) !== 'README.md' })
    ensureSlot(slot)
    for (const [name, inner] of LEGACY_STATE) {
      if (existsSync(join(root, name)) && !isLink(join(root, name))) cpSync(join(root, name), join(slot, inner), { recursive: true, verbatimSymlinks: true })
    }
    writeJsonAtomic(join(slot, 'local.json'), { reposRoot: resolve(root, config.reposRoot ?? '..'), ...(config.repoPaths ? { repoPaths: config.repoPaths } : {}) })
    // 공유 ID · 형식 버전
    const packJson = readPackJson(join(slot, 'pack'))
    if (!packJson.id || !packJson.formatVersion) {
      packJson.formatVersion ??= PACK_FORMAT_VERSION
      packJson.id ??= newPackId(packJson.name ?? id)
      writeFileSync(join(slot, 'pack', 'pack.json'), `${JSON.stringify(packJson, null, 2)}\n`)
    }

    report('verify', '대조')
    const copied = workCounts(slot)
    const plansCopied = walkFiles(join(slot, 'plans'), (path) => path.endsWith('.md') || path.endsWith('.html')).length
    if (plansCopied !== counts.plans || copied.issues !== counts.issues || copied.archive !== counts.archive) {
      rmSync(slot, { recursive: true, force: true })
      throw new PackError('rollback', `복사 대조가 맞지 않아 되돌렸다(계획서 ${plansCopied}/${counts.plans} · 이슈 ${copied.issues}/${counts.issues} · 보관함 ${copied.archive}/${counts.archive})`, { rolledBack: true })
    }

    report('link', '본체 링크 전환')
    const aside = join(root, `.migrate-${stampText}`)
    mkdirSync(aside, { recursive: true })
    const moved = []
    try {
      // 옛 OVERLAY 링크 · pack · .sync · archive 링크를 걷어 낸다(원본 팩 폴더는 packs/ 에 그대로)
      const { unlinkOverlay } = await import('./overlay.mjs')
      unlinkOverlay(root)
      for (const name of ['plans', 'issues', 'repos', ...planned.state]) {
        if (existsSync(join(root, name)) || isLink(join(root, name))) { renameSync(join(root, name), join(aside, name)); moved.push(name) }
      }
      swapActive(root, slot)
      ensureBodyLinks(root)
      const nextConfig = { ...config }
      delete nextConfig.pack
      delete nextConfig.screen
      delete nextConfig.reposRoot
      delete nextConfig.repoPaths
      writeJsonAtomic(join(aside, 'athena.config.json'), config)
      writeJsonAtomic(join(root, 'athena.config.json'), nextConfig)
      updateRegistry(data, (registry) => {
        registry.packs[id] = { ...(registry.packs[id] ?? {}), packId: packJson.id, name: packJson.name ?? id, source: 'local', addedAt: stamp(), migratedFrom: root }
        registry.current = id
        bumpGeneration(registry, id)
      })
      const overlay = linkOverlay(root)
      if (overlay.clash.length) throw new Error(`코어에 같은 이름의 실제 파일: ${overlay.clash.join(', ')}`)
      const repos = syncRepos(root)
      rebuildDiagramIndex(root)
      report('done', `옮김 — ${id}`)
      return { ok: true, id, backup: backupFile, packBackup, moved: aside, unlinkedRepos: repos.unlinked, worktrees, counts }
    } catch (error) {
      // 되돌리기 — 링크를 걷고 옮겨 둔 것을 제자리로, 설정 복원, 데이터 자리 삭제
      report('rollback', `실패 — 되돌린다: ${error.message}`)
      removeLink(join(root, ACTIVE_LINK))
      for (const [name] of FIXED_LINKS) if (isLink(join(root, name))) removeLink(join(root, name))
      for (const name of moved) renameSync(join(aside, name), join(root, name))
      writeFileSync(join(root, 'athena.config.json'), `${JSON.stringify(config, null, 2)}\n`)
      rmSync(slot, { recursive: true, force: true })
      try { linkOverlay(root) } catch { /* 옛 링크 다시 걸기 실패 — bin/athena pack link */ }
      throw new PackError('rollback', `옮기지 못해 되돌렸다 — ${error.message}`, { rolledBack: true, backup: backupFile })
    }
  } finally {
    release()
  }
}

// ── 테스트 셋업 — 테스트 데이터 폴더를 지우고 fixture 팩 둘(acme · globex)을 등록 ─────────────
// 진짜 스튜디오 집(~/.athena-studio/core · data)은 절대 건드리지 않는다: 데이터 폴더 이름에 test 가 들어가야 하고 본체가 스튜디오 코어면 멈춘다
export const testSetup = async (root, { report = () => {} } = {}) => {
  const data = dataDir(root)
  const studio = join(homedir(), '.athena-studio')
  if (realOr(root) === realOr(join(studio, 'core'))) throw new PackError('unsafe', '본체가 ~/.athena-studio/core 다 — 테스트 셋업은 코어를 따로 받은 테스트 본체에서만')
  if (realOr(data) === realOr(join(studio, 'data')) || !/test/i.test(basename(data))) throw new PackError('unsafe', `테스트 데이터 폴더가 아니다: ${data} — ATHENA_DATA_DIR=/tmp/athena-test-data 처럼 이름에 test 가 든 폴더로`)
  if (where0(root).mode === 'legacy' && bodyConfig(root).pack) throw new PackError('unsafe', '옛 구조 본체(팩이 걸린)에서는 테스트 셋업을 하지 않는다')
  const fixtures = join(root, 'test', 'fixtures')
  report('clean', `테스트 데이터 지우기 — ${data}`)
  // 테스트 데이터 안 레포 워크트리 정리는 폴더째 지우는 것으로 충분하다(레포도 테스트 데이터 안에 있다)
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data, { recursive: true })
  removeLink(join(root, ACTIVE_LINK))

  report('repos', '가짜 레포 만들기')
  const repoSpec = JSON.parse(readFileSync(join(fixtures, 'repos', 'repos.json'), 'utf8'))
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'athena-test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'athena-test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } })
  for (const name of repoSpec.repos) {
    const bare = join(data, 'remotes', `${name}.git`)
    const work = join(data, 'repos-src', name)
    mkdirSync(bare, { recursive: true }); mkdirSync(work, { recursive: true })
    git(bare, ['init', '--quiet', '--bare', '-b', 'main'])
    git(work, ['init', '--quiet', '-b', 'main'])
    const readme = join(fixtures, 'repos', name, 'README.md')
    writeFileSync(join(work, 'README.md'), existsSync(readme) ? readFileSync(readme, 'utf8') : `# ${name}\n테스트용 가짜 레포\n`)
    git(work, ['add', 'README.md'])
    git(work, ['commit', '--quiet', '-m', 'init'])
    git(work, ['remote', 'add', 'origin', bare])
    git(work, ['push', '--quiet', 'origin', 'main'])
    git(work, ['fetch', '--quiet', 'origin'])
  }

  report('packs', '테스트 팩 등록')
  const registry = { formatVersion: 1, current: null, generation: 0, packs: {} }
  for (const id of ['acme', 'globex']) {
    const slot = join(data, 'packs', id)
    cpSync(join(fixtures, 'packs', id), join(slot, 'pack'), { recursive: true })
    ensureSlot(slot)
    writeJsonAtomic(join(slot, 'local.json'), { reposRoot: join(data, 'repos-src') })
    const pack = readPackJson(join(slot, 'pack'))
    registry.packs[id] = { packId: pack.id, name: pack.name, source: 'local', addedAt: stamp() }
    // 팩마다 계획서·이슈 하나씩 — 갈아 끼웠을 때 다른 팩 것이 안 보이는지 확인용
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    writeFileSync(join(slot, 'plans', 'task', `${today}-${id}-sample.md`), `# ${pack.name} 샘플 작업\n\n## Checkpoint\n- Updated: ${today}\n- Status: in_progress\n- Owner: test\n- Agent: ${pack.repos[0].agents[0]}\n- Work ref: (디스패치할 때 채운다)\n\n## 지시\n${pack.name} 팩에서만 보여야 하는 계획서\n`)
    writeFileSync(join(slot, 'issues', `${today}-${id}-sample.md`), `---\ntitle: ${pack.name} 샘플 이슈\nstatus: open\nrepo: ${pack.repos[0].name}\n---\n${pack.name} 팩에서만 보여야 하는 이슈\n`)
  }
  saveRegistry(data, registry)

  // 본체 설정 — 데이터 폴더 · 현황판 포트(4710). screen 은 넣지 않는다(pane 안 표시로 고른다)
  const config = bodyConfig(root)
  writeJsonAtomic(join(root, 'athena.config.json'), { $comment: '테스트 본체 설정 — pack test-setup 이 썼다(docs/pack.md "여러 팩 테스트")', ...config, dataDir: data, boardPort: config.boardPort ?? 4710 })
  const result = await attachPack(root, 'acme', { report })
  return { ok: true, dataDir: data, current: result.current, packs: ['acme', 'globex'], unlinkedRepos: result.unlinkedRepos }
}
const where0 = (root) => paths(root)

