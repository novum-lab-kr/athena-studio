// @ts-check
// 끝난 에이전트 pane 자동 닫기(2026-11-12 사용자 요청 — 맡은 일이 끝나고 더 할 일이 없으면 clear 가 아니라 pane 을 닫는다).
// 현황판(server.mjs closeFinishedPanes)이 수집마다 부른다. 여기는 판정만 — 화면 · git · 요청은 server.mjs 가 읽어 넘긴다.
//   닫는 pane: 에이전트 pane(delegate.sh 가 띄운 🤖 — 리뷰어 포함 · 아테나 pane 은 아니다) 중 묶인 계획서가 모두 끝났고
//   앞(턴)이 쉬고(foreground_status idle — 뒤 셸만 도는 것은 쉼 · 옛 데몬은 agent_status) · 사용자가 보고 있지 않고(focused 아님) ·
//   선택 창 · 입력칸의 보내지 않은 글 · 열린 요청 · 미커밋 변경이 없는 상태가 CLOSE_AFTER_MS 동안 이어진 것.
//   입력칸을 못 읽으면(화면 읽기 실패 · 입력칸을 못 찾음) 글이 있는지 모르니 닫지 않는다(PR #293 리뷰 — 쓰던 글을 두고 다른 pane 으로 가면 사라졌다)
//   자동 완료는 묶인 pane 이 모두 닫혀야 돈다(#217 — 살아 있는 pane 은 후속 일을 할 수 있다) — 그래서 "끝남" 은 자동 완료 전 조건
//   (PR 이 모두 머지 · 바로 머지 끝 · 남은 단계 칸 없음)이나 Status done 이다. pane 이 닫히면 다음 수집에 자동 완료 → 보관 · 워크트리 정리가 이어진다
//   기다리는 동안 아테나가 이어 일을 시키면 쉼이 끊겨 처음부터 다시 센다

/** 끝나고 이만큼 계속 쉬어야 닫는다 — 머지 직후 아테나가 이어 시킬 틈(ATHENA_BOARD_PANE_CLOSE_MS 로 바꾼다 · 시험) */
export const CLOSE_AFTER_MS = 10 * 60 * 1000

/** pane 앞이 쉬는가 — 데몬 pane 모양(foreground_status 가 있으면 그것 · 없으면 agent_status)
 * @param {{ foreground_status?: string, agent_status?: string }} pane */
export const paneIdle = (pane) => (pane.foreground_status || pane.agent_status) === 'idle'

/** 입력칸 글 — 못 찾으면 null · 비었으면 ''. 앱 src/lib/pane-submit.mts inputOf · lead-fresh.py input_of 와 같은 규칙
 * @param {string | undefined} agent @param {string} text */
export const inputOf = (agent, text) => {
  const lines = String(text ?? '').split('\n').map((line) => line.trimEnd())
  const mark = { codex: '›', claude: '❯' }[agent ?? '']
  if (!mark) return null
  const index = lines.findLastIndex((line) => line.trimStart().startsWith(mark))
  if (index < 0) return null
  const rest = lines.slice(index + 1)
  // Claude 입력칸은 가로선, Codex 입력칸은 빈 줄로 끝난다
  const end = rest.findIndex((line) => (agent === 'claude' ? /^─{3}/.test(line) : !line.trim()))
  if (end < 0) return null
  const input = [lines[index]?.trimStart().slice(1) ?? '', ...rest.slice(0, end)].join('\n').trim()
  // Claude 가 일하는 중 받은 글을 큐로 옮기고 빈 입력칸에 그리는 안내 — 초안이 아니다
  if (agent === 'claude' && input === 'Press up to edit queued messages' && lines.some((line) => line.trim() === 'ctrl+x ctrl+s to send now')) return ''
  return input
}

/** 입력칸에 보내지 않은 글이 있나 — 화면을 못 읽었거나(null) 입력칸을 못 찾으면 모르니 true
 * @param {string | undefined} agent @param {string | null} text */
export const hasDraft = (agent, text) => text === null || inputOf(agent, text) !== ''

/** 지금 닫아도 되나 — '' 또는 막는 까닭(로그 · 시험용 한 낱말)
 * @param {{ raw: { foreground_status?: string, agent_status?: string, focused?: boolean } | undefined, plansDone: boolean, menu: boolean, draft: boolean, request: boolean, dirty: boolean }} input
 *   raw — 데몬 pane(pane list) · plansDone — 이 pane 이 묶인 계획서가 모두 끝남 · menu — 선택 창 · draft — 입력칸에 보내지 않은 글(또는 모름) · request — 이 pane 의 열린 요청 · dirty — 미커밋 변경(또는 모름) */
export const closeBlock = ({ raw, plansDone, menu, draft, request, dirty }) => {
  if (!raw) return 'gone'
  if (!plansDone) return 'plan-open'
  if (!paneIdle(raw)) return 'working'
  if (raw.focused) return 'focused'
  if (menu) return 'menu'
  if (draft) return 'draft'
  if (request) return 'request'
  if (dirty) return 'dirty'
  return ''
}

/** 쉼이 이어진 때를 센다 — pane 마다 처음 닫을 수 있게 된 시각. 막히면 지운다(다시 처음부터)
 * @param {number} afterMs */
export const createCloseTimer = (afterMs) => {
  /** @type {Map<string, number>} */
  const since = new Map()
  return {
    /** 지금 닫을 때가 됐나 @param {string} paneId @param {boolean} ready @param {number} now */
    due(paneId, ready, now) {
      if (!ready) {
        since.delete(paneId)
        return false
      }
      const first = since.get(paneId) ?? now
      since.set(paneId, first)
      return now - first >= afterMs
    },
    /** 이번 수집에 보지 않은 pane 은 잊는다(닫혔거나 묶임이 풀렸다) @param {Set<string>} seen */
    keep(seen) {
      for (const paneId of [...since.keys()]) if (!seen.has(paneId)) since.delete(paneId)
    },
    /** @param {string} paneId */
    forget(paneId) {
      since.delete(paneId)
    },
  }
}
