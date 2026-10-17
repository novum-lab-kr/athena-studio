const test = require('node:test')
const assert = require('node:assert/strict')
const viewer = require('../src/lib/viewer')

const known = new Set(['typescript', 'ts', 'javascript', 'js', 'json', 'md', 'markdown', 'yaml', 'shellscript', 'docker', 'make', 'ini', 'dotenv', 'py', 'css'])

test('언어: 확장자 · 이름 통째 · 별칭 · 모르면 text', () => {
  assert.equal(viewer.languageFor('src/main.ts', known), 'ts')
  assert.equal(viewer.languageFor('README.md', known), 'md')
  assert.equal(viewer.languageFor('ci.yml', known), 'yaml')
  assert.equal(viewer.languageFor('run.zsh', known), 'shellscript')
  assert.equal(viewer.languageFor('Dockerfile', known), 'docker')
  assert.equal(viewer.languageFor('.env.local', known), 'dotenv')
  assert.equal(viewer.languageFor('.gitignore', known), 'text')
  assert.equal(viewer.languageFor('weird.xyz', known), 'text')
  assert.equal(viewer.languageFor('Makefile', known), 'make')
})

test('이미지 종류', () => {
  assert.equal(viewer.imageType('logo.PNG'), 'image/png')
  assert.equal(viewer.imageType('icon.svg'), 'image/svg+xml')
  assert.equal(viewer.imageType('main.ts'), null)
})

test('파일 줄: 번호 · 마지막 줄바꿈 · CRLF', () => {
  assert.deepEqual(viewer.fileRows('a\r\nb\n'), [
    { kind: 'context', newNo: 1, code: 'a' },
    { kind: 'context', newNo: 2, code: 'b' },
  ])
  assert.deepEqual(viewer.fileRows(''), [{ kind: 'context', newNo: 1, code: '' }])
})

test('diff 줄: 머리 빼기 · @@ 에서 번호 시작 · 추가·삭제·그대로 번호', () => {
  const diff = ['diff --git a/x.ts b/x.ts', 'index 1..2 100644', '--- a/x.ts', '+++ b/x.ts', '@@ -10,3 +10,3 @@ function f() {', ' keep', '-old', '+new', ' tail', '\\ No newline at end of file', ''].join('\n')
  assert.deepEqual(viewer.diffRows(diff), [
    { kind: 'hunk', code: '@@ -10,3 +10,3 @@ function f() {' },
    { kind: 'context', oldNo: 10, newNo: 10, code: 'keep' },
    { kind: 'del', oldNo: 11, code: 'old' },
    { kind: 'add', newNo: 11, code: 'new' },
    { kind: 'context', oldNo: 12, newNo: 12, code: 'tail' },
    { kind: 'hunk', code: '\\ No newline at end of file' },
  ])
})

test('색칠: 구분 줄을 뺀 코드를 잇고, 토큰을 줄에 돌려 싣는다', () => {
  const rows = [{ kind: 'hunk', code: '@@' }, { kind: 'context', code: 'const a' }, { kind: 'add', code: '' }]
  assert.equal(viewer.codeOf(rows), 'const a\n')
  const tokenLines = [[{ content: 'const', color: '#569CD6', fontStyle: 0 }, { content: ' a', color: '#9CDCFE' }], []]
  assert.deepEqual(viewer.attachTokens(rows, tokenLines), [
    { kind: 'hunk', code: '@@' },
    { kind: 'context', code: 'const a', tokens: [['const', '#569CD6', 0], [' a', '#9CDCFE', 0]] },
    { kind: 'add', code: '', tokens: [] },
  ])
})
