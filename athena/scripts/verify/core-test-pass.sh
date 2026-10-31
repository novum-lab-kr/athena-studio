#!/usr/bin/env bash
# 코어 시험(athena/test/*.sh) 통과 기록 — 같은 트리 내용으로 이미 통과한 시험을 검증 스크립트가 다시 돌리지 않게 한다.
#   key    <트리> <시험>            열쇠를 출력(트리 해시를 못 구하면 1)
#   record <트리> <시험> <시작열쇠> <초>  지금 열쇠가 시작 열쇠와 같을 때만 기록(시험 도중 트리가 바뀌었으면 기록 안 함)
#   check  <트리> <시험>            기록이 있으면 "<시각>" 을 출력하고 0, 없으면 1
# 열쇠 = 트리 내용(추적 + 미추적, 무시 제외 — _lib.sh verify_tree_hash 와 같은 방식) · 트리 경로 · 시험 이름 · node 버전 · python3 유무.
# 실패는 기록하지 않는다. 다른 트리 · 한 글자라도 바뀐 트리는 열쇠가 달라 재사용되지 않는다. 기록은 ~/.cache/athena/core-test-pass/ (7일 뒤 정리)
set -uo pipefail

pass_dir() { echo "${XDG_CACHE_HOME:-$HOME/.cache}/athena/core-test-pass"; }

tree_hash() { # <트리> — 작업 트리 내용의 git tree 해시
  local tree="$1" index tmp hash
  index="$(git -C "$tree" rev-parse --path-format=absolute --git-path index 2>/dev/null)" || return 1
  tmp="$(mktemp "${TMPDIR:-/tmp}/athena-coretest-index.XXXXXX")" || return 1
  [ -f "$index" ] && cp "$index" "$tmp"
  if GIT_INDEX_FILE="$tmp" git -C "$tree" add -A . >/dev/null 2>&1; then
    hash="$(GIT_INDEX_FILE="$tmp" git -C "$tree" write-tree 2>/dev/null)"
  fi
  rm -f "$tmp" "$tmp.lock"
  [ -n "${hash:-}" ] && echo "$hash"
}

key_of() { # <트리> <시험>
  local tree="$1" test_name="$2" hash
  hash="$(tree_hash "$tree")" || return 1
  printf 'tree %s\ndir %s\ntest %s\nnode %s\npython3 %s\n' "$hash" "$(cd "$tree" && pwd -P)" "$test_name" \
    "$(node -v 2>/dev/null || echo none)" "$(command -v python3 >/dev/null 2>&1 && echo yes || echo no)" | shasum | cut -c1-24
}

command="${1:-}"; [ $# -gt 0 ] && shift
case "$command" in
  key) key_of "$1" "$2" ;;
  record)
    tree="$1"; test_name="$2"; start_key="$3"; secs="${4:-0}"
    [ -n "$start_key" ] || exit 0
    now_key="$(key_of "$tree" "$test_name")" || exit 0
    [ "$now_key" = "$start_key" ] || exit 0
    dir="$(pass_dir)"; mkdir -p "$dir" 2>/dev/null || exit 0
    find "$dir" -type f -mtime +7 -delete 2>/dev/null
    printf 'time\t%s\ntest\t%s\nsecs\t%s\n' "$(date '+%Y-%m-%d %H:%M')" "$test_name" "$secs" > "$dir/$now_key.tmp" && mv "$dir/$now_key.tmp" "$dir/$now_key"
    ;;
  check)
    key="$(key_of "$1" "$2")" || exit 1
    record="$(pass_dir)/$key"
    [ -f "$record" ] || exit 1
    awk -F '\t' '$1 == "time" { print $2; exit }' "$record"
    ;;
  *) echo "사용: $0 key|record|check <트리> <시험> …" >&2; exit 2 ;;
esac
