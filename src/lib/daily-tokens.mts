// 메뉴 막대 패널 — 최근 7일 일별 토큰량(Claude · Codex). 이 맥의 대화 기록만 읽는다(모델을 부르지 않는다).
// 센 것 = 입력 + 캐시 생성 + 출력 · 캐시 읽기는 뺀다(시안 기준 — 계획서 20261104 메뉴 막대).
// - Claude: ~/.claude/projects/**.jsonl 의 assistant 줄 message.usage — 서브에이전트 기록(<세션>/subagents/agent-*.jsonl)도 넣는다.
//   한 답(message.id)은 내용 조각마다 줄이 나뉘고, 이어 하기 · 서브에이전트 기록에 같은 답이 또 적힐 수 있어 id 마다 한 번만(파일을 넘어서도) 센다.
//   input_tokens + cache_creation_input_tokens + output_tokens (cache_read_input_tokens 는 뺀다)
// - Codex: $CODEX_HOME/sessions/**/rollout-*.jsonl 의 event_msg token_count — info.last_token_usage(그 요청 한 번)를 그 줄 시각의 날짜에.
//   누적(total_token_usage) 차이로 세지 않는다 — 이어 하기로 만든 파일은 첫 줄 누적에 앞 세션 몫이 들어 있다(2026-11-04 실제 기록 215개 중 7개).
//   누적 값이 앞 줄과 같은 줄은 같은 요청을 다시 적은 것이라 뺀다(7일치 6,745줄 중 45줄).
//   cached_input_tokens(캐시 읽기)가 input_tokens 안에 들어 있어(token-usage.mts 와 같은 확인) 입력 - 캐시 읽기 + 출력
// - 날짜는 줄의 timestamp 를 이 맥 현지 시각으로. 파일이 많아(7일에 4GB 넘게 — 2026-11-04 실측) 파일마다 읽은 자리를 기억해 늘어난 부분만 읽는다
import fs from 'node:fs'
import path from 'node:path'

export type Tool = 'claude' | 'codex'
export type DayTokens = { day: string; claude: number; codex: number }
// 파일 하나를 따라 읽는 상태 — 읽은 바이트 · 날짜별 합 · (Codex) 앞 줄 누적 값 · (Claude) 이 파일이 처음 센 답 id
type FileState = { tool: Tool; size: number; offset: number; days: Map<string, number>; codexTotal: number; ids: Set<string> }
type Loose = Record<string, unknown>

const CHUNK_BYTES = 8 * 1024 * 1024
const DAY_MS = 24 * 3600000

const isLoose = (value: unknown): value is Loose => Boolean(value) && typeof value === 'object'
const countOf = (usage: Loose, key: string): number => {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// 현지 날짜 'YYYY-MM-DD'
export function dayKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 오늘을 끝으로 count 일 — 오래된 날부터
export function lastDays(now: number, count = 7): string[] {
  const days: string[] = []
  const date = new Date(now)
  date.setHours(12, 0, 0, 0) // 서머타임이 바뀌는 날에도 하루씩 정확히 물러나게 한낮 기준
  for (let back = count - 1; back >= 0; back--) days.push(dayKey(date.getTime() - back * DAY_MS))
  return days
}

// 그 날짜 0시(현지) — 이보다 오래 안 바뀐 파일은 읽지 않는다
export function startOfDay(day: string): number {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  return new Date(year, month - 1, date).getTime()
}

// Claude 줄 → { id, at, tokens } | null
export function claudeEntry(line: string): { id: string; at: number; tokens: number } | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (!isLoose(record) || record.type !== 'assistant' || !isLoose(record.message)) return null
  const { id, usage } = record.message
  const at = Date.parse(String(record.timestamp ?? ''))
  if (typeof id !== 'string' || !id || !isLoose(usage) || Number.isNaN(at)) return null
  return { id, at, tokens: countOf(usage, 'input_tokens') + countOf(usage, 'cache_creation_input_tokens') + countOf(usage, 'output_tokens') }
}

// Codex 줄 → { at, total(세션 누적 total_tokens — 중복 줄 거르기용), tokens(이번 요청 — 입력 - 캐시 읽기 + 출력) } | null
export function codexEntry(line: string): { at: number; total: number; tokens: number } | null {
  if (!line.includes('"token_count"')) return null
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (!isLoose(record) || record.type !== 'event_msg' || !isLoose(record.payload) || record.payload.type !== 'token_count') return null
  const info = record.payload.info
  const total = isLoose(info) ? info.total_token_usage : null
  const last = isLoose(info) ? info.last_token_usage : null
  const at = Date.parse(String(record.timestamp ?? ''))
  if (!isLoose(total) || !isLoose(last) || Number.isNaN(at)) return null
  return { at, total: countOf(total, 'total_tokens'), tokens: Math.max(0, countOf(last, 'input_tokens') - countOf(last, 'cached_input_tokens')) + countOf(last, 'output_tokens') }
}

// 파일들을 따라 읽어 날짜별로 더한다 — 같은 개체로 다시 부르면 늘어난 부분만
export class DailyTokens {
  files = new Map<string, FileState>()
  seen = new Map<string, string>() // Claude 답 id → 처음 센 파일

  // 끝까지 적힌 줄들을 더한다
  feed(file: string, tool: Tool, text: string): void {
    const state = this.state(file, tool)
    const add = (at: number, tokens: number) => {
      if (tokens <= 0) return
      const day = dayKey(at)
      state.days.set(day, (state.days.get(day) ?? 0) + tokens)
    }
    for (const line of text.split('\n')) {
      if (tool === 'claude') {
        const entry = claudeEntry(line)
        if (!entry || this.seen.has(entry.id)) continue
        this.seen.set(entry.id, file)
        state.ids.add(entry.id)
        add(entry.at, entry.tokens)
      } else {
        const entry = codexEntry(line)
        if (!entry || entry.total === state.codexTotal) continue
        state.codexTotal = entry.total
        add(entry.at, entry.tokens)
      }
    }
  }

  state(file: string, tool: Tool): FileState {
    let state = this.files.get(file)
    if (!state) {
      state = { tool, size: 0, offset: 0, days: new Map(), codexTotal: -1, ids: new Set() }
      this.files.set(file, state)
    }
    return state
  }

  // 파일을 잊는다(지워졌거나 · 기간 밖 · 처음부터 다시 쓴 파일) — 그 파일이 센 답 id 도 놓아준다
  drop(file: string): void {
    const state = this.files.get(file)
    if (!state) return
    for (const id of state.ids) if (this.seen.get(id) === file) this.seen.delete(id)
    this.files.delete(file)
  }

  // 지난번 자리부터 늘어난 부분만 — 마지막 줄바꿈까지(쓰다 만 줄은 다음에) · 파일이 줄었으면 처음부터
  async readFile(file: string, tool: Tool, size: number): Promise<void> {
    const before = this.files.get(file)
    if (before && size < before.offset) this.drop(file)
    const state = this.state(file, tool)
    state.size = size
    if (size === state.offset) return
    const handle = await fs.promises.open(file, 'r')
    try {
      // 줄바꿈 바이트(0x0A)는 여러 바이트 글자 안에 나오지 않아 여기서 잘라도 글자가 깨지지 않는다
      let position = state.offset
      let pending: Buffer = Buffer.alloc(0)
      while (position < size) {
        const length = Math.min(CHUNK_BYTES, size - position)
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
        this.feed(file, tool, data.toString('utf8', 0, end))
        state.offset += end + 1
        pending = data.subarray(end + 1)
      }
    } finally {
      await handle.close()
    }
  }

  // 두 기록 폴더를 한 번 훑는다 — since(ms)보다 오래 안 바뀐 파일은 읽지 않고, 없어진 파일은 잊는다
  async scan({ claudeDir, codexDir, since }: { claudeDir: string | null; codexDir: string | null; since: number }): Promise<void> {
    const found = new Map<string, { tool: Tool; size: number }>()
    const walk = async (dir: string, tool: Tool, match: (name: string) => boolean): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(file, tool, match)
        else if (entry.isFile() && match(entry.name)) {
          const stat = await fs.promises.stat(file).catch(() => null)
          if (stat && stat.mtimeMs >= since) found.set(file, { tool, size: stat.size })
        }
      }
    }
    if (claudeDir) await walk(claudeDir, 'claude', (name) => name.endsWith('.jsonl'))
    if (codexDir) await walk(codexDir, 'codex', (name) => /^rollout-.*\.jsonl$/.test(name))
    for (const file of [...this.files.keys()]) if (!found.has(file)) this.drop(file)
    for (const [file, { tool, size }] of found) {
      try {
        await this.readFile(file, tool, size)
      } catch {
        // 읽다 사라진 파일 — 다음 훑기에서 잊는다
      }
    }
  }

  // 날짜마다 { day, claude, codex } — days 순서 그대로
  totals(days: readonly string[]): DayTokens[] {
    const rows = new Map(days.map((day) => [day, { day, claude: 0, codex: 0 }]))
    for (const state of this.files.values()) {
      for (const [day, tokens] of state.days) {
        const row = rows.get(day)
        if (row) row[state.tool] += tokens
      }
    }
    return [...rows.values()]
  }
}
