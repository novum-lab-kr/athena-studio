// 데몬의 순수 로직 — pane 정보를 화면 계층(아테나 scripts/lib/screen.py)의 납작한 JSON 으로 · 키 이름 · 에이전트 판정 · 읽기.
// pty·소켓 없이 테스트한다(test/screen-model.test.js).
const path = require('path')

// 납작한 Pane 의 키 — screen.py `_pane` 과 같은 12개, 같은 순서
const PANE_KEYS = ['id', 'tab_id', 'workspace_id', 'label', 'name', 'pane_title', 'cwd', 'foreground_cwd', 'focused', 'agent', 'agent_status', 'title']

// id 는 다시 쓰지 않는다. [\w:] 만 · 'hermes' 로 시작하지 않는다(현황판의 가짜 id)
// start 로 지난 데몬이 남긴 번호를 받아 이어서 센다 — 데몬을 다시 띄워도 p1 부터 다시 매기지 않게(계획서에 남은 옛 pane id 가 새 pane 을 가리키지 않게).
// onChange 는 번호가 바뀔 때마다 지금 번호 전체를 받는다(데몬이 파일에 남긴다)
function createIdGen(start = {}, onChange = null) {
  const counters = {}
  for (const [prefix, value] of Object.entries(start && typeof start === 'object' ? start : {})) {
    if (/^\w+$/.test(prefix) && Number.isSafeInteger(value) && value > 0) counters[prefix] = value
  }
  return {
    next(prefix) {
      counters[prefix] = (counters[prefix] || 0) + 1
      if (onChange) onChange({ ...counters })
      return `${prefix}${counters[prefix]}`
    },
  }
}

// 데몬이 id 번호를 남기는 파일 — 접속 파일 옆 <이름>-ids.json(앱마다 접속 파일이 달라 개발 앱 · 배포판이 섞이지 않는다)
const idsPath = (endpoint) => endpoint.replace(/\.json$/, '') + '-ids.json'

// 빈 글자는 null — screen.py 가 `or None` 으로 하던 그대로
const orNull = (value) => (value === undefined || value === null || value === '' ? null : value)

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
  }
}

// ── 키 이름 → pty 에 쓸 글자 (herdr send-keys 와 같은 이름) ─────────────
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
function keyBytes(name) {
  if (typeof name !== 'string' || !name) return null
  const named = NAMED_KEYS[name.toLowerCase()]
  if (named) return named
  const control = name.match(/^C-(.)$/i)
  if (!control) return null
  const code = control[1].toUpperCase().charCodeAt(0)
  // C-@ · C-a…z · C-[ · C-\ · C-] · C-^ · C-_ → 0x00…0x1f
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40)
  if (control[1] === '?') return '\x7f'
  return null
}

// ── 프로세스 → agent · 빈 셸 ──────────────────────────────────────────
const AGENTS = ['claude', 'codex']

// `ps -axo pid=,pgid=,tpgid=,comm=` 한 줄씩. comm 은 마지막 칸이라 공백이 있어도 끝까지 하나로 읽는다
function parsePs(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), pgid: Number(match[2]), tpgid: Number(match[3]), comm: match[4] })
  }
  return rows
}

// 셸의 앞쪽(포그라운드) 프로세스 그룹 — 셸 자신이 앞이거나 모르면 null
function foregroundGroup(processes, shellPid) {
  const shell = processes.find((row) => row.pid === shellPid)
  if (!shell || shell.tpgid <= 0 || shell.tpgid === shell.pgid) return null
  return shell.tpgid
}

// 빈 셸(프롬프트에서 대기)인가 — 확인 못 하면 false(돌고 있는 것을 건드리지 않는 쪽으로, screen.py is_shell 과 같다)
function isShellIdle(processes, shellPid) {
  const shell = processes.find((row) => row.pid === shellPid)
  return Boolean(shell) && shell.tpgid > 0 && shell.tpgid === shell.pgid
}

// 앞쪽 그룹 안에 claude·codex 가 있으면 그 이름. node-pty `.process` 는 실제 파일 이름이라 쓰지 않는다
// (claude 는 ~/.local/share/claude/versions/<버전> 으로 풀려 '2.1.302' 로 보인다 — ps comm 은 'claude').
// comm 이 node 인 프로세스(npm 판 codex)는 argsOf(pid) 로 두 번째 낱말을 본다 — 앞쪽 그룹 안에서만 묻는다
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
function agentStatus({ agent, screenLines, lastOutputAt, now }) {
  if (!agent) return 'unknown'
  const tail = (screenLines || []).filter((line) => line.trim()).slice(-STATUS_TAIL_LINES)
  if (tail.some((line) => WORKING_MARK.test(line))) return 'working'
  if (lastOutputAt && now - lastOutputAt < QUIET_MS) return 'working'
  return 'idle'
}

// ── 읽기 · 기다리기 ───────────────────────────────────────────────────
const DEFAULT_READ_LINES = 200

// 버퍼 줄들 → 읽을 글. 줄 끝 공백과 끝의 빈 줄을 떼고 마지막 N 줄
function formatRead(lines, count = DEFAULT_READ_LINES) {
  const trimmed = (lines || []).map((line) => line.replace(/\s+$/, ''))
  while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop()
  const limit = Number.isInteger(count) && count > 0 ? count : DEFAULT_READ_LINES
  const picked = trimmed.slice(-limit)
  return picked.length ? `${picked.join('\n')}\n` : ''
}

// 맞으면 맞은 글, 아니면 null. regex 가 잘못됐으면 예외(부르는 쪽이 usage 로)
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
  DEFAULT_READ_LINES,
  formatRead,
  findMatch,
}
