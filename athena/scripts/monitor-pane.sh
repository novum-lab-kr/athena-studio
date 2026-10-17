#!/usr/bin/env bash
# 에이전트 로그 모니터(scripts/agent-monitor.py — 백그라운드 서브에이전트 + 워크트리 pane 세션)를 herdr pane 에 띄운다.
# 사용: scripts/monitor-pane.sh [분]   → 최근 N분(기본 120) 안에 수정된 로그를 tail
#
# 같은 워크스페이스에 "🛰 에이전트 모니터" pane 이 이미 있으면 새로 만들지 않고 그 pane 에서 다시 실행한다.
# 늘 켜 두는 용도(--stay) — 로그가 없어도 닫지 않고 기다리다 에이전트가 뜨면 붙는다. 10분 조용해지면 pane 에 한 줄(MONITOR_IDLE_ALERT_SEC).
# 표준출력은 pane id 한 줄 (재사용이면 " (재사용)" 이 붙는다).
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="🛰 에이전트 모니터"

MINUTES="${1:-}"
[[ "$MINUTES" =~ ^[0-9]+$ ]] || MINUTES=""     # 숫자가 아니면 기본값(120분)을 쓴다
CMD=("$ATHENA_DIR/scripts/agent-monitor.py" --stay --recent)
[ -n "$MINUTES" ] && CMD+=("$MINUTES")

SCREEN="$ATHENA_DIR/scripts/screen"   # 화면 계층 — pane 은 이걸로만 다룬다
. "$ATHENA_DIR/scripts/lib/shell-line.sh"   # shell_line — pane run 에 넘길 셸 한 줄(띄어쓰기·한글 안전)
if ! "$SCREEN" inside; then
  echo "$("$SCREEN" name) 밖입니다. 직접 실행하세요:  ${CMD[*]}" >&2
  exit 1
fi
eval "$("$SCREEN" self --format sh)"   # SCREEN_TAB_ID — 고정 배치에 넘긴다

# 이미 떠 있는 모니터 pane 찾기 (부른 pane 의 워크스페이스 우선)
PANE="$("$SCREEN" pane list --label "$LABEL" --prefer-workspace self --format id 2>/dev/null)"

if [ -n "$PANE" ]; then
  "$SCREEN" pane send-keys "$PANE" C-c >/dev/null 2>&1 || true   # 돌고 있던 모니터를 먼저 끊는다
  sleep 1
  "$SCREEN" pane run "$PANE" "$(shell_line "${CMD[@]}")" >/dev/null   # 셸 한 줄 — 띄어쓰기 든 경로가 쪼개지지 않게
  echo "$PANE (재사용)"
  exit 0
fi

# 부른 pane 옆을 나눈다(--target self) — 포커스된 pane 은 뒤에서 돌 때 엉뚱한 곳을 가른다
OUT="$("$SCREEN" pane split --target self --direction right --ratio 0.5 --cwd "$ATHENA_DIR" --no-focus)" || {
  echo "⚠️  $("$SCREEN" name) pane split 실패: $OUT" >&2; exit 1; }
PANE="$(printf '%s' "$OUT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pane"]["id"])')"
sleep 1
# pane run 은 단어를 따옴표 없이 이어 붙여 한 줄로 친다 — bash -c "<한 줄>" 로 넘기면 bash 가 첫 단어(스크립트)만 돌리고
# --stay --recent 는 $0·$1 로 사라진다. 셸 따옴표를 붙인 한 줄 하나만 넘긴다(learn-review-pane.sh 와 같은 방식)
RUN_SH="$(shell_line "${CMD[@]}")"
"$SCREEN" pane run "$PANE" "$RUN_SH" >/dev/null
"$SCREEN" pane rename "$PANE" "$LABEL" >/dev/null 2>&1 || true
"$ATHENA_DIR/scripts/athena-layout.sh" "${SCREEN_TAB_ID:-}" >/dev/null 2>&1 || true   # athena workspace 고정 배치
echo "$PANE"
