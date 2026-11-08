// [작업] 에서 한 답을 묻던 pane 에 넣기 — 입력칸에 한 줄로 넣거나, 같은 질문의 선택 창이 떠 있으면 그 창에서 같은 선택지를 고른다.
// 선택 창 화면은 실측(2026-11-08 · Claude Code 2.1.319 · codex-cli 0.166.0 — pane read --source visible):
//   Claude 질문 하나: ' ☐ <header>' · 질문 줄 · '❯ 1. Red' (다음 줄 설명) … 'N. Type something.' · 'Enter to select · ↑/↓ to navigate · Esc to cancel'
//   Claude 질문 여럿: '←  ☐ Color  ☐ Size  ✔ Submit  →' — 마지막 Submit 단계가 있어 고르지 않는다
//   Codex 질문 하나: 'Question 1/1 (1 unanswered)' · 질문 줄 · '› 1. Red   The color red' … 'tab to add notes | enter to submit answer | esc to interrupt'
//   두 쪽 모두 질문 하나면 선택지 숫자 한 글자로 바로 고르고 제출된다(Enter 없이)
import { createRequire } from 'node:module'
const screenModel: typeof import('./screen-model.js') = createRequire(import.meta.url)('./screen-model.js')

type PromptRequest = { title: string; body?: string; options: readonly { label: string }[] }
type Answer = { choice?: unknown; text?: unknown }
// 넣지 못한 이유 — no-pane: pane 이 없다 · prompt-open: 선택 창이 떠 있어 넣지 못했다 · unconfirmed: 보냈지만 들어갔는지 확인 못 했다
export type DeliveryReason = 'no-pane' | 'prompt-open' | 'unconfirmed'
export type Delivery = { delivered: true; chose?: boolean } | { delivered: false; reason: DeliveryReason }
type Io = {
  // pane 목록 — 읽지 못하면 null
  panes: () => Promise<{ id?: unknown; agent?: unknown }[] | null>
  // 지금 화면 글 — 읽지 못하면 null
  read: (pane: string) => Promise<string | null>
  // 입력칸에 한 줄(데몬 pane run — 전송 확인까지) · 실패면 데몬 오류 code
  run: (pane: string, line: string) => Promise<{ code?: unknown } | null>
  // 글자 그대로 쓰기(데몬 pane send-text)
  type: (pane: string, text: string) => Promise<boolean>
  // 에이전트가 받았다 — 코어 request ack
  ack: () => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
}

const OPTION_LINE = /^\s*[❯›]?\s*(\d+)\.\s+(.*?)\s*$/
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim()

// 화면이 이 요청의 선택 창(질문 하나 · 같은 질문 · 같은 선택지 순서)이면 고를 숫자 한 글자, 아니면 null(키를 누르지 않는다)
export function choiceKey(text: string, agent: unknown, request: PromptRequest, answer: Answer): string | null {
  if (agent !== 'claude' && agent !== 'codex') return null
  // 메모가 붙은 답은 선택 창에 담는 동작을 실측하지 않았다 — 고르지 않는다
  if (String(answer.text || '').trim()) return null
  const choice = String(answer.choice || '').trim()
  const index = request.options.findIndex((option) => option.label === choice)
  if (!choice || index < 0 || index >= 9 || !screenModel.waitingForInput(text)) return null
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim())
  const footer = lines.slice(-3).join(' ')
  const startMark = agent === 'claude' ? /^\s*☐\s+\S/ : /^\s*Question 1\/1\b/
  if (agent === 'claude' ? !/Enter to select · ↑\/↓ to navigate/.test(footer) : !/enter to submit answer/i.test(footer)) return null
  const start = lines.findLastIndex((line) => startMark.test(line))
  if (start < 0) return null
  // Claude 는 질문 머리(header)를 ☐ 줄에 보인다 — 훅이 요청 본문에 [header] 로 적어 둔 것과 같아야 한다
  if (agent === 'claude' && !String(request.body || '').includes(`[${lines[start]!.replace(/^\s*☐\s+/, '').trim()}]`)) return null
  const rest = lines.slice(start + 1)
  const first = rest.findIndex((line) => OPTION_LINE.exec(line)?.[1] === '1')
  if (first < 1 || collapse(rest.slice(0, first).join(' ')) !== collapse(request.title)) return null
  // 1..k 번 선택지 라벨이 요청 선택지와 순서대로 같아야 한다(Claude 는 설명이 다음 줄 · Codex 는 같은 줄에 두 칸 이상 띄우고)
  const labels = new Map<number, string>()
  for (const line of rest.slice(first)) {
    const match = OPTION_LINE.exec(line)
    if (match && !labels.has(Number(match[1]))) labels.set(Number(match[1]), match[2]!)
  }
  const same = request.options.every((option, at) => {
    const shown = labels.get(at + 1)
    if (shown === undefined) return false
    return agent === 'claude' ? shown === option.label : shown === option.label || shown.startsWith(`${option.label}  `)
  })
  return same ? String(index + 1) : null
}

// 답 넣기 — 선택 창이 아니면 입력칸에 한 줄, 같은 질문의 선택 창이면 그 창에서 고르고 닫혔는지 다시 읽어 확인한다
export async function deliverAnswer(paneId: unknown, request: PromptRequest, answer: Answer, line: string, io: Io): Promise<Delivery> {
  const sleep = io.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  if (typeof paneId !== 'string' || !paneId) return { delivered: false, reason: 'no-pane' }
  const panes = await io.panes()
  const pane = panes && panes.find((entry) => entry.id === paneId)
  if (!pane) return { delivered: false, reason: 'no-pane' }
  const screen = await io.read(paneId)
  if (screen !== null && screenModel.waitingForInput(screen)) {
    const key = choiceKey(screen, pane.agent, request, answer)
    if (!key) return { delivered: false, reason: 'prompt-open' }
    if (!(await io.type(paneId, key))) return { delivered: false, reason: 'unconfirmed' }
    // 고르면 창이 닫힌다(실측 1초 안). 같은 창이 그대로면 들어갔는지 모른다 — 키를 더 누르지 않는다
    for (let poll = 0; poll < 10; poll++) {
      await sleep(200)
      const after = await io.read(paneId)
      if (after !== null && choiceKey(after, pane.agent, request, answer) === null) {
        await io.ack()
        return { delivered: true, chose: true }
      }
    }
    return { delivered: false, reason: 'unconfirmed' }
  }
  const failed = await io.run(paneId, line)
  if (!failed) return { delivered: true }
  if (failed.code === 'not_found') return { delivered: false, reason: 'no-pane' }
  // 보내는 사이 선택 창이 떴으면 글은 쓰지 않았다(pane-submit 이 쓰기 전에 거절)
  const now = failed.code === 'unavailable' ? await io.read(paneId) : null
  return { delivered: false, reason: now !== null && screenModel.waitingForInput(now) ? 'prompt-open' : 'unconfirmed' }
}
