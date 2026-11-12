// ── 맥 웹 로그인 — 앱 창 없이 브라우저로(Cursor 식 · PKCE S256) ──
// 바깥 계약: athena-app relay/docs/protocol.md "웹 로그인 (맥 · HTTP)". 계획서 4-8.
// 맥이 verifier 를 들고 브라우저에는 challenge · state 만 → 완료 페이지가 athena://login?code&state 를 열거나(open-url)
// 2초마다 상태 조회가 done 이 되면 → 먼저 온 쪽으로 한 번만 코드 + verifier 를 토큰으로 바꾼다.
// electron 을 import 하지 않는다 — 브라우저 열기 · fetch 는 부르는 쪽이 넘긴다.
// 로그에는 단계 · HTTP 상태 · 오류 코드만(verifier · state · code · 토큰은 남기지 않는다).
import crypto from 'node:crypto'
import type { SignInResult } from './mobile-relay.mts'

export const LOGIN_TTL_MS = 10 * 60_000 // relay 로그인 시도 10분
export const STATUS_POLL_MS = 2000 // 상태 조회 간격(계약 추천)
const CODE_RE = /^[A-Za-z0-9_-]{43}$/
const STATE_RE = /^[A-Za-z0-9_-]{22,64}$/
const DEVICE_MAX = 64 // relay /login device 칸 — 1~64자(UTF-16 단위) · 제어 · 서식 문자 없음

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>
export type LoginFailure = 'expired' | 'invalid_grant' | 'device_limit' | 'busy' | 'network' | 'bad_reply'

type LoginDeps = {
  base: string // relay 바탕 주소(http(s)://호스트:포트) — /ws 와 같은 곳
  fetch: FetchLike
  openBrowser: (url: string) => unknown
  onSignedIn: (result: SignInResult) => void
  onFailed: (why: LoginFailure) => void
  onChange?: () => void
  deviceName?: () => string | null // 로그인 페이지가 "<맥 이름>에서 시작한 로그인" 으로 보일 이름(피싱 대책 · 없으면 칸을 빼고 보낸다)
  log?: (line: string) => void
  now?: () => number
  pollMs?: number
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url')

// PKCE 짝 — verifier 32B 난수 base64url(43자) · challenge = base64url(SHA-256(verifier ASCII)) · state 32B 난수
export function newLoginSecrets(random: (size: number) => Buffer = crypto.randomBytes) {
  const verifier = base64url(random(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest())
  const state = base64url(random(32))
  return { verifier, challenge, state }
}

// relay ws 주소 → 웹 바탕 주소. ws → http · wss → https · 경로 /ws 는 뗀다
export function relayWebBase(wsUrl: string): string | null {
  let url: URL
  try {
    url = new URL(wsUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
  const scheme = url.protocol === 'wss:' ? 'https:' : 'http:'
  const pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '')
  return `${scheme}//${url.host}${pathname}`
}

// 맥 이름 → /login device 칸 값. 제어 · 서식 문자를 빼고 앞뒤 공백을 걷은 뒤 64자로 자른다(서로게이트 짝은 가르지 않는다) · 남는 것이 없으면 null
export function loginDeviceName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  let cut = ''
  for (const char of clean) {
    if (cut.length + char.length > DEVICE_MAX) break
    cut += char
  }
  cut = cut.trim()
  return cut || null
}

// athena://login?code=…&state=… — 모양이 맞는 것만. 그 밖의 athena:// 는 null
export function parseLoginLink(link: unknown): { code: string; state: string } | null {
  if (typeof link !== 'string' || link.length > 512) return null
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  // athena://login 은 host 가 login(경로 없음)
  if (url.protocol !== 'athena:' || url.hostname !== 'login' || (url.pathname && url.pathname !== '/')) return null
  const code = url.searchParams.get('code') || ''
  const state = url.searchParams.get('state') || ''
  return CODE_RE.test(code) && STATE_RE.test(state) ? { code, state } : null
}

// 로그에 남길 athena:// 모양 — 값 없이 자리 · 칸 이름만
export function describeLink(link: unknown): string {
  try {
    const url = new URL(String(link))
    return `${url.protocol}//${url.hostname}${url.pathname} 칸 ${[...url.searchParams.keys()].join(',') || '없음'}`
  } catch {
    return '읽지 못한 주소'
  }
}

type Attempt = { verifier: string; challenge: string; state: string; startedAt: number; exchanging: boolean }

export function createLoginFlow(deps: LoginDeps) {
  const log = deps.log || ((line: string) => console.log(line))
  const now = deps.now || Date.now
  const pollMs = deps.pollMs ?? STATUS_POLL_MS
  let attempt: Attempt | null = null
  let timer: NodeJS.Timeout | null = null
  const changed = () => deps.onChange && deps.onChange()

  const loginUrl = (own: Attempt) => {
    const query = new URLSearchParams({ challenge: own.challenge, state: own.state })
    const device = loginDeviceName(deps.deviceName ? deps.deviceName() : null)
    if (device) query.set('device', device)
    return `${deps.base}/login?${query}`
  }

  function finish() {
    attempt = null
    if (timer) clearTimeout(timer)
    timer = null
    changed()
  }

  function fail(own: Attempt, why: LoginFailure) {
    if (attempt !== own) return
    finish()
    log(`[mobile-login] 로그인 실패 ${why}`)
    deps.onFailed(why)
  }

  // 코드 하나로 한 번만 — 교환 중이면 뒤에 온 것은 버린다
  async function exchange(own: Attempt, code: string) {
    if (attempt !== own || own.exchanging) return
    own.exchanging = true
    let reply: { status: number; json(): Promise<unknown> }
    try {
      reply = await deps.fetch(`${deps.base}/api/login/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, verifier: own.verifier, state: own.state, kind: 'mac' }),
      })
    } catch {
      return fail(own, 'network')
    }
    const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null
    if (reply.status !== 200 || !body) {
      const code = body && typeof body.code === 'string' ? body.code : ''
      log(`[mobile-login] 토큰 교환 HTTP ${reply.status} ${code}`)
      return fail(own, code === 'invalid_grant' || code === 'device_limit' || code === 'busy' ? code : 'bad_reply')
    }
    const profile = (body.profile && typeof body.profile === 'object' ? body.profile : {}) as Record<string, unknown>
    const result: SignInResult = {
      token: typeof body.token === 'string' ? body.token : '',
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : '',
      account: typeof body.account === 'string' ? body.account : '',
      name: typeof profile.name === 'string' ? profile.name : typeof profile.email === 'string' ? profile.email : null,
    }
    if (!result.token || !result.deviceId || !result.account) return fail(own, 'bad_reply')
    if (attempt !== own) return
    finish()
    log('[mobile-login] 로그인 됨')
    deps.onSignedIn(result)
  }

  async function poll(own: Attempt) {
    timer = null
    if (attempt !== own || own.exchanging) return
    if (now() - own.startedAt > LOGIN_TTL_MS) return fail(own, 'expired')
    try {
      const reply = await deps.fetch(`${deps.base}/api/login/status?${new URLSearchParams({ state: own.state })}`)
      const body = (await reply.json().catch(() => null)) as Record<string, unknown> | null
      if (attempt !== own) return
      if (reply.status === 404) return fail(own, 'expired') // 없는 · 지난 · 이미 쓴 state — 처음부터
      if (reply.status === 200 && body && body.status === 'done' && typeof body.code === 'string' && CODE_RE.test(body.code)) return void exchange(own, body.code)
    } catch {
      // 잠깐 못 닿음 — 10분 안에서 계속 묻는다
    }
    if (attempt === own && !own.exchanging) timer = setTimeout(() => void poll(own), pollMs)
  }

  return {
    // 프로필을 누름 — 로그인 중이면 같은 challenge · state 로 다시 연다(10분 안), 아니면 새로 시작
    start() {
      if (attempt && now() - attempt.startedAt <= LOGIN_TTL_MS) {
        deps.openBrowser(loginUrl(attempt))
        return
      }
      if (attempt) finish()
      const own: Attempt = { ...newLoginSecrets(), startedAt: now(), exchanging: false }
      attempt = own
      deps.openBrowser(loginUrl(own))
      log('[mobile-login] 브라우저로 로그인 시작')
      changed()
      timer = setTimeout(() => void poll(own), pollMs)
    },
    // athena://login 받음 — 지금 기다리는 state 와 같을 때만
    handleLink(link: unknown): boolean {
      const parsed = parseLoginLink(link)
      if (!parsed || !attempt || parsed.state !== attempt.state) {
        log(`[mobile-login] athena:// 버림 — ${describeLink(link)}`)
        return false
      }
      void exchange(attempt, parsed.code)
      return true
    },
    cancel() {
      if (attempt) finish()
    },
    pending: () => Boolean(attempt),
  }
}
