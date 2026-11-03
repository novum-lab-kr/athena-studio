#!/usr/bin/env bash
# 현황판이 pane 에 지시를 넣는 순서 시험 — scripts/board/pane-delivery.mjs(질문 · 고르기 창이 떠 있으면 미뤘다가 닫히면 넣기).
# GitHub #100 재현 모양: 레포 고르기 콘솔 [이대로 진행] 을 누를 때 아테나 pane 에 AskUserQuestion 창이 떠 있으면
# 글은 창에 먹히고 Enter 가 1번 선택지를 골랐다. 가짜 화면 · 가짜 넣기로 — 화면 · claude 를 부르지 않는다 · 몇 초
#
# 사용: test/pane-delivery-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
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

const CODEX_QUESTION = 'Question 1/1 (1 unanswered)\nWhich do you choose?\n› 1. Alpha\n  2. Beta\ntab to add notes | enter to submit answer | esc to interrupt'
const CODEX_APPROVAL = 'Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. No\nPress enter to confirm or esc to cancel'
check('Codex 질문 창 → 떠 있음', menuOpen(CODEX_QUESTION))
check('Codex 허락 창 → 떠 있음', menuOpen(CODEX_APPROVAL))

check('질문 창(AskUserQuestion) → 떠 있음', menuOpen(ASKING))
check('권한 묻기 창 → 떠 있음', menuOpen(PERMISSION))
check('일하는 중(도구 실행) → 안 떠 있음 — 바로 넣는다(claude 가 받아 둔다)', !menuOpen(WORKING))
check('빈 입력칸 → 안 떠 있음', !menuOpen(IDLE))
check('못 읽음(null) → 안 떠 있음 — 지금처럼 바로', !menuOpen(null))
check('창 글이 위로 밀려 끝 12줄 밖이면 → 안 떠 있음', !menuOpen(ASKING + '\n' + Array.from({ length: 12 }, (_, index) => `줄 ${index}`).join('\n')))

check('Codex 작업 중 esc to interrupt만으로는 메뉴로 보지 않는다', !menuOpen('› 입력\nWorking (2s • esc to interrupt)'))

// sent — 전송 확인된 지시 · calls — 보내기 부른 기록(중복 입력 확인) · results — 다음 보내기 결과를 정한다('wait' · 실패 글)
// readDelay — 화면 읽기가 느린 척(겹침 재현). 보내기는 공통 전송 경로(lib/screen.mjs submitToPane) 모양
const fake = () => {
  const state = { screens: new Map(), sent: [], calls: [], panes: new Set(['p1', 'p2']), results: [], readDelay: 0 }
  const delivery = createDelivery({
    readPane: async (paneId) => {
      if (state.readDelay) await new Promise((resolve) => setTimeout(resolve, state.readDelay))
      return state.screens.get(paneId) ?? null
    },
    send: async (paneId, text) => {
      state.calls.push([paneId, text])
      const result = state.results.shift() ?? 'sent'
      if (result === 'sent') state.sent.push([paneId, text])
      return result
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
  state.results.push('wait')
  await delivery.tick()
  check('미룬 지시를 데몬이 쓰기 전에 거절하면(wait) 남겨 두고', delivery.pending('p1') === 1 && state.sent.length === 0)
  await delivery.tick()
  check('다음 차례에 다시 넣는다', delivery.pending('p1') === 0 && same(state.sent, [['p1', '미룸']]))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', IDLE)
  state.results.push('입력 전송을 확인하지 못했다')
  const result = await delivery.submit('p1', '바로')
  check('바로 넣다 실패하면 오류로 돌려주고 남기지 않는다(콘솔이 복사로 바뀐다)', result === '입력 전송을 확인하지 못했다' && delivery.pending('p1') === 0, String(result))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', IDLE)
  state.results.push('wait')
  const result = await delivery.submit('p1', '거절됨')
  check('바로 넣다 데몬이 쓰기 전에 거절하면(wait) 미룬다', result === 'queued' && delivery.pending('p1') === 1 && state.sent.length === 0, String(result))
  await delivery.tick()
  check('다음 차례에 한 번 넣는다', delivery.pending('p1') === 0 && same(state.sent, [['p1', '거절됨']]) && state.calls.length === 2, JSON.stringify(state.calls))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', ASKING)
  await delivery.submit('p1', '미룸')
  await delivery.submit('p1', '뒤')
  state.screens.set('p1', IDLE)
  state.results.push('입력 전송을 확인하지 못했다')
  await delivery.tick()
  check('미룬 지시가 확인 못 함으로 실패하면 다시 보내지 않는다(글이 들어갔을 수 있다) · 뒤 지시는 다음 차례에', delivery.pending('p1') === 1 && state.sent.length === 0 && state.calls.length === 1, JSON.stringify(state.calls))
  await delivery.tick()
  check('다음 차례에 뒤 지시만', same(state.sent, [['p1', '뒤']]) && delivery.pending('p1') === 0, JSON.stringify(state.calls))
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
  check('비어 있는 pane 에 겹쳐 온 두 지시 + tick — 차례대로 한 번씩', same(results.slice(0, 2), ['sent', 'sent']) && same(state.sent, [['p1', '첫째'], ['p1', '둘째']]) && state.calls.length === 2, JSON.stringify(state.sent))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', ASKING)
  await delivery.submit('p1', '미룸')
  state.screens.set('p1', IDLE)
  await Promise.all([delivery.tick(), delivery.tick()])
  check('겹쳐 불려도 한 번만 넣는다', same(state.sent, [['p1', '미룸']]), JSON.stringify(state.sent))
}
{
  const { state, delivery } = fake()
  state.screens.set('p1', CODEX_QUESTION)
  check('Codex 질문 중 답은 대기열에 남고 선택지를 누르지 않는다', await delivery.submit('p1', '답: Beta') === 'queued' && state.sent.length === 0 && state.calls.length === 0)
  state.screens.set('p1', IDLE)
  await delivery.tick()
  check('Codex 질문 닫힘 뒤 답 한 번 전달', same(state.sent, [['p1', '답: Beta']]) && delivery.pending('p1') === 0)
}
process.exit(fail)
NODE
