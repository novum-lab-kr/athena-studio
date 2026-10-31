#!/usr/bin/env bash
# 검증의 코어 시험 동시 실행 · 통과 기록 시험 — scripts/verify/_lib.sh 의 run_steps_parallel · verify_parallel_jobs 와
# scripts/verify/core-test-pass.sh 의 key · record · check 를 본다(몇 초 · 임시 git 레포 · 네트워크 없음)
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/athena-verify-parallel.XXXXXX")" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; FAIL=1; fi; }

echo "동시 실행"
export VERIFY_RECORD=0 VERIFY_LOG_DIR="$TMP/logs"; mkdir -p "$VERIFY_LOG_DIR"
source "$SRC/scripts/verify/_lib.sh"
runner() { sleep "$1"; [ "$1" != 0.9 ]; }   # 0.9 는 실패
namer() { echo "시험 $1"; }
start=$SECONDS
run_steps_parallel 3 runner namer 1 0.5 0.9 0.1
SORTED_NAMES="$(printf "%s," "${STEP_NAMES[@]}" | tr "," "\n" | sort | grep . | tr "\n" "|")"
check "4개를 3개씩 — 가장 먼저 끝난 것(0.5)부터 한 줄씩 · 4줄 모두 있음" '[ "${#STEP_NAMES[@]}" = 4 ] && [ "${STEP_NAMES[0]}" = "시험 0.5" ] && [ "$SORTED_NAMES" = "시험 0.1|시험 0.5|시험 0.9|시험 1|" ]'
check "실패는 ❌ (exit 1) · 나머지는 ✅ 통과 · VERIFY_FAILED=1" '[ "${STEP_RESULTS[2]}" = "❌ 실패 (exit 1)" ] && [ "${STEP_RESULTS[0]}" = "✅ 통과" ] && [ "$VERIFY_FAILED" = 1 ]'
check "시험마다 로그 파일이 따로 있다" '[ -f "${STEP_LOGS[0]}" ] && [ "${STEP_LOGS[0]}" != "${STEP_LOGS[1]}" ]'
check "차례로 돌렸을 때(2.5초)보다 빨리 끝남" '[ $((SECONDS - start)) -le 2 ]'

echo "동시 수"
check "ATHENA_VERIFY_JOBS 가 양의 정수면 그 값" '[ "$(ATHENA_VERIFY_JOBS=3 verify_parallel_jobs)" = 3 ]'
check "잘못된 값(0 · 글자)은 무시하고 1~4 사이" 'for bad in 0 abc -2; do n="$(ATHENA_VERIFY_JOBS=$bad verify_parallel_jobs)"; [ "$n" -ge 1 ] && [ "$n" -le 4 ] || exit 1; done'

echo "통과 기록 (core-test-pass.sh)"
HELPER="$SRC/scripts/verify/core-test-pass.sh"
export XDG_CACHE_HOME="$TMP/cache"
REPO="$TMP/repo"; git init -q "$REPO" && echo a > "$REPO/a.txt" && git -C "$REPO" add a.txt
KEY="$("$HELPER" key "$REPO" test/x-test.sh)"
check "기록 전에는 check 가 실패" '! "$HELPER" check "$REPO" test/x-test.sh >/dev/null'
"$HELPER" record "$REPO" test/x-test.sh "$KEY" 3
check "같은 트리 · 같은 시험이면 재사용(시각 출력)" '[ -n "$("$HELPER" check "$REPO" test/x-test.sh)" ]'
check "다른 시험 이름은 재사용 안 함" '! "$HELPER" check "$REPO" test/y-test.sh >/dev/null'
echo b >> "$REPO/a.txt"
check "트리가 바뀌면(추적 파일 수정) 재사용 안 함" '! "$HELPER" check "$REPO" test/x-test.sh >/dev/null'
echo c > "$REPO/new.txt"
"$HELPER" record "$REPO" test/z-test.sh "$KEY" 1
check "시작 열쇠와 지금 열쇠가 다르면(시험 도중 트리가 바뀜) 기록하지 않음" '! "$HELPER" check "$REPO" test/z-test.sh >/dev/null'
OTHER="$TMP/other"; git init -q "$OTHER" && echo a > "$OTHER/a.txt" && git -C "$OTHER" add a.txt
check "내용이 같아도 다른 트리 경로면 재사용 안 함" '! "$HELPER" check "$OTHER" test/x-test.sh >/dev/null'

echo; echo "통과 기록은 시험 끝에 남는다(test/_lib.sh)"
FAKESRC="$TMP/fake/athena"; mkdir -p "$FAKESRC/test" "$FAKESRC/scripts/verify"
cp "$SRC/test/_lib.sh" "$FAKESRC/test/_lib.sh"; cp "$HELPER" "$FAKESRC/scripts/verify/"
printf '#!/usr/bin/env bash\n. "$(dirname "$0")/_lib.sh"\necho "  ✔ 통과"\nexit 0\n' > "$FAKESRC/test/ok-test.sh"
printf '#!/usr/bin/env bash\n. "$(dirname "$0")/_lib.sh"\necho "  ✖ 실패"\nexit 1\n' > "$FAKESRC/test/bad-test.sh"
git init -q "$TMP/fake" && git -C "$TMP/fake" add -A
# 이 시험 자신이 걸어 둔 환경을 걷어 낸다(안쪽 시험이 거르기 · 기록 길을 그대로 타게)
fresh() { env -u ATHENA_TEST_FILTERED -u ATHENA_TEST_NO_RECORD -u ATHENA_TEST_VERBOSE bash "$@"; }
fresh "$FAKESRC/test/ok-test.sh" >/dev/null; fresh "$FAKESRC/test/bad-test.sh" >/dev/null
check "통과한 시험은 기록됨" '[ -n "$("$HELPER" check "$TMP/fake" test/ok-test.sh)" ]'
check "실패한 시험은 기록 안 됨" '! "$HELPER" check "$TMP/fake" test/bad-test.sh >/dev/null'
rm -rf "$XDG_CACHE_HOME"; env -u ATHENA_TEST_FILTERED -u ATHENA_TEST_VERBOSE ATHENA_TEST_NO_RECORD=1 bash "$FAKESRC/test/ok-test.sh" >/dev/null
check "ATHENA_TEST_NO_RECORD=1 이면 기록 안 함" '! "$HELPER" check "$TMP/fake" test/ok-test.sh >/dev/null'

[ "$FAIL" = 0 ] && echo "✅ 통과"
exit "$FAIL"
