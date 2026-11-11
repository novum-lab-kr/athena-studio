// ── 모바일 개발용 길 — 격리 시험 앱에서만 relay 에 붙고 짝 기기마다 브리지를 둔다 ──
// 계획서 plans/feature/20261110-아테나-모바일-앱.md 4-7 · 4-8(시험 3). 브리지는 여전히 기본 꺼짐 — 이 길이 켜질 때만 팩 레일 프로필 · [허용] 창이 보인다.
// 켜지는 조건(셋 다): 개발판(배포판 아님) · ATHENA_STUDIO_HOME(격리 집) · ATHENA_STUDIO_MOBILE_RELAY 가 루프백 ws 주소.
// 로그인은 웹(mobile-login.mts — relay 를 RELAY_DEV_LOGIN=1 로 띄우면 로그인 페이지에 개발 계정 칸) · 연결 허용은 맥 [허용] 창.
// 열쇠 · 세션 토큰은 <집>/mobile/ 아래 0600 파일에만(mobile-relay.mts) — 로그에 남기지 않는다.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMobileBridge, mobileInputAllowed, readLeadPane, boardActionPoster } from './mobile-bridge.mts'
import type { EventRow, LogEvent, RequestAnswer, AnswerResult, PackView, PackResultLike, RepoChanges, RepoSettings } from './mobile-bridge.mts'
import { setMergeFromScreen } from './pack-repos.mts'
import { createMobileRelay } from './mobile-relay.mts'
import type { PendingPair, PeerView } from './mobile-relay.mts'
import { createLoginFlow, relayWebBase } from './mobile-login.mts'
import type { FetchLike, LoginFailure } from './mobile-login.mts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

// 조건이 빠졌을 때 맥 로그(화면 문구 아님 — 개발판 격리 시험 전용)
export const MOBILE_DEV_SKIPPED = '[mobile-relay] 개발용 길을 켜지 않아요 — 개발판 · ATHENA_STUDIO_HOME · 루프백 ws 주소가 모두 있어야 해요'

export type MobileDevOptions = { url: string; base: string; dir: string }

// 켜도 되는지 · 무엇으로 — 조건이 하나라도 빠지면 null(아무것도 만들지 않는다)
export function mobileDevOptions({ env, packaged, homeOverride }: { env: NodeJS.ProcessEnv; packaged: boolean; homeOverride: string | null }): MobileDevOptions | null {
  const raw = env.ATHENA_STUDIO_MOBILE_RELAY
  if (packaged || !homeOverride || !raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(url.hostname)) return null
  const base = relayWebBase(url.href)
  return base ? { url: url.href, base, dir: mobileStateDir(homeOverride) } : null
}

// 상태 폴더 — 격리 집 아래
export const mobileStateDir = (home: string) => path.join(path.resolve(home), 'mobile')

// main 이 넘기는 것 — 지금 앞에 있는 팩 창의 문맥(본체 · 요청 · 현황판)과 앱 설정
type FrontCtx = {
  athenaDir: string | null
  requestsNow(): { requests: unknown[] }
  answerRequest(id: string, answer: RequestAnswer, by: 'mobile'): Promise<unknown>
  approveRequest(id: string, generation: string, choice: number): Promise<unknown>
  boardPortNow(): number
  serverStatus?: () => Promise<{ servers: unknown[] }>
  packState: { current?: { id?: unknown } | null; packs?: unknown }
  mergeSettings(): Promise<unknown>
  setAutoMerge(repo: string, values: RepoChanges): Promise<unknown>
  packOpen(id: string): Promise<unknown>
}

// 팩 목록 — 폰에 넘길 칸만(본체 경로 · 아이콘 파일 경로는 넣지 않는다)
export function packView(state: FrontCtx['packState'] | null): PackView {
  const name = (value: unknown) => (typeof value === 'string' && value ? value : null)
  const packs = state && Array.isArray(state.packs) ? (state.packs as { id?: unknown; name?: unknown; displayName?: unknown }[]) : []
  return {
    current: state && state.current ? name(state.current.id) : null,
    packs: packs.filter((pack) => Boolean(pack) && typeof pack.id === 'string' && pack.id !== '').map((pack) => ({ id: pack.id as string, name: name(pack.name), displayName: name(pack.displayName) })),
  }
}
type DevDeps = {
  options: MobileDevOptions
  daemonPaths: Parameters<typeof createMobileBridge>[0]['daemonPaths']
  frontCtx: () => FrontCtx | null
  config: () => Record<string, unknown> | null
  boardToken: (athenaDir: string) => Promise<string | null>
  openBrowser: (url: string) => unknown
  macName: () => string | null // 사용자에게 보이는 컴퓨터 이름(맥 [공유] 설정) — 웹 로그인 페이지에 보인다
  fetch: FetchLike
  onChange: () => void // 화면에 보일 것이 바뀜(view 다시 보내기)
  onPairRequest: (request: PendingPair) => void // [허용] 창 · 창이 뒤면 맥 알림
  onLoginFailed: (why: LoginFailure | 'expired_session' | 'account_deleted') => void
  log?: (line: string) => void
}

// 화면(팩 레일 프로필 · 메뉴 · 디바이스 창 · [허용] 창)에 넘기는 것 — 토큰 · 열쇠 · 계정 id 는 넣지 않는다
export type MobileView = {
  enabled: true
  signedIn: boolean
  signingIn: boolean
  connected: boolean
  name: string | null
  devices: PeerView[]
  pending: PendingPair[]
  accountUrl: string
}

// 화면 이름 — 공급자가 준 이름 · 이메일, 없으면 개발 계정 이름(dev:<이름>). apple · google 의 sub 은 보이지 않는다
export function displayName(name: string | null, account: string | null): string | null {
  if (name) return name
  return account && account.startsWith('dev:') ? account.slice(4) || null : null
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
  const relay = createMobileRelay({
    url: deps.options.url,
    dir: deps.options.dir,
    log,
    onChange: deps.onChange,
    onPairRequest: deps.onPairRequest,
    onSignedOut: (why) => deps.onLoginFailed(why === 'expired' ? 'expired_session' : 'account_deleted'),
    // 맥 로그아웃 — relay 에서 이 기기 · 토큰 · 쌍 · 연결 요청을 지운다(protocol.md auth.logout {} → {} · 답 뒤 close 4004). 실패해도 로컬은 지운다
    remoteLogout: (call) => call('auth.logout', {}),
    createBridge: (transport) =>
      createMobileBridge({
        daemonPaths: deps.daemonPaths,
        transport,
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
        approveRequest: async (id, generation, choice) => {
          const ctx = front()
          if (!ctx) return { ok: false, error: 'no-window' }
          return (await ctx.approveRequest(id, generation, choice)) as AnswerResult
        },
        athenaDir: () => {
          const ctx = front()
          return ctx ? ctx.athenaDir : null
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
        packs: () => {
          const ctx = front()
          return packView(ctx ? ctx.packState : null)
        },
        repoSettings: async () => {
          const ctx = front()
          return ctx ? ((await ctx.mergeSettings()) as RepoSettings) : { ok: false, repos: [] }
        },
        // ⚙ 설정 팝업(settings:set-merge)과 같은 길 — 값을 한 번 더 추린 뒤 코어 pack set-auto-merge
        setRepo: async (repo, changes) => {
          const ctx = front()
          if (!ctx) return { ok: false, error: 'no-window' }
          return (await setMergeFromScreen({ setAutoMerge: (name, values) => ctx.setAutoMerge(name, values as RepoChanges) }, repo, changes)) as PackResultLike
        },
        openPack: async (id) => {
          const ctx = front()
          if (!ctx) return { ok: false, error: 'no-window' }
          return (await ctx.packOpen(id)) as PackResultLike
        },
        logEvent,
      }),
  })
  const login = createLoginFlow({
    base: deps.options.base,
    fetch: deps.fetch,
    openBrowser: deps.openBrowser,
    onSignedIn: (result) => relay.signIn(result),
    onFailed: (why) => deps.onLoginFailed(why),
    onChange: deps.onChange,
    deviceName: deps.macName,
    log,
  })
  log(`[mobile-relay] 개발용 길 켬 — 상태 폴더 ${deps.options.dir}`)
  void relay.start() // 저장한 토큰이 있으면 붙는다 · 없으면 로그아웃 상태로 기다린다
  const view = (): MobileView => {
    const status = relay.status()
    return {
      enabled: true,
      signedIn: status.signedIn,
      signingIn: !status.signedIn && login.pending(),
      connected: status.connected,
      name: displayName(status.name, status.account),
      devices: relay.devices(),
      pending: relay.pending(),
      accountUrl: `${deps.options.base}/account`,
    }
  }
  return {
    relay,
    view,
    signIn: () => login.start(),
    // 로그아웃 — relay 에 auth.logout 먼저(위 remoteLogout) → 답 · 4004 · 실패와 상관없이 로컬 토큰 · 허용 기기를 지운다
    signOut: async () => {
      login.cancel()
      await relay.signOut()
    },
    handleLink: (link: unknown) => login.handleLink(link),
    openAccount: () => deps.openBrowser(`${deps.options.base}/account`),
    async stop() {
      login.cancel()
      await relay.stop()
    },
  }
}
