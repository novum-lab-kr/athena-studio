#!/usr/bin/env bash
# reviewer 결론을 기다린다 — 계획서의 "- Review result: … 📦 <레포> · 🌿 <브랜치> …" 줄이 새로 적히면(바뀌면) 그 줄을 출력하고 끝난다.
# reviewer pane 화면을 보지 않는다 — 끝난 reviewer pane 은 쉬기 시작하고 1분 뒤 저절로 닫힌다(review-result.sh).
# 줄 수를 세지 않는다 — review-result.sh 는 같은 레포·브랜치 줄을 새로 더하지 않고 바꿔 쓴다(2026-10-18 줄 수를 기다리다 9분 걸림).
#
# reviewer 를 띄운 시각(delegate.sh 가 '- Review: … · 띄움 <시각>' 에 적는다) 뒤에 적힌 결론을 찾는다 — 늦게 불러도 이미 끝난 결론을 바로 돌려준다
# 사용:
#   scripts/delegate.sh reviewer --cwd <트리> --here --plan <계획서> "<지시>"
#   scripts/review-wait.sh --plan <계획서> --dir <리뷰할 트리> [--timeout <초, 기본 1200>]
# 끝: 0 = 새 결론(그 줄을 출력) · 1 = 시간 초과(지금 줄을 출력) · 2 = 사용법
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
PLAN=""; DIR=""; TIMEOUT=1200
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PLAN" ] && [ -n "$DIR" ] || { echo "사용: $0 --plan <계획서> --dir <리뷰할 트리> [--timeout <초>]" >&2; exit 2; }
case "$PLAN" in /*) ;; *) PLAN="$ATHENA_DIR/$PLAN" ;; esac
[ -f "$PLAN" ] || { echo "계획서가 없다: $PLAN" >&2; exit 2; }
BRANCH="$(git -C "$DIR" symbolic-ref --short -q HEAD || echo detached)"
# 레포 이름 — review-result.sh 와 같은 방법(메인 체크아웃을 가리키는 repos/<이름> 링크)
MAIN="$(git -C "$DIR" worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
MAIN="$(cd "$MAIN" 2>/dev/null && pwd -P)"
REPO="$(basename "${MAIN:-$DIR}")"
for link in "$ATHENA_DIR"/repos/*; do [ -n "$MAIN" ] && [ "$(cd "$link" 2>/dev/null && pwd -P)" = "$MAIN" ] && REPO="$(basename "$link")"; done
line() { grep -F -- "📦 $REPO · 🌿 $BRANCH " "$PLAN" | grep '^- Review result:' | tail -1; }
# 결론 줄·띄운 줄의 시각(YYYY-MM-DD HH:MM) — 분 단위라 같은 분이면 띄운 뒤로 친다
stamp_of() { printf '%s' "$1" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}' | head -1; }
LAUNCHED="$(grep '^- Review:' "$PLAN" | grep -F -- "🌿 $BRANCH " | grep -oE '띄움 [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}' | tail -1 | sed 's/^띄움 //')"
# 새 결론인가 — reviewer 를 띄운 시각을 알면 그 뒤에 적힌 결론(기다리기를 늦게 시작했어도 이미 끝난 것까지), 모르면(옛 줄) 기다리기 시작한 뒤 바뀐 줄
fresh() {
  [ -n "$1" ] || return 1
  if [ -n "$LAUNCHED" ]; then
    [ ! "$(stamp_of "$1")" \< "$LAUNCHED" ]
  else
    [ "$1" != "$BEFORE" ]
  fi
}

BEFORE="$(line)"
echo "⏳ reviewer 결론 기다림 — 📦 $REPO · 🌿 $BRANCH${LAUNCHED:+ · 띄움 $LAUNCHED} (최대 ${TIMEOUT}초)" >&2
waited=0
while [ "$waited" -lt "$TIMEOUT" ]; do
  NOW="$(line)"
  if fresh "$NOW"; then
    echo "$NOW"
    exit 0
  fi
  sleep 5; waited=$((waited + 5))
done
echo "⌛ ${TIMEOUT}초 안에 새 결론이 없다 — 지금 줄: ${NOW:-없음}" >&2
echo "${NOW:-}"
exit 1
