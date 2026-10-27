// 회사 팩 바꾸기 — 팩 줄(보이기 · 누른 뒤) · 팩 목록 읽기 · 팩 메뉴 · 팩 흐름 잠금(runPackFlow) · 시작 화면 · 팩 열기 · 바꾸기 · 바꾼 뒤 다시 붙기
// renderer.js 에서 옮김(R3e · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만
import { $, currentTab, el, say, setState, showToast, state } from './core.ts'
import { deletePack, editPackLook, editPackLookDialog, hidePackProgress, packAlert, packDialog, packLabel, packs, setPacks, showPackProgress } from './pack-dialogs.ts'
import { attach, openAgent, setStarting } from './screen.ts'
import { browserOpen, closeBrowserPanel } from './browser.ts'
import { applySideFolds, chooseExport, importPack, lineIcon, newPack, renderState } from './renderer.js'
import { ensureSomeTab, switchTab } from './tabs.ts'
import { StudioUi } from './ui/index.ts'
import type { PackItem, PackRailActions } from './ui/pack-rail.tsx'
import type { WelcomeActions, WelcomePack } from './ui/pack-welcome.tsx'

// 팩 줄 · 팩 메뉴의 줄 — 목록에 지금 팩이 없으면(옛 구조 본체는 목록이 빈다) 지금 팩을 앞에 더한다
function packRows(): PackItem[] {
  const current = packs.current && !packs.packs!.some((item) => item.id === packs.current!.id) ? [packs.current] : []
  return [...current, ...packs.packs!]
}

// 팩 세로 줄 — 팩마다 이름 두 글자 + 이름 색(접힌 spaces 아이콘과 같은 모양) · 지금 팩 강조 · 누르면 갈아 끼우기.
// 줄(아이콘 · 이미지 · ＋)은 React(ui/pack-rail.tsx) — 여기는 보이기 · 숨기기와 누른 뒤의 팩 흐름
export function renderPackRail(): void {
  renderPackWelcome()
  const rail = $('pack-rail')
  rail.hidden = !packs.supported || !state || !state.valid || hasNoPacks()
  if (rail.hidden) return
  StudioUi.packRail.render({ rows: packRows(), current: packs.current || null, openIds: Array.isArray(packs.openIds) ? packs.openIds : [], selectedId: selectedPackId() })
}

// 팩 줄 누르기 — 한 번(조금 기다렸다 · 지금 팩은 빼고) 이 창에서 그 팩으로 · 더블클릭 이름 · 이미지 바꾸기 · ＋ 만들기 · 가져오기 · 내보내기
export const packRailActions: PackRailActions = {
  open: (id) => runPackFlow(() => switchPack(id)),
  edit: (id) => runPackFlow(() => editPackLookDialog(id)),
  menu: packRailMenu,
  add: () => runPackFlow(openPackActions),
}

// 팩 아이콘 우클릭 — main 메뉴에서 고른 것을 한다
async function packRailMenu(id: string, x: number, y: number): Promise<void> {
  // 메뉴는 팩 흐름 잠금 밖에서 — 메뉴가 끝내 닫힘 알림을 안 주면(창이 뒤에 있을 때 등) 잠금이 풀리지 않아 팩 일을 다 막는다
  const action = await studio.packContextMenu(id, { x, y })
  if (action === 'new-window') runPackFlow(() => switchPack(id, { newWindow: true }))
  else if (action === 'export') runPackFlow(chooseExport)
  else if (action === 'delete') runPackFlow(() => deletePack(id))
  else if (action) runPackFlow(() => editPackLook(id, action as string))
}

// 팩 줄 선택 표시 — 바꾸는 중인 팩이 있으면 그 팩(진행 팝업이 닫히면), 없으면 지금 팩
let packPendingId: string | null = null
const selectedPackId = (): string | null => packPendingId || (packs.current && packs.current.id) || null
// 버튼을 다시 그리지 않고 표시만 바꾼다(다시 그리면 두 번째 클릭이 다른 버튼에 떨어져 더블클릭이 안 된다)
const markPackSelection = (): void => StudioUi.packRail.select(selectedPackId())

export async function refreshPackList(): Promise<PackState> {
  if (!state || !state.valid) return packs
  setPacks(await studio.packList())
  renderPackRail()
  return packs
}

// 대화상자 안 아이콘 줄(24 격자 선 아이콘)
export const POPUP_ICONS: Record<string, string[]> = {
  new: ['M12 5v14', 'M5 12h14'],
  import: ['M12 3v10', 'M8 9.5l4 4l4-4', 'M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14'],
  export: ['M12 14V4', 'M8 7.5l4-4l4 4', 'M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14'],
  backup: ['M3 5h18v4H3z', 'M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9', 'M10 13h4'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M10 12h1M10 15h1M10 18h1'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  git: ['M6 3v12', 'M18 9a9 9 0 0 1-9 9', 'M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0', 'M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0'],
  athena: ['M12 8v4l3 2', 'M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  camera: ['M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M15.5 13a3.5 3.5 0 1 1-7 0a3.5 3.5 0 0 1 7 0'],
  trash: ['M4 7h16', 'M9 7V4.5h6V7', 'M6.5 7l1 13h9l1-13'],
}

// 아이콘 · 이름 · 한 줄 설명 버튼(고르면 data-value 로 대화상자를 끝낸다) — 팩 명령 줄 · 가져오기 종류
export function popupOption(className: string, value: string, icon: string, title: string, note: string): HTMLButtonElement {
  const button = el('button', className)
  button.type = 'button'
  button.dataset.value = value
  const mark = el('span', 'popup-icon')
  mark.append(lineIcon(POPUP_ICONS[icon]!))
  const copy = el('span', 'popup-option-copy')
  copy.append(el('b', null, title), el('small', null, note))
  button.append(mark, copy)
  return button
}

// 팩 대화상자 아래 줄 — 새로 만들기 · 가져오기 · 내보내기 · 내 백업
function packLinks(): HTMLDivElement {
  const links = el('div', 'pack-links')
  for (const value of ['new', 'import', 'export']) links.append(popupOption('pack-command', value, value, say(`pack.link.${value}`), say(`pack.link.${value}Note`)))
  return links
}

// 팩 세로 줄의 + — 목록 없이 만들기 · 가져오기 · 내보내기 · 내 백업만
async function openPackActions(): Promise<unknown> {
  const choice = (await packDialog({ title: say('pack.title'), body: [packLinks()], close: true })) as string | null
  if (choice) return packCommand(choice)
}

// 회사 팩 고르기 — 목록 + 새로 만들기 · 가져오기 · 내보내기 · 내 백업
async function openPackPicker(): Promise<unknown> {
  await refreshPackList()
  if (!packs.supported) return packAlert(say('pack.title'), say('pack.unsupported'))
  if (hasNoPacks()) return openNoPacks()
  // 줄 목록은 React(ui/pack-menu.tsx) — 대화상자가 끝나면 내린다
  const list = el('div', 'pack-list')
  StudioUi.packMenu.open(list, packRows(), packs.current || null)
  const choice = (await packDialog({ title: say('pack.title'), body: [list, packLinks()], close: true })) as string | null
  StudioUi.packMenu.close()
  if (!choice) return
  if (choice.startsWith('pack:')) return switchPack(choice.slice(5))
  return packCommand(choice) // 이미 흐름 안 — runPackCommand 를 다시 부르면 자기 잠금에 막힌다
}

// 팩 흐름은 한 번에 하나 — 진행 중에 메뉴로 또 열면 알리기만
let packFlow = false
export async function runPackFlow<T>(work: () => T | Promise<T>): Promise<T | void> {
  if (packFlow) return showToast(say('pack.flowBusy'), 'info')
  packFlow = true
  try {
    return await work()
  } finally {
    packFlow = false
  }
}
export const runPackCommand = (name: string): Promise<unknown> => runPackFlow(() => packCommand(name))

function packCommand(name: string): Promise<unknown> | undefined {
  if (name === 'picker') return openPackPicker()
  if (name === 'new') return newPack()
  if (name === 'import') return importPack()
  if (name === 'export') return chooseExport()
}

// 시작 화면 — 작업 창 가운데(VS Code 처럼). 두 경우(규칙은 main 이 pack.js 로 계산해 넘긴다):
//   welcome — 팩이 하나도 없을 때(만들기 · 가져오기만) · launchWelcome — 앱을 켤 때마다(팩이 있어도 · 도는 에이전트가 없으면) + '내 팩' 목록
// 켤 때 시작 화면은 팩을 고르거나 · 만들거나 · 가져와 들어가면(welcomeEntered) 닫힌다. 떠 있는 동안 에이전트 모니터는 접어 두고, 들어가면 펼친다
export const hasNoPacks = (): boolean => packs.welcome === true
let welcomeEntered = false
export const welcomeShown = (): boolean => Boolean(state && state.valid) && (hasNoPacks() || (packs.launchWelcome === true && !welcomeEntered))
let welcomeWasOn = false
function renderPackWelcome(): void {
  const on = welcomeShown()
  $('pack-welcome').hidden = !on
  document.body.classList.toggle('pack-welcome-on', on)
  // 일감 · 브라우저 아이콘은 팩에 들어간 뒤에만 — 시작 화면이 뜨면 끄고, 열려 있었으면 닫는다
  $<HTMLButtonElement>('board-tab').disabled = !state || !state.valid || on
  $<HTMLButtonElement>('diagrams-open').disabled = !state || !state.valid || on
  $<HTMLButtonElement>('browser-toggle').disabled = on
  if (on && browserOpen) closeBrowserPanel()
  // 처음 뜰 때만 접는다(시작 화면에서 직접 펴면 그대로 · 저장된 접기 설정은 건드리지 않는다)
  if (on && !welcomeWasOn) $('dock').classList.add('collapsed')
  if (on !== welcomeWasOn) {
    welcomeWasOn = on
    applySideFolds() // 시작 화면이 뜨면 양쪽을 접고, 들어가면 저장된 대로
  }
  // 몸통(로고 · 만들기 · 가져오기 · '내 팩')은 React(ui/pack-welcome.tsx) — 떠 있는 동안 목록을 넘기고, 닫히면 내린다
  if (on) StudioUi.welcome.open($('pack-welcome').querySelector<HTMLElement>('.pack-welcome-inner')!, welcomeRecent(), welcomeActions())
  else StudioUi.welcome.close()
}

// '내 팩' — 지금 팩 맨 위 · 최근 순 · 최대 5개(main 의 packs.recent) · 팩이 없으면 비운다(만들기 · 가져오기만)
function welcomeRecent(): WelcomePack[] {
  return (!hasNoPacks() && Array.isArray(packs.recent) && packs.recent) || []
}
// 시작 화면에서 누르면 — 만들기 · 가져오기 · 모두 보기는 팩 흐름 그대로, '내 팩' 줄을 고르면 그 팩으로 들어간다
function welcomeActions(): WelcomeActions {
  return { command: (name) => runPackCommand(name), enter: (id) => runPackFlow(() => enterPack(id)) }
}

// 시작 화면에서 들어가기 — 시작 화면을 닫고 모니터를 펼친다. 시작 화면이 떠 있지 않았으면(칩으로 갈아 끼움) 모니터는 그대로
function enterWelcome(): void {
  const wasShown = welcomeShown()
  welcomeEntered = true
  if (wasShown) $('dock').classList.remove('collapsed')
  renderPackWelcome()
}

// 목록에서 고름 — 이 창의 팩이면 바로 들어가 아테나를 켜고, 다른 팩이면 이 창에서 그 팩으로 바꾼다.
// 그 팩을 다른 창이 이미 보고 있으면 그 창이 앞으로 오고 이 시작 화면 창은 접는다
async function enterPack(id: string): Promise<void> {
  if (packs.current && packs.current.id === id) {
    enterWelcome()
    await openAgent()
    return
  }
  const result = await switchPack(id)
  if (result && result.ok && result.existing && welcomeShown()) studio.closeWindow()
}
export function openNoPacks(): void {
  renderPackWelcome()
  if (currentTab !== 'work') switchTab('work')
}

// 팩 바꾸기 — 그 팩 본체를 준비하고(처음이면 본체를 만든다) 이 창을 그 팩으로 다시 붙인다(한 창에서 바꿔 보기).
// 이전 팩의 pane · 에이전트는 닫지 않는다(데몬에서 계속 돌고, 다시 누르면 보던 자리 그대로). newWindow 면 새 창으로(우클릭 [새 창으로 열기])
export async function switchPack(id: string, { newWindow = false }: { newWindow?: boolean } = {}): Promise<PackOpenReply> {
  if (packs.current && packs.current.id === id) return { ok: true, same: true }
  const target = (packs.packs || []).find((item) => item.id === id)
  const name = target ? packLabel(target) : id
  try {
    return await openOrSwitchPack(id, { newWindow, name })
  } finally {
    // 끝나면(실패 · 취소 · 다른 창으로 감 포함) 실제 지금 팩으로 맞춘다
    if (packPendingId === id) {
      packPendingId = null
      markPackSelection()
    }
  }
}

async function openOrSwitchPack(id: string, { newWindow, name }: { newWindow: boolean; name: string }): Promise<PackOpenReply> {
  showPackProgress(say(newWindow ? 'pack.open.progress' : 'pack.switch.progress', { name }), true)
  const result = await studio.packOpen(id, { newWindow })
  hidePackProgress()
  // 선택 표시는 진행 팝업이 닫힐 때 옮긴다 — 다시 붙기 · 목록 읽기가 끝날 때까지 기다리지 않게
  if (result.switched) {
    packPendingId = id
    markPackSelection()
  }
  if (result.same || result.canceled || result.error === 'canceled') return result
  if (!result.ok) {
    await packAlert(say(newWindow ? 'pack.open.failed' : 'pack.switch.failed'), result.text || result.message)
    return result
  }
  if (result.switched) await applySwitchedPack(result.state as AthenaState)
  const notes: string[] = []
  if (result.unlinkedRepos && result.unlinkedRepos.length) notes.push(say('pack.switch.unlinked', { repos: result.unlinkedRepos.join(', ') }))
  if (result.repair) notes.push(say('pack.open.repair'))
  if (notes.length) packAlert(say(result.switched ? 'pack.switch.done' : 'pack.open.done', { name }), notes.join('\n'))
  return result
}

// 이 창이 다른 본체로 다시 묶였다 — 상태 · 일감 · 옆 브라우저 · 작업 창을 그 팩 것으로. 처음 온 팩이면 아테나 에이전트를 켜고(/setup 포함),
// 다녀온 팩이면 보던 자리 그대로(keepView)
export async function applySwitchedPack(next: AthenaState): Promise<void> {
  setState(next)
  enterWelcome() // 시작 화면에서 바꿨으면 닫고 모니터를 펼친다
  if (browserOpen) closeBrowserPanel()
  renderState()
  setStarting(true)
  try {
    if (await attach()) await openAgent({ keepView: true })
  } finally {
    setStarting(false)
  }
  ensureSomeTab()
  await refreshPackList()
}
