// 폰 푸시 — 맥이 언제 · 무슨 글로 relay push.send 를 부를지(계획서 plans/feature/20261119-폰-푸시-알림-답-필요-일-끝남.md 결정 B1 · C2 ·
// plans/feature/20261119-폰-알림-내용-암호화-A3.md 결정 D1 · D3 · D4).
// Electron 없이 돌아 `npm test` 로 검사한다. 보낼지 말지(폰이 붙어 있는지) · 암호화는 부르는 쪽(mobile-dev · mobile-relay)이 한다.
// request = 새로 열린 확인 요청 · pane 입력 대기 — 메뉴 막대 알림과 같은 판정(tray-model Notifier: 켤 때 본 것은 빼고 · 같은 건은 한 번 · 허락 한 건은 pane 마다 한 번)
// done = 에이전트 pane 이 working → idle(아테나 · 직접 켠 pane 포함) — 같은 pane 은 알린 뒤 DONE_HOLD_MS 안에 또 끝나도 한 번만
// 사건 하나에 푸시 하나(D3) — 사건마다 글(제목 · 본문)과 id 가 있다:
//   같은 pane 의 확인 요청은 ASK_HOLD_MS 안에 한 번(요청 목록 · 입력 대기 · 같은 건을 다른 id 로 받은 요청이 겹쳐도) ·
//   확인 요청을 알린 pane 이 곧 쉬어도(working → idle) 일 끝남을 또 보내지 않는다 · 그 pane 이 다시 일하기 시작하면 묶기가 풀린다 ·
//   일 끝남 뒤의 확인 요청은 보낸다 · 같은 id 는 다시 보내지 않는다
// 글(D1): 제목 '<에이전트> · 확인 요청|일 끝남' · 본문 = 요청 제목 / 일 끝남 · 입력 대기는 pane 이름표 — relay 고정 문구(풀기 실패 때 보임)와 같이 한국어
// pane(사용자 요청 2026-11-20): 그 푸시를 낸 pane id — 확인 요청은 요청을 연 pane · 일 끝남 · 입력 대기는 그 pane. 암호 안에만 실어 폰이 알림을 누르면 그 pane 으로 간다(모르면 없음)
// 맥 알림과 같은 거르기(사용자 결정 2026-11-19) — 메뉴 막대 [알림 끄기] 동안 · Studio 창이 앞(포커스)일 때(D4)는 아무것도 · 지금 보고 있는 pane 의 확인 요청 · 일 끝남은 빼고.
// 거른 것도 기억은 그대로 넘긴다(끄기가 풀려도 그 사이 것을 몰아 보내지 않는다 — 맥 알림과 같다)
// 끊길 때 다시 보내기(사용자 결정 2026-11-20): 폰이 직접(lan) 길로 붙어 있어 푸시 대상에서 빠진 사건은 PushMissed 가 기기마다 적어 두고,
//   그 기기 직접 길이 닫힐 때 그 기기에만 다시 보낸다 — 끊기기 전 RESEND_WINDOW_MS 안 것 · 아직 열려 있는 요청만 · 한 번만
import crypto from 'node:crypto'
import { Notifier, agentName } from './tray-model.mts'
import type { TrayPane } from './tray-model.mts'

export type PushKind = 'request' | 'done'
// 푸시 하나 — id 는 relay 중복 거르기 · 로그용(base64url 22자), title · body · pane 은 암호화해 싣는 것(pane 을 모르면 없음)
// request = 요청 목록에서 온 확인 요청의 요청 id — 맥 안에서만 쓴다(다시 보낼 때 아직 열려 있는지 · relay 로는 나가지 않는다)
export type PushEvent = { kind: PushKind; id: string; title: string; body: string; pane?: string; request?: string }
export const DONE_HOLD_MS = 60_000 // 같은 pane 끝남 묶기(아테나 정한 값 · 2026-11-19)
export const ASK_HOLD_MS = 60_000 // 같은 pane 확인 요청 묶기 · 확인 요청 뒤 일 끝남 안 보내기(D3)
export const SENT_KEEP_MS = 10 * 60_000 // 보낸 사건 id 를 기억하는 동안
export const RESEND_WINDOW_MS = 60_000 // 직접 길이 닫힐 때 다시 보내는 것 — 끊기기 전 이 안에 생긴 사건만(사용자 결정 2026-11-20)
export const MISSED_MAX = 20 // 기기마다 기억하는 빠진 사건 수(넘으면 오래된 것부터 버린다)
export const TITLE_MAX = 60 // 글자(코드포인트) — 계획서 5절
export const BODY_MAX = 160
export const PANE_MAX = 64 // pane id 글자(코드포인트) — 넘으면 싣지 않는다(enc 가 relay 상한을 넘지 않게)
const ASK_TITLE = '확인 요청'
const DONE_TITLE = '일 끝남'

// 메뉴 막대가 주는 거르기(tray.mts pushGate) — 없으면 거르지 않는다. active = Studio 창이 앞(포커스)이고 화면이 잠기지 않음(D4)
export type PushGate = { muted: boolean; active?: boolean; lookingAt: (pane: string) => boolean }
const openGate: PushGate = { muted: false, lookingAt: () => false }

// 보낸 것의 기억 — PushWatch 를 새로 만들어도(앞 창 · 본체가 바뀜) 부르는 쪽이 들고 있어 묶기가 풀리지 않는다.
// pane 목록에 안 보인다고 지우지 않고(창마다 목록이 다를 수 있다) 시간이 지난 것만 지운다
export class PushMemory {
  doneAt = new Map<string, number>() // pane → 끝남을 알린 시각
  askedAt = new Map<string, number>() // pane → 확인 요청을 알린 시각
  sent = new Map<string, number>() // 사건 id → 보낸 시각

  prune(now: number) {
    for (const [pane, at] of this.doneAt) if (now - at >= DONE_HOLD_MS) this.doneAt.delete(pane)
    for (const [pane, at] of this.askedAt) if (now - at >= ASK_HOLD_MS) this.askedAt.delete(pane)
    for (const [id, at] of this.sent) if (now - at >= SENT_KEEP_MS) this.sent.delete(id)
  }
}

// 지금 열려 있는 요청 id — 목록을 못 읽었으면 null(모른다)
export function openRequestIds(list: unknown): Set<string> | null {
  if (!Array.isArray(list)) return null
  const open = new Set<string>()
  for (const request of list as ({ id?: unknown; state?: unknown } | null | undefined)[]) {
    if (request && typeof request.id === 'string' && request.state === 'open') open.add(request.id)
  }
  return open
}

// 직접 길로 붙어 있어 푸시 대상에서 빠진 사건 — 기기마다 작게 적어 두었다가 그 기기 직접 길이 닫힐 때 꺼낸다
export class PushMissed {
  private missed = new Map<string, { event: PushEvent; at: number }[]>() // 기기 → 빠진 사건(오래된 것부터)

  // 이 사건이 peers(직접 길로 붙은 기기) 때문에 빠졌다 — 오래된 것은 이때 버린다
  note(peers: readonly string[], event: PushEvent, now: number) {
    for (const [peer, list] of this.missed) {
      const fresh = list.filter((item) => now - item.at < RESEND_WINDOW_MS)
      if (fresh.length) this.missed.set(peer, fresh)
      else this.missed.delete(peer)
    }
    for (const peer of peers) {
      const list = this.missed.get(peer) || []
      if (list.some((item) => item.event.id === event.id)) continue
      list.push({ event, at: now })
      this.missed.set(peer, list.slice(-MISSED_MAX))
    }
  }

  // 그 기기 직접 길이 닫혔다 — 다시 보낼 사건(끊기기 전 RESEND_WINDOW_MS 안 · 요청이면 아직 열려 있는 것만). 꺼낸 기기의 기억은 비운다(두 번 보내지 않는다)
  // openRequests 가 null(요청 목록을 못 읽음)이면 답했는지 알 수 없는 확인 요청은 보내지 않는다
  // gate — 처음 보낼 때와 같은 거르기를 지금 한 번 더: [알림 끄기] · Studio 창이 앞(D4)이면 아무것도(몰아 보내지 않게 기억도 비운다) · 지금 보고 있는 pane 것은 뺀다
  take(peer: string, now: number, openRequests: ReadonlySet<string> | null, gate: PushGate = openGate): PushEvent[] {
    const list = this.missed.get(peer) || []
    this.missed.delete(peer)
    if (gate.muted || gate.active) return []
    const found: PushEvent[] = []
    for (const { event, at } of list) {
      if (now - at >= RESEND_WINDOW_MS) continue
      if (event.request !== undefined && !(openRequests && openRequests.has(event.request))) continue
      if (event.pane && gate.lookingAt(event.pane)) continue
      found.push(event)
    }
    return found
  }

  peers = (): string[] => [...this.missed.keys()]
}

// 제어 글자를 빼고 max 글자(코드포인트)에서 자른다
export function clipText(value: unknown, max: number): string {
  const chars = Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
  return chars.slice(0, max).join('')
}

// 사건 id — relay 가 알 수 있는 것은 해시뿐(요청 id · pane 이름을 그대로 싣지 않는다)
const eventId = (...parts: (string | number)[]) => crypto.createHash('sha256').update(parts.join('\n')).digest('base64url').slice(0, 22)
// 에이전트 이름 — delegate 이름표 '🤖 에이전트 · 브랜치' 의 ' · ' 앞(이름표가 없으면 agent)
const agentOf = (pane: TrayPane) => agentName(pane).split(' · ')[0] || agentName(pane)
const titleOf = (pane: TrayPane | undefined, what: string) => clipText(pane ? `${agentOf(pane)} · ${what}` : what, TITLE_MAX)

// 사건에 실을 pane 칸 — 모르거나 너무 길면 칸 자체를 뺀다
const paneField = (pane: string | undefined): { pane?: string } => (pane && Array.from(pane).length <= PANE_MAX ? { pane } : {})

type RequestLike = { id?: unknown; pane?: unknown }

export class PushWatch {
  notifier = new Notifier()
  memory: PushMemory
  status = new Map<string, string>() // pane → 지난번 상태
  seen = new Map<string, TrayPane>() // pane → 마지막으로 본 모습(요청 알림의 에이전트 이름)
  ready = false

  constructor(memory: PushMemory = new PushMemory()) {
    this.memory = memory
  }

  // 같은 id 는 한 번만 — 보내기로 한 것을 기억에 적는다
  private take(event: PushEvent, now: number): PushEvent[] {
    if (this.memory.sent.has(event.id)) return []
    this.memory.sent.set(event.id, now)
    return [event]
  }

  // 요청 목록이 바뀜 — 새로 열린 것마다 사건 하나. 못 읽었으면(null) 기억 그대로 · 처음 본 목록은 기준만
  // 보고 있는 pane 이면 빼는 것은 허락 창 요청뿐(메뉴 막대와 같다) · 같은 pane 묶기(D3)는 pane 이 붙은 요청 모두
  requests(list: unknown, gate: PushGate = openGate, now: number = Date.now()): PushEvent[] {
    this.memory.prune(now)
    const paneOf = new Map<string, string>()
    for (const request of Array.isArray(list) ? (list as (RequestLike | null | undefined)[]) : []) {
      if (request && typeof request.id === 'string' && typeof request.pane === 'string' && request.pane) paneOf.set(request.id, request.pane)
    }
    const found: PushEvent[] = []
    for (const notice of this.notifier.updateRequests(list)) {
      if (notice.target.pane && gate.lookingAt(notice.target.pane)) continue
      const request = notice.target.request || ''
      const pane = paneOf.get(request)
      if (pane !== undefined) {
        if (this.memory.askedAt.has(pane)) continue
        this.memory.askedAt.set(pane, now)
      }
      const shown = pane === undefined ? undefined : this.seen.get(pane)
      const body = clipText(notice.body, BODY_MAX) || (shown ? clipText(agentName(shown), BODY_MAX) : '')
      found.push(...this.take({ kind: 'request', id: eventId('request', request), title: titleOf(shown, ASK_TITLE), body, ...paneField(pane), ...(request ? { request } : {}) }, now))
    }
    return gate.muted || gate.active ? [] : found
  }

  // pane 목록(메뉴 막대가 입력 대기를 보탠 것) — 이번에 보낼 사건
  panes(panes: readonly (TrayPane | null | undefined)[], now: number, gate: PushGate = openGate): PushEvent[] {
    this.memory.prune(now)
    const found: PushEvent[] = []
    const seen = new Set<string>()
    for (const pane of panes) {
      if (!pane || !pane.agent) continue
      seen.add(pane.id)
      this.seen.set(pane.id, pane)
    }
    for (const notice of this.notifier.update({ panes: [...panes] }, now)) {
      const id = notice.target.pane
      if (!id || gate.lookingAt(id) || this.memory.askedAt.has(id)) continue
      this.memory.askedAt.set(id, now)
      const pane = this.seen.get(id)
      found.push(...this.take({ kind: 'request', id: eventId('waiting', id, now), title: titleOf(pane, ASK_TITLE), body: pane ? clipText(agentName(pane), BODY_MAX) : '', ...paneField(id) }, now))
    }
    for (const id of seen) {
      const pane = this.seen.get(id) as TrayPane
      const status = pane.agent_status || 'idle'
      const before = this.status.get(id)
      this.status.set(id, status)
      // 다시 일하기 시작했다 — 앞 확인 요청은 끝난 사건이다(그 뒤의 일 끝남 · 새 확인 요청은 따로 보낸다)
      if (before !== undefined && before !== 'working' && status === 'working') this.memory.askedAt.delete(id)
      // 처음 본 pane · 켤 때는 기준만
      if (!this.ready || before !== 'working' || status !== 'idle') continue
      if (this.memory.doneAt.has(id)) continue
      this.memory.doneAt.set(id, now)
      // 방금 확인 요청을 알린 pane 이 쉬는 것은 같은 사건이다(D3)
      if (gate.lookingAt(id) || this.memory.askedAt.has(id)) continue
      found.push(...this.take({ kind: 'done', id: eventId('done', id, now), title: titleOf(pane, DONE_TITLE), body: clipText(agentName(pane), BODY_MAX), ...paneField(id) }, now))
    }
    for (const id of [...this.status.keys()]) if (!seen.has(id)) this.status.delete(id)
    for (const id of [...this.seen.keys()]) if (!seen.has(id)) this.seen.delete(id)
    this.ready = true
    return gate.muted || gate.active ? [] : found
  }
}
