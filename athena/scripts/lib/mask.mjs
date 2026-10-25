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
  /(\b[A-Z][A-Z0-9_]*(?:_AUTH|_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_PAT)\s*=\s*["']?)[^\s"';]+/g,
  /\b(sk-(?:ant-)?)[A-Za-z0-9_-]{16,}/g,
  /\b(xox[abpr]-)[A-Za-z0-9-]{10,}/g,
  /\b(AKIA)[A-Z0-9]{16}/g,
  /((?:token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;\\]{6,}/gi,
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/g,
]
export const maskSecrets = (text) => {
  let masked = text
  let count = 0
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (_whole, prefix) => {
      count += 1
      return `${prefix}***`
    })
  }
  return { masked, count }
}

