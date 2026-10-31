#!/usr/bin/env bash
# 계획서 칸 자동 기록 시험 — 검증 → Validation 한 줄(중복 없음 · 자리 표시 바꾸기 · 표 뒤 · 절 없음 · 이어 보낸 pane · reuse 는 안 적음) ·
# 커밋 → Status ready_for_review + plan.status 사건(한 번만) · delegate 사건의 글자 수 · test/_lib.sh(통과 줄 숨김 · 실패 줄 · 종료 코드 · VERBOSE). 임시 코어 사본 · 몇 초
#
# 사용: test/plan-autofill-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
ATH="$TMP/ath"; mkdir -p "$ATH/plans/task" "$ATH/plans/feature" "$ATH/repos" "$ATH/packs/t" "$ATH/.claude/agents"
cp -R "$SRC/scripts" "$ATH/"
printf '{"pack":"packs/t","reposRoot":".."}\n' > "$ATH/athena.config.json"
printf '{"formatVersion":1,"id":"t","name":"t","repos":[{"name":"main","branch":"main","prBase":"main","kind":"single","agents":["web-fe"]}]}\n' > "$ATH/packs/t/pack.json"
cp "$SRC/AGENTS.md" "$ATH/AGENTS.md"; cp "$SRC/.claude/settings.json" "$ATH/.claude/settings.json"
printf -- '---\nname: web-fe\ndescription: 웹\n---\n본문\n' > "$ATH/.claude/agents/web-fe.md"
git init -q -b main "$TMP/main"; git -C "$TMP/main" config user.email t@t; git -C "$TMP/main" config user.name t
printf 'a\n' > "$TMP/main/a.txt"; git -C "$TMP/main" add a.txt; git -C "$TMP/main" commit -qm init
git -C "$TMP/main" worktree add -q "$TMP/wt" -b feat/x
ln -s "$TMP/main" "$ATH/repos/main"
FAIL=0
check() { if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -z "${3:-}" ] || echo "    $3"; FAIL=1; fi; }
PLAN=plans/task/p.md
FILE="$ATH/$PLAN"
plan_with() { printf '# p\n\n## Checkpoint\n- Status: %s\n\n%s\n\n## 뒤 절\n내용\n' "$1" "$2" > "$FILE"; }
validation() { awk '/^#+ Validation/{found=1; next} /^#/{found=0} found && /^- /' "$FILE"; }
# 가짜 검증 스크립트 — 팩 스크립트처럼 _lib.sh 를 source 하고 요약까지. 첫 인자가 fail 이면 단계 하나가 실패
cat > "$ATH/scripts/verify/fake.sh" <<'SH'
#!/usr/bin/env bash
. "$(dirname "$0")/_lib.sh"
VERIFY_SCOPE_MODE=scoped
cd "$FAKE_DIR" || exit 2
if [ "${1:-}" = fail ]; then run_step "실패 단계" false; run_step "또 실패" false; else run_step "통과 단계" true; fi
print_summary main "$FAKE_DIR"
SH
verify() { FAKE_DIR="$TMP/wt" ATHENA_PLAN="$PLAN" bash "$ATH/scripts/verify/fake.sh" "$@" >/dev/null 2>&1; }
SHA="$(git -C "$TMP/wt" rev-parse --short=7 HEAD)"

echo "검증 → Validation"
plan_with in_progress $'### Validation\n- (검증 스크립트 출력 표 · 실행 못 한 것은 "실행 못 함")'
verify; RC=$?
LINE="$(validation)"
check "통과 — 종료 0 · 형식대로 한 줄 · 자리 표시 줄이 사라짐" '[ $RC = 0 ] && [ "$(validation | wc -l | tr -d " ")" = 1 ] && printf "%s" "$LINE" | grep -Eq "^- [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} main @$SHA 통과 \(scoped · [0-9]+초\)$"' "$LINE"
check "뒤 절은 그대로" 'tail -2 "$FILE" | grep -q "^## 뒤 절"'
verify
check "같은 sha · 같은 결과가 바로 위면 안 적음" '[ "$(validation | wc -l | tr -d " ")" = 1 ]' "$(validation)"
verify fail; RC=$?
check "실패 — 종료 코드 그대로 · 실패 단계 수 · 인자" '[ $RC = 1 ] && validation | tail -1 | grep -Eq "main @$SHA 실패 2 \(scoped · [0-9]+초\) — fail$"' "$(validation)"
verify
check "결과가 바뀌면 다시 적음" '[ "$(validation | wc -l | tr -d " ")" = 3 ]' "$(validation)"
plan_with in_progress $'### Validation\n| 단계 | 결과 |\n|---|---|\n| a | ✅ |'
verify
check "표 뒤에는 한 줄 띄워 적음(표 칸으로 읽히지 않게)" 'grep -A1 "^| a" "$FILE" | tail -1 | grep -q "^$" && [ "$(validation | wc -l | tr -d " ")" = 1 ]' "$(cat "$FILE")"
plan_with in_progress '- Next: 없음'
verify
check "절이 없으면 Checkpoint 끝에 만듦" 'awk "/^## 뒤 절/{exit} /^### Validation/{found=1} END{exit !found}" "$FILE" && [ "$(validation | wc -l | tr -d " ")" = 1 ]' "$(cat "$FILE")"
plan_with in_progress '### Validation'
BEFORE="$(cat "$FILE")"
FAKE_DIR="$TMP/wt" ATHENA_PLAN="/다른/곳/p.md" bash "$ATH/scripts/verify/fake.sh" >/dev/null 2>&1
FAKE_DIR="$TMP/wt" ATHENA_PLAN="plans/task/없음.md" bash "$ATH/scripts/verify/fake.sh" >/dev/null 2>&1; RC=$?
FAKE_DIR="$TMP/wt" VERIFY_RECORD=0 ATHENA_PLAN="$PLAN" bash "$ATH/scripts/verify/fake.sh" >/dev/null 2>&1
check "논리 경로 아님 · 없는 계획서 · 기록 끔이면 안 적고 검증은 그대로" '[ $RC = 0 ] && [ "$(cat "$FILE")" = "$BEFORE" ] && [ ! -e "$ATH/plans/task/없음.md" ]'

# 이어 보낸 pane — 환경 값은 처음 계획서 · pane 기록의 plan 이 지금 계획서
NEW=plans/task/new.md; printf '# 새\n\n## Checkpoint\n- Status: in_progress\n\n### Validation\n' > "$ATH/$NEW"
RESOLVED="$(cd "$ATH/scripts/lib" && python3 - "$ATH" "$NEW" "$PLAN" <<'PY'
import json, pathlib, sys
from plan_autofill import current_plan
athena, new, old = sys.argv[1:4]
data = pathlib.Path(athena).parent / 'data'; (data / 'state' / 'pane-sessions').mkdir(parents=True)
(pathlib.Path(athena) / '.pack-data').symlink_to(data)
(data / 'state' / 'pane-sessions' / 'p1.json').write_text(json.dumps({'plan': new, 'envPlan': old}))
print(current_plan(athena, old, 'p1'), current_plan(athena, 'plans/task/다른.md', 'p1'), current_plan(athena, old, ''), current_plan(athena, old, '없는pane'))
PY
)"
check "이어 보낸 pane → 지금 계획서 · 처음 값과 다르면 그대로 · pane 모름 · 기록 없음이면 환경 값" '[ "$RESOLVED" = "$NEW plans/task/다른.md $PLAN $PLAN" ]' "$RESOLVED"
rm -f "$ATH/.pack-data"

echo; echo "커밋 → Status"
commit_one() { printf '%s\n' "$1" >> "$TMP/wt/a.txt"; "$ATH/scripts/commit.sh" --plan "$PLAN" --dir "$TMP/wt" --no-verify -m "$1" -- a.txt 2>&1; }
status_of() { sed -n 's/^- Status:[[:space:]]*//p' "$FILE" | head -1; }
EVENTS="$ATH/.events.jsonl"
status_events() { grep -c '"type":"plan.status"' "$EVENTS" 2>/dev/null || true; }
plan_with in_progress '### Validation'
OUT="$(commit_one 하나)"; RC=$?
check "in_progress → ready_for_review · 알림" '[ $RC = 0 ] && [ "$(status_of)" = ready_for_review ] && printf "%s" "$OUT" | grep -q "in_progress → ready_for_review"' "$OUT"
check "plan.status 사건 — from · to · grade" 'grep "\"type\":\"plan.status\"" "$EVENTS" | tail -1 | grep -q "\"from\":\"in_progress\"" && grep "\"type\":\"plan.status\"" "$EVENTS" | tail -1 | grep -q "\"to\":\"ready_for_review\"" && grep "\"type\":\"plan.status\"" "$EVENTS" | tail -1 | grep -q "\"grade\":\"light\""' "$(cat "$EVENTS" 2>/dev/null)"
COUNT="$(status_events)"
commit_one 둘 >/dev/null
check "이미 ready_for_review 면 사건 없음" '[ "$(status_of)" = ready_for_review ] && [ "$(status_events)" = "$COUNT" ]'
plan_with planned '### Validation'; commit_one 셋 >/dev/null
check "planned → ready_for_review" '[ "$(status_of)" = ready_for_review ]'
for KEEP in blocked done; do
  plan_with "$KEEP" '### Validation'; commit_one "$KEEP" >/dev/null
  check "$KEEP 는 그대로" '[ "$(status_of)" = "$KEEP" ]'
done
printf '# p\n\n- Status: in_progress\n\n## Checkpoint\n- Status: blocked\n' > "$FILE"; commit_one 다섯 >/dev/null
check "본문의 Status 줄이 아니라 Checkpoint 의 줄을 본다" '[ "$(sed -n "s/^- Status: //p" "$FILE" | tr "\n" " ")" = "in_progress blocked " ]' "$(cat "$FILE")"
# 현황판이 같은 변화를 또 남기지 않게 본 기록을 맞춘다
SEEN="$(cd "$ATH" && node --input-type=module -e "
import { recordPlanStatus, observePlanStatus } from './scripts/lib/events.mjs'
import { readFileSync } from 'node:fs'
const count = () => readFileSync('.events.jsonl', 'utf8').split('\n').filter((line) => line.includes('\"plan.status\"')).length
observePlanStatus('.', [{ id: 'plans/task/s.md', status: 'in_progress', grade: 'light' }])
recordPlanStatus('.', { plan: 'plans/task/s.md', grade: 'light', from: 'in_progress', to: 'ready_for_review' })
const before = count()
observePlanStatus('.', [{ id: 'plans/task/s.md', status: 'ready_for_review', grade: 'light' }])
console.log(count() - before)
" 2>&1)"
check "현황판 훑기가 같은 변화를 또 남기지 않음" '[ "$SEEN" = 0 ]' "$SEEN"

echo; echo "delegate 사건"
FAKE_SCREEN="$ATH/scripts/screen"
cat > "$FAKE_SCREEN" <<'SH'
#!/bin/sh
case "$1 $2" in
  "inside "*) exit 0 ;;
  "self "*) echo "SCREEN_PANE_ID=lead1" ; exit 0 ;;
  "name "*) echo 가짜화면 ;;
  "pane split") echo '{"pane":{"id":"p9"}}' ;;
esac
exit 0
SH
chmod +x "$FAKE_SCREEN"
printf '# d\n\n## Checkpoint\n- Status: in_progress\n- Work ref: 없음\n' > "$ATH/plans/task/d.md"
: > "$EVENTS"
OUT="$(cd "$ATH" && env -u ATHENA_AGENT bash scripts/delegate.sh web-fe --plan plans/task/d.md --cwd "$TMP/wt" --here 지시문 2>&1)"; RC=$?
ROW="$(grep '"type":"delegate"' "$EVENTS" | tail -1)"
check "delegate 사건 — 글자 수가 숫자 칸" 'printf "%s" "$ROW" | grep -Eq "\"plan\":\"plans/task/d.md\"" && printf "%s" "$ROW" | grep -Eq "\"agent\":\"web-fe\"" && printf "%s" "$ROW" | grep -Eq "\"promptChars\":[1-9][0-9]*" && printf "%s" "$ROW" | grep -Eq "\"contextChars\":[1-9][0-9]*"' "rc=$RC · $ROW · $OUT"

echo; echo "test/_lib.sh"
mkdir -p "$TMP/quiet"; cp "$SRC/test/_lib.sh" "$TMP/quiet/_lib.sh"
fake_test() { # <파일> <마지막 명령>
  printf '#!/usr/bin/env bash\n. "$(dirname "$0")/_lib.sh"\necho "제목"\necho "  ✔ 맞는 줄"\necho "    ✔ 더 들여 쓴 줄"\n%s\n' "$2" > "$TMP/quiet/$1"
}
fake_test pass.sh 'echo "✅ 통과"; exit 0'
fake_test fail.sh 'echo "  ✖ 틀린 줄"; echo "    기대 a 실제 b"; echo "오류" >&2; exit 3'
Q() { env -u ATHENA_TEST_FILTERED -u ATHENA_TEST_VERBOSE "$@"; }
OUT="$(Q bash "$TMP/quiet/pass.sh" 2>&1)"; RC=$?
check "통과 — 통과 줄 없음 · 제목 · ✅ 통과 · 요약 · 종료 0" '[ $RC = 0 ] && ! printf "%s" "$OUT" | grep -q "✔" && printf "%s" "$OUT" | grep -q "^제목$" && printf "%s" "$OUT" | grep -q "^✅ 통과$" && printf "%s" "$OUT" | grep -Eq "^통과 2 · 실패 0 · [0-9]+s$"' "$OUT"
OUT="$(Q bash "$TMP/quiet/fail.sh" 2>&1)"; RC=$?
check "실패 — 실패 줄 · 기대/실제 · 표준 오류 · 요약 · 종료 코드 그대로" '[ $RC = 3 ] && printf "%s" "$OUT" | grep -q "✖ 틀린 줄" && printf "%s" "$OUT" | grep -q "기대 a 실제 b" && printf "%s" "$OUT" | grep -q "^오류$" && printf "%s" "$OUT" | grep -Eq "^통과 2 · 실패 1 · [0-9]+s$"' "$OUT"
OUT="$(Q ATHENA_TEST_VERBOSE=1 bash "$TMP/quiet/pass.sh" 2>&1)"; RC=$?
check "ATHENA_TEST_VERBOSE=1 — 통과 줄이 그대로 · 요약 없음" '[ $RC = 0 ] && printf "%s" "$OUT" | grep -q "  ✔ 맞는 줄" && ! printf "%s" "$OUT" | grep -q "^통과 2"' "$OUT"
# commit.sh 엄격 검증 · 팩 검증 스크립트처럼 종료 코드만 보는 호출
Q bash "$TMP/quiet/pass.sh" >/dev/null 2>&1; A=$?
Q bash "$TMP/quiet/fail.sh" >/dev/null 2>&1; B=$?
check "run_step 처럼 종료 코드로 읽어도 같다" '[ $A = 0 ] && [ $B = 3 ]'
check "scope-tests 는 _lib.sh 를 시험으로 고르지 않는다" 'grep -qF "test\/[^_/][^/]*\.sh" "$SRC/scripts/verify/scope-tests.mjs"'

echo
[ "$FAIL" = 0 ] && { echo "✅ 통과"; exit 0; }
echo "❌ 실패"; exit 1
