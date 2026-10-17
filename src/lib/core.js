// Electron 없이 돌아가는 순수 로직 — 서버에서 `npm test` 로 검사한다.
const fs = require('fs')
const path = require('path')

const DEFAULT_CONFIG = { athenaDir: null, boardPort: 4700 }

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
  return config
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

// 아테나 받기 — 고른 폴더 안의 athena/ 에 코어 레포를 clone 한다(코드는 아테나 레포가 관리한다)
const ATHENA_REPO = 'https://github.com/novum-lab-kr/athena.git'
const ATHENA_DIR_NAME = 'athena'

// 받을 자리: 없거나 빈 폴더면 clone, 이미 아테나면 그대로 쓰고, 다른 것이 있으면 건드리지 않는다
function installTarget(parent) {
  const dir = path.join(parent, ATHENA_DIR_NAME)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return { dir, action: 'clone' }
    return { dir, action: 'conflict' }
  }
  if (entries.length === 0) return { dir, action: 'clone' }
  return { dir, action: checkAthenaDir(dir).ok ? 'use' : 'conflict' }
}

// 이 컴퓨터 설정(athena.config.json · git 무시)이 없으면 팩 없는 최소 설정을 만든다.
// 아테나는 이 파일이 없으면 현황판이 뜨지 않고, 팩이 없으면 claude · codex 를 켤 때 /setup 이 시작된다
function ensureAthenaConfig(dir) {
  const file = path.join(dir, 'athena.config.json')
  if (fs.existsSync(file)) return false
  fs.writeFileSync(file, JSON.stringify({ reposRoot: '..' }, null, 2) + '\n')
  return true
}

// git clone --progress 는 \r 로 같은 줄을 고쳐 쓴다 — 마지막 줄만 보여 준다
function lastProgressLine(chunk) {
  const lines = String(chunk).split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : null
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

// 고른 것이 있으면 그것, 하나뿐이면 그것, 둘 이상이면 물어본다(choose), 없으면 none
function agentDecision(available, chosen) {
  if (chosen) return available.includes(chosen) ? { agent: chosen } : { error: `${chosen} 을 찾지 못했어요` }
  if (available.length === 1) return { agent: available[0] }
  if (available.length === 0) return { none: true }
  return { choose: available }
}

// 데몬 상태의 작업 공간 중 이름이 athena 인 것
function findAthenaWorkspace(workspaces) {
  return (workspaces || []).find((workspace) => workspace.label === ATHENA_WORKSPACE) || null
}

// 새 창 요청 분류: 현황판 주소(결정 콘솔 등)는 앱 안 새 창, 그 밖의 http(s) 는 기본 브라우저, 나머지는 막는다
function classifyOpen(rawUrl, boardPort) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return 'deny'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'deny'
  const isBoard =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
    Number(url.port || 80) === Number(boardPort)
  return isBoard ? 'app' : 'external'
}

function boardUrl(port) {
  return `http://localhost:${port}`
}

// 데몬 파일 자리. 맥 유닉스 소켓 경로는 104바이트(끝 NUL 포함)를 넘으면 connect 가 EINVAL 이다(2026-10-17 실측) —
// userData 경로가 길면 소켓만 tmpdir/athena-studio-<uid>/ 로 옮긴다. endpoint 는 pane 밖에서 데몬을 찾는 접속 파일(S4)
const SOCKET_PATH_MAX = 103

function daemonPaths({ userData, home, tmpdir, uid }) {
  let socket = path.join(userData, 'daemon.sock')
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) socket = path.join(tmpdir, `athena-studio-${uid}`, 'daemon.sock')
  // 대체 자리도 길면 여기서 알린다 — 데몬이 listen 하다 EINVAL 로 죽는 것보다 원인이 분명하다
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) throw new Error(`데몬 소켓 경로가 ${SOCKET_PATH_MAX}바이트를 넘어요: ${socket}`)
  return {
    socket,
    log: path.join(userData, 'daemon.log'),
    endpoint: path.join(home, '.athena-studio', 'daemon.json'),
  }
}

module.exports = {
  DEFAULT_CONFIG,
  PATH_MARK,
  loadConfig,
  saveConfig,
  checkAthenaDir,
  ATHENA_REPO,
  installTarget,
  ensureAthenaConfig,
  lastProgressLine,
  parseMarkedPath,
  mergePath,
  findExecutable,
  childEnv,
  terminalEnv,
  ATHENA_WORKSPACE,
  availableAgents,
  agentDecision,
  findAthenaWorkspace,
  classifyOpen,
  boardUrl,
  SOCKET_PATH_MAX,
  daemonPaths,
}
