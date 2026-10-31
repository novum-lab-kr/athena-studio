#!/usr/bin/env node
// 측정용 사건 기록 — 일이 어떻게 흘렀는지(사람 개입 · 상태 변화 · 검증 · 커밋 · 리뷰)를 한 줄씩 남긴다(docs/events.md)
//
//   자리: 여러 팩 구조면 팩 데이터 state/events.jsonl(팩마다), 옛 구조면 본체 .events.jsonl
//   한 줄 = { v, at, type, pack, …fields } — 덧붙이기만 한다(고치거나 지우지 않는다)
//   기록에 실패해도 하던 일을 막지 않는다 — 측정은 부가 기능이다
//
//   node:  logEvent(root, 'commit', { plan, repo, sha })
//   셸:    node scripts/lib/events.mjs <종류> 키=값 …     (값 true · false 는 참거짓으로 · ms 는 숫자로)
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ATHENA_ROOT, paths } from './config.mjs'
import { writeAtomic } from './plan-update.mjs'

export const EVENT_FORMAT = 1

const stateFile = (root, packsName, legacyName) => {
  const where = paths(root)
  return where.mode === 'packs' ? join(where.state, packsName) : join(root, legacyName)
}
export const eventsFile = (root) => stateFile(root, 'events.jsonl', '.events.jsonl')
const planStatusFile = (root) => stateFile(root, 'plan-status.json', '.board-plan-status.json')

export const logEvent = (root, type, fields = {}) => {
  try {
    const file = eventsFile(root)
    mkdirSync(dirname(file), { recursive: true })
    const event = { v: EVENT_FORMAT, at: new Date().toISOString(), type, pack: paths(root).packId, ...fields }
    appendFileSync(file, `${JSON.stringify(event)}\n`)
  } catch { /* 측정 실패는 무시한다 */ }
}

export const readEvents = (root) => {
  try {
    return readFileSync(eventsFile(root), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch {
    return []
  }
}

// 계획서마다 완료로 바뀐 시각(ms) — 마지막 plan.status 가 done 일 때만(done 뒤 다시 열렸으면 없음).
// 현황판이 카드에 doneAt 으로 실어 앱(트레이 · [작업] 팝업)이 같은 완료 기준을 쓴다. 파일이 그대로면 다시 읽지 않는다
let doneCache = { key: '', times: new Map() }
export const doneTimes = (root) => {
  try {
    const file = eventsFile(root)
    const stat = statSync(file)
    const key = `${file}:${stat.size}:${stat.mtimeMs}`
    if (doneCache.key === key) return doneCache.times
    const times = new Map()
    for (const event of readEvents(root)) {
      if (event.type !== 'plan.status' || !event.plan) continue
      if (event.to === 'done') times.set(event.plan, Date.parse(event.at) || null)
      else times.delete(event.plan)
    }
    doneCache = { key, times }
    return times
  } catch {
    return new Map()
  }
}

// 계획서 Status 변화 — 에이전트가 계획서 md 를 직접 고치므로 고치는 쪽에서 남길 수 없다.
// 현황판이 훑을 때마다 지난번 본 상태와 비교해 바뀐 것만 남긴다(현황판이 꺼져 있던 동안의 변화는 다음에 볼 때 시각으로).
// 처음(본 기록이 없을 때)은 지금 상태만 적어 두고 사건은 남기지 않는다 — 예전 계획서가 한꺼번에 "새로 생김" 으로 찍히지 않게
export const observePlanStatus = (root, plans) => {
  try {
    const file = planStatusFile(root)
    let seen = null
    try { seen = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 처음 */ }
    const next = { ...(seen ?? {}) }
    let changed = seen === null
    for (const plan of plans) {
      const before = seen?.[plan.id]
      if (before === plan.status) continue
      next[plan.id] = plan.status
      changed = true
      if (seen !== null) logEvent(root, 'plan.status', { plan: plan.id, grade: plan.grade, from: before ?? null, to: plan.status })
    }
    if (!changed) return
    mkdirSync(dirname(file), { recursive: true })
    writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  } catch { /* 측정 실패는 무시한다 */ }
}

// 스크립트가 Status 를 바꾼 때(commit.sh) — 사건을 남기고 지난번 본 상태도 맞춰 현황판이 같은 변화를 또 남기지 않게 한다.
// 본 기록이 아직 없으면 그대로 둔다(현황판의 첫 훑기가 지금 상태를 적는다)
export const recordPlanStatus = (root, fields) => {
  logEvent(root, 'plan.status', fields)
  try {
    const file = planStatusFile(root)
    const seen = JSON.parse(readFileSync(file, 'utf8'))
    writeAtomic(file, `${JSON.stringify({ ...seen, [fields.plan]: fields.to }, null, 2)}\n`)
  } catch { /* 측정 실패는 무시한다 */ }
}

// 셸 스크립트용 — node scripts/lib/events.mjs <종류> 키=값 …
// 숫자로 받는 칸은 이름으로 정한다(sha · pr 처럼 숫자로 보이는 글자 칸을 숫자로 바꾸지 않게)
const NUMBER_FIELDS = new Set(['ms', 'promptChars', 'contextChars'])
const parseValue = (key, value) => {
  if (value === 'true') return true
  if (value === 'false') return false
  if (NUMBER_FIELDS.has(key) && value !== '' && Number.isFinite(Number(value))) return Number(value)
  return value
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [type, ...pairs] = process.argv.slice(2)
  if (type) {
    const fields = {}
    for (const pair of pairs) {
      const at = pair.indexOf('=')
      if (at <= 0) continue
      fields[pair.slice(0, at)] = parseValue(pair.slice(0, at), pair.slice(at + 1))
    }
    if (type === 'plan.status') recordPlanStatus(ATHENA_ROOT, fields)
    else logEvent(ATHENA_ROOT, type, fields)
  }
}
