// 팩 백업으로 "그대로" 되살리기 — 에이전트 대화(pane ↔ 세션) · 워크트리(미커밋 변경 · push 안 한 커밋)
//   담기   captureRestore — pack backup --with-work --panes <id,…> 가 백업 안 restore/ 에
//   검사   checkRestore   — pack inspect 가 압축을 푼 restore/ 를 모양 · 이름 · 링크까지 본다
//   되살림 restoreWork    — pack restore-work(본체에서) 가 <팩 데이터>/state/restore 를 읽어 워크트리 → 대화 기록 → 에이전트 pane 순서로
// 경로는 자리표로 담는다 — {pack}(팩 데이터) · {body}(본체) · {repo:<이름>}(레포 메인 체크아웃). 되살릴 때 그 컴퓨터의 자리로 푼다
// 정본 설명은 docs/pack.md "백업 · 되살리기"
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PackError } from './lock.mjs'

const RESTORE_VERSION = 1
const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i
const AGENT_NAME = /^[\w-]{1,64}$/
const PLAN_PATH = /^plans\/[^\0]+\.md$/
const WORKTREE_NAME = /^[\w.-]+\/[\w.-]+$/
const MAX_UNTRACKED_FILE = 5 * 1024 * 1024
const MAX_RESTORE_BYTES = 200 * 1024 * 1024
const MAX_PATCH = 150 * 1024 * 1024 // 코드 변경(patch)은 한도와 상관없이 담는다 — 이보다 크면 "불완전한 백업" 으로 표시하고 되살림을 끝냄으로 치지 않는다
const SECRET_NAME = /^(\.env(\..+)?|\.npmrc|\.netrc|\.pypirc|id_rsa.*|id_ed25519.*|.*\.(pem|key|p12|pfx))$/i
const SECRET_OK = /^\.env\.(example|sample|template)$/i
const SKIP_PARTS = new Set(['node_modules', '.DS_Store', '__pycache__', '.omc'])

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}
const realOr = (path) => { try { return realpathSync(path) } catch { return path } }
const inside = (root, path) => path === root || path.startsWith(root + sep)
const git = (cwd, args, options = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024, ...options })
const gitTry = (cwd, args) => { try { return git(cwd, args).trim() } catch { return null } }
const isRepoDir = (path) => existsSync(join(path, '.git'))
// Claude Code 대화 기록 폴더 — ~/.claude/projects/<cwd 의 글자 · 숫자 말고는 -> (2026-10-22 실측: 폴더를 옮겨 넣고 그 cwd 에서 --resume 하면 이어진다)
// ATHENA_CLAUDE_HOME — 시험이 진짜 ~/.claude 를 건드리지 않게(test/packs-test.sh)
export const claudeProjectDir = (cwd, home = process.env.ATHENA_CLAUDE_HOME || homedir()) => join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))

// ── 자리표 ─────────────────────────────────────────────────────────────
const repoTargets = (root) => {
  const dir = join(root, 'repos')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((name) => ({ name, real: realOr(join(dir, name)) })).filter((repo) => isRepoDir(repo.real))
}
export const placeOf = (root, packData, cwd) => {
  const real = realOr(cwd)
  const pack = realOr(packData)
  const body = realOr(root)
  if (inside(pack, real)) return `{pack}${real.slice(pack.length)}`
  if (inside(body, real)) return `{body}${real.slice(body.length)}`
  for (const repo of repoTargets(root)) if (inside(repo.real, real)) return `{repo:${repo.name}}${real.slice(repo.real.length)}`
  return real
}
export const resolvePlace = (root, packData, place) => {
  if (typeof place !== 'string' || place.includes('\0') || place.split('/').includes('..')) return null
  const match = place.match(/^\{(pack|body|repo:([\w.-]+))\}(.*)$/)
  if (!match) return place.startsWith('/') ? place : null
  const rest = match[3]
  if (rest && !rest.startsWith('/')) return null
  if (match[1] === 'pack') return realOr(packData) + rest
  if (match[1] === 'body') return realOr(root) + rest
  const repo = realOr(join(root, 'repos', match[2]))
  return isRepoDir(repo) ? repo + rest : null
}

// ── 담기 ──────────────────────────────────────────────────────────────
// 워크트리 — <팩 데이터>/worktrees/<레포>/<이름> 중 .git 이 파일인 것(git worktree)
const listWorktrees = (packData) => {
  const base = join(packData, 'worktrees')
  if (!existsSync(base)) return []
  const found = []
  for (const repo of readdirSync(base)) {
    const repoDir = join(base, repo)
    if (!lstatSync(repoDir).isDirectory()) continue
    for (const name of readdirSync(repoDir)) {
      const path = join(repoDir, name)
      try { if (lstatSync(path).isDirectory() && lstatSync(join(path, '.git')).isFile()) found.push({ repo, name: `${repo}/${name}`, path }) } catch { /* .git 없음 */ }
    }
  }
  return found
}

const untrackedOk = (rel) => {
  const parts = rel.split('/')
  if (parts.some((part) => SKIP_PARTS.has(part))) return false
  const name = parts[parts.length - 1]
  return !(SECRET_NAME.test(name) && !SECRET_OK.test(name))
}

// 백업 안 restore/ 를 만든다 — panes: 지금 이 창의 살아 있는 pane id(앱이 데몬에서). 그 pane 의 대화 기록만 담는다
export const captureRestore = (root, packData, top, { panes = [], report = () => {} } = {}) => {
  const out = join(top, 'restore')
  const warnings = []
  let bytes = 0
  const add = (size) => { bytes += size; return bytes <= MAX_RESTORE_BYTES }
  // 1) pane ↔ 대화(state/pane-sessions/<pane>.json · scripts/hooks/pane-session.py)
  const sessions = []
  const missing = [] // claude 가 도는데 기록이 없는 pane — 훅이 생기기 전에 켠 세션(메시지를 한 번 보내면 적힌다)
  const records = join(packData, 'state', 'pane-sessions')
  for (const pane of panes) {
    if (!/^[\w-]{1,32}$/.test(pane)) continue
    const record = readJson(join(records, `${pane}.json`))
    if (!record || !SESSION_ID.test(record.session ?? '') || typeof record.cwd !== 'string') { missing.push(pane); continue }
    const agent = AGENT_NAME.test(record.agent ?? '') ? record.agent : 'athena'
    const plan = typeof record.plan === 'string' && PLAN_PATH.test(record.plan) ? record.plan : null
    const project = claudeProjectDir(record.cwd)
    const log = join(project, `${record.session}.jsonl`)
    let transcript = false
    if (existsSync(log) && add(statSync(log).size)) {
      mkdirSync(join(out, 'transcripts'), { recursive: true })
      cpSync(log, join(out, 'transcripts', `${record.session}.jsonl`))
      // 하위 에이전트 기록(<세션>/subagents/…)도 — 링크는 따라가지 않는다
      if (existsSync(join(project, record.session))) cpSync(join(project, record.session), join(out, 'transcripts', record.session), { recursive: true, filter: (path) => !lstatSync(path).isSymbolicLink() })
      transcript = true
    } else if (existsSync(log)) warnings.push(`대화 기록이 너무 커서 뺐다 — ${agent}`)
    sessions.push({ agent, session: record.session, plan, cwd: placeOf(root, packData, record.cwd), transcript })
  }
  // 2) 워크트리 — HEAD · 브랜치 · staged · unstaged · 추적 안 하는 파일 · push 안 한 커밋(bundle)
  const worktrees = []
  listWorktrees(packData).forEach((tree, index) => {
    const head = gitTry(tree.path, ['rev-parse', 'HEAD'])
    if (!head) return
    const branch = gitTry(tree.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const dir = join(out, 'worktrees', String(index))
    mkdirSync(dir, { recursive: true })
    const entry = { index, name: tree.name, repo: tree.repo, branch, head, staged: false, unstaged: false, untracked: 0, bundle: false }
    report('backup', `워크트리 담기 — ${tree.name}`)
    for (const [key, args] of [['staged', ['diff', '--cached', '--binary']], ['unstaged', ['diff', '--binary']]]) {
      const patch = git(tree.path, args)
      if (!patch) continue
      const size = Buffer.byteLength(patch)
      if (size > MAX_PATCH) { entry.incomplete = true; warnings.push(`코드 변경(${key})이 너무 커서 담지 못했다 — ${tree.name} — 커밋한 뒤 다시 백업하세요`); continue }
      bytes += size
      writeFileSync(join(dir, `${key}.patch`), patch)
      entry[key] = true
    }
    const listing = git(tree.path, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    for (const rel of listing) {
      const source = join(tree.path, rel)
      let stat
      try { stat = lstatSync(source) } catch { continue }
      if (!stat.isFile() || !untrackedOk(rel)) continue
      if (stat.size > MAX_UNTRACKED_FILE || !add(stat.size)) { warnings.push(`큰 파일은 뺐다 — ${tree.name}/${rel}`); continue }
      mkdirSync(dirname(join(dir, 'untracked', rel)), { recursive: true })
      cpSync(source, join(dir, 'untracked', rel))
      entry.untracked += 1
    }
    // push 안 한 커밋 — 다른 컴퓨터에서도 같은 HEAD 로 되살리게. 원격에 다 있으면 담지 않는다
    const ahead = Number(gitTry(tree.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']) ?? 0)
    if (ahead > 0) {
      const file = join(dir, 'commits.bundle')
      try {
        git(tree.path, ['bundle', 'create', file, branch ? `refs/heads/${branch}` : 'HEAD', '--not', '--remotes'])
        if (add(statSync(file).size)) entry.bundle = true
        else { rmSync(file, { force: true }); warnings.push(`push 안 한 커밋이 너무 커서 뺐다 — ${tree.name}`) }
      } catch (error) { warnings.push(`push 안 한 커밋을 담지 못했다 — ${tree.name}: ${String(error.stderr ?? error.message).trim().slice(0, 200)}`) }
    }
    worktrees.push(entry)
  })
  if (!sessions.length && !worktrees.length) { rmSync(out, { recursive: true, force: true }); return missing.length ? { sessions: 0, worktrees: 0, bytes: 0, warnings, missing, empty: true } : null }
  writeJson(join(out, 'restore.json'), { version: RESTORE_VERSION, sessions, worktrees })
  return { sessions: sessions.length, worktrees: worktrees.length, bytes, warnings, missing }
}

// ── 검사 ──────────────────────────────────────────────────────────────
// 가져온 restore/ — 목록 모양 · 이름 · 파일만(링크 · 이상한 이름 · .. 거부). 통과하면 요약
export const checkRestore = (dir) => {
  const file = join(dir, 'restore.json')
  const data = readJson(file)
  const bad = (why) => { throw new PackError('unsafe', `백업의 되살리기 정보가 이상하다 — ${why}`) }
  if (!data || data.version !== RESTORE_VERSION || !Array.isArray(data.sessions) || !Array.isArray(data.worktrees)) bad('restore.json 모양')
  if (data.sessions.length > 100 || data.worktrees.length > 200) bad('항목이 너무 많다')
  for (const item of data.sessions) {
    if (!SESSION_ID.test(item?.session ?? '') || !AGENT_NAME.test(item?.agent ?? '')) bad(`세션 ${JSON.stringify(item?.session)}`)
    if (item.plan !== null && !(typeof item.plan === 'string' && PLAN_PATH.test(item.plan) && !item.plan.split('/').includes('..'))) bad(`계획서 ${JSON.stringify(item.plan)}`)
    if (typeof item.cwd !== 'string' || item.cwd.includes('\0') || item.cwd.split('/').includes('..')) bad(`폴더 ${JSON.stringify(item.cwd)}`)
  }
  for (const item of data.worktrees) {
    if (!Number.isInteger(item?.index) || !WORKTREE_NAME.test(item?.name ?? '') || item.name.split('/').includes('..') || item.repo !== item.name.split('/')[0]) bad(`워크트리 ${JSON.stringify(item?.name)}`)
    if (!/^[0-9a-f]{40,64}$/.test(item.head ?? '')) bad(`커밋 ${JSON.stringify(item.head)}`)
    if (item.branch !== null && !(typeof item.branch === 'string' && /^[\w./-]+$/.test(item.branch) && !item.branch.includes('..') && !item.branch.startsWith('-'))) bad(`브랜치 ${JSON.stringify(item.branch)}`)
  }
  // 파일 — 링크 없음 · 일반 파일 · 대화 기록은 <세션>.jsonl · <세션>/ 아래만
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      const stat = lstatSync(child)
      if (stat.isSymbolicLink()) bad(`링크 ${relative(dir, child)}`)
      if (stat.isDirectory()) walk(child)
      else if (!stat.isFile()) bad(`일반 파일이 아니다 ${relative(dir, child)}`)
    }
  }
  walk(dir)
  if (existsSync(join(dir, 'transcripts'))) {
    for (const name of readdirSync(join(dir, 'transcripts'))) if (!SESSION_ID.test(name.replace(/\.jsonl$/, ''))) bad(`대화 기록 ${name}`)
  }
  const agents = data.sessions.filter((item) => item.agent !== 'athena').length
  return { sessions: data.sessions.length, agents, athena: data.sessions.length - agents, worktrees: data.worktrees.length }
}

// ── 되살리기 ──────────────────────────────────────────────────────────
// 폴더만 지워진 옛 워크트리 등록(초기화 뒤) — 레포 전체 prune 대신 그 자리의 등록만 지운다(<공용 .git>/worktrees/<이름>/gitdir 가 그 자리를 가리키는 것)
const dropStaleRegistration = (repo, target) => {
  const common = gitTry(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common || !existsSync(join(common, 'worktrees'))) return
  for (const name of readdirSync(join(common, 'worktrees'))) {
    const admin = join(common, 'worktrees', name)
    let gitdir = ''
    try { gitdir = readFileSync(join(admin, 'gitdir'), 'utf8').trim() } catch { continue }
    if (gitdir === join(target, '.git') && !existsSync(target)) rmSync(admin, { recursive: true, force: true })
  }
}
const branchCheckedOut = (repo, branch) => (gitTry(repo, ['worktree', 'list', '--porcelain']) ?? '').split('\n').some((line) => line === `branch refs/heads/${branch}`)

// 추적 안 하던 파일 — 하나씩, 덮지 않고. 워크트리 안의 링크 폴더를 거쳐 밖에 쓰지 않게 거쳐 가는 폴더마다 링크인지 본다
const copyUntracked = (from, target) => {
  const walk = (rel) => {
    for (const name of readdirSync(join(from, rel))) {
      const child = rel ? `${rel}/${name}` : name
      const stat = lstatSync(join(from, child))
      if (stat.isDirectory()) { walk(child); continue }
      if (!stat.isFile()) continue
      let cur = target
      let safe = true
      for (const part of child.split('/').slice(0, -1)) {
        cur = join(cur, part)
        if (existsSync(cur) || isLinkPath(cur)) { const at = lstatSync(cur); if (at.isSymbolicLink() || !at.isDirectory()) { safe = false; break } }
      }
      const dest = join(target, child)
      if (!safe || existsSync(dest) || isLinkPath(dest)) continue
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(join(from, child), dest)
    }
  }
  walk('')
}
const isLinkPath = (path) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }

// 워크트리 하나 — 단계(added → staged → unstaged → untracked → done)를 progress 에 적어 가며. 실패하면 그 단계에서 멈추고 다시 부르면 거기서 잇는다
const restoreWorktree = (root, packData, dir, item, state, save) => {
  const link = join(root, 'repos', item.repo)
  const repo = realOr(link)
  if (!isLinkPath(link) || !isRepoDir(repo)) return { status: 'skipped', reason: 'repo-unlinked', message: `레포가 이어지지 않았다 — ${item.repo}` }
  const base = join(realOr(packData), 'worktrees')
  for (const path of [base, join(base, item.repo)]) if (isLinkPath(path)) return { status: 'failed', reason: 'unsafe', message: `워크트리 자리가 링크다 — ${path}` }
  const target = join(base, item.name)
  const src = join(dir, 'worktrees', String(item.index))
  const fail = (reason, error) => ({ status: 'failed', reason, message: String(error?.stderr ?? error?.message ?? error).trim().slice(0, 300), path: target })
  if (state.step && !existsSync(target)) { for (const key of Object.keys(state)) delete state[key]; save() } // 만든 워크트리가 사라졌다 — 처음부터
  if (!state.step) {
    if (existsSync(target) || isLinkPath(target)) return { status: 'skipped', reason: 'exists', message: `그 자리에 이미 폴더가 있다 — ${target}` }
    // 커밋이 없으면(다른 컴퓨터 · push 안 한 커밋) 백업의 bundle 에서 받는다
    if (gitTry(repo, ['cat-file', '-e', `${item.head}^{commit}`]) === null && existsSync(join(src, 'commits.bundle'))) {
      try { git(repo, ['bundle', 'unbundle', join(src, 'commits.bundle')]) } catch { /* 아래에서 다시 본다 */ }
    }
    if (gitTry(repo, ['cat-file', '-e', `${item.head}^{commit}`]) === null) return { status: 'failed', reason: 'commit-missing', message: `커밋 ${item.head.slice(0, 7)} 이 레포에 없다 — ${item.repo} 를 fetch 한 뒤 다시` }
    // 브랜치 — 그대로면 그 브랜치, 그 뒤로 움직였거나 다른 워크트리가 쓰면 <브랜치>-restored(-n) 를 저장한 HEAD 에서(patch 는 늘 그 HEAD 기준)
    dropStaleRegistration(repo, target)
    const args = ['worktree', 'add']
    let branch = item.branch
    let renamed = null
    if (branch) {
      const tip = gitTry(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      if (tip === item.head && !branchCheckedOut(repo, branch)) args.push(target, branch)
      else if (tip === null) args.push('-b', branch, target, item.head)
      else {
        renamed = `${branch}-restored`
        for (let n = 2; gitTry(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${renamed}`]) !== null; n += 1) renamed = `${branch}-restored-${n}`
        args.push('-b', renamed, target, item.head)
        branch = renamed
      }
    } else args.push('--detach', target, item.head)
    mkdirSync(dirname(target), { recursive: true })
    try { git(repo, args) } catch (error) { return fail('worktree-add', error) }
    Object.assign(state, { step: 'added', path: target, branch, ...(renamed ? { renamed } : {}) })
    save()
  }
  // staged 가 안 되면 멈춘다 — unstaged patch 는 staged 를 얹은 상태 기준이라 그 위에만 얹는다(git apply 는 patch 하나를 통째로 하거나 안 한다)
  if (state.step === 'added') {
    if (item.staged) { try { git(target, ['apply', '--index', '--binary', join(src, 'staged.patch')]) } catch (error) { return fail('patch-staged', error) } }
    state.step = 'staged'; save()
  }
  if (state.step === 'staged') {
    if (item.unstaged) { try { git(target, ['apply', '--binary', join(src, 'unstaged.patch')]) } catch (error) { return fail('patch-unstaged', error) } }
    state.step = 'unstaged'; save()
  }
  if (state.step === 'unstaged') {
    if (existsSync(join(src, 'untracked'))) copyUntracked(join(src, 'untracked'), target)
    state.step = 'untracked'; save()
  }
  // 백업 때 담지 못한 코드 변경이 있으면 끝냄으로 치지 않는다(되살리기 정보는 남는다 — 버리려면 --discard)
  if (item.incomplete) return { status: 'failed', reason: 'incomplete-backup', message: '백업 때 코드 변경이 너무 커서 일부를 담지 못했다', path: target }
  state.step = 'done'; save()
  return { status: 'done', path: target, branch: state.branch, ...(state.renamed ? { renamed: state.renamed } : {}) }
}

// 대화가 든 기록인가 — 사용자 메시지 줄이 하나라도 있으면. 세션이 살아 있는 채로 파일이 지워지면 Claude 가 설정 줄만 든 새 파일을 다시 쓴다(2026-10-22 실측)
const hasMessages = (file) => { try { return readFileSync(file, 'utf8').includes('"type":"user"') } catch { return false } }

// 대화 기록 — 그 컴퓨터에 없을 때만 새 cwd 의 기록 폴더로 넣는다. 있으면 그대로 · 대화 없는 껍데기만 있으면 옆에 남기고(.bak-<시각>) 백업 것으로
const restoreTranscript = (dir, item, cwd) => {
  const project = claudeProjectDir(cwd)
  const log = join(project, `${item.session}.jsonl`)
  const source = join(dir, 'transcripts', `${item.session}.jsonl`)
  if (existsSync(log) && (hasMessages(log) || !hasMessages(source))) return 'present'
  if (!existsSync(source)) return 'missing'
  mkdirSync(project, { recursive: true })
  if (existsSync(log)) renameSync(log, `${log}.bak-${Date.now()}`)
  cpSync(source, log)
  if (existsSync(join(dir, 'transcripts', item.session))) cpSync(join(dir, 'transcripts', item.session), join(project, item.session), { recursive: true, force: false, errorOnExist: false })
  return 'copied'
}

// 본체(root)에서 — <팩 데이터>/state/restore 를 되살린다. dryRun 이면 요약만. agents=false 면 에이전트 pane 은 띄우지 않는다.
// 결과의 athena[] 는 본체 아테나 세션 — 앱이 아테나 pane 을 claude --resume 으로 켠다. 다 되면 state/restore 를 지운다(실패 · 건너뛴 것은 남겨 다시 시도)
export const restoreWork = (root, packData, { dryRun = false, agents = true, ack = [], report = () => {} } = {}) => {
  const dir = join(packData, 'state', 'restore')
  if (!existsSync(join(dir, 'restore.json'))) return { ok: true, pending: false }
  const summary = checkRestore(dir)
  const data = readJson(join(dir, 'restore.json'))
  const progressFile = join(dir, 'progress.json')
  const progress = readJson(progressFile) ?? { worktrees: {}, sessions: {} }
  const save = () => writeJson(progressFile, progress)
  const remainingNow = () => data.worktrees.filter((item) => progress.worktrees[item.index]?.step !== 'done').length + data.sessions.filter((item) => progress.sessions[item.session]?.status !== 'done').length
  const finish = (result) => {
    const remaining = remainingNow()
    if (!remaining) rmSync(dir, { recursive: true, force: true })
    return { ok: true, ...result, pending: remaining > 0, remaining }
  }
  if (dryRun) return { ok: true, pending: true, ...summary, done: { worktrees: data.worktrees.filter((item) => progress.worktrees[item.index]?.step === 'done').length, sessions: Object.keys(progress.sessions).length } }
  // 아테나 대화 — 앱이 아테나 pane 을 그 대화로 켠 뒤에 --ack 로 알린다(그 전에는 끝냄으로 치지 않는다)
  if (ack.length) {
    for (const session of ack) if (data.sessions.some((item) => item.session === session && item.agent === 'athena')) progress.sessions[session] = { status: 'done' }
    save()
    return finish({ acked: ack.length })
  }
  const worktrees = []
  for (const item of data.worktrees) {
    const state = (progress.worktrees[item.index] ??= {})
    if (state.step === 'done') continue
    report('worktree', `워크트리 되살리기 — ${item.name}`)
    worktrees.push({ name: item.name, ...restoreWorktree(root, packData, dir, item, state, save) })
  }
  const sessions = []
  const athena = []
  for (const item of data.sessions) {
    if (progress.sessions[item.session]?.status === 'done') continue
    const cwd = resolvePlace(root, packData, item.cwd)
    if (!cwd || !existsSync(cwd)) { sessions.push({ session: item.session, agent: item.agent, status: 'skipped', reason: 'cwd-missing', message: `폴더가 없다 — ${item.cwd}` }); continue }
    const transcript = restoreTranscript(dir, item, cwd)
    if (item.agent === 'athena') { athena.push({ session: item.session, cwd, transcript }); continue }
    if (!agents) { sessions.push({ session: item.session, agent: item.agent, status: 'skipped', reason: 'agents-off' }); continue }
    if (!item.plan || !existsSync(join(root, item.plan))) { sessions.push({ session: item.session, agent: item.agent, status: 'skipped', reason: 'plan-missing', message: `계획서가 없다 — ${item.plan ?? '(없음)'}` }); continue }
    report('agent', `에이전트 다시 열기 — ${item.agent}`)
    // delegate.sh 가 그 레포 작업 공간에 pane 을 놓고 claude --resume 으로 잇는다(지시문은 다시 보내지 않는다) — 인자로만 넘긴다(셸 글로 잇지 않는다)
    const run = spawnSync('bash', [join(root, 'scripts', 'delegate.sh'), item.agent, '--plan', item.plan, '--resume', item.session, '--cwd', cwd], { cwd: root, encoding: 'utf8', timeout: 120000 })
    const result = run.status === 0 ? { status: 'done', pane: (run.stdout.match(/^(\S+)\s/m) ?? [])[1] ?? null } : { status: 'failed', reason: 'delegate', message: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().slice(-300) }
    sessions.push({ session: item.session, agent: item.agent, transcript, ...result })
    if (result.status === 'done') progress.sessions[item.session] = result
    save()
  }
  return finish({ worktrees, sessions, athena })
}

// 되살리기 정보 버리기
export const discardRestore = (packData) => {
  rmSync(join(packData, 'state', 'restore'), { recursive: true, force: true })
  return { ok: true }
}
