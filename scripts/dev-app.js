// 개발용 Athena.app — `npm start` 로 켜면 맥 메뉴 막대 · Dock · ⌘Tab 이 node_modules 의 Electron.app 이름(Electron)을 쓴다.
// 그래서 Electron.app 을 레포 안 무시 폴더(.dev-app/)에 Athena.app 으로 복제하고 이름 · 아이콘만 바꿔 그걸로 켠다(node_modules 는 건드리지 않는다).
// 앱 이름(package.json productName "Athena Studio")은 그대로 — 앱 데이터 폴더(설정 · 데몬 · 스튜디오 아테나)가 옮겨지지 않게.
//   node scripts/dev-app.js make    (postinstall) 없거나 Electron 버전 · 아이콘이 바뀌었으면 다시 만든다
//   node scripts/dev-app.js start   (npm start) Athena.app 으로 켠다 — 맥이 아니거나 만들지 못했으면 Electron 그대로
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')
const APP_NAME = 'Athena'
const DEV_APP_VERSION = 2 // 만드는 방법이 바뀌면 올린다(있던 복사본을 다시 만든다)
const BUNDLE_ID = 'kr.novum-lab.athena-studio.dev'
const SOURCE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app')
const TARGET = path.join(ROOT, '.dev-app', `${APP_NAME}.app`)
const BINARY = path.join(TARGET, 'Contents', 'MacOS', 'Electron')
// 무엇으로 만들었는지 — 번들 밖에 둔다(번들 안에 쓰면 서명이 깨진다)
const MARKER = path.join(ROOT, '.dev-app', `${APP_NAME}.json`)
const ICON = path.join(ROOT, 'src', 'renderer', 'assets', 'logo', 'athena-app-icon.png') // 1024 · 둥근 사각형 앱 아이콘

function electronVersion() {
  try {
    return require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version
  } catch {
    return null
  }
}

function iconHash() {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(ICON)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

// 지금 Electron · 아이콘으로 만든 것이면 다시 만들 필요 없다
function wanted() {
  return { electron: electronVersion(), icon: iconHash(), name: APP_NAME, bundleId: BUNDLE_ID, arch: process.arch, version: DEV_APP_VERSION }
}

function isCurrent() {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(MARKER, 'utf8'))) === JSON.stringify(wanted()) && fs.existsSync(BINARY)
  } catch {
    return false
  }
}

// PNG(1024) → .icns — 맥 기본 도구 sips(크기별) · iconutil(묶기)
const ICON_SIZES = [16, 32, 128, 256, 512]

function makeIcns(png, output) {
  const iconset = path.join(path.dirname(TARGET), `.iconset-${process.pid}.iconset`)
  fs.rmSync(iconset, { recursive: true, force: true })
  fs.mkdirSync(iconset, { recursive: true })
  try {
    for (const size of ICON_SIZES) {
      for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
        const pixels = String(size * scale)
        execFileSync('sips', ['-z', pixels, pixels, png, '--out', path.join(iconset, `icon_${size}x${size}${suffix}.png`)], { stdio: 'ignore' })
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output], { stdio: 'ignore' })
  } finally {
    fs.rmSync(iconset, { recursive: true, force: true })
  }
}

// 만들기는 한 번에 하나만(npm install · npm start 가 겹쳐도) — 잠금 파일. 오래된(2분) 잠금은 버린다
const LOCK = path.join(ROOT, '.dev-app', '.lock')

function withLock(work) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true })
  const until = Date.now() + 60000
  for (;;) {
    try {
      fs.closeSync(fs.openSync(LOCK, 'wx'))
      break
    } catch {
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 120000) fs.rmSync(LOCK, { force: true })
      } catch {}
      if (Date.now() > until) return false
      execFileSync('sleep', ['0.5'])
    }
  }
  try {
    return work()
  } finally {
    fs.rmSync(LOCK, { force: true })
  }
}

function make() {
  if (process.platform !== 'darwin' || !fs.existsSync(SOURCE)) return false
  if (isCurrent()) return true
  try {
    // 기다리는 사이 다른 쪽이 만들었으면 그걸 쓴다
    return withLock(() => isCurrent() || build())
  } catch {
    return false
  }
}

// 임시 자리에서 다 만들고 서명까지 확인한 뒤 바꿔 끼운다 — 실패하면 있던 복사본은 그대로(그걸로 뜬 데몬 · pane CLI 가 실행 파일을 잃지 않게)
function build() {
  const building = path.join(path.dirname(TARGET), `.building-${process.pid}.app`)
  const retired = path.join(path.dirname(TARGET), `.old-${process.pid}.app`)
  try {
    fs.mkdirSync(path.dirname(TARGET), { recursive: true })
    fs.rmSync(building, { recursive: true, force: true })
    // APFS 복제(-c) — 공간을 거의 안 쓴다. 안 되는 디스크면 반쯤 만든 것을 지우고 그냥 복사
    try {
      execFileSync('cp', ['-cR', SOURCE, building], { stdio: 'ignore' })
    } catch {
      fs.rmSync(building, { recursive: true, force: true })
      execFileSync('cp', ['-R', SOURCE, building], { stdio: 'ignore' })
    }
    const plist = path.join(building, 'Contents', 'Info.plist')
    // 복제하는 사이 npm install 이 Electron 을 바꿨으면(버전이 다르면) 이번 것은 버린다
    const copied = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { encoding: 'utf8' }).trim()
    if (copied !== electronVersion()) throw new Error(`복제한 Electron(${copied})이 설치된 버전(${electronVersion()})과 달라요`)
    for (const [key, value] of [['CFBundleName', APP_NAME], ['CFBundleDisplayName', APP_NAME], ['CFBundleIdentifier', BUNDLE_ID]]) {
      execFileSync('plutil', ['-replace', key, '-string', value, plist], { stdio: 'ignore' })
    }
    if (fs.existsSync(ICON)) makeIcns(ICON, path.join(building, 'Contents', 'Resources', 'electron.icns'))
    // Info.plist 를 바꾸면 서명이 깨져 애플 실리콘에서 안 켜진다 — 이 컴퓨터용(ad-hoc)으로 다시 서명하고 확인
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', building], { stdio: 'ignore' })
    execFileSync('codesign', ['--verify', '--deep', building], { stdio: 'ignore' })
    // 바꿔 끼우기 — 있던 것은 옆으로 치운 뒤 지운다
    if (fs.existsSync(TARGET)) fs.renameSync(TARGET, retired)
    fs.renameSync(building, TARGET)
    fs.writeFileSync(MARKER, JSON.stringify(wanted()) + '\n')
    fs.rmSync(retired, { recursive: true, force: true })
    return true
  } catch (error) {
    try {
      fs.rmSync(building, { recursive: true, force: true })
      // 바꿔 끼우다 실패했으면 치워 둔 것을 되돌린다
      if (!fs.existsSync(TARGET) && fs.existsSync(retired)) fs.renameSync(retired, TARGET)
    } catch {}
    console.warn(`[dev-app] ${APP_NAME}.app 을 만들지 못했어요 — Electron 이름으로 켜요: ${error.message}`)
    return false
  }
}

function start(args) {
  const useDevApp = process.platform === 'darwin' && make()
  const binary = useDevApp ? BINARY : require('electron')
  let child = null
  const launch = (file) => {
    const current = spawn(file, ['.', ...args], { cwd: ROOT, stdio: 'inherit' })
    child = current
    // Athena.app 을 못 켜면(바꿔 끼우는 순간 등) Electron 그대로
    current.on('error', (error) => {
      if (file === BINARY) return launch(require('electron'))
      console.error(`[dev-app] 켜지 못했어요: ${error.message}`)
      return process.exit(1)
    })
    // 대신 켠 것이 있으면 앞의 것이 끝난 것은 무시한다
    current.on('exit', (code, signal) => child === current && process.exit(signal ? 1 : code || 0))
  }
  launch(binary)
  // npm start 를 Ctrl+C 로 끄면 앱도 끈다
  for (const name of ['SIGINT', 'SIGTERM', 'SIGUSR2']) process.on(name, () => child && child.kill(name))
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'make') make()
else if (command === 'start') start(rest)
else {
  console.error('사용: node scripts/dev-app.js make | start')
  process.exit(2)
}
