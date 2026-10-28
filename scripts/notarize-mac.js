// @ts-check
// 맥 배포판 공증 · staple — 공증(notarytool)은 꼭 성공해야 하고, staple 은 넉넉히 다시 시도하되 끝내 안 붙어도 빌드를 멈추지 않는다
//   GitHub macOS 러너 → Apple CloudKit(api.apple-cloudkit.com ticket lookup) 연결이 자주 끊겨(NSURLError -1005 · Error 68)
//   공증은 Accepted 인데 staple 만 지는 일이 잦다(실행 40636468435 .dmg · 40645585766 .app). 못 붙인 것은 staple.json 에 false 로 남기고
//   공개 레포에 올리기 전에 scripts/publish-release.js 가 이 맥에서 .dmg 에 다시 붙인다(티켓만 받는다 — 자격 증명 필요 없음)
//
//   electron-builder 의 공증(@electron/notarize)은 staple 이 지면 빌드가 멈춘다(다시 시도 3번 · 1 · 2 · 4초) — 그래서 package-mac.js 는
//   mac.notarize 를 끄고 afterSign 훅으로 이 파일의 afterSign 을 건다(.app 서명 직후 · .dmg · .zip 을 만들기 전 — 예전 공증과 같은 자리)
//
//   node scripts/notarize-mac.js staple [--record <폴더>] <파일>…   staple + validate 를 다시 시도 · 못 붙여도 0 으로 끝난다(경고만)
//     --record 면 <폴더>/staple.json 에 파일 이름(그 폴더 기준) → true · false 를 적는다
// 쓰는 것은 node 내장 · xcrun 뿐(package-mac.js · release-files.js 가 npm ci 전에도 읽힌다). 순수 부분은 test/notarize-mac.test.js
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const STATUS_FILE = 'staple.json'
// CI — 60초 간격 5번(기다림 최대 4분 · 파일 4개면 16분). 못 붙여도 올리기 전에 로컬에서 다시 붙이니 실행 시간을 더 늘리지 않는다
const CI_RETRY = { tries: 5, delayMs: 60_000 }
// 공증 키 — electron-builder 관례 이름(package-mac.js SIGNING_ENV · 워크플로가 APPLE_API_KEY_P8 을 파일로 써서 APPLE_API_KEY 경로로)
const NOTARY_ENV = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']

/** @typedef {{ code: number, output: string }} RunResult */
/** @typedef {{ tries: number, delayMs: number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void }} RetryOptions */

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// GitHub Actions 면 주석(::warning::)으로 — 실행 요약에 뜬다
/** @param {string} message */
function warn(message) {
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `[notarize] 경고: ${message}`)
}

/**
 * 성공할 때까지 다시 시도 — 성공하면 true · tries 번 모두 지면 false(던지지 않는다)
 * @param {() => Promise<boolean>} task
 * @param {RetryOptions} options
 */
async function retry(task, { tries, delayMs, sleep: wait = sleep, log = warn }) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    if (await task()) return true
    if (attempt < tries) {
      log(`다시 시도 ${attempt}/${tries - 1} (${Math.round(delayMs / 1000)}초 뒤)`)
      await wait(delayMs)
    }
  }
  return false
}

// notarytool submit 결과에 Accepted 줄이 있는지(텍스트 출력 — 실행 40636468435 로그와 같은 꼴 '  status: Accepted')
/** @param {string} output */
function accepted(output) {
  return /^\s*status: Accepted\s*$/m.test(output)
}

/** @param {string} output */
function submissionId(output) {
  const match = /^\s*id: (\S+)\s*$/m.exec(output)
  return match ? match[1] : null
}

// 공증 키 환경 변수 — 셋 다 있으면 'all' · 하나도 없으면 'none' · 일부만이면 빠진 이름들
/** @param {Record<string, string | undefined>} env @returns {'all' | 'none' | string[]} */
function notaryEnv(env) {
  const missing = NOTARY_ENV.filter((name) => !env[name])
  if (!missing.length) return 'all'
  return missing.length === NOTARY_ENV.length ? 'none' : missing
}

/** @param {Record<string, string | undefined>} env */
function notaryAuth(env) {
  return ['--key', String(env.APPLE_API_KEY), '--key-id', String(env.APPLE_API_KEY_ID), '--issuer', String(env.APPLE_API_ISSUER)]
}

// 명령을 돌려 출력을 그대로 보이면서 모은다 · 셸을 거치지 않는다
/** @param {string} command @param {string[]} args @param {{ echo?: boolean }} [options] @returns {Promise<RunResult>} */
function run(command, args, { echo = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    /** @param {Buffer} chunk */
    const take = (chunk) => {
      const text = chunk.toString()
      output += text
      if (echo) process.stdout.write(text)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (error) => resolve({ code: 127, output: `${output}${error.message}\n` }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

/**
 * notarytool 로 공증하고 기다린다 — Accepted 가 아니면 애플 로그를 찍고 던진다(공증은 꼭 성공해야 한다)
 * @param {string} file .zip · .dmg (.app 은 부르는 쪽이 ditto 로 .zip 으로 묶어 넘긴다)
 * @param {Record<string, string | undefined>} env
 */
async function notarize(file, env) {
  console.log(`[notarize] 공증 올림 · 기다림: ${path.basename(file)}`)
  const result = await run('xcrun', ['notarytool', 'submit', file, ...notaryAuth(env), '--wait', '--timeout', '30m'])
  if (accepted(result.output)) return
  const id = submissionId(result.output)
  if (id) await run('xcrun', ['notarytool', 'log', id, ...notaryAuth(env)])
  throw new Error(`공증 실패: ${path.basename(file)}${id ? ` (id ${id} — 위 notarytool log)` : ''}`)
}

/**
 * staple 하고 validate 까지 — 둘 다 CloudKit 에 묻는다. 한 번 시도 = staple → validate. 끝내 지면 false
 * @param {string} file .app · .dmg
 * @param {RetryOptions & { runner?: typeof run }} options
 */
async function staple(file, { runner = run, ...retryOptions }) {
  const name = path.basename(file)
  const ok = await retry(async () => {
    const stapled = await runner('xcrun', ['stapler', 'staple', '-v', file])
    if (stapled.code !== 0) return false
    return (await runner('xcrun', ['stapler', 'validate', file])).code === 0
  }, retryOptions)
  if (ok) console.log(`[notarize] staple 됨: ${name}`)
  return ok
}

// CI 에서 끝내 못 붙였을 때 — 멈추지 않고 알린다
/** @param {string} name */
function warnUnstapled(name) {
  warn(`미staple(공증은 됨): ${name} — 올리기 전에 publish-release.js 가 이 맥에서 .dmg 에 다시 붙인다`)
}

// staple.json 에 한 줄 더하기(있으면 바꾸기) — 칩마다 차례로 불리니 읽고 쓰기가 겹치지 않는다
/** @param {string} dir @param {string} name @param {boolean} ok */
function recordStaple(dir, name, ok) {
  const file = path.join(dir, STATUS_FILE)
  const current = readStaple(dir) || {}
  current[name] = ok
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`)
}

// staple.json — 없거나 모양이 아니면 null(옛 artifact 에는 없다)
/** @param {string} dir @returns {Record<string, boolean> | null} */
function readStaple(dir) {
  const file = path.join(dir, STATUS_FILE)
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === 'boolean'))
  } catch {
    return null
  }
}

/**
 * electron-builder afterSign 훅 — 서명된 .app 을 공증하고 staple 을 다시 시도한다. 결과는 recordName(이 .app 을 담을 .zip 이름)으로 staple.json 에
 * 공증 키가 하나도 없으면 공증하지 않는다(서명만 하는 로컬 판) · 일부만 있으면 멈춘다(electron-builder 와 같은 규칙)
 * @param {{ appOutDir: string, outDir: string, packager: { appInfo: { productFilename: string } } }} context
 * @param {{ recordName: string, env?: Record<string, string | undefined>, retryOptions?: RetryOptions }} options
 */
async function afterSign(context, { recordName, env = process.env, retryOptions = CI_RETRY }) {
  const state = notaryEnv(env)
  if (state === 'none') {
    console.log('[notarize] 공증 키(APPLE_API_KEY · APPLE_API_KEY_ID · APPLE_API_ISSUER)가 없다 — .app 공증을 건너뛴다')
    return
  }
  if (state !== 'all') throw new Error(`공증 키 중 빈 것: ${state.join(' · ')}`)
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // notarytool 은 .app 을 바로 받지 않는다 — ditto 로 묶어 올리고(electron-builder · @electron/notarize 와 같은 방법) 공증 뒤 지운다
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-notarize-'))
  try {
    const zip = path.join(work, `${path.basename(appPath, '.app')}.zip`)
    const zipped = await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip])
    if (zipped.code !== 0) throw new Error(`ditto 로 묶지 못했다: ${appPath}`)
    await notarize(zip, env)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  console.log(`[notarize] 공증 됨(Accepted): ${appPath}`)
  const ok = await staple(appPath, retryOptions)
  if (!ok) warnUnstapled(`${appPath} (${recordName})`)
  recordStaple(context.outDir, recordName, ok)
}

/** @param {string[]} args */
async function main(args) {
  const [command, ...rest] = args
  if (command !== 'staple') throw new Error('명령: staple [--record <폴더>] <파일>…')
  const recordAt = rest.indexOf('--record')
  const dir = recordAt >= 0 ? rest[recordAt + 1] || '' : ''
  if (recordAt >= 0 && !dir) throw new Error('--record <폴더>')
  const targets = rest.filter((_, index) => recordAt < 0 || (index !== recordAt && index !== recordAt + 1))
  if (!targets.length) throw new Error('staple 할 파일이 없다')
  for (const file of targets) {
    if (!fs.existsSync(file)) throw new Error(`파일이 없다: ${file}`)
    const ok = await staple(file, CI_RETRY)
    if (!ok) warnUnstapled(file)
    if (dir) recordStaple(dir, path.relative(dir, file), ok)
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[notarize] 실패: ${error && error.message ? error.message : error}`)
    process.exit(1)
  })
}

module.exports = { STATUS_FILE, CI_RETRY, retry, accepted, submissionId, notaryEnv, run, notarize, staple, recordStaple, readStaple, afterSign }
