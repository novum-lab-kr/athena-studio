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
  assert.deepEqual(core.loadConfig(file), { athenaDir: '/a/b', boardPort: 4711, studioAthenaAsked: false })
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  core.saveConfig(file, { athenaDir: 3, boardPort: 'x' })
  assert.deepEqual(core.loadConfig(file), core.DEFAULT_CONFIG)
  core.saveConfig(file, { boardPort: 70000 })
  assert.equal(core.loadConfig(file).boardPort, 4701)
  // 현황판 기본은 4701 — herdr 용 아테나 현황판(4700)과 나란히
  assert.equal(core.DEFAULT_CONFIG.boardPort, 4701)
})

test('스튜디오 전용 아테나: 홈의 ~/athena 를 쓰고 있으면 한 번만 묻고, 받기로 하면 폴더를 비우고 예전 기본 포트를 옮긴다', () => {
  const home = '/Users/me'
  const config = { athenaDir: '/Users/me/athena', boardPort: 4700, studioAthenaAsked: false }
  assert.equal(core.shouldOfferStudioAthena(config, home), true)
  assert.equal(core.shouldOfferStudioAthena({ ...config, athenaDir: '/Users/me/athena/' }, home), true)
  assert.equal(core.shouldOfferStudioAthena({ ...config, studioAthenaAsked: true }, home), false)
  assert.equal(core.shouldOfferStudioAthena({ ...config, athenaDir: '/Users/me/work/athena' }, home), false)
  assert.equal(core.shouldOfferStudioAthena({ ...config, athenaDir: null }, home), false)
  assert.deepEqual(core.moveToStudioAthena(config), { athenaDir: null, boardPort: 4701, studioAthenaAsked: true })
  // 직접 바꾼 포트는 그대로
  assert.equal(core.moveToStudioAthena({ ...config, boardPort: 4800 }).boardPort, 4800)
})

test('같은 폴더: 심볼릭 링크를 풀어 본다 · reposRoot 는 앱 데이터 폴더 아테나면 홈, 아니면 ..', () => {
  const base = tmp()
  const real = path.join(base, 'real', 'athena')
  fs.mkdirSync(real, { recursive: true })
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'))
  const linked = path.join(base, 'link', 'athena')
  assert.equal(core.sameDir(linked, real), true)
  assert.equal(core.sameDir(`${real}/`, real), true)
  assert.equal(core.sameDir(real, path.join(base, 'real')), false)
  assert.equal(core.sameDir(null, real), false)
  // ~/athena 를 링크로 적어 두었어도 묻는다
  assert.equal(core.shouldOfferStudioAthena({ athenaDir: linked, studioAthenaAsked: false }, path.join(base, 'real')), true)
  assert.equal(core.findAthenaWorkspace([{ label: 'athena', id: 'w1', cwd: real }], linked).id, 'w1')
  const userData = path.join(base, 'App Support', 'Athena Studio')
  assert.equal(core.reposRootFor(path.join(userData, 'athena'), { userData, home: '/Users/me' }), '/Users/me')
  assert.equal(core.reposRootFor(real, { userData, home: '/Users/me' }), '..')
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

test('아테나 받기(앱 데이터 폴더): 없거나 빈 폴더는 clone, 아테나면 그대로, 다른 것이 있으면 멈춤', () => {
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
  // 앱 데이터 폴더처럼 띄어쓰기가 있는 자리에도 받는다
  const spaced = path.join(tmp(), 'Application Support', 'Athena Studio')
  assert.deepEqual(core.installTarget(spaced), { dir: path.join(spaced, 'athena'), action: 'clone' })
})

test('아테나 설정: 없으면 팩 없는 최소 설정을 만들고, 있으면 건드리지 않는다', () => {
  const dir = tmp()
  const file = path.join(dir, 'athena.config.json')
  assert.equal(core.ensureAthenaConfig(dir), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { reposRoot: '..', screen: 'studio' })
  // 앱 데이터 폴더에 받은 아테나는 reposRoot 를 홈 절대 경로로
  const other = tmp()
  core.ensureAthenaConfig(other, '/Users/me')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, 'athena.config.json'), 'utf8')), { reposRoot: '/Users/me', screen: 'studio' })
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

test('자식 환경: delegate 실행기 값 · 스튜디오 pane 표시도 넘기지 않는다(상태줄이 엉뚱한 레포를 보지 않게)', () => {
  const env = core.childEnv({
    PATH: '/bin',
    ATHENA_REPO_DIR: '/w/athena-studio',
    ATHENA_VERIFY_DIR: '/w/athena/.worktrees/x',
    ATHENA_STUDIO: '1',
    ATHENA_STUDIO_PANE_ID: 'p3',
    ATHENA_STUDIO_SOCKET: '/s',
    ATHENA_BOARD_PORT: '4700',
    ATHENA_DIR: '/w/athena',
  })
  // 아테나 설정값(ATHENA_BOARD_PORT · ATHENA_DIR)은 남긴다 — 세션 표시만 지운다
  assert.deepEqual(env, { PATH: '/bin', ATHENA_BOARD_PORT: '4700', ATHENA_DIR: '/w/athena' })
  // 새로 넣는 값은 그대로 들어간다(main 이 현황판에 소켓을 넘길 때)
  assert.equal(core.childEnv({ ATHENA_STUDIO_SOCKET: '/old' }, { ATHENA_STUDIO_SOCKET: '/new' }).ATHENA_STUDIO_SOCKET, '/new')
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

test('athena 작업 공간: 이름이 athena 이고 지금 아테나 폴더인 것', () => {
  const dir = '/Users/me/Library/Application Support/Athena Studio/athena'
  assert.equal(core.findAthenaWorkspace([{ label: 'web', id: 'w1', cwd: dir }], dir), null)
  assert.equal(core.findAthenaWorkspace([{ label: '~', cwd: '/Users/me' }, { label: 'athena', id: 'w4', cwd: dir }], dir).id, 'w4')
  // 예전 아테나 폴더(herdr 용 ~/athena)의 athena 작업 공간은 고르지 않는다
  assert.equal(core.findAthenaWorkspace([{ label: 'athena', id: 'w2', cwd: '/Users/me/athena' }], dir), null)
  assert.equal(core.findAthenaWorkspace(undefined, dir), null)
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

test('현황판 포트: 저장된 포트부터 20개 · lsof 경로 · 스튜디오 아테나 설정에만 적는다', () => {
  assert.deepEqual(core.boardPortCandidates(4701).slice(0, 3), [4701, 4702, 4703])
  assert.equal(core.boardPortCandidates(4701).length, 20)
  assert.equal(core.boardPortCandidates(65530).length, 6)
  assert.equal(core.boardPortCandidates(undefined)[0], 4701)
  assert.equal(core.parseLsofPath('p123\nfcwd\nn/Users/me/Library/Application Support/Athena Studio/athena\n'), '/Users/me/Library/Application Support/Athena Studio/athena')
  assert.equal(core.parseLsofPath(''), null)
  const studioDir = tmp()
  core.ensureAthenaConfig(studioDir, '/Users/me')
  assert.equal(core.setAthenaBoardPort(studioDir, 4702), true)
  assert.equal(core.setAthenaBoardPort(studioDir, 4702), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(studioDir, 'athena.config.json'), 'utf8')), { reposRoot: '/Users/me', screen: 'studio', boardPort: 4702 })
  // herdr 용 설정(screen 없음)과 설정이 없는 폴더는 건드리지 않는다
  const herdrDir = tmp()
  fs.writeFileSync(path.join(herdrDir, 'athena.config.json'), '{"pack":"packs/acme"}')
  assert.equal(core.setAthenaBoardPort(herdrDir, 4702), false)
  assert.equal(fs.readFileSync(path.join(herdrDir, 'athena.config.json'), 'utf8'), '{"pack":"packs/acme"}')
  assert.equal(core.setAthenaBoardPort(tmp(), 4702), false)
  // 깨진 설정은 숨기지 않는다(앱 설정만 바뀌어 포트가 어긋나지 않게)
  const broken = tmp()
  fs.writeFileSync(path.join(broken, 'athena.config.json'), '{ 깨짐')
  assert.throws(() => core.setAthenaBoardPort(broken, 4702))
})
