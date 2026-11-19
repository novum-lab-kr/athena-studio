// pane 터미널 찾기 — ⌘F 로 pane 오른쪽 위에 찾기 막대(글자 칸 · 몇 번째/모두 · 이전 · 다음 · 닫기)를 띄운다.
// 찾기는 xterm search 애드온(스크롤백까지) · Enter 다음 · ⇧Enter 이전 · Esc 닫고 터미널로 돌아간다
import { SearchAddon } from '@xterm/addon-search'
import type { ISearchOptions } from '@xterm/addon-search'
import { say } from './core.ts'
import { isFindKey, views } from './terminal.ts'
import type { PaneView } from './terminal.ts'

export type PaneFind = { addon: SearchAddon; bar: HTMLDivElement | null; input: HTMLInputElement | null; count: HTMLSpanElement | null }

// 맞은 곳 칠하기 — xterm 은 #RRGGBB 만 받는다(모든 칸 · 지금 칸). 지금 칸은 강조색(style.css --accent)
const SEARCH_OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: '#4a4130',
    matchOverviewRuler: '#8c7a58',
    activeMatchBackground: '#8c7a58',
    activeMatchBorder: '#c9ad78',
    activeMatchColorOverviewRuler: '#c9ad78',
  },
}

const ICONS = {
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
}

// 터미널을 만들 때 애드온만 싣는다 — 막대는 처음 ⌘F 때 만든다
export function loadFind(view: Pick<PaneView, 'term'>): PaneFind {
  const addon = new SearchAddon()
  view.term.loadAddon(addon)
  const find: PaneFind = { addon, bar: null, input: null, count: null }
  addon.onDidChangeResults(({ resultIndex, resultCount }) => showCount(find, resultIndex, resultCount))
  return find
}

// ⌘F — 막대를 열고(이미 열려 있으면 글자를 다 고른 채) 글자 칸으로
export function openFind(paneId: string): void {
  const view = views.get(paneId)
  if (!view) return
  const { find } = view
  if (!find.bar) buildBar(paneId, view)
  find.bar!.hidden = false
  // 터미널에서 고른 글이 한 줄이면 그 글로 찾는다(맥 찾기와 같게)
  const selected = view.term.getSelection()
  if (selected && !selected.includes('\n')) find.input!.value = selected
  find.input!.focus()
  find.input!.select()
  if (find.input!.value) search(find, 'next', true)
}

export function closeFind(paneId: string): void {
  const view = views.get(paneId)
  if (!view?.find.bar || view.find.bar.hidden) return
  view.find.bar.hidden = true
  view.find.addon.clearDecorations()
  view.term.clearSelection()
  view.term.focus()
}

function buildBar(paneId: string, view: PaneView): void {
  const { find } = view
  const bar = document.createElement('div')
  bar.className = 'pane-find'
  bar.setAttribute('role', 'search')
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'pane-find-input'
  input.spellcheck = false
  input.placeholder = say('pane.find.placeholder')
  input.setAttribute('aria-label', say('pane.find.placeholder'))
  const count = document.createElement('span')
  count.className = 'pane-find-count'
  count.setAttribute('aria-live', 'polite')
  const prev = iconButton(ICONS.prev, say('pane.find.prev'), () => search(find, 'prev'))
  const next = iconButton(ICONS.next, say('pane.find.next'), () => search(find, 'next'))
  const close = iconButton(ICONS.close, say('pane.find.close'), () => closeFind(paneId))
  bar.append(input, count, prev, next, close)
  // 막대를 눌러도 pane 의 mousedown(터미널로 포커스)이 글자 칸을 뺏지 않게
  bar.addEventListener('mousedown', (event) => event.stopPropagation())
  bar.addEventListener('contextmenu', (event) => event.stopPropagation())
  input.addEventListener('input', () => {
    if (input.value) return search(find, 'next', true)
    find.addon.clearDecorations()
    view.term.clearSelection()
    return showCount(find, -1, 0)
  })
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      search(find, event.shiftKey ? 'prev' : 'next')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeFind(paneId)
    } else if (isFindKey(event)) {
      event.preventDefault()
      input.select()
    }
  })
  view.el.append(bar)
  find.bar = bar
  find.input = input
  find.count = count
  showCount(find, -1, 0)
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'pane-find-btn'
  button.innerHTML = icon
  button.title = label
  button.setAttribute('aria-label', label)
  button.addEventListener('click', onClick)
  return button
}

// incremental — 글자를 칠 때는 지금 자리에서 다시 맞춰 보고(다음으로 넘어가지 않는다)
function search(find: PaneFind, direction: 'next' | 'prev', incremental = false): void {
  const text = find.input?.value
  if (!text) return
  const options = { ...SEARCH_OPTIONS, incremental }
  if (direction === 'prev') find.addon.findPrevious(text, options)
  else find.addon.findNext(text, options)
}

// 몇 번째/모두 — 맞은 곳이 없으면 "없음", 칠하기 한도(1000)를 넘으면 지금 자리를 모른다(resultIndex -1)
function showCount(find: PaneFind, resultIndex: number, resultCount: number): void {
  if (!find.count) return
  const empty = !find.input?.value
  find.count.textContent = empty ? '' : countText(resultIndex, resultCount)
  find.count.classList.toggle('none', !empty && resultCount === 0)
}

function countText(resultIndex: number, resultCount: number): string {
  if (resultCount === 0) return say('pane.find.none')
  if (resultIndex < 0) return `${resultCount}+`
  return `${resultIndex + 1}/${resultCount}`
}
