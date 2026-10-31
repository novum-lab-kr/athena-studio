const test = require('node:test')
const assert = require('node:assert/strict')
const { oldPanesNotice, oldPanesView } = require('../src/lib/open-panes.mts')

test('이름표에서 브랜치 · 에이전트를, 폴더는 지금 폴더를 홈 줄여서 보여 준다', () => {
  const view = oldPanesView([{ id: 'p1', label: '🤖 athena-studio-fe · feat/daemon', agent: 'claude', cwd: '/home/me/a', foreground_cwd: '/home/me/a/b' }], '/home/me')
  assert.deepEqual(view.rows[0], { name: 'daemon', who: 'athena-studio-fe', folder: '~/a/b', tip: 'feat/daemon\nathena-studio-fe\n/home/me/a/b' })
})

test('이름표가 없으면 제목 · id 로, 에이전트는 감지한 것으로', () => {
  const { rows } = oldPanesView([{ id: 'p1', title: '✳ 대화 주제', agent: 'claude', cwd: '/x' }, { id: 'p2', cwd: '/home/me' }], '/home/me')
  assert.deepEqual(rows.map((row) => [row.name, row.who, row.folder]), [['대화 주제', 'claude', '/x'], ['p2', '', '~']])
})

test('많으면 에이전트 pane 부터 일부만 보이고 나머지 수를 준다', () => {
  const view = oldPanesView([{ id: 'p1' }, { id: 'p2', agent: 'claude' }, { id: 'p3' }], '', 2)
  assert.deepEqual(view.rows.map((row) => row.name), ['p2', 'p1'])
  assert.equal(view.total, 3)
  assert.equal(view.more, 1)
})

test('닫을 pane 이 0개면 안내하지 않는다', async () => {
  assert.equal(await oldPanesNotice(async () => ({ panes: [] }), ''), null)
})

test('목록을 읽지 못하면(실패 · 이상한 답) 0개로 치지 않고 안내하지 않는다', async () => {
  assert.equal(await oldPanesNotice(async () => { throw new Error('실패') }, ''), null)
  assert.equal(await oldPanesNotice(async () => ({}), ''), null)
  assert.equal(await oldPanesNotice(async () => null, ''), null)
})

test('pane 이 있으면 안내할 값을 준다', async () => {
  const view = await oldPanesNotice(async () => ({ panes: [{ id: 'p1' }] }), '')
  assert.equal(view.total, 1)
})
