#!/usr/bin/env bash
# 에이전트 → 아테나 보내기 시험 — scripts/lead-send.py(받을 수 없으면 모아 뒀다 넣기 · 요청은 열지 않음 · 못 넣으면 계획서 기록).
# 가짜 화면 CLI · 가짜 bin/athena · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 15초 안팎
#   바로 보냄 · 선택 창이면 모아 둠 → 닫히면 차례대로 넣음 · 앞에 미룬 글 뒤에 줄 섬
#   받을 pane 이 닫힘 → 계획서 Lead pane 이 살아 있으면 그쪽 / 담당도 닫혔으면 떠 있는 아테나에게 넘김(focused → 최근 · 계획서 담당 바꿈 · F4) / 없으면 모아 둠
#   오래 기다림 · 전송 확인 실패(다시 넣지 않음) · 옛 구조는 기록만 · 어느 갈래도 요청(question)을 열지 않음 · 사용법
#
# 사용: test/lead-send-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
FAIL=0

BODY="$WORK/body"; DATA="$WORK/data"
mkdir -p "$BODY/scripts/lib" "$BODY/bin" "$BODY/plans/task" "$DATA/state"
cp "$SRC/scripts/lead-send.py" "$BODY/scripts/"
cp "$SRC"/scripts/lib/*.py "$SRC"/scripts/lib/*.mjs "$SRC"/scripts/lib/*.json "$BODY/scripts/lib/"   # .mjs — 사건 기록(events.mjs)
ln -s "$DATA" "$BODY/.pack-data"
QUEUE="$DATA/state/lead-send"
EVENTS="$DATA/state/events.jsonl"
PLAN="$BODY/plans/task/x.md"

# 가짜 화면 CLI — 받은 인자를 로그에. waiting 파일이 있으면 화면에 고르기 창 · waiting-run 이면 pane run 을 데몬처럼 거절,
# timeout 이면 전송 확인 실패 · closed 에 적힌 pane 은 없음 · panes 파일(JSON 배열)이 pane list
# receive-on-send 면 넣자마자(lead-send 가 돌아오기 전에) 아테나 입력 훅처럼 받음 표시를 한다(agent_turn.mark_received)
mkdir -p "$WORK/cli"
cat > "$WORK/cli/athena-studio-cli" <<'CLIEOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case " $(cat "$FAKE_DIR/closed" 2>/dev/null) " in *" $3 "*) [ "$1" = pane ] && [ -n "${3:-}" ] && { echo '{"error":"not_found","message":"없는 pane"}' >&2; exit 1; } ;; esac
case "$1 $2" in
  'pane list') printf '{"panes":%s}\n' "$(cat "$FAKE_DIR/panes" 2>/dev/null || echo '[]')" ;;
  'pane get') echo "{\"pane\":{\"id\":\"$3\"}}" ;;
  'pane read') if [ -f "$FAKE_DIR/waiting" ]; then printf '질문\n❯ 1. 예\nEnter to select · ↑/↓ to navigate · Esc to cancel\n'; else printf '❯ \n'; fi ;;
  'pane run')
    if [ -f "$FAKE_DIR/waiting-run" ]; then echo '{"error":"unavailable","message":"입력을 기다리는 질문이 열려 있다"}' >&2; exit 1; fi
    if [ -f "$FAKE_DIR/timeout" ]; then echo '{"error":"timeout","message":"입력 전송을 확인하지 못했다 — pane 입력칸을 확인해 주세요"}' >&2; exit 1; fi
    echo "SENT $3 $4" >> "$FAKE_DIR/sent"
    if [ -f "$FAKE_DIR/receive-on-send" ]; then python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import agent_turn; agent_turn.mark_received(sys.argv[2], sys.argv[3])' "$FAKE_BODY/scripts/lib" "$3" "$4"; fi ;;
esac
exit 0
CLIEOF
chmod +x "$WORK/cli/athena-studio-cli"
# 가짜 요청 명령 — 불리면 적는다(이 명령은 어느 갈래에서도 요청을 열지 않아야 한다)
cat > "$BODY/bin/athena" <<'ATHEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DIR/requests"
echo '{"ok":true,"request":{"id":"r-test"}}'
ATHEOF
chmod +x "$BODY/bin/athena"

export FAKE_DIR="$WORK"; export FAKE_LOG="$WORK/log"; export FAKE_BODY="$BODY"
trap 'rm -rf "$WORK"' EXIT   # 남은 처리기는 대기열 폴더가 없어지면 스스로 끝난다

lead_send() {   # <글> [추가 인자…] — 에이전트 pane p9 에서 아테나 pane p1 으로
  env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/cli/athena-studio-cli" \
    ATHENA_AGENT="${AGENT-athena-studio-fe}" ATHENA_PLAN="${PLAN_REL-plans/task/x.md}" python3 "$BODY/scripts/lead-send.py" "${LEAD:-p1}" "$@"
}
count() { if [ -f "$1" ]; then grep -c "${2:-.}" "$1"; else echo 0; fi; }
queued() { find "$QUEUE" -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }
# 받음 확인 기록(state/lead-notices · scripts/lib/agent_turn.py) — 개수 · <kind> 와 글이 든 기록 수
notices() { ls "$DATA/state/lead-notices" 2>/dev/null | grep -cE '^[0-9a-f]{32}\.json$'; }
notice_with() { python3 -c 'import json,pathlib,sys; print(sum(1 for p in pathlib.Path(sys.argv[1]).glob("*.json") if (d:=json.loads(p.read_text())).get("kind")==sys.argv[2] and sys.argv[3] in d.get("text","") and d.get("lead")=="p1"))' "$DATA/state/lead-notices" "$1" "$2" 2>/dev/null || echo 0; }
check() { if [ "$2" = "$3" ]; then echo "  ✔ $1"; else echo "  ✖ $1 (기대 $3 · 실제 $2)"; FAIL=1; fi; }
wait_until() {   # <조건 명령> — 최대 15초
  for _ in $(seq 1 75); do eval "$1" && return 0; sleep 0.2; done; return 1
}
# 가짜 pane 목록 — <id>:<agent>:<cwd 종류 body|other>:<이름>:<focused true|false> …
panes() {
  local out='' item id agent where label focused cwd
  for item in "$@"; do
    IFS=: read -r id agent where label focused <<< "$item"
    cwd="$BODY"; [ "$where" = body ] || cwd="$WORK/other"
    out="$out${out:+,}{\"id\":\"$id\",\"agent\":\"$agent\",\"cwd\":\"$cwd\",\"label\":\"$label\",\"focused\":$focused}"
  done
  printf '[%s]' "$out" > "$WORK/panes"
}
plan_lines() { grep -c "아테나(pane $1)에 못 보낸 글" "$PLAN"; }
reset() {
  rm -f "$WORK/sent" "$WORK/requests" "$WORK/waiting" "$WORK/waiting-run" "$WORK/timeout" "$WORK/closed" "$WORK/panes" "$WORK/receive-on-send" "$EVENTS"; rm -rf "$QUEUE" "$DATA/state/lead-notices"
  printf '# x\n\n## Checkpoint\n- Status: in_progress\n- Lead pane: %s\n\n## 결과\n- (요약)\n\n## Commits\n- (없음)\n' "${1:-p1}" > "$PLAN"
}

echo "▶ 위임 발신자의 ID·역할·대화 검증 — delegate.sh --caller 경로"
python3 - "$BODY" <<'PYTEST'
import importlib.util, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('lead_send', root / 'scripts/lead-send.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Backend:
    def self_info(self):
        return {'inside': True, 'pane_id': 'p1'}
    def get_pane(self, pane):
        if pane == 'closed':
            raise ValueError('없는 pane')
        return {'id': pane, 'cwd': str(root), 'agent': 'codex'}
backend = Backend()
module.screen.get_backend = lambda: backend
module.pane_session = lambda pane: 'session-a'
os.environ['CODEX_THREAD_ID'] = 'session-a'
assert module.caller_lead() == ('p1', 'session-a')
for identity, record, thread in [
    ('closed', {}, 'session-a'),
    ('p1', {'cwd': '/other', 'agent': 'codex'}, 'session-a'),
    ('p1', {'cwd': str(root), 'agent': 'codex', 'label': '🤖 worker'}, 'session-a'),
    ('p1', {'cwd': str(root), 'agent': 'codex'}, 'session-b'),
]:
    backend.self_info = lambda: {'inside': True, 'pane_id': identity}
    def get_pane(pane):
        if identity == 'closed':
            raise ValueError('없는 pane')
        return {'id': pane, **record}
    backend.get_pane = get_pane
    os.environ['CODEX_THREAD_ID'] = thread
    try:
        module.caller_lead()
    except ValueError:
        continue
    raise AssertionError((identity, record, thread))
backend.self_info = lambda: {'inside': True, 'pane_id': 'p1;x'}
try:
    module.caller_lead()
    raise AssertionError('틀린 모양의 pane ID 가 통과했다')
except ValueError:
    pass
backend.self_info = lambda: {'inside': False}
assert module.caller_lead() == ('', '')
# 앱 · 현황판이 부름 — 화면 안(ATHENA_STUDIO=1)이지만 pane ID 가 없다
backend.self_info = lambda: {'inside': True, 'pane_id': ''}
assert module.caller_lead() == ('', '')
print('  ✔ 정상 담당·닫힌 ID·다른 본체·위임 pane·다른 대화·틀린 ID·화면 밖·pane 없는 앱')
PYTEST
check "위임 발신자 검증" "$?" 0

echo "▶ 바로 보냄"
reset
out="$(lead_send '[fe → 아테나] 끝 A')"; code=$?
check "종료 0" "$code" 0
check "✅ 출력" "${out:0:1}" "✅"
check "한 번 넣음" "$(count "$WORK/sent" 'SENT p1 \[fe → 아테나\] 끝 A')" 1
check "요청 없음" "$(count "$WORK/requests")" 0
check "대기열 없음" "$(queued)" 0
check "에이전트 직접 보고는 --track 없어도 받음 확인 기록(kind turn) — 그 차례의 끝 줄을 대신한다" "$(notice_with turn '끝 A')" 1
out="$(AGENT= lead_send '[fe → 아테나] 끝 A2')"
check "에이전트가 아닌 쪽이 --track 없이 넣은 글은 받음 확인 기록 없음" "$(notice_with turn '끝 A2')" 0
out="$(lead_send '[fe → 아테나] 끝 B' --track)"
check "--track 이면 넣은 글을 받음 확인 기록(kind turn)으로" "$(notice_with turn '끝 B')" 1
received_with() { python3 -c 'import json,pathlib,sys; print(sum(1 for p in pathlib.Path(sys.argv[1]).glob("*.json") if sys.argv[2] in (d:=json.loads(p.read_text())).get("text","") and d.get("received_at") and not d.get("pending")))' "$DATA/state/lead-notices" "$1" 2>/dev/null || echo 0; }
touch "$WORK/receive-on-send"
out="$(lead_send '[fe → 아테나] 끝 C' --track)"
check "넣자마자 아테나 입력 훅이 돌아도 받음 표시가 남는다(기록을 넣기 전에 만든다)" "$(received_with '끝 C')" 1
check "그 기록은 하나뿐(넣은 뒤 새로 만들지 않는다)" "$(notice_with turn '끝 C')" 1
rm -f "$WORK/receive-on-send"
check "--track 없이 넣은 글은 기록을 남기지 않는다(넣기 전 기록은 지운다)" "$(notice_with unconfirmed '끝 A')" 0

echo "▶ 고르기 창 → 요청 없이 모아 뒀다 닫히면 차례대로"
reset
touch "$WORK/waiting"
out="$(lead_send '첫째')"; code=$?
check "종료 0" "$code" 0
check "⏳ 출력" "${out:0:1}" "⏳"
lead_send '둘째' > /dev/null
check "대기열 2개" "$(queued)" 2
sleep 2.5
check "창이 떠 있는 동안 안 넣음" "$(count "$WORK/sent")" 0
check "요청 없음" "$(count "$WORK/requests")" 0
rm -f "$WORK/waiting"
wait_until '[ "$(queued)" = 0 ] && [ "$(count "$WORK/sent")" = 2 ]'
check "닫히자 둘 다 넣음" "$(count "$WORK/sent")" 2
check "들어온 차례" "$(sed -n '1s/^SENT p1 //p' "$WORK/sent")-$(sed -n '2s/^SENT p1 //p' "$WORK/sent")" "첫째-둘째"
check "요청 없음" "$(count "$WORK/requests")" 0

echo "▶ 화면 읽기는 통과했는데 데몬이 질문 대기로 거절 → 모아 둠"
reset
touch "$WORK/waiting-run"
out="$(lead_send '셋째')"
check "⏳ 출력" "${out:0:1}" "⏳"
check "요청 없음" "$(count "$WORK/requests")" 0
rm -f "$WORK/waiting-run"
wait_until '[ "$(queued)" = 0 ]'
check "넣음" "$(count "$WORK/sent" '셋째')" 1

echo "▶ 앞에 미룬 글이 있으면 pane 이 비어 있어도 뒤에 줄 선다"
reset
mkdir -p "$QUEUE"
printf '{"lead":"p1","text":"앞 글","plan":"","pane":"p9","from":"fe","at":%s}\n' "$(date +%s)" > "$QUEUE/p1-1-aaaaaa.json"
out="$(lead_send '뒤 글')"
check "⏳ 출력" "${out:0:1}" "⏳"
wait_until '[ "$(queued)" = 0 ] && [ "$(count "$WORK/sent")" = 2 ]'
check "앞 글 → 뒤 글" "$(sed -n '1s/^SENT p1 //p' "$WORK/sent")-$(sed -n '2s/^SENT p1 //p' "$WORK/sent")" "앞 글-뒤 글"

echo "▶ 받을 pane 이 닫힘 · 계획서 Lead pane 이 살아 있음 → 그 pane 으로"
reset p3
echo p1 > "$WORK/closed"
panes p2:claude:body:아테나:false p4:codex:body:아테나:false
out="$(lead_send '계획서 아테나로')"; code=$?
check "종료 0" "$code" 0
check "✅ 출력" "${out:0:1}" "✅"
check "p3 에 넣음" "$(count "$WORK/sent" '^SENT p3 계획서 아테나로')" 1
check "요청 없음" "$(count "$WORK/requests")" 0

echo "▶ 담당이 닫힘 · 떠 있는 아테나 → 넘기고 계획서 담당을 바꿈(F4 · focused → 가장 최근에 쓴 순)"
used() { mkdir -p "$DATA/state/pane-sessions"; printf '{"pane":"%s","session":"%s","at":"%s"}\n' "$1" "$2" "$3" > "$DATA/state/pane-sessions/$1.json"; }
reset
printf -- '- Lead session: session-old\n' >> "$PLAN"
echo p1 > "$WORK/closed"
used p2 session-two 2026-11-26T01:00:00+00:00; used p4 session-four 2026-11-26T02:00:00+00:00
panes p2:codex:body:아테나:true p4:claude:body:아테나:false p5:claude:body:'🤖 web-fe':false p6:claude:other:아테나:false p9:claude:body:아테나:false
out="$(lead_send '넘길 글')"; code=$?
check "종료 0 · ✅" "$code ${out:0:1}" "0 ✅"
check "보고 있는(focused) 아테나 p2 에 표시를 붙여 넣음" "$(count "$WORK/sent" '^SENT p2 \[이어받음 · 원래 담당 p1 닫힘\] 계획서 plans/task/x.md 넘길 글$')" 1
check "다른 pane 에는 넣지 않음" "$(count "$WORK/sent")" 1
check "계획서 Lead pane · Lead session 이 이어받은 아테나로(한 줄씩)" "$(grep -c '^- Lead pane: p2$' "$PLAN") $(grep -c '^- Lead session: session-two$' "$PLAN") $(grep -c '^- Lead ' "$PLAN")" "1 1 2"
check "사건 lead-takeover" "$(count "$EVENTS" '"type":"lead-takeover"')" 1
check "요청 없음 · 모아 둔 글 없음" "$(count "$WORK/requests") $(queued)" "0 0"
# 원래 담당이 돌아와도 담당은 이어받은 아테나 하나 — 다음 글은 표시 없이 p2 로
rm -f "$WORK/closed"
lead_send '다음 글' > /dev/null
check "원래 담당이 돌아와도 이어받은 아테나에게만(표시는 처음 한 번)" "$(count "$WORK/sent" '^SENT p2 다음 글$') $(count "$WORK/sent" '^SENT p1 ')" "1 0"
rm -f "$DATA/state/pane-sessions/p2.json" "$DATA/state/pane-sessions/p4.json"

reset
echo p1 > "$WORK/closed"
used p2 session-two 2026-11-26T01:00:00+00:00; used p4 session-four 2026-11-26T02:00:00+00:00
panes p2:codex:body:아테나:false p4:claude:body:아테나:false
lead_send '최근 순 글' > /dev/null
check "보고 있는 아테나가 없으면 가장 최근에 쓴 아테나 p4" "$(count "$WORK/sent" '^SENT p4 \[이어받음 · 원래 담당 p1 닫힘\] ') $(grep -c '^- Lead pane: p4$' "$PLAN")" "1 1"
rm -f "$DATA/state/pane-sessions/p2.json" "$DATA/state/pane-sessions/p4.json"

echo "▶ 계획서 폴더 밖 파일은 넘기기로 고쳐 쓰지 않음(.. 통과 · 절대 경로 — 보안 검토)"
reset
echo p1 > "$WORK/closed"
panes p2:claude:body:아테나:true
printf -- '- Lead pane: p1\n' > "$BODY/outside.md"
PLAN_REL='plans/../outside.md' lead_send '밖 글 하나' > /dev/null
PLAN_REL="$BODY/outside.md" lead_send '밖 글 둘' > /dev/null
check "폴더 밖 파일의 Lead pane 그대로 · 사건 없음" "$(grep -c '^- Lead pane: p1$' "$BODY/outside.md") $(count "$EVENTS" '"type":"lead-takeover"')" "1 0"
rm -f "$BODY/outside.md"; rm -rf "$DATA/state/lead-send"

echo "▶ 담당이 닫힘 · 떠 있는 아테나 없음 → 모아 뒀다가 아테나가 뜨면 넘김 · 원래 담당이 돌아오면 그쪽으로"
reset
echo p1 > "$WORK/closed"
panes p5:claude:body:'🤖 web-fe':true p6:claude:other:아테나:false
out="$(lead_send '기다리는 글')"
check "⏳ 출력" "${out:0:1}" "⏳"
sleep 2.5
check "에이전트 pane · 다른 본체 pane 에는 넣지 않음 · 담당 그대로" "$(count "$WORK/sent") $(grep -c '^- Lead pane: p1$' "$PLAN")" "0 1"
panes p5:claude:body:'🤖 web-fe':true p4:claude:body:아테나:false
wait_until '[ "$(queued)" = 0 ]'
check "아테나가 뜨자 표시를 붙여 넘김" "$(count "$WORK/sent" '^SENT p4 \[이어받음 · 원래 담당 p1 닫힘\] 계획서 plans/task/x.md 기다리는 글$') $(grep -c '^- Lead pane: p4$' "$PLAN")" "1 1"
reset
echo p1 > "$WORK/closed"
lead_send '돌아오면 넣을 글' > /dev/null
sleep 2.5
rm -f "$WORK/closed"
wait_until '[ "$(queued)" = 0 ]'
check "떠 있는 아테나 없이 원래 담당이 돌아오면 그대로 넣음" "$(count "$WORK/sent" '^SENT p1 돌아오면 넣을 글$')" 1

echo "▶ 담당이 살아 있는데 잠깐 못 받음 → 넘기지 않음"
reset
touch "$WORK/waiting"
panes p2:codex:body:아테나:true
out="$(lead_send '잠깐 못 받는 글')"
check "⏳ 출력" "${out:0:1}" "⏳"
sleep 2.5
check "다른 아테나에 넣지 않음 · 담당 그대로" "$(count "$WORK/sent") $(grep -c '^- Lead pane: p1$' "$PLAN")" "0 1"
rm -f "$WORK/waiting"
wait_until '[ "$(queued)" = 0 ]'
check "창이 닫히자 원래 담당에게" "$(count "$WORK/sent" '^SENT p1 잠깐 못 받는 글$')" 1

echo "▶ 잘못된 인자가 살아 있어도 계획서 담당을 우선"
reset p3
out="$(lead_send '명시한 담당으로')"
check "p3에만 넣음" "$(count "$WORK/sent" '^SENT p3 명시한 담당으로')" 1
check "p1에는 넣지 않음" "$(count "$WORK/sent" '^SENT p1 ')" 0

echo "▶ 대기 중 계획서 재배정을 따라감"
reset
touch "$WORK/waiting"
lead_send '재배정한 글' > /dev/null
sed -i '' 's/Lead pane: p1/Lead pane: p2/' "$PLAN"
rm -f "$WORK/waiting"
wait_until '[ "$(queued)" = 0 ]'
check "계획서 재배정 후 p2에 넣음(표시 없이)" "$(count "$WORK/sent" '^SENT p2 재배정한 글$')" 1

echo "▶ 대기 중 같은 pane의 대화가 바뀌면 기록만"
reset
mkdir -p "$DATA/state/pane-sessions"
printf '{"session":"session-a"}' > "$DATA/state/pane-sessions/p1.json"
touch "$WORK/waiting"
lead_send '옛 대화 보고' > /dev/null
printf '{"session":"session-b"}' > "$DATA/state/pane-sessions/p1.json"
rm -f "$WORK/waiting"
wait_until '[ "$(queued)" = 0 ]'
check "새 대화에 넣지 않음" "$(count "$WORK/sent")" 0
check "계획서에 소유권 오류" "$(grep -c '담당 대화가 바뀌었거나 확인되지 않아요: 옛 대화 보고$' "$PLAN")" 1
rm -f "$DATA/state/pane-sessions/p1.json"

echo "▶ 계획서에 묶인 담당 대화가 바뀌면 즉시 전송하지 않음"
reset
mkdir -p "$DATA/state/pane-sessions"
printf '{"session":"session-b"}' > "$DATA/state/pane-sessions/p1.json"
sed -i '' '/Lead pane: p1/a\
- Lead session: session-a\
' "$PLAN"
out="$(lead_send '다른 대화로 보내지 않음')"
check "⚠️ 기록" "${out:0:2}" "⚠️"
check "새 대화에 넣지 않음" "$(count "$WORK/sent")" 0
rm -f "$DATA/state/pane-sessions/p1.json"

# 2026-11-04 px5 실측 — 아테나 pane 안에서 플러그인이 띄운 headless claude(-p · 진입점 sdk-cli)의 훅이 pane 기록을 자기 대화로 덮어
# 계획서 Lead session 과 달라졌고, lead-send 가 "담당 대화가 바뀌었거나…" 로 막혔다. headless 실행은 pane 의 대화가 아니라 기록하지 않는다
echo "▶ 담당 pane 안에서 돈 headless claude 는 담당 대화 기록을 바꾸지 않는다"
reset
mkdir -p "$DATA/state/pane-sessions" "$BODY/scripts/hooks"
cp "$SRC/scripts/hooks/pane-session.py" "$BODY/scripts/hooks/"
fire_session() {   # <session> <진입점> — 아테나 pane p1 안에서 그 진입점으로 SessionStart 훅
  printf '{"session_id":"%s","cwd":"%s"}' "$1" "$BODY" | env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_SOCKET=/x \
    ATHENA_STUDIO_CLI="$WORK/cli/athena-studio-cli" CLAUDE_CODE_ENTRYPOINT="$2" python3 "$BODY/scripts/hooks/pane-session.py"
}
fire_session 0a0a0a0a-1111-2222-3333-444444444444 cli
fire_session 0b0b0b0b-1111-2222-3333-444444444444 sdk-cli
check "pane 기록은 대화형 대화 그대로" "$(count "$DATA/state/pane-sessions/p1.json" '0a0a0a0a-1111')" 1
sed -i '' '/Lead pane: p1/a\
- Lead session: 0a0a0a0a-1111-2222-3333-444444444444\
' "$PLAN"
out="$(lead_send 'headless 뒤 보고')"
check "✅ 담당에게 넣음" "${out:0:1}" "✅"
check "한 번 넣음" "$(count "$WORK/sent" '^SENT p1 headless 뒤 보고')" 1
fire_session 0c0c0c0c-1111-2222-3333-444444444444 cli
check "대화형 새 대화(/clear 등)는 그대로 기록" "$(count "$DATA/state/pane-sessions/p1.json" '0c0c0c0c-1111')" 1
rm -f "$DATA/state/pane-sessions/p1.json"

echo "▶ 너무 오래 못 넣음 → 계획서 기록만"
reset
touch "$WORK/waiting"
ATHENA_LEAD_SEND_GIVE_UP=1 lead_send '오래된 글' > /dev/null
wait_until '[ "$(queued)" = 0 ]'
check "넣지 않음" "$(count "$WORK/sent")" 0
check "요청 없음" "$(count "$WORK/requests")" 0
check "계획서에 6시간" "$(grep -c '6시간 동안 아테나가 받을 수 없었어요: 오래된 글$' "$PLAN")" 1

echo "▶ 전송 확인 실패 → 다시 넣지 않고 계획서 기록만"
reset
touch "$WORK/timeout"
out="$(lead_send '확인 실패')"; code=$?
check "종료 0" "$code" 0
check "⚠️ 출력" "${out:0:2}" "⚠️"
check "pane run 한 번만" "$(count "$FAKE_LOG" '^pane run p1 확인 실패')" 1
check "요청 없음" "$(count "$WORK/requests")" 0
check "계획서에 입력칸 안내" "$(grep -c '입력칸에 남았을 수 있어 다시 넣지 않았어요: 확인 실패$' "$PLAN")" 1
check "대기열 없음" "$(queued)" 0
check "전송 확인 실패는 받음 확인 기록(kind unconfirmed) — 현황판이 다시 넣기 대상으로 본다" "$(notice_with unconfirmed '확인 실패')" 1

echo "▶ 계획서가 없고 전송 확인 실패 → ❌ · 글은 사건 기록에"
reset
touch "$WORK/timeout"
out="$(PLAN_REL='' lead_send '갈 곳 없는 글')"; code=$?
check "종료 1" "$code" 1
check "❌ 출력" "${out:0:1}" "❌"
check "요청 없음" "$(count "$WORK/requests")" 0
check "사건 기록에 글" "$(count "$EVENTS" '"written":false.*"text":"갈 곳 없는 글"')" 1

echo "▶ 옛 구조(팩 데이터 없음) · 아테나 pane 없음 → 계획서 기록만"
reset
rm "$BODY/.pack-data"
echo p1 > "$WORK/closed"
out="$(lead_send '옛 구조 글')"; code=$?
check "종료 0" "$code" 0
check "⚠️ 출력" "${out:0:2}" "⚠️"
check "요청 없음" "$(count "$WORK/requests")" 0
check "계획서에 글" "$(grep -c '아테나 pane 이 없어요: 옛 구조 글$' "$PLAN")" 1
ln -s "$DATA" "$BODY/.pack-data"

echo "▶ 아테나 상태 확인은 맡은 계획서의 pane 만(scripts/screen pane list --mine · F3)"
cp "$SRC/scripts/screen" "$BODY/scripts/screen"
reset
bound() { mkdir -p "$DATA/state/pane-sessions"; printf '{"pane":"%s","plan":"%s"}\n' "$1" "$2" > "$DATA/state/pane-sessions/$1.json"; }
printf -- '# 남의 일\n\n## Checkpoint\n- Status: in_progress\n- Lead pane: p2\n' > "$BODY/plans/task/y.md"
bound p5 plans/task/x.md; bound p6 plans/task/y.md
mkdir -p "$DATA/state/agent-turn"; printf '{"pane":"p5","state":"working","turn":"t1"}\n' > "$DATA/state/agent-turn/p5.json"
panes p1:claude:body:아테나:true p2:claude:body:아테나:false p5:claude:other:'🤖 web-fe':false p6:claude:other:'🤖 api-be':false p7:claude:other:'🤖 묶이지 않음':false
mine() { env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID="$1" ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/cli/athena-studio-cli" python3 "$BODY/scripts/screen" pane list --mine --format "${2:-ids}" | tr '\n' ' '; }
check "p1 이 맡은 계획서의 pane 만" "$(mine p1)" "p5 "
check "다른 아테나(p2)에게는 그쪽 pane 만" "$(mine p2)" "p6 "
check "한 줄 형식 — id · 이름표 · 차례 상태 · 계획서" "$(mine p1 brief)" "p5 · 🤖 web-fe · working · plans/task/x.md "
# 일하는 중인 pane 에 보낸 글(H5) — 데몬은 전송 확인을 못 해 timeout 을 내지만 글은 대기열에 들어간다. 오류 대신 queued
send_wait() { env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/cli/athena-studio-cli" ATHENA_WAIT_START_SECONDS=0 python3 "$BODY/scripts/screen" pane send-text "$1" '지시' --enter --wait-start 2>/dev/null; echo "rc=$?"; }
touch "$WORK/timeout"
check "일하는 중인 pane 은 timeout 이어도 queued" "$(send_wait p5 | tr '\n' ' ')" "queued rc=0 "
check "일하지 않는 pane 의 timeout 은 오류 그대로" "$(send_wait p6 | tr '\n' ' ')" "rc=1 "
rm -f "$WORK/timeout"
check "일하는 중이면 기다리지 않고 queued" "$(send_wait p5 | tr '\n' ' ')" "queued rc=0 "
check "쉬는 pane 은 지금처럼 idle" "$(send_wait p6 | tr '\n' ' ')" "idle rc=0 "
# 담당 없는 pane(H4) — 계획서 Lead pane 이 닫힌 pane(p8) · 비어 있는 것은 어느 아테나에게도 "담당 없음" 으로 보인다
printf -- '# 주인 없는 일\n\n## Checkpoint\n- Status: in_progress\n- Lead pane: p8\n' > "$BODY/plans/task/z.md"
bound p7 plans/task/z.md
check "닫힌 담당의 pane 은 담당 없음으로 따로" "$(mine p1 brief)" "p5 · 🤖 web-fe · working · plans/task/x.md 담당 없음 1개(계획서 Lead pane 이 비었거나 닫힌 pane) p7 · 🤖 묶이지 않음 · plans/task/z.md "
check "ids 형식은 맡은 pane 만 그대로" "$(mine p1)" "p5 "
rm -f "$DATA/state/pane-sessions/p7.json" "$BODY/plans/task/z.md"
rm -f "$DATA/state/pane-sessions/p5.json" "$DATA/state/pane-sessions/p6.json" "$DATA/state/agent-turn/p5.json" "$BODY/plans/task/y.md"

echo "▶ 사용법"
lead_send > /dev/null 2>&1; check "글 없음 → 2" "$?" 2
LEAD='p 1' lead_send 'x' > /dev/null 2>&1; check "pane 이름 이상 → 2" "$?" 2

exit "$FAIL"
