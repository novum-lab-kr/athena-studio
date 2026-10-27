// 팩 작업 진행 표시(pack-progress) 몸통 — 도는 표시 · 제목 · 지금 하는 일 한 줄 · [취소]
// PR-R10. 껍데기(보이기 · 숨기기 · 뒤 화면 막기 syncModal · 포커스 받기 · 닫으면 포커스 돌려주기)는 renderer.js 그대로. 켤 때 한 번 띄워 두고 계속 쓴다
import { flushSync } from 'react-dom'
import { createStore, mountIsland, useSay, useStore } from './bridge.ts'

// cancellable — [취소](기다리는 중 · 검사 중에만 — 본체가 바꾸기 시작한 뒤에는 없다)
type Progress = { title: string; step: string; cancellable: boolean }
const view = createStore<Progress>({ title: '', step: '', cancellable: false })

// main 이 보내는 pack:progress(src/main/core-runner.mts) — 단계 한 줄 · 정리를 시작하면 cancellable false
export type PackProgressStep = { text?: string; cancellable?: boolean }

// 켤 때 한 번 — 진행 표시 상자(.pack-box)에 띄운다(내리지 않는다)
export function mount(box: HTMLElement): void {
  mountIsland(box, <ProgressBody />)
}

// 새 작업 — 단계 줄은 비운다. 그리기는 바로(flushSync) — 바닐라가 곧이어 상자를 보이고 포커스를 준다
export function show(title: string, cancellable: boolean): void {
  flushSync(() => view.set({ title, step: '', cancellable }))
}

// 단계 하나 — 지금 하는 일 한 줄. 정리를 시작하면 더는 취소할 수 없다
export function step(next: PackProgressStep): void {
  const state = view.get()
  flushSync(() =>
    view.set({
      ...state,
      step: next.text || '',
      cancellable: next.cancellable === false ? false : state.cancellable,
    }),
  )
}

function ProgressBody() {
  const say = useSay()
  const { title, step: stepText, cancellable } = useStore(view)
  return (
    <>
      <div className="spinner"></div>
      <h2 id="pack-progress-title">{title}</h2>
      <p id="pack-progress-step" className="pack-step" role="status">
        {stepText}
      </p>
      <div className="pack-actions">
        <button id="pack-progress-cancel" className="pack-button" hidden={!cancellable} onClick={() => void studio.packCancel()}>
          {say('common.cancel')}
        </button>
      </div>
    </>
  )
}
