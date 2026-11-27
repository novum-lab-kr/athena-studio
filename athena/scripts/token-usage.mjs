#!/usr/bin/env node
// @ts-check
// 토큰 사용량 측정 — Claude Code 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl)을 역할(아테나 · 작업자 · 리뷰어 · 기타)마다 센다.
//   토큰 절감 계획서(plans/refactor/20261126-아테나-토큰-절감-턴-묶기-핑퐁-줄이기.md) 1 · 2절 숫자를 다시 내고 적용 전 · 후를 비교하려고 만들었다.
//   숫자만 찍는다 — 대화 본문 · 명령 글 · 비밀값은 출력하지 않는다.
//
// 사용: node scripts/token-usage.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--days 7] [--json]
//                                    [--projects <대화 기록 폴더>] [--studio <스튜디오 집>]
//   기간은 이 컴퓨터 시간대의 날짜 — --since 그날 0시부터 · --until 그날 끝까지(둘 다 포함) · 없으면 오늘까지 최근 --days 일
//
// 역할 가르기(세션 파일 하나 = 한 역할)
//   - 작업자 · 리뷰어: delegate.sh 가 넣는 첫머리 지시("이 작업의 계획서:" · 이어 보내기 "새 요청 — 새 계획서:" / "리뷰할 계획서:") —
//     scripts/lib/session-work.mjs MARK 와 같은 판정. 위임 세션은 ATHENA_AGENT 가 켜진 pane 이라 이 머리로 시작한다(delegate.sh PLAN_HEADER)
//   - 머리가 없으면 세션 cwd 로: 스튜디오 집 bodies/<본체> 그대로(본체 루트)면 아테나 · data/packs/<팩>/worktrees/ 아래면 작업자(새로 시작해 머리가 없는 작업자) · 그 밖은 기타
//   - 서브에이전트 기록(<세션>/subagents/*.jsonl)은 부모 세션의 역할로 센다
// 턴 = 응답 하나(message.id) — 한 응답이 여러 줄로 나뉘어 적히니 id 로 묶고, 이어 쓰기(--resume)로 다른 파일에 복사된 줄은 한 번만 센다
// 비용 비중 = 가중 토큰(입력 1 · 캐시 쓰기 5분 1.25 · 1시간 2 · 캐시 읽기 0.1 · 출력 5 — 입력 단가에 대한 배수)의 몫. 모델마다 단가가 다른 것은 넣지 않는다
// 받은 글 = 아테나 세션에 들어온 "[<누구> → 아테나] …" 글(바로 받은 user 줄 + 일하는 중 대기열로 받은 queued_command) · 끝 알림 = 그중 "→ 아테나] 끝 ·"
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { isMainModule } from './lib/is-main.mjs'
import { MARK } from './lib/session-work.mjs'

const WEIGHT = { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 }
const ROLES = ['lead', 'worker', 'reviewer', 'other']
/** @type {Record<string, string>} */
const ROLE_NAME = { lead: '아테나', worker: '작업자', reviewer: '리뷰어', other: '기타' }
const RECEIVED = /^\s*\[[^\]\n]{1,80}→ 아테나\]/
const DONE_NOTICE = /→ 아테나\] 끝 ·/
// pane 번호(p1l4 · p12 모양 — 2026-11-26 아테나 기록의 pane read · send-text 인자 실측)
const PANE_ID = /\bp\d[0-9a-z]{1,4}\b/g
// 이 세션이 그 pane 에 보냈거나 이어 띄운 명령의 pane 번호
const OWN_PANE = /(?:pane\s+send-text|--reuse-pane|pane\s+wait-start)\s+(p\d[0-9a-z]{1,4})\b/g
// 보낸 뒤 확인을 따로 하게 만든 명령 — 다음 턴들이 sleep · pane 읽기뿐이면 A1(--wait-start) 로 없어지는 턴
const SENT = /\bpane\s+send-text\b|\bdelegate\.sh\b/
// Bash 한 번짜리 턴의 종류 — 리드 단독 턴(2절)과 작업자 sleep 턴
/** @type {[string, RegExp][]} */
const BASH_KIND = [
  ['leadLog', /\blead-log\.mjs\b/],
  ['sleep', /(?:^|[;&|(]\s*)sleep\s+\d/],
  ['paneRead', /\bpane\s+read\b/],
]

/** @returns {never} */
function usage() {
  console.error('사용: node scripts/token-usage.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--days 7] [--json] [--projects <폴더>] [--studio <폴더>]')
  process.exit(2)
}

/** @param {string} text @param {boolean} endOfDay */
const localDay = (text, endOfDay) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) usage()
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (endOfDay) day.setDate(day.getDate() + 1)
  return day.getTime()
}
/** @param {number} at */
const dayText = (at) => {
  const day = new Date(at)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

/** @param {string[]} argv */
const parseArgs = (argv) => {
  /** @type {Record<string, string>} */
  const values = {}
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--json') json = true
    else if (['--since', '--until', '--days', '--projects', '--studio'].includes(arg) && argv[index + 1]) {
      values[arg.slice(2)] = argv[index + 1] ?? ''
      index += 1
    } else usage()
  }
  const days = Number(values.days ?? 7)
  if (!Number.isInteger(days) || days < 1) usage()
  const to = values.until ? localDay(values.until, true) : localDay(dayText(Date.now()), true)
  const from = values.since ? localDay(values.since, false) : to - days * 86_400_000
  if (from >= to) usage()
  return {
    json,
    from,
    to,
    projectsDir: values.projects ?? join(homedir(), '.claude', 'projects'),
    studioDir: values.studio ?? process.env.ATHENA_STUDIO_HOME ?? join(homedir(), '.athena-studio'),
  }
}

/** @param {string} path */
const realOr = (path) => {
  try { return realpathSync(path) } catch { return path }
}

/** @param {unknown} content @returns {string} */
const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
}

// 답 끝 📝 줄(리드 기록 — scripts/hooks/lead-log-stop.py 가 차례 끝에 lead-log.mjs 로 적는다 · 같은 꼴). 코드 블록 안 줄은 예시라 세지 않는다
const REPLY_LOG = /^\s*📝\s*(정정|실패|사실|결정)\s*[:：]\s*\S/
const FENCE = /^\s*(```|~~~)/
/** @param {string} text */
const replyLogCount = (text) => {
  let fenced = false
  let count = 0
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced
    else if (!fenced && REPLY_LOG.test(line)) count += 1
  }
  return count
}

/** @param {string} command */
const bashKind = (command) => BASH_KIND.find(([, pattern]) => pattern.test(command))?.[0] ?? 'other'

const emptyTotals = () => ({
  sessions: 0, turns: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, weighted: 0,
  bashOnly: 0, bashOnlyWeighted: 0,
  /** @type {Record<string, { turns: number, weighted: number }>} */
  bashOnlyKinds: { leadLog: { turns: 0, weighted: 0 }, sleep: { turns: 0, weighted: 0 }, paneRead: { turns: 0, weighted: 0 } },
  received: 0, doneNotices: 0, replyLogs: 0,
})

/** @typedef {{ usage: any, tools: Map<string, { name: string, command: string }>, at: number, replyLogs: number }} Answer */
/** @typedef {{ kind: 'turn', id: string } | { kind: 'notice', uuid: string, done: boolean, waking: boolean, chars: number } | { kind: 'human' } | { kind: 'compact' }} Moment */

/**
 * 파일 하나를 읽어 응답 · 받은 글을 모은다(역할은 다 읽은 뒤 정한다). timeline 은 예상 절감 셈에 쓰는 기간 안 순서(본문은 담지 않는다)
 * @param {string} path
 * @param {{ from: number, to: number }} range
 */
const readSession = async (path, range) => {
  /** @type {Map<string, Answer>} */
  const answers = new Map()
  /** @type {{ uuid: string, done: boolean }[]} */
  const received = []
  /** @type {Moment[]} */
  const timeline = []
  /** @type {Map<string, string>} tool_use id → 응답 id */
  const toolOwner = new Map()
  /** 이 세션이 띄우거나 보낸 · 알림을 받은 pane 번호 — 남의 창 pane 읽기를 가른다 */
  const ownPanes = new Set()
  let cwd = ''
  let mark = /** @type {'worker' | 'reviewer' | null} */ (null)
  /** @param {number} at */
  const inRange = (at) => at >= range.from && at < range.to
  /** @param {string} text @param {string} uuid @param {number} at @param {boolean} waking */
  const takeReceived = (text, uuid, at, waking) => {
    if (!inRange(at) || !RECEIVED.test(text)) return false
    const done = DONE_NOTICE.test(text)
    received.push({ uuid, done })
    for (const match of text.matchAll(PANE_ID)) ownPanes.add(match[0])
    timeline.push({ kind: 'notice', uuid, done, waking, chars: text.length })
    return true
  }
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('queued_command')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
    const at = Date.parse(entry.timestamp)
    if (entry.type === 'user') {
      const content = entry.message?.content
      if (entry.isCompactSummary) {
        if (inRange(at)) timeline.push({ kind: 'compact' })
        continue
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== 'tool_result') continue
        const answer = answers.get(toolOwner.get(String(block.tool_use_id)) ?? '')
        if (!answer) continue
        const text = typeof block.content === 'string' ? block.content : (Array.isArray(block.content) ? block.content.map((/** @type {any} */ item) => item?.text ?? '').join('\n') : '')
        const command = answer.tools.get(String(block.tool_use_id))?.command ?? ''
        if (/\bdelegate\.sh\b/.test(command)) for (const match of text.matchAll(PANE_ID)) ownPanes.add(match[0])
      }
      if (entry.isMeta) continue
      const text = textOf(content)
      if (!text) continue
      if (!mark) {
        const found = MARK.exec(text)
        if (found) mark = found[1] ? 'worker' : 'reviewer'
      }
      if (!takeReceived(text, String(entry.uuid ?? ''), at, true) && inRange(at)) timeline.push({ kind: 'human' })
      continue
    }
    if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
      const text = typeof entry.attachment.prompt === 'string' ? entry.attachment.prompt : ''
      takeReceived(text, String(entry.uuid ?? ''), at, false)
      continue
    }
    if (entry.type !== 'assistant') continue
    const id = entry.message?.id
    if (typeof id !== 'string' || !inRange(at)) continue
    let answer = answers.get(id)
    if (!answer) {
      answer = { usage: null, tools: new Map(), at, replyLogs: 0 }
      answers.set(id, answer)
      timeline.push({ kind: 'turn', id })
    }
    if (entry.message.usage) answer.usage = entry.message.usage   // 같은 응답의 마지막 줄 값이 최종
    for (const block of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') answer.replyLogs += replyLogCount(block.text)
      if (block?.type !== 'tool_use') continue
      const command = String(block.input?.command ?? '')
      answer.tools.set(String(block.id ?? answer.tools.size), { name: String(block.name ?? ''), command })
      toolOwner.set(String(block.id), id)
      for (const match of command.matchAll(OWN_PANE)) if (match[1]) ownPanes.add(match[1])
    }
  }
  return { cwd, mark, answers, received, timeline, ownPanes }
}

/** @param {any} usage */
const weightOf = (usage) => {
  const write = Number(usage?.cache_creation_input_tokens ?? 0)
  const write1h = Number(usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0)
  const write5m = Math.max(0, write - write1h)
  return Number(usage?.input_tokens ?? 0) * WEIGHT.input + write5m * WEIGHT.cacheWrite5m + write1h * WEIGHT.cacheWrite1h +
    Number(usage?.cache_read_input_tokens ?? 0) * WEIGHT.cacheRead + Number(usage?.output_tokens ?? 0) * WEIGHT.output
}

// 예상 절감 — 이 변경(H1~H10)이 기간 전에 있었으면 아테나가 덜 썼을 가중 토큰. 실측이 아니라 기록으로 하는 추정이다
//   없어지는 것 네 가지(한 턴은 앞 갈래 하나로만 센다):
//   - doneNotice  아테나 pane 에 들어온 끝 알림 줄(H1 조용한 끝) — 글 크기 × 그 뒤 다시 읽은 턴 수 × 캐시 읽기 0.1,
//                 쉬던 아테나를 깨운 알림이면 깨어나 처음 한 턴의 비용도
//   - confirmAfterSend  send-text · delegate.sh 를 부른 턴 바로 뒤에 이어진 sleep · pane 읽기 하나만 턴(A1 --wait-start)
//   - leadLogOnly lead-log 하나만 부른 턴(다른 명령과 묶기) — 명령 결과는 묶어도 남으니 그 턴 비용만
//   - foreignPaneRead 이 세션이 보내거나 띄우거나 알림을 받은 적 없는 pane 을 읽은 하나만 턴(pane list --mine)
//   없어지는 턴은 그 턴 비용 + 그 턴이 문맥에 더한 크기(다음 턴 문맥 − 이 턴 문맥) × 그 뒤 다시 읽은 턴 수 × 0.1
//   "그 뒤 다시 읽은 턴" = 같은 세션에서 다음 압축 전까지(기간 안) 응답 수
const NOTICE_TOKENS_PER_CHAR = 0.5   // 끝 알림 글 크기 추정(한국어 섞인 글 ≈ 2글자에 1토큰 — 실측 아님)
const SAVING_KINDS = ['doneNotice', 'confirmAfterSend', 'leadLogOnly', 'foreignPaneRead']

/** @param {any} usage */
const contextOf = (usage) => Number(usage?.input_tokens ?? 0) + Number(usage?.cache_creation_input_tokens ?? 0) + Number(usage?.cache_read_input_tokens ?? 0)

/**
 * 아테나 세션 하나의 예상 절감(가중 토큰) — 이어 쓰기로 복사된 응답 · 글은 seen 으로 한 번만
 * @param {Awaited<ReturnType<typeof readSession>>} session
 * @param {Set<string>} seen
 * @param {Record<string, { count: number, weighted: number }>} saved
 */
const estimateSavings = (session, seen, saved) => {
  const { timeline, answers, ownPanes } = session
  // 각 자리 뒤로 압축 전까지 남은 응답 수(뒤에서부터 센다)
  const laterTurns = new Array(timeline.length).fill(0)
  let count = 0
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    laterTurns[index] = count
    const moment = timeline[index]
    if (moment?.kind === 'compact') count = 0
    else if (moment?.kind === 'turn') count += 1
  }
  /** @param {number} index */
  const turnAt = (index) => {
    const moment = timeline[index]
    return moment?.kind === 'turn' ? answers.get(moment.id) : undefined
  }
  // 이 턴이 문맥에 더한 크기 — 다음 응답(압축을 넘지 않고)의 문맥 − 이 턴 문맥
  /** @param {number} index */
  const growthAt = (index) => {
    const here = turnAt(index)
    for (let next = index + 1; next < timeline.length; next += 1) {
      const moment = timeline[next]
      if (moment?.kind === 'compact') return 0
      const after = turnAt(next)
      if (after?.usage && here?.usage) return Math.max(0, contextOf(after.usage) - contextOf(here.usage))
    }
    return 0
  }
  /** @param {Answer | undefined} answer */
  const soloBash = (answer) => {
    const tools = answer ? [...answer.tools.values()] : []
    return tools.length === 1 && tools[0]?.name === 'Bash' ? tools[0].command : null
  }
  /** @param {string} kind @param {number} weighted */
  const take = (kind, weighted) => {
    const slot = saved[kind]
    if (!slot) return
    slot.count += 1
    slot.weighted += weighted
  }
  let afterSend = false   // 바로 앞 턴들이 "보낸 턴 + 확인 턴" 줄이면 참
  timeline.forEach((moment, index) => {
    if (moment.kind === 'notice') {
      afterSend = false
      if (!moment.done || seen.has(`n:${moment.uuid}`)) return
      seen.add(`n:${moment.uuid}`)
      let weighted = moment.chars * NOTICE_TOKENS_PER_CHAR * WEIGHT.cacheRead * laterTurns[index]
      if (moment.waking) {
        const woken = turnAt(index + 1)
        if (woken?.usage) weighted += weightOf(woken.usage)
      }
      take('doneNotice', weighted)
      return
    }
    if (moment.kind !== 'turn') {
      afterSend = false
      return
    }
    const answer = answers.get(moment.id)
    if (!answer?.usage || seen.has(`t:${moment.id}`)) return
    seen.add(`t:${moment.id}`)
    const command = soloBash(answer)
    const removed = weightOf(answer.usage) + growthAt(index) * WEIGHT.cacheRead * laterTurns[index]
    const kind = command === null ? null : bashKind(command)
    if (afterSend && (kind === 'sleep' || kind === 'paneRead')) {
      take('confirmAfterSend', removed)
      return
    }
    afterSend = [...answer.tools.values()].some((tool) => tool.name === 'Bash' && SENT.test(tool.command))
    if (kind === 'leadLog') {
      take('leadLogOnly', weightOf(answer.usage))
      return
    }
    if (kind === 'paneRead' && command !== null) {
      const panes = [...command.matchAll(/\bpane\s+read\s+(p\d[0-9a-z]{1,4})\b/g)].map((match) => match[1])
      if (panes.length && panes.every((pane) => pane && !ownPanes.has(pane))) take('foreignPaneRead', removed)
    }
  })
}

/**
 * @param {{ from: number, to: number, projectsDir: string, studioDir: string }} options
 */
export const measure = async ({ from, to, projectsDir, studioDir }) => {
  const studio = realOr(studioDir)
  const bodiesRoot = join(studio, 'bodies') + sep
  const packsRoot = join(studio, 'data', 'packs') + sep
  /** @param {string} cwd @param {'worker' | 'reviewer' | null} mark */
  const roleOf = (cwd, mark) => {
    if (mark) return mark
    const real = realOr(cwd)
    // 본체 루트 그대로만 — 본체 아래 하위 폴더(scripts/qa 등)에서 켠 세션은 아테나가 아니다
    if (real.startsWith(bodiesRoot) && !real.slice(bodiesRoot.length).includes(sep)) return 'lead'
    if (real.startsWith(packsRoot) && real.slice(packsRoot.length).split(sep)[1] === 'worktrees') return 'worker'
    return 'other'
  }
  /** @type {Record<string, ReturnType<typeof emptyTotals>>} */
  const totals = Object.fromEntries(ROLES.map((role) => [role, emptyTotals()]))
  const seenAnswers = new Set()
  const seenReceived = new Set()
  const seenSaved = new Set()
  /** @type {Record<string, { count: number, weighted: number }>} */
  const saved = Object.fromEntries(SAVING_KINDS.map((kind) => [kind, { count: 0, weighted: 0 }]))
  /** @param {string} role @param {Awaited<ReturnType<typeof readSession>>} session */
  const add = (role, session) => {
    const sum = totals[role] ?? totals.other
    if (!sum) return
    for (const [id, answer] of session.answers) {
      if (seenAnswers.has(id) || !answer.usage) continue
      seenAnswers.add(id)
      const weighted = weightOf(answer.usage)
      sum.turns += 1
      sum.input += Number(answer.usage.input_tokens ?? 0)
      sum.cacheWrite += Number(answer.usage.cache_creation_input_tokens ?? 0)
      sum.cacheRead += Number(answer.usage.cache_read_input_tokens ?? 0)
      sum.output += Number(answer.usage.output_tokens ?? 0)
      sum.weighted += weighted
      if (role === 'lead') sum.replyLogs += answer.replyLogs
      const tools = [...answer.tools.values()]
      if (tools.length !== 1 || tools[0]?.name !== 'Bash') continue
      sum.bashOnly += 1
      sum.bashOnlyWeighted += weighted
      const kind = sum.bashOnlyKinds[bashKind(tools[0].command)]
      if (kind) {
        kind.turns += 1
        kind.weighted += weighted
      }
    }
    if (role !== 'lead') return
    for (const item of session.received) {
      const key = item.uuid || `${seenReceived.size}`
      if (seenReceived.has(key)) continue
      seenReceived.add(key)
      sum.received += 1
      if (item.done) sum.doneNotices += 1
    }
  }

  const folders = existsSync(projectsDir) ? readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : []
  for (const folder of folders) {
    const dir = join(projectsDir, folder.name)
    let files = []
    try { files = readdirSync(dir) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dir, file)
      // 기간 시작 전에 마지막으로 쓴 파일에는 기간 안 줄이 없다
      const subDir = join(dir, file.slice(0, -'.jsonl'.length), 'subagents')
      const subFiles = existsSync(subDir) ? readdirSync(subDir).filter((name) => name.endsWith('.jsonl')).map((name) => join(subDir, name)) : []
      const fresh = [path, ...subFiles].some((item) => statSync(item).mtimeMs >= from)
      if (!fresh) continue
      const session = await readSession(path, { from, to })
      const role = roleOf(session.cwd, session.mark)
      const counted = session.answers.size > 0 || session.received.length > 0
      add(role, session)
      if (role === 'lead') estimateSavings(session, seenSaved, saved)   // 서브에이전트는 아테나 pane 이 아니다
      for (const subPath of subFiles) if (statSync(subPath).mtimeMs >= from) add(role, await readSession(subPath, { from, to }))
      const sum = totals[role]
      if (sum && counted) sum.sessions += 1
    }
  }

  const allWeighted = ROLES.reduce((acc, role) => acc + (totals[role]?.weighted ?? 0), 0)
  /** @param {number} value @param {number} whole */
  const share = (value, whole) => (whole > 0 ? Math.round((value / whole) * 1000) / 10 : 0)
  const roles = Object.fromEntries(ROLES.map((role) => {
    const sum = totals[role] ?? emptyTotals()
    const context = sum.turns ? Math.round((sum.input + sum.cacheWrite + sum.cacheRead) / sum.turns) : 0
    return [role, {
      sessions: sum.sessions,
      turns: sum.turns,
      input: sum.input,
      cacheWrite: sum.cacheWrite,
      cacheRead: sum.cacheRead,
      output: sum.output,
      weighted: Math.round(sum.weighted),
      costShare: share(sum.weighted, allWeighted),
      contextPerTurn: context,
      bashOnly: { turns: sum.bashOnly, roleShare: share(sum.bashOnlyWeighted, sum.weighted) },
      bashOnlyKinds: Object.fromEntries(Object.entries(sum.bashOnlyKinds).map(([kind, value]) => [kind, { turns: value.turns, roleShare: share(value.weighted, sum.weighted) }])),
      received: sum.received,
      doneNotices: sum.doneNotices,
      replyLogs: sum.replyLogs,
    }]
  }))
  const savedTotal = SAVING_KINDS.reduce((acc, kind) => acc + (saved[kind]?.weighted ?? 0), 0)
  const savings = {
    estimate: true,
    noticeTokensPerChar: NOTICE_TOKENS_PER_CHAR,
    kinds: Object.fromEntries(SAVING_KINDS.map((kind) => [kind, { count: saved[kind]?.count ?? 0, weighted: Math.round(saved[kind]?.weighted ?? 0) }])),
    weighted: Math.round(savedTotal),
    shareOfAll: share(savedTotal, allWeighted),
    shareOfLead: share(savedTotal, totals.lead?.weighted ?? 0),
  }
  return { since: dayText(from), until: dayText(to - 1), weights: WEIGHT, roles, savings }
}

/** @param {number} value */
const num = (value) => value.toLocaleString('en-US')

/** @param {Awaited<ReturnType<typeof measure>>} result */
const printTable = (result) => {
  const { roles } = result
  console.log(`토큰 사용량 · ${result.since} ~ ${result.until} · 비용 비중은 가중 토큰(입력 1 · 캐시 쓰기 1.25/2 · 캐시 읽기 0.1 · 출력 5)`)
  console.log('')
  console.log('| 역할 | 세션 | 턴 | 입력 | 캐시 쓰기 | 캐시 읽기 | 출력 | 비용 비중 | 턴당 문맥 |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const role of ROLES) {
    const row = roles[role]
    if (!row) continue
    console.log(`| ${ROLE_NAME[role]} | ${num(row.sessions)} | ${num(row.turns)} | ${num(row.input)} | ${num(row.cacheWrite)} | ${num(row.cacheRead)} | ${num(row.output)} | ${row.costShare}% | ${num(row.contextPerTurn)} |`)
  }
  const lead = roles.lead
  const worker = roles.worker
  if (lead && worker) {
    console.log('')
    console.log('| 단독 턴(Bash 하나만 부른 응답) | 아테나 턴 | 아테나 비용 중 | 작업자 턴 | 작업자 비용 중 |')
    console.log('|---|---:|---:|---:|---:|')
    console.log(`| Bash 하나만 | ${num(lead.bashOnly.turns)} | ${lead.bashOnly.roleShare}% | ${num(worker.bashOnly.turns)} | ${worker.bashOnly.roleShare}% |`)
    /** @type {[string, string][]} */
    const kindNames = [['leadLog', 'lead-log'], ['sleep', 'sleep'], ['paneRead', 'pane 읽기']]
    for (const [kind, name] of kindNames) {
      const mine = lead.bashOnlyKinds[kind] ?? { turns: 0, roleShare: 0 }
      const theirs = worker.bashOnlyKinds[kind] ?? { turns: 0, roleShare: 0 }
      console.log(`| └ ${name} | ${num(mine.turns)} | ${mine.roleShare}% | ${num(theirs.turns)} | ${theirs.roleShare}% |`)
    }
    console.log('')
    console.log(`아테나가 받은 글 ${num(lead.received)}건 · 그중 끝 알림 ${num(lead.doneNotices)}건`)
    console.log(`답 끝 📝 줄로 남긴 리드 기록 ${num(lead.replyLogs)}줄(lead-log 를 따로 부르지 않은 기록)`)
  }
  const { savings } = result
  /** @type {Record<string, string>} */
  const label = { doneNotice: '아테나 pane 끝 알림 줄', confirmAfterSend: '보낸 뒤 따로 한 sleep · pane 읽기 턴', leadLogOnly: 'lead-log 만 한 턴', foreignPaneRead: '다른 창 pane 읽기 턴' }
  console.log('')
  console.log('| 예상 절감(추정 · 실측 아님) | 횟수 | 가중 토큰 |')
  console.log('|---|---:|---:|')
  for (const kind of SAVING_KINDS) {
    const row = savings.kinds[kind] ?? { count: 0, weighted: 0 }
    console.log(`| ${label[kind]} | ${num(row.count)} | ${num(row.weighted)} |`)
  }
  console.log(`| 합 | | ${num(savings.weighted)} |`)
  console.log('')
  console.log(`이 변경이 기간 전에 있었으면 약 ${num(savings.weighted)} 가중 토큰(전체의 ${savings.shareOfAll}% · 아테나의 ${savings.shareOfLead}%) 덜 씀 — 추정`)
}

if (isMainModule(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  const result = await measure(options)
  if (options.json) console.log(JSON.stringify(result, null, 2))
  else printTable(result)
}
