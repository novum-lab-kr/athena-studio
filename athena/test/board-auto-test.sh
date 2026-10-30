#!/usr/bin/env bash
# 현황판 자동 완료 · 자동 보관 판정 시험 — scripts/board/plan-bind.mjs(남은 단계 · 묶인 pane)를 server.mjs 와 같은 입력 모양으로.
# 2026-10-27 사고 재현: 단계 PR 하나가 머지된 틈에 진행 중 계획서가 완료 · 보관됐다(남은 단계를 안 봄 · 같은 계획서로 다시 띄워
# Work ref 가 마지막 pane 으로 바뀌어 일하던 다른 pane 을 못 봄). 임시 폴더 · gh · 화면을 부르지 않는다 · 몇 초
#
# 사용: test/board-auto-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-board-auto-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT

# pane 기록(scripts/hooks/pane-session.py 가 쓰는 모양) — 같은 계획서로 두 번 띄운 fe pane 둘 · 다른 계획서 · 집 초기화 뒤 남은 옛 기록 · 깨진 것
PLAN='plans/refactor/20261027-단계-작업.md'
mkdir -p "$TMP/pane-sessions"
rec() { printf '{ "pane": "%s", "session": "00000000-0000-0000-0000-00000000000%s", "cwd": "/x", "agent": "%s", "plan": %s, "at": "2026-10-27T13:00:00+00:00" }\n' "$1" "$2" "$3" "$4" > "$TMP/pane-sessions/$1.json"; }
rec p130 1 fe "\"$PLAN\""
rec p132 2 fe "\"$PLAN\""
rec p140 3 fe '"plans/task/다른-일.md"'
rec p150 4 be "\"$PLAN\""
rec p160 5 athena null
printf '{ broken' > "$TMP/pane-sessions/p170.json"
printf '{ "pane": "p180", "agent": "fe", "plan": "%s" }' "$PLAN" > "$TMP/pane-sessions/.p180.123.tmp"

node --input-type=module - "$SRC/scripts/board/plan-bind.mjs" "$TMP/pane-sessions" "$PLAN" <<'EOF'
const [modPath, sessionsDir, planId] = process.argv.slice(2)
import { readFileSync } from 'node:fs'
const { TEMPLATE_PLACEHOLDER_LINES, autoDoneDone, boundPaneIds, checkpointOf, hasOpenSteps, progressOf, readPaneSessions } = await import(modPath)
const PROTECTED = /^(prd|main|master|dev|dev-ecs|prd-.+|release\/.+)$/
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const sessions = readPaneSessions(sessionsDir)
check('pane 기록 — 계획서가 적힌 것만 · 깨진 파일 · 쓰는 중(.tmp) 건너뜀', same(sessions.map((record) => record.pane).sort(), ['p130', 'p132', 'p140', 'p150']), JSON.stringify(sessions))
check('pane 기록 폴더가 없으면 빈 목록', same(readPaneSessions(`${sessionsDir}/없음`), []))

// ── 이슈 frontmatter 값 — 따옴표로 감싼 값은 `#` 를 지키고 감싸지 않은 값은 공백 뒤 `#…` 를 주석으로 자름 ──
const { frontValue } = await import(modPath.replace('board/plan-bind.mjs', 'lib/front-value.mjs'))
check('frontValue — 감싸지 않은 값은 공백 뒤 # 부터 주석(지금처럼)', frontValue('열림 # 메모') === '열림' && frontValue('로그인 #12 안 됨') === '로그인', frontValue('로그인 #12 안 됨'))
check('frontValue — 따옴표로 감싸면 # 가 제목에 남음', frontValue('"#12 로그인 안 됨"') === '#12 로그인 안 됨' && frontValue("'로그인 #12 안 됨'") === '로그인 #12 안 됨' && frontValue('"로그인 #12" # 메모') === '로그인 #12')
check('frontValue — 따옴표가 짝이 아니면 감싼 값이 아님 · 빈 값', frontValue('"로그인 #12') === '"로그인' && frontValue('') === '')
// ── 자동 완료가 같은 PR 묶음으로 다시 덮지 않음(7b8d4f) ──
const doneText = '## Checkpoint\n- Status: in_progress\n- Work ref: x\n- Auto done: merged-12\n'
check('autoDoneDone — 같은 PR 묶음 표시가 있으면 이미 끝낸 것(되돌린 in_progress 를 덮지 않음)', autoDoneDone(doneText, 'merged-12') === true)
check('autoDoneDone — 새 PR 이 들어와 표시가 다르면 다시 끝낼 수 있음 · 표시 없는 계획서는 그대로 대상', autoDoneDone(doneText, 'merged-12-15') === false && autoDoneDone('- Status: in_progress\n', 'merged-12') === false)
check('autoDoneDone — Learn review 줄의 같은 표시도 인정', autoDoneDone('- Learn review: 2026-10-30 merged-7 · 1건\n', 'merged-7') === true)
check('autoDoneDone — 번호가 접두사로 겹쳐도 정확히 같은 묶음만(merged-123 ≠ merged-12 · merged-12-15 ≠ merged-12)', autoDoneDone('- Auto done: merged-123\n', 'merged-12') === false && autoDoneDone('- Auto done: merged-12-15\n', 'merged-12') === false && autoDoneDone('- Learn review: x merged-12-15 · 1건\n', 'merged-12-15') === true)
// ── Checkpoint 절 끝 ──
const fence = '`'.repeat(3)
const plainPlan = '# t\n\n## Checkpoint\n- Status: in_progress\n\n### Validation\n- ok\n\n## 지시\n본문\n'
check('Checkpoint — 다음 `## ` 제목에서 끝남', checkpointOf(plainPlan).includes('- ok') && !checkpointOf(plainPlan).includes('본문'), JSON.stringify(checkpointOf(plainPlan)))
const fencedPlan = `# t\n\n## Checkpoint\n- Status: in_progress\n\n### Validation\n${fence}\n## 검증 결과\n통과\n${fence}\n- 뒤쪽 줄\n\n## 지시\n본문\n`
check('Checkpoint — 울타리 안의 `## ` 줄은 절을 끊지 않음(Validation 에 붙인 출력)', checkpointOf(fencedPlan).includes('통과') && checkpointOf(fencedPlan).includes('- 뒤쪽 줄') && !checkpointOf(fencedPlan).includes('본문'), JSON.stringify(checkpointOf(fencedPlan)))
const long = '`'.repeat(4)
const longPlan = `# t\n\n## Checkpoint\n- Status: in_progress\n${long}md\n${fence}\n## 안쪽 제목\n${fence}\n${long}\n- 뒤쪽 줄\n\n## 지시\n본문\n`
check('Checkpoint — 백틱 4개 펜스 안의 백틱 3개는 닫힘이 아님', checkpointOf(longPlan).includes('## 안쪽 제목') && checkpointOf(longPlan).includes('- 뒤쪽 줄') && !checkpointOf(longPlan).includes('본문'), JSON.stringify(checkpointOf(longPlan)))
const tildePlan = '# t\n\n## Checkpoint\n- Status: in_progress\n~~~\n## 틸드 안\n```\n~~~\n- 뒤쪽 줄\n\n## 지시\n본문\n'
check('Checkpoint — 틸드 펜스 안의 `## ` 도 절을 끊지 않음(다른 문자 펜스는 닫힘이 아님)', checkpointOf(tildePlan).includes('## 틸드 안') && checkpointOf(tildePlan).includes('- 뒤쪽 줄') && !checkpointOf(tildePlan).includes('본문'), JSON.stringify(checkpointOf(tildePlan)))
check('Checkpoint — 절이 없으면 빈 글', checkpointOf('# t\n\n## 지시\n') === '')

// ── 남은 단계 ──
const stepsLeft = progressOf('- [x] 1단계 규칙\n- [ ] 2단계 전환\n  - [x] PR1\n  - [ ] PR-R1\n- [ ] 3단계')
check('사고 계획서 모양(맨 앞 칸 1/3) → 남은 단계 있음 → 자동 완료 보류', hasOpenSteps(stepsLeft) && stepsLeft?.checked === 1 && stepsLeft?.total === 3, JSON.stringify(stepsLeft))
// 2026-10-29 배포판 계획서 사고 — 맨 앞 칸은 다 [x] 인데 3단계 · 5단계 하위 칸이 비어 있는 채로 PR 머지 뒤 완료 · 보관됐다
const subLeft = progressOf('- [x] 1단계\n- [x] 3단계 서명\n  - [x] 인증서\n  - [ ] 공증\n- [x] 5단계 다운로드\n    - [ ] 페이지 링크')
check('맨 앞 칸 다 채움 + 하위 칸 빔(들여쓰기 깊이 무관) → 남은 단계 있음 → 자동 완료 보류', hasOpenSteps(subLeft), JSON.stringify(subLeft))
check('진행 숫자는 맨 앞 칸 기준 그대로(3/3)', subLeft?.checked === 3 && subLeft?.total === 3, JSON.stringify(subLeft))
check('하위 칸까지 다 채움 → 남은 단계 없음 → 자동 완료', !hasOpenSteps(progressOf('- [x] 구현\n  - [x] 덤\n\t- [X] 탭 하위\n- [X] 검증')))
const onlySub = progressOf('  - [ ] 남은 작업\n  - [x] 끝난 작업')
check('들여 쓴 칸만 있고 빈 칸이 있음(맨 앞 칸 없음) → 남은 단계 있음 → 자동 완료 보류', hasOpenSteps(onlySub) && onlySub?.total === 0 && onlySub?.open === 1, JSON.stringify(onlySub))
check('들여 쓴 칸만 있고 다 채움 → null(지금처럼 남은 단계 없음)', progressOf('  - [x] 끝난 작업') === null)
check('칸이 하나도 없음 → 남은 단계 없음(지금처럼)', !hasOpenSteps(progressOf('- 구현 끝\n- 검증 끝')) && progressOf('') === null)

// 2026-10-29 — 고치지 않은 템플릿 자리 줄이 남은 단계로 세져 PR 이 다 머지돼도 자동 완료가 안 됐다
const templateText = readFileSync(modPath.replace(/scripts\/board\/plan-bind\.mjs$/, 'docs/plan-template-light.md'), 'utf8')
check('템플릿 자리 줄이 docs/plan-template-light.md 에 글자 그대로 있다(템플릿을 바꾸면 TEMPLATE_PLACEHOLDER_LINES 도)', TEMPLATE_PLACEHOLDER_LINES.length === 3 && TEMPLATE_PLACEHOLDER_LINES.every((line) => templateText.split('\n').includes(line)))
const [placeholderWork, placeholderVerify, placeholderBasis] = TEMPLATE_PLACEHOLDER_LINES
const untouched = progressOf(`- [x] 담당 레포 브랜치·미커밋 상태 확인\n${placeholderWork}\n${placeholderVerify}\n${placeholderBasis}`)
check('고치지 않은 자리 줄 3개만 남음 → 남은 단계 없음 → 자동 완료', !hasOpenSteps(untouched) && untouched?.checked === 1 && untouched?.total === 1 && untouched?.open === 0, JSON.stringify(untouched))
check('자리 줄만 있으면 칸이 없는 것과 같다(null)', progressOf(`${placeholderWork}\n${placeholderVerify}`) === null)
check('자리 줄 말고 진짜 빈 칸이 있으면 그대로 남은 단계', hasOpenSteps(progressOf(`- [x] 구현\n- [ ] 머지 뒤 앱 화면 확인\n${placeholderWork}`)))
check('자리 줄을 한 글자라도 고쳤으면 보통 칸(빈 칸이면 남은 단계)', hasOpenSteps(progressOf(`- [x] 구현\n${placeholderWork.replace('(작업)', '로그인 고치기')}`)))

// ── 묶인 pane ── 사고 때 Work ref 는 마지막으로 띄운 p132(닫힘)만 · 일하던 p130 은 다른 브랜치
const plan = { id: planId, workRefs: '/w/feat-b · 🌿 feat/b · pane p132 (fe)', review: '' }
const live = [
  { id: 'p130', role: 'agent', agent: 'fe', branch: 'feat/a', status: 'working' },
  { id: 'p140', role: 'agent', agent: 'fe', branch: 'feat/c' },
  { id: 'p150', role: 'agent', agent: 'fe', branch: 'feat/d' },
  { id: 'p91', role: 'hermes', agent: '아테나', branch: '' },
]
check('옛 판정(계획서 줄만) → 일하던 p130 을 못 봄 = 사고 원인', same(boundPaneIds(plan, live, [], PROTECTED), []))
check('pane 기록까지 → p130 이 묶임 → 자동 보관 안 함', same(boundPaneIds(plan, live, sessions, PROTECTED), ['p130']))
check('다른 계획서 기록(p140) · 기록의 에이전트가 지금 pane 과 다름(p150 — 집 초기화 뒤 같은 id) → 안 묶임', !boundPaneIds(plan, live, sessions, PROTECTED).some((id) => id === 'p140' || id === 'p150'))
check('다 끝남 · pane 다 닫힘 → 묶인 pane 없음 → 지금처럼 보관', same(boundPaneIds(plan, [live[3]], sessions, PROTECTED), []))
check('계획서 줄은 그대로 — Work ref pane · 브랜치 · Review pane', same(boundPaneIds(
  { id: 'plans/task/x.md', workRefs: '/w · 🌿 feat/x · pane p1 (fe)\n/w2 · 🌿 feat/y · pane p9 (be)', review: '/w · 🌿 feat/x · pane p3 (reviewer) · 띄움 2026-10-27 10:00' },
  [{ id: 'p1', role: 'agent', agent: 'fe', branch: 'z' }, { id: 'p2', role: 'agent', agent: 'be', branch: 'feat/y' }, { id: 'p3', role: 'agent', agent: 'reviewer', branch: 'feat/x' }, { id: 'p4', role: 'agent', agent: 'fe', branch: 'feat/y-2' }],
  [], PROTECTED), ['p1', 'p2', 'p3']))
check('36진수 pane id(p6f · 2026-10-28) — Work ref · Review 줄로 묶이고 p6 · p6fa 같은 앞뒤 id 는 안 묶임', same(boundPaneIds(
  { id: 'plans/task/b36.md', workRefs: '/w · 🌿 feat/q · pane p6f (fe)', review: '/w · 🌿 feat/q · pane p7a (reviewer) · 띄움 2026-10-28 10:00' },
  [{ id: 'p6f', role: 'agent', agent: 'fe', branch: 'z' }, { id: 'p7a', role: 'agent', agent: 'reviewer', branch: 'z' }, { id: 'p6', role: 'agent', agent: 'fe', branch: 'z' }, { id: 'p6fa', role: 'agent', agent: 'fe', branch: 'z' }],
  [], PROTECTED), ['p6f', 'p7a']))
check('보호 브랜치(main)는 브랜치로 묶지 않음', same(boundPaneIds({ id: 'a', workRefs: 'athena 메인 체크아웃 · 🌿 main', review: '' }, [{ id: 'p5', role: 'agent', agent: 'fe', branch: 'main' }], [], PROTECTED), []))

console.log()
console.log(fail ? 'board-auto-test: 실패 있음' : 'board-auto-test: 모두 통과')
process.exit(fail)
EOF
