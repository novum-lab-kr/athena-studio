const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { installPaneWatch } = require('../src/main/pane-watch.mts')

// 아무도 듣지 않는 포트 — 현황판이 꺼진 상태
const closedPort = () =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

// 가짜 본체 — 코어 plan-bind.mjs(레포 athena/ 정본) · 계획서 하나 · pane 기록 하나
function makeBody() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-studio-pane-watch-'))
  fs.mkdirSync(path.join(root, 'scripts', 'board'), { recursive: true })
  fs.copyFileSync(path.join(__dirname, '..', 'athena', 'scripts', 'board', 'plan-bind.mjs'), path.join(root, 'scripts', 'board', 'plan-bind.mjs'))
  fs.mkdirSync(path.join(root, 'plans', 'task'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'plans', 'task', '20261029-버그.md'),
    ['# 버그', '', '## Checkpoint', '- Status: in_progress', '- Lead pane: p1', '- Work ref: /wt · 🌿 fix/bug · pane p7 (athena-studio-fe)', '', '## 지시', ''].join('\n'),
  )
  // 같은 계획서로 다시 띄운 pane 기록(Work ref 에는 없다)
  const sessions = path.join(root, '.pack-data', 'state', 'pane-sessions')
  fs.mkdirSync(sessions, { recursive: true })
  fs.writeFileSync(path.join(sessions, 'p9.json'), JSON.stringify({ pane: 'p9', agent: 'reviewer', plan: 'plans/task/20261029-버그.md' }))
  return root
}

test('현황판이 꺼져 있어도 계획서에 묶인 pane 을 알린다(머리 줄 [상세])', async () => {
  const root = makeBody()
  const port = await closedPort()
  const panes = [
    { id: 'p1', agent: 'claude', agent_status: 'idle', cwd: root },
    { id: 'p7', label: '🤖 athena-studio-fe · fix/bug', agent: 'claude', agent_status: 'working', cwd: '/wt' },
    { id: 'p9', label: '🤖 reviewer · fix/bug', agent: 'claude', agent_status: 'idle', cwd: '/wt' },
    { id: 'p5', label: '🤖 other-fe · fix/other', agent: 'claude', agent_status: 'idle', cwd: '/x' },
    { id: 'p3', agent: null, cwd: root },
  ]
  const sent = []
  const ctx = {
    athenaDir: root,
    win: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false },
    isAttached: () => true,
    boardPortNow: () => port,
    send: (channel, value) => sent.push([channel, value]),
    daemonCall: async (method) => (method === 'pane list' ? { result: { panes } } : { result: { workspaces: [] } }),
    catchUpBody: async () => {},
  }
  installPaneWatch(ctx, { monitor: {}, paneTokens: {} })
  await ctx.pollPanes()
  // 묶인 pane 계산은 기다리지 않고 돈다 — 알림이 올 때까지
  for (let tries = 0; tries < 50 && !sent.some(([channel]) => channel === 'screen:pane-bound'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  const bound = sent.find(([channel]) => channel === 'screen:pane-bound')
  assert.ok(bound, '현황판 없이도 screen:pane-bound 를 보낸다')
  assert.deepEqual(bound[1], { p7: 'agent', p9: 'agent', p1: 'lead' })
  assert.deepEqual(ctx.paneBound(), bound[1])
  fs.rmSync(root, { recursive: true, force: true })
})
