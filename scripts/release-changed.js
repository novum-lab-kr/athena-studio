// @ts-check
// 버전 태그 뒤 맥 배포판을 만들지 정한다 — .github/workflows/release.yml 이 태그를 단 다음 부른다(계획서 plans/feature/20261106-릴리스-머지-때-자동-공개와-소개-사이트-자동-반영 D2 · 5절)
//   node scripts/release-changed.js [--sha <커밋>]
//     새 판 = 그 커밋에서 닿는 가장 높은 v* 태그 · 비교 기준 = 공개 레포(athena-studio-releases) latest 의 태그
//     만든다: 공개판이 없을 때 · 공개판 태그가 이 레포에 없을 때 · 두 태그 사이에 아래 '앱 밖' 이 아닌 파일이 하나라도 바뀌었을 때
//     건너뛴다: 새 판이 공개판보다 높지 않을 때 · 바뀐 파일이 모두 앱 밖일 때(건너뛴 변경은 공개판 기준이라 다음 판에 함께 실린다)
//     결과는 한 줄로 찍고 GITHUB_OUTPUT 이 있으면 build=true|false · version=X.Y.Z 를 적는다
// 필요: git(태그까지 받은 체크아웃) · gh(GH_TOKEN — 공개 레포 읽기라 기본 토큰이면 된다). npm 의존성 없이 돈다(release.yml 은 npm ci 를 하지 않는다)
// 순수 부분(isOutsideApp · decide)은 test/release-changed.test.js
const fs = require('fs')
const { execFileSync } = require('child_process')
const version = require('../src/lib/version')
const packageMac = require('./package-mac')

/**
 * 앱 밖 파일인가 — 레포 뿌리 기준 경로. athena/ 안 문서(규칙 · 지시문)는 코어 동작이라 앱 안이다
 * @param {string} file
 */
function isOutsideApp(file) {
  if (file === 'CHANGELOG.md') return true
  if (/^README[^/]*\.md$/.test(file)) return true
  return ['test/', 'athena/test/', 'docs/', '.github/'].some((prefix) => file.startsWith(prefix))
}

/**
 * @param {{ next: string | null, published: string | null, baseKnown: boolean, files: string[] }} options
 *   next = 새 판(v 없이) · published = 공개판(v 없이 · 없으면 null) · baseKnown = 공개판 태그가 이 레포에 있나 · files = 두 태그 사이 바뀐 파일
 * @returns {{ build: boolean, reason: string }}
 */
function decide({ next, published, baseKnown, files }) {
  if (!next) return { build: false, reason: '버전 태그가 없다' }
  if (!published) return { build: true, reason: '공개판이 아직 없다' }
  if (version.compareVersions(next, published) <= 0) return { build: false, reason: `v${next} 가 공개판 v${published} 보다 높지 않다` }
  if (!baseKnown) return { build: true, reason: `공개판 태그 v${published} 가 이 레포에 없어 비교하지 못했다` }
  const inside = files.filter((file) => !isOutsideApp(file))
  if (!inside.length) return { build: false, reason: `v${published} → v${next} 사이 앱이 바뀌지 않았다(${files.length}개 파일 모두 문서 · 시험 · .github · CHANGELOG)` }
  return { build: true, reason: `v${published} → v${next} 사이 앱 파일 ${inside.length}개가 바뀌었다(예: ${inside.slice(0, 3).join(' · ')})` }
}

/** @param {string} file @param {string[]} args */
function run(file, args) {
  return String(execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim()
}

const lines = (/** @type {string} */ text) => text.split('\n').filter(Boolean)

// 공개 레포 latest 태그(v 없이) · Release 가 하나도 없으면(404) null · 그 밖의 오류는 던진다(모른 채 만들거나 건너뛰지 않게)
function publishedVersion() {
  try {
    const tag = run('gh', ['api', `repos/${packageMac.RELEASES_REPO}/releases/latest`, '--jq', '.tag_name'])
    return version.parseVersion(tag) ? tag.replace(/^v/, '') : null
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr || '')
    if (/HTTP 404|Not Found/.test(stderr)) return null
    throw new Error(`공개 레포 latest 를 읽지 못했다(gh api): ${stderr.trim().slice(0, 200) || String(error)}`)
  }
}

/** @param {string[]} args */
function main(args) {
  const index = args.indexOf('--sha')
  const sha = run('git', ['rev-parse', '--verify', `${(index >= 0 && args[index + 1]) || process.env.GITHUB_SHA || 'HEAD'}^{commit}`])
  const next = version.latestTag(lines(run('git', ['tag', '--merged', sha, '--list', version.TAG_PATTERN])))
  const published = next ? publishedVersion() : null
  const baseKnown = Boolean(published) && lines(run('git', ['tag', '--list', `v${published}`])).length > 0
  const files = next && published && baseKnown ? lines(run('git', ['diff', '--name-only', `v${published}`, `v${next}`])) : []
  const result = decide({ next, published, baseKnown, files })
  console.log(`[release-changed] ${result.build ? '맥 배포판을 만든다' : '건너뛴다'} — ${result.reason}`)
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=${result.build}\nversion=${next || ''}\n`)
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[release-changed] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

module.exports = { isOutsideApp, decide }
