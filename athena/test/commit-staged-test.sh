#!/usr/bin/env bash
# commit.sh 의 미리 스테이징된 변경 처리 시험 — git mv 로 이름을 바꾼 것(옛 이름 · 새 이름이 바로 스테이징됨)은 두 이름을 지정하면 받고,
# 지정하지 않은 스테이징은 여전히 거부하는지. 임시 레포 · 임시 코어 사본 · 검증 생략(--no-verify) · 몇 초
#
# 사용: test/commit-staged-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
ATH="$TMP/ath"; mkdir -p "$ATH/plans/task" "$ATH/repos"
cp -R "$SRC/scripts" "$ATH/"
mkdir -p "$ATH/packs/t"
printf '{"pack":"packs/t","reposRoot":".."}\n' > "$ATH/athena.config.json"
printf '{"formatVersion":1,"id":"t","name":"t","repos":[{"name":"main","branch":"main","prBase":"main","kind":"single"}]}\n' > "$ATH/packs/t/pack.json"
printf '# p\n' > "$ATH/plans/task/p.md"
git init -q "$TMP/main"; git -C "$TMP/main" config user.email t@t; git -C "$TMP/main" config user.name t
printf 'a\n' > "$TMP/main/a.txt"; git -C "$TMP/main" add a.txt; git -C "$TMP/main" commit -qm init; git -C "$TMP/main" branch -M main
git -C "$TMP/main" worktree add -q "$TMP/wt" -b feat/x
ln -s "$TMP/main" "$ATH/repos/main"
FAIL=0
ok() { echo "  ✔ $1"; }
bad() { echo "  ✖ $1"; FAIL=1; }
commit() { "$ATH/scripts/commit.sh" --plan plans/task/p.md --dir "$TMP/wt" --no-verify -m "$1" -- "${@:2}" 2>&1; }

git -C "$TMP/wt" mv a.txt b.txt
out="$(commit '이름 바꾸기' b.txt)"; rc=$?
[ $rc -ne 0 ] && ok "git mv 후 새 이름만 지정하면 거부(옛 이름이 빠진다)" || bad "새 이름만 지정했는데 커밋됨: $out"
# 첫 시나리오의 스테이징을 지우고 처음 상태(a.txt 추적)로 되돌린 뒤 실제로 git mv — 실패를 숨기지 않는다
git -C "$TMP/wt" reset -q --hard; rm -f "$TMP/wt/b.txt"
git -C "$TMP/wt" mv a.txt b.txt || bad "git mv 준비 실패"
[ "$(git -C "$TMP/wt" diff --cached --name-status -M | cut -c1)" = R ] || bad "시험 준비 — 이름 바꾸기가 스테이징돼 있지 않다"
out="$(commit '이름 바꾸기' a.txt b.txt)"; rc=$?
[ $rc -eq 0 ] && [ "$(git -C "$TMP/wt" log -1 --format=%s)" = '이름 바꾸기' ] && ok "git mv 후 옛 이름 · 새 이름을 지정하면 스테이징을 풀지 않아도 커밋" || bad "이름 바꾸기 커밋 실패(rc=$rc): $out"

printf 'x\n' > "$TMP/wt/other.txt"; git -C "$TMP/wt" add other.txt
printf 'y\n' > "$TMP/wt/b.txt"
out="$(commit '남의 스테이징' b.txt)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q 'other.txt' && ok "지정하지 않은 스테이징(other.txt)은 여전히 거부 · 이름을 알려 줌" || bad "남의 스테이징이 섞여 커밋됨(rc=$rc): $out"
[ "$(git -C "$TMP/wt" diff --cached --name-only)" = other.txt ] && ok "거부해도 남의 스테이징은 그대로" || bad "남의 스테이징이 바뀜"

[ $FAIL -eq 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
