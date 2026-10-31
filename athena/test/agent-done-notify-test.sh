#!/usr/bin/env bash
# 위임 에이전트 끝 알림 훅 시험 — scripts/hooks/agent-done-notify.py(Stop · UserPromptSubmit).
# 가짜 화면 CLI · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 몇 초
#   같은 내용 중복 안 함 · 새 입력이 오면 다시 알림 · 아테나가 알림에 답한 차례는 알리지 않음 · 아테나 pane 이 없거나 닫혔으면 조용히 · reviewer 는 보내지 않음
#
# 사용: test/agent-done-notify-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
FAIL=0

# 임시 본체 — 훅 · 화면 계층만 복사하고 .pack-data 는 임시 데이터 폴더로
BODY="$WORK/body"; DATA="$WORK/data"
mkdir -p "$BODY/scripts/hooks" "$BODY/scripts/lib" "$BODY/plans/task" "$DATA/state/pane-sessions"
cp "$SRC/scripts/hooks/agent-done-notify.py" "$BODY/scripts/hooks/"
cp "$SRC"/scripts/lib/screen.py "$SRC"/scripts/lib/screen.mjs "$BODY/scripts/lib/" 2>/dev/null
cp "$SRC"/scripts/lib/*.py "$BODY/scripts/lib/" 2>/dev/null
ln -s "$DATA" "$BODY/.pack-data"
PLAN="plans/task/x.md"
cat > "$BODY/$PLAN" <<'PLANEOF'
# 시험
- Status: ready_for_review
- Lead pane: p1
- PR: https://github.com/o/r/pull/7 (feat/x → main, draft · 2026-10-30 10:00)
PLANEOF

# 가짜 화면 CLI — 받은 인자를 로그에 적고, CLOSED 목록에 든 pane 의 get 은 실패
mkdir -p "$WORK/bin"
cat > "$WORK/bin/athena-studio-cli" <<'CLIEOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [ "$1 $2" = "pane get" ]; then
  case " ${CLOSED:-} " in *" $3 "*) echo '{"error":"not_found","message":"없는 pane"}' >&2; exit 1 ;; esac
  echo "{\"pane\":{\"id\":\"$3\"}}"
fi
exit 0
CLIEOF
chmod +x "$WORK/bin/athena-studio-cli"
export FAKE_LOG="$WORK/log"; : > "$FAKE_LOG"

hook() {   # <prompt|stop> [입력 JSON] — 에이전트 pane p9 에서
  local input="${2:-}"; [ -n "$input" ] || input='{}'
  printf '%s' "$input" | env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/bin/athena-studio-cli" \
    ATHENA_AGENT="${AGENT:-athena-studio-fe}" ATHENA_PLAN="$PLAN" FAKE_LOG="$FAKE_LOG" CLOSED="${CLOSED:-}" python3 "$BODY/scripts/hooks/agent-done-notify.py" "$1"
}
sent() { grep -c '^pane send-text p1 ' "$FAKE_LOG"; }
check() { if [ "$2" = "$3" ]; then echo "  ✔ $1"; else echo "  ✖ $1 (기대 $3 · 실제 $2)"; FAIL=1; fi; }

hook stop
check "끝나면 아테나 pane(p1)에 한 줄을 보낸다" "$(sent)" 1
check "글에 에이전트 · pane · 계획서 · Status · PR 이 든다" "$(grep -c '\[athena-studio-fe → 아테나\] 끝 · p9 · 계획서 plans/task/x.md · Status ready_for_review · PR #7 draft' "$FAKE_LOG")" 1
check "Enter 도 보낸다" "$(grep -c '^pane send-keys p1 Enter' "$FAKE_LOG")" 1

hook stop
check "같은 내용 연속 알림은 보내지 않는다" "$(sent)" 1

hook prompt '{"prompt":"계속 해 주세요"}'; hook stop
check "새 입력 뒤 끝난 차례는 같은 내용이어도 다시 알린다" "$(sent)" 2

hook prompt '{"prompt":"[아테나 p1 → athena-studio-fe] 끝 알림 확인 — 고마워"}'; hook stop
check "아테나가 알림에 답한 차례는 알리지 않는다(무한 왕복 방지)" "$(sent)" 2
hook stop; hook stop
check "회신 턴은 새 입력 없이 Stop 이 다시 와도 알리지 않는다" "$(sent)" 2
hook prompt '{"prompt":"새 요청"}'; hook stop
check "그 다음 평범한 입력 뒤에는 다시 알린다" "$(sent)" 3

sed -i.bak 's/^- Status:.*/- Status: in_progress/' "$BODY/$PLAN"
hook prompt '{"prompt":"또"}'; hook stop
check "Status 가 바뀌면 바뀐 값으로 보낸다" "$(grep -c 'Status in_progress' "$FAKE_LOG")" 1

CLOSED="p1"; hook prompt '{"prompt":"또2"}'; hook stop; echo "  (아테나 pane 닫힘 — 오류 없이 끝)"
check "아테나 pane 이 닫혔으면 보내지 않고 조용히 넘어간다" "$(sent)" 4
CLOSED=""

sed -i.bak '/^- Lead pane:/d' "$BODY/$PLAN"
hook prompt '{"prompt":"또3"}'; hook stop
check "계획서에 Lead pane 이 없으면 보내지 않는다" "$(sent)" 4

echo '- Lead pane: p1' >> "$BODY/$PLAN"
AGENT=reviewer hook prompt '{"prompt":"x"}'; AGENT=reviewer hook stop
check "reviewer 는 보내지 않는다" "$(sent)" 4
env -u ATHENA_AGENT ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 python3 "$BODY/scripts/hooks/agent-done-notify.py" stop </dev/null
check "ATHENA_AGENT 없는 세션(사람이 쓰는 아테나)은 보내지 않는다" "$(sent)" 4

[ "$FAIL" = 0 ] && echo "모두 통과" || { echo "실패 있음"; exit 1; }
