// ── 회사 팩 · 팩 표시 이름 · 이미지 — 팩 창 ─────────────────────────
// main.js createPackWindow 에서 옮겼다(PR3g) — electron(app · dialog · Menu) · 화면 문구(say) · 스튜디오 집 자리(studio) · 코어 팩 명령(runPack · contractBlock) ·
// 열린 팩 창(packWindows · openPackIds · refreshAllPacks) · 창 찾기 · 열기(ctxOfBody · openBody)는 인자로 받는다.
// main.mts 의 값 — 옛 데몬 표시(daemonOld) · 되살리기 표시(restoreArmedFor) · [Finder 에서 보기] 파일(lastPackFile) · 켤 때 시작 화면(launchWelcome — 창 변수)은 읽기 · 쓰기 함수로 받는다.
// ctx 에 같은 이름(refreshPacks · packTask · packNew · packInspect · packImport · packExport · packOpen · packIcon · repoIcon · packSetName · packPickIcon ·
// packSetIcon · repoSetName · repoSetIcon · deletePack · packContextMenu)으로 붙인다
import path from 'node:path'
import fs from 'node:fs'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import * as core from '../lib/core.mts'
import * as packModel from '../lib/pack.mts'
import { iconDataUrl } from './files.mts'
import type { PackEntry, PackResult, Say } from '../lib/pack.mts'
import type { RunCoreOptions } from './core-runner.mts'
import type { createCoreRunner } from './core-runner.mts'
import type { PackRepo } from './pack-repos.mts'

type CoreRunner = ReturnType<typeof createCoreRunner>
type RunPack = (args: string[], options: RunCoreOptions) => Promise<PackResult>
type Layout = { root: string; core: string }
// 이 창 팩 상태(pack list 를 다듬은 것 + 시작 화면 칸) — 읽는 칸만
export type PackState = { [key: string]: unknown; supported: boolean; current?: PackEntry | null; packs?: PackEntry[] }
// 코어 결과에서 더 읽는 칸(모양은 검사하지 않는다 — 옛 main.js 와 같다)
type Inspected = PackResult & { pack?: Record<string, unknown> | null; conflict?: { id?: unknown; repos?: unknown; updatedAt?: unknown } | null }
type Imported = PackResult & { imported?: { id?: unknown } | null }
type PaneListReply = { result?: { panes?: { id: string; agent?: unknown }[] } } | null
// 우클릭 메뉴를 띄울 자리(화면이 준 것 — 정수일 때만 쓴다)
type Point = { x?: unknown; y?: unknown } | null

// 팩 창 문맥(main.mts createPackWindow) 중 회사 팩이 읽는 것 · 붙이는 것
export type PacksCtx = {
  athenaDir: string | null
  win: BrowserWindow | null
  packState: PackState
  packBusy: string | null
  packAbort: AbortController | null
  pickedIcon?: string | null
  restoreForPack?: string | null
  send(channel: string, ...values: unknown[]): void
  packProgress(step: unknown): void
  daemonCall(op: string, args?: Record<string, unknown>): Promise<unknown>
  rebindBody(dir: string): Record<string, unknown>
  packRepos(): Promise<PackRepo[]>
  show(tab?: string): void
  restoreNow(): Promise<unknown>
  refreshPacks?: () => Promise<PackState>
  packTask?: <T>(name: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T | { ok: false; error: 'locked'; message: string }>
  packNew?: unknown
  packInspect?: unknown
  packImport?: unknown
  packExport?: unknown
  packOpen?: unknown
  packIcon?: unknown
  repoIcon?: unknown
  packSetName?: unknown
  packPickIcon?: unknown
  packSetIcon?: unknown
  repoSetName?: unknown
  repoSetIcon?: unknown
  deletePack?: unknown
  packContextMenu?: unknown
}

type PacksDeps = {
  app: Pick<typeof import('electron').app, 'getPath'>
  dialog: Pick<typeof import('electron').dialog, 'showOpenDialog'>
  Menu: Pick<typeof import('electron').Menu, 'buildFromTemplate'>
  say: Say
  studio: Layout
  runPack: RunPack
  contractBlock: CoreRunner['contractBlock']
  packWindows: Set<PacksCtx>
  openPackIds: () => string[]
  refreshAllPacks: () => void
  ctxOfBody: (dir: string) => PacksCtx | null
  openBody: (body: string) => { error?: string; code?: string; existing?: boolean }
  daemonOld: () => boolean
  restoreArmedFor: () => string | null
  disarmRestore: () => void
  setLastPackFile: (file: string | null) => void
  launchWelcome: () => boolean | null
  setLaunchWelcome: (value: boolean) => void
}

export function installPacks(ctx: PacksCtx, deps: PacksDeps): void {
  const { app, dialog, Menu, say, studio, runPack, contractBlock, packWindows, openPackIds, refreshAllPacks, ctxOfBody, openBody, daemonOld, restoreArmedFor, disarmRestore, setLastPackFile, launchWelcome, setLaunchWelcome } = deps
  // 옛 main.js 의 지역 daemonCall 과 같은 함수(ctx.daemonCall 은 창을 만들 때 한 번 붙고 바뀌지 않는다)
  const daemonCall = ctx.daemonCall
  // ctx 에 붙인 것을 이 안에서 부를 때(옛 main.js 처럼 ctx 로 찾는다)
  const packTask = <T,>(name: string, work: (signal: AbortSignal) => Promise<T>) => (ctx.packTask as NonNullable<PacksCtx['packTask']>)(name, work)
  const win = () => ctx.win as BrowserWindow

  // ── 회사 팩 ──
  // 켤 때 시작 화면을 띄울지 — 첫 창이 처음 목록을 읽을 때 한 번만 정한다(그 뒤로는 화면이 '들어갔음' 을 기억한다)
  async function decideLaunchWelcome(listed: packModel.PackList): Promise<void> {
    if (launchWelcome() !== null || !listed.supported) return
    const listedPanes = (await daemonCall('pane list')) as NonNullable<PaneListReply>
    const agentPanes = ((listedPanes.result && listedPanes.result.panes) || []).filter((pane) => pane.agent).length
    setLaunchWelcome(packModel.welcomeOnLaunch({ list: listed, agentPanes }))
  }

  const refreshPacks = async (): Promise<PackState> => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) {
      ctx.packState = { supported: false }
    } else {
      const dir = ctx.athenaDir
      const listed = packModel.normalizePackList(await runPack(['list'], { dir }))
      // 읽는 사이 이 창이 다른 본체로 다시 묶였으면(팩 바꾸기 — 처음 여는 팩은 rebindBody 전에 refreshAllPacks 가 돈다) 옛 본체 목록이다.
      // 늦게 끝난 옛 목록이 새 팩 상태를 덮으면 팩 줄이 옛 팩으로 돌아가고 창이 그 팩으로 묶인 줄 안다 — 버리고 지금 본체로 다시 읽는다
      if (ctx.athenaDir !== dir) return refreshPacks()
      await decideLaunchWelcome(listed)
      if (ctx.athenaDir !== dir) return refreshPacks() // 시작 화면 판단(데몬 pane 목록)을 기다리는 사이에도 바뀔 수 있다
      // welcome — 팩이 하나도 없을 때 시작 화면 · launchWelcome — 켤 때 시작 화면(팩이 있어도) · recent — 시작 화면 '내 팩' 목록. 규칙은 pack.js 한 곳에서만
      ctx.packState = { ...listed, welcome: packModel.showPackWelcome(listed), launchWelcome: launchWelcome() === true, recent: packModel.recentPacks(listed as Parameters<typeof packModel.recentPacks>[0]) }
    }
    // 열린 팩 창들 — 팩 줄의 '열려 있음' 점(다른 창 목록이 바뀌어도 보이게 모든 창에)
    for (const each of packWindows) each.send('pack:state', { ...each.packState, openIds: openPackIds() })
    return { ...ctx.packState, openIds: openPackIds() }
  }
  ctx.refreshPacks = refreshPacks

  // 한 번에 하나 — 같은 요청이 두 번 와도 두 번째는 busy
  ctx.packTask = async <T,>(name: string, work: (signal: AbortSignal) => Promise<T>) => {
    if (ctx.packBusy) return { ok: false as const, error: 'locked' as const, message: say('pack.error.taskBusy', { task: ctx.packBusy }) }
    ctx.packBusy = name
    ctx.packAbort = new AbortController()
    try {
      return await work(ctx.packAbort.signal)
    } finally {
      ctx.packBusy = null
      ctx.packAbort = null
    }
  }

  // 팩을 만들고 여는 명령(new · open)을 돌릴 본체 — 스튜디오 집 안 본체면 코어(주 본체), 밖에서 연결한 본체면 그 본체.
  // 코어는 앱을 켤 때마다 새 코드로 가지만 팩 본체는 claude 가 켜져 있으면 업데이트를 건너뛰어 옛 코드에 남는다 —
  // 지금 본체로 돌리면 고친 열기(빈 자리 다시 열기 등)가 들어오지 않는다. 약속 검사(contractBlock)도 같은 본체로.
  // new 는 처음부터 코어에서 — 새 팩 local.json 의 reposRoot 를 부른 본체 설정에서 옮겨 적는데,
  // 팩 본체 설정에는 reposRoot 가 없어 '..'(= bodies 폴더)로 잡혀 /setup 레포 찾기가 회사 레포를 못 찾았다. 코어 설정에는 홈이 있다
  const packManagerDir = () => (core.isInside(ctx.athenaDir, studio.root) ? studio.core : ctx.athenaDir)

  // 새 팩 — 빈 자리 + 그 본체(pack new)를 만들고 이 창을 그 본체로 바꾼다. 그 본체에서 claude 가 켜지면 /setup.
  // 옛 데몬이면 만들기 전에 막는다(바꿔 보면 팩끼리 pane 이 섞인다)
  ctx.packNew = async () => {
    if (daemonOld()) return { ok: false, error: 'old-daemon', text: say('pack.switch.oldDaemon') }
    const dir = packManagerDir()
    const blocked = await contractBlock(dir)
    if (blocked) return blocked
    return packTask(say('pack.task.new'), async (signal) => {
      const result = await runPack(['new'], { dir, onProgress: ctx.packProgress, signal })
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      if (typeof result.body !== 'string' || !path.isAbsolute(result.body) || !core.checkAthenaDir(result.body).ok) return { ok: false, error: 'invalid-pack', text: say('pack.open.badBody') }
      const state = ctx.rebindBody(result.body)
      refreshAllPacks()
      return { ok: true, id: result.id, body: result.body, switched: true, state }
    })
  }

  // 가져오기 검사 — 파일 · 폴더 · 기존 아테나는 main 이 대화상자를 연다(화면이 경로를 만들지 않게), git 은 주소를 검사해 넘긴다
  ctx.packInspect = async (kind: string, source: string | null) => {
    const blocked = await contractBlock(ctx.athenaDir)
    if (blocked) return blocked
    let target: string | null = null
    if (kind === 'git') {
      target = packModel.validGitUrl(source)
      if (!target) return { ok: false, error: 'invalid-url', text: say('pack.error.invalidGitUrl') }
    } else {
      const options = ({
        file: { title: say('dialog.packFile.title'), properties: ['openFile'], filters: [{ name: say('dialog.packFile.filter'), extensions: ['gz', 'tgz'] }] },
        folder: { title: say('dialog.packFolder.title'), properties: ['openDirectory'] },
        athena: { title: say('dialog.packAthena.title'), properties: ['openDirectory'] },
      } as Record<string, Electron.OpenDialogOptions>)[kind]
      if (!options) return { ok: false, error: 'invalid-pack', text: say('pack.error.unknownImportKind') }
      const picked = await dialog.showOpenDialog(win(), { ...options, defaultPath: app.getPath('home') })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      target = picked.filePaths[0]
    }
    const chosen = target
    return packTask(say('pack.task.inspect'), async (signal) => {
      const result = (await runPack([kind === 'athena' ? 'import-athena' : 'inspect', chosen], { dir: ctx.athenaDir, onProgress: ctx.packProgress, signal })) as Inspected
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      return {
        ...result,
        source: kind === 'git' ? chosen : path.basename(chosen),
        summary: { incoming: packModel.packSummary({ ...result.pack, source: kind === 'git' ? 'git' : null }, say), existing: packModel.packSummary(result.conflict, say) },
        current: Boolean(result.conflict && ctx.packState.current && result.conflict.id === ctx.packState.current.id),
      }
    })
  }

  // 검사한 임시본 등록 — keep(버림) · replace(기존 자동 백업 후 교체) · new.
  // 교체는 본체가 그 팩 본체 기준으로 막거나(일하는 중이면 busy) 링크를 다시 건다 — 스튜디오는 pane 을 닫지 않는다
  ctx.packImport = async (token: unknown, choice: string) => {
    if (typeof token !== 'string' || !['keep', 'replace', 'new'].includes(choice)) return { ok: false, error: 'invalid-pack', text: say('pack.error.badImportRequest') }
    if (choice !== 'keep') {
      const blocked = await contractBlock(ctx.athenaDir)
      if (blocked) return blocked
    }
    return packTask(say('pack.task.import'), async () => {
      const result = (await runPack(['import', token, `--${choice}`], { dir: ctx.athenaDir, onProgress: ctx.packProgress })) as Imported
      refreshAllPacks()
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      // 열린 창의 팩을 바꿨으면 그 창 일감을 새로
      const replaced = result.imported && result.imported.id
      for (const each of packWindows) if (replaced && each.packState.current && each.packState.current.id === replaced) each.send('pack:changed', { ok: true, replaced })
      return result
    })
  }

  // 내보내기(팀에 주는 것 — 허용 목록만) · 내 백업(팩 + 작업 기록) — 저장 폴더를 고르고 명령 → 결과
  ctx.packExport = async (kind: string) => {
    const picked = await dialog.showOpenDialog(win(), {
      title: kind === 'backup' ? say('dialog.packBackup.title') : say('dialog.packExport.title'),
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('downloads'),
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    const args = kind === 'backup' ? ['backup', '--with-work', '--out', picked.filePaths[0]] : ['export', '--out', picked.filePaths[0]]
    // 내 백업 — 이 창의 살아 있는 pane(데몬 상태는 이 본체 것만)을 넘겨 그 pane 의 에이전트 대화를 담게(코어 lib/restore.mjs)
    // claude 가 도는 pane 만 — 기록이 없는 pane 은 결과 restore.missing 으로 돌아온다(훅이 생기기 전에 켠 세션)
    if (kind === 'backup') {
      const listed = (await daemonCall('pane list').catch(() => null)) as PaneListReply
      const panes = ((listed && listed.result && listed.result.panes) || []).filter((pane) => pane.agent === 'claude').map((pane) => pane.id)
      if (panes.length) args.push('--panes', panes.join(','))
    }
    return packTask(kind === 'backup' ? say('pack.task.backup') : say('pack.task.export'), async () => {
      const result = await runPack(args, { dir: ctx.athenaDir, onProgress: ctx.packProgress })
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      setLastPackFile(typeof result.file === 'string' ? result.file : null)
      return result
    })
  }

  // 팩 열기 — 그 팩 본체를 준비하고(pack open) 이 창을 그 본체로 바꾼다(한 창에서 바꿔 보기).
  // 다른 창이 이미 그 팩을 보고 있으면 그 창으로(한 팩을 두 창이 같이 보지 않게). newWindow 면 새 창으로(우클릭 [새 창으로 열기])
  ctx.packOpen = async (id: unknown, { newWindow = false }: { newWindow?: boolean } = {}) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    if (ctx.packState.current && ctx.packState.current.id === id) return { ok: true, same: true }
    const elsewhere = [...packWindows].find((other) => other !== ctx && other.packState.current && other.packState.current.id === id)
    if (elsewhere) {
      elsewhere.show()
      // 되살리기로 열었는데 다른 창이 이미 그 팩이면 — 그 창에서 되살린다(아테나는 그 창 아테나 옆에서)
      if (restoreArmedFor() === id) elsewhere.restoreNow().then((result) => elsewhere.send('pack:restored', result))
      return { ok: true, id, existing: true }
    }
    // 옛 데몬이면 바꾸기 · 새 창 모두 막는다 — 창을 본체로 묶지 못해 팩끼리 pane 이 섞인다
    if (daemonOld()) return { ok: false, error: 'old-daemon', text: say(newWindow ? 'pack.open.oldDaemon' : 'pack.switch.oldDaemon') }
    const dir = packManagerDir()
    const blocked = await contractBlock(dir)
    if (blocked) return blocked
    return packTask(say('pack.task.open'), async (signal) => {
      const result = await runPack(['open', id], { dir, onProgress: ctx.packProgress, signal })
      if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
      if (result.created) refreshAllPacks()
      const notes = { unlinkedRepos: result.unlinkedRepos || [], repair: result.state === 'repair-required', created: result.created === true }
      const other = typeof result.body === 'string' ? ctxOfBody(result.body) : null
      if (newWindow || (other && other !== ctx)) {
        const opened = openBody(result.body as string)
        if (opened.error) return { ok: false, error: opened.code || 'invalid-pack', text: opened.error }
        return { ok: true, id, existing: opened.existing, ...notes }
      }
      if (other === ctx) return { ok: true, same: true }
      if (typeof result.body !== 'string' || !path.isAbsolute(result.body) || !core.checkAthenaDir(result.body).ok) return { ok: false, error: 'invalid-pack', text: say('pack.open.badBody') }
      const state = ctx.rebindBody(result.body)
      // 되살리기로 연 팩이면 이 창에 넘긴다 — 아테나를 켤 때(openAthenaAgent) 되살린다. 팩 목록(packState)은 그 뒤에 새로 읽혀서 그걸로는 못 본다
      if (restoreArmedFor() === id) {
        ctx.restoreForPack = id
        disarmRestore()
      }
      return { ok: true, id, switched: true, state, ...notes }
    })
  }

  // ── 팩 표시 이름 · 이미지 ──
  // 이미지는 본체가 준 iconPath(마지막 pack list)만 읽어 data URL 로 넘긴다 — 화면이 경로를 정하지 않고, CSP(img-src 'self' data:)와 맞는다
  ctx.packIcon = async (id: string) => iconDataUrl(packModel.packIconPath(ctx.packState, id))
  // 레포 이미지 — packRepos 가 확인한 iconPath(팩 안 · assets/repos/<레포>.*)만
  ctx.repoIcon = async (name: string) => {
    const repo = (await ctx.packRepos()).find((item) => item.name === name)
    return iconDataUrl(repo ? repo.iconPath : null)
  }

  // 이름 바꾸기 — name 이 없으면 원래 이름으로(--clear). 끝나면 모든 창의 목록을 새로
  ctx.packSetName = async (id: string, name: string | null) => {
    const result = await runPack(name === null ? ['set-name', '--clear', '--id', id] : ['set-name', name, '--id', id], { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    refreshAllPacks()
    return result
  }

  // 이미지 미리 고르기 — 이름 · 이미지 대화상자용. 고른 파일은 main 이 들고 있고(화면은 경로를 모른다) 미리보기만 넘긴다.
  // [저장] 때 packSetIcon(id, false, true) 로 붙인다 — 취소하면 아무것도 바뀌지 않는다
  ctx.packPickIcon = async (kind = 'pack') => {
    ctx.pickedIcon = null
    const picked = await dialog.showOpenDialog(win(), {
      title: say(kind === 'repo' ? 'spaces.icon.title' : 'pack.icon.title'),
      properties: ['openFile'],
      filters: [{ name: say('pack.icon.filter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      defaultPath: app.getPath('pictures'),
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    try {
      const stat = await fs.promises.stat(picked.filePaths[0])
      if (stat.size > packModel.ICON_MAX_BYTES) return { ok: false, text: say('pack.icon.tooBig') }
      const bytes = await fs.promises.readFile(picked.filePaths[0])
      const mime = packModel.iconMime(bytes.subarray(0, 12))
      if (!mime) return { ok: false, text: say('pack.icon.unsupported') }
      ctx.pickedIcon = picked.filePaths[0]
      return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
    } catch (error) {
      return { ok: false, text: (error as Error).message }
    }
  }

  // 이미지 고르기 — 파일 대화상자는 main 이 연다(png · jpg · webp 만 보이게). clear 면 지우기 · usePicked 면 packPickIcon 으로 고른 것
  ctx.packSetIcon = async (id: string, clear: boolean, usePicked = false) => {
    let args = ['set-icon', '--clear', '--id', id]
    if (usePicked) {
      if (!ctx.pickedIcon) return { canceled: true }
      args = ['set-icon', ctx.pickedIcon, '--id', id]
      ctx.pickedIcon = null
    } else if (!clear) {
      const picked = await dialog.showOpenDialog(win(), {
        title: say('pack.icon.title'),
        properties: ['openFile'],
        filters: [{ name: say('pack.icon.filter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        defaultPath: app.getPath('pictures'),
      })
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
      args = ['set-icon', picked.filePaths[0], '--id', id]
    }
    const result = await runPack(args, { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    refreshAllPacks()
    return result
  }

  // 레포 표시 이름 · 이미지 — 이 창 본체의 팩(코어 pack set-repo-name · set-repo-icon). name 이 null 이면 원래 이름으로(--clear).
  // 이미지는 이름 · 이미지 대화상자에서 미리 고른 것(usePicked)이나 지우기만 — 바뀐 목록은 화면이 다시 읽는다(refreshPackRepos)
  ctx.repoSetName = async (repo: string, name: string | null) => {
    if (!/^[\w.-]+$/.test(repo)) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    const result = await runPack(name === null ? ['set-repo-name', repo, '--clear'] : ['set-repo-name', repo, name], { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }
  ctx.repoSetIcon = async (repo: string, clear: boolean, usePicked = false) => {
    if (!/^[\w.-]+$/.test(repo)) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    let args = ['set-repo-icon', repo, '--clear']
    if (!clear) {
      if (!usePicked || !ctx.pickedIcon) return { canceled: true }
      args = ['set-repo-icon', repo, ctx.pickedIcon]
      ctx.pickedIcon = null
    }
    const result = await runPack(args, { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }

  // 팩 지우기 — 열린 창이 없는 팩만. 코어 pack delete(먼저 팩 + 작업 기록 + 워크트리 변경 백업 · 일하는 중이면 busy · 워크트리가 있으면 has-worktrees)를
  // 팩 관리 본체에서 — 팩 본체는 자기 팩을 지우지 못한다. 레포 폴더(코드)는 그대로
  ctx.deletePack = async (id: string, { withWorktrees = false }: { withWorktrees?: boolean } = {}) => {
    if (openPackIds().includes(id)) return { ok: false, error: 'open', text: say('pack.delete.open') }
    const dir = packManagerDir()
    const blocked = await contractBlock(dir)
    if (blocked) return blocked
    const result = (await packTask(say('pack.task.delete'), (signal) => runPack(['delete', id, ...(withWorktrees ? ['--with-worktrees'] : [])], { dir, onProgress: ctx.packProgress, signal }))) as PackResult
    if (result.ok) {
      setLastPackFile(typeof result.backup === 'string' ? result.backup : null)
      refreshAllPacks()
      return result
    }
    if (result.error === 'has-worktrees') return { ok: false, error: 'has-worktrees', worktrees: Array.isArray(result.worktrees) ? result.worktrees : [] }
    if (result.error === 'unsafe') return { ...result, text: say('pack.delete.unsafe') }
    return { ...result, text: packModel.packErrorText(result, say) }
  }

  // 팩 아이콘 우클릭 메뉴 — 고른 동작 이름을 돌려준다(이름 입력은 화면이 받는다). 아무것도 안 고르면 null
  ctx.packContextMenu = (id: string, point: Point) => {
    const pack = [...(ctx.packState.packs || []), ctx.packState.current].find((item) => item && item.id === id)
    if (!pack || !ctx.win) return Promise.resolve(null)
    const window = ctx.win
    return new Promise<string | null>((resolve) => {
      let chosen: string | null = null
      const pick = (action: string) => () => {
        chosen = action
        resolve(action)
      }
      const items: MenuItemConstructorOptions[] = []
      // 지금 팩이 아니면 — 따로 띄우고 싶을 때만 새 창으로(누르면 이 창에서 바꿔 본다)
      if (!(ctx.packState.current && ctx.packState.current.id === id)) items.push({ label: say('pack.menu.newWindow'), click: pick('new-window') }, { type: 'separator' })
      items.push({ label: say('pack.menu.rename'), click: pick('rename') })
      if (pack.displayName) items.push({ label: say('pack.menu.resetName'), click: pick('reset-name') })
      items.push({ type: 'separator' }, { label: say('pack.menu.icon'), click: pick('icon') })
      if (pack.iconPath) items.push({ label: say('pack.menu.clearIcon'), click: pick('clear-icon') })
      // 내보내기(담을 것은 화면이 묻는다) — 코어 명령이 이 본체의 팩(지금 팩)만 다룬다(--id 가 없다)
      if (ctx.packState.current && ctx.packState.current.id === id) items.push({ type: 'separator' }, { label: say('pack.link.export'), click: pick('export') })
      // 지우기 — 어느 창도 보고 있지 않은 팩만(보는 창이 있으면 그 창에서 다른 팩으로 바꾼 뒤)
      if (!openPackIds().includes(id)) items.push({ type: 'separator' }, { label: say('pack.menu.delete'), click: pick('delete') })
      // 메뉴가 닫힌 뒤 click 이 늦게 올 수 있어 잠깐 기다렸다 null
      const menu = Menu.buildFromTemplate(items)
      menu.once('menu-will-close', () => setTimeout(() => resolve(chosen), 100))
      // 누른 자리에 — 안 주면 OS 커서 자리(다른 화면일 수도)에 뜬다
      const at = point && Number.isInteger(point.x) && Number.isInteger(point.y) ? { x: point.x as number, y: point.y as number } : {}
      menu.popup({ window, ...at, callback: () => setTimeout(() => resolve(chosen), 100) })
    })
  }
}
