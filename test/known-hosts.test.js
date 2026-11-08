// 서버 등록 팝업의 호스트 키 믿기(src/lib/known-hosts.mts · src/main/ssh-setup.mts serverRegister · sshTrustHostKey)
// 순수 부분(ssh -G 읽기 · 이름 · 지문 · keyscan 줄 거르기) + 이 맥에서 사용자 모드 sshd(127.0.0.1 · 22 가 아닌 포트)를 띄워 진짜 ssh 로:
//   처음 서버 → 지문 표시 · 믿기 뒤 접속 확인 통과 / 키 바뀜 → 경고 · 믿기 없음 / 지문 바꿔치기 거절 / 칸 바뀜 · 그 사이 다른 키 / HashKnownHosts
// 진짜 ~/.ssh 는 건드리지 않는다 — 격리 폴더의 config 가 UserKnownHostsFile 을 그 폴더로 돌린다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const knownHosts = require('../src/lib/known-hosts.mts')
const { installSshSetup } = require('../src/main/ssh-setup.mts')

const SSHD = '/usr/sbin/sshd'

test('ssh -G 읽기: hostname · port · 파일 목록 · 해시 · HostKeyAlias', () => {
  const text = ['hostname 203.0.113.10', 'port 2222', 'hashknownhosts yes', 'userknownhostsfile /Users/me/.ssh/known_hosts /Users/me/.ssh/known_hosts2', 'globalknownhostsfile /etc/ssh/ssh_known_hosts none'].join('\n')
  assert.deepEqual(knownHosts.parseSshG(text), { hostname: '203.0.113.10', port: 2222, userFiles: ['/Users/me/.ssh/known_hosts', '/Users/me/.ssh/known_hosts2'], globalFiles: ['/etc/ssh/ssh_known_hosts'], hash: true, hostKeyAlias: null, proxied: false })
  assert.equal(knownHosts.parseSshG(`${text}\nhostkeyalias other`).hostKeyAlias, 'other')
  assert.equal(knownHosts.parseSshG(`${text}\nproxyjump jump`).proxied, true)
  assert.equal(knownHosts.parseSshG(`${text}\nproxycommand nc %h %p`).proxied, true)
  assert.equal(knownHosts.parseSshG(`${text}\nproxyjump none`).proxied, false)
  // 맨 앞 - · 공백 든 이름 · 포트 밖은 버린다
  assert.equal(knownHosts.parseSshG('hostname -oProxyCommand=x\nport 22'), null)
  assert.equal(knownHosts.parseSshG('hostname a b\nport 22'), null)
  assert.equal(knownHosts.parseSshG('hostname 203.0.113.10\nport 70000'), null)
})

test('점프 서버 · ProxyCommand 설정이면 keyscan 을 부르지 않고 failed(터미널 안내)', async () => {
  // keyscan 은 점프 서버를 거치지 않고 hostname 에 직접 붙는다 — 다른 기계의 키를 받을 수 있어 앱이 믿기를 내지 않는다
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'known-hosts-proxy-'))
  try {
    const marker = path.join(root, 'keyscan-called')
    const keyscan = path.join(root, 'keyscan')
    fs.writeFileSync(keyscan, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
    const config = path.join(root, 'config')
    const lines = ['Host plain', '  HostName 203.0.113.10', 'Host jumped', '  HostName 203.0.113.10', '  ProxyJump bastion', 'Host piped', '  HostName 203.0.113.10', '  ProxyCommand nc %h %p', 'Host *', `  UserKnownHostsFile ${path.join(root, 'known_hosts')}`, `  GlobalKnownHostsFile ${path.join(root, 'global_known_hosts')}`, '']
    fs.writeFileSync(config, lines.join('\n'), { mode: 0o600 })
    for (const alias of ['jumped', 'piped']) assert.deepEqual(await knownHosts.lookupHostKey(config, alias, { keyscanBin: keyscan }), { state: 'failed' }, alias)
    assert.equal(fs.existsSync(marker), false)
    // 점프가 없는 같은 설정은 keyscan 까지 간다(빈 결과라 failed 지만 불린다)
    await knownHosts.lookupHostKey(config, 'plain', { keyscanBin: keyscan })
    assert.equal(fs.existsSync(marker), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('이름: 22 면 그대로 · 아니면 [host]:port', () => {
  assert.equal(knownHosts.knownName('203.0.113.10', 22), '203.0.113.10')
  assert.equal(knownHosts.knownName('203.0.113.10', 2222), '[203.0.113.10]:2222')
  assert.equal(knownHosts.knownName('2001:db8::1', 2222), '[2001:db8::1]:2222')
})

// 키 글자 하나 만들기(종류 이름 + 32바이트) — ed25519 공개 키 꼴
const blobOf = (type, fill = 1) => {
  const name = Buffer.from(type)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(name.length)
  const keyHead = Buffer.alloc(4)
  keyHead.writeUInt32BE(32)
  return Buffer.concat([head, name, keyHead, Buffer.alloc(32, fill)]).toString('base64')
}

test('keyscan 줄: 이름 · 종류 · 안의 종류가 맞는 것만 · 같은 키는 한 번', () => {
  const name = '[203.0.113.10]:2222'
  const good = blobOf('ssh-ed25519')
  const text = [
    '# 203.0.113.10:2222 SSH-2.0-OpenSSH_10.2',
    `${name} ssh-ed25519 ${good}`,
    `${name} ssh-ed25519 ${good}`,
    `203.0.113.10 ssh-ed25519 ${blobOf('ssh-ed25519', 2)}`,
    `${name} ssh-dss ${blobOf('ssh-dss', 3)}`,
    `${name} ssh-rsa ${blobOf('ssh-ed25519', 4)}`,
    `${name} ssh-ed25519 ${good} extra`,
    `${name} ssh-ed25519 !!!`,
  ].join('\n')
  const keys = knownHosts.parseScan(text, name)
  assert.equal(keys.length, 1)
  assert.equal(keys[0].line, `${name} ssh-ed25519 ${good}`)
  assert.match(keys[0].sha256, /^SHA256:[A-Za-z0-9+/]{43}$/)
  assert.equal(knownHosts.keyLabel('ssh-ed25519'), 'ED25519')
  assert.equal(knownHosts.keyLabel('ecdsa-sha2-nistp256'), 'ECDSA')
  assert.equal(knownHosts.keyLabel('ssh-rsa'), 'RSA')
})

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
const waitPort = async (port) => {
  for (let tries = 0; tries < 50; tries += 1) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.end()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    if (open) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('sshd 가 뜨지 않았다')
}
const keygen = (file) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', file])
const sshFingerprint = (pubFile) => execFileSync('ssh-keygen', ['-lf', pubFile, '-E', 'sha256'], { encoding: 'utf8' }).split(' ')[1]

test('진짜 ssh: 처음 서버 · 바꿔치기 · 믿기 · 키 바뀜 · 해시', { skip: fs.existsSync(SSHD) ? false : 'sshd 없음' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'known-hosts-test-'))
  const home = path.join(root, 'home')
  const sshDir = path.join(home, '.ssh')
  const known = path.join(sshDir, 'known_hosts')
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  for (const name of ['hostkey', 'otherkey', 'userkey']) keygen(path.join(root, name))
  fs.copyFileSync(path.join(root, 'userkey.pub'), path.join(root, 'authorized_keys'))
  const port = await freePort()
  const sshdConfig = path.join(root, 'sshd_config')
  fs.writeFileSync(sshdConfig, [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${path.join(root, 'hostkey')}`, `PidFile ${path.join(root, 'sshd.pid')}`, `AuthorizedKeysFile ${path.join(root, 'authorized_keys')}`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PerSourcePenalties no', ''].join('\n'))
  // PerSourcePenalties(OpenSSH 9.8+)는 앞의 실패 접속으로 127.0.0.1 을 잠깐 막는다 — 모르는 옛 sshd 면 그 줄을 뺀다
  try {
    execFileSync(SSHD, ['-t', '-f', sshdConfig], { stdio: 'ignore' })
  } catch {
    fs.writeFileSync(sshdConfig, fs.readFileSync(sshdConfig, 'utf8').replace('PerSourcePenalties no\n', ''))
  }
  const sshd = spawn(SSHD, ['-D', '-f', sshdConfig, '-E', path.join(root, 'sshd.log')], { stdio: 'ignore' })
  const writeConfig = (extra = []) => fs.writeFileSync(path.join(sshDir, 'config'), ['Host *', `  UserKnownHostsFile ${known}`, `  GlobalKnownHostsFile ${path.join(root, 'global_known_hosts')}`, ...extra, ''].join('\n'), { mode: 0o600 })
  try {
    await waitPort(port)
    writeConfig()
    // 팩 쪽(코어 server add --check · --tested)은 가짜 — 여기서는 접속 · 호스트 키만 본다
    const added = []
    const ctx = {
      win: null,
      serverCheck: async (alias) => ({ ok: true, checked: true, server: { name: alias, host: alias } }),
      addServer: async (alias, options) => {
        added.push({ alias, ...options })
        return { ok: true, already: false, server: { name: alias, host: alias } }
      },
    }
    // 가짜 시스템 설정 — 처음엔 없다(10 에서 만든다)
    const systemDir = path.join(root, 'etc-ssh')
    const systemConfig = path.join(systemDir, 'ssh_config')
    installSshSetup(ctx, { dialog: {}, home, systemConfig })
    const input = { alias: 'kh-test', user: os.userInfo().username, host: '127.0.0.1', port: String(port), key: path.join(root, 'userkey') }
    const source = (value) => ({ kind: 'new', input: value })
    const register = async (value = input) => ctx.serverRegister(source(value))
    const trust = async (value, prints) => ctx.sshTrustHostKey(source(value), prints)
    // 등록이 통과하면 config 에 Host 블록이 붙는다 — 같은 별칭으로 다시 해 보려면 config 를 처음으로
    const passes = async (extra = []) => {
      const reply = await register()
      assert.equal(reply.ok, true, JSON.stringify(reply))
      assert.equal(fs.readFileSync(path.join(sshDir, 'config'), 'utf8').includes('Host kh-test'), true)
      assert.deepEqual(added.pop(), { alias: 'kh-test', tested: true })
      writeConfig(extra)
    }
    const expected = sshFingerprint(path.join(root, 'hostkey.pub'))

    // 1) 처음 서버 → host-key + 지문(ssh-keygen -l 과 같다) · known_hosts 는 아직 없다
    const first = await register()
    assert.equal(first.ok, false)
    assert.equal(first.step, 'connect')
    assert.equal(first.reason, 'host-key')
    assert.deepEqual(first.hostKey, { keys: [{ type: 'ED25519', sha256: expected }] })
    assert.equal(fs.existsSync(known), false)

    // 2) 지문 바꿔치기 → mismatch · 쓰지 않음 · 한 번 쓰면 기억은 지워진다(다시 [등록] 부터)
    const otherPrint = sshFingerprint(path.join(root, 'otherkey.pub'))
    assert.deepEqual(await trust(input, [otherPrint]), { ok: false, error: 'mismatch' })
    assert.deepEqual(await trust(input, [expected]), { ok: false, error: 'untested' })
    assert.equal(fs.existsSync(known), false)

    // 3) 칸이 바뀌면 → untested
    await register()
    assert.deepEqual(await trust({ ...input, alias: 'kh-other' }, [expected]), { ok: false, error: 'untested' })
    assert.equal(fs.existsSync(known), false)

    // 4) 믿기 → 새 파일 600 · [127.0.0.1]:port 한 줄 · 그 뒤 접속 확인 통과
    await register()
    assert.deepEqual(await trust(input, [expected]), { ok: true, created: true })
    assert.equal(fs.statSync(known).mode & 0o777, 0o600)
    const saved = fs.readFileSync(known, 'utf8')
    assert.equal(saved, `${fs.readFileSync(path.join(root, 'hostkey.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ').replace(/^/, `[127.0.0.1]:${port} `)}\n`)
    await passes()

    // 5) 키 바뀜(known_hosts 의 그 이름에 다른 키) → host-key-changed · 지문 · 믿기 없음 · 파일 그대로
    const otherLine = `[127.0.0.1]:${port} ${fs.readFileSync(path.join(root, 'otherkey.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')}\n`
    fs.writeFileSync(known, otherLine)
    const changed = await register()
    assert.equal(changed.reason, 'host-key-changed')
    assert.equal(changed.hostKey, undefined)
    assert.deepEqual(await trust(input, [expected]), { ok: false, error: 'untested' })
    assert.equal(fs.readFileSync(known, 'utf8'), otherLine)

    // 6) 지문을 보인 뒤 그 사이 다른 키가 생기면 → changed · 덧붙이지 않음
    fs.rmSync(known)
    await register()
    fs.writeFileSync(known, otherLine)
    assert.deepEqual(await trust(input, [expected]), { ok: false, error: 'changed' })
    assert.equal(fs.readFileSync(known, 'utf8'), otherLine)

    // 7) HashKnownHosts yes → |1| 해시 줄 · 기존 파일(끝 줄바꿈 없음)은 앞 글 · 권한 그대로 덧붙이기 · 접속 통과
    fs.writeFileSync(known, '# keep', { mode: 0o644 })
    fs.chmodSync(known, 0o644)
    writeConfig(['  HashKnownHosts yes'])
    const hashedTest = await register()
    assert.equal(hashedTest.reason, 'host-key')
    assert.deepEqual(await trust(input, [expected]), { ok: true, created: false })
    const hashed = fs.readFileSync(known, 'utf8')
    assert.match(hashed, /^# keep\n\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+ ssh-ed25519 \S+\n$/)
    assert.equal(hashed.includes('127.0.0.1'), false)
    assert.equal(fs.statSync(known).mode & 0o777, 0o644)
    await passes(['  HashKnownHosts yes'])
    assert.equal(added.length, 0)

    // 8) 기존 Host 고치기 — 고르면 ssh -G 값 · 고쳐서 [등록] 하면 접속 확인 뒤 그 블록만 다시 쓴다(백업 600 · 다른 줄 그대로)
    const configFile = path.join(sshDir, 'config')
    const userKey = path.join(root, 'userkey')
    const editBlock = (head, portValue) => [head, '  HostName 127.0.0.1', `  Port ${portValue}`, `  User ${os.userInfo().username}`, `  IdentityFile ${userKey}`, '  # 손으로 적은 메모']
    writeConfig(['  HashKnownHosts yes', ...editBlock('Host kh-edit', 1)])
    const detail = await ctx.serverHostDetail('kh-edit')
    assert.deepEqual(detail, { ok: true, values: { alias: 'kh-edit', host: '127.0.0.1', user: os.userInfo().username, port: '1', key: userKey }, lock: null })
    const hostSource = (value) => ({ kind: 'host', alias: 'kh-edit', input: value })
    const backups = () => fs.readdirSync(sshDir).filter((name) => name.startsWith('config.athena-studio-'))
    // 안 고쳤으면 쓰지 않는다(접속은 Port 1 이라 실패 — config · 백업 그대로)
    const before = fs.readFileSync(configFile, 'utf8')
    const untouched = await ctx.serverRegister(hostSource(detail.values))
    assert.equal(untouched.step, 'connect')
    assert.equal(fs.readFileSync(configFile, 'utf8'), before)
    assert.deepEqual(backups(), [])
    // 포트를 고치면 통과 → Port 줄만 바뀌고 메모 줄 · 다른 블록은 그대로 · 백업은 원래 글
    const edited = await ctx.serverRegister(hostSource({ ...detail.values, port: String(port) }))
    assert.equal(edited.ok, true, JSON.stringify(edited))
    assert.deepEqual(added.pop(), { alias: 'kh-edit', tested: true })
    assert.equal(fs.readFileSync(configFile, 'utf8'), before.replace('  Port 1\n', `  Port ${port}\n`))
    assert.equal(backups().length, 1)
    assert.equal(fs.readFileSync(path.join(sshDir, backups()[0]), 'utf8'), before)
    assert.equal(fs.statSync(path.join(sshDir, backups()[0])).mode & 0o777, 0o600)
    for (const name of backups()) fs.rmSync(path.join(sshDir, name))
    // 접속이 실패하면 쓰지 않는다
    writeConfig(['  HashKnownHosts yes', ...editBlock('Host kh-edit', port)])
    const kept = fs.readFileSync(configFile, 'utf8')
    const failed = await ctx.serverRegister(hostSource({ ...detail.values, port: '1' }))
    assert.equal(failed.step, 'connect')
    assert.equal(fs.readFileSync(configFile, 'utf8'), kept)
    assert.deepEqual(backups(), [])
    // Host 줄에 별칭이 여럿 → 읽기 전용(multi) · 고친 값을 보내도 쓰지 않는다
    writeConfig(['  HashKnownHosts yes', ...editBlock('Host kh-edit kh-alt', port)])
    assert.equal((await ctx.serverHostDetail('kh-edit')).lock, 'multi')
    const multi = await ctx.serverRegister(hostSource({ ...detail.values, port: '2' }))
    assert.deepEqual([multi.step, multi.lock], ['check', 'multi'])
    // 앞선 블록이 Port 를 먼저 정하면 이 블록을 고쳐도 안 먹는다 → override · 쓰지 않음
    writeConfig(['  HashKnownHosts yes', 'Host kh-e*', `  Port ${port}`, ...editBlock('Host kh-edit', 1)])
    const shadow = fs.readFileSync(configFile, 'utf8')
    const override = await ctx.serverRegister(hostSource({ ...detail.values, port: '3' }))
    assert.deepEqual([override.step, override.lock], ['check', 'override'])
    assert.equal(fs.readFileSync(configFile, 'utf8'), shadow)
    assert.equal(added.length, 0)

    // 9) 앞 IdentityFile 파일이 없고 뒤 키를 쓰는 Host — 칸은 뒤 키 · 포트만 고쳐도 override 가 아니다(바뀜 확인도 같은 키 규칙)
    const user = os.userInfo().username
    writeConfig(['  HashKnownHosts yes', 'Host kh-edit', '  HostName 127.0.0.1', '  Port 1', `  User ${user}`, `  IdentityFile ${path.join(root, 'nokey')}`, `  IdentityFile ${userKey}`])
    const twoKeys = await ctx.serverHostDetail('kh-edit')
    assert.equal(twoKeys.values.key, userKey)
    const twoKeyEdit = await ctx.serverRegister(hostSource({ ...twoKeys.values, port: String(port) }))
    assert.equal(twoKeyEdit.ok, true, JSON.stringify(twoKeyEdit))
    assert.deepEqual(added.pop(), { alias: 'kh-edit', tested: true })
    for (const name of backups()) fs.rmSync(path.join(sshDir, name))

    // 10) 시스템 설정 — 기본 ssh 처럼 사용자 config 뒤에 읽는다. Port 는 시스템 설정 → 따옴표 든 공백 경로 → 중첩 상대 Include 끝 파일에만 둔다
    //     — 상대 경로가 ~/.ssh 가 아니라 시스템 폴더 기준으로 · 따옴표 경로가 한 낱말로 풀려야 값 조회 · 접속 시험이 그 값
    fs.mkdirSync(path.join(systemDir, 'ssh_config.d'), { recursive: true })
    fs.mkdirSync(path.join(systemDir, 'nested.d'), { recursive: true })
    fs.writeFileSync(systemConfig, ['Include "ssh_config.d/company policy.conf"', 'Host *', '  SendEnv LANG', ''].join('\n'))
    fs.writeFileSync(path.join(systemDir, 'ssh_config.d', 'company policy.conf'), ['Include nested.d/*.conf', ''].join('\n'))
    fs.writeFileSync(path.join(systemDir, 'nested.d', '10-kh.conf'), ['Host kh-sys kh-edit', `  Port ${port}`, ''].join('\n'))
    writeConfig(['  HashKnownHosts yes', 'Host kh-sys', '  HostName 127.0.0.1', `  User ${user}`, `  IdentityFile ${userKey}`])
    assert.equal((await ctx.serverHostDetail('kh-sys')).values.port, String(port))
    const viaSystem = await ctx.serverRegister({ kind: 'host', alias: 'kh-sys' })
    assert.equal(viaSystem.ok, true, JSON.stringify(viaSystem))
    assert.deepEqual(added.pop(), { alias: 'kh-sys', tested: true })

    // 11) 고친 Host 키 올리기 — 다시 쓴 모습의 임시 config 를 -F 로 · 별칭으로(user@host 가 아니라) · 임시 폴더는 pane 이 끝날 때 sh 가 지운다
    const opened = []
    ctx.openSshPane = async (label, text) => {
      opened.push({ label, text })
      return { pane: 'p-test' }
    }
    writeConfig(['  HashKnownHosts yes', ...editBlock('Host kh-edit', 1)])
    const configBefore = fs.readFileSync(configFile, 'utf8')
    assert.deepEqual(await ctx.sshKeyUpload(hostSource({ ...detail.values, port: String(port) })), { ok: true, pane: 'p-test' })
    const [{ label, text }] = opened
    assert.equal(label, 'ssh-key-kh-edit')
    const script = text.match(/^sh '([^']+)' && exit$/)[1]
    const scriptText = fs.readFileSync(script, 'utf8')
    const tempFile = path.join(path.dirname(script), 'config')
    assert.equal(scriptText.includes(`ssh-copy-id -F '${tempFile}' -i '${userKey}.pub' kh-edit\n`), true, scriptText)
    assert.equal(scriptText.includes(`trap "rm -rf '${path.dirname(script)}'" EXIT HUP INT TERM`), true, scriptText)
    const tempText = fs.readFileSync(tempFile, 'utf8')
    assert.equal(tempText.includes(`  Port ${port}\n`), true)
    // 시스템 설정 사본 — 중첩 Include 끝 파일이 먼저(system-0) · 공백 경로 파일(system-1) · 시스템 설정(system-2) 이 차례로 사본을 가리킨다(키 올리기 임시 폴더 안)
    const copyOf = (index) => path.join(path.dirname(script), `system-${index}`)
    assert.equal(tempText.endsWith(`Match all\nInclude "${copyOf(2)}"\n`), true, tempText)
    assert.equal(fs.readFileSync(copyOf(2), 'utf8').startsWith(`Include "${copyOf(1)}"\n`), true)
    assert.equal(fs.readFileSync(copyOf(1), 'utf8'), `Include "${copyOf(0)}"\n`)
    assert.equal(fs.readFileSync(copyOf(0), 'utf8').includes(`  Port ${port}`), true)
    assert.equal(fs.statSync(tempFile).mode & 0o777, 0o600)
    assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore)
    fs.rmSync(path.dirname(script), { recursive: true, force: true })
    assert.equal(added.length, 0)
  } finally {
    sshd.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
