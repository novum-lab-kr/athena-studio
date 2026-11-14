// ── 모바일 개발용 길 — 개발판에서만 relay 에 붙고 짝 기기마다 브리지를 둔다 ──
// 계획서 plans/feature/20261110-아테나-모바일-앱.md 4-7 · 4-8(시험 3). 브리지는 여전히 기본 꺼짐 — 이 길이 켜질 때만 팩 레일 프로필 · [허용] 창이 보인다.
// 켜지는 조건(둘 다): 개발판(배포판 아님) · ATHENA_STUDIO_MOBILE_RELAY 가 허용 주소(루프백 ws 또는 운영 RELEASE_RELAY 정확히 — allowedRelay).
// 격리 집(ATHENA_STUDIO_HOME)은 없어도 된다 — 없으면 진짜 스튜디오 집(~/.athena-studio)에서 켠다(2026-11-12 결정 · 폰 실제 데이터 시험).
// 로그인은 웹(mobile-login.mts — relay 를 RELAY_DEV_LOGIN=1 로 띄우면 로그인 페이지에 개발 계정 칸) · 연결 허용은 맥 [허용] 창.
// 열쇠 · 세션 토큰은 <스튜디오 집>/mobile/ 아래 0600 파일에만(mobile-relay.mts) — 로그에 남기지 않는다.
// 직접 길(mobile-lan.mts — 같은 Wi-Fi · Tailscale)도 같은 조건에서만 켠다. 한 기기는 한 번에 한 길 — 직접이 붙으면 그 기기 relay 세션은 쉬고,
// relay 로 hello 가 오면 직접 연결을 닫는다(마지막 hello 가 이긴다). 받는 주소는 relay 세션 안 lan.info 로 알린다.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import * as core from '../lib/core.mts'
import * as packModel from '../lib/pack.mts'
import { createIconTokens } from './mobile-look.mts'
import { createMobileBridge, createMergeDetails, createPaneControl, mobileInputAllowed, readLeadPane, boardActionPoster } from './mobile-bridge.mts'
import type { MergeRunner } from './mobile-bridge.mts'
import type { EventRow, LogEvent, RequestAnswer, AnswerResult, PackView, PackResultLike, RepoChanges, RepoSettings, LookSource } from './mobile-bridge.mts'
import { setMergeFromScreen } from './pack-repos.mts'
import { noMobileWork, createWorkWatch } from '../lib/work-model.mts'
import type { MobileWork } from '../lib/work-model.mts'
import { createMobileRelay, loadMacKey } from './mobile-relay.mts'
import type { PendingPair, PeerView } from './mobile-relay.mts'
import { createMobileLan, lanPortOf, DIRECT_FLUSH_MS } from './mobile-lan.mts'
import type { KeyPair } from '../lib/mobile-crypto.mts'
import { createLoginFlow, relayWebBase } from './mobile-login.mts'
import type { FetchLike, LoginFailure } from './mobile-login.mts'
import { mobileLog } from './mobile-log.mts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
// 운영 relay — 경로는 athena-app relay/src/server.ts WS_PATH('/ws' · WebSocketServer path) · 호스트는 relay/deploy/relay.caddy
export const RELEASE_RELAY = 'wss://relay.athena.novum-lab.com/ws'

// 조건이 빠졌을 때 맥 로그(화면 문구 아님 — 개발판 전용)
export const MOBILE_DEV_SKIPPED = '[mobile-relay] 개발용 길을 켜지 않아요 — 개발판 · 허용한 relay 주소(루프백 ws 또는 운영 relay)가 모두 있어야 해요'

// 붙어도 되는 relay 주소인지 — 루프백 ws(포트 아무거나) 또는 RELEASE_RELAY 와 칸마다 정확히 같은 것만(문자열 앞부분 비교 X).
// 운영 주소는 계정 · 비밀번호 · 포트 · 쿼리 · 조각이 하나라도 붙으면 거절한다 — env 하나로 세션 토큰이 남의 서버로 가지 않게
export function allowedRelay(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname)) return url
  const release = new URL(RELEASE_RELAY)
  const same =
    url.protocol === release.protocol &&
    url.hostname === release.hostname &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === release.pathname &&
    url.search === '' &&
    url.hash === ''
  return same ? url : null
}

export type MobileDevOptions = { url: string; base: string; dir: string }

// 켜도 되는지 · 무엇으로 — 조건이 하나라도 빠지면 null(아무것도 만들지 않는다)
// home = 스튜디오 집(main 의 STUDIO.root — ATHENA_STUDIO_HOME 을 줬으면 그 격리 집 · 아니면 ~/.athena-studio)
export function mobileDevOptions({ env, packaged, home }: { env: NodeJS.ProcessEnv; packaged: boolean; home: string }): MobileDevOptions | null {
  const raw = env.ATHENA_STUDIO_MOBILE_RELAY
  if (packaged || !home || !raw) return null
  const url = allowedRelay(raw)
  if (!url) return null
  const base = relayWebBase(url.href)
  return base ? { url: url.href, base, dir: mobileStateDir(home) } : null
}

// 상태 폴더 — 스튜디오 집 아래(격리 집이면 그 아래)
export const mobileStateDir = (home: string) => path.join(path.resolve(home), 'mobile')

// main 이 넘기는 것 — 지금 앞에 있는 팩 창의 문맥(본체 · 요청 · 현황판)과 앱 설정
type FrontCtx = {
  athenaDir: string | null
  requestsNow(): { requests: unknown[] }
  workPeek(options?: { launch?: boolean }): Promise<MobileWork>
  answerRequest(id: string, answer: RequestAnswer, by: 'mobile'): Promise<unknown>
  approveRequest(id: string, generation: string, choice: number): Promise<unknown>
  boardPortNow(): number
  serverStatus?: () => Promise<{ servers: unknown[]; history?: Record<string, unknown[]>; sar?: Record<string, unknown[]> }>
  packState: { current?: { id?: unknown } | null; packs?: unknown }
  mergeSettings(): Promise<unknown>
  setAutoMerge(repo: string, values: RepoChanges): Promise<unknown>
  packOpen(id: string): Promise<unknown>
  // 맥 사이드바 이름 · 이미지(pack-repos.mts packRepos · server-status.mts serverList) — 없으면 빈 값
  packRepos?: () => Promise<{ name: string; displayName?: unknown; iconPath?: unknown }[]>
  serverList?: () => Promise<{ name: string }[]>
}

// 폰 스페이스 · 팩 이미지 원천 — 사이드바와 같은 packRepos · serverList · 팩 이미지는 마지막 pack list 의 iconPath(packModel.packIconPath — 화면 ctx.packIcon 과 같은 자리)
export async function lookSource(ctx: Pick<FrontCtx, 'packState' | 'packRepos' | 'serverList'> | null): Promise<LookSource> {
  if (!ctx) return { repos: [], servers: [], packIcons: {} }
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
  const [repos, servers] = await Promise.all([ctx.packRepos ? ctx.packRepos().catch(() => []) : [], ctx.serverList ? ctx.serverList().catch(() => []) : []])
  const packIcons: Record<string, string | null> = {}
  for (const pack of packView(ctx.packState).packs) packIcons[pack.id] = packModel.packIconPath(ctx.packState, pack.id)
  return {
    repos: repos.filter((repo) => Boolean(repo) && typeof repo.name === 'string').map((repo) => ({ name: repo.name, displayName: text(repo.displayName), iconPath: text(repo.iconPath) })),
    servers: servers.map((server) => (server && typeof server.name === 'string' ? server.name : '')).filter(Boolean),
    packIcons,
  }
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
  onPhoneControl: (pane: string) => void // 맥 → 폰으로 제어가 넘어감(D9) — 그 pane 을 보는 맥 창에 잠깐 알림
  log?: (line: string) => void
}

// 본체 실제 경로 → 팩 id — 데몬 작업 공간의 body(앱이 realDir 로 묶은 본체)와 견준다
export function bodyPacks(state: FrontCtx['packState'] | null): Record<string, string> {
  const packs = state && Array.isArray(state.packs) ? (state.packs as { id?: unknown; body?: unknown }[]) : []
  const found: Record<string, string> = {}
  for (const pack of packs) {
    if (!pack || typeof pack.id !== 'string' || !pack.id || typeof pack.body !== 'string' || !pack.body) continue
    let body = path.resolve(pack.body)
    try {
      body = fs.realpathSync(body)
    } catch {}
    found[body] = pack.id
  }
  return found
}

// 서버 상세 칸 — snapshot 의 servers 에는 넣지 않는다(크다 · 서버 화면을 열 때 server.detail 로)
const DETAIL_KEYS = ['ports', 'cpuModel', 'serviceInfo', 'timers', 'cron', 'ufw', 'monarx', 'sites']
export function serverSummary(reading: unknown): unknown {
  if (!reading || typeof reading !== 'object') return reading
  const status = (reading as { status?: unknown }).status
  if (!status || typeof status !== 'object') return reading
  const light = { ...(status as Record<string, unknown>) }
  for (const key of DETAIL_KEYS) delete light[key]
  return { ...(reading as object), status: light }
}

// 머지 상세 읽기 — 셸 없이 인자로만 · 20초 · 실패는 null(gh 로그인 안 됨 · 커밋 없음 등)
const runMergeCommand: MergeRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, env: core.childEnv(process.env), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout))
  })

// 화면(팩 레일 프로필 · 메뉴 · 디바이스 창 · [허용] 창)에 넘기는 것 — 토큰 · 열쇠 · 계정 id 는 넣지 않는다
export type MobileView = {
  enabled: true
  signedIn: boolean
  signingIn: boolean
  signingUntil: string | null // 로그인 시도가 끝나는 시각(ISO) — 로그인 중일 때만
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
  const log = deps.log || mobileLog
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
    createBridge: (transport) => newBridge(transport),
    onSessionOpen: (peer, send) => {
      lan.dropPeer(peer)
      send(lan.info())
    },
    onPeersChanged: () => lan.dropRemoved(),
  })
  // 제어 주인(D9) — 기기(브리지)끼리 · main 의 맥 입력 · 크기 요청과 같이 본다
  const control = createPaneControl({ onPhoneTook: (pane) => deps.onPhoneControl(pane) })
  // 머지는 바뀌지 않으니 상세는 기기끼리 같이 쓴다(앞 창 본체가 바뀌면 키 — 레포#PR — 가 같아도 다른 레포일 수 있어 본체마다 따로)
  const mergeCaches = new Map<string, ReturnType<typeof createMergeDetails>>()
  // 팩 · 레포 이미지 토큰 — 기기끼리 같이 쓴다(같은 파일은 한 번만 읽는다)
  const iconTokens = createIconTokens()
  const mergeDetails = () => {
    const dir = front()?.athenaDir || ''
    let cache = mergeCaches.get(dir)
    if (!cache) {
      cache = createMergeDetails({ athenaDir: () => dir || null, run: runMergeCommand })
      mergeCaches.set(dir, cache)
    }
    return cache
  }
  // 작업 목록 실시간 갱신 — 폰이 붙어 있는 동안만 앞 창 현황판을 띄우지 않고 주기로 읽어 달라졌을 때만 changed ['work'](work-model createWorkWatch)
  const workWatch = createWorkWatch({
    read: async () => {
      const ctx = front()
      return ctx ? ctx.workPeek({ launch: false }) : noMobileWork()
    },
  })
  // 브리지는 두 길이 같다 — 출력 묶음만 길마다(relay 는 mobile-bridge 기본값 · 직접은 DIRECT_FLUSH_MS)
  function newBridge(transport: Parameters<typeof createMobileBridge>[0]['transport'], flushMs?: number) {
    const bridge = (
      createMobileBridge({
        daemonPaths: deps.daemonPaths,
        transport,
        ...(flushMs === undefined ? {} : { flushMs }),
        control,
        inputAllowed: () => mobileInputAllowed(deps.config()),
        requests: () => {
          const ctx = front()
          return ctx ? ctx.requestsNow().requests : []
        },
        // 맥 [작업] 팝업과 같은 목록 — 앞 창의 현황판을 맥처럼 띄워 읽는다(겹침 · 재사용은 work.mts workPeek) · 앞 창이 없으면 빈 값
        work: async () => {
          const ctx = front()
          return ctx ? ctx.workPeek() : noMobileWork()
        },
        servers: async () => {
          const ctx = front()
          if (!ctx || !ctx.serverStatus) return []
          return (await ctx.serverStatus().catch(() => ({ servers: [] }))).servers.map(serverSummary)
        },
        serverDetail: async (name) => {
          const ctx = front()
          if (!ctx || !ctx.serverStatus) return null
          const all = await ctx.serverStatus().catch(() => null)
          const server = all ? all.servers.find((reading) => Boolean(reading) && (reading as { name?: unknown }).name === name) : undefined
          if (!all || !server) return null
          return { server, history: (all.history && all.history[name]) || [], sar: (all.sar && all.sar[name]) || [] }
        },
        bodyPacks: () => {
          const ctx = front()
          return bodyPacks(ctx ? ctx.packState : null)
        },
        look: () => lookSource(front()),
        iconTokens,
        get mergeDetails() {
          return mergeDetails()
        },
        mac: () => ({ name: deps.macName() }),
        devices: () => relay.devices(),
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
      })
    )
    workWatch.add(bridge)
    return {
      ...bridge,
      async stop() {
        workWatch.remove(bridge)
        await bridge.stop()
      },
    }
  }
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
  let macKey: KeyPair | null = null
  const lan = createMobileLan({
    port: lanPortOf(deps.config()),
    macKey: () => macKey,
    peerOfKey: (publicKey) => relay.peerOfKey(publicKey),
    peerAllowed: (peer) => relay.peers().includes(peer),
    createBridge: (transport) => newBridge(transport, DIRECT_FLUSH_MS),
    onDirectOpen: (peer) => relay.pauseSession(peer),
    onAddressesChanged: (info) => relay.broadcast(info),
    macId: () => relay.status().deviceId,
    log,
  })
  log(`[mobile-relay] 개발용 길 켬 — 상태 폴더 ${deps.options.dir}`)
  let stopped = false
  // 저장한 토큰이 있으면 붙는다 · 없으면 로그아웃 상태로 기다린다. relay 가 맥 열쇠를 만들고(처음이면) 나서 직접 길을 연다 — 같은 열쇠 파일을 읽는다
  void relay.start().then(() => {
    if (stopped) return
    macKey = loadMacKey(deps.options.dir)
    return lan.start()
  })
  const view = (): MobileView => {
    const status = relay.status()
    return {
      enabled: true,
      signedIn: status.signedIn,
      signingIn: !status.signedIn && login.pending(),
      signingUntil: status.signedIn ? null : login.until(),
      connected: status.connected,
      name: displayName(status.name, status.account),
      devices: relay.devices(),
      pending: relay.pending(),
      accountUrl: `${deps.options.base}/account`,
    }
  }
  return {
    relay,
    lan,
    view,
    signIn: () => login.start(),
    // 로그인 중 [취소] — 맥이 기다리기만 멈춘다(relay 쪽 시도는 그대로 두면 10분 뒤 저절로 끝난다 · 늦게 온 athena:// 는 state 가 없어 버린다)
    cancelSignIn: () => login.cancel(),
    // 로그아웃 — relay 에 auth.logout 먼저(위 remoteLogout) → 답 · 4004 · 실패와 상관없이 로컬 토큰 · 허용 기기를 지운다
    signOut: async () => {
      login.cancel()
      await relay.signOut()
    },
    handleLink: (link: unknown) => login.handleLink(link),
    // 맥 화면 입력(main pane:input) — 폰이 가진 pane 이면 맥 크기로 되돌린다
    macInput: (pane: string, data: string) => control.macInput(pane, data),
    // 맥 화면 포커스(main pane:focus — pane 누르기 · 창이 앞으로) — 폰이 가진 pane 이면 맥 크기로
    macFocus: (pane: string) => control.macFocus(pane),
    // 맥 화면 크기 요청(main pane:resize) — 폰이 가진 pane 이면 true(데몬에 보내지 않고 기억만 · 부르는 쪽이 받은 것처럼 답한다)
    macResize: (pane: string, cols: number, rows: number) => control.macResize(pane, { cols, rows }),
    // 앞 창의 요청이 바뀌었다(main — work.mts publishRequests) — 붙어 있는 폰에 changed ['requests', 'work']
    requestsChanged: () => workWatch.requestsChanged(),
    openAccount: () => deps.openBrowser(`${deps.options.base}/account`),
    async stop() {
      stopped = true
      login.cancel()
      await Promise.all([relay.stop(), lan.stop()])
    },
  }
}
