#!/usr/bin/env bash
# 에이전트 로그 모니터(scripts/agent-monitor.py — 백그라운드 서브에이전트 + 워크트리 pane 세션)를 어디서 보는지 알린다.
# 사용: scripts/monitor-pane.sh [분]   → 최근 N분(기본 120) 안에 수정된 로그
#
# Athena Studio 화면에는 모니터 pane 을 띄우지 않는다 — 앱 가운데 맨 아래 칸(AGENT MONITOR)이 같은 로그를 보여 준다.
# /setup·/diagram·디스패치가 "보이게" 부르므로 실패(1)가 아니라 할 일 없음(0)으로 끝낸다(사용자 결정 2026-10-19 · 표준출력 없음).
# 화면 pane 밖이면 직접 실행할 명령을 알려 주고 1 로 끝낸다.
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"

MINUTES="${1:-}"
[[ "$MINUTES" =~ ^[0-9]+$ ]] || MINUTES=""     # 숫자가 아니면 기본값(120분)을 쓴다
CMD=("$ATHENA_DIR/scripts/agent-monitor.py" --stay --recent)
[ -n "$MINUTES" ] && CMD+=("$MINUTES")

SCREEN="$ATHENA_DIR/scripts/screen"   # 화면 계층 — pane 은 이걸로만 다룬다
if ! "$SCREEN" inside; then
  echo "$("$SCREEN" name) 밖입니다. 직접 실행하세요:  ${CMD[*]}" >&2
  exit 1
fi
echo "Athena Studio 는 앱 아래 AGENT MONITOR 칸이 에이전트 로그를 보여 줍니다 — pane 을 띄우지 않습니다" >&2
exit 0
