#!/usr/bin/env bash
# 에이전트 → 아테나 보내기 시험 — scripts/lead-send.py(받을 수 없으면 모아 뒀다 넣기 · 요청은 열지 않음 · 못 넣으면 계획서 기록).
# 가짜 화면 CLI · 가짜 bin/athena · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 15초 안팎
#   바로 보냄 · 선택 창이면 모아 둠 → 닫히면 차례대로 넣음 · 앞에 미룬 글 뒤에 줄 섬
#   받을 pane 이 닫힘 → 계획서 Lead pane · 하나뿐인 아테나 pane · 보고 있는 아테나 pane 으로 / 여러 개면 기록만 / 없으면 모아 뒀다 생기면 넣음
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
cp "$SRC"/scripts/lib/*.py "$SRC"/scripts/lib/*.mjs "$BODY/scripts/lib/"   # .mjs — 사건 기록(events.mjs)
ln -s "$DATA" "$BODY/.pack-data"
QUEUE="$DATA/state/lead-send"
EVENTS="$DATA/state/events.jsonl"
PLAN="$BODY/plans/task/x.md"

# 가짜 화면 CLI — 받은 인자를 로그에. waiting 파일이 있으면 화면에 고르기 창 · waiting-run 이면 pane run 을 데몬처럼 거절,
# timeout 이면 전송 확인 실패 · closed 에 적힌 pane 은 없음 · panes 파일(JSON 배열)이 pane list
mkdir -p "$WORK/cli"
cat > "$WORK/cli/athena-studio-cli" <<'CLIEOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case " $(cat "$FAKE_DIR/closed" 2>/dev/null) " in *" $3 "*) [ "$1" = pane ] && { echo '{"error":"not_found","message":"없는 pane"}' >&2; exit 1; } ;; esac
case "$1 $2" in
  'pane list') printf '{"panes":%s}\n' "$(cat "$FAKE_DIR/panes" 2>/dev/null || echo '[]')" ;;
  'pane get') echo "{\"pane\":{\"id\":\"$3\"}}" ;;
  'pane read') if [ -f "$FAKE_DIR/waiting" ]; then printf '질문\n❯ 1. 예\nEnter to select · ↑/↓ to navigate · Esc to cancel\n'; else printf '❯ \n'; fi ;;
  'pane run')
    if [ -f "$FAKE_DIR/waiting-run" ]; then echo '{"error":"unavailable","message":"입력을 기다리는 질문이 열려 있다"}' >&2; exit 1; fi
    if [ -f "$FAKE_DIR/timeout" ]; then echo '{"error":"timeout","message":"입력 전송을 확인하지 못했다 — pane 입력칸을 확인해 주세요"}' >&2; exit 1; fi
    echo "SENT $3 $4" >> "$FAKE_DIR/sent" ;;
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

export FAKE_DIR="$WORK"; export FAKE_LOG="$WORK/log"
trap 'rm -rf "$WORK"' EXIT   # 남은 처리기는 대기열 폴더가 없어지면 스스로 끝난다

lead_send() {   # <글> [추가 인자…] — 에이전트 pane p9 에서 아테나 pane p1 으로
  env ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 ATHENA_STUDIO_SOCKET=/x ATHENA_STUDIO_CLI="$WORK/cli/athena-studio-cli" \
    ATHENA_AGENT=athena-studio-fe ATHENA_PLAN="${PLAN_REL-plans/task/x.md}" python3 "$BODY/scripts/lead-send.py" "${LEAD:-p1}" "$@"
}
count() { if [ -f "$1" ]; then grep -c "${2:-.}" "$1"; else echo 0; fi; }
queued() { find "$QUEUE" -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }
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
  rm -f "$WORK/sent" "$WORK/requests" "$WORK/waiting" "$WORK/waiting-run" "$WORK/timeout" "$WORK/closed" "$WORK/panes" "$EVENTS"; rm -rf "$QUEUE"
  printf '# x\n\n## Checkpoint\n- Status: in_progress\n- Lead pane: %s\n\n## 결과\n- (요약)\n\n## Commits\n- (없음)\n' "${1:-p1}" > "$PLAN"
}

echo "▶ 바로 보냄"
reset
out="$(lead_send '[fe → 아테나] 끝 A')"; code=$?
check "종료 0" "$code" 0
check "✅ 출력" "${out:0:1}" "✅"
check "한 번 넣음" "$(count "$WORK/sent" 'SENT p1 \[fe → 아테나\] 끝 A')" 1
check "요청 없음" "$(count "$WORK/requests")" 0
check "대기열 없음" "$(queued)" 0

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

echo "▶ 받을 pane 이 닫힘 · 떠 있는 아테나 pane 이 하나 → 그 pane 으로(위임 · 다른 폴더 · 셸은 빼고)"
reset
echo p1 > "$WORK/closed"
panes 'p5:claude:body:🤖 athena-studio-fe · x:true' 'p6:claude:other:다른 곳:true' p7::body:셸:true p2:claude:body:아테나:false
out="$(lead_send '하나뿐인 아테나로')"
check "✅ 출력" "${out:0:1}" "✅"
check "p2 에 넣음" "$(count "$WORK/sent" '^SENT p2 하나뿐인 아테나로')" 1
check "요청 없음" "$(count "$WORK/requests")" 0

echo "▶ 여러 개 · 보고 있는 아테나 pane 이 하나 → 그 pane 으로"
reset
echo p1 > "$WORK/closed"
panes p2:claude:body:아테나:false p4:codex:body:아테나:true
out="$(lead_send '보고 있는 아테나로')"
check "✅ 출력" "${out:0:1}" "✅"
check "p4 에 넣음" "$(count "$WORK/sent" '^SENT p4 보고 있는 아테나로')" 1

echo "▶ 여러 개 · 보고 있는 아테나 pane 이 없음 → 넣지 않고 계획서 · 사건 기록만"
reset
echo p1 > "$WORK/closed"
panes p2:claude:body:아테나:false p4:codex:body:아테나:false
out="$(lead_send '고를 수 없는 글')"; code=$?
check "종료 0" "$code" 0
check "⚠️ 출력" "${out:0:2}" "⚠️"
check "넣지 않음" "$(count "$WORK/sent")" 0
check "요청 없음" "$(count "$WORK/requests")" 0
check "계획서 결과 절에 글" "$(grep -c '여러 개라 고르지 못했어요: 고를 수 없는 글$' "$PLAN")" 1
check "결과 절 안(Commits 앞)" "$(awk '/^## 결과/{on=1} /^## Commits/{on=0} on && /고를 수 없는 글/' "$PLAN" | wc -l | tr -d ' ')" 1
check "사건 기록" "$(count "$EVENTS" '"type":"lead-send-unsent".*"written":true')" 1
check "대기열 없음" "$(queued)" 0

echo "▶ 떠 있는 아테나 pane 이 없음 → 모아 뒀다 생기면 넣음"
reset
echo p1 > "$WORK/closed"
out="$(lead_send '없는 pane')"; code=$?
check "종료 0" "$code" 0
check "⏳ 출력" "${out:0:1}" "⏳"
check "대기열 하나" "$(queued)" 1
sleep 2.5
check "아테나가 없는 동안 안 넣음" "$(count "$WORK/sent")" 0
panes 'p2:claude:body:새 아테나:false'
wait_until '[ "$(queued)" = 0 ]'
check "새 아테나 pane 에 넣음" "$(count "$WORK/sent" '^SENT p2 없는 pane')" 1
check "요청 없음" "$(count "$WORK/requests")" 0
check "기록 없음" "$(plan_lines p1)" 0

echo "▶ 기다리는 동안 pane 이 닫힘 → 하나뿐인 아테나 pane 으로"
reset
touch "$WORK/waiting"
lead_send '닫힐 pane' > /dev/null
panes p2:claude:body:아테나:false
echo p1 > "$WORK/closed"; rm -f "$WORK/waiting"
wait_until '[ "$(queued)" = 0 ]'
check "p2 에 넣음" "$(count "$WORK/sent" '^SENT p2 닫힐 pane')" 1
check "요청 없음" "$(count "$WORK/requests")" 0

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

echo "▶ 사용법"
lead_send > /dev/null 2>&1; check "글 없음 → 2" "$?" 2
LEAD='p 1' lead_send 'x' > /dev/null 2>&1; check "pane 이름 이상 → 2" "$?" 2

exit "$FAIL"
