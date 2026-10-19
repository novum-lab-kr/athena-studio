#!/usr/bin/env bash
# 검증 스크립트 공통 라이브러리. 각 레포 스크립트가 source 해서 쓴다.
#   run_step "<이름>" <명령...>   → 실행·시간 측정·로그 저장, 실패해도 계속 진행
#   skip_step "<이름>" "<이유>"   → 건너뜀으로 기록
#   skip_step_rule "<이름>" "<이유>" → 규칙으로 정해진 건너뜀(예: 화면 파일 변경 없음 — changed-screen.sh). 엄격 모드에서도 실패로 치지 않는다
#   print_summary                 → 표준 형식 요약 출력, 실패가 있으면 exit 1
#
# 엄격 모드(ATHENA_VERIFY_STRICT=1, scripts/commit.sh 가 켠다) — 커밋 전 검증용
#   - 건너뜀(⏭)도 실패로 친다. 사용자가 확인한 단계만 ATHENA_VERIFY_ALLOW_SKIP="이름1|이름2" 로 허용
#   - ATHENA_VERIFY_DIR 가 이 레포 워크트리가 아니면 메인 체크아웃으로 돌아가지 않고 멈춘다
#
# 통과 기록(계획서 D2) — 통과하면 "트리 내용 + 검증 스크립트 + 인자" 열쇠로 레포 밖에 기록한다
#   (${XDG_CACHE_HOME:-~/.cache}/athena/verify-pass/<열쇠>). scripts/verify/reuse.sh 가 같은 열쇠면 다시 돌리지 않고 그 결과를 쓴다
#   - 트리 내용 = 추적 파일 + 미추적(무시 제외) 파일의 작업 트리 내용(임시 index 로 계산 — 진짜 스테이징은 건드리지 않는다)
#   - 검증 스크립트 = 그 레포 스크립트 + scripts/verify 의 코어 파일 + 팩 pack.json 의 내용
#   - 실행 환경 = node -v · python3 유무(환경으로 정해지는 건너뜀이 있다)
#   - 검증 도중 트리가 바뀌었으면(시작·끝 열쇠가 다르면) 기록하지 않는다
# 출력은 에이전트 보고서의 "검증 결과" 절에 그대로 붙일 수 있는 마크다운이다.
set -uo pipefail
VERIFY_LOG_DIR="${VERIFY_LOG_DIR:-$(mktemp -d /tmp/hermes-verify.XXXXXX)}"
declare -a STEP_NAMES=() STEP_RESULTS=() STEP_SECS=() STEP_LOGS=()
VERIFY_FAILED=0
VERIFY_SKIPPED=""   # 규칙이 아닌 건너뜀 단계 이름(| 구분) — 통과 기록에 남겨 엄격 모드 재사용을 판단한다
# 통과 기록용 — 이 파일을 source 한 검증 스크립트와 그 인자(source 는 인자를 그대로 물려받는다)
VERIFY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VERIFY_SCRIPT="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
VERIFY_SCRIPT_ARGS="$*"
VERIFY_RECORD="${VERIFY_RECORD:-1}"   # reuse.sh 는 0 으로 두고 source 한다(기록하지 않는다)

verify_pass_dir() { echo "${XDG_CACHE_HOME:-$HOME/.cache}/athena/verify-pass"; }

verify_tree_hash() { # verify_tree_hash <트리> — 작업 트리 내용(추적 + 미추적, 무시 제외)의 git tree 해시
  local tree="$1" index tmp hash
  index="$(git -C "$tree" rev-parse --path-format=absolute --git-path index 2>/dev/null)" || return 1
  tmp="$(mktemp "${TMPDIR:-/tmp}/athena-verify-index.XXXXXX")" || return 1
  # 진짜 index 를 복사해 stat 정보를 재사용한다(빠르다). 복사본에만 add 하므로 스테이징은 그대로다
  [ -f "$index" ] && cp "$index" "$tmp"
  if GIT_INDEX_FILE="$tmp" git -C "$tree" add -A . >/dev/null 2>&1; then
    hash="$(GIT_INDEX_FILE="$tmp" git -C "$tree" write-tree 2>/dev/null)"
  fi
  rm -f "$tmp" "$tmp.lock"
  [ -n "${hash:-}" ] && echo "$hash"
}

verify_key() { # verify_key <검증 스크립트> <트리> <인자> — 통과 기록의 열쇠(없으면 빈 줄 · 1)
  local script="$1" tree="$2" args="$3" tree_hash script_hash file pack_json
  tree_hash="$(verify_tree_hash "$tree")" || return 1
  [ -n "$tree_hash" ] || return 1
  pack_json="$VERIFY_LIB_DIR/../../pack/pack.json"
  # 코어 검증 파일(링크가 아닌 것 — 레포별 스크립트는 팩 링크다) + 이 레포 스크립트 + 팩 설정
  script_hash="$( {
    for file in "$VERIFY_LIB_DIR"/*; do [ -f "$file" ] && [ ! -L "$file" ] && { echo "== ${file##*/}"; cat "$file"; }; done
    echo "== script"; cat "$script" 2>/dev/null
    echo "== pack.json"; [ -f "$pack_json" ] && cat "$pack_json"
  } | shasum | cut -c1-16)"
  # 실행 환경 — Node 버전 건너뜀·python3 없음 건너뜀은 환경으로 정해진다. 환경이 다르면 다시 돌게 열쇠에 넣는다
  printf 'tree %s\ndir %s\nscript %s\nargs %s\nnode %s\npython3 %s\n' "$tree_hash" "$(cd "$tree" && pwd -P)" "$script_hash" "$args" \
    "$(node -v 2>/dev/null || echo none)" "$(command -v python3 >/dev/null 2>&1 && echo yes || echo no)" | shasum | cut -c1-24
}

resolve_repo_dir() { # resolve_repo_dir <메인 체크아웃> — 검증할 트리 경로를 출력한다
  # ATHENA_VERIFY_DIR(워크트리)가 **같은 레포**의 워크트리일 때만 그쪽을 쓴다.
  # 다른 레포 워크트리를 가리키면 엉뚱한 트리를 검증하게 되므로 무시하고 메인 체크아웃을 쓴다.
  local main_dir="$1" target="${ATHENA_VERIFY_DIR:-}" main_common target_common
  if [ -z "$target" ]; then echo "$main_dir"; verify_mark_start "$main_dir"; return; fi
  main_common="$(cd "$main_dir" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)"
  target_common="$(cd "$target" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)"
  if [ -n "$main_common" ] && [ "$main_common" = "$target_common" ]; then
    git -C "$target" rev-parse --show-toplevel
    verify_mark_start "$(git -C "$target" rev-parse --show-toplevel)"
  else
    if [ "${ATHENA_VERIFY_STRICT:-0}" = 1 ]; then
      echo "❌ ATHENA_VERIFY_DIR($target)는 $(basename "$main_dir") 의 워크트리가 아니다 — 엄격 모드라 멈춘다" >&2
      exit 2
    fi
    echo "⚠️ ATHENA_VERIFY_DIR($target)는 $(basename "$main_dir") 의 워크트리가 아니다 — 메인 체크아웃을 검증한다" >&2
    echo "$main_dir"
    verify_mark_start "$main_dir"
  fi
}

# 시작할 때의 열쇠 — resolve_repo_dir 는 $(…) 안에서 불려 변수가 사라지므로 로그 폴더에 적는다(stdout 은 쓰지 않는다)
verify_mark_start() {
  [ "$VERIFY_RECORD" = 1 ] || return 0
  verify_key "$VERIFY_SCRIPT" "$1" "$VERIFY_SCRIPT_ARGS" > "$VERIFY_LOG_DIR/.start-key" 2>/dev/null || rm -f "$VERIFY_LOG_DIR/.start-key"
}

# 통과했으면 기록한다 — 시작 열쇠가 없거나(resolve_repo_dir 를 안 거친 스크립트) 끝 열쇠와 다르면(검증 중 트리가 바뀜) 기록하지 않는다
verify_record_pass() { # verify_record_pass <레포명> <트리> <브랜치> <sha>
  [ "$VERIFY_RECORD" = 1 ] && [ "$VERIFY_FAILED" = 0 ] || return 0
  local start key dir file i
  start="$(cat "$VERIFY_LOG_DIR/.start-key" 2>/dev/null)"
  [ -n "$start" ] || return 0
  key="$(verify_key "$VERIFY_SCRIPT" "$2" "$VERIFY_SCRIPT_ARGS")" || return 0
  if [ "$key" != "$start" ]; then
    echo "(통과 기록 안 함 — 검증하는 동안 트리가 바뀌었다)"; return 0
  fi
  dir="$(verify_pass_dir)"; mkdir -p "$dir" 2>/dev/null || return 0
  find "$dir" -type f -mtime +7 -delete 2>/dev/null   # 오래된 기록 정리
  file="$dir/$key"
  {
    printf 'time\t%s\nrepo\t%s\nbranch\t%s\nsha\t%s\nargs\t%s\nskipped\t%s\n' \
      "$(date '+%Y-%m-%d %H:%M')" "$1" "$3" "$4" "$VERIFY_SCRIPT_ARGS" "$VERIFY_SKIPPED"
    for i in "${!STEP_NAMES[@]}"; do printf 'step\t%s\t%s\t%s\n' "${STEP_NAMES[$i]}" "${STEP_RESULTS[$i]}" "${STEP_SECS[$i]}"; done
  } > "$file.tmp" && mv "$file.tmp" "$file"
  echo "통과 기록: ${key} — 같은 트리·스크립트·인자면 scripts/verify/reuse.sh 가 다시 돌리지 않는다"
}

check_node_version() { # check_node_version <레포경로> — .nvmrc 와 현재 node 버전이 다르면 경고 단계로 기록
  local repo_dir="$1" want cur
  [ -f "$repo_dir/.nvmrc" ] || return 0
  want="$(tr -d ' \n' < "$repo_dir/.nvmrc")"; cur="$(node -v 2>/dev/null)"
  [ -n "$want" ] || return 0
  # .nvmrc 가 "24"·"24.15" 처럼 앞자리만 적었으면 그 앞자리가 맞는지만 본다
  case "${cur#v}." in "${want#v}."*) return 0 ;; esac
  if [ "${want#v}" != "${cur#v}" ]; then
    skip_step "Node 버전" "레포는 $want 를 요구하는데 현재 $cur. 네이티브 모듈·lint 결과가 달라질 수 있다 → nvm use ${want#v}"
  fi
}

run_step() {
  local name="$1"; shift
  local log="$VERIFY_LOG_DIR/$(echo "$name" | tr ' /:' '___').log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    STEP_RESULTS+=("✅ 통과")
  else
    STEP_RESULTS+=("❌ 실패 (exit $?)"); VERIFY_FAILED=1
  fi
  STEP_NAMES+=("$name"); STEP_SECS+=("$((SECONDS - start))"); STEP_LOGS+=("$log")
}
skip_step() {
  STEP_NAMES+=("$1"); STEP_SECS+=("0"); STEP_LOGS+=("")
  VERIFY_SKIPPED="${VERIFY_SKIPPED:+$VERIFY_SKIPPED|}$1"
  # 엄격 모드: 허용 목록에 없는 건너뜀은 실패
  if [ "${ATHENA_VERIFY_STRICT:-0}" = 1 ] && ! printf '%s' "${ATHENA_VERIFY_ALLOW_SKIP:-}" | tr '|' '\n' | grep -qxF "$1"; then
    STEP_RESULTS+=("❌ 건너뜀(엄격 모드) — $2"); VERIFY_FAILED=1
  else
    STEP_RESULTS+=("⏭ 건너뜀 — $2")
  fi
}

# 규칙으로 정해진 건너뜀 — 엄격 모드에서도 통과로 친다. 이유는 스크립트가 판단한 사실이어야 한다(예: changed-screen.sh 의 "화면 파일 변경 없음")
skip_step_rule() {
  STEP_NAMES+=("$1"); STEP_SECS+=("0"); STEP_LOGS+=("")
  STEP_RESULTS+=("⏭ 건너뜀(규칙) — $2")
}

# mark_skipped <단계 번호> <이유> — 이미 돈 단계를 그 자리에서 "건너뜀"으로 바꾼다(예: 도구 설정 오류로 실행 자체가 안 된 경우).
# 배열을 지웠다 다시 만들지 않는다(bash 3.2 + set -u 에서 빈 배열 펼치기가 죽는다). 엄격 모드 판정은 skip_step 과 같다
mark_skipped() {
  local index="$1" reason="$2" result
  VERIFY_SKIPPED="${VERIFY_SKIPPED:+$VERIFY_SKIPPED|}${STEP_NAMES[$index]}"
  if [ "${ATHENA_VERIFY_STRICT:-0}" = 1 ] && ! printf '%s' "${ATHENA_VERIFY_ALLOW_SKIP:-}" | tr '|' '\n' | grep -qxF "${STEP_NAMES[$index]}"; then
    STEP_RESULTS[$index]="❌ 건너뜀(엄격 모드) — $reason"
  else
    STEP_RESULTS[$index]="⏭ 건너뜀 — $reason"
  fi
  VERIFY_FAILED=0
  for result in "${STEP_RESULTS[@]}"; do case "$result" in ❌*) VERIFY_FAILED=1 ;; esac; done
}

print_summary() { # print_summary <레포명> <레포경로>
  local repo="$1" path="$2" sha branch
  sha="$(git -C "$path" rev-parse --short HEAD 2>/dev/null || echo '?')"
  branch="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  echo
  echo "## 검증 결과 — $repo ($branch @ $sha, $(date '+%Y-%m-%d %H:%M'))"
  echo
  echo "| 단계 | 결과 | 소요 |"
  echo "|---|---|---|"
  local i
  for i in "${!STEP_NAMES[@]}"; do
    echo "| \`${STEP_NAMES[$i]}\` | ${STEP_RESULTS[$i]} | ${STEP_SECS[$i]}s |"
  done
  for i in "${!STEP_NAMES[@]}"; do
    case "${STEP_RESULTS[$i]}" in ❌*)
      echo; echo "### ❌ ${STEP_NAMES[$i]} 로그 (마지막 40줄)"; echo '```'
      tail -40 "${STEP_LOGS[$i]}"; echo '```' ;;
    esac
  done
  echo; echo "전체 로그: $VERIFY_LOG_DIR"
  verify_record_pass "$repo" "$path" "$branch" "$sha"
  [ "$VERIFY_FAILED" = 0 ]
}
