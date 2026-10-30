'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { installPackRepos, setMergeFromScreen } = require('../src/main/pack-repos.mts')

// 화면이 넘긴 값 → IPC 핸들러 → pack-repos → 코어 인자까지. 코어 명령은 부른 인자만 남기는 가짜
function setUp() {
  const calls = []
  const ctx = { athenaDir: '/tmp/body' }
  installPackRepos(ctx, {
    say: (key) => key,
    runPack: async (args) => { calls.push(args); return { ok: true } },
    daemonPaths: () => ({ socket: '' }),
  })
  return { ctx, calls }
}

test('자동 PR 스위치 — auto 값이 코어 인자 --auto 까지 간다', async () => {
  for (const auto of ['on', 'off', 'direct']) {
    const { ctx, calls } = setUp()
    await setMergeFromScreen(ctx, 'shop', { auto })
    assert.deepEqual(calls, [['set-auto-merge', 'shop', '--auto', auto]])
  }
})

test('모르는 auto 값은 넘기지 않는다', async () => {
  for (const auto of ['none', '', 1, true, null]) {
    const { ctx, calls } = setUp()
    await setMergeFromScreen(ctx, 'shop', { auto })
    assert.deepEqual(calls, [['set-auto-merge', 'shop']])
  }
})

test('리뷰 · 머지 값은 그대로 · 모르는 값과 빈 값은 뺀다', async () => {
  const { ctx, calls } = setUp()
  await setMergeFromScreen(ctx, 'shop', { auto: 'direct', review: false, merge: 'confirm' })
  await setMergeFromScreen(ctx, 'shop', { review: 'off', merge: 'later' })
  await setMergeFromScreen(ctx, 'shop', null)
  assert.deepEqual(calls, [
    ['set-auto-merge', 'shop', '--auto', 'direct', '--review', 'off', '--merge', 'confirm'],
    ['set-auto-merge', 'shop'],
    ['set-auto-merge', 'shop'],
  ])
})

test('main 의 settings:set-merge 가 이 핸들러를 쓴다', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.mts'), 'utf8')
  assert.match(main, /handle\('settings:set-merge', setMergeFromScreen\)/)
})
