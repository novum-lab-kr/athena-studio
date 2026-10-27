const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const i18n = require('../src/lib/i18n.mts')

const I18N_DIR = path.join(__dirname, '..', 'src', 'i18n')
const dictionaries = Object.fromEntries(
  i18n.LANGUAGES.map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8'))]),
)

test('사전: 네 언어 파일이 다 있고 폴더에 다른 언어 파일이 없다', () => {
  const files = fs.readdirSync(I18N_DIR).filter((name) => name.endsWith('.json')).sort()
  assert.deepEqual(files, i18n.LANGUAGES.map((lang) => `${lang}.json`).sort())
})

test('사전: 네 언어의 키가 한국어와 같다(빠진 키 · 남는 키 없음)', () => {
  for (const lang of i18n.LANGUAGES) {
    const diff = i18n.keyDiff(dictionaries.ko, dictionaries[lang])
    assert.deepEqual(diff, { missing: [], extra: [] }, `${lang}.json`)
  }
})

test('사전: 값은 빈 글이 아닌 문자열이고, 자리({이름})는 한국어와 같다', () => {
  for (const lang of i18n.LANGUAGES) {
    for (const [key, text] of Object.entries(dictionaries[lang])) {
      assert.equal(typeof text, 'string', `${lang} ${key}`)
      assert.ok(text.trim().length > 0, `${lang} ${key} 가 비었다`)
      assert.deepEqual(i18n.placeholders(text), i18n.placeholders(dictionaries.ko[key]), `${lang} ${key} 자리`)
    }
  }
})

test('사전: 일본어 · 중국어는 검수 전 표시, 한국어 · 영어는 검수됨', () => {
  assert.equal(dictionaries.ko['meta.status'], 'reviewed')
  assert.equal(dictionaries.en['meta.status'], 'reviewed')
  assert.equal(dictionaries.ja['meta.status'], 'draft')
  assert.equal(dictionaries.zh['meta.status'], 'draft')
  assert.deepEqual(
    i18n.LANGUAGES.map((lang) => dictionaries[lang]['meta.name']),
    ['한국어', 'English', '日本語', '中文'],
  )
})

test('t: 자리를 채우고, 없는 값의 자리는 그대로 둔다', () => {
  const dictionary = { 'time.minutesAgo': '{n}분 전', 'pair': '{from}~{to}' }
  assert.equal(i18n.t(dictionary, 'time.minutesAgo', { n: 3 }), '3분 전')
  assert.equal(i18n.t(dictionary, 'pair', { from: 1 }), '1~{to}')
  assert.equal(i18n.t(dictionary, 'pair'), '{from}~{to}')
  assert.equal(i18n.t(dictionary, 'pair', { from: 0, to: null }), '0~')
  // 값 안의 $ 를 바꾸기 패턴으로 읽지 않는다
  assert.equal(i18n.t(dictionary, 'time.minutesAgo', { n: '$&' }), '$&분 전')
})

test('t: 없는 키는 한국어 사전 → 키 이름 순으로 대신한다', () => {
  const english = { 'menu.file': 'File' }
  const korean = { 'menu.file': '파일', 'menu.edit': '편집', 'tab.default': '탭 {n}' }
  assert.equal(i18n.t(english, 'menu.file', null, korean), 'File')
  assert.equal(i18n.t(english, 'menu.edit', null, korean), '편집')
  assert.equal(i18n.t(english, 'tab.default', { n: 2 }, korean), '탭 2')
  assert.equal(i18n.t(english, 'menu.nothing', null, korean), 'menu.nothing')
  assert.equal(i18n.t(null, 'menu.file', null, korean), '파일')
  assert.equal(i18n.t(undefined, 'menu.file'), 'menu.file')
  // 문자열이 아닌 값은 없는 키로 본다
  assert.equal(i18n.t({ 'menu.file': 3 }, 'menu.file', null, korean), '파일')
})

test('translator: 사전 하나에 묶어 쓴다 · 실제 사전으로도 같다', () => {
  const say = i18n.translator(dictionaries.en, dictionaries.ko)
  assert.equal(say('menu.file'), 'File')
  assert.equal(say('dialog.closePane.message', { agent: 'claude' }), 'claude is running in this pane. Close it?')
  assert.equal(say('no.such.key'), 'no.such.key')
})

test('pickLanguage: 설정 → 시스템 언어 → 영어', () => {
  assert.equal(i18n.pickLanguage('ja', 'ko-KR'), 'ja')
  assert.equal(i18n.pickLanguage(undefined, 'ko-KR'), 'ko')
  assert.equal(i18n.pickLanguage(null, 'zh-CN'), 'zh')
  assert.equal(i18n.pickLanguage('', 'zh_Hans_CN'), 'zh')
  assert.equal(i18n.pickLanguage(undefined, 'JA'), 'ja')
  assert.equal(i18n.pickLanguage(undefined, 'en-US'), 'en')
  // 네 언어 밖이면 영어 — 설정이 이상해도 시스템 언어를 본다
  assert.equal(i18n.pickLanguage(undefined, 'fr-FR'), 'en')
  assert.equal(i18n.pickLanguage('de', 'ko'), 'ko')
  assert.equal(i18n.pickLanguage('de', 'fr'), 'en')
  assert.equal(i18n.pickLanguage(undefined, undefined), 'en')
  assert.equal(i18n.pickLanguage(42, ''), 'en')
})
