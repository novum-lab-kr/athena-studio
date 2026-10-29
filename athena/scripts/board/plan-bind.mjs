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
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Progress 절 글 → 맨 앞 칸 수(checked/total — 진행 표시) + 빈 칸 수(open — 하위 칸 포함, 남은 단계 판정). 맨 앞 칸이 없으면 null
 * @param {string} progress
 * @returns {{ checked: number, total: number, open: number } | null} */
export const progressOf = (progress) => {
  const checked = (progress.match(/^- \[x\]/gim) ?? []).length
  const total = (progress.match(/^- \[[ x]\]/gim) ?? []).length
  const open = (progress.match(/^[ \t]*- \[ \]/gm) ?? []).length
  return total ? { checked, total, open } : null
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
 * @param {{ id: string, role: string, agent: string, branch: string }[]} panes 지금 살아 있는 pane(server.mjs readPanes)
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
