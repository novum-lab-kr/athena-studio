#!/usr/bin/env bash
# 재사용 없는 전체 검증 시험(2026-11-08 · 계획서 "PR 자동 리뷰 · 검증 빠른 길" 6 · 7) — scripts/full-verify.mjs 를 임시 코어 사본 · 임시 git 레포 · 가짜 검증 스크립트로 돌린다.
# 보는 것: 그림자 통과 · 실패 → high 이슈(비밀값 가림 · 같은 커밋은 한 번) · 엄격 건너뜀만이면 실행 못 함(이슈 없음) · 끔(shadowVerify: false · 기간 밖) ·
#          재사용 없는 환경(FULL · NO_REUSE_CORE · STRICT · 계획서 걷음) · 하루 한 번(오늘 돈 레포 건너뜀 · --force · 실패 이슈 · dailyVerify: false · 넘기기 레포 빼기) · pr-auto 연결
# 몇 초 · 네트워크 없음
#
# 사용: test/full-verify-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
ATH="$TMP/ath"; mkdir -p "$ATH"
cp -R "$SRC/scripts" "$ATH/"
export XDG_CACHE_HOME="$TMP/cache" ATHENA_DATA_DIR="$TMP/data" ATHENA_SKIP_WT_SETUP=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export ATHENA_PLAN=plans/task/남의-계획서.md   # 걷어 내는지 본다
unset ATHENA_VERIFY_DIR ATHENA_VERIFY_STRICT ATHENA_VERIFY_FULL ATHENA_AGENT
export ATHENA_VERIFY_ALLOW_SKIP=typecheck

FAILED=0
ok() { echo "  ✔ $1"; }
bad() { echo "  ✖ $1"; FAILED=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

config() { echo "$1" > "$ATH/athena.config.json"; }
config '{"repos":[{"name":"web","autoMerge":true,"autoMergeConfirm":false,"prBase":"main"},{"name":"api","autoMerge":true,"autoPr":false,"actionsHandoff":true,"autoMergeConfirm":false,"prBase":"main"}]}'

# 원격 · repos/web — FAIL 파일이 있으면 실패, SKIP 파일이면 엄격 건너뜀만
git init -q --bare "$TMP/remote.git"
git clone -q "$TMP/remote.git" "$TMP/seed" 2>/dev/null
( cd "$TMP/seed" && git checkout -q -b main && echo one > a.txt && git add a.txt && git commit -qm one && git push -q origin main )
mkdir -p "$ATH/repos"; git clone -q "$TMP/remote.git" "$ATH/repos/web"
ENVLOG="$TMP/env.log"
cat > "$ATH/scripts/verify/web.sh" <<SCRIPT
#!/usr/bin/env bash
echo "dir=\$ATHENA_VERIFY_DIR full=\${ATHENA_VERIFY_FULL:-} reuse=\${ATHENA_VERIFY_NO_REUSE_CORE:-} strict=\${ATHENA_VERIFY_STRICT:-} allow=\${ATHENA_VERIFY_ALLOW_SKIP:-} plan=\${ATHENA_PLAN:-}" >> "$ENVLOG"
if [ -f "\$ATHENA_VERIFY_DIR/FAIL" ]; then echo "boom ghp_abcdefghijklmnopqrstuvwxyz0123456789" >&2; echo "| test | ❌ 실패 (exit 1) |"; exit 1; fi
if [ -f "\$ATHENA_VERIFY_DIR/SKIP" ]; then echo "| test | ❌ 건너뜀(엄격 모드) — node-pty 없음 |"; exit 1; fi
echo "| test | ✅ 통과 |"
SCRIPT
chmod +x "$ATH/scripts/verify/web.sh"

commit() { # commit <파일…> — seed 에 커밋하고 push · 새 sha 를 찍는다
  ( cd "$TMP/seed" && for name in "$@"; do echo x > "$name"; done && git add -A && git commit -qm "c $*" && git push -q origin main && git rev-parse HEAD )
}
drop() { ( cd "$TMP/seed" && git rm -q "$@" && git commit -qm "drop $*" && git push -q origin main && git rev-parse HEAD ); }
events() { node --input-type=module -e "import { readEvents } from '$ATH/scripts/lib/events.mjs'; for (const event of readEvents('$ATH').filter((item) => item.type === 'verify.full')) console.log([event.kind, event.repo, event.sha, event.outcome, event.why ?? '', event.issue ?? ''].join(' '))"; }
issues() { ls "$ATH/issues" 2>/dev/null | grep -c '전체-검증-실패' ; }
FV="$ATH/scripts/full-verify.mjs"

echo "── 판정 함수"
check "기간 안 · 끔 · 켬 · 기간 밖" "node --input-type=module -e \"
import { shadowOn, verifyOutcome, dailyDue } from '$ATH/scripts/lib/full-verify.mjs'
const inside = Date.parse('2026-11-10T12:00:00+09:00'), after = Date.parse('2026-11-15T00:00:00+09:00'), before = Date.parse('2026-11-07T23:00:00+09:00')
const want = [shadowOn({}, inside), !shadowOn({ shadowVerify: false }, inside), shadowOn({ shadowVerify: true }, after), !shadowOn({}, after), !shadowOn({}, before),
  verifyOutcome(0, '') === 'pass', verifyOutcome(1, '| a | ❌ 실패 |') === 'fail', verifyOutcome(1, '| a | ❌ 건너뜀(엄격 모드) — x |') === 'unrun', verifyOutcome(null, '') === 'unrun',
  dailyDue({}, 'web'), !dailyDue({ web: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10) }, 'web')]
process.exit(want.every(Boolean) ? 0 : 1)\""

echo "── 그림자"
SHA1="$(git -C "$TMP/seed" rev-parse HEAD)"
config '{"shadowVerify":true,"repos":[{"name":"web","autoMerge":true,"autoMergeConfirm":false,"prBase":"main"}]}'
node "$FV" --shadow --repo web --sha "$SHA1" --pr 7 --plan plans/task/x.md > "$TMP/out1" 2>&1
check "통과 → 사건 pass · 이슈 없음" "events | grep -q '^shadow web ${SHA1:0:7} pass' && [ \"\$(issues)\" = 0 ]"
check "재사용 없는 엄격 전체(FULL · NO_REUSE_CORE · STRICT · 건너뜀 허용 · 계획서 걷음)" "tail -1 '$ENVLOG' | grep -q 'full=1 reuse=1 strict=1 allow= plan=$'"
check "따로 둔 워크트리에서(그 커밋)" "tail -1 '$ENVLOG' | grep -q 'dir=$ATH/full-verify/web-shadow' && [ \"\$(git -C '$ATH/full-verify/web-shadow' rev-parse HEAD)\" = '$SHA1' ]"

SHA2="$(commit FAIL)"
node "$FV" --shadow --repo web --sha "$SHA2" --pr 7 --plan plans/task/x.md > "$TMP/out2" 2>&1
ISSUE="$(ls "$ATH/issues"/*전체-검증-실패-shadow-${SHA2:0:7}.md 2>/dev/null | head -1)"
check "실패 → high 이슈(레포 · PR · 계획서 · 출력 끝)" "[ -n '$ISSUE' ] && grep -q '^severity: high' '$ISSUE' && grep -q '^repo: web' '$ISSUE' && grep -q '^pr: 7' '$ISSUE' && grep -q 'plans/task/x.md' '$ISSUE' && grep -q '❌ 실패' '$ISSUE'"
check "이슈 · 출력에 비밀값 가림" "! grep -q 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' '$ISSUE' && ! grep -q 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' '$TMP/out2'"
check "사건 fail + 이슈 경로" "events | grep -q '^shadow web ${SHA2:0:7} fail  issues/'"
node "$FV" --shadow --repo web --sha "$SHA2" --pr 7 > /dev/null 2>&1
check "같은 커밋 다시 실패해도 이슈는 하나" "[ \"\$(issues)\" = 1 ]"

SHA3="$(drop FAIL >/dev/null; commit SKIP)"
node "$FV" --shadow --repo web --sha "$SHA3" > /dev/null 2>&1
check "엄격 건너뜀만 → 실행 못 함(unrun) · 이슈 없음" "events | grep -q '^shadow web ${SHA3:0:7} unrun 엄격 모드 건너뜀' && [ \"\$(issues)\" = 1 ]"
node "$FV" --shadow --repo nope --sha "$SHA3" > /dev/null 2>&1
check "레포 없음 → 실행 못 함" "events | grep -q '^shadow nope ${SHA3:0:7} unrun 검증 스크립트 없음'"

config '{"shadowVerify":false,"repos":[{"name":"web","autoMerge":true,"autoMergeConfirm":false,"prBase":"main"}]}'
BEFORE="$(events | wc -l)"
node "$FV" --shadow --repo web --sha "$SHA3" > "$TMP/out3" 2>&1
check "shadowVerify: false → 돌지 않음" "grep -q '꺼짐' '$TMP/out3' && [ \"\$(events | wc -l)\" = '$BEFORE' ]"
check "잘못된 인자 → 1" "! node '$FV' --shadow --repo web --sha 'x;rm' > /dev/null 2>&1"

echo "── 하루 한 번"
config '{"repos":[{"name":"web","autoMerge":true,"autoMergeConfirm":false,"prBase":"main"},{"name":"api","autoMerge":true,"autoPr":false,"actionsHandoff":true,"autoMergeConfirm":false,"prBase":"main"}]}'
mkdir -p "$ATH/repos/api"; printf '#!/usr/bin/env bash\necho api >> "%s"\n' "$TMP/api.log" > "$ATH/scripts/verify/api.sh"
SHA4="$(drop SKIP)"
node "$FV" --daily > /dev/null 2>&1
check "prBase 끝을 돌림 → 사건 daily pass · 오늘 날짜 기록" "events | grep -q '^daily web ${SHA4:0:7} pass' && grep -q '\"web\"' '$ATH/full-verify/daily.json'"
check "Actions 로 넘기는 레포는 빼기" "[ ! -f '$TMP/api.log' ]"
COUNT="$(events | grep -c '^daily web')"
node "$FV" --daily > /dev/null 2>&1
check "오늘 이미 돈 레포는 건너뜀" "[ \"\$(events | grep -c '^daily web')\" = '$COUNT' ]"
SHA5="$(commit FAIL)"
node "$FV" --daily --force > /dev/null 2>&1
check "--force · 실패 → daily high 이슈" "events | grep -q '^daily web ${SHA5:0:7} fail' && ls '$ATH/issues'/*전체-검증-실패-daily-${SHA5:0:7}.md > /dev/null 2>&1"
config '{"dailyVerify":false,"repos":[{"name":"web","autoMerge":true,"autoMergeConfirm":false,"prBase":"main"}]}'
BEFORE="$(events | wc -l)"
node "$FV" --daily --force > "$TMP/out4" 2>&1
check "dailyVerify: false → 돌지 않음" "grep -q '꺼짐' '$TMP/out4' && [ \"\$(events | wc -l)\" = '$BEFORE' ]"

echo "── 연결"
check "pr-auto 머지 성공 두 곳에서 그림자 띄우기" "[ \"\$(grep -c 'startShadowVerify(job, config)' '$SRC/scripts/pr-auto.mjs')\" = 2 ]"
check "현황판이 한 시간마다 --daily" "grep -q \"scripts/full-verify.mjs'), '--daily'\" '$SRC/scripts/board/server.mjs'"

[ "$FAILED" = 0 ] && echo "full-verify-test: 모두 통과" || { echo "full-verify-test: 실패 있음"; exit 1; }
