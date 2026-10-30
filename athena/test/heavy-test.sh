#!/usr/bin/env bash
# 무거운 명령 줄서기(scripts/heavy.sh) 자리 시험 — 자리 2개가 동시에 잡히는지 · 셋째는 기다리는지 · 여유 부족이면 둘째를 안 잡는지 ·
# 낡은 잠금 정리 · SLOTS=1 이면 예전처럼 하나 · 임시 잠금 경로(ATHENA_HEAVY_LOCK) · 가짜 memory_pressure · 몇 초
#
# 사용: test/heavy-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-heavy-test.XXXXXX")"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$TMP"' EXIT
FAIL=0
check() { if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; FAIL=1; fi; }

# 가짜 memory_pressure — $TMP/free 에 적힌 %를 돌려준다
mkdir -p "$TMP/bin"
cat > "$TMP/bin/memory_pressure" <<'FAKE'
#!/bin/sh
echo "System-wide memory free percentage: $(cat "$FREE_FILE")%"
FAKE
chmod +x "$TMP/bin/memory_pressure"
export PATH="$TMP/bin:$PATH" FREE_FILE="$TMP/free" ATHENA_HEAVY_LOAD=1000 ATHENA_HEAVY_MIN_FREE=1
echo 80 > "$TMP/free"

new_lock() { export ATHENA_HEAVY_LOCK="$TMP/lock.$1"; }
run_bg() { ( "$SRC/scripts/heavy.sh" sleep "$1" > "$2" 2>&1 ) & }   # <초> <로그>
waitfor() { local i; for i in $(seq 1 40); do eval "$1" && return 0; sleep 0.25; done; return 1; }

echo "자리 2개 (여유 80%)"
new_lock a; export ATHENA_HEAVY_SLOTS=2
run_bg 30 "$TMP/a1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
run_bg 30 "$TMP/a2.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK.2/what" ]'
check "첫째 자리를 잡음(pid · what · root)" '[ -s "$ATHENA_HEAVY_LOCK/pid" ] && grep -q sleep "$ATHENA_HEAVY_LOCK/what" && [ -s "$ATHENA_HEAVY_LOCK/root" ]'
check "둘째 자리도 동시에 잡음" '[ -s "$ATHENA_HEAVY_LOCK.2/pid" ] && grep -q sleep "$ATHENA_HEAVY_LOCK.2/what" && [ -s "$ATHENA_HEAVY_LOCK.2/root" ]'
ATHENA_HEAVY_WAIT=2 "$SRC/scripts/heavy.sh" true > "$TMP/a3.log" 2>&1; code=$?
check "셋째는 기다리다 포기(75)" '[ "$code" = 75 ]'
check "대기 메시지에 두 자리 모두 보임" 'grep -q "자리1: .*sleep" "$TMP/a3.log" && grep -q "자리2: .*sleep" "$TMP/a3.log"'
kill $(jobs -p) 2>/dev/null; sleep 1

echo "여유 부족이면 둘째를 안 잡음 (여유 20% < 40%)"
new_lock b; echo 20 > "$TMP/free"
run_bg 30 "$TMP/b1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
ATHENA_HEAVY_WAIT=2 "$SRC/scripts/heavy.sh" true > "$TMP/b2.log" 2>&1; code=$?
check "둘째를 안 잡고 기다리다 포기(75)" '[ "$code" = 75 ] && [ ! -e "$ATHENA_HEAVY_LOCK.2" ]'
check "보류 이유가 메시지에 나옴" 'grep -q "둘째 자리는 메모리 여유 20% < 40%" "$TMP/b2.log"'
echo 80 > "$TMP/free"
ATHENA_HEAVY_WAIT=20 "$SRC/scripts/heavy.sh" true > "$TMP/b3.log" 2>&1; code=$?
check "여유가 돌아오면 둘째 자리로 바로 돎" '[ "$code" = 0 ]'
kill $(jobs -p) 2>/dev/null; sleep 1

echo "SLOTS=1 은 예전과 같음"
new_lock c; export ATHENA_HEAVY_SLOTS=1
run_bg 30 "$TMP/c1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
ATHENA_HEAVY_WAIT=2 "$SRC/scripts/heavy.sh" true > "$TMP/c2.log" 2>&1; code=$?
check "둘째가 비었어도 기다리다 포기(75) · 둘째 자리 안 만듦" '[ "$code" = 75 ] && [ ! -e "$ATHENA_HEAVY_LOCK.2" ]'
kill $(jobs -p) 2>/dev/null; sleep 1; export ATHENA_HEAVY_SLOTS=2

echo "낡은 잠금 정리"
new_lock d
mkdir "$ATHENA_HEAVY_LOCK" "$ATHENA_HEAVY_LOCK.2"; echo 999999 > "$ATHENA_HEAVY_LOCK/pid"; echo 999999 > "$ATHENA_HEAVY_LOCK.2/pid"
ATHENA_HEAVY_WAIT=10 "$SRC/scripts/heavy.sh" true > "$TMP/d.log" 2>&1; code=$?
check "죽은 주인의 잠금은 치우고 돎" '[ "$code" = 0 ] && grep -q "🧹" "$TMP/d.log"'
check "다 끝나면 잠금이 남지 않음" '[ ! -e "$ATHENA_HEAVY_LOCK" ]'
mkdir -p "$ATHENA_HEAVY_LOCK.2"; echo 999999 > "$ATHENA_HEAVY_LOCK.2/pid"
run_bg 30 "$TMP/d1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
ATHENA_HEAVY_WAIT=10 "$SRC/scripts/heavy.sh" true > "$TMP/d2.log" 2>&1; code=$?
check "둘째 자리의 낡은 잠금도 치우고 그 자리로 돎" '[ "$code" = 0 ] && grep -q "🧹" "$TMP/d2.log"'
kill $(jobs -p) 2>/dev/null; sleep 1

echo "137 안전장치는 자리마다"
new_lock e; echo 80 > "$TMP/free"
( ATHENA_HEAVY_MIN_FREE=50 "$SRC/scripts/heavy.sh" bash -c 'echo 10 > "$FREE_FILE"; sleep 30' > "$TMP/e.log" 2>&1; echo $? > "$TMP/e.code" ) &
waitfor '[ -s "$TMP/e.code" ]'
check "메모리 여유가 MIN_FREE 아래로 떨어지면 137" '[ "$(cat "$TMP/e.code" 2>/dev/null)" = 137 ]'

[ "$FAIL" = 0 ] && echo "전부 통과" || { echo "실패 있음"; exit 1; }
