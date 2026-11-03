#!/usr/bin/env bash
# 에이전트 → 아테나 보내기 시험 — scripts/lead-send.py(받을 수 없으면 모아 뒀다 넣기 · 못 넣으면 요청).
# 가짜 화면 CLI · 가짜 bin/athena · 임시 본체 사본으로 — 화면 · claude 를 부르지 않는다 · 20초 안팎
#   바로 보냄 · 선택 창이면 요청 없이 모아 둠 → 닫히면 차례대로 넣음 · 앞에 미룬 글 뒤에 줄 섬
#   pane 없음 · 기다리다 닫힘 · 오래 기다림 · 전송 확인 실패는 요청(다시 넣지 않음) · 사용법
#
# 사용: test/lead-send-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
FAIL=0

BODY="$WORK/body"; DATA="$WORK/data"
mkdir -p "$BODY/scripts/lib" "$BODY/bin" "$DATA/state"
cp "$SRC/scripts/lead-send.py" "$BODY/scripts/"
cp "$SRC"/scripts/lib/*.py "$BODY/scripts/lib/"
ln -s "$DATA" "$BODY/.pack-data"
QUEUE="$DATA/state/lead-send"

# 가짜 화면 CLI — 받은 인자를 로그에. WAITING 파일이 있으면 화면에 고르기 창 · pane run 은 데몬처럼 거절, TIMEOUT 파일이면 전송 확인 실패
mkdir -p "$WORK/cli"
cat > "$WORK/cli/athena-studio-cli" <<'CLIEOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case " $(cat "$FAKE_DIR/closed" 2>/dev/null) " in *" $3 "*) [ "$1" = pane ] && { echo '{"error":"not_found","message":"없는 pane"}' >&2; exit 1; } ;; esac
case "$1 $2" in
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
# 가짜 요청 명령 — 연 요청을 적고 ok
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
    ATHENA_AGENT=athena-studio-fe ATHENA_PLAN=plans/task/x.md python3 "$BODY/scripts/lead-send.py" "${LEAD:-p1}" "$@"
}
count() { [ -f "$1" ] && grep -c "${2:-.}" "$1" || echo 0; }
queued() { find "$QUEUE" -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }
check() { if [ "$2" = "$3" ]; then echo "  ✔ $1"; else echo "  ✖ $1 (기대 $3 · 실제 $2)"; FAIL=1; fi; }
wait_until() {   # <조건 명령> — 최대 15초
  for _ in $(seq 1 75); do eval "$1" && return 0; sleep 0.2; done; return 1
}
reset() { rm -f "$WORK/sent" "$WORK/requests" "$WORK/waiting" "$WORK/waiting-run" "$WORK/timeout" "$WORK/closed"; rm -rf "$QUEUE"; }

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

echo "▶ 아테나 pane 이 없음 → 지금처럼 요청"
reset
echo p1 > "$WORK/closed"
out="$(lead_send '없는 pane')"; code=$?
check "종료 0" "$code" 0
check "⚠️ 출력" "${out:0:2}" "⚠️"
check "요청 하나" "$(count "$WORK/requests" '^request open --kind question')" 1
check "계획서 · pane 이 붙음" "$(count "$WORK/requests" '\-\-pane p9 \-\-plan plans/task/x.md')" 1
check "글이 요청 본문에" "$(grep -c '^없는 pane' "$WORK/requests")" 1
check "대기열 없음" "$(queued)" 0

echo "▶ 기다리는 동안 pane 이 닫힘 → 요청으로 남김"
reset
touch "$WORK/waiting"
lead_send '닫힐 pane' > /dev/null
echo p1 > "$WORK/closed"
wait_until '[ "$(queued)" = 0 ]'
check "넣지 않음" "$(count "$WORK/sent")" 0
check "요청 하나" "$(count "$WORK/requests" '닫혔어요')" 1

echo "▶ 너무 오래 못 넣음 → 요청으로 남김"
reset
touch "$WORK/waiting"
ATHENA_LEAD_SEND_GIVE_UP=1 lead_send '오래된 글' > /dev/null
wait_until '[ "$(queued)" = 0 ]'
check "넣지 않음" "$(count "$WORK/sent")" 0
check "요청 하나" "$(count "$WORK/requests" '6시간')" 1

echo "▶ 전송 확인 실패 → 다시 넣지 않고 요청"
reset
touch "$WORK/timeout"
out="$(lead_send '확인 실패')"
check "⚠️ 출력" "${out:0:2}" "⚠️"
check "pane run 한 번만" "$(count "$FAKE_LOG" '^pane run p1 확인 실패')" 1
check "요청 하나" "$(count "$WORK/requests" '입력칸에 글이 남았을 수')" 1
check "대기열 없음" "$(queued)" 0

echo "▶ 사용법"
lead_send > /dev/null 2>&1; check "글 없음 → 2" "$?" 2
LEAD='p 1' lead_send 'x' > /dev/null 2>&1; check "pane 이름 이상 → 2" "$?" 2

exit "$FAIL"
