// ── 계획서 md → 화면에 그릴 조각 — [작업] 계획서 화면(src/renderer/ui/plan-view.tsx)이 쓴다 ──
// 계획서가 쓰는 markdown 만 읽는다: 제목(## · ###) · 문단 · 목록(체크 칸 · 들여쓰기) · 표 · 코드 블록 · 인용 · 굵게 · `코드` · 링크.
// 모르는 줄은 문단으로 둔다(버리지 않는다). Electron · DOM 없이 돈다 — main(진행 칸)과 화면(본문) 둘 다 import 한다

export type PlanStep = { done: boolean; text: string }
export type ListItem = { text: string; check: boolean | null; depth: number; ordered: boolean }
export type PlanBlock =
  | { kind: 'para'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; text: string }
export type PlanSection = { title: string; blocks: PlanBlock[] }
export type InlinePart = { kind: 'text' | 'bold' | 'code'; text: string } | { kind: 'link'; text: string; href: string }

const INDENT_WIDTH = 2
const LIST_LINE = /^(\s*)(-|\*|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/
const TABLE_LINE = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/
const FENCE = /^\s*```/

// 꾸밈(** · `)을 걷은 글 — work-model.mts plain 과 같다
const plain = (value: string): string => value.replace(/\*\*/g, '').replace(/`/g, '').trim()

// 절 하나의 줄(다음 같은 깊이 · 더 얕은 제목 전까지) — work-model.mts section 과 같은 규칙
function sectionLines(lines: readonly string[], heading: string): string[] {
  const start = lines.findIndex((line) => /^#{2,3}\s/.test(line.trim()) && line.trim().replace(/^#+\s*/, '') === heading)
  if (start < 0) return []
  const depth = (lines[start] ?? '').trim().match(/^#+/)?.[0].length ?? 0
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const head = line.match(/^(#+)\s/)
    if (head && (head[1] ?? '').length <= depth) break
    body.push(line)
  }
  return body
}

// 진행 칸 — Checkpoint "Progress" 의 체크 줄 전부(순서 그대로). 세는 줄은 work-model.mts planDetail 의 progress 와 같다(templateLines 는 뺀다)
export function planSteps(text: unknown, templateLines: readonly string[] = []): PlanStep[] {
  return sectionLines(String(text || '').split('\n'), 'Progress')
    .map((line) => line.trim())
    .filter((line) => /^-\s+\[[ xX]\]/.test(line) && !templateLines.includes(line))
    .map((line) => ({ done: /^-\s+\[[xX]\]/.test(line), text: plain(line.replace(/^-\s+\[[ xX]\]\s*/, '')) }))
}

// 커밋 기록 — "Commits" 절(정식은 Checkpoint 아래 ### · 경량은 ##)의 목록 줄(commit.sh 가 한 커밋에 한 줄). 꾸밈은 그대로 둔다(화면이 inlineParts 로 그린다).
// 통째로 괄호인 줄은 템플릿 자리 글("(scripts/commit.sh 가 적는다)")이라 뺀다
export function planCommits(text: unknown): string[] {
  return sectionLines(String(text || '').split('\n'), 'Commits')
    .map((line) => line.match(/^-\s+(.*)$/)?.[1]?.trim() ?? '')
    .filter((line) => line && !/^\(.*\)$/.test(line))
}

// 표 한 줄 → 칸(양 끝 | 는 뗀다 · `코드` 안의 | 는 가르지 않는다)
function tableCells(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (const char of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (char === '`') inCode = !inCode
    if (char === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  cells.push(cell.trim())
  return cells
}

// 줄 묶음 → 조각. 빈 줄은 문단을 끊는다
export function planBlocks(lines: readonly string[]): PlanBlock[] {
  const blocks: PlanBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }
    if (FENCE.test(line)) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1 // 닫는 ``` (없으면 끝까지 코드)
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const head = line.match(/^#{1,6}\s+(.*)$/)
    if (head) {
      blocks.push({ kind: 'heading', text: plain(head[1] ?? '') })
      index += 1
      continue
    }
    if (TABLE_LINE.test(line) && TABLE_RULE.test(lines[index + 1] ?? '')) {
      const rows: string[][] = []
      let cursor = index + 2
      while (cursor < lines.length && TABLE_LINE.test(lines[cursor] ?? '')) {
        rows.push(tableCells(lines[cursor] ?? ''))
        cursor += 1
      }
      blocks.push({ kind: 'table', head: tableCells(line), rows })
      index = cursor
      continue
    }
    if (LIST_LINE.test(line)) {
      const items: ListItem[] = []
      while (index < lines.length) {
        const found = (lines[index] ?? '').match(LIST_LINE)
        if (!found) break
        const mark = found[3]
        items.push({ text: found[4] ?? '', check: mark === undefined ? null : mark !== ' ', depth: Math.floor((found[1] ?? '').replace(/\t/g, '  ').length / INDENT_WIDTH), ordered: /\d/.test(found[2] ?? '') })
        index += 1
      }
      blocks.push({ kind: 'list', items })
      continue
    }
    const quoted = /^\s*>/.test(line)
    const starts = (candidate: string): boolean => !candidate.trim() || FENCE.test(candidate) || /^#{1,6}\s/.test(candidate) || LIST_LINE.test(candidate) || TABLE_LINE.test(candidate) || /^\s*>/.test(candidate) !== quoted
    const para: string[] = []
    while (index < lines.length && (para.length === 0 || !starts(lines[index] ?? ''))) {
      para.push((lines[index] ?? '').trim().replace(/^>\s?/, ''))
      index += 1
    }
    blocks.push({ kind: quoted ? 'quote' : 'para', text: para.join('\n') })
  }
  return blocks
}

// 본문 절 — "## " 마다 하나(### 는 그 절 안 작은 제목). 제목 줄(#) 아래 · 첫 절 앞의 글은 버리지 않고 제목 없는 절로.
// skip 에 든 제목의 절은 뺀다(계획서 화면은 Checkpoint 를 요약 칸으로 따로 그린다)
export function planSections(text: unknown, skip: readonly string[] = []): PlanSection[] {
  const sections: PlanSection[] = []
  let title = ''
  let lines: string[] = []
  let inCode = false
  const push = () => {
    const blocks = planBlocks(lines)
    if (blocks.length && !skip.includes(title)) sections.push({ title, blocks })
  }
  for (const line of String(text || '').split('\n')) {
    if (FENCE.test(line)) inCode = !inCode
    const head = inCode ? null : line.match(/^##\s+(.*)$/)
    if (head) {
      push()
      title = plain(head[1] ?? '')
      lines = []
    } else if (!inCode && !sections.length && !title && /^#\s/.test(line)) {
      // 문서 제목 — 화면 머리에 따로 보인다
    } else lines.push(line)
  }
  push()
  return sections
}

// 한 줄 안 꾸밈 — `코드` · **굵게** · [글](주소) · 맨 주소(http · https). 그 밖은 글자 그대로
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)<>]+)/g
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  let last = 0
  for (const found of text.matchAll(INLINE)) {
    const at = found.index ?? 0
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) })
    if (found[1] !== undefined) parts.push({ kind: 'code', text: found[1] })
    else if (found[2] !== undefined) parts.push({ kind: 'bold', text: found[2] })
    else if (found[3] !== undefined) parts.push({ kind: 'link', text: found[3], href: found[4] ?? '' })
    else parts.push({ kind: 'link', text: found[5] ?? '', href: found[5] ?? '' })
    last = at + found[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

// ── 사람이 보는 짧은 말(D8) — 계획서 글을 자르기만 한다(새 말을 만들지 않는다).
// 폰 athena-app app/src/features/work/planView.ts stepParts · decisionParts 와 같은 규칙 — 한쪽을 바꾸면 다른 쪽도
const DASH = ' — '
const CHECK = ' → 확인:'

// 괄호 밖 첫 " · " 앞 — "B 그대로(제목 · 상태 칩)" 의 괄호 안에서는 자르지 않는다
function cutDot(text: string): string {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')' && depth > 0) depth -= 1
    else if (depth === 0 && text.startsWith(' · ', index)) return text.slice(0, index)
  }
  return text
}

// 단계 한 줄 — 머리(title) = 첫 " — " 앞 · 할 일(gist) = 그 뒤 ~ 첫 " → 확인:" 앞. " — " 가 없으면 줄 전체가 머리
export function stepBrief(text: string): { title: string; gist: string } {
  const at = text.indexOf(DASH)
  if (at < 0) return { title: text.trim(), gist: '' }
  const rest = text.slice(at + DASH.length)
  const check = rest.indexOf(CHECK)
  return { title: text.slice(0, at).trim(), gist: (check < 0 ? rest : rest.slice(0, check)).trim() }
}

// 지금 단계 짧은 제목 — progress.now 의 머리(단계 번호 · 담당, 예 "4단계 reviewer")
export function stepTitle(text: string): string {
  return stepBrief(text).title
}

// 결정 한 줄 — 맨 앞 번호("D1 ")는 화면에 쓰지 않는다. full = 번호만 뗀 전체(날짜 꼬리 그대로 · 누르면 보인다).
// title = 끝 괄호 꼬리("(2026-11-21 사용자)")를 뗀 글의 첫 ": " 앞(무엇에 대한 결정인지) · ": " 가 없으면 괄호 밖 첫 " · " 앞 · 비면 그 글
export function decisionBrief(text: string): { title: string; full: string } {
  const full = text.replace(/^D\d+\b[\s.:)]*/, '').trim()
  const body = full.replace(/\s*\([^()]*\)\s*$/, '')
  const colon = body.indexOf(': ')
  const title = colon < 0 ? cutDot(body) : body.slice(0, colon)
  return { title: title.trim() || body, full }
}
