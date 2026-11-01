#!/usr/bin/env bash
# 현황판 자동 완료 · 자동 보관 판정 시험 — scripts/board/plan-bind.mjs(남은 단계 · 묶인 pane)를 server.mjs 와 같은 입력 모양으로.
# 2026-10-27 사고 재현: 단계 PR 하나가 머지된 틈에 진행 중 계획서가 완료 · 보관됐다(남은 단계를 안 봄 · 같은 계획서로 다시 띄워
# Work ref 가 마지막 pane 으로 바뀌어 일하던 다른 pane 을 못 봄). 임시 폴더 · gh · 화면을 부르지 않는다 · 몇 초
#
# 사용: test/board-auto-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
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
const { TEMPLATE_PLACEHOLDER_LINES, autoDoneDone, autoDoneMark, autoReopenedFor, clearReopened, needsAutoReopen, reopenLines, boundPaneIds, checkpointOf, followUpDue, followUpIssue, hasOpenSteps, nextPaneWatch, PANE_CLOSED_ISSUE_MS, progressOf, readPaneSessions } = await import(modPath)
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

// ── 남은 단계 — 단계 칸만 자동 완료를 막는다(2026-11-01) ──
const stageTop = progressOf('- [x] 1단계 규칙\n- [ ] 2단계 전환\n  - [x] PR1\n  - [ ] PR-R1\n- [ ] 3단계')
check('맨 앞 단계 칸이 비어 있음 → 자동 완료 보류 · 단계 칸만 셈(하위 칸은 일반)', hasOpenSteps(stageTop) && stageTop?.checked === 1 && stageTop?.total === 3 && stageTop?.steps === 2 && stageTop?.open === 3, JSON.stringify(stageTop))
check('들여 쓴 단계 칸 → 자동 완료 보류', hasOpenSteps(progressOf('- [x] 구현\n  - [ ] 2단계 전환')))
check('(단계) 표시 → 맨 앞 칸 · 들여 쓴 칸 모두 보류', hasOpenSteps(progressOf('- [ ] 결제 옮기기 (단계)')) && hasOpenSteps(progressOf('- [x] a\n    - [ ] 결제 옮기기 (단계)')))
check('꾸민 단계 칸(**2단계**)도 단계 칸', hasOpenSteps(progressOf('- [ ] **2단계** 전환')))
const stageDoneSub = progressOf('- [x] 1단계\n- [x] 3단계 서명\n  - [x] 인증서\n  - [ ] 공증\n- [x] 5단계 다운로드\n    - [ ] 페이지 링크')
check('단계 칸은 다 채움 + 그 아래 하위 칸만 빔 → 일반 칸 → 자동 완료 · 빈 칸 수는 알림용으로 남음', !hasOpenSteps(stageDoneSub) && stageDoneSub?.open === 2 && stageDoneSub?.checked === 3 && stageDoneSub?.total === 3, JSON.stringify(stageDoneSub))
const plainLeft = progressOf('- [x] 구현\n- [ ] 머지 뒤 앱 화면 확인')
check('일반 빈 칸만 있음 → 자동 완료 · 남은 칸 1개', !hasOpenSteps(plainLeft) && plainLeft?.open === 1, JSON.stringify(plainLeft))
check('문구 가운데의 단계 · 채운 단계 칸은 막지 않음', !hasOpenSteps(progressOf('- [ ] 다음 2단계 확인\n- [x] 3단계 끝')))
check('칸을 다 채움 → 자동 완료', !hasOpenSteps(progressOf('- [x] 구현\n  - [x] 덤\n\t- [X] 탭 하위\n- [X] 검증')))
const onlySub = progressOf('  - [ ] 남은 작업\n  - [x] 끝난 작업')
check('들여 쓴 일반 빈 칸만 있음 → 자동 완료 · 칸 수는 셈', !hasOpenSteps(onlySub) && onlySub?.total === 0 && onlySub?.open === 1, JSON.stringify(onlySub))
check('들여 쓴 칸만 있고 다 채움 → null', progressOf('  - [x] 끝난 작업') === null)
check('칸이 하나도 없음 → 남은 단계 없음', !hasOpenSteps(progressOf('- 구현 끝\n- 검증 끝')) && progressOf('') === null)

// 2026-10-29 — 고치지 않은 템플릿 자리 줄이 남은 단계로 세져 PR 이 다 머지돼도 자동 완료가 안 됐다
const templateText = readFileSync(modPath.replace(/scripts\/board\/plan-bind\.mjs$/, 'docs/plan-template-light.md'), 'utf8')
const templateOpenLines = templateText.split('\n').filter((line) => /^- \[ \] /.test(line))
check('템플릿 자리 줄이 docs/plan-template-light.md 에 글자 그대로 있다(템플릿을 바꾸면 TEMPLATE_PLACEHOLDER_LINES 도)', TEMPLATE_PLACEHOLDER_LINES.every((line) => templateOpenLines.includes(line)))
check('템플릿의 빈 칸 줄(`- [ ]`)이 하나도 빠짐없이 TEMPLATE_PLACEHOLDER_LINES 에 있다(2026-11-01 — 첫 줄 누락 재발 방지)', templateOpenLines.length > 0 && templateOpenLines.every((line) => TEMPLATE_PLACEHOLDER_LINES.includes(line)) && TEMPLATE_PLACEHOLDER_LINES.length === templateOpenLines.length, JSON.stringify(templateOpenLines.filter((line) => !TEMPLATE_PLACEHOLDER_LINES.includes(line))))
const [placeholderBranch, placeholderWork, placeholderVerify, placeholderBasis] = TEMPLATE_PLACEHOLDER_LINES
const untouched = progressOf(`- [x] 구현\n${placeholderBranch}\n${placeholderWork}\n${placeholderVerify}\n${placeholderBasis}`)
check('고치지 않은 자리 줄 4개만 남음 → 남은 단계 없음 → 자동 완료 · 알림 칸도 0', !hasOpenSteps(untouched) && untouched?.checked === 1 && untouched?.total === 1 && untouched?.open === 0, JSON.stringify(untouched))
check('자리 줄만 있으면 칸이 없는 것과 같다(null)', progressOf(`${placeholderWork}\n${placeholderVerify}`) === null)
check('자리 줄 말고 일반 빈 칸이 있으면 그것만 알림 칸으로 셈', progressOf(`- [x] 구현\n- [ ] 머지 뒤 앱 화면 확인\n${placeholderWork}`)?.open === 1)
check('자리 줄을 한 글자라도 고쳤으면 보통 칸(빈 칸이면 셈)', progressOf(`- [x] 구현\n${placeholderWork.replace('(작업)', '로그인 고치기')}`)?.open === 1)

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

// ── 묶인 pane 이 닫힌 계획서 → 이어 갈 이슈(2026-11-01) ──
const HOUR = PANE_CLOSED_ISSUE_MS
const watchPlan = (agents, status = 'in_progress') => ({ id: 'plans/task/x.md', status, agents })
const opened = nextPaneWatch({}, [watchPlan(['p1'])], 1000)
check('pane 열림 → 닫힌 시각 없음 · 기록 바뀜', same(opened.watch['plans/task/x.md'], { closedAt: null }) && opened.changed)
check('pane 을 본 적 없는 계획서 → 기록 없음(옛 계획서가 한꺼번에 이슈가 되지 않음)', same(nextPaneWatch({}, [watchPlan([])], 1000).watch, {}))
const closed = nextPaneWatch(opened.watch, [watchPlan([])], 5000)
check('pane 닫힘 → 처음 본 시각을 적고 다음 수집은 그대로 · 파일 안 씀', closed.watch['plans/task/x.md'].closedAt === 5000 && closed.changed && !nextPaneWatch(closed.watch, [watchPlan([])], 9000).changed && nextPaneWatch(closed.watch, [watchPlan([])], 9000).watch['plans/task/x.md'].closedAt === 5000)
check('다시 열림 → 닫힌 시각 지움', nextPaneWatch(closed.watch, [watchPlan(['p2'])], 9000).watch['plans/task/x.md'].closedAt === null)
check('done · 없어진 계획서 → 기록에서 뺌', same(nextPaneWatch(closed.watch, [watchPlan([], 'done')], 9000).watch, {}) && same(nextPaneWatch(closed.watch, [], 9000).watch, {}))
const entry = { closedAt: 1000 }
const clear = { hasRequest: false, hasIssue: false }
check('닫힌 지 1시간 전 → 이슈 안 만듦', !followUpDue(entry, 1000 + HOUR - 1, clear))
check('닫힌 지 1시간 → 이슈 만듦', followUpDue(entry, 1000 + HOUR, clear))
check('pane 열림(closedAt 없음) · 기록 없음 → 안 만듦', !followUpDue({ closedAt: null }, 1000 + HOUR, clear) && !followUpDue(undefined, 1000 + HOUR, clear))
check('열린 요청 있음 → 안 만듦', !followUpDue(entry, 1000 + HOUR, { hasRequest: true, hasIssue: false }))
check('이미 연결 이슈 있음 → 안 만듦', !followUpDue(entry, 1000 + HOUR, { hasRequest: false, hasIssue: true }))
const made = followUpIssue({ id: 'plans/task/20261101-fe-결제-learn-고치기.md', title: '결제 #12 고치기' }, 'my-web', '2026-11-01')
check('이슈 파일 — 이름 · open · plan · 레포 · 제목(공백 뒤 # 없음) · 학습 후보로 읽히지 않음', made.name === '20261101-my-web-fe-결제-learn_고치기.md' && /^status: open$/m.test(made.text) && /^plan: plans\/task\/20261101-fe-결제-learn-고치기\.md$/m.test(made.text) && /^repo: my-web$/m.test(made.text) && /^title: 결제 12 고치기$/m.test(made.text), made.name + made.text)

// ── 자동 완료 되돌리기 — 자동 완료한 계획서에 단계 칸이 새로 생기면 진행 중으로(2026-11-01) ──
const autoText = '## Checkpoint\n- Status: done — 자동 — PR #7 이 main 에 머지됨\n- Work ref: x\n- Auto done: merged-7\n- Learn review: 2026-11-01 merged-7 · 0건\n\n### Progress\n- [x] a\n'
const openProgress = progressOf('- [x] a\n- [ ] 2단계 추가 요청')
const fullProgress = progressOf('- [x] a\n- [x] 추가 요청')
check('되돌리기 — 자동 완료(Auto done 줄) + 단계 칸이 새로 생김 → 대상', needsAutoReopen(autoText, 'done', false, openProgress) === true)
check('되돌리기 — 들여 쓴 단계 칸도 대상 · 일반 빈 칸은 대상 아님(남기고 완료한 칸에 왕복하지 않게)', needsAutoReopen(autoText, 'done', false, progressOf('- [x] a\n  - [ ] 하위 (단계)')) === true && needsAutoReopen(autoText, 'done', false, progressOf('- [x] a\n- [ ] 일반 칸\n  - [ ] 하위')) === false)
check('되돌리기 — 칸이 다 차 있으면 대상 아님 · 칸이 없어도 아님', needsAutoReopen(autoText, 'done', false, fullProgress) === false && needsAutoReopen(autoText, 'done', false, null) === false)
check('되돌리기 — 사람이 직접 옮긴 done(Auto done 줄 없음)은 건드리지 않음', needsAutoReopen('- Status: done\n- Learn review: x merged-7\n', 'done', false, openProgress) === false)
check('되돌리기 — 보관된 계획서 · done 이 아닌 계획서는 건드리지 않음', needsAutoReopen(autoText, 'done', true, openProgress) === false && needsAutoReopen(autoText, 'in_progress', false, openProgress) === false)
check('autoDoneMark — Auto done 줄의 PR 묶음 표시', autoDoneMark(autoText) === 'merged-7' && autoDoneMark('- Status: done\n') === '')
// 되돌린 뒤: 같은 PR 묶음 표시(Auto done · Learn review)가 남아 있어도 칸을 다 채우면 다시 자동 완료할 수 있어야 한다
const reopened = reopenLines(autoText).replace('done — 자동', 'in_progress — 자동')
check('되돌린 뒤 — Auto done 줄이 Auto reopened 로 바뀜(표시 유지) · 더는 되돌리기 대상 아님', /^- Auto reopened: merged-7$/m.test(reopened) && !/^- Auto done:/m.test(reopened) && needsAutoReopen(reopened, 'done', false, openProgress) === false)
check('되돌린 뒤 — autoDoneDone 은 여전히 막지만(Learn review 표시) Auto reopened 가 있으면 다시 완료 허용', autoDoneDone(reopened, 'merged-7') === true && autoReopenedFor(reopened, 'merged-7') === true)
check('되돌리지 않은(사람이 되돌린) 계획서는 그대로 막음 — Auto reopened 없음', autoReopenedFor(autoText.replace('done — 자동', 'in_progress — 자동'), 'merged-7') === false)
check('Auto reopened 는 다른 PR 묶음 표시와 맞지 않음', autoReopenedFor(reopened, 'merged-7-9') === false)
const redone = clearReopened(reopened)
check('다시 자동 완료하면 Auto reopened 줄을 지움(사람이 다시 되돌린 in_progress 를 계속 덮지 않게)', !/Auto reopened/.test(redone) && /Learn review/.test(redone))

console.log()
console.log(fail ? 'board-auto-test: 실패 있음' : 'board-auto-test: 모두 통과')
// ── 바로 머지(PR 끔) 완료 판정 — 계획서의 "- Auto merge:" 줄 + "## Commits" HEAD 로만(ship.sh 종료 코드가 아니다) ──
const { directMergeStatus } = await import(modPath.replace('board/plan-bind.mjs', 'lib/pr-auto.mjs'))
const commitLine = '- 2026-11-01 10:00 · web · 🌿 feat/x · `abc1234def` — feat: 시험 · 검증 통과'
const mergeLine = (result, sha = 'abc1234') => `- Auto merge: web feat/x @${sha} · ${result} · 2026-11-01 10:05`
const directPlan = (...rows) => `# 시험\n\n## Checkpoint\n${rows.filter((row) => row.startsWith('- Auto')).join('\n')}\n\n## Commits\n${rows.filter((row) => !row.startsWith('- Auto')).join('\n')}\n`
const merged = directMergeStatus(directPlan(commitLine, mergeLine('머지됨 — squash → main @def5678(PR 없음)')))
check('바로 머지 성공(레포 · 브랜치 · HEAD 일치) → 완료 + 표시', merged.state === 'done' && /^merged-direct-abc1234$/.test(merged.mark), JSON.stringify(merged))
check('머지 확인 대기 → 완료 아님', directMergeStatus(directPlan(commitLine, mergeLine('머지 확인 대기'))).state === 'wait')
check('브랜치까지만(사람이 직접 머지) → 완료 아님', directMergeStatus(directPlan(commitLine, mergeLine('브랜치까지만 — 사람이 직접 머지'))).state === 'wait')
check('검증 대기 → 완료 아님', directMergeStatus(directPlan(commitLine, mergeLine('검증 대기 — 같은 HEAD 검증 없음'))).state === 'wait')
check('머지 뒤 새 커밋이 생기면 완료 아님(HEAD 불일치)', directMergeStatus(directPlan(commitLine, '- 2026-11-01 11:00 · web · 🌿 feat/x · `9999999aaa` — fix: 또', mergeLine('머지됨 — squash → main @def5678(PR 없음)'))).state === 'wait')
// PR 과 바로 머지 기록이 섞인 계획서(2026-11-01 Codex 리뷰) — server.mjs autoDonePlans 의 PR 갈래가 부르는 판정. 기존 PR 은 머지됐어도 새 작업이 머지 확인 대기면 완료로 보지 않는다
const { prDoneHeldByDirect } = await import(modPath.replace('board/plan-bind.mjs', 'lib/pr-auto.mjs'))
check('PR + Auto merge(머지 확인 대기) 섞임 → PR 이 머지돼도 완료 보류', prDoneHeldByDirect(directPlan(commitLine, mergeLine('머지 확인 대기'))) === true)
check('PR + Auto merge(머지됨) 섞임 → 보류 아님(둘 다 끝남)', prDoneHeldByDirect(directPlan(commitLine, mergeLine('머지됨 — squash → main @def5678(PR 없음)'))) === false)
check('Auto merge 줄 없는 PR 계획서 → 보류 아님(동작 그대로)', prDoneHeldByDirect(directPlan(commitLine)) === false)
check('Auto merge 줄이 없으면 none(PR 쪽 판정에 맡김)', directMergeStatus(directPlan(commitLine)).state === 'none')
check('다른 브랜치의 머지 줄만 있으면 완료 아님', directMergeStatus(directPlan(commitLine, '- Auto merge: web feat/other @abc1234 · 머지됨 — squash → main @def5678(PR 없음) · 2026-11-01 10:05')).state === 'wait')
check('merged-direct 표시도 자동 완료 표시로 인식(완료 → 재개 판정이 같은 길)', autoDoneMark(`- Auto done: 자동 — 시험 (${merged.mark})`) === merged.mark && autoDoneDone(`- Auto done: 자동 — 시험 (${merged.mark})`, merged.mark))

process.exit(fail)
EOF
