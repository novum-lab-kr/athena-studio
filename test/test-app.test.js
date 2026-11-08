// 시험(격리) 앱 끄기 — 기록한 pid 와 그 자식 · 그 집 데몬만 끄고, 기록 밖 프로세스는 건드리지 않는다(실제 자식 프로세스 · Electron 없이)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const testApp = require('../src/lib/test-app.mts')
const { tempDir } = require('./temp-dirs')

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const startedAt = (pid) => {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
const realDeps = {
  rows: () => testApp.parseRows(execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })),
  startedAt,
  alive,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// 자식 하나를 띄우고 그 pid 를 stdout 으로 알리는 부모(앱 흉내) — 부모 · 자식 pid 를 돌려준다
function spawnTree() {
  const script = "const { spawn } = require('child_process'); const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(kid.pid); setInterval(() => {}, 1000)"
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  return new Promise((resolve) => parent.stdout.once('data', (chunk) => resolve({ parent: parent.pid, kid: Number(String(chunk).trim()) })))
}
const spawnLoner = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid
const cleanup = (pids) => pids.filter(alive).forEach((pid) => process.kill(pid, 'SIGKILL'))
const waitDead = async (pid) => {
  for (let waited = 0; alive(pid) && waited < 3000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
  return !alive(pid)
}

test('homeProblem: 비었거나 · 상대 경로 · 진짜 스튜디오 집과 겹치면 막는다', () => {
  const real = '/Users/me/.athena-studio'
  assert.match(testApp.homeProblem('', real), /--home/)
  assert.match(testApp.homeProblem('tmp/x', real), /절대 경로/)
  assert.match(testApp.homeProblem(real, real), /겹치는/)
  assert.match(testApp.homeProblem(`${real}/core`, real), /겹치는/)
  assert.match(testApp.homeProblem('/Users/me', real), /겹치는/)
  assert.equal(testApp.homeProblem('/tmp/athena-test-home', real), '')
  assert.equal(testApp.homeProblem('/Users/me/.athena-studio-test', real), '')
})

test('parseRows · descendantsOf: 자손만 모은다(형제 · 부모 쪽은 빼고)', () => {
  const rows = testApp.parseRows('  10     1\n  11    10\n  12    11\n  13     1\n  garbage\n  14    13\n')
  assert.deepEqual(rows, [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 13, ppid: 1 },
    { pid: 14, ppid: 13 },
  ])
  assert.deepEqual(testApp.descendantsOf(rows, [10]).sort(), [10, 11, 12])
  assert.deepEqual(testApp.descendantsOf(rows, []), [])
  assert.deepEqual(testApp.descendantsOf(rows, [1]), [], '1(launchd)은 뿌리로 받지 않는다')
})

test('readRecord: 모양이 틀린 기록은 없는 것으로', () => {
  const home = tempDir('athena-test-app-')
  assert.equal(testApp.readRecord(home), null)
  fs.writeFileSync(testApp.recordPath(home), '{"pid":"12"}')
  assert.equal(testApp.readRecord(home), null)
  fs.writeFileSync(testApp.recordPath(home), '{"pid":1,"startedAt":"x"}')
  assert.equal(testApp.readRecord(home), null)
  testApp.writeRecord(home, { pid: 4321, startedAt: 'Sun Nov  8 20:00:00 2026', home, at: 'now' })
  assert.deepEqual(testApp.readRecord(home), { pid: 4321, startedAt: 'Sun Nov  8 20:00:00 2026', home, at: 'now' })
})

test('stopTestApp: 기록한 앱과 그 자식 · 그 집 데몬만 끄고 관계없는 프로세스는 살린다', async () => {
  const home = tempDir('athena-test-app-')
  const app = await spawnTree()
  const daemon = spawnLoner()
  const bystander = spawnLoner() // 사용자 앱 흉내 — 기록에 없다
  try {
    testApp.writeRecord(home, { pid: app.parent, startedAt: startedAt(app.parent), home, at: '' })
    fs.writeFileSync(path.join(home, 'daemon-dev.json'), JSON.stringify({ pid: daemon, startedAt: new Date().toISOString() }))
    const result = await testApp.stopTestApp(home, realDeps, { graceMs: 3000 })
    assert.equal(result.ok, true)
    assert.deepEqual([...result.stopped].sort(), [app.parent, app.kid, daemon].sort())
    assert.ok(await waitDead(app.parent), '앱(부모)이 꺼진다')
    assert.ok(await waitDead(app.kid), '앱의 자식이 꺼진다')
    assert.ok(await waitDead(daemon), '그 집 데몬이 꺼진다')
    assert.equal(alive(bystander), true, '기록 밖 프로세스는 살아 있다')
    assert.equal(fs.existsSync(testApp.recordPath(home)), false, '끝낸 기록은 지운다')
  } finally {
    cleanup([app.parent, app.kid, daemon, bystander])
  }
})

test('stopTestApp: 기록이 없으면 앱 쪽은 아무것도 끄지 않는다', async () => {
  const home = tempDir('athena-test-app-')
  const bystander = spawnLoner()
  try {
    const result = await testApp.stopTestApp(home, realDeps, { graceMs: 500 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.stopped, [])
    assert.match(result.reason, /기록/)
    assert.equal(alive(bystander), true)
  } finally {
    cleanup([bystander])
  }
})

test('stopTestApp: 같은 pid 를 다른 프로세스가 쓰면(시작 시각이 다름) 끄지 않고 기록을 남긴다', async () => {
  const home = tempDir('athena-test-app-')
  const other = await spawnTree()
  try {
    testApp.writeRecord(home, { pid: other.parent, startedAt: 'Thu Jan  1 09:00:00 1970', home, at: '' })
    const result = await testApp.stopTestApp(home, realDeps, { graceMs: 500 })
    assert.equal(result.ok, false)
    assert.deepEqual(result.stopped, [])
    assert.equal(alive(other.parent), true)
    assert.equal(alive(other.kid), true)
    assert.equal(fs.existsSync(testApp.recordPath(home)), true, '거절한 기록은 남긴다')
  } finally {
    cleanup([other.parent, other.kid])
  }
})

// 데몬 접속 파일만 남고 그 pid 를 다른 프로세스가 다시 쓴 경우 — 앱 기록으로 확인되지 않으면 데몬 자리 pid 를 끄지 않는다
test('stopTestApp: 기록이 없으면 데몬 접속 파일의 pid 도 끄지 않는다', async () => {
  const home = tempDir('athena-test-app-')
  const reused = spawnLoner()
  try {
    fs.writeFileSync(path.join(home, 'daemon-dev.json'), JSON.stringify({ pid: reused }))
    const result = await testApp.stopTestApp(home, realDeps, { graceMs: 500 })
    assert.deepEqual(result.stopped, [])
    assert.match(result.reason, /데몬/)
    assert.equal(alive(reused), true)
  } finally {
    cleanup([reused])
  }
})

test('stopTestApp: 남의 pid 라 거절하면 데몬 접속 파일의 pid 도 끄지 않는다', async () => {
  const home = tempDir('athena-test-app-')
  const other = await spawnTree()
  const reused = spawnLoner()
  try {
    testApp.writeRecord(home, { pid: other.parent, startedAt: 'Thu Jan  1 09:00:00 1970', home, at: '' })
    fs.writeFileSync(path.join(home, 'daemon-dev.json'), JSON.stringify({ pid: reused }))
    const result = await testApp.stopTestApp(home, realDeps, { graceMs: 500 })
    assert.equal(result.ok, false)
    assert.deepEqual(result.stopped, [])
    assert.equal(alive(reused), true)
  } finally {
    cleanup([other.parent, other.kid, reused])
  }
})

test('stopTestApp: 앱보다 먼저 시작한 프로세스가 데몬 pid 를 쓰면(옛 접속 파일) 그 프로세스와 자식은 남긴다', async () => {
  const home = tempDir('athena-test-app-')
  const older = await spawnTree() // 옛 데몬 pid 를 다시 쓴 관계없는 프로세스 흉내 — 앱보다 먼저 시작
  await new Promise((resolve) => setTimeout(resolve, 1100)) // ps lstart 는 초 단위
  const app = await spawnTree()
  try {
    testApp.writeRecord(home, { pid: app.parent, startedAt: startedAt(app.parent), home, at: '' })
    fs.writeFileSync(path.join(home, 'daemon-dev.json'), JSON.stringify({ pid: older.parent, startedAt: new Date(Date.now() - 3600_000).toISOString() }))
    const result = await testApp.stopTestApp(home, realDeps, { graceMs: 3000 })
    assert.equal(result.ok, true)
    assert.deepEqual([...result.stopped].sort(), [app.parent, app.kid].sort())
    assert.match(result.reason, /맞지 않아/)
    assert.ok(await waitDead(app.parent))
    assert.equal(alive(older.parent), true)
    assert.equal(alive(older.kid), true)
  } finally {
    cleanup([app.parent, app.kid, older.parent, older.kid])
  }
})

test('stopTestApp: 앱이 살아 있는 동안 데몬이 끝나고 그 pid 를 다시 쓴 프로세스는(접속 파일 시각보다 늦게 시작) 남긴다', async () => {
  const home = tempDir('athena-test-app-')
  const app = await spawnTree()
  const written = new Date().toISOString() // 옛 데몬이 접속 파일에 적은 시작 시각 — 앱 시작 뒤
  await new Promise((resolve) => setTimeout(resolve, 1100)) // ps lstart 는 초 단위
  const reused = await spawnTree() // 옛 데몬이 끝난 뒤 그 pid 를 다시 쓴 관계없는 프로세스 흉내
  try {
    testApp.writeRecord(home, { pid: app.parent, startedAt: startedAt(app.parent), home, at: '' })
    fs.writeFileSync(path.join(home, 'daemon-dev.json'), JSON.stringify({ pid: reused.parent, startedAt: written }))
    const result = await testApp.stopTestApp(home, realDeps, { graceMs: 3000 })
    assert.equal(result.ok, true)
    assert.deepEqual([...result.stopped].sort(), [app.parent, app.kid].sort())
    assert.match(result.reason, /맞지 않아/)
    assert.ok(await waitDead(app.parent))
    assert.equal(alive(reused.parent), true)
    assert.equal(alive(reused.kid), true)
  } finally {
    cleanup([app.parent, app.kid, reused.parent, reused.kid])
  }
})
