#!/usr/bin/env node
/**
 * athena — 코어와 팩을 잇는 명령
 *
 *   athena pack link      팩 파일을 코어의 정해진 자리에 링크로 건다(이미 건 것은 다시 맞춘다)
 *   athena pack unlink    팩을 가리키는 링크를 모두 지운다
 *   athena pack check     코어 파일에 팩의 회사 이름(pack.json names)이 있는지 찾는다 — 있으면 1
 *   athena pack backup [--out <폴더>]
 *                         팩 폴더를 날짜 붙은 압축 파일 하나로(기본 ~/athena-pack-backups · .env*·키 파일·node_modules 는 뺀다)
 *   athena pack restore <파일>
 *                         백업을 packs/ 에 되살린다 — 같은 이름 팩이 있으면 덮지 않고 멈춘다. 팩 없이 쓰는 중이면 설정·링크까지
 *
 *   여러 팩(본체 하나 · 팩은 <데이터>/packs/<id> · docs/pack.md "여러 팩") — --json 이면 진행은 "progress: <단계> <설명>" 줄, 마지막 줄 하나가 JSON
 *   athena pack list|status|busy [--json]          팩 목록 · 지금 팩 · 갈아 끼우면 안 되는 작업
 *   athena pack use <id> [--start-board] [--json]  팩 갈아 끼우기(잠금 → 검사 → 현황판·학습 검토·QA 끄기 → 링크 교체 → repos 대조 → 확인, 실패하면 되돌림)
 *   athena pack new [--json]                       빈 팩 자리를 지금 팩으로 → claude 를 켜면 /setup
 *   athena pack inspect <파일|폴더|git 주소> --json  임시 위치에서 검사만 → token
 *   athena pack import <token> --new|--replace|--keep [--json]
 *   athena pack import-athena <옛 아테나 폴더> --json  팩 + 계획서·이슈를 임시본으로(원본은 그대로) → pack import <token>
 *   athena pack export --out <폴더> [--json]        지금 팩만 · 허용 목록
 *   athena pack backup --with-work [--out <폴더>] [--json] · athena pack restore --with-work <파일> [--new|--replace] [--json]
 *   athena pack board-token --json                 떠 있는 현황판의 쓰기 토큰·포트
 *   athena pack migrate [--yes] [--json]           옛 구조 본체를 여러 팩 구조로(--yes 없으면 계획만)
 *   athena pack test-setup [--json]                테스트 데이터(ATHENA_DATA_DIR · 이름에 test)를 지우고 fixture 팩 acme·globex 등록
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
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ATHENA_ROOT, boardPort, loadConfig, paths } from './lib/config.mjs'
import { initPack, scaffold, scanRepos } from './lib/init.mjs'
import { isLink, linkOverlay, unlinkOverlay } from './lib/overlay.mjs'
import {
  PackError, backupWithWork, boardToken, busyNow, exportPack, importToken, inspectAthena, inspectSource, listPacks, migrate,
  newPack, packStatus, renameNewSlot, restoreWithWork, testSetup, usePack,
} from './lib/packs.mjs'
import { maskText } from './qa/live.mjs'

const ROOT = ATHENA_ROOT
const [command, sub] = process.argv.slice(2)

// 이 컴퓨터 설정 — 새 회사는 아직 없을 수 있다(athena init 이 만든다)
const local = existsSync(join(ROOT, 'athena.config.json')) ? JSON.parse(readFileSync(join(ROOT, 'athena.config.json'), 'utf8')) : {}
// 지금 팩 폴더 — 여러 팩 구조면 본체의 pack(활성 팩), 옛 구조면 athena.config.json 의 pack
const packDir = () => {
  const where = paths(ROOT)
  const dir = where.packDir
  if (!dir) fail('athena.config.json 에 pack 이 없다 — 팩 없이 쓰는 중')
  if (!existsSync(join(dir, 'pack.json'))) fail(`팩이 없다: ${dir}/pack.json`)
  return dir
}
function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

// 팩 파일을 코어 자리에 링크로(scripts/lib/overlay.mjs)
const link = () => {
  const pack = packDir()
  const result = linkOverlay(ROOT)
  if (result.clash.length) {
    console.log(`🔗 팩 ${relative(ROOT, pack)} — ⚠️ 코어에 같은 이름의 실제 파일이 있어 아무것도 링크하지 않았다(${result.clash.length}개)`)
    for (const at of result.clash) console.log(`   ⚠️ ${at}`)
    process.exit(1)
  }
  console.log(`🔗 팩 ${relative(ROOT, pack)} — 새로 ${result.made.length} · 그대로 ${result.kept.length}${result.stale.length ? ` · 옛 팩 링크 지움 ${result.stale.length}` : ''}`)
}

const unlink = () => {
  console.log(`🔗 팩 링크 ${unlinkOverlay(ROOT)}개를 지웠다`)
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
    .filter((file) => file !== 'athena.config.json' && !file.startsWith('packs/') && !file.startsWith('test/fixtures/') && !isLink(join(ROOT, file)) && !file.split('/').some((part, index, parts) => isLink(join(ROOT, ...parts.slice(0, index + 1)))))
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
  if (existsSync(join(ROOT, 'athena.config.json'))) Object.assign(local, JSON.parse(readFileSync(join(ROOT, 'athena.config.json'), 'utf8')))
  // 여러 팩 구조 — pack new 로 만든 빈 자리(new-…)면 자리 이름을 회사 이름으로
  const renamed = renameNewSlot(ROOT, company)
  if (renamed) console.log(`📁 팩 자리 이름: ${renamed}`)
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
// 여러 팩 구조에서는 옛 backup·restore 를 쓰지 않는다 — pack 은 링크라 압축에 링크 하나만 담기고, restore 는 본체 설정에 pack 을 다시 쓴다(리뷰 2026-10-18)
const packsModeOnly = (what) => {
  if (paths(ROOT).mode !== 'packs') return
  fail(`여러 팩 구조에서는 ${what} 를 쓰지 않는다 — ${what === 'pack backup'
    ? '팩만: bin/athena pack export --out <폴더> · 팩 + 작업 기록: bin/athena pack backup --with-work [--out <폴더>]'
    : '팩 압축·폴더: bin/athena pack inspect <파일> → bin/athena pack import <token> --new · 작업 기록 백업: bin/athena pack restore --with-work <파일>'} (docs/pack.md "여러 팩")`)
}
const backup = () => {
  packsModeOnly('pack backup')
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
  packsModeOnly('pack restore')
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
    console.log(`   지금 쓰는 팩은 ${local.pack} — 갈아 끼우려면 athena.config.json 의 pack 을 packs/${name} 로 고치고 bin/athena pack link`)
  }
}

// ── 여러 팩 명령 — --json: progress 줄 + 마지막 줄 JSON · 실패 1({ ok:false, error, message }) · 사용법 오류 2 ──────────
const asJson = args.includes('--json')
const report = (step, text) => { if (asJson) console.log(`progress: ${step} ${text}`); else console.log(`· ${text}`) }
// args 맨 앞은 하위 명령(pack <sub>) — 그 뒤의 위치 인자만(--out 값은 뺀다)
const positional = () => args.slice(1).filter((arg, index, rest) => !arg.startsWith('--') && !(index > 0 && ['--out'].includes(rest[index - 1])))
const human = {
  list: (result) => {
    if (result.legacy && result.current) console.log('옛 구조 본체(athena.config.json 의 pack) — 여러 팩으로 옮기려면 bin/athena pack migrate')
    console.log(`지금 팩: ${result.current ? `${result.current.id} (${result.current.name} · 세대 ${result.current.generation})` : '없음'}${result.switching ? ' · ⏳ 갈아 끼우는 중' : ''}`)
    for (const pack of result.packs) console.log(`  ${result.current?.id === pack.id ? '▶' : ' '} ${pack.id.padEnd(20)} ${pack.name} · 레포 ${pack.repos} · ${pack.hasWork ? '작업 기록 있음' : '작업 기록 없음'} · ${pack.source}${pack.remote ? ` ${pack.remote}` : ''}`)
  },
  busy: (result) => { if (!result.busy.length) console.log('갈아 끼우면 안 되는 작업 없음'); for (const item of result.busy) console.log(`  ${item.kind.padEnd(13)} ${item.what}${item.pid ? ` (pid ${item.pid})` : ''}`) },
}
const runPack = async (name, work) => {
  try {
    const result = await work()
    if (asJson) console.log(JSON.stringify(result))
    else if (human[name]) human[name](result)
    else console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok === false ? 1 : 0)
  } catch (error) {
    const code = error instanceof PackError ? error.code : 'failed'
    if (code === 'usage') { console.error(error.message); process.exit(2) }
    const body = { ok: false, error: code, message: error.message, ...(error.extra ?? {}) }
    if (asJson) console.log(JSON.stringify(body))
    else console.error(`❌ ${error.message}${error.extra?.busy ? `\n${error.extra.busy.map((item) => `   - ${item.what}`).join('\n')}` : ''}`)
    process.exit(1)
  }
}
// pack use --start-board · CLI 용 — 갈아 끼운 뒤 현황판을 다시 띄운다(스튜디오는 자기가 띄운다)
const startBoard = () => spawnSync(join(ROOT, 'scripts', 'board.sh'), [], { stdio: asJson ? 'ignore' : 'inherit', env: { ...process.env, ATHENA_BOARD_NO_BROWSER: '1' } }).status === 0

const packCommands = {
  list: () => listPacks(ROOT),
  status: () => packStatus(ROOT),
  busy: () => busyNow(ROOT),
  use: async () => {
    const id = positional()[0]
    if (!id) throw new PackError('usage', '사용: athena pack use <id> [--start-board] [--json]')
    const result = await usePack(ROOT, id, { report })
    if (args.includes('--start-board') && !result.unchanged) result.boardStarted = startBoard() ? boardPort(ROOT) : null
    return result
  },
  new: () => newPack(ROOT, { report }),
  inspect: () => inspectSource(ROOT, positional()[0], { report }),
  import: () => {
    const mode = ['keep', 'replace', 'new'].find((name) => args.includes(`--${name}`))
    if (!positional()[0] || !mode) throw new PackError('usage', '사용: athena pack import <token> --new|--replace|--keep [--json]')
    return importToken(ROOT, positional()[0], mode, { report })
  },
  'import-athena': () => inspectAthena(ROOT, positional()[0], { report }),
  export: () => exportPack(ROOT, flag('out')),
  'board-token': () => boardToken(ROOT),
  migrate: () => migrate(ROOT, { yes: args.includes('--yes'), report }),
  'test-setup': () => testSetup(ROOT, { report }),
}

if (command === 'init') init()
else if (command === 'scaffold') runScaffold()
else if (command === 'pack' && sub === 'link') link()
else if (command === 'pack' && sub === 'unlink') unlink()
else if (command === 'pack' && sub === 'check') check()
else if (command === 'pack' && sub === 'backup' && args.includes('--with-work')) runPack('backup', () => backupWithWork(ROOT, flag('out')))
else if (command === 'pack' && sub === 'restore' && args.includes('--with-work')) runPack('restore', () => restoreWithWork(ROOT, positional()[0], ['replace', 'new'].find((name) => args.includes(`--${name}`)), { report }))
else if (command === 'pack' && sub === 'backup') backup()
else if (command === 'pack' && sub === 'restore') restore()
else if (command === 'pack' && packCommands[sub]) runPack(sub, packCommands[sub])
else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim())
  process.exit(command ? 2 : 0)
}
