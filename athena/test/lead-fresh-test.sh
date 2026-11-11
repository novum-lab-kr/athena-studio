#!/usr/bin/env bash
# 아테나 스스로 새로 시작하기 시험 — scripts/lead-fresh.py(확인 · 쉴 때 /clear · 계획서 · 대기열 대화 옮기기 · 재개 지시).
# 가짜 화면 CLI · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 몇 초
#   위임 에이전트 · 사용법 · 계획서 없음 · Checkpoint 오래됨은 거절(아무것도 안 넣음)
#   일하는 중 · 입력칸 초안 · 선택 창이면 기다리고, 쉬면 /clear → 새 대화 → Lead session 옮기기 → 재개 지시
#   그사이 사용자가 직접 새로 시작했으면 넣지 않는다 · Codex 는 /new
#
# 사용: test/lead-fresh-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
FAIL=0

BODY="$WORK/body"; DATA="$WORK/data"
mkdir -p "$BODY/scripts/lib" "$BODY/plans/task" "$DATA/state/pane-sessions" "$DATA/state/lead-send"
cp "$SRC/scripts/lead-fresh.py" "$BODY/scripts/"
cp "$SRC"/scripts/lib/*.py "$SRC"/scripts/lib/*.mjs "$SRC"/scripts/lib/*.json "$BODY/scripts/lib/"   # .mjs — 사건 기록(events.mjs)
ln -s "$DATA" "$BODY/.pack-data"
SESSIONS="$DATA/state/pane-sessions"
QUEUE="$DATA/state/lead-send"
EVENTS="$DATA/state/events.jsonl"

# 가짜 화면 CLI — agent · status 파일이 pane get 의 agent · agent_status, screen 파일이 pane read 화면(없으면 빈 입력칸),
# closed 면 pane 이 없음. pane run 은 sent 에 적고, /clear · /new 면 pane-session.py 처럼 새 대화를 pane 기록에 적는다(no-session 이면 안 적음
# · draft-after-clear 면 그 뒤 입력칸에 초안)
mkdir -p "$WORK/cli"
cat > "$WORK/cli/athena-studio-cli" <<'CLIEOF'
#!/usr/bin/env bash
[ -f "$FAKE_DIR/closed" ] && [ "$1" = pane ] && { echo '{"error":"not_found","message":"없는 pane"}' >&2; exit 1; }
case "$1 $2" in
  'pane get') echo "{\"pane\":{\"id\":\"$3\",\"agent\":\"$(cat "$FAKE_DIR/agent" 2>/dev/null || echo claude)\",\"agent_status\":\"$(cat "$FAKE_DIR/status" 2>/dev/null || echo idle)\"}}" ;;
  'pane read') if [ -f "$FAKE_DIR/screen" ]; then cat "$FAKE_DIR/screen"; else printf '● 끝났다\n\n────────\n❯ \n────────\n  ? for shortcuts\n'; fi ;;
  'pane run')
    printf 'SENT %s %s\n' "$3" "$4" >> "$FAKE_DIR/sent"
    case "$4" in /clear|/new)
      [ -f "$FAKE_DIR/no-session" ] || printf '{"session":"s-new","agent":"claude","at":"t-clear"}\n' > "$FAKE_SESSIONS/$3.json"
      [ -f "$FAKE_DIR/draft-after-clear" ] && printf '────────\n❯ 새 대화에 쓰는 중\n────────\n' > "$FAKE_DIR/screen" ;;
    esac ;;
esac
exit 0
CLIEOF
chmod +x "$WORK/cli/athena-studio-cli"
export FAKE_DIR="$WORK"; export FAKE_SESSIONS="$SESSIONS"
# 끝날 때 pane 을 닫아 남은 처리기가 스스로 끝나게
trap 'touch "$WORK/closed"; sleep 0.5; rm -rf "$WORK"' EXIT

fresh() {   # [추가 환경…] -- <인자…> — 아테나 pane p1 에서
  env -u ATHENA_AGENT -u ATHENA_PLAN ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/cli/athena-studio-cli" \
    ATHENA_LEAD_FRESH_POLL=0.1 "$@"
}
check() { if [ "$2" = "$3" ]; then echo "  ✔ $1"; else echo "  ✖ $1 (기대 $3 · 실제 $2)"; FAIL=1; fi; }
count() { if [ -f "$1" ]; then grep -c -- "${2:-.}" "$1"; else echo 0; fi; }
wait_until() {   # <조건 명령> — 최대 15초
  for _ in $(seq 1 75); do eval "$1" && return 0; sleep 0.2; done; return 1
}
now() { date '+%Y-%m-%d %H:%M'; }
write_plan() {   # <이름> <Updated> <Status> <Lead pane> <Lead session>
  printf '# %s\n\n## Checkpoint\n- Updated: %s / 아테나\n- Status: %s\n- Lead pane: %s\n- Lead session: %s\n' "$1" "$2" "$3" "$4" "$5" > "$BODY/plans/task/$1.md"
}
session_of() { sed -n 's/^- Lead session: //p' "$BODY/plans/task/$1.md"; }
reset() {
  rm -f "$WORK/sent" "$WORK/agent" "$WORK/status" "$WORK/screen" "$WORK/closed" "$WORK/no-session" "$WORK/draft-after-clear" "$EVENTS" "$QUEUE"/*.json
  rm -rf "$DATA/state/lead-fresh"
  printf '{"session":"s-old","agent":"claude","at":"t-1"}\n' > "$SESSIONS/p1.json"
  write_plan main "$(now)" in_progress p1 s-old
}
# 처리기가 끝나 사건 기록을 남길 때까지
finished() { wait_until "[ \"\$(count '$EVENTS' lead.fresh)\" -ge 1 ]"; }

echo "▶ 거절 — 아무것도 넣지 않는다"
reset
fresh ATHENA_AGENT=athena-studio-fe python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
check "위임 에이전트는 종료 1" "$?" 1
fresh python3 "$BODY/scripts/lead-fresh.py" >/dev/null 2>&1
check "인자 없으면 사용법(종료 2)" "$?" 2
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/none.md >/dev/null 2>&1
check "없는 계획서는 종료 1" "$?" 1
write_plan main "2026-01-01 09:00" in_progress p1 s-old
out="$(fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md 2>&1)"
check "Checkpoint 가 오래됐으면 종료 1" "$?" 1
check "Checkpoint 를 먼저 갱신하라고 알린다" "$(printf '%s' "$out" | grep -c 'Checkpoint 를 먼저 갱신')" 1
sleep 0.5
check "거절한 갈래는 아무것도 넣지 않았다" "$(count "$WORK/sent")" 0

echo "▶ 일하는 중 · 초안 · 선택 창이면 기다렸다가 쉬면 /clear → 대화 옮기기 → 재개 지시"
reset
write_plan other "$(now)" in_progress p1 s-old            # 같은 아테나 · 같은 대화의 다른 계획서 — 옮긴다
write_plan done "$(now)" done p1 s-old                     # 끝난 계획서 — 그대로
write_plan elsewhere "$(now)" in_progress p2 s-old         # 다른 아테나 pane — 그대로
printf '{"id":"q1","lead":"p1","session":"s-old","text":"보고"}\n' > "$QUEUE/p1-1.json"
printf '{"id":"q2","lead":"p2","session":"s-old","text":"보고"}\n' > "$QUEUE/p2-1.json"
echo working > "$WORK/status"
out="$(fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md 2>&1)"
check "확인을 통과하면 종료 0" "$?" 0
check "📦 줄을 찍는다" "$(printf '%s' "$out" | grep -c '📦 대화가 커져 새로 시작합니다 — plans/task/main.md')" 1
sleep 1
check "일하는 중에는 넣지 않는다" "$(count "$WORK/sent")" 0
echo idle > "$WORK/status"
printf '● 끝났다\n\n────────\n❯ 다음에 할 말 쓰는 중\n────────\n' > "$WORK/screen"
sleep 1
check "입력칸에 초안이 있으면 넣지 않는다" "$(count "$WORK/sent")" 0
printf '질문\n❯ 1. 예\nEnter to select · ↑/↓ to navigate · Esc to cancel\n' > "$WORK/screen"
sleep 1
check "선택 창이 떠 있으면 넣지 않는다" "$(count "$WORK/sent")" 0
rm -f "$WORK/screen"
finished
check "쉬면 /clear 를 한 번 넣는다" "$(count "$WORK/sent" '^SENT p1 /clear$')" 1
check "그다음 재개 지시를 넣는다" "$(count "$WORK/sent" '^SENT p1 plans/task/main.md 이어서 하자')" 1
check "넣은 것은 둘뿐 · /clear 가 먼저" "$(sed -n '1s/^SENT p1 \(\/clear\)$/\1/p' "$WORK/sent")$(wc -l < "$WORK/sent" | tr -d ' ')" "/clear2"
check "이 계획서 Lead session 을 새 대화로" "$(session_of main)" s-new
check "같은 아테나의 다른 진행 중 계획서도 옮긴다" "$(session_of other)" s-new
check "끝난 계획서는 그대로" "$(session_of done)" s-old
check "다른 아테나 pane 계획서는 그대로" "$(session_of elsewhere)" s-old
check "모아 둔 이 아테나 글의 대화도 옮긴다" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["session"])' "$QUEUE/p1-1.json")" s-new
check "다른 아테나 글은 그대로" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["session"])' "$QUEUE/p2-1.json")" s-old
check "사건 기록 lead.fresh result=done" "$(count "$EVENTS" '"result":"done"')" 1

echo "▶ 그사이 사용자가 직접 새로 시작했으면 넣지 않는다"
reset
echo working > "$WORK/status"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
printf '{"session":"s-user","agent":"claude"}\n' > "$SESSIONS/p1.json"
echo idle > "$WORK/status"
finished
check "아무것도 넣지 않았다" "$(count "$WORK/sent")" 0
check "사건 기록 result=already-new" "$(count "$EVENTS" '"result":"already-new"')" 1

echo "▶ 예약 뒤 같은 대화에 새 입력이 들어왔으면 /clear 를 넣지 않는다(리뷰 #289 ①)"
reset
echo working > "$WORK/status"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
sleep 0.3
printf '{"session":"s-old","agent":"claude","at":"t-2"}\n' > "$SESSIONS/p1.json"   # pane-session.py 가 새 입력에 at 을 다시 적은 것
echo idle > "$WORK/status"
finished
check "아무것도 넣지 않았다" "$(count "$WORK/sent")" 0
check "사건 기록 result=new-input" "$(count "$EVENTS" '"result":"new-input"')" 1

echo "▶ /clear 직전 Checkpoint 를 다시 본다 — 예약 때보다 앞서거나 없어졌으면 넣지 않는다"
reset
echo working > "$WORK/status"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
write_plan main "2026-01-01 09:00" in_progress p1 s-old
echo idle > "$WORK/status"
finished
check "아무것도 넣지 않았다" "$(count "$WORK/sent")" 0
check "사건 기록 result=checkpoint-stale" "$(count "$EVENTS" '"result":"checkpoint-stale"')" 1

echo "▶ 재개를 기다리는 동안 사용자가 직접 새 대화를 열면 재개 지시를 넣지 않는다(리뷰 #289 ②)"
reset
touch "$WORK/draft-after-clear"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
wait_until "[ \"\$(count '$WORK/sent' '^SENT p1 /clear$')\" -ge 1 ]"
sleep 0.5
check "/clear 뒤 초안이 있어 재개를 기다린다" "$(count "$WORK/sent" '이어서 하자')" 0
printf '{"session":"s-user","agent":"claude","at":"t-user"}\n' > "$SESSIONS/p1.json"
rm -f "$WORK/screen"
finished
check "사용자가 연 대화에 재개 지시를 넣지 않았다" "$(count "$WORK/sent" '이어서 하자')" 0
check "사건 기록 result=resume-user-new" "$(count "$EVENTS" '"result":"resume-user-new"')" 1

echo "▶ 재개를 기다리는 동안 새 대화에 사용자가 다른 일을 시켰으면 재개 지시를 넣지 않는다"
reset
touch "$WORK/draft-after-clear"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
wait_until "[ \"\$(count '$WORK/sent' '^SENT p1 /clear$')\" -ge 1 ]"
sleep 0.5
printf '{"session":"s-new","agent":"claude","at":"t-new-prompt"}\n' > "$SESSIONS/p1.json"
rm -f "$WORK/screen"
finished
check "재개 지시를 넣지 않았다" "$(count "$WORK/sent" '이어서 하자')" 0
check "사건 기록 result=resume-new-input" "$(count "$EVENTS" '"result":"resume-new-input"')" 1

echo "▶ 새 대화가 기록되지 않으면 재개 지시를 넣지 않는다 · 처리기는 pane 마다 하나"
reset
touch "$WORK/no-session"
echo working > "$WORK/status"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
sleep 0.5
echo idle > "$WORK/status"
wait_until "[ \"\$(count '$WORK/sent')\" -ge 1 ]"
sleep 1
check "두 번 불러도 /clear 는 한 번" "$(count "$WORK/sent" '^SENT p1 /clear$')" 1
check "재개 지시는 없다" "$(count "$WORK/sent" '이어서 하자')" 0

echo "▶ Codex 아테나는 /new"
reset
echo codex > "$WORK/agent"
printf '• 끝났다\n\n› \n\n  ? for shortcuts\n' > "$WORK/screen"
printf '{"session":"s-old","agent":"codex"}\n' > "$SESSIONS/p2.json"
fresh ATHENA_STUDIO_PANE_ID=p2 python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
check "Codex 도 종료 0" "$?" 0
wait_until "[ \"\$(count '$WORK/sent' '^SENT p2 /new$')\" -ge 1 ]"
check "Codex 에는 /new" "$(count "$WORK/sent" '^SENT p2 /new$')" 1
check "Codex 에 /clear 는 넣지 않는다" "$(count "$WORK/sent" '/clear')" 0

echo
if [ "$FAIL" = 0 ]; then echo "✅ 통과"; else echo "❌ 실패"; fi
exit "$FAIL"
