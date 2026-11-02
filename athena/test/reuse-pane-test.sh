#!/usr/bin/env bash
# 쉬는 같은 레포 pane 에 이어 보내기 시험 — scripts/reuse-pane.mjs(고르기 · 작업 폴더는 foreground_cwd · 메인 체크아웃 판정) · scripts/hooks/pane-session.py(이어 받은 계획서가 옛 계획서로 되돌아가지 않기)
# · plan-bind.mjs(옛 계획서가 다시 묶이지 않기). 가짜 화면 목록 · 임시 폴더 — 화면 · claude 를 부르지 않는다 · 몇 초
#
# 사용: test/reuse-pane-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
FAIL=0

node --input-type=module - "$SRC/scripts/reuse-pane.mjs" "$SRC/scripts/board/plan-bind.mjs" <<'NODE' || FAIL=1
const [pickPath, bindPath] = process.argv.slice(2)
const { pickReusable, isMainCheckout } = await import(pickPath)
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { execFileSync } = await import('node:child_process')
const { boundPaneIds, PROTECTED_BRANCH } = await import(bindPath)
let fail = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); if (!ok) { fail = 1; if (detail) console.log(`      ${detail}`) } }

const IDLE = ['⏺ 끝났어요', '────', '❯ ', '────'].join('\n')
const ASKING = ['❯ 1. acme', '  2. globex', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n')
const pane = (id, extra = {}) => ({ id, label: '🤖 fe · feat/a', agent: 'claude', agent_status: 'idle', focused: false, cwd: '/tmp', ...extra })
const read = (map) => (id) => (id in map ? map[id] : null)

check('쉬는 pane → 고른다', pickReusable([pane('p1')], 'fe', read({ p1: IDLE })).pane?.id === 'p1')
check('일하는 중 → 안 고른다', 'reason' in pickReusable([pane('p1', { agent_status: 'working' })], 'fe', read({ p1: IDLE })))
check('사용자가 보는 중(focused) → 안 고른다', 'reason' in pickReusable([pane('p1', { focused: true })], 'fe', read({ p1: IDLE })))
check('질문 창이 떠 있으면(idle 로 보여도) → 안 고른다', 'reason' in pickReusable([pane('p1')], 'fe', read({ p1: ASKING })))
check('화면을 못 읽으면 → 안 고른다', 'reason' in pickReusable([pane('p1')], 'fe', read({})))
check('다른 에이전트 이름표 → 안 고른다', 'reason' in pickReusable([pane('p1', { label: '🤖 be · x' })], 'fe', read({ p1: IDLE })))
check('에이전트 이름이 앞부분만 같으면 → 안 고른다(fe 가 fe2 를 잡지 않게)', 'reason' in pickReusable([pane('p1', { label: '🤖 fe2 · x' })], 'fe', read({ p1: IDLE })))
check('기본 Claude 엔진은 Codex pane 을 고르지 않는다', 'reason' in pickReusable([pane('p1', { agent: 'codex' })], 'fe', read({ p1: IDLE })))
check('Codex 엔진은 Codex pane 을 고른다', pickReusable([pane('p1', { agent: 'codex' })], 'fe', read({ p1: IDLE }), 'codex').pane?.id === 'p1')
for (const menu of ['Would you like to run the following command?\n› 1. Yes, proceed (y)\nPress enter to confirm or esc to cancel', 'Hooks need review\n› 1. Review hooks\nenter confirm · esc skip', 'Select model\n› 1. Test\nPress enter to select']) {
  check('Codex 선택 창은 재사용하지 않는다', 'reason' in pickReusable([pane('p1', { agent: 'codex' })], 'fe', read({ p1: menu }), 'codex'))
}
check('Codex 엔진은 Claude pane 을 고르지 않는다', 'reason' in pickReusable([pane('p1')], 'fe', read({ p1: IDLE }), 'codex'))
check('reviewer 역할은 재사용하지 않는다', 'reason' in pickReusable([pane('p1')], 'fe', read({ p1: IDLE }), 'claude', 'reviewer'))
check('focused 필드가 없으면(모름) → 안 고른다', 'reason' in pickReusable([(({ focused, ...rest }) => rest)(pane('p1'))], 'fe', read({ p1: IDLE })))
check('작업 폴더가 없으면 → 안 고른다', 'reason' in pickReusable([pane('p1', { cwd: '/없는/폴더' })], 'fe', read({ p1: IDLE })))
check('앞 pane 이 안 되면 다음 쉬는 pane', pickReusable([pane('p1', { focused: true }), pane('p2')], 'fe', read({ p1: IDLE, p2: IDLE })).pane?.id === 'p2')
// 새 workspace 의 첫 pane — 처음 연 폴더(cwd)는 메인 체크아웃 · 실행기가 cd 한 워크트리는 foreground_cwd(2026-11-02 pm5)
const MAIN = mkdtempSync(join(tmpdir(), 'reuse-main-'))
const TREE = mkdtempSync(join(tmpdir(), 'reuse-tree-'))
check('작업 폴더는 앞쪽 프로세스 폴더(foreground_cwd)', pickReusable([pane('p1', { cwd: MAIN, foreground_cwd: TREE })], 'fe', read({ p1: IDLE })).cwd === TREE)
check('foreground_cwd 가 없으면 cwd', pickReusable([pane('p1', { cwd: MAIN })], 'fe', read({ p1: IDLE })).cwd === MAIN)
// 메인 체크아웃인지 — 진짜 git 레포 · 워크트리로
const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })
git('-C', MAIN, 'init', '-q'); git('-C', MAIN, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
const WT = join(TREE, 'wt'); git('-C', MAIN, 'worktree', 'add', '-q', WT, '-b', 'feat/x')
check('메인 체크아웃 → mainCheckout 참', isMainCheckout(MAIN) === true)
check('워크트리 → mainCheckout 거짓', isMainCheckout(WT) === false)
check('git 레포가 아니면 → 거짓', isMainCheckout(tmpdir()) === false)
rmSync(MAIN, { recursive: true, force: true }); rmSync(TREE, { recursive: true, force: true })

// 묶음 — 옛 계획서 줄에서 pane 꼬리를 떼고 기록이 새 계획서를 가리키면 옛 계획서는 다시 묶이지 않는다
const boardPane = { id: 'pf1', role: 'agent', agent: 'fe', branch: 'feat/b' }
const sessions = [{ pane: 'pf1', agent: 'fe', plan: 'plans/task/new.md' }]
const oldPlan = { id: 'plans/task/old.md', workRefs: '/wt · 🌿 feat/a', review: '' }
const newPlan = { id: 'plans/task/new.md', workRefs: '/wt · 🌿 feat/b · pane pf1 (fe)', review: '' }
check('옛 계획서(꼬리 뗌 · 기록은 새 계획서) → 안 묶인다', boundPaneIds(oldPlan, [boardPane], sessions, PROTECTED_BRANCH).length === 0)
check('새 계획서 → 묶인다', boundPaneIds(newPlan, [boardPane], sessions, PROTECTED_BRANCH).join() === 'pf1')
process.exit(fail)
NODE

# 훅: 이어 받은 pane 의 기록이 매 메시지마다 처음 환경 값(옛 계획서)으로 덮이지 않는다
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/athena/scripts/hooks" "$TMP/athena/scripts/lib" "$TMP/data"
cp scripts/hooks/pane-session.py "$TMP/athena/scripts/hooks/"; cp scripts/lib/*.py "$TMP/athena/scripts/lib/"
ln -s "$TMP/data" "$TMP/athena/.pack-data"
SESSION=11111111-2222-3333-4444-555555555555
fire() { echo "{\"session_id\":\"$SESSION\",\"cwd\":\"/tmp\"}" | ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=pf1 ATHENA_AGENT=fe ATHENA_PLAN=plans/task/old.md python3 "$TMP/athena/scripts/hooks/pane-session.py"; }
planOf() { python3 -c "import json,sys; print(json.load(open('$TMP/data/state/pane-sessions/pf1.json')).get('plan'))"; }
check() { if [ "$2" = "$3" ]; then echo "  ✔ $1"; else echo "  ✖ $1 (받은 값: $2)"; FAIL=1; fi; }
fire; check '처음 띄운 pane — 기록은 환경 계획서' "$(planOf)" 'plans/task/old.md'
UNDO="$(python3 scripts/lib/reuse_link.py link "$TMP/athena" pf1 plans/task/new.md)"   # delegate.sh --reuse-pane 이 하는 일
fire; check '이어 받은 뒤 메시지를 보내도 새 계획서 그대로' "$(planOf)" 'plans/task/new.md'
fire; check '한 번 더 보내도 그대로' "$(planOf)" 'plans/task/new.md'
SESSION=99999999-2222-3333-4444-555555555555
fire; check '/clear 등으로 session id 가 바뀌어도 새 계획서 그대로' "$(planOf)" 'plans/task/new.md'
python3 scripts/lib/reuse_link.py link "$TMP/athena" pnone plans/task/new.md >/dev/null 2>&1; check '기록이 없는 pane 은 잇지 못하고 비정상 종료(보내기 전에 멈춤)' "$?" 1
mkdir -p "$TMP/bare"; python3 scripts/lib/reuse_link.py link "$TMP/bare" pf1 plans/task/new.md >/dev/null 2>&1; check '기록 폴더가 없는 본체도 비정상 종료' "$?" 1
python3 scripts/lib/reuse_link.py rollback "$TMP/athena" pf1 "$UNDO"
check '보내기 실패 때 되돌리면 옛 계획서' "$(planOf)" 'plans/task/old.md'
scripts/delegate.sh reviewer --new-branch x/y --plan plans/task/없음.md >/dev/null 2>&1; check '--new-branch 만 주면 pane 을 만들기 전에 종료(2)' "$?" 2
exit "$FAIL"
