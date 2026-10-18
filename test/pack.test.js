const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const pack = require('../src/lib/pack')

test('팩 출력: progress 줄을 모으고 마지막 줄 JSON 을 결과로', () => {
  const out = 'progress: lock 잠금\nprogress: link 링크 바꾸는 중\n{"ok":true,"current":{"id":"acme","generation":3}}\n'
  const parsed = pack.parsePackOutput(out)
  assert.deepEqual(parsed.progress.map((item) => item.step), ['lock', 'link'])
  assert.equal(parsed.result.current.generation, 3)
  // 설명이 없으면 단계 이름표
  assert.equal(pack.parseProgressLine('progress: verify').text, '새 팩 확인')
  assert.equal(pack.parseProgressLine('그냥 글'), null)
})

test('팩 출력: 비었거나 JSON 이 아니면 bad-output (옛 본체 · 사용법 글)', () => {
  assert.equal(pack.parsePackOutput('').result.error, 'bad-output')
  assert.equal(pack.parsePackOutput('사용: athena pack link\n').result.error, 'bad-output')
  // 원문은 화면 문장(message)에 넣지 않고 raw 로만(pack.log 용)
  const leaked = pack.parsePackOutput('token=abc123 secret\n')
  assert.equal(leaked.result.message.includes('abc123'), false)
  assert.equal(leaked.raw, 'token=abc123 secret')
  assert.equal(pack.parsePackOutput('[1,2]').result.error, 'bad-output')
  assert.equal(pack.parsePackOutput('{"ok":false,"error":"locked","message":"x"}').result.error, 'locked')
})

test('스트림 줄 나누기: 반쪽 줄은 다음 조각과 이어 붙인다', () => {
  let rest = ''
  const lines = []
  for (const chunk of ['progress: lo', 'ck 잠금\nprogress: li', 'nk 링크\n{"ok":true}']) {
    const split = pack.splitLines(rest, chunk)
    rest = split.rest
    lines.push(...split.lines)
  }
  assert.deepEqual(lines, ['progress: lock 잠금', 'progress: link 링크'])
  assert.equal(rest, '{"ok":true}')
})

test('오류 문장: 코드별 안내 + 본체 설명 + busy 목록', () => {
  assert.match(pack.packErrorText({ ok: false, error: 'locked' }), /다른 곳에서 팩을 갈아 끼우는 중/)
  const busy = pack.packErrorText({ ok: false, error: 'busy', busy: [{ kind: 'qa', what: 'acme-web', pid: 12 }] })
  assert.match(busy, /QA 실행 — acme-web \(pid 12\)/)
  assert.match(pack.packErrorText({ ok: false, error: 'rollback', message: '링크 실패' }), /되돌렸어요 — 링크 실패/)
  assert.match(pack.packErrorText({ ok: false, error: 'weird' }), /실패했어요/)
  assert.match(pack.packErrorText({ ok: false, error: 'failed', message: 'x' }), /예상하지 못한 오류가 났어요 — x/)
  assert.equal(pack.packErrorText({ ok: true }), '')
})

test('git 주소: https · ssh · git@ 만, 셸 문자 · 비밀번호 · 옵션 모양은 거절', () => {
  assert.ok(pack.validGitUrl('https://github.com/acme/acme-pack.git'))
  assert.ok(pack.validGitUrl('  git@github.com:acme/acme-pack.git '))
  assert.ok(pack.validGitUrl('ssh://git@github.com/acme/pack.git'))
  assert.ok(pack.validGitUrl('https://user@github.com/acme/pack.git')) // 사용자 이름만은 괜찮다
  assert.equal(pack.validGitUrl('other@github.com:acme/pack.git'), null) // scp 모양은 git@ 만(5절)
  for (const bad of ['', 'http://github.com/a/b', 'file:///tmp/x', 'ext::sh -c id', '-uhttps://x/y', 'https://github.com/a/b; rm -rf ~', 'https://u:secret@github.com/a/b', 'https://github.com/', 'git@github.com:a/b c', '$(id)']) {
    assert.equal(pack.validGitUrl(bad), null, bad)
  }
})

test('팩 목록: 실패 · 옛 본체면 supported:false, 이상한 항목은 뺀다', () => {
  assert.equal(pack.normalizePackList({ ok: false, error: 'bad-output' }).supported, false)
  const list = pack.normalizePackList({ ok: true, current: { id: 'acme', generation: 2 }, packs: [{ id: 'acme' }, { name: 'id 없음' }, null], legacy: true })
  assert.equal(list.supported, true)
  assert.equal(list.legacy, true)
  assert.deepEqual(list.packs.map((item) => item.id), ['acme'])
  assert.equal(pack.normalizePackList({ ok: true, current: null, packs: [] }).current, null)
  // ok 가 없거나 packs 가 배열이 아니면 '팩 없음' 이 아니라 지원 안 함으로
  assert.equal(pack.normalizePackList({}).supported, false)
  assert.equal(pack.normalizePackList({ ok: true, packs: 'x' }).supported, false)
})

test('시작 화면: 목록도 비고 지금 팩도 없을 때만', () => {
  assert.equal(pack.showPackWelcome({ supported: true, legacy: true, packs: [], current: null }), true) // 갓 받은 본체
  assert.equal(pack.showPackWelcome({ supported: true, legacy: true, packs: [], current: { id: 'novum-lab' } }), false) // 옛 구조 본체(리뷰 4차 회귀)
  assert.equal(pack.showPackWelcome({ supported: true, packs: [], current: { id: 'new-1', empty: true } }), false) // 새로 만드는 빈 자리
  assert.equal(pack.showPackWelcome({ supported: true, packs: [{ id: 'acme' }], current: null }), false)
  assert.equal(pack.showPackWelcome({ supported: false }), false)
})

test('켤 때 시작 화면: 팩이 있고 도는 에이전트가 없을 때만', () => {
  const list = { supported: true, packs: [{ id: 'acme' }], current: { id: 'acme' } }
  assert.equal(pack.welcomeOnLaunch({ list, agentPanes: 0 }), true)
  assert.equal(pack.welcomeOnLaunch({ list, agentPanes: 2 }), false) // 앱만 다시 켬 — 하던 일을 끊지 않는다
  assert.equal(pack.welcomeOnLaunch({ list: { ...list, packs: [] }, agentPanes: 0 }), false) // 팩이 없으면 원래 시작 화면(showPackWelcome)
  assert.equal(pack.welcomeOnLaunch({ list: { ...list, legacy: true }, agentPanes: 0 }), false)
  assert.equal(pack.welcomeOnLaunch({ list: { supported: false }, agentPanes: 0 }), false)
})

test('내 팩 목록: 지금 팩 맨 위 · 나머지 updatedAt 최근 순 · 최대 5개', () => {
  const packs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({ id, name: id.toUpperCase(), repos: index, updatedAt: `2026-10-1${index}T00:00:00Z` }))
  const recent = pack.recentPacks({ packs, current: { id: 'b' } })
  assert.deepEqual(recent.map((item) => item.id), ['b', 'f', 'e', 'd', 'c'])
  assert.equal(recent[0].current, true)
  assert.equal(recent[1].current, false)
  assert.equal(recent[0].name, 'B')
  assert.deepEqual(pack.recentPacks({ packs: [{ id: 'x' }], current: null }).map((item) => item.updatedAt), [null])
  assert.deepEqual(pack.recentPacks(null), [])
})

test('현황판 판단: pack 이 없으면 legacy, 팩 · 세대가 같아야 current (A→B→A 의 옛 A 는 stale)', () => {
  const current = { id: 'acme', generation: 3 }
  assert.equal(pack.boardIdentity({ cards: [] }, current), 'legacy')
  assert.equal(pack.boardIdentity({ pack: { id: 'acme', generation: 3 } }, current), 'current')
  assert.equal(pack.boardIdentity({ pack: { id: 'acme', generation: 1 } }, current), 'stale')
  assert.equal(pack.boardIdentity({ pack: { id: 'globex', generation: 3 } }, current), 'stale')
  assert.equal(pack.boardIdentity({ pack: { id: 'acme', generation: 3 } }, null), 'stale')
})

test('현황판 포트: pack status 의 boardPort 만 · 실패 · 이상한 값은 null(옛 본체 — 앱 설정)', () => {
  assert.equal(pack.statusBoardPort({ ok: true, boardPort: 4710 }), 4710)
  assert.equal(pack.statusBoardPort({ ok: true }), null)
  assert.equal(pack.statusBoardPort({ ok: true, boardPort: '4710' }), null)
  assert.equal(pack.statusBoardPort({ ok: false, boardPort: 4710 }), null)
  assert.equal(pack.statusBoardPort({ ok: true, boardPort: 70000 }), null)
})

test('바꾸기 점검: 막는 작업 · 밖의 에이전트 · pid 를 모름', () => {
  // 에이전트가 없으면 pid 없이도 진행
  assert.equal(pack.switchCheck({ panes: [{ id: 'p1', agent: 'claude', agent_status: 'working' }], busy: [] }).canProceed, true)
  // pid 를 모르면(옛 데몬 · busy 에 pid 없음) 가릴 수 없다 — 닫기 전에 멈춘다
  const unknown = pack.switchCheck({ panes: [{ id: 'p1', agent: 'claude' }], busy: [{ kind: 'agent' }] })
  assert.equal(unknown.unknownAgents, true)
  assert.equal(unknown.canProceed, false)
  // pid 조상으로 가린다 — 셸 pane(에이전트 없음)이 섞여 있어도 밖의 에이전트를 놓치지 않는다
  const parentOf = new Map([[501, 101], [601, 1], [101, 1], [102, 1]])
  const panes = [{ id: 'p1', pid: 101, agent: 'claude', agent_status: 'idle' }, { id: 'p2', pid: 102, agent: null }]
  const mixed = pack.switchCheck({ panes, busy: [{ kind: 'athena', pid: 501 }, { kind: 'agent', pid: 601 }], parentOf })
  assert.equal(mixed.externalAgents, 1)
  assert.equal(mixed.canProceed, false)
  assert.equal(pack.switchCheck({ panes, busy: [{ kind: 'athena', pid: 501 }], parentOf }).canProceed, true)
  assert.equal(pack.switchCheck({ panes: [...panes, { id: 'p3', agent: null }], busy: [{ kind: 'agent', pid: 501 }], parentOf }).unknownAgents, true)
  // QA · 배우기 검토는 코어가 끈다(5.2 · Q7) — 막지 않는다. 무거운 명령 · 바꾸기 중은 막는다
  assert.equal(pack.switchCheck({ panes: [], busy: [{ kind: 'qa', what: 'x' }, { kind: 'learn-review' }] }).canProceed, true)
  const heavy = pack.switchCheck({ panes: [], busy: [{ kind: 'heavy', what: 'next build' }] })
  assert.equal(heavy.blockers.length, 1)
  assert.equal(heavy.canProceed, false)
  assert.deepEqual(pack.remainingBusy([{ kind: 'qa' }, { kind: 'learn-review' }, { kind: 'heavy' }]).map((item) => item.kind), ['heavy'])
})

test('닫을 pane(R2): busy 에이전트를 품은 pane · athena 작업 공간 · 본체 · 데이터 폴더 안만 — 다른 프로젝트 claude 는 둔다', () => {
  const parentOf = new Map([[701, 201], [801, 206], [201, 1], [206, 1]])
  const panes = [
    { id: 'a', pid: 201, agent: 'claude', agent_status: 'working', workspace_id: 'w2', cwd: '/Users/me/work/x' }, // busy 에이전트(위임) 품음
    { id: 'b', pid: 202, agent: null, workspace_id: 'w1', cwd: '/Users/me' }, // athena 작업 공간
    { id: 'c', pid: 203, agent: null, workspace_id: 'w2', cwd: '/Users/me/athena/scripts' }, // 본체 안
    { id: 'd', pid: 204, agent: null, workspace_id: 'w2', cwd: '/Users/me/athena-data/packs/acme' }, // 데이터 폴더 안
    { id: 'e', pid: 205, agent: null, workspace_id: 'w2', cwd: '/Users/me/athena-other' }, // 이름만 비슷
    { id: 'f', pid: 206, agent: 'claude', agent_status: 'working', workspace_id: 'w3', cwd: '/Users/me/project' }, // 다른 프로젝트 claude — busy 에 없음
  ]
  const workspaces = [{ id: 'w1', label: 'athena' }, { id: 'w2', label: 'x' }, { id: 'w3', label: 'project' }]
  const check = pack.switchCheck({ panes, busy: [{ kind: 'agent', pid: 701 }], parentOf, workspaces, athenaDirs: ['/Users/me/athena', '/Users/me/athena-data'] })
  assert.deepEqual(check.close, ['a', 'b', 'c', 'd'])
  // 기다리기 · 멈추기는 닫을 pane 안의 에이전트만 — 다른 프로젝트에서 일하는 f 때문에 기다리지 않는다
  assert.deepEqual(check.working, ['a'])
  assert.equal(check.canProceed, true)
  // 링크로 들어간 폴더도 실제 경로로 풀어 본다 · '..cache' 는 안쪽
  const resolve = (dir) => dir.replace('/Users/me/link', '/Users/me/athena')
  assert.deepEqual(pack.panesToClose({ panes: [{ id: 'g', cwd: '/Users/me/link/x' }], workspaces: [], athenaDirs: ['/Users/me/athena'], resolve }), ['g'])
  assert.equal(pack.insideDir('/Users/me/athena/..cache', '/Users/me/athena'), true)
  assert.equal(pack.insideDir('/Users/me/athena-x', '/Users/me/athena'), false)
  assert.equal(pack.insideDir('/Users/me', '/Users/me/athena'), false)
})

test('데이터 폴더(R1): pack status 의 dataDir 절대 경로만 · 옛 응답이면 null', () => {
  assert.equal(pack.statusDataDir({ ok: true, dataDir: '/Users/me/athena-data' }), '/Users/me/athena-data')
  assert.equal(pack.statusDataDir({ ok: true }), null)
  assert.equal(pack.statusDataDir({ ok: true, dataDir: 'relative/dir' }), null)
  assert.equal(pack.statusDataDir({ ok: false, dataDir: '/x' }), null)
})

test('기본 본체: 저장된 것이 유효하면 그것, 아니면 ~/athena, 둘 다 없으면 null', () => {
  const valid = new Set(['/Users/me/athena', '/Users/me/other'])
  const isAthena = (dir) => valid.has(dir)
  assert.equal(pack.defaultAthenaDir({ athenaDir: '/Users/me/other' }, '/Users/me/athena', isAthena), '/Users/me/other')
  assert.equal(pack.defaultAthenaDir({ athenaDir: '/gone' }, '/Users/me/athena', isAthena), '/Users/me/athena')
  assert.equal(pack.defaultAthenaDir({ athenaDir: null }, '/nope', isAthena), null)
})

test('~/athena 로 옮기기: 스튜디오 레포 athena/ 를 쓰고 ~/athena 가 여러 팩을 지원할 때 한 번만', () => {
  const sameDir = (left, right) => path.resolve(left) === path.resolve(right)
  const base = { config: { athenaDir: '/repo/athena', homeAthenaAsked: false }, studioAthena: '/repo/athena', homeSupportsPacks: true, sameDir }
  assert.equal(pack.shouldOfferMoveToHome(base), true)
  assert.equal(pack.shouldOfferMoveToHome({ ...base, homeSupportsPacks: false }), false)
  assert.equal(pack.shouldOfferMoveToHome({ ...base, config: { athenaDir: '/repo/athena', homeAthenaAsked: true } }), false)
  assert.equal(pack.shouldOfferMoveToHome({ ...base, config: { athenaDir: '/Users/me/athena' } }), false)
})

test('비교 줄: 있는 정보만 이어 쓴다', () => {
  assert.equal(pack.packSummary({ repos: 3, updatedAt: '2026-10-15T01:00:00Z', hasWork: true, source: 'git' }), '레포 3 · 마지막 변경 2026-10-15 · 작업 기록 있음 · git')
  assert.equal(pack.packSummary(null), '')
})
