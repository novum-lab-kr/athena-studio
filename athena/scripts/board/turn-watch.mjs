// @ts-check
// 에이전트 끝 · 멈춤 · 질문을 아테나가 놓치지 않게 — 현황판이 몇 초마다 부른다(server.mjs reconcileTurns). 아테나가 손으로 감시하지 않는다(계획서 결정 D4).
//
// 읽는 것: 차례 상태 <팩 데이터>/state/agent-turn/<pane>.json · 아테나 알림 받음 기록 state/lead-notices/<id>.json(둘 다 scripts/lib/agent_turn.py)
//   · 계획서 카드(Status · Lead pane · 묶인 에이전트 pane) · 화면 pane 목록 · 선택 창(menuOf — prompt-menu.json · 데몬 waiting 합집합)
// 하는 것(계획서 결정 D1 — 즉시 알림 → 2분 뒤 한 번 더 → 10분이면 [작업] 요청):
//   1. 묶인 에이전트 pane 에 선택 창이 떠 있고 그 차례가 아직 끝나지 않았으면(끝 알림이 따로 가지 않는다) 아테나에 "선택 창" 한 줄 — 창 하나에 한 번
//   2. 아테나가 받지 않은 알림(received_at 없음)은 RESEND_MS 뒤 한 번 다시 넣는다 — 계획서 Lead pane 이 살아 있을 때만(다른 pane 으로 바꾸지 않는다 · lead-send.py 와 같은 규칙)
//   3. REQUEST_MS 가 지나도 안 받았으면 [작업] 요청을 연다 — 그 에이전트 pane 에 이미 열린 요청(고르기 질문 · 권한 창)이 있으면 이번엔 열지 않고 다음 주기에 다시 본다
//   4. 받았으면 연 요청을 거두고, 오래된 기록은 지운다
// 계획서가 done · cancelled 면 다시 넣지도 요청을 열지도 않는다(아테나가 이미 정리했다). 선택 창이 닫혔으면 그 "선택 창" 알림은 더 밀지 않는다.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const RESEND_MS = 2 * 60_000
export const REQUEST_MS = 10 * 60_000
export const KEEP_MS = 24 * 3600_000
const RECEIVED_KEEP_MS = 3600_000
const CLOSED_PLAN = new Set(['done', 'cancelled'])
const RESTING = new Set(['done', 'asking'])
const NOTICE_ID = /^[0-9a-f]{32}$/

/** @param {string} file @returns {Record<string, any> | null} */
const readJson = (file) => {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}
/** @param {string} file @param {Record<string, unknown>} data */
const writeJson = (file, data) => {
  const staging = `${file}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(data)}\n`)
  renameSync(staging, file)
}
const AGENT_TURN = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'agent_turn.py')
// 고칠 칸만 — 아테나 입력 훅(agent_turn.mark_received)과 같은 파일별 잠금(<lead-notices>/.<id>.lock · flock) 안에서 읽기 · 합치기 · 쓰기.
// node 에는 flock 이 없어 agent_turn.py --patch 로 고친다. 받음 표시(received_at)는 지우지 않는다. 실패하면 이번 주기만 건너뛴다
// (다시 넣기 · 요청은 같은 key 로 한 번만 가서 다음 주기에 또 해도 겹치지 않는다)
/** @param {string} file @param {Record<string, unknown>} fields @returns {boolean} */
const patchNotice = (file, fields) => {
  const id = file.replace(/^.*\/|\.json$/g, '')
  try {
    execFileSync('python3', [AGENT_TURN, '--patch', dirname(file), id, JSON.stringify(fields)], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * @typedef {{ id: string, status?: string, leadPane?: string, agents?: string[] }} PlanCard
 * @typedef {{ id: string, status?: string }} PaneCard
 * @typedef {{
 *   stateDir: string,
 *   plans: PlanCard[],
 *   panes: PaneCard[],
 *   now: number,
 *   menuOf: (paneId: string) => Promise<boolean>,
 *   notify: (notice: { key: string, mark: string, text: string, plan: string, lead: string }) => Promise<string>,
 *   openRequestFor: (notice: Record<string, any>) => string | null,
 *   cancelRequest: (requestId: string) => void,
 *   hasOpenRequest: (paneId: string) => boolean,
 *   log?: (message: string) => void,
 * }} WatchDeps
 * notify — 'sent' · 'wait'(미뤘다) · 'already' · 'failed' / openRequestFor — 연 요청 id(못 열면 null)
 */

/** @param {WatchDeps} deps */
export const reconcileTurns = async ({ stateDir, plans, panes, now, menuOf, notify, openRequestFor, cancelRequest, hasOpenRequest, log = () => {} }) => {
  const noticeDir = join(stateDir, 'lead-notices')
  const turnDir = join(stateDir, 'agent-turn')
  const alive = new Set(panes.map((pane) => pane.id))
  const planOf = new Map(plans.map((plan) => [plan.id, plan]))
  /** @type {Array<{ file: string, notice: Record<string, any> }>} */
  const notices = existsSync(noticeDir)
    ? readdirSync(noticeDir)
        .filter((name) => NOTICE_ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
        .flatMap((name) => {
          const notice = readJson(join(noticeDir, name))
          return notice ? [{ file: join(noticeDir, name), notice }] : []
        })
    : []

  // 1. 선택 창 — 묶인 에이전트 pane 마다(아테나 pane 자신은 빼고)
  for (const plan of plans) {
    if (CLOSED_PLAN.has(plan.status ?? '') || !plan.leadPane) continue
    for (const paneId of plan.agents ?? []) {
      if (paneId === plan.leadPane || !alive.has(paneId)) continue
      const turn = readJson(join(turnDir, `${paneId}.json`)) ?? {}
      const open = notices.filter(({ notice }) => notice.kind === 'menu' && notice.pane === paneId && !notice.closed_at)
      // 끝난 차례(done · asking)는 끝 알림이 갔다 — 선택 창 알림은 일하는 중에 뜬 창만
      const menu = !RESTING.has(turn.state) && (await menuOf(paneId))
      if (!menu) {
        for (const entry of open) patchNotice(entry.file, { closed_at: now / 1000 })
        continue
      }
      if (open.length) continue
      const agent = String(turn.agent || paneId)
      const text = `[${agent} → 아테나] 선택 창 · ${paneId} · 계획서 ${plan.id} · Status ${plan.status || '?'}`
      const id = randomUUID().replace(/-/g, '')
      const notice = { id, kind: 'menu', lead: plan.leadPane, text, plan: plan.id, pane: paneId, from: agent, turn: String(turn.turn || ''), sent_at: now / 1000 }
      mkdirSync(noticeDir, { recursive: true })
      const file = join(noticeDir, `${id}.json`)
      writeJson(file, notice)
      const result = alive.has(plan.leadPane) ? await notify({ key: `lead-notice:${id}`, mark: id, text, plan: plan.id, lead: plan.leadPane }) : 'failed'
      log(`🔔 ${paneId} 선택 창 — 아테나 pane ${plan.leadPane} 에 알림: ${result}`)
    }
  }

  // 2 · 3 · 4. 안 받은 알림 다시 넣기 · 요청 · 정리
  for (const { file } of notices) {
    const notice = readJson(file)   // 1 에서 닫았을 수 있다 — 다시 읽는다
    if (!notice) continue
    const sentAt = Number(notice.sent_at || 0) * 1000
    const age = now - sentAt
    if (notice.received_at) {
      if (notice.request && notice.request !== 'cancelled') {
        try { cancelRequest(notice.request) } catch { /* 이미 닫혔다 */ }
        patchNotice(file, { request: 'cancelled' })
      }
      if (now - Number(notice.received_at) * 1000 > RECEIVED_KEEP_MS) rmSync(file, { force: true })
      continue
    }
    if (age > KEEP_MS) { rmSync(file, { force: true }); continue }
    const plan = planOf.get(notice.plan)
    if (notice.closed_at || (plan && CLOSED_PLAN.has(plan.status ?? ''))) continue
    if (age >= REQUEST_MS && !notice.request) {
      // 그 에이전트 pane 에 이미 열린 요청이 있으면 표시를 남기지 않는다 — 그 요청이 닫힌 뒤 다음 주기에 다시 본다
      if (notice.pane && hasOpenRequest(notice.pane)) continue
      const request = openRequestFor(notice)
      if (request) {
        patchNotice(file, { request })
        log(`📮 아테나 pane ${notice.lead} 가 10분 동안 받지 않은 알림 — 요청 ${request}: ${notice.text}`)
      }
      continue
    }
    if (age >= RESEND_MS && !notice.resent_at) {
      const result = alive.has(notice.lead) ? await notify({ key: `lead-notice:${notice.id}:again`, mark: notice.id, text: notice.text, plan: notice.plan, lead: notice.lead }) : 'failed'
      patchNotice(file, { resent_at: now / 1000 })
      log(`🔁 아테나 pane ${notice.lead} 가 받지 않은 알림을 다시 넣었다(${result}): ${notice.text}`)
    }
  }

  // 닫힌 pane 의 오래된 차례 상태
  if (existsSync(turnDir)) {
    for (const name of readdirSync(turnDir)) {
      if (!name.endsWith('.json') || alive.has(name.replace(/\.json$/, ''))) continue
      const turn = readJson(join(turnDir, name))
      if (!turn || now - Number(turn.ts || 0) * 1000 > KEEP_MS) rmSync(join(turnDir, name), { force: true })
    }
  }
}
