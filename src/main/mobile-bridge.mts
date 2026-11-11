// ── 모바일 브리지 — 폰 앱이 이 앱의 데몬 · 요청 · 결정 콘솔을 보고 답하게 하는 맥 쪽 처리기 ──
// 계획서 plans/feature/20261110-아테나-모바일-앱.md 4-7 "메시지". 기본 꺼짐 — 켜는 설정 · 화면이 생기기 전에는 아무 데서도 만들지 않는다.
// 전송층(relay · 암호화)은 아직 없다 — Transport 하나로 끼워 넣는다(지금은 createMemoryTransport · 시험용).
// 메시지 모양은 데몬 줄 JSON 과 같다: 폰 → 맥 {id, op, args} · 맥 → 폰 답 {id, ok, result | error} · 알림 {event, …}
//
// 데몬은 자기를 띄운 앱의 것만(부르는 쪽이 main 의 daemonPaths() 를 넘긴다 — 배포판 daemon.json · 개발판 daemon-dev.json · 격리 집).
// 데몬을 띄우거나 다시 띄우지 않는다(peekDaemon — 이미 뜬 데몬 · 같은 프로토콜에만 붙는다).
// 폰은 크기를 보내지 않는다 — 브리지도 데몬에 resize 를 보내지 않는다(PC 크기 그대로 · D1).
//
// 데몬 연결은 둘: 묻기용(pane list · input — attach 하지 않음)과 흘리기용(pane 을 열었을 때만 attach).
// attach 한 연결은 데몬이 "붙은 앱"으로 친다(fitTab 건너뜀 · open-url 받을 창 고르기 — src/daemon/daemon.mts) — 그래서 열린 pane 이 없으면 끊는다.
// 흘리기용은 본체로 묶지 않는다(body 없음) — 묶으면 open-url 을 그 본체 앱 창 대신 브리지가 받을 수 있다.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import * as daemonClient from '../daemon-client.mts'
import type { Reply } from '../daemon-client.mts'

type Connection = NonNullable<Awaited<ReturnType<typeof daemonClient.peekDaemon>>>
type DaemonPaths = Parameters<typeof daemonClient.peekDaemon>[0]['paths']

// 전송층 — 폰 쪽과 주고받는 한 통로. relay 가 생기면 같은 모양으로 끼운다
export type Transport = {
  send(message: object): void
  onMessage(handler: (message: unknown) => void): void
  close(): void
}

// 폰이 보낸 답(request.answer) — 부르는 쪽(main)이 ctx.answerRequest(id, answer, 'mobile') 로 잇는다
export type RequestAnswer = { choice?: string; text?: string; rev?: number }
export type AnswerResult = { ok: boolean; error?: string; [key: string]: unknown }
// 현황판 /api/action 에 보낼 몸통 — 결정 콘솔이 보내는 것과 같고 by 만 더한다
export type DecisionPost = { pane: string; plan: string; decisions: string[]; text: string; by: 'mobile' }
export type BoardReply = { status: number; body: unknown }
// 사건 기록 한 줄(코어 events.mjs logEvent 와 같은 모양 — 종류 · 칸)
export type LogEvent = (type: string, fields: Record<string, unknown>) => void
// 머지 피드 원천 — 코어 사건 기록(events.jsonl)의 줄(읽는 칸만)
export type EventRow = { type?: unknown; at?: unknown; ok?: unknown; repo?: unknown; plan?: unknown; pr?: unknown; sha?: unknown; merged?: unknown; direct?: unknown }

export type BridgeDeps = {
  daemonPaths: () => DaemonPaths
  transport: Transport
  inputAllowed: () => boolean // "폰 입력 허용" — 꺼지면 pane.input · request.answer · decision.answer 를 거절
  requests: () => unknown[] | Promise<unknown[]> // 확인 요청 목록(열린 것)
  servers: () => unknown | Promise<unknown> // 서버 상태
  events: () => EventRow[] | Promise<EventRow[]> // 7일 머지 원천
  answerRequest: (id: string, answer: RequestAnswer) => Promise<AnswerResult>
  leadPaneOf: (plan: string) => string | null // 결정 콘솔이 보낼 pane(계획서 html PLAN.leadPane)
  postDecision: (body: DecisionPost) => Promise<BoardReply>
  logEvent: LogEvent
  now?: () => number
  flushMs?: number
}

export const FLUSH_MS = 100 // 출력은 100ms(초당 ~10번)로 묶는다 — 4-7 "트래픽"
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// 진행 중 pane — 데몬 pane list 의 agent_status(working · 질문 · 멈춤)
const IDLE_STATUSES = new Set(['', 'idle', 'unknown', 'none'])
const PLAN_ID = /^plans\/[^\0]+\.md$/

// 오류 답 — 화면 문구가 아니라 폰이 고를 코드(message 는 로그용)
class BridgeError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
const fail = (code: string, message: string): never => {
  throw new BridgeError(code, message)
}

// "폰 입력 허용" — 앱 설정(userData/config.json)의 mobileInput 칸. 켜는 화면이 생기기 전까지 기본 꺼짐
export function mobileInputAllowed(config: { [key: string]: unknown } | null | undefined): boolean {
  return Boolean(config && config.mobileInput === true)
}

// 지난 7일 머지 — 코어 auto.merge 사건 중 성공(ok true)만 새것부터
export function weekMerges(events: EventRow[], now: number) {
  return events
    .filter((event) => event.type === 'auto.merge' && event.ok === true && typeof event.at === 'string')
    .filter((event) => {
      const at = Date.parse(event.at as string)
      return !Number.isNaN(at) && at <= now && now - at <= WEEK_MS
    })
    .map((event) => ({ at: event.at as string, repo: event.repo ?? null, plan: event.plan ?? null, pr: event.pr ?? null, sha: event.sha ?? null, merged: event.merged ?? null, direct: event.direct === true }))
    .sort((left, right) => right.at.localeCompare(left.at))
}

// 진행 중 pane 만 — 폰에 필요한 칸만 넘긴다(cwd 등은 넘기지 않는다)
type ListedPane = { id?: unknown; label?: unknown; name?: unknown; title?: unknown; agent?: unknown; agent_status?: unknown }
export function runningPanes(panes: ListedPane[]) {
  return panes
    .filter((pane) => typeof pane.id === 'string' && typeof pane.agent_status === 'string' && !IDLE_STATUSES.has(pane.agent_status))
    .map((pane) => ({ id: pane.id as string, label: pane.label ?? null, name: pane.name ?? null, title: pane.title ?? null, agent: pane.agent ?? null, status: pane.agent_status as string }))
}

// 계획서 html 의 결정 콘솔 PLAN 블록에서 leadPane — 현황판 server.mjs planDecisionIds 와 같은 자리를 읽는다
const PLAN_DATA_BLOCK = /<script id="plan-data">\nconst PLAN = ([\s\S]*?)\n<\/script>/
export function readLeadPane(athenaDir: string, plan: string): string | null {
  if (!PLAN_ID.test(plan) || plan.split('/').includes('..')) return null
  try {
    const html = fs.readFileSync(path.join(athenaDir, plan.replace(/\.md$/, '.html')), 'utf8')
    const block = html.slice(html.indexOf('-->') + 3).match(PLAN_DATA_BLOCK)?.[1]
    const leadPane: unknown = block ? JSON.parse(block).leadPane : null
    return typeof leadPane === 'string' && leadPane ? leadPane : null
  } catch {
    return null
  }
}

// 현황판 /api/action — 결정 콘솔과 같은 출처(Origin) · 토큰(runPack board-token)으로 맥 안에서 부른다
export function boardActionPoster({ port, token }: { port: number; token: string }) {
  return (body: DecisionPost): Promise<BoardReply> =>
    new Promise((resolve) => {
      const payload = JSON.stringify(body)
      const request = http.request(
        { host: '127.0.0.1', port, path: '/api/action', method: 'POST', timeout: 5000, headers: { 'content-type': 'application/json', origin: `http://localhost:${port}`, 'x-board-token': token, 'content-length': Buffer.byteLength(payload) } },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => (text += chunk))
          response.on('end', () => {
            let parsed: unknown = null
            try {
              parsed = JSON.parse(text)
            } catch {}
            resolve({ status: response.statusCode || 0, body: parsed })
          })
        },
      )
      request.on('timeout', () => request.destroy())
      request.on('error', () => resolve({ status: 0, body: null }))
      request.end(payload)
    })
}

// 시험용 메모리 전송 — bridge 쪽은 브리지에 넘기고, phone 쪽으로 폰 흉내(보내기 · 받은 것 보기)
export function createMemoryTransport() {
  const toBridge: ((message: unknown) => void)[] = []
  const toPhone: ((message: unknown) => void)[] = []
  const received: Record<string, unknown>[] = []
  let closed = false
  // JSON 으로 한 번 오가게 — 실제 전송처럼 함수 · 공유 객체가 넘어가지 않는다
  const copy = (message: unknown) => JSON.parse(JSON.stringify(message))
  const bridge: Transport = {
    send: (message) => {
      if (closed) return
      const sent = copy(message)
      received.push(sent)
      for (const handler of toPhone) handler(sent)
    },
    onMessage: (handler) => void toBridge.push(handler),
    close: () => void (closed = true),
  }
  const phone = {
    send: (message: unknown) => {
      if (!closed) for (const handler of toBridge) handler(copy(message))
    },
    onMessage: (handler: (message: unknown) => void) => void toPhone.push(handler),
    received,
    get closed() {
      return closed
    },
  }
  return { bridge, phone }
}

export function createMobileBridge(deps: BridgeDeps) {
  const { transport } = deps
  const now = deps.now || Date.now
  const flushMs = deps.flushMs ?? FLUSH_MS
  let control: Connection | null = null // 묻기용
  let controlConnecting: Promise<Connection> | null = null
  let stream: Connection | null = null // 흘리기용(attach)
  let streamConnecting: Promise<Connection> | null = null
  const open = new Set<string>() // 폰이 연 pane
  const opening = new Set<string>() // 스냅숏을 기다리는 pane — 그 전 출력은 스냅숏에 이미 들어 있다
  const pending = new Map<string, string>() // pane → 모아 둔 출력
  let flushTimer: NodeJS.Timeout | null = null
  let resyncing = false
  let stopped = false

  const emit = (message: object) => {
    if (!stopped) transport.send(message)
  }

  function flush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    for (const [pane, data] of pending) emit({ event: 'pane.data', pane, data })
    pending.clear()
  }

  async function connectControl(): Promise<Connection> {
    if (control) return control
    if (controlConnecting) return controlConnecting
    controlConnecting = (async () => {
      const own = await daemonClient.peekDaemon({ paths: deps.daemonPaths(), onClose: () => void (control === own ? (control = null) : null) })
      if (!own) return fail('daemon-unavailable', '떠 있는 데몬이 없거나 프로토콜이 달라요')
      control = own
      return own
    })().finally(() => (controlConnecting = null))
    return controlConnecting
  }

  function onStreamEvent(message: Reply & { pane?: string; data?: string }) {
    if (message.event === 'data' && typeof message.pane === 'string') {
      if (resyncing || !open.has(message.pane) || opening.has(message.pane)) return
      pending.set(message.pane, (pending.get(message.pane) || '') + String(message.data ?? ''))
      if (!flushTimer) flushTimer = setTimeout(flush, flushMs)
    } else if (message.event === 'exit' && typeof message.pane === 'string') {
      flush()
      open.delete(message.pane)
      emit({ event: 'changed', parts: ['panes'] })
      if (!open.size) closeStream()
    } else if (message.event === 'state') {
      emit({ event: 'changed', parts: ['panes'] })
    } else if (message.event === 'resync') {
      resync().catch(() => {})
    }
    // open-url 은 앱 창 몫이다 — 흘리기용은 본체로 묶지 않아 데몬이 고르지 않는다
  }

  async function connectStream(): Promise<Connection> {
    if (stream) return stream
    if (streamConnecting) return streamConnecting
    streamConnecting = (async () => {
      let own: Connection | null = null
      own = await daemonClient.peekDaemon({
        paths: deps.daemonPaths(),
        onEvent: (message) => {
          if (own && own === stream) onStreamEvent(message as Reply & { pane?: string; data?: string })
        },
        onClose: () => {
          if (own !== stream) return
          stream = null
          // 데몬 쪽에서 끊겼다 — 열린 pane 은 끊김으로 알리고 비운다(폰이 다시 연다)
          if (open.size) emit({ event: 'changed', parts: ['panes'] })
          open.clear()
          opening.clear()
          pending.clear()
        },
      })
      if (!own) return fail('daemon-unavailable', '떠 있는 데몬이 없거나 프로토콜이 달라요')
      stream = own
      return own
    })().finally(() => (streamConnecting = null))
    return streamConnecting
  }

  function closeStream() {
    const current = stream
    stream = null
    if (current) current.close().catch(() => {})
  }

  // attach — 답을 읽은 그 자리에서(같은 소켓의 뒤 출력보다 먼저) 기다리던 pane 을 풀어 그 뒤 출력부터 받는다
  async function attach(connection: Connection, onReplied: () => void): Promise<Record<string, string>> {
    const result = (await connection.call('attach', {}, (reply) => {
      if (reply.ok) onReplied()
    })) as { snapshots?: Record<string, string> } | null
    return (result && result.snapshots) || {}
  }

  // 데몬이 못 따라온 폰 연결을 끊었다(8MB) — 다시 attach 해서 열린 pane 마다 새 스냅숏
  async function resync() {
    if (resyncing || !stream) return
    resyncing = true
    pending.clear()
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    try {
      const snapshots = await attach(stream, () => (resyncing = false))
      for (const pane of open) emit({ event: 'pane.resync', pane, snapshot: snapshots[pane] ?? '' })
    } finally {
      resyncing = false
    }
  }

  async function paneOpen(pane: string) {
    const connection = await connectStream()
    flush()
    opening.add(pane)
    open.add(pane)
    try {
      const snapshots = await attach(connection, () => opening.delete(pane))
      if (!(pane in snapshots)) {
        open.delete(pane)
        if (!open.size) closeStream()
        return fail('not_found', `없는 pane: ${pane}`)
      }
      return { pane, snapshot: snapshots[pane] }
    } catch (error) {
      open.delete(pane)
      if (!open.size) closeStream()
      throw error
    } finally {
      opening.delete(pane)
    }
  }

  function paneClose(pane: string) {
    flush()
    open.delete(pane)
    if (!open.size) closeStream()
    return { pane }
  }

  async function snapshot() {
    const connection = await connectControl()
    const listed = (await connection.call('pane list')) as { panes?: ListedPane[] } | null
    const [requests, servers, events] = await Promise.all([deps.requests(), deps.servers(), deps.events()])
    return { requests, panes: runningPanes((listed && listed.panes) || []), merges: weekMerges(events, now()), servers }
  }

  const requireInput = () => {
    if (!deps.inputAllowed()) fail('input-off', '폰 입력 허용이 꺼져 있어요')
  }
  const text = (value: unknown, name: string): string => (typeof value === 'string' && value ? value : fail('usage', `${name} 가 필요해요`))

  async function paneInput(args: Record<string, unknown>) {
    requireInput()
    const pane = text(args.pane, 'pane')
    const data = text(args.data, 'data')
    const connection = await connectControl()
    // 키 그대로(D2) — 붙여넣기 · 줄바꿈도 바꾸지 않는다
    await connection.call('input', { pane, data })
    // 내용은 적지 않는다(비밀값이 섞일 수 있다) — 누가 · 어느 pane · 크기만
    deps.logEvent('mobile.input', { by: 'mobile', pane, bytes: Buffer.byteLength(data) })
    return null
  }

  async function requestAnswer(args: Record<string, unknown>) {
    requireInput()
    const id = text(args.id, 'id')
    const choice = typeof args.choice === 'string' ? args.choice : ''
    const answerText = typeof args.text === 'string' ? args.text : ''
    if (!choice.trim() && !answerText.trim()) fail('usage', 'choice 또는 text 가 필요해요')
    const answer: RequestAnswer = { choice, text: answerText }
    if (Number.isInteger(args.rev)) answer.rev = args.rev as number
    const result = await deps.answerRequest(id, answer)
    if (!result.ok) fail(result.error || 'failed', '답을 적지 못했어요')
    return result
  }

  async function decisionAnswer(args: Record<string, unknown>) {
    requireInput()
    const plan = text(args.plan, 'plan')
    if (!PLAN_ID.test(plan) || plan.split('/').includes('..')) fail('usage', 'plan 은 plans/…md 여야 해요')
    if (!Array.isArray(args.decisions) || !args.decisions.every((entry) => typeof entry === 'string')) fail('usage', 'decisions 는 결정 id 목록이어야 해요')
    const prompt = text(args.text, 'text')
    const pane = deps.leadPaneOf(plan)
    if (!pane) return fail('no-pane', '결정을 보낼 pane 이 없어요')
    const reply = await deps.postDecision({ pane, plan, decisions: args.decisions as string[], text: prompt, by: 'mobile' })
    const body = (reply.body && typeof reply.body === 'object' ? reply.body : {}) as { stale?: unknown; queued?: unknown }
    if (reply.status === 409 && body.stale) fail('stale', '계획서 결정이 그사이 바뀌었어요')
    if (reply.status !== 200) fail('failed', `현황판이 받지 않았어요(${reply.status})`)
    return { ok: true, queued: body.queued === true }
  }

  async function dispatch(op: unknown, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'snapshot':
        return snapshot()
      case 'pane.open':
        return paneOpen(text(args.pane, 'pane'))
      case 'pane.close':
        return paneClose(text(args.pane, 'pane'))
      case 'pane.input':
        return paneInput(args)
      case 'request.answer':
        return requestAnswer(args)
      case 'decision.answer':
        return decisionAnswer(args)
      default:
        return fail('usage', `모르는 요청: ${String(op)}`)
    }
  }

  async function handle(message: unknown) {
    if (stopped || !message || typeof message !== 'object') return
    const { id, op, args } = message as { id?: unknown; op?: unknown; args?: unknown }
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    try {
      const result = await dispatch(op, safeArgs)
      if (id !== undefined) emit({ id, ok: true, result: result ?? null })
    } catch (caught) {
      const error = caught as { code?: unknown; message?: unknown }
      if (id !== undefined) emit({ id, ok: false, error: { code: typeof error.code === 'string' ? error.code : 'internal', message: String(error.message ?? '') } })
    }
  }

  transport.onMessage((message) => void handle(message))

  return {
    // 맥 쪽에서 바뀐 칸을 알린다(요청 폴더 · 머지 · 서버) — 폰은 그 칸만 다시 snapshot 한다
    changed(parts: string[]) {
      emit({ event: 'changed', parts })
    },
    openPanes: () => [...open],
    async stop() {
      if (stopped) return
      flush()
      stopped = true
      open.clear()
      const closing = [control, stream].filter((connection): connection is Connection => Boolean(connection)).map((connection) => connection.close())
      control = null
      stream = null
      await Promise.all(closing)
      transport.close()
    },
  }
}
