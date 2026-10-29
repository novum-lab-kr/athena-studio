#!/usr/bin/env bash
# red-check 시험 — 가짜 레포(임시 폴더 · origin 은 맨 레포)로 결과마다 한 번씩 · 임시 워크트리 정리 · 계획서 줄 · PR 본문 "확인 필요" 넣기
# (scripts/red-check.mjs · scripts/lib/red-check.mjs · scripts/verify/red-check.sh) — 진짜 팩 · GitHub 를 건드리지 않는다 · 몇 초
#
# 사용: test/red-check-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1 (KEEP=1 이면 임시 폴더를 남긴다)
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-red-check-test.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() {   # <이름> <조건 셸 식> [실패 때 보일 것]
  if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -n "${3:-}" ] && echo "      $3"; FAIL=1; fi
}
git() { command git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c core.hooksPath=/dev/null "$@"; }
export ATHENA_WORKTREE_ROOT="$TMP/worktrees"
NODE_SPEC='{"tests":["test/**/*.test.mjs"],"run":"node --test {files}"}'

# ── 가짜 레포 — main: 일부러 틀린 add(빼기) · 맞는 mul ────────────────────────
git init -q --bare "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/repo" 2>/dev/null
cd "$TMP/repo" || exit 1
mkdir -p lib test
printf 'export const add = (left, right) => left - right\nexport const mul = (left, right) => left * right\n' > lib/math.mjs
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { mul } from '../lib/math.mjs'\ntest('mul', () => assert.equal(mul(2, 3), 6))\n" > test/mul.test.mjs
printf 'node_modules/\n' > .gitignore
git add -A && git commit -qm base && git push -q origin main 2>/dev/null
BASE_SHA="$(git rev-parse HEAD)"

# 사례마다 main 에서 새 브랜치 — <브랜치> 다음 셸 명령으로 바꾼다(커밋 여부는 사례가 정한다)
case_branch() { git checkout -q -f main && git clean -qfdx && git checkout -q -b "$1"; }
red() { node "$SRC/scripts/red-check.mjs" --dir "$TMP/repo" --repo fake --base origin/main "$@" 2>"$TMP/stderr"; }
json_field() { node -e 'const data = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(String(data[process.argv[1]] ?? ""))' "$1"; }

echo "▶ 결과마다"
# ① ok (assertion) — add 를 고치고 그걸 검사하는 테스트를 더한다(커밋)
case_branch fix-add
printf 'export const add = (left, right) => left + right\nexport const mul = (left, right) => left * right\n' > lib/math.mjs
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../lib/math.mjs'\ntest('add', () => assert.equal(add(1, 2), 3))\n" > test/add.test.mjs
git add -A && git commit -qm fix
OUT="$(red --spec "$NODE_SPEC" --json)"; CODE=$?
check "ok(assertion) — base 에서 단정 실패" '[ "$(json_field result <<<"$OUT")" = ok ] && grep -q "ok (assertion)" <<<"$OUT" && [ $CODE = 0 ]' "$OUT · exit $CODE · $(cat "$TMP/stderr")"
check "ok — 결과 칸에 base sha · 테스트 수" 'grep -q "바뀐 테스트 1개가 구현 없이(base @${BASE_SHA:0:7}) 실패" <<<"$OUT"' "$OUT"

# ② ok (compile) — 새 구현 파일을 불러오는 새 테스트(미커밋 · 미추적) → base 에는 모듈이 없다
case_branch new-module
printf 'export const square = (value) => value * value\n' > lib/square.mjs
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { square } from '../lib/square.mjs'\ntest('square', () => assert.equal(square(3), 9))\n" > test/square.test.mjs
OUT="$(red --spec "$NODE_SPEC" --json)"; CODE=$?
check "ok(compile) — 미추적 새 테스트 · 새 모듈이 없어 실패 · 약한 근거 표시" '[ "$(json_field result <<<"$OUT")" = ok ] && grep -q "ok (compile · 약한 근거" <<<"$OUT" && [ $CODE = 0 ]' "$OUT · $(cat "$TMP/stderr")"

OUT="$(red --spec "$NODE_SPEC" --json --committed)"
check "--committed — 커밋 안 된 테스트 · 구현은 보지 않는다(ship.sh · PR 에 올라가는 것만)" '[ "$(json_field result <<<"$OUT")" = no-tests ] && grep -q "구현 0개" <<<"$OUT"' "$OUT"

# ③ non-discriminating — 구현을 바꾸고 이미 참인 것만 검사하는 테스트(미커밋 수정)
case_branch weak-test
printf '// 주석만 바꿈\nexport const add = (left, right) => left - right\nexport const mul = (left, right) => left * right\n' > lib/math.mjs
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { mul } from '../lib/math.mjs'\ntest('mul', () => assert.equal(mul(2, 3), 6))\ntest('mul zero', () => assert.equal(mul(0, 3), 0))\n" > test/mul.test.mjs
OUT="$(red --spec "$NODE_SPEC" --json)"; CODE=$?
check "non-discriminating — base 에서도 통과 · exit 1(경고)" '[ "$(json_field result <<<"$OUT")" = non-discriminating ] && grep -q "test/mul.test.mjs" <<<"$OUT" && [ $CODE = 1 ]' "$OUT · exit $CODE"

# ③-2 여러 파일 중 하나만 통과해도 그 파일을 non-discriminating 으로
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../lib/math.mjs'\ntest('add', () => assert.equal(add(1, 2), 3))\n" > test/add.test.mjs
OUT="$(red --spec "$NODE_SPEC" --json)"
check "non-discriminating — 통과한 파일만 적는다" '[ "$(json_field result <<<"$OUT")" = non-discriminating ] && ! grep -q "add.test" <<<"$(json_field files <<<"$OUT")"' "$OUT"

# ④ no-tests — 구현만 바꿈
case_branch impl-only
printf 'export const add = (left, right) => left + right\nexport const mul = (left, right) => left * right\n' > lib/math.mjs
OUT="$(red --spec "$NODE_SPEC" --json)"; CODE=$?
check "no-tests — 바뀐 테스트 없음 · exit 0" '[ "$(json_field result <<<"$OUT")" = no-tests ] && grep -q "구현 1개" <<<"$OUT" && [ $CODE = 0 ]' "$OUT · exit $CODE"

# ⑤ test-only — 테스트만 바꿈(돌리지 않는다)
case_branch tests-only
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { mul } from '../lib/math.mjs'\ntest('mul 2', () => assert.equal(mul(2, 2), 4))\n" > test/mul.test.mjs
OUT="$(red --spec "$NODE_SPEC" --json)"; CODE=$?
check "test-only — 테스트만 바뀜 · 건너뜀 · exit 0" '[ "$(json_field result <<<"$OUT")" = test-only ] && [ $CODE = 0 ]' "$OUT · exit $CODE"

# ⑥ unsupported — 바뀐 구현 파일에 doctest
case_branch doctest
printf 'def twice(value):\n    """\n    >>> twice(2)\n    4\n    """\n    return value * 2\n' > lib/twice.py
printf "import { test } from 'node:test'\ntest('x', () => {})\n" > test/x.test.mjs
OUT="$(red --spec "$NODE_SPEC" --json)"; CODE=$?
check "unsupported — doctest 가 든 구현 파일 · exit 1" '[ "$(json_field result <<<"$OUT")" = unsupported ] && grep -q "lib/twice.py" <<<"$OUT" && [ $CODE = 1 ]' "$OUT · exit $CODE"

# ⑦ error — 실행 명령이 없다(127) · 설정이 틀렸다 · 기준 ref 가 없다
case_branch broken-cmd
printf 'export const add = (left, right) => left + right\nexport const mul = (left, right) => left * right\n' > lib/math.mjs
printf "import { test } from 'node:test'\ntest('x', () => {})\n" > test/x.test.mjs
OUT="$(red --spec '{"tests":["test/*.test.mjs"],"run":"no-such-runner-xyz {files}"}' --json)"; CODE=$?
check "error — 명령을 실행하지 못함(127) · exit 1 · 통과로 치지 않음" '[ "$(json_field result <<<"$OUT")" = error ] && grep -q "exit 127" <<<"$OUT" && [ $CODE = 1 ]' "$OUT · exit $CODE"
OUT="$(red --spec '{"tests":["test/*.test.mjs"],"run":"node --test"}' --json)"; CODE=$?
check "error — run 에 {files} 자리가 없으면 설정 오류" '[ "$(json_field result <<<"$OUT")" = error ] && grep -q "{files}" <<<"$OUT" && [ $CODE = 1 ]' "$OUT"
OUT="$(node "$SRC/scripts/red-check.mjs" --dir "$TMP/repo" --repo fake --base origin/nope --spec "$NODE_SPEC" --json 2>/dev/null)"; CODE=$?
check "error — 기준 ref 가 없다" '[ "$(json_field result <<<"$OUT")" = error ] && grep -q "merge-base" <<<"$OUT"' "$OUT"

# ⑧ 건너뜀 — 팩에 칸이 없는 레포(--spec null = 칸 없음)
OUT="$(red --spec null)"; CODE=$?
check "건너뜀 — redCheck 칸 없음 · 표 한 줄 · exit 0" 'grep -qE "^\| \`red-check\` \| ⏭ 건너뜀\(규칙\) — 팩 fake 에 redCheck 칸 없음 \| [0-9]+s \|$" <<<"$OUT" && [ $CODE = 0 ]' "$OUT"

echo "▶ 여러 종류(node · python) — 배열 칸 · 첫 맞는 항목의 run"
case_branch two-kinds
printf 'export const add = (left, right) => left + right\nexport const mul = (left, right) => left * right\n' > lib/math.mjs
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../lib/math.mjs'\ntest('add', () => assert.equal(add(1, 2), 3))\n" > test/add.test.mjs
printf 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n' > test/test_py.py
OUT="$(red --spec '[{"tests":["test/*.test.mjs"],"run":"node --test {files}"},{"tests":["test/test_*.py"],"run":"python3 -m unittest {files}"}]' --json)"
check "배열 칸 — node 는 base 실패 · python 은 base 통과 → non-discriminating(python 파일)" '[ "$(json_field result <<<"$OUT")" = non-discriminating ] && grep -q "test/test_py.py" <<<"$OUT" && grep -q "base 에서 실패(assertion): test/add.test.mjs" "$TMP/stderr"' "$OUT · $(cat "$TMP/stderr")"

echo "▶ 정리 · 의존성 · 래퍼"
check "임시 워크트리가 남지 않는다(git worktree list 1개 · 폴더 비었음)" '[ "$(git worktree list | wc -l | tr -d " ")" = 1 ] && [ -z "$(ls -A "$TMP/worktrees/.red-check" 2>/dev/null)" ]' "$(git worktree list; ls -A "$TMP/worktrees/.red-check" 2>/dev/null)"
# node_modules 는 지금 트리 것을 링크한다 — base 에 없는 의존성이어도 테스트가 불러온다
case_branch with-deps
mkdir -p node_modules/fake-dep && printf 'module.exports = { two: 2 }\n' > node_modules/fake-dep/index.js
printf 'export const add = (left, right) => left + right\nexport const mul = (left, right) => left * right\n' > lib/math.mjs
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport dep from 'fake-dep'\nimport { add } from '../lib/math.mjs'\ntest('add', () => assert.equal(add(1, dep.two), 3))\n" > test/add.test.mjs
OUT="$(red --spec "$NODE_SPEC" --json)"
check "node_modules 링크 — 의존성은 불러오고 단정에서 실패(ok assertion)" 'grep -q "ok (assertion)" <<<"$OUT"' "$OUT · $(cat "$TMP/stderr")"
OUT="$(ATHENA_HEAVY_HELD=1 bash "$SRC/scripts/verify/red-check.sh" --dir "$TMP/repo" --repo fake --base origin/main --spec "$NODE_SPEC" 2>/dev/null)"; CODE=$?
check "래퍼(red-check.sh) — 표 한 줄 · exit 0" 'grep -qE "^\| \`red-check\` \| ✅ ok \(assertion\)" <<<"$OUT" && [ $CODE = 0 ]' "$OUT · exit $CODE"
check "실패 · 정리 뒤에도 워크트리 1개" '[ "$(git worktree list | wc -l | tr -d " ")" = 1 ]' "$(git worktree list)"

echo "▶ 계획서 줄 · PR 본문 (scripts/lib/red-check.mjs)"
LIB="$SRC/scripts/lib/red-check.mjs"
helper() { node --input-type=module -e "const lib = await import(process.argv[1]); $1" "$LIB" "${@:2}"; }
PLAN_A=$'# t\n\n## Checkpoint\n- Status: in_progress\n\n### Validation\n- (아직 없음)\n\n### Decisions\n- x\n'
NEW="$(helper 'process.stdout.write(lib.withPlanLine(process.argv[2], { repo: "r", branch: "b", sha: "abcdef1234", text: "✅ ok (assertion) — 1개", stamp: "2026-10-29 10:00" }))' "$PLAN_A")"
check "계획서 — 자리 표시 줄을 red-check 줄로 바꾼다" 'grep -qxF -- "- red-check: r · 🌿 b @abcdef1 — ✅ ok (assertion) — 1개 · 2026-10-29 10:00" <<<"$NEW" && ! grep -q "아직 없음" <<<"$NEW" && grep -q "### Decisions" <<<"$NEW"' "$NEW"
NEW2="$(helper 'process.stdout.write(lib.withPlanLine(process.argv[2], { repo: "r", branch: "b", sha: "1111111", text: "⚠️ non-discriminating — x", stamp: "s" }))' "$NEW")"
check "계획서 — 같은 레포 · 브랜치 줄은 바꿔 쓴다(한 줄)" '[ "$(grep -c "^- red-check: r · 🌿 b @" <<<"$NEW2")" = 1 ] && grep -q "@1111111 — ⚠️ non-discriminating" <<<"$NEW2"' "$NEW2"
NEW3="$(helper 'process.stdout.write(lib.withPlanLine(process.argv[2], { repo: "r2", branch: "b", sha: "2222222", text: "ℹ️ no-tests", stamp: "s" }))' "$NEW2")"
check "계획서 — 다른 레포는 Validation 절 끝에 한 줄 더(다음 절 앞)" '[ "$(grep -c "^- red-check:" <<<"$NEW3")" = 2 ] && [ "$(grep -n "^- red-check: r2" <<<"$NEW3" | cut -d: -f1)" -lt "$(grep -n "^### Decisions" <<<"$NEW3" | cut -d: -f1)" ]' "$NEW3"
PLAN_B=$'# t\n\n## Checkpoint\n- Status: x\n- Work ref: y\n\n## Commits\n- `abc` c\n'
NEW4="$(helper 'process.stdout.write(lib.withPlanLine(process.argv[2], { repo: "r", branch: "b", sha: "3333333", text: "✅ ok", stamp: "s" }))' "$PLAN_B")"
check "계획서 — Validation 절이 없으면 Checkpoint 끝(## Commits 앞)에 만든다" '[ "$(grep -n "^### Validation" <<<"$NEW4" | cut -d: -f1)" -lt "$(grep -n "^## Commits" <<<"$NEW4" | cut -d: -f1)" ] && grep -q "^- red-check: r · 🌿 b @3333333" <<<"$NEW4"' "$NEW4"
BODY=$'## 작업 내용\n- a\n\n## 검증\n| x |\n\n## 확인 필요\n- 없음\n\n---\n🤖\n'
NOTE="$(helper 'process.stdout.write(lib.bodyNote("⚠️ non-discriminating — 구현을 base @abc 로 되돌려도 통과: t.test.js"))')"
OUTB="$(helper 'process.stdout.write(lib.withBodyNote(process.argv[2], process.argv[3]))' "$BODY" "$NOTE")"
check "PR 본문 — \"- 없음\" 을 red-check 경고 줄로 바꾼다" 'grep -q "^- red-check non-discriminating — 구현을" <<<"$OUTB" && ! grep -qx -- "- 없음" <<<"$OUTB" && grep -q "^---$" <<<"$OUTB"' "$OUTB"
OUTC="$(helper 'process.stdout.write(lib.withBodyNote(process.argv[2], process.argv[3]))' "$OUTB" "$NOTE")"
check "PR 본문 — 이미 red-check 줄이 있으면 그대로(두 번 넣지 않음)" '[ "$OUTC" = "$OUTB" ]'
BODY2=$'## 확인 필요\n- 리뷰 승인 전\n'
OUTD="$(helper 'process.stdout.write(lib.withBodyNote(process.argv[2], process.argv[3]))' "$BODY2" "$NOTE")"
check "PR 본문 — 다른 항목이 있으면 맨 위에 더한다" '[ "$(sed -n 2p <<<"$OUTD" | cut -c1-12)" = "- red-check " ] && grep -q "리뷰 승인 전" <<<"$OUTD"' "$OUTD"
check "결과 칸 — 로컬 절대 경로가 없다(PR 본문 검사에 걸리지 않게)" '! grep -qE "/Users/|/private/|\.worktrees/" <<<"$NEW3$OUTB"'

echo "▶ ship.sh — 미리보기 · --yes · --auto-push 에서 돌고 계획서 · 본문에 남긴다(가짜 코어 · 가짜 gh)"
CORE="$TMP/core"; mkdir -p "$CORE/plans/task" "$CORE/repos" "$TMP/bin"; cp -R "$SRC/scripts" "$CORE/scripts"
ln -s "$TMP/repo" "$CORE/repos/fake"
printf '#!/bin/sh\nexit 0\n' > "$CORE/scripts/verify/reuse.sh"
cat > "$TMP/bin/gh" <<'SH'
#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "pr list") [ -z "${FAKE_OPEN:-}" ] || echo "$FAKE_OPEN" ;;
  "pr create") while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_BODY"; shift; done; echo "https://github.com/acme/fake/pull/9" ;;
  "pr edit") while [ $# -gt 0 ]; do [ "$1" = --body-file ] && cp "$2" "$FAKE_BODY"; shift; done ;;
  *) exit 1 ;;
esac
SH
chmod +x "$TMP/bin/gh"
set_config() {   # <redCheck JSON 또는 빈 값>
  printf '{ "github": { "org": "acme" }, "repos": [{ "name": "fake", "agents": ["fake-fe"], "prBase": "main", "autoMerge": true%s }] }\n' "${1:+, \"redCheck\": $1}" > "$CORE/athena.config.json"
}
git checkout -q -f main && git clean -qfdx
git worktree add -q -b feat/ship "$TMP/wt-ship" origin/main 2>/dev/null
WTS="$(cd "$TMP/wt-ship" && pwd -P)"
printf '// 주석만\nexport const add = (left, right) => left - right\nexport const mul = (left, right) => left * right\n' > "$WTS/lib/math.mjs"
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { mul } from '../lib/math.mjs'\ntest('mul one', () => assert.equal(mul(1, 3), 3))\n" > "$WTS/test/mul.test.mjs"
git -C "$WTS" add -A && git -C "$WTS" commit -qm weak
SS="$(git -C "$WTS" rev-parse HEAD)"
SPLAN="plans/task/20261029-fake-fe-ship.md"
ship_plan() {   # <추가 Checkpoint 줄>
  printf '# 시험 ship\n\n## Checkpoint\n- Status: in_progress\n- Agent: fake-fe\n- Work ref: %s · 🌿 feat/ship · pane p9 (fake-fe)\n%s\n\n### Validation\n- (아직 없음)\n\n## 지시\n- 시험\n\n## Commits\n- `%s` feat/ship · 시험 · ✅ 검증 · push 안 함\n' "$WTS" "${1:-}" "${SS:0:7}" > "$CORE/$SPLAN"
}
SLOG="$TMP/ship.log"; SBODY="$TMP/sent-body.md"; QUEUE2="$TMP/queue"; mkdir -p "$QUEUE2/.watcher.lock"; echo $$ > "$QUEUE2/.watcher.lock/pid"
sship() { (cd "$CORE" && env PATH="$TMP/bin:$PATH" FAKE_LOG="$SLOG" FAKE_BODY="$SBODY" ATHENA_HEAVY_HELD=1 ATHENA_PR_AUTO_QUEUE="$QUEUE2" ATHENA_DATA_DIR="$TMP/data" "${SENV[@]}" bash scripts/ship.sh --plan "$SPLAN" --dir "$WTS" "$@" 2>&1); }
SENV=(FAKE_X=1)
set_config "$NODE_SPEC"; ship_plan; : > "$SLOG"
OUT="$(sship)"; CODE=$?
DRAFTF="$(git -C "$WTS" rev-parse --absolute-git-dir)/hermes-pr-body.md"
check "미리보기 — red-check 줄 · 본문 초안 확인 필요에 적었다는 안내 · 막지 않음(exit 0)" '[ $CODE = 0 ] && grep -q "^red-check ⚠️ non-discriminating — 구현을 base @" <<<"$OUT" && grep -q "본문 초안 \"확인 필요\" 에 적었다" <<<"$OUT"' "$OUT"
check "미리보기 — 계획서 Validation 자리 표시 줄이 red-check 줄로" 'grep -q "^- red-check: fake · 🌿 feat/ship @${SS:0:7} — ⚠️ non-discriminating" "$CORE/$SPLAN" && ! grep -q "아직 없음" "$CORE/$SPLAN"' "$(cat "$CORE/$SPLAN")"
check "미리보기 — 본문 초안: 검증 절에 red-check 줄 · 확인 필요에 경고 줄" 'awk "/^## 검증/,/^## 확인 필요/" "$DRAFTF" | grep -q "red-check: fake" && awk "/^## 확인 필요/,0" "$DRAFTF" | grep -q "^- red-check non-discriminating"' "$(cat "$DRAFTF")"
printf '## 작업 내용\n시험\n\n## 변경 사항\n- a\n\n## 검증\n- 통과\n\n## 확인 필요\n- 없음\n' > "$TMP/agent-body.md"; cp "$TMP/agent-body.md" "$TMP/agent-body.orig"
: > "$SLOG"
OUT="$(sship --base main --title 'test(fake): 시험' --body-file "$TMP/agent-body.md" --no-review-ok --yes)"; CODE=$?
check "--yes — 에이전트 본문에도 경고 줄을 넣어 보낸다(그 파일은 그대로) · 테스트를 다시 돌리지 않음(같은 HEAD)" '[ $CODE = 0 ] && grep -q "^- red-check non-discriminating" "$SBODY" && cmp -s "$TMP/agent-body.md" "$TMP/agent-body.orig" && ! grep -q "base 에서 돌려 본다" <<<"$OUT"' "$OUT
$(cat "$SBODY" 2>/dev/null)"
# --auto-push — 자동 리뷰가 수정을 보낸 PR 에 고친 커밋(진짜 검사하는 테스트)을 올리면 다시 돌아 계획서 줄이 ok 로
printf 'export const add = (left, right) => left + right\nexport const mul = (left, right) => left * right\n' > "$WTS/lib/math.mjs"
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../lib/math.mjs'\ntest('add', () => assert.equal(add(1, 2), 3))\n" > "$WTS/test/add.test.mjs"
git -C "$WTS" checkout -q origin/main -- test/mul.test.mjs   # 약한 테스트는 되돌린다 — PR 에 남으면 계속 non-discriminating 이 맞다
git -C "$WTS" add -A && git -C "$WTS" commit -qm fix
SS="$(git -C "$WTS" rev-parse HEAD)"
ship_plan "- Auto review: fake#9 @0000000 · 수정 필요 · 라운드 1/3 · s
- PR: https://github.com/acme/fake/pull/9 (feat/ship → main, draft · s)"
grep -q "^- red-check:" "$CORE/$SPLAN" || printf '%s\n' "$(sed 's/^- (아직 없음)$/- red-check: fake · 🌿 feat\/ship @0000000 — ⚠️ 옛 결과 · s/' "$CORE/$SPLAN")" > "$CORE/$SPLAN"
SENV=(FAKE_OPEN=9); : > "$SLOG"
OUT="$(sship --auto-push)"; CODE=$?
check "--auto-push — 고친 커밋으로 다시 돌아 ok · 계획서 줄을 바꿔 쓴다(한 줄)" '[ $CODE = 0 ] && grep -q "^red-check ✅ ok (assertion)" <<<"$OUT" && [ "$(grep -c "^- red-check: fake · 🌿 feat/ship" "$CORE/$SPLAN")" = 1 ] && grep -q "@${SS:0:7} — ✅ ok (assertion)" "$CORE/$SPLAN"' "$OUT
$(grep red-check "$CORE/$SPLAN")"
# 칸 없는 레포 — 줄을 서지 않고 건너뜀 한 줄만 · 계획서에 쓰지 않는다
set_config ""; ship_plan; SENV=(FAKE_X=1); : > "$SLOG"
OUT="$(sship)"; CODE=$?
check "칸 없는 레포 — 미리보기에 건너뜀 한 줄 · 계획서 · 본문 초안에 red-check 없음" '[ $CODE = 0 ] && grep -q "^red-check ⏭ 건너뜀(규칙) — 팩 fake 에 redCheck 칸 없음" <<<"$OUT" && ! grep -qE "^- red-check[: ]" "$CORE/$SPLAN" "$DRAFTF"' "$OUT"
git worktree remove --force "$WTS" 2>/dev/null

echo
[ $FAIL = 0 ] && echo "✅ red-check 시험 통과" || echo "❌ red-check 시험 실패"
exit $FAIL
