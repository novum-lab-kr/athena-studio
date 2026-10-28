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
