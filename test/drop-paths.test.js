const test = require('node:test')
const assert = require('node:assert/strict')
const { shellEscapePath, dropText } = require('../src/lib/drop-paths.mts')

test('평범한 경로는 그대로', () => {
  assert.equal(shellEscapePath('/Users/me/a-b_c.d/x+y=1@2,3%4:5'), '/Users/me/a-b_c.d/x+y=1@2,3%4:5')
})

test('공백 · 따옴표 · 셸 특수 문자 앞에 역슬래시(맥 터미널처럼)', () => {
  assert.equal(shellEscapePath('/tmp/my file.png'), '/tmp/my\\ file.png')
  assert.equal(shellEscapePath(`/tmp/it's "q".txt`), `/tmp/it\\'s\\ \\"q\\".txt`)
  assert.equal(shellEscapePath('/tmp/$HOME!(1)&*?[a]{b};|<>`~#^\\'), '/tmp/\\$HOME\\!\\(1\\)\\&\\*\\?\\[a\\]\\{b\\}\\;\\|\\<\\>\\`\\~\\#\\^\\\\')
})

test('한글 등 ASCII 밖 글자는 그대로', () => {
  assert.equal(shellEscapePath('/Users/me/스크린샷 2026.png'), '/Users/me/스크린샷\\ 2026.png')
})

test('제어 문자가 든 경로는 $\'…\' 로', () => {
  assert.equal(shellEscapePath("/tmp/a\nb'c\\d"), "$'/tmp/a\\x0ab\\'c\\\\d'")
})

test('여러 개는 공백으로 잇고 끝에 공백 하나 · 빈 경로는 뺀다', () => {
  assert.equal(dropText(['/a b', '', '/c']), '/a\\ b /c ')
  assert.equal(dropText([]), '')
  assert.equal(dropText(['']), '')
})
