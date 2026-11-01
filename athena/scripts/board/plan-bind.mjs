// @ts-check
/**
 * 현황판 — 계획서에 묶인 pane 과 "남은 단계" 판정(server.mjs 자동 완료 · 자동 보관이 쓴다). 파일 · 화면을 직접 읽지 않는 순수 함수 + pane 기록 읽기 하나.
 *
 * 묶인 pane(2026-10-27 · 진행 중 계획서가 보관된 사고 뒤):
 *   - 계획서 줄 — Work ref(에이전트마다 한 줄 · delegate.sh 가 같은 에이전트를 다시 띄우면 그 줄을 바꿔 쓴다) · Review 의 "pane <id>", 또는 Work ref 의 브랜치
 *   - pane 기록 — <팩 데이터>/state/pane-sessions/<pane>.json(scripts/hooks/pane-session.py)의 plan. delegate.sh 가 띄운 pane 은
 *     ATHENA_PLAN 으로 계획서를 알고 있어, 같은 계획서로 여러 번 띄워 Work ref 가 덮여도 pane 마다 남는다.
 *     pane id 는 데몬이 파일에 이어 세어(src/daemon/main.mts createIdGen) 다시 쓰이지 않지만, 집을 초기화하면 처음부터라
 *     기록의 에이전트와 지금 pane 이름의 에이전트가 같을 때만 묶는다
 *
 * 남은 단계(2026-11-01 — PR 8개가 머지됐는데 빈 칸 때문에 며칠째 안 끝났다): 자동 완료를 막는 것은 단계 칸뿐이다 — 빈 칸(`- [ ]`)의 문구가 `N단계` 로 시작하거나 `(단계)` 표시가 있을 때.
 *   맨 앞 칸 · 들여 쓴 칸 모두 자기 문구로만 본다(단계 칸 아래 하위 칸은 표시가 없으면 일반 칸). 일반 빈 칸은 완료를 막지 않고 Lead pane 에 알린다(남은 일은 이슈로 — docs/issues.md).
 *   고치지 않은 템플릿 자리 줄(TEMPLATE_PLACEHOLDER_LINES)은 어느 쪽으로도 세지 않는다.
 *   진행 표시 숫자(checked/total)는 맨 앞 칸 기준 그대로.
 *
 * 스튜디오 앱도 이 파일을 본체에서 바로 불러 쓴다(src/main/pane-watch.mts — 현황판이 꺼져 있을 때 pane 머리줄 [상세] 를 정하려고 · bindingSources).
 *   그래서 node 기본 모듈만 가져온다 — 현황판 서버 · 설정을 읽는 모듈을 여기서 가져오지 않는다
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// 보호 브랜치(statusline.sh 와 같은 목록)는 여러 계획서가 같이 쓰므로 브랜치로는 붙이지 않는다.
// athena 자체 작업은 모두 main 이라, 그냥 포함 검사를 하면 main 에서 도는 pane 하나가 hermes 계획서 전부를 진행 중으로 끌고 갔다
export const PROTECTED_BRANCH = /^(prd|main|master|dev|dev-ecs|prd-.+|release\/.+)$/
export const DONE_KEEP_DAYS = 14 // 완료 칸에 남겨 두는 기간

/** 계획서 줄 값의 꾸밈(굵게 · 코드)을 걷어 낸다 @param {string} value */
export const plain = (value) => value.replace(/\*\*/g, '').replace(/`/g, '').trim()
/** "- <이름>: 값" 줄의 값 @param {string} text @param {string} name */
export const field = (text, name) => text.match(new RegExp(`^-\\s*${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''
/** 계획서 글 → ## Checkpoint 절 본문 @param {string} text */
// 다음 `## ` 제목에서 끝난다 — 코드 울타리(```) 안의 `## ` 줄(Validation 에 붙인 출력 · 예시)은 제목이 아니라서 절을 끊지 않는다
export const checkpointOf = (text) => {
  const lines = String(text).split('\n')
  const start = lines.findIndex((line) => /^## Checkpoint\s*$/.test(line))
  if (start < 0) return ''
  const body = []
  // 코드 펜스 — 여는 줄의 문자(` 또는 ~)와 길이를 기억하고 같은 문자로 그 길이 이상인 닫는 줄이 나올 때만 끝난다(CommonMark)
  /** @type {{ char: string, length: number } | null} */
  let fence = null
  for (const line of lines.slice(start + 1)) {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!fence && mark?.[1]) fence = { char: String(mark[1][0]), length: mark[1].length }
    else if (fence && mark?.[1] && mark[1][0] === fence.char && mark[1].length >= fence.length && !String(mark[2]).trim()) fence = null
    else if (!fence && /^## (?!#)/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}
/** Checkpoint → Status(보관된 계획서는 done) @param {string} checkpoint @param {boolean} archived */
export const statusOf = (checkpoint, archived) => (archived ? 'done' : (plain(field(checkpoint, 'Status')).match(/planned|in_progress|blocked|ready_for_review|done/)?.[0] ?? 'planned'))

const readText = (/** @type {string} */ path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
// 정식 계획서의 아테나 pane — 결정 콘솔 PLAN.leadPane(옛 계획서 hermesPane)
const leadPaneOfHtml = (/** @type {string} */ path) => {
  const html = path.replace(/\.md$/, '.html')
  if (!existsSync(html)) return ''
  return (readText(html) || '').match(/"(?:leadPane|hermesPane)":\s*"([^"]*)"/)?.[1] ?? ''
}

/** 계획서에서 pane 을 묶는 줄 — Work ref(첫 줄 · 전부) · Review · 맡긴 아테나 pane
 * @param {string} path 계획서 md 경로(정식이면 같은 이름 html 의 leadPane 을 읽는다)
 * @param {string} checkpoint */
export const planRefs = (path, checkpoint) => ({
  workRef: plain(field(checkpoint, 'Work ref')),
  // 여러 레포 계획서는 에이전트마다 Work ref 줄이 있다 — pane 을 붙일 때는 모두 본다
  workRefs: [...checkpoint.matchAll(/^-\s*Work ref:\s*(.+)$/gm)].map((match) => plain((match[1] ?? '').trim())).join('\n'),
  review: plain(field(checkpoint, 'Review')),
  // 이 일을 맡긴 아테나 pane — 정식은 결정 콘솔 PLAN.leadPane(옛 계획서 hermesPane), 경량은 delegate.sh 가 적는 "- Lead pane:" 줄
  leadPane: plain(field(checkpoint, 'Lead pane')) || leadPaneOfHtml(path),
})

/** 현황판에 올리는 계획서 파일 — archive 는 치운 것, plans/setup/ 은 첫 실행 고르기 콘솔(scripts/setup-pick.mjs — 작업 계획서가 아니다)
 * @param {string} dir 본체 plans 폴더
 * @returns {string[]} */
export const planFiles = (dir) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return planFiles(full)
    return full.endsWith('.md') && !full.includes('/plans/archive/') && !full.includes('/plans/setup/') ? [full] : []
  })
}

/** 화면 pane 하나 → 현황판 pane 모양(server.mjs readPanes · /api/state panes). 위임 pane 은 이름표 '🤖 <에이전트> · <브랜치>'
 * @param {{ id: string, label?: string | null, name?: string | null, pane_title?: string | null, agent?: string | null, agent_status?: string | null, title?: string | null, cwd?: string | null, focused?: boolean }} pane
 * @param {string} root 본체 폴더 — 여기서 도는 claude 가 아테나
 * @param {string} home 홈 폴더(cwd 를 ~ 로 줄여 보인다) */
export const boardPaneOf = (pane, root, home) => {
  // pane 이름은 label (delegate.sh 가 붙인 '🤖 <에이전트> · <브랜치>') — 없으면 name · pane 제목
  const name = pane.label || pane.name || pane.pane_title || ''
  const delegated = name.match(/^🤖\s*(\S+)(?:\s*·\s*(.+))?$/)
  const lead = pane.agent === 'claude' && pane.cwd === root
  return {
    kind: 'pane',
    id: pane.id,
    tool: pane.agent,
    status: pane.agent_status || 'unknown',
    // 위임 pane 은 에이전트 이름, athena 루트의 claude 는 아테나(팀리드), 그 밖은 도구 이름
    agent: delegated?.[1] || (lead ? '아테나' : pane.agent),
    role: delegated ? 'agent' : lead ? 'hermes' : 'other',
    branch: delegated?.[2] || '',
    title: pane.title || '',
    cwd: pane.cwd?.replace(home, '~') || '',
    focused: Boolean(pane.focused),
  }
}

/** 경량 계획서 템플릿(docs/plan-template-light.md)이 Progress 에 넣는 자리 줄 — 에이전트가 고치지 않고 남기면 남은 단계로 세지 않는다.
 * 판별: 고치지 않은 빈 칸 줄(`- [ ] …`)이 아래 원문과 글자 그대로 같을 때만(앞뒤 공백 무시). 한 글자라도 고쳤거나 [x] 로 채웠으면 보통 칸.
 * 템플릿 줄을 바꾸면 여기도 같이(athena/test/board-auto-test.sh 가 템플릿 파일에 이 줄이 그대로 있는지 본다) */
export const TEMPLATE_PLACEHOLDER_LINES = [
  '- [ ] 담당 레포 브랜치·미커밋 상태 확인',
  '- [ ] (작업) → 확인: (방법) → 성공 조건: (기대 결과)',
  '- [ ] 표준 검증 + 동작 확인 결과 기록 — 실행 못 한 것은 이유',
  '- [ ] 근거 확인 — 외부 계약·제품 정책·기본 동작을 근거 없이 넣지 않았나. 확인 못 한 것은 Blocked 에 적고 완료로 보고하지 않는다(`AGENTS.md` 5절)',
]
/** 고치지 않은 템플릿 자리 줄인가 @param {string} line */
export const isTemplatePlaceholder = (line) => TEMPLATE_PLACEHOLDER_LINES.includes(line.trim())

/** 자동 완료를 막는 단계 칸인가 — 빈 칸이고 문구가 `N단계` 로 시작하거나 `(단계)` 표시가 있다(들여쓰기 무관 · 굵게 · 코드 꾸밈은 걷어 낸다) @param {string} line */
export const isStageStep = (line) => {
  const words = line.match(/^[ \t]*- \[ \]\s*(.*)$/)?.[1]
  if (words === undefined) return false
  const text = plain(words)
  return /^\d+\s*단계/.test(text) || text.includes('(단계)')
}

/** Progress 절 글 → 맨 앞 칸 수(checked/total — 진행 표시) + 빈 칸 수(open — 하위 칸 포함) + 그중 단계 칸 수(steps — 자동 완료를 막는다).
 * 고치지 않은 템플릿 자리 줄은 어느 쪽에도 세지 않는다. 칸이 하나도 없으면 null. 들여 쓴 빈 칸만 있어도 { checked: 0, total: 0, open, steps } 을 돌려준다(화면은 total 0 이면 숫자를 안 보인다)
 * @param {string} progress
 * @returns {{ checked: number, total: number, open: number, steps: number } | null} */
export const progressOf = (progress) => {
  const lines = progress.split('\n').filter((line) => !isTemplatePlaceholder(line))
  const count = (/** @type {RegExp} */ pattern) => lines.filter((line) => pattern.test(line)).length
  const checked = count(/^- \[x\]/i)
  const total = count(/^- \[[ x]\]/i)
  const open = count(/^[ \t]*- \[ \]/)
  return total || open ? { checked, total, open, steps: lines.filter(isStageStep).length } : null
}

/** 남은 단계 칸이 있나 — 자동 완료 · 되돌리기 기준(일반 빈 칸은 보지 않는다)
 * @param {{ steps?: number } | null | undefined} progress */
export const hasOpenSteps = (progress) => Boolean(progress?.steps)

/** @typedef {{ pane: string, agent: string, plan: string }} PaneSession */

/** pane 기록 폴더 → 계획서가 적힌 기록만. 폴더가 없거나 깨진 파일은 건너뛴다
 * @param {string} dir
 * @returns {PaneSession[]} */
export const readPaneSessions = (dir) => {
  if (!dir || !existsSync(dir)) return []
  /** @type {PaneSession[]} */
  const records = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (typeof record?.pane === 'string' && typeof record?.plan === 'string' && record.plan) {
        records.push({ pane: record.pane, agent: String(record.agent ?? ''), plan: record.plan })
      }
    } catch { /* 쓰는 중이거나 깨진 기록 — 다음 갱신에 다시 */ }
  }
  return records
}

const escapeRegExp = (/** @type {string} */ value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Work ref 에 이 브랜치가 "🌿 <브랜치>" 로 정확히 있나(feature/A 가 feature/A-2 에 붙지 않게) — 보호 브랜치는 묶지 않는다
 * @param {string} workRef
 * @param {string} branch
 * @param {RegExp} protectedBranch */
export const branchMatches = (workRef, branch, protectedBranch) =>
  Boolean(branch) && !protectedBranch.test(branch) && new RegExp(`🌿 ${escapeRegExp(branch)}(?=[\\s@·(]|$)`).test(workRef)

/** 이 계획서에 묶인 에이전트 pane id — 계획서 줄(Work ref · Review)과 pane 기록을 합친다
 * @param {{ id: string, workRefs: string, review: string }} plan
 * @param {{ id: string, role: string, agent?: string | null, branch: string }[]} panes 지금 살아 있는 pane(server.mjs readPanes · boardPaneOf)
 * @param {PaneSession[]} sessions
 * @param {RegExp} protectedBranch
 * @returns {string[]} */
export const boundPaneIds = (plan, panes, sessions, protectedBranch) => {
  const refs = plan.workRefs.split('\n')
  const recorded = new Map(sessions.filter((record) => record.plan === plan.id).map((record) => [record.pane, record.agent]))
  return panes
    .filter((pane) => pane.role === 'agent')
    .filter((pane) =>
      refs.some((ref) => ref.includes(`pane ${pane.id} `) || ref.endsWith(`pane ${pane.id}`) || branchMatches(ref, pane.branch, protectedBranch)) ||
      plan.review.includes(`pane ${pane.id} `) ||
      (recorded.has(pane.id) && recorded.get(pane.id) === pane.agent))
    .map((pane) => pane.id)
}

/** 현황판 없이 계획서에 묶인 pane 을 알 재료 — /api/state 의 cards(계획서 · agents · leadPane 만) · panes 와 같은 규칙.
 * 이슈에 합친 계획서도 따로 한 장으로 둔다(묶인 pane 은 같다). 스튜디오 앱이 현황판이 꺼져 있을 때 쓴다(src/main/pane-watch.mts)
 * @param {{ root: string, panes: Parameters<typeof boardPaneOf>[0][], sessionsDir: string, home: string, now?: number }} input
 *   panes — 에이전트가 도는 화면 pane(server.mjs readPanes 의 --agent-only 와 같이) · sessionsDir — <팩 데이터>/state/pane-sessions(여러 팩 구조가 아니면 '')
 * @returns {{ cards: { kind: 'plan', id: string, agents: string[], leadPane: string }[], panes: ReturnType<typeof boardPaneOf>[] }} */
export const bindingSources = ({ root, panes, sessionsDir, home, now = Date.now() }) => {
  const boardPanes = panes.filter((pane) => pane.agent).map((pane) => boardPaneOf(pane, root, home))
  const sessions = sessionsDir ? readPaneSessions(sessionsDir) : []
  /** @type {{ kind: 'plan', id: string, agents: string[], leadPane: string }[]} */
  const cards = []
  for (const path of planFiles(join(root, 'plans'))) {
    const text = readText(path)
    if (!text) continue
    // 보관된 계획서는 묶지 않는다(src/lib/pane-detail.mts bindings 가 archived 카드를 건너뛰는 것과 같이)
    if (path.includes('/archive/')) continue
    const checkpoint = checkpointOf(text)
    // 현황판과 같이 — 끝난 지 오래된 계획서는 뺀다
    if (statusOf(checkpoint, false) === 'done' && now - statSync(path).mtimeMs >= DONE_KEEP_DAYS * 86_400_000) continue
    const id = relative(root, path)
    const refs = planRefs(path, checkpoint)
    cards.push({ kind: 'plan', id, agents: boundPaneIds({ id, workRefs: refs.workRefs, review: refs.review }, boardPanes, sessions, PROTECTED_BRANCH), leadPane: refs.leadPane })
  }
  return { cards, panes: boardPanes }
}

// 자동 완료가 이미 이 PR 묶음(merged-<번호들>)으로 한 번 끝낸 계획서인지 — Checkpoint 의 "- Auto done:" 줄(자동 완료가 쓴다) 또는 "- Learn review:" 줄에 같은 표시가 있으면.
// 그런 계획서를 사람이 추가 요청으로 in_progress 로 되돌렸는데 새 PR 이 PR 줄에 들어오기 전이면, 같은 머지를 다시 보고 done 으로 덮어쓰지 않는다(2026-10-30)
/** @param {string} text @param {string} mark */
export const autoDoneDone = (text, mark) => [...String(text).matchAll(/^- (?:Auto done|Learn review):.*$/gm)].some((match) => /** @type {string[]} */ (match[0].match(/merged-(?:direct-[0-9a-f]{7}(?:-[0-9a-f]{7})*|\d+(?:-\d+)*)/g) ?? []).includes(mark))

// ── 자동 완료 되돌리기 ──
// 자동 완료(PR 머지)한 계획서의 Progress 에 단계 칸이 새로 생기면(머지 뒤 새 단계) 현황판이 진행 중으로 되돌린다(2026-11-01). 일반 빈 칸은 되돌리지 않는다 — 남기고 완료한 칸에 왕복하지 않게.
// 대상은 Checkpoint 에 "- Auto done:" 줄이 있는 done 만 — 사람이 직접 완료로 옮긴 계획서(줄 없음)와 보관된 계획서는 건드리지 않는다.
// 되돌릴 때 Auto done 줄을 "- Auto reopened: <표시>" 로 바꾼다: ① 이후 사람이 직접 done 으로 옮겨도 다시 되돌리지 않고
// ② 칸을 다 채우면 같은 PR 묶음 표시여도 다시 자동 완료한다(autoDoneDone 은 사람이 되돌린 in_progress 를 지키려는 것이라 이 표시가 있을 때만 건너뛴다)
/** 자동 완료 줄의 PR 묶음 표시(merged-…) — 없으면 '' @param {string} text */
export const autoDoneMark = (text) => String(text).match(/^- Auto done:.*$/m)?.[0].match(/merged-(?:direct-[0-9a-f]{7}(?:-[0-9a-f]{7})*|\d+(?:-\d+)*)/)?.[0] ?? ''

/** 현황판이 이 계획서를 진행 중으로 되돌려야 하나
 * @param {string} text 계획서 전문 @param {string} status @param {boolean} archived
 * @param {{ steps?: number } | null | undefined} progress */
export const needsAutoReopen = (text, status, archived, progress) => !archived && status === 'done' && /^- Auto done:/m.test(text) && hasOpenSteps(progress)

/** 되돌린 뒤 같은 PR 묶음을 다시 자동 완료해도 되나 — 현황판이 되돌릴 때 남긴 "- Auto reopened:" 줄에 같은 표시가 있을 때
 * @param {string} text @param {string} mark */
export const autoReopenedFor = (text, mark) => Boolean(mark) && autoDoneMark(String(text).match(/^- Auto reopened:.*$/m)?.[0].replace('Auto reopened', 'Auto done') ?? '') === mark

/** 되돌리기 줄 바꾸기: Auto done → Auto reopened @param {string} text */
export const reopenLines = (text) => String(text).replace(/^- Auto done:(.*)$/m, '- Auto reopened:$1')

/** 다시 자동 완료할 때: Auto reopened 줄을 지운다(남기면 사람이 이어서 되돌린 in_progress 를 계속 덮는다) @param {string} text */
export const clearReopened = (text) => String(text).replace(/^- Auto reopened:.*\n/m, '')

// ── 묶인 pane 이 닫힌 계획서 → 이어 갈 이슈 ──
// done 이 아닌 계획서의 묶인 pane 이 모두 닫히고 1시간이 지나면 현황판이 그 계획서를 가리키는 open 이슈를 하나 만든다(2026-11-01).
// 한 번도 묶인 pane 을 본 적 없는 계획서는 대상이 아니다(닫힌 시각을 모른다) — 이 기능을 켠 날 옛 계획서가 한꺼번에 이슈가 되지 않는다
export const PANE_CLOSED_ISSUE_MS = 3_600_000

/** 지난 기록 + 이번 계획서들 → 계획서별 { closedAt }(열려 있으면 null · 닫힌 것을 처음 본 시각). done · 보관 · 없어진 계획서는 기록에서 뺀다. 바뀌었을 때만 파일에 쓰도록 changed
 * @param {Record<string, { closedAt: number | null }>} watch
 * @param {{ id: string, status: string, archived?: boolean, agents: string[] }[]} plans
 * @param {number} now
 * @returns {{ watch: Record<string, { closedAt: number | null }>, changed: boolean }} */
export const nextPaneWatch = (watch, plans, now) => {
  /** @type {Record<string, { closedAt: number | null }>} */
  const next = {}
  for (const plan of plans) {
    if (plan.archived || plan.status === 'done') continue
    const entry = watch[plan.id]
    if (plan.agents.length) next[plan.id] = { closedAt: null }
    else if (entry) next[plan.id] = { closedAt: entry.closedAt ?? now }
  }
  return { watch: next, changed: JSON.stringify(next) !== JSON.stringify(watch) }
}

/** 지금 이슈를 만들 때인가 — 닫힌 지 1시간이 지났고 열린 요청 · 연결된 이슈가 없다
 * @param {{ closedAt: number | null } | undefined} entry @param {number} now
 * @param {{ hasRequest: boolean, hasIssue: boolean }} links */
export const followUpDue = (entry, now, { hasRequest, hasIssue }) => Boolean(entry?.closedAt) && now - Number(entry?.closedAt) >= PANE_CLOSED_ISSUE_MS && !hasRequest && !hasIssue

/** 이어 갈 이슈 파일 — 이름과 글. 제목은 계획서 제목(공백 뒤 # 은 frontmatter 주석으로 잘리니 걷어 낸다) · 레포는 계획서 기준
 * @param {{ id: string, title: string }} plan @param {string} repo @param {string} day YYYY-MM-DD */
export const followUpIssue = (plan, repo, day) => {
  const slug = (plan.id.split('/').at(-1) ?? plan.id).replace(/\.md$/, '').replace(/^\d{8}-/, '')
  const title = plan.title.replace(/\s+/g, ' ').replace(/\s+#+/g, ' ').trim()
  return {
    // 이름에 -learn- 이 들어가면 학습 후보로 읽혀(learn.mjs isLearnIssue) 현황판 이슈에서 빠진다
    name: `${day.replaceAll('-', '')}-${repo || 'plan'}-${slug}.md`.replace(/-learn-/g, '-learn_'),
    text: `---\ntitle: ${title}\nrepo: ${repo}\nstatus: open\nplan: ${plan.id}\nsource: 현황판 자동(묶인 pane 이 닫힌 지 1시간) ${day}\n---\n\n계획서 ${plan.id} 를 이어 간다. 새 계획서를 만들지 않고 그 계획서의 Checkpoint 부터 본다.\n`,
  }
}
