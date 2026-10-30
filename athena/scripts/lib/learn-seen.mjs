/**
 * 배우기 검토 — "한 번 본 code 후보" 보관소와 이슈를 열지 말지 정하는 문.
 *
 * 학습 후보 이슈는 사람이 하나씩 [넣기]를 눌러야 해서 너무 많이 열면 쌓이기만 한다(2026-10-30: 5일에 72개).
 * 그래서 새 이슈는 아래 둘일 때만 연다.
 *   - 실행으로 확인한 것(basis: run)
 *   - 같은 함정이 두 번째 나온 것(검토자가 repeatOf 로 "한 번 본 후보"나 "열린 learn 이슈"를 가리킨다)
 * basis: code 한 번짜리는 이슈 대신 이 보관소(<본체>/.sync/learn-seen.json)에 가볍게 남기고, 두 번째가 나오면 이슈로 올린다.
 * 같은 함정인지는 글자 비교가 아니라 검토자(LLM)가 보고 repeatOf 에 적는다 — 함정은 절 이름이 같아도 내용이 다를 수 있다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

export const SEEN_MAX = 80   // 오래된 것부터 잊는다 — 가볍게 남기는 보관소라 끝없이 커지지 않게
const seenFile = (root) => join(root, '.sync', 'learn-seen.json')

export const seenIdOf = (rule) => `seen-${createHash('sha1').update(String(rule ?? '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 6)}`

export const readSeen = (root) => {
  try {
    const list = JSON.parse(readFileSync(seenFile(root), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
export const writeSeen = (root, list) => {
  const path = seenFile(root)
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(list.slice(-SEEN_MAX), null, 2)}\n`)
}

/**
 * 이 후보를 어떻게 할지.
 *   open         새 이슈를 연다
 *   repeat-open  이미 열린 learn 이슈에 "반복 +1" 만 덧붙인다(file)
 *   repeat-seen  한 번 본 후보와 같은 함정 — 이슈를 열고 보관소에서 뺀다(entry)
 *   hold         basis: code 한 번짜리 — 이슈를 열지 않고 보관소에 남긴다
 */
export const decideGate = ({ item, seen, openFiles }) => {
  if (item.kind === 'skill') return { action: 'open' }   // 스킬 후보는 기존대로 target 이 같으면 반복 +1
  const repeatOf = String(item.repeatOf ?? '').trim()
  if (repeatOf && openFiles.includes(repeatOf)) return { action: 'repeat-open', file: repeatOf }
  if (item.basis === 'run') return { action: 'open' }
  const entry = repeatOf ? seen.find((candidate) => candidate.id === repeatOf) : null
  if (entry) return { action: 'repeat-seen', entry }
  return { action: 'hold' }
}
