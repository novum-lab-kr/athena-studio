// PR 자동 리뷰 · 수정 · 머지(scripts/pr-auto.mjs)의 순수 로직 — 현황판(감지)과 자동 흐름이 같이 쓴다. 파일 · 네트워크를 건드리지 않는다
//
//   계획서 표시 줄(PR 마다 한 줄 · 바꿔 쓴다)
//     - Auto review: <레포>#<번호> @<sha7> · <결과> · 라운드 <k>/<상한> · <YYYY-MM-DD HH:MM>
//   결과: 승인 → 머지 확인 대기 · 승인 → 바로 머지(확인 없음) · 수정 필요 · 결정 필요 · 리뷰어 부족 · 검증 대기 · 멈춤 · 보류 · 머지됨 · 본문 고침
//         · 상한 뒤 이어받음 → 머지 확인 대기 / 바로 머지(확인 없음) — 라운드가 상한을 넘은 HEAD(리뷰 없이 같은 HEAD 검증 · 충돌 확인만)
//   같은 PR · 같은 HEAD(sha7) 가 이미 적혀 있으면 다시 돌지 않는다 — 본문 고침(ship.sh --auto-push --body-file 이 커밋 없이 본문만 바꿈)만 같은 HEAD 를 다시 본다

// 자동 머지 합의 — 결정 D2 "Claude·Codex 둘 다 승인"(+ 같은 HEAD 검증 통과). 하나라도 실패 · 로그인 안 됨 · 반려면 머지하지 않는다(남은 하나로 판정하지 않는다)
export const REVIEWERS = ['claude', 'codex']
// 리뷰 상한 — 같은 PR 에서 자동 리뷰는 이만큼만 돈다. 상한 라운드에도 승인이 아니면 멈추지 않고 이어받는다(2026-10-26 사용자 결정 C):
// 남은 수정 지적을 에이전트에 보내고, 고친 새 HEAD(라운드 > 상한)는 리뷰 없이 같은 HEAD 검증 · 충돌 확인만으로 승인과 같은 머지 단계로 간다
export const MAX_ROUNDS = 3
export const TAKEOVER = '상한 뒤 이어받음'
export const isTakeoverRound = (round) => round > MAX_ROUNDS
// 상한 라운드가 이어받기를 허락했나 — 그 라운드가 쓴 줄('수정 필요 — 상한 뒤 이어받음…' · '결정 필요 — 상한 뒤 이어받음…')로 시작할 때만.
// 이어받은 HEAD 가 머지 단계로 간 뒤의 줄('상한 뒤 이어받음(…) → 머지 확인 대기' 등)은 아니다 — 그 뒤 온 커밋은 멈춘다(PR #20 자동 리뷰 지적)
export const grantsTakeover = (result) => [`수정 필요 — ${TAKEOVER}`, `결정 필요 — ${TAKEOVER}`].some((head) => String(result ?? '').startsWith(head))
// 이 리뷰 라운드가 다음 커밋에 이어받기를 줄 수 있나 — 상한 라운드 · 승인 아님 · 리뷰어가 모두 답했을 때만(하나라도 실패한 라운드는 그 리뷰어가 본 적이 없으니 주지 않는다)
export const takeoverEligible = (summary, round) => round >= MAX_ROUNDS && ['changes', 'decision'].includes(summary.verdict)
  && summary.total === REVIEWERS.length && summary.answered === REVIEWERS.length
// 끝난 결과 — 이 PR 은 사람이 이어받았다. 새 커밋이 와도 자동 리뷰를 다시 돌지 않는다(계획서에서 그 줄을 지우면 다시 돈다).
// 멈춤은 옛 상한 동작(2026-10-26 전)의 줄 — 지금 흐름은 라운드 상한으로 멈추지 않는다
export const FINAL_RESULTS = ['멈춤', '머지됨']
// 커밋 없이 PR 본문만 고쳤다(ship.sh --auto-push --body-file) — 같은 HEAD 지만 다시 리뷰하고 라운드를 하나 쓴다
export const BODY_EDITED = '본문 고침'

// 지적의 등급 — blocking(막음: 버그 · 보안 · 데이터 위험 · 레포 규칙 위반 — 수정 필요 · 머지 차단) · advisory(권장: 그 밖 — PR 댓글에만 · 에이전트에 보내지 않고 머지를 막지 않는다)
// (2026-10-26 사용자 결정 E — 기준은 리뷰 프롬프트의 승인 기준 "버그 · 보안 · 데이터 위험 · 레포 규칙 위반" 그대로)
export const FINDING_SEVERITIES = ['blocking', 'advisory']
// 결정의 종류 — implementation(구현 세부)이고 추천안이 선택지에 있으면 사람을 기다리지 않고 추천안으로 자동 확정한다(2026-10-26 사용자 결정 B).
// product(제품 동작 · 범위 · 외부 계약 · 데이터)이거나 추천이 없으면 지금처럼 결정 콘솔 · 사람
export const DECISION_KINDS = ['implementation', 'product']
// 리뷰어 답 형식 — Claude --json-schema · Codex --output-schema(엄격: 모든 객체에 additionalProperties false · 모든 키 required)
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes', 'decision'], description: 'approve = 이대로 머지해도 된다(advisory 지적만 있어도) · changes = 고칠 방법이 하나인 blocking 문제가 있다 · decision = 골라야 하는 선택지가 있다' },
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
          severity: { type: 'string', enum: FINDING_SEVERITIES, description: 'blocking = 버그 · 보안 · 데이터 위험 · 레포 규칙 위반(머지를 막는다) · advisory = 그 밖의 권장(머지를 막지 않고 PR 댓글에만)' },
        },
        required: ['file', 'line', 'problem', 'fix', 'severity'],
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
          kind: { type: 'string', enum: DECISION_KINDS, description: 'implementation = 구현 세부(코드 안의 자리 · 이름 · 구조 · 제한값처럼 사용자가 보는 제품 동작 · 범위 · 외부 계약 · 데이터가 그대로인 것) · product = 제품 동작 · 범위 · 외부 계약 · 데이터가 달라지는 것. 애매하면 product' },
        },
        required: ['title', 'why', 'options', 'recommended', 'kind'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings', 'decisions'],
}

const VERDICTS = new Set(['approve', 'changes', 'decision'])
// 리뷰어 답을 믿기 전에 모양을 본다(REVIEW_SCHEMA 그대로) — 하나라도 빠지거나 틀리면 그 리뷰어는 실패로 친다.
// 틀린 항목을 버리고 나머지를 쓰지 않는다 — 지적이 빠진 답이 승인으로 셀 수 있다(2026-10-25 실제 Codex 리뷰 지적)
const isText = (value) => typeof value === 'string'
const validFinding = (item) => Boolean(item) && isText(item.file) && Number.isInteger(item.line) && isText(item.problem) && isText(item.fix) && FINDING_SEVERITIES.includes(item.severity)
export const isBlocking = (finding) => finding.severity === 'blocking'
const validOption = (option) => Boolean(option) && isText(option.label) && option.label.trim() !== '' && isText(option.desc)
const validDecision = (item) => Boolean(item) && isText(item.title) && isText(item.why) && isText(item.recommended) && DECISION_KINDS.includes(item.kind)
  && Array.isArray(item.options) && item.options.length >= 2 && item.options.every(validOption)
export const validReview = (answer) => {
  if (!answer || typeof answer !== 'object') return null
  if (!VERDICTS.has(answer.verdict) || !isText(answer.summary)) return null
  if (!Array.isArray(answer.findings) || !answer.findings.every(validFinding)) return null
  if (!Array.isArray(answer.decisions) || !answer.decisions.every(validDecision)) return null
  const { findings, decisions } = answer
  // 승인인데 막는 지적 · 결정이 있으면 승인으로 보지 않는다(LLM 이 모순된 답을 낸 것 — 사람 몫으로 가는 쪽이 안전하다). 권장(advisory)만이면 승인 그대로
  if (answer.verdict === 'approve' && (findings.some(isBlocking) || decisions.length)) return { ...answer, verdict: decisions.length ? 'decision' : 'changes', findings, decisions }
  if (answer.verdict === 'decision' && !decisions.length) return null
  if (answer.verdict === 'changes' && !findings.length) return null
  return { ...answer, findings, decisions }
}

// 추천안으로 자동 확정해도 되는 결정 — 구현 세부이고 추천 label 이 선택지에 그대로 있을 때만
export const autoResolvable = (decision) => decision.kind === 'implementation' && decision.recommended.trim() !== ''
  && decision.options.some((option) => option.label === decision.recommended)

// 리뷰어 결과 묶기 — results: [{ name, status: 'ok'|'unavailable'|'failed', review?, reason? }]
// findings 는 막는 지적(blocking)만 — 에이전트에 보낸다 · advisories 는 권장(PR 댓글에만 · 결정 E)
// decisions 는 사람이 정할 것만 · autoDecisions 는 추천안으로 자동 확정할 것(구현 세부 — 수정 지시와 함께 에이전트에 간다)
// 판정 순서: 결정 필요(사람 몫이 하나라도) → 수정 필요(막는 지적 · 자동 확정 결정이 하나라도) → REVIEWERS 가 모두 답했으면 승인(권장만 남은 수정 필요도 승인으로 센다)
// → 아니면 리뷰어 부족(머지하지 않는다). 결정 필요여도 findings · autoDecisions 는 그 라운드에 에이전트에 보낸다(2026-10-26 사용자 결정 A)
const settles = (review) => !review.decisions.length && !review.findings.some(isBlocking)   // 이 리뷰어는 막는 것이 없다(권장만)
export const aggregate = (results) => {
  const answered = results.filter((result) => result.status === 'ok' && result.review)
  const approvals = answered.filter((result) => settles(result.review))
  const tagged = answered.flatMap((result) => result.review.findings.map((item) => ({ ...item, by: result.name })))
  const findings = tagged.filter(isBlocking)
  const advisories = tagged.filter((item) => !isBlocking(item))
  const allDecisions = answered.flatMap((result) => result.review.decisions.map((item) => ({ ...item, by: result.name })))
  const autoDecisions = allDecisions.filter(autoResolvable)
  const decisions = allDecisions.filter((item) => !autoResolvable(item))
  let verdict = 'insufficient'
  if (decisions.length) verdict = 'decision'
  else if (findings.length || autoDecisions.length) verdict = 'changes'
  else if (results.length === REVIEWERS.length && approvals.length === REVIEWERS.length) verdict = 'approve'
  return { verdict, approvals: approvals.length, answered: answered.length, total: results.length, findings, advisories, decisions, autoDecisions }
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

// 추천안으로 자동 확정한 결정을 계획서 Checkpoint 의 "### Decisions" 절에 — 절이 없으면(경량 계획서) Checkpoint 끝에 만든다. 같은 줄은 다시 넣지 않는다
export const autoDecisionLine = ({ decision, repo, number, sha }) => `- 추천안으로 자동 확정(자동 리뷰 · ${decision.by} · ${repo}#${number} @${String(sha).slice(0, 7)} · 구현 세부): ${oneLine(decision.title, 160)} → ${oneLine(decision.recommended, 80)}`
export const withDecisionLines = (planText, newLines) => {
  const lines = String(planText).split('\n')
  const fresh = newLines.filter((line) => !lines.includes(line))
  if (!fresh.length) return String(planText)
  const heading = lines.findIndex((row) => /^###\s+Decisions\s*$/.test(row))
  if (heading >= 0) {
    let end = heading + 1
    while (end < lines.length && !/^#{2,3}\s/.test(lines[end])) end += 1
    while (end > heading + 1 && lines[end - 1].trim() === '') end -= 1
    lines.splice(end, 0, ...fresh)
    return lines.join('\n')
  }
  const checkpoint = lines.findIndex((row) => /^##\s+Checkpoint\s*$/.test(row))
  if (checkpoint < 0) return `${String(planText).replace(/\n*$/, '')}\n\n### Decisions\n${fresh.join('\n')}\n`
  let end = checkpoint + 1
  while (end < lines.length && !/^##\s/.test(lines[end])) end += 1
  while (end > checkpoint + 1 && lines[end - 1].trim() === '') end -= 1
  lines.splice(end, 0, '', '### Decisions', ...fresh)
  return lines.join('\n')
}

// 사람이 정할 결정 대기 줄 — 결정이 나오면 요청을 열 수 있든 없든 계획서에 남긴다(PR #20 자동 리뷰 지적 — 요청이 안 열려도 머지를 막게)
//   - Auto decisions: <레포>#<번호> @<sha7> · <N>개 · 등록됨|등록 실패 · <안내> · <YYYY-MM-DD HH:MM>
//   등록됨 = 결정 콘솔(또는 같은 키의 결정 요청)에 올렸다 — 그 요청이 닫히면 해결로 보고 줄을 지운다
//   등록 실패 = 둘 다 못 했다 — 사람이 정한 뒤 이 줄을 지울 때까지 머지하지 않는다
const PENDING_LINE = /^- Auto decisions:\s*([\w.-]+)#(\d+)\s+@([0-9a-f]{6,40})\s+·\s+(\d+)개\s+·\s+(등록됨|등록 실패)(?:\s+·.*)?$/
const isPendingRow = (row, repo, number) => { const hit = row.match(PENDING_LINE); return Boolean(hit) && hit[1] === repo && hit[2] === String(number) }
export const pendingDecisionLine = (planText, repo, number) => {
  const row = String(planText ?? '').split('\n').find((line) => isPendingRow(line, repo, number))
  if (!row) return null
  const hit = row.match(PENDING_LINE)
  return { sha: hit[3], count: Number(hit[4]), registered: hit[5] === '등록됨', line: row }
}
export const pendingDecisionText = ({ repo, number, sha, count, registered, stamp }) => `- Auto decisions: ${repo}#${number} @${String(sha).slice(0, 7)} · ${count}개 · ${registered ? '등록됨 · 결정 콘솔에서 다 정하면 저절로 지워진다' : '등록 실패 · 사람이 정한 뒤 이 줄을 지운다(그때까지 머지하지 않는다)'} · ${stamp}`
// 같은 PR 줄이 있으면 그 자리, 없으면 그 PR 의 "- Auto review:" 줄 뒤(없으면 Work ref 뒤 · 그것도 없으면 끝)
export const withPendingDecisionLine = (planText, entry) => {
  const line = pendingDecisionText(entry)
  const lines = String(planText).split('\n')
  const index = lines.findIndex((row) => isPendingRow(row, entry.repo, entry.number))
  if (index >= 0) { lines[index] = line; return lines.join('\n') }
  let anchor = lines.findIndex((row) => { const hit = row.match(AUTO_LINE); return hit && hit[1] === entry.repo && hit[2] === String(entry.number) })
  if (anchor < 0) anchor = lines.findIndex((row) => /^- Work ref:/.test(row))
  if (anchor >= 0) { lines.splice(anchor + 1, 0, line); return lines.join('\n') }
  return `${String(planText).replace(/\n*$/, '')}\n${line}\n`
}
export const withoutPendingDecisionLine = (planText, repo, number) => String(planText).split('\n').filter((row) => !isPendingRow(row, repo, number)).join('\n')

// 이 HEAD 를 자동 흐름이 다시 봐야 하나 — 현황판 감지 · 대기열이 같이 쓴다
export const needsReview = (planText, repo, number, headSha) => {
  const known = autoLines(planText).get(`${repo}#${number}`)
  if (!known) return true
  if (FINAL_RESULTS.some((result) => known.result.startsWith(result))) return false
  if (known.result.startsWith(BODY_EDITED)) return true
  return !String(headSha).startsWith(known.sha)
}
// 이번 리뷰의 라운드 — 새 HEAD 이거나 본문만 고쳤으면 하나 올린다(같은 HEAD 를 다시 보는 --dry-run 은 그대로)
export const nextRound = (known, headSha) => {
  if (!known) return 1
  return !String(headSha).startsWith(known.sha) || known.result.startsWith(BODY_EDITED) ? known.round + 1 : known.round
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
  const notes = []
  if (summary.advisories?.length) notes.push(`**💡 권장 ${summary.advisories.length}개는 머지를 막지 않는다** — 에이전트에 보내지 않고 이 댓글에만 남긴다`)
  if (summary.autoDecisions?.length) {
    notes.push('**추천안으로 자동 확정(구현 세부 — 사람을 기다리지 않음)**', ...summary.autoDecisions.map((item) => `- ${oneLine(item.title, 200)} → **${oneLine(item.recommended, 80)}** (${item.by})`))
  }
  if (round >= MAX_ROUNDS && ['changes', 'decision'].includes(summary.verdict) && !takeoverEligible(summary, round)) {
    notes.push(`**이어받지 않음** — 리뷰 상한(${MAX_ROUNDS})인데 답하지 못한 리뷰어가 있다(리뷰어 부족). 고친 커밋도 리뷰 없이 머지하지 않고 멈춘다 — 사람이 이어받는다`)
  }
  if (takeoverEligible(summary, round)) {
    notes.push(`**${TAKEOVER}** — 리뷰 상한(${MAX_ROUNDS})이라 다시 리뷰하지 않는다. 남은 지적을 고친 커밋은 리뷰 없이 같은 HEAD 검증 · 충돌 확인만으로 머지 단계로 간다${summary.verdict === 'decision' ? '(사람이 정할 결정은 결정 콘솔 — 다 정할 때까지 머지하지 않는다)' : ''}`)
  }
  const head = `### 🤖 자동 리뷰 — 라운드 ${round}/${MAX_ROUNDS} · @${String(sha).slice(0, 7)}`
  const verdictText = { approve: '승인', changes: '수정 필요', decision: '결정 필요', insufficient: `리뷰어 부족(승인 ${summary.approvals}/${REVIEWERS.length} · 둘 다 승인해야 머지)` }[summary.verdict]
  const rows = results.map((result) => {
    if (result.status !== 'ok') return `- **${result.name}** — ${result.status === 'unavailable' ? '못 씀' : '실패'}(${oneLine(result.reason, 120)})`
    const label = { approve: '승인', changes: '수정 필요', decision: '결정 필요' }[result.review.verdict]
    const items = [
      ...result.review.findings.map((item) => `  - ${isBlocking(item) ? '⛔ 막음' : '💡 권장'} \`${item.file}${item.line ? `:${item.line}` : ''}\` ${oneLine(item.problem, 300)} → ${oneLine(item.fix, 300)}`),
      ...result.review.decisions.map((item) => `  - 결정: ${oneLine(item.title, 200)} — ${item.options.map((option) => option.label).join(' / ')}`),
    ]
    return [`- **${result.name}** — ${label}: ${oneLine(result.review.summary, 600)}`, ...items].join('\n')
  })
  return `${head}\n\n**결론: ${verdictText}**\n\n${rows.join('\n')}\n${notes.length ? `\n${notes.join('\n')}\n` : ''}`
}

// 상한 뒤 이어받은 HEAD 의 PR 댓글 — 리뷰 없이 검증만으로 머지 단계로 간다는 것
export const takeoverComment = ({ sha, round }) => `### 🤖 자동 리뷰 — ${TAKEOVER} · 라운드 ${round}/${MAX_ROUNDS} · @${String(sha).slice(0, 7)}\n\n**${TAKEOVER} — 리뷰 없이 검증만으로 머지.** 리뷰 상한(${MAX_ROUNDS})을 넘은 커밋이라 리뷰어를 부르지 않고 같은 HEAD 엄격 검증 · 충돌 없음 · 안 정한 결정 없음을 확인한 뒤 승인과 같은 머지 단계(머지 확인 요청 · 레포 설정이면 바로)로 간다.\n`

// 작업 에이전트 pane 에 보낼 수정 지시 한 줄 — 지적 전문은 PR 댓글에 있다
// autoDecisions — 추천안으로 자동 확정한 결정(구현 세부)도 고칠 것으로 함께 · humanDecisions — 결정 콘솔에 올린 수(따로 온다)
// takeover — 이 라운드가 이어받기를 준다(takeoverEligible) · 상한인데 주지 않으면 그 사실을 알린다
export const fixInstruction = ({ agent, org, repo, number, sha, round, findings, autoDecisions = [], humanDecisions = 0, takeover = false, plan, worktree, athenaDir }) => {
  const list = findings.slice(0, 6).map((item, index) => `${index + 1}) ${item.file}${item.line ? `:${item.line}` : ''} ${oneLine(item.problem, 160)} → ${oneLine(item.fix, 160)}`).join(' ')
  const fixes = findings.length ? ` 수정 필요: ${list}${findings.length > 6 ? ` 외 ${findings.length - 6}개` : ''}.` : ''
  const decided = autoDecisions.length ? ` 추천안으로 자동 확정한 결정(구현 세부 — 그대로 반영): ${autoDecisions.slice(0, 5).map((item, index) => `D${index + 1}) ${oneLine(item.title, 120)} → ${oneLine(item.recommended, 80)}`).join(' ')}.` : ''
  const pending = humanDecisions ? ` 사람이 정할 결정 ${humanDecisions}개는 결정 콘솔(${plan})에 올렸다 — 위 수정은 기다리지 말고 지금 하고, 결정은 확정 지시가 따로 오면 반영한다.` : ''
  let limit = ''
  if (takeover) limit = ` 리뷰 상한(${MAX_ROUNDS}) — 이번에 올린 커밋은 다시 리뷰하지 않고 같은 HEAD 검증 · 충돌 확인만으로 머지 단계로 간다(${TAKEOVER}). 검증 스크립트를 통과하게 고친다.`
  else if (round >= MAX_ROUNDS) limit = ` 리뷰 상한(${MAX_ROUNDS}) · 답하지 못한 리뷰어가 있어 이어받지 않는다 — 고친 커밋은 자동으로 머지되지 않고 사람이 이어받는다.`
  return oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} 라운드 ${round}/${MAX_ROUNDS} —${fixes}${decided}${pending}${limit} 전문: gh pr view ${number} --repo ${org}/${repo} --comments. 자동 흐름 예외(이 지시에만): 고친 뒤 묻지 않고 ${athenaDir}/scripts/commit.sh --plan ${athenaDir}/${plan} --dir ${worktree} -m '<메시지>' -- <파일>… 로 커밋하고 ${athenaDir}/scripts/ship.sh --plan ${athenaDir}/${plan} --dir ${worktree} --auto-push 로 올린다(새 커밋을 자동 리뷰가 다시 본다). PR 본문 지적이면 본문 파일을 고쳐 --auto-push --body-file <파일> 로(커밋이 없어도 된다). 고칠 방법이 하나가 아니면 고르지 말고 멈춰 아테나에 알린다. 계획서 Progress 에 한 줄`, 3500)
}

export const decisionNotice = ({ agent, repo, number, sha, count, plan, worktree, athenaDir }) => oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} — 결정 필요 ${count}개를 결정 콘솔(${plan})에 올렸다. 사람이 확정하면 그 지시가 이 pane 으로 온다 — 반영한 뒤 묻지 않고 ${athenaDir}/scripts/commit.sh … 로 커밋하고 ${athenaDir}/scripts/ship.sh --plan ${athenaDir}/${plan} --dir ${worktree} --auto-push 로 올린다(자동 흐름 예외)`, 2000)

// 머지 확인 답을 처리한 결과(머지됨 · 보류 · 다시 확인 실패 · 머지 실패) — 작업 에이전트 pane 에 알림 한 줄(할 일은 주지 않는다)
export const mergeNotice = ({ agent, repo, number, sha, result }) => oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} — ${result}. 알림만 — 이 글로 할 일은 없다(계획서 "- Auto review:" 줄)`, 600)

// 리뷰 뒤 결정 → plan-html.mjs --add 의 decisions[] — 추천 label 이 선택지에 있을 때만 recommended
export const decisionsForConsole = (decisions) => decisions.map((item, index) => ({
  id: `r${index + 1}`,
  title: `R${index + 1} ${oneLine(item.title, 120)}`,
  desc: `${oneLine(item.why, 300)} (자동 리뷰 · ${item.by})`,
  type: 'single',
  required: true,
  options: item.options.map((option) => ({ label: oneLine(option.label, 80), desc: oneLine(option.desc, 300), ...(option.label === item.recommended ? { recommended: true } : {}) })),
}))
