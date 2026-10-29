const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../src/lib/screen-model')

test('id: 종류마다 1 부터 · 다시 쓰지 않음 · [\\w:] 만', () => {
  const ids = model.createIdGen()
  assert.deepEqual([ids.next('p'), ids.next('p'), ids.next('t'), ids.next('p')], ['p1', 'p2', 't1', 'p3'])
  assert.match(ids.next('p'), /^[\w:]+$/)
})

test('id: 36진수 소문자 — p230 다음 p6f · 예전 10진 id 와 같은 글자(숫자만)는 건너뛴다 · 카운터는 10진 숫자', () => {
  const saved = []
  const ids = model.createIdGen({ p: 230 }, (counters) => saved.push(counters))
  assert.equal(ids.next('p'), 'p6f')
  assert.deepEqual(saved.at(-1), { p: 231 })
  const fresh = model.createIdGen()
  const made = Array.from({ length: 40 }, () => fresh.next('t'))
  assert.deepEqual(made.slice(0, 11), ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't1a', 't1b'])
  assert.equal(made[34], 't1z') // 10 ~ 35 는 글자만('a' ~ 'z')이라 건너뛰고, 36('10') ~ 45('19') 는 예전 t10 ~ t19 와 겹쳐 건너뛴다
  assert.equal(made[35], 't2a')
  assert.ok(made.every((id) => /^t[0-9a-z]+$/.test(id) && /\d/.test(id.slice(1)) && (id.length < 3 || /[a-z]/.test(id.slice(1)))))
  assert.equal(model.createIdGen({ w: 1295 }).next('w'), 'w10a') // 1296('100') ~ 1305('109') 는 건너뛴다
  assert.equal(model.createIdGen({ p: 46654 }).next('p'), 'p100a') // 46655('zzz') 는 글자만이라 건너뛰고 · 46656 ~ 은 숫자만('1000' …)이라 건너뛴다
})

test('id: 숫자가 하나도 없는(글자만인) id 는 건너뛴다 — ps · pwd 같은 명령어 이름과 겹치지 않게 · 저장된 카운터는 그대로', () => {
  const saved = []
  const ids = model.createIdGen({ p: 27 }, (counters) => saved.push(counters)) // 28 = 's' → 'ps' 가 될 번호
  assert.equal(ids.next('p'), 'p1a')
  assert.deepEqual(saved.at(-1), { p: 46 }) // 10 ~ 35(글자만) · 36 ~ 45('10' ~ '19', 숫자만)를 건너뛴 다음 번호
  const fresh = model.createIdGen()
  const made = Array.from({ length: 200 }, () => fresh.next('p'))
  assert.ok(made.every((id) => /\d/.test(id.slice(1))))
  assert.ok(!made.includes('ps'))
})

test('id: 지난 데몬 번호에서 이어서 센다 · 바뀔 때마다 알린다 · 이상한 값은 버린다', () => {
  const saved = []
  const ids = model.createIdGen({ p: 4, t: 2, bad: -1, 'x-y': 3, w: 'a' }, (counters) => saved.push(counters))
  assert.deepEqual([ids.next('p'), ids.next('t'), ids.next('w')], ['p5', 't3', 'w1'])
  assert.deepEqual(saved.at(-1), { p: 5, t: 3, w: 1 })
  assert.deepEqual([model.createIdGen(null).next('p'), model.createIdGen('x').next('p')], ['p1', 'p1'])
})

test('납작한 Pane: 화면 계층 screen.py 계약과 같은 14개 키 · 빈 값은 null', () => {
  // 아테나 scripts/lib/screen.py 머리 계약(Pane) 키 순서 그대로 — 바뀌면 코어 계약이 바뀐 것. cols · rows 는 뒤에 더했다(추가만)
  const expected = ['id', 'tab_id', 'workspace_id', 'label', 'name', 'pane_title', 'cwd', 'foreground_cwd', 'focused', 'agent', 'agent_status', 'title', 'cols', 'rows']
  assert.deepEqual(model.PANE_KEYS, expected)
  const pane = model.flatPane({ id: 'p1', tabId: 't1', workspaceId: 'w2', label: '', cwd: '/a', foregroundCwd: '/a/b', focused: 1, agent: 'claude', agentStatus: 'idle', title: '', cols: 80, rows: 24 })
  assert.deepEqual(Object.keys(pane), expected)
  assert.deepEqual(pane, {
    id: 'p1',
    tab_id: 't1',
    workspace_id: 'w2',
    label: null,
    name: null,
    pane_title: null,
    cwd: '/a',
    foreground_cwd: '/a/b',
    focused: true,
    agent: 'claude',
    agent_status: 'idle',
    title: null,
    cols: 80,
    rows: 24,
  })
  assert.equal(model.flatPane({ id: 'p2', tabId: 't1' }).agent, null)
  assert.equal(model.flatPane({ id: 'p2', tabId: 't1' }).cols, null)
  assert.equal(model.flatPane({ id: 'p2', tabId: 't1' }).workspace_id, null)
})

test('키 이름: Enter · C-c 같은 이름 · 대소문자 무시 · 모르면 null', () => {
  assert.equal(model.keyBytes('Enter'), '\r')
  assert.equal(model.keyBytes('enter'), '\r')
  assert.equal(model.keyBytes('esc'), '\x1b')
  assert.equal(model.keyBytes('Escape'), '\x1b')
  assert.equal(model.keyBytes('BSpace'), '\x7f')
  assert.equal(model.keyBytes('Up'), '\x1b[A')
  assert.equal(model.keyBytes('Left'), '\x1b[D')
  assert.equal(model.keyBytes('C-c'), '\x03')
  assert.equal(model.keyBytes('C-C'), '\x03')
  assert.equal(model.keyBytes('C-d'), '\x04')
  assert.equal(model.keyBytes('C-['), '\x1b')
  assert.equal(model.keyBytes('C-@'), '\x00')
  assert.equal(model.keyBytes('C-?'), '\x7f')
  for (const bad of ['', 'Nope', 'C-', 'C-1', 'C-cc', undefined, 3]) assert.equal(model.keyBytes(bad), null)
})

// ps -axo pid=,pgid=,tpgid=,comm= 모양
const PS = [
  '  100   100   200 /bin/zsh', // pane A 셸 — 앞쪽 그룹 200
  '  200   200   200 claude', //   claude (comm 은 argv0 — 실제 파일은 versions/2.1.302)
  '  201   200   200 /bin/bash', //   claude 가 띄운 도구
  '  300   300   300 -zsh', // pane B 셸 — 자기가 앞(빈 셸)
  '  400   400   500 /bin/zsh', // pane C 셸
  '  500   500   500 /usr/local/bin/node', //   npm 판 codex
  '  600   600   700 /bin/zsh', // pane D 셸
  '  700   700   700 /Applications/Some App.app/Contents/MacOS/Some App', //   공백 있는 comm
  'garbage line',
].join('\n')

test('ps 읽기: 공백이 있는 comm 도 끝까지 · 못 읽는 줄은 버림', () => {
  const rows = model.parsePs(PS)
  assert.equal(rows.length, 8)
  assert.deepEqual(rows[0], { pid: 100, pgid: 100, tpgid: 200, comm: '/bin/zsh' })
  assert.equal(rows[7].comm, '/Applications/Some App.app/Contents/MacOS/Some App')
})

test('빈 셸: 셸이 앞쪽 그룹이면 true · 모르면 false', () => {
  const rows = model.parsePs(PS)
  assert.equal(model.isShellIdle(rows, 300), true)
  assert.equal(model.isShellIdle(rows, 100), false)
  assert.equal(model.isShellIdle(rows, 999), false)
  assert.equal(model.foregroundGroup(rows, 300), null)
  assert.equal(model.foregroundGroup(rows, 100), 200)
})

test('agent: 앞쪽 그룹의 comm 이름 · node 면 두 번째 낱말 · 그 밖은 null', () => {
  const rows = model.parsePs(PS)
  assert.equal(model.detectAgent(rows, 100), 'claude')
  assert.equal(model.detectAgent(rows, 300), null)
  const argsOf = (pid) => (pid === 500 ? '/usr/local/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex --yolo' : null)
  assert.equal(model.detectAgent(rows, 400, argsOf), 'codex')
  assert.equal(model.detectAgent(rows, 400), null) // args 를 모르면 node 는 agent 가 아니다
  assert.equal(model.detectAgent(rows, 600), null)
  assert.equal(model.detectAgent(rows, 999), null)
})

test('agent_status: 표식 · 출력 정지 · agent 아님', () => {
  const now = 100000
  const quiet = now - model.QUIET_MS - 1
  const working = ['✻ Thinking… (12s · esc to interrupt)', '', '❯ ', '']
  assert.equal(model.agentStatus({ agent: 'claude', screenLines: working, lastOutputAt: quiet, now }), 'working')
  assert.equal(model.agentStatus({ agent: 'codex', screenLines: ['• Working (3s • Esc to interrupt)'], lastOutputAt: quiet, now }), 'working')
  assert.equal(model.agentStatus({ agent: 'claude', screenLines: ['❯ '], lastOutputAt: now - 100, now }), 'working')
  assert.equal(model.agentStatus({ agent: 'claude', screenLines: ['❯ '], lastOutputAt: quiet, now }), 'idle')
  assert.equal(model.agentStatus({ agent: 'claude', screenLines: [], lastOutputAt: 0, now }), 'idle')
  assert.equal(model.agentStatus({ agent: null, screenLines: working, lastOutputAt: now, now }), 'unknown')
  // 표식이 화면 위쪽(끝 8줄 밖)으로 밀려나면 보지 않는다
  const old = ['esc to interrupt', ...Array.from({ length: 8 }, (_, index) => `line ${index}`)]
  assert.equal(model.agentStatus({ agent: 'claude', screenLines: old, lastOutputAt: quiet, now }), 'idle')
})

// 실측 화면(2026-10-25 · Claude Code 2.1.310 · codex-cli 0.160.0 — pane read --source visible) 그대로 줄인 것
const WAIT_SCREENS = {
  claudePermission: [
    '⏺ Creating empty file probe-two.txt',
    '  ⎿  $ touch probe-two.txt',
    '─────────────────────',
    ' Bash command',
    ' touch probe-two.txt',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don’t ask again for: touch *',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ],
  claudeQuestion: [' ☐ Color', '', 'Which color do you like?', '', '❯ 1. Red', '     The color red', '  2. Blue', '  3. Type something.', '────', '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'],
  claudeTrust: [' Quick safety check: Is this a project you created or one you trust?', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'],
  codexApproval: ['  Would you like to run the following command?', '', '  $ touch codex-probe.txt', '', '', '› 1. Yes, proceed (y)', "  2. Yes, and don't ask again (p)", '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel'],
  codexHooks: ['  Hooks need review', '', '› 1. Review hooks', '  2. Trust all and continue', '', '  enter confirm · esc skip'],
}

test('입력 대기: 권한 질문 · 고르기 창 · 폴더 신뢰 · Codex 승인은 잡고, 빈 입력칸 · 일하는 중 · 본문 속 같은 글은 빼고', () => {
  for (const [name, lines] of Object.entries(WAIT_SCREENS)) assert.equal(model.waitingForInput(lines.join('\n')), true, name)
  // 빈 입력칸(Claude · Codex)
  const claudeIdle = ['⏺ 끝났어요', '', '✻ Churned for 9s', '', '────', '❯ ', '────', '  Opus 5.5 | ctx 6%', '  ⏵⏵ auto mode on (shift+tab to cycle)']
  assert.equal(model.waitingForInput(claudeIdle.join('\n')), false)
  assert.equal(model.waitingForInput(['› Ask Codex to do anything', '', '  GPT medium · /tmp', '  ? for shortcuts'].join('\n')), false)
  // 일하는 중(맺음 줄 자리에 esc to interrupt)
  assert.equal(model.waitingForInput(['❯ 1. Yes', '✻ Thinking… (3s · esc to interrupt)', 'Esc to cancel'].join('\n')), false)
  // 대화 본문에 같은 글이 있어도 화면 맨 아래가 아니면 아니다
  assert.equal(model.waitingForInput(['❯ 1. Yes', 'Esc to cancel · Tab to amend', ...claudeIdle].join('\n')), false)
  // 고르는 줄이 없으면 아니다 · 빈 화면
  assert.equal(model.waitingForInput(['some log', 'Press enter to confirm or esc to cancel'].join('\n')), false)
  assert.equal(model.waitingForInput(''), false)
  assert.equal(model.waitingForInput(null), false)
})

test('읽기: 줄 끝 공백 · 끝 빈 줄 떼고 마지막 N 줄', () => {
  const lines = ['a  ', 'b', '  c ', '', '   ', '']
  assert.equal(model.formatRead(lines), 'a\nb\n  c\n')
  assert.equal(model.formatRead(lines, 2), 'b\n  c\n')
  assert.equal(model.formatRead(lines, 0), 'a\nb\n  c\n')
  assert.equal(model.formatRead(['', ' ']), '')
  assert.equal(model.formatRead(undefined), '')
})

test('기다리기 맞추기: match · regex · 둘 다 없으면 예외', () => {
  assert.equal(model.findMatch('hello world', { match: 'world' }), 'world')
  assert.equal(model.findMatch('hello world', { match: 'nope' }), null)
  assert.equal(model.findMatch('done: 42\n', { regex: '^done: \\d+$' }), 'done: 42')
  assert.equal(model.findMatch('x', { regex: 'y' }), null)
  assert.throws(() => model.findMatch('x', {}), /--match/)
  assert.throws(() => model.findMatch('x', { regex: '(' }))
})
