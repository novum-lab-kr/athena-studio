#!/usr/bin/env bash
# athena workspace 를 늘 같은 모양으로 — 도구 pane 을 (없는 것만) 띄우고 고정 배치로 정리한다.
#   오른쪽 끝: Explorer(사이드바 플러그인이 띄움) · 가이드 메뉴 / 하단 한 줄: 🛰 에이전트 모니터 | 📋 현황판 | 📚 배우기 검토
#   (Studio 화면이면 에이전트 모니터·배우기 검토·가이드 메뉴는 띄우지 않는다 — 모니터는 Studio 앱 가운데 맨 아래 칸이 보여 준다)
#   + herdr-sidebar 패치판(scripts/herdr-sidebar-ensure.sh → patch.sh — 없으면 고정 버전 설치 + 미리 빌드한 패치판 실행 파일, Rust 필요 없음)
#   pane 은 화면 계층(scripts/screen)으로만 다룬다. 사이드바는 herdr 플러그인이라 그 기능이 있는 백엔드에서만(capabilities herdr-sidebar)
# 아테나 세션이 켜질 때 SessionStart 훅(scripts/hooks/workspace-up.py)이 뒤에서 부른다. 손으로: scripts/athena-up.sh
# 조건은 "athena 폴더에서 켠 아테나 claude" 하나 — workspace 이름은 보지 않는다(훅이 cwd·에이전트 여부를 거른다)
# 각 도구 스크립트는 같은 이름의 pane 이 있으면 새로 만들지 않는다 — 다시 돌려도 안전.
# ATHENA_FIRST_RUN=claude|codex(회사 팩 없음 · 새로 켠 세션 — workspace-up 훅이 넘긴다)면 화면 세팅이 끝난 뒤 그 pane 에 첫 실행 지시를 입력한다
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCREEN="$ATHENA_DIR/scripts/screen"
"$SCREEN" inside || exit 0
eval "$("$SCREEN" self --format sh)"   # SCREEN_PANE_ID(이 아테나 pane) · SCREEN_TAB_ID
TAB="${SCREEN_TAB_ID:-}"; [ -n "$TAB" ] || exit 0
HAS_SIDEBAR=0; "$SCREEN" capabilities --has herdr-sidebar && HAS_SIDEBAR=1

# 현황판을 먼저 — 본 영역 아래를 통째로 차지해 하단 줄의 기준 칸이 된다. 세션 시작 때는 브라우저를 새로 열지 않는다
ATHENA_BOARD_NO_BROWSER=1 "$ATHENA_DIR/scripts/board.sh" >/dev/null 2>&1
# Studio 화면에는 에이전트 모니터·배우기 검토·가이드 메뉴 pane 을 두지 않는다(사용자 결정 2026-10-17 · 모니터는 2026-10-18) —
# 모니터는 앱이 가운데 맨 아래 칸으로 보여 주고, 배우기 검토는 대기열이 생기면 뒤에서 돌고, 가이드는 /guide 로 부를 때만
if [ "${SCREEN_BACKEND:-}" != studio ]; then
  "$ATHENA_DIR/scripts/monitor-pane.sh" >/dev/null 2>&1
  "$ATHENA_DIR/scripts/learn-review-pane.sh" >/dev/null 2>&1
  "$ATHENA_DIR/scripts/guide-pane.sh" >/dev/null 2>&1
fi
# Explorer 는 사이드바 플러그인이 띄우지만, herdr 재시작으로 자리만 복원된 빈 셸이면 플러그인이 이름만 보고 건너뛴다 — 그 자리에서 다시 띄운다(없으면 아무것도 안 한다)
[ "$HAS_SIDEBAR" = 1 ] && "$ATHENA_DIR/scripts/herdr-sidebar-reopen.sh" "$TAB" --only-restored >/dev/null 2>&1
"$ATHENA_DIR/scripts/athena-layout.sh" "$TAB" >/dev/null 2>&1

# 사이드바 패치판(Explorer 에서 바뀐 파일 클릭 → diff) — 최신이면 바로 끝난다. 실행 파일을 바꿨으면 열린 사이드바를 새 빌드로 다시 띄우고 배치를 한 번 더 맞춘다
[ "$HAS_SIDEBAR" = 1 ] && "$ATHENA_DIR/scripts/herdr-sidebar-ensure.sh" "$TAB"

# 첫 실행 자동 시작 — 화면 세팅이 끝났으니 이 pane 에 지시를 입력한다(사용자가 아무것도 치지 않아도 되게).
# 화면 백엔드가 본 그 pane 의 에이전트가 입력을 기다릴 때(idle)만 보낸다. 그사이 working 이 보이면(사용자가 먼저 말을 걸었다 — 아테나가 훅 안내로 첫 실행을 맡는다)
# 또는 90초 안에 idle 이 안 되면 보내지 않는다
if [ -n "${ATHENA_FIRST_RUN:-}" ] && [ -n "${SCREEN_PANE_ID:-}" ]; then
  case "$ATHENA_FIRST_RUN" in
    codex) FIRST_PROMPT="아테나 첫 실행 — 회사 팩이 없다. docs/setup.md 절차를 0단계부터 그대로 해 줘" ;;
    *) FIRST_PROMPT="/setup" ;;
  esac
  pane_status() { "$SCREEN" pane get "$SCREEN_PANE_ID" 2>/dev/null | python3 -c "import sys,json;p=json.load(sys.stdin)['pane'];print(p.get('agent_status') or '')" 2>/dev/null; }
  result="안 보냄 — 90초 안에 idle 아님"
  for _ in $(seq 1 90); do
    status="$(pane_status)"
    if [ "$status" = working ]; then result="안 보냄 — 사용자가 먼저 입력"; break; fi
    if [ "$status" = idle ]; then
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
