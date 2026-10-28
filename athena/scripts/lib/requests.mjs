// 사람에게 묻는 요청 — "내 판단이 필요해요" 를 상태 글자로 추측하지 않고 기록으로 남긴다(docs/requests.md)
//
//   자리: 여러 팩 구조면 팩 데이터 state/requests/<id>.json(팩마다 · 본체 링크를 늘리지 않는다), 옛 구조면 본체 .requests/
//   흐름: open → answered(사람이 답함) → delivered(에이전트가 받음 · ack) / cancelled / expired
//         대화로 답을 받았으면(answer --by chat) 에이전트가 이미 받은 것이라 바로 delivered
//   쓰기는 이 모듈로만 — 폴더 잠금 + 원자 저장 + rev(고칠 때마다 +1). 답할 때 rev 를 주면 그사이 바뀐 요청에는 답하지 않는다(conflict)
//   같은 dedupeKey 로 열린(open · answered) 요청이 있으면 새로 만들지 않고 고친다
//   팩 세대가 바뀐 뒤(가져오기 --replace 등) 만든 요청에 온 답은 거절한다(stale) — 현황판 쓰기의 409 와 같은 규칙
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './config.mjs'
import { logEvent } from './events.mjs'
import { PackError, takeLock } from './lock.mjs'
import { writeAtomic } from './plan-update.mjs'

export const REQUEST_FORMAT = 1
export const KINDS = ['decision', 'question']
export const STATES = ['open', 'answered', 'delivered', 'cancelled', 'expired']
const LIVE = ['open', 'answered']
const ANSWER_BY = ['board', 'app', 'chat']
const ID_PATTERN = /^r-\d{8}-\d{6}-[0-9a-f]{4}$/

export const requestsDir = (root) => {
  const where = paths(root)
  return where.mode === 'packs' ? join(where.state, 'requests') : join(root, '.requests')
}

const now = () => new Date().toISOString()
const newId = () => {
  const date = new Date()
  const two = (value) => String(value).padStart(2, '0')
  return `r-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}-${randomBytes(2).toString('hex')}`
}

const readRequest = (dir, id) => {
  try {
    const request = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
    return request && request.id === id ? request : null
  } catch {
    return null
  }
}
const readAll = (dir) => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && ID_PATTERN.test(name.slice(0, -5)))
    .map((name) => readRequest(dir, name.slice(0, -5)))
    .filter(Boolean)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}
const save = (dir, request) => writeAtomic(join(dir, `${request.id}.json`), `${JSON.stringify(request, null, 2)}\n`)
// 상태가 바뀔 때마다 사건 기록에도 한 줄(사람 개입 측정 — docs/events.md)
const logState = (root, request) => logEvent(root, 'request', {
  id: request.id, kind: request.kind, state: request.state, plan: request.links?.plan || null, by: request.answer?.by || null, rev: request.rev,
})

// 폴더 잠금 안에서 — 읽고 고치고 쓰기가 다른 쓰기와 섞이지 않게
const withLock = (root, work) => {
  const dir = requestsDir(root)
  mkdirSync(dir, { recursive: true })
  const release = takeLock(join(dir, '.lock'), 'request', { waitMs: 5000, message: (owner) => `요청 폴더를 다른 작업이 쥐고 있다(pid ${owner.pid})` })
  try {
    return work(dir)
  } finally {
    release()
  }
}

const mustGet = (dir, id) => {
  if (!ID_PATTERN.test(String(id || ''))) throw new PackError('usage', `요청 번호 모양이 아니다: ${id}`)
  const request = readRequest(dir, id)
  if (!request) throw new PackError('not-found', `그런 요청이 없다: ${id}`)
  return request
}

const cleanOptions = (options) => (Array.isArray(options) ? options : [])
  .filter((option) => option && String(option.label || '').trim())
  .map((option) => ({ label: String(option.label).trim(), ...(option.desc ? { desc: String(option.desc) } : {}), ...(option.recommended ? { recommended: true } : {}) }))

// 열기 — { kind, title, body?, options?, links?: { plan, html, issue }, pane?, dedupeKey? }
export const openRequest = (root, input) => {
  const kind = String(input.kind || '')
  if (!KINDS.includes(kind)) throw new PackError('usage', `종류는 ${KINDS.join(' · ')} 중 하나다: ${kind || '(없음)'}`)
  const title = String(input.title || '').trim()
  if (!title) throw new PackError('usage', '제목(--title)이 필요하다')
  const where = paths(root)
  const fields = {
    kind,
    title,
    body: String(input.body || ''),
    options: cleanOptions(input.options),
    links: { plan: input.links?.plan || null, html: input.links?.html || null, issue: input.links?.issue || null },
    pane: input.pane || null,
  }
  const dedupeKey = String(input.dedupeKey || '').trim() || null
  return withLock(root, (dir) => {
    const same = dedupeKey ? readAll(dir).find((request) => request.dedupeKey === dedupeKey && LIVE.includes(request.state)) : null
    if (same) {
      // 답을 받은 뒤(answered) 다시 열면 새 질문이다 — 답을 지우고 open 으로
      const updated = { ...same, ...fields, state: 'open', answer: null, rev: same.rev + 1, updatedAt: now() }
      save(dir, updated)
      logState(root, updated)
      return { ok: true, request: updated, reused: true }
    }
    const request = {
      format: REQUEST_FORMAT,
      id: newId(),
      ...fields,
      pack: where.packId,
      generation: where.generation,
      dedupeKey,
      state: 'open',
      rev: 1,
      createdAt: now(),
      updatedAt: now(),
      answer: null,
      deliveredAt: null,
      closedReason: null,
    }
    save(dir, request)
    logState(root, request)
    return { ok: true, request, reused: false }
  })
}

// 목록 — 기본은 열린 것(open · answered). 계획서가 없어졌거나 done 이 된 요청은 이때 expired 로 닫는다
export const listRequests = (root, { all = false } = {}) => withLock(root, (dir) => {
  const requests = readAll(dir)
  for (const request of requests) {
    if (!LIVE.includes(request.state) || !request.links?.plan) continue
    const planFile = join(root, request.links.plan)
    const text = existsSync(planFile) ? readFileSync(planFile, 'utf8') : null
    if (text !== null && !/^- Status:\s*done\b/m.test(text)) continue
    Object.assign(request, { state: 'expired', closedReason: text === null ? '계획서가 없어졌다' : '계획서가 done', rev: request.rev + 1, updatedAt: now() })
    save(dir, request)
    logState(root, request)
  }
  return { ok: true, requests: all ? requests : requests.filter((request) => LIVE.includes(request.state)) }
})

export const showRequest = (root, id) => withLock(root, (dir) => ({ ok: true, request: mustGet(dir, id) }))

// 답하기 — { choice?, text?, by, rev? }. 대화로 받은 답(by chat)은 바로 delivered
export const answerRequest = (root, id, { choice = '', text = '', by = '', rev = null } = {}) => {
  if (!ANSWER_BY.includes(by)) throw new PackError('usage', `--by 는 ${ANSWER_BY.join(' · ')} 중 하나다`)
  if (!String(choice).trim() && !String(text).trim()) throw new PackError('usage', '답(--choice 또는 --text)이 필요하다')
  const where = paths(root)
  return withLock(root, (dir) => {
    const request = mustGet(dir, id)
    if (rev !== null && Number(rev) !== request.rev) throw new PackError('conflict', `요청이 그사이 바뀌었다(rev ${request.rev} — 받은 rev ${rev}) — 다시 읽고 답한다`, { request })
    if (request.state !== 'open') throw new PackError('conflict', `이미 ${request.state} 인 요청이다`, { request })
    if (where.generation !== null && request.generation !== null && request.generation !== where.generation) {
      throw new PackError('stale', `팩이 그사이 바뀌었다(세대 ${request.generation} → ${where.generation}) — 이 요청에는 답할 수 없다`, { request })
    }
    const at = now()
    const answer = { choice: String(choice).trim() || null, text: String(text).trim() || null, by, at }
    const delivered = by === 'chat'
    Object.assign(request, { state: delivered ? 'delivered' : 'answered', answer, deliveredAt: delivered ? at : null, rev: request.rev + 1, updatedAt: at })
    save(dir, request)
    logState(root, request)
    return { ok: true, request }
  })
}

// 받음 — 에이전트가 답을 받았다. 같은 요청을 두 번 받아도 그대로(already)
export const ackRequest = (root, id) => withLock(root, (dir) => {
  const request = mustGet(dir, id)
  if (request.state === 'delivered') return { ok: true, request, already: true }
  if (request.state !== 'answered') throw new PackError('conflict', `답이 아직 없거나 닫힌 요청이다(${request.state})`, { request })
  const at = now()
  Object.assign(request, { state: 'delivered', deliveredAt: at, rev: request.rev + 1, updatedAt: at })
  save(dir, request)
  logState(root, request)
  return { ok: true, request, already: false }
})

export const cancelRequest = (root, id, { reason = '' } = {}) => withLock(root, (dir) => {
  const request = mustGet(dir, id)
  if (!LIVE.includes(request.state)) throw new PackError('conflict', `이미 ${request.state} 인 요청이다`, { request })
  Object.assign(request, { state: 'cancelled', closedReason: String(reason).trim() || null, rev: request.rev + 1, updatedAt: now() })
  save(dir, request)
  logState(root, request)
  return { ok: true, request }
})

// 계획서 결정 콘솔 → 요청 하나(계획서마다 dedupeKey plan:<경로>). 안 정한 결정이 있으면 열고, 다 정했으면 받은 것으로 닫는다.
// plan-html.mjs 가 부른다 — 결정 콘솔 요청은 규칙에 기대지 않고 늘 생긴다
export const syncPlanRequest = (root, { mdFile, htmlFile, plan }) => {
  const decisions = plan.decisions ?? []
  const open = decisions.filter((decision) => decision.decided == null)
  const dedupeKey = `plan:${mdFile}`
  if (open.length) {
    return openRequest(root, {
      kind: 'decision',
      title: plan.title || mdFile,
      body: open.map((decision) => `- ${decision.title}${decision.desc ? ` — ${decision.desc}` : ''}`).join('\n'),
      links: { plan: mdFile, html: htmlFile },
      pane: plan.leadPane || null,
      dedupeKey,
    })
  }
  return withLock(root, (dir) => {
    const live = readAll(dir).find((request) => request.dedupeKey === dedupeKey && LIVE.includes(request.state))
    if (!live) return { ok: true, request: null }
    const at = now()
    const answer = live.answer ?? { choice: decisions.map((decision) => `${decision.id}=${[].concat(decision.decided).join(',')}`).join(' '), text: null, by: 'chat', at }
    Object.assign(live, { state: 'delivered', answer, deliveredAt: at, rev: live.rev + 1, updatedAt: at })
    save(dir, live)
    logState(root, live)
    return { ok: true, request: live }
  })
}
