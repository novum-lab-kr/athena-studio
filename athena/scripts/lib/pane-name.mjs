// 아테나 pane 이름표 — '<레포> · <제목 앞 30자>' (레포를 못 정하면 제목만)
// 레포는 맡은 계획서에서 읽는다 → 팩 레포 표시 이름(pack.json repos[] displayName)이 있으면 그것, 없으면 레포 name(사이드바와 같은 이름)
//   경량 계획서   Checkpoint 의 `- Agent: <에이전트>` → 그 에이전트가 맡은 레포(repos[].agents · packagesAgent · apps[].agent)
//   정식 계획서   `## 6. 작업 배분` 표의 첫 칸(담당)에 적힌 에이전트들 → 레포(reviewer 등 레포 담당이 아닌 이름은 건너뛴다)
//   이슈          frontmatter `repo: <레포>[/<앱>]` (athena · hermes 는 레포 아님)
// 레포 하나면 'syung', 여럿이면 계획서에 적힌 첫 레포 + 나머지 수('syung +1'). 설정을 못 읽으면 레포 없이 제목만.
import { loadConfig } from './config.mjs'

const TITLE_MAX = 30

const tokens = (text) => String(text ?? '').split(/[\s,/·+&()]+/).filter(Boolean)

// 에이전트 → 레포 name (config.repos 에서)
const repoOfAgent = (config, agent) => {
  for (const repo of config.repos ?? []) {
    if (repo.agents?.includes(agent) || repo.packagesAgent === agent) return repo
    for (const app of Object.values(repo.apps ?? {})) if (app?.agent === agent) return repo
  }
  return null
}

// 계획서 글에서 에이전트 이름들 — 경량 `- Agent:` 줄 + 정식 작업 배분 표 첫 칸
export const agentsOfPlan = (text) => {
  const found = []
  const agentLine = String(text ?? '').match(/^-\s*Agent:\s*(.+)$/m)?.[1]
  if (agentLine) found.push(...tokens(agentLine))
  const section = String(text ?? '').match(/^##\s*(?:\d+\.\s*)?작업 배분[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]
  if (section) {
    for (const line of section.split('\n')) {
      const cells = line.split('|').map((cell) => cell.trim())
      if (cells.length < 3 || cells[0] !== '') continue   // 표 줄('| a | b |')만
      if (/^[-: ]*$/.test(cells[1]) || cells[1] === '담당') continue   // 구분선 · 머리 줄
      found.push(...tokens(cells[1]))
    }
  }
  return found
}

const labelOf = (repo) => (typeof repo.displayName === 'string' && repo.displayName.trim()) || repo.name

// 에이전트 이름들 → 'A' · 'A +N' (적힌 순서 · 같은 레포는 한 번 · 못 찾으면 '')
export const repoLabelOfAgents = (config, agents) => {
  const names = []
  for (const agent of agents) {
    const repo = repoOfAgent(config, agent)
    if (repo && !names.includes(labelOf(repo))) names.push(labelOf(repo))
  }
  if (!names.length) return ''
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`
}

// 이슈 repo 값('<레포>' · '<레포>/<앱>') → 표시 이름 · 레포가 아니면 ''
export const repoLabelOfValue = (config, value) => {
  const name = String(value ?? '').split('/')[0].trim()
  const repo = (config.repos ?? []).find((entry) => entry.name === name)
  return repo ? labelOf(repo) : ''
}

// 이름표 — 제목이 비면 '' (부른 쪽은 이름을 바꾸지 않는다)
export const paneNameOf = (title, repoLabel = '') => {
  const clipped = String(title ?? '').slice(0, TITLE_MAX).trim()
  if (!clipped) return ''
  return repoLabel ? `${repoLabel} · ${clipped}` : clipped
}

// 계획서 글 + 제목 → 이름표. 설정을 못 읽으면 제목만
export const paneNameOfPlan = (title, { planText = '', agents = [] } = {}, root) => {
  let repoLabel = ''
  try {
    repoLabel = repoLabelOfAgents(loadConfig(root), [...agents, ...agentsOfPlan(planText)])
  } catch { /* 팩이 아직 없다 — 제목만 */ }
  return paneNameOf(title, repoLabel)
}
