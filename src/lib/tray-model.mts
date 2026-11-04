// 맥 상단 메뉴 막대(Tray) — 무엇을 보여 주고 언제 알릴지. Electron 없이 돌아 `npm test` 로 검사한다
// 재료: 데몬 pane 목록(agent · agent_status) · 작업 공간 이름 · 아테나 현황판 /api/state(header.usage) · 사람에게 묻는 요청(request list)
import { createRequire } from 'node:module'
import * as i18n from './i18n.mts'
import { dayKey, lastDays } from './daily-tokens.mts'

// 문구 — say(키, 자리 값). 사전 · 자리 채우기는 i18n.mts
export type Say = (key: string, values?: Record<string, unknown>) => string
type Dictionary = Record<string, string>

// 사전은 JSON — main 과 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const KOREAN: Dictionary = require('../i18n/ko.json')

// 데몬 pane 에서 읽는 칸만
export type TrayPane = { id: string; label?: string; agent?: string; agent_status?: string; workspace_id?: string }
type Workspace = { id: string; label: string }
type TrayRequest = { id: string; kind?: string; title: string; state?: string; pane?: unknown; permission?: boolean }
// 현황판 header.usage — 도구마다 창(5시간 · 주간 …)
type UsageWindow = { label?: string; minutes?: unknown; percent?: unknown; resetsAt?: ResetsAt }
type UsageTool = { id?: string; label?: string; windows?: UsageWindow[] }
type ResetsAt = string | number | Date | null | undefined

export type TrayAgent = { id: string; name: string; branch: string; workspace: string; status: string }
export type UsageItem = { tool: string | undefined; toolId: string; window: string | undefined; percent: number; reset: string }
export type Notice = { kind: string; title: string; body: string; target: { pane?: string; request?: string } }

// 문구는 사전(src/i18n)에서 — main 이 지금 언어의 say 를 넘긴다(없으면 한국어 · 테스트)
const koreanSay = i18n.translator(KOREAN, KOREAN)
// 입력 대기(권한 질문 · 고르기 창)가 이만큼 이어져야 알린다 — 메뉴 막대가 4초마다 보니 두 번 잇달아 보여야 한다(잠깐 묻고 바로 넘어간 것은 빼고)
export const WAIT_HOLD_MS = 3000

// pane 이름 — delegate 가 붙인 '🤖 에이전트 · 브랜치' 이름표가 있으면 그것, 없으면 agent
export function agentName(pane: TrayPane): string {
  const label = String(pane.label || '').replace(/^🤖\s*/, '').trim()
  return label || pane.agent || pane.id
}

// 브랜치 — delegate 이름표 '🤖 에이전트 · 브랜치'(athena/scripts/delegate.sh)의 ' · ' 뒤. 이름표가 없거나 브랜치가 없으면 ''
export function agentBranch(pane: TrayPane): string {
  const label = String(pane.label || '')
  if (!label.startsWith('🤖')) return ''
  const at = label.indexOf(' · ')
  return at < 0 ? '' : label.slice(at + 3).trim()
}

type SummaryInput = {
  panes?: (TrayPane | null | undefined)[]
  workspaces?: Workspace[]
  usage?: unknown
  boardUp?: boolean
  now?: number
  say?: Say
}

// 메뉴 · 아이콘 제목에 쓸 요약
export function summarize({ panes = [], workspaces = [], usage = [], boardUp = false, now = Date.now(), say = koreanSay }: SummaryInput = {}) {
  const names = new Map<string | undefined, string>(workspaces.map((workspace) => [workspace.id, workspace.label]))
  const agents: TrayAgent[] = panes
    .filter((pane): pane is TrayPane => Boolean(pane && pane.agent))
    .map((pane) => ({ id: pane.id, name: agentName(pane), branch: agentBranch(pane), workspace: names.get(pane.workspace_id) || '', status: pane.agent_status || 'idle' }))
  // 입력 대기 먼저, 그다음 일하는 것 — 데몬의 입력 대기(waiting)를 그대로 쓰고, 메뉴 막대는 옛 데몬의 화면 판정도 보완한다
  const rank: Record<string, number> = { waiting: 0, working: 1 }
  agents.sort((left, right) => (rank[left.status] ?? 2) - (rank[right.status] ?? 2))
  // 일하는 에이전트 수 — 아이콘 눈 색 · 툴팁(막힘 · 리뷰 수는 빼기로 — 사용자 2026-11-04)
  const counts = { working: agents.filter((agent) => agent.status === 'working').length }
  const idle = agents.filter((agent) => agent.status !== 'working' && agent.status !== 'waiting').length
  return {
    counts,
    // 에이전트는 전부(패널이 칸 안에서 스크롤)
    agents,
    usageItems: usageItems(usage, now, say),
    idleAgents: idle,
    waitingAgents: agents.filter((agent) => agent.status === 'waiting').length,
    boardUp,
  }
}

const HOUR_MS = 3600000

// 리셋 시각 — 오늘이면 'HH:MM', 내일이면 '내일 HH:MM', 그 뒤면 '월 HH:MM'(없거나 못 읽으면 '')
export function resetClock(resetsAt: ResetsAt, now: number = Date.now(), say: Say = koreanSay): string {
  const date = resetsAt ? new Date(typeof resetsAt === 'number' && resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  const days = Math.round((day.getTime() - today.getTime()) / (24 * HOUR_MS))
  if (days <= 0) return time
  if (days === 1) return say('time.tomorrow', { time })
  return `${say(`time.weekday.${date.getDay()}`)} ${time}`
}

// 창 이름 — 현황판이 준 창 길이(분)로 지금 언어에 맞춰 짓는다. 길이가 없으면(옛 코어) 현황판이 준 label(한국어) 그대로
export function windowName(window: UsageWindow, say: Say = koreanSay): string | undefined {
  const minutes = window.minutes
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0) return window.label
  if (minutes === 300) return say('tray.usage.window.fiveHours')
  if (minutes === 10080) return say('tray.usage.window.weekly')
  if (minutes % 1440 === 0) return say('tray.usage.window.days', { count: minutes / 1440 })
  if (minutes % 60 === 0) return say('tray.usage.window.hours', { count: minutes / 60 })
  return say('tray.usage.window.minutes', { count: minutes })
}

// 현황판 header.usage → [{ tool, toolId, window, percent, reset }] — 패널 막대용(toolId 로 도구 색)
export function usageItems(usage: unknown, now: number = Date.now(), say: Say = koreanSay): UsageItem[] {
  const items: UsageItem[] = []
  const tools: UsageTool[] = Array.isArray(usage) ? usage : []
  for (const tool of tools) {
    const label = tool.label || tool.id
    for (const window of tool.windows || []) {
      if (typeof window.percent !== 'number') continue
      items.push({ tool: label, toolId: String(tool.id || ''), window: windowName(window, say), percent: Math.max(0, Math.min(100, Math.round(window.percent))), reset: resetClock(window.resetsAt, now, say) })
    }
  }
  return items
}


// 일한 시간 — 날마다 10분 한 칸 144개(0시 0분 칸부터 · 현지 시각). 칸 값은 그 10분 동안 에이전트들이 일한 시간의 합(에이전트·분):
// 4초마다 잴 때 일하는 에이전트 수 × 4초를 그 칸에 더한다(동시 최대가 아니다 — 사용자 2026-11-05).
// 오늘 · 어제 · 그저께 3일치만 들고 간다 — 더 오래된 날은 버린다(패널의 산 그림이 세 날을 겹쳐 그린다)
export const DAY_SLOTS = 144
export const ACTIVITY_DAYS = 3
export const SAMPLE_SECONDS = 4
// 저장 형식 — 옛 파일({ day, bins } · 칸 값 = 동시 최대)은 뜻이 달라 섞지 않고 버린다
export const ACTIVITY_FORMAT = 2
export type DayActivity = { day: string; bins: number[] }
export type ActivityLog = { format: typeof ACTIVITY_FORMAT; days: DayActivity[] }

// 그날 몇 번째 10분 칸인지(0~143)
export function daySlot(now: number): number {
  const date = new Date(now)
  return Math.min(DAY_SLOTS - 1, Math.floor((date.getHours() * 60 + date.getMinutes()) / 10))
}

// 들고 갈 날짜 — [오늘, 어제, 그저께]
export function activityDays(now: number): string[] {
  return lastDays(now, ACTIVITY_DAYS).reverse()
}

// 3일 밖의 날 · 모양이 다른 날을 걸러 낸다(같은 날이 둘이면 앞의 것)
function keepDays(days: DayActivity[], now: number): DayActivity[] {
  const keys = activityDays(now)
  return keys.map((key) => days.find((day) => day.day === key)).filter((day): day is DayActivity => Boolean(day))
}

// 잰 값 하나를 오늘 칸에 — 일하는 에이전트 수 × 잰 간격(초)을 분으로 더한다 · 오늘 칸이 없으면 만들고 3일 밖은 버린다(넘긴 log 를 고쳐 돌려준다)
export function recordActivity(log: ActivityLog | null, now: number, working: number, seconds = SAMPLE_SECONDS): ActivityLog {
  const day = dayKey(now)
  const days = keepDays(log ? log.days : [], now)
  let today = days.find((entry) => entry.day === day)
  if (!today) {
    today = { day, bins: new Array<number>(DAY_SLOTS).fill(0) }
    days.unshift(today)
  }
  const slot = daySlot(now)
  today.bins[slot] = (today.bins[slot] ?? 0) + (Math.max(0, working) * seconds) / 60
  if (log) {
    log.days = days
    return log
  }
  return { format: ACTIVITY_FORMAT, days }
}

// 파일에 쓸 글 — 칸 값은 소수 셋째 자리까지(4초 = 0.0667분이 길게 늘어지지 않게)
export function serializeActivity(log: ActivityLog): string {
  const days = log.days.map((day) => ({ day: day.day, bins: day.bins.map((value) => Math.round(value * 1000) / 1000) }))
  return `${JSON.stringify({ format: log.format, days })}\n`
}

// 저장한 기록(앱 데이터 폴더 tray-activity.json — main 이 켤 때 읽는다) → 3일 안의 날만. 못 읽음 · 형식이 다름(옛 동시 최대 기록 포함) → null(버린다)
// 모양이 다른 날은 그날만 버린다
export function parseActivity(text: string, now: number): ActivityLog | null {
  let saved: unknown
  try {
    saved = JSON.parse(text)
  } catch {
    return null
  }
  if (!saved || typeof saved !== 'object') return null
  const { format, days } = saved as { format?: unknown; days?: unknown }
  if (format !== ACTIVITY_FORMAT || !Array.isArray(days)) return null
  const valid = days.filter((entry: unknown): entry is DayActivity => {
    if (!entry || typeof entry !== 'object') return false
    const { day, bins } = entry as { day?: unknown; bins?: unknown }
    return typeof day === 'string' && Array.isArray(bins) && bins.length === DAY_SLOTS && bins.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  })
  return { format: ACTIVITY_FORMAT, days: keepDays(valid, now) }
}

// 패널에 보낼 세 날 — 오늘은 늘 있다(기록이 없으면 빈 칸) · 어제 · 그저께는 기록이 없으면 null(패널이 그 겹을 그리지 않는다)
export function activityView(log: ActivityLog | null, now: number): { today: number[]; yesterday: number[] | null; before: number[] | null } {
  const [today = '', yesterday = '', before = ''] = activityDays(now)
  const find = (key: string) => (log ? log.days.find((day) => day.day === key)?.bins ?? null : null)
  return { today: find(today) ?? new Array<number>(DAY_SLOTS).fill(0), yesterday: find(yesterday), before: find(before) }
}

// 알림 — 사람이 고르거나 답할 것만: pane 의 입력 대기 · 새로 열린 요청(질문 · 결정).
// 응답 끝남 · 리뷰 · 완료는 알리지 않는다(사용자 2026-10-26 — 알림이 너무 많다). 메뉴 막대 패널 · 칸반 숫자로는 그대로 보인다.
// 처음 본 상태는 알리지 않고(켤 때 기준만 잡는다), 같은 변화는 한 번만, 한 번에 여러 건이면 묶는다
// 요청 알림을 누르면 열 곳 — 허락 창 알림은 pane 도(보고 있으면 거를 때 쓴다)
function requestTarget(request: TrayRequest): Notice['target'] {
  return request.permission && typeof request.pane === 'string' && request.pane ? { request: request.id, pane: request.pane } : { request: request.id }
}

export class Notifier {
  ready = false
  panes = new Map<string, { status: string; since: number; notified: boolean }>() // id → { status, since, notified }
  requests: Set<string> | null = null // 본 요청 id — 처음 본 목록은 알리지 않는다(켤 때 기준)
  // 허락 한 건은 pane 마다 한 번 — 화면 감지 요청 → 같은 건을 새 id 로 받는 코어 perm 요청 → pane 입력 대기가 같은 건이다(검수 #14).
  // 알린 pane 은 허락 창 요청이 열려 있거나 입력을 기다리는 동안 다시 알리지 않는다. 둘 다 풀리면 한 건이 끝난다
  alerted = new Set<string>()
  permissionPanes = new Set<string>() // 지금 허락 창 요청이 열린 pane

  private settle() {
    for (const pane of [...this.alerted]) if (!this.permissionPanes.has(pane) && this.panes.get(pane)?.status !== 'waiting') this.alerted.delete(pane)
  }

  // 새로 열린 요청만 한 번 — [{ kind: 'request', title, body, target: { request, pane? } }]. requests 가 null 이면(못 읽음) 기억 그대로.
  // 허락 창 알림만 target 에 pane 을 싣는다 — 부르는 쪽이 지금 그 pane 을 보고 있으면 거른다(다른 요청은 보고 있어도 알린다)
  updateRequests(requests: unknown, say: Say = koreanSay): Notice[] {
    if (!Array.isArray(requests)) return []
    const list: (TrayRequest | null | undefined)[] = requests
    const open = list.filter((request): request is TrayRequest => Boolean(request && request.state === 'open'))
    const known = this.requests
    this.requests = new Set(open.map((request) => request.id))
    const permissionPane = (request: TrayRequest) => request.permission && typeof request.pane === 'string' ? request.pane : ''
    this.permissionPanes = new Set(open.map(permissionPane).filter(Boolean))
    this.settle()
    if (known === null) return []
    const found: Notice[] = []
    for (const request of open) {
      if (known.has(request.id)) continue
      const pane = permissionPane(request)
      if (pane && this.alerted.has(pane)) continue
      if (pane) this.alerted.add(pane)
      found.push({ kind: 'request', title: say(`notify.request.${request.kind === 'decision' ? 'decision' : 'question'}`), body: request.title, target: requestTarget(request) })
    }
    return found
  }

  // 반환: [{ kind: 'waiting', title, body, target: { pane } }] — 묶기(bundle)는 부르는 쪽이 거른 뒤에
  update({ panes = [], names = new Map(), say = koreanSay }: { panes?: (TrayPane | null | undefined)[]; names?: Map<unknown, string>; say?: Say }, now: number): Notice[] {
    const found: Notice[] = []
    const seen = new Set<string>()
    for (const pane of panes) {
      if (!pane || !pane.agent) continue
      seen.add(pane.id)
      const status = pane.agent_status || 'idle'
      const before = this.panes.get(pane.id)
      if (!before || before.status !== status) {
        this.panes.set(pane.id, { status, since: now, notified: !this.ready })
        continue
      }
      if (before.notified || status !== 'waiting' || now - before.since < WAIT_HOLD_MS) continue
      if (this.alerted.has(pane.id)) {
        before.notified = true // 같은 건의 허락 알림이 이미 났다
        continue
      }
      // 풀릴 때까지(상태가 바뀔 때까지) 한 번 — 켤 때 이미 기다리던 것은 알리지 않는다(위 notified)
      const name = agentName(pane)
      const where = names.get(pane.workspace_id)
      const who = where ? `${name} · ${where}` : name
      found.push({ kind: 'waiting', title: say('notify.waiting.title'), body: say('notify.waiting.body', { who }), target: { pane: pane.id } })
      before.notified = true
      this.alerted.add(pane.id)
    }
    for (const id of [...this.panes.keys()]) if (!seen.has(id)) this.panes.delete(id)
    this.settle()
    this.ready = true
    return found
  }
}

// 같은 종류가 여러 건이면 하나로 — '입력을 기다려요 (3건)'
// 묶은 본문은 이름만 — 알림 본문은 사전에서 '<누구> — <내용>' 꼴이다(네 언어 모두 ' — ')
export function bundle(found: readonly Notice[], say: Say = koreanSay): Notice[] {
  const byKind = new Map<string, [Notice, ...Notice[]]>()
  for (const item of found) {
    const before = byKind.get(item.kind)
    byKind.set(item.kind, before ? [...before, item] : [item])
  }
  return [...byKind.values()].map((items) =>
    items.length === 1 ? items[0] : { ...items[0], title: say('notify.bundle', { title: items[0].title, count: items.length }), body: items.map((item) => item.body.split(' — ')[0]).join(', ') },
  )
}
