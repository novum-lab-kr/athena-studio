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

function setup(t, runPack, { daemonCall = async () => ({ result: { panes: [] } }), welcome = false, refreshAllPacks = () => {}, withData = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-refresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bodies = { acme: fakeBody(root, 'acme'), globex: fakeBody(root, 'globex') }
  if (withData) fs.mkdirSync(path.join(root, 'data'), { recursive: true }) // 감시는 설치 때 데이터 폴더가 있어야 바로 걸린다(없으면 5초 주기 재시도)
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
    studio: { root, core: root, data: path.join(root, 'data') },
    runPack: (args, options) => runPack(args, options, bodies),
    contractBlock: async () => null,
    packWindows: new Set([ctx]),
    openPackIds: () => [],
    refreshAllPacks,
    ctxOfBody: () => null,
    openBody: () => ({}),
    daemonOld: () => false,
    restoreArmedFor: () => null,
    disarmRestore: () => {},
    setLastPackFile: () => {},
    launchWelcome: () => welcome,
    setLaunchWelcome: (value) => (welcome = value),
  })
  t.after(() => ctx.stopPackWatch && ctx.stopPackWatch())
  return { ctx, bodies, sent, data: path.join(root, 'data') }
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

// 새 팩의 /setup 이 앱을 거치지 않고 임시 id(new-…)를 회사 이름으로 바꾼다 — 팩 줄에 남은 옛 id 로 열면 not-found 가 온다(GitHub #169).
// 그때 모든 창의 목록을 새로 읽어 팩 줄이 지금 목록으로 맞춰져야 한다
test('팩 열기: 옛 id 로 not-found 가 오면 모든 창의 목록을 다시 읽는다', async (t) => {
  let refreshed = 0
  const { ctx } = setup(
    t,
    async (args) => (args[0] === 'open' ? { ok: false, error: 'not-found' } : { ok: true }),
    { refreshAllPacks: () => (refreshed += 1) },
  )
  const result = await ctx.packOpen('new-20261030-1')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not-found')
  assert.equal(refreshed, 1)
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// 조건이 참이 될 때까지 기다린다(감시 디바운스 300ms)
async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(50)
  }
  return check()
}

// 창이 계속 앞에 있어도(focus 가 다시 오지 않아도) pane 안 /setup 이 레지스트리를 바꾸면 목록을 다시 읽는다 — 레지스트리는 임시 파일 → rename 으로 쓴다
test('팩 목록: 레지스트리(config.json)가 바뀌면 창이 앞에 있어도 목록을 다시 읽는다', async (t) => {
  let lists = 0
  const { ctx, data } = setup(t, async (args, options, all) => {
    lists += 1
    return listOf(all, options.dir)
  })
  fs.writeFileSync(path.join(data, 'config.json'), '{}')
  await sleep(500)
  assert.ok(ctx.stopPackWatch)
  const before = lists
  fs.writeFileSync(path.join(data, 'config.json.1.tmp'), '{"a":1}') // 다른 파일은 무시
  await sleep(500)
  assert.equal(lists, before)
  fs.renameSync(path.join(data, 'config.json.1.tmp'), path.join(data, 'config.json')) // renameNewSlot 의 저장 방식
  assert.ok(await until(() => lists > before), '레지스트리가 바뀌었는데 목록을 다시 읽지 않았다')
})

test('팩 목록: 데이터 폴더가 아직 없어도 오류 없이 설치되고, 창을 닫으면(stopPackWatch) 더는 읽지 않는다', async (t) => {
  let lists = 0
  const { ctx, data } = setup(
    t,
    async (args, options, all) => {
      lists += 1
      return listOf(all, options.dir)
    },
    { withData: false },
  )
  assert.equal(fs.existsSync(data), false)
  fs.mkdirSync(data, { recursive: true })
  ctx.stopPackWatch()
  const before = lists
  fs.writeFileSync(path.join(data, 'config.json'), '{}')
  await sleep(700)
  assert.equal(lists, before)
})

// 창 focus — 레지스트리를 놓쳐도(감시 실패) 앞으로 올 때 한 번 더 맞춘다. electron 을 흉내 내 창 설치만 돈다
test('창 focus: 앞으로 오면 팩 목록을 다시 읽는다', async () => {
  const handlers = {}
  globalThis.__fakeBrowserWindow = class {
    constructor() {
      this.webContents = { on: () => {} }
    }
    loadFile() {}
    on(name, handler) {
      handlers[name] = handler
    }
  }
  // electron 모듈만 가짜로 — Node 의 모듈 훅(ESM 도 거친다)
  const hook = require('node:module').registerHooks({
    resolve: (specifier, context, next) => (specifier === 'electron' ? { url: 'data:text/javascript,export const BrowserWindow = globalThis.__fakeBrowserWindow', shortCircuit: true } : next(specifier, context)),
  })
  try {
    const { installPackWindow } = require('../src/main/pack-window.mts')
    let refreshed = 0
    const ctx = { win: null, packState: {}, send: () => {}, stopRequests: () => {}, dropBrowser: () => {}, detachScreen: () => {}, refreshPacks: async () => (refreshed += 1) }
    installPackWindow(ctx, {
      packWindows: new Set([ctx]), openPackIds: () => [], saveWindows: () => {}, openUrl: () => {}, hasTray: () => false, pollTray: () => {},
      monitor: { timer: null }, appIcon: '', appBackground: '#000', quitting: () => false, lastFocused: () => null, setLastFocused: () => {},
    })
    handlers.focus()
    assert.equal(refreshed, 1)
  } finally {
    hook.deregister()
    delete globalThis.__fakeBrowserWindow
  }
})
