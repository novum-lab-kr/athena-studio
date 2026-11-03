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

# 시험이 띄운 서버(현황판 등) 지키기 — 시험 셸이 SIGKILL · 시간 초과로 끝나면 EXIT trap 이 돌지 않아 서버가 ppid 1 고아로 남는다
#   (2026-11-03 재현: board-plan-followup-test 를 SIGKILL 하면 server.mjs 가 남음 · 그런 고아 69개가 열린 파일 한도를 채워 ENFILE).
#   시험 셸이 사라지면 그 pid 를 끈다 · 서버가 먼저 끝나면(정상 cleanup) 지킴이도 끝난다. 출력은 막는다 — 필터 파이프(awk)를 붙잡지 않게
#   사용: 서버를 & 로 띄운 직후 athena_test_guard "$SERVER_PID"
athena_test_guard() {
  local owner=$$ target=$1
  (
    while kill -0 "$owner" 2>/dev/null && kill -0 "$target" 2>/dev/null; do sleep 1; done
    kill "$target" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
}

# 전에 끊긴 같은 시험이 남긴 고아 서버 끄기 — ppid 1 · 이름 node · 작업 폴더가 같은 이름의 임시 폴더(mktemp 의 .XXXXXX 만 다른 것) 아래인 것만,
#   확인한 pid 만 kill. 돌고 있는 같은 시험의 서버는 부모가 그 시험 셸이라(ppid 1 아님) 건드리지 않는다
#   사용: 임시 폴더를 만든 직후 athena_test_reap "$TMP"   (TMP = mktemp -d ".../<시험 이름>.XXXXXX")
athena_test_reap() {
  local prefix pid ppid comm cwd
  prefix="$(cd "$1" && pwd -P)" || return 0
  prefix="${prefix%.*}."
  while read -r pid ppid comm; do
    [ "$ppid" = 1 ] || continue
    case "$comm" in node | */node) ;; *) continue ;; esac
    if [ -e "/proc/$pid/cwd" ]; then
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
    else
      cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    fi
    case "$cwd" in "$prefix"*) kill "$pid" 2>/dev/null ;; esac
  done < <(ps -axo pid=,ppid=,comm= 2>/dev/null)
}
