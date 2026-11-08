// 서버 탐색기 — 탭 줄 [서버] 버튼(늘 보임 · 상태 점 · 서버가 0개면 누를 때 등록 팝업)과 누르면 뜨는 앱 안 전체 화면 칸.
// 왼쪽 서버 목록(상태 점 · 이름 · 응답 · CPU/MEM/SWAP/DISK · 1시간 추이선) / 오른쪽 고른 서버의 경고 줄 · 2×2 그래프 · 상세.
// 읽기는 main(src/main/server-status.mts)이 코어 `ssh-run.sh <서버> --status`(허용 목록 안 고정 읽기 명령)와 이 맥의 응답 확인으로 — 여기서는 몇 분마다 부르고 그리기만.
// 칸을 닫아도 읽기는 계속 돈다(버튼 점이 맞게 바뀌도록). 서버 목록이 바뀌면 바닐라 space-actions.ts refreshServers 가 setServers 를 부른다
import type { ReactNode } from 'react'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'
import { bucketHistory, HISTORY_RANGES } from '../../lib/server-status.mts'
import type { HistoryMetric, HistoryPoint, HistoryRange, ServerStatus, WebCheck } from '../../lib/server-status.mts'

type Row = ServerEntry & { status: ServerStatus | null; web: WebCheck | null; at: number }
type View = { rows: Row[]; history: Record<string, HistoryPoint[]>; reading: boolean; selected: string }
const view = createStore<View>({ rows: [], history: {}, reading: false, selected: '' })
const rangeStore = createStore<{ range: HistoryRange }>({ range: '1h' })

// 몇 분마다 — ssh 를 서버마다 한 번씩 여니 자주 돌리지 않는다
const POLL_MS = 3 * 60 * 1000

let button: HTMLButtonElement | null = null
let dot: HTMLElement | null = null
let viewBox: HTMLElement | null = null
let names = ''
let timer: ReturnType<typeof setInterval> | null = null
let reading = false
let addServer: () => void = () => {}

// 켤 때 한 번 — 칸에 띄워 두고 계속 쓴다(내리지 않는다). 점은 읽을 때마다 바뀐다(칸이 닫혀 있어도)
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
  button.classList.add('active')
  button.setAttribute('aria-expanded', 'true')
  viewBox.focus()
}

function close(): void {
  if (!viewBox || !button || viewBox.hidden) return
  viewBox.hidden = true
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
  if (timer) clearInterval(timer)
  timer = has ? setInterval(() => void readNow(), POLL_MS) : null
  if (has) void readNow()
}

async function readNow(): Promise<void> {
  if (reading) return
  reading = true
  view.set({ ...view.get(), reading: true })
  try {
    const reply = await studio.serverStatus()
    const found = new Map(reply.servers.map((server) => [server.name, server]))
    view.set({ ...view.get(), reading: false, history: reply.history, rows: view.get().rows.map((row) => found.get(row.name) || row) })
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
            <ServerCard key={row.name} row={row} points={state.history[row.name] ?? []} picked={row.name === picked?.name} say={say} />
          ))}
        </nav>
        {picked && <ServerDetail row={picked} points={state.history[picked.name] ?? []} say={say} />}
      </div>
    </div>
  )
}

function ServerCard({ row, points, picked, say }: { row: Row; points: HistoryPoint[]; picked: boolean; say: Say }) {
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
            <span className={`sx-health ${webLevel(row.web)}`}>{webText(row.web, say)}</span>
            <span className="sx-gap" />
            <Spark points={points} />
          </span>
          <span className="sx-card-line sx-meters">
            <Meter label="CPU" value={status.cpuPercent} />
            <Meter label="MEM" value={status.memPercent} />
            <Meter label="SWAP" value={status.swapPercent} />
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

function ServerDetail({ row, points, say }: { row: Row; points: HistoryPoint[]; say: Say }) {
  const status = row.status
  const warnings = warningsOf(row, say)
  const worst = warnings.some((warning) => warning.level === 'fail') ? 'fail' : 'warn'
  const lastOk = points[points.length - 1]?.t ?? 0
  const web = row.web
  return (
    <section className="sx-main">
      {warnings.length > 0 && (
        <div className={`sx-banner ${worst}`}>
          {warnings.map((warning) => (
            <span key={warning.text} className={`sx-banner-item ${warning.level}`}>{warning.text}</span>
          ))}
        </div>
      )}
      <HistoryCharts name={row.name} points={points} failing={status !== null && !status.ok} say={say} />
      {status?.ok ? (
        <div className="sx-details">
          <Card title={say('server.box.disks')}>
            {(status.disks.length ? status.disks : [{ mount: '/', percent: status.diskPercent ?? 0 }]).map((disk) => (
              <div className="sx-disk" key={disk.mount}>
                <span className="sx-disk-mount" title={disk.mount}>{disk.mount}</span>
                <span className="sx-meter-track wide"><span className={meterLevel(disk.percent)} style={{ width: `${disk.percent}%` }} /></span>
                <span className={`sx-disk-value ${meterLevel(disk.percent)}`}>{disk.percent}%</span>
              </div>
            ))}
          </Card>
          <Card title={say('server.box.services')}>
            <Item label={say('server.failedServices')} value={status.failed.length ? status.failed.join(', ') : say('server.none')} level={status.failed.length ? 'fail' : 'dim'} />
            <Item label={say('server.runningServices')} value={status.running === null ? '—' : say('server.countValue', { count: status.running })} />
            <Item label="docker" value={status.docker ? say('server.dockerValue', { up: status.docker.up, total: status.docker.total }) : '—'} />
            <Item label={say('server.downContainers')} value={status.docker?.down.length ? status.docker.down.join(', ') : say('server.none')} level={status.docker?.down.length ? 'warn' : 'dim'} />
          </Card>
          <Card title={say('server.box.security')}>
            <Item label={say('server.response')} value={webText(web, say)} level={webLevel(web) === 'high' ? 'fail' : webLevel(web)} />
            <Item label={say('server.cert')} value={certText(web, say)} level={web?.ok && web.certDays !== null && web.certDays < 14 ? 'warn' : ''} />
            <Item label={say('server.updates')} value={status.updates === null ? '—' : say('server.countValue', { count: status.updates })} level={(status.updates ?? 0) > 10 ? 'warn' : ''} />
            <Item label={say('server.errors')} value={status.errors === null ? '—' : say('server.errorsValue', { count: status.errors })} level={(status.errors ?? 0) > 20 ? 'warn' : ''} />
          </Card>
          <Card title={say('server.box.system')}>
            <Item label={say('server.uptimeLabel')} value={uptimeText(status.uptimeSeconds, say)} />
            <Item label="SWAP" value={percentText(status.swapPercent)} level={(status.swapPercent ?? 0) > 50 ? 'warn' : ''} />
            <Item label={say('server.load')} value={status.load1 === null ? '—' : say('server.loadValue', { load: status.load1, cpus: status.cpus ?? '–' })} />
            <Item label={say('server.readTime')} value={timeText(row.at)} />
          </Card>
        </div>
      ) : (
        <div className="sx-details">
          <Card title={say('server.box.now')}>
            <Item label={say('server.why')} value={status ? say(`server.reason.${status.reason}`) : say('server.reading')} level={status ? 'fail' : 'dim'} />
            <Item label={say('server.lastOk')} value={timeText(lastOk)} />
            <Item label={say('server.tried')} value={timeText(row.at)} />
          </Card>
        </div>
      )}
      <p className="sx-foot">{say('server.foot')}</p>
    </section>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sx-box">
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
      boxes.push({ x: Math.max(0, (from - 0.5) * step), w: (to - from + 1) * step })
      from = -1
    }
  })
  return boxes
}

// 목록 카드의 1시간 추이 — CPU(금색) · MEM(파랑) 두 선
function Spark({ points }: { points: HistoryPoint[] }) {
  const width = 64
  const height = 16
  const series = bucketHistory(points, '1h', Date.now())
  return (
    <svg className="sv-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path className="sv-line-mem" d={linePath(series.mem, width, height, 100)} />
      <path className="sv-line-cpu" d={linePath(series.cpu, width, height, 100)} />
    </svg>
  )
}

const CHARTS: { metric: HistoryMetric; label: string; unit: string }[] = [
  { metric: 'cpu', label: 'CPU', unit: '%' },
  { metric: 'mem', label: 'MEM', unit: '%' },
  { metric: 'disk', label: 'DISK', unit: '%' },
  { metric: 'ms', label: '', unit: 'ms' },
]
const RANGE_KEYS = Object.keys(HISTORY_RANGES) as HistoryRange[]

function HistoryCharts({ name, points, failing, say }: { name: string; points: HistoryPoint[]; failing: boolean; say: Say }) {
  const { range } = useStore(rangeStore)
  const series = bucketHistory(points, range, Date.now())
  const width = 400
  const height = 90
  return (
    <div className="sx-history">
      <div className="sx-history-head">
        <span className="sx-history-name">{name}</span>
        <span className="sx-dim">{say('server.history')}</span>
        <span className="sx-gap" />
        <span className="sx-ranges">
          {RANGE_KEYS.map((key) => (
            <button key={key} className={`sv-range ${key === range ? 'active' : ''}`} onClick={() => rangeStore.set({ range: key })}>
              {say(`server.range.${key}`)}
            </button>
          ))}
        </span>
      </div>
      <div className="sx-charts">
        {CHARTS.map((chart) => {
          const values = series[chart.metric]
          const numbers = values.filter((value): value is number => value !== null)
          const max = chart.unit === '%' ? 100 : Math.max(100, ...numbers) * 1.2
          const last = numbers[numbers.length - 1]
          let valueText = '—'
          if (last !== undefined) valueText = failing ? say('server.lastValue', { value: `${Math.round(last)}${chart.unit}` }) : `${Math.round(last)}${chart.unit}`
          return (
            <div className="sx-box sx-chart" key={chart.metric}>
              <div className="sx-chart-label">
                <span>{chart.label || say('server.response')} {chart.unit}</span>
                <span className={`sx-chart-value ${failing ? 'sx-dim' : ''}`}>{valueText}</span>
              </div>
              <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
                {gapBoxes(values, width).map((box) => (
                  <rect key={box.x} className="sv-gap-box" x={box.x} y={0} width={box.w} height={height} />
                ))}
                {chart.unit === '%' && <line className="sv-warn-line" x1={0} x2={width} y1={height * 0.2} y2={height * 0.2} />}
                <path className={`sv-line-${chart.metric}`} d={linePath(values, width, height, max)} vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="sx-chart-axis">
                <span>{say(`server.rangeStart.${range}`)}</span>
                <span>{numbers.length ? say('server.now') : say('server.noHistory')}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
