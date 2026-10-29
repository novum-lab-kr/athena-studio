// @ts-check
// red-check 의 순수 로직 — 실행기(scripts/red-check.mjs) · ship.sh 가 같이 쓴다. 파일 · git · 프로세스를 건드리지 않는다
//
// red-check = 이번 변경의 테스트가 정말 이번 변경을 검사하는지 기계로 확인한다(계획서 2026-10-29 red-check · factory-format red_check.py 를 들임).
//   바뀐 파일을 테스트(팩 repos[].redCheck.tests 글롭)와 구현으로 나눈다 → base(merge-base origin/<prBase> HEAD)로 임시 워크트리를 만들고
//   이번 테스트 파일만 지금 내용으로 복사해(구현은 base 그대로) 그 테스트를 돌린다.
//   실패하면 ok(이번 변경 없이는 실패 — 진짜 검사) · 통과하면 non-discriminating(구현을 되돌려도 통과 — 아무것도 검사하지 않음)
//
// 결과(RESULTS) — 뜻 · 예외는 docs/knowledge/common/verify.md "red-check"
//   ok                  base 에서 실패. 실패 종류 compile(불러오기 · 문법 — 새 파일이 없어서일 수 있어 약한 근거) · assertion · other
//   non-discriminating  base 에서도 통과 — 그 테스트가 이번 변경을 검사하지 않는다
//   no-tests            바뀐 테스트 파일이 없다
//   test-only           구현은 그대로이고 테스트만 바뀌었다 — 돌리지 않는다(테스트만 고친 PR 은 정상)
//   unsupported         테스트와 구현이 한 파일(doctest · Rust #[cfg(test)]) — 나눌 수 없어 사람이 리뷰
//   error               설정이 틀림 · 기준 ref 없음 · 명령이 없음 · 시간 넘김 — 통과로 치지 않는다
//   skip                팩에 redCheck 칸이 없는 레포
// D1(경고만) — 어느 결과도 PR 을 막지 않는다. ATTENTION 결과면 PR 본문 "확인 필요" 에 적는다
import { globToRegExp } from './pr-auto.mjs'

export const RESULTS = ['ok', 'non-discriminating', 'no-tests', 'test-only', 'unsupported', 'error', 'skip']
// 사람이 봐야 하는 결과 — PR 본문 "확인 필요" · red-check.sh exit 1
export const ATTENTION = ['non-discriminating', 'unsupported', 'error']
export const TIMEOUT_SECONDS = 300
// 임시 워크트리에 지금 트리의 것을 링크할 의존성 폴더 — 빌드 결과(build · target)는 새 구현이 들어 있을 수 있어 넣지 않는다
export const DEP_DIRS = ['node_modules', '.venv', 'venv']
// factory-format red_check.py 와 같은 분류 — 불러오기 · 문법 실패가 먼저(compile), 그다음 단정 실패(assertion)
const COMPILE_RE = /(Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|ImportError|cannot find symbol|error TS\d+|Unresolved reference|[Cc]ompilation failed|SyntaxError|No such file|cannot open|is not defined|has no exported member|not found: )/
const ASSERT_RE = /(AssertionError|\bassert|Expected|expected .+ to |toBe|toEqual|AssertionFailedError|FAILED)/
const DOCTEST_RE = /^\s*>>>\s/m
const RUST_INLINE_RE = /#\[cfg\(test\)\]/

/** @typedef {{ tests: string[], run: string }} RedCheckEntry */

/**
 * 팩 repos[].redCheck 칸 → 항목 배열. 칸이 없으면 null(건너뜀), 모양이 틀리면 Error.
 * 한 레포에 테스트 종류가 여럿이면(예: node · python) 배열로 — 바뀐 테스트 파일은 글롭이 맞는 첫 항목의 run 으로 돈다
 * @param {unknown} value
 * @returns {RedCheckEntry[] | null}
 */
export const parseSpec = (value) => {
  if (value === undefined || value === null) return null
  const list = Array.isArray(value) ? value : [value]
  if (!list.length) throw new Error('redCheck 가 빈 배열이다')
  return list.map((entry, index) => {
    const where = list.length > 1 ? `redCheck[${index}]` : 'redCheck'
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} 가 객체가 아니다`)
    const { tests, run } = /** @type {Record<string, unknown>} */ (entry)
    if (!Array.isArray(tests) || !tests.length || !tests.every((glob) => typeof glob === 'string' && glob.trim())) throw new Error(`${where}.tests 는 글롭 문자열 배열이어야 한다`)
    if (typeof run !== 'string' || !run.includes('{files}')) throw new Error(`${where}.run 은 {files} 자리가 든 명령 문자열이어야 한다`)
    return { tests: tests.map(String), run }
  })
}

/**
 * 바뀐 파일을 테스트(항목마다)와 구현으로 나눈다. 지금 트리에 없는 테스트 파일(지운 테스트)은 돌릴 수 없어 어느 쪽에도 넣지 않는다
 * @param {string[]} changed  레포 맨 위 기준 경로
 * @param {RedCheckEntry[]} spec
 * @param {(path: string) => boolean} [exists]
 * @returns {{ groups: { entry: RedCheckEntry, files: string[] }[], tests: string[], impl: string[] }}
 */
export const splitChanged = (changed, spec, exists = () => true) => {
  const matchers = spec.map((entry) => entry.tests.map((glob) => globToRegExp(glob)))
  /** @type {string[][]} */
  const buckets = spec.map(() => [])
  /** @type {string[]} */
  const impl = []
  for (const path of [...new Set(changed)].sort()) {
    const index = matchers.findIndex((patterns) => patterns.some((pattern) => pattern.test(path)))
    if (index >= 0 && exists(path)) buckets[index]?.push(path)
    else if (index < 0) impl.push(path)
  }
  const groups = spec.map((entry, index) => ({ entry, files: buckets[index] ?? [] })).filter((group) => group.files.length)
  return { groups, tests: groups.flatMap((group) => group.files), impl }
}

/**
 * 테스트와 구현이 한 파일인 구현 파일 — doctest(.py 의 >>>) · Rust 인라인 테스트(.rs 의 #[cfg(test)])
 * @param {string} path
 * @param {string} text
 */
export const isInlineTest = (path, text) => (path.endsWith('.py') && DOCTEST_RE.test(text)) || (path.endsWith('.rs') && RUST_INLINE_RE.test(text))

/** @param {string} output */
export const classify = (output) => {
  if (COMPILE_RE.test(output)) return 'compile'
  if (ASSERT_RE.test(output)) return 'assertion'
  return 'other'
}

/** 셸 인용 — 파일 이름에 공백 · 따옴표가 있어도 한 인자로 @param {string} text */
export const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

/** @param {string} run @param {string[]} files */
export const commandFor = (run, files) => run.split('{files}').join(files.map(shellQuote).join(' '))

/**
 * 파일마다 돌린 결과 → 전체 결과. 하나라도 통과하면 non-discriminating(그 파일이 검사하지 않는다) · 그다음 error · 나머지는 ok
 * @param {{ file: string, outcome: 'fail' | 'pass' | 'error', kind?: string, reason?: string }[]} runs
 */
export const summarize = (runs) => {
  const passed = runs.filter((item) => item.outcome === 'pass')
  const errors = runs.filter((item) => item.outcome === 'error')
  const failed = runs.filter((item) => item.outcome === 'fail')
  if (passed.length) return { result: 'non-discriminating', files: passed.map((item) => item.file), failed, errors }
  if (errors.length) return { result: 'error', files: errors.map((item) => item.file), failed, errors }
  /** @type {Record<string, number>} */
  const kinds = {}
  for (const item of failed) kinds[item.kind ?? 'other'] = (kinds[item.kind ?? 'other'] ?? 0) + 1
  return { result: 'ok', files: failed.map((item) => item.file), failed, errors, kinds }
}

const ICONS = /** @type {Record<string, string>} */ ({ ok: '✅', 'non-discriminating': '⚠️', 'no-tests': 'ℹ️', 'test-only': '⏭', unsupported: '⚠️', error: '⚠️', skip: '⏭' })
/** @param {string[]} files */
const listOf = (files, max = 3) => (files.length > max ? `${files.slice(0, max).join(', ')} 외 ${files.length - max}개` : files.join(', '))
/** @param {Record<string, number>} kinds */
const kindText = (kinds) => {
  const names = Object.keys(kinds)
  if (names.length === 1) return names[0] === 'compile' ? 'compile · 약한 근거 — 불러오기 · 문법 실패만 확인' : String(names[0])
  return names.map((name) => `${name} ${kinds[name]}`).join(' · ')
}

/**
 * 검증 표와 같은 모양 한 줄의 결과 칸 글(아이콘 + 결과 + 설명). 로컬 절대 경로를 넣지 않는다(PR 본문에 그대로 실린다)
 * @param {{ result: string, detail?: string, files?: string[], kinds?: Record<string, number>, impl?: number, base?: string }} report
 */
export const resultText = (report) => {
  const icon = ICONS[report.result] ?? '⚠️'
  const base = report.base ? ` @${report.base.slice(0, 7)}` : ''
  const files = report.files ?? []
  switch (report.result) {
    case 'ok':
      return `${icon} ok (${kindText(report.kinds ?? {})}) — 바뀐 테스트 ${files.length}개가 구현 없이(base${base}) 실패`
    case 'non-discriminating':
      return `${icon} non-discriminating — 구현을 base${base} 로 되돌려도 통과: ${listOf(files)}`
    case 'no-tests':
      return `${icon} no-tests — 바뀐 테스트 파일 없음(구현 ${report.impl ?? 0}개)`
    case 'test-only':
      return `${icon} test-only — 구현은 그대로이고 테스트만 바뀜(${files.length}개) — 돌리지 않음`
    case 'unsupported':
      return `${icon} unsupported — 테스트와 구현이 한 파일: ${listOf(files)} — 사람이 리뷰`
    case 'skip':
      return `${icon} 건너뜀(규칙) — ${report.detail ?? '팩에 redCheck 칸 없음'}`
    default:
      return `${icon} error — ${report.detail ?? '알 수 없는 오류'}${files.length ? ` (${listOf(files)})` : ''}`
  }
}

/** @param {string} text @param {number} seconds */
export const tableRow = (text, seconds) => `| \`red-check\` | ${text.replace(/\|/g, '\\|')} | ${seconds}s |`

// ── 계획서 · PR 본문에 남기기(ship.sh) ─────────────────────────────────────
// 계획서 Validation 줄 — 레포 · 브랜치마다 한 줄(다시 돌리면 바꿔 쓴다)
//   - red-check: <레포> · 🌿 <브랜치> @<HEAD sha7> — <결과 칸 글> · <YYYY-MM-DD HH:MM>
/** @param {string} repo @param {string} branch */
const planLinePrefix = (repo, branch) => `- red-check: ${repo} · 🌿 ${branch} @`
/** @param {{ repo: string, branch: string, sha: string, text: string, stamp: string }} entry */
export const planLine = ({ repo, branch, sha, text, stamp }) => `${planLinePrefix(repo, branch)}${String(sha).slice(0, 7)} — ${text} · ${stamp}`

/**
 * 계획서 Validation 절(## 또는 ### Validation)에 red-check 줄을 넣거나 바꾼다. 절이 없으면 Checkpoint 끝(없으면 문서 끝)에 절을 만든다
 * @param {string} planText
 * @param {{ repo: string, branch: string, sha: string, text: string, stamp: string }} entry
 */
export const withPlanLine = (planText, entry) => {
  const line = planLine(entry)
  const prefix = planLinePrefix(entry.repo, entry.branch)
  const lines = String(planText).split('\n')
  const same = lines.findIndex((row) => row.startsWith(prefix))
  if (same >= 0) { lines[same] = line; return lines.join('\n') }
  const head = lines.findIndex((row) => /^#{2,3} Validation\s*$/.test(row))
  if (head < 0) {
    // 절이 없으면 Checkpoint 절 끝에 만든다(Commits 같은 다음 ## 절 앞) — Checkpoint 도 없으면 문서 끝
    const checkpoint = lines.findIndex((row) => /^##\s+Checkpoint\s*$/.test(row))
    if (checkpoint < 0) return `${String(planText).replace(/\n*$/, '')}\n\n### Validation\n${line}\n`
    let end = checkpoint + 1
    while (end < lines.length && !/^##?\s/.test(lines[end] ?? '')) end += 1
    while (end > checkpoint + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1
    lines.splice(end, 0, '', '### Validation', line)
    return lines.join('\n')
  }
  const level = (lines[head]?.match(/^#+/)?.[0] ?? '###').length
  let end = head + 1
  while (end < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[end] ?? '')) end += 1
  // 비어 있다는 자리 표시 줄("- (아직 없음)")은 바꾼다
  const placeholder = lines.slice(head + 1, end).findIndex((row) => /^- \((아직 )?없음\)\s*$/.test(row))
  if (placeholder >= 0) { lines[head + 1 + placeholder] = line; return lines.join('\n') }
  while (end > head + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1
  lines.splice(end, 0, line)
  return lines.join('\n')
}

/**
 * PR 본문 "## 확인 필요" 절에 red-check 경고 줄을 넣는다(이미 red-check 줄이 있으면 그대로). 절 내용이 "- 없음" 하나면 바꾼다
 * @param {string} body
 * @param {string} note  한 줄(- 로 시작)
 */
export const withBodyNote = (body, note) => {
  const lines = String(body).split('\n')
  const head = lines.findIndex((row) => row === '## 확인 필요')
  if (head < 0) return String(body)
  let end = head + 1
  while (end < lines.length && !/^#{1,2} |^---\s*$/.test(lines[end] ?? '')) end += 1
  const section = lines.slice(head + 1, end)
  if (section.some((row) => row.includes('red-check'))) return String(body)
  const filled = section.filter((row) => row.trim())
  if (filled.length === 1 && /^- 없음\s*$/.test(filled[0] ?? '')) {
    const index = head + 1 + section.findIndex((row) => row.trim())
    lines[index] = note
    return lines.join('\n')
  }
  lines.splice(head + 1, 0, note)
  return lines.join('\n')
}

/** 결과 칸 글 → PR 본문 "확인 필요" 줄 @param {string} text */
export const bodyNote = (text) => `- red-check ${text.replace(/^\S+\s+/, '')} — 이번 변경을 실제로 검사하는 테스트인지 확인(경고만 · 막지 않음)`
