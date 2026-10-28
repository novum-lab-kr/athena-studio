// 공개 레포에 올리기(scripts/publish-release.js) — gh · 네트워크 없이 확인 · 인자 모양만 본다
const test = require('node:test')
const assert = require('node:assert/strict')
const publish = require('../scripts/publish-release')

const run = { workflowName: 'release-mac', headBranch: 'main', status: 'completed', conclusion: 'success' }
const manifest = () => ({
  version: '0.15.0',
  date: '2026-10-28',
  minMacOS: '13.0',
  files: [
    { arch: 'arm64', name: 'Athena-Studio-mac-arm64.dmg', size: 10, sha256: 'a'.repeat(64) },
    { arch: 'x64', name: 'Athena-Studio-mac-x64.dmg', size: 20, sha256: 'b'.repeat(64) },
  ],
})
const measured = () => [
  { name: 'Athena-Studio-mac-arm64.dmg', exists: true, size: 10, sha256: 'a'.repeat(64) },
  { name: 'Athena-Studio-mac-x64.dmg', exists: true, size: 20, sha256: 'b'.repeat(64) },
  { name: 'Athena-Studio-mac-arm64.zip', exists: true, size: 5, sha512: 'A+/=' },
  { name: 'Athena-Studio-mac-x64.zip', exists: true, size: 6, sha512: 'B+/=' },
]
const feed = () =>
  require('../scripts/release-files').buildUpdaterFeed({
    appVersion: '0.15.0',
    releaseDate: '2026-10-28T12:00:00.000Z',
    files: [
      { arch: 'arm64', size: 5, sha512: 'A+/=' },
      { arch: 'x64', size: 6, sha512: 'B+/=' },
    ],
  })

test('올릴 실행 — release-mac · main · 끝남 · 성공만', () => {
  assert.equal(publish.checkRun(run), null)
  assert.match(publish.checkRun({ ...run, workflowName: 'release' }), /release-mac 실행이 아니다/)
  assert.match(publish.checkRun({ ...run, headBranch: 'feat/x' }), /main/)
  assert.match(publish.checkRun({ ...run, status: 'in_progress' }), /끝나지 않았다/)
  assert.match(publish.checkRun({ ...run, conclusion: 'failure' }), /성공한 실행이 아니다/)
})

test('받은 파일이 latest.json 과 맞으면 통과', () => {
  assert.deepEqual(publish.checkFiles({ manifest: manifest(), notes: '### New\n- x', measured: measured() }), [])
})

test('sha256 · 크기 · 빠진 파일 · 빈 본문 · 모양이 틀리면 하나씩 알린다', () => {
  const files = measured()
  files[0] = { ...files[0], sha256: 'c'.repeat(64) }
  files[1] = { ...files[1], size: 21 }
  files[3] = { name: 'Athena-Studio-mac-x64.zip', exists: false }
  const bad = { ...manifest(), version: '0.15.0+2', date: 'Oct 28', minMacOS: '12.0' }
  const errors = publish.checkFiles({ manifest: bad, notes: '  \n', measured: files })
  for (const pattern of [/arm64\.dmg sha256 이 다르다/, /x64\.dmg 크기가 다르다/, /x64\.zip 가 없다/, /release-notes\.md 가 비었다/, /version/, /date/, /minMacOS/]) {
    assert.ok(errors.some((line) => pattern.test(line)), `${pattern} — ${errors.join(' / ')}`)
  }
  const renamed = manifest()
  renamed.files[1].name = 'Athena-Studio-mac-intel.dmg'
  assert.ok(publish.checkFiles({ manifest: renamed, notes: 'x', measured: measured() }).some((line) => /x64 이름이/.test(line)))
  const missingArch = manifest()
  missingArch.files.pop()
  assert.ok(publish.checkFiles({ manifest: missingArch, notes: 'x', measured: measured() }).some((line) => /x64 가 없다/.test(line)))
})

test('latest-mac.yml — 받은 .zip 과 크기 · sha512 · 이름 · 버전이 맞으면 통과 · 틀리면 하나씩', () => {
  assert.deepEqual(publish.checkFeed({ feed: feed(), appVersion: '0.15.0', measured: measured() }), [])
  const files = measured()
  files[2] = { ...files[2], sha512: 'C+/=' }
  files[3] = { ...files[3], size: 7 }
  const errors = publish.checkFeed({ feed: feed(), appVersion: '0.15.1', measured: files })
  for (const pattern of [/version 이 latest\.json 과 다르다/, /arm64\.zip sha512 가 다르다/, /x64\.zip 크기가 다르다/]) {
    assert.ok(errors.some((line) => pattern.test(line)), `${pattern} — ${errors.join(' / ')}`)
  }
  const renamed = feed()
  renamed.files[1].url = 'Athena-Studio-mac-intel.zip'
  assert.ok(publish.checkFeed({ feed: renamed, appVersion: '0.15.0', measured: measured() }).some((line) => /x64\.zip 가 없다/.test(line)))
  const top = { ...feed(), sha512: 'B+/=' }
  assert.ok(publish.checkFeed({ feed: top, appVersion: '0.15.0', measured: measured() }).some((line) => /맨 위 path/.test(line)))
  assert.deepEqual(publish.checkFeed({ feed: null, appVersion: '0.15.0', measured: measured() }), ['latest-mac.yml 가 객체가 아니다'])
})

test('gh release create 인자 — 공개 레포 · 초안 · 본문 파일 · 파일 6개', () => {
  const args = publish.createArgs({ appVersion: '0.15.0', dir: '/d' })
  assert.deepEqual(args.slice(0, 5), ['release', 'create', 'v0.15.0', '--repo', 'novum-lab-kr/athena-studio-releases'])
  assert.ok(args.includes('--draft'))
  assert.equal(args[args.indexOf('--notes-file') + 1], '/d/release-notes.md')
  assert.deepEqual(args.slice(-6), ['/d/Athena-Studio-mac-arm64.dmg', '/d/Athena-Studio-mac-x64.dmg', '/d/Athena-Studio-mac-arm64.zip', '/d/Athena-Studio-mac-x64.zip', '/d/latest.json', '/d/latest-mac.yml'])
})

test('staple 로 바뀐 .dmg — latest.json 크기 · sha256 을 새 값으로 · 받은 manifest 는 그대로', () => {
  const original = manifest()
  const files = measured()
  files[1] = { ...files[1], size: 25, sha256: 'd'.repeat(64) }
  const { manifest: next, changed } = publish.updateManifest(original, files)
  assert.deepEqual(changed, ['Athena-Studio-mac-x64.dmg'])
  assert.deepEqual(next.files[1], { arch: 'x64', name: 'Athena-Studio-mac-x64.dmg', size: 25, sha256: 'd'.repeat(64) })
  assert.deepEqual(next.files[0], original.files[0])
  assert.equal(original.files[1].size, 20)
  assert.deepEqual(publish.checkFiles({ manifest: next, notes: 'x', measured: files }), [])
  assert.deepEqual(publish.updateManifest(original, measured()).changed, [])
})

test('.zip 안 .app 미staple — staple.json 의 false · 빠진 이름 · 파일 없으면 모름(null)', () => {
  assert.deepEqual(publish.unstapledZips({ 'Athena-Studio-mac-arm64.zip': true, 'Athena-Studio-mac-x64.zip': true }), [])
  assert.deepEqual(publish.unstapledZips({ 'Athena-Studio-mac-arm64.zip': false, 'Athena-Studio-mac-x64.dmg': true }), ['Athena-Studio-mac-arm64.zip', 'Athena-Studio-mac-x64.zip'])
  assert.equal(publish.unstapledZips(null), null)
})
