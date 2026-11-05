#!/usr/bin/env bash
# 위임 에이전트 끝 알림 훅 시험 — scripts/hooks/agent-done-notify.py(Stop · UserPromptSubmit).
# 가짜 화면 CLI · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 몇 초
#   같은 내용 중복 안 함 · 새 입력이 오면 다시 알림 · 멈춤 표시(⏸ 멈춤:)면 멈춤 알림 + plan.stop · 아테나가 알림에 답한 차례는 알리지 않음 · 아테나 pane 이 없거나 닫혔으면 조용히 · reviewer 는 보내지 않음
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
# HOOK_SRC=<다른 훅 파일> — 고치기 전 훅과 비교할 때
cp "${HOOK_SRC:-$SRC/scripts/hooks/agent-done-notify.py}" "$BODY/scripts/hooks/agent-done-notify.py"
cp "$SRC/scripts/lead-send.py" "$BODY/scripts/"   # 끝 알림도 lead-send 와 같은 길로 넣는다(검수 #16)
cp "$SRC"/scripts/lib/*.py "$SRC"/scripts/lib/*.mjs "$BODY/scripts/lib/" 2>/dev/null
ln -s "$DATA" "$BODY/.pack-data"
PLAN="plans/task/x.md"
cat > "$BODY/$PLAN" <<'PLANEOF'
# 시험
- Status: ready_for_review
- Lead pane: p1
- PR: https://github.com/o/r/pull/7 (feat/x → main, draft · 2026-10-30 10:00)
PLANEOF

# 가짜 화면 CLI — 받은 인자를 로그에 적고, CLOSED 목록에 든 pane 의 get 은 실패 · read 는 빈 입력칸(고르기 창 없음)
mkdir -p "$WORK/bin"
cat > "$WORK/bin/athena-studio-cli" <<'CLIEOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [ "$1 $2" = "pane get" ]; then
  case " ${CLOSED:-} " in *" $3 "*) echo '{"error":"not_found","message":"없는 pane"}' >&2; exit 1 ;; esac
  state=idle
  [ -f "${WAITING_FILE:-/no-waiting-file}" ] && state=waiting
  echo "{\"pane\":{\"id\":\"$3\",\"agent_status\":\"$state\"}}"
fi
[ "$1 $2" = "pane read" ] && printf '❯ \n'

exit 0
CLIEOF
chmod +x "$WORK/bin/athena-studio-cli"
# 가짜 gh — 끝 알림이 PR 실제 상태를 묻는다. FAKE_GH 로 답을 고른다(기본은 실패 — 진짜 GitHub 를 부르지 않게 항상 PATH 앞에 둔다)
cat > "$WORK/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
case "${FAKE_GH:-fail}" in
  merged) echo '{"isDraft":false,"state":"MERGED"}' ;;
  draft) echo '{"isDraft":true,"state":"OPEN"}' ;;
  open) echo '{"isDraft":false,"state":"OPEN"}' ;;
  slow) sleep 20; echo '{"isDraft":false,"state":"MERGED"}' ;;
  *) echo 'gh: 네트워크 없음' >&2; exit 1 ;;
esac
GHEOF
chmod +x "$WORK/bin/gh"
export FAKE_LOG="$WORK/log"; : > "$FAKE_LOG"

hook() {   # <prompt|stop> [입력 JSON] — 에이전트 pane p9 에서
  local input="${2:-}"; [ -n "$input" ] || input='{}'
  printf '%s' "$input" | env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/bin/athena-studio-cli" \
    ATHENA_NOTIFY_BOOTSTRAP="${BOOTSTRAP:-0}" ATHENA_AGENT="${AGENT:-athena-studio-fe}" ATHENA_PLAN="$PLAN" FAKE_LOG="$FAKE_LOG" FAKE_GH="${FAKE_GH:-fail}" PATH="$WORK/bin:$PATH" WAITING_FILE="$WORK/waiting" CLOSED="${CLOSED:-}" python3 "$BODY/scripts/hooks/agent-done-notify.py" "$1"
}
sent() { grep -c '^pane run p1 ' "$FAKE_LOG"; }   # lead-send 와 같은 pane run(전송 확인)
check() { if [ "$2" = "$3" ]; then echo "  ✔ $1"; else echo "  ✖ $1 (기대 $3 · 실제 $2)"; FAIL=1; fi; }

python3 - "$BODY" "$WORK" <<'PYRACE'
import importlib.util, json, multiprocessing, pathlib, sys, time
body, work = map(pathlib.Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('notify_hook', body / 'scripts/hooks/agent-done-notify.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
state_path = work / 'race' / 'p9.json'
log = work / 'race-sent'
class Backend:
    def get_pane(self, pane):
        time.sleep(0.05)
        return {'agent_status': 'idle'}
def forward(lead, line, plan):
    with log.open('a') as handle: handle.write('sent\n')
    time.sleep(0.05)
module.screen.get_backend = lambda: Backend()
module.forward = forward
line = '같은 문구의 끝 알림'
module.save_state(state_path, {'turn': 'new-turn', 'pending': {'id': 'new-notice', 'turn': 'new-turn', 'line': line}})
module.deliver_notice(state_path, 'p9', 'p1', 'old-notice')
assert not log.exists(), '옛 턴의 작업은 같은 문구여도 보내면 안 됨'
context = multiprocessing.get_context('fork')
workers = [context.Process(target=module.deliver_notice, args=(state_path, 'p9', 'p1', 'new-notice')) for index in range(2)]
for worker in workers: worker.start()
for worker in workers:
    worker.join(5)
    assert worker.exitcode == 0
assert log.read_text().splitlines() == ['sent'], '같은 알림을 두 작업이 동시에 보내도 전송은 한 번'
state = module.load_json(state_path)
assert state['last'] == line and 'pending' not in state
module.save_state(state_path, {'turn': 'next-turn', 'last': '', 'pending': {'id': 'next-notice', 'turn': 'next-turn', 'line': line}})
module.deliver_notice(state_path, 'p9', 'p1', 'new-notice')
module.deliver_notice(state_path, 'p9', 'p1', 'next-notice')
assert log.read_text().splitlines() == ['sent', 'sent'], '새 턴의 같은 문구는 한 번 새로 보내야 함'
PYRACE
check "옛 턴 같은 문구 취소·동시 전송 선점·새 턴 알림 허용" "$?" 0

hook stop
hook stop
check "첫 지시 전 Stop 은 끝 알림을 보내지 않는다" "$(sent)" 0
: > "$FAKE_LOG"
rm -f "$DATA/state/agent-notify/p9.json"

BOOTSTRAP=1 hook prompt '{"prompt":"지금은 지시가 없다. 브랜치 확인 후 기다린다"}'
BOOTSTRAP=1 hook stop
check "작업 지시 없는 시작 안내 턴은 끝 알림을 보내지 않는다" "$(sent)" 0
BOOTSTRAP=1 hook prompt '{"prompt":"첫 실제 요청"}'
BOOTSTRAP=1 hook stop
check "시작 안내 뒤 실제 요청부터 끝 알림을 보낸다" "$(sent)" 1
: > "$FAKE_LOG"
rm -f "$DATA/state/agent-notify/p9.json"

hook prompt '{"prompt":"선택 중 알림"}'
touch "$WORK/waiting"
hook stop
check "받는 pane이 waiting이면 글을 보내지 않는다" "$(sent)" 0
hook stop
check "같은 대기 알림은 중복 전송하지 않는다" "$(sent)" 0
rm "$WORK/waiting"
for attempt in $(seq 1 40); do [ "$(sent)" -eq 1 ] && break; sleep 0.1; done
check "선택 창이 닫힌 뒤 끝 알림을 한 번 보낸다" "$(sent)" 1
hook prompt '{"prompt":"선택 중 옛 알림"}'
touch "$WORK/waiting"
hook stop
hook prompt '{"prompt":"이미 다른 요청을 시작함"}'
rm "$WORK/waiting"
sleep 2.2
check "새 입력 뒤에는 기다리던 옛 턴의 알림을 버린다" "$(sent)" 1
: > "$FAKE_LOG"
hook prompt '{"prompt":"기존 시험 시작"}'

hook stop
check "끝나면 아테나 pane(p1)에 한 줄을 보낸다" "$(sent)" 1
check "글에 에이전트 · pane · 계획서 · Status · PR 이 든다" "$(grep -c '\[athena-studio-fe → 아테나\] 끝 · p9 · 계획서 plans/task/x.md · Status ready_for_review · PR #7 draft (기록 기준)' "$FAKE_LOG")" 1
check "send-text · Enter 를 직접 보내지 않는다(lead-send 의 pane run 으로)" "$(grep -c '^pane send-text p1 \|^pane send-keys p1 ' "$FAKE_LOG")" 0

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

# PR 끔 레포의 바로 머지 결과 — "- Auto merge:" 줄이 있으면 끝 알림에 레포 · 브랜치 · 결과가 든다(PR 줄이 없어도)
printf -- '- Auto merge: web feat/x @abc1234 · 머지됨 — squash → main @def5678(PR 없음) · 2026-11-01 10:00\n' >> "$BODY/$PLAN"
hook prompt '{"prompt":"머지"}'; hook stop
check "바로 머지 결과(머지됨)가 끝 알림에 실린다" "$(grep -c '머지 web feat/x 머지됨 — squash → main @def5678(PR 없음)' "$FAKE_LOG")" 1
sed -i.bak 's/^- Auto merge:.*/- Auto merge: web feat\/x @abc1234 · 머지 확인 대기 · 2026-11-01 10:01/' "$BODY/$PLAN"
hook prompt '{"prompt":"대기"}'; hook stop
check "머지 확인 대기도 그대로 실린다(완료로 바꾸지 않는다)" "$(grep -c '머지 web feat/x 머지 확인 대기$' "$FAKE_LOG")" 1
sed -i.bak '/^- Auto merge:/d' "$BODY/$PLAN"
hook prompt '{"prompt":"지움"}'; hook stop
sed -i.bak 's/^- Status:.*/- Status: in_progress/' "$BODY/$PLAN"

CLOSED="p1"; hook prompt '{"prompt":"또2"}'; hook stop; echo "  (아테나 pane 닫힘 — 오류 없이 끝)"
check "아테나 pane 이 닫혔으면 보내지 않고 조용히 넘어간다" "$(sent)" 7
CLOSED=""

sed -i.bak '/^- Lead pane:/d' "$BODY/$PLAN"
hook prompt '{"prompt":"또3"}'; hook stop
check "계획서에 Lead pane 이 없으면 보내지 않는다" "$(sent)" 7

echo '- Lead pane: p1' >> "$BODY/$PLAN"
AGENT=reviewer hook prompt '{"prompt":"x"}'; AGENT=reviewer hook stop
check "reviewer 는 보내지 않는다" "$(sent)" 7
env -u ATHENA_AGENT ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 python3 "$BODY/scripts/hooks/agent-done-notify.py" stop </dev/null
check "ATHENA_AGENT 없는 세션(사람이 쓰는 아테나)은 보내지 않는다" "$(sent)" 7

# 백그라운드 명령 — 대화 기록의 시작 · 끝 기록과 출력 파일을 쥔 진짜 프로세스로 판정한다
TRANSCRIPT="$WORK/transcript.jsonl"; OUTPUT="$WORK/task1.output"
python3 - "$TRANSCRIPT" "$OUTPUT" <<'PY'
import json, sys
transcript, output = sys.argv[1:3]
entry = {"type": "user", "toolUseResult": {"backgroundTaskId": "task1"}, "message": {"content": [{"type": "tool_result", "content": f"Output is being written to: {output}"}]}}
open(transcript, "w").write(json.dumps(entry) + "\n")
PY
STOP_JSON="{\"transcript_path\":\"$TRANSCRIPT\"}"
sleep 60 > "$OUTPUT" 2>&1 &
SLEEP_PID=$!
hook prompt '{"prompt":"백그라운드"}'; hook stop "$STOP_JSON"
check "백그라운드 명령이 도는 중이면 알리지 않는다" "$(sent)" 7
kill "$SLEEP_PID" 2>/dev/null; wait "$SLEEP_PID" 2>/dev/null
hook stop "$STOP_JSON"
check "끝 기록 없이 프로세스가 죽었으면 알린다(알림이 영영 끊기지 않게)" "$(sent)" 8

sleep 60 > "$OUTPUT" 2>&1 &
SLEEP_PID=$!
hook prompt '{"prompt":"끝 기록"}'; hook stop "$STOP_JSON"
check "다시 도는 중이면 알리지 않는다(last 를 남기지 않았다)" "$(sent)" 8
printf '%s\n' '{"type":"queue-operation","content":"<task-notification>\n<task-id>task1</task-id>\n<status>completed</status>"}' >> "$TRANSCRIPT"
hook stop "$STOP_JSON"
check "끝 기록(task-notification)이 있으면 알린다" "$(sent)" 9
sed -i.bak '$d' "$TRANSCRIPT"
hook prompt '{"prompt":"멈춤"}'; hook stop "$STOP_JSON"
check "끝 기록을 지우면 다시 도는 중으로 본다" "$(sent)" 9
printf '%s\n' '{"type":"user","toolUseResult":{"message":"Successfully stopped task: task1","task_id":"task1"}}' >> "$TRANSCRIPT"
hook stop "$STOP_JSON"
check "TaskStop 기록이 있으면 알린다" "$(sent)" 10
kill "$SLEEP_PID" 2>/dev/null; wait "$SLEEP_PID" 2>/dev/null

hook prompt '{"prompt":"기록 없음"}'; hook stop '{"transcript_path":"/없는/경로.jsonl"}'
check "대화 기록을 못 읽으면 평소대로 알린다" "$(sent)" 11

# PR 실제 상태 — 알림을 만들 때 gh 로 묻고, 못 물으면 계획서 값에 "(기록 기준)"
last_sent() { grep '^pane run p1 ' "$FAKE_LOG" | tail -1; }
FAKE_GH=merged hook prompt '{"prompt":"머지 뒤"}'; FAKE_GH=merged hook stop
check "머지된 PR 은 계획서가 draft 여도 merged 로 알린다" "$(last_sent | grep -c 'PR #7 merged$')" 1
check "gh 에는 계획서 PR 주소로 상태를 묻는다" "$(grep -q '^gh pr view https://github.com/o/r/pull/7 --json state,isDraft$' "$FAKE_LOG" && echo 1 || echo 0)" 1
FAKE_GH=draft hook prompt '{"prompt":"draft"}'; FAKE_GH=draft hook stop
check "열린 draft PR 은 draft 로 알린다" "$(last_sent | grep -c 'PR #7 draft$')" 1
FAKE_GH=open hook prompt '{"prompt":"open"}'; FAKE_GH=open hook stop
check "draft 를 푼 열린 PR 은 open 으로 알린다" "$(last_sent | grep -c 'PR #7 open$')" 1
FAKE_GH=fail hook prompt '{"prompt":"실패"}'; FAKE_GH=fail hook stop
check "gh 가 실패하면 계획서 값에 (기록 기준)" "$(last_sent | grep -c 'PR #7 draft (기록 기준)$')" 1
started=$(date +%s)
FAKE_GH=slow hook prompt '{"prompt":"느림"}'; FAKE_GH=slow hook stop
elapsed=$(( $(date +%s) - started ))
check "gh 가 느리면 기다리지 않고 (기록 기준)" "$(last_sent | grep -c 'PR #7 draft (기록 기준)$')" 1
check "느린 gh 에도 훅이 6초 안에 끝난다(실제 ${elapsed}초)" "$([ "$elapsed" -lt 6 ] && echo 1 || echo 0)" 1

# 멈춤 알림 — 마지막 답에 "⏸ 멈춤: <기다리는 것>" 줄이 있으면 "끝" 대신 멈춤으로 알리고 사건 plan.stop 을 남긴다
stop_events() { cat "$DATA/state/events.jsonl" "$BODY/.events.jsonl" 2>/dev/null | grep -c '"type":"plan.stop"'; }
hook prompt '{"prompt":"멈춤 1"}'; hook stop '{"last_assistant_message":"⏸ 멈춤: 지표 탭 캡처 확인 — \"넘겨\" 를 기다림\n\n바뀐 것 …"}'
check "훅 입력 last_assistant_message 의 멈춤 줄로 멈춤 알림" "$(last_sent | grep -c '\[athena-studio-fe → 아테나\] ⏸ 멈춤 · p9 · 계획서 plans/task/x.md · Status in_progress · 지표 탭 캡처 확인 — "넘겨" 를 기다림')" 1
check "멈춤 알림은 사건 plan.stop 을 남긴다" "$(stop_events)" 1
REPLY_LOG="$WORK/reply.jsonl"
python3 - "$REPLY_LOG" <<'PY'
import json, sys
rows = [
    {"type": "user", "message": {"content": "해 줘"}},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "**⏸ 멈춤: 사용자 확인**\n요약"}]}},
    {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}},
]
open(sys.argv[1], "w").write("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
PY
hook prompt '{"prompt":"멈춤 2"}'; hook stop "{\"transcript_path\":\"$REPLY_LOG\"}"
check "입력에 없으면 대화 기록 끝의 마지막 assistant 글에서 찾는다(굵게 표시도)" "$(last_sent | grep -c '⏸ 멈춤 · p9 · .* · 사용자 확인')" 1
check "plan.stop 2번째" "$(stop_events)" 2
hook prompt '{"prompt":"평범"}'; hook stop '{"last_assistant_message":"다 했어요. 멈춤: 없음 이라 넘겼어요"}'
check "줄 머리에 ⏸ 멈춤 이 없으면 평소처럼 끝" "$(last_sent | grep -c '\] 끝 · p9')" 1
check "끝 알림은 plan.stop 을 남기지 않는다" "$(stop_events)" 2

# 담당 대화 확인 — lead-send 와 같은 소유권 검사. 계획서 Lead session 과 아테나 pane 의 대화가 다르면 넣지 않고 계획서에 기록
mkdir -p "$DATA/state/pane-sessions"
printf '{"session":"session-b"}' > "$DATA/state/pane-sessions/p1.json"
printf -- '- Lead session: session-a\n\n## 결과\n- (요약)\n' >> "$BODY/$PLAN"
before="$(sent)"
hook prompt '{"prompt":"다른 대화"}'; hook stop
check "담당 대화가 바뀌었으면 끝 알림을 넣지 않는다" "$(sent)" "$before"
check "넣지 못한 끝 알림은 계획서 결과 절에 기록" "$(grep -c '담당 대화가 바뀌었거나 확인되지 않아요: \[athena-studio-fe → 아테나\] 끝 · p9' "$BODY/$PLAN")" 1
printf '{"session":"session-a"}' > "$DATA/state/pane-sessions/p1.json"
hook prompt '{"prompt":"같은 대화"}'; hook stop
check "담당 대화가 같으면 넣는다" "$(sent)" "$((before + 1))"

[ "$FAIL" = 0 ] && echo "모두 통과" || { echo "실패 있음"; exit 1; }
