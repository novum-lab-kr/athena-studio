// @ts-check
// 아테나 pane 에 알림 한 줄 넣기의 한 곳 — PR 자동 리뷰(scripts/pr-auto.mjs notify)와 현황판(안 받은 에이전트 알림 다시 넣기 · 선택 창 알림 — server.mjs reconcileTurns)이 같이 쓴다.
//   - 같은 알림 거르기: key → mark 기록(<dir>/.notified). 같은 key 에 같은 mark 를 이미 넣었거나 미뤘으면 다시 넣지 않는다
//   - 질문 · 고르기 창이 떠 있으면(menuOpen — scripts/lib/prompt-menu.json · 데몬 agent_status 'waiting' 합집합) 넣지 않고 대기열(<dir>/notices/ 파일 하나씩 —
//     처리기가 꺼져도 남는다)에 두고 flush 가 차례대로 넣는다. 앞에 미룬 알림이 있으면 새 알림도 뒤에 줄 선다
//   - 받을 pane 이 없거나 넣지 못하면 'failed' — 무엇을 할지(요청 열기 등)는 부르는 쪽이 정한다
// 로그는 남기지 않는다 — 부르는 쪽이 결과로 적는다(pr-auto 의 지금 로그 글 그대로).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { screen, screenText, submitToPane } from './screen.mjs'
import { menuOpen } from '../board/pane-delivery.mjs'

/**
 * @typedef {{ key: string, mark: string, text: string, pane?: string, typed?: boolean, [field: string]: unknown }} Notice
 * @typedef {'sent' | 'wait' | 'failed'} DeliverResult
 */

/**
 * 알림 하나 넣기 — 'sent' · 'wait'(창이 떠 있다 · 데몬이 쓰기 전에 거절) · 'failed'(보내지 못했다).
 * 화면을 못 읽으면(null) 창 여부를 모르니 바로 넣는다. 넣기는 공통 전송 경로 한 번(글 + Enter 전송 확인 — lib/screen.mjs submitToPane).
 * 옛 판이 글만 넣고 미룬 알림(typed)은 빈 글로 — 입력칸에 남은 글의 전송만 확인한다(글을 두 번 넣지 않게)
 * @param {string} pane
 * @param {Notice} notice
 * @returns {Promise<DeliverResult>}
 */
export const deliverNotice = async (pane, notice) => {
  const info = await screen(['pane', 'get', pane])
  if (menuOpen(await screenText(['pane', 'read', pane, '--lines', '40']), info?.pane?.agent_status)) return 'wait'
  const result = await submitToPane(pane, notice.typed ? '' : notice.text)
  return result === 'sent' || result === 'wait' ? result : 'failed'
}

/**
 * @param {{
 *   dir: string,
 *   pickPane: (notice: Notice) => Promise<string>,
 *   deliver?: (pane: string, notice: Notice) => Promise<DeliverResult>,
 * }} options dir — 기록 · 대기열 자리 / pickPane — 받을 아테나 pane('' 이면 없음 · 미룬 알림을 넣을 때 다시 고른다)
 */
export const createLeadNotifier = ({ dir, pickPane, deliver = deliverNotice }) => {
  // 이름이 .json 으로 끝나면 안 된다 — pr-auto 처리기가 dir 의 *.json 을 리뷰 작업으로 본다(PR #103 자동 리뷰 라운드 2)
  const notifiedFile = join(dir, '.notified')
  const noticeDir = join(dir, 'notices')
  /** @returns {Record<string, string>} */
  const readNotified = () => {
    try { return JSON.parse(readFileSync(notifiedFile, 'utf8')) } catch { return {} }
  }
  // 임시 파일에 쓰고 바꿔 끼운다(쓰다 끊겨도 깨진 파일이 남지 않게)
  /** @param {Record<string, string>} recorded */
  const writeNotified = (recorded) => {
    mkdirSync(dir, { recursive: true })
    const staging = `${notifiedFile}.${process.pid}`
    writeFileSync(staging, JSON.stringify(recorded, null, 2))
    renameSync(staging, notifiedFile)
  }
  /** @param {string} key @param {string} mark */
  const markNotified = (key, mark) => writeNotified({ ...readNotified(), [key]: mark })
  /** @param {string} key */
  const clearNotified = (key) => {
    const recorded = readNotified()
    if (!(key in recorded)) return
    delete recorded[key]
    writeNotified(recorded)
  }
  let sequence = 0
  const pendingNotices = () => (existsSync(noticeDir) ? readdirSync(noticeDir).filter((name) => name.endsWith('.json')).sort().map((name) => join(noticeDir, name)) : [])
  /** @param {string} file @returns {Notice | null} */
  const readNotice = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  }
  /** @param {Notice} notice */
  const queueNotice = (notice) => {
    mkdirSync(noticeDir, { recursive: true })
    // 같은 ms 에 둘을 미뤄도 넣은 차례대로 — 이름은 시각 · 이 처리기 안의 차례 번호 · key 해시(사전순 = 차례)
    sequence += 1
    const file = join(noticeDir, `${Date.now()}-${String(sequence).padStart(6, '0')}-${createHash('sha1').update(`${notice.key}\n${notice.mark}`).digest('hex').slice(0, 8)}.json`)
    writeFileSync(file, JSON.stringify(notice))
    return file
  }

  /**
   * 넣거나 미룬다 — 'already'(같은 key · mark 를 이미) · 'sent' · 'wait'(미뤘다) · 'failed'(받을 pane 이 없거나 못 넣었다 — 기록하지 않는다)
   * @param {Notice} notice
   * @returns {Promise<{ result: 'already' | DeliverResult, pane: string }>}
   */
  const notify = async (notice) => {
    if (readNotified()[notice.key] === notice.mark) return { result: 'already', pane: '' }
    const pane = await pickPane(notice)
    Object.assign(notice, { pane })
    // 먼저 미룬 알림이 있으면 차례를 지켜 뒤에 줄 선다
    const result = !pane ? 'failed' : pendingNotices().length ? 'wait' : await deliver(pane, notice)
    if (result === 'wait') queueNotice(notice)
    if (result !== 'failed') markNotified(notice.key, notice.mark)
    return { result, pane }
  }

  /**
   * 미룬 알림을 차례대로 넣어 본다 — 받을 pane 은 그때 다시 고른다. 창이 떠 있으면 거기서 멈춘다(뒤 알림을 앞질러 넣지 않는다)
   * @param {(notice: Notice, result: 'sent' | 'failed', pane: string) => void} done 넣었거나 못 넣어 대기열에서 뺀 알림마다
   */
  const flush = async (done) => {
    for (const file of pendingNotices()) {
      const notice = readNotice(file)
      if (!notice) { rmSync(file, { force: true }); continue }
      const pane = await pickPane(notice)
      if (pane !== notice.pane) Object.assign(notice, { pane, typed: false })
      const result = pane ? await deliver(pane, notice) : 'failed'
      if (result === 'wait') return
      rmSync(file, { force: true })
      done(notice, result, pane)
    }
  }

  return { notify, flush, readNotified, markNotified, clearNotified, pendingNotices }
}
