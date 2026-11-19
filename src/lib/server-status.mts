// 서버 탐색기 — 코어 `scripts/ssh-run.sh <서버> --status` 출력 읽기 · 실패 이유 고르기 · 팩 servers[] 읽기 · 응답 확인 결과 · 시간 기록(7일)
// 출력은 "==이름" 줄로 칸을 나눈다(load · cpu · stat · stat2 · mem · disk · disks · net · os · kernel · failed · services · docker · stats · podman · podstats · pods ·
// supervisor · pm2 · top · detect · uptime · errors · updates · end — ssh-run.sh STATUS_COMMAND · 옛 코어는 stat · net · os · kernel · services · stats · top · detect
// 대신 running(수) 만 있고, stat2 · podman · podstats · pods · supervisor · pm2 는 그 뒤에 더한 칸이다).
// 원문(ssh 오류 글)은 화면에 올리지 않는다 — 주소 · 사용자 이름이 섞일 수 있다. 이유 이름만 고른다

export type ServerEntry = { name: string; host: string }
// down — 주의할 것(restarting · dead · 오류 종료 코드 · 코드를 모르는 exited) · stopped — 일부러 끈 것(exit 0 · docker stop 의 143 · created · paused)
export type DockerSummary = { up: number; total: number; down: string[]; stopped: string[] }
export type DiskUse = { mount: string; percent: number }
// docker stats --no-stream 한 줄 — 바이트 · 퍼센트(수신 · 송신 · 읽기 · 쓰기는 컨테이너가 켜진 뒤 누적)
export type ContainerStats = { cpu: number; memUsed: number; memLimit: number; memPercent: number; rx: number; tx: number; read: number; write: number }
// docker ps -a 한 줄 — project 는 compose 라벨(없으면 따로 띄운 컨테이너) · state 는 up / down(주의) / stopped(일부러 끈 것) · 꺼진 컨테이너는 stats 없음
export type ContainerRow = { name: string; project: string | null; image: string; state: 'up' | 'down' | 'stopped'; stats: ContainerStats | null }
// 앱 하나의 상태 — 컨테이너 묶음과 같은 네 갈래(실행 중 · 중지됨 · 오류 · 일부 중지 — 시작 · 멈추는 중 · 준비가 덜 됨)
export type RunState = 'running' | 'stopped' | 'error' | 'partial'
// kubectl get pods -A 한 줄 — reason 은 STATUS 칸(Running · CrashLoopBackOff · Init:0/1 …) · restarts 는 재시작 수
export type PodRow = { name: string; namespace: string; state: RunState; reason: string; restarts: number | null }
// supervisorctl status 한 줄 — 이름(group:name) · 상태(설명 칸은 읽지 않는다 — 종료 이유 글이 섞인다)
export type SupervisorRow = { name: string; state: RunState; reason: string }
// pm2 ls 표 한 줄 — cpu %(없으면 null) · mem 바이트(없으면 null) · restarts(↺)
export type Pm2Row = { name: string; state: RunState; reason: string; cpu: number | null; mem: number | null; restarts: number | null }
// ps 의 프로그램 이름(comm — 명령줄 인자는 비밀값이 섞일 수 있어 읽지 않는다) · CPU % · 메모리 %
export type ProcessUse = { name: string; cpu: number; mem: number }
// 누적 값 — /proc/stat 첫 줄(바쁜 · 전체 tick) · /proc/net/dev(가상 장치 뺀 수신 · 송신 바이트). 앞 읽기와의 차이로 CPU % · 트래픽을 낸다(withRates)
export type Counters = { busy: number; total: number; rx: number | null; tx: number | null }
// ── 서버 상세(폰 앱 서버 화면 — STATUS_COMMAND 의 ports · units · cpumodel · servicedesc · timers · cron · ufw · monarx · caddy · nginx 칸) ──
// 열린 포트 하나(ss -ltnupH) — public 은 루프백(127.* · ::1 · %lo)이 아닌 주소 · unit 은 그 pid 의 systemd 서비스(.service 뗌 · 모르면 null)
export type OpenPort = { proto: 'tcp' | 'udp'; address: string; port: number; process: string | null; unit: string | null; public: boolean }
// 도는 서비스 하나 — 설명(systemctl 설명 칸) · 그 서비스가 연 포트
export type ServiceInfo = { name: string; description: string | null; ports: number[] }
// systemd 타이머 — next · last 는 ISO(시간대가 UTC · GMT 일 때만 · 그 밖이나 없으면 null)
export type TimerRow = { unit: string; activates: string | null; next: string | null; last: string | null }
// 사용자 crontab 한 줄 — 명령은 첫 낱말의 끝 이름만(서버에서 인자를 자른다 · = 가 든 낱말은 환경값이라 null)
export type CronRow = { schedule: string; command: string | null }
// 웹 서버 사이트 하나 — 주소(머리 줄 · server_name) · 설명(Caddyfile 머리 바로 위 주석 첫 줄) · 넘기는 포트(reverse_proxy) · 정적 파일(root)
export type SiteRow = { addresses: string[]; description: string | null; ports: number[]; static: boolean; source: 'caddy' | 'nginx' }
export type ServerDetail = {
  ports: OpenPort[] | null // ss 가 없거나 옛 코어면 null
  cpuModel: string | null
  serviceInfo: ServiceInfo[] | null
  timers: TimerRow[] | null
  cron: CronRow[] | null // crontab 이 비었으면 []
  ufw: 'active' | 'inactive' | null // ufw 가 없거나 못 읽으면 null
  monarx: string | null // monarx-agent 유닛이 없으면 null · 있으면 systemctl is-active 값(active · inactive · failed …)
  sites: SiteRow[] | null // Caddyfile · nginx 둘 다 못 읽으면 null
}
export type ServerHealth = {
  ok: true
  cpuPercent: number | null // 1초 사이 두 번 읽은 실제 CPU 사용률(/proc/stat) · 옛 코어는 앞 읽기(몇 분 전)부터 — 앞 읽기가 없으면 null
  load1: number | null
  load5: number | null
  load15: number | null
  cpus: number | null
  counters: Counters | null // /proc/stat 이 없는 서버 · 옛 코어면 null
  rxBytes: number | null // 앞 읽기부터 받은 · 보낸 바이트(가상 장치 뺌) — 앞 읽기가 없거나 서버가 다시 켜져 줄었으면 null
  txBytes: number | null
  memTotal: number | null // 바이트(free -b)
  swapTotal: number | null // 바이트 · SWAP 이 없으면 0
  rootDisk: { used: number; total: number } | null // / 의 바이트(df -B1)
  os: string | null // os-release PRETTY_NAME
  kernel: string | null // uname -r
  memPercent: number | null // (전체 − available) ÷ 전체
  diskPercent: number | null // 가장 찬 마운트의 Capacity(마운트 목록이 없으면 df / )
  disks: DiskUse[] // 마운트마다(tmpfs 같은 가짜 파일 시스템 뺌)
  swapPercent: number | null // SWAP 이 없으면(전체 0) null
  uptimeSeconds: number | null
  errors: number | null // 최근 1시간 에러 로그 줄 수(journalctl 이 없으면 null)
  updates: number | null // 밀린 보안 업데이트 수(apt 가 없으면 null)
  failed: string[] // 멈춘 systemd 서비스 이름(.service 뗌)
  running: number | null // 도는 systemd 서비스 수
  services: string[] | null // 도는 systemd 서비스 이름(.service 뗌 · 설명 칸은 읽지 않는다) — 옛 코어 · systemd 없으면 null
  docker: DockerSummary | null // docker 가 없거나 못 읽으면 null
  containers: ContainerRow[] | null // docker 가 없으면 null
  podman: ContainerRow[] | null // podman 이 없거나 못 읽으면 null(컨테이너 0개면 [])
  pods: PodRow[] | null // kubectl 이 없거나 못 읽으면 null
  supervisor: SupervisorRow[] | null // supervisorctl 이 없거나 못 읽으면 null
  pm2: Pm2Row[] | null // pm2 가 없거나 데몬이 안 떠 있거나 못 읽으면 null
  top: ProcessUse[] // CPU 순 5개
  detected: string[] // 있지만 읽지 못한 실행 도구(실행 실패 · 권한 없음 · pm2 데몬 없음 — command -v 로는 있다)
} & ServerDetail
// key-needed — 비밀번호 없이 못 들어감 · host-key — 지문 확인 필요 · unreachable — 닿지 않음 · timeout — 시간 초과 · core-old — 본체에 상태 읽기가 없음 · failed — 그 밖
// host-key-changed — 서버 추가 팝업만(known_hosts 에 그 서버의 다른 키가 있음 · lib/known-hosts.mts)
export type ServerFailReason = 'key-needed' | 'host-key' | 'host-key-changed' | 'unreachable' | 'timeout' | 'core-old' | 'failed'
export type ServerFailure = { ok: false; reason: ServerFailReason }
export type ServerStatus = ServerHealth | ServerFailure

// 이 맥에서 본 응답(pack.json servers[].health 주소) — 주소는 화면 · 기록에 넘기지 않는다
// unreachable — 닿지 않음 · timeout — 시간 초과 · cert — 인증서 오류(만료 · 이름 다름) · failed — 그 밖
export type WebCheck = { ok: true; code: number; ms: number; certDate: string | null; certDays: number | null } | { ok: false; reason: 'unreachable' | 'timeout' | 'cert' | 'failed' }
export type ServerReading = ServerEntry & { status: ServerStatus; web: WebCheck | null; at: number }

const NAME = /^[a-z0-9][a-z0-9-]*$/
// ssh 별칭 — 맨 앞 - 는 ssh 옵션(-oProxyCommand=… 은 이 맥에서 명령을 돌린다 · 2026-11-08 보안 검토 높음2) · 코어 ssh-run.sh 와 같은 꼴
export const SSH_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const ALIAS = SSH_ALIAS

// pack.json servers[] — 이름 · 별칭이 올바른 것만(그 밖 칸은 읽지 않는다)
export function packServers(pack: unknown): ServerEntry[] {
  const list = pack && typeof pack === 'object' ? (pack as { servers?: unknown }).servers : null
  if (!Array.isArray(list)) return []
  const servers: ServerEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { name, host } = item as { name?: unknown; host?: unknown }
    if (typeof name === 'string' && typeof host === 'string' && NAME.test(name) && ALIAS.test(host)) servers.push({ name, host })
  }
  return servers
}

// 이 맥 · 내부망 주소 — 루프백 · 사설 · 링크로컬 · 0.0.0.0 · localhost · .local(공유 팩이 이 맥에서 내부망 GET 을 시키지 못하게 · 보안 검토 M2)
// 주소 글자만 본다 — 공개 이름이 내부 주소로 풀리는 것까지는 막지 않는다
function internalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [first, second] = [Number(v4[1]), Number(v4[2])]
    return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
  }
  if (!host.includes(':')) return false
  const mapped = host.match(/^::ffff:(.+)$/)?.[1]
  if (mapped) return mapped.includes('.') ? internalHost(mapped) : true
  return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
}

// pack.json servers[].health — http(s) 주소만 · 사용자:비밀번호가 든 주소 · 이 맥 · 내부망 주소는 쓰지 않는다
export function healthUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (internalHost(url.hostname)) return null
    return url.username || url.password ? null : url.href
  } catch {
    return null
  }
}

// 서버 목록 + 응답 확인 주소(main 만 쓴다 — 화면에는 packServers)
export function packTargets(pack: unknown): (ServerEntry & { health: string | null })[] {
  const list = pack && typeof pack === 'object' ? (pack as { servers?: unknown }).servers : null
  if (!Array.isArray(list)) return []
  const byName = new Map(list.filter((item) => item && typeof item === 'object').map((item) => [(item as { name?: unknown }).name, (item as { health?: unknown }).health]))
  return packServers(pack).map((server) => ({ ...server, health: healthUrl(byName.get(server.name)) }))
}

// "==이름" 칸마다 줄 목록
function sections(output: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of output.split('\n')) {
    const head = /^==(\w+)\s*$/.exec(line)
    if (head) {
      current = []
      found.set(head[1]!, current)
    } else if (current && line.trim()) current.push(line.trim())
  }
  return found
}

const toNumber = (text: string | undefined): number | null => {
  if (text === undefined || text === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

const percent = (part: number, whole: number) => Math.max(0, Math.min(100, Math.round((part / whole) * 100)))

function memoryPercent(lines: string[]): number | null {
  const header = lines.find((line) => /\btotal\b/.test(line) && /\bavailable\b/.test(line))
  const row = lines.find((line) => /^Mem:/.test(line))
  if (!row) return null
  const values = row.split(/\s+/).slice(1).map(Number)
  const total = values[0]
  if (!total) return null
  // available 칸이 있으면 그것으로(캐시는 쓴 것으로 치지 않는다), 없으면 used
  const names = header ? header.split(/\s+/) : []
  const availableAt = names.indexOf('available')
  const available = availableAt >= 0 ? values[availableAt] : undefined
  const used = available !== undefined && Number.isFinite(available) ? total - available : values[1]
  return used !== undefined && Number.isFinite(used) ? percent(used, total) : null
}

function swapPercent(lines: string[]): number | null {
  const row = lines.find((line) => /^Swap:/.test(line))
  if (!row) return null
  const [total, used] = row.split(/\s+/).slice(1).map(Number)
  return total && used !== undefined && Number.isFinite(used) ? percent(used, total) : null
}

// df -P 마운트마다 — 마운트 이름에 빈칸이 있어도 Capacity 뒤를 통째로
function diskList(lines: string[]): DiskUse[] {
  const disks: DiskUse[] = []
  for (const line of lines) {
    const match = /\s(\d+)%\s+(\/.*)$/.exec(line)
    if (match) disks.push({ mount: match[2]!, percent: Number(match[1]) })
  }
  return disks
}

function diskPercent(lines: string[]): number | null {
  // 머리줄 다음 줄 — Filesystem 1024-blocks Used Available Capacity Mounted
  const row = lines.find((line) => !/^Filesystem\b/.test(line))
  const capacity = row && /(\d+)%/.exec(row)
  return capacity ? Number(capacity[1]) : null
}

// df -P -B1 / 의 바이트 — 머리줄 다음 줄 "장치 전체 사용 남음 N% /" (옛 코어는 1024-blocks 라 읽지 않는다)
function rootDisk(lines: string[]): { used: number; total: number } | null {
  if (!lines.some((line) => /^Filesystem\s+1-blocks\b/.test(line))) return null
  const row = lines.find((line) => !/^Filesystem\b/.test(line))
  const match = row && /\s(\d+)\s+(\d+)\s+\d+\s+\d+%\s+\//.exec(row)
  return match ? { total: Number(match[1]), used: Number(match[2]) } : null
}

function memTotals(lines: string[]): { mem: number | null; swap: number | null } {
  const first = (prefix: string) => toNumber(lines.find((line) => line.startsWith(prefix))?.split(/\s+/)[1])
  return { mem: first('Mem:'), swap: first('Swap:') }
}

// /proc/stat 첫 줄 "cpu user nice system idle iowait irq softirq steal …" — 쉰 시간 = idle + iowait
function cpuTicks(line: string | undefined): { busy: number; total: number } | null {
  if (!line || !/^cpu\s/.test(line)) return null
  const values = line.split(/\s+/).slice(1, 9).map(Number)
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  const idle = (values[3] ?? 0) + (values[4] ?? 0)
  return { busy: total - idle, total }
}

// 가상 장치(루프백 · 컨테이너 다리 · veth · VPN 터널 등)는 실제 랜카드를 다시 지나가는 트래픽이라 세지 않는다
const VIRTUAL_NET = /^(lo|veth|br-|docker|virbr|vnet|cni|flannel|cali|vxlan|tun|tap|wg|tailscale|zt|kube|lxc|lxd)/

// /proc/net/dev — "장치: 받은바이트 패킷 … (8칸) 보낸바이트 …"
function netBytes(lines: string[]): { rx: number; tx: number } | null {
  let rx = 0
  let tx = 0
  let found = false
  for (const line of lines) {
    const match = /^([^:\s]+):\s*(.*)$/.exec(line)
    if (!match || VIRTUAL_NET.test(match[1]!)) continue
    const values = match[2]!.split(/\s+/).map(Number)
    if (values.length < 9 || !Number.isFinite(values[0]) || !Number.isFinite(values[8])) continue
    rx += values[0]!
    tx += values[8]!
    found = true
  }
  return found ? { rx, tx } : null
}

// docker 크기 글 → 바이트 — 메모리는 KiB · MiB · GiB(1024), 네트워크 · 디스크는 kB · MB · GB(1000)
const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }
export function sizeBytes(text: string | undefined): number | null {
  const match = text && /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim())
  if (!match) return null
  const unit = SIZE_UNITS[match[2]!.toLowerCase()]
  const value = Number(match[1])
  return unit && Number.isFinite(value) ? Math.round(value * unit) : null
}

const percentNumber = (text: string | undefined) => toNumber(text?.trim().replace(/%$/, ''))

// docker stats 한 줄 "이름|CPU%|쓴 / 한도|메모리%|받음 / 보냄|읽음 / 씀"
function containerStats(lines: string[]): Map<string, ContainerStats> {
  const stats = new Map<string, ContainerStats>()
  for (const line of lines) {
    const [name, cpuText, memText, memPercentText, netText, blockText] = line.split('|')
    if (!name || blockText === undefined) continue
    const [memUsed, memLimit] = memText!.split('/').map(sizeBytes)
    const [rx, tx] = netText!.split('/').map(sizeBytes)
    const [read, write] = blockText.split('/').map(sizeBytes)
    const cpu = percentNumber(cpuText)
    const memPercent = percentNumber(memPercentText)
    const values = [cpu, memUsed, memLimit, memPercent, rx, tx, read, write]
    if (values.some((value) => value === null || value === undefined)) continue
    stats.set(name, { cpu: cpu!, memUsed: memUsed!, memLimit: memLimit!, memPercent: memPercent!, rx: rx!, tx: tx!, read: read!, write: write! })
  }
  return stats
}

// ps -eo comm=,pcpu=,pmem= — 이름에 빈칸이 있을 수 있어 끝 두 칸을 숫자로
function topProcesses(lines: string[]): ProcessUse[] {
  const list: ProcessUse[] = []
  for (const line of lines) {
    const match = /^(.+?)\s+([\d.]+)\s+([\d.]+)$/.exec(line)
    if (match) list.push({ name: match[1]!, cpu: Number(match[2]), mem: Number(match[3]) })
  }
  return list.slice(0, 5)
}

// lxc 는 뺀다 — 기본 Ubuntu 에 늘 깔려 있어 잡음(D10)
const DETECTABLE = new Set(['pm2', 'podman', 'kubectl', 'supervisorctl'])

// 정상으로 꺼진 종료 코드 — 0(스스로 끝남) · 143(docker stop 의 SIGTERM).
// 137 은 넣지 않는다 — docker stop 이 기다리다 SIGKILL 한 것과 OOM 이 같은 코드이고 docker ps 출력으로는 가를 수 없다
const STOPPED_CODES = new Set([0, 143])

// 줄 = "이름|State|Status"(Status 예: "Exited (143) 2 months ago") · 옛 형식 "이름|State" 도 읽는다(종료 코드를 모르면 주의)
function containerStopped(state: string, status: string | undefined): boolean {
  if (state === 'created' || state === 'paused') return true
  // podman 의 stopped 도 Status 가 "Exited (코드) … ago" 다(cmd/podman/containers/ps.go Status())
  if (state !== 'exited' && state !== 'stopped') return false
  const code = status && /^Exited \((\d+)\)/.exec(status)
  return Boolean(code) && STOPPED_CODES.has(Number(code![1]))
}

// 줄 = "이름|State|Status|이미지|compose 프로젝트"(옛 코어는 앞 2 · 3칸만)
function containerRows(lines: string[] | undefined, stats: Map<string, ContainerStats>): ContainerRow[] | null {
  if (!lines) return null
  const rows: ContainerRow[] = []
  for (const line of lines) {
    const parts = line.split('|')
    const [name, state, statusText, image, project] = parts
    if (parts.length < 2 || parts.length > 5 || !name || !state) continue // ".ok" 줄(읽기 성공 표시)도 여기서 빠진다
    let kind: ContainerRow['state'] = 'up'
    if (state !== 'running') kind = containerStopped(state, statusText) ? 'stopped' : 'down'
    rows.push({ name, project: project || null, image: image || '', state: kind, stats: kind === 'up' ? stats.get(name) ?? null : null })
  }
  return rows.length ? rows : null
}

// 읽기 성공 표시 — STATUS_COMMAND 가 명령이 0 으로 끝나면 칸 끝에 ".ok" 한 줄
const READ_OK = '.ok'
const readOk = (lines: string[] | undefined) => Boolean(lines?.includes(READ_OK))

// podman ps -a — docker 와 같은 꼴. 컨테이너가 없으면 []
function podmanRows(lines: string[] | undefined, stats: Map<string, ContainerStats>): ContainerRow[] | null {
  if (!readOk(lines)) return null
  return containerRows(lines, stats) ?? []
}

// kubectl get pods -A --no-headers — "NAMESPACE NAME READY STATUS RESTARTS AGE"(RESTARTS 는 "3 (5m ago)" 처럼 빈칸이 들 수 있다 · 처음 칸들만 본다)
// 준비 다 됨 + Running → 실행 중 · Completed → 중지됨(끝난 작업) · 준비 덜 됨 · 시작 · 끝내는 중 → 일부 중지 · 그 밖(CrashLoopBackOff · Error · ImagePullBackOff …) → 오류
const POD_PENDING = /^(Pending|ContainerCreating|PodInitializing|Terminating|NotReady|Init:)/
function podState(ready: string, reason: string): RunState {
  const [readyCount, wanted] = ready.split('/').map(Number)
  if (reason === 'Completed') return 'stopped'
  if (reason === 'Running') return readyCount === wanted ? 'running' : 'partial'
  if (POD_PENDING.test(reason) && !/(BackOff|Err|Error|Crash)/.test(reason)) return 'partial'
  return 'error'
}
function podRows(lines: string[] | undefined): PodRow[] | null {
  if (!readOk(lines)) return null
  const rows: PodRow[] = []
  for (const line of lines!) {
    const [namespace, name, ready, reason, restarts] = line.split(/\s+/)
    if (!namespace || !name || !ready || !reason || !/^\d+\/\d+$/.test(ready)) continue
    rows.push({ name, namespace, state: podState(ready, reason), reason, restarts: toNumber(restarts) })
  }
  return rows
}

// supervisorctl status — "이름  상태  설명"(supervisor/supervisorctl.py _show_statuses). 인증 실패 · 연결 실패 글도 stdout 이라 상태 낱말이 맞는 줄만
const SUPERVISOR_STATES: Record<string, RunState> = { RUNNING: 'running', STOPPED: 'stopped', STARTING: 'partial', STOPPING: 'partial', EXITED: 'error', BACKOFF: 'error', FATAL: 'error', UNKNOWN: 'error' }
function supervisorRows(lines: string[] | undefined): SupervisorRow[] | null {
  const rows: SupervisorRow[] = []
  for (const line of lines ?? []) {
    const match = /^(\S+)\s+([A-Z]+)(\s|$)/.exec(line)
    const state = match && SUPERVISOR_STATES[match[2]!]
    if (match && state) rows.push({ name: match[1]!, state, reason: match[2]! })
  }
  return rows.length ? rows : null
}

// pm2 ls 표(lib/API/UX/pm2-ls.js · cli-tableau) — "│" 로 나눈 첫 표만(뒤의 Module 표는 안 읽는다). 칸은 머리줄 이름으로 찾는다(판마다 칸 수가 다르다)
// mem 은 1024 단위 "45.2mb"(bytesToSize) · cpu 는 "0%" · 재시작은 "↺" 칸 · 상태는 online · stopped · errored · launching · stopping · restart …
const ANSI = /\u001b\[[0-9;]*m/g
const PM2_STATES: Record<string, RunState> = { online: 'running', stopped: 'stopped', launching: 'partial', stopping: 'partial', restart: 'partial' }
const PM2_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }
function pm2Bytes(text: string | undefined): number | null {
  const match = text && /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim())
  const unit = match && PM2_UNITS[match[2]!.toLowerCase()]
  return match && unit && Number.isFinite(Number(match[1])) ? Math.round(Number(match[1]) * unit) : null
}
function pm2Rows(lines: string[] | undefined): Pm2Row[] | null {
  if (!readOk(lines)) return null
  const cellsOf = (line: string) => line.replace(ANSI, '').split('│').slice(1, -1).map((cell) => cell.trim())
  let head: string[] | null = null
  const rows: Pm2Row[] = []
  for (const line of lines!) {
    const clean = line.replace(ANSI, '')
    if (head && clean.startsWith('└')) break
    if (!clean.startsWith('│')) continue
    const cells = cellsOf(clean)
    if (!head) {
      if (cells.includes('name') && cells.includes('status')) head = cells
      continue
    }
    const value = (names: string[]) => {
      const index = head!.findIndex((cell) => names.includes(cell))
      return index >= 0 ? cells[index] : undefined
    }
    const name = value(['name'])
    const status = value(['status'])
    if (!name || !status) continue
    rows.push({ name, state: PM2_STATES[status] ?? 'error', reason: status, cpu: percentNumber(value(['cpu'])), mem: pm2Bytes(value(['mem', 'memory'])), restarts: toNumber(value(['↺'])) })
  }
  return head ? rows : null
}

// 있지만 못 읽은 도구 — 옛 코어(칸이 없음)는 감지된 것 모두
function unreadable(found: Map<string, string[]>, read: Record<string, boolean>): string[] {
  return (found.get('detect') || []).filter((name) => DETECTABLE.has(name) && !read[name])
}

// 1초 사이 두 /proc/stat — 차이로 CPU %(둘 중 하나라도 없으면 null)
function instantCpu(first: { busy: number; total: number } | null, second: { busy: number; total: number } | null): number | null {
  if (!first || !second) return null
  const spent = second.total - first.total
  const busy = second.busy - first.busy
  return spent > 0 && busy >= 0 ? percent(busy, spent) : null
}

function dockerSummary(rows: ContainerRow[] | null): DockerSummary | null {
  if (!rows) return null
  const down = rows.filter((row) => row.state === 'down').map((row) => row.name)
  const stopped = rows.filter((row) => row.state === 'stopped').map((row) => row.name)
  return { up: rows.length - down.length - stopped.length, total: rows.length, down, stopped }
}

// ── 서버 상세 칸 읽기 ──
const LOOPBACK = /^(127\.|::1$|\[::1\]$|localhost$)|%lo$/
// pid → 서비스(ps -eo pid=,unit= 중 .service)
function unitsByPid(lines: string[] | undefined): Map<number, string> {
  const units = new Map<number, string>()
  for (const line of lines || []) {
    const [pid, unit] = line.split(/\s+/)
    if (pid && unit && /^\d+$/.test(pid) && unit.endsWith('.service')) units.set(Number(pid), unit.replace(/\.service$/, ''))
  }
  return units
}
// ss -ltnupH 한 줄: proto state recv send 주소:포트 상대 users:(("이름",pid=N,fd=N),…) — 같은 포트 · 주소는 한 번만
function openPorts(lines: string[] | undefined, units: Map<number, string>): OpenPort[] | null {
  if (!lines) return null
  const ports: OpenPort[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const cells = line.split(/\s+/)
    const proto = cells[0]
    const local = cells[4] || ''
    const split = local.lastIndexOf(':')
    const port = Number(local.slice(split + 1))
    if ((proto !== 'tcp' && proto !== 'udp') || split <= 0 || !Number.isInteger(port) || port <= 0) continue
    const address = local.slice(0, split)
    const key = `${proto} ${address} ${port}`
    if (seen.has(key)) continue
    seen.add(key)
    const user = /\("([^"]*)",pid=(\d+)/.exec(line)
    ports.push({ proto, address, port, process: user ? user[1]! : null, unit: user ? units.get(Number(user[2])) ?? null : null, public: !LOOPBACK.test(address) })
  }
  return ports
}
// systemctl list-units … --plain: 이름 load active sub 설명…
function serviceInfo(lines: string[] | undefined, ports: OpenPort[] | null): ServiceInfo[] | null {
  if (!lines) return null
  return lines
    .map((line) => line.split(/\s+/))
    .filter((cells) => (cells[0] || '').endsWith('.service'))
    .map((cells) => {
      const name = cells[0]!.replace(/\.service$/, '')
      const owned = (ports || []).filter((port) => port.unit === name).map((port) => port.port)
      return { name, description: cells.slice(4).join(' ') || null, ports: [...new Set(owned)].sort((left, right) => left - right) }
    })
}
// "Wed 2026-11-11 11:30:00 UTC" → ISO(UTC · GMT 만)
const TIMER_TIME = /\b\w{3} (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (\S+)/g
function timerRows(lines: string[] | undefined): TimerRow[] | null {
  if (!lines) return null
  const rows: TimerRow[] = []
  for (const line of lines) {
    const cells = line.split(/\s+/)
    const timerAt = cells.findIndex((cell) => cell.endsWith('.timer'))
    if (timerAt < 0) continue
    const times = [...line.slice(0, line.indexOf(cells[timerAt]!)).matchAll(TIMER_TIME)].map((match) => (match[3] === 'UTC' || match[3] === 'GMT' ? `${match[1]}T${match[2]}Z` : null))
    // 앞이 "-"(다음 차례 없음 · n/a)면 시각이 하나뿐이고 그것이 last
    const startsWithTime = /^\w{3} \d{4}-/.test(line)
    const next = startsWithTime ? (times[0] ?? null) : null
    const last = startsWithTime ? (times[1] ?? null) : (times[0] ?? null)
    const activates = cells[timerAt + 1]
    rows.push({ unit: cells[timerAt]!.replace(/\.timer$/, ''), activates: activates ? activates.replace(/\.service$/, '') : null, next, last })
  }
  return rows
}
// crontab: "분 시 일 월 요일 명령" · "@reboot 명령" — 명령은 경로 끝 이름만
function cronRows(lines: string[] | undefined): CronRow[] | null {
  if (!lines) return null
  return lines.map((line) => {
    const cells = line.split(/\s+/)
    const width = cells[0]!.startsWith('@') ? 1 : 5
    const word = cells[width]
    const command = word && !word.includes('=') ? word.split('/').pop() || null : null
    return { schedule: cells.slice(0, width).join(' '), command }
  })
}
// ufw status 첫 줄 "Status: active"
function ufwState(lines: string[] | undefined): 'active' | 'inactive' | null {
  const state = /^Status:\s*(\w+)/.exec((lines || [])[0] || '')?.[1]
  return state === 'active' || state === 'inactive' ? state : null
}
// "monarx-agent.service enabled enabled" 다음 줄이 is-active 값 — 유닛 줄이 없으면 설치 안 됨
function monarxState(lines: string[] | undefined): string | null {
  if (!lines || !lines[0]?.startsWith('monarx-agent.service')) return null
  return /^[a-z-]+$/.test(lines[1] || '') ? lines[1]! : null
}
const proxyPort = (target: string | undefined): number | null => {
  const port = Number(/:(\d+)\/?$/.exec(target || '')?.[1])
  return Number.isInteger(port) && port > 0 ? port : null
}
// Caddyfile 줄(grep -n): "줄:글". 들여쓰지 않고 { 로 끝나는 줄이 사이트 머리(스니펫 (이름) · 전역 { 빼고) ·
// 머리 바로 위로 이어진 주석의 첫 줄이 설명 · 그 뒤 reverse_proxy · root 는 마지막 머리의 것
function caddySites(lines: string[] | undefined): SiteRow[] | null {
  if (!lines) return null
  const sites: SiteRow[] = []
  let comments: { at: number; text: string }[] = []
  let current: SiteRow | null = null
  for (const raw of lines) {
    const match = /^(\d+):(.*)$/.exec(raw)
    if (!match) continue
    const at = Number(match[1])
    const body = match[2]!
    const text = body.trim()
    if (/^#/.test(body)) {
      // 끊긴 주석 덩어리는 새로 시작
      if (comments.length && comments[comments.length - 1]!.at !== at - 1) comments = []
      comments.push({ at, text: text.replace(/^#+\s*/, '') })
      continue
    }
    if (/^\S/.test(body) && text.endsWith('{') && !text.startsWith('(') && !text.startsWith('import')) {
      const addresses = text.slice(0, -1).split(/[\s,]+/).filter(Boolean)
      const block = comments.length && comments[comments.length - 1]!.at === at - 1 ? comments : []
      const first = block.find((line) => line.text)
      current = { addresses, description: first ? first.text : null, ports: [], static: false, source: 'caddy' }
      if (addresses.length) sites.push(current)
      comments = []
      continue
    }
    comments = []
    if (!current) continue
    const cells = text.replace(/\s+#.*$/, '').split(/\s+/)
    if (cells[0] === 'reverse_proxy') {
      for (const target of cells.slice(1)) {
        const port = proxyPort(target)
        if (port !== null && !current.ports.includes(port)) current.ports.push(port)
      }
    } else if (cells[0] === 'root') current.static = true
  }
  return sites
}
// nginx -T 중 server_name 줄마다 사이트 하나(설명 없음) — 앞뒤 listen · root 는 서버 블록을 가르지 못해 읽지 않는다
function nginxSites(lines: string[] | undefined): SiteRow[] | null {
  if (!lines) return null
  return lines
    .filter((line) => /^server_name\s/.test(line))
    .map((line) => line.replace(/^server_name\s+/, '').replace(/;.*$/, '').split(/\s+/).filter((name) => name && name !== '_'))
    .filter((addresses) => addresses.length)
    .map((addresses) => ({ addresses, description: null, ports: [], static: false, source: 'nginx' as const }))
}
function serverDetail(found: Map<string, string[]>): ServerDetail {
  const ports = openPorts(found.get('ports'), unitsByPid(found.get('units')))
  const caddy = caddySites(found.get('caddy'))
  const nginx = nginxSites(found.get('nginx'))
  const model = /^Model name:\s*(.+)$/.exec((found.get('cpumodel') || [])[0] || '')?.[1]?.trim()
  return {
    ports,
    cpuModel: model || null,
    serviceInfo: serviceInfo(found.get('servicedesc'), ports),
    timers: timerRows(found.get('timers')),
    cron: cronRows(found.get('cron')),
    ufw: ufwState(found.get('ufw')),
    monarx: monarxState(found.get('monarx')),
    // 칸이 있어도 비었으면(파일 없음 · 웹 서버 없음) 둘 다 [] — 옛 코어(칸 없음)만 null
    sites: caddy || nginx ? [...(caddy || []), ...(nginx || [])] : null,
  }
}

// ssh-run.sh --status 의 출력(끝 칸 "==end" 까지 와야 다 읽은 것) — 모자라면 null
export function parseStatus(output: string): ServerHealth | null {
  const found = sections(output)
  if (!found.has('end')) return null
  const loads = (found.get('load') || [])[0]?.split(/\s+/) || []
  const load1 = toNumber(loads[0])
  const cpus = toNumber((found.get('cpu') || [])[0])
  const ticks = cpuTicks((found.get('stat') || [])[0])
  const net = netBytes(found.get('net') || [])
  const totals = memTotals(found.get('mem') || [])
  const containers = containerRows(found.get('docker'), containerStats(found.get('stats') || []))
  const podman = podmanRows(found.get('podman'), containerStats(found.get('podstats') || []))
  const pods = podRows(found.get('pods'))
  const supervisor = supervisorRows(found.get('supervisor'))
  const pm2 = pm2Rows(found.get('pm2'))
  const serviceNames = found.has('services') ? (found.get('services') || []).map((line) => line.replace(/\.service$/, '')).filter(Boolean) : null
  const osLine = (found.get('os') || [])[0]
  const os = osLine ? osLine.replace(/^PRETTY_NAME=/, '').replace(/^"|"$/g, '').trim() || null : null
  const disks = diskList(found.get('disks') || [])
  const fullest = disks.length ? Math.max(...disks.map((disk) => disk.percent)) : diskPercent(found.get('disk') || [])
  const uptime = toNumber((found.get('uptime') || [])[0]?.split(/\s+/)[0])
  return {
    ok: true,
    load1,
    load5: toNumber(loads[1]),
    load15: toNumber(loads[2]),
    cpus,
    cpuPercent: instantCpu(ticks, cpuTicks((found.get('stat2') || [])[0])),
    counters: ticks ? { ...ticks, rx: net?.rx ?? null, tx: net?.tx ?? null } : null,
    rxBytes: null,
    txBytes: null,
    memTotal: totals.mem,
    swapTotal: totals.swap,
    rootDisk: rootDisk(found.get('disk') || []),
    os,
    kernel: (found.get('kernel') || [])[0] || null,
    memPercent: memoryPercent(found.get('mem') || []),
    diskPercent: fullest,
    disks,
    swapPercent: swapPercent(found.get('mem') || []),
    uptimeSeconds: uptime === null ? null : Math.floor(uptime),
    failed: (found.get('failed') || []).map((line) => line.split(/\s+/)[0]!.replace(/\.service$/, '')).filter(Boolean),
    running: serviceNames ? serviceNames.length : toNumber((found.get('running') || [])[0]),
    services: serviceNames,
    docker: dockerSummary(containers),
    containers,
    top: topProcesses(found.get('top') || []),
    podman,
    pods,
    supervisor,
    pm2,
    detected: unreadable(found, { podman: podman !== null, kubectl: pods !== null, supervisorctl: supervisor !== null, pm2: pm2 !== null }),
    errors: toNumber((found.get('errors') || [])[0]),
    updates: toNumber((found.get('updates') || [])[0]),
    ...serverDetail(found),
  }
}

// 앞 읽기와의 차이 — CPU % · 받은 · 보낸 바이트. 앞 읽기가 너무 오래됐거나(15분) 값이 줄었으면(서버가 다시 켜짐) 내지 않는다
export const RATE_GAP_MS = 15 * 60 * 1000
export function withRates(health: ServerHealth, at: number, previous: { t: number; counters: Counters } | null): ServerHealth {
  const now = health.counters
  if (!now || !previous || at - previous.t > RATE_GAP_MS || at <= previous.t) return health
  const before = previous.counters
  const spent = now.total - before.total
  const busy = now.busy - before.busy
  // 1초 사이 두 번 읽은 값이 있으면 그것(지금 값) — 앞 읽기 차이는 옛 코어 대비
  const cpuPercent = health.cpuPercent ?? (spent > 0 && busy >= 0 ? percent(busy, spent) : null)
  const diff = (current: number | null, past: number | null) => (current !== null && past !== null && current >= past ? current - past : null)
  return { ...health, cpuPercent, rxBytes: diff(now.rx, before.rx), txBytes: diff(now.tx, before.tx) }
}

// ssh 실패 글 → 이유 이름(코어 scripts/lib/servers.mjs 접속 시험과 같은 갈래)
export function failReason(stderr: string, timedOut: boolean): ServerFailReason {
  if (timedOut) return 'timeout'
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(stderr)) return 'host-key'
  if (/Permission denied|publickey|password|Too many authentication failures/i.test(stderr)) return 'key-needed'
  if (/Could not resolve|Connection refused|timed out|No route to host|Network is unreachable|Connection closed|Connection reset/i.test(stderr)) return 'unreachable'
  return 'failed'
}

// ── 시간 기록 — 앱이 읽을 때마다 숫자만 서버별 파일 한 줄(JSON Lines · 이 맥 팩 데이터 state/server-history/<이름>.jsonl).
// 주소 · 원문 · 비밀값은 넣지 않는다. 7일 지난 줄은 쓸 때 지운다. 읽지 못한 때는 쓰지 않는다(그래프에서 빈 칸)
// load — 1분 부하 · rx · tx — 앞 읽기부터 받은 · 보낸 바이트 · counters — 다음 읽기의 차이를 낼 누적 값(앱을 다시 켜도 이어지게)
export type HistoryPoint = { t: number; cpu: number | null; mem: number | null; swap: number | null; disk: number | null; ms: number | null; fail: number; load: number | null; rx: number | null; tx: number | null; counters?: Counters | null }
export const HISTORY_MS = 7 * 24 * 60 * 60 * 1000

// sarBacked — 서버 sar 기록을 읽을 수 있는 서버(사용자 결정 2026-11-09): CPU · 메모리 · 스왑 · 부하 · 송수신은 sar 가 그래프를 맡으니
// 이 맥 기록에는 디스크 · 응답 시간 · 실패 수만 쌓는다(차이 계산용 누적 값도 쌓지 않는다 — 앞 읽기는 창 메모리로)
export function historyPoint(reading: ServerReading, sarBacked = false): HistoryPoint | null {
  const status = reading.status
  if (!status.ok) return null
  if (sarBacked) return { t: reading.at, cpu: null, mem: null, swap: null, disk: status.diskPercent, ms: reading.web?.ok ? reading.web.ms : null, fail: status.failed.length + (status.docker?.down.length ?? 0), load: null, rx: null, tx: null }
  return {
    t: reading.at,
    cpu: status.cpuPercent,
    mem: status.memPercent,
    swap: status.swapPercent,
    disk: status.diskPercent,
    ms: reading.web?.ok ? reading.web.ms : null,
    fail: status.failed.length + (status.docker?.down.length ?? 0),
    load: status.load1,
    rx: status.rxBytes,
    tx: status.txBytes,
    counters: status.counters,
  }
}

// sar 서버의 지금 읽기 — 파일에는 줄인 점(historyPoint sarBacked)을 쓰되 이 창 메모리에 온전한 점을 LIVE_MS 동안 둔다.
// 화면에 넘길 때 같은 시각의 줄인 점을 온전한 점으로 바꿔 끼운다 — sar 가 아직 기록하지 않은 최근 칸(10분 간격)을 지금 읽기로 채운다
export const LIVE_MS = 2 * 60 * 60 * 1000
export function withLive(points: HistoryPoint[], live: HistoryPoint[]): HistoryPoint[] {
  if (!live.length) return points
  const times = new Set(live.map((point) => point.t))
  return [...points.filter((point) => !times.has(point.t)), ...live].sort((left, right) => left.t - right.t)
}

function countersOf(value: unknown): Counters | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const busy = numberOrNull(item.busy)
  const total = numberOrNull(item.total)
  return busy === null || total === null ? null : { busy, total, rx: numberOrNull(item.rx), tx: numberOrNull(item.tx) }
}

const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// 파일 글 → 7일 안의 점(시간 순) · 깨진 줄은 건너뛴다
export function parseHistory(text: string, now: number): HistoryPoint[] {
  const points: HistoryPoint[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line) as Record<string, unknown>
      const at = numberOrNull(item.t)
      if (at === null || at < now - HISTORY_MS || at > now + 60_000) continue
      // 옛 줄(counters 칸 없음)의 cpu 는 부하 ÷ 코어라 CPU 사용률이 아니다(결정 D8) — 빈 칸으로
      points.push({ t: at, cpu: 'counters' in item ? numberOrNull(item.cpu) : null, mem: numberOrNull(item.mem), swap: numberOrNull(item.swap), disk: numberOrNull(item.disk), ms: numberOrNull(item.ms), fail: numberOrNull(item.fail) ?? 0, load: numberOrNull(item.load), rx: numberOrNull(item.rx), tx: numberOrNull(item.tx), counters: countersOf(item.counters) })
    } catch {
      // 쓰다 끊긴 줄
    }
  }
  return points.sort((left, right) => left.t - right.t)
}

// 기록 끝에서 누적 값이 있는 마지막 점 — 앱을 다시 켠 뒤 첫 읽기도 CPU % · 트래픽을 낼 수 있게
export function lastCounters(points: HistoryPoint[]): { t: number; counters: Counters } | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!
    if (point.counters) return { t: point.t, counters: point.counters }
  }
  return null
}

export const historyText = (points: HistoryPoint[]) => points.map((point) => JSON.stringify(point)).join('\n') + (points.length ? '\n' : '')

// 그래프 구간 — 칸 하나가 읽는 간격(3분)보다 넓어야 맥이 켜져 있던 동안 선이 끊기지 않는다
export type HistoryRange = '1h' | '24h' | '7d'
// 서버 화면 위쪽 카드 줄 — 1열 서버 자원 · 2열 네트워크(D11). 빠진 카드는 그 줄 안에서만 12칸을 나눈다(다른 줄로 넘어가지 않는다)
export const METRIC_ROWS = [['cpu', 'load', 'mem', 'disk'], ['rx', 'tx', 'ms']] as const
export type MetricKey = (typeof METRIC_ROWS)[number][number]
export function metricRows(present: readonly MetricKey[]): { key: MetricKey; span: number }[][] {
  return METRIC_ROWS.map((row) => row.filter((key) => present.includes(key)))
    .filter((row) => row.length > 0)
    .map((row) => row.map((key) => ({ key, span: 12 / row.length })))
}

export const HISTORY_RANGES: Record<HistoryRange, { span: number; buckets: number }> = {
  '1h': { span: 60 * 60 * 1000, buckets: 15 },
  '24h': { span: 24 * 60 * 60 * 1000, buckets: 96 },
  '7d': { span: HISTORY_MS, buckets: 168 },
}
export type HistoryMetric = 'cpu' | 'mem' | 'disk' | 'ms' | 'load' | 'rx' | 'tx'

// 구간 칸마다 평균(수신 · 송신은 그 칸 동안 오간 바이트 합) — 점이 없는 칸은 null(맥이 꺼졌거나 못 읽음 → 선을 끊는다)
const SUMMED: ReadonlySet<HistoryMetric> = new Set<HistoryMetric>(['rx', 'tx'])
// 칸 i 의 시작 시각 — 그래프에 마우스를 올렸을 때 보여 준다
export const bucketStart = (range: HistoryRange, now: number, index: number) => now - HISTORY_RANGES[range].span + index * (HISTORY_RANGES[range].span / HISTORY_RANGES[range].buckets)
// fill — 서버 sar 기록(parseSar) · 있으면 CPU · 부하 · 메모리 · 송수신은 sar 값 먼저, sar 가 아직 없는 칸(최근 10분 등)만 이 맥 기록
export function bucketHistory(points: HistoryPoint[], range: HistoryRange, now: number, fill: SarPoint[] = []): Record<HistoryMetric, (number | null)[]> {
  const { span, buckets } = HISTORY_RANGES[range]
  const step = span / buckets
  const start = now - span
  const metrics: HistoryMetric[] = ['cpu', 'mem', 'disk', 'ms', 'load', 'rx', 'tx']
  const sums = Object.fromEntries(metrics.map((metric) => [metric, Array.from({ length: buckets }, () => ({ total: 0, count: 0 }))])) as Record<HistoryMetric, { total: number; count: number }[]>
  for (const point of points) {
    if (point.t < start || point.t > now) continue
    const index = Math.min(buckets - 1, Math.floor((point.t - start) / step))
    for (const metric of metrics) {
      const value = point[metric]
      if (value === null || value === undefined) continue
      sums[metric][index]!.total += value
      sums[metric][index]!.count += 1
    }
  }
  const valueOf = (metric: HistoryMetric, cell: { total: number; count: number }) => {
    if (!cell.count) return null
    return SUMMED.has(metric) ? cell.total : Math.round((cell.total / cell.count) * 100) / 100
  }
  const own = Object.fromEntries(metrics.map((metric) => [metric, sums[metric].map((cell) => valueOf(metric, cell))])) as Record<HistoryMetric, (number | null)[]>
  if (!fill.length) return own
  const fromSar = bucketSar(fill, range, now)
  for (const metric of SAR_METRICS) own[metric] = own[metric].map((value, index) => fromSar[metric][index] ?? value)
  return own
}

// ── 서버 sar 기록(ssh-run.sh --history) — sysstat 하루 파일을 sar 로 읽은 표. 이 맥 기록이 빈 구간(앱이 꺼져 있던 때)을 채운다.
// 모양(sysstat 소스 master — activity.c hdr_line · common.c print_gal_header · sa_common.c set_record_timestamp_string · man sar):
//   "==tz" 다음 줄 서버 date +%z · "==sa" 마다 파일 하나: 머리 "Linux <판> (<이름>) \t<YYYY-MM-DD> \t_<arch>_\t(<n> CPU)"(S_TIME_FORMAT=ISO)
//   그 뒤 활동마다 머리 줄 "HH:MM:SS  CPU %user … %idle" · "… runq-sz plist-sz ldavg-1 …" · "… kbmemfree kbavail kbmemused %memused …" · "… IFACE rxpck/s txpck/s rxkB/s txkB/s …"
//   행 "HH:MM:SS <값…>" · "Average:" 줄 · "HH:MM:SS  LINUX RESTART (n CPU)" 줄. 시각은 sar 를 돌린 쪽 지역 시간(man -t) · rxkB/s 는 초당 KiB(pr_stats.c — 초당 바이트 ÷ 1024 · 1024 를 곱해 바이트로)
//   %memused = (전체 − kbavail) ÷ 전체(pr_stats.c — 이 맥 기록 mem 과 같은 뜻) · 숫자는 LC_NUMERIC 를 따라 , 일 수 있다
// 점 하나 = 그 행이 덮는 구간(앞 행부터 · span ms) — rx · tx 는 그 구간 동안 오간 바이트(가상 장치 VIRTUAL_NET 빼고 합)
export type SarPoint = { t: number; span: number; cpu: number | null; load: number | null; mem: number | null; rx: number | null; tx: number | null }
const SAR_METRICS = ['cpu', 'load', 'mem', 'rx', 'tx'] as const
const SAR_SPAN_MAX = 2 * 60 * 60 * 1000
const SAR_TIME = /^(\d\d):(\d\d):(\d\d)$/

const sarNumber = (text: string | undefined) => {
  const value = Number((text ?? '').replace(',', '.'))
  return text !== undefined && Number.isFinite(value) ? value : null
}

export function parseSar(output: string, now: number): SarPoint[] {
  const lines = output.split('\n')
  const tzLine = lines[lines.indexOf('==tz') + 1] ?? ''
  const tz = /^([+-])(\d\d)(\d\d)$/.exec(tzLine.trim())
  if (!lines.includes('==tz') || !tz) return []
  const offset = (tz[1] === '-' ? -1 : 1) * (Number(tz[2]) * 60 + Number(tz[3])) * 60_000
  type Row = { t: number; cpu: number | null; load: number | null; mem: number | null; rx: number; tx: number; net: boolean }
  const rows = new Map<number, Row>()
  // 활동마다 행 시각 목록(구간 계산) — 파일 · 활동 · 다시 켜짐마다 끊는다
  const runs: number[][] = []
  let day: [number, number, number] | null = null
  let columns: string[] = []
  let run: number[] = []
  const endRun = () => {
    if (run.length) runs.push(run)
    run = []
  }
  const rowAt = (at: number) => {
    let row = rows.get(at)
    if (!row) rows.set(at, (row = { t: at, cpu: null, load: null, mem: null, rx: 0, tx: 0, net: false }))
    return row
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '==sa' || line === '==end') {
      endRun()
      day = null
      columns = []
      continue
    }
    const date = /\t(\d{4})-(\d\d)-(\d\d)\s/.exec(raw)
    if (/^Linux\s/.test(line) && date) {
      day = [Number(date[1]), Number(date[2]), Number(date[3])]
      continue
    }
    const words = line.split(/\s+/)
    const time = SAR_TIME.exec(words[0] ?? '')
    if (!day || !time) {
      if (!line) endRun()
      continue
    }
    if (words[1] === 'LINUX' && words[2] === 'RESTART') {
      endRun()
      continue
    }
    // 머리 줄 — 값이 아니라 칸 이름(CPU · runq-sz · kbmemfree · IFACE)
    if (['CPU', 'runq-sz', 'kbmemfree', 'IFACE'].includes(words[1] ?? '')) {
      endRun()
      columns = words
      continue
    }
    if (!columns.length || words.length !== columns.length) continue
    const at = Date.UTC(day[0], day[1] - 1, day[2], Number(time[1]), Number(time[2]), Number(time[3])) - offset
    if (at < now - HISTORY_MS || at > now + 60_000) continue
    const value = (name: string) => sarNumber(words[columns.indexOf(name)])
    const row = rowAt(at)
    if (columns[1] === 'CPU') {
      const idle = value('%idle')
      if (words[1] === 'all' && idle !== null) row.cpu = Math.round((100 - idle) * 100) / 100
    } else if (columns[1] === 'runq-sz') {
      row.load = value('ldavg-1')
    } else if (columns[1] === 'kbmemfree') {
      row.mem = value('%memused')
    } else {
      const rx = value('rxkB/s')
      const tx = value('txkB/s')
      // 같은 시각 행이 장치마다 — 구간 목록에는 첫 장치에서 한 번만
      if (run[run.length - 1] !== at) run.push(at)
      if (VIRTUAL_NET.test(words[1] ?? '') || rx === null || tx === null) continue
      row.rx += rx
      row.tx += tx
      row.net = true
      continue
    }
    run.push(at)
  }
  endRun()
  // 행이 덮는 구간 — 같은 흐름의 앞 행부터(첫 행은 다음 행까지 간격) · 2시간이 넘으면 sar 가 멈췄던 것이라 버린다
  const spans = new Map<number, number>()
  for (const times of runs) {
    times.forEach((at, index) => {
      const before = index > 0 ? at - times[index - 1]! : null
      const after = index + 1 < times.length ? times[index + 1]! - at : null
      const span = before ?? after
      if (span !== null && span > 0 && span <= SAR_SPAN_MAX) spans.set(at, Math.max(spans.get(at) ?? 0, span))
    })
  }
  const points: SarPoint[] = []
  for (const row of rows.values()) {
    const span = spans.get(row.t)
    if (!span) continue
    const bytes = (perSecond: number) => (row.net ? Math.round(perSecond * 1024 * (span / 1000)) : null)
    points.push({ t: row.t, span, cpu: row.cpu, load: row.load, mem: row.mem, rx: bytes(row.rx), tx: bytes(row.tx) })
  }
  return points.sort((left, right) => left.t - right.t)
}

// sar 점 → 그래프 칸 — 점의 구간 [t − span, t] 이 칸과 겹친 만큼(평균 값은 겹친 길이로 가중 평균 · rx · tx 는 바이트를 겹친 비율로 나눔)
function bucketSar(points: SarPoint[], range: HistoryRange, now: number): Record<(typeof SAR_METRICS)[number], (number | null)[]> {
  const { span, buckets } = HISTORY_RANGES[range]
  const step = span / buckets
  const start = now - span
  const cells = Object.fromEntries(SAR_METRICS.map((metric) => [metric, Array.from({ length: buckets }, () => ({ total: 0, weight: 0 }))])) as Record<(typeof SAR_METRICS)[number], { total: number; weight: number }[]>
  for (const point of points) {
    const from = Math.max(start, point.t - point.span)
    const to = Math.min(now, point.t)
    if (to <= from) continue
    const first = Math.max(0, Math.floor((from - start) / step))
    const last = Math.min(buckets - 1, Math.floor((to - start - 1) / step))
    for (let index = first; index <= last; index += 1) {
      const overlap = Math.min(to, start + (index + 1) * step) - Math.max(from, start + index * step)
      if (overlap <= 0) continue
      for (const metric of SAR_METRICS) {
        const value = point[metric]
        if (value === null) continue
        const cell = cells[metric][index]!
        if (SUMMED.has(metric)) cell.total += value * (overlap / point.span)
        else cell.total += value * overlap
        cell.weight += overlap
      }
    }
  }
  return Object.fromEntries(SAR_METRICS.map((metric) => [metric, cells[metric].map((cell) => {
    if (!cell.weight) return null
    return SUMMED.has(metric) ? Math.round(cell.total) : Math.round((cell.total / cell.weight) * 100) / 100
  })])) as Record<(typeof SAR_METRICS)[number], (number | null)[]>
}

// 응답 확인 오류 코드(node) → 이유 이름 — 원문(주소가 섞인다)은 넘기지 않는다
export function webFailReason(code: string | undefined): 'unreachable' | 'cert' | 'failed' {
  if (!code) return 'failed'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return 'cert'
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code)) return 'unreachable'
  return 'failed'
}
