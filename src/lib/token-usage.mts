// pane [상세] 토큰 — Claude Code 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl)의 assistant 줄 message.usage 를 더한다.
// 모델을 부르지 않고 파일만 읽는다. 3초마다 다시 물어도 파일마다 읽은 자리(바이트)를 기억해 늘어난 부분만 읽는다.
// 한 답(message.id)은 내용 조각(thinking · text · tool_use)마다 줄이 나뉘어 같은 usage 로 여러 번 적힌다(2026-10-27 실제 기록 확인) — id 마다 한 번만 센다
// Codex 대화 기록($CODEX_HOME/sessions · 기본 ~/.codex/sessions 의 YYYY/MM/DD/rollout-<시각>-<세션>.jsonl)도 같이 — event_msg token_count 의
// info.total_token_usage 가 세션 누적이라 마지막 값 하나를 쓴다(2026-11-04 실제 기록 203개: 파일 안에서 줄지 않음 · cached_input_tokens 가 input_tokens 를 넘는 줄 0개 —
// 캐시 읽기가 입력 안에 든다). 그래서 입력+출력 = 입력 - 캐시 읽기 + 출력 · 캐시 = 캐시 읽기 + 캐시 쓰기(Claude 의 두 칸과 같은 뜻)
import fs from 'node:fs'
import path from 'node:path'

// 기록 JSON 의 객체 하나(모양은 칸마다 따로 본다)
type Loose = Record<string, unknown>
// 입력+출력(io) · 캐시 만들기+읽기(cache)
export type Usage = { io: number; cache: number }
// 파일 하나를 따라 읽는 상태 — 읽은 바이트 · 답 id 마다 값 · id 없는 답의 합 · Codex 누적 값(마지막 것)
export type Tally = { offset: number; ids: Map<string, Usage>; loose: Usage; codex: Usage | null }
type Answer = Usage & { id: string | null; total?: boolean }

function isLoose(value: unknown): value is Loose {
  return Boolean(value) && typeof value === 'object'
}

const HEAD_LINES = 40
const CHUNK_BYTES = 8 * 1024 * 1024
const SCAN_MS = 15000

// ── 기록 한 파일 따라 읽기 ─────────────────────────────────────────────
export const newTally = (): Tally => ({ offset: 0, ids: new Map(), loose: { io: 0, cache: 0 }, codex: null })

const countOf = (usage: Loose, key: string): number => {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// Codex token_count 줄 → 세션 누적 { io, cache } | null
function codexUsageOf(record: unknown): Usage | null {
  if (!isLoose(record) || record.type !== 'event_msg' || !isLoose(record.payload) || record.payload.type !== 'token_count') return null
  const info = record.payload.info
  const usage = isLoose(info) ? info.total_token_usage : null
  if (!isLoose(usage)) return null
  const cached = countOf(usage, 'cached_input_tokens')
  return { io: Math.max(0, countOf(usage, 'input_tokens') - cached) + countOf(usage, 'output_tokens'), cache: cached + countOf(usage, 'cache_write_input_tokens') }
}

// 줄 하나 → 그 답의 { id, io, cache } | null
export function usageOf(line: string): Answer | null {
  const codex = line.includes('"token_count"')
  if (!codex && !line.includes('"usage"')) return null
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (codex) {
    const total = codexUsageOf(record)
    if (total) return { id: null, total: true, ...total }
  }
  const message = isLoose(record) && record.type === 'assistant' ? record.message : null
  if (!isLoose(message)) return null
  const usage = message.usage
  if (!isLoose(usage)) return null
  const count = (key: string): number => countOf(usage, key)
  return {
    id: typeof message.id === 'string' && message.id ? message.id : null,
    io: count('input_tokens') + count('output_tokens'),
    cache: count('cache_creation_input_tokens') + count('cache_read_input_tokens'),
  }
}

// 끝까지 적힌 줄들(마지막 줄바꿈까지)을 더한다 — 같은 id 는 마지막 줄 값 하나로
export function feedLines(tally: Tally, text: string): void {
  for (const line of text.split('\n')) {
    const answer = usageOf(line)
    if (!answer) continue
    if (answer.total) tally.codex = { io: answer.io, cache: answer.cache }
    else if (answer.id) tally.ids.set(answer.id, { io: answer.io, cache: answer.cache })
    else {
      tally.loose.io += answer.io
      tally.loose.cache += answer.cache
    }
  }
}

export function totalsOf(tally: Tally): Usage {
  const sum: Usage = { io: tally.loose.io + (tally.codex?.io ?? 0), cache: tally.loose.cache + (tally.codex?.cache ?? 0) }
  for (const answer of tally.ids.values()) {
    sum.io += answer.io
    sum.cache += answer.cache
  }
  return sum
}

// 지난번 자리부터 늘어난 부분만 — 마지막 줄바꿈까지만 먹고(쓰다 만 줄은 다음에), 파일이 줄었으면(새로 씀) 처음부터
export async function readGrowth(file: string, tally: Tally): Promise<Tally> {
  const stat = await fs.promises.stat(file)
  if (stat.size < tally.offset) Object.assign(tally, newTally())
  if (stat.size === tally.offset) return tally
  const handle = await fs.promises.open(file, 'r')
  try {
    // 줄바꿈 바이트(0x0A)는 여러 바이트 글자 안에 나오지 않아 여기서 잘라도 글자가 깨지지 않는다.
    // 한 조각에 줄바꿈이 없으면(이미지가 든 아주 긴 줄) 다음 조각과 이어 붙인다
    let position = tally.offset
    let pending: Buffer = Buffer.alloc(0)
    while (position < stat.size) {
      const length = Math.min(CHUNK_BYTES, stat.size - position)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (!bytesRead) break
      position += bytesRead
      const data = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      const end = data.lastIndexOf(0x0a)
      if (end < 0) {
        pending = data
        continue
      }
      feedLines(tally, data.toString('utf8', 0, end))
      tally.offset += end + 1
      pending = data.subarray(end + 1)
    }
  } finally {
    await handle.close()
  }
  return tally
}

// ── 계획서 → 대화 기록(코어 scripts/learn-review.mjs findTranscripts 와 같은 규칙) ──────────────
// delegate.sh 가 띄운 세션은 첫 지시 맨 앞이 "이 작업의 계획서: <본체>/<계획서> —" 또는 "리뷰할 계획서: <본체>/<계획서> —"
const stripNoise = (text: string): string => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<local-command-[\s\S]*?<\/local-command-[a-z]+>/g, '').trim()

// Codex 사용자 글(response_item message role user 의 input_text) — 지시 앞에 넣는 AGENTS.md · 환경 문맥은 건너뛴다(코어 learn-review.mjs firstUserText 와 같다)
function codexUserText(line: string): string {
  if (!line.includes('"response_item"') || !line.includes('"user"')) return ''
  try {
    const record: unknown = JSON.parse(line)
    const payload = isLoose(record) && record.type === 'response_item' ? record.payload : null
    if (!isLoose(payload) || payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) return ''
    const blocks: unknown[] = payload.content
    const text = blocks.filter((block): block is Loose => isLoose(block) && block.type === 'input_text' && typeof block.text === 'string').map((block) => block.text).join('\n')
    return text.startsWith('# AGENTS.md instructions') || text.startsWith('<environment_context>') ? '' : text
  } catch {
    return ''
  }
}

// Codex 하위 에이전트 rollout(첫 줄 session_meta 의 parent_thread_id — 2026-11-04 실제 기록 27개 모두 있음)인가 — Claude 서브에이전트처럼 계획서 합계에 넣지 않는다
function codexSubagentHead(line: string): boolean {
  if (!line.includes('"session_meta"') || !line.includes('"parent_thread_id"')) return false
  try {
    const record: unknown = JSON.parse(line)
    return isLoose(record) && record.type === 'session_meta' && isLoose(record.payload) && typeof record.payload.parent_thread_id === 'string'
  } catch {
    return false
  }
}

function userText(line: string): string {
  const codex = codexUserText(line)
  if (codex) return codex
  if (!line.includes('"type":"user"')) return ''
  try {
    const record: unknown = JSON.parse(line)
    if (!isLoose(record) || record.type !== 'user') return ''
    const message = record.message
    const content = isLoose(message) ? message.content : undefined
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const blocks: unknown[] = content
      return blocks.filter((block): block is Loose => isLoose(block) && block.type === 'text').map((block) => block.text || '').join('\n')
    }
  } catch {
    // 깨진 줄은 건너뛴다
  }
  return ''
}

// 앞 40줄 안의 첫 사용자 글(잡음 뺀 것). 없으면 ''
export async function firstUserText(file: string): Promise<string> {
  const handle = await fs.promises.open(file, 'r')
  try {
    let text = ''
    let position = 0
    let seen = 0
    let rest: Buffer = Buffer.alloc(0)
    while (seen < HEAD_LINES) {
      const buffer = Buffer.alloc(1024 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      const data = Buffer.concat([rest, buffer.subarray(0, bytesRead)])
      let start = 0
      for (let end = data.indexOf(0x0a); end >= 0 && seen < HEAD_LINES; end = data.indexOf(0x0a, start)) {
        seen += 1
        const line = data.toString('utf8', start, end)
        if (seen === 1 && codexSubagentHead(line)) return ''
        const found = userText(line)
        start = end + 1
        if (found) {
          text = found
          seen = HEAD_LINES
        }
      }
      rest = data.subarray(start)
    }
    return stripNoise(text)
  } finally {
    await handle.close()
  }
}

export const planHeaders = (bodyDirs: readonly (string | null | undefined)[], planId: string): string[] => [...new Set(bodyDirs.filter((dir): dir is string => Boolean(dir)))].flatMap((dir) => {
  const full = path.join(dir, planId)
  return [`이 작업의 계획서: ${full} —`, `리뷰할 계획서: ${full} —`]
})

// Codex rollout 목록 — sessions/YYYY/MM/DD 아래(깊이에 기대지 않고 rollout-*.jsonl 을 다 모은다 · 목록은 scanMs 마다 한 번)
async function codexRollouts(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await codexRollouts(file)))
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) found.push(file)
  }
  return found
}

// ── 보기 좋은 숫자 — 42k · 3.1M ──────────────────────────────────────
export function formatTokens(count: unknown): string {
  const value = Math.max(0, Math.round(Number(count) || 0))
  if (value < 1000) return String(value)
  if (value < 1e6) return `${trimZero((value / 1000).toFixed(value < 10000 ? 1 : 0))}k`
  if (value < 1e9) return `${trimZero((value / 1e6).toFixed(value < 1e7 ? 1 : 0))}M`
  return `${trimZero((value / 1e9).toFixed(1))}B`
}
const trimZero = (text: string): string => text.replace(/\.0$/, '')
// 화면에 보낼 값(pane 머리줄 · 상세) — 기록을 못 찾았거나 합이 0 이면 null(화면에서 숨긴다)
export type UsageView = { io: number; cache: number; ioText: string; cacheText: string }
export const usageView = (sum: Usage | null): UsageView | null => (sum && sum.io + sum.cache > 0 ? { io: sum.io, cache: sum.cache, ioText: formatTokens(sum.io), cacheText: formatTokens(sum.cache) } : null)

// ── 묶음 — 기록 폴더 목록 · 파일 머리 · 파일별 합계를 기억한다 ───────────────────
// peekPlan · peekSession 은 기다리지 않는다: 아는 값을 바로 돌려주고(처음엔 null) 뒤에서 새로 읽는다
// codexSessionsDir — Codex 대화 기록 자리(없으면 Codex 는 안 본다)
export type TokenUsageOptions = { projectsDir: string; codexSessionsDir?: string | null; scanMs?: number; now?: () => number }
export type TokenUsage = {
  peekPlan: (bodyDirs: readonly (string | null | undefined)[] | null | undefined, planId: string | null | undefined) => Usage | null
  peekSession: (sessionId: unknown) => Usage | null
  planUsage: (bodyDirs: readonly (string | null | undefined)[], planId: string) => Promise<Usage | null>
  sessionUsage: (sessionId: unknown) => Promise<Usage | null>
}
export function createTokenUsage({ projectsDir, codexSessionsDir = null, scanMs = SCAN_MS, now = Date.now }: TokenUsageOptions): TokenUsage {
  const tallies = new Map<string, Tally>() // 파일 → 따라 읽는 상태
  const heads = new Map<string, { mtimeMs: number; text: string }>() // 파일 → { mtimeMs, text }
  const known = new Map<string, Usage | null>() // 물음 열쇠 → 값({ io, cache } | null)
  const running = new Set<string>()
  let files: string[] = []
  let scannedAt = -Infinity

  // 프로젝트 폴더 바로 아래 <세션>.jsonl 만(서브에이전트 기록은 findTranscripts 처럼 넣지 않는다) · scanMs 마다 한 번
  async function listFiles(): Promise<string[]> {
    if (now() - scannedAt < scanMs) return files
    const next: string[] = []
    const dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const entries = await fs.promises.readdir(path.join(projectsDir, dir.name), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.jsonl')) next.push(path.join(projectsDir, dir.name, entry.name))
    }
    if (codexSessionsDir) next.push(...(await codexRollouts(codexSessionsDir)))
    files = next
    scannedAt = now()
    return files
  }

  // 첫 사용자 글은 한 번 적히면 바뀌지 않는다 — 찾았으면 계속 쓰고, 못 찾았으면 파일이 바뀔 때 다시 본다
  async function headOf(file: string): Promise<string> {
    const cached = heads.get(file)
    if (cached && cached.text) return cached.text
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat) return ''
    if (cached && cached.mtimeMs === stat.mtimeMs) return ''
    const text = await firstUserText(file).catch(() => '')
    heads.set(file, { mtimeMs: stat.mtimeMs, text })
    return text
  }

  async function sumFiles(list: readonly string[]): Promise<Usage | null> {
    if (!list.length) return null
    const sum: Usage = { io: 0, cache: 0 }
    let read = 0
    for (const file of list) {
      const tally = tallies.get(file) || newTally()
      tallies.set(file, tally)
      try {
        await readGrowth(file, tally)
      } catch {
        continue
      }
      read += 1
      const part = totalsOf(tally)
      sum.io += part.io
      sum.cache += part.cache
    }
    return read ? sum : null
  }

  async function planUsage(bodyDirs: readonly (string | null | undefined)[], planId: string): Promise<Usage | null> {
    const headers = planHeaders(bodyDirs, planId)
    const matched: string[] = []
    for (const file of await listFiles()) {
      const head = await headOf(file)
      if (head && headers.some((header) => head.startsWith(header))) matched.push(file)
    }
    return sumFiles(matched)
  }

  async function sessionUsage(sessionId: unknown): Promise<Usage | null> {
    const name = `${sessionId}.jsonl`
    // Claude 는 <세션>.jsonl · Codex 는 rollout-<시각>-<세션>.jsonl(앱 pane 기록의 session 과 같은 id — 2026-11-04 Codex pane 기록 43개 모두 이 이름으로 찾음)
    const matches = (file: string): boolean => {
      const base = path.basename(file)
      return base === name || (base.startsWith('rollout-') && base.endsWith(`-${name}`))
    }
    let list = (await listFiles()).filter(matches)
    // 방금 시작한 세션은 목록이 오래됐을 수 있다 — 한 번 더 훑는다
    if (!list.length) {
      scannedAt = -Infinity
      list = (await listFiles()).filter(matches)
    }
    return sumFiles(list)
  }

  function peek(key: string, compute: () => Promise<Usage | null>): Usage | null {
    if (!running.has(key)) {
      running.add(key)
      compute()
        .then((value) => known.set(key, value), () => {})
        .finally(() => running.delete(key))
    }
    return known.has(key) ? (known.get(key) ?? null) : null
  }

  return {
    // 열쇠에 본체까지 — 다른 팩에 같은 상대 경로 계획서가 있어도 값 · 실행이 섞이지 않게
    peekPlan: (bodyDirs, planId) => {
      if (!planId) return null
      const dirs = [...new Set((bodyDirs || []).filter((dir): dir is string => Boolean(dir)).map((dir) => path.resolve(dir)))].sort()
      return peek(`plan:${dirs.join('\n')}\n${planId}`, () => planUsage(dirs, planId))
    },
    peekSession: (sessionId) => (/^[0-9a-fA-F-]{8,64}$/.test(String(sessionId || '')) ? peek(`session:${sessionId}`, () => sessionUsage(sessionId)) : null),
    planUsage,
    sessionUsage,
  }
}
