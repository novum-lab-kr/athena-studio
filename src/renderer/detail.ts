// pane [상세] 껍데기 — 머리 줄 아이콘 · 열기 · 뒤로 · 닫기 · pane 으로 가기(goToPane) · 요청 대화상자(openRequest)
// renderer.js 에서 옮김(R3d · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 몸통은 React(ui/pane-detail.tsx). paneBound 를 바꾸는 바깥 쪽은 setPaneBound
import { $, el, say, showToast } from './core.ts'
import { views } from './terminal.ts'
import type { PaneView } from './terminal.ts'
import { focusPane, screen } from './screen.ts'
import { focusCurrentTerminal } from './pane-layout.ts'
import { packDialog } from './pack-dialogs.ts'
import type { PackDialogAction } from './pack-dialogs.ts'
import { closePops, reportDelivery, workRequests } from './work.ts'
import { StudioUi } from './ui/index.ts'
import type { PaneDetailActions, PlanRef } from './ui/pane-detail.tsx'

// ── pane [상세] ─────────────────────────────────────────────
// 계획서에 묶인 pane(그 계획서를 하는 에이전트 · 맡긴 아테나) 머리 줄 오른쪽 아이콘 → 작업 창 위에 오른쪽에서 뜨는 팝업.
// 팝업은 레이아웃에 끼지 않는다(position: fixed) — pane · spaces · Explorer · 모니터 크기와 터미널 크기는 그대로.
// 몸통은 React(ui/pane-detail.tsx — 3초마다 다시 읽기 · [더 보기] · 뒤로 간 스크롤) · 여기는 껍데기(아이콘 · 열기 · 닫기 · 머리줄 · [← 맡긴 일])
let paneBound: Record<string, 'agent' | 'lead'> = {} // pane id → 'agent' | 'lead'
export const setPaneBound = (next: Record<string, 'agent' | 'lead'>): void => {
  paneBound = next
}
export let detailPane: string | null = null
// 아테나 목록에서 들어온 상세면 돌아갈 자리 — { paneId, scroll } · 에이전트 pane 에서 바로 열면 null
let detailBack: { paneId: string; scroll: number } | null = null
// 아이콘 — 체크리스트 모양(사용자 확정 2026-10-27 · 시안 B)
const PANE_DETAIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2"/><circle cx="5" cy="18" r="1"/></svg>'

export function paneDetailButton(paneId: string): HTMLButtonElement {
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

export function syncDetailButton(paneId: string, view: PaneView): void {
  view.detailButton.hidden = !paneBound[paneId]
  view.detailButton.setAttribute('aria-expanded', String(detailPane === paneId))
  view.detailButton.classList.toggle('active', detailPane === paneId)
}
export function syncDetailButtons(): void {
  for (const [paneId, view] of views) syncDetailButton(paneId, view)
}

function togglePaneDetail(paneId: string): void {
  if (detailPane === paneId) return closePaneDetail()
  return openPaneDetail(paneId)
}

// from: 아테나 목록에서 들어올 때 돌아갈 자리 · restore: 뒤로 가기로 돌아올 때 맞출 스크롤
// plan: 담당 pane 이 없는 맡긴 일 줄의 계획서(paneId 는 그 아테나 pane)
function openPaneDetail(paneId: string, { from = null, restore = null, plan = null }: { from?: { paneId: string; scroll: number } | null; restore?: number | null; plan?: PlanRef | null } = {}): void {
  closePops()
  const pop = $('pane-detail')
  const first = detailPane === null
  detailPane = paneId
  detailBack = from
  $('pane-detail-back').hidden = !detailBack
  const bar = document.querySelector('.tabbar')
  pop.style.top = `${Math.round(bar ? bar.getBoundingClientRect().bottom : 0)}px`
  // 처음이거나 다른 pane 이면 읽는 중부터 · 같은 pane 이면 그린 것을 두고 바로 다시 읽는다
  StudioUi.paneDetail.open($('pane-detail-body'), paneId, restore, paneDetailActions, plan)
  if (first) {
    pop.hidden = false
    requestAnimationFrame(() => pop.classList.add('open'))
  }
  $('pane-detail-body').scrollTop = 0
  syncDetailButtons()
  $(detailBack ? 'pane-detail-back' : 'pane-detail-close').focus({ preventScroll: true })
}

export function backPaneDetail(): void {
  if (!detailBack) return
  const { paneId, scroll } = detailBack
  // 그사이 아테나 pane 이 닫혔으면 돌아갈 목록이 없다 — 들어갈 때(paneLive)와 같이 본다
  if (!paneLive(paneId)) return closePaneDetail()
  return openPaneDetail(paneId, { restore: scroll })
}

export function closePaneDetail(): void {
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
const paneDetailActions: PaneDetailActions = {
  openPane: (paneId, from) => openPaneDetail(paneId, { from }),
  openPlan: (plan, from) => openPaneDetail(from.paneId, { from, plan }),
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
export const paneLive = (paneId: unknown): boolean => Boolean(paneId) && screen.panes.some((pane) => pane.id === paneId)
export async function goToPane(paneId: unknown): Promise<void> {
  const pane = screen.panes.find((entry) => entry.id === paneId)
  if (!pane) return
  await studio.tabSelect(pane.tab as string)
  focusPane(pane.id)
}

// 질문 · 결정 — 질문은 앱 안에서 바로 답하고, 결정(정식 계획서)은 결정 콘솔로
export async function openRequest(request: WorkRequestView): Promise<void> {
  closePops()
  // 열 결정 콘솔(html)이 없고 선택지가 있는 decision 은 question 과 같은 화면으로 답한다
  const answerInApp = request.kind === 'decision' && !request.html && request.options.length > 0
  if (request.kind === 'decision' && !answerInApp) {
    const choice = await packDialog({
      title: request.title,
      subtitle: say('work.kind.decision'),
      body: [el('p', 'work-request-body', request.body), el('p', 'muted', say('work.decisionNote'))],
      actions: [{ label: say('work.detail.console'), value: 'console', kind: 'primary' }],
      close: true,
    })
    if (choice === 'console') studio.workOpenPlan((request.plan || '') as string, request.html as string | null)
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
  let picked = (request.options.find((option) => option.recommended) || request.options[0] || ({} as { label?: string })).label || ''
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
  const actions: PackDialogAction[] = [{ label: say('work.send'), value: 'send', kind: 'primary' }]
  if (paneLive(request.pane)) actions.unshift({ label: say('work.detail.goPane'), value: 'pane' })
  const choice = await packDialog({ title: request.title, subtitle: [say(request.kind === 'decision' ? 'work.kind.decision' : 'work.kind.question'), meta].filter(Boolean).join(' · '), body, actions, close: true })
  if (choice === 'pane') return goToPane(request.pane)
  if (choice !== 'send') return
  if (!picked && !note.value.trim()) return showToast(say('work.needAnswer'), 'info')
  const result = await studio.workAnswer(request.id, { choice: picked, text: note.value, rev: request.rev })
  if (!result || !result.ok) return showToast(say(result && result.error === 'conflict' ? 'work.answerConflict' : 'work.answerFailed', { message: (result && result.message) || '' }))
  reportDelivery(result)
}
