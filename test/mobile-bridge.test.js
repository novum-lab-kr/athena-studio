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

const { createMobileBridge, createMemoryTransport, macSpaces, weekMerges, livePanes, paneSizes, readLeadPane, boardActionPoster, mobileInputAllowed, readPlanData, openDecisionPlans, decisionPrompt, repoOfCwd, paneWhere, otherPackCounts, mergeKey, parsePrView, parseShortstat, createMergeDetails, mergeFeed, createPaneControl, isTerminalReply, isPointerHover, cellSize, imageType, decodeImage, imageFileName, saveImage, IMAGE_MAX_BYTES, IMAGE_KEEP_MS } = bridgeModule
const { packView, bodyPacks, serverSummary, lookSource } = require('../src/main/mobile-dev.mts')
const { createIconTokens, iconToken, ATHENA_LOGO } = require('../src/main/mobile-look.mts')

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
    beforeResize: null, // 문자열이면 resize 답 앞에 그 pane 출력을 같은 소켓으로 먼저 보낸다(답보다 앞선 출력)
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
      else if (message.op === 'resize') {
        // 데몬 Pane.resize 처럼 크기를 바꾼다 — 그 전에 나온 출력은 답보다 먼저(붙은 연결이면)
        if (state.beforeResize !== null && client.attached) socket.write(protocol.encode({ event: 'data', pane: message.args.pane, data: state.beforeResize }))
        state.sizes[message.args.pane] = { cols: message.args.cols, rows: message.args.rows }
      }
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
  const daemonPaths = () => ({ socket, log: path.join(dir, 'daemon.log'), endpoint: path.join(dir, 'endpoint.json') })
  const bridge = createMobileBridge({
    daemonPaths,
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
  return { daemon, daemonPaths, phone, bridge, ask, events, logged, answered, posted, approved, repoSets, opened, flags, cleanup }
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
    assert.deepEqual(reply.result.work, { boardUp: false, boardError: null, doing: [], done: [] }, '작업 목록을 안 넘기면 빈 값')
    assert.deepEqual(reply.result.otherPacks, [{ id: 'globex', name: 'globex', displayName: '글로벡스', icon: null, working: 0, question: 0 }])
    assert.deepEqual(reply.result.spaces, [], '이름 · 이미지 원천(look)을 안 넘기면 빈 목록')
    assert.equal(env.daemon.attached().length, 0, '묻기만 해서는 붙은 앱이 되지 않는다(fitTab · open-url 에 섞이지 않게)')
  } finally {
    await env.cleanup()
  }
})

test('snapshot.work — 맥 [작업] 과 같은 작업 목록(doing · done)을 넘긴 그대로 싣는다 · 부를 때마다 새로 읽는다', async () => {
  const item = { id: 'plans/task/a.md', title: '폰 작업 목록', line: '시험 추가 · 1/4', state: 'work', grade: 'light', maintenance: false, agents: ['p1'], mtime: 1000, doneAt: 1000 }
  let work = { boardUp: true, boardError: null, doing: [item], done: [] }
  let reads = 0
  const env = await setup({
    work: async () => {
      reads += 1
      if (!work) throw new Error('boom')
      return work
    },
  })
  try {
    const first = await env.ask('snapshot')
    assert.deepEqual(first.result.work, { boardUp: true, boardError: null, doing: [item], done: [] })
    // 현황판을 못 띄웠으면 — 빈 목록 + boardUp:false + 이유 한 줄
    work = { boardUp: false, boardError: '현황판을 띄우지 못했어요', doing: [], done: [] }
    const second = await env.ask('snapshot')
    assert.deepEqual(second.result.work, { boardUp: false, boardError: '현황판을 띄우지 못했어요', doing: [], done: [] })
    assert.equal(reads, 2)
    // 읽다 던져도 snapshot 은 간다
    work = null
    const third = await env.ask('snapshot')
    assert.equal(third.ok, true)
    assert.deepEqual(third.result.work, { boardUp: false, boardError: null, doing: [], done: [] })
    assert.deepEqual(third.result.requests, [{ id: 'r-20261111-090000-abcd', title: '질문' }])
  } finally {
    await env.cleanup()
  }
})

test('pane.open — 스냅숏을 답으로, 그 뒤 출력은 연 pane 만(조용하다 첫 조각은 바로 · 뒤따르는 것은 묶음) · 다 닫으면 attach 연결을 끊는다', async () => {
  const env = await setup()
  try {
    const opened = await env.ask('pane.open', { pane: 'p1' })
    assert.deepEqual(opened.result, { pane: 'p1', snapshot: 'P1-화면', cols: 120, rows: 40, owner: 'mac', mine: false })
    assert.equal(env.daemon.attached().length, 1)
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'a' })
    env.daemon.emit({ event: 'data', pane: 'p2', data: '안 연 pane' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'b' })
    await waitFor(() => env.events('pane.data').length > 0, '첫 조각')
    assert.deepEqual(env.events('pane.data'), [{ event: 'pane.data', panes: { p1: 'a' } }], '첫 조각은 바로 · 뒤따르는 것은 아직')
    await waitFor(() => env.events('pane.data').length > 1, '묶인 출력')
    assert.deepEqual(env.events('pane.data')[1], { event: 'pane.data', panes: { p1: 'b' } })

    const closed = await env.ask('pane.close', { pane: 'p1' })
    assert.equal(closed.ok, true)
    await waitFor(() => env.daemon.attached().length === 0, 'attach 연결 끊김')
    assert.ok(!env.daemon.state.ops.some((entry) => entry.op === 'resize'), '크기를 안 보낸 폰(옛 앱)이면 데몬에 resize 를 보내지 않는다')
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

test('pane.data — 조용하다 첫 조각은 바로 · 뒤따르는 100ms 안 여러 pane 출력은 기기당 메시지 하나 {panes:{…}} · 다시 조용해지면 다음 첫 조각도 바로', async () => {
  const env = await setup()
  try {
    await env.ask('pane.open', { pane: 'p1' })
    await env.ask('pane.open', { pane: 'p2' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'a' })
    env.daemon.emit({ event: 'data', pane: 'p2', data: 'b' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'c' })
    await waitFor(() => env.events('pane.data').length > 1, '묶인 출력')
    await sleep(60)
    assert.deepEqual(env.events('pane.data'), [{ event: 'pane.data', panes: { p1: 'a' } }, { event: 'pane.data', panes: { p2: 'b', p1: 'c' } }])
    // 창이 끝나고(쌓인 것 없음 → 닫힘) 조용하면 다음 첫 조각도 바로
    await sleep(60)
    const before = env.events('pane.data').length
    const sentAt = Date.now()
    env.daemon.emit({ event: 'data', pane: 'p2', data: 'd' })
    await waitFor(() => env.events('pane.data').length > before, '다음 첫 조각')
    assert.ok(Date.now() - sentAt < 30, '묶음 시간(40ms)을 기다리지 않는다')
    assert.deepEqual(env.events('pane.data').at(-1), { event: 'pane.data', panes: { p2: 'd' } })
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

test('pane.input 직후 — 열린 묶음 창 안의 그 pane 출력은 짧은 묶음(창 끝을 당긴다) · 입력 없는 pane 은 원래 묶음 · 유지 시간이 지나면 다시 원래 묶음', async () => {
  const env = await setup({ flushMs: 300, fastFlushMs: 20, fastHoldMs: 400 })
  const count = () => env.events('pane.data').length
  const arrived = async (want) => {
    const started = Date.now()
    await waitFor(() => count() >= want, '묶인 출력')
    return Date.now() - started
  }
  try {
    await env.ask('pane.open', { pane: 'p1' })
    await env.ask('pane.open', { pane: 'p2' })

    // 다른 pane(p2)에 입력해도 p1 은 원래 묶음 — 조용하다 첫 조각은 바로, 뒤따르는 것은 300ms
    await env.ask('pane.input', { pane: 'p2', data: 'x' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'a' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'b' })
    await arrived(1)
    await sleep(120)
    assert.equal(count(), 1, '입력 없는 pane 은 원래 묶음 시간 전에 보내지 않는다')
    await arrived(2)
    await sleep(350) // 창이 닫히고 p2 유지 시간도 지난다

    // p1 에 입력 → 첫 조각은 바로 · 뒤따르는 것은 짧은 묶음
    await env.ask('pane.input', { pane: 'p1', data: '\x1b[<64;1;1M' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'c' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'd' })
    assert.ok((await arrived(4)) < 200, '입력 직후 뒤따르는 출력은 짧은 묶음으로 온다')
    await sleep(60) // 짧은 창이 닫힌다

    // 원래 묶음으로 걸린 p2 출력 뒤에 p1 출력이 오면 창 끝을 당겨 같이 보낸다
    env.daemon.emit({ event: 'data', pane: 'p2', data: 'e' })
    await arrived(5)
    env.daemon.emit({ event: 'data', pane: 'p2', data: 'f' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'g' })
    assert.ok((await arrived(6)) < 200, '이미 걸린 긴 묶음을 당긴다')
    assert.deepEqual(env.events('pane.data'), [
      { event: 'pane.data', panes: { p1: 'a' } },
      { event: 'pane.data', panes: { p1: 'b' } },
      { event: 'pane.data', panes: { p1: 'c' } },
      { event: 'pane.data', panes: { p1: 'd' } },
      { event: 'pane.data', panes: { p2: 'e' } },
      { event: 'pane.data', panes: { p2: 'f', p1: 'g' } },
    ])

    // 유지 시간이 지나면 원래 묶음
    await sleep(450)
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'h' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'i' })
    await arrived(7)
    await sleep(120)
    assert.equal(count(), 7, '유지 시간 뒤에는 원래 묶음 시간 전에 보내지 않는다')
    await arrived(8)
  } finally {
    await env.cleanup()
  }
})

test('pane.input 직후 — 입력 전에 원래 묶음으로 기다리던 그 pane 출력도 앞당긴다(입력 뒤 새 출력 없음)', async () => {
  const env = await setup({ flushMs: 400, fastFlushMs: 20, fastHoldMs: 1000 })
  try {
    await env.ask('pane.open', { pane: 'p1' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'a' })
    await waitFor(() => env.events('pane.data').length > 0, '첫 조각')
    const started = Date.now()
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'b' })
    await sleep(10)
    await env.ask('pane.input', { pane: 'p1', data: 'x' })
    await waitFor(() => env.events('pane.data').length > 1, '묶인 출력')
    assert.ok(Date.now() - started < 250, '원래 묶음(400ms)을 다 기다리지 않는다')
    assert.deepEqual(env.events('pane.data'), [
      { event: 'pane.data', panes: { p1: 'a' } },
      { event: 'pane.data', panes: { p1: 'b' } },
    ])
  } finally {
    await env.cleanup()
  }
})

test('pane.input 직후 — 길의 묶음이 짧은 값보다 짧으면(직접 길) 그 묶음 그대로, 늘리지 않는다', async () => {
  const env = await setup({ flushMs: 40, fastFlushMs: 300 })
  try {
    await env.ask('pane.open', { pane: 'p1' })
    await env.ask('pane.input', { pane: 'p1', data: 'x' })
    const started = Date.now()
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'a' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'b' })
    await waitFor(() => env.events('pane.data').length > 1, '묶인 출력')
    assert.ok(Date.now() - started < 200, '입력 뒤에도 길의 묶음(40ms)으로 온다')
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
    assert.deepEqual(first.otherPacks, [{ id: 'globex', name: 'globex', displayName: '글로벡스', icon: null, working: 1, question: 1 }])
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
    { id: 'globex', name: 'globex', displayName: null, icon: null, working: 1, question: 1 },
    { id: 'initech', name: null, displayName: null, icon: null, working: 0, question: 0 },
  ])
  assert.equal(otherPackCounts(panes, { current: 'acme', packs: [{ id: 'globex', name: 'globex', displayName: null }] }, { globex: 'tok' })[0].icon, 'tok', '팩 이미지 토큰')
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

// ── 제어 주인(D9) — 제어하는 쪽 크기로 pane 크기를 맞춘다 ──
const resizes = (env) => env.daemon.state.ops.filter((entry) => entry.op === 'resize').map((entry) => entry.args)
// 시험마다 주인 표 하나 — 맥 → 폰으로 넘어간 pane 을 적는다(맥 Studio 알림 자리)
function sharedControl() {
  const took = []
  return { control: createPaneControl({ onPhoneTook: (pane) => took.push(pane) }), took }
}

test('cellSize · isTerminalReply — 폰 크기 검사 · 터미널 자동 답은 사람 입력이 아니다', () => {
  assert.deepEqual(cellSize(50, 30), { cols: 50, rows: 30 })
  for (const [cols, rows] of [[1, 30], [50, 1], [50.5, 30], ['50', 30], [5000, 30], [50, 900], [null, null]]) assert.equal(cellSize(cols, rows), null, `${cols}x${rows}`)
  for (const reply of ['\x1b[12;5R', '\x1b[?12;5R', '\x1b[0n', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[?2026;2$y', '\x1b[?0u', '\x1b[8;40;120t', '\x1b[I', '\x1b[O', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1bP>|xterm.js(6.0)\x1b\\', '\x1b[I\x1b[12;5R']) assert.equal(isTerminalReply(reply), true, JSON.stringify(reply))
  for (const hover of ['\x1b[<35;26;11M', '\x1b[<39;1;1M', '\x1b[<63;200;50M', '\x1b[<35;26;11M\x1b[<35;27;11M']) assert.equal(isPointerHover(hover), true, JSON.stringify(hover))
  // 누르기 · 떼기 · 끌기(32) · 휠(64 · 65) · 친 글자는 지나가기가 아니다
  for (const used of ['\x1b[<0;26;11M', '\x1b[<0;26;11m', '\x1b[<32;26;11M', '\x1b[<64;26;11M', '\x1b[<65;26;11M', '\x1b[<35;26;11m', 'a', '\x1b[<35;26;11Ma']) assert.equal(isPointerHover(used), false, JSON.stringify(used))
  for (const typed of ['a', 'ls\r', '\x1b[A', '\x1bOA', '\x1b[15~', '\x1b[<0;10;5M', '\x03', '\x1b[200~붙여\x1b[201~', '\x1b[Ia']) assert.equal(isTerminalReply(typed), false, JSON.stringify(typed))
})

test('pane.open + 크기 — 답(지금 크기 스냅숏) 뒤에 폰 크기로 resize · pane.owner(phone) · 맥 알림 한 번 · 앞선 출력이 pane.owner 보다 먼저', async () => {
  const { control, took } = sharedControl()
  const env = await setup({ control })
  try {
    env.daemon.state.beforeResize = '크기 전 출력'
    const opened = await env.ask('pane.open', { pane: 'p1', cols: 50, rows: 30 })
    assert.deepEqual(opened.result, { pane: 'p1', snapshot: 'P1-화면', cols: 120, rows: 40, owner: 'mac', mine: false })
    await waitFor(() => env.events('pane.owner').length === 1, 'pane.owner')
    assert.deepEqual(env.events('pane.owner'), [{ event: 'pane.owner', pane: 'p1', owner: 'phone', mine: true, cols: 50, rows: 30 }])
    assert.deepEqual(resizes(env), [{ pane: 'p1', cols: 50, rows: 30 }])
    assert.deepEqual(took, ['p1'])
    // 받은 순서: 답 → 크기 전 출력 → pane.owner(폰은 앞 출력을 다 쓴 뒤 크기를 바꾼다)
    const order = env.phone.received.map((message) => (message.id ? 'reply' : message.event))
    assert.deepEqual(order.filter((name) => name !== 'changed'), ['reply', 'pane.data', 'pane.owner'])
    assert.deepEqual(env.events('pane.data'), [{ event: 'pane.data', panes: { p1: '크기 전 출력' } }])
    // 같은 크기로 또 열어도 다시 resize · 알림하지 않는다
    await env.ask('pane.input', { pane: 'p1', data: 'x' })
    assert.equal(resizes(env).length, 1)
    assert.deepEqual(took, ['p1'])
  } finally {
    await env.cleanup()
  }
})

test('맥에서 입력 — 터미널 자동 답은 그대로 · 사람 입력이면 맥 크기(가져갈 때 크기 · 그 뒤 맥 화면 요청)로 되돌리고 pane.owner(mac)', async () => {
  const { control } = sharedControl()
  const env = await setup({ control })
  try {
    await env.ask('pane.open', { pane: 'p1', cols: 50, rows: 30 })
    await waitFor(() => env.events('pane.owner').length === 1, '폰이 가져감')
    assert.equal(control.macResize('p2', { cols: 90, rows: 20 }), false, '맥이 주인인 pane 은 그대로 데몬에')
    assert.equal(control.macResize('p1', { cols: 130, rows: 44 }), true, '폰이 가진 pane 은 기억만')
    assert.deepEqual(resizes(env), [{ pane: 'p1', cols: 50, rows: 30 }])
    control.macInput('p1', '\x1b[I')
    control.macInput('p1', '\x1b[3;1R')
    // 맥 포인터가 pane 위를 지나가기만 함 — Claude Code 는 움직임 추적(1003 · 1006)을 켜서 xterm 이 누르지 않은 움직임도 입력으로 보낸다(2026-11-12 실측 \x1b[<35;26;11M)
    control.macInput('p1', '\x1b[<35;26;11M')
    control.macInput('p1', '\x1b[<35;27;11M\x1b[<39;28;12M')
    await sleep(30)
    assert.equal(control.ownerOf('p1').owner, 'phone', '자동 답 · 포인터 지나가기는 주인을 바꾸지 않는다')
    control.macInput('p1', 'l')
    await waitFor(() => env.events('pane.owner').length === 2, '맥으로')
    assert.deepEqual(env.events('pane.owner')[1], { event: 'pane.owner', pane: 'p1', owner: 'mac', mine: false, cols: 130, rows: 44 })
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 130, rows: 44 })
    assert.equal(control.macResize('p1', { cols: 131, rows: 44 }), false)
    // 폰이 다시 입력하면 다시 폰 크기(열 때 보낸 크기를 기억)
    await env.ask('pane.input', { pane: 'p1', data: 'y' })
    await waitFor(() => env.events('pane.owner').length === 3, '다시 폰')
    assert.deepEqual(env.events('pane.owner')[2], { event: 'pane.owner', pane: 'p1', owner: 'phone', mine: true, cols: 50, rows: 30 })
    // 폰 쪽 자동 답은 가져가지 않는다
    control.macInput('p1', 'z')
    await waitFor(() => env.events('pane.owner').length === 4, '맥으로 한 번 더')
    await env.ask('pane.input', { pane: 'p1', data: '\x1b[1;1R' })
    assert.equal(control.ownerOf('p1').owner, 'mac')
  } finally {
    await env.cleanup()
  }
})

test('pane.close · 연결 끊김(stop) — 가진 pane 을 맥 크기로 되돌린다(이 폰에 알리지 않음) · pane.input 크기로도 가져간다', async () => {
  const { control, took } = sharedControl()
  const env = await setup({ control })
  try {
    await env.ask('pane.open', { pane: 'p1', cols: 50, rows: 30 })
    await waitFor(() => env.events('pane.owner').length === 1, '가져감')
    await env.ask('pane.close', { pane: 'p1' })
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 120, rows: 40 })
    assert.equal(control.ownerOf('p1').owner, 'mac')
    assert.equal(env.events('pane.owner').length, 1, '닫은 폰에는 알리지 않는다')
    // 열지 않고 입력만 크기와 함께 — 지금 크기(state)를 돌려줄 크기로
    await env.ask('pane.input', { pane: 'p2', data: 'a', cols: 40, rows: 20 })
    assert.deepEqual(resizes(env).at(-1), { pane: 'p2', cols: 40, rows: 20 })
    assert.deepEqual(took, ['p1', 'p2'])
    await env.bridge.stop()
    assert.deepEqual(resizes(env).at(-1), { pane: 'p2', cols: 80, rows: 24 })
    assert.equal(control.ownerOf('p2').owner, 'mac')
  } finally {
    await env.cleanup()
  }
})

test('입력 허용이 꺼져 있으면 열어도 크기를 바꾸지 않는다 · 잘못된 크기는 usage', async () => {
  const env = await setup()
  try {
    env.flags.input = false
    const opened = await env.ask('pane.open', { pane: 'p1', cols: 50, rows: 30 })
    assert.equal(opened.ok, true)
    await sleep(30)
    assert.deepEqual(resizes(env), [])
    assert.equal(env.events('pane.owner').length, 0)
    assert.equal((await env.ask('pane.size', { pane: 'p1', cols: 60, rows: 30 })).result.owner, 'mac')
    assert.deepEqual(resizes(env), [])
    env.flags.input = true
    assert.equal((await env.ask('pane.open', { pane: 'p2', cols: 1, rows: 30 })).error.code, 'usage')
    assert.equal((await env.ask('pane.input', { pane: 'p1', data: 'a', cols: 50 })).error.code, 'usage')
    assert.equal((await env.ask('pane.size', { pane: 'p1' })).error.code, 'usage')
  } finally {
    await env.cleanup()
  }
})

test('pane.size — 가진 폰이면 바로 그 크기로 · 아니면 기억만(입력할 때 그 크기로 가져간다)', async () => {
  const env = await setup()
  try {
    await env.ask('pane.open', { pane: 'p1' })
    const kept = await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 22 })
    assert.deepEqual(kept.result, { pane: 'p1', owner: 'mac', mine: false })
    assert.deepEqual(resizes(env), [])
    await env.ask('pane.input', { pane: 'p1', data: 'a' })
    assert.deepEqual(resizes(env), [{ pane: 'p1', cols: 44, rows: 22 }])
    const resized = await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 18 })
    assert.deepEqual(resized.result, { pane: 'p1', owner: 'phone', mine: true })
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 44, rows: 18 })
    await waitFor(() => env.events('pane.owner').length === 2, '두 번 알림')
    assert.deepEqual(env.events('pane.owner')[1], { event: 'pane.owner', pane: 'p1', owner: 'phone', mine: true, cols: 44, rows: 18 })
  } finally {
    await env.cleanup()
  }
})

test('포커스로 제어 바꾸기(D9 보완) — pane.size take 는 맥이 가졌어도 바로 폰 크기 · 맥 포커스(macFocus)는 폰이 가진 pane 을 맥 크기로 · 입력 허용 꺼짐 · 틀린 take 는 가져가지 않는다', async () => {
  const { control, took } = sharedControl()
  const env = await setup({ control })
  try {
    await env.ask('pane.open', { pane: 'p1' })
    control.macFocus('p1')
    await sleep(30)
    assert.deepEqual(resizes(env), [], '맥이 가진 pane 의 포커스는 아무것도 안 한다')
    assert.equal((await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 22, take: 'yes' })).error.code, 'usage')
    env.flags.input = false
    assert.equal((await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 22, take: true })).result.owner, 'mac')
    assert.deepEqual(resizes(env), [])
    env.flags.input = true
    const taken = await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 22, take: true })
    assert.deepEqual(taken.result, { pane: 'p1', owner: 'phone', mine: true })
    assert.deepEqual(resizes(env), [{ pane: 'p1', cols: 44, rows: 22 }])
    await waitFor(() => env.events('pane.owner').length === 1, '폰으로')
    assert.deepEqual(took, ['p1'])
    // 맥에서 그 pane 을 누르거나 창이 앞으로 오면 맥 크기로 되찾는다
    control.macFocus('p1')
    await waitFor(() => env.events('pane.owner').length === 2, '맥으로')
    assert.deepEqual(env.events('pane.owner')[1], { event: 'pane.owner', pane: 'p1', owner: 'mac', mine: false, cols: 120, rows: 40 })
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 120, rows: 40 })
    // take 없이 크기만이면 다시 가져가지 않는다 · take 면 다시 가져간다
    assert.equal((await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 20 })).result.owner, 'mac')
    assert.equal((await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 20, take: true })).result.owner, 'phone')
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 44, rows: 20 })
  } finally {
    await env.cleanup()
  }
})

test('가져갈 때 돌려줄 맥 크기는 아는 크기로 — attach · 맥 화면 resize 를 쓰고 데몬 state 를 다시 묻지 않는다', async () => {
  const { control } = sharedControl()
  const env = await setup({ control })
  const states = () => env.daemon.state.ops.filter((entry) => entry.op === 'state').length
  try {
    await env.ask('pane.open', { pane: 'p1' })
    const before = states()
    await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 22, take: true })
    assert.equal(states(), before, 'attach 로 안 크기(120×40) — state 안 물음')
    control.macFocus('p1')
    await waitFor(() => resizes(env).length === 2, '맥으로')
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 120, rows: 40 })
    // 맥 화면이 크기를 바꾼 뒤(폰이 안 가졌을 때 데몬에 간 것) 가져가면 그 크기로 돌려준다
    assert.equal(control.macResize('p1', { cols: 100, rows: 30 }), false)
    await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 22, take: true })
    control.macFocus('p1')
    await waitFor(() => resizes(env).length === 4, '다시 맥으로')
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 100, rows: 30 })
    assert.equal(states(), before)
  } finally {
    await env.cleanup()
  }
})

test('resize · 주인 바뀜 뒤 잠깐(liveMs)은 묶지 않고 조각마다 바로 · 지나면 다시 묶음(첫 조각만 바로)', async () => {
  const env = await setup({ liveMs: 80 })
  try {
    await env.ask('pane.open', { pane: 'p1' })
    await env.ask('pane.size', { pane: 'p1', cols: 44, rows: 22, take: true })
    await waitFor(() => env.events('pane.owner').length === 1, '가져감')
    env.daemon.emit({ event: 'data', pane: 'p1', data: '머리' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: '본 그림' })
    await waitFor(() => env.events('pane.data').length === 2, '둘 다 바로')
    assert.deepEqual(env.events('pane.data').map((message) => message.panes.p1), ['머리', '본 그림'])
    await sleep(100)
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'x' })
    env.daemon.emit({ event: 'data', pane: 'p1', data: 'y' })
    await waitFor(() => env.events('pane.data').length === 3, '첫 조각 바로')
    await sleep(15)
    assert.equal(env.events('pane.data').length, 3, '뒤따르는 것은 묶음')
    await waitFor(() => env.events('pane.data').length === 4, '묶음')
    assert.deepEqual(env.events('pane.data').map((message) => message.panes.p1).slice(2), ['x', 'y'])
  } finally {
    await env.cleanup()
  }
})

test('폰 둘 — 다른 폰이 가져가면 앞 폰에 pane.owner(mine false) · 맥 알림은 맥 → 폰 때만 · 앞 폰이 나가도 그대로', async () => {
  const { control, took } = sharedControl()
  const env = await setup({ control })
  const other = createMemoryTransport()
  const second = createMobileBridge({
    daemonPaths: env.daemonPaths,
    transport: other.bridge,
    control,
    inputAllowed: () => true,
    requests: () => [],
    servers: () => [],
    events: () => [],
    answerRequest: async () => ({ ok: true }),
    approveRequest: async () => ({ ok: true }),
    athenaDir: () => null,
    leadPaneOf: () => null,
    postDecision: async () => ({ status: 200, body: {} }),
    packs: () => ({ current: null, packs: [] }),
    repoSettings: async () => ({ ok: true, repos: [] }),
    setRepo: async () => ({ ok: true }),
    openPack: async () => ({ ok: true }),
    logEvent: () => {},
    flushMs: 40,
  })
  const otherOwner = () => other.phone.received.filter((message) => message.event === 'pane.owner')
  try {
    await env.ask('pane.open', { pane: 'p1', cols: 50, rows: 30 })
    await waitFor(() => env.events('pane.owner').length === 1, '첫 폰')
    other.phone.send({ id: 1, op: 'pane.open', args: { pane: 'p1', cols: 40, rows: 60 } })
    await waitFor(() => otherOwner().length === 1, '둘째 폰')
    assert.deepEqual(otherOwner()[0], { event: 'pane.owner', pane: 'p1', owner: 'phone', mine: true, cols: 40, rows: 60 })
    await waitFor(() => env.events('pane.owner').length === 2, '첫 폰에 알림')
    assert.deepEqual(env.events('pane.owner')[1], { event: 'pane.owner', pane: 'p1', owner: 'phone', mine: false, cols: 40, rows: 60 })
    assert.deepEqual(took, ['p1'], '폰 → 폰은 맥 알림 없음')
    // 가지지 않은 첫 폰이 닫아도 크기는 그대로
    await env.ask('pane.close', { pane: 'p1' })
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 40, rows: 60 })
    // 둘째 폰이 끊기면 맥이 가져갈 때 크기(첫 폰이 가져가기 전)로
    await second.stop()
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 120, rows: 40 })
    assert.equal(control.ownerOf('p1').owner, 'mac')
  } finally {
    await second.stop()
    await env.cleanup()
  }
})

// ── 폰 이미지(pane.image) ──
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')])

test('imageType · decodeImage · imageFileName — 형식은 앞 바이트로만 · base64 만 · 크기 상한 · 이름에 사용자 입력 없음', () => {
  assert.equal(imageType(PNG), 'png')
  assert.equal(imageType(JPG), 'jpg')
  assert.equal(imageType(Buffer.from('GIF89a....')), 'gif')
  assert.equal(imageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp')
  // HEIC(ftypheic) · 글자는 받지 않는다
  assert.equal(imageType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')])), null)
  assert.equal(imageType(Buffer.from('<svg')), null)
  assert.ok(decodeImage(PNG.toString('base64')).equals(PNG))
  const code = (fn) => {
    try {
      fn()
    } catch (error) {
      return error.code
    }
    return null
  }
  assert.equal(code(() => decodeImage('')), 'usage')
  assert.equal(code(() => decodeImage('data:image/png;base64,AAAA')), 'usage')
  assert.equal(code(() => decodeImage('AAA')), 'usage')
  assert.equal(code(() => decodeImage('A'.repeat(Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 4))), 'too-large')
  assert.equal(decodeImage(Buffer.alloc(IMAGE_MAX_BYTES).toString('base64')).length, IMAGE_MAX_BYTES)
  const at = new Date(2026, 10, 12, 9, 5, 7).getTime()
  assert.match(imageFileName(at, 'png'), /^athena-img-20261112-090507-[0-9a-f]{8}\.png$/)
  assert.notEqual(imageFileName(at, 'png'), imageFileName(at, 'png'))
})

test('pane.image — 임시 폴더(0700)에 0600 으로 저장 · 경로 + 공백을 엔터 없이 입력 · 기록은 크기 · 형식만 · 하루 지난 그림은 다음 저장 때 지운다', async () => {
  const images = path.join(workDir(), 'imgs')
  const env = await setup({ imageDir: () => images })
  try {
    fs.mkdirSync(images, { recursive: true, mode: 0o755 })
    const old = path.join(images, 'athena-img-20261110-010101-0123abcd.png')
    const other = path.join(images, 'note.png')
    fs.writeFileSync(old, 'x')
    fs.writeFileSync(other, 'x')
    const past = (Date.now() - IMAGE_KEEP_MS - 60_000) / 1000
    fs.utimesSync(old, past, past)
    fs.utimesSync(other, past, past)
    const reply = await env.ask('pane.image', { pane: 'p1', data: PNG.toString('base64'), name: '../../etc/passwd' })
    assert.equal(reply.ok, true, JSON.stringify(reply))
    const saved = reply.result.path
    assert.equal(path.dirname(saved), images)
    assert.match(path.basename(saved), /^athena-img-\d{8}-\d{6}-[0-9a-f]{8}\.png$/)
    assert.deepEqual({ type: reply.result.type, bytes: reply.result.bytes }, { type: 'png', bytes: PNG.length })
    assert.ok(fs.readFileSync(saved).equals(PNG))
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600)
    assert.equal(fs.statSync(images).mode & 0o777, 0o700)
    const input = env.daemon.state.ops.find((entry) => entry.op === 'input')
    assert.deepEqual(input.args, { pane: 'p1', data: `${saved} ` })
    assert.ok(!/[\r\n]/.test(input.args.data))
    assert.deepEqual(env.logged, [{ type: 'mobile.image', fields: { by: 'mobile', pane: 'p1', bytes: PNG.length, type: 'png' } }])
    assert.ok(!fs.existsSync(old), '하루 지난 우리 그림은 지운다')
    assert.ok(fs.existsSync(other), '우리 이름이 아닌 파일은 둔다')
  } finally {
    await env.cleanup()
    fs.rmSync(path.dirname(images), { recursive: true, force: true })
  }
})

test('pane.image — 입력 허용 꺼짐 · 모르는 형식 · 없는 pane 은 거절하고 파일 · 입력을 남기지 않는다 · 크기를 보내면 폰 크기로 가져간다', async () => {
  const images = path.join(workDir(), 'imgs')
  const { control, took } = sharedControl()
  const env = await setup({ imageDir: () => images, control })
  try {
    env.flags.input = false
    assert.equal((await env.ask('pane.image', { pane: 'p1', data: PNG.toString('base64') })).error.code, 'input-off')
    env.flags.input = true
    assert.equal((await env.ask('pane.image', { pane: 'p1', data: Buffer.from('heic?').toString('base64') })).error.code, 'unsupported-type')
    assert.equal((await env.ask('pane.image', { pane: 'nope', data: PNG.toString('base64') })).error.code, 'not_found')
    assert.equal((await env.ask('pane.image', { pane: 'p1', data: PNG.toString('base64'), cols: 1, rows: 5 })).error.code, 'usage')
    assert.ok(!fs.existsSync(images) || fs.readdirSync(images).length === 0)
    assert.equal(env.daemon.state.ops.filter((entry) => entry.op === 'input').length, 0)
    const reply = await env.ask('pane.image', { pane: 'p1', data: JPG.toString('base64'), cols: 50, rows: 30 })
    assert.equal(reply.result.type, 'jpg')
    assert.match(reply.result.path, /\.jpg$/)
    assert.deepEqual(resizes(env).at(-1), { pane: 'p1', cols: 50, rows: 30 })
    assert.deepEqual(took, ['p1'])
    // paste: true — 붙여넣기 표시로 감싼다(Claude Code 가 첨부로 바꾸는 길) · 공백 없음 · 틀린 값은 usage
    assert.equal((await env.ask('pane.image', { pane: 'p1', data: PNG.toString('base64'), paste: 'yes' })).error.code, 'usage')
    const pasted = await env.ask('pane.image', { pane: 'p1', data: PNG.toString('base64'), paste: true })
    const inputs = env.daemon.state.ops.filter((entry) => entry.op === 'input')
    assert.deepEqual(inputs.at(-1).args, { pane: 'p1', data: `\x1b[200~${pasted.result.path}\x1b[201~` })
  } finally {
    await env.cleanup()
    fs.rmSync(path.dirname(images), { recursive: true, force: true })
  }
})

test('saveImage — 폴더가 링크면 쓰지 않는다', async () => {
  const dir = workDir()
  try {
    const real = path.join(dir, 'real')
    fs.mkdirSync(real)
    const link = path.join(dir, 'link')
    fs.symlinkSync(real, link)
    await assert.rejects(saveImage(link, PNG, 'png', Date.now()), (error) => error.code === 'internal')
    assert.equal(fs.readdirSync(real).length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── 폰 스페이스 · 팩 · 레포 이미지(계획서 20261114 5절) ──
// 진짜 그림 머리(iconMime 이 12바이트 이상을 본다)
const ICON_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-그림-하나')])
const ICON_JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-그림-둘-길게')])

test('macSpaces — 맥 사이드바 순서(아테나 → 작업 공간 → pane 없는 레포 → 서버) · 앞 창 본체 것만 · 레포 이름이 같을 때만 이름 · 이미지', () => {
  const dir = workDir()
  try {
    const body = fs.realpathSync(dir)
    const state = {
      workspaces: [
        { id: 'w1', label: 'web', cwd: `${body}/repos/web`, body },
        { id: 'w2', label: 'novum-ops', cwd: body, body },
        { id: 'w3', label: 'athena', cwd: body, body },
        { id: 'w4', label: 'globex-api', cwd: '/b/globex', body: '/b/globex' },
        { id: 'w5', label: '셸', cwd: '/tmp', body: null },
        { id: 'w6', label: 'ssh-novum', cwd: body, body },
      ],
    }
    const repos = [
      { name: 'api', displayName: '백엔드', icon: 'tok-api' },
      { name: 'web', displayName: null, icon: 'tok-web' },
      { name: 'athena', displayName: '같은 이름', icon: 'tok-x' },
    ]
    assert.deepEqual(macSpaces(state, dir, repos, ['novum'], 'tok-athena'), [
      // 아테나 작업 공간 — 맥 사이드바처럼 이름 athena · 아테나 로고(같은 이름 레포의 이름 · 이미지는 쓰지 않는다)
      { workspace: 'athena', repo: null, displayName: 'athena', icon: 'tok-athena' },
      { workspace: 'web', repo: 'web', displayName: null, icon: 'tok-web' },
      { workspace: '셸', repo: null, displayName: null, icon: null },
      { workspace: 'api', repo: 'api', displayName: '백엔드', icon: 'tok-api' },
      { workspace: 'novum-ops', repo: null, displayName: null, icon: null },
      { workspace: 'ssh-novum', repo: null, displayName: null, icon: null },
    ])
    assert.deepEqual(macSpaces(state, null, repos, []), [], '앞 창이 없으면 빈 목록')
    assert.deepEqual(macSpaces(state, dir, repos, ['novum'])[0], { workspace: 'athena', repo: null, displayName: 'athena', icon: null }, '로고 토큰을 못 구하면 icon null')
    // 옛 버그로 폴더 이름이 붙은 아테나 작업 공간도 보이는 이름은 athena(맥 workspaceName · displayLabel)
    const old = { workspaces: [{ id: 'w1', label: path.basename(body), cwd: body, body }] }
    assert.deepEqual(macSpaces(old, dir, [], [], 'tok-athena'), [{ workspace: path.basename(body), repo: null, displayName: 'athena', icon: 'tok-athena' }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('이미지 토큰 — 내용 해시 · 같은 내용이면 같고 바뀌면 바뀐다 · 1MiB 넘음 · 그림 아님 · 없는 파일은 null · 내준 토큰만 읽는다', async () => {
  const dir = workDir()
  try {
    const tokens = createIconTokens()
    const file = path.join(dir, 'web.png')
    fs.writeFileSync(file, ICON_PNG)
    const first = await tokens.tokenOf(file)
    assert.equal(first, iconToken(ICON_PNG))
    assert.match(first, /^[0-9a-f]{32}$/)
    assert.equal(await tokens.tokenOf(file), first, '같은 파일은 같은 토큰')
    const copy = path.join(dir, 'copy.png')
    fs.writeFileSync(copy, ICON_PNG)
    assert.equal(await tokens.tokenOf(copy), first, '경로가 달라도 같은 내용이면 같은 토큰')
    assert.deepEqual(await tokens.read(first), { token: first, mime: 'image/png', data: ICON_PNG.toString('base64') })

    fs.writeFileSync(file, ICON_JPG)
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
    const second = await tokens.tokenOf(file)
    assert.notEqual(second, first, '그림이 바뀌면 토큰이 바뀐다')
    assert.equal((await tokens.read(second)).mime, 'image/jpeg')

    const big = path.join(dir, 'big.png')
    fs.writeFileSync(big, Buffer.concat([ICON_PNG, Buffer.alloc(1024 * 1024)]))
    assert.equal(await tokens.tokenOf(big), null, '1MiB 넘음')
    const svg = path.join(dir, 'x.webp')
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>')
    assert.equal(await tokens.tokenOf(svg), null, '그림 머리가 아님')
    assert.equal(await tokens.tokenOf(path.join(dir, 'none.png')), null)
    assert.equal(await tokens.tokenOf(null), null)
    assert.equal(await tokens.read('0'.repeat(32)), null, '내준 적 없는 토큰')
    assert.equal(await createIconTokens().read(second), null, '다른 저장소가 내준 토큰은 모른다')
    fs.rmSync(file)
    assert.equal(await tokens.read(second), null, '그사이 지운 파일')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshot.spaces · 팩 icon · look.icon — pane 없는 레포도 · 이미지는 토큰만(경로 없음) · 토큰으로 그림 · 모르는 토큰 null · 빈 토큰 usage', async () => {
  const dir = workDir()
  const body = fs.realpathSync(dir)
  const repoIcon = path.join(dir, 'web.png')
  const packIcon = path.join(dir, 'globex.jpg')
  fs.writeFileSync(repoIcon, ICON_PNG)
  fs.writeFileSync(packIcon, ICON_JPG)
  const env = await setup({
    athenaDir: () => dir,
    look: async () => ({
      repos: [{ name: 'web', displayName: '웹', iconPath: repoIcon }, { name: 'api', displayName: null, iconPath: null }],
      servers: [],
      packIcons: { acme: null, globex: packIcon },
    }),
  })
  try {
    env.daemon.state.workspaces = [{ id: 'w1', label: 'athena', cwd: body, activeTab: 't1', body }, { id: 'w2', label: 'web', cwd: `${body}/repos/web`, activeTab: 't2', body }]
    const snap = (await env.ask('snapshot')).result
    const webToken = iconToken(ICON_PNG)
    const logoToken = iconToken(fs.readFileSync(ATHENA_LOGO))
    assert.deepEqual(snap.spaces, [
      { workspace: 'athena', repo: null, displayName: 'athena', icon: logoToken },
      { workspace: 'web', repo: 'web', displayName: '웹', icon: webToken },
      { workspace: 'api', repo: 'api', displayName: null, icon: null },
    ])
    assert.deepEqual(snap.otherPacks.map((pack) => [pack.id, pack.icon]), [['globex', iconToken(ICON_JPG)]])
    assert.ok(!JSON.stringify(snap).includes(dir), '경로는 폰에 넘기지 않는다')
    const list = (await env.ask('pack.list')).result
    assert.deepEqual(list.packs.map((pack) => [pack.id, pack.icon]), [['acme', null], ['globex', iconToken(ICON_JPG)]])

    assert.deepEqual((await env.ask('look.icon', { token: webToken })).result, { token: webToken, mime: 'image/png', data: ICON_PNG.toString('base64') })
    // 아테나 로고도 같은 토큰 규칙으로 내려받는다 — 맥 사이드바가 그리는 그 파일(화이트판 180)
    assert.deepEqual((await env.ask('look.icon', { token: logoToken })).result, { token: logoToken, mime: 'image/png', data: fs.readFileSync(ATHENA_LOGO).toString('base64') })
    const unknown = await env.ask('look.icon', { token: 'f'.repeat(32) })
    assert.equal(unknown.ok, true)
    assert.equal(unknown.result, null, '모르는 토큰은 null')
    assert.equal((await env.ask('look.icon', {})).error.code, 'usage')
  } finally {
    await env.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // athenaDir 를 안 넘긴 옛 부르는 쪽 — spaces 는 빈 목록 · snapshot 은 그대로
  const noDir = await setup({ athenaDir: undefined })
  try {
    const reply = await noDir.ask('snapshot')
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.result.spaces, [])
  } finally {
    await noDir.cleanup()
  }
  // 원천이 실패해도 snapshot 은 그대로(빈 목록 · icon null)
  const failing = await setup({ athenaDir: () => '/b/acme', look: async () => { throw new Error('읽기 실패') } })
  try {
    const snap = (await failing.ask('snapshot')).result
    assert.deepEqual(snap.spaces, [{ workspace: 'athena', repo: null, displayName: 'athena', icon: iconToken(fs.readFileSync(ATHENA_LOGO)) }], '아테나 로고는 원천과 따로')
    assert.equal(snap.otherPacks[0].icon, null)
  } finally {
    await failing.cleanup()
  }
})

test('아테나 로고 — 맥 사이드바(ui/spaces.tsx spaceImage)가 아테나 줄에 그리는 파일 · 배포판도 그 폴더를 들고 간다 · 토큰 규칙(png · 1MiB 이하) 안', () => {
  const spaces = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ui', 'spaces.tsx'), 'utf8')
  assert.match(spaces, /assets\/logo\/athena-white-\$\{size\}\.png/)
  assert.match(spaces, /spaceImage\([^)]*, 180\)/, '사이드바가 쓰는 크기 중 하나(180)')
  assert.equal(ATHENA_LOGO, path.join(__dirname, '..', 'src', 'renderer', 'assets', 'logo', 'athena-white-180.png'))
  const bytes = fs.readFileSync(ATHENA_LOGO)
  assert.ok(bytes.length <= 1024 * 1024)
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG')
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-mac.js'), 'utf8'), /'src\/renderer\/assets\/logo\/\*\*'/, '배포판 FILES 에 로고 폴더')
})

test('lookSource — 사이드바 packRepos · serverList · 팩 이미지 경로(pack list iconPath) · 앞 창 없음 · 읽기 실패는 빈 값', async () => {
  assert.deepEqual(await lookSource(null), { repos: [], servers: [], packIcons: {} })
  const ctx = {
    packState: { current: { id: 'acme' }, packs: [{ id: 'acme', name: 'acme', iconPath: '/p/acme/icon.png' }, { id: 'globex', name: 'globex', iconPath: 'relative.png' }, { id: 'initech', iconPath: '/p/i.svg' }] },
    packRepos: async () => [{ name: 'web', displayName: '웹', iconPath: '/p/acme/assets/repos/web.png', agent: 'fe' }, { name: 'api', displayName: null, iconPath: null }],
    serverList: async () => [{ name: 'novum', host: '1.2.3.4' }],
  }
  assert.deepEqual(await lookSource(ctx), {
    repos: [{ name: 'web', displayName: '웹', iconPath: '/p/acme/assets/repos/web.png' }, { name: 'api', displayName: null, iconPath: null }],
    servers: ['novum'],
    packIcons: { acme: '/p/acme/icon.png', globex: null, initech: null },
  })
  assert.deepEqual(await lookSource({ packState: {}, packRepos: async () => { throw new Error('x') }, serverList: async () => { throw new Error('y') } }), { repos: [], servers: [], packIcons: {} })
})
