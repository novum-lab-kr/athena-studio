#!/usr/bin/env bash
# review-wait.sh 시험 — reviewer 결론 줄을 돌려주는지, 보안 검토를 같이 띄웠으면(- Security review: 띄움 줄) - Security result: 줄도 기다려 같이 돌려주는지,
# 보안 검토가 없으면 지금처럼 Review result 만 기다리는지. 임시 레포 · 임시 코어 사본 · 화면을 부르지 않는다 · 몇 초(시간 초과 사례 5초)
#
# 사용: test/review-wait-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
ATH="$TMP/ath"; mkdir -p "$ATH/plans/task" "$ATH/repos" "$ATH/scripts"
cp "$SRC/scripts/review-wait.sh" "$ATH/scripts/"
git init -q "$TMP/main"; git -C "$TMP/main" config user.email t@t; git -C "$TMP/main" config user.name t
printf 'a\n' > "$TMP/main/a.txt"; git -C "$TMP/main" add a.txt; git -C "$TMP/main" commit -qm init; git -C "$TMP/main" branch -M main
git -C "$TMP/main" worktree add -q "$TMP/wt" -b feat/x
ln -s "$TMP/main" "$ATH/repos/main"
PLAN="$ATH/plans/task/p.md"
TAIL='📦 main · 🌿 feat/x · 🧠 claude'
REVIEW="- Review: $TMP/wt · 📦 main · 🌿 feat/x · pane p2 (reviewer) · 띄움 2026-11-26 01:00"
SECURITY="- Security review: $TMP/wt · 📦 main · 🌿 feat/x · pane p3 (security-reviewer) · 띄움 2026-11-26 01:00"
RESULT="- Review result: 승인 @abc · tree t · $TAIL · 2026-11-26 01:05 · 요약"
SECURITY_RESULT="- Security result: 높음 0 · 중간 0 @abc · tree t · $TAIL · 2026-11-26 01:06 · 낮음 scripts/x.py:10 — 경로를 계획서 폴더 아래로 묶는다"
FAIL=0
ok() { echo "  ✔ $1"; }
bad() { echo "  ✖ $1"; FAIL=1; }
plan() { printf '%s\n' '# p' "$@" > "$PLAN"; }
wait_for() { "$ATH/scripts/review-wait.sh" --plan plans/task/p.md --dir "$TMP/wt" --timeout "${1:-5}" 2>/dev/null; }

echo "▶ 보안 검토를 띄우지 않았으면 Review result 만"
plan "$REVIEW" "$RESULT"
out="$(wait_for)"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "$RESULT" ] && ok "결론 한 줄 · 종료 0" || bad "rc=$rc out=$out"
# 띄움 줄 없이 옛 보안 결과만 남아 있어도 같이 내지 않는다
plan "$REVIEW" "$RESULT" "$SECURITY_RESULT"
out="$(wait_for)"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "$RESULT" ] && ok "보안 띄움 줄이 없으면 보안 결과를 내지 않음" || bad "rc=$rc out=$out"

echo "▶ 보안 검토를 같이 띄웠으면 Security result 도 기다려 같이"
plan "$REVIEW" "$RESULT" "$SECURITY" "$SECURITY_RESULT"
out="$(wait_for)"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "$RESULT"$'\n'"$SECURITY_RESULT" ] && ok "두 줄 · 종료 0(발견의 파일:줄 — 고칠 방법 포함)" || bad "rc=$rc out=$out"
plan "$REVIEW" "$RESULT" "$SECURITY"
out="$(wait_for 5)"; rc=$?
[ $rc -eq 1 ] && [ "$out" = "$RESULT" ] && ok "보안 결과가 아직이면 끝나지 않음(시간 초과 1 · 지금 줄)" || bad "rc=$rc out=$out"
# 띄우기 전에 적힌 옛 보안 결과는 새 결론이 아니다
plan "$REVIEW" "$RESULT" "$SECURITY" "- Security result: 높음 1 · 중간 0 @old · tree t · $TAIL · 2026-11-26 00:30 · 옛 결과"
out="$(wait_for 5)"; rc=$?
[ $rc -eq 1 ] && ok "띄우기 전 보안 결과는 새 결론으로 치지 않음" || bad "rc=$rc out=$out"
# 다른 브랜치의 보안 띄움 줄은 기다리지 않는다
plan "$REVIEW" "$RESULT" "- Security review: $TMP/other · 📦 main · 🌿 feat/y · pane p4 (security-reviewer) · 띄움 2026-11-26 01:00"
out="$(wait_for)"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "$RESULT" ] && ok "다른 브랜치의 보안 검토는 기다리지 않음" || bad "rc=$rc out=$out"

[ $FAIL -eq 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
