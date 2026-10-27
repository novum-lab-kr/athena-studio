// 앱 화면 — 탭 두 개(작업 창 · 일감) · 작업 창 안의 데몬 탭·pane · 처음 켤 때 아테나 받기 · 에이전트(claude · codex) 고르기
// studio 는 preload 의 contextBridge 가 만든 전역이다 — 같은 이름으로 다시 선언하면 이 파일 전체가 SyntaxError 로 죽는다
/* global studio, StudioLayout, StudioSpaceNames, StudioUi */
// 기능별로 .ts 로 나누는 중(R3 — 계획서 "R3 나누기"). 옮긴 묶음은 import 로 부르고, 옮긴 묶음이 부르는 아직 안 옮긴 함수는 여기서 export 한다(순환 import — 묶음 사이 사용은 모두 함수 안이라 읽는 순서와 상관없다)
// 옮긴 묶음의 변수는 그쪽이 가진다 — 여기서는 이름 그대로 읽고, 바꿀 때만 setX
import { $, applyStaticTexts, currentTab, el, panels, say, setI18nState, setState, showToast, state } from './core.ts'
import { isTabPane, views } from './terminal.ts'
import { attach, attached, attaching, estimateCells, focusPane, openAgent, runCommand, screen, setAttached, setReattachOnKey, setRestoreArmed, setStarting, showRestoreResult, startScreen } from './screen.ts'
import { applyState, ensureSomeTab, isAthenaWorkspace, renderTabs, switchTab } from './tabs.ts'
import { focusCurrentTerminal, holdForRedraw, holdOutputArrived, initMonitor, layoutPanes, sendPaneSize } from './pane-layout.ts'
import { hidePackProgress, lookDialog, modalOpen, packAlert, packDialog, packLabel, packs, setPacks, showPackProgress } from './pack-dialogs.ts'
import { applySwitchedPack, hasNoPacks, openNoPacks, packRailActions, popupOption, refreshPackList, renderPackRail, runPackCommand, runPackFlow, switchPack, welcomeShown } from './pack-switch.ts'

let branches = {} // 작업 공간 id → git 브랜치(없으면 null) — main 이 5초마다
let paneStatus = {} // pane id → 에이전트 상태(working · idle · …, 에이전트 없으면 null) — main 이 2초마다

// ── 왼쪽 spaces · 오른쪽 패널 ──
// 접기·펴기 버튼 아이콘 — 칸 머리에 붙는다(그리기는 React — 왼쪽 ui/spaces.tsx · 오른쪽 ui/explorer.tsx). 패널 아이콘(네모 + 세로선 · 사용자가 시안 5 를 고름) · 접힌 칸은 그쪽을 칠한다
const PANEL_ICONS = {
  left: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18'],
  right: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18'],
}

const PANEL_FILLS = {
  left: 'M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  right: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z',
}

// 툴팁 — data-tip 버튼 위에 잠깐 머물면 버튼 아래 가운데에 띄운다(화면 밖으로 나가면 안쪽으로 당기고, 아래가 모자라면 위로 · 세로 아이콘 줄은 오른쪽)
// 아이콘 버튼(글자가 거의 없는 button)의 title 도 여기로 옮겨 같은 툴팁으로 — 기본 title 툴팁은 탭 줄 등에서 안 뜬다
const TIP_SELECTOR = '[data-tip], button[title], .studio-tab .close[title]' // 탭의 ✕ 는 button 이 아니라 span
const ICON_TEXT_MAX = 2 // ＋ · ✕ · 접힌 작업 공간 머리글자(두 글자)까지
function tipTarget(element) {
  const node = element instanceof Element ? element.closest(TIP_SELECTOR) : null
  if (!node) return null
  if (node.hasAttribute('title')) {
    if (!node.dataset.tip && node.textContent.trim().length > ICON_TEXT_MAX) return null // 글자 버튼은 기본 title 그대로
    // 옆 브라우저 바는 기본 title 그대로 — 아래로 띄우면 페이지 자리의 네이티브 뷰에 가려진다
    if (node.closest('#browser')) return null
    // 코드가 title 을 다시 넣었을 수도 있어(언어 바꿈 · 상태 바뀜) 볼 때마다 옮긴다
    node.dataset.tip = node.title
    if (!node.hasAttribute('aria-label')) node.setAttribute('aria-label', node.title)
    node.removeAttribute('title')
  }
  return node.dataset.tip ? node : null
}
const TIP_DELAY_MS = 350
const TIP_GAP = 6
function initTips() {
  const tip = $('tip')
  let target = null
  let timer = null
  const hide = () => {
    clearTimeout(timer)
    tip.hidden = true
    target = null
  }
  const show = (node) => {
    tip.textContent = node.dataset.tip
    tip.hidden = false
    const rect = node.getBoundingClientRect()
    const box = tip.getBoundingClientRect()
    // 세로 아이콘 줄(팩 줄 · 접힌 spaces)은 아래로 띄우면 다음 아이콘을 가려서 오른쪽에
    if (node.closest('.pack-rail, .spaces.collapsed')) {
      tip.style.left = `${rect.right + TIP_GAP}px`
      tip.style.top = `${Math.max(4, Math.min(rect.top + rect.height / 2 - box.height / 2, innerHeight - box.height - 4))}px`
      return
    }
    const left = rect.left + rect.width / 2 - box.width / 2
    tip.style.left = `${Math.max(4, Math.min(left, innerWidth - box.width - 4))}px`
    // 아래 자리가 모자라면(맨 아래 접힌 에이전트 모니터 등) 버튼 위로
    const below = rect.bottom + TIP_GAP
    tip.style.top = `${below + box.height > innerHeight - 4 ? rect.top - TIP_GAP - box.height : below}px`
  }
  // 띄울 때는 그 자리의 버튼을 다시 찾는다 — 왼쪽 spaces 는 데몬 상태마다 다시 그려져 기다리는 사이 버튼이 바뀐다
  const tipAt = (point) => tipTarget(document.elementFromPoint(point.x, point.y))
  document.addEventListener('mouseover', (event) => {
    const node = tipTarget(event.target)
    if (node === target) return
    // 다시 그려져 같은 버튼이 새 요소로 바뀐 것뿐이면(탭 줄 · spaces) 툴팁을 그대로 둔다
    if (node && target && node.dataset.tip === target.dataset.tip) {
      target = node
      return
    }
    hide()
    if (!node) return
    target = node
    const point = { x: event.clientX, y: event.clientY }
    timer = setTimeout(() => {
      const now = node.isConnected ? node : tipAt(point)
      if (!now) return
      target = now
      show(now)
    }, TIP_DELAY_MS)
  })
  document.addEventListener('mousedown', hide)
  window.addEventListener('blur', hide)
  // 창 밖이나 옆 브라우저 화면(네이티브 뷰) 위로 바로 나가면 mouseover 가 안 온다 — 남지 않게
  document.documentElement.addEventListener('mouseleave', hide)
}

// 작업 공간 아이콘 — 이름 앞 두 글자 + 이름으로 고른 색(같은 이름은 늘 같은 색)
const SPACE_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#7dcfff', '#ff9e64', '#73daca']

export function spaceColor(label) {
  let hash = 0
  for (const character of String(label)) hash = (hash * 31 + character.codePointAt(0)) >>> 0
  return SPACE_COLORS[hash % SPACE_COLORS.length]
}

export function spaceInitials(label) {
  const words = String(label).split(/[-_\s.]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : String(label).slice(0, 2)
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()
}

// 작업 공간 순서 — 아테나(본체) 작업 공간은 늘 맨 위, 나머지는 데몬 순서 그대로
export function orderedWorkspaces() {
  const athena = screen.workspaces.filter(isAthenaWorkspace)
  return [...athena, ...screen.workspaces.filter((workspace) => !athena.includes(workspace))]
}

// 작업 공간의 pane 들 — 탭 순서, 탭 안은 분할 순서(왼쪽 작업 공간 목록 · 작업 공간 닫기)
function workspacePanes(workspaceId) {
  const meta = new Map(screen.panes.filter(isTabPane).map((pane) => [pane.id, pane]))
  return screen.tabs
    .filter((tab) => tab.workspace === workspaceId)
    .flatMap((tab) => StudioLayout.paneIds(tab.tree).filter((id) => meta.has(id)).map((id) => ({ ...meta.get(id), tab: tab.id })))
}

// 팩 레포 중 아직 작업 공간(에이전트 pane)이 없는 것 — 흐리게. 누르면 아테나에게 /call <그 레포 에이전트>
let packRepos = []
async function refreshPackRepos() {
  const next = (await studio.packRepos().catch(() => [])) || []
  if (JSON.stringify(next) === JSON.stringify(packRepos)) return
  packRepos = next
  if (attached) renderSides()
}
// 레포 표시 이름(pack set-repo-name) — 사이드바만. 레포 name 은 그대로(작업 공간 이름 · 경로가 이것으로 찾는다)
function repoLabel(repo) {
  return (repo && (repo.displayName || repo.name)) || ''
}
function packRepoOf(label) {
  return packRepos.find((repo) => repo.name === label) || null
}

// 후보 브랜치 설명 — 로컬 · 10/18 · 마지막 커밋 제목(없으면 "아직 커밋 없음") · 워크트리 있음
function candidateNote(item) {
  const day = item.date ? `${Number(item.date.slice(5, 7))}/${Number(item.date.slice(8, 10))}` : ''
  return [say(`spaces.place.${item.place}`), day, item.noCommits ? say('spaces.noCommits') : item.subject, item.worktree ? say('spaces.hasWorktree') : ''].filter(Boolean).join(' · ')
}

// 부르기 팝업 위 두 줄 — 담당 에이전트 · 메인 체크아웃(브랜치 · 원격과 비교 · 바뀐 파일). git 글자 그대로 보이지 않게 풀어 쓴다
function callMeta(info) {
  const meta = el('dl', 'call-meta')
  const row = (key, value) => meta.append(el('dt', null, key), el('dd', null, value))
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
async function spaceMenu({ workspace, repo }, event) {
  const action = await studio.spaceContextMenu({ workspace: workspace ? workspace.id : null, repo }, { x: Math.round(event.clientX), y: Math.round(event.clientY) })
  if (action === 'close-workspace') return closeWorkspace(workspace)
  if (action === 'repo-look') return runPackFlow(() => editRepoLookDialog(repo))
  if (action === 'repo-reset-name' || action === 'repo-clear-icon') return runPackFlow(() => resetRepoLook(repo, action))
  if (action === 'remove-repo') return runPackFlow(() => removeRepoFromPack(repo))
}

// 레포 이름 · 이미지 — 팩 이름 · 이미지와 같은 대화상자(lookDialog). 레포 name 은 그대로, 화면 표시만(팀과 같이 쓰는 팩 안에 저장)
async function editRepoLookDialog(name) {
  await refreshPackRepos()
  const repo = packRepoOf(name)
  if (!repo) return
  const image = repo.iconPath ? ((await studio.repoIcon(name)) || {}).dataUrl || null : null
  const answer = await lookDialog({ title: say('spaces.look.title'), color: name, image, value: repoLabel(repo), placeholder: name, pickKind: 'repo' })
  if (!answer) return
  const now = packRepoOf(name) || repo
  const results = []
  if (answer.text !== repoLabel(now)) results.push(await studio.repoSetName(name, answer.text ? answer.text : null))
  if (answer.iconChange) results.push(await studio.repoSetIcon(name, answer.iconChange === 'clear', answer.iconChange === 'picked'))
  await refreshPackRepos()
  const failed = results.find((result) => result && !result.ok && !result.canceled)
  if (failed) return packAlert(say('pack.look.failed'), failed.text || failed.message)
}

// 레포 우클릭 [원래 이름으로] · [이미지 지우기]
async function resetRepoLook(name, action) {
  const result = action === 'repo-reset-name' ? await studio.repoSetName(name, null) : await studio.repoSetIcon(name, true)
  await refreshPackRepos()
  if (result && !result.ok && !result.canceled) return packAlert(say('pack.look.failed'), result.text || result.message)
}

// 작업 공간 닫기 — 에이전트가 도는 pane 이 있으면 한 번 묻는다
async function closeWorkspace(workspace) {
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
async function removeRepoFromPack(name) {
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
export async function offerAddRepo({ dir, name }) {
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
async function callRepoAgent(repo) {
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
    const answer = await packDialog({
      title: say('spaces.callTitle', { repo: repo.name }),
      body: [meta, ...(info.candidates.length ? [rows] : []), label, slot],
      input: { placeholder: say('spaces.callNewPlaceholder'), code: true, label: say('spaces.callNewLabel') },
      actions: [{ label: say('spaces.callStart'), value: 'new', kind: 'primary' }, { label: say('common.cancel'), value: null }],
    })
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

export function renderSides() {
  // 왼쪽: 작업 공간(레포)만 — 그리기는 React(ui/spaces.tsx). 접기 · 펴기(collapsed 클래스)는 여기서
  const labels = new Set(screen.workspaces.map((workspace) => workspace.label))
  StudioUi.spaces.render({
    collapsed: $('spaces').classList.contains('collapsed'),
    tabKey: state.tabKey,
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
function spacesActions() {
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

// ── 오른쪽 Explorer (파일 · 변경) ──
// 칸 몸통(머리줄 · 폴더 트리 · 변경 목록)과 그 상태 · 읽기는 React(ui/explorer.tsx · PR-R9). 여기는 껍데기 — 접기 · 펴기 · 3초 타이머 · 미리보기(뷰어)
function explorerActions() {
  return {
    workspaceOf: (id) => screen.workspaces.find((entry) => entry.id === id),
    tabKey: () => state.tabKey,
    foldIcon: PANEL_ICONS.right,
    openPreview,
    collapse: () => setPanelHidden(true),
  }
}

// 선 아이콘(24 격자 · 글자색을 따름)
export function lineIcon(paths) {
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const shape of paths) {
    const path = document.createElementNS(svgNs, 'path')
    path.setAttribute('d', shape)
    svg.append(path)
  }
  return svg
}

// 미리보기(뷰어) — VSCode 처럼 확장자에 맞는 색(Dark+)과 줄 번호. 바뀐 파일은 diff(옛·새 번호 · 추가 초록 · 삭제 빨강), 이미지는 그림.
// 터미널 pane 옆에 나눠 띄우고(터미널은 줄어든 폭으로 다시 맞춘다) Esc · ✕ 로 닫는다
const FONT_STYLE = { italic: 1, bold: 2, underline: 4 }

function viewerLine(row, diff) {
  const line = document.createElement('div')
  line.className = `vl ${row.kind}`
  const number = (value) => {
    const cell = document.createElement('span')
    cell.className = 'no'
    cell.textContent = value === undefined ? '' : String(value)
    return cell
  }
  const code = document.createElement('span')
  code.className = 'code'
  if (row.kind === 'hunk' || !row.tokens) {
    code.textContent = row.code || ' '
  } else {
    for (const [text, color, style] of row.tokens) {
      const piece = document.createElement('span')
      piece.textContent = text
      if (color) piece.style.color = color
      if (style & FONT_STYLE.italic) piece.style.fontStyle = 'italic'
      if (style & FONT_STYLE.bold) piece.style.fontWeight = 'bold'
      if (style & FONT_STYLE.underline) piece.style.textDecoration = 'underline'
      code.append(piece)
    }
    if (!row.tokens.length) code.textContent = ' '
  }
  const sign = document.createElement('span')
  sign.className = 'sign'
  sign.textContent = { add: '+', del: '-' }[row.kind] || ''
  line.append(...(diff ? [number(row.oldNo), number(row.newNo), sign] : [number(row.newNo)]), code)
  return line
}

async function openPreview(relative) {
  const result = await studio.explorerOpen(StudioUi.explorer.workspace(), relative)
  const body = $('preview-body')
  const preview = $('preview')
  $('preview-title').textContent = result.path || relative
  const note = (text) => {
    const line = document.createElement('div')
    line.className = 'note'
    line.textContent = text
    return line
  }
  body.className = 'preview-body'
  body.style.background = ''
  body.style.color = ''
  if (result.error) body.replaceChildren(note(result.error))
  else if (result.kind === 'binary') body.replaceChildren(note(say('preview.binary', { size: result.size })))
  else if (result.kind === 'image') {
    const image = document.createElement('img')
    image.className = 'viewer-image'
    image.alt = result.path
    image.src = result.src
    body.className = 'preview-body image'
    body.replaceChildren(image)
  } else {
    const diff = result.kind === 'diff'
    // 바탕은 터미널과 같게(CSS --bg) — 글자색만 테마(Shiki)를 따른다
    if (result.fg) body.style.color = result.fg
    body.replaceChildren(...result.rows.map((row) => viewerLine(row, diff)))
    if (result.untracked) body.prepend(note(say('preview.untracked')))
    if (result.truncated) body.append(note(say('preview.truncated')))
  }
  preview.hidden = false
  body.scrollTop = 0
  preview.focus()
}

function closePreview() {
  $('preview').hidden = true
  const focused = views.get(screen.focused)
  if (focused) focused.term.focus()
}

// 오른쪽 Explorer 접기·펴기(⌘⌥B) — 접으면 좁은 줄만 남는다. 앱을 다시 켜도 기억한다
export function setPanelHidden(hidden) {
  $('side-panel').hidden = hidden
  $('side-rail').hidden = !hidden
  localStorage.setItem('studio.panelHidden', hidden ? '1' : '0')
  if (!hidden) StudioUi.explorer.render()
  requestAnimationFrame(layoutPanes)
}

// 저장된 접기 설정대로 양쪽을 맞춘다 — 시작 화면(팩 고르기) 동안은 저장값과 상관없이 양쪽을 접는다(저장은 안 바꾼다 · 들어가면 원래대로)
export function applySideFolds() {
  const welcome = welcomeShown()
  const panelHidden = welcome || localStorage.getItem('studio.panelHidden') === '1'
  $('spaces').classList.toggle('collapsed', welcome || localStorage.getItem('studio.spacesCollapsed') === '1')
  $('side-panel').hidden = panelHidden
  $('side-rail').hidden = !panelHidden
  if (!attached) return
  renderSides()
  if (!panelHidden) StudioUi.explorer.render()
  requestAnimationFrame(layoutPanes)
}

// 왼쪽 작업 공간 접기·펴기(⌘B) — 접으면 아이콘 줄
export function setSpacesCollapsed(collapsed) {
  $('spaces').classList.toggle('collapsed', collapsed)
  localStorage.setItem('studio.spacesCollapsed', collapsed ? '1' : '0')
  renderSides()
  requestAnimationFrame(layoutPanes)
}

// ── 옆 브라우저 ──────────────────────────────────────────
// 오른쪽에서 스르륵 나오는 서랍. 페이지는 main 의 WebContentsView 가 그린다 — 화면 위에 따로 떠 있어서
// 다 나온 뒤에 자리(#browser-slot)를 알려 붙이고, 닫을 땐 먼저 떼고 미끄러져 들어간다.
// 막대(앞뒤 · 새로고침 · 주소 칸 · 기본 브라우저 · 닫기)와 알림 줄은 React(ui/browser-bar.tsx) — 서랍 껍데기 · 너비 끌기는 여기
const BROWSER_SLIDE_MS = 240
export let browserOpen = false
let browserTimer = null
let urlFocusTimer = null

function openBrowserPanel() {
  if (welcomeShown()) return // 팩을 고르기 전에는 옆 브라우저를 열지 않는다(⌘⇧B · 링크 열기 포함)
  const panel = $('browser')
  if (browserOpen) return placeBrowserView()
  browserOpen = true
  clearTimeout(browserTimer)
  panel.hidden = false
  $('browser-toggle').classList.add('active')
  $('browser-toggle').setAttribute('aria-expanded', 'true')
  void panel.offsetWidth // 숨김을 푼 뒤 한 번 그려야 transform 이 스르륵 움직인다
  panel.classList.add('open')
  browserTimer = setTimeout(() => {
    browserTimer = null
    placeBrowserView()
  }, BROWSER_SLIDE_MS)
}

export function closeBrowserPanel() {
  const panel = $('browser')
  if (!browserOpen) return
  browserOpen = false
  clearTimeout(browserTimer)
  clearTimeout(urlFocusTimer)
  studio.browserHide()
  panel.classList.remove('open', 'resizing')
  $('browser-toggle').classList.remove('active')
  $('browser-toggle').setAttribute('aria-expanded', 'false')
  // 닫으면 작업 창 터미널로 입력을 돌려준다
  const focused = views.get(screen.focused)
  if (currentTab === 'work' && focused && !focused.el.hidden) focused.term.focus()
  browserTimer = setTimeout(() => {
    browserTimer = null
    panel.hidden = true
  }, BROWSER_SLIDE_MS)
}

// 다 나온 서랍의 자리 — 슬라이드 중(transform)이면 아직 붙이지 않는다
export function placeBrowserView() {
  if (modalOpen()) return // 대화상자 위를 덮지 않게 — 닫힐 때 syncModal 이 다시 붙인다
  if (!browserOpen || browserTimer || $('browser').hidden || $('browser').classList.contains('resizing')) return
  const rect = $('browser-slot').getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  studio.browserPlace({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
}

function toggleBrowserPanel() {
  if (browserOpen) return closeBrowserPanel()
  openBrowserPanel()
  // 처음이면 주소창부터 — 다 나온 뒤에, 스크롤 없이(나오는 중에 포커스를 주면 뒤 화면이 밀린다).
  // 그사이 닫았거나 다른 곳을 눌렀으면 하지 않는다
  if (StudioUi.browser.url()) return
  clearTimeout(urlFocusTimer)
  const before = document.activeElement
  urlFocusTimer = setTimeout(() => {
    if (browserOpen && document.activeElement === before) StudioUi.browser.focusUrl()
  }, BROWSER_SLIDE_MS)
}

// main 알림(browser:state) — 서랍의 읽는 중 표시 · 제목은 여기, 막대는 React
function applyBrowserState(next) {
  $('browser').classList.toggle('loading', Boolean(next.loading))
  $('browser').title = next.title || ''
  StudioUi.browser.applyState(next)
}

// 너비 끌기 — 끄는 동안은 페이지(화면 위에 떠 있는 뷰)를 떼어 둔다. 마우스가 페이지 위로 지나가도 끌기가 이어지게
const BROWSER_MIN_WIDTH = 320
const BROWSER_EDGE_GAP = 120 // 왼쪽에 이만큼은 남긴다

function clampBrowserWidth(width) {
  return Math.round(Math.min(Math.max(width, BROWSER_MIN_WIDTH), Math.max(BROWSER_MIN_WIDTH, window.innerWidth - BROWSER_EDGE_GAP)))
}

function setBrowserWidth(width) {
  const panel = $('browser')
  if (width === null) {
    panel.style.width = ''
    localStorage.removeItem('studio.browserWidth')
  } else {
    panel.style.width = `${clampBrowserWidth(width)}px`
    localStorage.setItem('studio.browserWidth', String(clampBrowserWidth(width)))
  }
}

function initBrowserResize() {
  const panel = $('browser')
  const handle = $('browser-resize')
  // 저장된 너비(없으면 기본 46%)
  const applySaved = () => {
    const saved = Number(localStorage.getItem('studio.browserWidth'))
    panel.style.width = saved > 0 ? `${clampBrowserWidth(saved)}px` : ''
  }
  applySaved()
  let dragging = false
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !browserOpen) return
    dragging = true
    handle.setPointerCapture(event.pointerId)
    panel.classList.add('resizing')
    studio.browserHide()
    event.preventDefault()
  })
  handle.addEventListener('pointermove', (event) => {
    // 끄는 중에 서랍을 닫으면(resizing 이 지워짐) 끌기도 끝난 것
    if (dragging && panel.classList.contains('resizing')) panel.style.width = `${clampBrowserWidth(window.innerWidth - event.clientX)}px`
  })
  // 놓기 · 취소 · 캡처를 잃음 모두 여기로. 그사이 서랍을 닫았으면 너비는 저장하지 않는다
  const finish = (event) => {
    if (!dragging) return
    dragging = false
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    const stillResizing = panel.classList.contains('resizing')
    panel.classList.remove('resizing')
    // 끄다가 서랍을 닫았으면 끌던 너비는 버리고 저장된 너비로
    if (!browserOpen || !stillResizing) return applySaved()
    setBrowserWidth(panel.getBoundingClientRect().width)
    placeBrowserView()
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
  handle.addEventListener('lostpointercapture', finish)
  // 너비를 px 로 정해 두면 창을 늘려도 서랍 크기는 그대로라 ResizeObserver 가 안 불린다 — 창 크기가 바뀌면 다시 맞춰 붙인다
  window.addEventListener('resize', () => {
    if (panel.style.width) panel.style.width = `${clampBrowserWidth(parseFloat(panel.style.width))}px`
    placeBrowserView()
  })
  handle.addEventListener('dblclick', () => {
    setBrowserWidth(null)
    requestAnimationFrame(placeBrowserView)
  })
}

function initBrowser() {
  initBrowserResize()
  StudioUi.browser.mount($('browser').querySelector('.browser-bar'), $('browser-error'), { close: closeBrowserPanel, place: placeBrowserView })
  $('browser-toggle').addEventListener('click', toggleBrowserPanel)
  studio.onBrowserOpen((url) => {
    StudioUi.browser.setUrl(url)
    StudioUi.browser.showError('')
    openBrowserPanel()
  })
  // 팩을 바꿨다 — 서랍을 닫고 주소 칸을 비운다(새 팩에서 열면 그 팩에서 보던 페이지로)
  studio.onBrowserReset(() => {
    if (browserOpen) closeBrowserPanel()
    StudioUi.browser.setUrl('')
    StudioUi.browser.showError('')
  })
  studio.onBrowserToggle(toggleBrowserPanel)
  studio.onBrowserState(applyBrowserState)
  studio.onBrowserError(StudioUi.browser.showError)
  studio.onBrowserClose(closeBrowserPanel) // 결정 콘솔 [이대로 진행] 을 보낸 뒤(main 이 알린다)
  // 창 크기가 바뀌면 서랍(너비 46%)도 바뀐다 — 다 나와 있을 때만 다시 붙인다
  new ResizeObserver(() => placeBrowserView()).observe($('browser-slot'))
}

// ── [작업] 팝업 · 일감 페이지 메뉴 ────────────────────────────
// 칸반 대신 탭 줄 [작업] — 나를 기다리는 것(사람에게 묻는 요청) · 진행 중 · 최근 끝난 것. 작업을 누르면 상세, 질문을 누르면 앱 안에서 바로 답한다.
// 요청 수는 main 이 요청 폴더를 보다가 바뀔 때 알린다(onWorkRequests) · 목록 전체는 팝업을 열 때 읽는다(일감을 띄운다)
let workRequests = { supported: false, requests: [] }
let workData = null // 마지막으로 읽은 목록(workGet) — 진행 중 숫자
const WORK_STATES = ['wait', 'work', 'blocked', 'idle', 'done']

function renderWorkTab() {
  const waiting = workRequests.requests.filter((request) => request.state === 'open').length
  // 숫자는 두지 않는다(사용자) — 있다는 것만 점으로, 수는 툴팁에
  $('work-ask').hidden = !waiting
  const doing = workData ? workData.counts.doing : 0
  $('work-tab').classList.toggle('asking', waiting > 0)
  $('work-tab').dataset.tip = say('work.tip', { doing, waiting })
}

// 탭 줄 버튼 아래에 붙인다 — 오른쪽 끝을 버튼 오른쪽에 맞춘다
function placeUnder(pop, button) {
  const rect = button.getBoundingClientRect()
  pop.style.top = `${Math.round(rect.bottom + 6)}px`
  pop.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`
}

let popBefore = null
function closePops() {
  for (const [pop, button] of [['work-pop', 'work-tab'], ['board-menu', 'board-tab'], ['settings-pop', 'settings-tab']]) {
    if ($(pop).hidden) continue
    $(pop).hidden = true
    if (pop === 'settings-pop') StudioUi.settings.close() // React 몸통을 내린다(다음에 열 때 읽는 중부터)
    if (pop === 'work-pop') StudioUi.work.close()
    $(button).setAttribute('aria-expanded', 'false')
    $(button).classList.remove('active')
  }
  if (popBefore instanceof HTMLElement && popBefore.isConnected) popBefore.focus({ preventScroll: true })
  popBefore = null
}
function openPop(pop, button) {
  closePops()
  popBefore = document.activeElement
  placeUnder($(pop), $(button))
  $(pop).hidden = false
  $(button).setAttribute('aria-expanded', 'true')
  $(button).classList.add('active')
}

// 몸통(work-pop-body)은 React(ui/work-pop.tsx) — 여기는 머리줄 팩 이름과 그릴 값 넘기기만
function renderWorkPop() {
  $('work-pop-title').textContent = say('work.popTitle', { pack: (packs.current && packLabel(packs.current)) || '' })
  StudioUi.work.setWork(workData, workData ? workData.requests : workRequests.requests)
}

async function toggleWorkPop() {
  if (!$('work-pop').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('work-pop', 'work-tab')
  renderWorkPop()
  StudioUi.work.open($('work-pop-body'), { openRequest, openWorkDetail })
  const first = $('work-pop-body').querySelector('button')
  if (first) first.focus({ preventScroll: true })
  workData = await studio.workGet()
  if ($('work-pop').hidden) return renderWorkTab()
  if (workData && Array.isArray(workData.requests)) workRequests = { supported: workData.supported, requests: workData.requests }
  renderWorkTab()
  renderWorkPop()
}

function toggleBoardMenu() {
  if (!$('board-menu').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('board-menu', 'board-tab')
  $('board-menu').querySelector('button').focus({ preventScroll: true })
}

// 작업 상세 — 계획서에서 왜 · 정한 것 · 진행 · 검증 · 결과 · 다음
async function openWorkDetail(item) {
  closePops()
  const detail = await studio.workDetail(item.id)
  const body = []
  if (!detail || !detail.ok) body.push(el('p', 'muted', say('work.detail.unreadable')))
  else {
    const field = (key, value) => {
      if (!value || (Array.isArray(value) && !value.length)) return
      const row = el('div', 'work-field')
      row.append(el('span', 'work-field-key', say(`work.detail.${key}`)))
      const text = el('span', 'work-field-value')
      if (Array.isArray(value)) text.append(...value.map((line) => el('span', 'work-field-line', line)))
      else text.textContent = value
      row.append(text)
      body.push(row)
    }
    field('why', detail.why)
    field('blocked', detail.blocked)
    field('decided', detail.decided)
    if (detail.progress.total) {
      const row = el('div', 'work-field')
      row.append(el('span', 'work-field-key', say('work.detail.progress')))
      const value = el('span', 'work-field-value', `${detail.progress.checked}/${detail.progress.total}${detail.progress.now ? ` · ${detail.progress.now}` : ''}`)
      const bar = el('span', 'work-steps')
      for (let index = 0; index < detail.progress.total; index += 1) bar.append(el('i', index < detail.progress.checked ? 'done' : index === detail.progress.checked ? 'now' : ''))
      value.append(bar)
      row.append(value)
      body.push(row)
    }
    field('validation', detail.validation)
    field('results', detail.results)
    field('next', detail.next)
  }
  const actions = [{ label: say('work.detail.openPlan'), value: 'plan' }]
  if (item.html) actions.push({ label: say('work.detail.console'), value: 'console' })
  const pane = item.agents.find(paneLive)
  if (pane) actions.push({ label: say('work.detail.goPane'), value: 'pane', kind: 'primary' })
  const choice = await packDialog({ title: item.title, subtitle: say(`work.state.${item.state}`), body, actions, close: true })
  if (choice === 'plan') studio.workOpenPlan(item.id, null)
  else if (choice === 'console') studio.workOpenPlan(item.id, item.html)
  else if (choice === 'pane') goToPane(pane)
}

// ── pane [상세] ─────────────────────────────────────────────
// 계획서에 묶인 pane(그 계획서를 하는 에이전트 · 맡긴 아테나) 머리 줄 오른쪽 아이콘 → 작업 창 위에 오른쪽에서 뜨는 팝업.
// 팝업은 레이아웃에 끼지 않는다(position: fixed) — pane · spaces · Explorer · 모니터 크기와 터미널 크기는 그대로.
// 몸통은 React(ui/pane-detail.tsx — 3초마다 다시 읽기 · [더 보기] · 뒤로 간 스크롤) · 여기는 껍데기(아이콘 · 열기 · 닫기 · 머리줄 · [← 맡긴 일])
let paneBound = {} // pane id → 'agent' | 'lead'
let detailPane = null
// 아테나 목록에서 들어온 상세면 돌아갈 자리 — { paneId, scroll } · 에이전트 pane 에서 바로 열면 null
let detailBack = null
// 아이콘 — 체크리스트 모양(사용자 확정 2026-10-27 · 시안 B)
const PANE_DETAIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2"/><circle cx="5" cy="18" r="1"/></svg>'

export function paneDetailButton(paneId) {
  const button = el('button', 'pane-detail-btn')
  button.type = 'button'
  button.hidden = true
  button.innerHTML = PANE_DETAIL_ICON
  button.title = say('pane.detail.open')
  button.setAttribute('aria-label', say('pane.detail.open'))
  button.setAttribute('aria-controls', 'pane-detail')
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    togglePaneDetail(paneId)
  })
  return button
}

export function syncDetailButton(paneId, view) {
  view.detailButton.hidden = !paneBound[paneId]
  view.detailButton.setAttribute('aria-expanded', String(detailPane === paneId))
  view.detailButton.classList.toggle('active', detailPane === paneId)
}
function syncDetailButtons() {
  for (const [paneId, view] of views) syncDetailButton(paneId, view)
}

function togglePaneDetail(paneId) {
  if (detailPane === paneId) return closePaneDetail()
  return openPaneDetail(paneId)
}

// from: 아테나 목록에서 들어올 때 돌아갈 자리 · restore: 뒤로 가기로 돌아올 때 맞출 스크롤
function openPaneDetail(paneId, { from = null, restore = null } = {}) {
  closePops()
  const pop = $('pane-detail')
  const first = detailPane === null
  detailPane = paneId
  detailBack = from
  $('pane-detail-back').hidden = !detailBack
  const bar = document.querySelector('.tabbar')
  pop.style.top = `${Math.round(bar ? bar.getBoundingClientRect().bottom : 0)}px`
  // 처음이거나 다른 pane 이면 읽는 중부터 · 같은 pane 이면 그린 것을 두고 바로 다시 읽는다
  StudioUi.paneDetail.open($('pane-detail-body'), paneId, restore, paneDetailActions)
  if (first) {
    pop.hidden = false
    requestAnimationFrame(() => pop.classList.add('open'))
  }
  $('pane-detail-body').scrollTop = 0
  syncDetailButtons()
  $(detailBack ? 'pane-detail-back' : 'pane-detail-close').focus({ preventScroll: true })
}

function backPaneDetail() {
  if (!detailBack) return
  const { paneId, scroll } = detailBack
  // 그사이 아테나 pane 이 닫혔으면 돌아갈 목록이 없다 — 들어갈 때(paneLive)와 같이 본다
  if (!paneLive(paneId)) return closePaneDetail()
  return openPaneDetail(paneId, { restore: scroll })
}

function closePaneDetail() {
  if (detailPane === null) return
  detailPane = null
  detailBack = null
  // 다시 읽기는 바로 멈추고, 몸통은 미끄러져 나간 뒤 내린다
  StudioUi.paneDetail.stop()
  const pop = $('pane-detail')
  pop.classList.remove('open')
  setTimeout(() => {
    if (detailPane !== null) return
    pop.hidden = true
    StudioUi.paneDetail.close()
  }, 180)
  syncDetailButtons()
  focusCurrentTerminal()
}

// React 몸통이 부르는 바닐라 쪽 — 다른 pane 상세 · pane 으로 가기 · 요청 대화상자 · 머리줄 이름
const paneDetailActions = {
  openPane: (paneId, from) => openPaneDetail(paneId, { from }),
  goToPane: (paneId) => {
    closePaneDetail()
    goToPane(paneId)
  },
  paneLive: (paneId) => paneLive(paneId),
  openRequest: (id) => {
    const known = workRequests.requests.find((entry) => entry.id === id)
    if (known) openRequest(known)
  },
  setLabel: (text) => {
    $('pane-detail-pane').textContent = text
  },
}

// pane 이 다른 탭 · 작업 공간에 있어도 — 왼쪽 목록에서 누른 것과 같다
const paneLive = (paneId) => Boolean(paneId) && screen.panes.some((pane) => pane.id === paneId)
async function goToPane(paneId) {
  const pane = screen.panes.find((entry) => entry.id === paneId)
  if (!pane) return
  await studio.tabSelect(pane.tab)
  focusPane(pane.id)
}

// 질문 · 결정 — 질문은 앱 안에서 바로 답하고, 결정(정식 계획서)은 결정 콘솔로
async function openRequest(request) {
  closePops()
  if (request.kind === 'decision') {
    const choice = await packDialog({
      title: request.title,
      subtitle: say('work.kind.decision'),
      body: [el('p', 'work-request-body', request.body), el('p', 'muted', say('work.decisionNote'))],
      actions: [{ label: say('work.detail.console'), value: 'console', kind: 'primary' }],
      close: true,
    })
    if (choice === 'console') studio.workOpenPlan(request.plan || '', request.html)
    return
  }
  if (request.state === 'answered') {
    const answer = [request.answer && request.answer.choice, request.answer && request.answer.text].filter(Boolean).join(' · ')
    const choice = await packDialog({
      title: request.title,
      subtitle: say('work.notDelivered'),
      body: [el('p', null, say('work.answeredNote', { answer }))],
      actions: [{ label: say('work.resend'), value: 'resend', kind: 'primary' }],
      close: true,
    })
    if (choice === 'resend') reportDelivery(await studio.workRedeliver(request.id))
    return
  }
  const body = []
  if (request.body) body.push(el('p', 'work-request-body', request.body))
  let picked = (request.options.find((option) => option.recommended) || request.options[0] || {}).label || ''
  if (request.options.length) {
    const list = el('div', 'work-options')
    list.setAttribute('role', 'radiogroup')
    for (const option of request.options) {
      const row = el('button', 'work-option')
      row.type = 'button'
      row.setAttribute('role', 'radio')
      const sync = () => {
        for (const node of list.children) node.setAttribute('aria-checked', String(node === row))
      }
      const label = el('span', 'work-option-label', option.label)
      if (option.recommended) label.append(el('span', 'work-rec', say('work.recommended')))
      const text = el('span', null)
      text.append(label)
      if (option.desc) text.append(el('small', null, option.desc))
      row.append(el('span', 'work-radio'), text)
      row.setAttribute('aria-checked', String(option.label === picked))
      row.addEventListener('click', () => {
        picked = option.label
        sync()
      })
      list.append(row)
    }
    body.push(list)
  }
  const note = el('textarea', 'work-note')
  note.placeholder = say('work.notePlaceholder')
  note.maxLength = 1500
  body.push(note)
  const meta = [request.waited ? say('work.waited', { time: request.waited }) : ''].filter(Boolean).join(' · ')
  const actions = [{ label: say('work.send'), value: 'send', kind: 'primary' }]
  if (paneLive(request.pane)) actions.unshift({ label: say('work.detail.goPane'), value: 'pane' })
  const choice = await packDialog({ title: request.title, subtitle: [say('work.kind.question'), meta].filter(Boolean).join(' · '), body, actions, close: true })
  if (choice === 'pane') return goToPane(request.pane)
  if (choice !== 'send') return
  if (!picked && !note.value.trim()) return showToast(say('work.needAnswer'), 'info')
  const result = await studio.workAnswer(request.id, { choice: picked, text: note.value })
  if (!result || !result.ok) return showToast(say(result && result.error === 'conflict' ? 'work.answerConflict' : 'work.answerFailed', { message: (result && result.message) || '' }))
  reportDelivery(result)
}

// ── ⚙ 설정 팝업 — 이 창 팩의 레포별 PR 자동 리뷰 · 머지 + 앱 업데이트 ─────────────────────
// 몸통(settings-pop-body)은 React(ui/settings-pop.tsx) — 여기는 껍데기(열기 · 닫기 · 머리줄 팩 이름)와 ⚙ 의 업데이트 점만
function applyAppUpdate(next) {
  $('settings-tab').classList.toggle('has-update', Boolean(next && next.state === 'behind'))
  StudioUi.settings.setAppUpdate(next || null)
}

function toggleSettingsPop() {
  if (!$('settings-pop').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('settings-pop', 'settings-tab')
  $('settings-pop-pack').textContent = (packs.current && packLabel(packs.current)) || ''
  StudioUi.settings.open($('settings-pop-body'))
}

function reportDelivery(result) {
  if (!result || !result.ok) return showToast(say('work.answerFailed', { message: (result && result.message) || '' }))
  showToast(say(result.delivered ? 'work.sent' : 'work.savedNoPane'), result.delivered ? 'success' : 'info')
}

function initWork() {
  $('work-tab').addEventListener('click', toggleWorkPop)
  $('board-tab').addEventListener('click', toggleBoardMenu)
  $('settings-tab').addEventListener('click', toggleSettingsPop)
  studio.onAppUpdate(applyAppUpdate)
  studio.appUpdateStatus().then((next) => next && !next.error && applyAppUpdate(next))
  for (const item of document.querySelectorAll('#board-menu [data-section]')) {
    item.addEventListener('click', () => {
      closePops()
      studio.openBoardSection(item.dataset.section)
    })
  }
  $('diagrams-open').addEventListener('click', async () => {
    closePops()
    const result = await studio.openDiagrams()
    if (result && result.ok) return
    showToast(result && result.error === 'missing' ? say('board.diagramsMissing') : say('board.diagramsFailed', { message: (result && result.message) || '' }))
  })
  $('work-pop-pages').addEventListener('click', () => {
    closePops()
    openPop('board-menu', 'board-tab')
  })
  // 바깥을 누르거나 Esc — 닫는다(대화상자가 떠 있으면 대화상자가 Esc 를 먼저 받는다)
  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('#work-pop, #board-menu, #settings-pop, #work-tab, #board-tab, #settings-tab')) return
    closePops()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (!$('work-pop').hidden || !$('board-menu').hidden || !$('settings-pop').hidden)) {
      event.preventDefault()
      closePops()
    }
  })
  window.addEventListener('resize', closePops)
  // pane [상세] — 바깥을 누르거나 Esc 면 닫는다(다른 팝업과 같은 관례). 아이콘을 다시 눌러도 닫힌다
  document.addEventListener('mousedown', (event) => {
    if (detailPane === null || event.target.closest('#pane-detail, .pane-detail-btn')) return
    closePaneDetail()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || detailPane === null) return
    event.preventDefault()
    closePaneDetail()
  })
  $('pane-detail-close').addEventListener('click', closePaneDetail)
  $('pane-detail-back').addEventListener('click', backPaneDetail)
  studio.onPaneBound((next) => {
    paneBound = next && typeof next === 'object' ? next : {}
    syncDetailButtons()
  })
  studio.paneBound().then((next) => {
    paneBound = next && typeof next === 'object' ? next : {}
    syncDetailButtons()
  }).catch(() => {})
  studio.onWorkRequests((next) => {
    workRequests = next && Array.isArray(next.requests) ? next : { supported: false, requests: [] }
    if (workData) workData = { ...workData, requests: workRequests.requests.map((request) => ({ ...request, waited: (workData.requests.find((known) => known.id === request.id) || {}).waited || '' })) }
    renderWorkTab()
    if (!$('work-pop').hidden) renderWorkPop()
  })
  studio.onWorkOpen((id) => {
    const request = id && workRequests.requests.find((entry) => entry.id === id)
    if (request) return openRequest(request)
    if ($('work-pop').hidden) toggleWorkPop()
  })
  studio.workRequests().then((next) => {
    if (next && Array.isArray(next.requests)) workRequests = next
    renderWorkTab()
  })
  renderWorkTab()
}

// ── 회사 팩 ────────────────────────────────────────────────
// 본체가 여러 팩을 지원할 때만 보인다(packs.supported). 일은 main → 아테나 본체 명령이 하고, 화면은 묻고 · 기다리고 · 결과를 보여 준다

// 새 팩 — 빈 자리 + 본체를 만들고 이 창에서 그 팩으로 바꾼다(그 본체 아테나가 /setup)
export async function newPack() {
  showPackProgress(say('pack.new.progress'), true)
  const result = await studio.packNew()
  hidePackProgress()
  if (result.canceled || result.error === 'canceled') return
  if (!result.ok) return packAlert(say('pack.new.failed'), result.text || result.message)
  if (result.switched) await applySwitchedPack(result.state)
  showToast(say('pack.new.opened'), 'success')
}

// 가져오기 — 종류 고르기 → 검사(main 이 대화상자) → 같은 이름이면 나란히 비교 → 등록 → "지금 바꿀까요?"
export async function importPack() {
  let target = null
  const options = el('div', 'pack-links')
  for (const value of ['file', 'folder', 'git', 'athena']) options.append(popupOption('pack-command', value, value, say(`pack.import.kind.${value}`), say(`pack.import.kind.${value}Note`)))
  const chosen = await packDialog({
    title: say('pack.import.title'),
    subtitle: say('pack.import.where'),
    body: [options],
    close: true,
  })
  if (!chosen) return
  // 기존 아테나는 git 설정(.git)을 그대로 가져온다(R4 A) — 내 컴퓨터에서 쓰던 것만 고르게 먼저 알린다
  if (chosen === 'athena') {
    const ok = await packDialog({
      title: say('pack.import.athena.title'),
      subtitle: say('pack.import.athena.body'),
      body: [el('p', 'muted', say('pack.import.athena.note'))],
      actions: [{ label: say('pack.import.athena.pick'), value: 'go', kind: 'primary' }, { label: say('common.cancel'), value: null }],
    })
    if (!ok) return
  }
  // git 주소 — 잘못된 주소면(main 이 검사) 쓴 그대로 다시 열고 칸 아래 오류
  let inspected = null
  let gitError = ''
  for (;;) {
    if (chosen === 'git') {
      const answer = await packDialog({
        title: say('pack.import.git.title'),
        subtitle: say('pack.import.git.body'),
        input: { placeholder: say('pack.import.git.placeholder'), value: target || '', code: true, label: say('pack.import.git.title'), error: gitError },
        actions: [{ label: say('pack.import.git.inspect'), value: 'go', kind: 'primary' }, { label: say('common.cancel'), value: null }],
      })
      if (!answer || !answer.value) return
      target = answer.text.trim()
    }
    showPackProgress(say('pack.import.inspecting'), true)
    inspected = await studio.packInspect(chosen, target)
    hidePackProgress()
    if (chosen !== 'git' || inspected.error !== 'invalid-url') break
    gitError = inspected.text || inspected.message
  }
  if (inspected.canceled || inspected.error === 'canceled') return
  if (!inspected.ok) return packAlert(say('pack.import.failed'), inspected.text || inspected.message)
  const choice = await chooseImport(inspected, chosen)
  if (!choice) return studio.packImport(inspected.token, 'keep')
  // 교체는 본체가 그 팩 본체 기준으로 판단한다(일하는 중이면 busy 로 막는다) — pane 을 닫지 않는다
  showPackProgress(say('pack.import.registering'), false)
  const result = await studio.packImport(inspected.token, choice)
  hidePackProgress()
  if (!result.ok) return packAlert(say('pack.import.failed'), result.text || result.message)
  if (choice === 'keep') return
  // 끝 — 팩 한 줄(아이콘 · 이름 · 레포) · 백업 · git 안내 · [나중에] [열기]
  const imported = result.imported
  const intoCurrent = !imported || (packs.current && packs.current.id === imported.id)
  const body = []
  if (imported) {
    const name = imported.name || imported.id
    const card = el('div', 'pack-result-card')
    const avatar = el('span', 'space-icon pack-icon pack-avatar', spaceInitials(name))
    avatar.setAttribute('aria-hidden', 'true')
    avatar.style.setProperty('--space-color', spaceColor(imported.id))
    const copy = el('div')
    copy.append(el('b', null, name))
    const repos = inspected.pack && inspected.pack.repos
    if (Number.isInteger(repos)) copy.append(el('small', null, say('pack.meta.repos', { count: repos })))
    card.append(avatar, copy)
    body.push(card)
  }
  if (result.backup) body.push(el('p', 'pack-result-note', say('pack.import.backedUp', { path: result.backup })))
  // 백업 때 하던 작업(에이전트 대화 · 워크트리)이 함께 왔으면 — 열면서 되살릴지 고른다(안 고르면 남겨 둔다)
  const restore = inspected.restore
  if (restore) body.push(el('p', 'pack-result-note', say('pack.restore.offer', restore)), el('p', 'pack-result-note', say('pack.restore.note')))
  // R4 A — 폴더 · 압축에서 온 .git 은 코어가 지웠다(inspect 결과 gitRemoved)
  if (inspected.gitRemoved) body.push(el('p', 'pack-result-note', say('pack.import.gitRemoved')))
  const openNow = await packDialog({
    title: say('pack.import.done'),
    subtitle: say(intoCurrent ? 'pack.import.intoCurrent' : 'pack.import.openNow'),
    body,
    actions: restoreActions(intoCurrent, Boolean(restore)),
  })
  if (openNow === 'restore') {
    if (intoCurrent) {
      showPackProgress(say('pack.restore.progress'), false)
      const restored = await studio.packRestoreNow()
      hidePackProgress()
      return showRestoreResult(restored)
    }
    await studio.packRestoreArm(imported.id)
    setRestoreArmed(true)
    const opened = await switchPack(imported.id)
    // 열지 못했거나 다른 창으로 갔으면 이 창의 예약은 지운다(main 의 예약은 그 팩을 연 창이 쓰거나 여기서 지운다)
    if (!packs.current || packs.current.id !== imported.id) {
      setRestoreArmed(false)
      studio.packRestoreDisarm()
    }
    return opened
  }
  if (openNow === 'yes') return switchPack(imported.id)
}

// 가져오기 끝 버튼 — 되살릴 작업이 있으면 [열고 작업 되살리기](지금 팩이면 [작업 되살리기])가 확인 자리
function restoreActions(intoCurrent, restore) {
  if (intoCurrent) return restore ? [{ label: say('pack.restore.now'), value: 'restore', kind: 'primary' }, { label: say('common.later'), value: null }] : [{ label: say('common.ok'), value: 'ok', kind: 'primary' }]
  const actions = [{ label: say('pack.verb.open'), value: 'yes', kind: restore ? undefined : 'primary' }, { label: say('common.later'), value: null }]
  if (restore) actions.unshift({ label: say('pack.restore.openAndRestore'), value: 'restore', kind: 'primary' })
  return actions
}

// 같은 이름이면 나란히(사용자 결정 3) · 기존 아테나면 가져올 작업 기록도 보여 준다. 반환: new · replace · keep(null 은 취소)
async function chooseImport(inspected, kind) {
  const name = (inspected.pack && inspected.pack.name) || say('pack.import.defaultName')
  const body = []
  if (inspected.work) {
    const work = inspected.work
    const worktrees = work.worktrees || []
    const dirty = worktrees.filter((tree) => tree.dirty).length
    body.push(say('pack.import.work', { plans: work.plans || 0, issues: work.issues || 0, archive: work.archive || 0 }))
    if (worktrees.length) body.push(el('p', 'muted', say('pack.import.worktrees', { count: worktrees.length, dirty })))
  }
  if (!inspected.conflict) {
    if (kind !== 'athena') return 'new'
    const ok = await packDialog({ title: say('pack.import.athenaTitle', { name }), body, actions: [{ label: say('pack.import.go'), value: 'new', kind: 'primary' }, { label: say('common.cancel'), value: null }] })
    return ok
  }
  const compare = el('div', 'pack-compare')
  const existing = el('div')
  existing.append(el('b', null, say('pack.compare.existing')), el('span', null, inspected.summary.existing || '-'))
  const incoming = el('div')
  incoming.append(el('b', null, say('pack.compare.incoming')), el('span', null, `${inspected.summary.incoming || '-'}${inspected.source ? ` · ${inspected.source}` : ''}`))
  compare.append(existing, incoming)
  body.unshift(compare)
  body.push(el('p', 'muted', [say('pack.compare.note'), inspected.current ? say('pack.compare.noteCurrent') : ''].filter(Boolean).join(' ')))
  // reason: packId(같은 팩 — 하나만) · name(이름만 같은 다른 팩 — 둘 다 둘 수 있다 · 5.4)
  const actions = [{ label: say('pack.compare.replace'), value: 'replace', kind: 'danger' }, { label: say('pack.compare.keep'), value: 'keep' }]
  if (inspected.conflict.reason === 'name') actions.splice(1, 0, { label: say('pack.compare.both'), value: 'new' })
  actions.push({ label: say('common.cancel'), value: null })
  const sameTitle = inspected.conflict.reason === 'name' ? say('pack.compare.sameName', { name }) : say('pack.compare.same', { name })
  return packDialog({ title: sameTitle, body, actions })
}

// 내보내기 — 담을 것을 먼저 묻는다: 팩 + 내 작업 기록(백업 · 위) · 팩만(팀에 줄 것)
export async function chooseExport() {
  const options = el('div', 'pack-links')
  options.append(
    popupOption('pack-command', 'backup', 'backup', say('pack.export.withWork'), say('pack.export.withWorkNote')),
    popupOption('pack-command', 'share', 'export', say('pack.export.packOnly'), say('pack.export.packOnlyNote')),
  )
  const kind = await packDialog({ title: say('pack.export.title'), subtitle: say('pack.export.ask'), body: [options], close: true })
  if (kind) return exportPack(kind)
}

// 내 백업에 담긴 되살리기 정보 — 에이전트 대화 · 워크트리 수 · 대화를 못 담은 pane · 뺀 것(큰 파일 등)
function backupNotes(result) {
  const restore = result.restore
  if (!restore) return []
  const notes = [el('p', null, say('pack.restore.saved', { sessions: restore.sessions || 0, worktrees: restore.worktrees || 0 }))]
  if ((restore.missing || []).length) notes.push(el('p', 'muted', say('pack.restore.missing', { count: restore.missing.length })))
  for (const warning of result.warnings || []) notes.push(el('p', 'muted', warning))
  return notes
}

async function exportPack(kind) {
  const prefix = kind === 'backup' ? 'pack.backup' : 'pack.export'
  const title = say(`${prefix}.title`)
  showPackProgress(say(`${prefix}.progress`), false)
  const result = await studio.packExport(kind)
  hidePackProgress()
  if (result.canceled) return
  if (!result.ok) return packAlert(say('pack.result.failed', { title }), result.text || result.message)
  const size = result.bytes ? ` · ${Math.max(1, Math.round(result.bytes / 1024))}KB` : ''
  const reveal = await packDialog({
    title: say('pack.result.done', { title }),
    body: [`${result.file}`, `${say('pack.result.files', { count: result.files || 0 })}${size}`, ...backupNotes(result), el('p', 'muted', say(`${prefix}.note`))],
    actions: [{ label: say('pack.reveal'), value: 'reveal', kind: 'primary' }],
    close: true,
  })
  if (reveal) studio.packReveal()
}

// 이 창의 팩이 가져오기로 바뀌었다(교체) — 목록 · 일감을 새로(창의 본체 · pane 은 그대로)
function onPackChanged() {
  refreshPackList()
}

async function initPacks() {
  StudioUi.packRail.mount($('pack-rail'), packRailActions, { spaceColor, spaceInitials })
  StudioUi.packProgress.mount($('pack-progress').querySelector('.pack-box'))
  studio.onPackState((next) => {
    refreshPackRepos()
    setPacks(next)
    renderPackRail()
  })
  studio.onPackProgress(StudioUi.packProgress.step)
  studio.onPackRestored(showRestoreResult)
  studio.onPackCaughtUp((info) => showToast(say('pack.caughtUp', info), 'info'))
  studio.onPackChanged(onPackChanged)
  studio.onPackCommand((name) => state && state.valid && runPackCommand(name))
  await afterAthenaReady()
}

// 본체가 정해진 뒤 — 팩이 하나도 없으면 두 가지만 보여 준다
async function afterAthenaReady() {
  if (!state || !state.valid) return
  await refreshPackList()
  if (!packs.supported) return
  if (hasNoPacks()) openNoPacks()
}

// ── 아테나 폴더 ────────────────────────────────────────────
export function renderState() {
  document.body.dataset.platform = state.platform
  $('install-dir').textContent = state.installDir || ''
  $('browser-toggle').dataset.tip = say('browser.toggleTitle', { key: state.tabKey })
  $('board-tab').dataset.tip = say('board.openTitle')
  const ready = state.valid
  panels.setup.hidden = ready
  $('board-tab').disabled = !ready || welcomeShown() // 시작 화면(팩 고르기) 동안은 일감을 못 연다
  $('diagrams-open').disabled = !ready || welcomeShown() // 다이어그램도 팩에 들어간 뒤에만
  $('work-tab').disabled = !ready || welcomeShown()
  $('settings-tab').disabled = !ready || welcomeShown() // 설정은 팩에 들어간 뒤에만(그 팩의 pack.json)
  renderPackRail()
  if (!ready) {
    panels.work.hidden = true
  }
}

const pickAthenaDir = () => applyAthenaResult(studio.pickAthenaDir())

// 처음 화면 제목 — 사전 키를 기억해 두어 언어를 바꾸면 다시 쓴다(키가 없으면 제품 이름 그대로)
let setupTitleKey = null
function setSetupTitle(key) {
  setupTitleKey = key
  $('setup-title').textContent = key ? say(key) : 'Athena Studio'
}

// 처음 켤 때 아테나 폴더가 안 정해졌으면 묻지 않고 앱이 들고 온 코어를 풀어 쓴다(~/.athena-studio/core). 안 됐을 때만 [다시 시도] · [폴더 고르기] 를 보여 준다
async function installAthena() {
  const buttons = [$('install'), $('pick')]
  for (const button of buttons) button.hidden = true
  $('setup-error').hidden = true
  $('spinner').hidden = false
  setSetupTitle('setup.preparing')
  $('setup-note').hidden = false
  try {
    await applyAthenaResult(studio.installAthena())
  } finally {
    $('spinner').hidden = true
    if (!state.valid) {
      setSetupTitle('setup.notFound')
      $('setup-note').hidden = true
      for (const button of buttons) button.hidden = false
    }
  }
}

async function applyAthenaResult(pending) {
  const result = await pending
  const error = $('setup-error')
  if (result.canceled) return
  if (result.error) {
    if (state.valid) {
      alert(result.error)
    } else {
      error.textContent = result.error
      error.hidden = false
    }
    return
  }
  error.hidden = true
  const wasValid = state.valid
  setState(result)
  renderState()
  if (!wasValid || result.changed) {
    // 처음 정했거나 폴더가 바뀌었으면 작업 창을 연다(이미 있는 데몬 탭은 그대로 — athena 탭이 없을 때만 새로 켠다)
    switchTab('work')
    startScreen()
    afterAthenaReady()
  }
}

// 메뉴 [보기 → 언어] — 정적 문구와 지금 보이는 것만 다시 그린다(열린 대화상자는 다음에 열 때부터 · React 화면은 textsChanged 로 바로)
function applyLanguage(next) {
  setI18nState(next)
  applyStaticTexts()
  StudioUi.textsChanged()
  if (setupTitleKey) setSetupTitle(setupTitleKey)
  if (!state) return
  renderState()
  if (attached) {
    renderTabs()
    renderSides()
    StudioUi.explorer.render()
  }
  StudioUi.monitor.refresh()
}

async function init() {
  setState(await studio.athenaState())
  renderState()
  initWork()
  initTips()
  initBrowser()
  initMonitor()
  StudioUi.explorer.setup($('side-panel'), explorerActions())
  $('pick').addEventListener('click', pickAthenaDir)
  $('install').addEventListener('click', installAthena)
  studio.onTabSwitch(switchTab)
  studio.onPickRequest(pickAthenaDir)
  // 데몬 알림 — 붙는 중에 온 출력은 되살릴 화면에 이미 들어 있어 버린다
  studio.onPaneData((paneId, data) => {
    if (!attached || attaching) return
    const view = views.get(paneId)
    if (!view) return
    view.term.write(data)
    if (view.hold && !view.hold.releasing) holdOutputArrived(paneId, view)
  })
  // 데몬이 크기를 적용한 자리 — 그 앞 출력(이미 보낸 것)을 다 읽은 뒤에 바꾼다(빈 write 의 콜백 = 앞선 write 다음 차례).
  // 붙는 중이면 버린다 — 새 view 는 attach 가 준 크기(이 요청이 이미 반영된)로 만든다
  studio.onPaneResized((paneId, cols, rows) => {
    const view = views.get(paneId)
    if (!view || !attached || attaching || !(cols > 1 && rows > 1)) return
    clearTimeout(view.resizing)
    view.resizing = null
    // 받은 상태의 크기도 고쳐 둔다 — 다음 상태가 올 때까지 옛 크기로 보고 다시 요청하지 않게
    const known = screen.panes.find((pane) => pane.id === paneId)
    if (known) Object.assign(known, { cols, rows })
    const held = holdForRedraw(paneId, view)
    view.term.write('', () => views.get(paneId) === view && view.term.resize(cols, rows))
    // 기다리는 사이 크기가 또 바뀌었으면 최신 크기만 이어서 — 덮었으면 다시 그리기를 다 받은 뒤(releaseHold), 아니면 다음 프레임에
    if (!held && view.want && (view.want.cols !== cols || view.want.rows !== rows)) {
      requestAnimationFrame(() => views.get(paneId) === view && sendPaneSize(paneId, view, known))
    }
  })
  studio.onScreenState((next) => attached && !attaching && applyState(next))
  studio.onScreenBranches((next) => {
    if (JSON.stringify(next) === JSON.stringify(branches)) return
    branches = next
    if (attached) renderSides()
  })
  studio.onScreenPaneStatus((next) => {
    if (JSON.stringify(next) === JSON.stringify(paneStatus)) return
    paneStatus = next
    if (attached) renderSides()
  })
  StudioUi.spaces.setup($('spaces'), spacesActions())
  applySideFolds()
  $('side-open').addEventListener('click', () => setPanelHidden(false))
  $('preview-close').addEventListener('click', closePreview)
  $('preview').addEventListener('keydown', (event) => event.key === 'Escape' && closePreview())
  // git 변경 · 펼친 폴더는 Explorer 가 보일 때만 3초마다
  setInterval(() => {
    if (currentTab === 'work' && !$('side-panel').hidden && attached) StudioUi.explorer.refresh()
    // 팩 레포 목록 — /setup 이 레포를 더하거나 연결이 바뀌면 spaces 의 흐린 레포 줄도 따라간다(작은 파일 하나 읽기)
    if (attached) refreshPackRepos()
  }, 3000)
  studio.onScreenResync(() => state.valid && attach())
  studio.onScreenDisconnected(() => {
    setAttached(false)
    setReattachOnKey(true)
    StudioUi.notices.showScreenStatus(say('screen.disconnected'))
  })
  studio.onScreenCommand(runCommand)
  studio.onLanguage(applyLanguage)
  const packsReady = initPacks()
  new ResizeObserver(() => layoutPanes()).observe($('panes'))
  new ResizeObserver(() => layoutPanes()).observe($('dock'))
  if (state.valid) {
    switchTab('work')
    // 팩 목록(켤 때 시작 화면인지)을 먼저 — 시작 화면이면 고를 때까지 아테나 에이전트를 켜지 않는다(startScreen)
    packsReady.finally(startScreen)
  } else {
    installAthena()
  }
}

init()
