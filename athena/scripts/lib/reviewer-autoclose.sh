#!/usr/bin/env bash
# review-result.sh 가 새 세션으로 띄우는 reviewer 자동 닫기 감시.
# 기존 정책 유지: 5초마다 확인 · 60초 연속 idle 이면 닫기 · 다른 상태면 다시 세기 · 30분 한도.
set -uo pipefail
ATHENA_DIR="$1"; SECS="$2"; PANE="$3"
idle_since=""; waited=0
while [ "$waited" -lt 1800 ]; do
  status="$("$ATHENA_DIR/scripts/screen" pane get "$PANE" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["pane"].get("agent_status") or "")' 2>/dev/null)"
  [ -n "$status" ] || exit 0
  now=$(date +%s)
  if [ "$status" = idle ]; then
    [ -n "$idle_since" ] || idle_since=$now
    [ $((now - idle_since)) -ge "$SECS" ] && { "$ATHENA_DIR/scripts/screen" pane close "$PANE" >/dev/null 2>&1; exit 0; }
  else
    idle_since=""
  fi
  sleep 5; waited=$((waited + 5))
done
