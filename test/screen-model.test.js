const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../src/lib/screen-model')

test('id: 종류마다 1 부터 · 다시 쓰지 않음 · [\\w:] 만', () => {
  const ids = model.createIdGen()
  assert.deepEqual([ids.next('p'), ids.next('p'), ids.next('t'), ids.next('p')], ['p1', 'p2', 't1', 'p3'])
  assert.match(ids.next('p'), /^[\w:]+$/)
})

test('id: 지난 데몬 번호에서 이어서 센다 · 바뀔 때마다 알린다 · 이상한 값은 버린다', () => {
  const saved = []
  const ids = model.createIdGen({ p: 4, t: 2, bad: -1, 'x-y': 3, w: 'a' }, (counters) => saved.push(counters))
  assert.deepEqual([ids.next('p'), ids.next('t'), ids.next('w')], ['p5', 't3', 'w1'])
  assert.deepEqual(saved.at(-1), { p: 5, t: 3, w: 1 })
  assert.deepEqual([model.createIdGen(null).next('p'), model.createIdGen('x').next('p')], ['p1', 'p1'])
})

test('납작한 Pane: 화면 계층 screen.py _pane 과 같은 12개 키 · 빈 값은 null', () => {
  // 아테나 scripts/lib/screen.py `_pane` 키 순서 그대로 — 바뀌면 코어 계약이 바뀐 것
  const expected = ['id', 'tab_id', 'workspace_id', 'label', 'name', 'pane_title', 'cwd', 'foreground_cwd', 'focused', 'agent', 'agent_status', 'title']
  assert.deepEqual(model.PANE_KEYS, expected)
  const pane = model.flatPane({ id: 'p1', tabId: 't1', workspaceId: 'w2', label: '', cwd: '/a', foregroundCwd: '/a/b', focused: 1, agent: 'claude', agentStatus: 'idle', title: '' })
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
  })
  assert.equal(model.flatPane({ id: 'p2', tabId: 't1' }).agent, null)
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
