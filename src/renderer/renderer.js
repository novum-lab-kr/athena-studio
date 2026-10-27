// 앱 화면 — 탭 두 개(작업 창 · 일감) · 작업 창 안의 데몬 탭·pane · 처음 켤 때 아테나 받기 · 에이전트(claude · codex) 고르기
// studio 는 preload 의 contextBridge 가 만든 전역이다 — 같은 이름으로 다시 선언하면 이 파일 전체가 SyntaxError 로 죽는다
/* global studio, StudioUi */
// 기능별로 .ts 로 나누는 중(R3 — 계획서 "R3 나누기"). 옮긴 묶음은 import 로 부르고, 옮긴 묶음이 부르는 아직 안 옮긴 함수는 여기서 export 한다(순환 import — 묶음 사이 사용은 모두 함수 안이라 읽는 순서와 상관없다)
// 옮긴 묶음의 변수는 그쪽이 가진다 — 여기서는 이름 그대로 읽고, 바꿀 때만 setX
import { $, applyStaticTexts, currentTab, el, panels, say, setI18nState, setState, showToast, state } from './core.ts'
import { views } from './terminal.ts'
import { attach, attached, attaching, openAgent, runCommand, screen, setAttached, setReattachOnKey, setRestoreArmed, setStarting, showRestoreResult, startScreen } from './screen.ts'
import { applyState, ensureSomeTab, renderTabs, switchTab } from './tabs.ts'
import { holdForRedraw, holdOutputArrived, initMonitor, layoutPanes, sendPaneSize } from './pane-layout.ts'
import { hidePackProgress, packAlert, packDialog, packs, setPacks, showPackProgress } from './pack-dialogs.ts'
import { applySwitchedPack, hasNoPacks, openNoPacks, packRailActions, popupOption, refreshPackList, renderPackRail, runPackCommand, switchPack, welcomeShown } from './pack-switch.ts'
import { initBrowser } from './browser.ts'
import { initWork } from './work.ts'
import { initTips } from './tips.ts'
import { refreshPackRepos, renderSides, spaceColor, spaceInitials, spacesActions } from './space-actions.ts'
import { applySideFolds, closePreview, explorerActions, setPanelHidden } from './side-panels.ts'

/** @type {Record<string, string | null>} */
export let branches = {} // 작업 공간 id → git 브랜치(없으면 null) — main 이 5초마다
/** @type {Record<string, string | null>} */
export let paneStatus = {} // pane id → 에이전트 상태(working · idle · …, 에이전트 없으면 null) — main 이 2초마다

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
