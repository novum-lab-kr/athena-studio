#!/usr/bin/env bash
# 아테나 스스로 새로 시작하기 시험 — scripts/lead-fresh.py(확인 · 쉴 때 /clear · 계획서 · 대기열 대화 옮기기 · 재개 지시).
# 가짜 화면 CLI · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 몇 초
#   리뷰어 · 사용법 · 계획서 없음 · Checkpoint 오래됨은 거절(아무것도 안 넣음)
#   일하는 중 · 입력칸 초안 · 선택 창이면 기다리고, 쉬면 /clear → 새 대화 → Lead session 옮기기 → 재개 지시
#   그사이 사용자가 직접 새로 시작했으면 넣지 않는다 · Codex 는 /new
#   넘긴 계획서는 이미 다른 대화를 가리켜도(손 /clear 뒤) 옮긴다 · 지운 때를 적는다(30분 안에는 다시 묻지 않게)
#   에이전트 pane 은 묻지 않고 — 사용자가 보고 있으면(focused) 미루고 · 지운 뒤 아테나에 📦 한 줄(받음 확인 · 직접 보고로 치지 않는다) · 재개 지시
#   · 못 지우고 끝나면 아테나에 까닭 한 줄 · 뒤 셸만 도는 것(foreground_status idle)은 쉼으로 본다
#
# 사용: test/lead-fresh-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
FAIL=0

BODY="$WORK/body"; DATA="$WORK/data"
mkdir -p "$BODY/scripts/lib" "$BODY/plans/task" "$DATA/state/pane-sessions" "$DATA/state/lead-send"
cp "$SRC/scripts/lead-fresh.py" "$SRC/scripts/lead-send.py" "$BODY/scripts/"   # lead-send — 에이전트 pane 이 지운 뒤 아테나에 📦 한 줄
cp "$SRC"/scripts/lib/*.py "$SRC"/scripts/lib/*.mjs "$SRC"/scripts/lib/*.json "$BODY/scripts/lib/"   # .mjs — 사건 기록(events.mjs)
ln -s "$DATA" "$BODY/.pack-data"
SESSIONS="$DATA/state/pane-sessions"
QUEUE="$DATA/state/lead-send"
EVENTS="$DATA/state/events.jsonl"

# 가짜 화면 CLI — agent · status 파일이 pane get 의 agent · agent_status(fgstatus 가 있으면 foreground_status 도 — 뒤 셸을 뺀 상태), screen 파일이 pane read 화면(없으면 빈 입력칸),
# focused-<pane> 이 있으면 그 pane 을 사용자가 보고 있음, closed 면 pane 이 없음. pane run 은 sent 에 적고, /clear · /new 면 pane-session.py 처럼 새 대화를 pane 기록에 적는다(no-session 이면 안 적음
# · draft-after-clear 면 그 뒤 입력칸에 초안)
mkdir -p "$WORK/cli"
cat > "$WORK/cli/athena-studio-cli" <<'CLIEOF'
#!/usr/bin/env bash
[ -f "$FAKE_DIR/closed" ] && [ "$1" = pane ] && { echo '{"error":"not_found","message":"없는 pane"}' >&2; exit 1; }
case "$1 $2" in
  'pane get') echo "{\"pane\":{\"id\":\"$3\",\"agent\":\"$(cat "$FAKE_DIR/agent" 2>/dev/null || echo claude)\",\"agent_status\":\"$(cat "$FAKE_DIR/status" 2>/dev/null || echo idle)\",\"focused\":$([ -f "$FAKE_DIR/focused-$3" ] && echo true || echo false)$([ -f "$FAKE_DIR/fgstatus" ] && printf ',"foreground_status":"%s"' "$(cat "$FAKE_DIR/fgstatus")")}}" ;;
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
  rm -f "$WORK/sent" "$WORK/agent" "$WORK/status" "$WORK/fgstatus" "$WORK/screen" "$WORK/closed" "$WORK/no-session" "$WORK/draft-after-clear" "$WORK"/focused-* "$EVENTS" "$QUEUE"/*.json
  rm -rf "$DATA/state/lead-notices" "$DATA/state/agent-notify"
  rm -rf "$DATA/state/lead-fresh"
  printf '{"session":"s-old","agent":"claude","at":"t-1"}\n' > "$SESSIONS/p1.json"
  write_plan main "$(now)" in_progress p1 s-old
}
# 처리기가 끝나 사건 기록을 남길 때까지
finished() { wait_until "[ \"\$(count '$EVENTS' lead.fresh)\" -ge 1 ]"; }

echo "▶ 거절 — 아무것도 넣지 않는다"
reset
fresh ATHENA_AGENT=reviewer ATHENA_ROLE=reviewer python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
check "리뷰어 pane 은 종료 1" "$?" 1
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
check "지운 때를 적는다(30분 안에는 다시 묻지 않게 — lead_fresh_mark)" "$([ -s "$DATA/state/lead-fresh/p1.cleared" ] && echo 1 || echo 0)" 1

echo "▶ 뒤에서 셸만 돌고 앞은 쉬면(agent_status working · foreground_status idle) /clear 를 넣는다(2026-11-12 p1m — 6시간 기다리다 끝나던 버그)"
reset
echo working > "$WORK/status"; echo working > "$WORK/fgstatus"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
sleep 1
check "앞이 일하는 중이면 넣지 않는다" "$(count "$WORK/sent")" 0
echo idle > "$WORK/fgstatus"   # 턴이 끝났다 — 뒤 셸(개발 앱 등)은 그대로 돈다
finished
check "뒤 셸이 돌아도 /clear 를 넣는다" "$(count "$WORK/sent" '^SENT p1 /clear$')" 1
check "재개 지시도 넣는다" "$(count "$WORK/sent" '^SENT p1 plans/task/main.md 이어서 하자')" 1
check "사건 기록 result=done" "$(count "$EVENTS" '"result":"done"')" 1

echo "▶ 넘긴 계획서가 이미 옛 대화를 가리켜도(사용자가 손으로 /clear 한 뒤) 새 대화로 옮긴다(2026-11-11 p1m)"
reset
write_plan main "$(now)" in_progress p1 s-manual           # 손 /clear 전 대화 — pane 기록(s-old)과 다르다
write_plan stale "$(now)" in_progress p1 s-manual          # 넘기지 않은 계획서 — 어느 대화인지 몰라 그대로
write_plan taken "$(now)" in_progress p2 s-manual          # 넘긴 적 없는 다른 아테나 pane — 그대로
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
finished
check "사건 기록 result=done" "$(count "$EVENTS" '"result":"done"')" 1
check "넘긴 계획서 Lead session 을 새 대화로" "$(session_of main)" s-new
check "넘기지 않은 계획서는 그대로" "$(session_of stale)" s-manual
check "다른 아테나 pane 계획서는 그대로" "$(session_of taken)" s-manual
rm -f "$BODY/plans/task/stale.md" "$BODY/plans/task/taken.md"

echo "▶ 넘긴 계획서가 다른 아테나 pane 것이면 옮기지 않는다"
reset
write_plan main "$(now)" in_progress p2 s-manual
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
finished
check "다른 pane 의 계획서 Lead session 은 그대로" "$(session_of main)" s-manual

echo "▶ 그사이 사용자가 직접 새로 시작했으면 넣지 않는다"
reset
echo working > "$WORK/status"
fresh python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
printf '{"session":"s-user","agent":"claude"}\n' > "$SESSIONS/p1.json"
echo idle > "$WORK/status"
finished
check "아무것도 넣지 않았다" "$(count "$WORK/sent")" 0
check "안 지웠으면 지운 때를 적지 않는다" "$([ -e "$DATA/state/lead-fresh/p1.cleared" ] && echo 1 || echo 0)" 0
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

echo "▶ 계획서 · 대기열을 옮기는 사이 사용자가 새 대화에 입력하면 재개 지시를 넣지 않는다(리뷰 #289 라운드 2)"
reset
# 처리기 본문을 이 프로세스에서 돌리고 rebind_session 이 도는 중에 사용자 입력을 pane 기록에 적는다
fresh python3 - "$BODY/scripts/lead-fresh.py" "$SESSIONS/p1.json" "$BODY/plans/task/main.md" "$(now)" <<'PYEOF' > "$WORK/race" 2>&1
import importlib.util, sys
spec = importlib.util.spec_from_file_location('lead_fresh', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = module.rebind_session
def during_rebind(*args):
    moved = original(*args)
    with open(sys.argv[2], 'w', encoding='utf-8') as handle:
        handle.write('{"session":"s-new","agent":"claude","at":"t-user-typed"}\n')
    return moved
module.rebind_session = during_rebind
print(module.worker('p1', 'claude', 'plans/task/main.md', 's-old', 's-old@t-1', sys.argv[4]))
PYEOF
check "결과 resume-new-input" "$(tail -1 "$WORK/race")" resume-new-input
check "재개 지시를 넣지 않았다" "$(count "$WORK/sent" '이어서 하자')" 0

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
# 빈 줄로 시작하는 여러 줄 초안 — 첫 빈 줄에서 끊으면 빈 입력칸으로 읽어 초안 위에 /new 를 넣었다(PR #293 의 pane-close.mjs 와 같은 함정)
printf '• 끝났다\n\n› \n\n  아직 보내지 않은 글\n\n  둘째 문단\n\n  GPT-6.1-Sol medium · /tmp/demo\n  ? for shortcuts\n' > "$WORK/screen"
printf '{"session":"s-old","agent":"codex"}\n' > "$SESSIONS/p2.json"
fresh ATHENA_STUDIO_PANE_ID=p2 python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/main.md >/dev/null 2>&1
check "Codex 도 종료 0" "$?" 0
sleep 1
check "Codex 빈 줄로 시작하는 초안이 있으면 넣지 않는다" "$(count "$WORK/sent")" 0
printf '• 끝났다\n\n› \n\n  ? for shortcuts\n' > "$WORK/screen"
wait_until "[ \"\$(count '$WORK/sent' '^SENT p2 /new$')\" -ge 1 ]"
check "Codex 에는 /new" "$(count "$WORK/sent" '^SENT p2 /new$')" 1
check "Codex 에 /clear 는 넣지 않는다" "$(count "$WORK/sent" '/clear')" 0

echo "▶ 사용자가 손으로 /clear(Codex /new) 하면 pane-session.py 가 Lead session · 대기열을 새 대화로 옮긴다(2026-11-11 p1m)"
reset
mkdir -p "$BODY/scripts/hooks"
cp "$SRC/scripts/hooks/pane-session.py" "$BODY/scripts/hooks/"
OLD_SID=aaaaaaaa-1111-2222-3333-444444444444; NEW_SID=bbbbbbbb-1111-2222-3333-444444444444
hook() {   # <source> <session> [추가 환경…] — 아테나 pane p1 의 SessionStart 훅
  local source="$1" session="$2"; shift 2
  printf '{"session_id":"%s","source":"%s","cwd":"%s"}' "$session" "$source" "$BODY" \
    | fresh "$@" python3 "$BODY/scripts/hooks/pane-session.py" >/dev/null 2>&1
}
hook_reset() {
  printf '{"pane":"p1","session":"%s","agent":"athena"}\n' "$OLD_SID" > "$SESSIONS/p1.json"
  write_plan main "$(now)" in_progress p1 "$OLD_SID"
  write_plan done-plan "$(now)" done p1 "$OLD_SID"
  write_plan other-pane "$(now)" in_progress p9 "$OLD_SID"
  write_plan other-session "$(now)" in_progress p1 cccccccc-1111
  printf '{"pane":"p1","session":"%s","text":"보고"}\n' "$OLD_SID" > "$QUEUE/p1-1.json"
}
hook_reset
hook clear "$NEW_SID"
check "pane 기록은 새 대화" "$(sed -n 's/.*"session": "\([^"]*\)".*/\1/p' "$SESSIONS/p1.json")" "$NEW_SID"
check "진행 중 계획서 Lead session → 새 대화" "$(session_of main)" "$NEW_SID"
check "끝난 계획서는 그대로" "$(session_of done-plan)" "$OLD_SID"
check "다른 pane 계획서는 그대로" "$(session_of other-pane)" "$OLD_SID"
check "다른 대화를 가리키던 계획서는 그대로" "$(session_of other-session)" cccccccc-1111
check "모아 둔 lead-send 글도 새 대화" "$(count "$QUEUE/p1-1.json" "$NEW_SID")" 1
hook_reset
printf '{"session_id":"%s","source":"clear","cwd":"%s"}' "$NEW_SID" "$BODY" | fresh python3 "$BODY/scripts/hooks/pane-session.py" --tool=codex >/dev/null 2>&1
check "Codex /new(source=clear)도 옮긴다" "$(session_of main)" "$NEW_SID"
hook_reset
hook startup "$NEW_SID"
check "source=startup 이면 옮기지 않는다" "$(session_of main)" "$OLD_SID"
hook_reset
hook resume "$NEW_SID"
check "source=resume 이면 옮기지 않는다" "$(session_of main)" "$OLD_SID"
hook_reset
hook clear "$NEW_SID" ATHENA_AGENT=athena-studio-fe
check "위임 에이전트 pane 이면 옮기지 않는다" "$(session_of main)" "$OLD_SID"
hook_reset
rm -f "$SESSIONS/p1.json"
hook clear "$NEW_SID"
check "옛 pane 기록이 없으면 옮기지 않는다" "$(session_of main)" "$OLD_SID"
rm -f "$BODY/plans/task/done-plan.md" "$BODY/plans/task/other-pane.md" "$BODY/plans/task/other-session.md"

echo "▶ 에이전트 pane — 묻지 않고 새로 시작 · 보고 있으면 미룬다 · 아테나에 📦 한 줄(끝 알림으로 치지 않는다) · 재개 지시(2026-11-11 사용자 결정)"
reset
agent_fresh() {   # [추가 환경…] — 에이전트 pane p4 에서 계획서 agent.md 로
  fresh ATHENA_STUDIO_PANE_ID=p4 ATHENA_AGENT=athena-studio-fe ATHENA_ROLE=agent ATHENA_PLAN=plans/task/agent.md "$@" python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/agent.md
}
printf '{"session":"s-lead","agent":"claude","at":"t-lead"}\n' > "$SESSIONS/p1.json"
printf '{"session":"s-agent","agent":"athena-studio-fe","role":"agent","plan":"plans/task/agent.md","at":"t-a1"}\n' > "$SESSIONS/p4.json"
write_plan agent "$(now)" in_progress p1 s-lead
out="$(fresh ATHENA_STUDIO_PANE_ID=p4 ATHENA_AGENT=reviewer ATHENA_ROLE=reviewer python3 "$BODY/scripts/lead-fresh.py" --plan plans/task/agent.md 2>&1)"
check "리뷰어 pane 은 종료 1" "$?" 1
write_plan agent "2026-01-01 09:00" in_progress p1 s-lead
agent_fresh >/dev/null 2>&1
check "에이전트도 Checkpoint 가 오래됐으면 종료 1" "$?" 1
write_plan agent "$(now)" in_progress p1 s-lead
touch "$WORK/focused-p4"
out="$(agent_fresh 2>&1)"
check "에이전트 pane 도 확인을 통과하면 종료 0" "$?" 0
check "에이전트도 📦 줄을 찍는다" "$(printf '%s' "$out" | grep -c '📦 대화가 커져 새로 시작합니다 — plans/task/agent.md')" 1
sleep 1
check "사용자가 그 pane 을 보고 있으면(focused) 넣지 않는다" "$(count "$WORK/sent")" 0
rm -f "$WORK/focused-p4"
finished
check "보지 않게 되면 /clear 를 넣는다" "$(count "$WORK/sent" '^SENT p4 /clear$')" 1
check "아테나(계획서 Lead pane)에 📦 한 줄" "$(count "$WORK/sent" '^SENT p1 📦 p4 새로 시작 — plans/task/agent.md$')" 1
check "재개 지시 — Checkpoint 부터 읽고 진행" "$(count "$WORK/sent" '^SENT p4 plans/task/agent.md 이어서 — Checkpoint 부터 읽고 진행')" 1
check "넣은 순서 /clear → 📦 → 재개" "$(sed 's/^SENT \(p[0-9]\) \(.\).*/\1\2/' "$WORK/sent" | tr -d '\n')" "p4/p1📦p4p"
check "에이전트의 계획서 Lead session 은 그대로(아테나 대화가 아니다)" "$(session_of agent)" s-lead
check "📦 줄은 끝 알림 받음 확인 대상이 아니다(state/lead-notices 없음)" "$(ls "$DATA/state/lead-notices" 2>/dev/null | grep -c json)" 0
check "📦 줄은 그 차례의 직접 보고로 치지 않는다(agent-notify reported 없음)" "$(grep -c reported "$DATA/state/agent-notify/p4.json" 2>/dev/null || echo 0)" 0
check "사건 기록 result=done" "$(count "$EVENTS" '"result":"done"')" 1

echo "▶ 에이전트 pane — 예약 뒤 새 입력 · 선택 창이면 넣지 않는다"
reset
printf '{"session":"s-lead","agent":"claude","at":"t-lead"}\n' > "$SESSIONS/p1.json"
printf '{"session":"s-agent","agent":"athena-studio-fe","at":"t-a1"}\n' > "$SESSIONS/p4.json"
write_plan agent "$(now)" in_progress p1 s-lead
printf '질문\n❯ 1. 예\nEnter to select · ↑/↓ to navigate · Esc to cancel\n' > "$WORK/screen"
agent_fresh >/dev/null 2>&1
sleep 1
check "선택 창이 떠 있으면 넣지 않는다" "$(count "$WORK/sent")" 0
printf '{"session":"s-agent","agent":"athena-studio-fe","at":"t-a2"}\n' > "$SESSIONS/p4.json"
rm -f "$WORK/screen"
finished
wait_until "[ \"\$(count '$WORK/sent' '^SENT p1 ')\" -ge 1 ]"
check "예약 뒤 새 입력이 들어왔으면 그 pane 에는 아무것도 넣지 않는다" "$(count "$WORK/sent" '^SENT p4 ')" 0
check "사건 기록 result=new-input" "$(count "$EVENTS" '"result":"new-input"')" 1
check "아테나에 못 지운 까닭 한 줄(2026-11-12 — 안 지워진 줄 모르던 버그)" "$(count "$WORK/sent" '^SENT p1 📦 p4 새로 시작 못 함(그사이 새 입력이 들어옴) — 대화는 그대로 · plans/task/agent.md$')" 1

echo
if [ "$FAIL" = 0 ]; then echo "✅ 통과"; else echo "❌ 실패"; fi
exit "$FAIL"
