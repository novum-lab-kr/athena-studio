#!/usr/bin/env node
// @ts-check
// 아테나(리드) 기록 — 사용자 정정 · 실패 원인 · 확인한 동작 사실 · 결정을 생길 때 한 줄씩 덧붙인다
//   대화가 압축되면 요약에서 빠질 수 있는 것을 남겨 두는 자리다. 압축 뒤 안내(scripts/hooks/compact-checkpoint.py post)가
//   아테나 세션에 최근 줄을 먼저 읽게 하고, 곧 압축 알림(warn)도 여기에 적어 두라고 가리킨다
//   자리: 여러 팩 구조면 팩 데이터 state/lead-log.md(팩마다), 옛 구조면 본체 .lead-log.md — 사건 기록(scripts/lib/events.mjs)과 같은 규칙
//   덧붙이기만 한다 · 한 줄로 접는다 · 비밀값은 가린 뒤 쓴다(scripts/lib/mask.mjs maskText)
//
// 사용: node scripts/lead-log.mjs <정정|실패|사실|결정> "<한 줄>"     → 덧붙이고 쓴 줄을 보여 준다
//       node scripts/lead-log.mjs --tail [N]                         → 최근 N줄(기본 20)
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ATHENA_ROOT, paths } from './lib/config.mjs'
import { isMainModule } from './lib/is-main.mjs'
import { maskText } from './lib/mask.mjs'

export const KINDS = ['정정', '실패', '사실', '결정']

/** @param {string} root */
export const leadLogFile = (root) => {
  const where = paths(root)
  return where.mode === 'packs' ? join(where.state, 'lead-log.md') : join(root, '.lead-log.md')
}

/** @param {number} value */
const pad = (value) => String(value).padStart(2, '0')
const stamp = (now = new Date()) =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

// 함수 선언이어야 never 로 좁혀진다(화살표 함수는 좁히지 못한다)
/** @returns {never} */
function usage() {
  console.error(`사용: node scripts/lead-log.mjs <${KINDS.join('|')}> "<한 줄>"   ·   node scripts/lead-log.mjs --tail [N]`)
  process.exit(2)
}

const main = () => {
  const [first, ...rest] = process.argv.slice(2)
  const file = leadLogFile(ATHENA_ROOT)
  if (first === '--tail') {
    const count = rest[0] === undefined ? 20 : Number(rest[0])
    if (!Number.isInteger(count) || count < 1) usage()
    if (!existsSync(file)) return
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('- '))
    for (const line of lines.slice(-count)) console.log(line)
    return
  }
  const text = rest.join(' ').replace(/\s+/g, ' ').trim()
  if (!first || !KINDS.includes(first) || !text) usage()
  const line = maskText(`- ${stamp()} [${first}] ${text}`)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${line}\n`)
  console.log(line)
}

// leadLogFile 을 가져다 쓸 때는 돌지 않는다
if (isMainModule(import.meta.url)) main()
