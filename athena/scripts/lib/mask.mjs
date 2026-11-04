// 비밀값 가리기 — 모양만 보고 가린다(규칙: 값은 어디에도 남기지 않는다). 배우기 검토(learn-review.mjs) · PR 자동 리뷰(pr-auto.mjs)가 같이 쓴다
//   maskSecrets(text) → { masked, count }
const SECRET_PATTERNS = [
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(_authToken=)[^\s"'\\]+/g,
  /\b(npm_)[A-Za-z0-9]{20,}/g,
  /\b(github_pat_)[A-Za-z0-9_]{20,}/g,
  /\b(glpat-)[A-Za-z0-9_-]{16,}/g,
  /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g,
  /\b(eyJ)[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@"']+(?=@)/gi,
  /(--(?:password|passwd|token|secret|api-key|auth)[\s=]+)[^\s"']+/gi,
  { name: true, pattern: /(\b[A-Z][A-Z0-9_]*(?:_AUTH|_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_PAT)\s*=\s*["']?)[^\s"';]+/g },
  /\b(sk-(?:ant-)?)[A-Za-z0-9_-]{16,}/g,
  /\b(xox[abpr]-)[A-Za-z0-9-]{10,}/g,
  /\b(AKIA)[A-Z0-9]{16}/g,
  { name: true, pattern: /((?:token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;\\]{6,}/gi },
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/g,
]
// 이름만 보고 가리는 패턴({ name: true })은 따옴표 없는 값이 코드 모양이면 그대로 둔다 — 함수 호출 · 색인(`re.compile(` · `keys[`) · 여는 괄호.
//   `DEDUP_KEY = re.compile(r'…')` 가 `DEDUP_KEY = ***'…')` 로 깨져 리뷰어가 없는 문법 오류를 지적했다(PR #205 · 2026-10-31).
//   따옴표 안 값 · 그냥 글자 값(`API_KEY=abc…`)은 지금처럼 가린다
const CODE_VALUE = /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*[([]|[{[(])/
const looksLikeCode = (prefix, value) => !/["']$/.test(prefix) && CODE_VALUE.test(value)

export const maskSecrets = (text) => {
  let masked = text
  let count = 0
  for (const entry of SECRET_PATTERNS) {
    const { pattern, name = false } = entry instanceof RegExp ? { pattern: entry } : entry
    masked = masked.replace(pattern, (whole, prefix) => {
      if (name && looksLikeCode(prefix, whole.slice(prefix.length))) return whole
      count += 1
      return `${prefix}***`
    })
  }
  return { masked, count }
}

// maskSecrets 에 더해 값 이름만 보고(cookie · session_id · Basic …) 넓게 가린다 — 로그 · QA 결과 · Jev 로 보내는 글에 쓴다
const SECRET_WORD = String.raw`[\w-]*(?:pass(?:word|wd)?|token|secret|api[-_]?key|authori[sz]ation|auth(?!or)|credential|cookie|session[-_]?id|private[-_]?key|otp)[\w-]*`

/** @param {unknown} text */
export const maskText = (text) => maskSecrets(String(text ?? '')).masked
  .replace(new RegExp(`(${SECRET_WORD})=([^&;\\s"']+)`, 'gi'), '$1=***')
  .replace(new RegExp(`("${SECRET_WORD}"\\s*:\\s*)"[^"]*"`, 'gi'), '$1"***"')
  .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 ***')
  .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***')
