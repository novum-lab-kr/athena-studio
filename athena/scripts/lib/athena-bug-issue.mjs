// @ts-check
// 아테나 자체 버그 → 우리 GitHub 이슈 초안 (공개 레포라 회사 정보를 뺀다)
//   팩에 코어 레포(athena-studio)가 없는 아테나(다른 회사)는 현황판 이슈 대신 이 초안 화면으로 보낸다. 있으면 지금처럼 현황판 이슈.
//   hasStudioRepo(config)            → 이 팩에 코어 레포가 있나
//   redact(text, { names, paths })   → 비밀값 · 경로 · 코드 · 호스트 · 레포 이름 · 메일 · 주소를 가린 글
//   buildDraft(fields, options)      → { title, fields, url, truncated } — url 은 초안을 채운 GitHub 새 이슈 화면(사용자가 보고 직접 Submit)
import { maskSecrets } from './mask.mjs'

export const STUDIO_REPO = 'athena-studio'
export const ISSUE_NEW_URL = 'https://github.com/novum-lab-kr/athena-studio/issues/new'
export const TEMPLATE = 'bug_report.yml'
// .github/ISSUE_TEMPLATE/bug_report.yml 의 필드 id — test/athena-bug-issue.test.js 가 그 파일과 맞는지 본다
export const FIELD_IDS = ['what-happened', 'expected', 'steps', 'app-version', 'macos-version', 'chip', 'logs']
// 브라우저 · GitHub 가 받는 주소 길이는 8KB 안팎 — 여유를 두고 자른다
export const URL_LIMIT = 6500
export const TRUNCATED_MARK = '… (본문 일부 생략)'

/** @param {{ repos?: Array<{ name?: string }> } | null | undefined} config */
export const hasStudioRepo = (config) => (config?.repos ?? []).some((repo) => repo?.name === STUDIO_REPO)

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 호스트로 보는 끝 글자 — 파일 이름(ship.sh · athena.mjs)과 겹치지 않는 것만. 점이 셋 이상이면 끝 글자와 상관없이 호스트
const HOST_SUFFIX = 'com|net|org|io|dev|app|cloud|internal|local|lan|corp|intranet|example|test|co|kr|ai|biz|info'
const SOURCE_EXT = 'js|jsx|mjs|cjs|ts|tsx|mts|cts|json|py|rb|go|rs|java|kt|swift|php|css|scss|html|vue|sql|yml|yaml|toml|env|md|sh|lock'

/**
 * @param {string} text
 * @param {{ names?: unknown[], paths?: Array<string | null | undefined>, scripts?: Set<string> }} [scrub] names: 가릴 이름들(레포 · 팩 · 회사 · 사람) · paths: 가릴 경로(홈 · 팩 · 본체 경로) · scripts: 남길 아테나 스크립트 경로(`scripts/board.sh` — 실제 코어에 있는 것만)
 */
export const redact = (text, { names = [], paths = [], scripts = new Set() } = {}) => {
  let result = String(text ?? '')
  // 코드 조각은 통째로 뺀다 — 블록 · 인라인 모두
  result = result.replace(/```[\s\S]*?(?:```|$)/g, '[코드 생략]').replace(/`[^`\n]*`/g, '[코드 생략]')
  result = maskSecrets(result).masked
  for (const path of [...paths].filter((entry) => typeof entry === 'string' && entry).sort((first, second) => String(second).length - String(first).length)) {
    result = result.replace(new RegExp(escapeRegExp(String(path)), 'g'), '<경로>')
  }
  // 남은 홈 · 절대 경로 · 주소를 먼저 — 그 뒤 상대 경로 · 호스트
  result = result
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp|\/Volumes|\/opt|\/srv|\/mnt)\/[^\s"'`)\]]+/g, '<경로>')
    .replace(/~\/[^\s"'`)\]]+/g, '<경로>')
    .replace(/[A-Za-z]:\\Users\\[^\s"'`)\]]+/g, '<경로>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<메일>')
    .replace(/\bgit@[\w.-]+:[^\s]+/g, '<주소>')
    .replace(/\b(?:https?|ssh|git):\/\/[^\s"'`)\]]+/g, '<주소>')
  // 상대 파일 경로 — 슬래시가 둘 이상이거나 끝이 파일 확장자. 실제 코어에 있는 아테나 스크립트 경로(scripts 인자)만 남긴다
  result = result.replace(/(?<![\w<>/.-])(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?/g, (matched) => {
    const slashes = matched.split('/').length - 1
    const last = matched.replace(/\/$/, '').split('/').pop() ?? ''
    const looksFile = new RegExp(`\\.(?:${SOURCE_EXT})$`, 'i').test(last)
    if (scripts.has(matched)) return matched
    return slashes >= 2 || looksFile ? '<경로>' : matched
  })
  // 소스 파일 이름만 따로 쓴 것(internal.js) — 아테나 스크립트(.mjs · .sh · .py)는 남기려고 확장자를 고객 코드에 흔한 것으로 한정
  result = result.replace(/(?<![\w<>/.-])[\w@-]+(?:\.[\w@-]+)*\.(?:jsx?|tsx?|json|rb|go|rs|java|kt|swift|php|s?css|html|vue|sql|ya?ml|toml|env)\b/gi, '<경로>')
  // 호스트 · IPv4
  result = result
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<호스트>')
    .replace(new RegExp(`\\b(?:[a-z0-9-]+\\.){2,}[a-z]{2,}(?::\\d+)?\\b|\\b[a-z0-9-]+\\.(?:${HOST_SUFFIX})(?::\\d+)?\\b`, 'gi'), '<호스트>')
  for (const name of [...names].map((entry) => String(entry ?? '').trim()).filter((entry) => entry.length >= 2).sort((first, second) => second.length - first.length)) {
    result = result.replace(new RegExp(escapeRegExp(name), 'gi'), '<이름>')
  }
  return result
}

/** @param {Array<[string, string]>} pairs */
const encodeQuery = (pairs) => pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
/**
 * @param {string} title
 * @param {Record<string, string>} fields
 */
const urlOf = (title, fields) => `${ISSUE_NEW_URL}?${encodeQuery([['template', TEMPLATE], ['title', title], ...FIELD_IDS.filter((id) => fields[id]).map((id) => /** @type {[string, string]} */ ([id, fields[id] ?? '']))])}`

// 유니코드 코드 포인트 단위로 자른다 — 이모지의 서로게이트 쌍을 중간에서 끊으면 encodeURIComponent 가 던진다
/**
 * @param {string} text
 * @param {number} count
 */
const sliceByCodePoint = (text, count) => Array.from(text).slice(0, count).join('')

/**
 * fields: 필드 id → 글(redact 를 거친 것). 주소가 limit 를 넘으면 제목 · 본문 중 가장 긴 것부터 줄이고 표시를 붙인다
 * @param {{ title: string, fields?: Record<string, string | undefined> }} draft
 * @param {{ limit?: number }} [options]
 */
export const buildDraft = ({ title, fields }, { limit = URL_LIMIT } = {}) => {
  /** @type {Record<string, string>} */
  const kept = Object.fromEntries(FIELD_IDS.map((id) => [id, String(fields?.[id] ?? '').trim()]))
  let keptTitle = String(title ?? '')
  let truncated = false
  let url = urlOf(keptTitle, kept)
  while (url.length > limit) {
    // 줄일 후보 — 제목 포함. 길이는 글자(코드 포인트) 수
    const candidates = [['title', keptTitle], ...FIELD_IDS.map((id) => [id, kept[id] ?? ''])]
    const [longestKey = 'title', longestText = ''] = candidates.reduce((best, entry) => (Array.from(entry[1] ?? '').length > Array.from(best[1] ?? '').length ? entry : best), candidates[0] ?? ['title', ''])
    const current = String(longestText).replace(TRUNCATED_MARK, '')
    const length = Array.from(current).length
    if (length <= 20) break
    truncated = true
    const shortened = `${sliceByCodePoint(current, Math.max(20, Math.floor(length * 0.8)))}${TRUNCATED_MARK}`
    if (longestKey === 'title') keptTitle = shortened
    else kept[String(longestKey)] = shortened
    url = urlOf(keptTitle, kept)
  }
  return { title: keptTitle, fields: kept, url, truncated }
}
