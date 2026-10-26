// 역할마다 Claude 모델 — 팩 pack.json 최상위 "models": { "<역할>": "<모델>" } (docs/pack.md "pack.json" · 계획서 2026-10-26 작업별 모델 배분)
//   agent       담당 에이전트 pane(delegate.sh — 에이전트 프로필 frontmatter model: 이 있으면 그게 이긴다)
//   reviewer    reviewer pane(delegate.sh — 같은 규칙)
//   prReview    PR 자동 리뷰 Claude 쪽(pr-auto.mjs)
//   learnReview 배우기 검토(learn-review.mjs)
//   athena      아테나 — 코어가 띄우지 않으니 기록만(읽는 곳 없음)
// 값은 Claude Code --model 이 받는 이름(opus · sonnet · haiku 또는 전체 이름). 없으면 --model 을 붙이지 않는다(기본 모델).
// 형식이 이상하면(모르는 역할 · 문자열 아님 · 빈 값 · 공백 · 따옴표 등) 무시하지 않고 오류 — 기본 모델로 몰래 돌지 않게.
// 파이썬 쪽 같은 규칙: scripts/lib/athena_config.py model_of
export const MODEL_ROLES = ['athena', 'agent', 'reviewer', 'prReview', 'learnReview']
// 별칭 · 전체 이름 · 클라우드 이름(점 · 콜론 · @ · 슬래시) · 긴 문맥 표시([1m])까지 — 셸에 먹히는 글자와 공백은 안 된다
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/

export const modelOf = (config, role) => {
  if (!MODEL_ROLES.includes(role)) throw new Error(`모르는 모델 역할: ${role}`)
  const models = config?.models
  if (models === undefined || models === null) return ''
  if (typeof models !== 'object' || Array.isArray(models)) throw new Error('pack.json "models" 는 { "<역할>": "<모델>" } 모양이어야 한다')
  for (const [key, value] of Object.entries(models)) {
    if (!MODEL_ROLES.includes(key)) throw new Error(`pack.json "models" 에 모르는 역할: ${key}(가능: ${MODEL_ROLES.join(' · ')})`)
    if (typeof value !== 'string' || !MODEL_NAME.test(value)) throw new Error(`pack.json "models.${key}" 모델 이름이 이상하다: ${JSON.stringify(value)}`)
  }
  return models[role] ?? ''
}

// claude 인자 — 값이 없으면 빈 배열
export const modelArgs = (config, role) => {
  const model = modelOf(config, role)
  return model ? ['--model', model] : []
}
