const test = require('node:test')
const assert = require('node:assert/strict')
const names = require('../src/lib/space-names')

test('브랜치: / 앞 접두어 하나만 뗀다', () => {
  assert.equal(names.shortBranch('feat/fsd-work'), 'fsd-work')
  assert.equal(names.shortBranch('release/v.26.10.100'), 'v.26.10.100')
  assert.equal(names.shortBranch('user/a/b'), 'a/b')
  assert.equal(names.shortBranch('main'), 'main')
  assert.equal(names.shortBranch('feat/'), 'feat/')
})

test('역할: 레포 이름을 뗀다 · 레포로 시작하지 않으면 그대로', () => {
  assert.equal(names.agentRole('fsd-agent-team-fe', 'fsd-agent-team'), 'fe')
  assert.equal(names.agentRole('reviewer', 'fsd-agent-team'), 'reviewer')
  assert.equal(names.agentRole('bznav-refund-fe', 'bznav-web'), 'bznav-refund-fe')
  assert.equal(names.agentRole('fsd-agent-team-', 'fsd-agent-team'), 'fsd-agent-team-')
})

test('pane 줄: delegate 이름표는 브랜치 · 역할로 · 아니면 이름 그대로', () => {
  assert.deepEqual(names.paneRow({ id: 'p2', label: '🤖 fsd-agent-team-fe · feat/fsd-work' }, 'fsd-agent-team'), {
    branch: 'fsd-work',
    role: 'fe',
    tip: 'feat/fsd-work\nfsd-agent-team-fe',
  })
  assert.deepEqual(names.paneRow({ id: 'p3', label: '🤖 reviewer' }, 'x'), { branch: '🤖 reviewer', role: '', tip: '🤖 reviewer' })
  assert.deepEqual(names.paneRow({ id: 'p4', label: null, title: 'zsh' }, 'x'), { branch: 'zsh', role: '', tip: 'zsh' })
  assert.deepEqual(names.paneRow({ id: 'p5' }, 'x'), { branch: 'p5', role: '', tip: 'p5' })
})

test('pane 줄: 이름표가 없으면 터미널 제목에서 앞 상태 기호를 뗀다', () => {
  assert.equal(names.paneRow({ id: 'p1', title: '✳ 쿠폰 적용 순서 정리' }, 'athena').branch, '쿠폰 적용 순서 정리')
  assert.equal(names.paneRow({ id: 'p1', title: '⠂ 쿠폰 적용 순서 정리' }, 'athena').tip, '쿠폰 적용 순서 정리')
  assert.equal(names.paneRow({ id: 'p1', title: '✳ Claude Code' }, 'athena').branch, 'Claude Code')
  assert.equal(names.paneRow({ id: 'p1', title: '✳ ' }, 'athena').branch, 'p1')
  assert.equal(names.paneRow({ id: 'p1', label: '✳ 손으로 붙인 이름' }, 'athena').branch, '✳ 손으로 붙인 이름')
})
