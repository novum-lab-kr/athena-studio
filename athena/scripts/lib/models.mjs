// @ts-check
// 역할과 엔진마다 모델 — 팩 pack.json 최상위 "models": { "<역할>": "<모델>" } (docs/pack.md "pack.json" · 계획서 2026-10-26 작업별 모델 배분)
//   agent       담당 에이전트 pane — 정식 계획서(plans/{feature,bugfix,refactor}/…) 작업(delegate.sh — 에이전트 프로필 frontmatter model: 이 있으면 그게 이긴다)
//   agentLight  담당 에이전트 pane — 경량 계획서(plans/task/…) 작업. 없으면 agent 값 · 그것도 없으면 코어 기본값(delegate.sh — 같은 규칙 · 계획서 2026-10-29 D1)
//   reviewer    reviewer pane(delegate.sh — 같은 규칙)
//   reviewerEscalated reviewer pane — 그 계획서의 같은 레포 · 브랜치 "- Review result:" 가 수정 필요일 때(다시 리뷰). 없으면 reviewer 값(같은 규칙 · 2026-10-29 D2)
//   prReview    PR 자동 리뷰 Claude 쪽(pr-auto.mjs)
//   prReviewSecond PR 자동 리뷰 두 번째 자리 — Codex 를 처음부터 못 쓰는 사람(명령 없음 · 로그인 안 됨)에게 Codex 대신 도는 Claude(prReview 와 다른 모델이어야 한다)
//   learnReview 배우기 검토(learn-review.mjs)
//   athena      아테나 — 코어가 띄우지 않으니 기록만(읽는 곳 없음)
// 어느 역할로 띄울지(경량 · 수정 필요 판정 · 없으면 대신 쓰는 값)는 delegate.sh 만 정한다 — 파이썬 athena_config.agent_model
// 문자열 값은 기존 Claude 모델. { claude: 이름, codex: 이름 } 은 엔진별 값이며 다른 엔진 값으로 대신하지 않는다.
// 값이 없으면 엔진 기본 모델(경량 Claude 만 코어 기본값).
// 형식이 이상하면(모르는 역할 · 문자열 아님 · 빈 값 · 공백 · 따옴표 등) 무시하지 않고 오류 — 기본 모델로 몰래 돌지 않게.
// 파이썬 쪽 같은 규칙: scripts/lib/athena_config.py model_of
export const MODEL_ROLES = ['athena', 'agent', 'agentLight', 'reviewer', 'reviewerEscalated', 'prReview', 'prReviewSecond', 'learnReview']
// 별칭 · 전체 이름 · 클라우드 이름(점 · 콜론 · @ · 슬래시) · 긴 문맥 표시([1m])까지 — 셸에 먹히는 글자와 공백은 안 된다
// 경량 작업 코어 기본값 · 새 팩 값 — 파이썬 athena_config.DEFAULT_AGENT_LIGHT_MODEL 과 같은 값
export const DEFAULT_AGENT_LIGHT_MODEL = 'claude-opus-5-5'
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/

/** @param {{models?: unknown} | null | undefined} config @param {string} role @param {string} engine */
export const modelOf = (config, role, engine = 'claude') => {
  if (!['claude', 'codex'].includes(engine)) throw new Error(`모르는 엔진: ${engine}`)
  if (!MODEL_ROLES.includes(role)) throw new Error(`모르는 모델 역할: ${role}`)
  const models = config?.models
  if (models === undefined || models === null) return ''
  if (typeof models !== 'object' || Array.isArray(models)) throw new Error('pack.json "models" 는 { "<역할>": "<모델>" } 모양이어야 한다')
  for (const [key, value] of Object.entries(models)) {
    if (!MODEL_ROLES.includes(key)) throw new Error(`pack.json "models" 에 모르는 역할: ${key}(가능: ${MODEL_ROLES.join(' · ')})`)
    const values = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { claude: value }
    if (!Object.keys(values).length || Object.keys(values).some((tool) => !['claude', 'codex'].includes(tool))) throw new Error(`pack.json models.${key} 엔진은 claude · codex 만 쓴다`)
    for (const name of Object.values(values)) {
      if (typeof name !== 'string' || !MODEL_NAME.test(name)) throw new Error(`pack.json models.${key} 모델 이름이 이상하다`)
    }
  }
  const value = /** @type {Record<string, string | Record<string, string>>} */ (models)[role]
  return typeof value === 'object' ? value[engine] ?? '' : engine === 'claude' ? value ?? '' : ''
}

// claude 인자 — 값이 없으면 빈 배열
/** @param {{models?: unknown} | null | undefined} config @param {string} role @param {string} engine */
export const modelArgs = (config, role, engine = 'claude') => {
  const model = modelOf(config, role, engine)
  return model ? ['--model', model] : []
}
