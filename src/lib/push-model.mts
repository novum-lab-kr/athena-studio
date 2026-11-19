// 폰 푸시 — 맥이 언제 relay push.send 를 부를지(계획서 plans/feature/20261119-폰-푸시-알림-답-필요-일-끝남.md 결정 B1 · C2).
// Electron 없이 돌아 `npm test` 로 검사한다. 보낼지 말지(폰이 붙어 있는지)는 부르는 쪽(mobile-dev · mobile-relay)이 정한다.
// request = 새로 열린 확인 요청 · pane 입력 대기 — 메뉴 막대 알림과 같은 판정(tray-model Notifier: 켤 때 본 것은 빼고 · 같은 건은 한 번 · 허락 한 건은 pane 마다 한 번)
// done = 에이전트 pane 이 working → idle(아테나 · 직접 켠 pane 포함) — 같은 pane 은 알린 뒤 DONE_HOLD_MS 안에 또 끝나도 한 번만
// 한 번 볼 때 같은 종류가 여러 건이어도 하나로 — relay 알림 글이 종류마다 고정 문구라 여러 번 보내도 같은 글이다
import { Notifier } from './tray-model.mts'
import type { TrayPane } from './tray-model.mts'

export type PushKind = 'request' | 'done'
export const DONE_HOLD_MS = 60_000 // 같은 pane 끝남 묶기(아테나 정한 값 · 2026-11-19)

export class PushWatch {
  notifier = new Notifier()
  status = new Map<string, string>() // pane → 지난번 상태
  doneAt = new Map<string, number>() // pane → 끝남을 알린 시각
  ready = false

  // 요청 목록이 바뀜 — 새로 열린 것이 있으면 ['request']. 못 읽었으면(null) 기억 그대로 · 처음 본 목록은 기준만
  requests(list: unknown): PushKind[] {
    return this.notifier.updateRequests(list).length ? ['request'] : []
  }

  // pane 목록(메뉴 막대가 입력 대기를 보탠 것) — 이번에 보낼 종류
  panes(panes: readonly (TrayPane | null | undefined)[], now: number): PushKind[] {
    const kinds = new Set<PushKind>()
    if (this.notifier.update({ panes: [...panes] }, now).length) kinds.add('request')
    const seen = new Set<string>()
    for (const pane of panes) {
      if (!pane || !pane.agent) continue
      seen.add(pane.id)
      const status = pane.agent_status || 'idle'
      const before = this.status.get(pane.id)
      this.status.set(pane.id, status)
      // 처음 본 pane · 켤 때는 기준만
      if (!this.ready || before !== 'working' || status !== 'idle') continue
      const last = this.doneAt.get(pane.id)
      if (last !== undefined && now - last < DONE_HOLD_MS) continue
      this.doneAt.set(pane.id, now)
      kinds.add('done')
    }
    for (const id of [...this.status.keys()]) if (!seen.has(id)) this.status.delete(id)
    for (const id of [...this.doneAt.keys()]) if (!seen.has(id)) this.doneAt.delete(id)
    this.ready = true
    return [...kinds]
  }
}
