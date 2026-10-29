// 에이전트 모니터 — Claude Code 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl) 한 줄을 화면에 보일 이벤트로.
// 아테나 scripts/agent-monitor.py 와 같은 규칙(도구 아이콘 · 요약 · pane 세션의 사용자 지시). Electron 없이 돌아 `npm test` 로 검사한다
import path from 'node:path'

// 기록 JSON 의 객체 하나(모양은 칸마다 따로 본다)
type Loose = Record<string, unknown>

// github — 현황판 GitHub 이슈 감시가 아테나에 맡긴 이슈(githubIssueEvents). 화면이 이 칸으로 문구를 지어 보인다(text 는 제목)
export type GithubIssueMark = { repo: string; number: number; title: string }
export type FeedEvent = { kind: 'tool' | 'say' | 'user'; icon: string; name: string; text: string; at: string | null; github?: GithubIssueMark }

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
  // 아테나 본체(~/.athena-studio/bodies/<id> 와 그 아래) — 폴더 이름이 본체 id 라 'athena' 로
  const isBody = /\/\.athena-studio\/bodies\/[^/]+(?:\/|$)/.test(cwd)
  const folderName = isBody ? 'athena' : path.basename(cwd)
  const repo = worktree ? worktree[1] : folderName
  const branch = record.gitBranch || folderName
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
