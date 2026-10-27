// @ts-check
// 앱·CLI ↔ 데몬 통신 — 유닉스 소켓 위의 줄 단위 JSON. 그리고 데몬 CLI(athena-studio-cli) 인자 해석.
// 데몬 CLI 는 코어(athena/)의 studio 화면 계층이 부른다 — 바꾸면 그쪽도 같이
//
// 요청  {id, op, args}            → 응답 {id, ok: true, result} | {id, ok: false, error: {code, message}}
// 알림  {event, ...}  (데몬 → 앱: 출력 · 배치 바뀜 · resync · open-url {url} — 아테나 화면 계층이 주소를 그 창에서 열어 달라고 할 때)
// 첫 요청은 hello {protocol, appVersion} — 프로토콜 번호만 비교한다(S3)

// 데몬과 앱(·CLI)이 서로 알아듣는 형식이 바뀌면 올린다(요청 하나를 더해도). 앱 버전이 아니다
// 안 올리면 옛 데몬을 앱이 맞는 데몬으로 보고 붙어, 새 요청이 '모르는 동작' 으로 실패한다
// 4 — 'pane pids'(팩 바꾸기 전 점검 · e23b039) · 3 까지의 데몬은 모른다
// 5 — 창-본체 묶음: attach {body} · 작업 공간 body · 보는 자리(활성 작업 공간 · 포커스)가 본체마다 ·
//     상태 · 출력 · 목록은 그 본체 것만 · CLI 는 부른 pane 의 본체만 본다
// open-url(CLI 가 부르는 동작 · 데몬 → 앱 알림)은 번호를 올리지 않았다 — 앱이 보내는 요청이 아니라 앱은 옛 데몬에 기대지 않고,
// 옛 데몬은 CLI 에 '모르는 동작'(usage)으로 답해 아테나 화면 계층이 기본 브라우저로 떨어진다(번호를 올리면 켤 때 데몬을 다시 띄워 pane 이 모두 닫힌다)
const PROTOCOL = 5

const ERROR_CODES = ['usage', 'not_found', 'timeout', 'unavailable', 'internal']

/** @param {unknown} message */
function encode(message) {
  return `${JSON.stringify(message)}\n`
}

// 조각으로 오는 글을 줄로 모아 JSON 하나씩 넘긴다. 깨진 줄은 onInvalid 로(연결을 끊지 않는다)
// 소켓은 setEncoding('utf8') 로 받는다 — 여러 바이트 글자가 조각 사이에서 잘리지 않게
/**
 * @param {(message: unknown) => void} onMessage
 * @param {(line: string) => void} [onInvalid]
 * @returns {(chunk: string) => void}
 */
function createDecoder(onMessage, onInvalid = () => {}) {
  let pending = ''
  return function feed(chunk) {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim()) {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          onInvalid(line)
          message = undefined
        }
        if (message !== undefined) onMessage(message)
      }
      newline = pending.indexOf('\n')
    }
  }
}

/**
 * @param {unknown} id
 * @param {string} code
 * @param {unknown} message
 */
function errorReply(id, code, message) {
  return { id, ok: false, error: { code: ERROR_CODES.includes(code) ? code : 'internal', message: String(message) } }
}

// hello 응답 판정: ok · mismatch(데몬을 다시 띄워야 한다 — 그러면 모든 pane 이 닫힌다, S3) · invalid
/**
 * @param {{ ok?: unknown, result?: { protocol?: unknown } | null } | null | undefined} reply
 * @param {number} [expected]
 */
function checkHello(reply, expected = PROTOCOL) {
  if (!reply || reply.ok !== true || !reply.result || !Number.isInteger(reply.result.protocol)) return 'invalid'
  return reply.result.protocol === expected ? 'ok' : 'mismatch'
}

// ── 데몬 CLI 인자 ─────────────────────────────────────────────────────
class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.code = 'usage'
  }
}

// 데몬에 못 붙으면 3 — 코어 화면 계층이 unavailable 로 옮긴다. 그 밖 실패는 1
/** @param {unknown} code */
function exitCodeFor(code) {
  return code === 'unavailable' ? 3 : 1
}

const USAGE = `athena-studio-cli — Athena Studio 데몬 (아테나 화면 계층 studio 백엔드가 부른다)
  version · self
  pane list · pane get <id> · pane current
  pane split --target <id|self|focused> --direction right|down [--ratio R] [--cwd D] [--env K=V]… [--focus|--no-focus]
  pane run <id> <낱말…> · pane send-text <id> <글> · pane send-keys <id> <키…> · pane rename <id> <이름>
  pane read <id> [--lines N] [--source visible|recent]
  pane wait-output <id> (--match T | --regex R) [--lines N] [--timeout MS]
  pane is-shell <id> · pane close <id>
  workspace list · workspace get <w> · workspace create --label L --cwd D [--focus|--no-focus]
  tab list [--workspace W] · tab get <t> · tab rename <t> <이름> · tab close <t>
  open-url <주소>  부른 pane(·ATHENA_STUDIO_BODY)의 본체에 붙은 앱 창이 연다(localhost 는 옆 브라우저) → {ok, target}`

// 뒤를 손대지 않고 그대로 넘기는 동작 — 낱말이 - 로 시작해도(screen.py raw_ops 와 같다)
const RAW_OPS = ['pane run', 'pane send-text', 'pane send-keys', 'pane rename', 'tab rename']
const VALUE_FLAGS = ['--target', '--direction', '--ratio', '--cwd', '--env', '--lines', '--source', '--match', '--regex', '--timeout', '--label', '--workspace']
const BOOL_FLAGS = ['--focus', '--no-focus']

/**
 * 옵션 이름(앞 -- 뗀 것) → 값. --env 만 여러 번 · 켜기 옵션은 true
 * @typedef {{ env?: string[], target?: string, direction?: string, ratio?: string, cwd?: string, lines?: string, source?: string,
 *   match?: string, regex?: string, timeout?: string, label?: string, workspace?: string, focus?: boolean, 'no-focus'?: boolean }} CliFlags
 */

/** @param {string[]} words */
function parseFlags(words) {
  /** @type {CliFlags} */
  const flags = {}
  /** @type {string[]} */
  const positional = []
  for (let index = 0; index < words.length; index++) {
    const word = /** @type {string} */ (words[index])
    if (VALUE_FLAGS.includes(word)) {
      if (index + 1 >= words.length) throw new UsageError(`${word} 에 값이 없다`)
      const value = /** @type {string} */ (words[++index])
      if (word === '--env') (flags.env = flags.env || []).push(value)
      // 이름을 글자로 골라 넣는다(VALUE_FLAGS · BOOL_FLAGS 안의 이름만 온다)
      else /** @type {Record<string, string | boolean>} */ (flags)[word.slice(2)] = value
    } else if (BOOL_FLAGS.includes(word)) {
      /** @type {Record<string, string | boolean>} */ (flags)[word.slice(2)] = true
    } else if (word.startsWith('--')) {
      throw new UsageError(`모르는 옵션: ${word}`)
    } else {
      positional.push(word)
    }
  }
  return { flags, positional }
}

// 정확히 count 개 — 모자라면 없다고, 남으면 남는다고 거절한다(남는 낱말을 조용히 버리면 실수가 숨는다)
/**
 * @param {string[]} positional
 * @param {number} count
 * @param {string} what
 */
function needPositional(positional, count, what) {
  if (positional.length < count) throw new UsageError(`${what} 가 없다`)
  if (positional.length > count) throw new UsageError(`남는 인자: ${positional.slice(count).join(' ')}`)
  return positional
}

/**
 * @param {string | undefined} value
 * @param {string} flag
 */
function positiveInt(value, flag) {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new UsageError(`${flag} 는 1 이상의 정수: ${value}`)
  return number
}

/** @param {CliFlags} flags */
function focusFlag(flags) {
  if (flags.focus) return true
  if (flags['no-focus']) return false
  return undefined
}

// argv(실행 파일 뒤) → {op, args} — 데몬에 보낼 요청. self·version 은 데몬에 묻지 않고 CLI 가 답한다(local: true)
/** @param {string[]} argv */
function parseCli(argv) {
  // 아래 argv[0] 은 늘 있다(빈 argv 는 첫 줄에서 돌려보낸다)
  if (!argv.length || ['-h', '--help', 'help'].includes(/** @type {string} */ (argv[0]))) return { op: 'help', local: true }
  if (argv[0] === 'version') return { op: 'version', local: true }
  if (argv[0] === 'self') return { op: 'self', local: true }
  if (argv[0] === 'open-url') {
    if (argv.length !== 2) throw new UsageError('open-url <주소>')
    return { op: 'open-url', args: { url: argv[1] } }
  }
  if (!['pane', 'tab', 'workspace'].includes(/** @type {string} */ (argv[0])) || argv.length < 2) throw new UsageError(`모르는 동작: ${argv.slice(0, 2).join(' ')}`)

  const op = `${argv[0]} ${argv[1]}`
  const rest = argv.slice(2)
  if (RAW_OPS.includes(op)) {
    if (rest.length < 2) throw new UsageError(op === 'pane send-keys' ? 'pane 과 키 가 없다' : 'pane 과 글 가 없다')
    // send-text · rename 은 글 하나(공백이 있으면 부르는 쪽이 따옴표로 묶는다) · run · send-keys 는 여러 낱말
    if (['pane send-text', 'pane rename', 'tab rename'].includes(op) && rest.length > 2) throw new UsageError(`남는 인자: ${rest.slice(2).join(' ')}`)
    const [pane, ...words] = rest
    if (op === 'pane run') return { op, args: { pane, text: words.join(' ') } }
    if (op === 'pane send-text') return { op, args: { pane, text: words[0] } }
    if (op === 'pane send-keys') return { op, args: { pane, keys: words } }
    if (op === 'tab rename') return { op, args: { tab: pane, label: words[0] } }
    return { op, args: { pane, label: words[0] } }
  }

  const { flags, positional } = parseFlags(rest)
  if (op === 'pane list' || op === 'pane current') {
    needPositional(positional, 0, 'pane')
    return { op, args: {} }
  }
  if (['pane get', 'pane is-shell', 'pane close'].includes(op)) return { op, args: { pane: needPositional(positional, 1, 'pane')[0] } }
  if (op === 'pane split') {
    needPositional(positional, 0, 'pane')
    if (!flags.target || !flags.direction) throw new UsageError('pane split --target <id|self|focused> --direction right|down')
    if (!['right', 'down'].includes(flags.direction)) throw new UsageError(`--direction 은 right · down: ${flags.direction}`)
    let ratio
    if (flags.ratio !== undefined) {
      ratio = Number(flags.ratio)
      if (!(ratio > 0 && ratio < 1)) throw new UsageError(`--ratio 는 0 과 1 사이: ${flags.ratio}`)
    }
    /** @type {Record<string, string>} */
    const env = {}
    for (const pair of flags.env || []) {
      const equals = pair.indexOf('=')
      if (equals <= 0) throw new UsageError(`--env 는 K=V: ${pair}`)
      env[pair.slice(0, equals)] = pair.slice(equals + 1)
    }
    return { op, args: { target: flags.target, direction: flags.direction, ratio, cwd: flags.cwd, env, focus: focusFlag(flags) } }
  }
  if (op === 'pane read') {
    const pane = needPositional(positional, 1, 'pane')[0]
    const source = flags.source || 'recent'
    if (!['recent', 'visible'].includes(source)) throw new UsageError(`--source 는 recent · visible: ${source}`)
    return { op, args: { pane, lines: positiveInt(flags.lines, '--lines'), source } }
  }
  if (op === 'pane wait-output') {
    const pane = needPositional(positional, 1, 'pane')[0]
    if (!flags.match && !flags.regex) throw new UsageError('pane wait-output <id> (--match T | --regex R)')
    if (flags.regex) {
      try {
        new RegExp(flags.regex)
      } catch (error) {
        throw new UsageError(`--regex 를 읽지 못했다: ${/** @type {Error} */ (error).message}`)
      }
    }
    return {
      op,
      args: { pane, match: flags.match, regex: flags.regex, lines: positiveInt(flags.lines, '--lines'), timeout: positiveInt(flags.timeout, '--timeout') },
    }
  }
  if (op === 'workspace list') {
    needPositional(positional, 0, 'workspace')
    return { op, args: {} }
  }
  if (op === 'workspace get') return { op, args: { workspace: needPositional(positional, 1, 'workspace')[0] } }
  if (op === 'workspace create') {
    needPositional(positional, 0, 'workspace')
    if (!flags.label || !flags.cwd) throw new UsageError('workspace create --label L --cwd D')
    return { op, args: { label: flags.label, cwd: flags.cwd, focus: focusFlag(flags) } }
  }
  if (op === 'tab list') {
    needPositional(positional, 0, 'tab')
    return { op, args: { workspace: flags.workspace } }
  }
  if (op === 'tab get' || op === 'tab close') return { op, args: { tab: needPositional(positional, 1, 'tab')[0] } }
  throw new UsageError(`모르는 동작: ${op}`)
}

// pane 셸이 받은 환경 변수로 답하는 self — 데몬에 묻지 않는다(screen.py self_info 와 같은 모양)
/** @param {Record<string, string | undefined>} env */
function selfInfo(env) {
  const inside = env.ATHENA_STUDIO === '1'
  return {
    inside,
    backend: 'studio',
    pane_id: inside ? env.ATHENA_STUDIO_PANE_ID || '' : '',
    tab_id: inside ? env.ATHENA_STUDIO_TAB_ID || '' : '',
    workspace_id: inside ? env.ATHENA_STUDIO_WORKSPACE_ID || '' : '',
  }
}

module.exports = {
  PROTOCOL,
  ERROR_CODES,
  encode,
  createDecoder,
  errorReply,
  checkHello,
  UsageError,
  exitCodeFor,
  USAGE,
  parseCli,
  selfInfo,
}
