#!/usr/bin/env bash
# 검증 결과 재사용 — 같은 트리 내용·같은 검증 스크립트·같은 인자로 이미 통과했으면 다시 돌리지 않는다.
# 다르면(한 글자라도 바뀌었으면) 검증 스크립트를 그대로 돌린다. commit.sh 와 reviewer 가 쓴다.
#
# 사용: scripts/verify/reuse.sh <레포> [<검증 인자…>]     (워크트리면 ATHENA_VERIFY_DIR=<워크트리> — 검증 스크립트와 같다)
#   재사용이면 기록된 결과 표를 "♻️ 재사용(@시각)" 으로 다시 찍고 0
#   엄격 모드(ATHENA_VERIFY_STRICT=1)면 기록에 건너뜀(⏭, 규칙 건너뜀 제외)이 있을 때 그 단계가 모두 ATHENA_VERIFY_ALLOW_SKIP 에 있어야 재사용한다
#   ATHENA_VERIFY_REUSE_NOTE=<파일> 이면 재사용했을 때 그 파일에 "재사용(@시각)" 을 적는다(commit.sh 가 계획서 기록에 쓴다)
# 통과 기록은 검증 스크립트가 통과할 때 _lib.sh 가 남긴다(scripts/verify/_lib.sh "통과 기록").
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="${1:-}"
[ -n "$REPO" ] || { echo "사용: $0 <레포> [<검증 인자…>]" >&2; exit 2; }
shift
ATHENA_DIR="$(cd "$HERE/../.." && pwd -P)"
SCRIPT="$ATHENA_DIR/scripts/verify/$REPO.sh"
[ -f "$SCRIPT" ] || { echo "검증 스크립트가 없다: scripts/verify/$REPO.sh" >&2; exit 2; }

# 열쇠 계산만 빌린다 — 기록하지 않고(VERIFY_RECORD=0), 검증 스크립트가 보는 것과 같은 스크립트·인자로
# shellcheck disable=SC2034
VERIFY_RECORD=0
VERIFY_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/athena-verify-reuse.XXXXXX")"
# shellcheck source=_lib.sh
source "$HERE/_lib.sh"
rm -rf "$VERIFY_LOG_DIR"
VERIFY_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd -P)/$(basename "$SCRIPT")"
VERIFY_SCRIPT_ARGS="$*"
run_script() { exec "$SCRIPT" "$@"; }

# 검증 스크립트와 같은 규칙으로 대상 트리를 고른다(다른 레포 워크트리면 엄격 모드는 여기서 멈춘다)
TREE="$(resolve_repo_dir "$ATHENA_DIR/repos/$REPO")" || exit 2
[ -d "$TREE" ] || run_script "$@"
KEY="$(verify_key "$VERIFY_SCRIPT" "$TREE" "$VERIFY_SCRIPT_ARGS")" || run_script "$@"
RECORD="$(verify_pass_dir)/$KEY"
[ -n "$KEY" ] && [ -f "$RECORD" ] || run_script "$@"

field() { awk -F '\t' -v name="$1" '$1 == name { print $2; exit }' "$RECORD"; }
WHEN="$(field time)"; SKIPPED="$(field skipped)"
if [ "${ATHENA_VERIFY_STRICT:-0}" = 1 ] && [ -n "$SKIPPED" ]; then
  # 엄격 모드 — 기록의 건너뜀이 모두 허용된 것일 때만
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s' "${ATHENA_VERIFY_ALLOW_SKIP:-}" | tr '|' '\n' | grep -qxF "$name" || {
      echo "♻️ 통과 기록이 있지만 건너뛴 단계($name)가 엄격 모드에서 허용되지 않았다 — 다시 돌린다"
      run_script "$@"
    }
  done <<EOF
$(printf '%s' "$SKIPPED" | tr '|' '\n')
EOF
fi

BRANCH="$(git -C "$TREE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
SHA="$(git -C "$TREE" rev-parse --short HEAD 2>/dev/null || echo '?')"
echo
echo "## 검증 결과 — $REPO ($BRANCH @ $SHA, $(date '+%Y-%m-%d %H:%M')) · ♻️ 재사용(@$WHEN)"
echo
echo "| 단계 | 결과 | 소요 |"
echo "|---|---|---|"
awk -F '\t' -v when="$WHEN" '$1 == "step" { printf "| `%s` | ♻️ 재사용(@%s) %s | 0s (당시 %ss) |\n", $2, when, $3, $4 }' "$RECORD"
echo
echo "같은 트리 내용·같은 검증 스크립트·같은 인자(${VERIFY_SCRIPT_ARGS:-없음})로 $WHEN 에 통과한 기록(당시 $(field branch) @ $(field sha)) — 다시 돌리지 않았다. 열쇠 $KEY"
[ -n "${ATHENA_VERIFY_REUSE_NOTE:-}" ] && printf '재사용(@%s)\n' "$WHEN" > "$ATHENA_VERIFY_REUSE_NOTE"
exit 0
