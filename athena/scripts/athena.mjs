#!/usr/bin/env node
/**
 * athena — 코어와 팩을 잇는 명령
 *
 *   athena pack link      팩 파일을 코어의 정해진 자리에 링크로 건다(이미 건 것은 다시 맞춘다)
 *   athena pack unlink    팩을 가리키는 링크를 모두 지운다
 *   athena pack check     코어 파일에 팩의 회사 이름(pack.json names)이 있는지 찾는다 — 있으면 1
 *   athena pack backup [--out <폴더>]
 *                         팩 폴더를 날짜 붙은 압축 파일 하나로(기본 <데이터>/backups/packs · .env*·키 파일·node_modules 는 뺀다)
 *   athena pack restore <파일>
 *                         백업을 packs/ 에 되살린다 — 같은 이름 팩이 있으면 덮지 않고 멈춘다. 팩 없이 쓰는 중이면 설정·링크까지
 *
 *   여러 팩 — 팩마다 본체(팩은 <데이터>/packs/<id> · 본체 <bodiesDir>/<id> · 약속은 docs/pack.md "여러 팩")
 *   --json 이면 진행은 "progress: <단계> <설명>" 줄, 마지막 줄 하나가 JSON. 스튜디오는 --contract 3 를 붙인다(다르면 contract-mismatch)
 *   athena pack list|status|busy [--json]          팩 목록(본체·포트·busy) · 이 본체의 팩 · 이 본체에서 도는 작업
 *   athena pack open <id> [--json]                 그 팩 본체를 준비(없으면 git 워크트리로 만들기)하고 경로·포트를 돌려준다
 *   athena pack use <id> [--start-board] [--json]  = pack open(활성 링크는 바꾸지 않는다 · --json 이면 --contract 3 필요)
 *   athena pack new [--json]                       빈 팩 자리 + 그 본체 → 그 본체에서 claude 를 켜면 /setup(--json 이면 --contract 3 필요)
 *   athena pack delete <id> [--with-worktrees] [--json]      팩 지우기 — 먼저 팩 + 작업 기록 + 워크트리 변경 백업 · 일하는 중이면 busy · 워크트리가 있으면 --with-worktrees · 레포 폴더는 그대로(주 본체에서)
 *   athena pack discard <id> [--json]              /setup 전 빈 자리와 그 본체를 지운다
 *   athena pack relink · attach <id> [--json]      (본체 안에서 쓰는 것) 링크 다시 맞추기 · 빈 본체에 팩을 처음 걸기
 *   athena pack set-name <이름>|--clear [--id <팩>] [--json]      팩 표시 이름(pack.json displayName · 팀과 공유 · id·name 은 그대로)
 *   athena pack set-icon <이미지>|--clear [--id <팩>] [--json]    팩 아이콘(png·jpeg·webp · 1MB 이하 → 팩 assets/icon.<형식>)
 *   athena pack set-repo-name <레포> <이름>|--clear [--id <팩>] [--json]     레포 표시 이름(pack.json repos[] displayName · 레포 name 은 그대로)
 *   athena pack set-repo-icon <레포> <이미지>|--clear [--id <팩>] [--json]   레포 아이콘(같은 규칙 → 팩 assets/repos/<레포>.<형식>)
 *   athena pack set-auto-merge <레포> [--auto on|off] [--confirm on|off] [--id <팩>] [--json]
 *                                                  레포별 PR 자동 리뷰 · 머지(pack.json "autoMerge") · 머지 전에 묻기("autoMergeConfirm") — docs/pr-auto.md "켜기"
 *   athena update --from <git 번들> [--to <커밋>] [--backup-dirty] [--panes-state <파일>] [--json]
 *                                                  앱이 들고 온 코어 번들을 주 본체로 받아 → 본체마다(일하면 건너뜀) 배포 커밋으로 · 기록 <데이터>/updates/
 *                                                  --panes-state: 스튜디오가 넘긴 데몬 pane 상태 — 입력을 기다리는 pane 의 세션은 막지 않는다
 *                                                  --backup-dirty: 코어 파일을 고쳐 둔 본체는 <데이터>/backups/core-edits/<operationId>/ 에 사본을 두고 교체(결과 backedUp)
 *   athena update --rollback [<operationId>] [--json]  그 업데이트가 바꾼 본체만 이전 커밋으로
 *   athena pack inspect <파일|폴더|git 주소> --json  임시 위치에서 검사만 → token
 *   athena pack import <token> --new|--replace|--keep [--json]
 *   athena pack import-athena <옛 아테나 폴더> --json  팩 + 계획서·이슈를 임시본으로(원본은 그대로) → pack import <token>
 *   athena pack export --out <폴더> [--json]        지금 팩만 · 허용 목록
 *   athena pack backup --with-work [--out <폴더>] [--json] · athena pack restore --with-work <파일> [--new|--replace] [--json]
 *   athena pack backup --with-work --panes <pane,…>             위 + 그 pane 들의 에이전트 대화 · 팩 워크트리(미커밋 변경 · push 안 한 커밋) — 되살리기 정보
 *   athena pack restore-work [--dry-run|--no-agents|--discard|--ack <세션>] [--json]  가져온 되살리기 정보로 워크트리 · 대화 기록 · 에이전트 pane 되살리기(본체에서)
 *   athena pack board-token --json                 떠 있는 현황판의 쓰기 토큰·포트
 *   athena pack migrate [--yes] [--json]           옛 구조 본체를 여러 팩 구조로(--yes 없으면 계획만)
 *   athena pack test-setup [--json]                테스트 데이터(ATHENA_DATA_DIR · 이름에 test)를 지우고 fixture 팩 acme·globex 등록
 *
 *   사람에게 묻는 요청(docs/requests.md) — 팩마다 · 쓰기는 이 명령으로만. --json 은 위와 같은 모양
 *   athena request open --kind decision|question --title <글> [--body <글>|--body-file <파일>] [--option '<라벨>[ :: <설명>]' …]
 *                       [--recommend <라벨>] [--plan <plans/…md>] [--html <…html>] [--issue <issues/…md>] [--pane <id>] [--key <중복 방지 키>] [--json]
 *                                                  요청을 연다(같은 --key 로 열린 것이 있으면 고친다). pane 을 안 주면 지금 pane
 *   athena request list [--all] [--json]           열린 요청(open · answered) — --all 이면 닫힌 것까지. 계획서가 done · 없어지면 expired 로 닫는다
 *   athena request show <id> [--json]
 *   athena request answer <id> --by board|app|chat [--choice <라벨>] [--text <글>] [--rev <n>] [--json]
 *                                                  사람의 답. --by chat(대화로 받음)이면 바로 delivered
 *   athena request ack <id> [--json]               에이전트가 답을 받았다(answered → delivered · 두 번 불러도 된다)
 *   athena request cancel <id> [--reason <글>] [--json]
 *
 *   athena version [--json]                          이 본체 코어 커밋 · 스튜디오 버전 · 약속 번호(contract) · 데이터 형식 범위 · 배포 커밋 — 스튜디오가 맞는지 본다
 *
 *   새 회사 첫 실행(/setup 스킬이 차례로 부른다)
 *   athena init --scan [--root <폴더>] [--depth <n>] [--json]
 *                                                     reposRoot(기본 ..) 아래 n 단계(기본 3)까지 git 레포를 훑어 추정을 보여 준다(읽기 전용)
 *   athena init --pack <회사> --repos <a,b|all> [--names <x,y>] [--org <GitHub 조직>] [--agent <레포>=<이름> …]
 *                                                     고른 레포로 빈 팩(packs/<회사>)·athena.config.json 을 만들고 링크까지
 *   athena repo add <레포 폴더> [--name <이름>] [--json]       이미 있는 팩에 레포 하나 더하기 — pack.json · 자리 · repos/ 링크 · 그 레포 뼈대 · 팩 링크(채우기는 docs/setup.md "레포 하나 더하기")
 *   athena repo remove <레포 이름> [--json]                  팩에서 레포 빼기 — 팩 자동 백업 · pack.json · 자리 · 링크 · 그 레포 에이전트 · 지식 · 검증(레포 폴더는 그대로 · 워크트리가 있으면 거부)
 *   athena scaffold [<레포> …]                        pack.json 레포마다 에이전트·지식 뼈대·검증 스크립트 + 팩 서비스 문서·다이어그램 표(있는 파일은 그대로) + 링크
 *
 * 팩 위치는 athena.config.json 의 pack. 링크 목록은 이 컴퓨터의 .git/info/exclude 에 적어 git 이 무시하게 한다
 * (커밋되는 .gitignore 에 회사 경로를 적지 않는다). Claude Code 가 정해진 자리에서만 찾는 것(.claude/agents·skills)과
 * 스크립트가 고정 경로로 읽는 것(docs/knowledge/<레포>·scripts/verify/<레포>.sh·archive …)을 링크로 잇는다.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ATHENA_ROOT, boardPort, dataDir, defaultBackupDir, loadConfig, paths } from './lib/config.mjs'
import { setDisplayName, setIcon } from './lib/pack-look.mjs'
import { setRepoDisplayName, setRepoIcon } from './lib/pack-repo-look.mjs'
import { setAutoMerge } from './lib/pack-merge.mjs'
import { CONTRACT, deletePack, discardPack, newPackBody, openPack, rollbackUpdate, updateBodies, useAsOpen, versionInfo } from './lib/bodies.mjs'
import { addRepo, initPack, scaffold, scanRepos } from './lib/init.mjs'
import { isLink, linkOverlay, unlinkOverlay } from './lib/overlay.mjs'
import {
  PackError, attachPack, backupWithWork, boardToken, busyNow, exportPack, headOf, importToken, inspectAthena, inspectSource, listPacks, migrate, removeRepo, syncRepos,
  packStatus, relinkBody, renameNewSlot, restoreWithWork, restoreWorkCommand, testSetup,
} from './lib/packs.mjs'
import { maskText } from './qa/live.mjs'
import { ackRequest, answerRequest, cancelRequest, listRequests, openRequest, showRequest } from './lib/requests.mjs'
import { callerPane } from './lib/screen.mjs'

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

// 레포 하나 더하기 — pack.json · local.json(lib/init.mjs addRepo) → repos/ 링크 → 그 레포 뼈대(에이전트 · 지식 · 검증) → 팩 링크.
// 뼈대 채우기(에이전트 설명 · 지식 · ROUTING · services · 지문)는 아테나가 docs/setup.md "레포 하나 더하기" 대로
const runRepoAdd = () => {
  const dir = positional()[0]
  if (!dir) throw new PackError('usage', '사용: athena repo add <레포 폴더> [--name <이름>] [--json]')
  let added
  try { added = addRepo({ athenaRoot: ROOT, dir: resolve(dir), name: flag('name') }) } catch (error) { throw new PackError(error.code ?? 'invalid-pack', error.message) }
  const repos = syncRepos(ROOT)
  const made = added.already ? [] : scaffold({ athenaRoot: ROOT, packDir: packDir(), config: loadConfig(ROOT), only: [added.repo.name] })
  if (!asJson) for (const path of made) console.log(`   + ${relative(ROOT, path)}`)
  const quiet = console.log
  if (asJson) console.log = () => {}
  try { link() } finally { console.log = quiet }
  return { ...added, linked: repos.linked.includes(added.repo.name), scaffolded: made.map((path) => relative(ROOT, path)) }
}

// 팩에서 레포 빼기 — lib/packs.mjs removeRepo 뒤 팩 링크 정리(빠진 에이전트 링크가 지워진다). ROUTING · services 줄 정리는 아테나가
const runRepoRemove = () => {
  const name = positional()[0]
  if (!name) throw new PackError('usage', '사용: athena repo remove <레포 이름> [--json]')
  const result = removeRepo(ROOT, name, { report })
  const quiet = console.log
  if (asJson) console.log = () => {}
  try { link() } finally { console.log = quiet }
  return result
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
  const out = resolve(flag('out') || defaultBackupDir(dataDir(ROOT)))
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
const positional = () => args.slice(1).filter((arg, index, rest) => !arg.startsWith('--') && !(index > 0 && ['--out', '--contract', '--to', '--id', '--from', '--panes', '--panes-state', '--ack', '--name', '--auto', '--confirm'].includes(rest[index - 1])))
// 약속 번호 — 스튜디오가 --contract <n>(또는 ATHENA_CONTRACT)로 알린다. 다르면 거부. pack use·new 는 --json 인데 없으면 거부 —
// 옛 스튜디오(1단계)의 "갈아 끼우기"를 성공으로 흉내 내지 않는다
const contractArg = flag('contract') || process.env.ATHENA_CONTRACT || ''
const checkContract = (name) => {
  const mismatch = (why) => new PackError('contract-mismatch', `스튜디오 약속이 다르다(${why}) — 이 코어는 약속 ${CONTRACT}. 스튜디오를 먼저 업데이트한다`, { contract: CONTRACT })
  if (contractArg && Number(contractArg) !== CONTRACT) throw mismatch(`받은 약속 ${contractArg}`)
  if (asJson && !contractArg && ['use', 'new'].includes(name)) throw mismatch('약속 번호 없음 — 팩마다 본체 전 스튜디오')
}
const human = {
  list: (result) => {
    if (result.legacy && result.current) console.log('옛 구조 본체(athena.config.json 의 pack) — 여러 팩으로 옮기려면 bin/athena pack migrate')
    console.log(`이 본체의 팩: ${result.current ? `${result.current.id} (${result.current.name} · 세대 ${result.current.generation})` : '없음'}${result.switching ? ' · ⏳ 작업 중' : ''}`)
    for (const pack of result.packs) {
      const where = pack.body ? `${pack.body} · :${pack.boardPort}${pack.bodyBusy ? ' · 🔨 일하는 중' : ''}${pack.updatePending ? ' · ⬆️ 업데이트 대기' : ''}${pack.bodyState === 'repair-required' ? ' · ⚠️ 링크 고치기 필요' : ''}` : (pack.bodyState === 'missing' ? '본체 폴더 없음' : '본체 없음(pack open)')
      console.log(`  ${result.current?.id === pack.id ? '▶' : ' '} ${pack.id.padEnd(20)} ${pack.name} · 레포 ${pack.repos} · ${pack.hasWork ? '작업 기록 있음' : '작업 기록 없음'} · ${where}`)
    }
    for (const slot of result.emptySlots ?? []) console.log(`    ${slot.id.padEnd(20)} (빈 자리 · /setup 전${slot.body ? ` · ${slot.body}` : ''} — 버리려면 pack discard ${slot.id})`)
  },
  busy: (result) => { if (!result.busy.length) console.log(result.busyKnown === false ? '도는 작업을 다 읽지 못했다' : '이 본체에서 도는 작업 없음'); for (const item of result.busy) console.log(`  ${item.kind.padEnd(13)} ${item.what}${item.pid ? ` (pid ${item.pid})` : ''}`) },
  version: (result) => console.log(`코어 ${result.core ? result.core.slice(0, 7) : '(git 아님)'}${result.dirty ? ' (미커밋 변경)' : ''}${result.version ? ` · 버전 ${result.version}` : ''} · 약속 ${result.contract} · 데이터 형식 ${result.dataFormats.join('~')} · 본체 ${result.body}${result.deploy ? ` · 배포 ${result.deploy.commit.slice(0, 7)}` : ''}`),
  'request list': (result) => {
    if (!result.requests.length) console.log('열린 요청 없음')
    for (const request of result.requests) console.log(`  ${requestLine(request)}`)
  },
  update: (result) => {
    console.log(`${result.status === 'complete' ? '✅' : '⚠️'} ${result.rollbackOf ? `되돌리기(${result.rollbackOf})` : `업데이트 → ${result.targetCore?.slice(0, 7)}`} · ${result.status} · ${result.operationId}`)
    for (const body of result.bodies) console.log(`  ${body.id.padEnd(20)} ${body.status}${body.reason ? `(${body.reason})` : ''}${body.error ? `(${body.error})` : ''} ${body.from?.slice(0, 7) ?? '-'} → ${body.to?.slice(0, 7) ?? '-'}${body.services?.boardStopped?.length ? ` · 현황판 끔 :${body.services.boardStopped.join(',')}` : ''}${body.backedUp?.length ? ` · 고친 코어 파일 ${body.backedUp.length}개 사본 ${body.backupDir}` : ''}${body.status === 'updated' && body.working?.length ? ` · 일하는 중이던 세션 ${body.working.length}개 — 바로 올림` : ''}${body.services?.learnStopped?.length ? ' · 학습 검토 끔' : ''}${body.services?.qaStopped?.length ? ' · QA 끔' : ''}`)
  },
}
// 출력이 파이프에 다 나간 뒤 끝난다 — console.log 직후 process.exit() 하면 64KB 넘는 출력이 잘린다
// stdout · stderr 양쪽의 대기 중인 쓰기가 다 끝난 뒤 끝낸다(runPack 은 모든 분기의 마지막이라 뒤따르는 코드가 없다)
const flushed = (stream) => new Promise((done) => stream.write('', () => done()))
const finish = (code) => { process.exitCode = code; Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(() => process.exit(code)) }
const runPack = async (name, work) => {
  try {
    checkContract(name)
    const result = await work()
    if (asJson) console.log(JSON.stringify(result))
    else if (human[name]) human[name](result)
    else console.log(JSON.stringify(result, null, 2))
    finish(result.ok === false ? 1 : 0)
  } catch (error) {
    const code = error instanceof PackError ? error.code : 'failed'
    if (code === 'usage') { console.error(error.message); return finish(2) }
    const body = { ok: false, error: code, message: error.message, ...(error.extra ?? {}) }
    if (asJson) console.log(JSON.stringify(body))
    else console.error(`❌ ${error.message}${error.extra?.busy ? `\n${error.extra.busy.map((item) => `   - ${item.what}`).join('\n')}` : ''}`)
    finish(1)
  }
}
// pack use --start-board · CLI 용 — 연 본체의 현황판을 띄운다(스튜디오는 자기가 띄운다). 포트는 그 본체가 정한다
const startBoard = (body) => {
  const env = { ...process.env, ATHENA_BOARD_NO_BROWSER: '1' }
  delete env.ATHENA_BOARD_PORT
  return spawnSync(join(body, 'scripts', 'board.sh'), [], { stdio: asJson ? 'ignore' : 'inherit', env }).status === 0
}

// ── 요청(request) ─────────────────────────────────────────────────────────
const requestId = () => {
  const id = args[1]
  if (!id || id.startsWith('--')) throw new PackError('usage', `사용: athena request ${sub} <id> [--json]`)
  return id
}
const requestCommands = {
  open: () => {
    const recommend = flag('recommend')
    const options = flags('option').map((raw) => {
      const [label, ...desc] = raw.split(' :: ')
      return { label: label.trim(), desc: desc.join(' :: ').trim(), recommended: label.trim() === recommend }
    })
    const bodyFile = flag('body-file')
    // 결정 콘솔(--html)이 없는 decision 은 앱이 열 화면이 없다 — question 으로 연다
    let kind = flag('kind')
    if (kind === 'decision' && !flag('html')) {
      kind = 'question'
      console.error('⚠️ --html 이 없는 decision 은 question 으로 열었다(decision 은 결정 콘솔 전용 · docs/requests.md)')
    }
    return openRequest(ROOT, {
      kind,
      title: flag('title'),
      body: bodyFile ? readFileSync(resolve(bodyFile), 'utf8') : flag('body'),
      options,
      links: { plan: flag('plan'), html: flag('html'), issue: flag('issue') },
      pane: flag('pane') || callerPane(),  // 부른 pane — 화면 밖이면 포커스된 pane(lib/screen.mjs)
      dedupeKey: flag('key'),
    })
  },
  list: () => listRequests(ROOT, { all: args.includes('--all') }),
  show: () => showRequest(ROOT, requestId()),
  answer: () => answerRequest(ROOT, requestId(), { choice: flag('choice'), text: flag('text'), by: flag('by'), rev: flag('rev') === '' ? null : Number(flag('rev')) }),
  ack: () => ackRequest(ROOT, requestId()),
  cancel: () => cancelRequest(ROOT, requestId(), { reason: flag('reason') }),
}
const requestLine = (request) => `${request.id} · ${request.kind} · ${request.state}${request.pane ? ` · pane ${request.pane}` : ''} — ${request.title}`

for (const name of ['open', 'show', 'answer', 'ack', 'cancel']) human[`request ${name}`] = (result) => console.log(`✅ ${requestLine(result.request)}`)

const packCommands = {
  'restore-work': () => restoreWorkCommand(ROOT, { dryRun: args.includes('--dry-run'), agents: !args.includes('--no-agents'), discard: args.includes('--discard'), ack: flags('ack'), report }),
  list: () => listPacks(ROOT),
  status: () => packStatus(ROOT),
  busy: () => busyNow(ROOT),
  use: async () => {
    const id = positional()[0]
    if (!id) throw new PackError('usage', '사용: athena pack use <id> [--start-board] [--json]')
    const result = await useAsOpen(ROOT, id, { report })
    if (args.includes('--start-board')) result.boardStarted = startBoard(result.body) ? result.boardPort : null
    return result
  },
  open: async () => {
    const id = positional()[0]
    if (!id) throw new PackError('usage', '사용: athena pack open <id> [--json]')
    // 빈 자리(pack new 뒤 /setup 전)도 연다 — 다른 팩으로 넘어갔다가 돌아와 /setup 을 이어 하게
    return openPack(ROOT, id, { report, allowEmpty: true })
  },
  new: () => newPackBody(ROOT, { report }),
  delete: () => {
    if (!positional()[0]) throw new PackError('usage', '사용: athena pack delete <id> [--with-worktrees] [--json]')
    return deletePack(ROOT, positional()[0], { withWorktrees: args.includes('--with-worktrees'), report })
  },
  discard: () => {
    if (!positional()[0]) throw new PackError('usage', '사용: athena pack discard <id> [--json]')
    return discardPack(ROOT, positional()[0], { report })
  },
  // 본체 안에서 — update 뒤 새 코드로 · pack open 의 고치기. 시험용: ATHENA_RELINK_FAIL_AT=<커밋> 이면 그 커밋에서 실패
  relink: () => {
    const failAt = process.env.ATHENA_RELINK_FAIL_AT
    if (failAt && (headOf(ROOT) ?? '').startsWith(failAt)) throw new PackError('verify-failed', `시험용 실패(ATHENA_RELINK_FAIL_AT=${failAt})`)
    return relinkBody(ROOT)
  },
  'set-name': () => {
    const clear = args.includes('--clear')
    if (!clear && !positional()[0]) throw new PackError('usage', '사용: athena pack set-name <이름>|--clear [--id <팩>] [--json]')
    return setDisplayName(paths(ROOT), { id: flag('id'), name: positional().join(' '), clear })
  },
  'set-icon': () => {
    const clear = args.includes('--clear')
    if (!clear && !positional()[0]) throw new PackError('usage', '사용: athena pack set-icon <이미지 파일>|--clear [--id <팩>] [--json]')
    return setIcon(paths(ROOT), { id: flag('id'), file: clear ? '' : resolve(positional()[0]), clear })
  },
  'set-repo-name': () => {
    const clear = args.includes('--clear')
    const [repo, ...words] = positional()
    if (!repo || (!clear && !words.length)) throw new PackError('usage', '사용: athena pack set-repo-name <레포> <이름>|--clear [--id <팩>] [--json]')
    return setRepoDisplayName(paths(ROOT), { id: flag('id'), repo, name: words.join(' '), clear })
  },
  'set-repo-icon': () => {
    const clear = args.includes('--clear')
    const [repo, file] = positional()
    if (!repo || (!clear && !file)) throw new PackError('usage', '사용: athena pack set-repo-icon <레포> <이미지 파일>|--clear [--id <팩>] [--json]')
    return setRepoIcon(paths(ROOT), { id: flag('id'), repo, file: clear ? '' : resolve(file), clear })
  },
  'set-auto-merge': () => setAutoMerge(paths(ROOT), { id: flag('id'), repo: positional()[0], auto: flag('auto'), confirm: flag('confirm') }),
  attach: () => {
    if (!positional()[0]) throw new PackError('usage', '사용: athena pack attach <id> [--json]')
    return attachPack(ROOT, positional()[0], { report, allowEmpty: true })
  },
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
else if (command === 'version') runPack('version', () => versionInfo(ROOT))
else if (command === 'update') {
  // update --rollback [<operationId>] — --rollback 바로 뒤가 --… 가 아니면 그 값이 operationId
  const rollback = args.includes('--rollback')
  const operationId = rollback ? (flag('rollback').startsWith('--') ? '' : flag('rollback')) : ''
  runPack('update', () => (rollback ? rollbackUpdate(ROOT, { operationId, report }) : updateBodies(ROOT, { to: flag('to'), from: flag('from'), backupDirty: args.includes('--backup-dirty'), panesState: flag('panes-state'), report })))
}
else if (command === 'scaffold') runScaffold()
else if (command === 'repo' && sub === 'add') runPack('repo add', () => runRepoAdd())
else if (command === 'repo' && sub === 'remove') runPack('repo remove', () => runRepoRemove())
else if (command === 'request' && requestCommands[sub]) runPack(`request ${sub}`, requestCommands[sub])
else if (command === 'pack' && sub === 'link') link()
else if (command === 'pack' && sub === 'unlink') unlink()
else if (command === 'pack' && sub === 'check') check()
else if (command === 'pack' && sub === 'backup' && args.includes('--with-work')) runPack('backup', () => backupWithWork(ROOT, flag('out'), { panes: flag('panes').split(',').filter(Boolean), report }))
else if (command === 'pack' && sub === 'restore' && args.includes('--with-work')) runPack('restore', () => restoreWithWork(ROOT, positional()[0], ['replace', 'new'].find((name) => args.includes(`--${name}`)), { report }))
else if (command === 'pack' && sub === 'backup') backup()
else if (command === 'pack' && sub === 'restore') restore()
else if (command === 'pack' && packCommands[sub]) runPack(sub, packCommands[sub])
else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim())
  process.exit(command ? 2 : 0)
}
