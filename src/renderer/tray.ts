// 메뉴 막대 패널(★ Codex 추천 · 상태 목록형) — 에이전트(두 줄 행) → 일한 시간 3일(산 능선) → 사용량(창마다 얇은 막대) → 최근 7일 토큰(하루 한 칸).
// 확인할 일 · 칸반 숫자 · 완료 24h 줄은 뺐다(사용자 2026-11-04 — 확인할 일은 [작업] 팝업이 맡는다).
// 많으면: 에이전트 칸 안 스크롤 · 패널 최대 높이 넘으면 스크롤. 없으면: 한 줄 안내.
// 글자는 모두 textContent(HTML 로 넣지 않는다)
import * as StudioI18n from '../lib/i18n.mts'
import type { Dictionary, Values } from '../lib/i18n.mts'
import { mountainGraph } from './tray-mountain.ts'
import type { ActivityDays } from './tray-mountain.ts'

// main 의 i18nPayload(src/main.mts) — 메인 창과 같은 모양
type TrayI18n = { language: string; dictionary: Dictionary; fallback: Dictionary }
// main 의 summarize(src/lib/tray-model.mts) 중 패널이 읽는 것 — 그 파일은 Node 모듈이라 화면 타입 검사로 가져오지 않는다
type TrayAgent = { id: string; name: string; branch: string; status: string }
type TrayUsageItem = { tool: string | undefined; toolId: string; window: string | undefined; percent: number; reset: string }
type TraySummary = {
  counts: { working: number }
  agents: TrayAgent[]
  usageItems: TrayUsageItem[]
  idleAgents: number
  waitingAgents: number
  boardUp: boolean
}
// 최근 7일 토큰(src/lib/daily-tokens.mts — 워커가 보낸 것) · 첫 값이 오기 전에는 null
type TrayTokens = { at: number; days: { day: string; claude: number; codex: number }[] }
// main 의 sendTrayUpdate(src/main/tray.mts) 중 패널이 읽는 것 — activity: 오늘 · 어제 · 그저께 10분 칸 144개마다 일한 시간(에이전트·분 · 기록 없는 날은 null) · slot: 지금 칸(0~143)
type TrayActivity = ActivityDays & { slot: number; at: number }
type TrayUpdate = { summary: TraySummary; activity: TrayActivity | null; tokens: TrayTokens | null; pausedUntil: number }

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
// 문구는 사전(src/i18n) — main 이 preload 로 넘긴다
let i18nState = trayPanel.i18n()
const say = (key: string, values?: Values) => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)
const STATUS_KEYS: Record<string, string> = { working: 'tray.status.working', idle: 'tray.status.idle', waiting: 'tray.status.waiting' }
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

// 에이전트 — 한 줄 '[pane ID]브랜치'(브랜치가 없으면 이름) · 길면 끝을 … 으로(툴팁에 전체) · 오른쪽 상태 · 누르면 그 pane
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
    const text = `[${agent.id}]${agent.branch || agent.name}`
    row.title = say('tray.agents.rowTitle', { name: text })
    const name = el('div', 'nm', text)
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

// 토큰 수 짧게 — 980 · 42k · 3.1M(src/lib/token-usage.mts formatTokens 와 같은 규칙)
function shortTokens(count: number): string {
  const trim = (text: string) => text.replace(/\.0$/, '')
  if (count < 1000) return String(Math.round(count))
  if (count < 1e6) return `${trim((count / 1000).toFixed(count < 10000 ? 1 : 0))}k`
  if (count < 1e9) return `${trim((count / 1e6).toFixed(count < 1e7 ? 1 : 0))}M`
  return `${trim((count / 1e9).toFixed(1))}B`
}

// 일한 시간 · 3일 — 산 능선 그림(tray-mountain.ts) · 오른쪽 합계는 오늘 일한 시간(에이전트·분 합)
function spentText(minutes: number): string {
  const total = Math.round(minutes)
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (!hours) return say('time.minutes', { n: rest })
  if (!rest) return say('time.hours', { n: hours })
  return say('time.hoursMinutes', { h: hours, m: rest })
}
function activityBlock(activity: TrayActivity | null): HTMLElement[] {
  if (!activity) return [title(say('tray.activity.title'))]
  const spent = activity.today.slice(0, activity.slot + 1).reduce((sum, value) => sum + value, 0)
  return [title(say('tray.activity.title'), say('tray.activity.summary', { time: spentText(spent) })), mountainGraph(activity, activity.slot, activity.at)]
}

// 최근 7일 토큰 — 하루 한 칸 · Claude(아래) · Codex(위) 쌓은 막대 · 높이는 7일 중 가장 많은 날 기준 · 아래 요일(마지막은 오늘)
function tokensBlock(tokens: TrayTokens | null): HTMLElement[] {
  const head = (summaryText?: string) => {
    const row = title(say('tray.tokens.title'), summaryText)
    row.title = say('tray.tokens.basis')
    return row
  }
  if (!tokens) return [head(), el('div', 'empty', say('tray.tokens.loading'))]
  const totals = tokens.days.map((day) => day.claude + day.codex)
  const max = Math.max(1, ...totals)
  const today = totals[totals.length - 1] ?? 0
  const week = totals.reduce((sum, value) => sum + value, 0)
  const chart = el('div', 'tok')
  tokens.days.forEach((day, index) => {
    const col = el('div', 'col')
    col.title = say('tray.tokens.dayTitle', { day: day.day, claude: shortTokens(day.claude), codex: shortTokens(day.codex) })
    const stack = el('div', 'stack')
    for (const [tool, value] of [['claude', day.claude], ['codex', day.codex]] as const) {
      if (!value) continue
      const part = el('span', tool)
      part.style.height = `${(value / max) * 100}%`
      stack.append(part)
    }
    const last = index === tokens.days.length - 1
    const weekday = new Date(`${day.day}T12:00:00`).getDay()
    col.append(el('small', 'n', totals[index] ? shortTokens(totals[index]!) : ''), stack, el('small', last ? 'today' : '', last ? say('tray.tokens.today') : say(`time.weekday.${weekday}`)))
    chart.append(col)
  })
  const legend = el('div', 'legend')
  legend.append(el('span', 'claude', 'Claude'), el('span', 'codex', 'Codex'))
  return [head(say('tray.tokens.summary', { today: shortTokens(today), week: shortTokens(week) })), chart, legend]
}

function render(data: TrayUpdate): void {
  const { summary } = data
  const parts: HTMLElement[] = []
  const waitingNote = summary.waitingAgents ? say('tray.agents.waiting', { count: summary.waitingAgents }) : ''
  parts.push(title(say('tray.agents.title'), `${say('tray.agents.summary', { working: summary.counts.working, idle: summary.idleAgents })}${waitingNote}`))
  parts.push(agentsBlock(summary))
  parts.push(...activityBlock(data.activity))
  parts.push(title(say('tray.usage.title')))
  parts.push(usageBlock(summary))
  parts.push(...tokensBlock(data.tokens))
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
// 패널이 닫히면(창이 숨으면) 구름 · 별 움직임을 멈춘다 — 열면 이어서
const pauseMotion = () => document.body.classList.toggle('paused', document.hidden)
document.addEventListener('visibilitychange', pauseMotion)
pauseMotion()
