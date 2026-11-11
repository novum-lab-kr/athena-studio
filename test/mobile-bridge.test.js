// 모바일 브리지(src/main/mobile-bridge.mts) — 폰 메시지(4-7)를 데몬 · 요청 · 결정 콘솔로 잇는다
// 가짜 데몬(유닉스 소켓)으로 실제 daemon-client 를 태우고, 폰 쪽은 메모리 전송으로 흉내 낸다 — Electron · pty 없이 돈다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const protocol = require('../src/lib/protocol')
const bridgeModule = require('../src/main/mobile-bridge.mts')

const { createMobileBridge, createMemoryTransport, weekMerges, livePanes, paneSizes, readLeadPane, boardActionPoster, mobileInputAllowed, readPlanData, openDecisionPlans, decisionPrompt, repoOfCwd, paneWhere, otherPackCounts, mergeKey, parsePrView, parseShortstat, createMergeDetails, mergeFeed } = bridgeModule
const { packView, bodyPacks, serverSummary } = require('../src/main/mobile-dev.mts')

// 소켓 경로 104바이트 제한 — /tmp 아래 짧게
const workDir = () => fs.mkdtempSync('/tmp/asd-mob-')

// 가짜 데몬 — hello · attach(스냅숏 · state 크기) · state · pane list · input 에 답하고, 받은 요청을 모두 적는다
function startFakeDaemon(socketPath) {
  const clients = []
  const state = {
    ops: [],
    snapshots: { p1: 'P1-화면', p2: 'P2-화면' },
    panes: [
      { id: 'p1', label: '아테나', agent: 'claude', agent_status: 'working', cwd: '/숨길/경로', cols: 120, rows: 40, workspace_id: 'w1' },
      { id: 'p2', label: 'fe', agent: 'codex', agent_status: 'idle', cols: 80, rows: 24 },
    ],
    // 데몬 state(범위 없음)의 작업 공간 — body 는 본체 실제 경로
    workspaces: [{ id: 'w1', label: 'athena', cwd: '/b/acme', activeTab: 't1', body: '/b/acme' }],
    // 데몬 state.panes 의 크기(attach · state 가 같이 준다)
    sizes: { p1: { cols: 120, rows: 40 }, p2: { cols: 80, rows: 24 } },
    failState: false, // true 면 state 요청에 실패로 답한다(크기 보기 실패)
  }
  const daemonState = () => ({ workspaces: state.workspaces, panes: Object.entries(state.sizes).map(([id, size]) => ({ id, tab: 't1', ...size })) })
  const server = net.createServer((socket) => {
    const client = { socket, attached: false }
    clients.push(client)
    socket.setEncoding('utf8')
    socket.on('data', protocol.createDecoder((message) => {
      state.ops.push({ op: message.op, args: message.args || {} })
      let result = {}
      if (message.op === 'hello') result = { protocol: protocol.PROTOCOL, codeVersion: protocol.DAEMON_CODE }
      else if (message.op === 'attach') {
        client.attached = true
        result = { state: daemonState(), snapshots: state.snapshots }
      } else if (message.op === 'state') result = daemonState()
      else if (message.op === 'pane list') result = { panes: state.panes }
      if (message.op === 'state' && state.failState) return void socket.write(protocol.encode({ id: message.id, ok: false, error: { code: 'busy', message: '시험용 실패' } }))
      socket.write(protocol.encode({ id: message.id, ok: true, result }))
    }))
    socket.on('error', () => {})
  })
  return new Promise((resolve) =>
    server.listen(socketPath, () =>
      resolve({
        state,
        attached: () => clients.filter((client) => client.attached && !client.socket.destroyed),
        live: () => clients.filter((client) => !client.socket.destroyed).length,
        // 붙은 연결에만 알림(데몬 broadcast 와 같다)
        emit: (event) => {
          for (const client of clients) if (client.attached && !client.socket.destroyed) client.socket.write(protocol.encode(event))
        },
        close: () => new Promise((done) => { for (const client of clients) client.socket.destroy(); server.close(() => done()) }),
      }),
    ),
  )
}

// Codex 승인 요청(src/lib/requests.mts codexApproval 모양)
const CODEX_REQUEST = {
  id: 'codex-approval:tok1',
  pane: 'p2',
  permission: true,
  codexApproval: { token: 'tok1', generation: 'g1', thread: 't1', choices: [{ key: 'accept', label: '허용' }, { key: 'decline', label: '거절' }] },
}

// 결정 콘솔 계획서 html(plan-html.mjs 가 쓰는 모양)
function writePlanHtml(dir, rel, plan) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file.replace(/\.md$/, '.html'), `<!-- 머리 -->\n<script id="plan-data">\nconst PLAN = ${JSON.stringify(plan)}\n</script>\n`)
  fs.writeFileSync(file, '# 계획서\n')
}
const SAMPLE_PLAN = {
  title: '모바일 앱',
  mdFile: 'plans/feature/a.md',
  leadPane: 'p1',
  decisions: [
    { id: 'D1', title: '로그인', desc: '방식', type: 'single', required: true, options: [{ label: 'A 웹', desc: '브라우저', recommended: true }, { label: 'B 앱' }] },
    { id: 'D2', title: '화면', type: 'multi', required: false, options: [{ label: '팩' }, { label: '결정' }, { label: '서버' }] },
    { id: 'D3', title: '저장', type: 'single', required: true, options: [{ label: '키체인' }, { label: '파일' }], decided: '키체인' },
  ],
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, what, limitMs = 3000) {
  const until = Date.now() + limitMs
  while (Date.now() < until) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error(`${what} 를 기다리다 시간 초과`)
}

async function setup(overrides = {}) {
  const dir = workDir()
  const socket = path.join(dir, 'd.sock')
  const daemon = await startFakeDaemon(socket)
  const { bridge: transport, phone } = createMemoryTransport()
  const logged = []
  const answered = []
  const posted = []
  const flags = { input: true }
  const approved = []
  const repoSets = []
  const opened = []
  const bridge = createMobileBridge({
    daemonPaths: () => ({ socket, log: path.join(dir, 'daemon.log'), endpoint: path.join(dir, 'endpoint.json') }),
    transport,
    inputAllowed: () => flags.input,
    requests: () => [{ id: 'r-20261111-090000-abcd', title: '질문' }],
    servers: () => [{ name: 'novum', ok: true }],
    events: () => [],
    answerRequest: async (id, answer) => {
      answered.push({ id, answer })
      return { ok: true, delivered: true }
    },
    approveRequest: async (id, generation, choice) => {
      approved.push({ id, generation, choice })
      return { ok: true }
    },
    athenaDir: () => null,
    leadPaneOf: (plan) => (plan === 'plans/feature/a.md' ? 'p1' : null),
    postDecision: async (body) => {
      posted.push(body)
      return { status: 200, body: { ok: true } }
    },
    packs: () => ({ current: 'acme', packs: [{ id: 'acme', name: 'acme', displayName: null }, { id: 'globex', name: 'globex', displayName: '글로벡스' }] }),
    repoSettings: async () => ({ ok: true, repos: [{ name: 'web', autoMerge: true, autoPr: true, review: true, mergeMode: 'auto', releaseOnMerge: false, prBase: 'main' }] }),
    setRepo: async (repo, changes) => {
      repoSets.push({ repo, changes })
      return { ok: true }
    },
    openPack: async (id) => {
      opened.push(id)
      return { ok: true, id, switched: true }
    },
    logEvent: (type, fields) => logged.push({ type, fields }),
    flushMs: 40,
    ...overrides,
  })
  let nextId = 1
  // 폰 → 맥 요청 하나 보내고 그 답을 기다린다
  const ask = async (op, args = {}) => {
    const id = nextId++
    phone.send({ id, op, args })
    await waitFor(() => phone.received.some((message) => message.id === id), `${op} 답`)
    return phone.received.find((message) => message.id === id)
  }
  const events = (name) => phone.received.filter((message) => message.event === name)
  const cleanup = async () => {
    await bridge.stop()
    await daemon.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { daemon, phone, bridge, ask, events, logged, answered, posted, approved, repoSets, opened, flags, cleanup }
}

test('snapshot — 확인 요청 · 살아 있는 pane 전부(쉬는 것도 · 필요한 칸 · PC 크기) · 서버 · 7일 머지를 한 번에, attach 하지 않는다', async () => {
  const env = await setup()
  try {
    const reply = await env.ask('snapshot')
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.result.requests, [{ id: 'r-20261111-090000-abcd', title: '질문' }])
    assert.deepEqual(reply.result.panes, [
      { id: 'p1', label: '아테나', name: null, title: null, agent: 'claude', status: 'working', running: true, cols: 120, rows: 40, repo: null, workspace: 'athena', pack: null },
      { id: 'p2', label: 'fe', name: null, title: null, agent: 'codex', status: 'idle', running: false, cols: 80, rows: 24, repo: null, workspace: null, pack: null },
    ])
    assert.deepEqual(reply.result.servers, [{ name: 'novum', ok: true }])
    assert.deepEqual(reply.result.merges, [])
    // 새 칸을 안 넘긴 부르는 쪽 — 지어내지 않고 빈 값
    assert.equal(reply.result.todayTop, null)
    assert.deepEqual(reply.result.mac, { name: null })
    assert.deepEqual(reply.result.devices, [])
    assert.deepEqual(reply.result.otherPacks, [{ id: 'globex', name: 'globex', displayName: '글로벡스', working: 0, question: 0 }])
    assert.equal(env.daemon.attached().length, 0, '묻기만 해서는 붙은 앱이 되지 않는다(fitTab · open-url 에 섞이지 않게)')
  } finally {
    await env.cleanup()
  }
})

test('pane.open — 스냅숏을 답으로, 그 뒤 출력은 연 pane 만 100ms 묶음으로 · 다 닫으면 attach 연결을 끊는다', async () => {
  const env = await setup()
  try {
    const opened = await env.ask('pane.open', { pane: 'p1' })
    assert.deepEqual(opened.result, { pane: 'p1', snapshot: 'P1-화면', cols: 120, rows: 40 })
    assert.equal(env.daemon.attached().length, 1)
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'a' })
    env.daemon.emit({ event: 'data', pane: 'p2', data: '안 연 pane' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'b' })
    await sleep(15)
    assert.equal(env.events('pane.data').length, 0, '묶음 시간 전에는 보내지 않는다')
    await waitFor(() => env.events('pane.data').length > 0, '묶인 출력')
    assert.deepEqual(env.events('pane.data'), [{ event: 'pane.data', panes: { p1: 'ab' } }])

    const closed = await env.ask('pane.close', { pane: 'p1' })
    assert.equal(closed.ok, true)
    await waitFor(() => env.daemon.attached().length === 0, 'attach 연결 끊김')
    assert.ok(!env.daemon.state.ops.some((entry) => entry.op === 'resize'), '데몬에 resize 를 보내지 않는다')
  } finally {
    await env.cleanup()
  }
})

test('pane.open — 없는 pane 은 not_found 이고 붙은 채로 남지 않는다', async () => {
  const env = await setup()
  try {
    const reply = await env.ask('pane.open', { pane: 'p9' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'not_found')
    await waitFor(() => env.daemon.attached().length === 0, 'attach 연결 끊김')
  } finally {
    await env.cleanup()
  }
})

test('pane.data — 100ms 안에 나온 여러 pane 출력을 기기당 메시지 하나 {panes:{…}} 로', async () => {
  const env = await setup()
  try {
    await env.ask('pane.open', { pane: 'p1' })
    await env.ask('pane.open', { pane: 'p2' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'a' })
    env.daemon.emit({ event: 'data', pane: 'p2', data: 'b' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'c' })
    await waitFor(() => env.events('pane.data').length > 0, '묶인 출력')
    await sleep(60)
    assert.deepEqual(env.events('pane.data'), [{ event: 'pane.data', panes: { p1: 'ac', p2: 'b' } }])
  } finally {
    await env.cleanup()
  }
})

test('resyncPane — 그 pane 하나만 다시 attach 스냅숏으로 · 안 연 pane 은 하지 않는다', async () => {
  const env = await setup()
  try {
    await env.ask('pane.open', { pane: 'p1' })
    await env.ask('pane.open', { pane: 'p2' })
    env.daemon.state.snapshots = { p1: 'P1-다시', p2: 'P2-다시' }
    await env.bridge.resyncPane('p1')
    await env.bridge.resyncPane('p9')
    assert.deepEqual(env.events('pane.resync'), [{ event: 'pane.resync', pane: 'p1', snapshot: 'P1-다시', cols: 120, rows: 40 }])
    // 다시 맞춘 뒤 출력은 그대로 흐른다
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'x' })
    await waitFor(() => env.events('pane.data').length > 0, '다시 맞춘 뒤 출력')
    assert.deepEqual(env.events('pane.data')[0].panes, { p1: 'x' })
  } finally {
    await env.cleanup()
  }
})

test('resync — 데몬이 따라오지 못한 연결을 끊으면 다시 attach 해서 열린 pane 마다 새 스냅숏', async () => {
  const env = await setup()
  try {
    await env.ask('pane.open', { pane: 'p1' })
    env.daemon.state.snapshots = { p1: 'P1-새화면', p2: 'P2' }
    env.daemon.emit({ event: 'resync' })
    await waitFor(() => env.events('pane.resync').length > 0, 'pane.resync')
    assert.deepEqual(env.events('pane.resync'), [{ event: 'pane.resync', pane: 'p1', snapshot: 'P1-새화면', cols: 120, rows: 40 }])
    assert.equal(env.daemon.state.ops.filter((entry) => entry.op === 'attach').length, 2)
  } finally {
    await env.cleanup()
  }
})

test('exit · state — 폰에 changed {parts:[panes]}', async () => {
  const env = await setup()
  try {
    await env.ask('pane.open', { pane: 'p1' })
    env.daemon.emit({ event: 'state', state: {} })
    await waitFor(() => env.events('changed').length > 0, 'changed')
    assert.deepEqual(env.events('changed')[0], { event: 'changed', parts: ['panes'] })
    env.bridge.changed(['requests'])
    await waitFor(() => env.events('changed').some((message) => message.parts[0] === 'requests'), '맥 쪽 changed')
  } finally {
    await env.cleanup()
  }
})

test('PC pane 크기가 바뀌면 changed {parts:[panes]} — 데몬 state 를 1초(시험은 짧게)마다 본다 · 멈추면 그만 본다', async () => {
  const env = await setup({ sizePollMs: 30 })
  try {
    await env.ask('snapshot')
    await waitFor(() => env.daemon.state.ops.filter((entry) => entry.op === 'state').length >= 2, '크기 보기 두 번')
    assert.equal(env.events('changed').length, 0, '처음 본 크기는 기준일 뿐')
    env.daemon.state.sizes.p1 = { cols: 100, rows: 30 }
    await waitFor(() => env.events('changed').length > 0, '크기 바뀜 changed')
    assert.deepEqual(env.events('changed')[0], { event: 'changed', parts: ['panes'] })
    await sleep(100)
    assert.equal(env.events('changed').length, 1, '같은 크기면 다시 알리지 않는다')
    await env.bridge.stop()
    const polled = env.daemon.state.ops.filter((entry) => entry.op === 'state').length
    await sleep(100)
    assert.equal(env.daemon.state.ops.filter((entry) => entry.op === 'state').length, polled)
  } finally {
    await env.cleanup()
  }
})

test('크기 보기는 기기마다 한 번만 — 첫 state 가 진행 중이거나 실패해도 snapshot 을 거듭 불러 늘지 않는다', async () => {
  // 다음 차례가 시험 안에 오지 않게 길게 — 늘어난 state 는 모두 snapshot 이 새로 켠 것
  const env = await setup({ sizePollMs: 60_000 })
  const stateCalls = () => env.daemon.state.ops.filter((entry) => entry.op === 'state').length
  try {
    env.daemon.state.failState = true
    await Promise.all([env.ask('snapshot'), env.ask('snapshot'), env.ask('snapshot')])
    await waitFor(() => stateCalls() >= 1, '첫 크기 보기')
    for (let round = 0; round < 3; round++) await env.ask('snapshot')
    await sleep(50)
    // snapshot 은 작업 공간(본체)을 보려고 state 를 한 번씩 부른다(실패해도 답은 간다) — 그 6번 + 크기 보기 처음 한 번
    assert.equal(stateCalls(), 6 + 1, '진행 중 · 실패 뒤에도 크기 보기는 처음 한 번만')
  } finally {
    await env.cleanup()
  }
})

test('pane.input — 키 그대로 데몬 input · 기록은 by mobile 과 바이트 수만(내용 없음)', async () => {
  const env = await setup()
  try {
    const reply = await env.ask('pane.input', { pane: 'p1', data: '비밀\r' })
    assert.equal(reply.ok, true)
    const input = env.daemon.state.ops.find((entry) => entry.op === 'input')
    assert.deepEqual(input.args, { pane: 'p1', data: '비밀\r' })
    assert.deepEqual(env.logged, [{ type: 'mobile.input', fields: { by: 'mobile', pane: 'p1', bytes: Buffer.byteLength('비밀\r') } }])
    assert.ok(!JSON.stringify(env.logged).includes('비밀'))
  } finally {
    await env.cleanup()
  }
})

test('폰 입력 허용이 꺼지면 pane.input · request.answer(권한 요청 포함) · decision.answer · repo.set · pack.open 을 input-off 로 거절하고 아무것도 하지 않는다', async () => {
  const env = await setup({ requests: () => [CODEX_REQUEST] })
  env.flags.input = false
  try {
    for (const [op, args] of [
      ['pane.input', { pane: 'p1', data: 'y' }],
      ['request.answer', { id: 'r-20261111-090000-abcd', choice: '예' }],
      ['request.answer', { id: CODEX_REQUEST.id, choice: 'accept', generation: 'g1' }],
      ['decision.answer', { plan: 'plans/feature/a.md', decisions: ['D1'], text: '진행' }],
      ['repo.set', { repo: 'web', review: false }],
      ['pack.open', { id: 'globex' }],
    ]) {
      const reply = await env.ask(op, args)
      assert.equal(reply.ok, false, op)
      assert.equal(reply.error.code, 'input-off', op)
    }
    assert.ok(!env.daemon.state.ops.some((entry) => entry.op === 'input'))
    assert.equal(env.answered.length, 0)
    assert.equal(env.posted.length, 0)
    assert.equal(env.approved.length, 0)
    assert.equal(env.repoSets.length, 0)
    assert.equal(env.opened.length, 0)
    // 보기는 그대로 된다(결정 목록 · 팩 목록도)
    assert.equal((await env.ask('decision.list')).ok, true)
    assert.equal((await env.ask('pack.list')).ok, true)
    assert.equal((await env.ask('snapshot')).ok, true)
    assert.equal((await env.ask('pane.open', { pane: 'p1' })).ok, true)
  } finally {
    await env.cleanup()
  }
})

test('request.answer — 고른 것 · 글 · rev 를 넘기고, 빈 답 · rev 없음 · 실패는 오류', async () => {
  const env = await setup()
  try {
    const reply = await env.ask('request.answer', { id: 'r-20261111-090000-abcd', choice: '예', text: '', rev: 3 })
    assert.equal(reply.ok, true)
    assert.deepEqual(env.answered, [{ id: 'r-20261111-090000-abcd', answer: { choice: '예', text: '', rev: 3 } }])
    assert.equal((await env.ask('request.answer', { id: 'r-20261111-090000-abcd', rev: 3 })).error.code, 'usage')
    // rev 가 없거나 정수가 아니면 거절 — 그사이 바뀐 요청에 답이 붙지 않게(앱 answerRevChanged 검사를 건너뛰지 않는다)
    for (const rev of [undefined, '3', 3.5, null]) {
      const reply = await env.ask('request.answer', { id: 'r-20261111-090000-abcd', choice: '예', rev })
      assert.equal(reply.error.code, 'usage', `rev ${rev}`)
    }
    assert.equal(env.answered.length, 1, 'rev 없는 답은 넘기지 않는다')
  } finally {
    await env.cleanup()
  }
  const failing = await setup({ answerRequest: async () => ({ ok: false, error: 'conflict' }) })
  try {
    assert.equal((await failing.ask('request.answer', { id: 'r-20261111-090000-abcd', choice: '예', rev: 1 })).error.code, 'conflict')
  } finally {
    await failing.cleanup()
  }
})

test('브리지가 정하지 않은 오류는 internal · 고정 문구로(원문은 폰에 안 간다)', async () => {
  const env = await setup({
    answerRequest: async () => {
      throw new Error('/Users/someone/비밀/경로 를 읽지 못함')
    },
  })
  const originalError = console.error
  const logged = []
  console.error = (...parts) => logged.push(parts.map(String).join(' '))
  try {
    const reply = await env.ask('request.answer', { id: 'r-20261111-090000-abcd', choice: '예', rev: 1 })
    assert.deepEqual(reply.error, { code: 'internal', message: '맥에서 처리하지 못했어요' })
    assert.ok(!JSON.stringify(env.phone.received).includes('비밀'))
    assert.ok(logged.some((line) => line.includes('비밀')), '원문은 맥 로그에')
  } finally {
    console.error = originalError
    await env.cleanup()
  }
})

test('decision.answer — 계획서 html 의 leadPane 으로 by mobile 을 붙여 보내고, 409 stale · 경로 밖은 거절', async () => {
  const env = await setup()
  try {
    const reply = await env.ask('decision.answer', { plan: 'plans/feature/a.md', decisions: ['D1', 'D2'], text: '이대로 진행' })
    assert.equal(reply.ok, true)
    assert.deepEqual(env.posted, [{ pane: 'p1', plan: 'plans/feature/a.md', decisions: ['D1', 'D2'], text: '이대로 진행', by: 'mobile' }])
    assert.equal((await env.ask('decision.answer', { plan: 'plans/../x.md', decisions: [], text: 't' })).error.code, 'usage')
    assert.equal((await env.ask('decision.answer', { plan: 'plans/feature/b.md', decisions: [], text: 't' })).error.code, 'no-pane')
  } finally {
    await env.cleanup()
  }
  const stale = await setup({ postDecision: async () => ({ status: 409, body: { stale: true } }) })
  try {
    assert.equal((await stale.ask('decision.answer', { plan: 'plans/feature/a.md', decisions: [], text: 't' })).error.code, 'stale')
  } finally {
    await stale.cleanup()
  }
})

test('모르는 요청 · 데몬이 없으면 오류 답(브리지는 데몬을 띄우지 않는다)', async () => {
  const { bridge: transport, phone } = createMemoryTransport()
  const bridge = createMobileBridge({
    daemonPaths: () => ({ socket: '/tmp/asd-mob-없는.sock', log: '/dev/null', endpoint: '/dev/null' }),
    transport,
    inputAllowed: () => true,
    requests: () => [],
    servers: () => [],
    events: () => [],
    answerRequest: async () => ({ ok: true }),
    leadPaneOf: () => null,
    postDecision: async () => ({ status: 200, body: {} }),
    logEvent: () => {},
  })
  phone.send({ id: 1, op: 'resize', args: { cols: 10, rows: 5 } })
  phone.send({ id: 2, op: 'snapshot' })
  await waitFor(() => phone.received.length === 2, '두 답')
  assert.equal(phone.received.find((message) => message.id === 1).error.code, 'usage')
  assert.equal(phone.received.find((message) => message.id === 2).error.code, 'daemon-unavailable')
  await bridge.stop()
  assert.equal(phone.closed, true)
})

test('weekMerges — 성공한 auto.merge 중 지난 7일만 새것부터', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  const rows = [
    { type: 'auto.merge', ok: true, at: '2026-11-10T00:00:00Z', repo: 'a', pr: 1 },
    { type: 'auto.merge', ok: false, at: '2026-11-10T01:00:00Z', repo: 'b' },
    { type: 'auto.merge', ok: true, at: '2026-11-01T00:00:00Z', repo: 'old' },
    { type: 'plan.check', ok: true, at: '2026-11-11T00:00:00Z' },
    { type: 'auto.merge', ok: true, at: '2026-11-11T08:00:00Z', repo: 'c', direct: true },
  ]
  assert.deepEqual(weekMerges(rows, now).map((row) => row.repo), ['c', 'a'])
  assert.equal(weekMerges(rows, now)[0].direct, true)
})

test('livePanes · paneSizes · mobileInputAllowed — 쉬는 pane 도 넣고 running 으로 가르기, 입력 허용은 true 일 때만', () => {
  const listed = livePanes([{ id: 'p1', agent_status: 'idle' }, { id: 'p2' }, { id: 'p3', agent_status: 'question', cols: 100, rows: 0 }, { label: 'id 없음' }])
  assert.deepEqual(listed.map((pane) => [pane.id, pane.status, pane.running, pane.cols, pane.rows]), [
    ['p1', 'idle', false, null, null],
    ['p2', null, false, null, null],
    ['p3', 'question', true, 100, null],
  ])
  assert.deepEqual(paneSizes({ panes: [{ id: 'p1', cols: 80, rows: 24 }, { cols: 1 }] }), { p1: { cols: 80, rows: 24 } })
  assert.deepEqual(paneSizes(null), {})
  assert.equal(mobileInputAllowed(null), false)
  assert.equal(mobileInputAllowed({ mobileInput: 'yes' }), false)
  assert.equal(mobileInputAllowed({ mobileInput: true }), true)
})

test('readLeadPane — 계획서 html 의 PLAN 블록 leadPane · 경로 밖 · 없는 파일은 null', () => {
  const dir = workDir()
  try {
    fs.mkdirSync(path.join(dir, 'plans', 'feature'), { recursive: true })
    const plan = { leadPane: 'p1m', decisions: [] }
    fs.writeFileSync(path.join(dir, 'plans', 'feature', 'a.html'), `<!-- 머리 -->\n<script id="plan-data">\nconst PLAN = ${JSON.stringify(plan)}\n</script>\n`)
    assert.equal(readLeadPane(dir, 'plans/feature/a.md'), 'p1m')
    assert.equal(readLeadPane(dir, 'plans/feature/none.md'), null)
    assert.equal(readLeadPane(dir, 'plans/../feature/a.md'), null)
    assert.equal(readLeadPane(dir, '/etc/a.md'), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('boardActionPoster — 현황판 /api/action 에 콘솔과 같은 Origin · 토큰 · JSON 으로', async () => {
  const seen = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: JSON.parse(body) })
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ stale: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const post = boardActionPoster({ port, token: 'test-token' })
    const reply = await post({ pane: 'p1', plan: 'plans/a.md', decisions: ['D1'], text: '진행', by: 'mobile' })
    assert.deepEqual(reply, { status: 409, body: { stale: true } })
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].url, '/api/action')
    assert.equal(seen[0].headers.origin, `http://localhost:${port}`)
    assert.equal(seen[0].headers['x-board-token'], 'test-token')
    assert.equal(seen[0].headers['content-type'], 'application/json')
    assert.equal(seen[0].body.by, 'mobile')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  // 현황판이 꺼져 있으면 status 0
  assert.deepEqual(await boardActionPoster({ port, token: 't' })({ pane: 'p', plan: 'plans/a.md', decisions: [], text: 't', by: 'mobile' }), { status: 0, body: null })
})

test('request.answer — Codex 승인은 choice key · generation 으로 ctx.approveRequest(선택지 번호)에, by mobile 기록 · 모르는 key 는 usage · 실패는 conflict', async () => {
  const env = await setup({ requests: () => [CODEX_REQUEST] })
  try {
    const reply = await env.ask('request.answer', { id: CODEX_REQUEST.id, choice: 'decline', generation: 'g1' })
    assert.equal(reply.ok, true)
    assert.deepEqual(env.approved, [{ id: CODEX_REQUEST.id, generation: 'g1', choice: 1 }])
    assert.equal(env.answered.length, 0, 'Codex 승인은 일반 답 길로 가지 않는다')
    assert.deepEqual(env.logged.at(-1), { type: 'mobile.approve', fields: { by: 'mobile', pane: 'p2', choice: 'decline' } })
    assert.equal((await env.ask('request.answer', { id: CODEX_REQUEST.id, choice: '없는키', generation: 'g1' })).error.code, 'usage')
    assert.equal((await env.ask('request.answer', { id: CODEX_REQUEST.id, choice: 'accept' })).error.code, 'usage', 'generation 없음')
    assert.equal(env.approved.length, 1)
  } finally {
    await env.cleanup()
  }
  const failing = await setup({ requests: () => [CODEX_REQUEST], approveRequest: async () => ({ ok: false, error: 'conflict' }) })
  try {
    assert.equal((await failing.ask('request.answer', { id: CODEX_REQUEST.id, choice: 'accept', generation: 'old' })).error.code, 'conflict')
  } finally {
    await failing.cleanup()
  }
})

test('readPlanData · openDecisionPlans — 결정 콘솔 PLAN 블록에서, 남은 결정이 있는 계획서만 · md 없는 html(그림 폴더) · 모양이 틀린 것은 뺀다', () => {
  const dir = workDir()
  try {
    writePlanHtml(dir, 'plans/feature/a.md', SAMPLE_PLAN)
    // 필수가 모두 확정 — 끝난 계획서
    writePlanHtml(dir, 'plans/task/done.md', { title: '끝', decisions: [{ id: 'D1', title: 'x', required: true, options: [{ label: 'A' }], decided: ['A'] }, { id: 'D2', title: 'y', options: [{ label: 'B' }] }] })
    // 결정이 없는 계획서
    writePlanHtml(dir, 'plans/task/empty.md', { title: '빈', decisions: [] })
    // 선택지 모양이 틀린 것
    writePlanHtml(dir, 'plans/task/bad.md', { title: '틀림', decisions: [{ id: 'D1', options: [{ desc: 'label 없음' }] }] })
    // md 가 없는 html
    fs.mkdirSync(path.join(dir, 'plans', 'artifacts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'plans', 'artifacts', 'x.html'), '<html></html>')
    const data = readPlanData(dir, 'plans/feature/a.md')
    assert.equal(data.title, '모바일 앱')
    assert.deepEqual(data.decisions[0], { id: 'D1', title: '로그인', desc: '방식', type: 'single', required: true, options: [{ label: 'A 웹', desc: '브라우저', recommended: true, custom: false }, { label: 'B 앱', desc: '', recommended: false, custom: false }], decided: null })
    assert.deepEqual(data.decisions[2].decided, ['키체인'])
    assert.equal(readPlanData(dir, 'plans/../feature/a.md'), null)
    assert.deepEqual(openDecisionPlans(dir).map((entry) => entry.plan), ['plans/feature/a.md'])
    assert.deepEqual(openDecisionPlans(path.join(dir, '없음')), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('decisionPrompt — 결정 콘솔 [이대로 진행] 과 같은 글 · 확정값은 그대로 · 틀린 고르기는 usage', () => {
  const data = { title: '모바일 앱', mdFile: 'plans/feature/a.md', decisions: SAMPLE_PLAN.decisions.map((entry) => ({ desc: '', ...entry, decided: entry.decided ? [entry.decided] : null })) }
  assert.equal(
    decisionPrompt(data, { D1: 'B 앱', D2: ['팩', '서버'] }),
    ['[작업계획서 결정사항 확정] 모바일 앱', '', '아래 결정사항으로 plans/feature/a.md 계획서를 확정하고 진행해주세요.', '', '1. 로그인: B 앱', '2. 화면: 팩, 서버', '3. 저장: 키체인', '', '추가 메모: (없음)'].join('\n'),
  )
  // 필수 아닌 것은 비워도 된다 — 콘솔처럼 (미결정)
  assert.match(decisionPrompt(data, { D1: 'A 웹' }), /2\. 화면: \(미결정\)/)
  const code = (fn) => {
    try {
      fn()
    } catch (error) {
      return error.code
    }
    return 'ok'
  }
  assert.equal(code(() => decisionPrompt(data, {})), 'usage', '필수 D1 이 남음')
  assert.equal(code(() => decisionPrompt(data, { D1: '없는 것' })), 'usage')
  assert.equal(code(() => decisionPrompt(data, { D1: ['A 웹', 'B 앱'] })), 'usage', '택1 에 둘')
  assert.equal(code(() => decisionPrompt(data, { D1: 'A 웹', D3: '파일' })), 'usage', '확정된 결정')
  assert.equal(code(() => decisionPrompt(data, { D1: 'A 웹', D9: 'x' })), 'usage', '없는 결정')
})

test('decision.list · decision.answer picks — 남은 결정 목록(hasPane) · 고른 값만 보내면 맥이 콘솔 글을 만들어 by mobile 로 · 결정이 바뀌었으면 stale', async () => {
  const dir = workDir()
  writePlanHtml(dir, 'plans/feature/a.md', SAMPLE_PLAN)
  const env = await setup({ athenaDir: () => dir })
  try {
    const list = await env.ask('decision.list')
    assert.equal(list.ok, true)
    assert.equal(list.result.plans.length, 1)
    assert.equal(list.result.plans[0].plan, 'plans/feature/a.md')
    assert.equal(list.result.plans[0].hasPane, true)
    assert.deepEqual(list.result.plans[0].decisions.map((entry) => [entry.id, entry.type, entry.required, entry.decided]), [['D1', 'single', true, null], ['D2', 'multi', false, null], ['D3', 'single', true, ['키체인']]])
    assert.equal(list.result.plans[0].decisions[0].options[0].recommended, true)
    const reply = await env.ask('decision.answer', { plan: 'plans/feature/a.md', decisions: ['D1', 'D2', 'D3'], picks: { D1: 'A 웹' } })
    assert.equal(reply.ok, true)
    assert.equal(env.posted.length, 1)
    assert.equal(env.posted[0].pane, 'p1')
    assert.equal(env.posted[0].by, 'mobile')
    assert.deepEqual(env.posted[0].decisions, ['D1', 'D2', 'D3'])
    assert.match(env.posted[0].text, /^\[작업계획서 결정사항 확정\] 모바일 앱\n/)
    assert.match(env.posted[0].text, /1\. 로그인: A 웹\n2\. 화면: \(미결정\)\n3\. 저장: 키체인/)
    // 폰이 본 결정 id 와 다르면 stale · 틀린 고르기는 usage — 둘 다 보내지 않는다
    assert.equal((await env.ask('decision.answer', { plan: 'plans/feature/a.md', decisions: ['D1', 'D2'], picks: { D1: 'A 웹' } })).error.code, 'stale')
    assert.equal((await env.ask('decision.answer', { plan: 'plans/feature/a.md', decisions: ['D1', 'D2', 'D3'], picks: { D1: '없는 것' } })).error.code, 'usage')
    assert.equal((await env.ask('decision.answer', { plan: 'plans/feature/a.md', decisions: ['D1', 'D2', 'D3'], picks: 'A' })).error.code, 'usage')
    assert.equal((await env.ask('decision.answer', { plan: 'plans/feature/none.md', decisions: [], picks: {} })).error.code, 'not_found')
    assert.equal(env.posted.length, 1)
  } finally {
    await env.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pack.list · repo.set · pack.open — 팩 · ⚙ 설정 줄을 보이고, 바꾸기는 같은 길(setRepo · openPack)로 by mobile 기록 · 모르는 값 · 레포 · 팩은 거절', async () => {
  const env = await setup()
  try {
    const list = await env.ask('pack.list')
    assert.equal(list.ok, true)
    assert.equal(list.result.current, 'acme')
    assert.deepEqual(list.result.packs.map((pack) => pack.id), ['acme', 'globex'])
    assert.equal(list.result.repos[0].name, 'web')
    assert.equal(list.result.repos[0].mergeMode, 'auto')

    const set = await env.ask('repo.set', { repo: 'web', review: false, merge: 'confirm' })
    assert.equal(set.ok, true)
    assert.equal(set.result.repo.name, 'web')
    assert.deepEqual(env.repoSets, [{ repo: 'web', changes: { auto: null, review: false, merge: 'confirm' } }])
    assert.deepEqual(env.logged.at(-1), { type: 'mobile.repo-set', fields: { by: 'mobile', repo: 'web', auto: null, review: false, merge: 'confirm' } })
    for (const args of [{ repo: 'web' }, { repo: 'web', auto: 'off' }, { repo: 'web', review: 'yes' }, { repo: 'web', merge: 'now' }, { repo: '../x', review: true }]) {
      assert.equal((await env.ask('repo.set', args)).error.code, 'usage', JSON.stringify(args))
    }
    assert.equal((await env.ask('repo.set', { repo: 'api', review: true })).error.code, 'not_found', '설정 줄에 없는 레포(main 직접 등)')
    assert.equal(env.repoSets.length, 1)

    const changedBefore = env.events('changed').length
    const open = await env.ask('pack.open', { id: 'globex' })
    assert.equal(open.ok, true)
    assert.deepEqual(open.result, { id: 'globex', switched: true })
    assert.deepEqual(env.opened, ['globex'])
    assert.deepEqual(env.logged.at(-1), { type: 'mobile.pack-open', fields: { by: 'mobile', pack: 'globex' } })
    await waitFor(() => env.events('changed').length > changedBefore, 'changed')
    assert.deepEqual(env.events('changed').at(-1).parts, ['requests', 'merges', 'servers', 'decisions', 'packs'])
    assert.equal((await env.ask('pack.open', { id: 'nope' })).error.code, 'not_found')
    assert.equal(env.opened.length, 1)
  } finally {
    await env.cleanup()
  }
  const failing = await setup({ setRepo: async () => ({ ok: false, error: 'busy', text: '맥 문구' }), openPack: async () => ({ ok: false, error: 'old-daemon', text: '맥 문구' }) })
  try {
    const set = await failing.ask('repo.set', { repo: 'web', auto: 'direct' })
    assert.equal(set.error.code, 'busy')
    assert.equal((await failing.ask('pack.open', { id: 'globex' })).error.code, 'old-daemon')
    assert.equal(failing.logged.filter((row) => row.type.startsWith('mobile.')).length, 0, '실패는 기록하지 않는다')
  } finally {
    await failing.cleanup()
  }
})

test('packView — 폰에 줄 칸만(id · 이름 · 표시 이름) · 모양이 틀린 줄은 뺀다', () => {
  assert.deepEqual(packView(null), { current: null, packs: [] })
  assert.deepEqual(
    packView({ current: { id: 'acme', body: '/숨길/본체' }, packs: [{ id: 'acme', name: 'acme', displayName: '', body: '/숨길' }, { id: '' }, null, { id: 'g', name: 3, displayName: '지' }] }),
    { current: 'acme', packs: [{ id: 'acme', name: 'acme', displayName: null }, { id: 'g', name: null, displayName: '지' }] },
  )
})

test('snapshot 새 칸 — pane 레포 · 작업 공간 · 팩, 다른 팩 일하는 · 질문 수, 머지 상세(뒤에서 읽고 changed merges) · 오늘 가장 큰 변경, 맥 이름 · 기기', async () => {
  const now = Date.parse('2026-11-11T15:00:00')
  const runs = []
  const details = createMergeDetails({
    athenaDir: () => '/b/acme',
    run: async (command, args, cwd) => {
      runs.push({ command, args, cwd })
      if (command === 'gh') return JSON.stringify({ title: 'feat: 로그인', headRefName: 'feat/login', additions: 120, deletions: 30, changedFiles: 7 })
      return 'fix: 길찾기\n\n 2 files changed, 10 insertions(+), 4 deletions(-)\n'
    },
  })
  const env = await setup({
    now: () => now,
    bodyPacks: () => ({ '/b/acme': 'acme', '/b/globex': 'globex' }),
    mergeDetails: details,
    mac: () => ({ name: '민창의 MacBook' }),
    devices: () => [{ peer: 'dev-1', label: 'iPhone', online: true, lastSeen: '2026-11-11T14:59:00Z' }],
    events: () => [
      { type: 'auto.merge', ok: true, at: '2026-11-11T10:00:00', repo: 'web', pr: 12, sha: 'abc1234' },
      { type: 'auto.merge', ok: true, at: '2026-11-11T11:00:00', repo: 'api', branch: 'fix/route', sha: 'aaa1111', direct: true, merged: 'bbb2222' },
      { type: 'auto.merge', ok: true, at: '2026-11-11T12:00:00', repo: 'api', branch: 'fix/x', sha: 'ccc3333', direct: true, handoff: true },
    ],
  })
  try {
    env.daemon.state.workspaces.push({ id: 'w2', label: 'globex-api', cwd: '/b/globex', activeTab: 't2', body: '/b/globex' })
    env.daemon.state.panes = [
      { id: 'p1', label: '아테나', agent: 'claude', agent_status: 'working', cwd: '/b/acme', workspace_id: 'w1' },
      { id: 'p2', label: 'fe', agent: 'claude', agent_status: 'waiting', cwd: '/h/.athena-studio/data/packs/acme/worktrees/web/feat-login', workspace_id: 'w1' },
      { id: 'p3', label: 'be', agent: 'codex', agent_status: 'working', cwd: '/b/globex/repos/globex-api', workspace_id: 'w2' },
      { id: 'p4', label: 'be2', agent: 'claude', agent_status: 'waiting', cwd: '/b/globex/repos/globex-api/src', workspace_id: 'w2' },
      { id: 'p5', label: '셸', agent: null, agent_status: 'unknown', cwd: '/tmp', workspace_id: 'w-없음' },
    ]
    const first = (await env.ask('snapshot')).result
    assert.deepEqual(first.panes.map((pane) => [pane.id, pane.repo, pane.workspace, pane.pack]), [
      ['p1', null, 'athena', 'acme'],
      ['p2', 'web', 'athena', 'acme'],
      ['p3', 'globex-api', 'globex-api', 'globex'],
      ['p4', 'globex-api', 'globex-api', 'globex'],
      ['p5', null, null, null],
    ])
    assert.ok(first.panes.every((pane) => !('cwd' in pane)), '경로는 넘기지 않는다')
    assert.deepEqual(first.otherPacks, [{ id: 'globex', name: 'globex', displayName: '글로벡스', working: 1, question: 1 }])
    assert.deepEqual(first.mac, { name: '민창의 MacBook' })
    assert.deepEqual(first.devices, [{ peer: 'dev-1', label: 'iPhone', online: true, lastSeen: '2026-11-11T14:59:00Z' }])
    // 처음에는 모른다 — null 로 보내고 뒤에서 읽는다(Actions 로 넘긴 것은 squash 커밋이 없어 읽지 않는다)
    assert.deepEqual(first.merges.map((merge) => [merge.repo, merge.title, merge.additions]), [['api', null, null], ['api', null, null], ['web', null, null]])
    assert.equal(first.merges[1].branch, 'fix/route', '상세 전에도 사건의 브랜치는 보인다')
    assert.equal(first.todayTop, null)
    await waitFor(() => env.events('changed').some((event) => event.parts.includes('merges')), '머지 상세 changed')
    assert.deepEqual(runs.map((run) => [run.command, run.args.join(' '), run.cwd]).sort(), [
      ['gh', 'pr view 12 --json title,headRefName,additions,deletions,changedFiles', path.join('/b/acme', 'repos', 'web')],
      ['git', 'show --shortstat --format=%s bbb2222 --', path.join('/b/acme', 'repos', 'api')],
    ])
    const second = (await env.ask('snapshot')).result
    const web = second.merges.find((merge) => merge.repo === 'web')
    assert.deepEqual([web.title, web.branch, web.additions, web.deletions, web.files], ['feat: 로그인', 'feat/login', 120, 30, 7])
    const direct = second.merges.find((merge) => merge.merged === 'bbb2222')
    assert.deepEqual([direct.title, direct.branch, direct.additions, direct.deletions, direct.files], ['fix: 길찾기', 'fix/route', 10, 4, 2])
    assert.equal(second.todayTop.repo, 'web')
    assert.equal(runs.length, 2, '읽은 상세는 다시 읽지 않는다')
  } finally {
    await env.cleanup()
  }
})

test('server.detail — 서버 하나의 읽기 · 이력 · sar 에 lastDeploy null(원천 없음) · 없는 서버 not_found', async () => {
  const env = await setup({
    serverDetail: async (name) => (name === 'novum' ? { server: { name: 'novum', status: { ok: true, cpuModel: 'EPYC' } }, history: [{ t: 1 }], sar: [] } : null),
  })
  try {
    const found = await env.ask('server.detail', { name: 'novum' })
    assert.deepEqual(found.result, { server: { name: 'novum', status: { ok: true, cpuModel: 'EPYC' } }, history: [{ t: 1 }], sar: [], lastDeploy: null })
    assert.equal((await env.ask('server.detail', { name: '없음' })).error.code, 'not_found')
    assert.equal((await env.ask('server.detail', {})).error.code, 'usage')
  } finally {
    await env.cleanup()
  }
})

test('repoOfCwd · otherPackCounts — 워크트리 · repos 아래만 레포, 지금 팩은 빼고 pane 없는 팩도 0', () => {
  assert.equal(repoOfCwd('/h/data/packs/acme/worktrees/web/feat-a'), 'web')
  assert.equal(repoOfCwd('/h/data/packs/acme/worktrees/web/feat-a/src'), 'web')
  assert.equal(repoOfCwd('/h/data/packs/acme/worktrees/web'), null, '브랜치 자리까지 와야 워크트리')
  assert.equal(repoOfCwd('/b/acme/repos/api'), 'api')
  assert.equal(repoOfCwd('/b/acme'), null)
  assert.equal(repoOfCwd(null), null)
  const panes = livePanes([{ id: 'p1', agent_status: 'working', workspace_id: 'w1' }, { id: 'p2', agent_status: 'waiting', workspace_id: 'w1' }], paneWhere({ workspaces: [{ id: 'w1', label: 'x', body: '/b/g' }] }, { '/b/g': 'globex' }))
  assert.deepEqual(otherPackCounts(panes, { current: 'acme', packs: [{ id: 'acme', name: 'acme', displayName: null }, { id: 'globex', name: 'globex', displayName: null }, { id: 'initech', name: null, displayName: null }] }), [
    { id: 'globex', name: 'globex', displayName: null, working: 1, question: 1 },
    { id: 'initech', name: null, displayName: null, working: 0, question: 0 },
  ])
})

test('머지 상세 — 키(PR · squash 커밋만) · gh · shortstat 해석 · 실패는 10분 뒤 다시 · 오늘 가장 큰 변경은 상세를 아는 오늘 것만', async () => {
  assert.equal(mergeKey({ repo: 'web', pr: 3 }), 'web#3')
  assert.equal(mergeKey({ repo: 'web', direct: true, merged: 'abc1234' }), 'web@abc1234')
  assert.equal(mergeKey({ repo: 'web', direct: true, sha: 'abc1234' }), null, 'Actions 로 넘긴 것(merged 없음)')
  assert.equal(mergeKey({ repo: '../x', pr: 3 }), null)
  assert.equal(mergeKey({ repo: 'web', direct: true, merged: '--output=x' }), null)
  assert.deepEqual(parsePrView('{"title":"t","headRefName":"b","additions":1,"deletions":2,"changedFiles":3}'), { title: 't', branch: 'b', additions: 1, deletions: 2, files: 3 })
  assert.equal(parsePrView('없음'), null)
  assert.deepEqual(parseShortstat('제목\n\n 1 file changed, 5 insertions(+)\n', 'b'), { title: '제목', branch: 'b', additions: 5, deletions: 0, files: 1 })
  assert.equal(parseShortstat('', null), null)

  let clock = 0
  let calls = 0
  const details = createMergeDetails({ athenaDir: () => '/b', now: () => clock, run: async () => (calls++, null) })
  const merges = [{ at: 'x', repo: 'web', pr: 1, branch: null }]
  let ready = 0
  assert.deepEqual(details.peek(merges, () => ready++), [null])
  details.peek(merges, () => ready++)
  await sleep(10)
  assert.equal(calls, 1, '읽는 중 · 실패 직후에는 다시 부르지 않는다')
  details.peek(merges, () => ready++)
  await sleep(10)
  assert.equal(calls, 1)
  clock = 10 * 60 * 1000
  details.peek(merges, () => ready++)
  await sleep(10)
  assert.equal(calls, 2, '10분 뒤 다시')
  assert.equal(ready, 0, '새로 읽힌 것이 없으면 알리지 않는다')

  const now = Date.parse('2026-11-11T15:00:00')
  const rows = [
    { at: '2026-11-11T09:00:00', repo: 'a', branch: null },
    { at: '2026-11-11T10:00:00', repo: 'b', branch: null },
    { at: '2026-11-10T10:00:00', repo: 'c', branch: null },
  ]
  const feed = mergeFeed(rows, [{ title: 'A', branch: 'x', additions: 5, deletions: 5, files: 1 }, null, { title: 'C', branch: null, additions: 900, deletions: 0, files: 9 }], now)
  assert.equal(feed.todayTop.repo, 'a', '어제 것(c) · 상세 모르는 것(b)은 견주지 않는다')
  assert.equal(feed.merges[1].additions, null)
})

test('bodyPacks · serverSummary — 본체 경로 → 팩 id, snapshot 서버는 상세 칸을 뺀다', () => {
  assert.deepEqual(bodyPacks({ packs: [{ id: 'acme', body: '/없는/본체/acme' }, { id: 'x' }, { body: '/b' }] }), { '/없는/본체/acme': 'acme' })
  assert.deepEqual(bodyPacks(null), {})
  const reading = { name: 'novum', status: { ok: true, load1: 1, ports: [], cpuModel: 'EPYC', serviceInfo: [], timers: [], cron: [], ufw: 'active', monarx: 'active', sites: [] }, web: null, at: 1 }
  assert.deepEqual(serverSummary(reading), { name: 'novum', status: { ok: true, load1: 1 }, web: null, at: 1 })
  assert.deepEqual(serverSummary({ name: 'down', status: { ok: false, reason: 'timeout' } }), { name: 'down', status: { ok: false, reason: 'timeout' } })
})
