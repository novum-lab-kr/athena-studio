const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { installExplorer } = require('../src/main/explorer-panel.mts')
const { createFiles } = require('../src/main/files.mts')

// 문구는 키 그대로 — 어느 문구를 냈는지 본다
const say = (key) => key

// 가짜 데몬 — state(작업 공간 폴더)와 pane list(살아 있는 pane 폴더)만 답한다
function fakeCtx(workspaces, panes) {
  const ctx = {
    async daemonCall(op) {
      if (op === 'state') return { result: { workspaces } }
      if (op === 'pane list') return { result: { panes } }
      throw new Error(`모르는 동작 ${op}`)
    },
  }
  installExplorer(ctx, { say, resolveInside: createFiles({ say }).resolveInside })
  return ctx
}

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-panel-')))
}

const pane = (id, workspace, cwd, focused = false) => ({ id, tab_id: 't1', workspace_id: workspace, cwd, foreground_cwd: cwd, focused })

test('작업 공간 폴더가 있으면 그 폴더를 읽는다', async () => {
  const root = tempDir()
  fs.writeFileSync(path.join(root, 'a.md'), 'a')
  const ctx = fakeCtx([{ id: 'w1', cwd: root }], [])
  assert.deepEqual((await ctx.explorerList('w1', '.')).entries.map((entry) => entry.name), ['a.md'])
})

test('작업 공간 폴더(지운 워크트리)가 없으면 그 작업 공간의 살아 있는 pane 폴더로 — 포커스된 pane 먼저', async () => {
  const base = tempDir()
  const gone = path.join(base, 'worktrees', 'docs-issue-templates') // 작업이 끝나 지운 워크트리(2026-10-28 w47)
  const first = path.join(base, 'first')
  const focused = path.join(base, 'focused')
  const other = path.join(base, 'other')
  for (const dir of [first, focused, other]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(focused, 'here.md'), 'x')
  const ctx = fakeCtx(
    [{ id: 'w47', cwd: gone }, { id: 'w1', cwd: other }],
    [pane('p1', 'w47', gone), pane('p2', 'w47', first), pane('p3', 'w47', focused, true), pane('p9', 'w1', other, true)],
  )
  assert.deepEqual((await ctx.explorerList('w47', '.')).entries.map((entry) => entry.name), ['here.md'])
  assert.deepEqual(await ctx.explorerStatus('w47'), { git: false, changes: [], root: focused, branch: null })
})

test('포커스된 pane 폴더도 없으면 그 작업 공간의 다음 pane 폴더 · 다른 작업 공간 pane 은 보지 않는다', async () => {
  const base = tempDir()
  const gone = path.join(base, 'gone')
  const first = path.join(base, 'first')
  fs.mkdirSync(first)
  fs.writeFileSync(path.join(first, 'first.md'), 'x')
  const ctx = fakeCtx([{ id: 'w47', cwd: gone }], [pane('p9', 'w1', base, true), pane('p1', 'w47', gone, true), pane('p2', 'w47', first)])
  assert.deepEqual((await ctx.explorerList('w47', '.')).entries.map((entry) => entry.name), ['first.md'])
})

test('작업 공간 폴더도 pane 폴더도 없으면 "폴더가 없어요"', async () => {
  const gone = path.join(tempDir(), 'gone')
  const ctx = fakeCtx([{ id: 'w47', cwd: gone }], [pane('p1', 'w47', gone, true)])
  await assert.rejects(ctx.explorerList('w47', '.'), { message: 'error.workspaceFolderMissing' })
  await assert.rejects(ctx.explorerStatus('w47'), { message: 'error.workspaceFolderMissing' })
})

test('pane 을 고르면 그 pane 폴더(foreground_cwd → cwd)를 읽는다 · 지워졌으면 작업 공간 폴더로', async () => {
  const base = tempDir()
  const main = path.join(base, 'main')
  const tree = path.join(base, 'tree')
  const gone = path.join(base, 'gone')
  for (const dir of [main, tree]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(main, 'main.md'), 'x')
  fs.writeFileSync(path.join(tree, 'tree.md'), 'x')
  const panes = [
    { id: 'p1', workspace_id: 'w1', cwd: main, foreground_cwd: tree, focused: true },
    { id: 'p2', workspace_id: 'w1', cwd: tree, foreground_cwd: gone },
    { id: 'p3', workspace_id: 'w1', cwd: gone, foreground_cwd: gone },
    { id: 'p9', workspace_id: 'w2', cwd: tree, foreground_cwd: tree },
  ]
  const ctx = fakeCtx([{ id: 'w1', cwd: main }], panes)
  const names = async (paneId) => (await ctx.explorerList('w1', '.', paneId)).entries.map((entry) => entry.name)
  assert.deepEqual(await names('p1'), ['tree.md']) // foreground_cwd 먼저
  assert.deepEqual(await names('p2'), ['tree.md']) // foreground_cwd 가 없으니 cwd
  assert.deepEqual(await names('p3'), ['main.md']) // 둘 다 없으니 작업 공간 폴더
  assert.deepEqual(await names('p9'), ['main.md']) // 다른 작업 공간 pane 은 안 믿는다
  assert.deepEqual(await names('nope'), ['main.md'])
  assert.equal((await ctx.explorerStatus('w1', 'p1')).root, tree)
})

test('pane 폴더 밖 경로는 계속 막는다', async () => {
  const base = tempDir()
  const tree = path.join(base, 'tree')
  fs.mkdirSync(tree)
  fs.writeFileSync(path.join(base, 'secret.md'), 'x')
  const ctx = fakeCtx([{ id: 'w1', cwd: base }], [{ id: 'p1', workspace_id: 'w1', cwd: tree, foreground_cwd: tree }])
  await assert.rejects(ctx.explorerOpen('w1', '../secret.md', 'p1'), { message: 'error.outsideWorkspace' })
  await assert.rejects(ctx.explorerList('w1', '..', 'p1'), { message: 'error.outsideWorkspace' })
  await assert.rejects(ctx.explorerOpen('w1', path.join(base, 'secret.md'), 'p1'), { message: 'error.pathUnreadable' })
})
