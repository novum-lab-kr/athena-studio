// ── 현황판 · 사람에게 묻는 요청 · [작업] 팝업 — 팩 창 ──────────────────
// main.js createPackWindow 에서 옮겼다(PR3f) — 화면 문구(say) · 코어 명령(runCore · runPack) · 현황판 띄우기 · 끄기(startBoard · stopStaleBoard) ·
// 메뉴 막대 알리기(trayRequestsChanged) · 앱 설정(appConfig · saveAppConfig)은 인자로 받는다.
// 이 창 현황판 포트(packBoardPort)와 요청 목록(requestsState)은 main.mts 의 창 변수 그대로 — 데몬 연결 · pane [상세] · 팩 바꾸기도 읽고 쓴다(읽기 · 쓰기 함수로 받는다).
// ctx 에 같은 이름(boardPortNow · openBoardExternal · ensureBoard · refreshRequests · requestsNow · stopRequests · watchRequests · workState ·
// answerRequest · redeliverRequest · openPlan · openBoardSection · openDiagrams · workDetail · prepareBoardPort)으로 붙인다
import fs from 'node:fs'
import path from 'node:path'
import { dialog, shell } from 'electron'
import type { BrowserWindow, MessageBoxOptions } from 'electron'
import * as core from '../lib/core.mts'
import * as packModel from '../lib/pack.mts'
import * as requestsModel from '../lib/requests.mts'
import * as workModel from '../lib/work-model.mts'
import { isBoardUp, queueBoard, boardOwner, boardJson, fetchBoardJson } from './board.mts'
import type { BoardStart } from './board.mts'
import type { PackResult, Say } from '../lib/pack.mts'
import type { RunCoreOptions } from './core-runner.mts'
import type { StudioRequest } from '../lib/requests.mts'

// error — 마지막 읽기가 실패한 까닭(코어 오류 코드) · 성공하면 null. "요청 없음" 과 "읽지 못함" 을 화면이 가르게
export type RequestsState = { supported: boolean; requests: StudioRequest[]; error: string | null }
type RunCore = (args: string[], options: RunCoreOptions) => Promise<PackResult>
// 현황판을 찾거나 띄운 결과(ensureBoard) — 성공 · 실패 모두 url, 실패면 error(띄우다 실패했으면 log 도)
type BoardResult = { ok: boolean; url: string; started?: boolean; error?: string; log?: string }
// 현황판 /api/state · /api/card 에서 읽는 칸만
type BoardState = { cards?: unknown }
type BoardCard = { text?: unknown; templateLines?: unknown }
type PaneListReply = { result?: { panes?: unknown } }

// 팩 창 문맥(main.mts createPackWindow) 중 현황판 · 요청 · [작업] 이 읽는 것 · 붙이는 것
export type WorkCtx = {
  athenaDir: string | null
  win: BrowserWindow | null
  send(channel: string, ...values: unknown[]): void
  peekCall(op: string, args?: Record<string, unknown>): Promise<unknown>
  notifyDaemon(op: string, args: Record<string, unknown>): unknown
  boardPortNow?: () => number
  openBoardExternal?: () => Promise<{ ok: boolean }>
  ensureBoard?: () => Promise<BoardResult>
  refreshRequests?: () => Promise<RequestsState>
  requestsNow?: () => RequestsState
  stopRequests?: () => void
  watchRequests?: () => void
  workState?: unknown
  answerRequest?: unknown
  redeliverRequest?: unknown
  openPlan?: unknown
  openInBrowser?: (url: string) => void
  openBoardSection?: unknown
  openDiagrams?: unknown
  workDetail?: unknown
  prepareBoardPort?: () => void
}

type WorkDeps = {
  say: Say
  runCore: RunCore
  runPack: RunCore
  startBoard: (port: number, athenaDir: string) => Promise<BoardStart>
  stopStaleBoard: (port: number, athenaDir: string) => Promise<boolean>
  waitCoreUpdate: () => Promise<void> // 코어 업데이트가 도는 동안 기다린다(옛 코어로 현황판을 띄운 뒤 업데이트가 끄지 않게)
  reloadKey: () => string
  requestsPollMs: number
  trayRequestsChanged: (ctx: WorkCtx) => void
  appConfig: () => { boardPort: number }
  saveAppConfig: (next: { boardPort: number }) => void
  packBoardPort: () => number | null
  setPackBoardPort: (port: number | null) => void
  requestsState: () => RequestsState
  setRequestsState: (next: RequestsState) => void
  // 요청 목록을 못 읽었을 때 한 줄(pack.log) — 같은 오류가 이어지면 한 번만
  logRequestsError: (line: string) => void
}

export function installWork(ctx: WorkCtx, deps: WorkDeps): void {
  const { say, runCore, runPack, startBoard, stopStaleBoard, waitCoreUpdate, reloadKey, requestsPollMs, trayRequestsChanged, appConfig, saveAppConfig, packBoardPort, setPackBoardPort, requestsState, setRequestsState, logRequestsError } = deps
  const send = ctx.send
  // ctx 에 붙인 것을 이 안에서 부를 때(옛 main.js 처럼 ctx 로 찾는다)
  const ensureBoard = () => (ctx.ensureBoard as NonNullable<WorkCtx['ensureBoard']>)()
  const refreshRequests = () => (ctx.refreshRequests as NonNullable<WorkCtx['refreshRequests']>)()
  const openBoardExternal = () => (ctx.openBoardExternal as NonNullable<WorkCtx['openBoardExternal']>)()

  // ── 현황판 ──
  // 지금 현황판 포트 — 팩 지원 본체면 본체가 정한 값(pack status · 본체마다 다르다), 옛 본체면 앱 설정
  const boardPortNow = () => packBoardPort() || appConfig().boardPort
  ctx.boardPortNow = boardPortNow

  // 현황판을 띄우거나(이미 떠 있으면 그대로) 기본 브라우저로 연다 — 못 열면 이 창에 알린다
  ctx.openBoardExternal = async () => {
    const result = await ensureBoard()
    if (result.ok) {
      await shell.openExternal(result.url)
      return { ok: true }
    }
    const detail = [result.error, result.log && say('board.logLine', { log: result.log })].filter(Boolean).join('\n')
    const options: MessageBoxOptions = { type: 'warning', message: say('board.openFailed'), detail }
    if (ctx.win && !ctx.win.isDestroyed()) dialog.showMessageBox(ctx.win, options)
    else dialog.showMessageBox(options)
    return { ok: false }
  }

  ctx.ensureBoard = async () => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return { ok: false, url: core.boardUrl(boardPortNow()), error: say('error.athenaDirMissing') }
    await waitCoreUpdate()
    // 기다리는 사이 팩을 바꿨을 수 있다 — 줄에 들어갈 때 다시 읽는다
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return { ok: false, url: core.boardUrl(boardPortNow()), error: say('error.athenaDirMissing') }
    return queueBoard(() => findOrStartBoard(ctx.athenaDir as string))
  }

  // ── 사람에게 묻는 요청 · [작업] 팝업 데이터 ──
  // 요청은 코어 명령(request list)으로 읽는다 — 현황판이 꺼져 있어도 센다. 요청 폴더(팩 데이터 state/requests · 옛 구조 .requests)가
  // 바뀌면 바로, 놓칠 때를 대비해 REQUESTS_POLL_MS 마다. request 명령이 없는 옛 코어면 supported:false(요청 없음)
  let requestsWatch: fs.FSWatcher | null = null
  let requestsTimer: NodeJS.Timeout | undefined
  let requestsKick: NodeJS.Timeout | undefined
  let requestsBusy: Promise<RequestsState> | null = null
  let requestsAgain = false
  ctx.refreshRequests = async () => {
    if (requestsBusy) {
      requestsAgain = true
      return requestsBusy
    }
    const dir = ctx.athenaDir
    if (!core.checkAthenaDir(dir).ok) return requestsState()
    requestsBusy = (async () => {
      const next = requestsModel.normalizeRequests(await runCore(['request', 'list'], { dir }))
      // 그새 팩을 바꿨으면 버린다
      if (dir !== ctx.athenaDir) return requestsState()
      const before = requestsState()
      const error = next.error ? String(next.error) : null
      if (error && error !== before.error) logRequestsError(`list failed ${error} supported=${next.supported}`)
      // 일시 실패(잠금 · 시간 초과)면 지난 목록을 그대로 두되 실패는 알린다 — 옛 코어(supported:false)는 목록을 비운다
      const requests = error && next.supported ? before.requests : next.requests
      const changed = next.supported !== before.supported || error !== before.error || JSON.stringify(requests) !== JSON.stringify(before.requests)
      setRequestsState({ supported: next.supported, requests, error })
      if (changed) {
        send('work:requests', requestsState())
        trayRequestsChanged(ctx)
      }
      return requestsState()
    })()
    try {
      return await requestsBusy
    } finally {
      requestsBusy = null
      if (requestsAgain) {
        requestsAgain = false
        refreshRequests()
      }
    }
  }
  // 요청 폴더 감시 — 폴더는 첫 요청이 생길 때 만들어지므로, 없으면 주기마다 다시 걸어 본다
  const watchRequestsDir = () => {
    if (requestsWatch || !ctx.athenaDir) return
    for (const dir of [path.join(ctx.athenaDir, '.pack-data', 'state', 'requests'), path.join(ctx.athenaDir, '.requests')]) {
      try {
        const watcher = fs.watch(fs.realpathSync(dir), () => {
          clearTimeout(requestsKick)
          requestsKick = setTimeout(() => refreshRequests(), 300)
        })
        requestsWatch = watcher
        watcher.on('error', () => {
          if (requestsWatch) requestsWatch.close()
          requestsWatch = null
        })
        return
      } catch {}
    }
  }
  ctx.requestsNow = () => requestsState()
  ctx.stopRequests = () => {
    if (requestsWatch) requestsWatch.close()
    requestsWatch = null
    clearInterval(requestsTimer)
    clearTimeout(requestsKick)
  }
  // 창이 본체를 열 때 · 다른 팩으로 다시 묶을 때 — 지난 팩의 요청은 지우고 새로 읽는다
  ctx.watchRequests = () => {
    ;(ctx.stopRequests as NonNullable<WorkCtx['stopRequests']>)()
    setRequestsState({ supported: false, requests: [], error: null })
    send('work:requests', requestsState())
    if (!ctx.athenaDir) return
    watchRequestsDir()
    requestsTimer = setInterval(() => {
      watchRequestsDir()
      refreshRequests()
    }, requestsPollMs)
    refreshRequests()
  }

  // [작업] 팝업 — 현황판을 띄우고(이미 떠 있으면 그대로) 카드를 읽어 목록으로. 요청은 그때 한 번 더 읽는다
  ctx.workState = async () => {
    const board = await ensureBoard()
    const state = board.ok ? ((await fetchBoardJson(boardPortNow(), '/api/state')) as BoardState | null) : null
    const requests = await refreshRequests()
    return {
      supported: requests.supported,
      requestsError: requests.error,
      requests: requests.requests.map((request) => ({ ...request, waited: requestsModel.waitedLabel(request.createdAt, Date.now(), say) })),
      boardUp: Boolean(state),
      boardError: board.ok ? null : board.error || null,
      ...workModel.workList(state && Array.isArray(state.cards) ? state.cards : [], requests.requests),
    }
  }
  // 답을 그 pane 에 한 줄로 넣는다 — 에이전트는 [요청 <id>] 를 보고 ack 한다. pane 이 지금 없으면 false(답은 저장돼 있다 · 다시 보내기)
  const deliverToPane = async (paneId: unknown, line: string) => {
    if (!paneId) return false
    const listed = (await ctx.peekCall('pane list')) as PaneListReply
    const panes: { id?: unknown }[] = listed.result && Array.isArray(listed.result.panes) ? listed.result.panes : []
    if (!panes.some((pane) => pane.id === paneId)) return false
    ctx.notifyDaemon('input', { pane: paneId, data: line })
    // 입력창이 붙여 넣은 글을 받은 뒤에 Enter — 같이 보내면 줄바꿈으로 들어가는 에이전트가 있다
    await new Promise((resolve) => setTimeout(resolve, 150))
    ctx.notifyDaemon('input', { pane: paneId, data: '\r' })
    return true
  }
  // 앱에서 답하기 — 코어에 답을 적고(본 rev 그대로 — 그사이 바뀌었으면 conflict) 그 pane 에 넣는다
  ctx.answerRequest = async (id: string, answer: { choice?: unknown; text?: unknown; rev?: unknown } | null) => {
    const known = requestsState().requests.find((request) => request.id === id)
    if (!known) return { ok: false, error: 'not-found' }
    // 대화상자가 보여 준 요청이 그사이 바뀌었으면 다른 내용에 답이 붙지 않게 코어를 부르지 않는다. 같으면 known.rev 가 곧 받은 rev 다
    if (requestsModel.answerRevChanged(answer && answer.rev, known.rev)) {
      refreshRequests()
      return { ok: false, error: 'conflict' }
    }
    // 코어 request answer 결과 — 적힌 요청의 answer 만 더 읽는다
    const result = (await runCore(requestsModel.answerArgs(id, { choice: answer && answer.choice, text: answer && answer.text, rev: known.rev }), { dir: ctx.athenaDir })) as PackResult & { request?: { answer?: { choice?: unknown; text?: unknown } | null } }
    if (!result.ok || !result.request) {
      refreshRequests()
      return { ok: false, error: result.error || 'failed', message: result.message || '' }
    }
    const delivered = await deliverToPane(known.pane, requestsModel.deliveryLine(known, result.request.answer || {}))
    refreshRequests()
    return { ok: true, delivered }
  }
  // 답은 했는데 전달 못 한 것(answered) — 다시 보내기
  ctx.redeliverRequest = async (id: string) => {
    const known = requestsState().requests.find((request) => request.id === id && request.state === 'answered')
    if (!known || !known.answer) return { ok: false, error: 'not-found' }
    return { ok: true, delivered: await deliverToPane(known.pane, requestsModel.deliveryLine(known, known.answer as { choice?: unknown; text?: unknown })) }
  }
  // 계획서 열기 — 결정 콘솔(html)이 있으면 현황판 주소를 이 창 옆 브라우저에, 없으면 md 를 기본 앱으로
  ctx.openPlan = async (id: string, html: string | null) => {
    const safe = (value: unknown, ext: string): value is string => typeof value === 'string' && value.startsWith('plans/') && value.endsWith(ext) && !value.split('/').includes('..')
    if (safe(html, '.html')) {
      const board = await ensureBoard()
      const url = board.ok ? `${board.url.replace(/\/$/, '')}/${html.split('/').map(encodeURIComponent).join('/')}` : null
      if (url && ctx.openInBrowser) {
        ctx.openInBrowser(url)
        return null
      }
      if (url) return shell.openExternal(url)
    }
    if (safe(id, '.md') && ctx.athenaDir) return shell.openPath(path.join(ctx.athenaDir, id))
    return null
  }
  // 현황판 페이지(칸반 · QA · 학습 · 지표 · 아카이브) — 현황판 탭 이름을 주소 끝 #<탭> 으로
  const BOARD_SECTIONS = ['now', 'qa', 'learn', 'metrics', 'history']
  ctx.openBoardSection = async (section: string) => {
    const result = await ensureBoard()
    if (!result.ok) return openBoardExternal()
    return shell.openExternal(`${result.url.replace(/\/$/, '')}/${BOARD_SECTIONS.includes(section) && section !== 'now' ? `#${section}` : ''}`)
  }
  // 다이어그램 목록 — 이 창 본체의 docs/diagrams/index.html 을 기본 앱으로(/guide 그림 과 같은 파일 · 같은 방식). 없으면 missing
  ctx.openDiagrams = async () => {
    if (!ctx.athenaDir) return { ok: false, error: 'missing' }
    const file = path.join(ctx.athenaDir, 'docs', 'diagrams', 'index.html')
    if (!fs.existsSync(file)) return { ok: false, error: 'missing' }
    const failure = await shell.openPath(file)
    return failure ? { ok: false, error: 'failed', message: failure } : { ok: true }
  }

  // 작업 상세 — 계획서 원문(현황판 /api/card)에서 몇 줄만. plans/ 안의 .md 만
  ctx.workDetail = async (id: string) => {
    if (!/^plans\/[^\0]+\.md$/.test(id) || id.split('/').includes('..')) return { ok: false, error: 'bad-id' }
    const card = (await fetchBoardJson(boardPortNow(), `/api/card?id=${encodeURIComponent(id)}`)) as BoardCard | null
    if (!card || typeof card.text !== 'string') return { ok: false, error: 'not-found' }
    return { ok: true, id, ...workModel.planDetail(card.text, Array.isArray(card.templateLines) ? card.templateLines.filter((line): line is string => typeof line === 'string') : []) }
  }

  // 현황판은 띄우지 않고 포트만 미리 정해 적는다(창을 열 때 · 아테나 폴더를 정할 때) — 현황판 탭을 열기 전에도 아테나가 콘솔을 맞는 포트로 띄우게.
  // 팩 지원 본체면 포트는 본체가 정하니 읽기만 하고 본체 설정에 쓰지 않는다(setAthenaBoardPort 는 옛 본체에서만)
  ctx.prepareBoardPort = () => {
    if (!core.checkAthenaDir(ctx.athenaDir).ok) return
    const dir = ctx.athenaDir as string
    queueBoard(async () => {
      if (await refreshPackStatus(dir)) return null
      return findBoardPort(dir)
    }).catch(() => {})
  }

  // 옛 본체 — 저장된 포트부터 차례로. 이 아테나 폴더에서 도는 현황판이면 그대로 쓰고, 비었으면 거기 띄우고, 다른 것이 쥐고 있으면 다음 번호
  async function findBoardPort(dir: string): Promise<{ error: string } | { port: number; owner: 'ours' | 'free' }> {
    const ports = core.boardPortCandidates(appConfig().boardPort)
    for (const port of ports) {
      const owner = await boardOwner(port, dir)
      if (owner === 'other') continue
      // 찾는 사이 아테나 폴더가 바뀌었으면 이 결과는 버린다
      if (ctx.athenaDir !== dir) return { error: say('error.athenaDirChanged') }
      const saved = rememberBoardPort(port, dir)
      if (saved.error) return { error: saved.error }
      return { port, owner }
    }
    return { error: say('error.boardPortsBusy', { from: ports[0], to: ports[ports.length - 1] }) }
  }

  async function findOrStartBoard(dir: string): Promise<BoardResult> {
    const result = await findOrStartBoardFor(dir)
    // 띄우거나 기다리는 사이 아테나 폴더가 바뀌었으면 예전 폴더의 현황판을 보여 주지 않는다
    if (ctx.athenaDir !== dir) return { ok: false, url: core.boardUrl(boardPortNow()), error: say('error.athenaDirChangedReload', { key: reloadKey() }) }
    return result
  }

  // 팩 지원 본체인지 · 현황판 포트 — pack status(가볍다). 옛 본체면 null
  async function refreshPackStatus(dir: string): Promise<{ boardPort: number; current: { id?: unknown; generation?: unknown } | null } | null> {
    const status = await runPack(['status'], { dir })
    setPackBoardPort(packModel.statusBoardPort(status))
    const port = packBoardPort()
    // current 도 같이 — 현황판 판단은 방금 읽은 이 값으로(목록을 못 읽었거나 시작 직후에도 멀쩡한 현황판을 끄지 않게)
    return port ? { boardPort: port, current: (status.current as { id?: unknown; generation?: unknown } | undefined) || null } : null
  }

  // 팩 지원 본체의 현황판 — 포트는 본체가 정한다(본체 하나에 현황판 하나). 떠 있는 현황판이 이 본체 팩 · 세대 것이면
  // 누가 띄웠든(board.sh · 스튜디오) 같이 쓰고, 다른 팩 것이면 토큰으로 끄고 다시 띄운다. 그 포트를 현황판이 아닌 것이 쥐고 있으면 오류
  async function packBoard(port: number, dir: string, current: { id?: unknown; generation?: unknown } | null): Promise<BoardResult> {
    const url = core.boardUrl(port)
    if (await isBoardUp(port)) {
      const reply = await boardJson(port, '/api/state')
      if (reply.status !== 200 || !reply.body) return { ok: false, url, error: say('error.boardStateUnreadable', { port, key: reloadKey() }) }
      if (packModel.boardIdentity(reply.body as { pack?: unknown }, current) !== 'stale') return { ok: true, url, started: false }
      if (await stopStaleBoard(port, dir)) return startBoard(port, dir)
      return { ok: false, url, error: say('error.boardStaleStopFailed', { port }) }
    }
    if ((await boardOwner(port, dir)) === 'free') return startBoard(port, dir)
    return { ok: false, url, error: say('error.boardPortBusyCore', { port }) }
  }

  async function findOrStartBoardFor(dir: string): Promise<BoardResult> {
    const status = await refreshPackStatus(dir)
    if (status) return packBoard(status.boardPort, dir, status.current)
    // 옛 본체 — 지금까지처럼 앱 설정 boardPort 부터 비어 있는 포트를 골라 적는다
    const found = await findBoardPort(dir)
    if ('error' in found) return { ok: false, url: core.boardUrl(appConfig().boardPort), error: found.error }
    if (found.owner === 'free') return startBoard(found.port, dir)
    const url = core.boardUrl(found.port)
    if (await isBoardUp(found.port)) return { ok: true, url, started: false }
    return { ok: false, url, error: say('error.boardNoAnswer', { port: found.port }) }
  }

  // 아테나 설정에 먼저 적고, 되면 앱 설정에 — 둘이 다른 포트를 가리키지 않게(옛 본체만)
  function rememberBoardPort(port: number, dir: string): { error?: string } {
    try {
      core.setAthenaBoardPort(dir, port)
    } catch (error) {
      return { error: say('error.boardPortSave', { message: (error as Error).message }) }
    }
    if (appConfig().boardPort !== port) saveAppConfig({ ...appConfig(), boardPort: port })
    return {}
  }
}
