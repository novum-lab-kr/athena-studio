// 에이전트 모니터 — Claude Code(~/.claude/projects)·Codex(~/.codex/sessions) 기록 한 줄을 화면 이벤트로.
// 아테나 scripts/agent-monitor.py 와 같은 규칙(도구 아이콘 · 요약 · pane 세션의 사용자 지시). Electron 없이 돌아 `npm test` 로 검사한다
import path from 'node:path'

// 기록 JSON 의 객체 하나(모양은 칸마다 따로 본다)
type Loose = Record<string, unknown>

// github — 현황판 GitHub 이슈 감시가 아테나에 맡긴 이슈(githubIssueEvents). 화면이 이 칸으로 문구를 지어 보인다(text 는 제목)
export type GithubIssueMark = { repo: string; number: number; title: string }
export type FeedEvent = { kind: 'tool' | 'say' | 'user'; icon: string; name: string; text: string; at: string | null; model?: string; github?: GithubIssueMark }

export const TOOL_ICON: Record<string, string> = { Exec: '⚙', Bash: '⚙', Read: '📖', Grep: '🔍', Glob: '📁', Edit: '✏️', Write: '📝', Agent: '🤖', WebFetch: '🌐', SubagentHandback: '📨' }

function isLoose(value: unknown): value is Loose {
  return Boolean(value) && typeof value === 'object'
}

// 한 줄로 — 줄바꿈·연속 공백을 하나로
const oneLine = (value: unknown): string => String(value || '').split(/\s+/).filter(Boolean).join(' ')

// 패치는 헤더의 작업·경로만 남긴다. 추가/삭제한 줄은 정규화 결과에도 넣지 않는다.
function patchChanges(patch: unknown): { kind: string; path: string }[] {
  if (typeof patch !== 'string') return []
  const changes: { kind: string; path: string }[] = []
  let started = false
  for (const line of patch.split(/\r?\n/)) {
    if (line === '*** Begin Patch') { started = true; continue }
    if (!started) continue
    if (line === '*** End Patch') break
    const file = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    const move = line.match(/^\*\*\* Move to: (.+)$/)
    if (file) changes.push({ kind: file[1]!, path: file[2]!.trim() })
    else if (move) changes.push({ kind: 'Move', path: move[1]!.trim() })
  }
  return changes
}

// 도구 입력 → 한 줄 요약(명령은 설명이 있으면 설명을 먼저)
export function summarizeTool(name: string, input: unknown): string {
  const value: Loose = isLoose(input) ? input : {}
  if (name === 'apply_patch') {
    const changes = Array.isArray(value.changes) ? value.changes : []
    return changes.filter(isLoose).map(change => `${oneLine(change.kind)} ${oneLine(change.path)}`).join(' · ') || 'apply_patch'
  }
  if (name === 'Bash' || name === 'Exec') return oneLine(value.description || value.command)
  if (name === 'Read' || name === 'Edit' || name === 'Write') return oneLine(value.file_path)
  if (name === 'Grep' || name === 'Glob') return oneLine(`${value.pattern || ''}  in ${value.path || ''}`)
  if (name === 'SubagentHandback') return '최종 보고 전송'
  if (name === 'Agent') return oneLine(value.description || value.subagent_type)
  return oneLine(JSON.stringify(value))
}

// code-mode 리터럴의 제어 문자는 모니터·터미널에 그대로 보내지 않는다.
const execText = (value: unknown): string => oneLine(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

// 단순한 code-mode 도구 호출만 읽는다. 문자열·주석 속 호출은 해석하지 않고,
// 변수 계산·제어 흐름 등은 실행하거나 추측하지 않고 기본 안내로 돌린다.
function execSummary(code: unknown): string {
  if (typeof code !== 'string' || code.length > 64_000) return '명령 실행'
  type Token = { raw: string; text?: string }
  const tokens: Token[] = []
  const pattern = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g
  for (const match of code.matchAll(pattern)) {
    const raw = match[0]
    if (raw.startsWith('//') || raw.startsWith('/*')) continue
    let text: string | undefined
    if (raw.length >= 2 && /^["'`]/.test(raw) && raw.at(-1) === raw[0]) {
      if (raw[0] === '`' && raw.includes('${')) return '명령 실행'
      let valid = true
      text = raw.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\s\S])/g, (_escape, part: string) => {
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'", '`': '`', '\n': '' }
        if (/^(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})$/.test(part)) return String.fromCharCode(parseInt(part.slice(1), 16))
        if (part in escapes) return escapes[part]!
        valid = false
        return ''
      })
      if (!valid) return '명령 실행'
    }
    tokens.push({ raw, ...(text !== undefined && { text }) })
  }
  let index = 0
  const take = (raw: string): boolean => {
    if (tokens[index]?.raw !== raw) return false
    index += 1
    return true
  }
  const summaries: string[] = []
  while (index < tokens.length) {
    const wrapped = take('text')
    if (wrapped && !take('(')) return '명령 실행'
    take('await')
    if (!take('tools') || !take('.')) return '명령 실행'
    const method = tokens[index++]?.raw
    if (!method || !/^[\w$]+$/.test(method) || !take('(')) return '명령 실행'
    const patch = tokens[index]?.text
    if (patch !== undefined) index += 1
    else if (!take('{')) return '명령 실행'
    const fields: Record<string, string> = {}
    while (patch === undefined && tokens[index]?.raw !== '}') {
      const key = tokens[index++]
      if (!key || !/^[\w$]+$/.test(key.text ?? key.raw) || !take(':')) return '명령 실행'
      const start = index
      const closing: string[] = []
      while (index < tokens.length) {
        const token = tokens[index]!
        if (token.text === undefined) {
          if (closing.length === 0 && [',', '}'].includes(token.raw)) break
          if (['(', '[', '{'].includes(token.raw)) closing.push({ '(': ')', '[': ']', '{': '}' }[token.raw]!)
          else if ([')', ']', '}'].includes(token.raw) && closing.pop() !== token.raw) return '명령 실행'
        }
        index += 1
      }
      if (closing.length || index === start) return '명령 실행'
      const literal = index === start + 1 ? tokens[start]?.text : undefined
      delete fields[key.text ?? key.raw]
      if (literal !== undefined) fields[key.text ?? key.raw] = literal
      if (!take(',')) break
    }
    if ((patch === undefined && !take('}')) || !take(')') || (wrapped && !take(')'))) return '명령 실행'
    take(';')
    const title = execText(fields.title || fields.description).slice(0, 120)
    if (['exec_command', 'shell_command', 'shell'].includes(method)) {
      const command = execText((fields.cmd || fields.command || '').split(/\r?\n/)[0]).slice(0, 120)
      summaries.push(title || command ? `명령 실행 · ${title || command}` : '명령 실행')
    } else if (method === 'view_image') {
      const file = execText(fields.path).slice(0, 120)
      summaries.push(title || file ? `이미지 확인 · ${title || file}` : '이미지 확인')
    } else if (method === 'apply_patch') {
      const changes = patchChanges(patch).map(change => `${change.kind} ${execText(change.path)}`).join(' · ').slice(0, 120)
      summaries.push(changes ? `파일 변경 · ${changes}` : '파일 변경')
    } else summaries.push(title ? `도구 실행 · ${title}` : '도구 실행')
  }
  return summaries.length > 1 ? `${summaries[0]} · 외 ${summaries.length - 1}개 작업` : summaries[0] || '명령 실행'
}

// Codex가 기록한 모델만 사용한다. 모델 문맥이 없는 줄은 undefined, 명시적으로 비었으면 null.
export function codexModelOf(record: unknown): string | null | undefined {
  if (!isLoose(record) || !isLoose(record.payload)) return undefined
  const value = record.payload
  const context = record.type === 'turn_context' ? value :
    record.type === 'event_msg' && value.type === 'thread_settings_applied' && isLoose(value.thread_settings) ? value.thread_settings : null
  if (!context || !('model' in context)) return undefined
  return typeof context.model === 'string' && /^[a-z]/i.test(context.model) ? context.model : null
}

function toolIcon(name: string, input: unknown): string {
  if (name === 'apply_patch' && isLoose(input) && Array.isArray(input.changes) && input.changes.length) {
    return input.changes.every(change => isLoose(change) && change.kind === 'Add') ? TOOL_ICON.Write! : TOOL_ICON.Edit!
  }
  return TOOL_ICON[name] || '•'
}

// Codex rollout은 session_meta / response_item의 payload에 같은 정보를 담는다.
// event_msg는 같은 응답을 다시 담으므로 response_item만 기존 Claude 입력으로 정규화한다.
export function codexRecord(record: unknown, model?: string | null): Loose {
  if (!isLoose(record) || !isLoose(record.payload)) return {}
  const value = record.payload
  if (record.type === 'session_meta') {
    return { cwd: value.cwd ?? null, gitBranch: (isLoose(value.git) ? value.git.branch : null) ?? null }
  }
  if (record.type !== 'response_item') return {}
  const stamp = typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}
  const modelPart = typeof model === 'string' && /^[a-z]/i.test(model) ? { model } : {}
  if (value.type === 'message' && (value.role === 'user' || value.role === 'assistant') && Array.isArray(value.content)) {
    const text = value.content.filter((block): block is Loose => isLoose(block) && (block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string').map(block => block.text).join('\n')
    return { ...stamp, type: value.role, message: { ...(value.role === 'assistant' ? modelPart : {}), content: value.role === 'user' ? text : [{ type: 'text', text }] } }
  }
  if (value.type !== 'function_call' && value.type !== 'custom_tool_call') return {}
  let name = typeof value.name === 'string' && value.name ? value.name : 'tool'
  let input: Loose
  if (value.type === 'function_call') {
    try {
      const args: unknown = typeof value.arguments === 'string' ? JSON.parse(value.arguments) : value.arguments ?? {}
      if (!isLoose(args) || Array.isArray(args)) return {}
      input = args
    } catch { return {} }
  } else input = { input: value.input ?? '' }
  if (name.split('.').at(-1) === 'apply_patch') {
    name = 'apply_patch'
    input = { changes: patchChanges(input.patch ?? input.input) }
  } else if (name.split('.').at(-1) === 'exec') {
    name = 'Exec'
    const title = [input.title, input.description, value.title, value.description].find(item => typeof item === 'string' && item.trim())
    input = { description: execText(title).slice(0, 160) || execSummary(input.input ?? input.code) }
  } else if (['exec_command', 'shell_command', 'shell'].includes(name.split('.').at(-1) || '')) {
    name = 'Bash'
    const cmd = input.cmd || input.command || ''
    input = { command: Array.isArray(cmd) ? cmd.map(String).join(' ') : cmd, description: input.description || input.title || null }
  } else if (input.title) input = { title: input.title }
  return { ...stamp, type: 'assistant', message: { ...modelPart, content: [{ type: 'tool_use', name, input }] } }
}

// 기존 앱의 본체·팩 워크트리·활성 pane 판정을 Codex에도 그대로 적용한다.
// Python 모니터와 공통 fixture로 같은 입력의 판정·정규화를 비교한다.
export function codexSessionMatches(cwd: string, body: string | null, worktrees: string | null, active: readonly string[]): boolean {
  if (!cwd) return false
  const name = projectDirName(cwd)
  const bodyName = body ? projectDirName(body) : null
  const worktreesName = worktrees ? projectDirName(worktrees) : null
  return active.some(dir => projectDirName(dir) === name) ||
    Boolean(worktreesName && name.startsWith(`${worktreesName}-`)) ||
    Boolean(bodyName && (name === bodyName || name.startsWith(`${bodyName}--`)))
}

// 기록의 cwd · gitBranch → '레포·브랜치'(워크트리면 그 레포 — 본체 안 .worktrees/<레포>/ · 여러 팩 구조의 packs/<팩>/worktrees/<레포>/)
export function sessionLabel(record: unknown): string | null {
  if (isLoose(record) && record.type === 'session_meta') record = codexRecord(record)
  if (!isLoose(record) || typeof record.cwd !== 'string' || !record.cwd) return null
  const cwd = record.cwd
  const worktree = cwd.match(/\/(?:\.worktrees|packs\/[^/]+\/worktrees)\/([^/]+)\//)
  // 아테나 본체(~/.athena-studio/bodies/<id> 와 그 아래) — 폴더 이름이 본체 id 라 'athena' 로
  const isBody = /\/\.athena-studio\/bodies\/[^/]+(?:\/|$)/.test(cwd)
  const folderName = isBody ? 'athena' : path.basename(cwd)
  const repo = worktree ? worktree[1] : folderName
  // 브랜치 대체값은 워크트리면 기존대로 폴더 이름, 본체일 때만 athena
  const branch = record.gitBranch || (worktree ? path.basename(cwd) : folderName)
  return `${repo}·${branch}`
}

// 서브에이전트 이름표 — 옆의 agent-*.meta.json(description · agentType · finished)
export function subagentInfo(meta: unknown): { label: string | null; finished: boolean } {
  if (!isLoose(meta)) return { label: null, finished: false }
  const name = oneLine(meta.description || meta.agentType)
  return { label: name ? `🤖 ${name}` : null, finished: meta.finished === true }
}

// 실제로 답한 모델 — assistant 줄의 message.model(예: claude-sonnet-5-5). 없거나 '<synthetic>' 같은 자리값이면 null
export function modelOf(record: unknown): string | null {
  if (!isLoose(record) || record.type !== 'assistant' || !isLoose(record.message)) return null
  const model = record.message.model
  return typeof model === 'string' && /^[a-z]/i.test(model) ? model : null
}

// 모델 id → 짧은 이름(claude-sonnet-5-5 → Sonnet 5.5 · claude-3-5-sonnet-20241022 → Sonnet 3.5). 모르는 모양은 지어내지 않고 id 그대로
export function modelShortName(model: string | null | undefined): string | null {
  if (!model) return null
  const match = model.match(/^claude-(?:(\d+)(?:-(\d{1,2}))?-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?$/)
  if (!match) return model
  const [, frontMajor, frontMinor, family, backMajor, backMinor] = match
  const major = frontMajor ?? backMajor
  const minor = frontMajor ? frontMinor : backMinor
  const name = `${family?.[0]?.toUpperCase()}${family?.slice(1)}`
  return major ? `${name} ${major}${minor ? `.${minor}` : ''}` : name
}

// 기록 한 줄 → 이벤트 목록 { kind: tool | say | user, icon, name, text, at }
export function eventsFromRecord(record: unknown): FeedEvent[] {
  if (isLoose(record) && record.type === 'response_item') record = codexRecord(record)
  // 대화 줄(user · assistant)만 — api-request-blob 같은 기록도 같은 content 를 담고 있어 두 번 찍힌다
  if (!isLoose(record) || (record.type !== 'user' && record.type !== 'assistant')) return []
  const at = typeof record.timestamp === 'string' ? record.timestamp : null
  const message = record.message
  const content = isLoose(message) ? message.content : undefined
  // 사용자가 pane 에 입력한 지시 — 시스템·명령 메시지는 '<' 로 시작해서 뺀다
  if (record.type === 'user' && typeof content === 'string') {
    if (record.isMeta || record.isCompactSummary) return []
    const text = oneLine(content)
    return text && !text.startsWith('<') ? [{ kind: 'user', icon: '👤', name: '', text, at }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: unknown[] = content
  // 답한 모델(assistant 줄에만) — 줄마다 그 줄을 쓴 모델이라 세션 중간에 바꿔도 줄별로 맞다
  const model = modelShortName(modelOf(record))
  const events: FeedEvent[] = []
  for (const block of blocks) {
    if (!isLoose(block)) continue
    if (block.type === 'tool_use') {
      const name = String(block.name || '')
      events.push({ kind: 'tool', icon: toolIcon(name, block.input), name, text: summarizeTool(name, block.input), at, ...(model && { model }) })
    } else if (block.type === 'text' && record.type === 'assistant') {
      const text = oneLine(block.text)
      if (text.length > 3) events.push({ kind: 'say', icon: '💬', name: '', text, at, ...(model && { model }) })
    }
  }
  return events
}

export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// cwd → ~/.claude/projects 아래 폴더 이름(영문·숫자 밖은 '-')
export function projectDirName(cwd: unknown): string {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-')
}

// 현황판 GET /api/github-issues 의 issues → 모니터 이벤트. seen 에 없던 것만(창마다 · 한 번씩) · since(ms) 보다 오래된 것은 빼고 기억만.
// 모양이 다른 칸은 건너뛴다(현황판은 다른 본체 코드일 수 있다)
export function githubIssueEvents(issues: unknown, seen: Set<string>, since: number): FeedEvent[] {
  if (!Array.isArray(issues)) return []
  const list: unknown[] = issues
  const events: FeedEvent[] = []
  for (const item of list) {
    if (!isLoose(item) || typeof item.repo !== 'string' || !Number.isInteger(item.number) || typeof item.at !== 'string') continue
    const key = `${item.repo}#${item.number}`
    if (seen.has(key)) continue
    seen.add(key)
    const at = Date.parse(item.at)
    if (Number.isNaN(at) || at < since) continue
    const title = oneLine(item.title)
    events.push({ kind: 'say', icon: '📥', name: 'GitHub', text: title, at: item.at, github: { repo: item.repo, number: Number(item.number), title } })
  }
  return events
}
