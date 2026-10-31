#!/usr/bin/env bash
# 검증을 "수정한 범위만" 돌리는 판정 시험 — scripts/verify/_lib.sh 의 verify_scope_init · verify_scope_only · verify_key 와
# scripts/verify/scope-tests.mjs(바뀐 파일에 닿는 시험 고르기) · verify 사건의 측정 칸(plan · ms · scope — verify_event_fields). 임시 git 레포만 쓴다 · 몇 초
#
# 사용: test/verify-scope-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-verify-scope-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() { # check <이름> <조건 결과 0/1> [<자세히>]
  if [ "$2" = 0 ]; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -n "${3:-}" ] && echo "      $3"; FAIL=1; fi
}
git_quiet() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@" >/dev/null 2>&1; }

# 원격(origin/main)이 있는 작업 레포
ORIGIN="$TMP/origin"; WORK="$TMP/work"
mkdir -p "$ORIGIN/athena/scripts/board" "$ORIGIN/athena/scripts/verify" "$ORIGIN/athena/test" "$ORIGIN/src" "$ORIGIN/test"
echo 'export const a = 1' > "$ORIGIN/athena/scripts/board/server.mjs"
echo 'x' > "$ORIGIN/athena/scripts/verify/_lib.sh"
echo "const a = require('../src/a.js')" > "$ORIGIN/test/a.test.js"
echo "const b = require('../src/b.js')" > "$ORIGIN/test/b.test.js"
echo 'module.exports = 1' > "$ORIGIN/src/a.js"
echo 'module.exports = 2' > "$ORIGIN/src/b.js"
printf '#!/usr/bin/env bash\nnode "$SRC/scripts/board/server.mjs"\n' > "$ORIGIN/athena/test/board-test.sh"
echo '{ "name": "x" }' > "$ORIGIN/package.json"
echo '# 설명' > "$ORIGIN/README.md"
git -C "$ORIGIN" init -q -b main && git_quiet -C "$ORIGIN" add -A && git_quiet -C "$ORIGIN" commit -m base
git_quiet clone "$ORIGIN" "$WORK"
git_quiet -C "$WORK" checkout -b feature

# 임시 레포 안에서 판정 함수를 부른다 — 출력: <모드>|<athena 만?>|<이유>
scope() { # scope [검증 인자…]
  (cd "$WORK" && bash -c '
    source "$1/scripts/verify/_lib.sh"; shift
    verify_scope_init demo
    only=no; verify_scope_only "^athena/" && only=yes
    echo "$VERIFY_SCOPE_MODE|$only|$VERIFY_SCOPE_WHY"' _ "$SRC" "$@")
}
reset_tree() { git -C "$WORK" checkout -q . && git -C "$WORK" clean -fdq; }

echo "범위 판정"
echo '// 주석' >> "$WORK/athena/scripts/board/server.mjs"
RESULT="$(scope)"
check "athena/ 만 바뀜 → 범위 모드 · athena 만" "$([ "$RESULT" = "scoped|yes|" ] && echo 0 || echo 1)" "$RESULT"
reset_tree

echo '// 주석' >> "$WORK/src/a.js"
echo '// 주석' >> "$WORK/athena/scripts/board/server.mjs"
RESULT="$(scope)"
check "앱(src/)도 바뀜 → 범위 모드 · athena 만 아님" "$([ "$RESULT" = "scoped|no|" ] && echo 0 || echo 1)" "$RESULT"
reset_tree

echo 'new' > "$WORK/athena/scripts/board/added.mjs"
RESULT="$(scope)"
check "미추적 새 파일도 바뀐 파일로 센다" "$([ "$RESULT" = "scoped|yes|" ] && echo 0 || echo 1)" "$RESULT"
reset_tree

echo '{ "name": "y" }' > "$WORK/package.json"
RESULT="$(scope)"
check "package.json 변경 → 전체" "$([[ "$RESULT" == full\|no\|*설정* ]] && echo 0 || echo 1)" "$RESULT"
reset_tree

echo '// 주석' >> "$WORK/athena/scripts/verify/_lib.sh"
RESULT="$(scope)"
check "검증 스크립트(scripts/verify/) 변경 → 전체" "$([[ "$RESULT" == full\|no\|*설정* ]] && echo 0 || echo 1)" "$RESULT"
reset_tree

echo '{}' > "$WORK/athena/tsconfig.json"
RESULT="$(scope)"
check "tsconfig 변경 → 전체" "$([[ "$RESULT" == full\|no\|*설정* ]] && echo 0 || echo 1)" "$RESULT"
reset_tree

echo '// 주석' >> "$WORK/athena/scripts/board/server.mjs"
RESULT="$(scope --full)"
check "--full → 전체" "$([[ "$RESULT" == full\|no\|*--full* ]] && echo 0 || echo 1)" "$RESULT"
RESULT="$(ATHENA_VERIFY_FULL=1 scope)"
check "ATHENA_VERIFY_FULL=1 → 전체" "$([[ "$RESULT" == full\|no\|*ATHENA_VERIFY_FULL* ]] && echo 0 || echo 1)" "$RESULT"
reset_tree

RESULT="$(scope)"
check "바뀐 파일 없음 → 전체" "$([[ "$RESULT" == full\|no\|*없어* ]] && echo 0 || echo 1)" "$RESULT"

# 기준 ref 가 없는 레포(원격 · upstream 없음)
NOBASE="$TMP/nobase"; mkdir -p "$NOBASE/athena" && echo a > "$NOBASE/athena/a.mjs"
git -C "$NOBASE" init -q -b main && git_quiet -C "$NOBASE" add -A && git_quiet -C "$NOBASE" commit -m base && echo b >> "$NOBASE/athena/a.mjs"
RESULT="$(cd "$NOBASE" && bash -c 'source "$1/scripts/verify/_lib.sh"; verify_scope_init demo; echo "$VERIFY_SCOPE_MODE|$VERIFY_SCOPE_WHY"' _ "$SRC")"
check "기준 ref 를 못 찾음 → 전체" "$([[ "$RESULT" == full\|*기준\ ref* ]] && echo 0 || echo 1)" "$RESULT"

# 팩 스크립트가 옛 코어에서도 돌도록 — 함수가 없으면 declare -F 가 실패해야 한다(스크립트가 이걸로 전체를 고른다)
RESULT="$(bash -c 'declare -F verify_scope_init >/dev/null && echo has || echo none')"
check "함수가 없는 셸에서는 declare -F 가 실패(옛 코어 → 전체)" "$([ "$RESULT" = none ] && echo 0 || echo 1)" "$RESULT"

echo "재사용 열쇠 — 트리가 같아도 기준이 달라지면 열쇠가 달라진다"
reset_tree
echo '// 주석' >> "$WORK/athena/scripts/board/server.mjs"
git_quiet -C "$WORK" add -A && git_quiet -C "$WORK" commit -m change
KEY_BEFORE="$(cd "$WORK" && bash -c 'source "$1/scripts/verify/_lib.sh"; verify_key /x/demo.sh "$2" ""' _ "$SRC" "$WORK")"
git -C "$WORK" update-ref refs/remotes/origin/main HEAD   # 기준이 현재 커밋으로 올라온 것처럼(트리는 그대로)
KEY_AFTER="$(cd "$WORK" && bash -c 'source "$1/scripts/verify/_lib.sh"; verify_key /x/demo.sh "$2" ""' _ "$SRC" "$WORK")"
check "같은 트리 · 다른 기준 → 다른 열쇠" "$([ -n "$KEY_BEFORE" ] && [ "$KEY_BEFORE" != "$KEY_AFTER" ] && echo 0 || echo 1)" "$KEY_BEFORE / $KEY_AFTER"
KEY_AGAIN="$(cd "$WORK" && bash -c 'source "$1/scripts/verify/_lib.sh"; verify_key /x/demo.sh "$2" ""' _ "$SRC" "$WORK")"
check "같은 트리 · 같은 기준 → 같은 열쇠" "$([ "$KEY_AFTER" = "$KEY_AGAIN" ] && echo 0 || echo 1)" "$KEY_AFTER / $KEY_AGAIN"

KEY_FULL="$(cd "$WORK" && ATHENA_VERIFY_FULL=1 bash -c 'source "$1/scripts/verify/_lib.sh"; verify_key /x/demo.sh "$2" ""' _ "$SRC" "$WORK")"
check "ATHENA_VERIFY_FULL 값이 다르면 열쇠가 다르다" "$([ -n "$KEY_FULL" ] && [ "$KEY_FULL" != "$KEY_AGAIN" ] && echo 0 || echo 1)" "$KEY_FULL / $KEY_AGAIN"

echo "verify 사건 칸 — plan(ATHENA_PLAN) · ms(source 한 때부터) · scope(verify_scope_init 결과)"
# 사건 파일을 쓰지 않고 칸만 뽑는다(verify_event_fields) — 줄마다 키=값
# commit.sh 의 엄격 검증 안에서 돌면 ATHENA_VERIFY_STRICT=1 이 물려와 strict 칸이 바뀐다 — 시험은 늘 비엄격으로
fields() { # fields [ATHENA_PLAN 값]
  (cd "$WORK" && ATHENA_PLAN="${1:-}" ATHENA_VERIFY_STRICT=0 bash -c '
    source "$1/scripts/verify/_lib.sh"
    verify_scope_init demo
    verify_event_fields demo feature abc123' _ "$SRC")
}
echo '// 주석' >> "$WORK/athena/scripts/board/server.mjs"
RESULT="$(fields plans/task/x.md)"
check "plan 칸 = ATHENA_PLAN" "$(grep -qx 'plan=plans/task/x.md' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
check "scope 칸 = 범위 모드(scoped)" "$(grep -qx 'scope=scoped' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
MS="$(grep '^ms=' <<<"$RESULT" | cut -d= -f2)"
check "ms 칸은 0 이상 정수" "$([[ "$MS" =~ ^[0-9]+$ ]] && echo 0 || echo 1)" "$RESULT"
check "기존 칸(repo · branch · sha · ok · strict · failed · args)도 그대로" "$(grep -qx 'repo=demo' <<<"$RESULT" && grep -qx 'branch=feature' <<<"$RESULT" && grep -qx 'sha=abc123' <<<"$RESULT" && grep -qx 'ok=true' <<<"$RESULT" && grep -qx 'strict=false' <<<"$RESULT" && grep -qx 'failed=' <<<"$RESULT" && grep -q '^args=' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
RESULT="$(fields)"
check "ATHENA_PLAN 이 없으면 plan 칸은 빈 값(옛 기록과 같다)" "$(grep -qx 'plan=' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
reset_tree
RESULT="$(ATHENA_VERIFY_FULL=1 fields plans/task/x.md)"
check "전체 모드면 scope=full" "$(grep -qx 'scope=full' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"

echo "닿는 시험 고르기 (scope-tests.mjs)"
git_quiet -C "$WORK" checkout -q -b picks
picks() { printf '%s\n' "$@" > "$TMP/changed.txt"; node "$SRC/scripts/verify/scope-tests.mjs" "$WORK" "$TMP/changed.txt" | tr '\n' ' '; }
RESULT="$(picks src/a.js)"
check "src/a.js → test/a.test.js 만" "$([ "$RESULT" = "JS test/a.test.js " ] && echo 0 || echo 1)" "$RESULT"
RESULT="$(picks athena/scripts/board/server.mjs)"
check "코어 스크립트 → 그것을 적은 코어 시험만" "$([ "$RESULT" = "SH athena/test/board-test.sh " ] && echo 0 || echo 1)" "$RESULT"
RESULT="$(picks test/b.test.js)"
check "바뀐 시험은 그 자체를 돌린다" "$([ "$RESULT" = "JS test/b.test.js " ] && echo 0 || echo 1)" "$RESULT"
RESULT="$(picks README.md)"
check "어떤 시험에도 안 닿는 파일 → 빈 목록" "$([ -z "$RESULT" ] && echo 0 || echo 1)" "$RESULT"
RESULT="$(picks src/a.js src/b.js)"
check "여러 파일 → 닿는 시험의 합" "$([ "$RESULT" = "JS test/a.test.js JS test/b.test.js " ] && echo 0 || echo 1)" "$RESULT"

# 삭제 · 이름 바꿈 · 닿는 시험이 없는 앱 소스 → 종료 코드 2(부르는 쪽이 전체를 돈다)
git -C "$WORK" rm -q src/a.js
RESULT="$(picks src/a.js 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
check "지워진 파일이 바뀐 목록에 있으면 종료 코드 2" "$([[ "$RESULT" == *rc=2 ]] && echo 0 || echo 1)" "$RESULT"
git -C "$WORK" reset -q --hard
echo 'module.exports = 3' > "$WORK/src/orphan.js"
RESULT="$(picks src/orphan.js 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
check "닿는 시험이 없는 앱 소스 → 종료 코드 2" "$([[ "$RESULT" == *rc=2 ]] && echo 0 || echo 1)" "$RESULT"

exit $FAIL
