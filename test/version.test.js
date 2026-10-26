// 버전 번호(SemVer 0.x) — 태그 계산 · describe 모양 · Release 본문
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const version = require('../src/lib/version')
const { gitEnv } = require('../src/lib/studio-home')

test('버전: 올리기 — feat · ! 는 가운데, 그 밖은 끝자리(1.0 전)', () => {
  assert.equal(version.bumpKind('feat(update): 앱 업데이트 간소화 (#15)'), 'minor')
  assert.equal(version.bumpKind('feat: 무엇'), 'minor')
  assert.equal(version.bumpKind('fix(tray)!: 알림 바꿈'), 'minor')
  assert.equal(version.bumpKind('fix: 고침'), 'patch')
  assert.equal(version.bumpKind('docs(readme): 한 줄'), 'patch')
  assert.equal(version.bumpKind('Merge pull request #5 from x/y'), 'patch')
  assert.equal(version.bumpKind(''), 'patch')
  assert.equal(version.nextVersion('0.1.0', 'feat: a'), '0.2.0')
  assert.equal(version.nextVersion('0.2.3', 'feat!: a'), '0.3.0')
  assert.equal(version.nextVersion('0.2.3', 'chore: a'), '0.2.4')
})

test('버전: 기준 — 가장 높은 v 태그(이름 순서가 아니라 번호 순) · 없으면 null', () => {
  assert.equal(version.latestTag(['v0.2.0', 'v0.10.0', 'v0.9.1']), '0.10.0')
  assert.equal(version.latestTag(['v0.2.0', 'vnext', 'x1.0.0', 'v1.0']), '0.2.0')
  assert.equal(version.latestTag([]), null)
  assert.equal(version.compareVersions('0.10.0', '0.9.9') > 0, true)
  assert.equal(version.parseVersion('v1.2.3').join('.'), '1.2.3')
  assert.equal(version.parseVersion('1.2'), null)
})

test('버전: describe 모양 — 태그 커밋 0.2.1 · 그 뒤 3개 0.2.1+3 · 아니면 null', () => {
  assert.equal(version.formatDescribe('v0.2.1-0-gabc1234\n'), '0.2.1')
  assert.equal(version.formatDescribe('v0.2.1-3-gabc1234'), '0.2.1+3')
  assert.equal(version.formatDescribe('abc1234'), null)
  assert.equal(version.formatDescribe(''), null)
  assert.deepEqual(version.splitDisplay('0.2.1+3'), { tag: '0.2.1', distance: 3 })
  assert.deepEqual(version.splitDisplay('0.2.1'), { tag: '0.2.1', distance: 0 })
  assert.equal(version.splitDisplay('x'), null)
  assert.equal(version.DISPLAY_RE.test('0.2.1+3'), true)
})

test('버전: Release 본문 — PR 제목 · 번호 · 링크(제목에 번호가 이미 있으면 한 번만)', () => {
  assert.equal(version.releaseNotes({ title: 'feat: a', number: 7, url: 'https://x/pull/7' }), 'feat: a (#7)\n\nhttps://x/pull/7\n')
  assert.equal(version.releaseNotes({ title: 'feat: a (#7)', number: 7, url: 'https://x/pull/7' }), 'feat: a (#7)\n\nhttps://x/pull/7\n')
  assert.equal(version.releaseNotes({ title: 'fix: b' }), 'fix: b\n')
})

test('버전: describeVersion — 임시 저장소의 태그로 · 태그가 없으면 null', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'version-test-')))
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'first')
  assert.equal(version.describeVersion({ repoRoot: dir, env }), null)
  git('tag', 'v0.2.0')
  assert.equal(version.describeVersion({ repoRoot: dir, env }), '0.2.0')
  git('commit', '-q', '--allow-empty', '-m', 'second')
  assert.equal(version.describeVersion({ repoRoot: dir, env }), '0.2.0+1')
  assert.equal(version.describeVersion({ repoRoot: path.join(dir, 'missing'), env }), null)
})
