# 코어 시험 공통 — 시험 파일 맨 위에서 source 한다. 통과 줄(들여 쓴 ✔)을 숨겨 도구 출력을 줄인다(계획서 D5 ④).
#   실패 줄 · 기대/실제 · 절 제목 · 시험 끝의 "✅ 통과" 는 그대로 나오고, 끝에 요약 "통과 N · 실패 M · Ns" 를 더한다. 종료 코드는 시험 그대로
#   ATHENA_TEST_VERBOSE=1 이면 예전처럼 전부 찍는다
# 통과하면 "트리 지문 · 시험 이름" 을 남긴다(scripts/verify/core-test-pass.sh) — 검증 스크립트가 같은 트리에서 이 시험을 또 돌리지 않는다.
#   시험 도중 트리가 바뀌었거나 실패했거나 ATHENA_TEST_NO_RECORD=1 이면 남기지 않는다
# 시험 본문을 다시 실행해 그 출력을 거르므로 시험 안의 변수 · 출력 캡처 · 표준 오류는 그대로다
if [ "${ATHENA_TEST_VERBOSE:-0}" != 1 ] && [ -z "${ATHENA_TEST_FILTERED:-}" ]; then
  export ATHENA_TEST_FILTERED=1
  athena_test_start=$SECONDS
  athena_test_helper="$(cd "$(dirname "$0")/.." && pwd -P)/scripts/verify/core-test-pass.sh"
  athena_test_tree="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)"
  athena_test_name="test/$(basename "$0")"
  athena_test_key=""
  if [ "${ATHENA_TEST_NO_RECORD:-0}" != 1 ] && [ -x "$athena_test_helper" ] && [ -n "$athena_test_tree" ]; then
    athena_test_key="$("$athena_test_helper" key "$athena_test_tree" "$athena_test_name" 2>/dev/null)"
  fi
  bash "$0" "$@" | awk '
    /^[ \t]+✔/ { pass++; next }
    /^[ \t]+✖/ { fail++ }
    { print; fflush() }
    END { printf "통과 %d · 실패 %d", pass, fail }'
  athena_test_code=${PIPESTATUS[0]}
  echo " · $((SECONDS - athena_test_start))s"
  [ "$athena_test_code" = 0 ] && [ -n "$athena_test_key" ] && "$athena_test_helper" record "$athena_test_tree" "$athena_test_name" "$athena_test_key" "$((SECONDS - athena_test_start))" 2>/dev/null
  exit "$athena_test_code"
fi
