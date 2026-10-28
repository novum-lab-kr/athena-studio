#!/usr/bin/env bash
# 현황판이 pane 에 지시를 넣는 순서 시험 — scripts/board/pane-delivery.mjs(질문 · 고르기 창이 떠 있으면 미뤘다가 닫히면 넣기).
# GitHub #100 재현 모양: 레포 고르기 콘솔 [이대로 진행] 을 누를 때 아테나 pane 에 AskUserQuestion 창이 떠 있으면
# 글은 창에 먹히고 Enter 가 1번 선택지를 골랐다. 가짜 화면 · 가짜 넣기로 — 화면 · claude 를 부르지 않는다 · 몇 초
#
# 사용: test/pane-delivery-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1

node --input-type=module - "$SRC/scripts/board/pane-delivery.mjs" <<'NODE'
const [modPath] = process.argv.slice(2)
const { createDelivery, menuOpen } = await import(modPath)
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

// 2026-10-28 claude 2.1.312 화면에서 옮긴 모양
const ASKING = ['❯ Use the AskUserQuestion tool …', '────', ' ☐ Company ', 'Company name?', '❯ 1. acme', '  2. globex', '  3. Type something.', '────', '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n')
const WORKING = ['❯ Run sleep 25', '⏺ Running 1 shell command…', '  ⎿  $ sleep 25', '✻ Slithering… (2s · ↓ 88 tokens · thinking)', '────', '❯ ', '────', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n')
const PERMISSION = ['⏺ Bash(rm -rf build)', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n')
const IDLE = ['⏺ 끝났어요', '────', '❯ ', '────', '  ⏵⏵ auto mode on'].join('\n')

check('질문 창(AskUserQuestion) → 떠 있음', menuOpen(ASKING))
check('권한 묻기 창 → 떠 있음', menuOpen(PERMISSION))
check('일하는 중(도구 실행) → 안 떠 있음 — 바로 넣는다(claude 가 받아 둔다)', !menuOpen(WORKING))
check('빈 입력칸 → 안 떠 있음', !menuOpen(IDLE))
check('못 읽음(null) → 안 떠 있음 — 지금처럼 바로', !menuOpen(null))
check('창 글이 위로 밀려 끝 12줄 밖이면 → 안 떠 있음', !menuOpen(ASKING + '\n' + Array.from({ length: 12 }, (_, index) => `줄 ${index}`).join('\n')))

// sent — 끝까지 넣은 지시(글 + Enter) · typed — 글 쓰기 기록(중복 입력 확인) · readDelay — 화면 읽기가 느린 척(겹침 재현)
const fake = () => {
  const state = { screens: new Map(), sent: [], typed: [], panes: new Set(['p1', 'p2']), failType: 0, failEnter: 0, readDelay: 0, box: new Map() }
  const delivery = createDelivery({
    readPane: async (paneId) => {
      if (state.readDelay) await new Promise((resolve) => setTimeout(resolve, state.readDelay))
      return state.screens.get(paneId) ?? null
    },
    typeText: async (paneId, text) => {
      if (state.failType) { state.failType -= 1; return '보내지 못했어요' }
      state.typed.push([paneId, text])
      state.box.set(paneId, text)
      return null
    },
    pressEnter: async (paneId) => {
      if (state.failEnter) { state.failEnter -= 1; return 'Enter 를 보내지 못했어요' }
      state.sent.push([paneId, state.box.get(paneId)])
      state.box.delete(paneId)
      return null
    },
    paneExists: (paneId) => state.panes.has(paneId),
  })
  return { state, delivery }
}

{
  const { state, delivery } = fake()
  state.screens.set('p1', WORKING)
  check('일하는 중이면 바로 넣는다', (await delivery.submit('p1', '1. 넣을 레포: a, b')) === 'sent' && same(state.sent, [['p1', '1. 넣을 레포: a, b']]))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', ASKING)
  const result = await delivery.submit('p1', '1. 넣을 레포: a, b')
  check('#100 — 질문 창이 떠 있으면 넣지 않고 미룬다', result === 'queued' && state.sent.length === 0 && delivery.pending('p1') === 1, JSON.stringify({ result, sent: state.sent }))
  await delivery.tick()
  check('창이 그대로면 계속 기다린다', state.sent.length === 0 && delivery.pending('p1') === 1)
  check('뒤에 온 지시도 그 뒤에 줄 선다(차례 유지)', (await delivery.submit('p1', '두 번째')) === 'queued' && delivery.pending('p1') === 2)
  state.screens.set('p1', WORKING)
  await delivery.tick()
  check('창이 닫히면 들어온 차례대로 넣는다', same(state.sent, [['p1', '1. 넣을 레포: a, b'], ['p1', '두 번째']]) && delivery.pending('p1') === 0, JSON.stringify(state.sent))
  check('다 넣은 뒤 새 지시는 다시 바로', (await delivery.submit('p1', '세 번째')) === 'sent')
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', ASKING)
  state.screens.set('p2', WORKING)
  await delivery.submit('p1', '미룸')
  check('다른 pane 은 막히지 않는다', (await delivery.submit('p2', '바로')) === 'sent' && same(state.sent, [['p2', '바로']]))
  state.panes.delete('p1')
  await delivery.tick()
  check('미룬 pane 이 닫히면 버린다', delivery.pending('p1') === 0 && state.sent.length === 1)
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', ASKING)
  await delivery.submit('p1', '미룸')
  state.screens.set('p1', IDLE)
  state.failType = 1
  await delivery.tick()
  check('미룬 글 쓰기가 실패하면 남겨 두고', delivery.pending('p1') === 1 && state.sent.length === 0)
  await delivery.tick()
  check('다음 차례에 다시 넣는다', delivery.pending('p1') === 0 && same(state.sent, [['p1', '미룸']]))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', IDLE)
  state.failType = 1
  const result = await delivery.submit('p1', '바로')
  check('바로 넣다 글 쓰기가 실패하면 오류로 돌려주고 남기지 않는다(콘솔이 복사로 바뀐다)', result === '보내지 못했어요' && delivery.pending('p1') === 0, String(result))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', IDLE)
  state.failEnter = 1
  const result = await delivery.submit('p1', '글은 들어감')
  check('Enter 만 실패하면 전달 완료로 치지 않는다(미룸)', result === 'queued' && delivery.pending('p1') === 1 && state.sent.length === 0, String(result))
  await delivery.tick()
  check('다음 차례에 Enter 부터 — 글을 두 번 쓰지 않는다', delivery.pending('p1') === 0 && same(state.sent, [['p1', '글은 들어감']]) && state.typed.length === 1, JSON.stringify(state.typed))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', ASKING)
  state.readDelay = 30
  const results = await Promise.all([delivery.submit('p1', '첫째'), delivery.submit('p1', '둘째')])
  check('창이 뜬 pane 에 겹쳐 온 두 지시 — 둘 다 미뤄지고 덮이지 않는다', same(results, ['queued', 'queued']) && delivery.pending('p1') === 2, JSON.stringify(results))
  state.screens.set('p1', IDLE)
  await delivery.tick()
  check('창이 닫히면 둘 다 들어온 차례대로', same(state.sent, [['p1', '첫째'], ['p1', '둘째']]), JSON.stringify(state.sent))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', IDLE)
  state.readDelay = 30
  const results = await Promise.all([delivery.submit('p1', '첫째'), delivery.submit('p1', '둘째'), delivery.tick()])
  check('비어 있는 pane 에 겹쳐 온 두 지시 + tick — 차례대로 한 번씩', same(results.slice(0, 2), ['sent', 'sent']) && same(state.sent, [['p1', '첫째'], ['p1', '둘째']]) && state.typed.length === 2, JSON.stringify(state.sent))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', ASKING)
  await delivery.submit('p1', '미룸')
  state.screens.set('p1', IDLE)
  await Promise.all([delivery.tick(), delivery.tick()])
  check('겹쳐 불려도 한 번만 넣는다', same(state.sent, [['p1', '미룸']]), JSON.stringify(state.sent))
}
process.exit(fail)
NODE
