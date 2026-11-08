// 서버 탐색기 — 코어 `scripts/ssh-run.sh <서버> --status` 출력 읽기 · 실패 이유 고르기 · 팩 servers[] 읽기 · 응답 확인 결과 · 시간 기록(7일)
// 출력은 "==이름" 줄로 칸을 나눈다(load · cpu · mem · disk · disks · failed · running · docker · uptime · errors · updates · end — ssh-run.sh STATUS_COMMAND).
// 원문(ssh 오류 글)은 화면에 올리지 않는다 — 주소 · 사용자 이름이 섞일 수 있다. 이유 이름만 고른다

export type ServerEntry = { name: string; host: string }
// down — 주의할 것(restarting · dead · 오류 종료 코드 · 코드를 모르는 exited) · stopped — 일부러 끈 것(exit 0 · docker stop 의 143 · created · paused)
export type DockerSummary = { up: number; total: number; down: string[]; stopped: string[] }
export type DiskUse = { mount: string; percent: number }
export type ServerHealth = {
  ok: true
  cpuPercent: number | null // 1분 부하 ÷ 코어 수(넘으면 100 으로 자른다)
  load1: number | null
  cpus: number | null
  memPercent: number | null // (전체 − available) ÷ 전체
  diskPercent: number | null // 가장 찬 마운트의 Capacity(마운트 목록이 없으면 df / )
  disks: DiskUse[] // 마운트마다(tmpfs 같은 가짜 파일 시스템 뺌)
  swapPercent: number | null // SWAP 이 없으면(전체 0) null
  uptimeSeconds: number | null
  errors: number | null // 최근 1시간 에러 로그 줄 수(journalctl 이 없으면 null)
  updates: number | null // 밀린 보안 업데이트 수(apt 가 없으면 null)
  failed: string[] // 멈춘 systemd 서비스 이름(.service 뗌)
  running: number | null // 도는 systemd 서비스 수
  docker: DockerSummary | null // docker 가 없거나 못 읽으면 null
}
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

// 정상으로 꺼진 종료 코드 — 0(스스로 끝남) · 143(docker stop 의 SIGTERM).
// 137 은 넣지 않는다 — docker stop 이 기다리다 SIGKILL 한 것과 OOM 이 같은 코드이고 docker ps 출력으로는 가를 수 없다
const STOPPED_CODES = new Set([0, 143])

// 줄 = "이름|State|Status"(Status 예: "Exited (143) 2 months ago") · 옛 형식 "이름|State" 도 읽는다(종료 코드를 모르면 주의)
function containerStopped(state: string, status: string | undefined): boolean {
  if (state === 'created' || state === 'paused') return true
  if (state !== 'exited') return false
  const code = status && /^Exited \((\d+)\)/.exec(status)
  return Boolean(code) && STOPPED_CODES.has(Number(code![1]))
}

function dockerSummary(lines: string[] | undefined): DockerSummary | null {
  if (!lines) return null
  const containers = lines.map((line) => line.split('|')).filter((parts) => (parts.length === 2 || parts.length === 3) && parts[0])
  if (!containers.length) return null
  const down: string[] = []
  const stopped: string[] = []
  for (const [name, state, statusText] of containers) {
    if (state === 'running') continue
    if (containerStopped(state!, statusText)) stopped.push(name!)
    else down.push(name!)
  }
  return { up: containers.length - down.length - stopped.length, total: containers.length, down, stopped }
}

// ssh-run.sh --status 의 출력(끝 칸 "==end" 까지 와야 다 읽은 것) — 모자라면 null
export function parseStatus(output: string): ServerHealth | null {
  const found = sections(output)
  if (!found.has('end')) return null
  const load1 = toNumber((found.get('load') || [])[0]?.split(/\s+/)[0])
  const cpus = toNumber((found.get('cpu') || [])[0])
  const disks = diskList(found.get('disks') || [])
  const fullest = disks.length ? Math.max(...disks.map((disk) => disk.percent)) : diskPercent(found.get('disk') || [])
  const uptime = toNumber((found.get('uptime') || [])[0]?.split(/\s+/)[0])
  return {
    ok: true,
    load1,
    cpus,
    cpuPercent: load1 !== null && cpus ? percent(load1, cpus) : null,
    memPercent: memoryPercent(found.get('mem') || []),
    diskPercent: fullest,
    disks,
    swapPercent: swapPercent(found.get('mem') || []),
    uptimeSeconds: uptime === null ? null : Math.floor(uptime),
    failed: (found.get('failed') || []).map((line) => line.split(/\s+/)[0]!.replace(/\.service$/, '')).filter(Boolean),
    running: toNumber((found.get('running') || [])[0]),
    docker: dockerSummary(found.get('docker')),
    errors: toNumber((found.get('errors') || [])[0]),
    updates: toNumber((found.get('updates') || [])[0]),
  }
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
export type HistoryPoint = { t: number; cpu: number | null; mem: number | null; swap: number | null; disk: number | null; ms: number | null; fail: number }
export const HISTORY_MS = 7 * 24 * 60 * 60 * 1000

export function historyPoint(reading: ServerReading): HistoryPoint | null {
  const status = reading.status
  if (!status.ok) return null
  return {
    t: reading.at,
    cpu: status.cpuPercent,
    mem: status.memPercent,
    swap: status.swapPercent,
    disk: status.diskPercent,
    ms: reading.web?.ok ? reading.web.ms : null,
    fail: status.failed.length + (status.docker?.down.length ?? 0),
  }
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
      points.push({ t: at, cpu: numberOrNull(item.cpu), mem: numberOrNull(item.mem), swap: numberOrNull(item.swap), disk: numberOrNull(item.disk), ms: numberOrNull(item.ms), fail: numberOrNull(item.fail) ?? 0 })
    } catch {
      // 쓰다 끊긴 줄
    }
  }
  return points.sort((left, right) => left.t - right.t)
}

export const historyText = (points: HistoryPoint[]) => points.map((point) => JSON.stringify(point)).join('\n') + (points.length ? '\n' : '')

// 그래프 구간 — 칸 하나가 읽는 간격(3분)보다 넓어야 맥이 켜져 있던 동안 선이 끊기지 않는다
export type HistoryRange = '1h' | '24h' | '7d'
export const HISTORY_RANGES: Record<HistoryRange, { span: number; buckets: number }> = {
  '1h': { span: 60 * 60 * 1000, buckets: 15 },
  '24h': { span: 24 * 60 * 60 * 1000, buckets: 96 },
  '7d': { span: HISTORY_MS, buckets: 168 },
}
export type HistoryMetric = 'cpu' | 'mem' | 'disk' | 'ms'

// 구간 칸마다 평균 — 점이 없는 칸은 null(맥이 꺼졌거나 못 읽음 → 선을 끊는다)
export function bucketHistory(points: HistoryPoint[], range: HistoryRange, now: number): Record<HistoryMetric, (number | null)[]> {
  const { span, buckets } = HISTORY_RANGES[range]
  const step = span / buckets
  const start = now - span
  const metrics: HistoryMetric[] = ['cpu', 'mem', 'disk', 'ms']
  const sums = Object.fromEntries(metrics.map((metric) => [metric, Array.from({ length: buckets }, () => ({ total: 0, count: 0 }))])) as Record<HistoryMetric, { total: number; count: number }[]>
  for (const point of points) {
    if (point.t < start || point.t > now) continue
    const index = Math.min(buckets - 1, Math.floor((point.t - start) / step))
    for (const metric of metrics) {
      const value = point[metric]
      if (value === null) continue
      sums[metric][index]!.total += value
      sums[metric][index]!.count += 1
    }
  }
  return Object.fromEntries(metrics.map((metric) => [metric, sums[metric].map((cell) => (cell.count ? Math.round((cell.total / cell.count) * 10) / 10 : null))])) as Record<HistoryMetric, (number | null)[]>
}

// 응답 확인 오류 코드(node) → 이유 이름 — 원문(주소가 섞인다)은 넘기지 않는다
export function webFailReason(code: string | undefined): 'unreachable' | 'cert' | 'failed' {
  if (!code) return 'failed'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return 'cert'
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code)) return 'unreachable'
  return 'failed'
}
