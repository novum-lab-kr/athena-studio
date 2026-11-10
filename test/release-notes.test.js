// 코어 업데이트 팝업의 업데이트 내역 — CHANGELOG.md 에서 이전 → 새 버전 사이의 줄 고르기 · 번역 파일 짝
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const notes = require('../src/lib/release-notes.mts')

const ROOT = path.join(__dirname, '..')
const SAMPLE = `# Changelog

## 0.28 (v0.26.0 – · Oct 29, 2026)

### New
- N28

### Fixed
- F28a
- F28b

## 0.25 (v0.20.0 – v0.25.1 · Oct 29, 2026)

### New
- N25

### Improved
- I25

## 0.19 (v0.19.0 – v0.19.2 · Oct 29, 2026)

### New
- N19
`

test('parseChangelog: 절 번호 · 종류별 줄', () => {
  const sections = notes.parseChangelog(SAMPLE)
  assert.deepEqual(sections.map((section) => section.minor), [[0, 28], [0, 25], [0, 19]])
  assert.deepEqual(sections[0].notes, [{ kind: 'new', text: 'N28' }, { kind: 'fixed', text: 'F28a' }, { kind: 'fixed', text: 'F28b' }])
})

test('notesBetween: 이전 minor 보다 크고 새 minor 이하와 겹치는 절을 최신 먼저 합친다', () => {
  const sections = notes.parseChangelog(SAMPLE)
  const texts = (from, to) => notes.notesBetween(sections, from, to).map((note) => note.text)
  assert.deepEqual(texts('0.25.1', '0.28.3'), ['N28', 'F28a', 'F28b'])
  assert.deepEqual(texts('0.19.2', '0.28.0+2'), ['N28', 'F28a', 'F28b', 'N25', 'I25'])
  // 0.28 절은 v0.26.0 부터 — 새 버전이 0.26 이어도 그 절이다
  assert.deepEqual(texts('0.25.1', '0.26.0'), ['N28', 'F28a', 'F28b'])
  assert.deepEqual(texts('0.20.0', '0.25.1'), ['N25', 'I25'])
  assert.deepEqual(texts('0.25.0', '0.25.0+3'), []) // 끝자리가 같으면 없다
  assert.deepEqual(texts('0.19.0', '0.25.1'), ['N25', 'I25'])
})

test('notesBetween: 끝자리만 오른 업데이트는 새 버전 minor 를 덮는 절 하나 · isPatchOnly', () => {
  const sections = notes.parseChangelog(SAMPLE)
  const texts = (from, to) => notes.notesBetween(sections, from, to).map((note) => note.text)
  assert.deepEqual(texts('0.28.1', '0.28.4'), ['N28', 'F28a', 'F28b'])
  assert.deepEqual(texts('0.26.0', '0.26.3+2'), ['N28', 'F28a', 'F28b'])
  assert.deepEqual(texts('0.25.0', '0.25.1'), ['N25', 'I25'])
  assert.deepEqual(texts('0.22.1', '0.22.2'), ['N25', 'I25'])
  assert.equal(notes.isPatchOnly('0.40.0', '0.40.3'), true)
  assert.equal(notes.isPatchOnly('0.40.3', '0.40.3+2'), false)
  assert.equal(notes.isPatchOnly('0.40.3', '0.40.0'), false)
  assert.equal(notes.isPatchOnly('0.39.9', '0.40.0'), false)
  assert.equal(notes.isPatchOnly(null, '0.40.1'), false)
})

test('notesBetween: 버전을 모르거나 minor 가 오르지 않으면 빈 목록', () => {
  const sections = notes.parseChangelog(SAMPLE)
  assert.deepEqual(notes.notesBetween(sections, null, '0.28.0'), [])
  assert.deepEqual(notes.notesBetween(sections, '0.25.1', null), [])
  assert.deepEqual(notes.notesBetween(sections, '0.28.4', '0.28.1'), []) // 내려감
  assert.deepEqual(notes.notesBetween(sections, '0.28.4', '0.28.4'), [])
  assert.deepEqual(notes.notesBetween(sections, '0.28.4', '0.25.1'), [])
  assert.deepEqual(notes.notesBetween(sections, 'abc', '0.28.0'), [])
})

test('pickNotes: 새 기능 → 개선 → 수정 차례로 3개 + 나머지 개수', () => {
  const list = [
    { kind: 'fixed', text: 'f1' },
    { kind: 'new', text: 'n1' },
    { kind: 'fixed', text: 'f2' },
    { kind: 'improved', text: 'i1' },
    { kind: 'new', text: 'n2' },
    { kind: 'fixed', text: 'f3' },
  ]
  const picked = notes.pickNotes(list, (text) => text.toUpperCase())
  assert.deepEqual(picked.shown.map((note) => note.text), ['N1', 'N2', 'I1'])
  assert.deepEqual(picked.rest, { count: 3, kinds: [{ kind: 'fixed', count: 3 }] })
  assert.equal(notes.pickNotes([], (text) => text), null)
  assert.equal(notes.pickNotes(list.slice(0, 2), (text) => text).rest, null)
})

test('translateNote: 번역이 없으면 영어 그대로', () => {
  assert.equal(notes.translateNote({ a: '가' })('a'), '가')
  assert.equal(notes.translateNote({ a: '가' })('b'), 'b')
  assert.equal(notes.translateNote(null)('b'), 'b')
})

test('CHANGELOG.md 의 모든 줄에 한국어 · 일본어 · 중국어 번역이 있고 남는 번역이 없다', () => {
  const english = notes.parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')).flatMap((section) => section.notes.map((note) => note.text))
  assert.ok(english.length > 0)
  for (const lang of ['ko', 'ja', 'zh']) {
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'changelog', `${lang}.json`), 'utf8'))
    assert.deepEqual(english.filter((text) => !map[text]), [], `${lang}: 번역이 빠진 줄`)
    assert.deepEqual(Object.keys(map).filter((text) => !english.includes(text)), [], `${lang}: CHANGELOG 에 없는 번역`)
  }
})

test('CHANGELOG.md · src/changelog: 줄은 개조식 한 줄 — 문장 끝맺음 · 끝 마침표 없이 짧게', () => {
  // 앱 업데이트 팝업 · Release 본문 · 사이트 줄(docs/site-release-notes.json)이 같은 줄을 쓴다(docs/development.md "배포판 (맥)")
  // 길이 상한은 2026-11-08 개조식으로 줄일 때의 최대(en 96 · 번역 54)에 여유를 둔 값 — 넘으면 세부를 덜어 낸다
  const english = notes.parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')).flatMap((section) => section.notes.map((note) => note.text))
  for (const text of english) {
    assert.doesNotMatch(text, /\.$/, `en 줄 끝에 마침표 — 개조식으로: ${text}`)
    assert.ok(text.length <= 100, `en 줄이 100자를 넘는다 — 핵심만: ${text}`)
  }
  const ending = { ko: /(다|요)\.?$|\.$/, ja: /[。.]$/, zh: /[。.]$/ }
  for (const lang of ['ko', 'ja', 'zh']) {
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'changelog', `${lang}.json`), 'utf8'))
    for (const [text, translated] of Object.entries(map)) {
      assert.doesNotMatch(translated, ending[lang], `${lang} 번역이 문장으로 끝난다 — 명사형으로: ${translated} (${text})`)
      assert.ok(translated.length <= 60, `${lang} 번역이 60자를 넘는다 — 핵심만: ${translated}`)
    }
  }
})

test('CHANGELOG.md: 공개 배포판 0.28.7 → 0.32 는 0.32 절 줄만 고른다(0.28 절은 안 나온다)', () => {
  const sections = notes.parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'))
  const section032 = sections.find((section) => section.minor[0] === 0 && section.minor[1] === 32)
  assert.ok(section032 && section032.notes.length > 0)
  assert.deepEqual(notes.notesBetween(sections, '0.28.7', '0.32.0'), section032.notes)
  const picked = notes.pickNotes(notes.notesBetween(sections, '0.28.7', '0.32.0'), (text) => text)
  assert.equal(picked.shown.length, notes.NOTE_LIMIT)
  assert.equal(picked.rest.count, section032.notes.length - notes.NOTE_LIMIT)
})

test('withTranslations · noteText: 언어별 번역을 싣고 지금 언어로 고른다(없으면 영어)', () => {
  const picked = notes.pickNotes([{ kind: 'new', text: 'A' }, { kind: 'fixed', text: 'B' }], (text) => text)
  const withTexts = notes.withTranslations(picked, { ko: { A: '가' }, ja: { A: 'か', B: 'び' }, zh: null })
  const [first, second] = withTexts.shown
  assert.equal(first.text, 'A')
  assert.deepEqual(first.texts, { ko: '가', ja: 'か' })
  assert.deepEqual(second.texts, { ja: 'び' })
  assert.equal(notes.noteText(first, 'ko'), '가')
  assert.equal(notes.noteText(first, 'zh'), 'A')
  assert.equal(notes.noteText(first, 'en'), 'A')
  assert.equal(notes.noteText(second, 'ko'), 'B')
  assert.equal(notes.withTranslations(null, {}), null)
})

test('notesBetween: 같은 minor의 두 절을 패치 범위와 경계에 맞게 고른다', () => {
  const sections = notes.parseChangelog(`## 0.47 (v0.47.20 – · Nov 3, 2026)
### New
- Latest
## 0.47 (v0.47.0 – v0.47.19 · Nov 1, 2026)
### Fixed
- Older
## 0.46 (v0.42.3 – v0.46.4 · Nov 1, 2026)
### Improved
- Earlier
`)
  const texts = (from, to) => notes.notesBetween(sections, from, to).map(note => note.text)
  assert.deepEqual(texts('0.47.38', '0.47.39'), ['Latest'])
  assert.deepEqual(texts('0.47.18', '0.47.19'), ['Older'])
  assert.deepEqual(texts('0.47.19', '0.47.20'), ['Latest'])
  assert.deepEqual(texts('0.47.18', '0.47.21'), ['Latest', 'Older'])
  assert.deepEqual(texts('0.46.4', '0.47.19'), ['Older'])
  assert.deepEqual(texts('0.46.4', '0.47.20'), ['Latest', 'Older'])
  const picked = notes.withTranslations(notes.pickNotes(notes.notesBetween(sections, '0.47.38', '0.47.39'), text => text), { ko: { Latest: '최신' }, ja: { Latest: '最新' }, zh: { Latest: '最新' } })
  assert.deepEqual(picked.shown[0].texts, { ko: '최신', ja: '最新', zh: '最新' })
})

test('CHANGELOG.md: 0.47.38 → 0.47.39는 최신 0.47 절과 그 번역만 고른다', () => {
  const sections = notes.parseChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'))
  const latest = sections.find(section => section.range?.from.join('.') === '0.47.20')
  assert.ok(latest)
  const selected = notes.notesBetween(sections, '0.47.38', '0.47.39')
  assert.deepEqual(selected, latest.notes)
  const tables = Object.fromEntries(['ko', 'ja', 'zh'].map(lang => [lang, JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'changelog', `${lang}.json`), 'utf8'))]))
  const picked = notes.withTranslations(notes.pickNotes(selected, text => text), tables)
  for (const note of picked.shown) {
    for (const lang of ['ko', 'ja', 'zh']) assert.equal(notes.noteText(note, lang), tables[lang][note.text])
  }
})

// 2026-11-10 제보 재현 — 0.60.14 → 15 → 16 → 18 끝자리 업데이트마다 0.60 절 전체가 똑같이 떴다.
// 줄마다 판 번호(그 줄을 처음 넣은 main 커밋의 태그 · scripts/changelog-versions.js)가 있으면 (이전, 새] 판에 들어간 줄만 고른다
test('notesBetween: 줄마다 판 번호가 있으면 이전 판 뒤에 들어간 줄만 — 끝자리 업데이트마다 같은 절을 되풀이하지 않는다', () => {
  const sections = notes.parseChangelog(`## 0.60 (v0.60.0 – · Nov 8, 2026)
### Improved
- Old60
### Fixed
- Fix16
- Fix18
## 0.58 (v0.58.0 – · Nov 8, 2026)
### New
- Old58
`)
  const versions = { Old60: '0.59.4', Fix16: '0.60.16', Fix18: '0.60.18', Old58: '0.58.0' }
  const texts = (from, to) => notes.notesBetween(sections, from, to, versions).map((note) => note.text)
  assert.deepEqual(texts('0.60.14', '0.60.15'), []) // 줄 없는 판 — 같은 글을 다시 띄우지 않는다
  assert.deepEqual(texts('0.60.15', '0.60.16'), ['Fix16'])
  assert.deepEqual(texts('0.60.16', '0.60.18'), ['Fix18'])
  assert.deepEqual(texts('0.60.14', '0.60.18+2'), ['Fix16', 'Fix18'])
  assert.deepEqual(texts('0.58.3', '0.60.16'), ['Old60', 'Fix16'])
  assert.deepEqual(texts('0.57.0', '0.60.0'), ['Old60', 'Old58'])
  // 판 번호를 모르는 줄(판 번호 붙이기 전 · 태그 없는 커밋)은 고르지 않는다 · 버전을 모르거나 내려가면 빈 목록
  assert.deepEqual(notes.notesBetween(sections, '0.60.15', '0.60.18', { Fix18: '0.60.18' }).map((note) => note.text), ['Fix18'])
  assert.deepEqual(notes.notesBetween(sections, null, '0.60.18', versions), [])
  assert.deepEqual(notes.notesBetween(sections, '0.60.18', '0.60.16', versions), [])
})
