// 에이전트 모니터 — Claude Code 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl) 한 줄을 화면에 보일 이벤트로.
// 아테나 scripts/agent-monitor.py 와 같은 규칙(도구 아이콘 · 요약 · pane 세션의 사용자 지시). Electron 없이 돌아 `npm test` 로 검사한다
import path from 'node:path'

// 기록 JSON 의 객체 하나(모양은 칸마다 따로 본다)
type Loose = Record<string, unknown>

export type FeedEvent = { kind: 'tool' | 'say' | 'user'; icon: string; name: string; text: string; at: string | null }

export const TOOL_ICON: Record<string, string> = { Bash: '⚙', Read: '📖', Grep: '🔍', Glob: '📁', Edit: '✏️', Write: '📝', Agent: '🤖', WebFetch: '🌐', SubagentHandback: '📨' }

function isLoose(value: unknown): value is Loose {
  return Boolean(value) && typeof value === 'object'
}

// 한 줄로 — 줄바꿈·연속 공백을 하나로
const oneLine = (value: unknown): string => String(value || '').split(/\s+/).filter(Boolean).join(' ')

// 도구 입력 → 한 줄 요약(명령은 설명이 있으면 설명을 먼저)
export function summarizeTool(name: string, input: unknown): string {
  const value: Loose = isLoose(input) ? input : {}
  if (name === 'Bash') return oneLine(value.description || value.command)
  if (name === 'Read' || name === 'Edit' || name === 'Write') return oneLine(value.file_path)
  if (name === 'Grep' || name === 'Glob') return oneLine(`${value.pattern || ''}  in ${value.path || ''}`)
  if (name === 'SubagentHandback') return '최종 보고 전송'
  if (name === 'Agent') return oneLine(value.description || value.subagent_type)
  return oneLine(JSON.stringify(value))
}

// 기록의 cwd · gitBranch → '레포·브랜치'(워크트리면 그 레포 — 본체 안 .worktrees/<레포>/ · 여러 팩 구조의 packs/<팩>/worktrees/<레포>/)
export function sessionLabel(record: unknown): string | null {
  if (!isLoose(record) || typeof record.cwd !== 'string' || !record.cwd) return null
  const cwd = record.cwd
  const worktree = cwd.match(/\/(?:\.worktrees|packs\/[^/]+\/worktrees)\/([^/]+)\//)
  const repo = worktree ? worktree[1] : path.basename(cwd)
  const branch = record.gitBranch || path.basename(cwd)
  return `${repo}·${branch}`
}

// 서브에이전트 이름표 — 옆의 agent-*.meta.json(description · agentType · finished)
export function subagentInfo(meta: unknown): { label: string | null; finished: boolean } {
  if (!isLoose(meta)) return { label: null, finished: false }
  const name = oneLine(meta.description || meta.agentType)
  return { label: name ? `🤖 ${name}` : null, finished: meta.finished === true }
}

// 기록 한 줄 → 이벤트 목록 { kind: tool | say | user, icon, name, text, at }
export function eventsFromRecord(record: unknown): FeedEvent[] {
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
  const events: FeedEvent[] = []
  for (const block of blocks) {
    if (!isLoose(block)) continue
    if (block.type === 'tool_use') {
      const name = String(block.name || '')
      events.push({ kind: 'tool', icon: TOOL_ICON[name] || '•', name, text: summarizeTool(name, block.input), at })
    } else if (block.type === 'text' && record.type === 'assistant') {
      const text = oneLine(block.text)
      if (text.length > 3) events.push({ kind: 'say', icon: '💬', name: '', text, at })
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
