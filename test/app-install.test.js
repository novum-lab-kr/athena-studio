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
