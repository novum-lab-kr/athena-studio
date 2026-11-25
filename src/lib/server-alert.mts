// 서버 문제 알림 판정(계획서 plans/feature/20261125-서버-문제-알림.md 결정 D1 · 5절) — 읽기 결과(server-status ServerReading)를 받아
// 새로 생긴 문제 · 풀린 문제를 사건으로 낸다. Electron 없이 돌아 `npm test` 로 검사한다(test/server-alert.test.js). 알림 글 · 보내기는 부르는 쪽(src/main/server-alert.mts)
// 문제(D1): 서비스 멈춤(failed — 서비스마다) · 사이트 응답 없음(web — 응답 확인 실패 · 5xx) · 서버 접속 안 됨(down — 연속 2번) · 디스크 90% 넘음(disk — 마운트마다) ·
//   인증서 14일 안 만료(cert — 남아 있으면 하루에 한 번 다시) · 메모리 90% 넘음(mem — 연속 2번 읽기)
// 같은 문제(서버 + 종류 + 대상)는 처음 한 번만 · 풀리면 '회복됨' 한 번 · 풀렸다 다시 생기면 다시.
// 그 읽기로 볼 수 없는 문제(접속 실패 중의 디스크 · 응답 확인 실패 중의 인증서 등)는 풀린 것으로 치지 않는다
import type { ServerReading } from './server-status.mts'

export type AlertKind = 'down' | 'failed' | 'web' | 'disk' | 'mem' | 'cert'
// value — 글에 쓸 값(down · web 은 이유 이름 — web 5xx 는 응답 코드 · disk · mem 은 % · cert 는 남은 날) · target — 서비스 이름 · 마운트(없으면 '')
export type AlertIssue = { kind: AlertKind; target: string; value: string | number }
export type AlertEvent = AlertIssue & { type: 'problem' | 'recovered'; server: string }
type Active = { since: number; told: number; value: string | number }
type ServerMemory = { at: number; streak: Record<string, number>; active: Record<string, Active> }
export type AlertMemory = Record<string, ServerMemory>

export const LIMIT_PERCENT = 90 // 디스크 · 메모리 — 넘으면(D1)
export const CERT_DAYS = 14 // 인증서 — 이 날 수 안에 끝나면(화면 경고와 같은 기준)
export const STREAK = 2 // down · mem — 연속 이만큼 읽어야(5절 흔들림 방지)
export const REMIND_MS = 24 * 60 * 60 * 1000 // 인증서 — 남아 있으면 하루에 한 번 다시
export const MIN_GAP_MS = 60_000 // 같은 서버를 이 안에 또 읽은 것은 세지 않는다(같은 팩 창이 둘이면 둘 다 읽는다)
const NEEDS_STREAK: ReadonlySet<AlertKind> = new Set(['down', 'mem'])

const keyOf = (issue: { kind: AlertKind; target: string }) => `${issue.kind}:${issue.target}`
const kindOfKey = (key: string) => key.slice(0, key.indexOf(':')) as AlertKind

// 그 읽기에 있는 문제 — 연속 조건은 보지 않는다
export function issuesOf(reading: ServerReading): AlertIssue[] {
  const { status, web } = reading
  const list: AlertIssue[] = []
  // 코어가 옛것인 것은 서버 문제가 아니다
  if (!status.ok && status.reason !== 'core-old') list.push({ kind: 'down', target: '', value: status.reason })
  if (status.ok) {
    for (const name of status.failed) list.push({ kind: 'failed', target: name, value: name })
    if (status.disks.length) {
      for (const disk of status.disks) if (disk.percent > LIMIT_PERCENT) list.push({ kind: 'disk', target: disk.mount, value: disk.percent })
    } else if ((status.diskPercent ?? 0) > LIMIT_PERCENT) {
      list.push({ kind: 'disk', target: '/', value: status.diskPercent ?? 0 })
    }
    if ((status.memPercent ?? 0) > LIMIT_PERCENT) list.push({ kind: 'mem', target: '', value: status.memPercent ?? 0 })
  }
  // 사이트 문제 — 응답 확인 실패(이유 이름) · 5xx 응답(코드 숫자 · 2026-11-25 사용자 결정 · 서버 칸 경고와 같은 기준)
  if (web && !web.ok) list.push({ kind: 'web', target: '', value: web.reason })
  if (web?.ok && web.code >= 500) list.push({ kind: 'web', target: '', value: web.code })
  if (web?.ok && web.certDays !== null && web.certDays < CERT_DAYS) list.push({ kind: 'cert', target: '', value: web.certDays })
  return list
}

// 그 읽기로 이 종류가 있는지 없는지 알 수 있나 — 모르면 풀린 것으로 치지 않고 연속 수도 그대로 둔다
function observable(kind: AlertKind, reading: ServerReading): boolean {
  const { status, web } = reading
  if (kind === 'down') return status.ok || status.reason !== 'core-old'
  if (kind === 'web') return web !== null
  if (kind === 'cert') return Boolean(web?.ok)
  return status.ok
}

// 기억 파일에서 읽은 값 — 모양이 다르면 빈 기억
export function memoryFrom(value: unknown): AlertMemory {
  const memory: AlertMemory = {}
  if (!value || typeof value !== 'object') return memory
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Partial<ServerMemory>
    const streak: Record<string, number> = {}
    for (const [key, count] of Object.entries(entry.streak ?? {})) if (typeof count === 'number') streak[key] = count
    const active: Record<string, Active> = {}
    for (const [key, item] of Object.entries(entry.active ?? {})) {
      if (item && typeof item.since === 'number' && typeof item.told === 'number' && (typeof item.value === 'string' || typeof item.value === 'number')) active[key] = { since: item.since, told: item.told, value: item.value }
    }
    memory[name] = { at: typeof entry.at === 'number' ? entry.at : 0, streak, active }
  }
  return memory
}

// 읽기 한 번(팩 서버 전부) — 사건 목록을 내고 memory 를 고친다. 목록에 없는 서버(팩에서 빠짐)는 조용히 잊는다
export function observe(memory: AlertMemory, readings: readonly ServerReading[], now: number): AlertEvent[] {
  const events: AlertEvent[] = []
  const names = new Set(readings.map((reading) => reading.name))
  for (const name of Object.keys(memory)) if (!names.has(name)) delete memory[name]
  for (const reading of readings) {
    const entry = memory[reading.name] ?? { at: 0, streak: {}, active: {} }
    memory[reading.name] = entry
    if (entry.at && reading.at - entry.at < MIN_GAP_MS) continue
    entry.at = reading.at
    const present = new Map(issuesOf(reading).map((issue) => [keyOf(issue), issue]))
    for (const [key, issue] of present) {
      if (NEEDS_STREAK.has(issue.kind)) {
        entry.streak[key] = (entry.streak[key] ?? 0) + 1
        if (entry.streak[key] < STREAK) continue
      }
      const active = entry.active[key]
      if (!active) {
        entry.active[key] = { since: now, told: now, value: issue.value }
        events.push({ type: 'problem', server: reading.name, ...issue })
        continue
      }
      active.value = issue.value
      if (issue.kind === 'cert' && now - active.told >= REMIND_MS) {
        active.told = now
        events.push({ type: 'problem', server: reading.name, ...issue })
      }
    }
    for (const key of Object.keys(entry.streak)) if (!present.has(key) && observable(kindOfKey(key), reading)) delete entry.streak[key]
    for (const [key, active] of Object.entries(entry.active)) {
      const kind = kindOfKey(key)
      if (present.has(key) || !observable(kind, reading)) continue
      delete entry.active[key]
      events.push({ type: 'recovered', server: reading.name, kind, target: key.slice(kind.length + 1), value: active.value })
    }
  }
  return events
}

export type AlertSay = (key: string, values?: Record<string, string | number>) => string
// 알림 글 — 제목 '<서버> 문제' · '<서버> 회복됨' / 본문 = 무엇이(서버 칸 경고 줄과 같은 말)
export function alertText(event: AlertEvent, say: AlertSay): { title: string; body: string } {
  const server = event.server
  if (event.type === 'recovered') {
    const body = say(`serverAlert.ok.${event.kind}`, { name: event.target, mount: event.target })
    return { title: say('serverAlert.recovered', { server }), body }
  }
  const title = say('serverAlert.problem', { server })
  if (event.kind === 'down') return { title, body: say('serverAlert.down', { reason: say(`server.reason.${event.value}`) }) }
  if (event.kind === 'web' && typeof event.value === 'number') return { title, body: say('server.warn.http', { code: event.value }) }
  if (event.kind === 'web') return { title, body: say('serverAlert.web', { reason: say(`server.web.${event.value}`) }) }
  if (event.kind === 'failed') return { title, body: say('serverAlert.failed', { name: event.target }) }
  if (event.kind === 'disk') return { title, body: say('server.warn.disk', { mount: event.target, percent: event.value }) }
  if (event.kind === 'mem') return { title, body: say('server.warn.mem', { percent: event.value }) }
  return { title, body: Number(event.value) < 0 ? say('server.warn.certGone') : say('server.warn.cert', { days: event.value }) }
}
