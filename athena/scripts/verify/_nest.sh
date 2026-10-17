#!/usr/bin/env bash
# NestJS 백엔드 레포 공통 검증: eslint(고치지 않음) → tsc --noEmit → jest(단위). 레포별 래퍼가 source 한 뒤 verify_nest 를 부른다.
#   verify_nest <레포명> [--no-test]
# - 레포의 `lint` 스크립트는 대부분 `--fix` 가 붙어 파일을 고친다 → 검증은 같은 대상(globs)을 eslint 로 직접, 고치지 않고 돌린다
# - `build`(nest build)는 dist 를 쓴다 → 타입 검사는 tsc --noEmit 으로 대신한다. 빌드와 같은 범위를 보도록 tsconfig.build.json 우선
# - 도구는 node_modules/.bin 에서 바로 부른다 — pnpm 11 의 `pnpm exec` 는 설치 상태 검사(승인 안 된 빌드 스크립트 등)에서 먼저 실패한다
# - Prisma 레포는 생성물(`__generated__/`, git 무시)이 없으면 `pnpm prisma:generate` 로 만든 뒤 검사한다
# - e2e(test:e2e)·마이그레이션은 DB 가 필요해 돌리지 않는다 — "실행 못 함"으로 표시(엄격 모드에서는 생략)
verify_nest() {
  local repo="$1" no_test="${2:-}" lint_globs tsconfig has_eslint_config=0 config_file
  REPO_DIR="$(resolve_repo_dir "$ATHENA_DIR/repos/$repo")"
  [ -d "$REPO_DIR" ] || { echo "repos/$repo 링크가 없습니다. scripts/setup.sh 를 실행하세요."; exit 2; }
  cd "$REPO_DIR"
  check_node_version "$REPO_DIR"
  local bin="$REPO_DIR/node_modules/.bin"

  if [ ! -d node_modules ]; then
    skip_step "pnpm install 확인" "node_modules 없음 — pnpm install 먼저"
    print_summary "$repo" "$REPO_DIR"; return
  fi

  # Prisma 생성물 — tsconfig paths 가 __generated__ 를 가리키는데 폴더가 없으면 만든다
  if node -e 'process.exit(require("./package.json").scripts?.["prisma:generate"] ? 0 : 1)' && [ ! -d __generated__ ] && grep -q '__generated__' tsconfig.json 2>/dev/null; then
    run_step "pnpm prisma:generate" pnpm run --silent prisma:generate
  fi

  # eslint 설정 파일이 없는 레포가 있다 — 원래 lint 를 안 쓰는 것이라 엄격 모드(commit.sh)에서는 줄을 넣지 않는다
  for config_file in .eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml eslint.config.js eslint.config.mjs eslint.config.cjs eslint.config.ts; do
    [ -f "$config_file" ] && { has_eslint_config=1; break; }
  done
  # lint 스크립트의 대상 globs 를 그대로 쓴다 (예: eslint "{src,test}/**/*.ts" --fix → "{src,test}/**/*.ts")
  lint_globs="$(node -e 'const s=require("./package.json").scripts?.lint||""; const m=s.match(/eslint\s+"([^"]+)"/); process.stdout.write(m?m[1]:"")')"
  if [ "$has_eslint_config" = 0 ]; then
    [ "${ATHENA_VERIFY_STRICT:-0}" = 1 ] || skip_step "eslint (고치지 않음)" "eslint 설정 파일 없음 — 레포가 lint 를 쓰지 않는다"
  elif [ -n "$lint_globs" ]; then
    run_step "eslint (고치지 않음)" "$bin/eslint" "$lint_globs"
  else
    skip_step "eslint (고치지 않음)" "package.json lint 스크립트에서 eslint 대상을 찾지 못함"
  fi

  tsconfig="tsconfig.json"; [ -f tsconfig.build.json ] && tsconfig="tsconfig.build.json"
  run_step "tsc --noEmit ($tsconfig)" "$bin/tsc" --noEmit -p "$tsconfig"

  if [ "$no_test" = "--no-test" ]; then
    skip_step "jest (단위)" "--no-test 지정"
  elif [ -n "${NEST_JEST_LIVE_ENV:-}" ] && [ -f "$NEST_JEST_LIVE_ENV" ]; then
    # 단위 테스트에 실DB·Redis·발송 테스트가 섞여, jest 가 읽는 env 파일이 있으면 실제 dev 자원에 붙는다 — 돌리지 않는다
    skip_step "jest (단위)" "$NEST_JEST_LIVE_ENV 가 있어 돌리지 않음 — 테스트가 그 env 로 실DB·외부 발송에 붙는다. 그 파일 없는 워크트리에서 검증"
  elif node -e 'process.exit(require("./package.json").scripts?.test ? 0 : 1)'; then
    run_step "jest (단위)" "$bin/jest" --passWithNoTests
  else
    skip_step "jest (단위)" "test 스크립트 없음"
  fi
  # e2e 는 늘 못 돌리므로 엄격 모드(commit.sh)에서는 줄을 넣지 않는다 — 넣으면 건너뜀이 실패로 쳐져 커밋이 항상 막힌다
  [ "${ATHENA_VERIFY_STRICT:-0}" = 1 ] || skip_step "jest e2e" "DB 가 필요해 돌리지 않음 — 실행 못 함"
  print_summary "$repo" "$REPO_DIR"
}
