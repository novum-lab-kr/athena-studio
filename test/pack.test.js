const test = require('node:test')
const assert = require('node:assert/strict')
const pack = require('../src/lib/pack.mts')

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
  assert.match(pack.packErrorText({ ok: false, error: 'rollback', message: '링크 실패' }), /되돌렸습니다 — 링크 실패/)
  assert.match(pack.packErrorText({ ok: false, error: 'weird' }), /실패했습니다/)
  assert.match(pack.packErrorText({ ok: false, error: 'failed', message: 'x' }), /예상하지 못한 오류가 났습니다 — x/)
  assert.equal(pack.packErrorText({ ok: true }), '')
  // pack open 오류 · busy 종류 codex · unknown 도 사전 문구로(모르는 코드 '팩 명령이 실패했습니다' 로 빠지지 않게)
  assert.match(pack.packErrorText({ ok: false, error: 'port-in-use' }), /빈 포트가 없습니다/)
  assert.match(pack.packErrorText({ ok: false, error: 'body-conflict', message: 'x' }), /다른 폴더가 있습니다.* — x/)
  for (const code of ['body-mismatch', 'data-incompatible']) assert.doesNotMatch(pack.packErrorText({ ok: false, error: code }), /팩 명령이 실패했습니다/)
  const busyKinds = pack.packErrorText({ ok: false, error: 'busy', busy: [{ kind: 'codex', pid: 3 }, { kind: 'unknown', what: 'node' }] })
  assert.match(busyKinds, /Codex 세션 \(pid 3\)/)
  assert.match(busyKinds, /확인하지 못한 프로세스 — node/)
})

test('git 주소: https · ssh · git@ 만, 셸 문자 · 비밀번호 · 옵션 모양은 거절', () => {
  assert.ok(pack.validGitUrl('https://github.com/acme/acme-pack.git'))
  assert.ok(pack.validGitUrl('  git@github.com:acme/acme-pack.git '))
  assert.ok(pack.validGitUrl('ssh://git@github.com/acme/pack.git'))
  assert.ok(pack.validGitUrl('https://user@github.com/acme/pack.git')) // 사용자 이름만은 괜찮다
  assert.equal(pack.validGitUrl('other@github.com:acme/pack.git'), null) // scp 모양은 git@ 만
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

test('팩 목록: 빈 자리(emptySlots)도 empty 팩으로 — 다른 팩으로 넘어간 뒤에도 다시 연다', () => {
  const list = pack.normalizePackList({ ok: true, current: { id: 'new-2', empty: true }, packs: [{ id: 'acme' }], emptySlots: [{ id: 'new-1', body: '/b/new-1' }, { id: 'new-2', body: '/b/new-2' }, { id: 'acme' }, null] })
  assert.deepEqual(list.packs.map((item) => [item.id, Boolean(item.empty)]), [['acme', false], ['new-1', true], ['new-2', true]])
  assert.equal(pack.showPackWelcome({ supported: true, packs: [{ id: 'new-1', empty: true }], current: null }), true) // 빈 자리만 — 팩은 아직 없다
  assert.equal(pack.welcomeOnLaunch({ list: { supported: true, packs: [{ id: 'new-1', empty: true }] }, agentPanes: 0 }), false)
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
  // 표시 이름이 있으면 그걸로
  assert.equal(pack.recentPacks({ packs: [{ id: 'x', name: 'x', displayName: '엑스 회사' }], current: null })[0].name, '엑스 회사')
})

test('팩 표시 이름 · 이미지: displayName → name → id · 본체가 준 iconPath 만 · 앞 바이트로 형식', () => {
  assert.equal(pack.packLabel({ id: 'a', name: 'acme', displayName: '에이크미' }), '에이크미')
  assert.equal(pack.packLabel({ id: 'a', name: 'acme', displayName: null }), 'acme')
  assert.equal(pack.packLabel({ id: 'a' }), 'a')
  assert.equal(pack.packLabel(null), '')
  const list = { current: { id: 'a', iconPath: '/d/packs/a/assets/icon.png' }, packs: [{ id: 'b', iconPath: '/d/packs/b/assets/icon.svg' }, { id: 'c', iconPath: 'rel/icon.png' }, { id: 'd', iconPath: '/d/packs/d/assets/icon.WEBP' }] }
  assert.equal(pack.packIconPath(list, 'a'), '/d/packs/a/assets/icon.png')
  assert.equal(pack.packIconPath(list, 'b'), null) // svg 거부
  assert.equal(pack.packIconPath(list, 'c'), null) // 상대 경로 거부
  assert.equal(pack.packIconPath(list, 'd'), '/d/packs/d/assets/icon.WEBP')
  assert.equal(pack.packIconPath(list, 'zz'), null)
  const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(12)])
  assert.equal(pack.iconMime(pad([0x89, 0x50, 0x4e, 0x47])), 'image/png')
  assert.equal(pack.iconMime(pad([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(pack.iconMime(Buffer.from('RIFF0000WEBPVP8 ', 'latin1')), 'image/webp')
  assert.equal(pack.iconMime(Buffer.from('GIF89a000000', 'latin1')), null)
  assert.equal(pack.iconMime(Buffer.from('<svg xmlns="', 'latin1')), null)
  assert.equal(pack.ICON_MAX_BYTES, 1024 * 1024)
})

test('레포 표시 이름 · 이미지: 규칙에 맞는 displayName 만 · icon 은 그 레포 자리(assets/repos/<name>.*)만', () => {
  assert.deepEqual(pack.repoLook({ name: 'shop-web', displayName: '  쇼핑 웹 ', icon: 'assets/repos/shop-web.png' }), { displayName: '쇼핑 웹', icon: 'assets/repos/shop-web.png' })
  assert.deepEqual(pack.repoLook({ name: 'shop-web' }), { displayName: null, icon: null })
  assert.equal(pack.repoLook({ name: 'a', displayName: '가'.repeat(41) }).displayName, null) // 41자
  assert.equal(pack.repoLook({ name: 'a', displayName: 'a\nb' }).displayName, null) // 줄바꿈
  assert.equal(pack.repoLook({ name: 'a', displayName: 'abc‮def' }).displayName, null) // 글자 방향 문자
  assert.equal(pack.repoLook({ name: 'a', displayName: '   ' }).displayName, null)
  assert.equal(pack.repoLook({ name: 'a', displayName: 3 }).displayName, null)
  assert.equal(pack.repoLook({ name: 'api', icon: 'assets/repos/api.webp' }).icon, 'assets/repos/api.webp')
  assert.equal(pack.repoLook({ name: 'api', icon: 'assets/repos/shop-web.png' }).icon, null) // 다른 레포 자리
  assert.equal(pack.repoLook({ name: 'api', icon: 'assets/repos/api.svg' }).icon, null)
  assert.equal(pack.repoLook({ name: 'api', icon: '../../etc/hosts' }).icon, null)
  assert.equal(pack.repoLook({ name: 'api', icon: 'assets/repos/api.png/../../x.png' }).icon, null)
  assert.equal(pack.repoLook({ name: '..', icon: 'assets/repos/...png' }).icon, null) // 이름이 . 으로 시작
  assert.deepEqual(pack.repoLook(null), { displayName: null, icon: null })
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

test('비교 줄: 있는 정보만 이어 쓴다', () => {
  assert.equal(pack.packSummary({ repos: 3, updatedAt: '2026-10-15T01:00:00Z', hasWork: true, source: 'git' }), '레포 3 · 마지막 변경 2026-10-15 · 작업 기록 있음 · git')
  assert.equal(pack.packSummary(null), '')
})

test('코어 약속 번호: version 결과 → contract · 옛 코어(명령 없음 · 실패)는 1', () => {
  assert.equal(pack.CONTRACT, 3)
  assert.deepEqual(pack.contractOf({ ok: true, core: 'abc', contract: 2 }), { contract: 2, core: 'abc' })
  assert.deepEqual(pack.contractOf({ ok: true, contract: 3 }), { contract: 3, core: null })
  assert.deepEqual(pack.contractOf({ ok: false, error: 'bad-output' }), { contract: 1, core: null })
  assert.deepEqual(pack.contractOf({ ok: false, error: 'usage' }), { contract: 1, core: null })
  assert.deepEqual(pack.contractOf({ ok: true }), { contract: 1, core: null })
  // 일시 실패 · 본체 없음은 모름(null) — 옛 코어로 단정하지 않는다
  assert.deepEqual(pack.contractOf({ ok: false, error: 'timeout' }), { contract: null, core: null })
  assert.deepEqual(pack.contractOf({ ok: false, error: 'not-found' }), { contract: null, core: null })
  assert.deepEqual(pack.contractOf(null), { contract: null, core: null })
})

test('레포 대표 에이전트 — 단일 · 모노레포 · 이상한 이름은 빼기', () => {
  assert.equal(pack.repoAgent({ name: 'web', agents: ['web-fe', 'web-be'] }), 'web-fe')
  assert.equal(pack.repoAgent({ name: 'mono', apps: { shop: { agent: 'shop-fe' } }, packagesAgent: 'mono-packages-fe' }), 'shop-fe')
  assert.equal(pack.repoAgent({ name: 'mono', apps: {}, packagesAgent: 'mono-packages-fe' }), 'mono-packages-fe')
  assert.equal(pack.repoAgent({ name: 'x', agents: ['bad; rm -rf'] }), null)
  assert.equal(pack.repoAgent({ name: 'x' }), null)
})

test('⚙ 설정 — 레포별 자동 머지 줄(main 직접 레포 빼기 · 키 없으면 끔 · 묻기 · 머지가 곧 운영 반영)', () => {
  const rows = pack.mergeSettings({
    repos: [
      { name: 'web', branch: 'main', prBase: 'main', autoMerge: true, autoMergeConfirm: false },
      { name: 'api', branch: 'prd', prBase: 'dev' },
      { name: 'mobile', branch: 'main', prBase: 'main', direct: true, autoMerge: true },
      { name: 'odd', branch: 'main', prBase: 'main', autoMerge: 'true', autoMergeConfirm: 'false', autoReview: 'false', autoMergeManual: 'true' },
      { name: 'solo', branch: 'main', prBase: 'main', autoMerge: true, autoReview: false, autoMergeManual: true, autoMergeConfirm: false },
      { name: 'bad; rm' },
    ],
  })
  assert.deepEqual(rows, [
    { name: 'web', autoMerge: true, review: true, mergeMode: 'auto', releaseOnMerge: true, prBase: 'main' },
    { name: 'api', autoMerge: false, review: true, mergeMode: 'confirm', releaseOnMerge: false, prBase: 'dev' },
    // 글자 "true" · "false" 는 켬 · 안 묻기가 아니다(docs/pr-auto.md — 불리언만)
    { name: 'odd', autoMerge: false, review: true, mergeMode: 'confirm', releaseOnMerge: true, prBase: 'main' },
    // 사람이 직접이 자동보다 먼저
    { name: 'solo', autoMerge: true, review: false, mergeMode: 'manual', releaseOnMerge: true, prBase: 'main' },
  ])
  assert.deepEqual(pack.mergeSettings(null), [])
  assert.deepEqual(pack.mergeSettings({}), [])
  assert.ok(pack.packErrorText({ ok: false, error: 'not-applicable' }).includes('main 직접'))
})

test('레포 에이전트 부르기 — call-branch-info · new-branch 출력 · 브랜치 이름', () => {
  const info = pack.parseCallInfo('target\tweb\nrepo\tweb\nmain\t## main...origin/main [behind 1]\t2\ncandidate\tfeature/T-1\t로컬\t2026-10-18 · 커밋 3\t/w/.worktrees/web/feature-T-1\n')
  assert.equal(info.target, 'web')
  assert.equal(info.main.status, 'main...origin/main [behind 1]')
  assert.equal(info.main.dirty, 2)
  assert.equal(info.main.branch, 'main')
  assert.deepEqual(info.candidates[0], { branch: 'feature/T-1', place: 'local', date: '2026-10-18', subject: '· 커밋 3', noCommits: false, worktree: '/w/.worktrees/web/feature-T-1' })
  const fresh = pack.parseCallInfo('candidate\tcheck/1\t로컬·원격\t2026-10-18 (커밋 없음) branch: Created from origin/main\t-\n').candidates[0]
  assert.deepEqual(fresh, { branch: 'check/1', place: 'both', date: '2026-10-18', subject: '', noCommits: true, worktree: null })
  assert.equal(info.direct, null)
  assert.equal(pack.parseCallInfo('target\tapp\ndirect\t/w/repos/app\n').direct, '/w/repos/app')
  assert.equal(pack.parseNewBranch('✅ web — 새 브랜치\n        워크트리: /d/worktrees/web/feature-T-2\n').worktree, '/d/worktrees/web/feature-T-2')
  const exists = pack.parseNewBranch('⚠️  web — 브랜치 feature/T-1 가 이미 있다 (로컬)\n        그대로 이어 쓰려면 --reuse\n')
  assert.equal(exists.exists, true)
  assert.equal(exists.worktree, null)
  assert.equal(pack.parseNewBranch('⏭  web — 워크트리 경로가 이미 있다: /d/wt\n').worktree, '/d/wt')
  for (const ok of ['PROJ-123', 'fix/login', '로그인-수정']) assert.equal(pack.validBranchInput(ok), true, ok)
  for (const bad of ['', '-x', 'a..b', 'fix/', 'a b', 'x.lock', 'a;rm']) assert.equal(pack.validBranchInput(bad), false, bad)
})

test('git status 머리줄 풀기 — 원격과 비교', () => {
  assert.deepEqual(pack.parseBranchStatus('main...origin/main [behind 1]'), { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 1, gone: false })
  assert.deepEqual(pack.parseBranchStatus('dev...origin/dev [ahead 2, behind 3]'), { branch: 'dev', upstream: 'origin/dev', ahead: 2, behind: 3, gone: false })
  assert.equal(pack.parseBranchStatus('main...origin/main').ahead, 0)
  assert.equal(pack.parseBranchStatus('feature/x').upstream, null)
  assert.equal(pack.parseBranchStatus('main...origin/main [gone]').gone, true)
  assert.equal(pack.parseBranchStatus('No commits yet on main').branch, 'main')
  assert.equal(pack.parseCallInfo('main\t## main...origin/main [behind 1]\t0\n').main.behind, 1)
})

test('coreTooOld: "알 수 없는 답" 뒤 version 으로 본체 코어가 옛 버전인지 가린다', () => {
  const repoIcon = ['pack', 'set-repo-icon', 'shop', '/tmp/a.png']
  // 약속이 같고 손잡이가 없으면 옛 코어(set-repo-icon 전 코어 · 2026-10-26)
  assert.equal(pack.coreTooOld(repoIcon, { ok: true, contract: 3, capabilities: ['update', 'idle-panes'] }), true)
  // 손잡이가 있으면 진짜 이상한 답 — 그대로 둔다
  assert.equal(pack.coreTooOld(repoIcon, { ok: true, contract: 3, capabilities: ['repo-look'] }), false)
  // 리뷰 · 머지 나누기(--review · --merge)를 모르는 코어 — 저장 실패가 아니라 옛 코어로 안내한다
  assert.equal(pack.coreTooOld(['pack', 'set-auto-merge', 'shop', '--review', 'off'], { ok: true, contract: 3, capabilities: ['repo-look'] }), true)
  assert.equal(pack.coreTooOld(['pack', 'set-auto-merge', 'shop'], { ok: true, contract: 3, capabilities: ['merge-flow'] }), false)
  // 약속이 낮으면(version 명령이 없는 코어 포함) 옛 코어
  assert.equal(pack.coreTooOld(['pack', 'set-auto-merge', 'shop'], { ok: true, contract: 2, capabilities: [] }), true)
  assert.equal(pack.coreTooOld(['pack', 'list'], { ok: false, error: 'bad-output' }), true)
  // 손잡이를 따로 두지 않은 명령은 약속이 같으면 옛 코어로 보지 않는다
  assert.equal(pack.coreTooOld(['pack', 'list'], { ok: true, contract: 3, capabilities: [] }), false)
  // version 을 못 물었으면(시간 초과 등) 모름 — 옛 코어라고 단정하지 않는다
  assert.equal(pack.coreTooOld(repoIcon, { ok: false, error: 'timeout' }), false)
  assert.equal(pack.ERROR_CODES.includes('core-old'), true)
  assert.match(pack.packErrorText({ ok: false, error: 'core-old' }), /옛 버전/)
})
