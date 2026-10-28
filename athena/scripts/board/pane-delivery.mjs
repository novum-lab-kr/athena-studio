// @ts-check
// 일감이 pane 에 지시를 넣는 순서 — 결정 콘솔 · 레포 고르기 콘솔 [이대로 진행] · 이슈 [작업 시작] 등(/api/action).
//
// GitHub #100(2026-10-28 진짜 claude 2.1.312 로 재현): 받는 pane 에 질문 · 고르기 창(AskUserQuestion · 권한 묻기)이 떠 있을 때
// 글 + Enter 를 넣으면 글은 창에 먹혀 사라지고 Enter 가 창의 1번 선택지를 고른다 — 고른 결과는 전달되지 않고 묻지 않은 답이 들어간다.
// 일하는 중(도구 실행 중)에는 claude 가 입력을 받아 두었다가 전달하니 지금처럼 바로 넣는다.
// 그래서 넣기 전에 화면 끝을 읽어 창이 떠 있으면 대기열에 두고, 창이 닫히면 들어온 차례대로 넣는다.

// 질문 · 고르기 창 표시 — 앱 src/lib/core.mts claudeAtEmptyPrompt 의 PROMPT_MENU 와 같은 글
const PROMPT_MENU = /Enter to (select|confirm)|Esc to cancel|↑\/↓ to navigate|Do you want to|Type something\./

/**
 * 화면 끝 12줄(빈 줄 빼고)에 질문 · 고르기 창이 떠 있나
 * @param {unknown} text pane 화면 글
 */
export const menuOpen = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim())
    .slice(-12)
    .some((line) => PROMPT_MENU.test(line))

/**
 * @typedef {{
 *   readPane: (paneId: string) => Promise<string | null>,
 *   sendNow: (paneId: string, text: string) => Promise<string | null>,
 *   paneExists: (paneId: string) => boolean,
 *   log?: (message: string) => void,
 * }} DeliveryDeps
 * readPane — 화면 글(못 읽으면 null — 그때는 창 여부를 모르니 지금처럼 바로 넣는다)
 * sendNow — 글 + Enter 를 넣는다 · 실패면 오류 글
 */

/** @param {DeliveryDeps} deps */
export const createDelivery = ({ readPane, sendNow, paneExists, log = () => {} }) => {
  /** @type {Map<string, string[]>} pane → 아직 못 넣은 글(들어온 차례) */
  const waiting = new Map()

  const blocked = async (/** @type {string} */ paneId) => menuOpen(await readPane(paneId))

  /**
   * 넣거나 미룬다 — 'sent' · 'queued' · 오류 글
   * @param {string} paneId
   * @param {string} text
   */
  const submit = async (paneId, text) => {
    const queue = waiting.get(paneId)
    // 앞에 기다리는 글이 있으면 그 뒤에 — 차례가 바뀌지 않게
    if (queue) {
      queue.push(text)
      return 'queued'
    }
    if (await blocked(paneId)) {
      waiting.set(paneId, [text])
      log(`⏳ ${paneId} 에 질문 · 고르기 창이 떠 있어 닫히면 넣는다`)
      return 'queued'
    }
    return (await sendNow(paneId, text)) ?? 'sent'
  }

  // 미룬 글을 넣어 본다 — 일감이 몇 초마다 부른다. pane 이 닫혔으면 버린다
  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      await drain()
    } finally {
      ticking = false
    }
  }
  const drain = async () => {
    for (const [paneId, queue] of [...waiting]) {
      if (!paneExists(paneId)) {
        waiting.delete(paneId)
        log(`⚠️ ${paneId} 가 닫혀 미룬 지시 ${queue.length}개를 버렸다`)
        continue
      }
      while (queue.length) {
        if (await blocked(paneId)) break
        const text = /** @type {string} */ (queue[0])
        const error = await sendNow(paneId, text)
        if (error) {
          log(`⚠️ ${paneId} 에 미룬 지시를 넣지 못했다 — ${error} · 다음 차례에 다시`)
          break
        }
        queue.shift()
        log(`✅ ${paneId} 에 미룬 지시를 넣었다`)
      }
      if (!queue.length) waiting.delete(paneId)
    }
  }

  return { submit, tick, pending: (/** @type {string} */ paneId) => waiting.get(paneId)?.length ?? 0 }
}
