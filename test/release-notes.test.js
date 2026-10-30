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
