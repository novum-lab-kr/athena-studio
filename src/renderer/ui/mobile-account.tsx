// 팩 레일 맨 아래 프로필 — 모바일 로그인 · 계정 메뉴 · 디바이스 연결 창 · 새 디바이스 [허용] 창
// 계획서 plans/feature/20261110-아테나-모바일-앱.md 4-8(시험 3). main 의 모바일 개발용 길(src/main/mobile-dev.mts)이 켜졌을 때만 보인다(꺼져 있으면 { enabled: false } — 아무것도 그리지 않는다).
// 로그인은 브라우저에서(앱에는 로그인 창이 없다) · 인증번호는 맥이 앱 난수를 받은 뒤에만 온다(4-7 "인증번호 미리 약속 v1") — 화면은 받은 것을 보이기만 한다.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createStore, say as sayNow, showToast, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

const state = createStore<MobileState>({ enabled: false })
type Dialog = 'none' | 'devices'
const dialog = createStore<Dialog>('none')

let listening = false
// 켤 때 한 번 — 지금 상태를 받고 바뀌면 다시 받는다. 로그인 실패 · 세션 끝은 알림으로
function listen(): void {
  if (listening) return
  listening = true
  studio.onMobileState((next) => state.set(next))
  studio.onMobileFailed((why) => showToast(sayNow(`mobile.failed.${why}`), 'error'))
  void studio.mobileState().then((next) => state.set(next))
}

const ICONS = {
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  devices: 'M9 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  close: 'M6 6l12 12M18 6L6 18',
}
const Icon = ({ path, className }: { path: string; className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} />
  </svg>
)

// 이름 첫 글자(한글 · 영문 모두 한 글자) — 이름이 없으면 null(사람 그림)
const initialOf = (name: string | null): string | null => (name ? (Array.from(name.trim())[0] || '').toUpperCase() || null : null)
const deviceName = (say: Say, label: string | null): string => label || say('mobile.device.unknown')

export function MobileAccount() {
  const mobile = useStore(state)
  const say = useSay()
  const [menuOpen, setMenuOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(listen, [])
  const signedIn = mobile.enabled && mobile.signedIn
  useEffect(() => setMenuOpen(false), [signedIn]) // 로그인 중 메뉴를 열어 둔 채 로그인이 끝나면 계정 메뉴로 바로 바뀌지 않게
  if (!mobile.enabled) return null
  const hasMenu = mobile.signedIn || mobile.signingIn
  const showMenu = menuOpen && hasMenu // 로그아웃 · 로그인 취소로 바뀌면 메뉴는 닫힌 것으로
  const initial = initialOf(mobile.name)
  let tip = say('mobile.account.signIn')
  if (mobile.signingIn) tip = say('mobile.account.signingIn')
  else if (mobile.signedIn) tip = mobile.name || say('mobile.account.title')
  const onClick = () => {
    if (hasMenu) setMenuOpen(!showMenu) // 로그인 중이면 다시 열기 · 취소 메뉴
    else void studio.mobileLogin()
  }
  const closeMenu = () => setMenuOpen(false)
  let menu: ReactNode = null
  if (showMenu && button.current) {
    menu = mobile.signedIn ? <AccountMenu anchor={button.current} mobile={mobile} close={closeMenu} /> : <SigningMenu anchor={button.current} mobile={mobile} close={closeMenu} />
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`mobile-account${mobile.signingIn ? ' loading' : ''}${showMenu ? ' open' : ''}`}
        data-tip={showMenu ? undefined : tip}
        aria-label={tip}
        aria-haspopup={hasMenu ? 'menu' : undefined}
        aria-expanded={hasMenu ? showMenu : undefined}
        onClick={onClick}
      >
        <span className={`mobile-avatar${initial && mobile.signedIn ? '' : ' out'}`}>{initial && mobile.signedIn ? initial : <Icon path={ICONS.person} />}</span>
      </button>
      {menu ? createPortal(menu, document.body) : null}
      {createPortal(<MobileDialogs mobile={mobile} />, document.body)}
    </>
  )
}

type EnabledState = Extract<MobileState, { enabled: true }>

// 프로필 오른쪽으로 펼치는 메뉴 껍데기 — 바깥을 누르거나 Esc 면 닫는다
function PopMenu({ anchor, close, wide, children }: { anchor: HTMLElement; close: () => void; wide?: boolean; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !anchor.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        close()
        anchor.focus()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, close])
  const rect = anchor.getBoundingClientRect()
  return (
    <div ref={menu} className={`work-pop mobile-menu${wide ? ' wide' : ''}`} role="menu" style={{ left: rect.right + 10, bottom: window.innerHeight - rect.bottom }}>
      {children}
    </div>
  )
}

// 1초마다 지금 시각 — 남은 시간 표시용(켜져 있을 때만 돈다)
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

// 로그인 중 프로필 메뉴 — 기다리는 것 · 남은 시간 / 로그인 페이지 다시 열기 · 취소(맥이 기다리기만 멈춘다)
function SigningMenu({ anchor, mobile, close }: { anchor: HTMLElement; mobile: EnabledState; close: () => void }) {
  const say = useSay()
  const now = useNow(true)
  const pick = (work: () => void) => () => {
    close()
    work()
  }
  return (
    <PopMenu anchor={anchor} close={close} wide>
      <div className="mobile-menu-head">
        <span className="mobile-menu-name">{say('mobile.account.signingIn')}</span>
        {mobile.signingUntil ? <span className="mobile-menu-sub">{say('mobile.signing.wait', { time: remaining(mobile.signingUntil, now) })}</span> : null}
      </div>
      <div className="mobile-menu-sep" />
      <button type="button" role="menuitem" className="mobile-menu-item" onClick={pick(() => void studio.mobileLogin())}>
        <Icon path={ICONS.external} />
        {say('mobile.signing.reopen')}
      </button>
      <button type="button" role="menuitem" className="mobile-menu-item" onClick={pick(() => void studio.mobileCancelLogin())}>
        <Icon path={ICONS.close} />
        {say('common.cancel')}
      </button>
    </PopMenu>
  )
}

// 로그인 뒤 프로필 메뉴 — 이름 · 연결 수 / 디바이스 연결 · 계정 관리 ↗ / 로그아웃
function AccountMenu({ anchor, mobile, close }: { anchor: HTMLElement; mobile: EnabledState; close: () => void }) {
  const say = useSay()
  const pick = (work: () => void) => () => {
    close()
    work()
  }
  return (
    <PopMenu anchor={anchor} close={close}>
      <div className="mobile-menu-head">
        <span className="mobile-menu-name">{mobile.name || say('mobile.account.title')}</span>
        <span className="mobile-menu-sub">{mobile.connected ? say('mobile.account.devices', { count: mobile.devices.length }) : say('mobile.account.offline')}</span>
      </div>
      <div className="mobile-menu-sep" />
      <button type="button" role="menuitem" className="mobile-menu-item" onClick={pick(() => dialog.set('devices'))}>
        <Icon path={ICONS.devices} />
        {say('mobile.menu.devices')}
      </button>
      <button type="button" role="menuitem" className="mobile-menu-item" data-tip={say('mobile.menu.accountTip')} onClick={pick(() => void studio.mobileOpenAccount())}>
        <Icon path={ICONS.person} />
        {say('mobile.menu.account')}
        <Icon className="mobile-menu-ext" path={ICONS.external} />
      </button>
      <div className="mobile-menu-sep" />
      <button type="button" role="menuitem" className="mobile-menu-item" onClick={pick(() => void studio.mobileLogout())}>
        <Icon path={ICONS.logout} />
        {say('mobile.menu.signOut')}
      </button>
    </PopMenu>
  )
}

// 대화 창 — 새 디바이스 [허용] 창이 먼저(디바이스 창이 떠 있어도 위에) · 로그아웃이면 둘 다 닫는다
function MobileDialogs({ mobile }: { mobile: EnabledState }) {
  const open = useStore(dialog)
  const now = useNow(mobile.pending.length > 0)
  const live = mobile.pending.filter((request) => Date.parse(request.expiresAt) > now)
  const request = live[0] || null
  useEffect(() => {
    if (!mobile.signedIn) dialog.set('none')
  }, [mobile.signedIn])
  if (!mobile.signedIn) return null
  if (request) return <PairDialog key={request.requestId} request={request} account={mobile.name} now={now} />
  if (open === 'devices') return <DevicesDialog mobile={mobile} close={() => dialog.set('none')} />
  return null
}

function Overlay({ title, labelId, children, onEscape, small }: { title: string; labelId: string; children: ReactNode; onEscape?: () => void; small?: boolean }) {
  const say = useSay()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    box.current?.focus()
    return () => {
      if (before && document.contains(before)) before.focus()
    }
  }, [])
  return (
    <div
      className="pack-overlay mobile-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && onEscape) {
          event.stopPropagation()
          onEscape()
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && onEscape) onEscape()
      }}
    >
      <div ref={box} className={`pack-box${small ? ' mobile-small' : ''}`} tabIndex={-1}>
        <h2 id={labelId}>{title}</h2>
        {onEscape ? (
          <button className="pack-close" type="button" aria-label={say('common.close')} onClick={onEscape}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        ) : null}
        {children}
      </div>
    </div>
  )
}

// 마지막 접속 — 같은 날이면 시:분, 아니면 월 · 일 시:분(이 컴퓨터 지역 형식)
function lastSeenText(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  const sameDay = when.toDateString() === new Date().toDateString()
  return when.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// [디바이스 연결] — 이 맥 · 연결된 디바이스(해제는 그 줄에서 한 번 묻는다) · 비었으면 폰에서 연결하는 순서
// 아래 "권한 · 모든 디바이스" 구획 — 디바이스에서 입력 허용(앱 설정 mobileInput · 기본 꺼짐 · 모든 디바이스에 함께 걸린다)
function DevicesDialog({ mobile, close }: { mobile: EnabledState; close: () => void }) {
  const say = useSay()
  const [input, setInput] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null) // [해제] 를 누른 디바이스 — 그 줄이 "끊을까요?" 로 바뀐다
  useEffect(() => {
    void studio.mobileInput().then((reply) => setInput(reply.allowed))
  }, [])
  const remove = async (peer: string) => {
    setBusy(peer)
    const reply = await studio.mobileRemoveDevice(peer)
    setBusy(null)
    setAsking(null)
    if (!reply.ok) showToast(say('mobile.devices.removeFailed'), 'error')
  }
  const toggle = async () => {
    if (input === null) return
    const reply = await studio.mobileSetInput(!input)
    setInput(reply.allowed)
  }
  const row = (device: MobileDevice) => {
    const name = deviceName(say, device.label)
    if (asking === device.peer) {
      return (
        <div key={device.peer} className="mobile-device">
          <span className="mobile-device-name">{say('mobile.devices.removeAsk', { device: name })}</span>
          <button type="button" className="settings-app-button" autoFocus disabled={busy === device.peer} onClick={() => setAsking(null)}>
            {say('common.cancel')}
          </button>
          <button type="button" className="settings-app-button danger" disabled={busy === device.peer} onClick={() => void remove(device.peer)}>
            {say('mobile.devices.remove')}
          </button>
        </div>
      )
    }
    let when = say('mobile.devices.never')
    if (device.online) when = say('mobile.devices.online')
    else if (device.lastSeen) when = say('mobile.devices.lastSeen', { when: lastSeenText(device.lastSeen) })
    return (
      <div key={device.peer} className="mobile-device">
        <span className={`mobile-dot${device.online ? ' on' : ''}`} aria-hidden="true" />
        <span className="mobile-device-name">{name}</span>
        <span className={`mobile-device-when${device.online ? ' on' : ''}`}>{when}</span>
        <button type="button" className="settings-app-button" onClick={() => setAsking(device.peer)}>
          {say('mobile.devices.remove')}
        </button>
      </div>
    )
  }
  return (
    <Overlay title={say('mobile.devices.title')} labelId="mobile-devices-title" onEscape={close} small>
      <div className="pack-body">
        {/* 구획은 굵은 글씨 대신 안쪽 박스로 나눈다(사용자 지적 · 2026-11-12) */}
        <p className="mobile-sub">{say('mobile.devices.list')}</p>
        <div className="mobile-group">
          {mobile.devices.length ? (
            mobile.devices.map(row)
          ) : (
            <>
              <p className="mobile-empty">{say('mobile.devices.empty')}</p>
              <ol className="mobile-steps">
                <li>{mobile.name ? say('mobile.devices.step1Account', { account: mobile.name }) : say('mobile.devices.step1')}</li>
                <li>{say('mobile.devices.step2')}</li>
                <li>{say('mobile.devices.step3')}</li>
              </ol>
            </>
          )}
        </div>
        <p className="mobile-sub">{say('mobile.devices.permissions')}</p>
        <div className="mobile-group">
          <button type="button" className="settings-switch" role="switch" aria-checked={input === true} disabled={input === null} onClick={() => void toggle()}>
            <span className="settings-switch-label">{say('mobile.devices.input')}</span>
            <span className="settings-switch-track" />
          </button>
          <p className="settings-note">{say('mobile.devices.inputNote')}</p>
        </div>
      </div>
    </Overlay>
  )
}

const remaining = (expiresAt: string, now: number): string => {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// 새 디바이스 연결 — 닫기 단추 없음(허용 · 거절로만) · 번호는 디바이스 화면과 같은지 사람이 본다
function PairDialog({ request, account, now }: { request: MobilePending; account: string | null; now: number }) {
  const say = useSay()
  const [busy, setBusy] = useState(false)
  const answer = async (accept: boolean) => {
    setBusy(true)
    const reply = await studio.mobileAnswer(request.requestId, accept)
    setBusy(false)
    if (!reply.ok) showToast(say(accept ? 'mobile.pair.acceptFailed' : 'mobile.pair.rejectFailed'), 'error')
  }
  const device = deviceName(say, request.label)
  return (
    <Overlay title={say('mobile.pair.title')} labelId="mobile-pair-title">
      <div className="pack-body">
        <p>{say('mobile.pair.from', { device })}</p>
        <p className="muted mobile-pair-lead">{say('mobile.pair.check')}</p>
        <div className="mobile-code" aria-label={request.code.split('').join(' ')}>
          {request.code.slice(0, 3)}
          <span />
          {request.code.slice(3)}
        </div>
        <div className="mobile-meta">
          <span>{account ? say('mobile.pair.account', { account }) : null}</span>
          <span>{say('mobile.pair.left', { time: remaining(request.expiresAt, now) })}</span>
        </div>
      </div>
      <div className="pack-actions">
        <button type="button" className="pack-button danger" disabled={busy} onClick={() => void answer(false)}>
          {say('mobile.pair.reject')}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void answer(true)}>
          {say('mobile.pair.accept')}
        </button>
      </div>
    </Overlay>
  )
}
