// 코드 교체 통합 — 임시 사본의 데몬을 실제 pty 로 띄워 사본 파일을 고치고 'daemon reload' 한다(레포 파일 · 평소 데몬을 건드리지 않는다)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const protocol = require('../src/lib/protocol')

const ROOT = path.join(__dirname, '..')

let ptyMissing = null
try {
  require('node-pty')
} catch (error) {
  ptyMissing = `node-pty 를 불러오지 못했다(${process.platform}) — ${error.message}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, what, limitMs = 8000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error(`${what} 를 기다리다 시간 초과`)
}

function connect(socket) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket)
    const pending = new Map()
    const events = []
    let nextId = 1
    connection.setEncoding('utf8')
    connection.on('data', protocol.createDecoder((message) => {
      if (message.event) events.push(message)
      else pending.get(message.id)?.(message)
    }))
    connection.once('error', reject)
    connection.once('connect', () => resolve({
      events,
      destroyed: () => connection.destroyed,
      call: (op, args = {}) => new Promise((done) => {
        const id = nextId++
        pending.set(id, done)
        connection.write(protocol.encode({ id, op, args }))
      }),
      close: () => connection.end(),
    }))
  })
}

function setup() {
  const dir = fs.mkdtempSync('/tmp/asd-reload-')
  fs.cpSync(path.join(ROOT, 'src', 'daemon'), path.join(dir, 'src', 'daemon'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'src', 'lib'), path.join(dir, 'src', 'lib'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'))
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'))
  const socket = path.join(dir, 'd.sock')
  const log = fs.openSync(path.join(dir, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [path.join(dir, 'src', 'daemon', 'main.mts'), '--socket', socket, '--endpoint', path.join(dir, 'e.json')], { detached: true, stdio: ['ignore', log, log] })
  child.unref()
  fs.closeSync(log)
  const edit = (file, from, to) => {
    const target = path.join(dir, 'src', file)
    const text = fs.readFileSync(target, 'utf8')
    assert.ok(text.includes(from), `${file} 에 ${from} 이 없다`)
    fs.writeFileSync(target, text.replace(from, to))
  }
  return { dir, socket, pid: child.pid, edit, end: () => { process.kill(child.pid, 'SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }) } }
}

const paneText = async (app, pane) => (await app.call('pane read', { pane, source: 'recent' })).result.text

async function runIn(app, pane, command, regex) {
  await app.call('pane run', { pane, text: command })
  return (await app.call('pane wait-output', { pane, regex, timeout: 8000 })).result
}

test('교체: pid · 입출력 · 연결 · 배치 유지, 크기 신호 없음, 크기 · 종료는 새 코드로', { skip: ptyMissing || false, timeout: 60000 }, async () => {
  const daemon = setup()
  try {
    await waitFor(() => fs.existsSync(daemon.socket), '데몬 소켓')
    const app = await connect(daemon.socket)
    const tab = (await app.call('tab new', { cwd: daemon.dir, cols: 100, rows: 30 })).result
    const split = (await app.call('pane split', { target: tab.pane, direction: 'right', cwd: daemon.dir })).result.pane.id
    await app.call('attach')
    // 옆 pane 에 크기 변경 신호(SIGWINCH)를 세는 기록기
    await runIn(app, split, `trap 'echo WINCH >> ${daemon.dir}/winch' WINCH; echo ready=$((1+1))`, '^ready=2$')
    await runIn(app, tab.pane, 'sleep 300 & echo job=$!', '^job=\\d+$')
    const pids = (await app.call('pane pids')).result.pids
    const layoutOf = (state) => ({ ...state, panes: state.panes.map(({ title, ...pane }) => pane) }) // 제목은 셸이 스스로 바꾼다
    const before = layoutOf((await app.call('state')).result)
    const job = /job=(\d+)/.exec(await paneText(app, tab.pane))[1]

    daemon.edit('lib/protocol.js', 'const DAEMON_CODE = 1', 'const DAEMON_CODE = 2')
    daemon.edit('daemon/daemon.mts', "pane.resize(Math.max(2, rect.width), Math.max(2, rect.height))", "pane.resize(50, 11)")
    daemon.edit('daemon/daemon.mts', "if ([...this.clients].some((client) => client.attached && !client.socket.destroyed && this.sees(client.body, body))) return\n", '')
    const reloaded = await app.call('daemon reload')
    assert.deepEqual(reloaded.result, { ok: true, codeVersion: 2 })

    assert.equal((await app.call('hello')).result.codeVersion, 2)
    assert.deepEqual((await app.call('pane pids')).result.pids, pids, 'pty 프로세스가 같다')
    assert.equal(process.kill(daemon.pid, 0), true)
    process.kill(Number(job), 0)
    assert.deepEqual(layoutOf((await app.call('state')).result), before, '탭 · 배치 · 포커스가 같다')
    assert.equal(app.destroyed(), false)
    await sleep(300)
    assert.equal(fs.existsSync(path.join(daemon.dir, 'winch')), false, '교체만으로 크기 신호가 생기지 않는다')

    // 기록기가 진짜 신호를 세는지 — 크기를 바꾸면 남아야 위 검사가 뜻이 있다
    await app.call('resize', { pane: split, cols: 61, rows: 19 })
    await waitFor(() => fs.existsSync(path.join(daemon.dir, 'winch')), '크기 신호 기록')
    // 입출력 · 교체 전 화면 유지
    await runIn(app, tab.pane, 'echo after=$((3+4))', '^after=7$')
    assert.match(await paneText(app, tab.pane), new RegExp(`job=${job}`))
    assert.ok(app.events.some((event) => event.event === 'data' && event.pane === tab.pane && event.data.includes('after=7')), '앱 연결로 출력이 이어진다')
    // 크기
    await app.call('resize', { pane: tab.pane, cols: 77, rows: 21 })
    await runIn(app, tab.pane, 'stty size', '^21 77$')
    // 고친 fitTab(새 코드) — 새 pane 을 나누면 바로 적용
    const third = (await app.call('pane split', { target: tab.pane, direction: 'down', cwd: daemon.dir })).result.pane.id
    await runIn(app, third, 'stty size', '^11 50$')
    // 종료 감지 · 배치 정리
    await app.call('pane run', { pane: third, text: 'exit' })
    await waitFor(() => app.events.some((event) => event.event === 'exit' && event.pane === third), '종료 알림')
    const left = (await app.call('state')).result
    assert.equal(left.panes.some((pane) => pane.id === third), false)
    assert.equal(JSON.stringify(left.tabs).includes(`"${third}"`), false)
    app.close()
  } finally {
    daemon.end()
  }
})

test('깨뜨린 새 코드 · 호환 판 불일치: 옛 코드로 계속 돌고 pane 이 안 꺼진다', { skip: ptyMissing || false, timeout: 40000 }, async () => {
  const daemon = setup()
  try {
    await waitFor(() => fs.existsSync(daemon.socket), '데몬 소켓')
    const app = await connect(daemon.socket)
    const tab = (await app.call('tab new', { cwd: daemon.dir })).result
    const pids = (await app.call('pane pids')).result.pids
    const file = path.join(daemon.dir, 'src', 'daemon', 'daemon.mts')
    const good = fs.readFileSync(file, 'utf8')

    fs.writeFileSync(file, 'export const = broken')
    const syntax = (await app.call('daemon reload')).result
    assert.equal(syntax.ok, false)
    assert.equal(syntax.reason, 'failed')

    fs.writeFileSync(file, `${good}\nthrow new Error('초기화 실패')\n`)
    assert.equal((await app.call('daemon reload')).result.reason, 'failed')

    fs.writeFileSync(file, good.replace('export const KERNEL_COMPAT = 1', 'export const KERNEL_COMPAT = 2'))
    assert.equal((await app.call('daemon reload')).result.reason, 'incompatible')

    // afterReload 가 던지면 되돌린다
    fs.writeFileSync(file, good.replace('this.state()\n    this.writeEndpoint()', "throw new Error('smoke')"))
    assert.equal((await app.call('daemon reload')).result.reason, 'failed')

    assert.deepEqual((await app.call('pane pids')).result.pids, pids)
    await runIn(app, tab.pane, 'echo alive=$((2+2))', '^alive=4$')

    // 고치면 다시 된다
    fs.writeFileSync(file, good)
    assert.equal((await app.call('daemon reload')).result.ok, true)
    await runIn(app, tab.pane, 'echo again=$((2+3))', '^again=5$')
    app.close()
  } finally {
    daemon.end()
  }
})
