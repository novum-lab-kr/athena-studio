// ── pane · 탭 · 작업 공간 · 팩 레포 더하기 · 빼기 · 우클릭 메뉴 — 팩 창 ──
// main.js 에서 옮겼다(PR3e) — createPackWindow 의 ctx 에 같은 이름으로 붙인다(installWorkspaces). 데몬 요청은 ctx.daemonCall(daemon-link) 로.
// 쓰는 것(electron app · dialog · Menu · 화면 문구 · 스튜디오 집 자리 · 앱 단축키 이름 · 코어 명령)은 인자로 받는다
import fs from 'node:fs'
import path from 'node:path'
import * as core from '../lib/core.mts'
import * as packModel from '../lib/pack.mts'
import * as layout from '../lib/layout.mts'
import type { PackResult, Say } from '../lib/pack.mts'
import { runGit } from './files.mts'
import type { DaemonPane, DaemonState, PackCtx, Size } from './daemon-link.mts'

type App = { getPath(name: 'home'): string }
type Dialog = Pick<typeof import('electron').dialog, 'showMessageBox' | 'showOpenDialog'>
type MenuApi = Pick<typeof import('electron').Menu, 'buildFromTemplate'>
type MenuItem = import('electron').MenuItemConstructorOptions
type Point = { x?: unknown; y?: unknown } | null
// 코어 repo add · remove 결과 — 읽는 칸만
type RepoResult = PackResult & { already?: boolean; repo: { name: string }; path?: string; removed?: string }
type RunCore = (args: string[], options: { dir: string | null }) => Promise<RepoResult>

type WorkspaceDeps = { app: App; dialog: Dialog; Menu: MenuApi; say: Say; studio: { core: string; data: string }; tabKey: string; runCore: RunCore }

// app — 홈 폴더 · dialog — 확인창 · 폴더 고르기 · Menu — 우클릭 메뉴 · say — 화면 문구 · studio — 스튜디오 집 자리(주 본체 · 레지스트리) ·
// tabKey — 앱 단축키 이름(Command · Alt) · runCore — 이 본체의 코어 명령(repo add · remove)
export function installWorkspaces(ctx: PackCtx, { app, dialog, Menu, say, studio, tabKey, runCore }: WorkspaceDeps): void {
  const daemonCall = ctx.daemonCall

  // 새 탭(＋ · ⌘T · 빈 창이면 셸 탭 하나) — 보던 작업 공간이 없으면(새 데몬 · 다시 붙기) 아테나 폴더 작업 공간을 athena 이름으로(core.newTabRequest)
  // 이 창의 새 탭 요청은 하나씩 — 빈 데몬에서 두 요청이 겹치면 둘 다 빈 state 를 읽고 athena 작업 공간을 둘 만들 수 있다(앞 요청이 끝난 뒤 state 를 읽는다)
  let newTabQueue: Promise<unknown> = Promise.resolve()
  const newTabOnce = async (size: Size) => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return daemonCall('tab new', { defaultCwd: ctx.athenaDir, ...size })
    const state = await daemonCall<DaemonState & { activeWorkspace?: string | null }>('state')
    if (state.error) return state
    const request = core.newTabRequest(state.result, ctx.athenaDir as string, size)
    return daemonCall(request.op, request.args)
  }
  ctx.newTab = (size: Size) => {
    const run = newTabQueue.then(() => newTabOnce(size))
    newTabQueue = run.catch(() => {})
    return run
  }

  // pane 닫기(⌘W) — 에이전트가 돌고 있으면 묻는다(S6)
  ctx.closePane = async (paneId: string) => {
    const info = await daemonCall<{ pane?: DaemonPane }>('pane get', { pane: paneId })
    const pane = info.result && info.result.pane
    if (pane && pane.agent) {
      const choice = await dialog.showMessageBox(ctx.win as import('electron').BrowserWindow, {
        type: 'warning',
        message: say('dialog.closePane.message', { agent: pane.agent }),
        buttons: [say('common.cancel'), say('common.close')],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice.response !== 1) return { canceled: true }
    }
    return daemonCall('pane close', { pane: paneId })
  }

  // 탭 닫기 — 안에 에이전트가 돌고 있으면 묻는다
  ctx.closeTab = async (tabId: string) => {
    const listed = await daemonCall<{ panes: DaemonPane[] }>('pane list')
    const agents = ((listed.result && listed.result.panes) || []).filter((pane) => pane.tab_id === tabId && pane.agent)
    if (agents.length) {
      const choice = await dialog.showMessageBox(ctx.win as import('electron').BrowserWindow, {
        type: 'warning',
        message: say('dialog.closeTab.message', { agents: agents.map((pane) => pane.agent).join(' · ') }),
        buttons: [say('common.cancel'), say('common.close')],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice.response !== 1) return { canceled: true }
    }
    return daemonCall('tab close', { tab: tabId })
  }

  // 새 작업 공간 — 폴더를 고르면 그 이름으로(레포 하나 = 작업 공간 하나)
  // spaces + — 폴더를 고른다. 팩 본체이고 고른 것이 팩에 없는 git 레포면 바로 열지 않고 돌려준다(화면이 "팩에 더할까요?" 를 묻는다)
  ctx.newWorkspace = async (size: Size) => {
    const result = await dialog.showOpenDialog(ctx.win as import('electron').BrowserWindow, {
      title: say('dialog.newWorkspace.title'),
      properties: ['openDirectory'],
      // 아테나는 앱 데이터 폴더에 있으니 레포 고르기는 홈에서 시작한다
      defaultPath: app.getPath('home'),
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const dir = result.filePaths[0]
    const packBody = fs.existsSync(path.join(ctx.athenaDir || '', '.pack-data'))
    if (packBody && fs.existsSync(path.join(dir, '.git'))) {
      const real = core.realDir(dir)
      const inPack = (await ctx.packRepos()).some((repo) => repo.linked && core.realDir(path.join(ctx.athenaDir as string, 'repos', repo.name)) === real)
      if (!inPack) return { askAdd: true, dir, name: path.basename(dir) }
    }
    return ctx.openWorkspaceDir(dir, size)
  }
  ctx.openWorkspaceDir = (dir: string, size: Size) => daemonCall('workspace create', { label: path.basename(dir), cwd: dir, focus: true, ...size })

  // 팩에 레포 하나 더하기 — 코어 repo add(pack.json · 자리 · 링크 · 뼈대) 뒤 아테나에게 뼈대 채우기를 맡긴다(docs/setup.md "레포 하나 더하기")
  // 레포 더하기 · 빼기는 이 본체의 코어 명령이다 — 본체가 배포 코어보다 뒤처졌으면(아테나가 계속 일해 자동 따라잡기를 못 했으면) 먼저 따라잡는다.
  // 옛 본체는 명령을 몰라 사용법만 찍고 끝났다(2026-10-23 — "알 수 없는 답")
  // 이 창 본체가 배포 코어보다 뒤처졌나 — 화면이 레포 더하기 · 빼기 확인창에 "에이전트를 멈췄다 다시 켜요" 를 붙인다
  ctx.bodyBehind = async () => {
    const body = ctx.athenaDir
    if (!body || core.sameDir(body, studio.core) || !fs.existsSync(path.join(body, '.pack-data'))) return false
    const registry: { deploy?: { commit?: string } } | null = await fs.promises.readFile(path.join(studio.data, 'config.json'), 'utf8').then(JSON.parse, () => null)
    const target = registry && registry.deploy && registry.deploy.commit
    const mine = ((await runGit(body, ['rev-parse', 'HEAD'])) || '').trim()
    if (!target || !mine || mine === target) return false
    return (await runGit(studio.core, ['merge-base', '--is-ancestor', mine, target])) !== null
  }
  const freshBody = async () => {
    const listed = await daemonCall<{ panes: DaemonPane[] }>('pane list')
    const caught = await ctx.catchUpBody(listed.result ? listed.result.panes : null, { force: true })
    if (!caught || caught.ok) return null
    return { ok: false, error: 'body-behind', text: say(`pack.catchUp.${caught.reason === 'unknown-session' ? 'unknownSession' : caught.reason === 'working' ? 'working' : 'failed'}`) }
  }
  ctx.addRepo = async (dir: unknown, name: unknown) => {
    const stale = await freshBody()
    if (stale) return stale
    const args = ['repo', 'add', String(dir), ...(name ? ['--name', String(name)] : [])]
    const result = await ctx.packTask(say('pack.task.addRepo'), () => runCore(args, { dir: ctx.athenaDir }))
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    if (!result.already) await sendToAthena(say('spaces.addRepoAsk', { repo: result.repo.name, path: result.path }))
    return result
  }
  // 팩에서 레포 빼기 — 코어 repo remove(팩 백업 · pack.json · 자리 · 링크 · 에이전트 · 지식 · 검증) 뒤 아테나에게 ROUTING · services 줄 정리를 맡긴다
  ctx.removeRepo = async (name: unknown) => {
    const stale = await freshBody()
    if (stale) return stale
    const result = await ctx.packTask(say('pack.task.removeRepo'), () => runCore(['repo', 'remove', String(name)], { dir: ctx.athenaDir }))
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    await sendToAthena(say('spaces.removeRepoAsk', { repo: result.removed }))
    return result
  }
  // 작업 공간 닫기 — 그 작업 공간의 탭을 모두 닫는다(pane 이 다 닫히면 데몬이 작업 공간도 지운다 · 팩은 그대로)
  ctx.closeWorkspace = async (workspaceId: string) => {
    const state = await daemonCall<DaemonState>('state')
    const tabs = ((state.result && state.result.tabs) || []).filter((tab) => tab.workspace === workspaceId)
    for (const tab of tabs) await daemonCall('tab close', { tab: tab.id })
    return { ok: true, closed: tabs.length }
  }
  // spaces 레포 줄 우클릭 — 고른 동작 이름(repo-look · repo-reset-name · repo-clear-icon · remove-repo · close-workspace · null).
  // 이름 · 이미지는 팩 이름 · 이미지와 같은 대화상자(화면) · 되돌리기는 바꿔 둔 것이 있을 때만
  // 아테나 작업 공간 줄은 레포 항목(이름 · 이미지 · 팩에서 빼기)을 띄우지 않는다 — 팩에 같은 이름 레포가 있어도 아테나 로고 고정
  ctx.spaceContextMenu = async ({ repo = null, workspace = null }: { repo?: string | null; workspace?: string | null } = {}, point: Point = null) => {
    if (repo && workspace) {
      const state = await daemonCall<DaemonState>('state')
      const athena = state.result && core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir as string)
      if (athena && athena.id === workspace) repo = null
    }
    const info = repo ? (await ctx.packRepos()).find((item) => item.name === repo) : null
    return spaceMenuPopup({ repo, workspace, info }, point)
  }
  const spaceMenuPopup = ({ repo, workspace, info }: { repo: string | null; workspace: string | null; info: Awaited<ReturnType<PackCtx['packRepos']>>[number] | null | undefined }, point: Point) => new Promise<string | null>((resolve) => {
    let chosen: string | null = null
    const pick = (action: string) => () => {
      chosen = action
      resolve(action)
    }
    const items: MenuItem[] = []
    if (workspace) items.push({ label: say('spaces.menu.closeWorkspace'), click: pick('close-workspace') })
    if (info) {
      items.push(...(items.length ? [{ type: 'separator' } as const] : []), { label: say('spaces.menu.look'), click: pick('repo-look') })
      if (info.displayName) items.push({ label: say('spaces.menu.resetName'), click: pick('repo-reset-name') })
      if (info.iconPath) items.push({ label: say('spaces.menu.clearIcon'), click: pick('repo-clear-icon') })
    }
    if (repo) items.push(...(items.length ? [{ type: 'separator' } as const] : []), { label: say('spaces.menu.removeRepo'), click: pick('remove-repo') })
    if (!items.length || !ctx.win) return resolve(null)
    const menu = Menu.buildFromTemplate(items)
    menu.once('menu-will-close', () => setTimeout(() => resolve(chosen), 100))
    const at = point && Number.isInteger(point.x) && Number.isInteger(point.y) ? { x: point.x as number, y: point.y as number } : {}
    menu.popup({ window: ctx.win, ...at, callback: () => setTimeout(() => resolve(chosen), 100) })
  })

  // pane(터미널) 우클릭 — 고른 동작 이름(split-right · split-down · close-pane · null). 동작은 화면이 우클릭한 그 pane 으로 한다.
  // 단축키는 앱 메뉴(보기 · 파일)에 이미 걸려 있어 여기서는 보여 주기만 한다.
  // title(화면이 만든 'p7h · 머리줄 이름')은 맨 위에 누를 수 없는 제목 한 줄로 — 보고에 나온 pane 번호를 화면에서 찾게
  ctx.paneContextMenu = (point: Point = null, title = '') => new Promise<string | null>((resolve) => {
    if (!ctx.win) return resolve(null)
    let chosen: string | null = null
    const pick = (action: string) => () => {
      chosen = action
      resolve(action)
    }
    const menu = Menu.buildFromTemplate([
      ...(title ? [{ label: title, enabled: false }, { type: 'separator' } as const] : []),
      { label: say('menu.pane.splitRight'), accelerator: `${tabKey}+D`, registerAccelerator: false, click: pick('split-right') },
      { label: say('menu.pane.splitDown'), accelerator: `${tabKey}+Shift+D`, registerAccelerator: false, click: pick('split-down') },
      { type: 'separator' },
      { label: say('menu.file.closePane'), accelerator: `${tabKey}+W`, registerAccelerator: false, click: pick('close-pane') },
    ])
    menu.once('menu-will-close', () => setTimeout(() => resolve(chosen), 100))
    const at = point && Number.isInteger(point.x) && Number.isInteger(point.y) ? { x: point.x as number, y: point.y as number } : {}
    menu.popup({ window: ctx.win, ...at, callback: () => setTimeout(() => resolve(chosen), 100) })
  })

  // 아테나 pane(이 창 아테나 작업 공간의 첫 pane)에 글 한 줄 + Enter — 없으면 false
  async function sendToAthena(text: string) {
    const state = await daemonCall<DaemonState>('state')
    const athena = state.result && core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir as string)
    const tab = athena && (state.result as DaemonState).tabs.find((entry) => entry.workspace === athena.id)
    const pane = tab && layout.paneIds(tab.tree)[0]
    if (!pane) return false
    await daemonCall('workspace select', { workspace: (athena as { id: string }).id })
    const typed = await daemonCall('pane send-text', { pane, text })
    if (typed.error) return false
    await daemonCall('pane send-keys', { pane, keys: ['Enter'] })
    return true
  }
}
