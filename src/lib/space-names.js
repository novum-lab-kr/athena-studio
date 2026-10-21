// 왼쪽 spaces 목록의 pane 줄 이름 — 화면(renderer)이 <script> 로 싣는다(layout.js 와 같은 방식 · 전역 StudioSpaceNames).
// delegate 가 붙인 이름표 '🤖 <에이전트> · <브랜치>' 를 [브랜치 · 역할] 두 칸으로 나눈다.
//   브랜치는 '/' 앞 접두어를 떼고(feature/REF-1 → REF-1), 역할은 레포 이름을 뗀다(fsd-agent-team-fe → fe).
//   전체 이름은 tip 으로(툴팁). 이름표가 그 모양이 아니면 그대로 쓰고 역할은 비운다.
//   이름표가 없으면 터미널 제목(아테나 pane 은 Claude Code 가 대화 주제를 적는다)에서 앞 상태 기호를 떼고 쓴다.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.StudioSpaceNames = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const AGENT_LABEL = /^🤖\s*(.+?)\s*·\s*(.+)$/
  // 에이전트가 터미널 제목 앞에 붙이는 상태 기호(Claude Code 의 ✳ · 일할 때 도는 점자 ⠂) — 상태는 줄 앞 점이 보인다
  const TITLE_MARK = /^[\u2722-\u273d\u2800-\u28ff*]\s+/

  function shortBranch(branch) {
    const name = String(branch || '').trim()
    const slash = name.indexOf('/')
    return slash > 0 && slash < name.length - 1 ? name.slice(slash + 1) : name
  }

  function agentRole(agent, repo) {
    const prefix = repo ? `${repo}-` : ''
    return prefix && agent.startsWith(prefix) && agent.length > prefix.length ? agent.slice(prefix.length) : agent
  }

  function paneRow(pane, repo) {
    const label = String(pane.label || '').trim()
    const match = label.match(AGENT_LABEL)
    if (!match) {
      const name = label || String(pane.title || '').replace(TITLE_MARK, '').trim() || pane.id
      return { branch: name, role: '', tip: name }
    }
    const [, agent, branch] = match
    return { branch: shortBranch(branch), role: agentRole(agent, repo), tip: `${branch}\n${agent}` }
  }

  return { shortBranch, agentRole, paneRow }
})
