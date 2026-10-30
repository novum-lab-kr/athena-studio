// 개발 앱 ⚙ 업데이트의 npm install — 종료 구분 · 출력 읽기 · 끊긴 설치 표시 · 실제 자식 프로세스 (Electron 없이)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const install = require('../src/lib/app-install.mts')
const notice = require('../src/lib/update-notice.mts')

test('classifyExit: 신호로 끝난 것(강제 종료)은 진짜 실패와 따로', () => {
  assert.equal(install.classifyExit({ code: 0, signal: null }), 'ok')
  assert.equal(install.classifyExit({ code: 1, signal: null }), 'failed')
  assert.equal(install.classifyExit({ code: 75, signal: null }), 'gave-up')
  assert.equal(install.classifyExit({ code: null, signal: 'SIGKILL' }), 'killed')
  for (const code of [130, 137, 143]) assert.equal(install.classifyExit({ code, signal: null }), 'killed') // heavy.sh · 셸이 돌려주는 128+신호
  assert.equal(install.classifyExit({ code: 1, signal: 'SIGTERM' }), 'killed')
})

test('installCommand: heavy.sh 가 있으면 줄 서기로 · 없으면 npm 바로', () => {
  const heavy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-')), 'heavy.sh')
  fs.writeFileSync(heavy, '')
  assert.deepEqual(install.installCommand({ heavy, platform: 'darwin' }), { file: 'bash', list: [heavy, 'npm', 'install', '--include=dev'] })
  assert.deepEqual(install.installCommand({ heavy: '/없는/heavy.sh', platform: 'darwin' }), { file: 'npm', list: ['install', '--include=dev'] })
  assert.equal(install.installCommand({ heavy: '', platform: 'win32' }).file, 'npm.cmd')
})

test('createLineWatcher: 대기는 한 번만 · 차례가 오면 알리고 그 뒤 출력은 보지 않는다 · 덩어리 경계', () => {
  const events = []
  const watch = install.createLineWatcher({ onWait: (event) => events.push(event.kind), onTurn: () => events.push('turn') })
  watch('⏳ 대기 0초 — 부하 12.3 > 한도 9.6 (코어 8)\n⏳ 대기 3')
  watch('0초 — 부하 12.0 > 한도 9.6 (코어 8)\n')
  watch('▶ 차례 — 40초 기다림\n⏳ 대기 0초 — 부하 99 > 한도 1 (코어 1)\n')
  assert.deepEqual(events, ['load', 'turn']) // 대기 줄이 여러 번 와도(30초마다 다시 찍는다) onWait 는 첫 줄에서만 · 차례 감지는 계속
})

test('끊긴 설치 표시: 쓰고 · 읽고 · 지운다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-'))
  assert.equal(install.readPending(root), null)
  install.writePending(root, { at: '2026-10-30T00:00:00Z', heavy: '/h/heavy.sh', lang: 'ko' })
  assert.deepEqual(install.readPending(root), { at: '2026-10-30T00:00:00Z', heavy: '/h/heavy.sh', lang: 'ko' })
  install.clearPending(root)
  assert.equal(install.readPending(root), null)
  install.clearPending(root) // 없어도 괜찮다
})

test('다시 빌드 표시 · 켜기 반복 막기: 표시가 있을 때만 · 간격 안에는 한 번', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-'))
  assert.equal(install.shouldRelaunch(root), false) // 남은 일이 없으면 다시 켜지 않는다
  install.writeRebuild(root)
  assert.equal(install.hasRebuild(root), true)
  assert.equal(install.shouldRelaunch(root, 1000), true)
  install.markRelaunch(root, 1000)
  assert.equal(install.shouldRelaunch(root, 1000 + install.RELAUNCH_GAP_MS - 1), false) // 방금 한 번 했다
  assert.equal(install.shouldRelaunch(root, 1000 + install.RELAUNCH_GAP_MS), true)
  install.clearRebuild(root)
  assert.equal(install.shouldRelaunch(root, 1000 + install.RELAUNCH_GAP_MS), false)
  install.writePending(root, { at: 'x', heavy: '', lang: '' }) // 설치가 끊긴 표시만 있어도 대상
  assert.equal(install.shouldRelaunch(root, 1000 + install.RELAUNCH_GAP_MS), true)
})

test('도우미 표시: 맞는 도우미만 true · 아닌 것은 표시를 지우고 false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-'))
  const file = path.join(root, '.dev-app', 'restart-helper.json')
  const now = Date.parse('2026-10-31T01:00:00Z')
  const helper = { startedAt: now - 1000, command: 'node /x/scripts/dev-app.js restart --after 7 --lang ko' }
  assert.equal(install.helperRunning(root, () => helper, 1, now), false) // 표시 없음
  install.writeHelper(root, 4242, now - 1000)
  assert.equal(install.helperRunning(root, () => helper, 1, now), true)
  assert.equal(fs.existsSync(file), true) // 맞으면 표시는 그대로
  assert.equal(install.helperRunning(root, () => helper, 4242, now), false) // 내 표시
  // 살아 있지만 도우미가 아닌 pid(pid 재사용 · 무관한 프로세스)
  assert.equal(install.helperRunning(root, () => ({ startedAt: now - 1000, command: 'sleep 120' }), 1, now), false)
  assert.equal(fs.existsSync(file), false)
  // 도우미 같지만 시작 시각이 다름(같은 pid 를 다른 도우미가 재사용)
  install.writeHelper(root, 4242, now - 1000)
  assert.equal(install.helperRunning(root, () => ({ ...helper, startedAt: now - 3600 * 1000 }), 1, now), false)
  // 죽은 pid
  install.writeHelper(root, 4242, now - 1000)
  assert.equal(install.helperRunning(root, () => null, 1, now), false)
  assert.equal(fs.existsSync(file), false)
  // 유효 시간 지남
  install.writeHelper(root, 4242, now - install.HELPER_MAX_MS - 1)
  assert.equal(install.helperRunning(root, () => ({ ...helper, startedAt: now - install.HELPER_MAX_MS - 1 }), 1, now), false)
  assert.equal(fs.existsSync(file), false)
  // 깨진 표시
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '깨짐')
  assert.equal(install.helperRunning(root, () => helper, 1, now), false)
})

test('도우미 표시: 지우기는 내 것만 · 진짜 ps 로 이 프로세스는 도우미가 아니다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-'))
  install.writeHelper(root, 4242)
  install.clearHelper(root, 1) // 남의 표시는 그대로
  assert.equal(fs.existsSync(path.join(root, '.dev-app', 'restart-helper.json')), true)
  install.clearHelper(root, 4242)
  assert.equal(fs.existsSync(path.join(root, '.dev-app', 'restart-helper.json')), false)
  const info = install.inspectProcess(process.pid) // 실제 ps — 시작 시각과 명령을 읽는다
  assert.ok(info && info.startedAt <= Date.now() && /node/.test(info.command))
  install.writeHelper(root) // 이 시험 프로세스(dev-app.js restart 가 아님)
  assert.equal(install.helperRunning(root, undefined, 1), false)
  assert.equal(install.inspectProcess(2 ** 22 + 12345), null)
})

test('dev-app.js: 도우미 표시를 앱 띄우기 직전에 지우고 · 신호 핸들러가 있다', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev-app.js'), 'utf8')
  const clear = source.indexOf('appInstall.clearHelper(ROOT)\n  appLaunched = true\n  launch(binary)')
  assert.ok(clear > 0) // launch 바로 앞
  assert.ok(source.indexOf("'SIGTERM', 'SIGINT', 'SIGHUP'") > 0)
})

test('missingModules: 켜는 데 꼭 필요한 electron · vite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-'))
  assert.deepEqual(install.missingModules(root), ['electron', 'vite'])
  for (const name of ['electron', 'vite']) {
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), '{}')
  }
  assert.deepEqual(install.missingModules(root), [])
})

test('runInstall: 실제 자식 — 성공 · 실패 코드 · 신호 · 못 띄움', async () => {
  const cwd = os.tmpdir()
  const out = []
  const ok = await install.runInstall({ file: process.execPath, list: ['-e', 'console.log("한글 출력")'], cwd, onOutput: (chunk) => out.push(chunk) })
  assert.deepEqual(ok, { code: 0, signal: null })
  assert.equal(out.join(''), '한글 출력\n')
  assert.deepEqual(await install.runInstall({ file: process.execPath, list: ['-e', 'process.exit(3)'], cwd }), { code: 3, signal: null })
  const killed = await install.runInstall({ file: process.execPath, list: ['-e', 'process.kill(process.pid, "SIGKILL")'], cwd })
  assert.equal(install.classifyExit(killed), 'killed')
  assert.equal((await install.runInstall({ file: '/없는/실행파일', list: [], cwd })).code, 1)
})

test('runInstall: 넘긴 env 만 자식에게 간다', async () => {
  process.env.ATHENA_STUDIO_TEST_LEAK = '1'
  const out = []
  await install.runInstall({ file: process.execPath, list: ['-e', 'console.log(String(process.env.ATHENA_STUDIO_TEST_LEAK) + process.env.KEPT)'], cwd: os.tmpdir(), env: { KEPT: 'y', PATH: process.env.PATH }, onOutput: (chunk) => out.push(chunk) })
  delete process.env.ATHENA_STUDIO_TEST_LEAK
  assert.equal(out.join(''), 'undefinedy\n')
})

test('stopInstall: 자식의 자식까지 끝나고 돌아온다', { skip: process.platform === 'win32' }, async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-stop-')), 'grandchild.pid')
  const parent = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000)`
  let pid
  const run = install.runInstall({ file: process.execPath, list: ['-e', parent], cwd: os.tmpdir(), onSpawn: (value) => (pid = value) })
  for (let waited = 0; !fs.existsSync(pidFile) && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 50))
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
  await install.stopInstall(pid, run, 3000)
  assert.equal(install.classifyExit(await run), 'killed')
  // 손자는 같은 그룹 신호를 받은 뒤 비동기로 사라진다 — 잠깐 기다리며 확인
  const alive = () => {
    try {
      process.kill(grandchild, 0)
      return true
    } catch {
      return false
    }
  }
  for (let waited = 0; alive() && waited < 60; waited++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(alive(), false)
})

test('noticeText: 강제 종료 알림은 설치 실패와 다른 문구', () => {
  const say = notice.translator('ko')
  assert.notEqual(notice.noticeText(say, { kind: 'killed' }).body, notice.noticeText(say, { kind: 'install-failed' }).body)
  assert.match(notice.noticeText(say, { kind: 'killed' }).body, /강제 종료/)
})
