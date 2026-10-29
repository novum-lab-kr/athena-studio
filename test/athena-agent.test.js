// 아테나 켜기(src/main/athena-agent.mts openAthenaAgent) — 데몬이 새로 뜬 뒤 다시 붙기 · 빈 창 셸 탭 · 여러 창이 겹쳐 불러도
// main 의 아테나 폴더별 줄(core.keyedQueue)을 거치면 아테나 작업 공간 · 에이전트가 한 번만 생긴다(사용자 결정 R1 · 2026-10-29)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const core = require('../src/lib/core.mts')
const { installAthenaAgent } = require('../src/main/athena-agent.mts')

// 아테나 본체로 보이는 폴더(core.checkAthenaDir — CLAUDE.md · scripts/board/server.mjs)
function fakeBody(root, name) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'scripts', 'board'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '')
  fs.writeFileSync(path.join(dir, 'scripts', 'board', 'server.mjs'), '')
  return dir
}

// 빈 데몬 하나 — 작업 공간 만들기는 조금 늦게 끝난다(그 사이 다른 요청이 state 를 읽을 수 있게)
function fakeDaemon() {
  const workspaces = []
  const calls = []
  let next = 1
  const callFor = (body) => async (op, args = {}) => {
    calls.push({ body, op, args })
    if (op === 'state') return { result: { workspaces: workspaces.filter((entry) => entry.body === body), tabs: [] } }
    if (op === 'workspace create') {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const id = `w${next++}`
      workspaces.push({ id, label: args.label, cwd: args.cwd, body })
      return { result: { workspace: { id }, root_pane: { id: `p${id}` } } }
    }
    return { result: {} }
  }
  return { workspaces, calls, callFor }
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-agent-'))
  // PATH 에 claude 하나 — agentDecision 이 claude 를 고르게
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = bin
  t.after(() => {
    process.env.PATH = savedPath
    fs.rmSync(root, { recursive: true, force: true })
  })
  const daemon = fakeDaemon()
  const makeCtx = (athenaDir) => {
    const ctx = { athenaDir, daemonCall: daemon.callFor(athenaDir), packTask: (_name, work) => work(), packProgress() {}, studioEnv: () => ({}) }
    installAthenaAgent(ctx, { say: (key) => key, runPack: async () => ({ ok: true }), disarmRestore() {} })
    return ctx
  }
  return { root, daemon, makeCtx }
}

const started = (daemon) => daemon.calls.filter((call) => call.op === 'pane run')

test('줄 세우기: 같은 열쇠는 앞 일이 끝난 뒤(실패해도) · 다른 열쇠는 따로', async () => {
  const queue = core.keyedQueue()
  const order = []
  const slow = (name, ms, fail = false) => () => new Promise((resolve, reject) => setTimeout(() => (order.push(name), fail ? reject(new Error(name)) : resolve(name)), ms))
  const first = queue('a', slow('a1', 30, true))
  const second = queue('a', slow('a2', 1))
  const other = queue('b', slow('b1', 5))
  await assert.rejects(first)
  assert.equal(await second, 'a2')
  assert.equal(await other, 'b1')
  assert.deepEqual(order, ['b1', 'a1', 'a2'])
})

test('겹친 아테나 켜기: 줄 없이는 둘 다 만들고, 줄을 거치면 한 번만 켜고 둘째는 그 작업 공간으로 옮긴다', async (t) => {
  // 줄 없이 — 고치기 전 모양(둘 다 빈 state 를 읽는다)
  {
    const { root, daemon, makeCtx } = setup(t)
    const ctx = makeCtx(fakeBody(root, 'body'))
    await Promise.all([ctx.openAthenaAgent({}), ctx.openAthenaAgent({})])
    assert.equal(daemon.workspaces.length, 2)
  }
  const { root, daemon, makeCtx } = setup(t)
  const ctx = makeCtx(fakeBody(root, 'body'))
  const queue = core.keyedQueue()
  const key = core.realDir(ctx.athenaDir)
  const results = await Promise.all([queue(key, () => ctx.openAthenaAgent({})), queue(key, () => ctx.openAthenaAgent({ cols: 80 }))])
  assert.deepEqual(daemon.workspaces.map((entry) => entry.label), ['athena'])
  assert.equal(started(daemon).length, 1)
  assert.equal(started(daemon)[0].args.text, 'claude')
  assert.equal(results[0].started, 'claude')
  assert.equal(results[1].focused, true)
})

test('두 창(다른 본체): 본체마다 아테나 하나씩 — 같은 본체를 두 창이 불러도 하나', async (t) => {
  const { root, daemon, makeCtx } = setup(t)
  const acme = fakeBody(root, 'acme')
  const globex = fakeBody(root, 'globex')
  const windows = [makeCtx(acme), makeCtx(globex), makeCtx(acme)]
  const queue = core.keyedQueue()
  await Promise.all(windows.map((ctx) => queue(core.realDir(ctx.athenaDir), () => ctx.openAthenaAgent({}, { keepView: true }))))
  assert.deepEqual(daemon.workspaces.map((entry) => path.basename(entry.cwd)).sort(), ['acme', 'globex'])
  assert.ok(daemon.workspaces.every((entry) => entry.label === 'athena'))
  assert.equal(started(daemon).length, 2)
})

test('아테나 켜기 뒤 새 탭(빈 창 셸 탭)은 그 athena 작업 공간에 붙는다', async (t) => {
  const { root, daemon, makeCtx } = setup(t)
  const ctx = makeCtx(fakeBody(root, 'body'))
  const queue = core.keyedQueue()
  const key = core.realDir(ctx.athenaDir)
  const [, tab] = await Promise.all([
    queue(key, () => ctx.openAthenaAgent({})),
    queue(key, async () => core.newTabRequest((await ctx.daemonCall('state')).result, ctx.athenaDir)),
  ])
  assert.deepEqual(tab, { op: 'tab new', args: { workspace: daemon.workspaces[0].id } })
})

test('옛 버그로 폴더 이름이 붙은 아테나 작업 공간이 있으면 새로 만들지 않고 그리로 옮긴다(#120 후속)', async (t) => {
  const { root, daemon, makeCtx } = setup(t)
  const body = fakeBody(root, 'new-20261025-184407')
  daemon.workspaces.push({ id: 'w9', label: 'new-20261025-184407', cwd: body, body })
  const ctx = makeCtx(body)
  const result = await ctx.openAthenaAgent({})
  assert.equal(result.focused, true)
  assert.deepEqual(daemon.workspaces.map((entry) => entry.id), ['w9'])
  assert.equal(started(daemon).length, 0)
  assert.deepEqual(daemon.calls.filter((call) => call.op === 'workspace select').map((call) => call.args.workspace), ['w9'])
})
