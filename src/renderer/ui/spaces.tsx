// 왼쪽 작업 공간 목록(#spaces) — 펼친 칸(머리줄 · 레포 줄 · pane 줄 · 아직 작업 공간이 없는 팩 레포 줄) · 접힌 칸(아이콘 줄)
// PR-R11. 칸 껍데기(접기 · 펴기 ⌘B — #spaces 의 collapsed 클래스 · 저장)와 데이터(데몬 상태 · 브랜치 · pane 상태 · 팩 레포 목록),
// 누른 뒤의 일(작업 공간 고르기 · 탭 열기 · pane 포커스 · 우클릭 메뉴 · 에이전트 부르기)은 바닐라 그대로(space-actions.ts).
// 바닐라가 renderSides() 때마다 지금 값을 render() 로 넘기고, 여기서는 그리기 · 레포 줄 접기(저장) · 레포 이미지 받아 두기만 한다
import { flushSync } from 'react-dom'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { createStore, mountIsland, showToast, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

// main 의 packRepos(src/main/pack-repos.mts PackRepo — 팩 레포 목록). 그 파일은 Node 모듈이라 화면 타입 검사로 가져오지 않는다
export type SpaceRepo = { name: string; agent: string | null; linked: boolean; displayName: string | null; iconPath: string | null; iconUpdatedAt: string | null }
// 데몬 상태(screen.panes)의 pane + 그 pane 이 있는 탭(space-actions.ts workspacePanes)
export type SpacePane = { id: string; label?: string | null; title?: string | null; tab: string }
export type SpaceWorkspace = {
  id: string
  label: string
  cwd: string
  athena: boolean // 아테나 작업 공간 — 같은 이름 팩 레포가 있어도 그 이름 · 이미지 · 메뉴를 쓰지 않는다(repo 는 늘 null)
  repo: SpaceRepo | null
  branch: string | null
  panes: SpacePane[]
}
// 바닐라가 renderSides() 때마다 넘기는 지금 값 — 작업 공간은 이미 순서대로(아테나가 맨 위)
export type SpacesView = {
  collapsed: boolean
  tabKey: string
  active: string | null
  focused: string | null
  workspaces: SpaceWorkspace[]
  idleRepos: SpaceRepo[] // 팩 레포 중 아직 작업 공간이 없는 것
  paneStatus: Record<string, string | null>
}

// 바닐라 도우미 · 누른 뒤의 일
export type SpacesActions = {
  spaceColor: (label: string) => string
  spaceInitials: (label: string) => string
  paneRow: (pane: SpacePane, repo: string) => { branch: string; role: string; tip: string }
  foldIcons: { paths: string[]; fill: string }
  toWork: () => void // [작업] 탭이 아니면 그리로
  selectWorkspace: (id: string) => void
  selectPane: (pane: SpacePane) => void
  newWorkspace: () => void
  setCollapsed: (collapsed: boolean) => void
  menu: (target: { workspace: string | null; repo: string | null }, point: { clientX: number; clientY: number }) => void
  callRepo: (repo: SpaceRepo) => void
  iconLoaded: () => void // 레포 이미지를 받았다 — 바닐라가 (붙어 있으면) 다시 그린다
}

type Shown = { view: SpacesView | null; folded: Set<string> }
const shown = createStore<Shown>({ view: null, folded: new Set(readFolded()) })

let box: HTMLElement | null = null
let actions: SpacesActions | null = null
let mounted = false

// 켤 때 한 번 — 자리와 바닐라 도우미만 받는다. 처음 그리는 것은 바닐라가 처음 render() 를 부를 때(그 전에는 칸이 빈 채)
export function setup(container: HTMLElement, next: SpacesActions): void {
  box = container
  actions = next
}

// 바닐라가 replaceChildren 하던 때처럼 그리기는 바로(flushSync) — 한 번 띄우면 내리지 않는다
function commit(next: Shown): void {
  if (!mounted && box && actions) {
    shown.set(next)
    mountIsland(box, <Spaces actions={actions} />)
    mounted = true
    return
  }
  flushSync(() => shown.set(next))
}

// 바닐라 renderSides() — 지금 값으로 다시 그린다
export function render(view: SpacesView): void {
  requestIcons(view)
  commit({ ...shown.get(), view })
}

// 바닐라 focusPane — 지금 보는 pane 만 바꿔 다시 그린다(pane 줄 aria-current · 접힌 머리글 holds-focus). 아직 안 그렸으면 할 일 없음
export function focus(paneId: string): void {
  const state = shown.get()
  if (!state.view || state.view.focused === paneId) return
  commit({ ...state, view: { ...state.view, focused: paneId } })
}

// 펼친 칸에서 레포 밑 pane 줄을 접은 레포 — 기억해 둔다
function readFolded(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('studio.spacesFolded') || '[]')
    return Array.isArray(saved) ? saved.map(String) : []
  } catch {
    return []
  }
}

function setFolded(workspaceId: string, folded: boolean): void {
  const next = new Set(shown.get().folded)
  if (folded) next.add(workspaceId)
  else next.delete(workspaceId)
  try {
    localStorage.setItem('studio.spacesFolded', JSON.stringify([...next]))
  } catch {}
  commit({ ...shown.get(), folded: next })
}

// 레포 이미지 — main 이 확인한 iconPath 를 data URL 로 받는다. iconUpdatedAt 이 바뀌면 다시 받는다(팩 이미지 ui/pack-rail.tsx usePackIcon 과 같은 방식)
const repoIconCache = new Map<string, { stamp: string; dataUrl: string | null }>() // name → 받은 것
const repoIconPending = new Set<string>()
const iconStamp = (repo: SpaceRepo) => `${repo.iconPath}|${repo.iconUpdatedAt || ''}`

// 보이는 레포 줄의 이미지를 받아 둔다 — 접힌 칸은 작업 공간 레포만, 펼친 칸은 작업 공간 없는 팩 레포까지
function requestIcons(view: SpacesView): void {
  const repos = view.workspaces.map((workspace) => workspace.repo)
  if (!view.collapsed) repos.push(...view.idleRepos)
  for (const repo of repos) if (repo) loadRepoIcon(repo)
}

function loadRepoIcon(repo: SpaceRepo): void {
  if (!repo.iconPath) return
  const stamp = iconStamp(repo)
  const cached = repoIconCache.get(repo.name)
  if ((cached && cached.stamp === stamp) || repoIconPending.has(repo.name)) return
  repoIconPending.add(repo.name)
  studio
    .repoIcon(repo.name)
    .then((result) => repoIconCache.set(repo.name, { stamp, dataUrl: (result && result.dataUrl) || null }))
    .catch(() => repoIconCache.set(repo.name, { stamp, dataUrl: null })) // 실패도 적어 둔다 — 다시 그릴 때마다 또 요청하지 않게
    .finally(() => {
      repoIconPending.delete(repo.name)
      actions?.iconLoaded()
    })
}

// 받아 둔 이미지(지금 iconPath · iconUpdatedAt 것) — 없거나 받는 중이면 null(두 글자)
function repoIconUrl(repo: SpaceRepo): string | null {
  if (!repo.iconPath) return null
  const cached = repoIconCache.get(repo.name)
  return cached && cached.stamp === iconStamp(repo) ? cached.dataUrl : null
}

// 레포 표시 이름(pack set-repo-name) — 사이드바만. 레포 name 은 그대로(작업 공간 이름 · 경로가 이것으로 찾는다)
const repoLabel = (repo: SpaceRepo | null) => (repo && (repo.displayName || repo.name)) || ''

// 작업 공간 줄 이미지 — 아테나 작업 공간은 늘 우리 로고(화이트판 · 작은 칸이라 크기에 맞는 파일 — 펼친 줄 14px → 32 · 접힌 rail 32px → 180),
// 그 밖엔 이미지를 정한 팩 레포만(없거나 받는 중이면 null)
function spaceImage(athena: boolean, repo: SpaceRepo | null, size: number): ReactNode {
  if (athena) return <img className="pack-icon-image space-athena-logo" src={`assets/logo/athena-white-${size}.png`} alt="" draggable={false} />
  const dataUrl = repo ? repoIconUrl(repo) : null
  return dataUrl ? <img className="pack-icon-image" src={dataUrl} alt="" draggable={false} /> : null
}

const colorStyle = (color: string) => ({ '--space-color': color }) as CSSProperties

function LineIcon({ paths, fill }: { paths: string[]; fill?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {fill ? <path className="panel-fill" d={fill} /> : null}
      {paths.map((shape) => (
        <path key={shape} d={shape} />
      ))}
    </svg>
  )
}

// 접기·펴기 버튼(side-panels.ts PANEL_ICONS · PANEL_FILLS 의 왼쪽) — 접힌 칸은 그쪽을 칠한다
function FoldButton({ title, collapsed, onClick, shell }: { title: string; collapsed: boolean; onClick: () => void; shell: SpacesActions }) {
  return (
    <button className="fold-button" title={title} aria-label={title} onClick={onClick}>
      <LineIcon paths={shell.foldIcons.paths} fill={collapsed ? shell.foldIcons.fill : undefined} />
    </button>
  )
}

function Spaces({ actions: shell }: { actions: SpacesActions }) {
  const say = useSay()
  const { view, folded } = useStore(shown)
  if (!view) return null
  return view.collapsed ? <Rail view={view} shell={shell} say={say} /> : <Expanded view={view} folded={folded} shell={shell} say={say} />
}

type Part = { view: SpacesView; shell: SpacesActions; say: Say }

// 접힌 왼쪽 — 작업 공간마다 아이콘 하나
function Rail({ view, shell, say }: Part) {
  const newTitle = say('spaces.newTitle', { key: view.tabKey })
  return (
    <>
      <FoldButton title={say('spaces.expand', { key: view.tabKey })} collapsed onClick={() => shell.setCollapsed(false)} shell={shell} />
      {view.workspaces.map((workspace) => {
        const name = workspace.repo ? repoLabel(workspace.repo) : workspace.label
        const image = spaceImage(workspace.athena, workspace.repo, 180)
        return (
          <button
            key={workspace.id}
            className="space-icon"
            aria-current={workspace.id === view.active}
            style={colorStyle(shell.spaceColor(workspace.label))} // 색은 레포 name 으로 — 표시 이름을 바꿔도 그대로
            title={[name, workspace.branch].filter(Boolean).join('\n')}
            onClick={() => {
              shell.toWork()
              shell.selectWorkspace(workspace.id)
            }}
          >
            {image || shell.spaceInitials(name)}
          </button>
        )
      })}
      <button className="space-icon add" data-tip={newTitle} aria-label={newTitle} onClick={shell.newWorkspace}>
        ＋
      </button>
    </>
  )
}

// 펼친 왼쪽 — 머리줄 · 작업 공간(레포)마다 머리글과 그 밑 pane 줄 · 아직 작업 공간이 없는 팩 레포
function Expanded({ view, folded, shell, say }: Part & { folded: Set<string> }) {
  const newTitle = say('spaces.newTitle', { key: view.tabKey })
  return (
    <>
      <div className="side-title with-fold">
        <span>spaces</span>
        <span className="side-title-actions">
          {/* + — 새 작업 공간(⌘⇧T · [파일] 메뉴와 같다) */}
          <button className="fold-button" data-tip={newTitle} aria-label={newTitle} onClick={shell.newWorkspace}>
            <LineIcon paths={['M12 5v14', 'M5 12h14']} />
          </button>
          <FoldButton title={say('spaces.collapse', { key: view.tabKey })} collapsed={false} onClick={() => shell.setCollapsed(true)} shell={shell} />
        </span>
      </div>
      {view.workspaces.map((workspace) => (
        <WorkspaceRows key={workspace.id} workspace={workspace} folded={folded.has(workspace.id)} view={view} shell={shell} say={say} />
      ))}
      {view.idleRepos.map((repo) => (
        <IdleRepoRow key={repo.name} repo={repo} shell={shell} say={say} />
      ))}
    </>
  )
}

// 펼친 칸 레포 줄 앞 칸 — 이미지가 있으면 이미지, 없으면 접힌 칸과 같은 색 · 두 글자 배지(꺾쇠 대신)
function RepoRowIcon({ workspace, repo, shell }: { workspace: SpaceWorkspace | null; repo: SpaceRepo | null; shell: SpacesActions }) {
  const image = spaceImage(Boolean(workspace && workspace.athena), repo, 32)
  // 이미지 칸 · 배지 칸은 key 를 달리 해 새로 만든다 — 같은 span 을 고쳐 쓰면 배지 색(style)을 지운 빈 style="" 이 남는다(옛 것은 늘 새로 만들었다)
  if (image) return <span key="image" className="space-repo-icon">{image}</span>
  const label = workspace ? workspace.label : (repo && repo.name) || ''
  return (
    // 색은 레포 name 으로 — 접힌 칸과 같다
    <span key="badge" className="space-repo-icon space-repo-badge" style={colorStyle(shell.spaceColor(label))}>
      {shell.spaceInitials(repoLabel(repo) || label)}
    </span>
  )
}

function WorkspaceRows({ workspace, folded, view, shell }: Part & { workspace: SpaceWorkspace; folded: boolean }) {
  const { panes } = workspace
  const current = workspace.id === view.active
  // 머리글을 누르면 그 레포의 pane 줄을 접고 편다(pane 이 없으면 그 레포를 고른다). 앞 칸은 이미지 또는 두 글자 배지(꺾쇠는 없다).
  // 접으면 모두 숨기고 머리글에 — 숨긴 수(+N) · 지금 보는 pane 이 안에 있으면 머리글을 밝게 · 일하는 pane 이 있으면 초록 점
  const hidden = folded && panes.length > 0
  const holdsFocus = hidden && panes.some((pane) => pane.id === view.focused)
  const children = folded ? [] : panes
  return (
    <>
      <button
        className={`space space-repo${holdsFocus ? ' holds-focus' : ''}`}
        aria-current={current}
        aria-expanded={panes.length ? !folded : undefined}
        // 레포 줄은 이름만 쓴 머리글 — 브랜치는 툴팁(에이전트 브랜치는 밑의 pane 줄에)
        title={[workspace.cwd, workspace.branch].filter(Boolean).join('\n')}
        onClick={() => {
          shell.toWork()
          if (panes.length) return setFolded(workspace.id, !folded)
          shell.selectWorkspace(workspace.id)
        }}
        // 우클릭 — 작업 공간 닫기 · (팩 레포면) 팩에서 빼기
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault()
          shell.menu({ workspace: workspace.id, repo: workspace.repo ? workspace.repo.name : null }, event)
        }}
      >
        <RepoRowIcon workspace={workspace} repo={workspace.repo} shell={shell} />
        <span className="space-text">
          <span className="space-label">{repoLabel(workspace.repo) || workspace.label}</span>
        </span>
        {hidden ? (
          <span className="space-fold-count">
            {panes.some((pane) => view.paneStatus[pane.id] === 'working') ? <span className="space-status working" /> : null}
            {`+${panes.length}`}
          </span>
        ) : null}
      </button>
      {/* pane 줄은 레포 머리글 밑에 */}
      {children.length ? (
        <div className="space-children">
          {children.map((pane) => (
            <PaneRow key={pane.id} pane={pane} repo={workspace.label} view={view} shell={shell} />
          ))}
        </div>
      ) : null}
    </>
  )
}

// pane 줄 — 누르면 그 탭(작업 공간도 따라 바뀐다)을 열고 그 pane 에 포커스
function PaneRow({ pane, repo, view, shell }: { pane: SpacePane; repo: string; view: SpacesView; shell: SpacesActions }) {
  // 왼쪽 브랜치(길면 …) · 오른쪽 끝 역할 — 전체 이름은 툴팁
  const row = shell.paneRow(pane, repo)
  return (
    <button className="space space-pane" data-pane={pane.id} aria-current={pane.id === view.focused} title={row.tip}
      onClick={() => {
        shell.toWork()
        shell.selectPane(pane)
      }}
    >
      {/* 앞 점 — 일하는 중(초록) · 그 밖(회색) */}
      <span className={`space-status ${view.paneStatus[pane.id] || ''}`} />
      <span className="space-label">{row.branch}</span>
      {row.role ? <span className="space-role">{row.role}</span> : null}
    </button>
  )
}

// 팩 레포 중 아직 작업 공간(에이전트 pane)이 없는 것 — 흐리게. 누르면 아테나에게 /call <그 레포 에이전트>
function IdleRepoRow({ repo, shell, say }: { repo: SpaceRepo; shell: SpacesActions; say: Say }) {
  // 툴팁은 없다 — 못 부르는 레포(연결 안 됨 · 에이전트 없음)만 누르면 이유를 알림으로
  const blocked = blockedReason(repo, say)
  return (
    <button
      className={`space space-repo space-idle${repo.linked ? '' : ' unlinked'}`}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault()
        shell.menu({ workspace: null, repo: repo.name }, event)
      }}
      onClick={() => {
        if (blocked) return showToast(blocked, 'info')
        shell.toWork()
        shell.callRepo(repo)
      }}
    >
      <RepoRowIcon workspace={null} repo={repo} shell={shell} />
      <span className="space-text">
        <span className="space-label">{repoLabel(repo)}</span>
      </span>
      {repo.linked && repo.agent ? <span className="space-call">{say('spaces.call')}</span> : null}
    </button>
  )
}

function blockedReason(repo: SpaceRepo, say: Say): string | null {
  if (!repo.linked) return say('spaces.repoUnlinked', { repo: repo.name })
  if (!repo.agent) return say('spaces.callNoAgent', { repo: repo.name })
  return null
}
