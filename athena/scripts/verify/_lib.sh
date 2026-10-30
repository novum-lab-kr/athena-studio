#!/usr/bin/env bash
# 검증 스크립트 공통 라이브러리. 각 레포 스크립트가 source 해서 쓴다.
#   run_step "<이름>" <명령...>   → 실행·시간 측정·로그 저장, 실패해도 계속 진행
#   skip_step "<이름>" "<이유>"   → 건너뜀으로 기록
#   skip_step_rule "<이름>" "<이유>" → 규칙으로 정해진 건너뜀(예: 화면 파일 변경 없음 — changed-screen.sh). 엄격 모드에서도 실패로 치지 않는다
#   print_summary                 → 표준 형식 요약 출력, 실패가 있으면 exit 1
#   typecheck_step <레포> [--all|--changed] → 타입 검사(tsc --noEmit · pyright). 지금 폴더에 설정이 있을 때만 줄을 넣는다(없으면 1)
#
# 타입 검사(typecheck_step) — 지금 폴더(cd 한 레포 · 앱 폴더)의 설정을 본다
#   Node   — tsconfig.json → jsconfig.json 순. node_modules/.bin/tsc(그 폴더 · 레포 맨 위)로 tsc --noEmit -p <설정> --pretty false
#   Python — pyrightconfig.json 또는 pyproject.toml 의 [tool.pyright] 가 있을 때 pyright --outputjson(uv.lock 이 있으면 uv run --frozen)
#   점진(--changed) — 바뀐 파일(기준 ref 와의 merge-base 대비 커밋 + 미커밋 + 미추적 · changed-screen.sh 와 같은 셈)의 오류만 실패.
#                    전체 오류 수는 결과 칸에 숫자로만. 기준 ref = 팩 prBase 의 origin/<prBase> → upstream → origin/HEAD → origin/main
#   전체(--all)    — 오류가 하나라도 있으면 실패(이미 타입이 깨끗한 레포)
#   둘 다 안 주면 — tsconfig 에 allowJs · checkJs 가 없으면(순수 TS) 전체, 있거나 jsconfig · pyright 면 점진(docs/knowledge/common/coding.md "언어 · 타입")
#
# 엄격 모드(ATHENA_VERIFY_STRICT=1, scripts/commit.sh 가 켠다) — 커밋 전 검증용
#   - 건너뜀(⏭)도 실패로 친다. 사용자가 확인한 단계만 ATHENA_VERIFY_ALLOW_SKIP="이름1|이름2" 로 허용
#   - ATHENA_VERIFY_DIR 가 이 레포 워크트리가 아니면 메인 체크아웃으로 돌아가지 않고 멈춘다
#
# 통과 기록 — 통과하면 "트리 내용 + 검증 스크립트 + 인자" 열쇠로 레포 밖에 기록한다
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
  # 기준 merge-base — 범위 검증(verify_scope_init)은 기준 대비 바뀐 파일로 단계를 정한다. 트리가 같아도 기준이 달라지면 범위가 달라지니 열쇠에 넣는다
  printf 'tree %s\ndir %s\nscript %s\nargs %s\nnode %s\npython3 %s\nbase %s\n' "$tree_hash" "$(cd "$tree" && pwd -P)" "$script_hash" "$args" \
    "$(node -v 2>/dev/null || echo none)" "$(command -v python3 >/dev/null 2>&1 && echo yes || echo no)" \
    "$(verify_merge_base "$(basename "$script" .sh)" "$tree" || echo none)" | shasum | cut -c1-24
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

verify_pack_prbase() { # verify_pack_prbase <레포> — 팩 pack.json 의 그 레포 prBase(없으면 빈 줄)
  local pack_json="$VERIFY_LIB_DIR/../../pack/pack.json"
  [ -f "$pack_json" ] || return 0
  if command -v node >/dev/null 2>&1; then
    node -e 'const pack = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const repo = (pack.repos ?? []).find((item) => item.name === process.argv[2]); process.stdout.write(repo?.prBase ?? "")' "$pack_json" "$1" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import json, sys; repos = json.load(open(sys.argv[1])).get("repos", []); print(next((item.get("prBase", "") for item in repos if item.get("name") == sys.argv[2]), ""), end="")' "$pack_json" "$1" 2>/dev/null
  fi
}

# verify_merge_base <레포> <트리> — 기준 ref 와의 merge-base SHA(못 찾으면 빈 줄 · 1). 기준 ref = 팩 prBase 의 origin/<prBase> → upstream → origin/HEAD → origin/main
verify_merge_base() {
  local repo="$1" tree="$2" pr_base base="" candidate merge_base=""
  pr_base="$(verify_pack_prbase "$repo")"
  for candidate in ${pr_base:+"origin/$pr_base"} '@{upstream}' origin/HEAD origin/main; do
    git -C "$tree" rev-parse -q --verify "$candidate^{commit}" >/dev/null 2>&1 && { base="$candidate"; break; }
  done
  [ -n "$base" ] && merge_base="$(git -C "$tree" merge-base HEAD "$base" 2>/dev/null)"
  [ -n "$merge_base" ] && echo "$merge_base"
}

# verify_changed_files <레포> — 지금 폴더가 든 git 트리에서 바뀐 파일의 절대 경로(실제 경로)를 한 줄에 하나.
# 기준 ref 를 못 찾으면 미커밋 · 미추적만 내고 1 을 돌려준다(부르는 쪽이 그 사실을 표에 적는다)
verify_changed_files() {
  local repo="$1" merge_base top status=0
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  top="$(cd "$top" && pwd -P)"
  merge_base="$(verify_merge_base "$repo" "$top")"
  [ -n "$merge_base" ] || status=1
  {
    [ -n "$merge_base" ] && git -c core.quotePath=false -C "$top" diff --name-only "$merge_base" HEAD
    git -c core.quotePath=false -C "$top" diff --name-only --cached
    git -c core.quotePath=false -C "$top" diff --name-only
    git -c core.quotePath=false -C "$top" ls-files --others --exclude-standard --full-name
  } | sort -u | sed "s#^#$top/#"
  return $status
}

# ── 수정한 범위만 검증하기 ─────────────────────────────────────────────────
# 팩 검증 스크립트가 쓴다(코어가 옛 설치본이면 함수가 없다 — declare -F verify_scope_init 로 확인하고 없으면 전체를 돌린다):
#   if declare -F verify_scope_init >/dev/null; then verify_scope_init "$REPO"; else VERIFY_SCOPE_MODE=full; fi
#   if [ "$VERIFY_SCOPE_MODE" = scoped ] && ! verify_scope_has '^web/'; then skip_step_rule "<단계>" "$(verify_scope_why '웹')"; else run_step … ; fi
# verify_scope_init <레포>   → VERIFY_SCOPE_MODE=scoped|full · VERIFY_SCOPE_FILES(트리 맨 위 기준 상대 경로, 한 줄에 하나) · VERIFY_SCOPE_WHY(전체로 돈 이유)
#   모르면 전체(full): --full(검증 인자) · ATHENA_VERIFY_FULL=1 · 기준 ref 없음 · 바뀐 파일 없음 · package.json / lockfile / tsconfig 같은 설정이나 검증 스크립트가 바뀜
# verify_scope_has <정규식>  → 바뀐 파일 중 하나라도 맞으면 0 (full 이면 늘 0)
# verify_scope_only <정규식> → 바뀐 파일이 모두 맞으면 0 (full 이면 늘 1)
# verify_scope_why <이름>    → skip_step_rule 의 이유 글: "<이름> 쪽 변경 없음 (바뀐 파일 N개)"
VERIFY_SCOPE_MODE=full; VERIFY_SCOPE_FILES=""; VERIFY_SCOPE_WHY=""
VERIFY_SCOPE_CONFIG_RE='(^|/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|tsconfig[^/]*\.json|jsconfig[^/]*\.json|\.nvmrc|vite\.config\.[a-z]+|pyproject\.toml|pyrightconfig\.json|requirements[^/]*\.txt|\.github/.+)$|(^|/)scripts/verify/'

verify_scope_init() { # verify_scope_init <레포> — 지금 폴더(레포 안)에서 부른다
  local repo="$1" top changed file config=""
  VERIFY_SCOPE_MODE=full; VERIFY_SCOPE_FILES=""; VERIFY_SCOPE_WHY=""
  case " ${VERIFY_SCRIPT_ARGS} " in *" --full "*) VERIFY_SCOPE_WHY="--full — 전체를 돌린다"; return 0 ;; esac
  [ "${ATHENA_VERIFY_FULL:-0}" = 1 ] && { VERIFY_SCOPE_WHY="ATHENA_VERIFY_FULL=1 — 전체를 돌린다"; return 0; }
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || { VERIFY_SCOPE_WHY="git 트리가 아니라 전체를 돌린다"; return 0; }
  top="$(cd "$top" && pwd -P)"
  if ! changed="$(verify_changed_files "$repo")"; then
    VERIFY_SCOPE_WHY="기준 ref 를 못 찾아 전체를 돌린다"; return 0
  fi
  VERIFY_SCOPE_FILES="$(printf '%s\n' "$changed" | grep -v '^$' | sed "s#^$top/##")"
  if [ -z "$VERIFY_SCOPE_FILES" ]; then
    VERIFY_SCOPE_WHY="바뀐 파일이 없어 전체를 돌린다"; return 0
  fi
  config="$(printf '%s\n' "$VERIFY_SCOPE_FILES" | grep -E "$VERIFY_SCOPE_CONFIG_RE" | head -3 | tr '\n' ' ')"
  if [ -n "$config" ]; then
    VERIFY_SCOPE_WHY="설정 · 검증 스크립트가 바뀌어(${config% }) 전체를 돌린다"; return 0
  fi
  VERIFY_SCOPE_MODE=scoped
}

verify_scope_has() {
  [ "$VERIFY_SCOPE_MODE" = scoped ] || return 0
  printf '%s\n' "$VERIFY_SCOPE_FILES" | grep -qE "$1"
}
verify_scope_only() {
  [ "$VERIFY_SCOPE_MODE" = scoped ] || return 1
  ! printf '%s\n' "$VERIFY_SCOPE_FILES" | grep -vqE "$1"
}
verify_scope_why() { # verify_scope_why <이름>
  printf '%s 쪽 변경 없음 (바뀐 파일 %s개 · 전체는 --full)' "$1" "$(printf '%s\n' "$VERIFY_SCOPE_FILES" | grep -c .)"
}

typecheck_step() {
  local repo="$1" mode="${2:-auto}" config="" kind="" top bin="" name log changed_list errors_list note=""
  local total=0 global=0 changed=0 show_config
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || top="$PWD"
  if [ -f tsconfig.json ]; then config=tsconfig.json; kind=tsc
  elif [ -f jsconfig.json ]; then config=jsconfig.json; kind=tsc
  elif [ -f pyrightconfig.json ] || { [ -f pyproject.toml ] && grep -q '^\[tool\.pyright\]' pyproject.toml; }; then kind=pyright
  else return 1; fi

  if [ "$kind" = tsc ]; then
    name="tsc --noEmit ($config)"
    for candidate in "$PWD/node_modules/.bin/tsc" "$top/node_modules/.bin/tsc"; do [ -x "$candidate" ] && { bin="$candidate"; break; }; done
    [ -n "$bin" ] || { skip_step "$name" "typescript 가 설치되지 않음(node_modules/.bin/tsc 없음)"; return 0; }
    if [ "$mode" = auto ]; then
      mode=--all
      [ "$config" = jsconfig.json ] && mode=--changed
      # tsc --showConfig 는 extends 까지 풀어 준다(타입 검사는 하지 않아 빠르다)
      show_config="$("$bin" --showConfig -p "$config" 2>/dev/null)"
      printf '%s' "$show_config" | grep -Eq '"(allowJs|checkJs)": *true' && mode=--changed
    fi
  else
    name="pyright"
    if command -v uv >/dev/null 2>&1 && [ -f "$top/uv.lock" ] && uv run --frozen pyright --version >/dev/null 2>&1; then bin="uv run --frozen pyright"
    elif command -v pyright >/dev/null 2>&1; then bin=pyright
    else skip_step "$name" "pyright 가 설치되지 않음 — uv add --dev pyright 또는 npm i -g pyright"; return 0; fi
    command -v python3 >/dev/null 2>&1 || { skip_step "$name" "python3 없음 — pyright 결과를 읽지 못함"; return 0; }
    [ "$mode" = auto ] && mode=--changed
  fi

  log="$VERIFY_LOG_DIR/$(echo "$name" | tr ' /:()' '_____').log"
  changed_list="$VERIFY_LOG_DIR/.typecheck-changed"; errors_list="$VERIFY_LOG_DIR/.typecheck-errors"
  local start=$SECONDS
  verify_changed_files "$repo" > "$changed_list" || note=" · 기준 ref 를 못 찾아 미커밋 파일만 봄"
  if [ "$kind" = tsc ]; then
    "$bin" --noEmit -p "$config" --pretty false > "$log.raw" 2>&1
    local tsc_status=$?
    # 오류 줄: <경로>(줄,칸): error TSnnnn: … — 경로는 지금 폴더 기준. 파일 없는 오류(error TSnnnn: — 설정 오류)는 따로 센다
    # 경로를 실제 절대 경로로 — tsc 는 지금 폴더 기준 상대 경로(../ 로 폴더 밖 파일도)를 낸다. 바뀐 파일 목록(실제 경로)과 같은 모양으로 맞춘다
    # errors_list: 오류마다 "<절대 경로>\t<원래 줄>"
    node -e '
const { readFileSync, realpathSync } = require("fs")
const { resolve } = require("path")
const real = (path) => { try { return realpathSync(path) } catch { return path } }
const pattern = /^([^ ].*)\(\d+,\d+\): error TS\d+/
for (const line of readFileSync(process.argv[1], "utf8").split("\n")) {
  const found = line.match(pattern)
  if (found) console.log(`${real(resolve(found[1]))}\t${line}`)
}
' "$log.raw" > "$errors_list"
    total="$(wc -l < "$errors_list" | tr -d ' ')"
    global="$(grep -cE '^error TS[0-9]+' "$log.raw")"
    changed="$(cut -f1 "$errors_list" | grep -cFxf "$changed_list")"
    # 오류를 하나도 못 읽었는데 tsc 가 실패했으면 검사 자체가 돌지 않은 것 — 실패로 둔다
    [ "$tsc_status" != 0 ] && [ "$total" = 0 ] && [ "$global" = 0 ] && global=1
  else
    $bin --outputjson > "$log.raw" 2>"$log.err"
    # pyright JSON — generalDiagnostics[].severity == "error" 를 센다. 읽지 못하면 global 1(실패)
    read -r total changed global < <(python3 -I -c '
import json, os, sys
changed = set(os.path.realpath(line) for line in open(sys.argv[2], encoding="utf-8").read().split("\n") if line)
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError):
    print(0, 0, 1); sys.exit()
errors = [item for item in data.get("generalDiagnostics", []) if item.get("severity") == "error"]
hit = [item for item in errors if os.path.realpath(item.get("file", "")) in changed]
print(len(errors), len(hit), 0)
' "$log.raw" "$changed_list")
    python3 -I -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except (OSError, ValueError):
    sys.exit()
for item in data.get("generalDiagnostics", []):
    if item.get("severity") != "error":
        continue
    line = item.get("range", {}).get("start", {}).get("line", 0) + 1
    message = (item.get("message") or "").split("\n")[0]
    print("%s:%d: %s" % (item.get("file", ""), line, message))
' "$log.raw" > "$errors_list.text" 2>/dev/null
  fi
  # 로그 — 실패하면 print_summary 가 마지막 40줄을 보여 준다. 바뀐 파일 오류를 맨 뒤에 모아 둔다
  {
    if [ "$kind" = tsc ]; then head -200 "$log.raw"; else cat "$log.err" "$errors_list.text" 2>/dev/null | head -200; fi
    echo "== 전체 오류 $total · 바뀐 파일 오류 $changed · 설정 오류 $global ($mode$note)"
    if [ "$kind" = tsc ]; then
      while IFS=$'\t' read -r path line; do grep -qFx "$path" "$changed_list" && printf '%s\n' "$line"; done < "$errors_list" | tail -30
    else grep -F -f "$changed_list" "$errors_list.text" 2>/dev/null | tail -30; fi
  } > "$log"
  STEP_NAMES+=("$name"); STEP_SECS+=("$((SECONDS - start))"); STEP_LOGS+=("$log")
  if [ "$global" -gt 0 ]; then
    STEP_RESULTS+=("❌ 실패 — 설정 · 실행 오류(로그 확인)"); VERIFY_FAILED=1
  elif [ "$mode" = --all ] && [ "$total" -gt 0 ]; then
    STEP_RESULTS+=("❌ 실패 — 오류 ${total}개"); VERIFY_FAILED=1
  elif [ "$mode" = --all ]; then
    STEP_RESULTS+=("✅ 통과 — 오류 0")
  elif [ "$changed" -gt 0 ]; then
    STEP_RESULTS+=("❌ 실패 — 바뀐 파일 오류 ${changed}개 (전체 ${total}개$note)"); VERIFY_FAILED=1
  else
    STEP_RESULTS+=("✅ 통과 — 바뀐 파일 오류 0 (전체 ${total}개 · 점진$note)")
  fi
  return 0
}

verify_log_event() { # verify_log_event <레포명> <브랜치> <sha> — 측정용 사건 기록(docs/events.md). reuse.sh 의 재사용은 새 검증이 아니라 남기지 않는다
  [ "$VERIFY_RECORD" = 1 ] && command -v node >/dev/null 2>&1 || return 0
  local failed="" ok=false strict=false i
  for i in "${!STEP_NAMES[@]}"; do
    case "${STEP_RESULTS[$i]}" in ❌*) failed="${failed:+$failed|}${STEP_NAMES[$i]}" ;; esac
  done
  [ "$VERIFY_FAILED" = 0 ] && ok=true
  [ "${ATHENA_VERIFY_STRICT:-0}" = 1 ] && strict=true
  node "$VERIFY_LIB_DIR/../lib/events.mjs" verify repo="$1" branch="$2" sha="$3" ok="$ok" strict="$strict" failed="$failed" args="$VERIFY_SCRIPT_ARGS" >/dev/null 2>&1 || true
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
  verify_log_event "$repo" "$branch" "$sha"
  [ "$VERIFY_FAILED" = 0 ]
}
