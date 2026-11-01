#!/usr/bin/env bash
# 무거운 명령 줄서기(scripts/heavy.sh) 자리 시험 — 자리 2개가 동시에 잡히는지 · 셋째는 기다리는지 · 여유 부족 · 부하 높음 · 부하 못 읽음이면 둘째를 안 잡는지 ·
# 낡은 잠금 정리 · SLOTS=1 이면 예전처럼 하나 · 임시 잠금 경로(ATHENA_HEAVY_LOCK) · 가짜 memory_pressure · 몇 초
#
# 사용: test/heavy-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
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
# 가짜 sysctl — $LOAD_FILE 의 값을 1분 부하로, 코어는 4 로 돌려준다(파일이 없으면 읽지 못한 것처럼 실패)
cat > "$TMP/bin/sysctl" <<'FAKE'
#!/bin/sh
case "$*" in
  "-n hw.ncpu") echo 4 ;;
  "-n vm.loadavg") [ -s "$LOAD_FILE" ] || exit 1; echo "{ $(cat "$LOAD_FILE") 0.00 0.00 }" ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$TMP/bin/sysctl"
export ATHENA_HEAVY_LOADAVG_FILE="$TMP/no-loadavg"   # 리눅스 /proc/loadavg 대체 경로도 없는 것으로 — 호스트 부하와 무관하게
export LOAD_FILE="$TMP/load"; echo 0.5 > "$LOAD_FILE"
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
ATHENA_HEAVY_WAIT=2 "$SRC/scripts/heavy.sh" true 2>/dev/null | tail -1 > "$TMP/a3.tail"
check "포기하면 stdout 마지막 줄에도 실패(75)가 남음 — stderr 를 버리고 | tail 로 받아도 성공처럼 안 보임" 'grep -q "종료 코드 75" "$TMP/a3.tail"'
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

echo "부하가 높으면 둘째를 안 잡음 (부하 6.5 ≥ 코어 4)"
new_lock f; echo 6.5 > "$LOAD_FILE"
run_bg 30 "$TMP/f1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
ATHENA_HEAVY_WAIT=2 "$SRC/scripts/heavy.sh" true > "$TMP/f2.log" 2>&1; code=$?
check "둘째를 안 잡고 기다리다 포기(75)" '[ "$code" = 75 ] && [ ! -e "$ATHENA_HEAVY_LOCK.2" ]'
check "이유가 메시지에 나옴" 'grep -q "부하 6.5 / 코어 4 — 둘째 자리 대기" "$TMP/f2.log"'
echo 1.0 > "$LOAD_FILE"
ATHENA_HEAVY_WAIT=20 "$SRC/scripts/heavy.sh" true > "$TMP/f3.log" 2>&1; code=$?
check "부하가 내려가면 둘째 자리로 바로 돎" '[ "$code" = 0 ]'
kill $(jobs -p) 2>/dev/null; sleep 1

echo "기준 변수 ATHENA_HEAVY_MAX_LOAD"
new_lock g; echo 2.0 > "$LOAD_FILE"
run_bg 30 "$TMP/g1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
ATHENA_HEAVY_MAX_LOAD=1.5 ATHENA_HEAVY_WAIT=2 "$SRC/scripts/heavy.sh" true > "$TMP/g2.log" 2>&1; code=$?
check "부하 2.0 ≥ 기준 1.5 면 안 잡음(75)" '[ "$code" = 75 ]'
kill $(jobs -p) 2>/dev/null; sleep 1

echo "부하를 못 읽으면 둘째를 안 잡음"
new_lock h; rm -f "$LOAD_FILE"
run_bg 30 "$TMP/h1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
ATHENA_HEAVY_WAIT=2 "$SRC/scripts/heavy.sh" true > "$TMP/h2.log" 2>&1; code=$?
check "둘째를 안 잡고 포기(75) · 이유가 나옴" '[ "$code" = 75 ] && [ ! -e "$ATHENA_HEAVY_LOCK.2" ] && grep -q "부하를 읽지 못해" "$TMP/h2.log"'
echo 0.5 > "$LOAD_FILE"
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


echo "개발 서버는 시작하는 동안만 자리를 쓴다 (포트를 열면 놓고, 감시는 계속)"
new_lock i; export ATHENA_HEAVY_SLOTS=1; echo 80 > "$TMP/free"
# 가짜 개발 서버 — next dev / npm run build 라는 이름으로 불리면 TCP 포트를 열고 오래 돈다
for fake in next npm; do
  cat > "$TMP/bin/$fake" <<'FAKE'
#!/bin/sh
exec node -e "require('net').createServer().listen(0); setTimeout(() => {}, 120000)"
FAKE
  chmod +x "$TMP/bin/$fake"
done
( ATHENA_HEAVY_MIN_FREE=50 "$SRC/scripts/heavy.sh" next dev > "$TMP/i.log" 2>&1; echo $? > "$TMP/i.code" ) &
waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
check "개발 서버가 자리를 잡고 시작함" 'grep -q "next dev" "$ATHENA_HEAVY_LOCK/what"'
waitfor '[ ! -e "$ATHENA_HEAVY_LOCK" ]'; for _ in $(seq 1 40); do [ ! -e "$ATHENA_HEAVY_LOCK" ] && break; sleep 0.5; done
check "포트를 연 뒤 자리를 놓음" '[ ! -e "$ATHENA_HEAVY_LOCK" ] && grep -q "개발 서버 시작 끝" "$TMP/i.log"'
ATHENA_HEAVY_WAIT=3 "$SRC/scripts/heavy.sh" true > "$TMP/i2.log" 2>&1; code=$?
check "개발 서버가 도는 중에도 다른 명령이 바로 돎" '[ "$code" = 0 ] && [ ! -s "$TMP/i.code" ]'
echo 10 > "$TMP/free"
for _ in $(seq 1 30); do [ -s "$TMP/i.code" ] && break; sleep 0.5; done
check "자리를 놓은 뒤에도 감시가 계속 — 메모리 여유가 떨어지면 137" '[ "$(cat "$TMP/i.code" 2>/dev/null)" = 137 ]'
echo 80 > "$TMP/free"

echo "개발 서버가 아닌 명령(npm run build)은 포트를 열어도 자리를 쥔다"
new_lock j
( "$SRC/scripts/heavy.sh" npm run build > "$TMP/j.log" 2>&1 ) &
waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'; sleep 8
check "빌드는 끝날 때까지 자리를 쥠" '[ -s "$ATHENA_HEAVY_LOCK/what" ] && ! grep -q "개발 서버 시작 끝" "$TMP/j.log"'
kill $(jobs -p) 2>/dev/null; sleep 1

echo "기다린 시간·이유를 안쪽 명령에 넘긴다"
new_lock k
run_bg 6 "$TMP/k1.log"; waitfor '[ -s "$ATHENA_HEAVY_LOCK/what" ]'
ATHENA_HEAVY_WAIT=30 "$SRC/scripts/heavy.sh" bash -c 'echo "WAIT_SEC=$ATHENA_HEAVY_WAIT_SEC"; echo "WAIT_WHY=$ATHENA_HEAVY_WAIT_WHY"' > "$TMP/k2.log" 2>&1
check "ATHENA_HEAVY_WAIT_SEC 가 기다린 초" 'grep -Eq "^WAIT_SEC=[1-9][0-9]*$" "$TMP/k2.log"'
check "ATHENA_HEAVY_WAIT_WHY 에 자리를 쥔 쪽이 남음" 'grep -q "^WAIT_WHY=.*자리1: .*sleep" "$TMP/k2.log"'
ATHENA_HEAVY_WAIT=30 "$SRC/scripts/heavy.sh" bash -c 'echo "WAIT_SEC=$ATHENA_HEAVY_WAIT_SEC"' > "$TMP/k3.log" 2>&1
check "안 기다리면 0" 'grep -qx "WAIT_SEC=0" "$TMP/k3.log"'
export ATHENA_HEAVY_SLOTS=2

[ "$FAIL" = 0 ] && echo "전부 통과" || { echo "실패 있음"; exit 1; }
