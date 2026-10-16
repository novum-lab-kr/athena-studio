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
// 앱 안의 herdr 가 "herdr 안의 herdr" 로 착각하지 않는다
function childEnv(baseEnv, extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith('HERDR_')) continue
    if (key === 'ELECTRON_RUN_AS_NODE') continue
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

// 작업 창에서 띄울 명령. herdr 가 있으면 herdr, 없으면 로그인 셸과 설치 안내
function terminalLaunch({ herdrPath, shell }) {
  const loginShell = shell || '/bin/zsh'
  if (herdrPath) return { file: herdrPath, args: [], notice: null }
  return {
    file: loginShell,
    args: ['-l'],
    notice: [
      '\x1b[33mherdr 를 찾지 못했어요.\x1b[0m 아래 셸에서 설치한 뒤 메뉴 [보기 → 작업 창 다시 시작] 을 눌러 주세요.',
      '설치 방법은 아테나 폴더의 README.md · ONBOARDING.md 를 보세요.',
      '',
    ].join('\r\n'),
  }
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

module.exports = {
  DEFAULT_CONFIG,
  PATH_MARK,
  loadConfig,
  saveConfig,
  checkAthenaDir,
  parseMarkedPath,
  mergePath,
  findExecutable,
  childEnv,
  terminalEnv,
  terminalLaunch,
  classifyOpen,
  boardUrl,
}
