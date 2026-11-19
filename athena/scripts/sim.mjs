#!/usr/bin/env node
// @ts-check
/**
 * 앱 화면 확인 도우미 — iOS 시뮬레이터(xcrun simctl · serve-sim) · Android 에뮬레이터(adb).
 * 에이전트가 앱을 열고 · 바뀐 화면으로 이동하고 · 캡처해 보고에 붙일 때 쓰고, Athena Studio 시뮬레이터 칸도 이것을 부른다.
 * 절차 · 보고 형식은 docs/knowledge/common/verify.md "앱 화면 확인" · reporting.md "앱 화면 캡처"
 *
 *   node scripts/sim.mjs list [--json]                          iOS · Android 기기 목록(켜진 것 먼저) · 도구가 없으면 그 플랫폼만 이유
 *   node scripts/sim.mjs boot <기기>                             꺼진 기기 켜기(heavy.sh 자리를 잡고) — 이미 켜졌으면 그대로
 *   node scripts/sim.mjs open <URL> [--device <기기>]            딥링크 · URL 열기(exp://… · myapp://… · https://…)
 *   node scripts/sim.mjs shot (--out <파일.png> | --plan <계획서> | --dir <폴더>) [--device <기기>] [--json]
 *                                                               화면 캡처 — --plan 이면 계획서 옆 <이름>.shots/ 에 · --dir 이면 그 폴더에(이름은 시각-플랫폼-기기)
 *   node scripts/sim.mjs tap <x> <y> [--device <기기>] [--size <너비>x<높이>]   0..1 비율 좌표 누르기
 *                                                               --size(Android · 일련번호 --device 와 함께)면 목록 · 화면 크기 읽기를 건너뛴다(Studio 칸 — 영상이 아는 크기)
 *   node scripts/sim.mjs swipe <x1> <y1> <x2> <y2> [--device <기기>] [--size …]   쓸기(Android 만 — iOS 는 serve-sim 칸에서 끈다)
 *   node scripts/sim.mjs stream [--device <기기>] [--watch-stdin]  Android 화면 영상(H.264 Annex B)을 표준 출력으로 — 끊을 때까지.
 *                                                               녹화 길이 제한 · 회전 · 해상도 바뀜이면 다시 켜 이어 준다 · --watch-stdin 이면 표준 입력이 닫힐 때 끝(Studio 칸)
 *                                                               지금 화면 크기를 표준 오류에 "size <너비>x<높이>" 한 줄로(처음 · 바뀔 때) — 칸이 tap --size 로 넘긴다
 *   node scripts/sim.mjs input --platform android --device <일련번호> [--size …] [--watch-stdin]
 *                                                               열어 둔 adb shell 하나로 누르기 · 손가락 움직임을 이어 보낸다(Studio 칸 — 쓸기가 손을 따라간다).
 *                                                               표준 입력 한 줄씩: "size <너비>x<높이>" · "tap|down|move|up <x> <y>"(0..1). 연결되면 표준 출력에 "ready"
 *   node scripts/sim.mjs serve [--device <기기>] [--json]        iOS 화면 · 입력 서버(serve-sim) 켜기 → 주소. 이미 켜졌으면 그것
 *   node scripts/sim.mjs unserve [--device <기기>]               이 기기의 serve-sim 서버만 끈다(시뮬레이터는 끄지 않는다)
 *
 *   <기기> = list 의 id(iOS UDID · Android 일련번호 · 꺼진 AVD 는 avd:<이름>) 또는 이름. --platform ios|android 로 좁힌다.
 *   --device 를 안 주면 켜진 iOS 먼저 · 다음 켜진 Android.
 *   켜져 있는 시뮬레이터 · 에뮬레이터 · Metro 는 끄지 않는다(사용자가 쓰는 중일 수 있다).
 * 종료: 0 성공 · 1 실패(이유 한 줄) · 2 인자 틀림 · 3 그 플랫폼 도구 없음(Xcode · Android SDK)
 */
import { execFile, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SERVE_SIM,
  androidDevices,
  deviceShellQuote,
  findAndroidTools,
  parseAdbDevices,
  parseAvdList,
  parseAvdName,
  parseDisplayCur,
  parseSimctlDevices,
  parseSizeOption,
  parseTouchLine,
  parseWmSize,
  pickTarget,
  planShotsDir,
  readRatio,
  screenrecordCommand,
  shotName,
  toPixel,
  touchCommand,
} from './lib/sim.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HEAVY = join(ROOT, 'scripts', 'heavy.sh')

const argv = process.argv.slice(2)
const command = argv[0] ?? ''
/** @param {string} name */
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? (argv[index + 1] ?? '') : ''
}
/** @param {string} name */
const flag = (name) => argv.includes(`--${name}`)
// 옵션 값이 아닌 위치 인자(명령 이름 뒤)
const VALUE_OPTIONS = new Set(['--device', '--platform', '--out', '--plan', '--dir', '--size'])
const positional = argv.slice(1).filter((value, index, list) => !value.startsWith('--') && !VALUE_OPTIONS.has(list[index - 1] ?? ''))
const asJson = flag('json')

class SimError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

/**
 * 명령 실행(셸 없이) — 실패하면 stderr 첫 줄로 SimError
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<string>}
 */
function run(file, args, { timeout = 60_000 } = {}) {
  return new Promise((done, fail) => {
    execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const reason = String(stderr || error.message).trim().split('\n').find(Boolean) || error.message
        fail(new SimError(`${file.split('/').pop()} ${args[0] ?? ''}: ${reason}`))
        return
      }
      done(String(stdout))
    })
  })
}

/** @param {number} ms */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ── 목록 ─────────────────────────────────────────────────
async function iosList() {
  try {
    const text = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeout: 30_000 })
    return { ok: true, reason: '', devices: parseSimctlDevices(text) }
  } catch {
    // Xcode(시뮬레이터 런타임)가 없거나 xcode-select 가 Command Line Tools 만 가리킨다
    return { ok: false, reason: 'no-xcode', devices: [] }
  }
}

async function androidList() {
  const tools = findAndroidTools(process.env)
  if (!tools.adb) return { ok: false, reason: 'no-sdk', devices: [], tools }
  const rows = parseAdbDevices(await run(tools.adb, ['devices', '-l'], { timeout: 15_000 }).catch(() => ''))
  const running = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      avd: row.serial.startsWith('emulator-') ? parseAvdName(await run(tools.adb, ['-s', row.serial, 'emu', 'avd', 'name'], { timeout: 5_000 }).catch(() => '')) : '',
    })),
  )
  const avds = tools.emulator ? parseAvdList(await run(tools.emulator, ['-list-avds'], { timeout: 15_000 }).catch(() => '')) : []
  return { ok: true, reason: '', devices: androidDevices(running, avds), tools }
}

/** @param {string} [platform] 주면 그 플랫폼만 읽는다(칸이 1초마다 부르는 Android 화면 받기가 simctl 까지 돌지 않게) */
async function lists(platform = '') {
  const skipped = { ok: false, reason: 'skipped', devices: [] }
  const [ios, android] = await Promise.all([
    platform === 'android' ? skipped : iosList(),
    platform === 'ios' ? { ...skipped, tools: { adb: '', emulator: '' } } : androidList(),
  ])
  return { ios, android }
}

/** @returns {Promise<{ target: import('./lib/sim.mjs').Target, adb: string, emulator: string }>} */
async function target() {
  const platform = option('platform')
  if (platform && platform !== 'ios' && platform !== 'android') throw new SimError('--platform 은 ios 또는 android', 2)
  const found = await lists(platform)
  if (platform === 'ios' && !found.ios.ok) throw new SimError('Xcode(iOS 시뮬레이터)가 없다 — App Store 에서 Xcode 설치 뒤 xcode-select -s /Applications/Xcode.app', 3)
  if (platform === 'android' && !found.android.ok) throw new SimError('Android SDK(adb)를 못 찾았다 — Android Studio 설치 또는 ANDROID_HOME', 3)
  // boot 은 기기를 위치 인자로도 받는다(boot <기기>)
  const device = option('device') || (command === 'boot' ? (positional[0] ?? '') : '')
  const picked = pickTarget({ ios: found.ios.devices, android: found.android.devices }, { device, platform })
  if (!picked) {
    throw new SimError(device ? `기기를 못 찾았다: ${device} — node scripts/sim.mjs list` : '켜진 시뮬레이터 · 에뮬레이터가 없다 — list 로 고르고 boot <기기>')
  }
  return { target: picked, adb: found.android.tools.adb, emulator: found.android.tools.emulator }
}

// ── 켜기 ─────────────────────────────────────────────────
/** heavy.sh 자리를 잡고 이 스크립트의 안쪽 명령을 돌린다(이미 자리를 쥔 안쪽이면 바로) */
function underHeavy(/** @type {string[]} */ args) {
  return new Promise((done, fail) => {
    const child = spawn('bash', [HEAVY, process.execPath, fileURLToPath(import.meta.url), ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done(undefined) : fail(new SimError(`켜기 실패(종료 ${code})`))))
  })
}

async function boot() {
  const { target: picked, adb, emulator } = await target()
  if (picked.device.booted) return say(`이미 켜져 있다: ${picked.device.name}`, { id: picked.device.id, booted: true })
  if (!process.env.ATHENA_HEAVY_HELD) {
    await underHeavy(['_boot', picked.platform, picked.platform === 'ios' ? picked.device.id : picked.device.avd])
  } else {
    await bootInside(picked.platform, picked.platform === 'ios' ? picked.device.id : picked.device.avd, adb, emulator)
  }
  return say(`켰다: ${picked.device.name}`, { id: picked.device.id, booted: true })
}

/**
 * heavy.sh 안에서 — 켜기를 시작하고 다 켜질 때까지 기다린다
 * @param {string} platform
 * @param {string} key iOS UDID · Android AVD 이름
 * @param {string} adb
 * @param {string} emulator
 */
async function bootInside(platform, key, adb, emulator) {
  if (platform === 'ios') {
    await run('xcrun', ['simctl', 'boot', key], { timeout: 120_000 }).catch((error) => {
      // 그사이 다른 쪽이 켰으면 괜찮다
      if (!/current state: Booted/i.test(String(error.message))) throw error
    })
    await run('xcrun', ['simctl', 'bootstatus', key, '-b'], { timeout: 300_000 })
    return
  }
  if (!emulator) throw new SimError('emulator 를 못 찾았다 — Android SDK 의 emulator 패키지', 3)
  // 에뮬레이터는 오래 산다 — 떼어 띄우고(이 스크립트가 끝나도 남는다) 다 켜질 때까지만 기다린다.
  // 출력은 임시 로그로 — 켜지다 꺼지면(시스템 이미지 없음 등) 5분 기다리지 않고 그 이유 줄로 멈춘다
  const log = join(tmpdir(), `athena-sim-emulator-${key}.log`)
  const logFd = openSync(log, 'w')
  const child = spawn(emulator, ['-avd', key], { detached: true, stdio: ['ignore', logFd, logFd] })
  closeSync(logFd)
  /** @type {number | null} */
  let exitCode = null
  child.on('exit', (code) => (exitCode = code ?? -1))
  child.unref()
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await sleep(3000)
    if (exitCode !== null) {
      const text = readFileSync(log, 'utf8')
      const reason = text.split('\n').reverse().find((line) => /\b(FATAL|ERROR)\b/.test(line)) || `종료 ${exitCode}`
      throw new SimError(`에뮬레이터가 켜지다 꺼졌다: ${reason.trim()} (로그 ${log})`)
    }
    const rows = parseAdbDevices(await run(adb, ['devices', '-l'], { timeout: 10_000 }).catch(() => ''))
    for (const row of rows.filter((item) => item.serial.startsWith('emulator-'))) {
      const name = parseAvdName(await run(adb, ['-s', row.serial, 'emu', 'avd', 'name'], { timeout: 5_000 }).catch(() => ''))
      if (name !== key) continue
      const booted = (await run(adb, ['-s', row.serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 10_000 }).catch(() => '')).trim()
      if (booted === '1') return
    }
  }
  throw new SimError(`에뮬레이터가 5분 안에 다 켜지지 않았다: ${key}`)
}

/** 꺼진 기기면 멈춘다 — 열기 · 캡처 · 누르기는 켜진 기기에만(켜는 것은 boot 로 따로) */
function needBooted(/** @type {import('./lib/sim.mjs').Target} */ picked) {
  if (!picked.device.booted) throw new SimError(`꺼져 있다: ${picked.device.name} — 먼저 node scripts/sim.mjs boot ${picked.device.id}`)
}

// ── 열기 · 캡처 · 누르기 ──────────────────────────────────
async function openUrl() {
  const url = positional[0] ?? ''
  if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(url)) throw new SimError('사용: node scripts/sim.mjs open <URL> [--device <기기>]', 2)
  const { target: picked, adb } = await target()
  needBooted(picked)
  if (picked.platform === 'ios') await run('xcrun', ['simctl', 'openurl', picked.device.id, url])
  // adb shell 은 기기 셸이 다시 읽는다 — URL 의 ; & | 가 명령이 되지 않게 감싼다
  else await run(adb, ['-s', picked.device.id, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deviceShellQuote(url)])
  return say(`열었다: ${url} → ${picked.device.name}`, { url, id: picked.device.id })
}

async function shot() {
  const out = option('out')
  const plan = option('plan')
  const dir = option('dir')
  if (!out && !plan && !dir) throw new SimError('사용: node scripts/sim.mjs shot (--out <파일.png> | --plan <계획서> | --dir <폴더>) [--device <기기>]', 2)
  const { target: picked, adb } = await target()
  needBooted(picked)
  const folder = dir ? resolve(dir) : planShotsDir(isAbsolute(plan) ? plan : resolve(plan))
  const file = out ? resolve(out) : join(folder, shotName(new Date(), picked.platform, picked.device.name))
  mkdirSync(dirname(file), { recursive: true })
  if (picked.platform === 'ios') {
    await run('xcrun', ['simctl', 'io', picked.device.id, 'screenshot', '--type=png', file])
  } else {
    // screencap 은 표준 출력으로 받아 파일에 — 기기 안에 남기지 않는다
    await new Promise((done, fail) => {
      const child = spawn('bash', ['-c', '"$0" -s "$1" exec-out screencap -p > "$2"', adb, picked.device.id, file], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('error', fail)
      child.on('exit', (code) => (code === 0 ? done(undefined) : fail(new SimError(`screencap: ${stderr.trim() || code}`))))
    })
  }
  if (statSync(file).size === 0) throw new SimError(`캡처 파일이 비었다: ${file}`)
  return say(file, { file, id: picked.device.id, platform: picked.platform, name: picked.device.name })
}

async function tapOrSwipe() {
  const swipe = command === 'swipe'
  const ratios = positional.slice(0, swipe ? 4 : 2).map(readRatio)
  if (ratios.length !== (swipe ? 4 : 2) || ratios.some((value) => value === null)) {
    throw new SimError(swipe ? '사용: node scripts/sim.mjs swipe <x1> <y1> <x2> <y2> (0..1)' : '사용: node scripts/sim.mjs tap <x> <y> (0..1)', 2)
  }
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = /** @type {number[]} */ (ratios)
  const known = await knownAndroid()
  const { target: picked, adb } = known || (await target())
  needBooted(picked)
  if (picked.platform === 'ios') {
    if (swipe) throw new SimError('iOS 쓸기는 serve-sim 으로: npx -y ' + SERVE_SIM + " gesture '<json>' -d <UDID>", 2)
    await run('npx', ['-y', SERVE_SIM, 'tap', String(x1), String(y1), '-d', picked.device.id], { timeout: 120_000 })
  } else {
    // 누르기 좌표는 지금 화면(회전 반영) 기준 — wm size 의 Physical 은 가로로 돌려도 세로 크기라 어긋난다
    const size = known ? known.size : await displaySize(adb, picked.device.id)
    if (!size) throw new SimError('화면 크기를 못 읽었다(adb shell wm size)')
    const point = (/** @type {number} */ rx, /** @type {number} */ ry) => [String(toPixel(rx, size.width)), String(toPixel(ry, size.height))]
    const args = swipe ? ['swipe', ...point(x1, y1), ...point(x2, y2), '250'] : ['tap', ...point(x1, y1)]
    await run(adb, ['-s', picked.device.id, 'shell', 'input', ...args])
  }
  return say(`${swipe ? '쓸었다' : '눌렀다'} → ${picked.device.name}`, { id: picked.device.id })
}

/**
 * 부른 쪽이 기기 · 화면 크기를 이미 안다(--platform android · 일련번호 --device · --size — Studio 칸이 영상에서 받은 크기).
 * 목록(adb 3번)과 화면 크기(dumpsys window — 부하 때 몇 초)를 건너뛴다. 기기가 없으면 adb input 이 실패로 끝난다
 */
async function knownAndroid() {
  const size = parseSizeOption(option('size'))
  const serial = option('device')
  if (!size || option('platform') !== 'android' || !serial || serial.startsWith('-') || serial.startsWith('avd:')) return null
  const { adb } = findAndroidTools(process.env)
  if (!adb) return null
  /** @type {import('./lib/sim.mjs').Target} */
  const picked = { platform: 'android', device: { id: serial, name: serial, booted: true, avd: '' } }
  return { target: picked, adb, size }
}

/**
 * Android 지금 화면 크기(회전 · wm size 반영) — dumpsys 의 cur= 를 못 읽으면 wm size
 * @param {string} adb
 * @param {string} serial
 */
async function displaySize(adb, serial) {
  const cur = parseDisplayCur(await run(adb, ['-s', serial, 'shell', 'dumpsys window displays | grep -m1 cur='], { timeout: 10_000 }).catch(() => ''))
  return cur || parseWmSize(await run(adb, ['-s', serial, 'shell', 'wm', 'size']).catch(() => ''))
}

// ── 이어 누르기(Android — Studio 칸) ─────────────────────
// 기기 셸 하나를 열어 두고 명령을 하나씩 — 끝 표시(@)가 오면 다음. 밀린 move 는 마지막 것만(늦게 따라가며 쌓이지 않게)
const INPUT_DONE = '@'
// 끝낼 때 기기 셸이 닫히기를 기다리는 시간
const INPUT_CLOSE_MS = 1_500
// adb 일련번호 모양(emulator-5554 · 192.168.0.5:5555) — 옵션으로 읽히지 않게 - 로 시작하면 안 되고 꺼진 AVD(avd:)는 아니다
const SERIAL_ID = /^(?!-|avd:)[\w.:-]{1,200}$/

async function input() {
  const serial = option('device')
  if (option('platform') !== 'android' || !SERIAL_ID.test(serial)) throw new SimError('사용: node scripts/sim.mjs input --platform android --device <일련번호> [--size <너비>x<높이>]', 2)
  const { adb } = findAndroidTools(process.env)
  if (!adb) throw new SimError('adb 를 찾지 못했다(Android SDK)', 3)
  /** @type {{ width: number, height: number } | null} */
  let size = parseSizeOption(option('size'))
  const shell = spawn(adb, ['-s', serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] })
  /** @type {string[]} */
  const queue = []
  let busy = true // 처음 끝 표시(연결 확인)를 기다린다
  let ready = false
  let fingerDown = false
  let lastPoint = { x: 0, y: 0 }
  let closing = false
  let lastError = ''

  const pump = () => {
    if (busy || !queue.length) {
      if (!busy && closing) shell.stdin?.end()
      return
    }
    busy = true
    shell.stdin?.write(`${queue.shift()}; echo ${INPUT_DONE}\n`)
  }
  // 크기를 모르면 한 번 읽는다(부른 쪽이 size 줄을 안 줬을 때)
  const sizeNow = async () => size || (size = await displaySize(adb, serial).catch(() => null))
  /** @param {import('./lib/sim.mjs').TouchLine} event */
  const handle = async (event) => {
    if (event.kind === 'size') {
      size = { width: event.width, height: event.height }
      return
    }
    const known = await sizeNow()
    if (!known) return process.stderr.write('화면 크기를 못 읽었다\n')
    if (event.kind === 'down') fingerDown = true
    if (event.kind === 'up') fingerDown = false
    if (event.kind === 'down' || event.kind === 'move') lastPoint = { x: event.x, y: event.y }
    const line = touchCommand(event.kind, event.x, event.y, known)
    // 아직 안 보낸 move 가 맨 뒤에 있으면 새 것으로 바꾼다
    if (event.kind === 'move' && queue.length && /motionevent MOVE/.test(queue[queue.length - 1] ?? '')) queue[queue.length - 1] = line
    else queue.push(line)
    pump()
  }

  /** @param {number} code */
  const finish = (code) => {
    if (closing) return
    closing = true
    // 누른 채로 끝나면 손가락을 뗀다(기기에 눌림이 남지 않게)
    if (fingerDown && size) queue.push(touchCommand('up', lastPoint.x, lastPoint.y, size))
    fingerDown = false
    pump()
    setTimeout(() => {
      shell.kill()
      process.exit(code)
    }, INPUT_CLOSE_MS).unref()
  }

  let pendingOut = ''
  shell.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
    const lines = (pendingOut + String(chunk)).split('\n')
    pendingOut = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() !== INPUT_DONE) continue
      busy = false
      if (!ready) {
        ready = true
        process.stdout.write('ready\n')
      }
      pump()
    }
  })
  shell.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
    lastError = String(chunk).trim().split('\n').find(Boolean) || lastError
  })
  // 기기 셸이 닫혔다(기기 꺼짐 · adb 끊김 · 끝내기) — 끝낼 때가 아니면 실패로
  const shellClosed = new Promise((done) => {
    shell.on('error', (error) => {
      lastError = error.message
    })
    shell.on('close', (code) => done(code))
  })
  shell.stdin?.on('error', () => {})
  shell.stdin?.write(`echo ${INPUT_DONE}\n`)

  process.on('SIGTERM', () => finish(0))
  process.on('SIGINT', () => finish(0))
  let pendingIn = ''
  process.stdin.on('data', (/** @type {Buffer} */ chunk) => {
    const lines = (pendingIn + String(chunk)).split('\n')
    pendingIn = lines.pop() ?? ''
    for (const raw of lines) {
      if (!raw.trim() || closing) continue
      const event = parseTouchLine(raw)
      if (event) void handle(event)
      else process.stderr.write(`모르는 줄: ${raw.slice(0, 80)}\n`)
    }
  })
  if (flag('watch-stdin')) process.stdin.on('end', () => finish(0))
  process.stdin.resume()

  const code = await shellClosed
  if (closing) process.exit(0)
  throw new SimError(`기기 셸이 닫혔다(adb shell ${code ?? '?'}): ${lastError || '이유 모름'}`)
}

// ── 화면 영상(Android) ─────────────────────────────────────
// 다시 켜기가 이만큼 안에 끝나면 "바로 끝남" — 연달아 이만큼 나면 포기(기기가 녹화를 못 한다)
const QUICK_EXIT_MS = 2_000
const QUICK_EXIT_LIMIT = 3
// 회전 · 해상도 바뀜을 보는 사이(녹화 도중 회전하면 크기 그대로 옆으로 누운 그림이 된다 — 새로 켜야 맞는 크기)
const SIZE_WATCH_MS = 1_500

async function stream() {
  const { target: picked, adb } = await target()
  if (picked.platform !== 'android') throw new SimError('stream 은 Android 만 — iOS 는 serve', 2)
  needBooted(picked)
  const serial = picked.device.id
  // 길이 제한 없애기는 v1.4 쯤부터 — 도움말로 가른다(없으면 180초마다 다시 켠다)
  const help = await run(adb, ['-s', serial, 'shell', 'screenrecord --help 2>&1'], { timeout: 10_000 }).catch(() => '')
  const command = screenrecordCommand(/Set to 0/.test(help))
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let devicePid = ''
  let stopping = false
  // 지금 크기를 칸에 알린다(tap --size 로 돌아온다) — 못 읽었으면 알리지 않는다(칸은 tap 이 스스로 읽게 둔다)
  /** @param {{ width: number, height: number } | null} value */
  const tellSize = (value) => {
    if (value) process.stderr.write(`size ${value.width}x${value.height}\n`)
  }
  const first = await displaySize(adb, serial)
  let size = JSON.stringify(first)
  tellSize(first)

  // 기기 안 녹화를 끈다(adb 를 끊는 것만으로는 남는다) — pid 는 숫자만
  const stopDevice = async () => {
    const pid = devicePid
    devicePid = ''
    if (/^\d+$/.test(pid)) await run(adb, ['-s', serial, 'shell', 'kill', pid], { timeout: 5_000 }).catch(() => '')
  }
  const restart = async () => {
    await stopDevice()
    child?.kill()
  }
  /** @param {number} code */
  const finish = async (code) => {
    if (stopping) return
    stopping = true
    await stopDevice()
    child?.kill()
    process.exit(code)
  }
  process.on('SIGTERM', () => void finish(0))
  process.on('SIGINT', () => void finish(0))
  // 읽는 쪽이 사라졌다(파이프 닫힘)
  process.stdout.on('error', () => void finish(0))
  if (flag('watch-stdin')) {
    process.stdin.on('end', () => void finish(0))
    process.stdin.on('close', () => void finish(0))
    process.stdin.resume()
  }

  // 회전 · 해상도 감시 — 바뀌면 지금 녹화를 끊어 아래 반복이 새 크기로 다시 켠다
  const watch = async () => {
    while (!stopping) {
      await sleep(SIZE_WATCH_MS)
      const now = await displaySize(adb, serial).catch(() => null)
      if (!now || stopping) continue
      const next = JSON.stringify(now)
      if (next === size) continue
      size = next
      tellSize(now)
      await restart()
    }
  }
  void watch()

  let quickExits = 0
  let lastError = ''
  while (!stopping) {
    const began = Date.now()
    const exitCode = await new Promise((done) => {
      const proc = spawn(adb, ['-s', serial, 'exec-out', command], { stdio: ['ignore', 'pipe', 'pipe'] })
      child = proc
      let head = Buffer.alloc(0)
      let headDone = false
      // 받는 쪽(main)이 늦으면 쌓이지 않게 — write 가 false 면 adb 출력을 멈추고 비워지면 다시 받는다
      let paused = false
      const forward = (/** @type {Buffer} */ bytes) => {
        if (process.stdout.write(bytes) || paused) return
        paused = true
        proc.stdout?.pause()
        process.stdout.once('drain', () => {
          paused = false
          proc.stdout?.resume()
        })
      }
      proc.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
        if (headDone) {
          forward(chunk)
          return
        }
        // 첫 줄 = 기기 셸 pid(screenrecordCommand) · 그 뒤가 영상
        head = Buffer.concat([head, chunk])
        const newline = head.indexOf(10)
        if (newline < 0) {
          if (head.length > 64) headDone = true // pid 줄이 아니다 — 그대로 넘긴다
          else return
        } else {
          devicePid = head.subarray(0, newline).toString('utf8').trim()
          head = head.subarray(newline + 1)
          headDone = true
        }
        if (head.length) forward(head)
      })
      proc.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
        lastError = String(chunk).trim().split('\n').find(Boolean) || lastError
      })
      proc.on('error', (error) => {
        lastError = error.message
        done(1)
      })
      proc.on('exit', (code) => done(code ?? 1))
    })
    child = null
    devicePid = ''
    if (stopping) break
    quickExits = Date.now() - began < QUICK_EXIT_MS ? quickExits + 1 : 0
    if (quickExits >= QUICK_EXIT_LIMIT) {
      stopping = true
      throw new SimError(`화면 녹화가 바로 끝났다(screenrecord ${exitCode}): ${lastError || '이유 모름'}`)
    }
  }
}

// ── serve-sim(iOS 화면 · 입력 서버) ───────────────────────
async function serve() {
  const { target: picked } = await target()
  if (picked.platform !== 'ios') throw new SimError('serve 는 iOS 만 — Android 는 shot · tap 으로', 2)
  needBooted(picked)
  // --detach 는 같은 기기에 켜진 서버가 있으면 그것을 돌려준다. --exit-on-simulator-shutdown 은 넘기지 않아 시뮬레이터가 꺼져도 서버는 남는다 — 끄는 것은 unserve
  const text = await run('npx', ['-y', SERVE_SIM, '--detach', '-q', picked.device.id], { timeout: 180_000 })
  const line = text.trim().split('\n').reverse().find((row) => row.startsWith('{'))
  /** @type {{ url?: unknown }} */
  let info = {}
  try {
    info = JSON.parse(line || '{}')
  } catch {
    // 아래에서 주소 없음으로
  }
  const url = typeof info.url === 'string' ? info.url : ''
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) throw new SimError(`serve-sim 이 주소를 내지 않았다: ${(line || text).slice(0, 200)}`)
  return say(url, { url, id: picked.device.id, name: picked.device.name })
}

async function unserve() {
  const { target: picked } = await target()
  if (picked.platform !== 'ios') throw new SimError('unserve 는 iOS 만', 2)
  await run('npx', ['-y', SERVE_SIM, '--kill', picked.device.id], { timeout: 60_000 })
  return say(`serve-sim 서버를 껐다(시뮬레이터는 그대로): ${picked.device.name}`, { id: picked.device.id })
}

// ── 출력 ─────────────────────────────────────────────────
/**
 * @param {string} text 사람에게
 * @param {Record<string, unknown>} data --json 일 때
 */
function say(text, data) {
  console.log(asJson ? JSON.stringify({ ok: true, ...data }) : text)
}

async function list() {
  const found = await lists()
  const result = {
    ios: { ok: found.ios.ok, reason: found.ios.reason, devices: found.ios.devices },
    android: { ok: found.android.ok, reason: found.android.reason, devices: found.android.devices },
  }
  if (asJson) return console.log(JSON.stringify({ ok: true, ...result }))
  for (const [platform, entry] of Object.entries(result)) {
    if (!entry.ok) {
      console.log(`${platform}: 없음(${entry.reason === 'no-xcode' ? 'Xcode 없음' : 'Android SDK · adb 없음'})`)
      continue
    }
    console.log(`${platform}: ${entry.devices.length}대`)
    for (const device of entry.devices) console.log(`  ${device.booted ? '●' : '○'} ${device.name}${'os' in device ? ` (${device.os})` : ''}  ${device.id}`)
  }
}

const COMMANDS = /** @type {Record<string, () => Promise<unknown>>} */ ({ list, boot, open: openUrl, shot, tap: tapOrSwipe, swipe: tapOrSwipe, input, stream, serve, unserve })

async function main() {
  if (command === '_boot') {
    // heavy.sh 안쪽 — boot 가 자리를 잡고 부른다
    const [, platform = '', key = ''] = argv
    const tools = findAndroidTools(process.env)
    await bootInside(platform, key, tools.adb, tools.emulator)
    return
  }
  const handler = COMMANDS[command]
  if (!handler) throw new SimError('사용: node scripts/sim.mjs <list|boot|open|shot|tap|swipe|input|stream|serve|unserve> … (자세히 파일 맨 위)', 2)
  await handler()
}

main().catch((error) => {
  const code = error instanceof SimError ? error.code : 1
  const message = error instanceof Error ? error.message : String(error)
  if (asJson) console.log(JSON.stringify({ ok: false, code, error: message }))
  else console.error(`❌ ${message}`)
  process.exit(code)
})
