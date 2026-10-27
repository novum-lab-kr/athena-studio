// 오른쪽 Explorer 칸(side-panel) — 머리줄(작업 공간 이름 · 파일 / 변경 단추 · 접기) · 폴더 트리 · 변경 목록
// PR-R9. 칸 껍데기(접기 · 펴기 · 3초 타이머(보일 때만) · 작업 공간이 바뀌면 reset 부르기)와 미리보기(뷰어) 열기 · 닫기는 바닐라 side-panels.ts.
// 펼친 폴더 · 읽은 폴더 · git 변경 · 고른 보기(파일 / 변경)와 그 읽기(explorerList · explorerStatus)는 여기서 한다.
// 파일은 main 이 작업 공간 폴더(+ 지금 팩 데이터) 안만 읽어 준다. 폴더는 펼칠 때 읽고, 보일 때 3초마다 git 변경과 펼친 폴더를 다시 본다
import { flushSync } from 'react-dom'
import type { ReactNode } from 'react'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

type Folder = { error: string } | ExplorerEntry[]
type Mode = 'files' | 'changes'
type Twisty = 'open' | 'closed' | 'none'

// 바닐라가 넘긴다 — 작업 공간 찾기(screen.workspaces) · 단축키 글자 · 접기 아이콘(PANEL_ICONS.right) · 미리보기 열기 · 접기
export type ExplorerActions = {
  workspaceOf: (id: string) => { label: string; cwd: string } | undefined
  tabKey: () => string
  foldIcon: string[]
  openPreview: (relative: string) => void
  collapse: () => void
}

// stamp — 바닐라가 render() 로 다시 그리라고 할 때마다 1 씩(작업 공간 이름 · 언어는 바닐라 값이라 그릴 때 읽는다)
type ExplorerView = { workspace: string | null; mode: Mode; children: Map<string, Folder>; expanded: Set<string>; changes: ExplorerChange[]; git: boolean; statusKey: string; stamp: number }
const view = createStore<ExplorerView>({ workspace: null, mode: 'files', children: new Map(), expanded: new Set(), changes: [], git: false, statusKey: '', stamp: 0 })

let panel: HTMLElement | null = null
let actions: ExplorerActions | null = null
let mounted = false

// 켤 때 한 번 — 자리와 바닐라 도우미만 받는다. 처음 그리는 것은 바닐라가 처음 render() · reset() 을 부를 때(그 전에는 칸이 빈 채)
export function setup(container: HTMLElement, next: ExplorerActions): void {
  panel = container
  actions = next
}

// 바닐라가 replaceChildren 하던 때처럼 그리기는 바로(flushSync) — 한 번 띄우면 내리지 않는다
function commit(next: ExplorerView): void {
  if (!mounted && panel && actions) {
    view.set(next)
    mountIsland(panel, <ExplorerBody actions={actions} />)
    mounted = true
    return
  }
  flushSync(() => view.set(next))
}

// 지금 그리는 작업 공간(바닐라가 작업 공간이 바뀌었는지 보고 · 미리보기를 열 때)
export function workspace(): string | null {
  return view.get().workspace
}

// 바닐라 값(작업 공간 이름 · 언어 · 단축키 글자)이 바뀌었거나 칸이 다시 보일 때 — 지금 상태로 다시 그린다
export function render(): void {
  const state = view.get()
  commit({ ...state, stamp: state.stamp + 1 })
}

// 작업 공간이 바뀌면 처음부터(고른 보기 — 파일 / 변경 — 는 그대로)
export function reset(workspaceId: string | null): void {
  const state = view.get()
  commit({ workspace: workspaceId, mode: state.mode, children: new Map(), expanded: new Set(['.']), changes: [], git: false, statusKey: '', stamp: state.stamp + 1 })
  if (!workspaceId) return
  loadFolder('.')
  refreshStatus()
}

async function loadFolder(relative: string): Promise<void> {
  const workspaceId = view.get().workspace
  const result = await studio.explorerList(workspaceId, relative)
  if (workspaceId !== view.get().workspace) return
  const next: Folder = 'error' in result ? { error: result.error } : result.entries
  const state = view.get()
  // 그대로면 다시 그리지 않는다(3초마다 다시 읽는다)
  if (JSON.stringify(next) === JSON.stringify(state.children.get(relative))) return
  commit({ ...state, children: new Map(state.children).set(relative, next) })
}

// 3초마다 — git 변경 + 펼친 폴더. git 이 안 보는 곳(.gitignore 된 plans · issues · 팩 데이터 링크)의 새 파일도 보이게
export function refresh(): void {
  const state = view.get()
  if (!state.workspace) return
  refreshStatus()
  for (const folder of state.expanded) if (state.children.has(folder)) loadFolder(folder)
}

async function refreshStatus(): Promise<void> {
  const workspaceId = view.get().workspace
  if (!workspaceId) return
  const result = await studio.explorerStatus(workspaceId)
  if (workspaceId !== view.get().workspace || 'error' in result) return
  const key = JSON.stringify(result)
  const state = view.get()
  if (key === state.statusKey) return
  commit({ ...state, statusKey: key, git: result.git, changes: result.changes })
}

function toggleFolder(relative: string): void {
  const state = view.get()
  const expanded = new Set(state.expanded)
  if (expanded.has(relative)) expanded.delete(relative)
  else {
    expanded.add(relative)
    if (!state.children.has(relative)) loadFolder(relative)
  }
  commit({ ...view.get(), expanded })
}

function setMode(mode: Mode): void {
  commit({ ...view.get(), mode })
}

const joinPath = (folder: string, name: string) => (folder === '.' ? name : `${folder}/${name}`)

// 아이콘 — VSCode Material Icon Theme 의 SVG(main 이 이름으로 골라 준다). 폴더는 열림·닫힘 아이콘이 화살표를 대신한다.
// 실행 중에 만드는 경로라 번들러가 보지 않는다 — dist/renderer 가 레포 뿌리에서 두 칸 아래라 그대로 맞는다
const ICON_ROOT = '../../node_modules/material-icon-theme/icons'
const ICON_NAME = /^[\w.-]+$/

function FileIcon({ entry, open }: { entry: { icon?: string | null; iconOpen?: string | null }; open?: boolean }) {
  const name = open && entry.iconOpen ? entry.iconOpen : entry.icon
  return <img className="file-icon" alt="" src={typeof name === 'string' && ICON_NAME.test(name) ? `${ICON_ROOT}/${name}.svg` : undefined} />
}

// 폴더 열기·닫기 표시 — 둥근 단추 꺾쇠(›, 열리면 아래로 돈다 · 마우스를 올리면 동그란 바탕) · 'none' 은 파일 줄의 빈 자리(이름 줄 맞춤)
function TwistyMark({ state }: { state: Twisty }) {
  const className = `twisty${state === 'open' ? ' open' : ''}${state === 'none' ? ' none' : ''}`
  if (state === 'none') return <span className={className} />
  return (
    <span className={className}>
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M3.5 1.5L7 5L3.5 8.5" />
      </svg>
    </span>
  )
}

type RowProps = { depth: number; label: string; mark?: string; markClass?: string; dotfile?: boolean; onClick: () => void; title?: string; icon?: ReactNode; twisty?: Twisty }

function TreeRow({ depth, label, mark, markClass, dotfile, onClick, title, icon, twisty }: RowProps) {
  const folder = twisty === 'open' || twisty === 'closed'
  return (
    <button className={`tree-row${dotfile ? ' dotfile' : ''}`} style={{ paddingLeft: `${6 + depth * 12}px` }} title={title || label} aria-expanded={folder ? twisty === 'open' : undefined} onClick={onClick}>
      {twisty ? <TwistyMark state={twisty} /> : null}
      {icon}
      <span className="label">{label}</span>
      <span className={`mark ${markClass || ''}`}>{mark || ''}</span>
    </button>
  )
}

const noop = () => {}

// 펼친 폴더만 따라 내려가며 줄을 만든다(펼친 만큼만 — 큰 레포도 처음엔 한 단계)
function fileRows(state: ExplorerView, say: Say, openPreview: (relative: string) => void): ReactNode[] {
  const codes = new Map(state.changes.map((change) => [change.path, change.code]))
  const folders = new Set<string>()
  for (const change of state.changes) {
    let dir = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''
    while (dir) {
      folders.add(dir)
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    }
  }
  const rows: ReactNode[] = []
  const walk = (folder: string, depth: number) => {
    const entries = state.children.get(folder)
    if (!entries) {
      rows.push(<TreeRow key={`loading:${folder}`} depth={depth} twisty="none" label={say('explorer.loading')} onClick={noop} />)
      return
    }
    if ('error' in entries) {
      rows.push(<TreeRow key={`error:${folder}`} depth={depth} twisty="none" label={entries.error} onClick={noop} />)
      return
    }
    for (const entry of entries) {
      const relative = joinPath(folder, entry.name)
      if (entry.dir) {
        const open = state.expanded.has(relative)
        rows.push(
          <TreeRow
            key={`dir:${relative}`}
            depth={depth}
            twisty={open ? 'open' : 'closed'}
            icon={<FileIcon entry={entry} open={open} />}
            label={entry.name}
            mark={folders.has(relative) ? '●' : ''}
            markClass="code-M"
            dotfile={entry.name.startsWith('.')}
            onClick={() => toggleFolder(relative)}
          />,
        )
        if (open) walk(relative, depth + 1)
      } else {
        const code = codes.get(relative)
        rows.push(
          <TreeRow
            key={`file:${relative}`}
            depth={depth}
            twisty="none"
            icon={<FileIcon entry={entry} />}
            label={entry.name}
            mark={code}
            markClass={code ? `code-${code}` : ''}
            dotfile={entry.name.startsWith('.')}
            onClick={() => openPreview(relative)}
          />,
        )
      }
    }
  }
  walk('.', 0)
  return rows
}

function changeRows(state: ExplorerView, say: Say, openPreview: (relative: string) => void): ReactNode[] {
  if (!state.git) return [<TreeRow key="not-git" depth={0} label={say('explorer.notGit')} onClick={noop} />]
  if (!state.changes.length) return [<TreeRow key="no-changes" depth={0} label={say('explorer.noChanges')} onClick={noop} />]
  return state.changes.map((change) => (
    <TreeRow key={`change:${change.path}`} depth={0} icon={<FileIcon entry={change} />} label={change.path} mark={change.code} markClass={`code-${change.code}`} onClick={() => openPreview(change.path)} title={change.path} />
  ))
}

// 선 아이콘(24 격자 · 글자색을 따름) — 파일은 겹친 문서, 변경은 git 갈래
const VIEW_ICONS: Record<Mode, string[]> = {
  files: ['M15 2H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z', 'M15 2v5h5', 'M4 7v13a2 2 0 0 0 2 2h9'],
  changes: ['M6 3v12', 'M18 9a9 9 0 0 1-9 9', 'M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0', 'M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0'],
}

function LineIcon({ paths }: { paths: string[] }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths.map((shape) => (
        <path key={shape} d={shape} />
      ))}
    </svg>
  )
}

// 파일 · 변경 — 글자 없이 아이콘만(이름은 마우스를 올리면 · 변경 수는 작은 숫자)
function ViewButton({ mode, label, badge, current }: { mode: Mode; label: string; badge?: number; current: Mode }) {
  return (
    <button className="view-button icon" title={label} aria-label={label} aria-pressed={current === mode} onClick={() => setMode(mode)}>
      <LineIcon paths={VIEW_ICONS[mode]} />
      {badge ? <span className="view-badge">{String(badge)}</span> : null}
    </button>
  )
}

function ExplorerBody({ actions: shell }: { actions: ExplorerActions }) {
  const say = useSay()
  const state = useStore(view)
  const workspace = state.workspace ? shell.workspaceOf(state.workspace) : undefined
  if (!workspace) return <div className="side-empty">{say('explorer.noWorkspace')}</div>
  const count = state.changes.length
  const collapseTitle = say('explorer.collapse', { key: shell.tabKey() })
  return (
    <>
      <div className="explorer-head">
        <span className="explorer-name" title={say('explorer.cwdTitle', { path: workspace.cwd, key: shell.tabKey() })}>
          {workspace.label}
        </span>
        <ViewButton mode="files" label={say('explorer.files')} current={state.mode} />
        <ViewButton mode="changes" label={count ? say('explorer.changesCount', { count }) : say('explorer.changes')} badge={count} current={state.mode} />
        <button className="fold-button" title={collapseTitle} aria-label={collapseTitle} onClick={shell.collapse}>
          <LineIcon paths={shell.foldIcon} />
        </button>
      </div>
      {state.mode === 'files' ? fileRows(state, say, shell.openPreview) : changeRows(state, say, shell.openPreview)}
    </>
  )
}
