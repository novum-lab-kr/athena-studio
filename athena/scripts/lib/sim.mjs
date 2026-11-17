// @ts-check
// 시뮬레이터 · 에뮬레이터 도우미의 순수 로직 — 명령 출력 읽기 · 기기 고르기 · 좌표 · 캡처 경로.
// 명령을 부르는 쪽은 scripts/sim.mjs(에이전트 · Athena Studio 시뮬레이터 칸이 같이 쓴다). 시험은 앱 레포 test/sim.test.js
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// serve-sim 판을 고정한다 — 칸과 에이전트가 같은 판을 쓰고, 새 판은 확인한 뒤 올린다(계획서 D5 · D6)
export const SERVE_SIM = 'serve-sim@0.1.49'

/** @typedef {{ id: string, name: string, os: string, booted: boolean }} IosDevice */
/** @typedef {{ id: string, name: string, booted: boolean, avd: string }} AndroidDevice */
/** @typedef {{ platform: 'ios', device: IosDevice } | { platform: 'android', device: AndroidDevice }} Target */

/**
 * `xcrun simctl list devices available -j` → iOS 기기(iPhone · iPad). 켜진 기기가 먼저
 * @param {string} text
 * @returns {IosDevice[]}
 */
export function parseSimctlDevices(text) {
  /** @type {unknown} */
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const groups = data && typeof data === 'object' && 'devices' in data ? /** @type {Record<string, unknown>} */ (data.devices) : null
  if (!groups || typeof groups !== 'object') return []
  /** @type {IosDevice[]} */
  const devices = []
  for (const [runtime, list] of Object.entries(groups)) {
    // com.apple.CoreSimulator.SimRuntime.iOS-17-5 → iOS 17.5 (watchOS · tvOS · visionOS 는 뺀다)
    const match = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime)
    if (!match || !Array.isArray(list)) continue
    for (const item of list) {
      if (!item || typeof item.udid !== 'string' || typeof item.name !== 'string') continue
      if (item.isAvailable === false) continue
      devices.push({ id: item.udid, name: item.name, os: `iOS ${match[1]}.${match[2]}`, booted: item.state === 'Booted' })
    }
  }
  return devices.sort((left, right) => Number(right.booted) - Number(left.booted))
}

/**
 * `adb devices -l` → 연결된 기기 일련번호 · 이름(model). 준비 안 된 것(offline · unauthorized)은 뺀다
 * @param {string} text
 * @returns {{ serial: string, model: string }[]}
 */
export function parseAdbDevices(text) {
  /** @type {{ serial: string, model: string }[]} */
  const rows = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2 || parts[1] !== 'device') continue
    const model = parts.find((part) => part.startsWith('model:'))
    rows.push({ serial: parts[0] ?? '', model: model ? model.slice('model:'.length).replaceAll('_', ' ') : (parts[0] ?? '') })
  }
  return rows
}

/**
 * `emulator -list-avds` → AVD 이름(빈 줄 · 로그 줄은 뺀다)
 * @param {string} text
 */
export function parseAvdList(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+$/.test(line))
}

/**
 * `adb emu avd name` → 첫 줄(AVD 이름) · 끝의 OK 는 버린다
 * @param {string} text
 */
export function parseAvdName(text) {
  const first = text.split('\n').map((line) => line.trim()).find((line) => line && line !== 'OK')
  return first || ''
}

/**
 * 켜진 기기(adb) + 꺼진 AVD 를 한 목록으로 — 꺼진 AVD 는 id 를 `avd:<이름>` 으로
 * @param {{ serial: string, model: string, avd: string }[]} running
 * @param {string[]} avds
 * @returns {AndroidDevice[]}
 */
export function androidDevices(running, avds) {
  /** @type {AndroidDevice[]} */
  const devices = running.map((row) => ({ id: row.serial, name: row.avd || row.model, booted: true, avd: row.avd }))
  for (const avd of avds) {
    if (!running.some((row) => row.avd === avd)) devices.push({ id: `avd:${avd}`, name: avd, booted: false, avd })
  }
  return devices
}

/**
 * `adb shell wm size` → 화면 픽셀(Override 가 있으면 그것)
 * @param {string} text
 * @returns {{ width: number, height: number } | null}
 */
export function parseWmSize(text) {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(text)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(text)
  const match = override || physical
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

/**
 * `adb shell dumpsys window displays` → 지금 화면 크기(첫 화면의 cur= — 회전 · wm size 를 반영한다. wm size 의 Physical 은 회전을 모른다)
 * @param {string} text
 * @returns {{ width: number, height: number } | null}
 */
export function parseDisplayCur(text) {
  const match = /\bcur=(\d+)x(\d+)/.exec(text)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

/**
 * `--size <너비>x<높이>`(tap · swipe — 부른 쪽이 이미 아는 지금 화면 크기) 읽기 — 모양이 틀리면 null
 * @param {string} text
 * @returns {{ width: number, height: number } | null}
 */
export function parseSizeOption(text) {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(text)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * 기기 안에서 돌릴 화면 녹화 명령(adb exec-out 한 줄) — 첫 줄에 셸 pid 를 찍고 그 셸을 screenrecord 로 바꾼다(exec · 같은 pid).
 * adb 를 끊어도 기기 안 screenrecord 는 다음 쓰기 때까지 남아서(2026-11-16 syung36 실측) 끝낼 때 이 pid 로 끈다.
 * unlimited 면 길이 제한을 없앤다(--time-limit 0 — 도움말에 "Set to 0" 이 있는 판만) · 아니면 기본 180초 뒤 끝나니 부른 쪽이 다시 켠다
 * @param {boolean} unlimited
 */
export function screenrecordCommand(unlimited) {
  return `echo $$; exec screenrecord --output-format=h264${unlimited ? ' --time-limit 0' : ''} -`
}

/**
 * 0..1 비율 좌표 → 기기 픽셀(화면 안으로 자른다)
 * @param {number} ratio
 * @param {number} size
 */
export function toPixel(ratio, size) {
  const clamped = Math.min(Math.max(ratio, 0), 1)
  return Math.min(Math.round(clamped * size), Math.max(size - 1, 0))
}

/**
 * 비율 좌표 인자 하나 읽기 — 0..1 숫자가 아니면 null
 * @param {string | undefined} value
 */
export function readRatio(value) {
  if (value === undefined || value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null
}

/**
 * 대상 기기 고르기 — --device(id · 이름) 가 있으면 그것, 없으면 켜진 iOS 먼저 · 다음 켜진 Android.
 * platform 을 주면 그 플랫폼에서만 찾는다. 못 찾으면 null
 * @param {{ ios: IosDevice[], android: AndroidDevice[] }} lists
 * @param {{ device?: string, platform?: string }} want
 * @returns {Target | null}
 */
export function pickTarget(lists, want) {
  const allowIos = !want.platform || want.platform === 'ios'
  const allowAndroid = !want.platform || want.platform === 'android'
  if (want.device) {
    const key = want.device
    const ios = allowIos ? lists.ios.find((item) => item.id === key) || lists.ios.find((item) => item.name === key && item.booted) || lists.ios.find((item) => item.name === key) : undefined
    if (ios) return { platform: 'ios', device: ios }
    const android = allowAndroid ? lists.android.find((item) => item.id === key || item.avd === key || item.name === key) : undefined
    return android ? { platform: 'android', device: android } : null
  }
  const bootedIos = allowIos ? lists.ios.find((item) => item.booted) : undefined
  if (bootedIos) return { platform: 'ios', device: bootedIos }
  const bootedAndroid = allowAndroid ? lists.android.find((item) => item.booted) : undefined
  return bootedAndroid ? { platform: 'android', device: bootedAndroid } : null
}

/**
 * adb 찾기 — PATH 다음 ANDROID_HOME · ANDROID_SDK_ROOT · ~/Library/Android/sdk(Android Studio 기본) 의 platform-tools.
 * emulator 는 같은 SDK 의 emulator/ 에서. 못 찾으면 빈 문자열
 * @param {Record<string, string | undefined>} env
 * @param {(file: string) => boolean} [exists]
 */
export function findAndroidTools(env, exists = existsSync) {
  const sdkRoots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.HOME ? join(env.HOME, 'Library', 'Android', 'sdk') : ''].filter(Boolean)
  const pathDirs = (env.PATH || '').split(':').filter(Boolean)
  const firstFile = (/** @type {string[]} */ candidates) => candidates.find((file) => exists(file)) || ''
  const adb = firstFile([...pathDirs.map((dir) => join(dir, 'adb')), ...sdkRoots.map((root) => join(/** @type {string} */ (root), 'platform-tools', 'adb'))])
  // emulator — adb 가 SDK 안에 있으면 그 SDK 의 emulator 를 먼저
  const sdkOfAdb = adb && basename(dirname(adb)) === 'platform-tools' ? dirname(dirname(adb)) : ''
  const emulator = firstFile([
    ...(sdkOfAdb ? [join(sdkOfAdb, 'emulator', 'emulator')] : []),
    ...pathDirs.map((dir) => join(dir, 'emulator')),
    ...sdkRoots.map((root) => join(/** @type {string} */ (root), 'emulator', 'emulator')),
  ])
  return { adb, emulator }
}

/**
 * 캡처 파일 이름 — <시각>-<플랫폼>-<기기 이름>.png(이름의 공백 · 기호는 -)
 * @param {Date} when
 * @param {string} platform
 * @param {string} name
 */
export function shotName(when, platform, name) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0')
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  const safe = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'device'
  return `${stamp}-${platform}-${safe}.png`
}

/**
 * 계획서 옆 캡처 폴더 — plans/…/<이름>.md → plans/…/<이름>.shots
 * @param {string} planFile
 */
export function planShotsDir(planFile) {
  return join(dirname(planFile), `${basename(planFile).replace(/\.md$/, '')}.shots`)
}

/**
 * 기기 셸(adb shell)에 넘길 글자 하나 — adb shell 은 인자를 이어 붙여 기기 셸이 다시 읽으니 작은따옴표로 감싼다(안의 ' 는 '\'' 로)
 * @param {string} text
 */
export function deviceShellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`
}
