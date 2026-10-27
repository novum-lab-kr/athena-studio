// 왼쪽 spaces 목록의 pane 줄 이름 — ES 모듈(layout.mts 와 같은 방식 · 화면은 진입점이 전역 StudioSpaceNames 로 넣는다).
// delegate 가 붙인 이름표 '🤖 <에이전트> · <브랜치>' 를 [브랜치 · 역할] 두 칸으로 나눈다.
//   브랜치는 '/' 앞 접두어를 떼고(feature/REF-1 → REF-1), 역할은 레포 이름을 뗀다(fsd-agent-team-fe → fe).
//   전체 이름은 tip 으로(툴팁). 이름표가 그 모양이 아니면 그대로 쓰고 역할은 비운다.
//   이름표가 없으면 터미널 제목(아테나 pane 은 Claude Code 가 대화 주제를 적는다)에서 앞 상태 기호를 떼고 쓴다.
// 데몬 pane 에서 읽는 칸만
export type NamedPane = { id: string; label?: unknown; title?: unknown }
export type PaneRow = { branch: string; role: string; tip: string }

const AGENT_LABEL = /^🤖\s*(.+?)\s*·\s*(.+)$/
// 에이전트가 터미널 제목 앞에 붙이는 상태 기호(Claude Code 의 ✳ · 일할 때 도는 점자 ⠂) — 상태는 줄 앞 점이 보인다
const TITLE_MARK = /^[\u2722-\u273d\u2800-\u28ff*]\s+/

export function shortBranch(branch: unknown): string {
  const name = String(branch || '').trim()
  const slash = name.indexOf('/')
  return slash > 0 && slash < name.length - 1 ? name.slice(slash + 1) : name
}

export function agentRole(agent: string, repo?: string | null): string {
  const prefix = repo ? `${repo}-` : ''
  return prefix && agent.startsWith(prefix) && agent.length > prefix.length ? agent.slice(prefix.length) : agent
}

export function paneRow(pane: NamedPane, repo?: string | null): PaneRow {
  const label = String(pane.label || '').trim()
  const match = label.match(AGENT_LABEL)
  if (!match) {
    const name = label || String(pane.title || '').replace(TITLE_MARK, '').trim() || pane.id
    return { branch: name, role: '', tip: name }
  }
  const [, agent, branch] = match as unknown as [string, string, string]
  return { branch: shortBranch(branch), role: agentRole(agent, repo), tip: `${branch}\n${agent}` }
}
