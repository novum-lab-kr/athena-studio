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

// 도구 로고 — 현황판 머리 사용량 칸(athena/scripts/board/index.html LOGO_PATH · cliLogo)과 같은 simple-icons(CC0) path · 색
// 패널은 오프라인이어도 보이게 외부에서 받지 않는다 · 모르는 도구는 첫 글자 로고
const LOGO_PATH: Record<string, [string, string]> = {
  claude: ['#d97757', 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'],
  codex: ['currentColor', 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'],
}
const SVG_NS = 'http://www.w3.org/2000/svg'
function toolLogo(toolId: string, label: string): Element {
  const logo = LOGO_PATH[toolId]
  if (!logo) return el('span', 'logo letter', label.charAt(0))
  const [fill, pathData] = logo
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'logo')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('fill', fill)
  path.setAttribute('d', pathData)
  svg.append(path)
  return svg
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
    const name = el('b')
    name.append(toolLogo(prov.dataset.tool, tool || ''), tool || '')
    prov.append(name)
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
