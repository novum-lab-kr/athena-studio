// 스튜디오 집 — 앱이 들고 온 아테나 코어(git 번들)를 풀어 자기 자리에서 쓴다.
// 본체 · 데이터 · 포트 · 레지스트리 · 데몬 접속 파일을 모두 이 아래에 둔다.
//   ~/.athena-studio/core          주 본체(번들에서 clone 한 git 저장소 · main)
//   ~/.athena-studio/bodies/<id>   팩 본체(코어가 만든다 — 레지스트리 bodiesDir)
//   ~/.athena-studio/data          데이터 폴더(본체 athena.config.json 의 dataDir · 레지스트리 <데이터>/config.json)
//   ~/.athena-studio/daemon.json   데몬 접속 파일(개발 앱은 daemon-dev.json)
// Electron 없이 돈다(npm test · scripts/dev-app.js 가 같이 쓴다). git 은 셸을 거치지 않고 부른다
const fs = require('fs')
const os = require('os')
const path = require('path')
const model = require('./screen-model')
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
// 번들에 싣는 버전 ref — refs/athena/version/<버전>(0.2.1 · 0.2.1+3 — src/lib/version.js) → 코어 커밋.
// 코어 커밋은 athena/ 가 그대로면 여러 앱 버전에서 같으니, 버전은 커밋이 아니라 이 ref 로 따라간다(코어 version --json 의 version)
const VERSION_REF_PREFIX = 'refs/athena/version/'
const VERSION_REFSPEC = `+${VERSION_REF_PREFIX}*:${VERSION_REF_PREFIX}*`
const VERSION_NAME_RE = /^\d+\.\d+\.\d+(\+\d+)?$/

function resourcesDir({ appRoot, packaged, resourcesPath = null }) {
  return packaged ? resourcesPath : path.join(appRoot, '.dev-app', 'resources')
}

function coreBundlePath(options) {
  return path.join(resourcesDir(options), CORE_BUNDLE_NAME)
}

// 스튜디오 데이터의 현황판 포트 기준(코어 레지스트리 portBase)
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

// 번들이 실은 버전 ref(refs/athena/version/*)를 주 본체에 받는다 — 팩 본체(같은 저장소의 워크트리)도 같은 ref 를 본다.
// 이미 같으면 받지 않는다. 옛 번들(버전 ref 없음)이면 아무것도 안 한다. → 받은 ref 수 · 실패는 0(버전만 비고 켜기는 그대로)
function syncVersionRefs({ coreDir, bundle, env = gitEnv() }) {
  try {
    const wanted = git(['bundle', 'list-heads', bundle], { env }).split('\n').map((line) => line.split(' ')).filter((parts) => parts.length === 2 && parts[1].startsWith(VERSION_REF_PREFIX))
    const missing = wanted.filter(([sha, ref]) => {
      try {
        return git(['rev-parse', '--verify', '--quiet', ref], { cwd: coreDir, env }) !== sha
      } catch {
        return true
      }
    })
    if (!missing.length) return 0
    git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bundle, VERSION_REFSPEC], { cwd: coreDir, env, timeout: 300000 })
    return missing.length
  } catch {
    return 0
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
// 본체 설정에 적어 둔다. 팩이 생기면 코어는 레지스트리 packs.<id>.boardPort 를 먼저 본다
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

// 고쳐 둔 추적 파일 사본(코어의 update --backup-dirty 와 같은 모양: files/ · changes.patch · meta.json). 사본을 확인한 뒤에만 ok
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

// backupRoot 가 있으면 고쳐 둔 본체도 사본을 두고 되돌린 뒤 감는다. 없으면 dirty 로 멈춘다
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

// 코어 update 결과(contract 2 + 4.1) → 화면에 알릴 것. 건너뛴 본체(팩 작업 중 · 커밋 중 · 고쳐 둠 …) · 백업한 코어 파일 · 실패 ·
// 일하는 세션이 있었지만 바로 올린 본체(working — 코어 update-busy · 2026-10-26 "일해도 바로 올리기")
function summarizeUpdate(result) {
  const bodies = Array.isArray(result && result.bodies) ? result.bodies : []
  // blockers — 그 본체를 막은 것(짝지은 pane 이름 · 없으면 코어 설명). 같은 이름은 한 번만
  const blockersOf = (entry) => [...new Set((Array.isArray(entry.busy) ? entry.busy : []).map((item) => item && (item.pane || item.what)).filter(Boolean))]
  const skipped = bodies.filter((entry) => entry.status === 'skipped' && entry.reason !== 'missing').map((entry) => ({ id: entry.id, reason: entry.reason || 'unknown', blockers: blockersOf(entry) }))
  const failed = bodies.filter((entry) => entry.status === 'failed').map((entry) => ({ id: entry.id, error: entry.error || 'unknown' }))
  const backedUp = Array.isArray(result && result.backedUp) ? result.backedUp.filter((entry) => entry && entry.dir) : []
  const updated = bodies.filter((entry) => entry.status === 'updated').map((entry) => entry.id)
  // sessions — 그 세션들(짝지은 pane 이름 · 없으면 코어 설명). count 는 세션 수 그대로(같은 이름이 둘이어도 둘)
  const working = bodies
    .filter((entry) => entry.status === 'updated' && Array.isArray(entry.working) && entry.working.length)
    .map((entry) => ({ id: entry.id, count: entry.working.length, sessions: blockersOf({ busy: entry.working }) }))
  return { updated, skipped, failed, backedUp, working, notify: skipped.length > 0 || failed.length > 0 || backedUp.length > 0 || working.length > 0 || Boolean(result && result.ok === false && !bodies.length) }
}

// 켤 때 코어 업데이트 — 주 본체보다 번들이 앞일 때만. runCore(argv, { contract: false }) → 코어 JSON 결과(--json 은 부르는 쪽이 붙인다)
//  - 업데이트 경로(version · update --from)는 약속 번호를 싣지 않는다 — 약속이 오른 앱이 옛 코어에 약속을 실으면 코어가 contract-mismatch 로
//    거절해 영영 못 올린다(2026-10-26 약속 3 앱 · 약속 2 코어). 이미 설치된 옛 코어는 고칠 수 없으니 앱 쪽에서 뺀다
//  - 팩이 하나라도 있으면(레지스트리 packs) 코어에 맡긴다: update --from <번들> --backup-dirty — 팩에 묶인 본체마다 확정 · 팩 작업 중인 본체는 건너뜀 ·
//    고친 코어 파일은 <데이터>/backups/core-edits/ 에 사본. 일하는 세션이 있어도 올리는지는 코어가 정한다(update-busy 코어부터 · 옛 코어는 건너뜀). 설치된 코어가 이 손잡이를 모르면(4.1 전 코어) 아무것도 건드리지 않고 알린다
//  - 주 본체에 팩이 없으면(스튜디오는 첫 팩을 bodies/<id> 에 만든다) 코어 update 가 주 본체를 옮기지 않으므로 그 뒤 앱이 앞으로 감는다
const UPDATE_CAPABILITIES = ['update-from-bundle', 'backup-dirty']
const NO_CONTRACT = Object.freeze({ contract: false })
// 쉬는 세션은 업데이트를 막지 않는다(결정 D1) — 코어가 이 손잡이를 알면 데몬 pane 상태 파일을 넘긴다(update --panes-state)
const IDLE_PANES_CAPABILITY = 'idle-panes'

// 데몬 pane 상태 → 코어에 넘길 모양 { at, panes:[{ id, label, pid, agent, status }] }.
// panes: pane list 결과 · pids: pane pids 결과(pane id → 셸 pid) · waiting: 질문 · 고르기 창을 띄운 pane id 들(screen-model waitingForInput).
// status 는 데몬 agent_status 그대로(idle · working · unknown) — 단 idle 인데 질문을 기다리면 waiting(일하는 중으로 막는다). 셸 pid 를 모르는 pane 은 뺀다
function panesState({ panes, pids, waiting = [], now = new Date() }) {
  const waitingIds = new Set(waiting)
  const list = []
  for (const pane of Array.isArray(panes) ? panes : []) {
    const pid = pids && pids[pane.id]
    if (!Number.isInteger(pid) || pid <= 0) continue
    let status = typeof pane.agent_status === 'string' ? pane.agent_status : 'unknown'
    if (status === 'idle' && waitingIds.has(pane.id)) status = 'waiting'
    list.push({ id: pane.id, label: pane.label || pane.name || pane.id, pid, agent: pane.agent || null, status })
  }
  return { at: now.toISOString(), panes: list }
}

// ── 초기화(메뉴 보기 › 스튜디오 초기화) — 처음 켠 것처럼 ──
// 끌 현황판(코어 + 팩마다)과 지울 자리. 스튜디오 집 안 것만 — 회사 레포 클론(홈 아래)은 건드리지 않는다
function resetPlan(layout) {
  const registry = readJson(path.join(layout.data, 'config.json')) || {}
  const packs = registry.packs && typeof registry.packs === 'object' ? registry.packs : {}
  const boards = []
  if (fs.existsSync(layout.core)) {
    const coreConfig = readJson(path.join(layout.core, 'athena.config.json')) || {}
    boards.push({ port: Number.isInteger(coreConfig.boardPort) ? coreConfig.boardPort : STUDIO_PORT_BASE, dir: layout.core })
  }
  for (const entry of Object.values(packs)) {
    if (entry && Number.isInteger(entry.boardPort) && typeof entry.body === 'string' && fs.existsSync(entry.body)) boards.push({ port: entry.boardPort, dir: entry.body })
  }
  return { packs: Object.keys(packs), boards, remove: [layout.core, layout.bodies, layout.data, layout.endpoint, model.idsPath(layout.endpoint)] }
}

// 지운다 — 스튜디오 집 안(집 자체는 빼고)이 아닌 자리는 건너뛴다(다른 앱의 접속 파일 daemon.json 등은 목록에 없어 남는다)
function resetHome(layout, plan) {
  const removed = []
  for (const target of plan.remove) {
    const relative = path.relative(layout.root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(target)
  }
  return removed
}

function registryHasPacks(dataDir) {
  const registry = readJson(path.join(dataDir, 'config.json'))
  return Boolean(registry && registry.packs && typeof registry.packs === 'object' && Object.keys(registry.packs).length)
}

// panesStateFile: async () → 데몬 pane 상태 파일 경로 | null(데몬 없음 · 못 읽음) — 코어가 idle-panes 를 알 때만 부른다
async function updateCore({ coreDir, dataDir, bundle, runCore, panesStateFile = null, env = gitEnv() }) {
  const status = bundleStatus({ coreDir, bundle, env })
  if (status.state !== 'ahead') return { state: status.state, head: status.head || null, target: status.target || null }
  const base = { head: status.head, target: status.target }
  const packless = isPackless(coreDir)
  let coreUpdate = null
  if (!packless || registryHasPacks(dataDir)) {
    // 설치된 코어(주 본체 코드)가 번들 업데이트를 아는가(4.1 손잡이)
    const version = await runCore(['version'], NO_CONTRACT)
    const capabilities = Array.isArray(version && version.capabilities) ? version.capabilities : []
    if (!UPDATE_CAPABILITIES.every((name) => capabilities.includes(name))) return { state: 'unsupported', ...base }
    const args = ['update', '--from', bundle, '--backup-dirty']
    const stateFile = panesStateFile && capabilities.includes(IDLE_PANES_CAPABILITY) ? await panesStateFile().catch(() => null) : null
    if (stateFile) args.push('--panes-state', stateFile)
    const result = await runCore(args, NO_CONTRACT)
    coreUpdate = { result, summary: summarizeUpdate(result) }
  }
  if (!packless) return { state: coreUpdate.result && coreUpdate.result.ok ? 'updated' : 'partial', ...coreUpdate, ...base }
  const moved = fastForwardPackless({ coreDir, bundle, backupRoot: path.join(dataDir, 'backups', 'core-edits'), env })
  // 주 본체(앱이 감음) 몫 — 백업했으면 · 못 감았으면 알린다
  const mainBackup = moved.backedUp && moved.backedUp.ok ? [{ id: 'core', dir: moved.backedUp.dir, files: moved.backedUp.files }] : []
  const mainFailed = moved.ok ? [] : [{ id: 'core', error: moved.error }]
  const empty = { updated: [], skipped: [], failed: [], backedUp: [], working: [], notify: false }
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
async function prepareCore({ layout, bundle, home, runCore, panesStateFile = null, update = true, env = gitEnv() }) {
  const installed = installCore({ bundle, coreDir: layout.core, env })
  if (!installed.ok) return installed
  syncVersionRefs({ coreDir: layout.core, bundle, env })
  const config = ensureCoreConfig(layout.core, { dataDir: layout.data, reposRoot: home, boardPort: STUDIO_PORT_BASE })
  if (!config.ok) return config
  // bodiesDir 는 데이터 폴더 기준 상대 경로 — 스튜디오 집을 통째로 옮겨도 맞는다
  const registry = ensureRegistry(layout.data, { bodiesDir: path.relative(layout.data, layout.bodies), portBase: STUDIO_PORT_BASE })
  if (!registry.ok) return registry
  if (installed.created || !update) return { ok: true, created: installed.created, update: null }
  return { ok: true, created: false, update: await updateCore({ coreDir: layout.core, dataDir: layout.data, bundle, runCore, panesStateFile, env }) }
}

// ── 개발 앱 — 레포 athena/(스튜디오 코어)의 커밋 기록으로 번들 만들기(scripts/dev-app.js start) ──
// athena/ 폴더 기록만 뽑아(git subtree split) 같은 기록이면 늘 같은 커밋을 낸다(코어 커밋의 후손 — 앞으로 감기가 된다). athena/ 트리가 그대로면 다시 만들지 않는다.
// 커밋하지 않은 athena/ 변경은 들어가지 않는다. 레포 ref 는 만들지 않는다(임시 bare 저장소 + alternates 에서 번들을 만든다)
// version: 이 앱 체크아웃의 버전 — 번들에 버전 ref 로 싣는다(위 VERSION_REF_PREFIX)
function makeCoreBundle({ repoRoot, out, prefix = 'athena', version = null, env = gitEnv(), log = () => {} }) {
  const versionName = version && VERSION_NAME_RE.test(version) ? version : null
  let tree
  try {
    tree = git(['rev-parse', `HEAD:${prefix}`], { cwd: repoRoot, env })
  } catch (error) {
    return { ok: false, error: 'no-subtree', message: String(error.stderr || error.message).trim().slice(0, 300) }
  }
  const marker = `${out}.json`
  const saved = readJson(marker)
  if (saved && saved.tree === tree && (saved.version || null) === versionName && saved.commit && bundleHead(out, { env }) === saved.commit) return { ok: true, built: false, commit: saved.commit, tree, version: versionName }
  // 트리가 같으면 subtree split(오래 걸린다)을 다시 돌리지 않고 지난 커밋을 쓴다 — 버전(0.2.1+N)만 바뀐 앱 커밋마다 split 하지 않게
  const reuse = Boolean(saved && saved.tree === tree && saved.commit && gitOk(['cat-file', '-e', `${saved.commit}^{commit}`], { cwd: repoRoot, env }))
  let commit
  if (reuse) {
    log(`코어 번들 다시 묶기(버전 ${versionName || '-'}) — ${prefix}/ 트리 그대로 · 커밋 ${saved.commit.slice(0, 12)}`)
    commit = saved.commit
  } else {
    log(`코어 번들 만들기 — ${prefix}/ 트리 ${tree.slice(0, 12)}`)
    commit = git(['subtree', 'split', '--prefix', prefix, 'HEAD'], { cwd: repoRoot, env, timeout: 600000 }).split('\n').pop().trim()
  }
  const objects = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, env })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-core-bundle-'))
  const building = `${out}.building-${process.pid}`
  try {
    git(['init', '--quiet', '--bare', scratch], { env })
    fs.writeFileSync(path.join(scratch, 'objects', 'info', 'alternates'), path.join(objects, 'objects') + '\n')
    git(['update-ref', 'refs/heads/main', commit], { cwd: scratch, env })
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: scratch, env })
    const refs = ['HEAD', 'main']
    if (versionName) {
      git(['update-ref', `${VERSION_REF_PREFIX}${versionName}`, commit], { cwd: scratch, env })
      refs.push(`${VERSION_REF_PREFIX}${versionName}`)
    }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    git(['bundle', 'create', '--quiet', building, ...refs], { cwd: scratch, env, timeout: 600000 })
    fs.renameSync(building, out)
    writeJson(marker, { tree, commit, version: versionName, at: new Date().toISOString() })
    return { ok: true, built: true, commit, tree, version: versionName }
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
  panesState,
  updateCore,
  prepareCore,
  makeCoreBundle,
  syncVersionRefs,
  VERSION_REF_PREFIX,
  resetPlan,
  resetHome,
}
