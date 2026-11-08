// 서버 추가 팝업의 ~/.ssh/config 쓰기(src/lib/ssh-config.mts) — 칸 검사(config 줄 주입 막기 · 포트 · 별칭 겹침) · 블록 모양 · 덧붙이기 · 새로 만들 때 권한
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ssh = require('../src/lib/ssh-config.mts')

const GOOD = { alias: 'web-prod', user: 'ubuntu', host: '203.0.113.10', port: '22', key: '~/.ssh/id_ed25519' }
const ENTRY = { alias: 'web-prod', user: 'ubuntu', host: '203.0.113.10', port: 22, key: '~/.ssh/id_ed25519' }
const problemOf = (patch, taken = []) => {
  const result = ssh.checkHost({ ...GOOD, ...patch }, taken)
  return result.ok ? null : result.problems
}

test('칸 검사: 좋은 값은 통과하고 앞뒤 공백은 걷는다', () => {
  const result = ssh.checkHost({ alias: ' web-prod ', user: 'ubuntu ', host: ' 203.0.113.10', port: ' 22 ', key: ' ~/.ssh/id_ed25519 ' }, [])
  assert.deepEqual(result, { ok: true, entry: ENTRY })
  assert.equal(ssh.checkHost({ ...GOOD, host: 'example.com' }, []).ok, true)
  assert.equal(ssh.checkHost({ ...GOOD, host: '2001:db8::10' }, []).ok, true)
  assert.equal(ssh.checkHost({ ...GOOD, key: '/Users/me/keys/deploy key' }, []).ok, true)
})

test('칸 검사: 빈 칸은 empty', () => {
  assert.deepEqual(ssh.checkHost({ alias: '', user: ' ', host: '', port: '', key: '' }, []), { ok: false, problems: { alias: 'empty', user: 'empty', host: 'empty', port: 'empty', key: 'empty' } })
})

test("칸 검사: config 줄 주입(공백 · 줄바꿈 · # · = · 따옴표 · 앞의 - · 키의 ' · 끝 \\)을 막는다", () => {
  for (const alias of ['web prod', 'web\nHost *', 'web#x', 'a=b', '"web"', '-oProxyCommand=x', 'web*', 'we%b']) assert.deepEqual(problemOf({ alias }), { alias: 'bad' }, alias)
  for (const user of ['ub untu', 'root\n  ProxyCommand sh', 'u#1', '-l', 'u"x']) assert.deepEqual(problemOf({ user }), { user: 'bad' }, user)
  for (const host of ['203.0.113.10 -p', '203.0.113.10\nProxyCommand x', 'h#x', '-oProxyCommand=x', 'host/1', 'a_b.com', '%h']) assert.deepEqual(problemOf({ host }), { host: 'bad' }, host)
  for (const key of ['~/.ssh/id\n  ProxyCommand x', '~/.ssh/id#1', '~/.ssh/%u', '~/.ssh/"id"', "~/.ssh/id'; touch x; '", '~/.ssh/id\\', `~/${'a'.repeat(1030)}`]) assert.deepEqual(problemOf({ key }), { key: 'bad' }, key)
  assert.deepEqual(problemOf({ key: '.ssh/id_rsa' }), { key: 'path' })
})

test('칸 검사: 포트는 1~65535 숫자만', () => {
  for (const port of ['0', '65536', '99999', 'abc', '22a', '-1', '2 2', '123456']) assert.deepEqual(problemOf({ port }), { port: 'range' }, port)
  for (const port of ['1', '2222', '65535']) assert.equal(problemOf({ port }), null, port)
})

test('칸 검사: 이미 있는 별칭은 대소문자 없이 taken', () => {
  assert.deepEqual(problemOf({}, ['Web-Prod']), { alias: 'taken' })
  assert.deepEqual(problemOf({ alias: 'WEB-PROD' }, ['web-prod']), { alias: 'taken' })
  assert.equal(problemOf({}, ['web-prod2']), null)
})

test('블록: Host · HostName · User · Port · IdentityFile(공백이면 따옴표) · IdentitiesOnly', () => {
  assert.equal(ssh.hostBlock(ENTRY, '2026-11-08'), '# Athena Studio · 2026-11-08\nHost web-prod\n  HostName 203.0.113.10\n  User ubuntu\n  Port 22\n  IdentityFile ~/.ssh/id_ed25519\n  IdentitiesOnly yes\n')
  assert.match(ssh.hostBlock({ ...ENTRY, key: '/Users/me/my keys/id' }, 'd'), /\n {2}IdentityFile "\/Users\/me\/my keys\/id"\n/)
})

test('덧붙이기 글: 기존 글은 그대로 · 사이에 빈 줄 하나', () => {
  assert.equal(ssh.appendedText('', 'B\n'), 'B\n')
  assert.equal(ssh.appendedText('Host a\n', 'B\n'), 'Host a\n\nB\n')
  assert.equal(ssh.appendedText('Host a', 'B\n'), 'Host a\n\nB\n')
})

test('config 별칭: Host 줄의 이름(여러 개 · = · 따옴표) · 패턴 · 주석 뺌', () => {
  const text = ['Host *', '  ServerAliveInterval 30', 'Host alpha beta', 'host=gamma', '# Host hidden', 'Host "delta" !bad web-?', 'Match host x', '  HostName example.com'].join('\n')
  assert.deepEqual(ssh.configAliases(text), ['alpha', 'beta', 'gamma', 'delta'])
})

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-config-test-'))

test('쓰기: ~/.ssh · config 가 없으면 700 · 600 으로 새로 만든다', () => {
  const home = tempHome()
  try {
    const dir = path.join(home, '.ssh')
    assert.deepEqual(ssh.writeHostBlock(dir, ENTRY, '2026-11-08'), { ok: true, created: true })
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(dir, 'config')).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(path.join(dir, 'config'), 'utf8'), ssh.hostBlock(ENTRY, '2026-11-08'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('쓰기: 기존 config 는 끝에 덧붙이기만(앞 글 · 권한 그대로)', () => {
  const home = tempHome()
  try {
    const dir = path.join(home, '.ssh')
    fs.mkdirSync(dir, { mode: 0o700 })
    const file = path.join(dir, 'config')
    const before = 'Host *\n  ServerAliveInterval 30\n\nHost old\n  HostName example.com'
    fs.writeFileSync(file, before, { mode: 0o644 })
    assert.deepEqual(ssh.writeHostBlock(dir, ENTRY, 'd'), { ok: true, created: false })
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.startsWith(before))
    assert.equal(after, `${before}\n\n${ssh.hostBlock(ENTRY, 'd')}`)
    assert.equal(fs.statSync(file).mode & 0o777, 0o644)
    // 두 번째 서버도 뒤에만 붙는다
    assert.deepEqual(ssh.writeHostBlock(dir, { ...ENTRY, alias: 'web-two' }, 'd'), { ok: true, created: false })
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(after))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('쓰기: 그 사이 같은 별칭이 생겼으면 쓰지 않고 taken', () => {
  const home = tempHome()
  try {
    const dir = path.join(home, '.ssh')
    fs.mkdirSync(dir, { mode: 0o700 })
    const file = path.join(dir, 'config')
    fs.writeFileSync(file, 'Host WEB-PROD\n  HostName example.com\n', { mode: 0o600 })
    assert.deepEqual(ssh.writeHostBlock(dir, ENTRY, 'd'), { ok: false, error: 'taken' })
    assert.equal(fs.readFileSync(file, 'utf8'), 'Host WEB-PROD\n  HostName example.com\n')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
