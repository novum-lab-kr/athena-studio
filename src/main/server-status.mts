// ── 서버 탐색기 — 팩 창 ─────────────────────────────────
// 탭 줄 [서버] 버튼 · 서버 탐색기(화면 ui/server-status.tsx)가 몇 분마다 부른다 — 칸이 닫혀 있어도(버튼 점). 팩 pack.json servers[] 를 읽고
// 서버마다 코어 `scripts/ssh-run.sh <서버> --status`(허용 목록 안의 고정 읽기 명령 · BatchMode · 묻지 않는다)를 한 번씩,
// servers[].health 주소가 있으면 이 맥에서 응답 코드 · 걸린 시간 · (https 면) 인증서 만료일을 본다.
// 읽을 때마다 숫자만 서버별 기록 파일에 한 줄(<본체>/.pack-data/state/server-history/<이름>.jsonl · 7일) — 주소 · 원문 · 비밀값은 쓰지 않는다.
// 서버에 sysstat 이 있으면 지난 기록(ssh-run.sh --history — sar · 10분에 한 번)을 같이 넘긴다(파일에 쓰지 않는다) — 그 서버는 CPU · 부하 · 메모리 · 송수신 그래프를 sar 로 그리고
// 이 맥 기록 파일에는 디스크 · 응답 시간 · 실패 수만 쌓는다(사용자 결정 2026-11-09)
// CPU % · 수신 · 송신은 누적 값(/proc/stat · /proc/net/dev)의 앞 읽기와의 차이 — 앞 값은 이 창 메모리 · 없으면 기록 끝 점(withRates)
// ssh 오류 원문은 화면에 넘기지 않는다(주소 · 사용자 이름이 섞일 수 있다) — 이유 이름만(src/lib/server-status.mts failReason)
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import type { TLSSocket } from 'node:tls'
import { execFile } from 'node:child_process'
import * as core from '../lib/core.mts'
import * as serverModel from '../lib/server-status.mts'
import type { Counters, HistoryPoint, SarPoint, ServerEntry, ServerReading, ServerStatus, WebCheck } from '../lib/server-status.mts'

// sar — 서버 sysstat 기록(빈 구간 채우기 · 서버에 sar · 기록이 없으면 빈 목록)
export type ServerStatusReply = { servers: ServerReading[]; history: Record<string, HistoryPoint[]>; sar: Record<string, SarPoint[]> }
export type ServerStatusCtx = {
  athenaDir: string | null
  serverList?: () => Promise<ServerEntry[]>
  serverStatus?: () => Promise<ServerStatusReply>
}

// 접속 10초(ssh-run.sh ConnectTimeout) + 명령 — 넘으면 끊고 timeout
const STATUS_TIMEOUT = 25000
const WEB_TIMEOUT = 10000
// 같은 팩 창이 둘이면 둘 다 읽는다 — 1분 안에 쓴 줄이 있으면 또 쓰지 않는다
const RECORD_GAP = 60_000
const DAY = 24 * 60 * 60 * 1000
// sar 기록 — 서버마다 10분에 한 번만 다시 읽는다(sysstat 기본 기록 간격 10분 · sar 서버는 CPU · 메모리 · 송수신 그래프를 sar 만 그린다) · 하루 파일 10개라 출력이 크다
// 못 읽었으면(접속 실패 · sar 없음) 10분 뒤 다시
const SAR_EVERY = 10 * 60 * 1000
const SAR_RETRY = 10 * 60 * 1000
const SAR_TIMEOUT = 30000
const SAR_BUFFER = 16 * 1024 * 1024

// 이 맥에서 응답 확인 — 본문은 받지 않는다(머리만 보고 끊는다)
function checkWeb(url: string): Promise<WebCheck> {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (result: WebCheck) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const client = url.startsWith('https:') ? https : http
    const request = client.request(url, { method: 'GET', timeout: WEB_TIMEOUT, headers: { 'user-agent': 'athena-studio' } }, (response) => {
      const ms = Date.now() - started
      let certDate: string | null = null
      let certDays: number | null = null
      const socket = response.socket as TLSSocket
      if (typeof socket.getPeerCertificate === 'function') {
        const end = new Date(socket.getPeerCertificate().valid_to || '')
        if (Number.isFinite(end.getTime())) {
          certDate = end.toISOString().slice(0, 10)
          certDays = Math.floor((end.getTime() - Date.now()) / DAY)
        }
      }
      response.destroy()
      finish({ ok: true, code: response.statusCode ?? 0, ms, certDate, certDays })
    })
    request.on('timeout', () => {
      request.destroy()
      finish({ ok: false, reason: 'timeout' })
    })
    request.on('error', (error: NodeJS.ErrnoException) => finish({ ok: false, reason: serverModel.webFailReason(error.code) }))
    request.end()
  })
}

export function installServerStatus(ctx: ServerStatusCtx): void {
  const readPack = (): Promise<unknown> => fs.promises.readFile(path.join(ctx.athenaDir || '', 'pack', 'pack.json'), 'utf8').then(JSON.parse).catch(() => null)
  // 이 창 본체 팩의 서버 목록 — pack.json 을 바로 읽는다(팩 레포 목록 pack-repos.mts 와 같은 자리)
  ctx.serverList = async () => serverModel.packServers(await readPack())

  const readOne = (server: ServerEntry): Promise<ServerStatus> => new Promise((resolve) => {
    const script = path.join(ctx.athenaDir || '', 'scripts', 'ssh-run.sh')
    // 옛 본체(코어 업데이트 전)는 상태 읽기가 없다
    if (!fs.existsSync(script)) return resolve({ ok: false, reason: 'core-old' })
    execFile('bash', [script, server.name, '--status'], { cwd: ctx.athenaDir as string, env: core.childEnv(process.env), encoding: 'utf8', timeout: STATUS_TIMEOUT, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const health = serverModel.parseStatus(stdout || '')
      if (health) return resolve(health)
      const timedOut = Boolean(error && (error as { killed?: boolean }).killed)
      resolve({ ok: false, reason: serverModel.failReason(String(stderr || ''), timedOut) })
    })
  })

  // 지난 기록(ssh-run.sh --history — sar) · 못 읽으면 빈 목록(옛 코어 · sar 없음 · 기록 없음 · 시간 넘김)
  const readSar = (server: ServerEntry): Promise<SarPoint[]> => new Promise((resolve) => {
    const script = path.join(ctx.athenaDir || '', 'scripts', 'ssh-run.sh')
    if (!fs.existsSync(script)) return resolve([])
    execFile('bash', [script, server.name, '--history'], { cwd: ctx.athenaDir as string, env: core.childEnv(process.env), encoding: 'utf8', timeout: SAR_TIMEOUT, maxBuffer: SAR_BUFFER }, (_error, stdout) => {
      resolve(serverModel.parseSar(stdout || '', Date.now()))
    })
  })
  const sarCache = new Map<string, { at: number; points: SarPoint[] }>()
  const sarOf = async (server: ServerEntry): Promise<SarPoint[]> => {
    const cached = sarCache.get(server.name)
    if (cached && Date.now() - cached.at < (cached.points.length ? SAR_EVERY : SAR_RETRY)) return cached.points
    const points = await readSar(server)
    sarCache.set(server.name, { at: Date.now(), points })
    return points
  }

  // 기록 자리 — 팩 데이터(.pack-data → <데이터>/packs/<팩>)가 있는 본체만. 없으면 기록 없이 지금 값만
  const historyDir = () => {
    const packData = path.join(ctx.athenaDir || '', '.pack-data')
    return ctx.athenaDir && fs.existsSync(packData) ? path.join(packData, 'state', 'server-history') : null
  }

  // 서버마다 앞 읽기의 누적 값(이 창 메모리)
  const lastSeen = new Map<string, { t: number; counters: Counters }>()
  const readHistory = async (dir: string | null, name: string): Promise<HistoryPoint[]> =>
    dir ? serverModel.parseHistory(await fs.promises.readFile(path.join(dir, `${name}.jsonl`), 'utf8').catch(() => ''), Date.now()) : []

  // 앞 읽기와의 차이를 채운다 — 메모리 · 기록 끝 점 중 더 최근 것(같은 팩 창이 둘이면 기록이 더 새로울 수 있다)
  const withRates = (reading: ServerReading, points: HistoryPoint[]): ServerReading => {
    if (!reading.status.ok) return reading
    const remembered = lastSeen.get(reading.name) ?? null
    const recorded = serverModel.lastCounters(points)
    const previous = remembered && (!recorded || remembered.t >= recorded.t) ? remembered : recorded
    const status = serverModel.withRates(reading.status, reading.at, previous)
    if (status.counters) lastSeen.set(reading.name, { t: reading.at, counters: status.counters })
    return { ...reading, status }
  }

  // 한 서버 기록에 (읽었으면) 한 줄 더하기 · 7일 지난 줄 지우기
  // sarBacked — sar 기록을 읽은 서버는 디스크 · 응답 시간 · 실패 수만(serverModel.historyPoint)
  const record = async (dir: string, reading: ServerReading, points: HistoryPoint[], sarBacked: boolean): Promise<HistoryPoint[]> => {
    const file = path.join(dir, `${reading.name}.jsonl`)
    const point = serverModel.historyPoint(reading, sarBacked)
    const last = points[points.length - 1]
    if (!point || (last && point.t - last.t < RECORD_GAP)) return points
    points.push(point)
    await fs.promises.mkdir(dir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(temp, serverModel.historyText(points))
    await fs.promises.rename(temp, file)
    return points
  }

  // 팩에서 빠진 서버의 기록 — 7일 동안 안 바뀌었으면 지운다
  const dropStale = async (dir: string, names: Set<string>) => {
    const files = await fs.promises.readdir(dir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.jsonl') || names.has(file.slice(0, -'.jsonl'.length))) continue
      const stat = await fs.promises.stat(path.join(dir, file)).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > serverModel.HISTORY_MS) await fs.promises.rm(path.join(dir, file), { force: true })
    }
  }

  // 서버마다 한 번씩(함께) — 서버가 없으면 빈 목록
  ctx.serverStatus = async () => {
    const targets = serverModel.packTargets(await readPack())
    const sar: Record<string, SarPoint[]> = {}
    const readings = await Promise.all(targets.map(async ({ health, ...server }): Promise<ServerReading> => {
      const [status, web, past] = await Promise.all([readOne(server), health ? checkWeb(health) : Promise.resolve(null), sarOf(server)])
      sar[server.name] = past
      return { ...server, status, web, at: Date.now() }
    }))
    const dir = historyDir()
    const history: Record<string, HistoryPoint[]> = {}
    const servers: ServerReading[] = []
    for (const raw of readings) {
      const points = await readHistory(dir, raw.name)
      const reading = withRates(raw, points)
      servers.push(reading)
      if (dir) history[reading.name] = await record(dir, reading, points, Boolean(sar[reading.name]?.length)).catch(() => points)
    }
    if (dir) await dropStale(dir, new Set(servers.map((server) => server.name)))
    return { servers, history, sar }
  }
}
