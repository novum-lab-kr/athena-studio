#!/usr/bin/env node
/**
 * 아테나 일감 — 로컬 서버를 띄워 지금 무슨 일이 돌아가는지 브라우저에서 실시간으로 본다.
 *
 *   node scripts/board/server.mjs            # http://localhost:4700 (ATHENA_BOARD_PORT 로 변경)
 *   /board                                   # 아테나 세션에서 — 뒤에서 띄우고 브라우저를 연다(scripts/board.sh)
 *
 * 보여주는 것 (로컬 파일·명령에서 읽는다)
 *   - 카드: 이슈(issues/*.md) · 계획서(plans/**\/*.md 의 Checkpoint Status) — 페이지 첫 화면은 해결할 이슈 목록, 계획서는 앱 [작업] · pane [상세] 가 /api/state 로 읽는다
 *   - 지금 동작 중: 화면(Athena Studio) pane 의 에이전트(agent_status), 백그라운드 서브에이전트 로그, 워크트리
 *   - 머리: 마지막 sync, 다이어그램 점검 결과는 /board 에서 따로 돌리지 않는다(무겁다)
 *
 * 3초마다 모아서 바뀐 게 있으면 SSE(/events)로 밀어 준다. 브라우저는 새로고침하지 않아도 된다.
 *
 * 쓰기는 두 가지뿐이다 (브라우저 버튼)
 *   - POST /api/move   카드를 다른 칸으로 — 이슈 frontmatter status, 계획서 Checkpoint Status(md 와 html 의 plan-md 사본 둘 다)
 *   - POST /api/dispatch (이슈 [작업 시작] → "담당 에이전트로 바로(조사만)") 이슈마다 워크트리(.worktrees/<레포>/issue-<이슈>, 운영 기준 ref · detached — 조사 전용, 코드 수정 없음)를 만들고
 *     담당 에이전트를 그 레포 workspace 에 새 pane 으로 띄운다(scripts/delegate.sh --cwd). 한 레포에서 여러 이슈를 동시에 돌려도 부딪히지 않게
 *   - POST /api/worktree-remove 끝난 이슈의 워크트리를 지운다(미커밋 변경이 있으면 거부)
 *   - POST /api/delete 카드를 휴지통(.board-trash/<날짜>/)으로 옮긴다 — 이슈면 연결된 경량 계획서·워크트리도. 되돌릴 수 있게 지우지 않는다
 *   - POST /api/archive 끝난 카드를 archive/<이름>/ 한 폴더로 보관 — issue.md · plan.md(· plan.html) · meta.json(archive.mjs), 이슈 워크트리 정리. 보드에서 사라지고 히스토리 탭에 뜬다
 *   - GET  /api/qa/runs      QA 시뮬레이션 런 목록(.qa-runs/) · /api/qa/run?id= 런 하나 · /qa-runs/<id>/<파일> 스크린샷·리포트
 *   - GET  /qa-live?id=      QA 자동화 도구 화면 — 실시간 화면(live/*.jpg)·API 호출·Mixpanel 이벤트(/api/qa/live?id=&since=) 한 페이지
 *   - GET  /api/qa/tc        QA TC 목록(docs/qa/tc/<앱>.md "B) TC" 표 · 앱별 흐름 씬 파일)
 *   - GET  /api/qa/sessions?app=&target=&server=  고른 앱·대상의 로그인 세션 상태(있음·만료 시각만, 쿠키 값은 안 읽음) · POST /api/qa-logout 세션 파일을 .qa-auth/.trash 로(다음 검수에 로그인 창) · POST /api/qa-login 로그인 창을 띄워 세션을 새로 저장
 *   - GET  /api/qa/apps      전체 검수할 수 있는 앱·세션 프로필 · POST /api/qa-suite [전체 검수](요청할 때만) · POST /api/qa-approve [기준으로 승인]
 *   - POST /api/qa-start     계획서 카드 [QA 실행] — Work ref 워크트리로 scripts/qa/run.mjs 를 뒤에서 돌린다(한 번에 하나)
 *   - GET  /api/history      보관된 일 목록 · /api/history/item?dir= 한 건의 이슈·계획서 원문
 *   - GET  /api/memory       아테나 메모리(~/.claude/projects/<워크스페이스>/memory) 목록·본문 — 읽기 전용
 *   - GET  /api/learn        [학습] 탭 — 학습 후보·학습한 내용·넣기/버리기 수 · POST /api/learn-{apply,discard,edit,remove,tidy}(learn.mjs — tidy 는 공책 정리 후보의 줄 하나 지우기·그대로 두기)
 *   - POST /api/hermes-new 이슈 [작업 시작] → 아테나: 새 아테나 pane(🧭 아테나 · <이슈>)을 열어 그 안에서 처리한다 — 떠 있는 아테나 대화에 섞지 않는다
 *   - POST /api/action 이미 떠 있는 아테나·에이전트 pane 에 지시문을 입력한다(scripts/screen pane send-text + Enter)
 *                      결정 콘솔이 plan(계획서 경로)을 같이 주면 그 계획서의 결정 요청에 답을 적고(answered) 지시 앞에 [요청 <id>] 를 붙인다(docs/requests.md)
 *     정식 계획서 결정 콘솔(/plans/*.html)의 [이대로 진행] 도 이걸로 PLAN.leadPane 에 보낸다
 *   브라우저가 보내기 전에 지시문을 보여주고 고치게 한다
 * 다른 사이트가 localhost 로 요청을 보내 아테나에 지시를 넣지 못하게, 서버를 띄울 때마다 만드는 토큰과
 * Origin 이 맞는 요청만 받는다.
 */
import { createServer } from 'node:http'
import { chmodSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, rmSync, mkdirSync, renameSync, realpathSync } from 'node:fs'
import { join, dirname, relative, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { archiveBundle, commitArchive, listHistory, readHistoryItem } from './archive.mjs'
import { answerRequest, listRequests } from '../lib/requests.mjs'
import { doneTimes, observePlanStatus, readEvents } from '../lib/events.mjs'
import { summarize } from '../lib/metrics.mjs'
import { applyLearn, checkLearnWithJev, discardLearn, editLearned, isLearnIssue, listLearn, removeLearned, tidyLine } from './learn.mjs'
import { listRuns as listQaRuns, RUNS_DIR as QA_RUNS_DIR } from '../qa/report.mjs'
import { checkServerUrl, sessionFileOf } from '../qa/targets.mjs'
import { listQaApps, findQaApp, appOfAgent, readRoutes, serverSettings, sessionToken, packQaWarnings, routesWarnings } from '../qa/apps.mjs'
import { updatePlan, withPlanLock, writeAtomic } from '../lib/plan-update.mjs'
import { approveRun as approveQaRun } from '../qa/baseline.mjs'
import { explainProblems, guessCause } from '../qa/explain.mjs'
import { jevEnabled } from '../lib/jev.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { bodyIdOf, boardPort, githubOrg, loadConfig, paths, prLinkPattern } from '../lib/config.mjs'
import { isPackBody } from '../lib/bodies.mjs'
import { autoMergeRepos, autoReviewAction, claimAutoReview, needsReview, REOPEN_STATUS } from '../lib/pr-auto.mjs'
import { screen, screenName } from '../lib/screen.mjs'
import { boundPaneIds, hasOpenSteps, progressOf, readPaneSessions } from './plan-bind.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = boardPort(ROOT)   // ATHENA_BOARD_PORT → 본체 athena.config.json boardPort → 4700
// 여러 팩 — 뜰 때의 팩·세대를 기억한다. 쓰기 요청 때 지금 팩·세대와 다르면 409 stale-generation(팩을 갈아 끼운 뒤 남은 일감이 다른 팩에 쓰지 않게)
const BOOT_PATHS = paths(ROOT)
const BOOT_PACK = BOOT_PATHS.mode === 'packs' ? (() => {
  let pack = {}
  try { pack = JSON.parse(readFileSync(join(BOOT_PATHS.packDir, 'pack.json'), 'utf8')) } catch { /* 빈 팩 자리(pack new 직후) */ }
  // bodyId · core(뜰 때의 코어 커밋) · instance(뜰 때마다 새 값) — 스튜디오가 "어느 본체의 어느 코드로 뜬 일감인지" 안다
  let core = null
  try { core = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null } catch { /* git 아님 */ }
  return { id: BOOT_PATHS.packId, packId: pack.id ?? null, name: pack.name ?? BOOT_PATHS.packId, generation: BOOT_PATHS.generation, bodyId: bodyIdOf(ROOT), core, instance: randomBytes(6).toString('hex') }
})() : null
// 세대는 팩마다(paths().generation) — 다른 본체·다른 팩의 일로는 stale 이 되지 않는다
const staleGeneration = () => {
  if (!BOOT_PACK) return false
  const now = paths(ROOT)
  return now.mode !== 'packs' || now.packId !== BOOT_PACK.id || now.generation !== BOOT_PACK.generation
}
// 워크트리 자리 — 본체 .worktrees(옛 구조 · 옮긴 본체의 기존 워크트리) + 여러 팩이면 지금 팩 데이터의 worktrees(새 워크트리)
const WORKTREE_ROOTS = [...new Set([join(ROOT, '.worktrees'), BOOT_PATHS.worktrees].map((dir) => { try { return realpathSync(dir) } catch { return dir } }))]
const POLL_MS = 3000
const DONE_KEEP_DAYS = 14 // 완료 칸에 남겨 두는 기간
const SUBAGENT_ACTIVE_SEC = 90 // 로그가 이 안에 바뀌었으면 "작업 중"
const SUBAGENT_RECENT_MIN = 30 // 이 안에 끝난 백그라운드 에이전트까지 보여준다

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout) => resolve(error ? null : stdout))
  })

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// ── 작업자 ──────────────────────────────────────────────────────────────
// 계획서 Checkpoint 의 Owner: · 이슈 frontmatter 의 owner: 가 정본. 없으면 그 파일을 처음 커밋한 사람,
// 커밋 전이면(plans/** 는 로컬) 이 워크스페이스의 git user.name — 로컬 파일은 이 사람이 만든 것이다
const LOCAL_USER = (() => {
  try {
    return execFileSync('git', ['-C', ROOT, 'config', 'user.name'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()
// path → { author, at }. 커밋된 파일은 처음 커밋한 사람이 바뀌지 않아 계속 쓰고, 아직 없으면 1분 뒤 다시 본다
const authorCache = new Map()
const firstAuthor = async (path) => {
  const cached = authorCache.get(path)
  if (cached && (cached.author || Date.now() - cached.at < 60_000)) return cached.author
  const out = await run('git', ['-C', ROOT, 'log', '--diff-filter=A', '--format=%an', '--', relative(ROOT, path)])
  const author = out?.trim().split('\n').at(-1) ?? ''
  authorCache.set(path, { author, at: Date.now() })
  return author
}
const ownerOf = async (declared, path) => declared || (await firstAuthor(path)) || LOCAL_USER

const listFiles = (dir, predicate) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) return listFiles(full, predicate)
    return predicate(full) ? [full] : []
  })
}

// ── 계획서 ──────────────────────────────────────────────────────────────
const STATUS_COLUMN = { planned: 'plan', in_progress: 'doing', blocked: 'doing', ready_for_review: 'review', done: 'done' }

const section = (text, heading) => {
  const match = text.match(new RegExp(`^###\\s*${heading}\\s*\\n([\\s\\S]*?)(?=^##|$(?![\\s\\S]))`, 'm'))
  return match ? match[1].trim() : ''
}
const field = (text, name) => text.match(new RegExp(`^-\\s*${name}:\\s*(.+)$`, 'm'))?.[1].trim() ?? ''
const plain = (value) => value.replace(/\*\*/g, '').replace(/`/g, '').trim()

// 이 계획서가 어떻게 시작됐나 — 이슈 [작업 시작] · /call · /qa-tc · 아테나 대화(정식·경량). 카드·팝업에 한 줄로
const planOrigin = (path, text, rawAgent, issueField) => {
  const title = text.match(/^#\s+(.+)$/m)?.[1] ?? ''
  const agent = rawAgent.startsWith('(') ? '' : rawAgent   // "(정해지지 않음)" 같은 자리표시는 없는 것으로
  if (/issues\/\S+\.md/.test(issueField)) return '📌 이슈 [작업 시작]'
  if (/QA TC/.test(title)) return `🧪 /qa-tc${agent ? ` · ${agent}` : ''}`
  // /call 이 만든 계획서 — 제목은 에이전트가 작업을 시작하며 바꾸므로 파일 이름(…-작업-pane-에서-지시)으로 본다
  if (/작업 \(pane 에서 지시\)\s*$/.test(title) || /-작업-pane-에서-지시\.md$/.test(path)) return `📞 /call ${agent}`.trim()
  if (path.split('/').at(-2) !== 'task') return '🧭 아테나 · 정식 계획'
  if (agent === 'athena' || agent === 'hermes') return '🧭 아테나 대화 (정비)'
  return `🧭 아테나 대화${agent ? ` → ${agent}` : ''}`
}
const leadPaneOfHtml = (path) => {
  const html = path.replace(/\.md$/, '.html')
  if (!existsSync(html)) return ''
  return (readText(html) || '').match(/"(?:leadPane|hermesPane)":\s*"([^"]*)"/)?.[1] ?? ''
}
const readPlan = (path) => {
  const text = readText(path)
  if (!text) return null
  const archived = path.includes('/archive/')
  const checkpoint = text.match(/^## Checkpoint\s*\n([\s\S]*?)(?=^## (?!#))/m)?.[1] ?? ''
  const statusRaw = plain(field(checkpoint, 'Status'))
  const status = archived ? 'done' : (statusRaw.match(/planned|in_progress|blocked|ready_for_review|done/)?.[0] ?? 'planned')
  const progress = progressOf(section(checkpoint, 'Progress'))
  const blocked = plain(section(checkpoint, 'Blocked').split('\n')[0] ?? '').replace(/^-\s*/, '')
  const next = plain(section(checkpoint, 'Next').split('\n').find((line) => line.trim()) ?? '').replace(/^\d+\.\s*/, '')
  const mtime = statSync(path).mtimeMs
  return {
    kind: 'plan',
    created: createdAt(path),
    id: relative(ROOT, path),
    title: plain(text.match(/^#\s+(.+)$/m)?.[1] ?? basename(path, '.md')),
    type: path.split('/').at(archived ? -2 : -2),
    // 정식 = feature·bugfix·refactor (md + html 결정 콘솔) · 경량 = plans/task
    grade: path.split('/').at(-2) === 'task' ? 'light' : 'formal',
    owner: plain(field(checkpoint, 'Owner')),
    // athena 자체 작업 — 서비스 칸반과 따로 [정비] 탭에 보인다. 경량은 Agent: athena(옛 hermes),
    // 정식은 Agent 줄이 없으니 Work ref 가 athena 체크아웃("hermes 메인 체크아웃 · main …")인 것으로 본다(FE 워크트리는 절대 경로라 안 걸린다)
    scope: ['athena', 'hermes'].includes(plain(field(checkpoint, 'Agent'))) || /^(?:athena|hermes)\b/.test(plain(field(checkpoint, 'Work ref'))) ? 'hermes' : 'service',
    status,
    statusNote: plain(statusRaw.replace(/^(planned|in_progress|blocked|ready_for_review|done)\s*[—-]?\s*/, '')),
    column: STATUS_COLUMN[status] ?? 'plan',
    blocked: status === 'blocked' || (blocked && !/^없음/.test(blocked)) ? blocked || '막힘' : '',
    next,
    workRef: plain(field(checkpoint, 'Work ref')),
    // 여러 레포 계획서는 에이전트마다 Work ref 줄이 있다 — pane 을 붙일 때는 모두 본다
    workRefs: [...checkpoint.matchAll(/^-\s*Work ref:\s*(.+)$/gm)].map((match) => plain(match[1].trim())).join('\n'),
    review: plain(field(checkpoint, 'Review')),
    // 이 일을 맡긴 아테나 pane — 정식은 결정 콘솔 PLAN.leadPane(옛 계획서 hermesPane), 경량은 delegate.sh 가 적는 "- Lead pane:" 줄
    leadPane: plain(field(checkpoint, 'Lead pane')) || leadPaneOfHtml(path),
    // PR 줄은 여러 개일 수 있다(레포·앱마다 하나) — 전부 모은다
    pr: [...checkpoint.matchAll(/^-\s*PR:\s*(.+)$/gm)].map((match) => plain(match[1])).join('\n'),
    issue: plain(field(checkpoint, 'Issue')).match(/issues\/\S+\.md/)?.[0] ?? '',
    origin: planOrigin(path, text, plain(field(checkpoint, 'Agent')), plain(field(checkpoint, 'Issue'))),
    updated: plain(field(checkpoint, 'Updated')),
    progress,
    archived,
    mtime,
    html: existsSync(path.replace(/\.md$/, '.html')) ? relative(ROOT, path.replace(/\.md$/, '.html')) : null,
  }
}

// 카드의 "시작" 시각 — 파일이 처음 생긴 때. birthtime 이 없거나(0) 수정 시각보다 뒤면 파일명 앞 YYYYMMDD 를 쓴다
const createdAt = (path) => {
  const { birthtimeMs, mtimeMs } = statSync(path)
  if (birthtimeMs > 0 && birthtimeMs <= mtimeMs) return birthtimeMs
  const day = basename(path).match(/^(\d{4})(\d{2})(\d{2})/)
  return day ? new Date(`${day[1]}-${day[2]}-${day[3]}T00:00:00+09:00`).getTime() : mtimeMs
}

// ── 이슈 ────────────────────────────────────────────────────────────────
// repo 값(`<레포>`, 모노레포 `<레포>/<앱>`·`<레포>/packages`)으로 담당 에이전트를 찾는다. 정본은 설정(scripts/lib/config.mjs)
// 빈 팩 자리(pack new 직후 · /setup 전)에도 뜬다 — 팩이 없으면 레포 없는 설정으로
const config = (() => { try { return loadConfig(ROOT) } catch { return { repos: [] } } })()
const ORG = githubOrg(config)
const AGENT_NAMES = new Set(readdirSync(join(ROOT, '.claude/agents')).map((name) => name.replace(/\.md$/, '')))
// 에이전트 → 담당 레포·운영 기준 브랜치 (워크트리를 어디서 어떤 ref 로 만들지)
const workspaceOf = (agent) => {
  for (const repo of config.repos) {
    if (repo.agents?.includes(agent)) return { repo: repo.name, branch: repo.branch }
    if (repo.packagesAgent === agent) return { repo: repo.name, branch: repo.branch }
    for (const app of Object.values(repo.apps ?? {})) if (app.agent === agent) return { repo: repo.name, branch: app.branch }
  }
  return null
}
const issueWorktree = (issueId, agent) => {
  const target = workspaceOf(agent)
  if (!target) return null
  const slug = `issue-${basename(issueId, '.md')}`
  // 실제 경로로 — 여러 팩이면 <데이터>/packs/<id>/worktrees(Work ref 가 팩을 갈아 끼운 뒤에도 그 팩을 가리키게)
  return { ...target, path: join(BOOT_PATHS.worktrees, target.repo, slug), rel: `.worktrees/${target.repo}/${slug}` }
}
const agentForRepo = (repoValue) => {
  const [repoName, app] = repoValue.split('/')
  const repo = config.repos.find((entry) => entry.name === repoName)
  if (!repo) return ''
  if (app === 'packages') return repo.packagesAgent || ''
  if (app && repo.apps?.[app]) return repo.apps[app].agent || ''
  return repo.agents?.[0] || ''
}
const ISSUE_COLUMN = { open: 'issue', planned: 'plan', in_progress: 'doing', done: 'done', wontfix: 'done' }

const readIssue = (path) => {
  const text = readText(path)
  if (!text) return null
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const meta = Object.fromEntries(
    front
      .split('\n')
      .map((line) => line.match(/^([\w-]+):\s*(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2].replace(/\s+#.*$/, '').trim()]),
  )
  const body = text.slice(front ? text.indexOf('---', 3) + 3 : 0).trim()
  const status = meta.status || 'open'
  return {
    kind: 'issue',
    id: relative(ROOT, path),
    title: meta.title || basename(path, '.md'),
    status,
    column: ISSUE_COLUMN[status] ?? 'issue',
    repo: meta.repo || '',
    // repo: athena(옛 이슈는 hermes) 는 아테나 자체 이슈 — 코어 담당 에이전트가 코어 정본 레포에서 브랜치 · PR 로 고치고 그 PR(pr:)이 머지되면 끝(옛 이슈는 fix: 커밋)
    scope: meta.repo === 'athena' || meta.repo === 'hermes' ? 'hermes' : 'service',
    severity: meta.severity || '',
    type: meta.kind || '',
    source: meta.source || '',
    plan: meta.plan || '',
    agent: meta.agent || agentForRepo(meta.repo || ''),
    owner: meta.owner || '',
    fix: meta.fix || '',
    pr: meta.pr || '',
    reason: meta.reason || '',
    body,
    summary: plain(body.split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? ''),
    created: createdAt(path),
    mtime: statSync(path).mtimeMs,
  }
}

// ── 완료 가능 판정 ───────────────────────────────────────────────────────
// 전부 파일·git·GitHub 에서 기계적으로 확인되는 신호만 쓴다. 판정은 배지일 뿐, 옮기는 건 사람이다
const prCache = new Map() // pr → { state, at }
// org — PR 주소에 적힌 조직(없으면 팩 github.org)
const prState = async (repoName, pr, org = ORG) => {
  const key = `${org}/${repoName}#${pr}`
  const cached = prCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.state
  const out = await run('gh', ['pr', 'view', String(pr).replace(/^#/, ''), '--repo', `${org}/${repoName}`, '--json', 'state', '--jq', '.state'], { timeout: 15_000 })
  const state = out?.trim() || 'UNKNOWN'
  prCache.set(key, { state, at: Date.now() })
  return state
}

// 계획서 PR 줄의 GitHub PR 상태·base — 머지된 것은 바뀌지 않으니 계속 기억하고, 나머지는 5분마다 다시 본다
const prInfoCache = new Map()
const prInfo = async (repoName, number) => {
  const key = `${repoName}#${number}`
  const cached = prInfoCache.get(key)
  if (cached && (cached.state === 'MERGED' || Date.now() - cached.at < 5 * 60_000)) return cached
  const out = await run('gh', ['pr', 'view', String(number), '--repo', `${ORG}/${repoName}`, '--json', 'state,baseRefName,mergedAt,headRefOid'], { timeout: 15_000 })
  let info = { state: 'UNKNOWN', base: '', mergedAt: '', head: '' }
  try { const json = JSON.parse(out ?? ''); info = { state: json.state, base: json.baseRefName, mergedAt: json.mergedAt ?? '', head: json.headRefOid ?? '' } } catch { /* gh 실패 — 다음에 다시 */ }
  const entry = { ...info, at: Date.now() }
  prInfoCache.set(key, entry)
  return entry
}

// 계획서의 PR 이 전부 머지되면(GitHub state MERGED — 어느 base 든) 계획서를 자동으로 완료로. 하나라도 열려 있으면(OPEN·확인 실패) 그대로 둔다.
// 머지 없이 닫힌 것(CLOSED — 취소·다른 PR 로 대체)은 판정에서 빼고, 머지된 PR 이 하나도 없으면 옮기지 않는다.
// Progress 에 남은 단계(빈 맨 앞 칸 `- [ ]`)가 있으면 옮기지 않는다 — 단계 PR 사이 틈에 완료 · 보관되지 않게(plan-bind.mjs hasOpenSteps).
// 진행 중·리뷰 계획서만, Status 줄만 바꾼다(정식이면 html 사본도)
// 학습 루프 5단계 — 내 계획서의 PR 이 모두 머지되면 배우기 검토자 대기열에 넣는다(scripts/learn-review.mjs).
// 표시는 PR 번호 묶음(merged-<번호들>) — 계획서 "- Learn review:" 줄에 같은 표시가 있으면 learn-review 가 건너뛴다
// 이 날짜 이후에 머지된 PR 만 — 기능을 켠 날보다 전에 끝난 작업은 자동으로 돌리지 않는다(지난 작업은 "배운 거 정리해줘"로 수동)
const LEARN_SINCE = '2026-10-09'
const learnQueued = new Set()
const enqueueLearn = (planId, mark, infos = []) => {
  if (infos.length && infos.every((info) => String(info.mergedAt).slice(0, 10) < LEARN_SINCE)) return
  const key = `${planId}@${mark}`
  if (learnQueued.has(key)) return
  learnQueued.add(key)
  const child = spawn(process.execPath, [join(ROOT, 'scripts/learn-review.mjs'), '--enqueue', '--plan', planId, '--head', mark], { cwd: ROOT, detached: true, stdio: 'ignore' })
  // 넣지 못했으면 다음 확인 때 다시 넣는다(넣기 전에 표시만 해 두면 이 일감이 켜져 있는 동안 다시 시도하지 않는다)
  child.on('exit', (code) => { if (code !== 0) learnQueued.delete(key) })
  child.on('error', () => learnQueued.delete(key))
  child.unref()
  console.log(`📚 배우기 검토 대기열 ${planId} (${mark})`)
}
const mergedMark = (infos) => `merged-${infos.map((info) => info.number).sort().join('-')}`

// ── Jev(scripts/lib/jev.mjs) — 키(TYPESAFE_API_KEY)가 없으면 아무것도 하지 않는다 ─────────────
// QA 미분류 오류의 원인 추정 캐시 — 묶음 키(unknownKey) → { cause, confidence, model } · 실패는 { failedAt } 로 두고 10분 뒤 다시 묻는다
const QA_GUESS_FILE = join(ROOT, '.board-jev-qa.json')
const QA_GUESS_RETRY_MS = 10 * 60 * 1000
const QA_GUESS_PER_REQUEST = 5
const qaGuessing = new Set()
const readQaGuesses = () => {
  try { return JSON.parse(readFileSync(QA_GUESS_FILE, 'utf8')) } catch { return {} }
}
const askQaGuesses = (reasons, guesses) => {
  if (!jevEnabled()) return
  const now = Date.now()
  const missing = reasons.filter((reason) => reason.unknownKey && !qaGuessing.has(reason.unknownKey))
    .filter((reason) => { const known = guesses[reason.unknownKey]; return !known || (known.failedAt && now - known.failedAt > QA_GUESS_RETRY_MS) })
    .slice(0, QA_GUESS_PER_REQUEST)
  for (const reason of missing) {
    qaGuessing.add(reason.unknownKey)
    guessCause(reason).then((guess) => {
      // 물은 사이 다른 묶음이 먼저 써 뒀을 수 있다 — 지금 파일을 다시 읽어 이 키만 바꾼다
      const current = readQaGuesses()
      current[reason.unknownKey] = guess ?? { failedAt: Date.now() }
      writeAtomic(QA_GUESS_FILE, JSON.stringify(current))
    }).catch(() => {}).finally(() => qaGuessing.delete(reason.unknownKey))
  }
}
// 학습 후보가 공책 기존 줄과 같은지(scripts/board/learn.mjs checkLearnWithJev) — 1분에 한 번, 겹쳐 돌지 않게(한 번에 후보 몇 개까지는 learn.mjs JEV_PER_RUN)
const LEARN_JEV_EVERY_MS = 60 * 1000
let learnJevAt = 0
let learnJevRunning = false
const checkLearnJev = () => {
  if (!jevEnabled() || learnJevRunning || Date.now() - learnJevAt < LEARN_JEV_EVERY_MS) return
  learnJevAt = Date.now()
  learnJevRunning = true
  checkLearnWithJev().then((done) => {
    for (const line of done) console.log(`🤖 Jev ${line}`)
    if (done.length) refresh()
  }).catch((error) => console.error(`⚠️ Jev 학습 후보 점검 실패: ${error.message}`)).finally(() => { learnJevRunning = false })
}

const openStepsNoted = new Set() // 보류 알림은 PR 묶음마다 한 번만(매 3초 같은 줄을 찍지 않게)
const autoDonePlans = async (plans) => {
  const targets = plans.filter((plan) => !plan.archived && (plan.status === 'ready_for_review' || plan.status === 'in_progress') && /\/pull\/\d+/.test(plan.pr))
  await Promise.all(targets.map(async (plan) => {
    const links = [...new Set([...plan.pr.matchAll(prLinkPattern(ORG))].map((match) => `${match[1]}#${match[2]}`))]
    const infos = await Promise.all(links.map(async (link) => {
      const [repoName, number] = link.split('#')
      return { number, ...(await prInfo(repoName, number)) }
    }))
    const counted = infos.filter((info) => info.state !== 'CLOSED')
    if (!counted.length || counted.some((info) => info.state !== 'MERGED')) return
    // 남은 단계(Progress 의 빈 맨 앞 칸)가 있으면 옮기지 않는다 — 단계마다 PR 을 나눠 올리는 계획서가 단계 PR 을 머지한 틈마다
    // 완료(그 뒤 자동 보관)되던 것(2026-10-27). 칸을 다 채우거나 사람이 완료로 옮기면 그때 끝난다(plan-bind.mjs)
    if (hasOpenSteps(plan.progress)) {
      const key = `${plan.id}@${mergedMark(counted)}`
      if (!openStepsNoted.has(key)) { openStepsNoted.add(key); console.log(`⏸ 자동 완료 보류 ${plan.id} — PR 은 모두 머지됐지만 남은 단계 ${plan.progress.total - plan.progress.checked}개`) }
      return
    }
    // 마지막으로 머지된 PR 을 사유에 적는다
    const last = counted.reduce((latest, info) => (info.mergedAt > latest.mergedAt ? info : latest))
    const merged = last.mergedAt ? new Date(last.mergedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : ''
    const reason = counted.length > 1 ? `자동 — PR ${counted.length}개 모두 머지됨(마지막 #${last.number} → ${last.base}, ${merged})` : `자동 — PR #${last.number} 이 ${last.base} 에 머지됨(${merged})`
    const error = setPlanStatus(plan.id, 'done', reason)
    if (error) { console.log(`⚠️ 자동 완료 실패 ${plan.id}: ${error}`); return }
    console.log(`✅ 자동 완료 ${plan.id} — ${reason}`)
    plan.status = 'done'
    plan.column = 'done'
    enqueueLearn(plan.id, mergedMark(counted), counted)
  }))
  // 사람이 직접 완료로 옮긴 계획서도 — PR 이 모두 머지됐는데 아직 그 PR 묶음을 배우지 않았으면(Learn review 줄에 지금 표시가 없음) 넣는다.
  // 줄이 있어도 이어 머지된 PR 이 생겼으면 표시가 달라 다시 넣는다(자동 보관이 그 표시를 기다린다 — autoArchive)
  const learned = plans.filter((plan) => !plan.archived && plan.status === 'done' && /\/pull\/\d+/.test(plan.pr))
  await Promise.all(learned.map(async (plan) => {
    const links = [...new Set([...plan.pr.matchAll(prLinkPattern(ORG))].map((match) => `${match[1]}#${match[2]}`))]
    const infos = (await Promise.all(links.map(async (link) => {
      const [repoName, number] = link.split('#')
      return { number, ...(await prInfo(repoName, number)) }
    }))).filter((info) => info.state !== 'CLOSED')
    if (!infos.length || infos.some((info) => info.state !== 'MERGED')) return
    const learnLine = (readText(join(ROOT, plan.id)) || '').match(/^- Learn review:.*$/m)?.[0] ?? ''
    if (!learnLine.includes(mergedMark(infos))) enqueueLearn(plan.id, mergedMark(infos), infos)
  }))
}

// PR 자동 리뷰 · 수정 · 머지(scripts/pr-auto.mjs · docs/pr-auto.md) — 켠 레포(pack.json "autoMerge": true)의 열린 PR 에
// 새 HEAD 가 오면(계획서 "- Auto review:" 줄의 sha 와 다르면) 대기열에 넣는다. 보통은 ship.sh 가 push 하자마자 먼저 넣고, 여기는 놓친 것을 잡는 안전망이다
// (PR 상태는 prInfo 캐시(5분)라 늦어도 5분 안에). 같은 HEAD 는 한 번만 — 이 일감의 메모리 · 대기열(pr-auto.mjs --enqueue 가 대기 · 처리 중인 같은 일을 막는다) ·
// 계획서 줄(처리기가 끝난 HEAD 를 건너뛴다). 머지 확인을 기다리는 일은 5분마다 처리기가 살아 있게 한다
const autoReviewQueued = new Set()
let autoKickAt = 0
const autoReviewPlans = async (plans) => {
  let config
  try { config = loadConfig(ROOT) } catch { return }
  const repos = autoMergeRepos(config)
  if (!repos.size) return
  if (Date.now() - autoKickAt > 5 * 60_000) {
    autoKickAt = Date.now()
    spawn(process.execPath, [join(ROOT, 'scripts/pr-auto.mjs'), '--kick'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref()
  }
  // 진행 중 · 리뷰 계획서 + 완료 · 계획 계획서(이어 올린 PR — 열린 PR 의 새 HEAD 가 있으면 ready_for_review 로 되돌린 뒤 · ship.sh 와 같은 규칙 · lib/pr-auto.mjs autoReviewAction)
  const targets = plans.filter((plan) => !plan.archived && autoReviewAction(plan.status) !== 'skip' && /\/pull\/\d+/.test(plan.pr))
  await Promise.all(targets.map(async (plan) => {
    const links = [...new Set([...plan.pr.matchAll(prLinkPattern(ORG))].map((match) => `${match[1]}#${match[2]}`))]
    const text = readText(join(ROOT, plan.id)) || ''
    for (const link of links) {
      const [repoName, number] = link.split('#')
      if (!repos.has(repoName)) continue
      const info = await prInfo(repoName, number)
      if (info.state !== 'OPEN' || !/^[0-9a-f]{40}$/.test(info.head) || !needsReview(text, repoName, number, info.head)) continue
      const key = `${plan.id}@${link}@${info.head}`
      if (autoReviewQueued.has(key)) continue
      // PR 을 조회하는 사이 Status 가 바뀌었을 수 있다(사람이 blocked 로 옮김 등) — 잠금 안에서 지금 Status 로 다시 판정하고,
      // 완료 · 계획이면 그 자리에서 ready_for_review 로 되돌린다. skip 이면 상태도 대기열도 건드리지 않는다(lib/pr-auto.mjs claimAutoReview)
      const path = safePath(plan.id, 'plans')
      if (!path) continue
      let action = 'skip'
      try {
        updatePlan(path, (current) => {
          const claim = claimAutoReview(current, { config, repoName, number, stamp: stamp(), by: '일감 자동(이어 올린 PR)' })
          action = claim.action
          return claim.text
        })
      } catch (error) {
        console.log(`⚠️ 자동 리뷰 대상 확인 실패 ${plan.id}: ${error.message}`)
        continue
      }
      if (action === 'skip') continue
      if (action === 'reopened') {
        console.log(`↩️ ${plan.id} — 이어 올린 PR ${link} 이 열려 있어 ${REOPEN_STATUS} 로 되돌림`)
        plan.status = REOPEN_STATUS
        plan.column = STATUS_COLUMN[REOPEN_STATUS]
      }
      autoReviewQueued.add(key)
      const child = spawn(process.execPath, [join(ROOT, 'scripts/pr-auto.mjs'), '--enqueue', '--plan', plan.id, '--pr', link, '--head', info.head], { cwd: ROOT, detached: true, stdio: 'ignore' })
      child.on('exit', (code) => { if (code !== 0) autoReviewQueued.delete(key) })
      child.on('error', () => autoReviewQueued.delete(key))
      child.unref()
      console.log(`🤖 자동 리뷰 대기열 ${plan.id} · ${link} @${info.head.slice(0, 7)}`)
    }
  }))
}

// 끝난 일 자동 보관(archive.mjs — 2026-10-26 결정 D4) — 이어서 쓸 일이 없을 때 그 자리에서 보관한다.
// 계획서: done · PR 이 모두 머지(머지 없이 닫힌 것은 빼고, 남은 PR 이 없으면 PR 없는 계획서와 같다) · 배우기 검토 끝(또는 대상 아님) · 묶인 에이전트 pane 이 모두 닫힘.
//   묶인 pane = Work ref · Review 줄의 pane(또는 브랜치) + 그 계획서로 띄운 pane 기록(state/pane-sessions — 같은 계획서로 여러 번 띄워 Work ref 가 덮여도 · plan-bind.mjs)
//   일찍 보관하면 commit.sh · ship.sh(--plan 이 plans/ 에 있어야 한다) · 배우기 검토(plans/ 계획서에 줄을 쓴다) · 이어 올린 PR 감지가 계획서를 못 찾는다
// 이슈: done · wontfix 이고 아직 plans/ 에 남은 연결 계획서가 없으면(있으면 계획서를 보관할 때 archive.mjs 가 같이 묶는다)
// 화면(pane 목록)을 못 읽으면 pane 이 닫혔는지 모르니 보관하지 않는다
const autoArchiveFailed = new Set() // 실패한 것은 이 일감이 켜져 있는 동안 다시 시도하지 않는다(매 3초 같은 오류를 내지 않게)
const planReadyToArchive = async (plan) => {
  if (plan.archived || plan.status !== 'done' || plan.agents.length) return false
  const links = [...new Set([...plan.pr.matchAll(prLinkPattern(ORG))].map((match) => `${match[1]}#${match[2]}`))]
  const infos = (await Promise.all(links.map(async (link) => {
    const [repoName, number] = link.split('#')
    return { number, ...(await prInfo(repoName, number)) }
  }))).filter((info) => info.state !== 'CLOSED')
  if (infos.some((info) => info.state !== 'MERGED')) return false
  // 배우기 검토 대상(enqueueLearn 과 같은 기준)이면 계획서에 그 PR 묶음의 "- Learn review:" 줄이 생긴 뒤에
  const learnTarget = infos.length && infos.some((info) => String(info.mergedAt).slice(0, 10) >= LEARN_SINCE)
  if (!learnTarget) return true
  const learnLine = (readText(join(ROOT, plan.id)) || '').match(/^- Learn review:.*$/m)?.[0] ?? ''
  return learnLine.includes(mergedMark(infos))
}
const autoArchive = async (plans, issues) => {
  const archived = new Set()
  // 팩을 갈아 끼운 뒤 남은 일감이면 옮기지도 커밋하지도 않는다(쓰기 API 의 409 와 같은 기준)
  if (staleGeneration()) return archived
  const notes = []
  const results = []
  const planIds = new Set(plans.map((plan) => plan.id))
  for (const plan of plans) {
    if (autoArchiveFailed.has(plan.id) || !(await planReadyToArchive(plan))) continue
    const bundle = archiveBundle(plan.id)
    if (bundle.error) { autoArchiveFailed.add(plan.id); console.log(`⚠️ 자동 보관 실패 ${plan.id}: ${bundle.error}`); continue }
    results.push(bundle)
    archived.add(plan.id)
    // 같이 묶여 옮겨진 끝난 이슈만 목록에서 뺀다 — 열려 있어 남겨 둔 이슈(plan: 만 고친 것)는 그대로 둔다
    for (const path of bundle.paths) if (path.startsWith('issues/') && !existsSync(join(ROOT, path))) archived.add(path)
  }
  for (const issue of issues) {
    if (archived.has(issue.id) || autoArchiveFailed.has(issue.id) || !['done', 'wontfix'].includes(issue.status)) continue
    // 연결 계획서가 아직 plans/ 에 있으면 그 계획서와 함께 보관한다
    if (issue.plan && planIds.has(issue.plan) && !archived.has(issue.plan)) continue
    if (plans.some((plan) => plan.issue === issue.id && !archived.has(plan.id))) continue
    if (issue.agent) {
      const removed = await removeIssueWorktree(issue.id, issue.agent)
      if (removed.error && !removed.error.startsWith('지울 워크트리가 없어요')) notes.push(`${issue.id}: ${removed.error}`)
    }
    const bundle = archiveBundle(issue.id)
    if (bundle.error) { autoArchiveFailed.add(issue.id); console.log(`⚠️ 자동 보관 실패 ${issue.id}: ${bundle.error}`); continue }
    results.push(bundle)
    archived.add(issue.id)
  }
  if (!results.length) return archived
  // 보관한 것만 로컬 커밋(push 는 아테나) — 한 번에 묶어서
  const committed = commitArchive(results)
  console.log(`🗄 자동 보관 ${results.map((result) => result.dir).join(' · ')}${committed.sha ? ` · 커밋 ${committed.sha}` : ''}`)
  if (committed.error) console.log(`⚠️ 자동 보관 커밋 실패: ${committed.error}`)
  for (const note of [committed.note, ...notes].filter(Boolean)) console.log(`ℹ️ ${note}`)
  return archived
}

const doneCheck = async (issue) => {
  const checks = []
  // 이슈 파일은 로컬 전용(.gitignore) — 커밋·push 는 조건이 아니다. 끝나면 [아카이브]가 archive/ 로 묶어 커밋한다

  if (issue.status === 'wontfix') {
    checks.push({ label: 'reason: 하지 않는 이유', ok: Boolean(issue.reason) })
  } else if (issue.type === 'check') {
    checks.push({ label: '## 확인 결과 절', ok: /^## 확인 결과/m.test(issue.body) })
    const followUp = issue.body.match(/^## 후속\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
    const items = followUp.split('\n').filter((line) => /^\s*- /.test(line))
    const open = items.filter((line) => {
      if (/^\s*- \[x\]/i.test(line)) return false
      const linked = line.match(/issues\/[\w.-]+\.md/)
      return !(linked && existsSync(join(ROOT, linked[0])))
    })
    checks.push({ label: items.length ? `## 후속 ${items.length - open.length}/${items.length} 정리` : '## 후속 절 (없으면 "- [x] 없음")', ok: items.length > 0 && open.length === 0 })
  } else if (issue.type === 'knowledge' || issue.type === 'diagram' || issue.scope === 'hermes') {
    // athena 자체 이슈는 kind 와 무관하게 이 기준.
    // 코어를 브랜치 · PR 로 고쳤으면(pr: PR 주소 또는 <레포>#<번호> — 2026-10-25 결정 D4) 그 PR 이 머지됐으면 끝(squash 머지라 fix: sha 는 main 에 없다).
    // pr: 이 없으면 옛 길 — PR 없이 코어 브랜치에 커밋·push 했으니 fix: 커밋이 그 원격 브랜치(이 체크아웃의 upstream · 없으면 origin/main)에 있으면 끝
    // PR 주소면 주소의 조직 · 레포 그대로(코어 정본 레포가 팩 github.org 밖일 수 있다) · <레포>#<번호> 면 팩 github.org
    // pr: 이 적혀 있는데 읽지 못하면 완료로 보지 않는다(옛 fix: 판정으로 넘어가 PR 머지를 건너뛰지 않게)
    const prText = String(issue.pr ?? '').trim()
    const prUrl = prText.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)
    const prShort = prText.match(/^([\w.-]+)#(\d+)$/)
    const prLink = prUrl ? { org: prUrl[1], repo: prUrl[2], number: prUrl[3] } : prShort && { org: ORG, repo: prShort[1], number: prShort[2] }
    if (prText && !prLink) {
      checks.push({ label: `pr: ${prText} — PR 주소 또는 <레포>#<번호> 가 아니다`, ok: false })
    } else if (prLink) {
      const merged = (await prState(prLink.repo, prLink.number, prLink.org)) === 'MERGED'
      checks.push({ label: `pr: ${prLink.org}/${prLink.repo}#${prLink.number} MERGED`, ok: merged })
    } else {
      const coreRef = (await run('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))?.trim() || 'origin/main'
      const shas = issue.fix.split(/[,\s]+/).filter(Boolean)
      let allIn = shas.length > 0
      for (const sha of shas) if ((await run('git', ['-C', ROOT, 'merge-base', '--is-ancestor', sha, coreRef])) === null) allIn = false
      checks.push({ label: shas.length ? `fix: ${shas.join(', ')} ${coreRef} 에 push 됨` : 'fix: 수정 커밋 sha', ok: allIn })
    }
  } else if (issue.type === 'seo') {
    // 서비스당 하나로 매주 갱신되는 SEO Health 이슈(/seo-feedback) — 현재 항목이 전부 해결([x])이면 끝
    const current = issue.body.match(/^## 현재 항목\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? ''
    const items = current.split('\n').filter((line) => /^\s*- \[[ x]\]/i.test(line))
    const resolved = items.filter((line) => /^\s*- \[x\]/i.test(line))
    checks.push({ label: items.length ? `## 현재 항목 ${resolved.length}/${items.length} 해결` : '## 현재 항목 절', ok: items.length > 0 && resolved.length === items.length })
  } else if (issue.type === 'code') {
    const planPath = issue.plan ? join(ROOT, issue.plan) : ''
    const planDone = planPath && existsSync(planPath) && /^- Status:.*\bdone\b/m.test(readText(planPath) ?? '')
    checks.push({ label: 'plan: 계획서 Status done', ok: Boolean(planDone) })
    const repoName = (issue.worktree?.repo || workspaceOf(issue.agent)?.repo || issue.repo.split('/')[0])
    const merged = issue.pr ? (await prState(repoName, issue.pr)) === 'MERGED' : false
    checks.push({ label: issue.pr ? `pr: ${issue.pr} MERGED` : 'pr: PR 번호', ok: merged })
  }
  return { ready: checks.every((check) => check.ok), checks }
}

// ── 지금 동작 중 ─────────────────────────────────────────────────────────
const readPanes = async () => {
  // 화면 계층(scripts/screen)의 에이전트 pane 만 — 없거나 실패면 "찾지 못했어요"
  const listed = await screen(['pane', 'list', '--agent-only'])
  if (!listed) return { available: false, panes: [] }
  try {
    const panes = listed.panes
      .map((pane) => {
        // pane 이름은 label (delegate.sh 가 붙인 '🤖 <에이전트> · <브랜치>') — 없으면 name · pane 제목
        const name = pane.label || pane.name || pane.pane_title || ''
        const delegated = name.match(/^🤖\s*(\S+)(?:\s*·\s*(.+))?$/)
        return {
          kind: 'pane',
          id: pane.id,
          tool: pane.agent,
          status: pane.agent_status || 'unknown',
          // 위임 pane 은 에이전트 이름, athena 루트의 claude 는 아테나(팀리드), 그 밖은 도구 이름
          agent: delegated?.[1] || (pane.agent === 'claude' && pane.cwd === ROOT ? '아테나' : pane.agent),
          role: delegated ? 'agent' : pane.agent === 'claude' && pane.cwd === ROOT ? 'hermes' : 'other',
          branch: delegated?.[2] || '',
          title: pane.title || '',
          cwd: pane.cwd?.replace(homedir(), '~') || '',
          focused: Boolean(pane.focused),
        }
      })
    return { available: true, panes }
  } catch {
    return { available: false, panes: [] }
  }
}

const projectDir = join(homedir(), '.claude/projects', ROOT.replace(/[/.]/g, '-'))

// 메모리 — 아테나 auto memory(<projectDir>/memory/*.md). 읽기 전용. 제목은 목차(MEMORY.md) 링크 글자, 순서도 목차를 따른다
const memoryDir = join(projectDir, 'memory')
const listMemory = () => {
  if (!existsSync(memoryDir)) return []
  const index = existsSync(join(memoryDir, 'MEMORY.md')) ? readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8') : ''
  const titles = new Map([...index.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)].map((match) => [match[2], match[1]]))
  const order = [...titles.keys()]
  // YAML 따옴표 값 — 큰따옴표 안의 \" · \\ 이스케이프도 푼다("\"이름\"" 이 그대로 보이던 것)
  const unquote = (value) => {
    const trimmed = value.trim()
    if (/^"[\s\S]*"$/.test(trimmed)) return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1')
    return trimmed.replace(/^'([\s\S]*)'$/, '$1')
  }
  return readdirSync(memoryDir)
    .filter((file) => file.endsWith('.md') && file !== 'MEMORY.md')
    .map((file) => {
      const text = readFileSync(join(memoryDir, file), 'utf8')
      const front = text.match(/^---\n([\s\S]*?)\n---\n?/)
      const field = (key) => {
        const match = front?.[1].match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'))
        return match ? unquote(match[1]) : ''
      }
      return {
        file,
        title: titles.get(file) || field('name') || file,
        type: field('type'),
        description: field('description'),
        updated: new Date(statSync(join(memoryDir, file)).mtimeMs).toISOString().slice(0, 10),
        body: front ? text.slice(front[0].length).trim() : text.trim(),
      }
    })
    .sort((left, right) => {
      const rank = (item) => (order.includes(item.file) ? order.indexOf(item.file) : order.length)
      return rank(left) - rank(right) || left.file.localeCompare(right.file)
    })
}
const readSubagents = () => {
  const now = Date.now()
  return listFiles(projectDir, (path) => /\/subagents\/agent-[^/]+\.jsonl$/.test(path))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .filter((log) => now - log.mtime < SUBAGENT_RECENT_MIN * 60_000)
    .map((log) => {
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(log.path.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
      } catch {
        // meta 가 없으면 이름만
      }
      // 마지막 도구 호출 한 줄
      let lastTool = ''
      const tail = readText(log.path)?.split('\n').filter(Boolean).slice(-40) ?? []
      for (const line of tail.reverse()) {
        try {
          const content = JSON.parse(line).message?.content
          const tool = Array.isArray(content) ? content.find((part) => part.type === 'tool_use') : null
          if (tool) {
            const input = tool.input ?? {}
            lastTool = `${tool.name} ${input.description || input.file_path || input.pattern || input.command || ''}`.slice(0, 90)
            break
          }
        } catch {
          // 깨진 줄은 건너뛴다
        }
      }
      const ageSec = Math.round((now - log.mtime) / 1000)
      return {
        kind: 'subagent',
        id: basename(log.path, '.jsonl'),
        agent: meta.agentType || 'agent',
        title: meta.description || '',
        status: ageSec < SUBAGENT_ACTIVE_SEC ? 'working' : 'done',
        ageSec,
        lastTool,
      }
    })
    .sort((left, right) => left.ageSec - right.ageSec)
}

const readWorktrees = async () => {
  const found = []
  for (const dir of WORKTREE_ROOTS) {
  if (!existsSync(dir)) continue
  for (const repo of readdirSync(dir)) {
    const repoDir = join(dir, repo)
    // 읽는 도중 워크트리 정리로 폴더가 사라질 수 있다(2026-10-14 일감이 이걸로 죽음) — 없으면 건너뛴다
    let slugs
    try {
      if (!statSync(repoDir).isDirectory()) continue
      slugs = readdirSync(repoDir)
    } catch {
      continue
    }
    for (const slug of slugs) {
      const path = join(repoDir, slug)
      const branch = (await run('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
      if (!branch) continue
      const dirty = ((await run('git', ['-C', path, 'status', '--porcelain'])) ?? '').split('\n').filter(Boolean).length
      found.push({ repo, slug, branch, dirty })
    }
  }
  }
  return found
}

const readHeader = () => {
  let sync = ''
  try {
    sync = JSON.parse(readFileSync(join(ROOT, '.sync/state.json'), 'utf8')).acceptedAt ?? ''
  } catch {
    // sync 기록 없음
  }
  return { sync, usage: readUsage() }
}

// ── AI 사용량 ──────────────────────────────────────────────────────────
// 설치된 AI CLI 를 PATH 에서 찾아, 사용량(요금제 한도 %)을 로컬에 남기는 CLI 만 그 값을 읽어 보여 준다.
// 새 CLI 는 읽는 함수를 만들어 AI_CLIS 에 한 줄 추가하면 된다
// resets_at 은 ISO 문자열 또는 epoch 초로 올 수 있어 ms 로 맞춘다
const toMs = (value) => {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(value ?? '')
  return Number.isNaN(parsed) ? null : parsed
}
// 창 길이(분) → 표시 이름
const windowLabel = (minutes) => {
  if (minutes === 300) return '5시간'
  if (minutes === 10080) return '주간'
  if (minutes % 1440 === 0) return `${minutes / 1440}일`
  if (minutes % 60 === 0) return `${minutes / 60}시간`
  return `${minutes}분`
}
// at 은 분 단위로 내려 값이 들어올 때마다 화면을 다시 그리지 않게 한다
const toMinute = (ms) => Math.floor(ms / 60_000) * 60_000

// Claude — scripts/board/statusline.sh 가 statusline 입력에서 떨군 파일
const readClaudeUsage = () => {
  try {
    const { at, rate_limits: limits } = JSON.parse(readFileSync(join(ROOT, '.board-usage.json'), 'utf8'))
    const windows = [['five_hour', '5시간'], ['seven_day', '주간']]
      .filter(([key]) => typeof limits?.[key]?.used_percentage === 'number')
      .map(([key, label]) => ({ label, percent: Math.round(limits[key].used_percentage), resetsAt: toMs(limits[key].resets_at) }))
    return windows.length ? { at: toMinute(at * 1000), windows } : null
  } catch {
    return null // 아직 statusline 이 한 번도 안 돌았거나 래퍼가 연결되지 않음
  }
}

// Codex — 가장 최근 세션 로그(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)의 마지막 token_count 이벤트
// 로그가 커질 수 있어 끝부분만 읽고, 파일이 그대로면 이전 결과를 쓴다
const CODEX_SESSIONS = join(homedir(), '.codex/sessions')
let codexCache = { key: '', value: null }
const newestChild = (dir, filter) => {
  try {
    return readdirSync(dir).filter(filter).sort().pop() ?? null
  } catch {
    return null
  }
}
const newestCodexLog = () => {
  let dir = CODEX_SESSIONS
  for (let depth = 0; depth < 3; depth += 1) {
    const child = newestChild(dir, (name) => /^\d+$/.test(name))
    if (!child) return null
    dir = join(dir, child)
  }
  const file = newestChild(dir, (name) => name.endsWith('.jsonl'))
  return file ? join(dir, file) : null
}
const readCodexUsage = () => {
  const path = newestCodexLog()
  if (!path) return null
  try {
    const { mtimeMs, size } = statSync(path)
    const key = `${path}:${mtimeMs}:${size}`
    if (codexCache.key === key) return codexCache.value
    const text = readFileSync(path, 'utf8')
    const lines = text.slice(Math.max(0, text.length - 512 * 1024)).split('\n').reverse()
    let value = null
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue
      try {
        const entry = JSON.parse(line)
        const limits = entry.payload?.rate_limits
        const windows = [limits?.primary, limits?.secondary]
          .filter((win) => typeof win?.used_percent === 'number')
          .map((win) => ({ label: windowLabel(win.window_minutes), minutes: win.window_minutes, percent: Math.round(win.used_percent), resetsAt: toMs(win.resets_at) }))
          .sort((left, right) => left.minutes - right.minutes)
        if (windows.length) value = { at: toMinute(Date.parse(entry.timestamp) || mtimeMs), windows }
        break
      } catch {
        // 잘린 줄 — 다음 줄
      }
    }
    codexCache = { key, value }
    return value
  } catch {
    return null
  }
}

const AI_CLIS = [
  { id: 'claude', label: 'Claude', bin: 'claude', read: readClaudeUsage },
  { id: 'codex', label: 'Codex', bin: 'codex', read: readCodexUsage },
]
// PATH 에서 실행 파일 찾기 — 1분마다만 다시 본다
const PATH_DIRS = [...new Set([...(process.env.PATH ?? '').split(':'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'])].filter(Boolean)
let installedCache = { at: 0, ids: [] }
const installedClis = () => {
  if (Date.now() - installedCache.at > 60_000) {
    installedCache = { at: Date.now(), ids: AI_CLIS.filter((cli) => PATH_DIRS.some((dir) => existsSync(join(dir, cli.bin)))).map((cli) => cli.id) }
  }
  return AI_CLIS.filter((cli) => installedCache.ids.includes(cli.id))
}
const readUsage = () =>
  installedClis().map((cli) => {
    const usage = cli.read()
    return { id: cli.id, label: cli.label, at: usage?.at ?? null, windows: usage?.windows.map(({ label, percent, resetsAt }) => ({ label, percent, resetsAt })) ?? [] }
  })

// ── 모으기 ──────────────────────────────────────────────────────────────
// 보호 브랜치(statusline.sh 와 같은 목록)는 여러 계획서가 같이 쓰므로 브랜치로는 붙이지 않는다.
// athena 자체 작업은 모두 main 이라, 그냥 포함 검사를 하면 main 에서 도는 pane 하나가 hermes 계획서 전부를 진행 중으로 끌고 갔다
const PROTECTED_BRANCH = /^(prd|main|master|dev|dev-ecs|prd-.+|release\/.+)$/

const collect = async () => {
  const now = Date.now()
  // archive 는 보드에서 치운 것 — 보이지 않는다
  // plans/setup/ 은 첫 실행 고르기 콘솔(scripts/setup-pick.mjs) — 작업 계획서가 아니라 칸반에 올리지 않는다(콘솔 주소 /plans/setup/*.html 은 그대로 열린다)
  const plans = listFiles(join(ROOT, 'plans'), (path) => path.endsWith('.md') && !path.includes('/plans/archive/') && !path.includes('/plans/setup/'))
    .map(readPlan)
    .filter(Boolean)
    .filter((plan) => plan.column !== 'done' || now - plan.mtime < DONE_KEEP_DAYS * 86_400_000)
  const issues = listFiles(join(ROOT, 'issues'), (path) => path.endsWith('.md') && !path.endsWith('README.md') && !path.includes('/issues/archive/') && !isLearnIssue(path))
    .map(readIssue)
    .filter(Boolean)
    .filter((issue) => issue.column !== 'done' || now - issue.mtime < DONE_KEEP_DAYS * 86_400_000)
  await autoDonePlans(plans)
  await autoReviewPlans(plans)
  // 계획서 Status 가 지난번과 달라졌으면 사건 기록에(측정 — docs/events.md)
  observePlanStatus(ROOT, plans)
  // 완료로 바뀐 시각 — 사건 기록에 없으면(기록 전에 끝난 것) null, 앱은 그때 mtime 을 쓴다
  const done = doneTimes(ROOT)
  for (const plan of plans) plan.doneAt = plan.status === 'done' ? done.get(plan.id) ?? null : null
  const [{ available, panes }, worktrees] = await Promise.all([readPanes(), readWorktrees()])
  await Promise.all([...plans, ...issues].map(async (card) => { card.owner = await ownerOf(card.owner, join(ROOT, card.id)) }))
  const subagents = readSubagents()

  // 이슈마다 완료 가능 판정 (docs/issues.md "완료 기준")
  for (const issue of issues) {
    issue.doneCheck = await doneCheck(issue)
    delete issue.body
  }
  // 이슈마다 워크트리 계획(어느 레포·ref)과 실제로 있는지
  for (const issue of issues) {
    const worktree = issue.agent ? issueWorktree(issue.id, issue.agent) : null
    issue.worktree = worktree ? { repo: worktree.repo, ref: `origin/${worktree.branch}`, rel: worktree.rel, exists: existsSync(worktree.path) } : null
  }
  // 에이전트 pane 을 계획서에 붙인다 — delegate.sh 가 Work ref · Review 에 적은 "pane <id>"(없으면 브랜치) + 그 계획서로 띄운 pane 기록(plan-bind.mjs).
  // 같은 계획서로 여러 번 띄우면 Work ref 는 마지막 pane 으로 바뀌어도 기록은 pane 마다 남는다 — 자동 보관이 일하는 pane 을 놓치지 않게
  const sessions = BOOT_PATHS.mode === 'packs' ? readPaneSessions(join(BOOT_PATHS.state, 'pane-sessions')) : []
  for (const plan of plans) {
    plan.agents = boundPaneIds(plan, panes, sessions, PROTECTED_BRANCH)
    // 에이전트가 지금 일하고 있으면 진행 중 칸에 — 요청을 여러 번 주고받으면 계획서 Status 가 리뷰에 머물러 있어도
    // 실제로는 작업 중이다. 파일은 바꾸지 않고 보여 주는 칸만 (끝나 대기로 돌아가면 다시 리뷰 칸)
    plan.working = plan.agents.some((id) => panes.find((pane) => pane.id === id)?.status === 'working')
    if (plan.working && (plan.column === 'review' || plan.column === 'done')) plan.column = 'doing'
  }
  // 끝난 일 자동 보관 — 화면(pane 목록)을 읽었을 때만(pane 이 닫혔는지 알아야 한다)
  if (available) {
    const archived = await autoArchive(plans, issues)
    if (archived.size) {
      for (const list of [plans, issues]) for (let index = list.length - 1; index >= 0; index -= 1) if (archived.has(list[index].id)) list.splice(index, 1)
    }
  }
  // 이슈에 연결된 계획서는 카드를 따로 만들지 않고 이슈 카드 안에 합친다 — 같은 일이 두 장으로 보이지 않게
  const merged = new Set()
  for (const issue of issues) {
    const plan = plans.find((entry) => entry.id === issue.plan || entry.issue === issue.id)
    if (!plan) continue
    // 아직 열린(open) 이슈가 다른 작업의 계획서를 가리키면 "그 작업 중 발견" 이다 — 합치면 진행 중 계획서 카드가
    // 이슈 칸으로 빨려 들어가 사라진다. 계획서가 이 이슈를 위해 만든 것(Issue:)일 때만 합친다
    if (issue.status === 'open' && plan.issue !== issue.id) continue
    merged.add(plan.id)
    issue.linkedPlan = { id: plan.id, grade: plan.grade, owner: plan.owner, created: plan.created, mtime: plan.mtime, doneAt: plan.doneAt, status: plan.status, progress: plan.progress, blocked: plan.blocked, next: plan.next, workRef: plan.workRef, agents: plan.agents, leadPane: plan.leadPane }
    // 계획서가 리뷰 단계면 이슈 카드도 리뷰 칸에
    if (issue.status === 'in_progress' && plan.status === 'ready_for_review') issue.column = 'review'
    if (plan.working && issue.column !== 'done') issue.column = 'doing'
    issue.linkedPlan.working = plan.working
    if (plan.status === 'blocked') issue.blocked = plan.blocked || '막힘'
  }
  return { header: readHeader(), screen: available, maintenance: MAINTENANCE, agents: [...AGENT_NAMES].sort(), cards: [...issues, ...plans.filter((plan) => !merged.has(plan.id))], panes, subagents, worktrees }
}

// ── 서버 ────────────────────────────────────────────────────────────────
let snapshot = null
// [정비] 탭(아테나 자체 작업)은 코어를 고치는 주 본체 · 개발 체크아웃에서만 — 팩 본체(사용자가 일하는 곳)에서는 그 카드를 서비스 칸반에 합친다
const MAINTENANCE = !isPackBody(ROOT)
let snapshotHash = ''
let updatedAt = 0
const clients = new Set()

const refreshOnce = async () => {
  const collectStarted = Date.now()
  const state = await collect()
  const collectMs = Date.now() - collectStarted
  if (collectMs > 1500) console.log(`⚠️ 일감 재계산 ${collectMs}ms`)
  checkLearnJev()
  const hash = createHash('sha1').update(JSON.stringify(state)).digest('hex')
  if (hash === snapshotHash) return
  snapshot = state
  snapshotHash = hash
  updatedAt = Date.now()
  const payload = `data: ${JSON.stringify({ ...snapshot, updatedAt, boot: BOOT })}\n\n`
  for (const client of clients) client.write(payload)
}
// 갱신은 한 번에 하나 — 수집이 3초보다 오래 걸려도 겹치지 않게(먼저 시작한 낡은 수집이 나중 것을 덮거나 자동 완료·학습 대기열을 두 번 돌리지 않게).
// 도는 중에 요청이 오면(카드 이동 등) 끝난 뒤 한 번 더 돈다. 3초 주기는 도는 중이면 건너뛴다. 오류는 남기고 서버는 계속 돈다
let refreshing = null
let refreshAgain = false
const refresh = (again = true) => {
  if (refreshing) {
    if (again) refreshAgain = true
    return refreshing
  }
  refreshing = (async () => {
    try {
      do {
        refreshAgain = false
        await refreshOnce()
      } while (refreshAgain)
    } catch (error) {
      console.error(`⚠️ 일감 갱신 실패: ${error.message}`)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

const TOKEN = randomBytes(16).toString('hex')
// 서버가 다시 뜨면 토큰이 바뀐다 — 열려 있던 브라우저가 알아채고 새로고침하도록 기동 번호를 따로 준다(토큰은 SSE 로 내보내지 않는다)
const BOOT = randomBytes(6).toString('hex')
// 화면이 쓰는 회사 값 — 화면에 직접 적지 않고 설정에서 넣는다(</script> 가 끼지 않게 < 는 이스케이프)
const PAGE_CONFIG = JSON.stringify({
  githubOrg: ORG,
  agents: [...AGENT_NAMES],
  // QA 대상 앱 이름 → 화면 이름 — 팩에 등록한 화면 레포에서(scripts/qa/apps.mjs)
  qaApps: Object.fromEntries(listQaApps(config).map((entry) => [entry.app, entry.label])),
  qaExampleUrl: config.qa?.exampleUrl ?? 'https://dev.example.com',
}).replace(/</g, '\\u003c')
const FAVICON = readFileSync(join(ROOT, 'scripts/board/favicon.png'))
const page = readFileSync(join(ROOT, 'scripts/board/index.html'), 'utf8').replace('__BOARD_TOKEN__', TOKEN).replace('__BOARD_BOOT__', BOOT)
  .replace('__BOARD_CONFIG__', () => PAGE_CONFIG).replaceAll('__BOARD_QA_EXAMPLE__', () => JSON.parse(PAGE_CONFIG).qaExampleUrl)

// ── 쓰기: 카드 이동 ──────────────────────────────────────────────────────
const PLAN_STATUS_OF = { plan: 'planned', doing: 'in_progress', review: 'ready_for_review', done: 'done' }
const ISSUE_STATUS_OF = { issue: 'open', plan: 'planned', doing: 'in_progress', review: 'in_progress', done: 'done' }
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16)

// dir(plans·issues) 안의 파일만 — 이름(../ 섞임)과 실제 경로(링크가 밖을 가리킴) 둘 다 본다. dir 자체가 링크(팩)면 그 실제 폴더 안
const insideDir = (path, dir) => {
  if (!path.startsWith(join(ROOT, dir) + sep) || !existsSync(path)) return false
  try {
    return realpathSync(path).startsWith(realpathSync(join(ROOT, dir)) + sep)
  } catch {
    return false
  }
}
const safePath = (id, dir) => {
  const path = join(ROOT, id)
  return path.endsWith('.md') && insideDir(path, dir) ? path : null
}

const moveCard = (id, column) => {
  if (id.startsWith('issues/')) {
    const path = safePath(id, 'issues')
    const status = ISSUE_STATUS_OF[column]
    if (!path || !status) return '이슈를 찾지 못했거나 옮길 칸이 올바르지 않아요'
    const text = readFileSync(path, 'utf8')
    if (!/^status:.*$/m.test(text)) return '이슈 파일에 status 줄이 없어요'
    writeFileSync(path, text.replace(/^status:.*$/m, `status: ${status}`))
    return null
  }
  return setPlanStatus(id, PLAN_STATUS_OF[column])
}

// 계획서 Status 를 바꾼다 — note 가 있으면 뒤 설명을 그걸로 바꾸고, 없으면 상태 값만 바꾸고 설명은 둔다
const setPlanStatus = (id, status, note = '') => {
  const path = safePath(id, 'plans')
  if (!path || !status) return '계획서를 찾지 못했거나 옮길 칸이 올바르지 않아요'
  if (path.includes('/archive/')) return '보관(archive)된 계획서는 옮길 수 없어요'
  // 다른 스크립트(commit.sh·ship.sh 등)가 같은 계획서를 고치는 중일 수 있다 — 잠금 안에서 지금 내용을 읽어 Status·Updated 줄만 바꾼다(scripts/lib/plan-update.mjs)
  try {
    return withPlanLock(path, () => {
      const text = readFileSync(path, 'utf8')
      const oldStatus = text.match(/^- Status:.*$/m)?.[0]
      const oldUpdated = text.match(/^- Updated:.*$/m)?.[0]
      if (!oldStatus) return '계획서 Checkpoint 에 Status 줄이 없어요'
      // 상태 값만 바꾸고 뒤의 설명은 둔다
      const STATUS_TOKEN = /(planned|in_progress|blocked|ready_for_review|done)/
      const replaced = STATUS_TOKEN.test(oldStatus) ? oldStatus.replace(STATUS_TOKEN, status) : oldStatus.replace(/^- Status:\s*/, `- Status: ${status} — `)
      const newStatus = note ? `- Status: ${status} — ${note}` : replaced
      const newUpdated = `- Updated: ${stamp()} / ${note ? '일감 자동(PR 머지)' : '일감에서 이동'}`
      let next = text.replace(oldStatus, newStatus)
      if (oldUpdated) next = next.replace(oldUpdated, newUpdated)
      writeAtomic(path, next)
      // 정식 계획서의 결정 콘솔 html 안 md 사본(plan-md)도 같이 — 경량 계획서는 html 이 없다
      const htmlPath = path.replace(/\.md$/, '.html')
      if (existsSync(htmlPath)) {
        let html = readFileSync(htmlPath, 'utf8')
        if (html.includes(oldStatus)) html = html.replace(oldStatus, newStatus)
        if (oldUpdated && html.includes(oldUpdated)) html = html.replace(oldUpdated, newUpdated)
        writeAtomic(htmlPath, html)
      }
      return null
    })
  } catch (error) {
    return `계획서를 고치지 못했어요 — ${error.message}`
  }
}

// ── 쓰기: 아테나에게 지시 ───────────────────────────────────────────────
const sendToPane = async (paneId, text) => {
  const panes = snapshot?.panes ?? []
  // 'hermes' 또는 보낼 수 없는 pane(일감 pane 등)을 주면 떠 있는 아테나 pane 으로 — QA 라이브 [조사 맡기기] 가 쓴다
  const target = panes.find((pane) => pane.id === paneId && pane.role !== 'other') ?? (paneId === 'hermes' || paneId.startsWith('hermes:') ? panes.find((pane) => pane.role === 'hermes') : null)
  if (!target) return '보낼 pane 을 찾지 못했어요 (아테나·에이전트 pane 에만 보낼 수 있어요)'
  const oneLine = text.replace(/\s*\n\s*/g, ' ').trim()
  if (!oneLine || oneLine.length > 2000) return '지시문이 비어 있거나 너무 길어요'
  if ((await screen(['pane', 'send-text', target.id, oneLine])) === null) return `${screenName()} 로 입력을 보내지 못했어요`
  await screen(['pane', 'send-keys', target.id, 'Enter'])
  return null
}

// 결정 콘솔 [이대로 진행] — 그 계획서의 결정 요청(plan:<경로>)에 사람이 답했다고 적고, 지시 앞에 요청 번호를 붙인다.
// 에이전트가 plan-html.mjs --decide 로 확정하면 요청이 delivered 로 닫힌다. 요청이 없거나(옛 계획서) 못 적어도 지시는 그대로 보낸다
const consoleAnswer = (plan, text) => {
  if (!/^plans\/[^\0]+\.md$/.test(plan) || plan.split('/').includes('..')) return text
  try {
    const live = listRequests(ROOT).requests.find((request) => request.dedupeKey === `plan:${plan}`)
    if (!live) return text
    if (live.state === 'open') answerRequest(ROOT, live.id, { choice: '결정 콘솔', text: text.slice(0, 1500), by: 'board' })
    return `[요청 ${live.id}] ${text}`
  } catch (error) {
    console.log(`⚠️ 결정 요청을 적지 못했다 ${plan}: ${error.message}`)
    return text
  }
}

// 이슈 [작업 시작] → 아테나: 떠 있는 아테나 pane 에 끼워 넣지 않고 **새 아테나 pane** 을 열어 그 안에서 처리한다.
// 하던 대화 한가운데에 다른 이슈가 섞이지 않게 — 이슈 하나에 세션 하나. 자리는 아테나 pane 옆(없으면 일감 pane 옆)
const openHermesPane = async (issueId, text) => {
  const issuePath = safePath(issueId, 'issues')
  if (!issuePath) return { error: '이슈 파일을 찾지 못했어요' }
  const prompt = text.trim()
  if (!prompt || prompt.length > 4000) return { error: '지시문이 비어 있거나 너무 길어요' }
  const base = (snapshot?.panes ?? []).find((pane) => pane.role === 'hermes')
  const out = await screen(['pane', 'split', '--target', base ? base.id : 'focused', '--direction', 'right', '--ratio', '0.5', '--cwd', ROOT, '--no-focus'])
  let pane = ''
  try {
    pane = out.pane.id
  } catch {
    return { error: `새 pane 을 열지 못했어요 (${screenName()} pane split)` }
  }
  const title = (readIssue(issuePath)?.title ?? basename(issueId, '.md')).slice(0, 30)
  await screen(['pane', 'rename', pane, `🧭 아테나 · ${title}`])
  // 지시문은 따옴표·줄바꿈이 섞여 있어 파일로 넘긴다(delegate.sh 와 같은 방식). 끝나면 러너가 지운다
  const stamp = randomBytes(4).toString('hex')
  const promptFile = join(tmpdir(), `hermes-issue-prompt-${stamp}`)
  const runner = join(tmpdir(), `hermes-issue-runner-${stamp}`)
  writeFileSync(promptFile, prompt)
  writeFileSync(runner, [
    '#!/usr/bin/env bash',
    `trap "rm -f '${promptFile}' '${runner}'" EXIT INT TERM`,
    `cd '${ROOT}' || exit 1`,
    `claude "$(cat '${promptFile}')"`,
  ].join('\n') + '\n', { mode: 0o755 })
  // pane run 은 한 줄로 친다 — 경로를 셸 작은따옴표로 감싼다(TMPDIR 에 띄어쓰기가 있어도 · 경로에 ' 는 없다)
  if ((await screen(['pane', 'run', pane, `'${runner}'`])) === null) return { error: `pane ${pane} 에서 아테나를 실행하지 못했어요` }
  return { pane }
}

// 담당 에이전트를 레포 workspace 에 띄운다 — delegate.sh 가 workspace 찾기·pane 이름·임시 파일을 다 한다
// 디스패치는 몇 초~수십 초 걸린다 — 작업 번호를 바로 돌려주고, 단계마다 SSE(event: job)로 진행을 밀어 준다
const jobs = new Map()
const STEPS = [
  ['fetch', '운영 ref fetch'],
  ['worktree', '이슈 워크트리'],
  ['plan', '경량 계획서'],
  ['pane', '에이전트 pane'],
]
const pushJob = (job) => {
  const payload = `event: job\ndata: ${JSON.stringify(job)}\n\n`
  for (const client of clients) client.write(payload)
}

const dispatchAgent = async (issueId, agent, text, job) => {
  const started = Date.now()
  const step = (key, state, detail = '') => {
    const entry = job.steps.find((item) => item.key === key)
    Object.assign(entry, { state, detail, sec: Math.round((Date.now() - started) / 100) / 10 })
    pushJob(job)
  }
  const fail = (key, message) => {
    step(key, 'error', message)
    return { error: message }
  }
  if (!AGENT_NAMES.has(agent)) return fail('fetch', `${agent} 라는 에이전트가 없어요`)
  const prompt = text.trim()
  if (!prompt || prompt.length > 4000) return fail('fetch', '지시문이 비어 있거나 너무 길어요')
  if (!safePath(issueId, 'issues')) return fail('fetch', '이슈 파일을 찾지 못했어요')
  const worktree = issueWorktree(issueId, agent)
  if (!worktree) return fail('fetch', `${agent} 의 담당 레포를 athena.config.json 에서 찾지 못했어요`)
  const repoDir = join(ROOT, 'repos', worktree.repo)
  let note = ''
  if (!existsSync(worktree.path)) {
    // 서버는 입력을 받을 수 없다 — ssh 키 암호를 묻다 멈추지 않게 비대화형으로. 안 되면 sync 처럼 https 로 재시도
    step('fetch', 'running', `origin/${worktree.branch}`)
    const quiet = { timeout: 45_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' } }
    let fetched = await run('git', ['-C', repoDir, 'fetch', '--quiet', 'origin', worktree.branch], quiet)
    let via = 'ssh'
    if (fetched === null) {
      via = 'https'
      fetched = await run('git', ['-C', repoDir, '-c', 'url.https://github.com/.insteadOf=git@github.com:', 'fetch', '--quiet', 'origin', worktree.branch], quiet)
    }
    if (fetched === null) note = ' (fetch 실패 — 로컬 ref 로 만들었다)'
    step('fetch', fetched === null ? 'warn' : 'done', fetched === null ? 'ssh·https 모두 실패해서 로컬 ref 로 진행해요' : `origin/${worktree.branch} (${via})`)
    step('worktree', 'running', worktree.rel)
    const added = await run('git', ['-C', repoDir, 'worktree', 'add', '--detach', worktree.path, `origin/${worktree.branch}`], { timeout: 120_000 })
    if (added === null) return fail('worktree', `워크트리를 만들지 못했어요: ${worktree.rel} ← origin/${worktree.branch}`)
  } else {
    step('fetch', 'skip', '워크트리가 이미 있어서 건너뛰었어요')
  }
  const sha = (await run('git', ['-C', worktree.path, 'rev-parse', '--short', 'HEAD']))?.trim() ?? '?'
  step('worktree', 'done', `${worktree.rel} @ ${sha}`)
  const header = `첫 보고 맨 앞에 '📋 경량으로 진행합니다 — 이슈 처리 · <계획서 경로>' 한 줄을 붙인다(계획서가 정식이면 '📋 정식으로 진행합니다'). 작업 디렉토리는 이 이슈 전용 워크트리 ${worktree.path} 다 (origin/${worktree.branch} @ ${sha}, detached — 브랜치 없음). 코드는 이 안에서만 읽는다. repos/${worktree.repo} 메인 체크아웃은 다른 작업이 올라가 있으니 읽지 않는다. `

  // 모든 작업은 계획서 하나에 묶인다 — 이슈에 계획서가 없으면 경량 계획서를 만들어 연결한다
  step('plan', 'running')
  const issueText = readText(join(ROOT, issueId)) ?? ''
  let plan = issueText.match(/^plan:\s*(\S+\.md)/m)?.[1] ?? ''
  if (!plan || !existsSync(join(ROOT, plan))) {
    const title = issueText.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, '') || basename(issueId, '.md')
    const promptPath = join(tmpdir(), `hermes-issue-prompt-${Date.now()}.txt`)
    writeFileSync(promptPath, header + prompt)
    // --no-pane-name — 일감을 띄운 pane(아테나일 수 있다) 이름을 이 이슈로 바꾸지 않게
    plan = ((await run('node', [join(ROOT, 'scripts/new-plan.mjs'), '--agent', agent, '--summary', title, '--issue', issueId, '--prompt-file', promptPath, '--no-pane-name'], { cwd: ROOT })) ?? '').trim()
    rmSync(promptPath, { force: true })
    if (!plan) return fail('plan', '경량 계획서를 만들지 못했어요')
    const withPlan = /^plan:.*$/m.test(issueText) ? issueText.replace(/^plan:.*$/m, `plan: ${plan}`) : issueText.replace(/^(status:.*)$/m, `$1\nplan: ${plan}`)
    writeFileSync(join(ROOT, issueId), withPlan)
  }
  step('plan', 'done', plan)
  step('pane', 'running', `${worktree.repo} workspace`)
  const out = await run(join(ROOT, 'scripts/delegate.sh'), [agent, header + prompt, '--cwd', worktree.path, '--plan', plan], { cwd: ROOT, timeout: 30_000 })
  if (out === null) return fail('pane', `에이전트를 띄우지 못했어요 — ${screenName()} 안에서 일감을 띄웠는지 확인해 주세요`)
  const pane = out.trim().split('\n').pop()
  step('pane', 'done', pane.split(' ')[0])
  // 맡겼으면 카드도 진행 중으로 — open·planned 일 때만 (이미 더 간 상태는 건드리지 않는다)
  const current = readText(join(ROOT, issueId))?.match(/^status:\s*(\S+)/m)?.[1]
  if (!current || current === 'open' || current === 'planned') moveCard(issueId, 'doing')
  return { pane, plan, worktree: worktree.rel, ref: `origin/${worktree.branch}@${sha}${note}` }
}

// 리뷰 요청 — 아테나 pane 을 거치지 않고 reviewer 를 바로 띄운다.
// 어느 레포 workspace·어느 워크트리에 띄울지는 delegate.sh 가 계획서의 Agent·Work ref 를 보고 정한다
const dispatchReview = async (planId, text) => {
  if (!safePath(planId, 'plans') || !planId.endsWith('.md')) return { error: '계획서를 찾지 못했어요' }
  const prompt = text.trim()
  if (!prompt || prompt.length > 4000) return { error: '지시문이 비어 있거나 너무 길어요' }
  const out = await run(join(ROOT, 'scripts/delegate.sh'), ['reviewer', prompt, '--plan', planId], { cwd: ROOT, timeout: 30_000 })
  if (out === null) return { error: `reviewer 를 띄우지 못했어요 — ${screenName()} 안에서 일감을 띄웠는지 확인해 주세요` }
  return { pane: out.trim().split('\n').pop() }
}

const removeIssueWorktree = async (issueId, agent) => {
  const worktree = issueWorktree(issueId, agent)
  if (!worktree || !existsSync(worktree.path)) return { error: '지울 워크트리가 없어요' }
  const dirty = ((await run('git', ['-C', worktree.path, 'status', '--porcelain'])) ?? 'x').trim()
  if (dirty) return { error: '커밋하지 않은 변경이 있어서 지우지 않았어요 — 직접 확인해 주세요' }
  // 에이전트가 로컬 커밋을 할 수 있으니, 깨끗해도 원격 어디에도 없는 커밋이 있으면 지우지 않는다
  const unpushed = ((await run('git', ['-C', worktree.path, 'rev-list', '--count', 'HEAD', '--not', '--remotes'])) ?? '1').trim()
  if (unpushed !== '0') return { error: `push 하지 않은 커밋이 ${unpushed}개 있어서 지우지 않았어요 — 그 pane 에서 "PR 올려줘"(ship.sh)로 올리거나 직접 확인해 주세요` }
  if ((await run('git', ['-C', join(ROOT, 'repos', worktree.repo), 'worktree', 'remove', worktree.path])) === null) return { error: '워크트리를 지우지 못했어요 (git worktree remove 실패)' }
  return { removed: worktree.rel }
}

// 삭제는 휴지통으로 옮기기 — plans/ 는 gitignore 라 지우면 되돌릴 수 없다
const toTrash = (relPath) => {
  const from = join(ROOT, relPath)
  if (!existsSync(from)) return null
  const to = join(ROOT, '.board-trash', stamp().slice(0, 10), relPath)
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, existsSync(to) ? `${to}.${Date.now()}` : to)
  return relPath
}

const archiveCard = async (id) => {
  const moved = []
  const notes = []
  let lastBundle = null
  if (id.startsWith('issues/')) {
    const path = safePath(id, 'issues')
    if (!path || basename(path) === 'README.md') return { error: '이슈 파일을 찾지 못했어요' }
    const text = readFileSync(path, 'utf8')
    const agent = text.match(/^agent:\s*(\S+)/m)?.[1] || agentForRepo(text.match(/^repo:\s*(\S+)/m)?.[1] || '')
    if (agent) {
      const removed = await removeIssueWorktree(id, agent)
      if (removed.removed) moved.push(`워크트리 ${removed.removed} 정리`)
      else if (removed.error && !removed.error.startsWith('지울 워크트리가 없어요')) notes.push(removed.error)
    }
    // 연결된 계획서와 한 폴더로 묶어 보관한다(archive.mjs) — 이슈 plan: 은 새 위치로 고쳐진다
    const bundle = archiveBundle(id)
    if (bundle.error) return { error: bundle.error }
    lastBundle = bundle
    moved.push(...bundle.moved)
  } else {
    const path = safePath(id, 'plans')
    if (!path) return { error: '계획서를 찾지 못했어요' }
    const bundle = archiveBundle(id)
    if (bundle.error) return { error: bundle.error }
    lastBundle = bundle
    moved.push(...bundle.moved)
  }
  // 보관한 것만 로컬 커밋(push 는 아테나)
  const committed = commitArchive([lastBundle])
  if (committed.sha) moved.push(`커밋 ${committed.sha}`)
  if (committed.error) notes.push(`커밋하지 못했어요 — ${committed.error}`)
  if (committed.note) notes.push(committed.note)
  return { moved: moved.filter(Boolean), notes }
}

const deleteCard = async (id) => {
  const moved = []
  const notes = []
  if (id.startsWith('issues/')) {
    const path = safePath(id, 'issues')
    if (!path || basename(path) === 'README.md') return { error: '이슈 파일을 찾지 못했어요' }
    const text = readFileSync(path, 'utf8')
    const agent = text.match(/^agent:\s*(\S+)/m)?.[1] || agentForRepo(text.match(/^repo:\s*(\S+)/m)?.[1] || '')
    // 워크트리 — 커밋 안 된 변경이 있으면 남긴다
    if (agent) {
      const removed = await removeIssueWorktree(id, agent)
      if (removed.removed) moved.push(`워크트리 ${removed.removed} 정리`)
      else if (removed.error && !removed.error.startsWith('지울 워크트리가 없어요')) notes.push(removed.error)
    }
    // 연결된 경량 계획서만 같이 — 정식 계획서는 다른 작업과 묶여 있을 수 있어 두지 않는다
    const plan = text.match(/^plan:\s*(plans\/task\/\S+\.md)/m)?.[1]
    if (plan && toTrash(plan)) moved.push(plan)
    moved.push(toTrash(id))
  } else {
    const path = safePath(id, 'plans')
    if (!path) return { error: '계획서를 찾지 못했어요' }
    moved.push(toTrash(id))
    const html = id.replace(/\.md$/, '.html')
    if (existsSync(join(ROOT, html))) moved.push(toTrash(html))
  }
  return { moved: moved.filter(Boolean), notes, trash: `.board-trash/${stamp().slice(0, 10)}/` }
}

const readBody = (request) =>
  new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 20_000) request.destroy()
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve(null)
      }
    })
  })

// 잘못된 퍼센트 인코딩(%E0%A4%A 등)이면 decodeURIComponent 가 던진다 — 서버가 죽지 않게 빈 경로(= 404)로
const safeDecodedPath = (pathname) => {
  try {
    return join(ROOT, decodeURIComponent(pathname))
  } catch {
    return ''
  }
}

// ── QA 시뮬레이션 (scripts/qa) ─────────────────────────────
let qaChild = null
const QA_ID = /^\d{8}-\d{6}-[\w-]+$/
const QA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.log': 'text/plain; charset=utf-8' }
// 목록에는 요약만 — 화면별 상세는 런 하나를 열 때
// 끝나지 않았는데 2분 넘게 run.json 이 그대로면 죽은 런 — 목록에 계속 ⏳ 로 남지 않게 '중단' 으로 보여 준다
const qaStale = (run) => ['preparing', 'running'].includes(run.status) && Date.now() - statSync(join(QA_RUNS_DIR, run.id, 'run.json')).mtimeMs > 120_000
const qaSummary = (run) => ({
  id: run.id, kind: run.kind ?? 'impact', app: run.app, plan: run.plan, branch: run.branch, head: run.head, base: run.base, profile: run.profile, group: run.group ?? null,
  target: run.target ?? 'local', serverUrl: run.serverUrl ?? null, urls: run.urls ?? null,
  status: run.status, phase: run.phase, error: run.error, startedAt: run.startedAt, finishedAt: run.finishedAt, summary: run.summary,
  screens: run.screens?.length ?? 0, finished: (run.screens ?? []).filter((screen) => !['queued', 'running'].includes(screen.status)).length,
  ...(qaStale(run) ? { status: 'error', error: '응답 없음 — 중단된 런' } : {})
})
// 돌고 있는 런 — run.json 이 2분 안에 갱신됐고 끝나지 않은 것(로컬 서버 포트를 쓰고 무겁기 때문에 한 번에 하나)
function activeQaRun() {
  for (const run of listQaRuns().slice(0, 5)) {
    if (!['preparing', 'running'].includes(run.status)) continue
    const fresh = Date.now() - statSync(join(QA_RUNS_DIR, run.id, 'run.json')).mtimeMs < 120_000
    if (fresh) return run
  }
  return null
}
// 계획서 카드 → QA 대상: Work ref 맨 앞의 워크트리(절대 경로) + 담당 에이전트의 앱(팩에 등록한 레포의 앱 — routes/<앱>.json 이 있는 것만).
// 담당 에이전트로 못 찾으면 워크트리가 어느 레포의 것인지(.worktrees/<레포>/…)로 고른다 — 그 레포 앱이 하나일 때만
function startQaRun(planId) {
  const path = safePath(planId, 'plans')
  if (!path) return { error: '계획서를 찾지 못했어요' }
  const text = readFileSync(path, 'utf8')
  const workRef = text.match(/^- Work ref:\s*(\S+)/m)?.[1] ?? ''
  const worktree = workRef.replace(/`/g, '')
  if (!worktree.startsWith('/') || !existsSync(worktree)) return { error: 'Work ref 에 워크트리 경로가 없어요 — 담당 에이전트가 브랜치를 만든 뒤에 돌릴 수 있어요' }
  const agent = text.match(/^- Agent:\s*(\S+)/m)?.[1] ?? ''
  const realTree = (() => { try { return realpathSync(worktree) } catch { return worktree } })()
  const treeRoot = WORKTREE_ROOTS.find((dir) => realTree.startsWith(dir + sep)) ?? join(ROOT, '.worktrees')
  const repoOfTree = relative(treeRoot, realTree).split(sep)[0]
  const sameRepo = listQaApps(config).filter((entry) => entry.repo === repoOfTree && entry.configured)
  const app = (appOfAgent(config, agent) ?? (sameRepo.length === 1 ? sameRepo[0] : null))?.app
  if (!app || !findQaApp(config, app)?.configured) return { error: `QA 시뮬레이션 설정이 있는 앱이 아니에요 (scripts/qa/routes/<앱>.json — 없으면 node scripts/qa/init-app.mjs --app <앱>)${agent ? ` — 이 계획서는 ${agent}` : ''}` }
  // 방금 띄운 런은 run.json 을 쓰기 전일 수 있다 — 이 서버가 띄운 프로세스가 살아 있으면 먼저 거부
  if (qaChild && qaChild.exitCode === null && qaChild.signalCode === null) return { error: '이 일감이 띄운 QA 가 아직 돌고 있어요 — QA 탭에서 진행을 보세요' }
  const running = activeQaRun()
  if (running) return { error: `다른 QA 가 돌고 있어요 — ${running.id} (${running.phase})` }
  mkdirSync(QA_RUNS_DIR, { recursive: true })
  const log = join(QA_RUNS_DIR, 'launch.log')
  writeFileSync(log, `${new Date().toISOString()} ${planId} ${worktree} ${app}\n`, { flag: 'a' })
  const child = spawn(process.execPath, [join(ROOT, 'scripts', 'qa', 'run.mjs'), '--cwd', worktree, '--app', app, '--plan', planId], { cwd: ROOT, detached: true, stdio: 'ignore' })
  child.unref()
  qaChild = child
  return { ok: true, app, worktree }
}

// 무거운 명령 잠금(scripts/heavy.sh) — QA 는 이 차례를 기다린다. 지금 누가 쥐고 있는지 + 이 일감이 띄운 QA 가 기다리는 중인지
function heavyLockState() {
  const lock = process.env.ATHENA_HEAVY_LOCK || '/tmp/hermes-heavy.lock'
  let holder = ''
  try {
    holder = readFileSync(join(lock, 'what'), 'utf8').trim()
  } catch {
    holder = ''
  }
  const launched = Boolean(qaChild && qaChild.exitCode === null && qaChild.signalCode === null)
  return { holder, waiting: launched && !activeQaRun() }
}

// 전체 검수 가능한 앱 — 팩에 등록한 화면 레포의 앱 중 scripts/qa/routes/<앱>.json 이 있는 것. 프로필마다 세션이 저장돼 있는지
function qaApps() {
  return listQaApps(config).filter((entry) => entry.configured).map(({ app, label }) => {
    const config = readRoutes(app)
    // 세션은 대상(D21 — 로컬 서버·dev 서버)마다 따로 저장된다
    const profiles = Object.entries(config.profiles ?? {}).filter(([key]) => !key.startsWith('$')).map(([key, settings]) => ({
      name: key, note: settings.note ?? '',
      session: !settings.session || existsSync(join(ROOT, '.qa-auth', `${app}.${settings.session}.json`))
    }))
    const scenarioDir = join(ROOT, 'scripts', 'qa', 'scenarios', app)
    return { app, label, profiles, devUrl: config.devUrl ?? null, local: config.local !== false, scenarios: existsSync(scenarioDir) ? readdirSync(scenarioDir).filter((file) => file.endsWith('.json')).length : 0, warnings: routesWarnings(app, config) }
  })
}
// QA 로그인 세션 상태 — 고른 앱·대상(로컬·서버 주소)의 세션 프로필마다 있는지·만료 시각. 쿠키 값은 읽지 않고 로그인 토큰(routes server.tokenCookie)의 만료 시각만 본다
function qaSessions(app, target, server) {
  const file = join(ROOT, 'scripts', 'qa', 'routes', `${app}.json`)
  if (!/^[\w-]+$/.test(app) || !existsSync(file)) return { error: '앱 설정이 없어요' }
  let serverUrl = null
  if (target === 'server') {
    const checked = checkServerUrl(server || '')
    if (checked.error) return { error: checked.error }
    serverUrl = checked.url
  }
  const config = JSON.parse(readFileSync(file, 'utf8'))
  const profiles = Object.entries(config.profiles ?? {}).filter(([key]) => !key.startsWith('$')).map(([name, settings]) => {
    if (!settings.session) return { name, state: 'none' }
    const path = sessionFileOf(ROOT, app, settings.session, target, serverUrl)
    if (!existsSync(path)) return { name, state: 'missing' }
    try {
      const { cookies = [] } = JSON.parse(readFileSync(path, 'utf8'))
      const token = sessionToken(cookies, serverSettings(config))
      const expiresAt = token ? token.expires * 1000 : null
      return { name, state: expiresAt && expiresAt < Date.now() ? 'expired' : 'valid', expiresAt, savedAt: statSync(path).mtimeMs }
    } catch { return { name, state: 'missing' } }
  })
  return { app, target, profiles }
}
// QA 세션 로그아웃 — 그 세션 파일을 .qa-auth/.trash 로 옮긴다(지우지 않는다 — 되살릴 수 있다). 다음 검수 차례에 로그인 창이 뜬다. 돌고 있는 런이 있으면 막는다
function logoutQaSession(app, target, server, profileName) {
  const file = join(ROOT, 'scripts', 'qa', 'routes', `${app}.json`)
  if (!/^[\w-]+$/.test(app) || !existsSync(file)) return { error: '앱 설정이 없어요' }
  if (activeQaRun()) return { error: 'QA 가 돌고 있어요 — 끝난 뒤에 로그아웃해 주세요' }
  let serverUrl = null
  if (target === 'server') {
    const checked = checkServerUrl(server || '')
    if (checked.error) return { error: checked.error }
    serverUrl = checked.url
  }
  const settings = JSON.parse(readFileSync(file, 'utf8')).profiles?.[profileName]
  if (!settings?.session) return { error: '로그인이 없는 세션이에요' }
  const path = sessionFileOf(ROOT, app, settings.session, target, serverUrl)
  if (!existsSync(path)) return { error: '저장된 세션이 없어요' }
  // macOS 휴지통(~/.Trash)은 권한에 막힐 수 있어 .qa-auth/.trash 에 둔다(git 무시 · 되살리려면 이름에서 시각을 빼고 되돌린다)
  const trash = join(ROOT, '.qa-auth', '.trash')
  mkdirSync(trash, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
  renameSync(path, join(trash, `${basename(path, '.json')}.${stamp}.json`))
  return { ok: true, file: basename(path) }
}
// QA 다시 로그인 — 그 세션의 로그인 창(scripts/qa/login.mjs)을 띄운다. 사용자가 로그인을 마치면 세션 파일이 새로 저장된다.
// 서버 대상은 그 주소로, 로컬은 떠 있는 로컬 서버(routes server.port → server.localPorts)로. 로그인 창은 한 번에 하나
let qaLoginChild = null
async function loginQaSession(app, target, server, profileName) {
  const file = join(ROOT, 'scripts', 'qa', 'routes', `${app}.json`)
  if (!/^[\w-]+$/.test(app) || !existsSync(file)) return { error: '앱 설정이 없어요' }
  if (qaLoginChild && qaLoginChild.exitCode === null) return { error: '로그인 창이 이미 열려 있어요 — 그 창에서 마치거나 닫아 주세요' }
  const routes = JSON.parse(readFileSync(file, 'utf8'))
  const settings = routes.profiles?.[profileName]
  if (!settings?.session) return { error: '로그인이 없는 세션이에요' }
  const local = serverSettings(routes)
  let url
  if (target === 'server') {
    const checked = checkServerUrl(server || '')
    if (checked.error) return { error: checked.error }
    url = checked.url
  } else {
    for (const candidate of [local.port, ...local.localPorts].map((port) => `http://localhost:${port}`)) {
      if (await fetch(candidate, { redirect: 'manual' }).then((response) => response.status < 500).catch(() => false)) { url = candidate; break }
    }
  }
  // 로컬 서버가 꺼져 있으면 login.mjs 가 qa-base 로 잠깐 띄운다(--start-local) — 무거운 명령이라 heavy.sh 로(검수가 돌면 차례를 기다린다)
  const startLocal = target !== 'server' && !url
  if (startLocal) url = `http://localhost:${local.port}`
  const args = [join(ROOT, 'scripts', 'qa', 'login.mjs'), '--app', app, '--profile', settings.session, ...(target === 'server' ? ['--server', url] : ['--url', url]), ...(startLocal ? ['--start-local'] : [])]
  qaLoginChild = startLocal
    ? spawn(join(ROOT, 'scripts', 'heavy.sh'), [process.execPath, ...args], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, ATHENA_AGENT: 'qa-login' } })
    : spawn(process.execPath, args, { cwd: ROOT, stdio: 'ignore' })
  return { ok: true, url, startLocal }
}
// QA 중단 — 라이브 화면 [⏹ 중단]. run.json·group.json 의 pid 를 끈다(node 프로세스인지 확인).
// 흐름(묶음)이면 다음 단계로 넘어가지 않게 묶음 프로세스를 먼저 끄고, 도는 단계 런을 끈다(런은 SIGTERM 에서 서버를 끄고 '중단됨' 으로 남는다)
function stopQaRun(id, groupId) {
  const isNode = (pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return false
    try { return /node$/.test(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()) } catch { return false }
  }
  const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
  const stopped = []
  if (groupId) {
    if (!QA_ID.test(groupId)) return { error: '묶음 id 가 올바르지 않아요' }
    const groupFile = join(QA_RUNS_DIR, groupId, 'group.json')
    const group = readJson(groupFile)
    if (!group) return { error: '묶음을 찾지 못했어요' }
    if (isNode(group.pid)) { process.kill(group.pid, 'SIGTERM'); stopped.push(group.pid) }
    for (const stage of group.stages ?? []) if (['queued', 'running', 'waiting-login'].includes(stage.status)) { stage.status = 'skipped'; stage.reason = '라이브 화면에서 중단' }
    group.finishedAt = new Date().toISOString()
    writeFileSync(groupFile, `${JSON.stringify(group, null, 2)}\n`)
    for (const run of listQaRuns().filter((entry) => entry.group === groupId && entry.status === 'running')) {
      if (isNode(run.pid)) { process.kill(run.pid, 'SIGTERM'); stopped.push(run.pid) }
    }
    // 로컬 흐름은 첫 단계가 남긴 dev 서버(routes server.port)를 묶음 프로세스가 끝에 끈다 — 묶음을 껐으니 여기서 끈다
    if (group.target !== 'server') {
      try {
        const port = serverSettings(readRoutes(group.app ?? '')).port
        const pid = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]
        const processGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8' }).trim())
        if (processGroup > 1) process.kill(-processGroup, 'SIGTERM')
      } catch { /* 이미 꺼졌다 */ }
    }
  } else {
    if (!QA_ID.test(id)) return { error: '런 id 가 올바르지 않아요' }
    const run = readJson(join(QA_RUNS_DIR, id, 'run.json'))
    if (!run) return { error: '런을 찾지 못했어요' }
    if (!['preparing', 'running'].includes(run.status)) return { error: '이미 끝난 런이에요' }
    if (isNode(run.pid)) { process.kill(run.pid, 'SIGTERM'); stopped.push(run.pid) }
  }
  if (!stopped.length) return { error: '끌 프로세스를 찾지 못했어요 — 이 기능 전에 시작한 런이면 터미널에서 끊어 주세요' }
  return { ok: true, stopped: stopped.length }
}
// QA TC 목록 — docs/qa/tc/<앱>.md 의 "B) TC" 표를 행 단위로. 문서가 정본이고 여기서는 읽기만 한다
const QA_TC_APPS = listQaApps(config).map((entry) => entry.app)   // 팩에 등록한 화면 레포의 앱 — docs/qa/tc/<앱>.md 가 있는 것만 보인다
const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
function qaTestCases() {
  const dir = join(ROOT, 'docs', 'qa', 'tc')
  const apps = []
  for (const app of QA_TC_APPS) {
    const file = join(dir, `${app}.md`)
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    const start = lines.findIndex((line) => line.startsWith('## B) TC'))
    const cases = []
    let header = null
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith('## ')) break
      if (!line.startsWith('|')) { header = null; continue }
      const cells = tableCells(line)
      if (!header) { header = cells; continue }
      if (cells.every((cell) => /^-+$/.test(cell)) || header[0] !== 'ID') continue
      const value = Object.fromEntries(header.map((name, index) => [name, cells[index] ?? '']))
      cases.push({
        id: value.ID, kind: value['분류'], title: value['제목'], session: value['세션'] || 'logout', viewport: value['뷰포트'],
        pre: value['사전 조건'], steps: value['단계'], expect: value['기대 결과'], auto: value['자동화'], prio: value['우선'], ref: value['근거']
      })
    }
    const scenarioDir = join(ROOT, 'scripts', 'qa', 'scenarios', app)
    const scenarios = existsSync(scenarioDir) ? readdirSync(scenarioDir).filter((name) => name.endsWith('.json')).sort() : []
    // TC 마다 그 TC 를 검사하는 흐름 씬(씬 파일의 "tc") — [선택한 TC만 검수] 가 이 씬들만 돌린다
    // 여정(include 로 부품 씬을 불러오는 씬)은 tc 를 적지 않았으면 부품들의 tc 를 모은다 — run.mjs expandScenario 와 같은 규칙
    const readScene = (dir, name) => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return null } }
    const sceneTcs = (dir, name, depth = 0) => {
      const scene = readScene(dir, name)
      if (!scene) return []
      if (scene.tc?.length || depth > 3) return scene.tc ?? []
      const found = new Set()
      for (const step of scene.steps ?? []) {
        for (const id of step?.section ? step.tc ?? [] : []) found.add(id)
        if (!step?.include) continue
        const prefix = String(step.include)
        const inDraft = prefix.startsWith('_draft/')
        const base = inDraft ? join(dir, '_draft') : dir
        const part = existsSync(base) ? readdirSync(base).filter((file) => file.endsWith('.json')).sort().find((file) => file.startsWith(inDraft ? prefix.slice(7) : prefix)) : null
        if (part) for (const id of sceneTcs(base, part, depth + 1)) found.add(id)
      }
      return [...found]
    }
    const scenarioTcs = scenarios.map((name) => [name, sceneTcs(scenarioDir, name)])
    // 여정 = 부품 씬을 include 하는 씬. TC 를 골라 검수할 때는 작은 씬이 있으면 그것만, 없을 때만 여정을 돌린다
    const journeys = scenarios.filter((name) => (readScene(scenarioDir, name)?.steps ?? []).some((step) => step?.include))
    for (const item of cases) {
      item.scenarioFiles = scenarioTcs.filter(([, tcs]) => tcs.includes(item.id)).map(([name]) => name)
      const parts = item.scenarioFiles.filter((name) => !journeys.includes(name))
      item.runFiles = parts.length ? parts : item.scenarioFiles
    }
    // 여정 카드 — 구간마다 하는 일(부품 씬·TC·모드)
    const findPart = (prefix) => {
      const inDraft = prefix.startsWith('_draft/')
      const base = inDraft ? join(scenarioDir, '_draft') : scenarioDir
      const name = existsSync(base) ? readdirSync(base).filter((file) => file.endsWith('.json')).sort().find((file) => file.startsWith(inDraft ? prefix.slice(7) : prefix)) : null
      return name ? { base, name, scene: readScene(base, name) } : null
    }
    const journeyCards = journeys.map((file) => {
      const scene = readScene(scenarioDir, file) ?? {}
      const sections = []
      let current = null
      for (const step of scene.steps ?? []) {
        if (step?.section) { current = { title: step.section, desc: step.desc ?? '', parts: [], steps: 0, tcs: new Set(step.tc ?? []), modes: new Set() }; sections.push(current); continue }
        if (!current) { current = { title: '(시작)', parts: [], steps: 0, tcs: new Set(), modes: new Set() }; sections.push(current) }
        if (step?.only) current.modes.add(step.only)
        if (step?.include) {
          const part = findPart(String(step.include))
          current.parts.push({ file: part?.name ?? String(step.include), name: part?.scene?.name ?? '(없음)', only: step.only ?? '' })
          for (const id of part ? sceneTcs(part.base, part.name) : []) current.tcs.add(id)
          current.steps += part?.scene?.steps?.length ?? 0
        } else current.steps += 1
      }
      return { file, name: scene.name ?? file, why: scene.why ?? '', sections: sections.map((section) => ({ ...section, tcs: [...section.tcs], modes: [...section.modes] })) }
    })
    apps.push({ app, doc: `docs/qa/tc/${app}.md`, cases, scenarios, journeys, journeyCards, routes: existsSync(join(ROOT, 'scripts', 'qa', 'routes', `${app}.json`)) })
  }
  return apps
}
// [전체 검수] — 최신 개발 브랜치(qa-base)로 화면 전부 + 흐름 씬. 한 번에 하나
// target: local | server(주소 입력 — dev·stg·dev-1~3·PR 미리보기, 운영은 거부) (D21) · flow: 비로그인 → 로그인 상태 전부 차례로(세션 없으면 그 차례에 로그인 요청) → 실패 리포트(D18~D20). 라이브 화면(--live)으로 연다
function startQaSuite(app, profile, target = 'local', flow = false, server = '', tcs = [], journey = null) {
  const known = qaApps().find((entry) => entry.app === app)
  if (target === 'local' && known && !known.local) return { error: `${app} 은 로컬 서버로 돌릴 수 없어요 — 서버를 고르고 주소를 넣어 주세요` }
  const checked = target === 'server' ? checkServerUrl(server || known?.devUrl || '') : null
  if (checked?.error) return { error: checked.error }
  if (!known) return { error: `전체 검수 설정이 없는 앱이에요 — scripts/qa/routes/${app}.json` }
  if (profile && !known.profiles.some((entry) => entry.name === profile)) return { error: `프로필 ${profile} 이 없어요` }
  if (qaChild && qaChild.exitCode === null && qaChild.signalCode === null) return { error: '이 일감이 띄운 QA 가 아직 돌고 있어요 — QA 탭에서 진행을 보세요' }
  const running = activeQaRun()
  if (running) return { error: `다른 QA 가 돌고 있어요 — ${running.id} (${running.phase})` }
  mkdirSync(QA_RUNS_DIR, { recursive: true })
  writeFileSync(join(QA_RUNS_DIR, 'launch.log'), `${new Date().toISOString()} suite ${app} ${profile ?? ''}\n`, { flag: 'a' })
  // [선택한 TC만 검수] — 고른 TC 를 검사하는 흐름 씬만(화면 검사 없이). 고른 목록은 .qa-runs/tc-picks/ 에 남긴다
  const picked = [...new Set(tcs.map(String).filter((id) => /^[A-Z]+-\d+$/.test(id)))]
  let pickArgs = []
  if (picked.length) {
    const picksDir = join(QA_RUNS_DIR, 'tc-picks')
    mkdirSync(picksDir, { recursive: true })
    const picksFile = join(picksDir, `${app}@board-${Date.now()}.json`)
    writeFileSync(picksFile, `${JSON.stringify({ app, from: 'board', tcs: picked.map((id) => ({ id })) }, null, 2)}\n`)
    const caseOf = new Map((qaTestCases().find((entry) => entry.app === app)?.cases ?? []).map((item) => [item.id, item]))
    const files = [...new Set(picked.flatMap((id) => caseOf.get(id)?.runFiles ?? []))]
    pickArgs = ['--tc-picks', picksFile, '--scenarios-only', ...(files.length ? ['--scenarios', files.map((name) => name.replace(/\.json$/, '')).join(',')] : [])]
  }
  // 여정 카드 [▶ 자동]·[▶ 실제] — 그 여정 씬만(화면 검사 없이), 모드
  const journeyArgs = journey?.file && /^[\w가-힣.-]+\.json$/.test(journey.file)
    ? ['--scenarios-only', '--scenarios', journey.file.replace(/\.json$/, ''), '--mode', journey.mode === 'real' ? 'real' : 'auto']
    : []
  const args = [join(ROOT, 'scripts', 'qa', 'run.mjs'), '--suite', '--app', app, '--live', ...(checked ? ['--server', checked.url] : []), ...(flow && !picked.length && !journeyArgs.length ? ['--flow'] : profile ? ['--profile', profile] : []), ...pickArgs, ...journeyArgs]
  qaChild = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: 'ignore' })
  qaChild.unref()
  return { ok: true, app, target, server: checked?.url ?? null, flow, profile: flow ? '(흐름)' : profile || '(기본)' }
}

const allowed = (request) => {
  const origin = request.headers.origin
  const okOrigin = origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`
  return okOrigin && request.headers['x-board-token'] === TOKEN && request.headers['content-type']?.startsWith('application/json')
}

const handleRequest = async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`)
  if (url.pathname === '/events') {
    // 기동 번호 없이 붙는 건 옛 페이지 — 204 를 주면 EventSource 가 재연결을 멈춘다(연결 한도를 잡아먹지 않게)
    if (!url.searchParams.get('boot')) {
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    if (snapshot) response.write(`data: ${JSON.stringify({ ...snapshot, updatedAt, boot: BOOT })}\n\n`)
    clients.add(response)
    const keepAlive = setInterval(() => response.write(': ping\n\n'), 20_000)
    request.on('close', () => {
      clearInterval(keepAlive)
      clients.delete(response)
    })
    return
  }
  // 카드 상세 — 누를 때만 읽는다(실시간 갱신에 싣지 않는다). plans/·issues/ 안의 md 만
  if (url.pathname === '/api/card') {
    const id = String(url.searchParams.get('id') ?? '')
    const dir = id.startsWith('issues/') ? 'issues' : 'plans'
    const path = safePath(id, dir)
    response.writeHead(path ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
    if (!path) return response.end(JSON.stringify({ error: '파일을 찾지 못했어요' }))
    const text = readFileSync(path, 'utf8')
    let plan = null
    if (dir === 'issues') {
      const planId = text.match(/^plan:\s*(\S+\.md)/m)?.[1]
      // 이슈 파일의 plan: 값도 plans/ 안의 계획서만(../ 로 밖을 가리켜도 읽지 않는다)
      const planPath = planId ? safePath(planId, 'plans') : null
      if (planPath) plan = { id: planId, text: readFileSync(planPath, 'utf8') }
    }
    return response.end(JSON.stringify({ id, text, plan }))
  }
  if (url.pathname === '/api/qa/runs') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ runs: listQaRuns().slice(0, 60).map(qaSummary), heavy: heavyLockState() }))
  }
  if (url.pathname === '/api/qa/sessions') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify(qaSessions(String(url.searchParams.get('app') ?? ''), url.searchParams.get('target') === 'server' ? 'server' : 'local', String(url.searchParams.get('server') ?? ''))))
  }
  if (url.pathname === '/api/qa/apps') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ apps: qaApps(), warnings: packQaWarnings(config) }))
  }
  // QA 실시간 페이지(QA 자동화 도구 화면) — 화면·API 호출·트래킹 이벤트를 한 페이지에
  if (url.pathname === '/qa-live') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    // 토큰을 넣어 준다 — 실패 리포트 모달의 [담당 에이전트에게 조사 맡기기] 가 /api/action 으로 아테나 pane 에 보낸다
    return response.end(readFileSync(join(ROOT, 'scripts/board/qa-live.html'), 'utf8').replace('</head>', `<script>window.ATHENA_BOARD_TOKEN = ${JSON.stringify(TOKEN)}</script>\n</head>`))
  }
  // 실시간 화면 스트림(MJPEG) — live/<칸>.jpg 가 바뀔 때마다 이어서 보낸다. <img src> 하나로 끊김 없이 그려진다
  if (url.pathname === '/api/qa/stream') {
    const id = String(url.searchParams.get('id') ?? '')
    const slot = String(url.searchParams.get('slot') ?? '')
    if (!QA_ID.test(id) || !/^[\w-]+$/.test(slot)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return response.end('not found')
    }
    const file = join(QA_RUNS_DIR, id, 'live', `${slot}.jpg`)
    response.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    let lastModified = 0
    const sendFrame = () => {
      try {
        const modified = statSync(file).mtimeMs
        if (modified === lastModified) return
        lastModified = modified
        const frame = readFileSync(file)
        response.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`)
        response.write(frame)
        response.write('\r\n')
      } catch {
        // 아직 프레임이 없거나 바꿔 쓰는 중 — 다음 차례에
      }
    }
    // 런이 끝나면 스트림을 닫는다 — 브라우저는 한 주소에 연결을 6개까지만 열어서, 끝난 런의 스트림이 남아 있으면
    // 일감의 다른 페이지(결정 콘솔 등)가 열리지 않고 계속 돈다. 2초마다 run.json 을 보고, 끝났으면 마지막 프레임까지 보낸 뒤 닫는다
    const runFile = join(QA_RUNS_DIR, id, 'run.json')
    let ticks = 0
    const timer = setInterval(() => {
      sendFrame()
      ticks += 1
      if (ticks % 40 !== 0) return
      try {
        const status = JSON.parse(readFileSync(runFile, 'utf8')).status
        if (status === 'done' || status === 'error') {
          clearInterval(timer)
          response.end()
        }
      } catch {
        // run.json 을 바꿔 쓰는 중 — 다음 차례에
      }
    }, 50)
    request.on('close', () => clearInterval(timer))
    return sendFrame()
  }
  // 실시간 호출 기록 — live.jsonl 을 since(바이트) 뒤부터. 다음에 since 로 next 를 넘긴다
  if (url.pathname === '/api/qa/live') {
    const id = String(url.searchParams.get('id') ?? '')
    const file = join(QA_RUNS_DIR, id, 'live.jsonl')
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
    let lines = []
    let next = since
    if (QA_ID.test(id) && existsSync(file)) {
      const buffer = readFileSync(file)
      const end = buffer.lastIndexOf(10) + 1
      if (end > since) {
        lines = buffer.subarray(since, end).toString('utf8').split('\n').filter(Boolean).map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).filter(Boolean)
        next = end
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ lines, next }))
  }
  if (url.pathname === '/api/qa/tc') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ apps: qaTestCases() }))
  }
  if (url.pathname === '/api/qa/run') {
    const id = String(url.searchParams.get('id') ?? '')
    const file = join(QA_RUNS_DIR, id, 'run.json')
    const ok = QA_ID.test(id) && existsSync(file)
    response.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    if (!ok) return response.end(JSON.stringify({ error: 'QA 런을 찾지 못했어요' }))
    // 실패 문구를 사람이 읽는 원인으로 묶어 붙인다(scripts/qa/explain.mjs) — run.json 원문은 그대로
    // 정규식이 모르는 묶음은 Jev 추정을 캐시에서 붙이고, 아직 없으면 뒤에서 물어 둔다(다음 새로고침에 보인다)
    try {
      const run = JSON.parse(readFileSync(file, 'utf8'))
      const guesses = readQaGuesses()
      for (const screen of run.screens ?? []) {
        if (!screen.problems?.length) continue
        screen.reasons = explainProblems(screen.problems, guesses)
        askQaGuesses(screen.reasons, guesses)
      }
      return response.end(JSON.stringify(run))
    } catch {
      return response.end(readFileSync(file))
    }
  }
  // QA 스크린샷·리포트 — .qa-runs/<런 id>/ 안의 png·html·json·log 만(경로 탈출 404)
  if (url.pathname.startsWith('/qa-runs/')) {
    let inner = ''
    try {
      inner = decodeURIComponent(url.pathname.slice('/qa-runs/'.length))
    } catch {
      inner = ''
    }
    const path = join(QA_RUNS_DIR, inner)
    const type = QA_TYPES[path.slice(path.lastIndexOf('.'))]
    if (inner && type && QA_ID.test(inner.split('/')[0]) && path.startsWith(QA_RUNS_DIR + sep) && existsSync(path) && statSync(path).isFile()) {
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      return response.end(readFileSync(path))
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return response.end('not found')
  }
  // board.sh 가 이미 보고 있는 탭이 있는지 묻는다 — 있으면 새 탭을 열지 않는다
  // 히스토리 — 보관된 일(archive/). 누를 때만 읽는다
  if (url.pathname === '/api/history') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return response.end(JSON.stringify({ items: listHistory() }))
  }
  if (url.pathname === '/api/history/item') {
    const item = readHistoryItem(String(url.searchParams.get('dir') ?? ''))
    response.writeHead(item ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
    return response.end(JSON.stringify(item ?? { error: '보관된 일을 찾지 못했어요' }))
  }
  // 지표 — 사건 기록(state/events.jsonl)을 계획서마다 묶은 숫자(scripts/lib/metrics.mjs). 누를 때만 읽는다
  if (url.pathname === '/api/metrics') {
    const days = url.searchParams.get('days') === 'all' ? null : Number(url.searchParams.get('days')) || 7
    const summary = summarize(readEvents(ROOT), { days })
    // 제목은 계획서에서 — 지웠거나 보관했으면 경로만
    for (const plan of summary.plans) {
      const text = plan.plan.startsWith('plans/') && !plan.plan.includes('..') ? readText(join(ROOT, plan.plan)) : null
      plan.title = text ? plain(text.match(/^#\s+(.+)$/m)?.[1] ?? '') : ''
      plan.exists = Boolean(text)
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify(summary))
  }
  if (url.pathname === '/api/learn') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify(listLearn()))
  }
  if (url.pathname === '/api/memory') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    return response.end(JSON.stringify({ dir: memoryDir.replace(homedir(), '~'), items: listMemory() }))
  }
  if (url.pathname === '/api/viewers') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ viewers: clients.size }))
    return
  }
  if (url.pathname === '/api/state') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    // pack — 이 일감이 뜰 때의 팩·세대(옛 구조면 없다). 스튜디오가 지금 팩과 비교해 다시 띄울지 정한다
    response.end(JSON.stringify({ ...snapshot, updatedAt, boot: BOOT, ...(BOOT_PACK ? { pack: BOOT_PACK } : {}) }))
    return
  }
  if (request.method === 'POST' && ['/api/move', '/api/action', '/api/dispatch', '/api/review', '/api/worktree-remove', '/api/delete', '/api/archive', '/api/hermes-new', '/api/qa-start', '/api/qa-suite', '/api/qa-approve', '/api/qa-logout', '/api/qa-login', '/api/qa-stop', '/api/learn-apply', '/api/learn-discard', '/api/learn-edit', '/api/learn-remove', '/api/learn-tidy', '/api/shutdown'].includes(url.pathname)) {
    const reply = (code, body) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(body))
    }
    if (!allowed(request)) return reply(403, { error: '허용되지 않은 요청이에요 (토큰·Origin 확인)' })
    const body = await readBody(request)
    if (!body) return reply(400, { error: '요청 형식이 올바르지 않아요' })
    // 끄기 — 스튜디오가 팩을 갈아 끼우기 전에(같은 출처 + 토큰 + JSON). 세대가 달라도 끌 수는 있다
    if (url.pathname === '/api/shutdown') {
      reply(200, { ok: true })
      setTimeout(() => shutdown(0), 50)
      return
    }
    if (staleGeneration()) return reply(409, { error: 'stale-generation', message: '팩을 갈아 끼웠어요 — 일감을 다시 띄워 주세요' })
    if (url.pathname === '/api/dispatch') {
      // 바로 작업 번호를 돌려주고 뒤에서 돈다 — 진행은 SSE event: job
      const job = { id: randomBytes(4).toString('hex'), issue: String(body.id ?? ''), agent: String(body.agent ?? ''), state: 'running', steps: STEPS.map(([key, label]) => ({ key, label, state: 'wait' })) }
      jobs.set(job.id, job)
      dispatchAgent(job.issue, job.agent, String(body.text ?? ''), job)
        .catch((error) => ({ error: `처리 중 오류 — ${error.message}` }))
        .then(async (result) => {
          Object.assign(job, result.error ? { state: 'error', error: result.error } : { state: 'done', result })
          pushJob(job)
          // 끝난 작업은 10분 뒤 잊는다(오래 켜 둬도 쌓이지 않게)
          setTimeout(() => jobs.delete(job.id), 600_000).unref()
          await refresh()
        })
      return reply(202, { ok: true, job: job.id })
    }
    if (url.pathname === '/api/qa-suite') {
      const result = startQaSuite(String(body.app ?? ''), String(body.profile ?? ''), body.target === 'server' ? 'server' : 'local', Boolean(body.flow), String(body.server ?? ''), Array.isArray(body.tcs) ? body.tcs : [], body.journey ?? null)
      return reply(result.error ? 400 : 202, result)
    }
    if (url.pathname === '/api/qa-stop') {
      const result = stopQaRun(String(body.id ?? ''), body.group ? String(body.group) : '')
      return reply(result.error ? 400 : 200, result)
    }
    if (url.pathname === '/api/qa-login') {
      const result = await loginQaSession(String(body.app ?? ''), body.target === 'server' ? 'server' : 'local', String(body.server ?? ''), String(body.profile ?? ''))
      return reply(result.error ? 400 : 202, result)
    }
    if (url.pathname === '/api/qa-logout') {
      const result = logoutQaSession(String(body.app ?? ''), body.target === 'server' ? 'server' : 'local', String(body.server ?? ''), String(body.profile ?? ''))
      return reply(result.error ? 400 : 200, result)
    }
    if (url.pathname === '/api/qa-approve') {
      const id = String(body.id ?? '')
      if (!QA_ID.test(id)) return reply(400, { error: '런 id 가 올바르지 않아요' })
      const result = approveQaRun(id, body.key ? [String(body.key)] : null)
      return reply(result.error ? 400 : 200, result.error ? result : { ok: true, screens: result.screens, shots: result.shots })
    }
    if (url.pathname === '/api/qa-start') {
      const result = startQaRun(String(body.id ?? ''))
      return reply(result.error ? 400 : 202, result)
    }
    if (url.pathname.startsWith('/api/learn-')) {
      const id = String(body.id ?? '')
      const edits = typeof body.edits === 'object' && body.edits ? body.edits : {}
      const action = { '/api/learn-apply': () => applyLearn(id, edits), '/api/learn-discard': () => discardLearn(id), '/api/learn-edit': () => editLearned(id, edits), '/api/learn-remove': () => removeLearned(id), '/api/learn-tidy': () => tidyLine(id, Number(body.index), body.act === 'remove' ? 'remove' : 'keep', String(body.line ?? '')) }[url.pathname]
      let result
      try {
        result = action()
      } catch (error) {
        return reply(500, { error: `학습 처리 중 오류: ${error.message}` })
      }
      return reply(result.error ? 400 : 200, result)
    }
    if (url.pathname === '/api/hermes-new') {
      const result = await openHermesPane(String(body.id ?? ''), String(body.text ?? ''))
      if (result.error) return reply(400, result)
      await refresh()
      return reply(200, { ok: true, ...result })
    }
    if (url.pathname === '/api/review') {
      const result = await dispatchReview(String(body.id ?? ''), String(body.text ?? ''))
      if (result.error) return reply(400, result)
      await refresh()
      return reply(200, { ok: true, ...result })
    }
    if (url.pathname === '/api/delete' || url.pathname === '/api/archive') {
      const result = url.pathname === '/api/delete' ? await deleteCard(String(body.id ?? '')) : await archiveCard(String(body.id ?? ''))
      if (result.error) return reply(400, result)
      await refresh()
      return reply(200, { ok: true, ...result })
    }
    if (url.pathname === '/api/worktree-remove') {
      const result = await removeIssueWorktree(String(body.id ?? ''), String(body.agent ?? ''))
      if (result.error) return reply(400, result)
      await refresh()
      return reply(200, { ok: true, ...result })
    }
    const text = url.pathname === '/api/action' ? consoleAnswer(String(body.plan ?? ''), String(body.text ?? '')) : ''
    const error = url.pathname === '/api/move' ? moveCard(String(body.id ?? ''), String(body.column ?? '')) : await sendToPane(String(body.pane ?? ''), text)
    if (error) return reply(400, { error })
    await refresh()
    return reply(200, { ok: true })
  }
  // 탭 아이콘(아테나 로고) — /favicon.ico 도 같은 그림을 준다(링크 줄이 없는 결정 콘솔에서 브라우저가 스스로 찾는다)
  if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' })
    response.end(FAVICON)
    return
  }
  // 보관된 결정 콘솔(archive/<이름>/plan.html) — 히스토리에서 읽기 전용으로 본다. 토큰을 넣지 않아 [이대로 진행] 은 복사로 바뀐다
  if (url.pathname.startsWith('/archive/') && url.pathname.endsWith('/plan.html')) {
    const path = safeDecodedPath(url.pathname)
    if (path && path.startsWith(join(ROOT, 'archive') + sep) && existsSync(path)) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(readFileSync(path))
      return
    }
  }
  // 계획서 HTML(결정 콘솔)은 plans/ 안의 것만 연다
  // 토큰을 넣어 준다 — 콘솔의 [이대로 진행] 이 /api/action 으로 PLAN.leadPane 에 결정을 보낸다(같은 출처라 Origin 검사도 통과)
  if (url.pathname.startsWith('/plans/') && url.pathname.endsWith('.html')) {
    const path = safeDecodedPath(url.pathname)
    if (path && insideDir(path, 'plans')) {
      const html = readFileSync(path, 'utf8').replace('</head>', `<script>window.ATHENA_BOARD_TOKEN = ${JSON.stringify(TOKEN)}</script>\n</head>`)
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(html)
      return
    }
  }
  response.writeHead(url.pathname === '/' ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(url.pathname === '/' ? page : 'not found')
}

// 쓰기 토큰 파일 — 여러 팩이면 <팩 데이터>/state/board-token(권한 600). 스튜디오는 bin/athena pack board-token --json 으로 받는다
const TOKEN_FILE = BOOT_PACK ? join(BOOT_PATHS.state, 'board-token') : null
const writeTokenFile = () => {
  if (!TOKEN_FILE) return
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true })
    writeFileSync(TOKEN_FILE, JSON.stringify({ token: TOKEN, port: PORT, pid: process.pid, generation: BOOT_PACK.generation, packId: BOOT_PACK.id }), { mode: 0o600 })
    chmodSync(TOKEN_FILE, 0o600)   // mode 는 새로 만들 때만 먹는다 — 이미 있던 파일(이전 일감이 남긴 것)도 600 으로
  } catch (error) { console.error(`⚠️ 일감 토큰 파일을 쓰지 못했다: ${error.message}`) }
}
const shutdown = (code) => {
  // 내 토큰 파일만 지운다(그 사이 다른 일감이 새로 썼으면 그대로)
  try { if (TOKEN_FILE && JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).pid === process.pid) rmSync(TOKEN_FILE, { force: true }) } catch { /* 없다 */ }
  process.exit(code)
}
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

// 요청 처리 중 예외(사라진 파일·깨진 JSON·쓰기 오류)는 500 으로 답하고 서버는 계속 돈다
createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(`⚠️ ${request.method} ${request.url} 처리 실패: ${error.message}`)
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    if (!response.writableEnded) response.end(JSON.stringify({ error: `처리하지 못했어요 — ${error.message}` }))
  })
}).listen(PORT, '127.0.0.1', async () => {
  writeTokenFile()
  await refresh()
  setInterval(() => refresh(false), POLL_MS)
  console.log(`아테나 일감: http://localhost:${PORT}  (3초마다 갱신 · Ctrl+C 로 종료)`)
})
