// 공개 자리에 올릴 Release 본문 · latest.json(scripts/release-files.js) — gh · 네트워크 없이 모양만 본다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const release = require('../scripts/release-files')

const CHANGELOG = [
  '# Changelog',
  '',
  'intro',
  '',
  '## 0.15 (v0.15.0 · Oct 28, 2026)',
  '',
  '### New',
  '- First release.',
  '',
  '## 0.13 (v0.13.0 – v0.13.34 · Oct 27–28, 2026)',
  '',
  '### Fixed',
  '- Something.',
  '',
  '## 0.12 (v0.12.0 · Oct 27, 2026)',
  '',
].join('\n')

test('버전은 태그 번호(X.Y.Z)만 — 태그 뒤 커밋(+N) · 모양이 아니면 null', () => {
  assert.equal(release.releaseVersion({ explicit: 'v0.15.0' }), '0.15.0')
  assert.equal(release.releaseVersion({ described: '0.15.1' }), '0.15.1')
  assert.equal(release.releaseVersion({ explicit: '0.15.2', described: '0.15.1+3' }), '0.15.2')
  assert.equal(release.releaseVersion({ described: '0.15.1+3' }), null)
  assert.equal(release.releaseVersion({ explicit: '' }), null)
  assert.equal(release.releaseVersion({ explicit: '0.15' }), null)
})

test('CHANGELOG 절 — 그 버전의 minor 묶음(## X.Y) 본문 · 패치 번호는 맞추지 않는다', () => {
  assert.equal(release.changelogSection(CHANGELOG, '0.15.0'), '### New\n- First release.')
  // 문서 머지로 끝자리가 올라도 같은 절
  assert.equal(release.changelogSection(CHANGELOG, '0.15.7'), '### New\n- First release.')
  assert.equal(release.changelogSection(CHANGELOG, '0.13.35'), '### Fixed\n- Something.')
})

test('CHANGELOG 절이 없거나 비었으면 null — 비슷한 minor 에 걸리지 않는다', () => {
  assert.equal(release.changelogSection(CHANGELOG, '0.16.0'), null)
  assert.equal(release.changelogSection(CHANGELOG, '0.1.0'), null)
  assert.equal(release.changelogSection(CHANGELOG, '1.15.0'), null)
  // 0.12 절은 제목만 있고 본문이 없다
  assert.equal(release.changelogSection(CHANGELOG, '0.12.0'), null)
  assert.equal(release.headingCovers('## 0.150 (v0.150.0 · Oct 28, 2026)', '0.15.0'), false)
  assert.equal(release.headingCovers('## 0.15.1 (v0.15.1 · Oct 28, 2026)', '0.15.1'), false)
  assert.equal(release.headingCovers('## 0.15 (v0.15.0 – · Oct 28, 2026)', '0.15.2'), true)
})

test('latest.json 모양 — version · date · minMacOS(배포판 최소 macOS) · files(.dmg 이름 · 크기 · sha256)', () => {
  const manifest = release.buildManifest({
    appVersion: '0.15.0',
    date: '2026-10-28',
    files: [
      { arch: 'arm64', size: 10, sha256: 'a'.repeat(64) },
      { arch: 'x64', size: 20, sha256: 'b'.repeat(64) },
    ],
  })
  assert.deepEqual(manifest, {
    version: '0.15.0',
    date: '2026-10-28',
    minMacOS: require('../scripts/package-mac').MINIMUM_MACOS,
    files: [
      { arch: 'arm64', name: 'Athena-Studio-mac-arm64.dmg', size: 10, sha256: 'a'.repeat(64) },
      { arch: 'x64', name: 'Athena-Studio-mac-x64.dmg', size: 20, sha256: 'b'.repeat(64) },
    ],
  })
})

test('latest-mac.yml(앱 안 업데이트 피드) — .zip 만 · 이름 · sha512 · 크기 · 맨 위 path/sha512 = 첫 파일', () => {
  const feed = release.buildUpdaterFeed({
    appVersion: '0.15.9',
    releaseDate: '2026-10-28T12:00:00.000Z',
    files: [
      { arch: 'arm64', size: 10, sha512: 'A+/=' },
      { arch: 'x64', size: 20, sha512: 'B+/=' },
    ],
  })
  assert.equal(release.UPDATER_FEED, 'latest-mac.yml')
  assert.deepEqual(feed, {
    version: '0.15.9',
    files: [
      { url: 'Athena-Studio-mac-arm64.zip', sha512: 'A+/=', size: 10 },
      { url: 'Athena-Studio-mac-x64.zip', sha512: 'B+/=', size: 20 },
    ],
    path: 'Athena-Studio-mac-arm64.zip',
    sha512: 'A+/=',
    releaseDate: '2026-10-28T12:00:00.000Z',
  })
  // 인텔 판 이름에는 arm64 가 없어야 한다 — electron-updater 가 이름으로 칩을 고른다
  assert.ok(!feed.files[1].url.includes('arm64'))
  assert.throws(() => release.buildUpdaterFeed({ appVersion: '0.15.9', releaseDate: 'x', files: [] }), /zip/)
})

test('sha512 는 electron-updater 꼴(base64)', async () => {
  const file = path.join(require('os').tmpdir(), `release-files-${process.pid}.bin`)
  fs.writeFileSync(file, 'abc')
  try {
    assert.equal(await release.sha512Of(file), require('crypto').createHash('sha512').update('abc').digest('base64'))
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('날짜는 한국 날짜 YYYY-MM-DD', () => {
  // UTC 10-27 16:00 = 한국 10-28 01:00
  assert.equal(release.releaseDate(new Date('2026-10-27T16:00:00Z')), '2026-10-28')
  assert.equal(release.releaseDate(new Date('2026-10-28T14:59:00Z')), '2026-10-28')
})

test('레포 CHANGELOG.md 의 모든 절 제목이 ## X.Y (vX.Y.Z[ – [vX.Y.N]] · 날짜) 꼴', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
  const headings = text.split('\n').filter((line) => /^## /.test(line))
  assert.ok(headings.length > 0)
  for (const heading of headings) assert.match(heading, /^## \d+\.\d+ \(v\d+\.\d+\.\d+( –( v\d+\.\d+\.\d+)?)? · .+\)$/, heading)
})

// 머지 전 검사(scripts/merge-gate.js — 코어 자동 머지 · athena-handoff.yml 이 머지 전에 부른다) — 머지 뒤 release-version.js 가 달 버전의 minor 절이
// CHANGELOG 에 없으면 막는다. 재현: v0.54.0 · v0.55.x release-mac 이 '## X.Y 절 없음' 으로 머지 뒤에야 실패했다(#248 · #249)
const REPO_CHANGELOG = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
const withSection = (changelog, heading) => changelog.replace(/\n## /, `\n${heading}\n\n### New\n- Something new.\n\n## `)

// 지금 CHANGELOG 맨 위 절(작성 때 0.55 — 태그 v0.55.3) 위에 다음 minor 절이 없는 상태 — 절을 더 써도 맨 위를 따라가 시험이 그대로 뜻을 가진다
const TOP_MINOR = /^## (\d+)\.(\d+) /m.exec(REPO_CHANGELOG)
const NOW_LATEST = TOP_MINOR ? `${TOP_MINOR[1]}.${TOP_MINOR[2]}.3` : '0.55.3'
const NOW_NEXT = TOP_MINOR ? `${TOP_MINOR[1]}.${Number(TOP_MINOR[2]) + 1}.0` : '0.56.0'

test('머지 전 검사 — 지금 main(v0.55.3 · 0.56 절 없음)에 feat 제목이면 v0.56.0 절이 없어 막는다', () => {
  assert.equal(release.changelogSection(REPO_CHANGELOG, NOW_NEXT), null)
  const result = release.mergeGate({ title: 'feat(app): 새 기능', latest: NOW_LATEST, changelog: REPO_CHANGELOG })
  assert.equal(result.ok, false)
  assert.equal(result.next, NOW_NEXT)
  assert.ok(result.reason && result.reason.includes(`## ${NOW_NEXT.split('.').slice(0, 2).join('.')} `), String(result.reason))
  // ! 도 가운데 올림(src/lib/version.js bumpKind 와 같은 판정)
  assert.equal(release.mergeGate({ title: 'fix!: 깨지는 변경', latest: NOW_LATEST, changelog: REPO_CHANGELOG }).ok, false)
})

test('머지 전 검사 — 0.56 절이 있으면 feat 도 통과 · 같은 minor 절에 이어 쓴 두 번째 feat 도', () => {
  const ready = withSection(REPO_CHANGELOG, '## 0.56 (v0.56.0 – · Nov 8, 2026)')
  assert.deepEqual(release.mergeGate({ title: 'feat: 새 기능', latest: '0.55.3', changelog: ready }), { ok: true, kind: 'minor', next: '0.56.0', reason: null })
  // 다음 minor 는 태그 기준 — release-version.js 와 같은 nextVersion(0.15.2 위의 feat 는 0.16.0 · 0.15 절이 있어도 0.16 절이 있어야 한다)
  assert.equal(release.mergeGate({ title: 'feat: 또', latest: '0.15.2', changelog: CHANGELOG }).ok, false)
  assert.equal(release.mergeGate({ title: 'feat: 또', latest: '0.15.2', changelog: withSection(CHANGELOG, '## 0.16 (v0.16.0 – · Oct 29, 2026)') }).ok, true)
})

test('머지 전 검사 — feat · ! 가 아니면(끝자리 올림) 절을 보지 않고 통과', () => {
  for (const title of ['fix(app): 고침', 'docs: 문서', 'chore: CHANGELOG 0.56 절', '형식 없는 제목', '']) {
    assert.deepEqual(release.mergeGate({ title, latest: '0.55.3', changelog: '' }), { ok: true, kind: 'patch', next: null, reason: null }, title)
  }
})

test('머지 전 검사 — 기준은 가장 높은 v* 태그(release-version.js 와 같다) · 태그가 없으면 package.json', () => {
  assert.equal(release.gateBase(['v0.9.1', 'v0.55.3', 'v0.55.10', 'x1', 'v0.56.0-rc']), '0.55.10')
  assert.equal(release.gateBase([]), require('../package.json').version)
})

// 2026-11-10 — 공개 Release v0.60.15 · v0.60.18 본문이 같은 0.60 절이던 것. 공개판 뒤에 들어간 줄만
test('Release 본문 — 공개판 뒤 판에 들어간 줄만 종류별로 · 줄이 없으면 NO_CHANGES · 공개판 · 판 번호를 모르면 minor 절 그대로', () => {
  const changelog = ['# Changelog', '', '## 0.60 (v0.60.0 – · Nov 8, 2026)', '', '### Improved', '- Old', '', '### Fixed', '- Fix16', '- Fix18', '', '## 0.58 (v0.58.0 – · Nov 8, 2026)', '', '### New', '- Old58', ''].join('\n')
  const versions = { Old: '0.59.4', Fix16: '0.60.16', Fix18: '0.60.18', Old58: '0.58.0' }
  assert.equal(release.releaseBody({ changelog, target: '0.60.18', since: '0.60.16', versions }), '### Fixed\n\n- Fix18')
  assert.equal(release.releaseBody({ changelog, target: '0.60.18', since: '0.58.3', versions }), '### Improved\n\n- Old\n\n### Fixed\n\n- Fix16\n- Fix18')
  assert.equal(release.releaseBody({ changelog, target: '0.60.15', since: '0.60.14', versions }), release.NO_CHANGES)
  assert.equal(release.releaseBody({ changelog, target: '0.60.18', since: null, versions }), release.changelogSection(changelog, '0.60.18'))
  assert.equal(release.releaseBody({ changelog, target: '0.60.18', since: '0.60.16', versions: null }), release.changelogSection(changelog, '0.60.18'))
  assert.equal(release.releaseBody({ changelog, target: '0.61.0', since: '0.60.16', versions }), null)
})

test('머지 전 검사 — feat · fix 제목이면 최신 태그 때 없던 CHANGELOG 줄이 있어야 한다 · fix(test|ci|docs) 와 다른 접두사는 면제 · 태그 CHANGELOG 를 모르면 보지 않는다', () => {
  const previous = ['## 0.60 (v0.60.0 – · Nov 8, 2026)', '', '### Fixed', '- Old', ''].join('\n')
  const added = previous.replace('- Old', '- Old\n- New fix')
  const blocked = release.mergeGate({ title: 'fix(release): 고침', latest: '0.60.18', changelog: previous, previous })
  assert.equal(blocked.ok, false)
  assert.ok(String(blocked.reason).includes('v0.60.18 뒤 새 줄이 없다'), String(blocked.reason))
  assert.equal(release.mergeGate({ title: 'fix(release): 고침', latest: '0.60.18', changelog: added, previous }).ok, true)
  assert.equal(release.mergeGate({ title: 'fix: 고침', latest: '0.60.18', changelog: previous, previous: null }).ok, true)
  const ready = `## 0.61 (v0.61.0 – · Nov 10, 2026)\n\n### New\n- Feature\n\n${previous}`
  assert.equal(release.mergeGate({ title: 'feat: 기능', latest: '0.60.18', changelog: ready, previous }).ok, true)
  assert.equal(release.mergeGate({ title: 'feat: 기능', latest: '0.60.18', changelog: `## 0.61 (v0.61.0 – · Nov 10, 2026)\n\n${previous}`, previous }).ok, false)
  for (const title of ['fix(test): 시험', 'fix(ci): 러너', 'fix(docs): 문서', 'chore: 정리', 'docs: 문서', 'test: 시험', 'refactor: 정리', '형식 없는 제목', '']) {
    assert.equal(release.mergeGate({ title, latest: '0.60.18', changelog: previous, previous }).ok, true, title)
  }
  assert.equal(release.needsLine('fix!: 깨짐'), true)
  assert.equal(release.needsLine('Feat(core): 기능'), true)
  assert.equal(release.needsLine('fix(test): 시험'), false)
})
