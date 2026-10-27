// 앱 화면 중 아직 .ts 로 안 옮긴 묶음 — 옆 브라우저 · [작업] 팝업 · 일감 메뉴 · pane [상세] · ⚙ 설정(R3d 가 browser.ts · work.ts · detail.ts 로 옮긴다)
// studio 는 preload 의 contextBridge 가 만든 전역이다 — 같은 이름으로 다시 선언하면 이 파일 전체가 SyntaxError 로 죽는다
/* global studio, StudioUi */
// 기능별로 .ts 로 나누는 중(R3 — 계획서 "R3 나누기"). 옮긴 묶음은 import 로 부르고, 옮긴 묶음이 부르는 아직 안 옮긴 함수는 여기서 export 한다(순환 import — 묶음 사이 사용은 모두 함수 안이라 읽는 순서와 상관없다)
// 옮긴 묶음의 변수는 그쪽이 가진다 — 여기서는 이름 그대로 읽고, 바꿀 때만 setX. 시작(init)은 main.ts(R3f) — 이 파일은 정의만 하고 아무것도 실행하지 않는다
import { $, currentTab, el, say, showToast, state } from './core.ts'
import { views } from './terminal.ts'
import { focusPane, screen } from './screen.ts'
import { focusCurrentTerminal } from './pane-layout.ts'
import { modalOpen, packDialog, packLabel, packs } from './pack-dialogs.ts'
import { welcomeShown } from './pack-switch.ts'

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

export function initBrowser() {
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

export function initWork() {
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
