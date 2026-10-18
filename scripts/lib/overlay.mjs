// 팩 파일을 코어 자리에 거는 링크(OVERLAY) — athena pack link · pack use 가 같이 쓴다.
//
// 옛 구조: 링크가 팩 실제 폴더(packs/<회사>/…)를 가리킨다. pack · .sync · archive 도 여기서 건다
// 여러 팩: 링크가 본체의 논리 경로 pack/…(= .pack-data/pack/…)를 가리킨다 → 팩을 바꿔도 같은 이름 파일은 그대로 이어진다.
//          pack · plans · issues · archive · .sync · repos · 상태 파일은 고정 링크(scripts/lib/packs.mjs FIXED_LINKS)라 여기서 다루지 않는다
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { ACTIVE_LINK, paths } from './config.mjs'

// 팩 안 경로 → 코어 자리. each = 그 폴더의 항목마다 링크(코어 폴더에 코어 파일과 섞여 있다), whole = 폴더째 링크
export const OVERLAY = [
  { from: 'agents', to: '.claude/agents', each: true },
  { from: 'skills', to: '.claude/skills', each: true },
  { from: 'knowledge', to: 'docs/knowledge', each: true },
  { from: 'docs', to: 'docs', each: true },
  { from: 'diagrams', to: 'docs/diagrams', each: true },
  { from: 'verify', to: 'scripts/verify', each: true },
  { from: 'scripts', to: 'scripts', each: true },
  { from: 'qa/docs', to: 'docs/qa' },
  { from: 'qa/routes', to: 'scripts/qa/routes' },
  { from: 'qa/scenarios', to: 'scripts/qa/scenarios' },
  { from: 'sync', to: '.sync', legacyOnly: true },
  { from: 'archive', to: 'archive', legacyOnly: true },
]

// 여러 팩 구조의 고정 링크 이름 — OVERLAY 정리에서 지우지 않는다(scripts/lib/packs.mjs 와 같은 목록)
export const FIXED_NAMES = new Set(['pack', 'plans', 'issues', 'repos', '.worktrees', 'archive', '.sync', ACTIVE_LINK,
  '.board-trash', '.board-learn-stats.json', '.board-jev-qa.json', '.board-jev-learn.json', '.jev-log.jsonl', '.qa-runs', '.qa-auth', '.qa-baselines'])

const SKIP_WALK = new Set(['.git', 'node_modules', 'repos', '.worktrees', 'packs', ACTIVE_LINK, 'plans', 'issues', 'archive', 'test'])
export const isLink = (path) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const pointsInto = (link, dir) => { try { const real = realpathSync(link); const base = realpathSync(dir); return real === base || real.startsWith(base + '/') } catch { return false } }
const under = (path, dir) => path === dir || path.startsWith(dir + '/')

// 코어 자리 → 링크 글(상대 경로) 쌍
export const plannedLinks = (root, mode, packDir) => {
  // 여러 팩: 논리 경로 <본체>/pack 기준(실제 경로로 풀지 않는다) · 옛 구조: 팩 실제 폴더 기준
  const base = mode === 'packs' ? join(root, 'pack') : packDir
  const links = mode === 'packs' ? [] : [{ at: 'pack', target: packDir }]
  for (const { from, to, each, legacyOnly } of OVERLAY) {
    if (legacyOnly && mode === 'packs') continue
    const source = join(base, from)
    if (!existsSync(source)) continue
    if (!each) { links.push({ at: to, target: source }); continue }
    for (const name of readdirSync(source)) {
      if (name === '.DS_Store' || name === '.omc' || name === '.gitkeep') continue
      links.push({ at: join(to, name), target: join(source, name) })
    }
  }
  return links
}

// 본체 안의 "팩을 가리키는 링크" — 옛 팩(packs/…)·논리 pack/…·데이터 폴더를 가리키는 것. 고정 링크는 뺀다
export const packLinks = (root) => {
  const found = []
  const where = paths(root)
  const targets = [join(root, 'pack'), join(root, 'packs'), join(root, ACTIVE_LINK)]
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir)) {
      if (depth === 0 && (SKIP_WALK.has(name) || FIXED_NAMES.has(name))) continue
      if (name === '.git' || name === 'node_modules') continue
      const path = join(dir, name)
      if (isLink(path)) {
        const text = readlinkSync(path)
        const logical = resolve(dirname(path), text)
        if (text.includes('packs/') || targets.some((target) => under(logical, target)) || pointsInto(path, join(root, 'packs')) || (existsSync(where.dataDir) && pointsInto(path, where.dataDir))) found.push(relative(root, path))
      } else if (depth < 3 && lstatSync(path).isDirectory()) walk(path, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

// .git/info/exclude 는 워크트리들이 같이 쓴다(git common dir) — 체크아웃마다 자기 구간(경로로 표시)만 바꾼다.
// 남의 체크아웃 구간은 그대로 두고(그 체크아웃의 팩 링크 목록이다), 폴더가 사라진 체크아웃의 구간과 옛 표시(경로 없는 구간)는 치운다
const EXCLUDE_START = '# >>> athena pack links (athena pack link 가 관리)'
const EXCLUDE_END = '# <<< athena pack links'
export const writeExclude = (root, linkPaths) => {
  let gitDir
  try { gitDir = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return }   // git 레포가 아니면(복사본) 건너뛴다
  const file = resolve(root, gitDir, 'info', 'exclude')
  // 무시 경로는 git 루트 기준이다 — 아테나가 다른 레포 안(예: 스튜디오 레포의 athena/ subtree)이면 그 앞자리를 붙인다
  const prefix = execFileSync('git', ['-C', root, 'rev-parse', '--show-prefix'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  mkdirSync(dirname(file), { recursive: true })
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  // 표시 문자열의 괄호를 정규식으로 escape 한다
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const section = new RegExp(`\\n?${escape(EXCLUDE_START)}( · (.+))?\\n[\\s\\S]*?${escape(EXCLUDE_END)}\\n?`, 'g')
  const kept = before.replace(section, (whole, _, owner) => (owner && owner !== root && existsSync(owner) ? whole : '\n')).replace(/\n+$/, '')
  const block = linkPaths.length ? `\n${EXCLUDE_START} · ${root}\n${linkPaths.map((path) => `/${prefix}${path}`).join('\n')}\n${EXCLUDE_END}\n` : '\n'
  writeFileSync(file, `${kept}${block}`)
}

// 링크를 맞춘다 — 겹치는 실제 파일이 하나라도 있으면 아무것도 바꾸지 않고 { clash } 를 돌려준다
export const linkOverlay = (root) => {
  const where = paths(root)
  const packDir = where.packDir
  if (!packDir) throw new Error('팩이 없다 — athena.config.json 의 pack 또는 활성 링크(.pack-data)')
  const planned = plannedLinks(root, where.mode, packDir)
  const clash = planned.filter(({ at }) => !isLink(join(root, at)) && existsSync(join(root, at))).map(({ at }) => at)
  if (clash.length) return { clash, made: [], kept: [], stale: [] }
  const made = []; const kept = []
  for (const { at, target } of planned) {
    const path = join(root, at)
    const want = relative(dirname(path), target)
    if (isLink(path)) {
      if (readlinkSync(path) === want) { kept.push(at); continue }
      rmSync(path)
    }
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(want, path)
    made.push(at)
  }
  // 팩을 바꿨으면 옛 팩 링크가 남는다 — 이번 목록에 없는 팩 링크는 지운다
  const wanted = new Set(planned.map(({ at }) => at))
  const stale = packLinks(root).filter((at) => !wanted.has(at))
  for (const at of stale) rmSync(join(root, at))
  writeExclude(root, [...made, ...kept])
  return { clash: [], made, kept, stale, packDir, mode: where.mode }
}

// 팩을 가리키는 OVERLAY 링크를 모두 지운다(고정 링크는 그대로)
export const unlinkOverlay = (root) => {
  const where = paths(root)
  const legacyPack = where.mode === 'legacy' ? where.packDir : null
  let removed = 0
  for (const at of packLinks(root)) { rmSync(join(root, at)); removed += 1 }
  // 옛 구조의 pack · .sync · archive (팩 실제 폴더를 가리키는 것)
  if (legacyPack) {
    for (const name of ['pack', '.sync', 'archive']) {
      const path = join(root, name)
      if (isLink(path) && (pointsInto(path, legacyPack) || readlinkSync(path).includes('packs/'))) { rmSync(path); removed += 1 }
    }
  }
  writeExclude(root, [])
  return removed
}
