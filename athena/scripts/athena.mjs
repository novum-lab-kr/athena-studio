#!/usr/bin/env node
/**
 * athena — 코어와 회사 팩을 잇는 명령
 *
 *   athena pack link      팩 파일을 코어의 정해진 자리에 링크로 건다(이미 건 것은 다시 맞춘다)
 *   athena pack unlink    팩을 가리키는 링크를 모두 지운다
 *   athena pack check     코어 파일에 팩의 회사 이름(pack.json names)이 있는지 찾는다 — 있으면 1
 *   athena pack backup [--out <폴더>]
 *                         팩 폴더를 날짜 붙은 압축 파일 하나로(기본 ~/athena-pack-backups · .env*·키 파일·node_modules 는 뺀다)
 *   athena pack restore <파일>
 *                         백업을 packs/ 에 되살린다 — 같은 이름 팩이 있으면 덮지 않고 멈춘다. 팩 없이 쓰는 중이면 설정·링크까지
 *
 *   새 회사 첫 실행(/setup 스킬이 차례로 부른다)
 *   athena init --scan [--root <폴더>] [--depth <n>] [--json]
 *                                                     reposRoot(기본 ..) 아래 n 단계(기본 3)까지 git 레포를 훑어 추정을 보여 준다(읽기 전용)
 *   athena init --pack <회사> --repos <a,b|all> [--names <x,y>] [--org <GitHub 조직>] [--agent <레포>=<이름> …]
 *                                                     고른 레포로 빈 팩(packs/<회사>)·athena.config.json 을 만들고 링크까지
 *   athena scaffold [<레포> …]                        pack.json 레포마다 에이전트·지식 뼈대·검증 스크립트 + 팩 서비스 문서·다이어그램 표(있는 파일은 그대로) + 링크
 *
 * 팩 위치는 athena.config.json 의 pack. 링크 목록은 이 컴퓨터의 .git/info/exclude 에 적어 git 이 무시하게 한다
 * (커밋되는 .gitignore 에 회사 경로를 적지 않는다). Claude Code 가 정해진 자리에서만 찾는 것(.claude/agents·skills)과
 * 스크립트가 고정 경로로 읽는 것(docs/knowledge/<레포>·scripts/verify/<레포>.sh·archive …)을 링크로 잇는다.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ATHENA_ROOT, loadConfig } from './lib/config.mjs'
import { initPack, scaffold, scanRepos } from './lib/init.mjs'
import { maskText } from './qa/live.mjs'

const ROOT = ATHENA_ROOT
const [command, sub] = process.argv.slice(2)

// 팩 안 경로 → 코어 자리. each = 그 폴더의 항목마다 링크(코어 폴더에 코어 파일과 섞여 있다), whole = 폴더째 링크
const OVERLAY = [
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
  { from: 'sync', to: '.sync' },
  { from: 'archive', to: 'archive' },
]

// 이 컴퓨터 설정 — 새 회사는 아직 없을 수 있다(athena init 이 만든다)
const local = existsSync(join(ROOT, 'athena.config.json')) ? JSON.parse(readFileSync(join(ROOT, 'athena.config.json'), 'utf8')) : {}
const packDir = () => {
  if (!local.pack) fail('athena.config.json 에 pack 이 없다 — 팩 없이 쓰는 중')
  const dir = resolve(ROOT, local.pack)
  if (!existsSync(join(dir, 'pack.json'))) fail(`팩이 없다: ${dir}/pack.json`)
  return dir
}
function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const pointsInto = (link, dir) => { try { return realpathSync(link).startsWith(realpathSync(dir) + '/') || realpathSync(link) === realpathSync(dir) } catch { return false } }

// 코어 자리 → 팩 실제 경로 쌍
const plannedLinks = (pack) => {
  const links = [{ at: 'pack', target: pack }]
  for (const { from, to, each } of OVERLAY) {
    const source = join(pack, from)
    if (!existsSync(source)) continue
    if (!each) { links.push({ at: to, target: source }); continue }
    for (const name of readdirSync(source)) {
      if (name === '.DS_Store') continue
      links.push({ at: join(to, name), target: join(source, name) })
    }
  }
  return links
}

// .git/info/exclude 는 워크트리들이 같이 쓴다(git common dir) — 체크아웃마다 자기 구간(경로로 표시)만 바꾼다.
// 남의 체크아웃 구간은 그대로 두고(그 체크아웃의 팩 링크 목록이다), 폴더가 사라진 체크아웃의 구간과 옛 표시(경로 없는 구간)는 치운다
const EXCLUDE_START = '# >>> athena pack links (athena pack link 가 관리)'
const EXCLUDE_END = '# <<< athena pack links'
const writeExclude = (paths) => {
  let gitDir
  try { gitDir = execFileSync('git', ['-C', ROOT, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return }   // git 레포가 아니면(복사본) 건너뛴다
  const file = resolve(ROOT, gitDir, 'info', 'exclude')
  // 무시 경로는 git 루트 기준이다 — 아테나가 다른 레포 안(예: 스튜디오 레포의 athena/ subtree)이면 그 앞자리를 붙인다
  const prefix = execFileSync('git', ['-C', ROOT, 'rev-parse', '--show-prefix'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  mkdirSync(dirname(file), { recursive: true })
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  // 표시 문자열의 괄호를 정규식으로 escape 한다
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const section = new RegExp(`\\n?${escape(EXCLUDE_START)}( · (.+))?\\n[\\s\\S]*?${escape(EXCLUDE_END)}\\n?`, 'g')
  const kept = before.replace(section, (whole, _, owner) => (owner && owner !== ROOT && existsSync(owner) ? whole : '\n')).replace(/\n+$/, '')
  const block = paths.length ? `\n${EXCLUDE_START} · ${ROOT}\n${paths.map((path) => `/${prefix}${path}`).join('\n')}\n${EXCLUDE_END}\n` : '\n'
  writeFileSync(file, `${kept}${block}`)
}

// 지금 팩이 아닌 팩(packs/…)을 가리키는 링크 — 팩을 바꾸면 옛 팩 링크가 남는다
const packLinks = () => {
  const found = []
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir)) {
      if (['.git', 'node_modules', 'repos', '.worktrees', 'packs'].includes(name)) continue
      const path = join(dir, name)
      if (isLink(path)) {
        if (readlinkSync(path).includes('packs/') || pointsInto(path, join(ROOT, 'packs'))) found.push(relative(ROOT, path))
      } else if (depth < 3 && lstatSync(path).isDirectory()) walk(path, depth + 1)
    }
  }
  walk(ROOT, 0)
  return found
}

const link = () => {
  const pack = packDir()
  const planned = plannedLinks(pack)
  // 먼저 다 살펴본다 — 코어 파일과 이름이 겹치는 게 하나라도 있으면 아무것도 바꾸지 않고 멈춘다(반만 링크된 상태를 남기지 않게)
  const clash = planned.filter(({ at }) => !isLink(join(ROOT, at)) && existsSync(join(ROOT, at))).map(({ at }) => at)
  if (clash.length) {
    console.log(`🔗 팩 ${relative(ROOT, pack)} — ⚠️ 코어에 같은 이름의 실제 파일이 있어 아무것도 링크하지 않았다(${clash.length}개)`)
    for (const at of clash) console.log(`   ⚠️ ${at}`)
    process.exit(1)
  }
  const made = []; const kept = []
  for (const { at, target } of planned) {
    const path = join(ROOT, at)
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
  const stale = packLinks().filter((at) => !wanted.has(at))
  for (const at of stale) rmSync(join(ROOT, at))
  writeExclude([...made, ...kept])
  console.log(`🔗 팩 ${relative(ROOT, pack)} — 새로 ${made.length} · 그대로 ${kept.length}${stale.length ? ` · 옛 팩 링크 지움 ${stale.length}` : ''}`)
}

const unlink = () => {
  const pack = local.pack ? resolve(ROOT, local.pack) : null
  let removed = 0
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir)) {
      if (['.git', 'node_modules', 'repos', '.worktrees', 'packs'].includes(name)) continue
      const path = join(dir, name)
      if (isLink(path)) {
        if (pack && (pointsInto(path, pack) || readlinkSync(path).includes('packs/'))) { rmSync(path); removed += 1 }
      } else if (depth < 3 && lstatSync(path).isDirectory()) walk(path, depth + 1)
    }
  }
  walk(ROOT, 0)
  writeExclude([])
  console.log(`🔗 팩 링크 ${removed}개를 지웠다`)
}

// 코어 파일(git 추적 + 미추적, 링크·팩 제외)에서 팩 names 를 찾는다
// 걸린 줄은 비밀값 모양(key=값 · "key":"값" · Bearer · JWT)을 가린 뒤 보여 준다 — QA 기록과 같은 기준(qa/live.mjs maskText)
const check = () => {
  const pack = packDir()
  const names = JSON.parse(readFileSync(join(pack, 'pack.json'), 'utf8')).names ?? []
  if (!names.length) fail('pack.json 에 names(회사 이름 목록)가 없다')
  const pattern = new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean)
    // athena.config.json 은 이 컴퓨터 설정(팩 경로가 들어 있다 — 코어 레포에는 예시만 둔다)
    .filter((file) => file !== 'athena.config.json' && !file.startsWith('packs/') && !isLink(join(ROOT, file)) && !file.split('/').some((part, index, parts) => isLink(join(ROOT, ...parts.slice(0, index + 1)))))
  const hits = []
  for (const file of files) {
    let text
    try { text = readFileSync(join(ROOT, file), 'utf8') } catch { continue }
    if (text.includes('\0')) continue   // 바이너리 — 우연한 바이트 조합이 걸린다
    text.split('\n').forEach((line, index) => { if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${maskText(line.trim()).slice(0, 140)}`) })
  }
  if (!hits.length) { console.log(`✅ 코어 파일 ${files.length}개에 회사 이름(${names.length}개) 없음`); return }
  console.log(hits.join('\n'))
  console.log(`❌ 회사 이름 ${hits.length}곳 — 설정·팩으로 옮긴다`)
  process.exit(1)
}

const args = process.argv.slice(3)
const flag = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] ?? '' : '' }
const flags = (name) => args.flatMap((arg, index) => (arg === `--${name}` ? [args[index + 1]] : [])).filter(Boolean)

const init = () => {
  const root = flag('root') || local.reposRoot || '..'
  if (args.includes('--scan')) {
    const repos = scanRepos(root, ROOT, Number(flag('depth')) || 3)
    if (args.includes('--json')) { console.log(JSON.stringify(repos, null, 2)); return }
    console.log(`레포 ${repos.length}개 (${resolve(ROOT, root)}) — 추정이다. /setup 이 확인받는다`)
    console.log('| 레포 | 위치 | 종류 | 층 | 언어 | 기준 브랜치 | 작업 base | 앱 | GitHub 조직 |')
    console.log('|---|---|---|---|---|---|---|---|---|')
    for (const repo of repos) console.log(`| ${repo.name} | ${repo.path} | ${repo.kind} | ${repo.layer}${repo.mobile ? '·앱' : ''} | ${repo.lang} | ${repo.branch || '?'} | ${repo.prBase || '?'} | ${repo.apps.map((app) => `${app}(${repo.appBranches[app]})`).join(' ') || '—'} | ${repo.org || '—'} |`)
    return
  }
  const company = flag('pack')
  if (!company || !/^[a-z0-9][a-z0-9-]*$/.test(company)) fail('--pack <회사> 가 필요하다(영문 소문자·숫자·-)')
  const scanned = scanRepos(root, ROOT, Number(flag('depth')) || 3)
  const want = flag('repos')
  if (!want) fail('--repos <a,b> 또는 --repos all')
  const chosen = want === 'all' ? scanned : want.split(',').map((name) => scanned.find((repo) => repo.name === name) ?? fail(`스캔에 없는 레포: ${name}`))
  // --agent <레포>=<이름>  · 모노레포 앱은 --agent <레포>/<앱>=<이름>
  for (const pair of flags('agent')) {
    const [key, agent] = pair.split('=')
    const [repoName, app] = key.split('/')
    const repo = chosen.find((item) => item.name === repoName) ?? fail(`--agent 의 레포가 고른 목록에 없다: ${repoName}`)
    if (app) { repo.appsSpec ??= {}; repo.appsSpec[app] = { agent, branch: repo.appBranches?.[app] ?? repo.branch, prBase: repo.prBase } } else repo.agents = [agent]
  }
  const orgs = [...new Set(chosen.map((repo) => repo.org).filter(Boolean))]
  const org = flag('org') || (orgs.length === 1 ? orgs[0] : '')
  try {
    const { pack, entries } = initPack({ athenaRoot: ROOT, company, repos: chosen, names: (flag('names') || '').split(',').filter(Boolean), org, reposRoot: root })
    console.log(`📦 팩 ${relative(ROOT, pack)} — 레포 ${entries.length}개${org ? ` · GitHub ${org}` : ' · ⚠️ GitHub 조직 모름(--org)'}`)
  } catch (error) { fail(error.message) }
  Object.assign(local, JSON.parse(readFileSync(join(ROOT, 'athena.config.json'), 'utf8')))
  link()
}

const runScaffold = () => {
  const pack = packDir()
  const made = scaffold({ athenaRoot: ROOT, packDir: pack, config: loadConfig(ROOT), only: args })
  console.log(`🧱 뼈대 ${made.length}개${made.length ? '' : ' (모두 이미 있다)'}`)
  for (const path of made) console.log(`   + ${relative(ROOT, path)}`)
  link()
}

// ── 팩 백업 · 되살리기 — 팩은 git 이 아닐 수 있다(로컬만 · 사용자 결정 2026-10-17). tar 로 한 파일 ─────────────
// 비밀값이 들 수 있는 파일은 담지 않는다 — 팩에 원래 두지 않는 것들이지만 실수로 있어도 백업 파일로 새지 않게.
// .git 도 뺀다(팩이 git 레포면 설정의 인증 정보·과거 커밋의 값이 남을 수 있다 — 그런 팩은 원격으로 백업한다). Codex 리뷰 2026-10-17
const BACKUP_EXCLUDES = ['.env*', '*.key', '*.pem', '*.p12', '.npmrc', '.netrc', '.git', 'node_modules', '.DS_Store', '.omc']
const backup = () => {
  const dir = packDir()
  const out = resolve(flag('out') || join(homedir(), 'athena-pack-backups'))
  mkdirSync(out, { recursive: true })
  const now = new Date()   // 이 컴퓨터 시각으로 — YYYYMMDD-HHMMSS
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // 같은 초에 다시 하면 앞 백업을 덮지 않게 -2 · -3 … 을 붙인다
  let file = join(out, `${basename(dir)}-pack-${stamp}.tar.gz`)
  for (let index = 2; existsSync(file); index += 1) file = join(out, `${basename(dir)}-pack-${stamp}-${index}.tar.gz`)
  execFileSync('tar', ['-czf', file, ...BACKUP_EXCLUDES.flatMap((pattern) => ['--exclude', pattern]), '-C', dirname(dir), basename(dir)], { stdio: ['ignore', 'ignore', 'inherit'] })
  const count = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter((line) => line && !line.endsWith('/')).length
  console.log(`📦 팩 백업 ${basename(dir)} — 파일 ${count}개 · ${(statSync(file).size / 1024).toFixed(0)}KB`)
  console.log(`   ${file}`)
  console.log('   되살리기: bin/athena pack restore <이 파일>')
}
const restore = () => {
  const file = resolve(process.argv[4] || fail('사용: athena pack restore <백업 파일>'))
  if (!existsSync(file)) fail(`백업 파일이 없다: ${file}`)
  const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean)
  // packs/ 밖에 쓰지 않게 — 절대 경로·.. 가 든 항목이 있으면 풀지 않는다(bsdtar 기본 방어에만 기대지 않는다)
  const unsafe = entries.find((entry) => entry.startsWith('/') || entry.split('/').includes('..'))
  if (unsafe) fail(`백업 안에 packs/ 밖을 가리키는 경로가 있다 — 풀지 않는다: ${unsafe}`)
  const tops = [...new Set(entries.map((line) => line.split('/')[0]))]
  if (tops.length !== 1 || !tops[0] || tops[0].startsWith('.')) fail(`팩 백업이 아니다(맨 위 폴더가 하나여야 한다): ${tops.join(', ')}`)
  const name = tops[0]
  const target = join(ROOT, 'packs', name)
  if (existsSync(target)) fail(`이미 있다: packs/${name} — 덮지 않는다. 지금 것을 옮기거나(예: packs/${name}.old) 지운 뒤 다시`)
  mkdirSync(join(ROOT, 'packs'), { recursive: true })
  execFileSync('tar', ['-xzf', file, '-C', join(ROOT, 'packs')], { stdio: ['ignore', 'ignore', 'inherit'] })
  if (!existsSync(join(target, 'pack.json'))) fail(`되살렸지만 pack.json 이 없다: packs/${name}`)
  console.log(`📦 되살림: packs/${name}`)
  if (!local.pack) {
    writeFileSync(join(ROOT, 'athena.config.json'), JSON.stringify({ ...local, pack: `packs/${name}` }, null, 2) + '\n')
    local.pack = `packs/${name}`
    console.log('   athena.config.json 의 pack 을 이 팩으로 — 링크를 건다')
    link()
  } else if (local.pack !== `packs/${name}`) {
    console.log(`   지금 쓰는 팩은 ${local.pack} — 바꾸려면 athena.config.json 의 pack 을 packs/${name} 로 고치고 bin/athena pack link`)
  }
}

if (command === 'init') init()
else if (command === 'scaffold') runScaffold()
else if (command === 'pack' && sub === 'link') link()
else if (command === 'pack' && sub === 'unlink') unlink()
else if (command === 'pack' && sub === 'check') check()
else if (command === 'pack' && sub === 'backup') backup()
else if (command === 'pack' && sub === 'restore') restore()
else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim())
  process.exit(command ? 2 : 0)
}
