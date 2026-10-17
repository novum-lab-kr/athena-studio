#!/usr/bin/env bash
# herdr-sidebar 패치판을 최신으로 맞추고, 실행 파일을 바꿨으면 열린 Explorer 를 새 빌드로 다시 띄운다 (athena-up.sh 가 부른다 · 다시 돌려도 안전).
#   패치판(Explorer 에서 바뀐 파일 클릭 → diff) — 없으면 고정 버전 설치 + 미리 빌드한 실행 파일, 최신이면 바로 끝난다(scripts/herdr-sidebar-patch.sh)
# herdr 플러그인 자체를 다루므로 herdr 를 직접 부른다 — 화면 계층(scripts/screen) 밖에서 herdr 를 부르는 허용 목록(scripts/screen-lint.sh)
# 사용: scripts/herdr-sidebar-ensure.sh <탭 id>   (끝나면 그 탭을 고정 배치로 다시 맞춘다)
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TAB="${1:-}"; [ -n "$TAB" ] || exit 0

out="$("$ATHENA_DIR/scripts/herdr-sidebar-patch.sh" 2>&1)"
printf '%s  %s\n' "$(date '+%F %T')" "$out" >> "${TMPDIR:-/tmp}/hermes-up.log"   # 뒤에서 도니 결과는 여기 남긴다
if grep -q '패치판 교체' <<<"$out"; then
  # redeploy 는 모든 workspace 의 Explorer 를 닫는다 — 있던 탭을 적어 두고 새 빌드로 전부 다시 띄운다
  had="$(herdr pane list 2>/dev/null | python3 -c "import sys,json;print(' '.join(sorted({p['tab_id'] for p in json.load(sys.stdin)['result']['panes'] if p.get('label')=='Explorer'} | {'$TAB'})))")"
  herdr plugin action invoke redeploy --plugin herdr-sidebar >/dev/null 2>&1
  sleep 3
  # shellcheck disable=SC2086
  "$ATHENA_DIR/scripts/herdr-sidebar-reopen.sh" $had >> "${TMPDIR:-/tmp}/hermes-up.log" 2>&1
  sleep 2
  "$ATHENA_DIR/scripts/athena-layout.sh" "$TAB" >/dev/null 2>&1
fi
exit 0
