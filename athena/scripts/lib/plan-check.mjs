// @ts-check
/**
 * 계획서 '## 지시' 칸 검사 — 잘못된 멈춤 · 줄이다 빠뜨린 내용을 찾는다. 경고만 하고 막지 않는다(scripts/plan-check.mjs · delegate.sh).
 * 칸 형식은 docs/plan-template-light.md "지시 칸". 새 칸(handoff 전 · 후 · 멈춤 · 받은 뒤)이 하나도 없는 옛 계획서는 검사하지 않는다(checked: false).
 *
 * 줄 번호는 지시 절 안에서 센다 — '## 지시' 다음 줄이 1. 인용 표시(> )는 떼고 읽는다(new-plan.mjs 가 지시문을 인용으로 넣는다).
 * 원본 대조(←N)의 N 은 원본 파일의 줄 번호다(--orig 로 준 파일 · 1부터).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 경고 종류 — 지표 탭이 종류별로 센다(i18n `m.pc.<종류>`) */
export const KINDS = [
  'field-missing', 'stop-missing', 'after-missing', 'stop-ground', 'wait-without-stop', 'ship-option', 'branch-base',
  'progress-word', 'path-missing', 'orig-missing-line', 'orig-bad-number', 'orig-drop-reason', 'orig-negation', 'orig-token',
  'handoff-scatter', 'todo-conflict',
]

// 사람 확인을 기다린다는 뜻의 말 — "확인해"(검사) 같은 넓은 말은 넣지 않는다
const WAIT_WORDS = /사용자 확인|확인받|확인 받|확인 뒤|승인 뒤|["“]넘겨["”]|넘겨["”]|기다림|기다린|보고 정/
// 지시 칸에 쓰지 않는 진행 상태 말(Checkpoint 몫) — "남은 일로 보고" 는 할 일이라 뺀다
const PROGRESS_WORDS = /받음|남은 일(?!로)|끝남|끝났|완료됨|했음|진행 중/
const SCREEN_HINT = /\.(tsx|ts|css|html|jsx|vue|svelte)\b|캡처|화면|팝업|hover/
const CITE = /\(←([\d,\s]+)\)/g
// 원본의 금지 · 제외 뜻. "A 말고 B"(바꿔 쓰기) · "아직 X"(때 — 멈춤 칸 몫)는 넣지 않는다
const NEGATION = /않|안 함|안 씀|금지|뺀다|뺌|없애|빼고|하지 마/
const KEEP_TOKEN = /\d+×\d+|[\w-]+\.(?:png|webp|jpg|md|ts|tsx|mts|mjs|css|html)\b/g
const HANDOFF_WORDS = /커밋|넘기|넘겨|머지|push|ship\.sh|commit\.sh/
const FIELD_NAMES = ['요청', '할 것', '보존', '조건', '안 할 것', 'handoff 전 · 후', '버림', '정리', '브랜치', '끝', '위치', '재현', '기대', '대상']
const FIELD_START = new RegExp(`^-\\s*(${FIELD_NAMES.join('|')})(?=[\\s:(]|$)`)
// 넘기기 말이 나오면 안 되는 칸 — 일을 시키는 칸만 본다(위치 · 재현 · 기대에는 "자동 머지 버튼" 같은 화면 이름이 나온다)
const WORK_FIELDS = new Set(['할 것', '보존', '조건', '안 할 것', '정리', '브랜치'])
const NEW_FILE_HINT = /새로|새 파일|만든다|만들|추가|생성/

/**
 * @typedef {{ kind: string, line?: number, message: string }} Warning
 * @typedef {{ name?: string, prBase?: string, branch?: string, direct?: boolean, autoMerge?: boolean, autoPr?: boolean }} RepoEntry
 * @typedef {{ repo?: RepoEntry | null, ship?: string, roots?: string[], repoFiles?: string[] | null, orig?: string | null }} CheckOptions
 */

/** 계획서에서 '## 지시' 절의 줄들(인용 표시를 뗀) — 없으면 null */
export const instructionLines = (/** @type {string} */ text) => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^## 지시\s*$/.test(line))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## /.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).map((line) => line.replace(/^>\s?/, ''))
}

/** 줄마다 속한 칸 이름 — 들여 쓴 줄은 위 칸을 잇는다 */
export const fieldsOf = (/** @type {string[]} */ lines) => {
  let current = '머리'
  return lines.map((line) => {
    const start = line.match(FIELD_START)
    if (start) current = start[1] ?? current
    else if (line.startsWith('### ')) current = line.slice(4).trim()
    else if (/^(요청|결정)/.test(line)) current = line.startsWith('요청') ? '요청' : '결정'
    return current
  })
}

const isHandoffField = (/** @type {string} */ name) => name.startsWith('handoff')

/** 이 계획서가 새 지시 칸을 쓰는가 — handoff 칸 · 멈춤 · 받은 뒤 줄 중 하나라도 있으면 */
export const usesNewFields = (/** @type {string[]} */ lines) =>
  fieldsOf(lines).some(isHandoffField) || lines.some((line) => /^\s*-\s*(멈춤|받은 뒤):/.test(line))

/** 받은 뒤 ship.sh 에 --direct-merge 가 있어야 하는 레포인가 — delegate.sh 의 올리는 방식(handoff · pr-off)과 같은 기준 */
const needsDirectMerge = (/** @type {RepoEntry} */ repo, /** @type {string | undefined} */ ship) => {
  if (ship) return ship === 'handoff' || ship === 'pr-off'
  return !repo.direct && repo.autoMerge === true && repo.autoPr === false
}

/**
 * 멈춤 근거가 실제로 있는지
 * @param {string} ground @param {string[]} lines @param {number} stopIndex @param {RepoEntry} repo
 * @returns {string | null} 문제 글(없으면 null)
 */
const groundProblem = (ground, lines, stopIndex, repo) => {
  const lineRef = ground.match(/^요청\s*(\d+)\s*줄/)
  const decision = ground.match(/^(D\d+)/)
  if (lineRef) {
    const number = Number(lineRef[1])
    const target = lines[number - 1]
    if (target === undefined || number < 1) return `근거 ${number}줄이 지시 칸에 없음`
    return WAIT_WORDS.test(target) ? null : `근거 ${number}줄에 기다림 말이 없음`
  }
  if (decision) {
    const code = decision[1]
    const hits = lines.filter((line) => new RegExp(`\\b${code}\\b`).test(line) && !line.includes('근거:'))
    if (!hits.length) return `근거 결정 ${code} 이 지시 칸에 없음`
    return hits.some((line) => WAIT_WORDS.test(line)) ? null : `결정 ${code} 에 기다림 말이 없음`
  }
  if (ground.startsWith('설정 direct')) return repo.direct ? null : `${repo.name} 은 main 직접(direct) 레포가 아님`
  if (ground.startsWith('규칙 화면')) {
    const body = lines.filter((_line, index) => index !== stopIndex).join('\n')
    return SCREEN_HINT.test(body) ? null : '근거 "규칙 화면" 인데 화면을 바꾸는 작업이 아님'
  }
  return `근거 모양을 모름: ${ground} (요청 N줄 · D# · 설정 direct · 규칙 화면 중 하나)`
}

/** 적힌 경로가 있는지 — 본체 · 팩(roots) 또는 레포 파일 목록(끝이 같은 파일도 인정 · `ui/x.tsx`) */
const pathExists = (/** @type {string} */ path, /** @type {string[]} */ roots, /** @type {string[] | null} */ repoFiles) => {
  if (roots.some((root) => existsSync(join(root, path)))) return true
  if (!repoFiles) return true   // 레포 목록을 못 읽으면 경고하지 않는다
  return repoFiles.some((file) => file === path || file.endsWith(`/${path}`))
}

/**
 * 원본 대조 — 줄 끝 (←N,M) · 버림 아래 "- N — 이유"
 * @param {string[]} lines @param {string[]} names @param {string[]} origLines @returns {Warning[]}
 */
const checkOrigin = (lines, names, origLines) => {
  /** @type {Warning[]} */
  const warnings = []
  /** @type {Map<number, number[]>} 원본 줄 → 가리킨 지시 줄(0부터) */
  const cited = new Map()
  lines.forEach((line, index) => {
    for (const hit of line.matchAll(CITE)) {
      for (const number of (hit[1] ?? '').match(/\d+/g) ?? []) cited.set(Number(number), [...(cited.get(Number(number)) ?? []), index])
    }
  })
  /** @type {Map<number, { reason: string, index: number }>} */
  const dropped = new Map()
  lines.forEach((line, index) => {
    if (names[index] !== '버림') return
    const item = line.match(/^\s*-\s*(?:버림:\s*)?(\d+)\s*(?:—\s*(.*))?$/)
    if (item) dropped.set(Number(item[1]), { reason: (item[2] ?? '').trim(), index })
  })
  for (const [number, { reason, index }] of dropped) {
    if (!reason) warnings.push({ kind: 'orig-drop-reason', line: index + 1, message: `버림 ${number} 에 이유가 없음` })
  }
  for (const number of new Set([...cited.keys(), ...dropped.keys()])) {
    if (number < 1 || number > origLines.length) warnings.push({ kind: 'orig-bad-number', message: `원본 ${number}줄은 없음(원본 ${origLines.length}줄)` })
  }
  origLines.forEach((orig, offset) => {
    const number = offset + 1
    const trimmed = orig.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const citing = cited.get(number) ?? []
    if (!citing.length) {
      if (!dropped.has(number)) warnings.push({ kind: 'orig-missing-line', message: `원본 ${number}줄 빠짐: ${trimmed.slice(0, 40)}` })
      return
    }
    const joined = citing.map((index) => lines[index] ?? '').join('\n')
    // 뜻 보존 — 원본의 금지가 가리킨 줄 어디에도 없으면. 요청 줄(요약)이 가리키거나 안 할 것 칸이 가리키면 지킨 것으로 본다
    const negation = orig.match(NEGATION)
    const kept = citing.some((index) => names[index] === '요청' || names[index] === '안 할 것') || NEGATION.test(joined)
    if (negation && !kept) warnings.push({ kind: 'orig-negation', line: (citing[0] ?? 0) + 1, message: `원본 ${number}줄의 금지("${negation[0]}")가 줄인 지시에 없음` })
    // 숫자 · 파일 이름 보존
    for (const token of orig.match(KEEP_TOKEN) ?? []) {
      if (!joined.includes(token)) warnings.push({ kind: 'orig-token', line: (citing[0] ?? 0) + 1, message: `원본 ${number}줄의 "${token}" 이 줄인 지시에 없음` })
    }
  })
  return warnings
}

/**
 * 지시 칸 검사
 * @param {string} text 계획서 전문
 * @param {CheckOptions} [options]
 * @returns {{ checked: boolean, warnings: Warning[] }}
 */
export const checkPlan = (text, options = {}) => {
  const lines = instructionLines(text)
  if (!lines || !usesNewFields(lines)) return { checked: false, warnings: [] }
  const repo = options.repo ?? {}
  const roots = options.roots ?? []
  const names = fieldsOf(lines)
  /** @type {Warning[]} */
  const warnings = []
  const warn = (/** @type {string} */ kind, /** @type {number | undefined} */ index, /** @type {string} */ message) =>
    warnings.push(index === undefined ? { kind, message } : { kind, line: index + 1, message })

  // 1. 칸 — 버그 수정 지시는 할 것 대신 재현 · 기대를 쓴다
  const present = new Set(names)
  if (!present.has('할 것') && !present.has('재현')) warn('field-missing', undefined, '칸 없음: 할 것')
  for (const field of ['조건', '안 할 것']) if (!present.has(field)) warn('field-missing', undefined, `칸 없음: ${field}`)
  if (!names.some(isHandoffField)) warn('field-missing', undefined, '칸 없음: handoff 전 · 후')

  // 2. 멈춤 · 받은 뒤 줄
  const stopIndex = lines.findIndex((line) => /^\s*-\s*멈춤:/.test(line))
  const afterIndex = lines.findIndex((line) => /^\s*-\s*받은 뒤:/.test(line))
  if (stopIndex < 0) warn('stop-missing', undefined, '멈춤: 줄이 없음 — 기다릴 게 없으면 "멈춤: 없음"')
  if (afterIndex < 0) warn('after-missing', undefined, '받은 뒤: 줄이 없음')
  const others = lines.map((line, index) => ({ line, index })).filter(({ index }) => index !== stopIndex && index !== afterIndex)

  if (stopIndex >= 0) {
    const stopLine = lines[stopIndex] ?? ''
    if (/멈춤:\s*없음/.test(stopLine)) {
      // 3. 멈춤 없음인데 다른 줄에 기다림 말
      for (const { line, index } of others) {
        const found = line.match(WAIT_WORDS)
        if (found) warn('wait-without-stop', index, `기다림("${found[0]}")이 있는데 멈춤: 없음`)
      }
    } else {
      // 4. 멈춤 근거가 실제로 있는지
      const ground = stopLine.match(/근거:\s*(.+)$/)
      const problem = ground ? groundProblem((ground[1] ?? '').trim(), lines, stopIndex, { name: '레포', ...repo }) : '멈춤에 근거가 없음 — "— 근거: 요청 N줄 | D# | 설정 direct | 규칙 화면"'
      if (problem) warn('stop-ground', stopIndex, problem)
    }
  }

  // 5. 받은 뒤 ship.sh 옵션이 레포 설정과 맞는지
  const afterLine = afterIndex >= 0 ? lines[afterIndex] ?? '' : ''
  if (afterLine.includes('ship.sh') && repo.name) {
    const needs = needsDirectMerge(repo, options.ship)
    const has = afterLine.includes('--direct-merge')
    // "레포 설정대로" 는 디스패치 결과의 올리는 방식 줄에 맡긴 것 — 빠진 옵션으로 보지 않는다
    if (needs && !has && !afterLine.includes('레포 설정대로')) warn('ship-option', afterIndex, `${repo.name} 은 PR 없이 넘기는 레포 — 받은 뒤 ship.sh 에 --direct-merge 가 없음`)
    if (!needs && has) warn('ship-option', afterIndex, `${repo.name} 은 PR 로 올리는 레포 — --direct-merge 를 쓰지 않음`)
  }

  // 6. 브랜치 base = prBase
  const prBase = repo.prBase ?? repo.branch
  lines.forEach((line, index) => {
    const base = line.match(/\((\S+) 에서\)/)
    if (prBase && line.includes('브랜치') && base && base[1] !== prBase) warn('branch-base', index, `브랜치 base ${base[1]} ≠ prBase ${prBase}`)
  })

  // 7. 진행 상태 말(요청 · 결정 줄과 버림 이유는 빼고)
  for (const { line, index } of others) {
    const found = line.match(PROGRESS_WORDS)
    if (found && !/^\s*(요청|결정)/.test(line) && names[index] !== '버림') warn('progress-word', index, `진행 상태 말 "${found[0]}" — Checkpoint 에 쓴다`)
  }

  // 8. 적힌 경로(`a/b.ext` 모양만 · 파일 이름만은 건너뜀 · 새로 만들 파일 · ~ · / 로 시작하는 것은 건너뜀)
  lines.forEach((line, index) => {
    if (NEW_FILE_HINT.test(line)) return
    for (const hit of line.matchAll(/`([\w./-]+\/[\w.-]+\.\w+)(?::\d+)?`/g)) {
      const path = hit[1] ?? ''
      if (path.startsWith('~') || path.startsWith('/')) continue
      if (!pathExists(path, roots, options.repoFiles ?? null)) warn('path-missing', index, `경로 없음: ${path}`)
    }
  })

  // 9. 원본 대조
  if (typeof options.orig === 'string') warnings.push(...checkOrigin(lines, names, options.orig.split('\n')))

  // 10. 넘기기 말이 handoff 칸 밖(일을 시키는 칸)에
  lines.forEach((line, index) => {
    const name = names[index] ?? ''
    if (!WORK_FIELDS.has(name)) return
    const found = line.match(HANDOFF_WORDS)
    if (found) warn('handoff-scatter', index, `넘기기 말 "${found[0]}" 이 handoff 칸 밖(${name}) — handoff 전 · 후 칸에 모은다`)
  })

  // 11. 할 것과 안 할 것 충돌
  const banned = lines.flatMap((line, index) => {
    if (names[index] !== '안 할 것') return []
    const body = line.replace(CITE, '').replace(/^\s*-\s*(안 할 것:)?/, '')
    return body.split(/[·,]/).map((item) => item.replace(/\(.*?\)/g, '').trim()).filter((item) => item.length >= 3)
  })
  lines.forEach((line, index) => {
    if (names[index] !== '할 것') return
    for (const item of banned) if (line.includes(item)) warn('todo-conflict', index, `할 것에 안 할 것 "${item}" 이 나옴`)
  })
  return { checked: true, warnings }
}

/** 레포 파일 목록(git ls-files) — git 이 아니거나 못 읽으면 null */
export const listRepoFiles = (/** @type {string} */ dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)
  } catch {
    return null
  }
}

/** 종류별 수 — { 'stop-ground': 1, … } */
export const countKinds = (/** @type {Warning[]} */ warnings) => {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const warning of warnings) counts[warning.kind] = (counts[warning.kind] ?? 0) + 1
  return counts
}
