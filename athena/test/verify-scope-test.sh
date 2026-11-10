#!/usr/bin/env bash
# 검증을 "수정한 범위만" 돌리는 판정 시험 — scripts/verify/_lib.sh 의 verify_scope_init · verify_scope_only · verify_key 와
# scripts/verify/scope-tests.mjs(바뀐 파일에 닿는 시험 고르기) · verify 사건의 측정 칸(plan · ms · scope — verify_event_fields). 임시 git 레포만 쓴다 · 몇 초
#
# 사용: test/verify-scope-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
# 전체 검증(full-verify.mjs)은 ATHENA_VERIFY_FULL=1 을 걸고 이 시험을 돌린다 — 물려받으면 범위 · 문서 판정이 모두 "전체"가 돼
# 20여 개가 깨진다(2026-11-09~10 그림자 · 하루 한 번 검증 9번 실패). 시험은 늘 꺼진 채로 시작하고, 켠 경우는 줄마다 직접 건다
unset ATHENA_VERIFY_FULL
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
# 조각으로 적은 경로(path.join) — CHANGELOG.md · 번역 파일만 바꿔도 그것을 읽는 시험을 고른다(2026-11-01 번역 빠진 줄이 main 에 들어간 재현)
mkdir -p "$WORK/src/changelog"; echo '# Changelog' > "$WORK/CHANGELOG.md"; echo '{}' > "$WORK/src/changelog/ko.json"
cat > "$WORK/test/notes.test.js" <<'JS'
const ROOT = path.join(__dirname, '..')
const english = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
for (const lang of ['ko']) JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'changelog', `${lang}.json`), 'utf8'))
JS
RESULT="$(picks CHANGELOG.md)"
check "path.join(ROOT, 'CHANGELOG.md') → 그 시험" "$([ "$RESULT" = "JS test/notes.test.js " ] && echo 0 || echo 1)" "$RESULT"
RESULT="$(picks src/changelog/ko.json)"
check "path.join(ROOT, 'src', 'changelog', \`\${lang}.json\`) → 그 폴더의 파일도 그 시험" "$([ "$RESULT" = "JS test/notes.test.js " ] && echo 0 || echo 1)" "$RESULT"
RESULT="$(picks README.md)"
check "조각 경로가 있어도 안 닿는 파일은 그대로 빈 목록" "$([ -z "$RESULT" ] && echo 0 || echo 1)" "$RESULT"
rm -rf "$WORK/CHANGELOG.md" "$WORK/src/changelog" "$WORK/test/notes.test.js"

# 삭제 · 이름 바꿈 · 닿는 시험이 없는 앱 소스 → 종료 코드 2(부르는 쪽이 전체를 돈다)
git -C "$WORK" rm -q src/a.js
RESULT="$(picks src/a.js 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
check "지워진 파일이 바뀐 목록에 있으면 종료 코드 2" "$([[ "$RESULT" == *rc=2 ]] && echo 0 || echo 1)" "$RESULT"
git -C "$WORK" reset -q --hard
echo 'module.exports = 3' > "$WORK/src/orphan.js"
RESULT="$(picks src/orphan.js 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
check "닿는 시험이 없는 앱 소스 → 종료 코드 2" "$([[ "$RESULT" == *rc=2 ]] && echo 0 || echo 1)" "$RESULT"
rm -f "$WORK/src/orphan.js"
# 타입 선언(.d.ts)은 시험이 가져다 쓰지 않는다 — 닿는 시험이 없어도 전체로 넓히지 않는다(2026-11-08 #267 검증 5번이 모두 전체였던 재현)
echo 'declare const x: number' > "$WORK/src/api.d.ts"
RESULT="$(picks src/api.d.ts 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
check "닿는 시험이 없는 .d.ts → 종료 코드 0 · 빈 목록" "$([ "$RESULT" = "rc=0" ] && echo 0 || echo 1)" "$RESULT"
rm -f "$WORK/src/api.d.ts"
# 셸 스크립트도 앱 소스다 — 닿는 시험이 없으면 전체
mkdir -p "$WORK/scripts"; echo 'echo hi' > "$WORK/scripts/orphan.sh"
RESULT="$(picks scripts/orphan.sh 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
check "닿는 시험이 없는 scripts/*.sh → 종료 코드 2" "$([[ "$RESULT" == *rc=2 ]] && echo 0 || echo 1)" "$RESULT"
rm -f "$WORK/scripts/orphan.sh"
# 따라갈 수 없는 공통 파일(scripts/lib/**/*.sh · *.py · *.json · test/_lib.sh — 코어 쪽 포함)은 닿는 시험이 있어도 전체
#   .json 은 import 가 아니라 파일로 읽힌다(2026-11-09 재현: prompt-menu.json 만 바꾸면 .py 쪽 시험이 안 골라졌다)
mkdir -p "$WORK/athena/scripts/lib" "$WORK/athena/test"
echo ': lib' > "$WORK/athena/scripts/lib/shared.sh"; echo 'X = 1' > "$WORK/athena/scripts/lib/shared.py"; echo ': lib' > "$WORK/athena/test/_lib.sh"
echo '{}' > "$WORK/athena/scripts/lib/shared.json"; mkdir -p "$WORK/scripts/lib"; echo '{}' > "$WORK/scripts/lib/shared.json"
for shared in athena/scripts/lib/shared.sh athena/scripts/lib/shared.py athena/scripts/lib/shared.json scripts/lib/shared.json athena/test/_lib.sh; do
  RESULT="$(picks "$shared" 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
  check "따라갈 수 없는 공통 파일 $shared → 종료 코드 2(전체)" "$([[ "$RESULT" == *rc=2 ]] && echo 0 || echo 1)" "$RESULT"
done
# scripts/lib 의 .mjs 는 import 를 따라 닿는 시험만 — 전체로 넓히지 않는다(2026-11-09 lib/pr-auto.mjs 하나로 전체를 돌던 재현)
echo 'export const x = 1' > "$WORK/athena/scripts/lib/shared.mjs"
cp "$WORK/athena/scripts/board/server.mjs" "$TMP/server.mjs.bak"
echo "import { x } from '../lib/shared.mjs'" >> "$WORK/athena/scripts/board/server.mjs"
RESULT="$(picks athena/scripts/lib/shared.mjs 2>/dev/null; echo "rc=${PIPESTATUS[0]}")"
check "lib .mjs → import 로 닿는 시험만(전체 아님)" "$([ "$RESULT" = "SH athena/test/board-test.sh rc=0" ] && echo 0 || echo 1)" "$RESULT"
cp "$TMP/server.mjs.bak" "$WORK/athena/scripts/board/server.mjs"
rm -rf "$WORK/athena/scripts/lib/shared.mjs" "$WORK/athena/scripts/lib/shared.sh" "$WORK/athena/scripts/lib/shared.py" "$WORK/athena/scripts/lib/shared.json" "$WORK/scripts/lib" "$WORK/athena/test/_lib.sh"

echo "줄서기 시간 칸 — wait_ms · wait_why (ms 와 따로)"
git -C "$WORK" reset -q --hard; reset_tree   # 앞 시험이 남긴 변경을 치운다
echo '// 주석' >> "$WORK/athena/scripts/board/server.mjs"
RESULT="$(ATHENA_HEAVY_WAIT_SEC=12 ATHENA_HEAVY_WAIT_WHY='자리1: a · sleep 부하 3 = x' fields plans/task/x.md)"
check "wait_ms = 기다린 초 × 1000" "$(grep -qx 'wait_ms=12000' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
check "wait_why = 마지막 이유(= 는 : 로)" "$(grep -qx 'wait_why=자리1: a · sleep 부하 3 : x' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
check "ms 는 줄서기를 포함하지 않는다(source 한 때부터라 12초보다 훨씬 작다)" "$([ "$(grep '^ms=' <<<"$RESULT" | cut -d= -f2)" -lt 12000 ] && echo 0 || echo 1)" "$RESULT"
# 바깥 검증(commit.sh)이 줄을 서다 들어오면 그 값이 물려 들어온다 — 이 단계만 지운다
RESULT="$(unset ATHENA_HEAVY_WAIT_SEC ATHENA_HEAVY_WAIT_WHY; fields plans/task/x.md)"
check "안 기다렸으면 wait_ms=0 · wait_why 빈 값" "$(grep -qx 'wait_ms=0' <<<"$RESULT" && grep -qx 'wait_why=' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
RESULT="$(ATHENA_HEAVY_WAIT_SEC=abc ATHENA_HEAVY_WAIT_WHY=x fields)"
check "숫자가 아니면 0" "$(grep -qx 'wait_ms=0' <<<"$RESULT" && echo 0 || echo 1)" "$RESULT"
reset_tree

echo "문서만 고친 수정 — 시험·빌드를 건너뛰고 파일 점검만"
# 코어 사본(+ 팩 pack.json)을 임시로 만들어 staticDocs 를 읽게 한다
CORE="$TMP/core"; mkdir -p "$CORE/scripts" "$CORE/pack"
cp -R "$SRC/scripts/verify" "$CORE/scripts/verify"; cp -R "$SRC/scripts/lib" "$CORE/scripts/lib"
echo '{ "repos": [{ "name": "demo", "staticDocs": ["^web/privacy\\.html$"] }] }' > "$CORE/pack/pack.json"
# 정적 파일은 기준(origin/main)에 들어 있어야 바뀐 파일로 안 센다 — 원격에 커밋하고 작업 브랜치를 그 위로 옮긴다
mkdir -p "$ORIGIN/web" "$WORK/scripts"
echo '<p>x</p>' > "$ORIGIN/web/privacy.html"; echo '<p>y</p>' > "$ORIGIN/web/other.html"
git_quiet -C "$ORIGIN" add web/privacy.html web/other.html; git_quiet -C "$ORIGIN" commit -m docs-base
git_quiet -C "$WORK" fetch origin; git_quiet -C "$WORK" reset --hard origin/main   # 앞 시험이 작업 브랜치에 남긴 커밋도 버린다
mkdir -p "$WORK/scripts"
docscope() { # docscope [검증 인자…] — 출력: <모드>
  (cd "$WORK" && VERIFY_SCOPE_DOCS_EXIT=0 bash -c 'source "$1/scripts/verify/_lib.sh"; shift; verify_scope_init demo; echo "$VERIFY_SCOPE_MODE"' _ "$CORE" "$@")
}
echo '문장 추가' >> "$WORK/README.md"
check ".md 만 바뀜 → docs" "$([ "$(docscope)" = docs ] && echo 0 || echo 1)" "$(docscope)"
check "--full 이면 전체" "$([ "$(docscope --full)" = full ] && echo 0 || echo 1)" "$(docscope --full)"
echo '// 주석' >> "$WORK/src/a.js"
check ".md + 코드 → docs 아님(scoped)" "$([ "$(docscope)" = scoped ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
mkdir -p "$WORK/scripts"; echo '문장' >> "$WORK/scripts/NOTE.md"
check "scripts/ 아래 .md 는 도구가 읽을 수 있어 문서가 아님 → scoped" "$([ "$(docscope)" = scoped ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
git -C "$WORK" rm -q README.md
check "지운 문서가 있으면 지금처럼(docs 아님)" "$([ "$(docscope)" != docs ] && echo 0 || echo 1)" "$(docscope)"
git -C "$WORK" reset -q --hard
echo '<p>z</p>' >> "$WORK/web/privacy.html"
check "팩 staticDocs 에 맞는 정적 파일만 바뀜 → docs" "$([ "$(docscope)" = docs ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
echo '<p>z</p>' >> "$WORK/web/other.html"
check "staticDocs 에 안 맞는 html → docs 아님" "$([ "$(docscope)" = scoped ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
echo '<p>z</p>' >> "$WORK/web/privacy.html"; rm "$CORE/pack/pack.json"
check "pack.json 이 없으면 정적 파일은 문서가 아님 → scoped" "$([ "$(docscope)" = scoped ] && echo 0 || echo 1)" "$(docscope)"
echo '{ "repos": [{ "name": "demo", "staticDocs": ["^web/privacy\\.html$"] }] }' > "$CORE/pack/pack.json"
reset_tree

# 시험·빌드·코어 시험이 읽는 md 는 문서가 아니다(엄격 검증이 낮아지면 안 된다)
echo '- 항목' >> "$WORK/CHANGELOG.md"
check "CHANGELOG.md 만 바뀜 → docs 아님(package-mac · release-files 가 읽는다)" "$([ "$(docscope)" != docs ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
mkdir -p "$WORK/athena/docs/knowledge/common"; echo '기준' >> "$WORK/athena/docs/knowledge/common/learning.md"
check "athena/docs/knowledge/ 아래 md → docs 아님(learn-review 가 읽는다)" "$([ "$(docscope)" != docs ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
echo '규칙' >> "$WORK/athena/AGENTS.md"
check "athena/AGENTS.md → docs 아님(코어 시험이 사본을 만든다)" "$([ "$(docscope)" != docs ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
mkdir -p "$WORK/athena/docs"; echo '틀' >> "$WORK/athena/docs/plan-template-light.md"
check "athena/docs/plan-template-light.md → docs 아님(new-plan.mjs · board-auto-test 가 읽는다)" "$([ "$(docscope)" != docs ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
mkdir -p "$WORK/athena/docs"; echo '설명' >> "$WORK/athena/docs/notes.md"
check "athena/docs/ 의 일반 md 는 그대로 docs" "$([ "$(docscope)" = docs ] && echo 0 || echo 1)" "$(docscope)"
reset_tree
git -C "$WORK" mv src/a.js src/a.md
check "a.js → a.md 이름 바꾸기 → 원본이 지워진 것으로 봐 docs 아님" "$([ "$(docscope)" != docs ] && echo 0 || echo 1)" "$(docscope)"
git -C "$WORK" reset -q --hard
reset_tree

# 끝까지 — 검증 스크립트 흉내: 문서만이면 verify_scope_init 이 요약까지 내고 끝낸다(아래 단계는 돌지 않는다)
cat > "$TMP/fake-verify.sh" <<'FAKE'
source "$1/scripts/verify/_lib.sh"
verify_scope_init demo
run_step "시험이 돌면 안 된다" false
print_summary demo "$PWD"
FAKE
finish() { (cd "$WORK" && ATHENA_VERIFY_STRICT=1 VERIFY_RECORD=0 bash "$TMP/fake-verify.sh" "$CORE" 2>&1); echo "rc=$?"; }
echo '문장 추가' >> "$WORK/README.md"
RESULT="$(finish)"
check "문서만 → 파일 점검 통과 · 시험 단계는 돌지 않음 · 종료 0 (엄격 모드에서도)" "$([[ "$RESULT" == *'문서 파일 점검'*'✅'* && "$RESULT" == *'건너뜀(규칙)'* && "$RESULT" != *'시험이 돌면 안 된다'* && "$RESULT" == *rc=0 ]] && echo 0 || echo 1)" "$RESULT"
reset_tree
echo '- 항목' >> "$WORK/CHANGELOG.md"
RESULT="$(finish)"
check "CHANGELOG.md 수정은 엄격 모드에서도 시험 단계가 돈다(건너뛰지 않음)" "$([[ "$RESULT" == *'시험이 돌면 안 된다'* && "$RESULT" != *'문서 파일 점검'* ]] && echo 0 || echo 1)" "$RESULT"
reset_tree
printf '<<<<<<< HEAD\n내용\n>>>>>>> x\n' > "$WORK/README.md"
RESULT="$(finish)"
check "충돌 표시가 남은 문서 → 실패(1)" "$([[ "$RESULT" == *'❌'*'충돌 표시'* && "$RESULT" == *rc=1 ]] && echo 0 || echo 1)" "$RESULT"
reset_tree
printf '\xff\xfe' > "$WORK/README.md"
RESULT="$(finish)"
check "UTF-8 이 아닌 문서 → 실패(1)" "$([[ "$RESULT" == *'UTF-8'* && "$RESULT" == *rc=1 ]] && echo 0 || echo 1)" "$RESULT"
reset_tree
echo '// 주석' >> "$WORK/src/a.js"
RESULT="$(finish)"
check "코드가 바뀌면 그대로 시험 단계가 돈다(검증 범위를 낮추지 않음)" "$([[ "$RESULT" == *'시험이 돌면 안 된다'* ]] && echo 0 || echo 1)" "$RESULT"
reset_tree
echo '문장 추가' >> "$WORK/README.md"
RESULT="$(cd "$WORK" && ATHENA_HEAVY_WAIT_SEC=75 ATHENA_HEAVY_WAIT_WHY='자리1: x' VERIFY_RECORD=0 bash "$TMP/fake-verify.sh" "$CORE" 2>&1)"
check "요약 끝에 줄서기 시간·이유가 남음" "$([[ "$RESULT" == *'줄서기 75초'*'자리1: x'* ]] && echo 0 || echo 1)" "$RESULT"
reset_tree

exit $FAIL
