# 계획서 경로 → 본체 기준 논리 경로(plans/…md) — delegate.sh · commit.sh · ship.sh · review-result.sh 가 같이 쓴다.
# 사용: . "$ATHENA_DIR/scripts/lib/plan-path.sh"; PLAN="$(plan_rel "$ATHENA_DIR" "$PLAN")" || exit 2
#
# 문서 ID 는 본체 기준 논리 경로다(계획서 4.2). 실제 경로로 풀어 본체 접두를 자르면 여러 팩 구조에서 깨진다
# (plans → .pack-data/plans → ~/athena-data/packs/<id>/plans 로 풀려 본체 밖이 된다 — 1-0 스파이크 S2).
#   1) 상대 경로면 그대로
#   2) 본체 경로(부른 쪽이 쓴 그대로 · 본체 실제 경로)로 시작하면 자른다
#   3) 활성 팩 데이터의 실제 경로(<데이터>/packs/<id>/…)면 논리 경로로 되돌린다 — plans/… · issues/… · pack/archive/… → archive/…
#   4) 옛 이름(hermes 링크 등)으로 온 경로는 폴더를 실제 경로로 풀어 2)·3) 을 다시 본다
#   그 밖(다른 팩 · 본체 밖)은 그대로 돌려준다 — 부른 쪽의 "plans/*.md 인가" 검사가 거부한다
plan_rel() {
  local root="$1" path="$2" root_real active_real dir
  case "$path" in /*) ;; *) printf '%s\n' "$path"; return 0 ;; esac
  root_real="$(cd "$root" 2>/dev/null && pwd -P)"
  active_real=""
  [ -L "$root/.pack-data" ] && active_real="$(cd "$root/.pack-data" 2>/dev/null && pwd -P)"
  _plan_rel_strip() {
    case "$1" in
      "$root"/*) printf '%s\n' "${1#"$root"/}"; return 0 ;;
      "$root_real"/*) printf '%s\n' "${1#"$root_real"/}"; return 0 ;;
    esac
    if [ -n "$active_real" ]; then
      case "$1" in
        "$active_real"/pack/archive/*) printf 'archive/%s\n' "${1#"$active_real"/pack/archive/}"; return 0 ;;
        "$active_real"/*) printf '%s\n' "${1#"$active_real"/}"; return 0 ;;
      esac
    fi
    return 1
  }
  _plan_rel_strip "$path" && return 0
  dir="$(dirname "$path")"
  if [ -d "$dir" ]; then
    _plan_rel_strip "$(cd "$dir" && pwd -P)/$(basename "$path")" && return 0
  fi
  printf '%s\n' "$path"
}
