#!/usr/bin/env bash
# git 없는 프로젝트의 맥 실행기 시험(결정 D4) — 진짜 local-finish.mjs · _lib.sh · _generic.sh 로 git 없는 폴더의 작업 하나를 끝까지 돌린다.
# 임시 코어 사본 · 임시 폴더 · 가짜 화면(보낸 글을 파일에). 몇 초 · 네트워크 없음
#
# 사용: test/local-finish-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
ATH="$TMP/ath"; mkdir -p "$ATH/plans/task"
cp -R "$SRC/scripts" "$ATH/"
SENT="$TMP/sent"; : > "$SENT"
cat > "$ATH/scripts/screen" <<SCRIPT
#!/bin/sh
case "\$1" in
  self) echo '{"pane_id":"pX"}' ;;
  pane) echo "\$@" >> "$SENT" ;;
esac
SCRIPT
chmod +x "$ATH/scripts/screen"
export XDG_CACHE_HOME="$TMP/cache" ATHENA_DATA_DIR="$TMP/data"
export ATHENA_HEAVY_HELD=1   # 시험 안의 작은 검증은 무거운 명령 줄에 서지 않는다
unset ATHENA_VERIFY_DIR ATHENA_VERIFY_STRICT ATHENA_VERIFY_ALLOW_SKIP ATHENA_VERIFY_FULL ATHENA_PLAN ATHENA_AGENT ATHENA_VERIFY_GITLESS

FAILED=0
ok() { echo "  ✔ $1"; }
bad() { echo "  ✖ $1"; FAILED=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# 작은 Node 프로젝트(git 없음) — FAIL 파일이 있으면 test 가 실패하고 비밀값을 찍는다
WORK="$TMP/site"; mkdir -p "$WORK/node_modules"
cat > "$WORK/package.json" <<'JSON'
{"scripts":{"lint":"true","typecheck":"true","test":"if [ -f FAIL ]; then echo 'boom ghp_abcdefghijklmnopqrstuvwxyz0123456789'; exit 1; fi"}}
JSON
newplan() { # newplan <이름> [Progress 줄]
  cat > "$ATH/plans/task/$1.md" <<PLAN
# $1

## Checkpoint
- Updated: 2026-11-02 / 시험
- Status: in_progress
- Lead pane: pL

### Progress
- [x] 고침
${2:-}

### Next
1. 끝

### Validation
- 아직 실행 안 함

## 1. 개요
PLAN
}
# 뒤에서 도는 실행기가 끝날 때까지(표시 파일이 지워질 때까지)
finish() { # finish <계획서 이름> [더 줄 인자] — 넘긴 뒤 바로 돌아오는지 · 끝까지 기다린다
  local name="$1"; shift
  node "$ATH/scripts/local-finish.mjs" --plan "$ATH/plans/task/$name.md" --dir "$WORK" "$@" > "$TMP/out" 2>&1
  CODE=$?
  local tries=0
  while [ "$tries" -lt 600 ] && ls "$ATH"/.local-finish/*.pid >/dev/null 2>&1; do sleep 0.1; tries=$((tries + 1)); done
}
show_log() { find "$ATH/.local-finish" -name "*.log" 2>/dev/null | while read -r log; do echo "--- $log"; tail -15 "$log"; done; }
status_of() { grep -m1 '^- Status:' "$ATH/plans/task/$1.md"; }

echo "▶ 통과 → 완료 표시"
newplan ok
finish ok
check "넘기고 바로 끝난다" '[ "$CODE" = 0 ] && grep -q "넘겼다" "$TMP/out"'
check "Status 가 done" 'status_of ok | grep -q "^- Status: done"'
check "Validation 에 통과 줄" 'grep -q "site @? 통과" "$ATH/plans/task/ok.md"'
check "통과는 pane 에 보내지 않는다" '[ ! -s "$SENT" ]'

echo "▶ 실패 → 완료 안 함 · 원문을 pane 으로"
touch "$WORK/FAIL"; newplan bad
finish bad
check "Status 는 그대로" 'status_of bad | grep -q "in_progress"'
check "Validation 에 실패 줄" 'grep -q "site @? 실패" "$ATH/plans/task/bad.md"'
check "부른 pane 으로 원문" 'grep -q "send-text pX .*전체 검증 실패" "$SENT"'
check "비밀값은 가린다" '! grep -q "ghp_abcdefghij" "$SENT"'
: > "$SENT"; rm -f "$WORK/FAIL"
finish bad
check "고쳐서 다시 부르면 done" 'status_of bad | grep -q "^- Status: done"'

echo "▶ 검증은 통과해도 완료하지 않는 경우"
newplan step '- [ ] 2단계 남은 일'
finish step
check "단계 칸이 남으면 그대로" 'status_of step | grep -q "in_progress"'
check "이유를 pane 으로" 'grep -q "완료로 바꾸지 않았다" "$SENT"'
: > "$SENT"; newplan blocked; python3 - "$ATH/plans/task/blocked.md" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1]); path.write_text(path.read_text().replace('- Status: in_progress', '- Status: blocked'))
PY
finish blocked
check "blocked 는 그대로" 'status_of blocked | grep -q "blocked"'

echo "▶ 돌릴 검증이 없으면 완료가 아니다"
WORK="$TMP/empty"; mkdir -p "$WORK"; newplan empty
finish empty
check "건너뛴 검증만이면 완료 안 함" 'status_of empty | grep -q "in_progress"'
WORK="$TMP/site"

echo "▶ 거부"
newplan reject
git init -q "$TMP/gitrepo"
node "$ATH/scripts/local-finish.mjs" --plan "plans/task/reject.md" --dir "$TMP/gitrepo" > "$TMP/out" 2>&1; CODE=$?
check "git 레포는 거부" '[ "$CODE" = 1 ] && grep -q "git 레포다" "$TMP/out"'
node "$ATH/scripts/local-finish.mjs" --plan "/elsewhere/plan.md" --dir "$WORK" > "$TMP/out" 2>&1; CODE=$?
check "다른 곳 계획서는 거부" '[ "$CODE" = 1 ] && grep -q "계획서를 찾지 못했다" "$TMP/out"'
check "거부 때 Status 는 그대로" 'status_of reject | grep -q "in_progress"'

echo "▶ git 없는 폴더 허용은 실행기 표시가 있을 때만"
out="$(cd "$ATH" && ATHENA_VERIFY_DIR="$WORK" ATHENA_VERIFY_STRICT=1 bash scripts/verify/_generic.sh site 2>&1)"; CODE=$?
check "표시 없으면 엄격 검증이 멈춘다" '[ "$CODE" = 2 ] && printf "%s" "$out" | grep -q "엄격 모드라 멈춘다"'

[ "$FAILED" = 0 ] || show_log
[ "$FAILED" = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit "$FAILED"
