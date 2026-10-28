// 메뉴 막대 패널(★ Codex 추천 · 상태 목록형) — 확인 필요 → 에이전트(두 줄 행) → 사용량(창마다 얇은 막대) → 칸반 숫자 → 최근 24시간 완료 막대그래프.
// 많으면: 확인 필요 3줄 + 'n개 더' · 에이전트 칸 안 스크롤 · 패널 최대 높이 넘으면 스크롤. 없으면: 한 줄 안내.
// 글자는 모두 textContent(HTML 로 넣지 않는다)
import * as StudioI18n from '../lib/i18n.mts'
import type { Dictionary, Values } from '../lib/i18n.mts'

// main 의 i18nPayload(src/main.mts) — 메인 창과 같은 모양
type TrayI18n = { language: string; dictionary: Dictionary; fallback: Dictionary }
// main 의 summarize(src/lib/tray-model.mts) 중 패널이 읽는 것 — 그 파일은 Node 모듈이라 화면 타입 검사로 가져오지 않는다
type TrayAttention = { id: string; requestKind: string | undefined; text: string }
type TrayAgent = { id: string; name: string; workspace: string; status: string }
type TrayUsageItem = { tool: string | undefined; toolId: string; window: string | undefined; percent: number; reset: string }
type TraySummary = {
  counts: { working: number }
  avgWait: string
  attention: TrayAttention[]
  agents: TrayAgent[]
  usageItems: TrayUsageItem[]
  done24: { hours: number[]; total: number }
  columns: Record<string, number>
  idleAgents: number
  waitingAgents: number
  boardUp: boolean
}
// main 의 sendTrayUpdate(src/main/tray.mts) 중 패널이 읽는 것(history 는 안 읽는다)
type TrayUpdate = { summary: TraySummary; boardAt: number; pausedUntil: number }

// preload-tray.js 가 여는 trayPanel 전역
declare global {
  const trayPanel: {
    i18n(): TrayI18n
    onLanguage(callback: (payload: TrayI18n) => void): () => void
    onUpdate(callback: (data: TrayUpdate) => void): () => void
    action(name: string, value?: string): void
    reportHeight(height: number): void
  }
}

// 없으면 그 자리에서 TypeError(옛 JS 와 같다) — 캐스트만
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const ATTENTION_ROWS = 3
// 문구는 사전(src/i18n) — main 이 preload 로 넘긴다
let i18nState = trayPanel.i18n()
const say = (key: string, values?: Values) => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)
const STATUS_KEYS: Record<string, string> = { working: 'tray.status.working', idle: 'tray.status.idle', waiting: 'tray.status.waiting' }
const COLUMNS: [string, string][] = [
  ['issue', 'tray.column.issue'],
  ['plan', 'tray.column.plan'],
  ['doing', 'tray.column.progress'],
  ['review', 'tray.column.review'],
  ['done', 'tray.column.done'],
]
const USAGE_HIGH = 80 // 이 % 넘으면 % 글자를 빨갛게(막대는 도구 색 그대로)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function clock(ms: number): string {
  if (!ms) return '-'
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// 칸 제목 — 위에 가는 선 · 오른쪽에 짧은 요약
function title(text: string, summaryText?: string): HTMLElement {
  const row = el('div', 't', text)
  if (summaryText) row.append(el('span', 'sum', summaryText))
  return row
}

// 확인 필요 — 사람에게 묻는 요청만. 제목에 수, 아래 한 줄씩(누르면 앱에서 그 요청 — 질문은 답하기 · 결정은 결정 콘솔)
function attention(summary: TraySummary): HTMLElement {
  const items = summary.attention
  if (!items.length) return el('div', 'att clear', say('tray.attention.none'))
  const box = el('div', 'att')
  box.append(el('b', '', `${say('tray.attention.count', { count: items.length })}${summary.avgWait}`))
  for (const item of items.slice(0, ATTENTION_ROWS)) {
    const row = el('button', 'it r')
    row.title = item.text
    row.append(el('span', 'tx', item.text), el('span', 'go', '›'))
    row.append(el('em', '', say(`work.kind.${item.requestKind === 'decision' ? 'decision' : 'question'}`)))
    row.addEventListener('click', () => trayPanel.action('open-request', item.id))
    box.append(row)
  }
  if (items.length > ATTENTION_ROWS) {
    const more = el('button', 'it')
    more.append(el('span', 'tx', say('tray.attention.more', { count: items.length - ATTENTION_ROWS })), el('span', 'go', '›'))
    more.addEventListener('click', () => trayPanel.action('open-work'))
    box.append(more)
  }
  return box
}

// 에이전트 — 두 줄 행(이름 / 작업 공간) · 오른쪽 상태 · 누르면 그 pane
function agentsBlock(summary: TraySummary): HTMLElement {
  const wrap = el('div', 'agents')
  if (!summary.agents.length) {
    const empty = el('div', 'empty', say('tray.agents.none'))
    const open = el('button', '', say('tray.menu.open'))
    open.addEventListener('click', () => trayPanel.action('show', 'work'))
    empty.append(open)
    wrap.append(empty)
    return wrap
  }
  for (const agent of summary.agents) {
    const row = el('button', 'ag')
    row.title = say('tray.agents.rowTitle', { name: `${agent.name}${agent.workspace ? ` · ${agent.workspace}` : ''}` })
    const name = el('div', 'nm', agent.name)
    name.append(el('small', '', agent.workspace || say('tray.agents.noWorkspace')))
    row.append(el('span', `dot ${agent.status}`), name, el('i', '', STATUS_KEYS[agent.status] ? say(STATUS_KEYS[agent.status]!) : agent.status))
    row.addEventListener('click', () => trayPanel.action('focus-pane', agent.id))
    wrap.append(row)
  }
  return wrap
}

// 사용량 — 도구마다 묶고, 창마다 '<창> <%> ▬ · <리셋>' · 막대는 도구 색(Claude 주황 · Codex 파랑)
function usageBlock(summary: TraySummary): HTMLElement {
  const box = el('div', 'usage')
  const tools = new Map<string | undefined, TrayUsageItem[]>()
  for (const item of summary.usageItems || []) {
    if (!tools.has(item.tool)) tools.set(item.tool, [])
    tools.get(item.tool)!.push(item)
  }
  if (!tools.size) {
    box.append(el('div', 'empty', summary.boardUp ? say('tray.usage.none') : say('tray.usage.boardOff')))
    return box
  }
  for (const [tool, windows] of tools) {
    const prov = el('div', 'prov')
    prov.dataset.tool = windows[0]!.toolId || ''
    prov.append(el('b', '', tool))
    for (const item of windows) {
      const line = el('div', `win${item.percent >= USAGE_HIGH ? ' hi' : ''}`)
      const bar = el('span', 'bar')
      const fill = el('span')
      fill.style.width = `${item.percent}%`
      bar.append(fill)
      line.append(el('span', 'wl', `${item.window} ${item.percent}%`), bar)
      if (item.reset) line.append(el('span', 'rs', `· ${item.reset}`))
      prov.append(line)
    }
    box.append(prov)
  }
  return box
}

function kanbanBlock(summary: TraySummary): HTMLElement {
  const box = el('div', 'kb')
  for (const [key, label] of COLUMNS) {
    const cell = el('button')
    cell.title = say('tray.board.view')
    cell.append(el('b', '', String(summary.columns[key] || 0)), el('small', '', say(label)))
    cell.addEventListener('click', () => trayPanel.action('show', 'board'))
    box.append(cell)
  }
  return box
}

// 최근 24시간 완료 — 한 줄 숫자(추세는 현황판 지표에서)
function historyBlock(summary: TraySummary): HTMLElement {
  const done = summary.done24 || { hours: [], total: 0 }
  return el('div', 'hist', say('tray.done.title', { count: done.total }))
}

function render(data: TrayUpdate): void {
  const { summary } = data
  const conn = $('conn')
  conn.textContent = summary.boardUp ? say('tray.connected') : say('tray.disconnected')
  conn.classList.toggle('off', !summary.boardUp)
  conn.title = say('tray.board.checkedAt', { time: clock(data.boardAt) })

  const parts = [attention(summary)]
  const waitingNote = summary.waitingAgents ? say('tray.agents.waiting', { count: summary.waitingAgents }) : ''
  parts.push(title(say('tray.agents.title'), `${say('tray.agents.summary', { working: summary.counts.working, idle: summary.idleAgents })}${waitingNote}`))
  parts.push(agentsBlock(summary))
  parts.push(title(say('tray.usage.title')))
  parts.push(usageBlock(summary))
  // 현황판이 꺼져 있으면 칸반 · 완료 그래프는 숨긴다(0 으로 보이지 않게)
  if (summary.boardUp) parts.push(kanbanBlock(summary), historyBlock(summary))
  $('body').replaceChildren(...parts)

  // 알림을 일시 중지했을 때만 머리줄에 🔕(언제까지는 마우스를 올리면)
  const paused = data.pausedUntil > Date.now()
  $('bell').hidden = !paused
  $('bell').title = paused ? say('tray.paused', { time: clock(data.pausedUntil) }) : ''
  // 머리줄 + 본문의 실제 높이 그대로(어림 여백을 더하지 않는다 — 남는 자리가 띠로 보인다 · 최대는 main 이 화면 높이로 자른다)
  requestAnimationFrame(() => trayPanel.reportHeight(Math.ceil($('hd').getBoundingClientRect().height + $('body').scrollHeight)))
}

// 정적 문구(data-i18n-title) — 처음과 언어를 바꿨을 때
function applyStaticTexts(): void {
  document.documentElement.lang = i18nState.language
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) node.title = say(node.dataset.i18nTitle ?? '')
}

// 언어를 바꾸면 main 이 곧이어 요약을 다시 보낸다(보일 때) — 여기서는 사전과 정적 문구만
trayPanel.onLanguage((next) => {
  i18nState = next
  applyStaticTexts()
})
applyStaticTexts()
$('menu').addEventListener('click', () => trayPanel.action('menu'))
trayPanel.onUpdate(render)
