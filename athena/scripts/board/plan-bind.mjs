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
 * 남은 단계: Checkpoint Progress 의 빈 칸(`- [ ]`)이 하나라도 있으면 남은 일이 있다 — 맨 앞 칸이든 들여 쓴 하위 칸(깊이 무관)이든.
 *   하위 칸도 센다(2026-10-29 — 맨 앞 칸은 다 [x] 인데 남은 일이 하위 칸에만 있던 배포판 계획서가 PR 머지 뒤 완료 · 보관됐다).
 *   진행 표시 숫자(checked/total)는 맨 앞 칸 기준 그대로 — 화면이 바뀌지 않게 판정(open)만 넓힌다.
 *   2026-10-27 실제 계획서 64개(보관 58 · 진행 6)로 세어 봄 — PR 머지로 끝난 계획서는 거의 모두 맨 앞 칸을 다 채웠고(빈 칸 남은 2개도
 *   실제로 못 한 확인 단계), Next 는 끝난 계획서도 거의 모두 "머지 뒤 확인" 같은 글이 있어 기준이 못 된다
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
export const checkpointOf = (text) => text.match(/^## Checkpoint\s*\n([\s\S]*?)(?=^## (?!#))/m)?.[1] ?? ''
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

/** Progress 절 글 → 맨 앞 칸 수(checked/total — 진행 표시) + 빈 칸 수(open — 하위 칸 포함, 남은 단계 판정).
 * 칸이 하나도 없으면 null. 들여 쓴 빈 칸만 있어도 { checked: 0, total: 0, open } 을 돌려준다(남은 단계 · 화면은 total 0 이면 숫자를 안 보인다)
 * @param {string} progress
 * @returns {{ checked: number, total: number, open: number } | null} */
export const progressOf = (progress) => {
  const checked = (progress.match(/^- \[x\]/gim) ?? []).length
  const total = (progress.match(/^- \[[ x]\]/gim) ?? []).length
  const open = (progress.match(/^[ \t]*- \[ \]/gm) ?? []).length
  return total || open ? { checked, total, open } : null
}

/** 남은 단계(빈 칸 — 맨 앞 칸 · 하위 칸)가 있나
 * @param {{ checked: number, total: number, open?: number } | null | undefined} progress */
export const hasOpenSteps = (progress) => Boolean(progress && (progress.checked < progress.total || (progress.open ?? 0) > 0))

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
