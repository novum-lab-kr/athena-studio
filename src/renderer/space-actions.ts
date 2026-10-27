// 왼쪽 작업 공간 목록 — 아이콘 색 · 머리글자 · 순서 · 팩 레포 목록 · 레포 우클릭 메뉴(이름 · 이미지 · 작업 공간 닫기 · 팩에서 빼기) · 팩에 레포 더하기 · 레포 에이전트 부르기 · 그리기(renderSides)
// renderer.js 에서 옮김(R3c · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 그리기는 React(ui/spaces.tsx) · 접기 · 펴기는 side-panels.ts
import * as StudioLayout from '../lib/layout.mts'
import * as StudioSpaceNames from '../lib/space-names.mts'
import { $, currentTab, el, say, showToast, state } from './core.ts'
import { isTabPane } from './terminal.ts'
import { attached, estimateCells, focusPane, runCommand, screen } from './screen.ts'
import { isAthenaWorkspace, switchTab } from './tabs.ts'
import { PANEL_FILLS, PANEL_ICONS, setSpacesCollapsed } from './side-panels.ts'
import { StudioUi } from './ui/index.ts'
import type { SpacePane, SpaceRepo, SpacesActions } from './ui/spaces.tsx'
import { hidePackProgress, lookDialog, packAlert, packDialog, showPackProgress } from './pack-dialogs.ts'
import { popupOption, runPackFlow } from './pack-switch.ts'
import { branches, paneStatus } from './renderer.js'

// 작업 공간 아이콘 — 이름 앞 두 글자 + 이름으로 고른 색(같은 이름은 늘 같은 색)
const SPACE_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#7dcfff', '#ff9e64', '#73daca']

export function spaceColor(label: string): string {
  let hash = 0
  for (const character of String(label)) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return SPACE_COLORS[hash % SPACE_COLORS.length]!
}

export function spaceInitials(label: string): string {
  const words = String(label).split(/[-_\s.]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : String(label).slice(0, 2)
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()
}

// 작업 공간 순서 — 아테나(본체) 작업 공간은 늘 맨 위, 나머지는 데몬 순서 그대로
export function orderedWorkspaces(): ScreenWorkspace[] {
  const athena = screen.workspaces.filter(isAthenaWorkspace)
  return [...athena, ...screen.workspaces.filter((workspace) => !athena.includes(workspace))]
}

// 작업 공간의 pane 들 — 탭 순서, 탭 안은 분할 순서(왼쪽 작업 공간 목록 · 작업 공간 닫기)
function workspacePanes(workspaceId: string): SpacePane[] {
  const meta = new Map(screen.panes.filter(isTabPane).map((pane) => [pane.id, pane]))
  return screen.tabs
    .filter((tab) => tab.workspace === workspaceId)
    .flatMap((tab) => StudioLayout.paneIds(tab.tree).filter((id) => meta.has(id)).map((id) => ({ ...meta.get(id)!, tab: tab.id })))
}

// 팩 레포 중 아직 작업 공간(에이전트 pane)이 없는 것 — 흐리게. 누르면 아테나에게 /call <그 레포 에이전트>
let packRepos: SpaceRepo[] = []
export async function refreshPackRepos(): Promise<void> {
  const next = (await studio.packRepos().catch(() => [])) || []
  if (JSON.stringify(next) === JSON.stringify(packRepos)) return
  packRepos = next
  if (attached) renderSides()
}
// 레포 표시 이름(pack set-repo-name) — 사이드바만. 레포 name 은 그대로(작업 공간 이름 · 경로가 이것으로 찾는다)
function repoLabel(repo: SpaceRepo | null): string {
  return (repo && (repo.displayName || repo.name)) || ''
}
function packRepoOf(label: string): SpaceRepo | null {
  return packRepos.find((repo) => repo.name === label) || null
}

// 후보 브랜치 설명 — 로컬 · 10/18 · 마지막 커밋 제목(없으면 "아직 커밋 없음") · 워크트리 있음
function candidateNote(item: CallCandidate): string {
  const day = item.date ? `${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8, 10))}` : ''
  return [say(`spaces.place.${item.place}`), day, item.noCommits ? say('spaces.noCommits') : item.subject, item.worktree ? say('spaces.hasWorktree') : ''].filter(Boolean).join(' · ')
}

// 부르기 팝업 위 두 줄 — 담당 에이전트 · 메인 체크아웃(브랜치 · 원격과 비교 · 바뀐 파일). git 글자 그대로 보이지 않게 풀어 쓴다
function callMeta(info: CallInfo): HTMLElement {
  const meta = el('dl', 'call-meta')
  const row = (key: string, value: string) => meta.append(el('dt', null, key), el('dd', null, value))
  row(say('spaces.callAgentKey'), info.agent)
  const main = info.main
  if (main) {
    const sync = !main.upstream ? say('spaces.syncNone')
      : main.gone ? say('spaces.syncGone')
      : main.ahead && main.behind ? say('spaces.syncBoth', { ahead: main.ahead, behind: main.behind })
      : main.ahead ? say('spaces.syncAhead', { count: main.ahead })
      : main.behind ? say('spaces.syncBehind', { count: main.behind })
      : say('spaces.syncSame')
    const dirty = main.dirty ? say('spaces.dirtyCount', { count: main.dirty }) : say('spaces.dirtyNone')
    row(say('spaces.callMainKey'), [main.branch, sync, dirty].join(' · '))
  }
  return meta
}

// spaces 레포 줄 우클릭 메뉴(main) — 작업 공간 닫기 · 팩에서 레포 빼기
async function spaceMenu({ workspace, repo }: { workspace: ScreenWorkspace | null; repo: string | null }, event: { clientX: number; clientY: number }): Promise<unknown> {
  const action = await studio.spaceContextMenu({ workspace: workspace ? workspace.id : null, repo }, { x: Math.round(event.clientX), y: Math.round(event.clientY) })
  if (action === 'close-workspace') return closeWorkspace(workspace!)
  if (action === 'repo-look') return runPackFlow(() => editRepoLookDialog(repo!))
  if (action === 'repo-reset-name' || action === 'repo-clear-icon') return runPackFlow(() => resetRepoLook(repo!, action))
  if (action === 'remove-repo') return runPackFlow(() => removeRepoFromPack(repo!))
}

// 레포 이름 · 이미지 — 팩 이름 · 이미지와 같은 대화상자(lookDialog). 레포 name 은 그대로, 화면 표시만(팀과 같이 쓰는 팩 안에 저장)
async function editRepoLookDialog(name: string): Promise<unknown> {
  await refreshPackRepos()
  const repo = packRepoOf(name)
  if (!repo) return
  const image = repo.iconPath ? ((await studio.repoIcon(name)) || {}).dataUrl || null : null
  const answer = await lookDialog({ title: say('spaces.look.title'), color: name, image, value: repoLabel(repo), placeholder: name, pickKind: 'repo' })
  if (!answer) return
  const now = packRepoOf(name) || repo
  const results: RepoLookReply[] = []
  if (answer.text !== repoLabel(now)) results.push(await studio.repoSetName(name, answer.text ? answer.text : null))
  if (answer.iconChange) results.push(await studio.repoSetIcon(name, answer.iconChange === 'clear', answer.iconChange === 'picked'))
  await refreshPackRepos()
  const failed = results.find((result) => result && !result.ok && !result.canceled)
  if (failed) return packAlert(say('pack.look.failed'), failed.text || failed.message)
}

// 레포 우클릭 [원래 이름으로] · [이미지 지우기]
async function resetRepoLook(name: string, action: string): Promise<unknown> {
  const result = action === 'repo-reset-name' ? await studio.repoSetName(name, null) : await studio.repoSetIcon(name, true)
  await refreshPackRepos()
  if (result && !result.ok && !result.canceled) return packAlert(say('pack.look.failed'), result.text || result.message)
}

// 작업 공간 닫기 — 에이전트가 도는 pane 이 있으면 한 번 묻는다
async function closeWorkspace(workspace: ScreenWorkspace): Promise<void> {
  const panes = workspacePanes(workspace.id)
  const agents = panes.filter((pane) => paneStatus[pane.id])
  if (agents.length) {
    const ok = await packDialog({ title: say('spaces.closeWorkspaceTitle', { name: workspace.label }), body: [el('p', 'muted', say('spaces.closeWorkspaceNote', { count: agents.length }))], actions: [{ label: say('spaces.closeWorkspaceYes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }] })
    if (!ok) return
  }
  const result = await studio.workspaceClose(workspace.id)
  if (result.error) showToast(result.error)
}

// 팩에서 레포 빼기 — 무엇이 지워지는지 · 레포 폴더는 그대로 · 자동 백업을 알리고 확인
async function removeRepoFromPack(name: string): Promise<unknown> {
  const behind = await studio.packBodyBehind()
  const ok = await packDialog({
    title: say('spaces.removeRepoTitle', { repo: name }),
    body: [el('p', null, say('spaces.removeRepoBody')), el('p', 'muted', say('spaces.removeRepoNote')), ...(behind ? [el('p', 'muted', say('pack.catchUp.notice'))] : [])],
    actions: [{ label: say('spaces.removeRepoYes'), value: 'yes', kind: 'danger' }, { label: say('common.cancel'), value: null }],
  })
  if (!ok) return
  showPackProgress(say('spaces.removeRepoProgress', { repo: name }), false)
  const result = await studio.packRemoveRepo(name)
  hidePackProgress()
  if (!result.ok) return packAlert(say('spaces.removeRepoFailed'), result.text || result.message)
  await refreshPackRepos()
  showToast(say('spaces.removeRepoDone', { repo: name }), 'success')
}

// spaces + 로 팩에 없는 git 레포를 골랐다 — 팩에 더할지(에이전트 · 지식 뼈대 · 아테나가 채움) 터미널만 열지
export async function offerAddRepo({ dir, name }: { dir: string; name: string }): Promise<unknown> {
  const behind = await studio.packBodyBehind()
  const choice = await packDialog({
    title: say('spaces.addRepoTitle', { repo: name }),
    subtitle: say('spaces.addRepoNote'),
    body: [el('p', 'muted', dir), ...(behind ? [el('p', 'muted', say('pack.catchUp.notice'))] : [])],
    actions: [{ label: say('spaces.addRepoYes'), value: 'add', kind: 'primary' }, { label: say('spaces.addRepoTerminal'), value: 'open' }, { label: say('common.cancel'), value: null }],
  })
  if (choice === 'open') {
    const opened = await studio.workspaceOpenDir(dir, estimateCells($('panes')))
    if (opened.error) showToast(say('spaces.createFailed', { message: opened.error }))
    return
  }
  if (choice !== 'add') return
  showPackProgress(say('spaces.addRepoProgress', { repo: name }), false)
  const result = await studio.packAddRepo(dir, null)
  hidePackProgress()
  if (!result.ok) return packAlert(say('spaces.addRepoFailed'), result.text || result.message)
  await refreshPackRepos()
  showToast(say(result.already ? 'spaces.addRepoAlready' : 'spaces.addRepoDone', { repo: result.repo.name }), 'success')
}

// 레포 에이전트 부르기 — 브랜치를 앱 팝업에서 고르고(최근 작업 브랜치 이어 쓰기 · 새 브랜치) 워크트리에 바로 띄운다. main 직접 레포는 묻지 않는다
async function callRepoAgent(repo: SpaceRepo): Promise<unknown> {
  const info = await studio.packCallInfo(repo.name)
  if (info.error) return showToast(info.error)
  let choice = { branch: '', reuse: false }
  if (!info.direct) {
    const rows = el('div', 'pack-links')
    for (const item of info.candidates) rows.append(popupOption('pack-command', `reuse:${item.branch}`, 'git', say('spaces.callReuse', { branch: item.branch }), candidateNote(item)))
    const meta = callMeta(info)
    const label = el('label', 'pack-look-label', say('spaces.callNewLabel'))
    label.htmlFor = 'pack-dialog-input'
    const slot = el('div')
    slot.dataset.inputSlot = ''
    const answer = (await packDialog({
      title: say('spaces.callTitle', { repo: repo.name }),
      body: [meta, ...(info.candidates.length ? [rows] : []), label, slot],
      input: { placeholder: say('spaces.callNewPlaceholder'), code: true, label: say('spaces.callNewLabel') },
      actions: [{ label: say('spaces.callStart'), value: 'new', kind: 'primary' }, { label: say('common.cancel'), value: null }],
    })) as { value: string; text: string } | null
    if (!answer) return
    const value = typeof answer === 'string' ? answer : answer.value
    if (value.startsWith('reuse:')) choice = { branch: value.slice(6), reuse: true }
    else if (answer.text && answer.text.trim()) choice = { branch: answer.text.trim(), reuse: false }
    else return showToast(say('spaces.callBadBranch'))
  }
  showPackProgress(say('spaces.callProgress', { agent: info.agent }), false)
  let result = await studio.packCallStart(repo.name, choice)
  hidePackProgress()
  // 새 이름인데 이미 있는 브랜치 — 이어 쓸지 한 번 더
  if (result.exists) {
    const again = await packDialog({ title: say('spaces.callExists', { branch: choice.branch }), body: [el('p', 'muted', result.message || '')], actions: [{ label: say('spaces.callReuseYes'), value: 'yes', kind: 'primary' }, { label: say('common.cancel'), value: null }] })
    if (!again) return
    showPackProgress(say('spaces.callProgress', { agent: info.agent }), false)
    result = await studio.packCallStart(repo.name, { branch: choice.branch, reuse: true })
    hidePackProgress()
  }
  if (result.error) return packAlert(say('spaces.callFailed'), result.error)
  showToast(say('spaces.called', { agent: result.agent, branch: result.branch || say('spaces.callDirect') }), 'success')
}

export function renderSides(): void {
  // 왼쪽: 작업 공간(레포)만 — 그리기는 React(ui/spaces.tsx). 접기 · 펴기(collapsed 클래스)는 여기서
  const labels = new Set(screen.workspaces.map((workspace) => workspace.label))
  StudioUi.spaces.render({
    collapsed: $('spaces').classList.contains('collapsed'),
    tabKey: state!.tabKey,
    active: screen.activeWorkspace,
    focused: screen.focused,
    workspaces: orderedWorkspaces().map((workspace) => {
      const athena = isAthenaWorkspace(workspace)
      // 아테나 작업 공간은 같은 이름 팩 레포가 있어도 그 이름 · 이미지 · 메뉴를 쓰지 않는다
      const repo = athena ? null : packRepoOf(workspace.label)
      return { id: workspace.id, label: workspace.label, cwd: workspace.cwd, athena, repo, branch: branches[workspace.id] || null, panes: workspacePanes(workspace.id) }
    }),
    idleRepos: packRepos.filter((repo) => !labels.has(repo.name)),
    paneStatus,
  })

  // 오른쪽: 지금 작업 공간의 Explorer — 작업 공간이 바뀌면 따라간다
  if (StudioUi.explorer.workspace() !== screen.activeWorkspace) StudioUi.explorer.reset(screen.activeWorkspace)
}

// 왼쪽 작업 공간 목록(React)에 넘기는 바닐라 도우미 · 누른 뒤의 일
export function spacesActions(): SpacesActions {
  return {
    spaceColor,
    spaceInitials,
    paneRow: StudioSpaceNames.paneRow,
    foldIcons: { paths: PANEL_ICONS.left, fill: PANEL_FILLS.left },
    toWork: () => {
      if (currentTab !== 'work') switchTab('work')
    },
    selectWorkspace: (id) => studio.workspaceSelect(id),
    selectPane: async (pane) => {
      await studio.tabSelect(pane.tab)
      focusPane(pane.id)
    },
    newWorkspace: () => runCommand('new-workspace'),
    setCollapsed: setSpacesCollapsed,
    menu: (target, event) => spaceMenu({ workspace: screen.workspaces.find((workspace) => workspace.id === target.workspace) || null, repo: target.repo }, event),
    callRepo: (repo) => runPackFlow(() => callRepoAgent(repo)),
    iconLoaded: () => {
      if (attached) renderSides()
    },
  }
}
