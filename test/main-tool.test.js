const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const core = require('../src/lib/core.mts')
const { toolDecision } = require('../athena/scripts/lib/main-tool.mjs')

test('가짜 PATH: Claude만 · Codex만 · 둘 다 · 없음, 인증 실패와 출력 폐기', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-tool-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const installed of [[], ['claude'], ['codex'], ['claude', 'codex']]) {
    const bin = fs.mkdtempSync(path.join(root, 'bin-'))
    const log = path.join(bin, 'calls')
    for (const tool of installed) fs.writeFileSync(path.join(bin, tool),
      `#!/bin/sh
printf '%s %s\\n' "$1" "$2" >> '${log}'
echo SECRET_AUTH_OUTPUT
echo SECRET_AUTH_OUTPUT >&2
exit 0
`, { mode: 0o755 })
    const env = { ...process.env, PATH: bin }
    assert.deepEqual(await core.authenticatedAgents(env), installed)
    const d = core.agentDecision(installed)
    assert.deepEqual(d, installed.length === 2 ? { choose: true } : installed.length ? { agent: installed[0] } : { none: true })
    if (installed.length) {
      assert.equal(fs.readFileSync(log, 'utf8'), installed.map((tool) => tool === 'claude' ? 'auth status\n' : 'login status\n').join(''))
      for (const tool of installed) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      assert.deepEqual(await core.authenticatedAgents(env), [])
    }
  }
})

test('주 도구 기억 · 사용할 수 없는 기억 무시 · 부 도구는 인증된 다른 하나만', () => {
  assert.deepEqual(toolDecision(['claude', 'codex'], 'codex'), { main: 'codex', secondary: 'claude', choose: false })
  assert.deepEqual(toolDecision(['codex'], 'claude'), { main: 'codex', secondary: null, choose: false })
  assert.deepEqual(toolDecision([], 'claude'), { main: null, secondary: null, choose: false })
})

test('양쪽 SessionStart가 리드만 기록하고 재개도 갱신한다', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'main-hook-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.cpSync(path.resolve('athena/scripts/hooks/setup-check.py'), path.join(root, 'scripts/hooks/setup-check.py'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'scripts/lib/athena_config.py'), 'def needs_first_run(root): return False\ndef load(root): return {"repos": []}\n')
  const run = (tool, payload = {}, extra = {}) => {
    const result = spawnSync('python3', [path.join(root, 'scripts/hooks/setup-check.py'), '--tool', tool], {
      input: JSON.stringify({ cwd: root, source: 'resume', ...payload }), encoding: 'utf8',
      env: { ...process.env, ATHENA_AGENT: '', ...extra },
    })
    assert.equal(result.status, 0)
  }
  assert.equal(core.readMainTool(root), null)
  for (const tool of ['claude', 'codex']) {
    run(tool)
    assert.equal(core.readMainTool(root), tool)
  }
  run('claude', { agent_type: 'worker' })
  run('claude', { cwd: os.tmpdir() })
  run('claude', {}, { ATHENA_AGENT: 'worker' })
  assert.equal(core.readMainTool(root), 'codex')
  core.writeMainTool(root, 'claude')
  assert.equal(core.readMainTool(root), 'claude')
  fs.writeFileSync(path.join(root, '.athena-main-tool.json'), '{broken')
  assert.equal(core.readMainTool(root), null)
})
