// 작업 창 화면(index.html)의 공용 — 요소 찾기 · 만들기 · 문구(say) · 알림 · 처음 화면 칸 · 아테나 폴더 상태 · 지금 탭
// renderer.js 를 기능별로 나누는 중(R3 — 계획서 "R3 나누기"). 이 파일은 다른 묶음을 import 하지 않는다 — 묶음끼리 서로 부르는 순환 import 에서 맨 먼저 다 읽혀야 한다
// 다른 묶음이 값을 바꾸는 변수는 여기서 export let + setX — 읽는 쪽은 이름 그대로(ES 모듈 바인딩), 바꾸는 쪽만 setX
import * as StudioI18n from '../lib/i18n.mts'
import { StudioUi } from './ui/index.ts'

// 없는 id 면 지금처럼 그 자리에서 TypeError(캐스트만 — 동작 그대로)
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ── 언어 ──────────────────────────────────────────────────
// 문구는 사전(src/i18n) — main 이 preload 로 넘긴다(StudioI18n 은 src/lib/i18n.mts). 정적 문구는 index.html 의 data-i18n* 속성
export let i18nState: I18nPayload = studio.i18n()
export const setI18nState = (next: I18nPayload): void => {
  i18nState = next
}
export const say = (key: string, values?: Record<string, unknown>): string => StudioI18n.t(i18nState.dictionary, key, values, i18nState.fallback)
// 알림 · 상태 줄은 React(ui/notices.tsx) — 켤 때 한 번 띄워 둔다. React 화면(ui/)도 같은 say · 토스트를 쓴다(ui/bridge.ts)
export const { showToast } = StudioUi.notices
StudioUi.notices.mount($('toast'), $('screen-status'))
StudioUi.connect({ say, showToast })

export function applyStaticTexts(): void {
  document.documentElement.lang = i18nState.language
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = say(node.dataset.i18n as string)
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) node.title = say(node.dataset.i18nTitle as string)
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) node.setAttribute('aria-label', say(node.dataset.i18nAriaLabel as string))
  for (const node of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) node.placeholder = say(node.dataset.i18nPlaceholder as string)
}
applyStaticTexts()

export const panels = { setup: $('setup'), work: $('work') }

export let state: AthenaState | null = null
export const setState = (next: AthenaState | null): void => {
  state = next
}
export let currentTab = 'work'
export const setCurrentTab = (next: string): void => {
  currentTab = next
}
