// 스튜디오 집 — 앱이 들고 온 아테나 코어(git 번들)를 풀어 자기 자리에서 쓴다(아테나 계획서 20261019-스튜디오-코어-내장 4.2).
// ~/athena(herdr 용 아테나)와는 완전히 다른 앱이다 — 본체 · 데이터 · 포트 · 레지스트리 · 데몬 접속 파일을 나누지 않는다.
//   ~/.athena-studio/core          주 본체(번들에서 clone 한 git 저장소 · main)
//   ~/.athena-studio/bodies/<id>   팩 본체(코어가 만든다 — 레지스트리 bodiesDir)
//   ~/.athena-studio/data          데이터 폴더(본체 athena.config.json 의 dataDir · 레지스트리 <데이터>/config.json)
//   ~/.athena-studio/daemon.json   데몬 접속 파일(개발 앱은 daemon-dev.json)
// Electron 없이 돈다(npm test · scripts/dev-app.js 가 같이 쓴다). git 은 셸을 거치지 않고 부른다
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

// ── 앱 신원 — 개발 앱(npm start)과 배포판이 앱 데이터(userData) · 데몬 접속 파일을 같이 쓰지 않게 ──
// 개발 앱 번들 ID 는 scripts/dev-app.js(kr.novum-lab.athena-studio.dev)
function appIdentity({ packaged }) {
  if (packaged) return { flavor: 'release', name: 'Athena Studio', endpointName: 'daemon.json', socketTag: '' }
  return { flavor: 'dev', name: 'Athena Studio Dev', endpointName: 'daemon-dev.json', socketTag: '-dev' }
}

// 스튜디오 집 자리. override(ATHENA_STUDIO_HOME) — 격리 실행(시험)용. Electron 은 HOME 을 바꿔도 진짜 홈을 쓰므로 자리를 직접 준다
function studioLayout({ home, override = null, identity }) {
  const root = override ? path.resolve(override) : path.join(home, '.athena-studio')
  return {
    root,
    core: path.join(root, 'core'),
    bodies: path.join(root, 'bodies'),
    data: path.join(root, 'data'),
    endpoint: path.join(root, identity.endpointName),
  }
}

// 앱 데이터 폴더(설정 · 데몬 소켓 · 로그) — 격리 실행이면 스튜디오 집 안
function userDataDir({ appData, identity, override = null }) {
  return override ? path.join(path.resolve(override), 'app', identity.name) : path.join(appData, identity.name)
}

// ── 앱 리소스 자리 — 들고 온 코어 번들은 여기 하나 ──
// 개발 앱: 레포의 .dev-app/resources/(npm start 가 레포 athena/ 에서 만든다 · git 무시)
// 배포판(나중 — 패키징은 다음 계획): process.resourcesPath(extraResources 로 같은 이름을 넣는다)
const CORE_BUNDLE_NAME = 'athena-core.bundle'

function resourcesDir({ appRoot, packaged, resourcesPath = null }) {
  return packaged ? resourcesPath : path.join(appRoot, '.dev-app', 'resources')
}

function coreBundlePath(options) {
  return path.join(resourcesDir(options), CORE_BUNDLE_NAME)
}

// 스튜디오 데이터의 현황판 포트 기준 — ~/athena(4700대)와 부딪히지 않게(코어 레지스트리 portBase)
const STUDIO_PORT_BASE = 4800

// ── git ──
// 물려받은 GIT_* (git 훅 안에서 켠 경우 등)가 다른 저장소를 가리키지 않게 지운다
function gitEnv(baseEnv = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) if (!key.startsWith('GIT_')) env[key] = value
  return { ...env, GIT_TERMINAL_PROMPT: '0' }
}

function git(args, { cwd = undefined, env = gitEnv(), timeout = 120000 } = {}) {
  return execFileSync('git', args, { cwd, env, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOk(args, options) {
  try {
    git(args, options)
    return true
  } catch {
    return false
  }
}

// 번들의 main 커밋 — 없거나 번들이 아니면 null
function bundleHead(bundle, options = {}) {
  if (!isFile(bundle)) return null
  try {
    const line = git(['bundle', 'list-heads', bundle, 'refs/heads/main'], options).split('\n').find((entry) => entry.endsWith(' refs/heads/main'))
    return line ? line.split(' ')[0] : null
  } catch {
    return null
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// 반쯤 쓴 파일이 남지 않게
function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// ── 첫 실행 — 번들 → 주 본체 ──
// 옆 임시 자리에 clone 하고 다 되면 바꿔 넣는다(중간에 꺼져도 반쯤 받은 본체가 남지 않게). 이미 있으면 건드리지 않는다
function installCore({ bundle, coreDir, env = gitEnv() }) {
  if (fs.existsSync(coreDir)) return { ok: true, created: false }
  if (!bundleHead(bundle, { env })) return { ok: false, error: 'bundle-missing', bundle }
  fs.mkdirSync(path.dirname(coreDir), { recursive: true })
  const building = path.join(path.dirname(coreDir), `.core-installing-${process.pid}`)
  fs.rmSync(building, { recursive: true, force: true })
  try {
    // origin = 번들 — 코어가 새 팩 본체를 만들 때 배포 커밋(레지스트리 deploy.commit → origin/main)을 본다.
    // 받아 오기는 늘 그때 들고 온 번들 경로로 한다(update --from · fastForwardPackless) — 번들 자리가 바뀌어도 된다
    git(['clone', '--quiet', '--branch', 'main', bundle, building], { env, timeout: 300000 })
    fs.renameSync(building, coreDir)
    return { ok: true, created: true }
  } catch (error) {
    fs.rmSync(building, { recursive: true, force: true })
    return { ok: false, error: 'clone-failed', message: String(error.stderr || error.message).trim().slice(0, 300) }
  }
}

// 주 본체 설정(athena.config.json · git 무시) — 비어 있는 키만 채운다(사용자가 바꾼 값 · 코어가 적은 값은 그대로).
// dataDir: ATHENA_DATA_DIR 대신 본체 설정 — pane 안 claude · 훅도 같은 데이터 폴더를 본다
// screen: studio — 화면 계층을 스튜디오 데몬으로. reposRoot: 회사 레포 클론 자리(두 앱이 같이 쓴다 · 홈)
// boardPort: 스튜디오 포트 기준 — 팩이 아직 없는(옛 구조) 본체는 코어가 레지스트리 portBase 를 보지 않고 본체 설정 → 4700 이라
// ~/athena 현황판(4700)과 부딪힌다. 팩이 생기면 코어는 레지스트리 packs.<id>.boardPort 를 먼저 본다
function ensureCoreConfig(coreDir, { dataDir, reposRoot, boardPort }) {
  const file = path.join(coreDir, 'athena.config.json')
  const exists = fs.existsSync(file)
  const current = exists ? readJson(file) : {}
  if (!current) return { ok: false, error: 'config-unreadable', file } // 깨진 설정은 고치지 않는다(사용자 것일 수 있다)
  const wanted = { dataDir, screen: 'studio', reposRoot, boardPort }
  const missing = Object.keys(wanted).filter((key) => current[key] === undefined)
  if (!missing.length) return { ok: true, changed: false }
  writeJson(file, { ...current, ...Object.fromEntries(missing.map((key) => [key, wanted[key]])) })
  return { ok: true, changed: true, keys: missing }
}

// 레지스트리(<데이터>/config.json — 코어 것)에 스튜디오 손잡이 — 없는 키만 더한다(코어 4.1 · 없으면 코어는 지금 동작).
// 파일이 없으면 코어 기본(readRegistry)과 같은 빈 레지스트리로 만든다. 코어가 레지스트리를 고치는 중(registry.lock)이면 이번엔 건너뛴다
function ensureRegistry(dataDir, { bodiesDir, portBase }) {
  fs.mkdirSync(dataDir, { recursive: true })
  if (fs.existsSync(path.join(dataDir, 'registry.lock'))) return { ok: true, changed: false, locked: true }
  const file = path.join(dataDir, 'config.json')
  const exists = fs.existsSync(file)
  const current = exists ? readJson(file) : { formatVersion: 1, current: null, generation: 0, packs: {} }
  if (!current) return { ok: false, error: 'registry-unreadable', file }
  const wanted = { bodiesDir, portBase }
  const missing = Object.keys(wanted).filter((key) => current[key] === undefined)
  if (!missing.length) return { ok: true, changed: false }
  writeJson(file, { ...current, ...Object.fromEntries(missing.map((key) => [key, wanted[key]])) })
  return { ok: true, changed: true, keys: missing }
}

// ── 켤 때 — 들고 온 번들이 주 본체보다 앞인가 ──
// 앞으로만 간다(번들이 뒤거나 갈라졌으면 건드리지 않는다 — 개발 앱에서 옛 브랜치로 켜도 코어를 내리지 않게).
// 번들 커밋이 본체에 없으면 번들에서 객체만 받아(ref · FETCH_HEAD 없이) 조상 관계를 본다
function bundleStatus({ coreDir, bundle, env = gitEnv() }) {
  const target = bundleHead(bundle, { env })
  if (!target) return { state: 'no-bundle' }
  let head
  try {
    head = git(['rev-parse', 'HEAD'], { cwd: coreDir, env })
  } catch {
    return { state: 'no-core', target }
  }
  if (head === target) return { state: 'same', head, target }
  if (!gitOk(['cat-file', '-e', `${target}^{commit}`], { cwd: coreDir, env })) {
    if (!gitOk(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bundle, 'refs/heads/main'], { cwd: coreDir, env, timeout: 300000 })) return { state: 'fetch-failed', head, target }
  }
  if (gitOk(['merge-base', '--is-ancestor', head, target], { cwd: coreDir, env })) return { state: 'ahead', head, target }
  if (gitOk(['merge-base', '--is-ancestor', target, head], { cwd: coreDir, env })) return { state: 'behind', head, target }
  return { state: 'diverged', head, target }
}

// 팩이 아직 없는 주 본체(첫 실행 뒤 /setup 전) — 코어 update 는 팩에 묶인 본체만 옮기므로 앱이 앞으로 감기만 한다.
// 깨끗하고(추적 파일 변경 없음) main 위일 때만. 팩 링크가 없으니 다시 걸 것도 없다.
// origin/main 도 번들 main 으로 맞춘다(clone 때와 같게 — 코어가 새 팩 본체를 만들 때 이 커밋을 본다)
function isPackless(coreDir) {
  try {
    fs.lstatSync(path.join(coreDir, '.pack-data'))
    return false
  } catch {
    return true
  }
}

// 고쳐 둔 추적 파일 사본(D4 — 코어의 update --backup-dirty 와 같은 모양: files/ · changes.patch · meta.json). 사본을 확인한 뒤에만 ok
function backupCoreEdits({ coreDir, backupRoot, env = gitEnv() }) {
  const files = git(['diff', '--name-only', 'HEAD'], { cwd: coreDir, env }).split('\n').filter(Boolean)
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)
  const dir = path.join(backupRoot, `studio-${stamp}-${process.pid}`, 'core')
  try {
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
    const copied = []
    for (const file of files) {
      const source = path.join(coreDir, file)
      if (!fs.existsSync(source)) continue // 지운 파일은 changes.patch 에만
      const target = path.join(dir, 'files', file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      if (!fs.readFileSync(target).equals(fs.readFileSync(source))) throw new Error(`사본이 다르다: ${file}`)
      copied.push(file)
    }
    fs.writeFileSync(path.join(dir, 'changes.patch'), execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: coreDir, env, maxBuffer: 256 * 1024 * 1024 }))
    writeJson(path.join(dir, 'meta.json'), { at: new Date().toISOString(), body: coreDir, head: git(['rev-parse', 'HEAD'], { cwd: coreDir, env }), files, copied, by: 'athena-studio' })
    return { ok: true, dir, files }
  } catch (error) {
    return { ok: false, error: 'backup-failed', message: error.message }
  }
}

// backupRoot 가 있으면 고쳐 둔 본체도 사본을 두고 되돌린 뒤 감는다(D4). 없으면 dirty 로 멈춘다
function fastForwardPackless({ coreDir, bundle, backupRoot = null, env = gitEnv() }) {
  if (!isPackless(coreDir)) return { ok: false, error: 'has-pack' }
  let branch = ''
  try {
    branch = git(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: coreDir, env })
  } catch {}
  if (branch !== 'main') return { ok: false, error: 'not-main' }
  if (!gitOk(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bundle, '+refs/heads/main:refs/remotes/origin/main'], { cwd: coreDir, env, timeout: 300000 })) return { ok: false, error: 'fetch-failed' }
  if (!gitOk(['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'], { cwd: coreDir, env })) return { ok: false, error: 'diverged' }
  let backedUp = null
  if (git(['status', '--porcelain', '--untracked-files=no'], { cwd: coreDir, env })) {
    if (!backupRoot) return { ok: false, error: 'dirty' }
    backedUp = backupCoreEdits({ coreDir, backupRoot, env })
    if (!backedUp.ok) return backedUp
    if (!gitOk(['reset', '--quiet', '--hard', 'HEAD'], { cwd: coreDir, env })) return { ok: false, error: 'reset-failed', backedUp }
  }
  if (!gitOk(['merge', '--quiet', '--ff-only', 'refs/remotes/origin/main'], { cwd: coreDir, env, timeout: 300000 })) return { ok: false, error: 'merge-failed', ...(backedUp ? { backedUp } : {}) }
  return { ok: true, ...(backedUp ? { backedUp } : {}) }
}

// 코어 update 결과(contract 2 + 4.1) → 화면에 알릴 것. 건너뛴 본체(일하는 중 · 고쳐 둠 …) · 백업한 코어 파일 · 실패
function summarizeUpdate(result) {
  const bodies = Array.isArray(result && result.bodies) ? result.bodies : []
  const skipped = bodies.filter((entry) => entry.status === 'skipped' && entry.reason !== 'missing').map((entry) => ({ id: entry.id, reason: entry.reason || 'unknown' }))
  const failed = bodies.filter((entry) => entry.status === 'failed').map((entry) => ({ id: entry.id, error: entry.error || 'unknown' }))
  const backedUp = Array.isArray(result && result.backedUp) ? result.backedUp.filter((entry) => entry && entry.dir) : []
  const updated = bodies.filter((entry) => entry.status === 'updated').map((entry) => entry.id)
  return { updated, skipped, failed, backedUp, notify: skipped.length > 0 || failed.length > 0 || backedUp.length > 0 || Boolean(result && result.ok === false && !bodies.length) }
}

// 켤 때 코어 업데이트 — 주 본체보다 번들이 앞일 때만. runCore(argv) → 코어 JSON 결과(--json 은 부르는 쪽이 붙인다)
//  - 팩이 하나라도 있으면(레지스트리 packs) 코어에 맡긴다: update --from <번들> --backup-dirty — 팩에 묶인 본체마다 확정 · 일하는 본체는 건너뜀 ·
//    고친 코어 파일은 <데이터>/backups/core-edits/ 에 사본. 설치된 코어가 이 손잡이를 모르면(4.1 전 코어) 아무것도 건드리지 않고 알린다
//  - 주 본체에 팩이 없으면(스튜디오는 첫 팩을 bodies/<id> 에 만든다) 코어 update 가 주 본체를 옮기지 않으므로 그 뒤 앱이 앞으로 감는다
const UPDATE_CAPABILITIES = ['update-from-bundle', 'backup-dirty']

function registryHasPacks(dataDir) {
  const registry = readJson(path.join(dataDir, 'config.json'))
  return Boolean(registry && registry.packs && typeof registry.packs === 'object' && Object.keys(registry.packs).length)
}

async function updateCore({ coreDir, dataDir, bundle, runCore, env = gitEnv() }) {
  const status = bundleStatus({ coreDir, bundle, env })
  if (status.state !== 'ahead') return { state: status.state, head: status.head || null, target: status.target || null }
  const base = { head: status.head, target: status.target }
  const packless = isPackless(coreDir)
  let coreUpdate = null
  if (!packless || registryHasPacks(dataDir)) {
    // 설치된 코어(주 본체 코드)가 번들 업데이트를 아는가(4.1 손잡이)
    const version = await runCore(['version'])
    const capabilities = Array.isArray(version && version.capabilities) ? version.capabilities : []
    if (!UPDATE_CAPABILITIES.every((name) => capabilities.includes(name))) return { state: 'unsupported', ...base }
    const result = await runCore(['update', '--from', bundle, '--backup-dirty'])
    coreUpdate = { result, summary: summarizeUpdate(result) }
  }
  if (!packless) return { state: coreUpdate.result && coreUpdate.result.ok ? 'updated' : 'partial', ...coreUpdate, ...base }
  const moved = fastForwardPackless({ coreDir, bundle, backupRoot: path.join(dataDir, 'backups', 'core-edits'), env })
  // 주 본체(앱이 감음) 몫 — 백업했으면 · 못 감았으면 알린다
  const mainBackup = moved.backedUp && moved.backedUp.ok ? [{ id: 'core', dir: moved.backedUp.dir, files: moved.backedUp.files }] : []
  const mainFailed = moved.ok ? [] : [{ id: 'core', error: moved.error }]
  const empty = { updated: [], skipped: [], failed: [], backedUp: [], notify: false }
  const prior = coreUpdate ? coreUpdate.summary : empty
  const summary = {
    ...prior,
    updated: moved.ok ? [...prior.updated, 'core'] : prior.updated,
    failed: [...prior.failed, ...mainFailed],
    backedUp: [...prior.backedUp, ...mainBackup],
  }
  summary.notify = prior.notify || mainFailed.length > 0 || mainBackup.length > 0
  if (!coreUpdate) return { state: moved.ok ? 'fast-forwarded' : 'ff-failed', error: moved.error, summary, ...base }
  const ok = Boolean(coreUpdate.result && coreUpdate.result.ok) && moved.ok
  return { state: ok ? 'updated' : 'partial', result: coreUpdate.result, summary, mainMoved: moved.ok, ...base }
}

// 켤 때 · [다시 시도] — 없으면 번들에서 풀고, 본체 설정 · 레지스트리 손잡이를 채우고, 있던 본체면 업데이트까지(update: false 면 건너뜀)
async function prepareCore({ layout, bundle, home, runCore, update = true, env = gitEnv() }) {
  const installed = installCore({ bundle, coreDir: layout.core, env })
  if (!installed.ok) return installed
  const config = ensureCoreConfig(layout.core, { dataDir: layout.data, reposRoot: home, boardPort: STUDIO_PORT_BASE })
  if (!config.ok) return config
  // bodiesDir 는 데이터 폴더 기준 상대 경로 — 스튜디오 집을 통째로 옮겨도 맞는다
  const registry = ensureRegistry(layout.data, { bodiesDir: path.relative(layout.data, layout.bodies), portBase: STUDIO_PORT_BASE })
  if (!registry.ok) return registry
  if (installed.created || !update) return { ok: true, created: installed.created, update: null }
  return { ok: true, created: false, update: await updateCore({ coreDir: layout.core, dataDir: layout.data, bundle, runCore, env }) }
}

// ── 개발 앱 — 레포 athena/(git subtree)에서 번들 만들기(scripts/dev-app.js start) ──
// subtree split 은 같은 기록이면 늘 같은 커밋을 낸다(코어 커밋의 후손 — 앞으로 감기가 된다). athena/ 트리가 그대로면 다시 만들지 않는다.
// 커밋하지 않은 athena/ 변경은 들어가지 않는다. 레포 ref 는 만들지 않는다(임시 bare 저장소 + alternates 에서 번들을 만든다)
function makeCoreBundle({ repoRoot, out, prefix = 'athena', env = gitEnv(), log = () => {} }) {
  let tree
  try {
    tree = git(['rev-parse', `HEAD:${prefix}`], { cwd: repoRoot, env })
  } catch (error) {
    return { ok: false, error: 'no-subtree', message: String(error.stderr || error.message).trim().slice(0, 300) }
  }
  const marker = `${out}.json`
  const saved = readJson(marker)
  if (saved && saved.tree === tree && saved.commit && bundleHead(out, { env }) === saved.commit) return { ok: true, built: false, commit: saved.commit, tree }
  log(`코어 번들 만들기 — ${prefix}/ 트리 ${tree.slice(0, 12)}`)
  const commit = git(['subtree', 'split', '--prefix', prefix, 'HEAD'], { cwd: repoRoot, env, timeout: 600000 }).split('\n').pop().trim()
  const objects = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, env })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-core-bundle-'))
  const building = `${out}.building-${process.pid}`
  try {
    git(['init', '--quiet', '--bare', scratch], { env })
    fs.writeFileSync(path.join(scratch, 'objects', 'info', 'alternates'), path.join(objects, 'objects') + '\n')
    git(['update-ref', 'refs/heads/main', commit], { cwd: scratch, env })
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: scratch, env })
    fs.mkdirSync(path.dirname(out), { recursive: true })
    git(['bundle', 'create', '--quiet', building, 'HEAD', 'main'], { cwd: scratch, env, timeout: 600000 })
    fs.renameSync(building, out)
    writeJson(marker, { tree, commit, at: new Date().toISOString() })
    return { ok: true, built: true, commit, tree }
  } catch (error) {
    fs.rmSync(building, { force: true })
    return { ok: false, error: 'bundle-failed', message: String(error.stderr || error.message).trim().slice(0, 300) }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

module.exports = {
  CORE_BUNDLE_NAME,
  STUDIO_PORT_BASE,
  appIdentity,
  studioLayout,
  userDataDir,
  resourcesDir,
  coreBundlePath,
  gitEnv,
  bundleHead,
  installCore,
  ensureCoreConfig,
  ensureRegistry,
  bundleStatus,
  isPackless,
  backupCoreEdits,
  fastForwardPackless,
  summarizeUpdate,
  updateCore,
  prepareCore,
  makeCoreBundle,
}
