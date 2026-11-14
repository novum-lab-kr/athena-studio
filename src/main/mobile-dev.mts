// ── 모바일 시험 2 의 개발용 길 — 격리 시험 앱에서만 relay 에 붙고 짝 기기마다 브리지를 둔다 ──
// 계획서 plans/feature/20261110-아테나-모바일-앱.md 4-7 · 시험 2. 브리지는 여전히 기본 꺼짐 — 설정 화면 · [허용] 창 · 로그인 화면은 없다.
// 켜지는 조건(셋 다): 개발판(배포판 아님) · ATHENA_STUDIO_HOME(격리 집) · ATHENA_STUDIO_MOBILE_RELAY 가 루프백 ws 주소.
// 계정은 ATHENA_STUDIO_MOBILE_DEV_ACCOUNT(relay 개발 로그인 · RELAY_DEV_LOGIN=1 인 relay 에서만 받는다).
// [허용]: 확인 숫자는 맥 로그(test-app.log)에 · 답은 `node scripts/mobile-pair.js --home <집> accept|reject [requestId]`.
// 열쇠 · 세션 토큰은 <집>/mobile/ 아래 0600 파일에만(mobile-relay.mts) — 로그에 남기지 않는다.
// 직접 길(mobile-lan.mts — 같은 Wi-Fi · Tailscale)도 같은 조건에서만 켠다. 한 기기는 한 번에 한 길 — 직접이 붙으면 그 기기 relay 세션은 쉬고,
// relay 로 hello 가 오면 직접 연결을 닫는다(마지막 hello 가 이긴다). 받는 주소는 relay 세션 안 lan.info 로 알린다.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMobileBridge, mobileInputAllowed, readLeadPane, boardActionPoster } from './mobile-bridge.mts'
import type { EventRow, LogEvent, RequestAnswer, AnswerResult, Transport } from './mobile-bridge.mts'
import { createMobileRelay, watchPairAnswers, loadMacKey } from './mobile-relay.mts'
import { createMobileLan, lanPortOf, DIRECT_FLUSH_MS } from './mobile-lan.mts'
import type { KeyPair } from '../lib/mobile-crypto.mts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const DEV_ACCOUNT_RE = /^[A-Za-z0-9._@-]{1,64}$/ // relay protocol.ts devAccount 와 같은 모양

// 조건이 빠졌을 때 맥 로그(화면 문구 아님 — 개발판 격리 시험 전용)
export const MOBILE_DEV_SKIPPED = '[mobile-relay] 개발용 길을 켜지 않아요 — 개발판 · ATHENA_STUDIO_HOME · 루프백 ws 주소 · ATHENA_STUDIO_MOBILE_DEV_ACCOUNT 가 모두 있어야 해요'

export type MobileDevOptions = { url: string; account: string; dir: string }

// 켜도 되는지 · 무엇으로 — 조건이 하나라도 빠지면 null(아무것도 만들지 않는다)
export function mobileDevOptions({ env, packaged, homeOverride }: { env: NodeJS.ProcessEnv; packaged: boolean; homeOverride: string | null }): MobileDevOptions | null {
  const raw = env.ATHENA_STUDIO_MOBILE_RELAY
  const account = env.ATHENA_STUDIO_MOBILE_DEV_ACCOUNT || ''
  if (packaged || !homeOverride || !raw || !DEV_ACCOUNT_RE.test(account)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(url.hostname)) return null
  return { url: url.href, account, dir: mobileStateDir(homeOverride) }
}

// 상태 폴더 — 격리 집 아래(scripts/mobile-pair.js 도 같은 자리를 쓴다)
export const mobileStateDir = (home: string) => path.join(path.resolve(home), 'mobile')

// main 이 넘기는 것 — 지금 앞에 있는 팩 창의 문맥(본체 · 요청 · 현황판)과 앱 설정
type FrontCtx = {
  athenaDir: string | null
  requestsNow(): { requests: unknown[] }
  answerRequest(id: string, answer: RequestAnswer, by: 'mobile'): Promise<unknown>
  boardPortNow(): number
  serverStatus?: () => Promise<{ servers: unknown[] }>
}
type DevDeps = {
  options: MobileDevOptions
  daemonPaths: Parameters<typeof createMobileBridge>[0]['daemonPaths']
  frontCtx: () => FrontCtx | null
  config: () => Record<string, unknown> | null
  boardToken: (athenaDir: string) => Promise<string | null>
  log?: (line: string) => void
}

type EventsModule = { readEvents?: (root: string) => EventRow[]; logEvent?: (root: string, type: string, fields: object) => void }
// 사건 기록은 본체 코어의 events.mjs 로(자리 · 모양을 코어와 같게 — pane-watch.mts 의 plan-bind 와 같은 방식)
async function eventsModule(athenaDir: string | null): Promise<EventsModule | null> {
  if (!athenaDir) return null
  try {
    return (await import(pathToFileURL(path.join(path.resolve(athenaDir), 'scripts', 'lib', 'events.mjs')).href)) as EventsModule
  } catch {
    return null
  }
}

export function startMobileDev(deps: DevDeps) {
  const log = deps.log || ((line: string) => console.log(line))
  const front = () => deps.frontCtx()
  const logEvent: LogEvent = (type, fields) => {
    const ctx = front()
    void eventsModule(ctx && ctx.athenaDir).then((events) => {
      if (ctx && ctx.athenaDir && events && typeof events.logEvent === 'function') events.logEvent(ctx.athenaDir, type, fields)
    })
  }
  // 브리지는 두 길이 같다 — 출력 묶음만 길마다(relay 는 mobile-bridge 기본값 · 직접은 DIRECT_FLUSH_MS)
  const makeBridge = (transport: Transport, flushMs?: number) =>
    createMobileBridge({
      daemonPaths: deps.daemonPaths,
      transport,
      ...(flushMs === undefined ? {} : { flushMs }),
      inputAllowed: () => mobileInputAllowed(deps.config()),
      requests: () => {
        const ctx = front()
        return ctx ? ctx.requestsNow().requests : []
      },
      servers: async () => {
        const ctx = front()
        if (!ctx || !ctx.serverStatus) return []
        return (await ctx.serverStatus().catch(() => ({ servers: [] }))).servers
      },
      events: async () => {
        const ctx = front()
        const events = await eventsModule(ctx && ctx.athenaDir)
        return ctx && ctx.athenaDir && events && typeof events.readEvents === 'function' ? events.readEvents(ctx.athenaDir) : []
      },
      answerRequest: async (id, answer) => {
        const ctx = front()
        if (!ctx) return { ok: false, error: 'no-window' }
        return (await ctx.answerRequest(id, answer, 'mobile')) as AnswerResult
      },
      leadPaneOf: (plan) => {
        const ctx = front()
        return ctx && ctx.athenaDir ? readLeadPane(ctx.athenaDir, plan) : null
      },
      postDecision: async (body) => {
        const ctx = front()
        const token = ctx && ctx.athenaDir ? await deps.boardToken(ctx.athenaDir) : null
        if (!ctx || !token) return { status: 503, body: { ok: false, error: 'board-unavailable' } }
        return boardActionPoster({ port: ctx.boardPortNow(), token })(body)
      },
      logEvent,
    })
  let macKey: KeyPair | null = null
  const relay = createMobileRelay({
    url: deps.options.url,
    login: { provider: 'dev', account: deps.options.account },
    dir: deps.options.dir,
    log,
    createBridge: (transport) => makeBridge(transport),
    onSessionOpen: (peer, send) => {
      lan.dropPeer(peer)
      send(lan.info())
    },
    onPeersChanged: () => lan.dropRemoved(),
  })
  const lan = createMobileLan({
    port: lanPortOf(deps.config()),
    macKey: () => macKey,
    peerOfKey: (publicKey) => relay.peerOfKey(publicKey),
    peerAllowed: (peer) => relay.peers().includes(peer),
    createBridge: (transport) => makeBridge(transport, DIRECT_FLUSH_MS),
    onDirectOpen: (peer) => relay.pauseSession(peer),
    onAddressesChanged: (info) => relay.broadcast(info),
    macId: () => relay.status().deviceId,
    log,
  })
  const stopWatch = watchPairAnswers(relay, deps.options.dir)
  log(`[mobile-relay] 개발용 길 켬 — 상태 폴더 ${deps.options.dir} · 허용은 node scripts/mobile-pair.js --home <집> accept`)
  let stopped = false
  // relay 가 맥 열쇠를 만들고(처음이면) 나서 직접 길을 연다 — 같은 열쇠 파일을 읽는다
  void relay.start().then(() => {
    if (stopped) return
    macKey = loadMacKey(deps.options.dir)
    return lan.start()
  })
  return {
    relay,
    lan,
    async stop() {
      stopped = true
      stopWatch()
      await Promise.all([relay.stop(), lan.stop()])
    },
  }
}
