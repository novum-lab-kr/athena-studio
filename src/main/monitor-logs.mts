// ── 에이전트 모니터 — 기록 읽기(창마다 따로 따라간다) ───────────────
// Claude Code(~/.claude/projects)·Codex(~/.codex/sessions)의 JSONL을 따라 읽어 화면에 이벤트로 보낸다 — 아테나 agent-monitor.py 와 같은 대상:
// 서브에이전트(<세션>/subagents/agent-*.jsonl) · 워크트리 세션 · 지금 에이전트가 도는 pane 폴더의 세션. 최근 120분 안에 바뀐 것만.
// 팩 창마다 그 본체(·그 .worktrees 가 가리키는 워크트리) 폴더의 세션만 — 다른 팩 본체의 세션은 그 팩 창 몫이다
// main.js 에서 옮겼다(PR3b) — 기록 폴더 자리는 createMonitorLogs 인자로 받는다
import fs from 'node:fs'
import path from 'node:path'
import * as core from '../lib/core.mts'
import * as agentFeed from '../lib/agent-feed.mts'
import type { FeedEvent } from '../lib/agent-feed.mts'

// 따라 읽는 파일 하나
export type Tail = {
  id: string
  file: string
  pane: boolean
  label: string | null
  finished: boolean
  tools: number
  mtime: number
  offset: number
  rest: Buffer
  skipPartial: boolean
  ino?: number
  codex?: boolean
  codexModel?: string | null
}
export type MonitorEvent = FeedEvent & { id: number; session: string }
// 창 하나의 모니터 상태 — 창(createPackWindow)이 newMonitor() 로 갖는다
export type Monitor = {
  watching: boolean
  timer: ReturnType<typeof setInterval> | null
  ticking: boolean
  lastScan: number
  lastFullScan: number
  tails: Map<string, Tail>
  tailSeq: number
  events: MonitorEvent[]
  seq: number
  agentCwds: string[]
  floor: number
  // GitHub 이슈 감시 — 현황판 /api/github-issues 를 마지막으로 읽은 때 · 이미 줄로 낸 이슈(repo#번호)
  lastGithub: number
  githubSeen: Set<string>
}
export type FoundLog = { file: string; pane: boolean; stat: fs.Stats; label?: string | null; codex?: boolean }
export type MonitorSession = { id: string; label: string; pane: boolean; finished: boolean; tools: number; lastAt: number }

// 예전 터미널 모니터 칸의 이름표 — 이미 떠 있는 pane 을 찾는 값이라 번역하지 않는다
export const MONITOR_LABEL = '🛰 에이전트 모니터'
export const MONITOR_MINUTES = 120
const MONITOR_BACKLOG = 5 // 처음 붙을 때 세션마다 마지막 몇 개만
const MONITOR_HEAD_BYTES = 64 * 1024 // 처음 붙을 때 파일 끝에서 이만큼만 읽는다
const MONITOR_CHUNK_BYTES = 4 * 1024 * 1024
export const MONITOR_KEEP = 300
const MONITOR_TEXT_MAX = 300
export const newMonitor = (): Monitor => ({ watching: false, timer: null, ticking: false, lastScan: 0, lastFullScan: 0, tails: new Map(), tailSeq: 0, events: [], seq: 0, agentCwds: [], floor: 0, lastGithub: 0, githubSeen: new Set() })

async function readDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function recentFile(file: string, since: number): Promise<fs.Stats | null> {
  try {
    const stat = await fs.promises.stat(file)
    return stat.isFile() && stat.mtimeMs >= since ? stat : null
  } catch {
    return null
  }
}

// 이 본체의 세션 폴더인가 — 본체 자체 · 그 안 워크트리(<본체>/.worktrees/… → '<이름>--worktrees-…')
// · 여러 팩 구조의 워크트리(.worktrees 가 가리키는 …/packs/<팩>/worktrees/… → '<그 폴더 이름>-…')
function ownProject(name: string, bodyName: string | null, worktreesName: string | null): boolean {
  if (worktreesName && name.startsWith(`${worktreesName}-`)) return true
  return Boolean(bodyName) && (name === bodyName || name.startsWith(`${bodyName}--`))
}

// 연/월/일 아래 rollout만 찾는다. 없는 폴더·바뀌는 파일은 다른 기록 읽기를 막지 않는다.
async function* codexFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readDir(dir)) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* codexFiles(file)
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield file
  }
}

// 끝부분만 tail해도 라벨은 첫 메타데이터에서 확보한다. 대화 파일 전체를 읽지 않는다.
async function codexHead(file: string): Promise<unknown> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, 'r')
    const parts: Buffer[] = []
    for (let offset = 0; offset < MONITOR_LINE_MAX; offset += 8192) {
      const buffer = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) return null
      const part = buffer.subarray(0, bytesRead)
      const newline = part.indexOf(10)
      parts.push(newline < 0 ? part : part.subarray(0, newline))
      if (newline >= 0) return agentFeed.parseLine(Buffer.concat(parts).toString('utf8'))
    }
  } catch {} finally { await handle?.close() }
  return null
}

// projectsDir — Claude Code 대화 기록 자리(~/.claude/projects)
export function createMonitorLogs({ projectsDir, codexSessionsDir = path.resolve(projectsDir, '../../.codex/sessions') }: { projectsDir: string; codexSessionsDir?: string }) {
  // allSessions — 부모 세션이 조용해도 서브에이전트는 오래 돌 수 있어서, 가끔(1분)은 모든 세션의 서브에이전트를 자기 수정 시각으로 본다
  async function findMonitorLogs(monitor: Monitor, allSessions: boolean, athenaDir: string | null): Promise<FoundLog[]> {
    const root = projectsDir
    const since = Math.max(Date.now() - MONITOR_MINUTES * 60000, monitor.floor)
    const wanted = new Set(monitor.agentCwds.map(agentFeed.projectDirName))
    const bodyName = athenaDir ? agentFeed.projectDirName(core.realDir(athenaDir)) : null
    const worktreesName = athenaDir ? agentFeed.projectDirName(core.realDir(path.join(athenaDir, '.worktrees'))) : null
    const found: FoundLog[] = []
    for (const project of await readDir(root)) {
      if (!project.isDirectory()) continue
      const own = ownProject(project.name, bodyName, worktreesName)
      const paneSessions = wanted.has(project.name) || own
      // 이 팩과 상관없는 폴더는 서브에이전트도 보지 않는다
      if (!paneSessions) continue
      const dir = path.join(root, project.name)
      for (const entry of await readDir(dir)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const file = path.join(dir, entry.name)
        const stat = await recentFile(file, since)
        if (stat) found.push({ file, pane: true, stat })
        // 서브에이전트 — 평소엔 최근에 움직인 세션만(모든 세션 폴더를 자주 뒤지지 않게)
        if (!stat && !allSessions) continue
        const subDir = path.join(dir, entry.name.replace(/\.jsonl$/, ''), 'subagents')
        for (const sub of await readDir(subDir)) {
          if (!sub.isFile() || !/^agent-.*\.jsonl$/.test(sub.name)) continue
          const subFile = path.join(subDir, sub.name)
          const subStat = await recentFile(subFile, since)
          if (subStat) found.push({ file: subFile, pane: false, stat: subStat })
        }
      }
    }
    // Codex는 프로젝트별 폴더가 없으므로 먼저 수정 시각을 보고 첫 session_meta의 cwd로 팩을 가른다.
    const body = athenaDir ? core.realDir(athenaDir) : null
    const worktrees = athenaDir ? core.realDir(path.join(athenaDir, '.worktrees')) : null
    const active = monitor.agentCwds.map(core.realDir)
    for await (const file of codexFiles(codexSessionsDir)) {
      const stat = await recentFile(file, since)
      if (!stat) continue
      const record = await codexHead(file)
      const meta = agentFeed.codexRecord(record)
      if (typeof meta.cwd !== 'string' || !agentFeed.codexSessionMatches(core.realDir(meta.cwd), body, worktrees, active)) continue
      found.push({ file, pane: true, stat, label: agentFeed.sessionLabel(record), codex: true })
    }
    return found
  }

  return { findMonitorLogs }
}

// 새로 붙은 줄들 — 줄바꿈 바이트에서 끊어 한글이 반쪽으로 잘리지 않게 한다.
// 파일이 바뀌었으면(inode) 처음 붙을 때처럼 끝부분부터, 줄바꿈 없이 너무 긴 줄은 버린다(메모리가 끝없이 늘지 않게)
const MONITOR_LINE_MAX = 1024 * 1024

export async function readNewLines(tail: Tail, limit?: number): Promise<string[]> {
  const stat = await fs.promises.stat(tail.file)
  tail.mtime = stat.mtimeMs
  let reset = false
  if (tail.ino !== undefined && stat.ino !== tail.ino) {
    tail.offset = Math.max(0, stat.size - MONITOR_HEAD_BYTES)
    tail.rest = Buffer.alloc(0)
    tail.skipPartial = tail.offset > 0
    reset = true
  } else if (stat.size < tail.offset) {
    tail.offset = 0
    tail.rest = Buffer.alloc(0)
    tail.skipPartial = false
    reset = true
  }
  if (tail.codex && reset) tail.codexModel = await codexModelBefore(tail.file, tail.offset).catch(() => null)
  tail.ino = stat.ino
  const size = Math.min(stat.size, limit ?? stat.size)
  if (size <= tail.offset) return []
  const length = Math.min(size - tail.offset, MONITOR_CHUNK_BYTES)
  const buffer = Buffer.alloc(length)
  const handle = await fs.promises.open(tail.file, 'r')
  let bytesRead = 0
  try {
    ;({ bytesRead } = await handle.read(buffer, 0, length, tail.offset))
  } finally {
    await handle.close()
  }
  tail.offset += bytesRead
  const combined = Buffer.concat([tail.rest, buffer.subarray(0, bytesRead)])
  const cut = combined.lastIndexOf(10)
  if (cut < 0) {
    // 줄바꿈 없이 너무 길면 그 줄은 버리고 다음 줄바꿈부터
    if (combined.length > MONITOR_LINE_MAX) {
      tail.rest = Buffer.alloc(0)
      tail.skipPartial = true
    } else {
      tail.rest = Buffer.from(combined)
    }
    return []
  }
  // 남은 조각은 복사해 둔다(큰 읽기 버퍼를 붙잡지 않게)
  tail.rest = Buffer.from(combined.subarray(cut + 1))
  let lines = combined.subarray(0, cut).toString('utf8').split('\n')
  if (tail.skipPartial) {
    lines = lines.slice(1)
    tail.skipPartial = false
  }
  return lines.filter((line) => line.trim() && line.length <= MONITOR_LINE_MAX)
}

// 처음 tail할 지점보다 앞에 기록된 모델 문맥도 복원한다. 기존 제한된 읽기를 재사용해 전체 파일을 메모리에 올리지 않는다.
async function codexModelBefore(file: string, before: number): Promise<string | null> {
  const history: Tail = { id: '', file, pane: true, label: null, finished: false, tools: 0, mtime: 0, offset: 0, rest: Buffer.alloc(0), skipPartial: false }
  let model: string | null = null
  while (history.offset < before) {
    const previous = history.offset
    for (const line of await readNewLines(history, before)) {
      const found = agentFeed.codexModelOf(agentFeed.parseLine(line))
      if (found !== undefined) model = found
    }
    if (history.offset === previous) break
  }
  return model
}

export function tailEvents(monitor: Monitor, tail: Tail, lines: readonly string[]): MonitorEvent[] {
  const events: MonitorEvent[] = []
  for (const line of lines) {
    let record = agentFeed.parseLine(line)
    if (!record) continue
    const model = agentFeed.codexModelOf(record)
    if (model !== undefined) tail.codexModel = model
    if (typeof record === 'object' && record !== null && 'type' in record && record.type === 'response_item') record = agentFeed.codexRecord(record, tail.codexModel)
    if (!tail.label) tail.label = agentFeed.sessionLabel(record)
    for (const event of agentFeed.eventsFromRecord(record)) {
      if (event.kind === 'tool') tail.tools += 1
      // 서브에이전트는 사용자 지시 대신 아테나가 보낸 지시라 빼고, 도구 · 말만
      if (!tail.pane && event.kind === 'user') continue
      events.push({
        id: ++monitor.seq,
        session: tail.id,
        ...event,
        text: event.text.length > MONITOR_TEXT_MAX ? `${event.text.slice(0, MONITOR_TEXT_MAX)}…` : event.text,
      })
    }
  }
  return events
}

// 서브에이전트는 옆의 meta.json 으로 이름 · 끝남을 안다(없거나 깨졌으면 그냥 둔다)
export async function readSubagentMeta(tail: Tail): Promise<void> {
  if (tail.pane) return
  try {
    const info = agentFeed.subagentInfo(JSON.parse(await fs.promises.readFile(tail.file.replace(/\.jsonl$/, '.meta.json'), 'utf8')))
    if (info.label) tail.label = info.label
    tail.finished = info.finished
  } catch {}
}

export async function openTail(monitor: Monitor, item: FoundLog): Promise<MonitorEvent[]> {
  const tail: Tail = { id: `s${++monitor.tailSeq}`, file: item.file, pane: item.pane, codex: item.codex, label: item.label ?? null, finished: false, tools: 0, mtime: item.stat.mtimeMs, offset: Math.max(0, item.stat.size - MONITOR_HEAD_BYTES), rest: Buffer.alloc(0), skipPartial: item.stat.size > MONITOR_HEAD_BYTES }
  if (tail.codex) tail.codexModel = await codexModelBefore(tail.file, tail.offset).catch(() => null)
  await readSubagentMeta(tail)
  const lines = await readNewLines(tail).catch(() => [])
  const events = tailEvents(monitor, tail, lines).slice(-MONITOR_BACKLOG)
  monitor.tails.set(item.file, tail)
  return events
}

export function monitorSessions(monitor: Monitor): MonitorSession[] {
  return [...monitor.tails.values()]
    .sort((left, right) => right.mtime - left.mtime)
    .map((tail) => ({ id: tail.id, label: tail.label || (tail.pane ? 'pane' : 'agent'), pane: tail.pane, finished: tail.finished, tools: tail.tools, lastAt: tail.mtime }))
}
