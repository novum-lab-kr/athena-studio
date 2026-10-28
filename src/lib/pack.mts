// 회사 팩 — Electron 없이 도는 순수 로직(npm test). 실제 일(잠금 · 링크 · 되돌리기 · 검사)은 아테나 본체 명령이 한다.
// 약속: 코어 `pack … --json` 출력(코어는 athena/)
//   node scripts/athena.mjs pack <명령> … --json → `progress: <단계ID> <설명>` 줄들 + 마지막 줄 JSON · 실패 종료 1 + { ok:false, error, message }
import path from 'node:path'
import { createRequire } from 'node:module'
import * as i18n from './i18n.mts'

// 문구 — say(키, 자리 값). 사전 · 자리 채우기는 i18n.mts
export type Say = (key: string, values?: Record<string, unknown>) => string
type Dictionary = Record<string, string>

// 사전은 JSON — main 과 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const KOREAN: Dictionary = require('../i18n/ko.json')

// 코어 `pack … --json` 결과 — 읽는 칸만, 모양은 칸마다 따로 본다
export type PackResult = { [key: string]: unknown; ok?: unknown; error?: unknown; message?: unknown; busy?: unknown }
type BusyItem = { kind?: unknown; what?: unknown; pid?: unknown }
// 팩 목록의 팩 하나 — 코어가 주는 칸 그대로(읽는 칸만)
export type PackEntry = { [key: string]: unknown; id: string; name?: unknown; displayName?: unknown; empty?: boolean; updatedAt?: unknown; repos?: unknown; iconPath?: unknown }
export type PackList = { supported: true; legacy: boolean; switching: boolean; current: PackEntry | null; packs: PackEntry[] } | { supported: false; error: unknown }
// pack.json repos[] 하나 — 읽는 칸만
type Repo = { name?: unknown; displayName?: unknown; icon?: unknown; apps?: unknown; agents?: unknown; packagesAgent?: unknown; direct?: unknown; autoMerge?: unknown; autoMergeConfirm?: unknown; branch?: unknown; prBase?: unknown }

// 문구는 사전(src/i18n)에서 — 부르는 쪽이 지금 언어의 say 를 넘긴다(없으면 한국어 · 테스트)
const koreanSay = i18n.translator(KOREAN, KOREAN)

// 진행 단계 이름 — 본체 progress 단계ID 와 스튜디오가 스스로 하는 단계(사전 pack.step.<ID>)
export const STEP_IDS: readonly string[] = ['lock', 'check', 'stop', 'link', 'repos', 'verify', 'done', 'rollback', 'body', 'port', 'slow'] // body · port — pack open 단계
// 본체 오류 코드(사전 pack.errorCode.<코드>)
export const ERROR_CODES: readonly string[] = ['locked', 'busy', 'not-found', 'invalid-pack', 'unsafe', 'format-unknown', 'token-expired', 'clone-failed', 'rollback', 'no-pack-support', 'bad-output', 'timeout', 'canceled', 'failed', 'conflict', 'invalid-name', 'invalid-image', 'image-too-large', 'contract-mismatch', 'body-conflict', 'body-mismatch', 'port-in-use', 'data-incompatible', 'not-applicable', 'core-old'] // body-… · port-in-use · data-incompatible — pack open · not-applicable — pack set-auto-merge(main 직접 레포) · core-old — 스튜디오가 붙인다(coreTooOld)
// 남은 작업 종류(사전 pack.busy.<종류>)
export const BUSY_KINDS: readonly string[] = ['agent', 'athena', 'qa', 'learn-review', 'heavy', 'switch', 'outside', 'codex', 'unknown']

export const stepLabel = (step: string, say: Say = koreanSay): string | null => (STEP_IDS.includes(step) ? say(`pack.step.${step}`) : null)

// 스트림을 줄 단위로 — 남은 반쪽 줄은 rest 로 돌려준다
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const lines = (rest + chunk).split('\n')
  return { lines: lines.slice(0, -1), rest: lines[lines.length - 1] ?? '' }
}

// `progress: <단계ID> <설명>` 한 줄 → { step, text } (아니면 null)
// 본체가 준 설명(한국어 · 번역 범위 밖)이 있으면 그대로, 없으면 사전의 단계 이름
export function parseProgressLine(line: unknown, say: Say = koreanSay): { step: string; text: string } | null {
  const match = /^progress:\s+(\S+)\s*(.*)$/.exec(String(line).trim())
  if (!match) return null
  const step = match[1] ?? ''
  return { step, text: match[2] || stepLabel(step, say) || step }
}

// 명령 출력 전체 → { progress: [...], result } — 마지막 비지 않은 줄이 JSON 이어야 한다
export function parsePackOutput(text: unknown, say: Say = koreanSay): { progress: { step: string; text: string }[]; raw?: string; result: PackResult } {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const progress = lines.map((line) => parseProgressLine(line, say)).filter((item) => item !== null)
  const last = lines[lines.length - 1]
  if (!last) return { progress, raw: '', result: { ok: false, error: 'bad-output', message: say('pack.error.emptyOutput') } }
  try {
    const result: unknown = JSON.parse(last)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('객체가 아님')
    return { progress, result: result as PackResult }
  } catch {
    // 원문은 화면에 넣지 않는다(비밀값이 섞일 수 있다) — 부르는 쪽이 raw 를 pack.log 에만 남긴다
    return { progress, raw: last.slice(0, 2000), result: { ok: false, error: 'bad-output', message: say('pack.error.notJson') } }
  }
}

// 오류 결과 → 화면에 보일 한 문장(본체 message 가 있으면 뒤에 붙인다)
// 본체 message 는 본체가 쓴 한국어 그대로(번역 범위 밖)
export function packErrorText(result: PackResult | null | undefined, say: Say = koreanSay): string {
  if (!result || result.ok) return ''
  const base = typeof result.error === 'string' && ERROR_CODES.includes(result.error) ? say(`pack.errorCode.${result.error}`) : say('pack.error.unknown')
  const detail = result.message && result.message !== base ? ` — ${result.message}` : ''
  const busy = Array.isArray(result.busy) && result.busy.length ? `\n${busyLines(result.busy, say).join('\n')}` : ''
  return `${base}${detail}${busy}`
}

export function busyLines(busy: BusyItem[] | null | undefined, say: Say = koreanSay): string[] {
  const kindLabel = (kind: unknown) => (typeof kind === 'string' && BUSY_KINDS.includes(kind) ? say(`pack.busy.${kind}`) : kind)
  return (busy || []).map((item) => `· ${kindLabel(item.kind)}${item.what ? ` — ${item.what}` : ''}${item.pid ? ` (pid ${item.pid})` : ''}`)
}

// git 주소 — https:// · ssh:// · git@host:path 만. 공백 · 셸 문자 · 옵션처럼 보이는 것 · 비밀번호가 든 주소는 받지 않는다
export function validGitUrl(text: unknown): string | null {
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
export function normalizePackList(result: PackResult | null | undefined): PackList {
  if (!result || result.ok !== true || !Array.isArray(result.packs)) return { supported: false, error: (result && result.error) || 'bad-output' }
  const packs: PackEntry[] = result.packs.filter((pack: { id?: unknown } | null) => pack && typeof pack.id === 'string')
  // 빈 자리(pack new 뒤 /setup 전)도 팩으로 — 다른 팩으로 넘어간 뒤에도 다시 열 수 있게(empty 표시)
  const slots: ({ id?: unknown } | null)[] = Array.isArray(result.emptySlots) ? result.emptySlots : []
  for (const slot of slots) {
    if (slot && typeof slot.id === 'string' && !packs.some((pack) => pack.id === slot.id)) packs.push({ id: slot.id, name: slot.id, empty: true })
  }
  const reported = result.current as { id?: unknown } | null | undefined
  const current = reported && typeof reported.id === 'string' ? (reported as PackEntry) : null
  return { supported: true, legacy: result.legacy === true, switching: result.switching === true, current, packs }
}

// 스튜디오가 아는 코어 약속 번호(2 = 팩마다 본체 · 3 = pack set-auto-merge · 오류 코드 not-applicable)
export const CONTRACT = 3

// `version --json` 결과 → { contract, core }. 명령이 없는 옛 코어(사용법 오류 · JSON 이 아닌 출력)는 contract 1,
// 그 밖의 실패(시간 초과 · 실행 못 함 등 — 일시적일 수 있다)는 null(모름 — 기억하지 않고 다음에 다시 묻는다)
const OLD_CORE_ERRORS: readonly unknown[] = ['usage', 'bad-output']
export function contractOf(result: PackResult | null | undefined): { contract: number | null; core: string | null } {
  if (result && result.ok === true && Number.isInteger(result.contract)) return { contract: result.contract as number, core: typeof result.core === 'string' ? result.core : null }
  if (result && result.ok === true) return { contract: 1, core: null }
  return { contract: result && OLD_CORE_ERRORS.includes(result.error) ? 1 : null, core: null }
}

// 약속 번호를 올리지 않고 나중에 더한 명령 → 그 명령을 아는 코어의 손잡이(코어 version capabilities · athena/scripts/lib/bodies.mjs CAPABILITIES)
const COMMAND_CAPABILITIES: Record<string, string> = { 'pack set-repo-name': 'repo-look', 'pack set-repo-icon': 'repo-look' }
const commandName = (argv: string[]) => (argv[0] === 'pack' ? `pack ${argv[1]}` : String(argv[0] || ''))
// "알 수 없는 답"이 온 명령 · 그 본체의 version 결과 → 본체 코어가 옛 버전이라 그 명령을 모르나.
// 약속 번호가 낮으면(명령 없음 → 1 포함) 옛 코어 · 같으면 그 명령의 손잡이가 capabilities 에 없을 때만. version 을 못 물었으면(일시 실패) 모름 → false
export function coreTooOld(argv: string[] | null | undefined, versionResult: PackResult | null | undefined): boolean {
  const { contract } = contractOf(versionResult)
  if (contract === null) return false
  if (contract < CONTRACT) return true
  const needed = COMMAND_CAPABILITIES[commandName(argv || [])]
  const capabilities: unknown[] = versionResult && Array.isArray(versionResult.capabilities) ? versionResult.capabilities : []
  return Boolean(needed) && !capabilities.includes(needed)
}

// 화면에 보일 팩 이름 — 표시 이름(pack set-name) → 이름 → id
export function packLabel(pack: { displayName?: unknown; name?: unknown; id?: unknown } | null | undefined): unknown {
  return (pack && (pack.displayName || pack.name || pack.id)) || ''
}

// 팩 이미지 — 본체가 준 iconPath 만 읽는다(화면이 경로를 정하지 않게). 절대 경로 · png/jpg/jpeg/webp · 크기 제한은 읽는 쪽(main)이 한 번 더
export const ICON_MAX_BYTES = 1024 * 1024
const ICON_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']
export function packIconPath(list: { packs?: unknown; current?: unknown } | null | undefined, id: unknown): string | null {
  if (!list || typeof id !== 'string') return null
  const pack = [...(Array.isArray(list.packs) ? list.packs : []), list.current].find((item: { id?: unknown } | null | undefined) => item && item.id === id) as { iconPath?: unknown } | undefined
  const iconPath = pack && pack.iconPath
  if (typeof iconPath !== 'string' || !path.isAbsolute(iconPath)) return null
  return ICON_EXTENSIONS.includes(path.extname(iconPath).toLowerCase()) ? iconPath : null
}

// 레포 표시 이름 · 아이콘 — pack.json repos[] 의 displayName · icon(코어 athena/scripts/lib/pack-repo-look.mjs 와 같은 규칙). 화면은 displayName ?? name.
// 규칙 밖이면 null(이름은 원래 이름 · 아이콘은 글자 동그라미). icon 은 늘 assets/repos/<name>.<png|jpg|webp> — 실제 파일(팩 안 · 링크 아님)은 읽는 쪽(main)이 본다
const REPO_ICON_NAME = /^\w[\w.-]*$/
const LOOK_NAME_MAX = 40
const LOOK_NAME_BAD = /[\u0000-\u001f\u007f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/
export function repoLook(repo: Repo | null | undefined): { displayName: string | null; icon: string | null } {
  const name = String((repo && repo.name) || '')
  const text = repo && typeof repo.displayName === 'string' ? repo.displayName.trim() : ''
  const displayName = text && [...text].length <= LOOK_NAME_MAX && !LOOK_NAME_BAD.test(text) ? text : null
  const prefix = `assets/repos/${name}.`
  // 이름이 규칙에 맞으면 repo 가 있다(빈 이름은 REPO_ICON_NAME 에 걸린다)
  const icon = REPO_ICON_NAME.test(name) ? (repo as Repo).icon : undefined
  const okIcon = typeof icon === 'string' && icon.startsWith(prefix) && /^(png|jpg|webp)$/.test(icon.slice(prefix.length))
  return { displayName, icon: okIcon ? icon : null }
}

// 이미지 앞 바이트로 형식 — png · jpeg · webp 만(SVG · GIF 등은 null)
export function iconMime(head: unknown): string | null {
  if (!Buffer.isBuffer(head) || head.length < 12) return null
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png'
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

// pack status 의 현황판 포트 — 본체가 정한다(5.3: ATHENA_BOARD_PORT → 본체 설정 boardPort → 4700). 없거나 이상하면 null(옛 본체 — 앱 설정으로)
export function statusBoardPort(result: PackResult | null | undefined): number | null {
  const port = result && result.ok === true ? result.boardPort : null
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

// 시작 화면(회사 팩이 아직 없어요)을 띄울까 — 목록도 비고 지금 팩도 없을 때만.
// 옛 구조 본체(legacy · packs:[] · current 있음) · 새로 만드는 빈 자리(current.empty) · 명령이 없는 본체(supported:false)는 아니다
// 빈 자리(empty)만 있으면 팩이 없는 것으로 본다
const realPacks = (list: { packs: PackEntry[] }) => list.packs.filter((pack) => !pack.empty)
type ListLike = { supported?: boolean; legacy?: boolean; packs?: unknown; current?: unknown } | null | undefined
export function showPackWelcome(list: ListLike): boolean {
  return Boolean(list && list.supported && Array.isArray(list.packs) && !realPacks({ packs: list.packs }).length && !list.current)
}

// 켤 때 시작 화면을 띄울까(팩이 있어도 — 사용자 결정 2026-10-18) — 팩 지원 본체 · 팩이 하나 이상 · 켤 때 도는 에이전트 pane 이 없을 때.
// 에이전트가 돌고 있으면(앱만 다시 켬) 하던 일을 끊지 않게 건너뛴다. 옛 구조 본체(legacy)는 목록이 없어 띄우지 않는다
export function welcomeOnLaunch({ list, agentPanes }: { list: ListLike; agentPanes: number }): boolean {
  if (!list || !list.supported || list.legacy || !Array.isArray(list.packs) || !realPacks({ packs: list.packs }).length) return false
  return !(agentPanes > 0)
}

// 시작 화면 '내 팩' 목록 — 지금 팩 맨 위, 나머지는 updatedAt(그 팩 작업 기록 · pack.json 마지막 변경) 최근 순, 최대 limit 개
export function recentPacks(list: { packs?: unknown; current?: { id?: unknown } | null } | null | undefined, limit = 5): { id: string; name: unknown; repos: unknown; updatedAt: unknown; current: boolean }[] {
  if (!list || !Array.isArray(list.packs)) return []
  const currentId = list.current && list.current.id
  const time = (pack: PackEntry) => Date.parse(pack.updatedAt as string) || 0
  const sorted = [...(list.packs as PackEntry[])].sort((left, right) => {
    if (left.id === currentId) return -1
    if (right.id === currentId) return 1
    return time(right) - time(left)
  })
  return sorted.slice(0, limit).map((pack) => ({ id: pack.id, name: packLabel(pack), repos: pack.repos, updatedAt: pack.updatedAt || null, current: pack.id === currentId }))
}

// 현황판 /api/state 의 pack 이 지금 팩 · 세대와 같은가 — legacy(옛 본체 · pack 없음) · current · stale
export function boardIdentity(boardState: { pack?: unknown } | null | undefined, current: { id?: unknown; generation?: unknown } | null | undefined): 'legacy' | 'current' | 'stale' {
  const pack = boardState && boardState.pack
  if (!pack || typeof pack !== 'object') return 'legacy'
  if (!current) return 'stale'
  const reported = pack as { id?: unknown; generation?: unknown }
  return reported.id === current.id && reported.generation === current.generation ? 'current' : 'stale'
}

// 같은 이름 팩 비교 줄
export function packSummary(pack: { repos?: unknown; updatedAt?: unknown; createdAt?: unknown; hasWork?: unknown; source?: unknown } | null | undefined, say: Say = koreanSay): string {
  if (!pack) return ''
  const parts: string[] = []
  if (Number.isFinite(pack.repos)) parts.push(say('pack.meta.repos', { count: pack.repos }))
  if (pack.updatedAt) parts.push(say('pack.meta.updated', { date: String(pack.updatedAt).slice(0, 10) }))
  if (pack.createdAt) parts.push(say('pack.meta.created', { date: String(pack.createdAt).slice(0, 10) }))
  if (pack.hasWork) parts.push(say('pack.meta.hasWork'))
  if (pack.source) parts.push(pack.source === 'git' ? 'git' : say('pack.meta.local'))
  return parts.join(' · ')
}

// 레포의 대표 에이전트 — 단일 레포는 agents 첫째, 모노레포는 첫 앱 에이전트(없으면 packagesAgent). 이름 모양만 받는다(아테나 pane 에 글로 쓰인다)
export function repoAgent(repo: Repo | null | undefined): string | null {
  const apps: unknown[] = repo && repo.apps && typeof repo.apps === 'object' ? Object.values(repo.apps).map((app: { agent?: unknown } | null) => app && app.agent) : []
  const agents: unknown[] = Array.isArray(repo?.agents) ? repo.agents : []
  const agent = [...agents, ...apps, repo && repo.packagesAgent].find((name): name is string => typeof name === 'string' && /^[\w-]{1,64}$/.test(name))
  return agent || null
}

// ⚙ 설정 — 레포별 PR 자동 리뷰 · 머지(pack.json "autoMerge" · "autoMergeConfirm" — 뜻은 코어 docs/pr-auto.md "켜기").
// main 직접 레포("direct": true)는 PR 이 없어 목록에서 뺀다. releaseOnMerge — 작업 base(prBase)가 운영 브랜치(branch)와 같아 머지가 곧 운영 반영
export function mergeSettings(pack: { repos?: unknown } | null | undefined): { name: unknown; autoMerge: boolean; confirm: boolean; releaseOnMerge: boolean; prBase: string }[] {
  if (!pack || !Array.isArray(pack.repos)) return []
  const repos: (Repo | null)[] = pack.repos
  return repos
    .filter((repo): repo is Repo => Boolean(repo && /^[\w.-]+$/.test(String(repo.name || '')) && repo.direct !== true))
    .map((repo) => ({
      name: repo.name,
      autoMerge: repo.autoMerge === true,
      confirm: repo.autoMergeConfirm !== false,
      releaseOnMerge: typeof repo.branch === 'string' && repo.branch !== '' && repo.prBase === repo.branch,
      prBase: typeof repo.prBase === 'string' ? repo.prBase : '',
    }))
}

// scripts/call-branch-info.sh 출력(탭으로 나눈 줄) — target · repo · main(상태 · 미커밋 수) · candidate(브랜치 · 로컬/원격 · 최근 활동 · 체크아웃 자리) · direct(메인 체크아웃)
type BranchStatus = { branch: string; upstream: string | null; ahead: number; behind: number; gone?: boolean }
type Candidate = { branch: string; place: 'both' | 'local' | 'remote'; date: string; subject: string; noCommits: boolean; worktree: string | null }
type CallInfo = { target: string; main: ({ status: string; dirty: number } & BranchStatus) | null; candidates: Candidate[]; direct: string | null }

export function parseCallInfo(text: unknown): CallInfo {
  const info: CallInfo = { target: '', main: null, candidates: [], direct: null }
  for (const line of String(text || '').split('\n')) {
    const [key, ...rest] = line.split('\t')
    if (key === 'target') info.target = rest[0] || ''
    else if (key === 'main') {
      const status = (rest[0] || '').replace(/^##\s*/, '')
      info.main = { status, dirty: Number(rest[1]) || 0, ...parseBranchStatus(status) }
    }
    else if (key === 'candidate' && rest[0]) info.candidates.push(parseCandidate(rest as [string, ...string[]]))
    else if (key === 'direct' && rest[0]) info.direct = rest[0]
  }
  return info
}

// 후보 브랜치 한 줄(scripts/branch-candidates.sh) — 자리(로컬 · 원격 · 둘 다) · 날짜 · 마지막 커밋 제목(커밋이 없으면 noCommits) · 워크트리
function parseCandidate([branch, where = '', activity = '', checkout = '']: [string, ...string[]]): Candidate {
  const [, date = '', what = ''] = activity.match(/^(\d{4}-\d{2}-\d{2}|\?)\s*(.*)$/) || []
  const place = where.includes('·') ? 'both' : where === '로컬' ? 'local' : 'remote'
  const noCommits = what.startsWith('(커밋 없음)')
  return { branch, place, date: date === '?' ? '' : date, subject: noCommits ? '' : what.trim(), noCommits, worktree: checkout && checkout !== '-' ? checkout : null }
}

// git status 머리줄("main...origin/main [ahead 1, behind 2]")을 나눈다 — 브랜치 · 원격 · 앞섬 · 뒤처짐. 원격이 없으면 upstream null
export function parseBranchStatus(status: unknown): BranchStatus {
  const text = String(status || '').trim()
  const match = text.match(/^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(.*)\])?$/)
  if (!match) return { branch: text, upstream: null, ahead: 0, behind: 0 }
  const counts = match[3] || ''
  const number = (word: string) => Number((counts.match(new RegExp(`${word} (\\d+)`)) || [])[1]) || 0
  return { branch: (match[1] ?? '').replace(/^No commits yet on /, ''), upstream: match[2] || null, ahead: number('ahead'), behind: number('behind'), gone: counts.includes('gone') }
}

// scripts/new-branch.sh 출력 — 만든(또는 이어 쓰는) 워크트리 자리 · "이미 있다"(이어 쓸지 다시 물어야 한다)
export function parseNewBranch(text: unknown): { worktree: string | null; exists: boolean; message: string } {
  const lines = String(text || '').split('\n')
  const worktree = (lines.map((line) => line.match(/^\s*워크트리:\s*(\S.*)$/)).find(Boolean) || [])[1] || (lines.map((line) => line.match(/워크트리 경로가 이미 있다:\s*(\S.*)$/)).find(Boolean) || [])[1] || null
  const exists = !worktree && lines.some((line) => line.includes('이미 있다') && line.startsWith('⚠️'))
  const message = lines.filter((line) => /^(⚠️|❌|⏭)/.test(line.trim())).join('\n')
  return { worktree: worktree ? worktree.trim() : null, exists, message }
}

// 새 브랜치 이름(티켓 · fix/설명) — 셸에 넘기지는 않지만 git 이 받을 모양만
export const validBranchInput = (text: unknown): boolean => typeof text === 'string' && /^[\w\uAC00-\uD7A3][\w\uAC00-\uD7A3./-]{0,79}$/.test(text) && !text.includes('..') && !text.endsWith('/') && !text.endsWith('.lock')
