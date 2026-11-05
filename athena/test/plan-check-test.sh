#!/usr/bin/env bash
# 계획서 지시 칸 검사 시험 — test/fixtures/plan-check/ 의 시험 계획서를 scripts/lib/plan-check.mjs 로 검사해 기대값(통과 · 걸림)과 맞는지 본다(몇 초 · 임시 폴더)
#
# 사용: test/plan-check-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#
# 보는 것: 좋은 지시(G1~G4) 경고 0 · 잘못된 멈춤 · 칸 · 설정 · 경로(B1~B12) · 원본 대조(A1 통과 · A2~A7 걸림) · 할 것/안 할 것 충돌(C1) · 넘기기 흩어짐(C2) ·
# 옛 계획서(새 칸 없음)는 건너뜀 · CLI 는 경고가 있어도 종료 0 · 옛 계획서에 아무것도 안 찍음 · --log 는 검사한 계획서만 plan.check 를 남김
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
node --input-type=module - <<'EOF'
import { checkPlan, countKinds } from './scripts/lib/plan-check.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const FIX = 'test/fixtures/plan-check'
const read = (name) => readFileSync(join(FIX, `${name}.md`), 'utf8')
// 팩 레포 설정 — 실제 팩과 같은 모양(PR 없이 Actions 로 넘기는 레포)
const studio = { name: 'athena-studio', prBase: 'main', autoPr: false, autoMerge: true, actionsHandoff: true }
const web = { name: 'novum-web', prBase: 'main', autoPr: false, autoMerge: true, actionsHandoff: true }
// 본체(roots)와 레포 파일 목록 — 시험 계획서가 가리키는 파일만 둔다(B10 의 core-runer 는 일부러 없음)
const root = mkdtempSync(join(tmpdir(), 'plan-check-'))
mkdirSync(join(root, 'docs'), { recursive: true })
writeFileSync(join(root, 'docs/setup.md'), '')
const repoFiles = [
  'athena/scripts/lib/init.mjs', 'athena/scripts/lib/packs.mjs', 'src/lib/pack.mts', 'src/main/athena-dir.mts', 'src/main/core-runner.mts',
  'src/main/daemon-link.mts', 'src/renderer/ui/notices.tsx', 'src/renderer/ui/settings-pop.tsx',
]
const run = (name, repo, orig = null) => checkPlan(read(name), { repo, roots: [root], repoFiles, orig })
const summary = (result) => result.warnings.map((warning) => `${warning.line ?? '-'}:${warning.kind} ${warning.message}`).join(' | ')

const cases = [
  ['G1', studio, 'pass'], ['G2', studio, 'pass'], ['G3', studio, 'pass'], ['G4', web, 'pass'],
  ['B1', studio, 'catch'], ['B2', studio, 'catch'], ['B3', studio, 'catch'], ['B4', studio, 'catch'], ['B5', web, 'catch'], ['B6', web, 'catch'],
  ['B7', web, 'catch'], ['B8', studio, 'catch'], ['B9', studio, 'catch'], ['B10', studio, 'catch'], ['B11', studio, 'catch'], ['B12', studio, 'catch'],
  ['C1', studio, 'catch'], ['C2', studio, 'catch'],
]
for (const [name, repo, expect] of cases) {
  const result = run(name, repo)
  const ok = result.checked && (expect === 'pass' ? result.warnings.length === 0 : result.warnings.length > 0)
  check(`${name} ${expect === 'pass' ? '통과' : '걸림'}`, ok, summary(result) || '경고 없음')
}
const orig = readFileSync(join(FIX, 'orig.md'), 'utf8')
for (const [name, expect] of [['A1', 'pass'], ['A2', 'catch'], ['A3', 'catch'], ['A4', 'catch'], ['A5', 'catch'], ['A6', 'catch'], ['A7', 'catch']]) {
  const result = run(name, studio, orig)
  const ok = result.checked && (expect === 'pass' ? result.warnings.length === 0 : result.warnings.length > 0)
  check(`${name} 원본 대조 ${expect === 'pass' ? '통과' : '걸림'}`, ok, summary(result) || '경고 없음')
}
// 걸려야 할 종류로 걸렸는지 — 대표만
const kindsOf2 = (result) => Object.keys(countKinds(result.warnings))
const kindsOf = (name, repo, origText = null) => Object.keys(countKinds(run(name, repo, origText).warnings))
check('B8 은 ship 옵션으로', kindsOf('B8', studio).includes('ship-option'))
check('B9 는 브랜치 base 로', kindsOf('B9', studio).includes('branch-base'))
check('B10 은 없는 경로로', kindsOf('B10', studio).includes('path-missing'))
check('A3 은 버림 이유로', kindsOf('A3', studio, orig).includes('orig-drop-reason'))
check('A4 는 없는 원본 줄로', kindsOf('A4', studio, orig).includes('orig-bad-number'))
check('C1 은 충돌로', kindsOf('C1', studio).includes('todo-conflict'))
check('C2 는 넘기기 흩어짐으로', kindsOf('C2', studio).includes('handoff-scatter'))
// 옛 계획서 — 새 칸이 없으면 검사하지 않는다
const old = checkPlan('# 옛\n\n## 지시\n> 검사해 줘\n> 화면 고치고 확인받기\n\n## 결과\n', { repo: studio })
check('옛 계획서는 건너뜀', !old.checked && old.warnings.length === 0)
check('지시 절이 없으면 건너뜀', !checkPlan('# 빈\n', {}).checked)
// 받은 뒤 "레포 설정대로" 는 올리는 방식 줄에 맡긴 것 — 옵션 경고 없음 · 그래도 PR 레포에 --direct-merge 를 적으면 경고
const skeleton = (after) => `## 지시\n요청(2026-11-05): 문구 고치기 (←1)\n- 할 것: 문구\n- 조건: 없음\n- 안 할 것: 없음\n- handoff 전 · 후:\n  - 멈춤: 없음\n  - 받은 뒤: ${after}\n`
check('레포 설정대로는 옵션 경고 없음', checkPlan(skeleton('commit.sh → 레포 설정대로 ship.sh'), { repo: studio }).warnings.length === 0)
check('PR 레포에 --direct-merge 는 경고', kindsOf2(checkPlan(skeleton('commit.sh → ship.sh --direct-merge'), { repo: { name: 'pr-repo', prBase: 'dev', autoPr: true, autoMerge: true } })).includes('ship-option'))
check('--ship 이 주어지면 그것으로(handoff 인데 옵션 없음)', kindsOf2(checkPlan(skeleton('commit.sh → ship.sh'), { repo: studio, ship: 'handoff' })).includes('ship-option'))
// 레포 목록을 못 읽으면 경로 경고를 내지 않는다
check('레포 목록이 없으면 경로 경고 없음', !Object.keys(countKinds(checkPlan(read('B10'), { repo: studio, roots: [root], repoFiles: null }).warnings)).includes('path-missing'))
rmSync(root, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
EOF
LIB_STATUS=$?

# CLI — 임시 코어 사본(본체 뿌리)에서 돌려 사건 기록 자리 · 종료 코드 · 출력을 본다
TMP="$(mktemp -d "${TMPDIR:-/tmp}/plan-check-cli.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts/lib" "$TMP/plans/task"
cp scripts/plan-check.mjs "$TMP/scripts/"
cp scripts/lib/*.mjs "$TMP/scripts/lib/"
cp test/fixtures/plan-check/B1.md "$TMP/plans/task/b1.md"
printf '# 옛\n\n## 지시\n> 화면 고치고 확인받기\n' > "$TMP/plans/task/old.md"
CLI_FAIL=0
cli_check() { if [ "$2" = 0 ]; then echo "  ✔ $1"; else echo "  ✖ $1${3:+ — $3}"; CLI_FAIL=1; fi; }
OUT="$(node "$TMP/scripts/plan-check.mjs" --plan plans/task/b1.md --log 2>&1)"; CODE=$?
cli_check 'CLI 는 경고가 있어도 종료 0' "$CODE" "종료 $CODE"
case "$OUT" in *'지시 칸 경고'*) cli_check 'CLI 가 경고를 찍음' 0 ;; *) cli_check 'CLI 가 경고를 찍음' 1 "$OUT" ;; esac
OUT="$(node "$TMP/scripts/plan-check.mjs" --plan plans/task/old.md --log 2>&1)"; CODE=$?
[ "$CODE" = 0 ] && [ -z "$OUT" ]; cli_check '옛 계획서는 아무것도 안 찍음' $? "종료 $CODE · $OUT"
EVENTS="$TMP/.events.jsonl"
COUNT="$(grep -c '"type":"plan.check"' "$EVENTS" 2>/dev/null || true)"
[ "$COUNT" = 1 ]; cli_check '--log 는 검사한 계획서만 plan.check 1줄' $? "${COUNT:-0}줄"
grep -q '"plan":"plans/task/b1.md"' "$EVENTS" 2>/dev/null; cli_check 'plan.check 에 본체 기준 경로' $?
node "$TMP/scripts/plan-check.mjs" >/dev/null 2>&1; CODE=$?
[ "$CODE" = 2 ]; cli_check '인자가 없으면 종료 2' $? "종료 $CODE"

[ "$LIB_STATUS" = 0 ] && [ "$CLI_FAIL" = 0 ]
