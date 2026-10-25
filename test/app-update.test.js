// 앱 업데이트(⚙ 설정 팝업 [업데이트]) — 임시 저장소(bare 원격 + 앱 체크아웃 + 새 커밋을 올리는 클론)로
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const appUpdate = require('../src/lib/app-update')
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
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: tmp() }), { state: 'unavailable', behind: 0, branch: null, reason: null })
})

test('앱 업데이트: 최신이면 current · 뒤처지면 behind(커밋 수) · 받으면 빨리 감기 · lockfile 이 그대로면 install 없음', async () => {
  const { app, dev } = repos()
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'current', behind: 0, branch: 'main', reason: null })
  push(dev, 'README.md', 'b\n')
  const next = push(dev, 'README.md', 'c\n')
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'behind', behind: 2, branch: 'main', reason: null })
  const pulled = await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })
  assert.equal(pulled.ok, true)
  assert.equal(pulled.to, next)
  assert.equal(pulled.install, false)
  assert.equal(run(app, 'rev-parse', 'HEAD'), next)
  assert.deepEqual(await appUpdate.pullMain({ repoRoot: app, git: gitOrFail }), { ok: false, reason: 'current', branch: 'main' })
})

test('앱 업데이트: package.json 이 바뀌었으면 install', async () => {
  const { app, dev } = repos()
  push(dev, 'package.json', '\n')
  const pulled = await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })
  assert.equal(pulled.ok, true)
  assert.equal(pulled.install, true)
})

test('앱 업데이트: 추적 파일 변경 · main 이 아님 · 로컬 커밋이면 진행하지 않고 까닭(아무것도 안 바꾼다)', async () => {
  const { app, dev } = repos()
  push(dev, 'README.md', 'b\n')
  const before = run(app, 'rev-parse', 'HEAD')
  // 추적 파일 변경 — 미추적 파일은 상관없다
  fs.writeFileSync(path.join(app, 'scratch.txt'), 'x\n')
  assert.equal((await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail })).reason, null)
  fs.appendFileSync(path.join(app, 'README.md'), 'local\n')
  assert.deepEqual(await appUpdate.checkStatus({ repoRoot: app, git: gitOrFail }), { state: 'behind', behind: 1, branch: 'main', reason: 'dirty' })
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
  assert.deepEqual(status, { state: 'behind', behind: 1, branch: 'main', reason: 'fetch-failed' })
  assert.equal((await appUpdate.pullMain({ repoRoot: app, git: gitOrFail })).reason, 'fetch-failed')
})

test('앱 업데이트: 기본 git(runGit)으로도 돈다', async () => {
  const { app, dev } = repos()
  push(dev, 'README.md', 'b\n')
  assert.equal((await appUpdate.checkStatus({ repoRoot: app })).state, 'behind')
})
