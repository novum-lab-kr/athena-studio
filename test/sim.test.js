// 앱 화면 확인 도우미(athena/scripts/lib/sim.mjs · scripts/sim.mjs) — 명령 출력 읽기 · 기기 고르기 · 좌표 · 가짜 adb 로 CLI
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const sim = require('../athena/scripts/lib/sim.mjs')

const CLI = path.join(__dirname, '..', 'athena', 'scripts', 'sim.mjs')

test('simctl 목록: iOS 런타임만 · 켜진 기기 먼저 · 쓸 수 없는 기기 빼기', () => {
  const text = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
        { udid: 'A', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
        { udid: 'B', name: 'iPhone 15 Pro Max', state: 'Booted', isAvailable: true },
        { udid: 'C', name: 'Broken', state: 'Shutdown', isAvailable: false },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-10-5': [{ udid: 'W', name: 'Watch', state: 'Booted' }],
    },
  })
  assert.deepEqual(sim.parseSimctlDevices(text), [
    { id: 'B', name: 'iPhone 15 Pro Max', os: 'iOS 17.5', booted: true },
    { id: 'A', name: 'iPhone 15', os: 'iOS 17.5', booted: false },
  ])
  assert.deepEqual(sim.parseSimctlDevices('xcrun: error'), [])
})

test('adb 목록 · AVD 이름 · 켜진 기기와 꺼진 AVD 합치기', () => {
  const rows = sim.parseAdbDevices(
    'List of devices attached\nemulator-5554          device product:sdk model:sdk_gphone64_arm64 device:emu64a\nR3CN1        unauthorized usb:1\n\n',
  )
  assert.deepEqual(rows, [{ serial: 'emulator-5554', model: 'sdk gphone64 arm64' }])
  assert.equal(sim.parseAvdName('Pixel_8_API_35\r\nOK\n'), 'Pixel_8_API_35')
  assert.deepEqual(sim.parseAvdList('INFO    | 로그\nPixel_8_API_35\nTablet_API_34\n'), ['Pixel_8_API_35', 'Tablet_API_34'])
  assert.deepEqual(sim.androidDevices([{ ...rows[0], avd: 'Pixel_8_API_35' }], ['Pixel_8_API_35', 'Tablet_API_34']), [
    { id: 'emulator-5554', name: 'Pixel_8_API_35', booted: true, avd: 'Pixel_8_API_35' },
    { id: 'avd:Tablet_API_34', name: 'Tablet_API_34', booted: false, avd: 'Tablet_API_34' },
  ])
})

test('화면 크기 · 비율 좌표', () => {
  assert.deepEqual(sim.parseWmSize('Physical size: 1080x2400\n'), { width: 1080, height: 2400 })
  assert.deepEqual(sim.parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n'), { width: 720, height: 1600 })
  assert.equal(sim.parseWmSize('error'), null)
  // 회전 · override 를 반영한 지금 크기(dumpsys window displays 의 cur=) — 가로면 2400x1080
  assert.deepEqual(sim.parseDisplayCur('  init=1080x2400 420dpi base=1080x2400 cur=2400x1080 app=2400x1036 rng=1080x1036-2400x2356\n'), { width: 2400, height: 1080 })
  assert.equal(sim.parseDisplayCur('Display: mDisplayId=0'), null)
  assert.deepEqual(sim.parseSizeOption('2400x1080'), { width: 2400, height: 1080 })
  assert.equal(sim.parseSizeOption('0x100'), null)
  assert.equal(sim.parseSizeOption('1080x2400;id'), null)
  assert.equal(sim.parseSizeOption(''), null)
  // 기기 pid 를 첫 줄로(끊을 때 기기 안 녹화를 끄려고) · 무제한은 지원하는 기기만
  assert.equal(sim.screenrecordCommand(true), 'echo $$; exec screenrecord --output-format=h264 --time-limit 0 -')
  assert.equal(sim.screenrecordCommand(false), 'echo $$; exec screenrecord --output-format=h264 -')
  assert.equal(sim.toPixel(0.5, 1080), 540)
  assert.equal(sim.toPixel(1, 1080), 1079)
  assert.equal(sim.toPixel(-1, 1080), 0)
  assert.equal(sim.readRatio('0.25'), 0.25)
  for (const bad of ['2', '-0.1', 'abc', '', undefined]) assert.equal(sim.readRatio(bad), null)
})

test('대상 기기 고르기: --device(id · 이름 · AVD) · 기본은 켜진 iOS 먼저 · platform 으로 좁히기', () => {
  const lists = {
    ios: [
      { id: 'B', name: 'iPhone 15', os: 'iOS 17.5', booted: true },
      { id: 'A', name: 'iPhone 15', os: 'iOS 26.5', booted: false },
    ],
    android: [
      { id: 'emulator-5554', name: 'Pixel', booted: true, avd: 'Pixel' },
      { id: 'avd:Tab', name: 'Tab', booted: false, avd: 'Tab' },
    ],
  }
  assert.equal(sim.pickTarget(lists, {})?.device.id, 'B')
  assert.equal(sim.pickTarget(lists, { platform: 'android' })?.device.id, 'emulator-5554')
  assert.equal(sim.pickTarget(lists, { device: 'A' })?.device.id, 'A')
  assert.equal(sim.pickTarget(lists, { device: 'iPhone 15' })?.device.id, 'B', '같은 이름이면 켜진 것')
  assert.equal(sim.pickTarget(lists, { device: 'Tab' })?.device.id, 'avd:Tab')
  assert.equal(sim.pickTarget(lists, { device: 'B', platform: 'android' }), null)
  assert.equal(sim.pickTarget({ ios: [lists.ios[1]], android: [] }, {}), null, '켜진 기기가 없으면 null')
})

test('adb · emulator 찾기: PATH → ANDROID_HOME → ~/Library/Android/sdk', () => {
  const have = (/** @type {string[]} */ files) => (/** @type {string} */ file) => files.includes(file)
  assert.deepEqual(sim.findAndroidTools({ PATH: '/usr/bin', HOME: '/Users/me' }, have([])), { adb: '', emulator: '' })
  assert.deepEqual(
    sim.findAndroidTools({ PATH: '/usr/bin', HOME: '/Users/me' }, have(['/Users/me/Library/Android/sdk/platform-tools/adb', '/Users/me/Library/Android/sdk/emulator/emulator'])),
    { adb: '/Users/me/Library/Android/sdk/platform-tools/adb', emulator: '/Users/me/Library/Android/sdk/emulator/emulator' },
  )
  assert.equal(sim.findAndroidTools({ PATH: '/opt/bin', ANDROID_HOME: '/sdk' }, have(['/opt/bin/adb', '/sdk/platform-tools/adb'])).adb, '/opt/bin/adb')
})

test('캡처 이름 · 계획서 옆 폴더', () => {
  assert.equal(sim.shotName(new Date(2026, 10, 15, 9, 5, 7), 'ios', 'iPhone 15 Pro Max'), '20261115-090507-ios-iPhone-15-Pro-Max.png')
  assert.equal(sim.shotName(new Date(2026, 0, 1), 'android', '(!)'), '20260101-000000-android-device.png')
  assert.equal(sim.planShotsDir('/b/plans/task/20261115-x.md'), '/b/plans/task/20261115-x.shots')
})

// 가짜 adb(PATH 앞) · xcrun 은 실패하게 — 이 맥에 Xcode · SDK 가 있든 없든 같은 결과
function fakeTools(root) {
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const log = path.join(root, 'calls')
  fs.writeFileSync(path.join(bin, 'xcrun'), '#!/bin/sh\necho "xcrun: error: unable to find utility simctl" >&2\nexit 72\n', { mode: 0o755 })
  fs.writeFileSync(
    path.join(bin, 'adb'),
    `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  "-s emulator-5554 shell") exec /bin/sh ;;
  "devices -l") printf 'List of devices attached\\nemulator-5554 device model:Pixel_8\\n' ;;
  *"emu avd name"*) printf 'Pixel_8_API_35\\nOK\\n' ;;
  *"wm size"*) sleep 0.3; echo "Physical size: 1000x2000" ;;
  *"screencap -p"*) printf 'PNGDATA' ;;
esac
`,
    { mode: 0o755 },
  )
  // 기기 셸의 input — 받은 인자를 적는다(sim.mjs input 이 열어 둔 셸로 부른다)
  fs.writeFileSync(path.join(bin, 'input'), `#!/bin/sh\necho "input $*" >> '${log}'\n`, { mode: 0o755 })
  return { bin, log }
}

function runCli(/** @type {string[]} */ args, /** @type {string} */ bin, /** @type {string} */ home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: os.tmpdir() },
  })
}

test('CLI(가짜 adb): list · tap 비율 → 픽셀 · shot --plan · Xcode 없음은 그 플랫폼만', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin, log } = fakeTools(root)

  const listed = runCli(['list', '--json'], bin, root)
  assert.equal(listed.status, 0, listed.stderr)
  const data = JSON.parse(listed.stdout)
  assert.deepEqual(data.ios, { ok: false, reason: 'no-xcode', devices: [] })
  assert.deepEqual(data.android.devices, [{ id: 'emulator-5554', name: 'Pixel_8_API_35', booted: true, avd: 'Pixel_8_API_35' }])

  const tapped = runCli(['tap', '0.5', '0.25'], bin, root)
  assert.equal(tapped.status, 0, tapped.stderr)
  assert.match(fs.readFileSync(log, 'utf8'), /^-s emulator-5554 shell input tap 500 500$/m)

  const plan = path.join(root, 'plans', 'task', '20261115-x.md')
  const shot = runCli(['shot', '--plan', plan, '--json'], bin, root)
  assert.equal(shot.status, 0, shot.stderr)
  const file = JSON.parse(shot.stdout).file
  assert.equal(path.dirname(file), path.join(root, 'plans', 'task', '20261115-x.shots'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'PNGDATA')

  // --dir — 그 폴더에 시각-플랫폼-기기 이름으로(칸 [캡처] 가 데스크톱에)
  const toDir = runCli(['shot', '--dir', path.join(root, 'Desktop'), '--json'], bin, root)
  assert.equal(toDir.status, 0, toDir.stderr)
  assert.match(path.basename(JSON.parse(toDir.stdout).file), /^\d{8}-\d{6}-android-Pixel_8_API_35\.png$/)
  assert.equal(path.dirname(JSON.parse(toDir.stdout).file), path.join(root, 'Desktop'))

  const ios = runCli(['shot', '--out', path.join(root, 'a.png'), '--platform', 'ios'], bin, root)
  assert.equal(ios.status, 3)
  assert.match(ios.stderr, /Xcode/)
  assert.equal(runCli(['tap', '3', '0'], bin, root).status, 2)
  assert.equal(runCli(['nope'], bin, root).status, 2)
})

test('CLI(가짜 adb): tap · swipe --size 면 목록 · 화면 크기 읽기 없이 그 크기로 누른다(칸 — 영상이 아는 크기)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-size-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin, log } = fakeTools(root)
  const tapped = runCli(['tap', '0.5', '0.25', '--platform', 'android', '--device', 'emulator-5554', '--size', '2400x1080', '--json'], bin, root)
  assert.equal(tapped.status, 0, tapped.stderr)
  assert.equal(JSON.parse(tapped.stdout).id, 'emulator-5554')
  const swiped = runCli(['swipe', '0', '0', '1', '1', '--platform', 'android', '--device', 'emulator-5554', '--size', '2400x1080'], bin, root)
  assert.equal(swiped.status, 0, swiped.stderr)
  // adb 는 누르기 · 쓸기 두 번만(devices · emu avd name · dumpsys · wm size 없음)
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
    '-s emulator-5554 shell input tap 1200 270',
    '-s emulator-5554 shell input swipe 0 0 2399 1079 250',
  ])
  // --size 모양이 틀렸거나 --platform 이 없으면 옛 길(목록 · 크기 읽기)
  fs.writeFileSync(log, '')
  assert.equal(runCli(['tap', '0.5', '0.25', '--device', 'emulator-5554', '--size', 'x'], bin, root).status, 0)
  assert.match(fs.readFileSync(log, 'utf8'), /^devices -l$/m)
  assert.match(fs.readFileSync(log, 'utf8'), /input tap 500 500$/m)
})

test('기기 셸 감싸기: URL 의 ; & | \' 가 기기 셸에서 명령이 되지 않는다(open)', (t) => {
  const url = "exp://127.0.0.1:8081/--/a?b=1&c=2;reboot|id $(id) `id` it's"
  const quoted = sim.deviceShellQuote(url)
  // 기기 셸(sh)이 다시 읽어도 원래 글자 그대로 한 인자
  const echoed = spawnSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })
  assert.equal(echoed.stdout, url)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-open-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin, log } = fakeTools(root)
  const opened = runCli(['open', 'exp://x/a;reboot', '--platform', 'android'], bin, root)
  assert.equal(opened.status, 0, opened.stderr)
  assert.match(fs.readFileSync(log, 'utf8'), /^-s emulator-5554 shell am start -a android\.intent\.action\.VIEW -d 'exp:\/\/x\/a;reboot'$/m)
})

test('CLI: 켜진 기기가 없으면 실패 · 도구가 하나도 없어도 list 는 성공', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin } = fakeTools(root)
  fs.rmSync(path.join(bin, 'adb'))
  const listed = runCli(['list', '--json'], bin, root)
  assert.equal(listed.status, 0, listed.stderr)
  assert.equal(JSON.parse(listed.stdout).android.reason, 'no-sdk')
  const opened = runCli(['open', 'exp://127.0.0.1:8081', '--json'], bin, root)
  assert.equal(opened.status, 1)
  assert.match(JSON.parse(opened.stdout).error, /켜진 시뮬레이터/)
})

test('CLI: boot <AVD> — 에뮬레이터가 켜지다 꺼지면 5분 기다리지 않고 로그의 FATAL 줄로 멈춘다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin } = fakeTools(root)
  fs.writeFileSync(
    path.join(bin, 'emulator'),
    `#!/bin/sh
case "$*" in
  "-list-avds") echo Dead_AVD ;;
  *) echo "FATAL | Cannot find AVD system path"; exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const started = Date.now()
  const booted = spawnSync(process.execPath, [CLI, 'boot', 'Dead_AVD', '--json'], {
    encoding: 'utf8',
    // heavy.sh 자리는 이미 잡은 것으로(시험이 진짜 잠금을 건드리지 않게)
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: root, ATHENA_HEAVY_HELD: '1' },
  })
  assert.equal(booted.status, 1, booted.stderr)
  assert.match(JSON.parse(booted.stdout).error, /켜지다 꺼졌다: FATAL \| Cannot find AVD system path/)
  assert.ok(Date.now() - started < 30_000)
})

test('이어 누르기 줄 읽기 · 기기 명령(정수 픽셀만)', () => {
  assert.deepEqual(sim.parseTouchLine('tap 0.5 0.25'), { kind: 'tap', x: 0.5, y: 0.25 })
  assert.deepEqual(sim.parseTouchLine(' move 1 0 '), { kind: 'move', x: 1, y: 0 })
  assert.deepEqual(sim.parseTouchLine('size 1080x2400'), { kind: 'size', width: 1080, height: 2400 })
  for (const bad of ['tap 0.5', 'tap 2 0', 'tap 0.5 0.5;reboot', 'tap 0.5 0.5 x', 'drag 0 0', 'size 1080x2400;id', '']) assert.equal(sim.parseTouchLine(bad), null, bad)
  const size = { width: 1000, height: 2000 }
  assert.equal(sim.touchCommand('tap', 0.5, 0.25, size), 'input tap 500 500')
  assert.equal(sim.touchCommand('down', 0, 1, size), 'input motionevent DOWN 0 1999')
  assert.equal(sim.touchCommand('move', 0.1, 0.1, size), 'input motionevent MOVE 100 200')
  assert.equal(sim.touchCommand('up', 0.1, 0.1, size), 'input motionevent UP 100 200')
})

// 이어 누르기 CLI 를 띄워 줄을 넣고(ready 뒤) 표준 입력을 닫는다 — 끝 코드 · 출력
function runInput(/** @type {string[]} */ args, /** @type {string[]} */ lines, /** @type {string} */ bin, /** @type {string} */ home) {
  const { spawn } = require('node:child_process')
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, 'input', ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: os.tmpdir() } })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => {
      const first = !stdout.includes('ready')
      stdout += chunk
      if (first && stdout.includes('ready')) {
        proc.stdin.write(lines.map((line) => `${line}\n`).join(''))
        proc.stdin.end()
      }
    })
    proc.stderr.on('data', (chunk) => (stderr += chunk))
    proc.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('CLI(가짜 adb): input — 열어 둔 셸 하나로 누르기 · 손가락 · 끝날 때 눌린 손가락 떼기 · 틀린 줄은 버림', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-input-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin, log } = fakeTools(root)
  const args = ['--platform', 'android', '--device', 'emulator-5554', '--size', '1000x2000', '--watch-stdin']
  const done = await runInput(args, ['tap 0.5 0.25', 'down 0.5 0.5', 'move 0.5 0.4', 'move 0.5 0.3;reboot', 'up 0.5 0.3', 'size 2000x1000', 'down 0.1 0.1', 'move 0.2 0.2'], bin, root)
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /^ready$/m)
  assert.match(done.stderr, /모르는 줄: move 0\.5 0\.3;reboot/)
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
  // adb 는 셸 한 번만 연다 · 손가락이 눌린 채 끝나면 마지막 자리에서 뗀다(새 크기로)
  assert.deepEqual(calls, [
    '-s emulator-5554 shell',
    'input tap 500 500',
    'input motionevent DOWN 500 1000',
    'input motionevent MOVE 500 800',
    'input motionevent UP 500 600',
    'input motionevent DOWN 200 100',
    'input motionevent MOVE 400 200',
    'input motionevent UP 400 200',
  ])
})

test('CLI(가짜 adb): input — 크기를 읽는 동안 입력이 닫혀도 받은 순서대로 다 보내고 손가락을 뗀 뒤 닫는다', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-input-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin, log } = fakeTools(root)
  // --size 없음 — 첫 줄에서 wm size 를 읽는다(가짜는 0.3초 걸림)
  const done = await runInput(['--platform', 'android', '--device', 'emulator-5554', '--watch-stdin'], ['down 0.5 0.5', 'move 0.5 0.4'], bin, root)
  assert.equal(done.status, 0, done.stderr)
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line.startsWith('input '))
  assert.deepEqual(calls, ['input motionevent DOWN 500 1000', 'input motionevent MOVE 500 800', 'input motionevent UP 500 800'])
})

test('CLI: input 은 Android 일련번호만 — 아니면 인자 틀림(2 · 칸은 지금 방식으로)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-input-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bin } = fakeTools(root)
  for (const device of ['-x', 'avd:Pixel', 'a b', '']) {
    assert.equal(runCli(['input', '--platform', 'android', '--device', device], bin, root).status, 2, device)
  }
  assert.equal(runCli(['input', '--device', 'emulator-5554'], bin, root).status, 2)
})
