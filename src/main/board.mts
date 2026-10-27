// ── 일감 — 공용 도우미 ────────────────────────────────────
// main.js 에서 옮겼다(PR3b) — 화면 문구(say) · 일감 로그 자리 · 데몬 자리 · 팩 명령(runPack)은 createBoard 인자로 받는다
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import * as core from '../lib/core.mts'
import { CLI } from '../daemon-client.mts'
import type { Say } from '../lib/pack.mts'

export type BoardStart = { ok: true; url: string; started: boolean } | { ok: false; url: string; error: string; log: string }
export type BoardReply = { status: number; body: unknown }
type RunPack = (args: string[], options: { dir: string }) => Promise<{ ok?: unknown; token?: unknown }>

export function isBoardUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (response) => {
      response.resume()
      resolve((response.statusCode as number) < 500)
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

// scripts/board.sh 는 브라우저를 열므로 쓰지 않고 server.mjs 를 직접 띄운다.
// 앱을 닫아도 일감은 계속 돈다(board.sh 의 백그라운드 실행과 같다)
// 포트 정하기 · 띄우기가 겹치지 않게 한 줄로 세운다(창이 여럿이어도 — 포트를 서로 고르다 겹치지 않게)
let boardQueue: Promise<unknown> = Promise.resolve()
export function queueBoard<T>(work: () => T | Promise<T>): Promise<T> {
  const run = boardQueue.then(work)
  boardQueue = run.catch(() => {})
  return run
}

// 그 포트를 쥔 프로세스가 이 아테나 폴더에서 돌면 ours, 아무도 없으면 free, 다른 폴더이거나 알아볼 수 없으면 other(쓰지 않는다).
// 맥은 lsof 로 그 프로세스의 작업 폴더를 본다
const LSOF = '/usr/sbin/lsof'

export async function boardOwner(port: number, athenaDir: string): Promise<'ours' | 'free' | 'other'> {
  const listening = await runLsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  if (listening.failed) return 'other'
  const pid = listening.stdout.split('\n').find(Boolean)
  if (!pid) return 'free'
  const where = await runLsof(['-a', '-p', pid, '-d', 'cwd', '-Fn'])
  const cwd = where.failed ? null : core.parseLsofPath(where.stdout)
  return cwd && core.sameDir(cwd, athenaDir) ? 'ours' : 'other'
}

// lsof 는 찾은 것이 없으면 종료 1 + 빈 출력이다 — 그건 '없음', 그 밖의 실패(lsof 없음 · 시간 초과 등)는 failed
function runLsof(args: string[]): Promise<{ failed: boolean; stdout: string }> {
  return new Promise((resolve) =>
    execFile(LSOF, args, { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
      const empty = !String(stdout || '').trim()
      if (error && !(error.code === 1 && empty)) return resolve({ failed: true, stdout: '' })
      resolve({ failed: false, stdout: stdout || '' })
    }),
  )
}

// 일감이 지금 팩 · 세대 것인지(옛 본체면 legacy — 지금처럼). 아니면 토큰으로 끄고 다시 띄운다
export function boardJson(port: number, pathName: string, { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<BoardReply> {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathName, method, headers, timeout: 3000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode as number, body: JSON.parse(body) })
        } catch {
          resolve({ status: response.statusCode as number, body: null })
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve({ status: 0, body: null }))
    request.end(method === 'POST' ? '{}' : undefined)
  })
}

// say — 화면 문구 · boardLogFile — 일감 로그 자리 · daemonPaths — 데몬 소켓 자리 · runPack — 코어 팩 명령(main.mts)
export function createBoard({ say, boardLogFile, daemonPaths, runPack }: { say: Say; boardLogFile: () => string; daemonPaths: () => { socket: string }; runPack: RunPack }) {
  async function startBoard(port: number, athenaDir: string): Promise<BoardStart> {
    const url = core.boardUrl(port)
    const logFile = boardLogFile()
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    const log = fs.openSync(logFile, 'a')
    fs.writeSync(log, `\n── ${new Date().toISOString()} 일감 시작 (포트 ${port})\n`)

    // node 가 PATH 에 없으면 Electron 을 node 로 돌린다
    const nodePath = core.findExecutable('node', process.env.PATH)
    // 일감은 pane 밖에서 pane 목록을 묻는다 — 화면 계층이 studio 데몬을 고르게 자리를 넘긴다(S4)
    const paths = daemonPaths()
    // ATHENA_STUDIO_BODY — 일감이 CLI 로 띄우는 pane 이 이 본체(팩) 창에 속하게(protocol 5 · pane 밖이라 부른 pane 이 없다)
    const extra: Record<string, string> = { ATHENA_BOARD_PORT: String(port), ATHENA_STUDIO_SOCKET: paths.socket, ATHENA_STUDIO_CLI: CLI, ATHENA_STUDIO_NODE: process.execPath, ATHENA_STUDIO_BODY: core.realDir(athenaDir) }
    if (!nodePath) extra.ELECTRON_RUN_AS_NODE = '1'
    const env = core.childEnv(process.env, extra)

    let exited: number | string | null = null
    try {
      const child = spawn(nodePath || process.execPath, [path.join(athenaDir, 'scripts', 'board', 'server.mjs')], {
        cwd: athenaDir,
        env,
        detached: true,
        stdio: ['ignore', log, log],
      })
      child.on('exit', (code) => (exited = code))
      child.on('error', (error) => (exited = error.message))
      child.unref()
    } catch (error) {
      return { ok: false, url, error: say('error.boardStart', { message: (error as Error).message }), log: logFile }
    } finally {
      fs.closeSync(log)
    }

    for (let i = 0; i < 40; i++) {
      if (exited !== null) break
      // 답하는 서버가 방금 띄운 이 아테나의 것인지까지 본다(그사이 다른 것이 그 포트를 잡았을 수 있다)
      if (await isBoardUp(port)) {
        if ((await boardOwner(port, athenaDir)) === 'ours') return { ok: true, url, started: true }
        return { ok: false, url, error: say('error.boardPortTaken', { port }), log: logFile }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const why = exited !== null ? say('error.boardExited', { code: exited }) : say('error.boardTimeout')
    return { ok: false, url, error: say('error.boardStartReason', { reason: why }), log: logFile }
  }

  async function stopStaleBoard(port: number, athenaDir: string): Promise<boolean> {
    const token = await runPack(['board-token'], { dir: athenaDir })
    if (!token.ok || typeof token.token !== 'string') return false
    const origin = `http://localhost:${port}`
    await boardJson(port, '/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-board-token': token.token } })
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await isBoardUp(port))) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  return { startBoard, stopStaleBoard }
}

// 일감 GET 하나 → JSON(실패면 null) — main.js 메뉴 막대 묶음에서 옮겼다(PR3d · 팩 창도 쓴다)
export function fetchBoardJson(port: number, pathName: string): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: unknown) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = http.get({ host: '127.0.0.1', port, path: pathName, timeout: 2000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 5 * 1024 * 1024) {
          request.destroy()
          finish(null)
        }
      })
      response.on('end', () => {
        try {
          finish(response.statusCode === 200 ? JSON.parse(body) : null)
        } catch {
          finish(null)
        }
      })
      response.on('aborted', () => finish(null))
      response.on('error', () => finish(null))
      response.on('close', () => finish(null))
    })
    request.on('timeout', () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
  })
}
