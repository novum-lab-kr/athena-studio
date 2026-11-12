// ── 모바일 브리지 — 폰 앱이 이 앱의 데몬 · 요청 · 결정 콘솔을 보고 답하게 하는 맥 쪽 처리기 ──
// 계획서 plans/feature/20261110-아테나-모바일-앱.md 4-7 "메시지". 기본 꺼짐 — 켜는 설정 · 화면이 생기기 전에는 아무 데서도 만들지 않는다.
// 전송층은 Transport 하나로 끼워 넣는다 — 진짜는 relay 의 짝 기기 하나(src/main/mobile-relay.mts · 기기마다 브리지 하나) · 시험은 createMemoryTransport.
// 메시지 모양은 데몬 줄 JSON 과 같다: 폰 → 맥 {id, op, args} · 맥 → 폰 답 {id, ok, result | error} · 알림 {event, …}
//
// 데몬은 자기를 띄운 앱의 것만(부르는 쪽이 main 의 daemonPaths() 를 넘긴다 — 배포판 daemon.json · 개발판 daemon-dev.json · 격리 집).
// 데몬을 띄우거나 다시 띄우지 않는다(peekDaemon — 이미 뜬 데몬 · 같은 프로토콜에만 붙는다).
// 크기는 제어하는 쪽에 맞춘다(D9 — 1편 D1 을 바꿈): pane 마다 제어 주인(mac | phone · 기본 mac). 폰이 열거나 입력하면 폰 크기로 resize ·
// 맥에서 입력하면 맥 크기로 되돌린다. 주인은 기기(브리지)끼리 · main 의 맥 입력과 같이 봐야 해서 createPaneControl 하나를 나눠 쓴다.
//
// 데몬 연결은 둘: 묻기용(pane list · input — attach 하지 않음)과 흘리기용(pane 을 열었을 때만 attach).
// attach 한 연결은 데몬이 "붙은 앱"으로 친다(fitTab 건너뜀 · open-url 받을 창 고르기 — src/daemon/daemon.mts) — 그래서 열린 pane 이 없으면 끊는다.
// 흘리기용은 본체로 묶지 않는다(body 없음) — 묶으면 open-url 을 그 본체 앱 창 대신 브리지가 받을 수 있다.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import * as daemonClient from '../daemon-client.mts'
import type { Reply } from '../daemon-client.mts'
import { mobileError } from './mobile-log.mts'

type Connection = NonNullable<Awaited<ReturnType<typeof daemonClient.peekDaemon>>>
type DaemonPaths = Parameters<typeof daemonClient.peekDaemon>[0]['paths']

// 전송층 — 폰 쪽과 주고받는 한 통로. relay 가 생기면 같은 모양으로 끼운다
export type Transport = {
  send(message: object): void
  onMessage(handler: (message: unknown) => void): void
  close(): void
}

// 폰이 보낸 답(request.answer) — 부르는 쪽(main)이 ctx.answerRequest(id, answer, 'mobile') 로 잇는다
export type RequestAnswer = { choice?: string; text?: string; rev?: number }
export type AnswerResult = { ok: boolean; error?: string; [key: string]: unknown }
// 현황판 /api/action 에 보낼 몸통 — 결정 콘솔이 보내는 것과 같고 by 만 더한다
export type DecisionPost = { pane: string; plan: string; decisions: string[]; text: string; by: 'mobile' }
export type BoardReply = { status: number; body: unknown }
// 사건 기록 한 줄(코어 events.mjs logEvent 와 같은 모양 — 종류 · 칸)
export type LogEvent = (type: string, fields: Record<string, unknown>) => void
// 머지 피드 원천 — 코어 사건 기록(events.jsonl)의 줄(읽는 칸만)
export type EventRow = { type?: unknown; at?: unknown; ok?: unknown; repo?: unknown; plan?: unknown; pr?: unknown; sha?: unknown; merged?: unknown; direct?: unknown; branch?: unknown }
// 머지 하나의 상세 — PR 은 gh pr view · 바로 머지는 git show --shortstat(머지 커밋)에서. 읽지 못한 칸은 null
export type MergeDetail = { title: string | null; branch: string | null; additions: number | null; deletions: number | null; files: number | null }
export type MergeRow = ReturnType<typeof weekMerges>[number]
// 이 맥 · 짝 기기(연결된 폰) — 폰 화면 머리에 보인다
export type DeviceView = { peer: string; label: string | null; online: boolean; lastSeen: string | null }

// 팩 탭 — 앞 창의 팩 목록(pack list 를 다듬은 ctx.packState 에서) · ⚙ 설정 팝업과 같은 레포 설정 칸
export type PackView = { current: string | null; packs: { id: string; name: string | null; displayName: string | null }[] }
export type RepoSettings = { ok: boolean; repos: unknown[] }
// ⚙ 설정 팝업이 바꾸는 값과 같다 — auto 는 팝업 스위치처럼 on(자동 PR) · direct(PR 끔)만
export type RepoChanges = { auto: 'on' | 'direct' | null; review: boolean | null; merge: 'auto' | 'confirm' | 'manual' | null }
export type PackResultLike = { ok?: unknown; error?: unknown; switched?: unknown; same?: unknown }

export type BridgeDeps = {
  daemonPaths: () => DaemonPaths
  transport: Transport
  inputAllowed: () => boolean // "폰 입력 허용" — 꺼지면 pane.input · pane.image · request.answer · decision.answer · repo.set · pack.open 을 거절
  requests: () => unknown[] | Promise<unknown[]> // 확인 요청 목록(열린 것)
  servers: () => unknown | Promise<unknown> // 서버 상태
  events: () => EventRow[] | Promise<EventRow[]> // 7일 머지 원천
  answerRequest: (id: string, answer: RequestAnswer) => Promise<AnswerResult>
  approveRequest: (id: string, generation: string, choice: number) => Promise<AnswerResult> // Codex 승인 — 앱 승인 대화상자와 같은 길(ctx.approveRequest)
  athenaDir: () => string | null // 결정 목록을 읽을 본체(앞 창)
  leadPaneOf: (plan: string) => string | null // 결정 콘솔이 보낼 pane(계획서 html PLAN.leadPane)
  postDecision: (body: DecisionPost) => Promise<BoardReply>
  packs: () => PackView
  repoSettings: () => Promise<RepoSettings> // ctx.mergeSettings 그대로
  setRepo: (repo: string, changes: RepoChanges) => Promise<PackResultLike> // ctx.setAutoMerge(코어 pack set-auto-merge)
  openPack: (id: string) => Promise<PackResultLike> // ctx.packOpen — 앞 창을 그 팩으로
  logEvent: LogEvent
  // 아래는 없으면 빈 값(옛 부르는 쪽 · 시험) — 모르는 값을 지어내지 않는다
  bodyPacks?: () => Record<string, string> // 본체 실제 경로 → 팩 id(pack list packs[].body) — pane 이 어느 팩 것인지
  mergeDetails?: MergeDetails // 머지 상세 캐시(createMergeDetails)
  mac?: () => { name: string | null }
  devices?: () => DeviceView[]
  serverDetail?: (name: string) => Promise<unknown | null> // 서버 하나의 상세 · 이력(server.detail) — 없는 서버면 null
  control?: PaneControl // 제어 주인(D9) — 기기끼리 나눠 쓴다. 없으면 이 브리지 혼자 쓰는 것
  imageDir?: () => string // 폰 이미지 저장 폴더 — 없으면 defaultImageDir()(맥 사용자 임시 폴더 아래)
  now?: () => number
  flushMs?: number
  sizePollMs?: number
  liveMs?: number
}

export const FLUSH_MS = 100 // 출력은 100ms(초당 ~10번)로 묶는다 — 4-7 "트래픽" · 조용하다 처음 나온 조각은 바로(앞쪽) 보내고 뒤따르는 것만 묶는다
// PC 쪽 pane 크기가 바뀌었나 — 데몬은 resize 를 알리지 않아 묻기용 연결로 state(메모리에서 바로 답한다)를 1초마다 본다(Q8)
export const SIZE_POLL_MS = 1000
// resize · 주인 바뀜 뒤 이만큼은 묶지 않고 조각마다 바로 보낸다 — 다시 그림 첫 조각은 작은 머리(커서 · 지우기)라 본 그림이 묶음에 걸려 100ms 늦었다(2026-11-12 실측)
export const LIVE_AFTER_RESIZE_MS = 300
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// 진행 중 pane — 데몬 pane list 의 agent_status(working · 질문 · 멈춤)
const IDLE_STATUSES = new Set(['', 'idle', 'unknown', 'none'])
const PLAN_ID = /^plans\/[^\0]+\.md$/

// 오류 답 — 화면 문구가 아니라 폰이 고를 코드(message 는 로그용)
class BridgeError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
const fail = (code: string, message: string): never => {
  throw new BridgeError(code, message)
}

// 요청 목록에서 Codex 승인 하나 — 앱 요청 모양(src/lib/requests.mts StudioRequest.codexApproval)에서 읽는 칸만
type CodexApprovalView = { pane: unknown; choices: { key: string }[] }
function codexApprovalOf(requests: unknown[], id: string): CodexApprovalView | null {
  const found = requests.find((request) => Boolean(request) && typeof request === 'object' && (request as { id?: unknown }).id === id) as { pane?: unknown; codexApproval?: unknown } | undefined
  const approval = found && found.codexApproval && typeof found.codexApproval === 'object' ? (found.codexApproval as { choices?: unknown }) : null
  if (!approval || !Array.isArray(approval.choices)) return null
  return { pane: found!.pane ?? null, choices: approval.choices.map((choice) => ({ key: choice && typeof choice === 'object' ? String((choice as { key?: unknown }).key) : '' })) }
}
const repoName = (row: unknown) => (row && typeof row === 'object' ? (row as { name?: unknown }).name : undefined)
// 맥 쪽 결과의 오류 코드만 폰에 — 짧은 코드 모양이 아니면 대신 쓸 코드
const errorCode = (value: unknown, fallback: string) => (typeof value === 'string' && /^[\w-]{1,40}$/.test(value) ? value : fallback)

// "폰 입력 허용" — 앱 설정(userData/config.json)의 mobileInput 칸. 켜는 화면이 생기기 전까지 기본 꺼짐
export function mobileInputAllowed(config: { [key: string]: unknown } | null | undefined): boolean {
  return Boolean(config && config.mobileInput === true)
}

// 지난 7일 머지 — 코어 auto.merge 사건 중 성공(ok true)만 새것부터
export function weekMerges(events: EventRow[], now: number) {
  return events
    .filter((event) => event.type === 'auto.merge' && event.ok === true && typeof event.at === 'string')
    .filter((event) => {
      const at = Date.parse(event.at as string)
      return !Number.isNaN(at) && at <= now && now - at <= WEEK_MS
    })
    .map((event) => ({ at: event.at as string, repo: event.repo ?? null, plan: event.plan ?? null, pr: event.pr ?? null, sha: event.sha ?? null, merged: event.merged ?? null, direct: event.direct === true, branch: typeof event.branch === 'string' ? event.branch : null }))
    .sort((left, right) => right.at.localeCompare(left.at))
}

// 살아 있는 pane 전부 — 쉬는 pane 도(Pane 탭에서 쉬는 아테나 pane 에 지시 · Q8). 진행 중인지는 status · running 으로 가른다.
// 폰에 필요한 칸만 넘긴다(cwd 등은 넘기지 않는다) · cols · rows 는 PC 크기(폰은 그대로 받는다 · D1)
type ListedPane = { id?: unknown; label?: unknown; name?: unknown; title?: unknown; agent?: unknown; agent_status?: unknown; cols?: unknown; rows?: unknown; workspace_id?: unknown; cwd?: unknown }
// 데몬 state(범위 없음)의 작업 공간 — id → 이름 · 본체(레포마다 하나 · body 는 본체 실제 경로)
type StateWorkspaces = { workspaces?: { id?: unknown; label?: unknown; body?: unknown }[] } | null | undefined
export type PaneWhere = { workspaces: Map<string, { label: string | null; body: string | null }>; bodyPacks: Record<string, string> }
export function paneWhere(state: StateWorkspaces, bodyPacks: Record<string, string> = {}): PaneWhere {
  const workspaces = new Map<string, { label: string | null; body: string | null }>()
  for (const workspace of (state && state.workspaces) || []) {
    if (typeof workspace.id !== 'string') continue
    workspaces.set(workspace.id, { label: typeof workspace.label === 'string' ? workspace.label : null, body: typeof workspace.body === 'string' ? workspace.body : null })
  }
  return { workspaces, bodyPacks }
}
// pane 이 일하는 레포 — 시작 자리(cwd)가 작업 워크트리(…/worktrees/<레포>/<브랜치>) · 본체 repos/<레포> 아래일 때만(본체 루트 · 그 밖은 null)
export function repoOfCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  const found = /\/worktrees\/([\w.-]+)\/[^/]+(?:\/|$)/.exec(cwd) || /\/repos\/([\w.-]+)(?:\/|$)/.exec(cwd)
  return found ? found[1]! : null
}
// cwd 는 넘기지 않는다(레포 이름만) · workspace 는 작업 공간 이름 · pack 은 그 작업 공간 본체의 팩 id(모르면 null)
export function livePanes(panes: ListedPane[], where: PaneWhere = paneWhere(null)) {
  return panes
    .filter((pane) => typeof pane.id === 'string')
    .map((pane) => {
      const status = typeof pane.agent_status === 'string' ? pane.agent_status : null
      const workspace = typeof pane.workspace_id === 'string' ? where.workspaces.get(pane.workspace_id) : undefined
      const body = workspace ? workspace.body : null
      return {
        id: pane.id as string,
        label: pane.label ?? null,
        name: pane.name ?? null,
        title: pane.title ?? null,
        agent: pane.agent ?? null,
        status,
        running: status !== null && !IDLE_STATUSES.has(status),
        cols: sizeOf(pane.cols),
        rows: sizeOf(pane.rows),
        repo: repoOfCwd(pane.cwd),
        workspace: workspace ? workspace.label : null,
        pack: body ? (where.bodyPacks[body] ?? null) : null,
      }
    })
}

// 지금 팩 밖 팩마다 일하는 · 질문 대기 pane 수(데몬 agent_status working · waiting) — 팩 목록 순서 · pane 이 없는 팩도 0 으로
export function otherPackCounts(panes: ReturnType<typeof livePanes>, packs: PackView) {
  return packs.packs
    .filter((pack) => pack.id !== packs.current)
    .map((pack) => {
      const own = panes.filter((pane) => pane.pack === pack.id)
      return { id: pack.id, name: pack.name, displayName: pack.displayName, working: own.filter((pane) => pane.status === 'working').length, question: own.filter((pane) => pane.status === 'waiting').length }
    })
}

// ── 머지 상세 — PR 은 gh · 바로 머지는 git. 머지된 것은 바뀌지 않아 한 번 읽으면 둔다(실패는 10분 뒤 다시) ──
// 읽는 동안 snapshot 을 붙잡지 않는다: 없는 것은 null 로 보내고 뒤에서 읽어 다 되면 onReady(브리지가 changed merges 를 보낸다)
export type MergeRunner = (command: 'gh' | 'git', args: string[], cwd: string) => Promise<string | null>
export type MergeDetails = ReturnType<typeof createMergeDetails>
const RETRY_MS = 10 * 60 * 1000
const MERGE_READS = 3 // 한꺼번에 도는 gh · git 수
const SHA = /^[0-9a-f]{7,40}$/
export function mergeKey(merge: MergeRow): string | null {
  if (typeof merge.repo !== 'string' || !/^[\w.-]+$/.test(merge.repo)) return null
  if (Number.isInteger(merge.pr) && (merge.pr as number) > 0) return `${merge.repo}#${merge.pr}`
  // 바로 머지는 squash 커밋(merged — 부모 하나라 shortstat 가 바뀐 것 전부). Actions 로 넘긴 것은 merged 가 없어 읽지 않는다(sha 는 브랜치 끝 커밋 하나뿐)
  return merge.direct && typeof merge.merged === 'string' && SHA.test(merge.merged) ? `${merge.repo}@${merge.merged}` : null
}
const countOf = (value: unknown): number | null => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null)
// gh pr view --json title,headRefName,additions,deletions,changedFiles
export function parsePrView(text: string): MergeDetail | null {
  try {
    const data = JSON.parse(text) as { title?: unknown; headRefName?: unknown; additions?: unknown; deletions?: unknown; changedFiles?: unknown }
    return { title: typeof data.title === 'string' ? data.title : null, branch: typeof data.headRefName === 'string' ? data.headRefName : null, additions: countOf(data.additions), deletions: countOf(data.deletions), files: countOf(data.changedFiles) }
  } catch {
    return null
  }
}
// git show --shortstat --format=%s: 첫 줄 제목 · " 3 files changed, 10 insertions(+), 2 deletions(-)"
export function parseShortstat(text: string, branch: string | null): MergeDetail | null {
  const lines = text.split('\n').filter((line) => line.trim())
  if (!lines.length) return null
  const stat = lines.find((line) => /\bfiles? changed\b/.test(line)) || ''
  const number = (pattern: RegExp) => Number(pattern.exec(stat)?.[1] ?? 0)
  return { title: lines[0]!.trim(), branch, additions: number(/(\d+) insertions?\(\+\)/), deletions: number(/(\d+) deletions?\(-\)/), files: number(/(\d+) files? changed/) }
}
export function createMergeDetails({ athenaDir, run, now = Date.now }: { athenaDir: () => string | null; run: MergeRunner; now?: () => number }) {
  const done = new Map<string, MergeDetail>()
  const failed = new Map<string, number>() // 키 → 실패한 때
  const reading = new Set<string>()
  const read = async (merge: MergeRow, key: string): Promise<MergeDetail | null> => {
    const dir = athenaDir()
    if (!dir) return null
    const cwd = path.join(dir, 'repos', merge.repo as string)
    if (key.includes('#')) {
      const out = await run('gh', ['pr', 'view', String(merge.pr), '--json', 'title,headRefName,additions,deletions,changedFiles'], cwd)
      return out === null ? null : parsePrView(out)
    }
    const sha = key.slice(key.indexOf('@') + 1)
    const out = await run('git', ['show', '--shortstat', '--format=%s', sha, '--'], cwd)
    return out === null ? null : parseShortstat(out, merge.branch)
  }
  return {
    // 지금 아는 상세(없으면 null) — 모르는 것은 뒤에서 읽기 시작하고, 새로 읽힌 것이 있으면 onReady 한 번
    peek(merges: MergeRow[], onReady: () => void): (MergeDetail | null)[] {
      const queue: { merge: MergeRow; key: string }[] = []
      const found = merges.map((merge) => {
        const key = mergeKey(merge)
        if (!key) return null
        const known = done.get(key)
        if (known) return known
        const failedAt = failed.get(key)
        if (!reading.has(key) && (failedAt === undefined || now() - failedAt >= RETRY_MS) && !queue.some((item) => item.key === key)) queue.push({ merge, key })
        return null
      })
      if (queue.length) {
        for (const item of queue) reading.add(item.key)
        let added = false
        const worker = async () => {
          for (let item = queue.shift(); item; item = queue.shift()) {
            const detail = await read(item.merge, item.key).catch(() => null)
            reading.delete(item.key)
            if (detail) {
              done.set(item.key, detail)
              failed.delete(item.key)
              added = true
            } else failed.set(item.key, now())
          }
        }
        void Promise.all(Array.from({ length: Math.min(MERGE_READS, queue.length) }, worker)).then(() => {
          if (added) onReady()
        })
      }
      return found
    },
  }
}

// 머지 줄 + 상세 · 오늘(이 맥 날짜) 가장 큰 변경(+ − 합) — 상세를 모르는 머지는 견주지 않는다
export function mergeFeed(merges: MergeRow[], details: (MergeDetail | null)[], now: number) {
  const empty: MergeDetail = { title: null, branch: null, additions: null, deletions: null, files: null }
  const rows = merges.map((merge, index) => {
    const detail = details[index] || empty
    return { ...merge, title: detail.title, branch: detail.branch ?? merge.branch, additions: detail.additions, deletions: detail.deletions, files: detail.files }
  })
  const today = new Date(now).toDateString()
  let todayTop: (typeof rows)[number] | null = null
  for (const row of rows) {
    if (new Date(row.at).toDateString() !== today || row.additions === null || row.deletions === null) continue
    if (!todayTop || row.additions + row.deletions > (todayTop.additions as number) + (todayTop.deletions as number)) todayTop = row
  }
  return { merges: rows, todayTop }
}
const sizeOf = (value: unknown): number | null => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : null)

// 데몬 state 의 pane 크기 — {pane: {cols, rows}}
type StatePanes = { panes?: { id?: unknown; cols?: unknown; rows?: unknown }[] } | null | undefined
export function paneSizes(state: StatePanes): Record<string, { cols: number | null; rows: number | null }> {
  const sizes: Record<string, { cols: number | null; rows: number | null }> = {}
  for (const pane of (state && state.panes) || []) if (typeof pane.id === 'string') sizes[pane.id] = { cols: sizeOf(pane.cols), rows: sizeOf(pane.rows) }
  return sizes
}
const sizeKey = (sizes: ReturnType<typeof paneSizes>) =>
  Object.keys(sizes)
    .sort()
    .map((pane) => `${pane}:${sizes[pane]?.cols}x${sizes[pane]?.rows}`)
    .join(',')

// 계획서 html 의 결정 콘솔 PLAN 블록에서 leadPane — 현황판 server.mjs planDecisionIds 와 같은 자리를 읽는다
const PLAN_DATA_BLOCK = /<script id="plan-data">\nconst PLAN = ([\s\S]*?)\n<\/script>/
export function readLeadPane(athenaDir: string, plan: string): string | null {
  if (!PLAN_ID.test(plan) || plan.split('/').includes('..')) return null
  try {
    const html = fs.readFileSync(path.join(athenaDir, plan.replace(/\.md$/, '.html')), 'utf8')
    const block = html.slice(html.indexOf('-->') + 3).match(PLAN_DATA_BLOCK)?.[1]
    const leadPane: unknown = block ? JSON.parse(block).leadPane : null
    return typeof leadPane === 'string' && leadPane ? leadPane : null
  } catch {
    return null
  }
}

// ── 결정 시트 — 결정 콘솔(계획서 html)이 읽는 그 PLAN 블록에서 ──
type PlanOption = { label: string; desc: string; recommended: boolean; custom: boolean }
export type PlanDecision = { id: string; title: string; desc: string; type: 'single' | 'multi'; required: boolean; options: PlanOption[]; decided: string[] | null }
export type PlanData = { title: string; mdFile: string; decisions: PlanDecision[] }

const plainText = (value: unknown): string => (typeof value === 'string' ? value : '')
// 결정 하나 — 모양이 하나라도 어긋나면 null(그 계획서는 통째로 뺀다 — 현황판이 보는 결정 id 목록과 어긋나지 않게)
function planDecision(raw: unknown): PlanDecision | null {
  if (!raw || typeof raw !== 'object') return null
  const dec = raw as { id?: unknown; title?: unknown; desc?: unknown; type?: unknown; required?: unknown; options?: unknown; decided?: unknown }
  if (typeof dec.id !== 'string' || !dec.id || !Array.isArray(dec.options)) return null
  const options: PlanOption[] = []
  for (const option of dec.options as unknown[]) {
    const entry = (option && typeof option === 'object' ? option : {}) as { label?: unknown; desc?: unknown; recommended?: unknown; custom?: unknown }
    if (typeof entry.label !== 'string' || !entry.label) return null
    options.push({ label: entry.label, desc: plainText(entry.desc), recommended: entry.recommended === true, custom: entry.custom === true })
  }
  // 콘솔 decidedList — null · undefined 면 미확정, 배열이 아니면 한 개짜리
  let decided: string[] | null = null
  if (dec.decided != null) decided = (Array.isArray(dec.decided) ? dec.decided : [dec.decided]).map(String)
  return { id: dec.id, title: plainText(dec.title), desc: plainText(dec.desc), type: dec.type === 'multi' ? 'multi' : 'single', required: dec.required === true, options, decided }
}

// 계획서 html → PLAN(제목 · md 경로 · 결정). plan-html.mjs 가 쓴 JSON 블록만(손으로 만든 JS 블록은 현황판처럼 읽지 못한 것으로)
export function readPlanData(athenaDir: string, plan: string): PlanData | null {
  if (!PLAN_ID.test(plan) || plan.split('/').includes('..')) return null
  try {
    const html = fs.readFileSync(path.join(athenaDir, plan.replace(/\.md$/, '.html')), 'utf8')
    const block = html.slice(html.indexOf('-->') + 3).match(PLAN_DATA_BLOCK)?.[1]
    const data: unknown = block ? JSON.parse(block) : null
    if (!data || typeof data !== 'object' || !Array.isArray((data as { decisions?: unknown }).decisions)) return null
    const raw = data as { title?: unknown; mdFile?: unknown; decisions: unknown[] }
    const decisions: PlanDecision[] = []
    for (const entry of raw.decisions) {
      const decision = planDecision(entry)
      if (!decision) return null
      decisions.push(decision)
    }
    return { title: plainText(raw.title), mdFile: typeof raw.mdFile === 'string' && raw.mdFile ? raw.mdFile : plan, decisions }
  } catch {
    return null
  }
}

// 남은 결정이 있나 — 콘솔 allConfirmed 의 반대(필수 표시가 있으면 필수만, 없으면 전부가 확정돼야 끝)
export function hasOpenDecisions(data: PlanData): boolean {
  const required = data.decisions.filter((decision) => decision.required)
  const targets = required.length ? required : data.decisions
  return targets.length > 0 && !targets.every((decision) => decision.decided !== null)
}

// 남은 결정이 있는 계획서 — plans/<폴더>/<이름>.html 중 같은 이름 .md 가 있는 것(artifacts 같은 그림 폴더는 md 가 없어 빠진다)
export function openDecisionPlans(athenaDir: string): { plan: string; data: PlanData }[] {
  const root = path.join(athenaDir, 'plans')
  const found: { plan: string; data: PlanData }[] = []
  let folders: string[] = []
  try {
    folders = fs.readdirSync(root).sort()
  } catch {
    return found
  }
  for (const folder of folders) {
    let files: string[] = []
    try {
      files = fs.readdirSync(path.join(root, folder)).sort()
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.html')) continue
      const plan = `plans/${folder}/${file.replace(/\.html$/, '.md')}`
      if (!fs.existsSync(path.join(athenaDir, plan))) continue
      const data = readPlanData(athenaDir, plan)
      if (data && hasOpenDecisions(data)) found.push({ plan, data })
    }
  }
  return found
}

// 고른 값({D1: "B"} · 복수면 배열) → 결정 콘솔 [이대로 진행] 과 같은 글(plan-template.html buildPrompt — 콘솔도 언어와 상관없이 이 한국어 글)
// 확정된 결정은 확정값 그대로(콘솔도 바꿀 수 없다) · 골라야 할 필수 결정이 남으면 거절
export function decisionPrompt(data: PlanData, picks: Record<string, unknown>): string {
  const known = new Map(data.decisions.map((decision) => [decision.id, decision]))
  const chosen = new Map<string, string[]>()
  for (const [id, value] of Object.entries(picks)) {
    const decision = known.get(id)
    if (!decision) fail('usage', `없는 결정: ${id}`)
    if (decision!.decided !== null) fail('usage', `이미 확정된 결정이에요: ${id}`)
    const labels = [...new Set(Array.isArray(value) ? value : [value])]
    if (!labels.length || !labels.every((label) => typeof label === 'string' && decision!.options.some((option) => option.label === label))) fail('usage', `없는 선택지: ${id}`)
    if (decision!.type === 'single' && labels.length !== 1) fail('usage', `하나만 고를 수 있어요: ${id}`)
    chosen.set(id, labels as string[])
  }
  const left = data.decisions.filter((decision) => decision.required && decision.decided === null && !chosen.has(decision.id))
  if (left.length) fail('usage', `필수 결정이 남았어요: ${left.map((decision) => decision.id).join(', ')}`)
  const lines = [`[작업계획서 결정사항 확정] ${data.title}`, '', `아래 결정사항으로 ${data.mdFile} 계획서를 확정하고 진행해주세요.`, '']
  data.decisions.forEach((decision, index) => {
    const value = (decision.decided || chosen.get(decision.id) || []).join(', ')
    lines.push(`${index + 1}. ${decision.title}: ${value || '(미결정)'}`)
  })
  lines.push('', '추가 메모: (없음)')
  return lines.join('\n')
}

// 현황판 /api/action — 결정 콘솔과 같은 출처(Origin) · 토큰(runPack board-token)으로 맥 안에서 부른다
export function boardActionPoster({ port, token }: { port: number; token: string }) {
  return (body: DecisionPost): Promise<BoardReply> =>
    new Promise((resolve) => {
      const payload = JSON.stringify(body)
      const request = http.request(
        { host: '127.0.0.1', port, path: '/api/action', method: 'POST', timeout: 5000, headers: { 'content-type': 'application/json', origin: `http://localhost:${port}`, 'x-board-token': token, 'content-length': Buffer.byteLength(payload) } },
        (response) => {
          let text = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => (text += chunk))
          response.on('end', () => {
            let parsed: unknown = null
            try {
              parsed = JSON.parse(text)
            } catch {}
            resolve({ status: response.statusCode || 0, body: parsed })
          })
        },
      )
      request.on('timeout', () => request.destroy())
      request.on('error', () => resolve({ status: 0, body: null }))
      request.end(payload)
    })
}

// ── 제어 주인(D9) ──
export type CellSize = { cols: number; rows: number }
export type PaneOwner = 'mac' | 'phone'
// 기기(브리지) 하나 — 데몬 resize 는 그 브리지 연결로(몸 없는 연결이라 어느 본체 pane 이든 된다) · 주인이 바뀌면 그 브리지가 폰에 알린다
export type ControlHolder = {
  resize(pane: string, size: CellSize): Promise<void> // 끝나면(답 · 실패 모두) 그 기기에는 이미 pane.owner 를 보냈다
  changed(pane: string, size: CellSize | null): void // 다른 기기가 바꿨다(size 는 바뀐 크기 · 모르면 null) — 그 pane 을 열어 둔 기기면 pane.owner
}
export type PaneControl = ReturnType<typeof createPaneControl>
const MAX_COLS = 1000
const MAX_ROWS = 500
// 폰이 보낸 크기 — 둘 다 2 이상 정수(데몬 Pane.resize 가 2 미만은 버린다) · 너무 큰 값은 거절
export function cellSize(cols: unknown, rows: unknown): CellSize | null {
  const ok = (value: unknown, max: number) => Number.isInteger(value) && (value as number) >= 2 && (value as number) <= max
  return ok(cols, MAX_COLS) && ok(rows, MAX_ROWS) ? { cols: cols as number, rows: rows as number } : null
}
// 터미널이 스스로 보내는 답(사람이 친 것이 아님) — 커서 위치(CPR) · 상태(DSR) · 장치 속성(DA) · 모드(DECRPM) · kitty 키 · 창 보고 · 포커스 들어옴/나감 · OSC · DCS 답.
// 맥 · 폰 xterm 이 프로그램 물음에 저절로 답한다 — 이것으로 주인을 바꾸면 크기를 바꾼 뒤 다시 그리며 묻는 물음에 두 화면이 서로 빼앗는다
const TERMINAL_REPLY = /^(?:\x1b\[[IO]|\x1b\[\??[\d;]*[Rn]|\x1b\[[?>=][\d;.]*c|\x1b\[\??[\d;]*\$y|\x1b\[\?[\d;]*u|\x1b\[[\d;]*t|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/
export function isTerminalReply(data: string): boolean {
  return TERMINAL_REPLY.test(data)
}
// 맥 포인터가 pane 위를 누르지 않고 지나가기만 한 것(SGR 마우스 보고 · 단추 없음 + 움직임 = 35 · Shift 4 · Meta 8 · Ctrl 16 을 더한 값).
// Claude Code 는 움직임 추적(DECSET 1003 · 1006)을 켜서 맥 xterm 이 창에 포커스가 없어도 이것을 입력으로 보낸다 — 사람이 친 것이 아니니 주인을 바꾸지 않는다(누르기는 pane 포커스로 · 휠은 입력으로 되찾는다)
const POINTER_HOVER = /^(?:\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+M)+$/
export function isPointerHover(data: string): boolean {
  return POINTER_HOVER.test(data)
}

// 주인 표 — pane → 가진 폰(없으면 맥) · 폰이 가져갈 때의 맥 크기(돌려줄 크기 · 폰 제어 중 맥 화면이 요청한 크기로 바뀐다)
// onPhoneTook: 맥 → 폰으로 넘어갈 때만(폰 → 폰은 아님) — 맥 Studio 의 잠깐 알림
export function createPaneControl({ onPhoneTook }: { onPhoneTook?: (pane: string) => void } = {}) {
  const phones = new Map<string, { holder: ControlHolder; size: CellSize }>()
  const macSizes = new Map<string, CellSize>()
  // 아는 pty 크기 — 맥 화면 resize(폰이 안 가졌을 때 데몬에 가는 것) · 브리지 resize · attach · state 로. 폰이 가져갈 때 돌려줄 맥 크기(모르면 브리지가 state 로 묻는다)
  const sizes = new Map<string, CellSize>()
  const holders = new Set<ControlHolder>()
  const tell = (pane: string, except: ControlHolder, size: CellSize | null) => {
    for (const holder of holders) if (holder !== except) holder.changed(pane, size)
  }
  // 맥으로 되돌리기 — 가진 폰의 연결로 맥 크기 resize(모르면 크기는 그대로 · 맥 화면이 다음 상태에서 다시 맞춘다)
  async function backToMac(pane: string) {
    const held = phones.get(pane)
    if (!held) return
    phones.delete(pane)
    const size = macSizes.get(pane)
    macSizes.delete(pane)
    if (size) await held.holder.resize(pane, size).catch(() => {})
    else held.holder.changed(pane, null)
    tell(pane, held.holder, size || null)
  }
  return {
    register(holder: ControlHolder) {
      holders.add(holder)
    },
    unregister(holder: ControlHolder) {
      holders.delete(holder)
    },
    ownerOf(pane: string): { owner: PaneOwner; holder: ControlHolder | null; size: CellSize | null } {
      const held = phones.get(pane)
      return held ? { owner: 'phone', holder: held.holder, size: held.size } : { owner: 'mac', holder: null, size: null }
    },
    // 폰이 가져간다(열기 · 입력 · 가진 폰의 크기 바뀜) — current 는 지금 pty 크기(맥이 주인일 때 돌려줄 맥 크기로 기억)
    async phoneTake(holder: ControlHolder, pane: string, size: CellSize, current: CellSize | null) {
      const held = phones.get(pane)
      if (held && held.holder === holder && held.size.cols === size.cols && held.size.rows === size.rows) return
      if (!held && current) macSizes.set(pane, current)
      phones.set(pane, { holder, size })
      await holder.resize(pane, size).catch(() => {})
      tell(pane, holder, size)
      if (!held && onPhoneTook) onPhoneTook(pane)
    },
    // 폰이 나감(pane 닫기 · 앱 뒤로 · 연결 끊김) — 그 폰이 가진 것만 맥으로(맥 알림 없음)
    async phoneRelease(holder: ControlHolder, pane: string) {
      const held = phones.get(pane)
      if (held && held.holder === holder) await backToMac(pane)
    },
    heldBy(holder: ControlHolder): string[] {
      return [...phones].filter(([, held]) => held.holder === holder).map(([pane]) => pane)
    },
    // 맥 화면에서 입력 — 터미널 자동 답 · 포인터 지나가기가 아니고 폰이 가졌으면 맥 크기로
    macInput(pane: string, data: string) {
      if (phones.has(pane) && !isTerminalReply(data) && !isPointerHover(data)) void backToMac(pane)
    },
    // 맥 화면에서 pane 에 포커스(누르기 · 창이 앞으로 — D9 보완) — 폰이 가졌으면 맥 크기로
    macFocus(pane: string) {
      if (phones.has(pane)) void backToMac(pane)
    },
    // 맥 화면이 크기를 요청 — 폰이 가진 pane 이면 기억만 하고 true(부르는 쪽은 데몬에 보내지 않고 받은 것처럼 답한다)
    macResize(pane: string, size: CellSize): boolean {
      if (!phones.has(pane)) {
        sizes.set(pane, size)
        return false
      }
      macSizes.set(pane, size)
      return true
    },
    paneGone(pane: string) {
      phones.delete(pane)
      macSizes.delete(pane)
      sizes.delete(pane)
    },
    noteSize(pane: string, size: CellSize) {
      sizes.set(pane, size)
    },
    sizeOf(pane: string): CellSize | null {
      return sizes.get(pane) || null
    },
  }
}

// ── 폰 → 맥 이미지(pane.image) ──
// 폰이 고른 사진을 base64 로 보내면 맥 임시 폴더에 저장하고 그 경로를 pane 입력에 넣는다(엔터 없음 — 사람이 보낼 때 누른다).
// 안쪽 메시지 하나는 조각 모으기 상한 16 MiB(mobile-crypto ASSEMBLE_MAX_BYTES) — base64 가 4/3 로 늘어 원본은 10 MiB 까지만 받는다
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const IMAGE_KEEP_MS = 24 * 60 * 60 * 1000 // 저장한 그림은 하루 — 그 뒤 다음 저장 때 지운다(에이전트가 엔터 뒤 읽을 시간)
const IMAGE_BASE64_MAX = Math.ceil(IMAGE_MAX_BYTES / 3) * 4
const IMAGE_NAME = /^athena-img-\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpg|gif|webp)$/
export const defaultImageDir = () => path.join(os.tmpdir(), 'athena-mobile-images')

// 형식은 파일 앞 바이트로만 판단한다(폰이 보낸 이름 · 형식 값은 쓰지 않는다) — png · jpeg · gif · webp. HEIC 등은 폰이 jpeg 로 바꿔 보낸다
export function imageType(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

// base64 글자 → 바이트(줄바꿈 · 공백 · data: 머리 없이 순수 base64 만) — 크기는 풀기 전에 글자 수로 먼저 거른다
export function decodeImage(data: unknown): Buffer {
  if (typeof data !== 'string' || !data) return fail('usage', 'data 가 필요해요')
  if (data.length > IMAGE_BASE64_MAX) return fail('too-large', `이미지는 ${IMAGE_MAX_BYTES / 1024 / 1024} MiB 까지예요`)
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return fail('usage', 'data 는 base64 여야 해요')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > IMAGE_MAX_BYTES) return fail('too-large', `이미지는 ${IMAGE_MAX_BYTES / 1024 / 1024} MiB 까지예요`)
  return bytes
}

const pad2 = (value: number) => String(value).padStart(2, '0')
// 이름은 맥 시각 + 무작위만(사용자 입력 없음 · 공백 없음 — 경로를 따옴표 없이 넣는다)
export function imageFileName(at: number, type: string): string {
  const date = new Date(at)
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  return `athena-img-${stamp}-${crypto.randomBytes(4).toString('hex')}.${type}`
}

// 저장 — 폴더 0700 · 파일 0600 · 이미 있으면 덮지 않는다(wx). 저장 전에 하루 지난 우리 그림을 지운다(우리 이름 규칙에 맞는 일반 파일만)
export async function saveImage(dir: string, bytes: Buffer, type: string, at: number): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await fs.promises.lstat(dir)
  if (!info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return fail('internal', '이미지 폴더를 쓸 수 없어요')
  if ((info.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700)
  await sweepImages(dir, at)
  const file = path.join(dir, imageFileName(at, type))
  await fs.promises.writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
  return file
}

export async function sweepImages(dir: string, at: number) {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!IMAGE_NAME.test(name)) continue
    const file = path.join(dir, name)
    const info = await fs.promises.lstat(file).catch(() => null)
    if (info && info.isFile() && at - info.mtimeMs > IMAGE_KEEP_MS) await fs.promises.unlink(file).catch(() => {})
  }
}

// 시험용 메모리 전송 — bridge 쪽은 브리지에 넘기고, phone 쪽으로 폰 흉내(보내기 · 받은 것 보기)
export function createMemoryTransport() {
  const toBridge: ((message: unknown) => void)[] = []
  const toPhone: ((message: unknown) => void)[] = []
  const received: Record<string, unknown>[] = []
  let closed = false
  // JSON 으로 한 번 오가게 — 실제 전송처럼 함수 · 공유 객체가 넘어가지 않는다
  const copy = (message: unknown) => JSON.parse(JSON.stringify(message))
  const bridge: Transport = {
    send: (message) => {
      if (closed) return
      const sent = copy(message)
      received.push(sent)
      for (const handler of toPhone) handler(sent)
    },
    onMessage: (handler) => void toBridge.push(handler),
    close: () => void (closed = true),
  }
  const phone = {
    send: (message: unknown) => {
      if (!closed) for (const handler of toBridge) handler(copy(message))
    },
    onMessage: (handler: (message: unknown) => void) => void toPhone.push(handler),
    received,
    get closed() {
      return closed
    },
  }
  return { bridge, phone }
}

export function createMobileBridge(deps: BridgeDeps) {
  const { transport } = deps
  const now = deps.now || Date.now
  const flushMs = deps.flushMs ?? FLUSH_MS
  const liveMs = deps.liveMs ?? LIVE_AFTER_RESIZE_MS
  let liveUntil = 0 // 이 시각까지는 묶지 않는다(resize · 주인 바뀜 뒤)
  let control: Connection | null = null // 묻기용
  let controlConnecting: Promise<Connection> | null = null
  let stream: Connection | null = null // 흘리기용(attach)
  let streamConnecting: Promise<Connection> | null = null
  const open = new Set<string>() // 폰이 연 pane
  const opening = new Set<string>() // 스냅숏을 기다리는 pane — 그 전 출력은 스냅숏에 이미 들어 있다
  const pending = new Map<string, string>() // pane → 모아 둔 출력
  let flushTimer: NodeJS.Timeout | null = null
  let resyncing = false
  let stopped = false
  let sizeTimer: NodeJS.Timeout | null = null
  let lastSizes: string | null = null
  let sizeWatching = false // 크기 보기는 브리지(기기)마다 한 번만 시작 — 첫 state 가 진행 중이거나 실패해도 다시 켜지 않는다
  // 제어 주인(D9) — 이 기기가 알린 pane 크기(열기 · 입력 · pane.size) · 주인 표에서의 이 기기
  const owners = deps.control || createPaneControl()
  const phoneSizes = new Map<string, CellSize>()
  // 아는 pty 크기를 주인 표에 — attach · 크기 보기(state) 답으로(가져갈 때 돌려줄 맥 크기를 데몬에 다시 묻지 않게)
  const learnSizes = (sizes: ReturnType<typeof paneSizes>) => {
    for (const [pane, size] of Object.entries(sizes)) if (size.cols && size.rows) owners.noteSize(pane, { cols: size.cols, rows: size.rows })
  }
  const holder: ControlHolder = { resize: (pane, size) => resizeFor(pane, size), changed: (pane, size) => emitOwner(pane, size) }
  owners.register(holder)

  const emit = (message: object) => {
    if (!stopped) transport.send(message)
  }

  function flush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    // 기기 하나에 100ms 마다 메시지 하나 — 그사이 나온 pane 들을 한 번에(안쪽 약속 v1)
    if (pending.size) emit({ event: 'pane.data', panes: Object.fromEntries(pending) })
    pending.clear()
  }
  // 묶음 창 끝 — 그사이 쌓인 것이 있으면 보내고 창을 한 번 더(계속 나오는 동안은 100ms 마다 하나) · 없으면 닫아 다음 조각은 바로 보낸다
  function flushWindowEnd() {
    flushTimer = null
    if (!pending.size) return
    flush()
    flushTimer = setTimeout(flushWindowEnd, flushMs)
  }

  async function connectControl(): Promise<Connection> {
    if (control) return control
    if (controlConnecting) return controlConnecting
    controlConnecting = (async () => {
      const own = await daemonClient.peekDaemon({ paths: deps.daemonPaths(), onClose: () => void (control === own ? (control = null) : null) })
      if (!own) return fail('daemon-unavailable', '떠 있는 데몬이 없거나 프로토콜이 달라요')
      control = own
      return own
    })().finally(() => (controlConnecting = null))
    return controlConnecting
  }

  function onStreamEvent(message: Reply & { pane?: string; data?: string }) {
    if (message.event === 'data' && typeof message.pane === 'string') {
      if (resyncing || !open.has(message.pane) || opening.has(message.pane)) return
      pending.set(message.pane, (pending.get(message.pane) || '') + String(message.data ?? ''))
      // resize · 주인 바뀜 바로 뒤면 조각마다 바로(다시 그림 전체가 늦지 않게)
      if (Date.now() < liveUntil) {
        flush()
        return
      }
      // 조용하던 참(묶음 창 없음 — 열기 · 닫기의 flush 뒤 포함)이면 바로 보내고 창을 연다 — 첫 조각이 100ms 늦지 않게
      if (!flushTimer) {
        flush()
        flushTimer = setTimeout(flushWindowEnd, flushMs)
      }
    } else if (message.event === 'exit' && typeof message.pane === 'string') {
      flush()
      open.delete(message.pane)
      phoneSizes.delete(message.pane)
      owners.paneGone(message.pane)
      emit({ event: 'changed', parts: ['panes'] })
      if (!open.size) closeStream()
    } else if (message.event === 'state') {
      emit({ event: 'changed', parts: ['panes'] })
    } else if (message.event === 'resync') {
      resync().catch(() => {})
    }
    // open-url 은 앱 창 몫이다 — 흘리기용은 본체로 묶지 않아 데몬이 고르지 않는다
  }

  async function connectStream(): Promise<Connection> {
    if (stream) return stream
    if (streamConnecting) return streamConnecting
    streamConnecting = (async () => {
      let own: Connection | null = null
      own = await daemonClient.peekDaemon({
        paths: deps.daemonPaths(),
        onEvent: (message) => {
          if (own && own === stream) onStreamEvent(message as Reply & { pane?: string; data?: string })
        },
        onClose: () => {
          if (own !== stream) return
          stream = null
          // 데몬 쪽에서 끊겼다 — 열린 pane 은 끊김으로 알리고 비운다(폰이 다시 연다)
          if (open.size) emit({ event: 'changed', parts: ['panes'] })
          open.clear()
          opening.clear()
          pending.clear()
          // 폰이 가진 pane 은 맥 크기로(묻기용 연결이 살아 있으면 된다)
          for (const pane of owners.heldBy(holder)) void owners.phoneRelease(holder, pane)
        },
      })
      if (!own) return fail('daemon-unavailable', '떠 있는 데몬이 없거나 프로토콜이 달라요')
      stream = own
      return own
    })().finally(() => (streamConnecting = null))
    return streamConnecting
  }

  function closeStream() {
    const current = stream
    stream = null
    if (current) current.close().catch(() => {})
  }

  // attach — 답을 읽은 그 자리에서(같은 소켓의 뒤 출력보다 먼저) 기다리던 pane 을 풀어 그 뒤 출력부터 받는다
  async function attach(connection: Connection, onReplied: () => void) {
    const result = (await connection.call('attach', {}, (reply) => {
      if (reply.ok) onReplied()
    })) as { snapshots?: Record<string, string>; state?: StatePanes } | null
    const sizes = paneSizes(result && result.state)
    learnSizes(sizes)
    return { snapshots: (result && result.snapshots) || {}, sizes }
  }
  // 폰에 보낼 pane 한 장 — 스냅숏과 그때의 PC 크기(Q8)
  const paneView = (pane: string, view: Awaited<ReturnType<typeof attach>>) => ({ pane, snapshot: view.snapshots[pane] ?? '', cols: view.sizes[pane]?.cols ?? null, rows: view.sizes[pane]?.rows ?? null })
  const ownerView = (pane: string) => {
    const found = owners.ownerOf(pane)
    return { owner: found.owner, mine: found.holder === holder }
  }

  // 주인 알림 — 이 폰이 연 pane 만(스냅숏을 기다리는 중이면 아직) · cols · rows 는 바뀐 pty 크기(모르면 null — 폰은 지금 크기 그대로)
  function emitOwner(pane: string, size: CellSize | null) {
    if (!open.has(pane) || opening.has(pane)) return
    // 크기가 바뀌었으니 뒤따르는 다시 그림은 잠깐 묶지 않는다(맥 → 폰 · 폰 → 맥 · 다른 폰이 가져감 모두 여기를 지난다)
    liveUntil = Date.now() + liveMs
    emit({ event: 'pane.owner', pane, ...ownerView(pane), cols: size ? size.cols : null, rows: size ? size.rows : null })
  }

  // 데몬 resize — 연 pane 이면 흘리기 연결로 보내 답을 읽은 자리에서(같은 소켓의 뒤 출력보다 먼저) 앞 출력을 내보내고 pane.owner.
  // 그래서 폰은 받은 출력을 다 쓴 뒤 크기를 바꾸면 데몬 화면과 같은 지점이다(맥 화면 ctx.resizePane · pane:resized 와 같은 방식)
  async function resizeFor(pane: string, size: CellSize) {
    let told = false
    const tell = () => {
      if (told) return
      told = true
      emitOwner(pane, size)
    }
    const args = { pane, cols: size.cols, rows: size.rows }
    try {
      if (stream && open.has(pane) && !opening.has(pane)) {
        await stream.call('resize', args, () => {
          flush()
          tell()
        })
      } else await (await connectControl()).call('resize', args)
      owners.noteSize(pane, size)
    } finally {
      tell()
    }
  }

  // 지금 pty 크기 — 맥이 주인일 때 가져가면 돌려줄 맥 크기
  async function currentSize(pane: string): Promise<CellSize | null> {
    try {
      const found = paneSizes((await (await connectControl()).call('state')) as StatePanes)[pane]
      return found && found.cols && found.rows ? { cols: found.cols, rows: found.rows } : null
    } catch {
      return null
    }
  }

  // 이 폰이 가져간다 — 맥이 주인이었으면 지금 크기를 돌려줄 크기로(이미 알면 그것)
  async function take(pane: string, size: CellSize, known: CellSize | null = null) {
    phoneSizes.set(pane, size)
    const current = owners.ownerOf(pane).owner === 'mac' ? known || owners.sizeOf(pane) || (await currentSize(pane)) : null
    await owners.phoneTake(holder, pane, size, current)
  }

  // 데몬이 못 따라온 폰 연결을 끊었다(8MB) — 다시 attach 해서 열린 pane 마다 새 스냅숏
  async function resync() {
    if (resyncing || !stream) return
    resyncing = true
    pending.clear()
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    try {
      const view = await attach(stream, () => (resyncing = false))
      for (const pane of open) emit({ event: 'pane.resync', ...paneView(pane, view) })
    } finally {
      resyncing = false
    }
  }

  // pane 하나만 다시 맞추기 — 맥 → 폰 출력이 relay 에서 버려졌을 때(msg.dropped). 다시 attach 해 그 pane 스냅숏만 보내고,
  // 답을 읽기 전 출력은 스냅숏에 들어 있으니 버린다(paneOpen 과 같은 opening 표시)
  async function resyncPane(pane: string) {
    if (stopped || !stream || !open.has(pane) || opening.has(pane)) return
    pending.delete(pane)
    opening.add(pane)
    try {
      const view = await attach(stream, () => opening.delete(pane))
      if (open.has(pane)) emit({ event: 'pane.resync', ...paneView(pane, view) })
    } finally {
      opening.delete(pane)
    }
  }

  // size 를 보냈고 입력 허용이 켜져 있으면 답을 보낸 뒤 폰 크기로 가져간다(later) — 스냅숏(지금 크기)이 pane.owner 보다 먼저 가게
  async function paneOpen(pane: string, size: CellSize | null, later: (work: () => Promise<void>) => void) {
    const connection = await connectStream()
    flush()
    opening.add(pane)
    open.add(pane)
    try {
      const view = await attach(connection, () => opening.delete(pane))
      if (!(pane in view.snapshots)) {
        open.delete(pane)
        if (!open.size) closeStream()
        return fail('not_found', `없는 pane: ${pane}`)
      }
      const shown = paneView(pane, view)
      if (size && deps.inputAllowed()) {
        const known = shown.cols && shown.rows ? { cols: shown.cols, rows: shown.rows } : null
        later(() => take(pane, size, known))
      } else if (size) phoneSizes.set(pane, size)
      return { ...shown, ...ownerView(pane) }
    } catch (error) {
      open.delete(pane)
      if (!open.size) closeStream()
      throw error
    } finally {
      opening.delete(pane)
    }
  }

  // 닫기(나가기 · 앱이 뒤로) — 이 폰이 가진 pane 이면 맥 크기로 되돌린다(이 폰에는 알리지 않는다 · 닫았으니)
  async function paneClose(pane: string) {
    flush()
    open.delete(pane)
    phoneSizes.delete(pane)
    await owners.phoneRelease(holder, pane)
    if (!open.size) closeStream()
    return { pane }
  }

  // 폰 화면 크기가 바뀜(돌리기 · 키보드) — 기억하고, 이 폰이 가진 pane 이면 바로 그 크기로. 맥이나 다른 폰이 가졌으면 가져가지 않는다.
  // take: true — 폰에서 그 pane 에 포커스(D9 보완) · 입력 허용이면 바로 가져온다(맥 · 다른 폰이 가졌어도)
  async function paneSize(args: Record<string, unknown>) {
    const pane = text(args.pane, 'pane')
    const size = cellSize(args.cols, args.rows) || fail('usage', 'cols · rows 는 2 이상 정수')
    if (args.take !== undefined && typeof args.take !== 'boolean') fail('usage', 'take 는 true · false')
    phoneSizes.set(pane, size)
    if (deps.inputAllowed() && (args.take === true || owners.ownerOf(pane).holder === holder)) await take(pane, size)
    return { pane, ...ownerView(pane) }
  }

  // 크기 바뀜 보기 — 첫 snapshot 뒤부터 브리지가 멈출 때까지. 처음 본 크기는 기준으로만 삼는다
  async function pollSizes() {
    sizeTimer = null
    if (stopped) return
    try {
      const connection = await connectControl()
      const sizes = paneSizes((await connection.call('state')) as StatePanes)
      learnSizes(sizes)
      const key = sizeKey(sizes)
      if (lastSizes !== null && key !== lastSizes) emit({ event: 'changed', parts: ['panes'] })
      lastSizes = key
    } catch {}
    if (!stopped) sizeTimer = setTimeout(() => void pollSizes(), deps.sizePollMs ?? SIZE_POLL_MS)
  }

  async function snapshot() {
    const connection = await connectControl()
    const listed = (await connection.call('pane list')) as { panes?: ListedPane[] } | null
    // 범위 없는 state — 작업 공간마다 본체(body)가 실려 pane 이 어느 팩 것인지 안다(못 읽으면 workspace · pack 만 null)
    const state = (await connection.call('state').catch(() => null)) as StateWorkspaces
    const [requests, servers, events] = await Promise.all([deps.requests(), deps.servers(), deps.events()])
    if (!sizeWatching) {
      sizeWatching = true
      void pollSizes()
    }
    const panes = livePanes((listed && listed.panes) || [], paneWhere(state, deps.bodyPacks ? deps.bodyPacks() : {}))
    const merges = weekMerges(events, now())
    const details = deps.mergeDetails ? deps.mergeDetails.peek(merges, () => emit({ event: 'changed', parts: ['merges'] })) : merges.map(() => null)
    const feed = mergeFeed(merges, details, now())
    return {
      requests,
      panes,
      otherPacks: otherPackCounts(panes, deps.packs()),
      merges: feed.merges,
      todayTop: feed.todayTop,
      servers,
      mac: { name: deps.mac ? deps.mac().name : null },
      devices: deps.devices ? deps.devices() : [],
    }
  }

  // 서버 하나 — 지금 읽기(상세 칸 포함) · 7일 이력 · sar. 마지막 배포는 맥 · 서버 어디에도 원천이 없어 null
  async function serverDetail(args: Record<string, unknown>) {
    const name = text(args.name, 'name')
    const found = deps.serverDetail ? await deps.serverDetail(name) : null
    if (!found) return fail('not_found', `없는 서버: ${name}`)
    return { ...(found as object), lastDeploy: null }
  }

  const requireInput = () => {
    if (!deps.inputAllowed()) fail('input-off', '폰 입력 허용이 꺼져 있어요')
  }
  const text = (value: unknown, name: string): string => (typeof value === 'string' && value ? value : fail('usage', `${name} 가 필요해요`))

  const sentSize = (args: Record<string, unknown>) =>
    args.cols !== undefined || args.rows !== undefined ? cellSize(args.cols, args.rows) || fail('usage', 'cols · rows 는 2 이상 정수') : null

  async function paneInput(args: Record<string, unknown>) {
    requireInput()
    const pane = text(args.pane, 'pane')
    const data = text(args.data, 'data')
    await writeInput(pane, data, sentSize(args))
    // 내용은 적지 않는다(비밀값이 섞일 수 있다) — 누가 · 어느 pane · 크기만
    deps.logEvent('mobile.input', { by: 'mobile', pane, bytes: Buffer.byteLength(data) })
    return null
  }

  // 폰 이미지 — 저장한 경로를 pane 입력에 넣는다(엔터 없음). 입력과 같이 폰 크기로 가져간다.
  // paste: true 면 붙여넣기 표시(\x1b[200~ … \x1b[201~)로 감싼다 — Claude Code 는 붙여넣은 그림 경로만 첨부([Image #N])로 바꾼다(그냥 친 글자는 경로 글자 그대로 · 2026-11-12 실측).
  // pane 프로그램이 붙여넣기 모드(DECSET 2004)를 켰는지는 폰 xterm 이 안다(데몬 스냅숏이 모드를 싣는다) — 모드가 꺼진 pane 에 감싸면 표시 글자가 그대로 들어가니 폰이 정한다. 없으면 경로 + 공백
  async function paneImage(args: Record<string, unknown>) {
    requireInput()
    const pane = text(args.pane, 'pane')
    const sent = sentSize(args)
    if (args.paste !== undefined && typeof args.paste !== 'boolean') fail('usage', 'paste 는 true · false')
    const bytes = decodeImage(args.data)
    const type = imageType(bytes) || fail('unsupported-type', '이미지는 png · jpeg · gif · webp 만 받아요')
    // 없는 pane 에 파일만 남기지 않게 — 먼저 pane 이 있는지 본다
    const listed = (await (await connectControl()).call('pane list')) as { panes?: ListedPane[] } | null
    if (!((listed && listed.panes) || []).some((row) => row && row.id === pane)) fail('not_found', `없는 pane: ${pane}`)
    const file = await saveImage(deps.imageDir ? deps.imageDir() : defaultImageDir(), bytes, type, now())
    await writeInput(pane, args.paste === true ? `\x1b[200~${file}\x1b[201~` : `${file} `, sent)
    // 내용 · 경로는 적지 않는다 — 누가 · 어느 pane · 크기 · 형식만
    deps.logEvent('mobile.image', { by: 'mobile', pane, bytes: bytes.length, type })
    return { path: file, type, bytes: bytes.length }
  }

  async function writeInput(pane: string, data: string, sent: CellSize | null) {
    const connection = await connectControl()
    // 사람이 친 입력이면 폰 크기로 가져간 뒤 넣는다(터미널 자동 답은 주인을 바꾸지 않는다) — 크기를 모르면(열 때 · 입력 때 안 보냄) 가져가지 않는다
    const size = sent || phoneSizes.get(pane) || null
    if (size && !isTerminalReply(data)) await take(pane, size)
    else if (sent) phoneSizes.set(pane, sent)
    // 키 그대로(D2) — 붙여넣기 · 줄바꿈도 바꾸지 않는다
    await connection.call('input', { pane, data })
  }

  async function requestAnswer(args: Record<string, unknown>) {
    requireInput()
    const id = text(args.id, 'id')
    // 권한 요청(Claude 허락 · Codex 승인)도 위 requireInput 을 지난 뒤에만 — 입력 허용이 꺼져 있으면 input-off
    const approval = codexApprovalOf(await deps.requests(), id)
    if (approval) return approveCodex(id, approval, args)
    const choice = typeof args.choice === 'string' ? args.choice : ''
    const answerText = typeof args.text === 'string' ? args.text : ''
    if (!choice.trim() && !answerText.trim()) fail('usage', 'choice 또는 text 가 필요해요')
    // 본 rev 가 꼭 있어야 한다 — 없으면 앱 answerRevChanged 검사를 건너뛰어 그사이 바뀐 요청에 답이 붙는다
    if (!Number.isInteger(args.rev)) fail('usage', 'rev 가 필요해요')
    const answer: RequestAnswer = { choice, text: answerText, rev: args.rev as number }
    const result = await deps.answerRequest(id, answer)
    if (!result.ok) fail(result.error || 'failed', '답을 적지 못했어요')
    return result
  }

  // Codex 승인 — choice 는 승인 선택지의 key(snapshot requests[].codexApproval.choices[].key) · generation 은 본 그대로
  async function approveCodex(id: string, approval: CodexApprovalView, args: Record<string, unknown>) {
    const generation = text(args.generation, 'generation')
    const index = approval.choices.findIndex((choice) => choice.key === args.choice)
    if (index < 0) fail('usage', 'choice 는 승인 선택지 key 여야 해요')
    const result = await deps.approveRequest(id, generation, index)
    if (!result.ok) fail(errorCode(result.error, 'conflict'), '승인을 넣지 못했어요')
    // 명령 · 경로는 적지 않는다 — 누가 · 어느 pane · 고른 key 만
    deps.logEvent('mobile.approve', { by: 'mobile', pane: approval.pane, choice: approval.choices[index]?.key ?? null })
    return { ok: true }
  }

  // 결정 시트 — 남은 결정이 있는 계획서마다 결정(제목 · 설명 · 택1/복수 · 필수 · 선택지 · 확정값)
  function decisionList() {
    const dir = deps.athenaDir()
    const plans = dir ? openDecisionPlans(dir) : []
    return {
      plans: plans.map(({ plan, data }) => ({
        plan,
        title: data.title,
        hasPane: Boolean(deps.leadPaneOf(plan)),
        decisions: data.decisions.map(({ id, title, desc, type, required, options, decided }) => ({ id, title, desc, type, required, options, decided })),
      })),
    }
  }

  async function decisionAnswer(args: Record<string, unknown>) {
    requireInput()
    const plan = text(args.plan, 'plan')
    if (!PLAN_ID.test(plan) || plan.split('/').includes('..')) fail('usage', 'plan 은 plans/…md 여야 해요')
    if (!Array.isArray(args.decisions) || !args.decisions.every((entry) => typeof entry === 'string')) fail('usage', 'decisions 는 결정 id 목록이어야 해요')
    // 글을 폰이 만들어 보내거나(text) · 고른 값만 보내면 맥이 콘솔과 같은 글을 만든다(picks)
    const prompt = args.picks !== undefined ? promptFromPicks(plan, args.decisions as string[], args.picks) : text(args.text, 'text')
    const pane = deps.leadPaneOf(plan)
    if (!pane) return fail('no-pane', '결정을 보낼 pane 이 없어요')
    const reply = await deps.postDecision({ pane, plan, decisions: args.decisions as string[], text: prompt, by: 'mobile' })
    const body = (reply.body && typeof reply.body === 'object' ? reply.body : {}) as { stale?: unknown; queued?: unknown }
    if (reply.status === 409 && body.stale) fail('stale', '계획서 결정이 그사이 바뀌었어요')
    if (reply.status !== 200) fail('failed', `현황판이 받지 않았어요(${reply.status})`)
    return { ok: true, queued: body.queued === true }
  }

  function promptFromPicks(plan: string, seen: string[], picks: unknown): string {
    if (!picks || typeof picks !== 'object' || Array.isArray(picks)) return fail('usage', 'picks 는 {결정 id: 선택지} 여야 해요')
    const dir = deps.athenaDir()
    const data = dir ? readPlanData(dir, plan) : null
    if (!data) return fail('not_found', '결정을 읽지 못했어요')
    // 폰이 본 결정 id 와 지금 결정이 다르면 현황판처럼 stale(같은 글을 만들 수 없다)
    const now = data.decisions.map((decision) => decision.id)
    if (new Set(seen).size !== now.length || now.some((id) => !seen.includes(id))) return fail('stale', '계획서 결정이 그사이 바뀌었어요')
    return decisionPrompt(data, picks as Record<string, unknown>)
  }

  // ── 팩 탭 ──
  async function packList() {
    const view = deps.packs()
    const settings = await deps.repoSettings()
    // repos 는 ⚙ 설정 팝업과 같은 줄(main 직접 레포 빠짐) · 읽지 못하면 null
    return { current: view.current, packs: view.packs, repos: settings.ok ? settings.repos : null }
  }

  async function repoSet(args: Record<string, unknown>) {
    requireInput()
    const repo = text(args.repo, 'repo')
    if (!/^[\w.-]+$/.test(repo)) fail('usage', 'repo 이름이 맞지 않아요')
    const changes: RepoChanges = { auto: null, review: null, merge: null }
    if (args.auto !== undefined) changes.auto = args.auto === 'on' || args.auto === 'direct' ? args.auto : fail('usage', 'auto 는 on · direct')
    if (args.review !== undefined) changes.review = typeof args.review === 'boolean' ? args.review : fail('usage', 'review 는 true · false')
    if (args.merge !== undefined) changes.merge = args.merge === 'auto' || args.merge === 'confirm' || args.merge === 'manual' ? args.merge : fail('usage', 'merge 는 auto · confirm · manual')
    if (changes.auto === null && changes.review === null && changes.merge === null) fail('usage', '바꿀 값이 없어요')
    const before = await deps.repoSettings()
    if (!before.ok) fail('unreadable', '레포 설정을 읽지 못했어요')
    if (!before.repos.some((row) => repoName(row) === repo)) fail('not_found', `설정할 수 없는 레포: ${repo}`)
    const result = await deps.setRepo(repo, changes)
    if (result.ok !== true) fail(errorCode(result.error, 'failed'), '설정을 바꾸지 못했어요')
    deps.logEvent('mobile.repo-set', { by: 'mobile', repo, auto: changes.auto, review: changes.review, merge: changes.merge })
    const after = await deps.repoSettings()
    return { repo: (after.ok && after.repos.find((row) => repoName(row) === repo)) || null }
  }

  async function packOpen(args: Record<string, unknown>) {
    requireInput()
    const id = text(args.id, 'id')
    if (!deps.packs().packs.some((pack) => pack.id === id)) fail('not_found', `없는 팩: ${id}`)
    const result = await deps.openPack(id)
    if (result.ok !== true) fail(errorCode(result.error, 'failed'), '팩을 바꾸지 못했어요')
    deps.logEvent('mobile.pack-open', { by: 'mobile', pack: id })
    // 팩이 바뀌면 요청 · 머지 · 서버 · 결정 · 팩 칸이 모두 그 팩 것으로(pane 은 데몬 전체라 그대로)
    if (result.same !== true) emit({ event: 'changed', parts: ['requests', 'merges', 'servers', 'decisions', 'packs'] })
    return { id, switched: result.switched === true }
  }

  async function dispatch(op: unknown, args: Record<string, unknown>, later: (work: () => Promise<void>) => void): Promise<unknown> {
    switch (op) {
      case 'snapshot':
        return snapshot()
      case 'pane.open':
        return paneOpen(text(args.pane, 'pane'), sentSize(args), later)
      case 'pane.size':
        return paneSize(args)
      case 'pane.close':
        return paneClose(text(args.pane, 'pane'))
      case 'pane.input':
        return paneInput(args)
      case 'pane.image':
        return paneImage(args)
      case 'request.answer':
        return requestAnswer(args)
      case 'decision.list':
        return decisionList()
      case 'decision.answer':
        return decisionAnswer(args)
      case 'pack.list':
        return packList()
      case 'repo.set':
        return repoSet(args)
      case 'pack.open':
        return packOpen(args)
      case 'server.detail':
        return serverDetail(args)
      default:
        return fail('usage', `모르는 요청: ${String(op)}`)
    }
  }

  async function handle(message: unknown) {
    if (stopped || !message || typeof message !== 'object') return
    const { id, op, args } = message as { id?: unknown; op?: unknown; args?: unknown }
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    const afterReply: (() => Promise<void>)[] = []
    try {
      const result = await dispatch(op, safeArgs, (work) => void afterReply.push(work))
      if (id !== undefined) emit({ id, ok: true, result: result ?? null })
      for (const work of afterReply) await work().catch((error) => mobileError('[mobile-bridge] 답 뒤 처리 실패', String(op), error))
    } catch (caught) {
      // 브리지가 정한 오류만 그대로 — 그 밖(데몬 · 파일 · 코어)의 원문은 경로 등이 섞일 수 있어 맥 로그에만 남기고 폰에는 고정 문구
      if (caught instanceof BridgeError) {
        if (id !== undefined) emit({ id, ok: false, error: { code: caught.code, message: caught.message } })
        return
      }
      mobileError('[mobile-bridge] 요청 처리 실패', String(op), caught)
      if (id !== undefined) emit({ id, ok: false, error: { code: 'internal', message: '맥에서 처리하지 못했어요' } })
    }
  }

  transport.onMessage((message) => void handle(message))

  return {
    // 맥 쪽에서 바뀐 칸을 알린다(요청 폴더 · 머지 · 서버) — 폰은 그 칸만 다시 snapshot 한다
    changed(parts: string[]) {
      emit({ event: 'changed', parts })
    },
    openPanes: () => [...open],
    resyncPane,
    async stop() {
      if (stopped) return
      flush()
      // 연결이 끊겼다 — 이 폰이 가진 pane 은 맥 크기로(맥 알림 없음 · 이 폰에는 보내지 않는다)
      open.clear()
      for (const pane of owners.heldBy(holder)) await owners.phoneRelease(holder, pane)
      owners.unregister(holder)
      stopped = true
      if (sizeTimer) clearTimeout(sizeTimer)
      sizeTimer = null
      open.clear()
      const closing = [control, stream].filter((connection): connection is Connection => Boolean(connection)).map((connection) => connection.close())
      control = null
      stream = null
      await Promise.all(closing)
      transport.close()
    },
  }
}
