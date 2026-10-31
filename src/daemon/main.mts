// Athena Studio 데몬 프로세스 — pane(셸 pty)을 갖고 앱보다 오래 산다. 앱을 닫아도 셸·에이전트는 계속 돈다(rules.md 필수).
// 앱이 떼어 띄운다(detached · unref, 현황판과 같은 방식). 앱·CLI 는 유닉스 소켓으로 말한다(src/lib/protocol.js).
// 띄우기: <node> src/daemon/main.mts --socket <경로> --endpoint <경로> [--cli <athena-studio-cli 경로>]
//   (앱은 Electron 을 node 로 — ELECTRON_RUN_AS_NODE=1, S2. 표준 출력·오류는 앱이 daemon.log 로 돌린다)
// 이 파일은 켤 때 읽은 그대로 데몬이 끝날 때까지 돈다(바꿀 수 없는 쪽) — 동작은 daemon.mts 에 두고 reloadCode 로 바꿔 끼운다
import os from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as core from '../lib/core.mts'
import { Daemon } from './daemon.mts'
import type { ReloadResult } from './daemon.mts'
import type { Pane } from './pane.mts'

const require = createRequire(import.meta.url)
const APP_ROOT = path.join(import.meta.dirname, '..', '..')
const SOURCE_URL = `${pathToFileURL(path.join(APP_ROOT, 'src')).href}/`
// daemon.mts KERNEL_COMPAT 과 같아야 바꿔 끼운다 — 이 파일이 줘야 할 것이 바뀌면 둘 다 올린다
const KERNEL_COMPAT = 1
const RELOAD_LIMIT_MS = 5000 // 새 파일 맨 위 await 가 끝나지 않아도 요청이 묶이지 않게

const log = (...words: unknown[]) => console.log(new Date().toISOString(), ...words)

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (!key || !key.startsWith('--') || index + 1 >= argv.length) throw new Error(`인자를 읽지 못했다: ${argv.join(' ')}`)
    args[key.slice(2)] = argv[index + 1] as string
  }
  return args
}

// 맥 userData 자리(Electron app.getPath('userData') 와 같게) — 앱 없이 손으로 띄울 때의 기본값
function defaultPaths() {
  const home = os.homedir()
  const userData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Athena Studio') : path.join(home, '.config', 'Athena Studio')
  return core.daemonPaths({ userData, home, tmpdir: os.tmpdir(), uid: process.getuid!() })
}

// ES 모듈은 캐시를 비울 수 없다 — `?gen=N` 을 붙여 새 모듈로 읽고, 그 아래 src 모듈까지 같은 표를 물려 줘야 layout · core 도 새 파일이 된다
function propagateGeneration(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      const generation = context.parentURL ? new URL(context.parentURL).searchParams.get('gen') : null
      if (!generation || !resolved.url.startsWith(SOURCE_URL) || resolved.url.includes('?')) return resolved
      return { ...resolved, url: `${resolved.url}?gen=${generation}` }
    },
  })
}

// CommonJS(protocol · screen-model · package.json 버전)는 캐시에서 빼면 다시 읽는다. node-pty · xterm 은 node_modules 라 그대로다(pty 를 쥔 네이티브 모듈)
function forgetSourceModules(): void {
  const sourceDir = path.join(APP_ROOT, 'src') + path.sep
  const packageFile = path.join(APP_ROOT, 'package.json')
  for (const file of Object.keys(require.cache)) if (file.startsWith(sourceDir) || file === packageFile) delete require.cache[file]
}

function timedOut(limitMs: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`${limitMs}ms 안에 새 코드를 읽지 못했다`)), limitMs).unref()
  })
}

// 새 파일을 읽어 메서드만 바꿔 끼운다 — 인스턴스(pty · 소켓 · 탭 · 배치 · 화면 버퍼)와 프로세스는 그대로. 실패하면 옛 코드로 계속 돈다
export function createReloader(getDaemon: () => Daemon): () => Promise<ReloadResult> {
  let generation = 0
  let running: Promise<ReloadResult> | null = null
  const load = async (): Promise<ReloadResult> => {
    generation += 1
    const url = `${SOURCE_URL}daemon/daemon.mts?gen=${generation}`
    const daemon = getDaemon()
    const panes = [...daemon.panes.values()]
    const previous = { daemon: Object.getPrototypeOf(daemon), pane: panes.map((pane) => Object.getPrototypeOf(pane)) }
    try {
      forgetSourceModules()
      const next = (await Promise.race([import(url), timedOut(RELOAD_LIMIT_MS)])) as typeof import('./daemon.mts')
      if (next.KERNEL_COMPAT !== KERNEL_COMPAT) return { ok: false, reason: 'incompatible', message: `호환 판이 다르다: ${next.KERNEL_COMPAT} ≠ ${KERNEL_COMPAT}` }
      const paneModule = (await import(`${SOURCE_URL}daemon/pane.mts?gen=${generation}`)) as { Pane: typeof Pane }
      Object.setPrototypeOf(daemon, next.Daemon.prototype)
      for (const pane of panes) Object.setPrototypeOf(pane, paneModule.Pane.prototype)
      daemon.afterReload()
      const version = (require('../lib/protocol.js') as typeof import('../lib/protocol.js')).DAEMON_CODE
      return { ok: true, codeVersion: version }
    } catch (error) {
      Object.setPrototypeOf(daemon, previous.daemon)
      panes.forEach((pane, index) => Object.setPrototypeOf(pane, previous.pane[index] as object))
      log('코드 교체 실패 — 옛 코드로 계속 돈다', (error as Error).stack || error)
      return { ok: false, reason: 'failed', message: (error as Error).message }
    }
  }
  return () => {
    running = running || load().finally(() => (running = null))
    return running
  }
}

async function main(): Promise<void> {
  // process.title 은 붙이지 않는다 — 맥에서 제목을 바꾸면 LaunchServices 가 Electron 번들(LSUIElement 없음)을 Foreground 앱으로 등록해 Dock 에 아이콘이 뜬다
  const args = parseArgs(process.argv.slice(2))
  const defaults = defaultPaths()
  propagateGeneration()
  const daemon: Daemon = new Daemon({ socket: args.socket || defaults.socket, endpoint: args.endpoint || defaults.endpoint, cli: args.cli, reloadCode: createReloader(() => daemon) })
  // 예외 하나로 데몬이 죽으면 모든 셸이 SIGHUP 으로 같이 죽는다 — 로그만 남기고 계속 돈다
  process.on('uncaughtException', (error) => log('잡히지 않은 예외', error.stack || error))
  process.on('unhandledRejection', (error) => log('처리 안 된 거절', (error && (error as Error).stack) || error))
  process.on('SIGTERM', () => daemon.shutdown('SIGTERM'))
  process.on('SIGHUP', () => {}) // 띄운 터미널이 닫혀도 산다
  await daemon.start()
}

// 바로 띄웠을 때만(require.main === module 과 같다)
if (import.meta.main) {
  main().catch((error: Error) => {
    log('데몬 시작 실패', error.message)
    process.exit(1)
  })
}
