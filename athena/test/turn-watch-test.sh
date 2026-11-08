#!/usr/bin/env bash
# 아테나가 에이전트 알림을 놓치지 않게 지키기 시험 — scripts/board/turn-watch.mjs(현황판 server.mjs 가 15초마다 부른다 · 계획서 결정 D1~D4).
# 임시 상태 폴더 · 가짜 넣기 · 가짜 요청으로 — 화면 · claude · 현황판 서버를 부르지 않는다 · 몇 초
#   안 받은 알림: 2분 전엔 그대로 · 2분이면 한 번 다시 넣기(그 아테나 pane 이 살아 있을 때만) · 10분이면 [작업] 요청 한 번 · 이미 열린 요청이 있으면 열지 않기
#   받았으면 연 요청을 거두기 · 계획서가 done 이면 아무것도 안 함 · 일하는 중 선택 창은 "선택 창" 알림 한 번(끝난 차례는 안 함) · 창이 닫히면 그 알림을 더 밀지 않음
#   lead-notice.mjs — 창이 떠 있으면 미뤘다가 flush 로 넣기 · 같은 key 는 한 번
#
# 사용: test/turn-watch-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

node --input-type=module - "$SRC" "$WORK" <<'NODE'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const [src, work] = process.argv.slice(2)
const { reconcileTurns, RESEND_MS, REQUEST_MS } = await import(join(src, 'scripts/board/turn-watch.mjs'))
const { createLeadNotifier } = await import(join(src, 'scripts/lib/lead-notice.mjs'))
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✔ ${name}`)
  else { console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`); fail = 1 }
}

const stateDir = join(work, 'state')
const noticeDir = join(stateDir, 'lead-notices')
const turnDir = join(stateDir, 'agent-turn')
mkdirSync(noticeDir, { recursive: true }); mkdirSync(turnDir, { recursive: true })
const T0 = 1_800_000_000_000
const writeNotice = (id, fields) => writeFileSync(join(noticeDir, `${id}.json`), JSON.stringify({ id, kind: 'turn', lead: 'p1', text: `[fe → 아테나] 끝 · p9 · ${id}`, plan: 'plans/task/x.md', pane: 'p9', from: 'fe', sent_at: T0 / 1000, ...fields }))
const readNotice = (id) => JSON.parse(readFileSync(join(noticeDir, `${id}.json`), 'utf8'))
const ID = 'a'.repeat(32)

// 부르는 쪽 흉내 — 넣은 것 · 연 요청 · 거둔 요청을 적는다
const make = ({ plans, panes, menu = new Set(), openPanes = new Set() } = {}) => {
  const log = { notify: [], opened: [], cancelled: [] }
  const deps = {
    stateDir,
    plans: plans ?? [{ id: 'plans/task/x.md', status: 'in_progress', leadPane: 'p1', agents: ['p9'] }],
    panes: panes ?? [{ id: 'p1' }, { id: 'p9' }],
    menuOf: async (paneId) => menu.has(paneId),
    notify: async (notice) => { log.notify.push(notice); return 'sent' },
    openRequestFor: (notice) => { log.opened.push(notice.id); return `req-${log.opened.length}` },
    cancelRequest: (requestId) => log.cancelled.push(requestId),
    hasOpenRequest: (paneId) => openPanes.has(paneId),
  }
  return { log, run: (now) => reconcileTurns({ ...deps, now }) }
}

// 1. 안 받은 알림 — 2분 · 10분
writeNotice(ID, {})
let watch = make()
await watch.run(T0 + RESEND_MS - 1000)
check('2분 전에는 다시 넣지 않는다', watch.log.notify.length === 0 && !readNotice(ID).resent_at)
await watch.run(T0 + RESEND_MS)
check('2분이 지나면 같은 아테나 pane 에 한 번 다시 넣는다', watch.log.notify.length === 1 && watch.log.notify[0].lead === 'p1' && watch.log.notify[0].key === `lead-notice:${ID}:again`, JSON.stringify(watch.log.notify))
await watch.run(T0 + RESEND_MS + 30_000)
check('다시 넣기는 한 번뿐', watch.log.notify.length === 1)
await watch.run(T0 + REQUEST_MS)
check('10분이 지나도 안 받았으면 [작업] 요청을 연다', watch.log.opened.length === 1 && readNotice(ID).request === 'req-1')
await watch.run(T0 + REQUEST_MS + 60_000)
check('요청은 한 번만 연다', watch.log.opened.length === 1)
// 받음 → 요청 거두기
writeFileSync(join(noticeDir, `${ID}.json`), JSON.stringify({ ...readNotice(ID), received_at: (T0 + REQUEST_MS + 70_000) / 1000 }))
await watch.run(T0 + REQUEST_MS + 80_000)
check('받았으면 연 요청을 거둔다', watch.log.cancelled.length === 1 && watch.log.cancelled[0] === 'req-1' && readNotice(ID).request === 'existing')
await watch.run(T0 + REQUEST_MS + 90_000)
check('거둔 요청을 두 번 거두지 않는다', watch.log.cancelled.length === 1)
await watch.run(T0 + REQUEST_MS + 70_000 + 3600_000 + 1000)
check('받은 지 한 시간이 지난 기록은 지운다', !existsSync(join(noticeDir, `${ID}.json`)))

// 2. 이미 열린 요청 · 아테나 pane 닫힘 · 계획서 done
const ID2 = 'b'.repeat(32)
writeNotice(ID2, {})
watch = make({ openPanes: new Set(['p9']) })
await watch.run(T0 + REQUEST_MS)
check('그 에이전트 pane 에 이미 열린 요청이 있으면 새로 열지 않는다', watch.log.opened.length === 0 && readNotice(ID2).request === 'existing')
const ID3 = 'c'.repeat(32)
writeNotice(ID3, {})
watch = make({ panes: [{ id: 'p9' }] })
await watch.run(T0 + RESEND_MS)
check('아테나 pane 이 닫혔으면 다른 pane 으로 넣지 않는다', watch.log.notify.length === 0 && readNotice(ID3).resent_at)
await watch.run(T0 + REQUEST_MS)
check('아테나 pane 이 닫혀도 10분이면 요청은 연다', watch.log.opened.length === 1)
const ID4 = 'd'.repeat(32)
writeNotice(ID4, {})
watch = make({ plans: [{ id: 'plans/task/x.md', status: 'done', leadPane: 'p1', agents: ['p9'] }] })
await watch.run(T0 + REQUEST_MS)
check('계획서가 done 이면 다시 넣지도 요청을 열지도 않는다', watch.log.notify.length === 0 && watch.log.opened.length === 0)
for (const id of [ID2, ID3, ID4]) writeFileSync(join(noticeDir, `${id}.json`), JSON.stringify({ ...readNotice(id), received_at: T0 / 1000 }))

// 3. 선택 창 — 일하는 중에 뜬 창만 · 창 하나에 한 번 · 닫히면 그 알림을 더 밀지 않음
writeFileSync(join(turnDir, 'p9.json'), JSON.stringify({ state: 'working', agent: 'fe', turn: 't1', ts: T0 / 1000 }))
const menu = new Set(['p9'])
watch = make({ menu })
await watch.run(T0)
const menuNotices = () => readdirSync(noticeDir).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).map((name) => JSON.parse(readFileSync(join(noticeDir, name), 'utf8'))).filter((notice) => notice.kind === 'menu')
check('일하는 중 선택 창이 뜨면 아테나에 "선택 창" 한 줄', watch.log.notify.length === 1 && /^\[fe → 아테나\] 선택 창 · p9 · 계획서 plans\/task\/x\.md · Status in_progress$/.test(watch.log.notify[0].text), JSON.stringify(watch.log.notify))
await watch.run(T0 + 15_000)
check('같은 창에는 한 번만', watch.log.notify.length === 1 && menuNotices().length === 1)
menu.delete('p9')
await watch.run(T0 + 30_000)
check('창이 닫히면 그 알림은 닫힘 표시', Boolean(menuNotices()[0]?.closed_at))
await watch.run(T0 + REQUEST_MS + 30_000)
check('닫힌 선택 창 알림은 다시 넣지도 요청을 열지도 않는다', watch.log.notify.length === 1 && watch.log.opened.length === 0)
writeFileSync(join(turnDir, 'p9.json'), JSON.stringify({ state: 'done', agent: 'fe', turn: 't1', ts: T0 / 1000 }))
menu.add('p9')
await watch.run(T0 + REQUEST_MS + 45_000)
check('끝난 차례(done)의 창은 선택 창 알림을 따로 보내지 않는다(끝 알림이 갔다)', watch.log.notify.length === 1)
watch = make({ menu, plans: [{ id: 'plans/task/x.md', status: 'in_progress', leadPane: 'p1', agents: ['p1'] }] })
writeFileSync(join(turnDir, 'p1.json'), JSON.stringify({ state: 'working', ts: T0 / 1000 }))
menu.add('p1')
await watch.run(T0)
check('아테나 pane 자신의 창은 알리지 않는다', watch.log.notify.length === 0)

// 4. 닫힌 pane 의 오래된 차례 상태는 지운다 · 살아 있는 pane 은 둔다
writeFileSync(join(turnDir, 'p7.json'), JSON.stringify({ state: 'done', ts: T0 / 1000 }))
watch = make()
await watch.run(T0 + 25 * 3600_000)
check('닫힌 pane 의 하루 지난 차례 상태는 지운다', !existsSync(join(turnDir, 'p7.json')) && existsSync(join(turnDir, 'p9.json')))

// 5. lead-notice.mjs — 창이 떠 있으면 미뤘다가 flush · 같은 key 한 번
const sent = []
let busy = true
const notifier = createLeadNotifier({
  dir: join(work, 'queue'),
  pickPane: async () => 'p1',
  deliver: async (pane, notice) => { if (busy) return 'wait'; sent.push([pane, notice.text]); return 'sent' },
})
const first = await notifier.notify({ key: 'k1', mark: 'm1', text: '하나' })
check('창이 떠 있으면 미룬다(wait)', first.result === 'wait' && notifier.pendingNotices().length === 1)
const second = await notifier.notify({ key: 'k2', mark: 'm2', text: '둘' })
check('앞에 미룬 알림이 있으면 뒤에 줄 선다', second.result === 'wait' && notifier.pendingNotices().length === 2)
check('같은 key · mark 는 다시 넣지 않는다', (await notifier.notify({ key: 'k1', mark: 'm1', text: '하나' })).result === 'already')
await notifier.flush(() => {})
check('창이 아직이면 flush 도 기다린다', sent.length === 0)
busy = false
const flushed = []
await notifier.flush((notice, result) => flushed.push(result))
check('창이 닫히면 차례대로 넣는다', JSON.stringify(sent) === JSON.stringify([['p1', '하나'], ['p1', '둘']]) && flushed.join() === 'sent,sent' && notifier.pendingNotices().length === 0, JSON.stringify({ sent, flushed }))
process.exit(fail)
NODE
