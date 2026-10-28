// @ts-check
// athena-studio-cli — 아테나 화면 계층(scripts/lib/screen.py studio 백엔드)이 부르는 데몬 CLI.
// 출력은 화면 계층의 납작한 JSON 그대로(stdout 한 줄). 실패는 종료 1(데몬에 못 붙으면 3) + stderr {"error","message"}.
// 소켓 찾기: ATHENA_STUDIO_SOCKET(pane 셸) → 접속 파일 ~/.athena-studio/daemon.json(pane 밖, S4)
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const protocol = require('../lib/protocol')

/** @typedef {Record<string, string | undefined>} Env */
// 데몬 답 한 줄(소켓 JSON 그대로 — 모양 검사는 하지 않는다)
// result 는 동작마다 다르다 — CLI 가 보는 칸만(pane is-shell 의 shell · pane read 의 text)
/** @typedef {{ shell?: unknown, text?: unknown } | null} Result */
/** @typedef {{ id?: unknown, ok?: boolean, result: Result, error: { code: string, message: string } }} Reply */
// 실패 — code 는 protocol.ERROR_CODES 하나(못 붙으면 unavailable)
/** @typedef {Error & { code?: string }} Failure */

// ATHENA_STUDIO_ENDPOINT — 격리 실행(개발 · 회귀 검사)의 접속 파일 자리(앱 · 아테나 screen.py 와 같은 변수)
const ENDPOINT = process.env.ATHENA_STUDIO_ENDPOINT || path.join(os.homedir(), '.athena-studio', 'daemon.json')

/** @param {Env} env */
function socketPath(env) {
  if (env.ATHENA_STUDIO_SOCKET) return env.ATHENA_STUDIO_SOCKET
  try {
    return JSON.parse(fs.readFileSync(ENDPOINT, 'utf8')).socket || null
  } catch {
    return null
  }
}

/**
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) {
  process.stderr.write(`${JSON.stringify({ error: code, message })}\n`)
  process.exitCode = protocol.exitCodeFor(code)
}

/**
 * @param {string} socket
 * @param {string} op
 * @param {unknown} args
 * @param {string | null} caller
 * @param {string | null} body
 * @returns {Promise<Result>}
 */
function request(socket, op, args, caller, body) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket)
    connection.setEncoding('utf8')
    connection.once('error', (/** @type {Error & { code?: string }} */ error) => reject(Object.assign(new Error(`데몬에 붙지 못했다(${error.code || error.message}): ${socket}`), { code: 'unavailable' })))
    connection.on(
      'data',
      protocol.createDecoder((decoded) => {
        const message = /** @type {Reply} */ (decoded)
        if (message.id !== 1) return
        connection.end()
        if (message.ok) resolve(message.result)
        else reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      }),
    )
    connection.once('connect', () => connection.write(protocol.encode({ id: 1, op, args, caller, body })))
    connection.once('close', () => reject(Object.assign(new Error('데몬이 답하지 않고 연결을 닫았다'), { code: 'unavailable' })))
  })
}

/**
 * @param {string[]} argv
 * @param {Env} env
 */
async function main(argv, env) {
  let parsed
  try {
    parsed = protocol.parseCli(argv)
  } catch (caught) {
    const error = /** @type {Failure} */ (caught)
    return fail(error.code || 'usage', error.message)
  }
  if (parsed.op === 'help') {
    process.stdout.write(`${protocol.USAGE}\n`)
    return undefined
  }
  if (parsed.op === 'self') {
    process.stdout.write(`${JSON.stringify(protocol.selfInfo(env))}\n`)
    return undefined
  }
  if (parsed.op === 'version') {
    process.stdout.write(`${JSON.stringify({ protocol: protocol.PROTOCOL, cliVersion: require('../../package.json').version })}\n`)
    return undefined
  }
  const socket = socketPath(env)
  if (!socket) return fail('unavailable', 'Athena Studio 데몬을 찾지 못했다(ATHENA_STUDIO_SOCKET · ~/.athena-studio/daemon.json 없음)')
  /** @type {Result} */
  let result
  try {
    // 부른 pane 이 없을 때(현황판 등 pane 밖) 어느 본체(팩) 것인지 — 앱이 현황판 환경에 넣는다(protocol 5)
    result = await request(socket, parsed.op, parsed.args, env.ATHENA_STUDIO_PANE_ID || null, env.ATHENA_STUDIO_BODY || null)
  } catch (caught) {
    const error = /** @type {Failure} */ (caught)
    return fail(error.code || 'internal', error.message)
  }
  if (parsed.op === 'pane is-shell') {
    process.exitCode = result && result.shell ? 0 : 1
    return undefined
  }
  if (result && typeof result.text === 'string') process.stdout.write(result.text)
  else if (result) process.stdout.write(`${JSON.stringify(result)}\n`)
  return undefined
}

main(process.argv.slice(2), process.env)
