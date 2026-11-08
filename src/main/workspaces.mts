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
import { SSH_ALIAS } from '../lib/server-status.mts'
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
  // 겹친 요청은 main 이 아테나 폴더마다 한 줄로 세워 부른다(screenQueue) — 앞 요청이 끝난 뒤 state 를 읽는다
  ctx.newTab = async (size: Size) => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return daemonCall('tab new', { defaultCwd: ctx.athenaDir, ...size })
    const state = await daemonCall<DaemonState & { activeWorkspace?: string | null }>('state')
    if (state.error) return state
    const request = core.newTabRequest(state.result, ctx.athenaDir as string, size)
    return daemonCall(request.op, request.args)
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
    if (!result.ok) return packModel.packFailure(result, say)
    if (!result.already) await sendToAthena(say('spaces.addRepoAsk', { repo: result.repo.name, path: result.path }))
    return result
  }
  // 팩 설정 전(빈 팩 자리)에 레포를 고르면 — 아테나 pane 에 첫 실행 설정(docs/setup.md)을 시킨다. 레포 폴더는 고른 레포가 있는 폴더(setup.md "레포 폴더: 사용자가 준 폴더")
  ctx.startSetup = async (dir: string) => ({ ok: await sendToAthena(say('spaces.setupAsk', { root: path.dirname(dir), repo: path.basename(dir) })) })
  // 팩에서 레포 빼기 — 코어 repo remove(팩 백업 · pack.json · 자리 · 링크 · 에이전트 · 지식 · 검증) 뒤 아테나에게 ROUTING · services 줄 정리를 맡긴다
  ctx.removeRepo = async (name: unknown) => {
    const stale = await freshBody()
    if (stale) return stale
    const result = await ctx.packTask(say('pack.task.removeRepo'), () => runCore(['repo', 'remove', String(name)], { dir: ctx.athenaDir }))
    if (!result.ok) return packModel.packFailure(result, say)
    await sendToAthena(say('spaces.removeRepoAsk', { repo: result.removed }))
    return result
  }
  // 서버 — 코어 server hosts · add · remove(athena/scripts/lib/servers.mjs · docs/setup.md "서버 하나 더하기").
  // hosts 는 이 컴퓨터 ~/.ssh/config 의 Host 별칭만(주소는 오지 않는다) · add 는 BatchMode 접속 시험을 통과해야 팩에 들어간다
  ctx.serverHosts = async () => {
    const result = (await runCore(['server', 'hosts'], { dir: ctx.athenaDir })) as PackResult & { hosts?: unknown }
    if (!result.ok) return packModel.packFailure(result, say)
    const hosts = Array.isArray(result.hosts) ? result.hosts.filter((item): item is { host: string; registered: boolean } => Boolean(item) && typeof item.host === 'string') : []
    return { ok: true, hosts: hosts.map((item) => ({ host: item.host, registered: item.registered === true })) }
  }
  // 등록 팝업의 첫 단계 — 팩 쪽 검사만(코어 server add --check · ssh 를 부르지 않고 아무것도 쓰지 않는다). 본체를 먼저 따라잡는다(옛 코어는 --check 를 모른다)
  ctx.serverCheck = async (alias: string) => {
    const stale = await freshBody()
    if (stale) return stale
    const result = (await runCore(['server', 'add', alias, '--check'], { dir: ctx.athenaDir })) as RepoResult & { checked?: boolean; server?: { name: string; host: string } }
    if (!result.ok || !result.server) return packModel.packFailure(result, say)
    if (result.already) return { ok: true, already: true, server: { name: result.server.name, host: result.server.host } }
    // 검사만 했다는 표시가 없으면 옛 코어가 등록까지 했을 수 있다 — 등록된 것으로 본다
    return result.checked ? { ok: true, server: { name: result.server.name, host: result.server.host } } : { ok: true, already: true, server: { name: result.server.name, host: result.server.host } }
  }
  // 등록 — tested 면 앱이 방금 접속을 확인했다(D1 · 코어는 접속 시험을 건너뛴다). 등록 뒤 분석은 팝업 [등록] 옆 체크를 켰으면 닫힐 때 serverAnalyze 로
  ctx.addServer = async (host: string, { tested = false }: { tested?: boolean } = {}) => {
    const stale = await freshBody()
    if (stale) return stale
    const args = ['server', 'add', host, ...(tested ? ['--tested'] : [])]
    const result = (await ctx.packTask(say('pack.task.addServer'), () => runCore(args, { dir: ctx.athenaDir }))) as RepoResult & { server?: { name: string; host: string } }
    if (!result.ok || !result.server) return packModel.packFailure(result, say)
    return { ok: true, already: Boolean(result.already), server: { name: result.server.name, host: result.server.host } }
  }
  // 키 올리기 터미널 — 사람이 비밀번호를 직접 넣는 셸(ssh-copy-id). 작업 공간 하나를 새로 열고 그 pane id 를 돌려준다(화면이 끝남을 기다린다)
  ctx.openSshPane = async (label: string, text: string) => {
    const created = await daemonCall<{ root_pane?: { id: string } }>('workspace create', { label, cwd: app.getPath('home'), focus: true })
    const pane = created.result && created.result.root_pane
    if (!pane) return { error: created.error || 'pane' }
    const ran = await daemonCall('pane run', { pane: pane.id, text })
    return ran.error ? { error: ran.error } : { pane: pane.id }
  }
  // 등록 뒤 [분석하기] — 아테나 창을 열고(없으면 에이전트를 켠다) 입력을 기다렸다가 분석 지시를 넣는다(setup.md "서버 하나 더하기" 2단계 · 분석은 바로 시작)
  ctx.serverAnalyze = async (name: string, size: Size) => {
    const server = (await (ctx.serverList as () => Promise<{ name: string; host: string }[]>)()).find((item) => item.name === name)
    if (!server) return { ok: false, text: say('spaces.serverMissing', { server: name }) }
    const opened = (await (ctx.openAthenaAgent as (size: Size) => Promise<{ error?: string; cancelled?: boolean }>)(size)) || {}
    if (opened.error || opened.cancelled) return { ok: false, text: opened.error || '' }
    // 막 켠 에이전트는 입력칸이 뜰 때까지 기다린다(최대 90초)
    for (let waited = 0; waited < 90_000; waited += 1000) {
      const state = await daemonCall<DaemonState>('state')
      const listed = await daemonCall<{ panes: DaemonPane[] }>('pane list')
      const athena = state.result && core.findAthenaWorkspace(state.result.workspaces, ctx.athenaDir as string)
      const tab = athena && (state.result as DaemonState).tabs.find((entry) => entry.workspace === athena.id)
      const paneId = tab && layout.paneIds(tab.tree)[0]
      const pane = paneId && listed.result ? listed.result.panes.find((entry) => entry.id === paneId) : null
      if (pane && pane.agent && pane.agent_status === 'idle') {
        const sent = await sendToAthena(say('spaces.serverAnalyzeAsk', { server: server.name, host: server.host }))
        return sent ? { ok: true } : { ok: false, text: say('spaces.serverAnalyzeFailed') }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return { ok: false, text: say('spaces.serverAnalyzeFailed') }
  }
  ctx.removeServer = async (name: string) => {
    const stale = await freshBody()
    if (stale) return stale
    const result = await ctx.packTask(say('pack.task.removeServer'), () => runCore(['server', 'remove', name], { dir: ctx.athenaDir }))
    if (!result.ok) return packModel.packFailure(result, say)
    await sendToAthena(say('spaces.removeServerAsk', { server: name }))
    return { ok: true, removed: name }
  }
  // 서버 줄 누르기 — 사람이 직접 쓰는 접속 터미널(ssh <별칭>). 작업 공간 이름은 ssh-<서버> · 이미 있으면 그리로.
  // 에이전트가 아니라 사람 셸이라 서버 보호 훅(server-guard.py)이 닿지 않는다 — 에이전트는 늘 scripts/ssh-run.sh 로 들어간다
  ctx.openServer = async (name: string, size: Size) => {
    const server = (await (ctx.serverList as () => Promise<{ name: string; host: string }[]>)()).find((item) => item.name === name)
    // 별칭은 pane 셸에 그대로 들어간다 — 맨 앞 - · 공백 · 셸 글자가 든 것은 열지 않는다(보안 검토 높음2)
    if (!server || !SSH_ALIAS.test(server.host)) return { error: say('spaces.serverMissing', { server: name }) }
    const label = `ssh-${server.name}`
    const state = await daemonCall<DaemonState>('state')
    const open = state.result && state.result.workspaces.find((workspace) => workspace.label === label)
    if (open) return daemonCall('workspace select', { workspace: open.id })
    const created = await daemonCall<{ root_pane?: { id: string } }>('workspace create', { label, cwd: app.getPath('home'), focus: true, ...size })
    const pane = created.result && created.result.root_pane
    if (!pane) return created
    return daemonCall('pane run', { pane: pane.id, text: `ssh -- ${server.host}` })
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

  // 서버 줄 우클릭 — 고른 동작 이름(open-server · analyze-server · remove-server · null)
  ctx.serverContextMenu = (point: Point = null) => new Promise<string | null>((resolve) => {
    if (!ctx.win) return resolve(null)
    let chosen: string | null = null
    const pick = (action: string) => () => {
      chosen = action
      resolve(action)
    }
    const menu = Menu.buildFromTemplate([
      { label: say('spaces.menu.openServer'), click: pick('open-server') },
      { label: say('spaces.menu.analyzeServer'), click: pick('analyze-server') },
      { type: 'separator' },
      { label: say('spaces.menu.removeServer'), click: pick('remove-server') },
    ])
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
    const sent = await daemonCall('pane run', { pane, text })
    return !sent.error
  }
}
