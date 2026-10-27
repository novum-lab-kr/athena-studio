// 탭 줄 팝업 껍데기 — [작업](요청 수 점 · 열기 · 닫기 · 작업 상세) · 일감 페이지 메뉴 · ⚙ 설정 · 답 전달 알림 · 이벤트 묶기(initWork)
// renderer.js 에서 옮김(R3d · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 몸통은 React(ui/work-pop.tsx · ui/settings-pop.tsx)
import { $, el, say, showToast, state } from './core.ts'
import { packDialog, packLabel, packs } from './pack-dialogs.ts'
import type { PackDialogAction } from './pack-dialogs.ts'
import { welcomeShown } from './pack-switch.ts'
import { backPaneDetail, closePaneDetail, detailPane, goToPane, openRequest, paneLive, setPaneBound, syncDetailButtons } from './detail.ts'
import { StudioUi } from './ui/index.ts'

// ── [작업] 팝업 · 일감 페이지 메뉴 ────────────────────────────
// 칸반 대신 탭 줄 [작업] — 나를 기다리는 것(사람에게 묻는 요청) · 진행 중 · 최근 끝난 것. 작업을 누르면 상세, 질문을 누르면 앱 안에서 바로 답한다.
// 요청 수는 main 이 요청 폴더를 보다가 바뀔 때 알린다(onWorkRequests) · 목록 전체는 팝업을 열 때 읽는다(일감을 띄운다)
export let workRequests: WorkRequestsState = { supported: false, requests: [] }
let workData: WorkView | null = null // 마지막으로 읽은 목록(workGet) — 진행 중 숫자
const WORK_STATES = ['wait', 'work', 'blocked', 'idle', 'done']

function renderWorkTab(): void {
  const waiting = workRequests.requests.filter((request) => request.state === 'open').length
  // 숫자는 두지 않는다(사용자) — 있다는 것만 점으로, 수는 툴팁에
  $('work-ask').hidden = !waiting
  const doing = workData ? workData.counts.doing : 0
  $('work-tab').classList.toggle('asking', waiting > 0)
  $('work-tab').dataset.tip = say('work.tip', { doing, waiting })
}

// 탭 줄 버튼 아래에 붙인다 — 오른쪽 끝을 버튼 오른쪽에 맞춘다
function placeUnder(pop: HTMLElement, button: HTMLElement): void {
  const rect = button.getBoundingClientRect()
  pop.style.top = `${Math.round(rect.bottom + 6)}px`
  pop.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`
}

let popBefore: Element | null = null
export function closePops(): void {
  for (const [pop, button] of [['work-pop', 'work-tab'], ['board-menu', 'board-tab'], ['settings-pop', 'settings-tab']] as [string, string][]) {
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
function openPop(pop: string, button: string): void {
  closePops()
  popBefore = document.activeElement
  placeUnder($(pop), $(button))
  $(pop).hidden = false
  $(button).setAttribute('aria-expanded', 'true')
  $(button).classList.add('active')
}

// 몸통(work-pop-body)은 React(ui/work-pop.tsx) — 여기는 머리줄 팩 이름과 그릴 값 넘기기만
function renderWorkPop(): void {
  $('work-pop-title').textContent = say('work.popTitle', { pack: (packs.current && packLabel(packs.current)) || '' })
  StudioUi.work.setWork(workData, workData ? workData.requests : workRequests.requests)
}

async function toggleWorkPop(): Promise<void> {
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

function toggleBoardMenu(): void {
  if (!$('board-menu').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('board-menu', 'board-tab')
  $('board-menu').querySelector('button')!.focus({ preventScroll: true })
}

// 작업 상세 — 계획서에서 왜 · 정한 것 · 진행 · 검증 · 결과 · 다음
async function openWorkDetail(item: WorkItemView): Promise<void> {
  closePops()
  const detail = await studio.workDetail(item.id as string)
  const body = []
  if (!detail || !detail.ok) body.push(el('p', 'muted', say('work.detail.unreadable')))
  else {
    const field = (key: string, value: string | string[]) => {
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
  const actions: PackDialogAction[] = [{ label: say('work.detail.openPlan'), value: 'plan' }]
  if (item.html) actions.push({ label: say('work.detail.console'), value: 'console' })
  const pane = item.agents.find(paneLive)
  if (pane) actions.push({ label: say('work.detail.goPane'), value: 'pane', kind: 'primary' })
  const choice = await packDialog({ title: item.title, subtitle: say(`work.state.${item.state}`), body, actions, close: true })
  if (choice === 'plan') studio.workOpenPlan(item.id as string, null)
  else if (choice === 'console') studio.workOpenPlan(item.id as string, item.html)
  else if (choice === 'pane') goToPane(pane)
}

// ── ⚙ 설정 팝업 — 이 창 팩의 레포별 PR 자동 리뷰 · 머지 + 앱 업데이트 ─────────────────────
// 몸통(settings-pop-body)은 React(ui/settings-pop.tsx) — 여기는 껍데기(열기 · 닫기 · 머리줄 팩 이름)와 ⚙ 의 업데이트 점만
function applyAppUpdate(next: AppUpdateView | null): void {
  $('settings-tab').classList.toggle('has-update', Boolean(next && next.state === 'behind'))
  StudioUi.settings.setAppUpdate(next || null)
}

function toggleSettingsPop(): void {
  if (!$('settings-pop').hidden) return closePops()
  if (!state || !state.valid || welcomeShown()) return
  openPop('settings-pop', 'settings-tab')
  $('settings-pop-pack').textContent = (packs.current && packLabel(packs.current)) || ''
  StudioUi.settings.open($('settings-pop-body'))
}

export function reportDelivery(result: WorkAnswerReply | null | undefined): void {
  if (!result || !result.ok) return showToast(say('work.answerFailed', { message: (result && result.message) || '' }))
  showToast(say(result.delivered ? 'work.sent' : 'work.savedNoPane'), result.delivered ? 'success' : 'info')
}

export function initWork(): void {
  $('work-tab').addEventListener('click', toggleWorkPop)
  $('board-tab').addEventListener('click', toggleBoardMenu)
  $('settings-tab').addEventListener('click', toggleSettingsPop)
  studio.onAppUpdate(applyAppUpdate)
  studio.appUpdateStatus().then((next) => next && !next.error && applyAppUpdate(next))
  for (const item of document.querySelectorAll<HTMLElement>('#board-menu [data-section]')) {
    item.addEventListener('click', () => {
      closePops()
      studio.openBoardSection(item.dataset.section as string)
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
    if ((event.target as Element).closest('#work-pop, #board-menu, #settings-pop, #work-tab, #board-tab, #settings-tab')) return
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
    if (detailPane === null || (event.target as Element).closest('#pane-detail, .pane-detail-btn')) return
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
    setPaneBound(next && typeof next === 'object' ? next : {})
    syncDetailButtons()
  })
  studio.paneBound().then((next) => {
    setPaneBound(next && typeof next === 'object' ? next : {})
    syncDetailButtons()
  }).catch(() => {})
  studio.onWorkRequests((next) => {
    workRequests = next && Array.isArray(next.requests) ? next : { supported: false, requests: [] }
    if (workData) workData = { ...workData, requests: workRequests.requests.map((request) => ({ ...request, waited: (workData!.requests.find((known) => known.id === request.id) || {}).waited || '' })) }
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
