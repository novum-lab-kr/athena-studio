// PR 자동 리뷰 · 수정 · 머지(scripts/pr-auto.mjs)의 순수 로직 — 현황판(감지)과 자동 흐름이 같이 쓴다. 파일 · 네트워크를 건드리지 않는다
//
//   계획서 표시 줄(PR 마다 한 줄 · 바꿔 쓴다)
//     - Auto review: <레포>#<번호> @<sha7> · <결과> · 라운드 <k>/<상한> · <YYYY-MM-DD HH:MM>
//   결과: 승인 → 머지 확인 대기 · 승인 → 바로 머지(확인 없음) · 수정 필요 · 결정 필요 · 리뷰어 부족 · 검증 대기 · 멈춤 · 보류 · 머지됨
//   같은 PR · 같은 HEAD(sha7) 가 이미 적혀 있으면 다시 돌지 않는다

// 자동 머지 합의 — 결정 D2 "Claude·Codex 둘 다 승인"(+ 같은 HEAD 검증 통과). 하나라도 실패 · 로그인 안 됨 · 반려면 머지하지 않는다(남은 하나로 판정하지 않는다)
export const REVIEWERS = ['claude', 'codex']
// 수정 고리 상한 — 같은 PR 에서 자동 리뷰를 이만큼 돌았는데도 승인이 아니면 멈추고 사람에게 요청을 연다
export const MAX_ROUNDS = 3
// 끝난 결과 — 이 PR 은 사람이 이어받았다. 새 커밋이 와도 자동 리뷰를 다시 돌지 않는다(계획서에서 그 줄을 지우면 다시 돈다)
export const FINAL_RESULTS = ['멈춤', '머지됨']

// 리뷰어 답 형식 — Claude --json-schema · Codex --output-schema(엄격: 모든 객체에 additionalProperties false · 모든 키 required)
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes', 'decision'], description: 'approve = 이대로 머지해도 된다 · changes = 고칠 방법이 하나인 문제가 있다 · decision = 사람이 골라야 하는 선택지가 있다' },
    summary: { type: 'string', description: '리뷰 요약 2~4문장(한국어)' },
    findings: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: '파일 경로(diff 에 나온 그대로)' },
          line: { type: 'integer', description: '줄 번호(모르면 0)' },
          problem: { type: 'string', description: '무엇이 문제인가 한 줄' },
          fix: { type: 'string', description: '어떻게 고치나 한 줄 — 방법이 하나일 때만 findings 에 넣는다' },
        },
        required: ['file', 'line', 'problem', 'fix'],
      },
    },
    decisions: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '무엇을 정해야 하나 한 줄' },
          why: { type: 'string', description: '고르면 무엇이 달라지나 한 줄' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { label: { type: 'string' }, desc: { type: 'string' } },
              required: ['label', 'desc'],
            },
          },
          recommended: { type: 'string', description: '추천 선택지의 label 그대로(없으면 빈 문자열)' },
        },
        required: ['title', 'why', 'options', 'recommended'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings', 'decisions'],
}

const VERDICTS = new Set(['approve', 'changes', 'decision'])
// 리뷰어 답을 믿기 전에 모양을 본다(REVIEW_SCHEMA 그대로) — 하나라도 빠지거나 틀리면 그 리뷰어는 실패로 친다.
// 틀린 항목을 버리고 나머지를 쓰지 않는다 — 지적이 빠진 답이 승인으로 셀 수 있다(2026-10-25 실제 Codex 리뷰 지적)
const isText = (value) => typeof value === 'string'
const validFinding = (item) => Boolean(item) && isText(item.file) && Number.isInteger(item.line) && isText(item.problem) && isText(item.fix)
const validOption = (option) => Boolean(option) && isText(option.label) && option.label.trim() !== '' && isText(option.desc)
const validDecision = (item) => Boolean(item) && isText(item.title) && isText(item.why) && isText(item.recommended)
  && Array.isArray(item.options) && item.options.length >= 2 && item.options.every(validOption)
export const validReview = (answer) => {
  if (!answer || typeof answer !== 'object') return null
  if (!VERDICTS.has(answer.verdict) || !isText(answer.summary)) return null
  if (!Array.isArray(answer.findings) || !answer.findings.every(validFinding)) return null
  if (!Array.isArray(answer.decisions) || !answer.decisions.every(validDecision)) return null
  const { findings, decisions } = answer
  // 승인인데 지적이 있으면 승인으로 보지 않는다(LLM 이 모순된 답을 낸 것 — 사람 몫으로 가는 쪽이 안전하다)
  if (answer.verdict === 'approve' && (findings.length || decisions.length)) return { ...answer, verdict: decisions.length ? 'decision' : 'changes', findings, decisions }
  if (answer.verdict === 'decision' && !decisions.length) return null
  if (answer.verdict === 'changes' && !findings.length) return null
  return { ...answer, findings, decisions }
}

// 리뷰어 결과 묶기 — results: [{ name, status: 'ok'|'unavailable'|'failed', review?, reason? }]
// 판정 순서: 결정 필요(하나라도) → 수정 필요(하나라도) → REVIEWERS 가 모두 답했고 모두 승인이면 승인 → 아니면 리뷰어 부족(머지하지 않는다)
export const aggregate = (results) => {
  const answered = results.filter((result) => result.status === 'ok' && result.review)
  const approvals = answered.filter((result) => result.review.verdict === 'approve')
  const findings = answered.flatMap((result) => result.review.findings.map((item) => ({ ...item, by: result.name })))
  const decisions = answered.flatMap((result) => result.review.decisions.map((item) => ({ ...item, by: result.name })))
  let verdict = 'insufficient'
  if (decisions.length) verdict = 'decision'
  else if (findings.length || answered.some((result) => result.review.verdict === 'changes')) verdict = 'changes'
  else if (results.length === REVIEWERS.length && approvals.length === REVIEWERS.length) verdict = 'approve'
  return { verdict, approvals: approvals.length, answered: answered.length, total: results.length, findings, decisions }
}

// 리뷰어마다 짧은 상태 — 사건 기록 · 댓글 · 계획서에
export const reviewerBrief = (results) => results.map((result) => `${result.name}:${result.status === 'ok' ? result.review.verdict : result.status}`).join(',')

// ── 계획서 표시 줄 ─────────────────────────────────────────────────────
const AUTO_LINE = /^- Auto review:\s*([\w.-]+)#(\d+)\s+@([0-9a-f]{6,40})\s+·\s+(.+?)\s+·\s+라운드\s+(\d+)\/(\d+)(?:\s+·\s+(.*))?$/
export const autoLines = (planText) => {
  const found = new Map()
  for (const line of String(planText ?? '').split('\n')) {
    const hit = line.match(AUTO_LINE)
    if (hit) found.set(`${hit[1]}#${hit[2]}`, { repo: hit[1], number: hit[2], sha: hit[3], result: hit[4], round: Number(hit[5]), max: Number(hit[6]), stamp: hit[7] ?? '', line })
  }
  return found
}
export const autoLineText = ({ repo, number, sha, result, round, max = MAX_ROUNDS, stamp }) => `- Auto review: ${repo}#${number} @${String(sha).slice(0, 7)} · ${result} · 라운드 ${round}/${max} · ${stamp}`
// 계획서에 이 줄을 넣거나 바꾼 새 글 — 같은 PR 줄이 있으면 그 자리, 없으면 Work ref 뒤
export const withAutoLine = (planText, entry) => {
  const line = autoLineText(entry)
  const lines = String(planText).split('\n')
  const index = lines.findIndex((row) => { const hit = row.match(AUTO_LINE); return hit && hit[1] === entry.repo && hit[2] === String(entry.number) })
  if (index >= 0) { lines[index] = line; return lines.join('\n') }
  const anchor = lines.findIndex((row) => /^- Work ref:/.test(row))
  if (anchor >= 0) { lines.splice(anchor + 1, 0, line); return lines.join('\n') }
  return `${String(planText).replace(/\n*$/, '')}\n${line}\n`
}

// 이 HEAD 를 자동 흐름이 다시 봐야 하나 — 현황판 감지 · 대기열이 같이 쓴다
export const needsReview = (planText, repo, number, headSha) => {
  const known = autoLines(planText).get(`${repo}#${number}`)
  if (!known) return true
  if (FINAL_RESULTS.some((result) => known.result.startsWith(result))) return false
  return !String(headSha).startsWith(known.sha)
}

// ── 팩 설정 ────────────────────────────────────────────────────────────
// 결정 D4 — 레포별 스위치(pack.json 레포의 "autoMerge": true · 기본 꺼짐)
export const autoMergeRepos = (config) => new Set((config?.repos ?? []).filter((repo) => repo.autoMerge === true && !repo.direct).map((repo) => repo.name))
// 머지 직전 사람 확인(결정 D3)을 건너뛰는 레포 — 자동 머지를 켰고 "autoMergeConfirm": false 일 때만. 키가 없거나 false 가 아니면 지금처럼 묻는다
export const skipsMergeConfirm = (config, repoName) => autoMergeRepos(config).has(repoName)
  && (config?.repos ?? []).some((repo) => repo.name === repoName && repo.autoMergeConfirm === false)

const repoAgents = (repo) => [
  ...(repo.agents ?? []),
  ...(repo.packagesAgent ? [repo.packagesAgent] : []),
  ...Object.values(repo.apps ?? {}).map((app) => app.agent).filter(Boolean),
]
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentions = (text, name) => new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`).test(text)
// 계획서가 붙인 에이전트 — ship.sh 와 같은 기준(Agent 줄 + 정식 계획서 "작업 배분" 표의 첫 칸)
export const planAgents = (planText, config) => {
  const text = String(planText ?? '')
  const all = (config?.repos ?? []).flatMap(repoAgents)
  const found = new Set()
  const agentLine = text.match(/^- Agent:\s*(.+)$/m)?.[1] ?? ''
  for (const name of all) if (mentions(agentLine, name)) found.add(name)
  const table = text.match(/^## \d*\.?\s*작업 배분\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? ''
  for (const row of table.matchAll(/^\|\s*([^|]+?)\s*\|/gm)) for (const name of all) if (mentions(row[1], name)) found.add(name)
  return found
}
// 결정 D4 — 레포 하나짜리 작업인가. ship.sh 와 같은 기준 — 붙은 에이전트가 정확히 하나이고 그게 이 레포 것
// (ship.sh 는 에이전트가 둘 이상이면 같은 레포의 앱 에이전트끼리여도 아테나에게 넘긴다 — 자동 흐름도 그 PR 은 사람이)
export const singleRepoPlan = (planText, config, repoName) => {
  const repo = (config?.repos ?? []).find((entry) => entry.name === repoName)
  if (!repo) return false
  const found = [...planAgents(planText, config)]
  return found.length === 1 && repoAgents(repo).includes(found[0])
}

// 계획서 Work ref 줄 — 워크트리 경로 · pane
export const workRefOf = (planText) => {
  const line = String(planText ?? '').match(/^- Work ref:\s*(.+)$/m)?.[1] ?? ''
  const worktree = line.match(/(\/[^\s·]+)/)?.[1] ?? ''
  const pane = line.match(/\bpane\s+([\w:-]+)/)?.[1] ?? ''
  const agent = line.match(/\(([\w-]+)\)\s*$/)?.[1] ?? ''
  const branch = line.match(/🌿\s*(\S+)/)?.[1] ?? ''
  return { worktree, pane, agent, branch }
}

// ── 사람 · 에이전트에게 보낼 글 ─────────────────────────────────────────
const oneLine = (text, size) => {
  const flat = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
  return flat.length > size ? `${flat.slice(0, size)}…` : flat
}
// PR 댓글 본문 — 리뷰어마다 결론 · 요약 · 지적
export const reviewComment = ({ sha, round, results, summary }) => {
  const head = `### 🤖 자동 리뷰 — 라운드 ${round}/${MAX_ROUNDS} · @${String(sha).slice(0, 7)}`
  const verdictText = { approve: '승인', changes: '수정 필요', decision: '결정 필요', insufficient: `리뷰어 부족(승인 ${summary.approvals}/${REVIEWERS.length} · 둘 다 승인해야 머지)` }[summary.verdict]
  const rows = results.map((result) => {
    if (result.status !== 'ok') return `- **${result.name}** — ${result.status === 'unavailable' ? '못 씀' : '실패'}(${oneLine(result.reason, 120)})`
    const label = { approve: '승인', changes: '수정 필요', decision: '결정 필요' }[result.review.verdict]
    const items = [
      ...result.review.findings.map((item) => `  - \`${item.file}${item.line ? `:${item.line}` : ''}\` ${oneLine(item.problem, 300)} → ${oneLine(item.fix, 300)}`),
      ...result.review.decisions.map((item) => `  - 결정: ${oneLine(item.title, 200)} — ${item.options.map((option) => option.label).join(' / ')}`),
    ]
    return [`- **${result.name}** — ${label}: ${oneLine(result.review.summary, 600)}`, ...items].join('\n')
  })
  return `${head}\n\n**결론: ${verdictText}**\n\n${rows.join('\n')}\n`
}

// 작업 에이전트 pane 에 보낼 수정 지시 한 줄 — 지적 전문은 PR 댓글에 있다
export const fixInstruction = ({ agent, org, repo, number, sha, round, findings, plan, worktree, athenaDir }) => {
  const list = findings.slice(0, 6).map((item, index) => `${index + 1}) ${item.file}${item.line ? `:${item.line}` : ''} ${oneLine(item.problem, 160)} → ${oneLine(item.fix, 160)}`).join(' ')
  return oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} 라운드 ${round}/${MAX_ROUNDS} — 수정 필요: ${list}${findings.length > 6 ? ` 외 ${findings.length - 6}개` : ''}. 전문: gh pr view ${number} --repo ${org}/${repo} --comments. 자동 흐름 예외(이 지시에만): 고친 뒤 묻지 않고 ${athenaDir}/scripts/commit.sh --plan ${athenaDir}/${plan} --dir ${worktree} -m '<메시지>' -- <파일>… 로 커밋하고 ${athenaDir}/scripts/ship.sh --plan ${athenaDir}/${plan} --dir ${worktree} --auto-push 로 올린다(새 커밋을 자동 리뷰가 다시 본다). 고칠 방법이 하나가 아니면 고르지 말고 멈춰 아테나에 알린다. 계획서 Progress 에 한 줄`, 3500)
}

export const decisionNotice = ({ agent, repo, number, sha, count, plan, worktree, athenaDir }) => oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} — 결정 필요 ${count}개를 결정 콘솔(${plan})에 올렸다. 사람이 확정하면 그 지시가 이 pane 으로 온다 — 반영한 뒤 묻지 않고 ${athenaDir}/scripts/commit.sh … 로 커밋하고 ${athenaDir}/scripts/ship.sh --plan ${athenaDir}/${plan} --dir ${worktree} --auto-push 로 올린다(자동 흐름 예외)`, 2000)

// 리뷰 뒤 결정 → plan-html.mjs --add 의 decisions[] — 추천 label 이 선택지에 있을 때만 recommended
export const decisionsForConsole = (decisions) => decisions.map((item, index) => ({
  id: `r${index + 1}`,
  title: `R${index + 1} ${oneLine(item.title, 120)}`,
  desc: `${oneLine(item.why, 300)} (자동 리뷰 · ${item.by})`,
  type: 'single',
  required: true,
  options: item.options.map((option) => ({ label: oneLine(option.label, 80), desc: oneLine(option.desc, 300), ...(option.label === item.recommended ? { recommended: true } : {}) })),
}))
