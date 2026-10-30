// 개발용 Athena.app — `npm start` 로 켜면 맥 메뉴 막대 · Dock · ⌘Tab 이 node_modules 의 Electron.app 이름(Electron)을 쓴다.
// 그래서 Electron.app 을 레포 안 무시 폴더(.dev-app/)에 Athena.app 으로 복제하고 이름 · 아이콘만 바꿔 그걸로 켠다(node_modules 는 건드리지 않는다).
// 앱 데이터 폴더는 main 이 정한다 — 개발 앱은 'Athena Studio Dev' · 데몬 접속 파일 daemon-dev.json(배포판과 겹치지 않게 · src/lib/studio-home.js appIdentity).
//   node scripts/dev-app.js make    (postinstall) 없거나 Electron 버전 · 아이콘이 바뀌었으면 다시 만든다
//   node scripts/dev-app.js start   (npm start) Athena.app 으로 켠다 — 맥이 아니거나 만들지 못했으면 Electron 그대로.
//                                   켜기 전에 레포 athena/(스튜디오 코어)에서 코어 번들을 만들어 앱 리소스 자리에 두고(src/lib/studio-home.js)
//                                   화면(src/renderer)을 Vite 로 dist/renderer 에 빌드한다(vite.config.mts). 빌드가 실패하면 이전 빌드로 켜고 경고 · 이전 빌드가 없으면 켜지 않는다
//   node scripts/dev-app.js restart --after <pid> [--install] [--heavy <heavy.sh>] [--lang <언어>]
//                                   (앱 ⚙ [업데이트] 가 떼어 띄운다) 앱(pid)이 끝나길 기다려(1분 넘게 살아 있으면 멈춤) → --install 이면 npm install(--heavy 가 있으면 그 줄 서기로)
//                                   → start 와 같이 켠다. install · 화면 빌드가 실패해도 켜고 앱에 알린다(ATHENA_STUDIO_APP_UPDATE=install-failed · install-gave-up · install-killed · build-failed)
//                                   앱이 꺼진 사이 heavy.sh 잠금 대기 · install 포기 · 실패 · 강제 종료는 맥 알림으로(--lang 언어 · src/lib/update-notice.mts)
//                                   새 앱은 설치를 앱을 켠 채 끝내고(src/main/app-updater.mts) --install 없이 부른다 — --install 은 옛 앱(이 흐름을 모르는 첫 업데이트)용으로 남겼다.
//                                   설치가 끊겼으면(.dev-app/install-pending.json) start 가 켜기 전에 다시 시도한다(src/lib/app-install.mts)
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, spawn } = require('child_process')
const studioHome = require('../src/lib/studio-home')
const version = require('../src/lib/version')
const updateNotice = require('../src/lib/update-notice.mts')
const appInstall = require('../src/lib/app-install.mts')

const ROOT = path.join(__dirname, '..')
const APP_NAME = 'Athena'
const DEV_APP_VERSION = 3 // 만드는 방법이 바뀌면 올린다(있던 복사본을 다시 만든다)
const BASE_BUNDLE_ID = 'kr.novum-lab.athena-studio.dev'
const SOURCE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app')
const TARGET = path.join(ROOT, '.dev-app', `${APP_NAME}.app`)
const BINARY = path.join(TARGET, 'Contents', 'MacOS', 'Electron')
// 무엇으로 만들었는지 — 번들 밖에 둔다(번들 안에 쓰면 서명이 깨진다)
const MARKER = path.join(ROOT, '.dev-app', `${APP_NAME}.json`)
const ICON = path.join(ROOT, 'src', 'renderer', 'assets', 'logo', 'athena-app-icon.png') // 1024 · 둥근 사각형 앱 아이콘

// git 워크트리의 복사본은 번들 ID 를 따로 준다 — 같은 ID 복사본이 여럿이면 맥이 알림 · Dock · Finder 에서 아무거나 골라 켠다.
// 메인 체크아웃은 옛 ID 그대로(맥 알림 허용 설정을 잃지 않게). 앱 데이터 · 데몬 접속 파일은 번들 ID 가 아니라 appIdentity(studio-home.js)가 정하니 갈리지 않는다
function bundleId() {
  try {
    const git = (flag) => execFileSync('git', ['rev-parse', flag], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (path.resolve(ROOT, git('--git-dir')) === path.resolve(ROOT, git('--git-common-dir'))) return BASE_BUNDLE_ID
  } catch {
    return BASE_BUNDLE_ID
  }
  return `${BASE_BUNDLE_ID}.${crypto.createHash('sha256').update(fs.realpathSync(ROOT)).digest('hex').slice(0, 8)}`
}
const BUNDLE_ID = bundleId()

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
  return { electron: electronVersion(), icon: iconHash(), name: APP_NAME, bundleId: BUNDLE_ID, root: ROOT, arch: process.arch, version: DEV_APP_VERSION }
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
    // 인자 없이 켜져도(알림 · Dock · Finder) Electron 기본 창이 아니라 이 레포 앱이 뜨게 — Resources/app 이 있으면 Electron 이 default_app 대신 그걸 연다.
    // 이름 · 버전은 레포 package.json 과 같게, main 은 레포 진입점을 가리킨다(레포가 옮겨지면 marker 의 root 가 달라 다시 만든다)
    const appDir = path.join(building, 'Contents', 'Resources', 'app')
    fs.mkdirSync(appDir, { recursive: true })
    const repoPackage = require(path.join(ROOT, 'package.json'))
    const main = path.relative(appDir, path.join(ROOT, repoPackage.main))
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: repoPackage.name, version: repoPackage.version, main }, null, 2) + '\n')
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

// 앱이 들고 갈 아테나 코어 — 레포 athena/ 의 커밋된 기록을 git 번들로. 앱은 첫 실행 때 ~/.athena-studio/core 로 풀고,
// 새 커밋이면 켤 때 업데이트한다. 못 만들어도 켜기는 한다(이미 만든 번들 · 이미 푼 코어를 쓴다).
// 앱 버전(git describe · 태그가 없으면 package.json)을 번들에 같이 싣는다 — 코어 version --json 의 version
function makeBundle() {
  const out = studioHome.coreBundlePath({ appRoot: ROOT, packaged: false })
  try {
    const appVersion = version.describeVersion({ repoRoot: ROOT, env: studioHome.gitEnv() }) || require(path.join(ROOT, 'package.json')).version
    const made = studioHome.makeCoreBundle({ repoRoot: ROOT, out, version: appVersion, log: (line) => console.log(`[dev-app] ${line}`) })
    if (!made.ok) console.warn(`[dev-app] 코어 번들을 만들지 못했어요(${made.error}) — ${made.message || ''}`)
    else if (made.built) console.log(`[dev-app] 코어 번들 ${made.commit.slice(0, 12)}${made.version ? ` · ${made.version}` : ''} → ${path.relative(ROOT, out)}`)
  } catch (error) {
    console.warn(`[dev-app] 코어 번들을 만들지 못했어요 — ${error.message}`)
  }
}

// 화면 빌드 — Vite 를 이 프로세스에서 부른다(앱 ⚙ 업데이트가 이 도우미를 Electron(ELECTRON_RUN_AS_NODE)으로 띄워도 된다 —
// 자식으로 process.execPath 를 띄우면 그때는 Electron 앱이 하나 더 켜진다). 옆 폴더(dist/renderer-next)에 만들고 다 되면 바꿔 끼운다 —
// 실패해도 이전 빌드(dist/renderer)는 그대로 남는다. 돌려주는 값: built(새로 만듦) · previous(실패 · 이전 빌드로) · missing(실패 · 이전 빌드도 없음)
const RENDERER_OUT = path.join(ROOT, 'dist', 'renderer')
const RENDERER_NEXT = path.join(ROOT, 'dist', 'renderer-next')
// vite.build 는 이 프로세스의 NODE_ENV 를 production 으로 바꿔 둔다 — 그대로 두면 켜는 앱 → 데몬 → 모든 pane 셸로 물려져
// 그 안의 npm install(⚙ 업데이트 도우미 · 에이전트)이 devDependencies(electron · vite)를 지운다(2026-10-29). 빌드가 끝나면 되돌린다
async function buildRenderer() {
  const started = Date.now()
  const hadNodeEnv = Object.hasOwn(process.env, 'NODE_ENV')
  const nodeEnv = process.env.NODE_ENV
  try {
    fs.rmSync(RENDERER_NEXT, { recursive: true, force: true })
    const vite = await import('vite')
    try {
      await vite.build({ configFile: path.join(ROOT, 'vite.config.mts'), logLevel: 'warn', build: { outDir: RENDERER_NEXT } })
    } finally {
      if (hadNodeEnv) process.env.NODE_ENV = nodeEnv
      else delete process.env.NODE_ENV
    }
    fs.rmSync(RENDERER_OUT, { recursive: true, force: true })
    fs.renameSync(RENDERER_NEXT, RENDERER_OUT)
    console.log(`[dev-app] 화면 빌드 → ${path.relative(ROOT, RENDERER_OUT)} (${Date.now() - started}ms)`)
    return 'built'
  } catch (error) {
    fs.rmSync(RENDERER_NEXT, { recursive: true, force: true })
    const previous = fs.existsSync(path.join(RENDERER_OUT, 'index.html')) && fs.existsSync(path.join(RENDERER_OUT, 'tray.html'))
    if (previous) {
      console.warn(`[dev-app] 화면을 빌드하지 못했어요 — 이전 빌드로 켜요: ${error.message}`)
      return 'previous'
    }
    console.error(`[dev-app] 화면을 빌드하지 못했고 이전 빌드도 없어 켜지 않아요 — 고친 뒤 npm start(vite 가 없으면 npm install 먼저): ${error.message}`)
    return 'missing'
  }
}

async function start(args, { fromUpdate = false } = {}) {
  // 앱을 켠 채 하던 업데이트 설치가 끊겼으면(앱이 꺼짐 · 강제 종료) 다시 시도한다 — 끝나면 표시를 지운다
  const pending = appInstall.readPending(ROOT)
  if (pending) {
    console.log('[dev-app] 지난 업데이트의 npm install 이 끊겨 다시 시도해요')
    await installDependencies({ heavy: pending.heavy, lang: pending.lang })
  }
  // 버전을 정하기 전에 origin 태그부터 — 번들 · 앱(맥 정보 · ⚙ 줄)이 켤 때 정한 같은 번호를 쓴다(못 받으면 있는 태그로)
  version.fetchTags({ repoRoot: ROOT, env: studioHome.gitEnv() })
  makeBundle()
  const renderer = await buildRenderer()
  if (renderer === 'missing') {
    process.exitCode = 1
    return
  }
  // 앱 ⚙ 업데이트 뒤 다시 켤 때 화면 빌드가 실패했으면 앱에 알린다(npm install 실패를 먼저 알린다)
  if (renderer === 'previous' && fromUpdate && !process.env.ATHENA_STUDIO_APP_UPDATE) process.env.ATHENA_STUDIO_APP_UPDATE = 'build-failed'
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

// 맥 알림 하나 — 앱이 꺼진 사이라 화면 · 트레이가 없다(src/lib/update-notice.mts). 맥이 아니거나 못 띄워도 업데이트는 계속한다
function createNotice(language) {
  const say = updateNotice.translator(updateNotice.pickLanguage(language, Intl.DateTimeFormat().resolvedOptions().locale))
  return (event) => {
    const { title, body } = updateNotice.noticeText(say, event)
    console.log(`[dev-app] 알림: ${body}`)
    if (process.platform !== 'darwin') return
    try {
      spawn('osascript', updateNotice.notifyArgs(title, body), { stdio: 'ignore' }).on('error', () => {})
    } catch {}
  }
}

// npm install(heavy.sh 줄 서기 포함) — 출력은 그대로 기록(app-update.log)에 넘기고 heavy.sh 대기는 맥 알림으로 한 번(src/lib/app-install.mts).
// 시작할 때 "끊긴 설치" 표시를 남기고 끝나면 지운다 — 도우미가 도는 중에 꺼지면 남아서 다음에 켤 때 다시 시도한다.
// 신호로 끝난 것(강제 종료)은 npm install 실패와 따로 기록 · 알린다. 켜는 데 필요한 것이 없으면 실패로 본다. 설치가 안 됐어도 켠다(이전 빌드 · .dev-app 으로)
async function installDependencies({ heavy, lang }) {
  const { file, list } = appInstall.installCommand({ heavy })
  console.log(`[dev-app] ${[file, ...list].join(' ')}`)
  const notice = createNotice(lang)
  appInstall.writePending(ROOT, { at: new Date().toISOString(), heavy: heavy || '', lang: lang || '' })
  const exit = await appInstall.runInstall({
    file,
    list,
    cwd: ROOT,
    onOutput: (chunk, stream) => process[stream].write(chunk),
    watch: appInstall.createLineWatcher({ onWait: notice, onTurn: () => {} }),
  })
  const outcome = appInstall.classifyExit(exit)
  if (outcome === 'ok') {
    appInstall.clearPending(ROOT)
    const missing = appInstall.missingModules(ROOT)
    if (!missing.length) return
    console.error(`[dev-app] npm install 뒤에 ${missing.join(' · ')} 이(가) 없어요 — 레포에서 npm install --include=dev 를 다시 돌려 주세요`)
    process.env.ATHENA_STUDIO_APP_UPDATE = 'install-failed'
    notice({ kind: 'install-failed' })
    return
  }
  if (outcome === 'killed') {
    // 신호로 끝났다 — 진짜 실패가 아니라 끊긴 것. 표시를 남겨 다음에 켤 때 다시 시도한다
    console.error(`[dev-app] npm install 강제 종료(신호 ${exit.signal || exit.code}) — 설치 실패가 아니라 끊긴 것이에요. 다음에 켤 때 다시 시도해요`)
    process.env.ATHENA_STUDIO_APP_UPDATE = 'install-killed'
    notice({ kind: 'killed' })
    return
  }
  appInstall.clearPending(ROOT)
  // heavy.sh 75 = 최대 대기(ATHENA_HEAVY_WAIT)를 넘겨 포기 · 그 밖은 npm install 실패. 켠 뒤 앱 알림은 그대로
  console.error(`[dev-app] npm install ${outcome === 'gave-up' ? '포기(대기 시간 초과)' : '실패'}: 종료 코드 ${exit.code}`)
  process.env.ATHENA_STUDIO_APP_UPDATE = outcome === 'gave-up' ? 'install-gave-up' : 'install-failed'
  notice({ kind: outcome === 'gave-up' ? 'gave-up' : 'install-failed' })
}

// 앱 업데이트 뒤 다시 켜기 — 옛 앱이 끝난 뒤에(같은 앱 데이터 · node_modules 를 쓰는 동안 바꾸지 않게)
async function restart(args) {
  const valueOf = (name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] || '' : ''
  }
  const after = Number(valueOf('--after'))
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  }
  // 옛 앱이 끝나길 1분까지 기다린다
  for (let waited = 0; Number.isInteger(after) && after > 0 && alive(after) && waited < 60000; waited += 200) await new Promise((resolve) => setTimeout(resolve, 200))
  // 1분이 지나도 옛 앱이 살아 있으면 멈춘다 — 쓰는 중인 node_modules 를 바꾸거나 앱을 둘 켜지 않게(기록은 app-update.log)
  if (Number.isInteger(after) && after > 0 && alive(after)) {
    console.error(`[dev-app] 앱(pid ${after})이 1분 안에 끝나지 않아 설치 · 다시 켜기를 멈췄어요 — 앱을 끈 뒤 npm start 로 켜 주세요`)
    process.exitCode = 1
    return
  }
  // 앱이 이 도우미를 node 대신 Electron(ELECTRON_RUN_AS_NODE)으로 띄웠으면 — 켤 앱에 물려주지 않는다
  delete process.env.ELECTRON_RUN_AS_NODE
  // 이 수정 전 앱은 화면 빌드가 남긴 NODE_ENV=production 을 물려받아 켜져 있다(buildRenderer 주석) — 다시 켤 앱 · pane 에 또 물려주지 않는다.
  // 앱 코드는 NODE_ENV 를 읽지 않는다(화면 번들의 production 은 vite.build 가 따로 정한다)
  if (process.env.NODE_ENV === 'production') delete process.env.NODE_ENV
  if (args.includes('--install')) await installDependencies({ heavy: valueOf('--heavy'), lang: valueOf('--lang') })
  await start([], { fromUpdate: true })
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'make') make()
else if (command === 'start') start(rest)
else if (command === 'restart') restart(rest)
else {
  console.error('사용: node scripts/dev-app.js make | start | restart --after <pid> [--install] [--heavy <heavy.sh>] [--lang <언어>]')
  process.exit(2)
}
