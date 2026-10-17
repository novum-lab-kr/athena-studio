const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const core = require('../src/lib/core')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'athena-studio-'))

test('설정: 없거나 깨진 파일은 기본값', () => {
  const dir = tmp()
  assert.deepEqual(core.loadConfig(path.join(dir, 'none.json')), core.DEFAULT_CONFIG)
  const broken = path.join(dir, 'broken.json')
  fs.writeFileSync(broken, '{oops')
  assert.deepEqual(core.loadConfig(broken), core.DEFAULT_CONFIG)
  fs.writeFileSync(broken, '[1,2]')
  assert.deepEqual(core.loadConfig(broken), core.DEFAULT_CONFIG)
})

test('설정: 저장한 값을 다시 읽고, 이상한 포트는 기본값', () => {
  const file = path.join(tmp(), 'sub', 'config.json')
  core.saveConfig(file, { athenaDir: '/a/b', boardPort: 4711 })
  assert.deepEqual(core.loadConfig(file), { athenaDir: '/a/b', boardPort: 4711 })
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  core.saveConfig(file, { athenaDir: 3, boardPort: 'x' })
  assert.deepEqual(core.loadConfig(file), core.DEFAULT_CONFIG)
  core.saveConfig(file, { boardPort: 70000 })
  assert.equal(core.loadConfig(file).boardPort, 4700)
})

test('아테나 폴더: CLAUDE.md 와 scripts/board/server.mjs 가 있어야 한다', () => {
  const dir = tmp()
  assert.deepEqual(core.checkAthenaDir(null).ok, false)
  assert.deepEqual(core.checkAthenaDir(dir).missing, ['CLAUDE.md', path.join('scripts', 'board', 'server.mjs')])
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '')
  assert.deepEqual(core.checkAthenaDir(dir), { ok: false, missing: [path.join('scripts', 'board', 'server.mjs')] })
  // 같은 이름의 폴더는 파일로 치지 않는다
  fs.mkdirSync(path.join(dir, 'scripts', 'board', 'server.mjs'), { recursive: true })
  assert.equal(core.checkAthenaDir(dir).ok, false)
  fs.rmSync(path.join(dir, 'scripts', 'board', 'server.mjs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'scripts', 'board', 'server.mjs'), '')
  assert.deepEqual(core.checkAthenaDir(dir), { ok: true, missing: [] })
  assert.equal(core.checkAthenaDir(path.join(dir, 'nope')).ok, false)
})

test('아테나 받기: 없거나 빈 폴더는 clone, 아테나면 그대로, 다른 것이 있으면 멈춤', () => {
  const parent = tmp()
  const dir = path.join(parent, 'athena')
  assert.deepEqual(core.installTarget(parent), { dir, action: 'clone' })
  fs.mkdirSync(dir)
  assert.equal(core.installTarget(parent).action, 'clone')
  fs.writeFileSync(path.join(dir, 'notes.txt'), '')
  assert.equal(core.installTarget(parent).action, 'conflict')
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '')
  fs.mkdirSync(path.join(dir, 'scripts', 'board'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'scripts', 'board', 'server.mjs'), '')
  assert.equal(core.installTarget(parent).action, 'use')
  // athena 라는 이름의 파일이 있으면 건드리지 않는다
  const other = tmp()
  fs.writeFileSync(path.join(other, 'athena'), '')
  assert.equal(core.installTarget(other).action, 'conflict')
})

test('아테나 설정: 없으면 팩 없는 최소 설정을 만들고, 있으면 건드리지 않는다', () => {
  const dir = tmp()
  const file = path.join(dir, 'athena.config.json')
  assert.equal(core.ensureAthenaConfig(dir), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { reposRoot: '..' })
  fs.writeFileSync(file, '{"pack":"packs/acme"}')
  assert.equal(core.ensureAthenaConfig(dir), false)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"pack":"packs/acme"}')
})

test('clone 진행: \\r 로 고쳐 쓴 줄 중 마지막만', () => {
  assert.equal(core.lastProgressLine("Cloning into 'athena'...\nReceiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\r"), 'Receiving objects:  50% (5/10)')
  assert.equal(core.lastProgressLine('\r\n'), null)
})

test('로그인 셸 PATH: rc 가 찍은 글자를 버리고 표시 사이만', () => {
  const M = core.PATH_MARK
  assert.equal(core.parseMarkedPath(`welcome!\n${M}/opt/homebrew/bin:/usr/bin${M}bye`), '/opt/homebrew/bin:/usr/bin')
  assert.equal(core.parseMarkedPath('no marks'), null)
  assert.equal(core.parseMarkedPath(`${M}half`), null)
  assert.equal(core.parseMarkedPath(`${M}${M}`), null)
})

test('PATH 합치기: 로그인 PATH 가 앞, 겹치면 한 번', () => {
  assert.equal(core.mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin'), '/opt/homebrew/bin:/usr/bin:/bin')
  assert.equal(core.mergePath(null, '/usr/bin'), '/usr/bin')
})

test('실행 파일 찾기: PATH 앞쪽부터', () => {
  const seen = new Set(['/b/herdr', '/c/herdr'])
  assert.equal(core.findExecutable('herdr', '/a:/b:/c', (f) => seen.has(f)), '/b/herdr')
  assert.equal(core.findExecutable('herdr', '/a', (f) => seen.has(f)), null)
  assert.equal(core.findExecutable('herdr', '', () => true), null)
})

test('실행 파일 찾기: 실제 파일 시스템', () => {
  const dir = tmp()
  const exe = path.join(dir, 'herdr')
  fs.writeFileSync(exe, '#!/bin/sh\n')
  assert.equal(core.findExecutable('herdr', dir), null) // 실행 권한 없음
  fs.chmodSync(exe, 0o755)
  assert.equal(core.findExecutable('herdr', dir), exe)
})

test('자식 환경: HERDR_* 와 ELECTRON_RUN_AS_NODE 는 물려주지 않는다', () => {
  const env = core.childEnv({ PATH: '/x', HERDR_ENV: '1', HERDR_PANE_ID: 'p1', ELECTRON_RUN_AS_NODE: '1', HOME: '/h' }, { A: 'b' })
  assert.deepEqual(env, { PATH: '/x', HOME: '/h', A: 'b' })
})

test('터미널 환경: TERM · COLORTERM', () => {
  const env = core.terminalEnv({ PATH: '/x', TERM: 'dumb', HERDR_ENV: '1' })
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.COLORTERM, 'truecolor')
  assert.equal(env.HERDR_ENV, undefined)
  assert.equal(env.LANG, 'ko_KR.UTF-8')
  assert.equal(core.terminalEnv({ LANG: 'en_US.UTF-8' }).LANG, 'en_US.UTF-8')
})

test('자식 환경: 앱을 에이전트 세션 안에서 켜도 세션 표시는 넘기지 않는다', () => {
  const env = core.childEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ATHENA_AGENT: 'x', CLAUDE_CONFIG_DIR: '/c' })
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c' })
})

test('에이전트: 깔린 것 찾기 · 하나면 그것 · 둘이면 묻기 · 없으면 none', () => {
  const seen = new Set(['/a/claude', '/b/codex'])
  assert.deepEqual(core.availableAgents('/a:/b', (f) => seen.has(f)), ['claude', 'codex'])
  assert.deepEqual(core.availableAgents('/b', (f) => seen.has(f)), ['codex'])
  assert.deepEqual(core.agentDecision(['claude', 'codex']), { choose: ['claude', 'codex'] })
  assert.deepEqual(core.agentDecision(['codex']), { agent: 'codex' })
  assert.deepEqual(core.agentDecision([]), { none: true })
  assert.deepEqual(core.agentDecision(['claude', 'codex'], 'codex'), { agent: 'codex' })
  assert.match(core.agentDecision(['claude'], 'codex').error, /codex/)
})

test('athena 작업 공간: 이름이 athena 인 것', () => {
  assert.equal(core.findAthenaWorkspace([{ label: 'web', id: 'w1' }]), null)
  assert.equal(core.findAthenaWorkspace([{ label: '~' }, { label: 'athena', id: 'w4' }]).id, 'w4')
  assert.equal(core.findAthenaWorkspace(undefined), null)
})

test('새 창 분류: 현황판 주소는 앱 안, 그 밖 http(s) 는 브라우저, 나머지는 막기', () => {
  assert.equal(core.classifyOpen('http://localhost:4700/plans/a/plan.html', 4700), 'app')
  assert.equal(core.classifyOpen('http://127.0.0.1:4700/qa-live?id=1', 4700), 'app')
  assert.equal(core.classifyOpen('http://localhost:4701/', 4700), 'external')
  assert.equal(core.classifyOpen('https://localhost:4700/', 4700), 'external')
  assert.equal(core.classifyOpen('https://github.com/novum-lab-kr', 4700), 'external')
  assert.equal(core.classifyOpen('file:///etc/passwd', 4700), 'deny')
  assert.equal(core.classifyOpen('javascript:alert(1)', 4700), 'deny')
  assert.equal(core.classifyOpen('not a url', 4700), 'deny')
})

test('데몬 자리: 소켓은 userData, 104바이트(끝 NUL 포함)를 넘으면 tmpdir 로', () => {
  const short = core.daemonPaths({ userData: '/Users/me/Library/Application Support/Athena Studio', home: '/Users/me', tmpdir: '/tmp', uid: 501 })
  assert.deepEqual(short, {
    socket: '/Users/me/Library/Application Support/Athena Studio/daemon.sock',
    log: '/Users/me/Library/Application Support/Athena Studio/daemon.log',
    endpoint: '/Users/me/.athena-studio/daemon.json',
  })
  const longDir = `/Users/${'x'.repeat(80)}/Library/Application Support/Athena Studio`
  const long = core.daemonPaths({ userData: longDir, home: '/h', tmpdir: '/var/tmp', uid: 501 })
  assert.equal(long.socket, '/var/tmp/athena-studio-501/daemon.sock')
  assert.equal(long.log, `${longDir}/daemon.log`)
  // 경계: 103바이트까지는 그대로 — 한글처럼 여러 바이트 글자는 바이트로 센다
  const exact = '/' + 'a'.repeat(core.SOCKET_PATH_MAX - '/daemon.sock'.length - 1)
  assert.equal(core.daemonPaths({ userData: exact, home: '/h', tmpdir: '/t', uid: 1 }).socket, `${exact}/daemon.sock`)
  assert.equal(core.daemonPaths({ userData: `${exact}a`, home: '/h', tmpdir: '/t', uid: 1 }).socket, '/t/athena-studio-1/daemon.sock')
  const korean = '/' + '가'.repeat(31) // 소켓 경로가 글자로는 44개지만 바이트로는 106
  assert.equal(core.daemonPaths({ userData: korean, home: '/h', tmpdir: '/t', uid: 1 }).socket, '/t/athena-studio-1/daemon.sock')
  // 대체 자리도 길면 분명한 오류
  assert.throws(() => core.daemonPaths({ userData: longDir, home: '/h', tmpdir: `/${'t'.repeat(100)}`, uid: 1 }), /103바이트/)
})
