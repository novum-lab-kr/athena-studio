// 코어 업데이트 팝업의 "업데이트 내역" — CHANGELOG.md(영어 정본)에서 이전 → 새 버전 사이의 줄을 고른다.
// CHANGELOG 는 minor 단위 절이다: "## 0.28 (v0.26.0 – … · Oct 29, 2026)" 아래 "### New · Improved · Fixed" 줄들.
// Electron 없이 돈다(test/release-notes.test.js). 번역은 src/changelog/<언어>.json — 영어 줄 글자 그대로를 키로 쓴다(없으면 영어 그대로)

export const RELEASES_URL = 'https://athena.novum-lab.com/releases/'
export const NOTE_LIMIT = 3

export type NoteKind = 'new' | 'improved' | 'fixed'
export const NOTE_KINDS: NoteKind[] = ['new', 'improved', 'fixed']
export type Note = { kind: NoteKind; text: string }
export type ChangelogSection = { minor: [number, number]; notes: Note[] }
export type ReleaseNotes = { shown: Note[]; rest: { count: number; kinds: { kind: NoteKind; count: number }[] } | null }

const SECTION_RE = /^## (\d+)\.(\d+)\b/
const HEADING_KINDS: Record<string, NoteKind> = { New: 'new', Improved: 'improved', Fixed: 'fixed' }

// 위에서 아래로 — 최신 절이 먼저. 알 수 없는 ### 제목 아래 줄은 버린다
export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  let kind: NoteKind | null = null
  for (const line of text.split('\n')) {
    const heading = SECTION_RE.exec(line)
    if (heading) {
      sections.push({ minor: [Number(heading[1]), Number(heading[2])], notes: [] })
      kind = null
      continue
    }
    const sub = /^### (\w+)\s*$/.exec(line)
    if (sub) {
      kind = HEADING_KINDS[sub[1] || ''] || null
      continue
    }
    const item = /^- (.+)$/.exec(line)
    const current = sections[sections.length - 1]
    if (item && kind && current) current.notes.push({ kind, text: (item[1] || '').trim() })
  }
  return sections
}

// '0.26.0' · '0.28.3+2' · 'v0.28.3' → [0, 28] | null (모양이 아니면)
export function minorOf(version: unknown): [number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(String(version ?? ''))
  return match ? [Number(match[1]), Number(match[2])] : null
}

const afterMinor = (left: [number, number], right: [number, number]): boolean => left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1]

// 절 제목의 번호는 그 절이 덮는 마지막 minor 다(## 0.28 = v0.26.0 – … : 0.26 · 0.27 · 0.28 이 한 절). 그래서 한 절은 (바로 아래 절 번호, 자기 번호] 를 덮는다.
// 이전 버전 minor 보다 크고 새 버전 minor 이하인 칸과 겹치는 절들의 줄을 합친다(최신 절 먼저). 한쪽 버전을 모르거나 minor 가 안 오르면 빈 목록
export function notesBetween(sections: ChangelogSection[], from: unknown, to: unknown): Note[] {
  const before = minorOf(from)
  const after = minorOf(to)
  if (!before || !after || !afterMinor(after, before)) return []
  return sections.filter((section, index) => {
    const older = sections[index + 1]
    return afterMinor(section.minor, before) && (!older || afterMinor(after, older.minor))
  }).flatMap((section) => section.notes)
}

// 보일 줄 최대 limit 개(새 기능 → 개선 → 수정 차례, 같은 종류는 CHANGELOG 차례) + 나머지는 종류별 개수. 없으면 null
export function pickNotes(notes: Note[], translate: (text: string) => string, limit = NOTE_LIMIT): ReleaseNotes | null {
  if (!notes.length) return null
  const ordered = NOTE_KINDS.flatMap((kind) => notes.filter((note) => note.kind === kind))
  const shown = ordered.slice(0, limit).map((note) => ({ kind: note.kind, text: translate(note.text) }))
  const left = ordered.slice(limit)
  const kinds = NOTE_KINDS.map((kind) => ({ kind, count: left.filter((note) => note.kind === kind).length })).filter((entry) => entry.count > 0)
  return { shown, rest: left.length ? { count: left.length, kinds } : null }
}

export type Translations = Record<string, string>
export const translateNote = (translations: Translations | null | undefined) => (text: string): string => (translations && translations[text]) || text

// 팝업 결과 상자의 줄 하나 — kind 가 문구 키(coreUpdate.row.<kind>)고, chips 는 글 아래 줄에 모두 보이는 팩 · 세션 이름. dir 은 백업 폴더([폴더 열기])
export type CoreUpdateRowKind = 'skipped' | 'working' | 'backedUp' | 'failed' | 'unsupported' | 'notMoved'
export type CoreUpdateRow = { kind: CoreUpdateRowKind; params: Record<string, string | number>; chips: string[]; dir?: string }
// main → 화면(core-update:show). changed — 코어가 새 버전으로 바뀌었다(제목 · 버전 칩 · 내역을 보인다). from · to · notes 는 모르면 null(그 칸을 숨긴다)
export type CoreUpdateView = { changed: boolean; from: string | null; to: string | null; notes: ReleaseNotes | null; rows: CoreUpdateRow[]; releasesUrl: string }
