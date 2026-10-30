// 이슈 frontmatter 값 읽기 — 현황판(server.mjs readIssue)과 보관함(archive.mjs front)이 같이 쓴다.
// 값 뒤 공백 + `#` 는 주석으로 잘라 낸다. 단 값 전체를 따옴표("…" 또는 '…')로 감싸면 그 안의 `#` 는 그대로 둔다 —
// GitHub 이슈 제목처럼 바깥에서 온 글(`#12 로그인 안 됨`)을 따옴표로 감싸 쓰면 제목이 비거나 끊기지 않는다.
/** @param {string} raw frontmatter 한 줄의 `key:` 뒤 글 */
export const frontValue = (raw) => {
  const value = String(raw).trim()
  const quoted = value.match(/^(["'])(.*)\1(?:\s+#.*)?$/)
  if (quoted) return quoted[2].trim()
  return value.replace(/\s+#.*$/, '').trim()
}
