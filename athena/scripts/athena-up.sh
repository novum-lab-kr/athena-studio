#!/usr/bin/env bash
# 아테나 세션이 켜질 때 화면을 세팅한다 — 현황판을 (없으면) 띄우고, 첫 실행이면 그 pane 에 첫 실행 지시를 입력한다.
#   에이전트 모니터는 Athena Studio 앱 가운데 맨 아래 칸(AGENT MONITOR)이 보여 주고, 배우기 검토는 대기열이 생기면 뒤에서 돌고,
#   가이드 메뉴는 /guide 로 부를 때만 띄운다 — 여기서 도구 pane 을 더 띄우지 않는다(사용자 결정 2026-10-17 · 모니터는 2026-10-18).
#   pane 은 화면 계층(scripts/screen)으로만 다룬다.
# 아테나 세션이 켜질 때 SessionStart 훅(scripts/hooks/workspace-up.py)이 뒤에서 부른다. 손으로: scripts/athena-up.sh
# 조건은 "athena 폴더에서 켠 아테나 claude" 하나 — workspace 이름은 보지 않는다(훅이 cwd·에이전트 여부를 거른다)
# 현황판 스크립트는 떠 있으면 새로 띄우지 않는다 — 다시 돌려도 안전.
# ATHENA_FIRST_RUN=claude|codex(팩 없음 · 새로 켠 세션 — workspace-up 훅이 넘긴다)면 화면 세팅이 끝난 뒤 그 pane 에 첫 실행 지시를 입력한다
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCREEN="$ATHENA_DIR/scripts/screen"
"$SCREEN" inside || exit 0
eval "$("$SCREEN" self --format sh)"   # SCREEN_PANE_ID(이 아테나 pane) · SCREEN_TAB_ID
[ -n "${SCREEN_TAB_ID:-}" ] || exit 0

# 세션 시작 때는 브라우저를 새로 열지 않는다
ATHENA_BOARD_NO_BROWSER=1 "$ATHENA_DIR/scripts/board.sh" >/dev/null 2>&1

# 첫 실행 자동 시작 — 화면 세팅이 끝났으니 이 pane 에 지시를 입력한다(사용자가 아무것도 치지 않아도 되게).
# 화면 백엔드가 본 그 pane 의 에이전트가 입력을 기다릴 때(idle)만 보낸다. idle 을 본 뒤에 working 이 보이면(사용자가 먼저 말을 걸었다 — 아테나가 훅 안내로 첫 실행을 맡는다 · idle 전의 working 은 켜지는 중이라 무시)
# 또는 90초 안에 idle 이 안 되면 보내지 않는다
if [ -n "${ATHENA_FIRST_RUN:-}" ] && [ -n "${SCREEN_PANE_ID:-}" ]; then
  case "$ATHENA_FIRST_RUN" in
    codex) FIRST_PROMPT="아테나 첫 실행 — 팩이 없다. docs/setup.md 절차를 0단계부터 그대로 해 줘" ;;
    *) FIRST_PROMPT="/setup" ;;
  esac
  pane_status() { "$SCREEN" pane get "$SCREEN_PANE_ID" 2>/dev/null | python3 -c "import sys,json;p=json.load(sys.stdin)['pane'];print(p.get('agent_status') or '')" 2>/dev/null; }
  result="안 보냄 — 90초 안에 idle 아님"
  seen_idle=0
  for _ in $(seq 1 90); do
    status="$(pane_status)"
    if [ "$status" = working ] && [ "$seen_idle" = 1 ]; then result="안 보냄 — 사용자가 먼저 입력"; break; fi
    if [ "$status" = idle ]; then
      seen_idle=1
      sleep 1   # 입력창이 그려질 틈
      if [ "$(pane_status)" = idle ]; then
        "$SCREEN" pane send-text "$SCREEN_PANE_ID" "$FIRST_PROMPT" >/dev/null 2>&1 && sleep 0.5 && "$SCREEN" pane send-keys "$SCREEN_PANE_ID" Enter >/dev/null 2>&1 && result="보냄"
        break
      fi
    fi
    sleep 1
  done
  printf '%s  첫 실행 자동 시작(%s): %s\n' "$(date '+%F %T')" "$ATHENA_FIRST_RUN" "$result" >> "${TMPDIR:-/tmp}/hermes-up.log"
fi
exit 0
