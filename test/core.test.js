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

test('작업 창 명령: herdr 가 있으면 herdr, 없으면 로그인 셸 + 안내', () => {
  assert.deepEqual(core.terminalLaunch({ herdrPath: '/b/herdr', shell: '/bin/zsh' }), { file: '/b/herdr', args: [], notice: null })
  const fallback = core.terminalLaunch({ herdrPath: null, shell: '/bin/bash' })
  assert.equal(fallback.file, '/bin/bash')
  assert.deepEqual(fallback.args, ['-l'])
  assert.match(fallback.notice, /herdr 를 찾지 못했어요/)
  assert.equal(core.terminalLaunch({ herdrPath: null }).file, '/bin/zsh')
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
