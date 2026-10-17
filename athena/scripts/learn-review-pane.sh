#!/usr/bin/env bash
# "📚 배우기 검토" pane 하나에서 learn-review.mjs --watch 를 돌린다(학습 루프 3단계 — 작업마다 pane 을 늘리지 않는다).
# 사용: scripts/learn-review-pane.sh   (보통은 learn-review.mjs --enqueue 가 부른다)
#
# 어느 워크스페이스든 그 이름의 pane 이 이 체크아웃 폴더에서 떠 있으면 그 pane 을 쓰고(이미 돌고 있으면 그대로 · 빈 셸이면 다시 돌린다),
# (다른 체크아웃의 같은 이름 pane 은 쓰지 않는다 — 대기열이 체크아웃마다 따로다)
# 없으면 지금 pane 옆에 하나 띄운다. 표준출력은 pane id 한 줄. 화면 pane 밖이면 1 로 끝낸다(호출한 쪽이 뒤에서 돌린다).
# Studio 화면에서도 pane 을 띄우지 않고 1 로 끝낸다 — 뒤에서 돈다(사용자 결정 2026-10-17: 스튜디오에는 배우기 검토 pane 을 두지 않는다)
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
LABEL="📚 배우기 검토"
CMD=(node "$ATHENA_DIR/scripts/learn-review.mjs" --watch)

SCREEN="$ATHENA_DIR/scripts/screen"   # 화면 계층 — pane 은 이걸로만 다룬다
. "$ATHENA_DIR/scripts/lib/shell-line.sh"   # shell_line — pane run 에 넘길 셸 한 줄(띄어쓰기·한글 안전)
if ! "$SCREEN" inside; then
  exit 1
fi
eval "$("$SCREEN" self --format sh)"   # SCREEN_TAB_ID — 고정 배치에 넘긴다 · SCREEN_BACKEND
[ "${SCREEN_BACKEND:-}" = studio ] && exit 1

# 이 이름이고 cwd(또는 지금 셸의 폴더)가 이 체크아웃인 pane
PANE="$("$SCREEN" pane list --label "$LABEL" --cwd "$ATHENA_DIR" --format id 2>/dev/null)"

RUN="$(shell_line "${CMD[@]}")"   # pane run 은 명령을 한 줄 문자열로 받는다(단어를 따옴표 없이 이어 붙인다)
if [ -n "$PANE" ]; then
  # 이미 돌고 있으면 그대로 둔다 — 돌고 있는 프로그램에 명령줄을 쳐 넣지 않는다. 빈 셸(herdr 재시작으로 복원된 pane)일 때만 다시 띄운다
  if "$SCREEN" pane is-shell "$PANE"; then
    "$SCREEN" pane run "$PANE" "$RUN" >/dev/null || exit 1
  fi
  echo "$PANE (재사용)"
  exit 0
fi

# 부른 pane 옆을 나눈다(--target self) — 포커스된 pane 은 뒤에서 돌 때 엉뚱한 곳을 가른다
OUT="$("$SCREEN" pane split --target self --direction down --ratio 0.3 --cwd "$ATHENA_DIR" --no-focus)" || exit 1
PANE="$(printf '%s' "$OUT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pane"]["id"])')" || exit 1
sleep 1
"$SCREEN" pane run "$PANE" "$RUN" >/dev/null
"$SCREEN" pane rename "$PANE" "$LABEL" >/dev/null 2>&1 || true
"$ATHENA_DIR/scripts/athena-layout.sh" "${SCREEN_TAB_ID:-}" >/dev/null 2>&1 || true   # athena workspace 고정 배치
echo "$PANE"
