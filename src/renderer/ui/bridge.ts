// 바닐라 .ts ↔ React 화면을 잇는 작은 틀 — 화면 하나를 React 로 옮길 때 이 파일의 네 가지만 쓴다
// 1. 마운트: 바닐라가 이미 가진 "몸통" 칸(예: settings-pop-body)에 mountIsland 로 React 루트를 띄우고, 닫을 때 돌려받은 함수로 내린다.
//    바깥 껍데기(열기 · 닫기 · Esc · 바깥 누르기 · 포커스 돌려주기)는 바닐라(openPop · closePops)가 그대로 맡는다
// 2. 문구: 바닐라의 say(core.ts)를 connect 로 받아 useSay 로 쓴다. 언어가 바뀌면 바닐라가 textsChanged() 한 줄 → 떠 있는 React 화면이 다시 그린다
// 3. 바닐라 상태: 바닐라와 React 가 같이 보는 값은 createStore 로 만들고 바닐라는 set, React 는 useStore 로 읽는다(바뀌면 다시 그림)
// 4. preload API: studio 전역(preload 의 contextBridge)을 React 쪽에서도 그대로 부른다 — 타입은 ../studio-api.d.ts
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

export type Say = (key: string, values?: Record<string, string | number>) => string
export type ToastKind = 'error' | 'info' | 'success'
export type VanillaHelpers = { say: Say; showToast: (message: string, kind?: ToastKind) => void }

export type Store<T> = { get: () => T; set: (next: T) => void; subscribe: (listener: () => void) => () => void }

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}

// 바닐라 도우미 — connect 전에 그리면 키를 그대로 보인다(진입점이 main.ts 를 실은 뒤에야 화면을 띄우므로 실제로는 없다)
let helpers: VanillaHelpers = { say: (key) => key, showToast: () => {} }
// 문구 판 번호 — 언어가 바뀔 때마다 1 씩. useSay 가 이 값을 구독해 다시 그린다
const texts = createStore(0)

export function connect(next: VanillaHelpers): void {
  helpers = next
}

export function textsChanged(): void {
  texts.set(texts.get() + 1)
}

export function useSay(): Say {
  useStore(texts)
  return helpers.say
}

// 컴포넌트 밖(바닐라가 부르는 함수)에서 쓰는 문구 — 다시 그리기를 구독하지 않는다
export const say: Say = (key, values) => helpers.say(key, values)

export function showToast(message: string, kind?: ToastKind): void {
  helpers.showToast(message, kind)
}

// 칸 하나에 React 를 띄운다. 처음 그림은 바로(flushSync) — 바닐라가 replaceChildren 하던 때처럼 열리는 순간 내용이 있다
export function mountIsland(container: HTMLElement, node: ReactNode): () => void {
  const root = createRoot(container)
  flushSync(() => root.render(node))
  return () => root.unmount()
}
