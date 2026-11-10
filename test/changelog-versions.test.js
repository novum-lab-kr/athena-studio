// CHANGELOG.md 줄마다 판 번호(scripts/changelog-versions.js) — 그 줄을 처음 넣은 main 커밋의 태그
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const versions = require('../scripts/changelog-versions')
const { tempDir } = require('./temp-dirs')

const MARK = versions.COMMIT_MARK
const block = (sha, ...added) => `${MARK}${sha}\n\ndiff --git a/CHANGELOG.md b/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@ -1 +1 @@\n${added.map((line) => `+- ${line}`).join('\n')}\n-- removed\n`

test('versionsFromLog: 처음 넣은 커밋의 태그 · 태그 없는 커밋은 다음 태그 · 그 뒤 태그가 없으면 번호 없음 · 다시 들어와도 처음 번호', () => {
  const tags = { aaa: '0.60.15', ccc: '0.60.18' }
  const log = [block('aaa', 'One'), block('bbb', 'Two'), block('ccc', 'Three', 'One'), block('ddd', 'Four')].join('')
  assert.deepEqual(versions.versionsFromLog(log, (sha) => tags[sha] || null), { One: '0.60.15', Two: '0.60.18', Three: '0.60.18' })
  assert.deepEqual(versions.versionsFromLog('', () => null), {})
})

test('changelogVersions: 진짜 git — first-parent 커밋마다 태그 · 주석 태그도', () => {
  const dir = tempDir('changelog-versions-')
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const write = (lines) => fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n## 0.60 (v0.60.0 – · Nov 8, 2026)\n\n### Fixed\n${lines.map((line) => `- ${line}`).join('\n')}\n`)
  git('init', '-q', '-b', 'main')
  write(['Old'])
  git('add', '.')
  git('commit', '-qm', 'first')
  git('tag', 'v0.60.0')
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x')
  git('add', '.')
  git('commit', '-qm', 'no changelog')
  git('tag', 'v0.60.1')
  write(['Old', 'Fix2'])
  git('commit', '-qam', 'fix 2')
  git('tag', '-a', 'v0.60.2', '-m', 'v0.60.2')
  write(['Old', 'Fix2', 'Unreleased'])
  git('commit', '-qam', 'not tagged')
  assert.deepEqual(versions.changelogVersions({ repoRoot: dir }), { Old: '0.60.0', Fix2: '0.60.2' })
  const out = path.join(dir, 'dist', versions.FILE_NAME)
  assert.equal(versions.writeChangelogVersions({ repoRoot: dir, out }), 2)
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { Old: '0.60.0', Fix2: '0.60.2' })
})
