// 팩 창 목록 새로 읽기(src/main/packs.mts refreshPacks) — 읽는 사이 창이 다른 본체로 다시 묶이면 옛 본체 목록을 버리고 지금 본체로 다시 읽는다.
// 처음 여는 팩은 packOpen 이 rebindBody 전에 refreshAllPacks 를 불러 옛 본체 목록이 늦게 끝날 수 있다 — 그 목록이 새 팩 상태를 덮으면
// 팩 줄이 옛 팩으로 돌아가고 창이 옛 팩에 묶인 줄 안다(2026-10-28 가짜 팩 화면 확인으로 재현)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { installPacks } = require('../src/main/packs.mts')

// 아테나 본체로 보이는 폴더(core.checkAthenaDir — CLAUDE.md · scripts/board/server.mjs)
function fakeBody(root, name) {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'scripts', 'board'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '')
  fs.writeFileSync(path.join(dir, 'scripts', 'board', 'server.mjs'), '')
  return dir
}

function setup(t, runPack, { daemonCall = async () => ({ result: { panes: [] } }), welcome = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-refresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bodies = { acme: fakeBody(root, 'acme'), globex: fakeBody(root, 'globex') }
  const sent = []
  const ctx = {
    athenaDir: bodies.acme,
    win: null,
    packState: { supported: false },
    packBusy: null,
    packAbort: null,
    send: (channel, value) => sent.push({ channel, value }),
    packProgress: () => {},
    daemonCall,
    rebindBody: () => ({}),
    packRepos: async () => [],
    show: () => {},
    restoreNow: async () => ({}),
  }
  const stub = () => {
    throw new Error('부르지 않아야 함')
  }
  installPacks(ctx, {
    app: { getPath: stub },
    dialog: { showOpenDialog: stub },
    Menu: { buildFromTemplate: stub },
    say: (key) => key,
    studio: { root, core: root },
    runPack: (args, options) => runPack(args, options, bodies),
    contractBlock: async () => null,
    packWindows: new Set([ctx]),
    openPackIds: () => [],
    refreshAllPacks: () => {},
    ctxOfBody: () => null,
    openBody: () => ({}),
    daemonOld: () => false,
    restoreArmedFor: () => null,
    disarmRestore: () => {},
    setLastPackFile: () => {},
    launchWelcome: () => welcome,
    setLaunchWelcome: (value) => (welcome = value),
  })
  return { ctx, bodies, sent }
}

// pack list 흉내 — current 는 부른 본체의 팩
const listOf = (bodies, dir) => {
  const id = Object.keys(bodies).find((key) => bodies[key] === dir)
  return { ok: true, current: { id, name: id }, switching: false, packs: [{ id: 'acme', name: 'acme' }, { id: 'globex', name: 'globex' }] }
}

test('팩 목록: 읽는 사이 다른 본체로 다시 묶이면 옛 목록을 버리고 지금 본체로 다시 읽는다', async (t) => {
  const calls = []
  let releaseOld
  const oldDone = new Promise((resolve) => (releaseOld = resolve))
  const { ctx, bodies, sent } = setup(t, async (args, options, all) => {
    calls.push(options.dir)
    // 옛 본체(acme) 목록은 늦게 끝난다(부하 흉내)
    if (options.dir === all.acme) await oldDone
    return listOf(all, options.dir)
  })
  const stale = ctx.refreshPacks() // packOpen 의 refreshAllPacks — 아직 acme 본체
  ctx.athenaDir = bodies.globex // rebindBody
  const fresh = await ctx.refreshPacks() // 화면의 refreshPackList — globex 본체
  assert.equal(fresh.current.id, 'globex')
  releaseOld()
  const late = await stale
  assert.equal(late.current.id, 'globex')
  assert.equal(ctx.packState.current.id, 'globex')
  // 화면에 간 마지막 상태도 globex — 옛 acme 상태는 보내지 않는다
  const states = sent.filter((item) => item.channel === 'pack:state')
  assert.equal(states.at(-1).value.current.id, 'globex')
  assert.ok(states.every((item) => item.value.current.id === 'globex'))
  assert.deepEqual(calls, [bodies.acme, bodies.globex, bodies.globex])
})

test('팩 목록: 본체가 그대로면 한 번만 읽는다', async (t) => {
  const calls = []
  const { ctx, bodies } = setup(t, async (args, options, all) => {
    calls.push(options.dir)
    return listOf(all, options.dir)
  })
  const state = await ctx.refreshPacks()
  assert.equal(state.current.id, 'acme')
  assert.deepEqual(calls, [bodies.acme])
})

test('팩 목록: 시작 화면 판단(데몬 pane 목록)을 기다리는 사이 본체가 바뀌어도 옛 목록을 버린다', async (t) => {
  const calls = []
  let releasePanes
  const panesDone = new Promise((resolve) => (releasePanes = resolve))
  let firstPanes = true
  const { ctx, bodies, sent } = setup(
    t,
    async (args, options, all) => {
      calls.push(options.dir)
      return listOf(all, options.dir)
    },
    {
      // 켤 때 시작 화면을 아직 정하지 않았다(null) — 첫 목록이 데몬 pane 목록을 기다린다
      welcome: null,
      daemonCall: async () => {
        if (firstPanes) {
          firstPanes = false
          await panesDone
        }
        return { result: { panes: [] } }
      },
    },
  )
  const stale = ctx.refreshPacks() // acme 본체 목록은 받았고 pane 목록을 기다리는 중
  await new Promise((resolve) => setImmediate(resolve))
  ctx.athenaDir = bodies.globex // 그사이 rebindBody
  releasePanes()
  const late = await stale
  assert.equal(late.current.id, 'globex')
  assert.equal(ctx.packState.current.id, 'globex')
  assert.ok(sent.filter((item) => item.channel === 'pack:state').every((item) => item.value.current.id === 'globex'))
  assert.deepEqual(calls, [bodies.acme, bodies.globex])
})
