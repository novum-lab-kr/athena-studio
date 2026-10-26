#!/usr/bin/env bash
# 아테나 일감(scripts/board/server.mjs)을 띄우고 브라우저로 연다.
# 사용: scripts/board.sh          → 서버가 없으면 백그라운드로 띄우고 브라우저를 연다
#       scripts/board.sh stop     → 서버를 끈다
#       scripts/board.sh url      → 주소만 출력
#       scripts/board.sh open <plans/…html|md> → (서버가 없으면 띄우고) 정식 계획서 결정 콘솔을 일감 주소로 연다
#                                  [이대로 진행] 이 아테나 pane 으로 보내려면 이 주소로 열어야 한다
# 브라우저는 화면 계층 scripts/screen open-url 로 연다 — Athena Studio 면 그 창의 옆 브라우저, 그 밖은 기본 브라우저(open)
#
# 포트는 여러 팩이면 레지스트리 packs.<id>.boardPort → 본체 boardPort → ATHENA_BOARD_PORT → 레지스트리 portBase → 4700(옛 구조는 env 먼저). 이미 떠 있으면 새로 띄우지 않고 브라우저만 연다.
# 여러 팩 — 떠 있는 일감의 /api/state.pack(팩·세대)이 지금 팩과 다르면 끄고 다시 띄운다(같으면 그대로)
# 서버는 pane 없이 백그라운드(nohup)로 띄운다(사용자 결정 2026-10-18 — 앱 일감 탭이 보여 준다). 로그는 /tmp/hermes-board.log(포트 4700) ·
# 다른 포트면 /tmp/hermes-board-<포트>.log(포트는 본체마다 달라 — 여러 본체의 일감 로그가 서로 덮지 않는다).
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 포트 순서는 athena_config.board_port(여러 팩: 레지스트리 → 본체 설정 → ATHENA_BOARD_PORT → 레지스트리 portBase → 4700 · 옛 구조: env 먼저)
PORT="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import board_port; print(board_port(sys.argv[1]))' "$ATHENA_DIR" 2>/dev/null || echo "${ATHENA_BOARD_PORT:-4700}")"
URL="http://localhost:$PORT"
# 백그라운드 로그 — 4700(기본 포트)은 지금 이름 그대로, 다른 포트는 포트별 이름
if [ "$PORT" = 4700 ]; then LOG_FILE=/tmp/hermes-board.log; else LOG_FILE="/tmp/hermes-board-$PORT.log"; fi

is_up() { curl -s -o /dev/null --max-time 1 "$URL/api/state"; }

OPEN_PATH=""
case "${1:-}" in
  url) echo "$URL"; exit 0 ;;
  open)
    OPEN_PATH="${2:-}"
    OPEN_PATH="${OPEN_PATH#"$ATHENA_DIR"/}"
    OPEN_PATH="${OPEN_PATH%.md}"; OPEN_PATH="${OPEN_PATH%.html}.html"
    case "$OPEN_PATH" in plans/*) ;; *) echo "⚠️  plans/ 안의 계획서 html 만 열 수 있다: ${2:-}" >&2; exit 1 ;; esac
    [ -f "$ATHENA_DIR/$OPEN_PATH" ] || { echo "⚠️  파일이 없다: $OPEN_PATH" >&2; exit 1; } ;;
  stop)
    # 포트를 잡고 있는 node 만 끈다. `pkill -f server.mjs` 는 명령줄에 그 경로가 든 프로세스(지시문에 경로가 적힌 에이전트 세션)까지 죽였다
    PIDS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | while read -r pid; do ps -o comm= -p "$pid" | grep -q node && echo "$pid"; done)"
    if [ -n "$PIDS" ]; then kill $PIDS && echo "일감을 껐다"; else echo "떠 있는 일감이 없다"; fi
    exit 0 ;;
esac

# 떠 있는 일감이 지금 팩·세대의 것인가(옛 구조 본체면 늘 그렇다고 본다)
same_pack() {
  curl -s --max-time 2 "$URL/api/state" | python3 -c '
import json, sys
sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import paths
where = paths(sys.argv[1])
if where["mode"] != "packs": sys.exit(0)
try: state = json.load(sys.stdin)
except Exception: sys.exit(1)
pack = state.get("pack")
sys.exit(0 if pack and pack.get("id") == where["packId"] and pack.get("generation") == where["generation"] else 1)' "$ATHENA_DIR"
}
if is_up && ! same_pack; then
  echo "떠 있는 일감이 다른 팩·세대의 것이라 다시 띄운다"
  "$0" stop >/dev/null
  for _ in $(seq 1 20); do is_up || break; sleep 0.2; done
fi

if is_up; then
  echo "$URL (이미 떠 있음)"
else
  CMD="ATHENA_BOARD_PORT=$PORT node $(printf '%q' "$ATHENA_DIR/scripts/board/server.mjs")"
  nohup bash -c "$CMD" >"$LOG_FILE" 2>&1 &
  PLACE="백그라운드 (로그 $LOG_FILE)"
  for _ in $(seq 1 20); do is_up && break; sleep 0.3; done
  is_up || { echo "⚠️  서버가 뜨지 않았다 — $PLACE 확인" >&2; exit 1; }
  echo "$URL ($PLACE)"
fi

if [ -n "$OPEN_PATH" ]; then
  # 한글 경로는 퍼센트 인코딩해서 연다
  ENCODED="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$OPEN_PATH")"
  echo "$URL/$ENCODED"
  "$ATHENA_DIR/scripts/screen" open-url "$URL/$ENCODED" >/dev/null || true
  exit 0
fi

# 이미 보고 있는 탭이 있으면 새로 열지 않는다 — 탭마다 실시간 연결을 잡아 브라우저 연결 한도(6)를 채우면 요청이 멈춘다
viewers() { curl -s --max-time 1 "$URL/api/viewers" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("viewers",0))' 2>/dev/null || echo 0; }
VIEWERS="$(viewers)"
# 방금 띄웠으면 열려 있던 탭이 다시 붙을 때까지 잠깐 기다린다(자동 재연결은 몇 초 걸린다)
if [ "${VIEWERS:-0}" = 0 ] && [ -n "${PLACE:-}" ]; then
  for _ in 1 2 3 4 5 6; do sleep 1; VIEWERS="$(viewers)"; [ "${VIEWERS:-0}" -gt 0 ] && break; done
fi
if [ "${ATHENA_BOARD_NO_BROWSER:-}" = 1 ]; then
  :   # athena-up(세션 시작)에서는 브라우저를 열지 않는다
elif [ "${VIEWERS:-0}" -gt 0 ]; then
  echo "  (이미 열린 탭 ${VIEWERS}개 — 새 탭은 열지 않는다. 그 탭은 서버가 다시 뜨면 저절로 새로고침된다)"
else
  "$ATHENA_DIR/scripts/screen" open-url "$URL" >/dev/null || true
fi
