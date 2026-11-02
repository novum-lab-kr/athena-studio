// 작업 시간 안쪽 — Claude 세션 기록(~/.claude/projects/<폴더>/*.jsonl)으로 "작업" 구간에 무엇을 했나 나눈다. 현황판 [지표] 탭(/api/metrics/work)
// 세션과 계획서는 delegate.sh 가 넣는 첫머리 지시로 잇는다("이 작업의 계획서:" · 이어 보내면 "새 계획서:" — 그 뒤 줄은 새 계획서로).
// reviewer("리뷰할 계획서:")는 리뷰 구간이라 빼고, 표시 없는 세션은 건수만 센다. Codex 세션은 모양이 달라 세지 않는다
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { partition } from './metrics.mjs'
import { projectFolderName } from '../board/claude-paths.mjs'

// 겹치면 앞쪽이 가져간다 — 응답을 쓰는 동안 도는 도구는 생각·작성으로 든다
export const WORK_KINDS = ['think', 'wait', 'check', 'other', 'read']

const MARK = /^\s*(?:(\[[^\]]*\]\s*새 요청 — 새 계획서|이 작업의 계획서)|리뷰할 계획서):\s*\S*?(plans\/\S+?\.md)/
const WAITING = /\b(?:until|while)\b[\s\S]*\bsleep\b|^\s*sleep\b|review-wait\.sh/
const CHECKING = /scripts\/verify\/|\breuse\.sh\b|\bcommit\.sh\b|\bship\.sh\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|typecheck|lint|build)\b|\btsc\b|\bvitest\b|\bjest\b|\bplaywright\s+test\b|\bgit\s+commit\b|\btest\/\S+-test\.sh\b/

// 도구 한 번의 종류 — null 이면 세지 않는다(사람 답을 기다리는 시간)
export const toolKind = (name, input) => {
  if (name === 'AskUserQuestion') return null
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'think'
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'read'
  if (name === 'Monitor') return 'wait'
  if (name !== 'Bash') return 'other'
  const command = String(input?.command ?? '')
  if (WAITING.test(command)) return 'wait'
  return CHECKING.test(command) ? 'check' : 'other'
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join(' ')
}

// 세션 한 개를 줄 순서대로 받는다 — 같은 응답은 message id 가 같은 줄 여러 개로 나뉘니 첫 줄 앞 ~ 끝 줄을 한 조각으로(그 사이 시간도 생각·작성)
export const createSessionReader = () => {
  let plan = null
  let linked = false
  let reviewer = false
  let lastMark = null
  const answers = new Map()   // message id → { plan, from, to }
  const tools = new Map()     // tool_use id → { plan, kind, from }
  const pieces = []
  return {
    add(entry) {
      const at = Date.parse(entry?.timestamp)
      if (!at || entry.isSidechain) return
      const content = entry.message?.content
      if (entry.type === 'user') {
        if (!entry.isCompactSummary && !entry.isMeta) {
          const mark = MARK.exec(textOf(content))
          if (mark) {
            plan = mark[1] ? mark[2] : null
            if (mark[1]) linked = true
            else reviewer = true
          }
        }
        for (const block of Array.isArray(content) ? content : []) {
          const open = block?.type === 'tool_result' ? tools.get(block.tool_use_id) : null
          if (!open) continue
          tools.delete(block.tool_use_id)
          if (open.plan) pieces.push({ plan: open.plan, label: open.kind, from: open.from, to: at })
        }
        lastMark = at
        return
      }
      if (entry.type !== 'assistant') return
      const answerId = entry.message?.id
      if (answerId) {
        const answer = answers.get(answerId) ?? { plan, from: lastMark ?? at, to: at }
        answer.to = at
        answers.set(answerId, answer)
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== 'tool_use') continue
        const kind = toolKind(block.name, block.input)
        if (kind) tools.set(block.id, { plan, kind, from: at })
      }
      lastMark = at
    },
    finish() {
      for (const answer of answers.values()) {
        if (answer.plan) pieces.push({ plan: answer.plan, label: 'think', from: answer.from, to: answer.to })
      }
      // 한 세션 안에서는 겹치지 않게 — 계획서마다 나눈다
      const byPlan = new Map()
      for (const piece of pieces) {
        if (!byPlan.has(piece.plan)) byPlan.set(piece.plan, [])
        byPlan.get(piece.plan).push(piece)
      }
      const merged = [...byPlan].flatMap(([planId, items]) => partition(items, WORK_KINDS).map((piece) => ({ plan: planId, ...piece })))
      return { kind: sessionKind(linked, reviewer), pieces: merged }
    },
  }
}

const sessionKind = (linked, reviewer) => {
  if (linked) return 'linked'
  return reviewer ? 'reviewer' : 'unlinked'
}

// 기간 [from, to) 합계 — 조각을 기간에 맞게 자른다. 세션끼리는 더하기만 하니 동시에 돌면 실제 경과보다 클 수 있다
export const workTotals = (sessions, { from = -Infinity, to = Infinity, picked = null } = {}) => {
  const totals = Object.fromEntries(WORK_KINDS.map((kind) => [kind, 0]))
  const plans = {}
  const counts = { linked: 0, reviewer: 0, unlinked: 0 }
  for (const session of sessions) {
    let touched = false
    for (const piece of session.pieces) {
      if (picked && !picked.has(piece.plan)) continue
      const span = Math.min(piece.to, to) - Math.max(piece.from, from)
      if (span <= 0) continue
      totals[piece.label] += span
      plans[piece.plan] ??= Object.fromEntries(WORK_KINDS.map((kind) => [kind, 0]))
      plans[piece.plan][piece.label] += span
      touched = true
    }
    if (touched || (session.kind !== 'linked' && session.lastAt >= from && session.lastAt < to)) counts[session.kind] += 1
  }
  return { totals, plans, sessions: counts }
}

const readSession = async (path) => {
  const reader = createSessionReader()
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    try { reader.add(JSON.parse(line)) } catch { /* 쓰는 중인 끝 줄 · 망가진 줄은 건너뛴다 */ }
  }
  return reader.finish()
}

// 바뀌지 않은 세션은 다시 읽지 않는다 — (크기 · 수정 시각)이 같으면 캐시. 세션 기록이 수 GB 라 스트림으로 읽고 기간 전에 끝난 파일은 건너뛴다
export const scanSessions = async ({ projectsDir, worktrees, cachePath, from = -Infinity }) => {
  const prefix = `${projectFolderName(worktrees)}-`
  let cache = {}
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')) } catch { /* 처음 · 망가졌으면 다시 센다 */ }
  const folders = (await readdir(projectsDir).catch(() => [])).filter((name) => name.startsWith(prefix))
  const sessions = []
  let changed = false
  for (const folder of folders) {
    const files = (await readdir(join(projectsDir, folder)).catch(() => [])).filter((name) => name.endsWith('.jsonl'))
    for (const file of files) {
      const path = join(projectsDir, folder, file)
      const info = await stat(path).catch(() => null)
      if (!info || info.mtimeMs < from) continue
      let saved = cache[path]
      if (!saved || saved.size !== info.size || saved.mtimeMs !== info.mtimeMs) {
        const result = await readSession(path).catch(() => null)
        if (!result) continue
        saved = { size: info.size, mtimeMs: info.mtimeMs, kind: result.kind, pieces: result.pieces.map((piece) => [piece.plan, piece.label, piece.from, piece.to]) }
        cache[path] = saved
        changed = true
      }
      sessions.push({
        kind: saved.kind,
        lastAt: saved.mtimeMs,
        pieces: saved.pieces.map(([plan, label, start, end]) => ({ plan, label, from: start, to: end })),
      })
    }
  }
  if (changed) await writeFile(cachePath, JSON.stringify(cache)).catch(() => {})
  return sessions
}
