// 알림(#toast — pane 위에 따로 뜨는 한 줄) · 작업 창 상태 줄(#screen-status — 데몬에 못 붙었을 때) · 되살리기 결과 고르기
// PR-R12. 칸 자리(index.html)와 대화상자(packAlert)는 renderer.js 그대로. 알림의 칸 속성(종류 · role · 숨김) · 사라지는 타이머 · 마우스 올려 기다리기는 여기서 한다.
// 다른 팝업과 달리 열고 닫지 않는다 — 켤 때 한 번 띄워 두고 계속 쓴다
import { Fragment } from 'react'
import { flushSync } from 'react-dom'
import { createStore, mountIsland, say, useSay, useStore } from './bridge.ts'
import type { ToastKind } from './bridge.ts'

// 알림은 kind: error(기본 · ✕ 로 닫을 때까지) · success(4초) · info(6초). 마우스를 올려 두면 기다린다
const TOAST_MS: Partial<Record<ToastKind, number>> = { success: 4000, info: 6000 }
const TOAST_ICONS: Record<ToastKind, string> = { success: '✓', info: 'i', error: '!' }
const CLOSE_ICON = ['M6 6l12 12', 'M18 6L6 18']

// seq — 띄울 때마다 1 씩. 같은 글을 다시 띄워도 내용을 새로 만든다(바닐라가 replaceChildren 하던 때처럼 화면 읽기 프로그램이 다시 읽는다)
type ToastView = { message: string; kind: ToastKind; seq: number }
const toastView = createStore<ToastView | null>(null)
const statusView = createStore('')

let toastBox: HTMLElement | null = null
let statusBox: HTMLElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | undefined
let toastKind: ToastKind = 'error'

// 켤 때 한 번(core.ts 맨 위) — 알림 칸 · 상태 줄 칸에 각각 띄운다(내리지 않는다)
export function mount(toast: HTMLElement, status: HTMLElement): void {
  toastBox = toast
  statusBox = status
  mountIsland(toast, <Toast />)
  mountIsland(status, <ScreenStatus />)
  toast.addEventListener('mouseenter', () => clearTimeout(toastTimer))
  toast.addEventListener('mouseleave', waitToast)
}

function hideToast(): void {
  clearTimeout(toastTimer)
  if (toastBox) toastBox.hidden = true
}

function waitToast(): void {
  clearTimeout(toastTimer)
  const ms = TOAST_MS[toastKind]
  if (ms) toastTimer = setTimeout(hideToast, ms)
}

export function showToast(message: string, kind: ToastKind = 'error'): void {
  const box = toastBox
  if (!box) return
  clearTimeout(toastTimer)
  toastKind = kind
  const seq = (toastView.get()?.seq ?? 0) + 1
  // 칸 속성(종류 · role)을 먼저 — 바닐라가 replaceChildren 앞에 넣던 차례 그대로(role=alert 칸에 내용이 들어오면 화면 읽기 프로그램이 읽는다)
  box.dataset.kind = kind
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  flushSync(() => toastView.set({ message, kind, seq }))
  box.hidden = false
  waitToast()
}

export function showScreenStatus(message: string): void {
  flushSync(() => statusView.set(message))
  if (statusBox) statusBox.hidden = false
}

export function hideScreenStatus(): void {
  if (statusBox) statusBox.hidden = true
}

// 코어 pack restore-work 결과(src/main/athena-agent.mts packRestore · restoreNow — 코어 athena/scripts/lib/restore.mjs) 중 여기서 읽는 것만
type RestoreItem = { status?: string; name?: string; agent?: string; renamed?: string; message?: string; reason?: string }
export type RestoreResult = { ok?: boolean; text?: string; message?: string; worktrees?: RestoreItem[]; sessions?: RestoreItem[]; athena?: unknown[] }
export type PackAlert = (title: string, text?: string) => unknown

// 되살린 결과 — 다 됐으면 알림 한 줄, 못 한 것이 있으면 항목마다 이유(대화상자는 renderer.js packAlert).
// 대화상자의 promise 를 그대로 돌려준다 — 가져오기 흐름(runPackFlow)이 확인을 누를 때까지 잠금을 쥔다
export function showRestoreResult(result: RestoreResult, alert: PackAlert): unknown {
  if (!result.ok) return alert(say('pack.restore.failed'), result.text || result.message)
  const worktrees = result.worktrees || []
  const sessions = result.sessions || []
  const counts = {
    worktrees: worktrees.filter((item) => item.status === 'done').length,
    agents: sessions.filter((item) => item.status === 'done').length,
    athena: (result.athena || []).length,
  }
  const problems = [...worktrees, ...sessions].filter((item) => item.status !== 'done')
  const renamed = worktrees.filter((item) => item.renamed).map((item) => say('pack.restore.renamed', { name: item.name || '', branch: item.renamed || '' }))
  if (!problems.length && !renamed.length) return showToast(say('pack.restore.done', counts), 'success')
  const lines = problems.map((item) => `· ${item.name || item.agent}: ${item.message || item.reason}`)
  return alert(problems.length ? say('pack.restore.partial') : say('pack.restore.done', counts), [say('pack.restore.done', counts), ...renamed, ...lines].join('\n'))
}

function Toast() {
  const say = useSay()
  const toast = useStore(toastView)
  if (!toast) return null
  return (
    <Fragment key={toast.seq}>
      <span className="toast-icon" aria-hidden="true">
        {TOAST_ICONS[toast.kind] ?? TOAST_ICONS.error}
      </span>
      <span className="toast-message">{toast.message}</span>
      <button className="toast-close" type="button" aria-label={say('common.close')} onClick={hideToast}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {CLOSE_ICON.map((shape) => (
            <path key={shape} d={shape} />
          ))}
        </svg>
      </button>
    </Fragment>
  )
}

function ScreenStatus() {
  return <>{useStore(statusView)}</>
}
