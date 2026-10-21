const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const agentLanguage = require('../src/lib/agent-language')

test('앱 언어 네 개 모두 Claude Code language 값으로', () => {
  assert.deepEqual(Object.keys(agentLanguage.AGENT_LANGUAGES).sort(), ['en', 'ja', 'ko', 'zh'])
  assert.equal(agentLanguage.AGENT_LANGUAGES.ko, 'korean')
})

test('파일이 없거나 비었으면 language 만 담아 새로', () => {
  assert.deepEqual(JSON.parse(agentLanguage.withLanguage(null, 'en')), { language: 'english' })
  assert.deepEqual(JSON.parse(agentLanguage.withLanguage('  \n', 'ja')), { language: 'japanese' })
})

test('다른 설정은 그대로 두고 language 만 바꾼다', () => {
  const before = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, language: 'korean' })
  assert.deepEqual(JSON.parse(agentLanguage.withLanguage(before, 'zh')), { permissions: { allow: ['Bash(ls)'] }, language: 'chinese' })
})

test('이미 같은 값 · 모르는 언어 · 깨진 파일 · 객체가 아닌 JSON 이면 쓰지 않는다', () => {
  assert.equal(agentLanguage.withLanguage('{"language":"korean"}', 'ko'), null)
  assert.equal(agentLanguage.withLanguage(null, 'fr'), null)
  assert.equal(agentLanguage.withLanguage('{ "permissions": ', 'en'), null)
  assert.equal(agentLanguage.withLanguage('[]', 'en'), null)
  assert.equal(agentLanguage.withLanguage('null', 'en'), null)
})

test('설정 파일 자리는 본체 .claude/settings.local.json', () => {
  assert.equal(agentLanguage.settingsFile('/x/body'), path.join('/x/body', '.claude', 'settings.local.json'))
})
