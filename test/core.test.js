const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const core = require('../src/lib/core.mts')

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
  // 예전 키(studioAthenaAsked · homeAthenaAsked)는 읽으면서 버린다
  core.saveConfig(file, { athenaDir: '/a/b', studioAthenaAsked: true, homeAthenaAsked: true })
  assert.equal('studioAthenaAsked' in core.loadConfig(file), false)
  assert.equal('homeAthenaAsked' in core.loadConfig(file), false)
  assert.equal(fs.existsSync(`${file}.tmp`), false)
  core.saveConfig(file, { athenaDir: 3, boardPort: 'x' })
  assert.deepEqual(core.loadConfig(file), core.DEFAULT_CONFIG)
  core.saveConfig(file, { boardPort: 70000 })
  assert.equal(core.loadConfig(file).boardPort, 4701)
  // 현황판 기본은 4701
  assert.equal(core.DEFAULT_CONFIG.boardPort, 4701)
})

test('같은 폴더: 심볼릭 링크를 풀어 본다 · reposRoot 는 스튜디오 집 안 본체면 홈, 아니면 ..', () => {
  const base = tmp()
  const real = path.join(base, 'real', 'athena')
  fs.mkdirSync(real, { recursive: true })
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'))
  const linked = path.join(base, 'link', 'athena')
  assert.equal(core.sameDir(linked, real), true)
  assert.equal(core.sameDir(`${real}/`, real), true)
  assert.equal(core.sameDir(real, path.join(base, 'real')), false)
  assert.equal(core.sameDir(null, real), false)
  assert.equal(core.findAthenaWorkspace([{ label: 'athena', id: 'w1', cwd: real }], linked).id, 'w1')
  // 스튜디오 집(주 본체 · 팩 본체)이면 홈, 직접 고른 폴더면 ..
  const studioRoot = path.join(base, '.athena-studio')
  fs.mkdirSync(path.join(studioRoot, 'bodies', 'acme'), { recursive: true })
  fs.symlinkSync(studioRoot, path.join(base, 'studio-link'))
  assert.equal(core.reposRootFor(path.join(studioRoot, 'core'), { studioRoot, home: '/Users/me' }), '/Users/me')
  assert.equal(core.reposRootFor(path.join(base, 'studio-link', 'bodies', 'acme'), { studioRoot, home: '/Users/me' }), '/Users/me')
  assert.equal(core.reposRootFor(real, { studioRoot, home: '/Users/me' }), '..')
  assert.equal(core.reposRootFor(`${studioRoot}-other`, { studioRoot, home: '/Users/me' }), '..')
  assert.equal(core.isInside(studioRoot, studioRoot), true)
  assert.equal(core.isInside(null, studioRoot), false)
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

test('아테나 설정: 없으면 팩 없는 최소 설정을 만들고, 있으면 건드리지 않는다', () => {
  const dir = tmp()
  const file = path.join(dir, 'athena.config.json')
  assert.equal(core.ensureAthenaConfig(dir), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { reposRoot: '..', screen: 'studio' })
  // 스튜디오 레포의 athena/ 는 reposRoot 를 홈 절대 경로로
  const other = tmp()
  core.ensureAthenaConfig(other, '/Users/me')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, 'athena.config.json'), 'utf8')), { reposRoot: '/Users/me', screen: 'studio' })
  fs.writeFileSync(file, '{"pack":"packs/acme"}')
  assert.equal(core.ensureAthenaConfig(dir), false)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"pack":"packs/acme"}')
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
  const seen = new Set(['/b/tool', '/c/tool'])
  assert.equal(core.findExecutable('tool', '/a:/b:/c', (f) => seen.has(f)), '/b/tool')
  assert.equal(core.findExecutable('tool', '/a', (f) => seen.has(f)), null)
  assert.equal(core.findExecutable('tool', '', () => true), null)
})

test('실행 파일 찾기: 실제 파일 시스템', () => {
  const dir = tmp()
  const exe = path.join(dir, 'tool')
  fs.writeFileSync(exe, '#!/bin/sh\n')
  assert.equal(core.findExecutable('tool', dir), null) // 실행 권한 없음
  fs.chmodSync(exe, 0o755)
  assert.equal(core.findExecutable('tool', dir), exe)
})

test('자식 환경: HOME 은 그대로(pane 의 claude 가 진짜 홈의 로그인 · 키체인을 쓴다) · 격리용 ATHENA_STUDIO_HOME 은 넘기지 않는다', () => {
  const base = { HOME: '/Users/me', ATHENA_STUDIO_HOME: '/tmp/iso', PATH: '/usr/bin' }
  for (const env of [core.childEnv(base), core.terminalEnv(base)]) {
    assert.equal(env.HOME, '/Users/me')
    assert.equal('ATHENA_STUDIO_HOME' in env, false)
  }
})

test('자식 환경: ELECTRON_RUN_AS_NODE 는 물려주지 않는다', () => {
  const env = core.childEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: '1', HOME: '/h' }, { A: 'b' })
  assert.deepEqual(env, { PATH: '/x', HOME: '/h', A: 'b' })
})

test('터미널 환경: TERM · COLORTERM', () => {
  const env = core.terminalEnv({ PATH: '/x', TERM: 'dumb' })
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.COLORTERM, 'truecolor')
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

test('에이전트: 깔린 것 찾기 · 묻지 않고 claude 먼저 · 없으면 첫 번째 · 없으면 none', () => {
  const seen = new Set(['/a/claude', '/b/codex'])
  assert.deepEqual(core.availableAgents('/a:/b', (f) => seen.has(f)), ['claude', 'codex'])
  assert.deepEqual(core.availableAgents('/b', (f) => seen.has(f)), ['codex'])
  assert.deepEqual(core.agentDecision(['claude', 'codex']), { agent: 'claude' })
  assert.deepEqual(core.agentDecision(['codex']), { agent: 'codex' })
  assert.deepEqual(core.agentDecision([]), { none: true })
})

test('athena 작업 공간: 이름이 athena 이고 지금 아테나 폴더인 것', () => {
  const dir = '/Users/me/Library/Application Support/Athena Studio/athena'
  assert.equal(core.findAthenaWorkspace([{ label: 'web', id: 'w1', cwd: dir }], dir), null)
  assert.equal(core.findAthenaWorkspace([{ label: '~', cwd: '/Users/me' }, { label: 'athena', id: 'w4', cwd: dir }], dir).id, 'w4')
  // 다른 아테나 폴더의 athena 작업 공간은 고르지 않는다
  assert.equal(core.findAthenaWorkspace([{ label: 'athena', id: 'w2', cwd: '/Users/me/athena' }], dir), null)
  assert.equal(core.findAthenaWorkspace(undefined, dir), null)
})

test('링크 열 곳: localhost 는 옆 브라우저, 그 밖 http(s) 는 기본 브라우저, 나머지는 막기 · 주소창', () => {
  assert.equal(core.openTarget('http://localhost:4701/plans/a/plan.html'), 'panel')
  assert.equal(core.openTarget('http://127.0.0.1:3000/'), 'panel')
  assert.equal(core.openTarget('http://[::1]:5173/'), 'panel')
  assert.equal(core.openTarget('https://github.com/novum-lab-kr'), 'external')
  assert.equal(core.openTarget('file:///etc/passwd'), 'deny')
  assert.equal(core.openTarget('javascript:alert(1)'), 'deny')
  assert.equal(core.openTarget('not a url'), 'deny')
  // 주소창
  assert.equal(core.normalizeAddress('localhost:3000/login'), 'http://localhost:3000/login')
  assert.equal(core.normalizeAddress('127.0.0.1:4701'), 'http://127.0.0.1:4701')
  assert.equal(core.normalizeAddress('example.com/a'), 'https://example.com/a')
  assert.equal(core.normalizeAddress('http://localhost:4701/'), 'http://localhost:4701/')
  assert.equal(core.normalizeAddress('file:///etc/passwd'), null)
  assert.equal(core.normalizeAddress('  '), null)
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
  // 접속 파일 자리를 따로 주면(ATHENA_STUDIO_ENDPOINT) 그 자리 — 격리 실행이 사용자 앱 것을 덮지 않게
  assert.equal(core.daemonPaths({ userData: exact, home: '/h', tmpdir: '/t', uid: 1, endpoint: '/x/daemon.json' }).endpoint, '/x/daemon.json')
  assert.equal(core.daemonPaths({ userData: exact, home: '/h', tmpdir: '/t', uid: 1 }).endpoint, '/h/.athena-studio/daemon.json')
  assert.equal(core.daemonPaths({ userData: `${exact}a`, home: '/h', tmpdir: '/t', uid: 1 }).socket, '/t/athena-studio-1/daemon.sock')
  // 개발 앱은 대체 자리도 따로(배포판과 소켓을 같이 쓰지 않게)
  assert.equal(core.daemonPaths({ userData: `${exact}a`, home: '/h', tmpdir: '/t', uid: 1, socketTag: '-dev' }).socket, '/t/athena-studio-1-dev/daemon.sock')
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
  // 스튜디오가 만들지 않은 설정(screen 없음)과 설정이 없는 폴더는 건드리지 않는다
  const foreignDir = tmp()
  fs.writeFileSync(path.join(foreignDir, 'athena.config.json'), '{"pack":"packs/acme"}')
  assert.equal(core.setAthenaBoardPort(foreignDir, 4702), false)
  assert.equal(fs.readFileSync(path.join(foreignDir, 'athena.config.json'), 'utf8'), '{"pack":"packs/acme"}')
  assert.equal(core.setAthenaBoardPort(tmp(), 4702), false)
  // 깨진 설정은 숨기지 않는다(앱 설정만 바뀌어 포트가 어긋나지 않게)
  const broken = tmp()
  fs.writeFileSync(path.join(broken, 'athena.config.json'), '{ 깨짐')
  assert.throws(() => core.setAthenaBoardPort(broken, 4702))
})

test('창마다 팩: 켤 때 열 본체 목록 · 예전 설정(athenaDir 하나) · 중복 빼기 · 저장', () => {
  assert.deepEqual(core.windowDirs({ athenaDir: '/a' }), ['/a'])
  assert.deepEqual(core.windowDirs({ athenaDir: null }), [])
  assert.deepEqual(core.windowDirs({ athenaDir: '/a', windows: [{ athenaDir: '/b' }, { athenaDir: '/c' }, { athenaDir: '/b' }, null, { athenaDir: 3 }] }), ['/b', '/c'])
  assert.deepEqual(core.windowDirs({ athenaDir: '/a', windows: [] }), ['/a']) // 빈 목록이면 예전 값
  assert.deepEqual(core.windowDirs({ windows: [{ athenaDir: '/x/' }, { athenaDir: '/x' }] }, (left, right) => left.replace(/\/$/, '') === right.replace(/\/$/, '')), ['/x/'])
  assert.deepEqual(core.withWindows({ language: 'ko', athenaDir: '/old' }, ['/b', '/c']), { language: 'ko', athenaDir: '/b', windows: [{ athenaDir: '/b' }, { athenaDir: '/c' }] })
  assert.deepEqual(core.withWindows({ athenaDir: '/old' }, []), { athenaDir: '/old', windows: [] })
})


test('isConsoleSent: 옆 브라우저의 결정 콘솔이 같은 현황판 /api/action 에 POST 200 일 때만', () => {
  const page = 'http://localhost:4804/plans/setup/20261019-a.html?token=x'
  const sent = { method: 'POST', url: 'http://localhost:4804/api/action', statusCode: 200, pageUrl: page }
  assert.equal(core.isConsoleSent(sent), true)
  assert.equal(core.isConsoleSent({ ...sent, statusCode: 400 }), false) // 못 보냄 — [프롬프트로 복사] 를 봐야 한다
  assert.equal(core.isConsoleSent({ ...sent, method: 'GET' }), false)
  assert.equal(core.isConsoleSent({ ...sent, url: 'http://localhost:4804/api/move' }), false)
  assert.equal(core.isConsoleSent({ ...sent, url: 'http://localhost:4700/api/action' }), false) // 다른 현황판
  assert.equal(core.isConsoleSent({ ...sent, pageUrl: 'http://localhost:4804/' }), false) // 현황판 화면 자체
  assert.equal(core.isConsoleSent({ ...sent, url: 'https://example.com/api/action', pageUrl: 'https://example.com/plans/a.html' }), false)
  assert.equal(core.isConsoleSent({ ...sent, pageUrl: 'not a url' }), false)
})

test('claude 화면이 비어 있나 — 질문 · 고르기 창 · 쓰다 만 글이면 아니다', () => {
  const rule = '─'.repeat(40)
  const status = '  📁 core  🌿 HEAD\n  ⏵⏵ auto mode on (shift+tab to cycle)'
  assert.equal(core.claudeAtEmptyPrompt(`⏺ 네\n${rule}\n❯ \n${rule}\n${status}`), true)
  assert.equal(core.claudeAtEmptyPrompt(`${rule}\n❯ Try "fix typecheck errors"\n${rule}\n${status}`), true)
  assert.equal(core.claudeAtEmptyPrompt(`${rule}\n❯ 새 브랜치로 만들어줘\n${rule}\n${status}`), false)
  assert.equal(core.claudeAtEmptyPrompt(`☐ 다이어그램\n❯ 1. 나중에\n  2. 지금 그린다\n  3. Type something.\nEnter to select · ↑/↓ to navigate · Esc to cancel`), false)
  assert.equal(core.claudeAtEmptyPrompt('➜  demo git:(main)'), false)
  assert.equal(core.claudeAtEmptyPrompt(`${rule}\n❯ \n${rule}\n${status}\n  ⏺ main\n  ◯ general-purpose  지식 채우기 재개   4s · ↓ 85.7k tokens`), false)
})

test('다시 켜기 환경: childEnv 로 걷어 내고 켤 때 읽는 값(스튜디오 집 · 접속 파일 · 가짜 팩)만 다시 싣는다', () => {
  const base = { PATH: '/bin', HOME: '/h', CLAUDECODE: '1', ATHENA_AGENT: 'x', ELECTRON_RUN_AS_NODE: '1', ATHENA_STUDIO: '1', ATHENA_STUDIO_SOCKET: '/s', ATHENA_STUDIO_PANE_ID: 'p1', ATHENA_STUDIO_APP_UPDATE: 'install-failed', ATHENA_STUDIO_HOME: '/tmp/iso', ATHENA_STUDIO_ENDPOINT: '/tmp/iso/d.json', ATHENA_STUDIO_FAKE_PACK: '1' }
  const env = core.relaunchEnv(base)
  assert.deepEqual(
    Object.keys(env).sort(),
    ['ATHENA_STUDIO_ENDPOINT', 'ATHENA_STUDIO_FAKE_PACK', 'ATHENA_STUDIO_HOME', 'HOME', 'PATH'],
  )
  assert.equal(env.ATHENA_STUDIO_HOME, '/tmp/iso')
  assert.equal(core.relaunchEnv({ PATH: '/bin' }, { electronAsNode: true }).ELECTRON_RUN_AS_NODE, '1')
  assert.equal('ATHENA_STUDIO_HOME' in core.relaunchEnv({ PATH: '/bin', ATHENA_STUDIO_HOME: '' }), false)
})

