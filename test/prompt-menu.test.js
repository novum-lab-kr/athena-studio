// 선택 창 판정 글이 앱 · 코어에서 같은지 — 앱 src/lib/core.mts PROMPT_MENU 는 코어 athena/scripts/lib/prompt-menu.json 을 읽지 않고 같은 글을 따로 둔다
// (앱은 설치된 코어 판과 따로 움직인다). 한쪽만 고치면 [작업] 답 넣기와 현황판 · 훅의 창 판정이 갈린다
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

test('core.mts PROMPT_MENU 와 prompt-menu.json pattern 이 같다', () => {
  const root = path.join(__dirname, '..')
  const menu = JSON.parse(fs.readFileSync(path.join(root, 'athena/scripts/lib/prompt-menu.json'), 'utf8'))
  const source = fs.readFileSync(path.join(root, 'src/lib/core.mts'), 'utf8')
  const found = source.match(/^const PROMPT_MENU = \/(.+)\/i$/m)
  assert.ok(found, 'core.mts 에서 PROMPT_MENU 를 찾지 못했다')
  // 정규식 글자 그대로 비교 — 앱은 / 를 \/ 로 쓴다
  assert.strictEqual(found[1].replace(/\\\//g, '/'), menu.pattern)
})
