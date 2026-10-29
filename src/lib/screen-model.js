// @ts-check
// 데몬의 순수 로직 — pane 정보를 화면 계층(아테나 scripts/lib/screen.py)의 납작한 JSON 으로 · 키 이름 · 에이전트 판정 · 읽기.
// pty·소켓 없이 테스트한다(test/screen-model.test.js).
const path = require('path')

// 납작한 Pane 의 키 — screen.py `_pane` 과 같은 12개, 같은 순서
const PANE_KEYS = ['id', 'tab_id', 'workspace_id', 'label', 'name', 'pane_title', 'cwd', 'foreground_cwd', 'focused', 'agent', 'agent_status', 'title', 'cols', 'rows']

// id 는 다시 쓰지 않는다. [\w:] 만 · 'hermes' 로 시작하지 않는다(현황판의 가짜 id)
// start 로 지난 데몬이 남긴 번호를 받아 이어서 센다 — 데몬을 다시 띄워도 p1 부터 다시 매기지 않게(계획서에 남은 옛 pane id 가 새 pane 을 가리키지 않게).
// onChange 는 번호가 바뀔 때마다 지금 번호 전체를 받는다(데몬이 파일에 남긴다 — 카운터는 10진 숫자 그대로)
// id 글자는 36진수 소문자(2026-10-28 — p230 다음 p6f · 접두 빼고 3글자로 46,655 까지). 10 이상인데 36진수가 숫자만인 번호
// (36 → '10' · 1296 → '100')는 건너뛴다 — 예전 10진 id(p10 · p100)와 같은 글자가 되어 계획서에 남은 옛 pane id 가 새 pane 을 가리키지 않게.
// 숫자가 하나도 없는(글자만인) 번호(10 → 'a' · 28 → 's')도 건너뛴다 — id 에 늘 숫자가 하나 이상 들어가 ps · pwd 같은 명령어 이름과 겹치지 않게(gh134). 이미 만든 id · 저장된 카운터는 그대로
/**
 * @param {unknown} [start]
 * @param {((counters: Record<string, number>) => void) | null} [onChange]
 */
function createIdGen(start = {}, onChange = null) {
  /** @type {Record<string, number>} */
  const counters = {}
  for (const [prefix, value] of Object.entries(start && typeof start === 'object' ? start : {})) {
    if (/^\w+$/.test(prefix) && Number.isSafeInteger(value) && value > 0) counters[prefix] = value
  }
  return {
    /** @param {string} prefix */
    next(prefix) {
      let number = (counters[prefix] || 0) + 1
      while (number >= 10 && /^\d+$|^[a-z]+$/.test(number.toString(36))) number += 1
      counters[prefix] = number
      if (onChange) onChange({ ...counters })
      return `${prefix}${number.toString(36)}`
    },
  }
}

// 데몬이 id 번호를 남기는 파일 — 접속 파일 옆 <이름>-ids.json(앱마다 접속 파일이 달라 개발 앱 · 배포판이 섞이지 않는다)
const idsPath = (/** @type {string} */ endpoint) => endpoint.replace(/\.json$/, '') + '-ids.json'

// 빈 글자는 null — screen.py 가 `or None` 으로 하던 그대로
/**
 * @template T
 * @param {T} value
 * @returns {T | null}
 */
const orNull = (value) => (value === undefined || value === null || value === '' ? null : value)

/**
 * 데몬 pane 정보에서 읽는 칸만(모양은 검사하지 않는다)
 * @param {{ id: unknown, tabId: unknown, workspaceId?: unknown, label?: unknown, cwd?: unknown, foregroundCwd?: unknown, focused?: unknown, agent?: unknown, agentStatus?: unknown, title?: unknown, cols?: unknown, rows?: unknown }} info
 */
function flatPane(info) {
  return {
    id: info.id,
    tab_id: info.tabId,
    workspace_id: orNull(info.workspaceId),
    label: orNull(info.label),
    name: null,
    pane_title: null,
    cwd: orNull(info.cwd),
    foreground_cwd: orNull(info.foregroundCwd),
    focused: Boolean(info.focused),
    agent: orNull(info.agent),
    agent_status: orNull(info.agentStatus),
    title: orNull(info.title),
    // pane 크기(글자 칸) — 에이전트 pane 을 어느 pane 의 어느 쪽으로 나눌지 고르는 데 쓴다(delegate.sh). 모르면 null
    cols: orNull(info.cols),
    rows: orNull(info.rows),
  }
}

// ── 키 이름 → pty 에 쓸 글자 (Enter · C-c 같은 이름) ─────────────
/** @type {Record<string, string>} */
const NAMED_KEYS = {
  enter: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  bspace: '\x7f',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  delete: '\x1b[3~',
}

// 모르는 키는 null — 부르는 쪽이 usage 오류로 거절한다(조용히 넘어가지 않게)
/** @param {unknown} name */
function keyBytes(name) {
  if (typeof name !== 'string' || !name) return null
  const named = NAMED_KEYS[name.toLowerCase()]
  if (named) return named
  const control = name.match(/^C-(.)$/i)
  if (!control) return null
  const code = /** @type {string} */ (control[1]).toUpperCase().charCodeAt(0)
  // C-@ · C-a…z · C-[ · C-\ · C-] · C-^ · C-_ → 0x00…0x1f
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40)
  if (control[1] === '?') return '\x7f'
  return null
}

// ── 프로세스 → agent · 빈 셸 ──────────────────────────────────────────
const AGENTS = ['claude', 'codex']

// `ps -axo pid=,pgid=,tpgid=,comm=` 한 줄씩. comm 은 마지막 칸이라 공백이 있어도 끝까지 하나로 읽는다
/** @typedef {{ pid: number, pgid: number, tpgid: number, comm: string }} ProcessRow */

/** @param {unknown} text */
function parsePs(text) {
  /** @type {ProcessRow[]} */
  const rows = []
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), pgid: Number(match[2]), tpgid: Number(match[3]), comm: /** @type {string} */ (match[4]) })
  }
  return rows
}

// 셸의 앞쪽(포그라운드) 프로세스 그룹 — 셸 자신이 앞이거나 모르면 null
/**
 * @param {ProcessRow[]} processes
 * @param {number} shellPid
 */
function foregroundGroup(processes, shellPid) {
  const shell = processes.find((row) => row.pid === shellPid)
  if (!shell || shell.tpgid <= 0 || shell.tpgid === shell.pgid) return null
  return shell.tpgid
}

// 빈 셸(프롬프트에서 대기)인가 — 확인 못 하면 false(돌고 있는 것을 건드리지 않는 쪽으로, screen.py is_shell 과 같다)
/**
 * @param {ProcessRow[]} processes
 * @param {number} shellPid
 */
function isShellIdle(processes, shellPid) {
  const shell = processes.find((row) => row.pid === shellPid)
  return shell !== undefined && shell.tpgid > 0 && shell.tpgid === shell.pgid
}

// 앞쪽 그룹 안에 claude·codex 가 있으면 그 이름. node-pty `.process` 는 실제 파일 이름이라 쓰지 않는다
// (claude 는 ~/.local/share/claude/versions/<버전> 으로 풀려 '2.1.302' 로 보인다 — ps comm 은 'claude').
// comm 이 node 인 프로세스(npm 판 codex)는 argsOf(pid) 로 두 번째 낱말을 본다 — 앞쪽 그룹 안에서만 묻는다
/**
 * @param {ProcessRow[]} processes
 * @param {number} shellPid
 * @param {(pid: number) => unknown} [argsOf]
 */
function detectAgent(processes, shellPid, argsOf = () => null) {
  const group = foregroundGroup(processes, shellPid)
  if (group === null) return null
  for (const row of processes) {
    if (row.pgid !== group) continue
    const base = path.basename(row.comm)
    if (AGENTS.includes(base)) return base
    if (base !== 'node') continue
    const script = String(argsOf(row.pid) || '').trim().split(/\s+/)[1]
    if (script && AGENTS.includes(path.basename(script))) return path.basename(script)
  }
  return null
}

// ── agent_status (S7: 프로세스 이름 + 'esc to interrupt' 표식 + 출력 정지 보조) ─────
const WORKING_MARK = /esc to interrupt/i
const QUIET_MS = 1500
const STATUS_TAIL_LINES = 8

// screenLines: 화면에 보이는 줄들(위→아래). lastOutputAt·now: ms
/** @param {{ agent?: unknown, screenLines?: string[] | null, lastOutputAt?: number | null, now: number }} state */
function agentStatus({ agent, screenLines, lastOutputAt, now }) {
  if (!agent) return 'unknown'
  const tail = (screenLines || []).filter((line) => line.trim()).slice(-STATUS_TAIL_LINES)
  if (tail.some((line) => WORKING_MARK.test(line))) return 'working'
  if (lastOutputAt && now - lastOutputAt < QUIET_MS) return 'working'
  return 'idle'
}

// ── 입력 대기 (권한 질문 · 고르기 창 · 폴더 신뢰 — 사람이 골라야 이어진다) ─────────
// agent_status 는 이것을 idle 로 보거나(조용할 때) working 으로 본다(질문 창을 다시 그리는 동안 '방금 출력'). 메뉴 막대가 에이전트 pane 의 화면(pane read --source visible)을 읽어 따로 가린다.
// 근거는 실측 화면의 맺음 줄(2026-10-25 · Claude Code 2.1.310 · codex-cli 0.160.0):
//   Claude 권한 질문 'Esc to cancel · Tab to amend' · 고르기 창 'Enter to select · ↑/↓ to navigate · Esc to cancel' ·
//   폴더 신뢰 'Enter to confirm · Esc to cancel' · Codex 승인 'Press enter to confirm or esc to cancel' · Codex 훅 확인 'enter confirm · esc skip'
// 맺음 줄은 화면 맨 아래 몇 줄에만 본다(대화 본문에 같은 글이 있어도 잡지 않게) · 고르는 줄(❯ · ›)도 있어야 한다
const WAIT_FOOTER = /\benter (to )?(select|confirm)\b|\besc (to )?(cancel|skip)\b/i
const WAIT_CURSOR = /^\s*[❯›]\s*\S/
const WAIT_FOOTER_LINES = 3
const WAIT_CURSOR_LINES = 20

// text: 화면 글(pane read 결과) — 입력을 기다리면 true
/** @param {unknown} text */
function waitingForInput(text) {
  const lines = String(text || '').split('\n').filter((line) => line.trim())
  const footer = lines.slice(-WAIT_FOOTER_LINES)
  if (footer.some((line) => WORKING_MARK.test(line))) return false
  if (!footer.some((line) => WAIT_FOOTER.test(line))) return false
  return lines.slice(-WAIT_CURSOR_LINES).some((line) => WAIT_CURSOR.test(line))
}

// ── 읽기 · 기다리기 ───────────────────────────────────────────────────
const DEFAULT_READ_LINES = 200

// 버퍼 줄들 → 읽을 글. 줄 끝 공백과 끝의 빈 줄을 떼고 마지막 N 줄
/**
 * @param {string[] | null | undefined} lines
 * @param {number} [count]
 */
function formatRead(lines, count = DEFAULT_READ_LINES) {
  const trimmed = (lines || []).map((line) => line.replace(/\s+$/, ''))
  while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop()
  const limit = Number.isInteger(count) && count > 0 ? count : DEFAULT_READ_LINES
  const picked = trimmed.slice(-limit)
  return picked.length ? `${picked.join('\n')}\n` : ''
}

// 맞으면 맞은 글, 아니면 null. regex 가 잘못됐으면 예외(부르는 쪽이 usage 로)
/**
 * @param {string} text
 * @param {{ match?: unknown, regex?: unknown }} pattern
 */
function findMatch(text, { match, regex }) {
  if (typeof match === 'string' && match) return text.includes(match) ? match : null
  if (typeof regex === 'string' && regex) {
    const found = new RegExp(regex, 'm').exec(text)
    return found ? found[0] : null
  }
  throw new Error('--match 또는 --regex 가 필요하다')
}

module.exports = {
  idsPath,
  PANE_KEYS,
  createIdGen,
  flatPane,
  keyBytes,
  AGENTS,
  parsePs,
  foregroundGroup,
  isShellIdle,
  detectAgent,
  QUIET_MS,
  agentStatus,
  waitingForInput,
  DEFAULT_READ_LINES,
  formatRead,
  findMatch,
}
