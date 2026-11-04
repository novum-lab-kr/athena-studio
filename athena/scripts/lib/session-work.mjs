// 작업 시간 안쪽 — Claude 세션 기록(~/.claude/projects/<폴더>/*.jsonl) · Codex rollout 으로 "작업" 구간에 무엇을 했나 나눈다. 현황판 [지표] 탭(/api/metrics/work)
// 세션과 계획서는 delegate.sh 가 넣는 첫머리 지시로 잇는다("이 작업의 계획서:" · 이어 보내면 "새 계획서:" — 그 뒤 줄은 새 계획서로).
// reviewer("리뷰할 계획서:")는 리뷰 구간이라 빼고, 표시 없는 세션은 건수만 센다.
// Codex 세션(~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl · CODEX_HOME 이 있으면 그 아래)도 같은 읽기로 — codexEntry 가 Claude 줄 모양으로 바꾼다
import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { partition } from './metrics.mjs'
import { projectFolderName } from '../board/claude-paths.mjs'

// 겹치면 앞쪽이 가져간다 — 응답을 쓰는 동안 도는 도구는 생각·작성으로 든다
export const WORK_KINDS = ['think', 'wait', 'check', 'other', 'read']

const MARK = /^\s*(?:(\[[^\]]*\]\s*새 요청 — 새 계획서|이 작업의 계획서)|리뷰할 계획서):\s*\S*?(plans\/\S+?\.md)/
const WAITING = /\b(?:until|while)\b[\s\S]*\bsleep\b|^\s*sleep\b|review-wait\.sh/
const CHECKING = /scripts\/verify\/|\breuse\.sh\b|\bcommit\.sh\b|\bship\.sh\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|typecheck|lint|build)\b|\btsc\b|\bvitest\b|\bjest\b|\bplaywright\s+test\b|\bgit\s+commit\b|\btest\/\S+-test\.sh\b/

// 도구 한 번의 종류 — null 이면 세지 않는다(사람 답을 기다리는 시간)
export const toolKind = (name, input) => {
  if (name === 'AskUserQuestion') return null
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'think'
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'read'
  if (name === 'Monitor') return 'wait'
  if (name !== 'Bash') return 'other'
  const command = String(input?.command ?? '')
  if (WAITING.test(command)) return 'wait'
  return CHECKING.test(command) ? 'check' : 'other'
}

// ── Codex rollout → Claude 줄 모양 ─────────────────────────────────────
// 근거: 2026-11-04 이 컴퓨터의 rollout 203개(codex 0.160~0.166) — 줄마다 timestamp · type · payload.
// response_item 의 message(role user · assistant) · reasoning · custom_tool_call / function_call(call_id · name · input / arguments) ·
// *_output(call_id). 한 응답은 줄이 여러 개라 사용자 쪽 줄(사용자 글 · 도구 결과)이 올 때마다 응답 번호를 올려 같은 응답으로 묶는다(Claude 의 message.id 몫)
const CODEX_WAIT = new Set(['sleep', 'wait', 'wait_agent'])
// 도구 이름 → Claude 도구 이름 · 입력(toolKind 로 같은 종류에 넣는다). exec 는 code-mode 스크립트라 그 글로 명령을 가른다
const codexTool = (name, input) => {
  const short = String(name ?? '').split('.').at(-1)
  if (short === 'request_user_input') return ['AskUserQuestion', {}]
  if (CODEX_WAIT.has(short)) return ['Monitor', {}]
  if (short === 'apply_patch') return ['Edit', {}]
  if (short === 'exec') return /\bapply_patch\b/.test(String(input ?? '')) ? ['Edit', {}] : ['Bash', { command: String(input ?? '') }]
  if (['exec_command', 'shell_command', 'shell'].includes(short)) {
    let args = {}
    try { args = typeof input === 'string' ? JSON.parse(input) : input ?? {} } catch { /* 깨진 인자는 명령 없음으로 */ }
    const command = args?.cmd ?? args?.command ?? ''
    return ['Bash', { command: Array.isArray(command) ? command.join(' ') : String(command) }]
  }
  return [short || 'tool', {}]
}

export const createCodexAdapter = () => {
  let answer = 0
  let fresh = true
  return (record) => {
    const value = record?.payload
    if (record?.type !== 'response_item' || !value) return null
    const timestamp = record.timestamp
    const fromUser = (message) => {
      if (!fresh) answer += 1
      fresh = true
      return { type: 'user', timestamp, message }
    }
    const fromAgent = (content) => {
      fresh = false
      return { type: 'assistant', timestamp, message: { id: `codex-${answer}`, content } }
    }
    if (value.type === 'message' && value.role === 'user') {
      const text = (Array.isArray(value.content) ? value.content : []).filter((block) => block?.type === 'input_text').map((block) => block.text ?? '').join('\n')
      return fromUser({ content: text })
    }
    if (value.type === 'function_call_output' || value.type === 'custom_tool_call_output') return fromUser({ content: [{ type: 'tool_result', tool_use_id: value.call_id }] })
    if (value.type === 'message' && value.role === 'assistant') return fromAgent([])
    if (value.type === 'reasoning') return fromAgent([])
    if (value.type === 'function_call' || value.type === 'custom_tool_call') {
      const [name, input] = codexTool(value.name, value.type === 'function_call' ? value.arguments : value.input)
      return fromAgent([{ type: 'tool_use', id: value.call_id, name, input }])
    }
    return null
  }
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join(' ')
}

// 세션 한 개를 줄 순서대로 받는다 — 같은 응답은 message id 가 같은 줄 여러 개로 나뉘니 첫 줄 앞 ~ 끝 줄을 한 조각으로(그 사이 시간도 생각·작성)
export const createSessionReader = () => {
  let plan = null
  let linked = false
  let reviewer = false
  let lastMark = null
  const answers = new Map()   // message id → { plan, from, to }
  const tools = new Map()     // tool_use id → { plan, kind, from }
  const pieces = []
  return {
    add(entry) {
      const at = Date.parse(entry?.timestamp)
      if (!at || entry.isSidechain) return
      const content = entry.message?.content
      if (entry.type === 'user') {
        if (!entry.isCompactSummary && !entry.isMeta) {
          const mark = MARK.exec(textOf(content))
          if (mark) {
            plan = mark[1] ? mark[2] : null
            if (mark[1]) linked = true
            else reviewer = true
          }
        }
        for (const block of Array.isArray(content) ? content : []) {
          const open = block?.type === 'tool_result' ? tools.get(block.tool_use_id) : null
          if (!open) continue
          tools.delete(block.tool_use_id)
          if (open.plan) pieces.push({ plan: open.plan, label: open.kind, from: open.from, to: at })
        }
        lastMark = at
        return
      }
      if (entry.type !== 'assistant') return
      const answerId = entry.message?.id
      if (answerId) {
        const answer = answers.get(answerId) ?? { plan, from: lastMark ?? at, to: at }
        answer.to = at
        answers.set(answerId, answer)
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== 'tool_use') continue
        const kind = toolKind(block.name, block.input)
        if (kind) tools.set(block.id, { plan, kind, from: at })
      }
      lastMark = at
    },
    finish() {
      for (const answer of answers.values()) {
        if (answer.plan) pieces.push({ plan: answer.plan, label: 'think', from: answer.from, to: answer.to })
      }
      // 한 세션 안에서는 겹치지 않게 — 계획서마다 나눈다
      const byPlan = new Map()
      for (const piece of pieces) {
        if (!byPlan.has(piece.plan)) byPlan.set(piece.plan, [])
        byPlan.get(piece.plan).push(piece)
      }
      const merged = [...byPlan].flatMap(([planId, items]) => partition(items, WORK_KINDS).map((piece) => ({ plan: planId, ...piece })))
      return { kind: sessionKind(linked, reviewer), pieces: merged }
    },
  }
}

const sessionKind = (linked, reviewer) => {
  if (linked) return 'linked'
  return reviewer ? 'reviewer' : 'unlinked'
}

// 기간 [from, to) 합계 — 조각을 기간에 맞게 자른다. 세션끼리는 더하기만 하니 동시에 돌면 실제 경과보다 클 수 있다
export const workTotals = (sessions, { from = -Infinity, to = Infinity, picked = null } = {}) => {
  const totals = Object.fromEntries(WORK_KINDS.map((kind) => [kind, 0]))
  const plans = {}
  const counts = { linked: 0, reviewer: 0, unlinked: 0 }
  const engines = { claude: 0, codex: 0 }
  for (const session of sessions) {
    let touched = false
    for (const piece of session.pieces) {
      if (picked && !picked.has(piece.plan)) continue
      const span = Math.min(piece.to, to) - Math.max(piece.from, from)
      if (span <= 0) continue
      totals[piece.label] += span
      plans[piece.plan] ??= Object.fromEntries(WORK_KINDS.map((kind) => [kind, 0]))
      plans[piece.plan][piece.label] += span
      touched = true
    }
    if (touched || (session.kind !== 'linked' && session.lastAt >= from && session.lastAt < to)) {
      counts[session.kind] += 1
      engines[session.engine === 'codex' ? 'codex' : 'claude'] += 1
    }
  }
  return { totals, plans, sessions: counts, engines }
}

const readSession = async (path) => {
  const reader = createSessionReader()
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    try { reader.add(JSON.parse(line)) } catch { /* 쓰는 중인 끝 줄 · 망가진 줄은 건너뛴다 */ }
  }
  return reader.finish()
}

// Codex rollout 한 개 — 첫 줄 session_meta 의 cwd 가 이 팩 워크트리 안일 때만. 하위 에이전트(parent_thread_id)는 Claude 서브에이전트처럼 뺀다
const readCodexSession = async (path, worktrees) => {
  const reader = createSessionReader()
  const adapt = createCodexAdapter()
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let first = true
  for await (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (first) {
      first = false
      const meta = record?.type === 'session_meta' ? record.payload : null
      const cwd = typeof meta?.cwd === 'string' ? await realpath(meta.cwd).catch(() => meta.cwd) : null
      if (!cwd || meta.parent_thread_id || !(cwd === worktrees || cwd.startsWith(`${worktrees}${sep}`))) {
        lines.close()
        return null
      }
      continue
    }
    const entry = adapt(record)
    if (entry) reader.add(entry)
  }
  return first ? null : reader.finish()
}

// sessions 아래 rollout-*.jsonl — 연/월/일 폴더(실제 구조)지만 깊이에 기대지 않고 다 본다(지표는 누를 때만 읽는다)
const codexFiles = async (dir) => {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await codexFiles(path)))
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) found.push(path)
  }
  return found
}

// 바뀌지 않은 세션은 다시 읽지 않는다 — (크기 · 수정 시각)이 같으면 캐시. 세션 기록이 수 GB 라 스트림으로 읽고 기간 전에 끝난 파일은 건너뛴다
// codexSessionsDir — Codex rollout 자리(없으면 Codex 는 안 센다). 이 팩 세션이 아닌 rollout 도 캐시에 skip 으로 남겨 다시 읽지 않는다
export const scanSessions = async ({ projectsDir, codexSessionsDir = null, worktrees, cachePath, from = -Infinity }) => {
  const prefix = `${projectFolderName(worktrees)}-`
  let cache = {}
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')) } catch { /* 처음 · 망가졌으면 다시 센다 */ }
  const folders = (await readdir(projectsDir).catch(() => [])).filter((name) => name.startsWith(prefix))
  const targets = []
  for (const folder of folders) {
    const files = (await readdir(join(projectsDir, folder)).catch(() => [])).filter((name) => name.endsWith('.jsonl'))
    for (const file of files) targets.push({ path: join(projectsDir, folder, file), engine: 'claude' })
  }
  const realWorktrees = await realpath(worktrees).catch(() => worktrees)
  if (codexSessionsDir) for (const path of await codexFiles(codexSessionsDir)) targets.push({ path, engine: 'codex' })
  const sessions = []
  let changed = false
  for (const { path, engine } of targets) {
    const info = await stat(path).catch(() => null)
    if (!info || info.mtimeMs < from) continue
    let saved = cache[path]
    if (!saved || saved.size !== info.size || saved.mtimeMs !== info.mtimeMs) {
      const result = engine === 'codex' ? await readCodexSession(path, realWorktrees).catch(() => undefined) : await readSession(path).catch(() => undefined)
      if (result === undefined) continue
      saved = result
        ? { size: info.size, mtimeMs: info.mtimeMs, engine, kind: result.kind, pieces: result.pieces.map((piece) => [piece.plan, piece.label, piece.from, piece.to]) }
        : { size: info.size, mtimeMs: info.mtimeMs, engine, skip: true }
      cache[path] = saved
      changed = true
    }
    if (saved.skip) continue
    sessions.push({
      kind: saved.kind,
      engine: saved.engine ?? 'claude',
      lastAt: saved.mtimeMs,
      pieces: saved.pieces.map(([plan, label, start, end]) => ({ plan, label, from: start, to: end })),
    })
  }
  if (changed) await writeFile(cachePath, JSON.stringify(cache)).catch(() => {})
  return sessions
}
