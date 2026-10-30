// 아테나 자체 버그 → 우리 GitHub 이슈 초안 (공개 레포라 회사 정보를 뺀다)
//   팩에 코어 레포(athena-studio)가 없는 아테나(다른 회사)는 현황판 이슈 대신 이 초안 화면으로 보낸다. 있으면 지금처럼 현황판 이슈.
//   hasStudioRepo(config)            → 이 팩에 코어 레포가 있나
//   redact(text, { names, paths })   → 비밀값 · 경로 · 레포 이름 · 메일 · 주소를 가린 글
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

export const hasStudioRepo = (config) => (config?.repos ?? []).some((repo) => repo?.name === STUDIO_REPO)

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// names: 가릴 이름들(레포 · 팩 · 회사 · 사람) · paths: 가릴 경로(홈 · 팩 · 본체 경로)
export const redact = (text, { names = [], paths = [] } = {}) => {
  let result = String(text ?? '')
  // 코드 조각은 통째로 뺀다
  result = result.replace(/```[\s\S]*?(?:```|$)/g, '[코드 생략]')
  result = maskSecrets(result).masked
  for (const path of [...paths].filter(Boolean).sort((first, second) => second.length - first.length)) {
    result = result.replace(new RegExp(escapeRegExp(path), 'g'), '<경로>')
  }
  // 남은 홈 · 절대 경로 — 아테나 스크립트 이름(scripts/…)은 상대 경로라 남는다
  result = result
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp|\/Volumes|\/opt|\/srv|\/mnt)\/[^\s"'`)\]]+/g, '<경로>')
    .replace(/~\/[^\s"'`)\]]+/g, '<경로>')
    .replace(/[A-Za-z]:\\Users\\[^\s"'`)\]]+/g, '<경로>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<메일>')
    .replace(/\bgit@[\w.-]+:[^\s]+/g, '<주소>')
    .replace(/\b(?:https?|ssh|git):\/\/[^\s"'`)\]]+/g, '<주소>')
  for (const name of [...names].map((entry) => String(entry ?? '').trim()).filter((entry) => entry.length >= 2).sort((first, second) => second.length - first.length)) {
    result = result.replace(new RegExp(escapeRegExp(name), 'gi'), '<이름>')
  }
  return result
}

const encodeQuery = (pairs) => pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
const urlOf = (title, fields) => `${ISSUE_NEW_URL}?${encodeQuery([['template', TEMPLATE], ['title', title], ...FIELD_IDS.filter((id) => fields[id]).map((id) => [id, fields[id]])])}`

// fields: 필드 id → 글(redact 를 거친 것). 주소가 URL_LIMIT 를 넘으면 가장 긴 칸부터 줄이고 표시를 붙인다
export const buildDraft = ({ title, fields }, { limit = URL_LIMIT } = {}) => {
  const kept = Object.fromEntries(FIELD_IDS.map((id) => [id, String(fields?.[id] ?? '').trim()]))
  let truncated = false
  let url = urlOf(title, kept)
  while (url.length > limit) {
    const longest = FIELD_IDS.reduce((best, id) => (kept[id].length > kept[best].length ? id : best), FIELD_IDS[0])
    const current = kept[longest].replace(TRUNCATED_MARK, '')
    if (current.length <= 20) break
    truncated = true
    kept[longest] = `${current.slice(0, Math.max(20, Math.floor(current.length * 0.8)))}${TRUNCATED_MARK}`
    url = urlOf(title, kept)
  }
  return { title, fields: kept, url, truncated }
}
