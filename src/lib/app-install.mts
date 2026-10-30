// 개발 앱 ⚙ 업데이트의 npm install — 앱이 켜진 채로(src/main/app-updater.mts) · 꺼진 사이 도우미(scripts/dev-app.js)가 같이 쓴다.
// heavy.sh 줄 서기 · 출력 읽기(대기 → 차례) · 종료 구분(진짜 실패 / 대기 포기 / 신호로 강제 종료) · 끊긴 설치 표시 파일(.dev-app/install-pending.json).
// dev-app.js(CommonJS)가 require 한다 — Node 22.18 이상은 .mts 를 타입만 지우고 읽는다
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseWaitLine } from './update-notice.mts'
import type { WaitEvent } from './update-notice.mts'

export type InstallExit = { code: number | null; signal: NodeJS.Signals | null }
// ok — 설치됨 · gave-up — heavy.sh 가 최대 대기를 넘겨 포기(75) · killed — 신호로 끝남(강제 종료 · 앱 종료) · failed — npm install 이 실패
export type InstallOutcome = 'ok' | 'gave-up' | 'killed' | 'failed'
export type Pending = { at: string; heavy: string; lang: string }

export const HEAVY_GAVE_UP = 75 // heavy.sh 의 최대 대기 초과 종료 코드
const REQUIRED_MODULES = ['electron', 'vite'] // 켜는 데 꼭 필요한 것

// 셸(heavy.sh 포함)은 신호로 죽은 자식을 128+신호 번호 코드로 돌려준다(130 INT/TERM 트랩 · 137 KILL · 143 TERM) — 그것도 강제 종료
const isSignalCode = (code: number | null) => code !== null && code > 128 && code <= 159

export function classifyExit({ code, signal }: InstallExit): InstallOutcome {
  if (signal || isSignalCode(code)) return 'killed'
  if (code === 0) return 'ok'
  return code === HEAVY_GAVE_UP ? 'gave-up' : 'failed'
}

// --include=dev — 개발 앱은 devDependencies(electron · vite)로 켜진다. NODE_ENV=production · npmrc omit=dev 가 있어도 지우지 않게
export function installCommand({ heavy, platform = process.platform }: { heavy?: string | null; platform?: string }): { file: string; list: string[] } {
  const npm = platform === 'win32' ? 'npm.cmd' : 'npm'
  const install = [npm, 'install', '--include=dev']
  if (heavy && fs.existsSync(heavy)) return { file: 'bash', list: [heavy, ...install] }
  return { file: install[0] as string, list: install.slice(1) }
}

// 끝났다고 다 깔린 것은 아니다 — 켜는 데 꼭 필요한 것 중 없는 것
export function missingModules(root: string): string[] {
  return REQUIRED_MODULES.filter((name) => !fs.existsSync(path.join(root, 'node_modules', name, 'package.json')))
}

// heavy.sh 출력 한 줄씩 읽기 — "⏳ 대기" 를 처음 찍을 때 onWait 한 번(30초마다 다시 찍어도 다시 부르지 않는다) · "▶ 차례" 에 onTurn
export function createLineWatcher({ onWait, onTurn }: { onWait: (event: WaitEvent) => void; onTurn: () => void }): (chunk: string) => void {
  let waiting = true
  let notified = false
  let rest = ''
  return (chunk) => {
    if (!waiting) return // 차례 뒤 npm 출력은 보지 않는다
    const lines = (rest + chunk).split('\n')
    rest = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('▶')) {
        waiting = false
        onTurn()
        return
      }
      const wait = parseWaitLine(line)
      if (wait && !notified) {
        notified = true
        onWait(wait)
      }
    }
  }
}

// npm install(heavy.sh 포함) 돌리기 — 출력은 onOutput 으로(없으면 버린다) · 못 띄웠으면 { code: 1 }
// env — 자식 환경(앱은 core.childEnv 로 정리해 넘긴다) · 맥 · 리눅스는 새 프로세스 그룹으로 띄운다(stopInstall 이 트리째 끝낸다)
export function runInstall({ file, list, cwd, env, onOutput, watch, onSpawn }: { file: string; list: string[]; cwd: string; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void; watch?: (chunk: string) => void; onSpawn?: (pid: number | undefined) => void }): Promise<InstallExit> {
  return new Promise((resolve) => {
    const child = spawn(file, list, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    onSpawn?.(child.pid)
    // 글자 단위로 받는다 — 덩어리 경계에서 한글(여러 바이트)이 잘리지 않게
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // 앱이 먼저 꺼져 파이프가 끊겨도 우리가 죽지 않게
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    child.stdout.on('data', (chunk: string) => {
      onOutput?.(chunk, 'stdout')
      watch?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => onOutput?.(chunk, 'stderr'))
    child.on('error', (error) => {
      onOutput?.(`${file} 을(를) 띄우지 못했어요: ${error.message}\n`, 'stderr')
      resolve({ code: 1, signal: null })
    })
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

// 앱이 꺼질 때 도는 설치를 트리째(heavy.sh · npm · 그 자식) 끝낸다 — 끝난 것을 확인하고 돌아온다.
// 먼저 TERM(heavy.sh 가 트랩으로 자식까지 정리), graceMs 안에 안 끝나면 KILL. done — runInstall 이 끝나면 풀리는 약속
export async function stopInstall(pid: number | undefined, done: Promise<unknown>, graceMs = 8000): Promise<void> {
  if (!pid) return
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') process.kill(pid, signal)
      else process.kill(-pid, signal)
    } catch {
      // 이미 끝났다
    }
  }
  const waitDone = (ms: number) => Promise.race([done.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))])
  signalGroup('SIGTERM')
  if (await waitDone(graceMs)) return
  signalGroup('SIGKILL')
  await waitDone(2000)
}

// ── 끊긴 설치 표시 — 설치를 시작할 때 쓰고 끝나면 지운다. 앱이 꺼져 설치가 끊기면 남아서 다음에 켤 때 다시 시도한다
export const pendingFile = (root: string) => path.join(root, '.dev-app', 'install-pending.json')

export function writePending(root: string, pending: Pending): void {
  try {
    fs.mkdirSync(path.dirname(pendingFile(root)), { recursive: true })
    fs.writeFileSync(pendingFile(root), JSON.stringify(pending) + '\n')
  } catch {
    // 표시를 못 남겨도 설치는 한다
  }
}

export function readPending(root: string): Pending | null {
  try {
    const value = JSON.parse(fs.readFileSync(pendingFile(root), 'utf8')) as Partial<Pending>
    return { at: String(value.at || ''), heavy: String(value.heavy || ''), lang: String(value.lang || '') }
  } catch {
    return null
  }
}

export function clearPending(root: string): void {
  fs.rmSync(pendingFile(root), { force: true })
}

// ── 다시 빌드할 것 표시 — 업데이트로 받은 뒤 아직 화면 · 코어 번들 · 개발 앱(Athena.app)을 새로 맞추지 못했다(start 가 맞추고 지운다).
// 설치 표시와 따로다: 설치가 끝났어도 `[나중에]` 뒤 Dock · Finder 로 켜면 start 를 거치지 않아 옛 빌드로 뜬다
export const rebuildFile = (root: string) => path.join(root, '.dev-app', 'rebuild-pending.json')

export function writeRebuild(root: string): void {
  try {
    fs.mkdirSync(path.dirname(rebuildFile(root)), { recursive: true })
    fs.writeFileSync(rebuildFile(root), JSON.stringify({ at: new Date().toISOString() }) + '\n')
  } catch {
    // 표시를 못 남겨도 업데이트는 한다
  }
}

export const hasRebuild = (root: string): boolean => fs.existsSync(rebuildFile(root))

export function clearRebuild(root: string): void {
  fs.rmSync(rebuildFile(root), { force: true })
}

// start 를 거치지 않고 켜진 앱이 끝나지 않은 일(설치 · 다시 빌드)이 남은 것을 보면 도우미로 다시 켠다 — 켜기 반복을 막으려고 이 간격 안에는 한 번만
export const RELAUNCH_GAP_MS = 5 * 60 * 1000
const relaunchGuardFile = (root: string) => path.join(root, '.dev-app', 'relaunch-guard.json')

// 다시 켜기 도우미(dev-app.js restart)가 도는 동안의 pid 표시 — 그 사이 Dock · Finder 로 켠 앱이 창을 열지 않고 끝나게 한다
// (도우미가 화면 빌드를 바꾸고 끝나면 앱을 따로 띄운다 — 옛 앱이 같이 떠 있으면 둘이 된다)
const helperFile = (root: string) => path.join(root, '.dev-app', 'restart-helper.json')

export function writeHelper(root: string, pid = process.pid): void {
  try {
    fs.mkdirSync(path.dirname(helperFile(root)), { recursive: true })
    fs.writeFileSync(helperFile(root), JSON.stringify({ pid }) + '\n')
  } catch {
    // 표시를 못 남기면 겹쳐 켜질 수 있을 뿐 — 도우미는 계속 한다
  }
}

export function clearHelper(root: string, pid = process.pid): void {
  try {
    // 내가 쓴 표시만 지운다(다른 도우미가 덮어썼으면 그대로)
    if (JSON.parse(fs.readFileSync(helperFile(root), 'utf8')).pid === pid) fs.rmSync(helperFile(root), { force: true })
  } catch {
    // 없거나 깨졌으면 지울 것이 없다
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// 살아 있는 다른 도우미가 있으면 true — 죽은 pid · 깨진 표시 · 내 pid 는 무시해 앱이 안 뜨는 일이 없게
export function helperRunning(root: string, alive: (pid: number) => boolean = isProcessAlive, self = process.pid): boolean {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(helperFile(root), 'utf8')).pid)
    return Number.isInteger(pid) && pid > 0 && pid !== self && alive(pid)
  } catch {
    return false
  }
}

export function shouldRelaunch(root: string, now = Date.now()): boolean {
  if (!readPending(root) && !hasRebuild(root)) return false
  try {
    const at = Number(JSON.parse(fs.readFileSync(relaunchGuardFile(root), 'utf8')).at)
    return !(Number.isFinite(at) && now - at < RELAUNCH_GAP_MS)
  } catch {
    return true
  }
}

export function markRelaunch(root: string, now = Date.now()): void {
  try {
    fs.mkdirSync(path.dirname(relaunchGuardFile(root)), { recursive: true })
    fs.writeFileSync(relaunchGuardFile(root), JSON.stringify({ at: now }) + '\n')
  } catch {
    // 못 남기면 다음에도 다시 켤 수 있다 — 도우미가 켠 앱은 VIA_START 표시가 있어 그 앱이 또 다시 켜지는 일은 없다
  }
}
