// 입력칸 끝 판정 글이 앱 · 코어에서 같은지 — 앱 src/lib/pane-submit.mts 는 코어 athena/scripts/lib/input-box.json 을 읽지 않고 같은 글을 따로 둔다
// (앱은 설치된 코어 판과 따로 움직인다). 한쪽만 고치면 붙여 넣기 확인과 현황판 pane 닫기 · 리드 새로 시작의 초안 판정이 갈린다
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const box = JSON.parse(fs.readFileSync(path.join(root, 'athena/scripts/lib/input-box.json'), 'utf8'))

/** 소스에서 `const <이름> = /…/` 정규식 글자를 찾는다 */
const regexIn = (file, name) => {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const found = source.match(new RegExp(`^const ${name} = /(.+)/$`, 'm'))
  assert.ok(found, `${file} 에서 ${name} 를 찾지 못했다`)
  return found[1]
}

test('pane-submit.mts Codex 경계 글이 input-box.json 과 같다', () => {
  assert.strictEqual(regexIn('src/lib/pane-submit.mts', 'CODEX_SHORTCUTS'), box.codexShortcuts)
  assert.strictEqual(regexIn('src/lib/pane-submit.mts', 'CODEX_STATUS'), box.codexStatus)
})

test('core.mts 상태줄 글이 input-box.json 과 같다', () => {
  assert.strictEqual(regexIn('src/lib/core.mts', 'CODEX_STATUS'), box.codexStatus)
})
