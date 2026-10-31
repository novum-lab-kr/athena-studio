# 코어 시험 공통 — 시험 파일 맨 위에서 source 한다. 통과 줄(들여 쓴 ✔)을 숨겨 도구 출력을 줄인다(계획서 D5 ④).
#   실패 줄 · 기대/실제 · 절 제목 · 시험 끝의 "✅ 통과" 는 그대로 나오고, 끝에 요약 "통과 N · 실패 M · Ns" 를 더한다. 종료 코드는 시험 그대로
#   ATHENA_TEST_VERBOSE=1 이면 예전처럼 전부 찍는다
# 시험 본문을 다시 실행해 그 출력을 거르므로 시험 안의 변수 · 출력 캡처 · 표준 오류는 그대로다
if [ "${ATHENA_TEST_VERBOSE:-0}" != 1 ] && [ -z "${ATHENA_TEST_FILTERED:-}" ]; then
  export ATHENA_TEST_FILTERED=1
  athena_test_start=$SECONDS
  bash "$0" "$@" | awk '
    /^[ \t]+✔/ { pass++; next }
    /^[ \t]+✖/ { fail++ }
    { print; fflush() }
    END { printf "통과 %d · 실패 %d", pass, fail }'
  athena_test_code=${PIPESTATUS[0]}
  echo " · $((SECONDS - athena_test_start))s"
  exit "$athena_test_code"
fi
