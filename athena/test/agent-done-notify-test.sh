#!/usr/bin/env bash
# 위임 에이전트 끝 알림 훅 시험 — scripts/hooks/agent-done-notify.py(Stop · UserPromptSubmit).
# 가짜 화면 CLI · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 몇 초
#   같은 내용 중복 안 함 · 백그라운드 명령이 돌아도 알림(개수 표시) · 새 입력이 오면 다시 알림 · 멈춤 표시(⏸ 멈춤:)면 멈춤 알림 + plan.stop · 아테나가 알림에 답한 차례는 알리지 않음 · 아테나 pane 이 없거나 닫혔으면 조용히 · reviewer 도 보냄(D2)
#   차례 상태 파일(state/agent-turn) · 글로 묻고 끝낸 차례는 '질문으로 멈춤' · 고르기 질문(asking) 유지 · 넣은 알림은 받음 확인 기록(state/lead-notices)
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
cp "$SRC"/scripts/lib/*.py "$SRC"/scripts/lib/*.mjs "$SRC"/scripts/lib/*.json "$BODY/scripts/lib/" 2>/dev/null
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
# 현황판(turn-watch.mjs 5)이 '지시 없이 5분 대기' 를 알리려고 읽는 칸 — 첫 차례 · 끝 알림 건너뜀
check "시작 안내 턴은 차례 상태에 first · quiet" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("state"), d.get("first"), d.get("quiet"))' "$DATA/state/agent-turn/p9.json")" "done True True"
BOOTSTRAP=1 hook prompt '{"prompt":"첫 실제 요청"}'
check "다음 입력부터는 first 아님" "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("first"), d.get("quiet"))' "$DATA/state/agent-turn/p9.json")" "False False"
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
check "reviewer 도 끝 알림을 보낸다(계획서 결정 D2)" "$(sent)" 8
check "reviewer 알림 줄은 reviewer 이름으로" "$(grep '^pane run p1 ' "$FAKE_LOG" | tail -1 | grep -c '\[reviewer → 아테나\] 끝 · p9')" 1
env -u ATHENA_AGENT ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 python3 "$BODY/scripts/hooks/agent-done-notify.py" stop </dev/null
check "ATHENA_AGENT 없는 세션(사람이 쓰는 아테나)은 보내지 않는다" "$(sent)" 8

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
check "백그라운드 명령이 도는 중이어도 알린다" "$(sent)" 9
check "알림 줄에 도는 백그라운드 명령 개수가 붙는다" "$(grep '^pane run p1 ' "$FAKE_LOG" | tail -1 | grep -c ' · (백그라운드 명령 1개 도는 중)$')" 1
hook stop "$STOP_JSON"
check "같은 줄은 새 입력 전에는 다시 보내지 않는다" "$(sent)" 9
kill "$SLEEP_PID" 2>/dev/null; wait "$SLEEP_PID" 2>/dev/null
hook stop "$STOP_JSON"
check "끝 기록 없이 프로세스가 죽었으면 개수 없는 줄로 한 번 더 알린다" "$(sent)" 10
check "명령이 끝난 뒤 줄에는 개수가 없다" "$(grep '^pane run p1 ' "$FAKE_LOG" | tail -1 | grep -c '백그라운드 명령')" 0

sleep 60 > "$OUTPUT" 2>&1 &
SLEEP_PID=$!
hook prompt '{"prompt":"끝 기록"}'; hook stop "$STOP_JSON"
check "다시 도는 중이면 개수를 붙여 알린다" "$(sent)" 11
printf '%s\n' '{"type":"queue-operation","content":"<task-notification>\n<task-id>task1</task-id>\n<status>completed</status>"}' >> "$TRANSCRIPT"
hook stop "$STOP_JSON"
check "끝 기록(task-notification)이 있으면 도는 중으로 세지 않는다" "$(sent)" 12
sed -i.bak '$d' "$TRANSCRIPT"
hook prompt '{"prompt":"멈춤"}'; hook stop "$STOP_JSON"
check "끝 기록을 지우면 다시 도는 중으로 센다" "$(grep '^pane run p1 ' "$FAKE_LOG" | tail -1 | grep -c '(백그라운드 명령 1개 도는 중)')" 1
printf '%s\n' '{"type":"user","toolUseResult":{"message":"Successfully stopped task: task1","task_id":"task1"}}' >> "$TRANSCRIPT"
hook stop "$STOP_JSON"
check "TaskStop 기록이 있으면 도는 중으로 세지 않는다" "$(sent)" 14
kill "$SLEEP_PID" 2>/dev/null; wait "$SLEEP_PID" 2>/dev/null

hook prompt '{"prompt":"기록 없음"}'; hook stop '{"transcript_path":"/없는/경로.jsonl"}'
check "대화 기록을 못 읽으면 평소대로 알린다" "$(sent)" 15

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

# 차례 상태 파일 · 질문으로 멈춤 · 받음 확인 기록(계획서 B · D3 · C)
turn() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2]))' "$DATA/state/agent-turn/p9.json" "$1"; }
notices() { ls "$DATA/state/lead-notices" 2>/dev/null | grep -cE '^[0-9a-f]{32}\.json$'; }
hook prompt '{"prompt":"차례 1"}'
check "입력을 받으면 차례 상태 working" "$(turn state)" working
before_notices="$(notices)"
hook stop '{"last_assistant_message":"다 했어요."}'
check "끝나면 차례 상태 done" "$(turn state)" done
check "끝 차례는 question False" "$(turn question)" False
check "넣은 끝 알림은 받음 확인 기록을 하나 남긴다(--track)" "$(notices)" "$((before_notices + 1))"
check "받음 확인 기록에 아테나 pane · 줄이 든다" "$(grep -l '"lead": "p1"' "$DATA"/state/lead-notices/*.json | xargs grep -l '끝 · p9' | wc -l | tr -d ' ' | grep -c '^[1-9]')" 1
hook prompt '{"prompt":"차례 2"}'
hook stop '{"last_assistant_message":"고쳤어요.\n\n커밋할까요?"}'
check "글로 묻고 끝낸 차례는 '질문으로 멈춤'" "$(last_sent | grep -c '\[athena-studio-fe → 아테나\] 질문으로 멈춤 · p9')" 1
check "글로 물은 차례는 차례 상태 done · question True(asking 은 요청을 올린 차례만)" "$(turn state) $(turn question)" "done True"
hook prompt '{"prompt":"차례 3"}'
python3 - "$BODY" <<'PY'
import sys; sys.path.insert(0, sys.argv[1] + '/scripts/lib')
import agent_turn; agent_turn.write_turn('p9', state='asking', requests=['r1'])
PY
hook stop '{"last_assistant_message":"골라 주세요 — 요청을 열었어요"}'
check "고르기 질문(asking)을 올린 차례는 끝나도 질문으로 멈춤" "$(turn state) $(last_sent | grep -c '질문으로 멈춤 · p9')" "asking 1"
cat > "$WORK/received.py" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib')
import agent_turn
folder = agent_turn.pack_state() / 'lead-notices'
latest = max(folder.glob('*.json'), key=lambda path: json.loads(path.read_text())['sent_at'])
notice = json.loads(latest.read_text())
# 대기 입력이 이어 붙어 오고 줄바꿈이 섞여도 받음으로 — 한 번만 · 다른 아테나 pane 은 아니다
print(len(agent_turn.mark_received('p1', '앞 입력\n' + notice['text'].replace(' · ', '  ·\n'))) > 0,   # 같은 줄을 두 번 넣었으면 둘 다
      bool(json.loads(latest.read_text()).get('received_at')),
      len(agent_turn.mark_received('p1', notice['text'])),
      len(agent_turn.mark_received('p2', notice['text'])))
PY
check "아테나가 받은 입력에 든 알림은 받음으로 표시(공백 차이 무시 · 한 번 · 그 아테나 pane 만)" "$(python3 "$WORK/received.py" "$BODY")" "True True 0 0"

# 같은 차례에 에이전트가 lead-send.py 로 직접 보고했으면 Stop 의 "끝" 줄은 따로 넣지 않는다 — 아테나가 한 차례에 두 번 깨지 않게
# (2026-11-11 리드 기록: 직접 보고 뒤 끝 줄이 연달아 와 두 번 깼다). 멈춤 · 질문 · 보고 뒤 Status · PR 이 바뀐 차례는 그대로 알린다
report() {   # <글> — 에이전트 pane p9 에서 직접 보고(--track 없이)
  env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/bin/athena-studio-cli" \
    ATHENA_AGENT="${AGENT:-athena-studio-fe}" ATHENA_PLAN="$PLAN" FAKE_LOG="$FAKE_LOG" PATH="$WORK/bin:$PATH" WAITING_FILE="$WORK/waiting" \
    python3 "$BODY/scripts/lead-send.py" p1 "$1" --plan "$PLAN" >/dev/null
}
reported_notices() { grep -l '직접 보고' "$DATA"/state/lead-notices/*.json 2>/dev/null | wc -l | tr -d ' '; }
hook prompt '{"prompt":"보고 1"}'
before="$(sent)"
report '[athena-studio-fe → 아테나] 직접 보고 1 — 리뷰 반영 커밋'
hook stop '{"last_assistant_message":"보고했어요."}'
check "직접 보고한 차례는 끝 줄을 따로 넣지 않는다(보고 한 번만)" "$(sent)" "$((before + 1))"
check "끝 줄을 안 넣어도 차례 상태는 done" "$(turn state)" done
check "직접 보고는 받음 확인 대상으로 남는다(현황판 다시 넣기)" "$(reported_notices)" 1
hook prompt '{"prompt":"보고 2"}'
before="$(sent)"
report '[athena-studio-fe → 아테나] 직접 보고 2'
hook stop '{"last_assistant_message":"⏸ 멈춤: 사용자 확인"}'
check "직접 보고한 차례도 멈춤이면 멈춤 알림은 간다" "$(sent) $(last_sent | grep -c '⏸ 멈춤 · p9')" "$((before + 2)) 1"
hook prompt '{"prompt":"보고 3"}'
before="$(sent)"
report '[athena-studio-fe → 아테나] 직접 보고 3'
hook stop '{"last_assistant_message":"커밋할까요?"}'
check "직접 보고한 차례도 질문으로 끝내면 질문 알림은 간다" "$(sent) $(last_sent | grep -c '질문으로 멈춤 · p9')" "$((before + 2)) 1"
hook prompt '{"prompt":"보고 4"}'
before="$(sent)"
report '[athena-studio-fe → 아테나] 직접 보고 4'
sed -i.bak 's/^- Status:.*/- Status: ready_for_review/' "$BODY/$PLAN"
hook stop '{"last_assistant_message":"다 했어요."}'
check "보고 뒤 Status · PR 이 바뀌었으면 끝 줄을 넣는다" "$(sent) $(last_sent | grep -c '\] 끝 · p9 · .* · Status ready_for_review')" "$((before + 2)) 1"
hook prompt '{"prompt":"보고 없음"}'
before="$(sent)"
hook stop '{"last_assistant_message":"다 했어요 2."}'
check "다음 차례에 보고가 없으면 끝 줄을 넣는다(옛 차례 보고로 막지 않는다)" "$(sent)" "$((before + 1))"

# 결과 요약 — 마지막 답(보고)의 절마다 첫 줄을 끝 줄 뒤에 ' — 요약: a / b' 로(아테나가 pane 을 읽으러 가지 않게 · 2026-11-12)
hook prompt '{"prompt":"요약 1"}'
hook stop '{"last_assistant_message":"## 1. 무엇이 달라졌나\n- 버튼 문구 고침\n- 둘째 줄\n\n## 2. 어디서 확인하나\n- PR #7 (draft)\n\n## 3. 검증 결과\n| a | b |\n|---|---|\n```\n출력\n```\n전체 검증 미실행(커밋 때 돈다)\n\n## 4. 남은 일\n- 없음"}'
check "절마다 첫 줄을 요약으로 싣는다(표 · 코드 블록 · 제목은 뺀다)" "$(last_sent | grep -c '\] 끝 · p9 · .* — 요약: 버튼 문구 고침 / PR #7 (draft) / 전체 검증 미실행(커밋 때 돈다) / 없음$')" 1
hook prompt '{"prompt":"요약 2"}'
long="$(python3 -c 'print("\\n".join(f"{i}번 " + "가" * 200 for i in range(9)))')"
hook stop "{\"last_assistant_message\":\"$long\"}"
check "요약은 5줄 · 줄당 120자 · 전체 480자 상한" "$(last_sent | python3 -c 'import sys; s=sys.stdin.read().split(" — 요약: ",1)[1].strip().split(" / "); print(len(s) <= 5 and all(len(x) <= 120 for x in s) and sum(map(len, s)) <= 480)')" True
before="$(sent)"
hook stop '{"last_assistant_message":"다른 보고"}'
check "같은 차례에 요약만 달라진 Stop 은 다시 넣지 않는다(중복 막기는 요약을 뺀 줄)" "$(sent)" "$before"

[ "$FAIL" = 0 ] && echo "모두 통과" || { echo "실패 있음"; exit 1; }
