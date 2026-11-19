// ── 시뮬레이터 칸 — 옆 브라우저 서랍의 [시뮬레이터] 탭(팩 창마다) ─────────────
// 기기 찾기 · 켜기 · 캡처 · 누르기는 모두 본체 코어 `scripts/sim.mjs … --json`(에이전트가 쓰는 것과 같은 길 · 셸 없이 execFile).
// iOS 는 sim.mjs serve 가 켠 serve-sim 미리보기 페이지(127.0.0.1:<포트> — 화면 스트림 · 누르기 · 쓸기를 페이지가 한다)를
// 전용 WebContentsView(세션 따로 · sandbox · preload 없음 · 그 주소 밖 이동 막기)에 띄워 서랍 자리(#browser-slot)에 붙인다.
// Android 는 화면을 그림으로 받아(simFrame — 화면이 1초마다 부른다) 화면 쪽 <img> 가 그리고, 누르기 · 쓸기는 sim.mjs tap · swipe.
// 창이 닫히면(dropSim) 서버를 놓는다 — 앱이 켠 serve-sim 서버는 쓰는 창이 모두 놓은 뒤에만 끈다. 시뮬레이터 · 에뮬레이터는 끄지 않는다(계획서 지시 "보존")
// 떼어 내기 — 막대의 [새 창으로] 를 누르면 떼어 낸 서랍 창(drawer-window.mts — [웹] · [시뮬레이터] 두 탭)으로 옮긴다. iOS 페이지 뷰는 그 창에 붙고(다시 불러오지 않음),
// Android 화면 그림 · 누르기 · 쓸기는 그 창 화면이 같은 sim:* 채널로 부른다. 그 창을 닫으면(또는 [되돌리기]) 서랍이 그 창에서 보던 탭으로 돌아온다
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { app, session, WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
import * as core from '../lib/core.mts'
import type { DrawerWindowCtx } from './drawer-window.mts'

type Rect = { x: number; y: number; width: number; height: number }

// 지금 연 기기(마지막으로 연 것) — 떼어 낸 창 · 돌아온 서랍이 이 기기로 이어 본다
export type SimRunning = { platform: 'ios' | 'android'; id: string; name: string }

// sim.mjs --json 의 답 — ok 가 거짓이면 error(이유 한 줄) · code(1 실패 · 2 인자 · 3 도구 없음). 칸이 따로 아는 이유는 error 에 이름으로(core-old)
export type SimReply = { ok: boolean; error?: string; code?: number; [key: string]: unknown }

export type SimulatorCtx = {
  athenaDir: string | null
  win: BrowserWindow | null
  send(channel: string, ...values: unknown[]): void
  simList?: () => Promise<SimReply>
  simStart?: (id: string) => Promise<SimReply>
  simCurrent?: () => SimRunning | null
  // fromDetached — 떼어 낸 창 화면이 보낸 것. 떼어 낸 동안 서랍이 보낸 것(또는 그 반대)은 무시한다
  simPlace?: (rect: Rect | null, fromDetached?: boolean) => void
  simHide?: (fromDetached?: boolean) => void
  simCommand?: (name: string) => void
  simShot?: (id: string) => Promise<SimReply>
  simFrame?: (id: string) => Promise<SimReply>
  simTap?: (id: string, x: number, y: number) => Promise<SimReply>
  simSwipe?: (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => Promise<SimReply>
  dropSim?: () => void
}

// 켜기(boot — heavy.sh 자리 기다림 포함) · serve-sim 첫 내려받기는 오래 걸린다
const BOOT_TIMEOUT = 10 * 60_000
const SERVE_TIMEOUT = 4 * 60_000
const QUICK_TIMEOUT = 60_000
const FRAME_TIMEOUT = 15_000
const SIM_PARTITION = 'athena-simulator'

// serve-sim 상태 파일 — 기기마다 하나(계획서 D5). 켜기 전에 있었으면 다른 쪽(에이전트 · 다른 창)이 켠 서버라 끄지 않는다
const serveStateFile = (udid: string) => path.join(os.tmpdir(), 'serve-sim', `server-${udid}.json`)

// serve-sim 서버를 쓰는 창(UDID → 창 표) · 앱이 켠 서버(UDID) — 창 여럿이 같은 기기를 열면 서버 하나를 같이 쓴다.
// 앱이 켠 서버는 쓰는 창이 모두 놓은 뒤에만 끈다(main 프로세스에 하나 — 창마다 따로 두면 A 를 닫을 때 B 화면이 끊긴다)
const serverUsers = new Map<string, Set<object>>()
const appServers = new Set<string>()

// sim.mjs 출력의 마지막 JSON 줄(heavy.sh 안내 줄이 앞에 섞일 수 있다)
function lastJson(text: string): SimReply | null {
  const line = text.trim().split('\n').reverse().find((row) => row.startsWith('{'))
  if (!line) return null
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && 'ok' in value ? (value as SimReply) : null
  } catch {
    return null
  }
}

export function installSimulator(ctx: SimulatorCtx & DrawerWindowCtx): void {
  let view: WebContentsView | null = null
  let viewUrl = ''
  let attached = false
  let lastBounds: Rect | null = null
  let frameCount = 0
  let current: SimRunning | null = null
  // 떼어 낸 서랍 창 — 있으면 iOS 페이지 뷰는 이 창에 붙는다
  const detachedWin = (): BrowserWindow | null => ctx.drawerWin?.() ?? null
  // iOS 페이지 뷰가 붙는 창 — 떼어 낸 동안은 그 창, 아니면 팩 창
  const host = (): BrowserWindow | null => detachedWin() || ctx.win
  // 이 창의 표 · 쓰는 서버(UDID) · 창이 닫혔는지(켜기를 기다리는 중에 닫히면 뒤늦게 뷰 · 서버를 만들지 않는다)
  const owner = {}
  let usingServer = ''
  let dropped = false

  const runSim = (args: string[], timeout = QUICK_TIMEOUT): Promise<SimReply> => new Promise((resolve) => {
    const script = path.join(ctx.athenaDir || '', 'scripts', 'sim.mjs')
    // 옛 본체(코어 업데이트 전)는 도우미가 없다
    if (!ctx.athenaDir || !fs.existsSync(script)) return resolve({ ok: false, error: 'core-old' })
    const nodePath = core.findExecutable('node', process.env.PATH)
    const env = core.childEnv(process.env, nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' })
    execFile(nodePath || process.execPath, [script, ...args, '--json'], { cwd: ctx.athenaDir, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const reply = lastJson(String(stdout || ''))
      if (reply) return resolve(reply)
      const timedOut = Boolean(error && (error as { killed?: boolean }).killed)
      const reason = String(stderr || (error && error.message) || '').trim().split('\n').find(Boolean) || ''
      resolve({ ok: false, error: timedOut ? 'timeout' : reason || 'failed' })
    })
  })

  // 이 창이 서버를 놓는다 — 아무 창도 안 쓰고 앱이 켠 서버면 끈다(다른 쪽 — 에이전트 · 밖에서 켠 서버는 그대로)
  function releaseServer(udid: string): void {
    const users = serverUsers.get(udid)
    users?.delete(owner)
    if (users && users.size > 0) return
    serverUsers.delete(udid)
    if (!appServers.delete(udid)) return
    void runSim(['unserve', '--device', udid])
  }

  function useServer(udid: string): void {
    if (usingServer && usingServer !== udid) releaseServer(usingServer)
    usingServer = udid
    const users = serverUsers.get(udid) || new Set<object>()
    users.add(owner)
    serverUsers.set(udid, users)
  }

  function closeView(): void {
    if (!view) return
    const win = host()
    if (attached && win && !win.isDestroyed()) win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    view = null
    viewUrl = ''
    attached = false
  }

  // serve-sim 페이지 전용 뷰 — 옆 브라우저와 세션이 다르고(쿠키 · 저장소를 섞지 않는다) 그 주소(127.0.0.1:<포트>) 밖으로는 움직이지 않는다
  function showPage(url: string): void {
    if (view && viewUrl === url) return
    closeView()
    const simSession = session.fromPartition(SIM_PARTITION)
    simSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    simSession.setPermissionCheckHandler(() => false)
    const next = new WebContentsView({ webPreferences: { partition: SIM_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false } })
    const origin = new URL(url).origin
    const inside = (target: string) => {
      try {
        return new URL(target).origin === origin
      } catch {
        return false
      }
    }
    const contents = next.webContents
    contents.on('will-frame-navigate', (event) => {
      if (!inside(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, target) => {
      if (!inside(target)) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (lastBounds) next.setBounds(lastBounds)
    view = next
    viewUrl = url
    contents.loadURL(url)
  }

  ctx.simList = () => runSim(['list'])

  // 칸에서 기기를 골랐다 — 꺼졌으면 켜고(D3 — 칸을 열 때만), iOS 는 serve-sim 페이지를 띄운다. Android 는 화면이 그림을 받아 간다
  ctx.simStart = async (id) => {
    const found = await runSim(['list'])
    if (!found.ok) return found
    const pick = (platform: 'ios' | 'android') => {
      const entry = found[platform] as { devices?: { id: string; name: string; booted: boolean }[] } | undefined
      return (entry?.devices || []).find((device) => device.id === id)
    }
    const ios = pick('ios')
    const android = ios ? undefined : pick('android')
    const device = ios || android
    if (!device) return { ok: false, error: 'not-found' }
    let deviceId = device.id
    if (!device.booted) {
      const booted = await runSim(['boot', device.id], BOOT_TIMEOUT)
      if (!booted.ok) return booted
      // 꺼진 AVD(avd:<이름>)는 켜지면 일련번호(emulator-5554)로 바뀐다 — 다시 찾는다
      if (android) {
        const again = await runSim(['list', '--platform', 'android'])
        const devices = ((again.android as { devices?: { id: string; avd: string; booted: boolean }[] } | undefined)?.devices) || []
        deviceId = devices.find((item) => item.booted && item.avd === (device as { avd?: string }).avd)?.id || deviceId
      }
    }
    if (dropped) return { ok: false, error: 'closed' }
    if (android) {
      closeView()
      if (usingServer) releaseServer(usingServer)
      usingServer = ''
      current = { platform: 'android', id: deviceId, name: device.name }
      return { ok: true, platform: 'android', id: deviceId, name: device.name }
    }
    const before = fs.existsSync(serveStateFile(deviceId))
    const served = await runSim(['serve', '--device', deviceId], SERVE_TIMEOUT)
    if (!served.ok || typeof served.url !== 'string') return served.ok ? { ok: false, error: 'no-url' } : served
    if (!before) appServers.add(deviceId)
    useServer(deviceId)
    // 서버를 기다리는 사이 창이 닫혔다 — 뷰는 만들지 않고 방금 잡은 서버를 놓는다
    if (dropped) {
      releaseServer(deviceId)
      usingServer = ''
      return { ok: false, error: 'closed' }
    }
    showPage(served.url)
    current = { platform: 'ios', id: deviceId, name: device.name }
    return { ok: true, platform: 'ios', id: deviceId, name: device.name, url: served.url }
  }

  // 화면 좌표(CSS 픽셀) × 확대 비율 = 창 좌표 · 창 안으로 자른다(옆 브라우저 placeBrowser 와 같은 셈)
  ctx.simCurrent = () => current

  ctx.simPlace = (rect, fromDetached = false) => {
    const win = host()
    if (!win || win.isDestroyed() || !rect || !view || fromDetached !== Boolean(detachedWin())) return
    const zoom = win.webContents.getZoomFactor()
    const [contentWidth = 0, contentHeight = 0] = win.getContentSize()
    const x = Math.min(Math.max(0, Math.round(rect.x * zoom)), contentWidth)
    const y = Math.min(Math.max(0, Math.round(rect.y * zoom)), contentHeight)
    const width = Math.min(Math.max(0, Math.round(rect.width * zoom)), contentWidth - x)
    const height = Math.min(Math.max(0, Math.round(rect.height * zoom)), contentHeight - y)
    lastBounds = { x, y, width, height }
    view.setBounds(lastBounds)
    if (!attached) {
      win.contentView.addChildView(view)
      attached = true
    }
  }

  // 서랍을 닫거나 [웹] 탭 · 대화상자 — 떼기만(페이지는 살려 두어 다시 열면 바로)
  ctx.simHide = (fromDetached = false) => {
    const win = host()
    if (!win || win.isDestroyed() || !view || !attached || fromDetached !== Boolean(detachedWin())) return
    win.contentView.removeChildView(view)
    attached = false
  }

  // 떼어 낸 서랍 창으로 옮기기 · 돌아오기 — 붙어 있던 뷰를 옛 창에서 먼저 뗀다(창과 함께 정리되지 않게). 다음 자리 알리기(sim:place)가 새 host 에 붙인다
  ctx.onDrawerMove?.((win, detached) => {
    const from = detached ? ctx.win : win
    if (attached && view && from && !from.isDestroyed() && !view.webContents.isDestroyed()) from.contentView.removeChildView(view)
    attached = false
  })

  // 막대 단추 — detach [새 창으로](시뮬레이터 탭을 보던 채로) · attach [되돌리기](서랍이 그 창에서 보던 탭으로) · focus-detached(떼어 낸 동안 서랍의 [시뮬레이터])
  ctx.simCommand = (name) => {
    if (name === 'detach') return ctx.detachDrawer?.('sim')
    if (name === 'attach') return ctx.closeDrawer?.(true)
    if (name === 'focus-detached') return ctx.focusDrawer?.()
  }

  // 칸 [캡처] — 데스크톱에(Simulator.app ⌘S 기본과 같은 자리 · 계획서 D8)
  ctx.simShot = (id) => runSim(['shot', '--device', id, '--dir', app.getPath('desktop')])

  // Android 화면 한 장 — 임시 파일로 받아 data URL 로(파일은 바로 지운다)
  ctx.simFrame = async (id) => {
    const file = path.join(os.tmpdir(), `athena-sim-frame-${process.pid}-${frameCount++}.png`)
    const reply = await runSim(['shot', '--platform', 'android', '--device', id, '--out', file], FRAME_TIMEOUT)
    try {
      if (!reply.ok) return reply
      return { ok: true, image: `data:image/png;base64,${(await fs.promises.readFile(file)).toString('base64')}` }
    } catch {
      return { ok: false, error: 'failed' }
    } finally {
      fs.promises.rm(file, { force: true }).catch(() => {})
    }
  }

  ctx.simTap = (id, x, y) => runSim(['tap', String(x), String(y), '--platform', 'android', '--device', id])
  ctx.simSwipe = (id, from, to) => runSim(['swipe', String(from.x), String(from.y), String(to.x), String(to.y), '--platform', 'android', '--device', id])

  // 창이 닫혔다 — 떼어 둔 뷰를 닫고 서버를 놓는다(앱이 켠 서버는 쓰는 창이 없을 때만 꺼진다 · 시뮬레이터는 그대로)
  ctx.dropSim = () => {
    dropped = true
    closeView()
    ctx.closeDrawer?.(false)
    if (usingServer) releaseServer(usingServer)
    usingServer = ''
  }
}
