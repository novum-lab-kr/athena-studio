// 시험(격리) 앱 켜기 · 끄기 — scripts/dev-app.js test-start · test-stop 이 쓴다.
// 켤 때 띄운 pid 를 격리한 스튜디오 집의 기록 파일(test-app.json)에 적고, 끌 때는 그 pid 와 그 자식(+ 그 집의 데몬 접속 파일 pid)만 끈다.
// 프로세스 목록에서 이름으로 짐작해 고르지 않는다 — 2026-11-08 시험 앱을 끄던 에이전트가 사용자 개발 앱(Electron · 부모 node)을 잘못 끄고 앱이 안 켜졌다.
// dev-app.js(CommonJS)가 require 한다 — Node 22.18 이상은 .mts 를 타입만 지우고 읽는다
import fs from 'node:fs'
import path from 'node:path'

export const RECORD_NAME = 'test-app.json'
export const LOG_NAME = 'test-app.log'
const DAEMON_ENDPOINT = 'daemon-dev.json' // 개발 앱 데몬 접속 파일(src/lib/studio-home.js appIdentity) — 데몬이 자기 pid 를 적는다

export type TestAppRecord = { pid: number; startedAt: string; home: string; at: string }
export type ProcessRow = { pid: number; ppid: number }
export type StopDeps = {
  rows: () => ProcessRow[] // 지금 프로세스 목록(pid · 부모 pid 만)
  startedAt: (pid: number) => string // 그 pid 가 시작한 시각(ps lstart) — 없으면 ''
  alive: (pid: number) => boolean
  kill: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
}
export type StopResult = { ok: boolean; reason: string; stopped: number[] }

export const recordPath = (home: string) => path.join(home, RECORD_NAME)

// 격리 집으로 쓸 수 없는 자리 — 비었거나 · 상대 경로거나 · 진짜 스튜디오 집(~/.athena-studio)이거나 그 안 · 그 바깥(홈 등)
export function homeProblem(home: string, realStudioHome: string): string {
  if (!home) return '--home <임시 폴더> 가 필요해요'
  if (!path.isAbsolute(home)) return `--home 은 절대 경로로 주세요: ${home}`
  const resolved = path.resolve(home)
  const real = path.resolve(realStudioHome)
  const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`)
  if (inside(real, resolved) || inside(resolved, real)) return `진짜 스튜디오 집(${real})과 겹치는 자리는 시험 앱 집으로 쓰지 않아요: ${resolved}`
  return ''
}

export function readRecord(home: string): TestAppRecord | null {
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(recordPath(home), 'utf8'))
    if (!saved || typeof saved !== 'object') return null
    const { pid, startedAt, at } = saved as Record<string, unknown>
    if (!Number.isInteger(pid) || (pid as number) <= 1 || typeof startedAt !== 'string' || !startedAt) return null
    return { pid: pid as number, startedAt, home: path.resolve(home), at: typeof at === 'string' ? at : '' }
  } catch {
    return null
  }
}

export function writeRecord(home: string, record: TestAppRecord) {
  const file = recordPath(home)
  const staging = `${file}.tmp`
  fs.writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`)
  fs.renameSync(staging, file)
}

// 그 집의 데몬이 적은 pid — 데몬은 앱보다 오래 살고(떼어 띄움) 앱이 꺼진 뒤에는 앱의 자식이 아니다
export function daemonPid(home: string): number {
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(path.join(home, DAEMON_ENDPOINT), 'utf8'))
    const pid = saved && typeof saved === 'object' ? (saved as Record<string, unknown>).pid : 0
    return Number.isInteger(pid) && (pid as number) > 1 ? (pid as number) : 0
  } catch {
    return 0
  }
}

// `ps -axo pid=,ppid=` 출력 → 줄마다 pid · 부모 pid
export function parseRows(text: string): ProcessRow[] {
  return text
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length === 2 && parts.every((value) => Number.isInteger(value) && value > 0))
    .map(([pid, ppid]) => ({ pid: pid as number, ppid: ppid as number }))
}

// roots 와 그 자손 전부(roots 포함) — 부모 → 자식 표를 한 번 만들고 넓이 우선으로
export function descendantsOf(rows: ProcessRow[], roots: number[]): number[] {
  const children = new Map<number, number[]>()
  for (const { pid, ppid } of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  const seen = new Set<number>()
  const queue = roots.filter((pid) => pid > 1)
  while (queue.length) {
    const pid = queue.shift() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return [...seen]
}

// 기록한 pid 와 자식 · 그 집 데몬과 자식만 끈다. 기록이 없거나 · 그 pid 가 이미 끝났거나 · 같은 번호를 다른 프로세스가 쓰면(시작 시각이 다름) 앱 쪽은 끄지 않는다
export async function stopTestApp(home: string, deps: StopDeps, { graceMs = 10_000 } = {}): Promise<StopResult> {
  const record = readRecord(home)
  const roots: number[] = []
  let reason = ''
  let refused = false
  if (!record) reason = `기록(${recordPath(home)})이 없어 앱은 끄지 않아요`
  else if (!deps.alive(record.pid)) reason = `기록한 앱(pid ${record.pid})은 이미 끝났어요`
  else if (deps.startedAt(record.pid) !== record.startedAt) {
    refused = true
    reason = `pid ${record.pid} 를 다른 프로세스가 쓰고 있어 끄지 않아요(시작 시각이 기록과 다름)`
  }
  else roots.push(record.pid)
  const daemon = daemonPid(home)
  if (daemon && deps.alive(daemon)) roots.push(daemon)
  const targets = descendantsOf(deps.rows(), roots).filter((pid) => pid !== process.pid)
  for (const pid of targets) {
    try {
      deps.kill(pid, 'SIGTERM')
    } catch {
      // 그새 끝났다
    }
  }
  for (let waited = 0; waited < graceMs && targets.some((pid) => deps.alive(pid)); waited += 200) await deps.sleep(200)
  for (const pid of targets.filter((pid) => deps.alive(pid))) {
    try {
      deps.kill(pid, 'SIGKILL')
    } catch {
      // 그새 끝났다
    }
  }
  // 남의 pid 라 거절한 기록은 남겨 둔다(사람이 본다) — 끝냈거나 이미 끝난 기록은 지운다
  if (record && !refused) fs.rmSync(recordPath(home), { force: true })
  return { ok: !refused, reason, stopped: targets }
}
