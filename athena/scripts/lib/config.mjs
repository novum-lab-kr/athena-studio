// 아테나 설정 읽기 — 코어 스크립트는 athena.config.json 을 직접 읽지 않고 이걸 쓴다.
//   athena.config.json : 이 컴퓨터·이 본체 설정(현황판 포트 boardPort · 화면 screen · 데이터 폴더 dataDir · 옛 구조면 pack·reposRoot)
//   <pack>/pack.json   : 팩(레포 목록 · GitHub 조직 · QA · 추적 의존성 …)
//   <팩 데이터>/local.json : (여러 팩 구조) 그 팩의 이 컴퓨터 설정(reposRoot · repoPaths)
// 합치는 규칙: 팩 값 위에 이 컴퓨터 설정을 덮는다(같은 키면 이 컴퓨터가 이긴다). 단 repos 는 팩 것만.
// pack 이 없으면 athena.config.json 하나가 전부다. 파이썬 쪽 같은 규칙: scripts/lib/athena_config.py
//
// 두 가지 구조 (docs/pack.md "여러 팩")
//   옛 구조(legacy) — athena.config.json 의 pack 이 본체 안 packs/<회사> 를 가리킨다. plans/·issues/ 는 본체의 실제 폴더
//   여러 팩(packs)   — 본체의 활성 링크 .pack-data → <데이터>/packs/<id>. pack·plans·issues·repos·.worktrees … 는 그 아래를 가리키는 고정 링크
// 문서 ID 는 두 구조 모두 본체 기준 논리 경로(plans/…md · issues/…md · archive/…) — 실제 경로(<데이터>/packs/…)로 풀지 않는다
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ATHENA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const ACTIVE_LINK = '.pack-data'
export const PACK_FORMAT_VERSION = 1   // 이 코어가 읽을 수 있는 pack.json formatVersion 최댓값
// 이 코어가 읽고 쓸 수 있는 데이터 폴더 형식(<데이터>/config.json formatVersion) 범위 — 밖이면 쓰기 명령은 data-incompatible.
// athena update --from 은 대상 커밋의 이 줄을 읽어 형식이 바뀌는 업데이트인지 본다(글자 모양을 바꾸지 않는다)
export const DATA_FORMATS = [1, 1]

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const realOr = (path) => { try { return realpathSync(path) } catch { return path } }
const expandHome = (path) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

// 본체 ID — 본체 실제 경로의 sha1 앞 12자(저장하지 않고 늘 같은 값)
export const bodyIdOf = (root = ATHENA_ROOT) => createHash('sha1').update(realOr(root)).digest('hex').slice(0, 12)

// 본체 설정(athena.config.json) — 없으면 빈 값
export const bodyConfig = (root = ATHENA_ROOT) => readJson(join(root, 'athena.config.json')) ?? {}

// 사용자 데이터 폴더 — ATHENA_DATA_DIR → 본체 설정 dataDir(스튜디오가 채운다) → ~/.athena-studio/data (테스트는 ATHENA_DATA_DIR 로 따로)
export const DEFAULT_DATA_DIR = join(homedir(), '.athena-studio', 'data')
export const dataDir = (root = ATHENA_ROOT) => resolve(root, expandHome(process.env.ATHENA_DATA_DIR || bodyConfig(root).dataDir || DEFAULT_DATA_DIR))

// 데이터 폴더의 팩 목록·지금 팩·전환 세대(<데이터>/config.json)
export const readRegistry = (data) => readJson(join(data, 'config.json')) ?? { formatVersion: 1, current: null, generation: 0, packs: {} }

// ── 데이터 폴더마다 다른 손잡이(레지스트리 키 · 없으면 지금 동작) ──
// 현황판 포트 기준 — 레지스트리 portBase(주 본체 기본 포트 · 팩 본체는 +2 부터 2씩). 없거나 이상하면 4700
// 데이터 폴더마다 포트 범위를 갈라 다른 데이터 폴더(시험 등)의 꺼진 포트와 부딪히지 않게 한다
export const DEFAULT_PORT_BASE = 4700
export const portBaseOf = (registry) => {
  const value = registry?.portBase   // 숫자만(파이썬 athena_config.port_base 와 같은 판정)
  return Number.isInteger(value) && value >= 1024 && value <= 65400 ? value : DEFAULT_PORT_BASE
}
// 팩 본체 자리 — 레지스트리 bodiesDir 가 있으면 <bodiesDir>/<id>(상대 경로는 데이터 폴더 기준), 없으면 null(부른 쪽이 <주 본체>-<id>)
export const bodiesDirOf = (data, registry) => (typeof registry?.bodiesDir === 'string' && registry.bodiesDir.trim()
  ? resolve(data, expandHome(registry.bodiesDir.trim()))
  : null)
// 백업 기본 자리 — <데이터>/backups/packs
export const defaultBackupDir = (data) => join(data, 'backups', 'packs')

// 경로 묶음 — 새 코드는 이걸 쓴다(옛 코드는 고정 링크 덕에 그대로 돈다)
export const paths = (root = ATHENA_ROOT) => {
  const data = dataDir(root)
  const active = join(root, ACTIVE_LINK)
  if (!isLink(active)) {
    const local = bodyConfig(root)
    return {
      root, mode: 'legacy', dataDir: data, packData: null, packDataReal: null,
      packDir: local.pack ? resolve(root, local.pack) : null,
      plans: join(root, 'plans'), issues: join(root, 'issues'), state: root,
      worktrees: process.env.ATHENA_WORKTREE_ROOT || join(root, '.worktrees'),
      packId: null, generation: null, dataMismatch: false,
    }
  }
  const real = resolve(root, readlinkSync(active))
  const registry = readRegistry(data)
  return {
    root, mode: 'packs', dataDir: data, packData: active, packDataReal: real,
    packDir: join(root, 'pack'),
    plans: join(root, 'plans'), issues: join(root, 'issues'), state: join(active, 'state'),
    // 새 워크트리는 팩 데이터 안 실제 경로로 — git 이 실제 경로를 기록하고, 팩을 갈아 끼워도 그 팩 폴더에 남는다(D4)
    worktrees: process.env.ATHENA_WORKTREE_ROOT || join(real, 'worktrees'),
    packId: basename(real),
    // 세대는 팩마다(packs.<id>.generation) — 다른 본체의 일이 이 본체 현황판을 stale 로 만들지 않게
    generation: registry.packs?.[basename(real)]?.generation ?? 0,
    // 활성 링크가 지금 데이터 폴더 밖을 가리킨다(ATHENA_DATA_DIR 가 다른 값) — 쓰기 명령은 멈춘다
    dataMismatch: realOr(dirname(dirname(real))) !== realOr(data),
  }
}

export const loadConfig = (root = ATHENA_ROOT) => {
  const where = paths(root)
  if (where.mode === 'packs') {
    // 여러 팩 구조 — 본체 설정의 pack 은 쓰지 않는다(활성 링크가 정본)
    const { pack: _ignored, ...local } = bodyConfig(root)
    const packFile = join(where.packDir, 'pack.json')
    if (!existsSync(packFile)) throw new Error(`팩이 아직 없다: ${packFile} — 새 팩이면 claude 를 켜고 /setup`)
    const pack = JSON.parse(readFileSync(packFile, 'utf8'))
    const packLocal = readJson(join(where.packData, 'local.json')) ?? {}
    return { ...pack, ...local, ...packLocal, repos: pack.repos ?? [], packDir: where.packDir, packId: where.packId, packDataDir: where.packData }
  }
  const local = JSON.parse(readFileSync(join(root, 'athena.config.json'), 'utf8'))
  if (!local.pack) return local
  const packDir = resolve(root, local.pack)
  const packFile = join(packDir, 'pack.json')
  if (!existsSync(packFile)) throw new Error(`팩이 없다: ${packFile} — athena.config.json 의 pack 경로 확인`)
  const pack = JSON.parse(readFileSync(packFile, 'utf8'))
  return { ...pack, ...local, repos: pack.repos ?? [], packDir }
}

// 이 본체의 팩에 작업 잠금이 걸려 있나(열기·업데이트 중) — <데이터>/locks/<팩 id>.lock 의 pid 가 살아 있으면
// 새 위임·브랜치·QA 를 받지 않는다(athena_config.py switching 과 같다). 다른 팩의 잠금은 이 본체를 막지 않는다
export const isSwitching = (root = ATHENA_ROOT) => {
  const where = paths(root)
  if (where.mode !== 'packs') return false
  const lock = join(where.dataDir, 'locks', `${where.packId}.lock`)
  if (!existsSync(lock)) return false
  let pid = 0
  try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim() || 0) } catch { return false }
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

// 현황판 포트 — 여러 팩 구조: 레지스트리 packs.<id>.boardPort(정본) → 본체 설정 boardPort → ATHENA_BOARD_PORT → 레지스트리 portBase → 4700
// (앱이 물려준 환경 변수 하나가 모든 본체를 같은 포트로 만들지 않게). 옛 구조: ATHENA_BOARD_PORT → 본체 설정 → 4700
export const boardPort = (root = ATHENA_ROOT) => {
  const where = paths(root)
  if (where.mode === 'packs') {
    const registry = readRegistry(where.dataDir)
    const saved = registry.packs?.[where.packId]?.boardPort
    return Number(saved || bodyConfig(root).boardPort || process.env.ATHENA_BOARD_PORT || portBaseOf(registry))
  }
  return Number(process.env.ATHENA_BOARD_PORT || bodyConfig(root).boardPort || 4700)
}

// 레포를 맡은 에이전트 → 레포 이름 (모노레포는 앱 에이전트·packagesAgent 까지)
export const repoOfAgent = (config, agent) => config.repos.find((repo) =>
  (repo.agents ?? []).includes(agent) ||
  Object.values(repo.apps ?? {}).some((app) => app.agent === agent) ||
  repo.packagesAgent === agent)

// 계획서·이슈의 PR 링크(github.com/<조직>/<레포>/pull/<번호>) — 조직은 설정 github.org(없으면 아무 조직)
export const githubOrg = (config) => config.github?.org ?? ''
export const prLinkPattern = (org) => new RegExp(`github\\.com/${org ? org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[\\w.-]+'}/([\\w.-]+)/pull/(\\d+)`, 'g')
