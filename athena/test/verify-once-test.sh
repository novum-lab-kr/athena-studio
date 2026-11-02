#!/usr/bin/env bash
# 전체 검증을 작업 끝에 한 번만 도는지 시험 — 진짜 commit.sh · reuse.sh · _lib.sh · ship.sh · pr-auto.mjs 로 작업 1건을 끝까지 돌리고 검증 스크립트가 돈 횟수를 센다.
# 임시 코어 사본 · 임시 레포 · 로컬 bare origin · 임시 통과 기록(XDG_CACHE_HOME) · 몇 초. 가짜는 화면과 검증 단계의 내용뿐이다
#
# 사용: test/verify-once-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
ATH="$TMP/ath"; mkdir -p "$ATH/plans/task" "$ATH/repos"
cp -R "$SRC/scripts" "$ATH/"
printf '#!/bin/sh\nexit 0\n' > "$ATH/scripts/screen"; chmod +x "$ATH/scripts/screen"
export XDG_CACHE_HOME="$TMP/cache" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue"
mkdir -p "$TMP/queue/.watcher.lock"; echo $$ > "$TMP/queue/.watcher.lock/pid"   # 처리기가 돌고 있는 것처럼
unset ATHENA_VERIFY_DIR ATHENA_VERIFY_STRICT ATHENA_VERIFY_ALLOW_SKIP ATHENA_VERIFY_FULL ATHENA_PLAN ATHENA_AGENT

# 검증 스크립트 — 진짜 _lib.sh 로 기록을 남기고, 돌 때마다 횟수 파일에 "인자 · 엄격" 한 줄. FAIL 파일이 있으면 실패
COUNT="$TMP/runs"; : > "$COUNT"
cat > "$ATH/scripts/verify/web.sh" <<SCRIPT
#!/usr/bin/env bash
source "$ATH/scripts/verify/_lib.sh"
REPO_DIR="\$(resolve_repo_dir "$ATH/repos/web")"
echo "args=[\$*] strict=\${ATHENA_VERIFY_STRICT:-0}" >> "$COUNT"
cd "\$REPO_DIR"
run_step "시험" sh -c '[ ! -f FAIL ]'
print_summary web "\$REPO_DIR"
SCRIPT
chmod +x "$ATH/scripts/verify/web.sh"

printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoPr": false, "autoMergeConfirm": false } ] }\n' > "$ATH/athena.config.json"
git init -q --bare "$TMP/origin.git"
git init -q "$TMP/main"
G() { git -C "$TMP/main" -c user.name=t -c user.email=t@t "$@"; }
G checkout -q -b main; printf 'FAIL\n' > "$TMP/main/.gitignore"; mkdir -p "$TMP/main/apps/one"; echo base > "$TMP/main/apps/one/a.txt"; echo base > "$TMP/main/f.txt"
G add .; G commit -qm base; G remote add origin "$TMP/origin.git"; G push -q origin main 2>/dev/null
G worktree add -q "$TMP/wt" -b feat/x
git -C "$TMP/wt" config user.name t; git -C "$TMP/wt" config user.email t@t
ln -s "$TMP/main" "$ATH/repos/web"
printf '# 시험\n\n## Checkpoint\n- Status: in_progress\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p1 (web-fe)\n\n## Commits\n' "$TMP/wt" > "$ATH/plans/task/p.md"

FAIL_COUNT=0
ok() { echo "  ✔ $1"; }
bad() { echo "  ✖ $1"; FAIL_COUNT=1; }
runs() { wc -l < "$COUNT" | tr -d ' '; }
expect_runs() { [ "$(runs)" = "$1" ] && ok "$2 — 전체 검증 누적 $1번" || { bad "$2 — 누적 기대 $1 · 실제 $(runs)"; sed 's/^/      /' "$COUNT"; }; }
commit() { "$ATH/scripts/commit.sh" --plan plans/task/p.md --dir "$TMP/wt" -m "$1" -- "${@:2}" 2>&1; }
# 리뷰어 · 머지가 부르는 모양 그대로
reviewer() { ATHENA_VERIFY_DIR="$TMP/wt" "$ATH/scripts/verify/reuse.sh" web "$@" 2>&1; }
merge_check() { ATHENA_VERIFY_DIR="$TMP/wt" ATHENA_VERIFY_STRICT=1 ATHENA_VERIFY_ALLOW_SKIP='' "$ATH/scripts/verify/reuse.sh" web "$@" 2>&1; }

echo "작업 1건 — 고치기 → 커밋 → 리뷰 → 머지"
echo one > "$TMP/wt/f.txt"; echo two >> "$TMP/wt/f.txt"
expect_runs 0 "작업 중 — 고치기만 하면 전체 검증은 돌지 않는다"
out="$(commit '기능' f.txt)"; rc=$?
[ $rc = 0 ] || bad "커밋 실패(rc=$rc): $out"
expect_runs 1 "commit.sh — 엄격 검증이 그 한 번"
grep -q '엄격 검증 통과 — 전체' "$ATH/plans/task/p.md" && ok "계획서 Commits 에 엄격 검증 기록" || bad "Commits 기록 없음"
out="$(reviewer)"; rc=$?
[ $rc = 0 ] && printf '%s' "$out" | grep -q '♻️ 재사용' && ok "reviewer(reuse.sh) — 재사용 표를 찍고 통과" || bad "reviewer 재사용 아님(rc=$rc): $out"
expect_runs 1 "reviewer 뒤"
out="$(merge_check)"; rc=$?
[ $rc = 0 ] && printf '%s' "$out" | grep -q '♻️ 재사용' && ok "머지 조건(엄격 · 건너뜀 허용 없음) — 재사용으로 통과" || bad "머지 조건 재사용 아님(rc=$rc): $out"
expect_runs 1 "머지 조건 뒤"
out="$("$ATH/scripts/ship.sh" --plan plans/task/p.md --dir "$TMP/wt" --direct-merge 2>&1)"; rc=$?
tip="$(git -C "$TMP/origin.git" show refs/heads/main:f.txt 2>/dev/null | head -1)"
[ $rc = 0 ] && [ "$tip" = one ] && ok "ship.sh --direct-merge — 머지됨(진짜 pr-auto · reuse)" || bad "바로 머지 안 됨(rc=$rc · main f.txt=$tip): $out"
expect_runs 1 "바로 머지 뒤 — 작업 1건 전체 검증 한 번"
grep -qv 'strict=1' "$COUNT" && bad "엄격이 아닌 검증이 돌았다: $(cat "$COUNT")" || ok "돈 검증은 엄격 모드뿐"

echo; echo "다시 도는 경우 — 실패해 고쳤을 때 · 트리가 달라졌을 때만"
: > "$COUNT"
touch "$TMP/wt/FAIL"; echo three > "$TMP/wt/f.txt"
out="$(commit '실패' f.txt)"; rc=$?
[ $rc != 0 ] && ok "검증 실패 → 커밋 거부" || bad "실패했는데 커밋됨: $out"
expect_runs 1 "실패 한 번"
rm -f "$TMP/wt/FAIL"; echo four > "$TMP/wt/f.txt"
out="$(commit '고침' f.txt)"; rc=$?
[ $rc = 0 ] || bad "고친 뒤 커밋 실패: $out"
expect_runs 2 "고친 뒤 커밋 — 실패한 경우에만 한 번 더"
merge_check >/dev/null; expect_runs 2 "고친 트리의 머지 조건은 재사용"
echo five > "$TMP/wt/g.txt"
out="$(merge_check)"; rc=$?
expect_runs 3 "미추적 파일 하나만 달라져도 재사용하지 않고 다시 돈다"
rm -f "$TMP/wt/g.txt"

echo; echo "머지 안전 조건은 그대로"
: > "$COUNT"; echo dirty >> "$TMP/wt/f.txt"
BASE_BEFORE="$(git -C "$TMP/origin.git" rev-parse refs/heads/main)"
out="$("$ATH/scripts/ship.sh" --plan plans/task/p.md --dir "$TMP/wt" --direct-merge 2>&1)"; rc=$?
[ "$(git -C "$TMP/origin.git" rev-parse refs/heads/main)" = "$BASE_BEFORE" ] && [ $rc != 0 ] && ok "커밋 안 한 변경이 있으면 머지 안 함" || bad "커밋 안 한 변경인데 머지됨(rc=$rc): $out"
git -C "$TMP/wt" checkout -q -- f.txt
# 통과 기록이 없으면(지웠거나 다른 트리) 재사용 없이 진짜로 돌고, 실패하면 머지 안 함
rm -rf "$XDG_CACHE_HOME/athena/verify-pass"; touch "$TMP/wt/FAIL"
out="$("$ATH/scripts/ship.sh" --plan plans/task/p.md --dir "$TMP/wt" --direct-merge 2>&1)"; rc=$?
[ "$(git -C "$TMP/origin.git" rev-parse refs/heads/main)" = "$BASE_BEFORE" ] && [ "$(runs)" -ge 1 ] && ok "통과 기록 없으면 머지 전에 진짜로 돌고, 실패하면 머지 안 함" || bad "기록 없이 머지됨(rc=$rc · 횟수 $(runs)): $out"
rm -f "$TMP/wt/FAIL"

echo; echo "기준 브랜치를 합친 merge 커밋 — 커밋 뒤 merge-base 가 옮겨 가도 다시 돌지 않는다"
rm -f "$TMP/wt/FAIL"
# 앞 절의 squash 머지와 겹치지 않게 지금 base 에서 다시 시작해 작업 커밋 하나를 둔다
git -C "$TMP/wt" reset -q --hard origin/main; echo work > "$TMP/wt/work.txt"
out="$(commit '작업' work.txt)" || bad "작업 커밋 실패: $out"
: > "$COUNT"
git -C "$TMP/main" -c user.name=t -c user.email=t@t worktree add -q "$TMP/base" -B base-work origin/main
echo moved > "$TMP/base/base.txt"; git -C "$TMP/base" -c user.name=t -c user.email=t@t add base.txt; git -C "$TMP/base" -c user.name=t -c user.email=t@t commit -qm 'base 앞으로'
git -C "$TMP/base" push -q origin HEAD:main 2>/dev/null; G fetch -q origin
OLD_BASE="$(git -C "$TMP/wt" merge-base HEAD origin/main)"
git -C "$TMP/wt" merge -q --no-ff --no-commit origin/main 2>/dev/null
out="$(commit 'base 합치기')"; rc=$?
[ $rc = 0 ] && [ -n "$(git -C "$TMP/wt" rev-parse -q --verify HEAD^2)" ] && ok "merge 커밋 성공" || bad "merge 커밋 실패(rc=$rc): $out"
[ "$(git -C "$TMP/wt" merge-base HEAD origin/main)" != "$OLD_BASE" ] && ok "merge-base 가 옮겨 갔다(시험 조건)" || bad "merge-base 가 그대로 — 시험이 조건을 못 만듦"
expect_runs 1 "merge 커밋의 엄격 검증"
out="$(merge_check)"; rc=$?
[ $rc = 0 ] && printf '%s' "$out" | grep -q '♻️ 재사용' && ok "merge 커밋 뒤 머지 조건 재사용" || bad "merge 커밋 뒤 재사용 아님(rc=$rc)"
expect_runs 1 "merge 커밋 뒤 머지 조건"
[ -z "$(git -C "$TMP/wt" status --porcelain)" ] && ok "임시 커밋이 트리 · 브랜치에 남지 않는다" || bad "트리가 더러워짐"

echo; echo "재사용이 안 되는 경계(안전 쪽으로 다시 돈다)"
rm -rf "$XDG_CACHE_HOME/athena/verify-pass"; : > "$COUNT"
merge_check >/dev/null; expect_runs 1 "기록을 지운 뒤 첫 검증"
merge_check >/dev/null; expect_runs 1 "같은 환경이면 재사용"
FAKE_NODE="$TMP/fake-node"; mkdir -p "$FAKE_NODE"; REAL_NODE="$(command -v node)"
printf '#!/bin/sh\n[ "$1" = -v ] && { echo v0.0.0; exit 0; }\nexec "%s" "$@"\n' "$REAL_NODE" > "$FAKE_NODE/node"; chmod +x "$FAKE_NODE/node"
PATH="$FAKE_NODE:$PATH" merge_check >/dev/null; expect_runs 2 "node 버전이 다른 프로세스면 다시 돈다"
# 모노레포 — commit.sh 는 앱 인자로, 머지 조건은 인자 없이 부른다(열쇠가 다르다)
: > "$COUNT"
ATHENA_VERIFY_DIR="$TMP/wt" ATHENA_VERIFY_STRICT=1 "$ATH/scripts/verify/reuse.sh" web one >/dev/null 2>&1
expect_runs 1 "앱 인자 검증(모노레포 커밋)"
ATHENA_VERIFY_DIR="$TMP/wt" "$ATH/scripts/verify/reuse.sh" web one >/dev/null 2>&1
expect_runs 1 "같은 앱 인자 리뷰어는 재사용"
find "$XDG_CACHE_HOME/athena/verify-pass" -type f ! -exec grep -q "^args	one$" {} \; -delete
merge_check >/dev/null
expect_runs 2 "인자 없는 머지 조건은 앱 인자 기록을 재사용하지 않고 전체를 돈다(모노레포는 머지 때 한 번 더)"

[ $FAIL_COUNT -eq 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL_COUNT
