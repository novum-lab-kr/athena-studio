const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { tempDir } = require('./temp-dirs')

// 가짜 팩 명령이 코어와 같은 검사 · 같은 오류 코드 · 같은 순서로 답하는지(5c91d3 — 이름은 길이만 보고, 아이콘은 검사 전에 옛 것을 지웠다)
const FAKE = path.join(__dirname, '..', 'scripts', 'fake-pack.js')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])

const setup = () => {
  const dir = tempDir('asd-fake-pack-')
  fs.mkdirSync(path.join(dir, 'pack'))
  fs.writeFileSync(path.join(dir, 'pack', 'pack.json'), JSON.stringify({ repos: [{ name: 'shop' }] }, null, 2))
  const run = (...args) => {
    const result = spawnSync(process.execPath, [FAKE, 'pack', ...args, '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: dir } })
    return JSON.parse(result.stdout.trim().split('\n').pop())
  }
  return { dir, run, write: (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file } }
}

test('set-repo-name — 코어 normalizeName 과 같은 규칙(제어 문자 · 방향 문자 · 40자 · 빈 이름)', () => {
  const { run } = setup()
  assert.equal(run('set-repo-name', 'shop', '쇼핑').displayName, '쇼핑')
  assert.equal(run('set-repo-name', 'shop', '줄\n바꿈').error, 'invalid-name')
  assert.equal(run('set-repo-name', 'shop', '가‮나').error, 'invalid-name')
  assert.equal(run('set-repo-name', 'shop', 'a'.repeat(41)).error, 'invalid-name')
  assert.equal(run('set-repo-name', 'shop', '   ').error, 'invalid-name')
})

test('set-repo-icon — GIF · 큰 파일 · 없는 파일을 코어와 같은 코드로 막고 옛 아이콘을 지우지 않는다', () => {
  const { dir, run, write } = setup()
  assert.equal(run('set-repo-icon', 'shop', write('a.png', PNG)).ok, true)
  const icon = path.join(dir, 'pack', 'assets', 'repos', 'shop.png')
  assert.ok(fs.existsSync(icon))
  assert.equal(run('set-repo-icon', 'shop', write('b.gif', Buffer.from('GIF89a......'))).error, 'invalid-image')
  assert.equal(run('set-repo-icon', 'shop', write('big.png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))).error, 'image-too-large')
  assert.equal(run('set-repo-icon', 'shop', path.join(dir, '없음.png')).error, 'not-found')
  assert.ok(fs.existsSync(icon), '검사에 걸린 요청이 옛 아이콘을 지웠다')
})

test('set-repo-icon — 레포 이름 검사가 먼저, 코어처럼 PNG 는 8바이트 머리말 전체를 본다', () => {
  const { run, write } = setup()
  assert.equal(run('set-repo-icon', '../x', write('a.png', PNG)).error, 'not-found')
  assert.equal(run('set-repo-icon', 'shop', write('half.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]))).error, 'invalid-image')
})

test('가짜 코어도 앱과 같은 약속4를 알리고 약속3 복원 호출은 거부한다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-contract-'))
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }))
  const env = { ...process.env,TMPDIR:dir }
  delete env.ATHENA_FAKE_CONTRACT
  delete env.ATHENA_CONTRACT
  const version = spawnSync(process.execPath,[FAKE,'version','--json'],{cwd:dir,env,encoding:'utf8'})
  assert.equal(version.status,0)
  const reply = JSON.parse(version.stdout.trim().split('\n').pop())
  assert.equal(reply.contract,require('../src/lib/pack.mts').CONTRACT)
  assert.equal(reply.contract,(await import('../athena/scripts/lib/bodies.mjs')).CONTRACT)
  const restored = spawnSync(process.execPath,[FAKE,'pack','restore-work','--json'],{cwd:dir,env:{...env,ATHENA_CONTRACT:'3'},encoding:'utf8'})
  assert.equal(restored.status,1)
  assert.equal(JSON.parse(restored.stdout.trim().split('\n').pop()).error,'contract-mismatch')
})
