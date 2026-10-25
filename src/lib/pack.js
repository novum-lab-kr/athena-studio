// 회사 팩 — Electron 없이 도는 순수 로직(npm test). 실제 일(잠금 · 링크 · 되돌리기 · 검사)은 아테나 본체 명령이 한다.
// 약속: 코어 `pack … --json` 출력(코어는 athena/)
//   node scripts/athena.mjs pack <명령> … --json → `progress: <단계ID> <설명>` 줄들 + 마지막 줄 JSON · 실패 종료 1 + { ok:false, error, message }
const path = require('path')

const i18n = require('./i18n')
const KOREAN = require('../i18n/ko.json')

// 문구는 사전(src/i18n)에서 — 부르는 쪽이 지금 언어의 say 를 넘긴다(없으면 한국어 · 테스트)
const koreanSay = i18n.translator(KOREAN, KOREAN)

// 진행 단계 이름 — 본체 progress 단계ID 와 스튜디오가 스스로 하는 단계(사전 pack.step.<ID>)
const STEP_IDS = ['lock', 'check', 'stop', 'link', 'repos', 'verify', 'done', 'rollback', 'body', 'port', 'slow'] // body · port — pack open 단계
// 본체 오류 코드(사전 pack.errorCode.<코드>)
const ERROR_CODES = ['locked', 'busy', 'not-found', 'invalid-pack', 'unsafe', 'format-unknown', 'token-expired', 'clone-failed', 'rollback', 'no-pack-support', 'bad-output', 'timeout', 'canceled', 'failed', 'conflict', 'invalid-name', 'invalid-image', 'image-too-large', 'contract-mismatch', 'body-conflict', 'body-mismatch', 'port-in-use', 'data-incompatible', 'not-applicable'] // body-… · port-in-use · data-incompatible — pack open · not-applicable — pack set-auto-merge(main 직접 레포)
// 남은 작업 종류(사전 pack.busy.<종류>)
const BUSY_KINDS = ['agent', 'athena', 'qa', 'learn-review', 'heavy', 'switch', 'outside', 'codex', 'unknown']

const stepLabel = (step, say = koreanSay) => (STEP_IDS.includes(step) ? say(`pack.step.${step}`) : null)

// 스트림을 줄 단위로 — 남은 반쪽 줄은 rest 로 돌려준다
function splitLines(rest, chunk) {
  const lines = (rest + chunk).split('\n')
  return { lines: lines.slice(0, -1), rest: lines[lines.length - 1] }
}

// `progress: <단계ID> <설명>` 한 줄 → { step, text } (아니면 null)
// 본체가 준 설명(한국어 · 번역 범위 밖)이 있으면 그대로, 없으면 사전의 단계 이름
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
// 본체 message 는 본체가 쓴 한국어 그대로(번역 범위 밖)
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
  // 빈 자리(pack new 뒤 /setup 전)도 팩으로 — 다른 팩으로 넘어간 뒤에도 다시 열 수 있게(empty 표시)
  const slots = Array.isArray(result.emptySlots) ? result.emptySlots : []
  for (const slot of slots) {
    if (slot && typeof slot.id === 'string' && !packs.some((pack) => pack.id === slot.id)) packs.push({ id: slot.id, name: slot.id, empty: true })
  }
  const current = result.current && typeof result.current.id === 'string' ? result.current : null
  return { supported: true, legacy: result.legacy === true, switching: result.switching === true, current, packs }
}

// 스튜디오가 아는 코어 약속 번호(2 = 팩마다 본체 · 3 = pack set-auto-merge · 오류 코드 not-applicable)
const CONTRACT = 3

// `version --json` 결과 → { contract, core }. 명령이 없는 옛 코어(사용법 오류 · JSON 이 아닌 출력)는 contract 1,
// 그 밖의 실패(시간 초과 · 실행 못 함 등 — 일시적일 수 있다)는 null(모름 — 기억하지 않고 다음에 다시 묻는다)
const OLD_CORE_ERRORS = ['usage', 'bad-output']
function contractOf(result) {
  if (result && result.ok === true && Number.isInteger(result.contract)) return { contract: result.contract, core: typeof result.core === 'string' ? result.core : null }
  if (result && result.ok === true) return { contract: 1, core: null }
  return { contract: result && OLD_CORE_ERRORS.includes(result.error) ? 1 : null, core: null }
}

// 화면에 보일 팩 이름 — 표시 이름(pack set-name) → 이름 → id
function packLabel(pack) {
  return (pack && (pack.displayName || pack.name || pack.id)) || ''
}

// 팩 이미지 — 본체가 준 iconPath 만 읽는다(화면이 경로를 정하지 않게). 절대 경로 · png/jpg/jpeg/webp · 크기 제한은 읽는 쪽(main)이 한 번 더
const ICON_MAX_BYTES = 1024 * 1024
const ICON_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']
function packIconPath(list, id) {
  if (!list || typeof id !== 'string') return null
  const pack = [...(Array.isArray(list.packs) ? list.packs : []), list.current].find((item) => item && item.id === id)
  const iconPath = pack && pack.iconPath
  if (typeof iconPath !== 'string' || !path.isAbsolute(iconPath)) return null
  return ICON_EXTENSIONS.includes(path.extname(iconPath).toLowerCase()) ? iconPath : null
}

// 이미지 앞 바이트로 형식 — png · jpeg · webp 만(SVG · GIF 등은 null)
function iconMime(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) return null
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png'
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

// pack status 의 현황판 포트 — 본체가 정한다(5.3: ATHENA_BOARD_PORT → 본체 설정 boardPort → 4700). 없거나 이상하면 null(옛 본체 — 앱 설정으로)
function statusBoardPort(result) {
  const port = result && result.ok === true ? result.boardPort : null
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

// 시작 화면(회사 팩이 아직 없어요)을 띄울까 — 목록도 비고 지금 팩도 없을 때만.
// 옛 구조 본체(legacy · packs:[] · current 있음) · 새로 만드는 빈 자리(current.empty) · 명령이 없는 본체(supported:false)는 아니다
// 빈 자리(empty)만 있으면 팩이 없는 것으로 본다
const realPacks = (list) => list.packs.filter((pack) => !pack.empty)
function showPackWelcome(list) {
  return Boolean(list && list.supported && Array.isArray(list.packs) && !realPacks(list).length && !list.current)
}

// 켤 때 시작 화면을 띄울까(팩이 있어도 — 사용자 결정 2026-10-18) — 팩 지원 본체 · 팩이 하나 이상 · 켤 때 도는 에이전트 pane 이 없을 때.
// 에이전트가 돌고 있으면(앱만 다시 켬) 하던 일을 끊지 않게 건너뛴다. 옛 구조 본체(legacy)는 목록이 없어 띄우지 않는다
function welcomeOnLaunch({ list, agentPanes }) {
  if (!list || !list.supported || list.legacy || !Array.isArray(list.packs) || !realPacks(list).length) return false
  return !(agentPanes > 0)
}

// 시작 화면 '내 팩' 목록 — 지금 팩 맨 위, 나머지는 updatedAt(그 팩 작업 기록 · pack.json 마지막 변경) 최근 순, 최대 limit 개
function recentPacks(list, limit = 5) {
  if (!list || !Array.isArray(list.packs)) return []
  const currentId = list.current && list.current.id
  const time = (pack) => Date.parse(pack.updatedAt) || 0
  const sorted = [...list.packs].sort((left, right) => {
    if (left.id === currentId) return -1
    if (right.id === currentId) return 1
    return time(right) - time(left)
  })
  return sorted.slice(0, limit).map((pack) => ({ id: pack.id, name: packLabel(pack), repos: pack.repos, updatedAt: pack.updatedAt || null, current: pack.id === currentId }))
}

// 현황판 /api/state 의 pack 이 지금 팩 · 세대와 같은가 — legacy(옛 본체 · pack 없음) · current · stale
function boardIdentity(boardState, current) {
  const pack = boardState && boardState.pack
  if (!pack || typeof pack !== 'object') return 'legacy'
  if (!current) return 'stale'
  return pack.id === current.id && pack.generation === current.generation ? 'current' : 'stale'
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

// 레포의 대표 에이전트 — 단일 레포는 agents 첫째, 모노레포는 첫 앱 에이전트(없으면 packagesAgent). 이름 모양만 받는다(아테나 pane 에 글로 쓰인다)
function repoAgent(repo) {
  const apps = repo && repo.apps && typeof repo.apps === 'object' ? Object.values(repo.apps).map((app) => app && app.agent) : []
  const agent = [...(Array.isArray(repo && repo.agents) ? repo.agents : []), ...apps, repo && repo.packagesAgent].find((name) => typeof name === 'string' && /^[\w-]{1,64}$/.test(name))
  return agent || null
}

// ⚙ 설정 — 레포별 PR 자동 리뷰 · 머지(pack.json "autoMerge" · "autoMergeConfirm" — 뜻은 코어 docs/pr-auto.md "켜기").
// main 직접 레포("direct": true)는 PR 이 없어 목록에서 뺀다. releaseOnMerge — 작업 base(prBase)가 운영 브랜치(branch)와 같아 머지가 곧 운영 반영
function mergeSettings(pack) {
  if (!pack || !Array.isArray(pack.repos)) return []
  return pack.repos
    .filter((repo) => repo && /^[\w.-]+$/.test(String(repo.name || '')) && repo.direct !== true)
    .map((repo) => ({
      name: repo.name,
      autoMerge: repo.autoMerge === true,
      confirm: repo.autoMergeConfirm !== false,
      releaseOnMerge: typeof repo.branch === 'string' && repo.branch !== '' && repo.prBase === repo.branch,
      prBase: typeof repo.prBase === 'string' ? repo.prBase : '',
    }))
}

// scripts/call-branch-info.sh 출력(탭으로 나눈 줄) — target · repo · main(상태 · 미커밋 수) · candidate(브랜치 · 로컬/원격 · 최근 활동 · 체크아웃 자리) · direct(메인 체크아웃)
function parseCallInfo(text) {
  const info = { target: '', main: null, candidates: [], direct: null }
  for (const line of String(text || '').split('\n')) {
    const [key, ...rest] = line.split('\t')
    if (key === 'target') info.target = rest[0] || ''
    else if (key === 'main') {
      const status = (rest[0] || '').replace(/^##\s*/, '')
      info.main = { status, dirty: Number(rest[1]) || 0, ...parseBranchStatus(status) }
    }
    else if (key === 'candidate' && rest[0]) info.candidates.push(parseCandidate(rest))
    else if (key === 'direct' && rest[0]) info.direct = rest[0]
  }
  return info
}

// 후보 브랜치 한 줄(scripts/branch-candidates.sh) — 자리(로컬 · 원격 · 둘 다) · 날짜 · 마지막 커밋 제목(커밋이 없으면 noCommits) · 워크트리
function parseCandidate([branch, where = '', activity = '', checkout = '']) {
  const [, date = '', what = ''] = activity.match(/^(\d{4}-\d{2}-\d{2}|\?)\s*(.*)$/) || []
  const place = where.includes('·') ? 'both' : where === '로컬' ? 'local' : 'remote'
  const noCommits = what.startsWith('(커밋 없음)')
  return { branch, place, date: date === '?' ? '' : date, subject: noCommits ? '' : what.trim(), noCommits, worktree: checkout && checkout !== '-' ? checkout : null }
}

// git status 머리줄("main...origin/main [ahead 1, behind 2]")을 나눈다 — 브랜치 · 원격 · 앞섬 · 뒤처짐. 원격이 없으면 upstream null
function parseBranchStatus(status) {
  const text = String(status || '').trim()
  const match = text.match(/^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.*)\])?$/)
  if (!match) return { branch: text, upstream: null, ahead: 0, behind: 0 }
  const counts = match[3] || ''
  const number = (word) => Number((counts.match(new RegExp(`${word} (\\d+)`)) || [])[1]) || 0
  return { branch: match[1].replace(/^No commits yet on /, ''), upstream: match[2] || null, ahead: number('ahead'), behind: number('behind'), gone: counts.includes('gone') }
}

// scripts/new-branch.sh 출력 — 만든(또는 이어 쓰는) 워크트리 자리 · "이미 있다"(이어 쓸지 다시 물어야 한다)
function parseNewBranch(text) {
  const lines = String(text || '').split('\n')
  const worktree = (lines.map((line) => line.match(/^\s*워크트리:\s*(\S.*)$/)).find(Boolean) || [])[1] || (lines.map((line) => line.match(/워크트리 경로가 이미 있다:\s*(\S.*)$/)).find(Boolean) || [])[1] || null
  const exists = !worktree && lines.some((line) => line.includes('이미 있다') && line.startsWith('⚠️'))
  const message = lines.filter((line) => /^(⚠️|❌|⏭)/.test(line.trim())).join('\n')
  return { worktree: worktree ? worktree.trim() : null, exists, message }
}

// 새 브랜치 이름(티켓 · fix/설명) — 셸에 넘기지는 않지만 git 이 받을 모양만
const validBranchInput = (text) => typeof text === 'string' && /^[\w\uAC00-\uD7A3][\w\uAC00-\uD7A3./-]{0,79}$/.test(text) && !text.includes('..') && !text.endsWith('/') && !text.endsWith('.lock')

module.exports = {
  repoAgent,
  mergeSettings,
  parseCallInfo,
  parseBranchStatus,
  parseNewBranch,
  validBranchInput,
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
  welcomeOnLaunch,
  recentPacks,
  CONTRACT,
  contractOf,
  packLabel,
  ICON_MAX_BYTES,
  packIconPath,
  iconMime,
  statusBoardPort,
  packSummary,
}
