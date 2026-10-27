// 하단 에이전트 모니터 칸 — 머리줄 칩(monitor-sessions) · 로그(monitor-feed)
// PR-R8. 칸 껍데기(보이기 · 숨기기 — 작업 공간이 있으면 어느 공간이든(#59) · 접기 · 펴기 · main 에 보는 중 알리기(monitorWatch) ·
// main 알림 받기(onMonitorUpdate) · 30초마다 새로 쓰기 타이머)는 바닐라 pane-layout.ts. 받은 갱신을 모으고(세션 · 이벤트 · 고른 칩) 그리기 · 스크롤 지키기는 여기서 한다.
// 다른 팝업과 달리 열고 닫지 않는다 — 켤 때 한 번 띄워 두고 계속 쓴다
import { flushSync } from 'react-dom'
import type { CSSProperties } from 'react'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

// main 이 보내는 monitor:update(src/main/agent-monitor.mts) — 세션은 src/main/monitor-logs.mts MonitorSession,
// 이벤트는 MonitorEvent(src/lib/agent-feed.mts FeedEvent + id · session). 그 파일들은 Node 모듈이라 화면 타입 검사로 가져오지 않는다
type MonitorSession = { id: string; label: string; pane: boolean; finished: boolean; tools: number; lastAt: number }
type MonitorEvent = { id: number; session: string; kind: 'tool' | 'say' | 'user'; icon: string; name: string; text: string; at: string | null }
export type MonitorUpdate = { reset?: boolean; sessions?: MonitorSession[]; events?: MonitorEvent[] }

// 바닐라가 넘긴다 — 작업 공간 아이콘과 같은 이름 색(space-actions.ts spaceColor)
export type MonitorOptions = { spaceColor: (label: string) => string }

const MONITOR_ROWS = 300

// now — 'n분 전' · 지금 작업 중인지를 재는 시각(갱신 · 타이머 · 언어 바꾸기 때 새로)
type MonitorView = { sessions: MonitorSession[]; events: MonitorEvent[]; filter: string | null; now: number }
const view = createStore<MonitorView>({ sessions: [], events: [], filter: null, now: Date.now() })

let feedBox: HTMLElement | null = null
let options: MonitorOptions = { spaceColor: () => '' }

// 켤 때 한 번 — 칩 칸 · 로그 칸에 각각 띄운다(내리지 않는다)
export function mount(sessionsBox: HTMLElement, feed: HTMLElement, next: MonitorOptions): void {
  options = next
  feedBox = feed
  mountIsland(sessionsBox, <SessionChips />)
  mountIsland(feed, <Feed />)
  stickToBottom()
}

// 스크롤 — 'bottom' 맨 아래로 · 'keep' 위쪽을 읽던 중이면 그 자리(맨 아래였으면 따라 내려간다) · 'follow' 맨 아래를 보고 있을 때만 따라 내려간다
type ScrollMode = 'bottom' | 'keep' | 'follow'

const isAtBottom = (feed: HTMLElement) => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24

function stickToBottom(): void {
  if (feedBox) feedBox.scrollTop = feedBox.scrollHeight
}

// 바닐라가 replaceChildren 하던 때처럼 그리기는 바로(flushSync) — 그다음 스크롤을 맞춘다
function commit(next: MonitorView, scroll: ScrollMode): void {
  const feed = feedBox
  const atBottom = feed ? isAtBottom(feed) : true
  const scrollTop = feed ? feed.scrollTop : 0
  const wasEmpty = shownEvents(view.get()).length === 0
  flushSync(() => view.set(next))
  if (!feed || shownEvents(next).length === 0) return
  // 빈 글 자리에 줄이 처음 들어오면 맨 아래부터
  const mode = wasEmpty ? 'bottom' : scroll
  if (mode === 'bottom' || atBottom) feed.scrollTop = feed.scrollHeight
  else if (mode === 'keep') feed.scrollTop = scrollTop
}

function shownEvents(state: MonitorView): MonitorEvent[] {
  return state.filter ? state.events.filter((event) => event.session === state.filter) : state.events
}

// 지금 작업 중인 에이전트 — 끝나지 않았고 마지막 움직임이 2분 안
const isLiveSession = (session: MonitorSession, now: number) => !session.finished && now - session.lastAt < 2 * 60000

// 고른 칩의 세션이 조용해졌으면(칩이 빠진다) 거름을 풀어 전체 로그로
function liveFilter(filter: string | null, sessions: MonitorSession[], now: number): string | null {
  if (!filter) return null
  const session = sessions.find((entry) => entry.id === filter)
  return session && isLiveSession(session, now) ? filter : null
}

const byEventTime = (left: MonitorEvent, right: MonitorEvent) => String(left.at).localeCompare(String(right.at)) || left.id - right.id

// main 알림 — reset 이면 통째로 바꾸고, 아니면 새 이벤트를 덧붙인다(맨 아래를 보고 있을 때만 따라 내려간다)
export function update(next: MonitorUpdate): void {
  const state = view.get()
  const now = Date.now()
  const sessions = next.sessions || []
  // 고른 세션이 빠졌거나 조용해졌으면 필터를 풀고 전체를 다시 그린다
  const filter = liveFilter(state.filter, sessions, now)
  const filterGone = filter !== state.filter
  if (next.reset) {
    const events = [...(next.events || [])].sort(byEventTime).slice(-MONITOR_ROWS)
    return commit({ sessions, events, filter, now }, 'bottom')
  }
  const fresh = next.events || []
  const last = state.events[state.events.length - 1]
  // 늦게 찾은 세션의 이전 줄이 섞이면 시각 순으로 다시 세워 그 자리를 지킨다
  const outOfOrder = Boolean(last) && fresh.some((event) => String(event.at) < String(last?.at))
  const events = [...state.events, ...fresh].sort(byEventTime).slice(-MONITOR_ROWS)
  commit({ sessions, events, filter, now }, outOfOrder || filterGone ? 'keep' : 'follow')
}

// 30초마다(보일 때만 — 바닐라 pane-layout.ts) · 'n분 전' 을 새로 쓰고 조용해진 에이전트의 칩을 뺀다(고른 칩이 빠지면 전체 로그로)
export function tick(): void {
  const state = view.get()
  const now = Date.now()
  commit({ ...state, filter: liveFilter(state.filter, state.sessions, now), now }, 'keep')
}

// 언어를 바꾼 뒤(main.ts applyLanguage) — 지금 언어로 바로 다시 그린다
export function refresh(): void {
  commit({ ...view.get(), now: Date.now() }, 'keep')
}

// 칩을 누르면 그 세션만 걸러 본다(다시 누르면 전체) — 맨 아래부터
function toggleFilter(sessionId: string): void {
  const state = view.get()
  commit({ ...state, filter: state.filter === sessionId ? null : sessionId, now: Date.now() }, 'bottom')
}

function sinceText(say: Say, ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return say('time.justNow')
  if (minutes < 60) return say('time.minutesAgo', { n: minutes })
  return say('time.hoursAgo', { n: Math.floor(minutes / 60) })
}

function sessionKind(say: Say, session: MonitorSession): string {
  if (session.pane) return say('monitor.paneSession')
  return session.finished ? say('monitor.subagentDone') : say('monitor.subagent')
}

// 머리줄 칩은 지금 작업 중인 에이전트만 — 없으면 비워 둔다(아래 로그는 그대로)
function SessionChips() {
  const say = useSay()
  const { sessions, filter, now } = useStore(view)
  return (
    <>
      {sessions
        .filter((session) => isLiveSession(session, now))
        .map((session) => {
          const since = sinceText(say, session.lastAt, now)
          return (
            <button
              key={session.id}
              className={`monitor-chip live${filter === session.id ? ' active' : ''}`}
              style={{ '--label-color': options.spaceColor(session.label) } as CSSProperties}
              title={say('monitor.sessionTitle', { label: session.label, kind: sessionKind(say, session), tools: session.tools, since })}
              onClick={() => toggleFilter(session.id)}
            >
              <span className="name">{session.label}</span>
              <span className="count">{`${session.tools} · ${since}`}</span>
            </button>
          )
        })}
    </>
  )
}

function monitorTime(at: string | null): string {
  const date = at ? new Date(at) : null
  if (!date || Number.isNaN(date.getTime())) return '--:--'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// 서브에이전트 보고(SubagentHandback)는 입력이 없어 main(agent-feed)이 고정 문구를 준다 — 화면 언어로 바꿔 보인다
const eventText = (say: Say, event: MonitorEvent) => (event.kind === 'tool' && event.name === 'SubagentHandback' ? say('monitor.finalReport') : event.text)

function Feed() {
  const say = useSay()
  const state = useStore(view)
  const events = shownEvents(state)
  if (!events.length) return <div className="monitor-empty">{state.sessions.length ? say('monitor.empty') : say('monitor.noAgents')}</div>
  const labels = new Map(state.sessions.map((session) => [session.id, session.label]))
  return (
    <>
      {events.map((event) => (
        <MonitorRow key={event.id} event={event} label={labels.get(event.session) ?? '?'} text={eventText(say, event)} />
      ))}
    </>
  )
}

function MonitorRow({ event, label, text }: { event: MonitorEvent; label: string; text: string }) {
  return (
    <div className={`monitor-row ${event.kind}`} style={{ '--label-color': options.spaceColor(label) } as CSSProperties} title={`${label} · ${event.name ? `${event.name} · ` : ''}${text}`}>
      <span className="monitor-time">{monitorTime(event.at)}</span>
      <span className="monitor-label">{`[${label}]`}</span>
      <span className="monitor-icon">{event.icon}</span>
      <span className="monitor-name">{event.name}</span>
      <span className="monitor-text">{text}</span>
    </div>
  )
}
