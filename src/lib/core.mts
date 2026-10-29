// Electron 없이 돌아가는 순수 로직 — 서버에서 `npm test` 로 검사한다.
import fs from 'node:fs'
import path from 'node:path'
import { ATHENA_WORKSPACE, pickAthenaWorkspace } from './athena-workspace.mts'

// 앱 설정 — 아는 칸만 모양을 맞추고 나머지 칸은 그대로 둔다(windows 등)
export type AppConfig = { [key: string]: unknown; athenaDir: string | null; boardPort: number }
// 켤 때 열 창 목록을 읽는 칸만
type WindowsConfig = { windows?: unknown; athenaDir?: unknown } | null | undefined
// 데몬 상태의 작업 공간에서 읽는 칸만
type Workspace = { label?: unknown; cwd?: string }

// 현황판 기본 포트는 4701(옛 본체만 · 팩 본체는 코어가 정한다)
export const DEFAULT_CONFIG: { athenaDir: string | null; boardPort: number } = { athenaDir: null, boardPort: 4701 }

// 앱 설정(userData/config.json). 깨졌거나 없으면 기본값
export function loadConfig(file: string): AppConfig {
  let saved: unknown = {}
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {}
  const config: AppConfig = { ...DEFAULT_CONFIG, ...(saved as Record<string, unknown>) }
  const port = Number(config.boardPort)
  config.boardPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONFIG.boardPort
  if (typeof config.athenaDir !== 'string' || !config.athenaDir) config.athenaDir = null
  // 예전 키 — 아테나 폴더 옮기기를 물었는지. 스튜디오는 이제 자기 코어(~/.athena-studio)만 쓴다
  delete config.studioAthenaAsked
  delete config.homeAthenaAsked
  return config
}

// 켤 때 열 팩 창들의 본체 — 설정 windows:[{ athenaDir }] (창마다 팩).
// 예전 설정(athenaDir 하나)이면 그 하나. 같은 본체는 한 번만(심볼릭 링크를 풀어 비교하는 것은 부르는 쪽 sameDir)
export function windowDirs(config: WindowsConfig, sameDir: (left: string, right: string) => boolean = (left, right) => left === right): string[] {
  const listed: string[] = Array.isArray(config?.windows) ? config.windows.map((entry: { athenaDir?: unknown } | null) => entry && entry.athenaDir).filter((dir: unknown): dir is string => typeof dir === 'string' && dir !== '') : []
  const dirs = listed.length ? listed : config && config.athenaDir ? [config.athenaDir as string] : []
  return dirs.filter((dir, index) => dirs.findIndex((other) => sameDir(other, dir)) === index)
}

// 열린 창 목록을 설정에 — 첫 창의 본체는 athenaDir 에도 적는다(시작 화면 · 옮기기 묻기 같은 예전 규칙이 그 값을 본다)
export function withWindows(config: AppConfig, dirs: unknown[]): AppConfig {
  const clean = dirs.filter((dir): dir is string => typeof dir === 'string' && dir !== '')
  return { ...config, windows: clean.map((athenaDir) => ({ athenaDir })), athenaDir: clean[0] || config.athenaDir || null }
}

// 반쯤 쓴 파일이 남지 않게 임시 파일에 쓰고 바꿔 넣는다
export function saveConfig(file: string, config: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// 아테나 폴더인지: CLAUDE.md 와 scripts/board/server.mjs 가 있어야 한다
const ATHENA_MARKERS = ['CLAUDE.md', path.join('scripts', 'board', 'server.mjs')]

export function checkAthenaDir(dir: string | null | undefined): { ok: boolean; missing: string[] } {
  if (!dir) return { ok: false, missing: ATHENA_MARKERS }
  const missing = ATHENA_MARKERS.filter((rel) => {
    try {
      return !fs.statSync(path.join(dir, rel)).isFile()
    } catch {
      return true
    }
  })
  return { ok: missing.length === 0, missing }
}

// 같은 폴더인지 — 심볼릭 링크(/tmp → /private/tmp 등)까지 풀어 본다. 없는 폴더는 표기만 정리해 비교
export function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

export function sameDir(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  return realDir(left) === realDir(right)
}


// 이 컴퓨터 설정(athena.config.json · git 무시)이 없으면 팩 없는 최소 설정을 만든다.
// 아테나는 이 파일이 없으면 현황판이 뜨지 않고, 팩이 없으면 claude · codex 를 켤 때 /setup 이 시작된다.
// screen: 'studio' — 아테나가 화면(pane · 탭)을 스튜디오 데몬으로 다루게 고정한다(아테나 쪽 키).
// reposRoot(레포 클론이 있는 폴더)는 reposRootFor 가 정한다. 이미 있는 설정은 건드리지 않는다
export function ensureAthenaConfig(dir: string, reposRoot = '..'): boolean {
  const file = path.join(dir, 'athena.config.json')
  if (fs.existsSync(file)) return false
  fs.writeFileSync(file, JSON.stringify({ reposRoot, screen: 'studio' }, null, 2) + '\n')
  return true
}

// 스튜디오 집(~/.athena-studio) 안의 본체는 상위가 스튜디오 집이라 담당 레포가 없다 — 회사 레포 클론이 있는 홈을 절대 경로로
// (두 앱이 같은 클론을 같이 쓴다). 직접 고른 아테나 폴더는 지금처럼 옆 폴더(..)
export function reposRootFor(dir: string, { studioRoot, home }: { studioRoot: string; home: string }): string {
  return isInside(dir, studioRoot) ? home : '..'
}

// dir 이 root 안(또는 root 자체)인가 — 심볼릭 링크를 풀어 본다(아직 없는 폴더는 있는 상위까지 풀고 나머지를 붙인다)
function realDirLoose(dir: string): string {
  let current = path.resolve(dir)
  const rest: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(dir)
      rest.unshift(path.basename(current))
      current = parent
    }
  }
}

export function isInside(dir: string | null | undefined, root: string | null | undefined): boolean {
  if (!dir || !root) return false
  const relative = path.relative(realDirLoose(root), realDirLoose(dir))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// 현황판 포트 고르기 — 저장된 포트부터 차례로 본다(다른 아테나 현황판 등이 쥐고 있으면 다음 번호)
const BOARD_PORT_SPAN = 20

export function boardPortCandidates(start: unknown): number[] {
  const first = typeof start === 'number' && Number.isInteger(start) && start > 0 && start < 65536 ? start : DEFAULT_CONFIG.boardPort
  const ports: number[] = []
  for (let port = first; port < Math.min(first + BOARD_PORT_SPAN, 65536); port++) ports.push(port)
  return ports
}

// lsof -Fn 출력에서 경로(n 으로 시작하는 줄)를 꺼낸다
export function parseLsofPath(output: unknown): string | null {
  const line = String(output || '').split('\n').find((entry) => entry.startsWith('n'))
  return line ? line.slice(1) : null
}

// 스튜디오가 만든 아테나 설정(screen: studio)에만 고른 현황판 포트를 적는다 — pane 안의 아테나가 이 값으로 현황판을 찾는다.
// 스튜디오가 만들지 않은 설정은 건드리지 않는다. 바꿨으면 true · 없으면 false · 읽거나 쓰지 못하면 throw
export function setAthenaBoardPort(dir: string, port: number): boolean {
  const file = path.join(dir, 'athena.config.json')
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const current: unknown = JSON.parse(text)
  if (!current || typeof current !== 'object' || Array.isArray(current) || (current as Record<string, unknown>).screen !== 'studio') return false
  if ((current as Record<string, unknown>).boardPort === port) return false
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...current, boardPort: port }, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return true
}

// 로그인 셸이 찍은 PATH 를 표시 사이에서 꺼낸다(rc 파일이 찍는 다른 글자는 버린다)
export const PATH_MARK = '__ATHENA_STUDIO_PATH__'

export function parseMarkedPath(output: string): string | null {
  const start = output.indexOf(PATH_MARK)
  if (start < 0) return null
  const end = output.indexOf(PATH_MARK, start + PATH_MARK.length)
  if (end < 0) return null
  const value = output.slice(start + PATH_MARK.length, end).trim()
  return value || null
}

// 기존 PATH 앞에 로그인 셸 PATH 를 두고 겹치는 항목은 한 번만
export function mergePath(loginPath: string | null | undefined, currentPath: string | null | undefined): string {
  const parts = [...(loginPath || '').split(':'), ...(currentPath || '').split(':')].filter(Boolean)
  return [...new Set(parts)].join(':')
}

export function findExecutable(name: string, pathValue: string | null | undefined, isExecutable: (file: string) => boolean = defaultIsExecutable): string | null {
  for (const dir of (pathValue || '').split(':').filter(Boolean)) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function defaultIsExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

// 자식 프로세스 환경. 앱을 에이전트(claude) 세션 안에서 켰을 때 물려받은 표시를 지운다 — 남으면 pane 의 claude 가
// 자기를 하위 세션으로 알고(대화 기록 저장 꺼짐) 아테나가 관리 창(ATHENA_AGENT)으로 알아 첫 실행·화면 세팅을 건너뛴다.
// 아테나 delegate.sh 실행기가 에이전트 pane 에 넣는 값(ATHENA_REPO_DIR · ATHENA_VERIFY_DIR)도 — 남으면 상태줄(statusline.sh)이
// cwd 보다 그 레포를 먼저 보고, 검증 스크립트가 그 워크트리를 본다
const INHERITED_SESSION_KEYS = ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'ATHENA_AGENT', 'ATHENA_REPO_DIR', 'ATHENA_VERIFY_DIR']

type Env = Record<string, string | undefined>

export function childEnv(baseEnv: Env, extra: Env = {}): Env {
  const env: Env = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith('CLAUDE_CODE_')) continue
    // 스튜디오 pane 안에서 앱을 켰을 때의 표시 — pane 셸·현황판에는 데몬·main 이 새 값을 다시 넣는다
    if (key === 'ATHENA_STUDIO' || key.startsWith('ATHENA_STUDIO_')) continue
    if (INHERITED_SESSION_KEYS.includes(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

// 앱을 다시 켤 때(⚙ [업데이트] → scripts/dev-app.js restart) — childEnv 로 걷어 내되 다시 켜진 앱이 켤 때 읽는 값만 다시 싣는다:
// 격리 실행의 스튜디오 집 · 데몬 접속 파일 자리 · 가짜 팩(화면 확인). 지난 업데이트 표시(ATHENA_STUDIO_APP_UPDATE)는 싣지 않는다.
// electronAsNode — node 가 없어 도우미를 Electron 으로 돌릴 때(도우미가 켤 앱에서는 뗀다)
const RELAUNCH_KEYS = ['ATHENA_STUDIO_HOME', 'ATHENA_STUDIO_ENDPOINT', 'ATHENA_STUDIO_FAKE_PACK']
export function relaunchEnv(baseEnv: Env, { electronAsNode = false }: { electronAsNode?: boolean } = {}): Env {
  const kept: Env = {}
  for (const key of RELAUNCH_KEYS) if (typeof baseEnv[key] === 'string' && baseEnv[key]) kept[key] = baseEnv[key]
  return childEnv(baseEnv, { ...kept, ...(electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) })
}

export function terminalEnv(baseEnv: Env): Env {
  return childEnv(baseEnv, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'AthenaStudio',
    LANG: baseEnv.LANG || 'ko_KR.UTF-8',
  })
}

// 아테나 에이전트 — 작업 창의 athena 작업 공간(아테나 폴더)에서 켠다(화면 세팅 · 첫 실행은 아테나 훅이 맡는다)
const AGENTS = ['claude', 'codex']
export { ATHENA_WORKSPACE }

export function availableAgents(pathValue: string | null | undefined, isExecutable: (file: string) => boolean = defaultIsExecutable): string[] {
  return AGENTS.filter((name) => findExecutable(name, pathValue, isExecutable))
}

// 묻지 않고 깔린 것 중 첫 번째(AGENTS 순서라 claude 가 있으면 claude), 없으면 none — 다른 에이전트는 작업 창에서 직접 켠다
export function agentDecision(available: string[]): { none: true } | { agent: string | undefined } {
  if (available.length === 0) return { none: true }
  return { agent: available[0] }
}

// 백업에서 되살린 아테나 대화를 잇는 명령 — 세션 id 모양만 받는다(pane 에 글로 쓰이니 셸 글자가 섞이면 안 된다)
const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i
export function resumeCommand(session: unknown): string {
  if (!SESSION_ID.test(String(session || ''))) throw new Error('bad session id')
  return `claude --resume ${session}`
}

// claude 화면이 "아무것도 안 하고 비어 있다" 인가 — 질문 · 고르기 창이 없고 입력칸이 비었을 때만(자리 글 Try "…" 는 빈 것으로).
// 데몬의 agent_status 는 질문을 기다리는 것도 idle 로 본다 — 그 상태에 /exit 를 치면 사용자가 답하던 창 · 쓰던 글에 들어간다
const PROMPT_MENU = /Enter to (select|confirm)|Esc to cancel|↑\/↓ to navigate|Do you want to|Type something\./
const BACKGROUND_WORK = /·\s*[↓↑]\s*[\d.,]+k?\s*tokens|esc to interrupt/i
export function claudeAtEmptyPrompt(text: unknown): boolean {
  const lines = String(text || '').split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim())
  const tail = lines.slice(-12)
  if (tail.some((line) => PROMPT_MENU.test(line))) return false
  // 뒤에서 도는 하위 에이전트 · 셸(◯ … 1m 29s · ↓ 135.1k tokens) — 입력칸이 비어도 일하는 중
  if (tail.some((line) => BACKGROUND_WORK.test(line))) return false
  const prompt = [...tail].reverse().find((line) => /^\s*❯/.test(line))
  if (!prompt) return false
  const typed = prompt.replace(/^\s*❯\s?/, '').trim()
  return typed === '' || /^Try "/.test(typed)
}

// 데몬 상태의 작업 공간 중 이 아테나 폴더의 아테나 작업 공간 — 규칙은 athena-workspace.mts(화면과 같이 쓴다):
// 이름이 athena 인 것이 먼저, 없으면 옛 버그로 폴더 이름이 붙은 것. 아테나 폴더를 바꿨으면 예전 폴더의 작업 공간은 건드리지 않는다
export function findAthenaWorkspace<W extends Workspace>(workspaces: W[] | null | undefined, athenaDir: string): W | null {
  return pickAthenaWorkspace(workspaces, [athenaDir, realDir(athenaDir)], (cwd) => sameDir(cwd, athenaDir))
}

// 앱의 ＋ · ⌘T 가 데몬에 보낼 요청. 보던 작업 공간이 없으면(새 데몬 · 마지막 탭을 닫음) 데몬 tab new 는 폴더 이름으로 작업 공간을 새로 만든다 —
// 아테나 폴더면 그 이름이 athena 가 아니라 로고 · 모니터 · 아테나 판정(findAthenaWorkspace)이 빠진다. 그래서 그때는
// 이 아테나 폴더의 athena 작업 공간이 있으면 거기에 탭을 붙이고, 없으면 athena 이름으로 만든다(셸만 — 에이전트는 켜지 않는다)
type NewTabState = { workspaces?: (Workspace & { id: string })[] | null; activeWorkspace?: string | null }
type DaemonRequest = { op: string; args: Record<string, unknown> }
export function newTabRequest(state: NewTabState | null | undefined, athenaDir: string, size: Record<string, unknown> = {}): DaemonRequest {
  if (!state || state.activeWorkspace) return { op: 'tab new', args: { defaultCwd: athenaDir, ...size } }
  const athena = findAthenaWorkspace(state.workspaces, athenaDir)
  if (athena) return { op: 'tab new', args: { workspace: athena.id, ...size } }
  return { op: 'workspace create', args: { label: ATHENA_WORKSPACE, cwd: athenaDir, focus: true, ...size } }
}

// 같은 열쇠의 일을 하나씩 — 앞 일이 끝난 뒤(실패해도) 다음 일을 시작한다.
// main 이 아테나 폴더마다 아테나 켜기 · 새 탭을 한 줄로 세운다 — 겹치면 둘 다 빈 상태를 읽고 아테나 작업 공간 · 에이전트를 둘 만든다
export function keyedQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T,>(key: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) || Promise.resolve()).then(work)
    const tail = run.catch(() => {})
    tails.set(key, tail)
    tail.then(() => tails.get(key) === tail && tails.delete(key))
    return run
  }
}

// 링크를 어디서 열지: localhost(계획서 · 테스트 화면)는 옆 브라우저(panel), 그 밖의 http(s) 는 기본 브라우저, 나머지는 막는다
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export function openTarget(rawUrl: string): 'deny' | 'panel' | 'external' {
  if (!isWebUrl(rawUrl)) return 'deny'
  return LOCAL_HOSTS.includes(new URL(rawUrl).hostname) ? 'panel' : 'external'
}

// 옆 브라우저의 결정 콘솔(현황판이 주는 /plans/….html)이 [이대로 진행] 으로 pane 에 보내기를 마쳤나 —
// 같은 localhost 현황판의 POST /api/action 이 200 이면 보냄(실패면 콘솔이 [프롬프트로 복사] 로 바뀌니 서랍을 두어야 한다)
export function isConsoleSent({ method, url, statusCode, pageUrl }: { method: string; url: string; statusCode: number; pageUrl: string }): boolean {
  if (method !== 'POST' || statusCode !== 200) return false
  try {
    const request = new URL(url)
    const page = new URL(pageUrl)
    return LOCAL_HOSTS.includes(request.hostname) && request.origin === page.origin && request.pathname === '/api/action' && /^\/plans\/.+\.html$/.test(page.pathname)
  } catch {
    return false
  }
}

// 옆 브라우저가 열 수 있는 주소 — http(s) 만
export function isWebUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// 주소창에 친 글자 → 주소. 스킴이 없으면 localhost:3000 · 127.0.0.1 은 http, 그 밖은 https 를 붙인다. 열 수 없으면 null
export function normalizeAddress(input: unknown): string | null {
  const text = String(input || '').trim()
  if (!text) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return isWebUrl(text) ? text : null
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text)
  const candidate = `${local ? 'http' : 'https'}://${text}`
  return isWebUrl(candidate) ? candidate : null
}

export function boardUrl(port: number): string {
  return `http://localhost:${port}`
}

// 데몬 파일 자리. 맥 유닉스 소켓 경로는 104바이트(끝 NUL 포함)를 넘으면 connect 가 EINVAL 이다(2026-10-17 실측) —
// userData 경로가 길면 소켓만 tmpdir/athena-studio-<uid>/ 로 옮긴다. endpoint 는 pane 밖에서 데몬을 찾는 접속 파일(S4)
export const SOCKET_PATH_MAX = 103

// endpoint — 데몬 접속 파일. ATHENA_STUDIO_ENDPOINT 가 있으면 그 자리(아테나 screen.py 와 같은 변수 · 개발 · 회귀 검사용 격리 —
// Electron 은 HOME 을 바꿔도 홈 경로를 그대로 써서, 격리 실행이 사용자 앱의 접속 파일을 덮을 수 있다)
// socketTag — 대체 자리를 개발 앱 · 배포판이 같이 쓰지 않게(개발 앱 '-dev' · studio-home appIdentity)
export function daemonPaths({ userData, home, tmpdir, uid, endpoint = null, socketTag = '' }: { userData: string; home: string; tmpdir: string; uid: number | string; endpoint?: string | null; socketTag?: string }): { socket: string; log: string; endpoint: string } {
  let socket = path.join(userData, 'daemon.sock')
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) socket = path.join(tmpdir, `athena-studio-${uid}${socketTag}`, 'daemon.sock')
  // 대체 자리도 길면 여기서 알린다 — 데몬이 listen 하다 EINVAL 로 죽는 것보다 원인이 분명하다
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`데몬 소켓 경로가 ${SOCKET_PATH_MAX}바이트를 넘어요: ${socket}`)
  return {
    socket,
    log: path.join(userData, 'daemon.log'),
    endpoint: endpoint || path.join(home, '.athena-studio', 'daemon.json'),
  }
}
