// 작업 창의 pane 하나 = xterm 터미널 하나(view) — 만들기 · 키 · 화면 아래 붙이기 · 숨었다 보일 때 다시 그리기 · 치우기
// renderer.js 에서 옮김(R3a · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 데몬 연결 상태 · 명령은 screen.ts
import { Terminal } from '@xterm/xterm'
import * as FitAddon from '@xterm/addon-fit'
import * as WebLinksAddon from '@xterm/addon-web-links'
import * as Unicode11Addon from '@xterm/addon-unicode11'
import * as StudioPaneKeys from '../lib/pane-keys.mts'
import { $ } from './core.ts'
import { focusPane, paneMenu, reattach, reattachOnKey } from './screen.ts'
import { paneDetailButton } from './renderer.js'

// 크기를 바꾸는 동안 옛 화면을 덮어 두는 틀(pane-layout.ts holdForRedraw)
export type PaneHold = { still: HTMLElement; releasing?: boolean; start?: number; timer?: number }
export type PaneView = {
  term: Terminal
  fit: FitAddon.FitAddon
  el: HTMLDivElement
  head: HTMLDivElement
  headLabel: HTMLSpanElement
  detailButton: HTMLElement
  body: HTMLDivElement
  shown: boolean
  sent: CellSize | null
  want?: CellSize
  resizing?: number | null
  anchorTimer?: number
  hold?: PaneHold | null
}

// ── 작업 창 (데몬의 탭 · pane) ───────────────────────────────
// pane 은 데몬이 갖는다 — 앱을 닫았다 켜도 같은 배치·화면으로 다시 붙는다. 분할 트리는 StudioLayout(src/lib/layout.mts)
export const PANE_GAP = 2
export const HEAD_HEIGHT = 22 // pane 머리줄 높이(style.css .pane-head 와 같은 값)
export const views = new Map<string, PaneView>() // paneId → { term, fit, el, head, shown, sent: {cols, rows} }

function makeTerminal(): { term: Terminal; fit: FitAddon.FitAddon } {
  const term = new Terminal({
    allowProposedApi: true, // unicode11 에 필요
    // Nerd Font 는 아이콘(사이드바 Explorer 등)용 — 기본 글꼴에 없는 글자만 그 글꼴로 그린다
    fontFamily: '"D2Coding", "SF Mono", Menlo, "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true, // 안의 프로그램이 마우스를 잡아도 Option+드래그로 고를 수 있게
    theme: { background: '#16171a', foreground: '#e8e6e1' },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_event: MouseEvent, uri: string) => studio.openUrl(uri)))
  // 이모지(🤖 🧭)를 두 칸으로 — 데몬의 화면 버퍼와 같은 규칙
  term.loadAddon(new Unicode11Addon.Unicode11Addon())
  term.unicode.activeVersion = '11'
  return { term, fit }
}

// 탭 밖 고정 칸(dock — 예전 터미널 모니터)은 그리지 않는다. 모니터는 이제 앱 화면(#dock)이다
export const isTabPane = (pane: ScreenPane): boolean => Boolean(pane.tab)

export function ensureView(paneId: string): PaneView {
  if (views.has(paneId)) return views.get(paneId) as PaneView
  const el = document.createElement('div')
  el.className = 'pane'
  const head = document.createElement('div')
  head.className = 'pane-head'
  const headLabel = document.createElement('span')
  headLabel.className = 'pane-head-label'
  const detailButton = paneDetailButton(paneId)
  head.append(headLabel, detailButton)
  const body = document.createElement('div')
  body.className = 'pane-body'
  el.append(head, body)
  $('panes').append(el)
  const { term, fit } = makeTerminal()
  term.open(body)
  const sendInput = (data: string) => {
    if (reattachOnKey) return reattach()
    return studio.paneInput(paneId, data)
  }
  term.onData(sendInput)
  // 조합 중 누른 ⌘← · ⌘→ 는 조합이 확정된 뒤 보낸다(StudioPaneKeys.createComposingKeys). 확정 소식은 xterm 보다 늦게 건 이 처리로
  const composingKeys = StudioPaneKeys.createComposingKeys({ send: sendInput })
  term.textarea!.addEventListener('compositionend', () => composingKeys.compositionEnd())
  // xterm 기본과 다르게 보내는 키. 한글 조합 중(isComposing)이면 xterm 에 맡긴다 — 둘만 빼고:
  //   ⌘ 키 자체 — xterm 6.0.0 은 조합 중 Shift · Ctrl · Alt 만 수정키로 보고 ⌘ 는 조합을 바로 끝내 글자를 보낸 뒤, 진짜 조합 끝에 한 번 더 보낸다(글자 반복)
  //   줄 처음 · 끝(⌘← · ⌘→) — 기본 커서 이동을 막고 신호를 조합 확정 뒤로 미룬다. 조합 마무리는 compositionend 로 xterm 이 한다
  // keydown 에서만 보내고 keypress · keyup 의 같은 키도 막아 기본 신호가 새지 않게 한다
  term.attachCustomKeyEventHandler((event) => {
    if (event.isComposing && event.key === 'Meta') return false
    const data = StudioPaneKeys.paneKeyOverride(event)
    if (data === null) return true
    if (event.isComposing) {
      if (!StudioPaneKeys.holdWhileComposing(data)) return true
      if (event.type === 'keydown') {
        event.preventDefault()
        composingKeys.hold(data)
      }
      return false
    }
    if (event.type === 'keydown') {
      event.preventDefault()
      sendInput(data)
    }
    return false
  })
  // 누른 pane 으로 포커스(데몬에도 알려 pane current · split --target focused 가 맞게)
  el.addEventListener('mousedown', () => focusPane(paneId))
  // 우클릭 메뉴 — 나누기 · 닫기. xterm 의 우클릭 단어 선택(맥 기본)은 그대로 두고 메뉴만 덧띄운다
  el.addEventListener('contextmenu', (event) => paneMenu(paneId, event))
  const view: PaneView = { term, fit, el, head, headLabel, detailButton, body, shown: false, sent: null }
  term.onWriteParsed(() => scheduleScreenAnchor(paneId, view))
  views.set(paneId, view)
  return view
}

// 칸 높이로 나누고 남는 몇 px 를 어디에 두나 — 화면이 차 있으면 위에 두고 글을 pane 아래에 붙인다(.pane-body.screen-bottom).
// 셸 · Claude Code 처럼 마지막 줄(프롬프트 · 입력창)이 맨 아래에 있는 화면을 위에 붙여 두면, 위아래로 크기를 바꿀 때
// 상자는 px 단위로 움직이는데 줄 수는 한 줄(약 14px)씩만 바뀌어 아래쪽 글이 밀렸다 한 줄씩 되튄다(톱니). 아래에 붙이면 아래쪽 글이 제자리에 있다.
// 아직 덜 찬 화면(새 셸 · 막 켠 Claude Code)은 지금처럼 위에 붙인다.
// 출력 중간(다시 그리기 조각 사이)에 바꾸면 남는 px 만큼 흔들리니 출력이 이만큼 조용할 때 · 덮어 두지 않을 때만 바꾼다
const SCREEN_ANCHOR_SETTLE_MS = 150

function scheduleScreenAnchor(paneId: string, view: PaneView): void {
  clearTimeout(view.anchorTimer)
  view.anchorTimer = setTimeout(() => {
    if (views.get(paneId) !== view) return
    if (view.hold) return scheduleScreenAnchor(paneId, view)
    return view.body.classList.toggle('screen-bottom', screenIsFull(view.term))
  }, SCREEN_ANCHOR_SETTLE_MS)
}

// 전체 화면 프로그램 · 스크롤백이 있는 화면 · 맨 아래 줄까지 글이 있는 화면
function screenIsFull(term: Terminal): boolean {
  const buffer = term.buffer.active
  if (buffer.type === 'alternate' || buffer.baseY > 0) return true
  const lastRow = buffer.getLine(buffer.baseY + term.rows - 1)
  return Boolean(lastRow && lastRow.translateToString(true))
}

// 숨었던 칸이 다시 보일 때 — xterm DOM 렌더러는 글자 폭을 DOM 으로 재서 글자 간격(셀 폭 − 글자 폭)을 정하는데,
// 숨은 칸(display:none — 다른 작업 공간의 하단 칸 · 일감 탭)에서는 0 으로 재져 간격이 셀 폭만큼 벌어진다.
// (A) 숨은 채 열면 기본 간격이 그렇게 굳고 (B) 숨는 순간의 한 프레임에 그려진 줄도 그대로 남는다.
// 옵션이 바뀌면 렌더러가 기본 간격을 다시 정하고(같은 값은 무시돼서 바꿨다 되돌린다) 0 으로 잰 글자 폭은 캐시에 남지 않으니, 보일 때 다시 재고 전부 다시 그린다.
// open 을 미루면 그 전에 온 OSC 색 설정이 버려져서(테마 서비스가 open 때 생긴다) 열기는 그대로 둔다
export function redrawAfterHidden(view: PaneView): void {
  const { term } = view
  const sensitivity = term.options.scrollSensitivity as number
  term.options.scrollSensitivity = sensitivity + 1
  term.options.scrollSensitivity = sensitivity
  term.refresh(0, term.rows - 1)
}

export function disposeView(paneId: string): void {
  const view = views.get(paneId)
  if (!view) return
  clearTimeout(view.resizing as number | undefined)
  clearTimeout(view.anchorTimer)
  if (view.hold) clearTimeout(view.hold.timer)
  view.term.dispose()
  view.el.remove()
  views.delete(paneId)
}

