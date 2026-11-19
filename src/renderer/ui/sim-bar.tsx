// 옆 브라우저 서랍의 [웹 | 시뮬레이터] 전환 · 시뮬레이터 막대(기기 고르기 · 켜기 · 캡처 · 닫기) · 칸(#sim-screen — 안내 글 · Android 화면 그림)
// 서랍 껍데기와 자리 알리기(placeBrowserView)는 바닐라 browser.ts. 명령은 main 이 본체 scripts/sim.mjs 로(src/main/simulator.mts).
// iOS 화면은 main 의 serve-sim 페이지 뷰가 #browser-slot 자리에 그린다(누르기 · 쓸기도 그 페이지) — 여기는 그 뒤에 깔린 안내 글만.
// Android 는 칸이 보일 때만 1초마다 화면 그림을 받아 <img> 로 그리고, 누르기 · 끌기를 비율 좌표로 보낸다.
// [새 창으로] ⧉ 를 누르면 떼어 낸 서랍 창(browser-window.ts — detached · 서랍과 같은 [웹 | 시뮬레이터] 탭)이 같은 막대 · 칸을 띄운다. 그 동안 서랍의 [시뮬레이터] 는 그 창을 앞으로 가져온다
import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { flushSync } from 'react-dom'
import { createStore, mountIsland, say as sayNow, showToast, useSay, useStore } from './bridge.ts'

// main 의 답(scripts/sim.mjs --json 그대로)
export type SimReply = { ok: boolean; error?: string; code?: number; [key: string]: unknown }
type Device = { id: string; name: string; booted: boolean; os?: string; platform: 'ios' | 'android' }
type Running = { platform: 'ios' | 'android'; id: string; name: string }
type Platform = { ok: boolean; reason: string; devices: Device[] }

// detached — 떼어 낸 창의 막대: ✕ 대신 [되돌리기]. 서랍 막대에는 [새 창으로]
export type SimActions = { place: () => void; close: () => void; isOpen: () => boolean; detached?: boolean }
export type DrawerMode = 'web' | 'sim'

type SimView = {
  loaded: boolean
  busy: '' | 'list' | 'start' | 'shot'
  ios: Platform | null
  android: Platform | null
  selected: string
  running: Running | null
  error: string // 화면에 보일 이유(문구 키 또는 sim.mjs 의 한 줄)
  frame: string // Android 화면 그림(data URL)
}

const MODE_KEY = 'studio.browserMode'
const FRAME_GAP_MS = 1000
const TAP_MOVE = 0.02 // 이보다 덜 움직이면 누르기 · 넘으면 쓸기(비율)

export const mode = createStore<DrawerMode>(localStorage.getItem(MODE_KEY) === 'sim' ? 'sim' : 'web')
const view = createStore<SimView>({ loaded: false, busy: '', ios: null, android: null, selected: '', running: null, error: '', frame: '' })
let actions: SimActions = { place: () => {}, close: () => {}, isOpen: () => false }
let frameLoop = false
// 서랍을 새 창으로 떼어 낸 동안(main drawer:detached) — 서랍 쪽만 쓴다
export const detachedStore = createStore(false)

function commit(next: Partial<SimView>): void {
  flushSync(() => view.set({ ...view.get(), ...next }))
}

const allDevices = (state: SimView): Device[] => [...(state.ios?.devices || []), ...(state.android?.devices || [])]

// 켤 때 한 번 — 칸(#sim-screen)에 띄운다. 막대는 browser-bar.tsx 의 Bar 가 모드에 따라 SimBar 를 그린다
export function mount(screen: HTMLElement, next: SimActions): void {
  actions = next
  mountIsland(screen, <SimScreen />)
}

// 떼어 낸 서랍 창 — 칸을 띄우고 처음 볼 탭으로(막대는 browser-bar.tsx 의 Bar 가 탭에 따라 SimBar 를 그린다 · 서랍의 탭 기억은 건드리지 않는다)
export function mountWindow(screen: HTMLElement, place: () => void, first: DrawerMode): void {
  actions = { place, close: () => {}, isOpen: () => true, detached: true }
  flushSync(() => mode.set(first))
  mountIsland(screen, <SimScreen />)
}

// main 이 기억하는 지금 기기(마지막으로 연 것)로 맞춘다 — 떼어 낸 창이 뜰 때 · 서랍으로 돌아올 때
export async function adopt(): Promise<void> {
  const running = (await studio.simCurrent()) as Running | null
  if (running) commit({ running, selected: running.id, frame: '', error: '' })
}

export function setMode(next: DrawerMode): void {
  // 떼어 낸 동안 서랍의 [시뮬레이터] 는 그 창을 앞으로
  if (next === 'sim' && detachedStore.get() && !actions.detached) return void studio.simCommand('focus-detached')
  if (mode.get() === next) return
  if (!actions.detached) localStorage.setItem(MODE_KEY, next)
  flushSync(() => mode.set(next))
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
  if (state.running?.platform === 'android') runFrames()
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
  const keep = devices.find((device) => device.id === state.selected)
  const booted = devices.find((device) => device.booted)
  const selected = keep?.id || state.running?.id || booted?.id || devices[0]?.id || ''
  // 열어 둔 기기가 밖에서 꺼졌다(목록에 없거나 꺼짐) — 열림을 풀어 뷰를 떼고 [켜기] 로 돌린다
  const stillRunning = state.running && devices.some((device) => device.id === state.running?.id && device.booted)
  if (state.running && !stillRunning) {
    commit({ busy: '', loaded: true, ios, android, selected, running: null, frame: '' })
    actions.place()
    return
  }
  commit({ busy: '', loaded: true, ios, android, selected })
  if (autoStart && !state.running && booted && booted.id === selected) void start(booted.id)
}

async function start(id: string): Promise<void> {
  const device = allDevices(view.get()).find((item) => item.id === id)
  if (!device) return
  commit({ busy: 'start', selected: id, error: '', frame: '' })
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
  if (running.platform === 'android') runFrames()
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

// Android 화면 받기 — 서랍이 열려 있고 · 시뮬레이터 모드이고 · Android 가 열려 있을 때만 돈다(하나만)
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
        {devices.length === 0 ? <option value="">{say('sim.noDevices')}</option> : null}
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
      {actions.detached ? (
        <button id="sim-attach" title={say('browser.attach')} aria-label={say('browser.attach')} onClick={() => studio.simCommand('attach')}>
          ◨
        </button>
      ) : (
        <>
          <button id="sim-detach" title={say('browser.detach')} aria-label={say('browser.detach')} onClick={() => studio.simCommand('detach')}>
            ⧉
          </button>
          <button title={say('common.close')} onClick={() => actions.close()}>
            ✕
          </button>
        </>
      )}
    </>
  )
}

// ── 칸 ───────────────────────────────────────────────────
function SimScreen() {
  const say = useSay()
  const state = useStore(view)
  const press = useRef<{ x: number; y: number } | null>(null)
  const ratioOf = (event: ReactPointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const clamp = (value: number) => Math.min(Math.max(value, 0), 1)
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }
  }
  const running = state.running
  const notes: string[] = []
  if (state.ios && !state.ios.ok && state.ios.reason === 'no-xcode') notes.push(say('sim.noXcode'))
  if (state.android && !state.android.ok && state.android.reason === 'no-sdk') notes.push(say('sim.noSdk'))
  let message = ''
  if (state.busy === 'list' && !state.loaded) message = say('sim.loading')
  else if (state.busy === 'start') message = say('sim.starting', { name: allDevices(state).find((device) => device.id === state.selected)?.name || '' })
  else if (state.error) message = state.error
  else if (!running) message = allDevices(state).length ? say('sim.noRunning') : say('sim.noDevices')
  else if (running.platform === 'android' && !state.frame) message = say('sim.loading')
  return (
    <>
      {running?.platform === 'android' && state.frame && state.busy !== 'start' ? (
        <img
          className="sim-frame"
          src={state.frame}
          alt={running.name}
          draggable={false}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            press.current = ratioOf(event)
          }}
          onPointerUp={(event) => {
            const from = press.current
            press.current = null
            if (!from) return
            const to = ratioOf(event)
            if (Math.hypot(to.x - from.x, to.y - from.y) < TAP_MOVE) void studio.simTap(running.id, from.x, from.y)
            else void studio.simSwipe(running.id, from, to)
          }}
        />
      ) : null}
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
