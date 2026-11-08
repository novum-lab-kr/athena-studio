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
  // 에이전트가 받았다 — 코어 request ack · 기록됐으면 true
  ack: () => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
}

const OPTION_LINE = /^\s*[❯›]?\s*(\d+)\.\s+(.*?)\s*$/
// 선택지 뒤에 에이전트가 붙이는 항목(실측) — 요청 선택지가 아니다
const isExtra = (agent: string, label: string) =>
  agent === 'claude' ? label === 'Type something.' || label === 'Chat about this' : label === 'None of the above' || label.startsWith('None of the above  ')
// 선택 창 표식 — 이 중 하나라도 화면에 남아 있으면 창이 닫혔다고 보지 않는다
const PROMPT_MARKS = [/Enter to select · ↑\/↓ to navigate/, /Tab\/Arrow keys to navigate/, /enter to submit answer/i, /^\s*(←\s*)?☐\s+\S/, /^\s*Question \d+\/\d+\b/]
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
  // 화면 선택지 전체(덧붙는 항목 빼고)가 요청 선택지와 개수 · 라벨 · 순서까지 같아야 한다(Claude 는 설명이 다음 줄 · Codex 는 같은 줄에 두 칸 이상 띄우고)
  const labels: string[] = []
  for (const line of rest.slice(first)) {
    const match = OPTION_LINE.exec(line)
    if (match && Number(match[1]) === labels.length + 1) labels.push(match[2]!)
  }
  const shown = labels.filter((label) => !isExtra(agent, label))
  // 덧붙는 항목은 맨 뒤에만 — 중간에 끼면 모르는 화면이다
  if (labels.slice(0, shown.length).some((label) => isExtra(agent, label))) return null
  if (shown.length !== request.options.length) return null
  const same = request.options.every((option, at) => {
    const label = shown[at]!
    return agent === 'claude' ? label === option.label : label === option.label || label.startsWith(`${option.label}  `)
  })
  return same ? String(index + 1) : null
}

// 선택 창이 닫힌 화면 — 읽혔고 · 입력 대기가 아니고 · 선택 창 표식도 이 요청의 선택지 줄('2. Blue')도 없다
// (다시 그리는 중 제목 · 선택지 · 맺음 일부만 읽혀도 남은 조각이 있거나 비어 있으면 닫힘으로 치지 않는다)
export function promptClosed(text: string | null, request: PromptRequest): boolean {
  if (text === null || screenModel.waitingForInput(text)) return false
  const lines = text.split('\n').filter((line) => line.trim())
  const labels = new Set(request.options.map((option) => option.label))
  const optionLine = (line: string) => {
    const label = OPTION_LINE.exec(line)?.[2] ?? ''
    return [...labels].some((known) => label === known || label.startsWith(`${known}  `))
  }
  return lines.length > 0 && !lines.some((line) => optionLine(line) || PROMPT_MARKS.some((mark) => mark.test(line)))
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
    // 고르면 창이 닫힌다(실측 1초 안). 닫힌 화면이 두 번 잇달아 읽혀야 닫힘으로 본다 — 그대로거나 확인 못 하면 키를 더 누르지 않는다
    let closedReads = 0
    for (let poll = 0; poll < 15; poll++) {
      await sleep(200)
      closedReads = promptClosed(await io.read(paneId), request) ? closedReads + 1 : 0
      if (closedReads < 2) continue
      // ack 가 기록되지 않으면 요청은 answered 로 남는다 — 성공으로 알리지 않는다
      return (await io.ack()) ? { delivered: true, chose: true } : { delivered: false, reason: 'unconfirmed' }
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
