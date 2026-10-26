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

test('버전: releasePlan — 커밋마다 차례로(앞 버전이 다음 기준) · feat 는 몰려도 가운데를 올린다', () => {
  const plan = version.releasePlan('0.2.0', [{ sha: 'a', title: 'fix: 1' }, { sha: 'b', title: 'feat: 2' }, { sha: 'c', title: 'docs: 3' }])
  assert.deepEqual(plan.map((entry) => [entry.sha, entry.version, entry.kind]), [['a', '0.2.1', 'patch'], ['b', '0.3.0', 'minor'], ['c', '0.3.1', 'patch']])
  assert.deepEqual(version.releasePlan('0.2.0', []), [])
})

// 릴리스 스크립트 --dry-run — 임시 main 에 머지가 몰려(앞 실행이 취소돼) 태그 없는 커밋이 여럿이어도 오래된 순으로 모두 · 태그가 없으면 그 커밋 하나만
test('버전: release-version.js --dry-run — 빠진 머지를 차례로 채우고 · 태그 있는 커밋은 건너뛴다', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-')))
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
  delete env.GITHUB_REPOSITORY
  delete env.GITHUB_SHA
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim()
  const script = path.join(__dirname, '..', 'scripts', 'release-version.js')
  const dry = () => execFileSync(process.execPath, [script, '--dry-run'], { cwd: dir, env, encoding: 'utf8' }).trim().split('\n')
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'chore: 옛 기록')
  git('commit', '-q', '--allow-empty', '-m', 'feat: 첫 버전 (#1)')
  // 태그가 하나도 없으면 package.json 값에서 그 커밋 하나만
  const first = dry()
  assert.equal(first.length, 1)
  assert.match(first[0], /^v0\.1\.0 → v0\.2\.0 \(minor\) · \w{7} · feat: 첫 버전/)
  git('tag', 'v0.2.0')
  // 몰린 머지 셋 — 가운데 feat 도 가운데를 올린다
  git('commit', '-q', '--allow-empty', '-m', 'fix: 하나 (#2)')
  git('commit', '-q', '--allow-empty', '-m', 'feat: 둘 (#3)')
  git('commit', '-q', '--allow-empty', '-m', 'docs: 셋 (#4)')
  const many = dry()
  assert.deepEqual(many.map((line) => line.split(' · ')[0]), ['v0.2.0 → v0.2.1 (patch)', 'v0.2.1 → v0.3.0 (minor)', 'v0.3.0 → v0.3.1 (patch)'])
  // 앞 실행이 첫 커밋만 처리했으면 나머지만
  git('tag', 'v0.2.1', 'HEAD~2')
  assert.deepEqual(dry().map((line) => line.split(' · ')[0]), ['v0.2.1 → v0.3.0 (minor)', 'v0.3.0 → v0.3.1 (patch)'])
  // 그 커밋에 이미 태그 — 아무것도
  git('tag', 'v0.3.1')
  assert.match(dry()[0], /^이미 태그가 있어요 — v0\.3\.1/)
})

test('버전: fetchTags — origin 의 v 태그를 받고 · origin 이 없으면 false', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-tags-test-')))
  test.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: 'ignore' })
  const origin = path.join(root, 'origin')
  git(root, 'init', '-q', '-b', 'main', origin)
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'first')
  git(root, 'clone', '-q', '--no-tags', origin, 'app')
  const app = path.join(root, 'app')
  git(origin, 'tag', 'v0.2.0')
  assert.equal(version.describeVersion({ repoRoot: app, env }), null)
  assert.equal(version.fetchTags({ repoRoot: app, env }), true)
  assert.equal(version.describeVersion({ repoRoot: app, env }), '0.2.0')
  git(app, 'remote', 'remove', 'origin')
  assert.equal(version.fetchTags({ repoRoot: app, env }), false)
})
