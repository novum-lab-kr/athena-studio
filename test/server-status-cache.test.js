// @ts-check
'use strict'
// 서버 상태 읽기 캐시 — 맥 화면 · 폰 브리지가 같은 ctx.serverStatus 를 부른다.
// 폰은 snapshot 마다 부르니(2초 남짓) 부를 때마다 ssh 를 돌면 서버가 버티지 못한다(2026-11-19 load 29).
// 가짜 ssh-run.sh 가 부른 인자를 파일에 한 줄씩 남겨 ssh 횟수를 센다
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir } = require('./temp-dirs.js')
const { installServerStatus } = require('../src/main/server-status.mts')

const STATUS = ['==load', '0.10 0.10 0.10 1/100 1', '==cpu', '2', '==end', ''].join('\n')

/** @param {{ name: string, host: string }[]} servers */
function setUp(servers) {
  const dir = tempDir('server-status-cache-')
  const log = path.join(dir, 'calls.log')
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.mkdirSync(path.join(dir, 'pack'))
  fs.writeFileSync(path.join(dir, 'pack', 'pack.json'), JSON.stringify({ servers }))
  // 조금 늦게 답한다 — 읽는 중에 또 부르면 같은 읽기를 나눠 쓰는지 보려고
  fs.writeFileSync(
    path.join(dir, 'scripts', 'ssh-run.sh'),
    `echo "$1 $2" >> ${JSON.stringify(log)}\nsleep 0.2\nif [ "$2" = "--status" ]; then printf '%s' ${JSON.stringify(STATUS)}; fi\n`,
  )
  /** @type {import('../src/main/server-status.mts').ServerStatusCtx} */
  const ctx = { athenaDir: dir }
  installServerStatus(ctx)
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])
  const read = () => {
    if (!ctx.serverStatus) throw new Error('serverStatus 없음')
    return ctx.serverStatus()
  }
  return { dir, calls, read }
}

test('잇달아 불러도(폰 snapshot) 서버마다 ssh 는 한 번 — 앞 읽기 값을 그대로', async () => {
  const { calls, read } = setUp([{ name: 'web', host: 'web-host' }])
  const first = await read()
  const again = []
  for (let index = 0; index < 5; index += 1) again.push(await read())
  assert.deepEqual(calls().filter((line) => line.endsWith('--status')), ['web --status'])
  for (const reply of again) assert.equal(reply, first)
  assert.equal(first.servers[0]?.name, 'web')
})

test('읽는 중에 함께 부르면 같은 읽기를 나눠 쓴다', async () => {
  const { calls, read } = setUp([{ name: 'web', host: 'web-host' }])
  const replies = await Promise.all([read(), read(), read()])
  assert.equal(replies[1], replies[0])
  assert.equal(replies[2], replies[0])
  assert.deepEqual(calls().filter((line) => line.endsWith('--status')), ['web --status'])
})

test('팩 서버 목록이 바뀌면 기다리지 않고 새로 읽는다', async () => {
  const { dir, calls, read } = setUp([{ name: 'web', host: 'web-host' }])
  await read()
  fs.writeFileSync(path.join(dir, 'pack', 'pack.json'), JSON.stringify({ servers: [{ name: 'web', host: 'web-host' }, { name: 'db', host: 'db-host' }] }))
  const next = await read()
  assert.deepEqual(next.servers.map((server) => server.name), ['web', 'db'])
  assert.deepEqual(calls().filter((line) => line.endsWith('--status')).sort(), ['db --status', 'web --status', 'web --status'])
})

test('맥 화면 주기(3분)가 돌아오면 다시 읽는다', async () => {
  const { calls, read } = setUp([{ name: 'web', host: 'web-host' }])
  const realNow = Date.now
  try {
    await read()
    const later = realNow() + 3 * 60 * 1000
    Date.now = () => later
    await read()
  } finally {
    Date.now = realNow
  }
  assert.deepEqual(calls().filter((line) => line.endsWith('--status')), ['web --status', 'web --status'])
})
