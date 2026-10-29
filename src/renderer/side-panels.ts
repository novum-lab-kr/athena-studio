// 양옆 칸 껍데기 — 접기 · 펴기 아이콘 · 오른쪽 Explorer 에 넘기는 도우미 · 미리보기(뷰어) · 오른쪽 접기(⌘⌥B) · 왼쪽 접기(⌘B) · 저장된 접기 맞추기
// renderer.js 에서 옮김(R3c · 계획서 "R3 나누기") — 이름 · 동작 그대로, 타입만. 왼쪽 작업 공간 목록 데이터 · 누른 뒤의 일은 space-actions.ts
import { $, say, state } from './core.ts'
import { views } from './terminal.ts'
import { attached, screen } from './screen.ts'
import { layoutPanes } from './pane-layout.ts'
import { renderSides } from './space-actions.ts'
import { StudioUi } from './ui/index.ts'
import type { ExplorerActions } from './ui/explorer.tsx'
import { welcomeShown } from './pack-switch.ts'
import { workspaceName } from './tabs.ts'
import { fitEdgeSizes } from './edge-resize.ts'

// ── 왼쪽 spaces · 오른쪽 패널 ──
// 접기·펴기 버튼 아이콘 — 칸 머리에 붙는다(그리기는 React — 왼쪽 ui/spaces.tsx · 오른쪽 ui/explorer.tsx). 패널 아이콘(네모 + 세로선 · 사용자가 시안 5 를 고름) · 접힌 칸은 그쪽을 칠한다
export const PANEL_ICONS = {
  left: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18'],
  right: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M15 3v18'],
}

export const PANEL_FILLS = {
  left: 'M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  right: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z',
}

// ── 오른쪽 Explorer (파일 · 변경) ──
// 칸 몸통(머리줄 · 폴더 트리 · 변경 목록)과 그 상태 · 읽기는 React(ui/explorer.tsx · PR-R9). 여기는 껍데기 — 접기 · 펴기 · 3초 타이머 · 미리보기(뷰어)
export function explorerActions(): ExplorerActions {
  return {
    workspaceOf: (id) => {
      const found = screen.workspaces.find((entry) => entry.id === id)
      return found && { label: workspaceName(found), cwd: found.cwd }
    },
    tabKey: () => state!.tabKey,
    foldIcon: PANEL_ICONS.right,
    openPreview,
    collapse: () => setPanelHidden(true),
  }
}

// 선 아이콘(24 격자 · 글자색을 따름)
export function lineIcon(paths: string[]): SVGSVGElement {
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

function viewerLine(row: ViewerRow, diff: boolean): HTMLDivElement {
  const line = document.createElement('div')
  line.className = `vl ${row.kind}`
  const number = (value: number | undefined) => {
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
  sign.textContent = ({ add: '+', del: '-' } as Record<string, string>)[row.kind] || ''
  line.append(...(diff ? [number(row.oldNo), number(row.newNo), sign] : [number(row.newNo)]), code)
  return line
}

async function openPreview(relative: string): Promise<void> {
  const result = await studio.explorerOpen(StudioUi.explorer.workspace(), relative)
  const body = $('preview-body')
  const preview = $('preview')
  $('preview-title').textContent = result.path || relative
  const note = (text: string) => {
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
    image.alt = result.path as string
    image.src = result.src as string
    body.className = 'preview-body image'
    body.replaceChildren(image)
  } else {
    const diff = result.kind === 'diff'
    // 바탕은 터미널과 같게(CSS --bg) — 글자색만 테마(Shiki)를 따른다
    if (result.fg) body.style.color = result.fg
    body.replaceChildren(...result.rows!.map((row) => viewerLine(row, diff)))
    if (result.untracked) body.prepend(note(say('preview.untracked')))
    if (result.truncated) body.append(note(say('preview.truncated')))
  }
  preview.hidden = false
  body.scrollTop = 0
  preview.focus()
}

export function closePreview(): void {
  $('preview').hidden = true
  const focused = views.get(screen.focused as string)
  if (focused) focused.term.focus()
}

// 오른쪽 Explorer 접기·펴기(⌘⌥B) — 접으면 좁은 줄만 남는다. 앱을 다시 켜도 기억한다
export function setPanelHidden(hidden: boolean): void {
  $('side-panel').hidden = hidden
  $('side-rail').hidden = !hidden
  localStorage.setItem('studio.panelHidden', hidden ? '1' : '0')
  if (!hidden) StudioUi.explorer.render()
  fitEdgeSizes() // 한쪽을 펴거나 접으면 다른 쪽이 쓸 수 있는 폭이 바뀐다
  requestAnimationFrame(layoutPanes)
}

// 저장된 접기 설정대로 양쪽을 맞춘다 — 시작 화면(팩 고르기) 동안은 저장값과 상관없이 양쪽을 접는다(저장은 안 바꾼다 · 들어가면 원래대로)
export function applySideFolds(): void {
  const welcome = welcomeShown()
  const panelHidden = welcome || localStorage.getItem('studio.panelHidden') === '1'
  $('spaces').classList.toggle('collapsed', welcome || localStorage.getItem('studio.spacesCollapsed') === '1')
  $('side-panel').hidden = panelHidden
  $('side-rail').hidden = !panelHidden
  fitEdgeSizes() // 한쪽을 펴거나 접으면 다른 쪽이 쓸 수 있는 폭이 바뀐다
  if (!attached) return
  renderSides()
  if (!panelHidden) StudioUi.explorer.render()
  requestAnimationFrame(layoutPanes)
}

// 왼쪽 작업 공간 접기·펴기(⌘B) — 접으면 아이콘 줄
export function setSpacesCollapsed(collapsed: boolean): void {
  $('spaces').classList.toggle('collapsed', collapsed)
  localStorage.setItem('studio.spacesCollapsed', collapsed ? '1' : '0')
  renderSides()
  fitEdgeSizes() // 한쪽을 펴거나 접으면 다른 쪽이 쓸 수 있는 폭이 바뀐다
  requestAnimationFrame(layoutPanes)
}
