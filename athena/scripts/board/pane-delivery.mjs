// @ts-check
// 현황판이 pane 에 지시를 넣는 순서 — 결정 콘솔 · 레포 고르기 콘솔 [이대로 진행] · 이슈 [작업 시작] 등(/api/action).
//
// GitHub #100(2026-10-28 진짜 claude 2.1.312 로 재현): 받는 pane 에 질문 · 고르기 창(AskUserQuestion · 권한 묻기)이 떠 있을 때
// 글 + Enter 를 넣으면 글은 창에 먹혀 사라지고 Enter 가 창의 1번 선택지를 고른다 — 고른 결과는 전달되지 않고 묻지 않은 답이 들어간다.
// 일하는 중(도구 실행 중)에는 claude 가 입력을 받아 두었다가 전달하니 지금처럼 바로 넣는다.
// 그래서 넣기 전에 화면 끝을 읽어 창이 떠 있으면 대기열에 두고, 창이 닫히면 들어온 차례대로 넣는다.
//
// 차례 지키기: 지시는 submit 이 부르자마자(기다리기 전에) pane 대기열에 동기로 올린다. 화면 확인 · 넣기는 pane 마다 잠금 하나 아래에서
// submit 과 tick 이 차례로 한다 — 같은 pane 에 두 지시가 겹쳐 와도 덮이지 않고 순서가 바뀌지 않는다.
// 넣기는 공통 전송 경로 한 번(글 + Enter · 데몬이 전송을 확인하고 같은 입력이 남았을 때만 Enter 를 다시 누른다 — lib/screen.mjs submitToPane).
// 데몬이 쓰기 전에 거절하면(질문 창 · 다른 전송 중) 대기열에 두고 다음 차례에 다시, 그 밖의 실패는 글이 들어갔는지 모르니 다시 보내지 않는다.

import { readFileSync } from 'node:fs'

// 질문 · 고르기 창 표시 — scripts/lib/prompt-menu.json 한 곳(scripts/lib/pane_request.py 와 같이 읽는다)
const MENU = JSON.parse(readFileSync(new URL('../lib/prompt-menu.json', import.meta.url), 'utf8'))
const PROMPT_MENU = new RegExp(MENU.pattern, 'i')
const MENU_TAIL_LINES = Number(MENU.tailLines)

/**
 * 화면 끝 12줄(빈 줄 빼고)에 질문 · 고르기 창이 떠 있나 — 데몬이 입력 대기(agent_status 'waiting')로 본 것도 창으로 친다(합집합)
 * @param {unknown} text pane 화면 글
 * @param {unknown} [status] 데몬 agent_status
 */
export const menuOpen = (text, status = '') =>
  status === 'waiting' ||
  String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim())
    .slice(-MENU_TAIL_LINES)
    .some((line) => PROMPT_MENU.test(line))

/**
 * @typedef {{
 *   readPane: (paneId: string) => Promise<string | null>,
 *   send: (paneId: string, text: string) => Promise<string>,
 *   paneExists: (paneId: string) => boolean,
 *   paneStatus?: (paneId: string) => Promise<string>,
 *   log?: (message: string) => void,
 * }} DeliveryDeps
 * readPane — 화면 글(못 읽으면 null — 그때는 창 여부를 모르니 지금처럼 바로 넣는다)
 * paneStatus — 데몬 agent_status('waiting' 이면 창이 떠 있다 — 화면 글과 합집합 · 못 읽으면 '')
 * send — 글 + Enter · 'sent' · 'wait'(안 들어감 — 다시 보내도 된다) · 그 밖은 실패 글(들어갔는지 모른다)
 */

/** @typedef {{ text: string, done: boolean, error: string | null }} Entry */

/** @param {DeliveryDeps} deps */
export const createDelivery = ({ readPane, send, paneExists, paneStatus = async () => '', log = () => {} }) => {
  /** @type {Map<string, Entry[]>} pane → 아직 다 못 넣은 지시(들어온 차례) */
  const waiting = new Map()
  /** @type {Map<string, Promise<void>>} pane → 마지막에 건 일(잠금) */
  const locks = new Map()

  /**
   * pane 마다 한 번에 하나씩
   * @param {string} paneId
   * @param {() => Promise<void>} work
   */
  const withLock = (paneId, work) => {
    const run = (locks.get(paneId) ?? Promise.resolve()).then(work)
    const tail = run.catch(() => {})
    locks.set(paneId, tail)
    tail.then(() => {
      if (locks.get(paneId) === tail) locks.delete(paneId)
    })
    return run
  }

  /**
   * 대기열 앞에서부터 넣는다 — 창이 떠 있거나 실패하면 멈춘다. 잠금 안에서만 부른다
   * @param {string} paneId
   * @param {Entry | null} owner 지금 submit 한 지시 — 보내기가 실패하면 대기열에서 빼고 오류로 돌려준다(콘솔이 복사로 바뀐다)
   */
  const flush = async (paneId, owner) => {
    const queue = waiting.get(paneId)
    while (queue?.length) {
      if (menuOpen(await readPane(paneId), await paneStatus(paneId))) break
      const entry = /** @type {Entry} */ (queue[0])
      const result = await send(paneId, entry.text)
      // 데몬이 쓰기 전에 거절했다(창이 막 떴다 · 다른 전송 중) — 글은 안 들어갔으니 다음 차례에 다시
      if (result === 'wait') break
      if (result !== 'sent') {
        // 글이 입력칸에 들어갔는지 모른다 — 다시 보내면 두 번 들어갈 수 있어 대기열에서 뺀다
        queue.shift()
        if (entry === owner) entry.error = result
        else log(`⚠️ ${paneId} 에 미룬 지시를 넣었는지 확인하지 못했다 — ${result} · 다시 보내지 않는다(입력칸을 확인)`)
        break
      }
      queue.shift()
      entry.done = true
      if (entry !== owner) log(`✅ ${paneId} 에 미룬 지시를 넣었다`)
    }
    if (queue && !queue.length) waiting.delete(paneId)
  }

  /**
   * 넣거나 미룬다 — 'sent' · 'queued' · 오류 글
   * @param {string} paneId
   * @param {string} text
   */
  const submit = async (paneId, text) => {
    /** @type {Entry} */
    const entry = { text, done: false, error: null }
    // 기다리기 전에 동기로 줄 선다 — 겹쳐 온 지시가 서로 덮지 않게
    const queue = waiting.get(paneId) ?? []
    queue.push(entry)
    waiting.set(paneId, queue)
    await withLock(paneId, () => flush(paneId, entry))
    if (entry.done) return 'sent'
    if (entry.error) return entry.error
    log(`⏳ ${paneId} 에 질문 · 고르기 창이 떠 있거나 다른 전송 중이라 다음 차례에 넣는다`)
    return 'queued'
  }

  // 미룬 지시를 넣어 본다 — 현황판이 몇 초마다 부른다. pane 이 닫혔으면 버린다
  const tick = async () => {
    await Promise.all(
      [...waiting.keys()].map((paneId) =>
        withLock(paneId, async () => {
          const queue = waiting.get(paneId)
          if (!queue) return
          if (!paneExists(paneId)) {
            waiting.delete(paneId)
            log(`⚠️ ${paneId} 가 닫혀 미룬 지시 ${queue.length}개를 버렸다`)
            return
          }
          await flush(paneId, null)
        }),
      ),
    )
  }

  return { submit, tick, pending: (/** @type {string} */ paneId) => waiting.get(paneId)?.length ?? 0 }
}
