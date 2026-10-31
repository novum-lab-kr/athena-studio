// ── 데몬 연결 — 창마다 하나, 이 창의 본체로 묶인다(protocol 5) ──
// main.js 에서 옮겼다(PR3e) — createPackWindow 의 ctx 에 같은 이름으로 붙인다(installDaemonLink).
// 쓰는 것(화면 문구 · 데몬 자리 · 데몬 오류 글 · 다시 띄우기 묻기 · 옛 데몬 표시 · 미뤄 둔 창 열기 · 링크 열기)은 인자로 받는다
import * as core from '../lib/core.mts'
import * as daemonClient from '../daemon-client.mts'
import type { Reply } from '../daemon-client.mts'
import type { Say } from '../lib/pack.mts'
import type { Tree } from '../lib/layout.mts'
import { MONITOR_LABEL } from './monitor-logs.mts'

type Ensured = Awaited<ReturnType<typeof daemonClient.ensureDaemon>>
type Connection = Ensured['connection']
type Window = import('electron').BrowserWindow
// 데몬 요청 결과 — 성공이면 result, 실패면 error(글) · code. result 모양은 부르는 쪽이 읽는 칸만 적는다
export type Called<T = unknown> = { result?: T; error?: string; code?: unknown }
export type DaemonCall = <T = unknown>(op: string, args?: object) => Promise<Called<T>>
// 데몬 pane 목록(pane list) 한 줄 — 읽는 칸만
export type DaemonPane = { id: string; tab_id?: string | null; label?: string; name?: string; title?: string; agent?: string | null; agent_status?: string; cwd?: string; foreground_cwd?: string }
// 데몬 화면 상태(state) — 읽는 칸만
export type DaemonState = { workspaces: { id: string; label?: unknown; cwd?: string }[]; tabs: { id: string; workspace: string; tree: Tree | null }[] }

// 화면이 넘기는 pane 크기(cols · rows) — 그대로 데몬에 넘긴다
export type Size = Record<string, unknown> | undefined

// 팩 창 문맥(main.mts createPackWindow 의 ctx) — 이 파일들이 읽는 칸 · 붙이는 칸만
export type PackCtx = {
  athenaDir: string | null
  win: Window | null
  packState: { current?: { id?: string; name?: string; displayName?: string } | null }
  packBusy: unknown
  send(channel: string, ...args: unknown[]): void
  // 데몬 연결(daemon-link)
  connectDaemon(): Promise<Connection>
  isAttached(): boolean
  attachScreen(): Promise<unknown>
  detachScreen(): Promise<void>
  daemonCall: DaemonCall
  peekCall(op: string, args?: object): Promise<Called>
  notifyDaemon(op: string, args?: object): unknown
  resizePane(paneId: string, cols: number, rows: number): void
  screenDetached(): boolean
  // 작업 공간(workspaces)
  openWorkspaceDir(dir: string, size: Size): Promise<Called>
  // 다른 묶음이 붙이는 것 — 부를 때 찾는다
  packRepos(): Promise<{ name: string; linked?: boolean; displayName?: unknown; iconPath?: unknown }[]>
  packTask<T>(name: string, work: () => Promise<T>): Promise<T>
  catchUpBody(panes: DaemonPane[] | null, options?: { force?: boolean }): Promise<{ ok: boolean; same?: boolean; reason?: string } | null>
  boardPortNow(): number
  requestsNow(): { requests: { id: string; state: string; plan?: string; pane?: string; kind?: string; title?: string }[] }
  [name: string]: unknown
}

type LinkDeps = {
  say: Say
  daemonPaths: () => Parameters<typeof daemonClient.ensureDaemon>[0]['paths']
  daemonErrorText: (error: Error & { code?: unknown }) => string
  askRestartDaemon: (result: Ensured, parentWindow: Window | null) => Promise<boolean>
  setDaemonOld: (old: boolean) => void
  noticeOldCode: (connection: Connection, parentWindow: Window | null) => void
  releaseHeldWindows: () => void
  openUrl: (ctx: PackCtx, url: string) => void
}

// say — 화면 문구 · daemonPaths — 데몬 자리 · daemonErrorText — 데몬 오류를 화면 글로 · askRestartDaemon — 프로토콜이 다를 때 묻기(창이 여럿이어도 한 번) ·
// setDaemonOld — 옛 데몬에 붙어 쓰는 중인지(main.mts daemonOld) · noticeOldCode — 코드 판이 낮은 데몬 안내 · releaseHeldWindows — 맞는 데몬이면 미뤄 둔 창 열기 · openUrl — 데몬 open-url 알림
export function installDaemonLink(ctx: PackCtx, { say, daemonPaths, daemonErrorText, askRestartDaemon, setDaemonOld, noticeOldCode, releaseHeldWindows, openUrl }: LinkDeps): void {
  const send = ctx.send
  let daemon: Connection | null = null // DaemonConnection
  let connecting: Promise<Connection> | null = null
  const outputQueue = new Map<string, string>() // paneId → 모아 둔 출력(8ms 마다 한 번에 보낸다)
  let flushTimer: NodeJS.Timeout | null = null
  let dropOutput = false // attach 답이 오기 전 출력 — 되살릴 화면에 이미 들어 있다
  let screenDetached = false

  function onDaemonEvent(current: () => Connection | null, message: Reply & { pane?: string; data?: string; state?: unknown; url?: unknown }) {
    // 이미 떼어 낸 옛 연결의 알림은 버린다(새 연결이 붙기 전이어도) — 새 연결과 같이 오면 출력이 두 번 찍힌다(gh170). 아직 묶이지 않은 연결(from 없음)은 받는다
    const from = current()
    if (from && from !== daemon) return
    if (message.event === 'data') {
      if (dropOutput) return
      outputQueue.set(message.pane as string, (outputQueue.get(message.pane as string) || '') + message.data)
      if (!flushTimer) flushTimer = setTimeout(flushOutput, 8)
    } else if (message.event === 'state') {
      flushOutput() // 배치가 바뀌기 전 출력부터
      send('screen:state', message.state)
    } else if (message.event === 'exit') {
      flushOutput()
      send('pane:exit', message.pane)
    } else if (message.event === 'resync') {
      send('screen:resync')
    } else if (message.event === 'open-url' && typeof message.url === 'string') {
      openUrl(ctx, message.url) // 아테나 화면 계층 open-url — 계획서 · 선택 화면을 이 창 옆 브라우저로(localhost 아니면 기본 브라우저)
    }
  }

  function flushOutput() {
    clearTimeout(flushTimer as NodeJS.Timeout)
    flushTimer = null
    for (const [paneId, data] of outputQueue) send('pane:data', paneId, data)
    outputQueue.clear()
  }

  // 연결이 끊기면 화면에 알린다(앱이 스스로 끊은 detachScreen 은 daemon 을 먼저 비운다)
  // 지금 연결이 아닌 것의 닫힘은 새 연결이 붙었거나 붙는 중이면 아무것도 건드리지 않는다 — 살아 있는 새 연결을 잃으면 다음 요청이 연결을 하나 더 만든다(gh170)
  // 새 연결이 없을 때 앱이 스스로 끊은 연결의 닫힘은 알린다(데몬 다시 띄우기가 끊김 알림 뒤 resync 를 보낸다)
  function onDaemonClosed(closed: Connection | null) {
    if (closed !== daemon && (daemon || connecting)) return
    daemon = null
    screenDetached = true
    send('screen:disconnected')
  }

  ctx.connectDaemon = () => {
    if (daemon) return Promise.resolve(daemon)
    if (connecting) return connecting
    connecting = (async () => {
      const paths = daemonPaths()
      // ensureDaemon 호출마다 따로 — 알림 · 닫힘이 어느 연결 것인지 가린다(버전 확인으로 다시 붙을 때 첫 연결의 닫힘이 둘째 것으로 읽히지 않게)
      const optionsFor = () => {
        let own: Connection | null = null
        return {
          paths,
          env: core.childEnv(process.env),
          onEvent: (message: Reply) => onDaemonEvent(() => own, message),
          onClose: () => onDaemonClosed(own),
          bind: (connection: Connection) => (own = connection),
        }
      }
      const connect = async () => {
        const { bind, ...options } = optionsFor()
        const ensured = await daemonClient.ensureDaemon(options)
        bind(ensured.connection)
        return ensured
      }
      let result = await connect()
      if (result.status === 'mismatch' && (await askRestartDaemon(result, ctx.win))) result = await connect()
      if (result.status === 'ok') {
        setDaemonOld(false)
        releaseHeldWindows()
      } else if (result.status === 'mismatch') setDaemonOld(true)
      daemon = daemon || result.connection
      // 말은 맞지만 코드가 낮고 바꿔 끼우지 못했다 — 알리기만 한다(기다리지 않는다 · 끄지 않는다)
      if (result.status === 'ok' && result.code !== 'current') noticeOldCode(daemon, ctx.win)
      return daemon
    })().finally(() => (connecting = null))
    return connecting
  }
  ctx.isAttached = () => Boolean(daemon)

  // 화면이 붙는다 — 지금 상태 + pane 마다 되살릴 화면. 이 뒤로 실시간 출력이 이어진다
  ctx.attachScreen = async () => {
    const check = core.checkAthenaDir(ctx.athenaDir)
    if (!check.ok) return { error: say('error.athenaDirMissing') }
    try {
      const connection = await ctx.connectDaemon()
      flushOutput()
      dropOutput = true
      try {
        // 이 창의 본체로 묶는다(protocol 5) — 다른 팩 창의 작업 공간 · 출력은 오지 않는다
        const attached = await connection.call('attach', { body: core.realDir(ctx.athenaDir as string) }, () => {
          dropOutput = false
          outputQueue.clear()
        })
        screenDetached = false
        // 예전 터미널 모니터 칸이 남아 있으면 닫는다(이제 모니터는 앱 화면)
        closeMonitorDock().catch(() => {})
        return attached
      } finally {
        dropOutput = false
      }
    } catch (error) {
      return { error: say('error.daemonConnect', { message: daemonErrorText(error as Error) }) }
    }
  }

  // 창 닫기 · 앱 종료 — 연결만 끊는다(데몬·셸·에이전트는 계속 돈다)
  // 옛 연결이 실제로 닫히면 풀린다 — 닫힘 알림(screen:disconnected)이 다음 screen:resync 보다 늦게 가지 않게 기다릴 수 있다
  ctx.detachScreen = () => {
    if (!daemon) return Promise.resolve()
    const current = daemon
    daemon = null
    return current.close()
  }

  const daemonCall: DaemonCall = async <T,>(op: string, args?: object) => {
    try {
      const connection = await ctx.connectDaemon()
      return { result: (await connection.call(op, args)) as T }
    } catch (error) {
      return { error: daemonErrorText(error as Error), code: (error as { code?: unknown }).code }
    }
  }
  ctx.daemonCall = daemonCall
  // 메뉴 막대 폴링 전용 — 이미 붙은 연결로만 묻는다(daemonCall 은 끊겼으면 데몬을 다시 띄우거나 버전 확인창을 띄운다)
  ctx.peekCall = async (op, args = {}) => {
    const connection = daemon
    if (!connection) return { error: say('tray.daemonOffline') }
    try {
      return { result: await connection.call(op, args) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }
  ctx.notifyDaemon = (op, args) => daemon && daemon.notify(op, args)
  // pane 크기 — 답을 받는 그 자리(같은 소켓의 뒤 출력보다 먼저)에서 앞 출력을 내보내고 화면에 '적용됨'을 알린다.
  // 화면은 그 알림을 받아 앞 출력을 다 읽은 뒤 xterm 크기를 바꾼다 — 데몬이 pty 를 바꾼 출력 지점과 같다(데몬 버퍼도 앞 출력을 다 읽은 뒤 바꾼다 · Pane.resize).
  // 데몬이 스스로 바꾸는 크기(분할 · pane 종료의 fitTab)는 알리지 않는다 — 곧 화면이 자기 크기를 다시 요청한다
  ctx.resizePane = (paneId, cols, rows) => {
    if (!daemon) return
    daemon
      .call('resize', { pane: paneId, cols, rows }, (reply) => {
        if (!reply.ok) return
        flushOutput()
        send('pane:resized', paneId, cols, rows)
      })
      .catch(() => {})
  }
  ctx.screenDetached = () => screenDetached

  // 예전엔 데몬 고정 칸에서 agent-monitor.py 를 돌렸다 — 남아 있으면 닫는다(보기만 하는 칸이라 잃는 것이 없다)
  async function closeMonitorDock() {
    const listed = await daemonCall<{ panes: DaemonPane[] }>('pane list')
    for (const pane of (listed.result && listed.result.panes) || []) {
      if (!pane.tab_id && pane.label === MONITOR_LABEL) await daemonCall('pane close', { pane: pane.id })
    }
  }
}
