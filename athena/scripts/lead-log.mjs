#!/usr/bin/env node
// @ts-check
// 아테나(리드) 기록 — 사용자 정정 · 실패 원인 · 확인한 동작 사실 · 결정을 생길 때 한 줄씩 덧붙인다
//   대화가 압축되면 요약에서 빠질 수 있는 것을 남겨 두는 자리다. 압축 뒤 안내(scripts/hooks/compact-checkpoint.py post)가
//   아테나 세션에 최근 줄을 먼저 읽게 하고, 곧 압축 알림(warn)도 여기에 적어 두라고 가리킨다
//   아테나는 보통 이 명령을 직접 부르지 않는다 — 답 끝 "📝 <종류>: <한 줄>" 줄을 Stop 훅(scripts/hooks/lead-log-stop.py)이 받아 줄마다 이 명령으로 적는다
//   자리: 여러 팩 구조면 팩 데이터 state/lead-log.md(팩마다), 옛 구조면 본체 .lead-log.md — 사건 기록(scripts/lib/events.mjs)과 같은 규칙
//   아테나 창이 여럿이면 줄이 섞이니 줄마다 쓴 창을 적는다 — "- <시각> <pane·대화 앞 8자> [종류] 글"(화면 밖이면 표시 없음)
//   읽을 때는 자기 줄만: 표시 없는 옛 줄 · 자기 pane · 자기 대화 · 지금 닫힌 pane 의 줄(창을 닫았다 열면 pane 번호가 바뀐다 — 닫힌 창의 기록은
//   떠 있는 아테나가 이어 읽는다 · 계획서 담당 넘기기 lead-send.py take_over 와 같은 쪽). 다른 열린 창의 줄만 뺀다. 압축 훅 lead_log_note 와 같은 규칙
//   덧붙이기만 한다 · 한 줄로 접는다 · 비밀값은 가린 뒤 쓴다(scripts/lib/mask.mjs maskText)
//
// 사용: node scripts/lead-log.mjs <정정|실패|사실|결정> "<한 줄>"     → 덧붙이고 쓴 줄을 보여 준다
//       node scripts/lead-log.mjs --tail [N] [--all]                 → 내 줄 중 최근 N줄(기본 20) · --all 은 모든 창의 줄
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ATHENA_ROOT, paths } from './lib/config.mjs'
import { isMainModule } from './lib/is-main.mjs'
import { maskText } from './lib/mask.mjs'
import { screenSync } from './lib/screen.mjs'

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

// 줄 앞의 창 표시 — "- 2026-11-26 02:20 <p1jh·1a2b3c4d> [결정] …"
const OWNER = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} <([\w-]+)(?:·([0-9a-fA-F-]+))?> /

/** 이 명령을 부른 창 — pane(환경에서 · 서버에 묻지 않는다)과 그 pane 의 지금 대화(pane-session.py 기록). 화면 밖이면 둘 다 ''
 * @param {string} root */
export const leadOwner = (root) => {
  let pane = ''
  try {
    pane = String(screenSync(['self'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).pane_id ?? '')
  } catch {
    return { pane: '', session: '' }
  }
  const where = paths(root)
  let session = ''
  if (pane && where.state) {
    try {
      session = String(JSON.parse(readFileSync(join(where.state, 'pane-sessions', `${pane}.json`), 'utf8')).session ?? '')
    } catch {
      // 기록이 없으면 pane 만 적는다
    }
  }
  return { pane, session }
}

/** 지금 열린 pane id — 못 읽으면 null(닫힌 창인지 모르니 줄을 빼지 않는다)
 * @returns {Set<string> | null} */
const openPanes = () => {
  try {
    const panes = screenSync(['pane', 'list'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).panes
    return Array.isArray(panes) ? new Set(panes.map((pane) => String(pane.id))) : null
  } catch {
    return null
  }
}

/** 내 줄만 — 표시 없는 줄 · 내 pane · 내 대화 · 닫힌 pane 의 줄(다른 열린 창의 줄만 뺀다)
 * @param {string[]} lines @param {{ pane: string, session: string }} owner @param {Set<string> | null} open */
export const ownLines = (lines, owner, open) => {
  if (!owner.pane || !open) return lines
  return lines.filter((line) => {
    const found = OWNER.exec(line)
    if (!found || found[1] === owner.pane) return true
    if (found[2] && owner.session.startsWith(found[2])) return true
    return !open.has(found[1] ?? '')
  })
}

// 함수 선언이어야 never 로 좁혀진다(화살표 함수는 좁히지 못한다)
/** @returns {never} */
function usage() {
  console.error(`사용: node scripts/lead-log.mjs <${KINDS.join('|')}> "<한 줄>"   ·   node scripts/lead-log.mjs --tail [N] [--all]`)
  process.exit(2)
}

const main = () => {
  const [first, ...rest] = process.argv.slice(2)
  const file = leadLogFile(ATHENA_ROOT)
  if (first === '--tail') {
    const all = rest.includes('--all')
    const [given, ...extra] = rest.filter((word) => word !== '--all')
    const count = given === undefined ? 20 : Number(given)
    if (!Number.isInteger(count) || count < 1 || extra.length) usage()
    if (!existsSync(file)) return
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('- '))
    const shown = all ? lines : ownLines(lines, leadOwner(ATHENA_ROOT), openPanes())
    for (const line of shown.slice(-count)) console.log(line)
    return
  }
  const text = rest.join(' ').replace(/\s+/g, ' ').trim()
  if (!first || !KINDS.includes(first) || !text) usage()
  const owner = leadOwner(ATHENA_ROOT)
  const mark = owner.pane ? `<${owner.pane}${owner.session ? `·${owner.session.slice(0, 8)}` : ''}> ` : ''
  const line = maskText(`- ${stamp()} ${mark}[${first}] ${text}`)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${line}\n`)
  console.log(line)
}

// leadLogFile 을 가져다 쓸 때는 돌지 않는다
if (isMainModule(import.meta.url)) main()
