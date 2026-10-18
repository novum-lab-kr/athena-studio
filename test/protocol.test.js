const test = require('node:test')
const assert = require('node:assert/strict')
const protocol = require('../src/lib/protocol')

test('프레이밍: 조각 · 여러 줄 · 빈 줄 · 깨진 줄', () => {
  const messages = []
  const invalid = []
  const feed = protocol.createDecoder((message) => messages.push(message), (line) => invalid.push(line))
  feed(protocol.encode({ id: 1, op: 'pane list' }).slice(0, 10))
  assert.deepEqual(messages, [])
  feed(protocol.encode({ id: 1, op: 'pane list' }).slice(10) + '\n{oops}\n' + protocol.encode({ event: 'data', text: '한글\n줄' }))
  assert.deepEqual(messages, [{ id: 1, op: 'pane list' }, { event: 'data', text: '한글\n줄' }])
  assert.deepEqual(invalid, ['{oops}'])
  assert.equal(protocol.encode({ a: 1 }), '{"a":1}\n')
})

test('오류 응답: 모르는 코드는 internal', () => {
  assert.deepEqual(protocol.errorReply(3, 'timeout', '늦음'), { id: 3, ok: false, error: { code: 'timeout', message: '늦음' } })
  assert.equal(protocol.errorReply(3, 'weird', 'x').error.code, 'internal')
})

test('핸드셰이크: 프로토콜 번호만 비교', () => {
  assert.equal(protocol.checkHello({ ok: true, result: { protocol: protocol.PROTOCOL, daemonVersion: '0.0.1' } }), 'ok')
  assert.equal(protocol.checkHello({ ok: true, result: { protocol: protocol.PROTOCOL + 1 } }), 'mismatch')
  assert.equal(protocol.checkHello({ ok: false, error: {} }), 'invalid')
  assert.equal(protocol.checkHello({ ok: true, result: { protocol: '1' } }), 'invalid')
  assert.equal(protocol.checkHello(null), 'invalid')
})

// 옛 데몬 — 'pane pids' 를 더하며 4 로 올렸다. 3 이하로 뜬 데몬은 다시 띄우라는 확인창(mismatch)으로 가야 한다
test('핸드셰이크: pane pids 전 데몬(protocol 3)은 mismatch', () => {
  assert.ok(protocol.PROTOCOL >= 4)
  const oldHello = { ok: true, result: { protocol: 3, daemonVersion: '0.1.0', pid: 54972, startedAt: '2026-10-17T00:00:00.000Z', panes: 2 } }
  assert.equal(protocol.checkHello(oldHello), 'mismatch')
})

test('종료 코드: unavailable 은 3, 그 밖은 1', () => {
  assert.equal(protocol.exitCodeFor('unavailable'), 3)
  for (const code of ['usage', 'not_found', 'timeout', 'internal']) assert.equal(protocol.exitCodeFor(code), 1)
})

test('CLI: 데몬에 묻지 않는 것 — help · version · self', () => {
  assert.deepEqual(protocol.parseCli([]), { op: 'help', local: true })
  assert.deepEqual(protocol.parseCli(['--help']), { op: 'help', local: true })
  assert.deepEqual(protocol.parseCli(['version']), { op: 'version', local: true })
  assert.deepEqual(protocol.parseCli(['self']), { op: 'self', local: true })
})

test('CLI: 조회', () => {
  assert.deepEqual(protocol.parseCli(['pane', 'list']), { op: 'pane list', args: {} })
  assert.deepEqual(protocol.parseCli(['pane', 'current']), { op: 'pane current', args: {} })
  assert.deepEqual(protocol.parseCli(['pane', 'get', 'p3']), { op: 'pane get', args: { pane: 'p3' } })
  assert.deepEqual(protocol.parseCli(['pane', 'is-shell', 'p3']), { op: 'pane is-shell', args: { pane: 'p3' } })
  assert.deepEqual(protocol.parseCli(['pane', 'close', 'p3']), { op: 'pane close', args: { pane: 'p3' } })
  assert.throws(() => protocol.parseCli(['pane', 'get']), { code: 'usage' })
  // 남는 인자는 조용히 버리지 않고 거절
  assert.throws(() => protocol.parseCli(['pane', 'get', 'p3', 'p4']), /남는 인자: p4/)
  assert.throws(() => protocol.parseCli(['pane', 'list', 'extra']), /남는 인자/)
  assert.throws(() => protocol.parseCli(['pane', 'read', 'p1', 'extra']), /남는 인자/)
  assert.throws(() => protocol.parseCli(['pane', 'wait-output', 'p1', 'p2', '--match', 'x']), /남는 인자/)
})

test('CLI: split — 플래그 · env 여러 번 · 잘못된 값', () => {
  const parsed = protocol.parseCli(['pane', 'split', '--target', 'self', '--direction', 'right', '--ratio', '0.5', '--cwd', '/w', '--env', 'A=1', '--env', 'B=x=y', '--no-focus'])
  assert.deepEqual(parsed, { op: 'pane split', args: { target: 'self', direction: 'right', ratio: 0.5, cwd: '/w', env: { A: '1', B: 'x=y' }, focus: false } })
  assert.equal(protocol.parseCli(['pane', 'split', '--target', 'p1', '--direction', 'down']).args.focus, undefined)
  assert.equal(protocol.parseCli(['pane', 'split', '--target', 'p1', '--direction', 'down', '--focus']).args.focus, true)
  const usage = { code: 'usage' }
  assert.throws(() => protocol.parseCli(['pane', 'split', '--target', 'p1']), usage)
  assert.throws(() => protocol.parseCli(['pane', 'split', '--target', 'p1', '--direction', 'left']), usage)
  assert.throws(() => protocol.parseCli(['pane', 'split', '--target', 'p1', '--direction', 'down', '--ratio', '1']), usage)
  assert.throws(() => protocol.parseCli(['pane', 'split', '--target', 'p1', '--direction', 'down', '--env', 'NOEQ']), usage)
  assert.throws(() => protocol.parseCli(['pane', 'split', '--target', 'p1', '--direction', 'down', '--what']), usage)
  assert.throws(() => protocol.parseCli(['pane', 'split', '--target']), usage)
  assert.throws(() => protocol.parseCli(['pane', 'split', 'p1', '--target', 'p1', '--direction', 'down']), /남는 인자: p1/)
})

test('CLI: run · send-text · send-keys · rename 은 뒤를 그대로', () => {
  assert.deepEqual(protocol.parseCli(['pane', 'run', 'p1', 'claude', '--agent', 'x']), { op: 'pane run', args: { pane: 'p1', text: 'claude --agent x' } })
  assert.deepEqual(protocol.parseCli(['pane', 'send-text', 'p1', '--not-a-flag']), { op: 'pane send-text', args: { pane: 'p1', text: '--not-a-flag' } })
  assert.deepEqual(protocol.parseCli(['pane', 'send-keys', 'p1', 'C-c', 'Enter']), { op: 'pane send-keys', args: { pane: 'p1', keys: ['C-c', 'Enter'] } })
  assert.deepEqual(protocol.parseCli(['pane', 'rename', 'p1', '🤖 a · b']), { op: 'pane rename', args: { pane: 'p1', label: '🤖 a · b' } })
  assert.throws(() => protocol.parseCli(['pane', 'run', 'p1']), { code: 'usage' })
  assert.throws(() => protocol.parseCli(['pane', 'send-text', 'p1', 'a', 'b']), /남는 인자: b/)
  assert.throws(() => protocol.parseCli(['pane', 'rename', 'p1', 'a', 'b']), /남는 인자: b/)
})

test('CLI: read · wait-output', () => {
  assert.deepEqual(protocol.parseCli(['pane', 'read', 'p1']), { op: 'pane read', args: { pane: 'p1', lines: undefined, source: 'recent' } })
  assert.deepEqual(protocol.parseCli(['pane', 'read', 'p1', '--lines', '40', '--source', 'visible']), { op: 'pane read', args: { pane: 'p1', lines: 40, source: 'visible' } })
  assert.throws(() => protocol.parseCli(['pane', 'read', 'p1', '--lines', '0']), { code: 'usage' })
  assert.throws(() => protocol.parseCli(['pane', 'read', 'p1', '--source', 'recent-unwrapped']), { code: 'usage' })
  assert.throws(() => protocol.parseCli(['pane', 'read', 'p1', '--ansi']), { code: 'usage' }) // 1차는 글자만
  assert.deepEqual(protocol.parseCli(['pane', 'wait-output', 'p1', '--match', 'done', '--timeout', '5000']), {
    op: 'pane wait-output',
    args: { pane: 'p1', match: 'done', regex: undefined, lines: undefined, timeout: 5000 },
  })
  assert.throws(() => protocol.parseCli(['pane', 'wait-output', 'p1']), { code: 'usage' })
  assert.throws(() => protocol.parseCli(['pane', 'wait-output', 'p1', '--regex', '(']), { code: 'usage' })
})

test('CLI: 모르는 동작', () => {
  assert.throws(() => protocol.parseCli(['tab', 'move', 't1']), { code: 'usage' })
  assert.throws(() => protocol.parseCli(['window', 'list']), { code: 'usage' })
  assert.throws(() => protocol.parseCli(['pane', 'move', 'p1']), { code: 'usage' })
  assert.throws(() => protocol.parseCli(['pane']), { code: 'usage' })
})

test('CLI: workspace · tab (D3 확장 — delegate 가 레포마다 작업 공간)', () => {
  assert.deepEqual(protocol.parseCli(['workspace', 'list']), { op: 'workspace list', args: {} })
  assert.deepEqual(protocol.parseCli(['workspace', 'get', 'w2']), { op: 'workspace get', args: { workspace: 'w2' } })
  assert.deepEqual(protocol.parseCli(['workspace', 'create', '--label', 'web', '--cwd', '/r/web', '--no-focus']), {
    op: 'workspace create',
    args: { label: 'web', cwd: '/r/web', focus: false },
  })
  assert.throws(() => protocol.parseCli(['workspace', 'create', '--label', 'web']), { code: 'usage' })
  assert.deepEqual(protocol.parseCli(['tab', 'list']), { op: 'tab list', args: { workspace: undefined } })
  assert.deepEqual(protocol.parseCli(['tab', 'list', '--workspace', 'w2']), { op: 'tab list', args: { workspace: 'w2' } })
  assert.deepEqual(protocol.parseCli(['tab', 'get', 't3']), { op: 'tab get', args: { tab: 't3' } })
  assert.deepEqual(protocol.parseCli(['tab', 'close', 't3']), { op: 'tab close', args: { tab: 't3' } })
  assert.deepEqual(protocol.parseCli(['tab', 'rename', 't3', 'web · fe']), { op: 'tab rename', args: { tab: 't3', label: 'web · fe' } })
  assert.throws(() => protocol.parseCli(['tab', 'rename', 't3', 'a', 'b']), /남는 인자: b/)
})

test('self: pane 셸 환경 변수로 · 밖이면 빈 값', () => {
  assert.deepEqual(protocol.selfInfo({ ATHENA_STUDIO: '1', ATHENA_STUDIO_PANE_ID: 'p2', ATHENA_STUDIO_TAB_ID: 't1', ATHENA_STUDIO_WORKSPACE_ID: 'w1' }), {
    inside: true,
    backend: 'studio',
    pane_id: 'p2',
    tab_id: 't1',
    workspace_id: 'w1',
  })
  assert.deepEqual(protocol.selfInfo({ ATHENA_STUDIO_PANE_ID: 'p2' }), { inside: false, backend: 'studio', pane_id: '', tab_id: '', workspace_id: '' })
})
