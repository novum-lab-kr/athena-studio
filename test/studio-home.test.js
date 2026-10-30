// 스튜디오 집 — 번들 만들기 · 풀기 · 본체 설정 · 레지스트리 손잡이 · 켤 때 업데이트 판단(임시 git 저장소로)
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const home = require('../src/lib/studio-home')

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-home-')))
const env = home.gitEnv()
const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// 스튜디오 레포 흉내 — athena/ 아래 코어 파일 + 레포 자체 파일
function studioRepo() {
  const repo = path.join(tmp(), 'studio')
  fs.mkdirSync(path.join(repo, 'athena', 'scripts', 'board'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'athena', 'CLAUDE.md'), '# core\n')
  fs.writeFileSync(path.join(repo, 'athena', 'scripts', 'board', 'server.mjs'), '// board\n')
  fs.writeFileSync(path.join(repo, 'athena', '.gitignore'), 'athena.config.json\n.pack-data\n')
  fs.writeFileSync(path.join(repo, 'README.md'), 'studio\n')
  run(repo, 'init', '-q', '-b', 'main')
  run(repo, 'add', '-A')
  run(repo, 'commit', '-q', '-m', 'init')
  return repo
}

function commitCore(repo, name, text) {
  fs.writeFileSync(path.join(repo, 'athena', name), text)
  run(repo, 'add', '-A')
  run(repo, 'commit', '-q', '-m', `core ${name}`)
}

// 폴더 전체 해시(경로 + 내용 · 링크는 가리키는 곳)
function dirHash(dir) {
  const hash = crypto.createHash('sha256')
  const walk = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name)
      const stat = fs.lstatSync(full)
      hash.update(path.relative(dir, full))
      if (stat.isSymbolicLink()) hash.update(`->${fs.readlinkSync(full)}`)
      else if (stat.isDirectory()) walk(full)
      else hash.update(fs.readFileSync(full))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

test('신원 · 자리: 개발 앱과 배포판은 앱 데이터 · 접속 파일 · 소켓 대체 자리가 다르다', () => {
  const dev = home.appIdentity({ packaged: false })
  const release = home.appIdentity({ packaged: true })
  assert.notEqual(dev.name, release.name)
  assert.notEqual(dev.endpointName, release.endpointName)
  assert.notEqual(dev.socketTag, release.socketTag)
  assert.equal(release.name, 'Athena Studio')
  const layout = home.studioLayout({ home: '/Users/me', identity: release })
  assert.deepEqual(layout, {
    root: '/Users/me/.athena-studio',
    core: '/Users/me/.athena-studio/core',
    bodies: '/Users/me/.athena-studio/bodies',
    data: '/Users/me/.athena-studio/data',
    endpoint: '/Users/me/.athena-studio/daemon.json',
  })
  assert.equal(home.studioLayout({ home: '/Users/me', identity: dev }).endpoint, '/Users/me/.athena-studio/daemon-dev.json')
  // 격리 실행 — 스튜디오 집 · 앱 데이터가 모두 그 아래
  assert.equal(home.studioLayout({ home: '/Users/me', override: '/tmp/x', identity: dev }).core, '/tmp/x/core')
  assert.equal(home.userDataDir({ appData: '/Users/me/Library/Application Support', identity: dev }), '/Users/me/Library/Application Support/Athena Studio Dev')
  assert.equal(home.userDataDir({ appData: '/a', identity: dev, override: '/tmp/x' }), '/tmp/x/app/Athena Studio Dev')
  // 앱 리소스 자리 하나 — 개발 앱은 레포 .dev-app/resources, 배포판은 resourcesPath
  assert.equal(home.coreBundlePath({ appRoot: '/repo', packaged: false }), '/repo/.dev-app/resources/athena-core.bundle')
  assert.equal(home.coreBundlePath({ appRoot: '/repo', packaged: true, resourcesPath: '/App.app/Contents/Resources' }), '/App.app/Contents/Resources/athena-core.bundle')
  assert.notEqual(home.STUDIO_PORT_BASE, 4700)
})

test('본체 설정: 빈 키만 채우고 있던 값 · 깨진 파일은 건드리지 않는다', () => {
  const core = tmp()
  const file = path.join(core, 'athena.config.json')
  const wanted = { dataDir: '/d', reposRoot: '/h', boardPort: 4800 }
  assert.deepEqual(home.ensureCoreConfig(core, wanted), { ok: true, changed: true, keys: ['dataDir', 'screen', 'reposRoot', 'boardPort'] })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dataDir: '/d', screen: 'studio', reposRoot: '/h', boardPort: 4800 })
  assert.deepEqual(home.ensureCoreConfig(core, { ...wanted, dataDir: '/other' }), { ok: true, changed: false })
  fs.writeFileSync(file, JSON.stringify({ dataDir: '/mine', boardPort: 4811 }))
  home.ensureCoreConfig(core, wanted)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dataDir: '/mine', boardPort: 4811, screen: 'studio', reposRoot: '/h' })
  fs.writeFileSync(file, '{oops')
  assert.equal(home.ensureCoreConfig(core, wanted).error, 'config-unreadable')
  assert.equal(fs.readFileSync(file, 'utf8'), '{oops')
})

test('레지스트리: 없으면 코어 기본 모양 + 손잡이, 있으면 없는 키만, 잠겨 있으면 건너뜀', () => {
  const data = path.join(tmp(), 'data')
  const file = path.join(data, 'config.json')
  assert.equal(home.ensureRegistry(data, { bodiesDir: '../bodies', portBase: 4800 }).changed, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { formatVersion: 1, current: null, generation: 0, packs: {}, bodiesDir: '../bodies', portBase: 4800 })
  fs.writeFileSync(file, JSON.stringify({ formatVersion: 1, packs: { acme: { body: '/x' } }, portBase: 4900 }))
  home.ensureRegistry(data, { bodiesDir: '../bodies', portBase: 4800 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { formatVersion: 1, packs: { acme: { body: '/x' } }, portBase: 4900, bodiesDir: '../bodies' })
  const untouched = JSON.stringify({ formatVersion: 1, packs: {} })
  fs.writeFileSync(file, untouched)
  fs.mkdirSync(path.join(data, 'registry.lock'))
  assert.deepEqual(home.ensureRegistry(data, { bodiesDir: '../bodies', portBase: 4800 }), { ok: true, changed: false, locked: true })
  assert.equal(fs.readFileSync(file, 'utf8'), untouched)
})

test('번들: athena/ 커밋 기록으로 만들고 · 트리가 같으면 다시 만들지 않고 · 새 커밋은 앞 번들의 후손', () => {
  const repo = studioRepo()
  const out = path.join(repo, '.dev-app', 'resources', home.CORE_BUNDLE_NAME)
  const first = home.makeCoreBundle({ repoRoot: repo, out })
  assert.equal(first.ok, true)
  assert.equal(first.built, true)
  assert.equal(home.bundleHead(out), first.commit)
  // 레포에 브랜치 · ref 를 만들지 않는다
  assert.deepEqual(run(repo, 'for-each-ref', '--format=%(refname)').split('\n'), ['refs/heads/main'])
  // 레포 쪽 파일만 바뀐 커밋 — 코어 트리가 같으니 그대로
  fs.writeFileSync(path.join(repo, 'README.md'), 'studio 2\n')
  run(repo, 'commit', '-q', '-am', 'studio only')
  assert.deepEqual(home.makeCoreBundle({ repoRoot: repo, out }), { ok: true, built: false, commit: first.commit, tree: first.tree, version: null })
  commitCore(repo, 'NEW.md', 'new\n')
  const second = home.makeCoreBundle({ repoRoot: repo, out })
  assert.equal(second.built, true)
  assert.notEqual(second.commit, first.commit)
  assert.equal(run(repo, 'merge-base', '--is-ancestor', first.commit, second.commit), '')
  // 번들 안 파일은 athena/ 아래 것만(레포 루트 파일 없음)
  const clone = path.join(tmp(), 'clone')
  run(tmp(), 'clone', '-q', out, clone)
  assert.equal(fs.existsSync(path.join(clone, 'NEW.md')), true)
  assert.equal(fs.existsSync(path.join(clone, 'README.md')), false)
  assert.equal(home.makeCoreBundle({ repoRoot: tmp(), out }).ok, false)
})

test('번들: 버전 ref 를 싣고(버전이 바뀌면 다시 만든다) · 주 본체로 받는다(이미 같으면 안 받음 · 옛 번들이면 아무것도)', () => {
  const repo = studioRepo()
  const out = path.join(repo, 'core.bundle')
  const first = home.makeCoreBundle({ repoRoot: repo, out, version: '0.2.0' })
  assert.equal(first.version, '0.2.0')
  const heads = () => run(repo, 'bundle', 'list-heads', out).split('\n').map((line) => line.split(' ')[1]).sort()
  assert.deepEqual(heads(), ['HEAD', 'refs/athena/version/0.2.0', 'refs/heads/main'])
  // 레포에는 ref 를 만들지 않는다
  assert.deepEqual(run(repo, 'for-each-ref', '--format=%(refname)').split('\n'), ['refs/heads/main'])
  // 코어 트리는 그대로 · 버전만 바뀜 → 다시 만든다(같은 커밋 · 새 ref)
  const logs = []
  const second = home.makeCoreBundle({ repoRoot: repo, out, version: '0.2.0+1', log: (line) => logs.push(line) })
  assert.equal(second.built, true)
  // subtree split 을 다시 돌리지 않고 지난 커밋에 버전 ref 만 달아 묶는다
  assert.equal(logs.length, 1)
  assert.match(logs[0], /다시 묶기/)
  assert.equal(second.commit, first.commit)
  assert.deepEqual(heads(), ['HEAD', 'refs/athena/version/0.2.0+1', 'refs/heads/main'])
  assert.equal(home.makeCoreBundle({ repoRoot: repo, out, version: '0.2.0+1' }).built, false)
  // 모양이 아닌 버전은 싣지 않는다
  assert.equal(home.makeCoreBundle({ repoRoot: repo, out: path.join(repo, 'odd.bundle'), version: 'v1 x' }).version, null)
  // 주 본체로 — 처음엔 받고 · 같으면 0
  const coreDir = path.join(tmp(), 'core')
  home.installCore({ bundle: out, coreDir })
  assert.equal(home.syncVersionRefs({ coreDir, bundle: out }), 1)
  assert.equal(run(coreDir, 'rev-parse', 'refs/athena/version/0.2.0+1'), first.commit)
  assert.equal(home.syncVersionRefs({ coreDir, bundle: out }), 0)
  // 옛 번들(버전 없음) · 번들이 없음 — 아무것도 안 한다
  const plain = path.join(repo, 'plain.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: plain })
  assert.equal(home.syncVersionRefs({ coreDir, bundle: plain }), 0)
  assert.equal(home.syncVersionRefs({ coreDir, bundle: path.join(repo, 'none.bundle') }), 0)
})

test('풀기: 번들 → 주 본체(main · origin/main) · 있으면 그대로 · 번들이 없으면 bundle-missing', () => {
  const repo = studioRepo()
  const bundle = path.join(repo, 'core.bundle')
  const made = home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const coreDir = path.join(tmp(), '.athena-studio', 'core')
  assert.deepEqual(home.installCore({ bundle: path.join(repo, 'none.bundle'), coreDir }), { ok: false, error: 'bundle-missing', bundle: path.join(repo, 'none.bundle') })
  assert.equal(fs.existsSync(coreDir), false)
  assert.deepEqual(home.installCore({ bundle, coreDir }), { ok: true, created: true })
  assert.equal(run(coreDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(run(coreDir, 'rev-parse', 'HEAD'), made.commit)
  assert.equal(run(coreDir, 'rev-parse', 'refs/remotes/origin/main'), made.commit)
  assert.equal(fs.existsSync(path.join(coreDir, 'CLAUDE.md')), true)
  // 임시 자리가 남지 않는다
  assert.deepEqual(fs.readdirSync(path.dirname(coreDir)), ['core'])
  assert.deepEqual(home.installCore({ bundle, coreDir }), { ok: true, created: false })
})

test('켤 때 판단: 같음 · 앞 · 뒤 — 뒤면 건드리지 않는다', () => {
  const repo = studioRepo()
  const oldBundle = path.join(repo, 'old.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: oldBundle })
  const coreDir = path.join(tmp(), 'core')
  home.installCore({ bundle: oldBundle, coreDir })
  assert.equal(home.bundleStatus({ coreDir, bundle: oldBundle }).state, 'same')
  commitCore(repo, 'A.md', 'a\n')
  const newBundle = path.join(repo, 'new.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: newBundle })
  assert.equal(home.bundleStatus({ coreDir, bundle: newBundle }).state, 'ahead')
  // 판단만으로는 본체가 움직이지 않는다(객체만 받음 · ref 없음)
  assert.equal(fs.existsSync(path.join(coreDir, 'A.md')), false)
  assert.equal(home.bundleStatus({ coreDir, bundle: path.join(repo, 'none.bundle') }).state, 'no-bundle')
  // 본체가 더 앞(개발 앱을 옛 커밋으로 켬) → behind
  assert.equal(home.fastForwardPackless({ coreDir, bundle: newBundle }).ok, true)
  assert.equal(home.bundleStatus({ coreDir, bundle: oldBundle }).state, 'behind')
})

test('팩 없는 본체 앞으로 감기: 깨끗하면 감고 origin/main 도 맞춤 · 고쳐 뒀거나 팩이 있으면 안 함', () => {
  const repo = studioRepo()
  const bundle = path.join(repo, 'core.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const coreDir = path.join(tmp(), 'core')
  home.installCore({ bundle, coreDir })
  home.ensureCoreConfig(coreDir, { dataDir: '/d', reposRoot: '/h', boardPort: 4800 }) // git 무시 파일 — 깨끗함에 안 걸린다
  commitCore(repo, 'B.md', 'b\n')
  const next = home.makeCoreBundle({ repoRoot: repo, out: bundle })
  fs.appendFileSync(path.join(coreDir, 'CLAUDE.md'), 'edit\n')
  assert.deepEqual(home.fastForwardPackless({ coreDir, bundle }), { ok: false, error: 'dirty' })
  run(coreDir, 'checkout', '-q', '--', 'CLAUDE.md')
  assert.deepEqual(home.fastForwardPackless({ coreDir, bundle }), { ok: true })
  assert.equal(run(coreDir, 'rev-parse', 'HEAD'), next.commit)
  assert.equal(run(coreDir, 'rev-parse', 'refs/remotes/origin/main'), next.commit)
  fs.symlinkSync(tmp(), path.join(coreDir, '.pack-data'))
  assert.equal(home.isPackless(coreDir), false)
  assert.deepEqual(home.fastForwardPackless({ coreDir, bundle }), { ok: false, error: 'has-pack' })
})

test('켤 때 업데이트: 팩이 있으면 코어에 맡긴다 — 손잡이를 모르는 코어면 unsupported, 알면 update --from <번들> --backup-dirty', async () => {
  const repo = studioRepo()
  const bundle = path.join(repo, 'core.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const coreDir = path.join(tmp(), 'core')
  home.installCore({ bundle, coreDir })
  fs.symlinkSync(tmp(), path.join(coreDir, '.pack-data'))
  commitCore(repo, 'C.md', 'c\n')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const calls = []
  const oldCore = async (argv) => {
    calls.push(argv)
    return { ok: true, contract: 2, capabilities: [] }
  }
  assert.equal((await home.updateCore({ coreDir, dataDir: tmp(), bundle, runCore: oldCore })).state, 'unsupported')
  assert.deepEqual(calls, [['version']])
  calls.length = 0
  const result = { ok: false, error: 'partial', bodies: [{ id: 'acme', status: 'updated' }, { id: 'globex', status: 'skipped', reason: 'busy' }], backedUp: [{ id: 'acme', dir: '/d/backups/core-edits/upd-1/acme', files: ['CLAUDE.md'] }] }
  const newCore = async (argv) => {
    calls.push(argv)
    return argv[0] === 'version' ? { ok: true, capabilities: ['update-from-bundle', 'backup-dirty', 'bodies-dir', 'port-base'] } : result
  }
  const updated = await home.updateCore({ coreDir, dataDir: tmp(), bundle, runCore: newCore })
  assert.deepEqual(calls, [['version'], ['update', '--from', bundle, '--backup-dirty']])
  assert.equal(updated.state, 'partial')
  assert.deepEqual(updated.summary.skipped, [{ id: 'globex', reason: 'busy', blockers: [] }])
  assert.deepEqual(updated.summary.updated, ['acme'])
  assert.equal(updated.summary.backedUp[0].dir, '/d/backups/core-edits/upd-1/acme')
  assert.equal(updated.summary.notify, true)
  assert.equal(home.summarizeUpdate({ ok: true, bodies: [{ id: 'acme', status: 'updated' }, { id: 'old', status: 'skipped', reason: 'missing' }], backedUp: [] }).notify, false)
})

test('업데이트 요약: 일하는 세션이 있었지만 바로 올린 본체(working)도 알린다 — 세션 수 · pane 이름', () => {
  const working = [{ kind: 'athena', pid: 11, pane: '🧭 아테나' }, { kind: 'agent', pid: 12, pane: '🤖 shop-fe · feat/x' }, { kind: 'agent', pid: 14, pane: '🤖 shop-fe · fix/y' }, { kind: 'agent', pid: 13, what: '위임 에이전트(claude) — /r' }]
  const summary = home.summarizeUpdate({ ok: true, bodies: [{ id: 'acme', status: 'updated', working }, { id: 'globex', status: 'same', working }, { id: 'initech', status: 'updated', working: [] }], backedUp: [] })
  assert.deepEqual(summary.working, [{ id: 'acme', count: 4, sessions: ['🧭 아테나', 'shop-fe', '위임 에이전트(claude) — /r'] }])
  assert.deepEqual(summary.skipped, [])
  assert.equal(summary.notify, true)
  // 옛 코어(working 없음)는 지금처럼
  assert.deepEqual(home.summarizeUpdate({ ok: true, bodies: [{ id: 'acme', status: 'updated' }], backedUp: [] }).working, [])
})

test('켤 때 업데이트: 약속이 오른 앱이 옛 코어를 올린다 — version · update --from 에 약속 번호를 싣지 않는다', async () => {
  const repo = studioRepo()
  const bundle = path.join(repo, 'core.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const coreDir = path.join(tmp(), 'core')
  home.installCore({ bundle, coreDir })
  fs.symlinkSync(tmp(), path.join(coreDir, '.pack-data'))
  commitCore(repo, 'D.md', 'd\n')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  // 옛 코어(약속 2) 흉내 — athena.mjs checkContract 처럼 약속 번호가 실리면(앱 약속 3) contract-mismatch 로 거절
  const calls = []
  const oldCore = async (argv, options = {}) => {
    calls.push({ argv, contract: options.contract })
    if (options.contract !== false) return { ok: false, error: 'contract-mismatch', contract: 2 }
    return argv[0] === 'version' ? { ok: true, contract: 2, capabilities: ['update-from-bundle', 'backup-dirty'] } : { ok: true, bodies: [{ id: 'acme', status: 'updated' }], backedUp: [] }
  }
  const updated = await home.updateCore({ coreDir, dataDir: tmp(), bundle, runCore: oldCore })
  assert.equal(updated.state, 'updated')
  assert.deepEqual(calls.map((call) => call.argv[0]), ['version', 'update'])
  assert.ok(calls.every((call) => call.contract === false))
})

test('켤 때 업데이트: 코어가 idle-panes 를 알면 데몬 pane 상태 파일을 넘기고 · 막은 pane 이름을 알린다', async () => {
  const repo = studioRepo()
  const bundle = path.join(repo, 'core.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const coreDir = path.join(tmp(), 'core')
  home.installCore({ bundle, coreDir })
  fs.symlinkSync(tmp(), path.join(coreDir, '.pack-data'))
  commitCore(repo, 'P.md', 'p\n')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const calls = []
  const busy = [{ kind: 'athena', pid: 11, pane: '🧭 아테나' }, { kind: 'agent', pid: 12, pane: '🧭 아테나' }, { kind: 'heavy', pid: 13, what: '무거운 명령 잠금(heavy.sh)' }]
  const makeCore = (capabilities) => async (argv) => {
    calls.push(argv)
    return argv[0] === 'version' ? { ok: true, capabilities } : { ok: false, error: 'partial', bodies: [{ id: 'globex', status: 'skipped', reason: 'busy', busy }], backedUp: [] }
  }
  const panesStateFile = async () => '/tmp/panes.json'
  const updated = await home.updateCore({ coreDir, dataDir: tmp(), bundle, runCore: makeCore(['update-from-bundle', 'backup-dirty', 'idle-panes']), panesStateFile })
  assert.deepEqual(calls[1], ['update', '--from', bundle, '--backup-dirty', '--panes-state', '/tmp/panes.json'])
  assert.deepEqual(updated.summary.skipped, [{ id: 'globex', reason: 'busy', blockers: ['🧭 아테나', '무거운 명령 잠금(heavy.sh)'] }])
  // 손잡이를 모르는 코어 · 상태 파일이 없으면 넘기지 않는다
  calls.length = 0
  await home.updateCore({ coreDir, dataDir: tmp(), bundle, runCore: makeCore(['update-from-bundle', 'backup-dirty']), panesStateFile })
  assert.deepEqual(calls[1], ['update', '--from', bundle, '--backup-dirty'])
  calls.length = 0
  await home.updateCore({ coreDir, dataDir: tmp(), bundle, runCore: makeCore(['update-from-bundle', 'backup-dirty', 'idle-panes']), panesStateFile: async () => null })
  assert.deepEqual(calls[1], ['update', '--from', bundle, '--backup-dirty'])
})

test('pane 상태: 데몬 agent_status 그대로 · 질문을 기다리면 waiting · 셸 pid 모르는 pane 은 뺀다', () => {
  const panes = [
    { id: 'p1', label: '🧭 아테나', agent: 'claude', agent_status: 'idle' },
    { id: 'p2', label: null, name: null, agent: 'claude', agent_status: 'idle' },
    { id: 'p3', label: '🤖 fe', agent: 'claude', agent_status: 'working' },
    { id: 'p4', label: 'zsh', agent: null, agent_status: 'unknown' },
  ]
  const state = home.panesState({ panes, pids: { p1: 101, p2: 102, p3: 103 }, waiting: ['p2'], now: new Date('2026-10-26T00:00:00Z') })
  assert.equal(state.at, '2026-10-26T00:00:00.000Z')
  assert.deepEqual(state.panes, [
    { id: 'p1', label: '🧭 아테나', pid: 101, agent: 'claude', status: 'idle' },
    { id: 'p2', label: 'p2', pid: 102, agent: 'claude', status: 'waiting' },
    { id: 'p3', label: '🤖 fe', pid: 103, agent: 'claude', status: 'working' },
  ])
})

test('켤 때 업데이트: 주 본체에 팩이 없어도 레지스트리에 팩이 있으면 코어 update 뒤 주 본체를 앱이 감는다', async () => {
  const repo = studioRepo()
  const bundle = path.join(repo, 'core.bundle')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const coreDir = path.join(tmp(), 'core')
  home.installCore({ bundle, coreDir })
  const dataDir = tmp()
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ formatVersion: 1, packs: { 'new-1': { body: '/b/new-1' } } }))
  commitCore(repo, 'E.md', 'e\n')
  const next = home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const calls = []
  const runCore = async (argv) => {
    calls.push(argv[0])
    return argv[0] === 'version' ? { capabilities: ['update-from-bundle', 'backup-dirty'] } : { ok: true, bodies: [{ id: 'new-1', status: 'updated' }], backedUp: [] }
  }
  const updated = await home.updateCore({ coreDir, dataDir, bundle, runCore })
  assert.deepEqual(calls, ['version', 'update'])
  assert.equal(updated.state, 'updated')
  assert.equal(updated.mainMoved, true)
  assert.equal(run(coreDir, 'rev-parse', 'HEAD'), next.commit)
  // 주 본체 코어 파일을 고쳐 뒀으면 <데이터>/backups/core-edits/ 에 사본을 두고 감는다
  commitCore(repo, 'F.md', 'f\n')
  const third = home.makeCoreBundle({ repoRoot: repo, out: bundle })
  fs.appendFileSync(path.join(coreDir, 'CLAUDE.md'), 'edit\n')
  const backed = await home.updateCore({ coreDir, dataDir, bundle, runCore })
  assert.equal(backed.state, 'updated')
  assert.equal(run(coreDir, 'rev-parse', 'HEAD'), third.commit)
  assert.equal(backed.summary.notify, true)
  const copy = backed.summary.backedUp.find((entry) => entry.id === 'core')
  assert.ok(copy.dir.startsWith(path.join(dataDir, 'backups', 'core-edits')))
  assert.deepEqual(copy.files, ['CLAUDE.md'])
  assert.match(fs.readFileSync(path.join(copy.dir, 'files', 'CLAUDE.md'), 'utf8'), /edit/)
  assert.match(fs.readFileSync(path.join(copy.dir, 'changes.patch'), 'utf8'), /\+edit/)
  assert.doesNotMatch(fs.readFileSync(path.join(coreDir, 'CLAUDE.md'), 'utf8'), /edit/)
  // 주 본체에 로컬 커밋(갈라짐) — 못 감고 실패로 알린다
  run(coreDir, 'commit', '-q', '--allow-empty', '-m', 'local')
  commitCore(repo, 'G.md', 'g\n')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const status = home.bundleStatus({ coreDir, bundle })
  assert.equal(status.state, 'diverged')
  assert.equal((await home.updateCore({ coreDir, dataDir, bundle, runCore })).state, 'diverged')
  assert.deepEqual(home.fastForwardPackless({ coreDir, bundle }), { ok: false, error: 'diverged' })
})

test('켤 때 준비: 첫 실행은 풀고 · 다시 켜면 새 번들로 감되 데이터 폴더 해시는 같다', async () => {
  const repo = studioRepo()
  const bundle = path.join(repo, '.dev-app', 'resources', home.CORE_BUNDLE_NAME)
  const made = home.makeCoreBundle({ repoRoot: repo, out: bundle, version: '0.3.0' })
  const layout = home.studioLayout({ home: '/unused', override: path.join(tmp(), '.athena-studio'), identity: home.appIdentity({ packaged: false }) })
  const runCore = async () => assert.fail('팩 없는 본체는 코어를 부르지 않는다')
  const first = await home.prepareCore({ layout, bundle, home: '/Users/me', runCore })
  assert.deepEqual(first, { ok: true, created: true, update: null })
  // 번들이 실은 버전 ref 도 받는다(코어 version --json 의 version)
  assert.equal(run(layout.core, 'rev-parse', `${home.VERSION_REF_PREFIX}0.3.0`), made.commit)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(layout.core, 'athena.config.json'), 'utf8')), { dataDir: layout.data, screen: 'studio', reposRoot: '/Users/me', boardPort: home.STUDIO_PORT_BASE })
  const registry = JSON.parse(fs.readFileSync(path.join(layout.data, 'config.json'), 'utf8'))
  assert.equal(registry.bodiesDir, '../bodies')
  assert.equal(path.resolve(layout.data, registry.bodiesDir), layout.bodies)
  assert.equal(registry.portBase, home.STUDIO_PORT_BASE)
  // 사용자 데이터 흉내
  fs.mkdirSync(path.join(layout.data, 'packs', 'acme', 'plans'), { recursive: true })
  fs.writeFileSync(path.join(layout.data, 'packs', 'acme', 'plans', 'a.md'), 'plan\n')
  const before = dirHash(layout.data)
  const configBefore = fs.readFileSync(path.join(layout.core, 'athena.config.json'), 'utf8')
  assert.equal((await home.prepareCore({ layout, bundle, home: '/Users/me', runCore })).update.state, 'same')
  commitCore(repo, 'D.md', 'd\n')
  home.makeCoreBundle({ repoRoot: repo, out: bundle })
  const again = await home.prepareCore({ layout, bundle, home: '/Users/me', runCore })
  assert.equal(again.update.state, 'fast-forwarded')
  assert.equal(fs.existsSync(path.join(layout.core, 'D.md')), true)
  assert.equal(dirHash(layout.data), before)
  assert.equal(fs.readFileSync(path.join(layout.core, 'athena.config.json'), 'utf8'), configBefore)
  // update: false([다시 시도]) 는 업데이트를 보지 않는다
  assert.deepEqual(await home.prepareCore({ layout, bundle, home: '/Users/me', runCore, update: false }), { ok: true, created: false, update: null })
})

test('초기화: 끌 현황판(코어 + 팩마다) · 지울 자리는 스튜디오 집 안만 · 다른 앱 접속 파일과 집 밖은 남긴다', () => {
  const root = tmp()
  const layout = home.studioLayout({ home: '/unused', override: root, identity: home.appIdentity({ packaged: false }) })
  fs.mkdirSync(layout.core, { recursive: true })
  fs.writeFileSync(path.join(layout.core, 'athena.config.json'), JSON.stringify({ boardPort: 4800 }))
  const body = path.join(layout.bodies, 'acme')
  fs.mkdirSync(body, { recursive: true })
  fs.mkdirSync(layout.data, { recursive: true })
  fs.writeFileSync(path.join(layout.data, 'config.json'), JSON.stringify({ packs: { acme: { body, boardPort: 4802 }, gone: { body: path.join(layout.bodies, 'gone'), boardPort: 4804 } } }))
  fs.writeFileSync(layout.endpoint, '{}')
  fs.writeFileSync(path.join(root, 'daemon-dev-ids.json'), '{}')
  fs.writeFileSync(path.join(root, 'daemon.json'), '{}') // 배포판 접속 파일 — 남긴다
  const outside = path.join(tmp(), 'repo')
  fs.mkdirSync(outside)

  const plan = home.resetPlan(layout)
  assert.deepEqual(plan.packs, ['acme', 'gone'])
  assert.deepEqual(plan.boards, [{ port: 4800, dir: layout.core }, { port: 4802, dir: body }]) // 본체가 없는 팩은 끌 수 없다
  home.resetHome(layout, { ...plan, remove: [...plan.remove, outside, root] })
  assert.deepEqual(fs.readdirSync(root), ['daemon.json'])
  assert.equal(fs.existsSync(outside), true) // 집 밖 · 집 자체는 지우지 않는다
})
