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
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon', 'main.mts'), '--socket', socket, '--endpoint', endpoint], {
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

    // 앱에서 경계를 끈 결과 — 탭 트리 비율이 바뀌고, 잎이나 없는 경계는 usage
    assert.equal((await again.call('tab ratio', { tab: 't1', path: [], ratio: 0.6 })).ok, true)
    assert.equal((await again.call('attach')).result.state.tabs[0].tree.ratio, 0.6)
    assert.equal((await again.call('tab ratio', { tab: 't1', path: ['first'], ratio: 0.5 })).error.code, 'usage')

    // 닫으면 트리에서 빠지고 형제가 자리를 차지 · 앱에 exit 알림
    assert.equal((await cli(daemon.socket, ['pane', 'close', 'p2'])).code, 0)
    await waitFor(() => again.events.some((event) => event.event === 'exit' && event.pane === 'p2'), 'p2 exit 알림')
    const after = await again.call('attach')
    assert.deepEqual(after.result.state.tabs[0].tree, { pane: 'p1' })

    // 고정 칸(dock) — 탭 밖 · 이름마다 하나(다시 불러도 같은 pane) · 그 셸에서 명령 실행 · 탭 목록·배치에는 안 들어간다
    const dock = await again.call('dock ensure', { name: 'monitor', cwd: dir, command: 'echo dock=$ATHENA_STUDIO_PANE_ID' })
    assert.equal(dock.result.created, true)
    assert.equal((await again.call('dock ensure', { name: 'monitor', cwd: dir })).result.pane, dock.result.pane)
    assert.equal((await cli(daemon.socket, ['pane', 'wait-output', dock.result.pane, '--regex', `^dock=${dock.result.pane}$`, '--timeout', '8000'])).code, 0)
    const docked = (await again.call('attach')).result.state
    assert.equal(docked.panes.find((pane) => pane.id === dock.result.pane).dock, 'monitor')
    assert.equal(docked.tabs.some((tab) => JSON.stringify(tab.tree).includes(dock.result.pane)), false)
    assert.equal((await again.call('focus', { pane: dock.result.pane })).ok, true) // 탭이 없어도 포커스는 된다
    // 고정 칸은 나눌 수 없다 — 탭이 없어서(분명한 usage 오류로)
    const splitDock = await cli(daemon.socket, ['pane', 'split', '--target', dock.result.pane, '--direction', 'right'])
    assert.equal(JSON.parse(splitDock.stderr).error, 'usage')

    await again.call('shutdown')
    again.close()
    await waitFor(() => !alive(daemon.pid), '데몬 종료')
    assert.equal(fs.existsSync(daemon.endpoint), false)
  } finally {
    if (alive(daemon.pid)) process.kill(daemon.pid, 'SIGTERM')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('데몬을 다시 띄워도 id 를 처음부터 다시 매기지 않는다(접속 파일 옆 -ids.json)', { skip: ptyMissing || false, timeout: 30000 }, async () => {
  const dir = workDir()
  let daemon = startDaemon(dir)
  try {
    await waitFor(() => fs.existsSync(daemon.socket), '데몬 소켓')
    const first = await connect(daemon.socket)
    await first.call('hello', { protocol: protocol.PROTOCOL })
    assert.deepEqual((await first.call('tab new', { label: 'athena', cwd: dir, cols: 100, rows: 30 })).result, { workspace: 'w1', tab: 't1', pane: 'p1' })
    await first.call('shutdown')
    first.close()
    await waitFor(() => !alive(daemon.pid), '데몬 종료')

    daemon = startDaemon(dir)
    await waitFor(() => fs.existsSync(daemon.socket), '다시 띄운 데몬 소켓')
    const second = await connect(daemon.socket)
    await second.call('hello', { protocol: protocol.PROTOCOL })
    assert.deepEqual((await second.call('tab new', { label: 'athena', cwd: dir, cols: 100, rows: 30 })).result, { workspace: 'w2', tab: 't2', pane: 'p2' })
    await second.call('shutdown')
    second.close()
    await waitFor(() => !alive(daemon.pid), '데몬 종료')
  } finally {
    if (alive(daemon.pid)) process.kill(daemon.pid, 'SIGTERM')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('데몬 창-본체 묶음(protocol 5): 연결마다 자기 본체 작업 공간 · 출력 · 포커스 · 고정 칸 · CLI 는 부른 pane 의 본체만', { skip: ptyMissing || false, timeout: 30000 }, async () => {
  const dir = workDir()
  const daemon = startDaemon(dir)
  const bodyA = path.join(dir, 'athena-a')
  const bodyB = path.join(dir, 'athena-b')
  try {
    await waitFor(() => fs.existsSync(daemon.socket), '데몬 소켓')
    const appA = await connect(daemon.socket)
    const appB = await connect(daemon.socket)
    await appA.call('attach', { body: bodyA })
    await appB.call('attach', { body: bodyB })
    const tabA = (await appA.call('tab new', { cwd: dir })).result
    const tabB = (await appB.call('tab new', { cwd: dir })).result
    assert.notEqual(tabA.workspace, tabB.workspace) // B 의 '지금 작업 공간'은 A 것이 아니다 — 새로 만든다

    // 상태는 자기 본체 것만
    const stateA = (await appA.call('state')).result
    const stateB = (await appB.call('state')).result
    assert.deepEqual(stateA.workspaces.map((workspace) => [workspace.id, workspace.body]), [[tabA.workspace, bodyA]])
    assert.deepEqual(stateB.panes.map((pane) => pane.id), [tabB.pane])
    assert.equal(stateA.focused, tabA.pane)
    assert.equal(stateB.focused, tabB.pane) // 포커스는 본체마다

    // 다른 본체 pane 은 없는 것처럼
    assert.equal((await appB.call('input', { pane: tabA.pane, data: 'x' })).error.code, 'not_found')
    // 크기 · 닫기 · 포커스 · 탭/작업 공간 고르기도 — 다른 본체 것은 건드리지 못한다(리뷰 제안 4)
    const tabIdA = (await appA.call('state')).result.tabs[0].id
    const otherBody = [
      ['resize', { pane: tabA.pane, cols: 40, rows: 10 }],
      ['pane close', { pane: tabA.pane }],
      ['tab close', { tab: tabIdA }],
      ['focus', { pane: tabA.pane }],
      ['tab select', { tab: tabIdA }],
      ['workspace select', { workspace: tabA.workspace }],
    ]
    for (const [op, args] of otherBody) assert.equal((await appB.call(op, args)).error?.code, 'not_found', op)
    assert.ok((await appA.call('state')).result.panes.some((pane) => pane.id === tabA.pane)) // A 의 pane 은 그대로 살아 있다

    // 묶이지 않은 연결이 B 의 탭 · pane 을 골라도 A 창의 보는 자리는 그대로 — lastKey(마지막으로 움직인 A)를 덮지 않는다(리뷰 제안 1)
    await appA.call('focus', { pane: tabA.pane })
    const unbound = await connect(daemon.socket)
    const tabIdB = (await appB.call('state')).result.tabs[0].id
    assert.equal((await unbound.call('tab select', { tab: tabIdB })).ok, true)
    assert.equal((await unbound.call('focus', { pane: tabB.pane })).ok, true)
    assert.equal((await unbound.call('workspace select', { workspace: tabB.workspace })).ok, true)
    const afterA = (await appA.call('state')).result
    assert.equal(afterA.activeWorkspace, tabA.workspace)
    assert.equal(afterA.focused, tabA.pane)
    const afterB = (await appB.call('state')).result
    assert.equal(afterB.activeWorkspace, tabB.workspace)
    assert.equal(afterB.focused, tabB.pane)
    unbound.close()

    // 출력은 그 본체 연결에만
    await cli(daemon.socket, ['pane', 'run', tabB.pane, 'echo', 'only-b'])
    await waitFor(() => appB.events.some((event) => event.event === 'data' && event.pane === tabB.pane && event.data.includes('only-b')), 'B 출력')
    assert.equal(appA.events.some((event) => event.event === 'data' && event.pane === tabB.pane), false)

    // 묶이지 않은 CLI 는 전부 · 부른 pane 이 있으면 그 본체만 — delegate 가 다른 팩 작업 공간을 이름으로 찾지 않게
    assert.equal(JSON.parse((await cli(daemon.socket, ['workspace', 'list'])).stdout).workspaces.length, 2)
    const fromA = { ATHENA_STUDIO_PANE_ID: tabA.pane }
    assert.deepEqual(JSON.parse((await cli(daemon.socket, ['workspace', 'list'], fromA)).stdout).workspaces.map((workspace) => workspace.id), [tabA.workspace])
    assert.equal(JSON.parse((await cli(daemon.socket, ['pane', 'read', tabB.pane], fromA)).stderr).error, 'not_found')
    // 부른 pane 의 본체에 새 작업 공간 — A 창에만 보인다
    const made = JSON.parse((await cli(daemon.socket, ['workspace', 'create', '--label', 'web', '--cwd', dir, '--no-focus'], fromA)).stdout)
    assert.ok((await appA.call('state')).result.workspaces.some((workspace) => workspace.id === made.workspace.id && workspace.body === bodyA))
    assert.equal((await appB.call('state')).result.workspaces.some((workspace) => workspace.id === made.workspace.id), false)
    assert.equal((await appA.call('state')).result.focused, tabA.pane) // --no-focus 면 A 의 보던 곳 그대로

    // pane 밖(일감)에서 부른 CLI 는 ATHENA_STUDIO_BODY 의 본체 — 만든 작업 공간이 그 창에만
    const fromBoard = JSON.parse((await cli(daemon.socket, ['workspace', 'create', '--label', 'qa', '--cwd', dir, '--no-focus'], { ATHENA_STUDIO_BODY: bodyB })).stdout)
    assert.ok((await appB.call('state')).result.workspaces.some((workspace) => workspace.id === fromBoard.workspace.id))
    assert.equal((await appA.call('state')).result.workspaces.some((workspace) => workspace.id === fromBoard.workspace.id), false)

    // 고정 칸도 본체마다 하나
    const dockA = (await appA.call('dock ensure', { name: 'monitor', cwd: dir })).result
    const dockB = (await appB.call('dock ensure', { name: 'monitor', cwd: dir })).result
    assert.notEqual(dockA.pane, dockB.pane)
    assert.equal((await appA.call('state')).result.panes.some((pane) => pane.id === dockB.pane), false)

    // 다시 붙을 때 되살릴 화면도 자기 본체 pane 만
    const again = await connect(daemon.socket)
    const attached = (await again.call('attach', { body: bodyA })).result
    assert.equal(Object.keys(attached.snapshots).includes(tabB.pane), false)
    assert.ok(Object.keys(attached.snapshots).includes(tabA.pane))

    await appA.call('shutdown')
    for (const connection of [appA, appB, again]) connection.close()
    await waitFor(() => !alive(daemon.pid), '데몬 종료')
  } finally {
    if (alive(daemon.pid)) process.kill(daemon.pid, 'SIGTERM')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('데몬 open-url: 그 본체에 붙은 앱 창 하나에만 알리고 {ok, target} · 못 고르면 not_found · http(s) 아니면 usage', { skip: ptyMissing || false, timeout: 20000 }, async () => {
  const dir = workDir()
  const daemon = startDaemon(dir)
  const bodyA = path.join(dir, 'athena-a')
  const bodyB = path.join(dir, 'athena-b')
  const url = 'http://localhost:4802/plans/setup/pick.html'
  try {
    await waitFor(() => fs.existsSync(daemon.socket), '데몬 소켓')
    const appA = await connect(daemon.socket)
    await appA.call('attach', { body: bodyA })
    // 창이 하나면 본체를 모르는 호출(일반 터미널)도 그 창으로
    assert.deepEqual(JSON.parse((await cli(daemon.socket, ['open-url', url])).stdout), { ok: true, target: 'panel' })
    await waitFor(() => appA.events.some((event) => event.event === 'open-url' && event.url === url), 'A 알림')
    const appB = await connect(daemon.socket)
    await appB.call('attach', { body: bodyB })
    // 일감(pane 밖)은 ATHENA_STUDIO_BODY 의 본체 창만
    const before = appA.events.length
    assert.deepEqual(JSON.parse((await cli(daemon.socket, ['open-url', url], { ATHENA_STUDIO_BODY: bodyB })).stdout), { ok: true, target: 'panel' })
    await waitFor(() => appB.events.some((event) => event.event === 'open-url'), 'B 알림')
    assert.equal(appA.events.slice(before).some((event) => event.event === 'open-url'), false)
    // 부른 pane 의 본체
    const tabA = (await appA.call('tab new', { cwd: dir })).result
    const fromA = await cli(daemon.socket, ['open-url', 'https://example.com/x'], { ATHENA_STUDIO_PANE_ID: tabA.pane })
    assert.deepEqual(JSON.parse(fromA.stdout), { ok: true, target: 'external' })
    await waitFor(() => appA.events.some((event) => event.event === 'open-url' && event.url === 'https://example.com/x'), 'A 의 pane 에서')
    // 창이 여럿인데 본체를 모르면 · 붙은 창이 없는 본체면 not_found(화면 계층이 기본 브라우저로)
    assert.equal(JSON.parse((await cli(daemon.socket, ['open-url', url])).stderr).error, 'not_found')
    assert.equal(JSON.parse((await cli(daemon.socket, ['open-url', url], { ATHENA_STUDIO_BODY: path.join(dir, 'none') })).stderr).error, 'not_found')
    assert.equal(JSON.parse((await cli(daemon.socket, ['open-url', 'file:///etc/hosts'], { ATHENA_STUDIO_BODY: bodyA })).stderr).error, 'usage')
    await appA.call('shutdown')
    for (const connection of [appA, appB]) connection.close()
    await waitFor(() => !alive(daemon.pid), '데몬 종료')
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
    const child = spawn(process.execPath, [${JSON.stringify(path.join(ROOT, 'src', 'daemon', 'main.mts'))}, '--socket', ${JSON.stringify(path.join(dir, 'd.sock'))}, '--endpoint', ${JSON.stringify(path.join(dir, 'e.json'))}], { detached: true, stdio: 'ignore' })
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

