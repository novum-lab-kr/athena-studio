// 맥 배포판을 만들지 정하기(scripts/release-changed.js) — git · gh 없이 판정만 본다
const test = require('node:test')
const assert = require('node:assert/strict')
const { isOutsideApp, decide } = require('../scripts/release-changed')

const base = { next: '0.51.39', published: '0.51.38', baseKnown: true }

test('앱 밖 — 시험 · 뿌리 docs · README · .github · CHANGELOG 만', () => {
  for (const file of ['test/a.test.js', 'athena/test/x.sh', 'docs/development.md', 'README.md', 'README.ko.md', '.github/workflows/release.yml', 'CHANGELOG.md']) {
    assert.equal(isOutsideApp(file), true, file)
  }
  for (const file of ['src/main.mts', 'scripts/package-mac.js', 'package.json', 'athena/docs/pr-auto.md', 'athena/AGENTS.md', 'athena/scripts/ship.sh', 'src/docs/x.md', 'docs.md', 'build/entitlements.mac.plist']) {
    assert.equal(isOutsideApp(file), false, file)
  }
})

test('앱 밖 — 번들(scripts/package-mac.js FILES · extraResources · 코어 번들 athena/)에 안 들어가는 뿌리 문서 · 배포 · 개발 스크립트', () => {
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'SECURITY.md', 'LICENSE', 'scripts/release-changed.js', 'scripts/release-version.js', 'scripts/release-files.js', 'scripts/publish-release.js', 'scripts/dev-app.js', 'scripts/fake-pack.js', 'scripts/check-ts.js', 'scripts/worktree-setup.sh']) {
    assert.equal(isOutsideApp(file), true, file)
  }
  // 배포판 만드는 결과를 바꾸는 스크립트 · 화면 빌드 설정 · 의존성은 앱 안
  for (const file of ['scripts/third-party-notices.js', 'scripts/notarize-mac.js', 'scripts/fix-spawn-helper.js', 'vite.config.mts', 'package-lock.json', 'athena/CLAUDE.md', 'src/AGENTS.md', 'scripts/new.js']) {
    assert.equal(isOutsideApp(file), false, file)
  }
  // 319ee97 처럼 뿌리 AGENTS.md 만 바뀐 판은 건너뛴다
  assert.equal(decide({ ...base, files: ['AGENTS.md', 'docs/development.md'] }).build, false)
})

test('문서만 · 시험만 바뀐 판은 건너뛴다', () => {
  assert.equal(decide({ ...base, files: ['docs/development.md', 'README.md', 'CHANGELOG.md'] }).build, false)
  assert.equal(decide({ ...base, files: ['test/a.test.js', 'athena/test/b.sh', '.github/workflows/x.yml'] }).build, false)
  assert.equal(decide({ ...base, files: [] }).build, false)
})

test('athena/ 안 문서 · src 가 섞이면 만든다', () => {
  assert.equal(decide({ ...base, files: ['athena/docs/pr-auto.md'] }).build, true)
  const mixed = decide({ ...base, files: ['docs/development.md', 'src/main.mts'] })
  assert.equal(mixed.build, true)
  assert.match(mixed.reason, /src\/main\.mts/)
})

test('공개판이 없거나 · 공개판 태그를 모르면 만든다 · 공개판보다 높지 않으면 건너뛴다', () => {
  assert.equal(decide({ ...base, published: null, files: [] }).build, true)
  assert.equal(decide({ ...base, baseKnown: false, files: [] }).build, true)
  assert.equal(decide({ ...base, next: '0.51.38', files: ['src/main.mts'] }).build, false)
  assert.match(decide({ ...base, next: '0.51.37', files: ['src/main.mts'] }).reason, /높지 않다/)
  assert.equal(decide({ ...base, next: null, files: [] }).build, false)
})
