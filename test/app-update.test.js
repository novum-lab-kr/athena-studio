// 앱 업데이트(⚙ 설정 팝업 [업데이트]) — 임시 저장소(bare 원격 + 앱 체크아웃 + 새 커밋을 올리는 클론)로
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const appUpdate = require('../src/lib/app-update.mts')
const { gitEnv } = require('../src/lib/studio-home')

const temps = []
test.after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-update-test-')))
  temps.push(dir)
  return dir
}
const env = { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const run = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// → { origin, app, dev } — app 은 앱 체크아웃(main), dev 는 원격 main 에 새 커밋을 올리는 클론
function repos() {
  const root = tmp()
  const origin = path.join(root, 'origin.git')
  const app = path.join(root, 'app')
  const dev = path.join(root, 'dev')
  run(root, 'init', '-q', '--bare', '-b', 'main', origin)
  run(root, 'clone', '-q', origin, dev)
  run(dev, 'checkout', '-q', '-B', 'main')
  fs.writeFileSync(path.join(dev, 'package.json'), '{}\n')
  fs.writeFileSync(path.join(dev, 'README.md'), 'a\n')
  run(dev, 'add', '-A')
  run(dev, 'commit', '-qm', 'first')
  run(dev, 'push', '-q', 'origin', 'main')
  run(root, 'clone', '-q', origin, app)
  return { origin, app, dev }
}
const push = (dev, file, text) => {
  fs.appendFileSync(path.join(dev, file), text)
  run(dev, 'add', '-A')
  run(dev, 'commit', '-qm', `edit ${file}`)
  run(dev, 'push', '-q', 'origin', 'main')
  return run(dev, 'rev-parse', 'HEAD')
}
// 테스트용 git — 기본(runGit)과 같은 약속(성공 stdout · 실패 reject)에 작성자 환경만 더한다
const gitOrFail = (args, { cwd }) => new Promise((resolve) => resolve(run(cwd, ...args)))

test('앱 업데이트: git 체크아웃이 아니면 unavailable(줄을 보이지 않는다)', async () => {
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: tmp() }), { state: 'unavailable', behind: 0, branch: null, reason: null, version: null, latest: null })
})

test('앱 업데이트: 최신이면 current · 뒤처지면 behind(커밋 수) · 받으면 빨리 감기 · lockfile 이 그대로면 install 없음', async () => {
  const { app, dev } = repos()
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'current', behind: 0, branch: 'main', reason: null, version: null, latest: null })
  push(dev, 'README.md', 'b\n')
  const next = push(dev, 'README.md', 'c\n')
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'behind', behind: 2, branch: 'main', reason: null, version: null, latest: null })
  const pulled = await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })
  assert.equal(pulled.ok, true)
  assert.equal(pulled.to, next)
  assert.equal(pulled.install, false)
  assert.equal(run(app, 'rev-parse', 'HEAD'), next)
  assert.deepEqual(await appUpdate.pullMain({ repoRoot: app, git: gitOrFail }), { ok: false, reason: 'current', branch: 'main' })
})

// package.json 을 통째로 바꿔 올리고 받은 결과의 install 을 돌려준다
async function installAfter(files) {
  const { app, dev } = repos()
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dev, file), text)
  run(dev, 'add', '-A')
  run(dev, 'commit', '-qm', 'edit')
  run(dev, 'push', '-q', 'origin', 'main')
  const pulled = await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })
  assert.equal(pulled.ok, true)
  return pulled.install
}
const pkg = (value) => JSON.stringify(value, null, 2) + '\n'

test('앱 업데이트: 일반 scripts 만 바뀐 package.json 은 install 없음', async () => {
  const { app, dev } = repos()
  fs.writeFileSync(path.join(dev, 'package.json'), pkg({ name: 'x', scripts: { check: 'node a' }, dependencies: { a: '1' } }))
  run(dev, 'add', '-A'); run(dev, 'commit', '-qm', 'base'); run(dev, 'push', '-q', 'origin', 'main')
  await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })
  fs.writeFileSync(path.join(dev, 'package.json'), pkg({ name: 'x', scripts: { check: 'node a b', test: 'node t' }, dependencies: { a: '1' } }))
  run(dev, 'add', '-A'); run(dev, 'commit', '-qm', 'scripts'); run(dev, 'push', '-q', 'origin', 'main')
  const pulled = await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })
  assert.equal(pulled.ok, true)
  assert.equal(pulled.install, false)
})

test('앱 업데이트: 의존성이 바뀌면 install', async () => {
  assert.equal(await installAfter({ 'package.json': pkg({ dependencies: { a: '1' } }) }), true)
})

test('앱 업데이트: lockfile 이 바뀌면 install', async () => {
  assert.equal(await installAfter({ 'package-lock.json': '{}\n' }), true)
})

test('앱 업데이트: package.json 을 파싱하지 못하면 안전하게 install', async () => {
  assert.equal(await installAfter({ 'package.json': '{ not json' }), true)
})

test('앱 업데이트: 설치 스크립트 넷이 바뀌면 install · 그 밖의 scripts 는 아니다', () => {
  const base = { name: 'x', scripts: { check: 'a', postinstall: 'node p' } }
  const changed = (scripts) => appUpdate.installRelevantChanged(pkg(base), pkg({ ...base, scripts }))
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(changed({ ...base.scripts, [name]: 'node changed' }), true, name)
  }
  assert.equal(changed({ check: 'b', postinstall: 'node p' }), false)
  assert.equal(changed({ check: 'a' }), true) // 설치 스크립트를 지움
  // 일반 scripts 필드의 최초 추가 · 전체 삭제는 양방향 모두 설치 아님
  assert.equal(appUpdate.installRelevantChanged(pkg({ name: 'x' }), pkg({ name: 'x', scripts: { check: 'a' } })), false)
  assert.equal(appUpdate.installRelevantChanged(pkg({ name: 'x', scripts: { check: 'a' } }), pkg({ name: 'x' })), false)
  assert.equal(appUpdate.installRelevantChanged(pkg({ name: 'x', scripts: {} }), pkg({ name: 'x', scripts: { check: 'a' } })), false)
  assert.equal(appUpdate.installRelevantChanged(pkg({ b: 1, a: 2 }), pkg({ a: 2, b: 1 })), false) // 키 순서
  assert.throws(() => appUpdate.installRelevantChanged('{', '{}'))
})

test('앱 업데이트: 추적 파일 변경 · main 이 아님 · 로컬 커밋이면 진행하지 않고 까닭(아무것도 안 바꾼다)', async () => {
  const { app, dev } = repos()
  push(dev, 'README.md', 'b\n')
  const before = run(app, 'rev-parse', 'HEAD')
  // 추적 파일 변경 — 미추적 파일은 상관없다
  fs.writeFileSync(path.join(app, 'scratch.txt'), 'x\n')
  assert.equal((await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail })).reason, null)
  fs.appendFileSync(path.join(app, 'README.md'), 'local\n')
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'behind', behind: 1, branch: 'main', reason: 'dirty', version: null, latest: null })
  assert.deepEqual(await appUpdate.pullMain({ repoRoot: app, git: gitOrFail }), { ok: false, reason: 'dirty', branch: 'main' })
  assert.equal(run(app, 'rev-parse', 'HEAD'), before)
  assert.match(fs.readFileSync(path.join(app, 'README.md'), 'utf8'), /local/)
  run(app, 'checkout', '-q', '--', 'README.md')
  // main 이 아님
  run(app, 'checkout', '-q', '-b', 'feature/x')
  assert.deepEqual(await appUpdate.pullMain({ repoRoot: app, git: gitOrFail }), { ok: false, reason: 'not-main', branch: 'feature/x' })
  run(app, 'checkout', '-q', 'main')
  // 로컬 커밋 — 빨리 감기가 안 된다
  fs.writeFileSync(path.join(app, 'LOCAL.md'), 'l\n')
  run(app, 'add', 'LOCAL.md')
  run(app, 'commit', '-qm', 'local')
  const local = run(app, 'rev-parse', 'HEAD')
  assert.deepEqual(await appUpdate.pullMain({ repoRoot: app, git: gitOrFail }), { ok: false, reason: 'diverged', branch: 'main' })
  assert.equal(run(app, 'rev-parse', 'HEAD'), local)
})

test('앱 업데이트: origin 에서 못 받으면 fetch-failed — 이미 받은 origin/main 으로 센다', async () => {
  const { app, dev } = repos()
  push(dev, 'README.md', 'b\n')
  run(app, 'fetch', '-q', 'origin')
  run(app, 'remote', 'set-url', 'origin', path.join(tmp(), 'missing.git'))
  const status = await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail })
  assert.deepEqual(status, { state: 'behind', behind: 1, branch: 'main', reason: 'fetch-failed', version: null, latest: null })
  assert.equal((await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })).reason, 'fetch-failed')
})

test('앱 업데이트: 기본 git(runGit)으로도 돈다', async () => {
  const { app, dev } = repos()
  push(dev, 'README.md', 'b\n')
  assert.equal((await appUpdate.checkStatus({ repoRoot: app })).state, 'behind')
})

// 버전 — 태그 vX.Y.Z(src/lib/version.js). 지금 버전은 늘 · origin/main 에 더 높은 태그가 있을 때만 latest
test('앱 업데이트: 태그로 지금 버전 · origin 의 새 태그(latest) — 새 태그가 아직 없으면 latest 없음', async () => {
  const { app, dev } = repos()
  run(dev, 'tag', 'v0.2.1')
  run(dev, 'push', '-q', 'origin', 'v0.2.1')
  run(app, 'fetch', '-q', 'origin', 'v0.2.1:refs/tags/v0.2.1')
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'current', behind: 0, branch: 'main', reason: null, version: '0.2.1', latest: null })
  // 커밋만 늘었다 — 새 태그 없음
  push(dev, 'README.md', 'b\n')
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'behind', behind: 1, branch: 'main', reason: null, version: '0.2.1', latest: null })
  // 새 태그 — 받기(fetch)로 태그도 온다
  push(dev, 'README.md', 'c\n')
  run(dev, 'tag', 'v0.3.0')
  run(dev, 'push', '-q', 'origin', 'v0.3.0')
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'behind', behind: 2, branch: 'main', reason: null, version: '0.2.1', latest: '0.3.0' })
  // 받은 뒤 — 태그 커밋이면 0.3.0 · 그 위에 내 커밋이면 +1
  await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })
  assert.equal((await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail, fetch: false })).version, '0.3.0')
  run(app, 'checkout', '-q', '-b', 'feature/y')
  fs.appendFileSync(path.join(app, 'README.md'), 'mine\n')
  run(app, 'commit', '-qam', 'mine')
  assert.equal((await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail, fetch: false })).version, '0.3.0+1')
})

test('앱 업데이트: newerVersion — 태그가 더 높을 때만', () => {
  assert.equal(appUpdate.newerVersion('0.2.1', '0.3.0'), '0.3.0')
  assert.equal(appUpdate.newerVersion('0.2.1+2', '0.2.1+5'), null)
  assert.equal(appUpdate.newerVersion('0.2.1', '0.2.2+1'), '0.2.2+1')
  assert.equal(appUpdate.newerVersion(null, '0.1.1'), '0.1.1')
  assert.equal(appUpdate.newerVersion('0.2.1', null), null)
})
