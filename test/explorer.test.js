const test = require('node:test')
const assert = require('node:assert/strict')
const explorer = require('../src/lib/explorer.mts')

test('정렬: 폴더 먼저 · 이름 대소문자 무시 · .git 빼기', () => {
  const sorted = explorer.sortEntries([
    { name: 'b.md', dir: false },
    { name: '.git', dir: true },
    { name: 'Src', dir: true },
    { name: 'a.md', dir: false },
    { name: 'docs', dir: true },
    { name: '.DS_Store', dir: false },
  ])
  assert.deepEqual(sorted.map((entry) => entry.name), ['docs', 'Src', 'a.md', 'b.md'])
})

test('git status -z: 상태 글자 · 이름 바꾸기 옛 이름 건너뛰기 · 공백 있는 경로', () => {
  const output = [' M src/main.js', '?? new file.txt', 'R  b.js', 'a.js', 'A  added.js', ' D gone.js', 'UU conflict.js', ''].join('\0')
  assert.deepEqual(explorer.parseGitStatus(output), [
    { path: 'src/main.js', code: 'M' },
    { path: 'new file.txt', code: 'U' },
    { path: 'b.js', code: 'R' },
    { path: 'added.js', code: 'A' },
    { path: 'gone.js', code: 'D' },
    { path: 'conflict.js', code: '!' },
  ])
  assert.deepEqual(explorer.parseGitStatus(''), [])
})

test('작업 공간 기준으로: 하위 폴더가 작업 공간이면 그 안 변경만', () => {
  const changes = [
    { path: 'apps/web/src/a.ts', code: 'M' },
    { path: 'apps/admin/b.ts', code: 'M' },
    { path: 'README.md', code: 'M' },
  ]
  assert.deepEqual(explorer.relativeToWorkspace(changes, 'apps/web'), [{ path: 'src/a.ts', code: 'M' }])
  assert.deepEqual(explorer.relativeToWorkspace(changes, 'apps/web/'), [{ path: 'src/a.ts', code: 'M' }])
  assert.equal(explorer.relativeToWorkspace(changes, '').length, 3)
})

test('루트 안 판정 · 상대 경로 검사', () => {
  assert.equal(explorer.isInside('/w/repo', '/w/repo'), true)
  assert.equal(explorer.isInside('/w/repo', '/w/repo/src/a.js'), true)
  assert.equal(explorer.isInside('/w/repo', '/w/repo2/a.js'), false)
  assert.equal(explorer.isInside('/w/repo', '/w/other'), false)
  assert.equal(explorer.isInside('/w/repo', '/etc/passwd'), false)
  assert.equal(explorer.isInside('/w/repo', '/w/repo/..notes'), true)
  assert.equal(explorer.isInside('/w/repo', '/w'), false)
  // 여러 팩 본체 — 작업 공간 + 지금 팩 데이터(plans · issues 링크가 가리키는 곳)만, 그 밖(내 레포 등)은 아니다
  const roots = ['/h/bodies/b1', '/h/data/packs/acme']
  assert.equal(explorer.isInsideAny(roots, '/h/bodies/b1/CLAUDE.md'), true)
  assert.equal(explorer.isInsideAny(roots, '/h/data/packs/acme/plans/a.md'), true)
  assert.equal(explorer.isInsideAny(roots, '/h/data/packs/globex/plans/a.md'), false)
  assert.equal(explorer.isInsideAny(roots, '/Users/me/code/api'), false)
  assert.equal(explorer.cleanRelative(''), '.')
  assert.equal(explorer.cleanRelative('src/../a.js'), 'a.js')
  assert.equal(explorer.cleanRelative('/etc/passwd'), null)
  assert.equal(explorer.cleanRelative('a\0b'), null)
  assert.equal(explorer.cleanRelative(3), '.')
})

test('팩 본체 Explorer — 맨 위는 팩 내용만 · 변경도 팩 내용 쪽만', () => {
  const entries = ['scripts', 'docs', 'CLAUDE.md', 'pack', 'plans', 'issues', 'archive', 'repos', '.worktrees', '.pack-data'].map((name) => ({ name, dir: true }))
  assert.deepEqual(explorer.packBodyEntries(entries).map((entry) => entry.name), ['pack', 'plans', 'issues', 'archive'])
  const changes = [{ path: 'scripts/athena.mjs', code: 'M' }, { path: 'pack/pack.json', code: 'M' }, { path: 'plans/a.md', code: '??' }]
  assert.deepEqual(explorer.packBodyChanges(changes).map((change) => change.path), ['pack/pack.json', 'plans/a.md'])
})

test('바이너리 어림', () => {
  assert.equal(explorer.looksBinary(Buffer.from('hello\nworld')), false)
  assert.equal(explorer.looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x47])), true)
})
