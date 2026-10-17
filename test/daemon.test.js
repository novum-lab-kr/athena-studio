// pty 통합 — 데몬을 실제로 띄워 CLI 로 말해 본다(맥에서만: node-pty prebuild 가 darwin·win32 뿐이다)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn, execFile } = require('child_process')
const protocol = require('../src/lib/protocol')

const ROOT = path.join(__dirname, '..')
const CLI = path.join(ROOT, 'bin', 'athena-studio-cli')

let ptyMissing = null
try {
  require('node-pty')
} catch (error) {
  ptyMissing = `node-pty 를 불러오지 못했다(${process.platform}) — ${error.message}`
}

// 소켓 경로 104바이트 제한 — os.tmpdir() 는 길 수 있어 /tmp 아래 짧게
const workDir = () => fs.mkdtempSync('/tmp/asd-test-')

function startDaemon(dir) {
  const socket = path.join(dir, 'd.sock')
  const endpoint = path.join(dir, 'endpoint.json')
  const log = fs.openSync(path.join(dir, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon', 'main.js'), '--socket', socket, '--endpoint', endpoint], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  fs.closeSync(log)
  return { socket, endpoint, pid: child.pid }
}

async function waitFor(check, what, limitMs = 5000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${what} 를 기다리다 시간 초과`)
}

// 앱처럼 소켓으로 직접 — 한 연결에서 요청하고 알림도 모은다
function connect(socket) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket)
    const pending = new Map()
    const events = []
    let nextId = 1
    connection.setEncoding('utf8')
    connection.on(
      'data',
      protocol.createDecoder((message) => {
        if (message.event) events.push(message)
        else pending.get(message.id)?.(message)
      }),
    )
    connection.once('error', reject)
    connection.once('connect', () =>
      resolve({
        events,
        call(op, args = {}) {
          const id = nextId++
          return new Promise((done) => {
            pending.set(id, done)
            connection.write(protocol.encode({ id, op, args }))
          })
        },
        close: () => connection.end(),
      }),
    )
  })
}

function cli(socket, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(CLI, args, { env: { ...process.env, ATHENA_STUDIO_SOCKET: socket, ATHENA_STUDIO_NODE: process.execPath, ...extraEnv } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
  })
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('데몬 + CLI: 탭 · 분할 · 쓰기 · 기다리기 · 읽기 · 목록 · 다시 붙기 · 닫기', { skip: ptyMissing || false, timeout: 30000 }, async () => {
  const dir = workDir()
  const daemon = startDaemon(dir)
  try {
    await waitFor(() => fs.existsSync(daemon.socket), '데몬 소켓')
    const app = await connect(daemon.socket)

    const hello = await app.call('hello', { protocol: protocol.PROTOCOL })
    assert.equal(protocol.checkHello(hello), 'ok')
    // 접속 파일(S4) — pane 밖에서 찾는 자리
    const endpoint = JSON.parse(fs.readFileSync(daemon.endpoint, 'utf8'))
    assert.equal(endpoint.socket, daemon.socket)
    assert.equal(endpoint.protocol, protocol.PROTOCOL)

    const tab = await app.call('tab new', { label: 'athena', cwd: dir, cols: 100, rows: 30 })
    assert.deepEqual(tab.result, { workspace: 'w1', tab: 't1', pane: 'p1' }) // 작업 공간이 없으면 cwd 이름으로 하나

    // self 를 나누면 부른 pane(caller) 옆에 — 원래 pane 몫 0.25
    const split = await cli(daemon.socket, ['pane', 'split', '--target', 'self', '--direction', 'right', '--ratio', '0.25', '--no-focus'], { ATHENA_STUDIO_PANE_ID: 'p1' })
    assert.equal(split.code, 0, split.stderr)
    const created = JSON.parse(split.stdout).pane
    assert.equal(created.id, 'p2')
    assert.equal(created.cwd, dir)

    // pane 셸 환경 변수 · run · wait-output(정규식은 출력 줄에만 맞게)
    assert.equal((await cli(daemon.socket, ['pane', 'run', 'p2', 'echo', 'studio=$ATHENA_STUDIO:$ATHENA_STUDIO_PANE_ID:$((6*7))'])).code, 0)
    const waited = await cli(daemon.socket, ['pane', 'wait-output', 'p2', '--regex', '^studio=1:p2:42$', '--timeout', '8000'])
    assert.equal(waited.code, 0, waited.stderr)
    assert.equal(waited.stdout, 'studio=1:p2:42\n')
    assert.match((await cli(daemon.socket, ['pane', 'read', 'p2', '--lines', '20'])).stdout, /^studio=1:p2:42$/m)

    // 납작한 Pane 12키 · 포커스는 그대로 p1(--no-focus) · 이름표
    assert.equal((await cli(daemon.socket, ['pane', 'rename', 'p2', '🤖 test · branch'])).code, 0)
    const list = JSON.parse((await cli(daemon.socket, ['pane', 'list'])).stdout).panes
    assert.deepEqual(list.map((pane) => [pane.id, pane.focused, pane.label]), [['p1', true, null], ['p2', false, '🤖 test · branch']])
    assert.equal(Object.keys(list[0]).length, 12)
    assert.equal((await cli(daemon.socket, ['pane', 'is-shell', 'p2'])).code, 0)
    assert.equal(JSON.parse((await cli(daemon.socket, ['pane', 'current'])).stdout).pane.id, 'p1')

    // 앱이 떨어졌다 다시 붙으면 화면이 되살아난다(직렬화에 출력이 들어 있다)
    app.close()
    const again = await connect(daemon.socket)
    const attached = await again.call('attach')
    assert.match(attached.result.snapshots.p2, /studio=1:p2:42/)
    assert.deepEqual(attached.result.state.tabs[0].tree, { split: 'right', ratio: 0.25, first: { pane: 'p1' }, second: { pane: 'p2' } })

    // 작업 공간 — delegate 처럼: 만들면 셸 탭 하나가 딸려 오고(--no-focus 면 보던 곳 그대로) 그 탭 이름을 바꾼다
    const created2 = JSON.parse((await cli(daemon.socket, ['workspace', 'create', '--label', 'web', '--cwd', dir, '--no-focus'])).stdout)
    assert.deepEqual(created2.workspace, { id: 'w2', label: 'web', active_tab_id: 't2', focused: false })
    assert.equal(created2.root_pane.workspace_id, 'w2')
    assert.equal((await cli(daemon.socket, ['tab', 'rename', 't2', 'web'])).code, 0)
    assert.deepEqual(JSON.parse((await cli(daemon.socket, ['tab', 'list', '--workspace', 'w2'])).stdout).tabs, [{ id: 't2', workspace_id: 'w2', label: 'web' }])
    assert.deepEqual(
      JSON.parse((await cli(daemon.socket, ['workspace', 'list'])).stdout).workspaces.map((workspace) => [workspace.id, workspace.focused]),
      [['w1', true], ['w2', false]],
    )
    // 그 작업 공간 셸은 자기 작업 공간 id 를 안다
    const root = created2.root_pane.id
    await cli(daemon.socket, ['pane', 'run', root, 'echo', 'ws=$ATHENA_STUDIO_WORKSPACE_ID'])
    assert.equal((await cli(daemon.socket, ['pane', 'wait-output', root, '--regex', '^ws=w2$', '--timeout', '8000'])).code, 0)
    // 탭을 닫으면 마지막 탭이라 작업 공간도 빠진다
    assert.equal((await cli(daemon.socket, ['tab', 'close', 't2'])).code, 0)
    await waitFor(async () => JSON.parse((await cli(daemon.socket, ['workspace', 'list'])).stdout).workspaces.length === 1, '작업 공간 w2 정리')

    // 오류: 없는 pane · 모르는 키 · 시간 초과
    const missing = await cli(daemon.socket, ['pane', 'get', 'p9'])
    assert.equal(missing.code, 1)
    assert.deepEqual(JSON.parse(missing.stderr), { error: 'not_found', message: '없는 pane: p9' })
    assert.equal(JSON.parse((await cli(daemon.socket, ['pane', 'send-keys', 'p2', 'Nope'])).stderr).error, 'usage')
    assert.equal(JSON.parse((await cli(daemon.socket, ['pane', 'wait-output', 'p2', '--match', 'never-printed-xyz', '--timeout', '300'])).stderr).error, 'timeout')

    // 닫으면 트리에서 빠지고 형제가 자리를 차지 · 앱에 exit 알림
    assert.equal((await cli(daemon.socket, ['pane', 'close', 'p2'])).code, 0)
    await waitFor(() => again.events.some((event) => event.event === 'exit' && event.pane === 'p2'), 'p2 exit 알림')
    const after = await again.call('attach')
    assert.deepEqual(after.result.state.tabs[0].tree, { pane: 'p1' })

    await again.call('shutdown')
    again.close()
    await waitFor(() => !alive(daemon.pid), '데몬 종료')
    assert.equal(fs.existsSync(daemon.endpoint), false)
  } finally {
    if (alive(daemon.pid)) process.kill(daemon.pid, 'SIGTERM')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('데몬에 못 붙으면 CLI 는 종료 3 · unavailable', async () => {
  const result = await cli('/tmp/asd-no-such-daemon.sock', ['pane', 'list'])
  assert.equal(result.code, 3)
  assert.equal(JSON.parse(result.stderr).error, 'unavailable')
})

test('떼어 띄운 데몬은 띄운 쪽이 끝나도 셸과 함께 산다', { skip: ptyMissing || false, timeout: 20000 }, async () => {
  const dir = workDir()
  // 중간 프로세스가 데몬을 떼어 띄우고 바로 끝난다(앱을 닫는 것과 같다)
  const launcher = `
    const { spawn } = require('child_process')
    const child = spawn(process.execPath, [${JSON.stringify(path.join(ROOT, 'src', 'daemon', 'main.js'))}, '--socket', ${JSON.stringify(path.join(dir, 'd.sock'))}, '--endpoint', ${JSON.stringify(path.join(dir, 'e.json'))}], { detached: true, stdio: 'ignore' })
    child.unref()
    console.log(child.pid)`
  const daemonPid = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', launcher], (error, stdout) => (error ? reject(error) : resolve(Number(stdout.trim())))))
  try {
    await waitFor(() => fs.existsSync(path.join(dir, 'd.sock')), '데몬 소켓')
    const app = await connect(path.join(dir, 'd.sock'))
    await app.call('tab new', { cwd: dir })
    app.close() // 앱이 떨어져도
    // 띄운 쪽(launcher)은 이미 끝났는데 데몬과 그 셸은 그대로 답한다
    assert.equal(alive(daemonPid), true)
    await waitFor(async () => (await cli(path.join(dir, 'd.sock'), ['pane', 'is-shell', 'p1'])).code === 0, '셸 프롬프트')
  } finally {
    process.kill(daemonPid, 'SIGTERM')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
