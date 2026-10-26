// 버전 번호(SemVer 0.x · 결정 D1 · D2 — plans/feature/20261026-버저닝) — 정본은 git 태그 vX.Y.Z 하나.
// main 에 머지될 때마다 워크플로(.github/workflows/release.yml → scripts/release-version.js)가 그 커밋에 다음 태그를 단다:
// PR 제목(squash 커밋 제목)의 타입이 feat 이거나 ! 가 붙으면 가운데(0.Y+1.0) · 그 밖은 끝자리(0.Y.Z+1). 1.0 전이라 ! 도 가운데까지만.
// 앱은 git describe 로 읽는다 — 태그 커밋이면 0.2.1, 그 뒤 커밋이 3개 더 있으면 0.2.1+3. 태그가 없으면 package.json 값.
// Electron 없이 돈다(test/version.test.js). git 은 셸을 거치지 않고 부른다
const { execFileSync } = require('child_process')

const TAG_PATTERN = 'v[0-9]*'
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/
// 앱 · 코어가 보이는 모양 — 0.2.1 · 0.2.1+3
const DISPLAY_RE = /^\d+\.\d+\.\d+(\+\d+)?$/

// '0.2.1' · 'v0.2.1' → [0, 2, 1] · 아니면 null
function parseVersion(text) {
  const match = VERSION_RE.exec(String(text || '').replace(/^v/, ''))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(left, right) {
  const first = parseVersion(left)
  const second = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (first[index] !== second[index]) return first[index] - second[index]
  }
  return 0
}

// 태그 이름들 중 가장 높은 버전(v 없이) · 맞는 태그가 없으면 null
function latestTag(tags) {
  const versions = (Array.isArray(tags) ? tags : []).filter((tag) => /^v/.test(tag) && parseVersion(tag)).map((tag) => tag.slice(1))
  return versions.reduce((best, each) => (best === null || compareVersions(each, best) > 0 ? each : best), null)
}

// PR 제목 → 'minor' | 'patch'. feat(…) · 타입 뒤 ! 는 가운데, 그 밖(fix · docs · chore · 형식 없는 제목)은 끝자리
function bumpKind(title) {
  const match = /^\s*([A-Za-z]+)(\([^)]*\))?(!)?:/.exec(String(title || ''))
  if (!match) return 'patch'
  if (match[3] || match[1].toLowerCase() === 'feat') return 'minor'
  return 'patch'
}

// 기준 버전(가장 최근 태그 · 없으면 package.json) + 제목 → 다음 버전
function nextVersion(base, title) {
  const [major, minor, patch] = parseVersion(base)
  if (bumpKind(title) === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// git describe --tags --long 출력('v0.2.1-3-gabc1234') → '0.2.1+3' · 태그 커밋이면 '0.2.1' · 못 읽으면 null
function formatDescribe(output) {
  const match = /^v(\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/.exec(String(output || '').trim())
  if (!match) return null
  return match[2] === '0' ? match[1] : `${match[1]}+${match[2]}`
}

// 그 ref 의 버전 — 태그가 없거나 git 이 아니면 null(부르는 쪽이 package.json 값으로)
function describeVersion({ repoRoot, ref = 'HEAD', env = process.env }) {
  try {
    const output = execFileSync('git', ['describe', '--tags', '--long', '--match', TAG_PATTERN, ref], { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })
    return formatDescribe(output)
  } catch {
    return null
  }
}

// '0.2.1+3' → { tag: '0.2.1', distance: 3 } · 모양이 아니면 null
function splitDisplay(text) {
  const match = /^(\d+\.\d+\.\d+)(?:\+(\d+))?$/.exec(String(text || ''))
  return match ? { tag: match[1], distance: Number(match[2] || 0) } : null
}

// Release 본문 — PR 제목 · 링크(PR 을 못 찾으면 커밋 제목 · 커밋 링크)
function releaseNotes({ title, number = null, url = null }) {
  const head = number && !String(title).includes(`(#${number})`) ? `${title} (#${number})` : String(title)
  return url ? `${head}\n\n${url}\n` : `${head}\n`
}

module.exports = { TAG_PATTERN, DISPLAY_RE, parseVersion, compareVersions, latestTag, bumpKind, nextVersion, formatDescribe, describeVersion, splitDisplay, releaseNotes }
