// 소개 사이트 릴리스 페이지 '바뀐 점' 줄 — docs/site-release-notes.json 형식 검사
// 공개 뒤 novum-web 맞추기(deploy/sync-athena-release.mjs)가 공개판 태그 ↔ 새 태그의 이 파일을 비교해 새 줄(en 기준)만 붙인다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const notes = require('../src/lib/release-notes.mts')

const ROOT = path.join(__dirname, '..')
const SITE_NOTES = path.join(ROOT, 'docs', 'site-release-notes.json')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const TAGS = ['new', 'improved', 'fixed', 'security']
const LANGS = ['en', 'ko', 'ja', 'zh']
// 사이트 맞추기가 한 글에 받는 길이 상한(novum-web validateNotes MAX_TEXT_LENGTH)
const MAX_TEXT_LENGTH = 500

const readSiteNotes = () => JSON.parse(fs.readFileSync(SITE_NOTES, 'utf8'))
const minorText = (/** @type {[number, number]} */ minor) => minor.join('.')

test('site-release-notes.json: minor 마다 줄 배열 · 태그 · 4개 언어 한 줄 글', () => {
  const data = readSiteNotes()
  assert.equal(typeof data, 'object')
  assert.ok(data && !Array.isArray(data), '맨 위는 { "<minor>": [...] } 객체')
  for (const [minor, items] of Object.entries(data)) {
    assert.match(minor, /^\d+\.\d+$/, `${minor} — 키는 minor(예 0.52) · 패치 번호는 적지 않는다`)
    assert.ok(Array.isArray(items) && items.length > 0, `${minor} 에 줄이 없다`)
    const seen = new Set()
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ['tag', ...LANGS].sort(), `${minor} 줄의 칸은 tag · en · ko · ja · zh`)
      assert.ok(TAGS.includes(item.tag), `${minor} 의 태그 ${item.tag} — ${TAGS.join(' · ')} 중 하나`)
      for (const lang of LANGS) {
        const text = item[lang]
        assert.equal(typeof text, 'string', `${minor} 줄에 ${lang} 글이 없다`)
        assert.ok(text.trim(), `${minor} 줄의 ${lang} 글이 비었다`)
        assert.equal(text, text.trim(), `${minor} 줄의 ${lang} 글 앞뒤에 공백이 있다`)
        assert.doesNotMatch(text, /[\r\n]/, `${minor} 줄의 ${lang} 글에 줄바꿈이 있다`)
        assert.ok(text.length <= MAX_TEXT_LENGTH, `${minor} 줄의 ${lang} 글이 ${MAX_TEXT_LENGTH}자를 넘는다`)
      }
      // 새 줄은 en 으로 가른다 — 같은 minor 안에서 겹치면 안 된다
      assert.ok(!seen.has(item.en), `${minor} 에 같은 en 줄이 두 번: ${item.en}`)
      seen.add(item.en)
    }
  }
})

test('site-release-notes.json: 줄은 CHANGELOG 의 같은 minor 줄과 앱 번역 그대로', () => {
  // 앱 · 사이트가 같은 개조식 한 줄을 쓴다 — 말투 · 길이 검사는 test/release-notes.test.js(docs/development.md "배포판 (맥)")
  const data = readSiteNotes()
  const sections = notes.parseChangelog(fs.readFileSync(CHANGELOG, 'utf8'))
  const tables = Object.fromEntries(['ko', 'ja', 'zh'].map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'changelog', `${lang}.json`), 'utf8'))]))
  for (const [minor, items] of Object.entries(data)) {
    const english = sections.filter((section) => minorText(section.minor) === minor).flatMap((section) => section.notes.map((note) => note.text))
    for (const item of items) {
      assert.ok(english.includes(item.en), `${minor} 줄의 en 이 CHANGELOG ## ${minor} 절에 없다: ${item.en}`)
      for (const lang of ['ko', 'ja', 'zh']) assert.equal(item[lang], tables[lang][item.en], `${minor} 줄의 ${lang} 글이 src/changelog/${lang}.json 번역과 다르다: ${item.en}`)
    }
  }
})

test('site-release-notes.json: 키마다 CHANGELOG 에 그 minor 절이 있고 최신 절의 줄도 있다', () => {
  const data = readSiteNotes()
  const sections = notes.parseChangelog(fs.readFileSync(CHANGELOG, 'utf8'))
  const minors = new Set(sections.map((section) => minorText(section.minor)))
  for (const minor of Object.keys(data)) assert.ok(minors.has(minor), `CHANGELOG.md 에 ## ${minor} 절이 없다`)
  // CHANGELOG 최신 절을 쓸 때 사이트 줄도 같이 쓴다(docs/development.md "배포판 (맥)")
  const latest = sections[0]
  assert.ok(latest, 'CHANGELOG.md 에 절이 없다')
  const latestMinor = minorText(latest.minor)
  assert.ok(data[latestMinor], `CHANGELOG 최신 절 ${latestMinor} 의 사이트 줄이 docs/site-release-notes.json 에 없다`)
})
