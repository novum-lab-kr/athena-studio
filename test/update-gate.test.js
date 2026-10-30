// 코어 업데이트 대기 문 — 성공 · 실패 · 멈춤 모두 대기가 풀리는지, 대기 입구가 빠지지 않았는지
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createUpdateGate } = require('../src/lib/update-gate.mts')

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('열려 있으면 wait 는 바로 끝난다', async () => {
  const gate = createUpdateGate()
  assert.equal(gate.active(), false)
  await gate.wait()
})

test('업데이트 중에는 wait 가 기다렸다가 끝나면 풀린다 · 표시가 켜졌다 꺼진다', async () => {
  const changes = []
  const gate = createUpdateGate({ onChange: (running) => changes.push(running) })
  let finish
  const running = gate.run(() => new Promise((resolve) => (finish = resolve)))
  assert.equal(gate.active(), true)
  let released = false
  const waiting = gate.wait().then(() => (released = true))
  await tick()
  assert.equal(released, false)
  finish('done')
  assert.equal(await running, 'done')
  await waiting
  assert.equal(released, true)
  assert.equal(gate.active(), false)
  assert.deepEqual(changes, [true, false])
})

test('업데이트가 실패(예외)해도 대기가 풀린다', async () => {
  const gate = createUpdateGate()
  const running = gate.run(async () => {
    throw new Error('boom')
  })
  const waiting = gate.wait()
  await assert.rejects(running, /boom/)
  await waiting
  assert.equal(gate.active(), false)
})

test('업데이트가 멈추면 maxMs 뒤 기다리던 쪽을 풀고 표시도 내린다 · 일이 나중에 끝나도 안전하다', async () => {
  const changes = []
  const gate = createUpdateGate({ maxMs: 20, onChange: (running) => changes.push(running) })
  let finish
  const running = gate.run(() => new Promise((resolve) => (finish = resolve)))
  await gate.wait() // 20ms 뒤 풀려야 한다(안 풀리면 시험이 멈춘다)
  assert.equal(gate.active(), false)
  finish()
  await running
  assert.equal(gate.active(), false)
  assert.deepEqual(changes, [true, false])
})

test('업데이트가 겹쳐도(두 번) 둘 다 끝나야 열린다', async () => {
  const gate = createUpdateGate()
  let finishFirst
  let finishSecond
  const first = gate.run(() => new Promise((resolve) => (finishFirst = resolve)))
  const second = gate.run(() => new Promise((resolve) => (finishSecond = resolve)))
  let released = false
  const waiting = gate.wait().then(() => (released = true))
  finishFirst()
  await first
  await tick()
  assert.equal(released, false)
  finishSecond()
  await second
  await waiting
  assert.equal(released, true)
})

test('겹친 업데이트 중 하나만 시간 초과돼도 다른 쪽이 도는 동안 문은 닫혀 있다', async () => {
  const gate = createUpdateGate({ maxMs: 60 })
  gate.run(() => new Promise(() => {})) // 멈춘 업데이트(끝나지 않음) — 60ms 뒤 시간 초과
  await new Promise((resolve) => setTimeout(resolve, 30))
  let finishSecond
  const second = gate.run(() => new Promise((resolve) => (finishSecond = resolve))) // 둘째는 90ms 에 시간 초과
  let released = false
  const waiting = gate.wait().then(() => (released = true))
  await new Promise((resolve) => setTimeout(resolve, 45)) // 75ms — 첫째만 시간 초과
  assert.equal(released, false)
  assert.equal(gate.active(), true)
  finishSecond()
  await second
  await waiting
  assert.equal(released, true)
  assert.equal(gate.active(), false)
})

// ── 대기 입구 — 빠뜨리면 팩 작업이 옛 코어로 돈다. 입구를 바꾸면 이 시험과 계획서 표를 같이 고친다 ──
const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')

test('팩 명령 입구 — 밖으로 내보내는 runCore 는 문을 기다리고, 업데이트 자신은 기다리지 않는다', () => {
  const runner = read('main/core-runner.mts')
  assert.match(runner, /async function runCore\([^)]*\)[^{]*\{\s*await updateGate\.wait\(\)\s*return runCoreRaw\(/)
  assert.match(runner, /const runPack = \(args: string\[\], options: RunCoreOptions\) => runCore\(/)
  // 업데이트 · prepare 의 코어 명령은 문을 거치지 않는다(거치면 자기 자신을 기다려 멈춘다)
  assert.doesNotMatch(runner, /runCore: \(argv, options\) => runCore\(/)
  assert.equal((runner.match(/runCore: \(argv, options\) => runCoreRaw\(/g) || []).length, 2)
  assert.match(runner, /updateGate\.run\(/)
})

test('현황판 · 새 에이전트 · 자동 따라잡기 입구가 문을 본다', () => {
  assert.match(read('main/work.mts'), /ctx\.ensureBoard = async \(\) => \{[\s\S]*?await waitCoreUpdate\(\)[\s\S]*?queueBoard\(/)
  assert.match(read('main/athena-agent.mts'), /await waitCoreUpdate\(\)[\s\S]*?findAthenaWorkspace[\s\S]*?const decision = core\.agentDecision/)
  assert.match(read('main/catch-up.mts'), /if \(!force && updating\(\)\) return null/)
})

test('main 은 코어 업데이트를 창을 연 뒤에 돌리고 처음 준비는 update:false 로 한다', () => {
  const main = read('main.mts')
  assert.match(main, /prepareStudioCore\(\{ update: false \}\)/)
  assert.doesNotMatch(main, /prepareStudioCore\(\{ update: true \}\)/)
  assert.ok(main.indexOf('openSavedWindows()') < main.indexOf('void runCoreUpdateInBackground()'))
})

test('화면 시작 — 데몬에 붙는 것은 팩 목록(문에 걸림)을 기다리지 않고, 에이전트 시작 판단만 목록 뒤에 한다', () => {
  const screen = read('renderer/screen.ts')
  assert.match(screen, /startScreen\(packsReady: Promise<unknown>[^)]*\)[\s\S]*?await attach\(\)\)[\s\S]*?await packsReady[\s\S]*?welcomeShown\(\)/)
  assert.match(read('renderer/main.ts'), /void startScreen\(packsReady\)/)
})
