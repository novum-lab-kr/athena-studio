#!/usr/bin/env bash
# 가이드 메뉴(또는 지정 파일)를 현재 터미널 옆 pane 에 띄운다.
# 사용: scripts/guide-pane.sh            → 선택형 메뉴(scripts/guide-menu.sh)
#       scripts/guide-pane.sh <파일>     → 해당 파일을 less 로
#
# 우선순위
#   1. 화면 pane 안(scripts/screen inside — herdr · Athena Studio)이면 현재 pane 을 오른쪽으로 분할
#   2. tmux 안이면 tmux split-window
#   3. 둘 다 아니면 새 Ghostty 창으로 대체
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -ge 1 ]; then
  case "$1" in /*) ABS="$1" ;; *) ABS="$ATHENA_DIR/$1" ;; esac
  case "$ABS" in
    *.md) CMD=(bash -c "python3 '$ATHENA_DIR/scripts/mdview.py' '$ABS' | less -R"); LABEL="$(basename "$ABS")" ;;
    *)    CMD=(less -R "$ABS"); LABEL="$(basename "$ABS")" ;;
  esac
else
  CMD=("$ATHENA_DIR/scripts/guide-menu.sh"); LABEL="가이드 메뉴"
fi

SCREEN="$ATHENA_DIR/scripts/screen"   # 화면 계층 — pane 은 이걸로만 다룬다
. "$ATHENA_DIR/scripts/lib/shell-line.sh"   # shell_line — pane run 에 넘길 셸 한 줄(띄어쓰기·한글 안전)
if "$SCREEN" inside; then
  eval "$("$SCREEN" self --format sh)"   # SCREEN_PANE_ID(부른 pane) · SCREEN_TAB_ID
  # 이 탭에 이미 같은 이름의 pane 이 있으면 새로 쪼개지 않고 그 자리에서 다시 띄운다
  EXISTING="$("$SCREEN" pane list --tab self --label "$LABEL" --format id 2>/dev/null)"
  if [ -n "$EXISTING" ]; then
    # 떠 있는 메뉴·뷰어를 닫는다 — 빈 셸(herdr 재시작으로 복원된 pane)이면 q 가 명령줄에 남아 "qenv …" 가 되므로 보내지 않는다
    "$SCREEN" pane is-shell "$EXISTING" || { "$SCREEN" pane send-text "$EXISTING" q >/dev/null 2>&1; sleep 0.5; }
    "$SCREEN" pane run "$EXISTING" "$(shell_line env "ATHENA_CLAUDE_PANE=${SCREEN_PANE_ID:-}" "${CMD[@]}")" >/dev/null
    "$ATHENA_DIR/scripts/athena-layout.sh" "${SCREEN_TAB_ID:-}" >/dev/null 2>&1 || true
    echo "$EXISTING (재사용)"
    exit 0
  fi
  # 부른 pane 옆을 나눈다(--target self) — 포커스된 pane 은 뒤에서 돌 때 엉뚱한 곳을 가른다
  OUT="$("$SCREEN" pane split --target self --direction right --ratio 0.6 --cwd "$ATHENA_DIR" \
          --env "ATHENA_CLAUDE_PANE=${SCREEN_PANE_ID:-}" --no-focus)" || {
    echo "⚠️  $("$SCREEN" name) pane split 실패: $OUT" >&2; exit 1; }
  NEW_PANE="$(printf '%s' "$OUT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pane"]["id"])')"
  sleep 1
  "$SCREEN" pane run "$NEW_PANE" "$(shell_line "${CMD[@]}")" >/dev/null
  "$SCREEN" pane rename "$NEW_PANE" "$LABEL" >/dev/null 2>&1 || true
  "$ATHENA_DIR/scripts/athena-layout.sh" "${SCREEN_TAB_ID:-}" >/dev/null 2>&1 || true   # athena workspace 고정 배치
  echo "$NEW_PANE"
  exit 0
fi

if [ -n "${TMUX:-}" ]; then
  tmux split-window -h -c "$ATHENA_DIR" "${CMD[*]}"
  exit 0
fi

open -na Ghostty --args --working-directory="$ATHENA_DIR" --title="Athena $LABEL" -e "${CMD[@]}"
