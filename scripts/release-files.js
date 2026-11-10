// @ts-check
// 맥 배포판을 공개 자리(novum-lab-kr/athena-studio-releases)에 올릴 때 쓰는 것 — Release 본문 · latest.json(계획서 3절 · 홈페이지가 읽는 약속)
// 워크플로(.github/workflows/release-mac.yml)가 파일을 만들어 artifact 에 넣고, 올리기는 로컬 scripts/publish-release.js 가 한다(같은 함수로 다시 확인)
//   node scripts/release-files.js check [--version X.Y.Z]     버전을 정하고(비우면 git 태그) CHANGELOG 에 그 버전 절이 있는지 — 없으면 1. 버전을 찍는다
//   node scripts/release-files.js notes --version X.Y.Z --out <파일> [--since X.Y.Z|published]   Release 본문 — --since 판 뒤에 들어간 줄만(줄마다 판 번호 · scripts/changelog-versions.js).
//       published = 공개 레포 latest(gh · release-mac.yml). 줄이 없으면 NO_CHANGES 한 줄 · --since 가 없거나 공개판이 없으면 그 버전 minor 절 그대로
//   node scripts/release-files.js manifest --version X.Y.Z --dir dist/release --out <파일>   latest.json(.dmg 기준 · 크기 · sha256)
//   node scripts/release-files.js updater --version X.Y.Z --dir dist/release --out <파일>    latest-mac.yml(앱 안 업데이트 피드 · .zip 기준 · 크기 · sha512)
//   node scripts/release-files.js gate --title "<PR 제목>"   머지 전 검사 — feat · ! 제목이면 머지 뒤 달릴 X.(Y+1).0 의 minor 절이 있어야 하고,
//       feat · fix 제목이면 머지될 판의 CHANGELOG 절에 최신 태그 때 없던 줄이 하나는 있어야 한다(없으면 1 · fix(test|ci|docs) 는 면제) · scripts/merge-gate.js 가 부른다
// 순수 부분(releaseVersion · changelogSection · releaseBody · needsLine · mergeGate · gateBase · buildManifest · buildUpdaterFeed · releaseDate)은 test/release-files.test.js 가 본다
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const studioHome = require('../src/lib/studio-home')
const version = require('../src/lib/version')
const packageMac = require('./package-mac')
const changelogVersions = require('./changelog-versions')
const releaseNotes = require('../src/lib/release-notes.mts')

const ROOT = path.join(__dirname, '..')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const ARCHES = ['arm64', 'x64']
// 날짜는 한국 날짜로(CHANGELOG 제목 날짜와 같은 기준) — latest.json "date" 는 YYYY-MM-DD(docs/release/homepage-handoff.md 1절)
const DATE_ZONE = 'Asia/Seoul'
// 앱 안 업데이트 피드 파일 — electron-updater 맥 채널 이름(latest + -mac · providers/Provider.getCustomChannelName)
const UPDATER_FEED = 'latest-mac.yml'

// 올릴 버전 — 명시값 > git 태그. 공개 Release 는 태그와 같은 번호만(X.Y.Z) — 0.15.1+2 같은 태그 뒤 커밋은 null
/** @param {{ explicit?: string | null, described?: string | null }} options */
function releaseVersion({ explicit = null, described = null }) {
  const value = String(explicit || described || '').replace(/^v/, '')
  return version.parseVersion(value) ? value : null
}

// CHANGELOG 제목 줄이 그 버전의 minor 묶음인지 — '## 0.15 (v0.15.0 – v0.15.3 · …)' 는 0.15.x 모두.
// 문서 머지마다 끝자리가 오르니 패치 번호까지 맞추지 않는다(괄호 안 범위는 사람이 읽는 표기 · 열어 둬도 된다 — 'v0.15.0 –')
/** @param {string} heading @param {string} target */
function headingCovers(heading, target) {
  const parsed = version.parseVersion(target)
  if (!parsed) return false
  return new RegExp(`^## ${parsed[0]}\\.${parsed[1]}(?![\\d.])`).test(heading)
}

// 그 버전(minor 묶음) 절의 본문(제목 줄 아래부터 다음 '## ' 앞까지 · 앞뒤 빈 줄 뺌) · 없거나 비었으면 null
/** @param {string} changelog @param {string} target */
function changelogSection(changelog, target) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => /^## /.test(line) && headingCovers(line, target))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line))
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
  return body || null
}

// 그 판에 새로 들어간 줄이 없을 때의 Release 본문
const NO_CHANGES = 'Maintenance release — no user-facing changes'
const KIND_HEADINGS = { new: 'New', improved: 'Improved', fixed: 'Fixed' }

// Release 본문 — since(공개판) 뒤 target 까지 들어간 줄만 종류별로(줄마다 판 번호 versions · 앱 업데이트 창과 같은 고르기 src/lib/release-notes.mts notesBetween).
// since · versions 가 없으면 그 minor 절 그대로(공개판이 아직 없을 때 · 손으로 돌릴 때) · 절이 없으면 null
/** @param {{ changelog: string, target: string, since?: string | null, versions?: Record<string, string> | null }} options */
function releaseBody({ changelog, target, since = null, versions = null }) {
  const section = changelogSection(changelog, target)
  if (!section || !since || !versions) return section
  const notes = releaseNotes.notesBetween(releaseNotes.parseChangelog(changelog), since, target, versions)
  if (!notes.length) return NO_CHANGES
  return releaseNotes.NOTE_KINDS.map((kind) => {
    const lines = notes.filter((note) => note.kind === kind).map((note) => `- ${note.text}`)
    return lines.length ? `### ${KIND_HEADINGS[kind]}\n\n${lines.join('\n')}` : ''
  }).filter(Boolean).join('\n\n')
}

// 사용자에게 보이는 수정 제목 — feat · fix(! 포함). 시험 · CI · 문서 범위(fix(test) 등)와 다른 접두사(chore · docs · test · refactor …) · 형식 없는 제목은 줄 없이 지나간다
const NO_LINE_SCOPES = new Set(['test', 'ci', 'docs'])
/** @param {unknown} title */
function needsLine(title) {
  const match = /^\s*([A-Za-z]+)(?:\(([^)]*)\))?!?:/.exec(String(title || ''))
  if (!match || !['feat', 'fix'].includes(String(match[1]).toLowerCase())) return false
  return !NO_LINE_SCOPES.has(String(match[2] || '').trim().toLowerCase())
}

// 머지 전 검사의 기준 버전 — release-version.js 와 같이 가장 높은 v* 태그 · 태그가 하나도 없으면 package.json version
/** @param {string[]} tags */
function gateBase(tags) {
  return version.latestTag(tags) || require(path.join(ROOT, 'package.json')).version
}

// 머지 전 검사 — 이 제목으로 머지되면 release-version.js 가 latest 다음에 달 버전(src/lib/version.js nextVersion 그대로).
// 가운데 올림(feat · !)이면 그 minor 절이 CHANGELOG 에 있어야 release-mac 의 "배포 버전 · CHANGELOG 확인"(readSection)을 지난다 — 없으면 막는다.
// 끝자리 올림은 이미 있는 minor 절에 들어가니 절은 보지 않는다(그 절은 앞 minor 머지 때 이 검사가 확인했다).
// 그다음 feat · fix 제목(needsLine)이면 머지될 판의 절에 최신 태그 때(previous) 없던 줄이 있어야 한다 — 업데이트 창 · Release 본문은 그 판에 새로 들어간 줄만 보인다(2026-11-10).
// previous 를 모르면(태그 CHANGELOG 를 못 읽음) 줄은 보지 않는다
/** @param {{ title: unknown, latest: string, changelog: string, previous?: string | null }} options */
function mergeGate({ title, latest, changelog, previous = null }) {
  const kind = version.bumpKind(title) === 'minor' ? 'minor' : 'patch'
  const next = kind === 'minor' ? version.nextVersion(latest, title) : null
  if (next && !changelogSection(changelog, next)) {
    const minor = next.split('.').slice(0, 2).join('.')
    const reason = `feat · ! 제목이라 머지되면 v${next} 가 된다(지금 태그 v${latest}) — CHANGELOG.md 에 '## ${minor} (v${next} – · <날짜>)' 절이 없어 맥 배포가 멈춘다. 그 절과 src/changelog · docs/site-release-notes.json 줄을 먼저 쓴다(공개 안 된 minor 절은 이 절에 합친다)`
    return { ok: false, kind, next, reason }
  }
  if (needsLine(title) && previous !== null) {
    // 머지될 판(끝자리 올림이면 지금 minor · 가운데 올림이면 새 minor)의 절에 넣은 줄만 친다 — 옛 절에 넣은 줄은 그 판 업데이트 내역에서 빠진다(리뷰 #283)
    const merged = version.nextVersion(latest, title)
    const minor = merged.split('.').slice(0, 2).join('.')
    const before = new Set(releaseNotes.parseChangelog(previous).flatMap((section) => section.notes.map((note) => note.text)))
    const [major, minorNumber] = merged.split('.').map(Number)
    const added = releaseNotes.parseChangelog(changelog)
      .filter((section) => section.minor[0] === major && section.minor[1] === minorNumber)
      .flatMap((section) => section.notes)
      .filter((note) => !before.has(note.text))
    if (!added.length) {
      const reason = `feat · fix 제목인데 CHANGELOG.md '## ${minor}' 절(머지되면 v${merged})에 v${latest} 뒤 새 줄이 없다 — 업데이트 창 · Release 본문은 그 판에 새로 들어간 줄만 보인다. 그 절 New / Improved / Fixed 에 영어 한 줄 + src/changelog/{ko,ja,zh}.json 번역(손님이 알아챌 것이면 docs/site-release-notes.json 도)을 쓴다. 사용자에게 안 보이는 수정이면 제목을 chore · test · docs 또는 fix(test|ci|docs) 로`
      return { ok: false, kind, next, reason }
    }
  }
  return { ok: true, kind, next, reason: null }
}

/** @param {Date} now */
function releaseDate(now) {
  // en-CA 는 YYYY-MM-DD 꼴로 찍는다
  return new Intl.DateTimeFormat('en-CA', { timeZone: DATE_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/**
 * latest.json — { version, date, minMacOS, files: [{ arch, name, size, sha256 }] }(계획서 3절 · .dmg 만)
 * @param {{ appVersion: string, date: string, files: { arch: string, size: number, sha256: string }[] }} options
 */
function buildManifest({ appVersion, date, files }) {
  return {
    version: appVersion,
    date,
    minMacOS: packageMac.MINIMUM_MACOS,
    files: files.map(({ arch, size, sha256 }) => ({ arch, name: packageMac.artifactName(arch, 'dmg'), size, sha256 })),
  }
}

/**
 * latest-mac.yml — electron-updater 가 읽는 꼴(UpdateInfo: version · files[url · sha512 · size] · path · sha512 · releaseDate).
 * JSON 으로 쓴다(JSON 은 YAML 이라 electron-updater 의 js-yaml 이 그대로 읽고, publish-release.js 는 JSON.parse 로 다시 맞춘다).
 * url 은 피드 주소(releases/latest/download)에 붙는 파일 이름 · 앱이 이름에 arm64 가 든 것(애플 실리콘)과 없는 것(인텔)을 고른다(MacUpdater.filterFilesForArch).
 * .dmg 는 넣지 않는다 — 맥 업데이트는 .zip 만 쓰고(MacUpdater findFile zip), .dmg 는 올리기 전에 staple 로 바뀐다
 * @param {{ appVersion: string, releaseDate: string, files: { arch: string, size: number, sha512: string }[] }} options
 */
function buildUpdaterFeed({ appVersion, releaseDate, files }) {
  const listed = files.map(({ arch, size, sha512 }) => ({ url: packageMac.artifactName(arch, 'zip'), sha512, size }))
  const first = listed[0]
  if (!first) throw new Error('.zip 이 하나도 없다')
  // path · sha512 는 옛 electron-updater 용 맨 위 값(files[0] 과 같다)
  return { version: appVersion, files: listed, path: first.url, sha512: first.sha512, releaseDate }
}

/** @param {string} file @param {'sha256' | 'sha512'} [algorithm] @param {'hex' | 'base64'} [encoding] @returns {Promise<string>} */
function hashOf(file, algorithm = 'sha256', encoding = 'hex') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm)
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest(encoding)))
  })
}

/** @param {string} file */
const sha256Of = (file) => hashOf(file, 'sha256', 'hex')
// electron-updater 가 맞추는 꼴 — sha512 base64
/** @param {string} file */
const sha512Of = (file) => hashOf(file, 'sha512', 'base64')

/** @param {string[]} args @param {string} name */
function argValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || '' : ''
}

/** @param {string[]} args */
function requireVersion(args) {
  const appVersion = releaseVersion({ explicit: argValue(args, '--version') })
  if (!appVersion) throw new Error('--version X.Y.Z 가 필요하다')
  return appVersion
}

/** @param {string} appVersion */
function readSection(appVersion) {
  const body = changelogSection(fs.readFileSync(CHANGELOG, 'utf8'), appVersion)
  if (!body) throw new Error(`CHANGELOG.md 에 v${appVersion} 의 minor 절이 없다 — '## ${appVersion.split('.').slice(0, 2).join('.')} (v${appVersion} · <날짜>)' 제목과 New / Improved / Fixed 를 먼저 쓴다`)
  return body
}

/** @param {string} file @param {string} text */
function writeOut(file, text) {
  if (!file) throw new Error('--out <파일> 이 필요하다')
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, text)
}

/** @param {string[]} args */
async function main(args) {
  const command = args[0]
  if (command === 'check') {
    const explicit = argValue(args, '--version')
    const described = explicit ? null : version.describeVersion({ repoRoot: ROOT, env: studioHome.gitEnv() })
    const appVersion = releaseVersion({ explicit, described })
    if (!appVersion) throw new Error(`공개 Release 는 태그 번호(X.Y.Z)로만 올린다 — 지금 ${explicit || described || '(태그 없음)'} · 태그 커밋에서 돌리거나 version 칸에 준다`)
    readSection(appVersion)
    console.log(appVersion)
    return
  }
  if (command === 'notes') {
    const appVersion = requireVersion(args)
    readSection(appVersion)
    const sinceArg = argValue(args, '--since')
    // published — 공개 레포 latest(올리기 전이라 아직 이전 판) · 없으면(첫 공개) 절 그대로
    const since = sinceArg === 'published' ? require('./release-changed').publishedVersion() : sinceArg.replace(/^v/, '') || null
    const versions = since ? changelogVersions.changelogVersions({ repoRoot: ROOT, env: studioHome.gitEnv() }) : null
    const body = releaseBody({ changelog: fs.readFileSync(CHANGELOG, 'utf8'), target: appVersion, since, versions })
    console.log(`[release] Release 본문 — ${since ? `v${since} 뒤 줄만` : 'minor 절 그대로'}`)
    writeOut(argValue(args, '--out'), `${body}\n`)
    return
  }
  if (command === 'manifest') {
    const appVersion = requireVersion(args)
    const dir = argValue(args, '--dir') || path.join(ROOT, 'dist', 'release')
    const files = []
    for (const arch of ARCHES) {
      const file = path.join(dir, packageMac.artifactName(arch, 'dmg'))
      if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} 가 없다 — 두 칩(--arch all)을 다 만든 뒤에 올린다`)
      files.push({ arch, size: fs.statSync(file).size, sha256: await sha256Of(file) })
    }
    writeOut(argValue(args, '--out'), `${JSON.stringify(buildManifest({ appVersion, date: releaseDate(new Date()), files }), null, 2)}\n`)
    return
  }
  if (command === 'updater') {
    const appVersion = requireVersion(args)
    const dir = argValue(args, '--dir') || path.join(ROOT, 'dist', 'release')
    const files = []
    for (const arch of ARCHES) {
      const file = path.join(dir, packageMac.artifactName(arch, 'zip'))
      if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} 가 없다 — 두 칩(--arch all)을 다 만든 뒤에 올린다`)
      files.push({ arch, size: fs.statSync(file).size, sha512: await sha512Of(file) })
    }
    writeOut(argValue(args, '--out'), `${JSON.stringify(buildUpdaterFeed({ appVersion, releaseDate: new Date().toISOString(), files }), null, 2)}\n`)
    return
  }
  if (command === 'gate') {
    // 태그를 받아 온 뒤 정한다(받지 못하면 있는 태그로 — 오프라인 · 얕은 체크아웃) · CHANGELOG 는 이 체크아웃(머지될 트리)의 것
    version.fetchTags({ repoRoot: ROOT, env: studioHome.gitEnv() })
    /** @type {string[]} */
    let tags = []
    try {
      tags = String(execFileSync('git', ['tag', '--list', version.TAG_PATTERN], { cwd: ROOT, env: studioHome.gitEnv(), encoding: 'utf8' })).split('\n').filter(Boolean)
    } catch {
      tags = []
    }
    const latest = gateBase(tags)
    // 최신 태그 때의 CHANGELOG — 이 PR 이 새 줄을 더했는지 견준다(태그가 없거나 못 읽으면 null · 줄은 보지 않는다)
    /** @type {string | null} */
    let previous = null
    try {
      previous = String(execFileSync('git', ['show', `v${latest}:CHANGELOG.md`], { cwd: ROOT, env: studioHome.gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    } catch {
      previous = null
    }
    const title = argValue(args, '--title')
    const result = mergeGate({ title, latest, changelog: fs.readFileSync(CHANGELOG, 'utf8'), previous })
    if (!result.ok) throw new Error(String(result.reason))
    const lineNote = !needsLine(title) ? '사용자에게 안 보이는 제목 — 새 줄 확인 안 함' : previous === null ? `v${latest} CHANGELOG 를 못 읽어 새 줄 확인 안 함` : '새 CHANGELOG 줄이 있다'
    console.log(result.kind === 'minor' ? `통과 — v${result.next} 의 CHANGELOG 절이 있다 · ${lineNote}` : `통과 — 끝자리 올림 · ${lineNote}`)
    return
  }
  throw new Error('명령: check · notes · manifest · updater · gate')
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[release] 실패: ${error && error.message ? error.message : error}`)
    process.exit(1)
  })
}

module.exports = { ARCHES, UPDATER_FEED, NO_CHANGES, releaseVersion, headingCovers, changelogSection, releaseBody, needsLine, mergeGate, gateBase, releaseDate, buildManifest, buildUpdaterFeed, sha256Of, sha512Of }
