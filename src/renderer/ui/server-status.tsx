// 서버 탐색기 — 탭 줄 [서버] 버튼(늘 보임 · 상태 점 · 서버가 0개면 누를 때 등록 팝업)과 누르면 뜨는 앱 안 전체 화면 칸.
// 왼쪽 서버 목록(상태 점 · 이름 · 응답 · CPU/MEM/SWAP/DISK · 1시간 추이선) / 오른쪽 고른 서버의 경고 줄 · 2×2 그래프 · 상세.
// 읽기는 main(src/main/server-status.mts)이 코어 `ssh-run.sh <서버> --status`(허용 목록 안 고정 읽기 명령)와 이 맥의 응답 확인으로 — 여기서는 몇 분마다 부르고 그리기만.
// 칸을 닫아도 읽기는 계속 돈다(버튼 점이 맞게 바뀌도록). 서버 목록이 바뀌면 바닐라 space-actions.ts refreshServers 가 setServers 를 부른다
import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import { TwistyMark } from './explorer.tsx'
import type { Say } from './bridge.ts'
import { bucketHistory, bucketStart, HISTORY_RANGES, metricRows } from '../../lib/server-status.mts'
import type { ContainerRow, HistoryPoint, SarPoint, Pm2Row, PodRow, SupervisorRow, HistoryRange, MetricKey, ServerStatus, WebCheck } from '../../lib/server-status.mts'

type Healthy = Extract<ServerStatus, { ok: true }>
type Row = ServerEntry & { status: ServerStatus | null; web: WebCheck | null; at: number }
// sar — 서버 sysstat 기록(이 맥 기록이 빈 칸만 채운다 · 없으면 빈 목록)
type View = { rows: Row[]; history: Record<string, HistoryPoint[]>; sar: Record<string, SarPoint[]>; reading: boolean; selected: string }
const view = createStore<View>({ rows: [], history: {}, sar: {}, reading: false, selected: '' })
const rangeStore = createStore<{ range: HistoryRange }>({ range: '1h' })

// 칸이 열려 있을 때만 몇 분마다(사용자 결정 2026-11-09) — ssh 를 서버마다 한 번씩 여니 자주 돌리지 않는다.
// 닫혀 있으면 켤 때 · 서버 목록이 바뀔 때 한 번만 읽는다(버튼 점은 그 읽기 기준)
const POLL_MS = 3 * 60 * 1000

let button: HTMLButtonElement | null = null
let dot: HTMLElement | null = null
let viewBox: HTMLElement | null = null
let names = ''
let timer: ReturnType<typeof setInterval> | null = null
let reading = false
let readAt = 0
let addServer: () => void = () => {}

// 켤 때 한 번 — 칸에 띄워 두고 계속 쓴다(내리지 않는다). 점은 읽을 때마다 바뀐다
// add — 서버 등록 팝업(바닐라 space-actions.ts offerAddServer) · 0개일 때 버튼 · 칸 머리줄 [서버 추가]
export function mount(openButton: HTMLButtonElement, box: HTMLElement, add: () => void): void {
  button = openButton
  addServer = add
  viewBox = box
  dot = openButton.querySelector<HTMLElement>('.server-tool-dot')
  mountIsland(box, <ServerExplorer />)
  openButton.addEventListener('click', () => {
    if (!box.hidden) return close()
    if (view.get().rows.length) return open()
    addServer()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || box.hidden) return
    event.preventDefault()
    close()
  })
  view.subscribe(paintDot)
}

function open(): void {
  if (!viewBox || !button) return
  const rows = view.get().rows
  // 처음 열면 가장 나쁜 서버부터
  if (!rows.some((row) => row.name === view.get().selected)) view.set({ ...view.get(), selected: worstFirst(rows)[0]?.name ?? '' })
  viewBox.hidden = false
  startPolling()
  if (Date.now() - readAt >= POLL_MS) void readNow()
  button.classList.add('active')
  button.setAttribute('aria-expanded', 'true')
  viewBox.focus()
}

function close(): void {
  if (!viewBox || !button || viewBox.hidden) return
  viewBox.hidden = true
  stopPolling()
  button.classList.remove('active')
  button.setAttribute('aria-expanded', 'false')
  button.focus()
}

// 버튼 점 — 정상이면 없음 · 경고 노랑 · 연결/서비스 실패 빨강
function paintDot(): void {
  if (!dot) return
  const level = overallLevel(view.get().rows)
  dot.hidden = level === 'ok' || level === 'unknown'
  dot.className = `server-tool-dot ${level}`
}

// 팩 서버 목록 — 바뀌었을 때만 다시 맞추고 곧바로 한 번 읽는다
export function setServers(list: ServerEntry[]): void {
  const next = list.map((server) => `${server.name}=${server.host}`).join(',')
  if (next === names) return
  names = next
  const old = new Map(view.get().rows.map((row) => [row.name, row]))
  const rows = list.map((server): Row => {
    const before = old.get(server.name)
    return before?.host === server.host ? { ...before, ...server } : { ...server, status: null, web: null, at: 0 }
  })
  view.set({ ...view.get(), rows })
  const has = list.length > 0
  if (!has) close()
  if (has) void readNow()
}

function startPolling(): void {
  stopPolling()
  timer = setInterval(() => void readNow(), POLL_MS)
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function readNow(): Promise<void> {
  if (reading) return
  reading = true
  readAt = Date.now()
  view.set({ ...view.get(), reading: true })
  try {
    const reply = await studio.serverStatus()
    const found = new Map(reply.servers.map((server) => [server.name, server]))
    view.set({ ...view.get(), reading: false, history: reply.history, sar: reply.sar ?? {}, rows: view.get().rows.map((row) => found.get(row.name) || row) })
  } catch {
    view.set({ ...view.get(), reading: false })
  } finally {
    reading = false
  }
}

// ── 판정 — 숫자 색: 80% 넘으면 노랑 · 90% 넘으면 빨강. 서버 하나의 수준은 경고 줄에서 가장 나쁜 것
// 빨강 = 연결 실패 · 실패한 systemd 서비스 · 응답 5xx · 응답 확인 실패 / 노랑 = 꺼진 컨테이너(일부러 멈췄을 수 있다) · 디스크 · 메모리 80% · SWAP 50% · 느린 응답 1초 · 인증서 14일 · 보안 업데이트 10개 · 에러 로그 20건
type Level = 'ok' | 'warn' | 'fail' | 'unknown'
type Warning = { level: 'warn' | 'fail'; text: string }
const percentText = (value: number | null) => (value === null ? '–' : `${value}%`)
const meterLevel = (value: number | null) => {
  if (value === null) return ''
  if (value > 90) return 'high'
  return value > 80 ? 'warn' : ''
}

function warningsOf(row: Row, say: Say): Warning[] {
  const status = row.status
  if (!status) return []
  if (!status.ok) return [{ level: 'fail', text: say(`server.reason.${status.reason}`) }]
  const list: Warning[] = []
  const web = row.web
  if (status.failed.length) list.push({ level: 'fail', text: say('server.warn.failed', { names: status.failed.join(', ') }) })
  if (web && !web.ok) list.push({ level: 'fail', text: say('server.warn.web', { reason: say(`server.web.${web.reason}`) }) })
  if (web?.ok && web.code >= 500) list.push({ level: 'fail', text: say('server.warn.http', { code: web.code }) })
  if (status.docker?.down.length) list.push({ level: 'warn', text: say('server.warn.dockerDown', { names: status.docker.down.join(', ') }) })
  for (const disk of status.disks) if (disk.percent > 80) list.push({ level: 'warn', text: say('server.warn.disk', { mount: disk.mount, percent: disk.percent }) })
  if (!status.disks.length && (status.diskPercent ?? 0) > 80) list.push({ level: 'warn', text: say('server.warn.disk', { mount: '/', percent: status.diskPercent ?? 0 }) })
  if ((status.memPercent ?? 0) > 80) list.push({ level: 'warn', text: say('server.warn.mem', { percent: status.memPercent ?? 0 }) })
  if ((status.swapPercent ?? 0) > 50) list.push({ level: 'warn', text: say('server.warn.swap', { percent: status.swapPercent ?? 0 }) })
  if (web?.ok && web.code < 500 && web.ms > 1000) list.push({ level: 'warn', text: say('server.warn.slow', { ms: web.ms }) })
  if (web?.ok && web.certDays !== null && web.certDays < 14) list.push({ level: 'warn', text: web.certDays < 0 ? say('server.warn.certGone') : say('server.warn.cert', { days: web.certDays }) })
  if ((status.updates ?? 0) > 10) list.push({ level: 'warn', text: say('server.warn.updates', { count: status.updates ?? 0 }) })
  if ((status.errors ?? 0) > 20) list.push({ level: 'warn', text: say('server.warn.errors', { count: status.errors ?? 0 }) })
  return list
}
// 수준만 보는 곳(점 · 정렬)은 문구가 필요 없다
const quiet: Say = (key) => key
function levelOf(row: Row): Level {
  if (!row.status) return 'unknown'
  const levels = warningsOf(row, quiet).map((warning) => warning.level)
  if (levels.includes('fail')) return 'fail'
  return levels.length ? 'warn' : 'ok'
}
function overallLevel(rows: Row[]): Level {
  const levels = rows.map(levelOf)
  if (levels.includes('fail')) return 'fail'
  if (levels.includes('warn')) return 'warn'
  return levels.includes('ok') ? 'ok' : 'unknown'
}
// 사이드바 servers 줄 배지 — 가장 심한 이유 하나(text · 연결 실패면 "연결 실패") + 나머지 수(more · 줄임표에 묻히지 않게 따로) · 정상 · 읽기 전이면 빈 글
export function useServerBrief(name: string, say: Say): { level: Level; text: string; more: string } {
  const state = useStore(view)
  const row = state.rows.find((item) => item.name === name)
  if (!row?.status) return { level: 'unknown', text: '', more: '' }
  if (!row.status.ok) return { level: 'fail', text: say('server.level.down'), more: '' }
  const list = warningsOf(row, say)
  const worst = list.find((warning) => warning.level === 'fail') ?? list[0]
  if (!worst) return { level: 'ok', text: '', more: '' }
  return { level: worst.level, text: worst.text, more: list.length > 1 ? say('server.badge.more', { count: list.length - 1 }) : '' }
}
const RANK: Record<Level, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 }
const worstFirst = (rows: Row[]) => [...rows].sort((left, right) => RANK[levelOf(left)] - RANK[levelOf(right)])
function levelLabel(row: Row, say: Say): string {
  const level = levelOf(row)
  if (level === 'unknown') return say('server.reading')
  if (level === 'fail') return say(row.status?.ok ? 'server.level.service' : 'server.level.down')
  return say(`server.level.${level}`)
}

// 시각 — 오늘이면 시:분:초, 아니면 월/일 시:분
const timeText = (at: number) => {
  if (!at) return '—'
  const date = new Date(at)
  const clock = date.toTimeString().slice(0, 8)
  return date.toDateString() === new Date().toDateString() ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock.slice(0, 5)}`
}
function uptimeText(seconds: number | null, say: Say): string {
  if (seconds === null) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return days > 0 ? say('server.days', { days, hours }) : say('server.hours', { hours, minutes: Math.floor((seconds % 3600) / 60) })
}
function webText(web: WebCheck | null, say: Say): string {
  if (!web) return '—'
  return web.ok ? `${web.code} · ${web.ms} ms` : say(`server.web.${web.reason}`)
}
const webLevel = (web: WebCheck | null) => {
  if (!web) return ''
  if (!web.ok || web.code >= 500) return 'high'
  return web.code >= 400 || web.ms > 1000 ? 'warn' : ''
}
function certText(web: WebCheck | null, say: Say): string {
  if (!web?.ok || web.certDays === null || web.certDate === null) return '—'
  return say('server.certValue', { date: web.certDate, days: web.certDays })
}

// ── 칸 전체
function ServerExplorer() {
  const say = useSay()
  const state = useStore(view)
  const counts = { ok: 0, warn: 0, fail: 0 }
  for (const row of state.rows) {
    const level = levelOf(row)
    if (level !== 'unknown') counts[level] += 1
  }
  const picked = state.rows.find((row) => row.name === state.selected) ?? state.rows[0]
  const refreshTitle = say('server.refresh')
  const closeTitle = say('server.close')
  return (
    <div className="sx">
      <header className="sx-head">
        <span className="sx-title">{say('server.heading')}</span>
        <span className="sx-count">{say('server.count', { count: state.rows.length })}</span>
        <span className="sx-sum"><i className="server-dot ok" />{say('server.level.ok')} {counts.ok}</span>
        <span className="sx-sum"><i className="server-dot warn" />{say('server.level.warn')} {counts.warn}</span>
        <span className="sx-sum"><i className="server-dot fail" />{say('server.level.fail')} {counts.fail}</span>
        <span className="sx-gap" />
        <button className="sx-add" onClick={() => addServer()}>
          {say('server.add')}
        </button>
        <button className={`sx-icon ${state.reading ? 'spinning' : ''}`} title={refreshTitle} aria-label={refreshTitle} disabled={state.reading} onClick={() => void readNow()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" /></svg>
        </button>
        <button className="sx-icon" title={closeTitle} aria-label={closeTitle} onClick={close}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div className="sx-body">
        <nav className="sx-list">
          {state.rows.map((row) => (
            <ServerCard key={row.name} row={row} points={state.history[row.name] ?? []} fill={state.sar[row.name] ?? []} picked={row.name === picked?.name} say={say} />
          ))}
        </nav>
        {picked && <ServerDetail row={picked} points={state.history[picked.name] ?? []} fill={state.sar[picked.name] ?? []} say={say} />}
      </div>
    </div>
  )
}

function ServerCard({ row, points, fill, picked, say }: { row: Row; points: HistoryPoint[]; fill: SarPoint[]; picked: boolean; say: Say }) {
  const status = row.status
  const level = levelOf(row)
  return (
    <button className={`sx-card ${picked ? 'picked' : ''}`} onClick={() => view.set({ ...view.get(), selected: row.name })}>
      <span className="sx-card-line">
        <span className={`server-dot ${level}`} aria-hidden="true" />
        <span className="sx-name">{row.name}</span>
        <span className={`sx-state ${level}`}>{levelLabel(row, say)}</span>
      </span>
      {status?.ok ? (
        <>
          <span className="sx-card-line">
            {/* 웹 주소가 없는 서버는 응답 글을 빼고 추이선만 */}
            {row.web && <span className={`sx-health ${webLevel(row.web)}`}>{webText(row.web, say)}</span>}
            <span className="sx-gap" />
            <Spark points={points} fill={fill} />
          </span>
          <span className="sx-card-line sx-meters">
            <Meter label="CPU" value={status.cpuPercent} />
            <Meter label="MEM" value={status.memPercent} />
            {status.swapPercent !== null && <Meter label="SWAP" value={status.swapPercent} />}
            <Meter label="DISK" value={status.diskPercent} />
          </span>
        </>
      ) : (
        <span className={`sx-card-line sx-reason ${status ? 'fail' : ''}`}>{status ? say(`server.reason.${status.reason}`) : say('server.reading')}</span>
      )}
      <span className="sx-card-line sx-dim">
        {status?.ok && status.uptimeSeconds !== null && <span>{say('server.uptime', { time: uptimeText(status.uptimeSeconds, say) })}</span>}
        <span className="sx-gap" />
        {row.at > 0 && <span>{say('server.readAt', { time: timeText(row.at) })}</span>}
      </span>
    </button>
  )
}

function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <span className={`sx-meter ${meterLevel(value)}`}>
      <span className="sx-meter-label">{label}</span>
      <span>{percentText(value)}</span>
      <span className="sx-meter-track"><span style={{ width: `${value ?? 0}%` }} /></span>
    </span>
  )
}

// 상세 칸(디스크 · 서비스와 컨테이너 · 응답과 보안) — 그 서버에 없는 것(웹 주소 · apt · journalctl · systemd · docker · 마운트 하나)은 줄째 · 카드째 뺀다
function detailCards(row: Row, status: Healthy, say: Say): { key: string; title: string; body: ReactNode }[] {
  const web = row.web
  const cards: { key: string; title: string; rows: ReactNode[] }[] = []
  // 마운트가 하나면 위 디스크 카드와 같으니 뺀다
  if (status.disks.length > 1) {
    cards.push({ key: 'disks', title: say('server.box.disks'), rows: status.disks.map((disk) => (
      <div className="sx-disk" key={disk.mount}>
        <span className="sx-disk-mount" title={disk.mount}>{disk.mount}</span>
        <span className="sx-meter-track wide"><span className={meterLevel(disk.percent)} style={{ width: `${disk.percent}%` }} /></span>
        <span className={`sx-disk-value ${meterLevel(disk.percent)}`}>{disk.percent}%</span>
      </div>
    )) })
  }
  const services: ReactNode[] = []
  if (status.running !== null) {
    services.push(<Item key="failed" label={say('server.failedServices')} value={status.failed.length ? status.failed.join(', ') : say('server.none')} level={status.failed.length ? 'fail' : 'dim'} />)
    services.push(<Item key="running" label={say('server.runningServices')} value={say('server.countValue', { count: status.running })} />)
  }
  if (status.docker) {
    services.push(<Item key="docker" label="docker" value={say('server.dockerValue', { up: status.docker.up, total: status.docker.total })} />)
    services.push(<Item key="error" label={say('server.errorContainers')} value={status.docker.down.length ? status.docker.down.join(', ') : say('server.none')} level={status.docker.down.length ? 'warn' : 'dim'} />)
    services.push(<Item key="stopped" label={say('server.stoppedContainers')} value={status.docker.stopped.length ? status.docker.stopped.join(', ') : say('server.none')} level="dim" />)
  }
  cards.push({ key: 'services', title: status.docker ? say('server.box.services') : say('server.box.servicesOnly'), rows: services })
  const security: ReactNode[] = []
  if (web) {
    security.push(<Item key="web" label={say('server.response')} value={webText(web, say)} level={webLevel(web) === 'high' ? 'fail' : webLevel(web)} />)
    security.push(<Item key="cert" label={say('server.cert')} value={certText(web, say)} level={web.ok && web.certDays !== null && web.certDays < 14 ? 'warn' : ''} />)
  }
  if (status.updates !== null) security.push(<Item key="updates" label={say('server.updates')} value={say('server.countValue', { count: status.updates })} level={status.updates > 10 ? 'warn' : ''} />)
  if (status.errors !== null) security.push(<Item key="errors" label={say('server.errors')} value={say('server.errorsValue', { count: status.errors })} level={status.errors > 20 ? 'warn' : ''} />)
  cards.push({ key: 'security', title: web ? say('server.box.security') : say('server.box.securityOnly'), rows: security })
  return cards.filter((card) => card.rows.length > 0).map((card) => ({ key: card.key, title: card.title, body: card.rows }))
}

function ServerDetail({ row, points, fill, say }: { row: Row; points: HistoryPoint[]; fill: SarPoint[]; say: Say }) {
  const status = row.status
  const warnings = warningsOf(row, say)
  const worst = warnings.some((warning) => warning.level === 'fail') ? 'fail' : 'warn'
  const lastOk = points[points.length - 1]?.t ?? 0
  return (
    <section className="sx-main">
      {warnings.length > 0 && (
        <div className={`sx-banner ${worst}`}>
          {warnings.map((warning) => (
            <span key={warning.text} className={`sx-banner-item ${warning.level}`}>{warning.text}</span>
          ))}
        </div>
      )}
      <HistoryCharts row={row} points={points} fill={fill} say={say} />
      {status?.ok ? (
        <>
        <div className="sx-details wide">
          {detailCards(row, status, say).map((card, index, list) => (
            <Card key={card.key} title={card.title} span={spanOf(index, list.length)}>{card.body}</Card>
          ))}
        </div>
        <MoreTables status={status} say={say} />
        </>
      ) : (
        <div className="sx-details wide">
          <Card title={say('server.box.now')} span={12}>
            <Item label={say('server.why')} value={status ? say(`server.reason.${status.reason}`) : say('server.reading')} level={status ? 'fail' : 'dim'} />
            <Item label={say('server.lastOk')} value={timeText(lastOk)} />
            <Item label={say('server.tried')} value={timeText(row.at)} />
          </Card>
        </div>
      )}
      <p className="sx-foot">{say('server.readAt', { time: timeText(row.at) })} · {say(fill.length ? 'server.footSar' : 'server.foot')}</p>
    </section>
  )
}

// 컨테이너(Compose 프로젝트별) · 무거운 프로세스 · systemd 서비스 — 문제 있는 것을 맨 위로
const CONTAINER_ORDER: Record<ContainerRow['state'], number> = { down: 0, stopped: 1, up: 2 }
type ProjectState = 'error' | 'partial' | 'stopped' | 'running'
const PROJECT_ORDER: Record<ProjectState, number> = { error: 0, partial: 1, stopped: 2, running: 3 }
// 컨테이너 상태도 프로젝트와 같은 말 · 같은 아이콘으로
const CONTAINER_STATE: Record<ContainerRow['state'], ProjectState> = { up: 'running', stopped: 'stopped', down: 'error' }
type Project = { key: string; name: string | null; state: ProjectState; containers: ContainerRow[]; cpu: number; mem: number }

// 상태는 아이콘만 — 글은 title · aria-label 로(실행 중 체크 · 중지됨 정지 · 오류 느낌표 · 일부 중지 반쯤)
function StateIcon({ state, label }: { state: ProjectState; label: string }) {
  return (
    <svg className={`sx-st sx-st-${state}`} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx="8" cy="8" r="7" />
      {state === 'running' && <path d="M4.8 8.3l2.2 2.2 4.2-4.6" />}
      {state === 'stopped' && <rect x="5.5" y="5.5" width="5" height="5" rx="0.5" />}
      {state === 'error' && <path d="M8 4.5v4.2M8 11.2v0.3" />}
      {state === 'partial' && <path d="M8 1a7 7 0 0 1 0 14z" />}
    </svg>
  )
}

function projectState(containers: ContainerRow[]): ProjectState {
  if (containers.some((item) => item.state === 'down')) return 'error'
  const running = containers.filter((item) => item.state === 'up').length
  if (running === containers.length) return 'running'
  return running === 0 ? 'stopped' : 'partial'
}

// 라벨로 묶고 따로 띄운 컨테이너는 한 묶음으로 — 문제 있는 묶음 먼저, 같으면 이름 순
function groupProjects(containers: ContainerRow[]): Project[] {
  const groups = new Map<string, ContainerRow[]>()
  for (const item of containers) {
    const key = item.project ?? ''
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups].map(([key, items]) => ({
    key,
    name: key || null,
    state: projectState(items),
    containers: [...items].sort((left, right) => CONTAINER_ORDER[left.state] - CONTAINER_ORDER[right.state]),
    cpu: items.reduce((sum, item) => sum + (item.stats?.cpu ?? 0), 0),
    mem: items.reduce((sum, item) => sum + (item.stats?.memUsed ?? 0), 0),
  })).sort((left, right) => PROJECT_ORDER[left.state] - PROJECT_ORDER[right.state]
    || Number(left.name === null) - Number(right.name === null)
    || (left.name ?? '').localeCompare(right.name ?? ''))
}

// 돌고 있는 앱 — 서버에 있는 것만 묶음으로(Docker · Podman 프로젝트 · kubectl 파드 · supervisor · pm2 · 못 읽은 도구 · 무거운 프로세스 · 그 밖 systemd 서비스)
// 비어 있는 표는 숨긴다(도구가 있어도 앱이 0개면)
function MoreTables({ status, say }: { status: Healthy; say: Say }) {
  const services = status.services ?? []
  const failed = status.failed
  const hasServices = services.length > 0 || failed.length > 0
  const more = { containers: status.containers, podman: status.podman?.length ? status.podman : null, pods: status.pods ?? [], supervisor: status.supervisor ?? [], pm2: status.pm2 ?? [], detected: status.detected, top: status.top }
  const apps = more.pods.length + more.supervisor.length + more.pm2.length
  if (!more.containers && !more.podman && !apps && !more.detected.length && !more.top.length && !hasServices) return null
  return (
    <div className="sx-tables">
      {more.containers && <DockerTable containers={more.containers} title="server.box.projects" say={say} />}
      {more.podman && <DockerTable containers={more.podman} title="server.box.podman" say={say} />}
      {more.pods.length > 0 && <PodTable pods={more.pods} say={say} />}
      {more.pm2.length > 0 && <Pm2Table apps={more.pm2} say={say} />}
      {more.supervisor.length > 0 && <SupervisorTable programs={more.supervisor} say={say} />}
      {more.detected.length > 0 && (
        <div className="sx-span">
          <Card title={say('server.box.detected')}>
            {more.detected.map((name) => <Item key={name} label={name} value={say('server.detectedValue')} level="dim" />)}
          </Card>
        </div>
      )}
      {more.top.length > 0 && (
        <div className={hasServices ? '' : 'sx-span'}>
          <Card title={say('server.box.processes')}>
            <table className="sx-table">
              <thead><tr><th>{say('server.col.name')}</th><th className="num">CPU</th><th className="num">MEM</th></tr></thead>
              <tbody>
                {more.top.map((item) => (
                  <tr key={item.name}>
                    <td title={item.name}>{item.name}</td>
                    <td className={`num sx-cell-${meterLevel(item.cpu) || 'plain'}`}>{item.cpu.toFixed(1)}%</td>
                    <td className={`num sx-cell-${meterLevel(item.mem) || 'plain'}`}>{item.mem.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
      {hasServices && (
        <div className={more.top.length ? '' : 'sx-span'}>
          <Card title={say(more.containers ? 'server.box.serviceOther' : 'server.box.serviceList', { running: services.length, failed: failed.length })}>
            <div className="sx-chips">
              {failed.map((name) => <span key={name} className="sx-chip fail">{name}</span>)}
              {services.map((name) => <span key={name} className="sx-chip">{name}</span>)}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

// 문제 있는 것 먼저(오류 · 일부 중지 · 중지됨 · 실행 중), 같으면 이름 순
const appOrder = <T extends { name: string; state: ProjectState }>(rows: T[]) => [...rows].sort((left, right) => PROJECT_ORDER[left.state] - PROJECT_ORDER[right.state] || left.name.localeCompare(right.name))
const stateCell = (row: { state: ProjectState; reason: string }, say: Say) => <StateIcon state={row.state} label={`${say(`server.project.${row.state}`)} · ${row.reason}`} />
const restartText = (value: number | null) => (value === null ? '—' : String(value))

// kubectl get pods -A — 이름 · 네임스페이스 · 상태 · 재시작
function PodTable({ pods, say }: { pods: PodRow[]; say: Say }) {
  return (
    <div className="sx-span">
      <Card title={say('server.box.pods', { count: pods.length })}>
        <div className="sx-table-scroll">
          <table className="sx-table">
            <thead><tr><th>{say('server.col.name')}</th><th>{say('server.col.namespace')}</th><th>{say('server.col.state')}</th><th className="num">{say('server.col.restarts')}</th></tr></thead>
            <tbody>
              {appOrder(pods).map((pod) => (
                <tr key={`${pod.namespace}/${pod.name}`}>
                  <td title={pod.name}>{pod.name}</td>
                  <td className="sx-cell-dim" title={pod.namespace}>{pod.namespace}</td>
                  <td>{stateCell(pod, say)}</td>
                  <td className="num">{restartText(pod.restarts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// pm2 ls — 이름 · 상태 · CPU · 메모리 · 재시작
function Pm2Table({ apps, say }: { apps: Pm2Row[]; say: Say }) {
  return (
    <div className="sx-span">
      <Card title={say('server.box.pm2', { count: apps.length })}>
        <div className="sx-table-scroll">
          <table className="sx-table">
            <thead><tr><th>{say('server.col.name')}</th><th>{say('server.col.state')}</th><th className="num">CPU</th><th className="num">{say('server.col.mem')}</th><th className="num">{say('server.col.restarts')}</th></tr></thead>
            <tbody>
              {appOrder(apps).map((app) => (
                <tr key={app.name}>
                  <td title={app.name}>{app.name}</td>
                  <td>{stateCell(app, say)}</td>
                  <td className={`num sx-cell-${meterLevel(app.cpu) || 'plain'}`}>{app.cpu === null ? '—' : `${app.cpu.toFixed(1)}%`}</td>
                  <td className="num">{app.mem === null ? '—' : sizeText(app.mem)}</td>
                  <td className="num">{restartText(app.restarts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// supervisorctl status — 이름 · 상태
function SupervisorTable({ programs, say }: { programs: SupervisorRow[]; say: Say }) {
  return (
    <div className="sx-span">
      <Card title={say('server.box.supervisor', { count: programs.length })}>
        <div className="sx-table-scroll">
          <table className="sx-table">
            <thead><tr><th>{say('server.col.name')}</th><th>{say('server.col.state')}</th></tr></thead>
            <tbody>
              {appOrder(programs).map((program) => (
                <tr key={program.name}>
                  <td title={program.name}>{program.name}</td>
                  <td>{stateCell(program, say)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// Docker · Podman 같은 꼴 — title 은 머리 문구 키
function DockerTable({ containers, title, say }: { containers: ContainerRow[]; title: 'server.box.projects' | 'server.box.podman'; say: Say }) {
  const projects = groupProjects(containers)
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const toggle = (key: string) => setClosed((before) => {
    const next = new Set(before)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  return (
      <div className="sx-span">
        <Card title={say(title, { count: projects.filter((project) => project.name !== null).length, containers: containers.length })}>
          <div className="sx-table-scroll">
            <table className="sx-table sx-containers">
              <colgroup>
                <col className="c-name" /><col className="c-image" /><col className="c-state" /><col className="c-cpu" /><col className="c-mem" /><col className="c-io" /><col className="c-io" />
              </colgroup>
              <thead>
                <tr>
                  <th>{say('server.col.name')}</th>
                  <th>{say('server.col.image')}</th>
                  <th>{say('server.col.state')}</th>
                  <th className="num">CPU</th>
                  <th className="num">{say('server.col.mem')}</th>
                  <th className="num">{say('server.col.net')}</th>
                  <th className="num">{say('server.col.block')}</th>
                </tr>
              </thead>
              {projects.map((project) => {
                const open = !closed.has(project.key)
                const anyRunning = project.containers.some((item) => item.stats)
                return (
                  <tbody key={project.key} className="sx-project">
                    <tr className="sx-project-row" onClick={() => toggle(project.key)} aria-expanded={open}>
                      <td colSpan={2} title={project.name ?? ''}>
                        <TwistyMark state={open ? 'open' : 'closed'} />
                        <span className="sx-project-name">{project.name ?? say('server.project.standalone')}</span>
                        <span className="sx-cell-dim">{say('server.project.count', { count: project.containers.length })}</span>
                      </td>
                      <td><StateIcon state={project.state} label={say(`server.project.${project.state}`)} /></td>
                      <td className="num">{anyRunning ? `${project.cpu.toFixed(1)}%` : '—'}</td>
                      <td className="num">{anyRunning ? sizeText(project.mem) : '—'}</td>
                      <td /><td />
                    </tr>
                    {open && project.containers.map((item) => (
                      <tr key={item.name} className="sx-container-row">
                        <td className="sx-indent" title={item.name}>{item.name}</td>
                        <td className="sx-cell-dim" title={item.image}>{item.image}</td>
                        <td><StateIcon state={CONTAINER_STATE[item.state]} label={say(`server.project.${CONTAINER_STATE[item.state]}`)} /></td>
                        <td className={`num sx-cell-${(item.stats && meterLevel(item.stats.cpu)) || 'plain'}`}>{item.stats ? `${item.stats.cpu.toFixed(1)}%` : '—'}</td>
                        <td className={`num sx-cell-${(item.stats && meterLevel(item.stats.memPercent)) || 'plain'}`} title={item.stats ? `${sizeText(item.stats.memUsed)} / ${sizeText(item.stats.memLimit)} · ${item.stats.memPercent}%` : ''}>{item.stats ? sizeText(item.stats.memUsed) : '—'}</td>
                        <td className="num">{item.stats ? `${sizeText(item.stats.rx)} / ${sizeText(item.stats.tx)}` : '—'}</td>
                        <td className="num">{item.stats ? `${sizeText(item.stats.read)} / ${sizeText(item.stats.write)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                )
              })}
            </table>
          </div>
        </Card>
      </div>
  )
}

// 바이트 → MB · GB(서버 정보 · 컨테이너 표 — 단위는 이 둘만)
function bytesText(value: number | null): string {
  if (value === null) return '—'
  if (value === 0) return '0'
  return sizeText(value)
}

function sizeText(value: number): string {
  if (value === 0) return '0 MB'
  const gb = value / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`
  const mb = value / 1024 ** 2
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
}

// 12칸 격자에서 차지할 칸 수 — 한 줄 칸 수는 장 수로(4장까지 한 줄 · 5 · 6장 3칸 · 7 · 8장 4칸), 마지막 줄은 남은 장끼리 나눠 빈자리 없이
function perRowOf(count: number): number {
  if (count <= 4) return Math.max(1, count)
  if (count <= 6) return 3
  return 4
}

function spanOf(index: number, count: number): number {
  const perRow = perRowOf(count)
  const rest = count % perRow
  if (rest === 0 || index < count - rest) return 12 / perRow
  return 12 / rest
}

function Card({ title, span, children }: { title: string; span?: number; children: ReactNode }) {
  return (
    <div className="sx-box" style={span ? { gridColumn: `span ${span}` } : undefined}>
      <div className="sx-box-title">{title}</div>
      {children}
    </div>
  )
}

function Item({ label, value, level = '' }: { label: string; value: string; level?: string }) {
  return (
    <div className="sx-item">
      <span className="sx-item-label">{label}</span>
      <span className={`sx-item-value ${level}`}>{value}</span>
    </div>
  )
}

// ── 시간 그래프 — 서버마다 따로. 칸마다 평균 · 기록이 없는 칸(맥이 꺼졌던 때 등)은 선을 끊고 빈 칸으로 보인다
// 값 목록을 SVG 길로 — null 이면 선을 끊고, 앞뒤가 비어 혼자 남은 점은 짧은 가로선으로
function linePath(values: (number | null)[], width: number, height: number, max: number): string {
  const step = values.length > 1 ? width / (values.length - 1) : width
  const yOf = (value: number) => (height - (Math.min(value, max) / max) * height).toFixed(1)
  let path = ''
  values.forEach((value, index) => {
    if (value === null) return
    const x = index * step
    const before = index > 0 ? values[index - 1] : null
    const after = index < values.length - 1 ? values[index + 1] : null
    if (before === null || before === undefined) {
      path += `M${x.toFixed(1)},${yOf(value)} `
      if (after === null || after === undefined) path += `L${Math.min(width, x + step / 2).toFixed(1)},${yOf(value)} `
    } else path += `L${x.toFixed(1)},${yOf(value)} `
  })
  return path
}
// 빈 칸 — 값이 null 인 연속 구간마다 한 칸
function gapBoxes(values: (number | null)[], width: number) {
  const step = width / Math.max(1, values.length - 1)
  const boxes: { x: number; w: number }[] = []
  let from = -1
  values.forEach((value, index) => {
    if (value === null && from < 0) from = index
    if ((value !== null || index === values.length - 1) && from >= 0) {
      const to = value === null ? index : index - 1
      // 칸 i 는 x = i·step 에서 앞뒤 반 칸씩 — 양 끝은 그래프 폭 안으로 자른다(자르지 않으면 overflow: visible 인 svg 가 카드 밖으로 넘친다)
      const left = Math.max(0, (from - 0.5) * step)
      const right = Math.min(width, (to + 0.5) * step)
      boxes.push({ x: left, w: right - left })
      from = -1
    }
  })
  return boxes
}

// 목록 카드의 1시간 추이 — CPU · MEM 두 선(색은 style.css --metric-*)
function Spark({ points, fill }: { points: HistoryPoint[]; fill: SarPoint[] }) {
  const width = 64
  const height = 16
  const series = bucketHistory(points, '1h', Date.now(), fill)
  return (
    <svg className="sv-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path className="sv-line sv-c-mem" d={linePath(series.mem, width, height, 100)} />
      <path className="sv-line sv-c-cpu" d={linePath(series.cpu, width, height, 100)} />
    </svg>
  )
}

// 마우스를 올린 칸의 값 — 카드 단위 그대로(% · 부하 · MB/GB · ms)
function pointText(metric: string): (value: number) => string {
  if (metric === 'load') return (value) => value.toFixed(2)
  if (metric === 'rx' || metric === 'tx') return (value) => bytesSize(value)
  if (metric === 'ms') return (value) => `${Math.round(value)} ms`
  return (value) => `${Math.round(value)}%`
}

// 그래프 시각 — 오늘이면 시:분, 아니면 월/일 시:분
const pointTime = (at: number) => {
  const date = new Date(at)
  const clock = date.toTimeString().slice(0, 5)
  return date.toDateString() === new Date().toDateString() ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

// 본문 카드 추이선에 마우스를 올리면 가장 가까운 칸에 세로 안내선 · 점 · 작은 말풍선(시각 · 값). 선 좌표는 linePath 와 같다(칸 i → 폭의 i/(n−1))
// 말풍선은 그래프 안 점 옆에 — 오른쪽 절반이면 왼쪽으로 뒤집어 카드 밖으로 안 나가게
type HoverLine = { metric: string; values: (number | null)[]; max: number }
type Hovered = { index: number; ratio: number }
function ChartHover({ className, line, timeOf, children }: { className: string; line: HoverLine; timeOf: (index: number) => number; children: ReactNode }) {
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const count = line.values.length
  const move = (event: MouseEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (count < 1 || rect.width <= 0) return
    const index = count > 1 ? Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * (count - 1)) : 0
    setHovered({ index, ratio: count > 1 ? index / (count - 1) : 0 })
  }
  const value = hovered ? line.values[hovered.index] : null
  const left = hovered ? `${hovered.ratio * 100}%` : '0'
  return (
    <span className={`sx-hover ${className}`} onMouseMove={move} onMouseLeave={() => setHovered(null)}>
      {children}
      {hovered && (
        <>
          <span className="sx-hover-guide" style={{ left }} />
          {value !== null && value !== undefined && (
            <span className={`sx-hover-dot sv-dot sv-c-${line.metric}`} style={{ left, top: `${100 - (Math.min(value, line.max) / line.max) * 100}%` }} />
          )}
          <span className={`sx-hover-tip ${hovered.ratio > 0.5 ? 'flip' : ''}`} style={{ left }}>
            <span className="sx-hover-time">{pointTime(timeOf(hovered.index))}</span>
            <span>{value === null || value === undefined ? '—' : pointText(line.metric)(value)}</span>
          </span>
        </>
      )}
    </span>
  )
}

const RANGE_KEYS = Object.keys(HISTORY_RANGES) as HistoryRange[]

// 면 채움 — 끊긴 구간마다 선 아래를 바닥까지 닫는다
function areaPath(values: (number | null)[], width: number, height: number, max: number): string {
  const step = values.length > 1 ? width / (values.length - 1) : width
  const yOf = (value: number) => (height - (Math.min(value, max) / max) * height).toFixed(1)
  let path = ''
  let start = -1
  values.forEach((value, index) => {
    if (value !== null && start < 0) start = index
    const ends = value !== null && (index === values.length - 1 || values[index + 1] === null)
    if (!ends) return
    const run = values.slice(start, index + 1) as number[]
    if (run.length > 1) path += `M${(start * step).toFixed(1)},${height} ` + run.map((item, offset) => `L${((start + offset) * step).toFixed(1)},${yOf(item)}`).join(' ') + ` L${(index * step).toFixed(1)},${height} Z `
    start = -1
  })
  return path
}

function bytesSize(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 100 * 1024 ** 3 ? 0 : 1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(value / 1024)} KB`
}

function msText(value: number | undefined, failing: boolean, say: Say): string {
  if (value === undefined) return '—'
  return failing ? say('server.lastValue', { value: `${Math.round(value)} ms` }) : `${Math.round(value)} ms`
}

type MetricCard = { key: MetricKey; title: string; value: string; total?: string; note?: string; level: string; line?: { metric: string; values: (number | null)[]; max: number }; ring?: number }

// 위쪽 카드 — 제목 · 큰 숫자 · 작은 줄 · 오른쪽 추이선(면 채움). 디스크는 고리. 연결 실패면 마지막 값을 흐리게 · 응답 주소 · 기록 없는 응답 카드는 숨김
// 서버 정보 — 머리줄 아래 한 줄 칩(없는 값은 칩째 숨김)
function InfoChips({ status, at, say }: { status: Healthy; at: number; say: Say }) {
  const chips: { key: string; label: string; value: string }[] = []
  if (status.os) chips.push({ key: 'os', label: say('server.os'), value: status.os })
  if (status.kernel) chips.push({ key: 'kernel', label: say('server.kernel'), value: status.kernel })
  if (status.cpus !== null) chips.push({ key: 'cores', label: say('server.cores'), value: say('server.countValue', { count: status.cpus }) })
  if (status.memTotal) chips.push({ key: 'mem', label: say('server.memTotal'), value: bytesText(status.memTotal) })
  if (status.swapTotal) chips.push({ key: 'swap', label: 'SWAP', value: bytesText(status.swapTotal) })
  // 최근 재부팅 = 읽은 시각 − 켜진 시간(명령을 더 부르지 않는다)
  if (status.uptimeSeconds !== null && at > 0) chips.push({ key: 'boot', label: say('server.lastBoot'), value: timeText(at - status.uptimeSeconds * 1000) })
  if (!chips.length) return null
  return (
    <div className="sx-info">
      {chips.map((chip) => (
        <span key={chip.key} className="sx-info-chip"><span className="sx-info-label">{chip.label}</span>{chip.value}</span>
      ))}
    </div>
  )
}

function HistoryCharts({ row, points, fill, say }: { row: Row; points: HistoryPoint[]; fill: SarPoint[]; say: Say }) {
  const { range } = useStore(rangeStore)
  const now = Date.now()
  const series = bucketHistory(points, range, now, fill)
  const { rx, tx, load: loads } = series
  const status = row.status
  const failing = status !== null && !status.ok
  const healthy = status?.ok ? status : null
  const lastOf = (values: (number | null)[]) => values.filter((value): value is number => value !== null).pop()
  const percentOr = (current: number | null | undefined, values: (number | null)[]) => {
    const value = current ?? lastOf(values)
    if (value === undefined || value === null) return '—'
    return failing ? say('server.lastValue', { value: `${Math.round(value)}%` }) : `${Math.round(value)}%`
  }
  // 구간 합계 — 칸마다 오간 바이트의 합(앞 읽기와의 차이를 쌓은 것 · 맥이 꺼져 못 읽은 동안은 빠진다)
  const sumText = (values: (number | null)[]) => {
    const known = values.filter((value): value is number => value !== null)
    return known.length ? bytesSize(known.reduce((total, value) => total + value, 0)) : '—'
  }
  const peak = (values: (number | null)[]) => Math.max(1, ...values.filter((value): value is number => value !== null)) * 1.15
  const msValues = series.ms.filter((value): value is number => value !== null)
  const disk = healthy?.rootDisk ?? null
  const diskRing = disk && disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : null
  const msNow = row.web?.ok ? row.web.ms : lastOf(series.ms)
  const cpus = healthy?.cpus ?? null
  const loadNow = healthy?.load1 ?? lastOf(loads) ?? null
  const loadValues = loads.filter((value): value is number => value !== null)
  // 부하가 코어 수를 넘으면 주의 · 두 배면 높음
  const loadLevel = loadNow === null || cpus === null || failing ? '' : loadNow > cpus * 2 ? 'high' : loadNow > cpus ? 'warn' : ''
  const loadText = loadNow === null ? '—' : failing ? say('server.lastValue', { value: loadNow.toFixed(2) }) : loadNow.toFixed(2)
  const loadNote = healthy && healthy.load5 !== null && healthy.load15 !== null ? say('server.card.loadNote', { one: loadNow?.toFixed(2) ?? '—', five: healthy.load5.toFixed(2), fifteen: healthy.load15.toFixed(2) }) : undefined
  const swapNote = healthy && healthy.swapPercent !== null ? say('server.card.swapNote', { value: `${healthy.swapPercent}%` }) : undefined
  const allCards: MetricCard[] = [
    { key: 'cpu', title: say('server.card.cpu'), value: percentOr(healthy?.cpuPercent, series.cpu), level: meterLevel(healthy?.cpuPercent ?? null), line: { metric: 'cpu', values: series.cpu, max: 100 } },
    { key: 'load', title: say('server.card.load'), value: loadText, total: cpus !== null ? say('server.card.loadCores', { count: cpus }) : undefined, note: loadNote, level: loadLevel, line: { metric: 'load', values: loads, max: Math.max(cpus ?? 1, ...loadValues) * 1.2 } },
    { key: 'mem', title: say('server.card.mem'), value: percentOr(healthy?.memPercent, series.mem), note: swapNote, level: meterLevel(healthy?.memPercent ?? null), line: { metric: 'mem', values: series.mem, max: 100 } },
    // / 를 GB 로 · 고리도 / 의 사용률 — 다른 마운트는 아래 디스크 칸
    { key: 'disk', title: disk ? say('server.card.diskAt', { mount: '/' }) : say('server.card.disk'), value: disk ? bytesSize(disk.used) : percentOr(healthy?.diskPercent, series.disk), total: disk ? `/ ${bytesSize(disk.total)}` : undefined, level: meterLevel(diskRing ?? healthy?.diskPercent ?? null), ring: diskRing ?? healthy?.diskPercent ?? lastOf(series.disk) ?? 0 },
    { key: 'rx', title: say('server.card.rx', { range: say(`server.range.${range}`) }), value: sumText(rx), level: '', line: { metric: 'rx', values: rx, max: peak(rx) } },
    { key: 'tx', title: say('server.card.tx', { range: say(`server.range.${range}`) }), value: sumText(tx), level: '', line: { metric: 'tx', values: tx, max: peak(tx) } },
    { key: 'ms', title: say('server.card.ms'), value: msText(msNow, failing, say), level: failing ? '' : webLevel(row.web), line: { metric: 'ms', values: series.ms, max: Math.max(100, ...msValues) * 1.2 } },
  ]
  const cards = allCards.filter((card) => card.key !== 'ms' || row.web !== null || msValues.length > 0)
  // 줄마다 폭 — 응답 카드가 없으면 2열은 수신 · 송신 반반(D11)
  const spans = new Map(metricRows(cards.map((card) => card.key)).flat().map(({ key, span }) => [key, span]))
  const width = 200
  const height = 56
  return (
    <div className="sx-history">
      <div className="sx-history-head">
        <span className="sx-history-name">{row.name}</span>
        {healthy && (
          <span className="sx-facts">
            <span>{say('server.uptime', { time: uptimeText(healthy.uptimeSeconds, say) })}</span>
            {healthy.docker && <span className={healthy.docker.down.length ? 'warn' : ''}>{say('server.fact.docker', { value: `${healthy.docker.up}/${healthy.docker.total}` })}</span>}
            {healthy.running !== null && <span className={healthy.failed.length ? 'fail' : ''}>{say('server.fact.failed', { count: healthy.failed.length })}</span>}
          </span>
        )}
        <span className="sx-gap" />
        <span className="sx-dim">{say(fill.length ? 'server.historySar' : 'server.history')}</span>
        <span className="sx-ranges">
          {RANGE_KEYS.map((key) => (
            <button key={key} className={`sv-range ${key === range ? 'active' : ''}`} onClick={() => rangeStore.set({ range: key })}>
              {say(`server.range.${key}`)}
            </button>
          ))}
        </span>
      </div>
      {healthy && <InfoChips status={healthy} at={row.at} say={say} />}
      <div className="sx-cards">
        {cards.map((card) => (
          <div className={`sx-box sx-mcard ${failing ? 'stale' : ''}`} key={card.key} style={{ gridColumn: `span ${spans.get(card.key) ?? 12}` }}>
            <div className="sx-mcard-text">
              <span className="sx-mcard-title">{card.title}</span>
              <span className={`sx-mcard-value ${card.level}`}>
                {card.value}
                {card.total && <span className="sx-mcard-total"> {card.total}</span>}
              </span>
              {card.note && <span className="sx-mcard-note">{card.note}</span>}
            </div>
            {card.line && (
              <ChartHover className="sx-mcard-line" line={card.line} timeOf={(index) => bucketStart(range, now, index)}>
                <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
                  {gapBoxes(card.line.values, width).map((box) => (
                    <rect key={box.x} className="sv-gap-box" x={box.x} y={0} width={box.w} height={height} />
                  ))}
                  <path className={`sv-area sv-c-${card.line.metric}`} d={areaPath(card.line.values, width, height, card.line.max)} />
                  <path className={`sv-line sv-c-${card.line.metric}`} d={linePath(card.line.values, width, height, card.line.max)} vectorEffect="non-scaling-stroke" />
                </svg>
              </ChartHover>
            )}
            {card.ring !== undefined && (
              <svg className="sx-ring" viewBox="0 0 48 48" aria-hidden="true">
                <circle className="sx-ring-track" cx={24} cy={24} r={19} />
                <circle className={`sx-ring-fill ${meterLevel(card.ring)}`} cx={24} cy={24} r={19} pathLength={100} strokeDasharray={`${card.ring} 100`} transform="rotate(-90 24 24)" />
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
