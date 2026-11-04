const test = require('node:test')
const assert = require('node:assert/strict')
const feed = require('../src/lib/agent-feed.mts')

test('기록 한 줄 → 이벤트: 도구 · 말 · 사용자 지시(시스템 메시지는 뺀다)', () => {
  const tool = {
    type: 'assistant',
    timestamp: '2026-10-17T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: '테스트 돌리기' } }, { type: 'text', text: '확인할게요\n다음' }] },
  }
  assert.deepEqual(feed.eventsFromRecord(tool), [
    { kind: 'tool', icon: '⚙', name: 'Bash', text: '테스트 돌리기', at: '2026-10-17T12:00:00.000Z' },
    { kind: 'say', icon: '💬', name: '', text: '확인할게요 다음', at: '2026-10-17T12:00:00.000Z' },
  ])
  assert.equal(feed.eventsFromRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.js' } }] } })[0].text, '/a/b.js')
  assert.equal(feed.eventsFromRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Zap', input: { q: 1 } }] } })[0].icon, '•')
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', message: { content: '  버그 고쳐줘 ' } }).map((event) => event.text), ['버그 고쳐줘'])
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }), [])
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', isMeta: true, message: { content: '메타' } }), [])
  // 도구 결과(사용자 쪽 목록)와 짧은 말 · 이상한 값은 건너뛴다
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', message: { content: [{ type: 'tool_result', content: '...' }] } }), [])
  assert.deepEqual(feed.eventsFromRecord({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }), [])
  assert.deepEqual(feed.eventsFromRecord(null), [])
  // 요청 본문 기록은 같은 content 를 담아도 건너뛴다
  assert.deepEqual(feed.eventsFromRecord({ type: 'api-request-blob', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }), [])
})

test('세션 이름표 · 줄 읽기 · 폴더 이름', () => {
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/athena/.worktrees/web/feature-x/src', gitBranch: 'feature/x' }), 'web·feature/x')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/novum-lab/athena-studio', gitBranch: 'main' }), 'athena-studio·main')
  // 여러 팩 구조 — 워크트리는 스튜디오 집 데이터 폴더(packs/<팩>/worktrees/<레포>/<슬러그>) · 하위 폴더에서 연 세션도 같은 레포
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/data/packs/novum-lab/worktrees/athena-studio/feat-modern-code-rules', gitBranch: 'feat/modern-code-rules' }), 'athena-studio·feat/modern-code-rules')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/data/packs/novum-lab/worktrees/athena-studio/feat-modern-code-rules/src/lib', gitBranch: 'feat/modern-code-rules' }), 'athena-studio·feat/modern-code-rules')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/bodies/new-20261025-184407', gitBranch: 'main' }), 'athena·main')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/bodies/new-20261025-184407/scripts', gitBranch: 'main' }), 'athena·main')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/bodies/new-20261025-184407' }), 'athena·athena')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/bodies/new-1/.worktrees/web/x/src', gitBranch: 'x' }), 'web·x')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/bodies/new-1/.worktrees/web/x/src' }), 'web·src')
  assert.equal(feed.sessionLabel({}), null)
  assert.deepEqual(feed.subagentInfo({ description: 'Fill skeleton: web', agentType: 'general-purpose', finished: true }), { label: '🤖 Fill skeleton: web', finished: true })
  assert.deepEqual(feed.subagentInfo({ agentType: 'reviewer' }), { label: '🤖 reviewer', finished: false })
  assert.deepEqual(feed.subagentInfo(null), { label: null, finished: false })
  assert.equal(feed.parseLine('{"a":1}').a, 1)
  assert.equal(feed.parseLine('{깨짐'), null)
  assert.equal(feed.projectDirName('/Users/me/Library/Application Support/Athena Studio/athena'), '-Users-me-Library-Application-Support-Athena-Studio-athena')
})

test('GitHub 이슈 감시 → 모니터 이벤트: 처음 본 것만 · 오래된 것 · 이상한 칸은 빼고', () => {
  const seen = new Set()
  const since = Date.parse('2026-10-28T10:00:00Z')
  const issues = [
    { repo: 'athena-studio', number: 101, title: '팩\n만들기 버그', issue: 'issues/x.md', at: '2026-10-28T12:00:00Z' },
    { repo: 'athena-studio', number: 90, title: '옛 이슈', issue: 'issues/y.md', at: '2026-10-28T08:00:00Z' },
    { repo: 'athena-studio', number: 'x', title: '깨짐', at: '2026-10-28T12:00:00Z' },
    null,
  ]
  assert.deepEqual(feed.githubIssueEvents(issues, seen, since), [
    { kind: 'say', icon: '📥', name: 'GitHub', text: '팩 만들기 버그', at: '2026-10-28T12:00:00Z', github: { repo: 'athena-studio', number: 101, title: '팩 만들기 버그' } },
  ])
  // 오래된 것도 본 것으로 기억 — 다음에 다시 보여 주지 않는다
  assert.deepEqual([...seen].sort(), ['athena-studio#101', 'athena-studio#90'])
  assert.deepEqual(feed.githubIssueEvents(issues, seen, since), [])
  assert.deepEqual(feed.githubIssueEvents(null, seen, since), [])
})

test('모델 — assistant 줄의 message.model 만 · 짧은 이름', () => {
  assert.equal(feed.modelOf({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } }), 'claude-sonnet-5-5')
  assert.equal(feed.modelOf({ type: 'assistant', message: { model: '<synthetic>' } }), null)
  assert.equal(feed.modelOf({ type: 'user', message: { model: 'claude-opus-5-5' } }), null)
  assert.equal(feed.modelOf({ type: 'assistant', message: {} }), null)
  assert.equal(feed.modelOf(null), null)
  assert.equal(feed.modelShortName('claude-sonnet-5-5'), 'Sonnet 5.5')
  assert.equal(feed.modelShortName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(feed.modelShortName('claude-opus-4-1-20250805'), 'Opus 4.1')
  assert.equal(feed.modelShortName('claude-sonnet-4-20250514'), 'Sonnet 4')
  assert.equal(feed.modelShortName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5')
  // 모르는 모양은 지어내지 않고 그대로
  assert.equal(feed.modelShortName('gpt-x'), 'gpt-x')
  assert.equal(feed.modelShortName(null), null)
})

test('모델 — assistant 줄의 이벤트에만 짧은 이름이 붙는다', () => {
  const record = { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } }, { type: 'text', text: '읽었어요' }] } }
  assert.deepEqual(feed.eventsFromRecord(record).map((event) => event.model), ['Sonnet 5.5', 'Sonnet 5.5'])
  assert.equal('model' in feed.eventsFromRecord({ type: 'assistant', message: { content: [{ type: 'text', text: '모델 없음' }] } })[0], false)
  assert.equal('model' in feed.eventsFromRecord({ type: 'user', message: { content: '지시' } })[0], false)
})

// 앱과 Python은 같은 가짜 기록·팩 범위 fixture로 판정이 같은지 확인한다.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const logs = require('../src/main/monitor-logs.mts')
const codexFixture = require('../athena/test/fixtures/codex-monitor.json')

test('Codex 기록 → 기존 한 줄 이벤트 · 앱과 Python 정규화 일치', () => {
  const records = codexFixture.records
  assert.equal(feed.sessionLabel(records[0]), 'shop·fix/monitor')
  const events = records.flatMap(feed.eventsFromRecord)
  assert.deepEqual(events.map(({ kind, name, text }) => ({ kind, name, text })), [
    { kind: 'tool', name: 'Bash', text: 'git status --short' },
    { kind: 'tool', name: 'Bash', text: '상태 확인' },
    { kind: 'tool', name: 'Exec', text: '수정 확인' },
    { kind: 'tool', name: 'apply_patch', text: 'Update demo.py' },
    { kind: 'user', name: '', text: '모니터를 고쳐 주세요' },
    { kind: 'say', name: '', text: '수정을 확인했습니다' },
  ])
  assert.equal(events[0].at, '2026-11-03T01:00:00Z')
  const result = spawnSync('python3', ['-c', `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('monitor',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
f=json.load(sys.stdin)
print(json.dumps({'records':[m.codex_message(r) for r in f['records']], 'scope':[m.codex_session_matches(v['cwd'],v['body'],v['worktrees'],v['active']) for v in f['scope']]}))
`, path.join(__dirname, '../athena/scripts/agent-monitor.py')], { input: JSON.stringify(codexFixture), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const python = JSON.parse(result.stdout)
  assert.deepEqual(records.map(feed.codexRecord), python.records)
  for (const [index, value] of codexFixture.scope.entries()) {
    assert.equal(feed.codexSessionMatches(value.cwd, value.body, value.worktrees, value.active), value.expectedApp)
    assert.equal(python.scope[index], value.expectedPython)
  }
})

test('앱 모니터: Codex 팩 분리·활성 pane·120분·메타데이터·이어 읽기', async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-test-')))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const projectsDir = path.join(tmp, '.claude/projects')
  const codexSessionsDir = path.join(tmp, '.codex/sessions')
  const body = path.join(tmp, 'body')
  const worktrees = path.join(tmp, 'packs/demo/worktrees')
  fs.mkdirSync(body)
  fs.mkdirSync(worktrees, { recursive: true })
  fs.symlinkSync(worktrees, path.join(body, '.worktrees'))
  const now = Date.now()
  const make = (name, cwd, options = {}) => {
    const file = path.join(codexSessionsDir, '2026/11/03', `rollout-${name}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const meta = { type: 'session_meta', payload: { id: name, cwd, git: { branch: 'fix/monitor' }, padding: options.large ? 'x'.repeat(70000) : '' } }
    fs.writeFileSync(file, JSON.stringify(meta)+'\n'+JSON.stringify(codexFixture.records[1])+'\n')
    fs.utimesSync(file, new Date(now-(options.age || 0)), new Date(now-(options.age || 0)))
    return file
  }
  const active = make('active', path.join(worktrees, 'shop/fix'), { large: true })
  const other = make('other', path.join(tmp, 'packs/other/worktrees/shop/fix'))
  const old = make('old', path.join(worktrees, 'shop/old'), { age: 121*60000 })
  const lead = make('lead', body)
  const ordinary = path.join(tmp, 'plain/shop')
  const pane = make('pane', ordinary)
  const bad = make('bad', path.join(worktrees, 'shop/bad'))
  fs.writeFileSync(bad, '{unfinished')
  const claude = path.join(projectsDir, feed.projectDirName(path.join(worktrees, 'shop/fix')), 'claude.jsonl')
  fs.mkdirSync(path.dirname(claude), { recursive: true })
  fs.writeFileSync(claude, JSON.stringify({ type: 'assistant', cwd: path.join(worktrees, 'shop/fix'), gitBranch: 'fix/claude', message: { content: [{ type: 'text', text: 'Claude 유지' }] } })+'\n')
  const sub = path.join(claude.replace(/\.jsonl$/, ''), 'subagents/agent-child.jsonl')
  fs.mkdirSync(path.dirname(sub), { recursive: true })
  fs.writeFileSync(sub, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '서브에이전트 유지' }] } })+'\n')
  const counterparts = [body, ordinary].map((cwd) => {
    const file = path.join(projectsDir, feed.projectDirName(cwd), 'claude.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ cwd, type: 'assistant', message: { content: [] } })+'\n')
    return file
  })
  const otherClaude = path.join(projectsDir, feed.projectDirName(path.join(tmp, 'packs/other/worktrees/shop/fix')), 'claude.jsonl')
  fs.mkdirSync(path.dirname(otherClaude), { recursive: true })
  fs.writeFileSync(otherClaude, JSON.stringify({ type: 'assistant', message: { content: [] } })+'\n')
  const monitor = logs.newMonitor()
  monitor.agentCwds = [ordinary]
  const finder = logs.createMonitorLogs({ projectsDir, codexSessionsDir })
  const found = await finder.findMonitorLogs(monitor, true, body)
  assert.deepEqual(new Set(found.map(v => v.file)), new Set([active, pane, lead, claude, sub, ...counterparts]))
  assert.ok(!found.some(v => [other, old, bad].includes(v.file)))
  for (const [codexFile, claudeFile] of [[lead, counterparts[0]], [pane, counterparts[1]], [other, otherClaude]]) {
    assert.equal(found.some(v => v.file === codexFile), found.some(v => v.file === claudeFile))
  }
  const item = found.find(v => v.file === active)
  const events = await logs.openTail(monitor, item)
  assert.equal(logs.monitorSessions(monitor)[0].label, 'shop·fix/monitor')
  const sessionsDir = path.join(tmp, 'pane-sessions')
  fs.mkdirSync(sessionsDir)
  fs.writeFileSync(path.join(sessionsDir, 'p1.json'), JSON.stringify({ session: 'active' }))
  fs.writeFileSync(path.join(sessionsDir, 'p2.json'), JSON.stringify({ session: 'another-session' }))
  const statuses = await logs.monitorPaneStatuses([{ id: 'p1', agent: 'codex', agent_status: 'waiting' }, { id: 'p2', agent: 'claude', agent_status: 'working' }], sessionsDir)
  assert.equal(logs.monitorSessions(monitor, statuses)[0].status, 'waiting', '훅의 정확한 세션으로 입력 대기를 연결한다')
  fs.writeFileSync(path.join(sessionsDir, 'p1.json'), JSON.stringify({ session: 'new-session' }))
  const changedStatuses = await logs.monitorPaneStatuses([{ id: 'p1', agent: 'codex', agent_status: 'idle' }], sessionsDir)
  assert.equal(logs.monitorSessions(monitor, changedStatuses)[0].status, undefined, '옛 세션에 새 pane 상태를 붙이지 않는다')

  assert.equal(events[0].name, 'Bash')
  const tail = monitor.tails.get(active)
  const message = JSON.stringify(codexFixture.records[6])
  fs.appendFileSync(active, message.slice(0, -1))
  assert.deepEqual(await logs.readNewLines(tail), [])
  fs.appendFileSync(active, message.slice(-1)+'\n')
  assert.deepEqual(logs.tailEvents(monitor, tail, await logs.readNewLines(tail)).map(v => v.text), ['수정을 확인했습니다'])
  assert.deepEqual(await logs.readNewLines(tail), [])
  monitor.floor = now + 60000
  assert.deepEqual(await finder.findMonitorLogs(monitor, true, body), [])
})

test('Codex apply_patch 요약은 작업·경로만: 추가·수정·삭제·이동·잘못된 입력', () => {
  const patch = '*** Begin Patch\n*** Add File: new.txt\n+FAKE_PATCH_MARKER\n*** Update File: old.txt\n@@\n-FAKE_PATCH_MARKER\n+changed\n*** Move to: moved.txt\n*** Delete File: gone.txt\n*** End Patch'
  const call = (name, type, input) => ({ type: 'response_item', payload: { name, type, ...(type === 'custom_tool_call' ? { input } : { arguments: JSON.stringify({ patch: input }) }) } })
  for (const record of [call('apply_patch', 'custom_tool_call', patch), call('functions.apply_patch', 'function_call', patch)]) {
    const normalized = feed.codexRecord(record)
    const event = feed.eventsFromRecord(record)[0]
    assert.equal(event.text, 'Add new.txt · Update old.txt · Move moved.txt · Delete gone.txt')
    assert.equal(JSON.stringify(normalized).includes('FAKE_PATCH_MARKER'), false)
    assert.equal(event.text.includes('changed'), false)
  }
  for (const bad of ['FAKE_PATCH_MARKER', '+*** Add File: FAKE_PATCH_MARKER', null]) {
    const event = feed.eventsFromRecord(call('apply_patch', 'custom_tool_call', bad))[0]
    assert.equal(event.text, 'apply_patch')
  }
})

test('Codex 패치 종류에 맞는 Claude 도구 아이콘 · 본문 비노출 유지', () => {
  for (const [kind, icon] of [['Add', '📝'], ['Update', '✏️'], ['Delete', '✏️']]) {
    const patch = `*** Begin Patch\n*** ${kind} File: demo.txt\n+FAKE_PATCH_MARKER\n*** End Patch`
    const event = feed.eventsFromRecord({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch } })[0]
    assert.equal(event.icon, icon)
    assert.equal(event.text.includes('FAKE_PATCH_MARKER'), false)
  }
  assert.equal(feed.eventsFromRecord(codexFixture.records[1])[0].icon, '⚙')
})

test('Codex 모델: 긴 기록 시작 앞 문맥 복원 · 변경 이후 행만 변경 · 사용자 줄 제외', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-model-test-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const file = path.join(tmp, 'rollout-model.jsonl')
  const line = (value) => JSON.stringify(value)+'\n'
  fs.writeFileSync(file, line(codexFixture.records[0])+line({ type: 'turn_context', payload: { model: 'codex-model-a' } })+line({ type: 'response_item', payload: { type: 'reasoning', padding: 'x'.repeat(70000) } })+line(codexFixture.records[1]))
  const monitor = logs.newMonitor()
  const initial = await logs.openTail(monitor, { file, pane: true, codex: true, stat: fs.statSync(file) })
  assert.equal(initial[0].model, 'codex-model-a')
  const tail = monitor.tails.get(file)
  const next = logs.tailEvents(monitor, tail, [line({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'codex-model-b' } } }), line(codexFixture.records[4]), line(codexFixture.records[5])])
  assert.equal(next[0].model, 'codex-model-b')
  assert.equal(next[0].icon, '✏️')
  assert.equal(next[1].model, undefined)
  assert.equal(initial[0].model, 'codex-model-a')
  const changed = logs.tailEvents(monitor, tail, [line({ type: 'turn_context', payload: { model: 'codex-model-c' } }), line(codexFixture.records[6])])
  assert.equal(changed[0].model, 'codex-model-c')
  const noModel = logs.tailEvents(monitor, tail, [line({ type: 'turn_context', payload: { model: null } }), line(codexFixture.records[1])])
  assert.equal(noModel[0].model, undefined)
  fs.writeFileSync(file, line({ type: 'turn_context', payload: { model: 'codex-model-new' } })+line(codexFixture.records[1]))
  assert.equal(logs.tailEvents(monitor, tail, await logs.readNewLines(tail))[0].model, 'codex-model-new')
})

test('모니터 만료 세션의 줄을 main·화면에서 함께 지우고 재진입 때 중복하지 않는다', async (context) => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const { installAgentMonitor } = require('../src/main/agent-monitor.mts')
  const logs = require('../src/main/monitor-logs.mts')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-monitor-expiry-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  let tick
  context.mock.method(global, 'setInterval', (callback) => { tick = callback; return 0 })
  const file = path.join(root, 'session.jsonl')
  const line = (text) => `${JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { content: [{ type: 'text', text }] } })}\n`
  fs.writeFileSync(file, line('이전 기록입니다'))
  const monitor = logs.newMonitor()
  const sent = []
  let visibleEvents = []
  const ctx = {
    athenaDir: null,
    win: { isDestroyed: () => false, isVisible: () => true },
    daemonCall: async () => ({ result: { panes: [] } }),
    boardPortNow: () => { throw new Error('이 시험에서 현황판을 부르지 않는다') },
    send: (channel, update) => {
      assert.equal(channel, 'monitor:update')
      assert.equal(update.error, undefined)
      sent.push(update)
      // 화면의 기존 reset/증분 수신 방식으로 이름표가 남는지 확인한다.
      visibleEvents = update.reset ? [...update.events] : [...visibleEvents, ...update.events]
    },
  }
  installAgentMonitor(ctx, { monitor, findMonitorLogs: async () => {
    const stat = fs.statSync(file)
    return stat.mtimeMs >= now - logs.MONITOR_MINUTES * 60000 ? [{ file, pane: true, stat, label: 'Codex' }] : []
  } })
  const settle = async () => {
    // 갱신은 진짜 파일 읽기(스레드 풀)를 기다린다 — 느린 러너에서는 setImmediate 100번으로 모자라니 실제 시간(최대 5초)으로 기다린다
    for (let attempt = 0; monitor.ticking && attempt < 500; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(monitor.ticking, false, '모니터 갱신이 끝난다')
  }
  monitor.lastGithub = now
  ctx.setMonitorWatch(true)
  context.after(() => ctx.setMonitorWatch(false))
  await settle()
  assert.deepEqual(visibleEvents.map(event => event.text), ['이전 기록입니다'])
  const oldSession = sent.at(-1).sessions[0].id
  const github = { id: ++monitor.seq, session: 'github', kind: 'say', icon: '', name: '', text: 'GitHub 이슈', at: new Date(now).toISOString(), github: { repo: 'test/repo', number: 1, title: '이슈' } }
  monitor.events.push(github)
  visibleEvents.push(github)

  now += (logs.MONITOR_MINUTES + 1) * 60000
  monitor.lastGithub = now
  await tick()
  const expired = sent.at(-1)
  const labels = new Map(expired.sessions.map(session => [session.id, session.label]))
  assert.deepEqual(visibleEvents.map(event => labels.get(event.session) ?? (event.github ? 'GitHub' : '?')), ['GitHub'], '만료 뒤 [?] 줄이 남지 않는다')
  assert.deepEqual(monitor.events, [github], 'main에도 만료 이벤트가 남지 않는다')
  assert.equal(expired.reset, true, '기존 reset으로 화면의 누적 줄도 정리한다')

  fs.appendFileSync(file, line('다시 시작합니다'))
  fs.utimesSync(file, new Date(now), new Date(now))
  now += 11000
  await tick()
  assert.notEqual(sent.at(-1).sessions[0].id, oldSession)
  assert.deepEqual(visibleEvents.map(event => event.text).sort(), ['GitHub 이슈', '다시 시작합니다', '이전 기록입니다'].sort(), '다시 읽은 backlog는 한 번씩만 나온다')
  assert.equal(visibleEvents.some(event => event.session === oldSession), false)
  await tick()
  assert.equal(visibleEvents.length, 3, '다음 갱신에도 같은 줄을 덧붙이지 않는다')
})


test('Codex functions.exec는 코드를 실행하지 않고 작업만 요약하며 Python과 일치', () => {
  const fixture = require('../athena/test/fixtures/codex-exec-monitor.json')
  for (const { label, record, summary, text } of fixture) {
    const event = feed.eventsFromRecord(record)[0]
    assert.deepEqual(event.exec, summary, label)
    assert.equal(event.text, summary.value, label)
    const { execSummaryText } = require('../src/lib/monitor-text.mts')
    const i18n = require('../src/lib/i18n.mts')
    const say = i18n.translator(require('../src/i18n/ko.json'))
    assert.equal(execSummaryText(say, event.exec), text, label)
    assert.equal(event.icon, '⚙', label)
    assert.equal(event.text.includes('PRIVATE_MARKER'), false, label)
    assert.equal(event.text.includes('tools.'), false, label)
  }
  assert.equal(globalThis.MONITOR_MUST_NOT_RUN, undefined)
  const result = spawnSync('python3', ['-c', `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('monitor',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
fixture=json.load(sys.stdin)
rows=[]
for item in fixture:
    record=m.codex_message(item['record'])
    block=record['message']['content'][0]
    rows.append({'record':record,'text':m.summarize_tool(block['name'],block['input'])})
print(json.dumps(rows))
`, path.join(__dirname, '../athena/scripts/agent-monitor.py')], { input: JSON.stringify(fixture), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const python = JSON.parse(result.stdout)
  assert.deepEqual(python.map(item => item.record), fixture.map(item => feed.codexRecord(item.record)))
  assert.deepEqual(python.map(item => item.text), fixture.map(item => item.text))
})


test('code-mode 시스템 요약은 화면 언어로, 원문 title·명령은 그대로', () => {
  const { execSummaryText } = require('../src/lib/monitor-text.mts')
  const { translator } = require('../src/lib/i18n.mts')
  const fixture = require('../athena/test/fixtures/codex-exec-monitor.json')
  const first = feed.eventsFromRecord(fixture[0].record)[0]
  const expected = { ko: '명령 실행', en: 'Run command', ja: 'コマンド実行', zh: '运行命令' }
  for (const lang of ['ko', 'en', 'ja', 'zh']) {
    const say = translator(require(`../src/i18n/${lang}.json`))
    assert.equal(execSummaryText(say, first.exec), `${expected[lang]} · git status --short`)
    const provided = feed.eventsFromRecord(fixture.find(item => item.label === '기존 title').record)[0]
    assert.equal(execSummaryText(say, provided.exec), '수정 확인', '제공된 title은 번역하지 않는다')
    for (const item of fixture) {
      const event = feed.eventsFromRecord(item.record)[0]
      const text = execSummaryText(say, event.exec)
      assert.equal(text.includes('PRIVATE_MARKER'), false)
      assert.equal(/\{(?:n|text)\}/.test(text), false)
    }
  }
  const english = translator(require('../src/i18n/en.json'))
  const batch = feed.eventsFromRecord(fixture.find(item => item.label === '여러 작업').record)[0]
  assert.equal(execSummaryText(english, batch.exec), 'Run command · git status · 1 more')
})
