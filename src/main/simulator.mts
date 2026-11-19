// ── 시뮬레이터 칸 — 옆 브라우저 서랍의 [시뮬레이터] 탭(팩 창마다) ─────────────
// 기기 찾기 · 켜기 · 캡처 · 누르기는 모두 본체 코어 `scripts/sim.mjs … --json`(에이전트가 쓰는 것과 같은 길 · 셸 없이 execFile).
// iOS 는 sim.mjs serve 가 켠 serve-sim 미리보기 페이지(127.0.0.1:<포트> — 화면 스트림 · 누르기 · 쓸기를 페이지가 한다)를
// 전용 WebContentsView(세션 따로 · sandbox · preload 없음 · 그 주소 밖 이동 막기)에 띄워 서랍 자리(#browser-slot)에 붙인다.
// Android 는 화면 영상(sim.mjs stream — adb screenrecord H.264)을 창마다 하나 띄워 조각을 화면에 보내고(sim:video) 화면이 WebCodecs 로 푼다.
// 옛 코어(stream 없음)면 그림 받기(simFrame — 화면이 1초마다 부른다)로. 누르기 · 쓸기는 sim.mjs tap · swipe —
// 영상이 알린 화면 크기(stderr "size WxH")가 있으면 --size 로 넘겨 목록 · 화면 크기 읽기(dumpsys — 부하 때 몇 초)를 건너뛴다.
// 영상과 함께 이어 누르기(sim.mjs input — 열어 둔 adb shell 하나)를 띄워 누르기 · 손가락 움직임을 그때그때 보낸다(쓸기가 손을 따라간다).
// 이어 누르기가 아직 · 못 쓰면(옛 코어 · 끊김) 지금 방식 — 누르기마다 sim.mjs tap · 뗄 때 sim.mjs swipe 한 번.
// 창이 닫히면(dropSim) 서버를 놓는다 — 앱이 켠 serve-sim 서버는 쓰는 창이 모두 놓은 뒤에만 끈다. 시뮬레이터 · 에뮬레이터는 끄지 않는다(계획서 지시 "보존")
// 떼어 내기 — 막대의 [새 창으로] 를 누르면 떼어 낸 서랍 창(drawer-window.mts — [웹] · [시뮬레이터] 두 탭)으로 옮긴다. iOS 페이지 뷰는 그 창에 붙고(다시 불러오지 않음),
// Android 화면 그림 · 누르기 · 쓸기는 그 창 화면이 같은 sim:* 채널로 부른다. 그 창을 닫으면(또는 [되돌리기]) 서랍이 그 창에서 보던 탭으로 돌아온다
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app, session, WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
import * as core from '../lib/core.mts'
import type { DrawerWindowCtx } from './drawer-window.mts'

type Rect = { x: number; y: number; width: number; height: number }
export type TouchPhase = 'down' | 'move' | 'up'

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
  // fromDetached — 떼어 낸 창 화면이 켠 · 끈 것. 조각은 켠 창에만 보내고, 끄기는 켠 창이 보낸 것만 받는다
  simStream?: (id: string, token: number, fromDetached?: boolean) => SimReply
  simStreamStop?: (fromDetached?: boolean) => void
  simTap?: (id: string, x: number, y: number) => Promise<SimReply>
  simSwipe?: (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => Promise<SimReply>
  simTouch?: (id: string, phase: TouchPhase, x: number, y: number) => void
  dropSim?: () => void
  send(channel: string, ...values: unknown[]): void
}

// 켜기(boot — heavy.sh 자리 기다림 포함) · serve-sim 첫 내려받기는 오래 걸린다
const BOOT_TIMEOUT = 10 * 60_000
const SERVE_TIMEOUT = 4 * 60_000
const QUICK_TIMEOUT = 60_000
const FRAME_TIMEOUT = 15_000
const SIM_PARTITION = 'athena-simulator'
// 영상 프로세스를 끄라고 한 뒤 이만큼 지나도 살아 있으면 강제로(기기 안 녹화를 끄는 adb 한 번을 기다린다)
const STREAM_KILL_MS = 6_000
// adb 일련번호 모양(emulator-5554 · 192.168.0.5:5555 · adb-…._adb-tls-connect._tcp) — 옵션으로 읽히지 않게 - 로 시작하면 안 된다
const SERIAL = /^[\w.:-]{1,200}$/
// 이어 누르기가 끊긴 뒤 다시 띄우기까지 쉬는 시간(그사이는 지금 방식)
const INPUT_RETRY_MS = 5_000
// 영상(sim.mjs stream)이 표준 오류로 알리는 지금 화면 크기 한 줄
const SIZE_LINE = /^size (\d{1,5}x\d{1,5})$/

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
  // Android 영상 — 이 창에 하나(다른 기기를 열거나 칸이 안 보이면 끈다)
  let streamProc: ChildProcess | null = null
  // 영상을 켠 곳이 떼어 낸 창인지(아니면 팩 창의 서랍)
  let streamFromDetached = false
  // 영상이 알린 그 기기의 지금 화면 크기(누르기 좌표용) — 영상을 끄면 비운다
  let streamSize: { id: string; size: string } | null = null
  // 이어 누르기(sim.mjs input) — 영상과 함께 띄우고 끈다. ready 전에는 쓰지 않는다
  let inputProc: ChildProcess | null = null
  let inputId = ''
  let inputReady = false
  let inputRetryAt = 0
  // 옛 코어(input 명령 없음)인 sim.mjs — 그 경로면 다시 띄우지 않는다
  let inputUnsupported = ''
  // 지금 끄는 손가락 — 시작점(지금 방식으로 떨어지면 뗄 때 swipe 로) · 이어 누르기로 보냈는지
  let gesture: { id: string; from: { x: number; y: number }; live: boolean } | null = null

  // sim.mjs 를 부를 node · 환경 — 옛 본체(코어 업데이트 전)는 도우미가 없다(null)
  const simCommand = () => {
    const script = path.join(ctx.athenaDir || '', 'scripts', 'sim.mjs')
    if (!ctx.athenaDir || !fs.existsSync(script)) return null
    const nodePath = core.findExecutable('node', process.env.PATH)
    const env = core.childEnv(process.env, nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' })
    return { node: nodePath || process.execPath, script, cwd: ctx.athenaDir, env }
  }

  const runSim = (args: string[], timeout = QUICK_TIMEOUT): Promise<SimReply> => new Promise((resolve) => {
    const command = simCommand()
    if (!command) return resolve({ ok: false, error: 'core-old' })
    execFile(command.node, [command.script, ...args, '--json'], { cwd: command.cwd, env: command.env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
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
    // 옛 창이 켠 Android 영상은 끈다(닫히는 창은 끄기를 보내지 못한다) — 새 창의 칸이 보이면 다시 켠다
    if (streamProc && streamFromDetached !== detached) stopStream()
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

  // 이어 누르기 끄기 — 표준 입력을 닫으면 sim.mjs 가 눌린 손가락을 떼고 기기 셸을 닫는다
  function stopInput(): void {
    const proc = inputProc
    inputProc = null
    inputId = ''
    inputReady = false
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    proc.stdin?.end()
    const force = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, STREAM_KILL_MS)
    proc.once('exit', () => clearTimeout(force))
  }

  // 이어 누르기 띄우기 — 그 기기 영상이 도는 동안만. 옛 코어 · 쉬는 중이면 띄우지 않는다(지금 방식)
  function startInput(id: string): void {
    if (inputProc && inputId === id) return
    stopInput()
    const command = simCommand()
    if (!command || inputUnsupported === command.script || Date.now() < inputRetryAt) return
    const size = streamSize && streamSize.id === id ? ['--size', streamSize.size] : []
    const proc = spawn(command.node, [command.script, 'input', '--platform', 'android', '--device', id, ...size, '--watch-stdin'], { cwd: command.cwd, env: command.env, stdio: ['pipe', 'pipe', 'ignore'] })
    inputProc = proc
    inputId = id
    proc.stdin?.on('error', () => {})
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (inputProc === proc && String(chunk).includes('ready')) inputReady = true
    })
    proc.on('error', () => {})
    proc.on('close', (code) => {
      // 인자 틀림(2)으로 연결 전에 끝났다 — input 이 없는 옛 코어
      if (code === 2) inputUnsupported = command.script
      if (inputProc !== proc) return
      inputProc = null
      inputId = ''
      inputReady = false
      inputRetryAt = Date.now() + INPUT_RETRY_MS
    })
  }

  // 이어 누르기로 한 줄 보내기 — 쓸 수 없으면 거짓(부른 쪽이 지금 방식으로)
  const sendInput = (id: string, line: string): boolean => {
    if (!inputProc || !inputReady || inputId !== id || !inputProc.stdin?.writable) {
      // 끊겼으면 다음을 위해 다시 띄운다(그 기기 영상이 도는 동안만)
      if (!inputProc && streamProc && streamSize?.id === id) startInput(id)
      return false
    }
    inputProc.stdin.write(`${line}\n`)
    return true
  }

  // 영상 끄기 — 표준 입력을 닫고 SIGTERM(sim.mjs 가 기기 안 녹화까지 끄고 끝난다) · 안 끝나면 강제로
  function stopStream(): void {
    stopInput()
    const proc = streamProc
    streamProc = null
    streamSize = null
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    proc.stdin?.end()
    proc.kill('SIGTERM')
    const force = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, STREAM_KILL_MS)
    proc.once('exit', () => clearTimeout(force))
  }

  // Android 영상 켜기 — 조각은 sim:video(token, 바이트), 끝나면 sim:video-end(token, 이유). token 은 화면이 정해 옛 영상 조각을 가린다.
  // 옛 코어(stream 명령 없음 — 인자 틀림 2 로 바로 끝)면 이유 'no-stream' → 화면이 그림 받기로 돌아간다
  ctx.simStream = (id, token, fromDetached = false) => {
    stopStream()
    // 조각 · 끝 알림은 켠 창에만 — 떼어 낸 창이 닫혔으면 버린다
    const send = (channel: string, ...values: unknown[]) => {
      if (!fromDetached) return ctx.send(channel, ...values)
      const win = detachedWin()
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...values)
    }
    if (!SERIAL.test(id) || id.startsWith('-')) return { ok: false, error: 'not-found' }
    const command = simCommand()
    if (!command) return { ok: false, error: 'core-old' }
    const proc = spawn(command.node, [command.script, 'stream', '--platform', 'android', '--device', id, '--watch-stdin'], { cwd: command.cwd, env: command.env, stdio: ['pipe', 'pipe', 'pipe'] })
    streamProc = proc
    streamFromDetached = fromDetached
    let received = false
    let reason = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      received = true
      send('sim:video', token, chunk)
    })
    let pendingErr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = (pendingErr + String(chunk)).split('\n')
      pendingErr = lines.pop() || ''
      for (const raw of lines) {
        const line = raw.trim()
        const size = SIZE_LINE.exec(line)
        if (size?.[1]) {
          if (streamProc !== proc) continue
          streamSize = { id, size: size[1] }
          // 이어 누르기에 지금 크기를(회전 · 해상도 바뀜) · 아직 안 띄웠으면 띄운다
          if (inputProc && inputId === id) inputProc.stdin?.write(`size ${size[1]}\n`)
          else startInput(id)
        } else if (line) reason = line.replace(/^❌\s*/, '')
      }
    })
    proc.on('error', (error) => {
      reason = error.message
    })
    proc.on('close', (code) => {
      if (pendingErr.trim()) reason = pendingErr.trim().replace(/^❌\s*/, '')
      // 끈 영상(다른 기기 · 칸 닫힘 · 창 닫힘)은 알리지 않는다
      if (streamProc !== proc) return
      streamProc = null
      streamSize = null
      send('sim:video-end', token, code === 2 && !received ? 'no-stream' : reason)
    })
    return { ok: true }
  }
  // 떼어 낼 때 · 돌아올 때 옛 창의 칸이 늦게 보낸 끄기가 새 창의 영상을 끄지 않게
  ctx.simStreamStop = (fromDetached = false) => {
    if (streamProc && streamFromDetached !== fromDetached) return
    stopStream()
  }

  // 그 기기 영상이 크기를 알렸으면 --size(목록 · 화면 크기 읽기 건너뛰기) · 아니면 sim.mjs 가 스스로 읽는다
  const knownSize = (id: string) => (streamSize && streamSize.id === id ? ['--size', streamSize.size] : [])
  ctx.simTap = async (id, x, y) => {
    if (sendInput(id, `tap ${x} ${y}`)) return { ok: true }
    return runSim(['tap', String(x), String(y), '--platform', 'android', '--device', id, ...knownSize(id)])
  }
  ctx.simSwipe = (id, from, to) => runSim(['swipe', String(from.x), String(from.y), String(to.x), String(to.y), '--platform', 'android', '--device', id, ...knownSize(id)])

  // 끄는 손가락 — 이어 누르기가 되면 누름 · 움직임 · 뗌을 그때그때. 안 되면 시작점을 기억했다가 뗄 때 swipe 한 번(지금 방식).
  // 손가락 하나의 도중에 갈래를 바꾸지 않는다(이어 누르기가 도중에 끊겨도 뗄 때 swipe 로 마저 — 기기는 sim.mjs 가 끝날 때 뗀다)
  ctx.simTouch = (id, phase, x, y) => {
    if (phase === 'down') {
      gesture = { id, from: { x, y }, live: sendInput(id, `down ${x} ${y}`) }
      return
    }
    if (!gesture || gesture.id !== id) return
    if (phase === 'move') {
      if (gesture.live) gesture.live = sendInput(id, `move ${x} ${y}`)
      return
    }
    const { from, live } = gesture
    gesture = null
    if (live && sendInput(id, `up ${x} ${y}`)) return
    void ctx.simSwipe?.(id, from, { x, y })
  }

  // 창이 닫혔다 — 떼어 둔 뷰를 닫고 서버를 놓는다(앱이 켠 서버는 쓰는 창이 없을 때만 꺼진다 · 시뮬레이터는 그대로)
  ctx.dropSim = () => {
    dropped = true
    stopStream()
    closeView()
    ctx.closeDrawer?.(false)
    if (usingServer) releaseServer(usingServer)
    usingServer = ''
  }
}
