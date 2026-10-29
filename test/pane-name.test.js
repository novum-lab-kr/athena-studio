'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../athena/scripts/lib/pane-name.mjs')
const config = {
  repos: [
    { name: 'syung', displayName: '슝', agents: ['syung-fe'] },
    { name: 'novum-web', agents: ['web-fe'], packagesAgent: 'web-pkg', apps: { shop: { agent: 'shop-fe' } } },
  ],
}

test('레포 하나면 표시 이름 · 없으면 name', async () => {
  const { repoLabelOfAgents } = await load()
  assert.equal(repoLabelOfAgents(config, ['syung-fe']), '슝')
  assert.equal(repoLabelOfAgents(config, ['shop-fe', 'web-pkg']), 'novum-web')
})

test('표시 이름이 같은 서로 다른 레포도 +N 으로 센다', async () => {
  const { repoLabelOfAgents } = await load()
  const same = { repos: [{ name: 'a', displayName: '웹', agents: ['a-fe'] }, { name: 'b', displayName: '웹', agents: ['b-fe'] }] }
  assert.equal(repoLabelOfAgents(same, ['a-fe', 'b-fe', 'a-fe']), '웹 +1')
})

test('여러 레포는 적힌 순서의 첫 레포 +N · 모르면 빈 값', async () => {
  const { repoLabelOfAgents } = await load()
  assert.equal(repoLabelOfAgents(config, ['web-fe', 'syung-fe']), 'novum-web +1')
  assert.equal(repoLabelOfAgents(config, ['reviewer', 'athena']), '')
})

test('계획서 글에서 에이전트 읽기 — 경량 Agent 줄 · 정식 작업 배분 표', async () => {
  const { agentsOfPlan } = await load()
  assert.deepEqual(agentsOfPlan('- Agent: web-fe\n'), ['web-fe'])
  const formal = '## 6. 작업 배분\n\n| 담당 | 작업 내용 | 의존성 |\n|------|------|------|\n| syung-fe | a | 없음 |\n| web-fe | b | 없음 |\n| reviewer | c | FE |\n\n## 7. 검증\n| x-fe | y | z |\n'
  assert.deepEqual(agentsOfPlan(formal), ['syung-fe', 'web-fe', 'reviewer'])
})

test('이름표 — 레포 · 제목 앞 30자 · 제목이 비면 빈 값', async () => {
  const { paneNameOf, repoLabelOfValue } = await load()
  assert.equal(paneNameOf('가'.repeat(40), 'syung'), `syung · ${'가'.repeat(30)}`)
  assert.equal(paneNameOf('제목', ''), '제목')
  assert.equal(paneNameOf('  ', 'syung'), '')
  assert.equal(repoLabelOfValue(config, 'novum-web/shop'), 'novum-web')
  assert.equal(repoLabelOfValue(config, 'athena'), '')
})
