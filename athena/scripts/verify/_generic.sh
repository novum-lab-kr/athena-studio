#!/usr/bin/env bash
# 레포 공용 검증 — 새 회사 첫 실행(/setup · athena scaffold)이 만든 scripts/verify/<레포>.sh 가 부른다.
#   _generic.sh <레포> [<앱>]   (모노레포는 앱 폴더 apps/<앱> 에서)
# 레포에 있는 것만 돌린다: Node — lint · typecheck(type-check, 없으면 tsconfig · jsconfig 가 있을 때 tsc --noEmit — _lib.sh typecheck_step) · test
#                          Python — ruff check · pyright(설정이 있을 때만 — typecheck_step) · pytest (uv 가 있으면 uv run)
# 타입 검사는 순수 TS 면 오류 하나라도 실패, JS 를 섞어 쓰는 중(allowJs · checkJs · jsconfig)이거나 pyright 면 바뀐 파일 오류만 실패(전체 수는 표에)
# 설치가 안 됐거나 스크립트가 없으면 이유와 함께 ⏭(엄격 모드에선 ❌). 레포에 맞게 고치려면 레포 스크립트를 직접 쓴다
[ -z "${ATHENA_HEAVY_HELD:-}" ] && exec "$(cd "$(dirname "$0")/.." && pwd)/heavy.sh" "$0" "$@"
ATHENA_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ATHENA_DIR/scripts/verify/_lib.sh"
REPO="${1:?사용: _generic.sh <레포> [<앱>]}"; APP="${2:-}"
REPO_DIR="$(resolve_repo_dir "$ATHENA_DIR/repos/$REPO")"
[ -d "$REPO_DIR" ] || { echo "repos/$REPO 링크가 없습니다. scripts/setup.sh 를 실행하세요."; exit 2; }
WORK_DIR="$REPO_DIR"; [ -n "$APP" ] && WORK_DIR="$REPO_DIR/apps/$APP"
[ -d "$WORK_DIR" ] || { echo "앱 폴더가 없습니다: $WORK_DIR"; exit 2; }
cd "$WORK_DIR"

if [ -f package.json ]; then
  check_node_version "$REPO_DIR"
  # 패키지 매니저 — 레포 루트의 lock 으로
  PM=npm; [ -f "$REPO_DIR/pnpm-lock.yaml" ] && PM=pnpm; [ -f "$REPO_DIR/yarn.lock" ] && PM=yarn
  has_script() { node -e 'process.exit(require("./package.json").scripts?.[process.argv[1]] ? 0 : 1)' "$1"; }
  if [ ! -d node_modules ] && [ ! -d "$REPO_DIR/node_modules" ]; then
    skip_step "$PM install 확인" "node_modules 없음 — $PM install 먼저"
  else
    if has_script lint; then run_step "$PM run lint" "$PM" run lint; else skip_step "lint" "package.json 에 lint 스크립트 없음"; fi
    if has_script typecheck; then run_step "$PM run typecheck" "$PM" run typecheck
    elif has_script type-check; then run_step "$PM run type-check" "$PM" run type-check
    elif typecheck_step "$REPO"; then :
    else skip_step "typecheck" "타입 검사 스크립트·tsconfig·jsconfig 없음"; fi
    if has_script test; then run_step "$PM test" env CI=1 "$PM" test; else skip_step "test" "package.json 에 test 스크립트 없음"; fi
  fi
elif [ -f pyproject.toml ]; then
  RUN=(); command -v uv >/dev/null 2>&1 && [ -f "$REPO_DIR/uv.lock" ] && RUN=(uv run --frozen)
  if ${RUN[@]+"${RUN[@]}"} ruff --version >/dev/null 2>&1; then run_step "ruff check" ${RUN[@]+"${RUN[@]}"} ruff check .; else skip_step "ruff check" "ruff 없음"; fi
  # 설정(pyrightconfig.json · [tool.pyright])이 없으면 줄을 넣지 않는다 — 지금까지 통과하던 레포는 그대로
  typecheck_step "$REPO" || true
  if ${RUN[@]+"${RUN[@]}"} pytest --version >/dev/null 2>&1; then run_step "pytest" ${RUN[@]+"${RUN[@]}"} pytest -q; else skip_step "pytest" "pytest 없음"; fi
else
  skip_step "검증" "package.json·pyproject.toml 이 없다 — scripts/verify/$REPO.sh 를 레포에 맞게 쓴다"
fi
print_summary "$REPO${APP:+ ($APP)}" "$REPO_DIR"
