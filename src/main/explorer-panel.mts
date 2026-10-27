// ── 오른쪽 Explorer — 팩 창 ────────────────────────────────
// main.js createPackWindow 에서 옮겼다(PR3f) — 화면 문구(say) · 경로 풀기(resolveInside)는 인자로 받고, ctx 에 같은 이름(explorerList · explorerStatus · explorerOpen)으로 붙인다.
// 화면은 파일에 손대지 않는다 — main 이 읽어 준다. 루트는 화면이 준 경로가 아니라 데몬 상태(이 창 본체)의 작업 공간 폴더다
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as explorer from '../lib/explorer.mts'
import * as viewer from '../lib/viewer.mts'
import { explorerRoots, runGit, colorRows } from './files.mts'
import type { Say } from '../lib/pack.mts'

// file-icons 는 JS — main 과 같은 require 캐시의 것을 쓴다(대응표 캐시를 같이 쓴다)
const require = createRequire(import.meta.url)
const fileIcons: typeof import('../lib/file-icons.js') = require('../lib/file-icons.js')

// 데몬 state 답에서 읽는 칸만(모양은 검사하지 않는다 — 옛 main.js 와 같다)
type StateReply = { result?: { workspaces: { id: string; cwd: string }[] } }

// 팩 창 문맥(main.mts createPackWindow) 중 Explorer 가 읽는 것 · 붙이는 것
export type ExplorerCtx = {
  daemonCall(op: string, args?: Record<string, unknown>): Promise<unknown>
  explorerList?: unknown
  explorerStatus?: unknown
  explorerOpen?: unknown
}

type ExplorerDeps = { say: Say; resolveInside: (root: string, relative: unknown) => Promise<{ real: string; clean: string }> }

export function installExplorer(ctx: ExplorerCtx, { say, resolveInside }: ExplorerDeps): void {
  async function workspaceRoot(workspaceId: unknown): Promise<string> {
    const state = (await ctx.daemonCall('state')) as StateReply
    const workspace = state.result && state.result.workspaces.find((entry) => entry.id === String(workspaceId))
    if (!workspace) throw new Error(say('error.workspaceMissing'))
    return fs.promises.realpath(workspace.cwd)
  }

  ctx.explorerList = async (workspaceId: unknown, relative: unknown) => {
    const root = await workspaceRoot(workspaceId)
    const { real, clean } = await resolveInside(root, relative)
    const roots = await explorerRoots(root)
    const dirents = await fs.promises.readdir(real, { withFileTypes: true })
    const entries = await Promise.all(
      dirents.map(async (dirent) => {
        let dir = dirent.isDirectory()
        if (dirent.isSymbolicLink()) {
          // 읽어도 되는 곳 밖을 가리키는 링크는 열 수 없으니 목록에서 뺀다(끊긴 링크는 그대로 둔다)
          const target = await fs.promises.realpath(path.join(real, dirent.name)).catch(() => null)
          if (target && !explorer.isInsideAny(roots, target)) return null
          dir = await fs.promises.stat(path.join(real, dirent.name)).then((stat) => stat.isDirectory(), () => false)
        }
        return { name: dirent.name, dir, ...fileIcons.iconFor(fileIcons.loadManifest(), dirent.name, dir) }
      }),
    )
    const shown = entries.filter((entry) => entry !== null)
    // 팩 본체면 맨 위는 팩 내용만(코어 · 본체 설정은 사용자가 볼 것이 아니다)
    return { entries: explorer.sortEntries(clean === '.' && roots.length > 1 ? explorer.packBodyEntries(shown) : shown) }
  }

  // 작업 공간 폴더 기준 git 변경. git 레포가 아니면 git: false
  ctx.explorerStatus = async (workspaceId: unknown) => {
    const root = await workspaceRoot(workspaceId)
    const top = await runGit(root, ['rev-parse', '--show-toplevel'])
    if (top === null) return { git: false, changes: [] }
    const prefix = path.relative(await fs.promises.realpath(top.trim()), root)
    // 새 폴더는 한 줄(`dir/`)로 — 안의 파일을 다 세면 .omc/ 같은 폴더 하나로 수백 줄이 된다(git 기본과 같다)
    const output = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    if (output === null) return { git: true, changes: [] }
    const all = explorer.relativeToWorkspace(explorer.parseGitStatus(output), prefix.split(path.sep).join('/'))
    // 팩 본체의 git 은 코어 레포다 — 코어 변경은 빼고 팩 내용 쪽만
    const changes = (await explorerRoots(root)).length > 1 ? explorer.packBodyChanges(all) : all
    // 변경 목록에도 아이콘 — 새 폴더(`dir/`)는 폴더 아이콘
    const manifest = fileIcons.loadManifest()
    return {
      git: true,
      changes: changes.map((change) => ({ ...change, ...fileIcons.iconFor(manifest, change.path.split('/').filter(Boolean).pop(), change.path.endsWith('/')) })),
    }
  }

  // 미리보기 — 이미지는 그림, 바뀐 파일은 diff(옛·새 줄 번호), 그 밖은 내용(앞 512KB). 바이너리는 안내만
  ctx.explorerOpen = async (workspaceId: unknown, relative: unknown) => {
    const root = await workspaceRoot(workspaceId)
    const { real, clean } = await resolveInside(root, relative)
    const stat = await fs.promises.stat(real)
    if (!stat.isFile()) throw new Error(say('error.notFile'))
    const image = viewer.imageType(clean)
    if (image) {
      if (stat.size > viewer.IMAGE_LIMIT) return { kind: 'binary', path: clean, size: stat.size }
      const data = await fs.promises.readFile(real)
      return { kind: 'image', path: clean, src: `data:${image};base64,${data.toString('base64')}`, size: stat.size }
    }
    const status = await runGit(root, ['status', '--porcelain=v1', '-z', '--', clean])
    const tracked = status && status.length > 3 && !status.startsWith('??')
    if (tracked) {
      const diff = await runGit(root, ['diff', 'HEAD', '--', clean])
      if (diff) {
        const colored = await colorRows(viewer.diffRows(diff.slice(0, explorer.PREVIEW_LIMIT)), clean)
        return { kind: 'diff', path: clean, ...colored, truncated: diff.length > explorer.PREVIEW_LIMIT }
      }
    }
    const handle = await fs.promises.open(real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, explorer.PREVIEW_LIMIT))
      await handle.read(buffer, 0, buffer.length, 0)
      if (explorer.looksBinary(buffer)) return { kind: 'binary', path: clean, size: stat.size }
      const colored = await colorRows(viewer.fileRows(buffer.toString('utf8')), clean)
      return { kind: 'file', path: clean, ...colored, truncated: stat.size > explorer.PREVIEW_LIMIT, untracked: Boolean(status && status.startsWith('??')) }
    } finally {
      await handle.close()
    }
  }
}
