// PR 자동 리뷰 · 수정 · 머지(scripts/pr-auto.mjs)의 순수 로직 — 현황판(감지)과 자동 흐름이 같이 쓴다. 파일 · 네트워크를 건드리지 않는다
//
//   계획서 표시 줄(PR 마다 한 줄 · 바꿔 쓴다)
//     - Auto review: <레포>#<번호> @<sha7> · <결과> · 라운드 <k>/<상한> · <YYYY-MM-DD HH:MM>
//   결과: 승인 → 머지 확인 대기 · 승인 → 바로 머지(확인 없음) · 수정 필요 · 결정 필요 · 리뷰어 부족 · 잘린 diff 승인 · 검증 대기 · 멈춤 · 보류 · 머지됨 · 본문 고침
//         · 상한 뒤 이어받음 → 머지 확인 대기 / 바로 머지(확인 없음) — 라운드가 상한을 넘은 HEAD(리뷰 없이 같은 HEAD 검증 · 충돌 확인만)
//   같은 PR · 같은 HEAD(sha7) 가 이미 적혀 있으면 다시 돌지 않는다 — 본문 고침(ship.sh --auto-push --body-file 이 커밋 없이 본문만 바꿈)만 같은 HEAD 를 다시 본다

// 자동 머지 합의 — 결정 D2 "Claude·Codex 둘 다 승인"(+ 같은 HEAD 검증 통과). 하나라도 실패 · 로그인 안 됨 · 반려면 머지하지 않는다(남은 하나로 판정하지 않는다)
export const REVIEWERS = ['claude', 'codex']
// 리뷰 상한 — 같은 PR 에서 자동 리뷰는 이만큼만 돈다. 상한 라운드에도 승인이 아니면 멈추지 않고 이어받는다(2026-10-26 사용자 결정 C):
// 남은 수정 지적을 에이전트에 보내고, 고친 새 HEAD(라운드 > 상한)는 리뷰 없이 같은 HEAD 검증 · 충돌 확인만으로 승인과 같은 머지 단계로 간다
export const MAX_ROUNDS = 3
export const TAKEOVER = '상한 뒤 이어받음'
export const REVIEW_OFF = '리뷰 끔'
export const isTakeoverRound = (round, max = MAX_ROUNDS) => round > max
// 상한 라운드가 이어받기를 허락했나 — 그 라운드가 쓴 줄('수정 필요 — 상한 뒤 이어받음…' · '결정 필요 — 상한 뒤 이어받음…')로 시작할 때만.
// 이어받은 HEAD 가 머지 단계로 간 뒤의 줄('상한 뒤 이어받음(…) → 머지 확인 대기' 등)은 아니다 — 그 뒤 온 커밋은 멈춘다(PR #20 자동 리뷰 지적)
export const grantsTakeover = (result) => [`수정 필요 — ${TAKEOVER}`, `결정 필요 — ${TAKEOVER}`].some((head) => String(result ?? '').startsWith(head))
// 이 리뷰 라운드가 다음 커밋에 이어받기를 줄 수 있나 — 상한 라운드 · 승인 아님 · 리뷰어가 모두 답했을 때만(하나라도 실패한 라운드는 그 리뷰어가 본 적이 없으니 주지 않는다)
// 빠른 길(아래)은 상한 1 · 리뷰어 1 — max · reviewers 로 그 값을 받는다
export const takeoverEligible = (summary, round, { max = MAX_ROUNDS, reviewers = REVIEWERS.length } = {}) => round >= max && ['changes', 'decision'].includes(summary.verdict)
  && summary.total === reviewers && summary.answered === reviewers
// 끝난 결과 — 이 PR 은 사람이 이어받았다. 새 커밋이 와도 자동 리뷰를 다시 돌지 않는다(계획서에서 그 줄을 지우면 다시 돈다).
// 멈춤은 옛 상한 동작(2026-10-26 전)의 줄 — 지금 흐름은 라운드 상한으로 멈추지 않는다
export const FINAL_RESULTS = ['멈춤', '머지됨']
// 커밋 없이 PR 본문만 고쳤다(ship.sh --auto-push --body-file) — 같은 HEAD 지만 다시 리뷰하고 라운드를 하나 쓴다
export const BODY_EDITED = '본문 고침'

// ── 빠른 길(2026-10-31 계획서 "아테나 작업 속도 높이기" D1 · D2) ─────────────────────────
// 작은 PR 은 리뷰어 한 명(REVIEWERS[0] = claude) · 1라운드. 승인이면 같은 HEAD 검증 → 머지, 수정 필요면 지적을 보내고
// 고친 새 HEAD(라운드 2/1)는 리뷰 없이 검증 · 충돌 확인만으로 머지 단계(상한 뒤 이어받음과 같은 길 · auto.takeover).
// 판정은 ship.sh 가 PR 올리기 직전에 한 번(fastPathVerdict) 하고 계획서 Checkpoint "- Fast path: yes|no (<이유>)" 줄로 남긴다 — pr-auto 는 그 줄만 읽는다(planFastPath).
// 레포가 리뷰 끔(autoReview: false)이면 빠른 길과 상관없이 리뷰 없이(지금처럼)
export const FAST_PATH = '⚡ 빠른 길'
export const FAST_MAX_ROUNDS = 1
export const FAST_PATH_MAX_FILES = 10   // 작은 일 = 기준 브랜치 대비 바뀐 파일 수 상한 — 상수 하나 · 옵션화하지 않는다
// 설정 파일 — 하나라도 바뀌면 빠른 길 아님. scripts/verify/_lib.sh VERIFY_SCOPE_CONFIG_RE("전체로 가는" 목록)와 같아야 한다(test/pr-auto-test.sh 가 원문 비교)
export const FAST_PATH_CONFIG_RE = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|tsconfig[^/]*\.json|jsconfig[^/]*\.json|\.nvmrc|vite\.config\.[a-z]+|pyproject\.toml|pyrightconfig\.json|requirements[^/]*\.txt|\.github\/.+)$|(^|\/)scripts\/verify\//
// 계획서 1절에 이 말이 있으면 빠른 길 아님(보안 · 외부 계약 · 데이터에 닿는 일은 리뷰어 둘) — 1절(## 1. …)부터 다음 ## 까지만 본다
export const FAST_PATH_FLAGS = ['보안', '외부 계약', '데이터']
export const planFastPathFlags = (planText) => {
  const section = String(planText ?? '').match(/^## 1\.[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? ''
  return FAST_PATH_FLAGS.filter((word) => section.includes(word))
}
// 팩 레포 "fastPath": false — 이 레포는 늘 리뷰어 둘(없으면 true)
export const repoFastPath = (config, repoName) => (config?.repos ?? []).find((repo) => repo.name === repoName)?.fastPath !== false
// 판정 — { fast, why }. why 는 계획서 줄 괄호 안에 그대로 들어간다(짧게)
export const fastPathVerdict = ({ repoFast = true, files = [], flagged = [] }) => {
  if (!repoFast) return { fast: false, why: '레포 fastPath: false' }
  const configFiles = files.filter((path) => FAST_PATH_CONFIG_RE.test(path))
  if (configFiles.length) return { fast: false, why: `설정 파일 ${configFiles.slice(0, 3).join(' · ')}${configFiles.length > 3 ? ` 외 ${configFiles.length - 3}개` : ''}` }
  if (files.length > FAST_PATH_MAX_FILES) return { fast: false, why: `파일 ${files.length}개 > ${FAST_PATH_MAX_FILES}` }
  if (flagged.length) return { fast: false, why: `1절에 ${flagged.join(' · ')}` }
  return { fast: true, why: `파일 ${files.length}개` }
}
//   - Fast path: yes|no (<이유>)
//   읽기 · 쓰기 모두 "## Checkpoint" 절 안에서만 — 본문 예시 · 옛 기록에 같은 모양의 줄이 있어도 판정으로 읽지 않는다(PR #200 자동 리뷰 지적). Checkpoint 절이 없는 계획서는 빠른 길이 아니다
const FAST_LINE = /^- Fast path:\s*(yes|no)\b(?:\s*\((.*)\))?\s*$/
// "## Checkpoint" 절의 줄 범위 [start, end) — 절이 없으면 null
const checkpointRange = (lines) => {
  const start = lines.findIndex((row) => /^##\s+Checkpoint\s*$/.test(row))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^##\s/.test(lines[end])) end += 1
  return { start, end }
}
const checkpointIndex = (lines, matches) => {
  const range = checkpointRange(lines)
  if (!range) return -1
  for (let index = range.start + 1; index < range.end; index += 1) if (matches(lines[index])) return index
  return -1
}
export const planFastPath = (planText) => {
  const lines = String(planText ?? '').split('\n')
  const index = checkpointIndex(lines, (row) => FAST_LINE.test(row))
  return index >= 0 && lines[index].match(FAST_LINE)?.[1] === 'yes'
}
export const fastPathLineText = ({ fast, why = '' }) => `- Fast path: ${fast ? 'yes' : 'no'}${why ? ` (${oneLine(why, 200)})` : ''}`
// Checkpoint 절에 같은 줄이 있으면 바꾸고(PR 을 다시 올리면 다시 판정) 없으면 Checkpoint 의 Work ref 뒤에 · Checkpoint 가 없으면 Work ref 뒤 · 그것도 없으면 끝에(그 줄은 planFastPath 가 읽지 않는다)
export const withFastPathLine = (planText, entry) => {
  const line = fastPathLineText(entry)
  const lines = String(planText).split('\n')
  const index = checkpointIndex(lines, (row) => FAST_LINE.test(row))
  if (index >= 0) { lines[index] = line; return lines.join('\n') }
  const inCheckpoint = checkpointIndex(lines, (row) => /^- Work ref:/.test(row))
  const anchor = inCheckpoint >= 0 ? inCheckpoint : lines.findIndex((row) => /^- Work ref:/.test(row))
  if (anchor >= 0) { lines.splice(anchor + 1, 0, line); return lines.join('\n') }
  return `${String(planText).replace(/\n*$/, '')}\n${line}\n`
}

// ── 리뷰어 구성 — 두 번째 자리(2026-10-26 사용자 결정 · Codex 없는 사람) ──────────────
// 첫 자리는 늘 Claude. 두 번째 자리는 Codex 를 쓸 수 있으면 Codex(지금과 똑같이 — 첫 자리는 models.prReview, 없으면 기본 모델),
// **처음부터** 못 쓰면(명령 없음 · 로그인 안 됨 — 돌리기 전 확인) Claude 두 번 모드 — 두 번째 자리를 다른 모델 Claude 가 따로 한 번 더 리뷰한다.
// Claude 두 번 모드의 모델: 팩 models 에 적힌 값이 먼저, 없으면 첫 자리 opus · 두 번째 자리 sonnet(사용자 결정 b).
// 두 자리가 같은 모델이 되면 대신하지 않는다(→ 리뷰어 부족 · 같은 모델 두 번은 합의가 아니다).
// Codex 가 돌다가 실패한 것은 여기서 바꾸지 않는다(그 자리는 실패 → 리뷰어 부족 · 조용히 Claude 로 바꾸지 않는다)
export const SECOND_MODEL_ROLE = 'prReviewSecond'
export const CLAUDE_PAIR_DEFAULTS = { first: 'opus', second: 'sonnet' }
// codex: 'ready' | 'missing'(명령 없음) | 'logged-out'(로그인 안 됨) · firstModel · secondModel: 팩 models 값('' = 안 적음)
// 결과: { first: { name, kind, model? }, second: { name, kind, model?, unavailable?, replaces? } } — name 은 댓글 · 사건 기록 · 판정에 쓰는 이름
export const reviewerSlots = ({ codex, firstModel = '', secondModel = '' }) => {
  if (codex === 'ready') return { first: { name: 'claude', kind: 'claude', model: firstModel }, second: { name: 'codex', kind: 'codex' } }
  const why = codex === 'missing' ? 'Codex 설치 안 됨' : 'Codex 로그인 안 됨'
  const firstUsed = firstModel || CLAUDE_PAIR_DEFAULTS.first
  const secondUsed = secondModel || CLAUDE_PAIR_DEFAULTS.second
  const first = { name: 'claude', kind: 'claude', model: firstUsed }
  if (firstUsed === secondUsed) return { first, second: { name: 'codex', kind: 'codex', unavailable: `${why} · 대신할 Claude 모델(models.${SECOND_MODEL_ROLE} · ${secondUsed})이 첫 자리와 같은 모델` } }
  return { first, second: { name: `claude-${secondUsed}`, kind: 'claude', model: secondUsed, replaces: why } }
}
// 어떤 구성으로 돌았나 — PR 댓글 · 계획서 "- Auto review:" 줄에 남긴다
export const lineupNote = ({ first, second }) => {
  const head = `리뷰어 claude${first.model ? `(${first.model})` : ''}`
  if (second.kind === 'claude') return `${head} + claude(${second.model}) — ${second.replaces}`
  return `${head} + codex${second.unavailable ? `(못 씀: ${second.unavailable})` : second.model ? `(${second.model})` : ''}`
}

// Codex 사용자 설정(config.toml)에서 맨 위(첫 [표] 앞) model · model_reasoning_effort 두 값만 읽는다 — MCP · 훅 같은 다른 키는 읽지 않는다
// (리뷰는 --ignore-user-config 로 도니 모델만 따로 넘긴다 · docs/pr-auto.md). 이상한 값은 넘기지 않는다
const CODEX_SETTING_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/
export const codexUserSettings = (tomlText) => {
  const settings = { model: '', effort: '' }
  let open = ''   // 여러 줄 문자열 안이면 닫는 글자(""" 또는 ''') — 그 안의 줄은 키도 [표]도 아니다
  for (const raw of String(tomlText ?? '').split('\n')) {
    if (open) {
      if (raw.includes(open)) open = ''
      continue
    }
    const line = raw.trim()
    if (line.startsWith('#')) continue   // 주석 줄 — 안의 """ 는 문자열 시작이 아니다
    if (line.startsWith('[')) break
    const match = line.match(/^(model|model_reasoning_effort)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/)
    if (match) {
      const value = match[2] ?? match[3]
      if (CODEX_SETTING_VALUE.test(value)) settings[match[1] === 'model' ? 'model' : 'effort'] = value
      continue
    }
    const value = line.replace(/^[^=]*=\s*/, '')
    const delimiter = ['"""', "'''"].find((quote) => line.includes('=') && value.startsWith(quote))
    if (delimiter && !value.slice(3).includes(delimiter)) open = delimiter
  }
  return settings
}
// codex exec 에 붙일 인자 — 값이 없으면 넘기지 않는다(Codex 기본값)
export const codexModelArgs = ({ model, effort }) => [
  ...(model ? ['-m', model] : []),
  ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
]

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
// reviewers — 승인에 필요한 리뷰어 수(기본 REVIEWERS 모두 · 빠른 길은 1)
export const aggregate = (results, reviewers = REVIEWERS.length) => {
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
  else if (results.length === reviewers && approvals.length === reviewers) verdict = 'approve'
  return { verdict, approvals: approvals.length, answered: answered.length, total: results.length, findings, advisories, decisions, autoDecisions }
}

// 리뷰어마다 짧은 상태 — 사건 기록 · 댓글 · 계획서에. 앞 리뷰 승인을 이어받은 리뷰어는 inherited
export const reviewerBrief = (results) => results.map((result) => `${result.name}:${result.inherited ? 'inherited' : result.status === 'ok' ? result.review.verdict : result.status}`).join(',')

// ── 앞 리뷰 승인 이어받기(2026-10-26 사용자 결정) ────────────────────────
// PR 전에 reviewer pane 이 남긴 계획서 "- Review result:" 줄이 같은 내용으로 승인이면 Claude 리뷰어는 다시 돌리지 않고 그 승인을 Claude 몫으로 쓴다(Codex 는 그대로).
// 같은 내용 판정은 ship.sh "리뷰" 와 같다 — 줄에 tree(리뷰한 워크트리 전체 · 커밋 전 변경 포함)가 있으면 PR HEAD 의 tree 가 그것으로 시작할 때,
// tree 가 없는 옛 줄이면 PR HEAD 커밋이 그 sha 로 시작할 때. 줄 고르기도 ship.sh 와 같다 — 이 레포 · 브랜치 줄 → 레포 표시 없는 이 브랜치 줄 → 표시 없는 옛 줄, 그중 마지막
export const INHERITED_BY = 'claude'
export const priorApproval = (planText, { repo, branch, sha, tree }) => {
  const lines = String(planText ?? '').split('\n').filter((line) => /^- Review result:/.test(line))
  const mine = [
    lines.filter((line) => `${line} `.includes(`📦 ${repo} · 🌿 ${branch} `)),
    lines.filter((line) => !line.includes('📦') && `${line} `.includes(`🌿 ${branch} `)),
    lines.filter((line) => !line.includes('📦') && !line.includes('🌿')),
  ].find((group) => group.length) ?? []
  const last = mine.at(-1)
  const hit = last?.match(/^- Review result:\s*(.+?)\s*@\s*([0-9a-f]{6,40})/)
  if (!hit || !hit[1].startsWith('승인')) return null
  const reviewedTree = last.match(/· tree ([0-9a-f]{6,40})/)?.[1] ?? ''
  const same = reviewedTree ? Boolean(tree) && String(tree).startsWith(reviewedTree) : String(sha).startsWith(hit[2])
  return same ? { sha: hit[2], tree: reviewedTree } : null
}
// 이어받은 리뷰어 결과 — 승인 · 지적 없음. 판정(aggregate)에는 그 리뷰어가 승인한 것으로 들어간다
export const inheritedResult = (prior, headSha) => ({
  name: INHERITED_BY,
  status: 'ok',
  inherited: true,
  review: { verdict: 'approve', summary: inheritedNote(headSha, prior), findings: [], decisions: [] },
})
export const inheritedNote = (headSha, prior) => `Claude: 앞 리뷰 승인 이어받음 @${String(headSha).slice(0, 7)}${prior?.tree ? ` (reviewer 승인 · tree ${prior.tree.slice(0, 12)})` : ` (reviewer 승인 @${String(prior?.sha ?? '').slice(0, 7)})`}`

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
// note(앞 리뷰 승인 이어받음 등)는 결과 뒤에 붙인다 — 결과는 앞부분(startsWith)으로만 읽으니 판정이 바뀌지 않는다
export const autoLineText = ({ repo, number, sha, result, note = '', round, max = MAX_ROUNDS, stamp }) => `- Auto review: ${repo}#${number} @${String(sha).slice(0, 7)} · ${result}${note ? ` · ${note}` : ''} · 라운드 ${round}/${max} · ${stamp}`
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
// ── 대상 계획서 Status — ship.sh(push 직후) · 현황판(안전망)이 같이 쓴다 ─────────────
// 진행 중 · 리뷰면 그대로 대상. 완료(done) · 계획(planned)이면 이어 올린 PR 이다 — Status 를 ready_for_review 로 되돌린 뒤 대상으로
// (2026-10-26 PR #28 재현 — #27 머지로 done 이 된 계획서에서 추가 요청의 새 PR 이 대기열에 안 들어갔다. 에이전트가 요청마다 in_progress 로 되돌리기를 놓쳐도 막히지 않게).
// 되돌리면 현황판 카드 · 머지 뒤 자동 done 이 그대로 돈다. 막힘(blocked)은 사람이 풀 때까지 대상 아님 — 풀면(in_progress · ready_for_review) 현황판이 잡는다
export const AUTO_REVIEW_STATUSES = ['in_progress', 'ready_for_review']
export const REOPEN_STATUSES = ['done', 'planned']
export const REOPEN_STATUS = 'ready_for_review'
const STATUS_WORD = /planned|in_progress|blocked|ready_for_review|done/
// 계획서 Checkpoint 의 Status 값(현황판 readPlan 과 같은 읽기 — ** · ` 는 걷고 첫 상태 낱말)
export const planStatusOf = (planText) => {
  const raw = String(planText ?? '').match(/^-\s*Status:\s*(.+)$/m)?.[1] ?? ''
  return raw.replace(/[*`]/g, '').match(STATUS_WORD)?.[0] ?? ''
}
// 'review'(그대로 대상) · 'reopen'(ready_for_review 로 되돌린 뒤 대상) · 'skip'
export const autoReviewAction = (status) => {
  if (AUTO_REVIEW_STATUSES.includes(status)) return 'review'
  if (REOPEN_STATUSES.includes(status)) return 'reopen'
  return 'skip'
}
export const reopenNote = (repo, number) => `이어 올린 PR ${repo}#${number} 자동 리뷰 대기(완료에서 되돌림)`
// Status 줄을 ready_for_review 로(설명은 note 로 바꿈) · Updated 줄이 있으면 시각 · 누가
export const reopenedPlan = (planText, { note, stamp, by }) => {
  const text = String(planText)
  if (!/^- Status:.*$/m.test(text)) return text
  const next = text.replace(/^- Status:.*$/m, `- Status: ${REOPEN_STATUS} — ${note}`)
  return next.replace(/^- Updated:.*$/m, `- Updated: ${stamp} / ${by}`)
}

// 계획서 잠금 안에서 부른다 — 지금 내용(최신 Status)으로 다시 판정하고, 되돌릴 때만 바꾼 글을 준다.
// 현황판이 PR 을 조회하는 사이 사람이 blocked 로 옮겼으면 skip(상태도 대기열도 건드리지 않는다 · PR #29 자동 리뷰 지적).
// 되돌리기는 레포 하나짜리 계획서만 — 여러 레포 작업은 사람이 올린다
// → { action: 'review' | 'reopened' | 'skip', text }
export const claimAutoReview = (planText, { config, repoName, number, stamp, by }) => {
  const text = String(planText)
  const action = autoReviewAction(planStatusOf(text))
  if (action === 'review') return { action, text }
  if (action === 'skip' || !singleRepoPlan(text, config, repoName)) return { action: 'skip', text }
  return { action: 'reopened', text: reopenedPlan(text, { note: reopenNote(repoName, number), stamp, by }) }
}

// base 합치기 merge 커밋(충돌 풀기 · commit.sh --merge-base)은 라운드 상한에 세지 않는다 — 지난 라운드 번호 그대로 한 번 리뷰하고 줄 메모에 표시(2026-10-26 아테나 · 사용자 방침)
export const BASE_MERGED = 'base 합침'
export const baseMergeRound = (known, round, baseMerge) => (baseMerge && known ? known.round : round)
// 이번 리뷰의 라운드 — 새 HEAD 이거나 본문만 고쳤으면 하나 올린다(같은 HEAD 를 다시 보는 --dry-run 은 그대로)
export const nextRound = (known, headSha) => {
  if (!known) return 1
  return !String(headSha).startsWith(known.sha) || known.result.startsWith(BODY_EDITED) ? known.round + 1 : known.round
}

// ── 팩 설정 ────────────────────────────────────────────────────────────
// 레포별 설정 세 가지(docs/pr-auto.md "켜기") — PR(켬/끔) · 리뷰(켬/끔) · 머지(auto/confirm/manual). 키가 없으면 옛 뜻 그대로:
//   "autoMerge": true          끝나면 PR 켬 · 없으면 PR · 리뷰 · 머지 모두 꺼짐("PR 올려줘" 는 그대로 된다 · 자동 리뷰만 없다)
//   "autoReview": false        리뷰 끔 · 없으면 켬
//   "autoMergeConfirm": false  확인 없이 머지 · 없으면 확인 후
//   "autoMergeManual": true    사람이 직접 머지 · autoMergeConfirm 보다 먼저(둘 다 있어도 머지하지 않는 쪽으로)
//   "autoPr": false            PR 끔 — "autoMerge": true 와 같이 있을 때만 뜻이 있다. PR · 리뷰 없이 작업 브랜치를 prBase 에 바로 머지(머지 설정은 그대로)
export const mergeModeOf = (repo) => {
  if (repo?.autoMergeManual === true) return 'manual'
  return repo?.autoMergeConfirm === false ? 'auto' : 'confirm'
}
// PR 끔 = "autoMerge": true 에 "autoPr": false 를 더한 것 — PR 도 리뷰도 없이 작업 브랜치를 prBase 에 바로 squash 머지한다(direct: true).
// "autoMerge" 키가 없으면 autoPr 와 상관없이 자동 흐름 없음(키 없는 pack.json 이 업데이트로 갑자기 머지하지 않게)
//   "fastPath": false          빠른 길 끔 — 작은 PR 도 늘 리뷰어 둘 · 상한 3(없으면 켬 · PR 켬 + 리뷰 켬일 때만 뜻이 있다)
export const prFlow = (repo) => {
  if (repo?.autoMerge !== true || repo?.direct) return { pr: false, review: false, merge: 'manual', direct: false, fast: false }
  if (repo.autoPr === false) return { pr: false, review: false, merge: mergeModeOf(repo), direct: true, fast: false }
  return { pr: true, review: repo.autoReview !== false, merge: mergeModeOf(repo), direct: false, fast: repo.fastPath !== false }
}
export const repoFlow = (config, repoName) => prFlow((config?.repos ?? []).find((repo) => repo.name === repoName))
// PR 끔 + 바로 머지 레포 — 대상은 prBase 로 바로 머지(directMerge · pr-auto.mjs --direct-merge)
export const directMergeRepos = (config) => new Set((config?.repos ?? []).filter((repo) => prFlow(repo).direct).map((repo) => repo.name))
// 자동 흐름(pr-auto)이 할 일이 있는 레포 — PR 을 켰고 리뷰나 머지 중 하나라도 자동. 리뷰 끔 + 사람이 직접은 draft PR 까지라 뺀다
export const autoMergeRepos = (config) => new Set((config?.repos ?? []).filter((repo) => {
  const flow = prFlow(repo)
  return flow.pr && (flow.review || flow.merge !== 'manual')
}).map((repo) => repo.name))
// 머지 직전 사람 확인(결정 D3)을 건너뛰는 레포 — 머지가 자동일 때만
export const skipsMergeConfirm = (config, repoName) => autoMergeRepos(config).has(repoName) && repoFlow(config, repoName).merge === 'auto'

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
// PR 댓글 본문 — 리뷰어마다 결론 · 요약 · 지적 · 리뷰어 구성(lineup — lineupNote)
// partial — diff 를 다 넣지 못해 못 본 코드 파일 수(0 이면 다 봤다 · packDiff)
// max · reviewers — 라운드 상한 · 승인에 필요한 리뷰어 수(빠른 길은 1 · 1 — fast 면 머리에 표시)
export const reviewComment = ({ sha, round, results, summary, lineup = '', partial = 0, max = MAX_ROUNDS, reviewers = REVIEWERS.length, fast = false }) => {
  const notes = []
  if (partial) notes.push(`**⚠️ diff 가 길어 코드 파일 ${partial}개를 다 넣지 못했다** — 리뷰어가 일부만 봤다.${summary.verdict === 'approve' ? ' 이 승인은 머지 승인으로 세지 않고 사람 확인으로 넘긴다' : ''}`)
  if (summary.advisories?.length) notes.push(`**💡 권장 ${summary.advisories.length}개는 머지를 막지 않는다** — 에이전트에 보내지 않고 이 댓글에만 남긴다`)
  if (summary.autoDecisions?.length) {
    notes.push('**추천안으로 자동 확정(구현 세부 — 사람을 기다리지 않음)**', ...summary.autoDecisions.map((item) => `- ${oneLine(item.title, 200)} → **${oneLine(item.recommended, 80)}** (${item.by})`))
  }
  const limits = { max, reviewers }
  if (round >= max && ['changes', 'decision'].includes(summary.verdict) && !takeoverEligible(summary, round, limits)) {
    notes.push(`**이어받지 않음** — 리뷰 상한(${max})인데 답하지 못한 리뷰어가 있다(리뷰어 부족). 고친 커밋도 리뷰 없이 머지하지 않고 멈춘다 — 사람이 이어받는다`)
  }
  if (takeoverEligible(summary, round, limits)) {
    notes.push(`**${TAKEOVER}** — 리뷰 상한(${max})이라 다시 리뷰하지 않는다. 남은 지적을 고친 커밋은 리뷰 없이 같은 HEAD 검증 · 충돌 확인만으로 머지 단계로 간다${summary.verdict === 'decision' ? '(사람이 정할 결정은 결정 콘솔 — 다 정할 때까지 머지하지 않는다)' : ''}`)
  }
  const head = `### 🤖 자동 리뷰 — ${fast ? `${FAST_PATH} · ` : ''}라운드 ${round}/${max} · @${String(sha).slice(0, 7)}`
  const verdictText = { approve: '승인', changes: '수정 필요', decision: '결정 필요', insufficient: `리뷰어 부족(승인 ${summary.approvals}/${reviewers} · ${reviewers === 1 ? '리뷰어가 답해야' : '둘 다 승인해야'} 머지)` }[summary.verdict]
  const rows = results.map((result) => {
    if (result.status !== 'ok') return `- **${result.name}** — ${result.status === 'unavailable' ? '못 씀' : '실패'}(${oneLine(result.reason, 120)})`
    if (result.inherited) return `- **${result.name}** — 승인 · ${oneLine(result.review.summary, 300)} — 다시 돌리지 않음`
    const label = { approve: '승인', changes: '수정 필요', decision: '결정 필요' }[result.review.verdict]
    const items = [
      ...result.review.findings.map((item) => `  - ${isBlocking(item) ? '⛔ 막음' : '💡 권장'} \`${item.file}${item.line ? `:${item.line}` : ''}\` ${oneLine(item.problem, 300)} → ${oneLine(item.fix, 300)}`),
      ...result.review.decisions.map((item) => `  - 결정: ${oneLine(item.title, 200)} — ${item.options.map((option) => option.label).join(' / ')}`),
    ]
    return [`- **${result.name}** — ${label}: ${oneLine(result.review.summary, 600)}`, ...items].join('\n')
  })
  return `${head}\n\n**결론: ${verdictText}**${lineup ? `\n\n_${lineup}_` : ''}\n\n${rows.join('\n')}\n${notes.length ? `\n${notes.join('\n')}\n` : ''}`
}

// 상한 뒤 이어받은 HEAD 의 PR 댓글 — 리뷰 없이 검증만으로 머지 단계로 간다는 것
export const takeoverComment = ({ sha, round, max = MAX_ROUNDS, fast = false }) => `### 🤖 자동 리뷰 — ${fast ? `${FAST_PATH} · ` : ''}${TAKEOVER} · 라운드 ${round}/${max} · @${String(sha).slice(0, 7)}\n\n**${TAKEOVER} — 리뷰 없이 검증만으로 머지.** 리뷰 상한(${max})을 넘은 커밋이라 리뷰어를 부르지 않고 같은 HEAD 엄격 검증 · 충돌 없음 · 안 정한 결정 없음을 확인한 뒤 승인과 같은 머지 단계(머지 확인 요청 · 레포 설정이면 바로)로 간다.\n`

// 작업 에이전트 pane 에 보낼 수정 지시 한 줄 — 지적 전문은 PR 댓글에 있다
// autoDecisions — 추천안으로 자동 확정한 결정(구현 세부)도 고칠 것으로 함께 · humanDecisions — 결정 콘솔에 올린 수(따로 온다)
// takeover — 이 라운드가 이어받기를 준다(takeoverEligible) · 상한인데 주지 않으면 그 사실을 알린다
export const fixInstruction = ({ agent, org, repo, number, sha, round, findings, autoDecisions = [], humanDecisions = 0, takeover = false, plan, worktree, athenaDir, max = MAX_ROUNDS }) => {
  const list = findings.slice(0, 6).map((item, index) => `${index + 1}) ${item.file}${item.line ? `:${item.line}` : ''} ${oneLine(item.problem, 160)} → ${oneLine(item.fix, 160)}`).join(' ')
  const fixes = findings.length ? ` 수정 필요: ${list}${findings.length > 6 ? ` 외 ${findings.length - 6}개` : ''}.` : ''
  const decided = autoDecisions.length ? ` 추천안으로 자동 확정한 결정(구현 세부 — 그대로 반영): ${autoDecisions.slice(0, 5).map((item, index) => `D${index + 1}) ${oneLine(item.title, 120)} → ${oneLine(item.recommended, 80)}`).join(' ')}.` : ''
  const pending = humanDecisions ? ` 사람이 정할 결정 ${humanDecisions}개는 결정 콘솔(${plan})에 올렸다 — 위 수정은 기다리지 말고 지금 하고, 결정은 확정 지시가 따로 오면 반영한다.` : ''
  let limit = ''
  if (takeover) limit = ` 리뷰 상한(${max}) — 이번에 올린 커밋은 다시 리뷰하지 않고 같은 HEAD 검증 · 충돌 확인만으로 머지 단계로 간다(${TAKEOVER}). 검증 스크립트를 통과하게 고친다.`
  else if (round >= max) limit = ` 리뷰 상한(${max}) · 답하지 못한 리뷰어가 있어 이어받지 않는다 — 고친 커밋은 자동으로 머지되지 않고 사람이 이어받는다.`
  return oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} 라운드 ${round}/${max} —${fixes}${decided}${pending}${limit} 전문: gh pr view ${number} --repo ${org}/${repo} --comments. 자동 흐름 예외(이 지시에만): 고친 뒤 묻지 않고 ${athenaDir}/scripts/commit.sh --plan ${athenaDir}/${plan} --dir ${worktree} -m '<메시지>' -- <파일>… 로 커밋하고 ${athenaDir}/scripts/ship.sh --plan ${athenaDir}/${plan} --dir ${worktree} --auto-push 로 올린다(새 커밋을 자동 리뷰가 다시 본다). PR 본문 지적이면 본문 파일을 고쳐 --auto-push --body-file <파일> 로(커밋이 없어도 된다). 고칠 방법이 하나가 아니면 고르지 말고 멈춰 아테나에 알린다. 계획서 Progress 에 한 줄`, 3500)
}

export const decisionNotice = ({ agent, repo, number, sha, count, plan, worktree, athenaDir }) => oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} — 결정 필요 ${count}개를 결정 콘솔(${plan})에 올렸다. 사람이 확정하면 그 지시가 이 pane 으로 온다 — 반영한 뒤 묻지 않고 ${athenaDir}/scripts/commit.sh … 로 커밋하고 ${athenaDir}/scripts/ship.sh --plan ${athenaDir}/${plan} --dir ${worktree} --auto-push 로 올린다(자동 흐름 예외)`, 2000)

// base 와 충돌해 머지하지 못했다 — 작업 에이전트에 "base 를 합쳐 충돌을 풀어라"(2026-10-26 아테나 · 사용자 방침 "자동화 · 고치고 바로 머지").
// merge 는 commit.sh --merge-base(이 레포 prBase 만 · 보호 훅이 통과시키는 길) → 충돌을 풀고 commit.sh 가 merge 커밋 → ship.sh --auto-push(충돌로 검증 대기인 PR 도 받는다).
// 그 새 HEAD 는 라운드를 올리지 않고 한 번 리뷰한다(BASE_MERGED)
export const conflictNotice = ({ agent, repo, number, sha, base, plan, worktree, athenaDir }) => oneLine(`[자동 리뷰 → ${agent}] PR ${repo}#${number} @${String(sha).slice(0, 7)} — base(${base})와 충돌해 머지하지 못했다. 자동 흐름 예외(이 지시에만): 묻지 않고 ${athenaDir}/scripts/commit.sh --plan ${athenaDir}/${plan} --dir ${worktree} --merge-base 로 origin/${base} 를 합치고, 충돌을 푼 뒤 ${athenaDir}/scripts/commit.sh --plan ${athenaDir}/${plan} --dir ${worktree} -m '<메시지>' -- <푼 파일>… 로 merge 커밋을 만들어 ${athenaDir}/scripts/ship.sh --plan ${athenaDir}/${plan} --dir ${worktree} --auto-push 로 올린다(base 합침 — 라운드를 쓰지 않고 자동 리뷰가 한 번 다시 본다). merge 커밋에는 충돌 풀기만 담고 다른 수정은 섞지 않는다. 푸는 방법이 하나가 아니면 고르지 말고 멈춰 아테나에 알린다. 계획서 Progress 에 한 줄`, 2000)

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

// ── 큰 diff 나누기 — 생성물은 빼고 코드 파일부터(이슈 20261025-자동-리뷰-큰-PR-diff-잘림 · syung#12 · #23) ─────────────
// 리뷰어 프롬프트에는 diff 를 limit 자까지만 넣는다. 예전에는 앞에서부터 잘라 맨 앞 생성물(1.2 MB JSON 등)이 자리를 다 차지했다.
// 이제 ① 생성물 · 데이터 파일은 본문 없이 "경로 · +N/−M줄 · 이유" 만 ② 나머지 파일의 아주 긴 줄은 앞부분만 ③ 코드 파일을 순서대로 넣고
// 넘치면 그 파일을 잘라 넣거나 빼고 목록으로 알린다. 잘리거나 빠진 파일이 있으면 complete=false — 그 승인은 머지 승인으로 세지 않는다(pr-auto.mjs)
export const LONG_LINE = 1000
export const SHORT_LINE_KEEP = 200
export const DATA_FILE_CHARS = 20_000
// 잘라서라도 넣는 최소 자리 — 이보다 남은 자리가 적으면 그 파일은 빼고 목록에만
export const MIN_PART_CHARS = 2000
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'Podfile.lock', 'pubspec.lock', 'mix.lock', 'flake.lock'])
const DATA_EXT = /\.(json|geojson|ndjson|jsonl|csv|tsv|xml|svg)$/i
const MINIFIED = /\.min\.(js|css|mjs)$|\.map$/i
const baseName = (path) => String(path).split('/').at(-1) ?? ''

// gitattributes 식 경로 패턴 → 정규식. / 가 없으면 어느 폴더의 이름이든(basename) · ** 는 폴더를 넘는다 · 끝이 / 면 그 폴더 아래 전부
export const globToRegExp = (pattern) => {
  let text = String(pattern).trim()
  const dirOnly = text.endsWith('/')
  if (dirOnly) text = text.slice(0, -1)
  const anchored = text.includes('/')
  text = text.replace(/^\//, '')
  let body = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '*' && text[index + 1] === '*') {
      body += text[index + 2] === '/' ? '(?:.*/)?' : '.*'
      index += text[index + 2] === '/' ? 2 : 1
    } else if (char === '*') body += '[^/]*'
    else if (char === '?') body += '[^/]'
    else body += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const prefix = anchored ? '^' : '^(?:.*/)?'
  return new RegExp(`${prefix}${body}${dirOnly ? '/.*' : '(?:/.*)?'}$`)
}
const matchesAny = (path, patterns) => patterns.some((pattern) => globToRegExp(pattern).test(path))

// .gitattributes 의 linguist-generated 규칙을 순서대로 — [{ pattern, on }]. 켬: linguist-generated · =true / 끔: -linguist-generated · !linguist-generated · =false
// git 처럼 뒤 규칙이 앞 규칙을 덮는다(linguistGenerated) — "* linguist-generated" 뒤 "src/** -linguist-generated" 면 src 는 생성물 아님
export const linguistGeneratedRules = (attributesText) => String(attributesText ?? '').split('\n').flatMap((line) => {
  const [pattern, ...attrs] = line.trim().split(/\s+/)
  if (!pattern || pattern.startsWith('#')) return []
  let on = null
  for (const attr of attrs) {
    if (attr === 'linguist-generated' || attr === 'linguist-generated=true') on = true
    else if (attr === '-linguist-generated' || attr === '!linguist-generated' || attr.startsWith('linguist-generated=')) on = false
  }
  return on === null ? [] : [{ pattern, on }]
})
// 그 경로의 최종 linguist-generated — 맞는 규칙 중 마지막 것
export const linguistGenerated = (path, rules) => rules.reduce((state, rule) => (globToRegExp(rule.pattern).test(path) ? rule.on : state), false)

// 팩 레포 설정의 생성물 경로 — pack.json 레포 항목 "generated": ["<패턴>", …](문자열이 아닌 것은 버린다)
export const repoGeneratedPatterns = (config, repoName) => {
  const list = (config?.repos ?? []).find((repo) => repo.name === repoName)?.generated
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()) : []
}

// git diff 글 → 파일마다 { path, text, added, removed, longest }. 머리줄(diff --git) 앞의 글이나 머리줄이 없는 글은 path '' 한 덩어리
export const splitDiff = (diff) => {
  const text = String(diff ?? '')
  if (!text) return []
  const starts = [...text.matchAll(/^diff --git /gm)].map((match) => match.index)
  if (!starts.length || starts[0] !== 0) starts.unshift(0)
  return starts.map((start, index) => {
    const chunk = text.slice(start, starts[index + 1] ?? text.length)
    const lines = chunk.split('\n')
    const plus = lines.find((line) => line.startsWith('+++ '))?.slice(4) ?? ''
    const minus = lines.find((line) => line.startsWith('--- '))?.slice(4) ?? ''
    const header = lines[0].match(/^diff --git a\/(.+) b\/(.+)$/)?.[2] ?? ''
    let path = header
    if (plus && plus !== '/dev/null') path = plus.replace(/^b\//, '')
    else if (minus && minus !== '/dev/null') path = minus.replace(/^a\//, '')
    let added = 0
    let removed = 0
    let longest = 0
    let inHunk = false
    for (const line of lines) {
      if (line.startsWith('@@')) { inHunk = true; continue }
      if (!inHunk) continue
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
      longest = Math.max(longest, line.length)
    }
    return { path: chunk.startsWith('diff --git ') ? path : '', text: chunk, added, removed, longest }
  })
}

// 생성물 · 데이터 파일이면 이유 글, 아니면 '' — 판별 기준은 docs/pr-auto.md "큰 diff"
export const generatedReason = (file, { patterns = [], attributes = [] } = {}) => {
  if (!file.path) return ''
  if (matchesAny(file.path, patterns)) return '팩 설정 생성물'
  if (linguistGenerated(file.path, attributes)) return 'linguist-generated'
  if (LOCKFILES.has(baseName(file.path))) return 'lockfile'
  if (MINIFIED.test(file.path)) return '압축본 · 소스맵'
  if (DATA_EXT.test(file.path) && (file.text.length > DATA_FILE_CHARS || file.longest > LONG_LINE)) return file.longest > LONG_LINE ? `데이터 파일 · 아주 긴 줄(${file.longest}자)` : `큰 데이터 파일(${file.text.length}자)`
  return ''
}

// 데이터 모양 줄 — 따옴표 문자열 내용을 비운 뒤 숫자 · 따옴표 · 괄호 · 구분 기호 · 공백이 90% 이상인 리터럴(PR #62 R1 확정 "데이터 모양 줄만 완전으로").
// 이런 줄은 앞부분만 넣어도 다 본 것으로 친다(역 데이터 · 숫자 표). 아니면(압축 코드 등) 못 본 코드가 있는 것 — 잘린 diff 와 같이 사람 확인으로
export const DATA_LINE_RATIO = 0.9
export const dataLikeLine = (line) => {
  const body = String(line).replace(/^[+\- ]/, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  if (!body.length) return true
  const data = body.match(/[0-9"'`[\]{}(),:;.\s+\-]/g)?.length ?? 0
  return data / body.length >= DATA_LINE_RATIO
}

// 아주 긴 줄은 앞부분만 — 코드 파일 안에 한 줄로 박힌 데이터(syung#12 web/index.html 의 역 데이터)가 자리를 다 먹지 않게.
// code — 그중 데이터 모양이 아닌 줄 수(> 0 이면 그 파일은 못 본 코드가 있다)
const shortenLongLines = (text) => {
  let count = 0
  let code = 0
  const out = text.split('\n').map((line) => {
    if (line.length <= LONG_LINE) return line
    count += 1
    if (!dataLikeLine(line)) code += 1
    return `${line.slice(0, SHORT_LINE_KEEP)} …(이 줄 ${line.length}자 — 앞 ${SHORT_LINE_KEEP}자만)`
  }).join('\n')
  return { text: out, count, code }
}

// attributes — linguistGeneratedRules 결과(PR base 쪽 .gitattributes — PR 이 스스로 바꾼 것은 쓰지 않는다)
// → { text, generated: [{ path, added, removed, reason }], shortened: [{ path, lines, code }], truncated: [{ path, shown, total }], dropped: [{ path, added, removed }], complete }
export const packDiff = (diff, { limit, patterns = [], attributes = [] }) => {
  const generated = []
  const shortened = []
  const truncated = []
  const dropped = []
  const parts = []
  const waiting = []
  let left = limit
  // 1) 통째로 들어가는 코드 파일을 순서대로(큰 파일 하나가 막아도 뒤의 작은 파일은 들어간다)
  for (const [index, file] of splitDiff(diff).entries()) {
    const reason = generatedReason(file, { patterns, attributes })
    if (reason) { generated.push({ path: file.path, added: file.added, removed: file.removed, reason }); continue }
    const short = shortenLongLines(file.text)
    if (short.count) shortened.push({ path: file.path, lines: short.count, code: short.code })
    if (short.text.length <= left) {
      parts.push({ index, text: short.text })
      left -= short.text.length
    } else waiting.push({ index, file, text: short.text })
  }
  // 2) 못 들어간 것 — 남은 자리가 있으면 맨 앞 하나를 잘라 넣고, 나머지는 목록에만
  for (const item of waiting) {
    if (left >= MIN_PART_CHARS) {
      parts.push({ index: item.index, text: `${item.text.slice(0, left)}\n…(이 파일 diff 는 여기서 잘림 — 뒤 ${item.text.length - left}자 못 넣음)\n` })
      truncated.push({ path: item.file.path, shown: left, total: item.text.length })
      left = 0
    } else dropped.push({ path: item.file.path, added: item.file.added, removed: item.file.removed })
  }
  const text = parts.sort((first, second) => first.index - second.index).map((part) => part.text).join('')
  const packed = { text, generated, shortened, truncated, dropped }
  return { ...packed, complete: missedFiles(packed).length === 0 }
}

// 프롬프트의 "리뷰에 넣지 못한 것" 절 — 없으면 ''
export const omittedSection = (packed) => {
  const lines = []
  const name = (path) => `\`${path || '(경로 모름)'}\``
  if (packed.generated.length) lines.push('생성물 · 데이터라 diff 본문을 넣지 않은 파일(리뷰 대상 아님 — 이 파일 내용으로 지적하지 않는다):', ...packed.generated.map((item) => `- ${name(item.path)} · +${item.added}/−${item.removed}줄 · 생성물이라 생략(${item.reason})`))
  const dataOnly = packed.shortened.filter((item) => !item.code)
  if (dataOnly.length) lines.push('데이터 모양의 아주 긴 줄을 앞부분만 넣은 파일(숫자 · 따옴표 · 괄호 위주 리터럴 — 그 줄 내용으로 지적하지 않는다):', ...dataOnly.map((item) => `- ${name(item.path)} · ${item.lines}줄`))
  if (!packed.complete) {
    lines.push('⚠️ 길어서 다 넣지 못한 코드 파일 — 이 PR 은 일부만 보고 판단한다. 아래 파일의 못 본 부분은 판단하지 않고, "전체 diff 를 달라" 같은 지적도 내지 않는다(받을 수 없다 · 자동 흐름이 따로 사람 확인으로 넘긴다):')
    lines.push(
      ...packed.truncated.map((item) => `- ${name(item.path)} · 앞 ${item.shown}자만(전체 ${item.total}자)`),
      ...packed.dropped.map((item) => `- ${name(item.path)} · +${item.added}/−${item.removed}줄 · 못 넣음`),
      ...packed.shortened.filter((item) => item.code).map((item) => `- ${name(item.path)} · 코드로 보이는 아주 긴 줄 ${item.code}개를 앞 ${SHORT_LINE_KEEP}자만`),
    )
  }
  return lines.join('\n')
}

// 잘린 diff 로 받은 승인 — 머지 조건의 승인으로 세지 않고 사람 확인으로(계획서 줄 결과 머리)
export const PARTIAL_APPROVAL = '잘린 diff 승인'
export const partialApproval = (summary, packed) => summary.verdict === 'approve' && !packed.complete
// 이 라운드에 못 본 코드 파일 경로(중복 없이) — 잘림 · 빠짐 · 코드로 보이는 긴 줄을 줄임. history 에 남겨 다음 라운드가 증분 대신 PR 전체 diff 를 다시 보게 한다
export const missedFiles = (packed) => [...new Set([...packed.truncated, ...packed.dropped, ...packed.shortened.filter((item) => item.code)].map((item) => item.path || '(경로 모름)'))]
export const partialCount = (packed) => missedFiles(packed).length

// ── PR 끔: 바로 머지 — 계획서 표시 줄 · 커밋 글 ──────────────────────────
// PR 이 없어 번호가 없다 — "- Auto review:" 줄(PR 번호 필수)과 따로 두고 레포 + 브랜치로 구분한다.
//   - Auto merge: <레포> <브랜치> @<sha7> · <결과> · <YYYY-MM-DD HH:MM>
export const DIRECT_MERGED = '머지됨'
const MERGE_LINE = /^- Auto merge:\s*([\w.-]+)\s+(\S+)\s+@([0-9a-f]{6,40})\s+·\s+(.+?)\s+·\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/
export const directMergeLines = (planText) => {
  const found = new Map()
  for (const line of String(planText ?? '').split('\n')) {
    const hit = line.match(MERGE_LINE)
    if (hit) found.set(`${hit[1]} ${hit[2]}`, { repo: hit[1], branch: hit[2], sha: hit[3], result: hit[4], stamp: hit[5], line })
  }
  return found
}
export const directMergeLineText = ({ repo, branch, sha, result, stamp }) => `- Auto merge: ${repo} ${branch} @${String(sha).slice(0, 7)} · ${oneLine(result, 300)} · ${stamp}`
export const withDirectMergeLine = (planText, entry) => {
  const line = directMergeLineText(entry)
  const lines = String(planText).split('\n')
  const index = lines.findIndex((row) => { const hit = row.match(MERGE_LINE); return hit && hit[1] === entry.repo && hit[2] === entry.branch })
  if (index >= 0) { lines[index] = line; return lines.join('\n') }
  const anchor = lines.findIndex((row) => /^- Work ref:/.test(row))
  if (anchor >= 0) { lines.splice(anchor + 1, 0, line); return lines.join('\n') }
  return `${String(planText).replace(/\n*$/, '')}\n${line}\n`
}
// 같은 HEAD 가 이미 머지됐나 — 끝난 일을 다시 하지 않는다
export const directMergeDone = (planText, repo, branch, headSha) => {
  const known = directMergeLines(planText).get(`${repo} ${branch}`)
  return Boolean(known) && known.result.startsWith(DIRECT_MERGED) && String(headSha).startsWith(known.sha)
}
// 바로 머지 커밋 글 — squash 한 줄 제목(계획서 제목)과 브랜치
export const directMergeMessage = ({ title, branch, base }) => `${oneLine(title || branch, 120)}\n\n${branch} → ${base} 바로 머지(PR 없음 · squash)`
// 바로 머지 결과를 작업 pane 에 — 알림만
export const directMergeNotice = ({ agent, repo, branch, sha, result }) => oneLine(`[자동 머지 → ${agent}] ${repo} ${branch} @${String(sha).slice(0, 7)} — ${result}. 알림만 — 이 글로 할 일은 없다(계획서 "- Auto merge:" 줄)`, 600)
// 바로 머지 대상 브랜치 — ship.sh 와 같은 기준(레포 prBase, 없으면 앱 중 첫 prBase)
export const prBaseOf = (config, repoName) => {
  const entry = (config?.repos ?? []).find((repo) => repo.name === repoName) ?? {}
  return entry.prBase || Object.values(entry.apps ?? {}).map((app) => app?.prBase).find(Boolean) || ''
}
// 계획서 제목(첫 "# " 줄) — 바로 머지 커밋 제목
export const planTitleOf = (planText) => String(planText ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim() ?? ''
