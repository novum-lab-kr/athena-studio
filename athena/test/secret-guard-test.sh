#!/usr/bin/env bash
# secret-guard 훅 시험 — ps · pgrep 규칙이 명령 자리에서만 걸리는지(gh134). 훅에 글자만 넣어 종료 코드를 본다(2 = 막힘, 0 = 통과) · 몇 초
#
# 사용: test/secret-guard-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#       HOOK=<다른 훅 파일> test/secret-guard-test.sh   (고치기 전 훅과 비교할 때)
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="${HOOK:-$SRC/scripts/hooks/secret-guard.py}"
FAIL=0
run() {   # <명령 글자> → 훅 종료 코드
  CMD="$1" python3 -c 'import json,os,sys; json.dump({"tool_input":{"command":os.environ["CMD"]}}, sys.stdout)' | python3 "$HOOK" >/dev/null 2>&1
  echo $?
}
check() {   # <기대: pass|block> <명령>
  local want=0 got; [ "$1" = block ] && want=2
  got="$(run "$2")"
  if [ "$got" = "$want" ]; then echo "  ✔ [$1] $2"; else echo "  ✖ [$1] $2 (종료 코드 $got)"; FAIL=1; fi
}

echo "ps · pgrep 이름이 인자 자리에 있는 것 — 통과"
check pass "scripts/screen pane send-keys ps Enter"
check pass "scripts/screen pane send-keys ps Escape"
check pass "git log --oneline -- docs/ps example"
check pass "grep -rn x ps utils"
check pass "scripts/screen pane send-text ps '…'"
check pass "scripts/screen pane send-keys ps C-c"
check pass "scripts/screen pane read ps"
check pass "scripts/screen pane send-keys pgrep Enter"
echo "ps · pgrep 이 이름만 보는 쓰임 — 통과"
check pass "ps -axo pid=,comm="
check pass "pgrep -f athena"
check pass "pgrep athena"
echo "전체 인자·환경 변수를 찍는 ps — 막힘(유지)"
check block "ps aux"
check block "ps -ef"
check block "ps -o command= -p 123"
check block "echo x; ps aux"
check block "echo x && ps -ef"
check block "echo x | ps aux"
check block 'sh -c "ps aux"'
check block 'bash -lc "ps -ef"'
check block 'x=$(ps -ef)'
check block 'x=`ps -ef`'
check block "(ps aux)"
check block "sudo ps aux"
check block "env FOO=1 ps -ef"
check block "FOO=1 ps aux"
check block "command ps aux"
check block "exec ps aux"
check block "time ps -ef"
check block "/bin/ps aux"
check block $'echo x\nps aux'
check block "sudo -u root ps aux"
check block "nice -n 10 ps -ef"
check block "env -u FOO ps -ef"
check block "/usr/bin/sudo ps aux"
check block "xargs ps -ef"
check block "watch ps aux"
check block "timeout 5 ps aux"
check block "sudo -E timeout 5 ps -ef"
echo "전체 인자를 찍는 pgrep — 막힘(유지)"
check block "pgrep -fl athena"
check block "pgrep -a athena"
check block "echo x; pgrep -lf athena"
check block 'x=$(pgrep -fl athena)'
check block "sudo pgrep -a athena"
check block "env -u FOO pgrep -fl athena"
check block "sudo -u root pgrep -fl athena"
check block "timeout 5 pgrep -a athena"

[ "$FAIL" = 0 ] && echo "모두 통과" || echo "실패 있음"
exit "$FAIL"
