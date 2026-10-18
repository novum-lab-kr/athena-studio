// Electron 없이 돌아가는 순수 로직 — 서버에서 `npm test` 로 검사한다.
const fs = require('fs')
const path = require('path')

// 현황판 기본 포트는 4701 — herdr 용 아테나(~/athena)의 현황판(4700)과 나란히 돈다
// homeAthenaAsked — 스튜디오 레포 athena/ 를 쓰던 사람에게 ~/athena 로 옮기기를 물었는지(여러 회사 팩 · 사용자 결정 1)
const DEFAULT_CONFIG = { athenaDir: null, boardPort: 4701, homeAthenaAsked: false }

// 앱 설정(userData/config.json). 깨졌거나 없으면 기본값
function loadConfig(file) {
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {}
  const config = { ...DEFAULT_CONFIG, ...saved }
  const port = Number(config.boardPort)
  config.boardPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONFIG.boardPort
  if (typeof config.athenaDir !== 'string' || !config.athenaDir) config.athenaDir = null
  config.homeAthenaAsked = config.homeAthenaAsked === true
  delete config.studioAthenaAsked // 예전 키(스튜디오 전용 아테나를 물었는지) — 이제 쓰지 않는다
  return config
}

// 켤 때 열 팩 창들의 본체 — 설정 windows:[{ athenaDir }] (창마다 팩 · 아테나 계획서 20261018-팩마다-본체 4.2).
// 예전 설정(athenaDir 하나)이면 그 하나. 같은 본체는 한 번만(심볼릭 링크를 풀어 비교하는 것은 부르는 쪽 sameDir)
function windowDirs(config, sameDir = (left, right) => left === right) {
  const listed = Array.isArray(config && config.windows) ? config.windows.map((entry) => entry && entry.athenaDir).filter((dir) => typeof dir === 'string' && dir) : []
  const dirs = listed.length ? listed : config && config.athenaDir ? [config.athenaDir] : []
  return dirs.filter((dir, index) => dirs.findIndex((other) => sameDir(other, dir)) === index)
}

// 열린 창 목록을 설정에 — 첫 창의 본체는 athenaDir 에도 적는다(시작 화면 · 옮기기 묻기 같은 예전 규칙이 그 값을 본다)
function withWindows(config, dirs) {
  const clean = dirs.filter((dir) => typeof dir === 'string' && dir)
  return { ...config, windows: clean.map((athenaDir) => ({ athenaDir })), athenaDir: clean[0] || config.athenaDir || null }
}

// 반쯤 쓴 파일이 남지 않게 임시 파일에 쓰고 바꿔 넣는다
function saveConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

// 아테나 폴더인지: CLAUDE.md 와 scripts/board/server.mjs 가 있어야 한다
const ATHENA_MARKERS = ['CLAUDE.md', path.join('scripts', 'board', 'server.mjs')]

function checkAthenaDir(dir) {
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

// 스튜디오용 아테나 — 스튜디오 레포 안 athena/(git subtree · 정본은 아테나 레포 novum-lab-kr/athena). 앱은 그 폴더를 바로 쓴다.
// herdr 용 아테나(~/athena)와 섞이지 않는다
const ATHENA_DIR_NAME = 'athena'

function studioAthenaDir(appRoot) {
  return path.join(appRoot, ATHENA_DIR_NAME)
}

// 같은 폴더인지 — 심볼릭 링크(/tmp → /private/tmp 등)까지 풀어 본다. 없는 폴더는 표기만 정리해 비교
function realDir(dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function sameDir(left, right) {
  if (!left || !right) return false
  return realDir(left) === realDir(right)
}


// 이 컴퓨터 설정(athena.config.json · git 무시)이 없으면 팩 없는 최소 설정을 만든다.
// 아테나는 이 파일이 없으면 현황판이 뜨지 않고, 팩이 없으면 claude · codex 를 켤 때 /setup 이 시작된다.
// screen: 'studio' — 아테나가 화면(pane · 탭)을 herdr 가 아니라 스튜디오 데몬으로 다루게 고정한다(아테나 쪽 키 · herdr | studio | none).
// reposRoot(레포 클론이 있는 폴더)는 reposRootFor 가 정한다. 이미 있는 설정(herdr 용 ~/athena 등)은 건드리지 않는다
function ensureAthenaConfig(dir, reposRoot = '..') {
  const file = path.join(dir, 'athena.config.json')
  if (fs.existsSync(file)) return false
  fs.writeFileSync(file, JSON.stringify({ reposRoot, screen: 'studio' }, null, 2) + '\n')
  return true
}

// 스튜디오 레포의 athena/ 는 상위가 스튜디오 레포라 담당 레포가 없다 — 예전(~/athena/..)과 같은 홈을 절대 경로로.
// 직접 고른 아테나 폴더는 지금처럼 옆 폴더(..)
function reposRootFor(dir, { studioAthena, home }) {
  return sameDir(dir, studioAthena) ? home : '..'
}

// 현황판 포트 고르기 — 저장된 포트부터 차례로 본다(다른 아테나 현황판 등이 쥐고 있으면 다음 번호)
const BOARD_PORT_SPAN = 20

function boardPortCandidates(start) {
  const first = Number.isInteger(start) && start > 0 && start < 65536 ? start : DEFAULT_CONFIG.boardPort
  const ports = []
  for (let port = first; port < Math.min(first + BOARD_PORT_SPAN, 65536); port++) ports.push(port)
  return ports
}

// lsof -Fn 출력에서 경로(n 으로 시작하는 줄)를 꺼낸다
function parseLsofPath(output) {
  const line = String(output || '').split('\n').find((entry) => entry.startsWith('n'))
  return line ? line.slice(1) : null
}

// 스튜디오가 만든 아테나 설정(screen: studio)에만 고른 현황판 포트를 적는다 — pane 안의 아테나가 이 값으로 현황판을 찾는다.
// herdr 용 ~/athena 등 스튜디오가 만들지 않은 설정은 건드리지 않는다. 바꿨으면 true · 없으면 false · 읽거나 쓰지 못하면 throw
function setAthenaBoardPort(dir, port) {
  const file = path.join(dir, 'athena.config.json')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  const current = JSON.parse(text)
  if (!current || typeof current !== 'object' || Array.isArray(current) || current.screen !== 'studio') return false
  if (current.boardPort === port) return false
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...current, boardPort: port }, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return true
}

// 로그인 셸이 찍은 PATH 를 표시 사이에서 꺼낸다(rc 파일이 찍는 다른 글자는 버린다)
const PATH_MARK = '__ATHENA_STUDIO_PATH__'

function parseMarkedPath(output) {
  const start = output.indexOf(PATH_MARK)
  if (start < 0) return null
  const end = output.indexOf(PATH_MARK, start + PATH_MARK.length)
  if (end < 0) return null
  const value = output.slice(start + PATH_MARK.length, end).trim()
  return value || null
}

// 기존 PATH 앞에 로그인 셸 PATH 를 두고 겹치는 항목은 한 번만
function mergePath(loginPath, currentPath) {
  const parts = [...(loginPath || '').split(':'), ...(currentPath || '').split(':')].filter(Boolean)
  return [...new Set(parts)].join(':')
}

function findExecutable(name, pathValue, isExecutable = defaultIsExecutable) {
  for (const dir of (pathValue || '').split(':').filter(Boolean)) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function defaultIsExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

// 자식 프로세스 환경. 앱을 herdr 안에서 켰을 때 물려받은 HERDR_* 를 지워야
// 작업 창 pane 셸(·그 안의 아테나)이 herdr pane 안이라고 착각하지 않는다
// 앱을 에이전트(claude) 세션 안에서 켰을 때 물려받은 표시도 지운다 — 남으면 pane 의 claude 가
// 자기를 하위 세션으로 알고(대화 기록 저장 꺼짐) 아테나가 관리 창(ATHENA_AGENT)으로 알아 첫 실행·화면 세팅을 건너뛴다.
// 아테나 delegate.sh 실행기가 에이전트 pane 에 넣는 값(ATHENA_REPO_DIR · ATHENA_VERIFY_DIR)도 — 남으면 상태줄(statusline.sh)이
// cwd 보다 그 레포를 먼저 보고, 검증 스크립트가 그 워크트리를 본다
const INHERITED_SESSION_KEYS = ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'ATHENA_AGENT', 'ATHENA_REPO_DIR', 'ATHENA_VERIFY_DIR']

function childEnv(baseEnv, extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith('HERDR_') || key.startsWith('CLAUDE_CODE_')) continue
    // 스튜디오 pane 안에서 앱을 켰을 때의 표시 — pane 셸·현황판에는 데몬·main 이 새 값을 다시 넣는다
    if (key === 'ATHENA_STUDIO' || key.startsWith('ATHENA_STUDIO_')) continue
    if (INHERITED_SESSION_KEYS.includes(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

function terminalEnv(baseEnv) {
  return childEnv(baseEnv, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'AthenaStudio',
    LANG: baseEnv.LANG || 'ko_KR.UTF-8',
  })
}

// 아테나 에이전트 — 작업 창의 athena 작업 공간(아테나 폴더)에서 켠다(화면 세팅 · 첫 실행은 아테나 훅이 맡는다)
const AGENTS = ['claude', 'codex']
const ATHENA_WORKSPACE = 'athena'

function availableAgents(pathValue, isExecutable = defaultIsExecutable) {
  return AGENTS.filter((name) => findExecutable(name, pathValue, isExecutable))
}

// 묻지 않고 깔린 것 중 첫 번째(AGENTS 순서라 claude 가 있으면 claude), 없으면 none — 다른 에이전트는 작업 창에서 직접 켠다
function agentDecision(available) {
  if (available.length === 0) return { none: true }
  return { agent: available[0] }
}

// 데몬 상태의 작업 공간 중 이름이 athena 이고 그 아테나 폴더인 것 — 아테나 폴더를 바꿨으면 예전 폴더의 athena 작업 공간은 건드리지 않는다
function findAthenaWorkspace(workspaces, athenaDir) {
  return (workspaces || []).find((workspace) => workspace.label === ATHENA_WORKSPACE && sameDir(workspace.cwd, athenaDir)) || null
}

// 링크를 어디서 열지: 현황판에서 누른 것 · localhost(계획서 · 테스트 화면)는 옆 브라우저(panel), 그 밖의 http(s) 는 기본 브라우저, 나머지는 막는다
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

function openTarget(rawUrl, { fromBoard = false } = {}) {
  if (!isWebUrl(rawUrl)) return 'deny'
  if (fromBoard) return 'panel'
  return LOCAL_HOSTS.includes(new URL(rawUrl).hostname) ? 'panel' : 'external'
}

// 옆 브라우저가 열 수 있는 주소 — http(s) 만
function isWebUrl(rawUrl) {
  try {
    const { protocol } = new URL(rawUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// 주소창에 친 글자 → 주소. 스킴이 없으면 localhost:3000 · 127.0.0.1 은 http, 그 밖은 https 를 붙인다. 열 수 없으면 null
function normalizeAddress(input) {
  const text = String(input || '').trim()
  if (!text) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return isWebUrl(text) ? text : null
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text)
  const candidate = `${local ? 'http' : 'https'}://${text}`
  return isWebUrl(candidate) ? candidate : null
}

function boardUrl(port) {
  return `http://localhost:${port}`
}

// 데몬 파일 자리. 맥 유닉스 소켓 경로는 104바이트(끝 NUL 포함)를 넘으면 connect 가 EINVAL 이다(2026-10-17 실측) —
// userData 경로가 길면 소켓만 tmpdir/athena-studio-<uid>/ 로 옮긴다. endpoint 는 pane 밖에서 데몬을 찾는 접속 파일(S4)
const SOCKET_PATH_MAX = 103

// endpoint — 데몬 접속 파일. ATHENA_STUDIO_ENDPOINT 가 있으면 그 자리(아테나 screen.py 와 같은 변수 · 개발 · 회귀 검사용 격리 —
// Electron 은 HOME 을 바꿔도 홈 경로를 그대로 써서, 격리 실행이 사용자 앱의 접속 파일을 덮을 수 있다)
function daemonPaths({ userData, home, tmpdir, uid, endpoint = null }) {
  let socket = path.join(userData, 'daemon.sock')
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) socket = path.join(tmpdir, `athena-studio-${uid}`, 'daemon.sock')
  // 대체 자리도 길면 여기서 알린다 — 데몬이 listen 하다 EINVAL 로 죽는 것보다 원인이 분명하다
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`데몬 소켓 경로가 ${SOCKET_PATH_MAX}바이트를 넘어요: ${socket}`)
  return {
    socket,
    log: path.join(userData, 'daemon.log'),
    endpoint: endpoint || path.join(home, '.athena-studio', 'daemon.json'),
  }
}

// 본체마다 에이전트가 도는 pane 수 — 묶이지 않은 데몬 연결의 state.workspaces(body) + pane list(workspace_id · agent · agent_status).
// 본체를 모르는 작업 공간(body null)은 어느 팩에도 세지 않는다. → { '<본체>': { agents, working } }
function agentsByBody(workspaces, panes) {
  const bodyOf = new Map((workspaces || []).filter((workspace) => workspace && workspace.body).map((workspace) => [workspace.id, workspace.body]))
  const counts = {}
  for (const pane of panes || []) {
    const body = pane && pane.agent ? bodyOf.get(pane.workspace_id) : null
    if (!body) continue
    const entry = counts[body] || (counts[body] = { agents: 0, working: 0 })
    entry.agents += 1
    if (pane.agent_status === 'working') entry.working += 1
  }
  return counts
}

// 팩 목록(pack list 의 packs[].body)에 맞춰 팩 id → { agents, working } — 본체 경로는 realDir 로 맞춘다(~/athena 링크 등). 도는 게 없으면 빠진다
function runningByPack(packs, byBody, real = (dir) => dir) {
  const realCounts = new Map(Object.entries(byBody || {}).map(([body, count]) => [real(body), count]))
  const running = {}
  for (const pack of packs || []) {
    if (!pack || typeof pack.id !== 'string' || typeof pack.body !== 'string' || !pack.body) continue
    const count = realCounts.get(real(pack.body))
    if (count && count.agents) running[pack.id] = count
  }
  return running
}

module.exports = {
  DEFAULT_CONFIG,
  PATH_MARK,
  loadConfig,
  saveConfig,
  checkAthenaDir,
  studioAthenaDir,
  sameDir,
  realDir,
  reposRootFor,
  boardPortCandidates,
  parseLsofPath,
  setAthenaBoardPort,
  ensureAthenaConfig,
  parseMarkedPath,
  mergePath,
  findExecutable,
  childEnv,
  terminalEnv,
  ATHENA_WORKSPACE,
  availableAgents,
  agentDecision,
  findAthenaWorkspace,
  openTarget,
  isWebUrl,
  normalizeAddress,
  boardUrl,
  SOCKET_PATH_MAX,
  daemonPaths,
  windowDirs,
  withWindows,
  agentsByBody,
  runningByPack,
}
