// 프로세스 종료 보호 훅(athena/scripts/hooks/process-guard.py) — GH #133. 실제 명령은 실행하지 않고 훅에 JSON 만 넣는다.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'athena', 'scripts', 'hooks', 'process-guard.py');

function run(command) {
  return spawnSync('python3', [HOOK], { input: JSON.stringify({ tool_input: { command }, cwd: __dirname }), encoding: 'utf8' });
}

const BLOCKED = [
  'pkill -f "cat" -U $(id -u) -x',
  'pkill node',
  'sudo pkill -9 node',
  '/usr/bin/pkill foo',
  'killall Electron',
  'kill -1',
  'kill -9 -1',
  'kill 0',
  'kill -TERM 0',
  'kill -- -1234',
  'kill -9 -- -1234',
  'kill -TERM -1234',
  'pgrep -f foo | xargs kill',
  'pgrep foo | xargs kill -9',
  'pgrep foo | xargs -n 1 kill',
  'pgrep foo | xargs -I {} kill {}',
  'pgrep foo | xargs -P4 -n1 kill -9',
  'ps -axo pid=,comm= | grep Foo | xargs -- kill',
  'echo ok # 설명\npkill foo',
  'echo "#" && pkill foo',
  'echo foo\\ #bar; pkill foo',
  'kill $(pgrep -f foo)',
  'kill -9 `pgrep foo`',
  'sh -c "pkill foo"',
  'bash -lc "echo hi; killall foo"',
  'echo start && pkill foo',
  'FOO=1 env pkill foo',
  'echo $(pkill foo)',
];

const ALLOWED = [
  'kill 12345',
  'kill -TERM 12345',
  'kill -9 12345 12346',
  'kill -0 12345',
  'kill -s TERM 12345',
  'ps -axo pid=,comm=',
  'pgrep foo',
  'echo "pkill"',
  "echo 'kill 0'",
  'grep pkill notes.md',
  'git commit -m "docs: pkill 금지"',
  'echo 123 | xargs kill',
  'ls # pkill foo',
  'echo ok # 설명; pkill foo',
  'echo ok # $(pkill foo) | xargs kill',
  'echo ${#PATH} 12',
  'echo 123 | xargs -n 1 kill',
];

for (const command of BLOCKED) {
  test(`막는다: ${command}`, () => {
    const result = run(command);
    assert.strictEqual(result.status, 2, result.stderr);
    assert.match(result.stderr, /kill <pid>/);
  });
}

for (const command of ALLOWED) {
  test(`통과: ${command}`, () => {
    const result = run(command);
    assert.strictEqual(result.status, 0, result.stderr);
  });
}

test('빈 명령 · 깨진 입력은 통과', () => {
  assert.strictEqual(run('').status, 0);
  assert.strictEqual(spawnSync('python3', [HOOK], { input: 'not json', encoding: 'utf8' }).status, 0);
});
