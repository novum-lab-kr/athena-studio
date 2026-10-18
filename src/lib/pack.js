// 회사 팩 — Electron 없이 도는 순수 로직(npm test). 실제 일(잠금 · 링크 · 되돌리기 · 검사)은 아테나 본체 명령이 한다.
// 약속 정본: 아테나 계획서 plans/feature/20261018-여러-회사-팩.md "5. 공통 스펙"
//   node scripts/athena.mjs pack <명령> … --json → `progress: <단계ID> <설명>` 줄들 + 마지막 줄 JSON · 실패 종료 1 + { ok:false, error, message }
const path = require('path')

const i18n = require('./i18n')
const KOREAN = require('../i18n/ko.json')

// 문구는 사전(src/i18n)에서 — 부르는 쪽이 지금 언어의 say 를 넘긴다(없으면 한국어 · 테스트)
const koreanSay = i18n.translator(KOREAN, KOREAN)

// 진행 단계 이름 — 본체 progress 단계ID 와 스튜디오가 스스로 하는 단계(사전 pack.step.<ID>)
const STEP_IDS = ['lock', 'check', 'stop', 'link', 'repos', 'verify', 'done', 'rollback', 'studio-wait', 'studio-stop', 'studio-close', 'studio-busy', 'studio-board', 'slow']
// 본체 오류 코드(사전 pack.errorCode.<코드>)
const ERROR_CODES = ['locked', 'busy', 'not-found', 'invalid-pack', 'unsafe', 'format-unknown', 'token-expired', 'clone-failed', 'rollback', 'no-pack-support', 'bad-output', 'timeout', 'canceled', 'failed', 'conflict']
// 남은 작업 종류(사전 pack.busy.<종류>)
const BUSY_KINDS = ['agent', 'athena', 'qa', 'learn-review', 'heavy', 'switch', 'outside']

const stepLabel = (step, say = koreanSay) => (STEP_IDS.includes(step) ? say(`pack.step.${step}`) : null)

// 스튜디오가 끌 수 없고 코어도 끄지 않는 것 — 남아 있으면 pane 을 닫기 전에 멈춘다.
// QA · 배우기 검토는 코어가 pack use 때 끈다(5.2 · Q7) — 막지 않는다. 밖의 에이전트는 switchCheck 가 따로 가린다
const BLOCKING_KINDS = ['heavy', 'switch']
// 바꾸기 전 '다 끝났나' 확인에서 기다릴 것 — 코어가 끄는 QA · 배우기 검토는 빼고 본다
const STOPPED_BY_CORE = ['qa', 'learn-review']
const remainingBusy = (busy) => (busy || []).filter((item) => !STOPPED_BY_CORE.includes(item.kind))
const AGENT_KINDS = ['agent', 'athena']

// 스트림을 줄 단위로 — 남은 반쪽 줄은 rest 로 돌려준다
function splitLines(rest, chunk) {
  const lines = (rest + chunk).split('\n')
  return { lines: lines.slice(0, -1), rest: lines[lines.length - 1] }
}

// `progress: <단계ID> <설명>` 한 줄 → { step, text } (아니면 null)
// 본체가 준 설명(한국어 · D4 범위 밖)이 있으면 그대로, 없으면 사전의 단계 이름
function parseProgressLine(line, say = koreanSay) {
  const match = /^progress:\s+(\S+)\s*(.*)$/.exec(String(line).trim())
  if (!match) return null
  return { step: match[1], text: match[2] || stepLabel(match[1], say) || match[1] }
}

// 명령 출력 전체 → { progress: [...], result } — 마지막 비지 않은 줄이 JSON 이어야 한다
function parsePackOutput(text, say = koreanSay) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const progress = lines.map((line) => parseProgressLine(line, say)).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return { progress, raw: '', result: { ok: false, error: 'bad-output', message: say('pack.error.emptyOutput') } }
  try {
    const result = JSON.parse(last)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('객체가 아님')
    return { progress, result }
  } catch {
    // 원문은 화면에 넣지 않는다(비밀값이 섞일 수 있다) — 부르는 쪽이 raw 를 pack.log 에만 남긴다
    return { progress, raw: last.slice(0, 2000), result: { ok: false, error: 'bad-output', message: say('pack.error.notJson') } }
  }
}

// 오류 결과 → 화면에 보일 한 문장(본체 message 가 있으면 뒤에 붙인다)
// 본체 message 는 본체가 쓴 한국어 그대로(D4 범위 밖)
function packErrorText(result, say = koreanSay) {
  if (!result || result.ok) return ''
  const base = ERROR_CODES.includes(result.error) ? say(`pack.errorCode.${result.error}`) : say('pack.error.unknown')
  const detail = result.message && result.message !== base ? ` — ${result.message}` : ''
  const busy = Array.isArray(result.busy) && result.busy.length ? `\n${busyLines(result.busy, say).join('\n')}` : ''
  return `${base}${detail}${busy}`
}

function busyLines(busy, say = koreanSay) {
  const kindLabel = (kind) => (BUSY_KINDS.includes(kind) ? say(`pack.busy.${kind}`) : kind)
  return (busy || []).map((item) => `· ${kindLabel(item.kind)}${item.what ? ` — ${item.what}` : ''}${item.pid ? ` (pid ${item.pid})` : ''}`)
}

// git 주소 — https:// · ssh:// · git@host:path 만. 공백 · 셸 문자 · 옵션처럼 보이는 것 · 비밀번호가 든 주소는 받지 않는다
function validGitUrl(text) {
  const value = String(text || '').trim()
  if (!value || value.length > 500 || value.startsWith('-')) return null
  if (/[\s'"`$;&|<>\\]/.test(value) || /[\u0000-\u001f]/.test(value)) return null
  if (/^https:\/\//i.test(value)) {
    let url
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (url.password) return null // 토큰 · 비밀번호를 주소에 넣으면 설정 · 기록에 남는다
    return url.hostname && url.pathname.length > 1 ? value : null
  }
  if (/^ssh:\/\/[\w.-]+(@[\w.-]+)?(:\d+)?\/[\w./~-]+$/i.test(value)) return value
  if (/^git@[\w.-]+:[\w./~-]+$/.test(value)) return value
  return null
}

// pack list 결과 → 화면이 쓰는 모양. 명령이 없거나(옛 본체) 실패면 supported:false
function normalizePackList(result) {
  if (!result || result.ok !== true || !Array.isArray(result.packs)) return { supported: false, error: (result && result.error) || 'bad-output' }
  const packs = result.packs.filter((pack) => pack && typeof pack.id === 'string')
  const current = result.current && typeof result.current.id === 'string' ? result.current : null
  return { supported: true, legacy: result.legacy === true, switching: result.switching === true, current, packs }
}

// pack status 의 데이터 폴더(R1 — 코어가 정한 실제 경로). 없거나(옛 응답) 절대 경로가 아니면 null
function statusDataDir(result) {
  const dir = result && result.ok === true ? result.dataDir : null
  return typeof dir === 'string' && path.isAbsolute(dir) ? dir : null
}

// pack status 의 현황판 포트 — 본체가 정한다(5.3: ATHENA_BOARD_PORT → 본체 설정 boardPort → 4700). 없거나 이상하면 null(옛 본체 — 앱 설정으로)
function statusBoardPort(result) {
  const port = result && result.ok === true ? result.boardPort : null
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

// 시작 화면(회사 팩이 아직 없어요)을 띄울까 — 목록도 비고 지금 팩도 없을 때만.
// 옛 구조 본체(legacy · packs:[] · current 있음) · 새로 만드는 빈 자리(current.empty) · 명령이 없는 본체(supported:false)는 아니다
function showPackWelcome(list) {
  return Boolean(list && list.supported && Array.isArray(list.packs) && !list.packs.length && !list.current)
}

// 현황판 /api/state 의 pack 이 지금 팩 · 세대와 같은가 — legacy(옛 본체 · pack 없음) · current · stale
function boardIdentity(boardState, current) {
  const pack = boardState && boardState.pack
  if (!pack || typeof pack !== 'object') return 'legacy'
  if (!current) return 'stale'
  return pack.id === current.id && pack.generation === current.generation ? 'current' : 'stale'
}

// pid 가 어느 pane 안에서 도는지 — 조상을 따라가 pane 셸 pid 를 찾는다(없으면 null)
function paneOfPid(pid, paneByPid, parentOf) {
  let current = pid
  for (let depth = 0; depth < 64 && Number.isInteger(current) && current > 1; depth++) {
    if (paneByPid.has(current)) return paneByPid.get(current)
    current = parentOf.get(current)
  }
  return null
}

// 본체 busy 의 에이전트를 스튜디오 pane 에 맞춘다 — { inside: 그 에이전트를 품은 pane id, outside: 밖에서 도는 수, unknown }.
// 모든 pane 셸 pid 와 프로세스 부모 표(pid → ppid)가 있어야 가린다. 하나라도 모르면(옛 데몬 · busy 에 pid 없음)
// unknown — 부르는 쪽은 아무것도 닫지 않고 멈춘다(닫은 뒤에 거절되면 pane 만 잃는다)
function matchAgents({ agentItems, panes, parentOf }) {
  if (!agentItems.length) return { inside: new Set(), outside: 0, unknown: false }
  const known = parentOf instanceof Map && panes.every((pane) => Number.isInteger(pane.pid)) && agentItems.every((item) => Number.isInteger(item.pid))
  if (!known) return { inside: new Set(), outside: 0, unknown: true }
  const paneByPid = new Map(panes.map((pane) => [pane.pid, pane.id]))
  const inside = new Set()
  let outside = 0
  for (const item of agentItems) {
    const paneId = paneOfPid(item.pid, paneByPid, parentOf)
    if (paneId) inside.add(paneId)
    else outside += 1
  }
  return { inside, outside, unknown: false }
}

// 바꾸기 전 점검 — 스튜디오 pane 과 본체 busy 를 맞춰 닫을 pane 을 정하고, 스튜디오가 끌 수 없는 것이 있으면 막는다.
// 기다리기 · 멈추기는 닫을 pane 안의 에이전트만 본다(다른 프로젝트에서 일하는 claude 때문에 기다리지 않게 — R2)
function switchCheck({ panes, busy, parentOf = null, workspaces = [], athenaDirs = [], resolve = (dir) => dir }) {
  const list = (panes || []).filter(Boolean)
  const items = busy || []
  const blockers = items.filter((item) => BLOCKING_KINDS.includes(item.kind))
  const matched = matchAgents({ agentItems: items.filter((item) => AGENT_KINDS.includes(item.kind)), panes: list, parentOf })
  const close = panesToClose({ panes: list, workspaces, athenaDirs, resolve, agentPanes: matched.inside })
  const closing = new Set(close)
  const working = list.filter((pane) => closing.has(pane.id) && pane.agent && pane.agent_status === 'working').map((pane) => pane.id)
  return {
    close,
    working,
    blockers,
    externalAgents: matched.outside,
    unknownAgents: matched.unknown,
    canProceed: blockers.length === 0 && matched.outside === 0 && !matched.unknown,
  }
}

// child 가 parent 안인가 — 링크는 부르는 쪽이 실제 경로로 풀어 넘긴다(realDir). `..cache` 같은 이름은 안쪽이다
function insideDir(child, parent) {
  if (!child || !parent) return false
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

// 바꿀 때 닫을 pane(R2) — 본체 busy 의 에이전트를 품은 pane + 아테나 작업 공간 + 아테나 본체 · 데이터 폴더 안 pane.
// 다른 프로젝트에서 도는 claude · 다른 폴더 셸은 둔다 — 팩 상태를 들고 있지 않다. resolve 는 링크를 실제 경로로 푸는 함수(main 이 realDir)
function panesToClose({ panes, workspaces, athenaDirs, resolve = (dir) => dir, agentPanes = new Set() }) {
  const athenaWorkspaces = new Set((workspaces || []).filter((workspace) => workspace.label === 'athena').map((workspace) => workspace.id))
  const dirs = (athenaDirs || []).filter(Boolean).map(resolve)
  return (panes || [])
    .filter((pane) => {
      if (agentPanes.has(pane.id)) return true
      if (athenaWorkspaces.has(pane.workspace_id)) return true
      const cwd = pane.foreground_cwd || pane.cwd
      return Boolean(cwd) && dirs.some((dir) => insideDir(resolve(cwd), dir))
    })
    .map((pane) => pane.id)
}

// 처음 켤 때 고를 기본 본체 — 저장된 것이 있으면 그것, 없으면 ~/athena(사용자 결정 1)
function defaultAthenaDir(config, homeAthena, isAthenaDir) {
  if (config.athenaDir && isAthenaDir(config.athenaDir)) return config.athenaDir
  return isAthenaDir(homeAthena) ? homeAthena : null
}

// 스튜디오 레포 athena/ 를 쓰던 사람 — ~/athena 가 여러 팩을 지원하면 옮기기를 한 번 묻는다
function shouldOfferMoveToHome({ config, studioAthena, homeSupportsPacks, sameDir }) {
  if (config.homeAthenaAsked) return false
  if (!config.athenaDir || !sameDir(config.athenaDir, studioAthena)) return false
  return homeSupportsPacks === true
}

// 같은 이름 팩 비교 줄
function packSummary(pack, say = koreanSay) {
  if (!pack) return ''
  const parts = []
  if (Number.isFinite(pack.repos)) parts.push(say('pack.meta.repos', { count: pack.repos }))
  if (pack.updatedAt) parts.push(say('pack.meta.updated', { date: String(pack.updatedAt).slice(0, 10) }))
  if (pack.createdAt) parts.push(say('pack.meta.created', { date: String(pack.createdAt).slice(0, 10) }))
  if (pack.hasWork) parts.push(say('pack.meta.hasWork'))
  if (pack.source) parts.push(pack.source === 'git' ? 'git' : say('pack.meta.local'))
  return parts.join(' · ')
}

module.exports = {
  STEP_IDS,
  ERROR_CODES,
  BUSY_KINDS,
  stepLabel,
  splitLines,
  parseProgressLine,
  parsePackOutput,
  packErrorText,
  busyLines,
  validGitUrl,
  normalizePackList,
  boardIdentity,
  showPackWelcome,
  statusBoardPort,
  statusDataDir,
  switchCheck,
  remainingBusy,
  panesToClose,
  insideDir,
  matchAgents,
  defaultAthenaDir,
  shouldOfferMoveToHome,
  packSummary,
}
