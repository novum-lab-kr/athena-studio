// 옆 브라우저 서랍의 [웹 | 시뮬레이터] 전환 · 시뮬레이터 막대(기기 고르기 · 켜기 · 캡처 · 닫기) · 칸(#sim-screen — 안내 글 · Android 화면 그림)
// 서랍 껍데기와 자리 알리기(placeBrowserView)는 바닐라 browser.ts. 명령은 main 이 본체 scripts/sim.mjs 로(src/main/simulator.mts).
// iOS 화면은 main 의 serve-sim 페이지 뷰가 #browser-slot 자리에 그린다(누르기 · 쓸기도 그 페이지) — 여기는 그 뒤에 깔린 안내 글만.
// Android 는 칸이 보일 때만 화면 영상(H.264 — ui/sim-video.ts)을 canvas 에 그리고, 누르기 · 끌기를 비율 좌표로 보낸다.
// 옛 코어(영상 명령 없음) · 영상을 못 풀면 1초마다 화면 그림을 받아 <img> 로 그린다
import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { flushSync } from 'react-dom'
import { createStore, mountIsland, say as sayNow, showToast, useSay, useStore } from './bridge.ts'
import { pickSelected, screenNote } from '../../lib/sim-view.mts'
import { setCanvas, startVideo, stopVideo, videoRunning, videoSupported } from './sim-video.ts'

// main 의 답(scripts/sim.mjs --json 그대로)
export type SimReply = { ok: boolean; error?: string; code?: number; [key: string]: unknown }
type Device = { id: string; name: string; booted: boolean; os?: string; platform: 'ios' | 'android' }
type Running = { platform: 'ios' | 'android'; id: string; name: string }
type Platform = { ok: boolean; reason: string; devices: Device[] }

export type SimActions = { place: () => void; close: () => void; isOpen: () => boolean }
export type DrawerMode = 'web' | 'sim'

type SimView = {
  loaded: boolean
  busy: '' | 'list' | 'start' | 'shot'
  ios: Platform | null
  android: Platform | null
  selected: string
  running: Running | null
  error: string // 화면에 보일 이유(문구 키 또는 sim.mjs 의 한 줄)
  frame: string // Android 화면 그림(data URL — 그림 받기로 돌아갔을 때만)
  videoReady: boolean // Android 영상의 첫 장을 그렸다
}

const MODE_KEY = 'studio.browserMode'
const FRAME_GAP_MS = 1000
const TAP_MOVE = 0.02 // 이보다 덜 움직이면 누르기 · 넘으면 쓸기(비율)
const VIDEO_GUARD_MS = 1000 // 영상이 도는 동안 칸이 아직 보이는지 보는 간격(서랍 닫기 · 웹 탭 · 다른 기기 → 끈다)
const DECODE_RETRIES = 3 // 풀기 실패면 영상을 다시 켠다 — 이만큼 넘으면 그림 받기로

export const mode = createStore<DrawerMode>(localStorage.getItem(MODE_KEY) === 'sim' ? 'sim' : 'web')
const view = createStore<SimView>({ loaded: false, busy: '', ios: null, android: null, selected: '', running: null, error: '', frame: '', videoReady: false })
let actions: SimActions = { place: () => {}, close: () => {}, isOpen: () => false }
let frameLoop = false
let framesOnly = false // 영상을 못 쓴다(옛 코어 · 풀기 실패 반복) — 이 창에서는 그림 받기로
let videoId = '' // 영상을 띄운 기기
let videoGuard: number | null = null
let decodeFailures = 0

function commit(next: Partial<SimView>): void {
  flushSync(() => view.set({ ...view.get(), ...next }))
}

const allDevices = (state: SimView): Device[] => [...(state.ios?.devices || []), ...(state.android?.devices || [])]

// 켤 때 한 번 — 칸(#sim-screen)에 띄운다. 막대는 browser-bar.tsx 의 Bar 가 모드에 따라 SimBar 를 그린다
export function mount(screen: HTMLElement, next: SimActions): void {
  actions = next
  mountIsland(screen, <SimScreen />)
}

export function setMode(next: DrawerMode): void {
  if (mode.get() === next) return
  localStorage.setItem(MODE_KEY, next)
  flushSync(() => mode.set(next))
  if (next === 'web') stopAndroidVideo()
  actions.place()
}

// iOS 화면을 main 의 뷰로 붙일 때인지 — 시뮬레이터 모드이고 iOS 기기가 열려 있다
export function wantsView(): boolean {
  const { running, busy } = view.get()
  return mode.get() === 'sim' && running?.platform === 'ios' && busy !== 'start'
}

// 서랍이 시뮬레이터 모드로 보일 때마다(placeBrowserView) — 처음이면 목록을 읽고 켜진 기기를 바로 연다(D3), Android 면 화면 받기를 다시 돌린다
export function shown(): void {
  const state = view.get()
  if (!state.loaded && !state.busy) void loadList(true)
  if (state.running?.platform === 'android') runAndroid()
}

function platformOf(reply: SimReply, key: 'ios' | 'android'): Platform {
  const entry = reply[key] as { ok?: boolean; reason?: string; devices?: Omit<Device, 'platform'>[] } | undefined
  return { ok: Boolean(entry?.ok), reason: String(entry?.reason || ''), devices: (entry?.devices || []).map((device) => ({ ...device, platform: key })) }
}

// sim.mjs 이유 → 화면 문구(아는 것만 키로 · 나머지는 원문 한 줄)
function reasonText(error: string | undefined): string {
  if (error === 'core-old') return sayNow('sim.coreOld')
  if (error === 'timeout') return sayNow('sim.timeout')
  if (error === 'not-found') return sayNow('sim.notFound')
  return error || sayNow('sim.failedUnknown')
}

async function loadList(autoStart: boolean): Promise<void> {
  commit({ busy: 'list', error: '' })
  const reply = await studio.simList()
  if (!reply.ok) {
    commit({ busy: '', loaded: true, error: reasonText(reply.error) })
    return
  }
  const ios = platformOf(reply, 'ios')
  const android = platformOf(reply, 'android')
  const state = view.get()
  const devices = [...ios.devices, ...android.devices]
  const booted = devices.find((device) => device.booted)
  // 열어 둔 기기가 밖에서 꺼졌다(목록에 없거나 꺼짐) — 열림을 풀어 뷰를 떼고 [켜기] 로 돌린다.
  // 목록을 읽는 사이 그 기기의 마지막 그림 받기가 남긴 오류도 지운다(사라진 기기 이야기라 안내를 가린다)
  const stillRunning = state.running && devices.some((device) => device.id === state.running?.id && device.booted)
  const selected = pickSelected(devices, state.selected, stillRunning ? state.running?.id || '' : '')
  if (state.running && !stillRunning) {
    stopAndroidVideo()
    commit({ busy: '', loaded: true, ios, android, selected, running: null, frame: '', videoReady: false, error: '' })
    actions.place()
    return
  }
  commit({ busy: '', loaded: true, ios, android, selected })
  if (autoStart && !state.running && booted && booted.id === selected) void start(booted.id)
}

async function start(id: string): Promise<void> {
  const device = allDevices(view.get()).find((item) => item.id === id)
  if (!device) return
  stopAndroidVideo()
  commit({ busy: 'start', selected: id, error: '', frame: '', videoReady: false })
  actions.place() // 여는 동안 옛 iOS 페이지를 뗀다(wantsView 가 거짓)
  const reply = await studio.simStart(id)
  if (!reply.ok) {
    commit({ busy: '', running: null, error: reasonText(reply.error) })
    actions.place()
    return
  }
  const running: Running = { platform: reply.platform === 'android' ? 'android' : 'ios', id: String(reply.id || id), name: String(reply.name || device.name) }
  commit({ busy: '', running, selected: running.id })
  // 꺼져 있던 기기를 켰으면 목록의 ●/○ 도 바꾼다
  if (!device.booted) void loadList(false)
  actions.place()
  if (running.platform === 'android') runAndroid()
}

async function shot(): Promise<void> {
  const { running } = view.get()
  if (!running) return
  commit({ busy: 'shot' })
  const reply = await studio.simShot(running.id)
  commit({ busy: '' })
  if (reply.ok) showToast(sayNow('sim.shotSaved', { file: String(reply.file || '') }), 'success')
  else showToast(sayNow('sim.shotFailed', { reason: reasonText(reply.error) }), 'error')
}

// 칸에 Android 화면을 그릴 때인지 — 서랍이 열려 있고 · 시뮬레이터 모드이고 · Android 가 열려 있다
function androidShown(): Running | null {
  const { running } = view.get()
  return running?.platform === 'android' && mode.get() === 'sim' && actions.isOpen() ? running : null
}

function stopAndroidVideo(): void {
  clearInterval(videoGuard ?? undefined)
  videoGuard = null
  videoId = ''
  stopVideo()
  // 다시 보일 때 끈 동안의 마지막 장이 잠깐 보이지 않게 — 새 첫 장을 그리면 다시 켠다
  if (view.get().videoReady) commit({ videoReady: false })
}

// Android 화면 — 영상을 하나 띄운다(이미 그 기기 영상이면 그대로). 칸이 안 보이면 끈다 · 영상을 못 쓰면 그림 받기
function runAndroid(): void {
  const running = androidShown()
  if (!running) return stopAndroidVideo()
  if (framesOnly || !videoSupported()) return runFrames()
  if (videoId === running.id && videoRunning()) return
  videoId = running.id
  commit({ videoReady: false })
  startVideo(running.id, {
    drawn: () => {
      decodeFailures = 0
      if (view.get().running?.id === running.id) commit({ videoReady: true, error: '' })
    },
    ended: (reason) => videoEnded(running.id, reason),
  })
  if (videoGuard) return
  videoGuard = setInterval(() => {
    if (androidShown()?.id !== videoId) stopAndroidVideo()
  }, VIDEO_GUARD_MS)
}

// 영상이 저절로 끝났다(끈 것은 오지 않는다) — 옛 코어면 그림 받기 · 풀기 실패면 다시 · 나머지는 이유를 보인다
function videoEnded(id: string, reason: string): void {
  clearInterval(videoGuard ?? undefined)
  videoGuard = null
  videoId = ''
  if (view.get().running?.id !== id) return
  if (reason === 'decode' && decodeFailures < DECODE_RETRIES) {
    decodeFailures += 1
    return runAndroid()
  }
  if (reason === 'no-stream' || reason === 'decode') {
    framesOnly = true
    commit({ videoReady: false })
    return runFrames()
  }
  commit({ videoReady: false, error: reasonText(reason) })
}

// Android 화면 받기(그림 — 영상을 못 쓸 때) — 서랍이 열려 있고 · 시뮬레이터 모드이고 · Android 가 열려 있을 때만 돈다(하나만)
function runFrames(): void {
  if (frameLoop) return
  frameLoop = true
  const step = async () => {
    const { running } = view.get()
    if (!running || running.platform !== 'android' || mode.get() !== 'sim' || !actions.isOpen()) {
      frameLoop = false
      return
    }
    const reply = await studio.simFrame(running.id)
    if (view.get().running?.id === running.id) {
      if (reply.ok && typeof reply.image === 'string') commit({ frame: reply.image, error: '' })
      else commit({ error: reasonText(reply.error) })
    }
    setTimeout(() => void step(), FRAME_GAP_MS)
  }
  void step()
}

// ── 막대 ──────────────────────────────────────────────────
export function ModeSwitch() {
  const say = useSay()
  const current = useStore(mode)
  return (
    <div className="browser-mode" role="tablist" aria-label={say('sim.modeLabel')}>
      <button role="tab" aria-selected={current === 'web'} className={current === 'web' ? 'active' : ''} onClick={() => setMode('web')}>
        {say('sim.modeWeb')}
      </button>
      <button role="tab" aria-selected={current === 'sim'} className={current === 'sim' ? 'active' : ''} onClick={() => setMode('sim')}>
        {say('sim.modeSim')}
      </button>
    </div>
  )
}

function deviceLabel(device: Device): string {
  return `${device.booted ? '●' : '○'} ${device.name}${device.os ? ` (${device.os})` : ''}`
}

export function SimBar() {
  const say = useSay()
  const state = useStore(view)
  const devices = allDevices(state)
  const selected = devices.find((device) => device.id === state.selected)
  const showing = state.running && state.running.id === state.selected
  const group = (platform: Platform | null, label: string) =>
    platform && platform.devices.length > 0 ? (
      <optgroup label={label}>
        {platform.devices.map((device) => (
          <option key={device.id} value={device.id}>
            {deviceLabel(device)}
          </option>
        ))}
      </optgroup>
    ) : null
  return (
    <>
      <select
        className="sim-device"
        title={say('sim.pick')}
        value={state.selected}
        disabled={state.busy === 'start' || devices.length === 0}
        onChange={(event) => {
          const id = event.currentTarget.value
          commit({ selected: id })
          // 켜진 기기는 고르면 바로 연다 · 꺼진 기기는 [켜기] 를 기다린다(D3)
          if (devices.find((device) => device.id === id)?.booted) void start(id)
        }}
      >
        {devices.length === 0 ? <option value="">{state.loaded ? say('sim.noDevices') : say('sim.loading')}</option> : null}
        {group(state.ios, 'iOS')}
        {group(state.android, 'Android')}
      </select>
      <button title={say('sim.refresh')} disabled={Boolean(state.busy)} onClick={() => void loadList(false)}>
        ⟳
      </button>
      {selected && !showing ? (
        <button className="sim-action" disabled={Boolean(state.busy)} onClick={() => void start(selected.id)}>
          {selected.booted ? say('sim.open') : say('sim.boot')}
        </button>
      ) : (
        <button className="sim-action" title={say('sim.shotHint')} disabled={!showing || Boolean(state.busy)} onClick={() => void shot()}>
          {say('sim.shot')}
        </button>
      )}
      <span className="sim-gap" />
      <button title={say('common.close')} onClick={() => actions.close()}>
        ✕
      </button>
    </>
  )
}

// ── 칸 ───────────────────────────────────────────────────
// 판정(src/lib/sim-view.mts) → 문구 키 — 키를 글자 그대로 둬 문구 시험(i18n-usage)이 본다
const NOTE_KEYS = { loading: 'sim.loading', noDevices: 'sim.noDevices', noRunning: 'sim.noRunning', pickBooted: 'sim.pickBooted' } as const
function SimScreen() {
  const say = useSay()
  const state = useStore(view)
  const press = useRef<{ x: number; y: number } | null>(null)
  const ratioOf = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const clamp = (value: number) => Math.min(Math.max(value, 0), 1)
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
  }
  // 누르기 · 끌기 — 놓은 자리가 거의 같으면 누르기, 아니면 쓸기(휠은 보내지 않는다)
  const pointer = (id: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      press.current = ratioOf(event)
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const from = press.current
      press.current = null
      if (!from) return
      const to = ratioOf(event)
      if (Math.hypot(to.x - from.x, to.y - from.y) < TAP_MOVE) void studio.simTap(id, from.x, from.y)
      else void studio.simSwipe(id, from, to)
    },
  })
  const running = state.running
  const notes: string[] = []
  if (state.ios && !state.ios.ok && state.ios.reason === 'no-xcode') notes.push(say('sim.noXcode'))
  if (state.android && !state.android.ok && state.android.reason === 'no-sdk') notes.push(say('sim.noSdk'))
  const devices = allDevices(state)
  const note = screenNote({ loaded: state.loaded, busy: state.busy, error: state.error, running: Boolean(running), frameMissing: running?.platform === 'android' && !state.frame && !state.videoReady, devices })
  let message = ''
  if (note === 'starting') message = say('sim.starting', { name: devices.find((device) => device.id === state.selected)?.name || '' })
  else if (note === 'error') message = state.error
  else if (note) message = say(NOTE_KEYS[note])
  return (
    <>
      {running?.platform === 'android' && !state.frame ? (
        <canvas ref={setCanvas} className="sim-frame" hidden={!state.videoReady || state.busy === 'start'} aria-label={running.name} {...pointer(running.id)} />
      ) : null}
      {running?.platform === 'android' && state.frame && state.busy !== 'start' ? <img className="sim-frame" src={state.frame} alt={running.name} draggable={false} {...pointer(running.id)} /> : null}
      {message ? <p className="sim-message">{message}</p> : null}
      {notes.length && (!running || state.error) ? (
        <ul className="sim-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
