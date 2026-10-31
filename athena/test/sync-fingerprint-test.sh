#!/usr/bin/env bash
# sync-fingerprint 시험 — 기준 ref(origin/<branch>)를 못 읽는 레포가 있어도 스택 트레이스로 죽지 않고 그 레포만 건너뛴다
# (⚠️ 안내 · 앞 실행의 pending 정리 · 마지막 줄이 "모두 동일" 로 나오지 않음 · 읽은 레포는 정상) — 임시 폴더 · 네트워크 없음 · 몇 초
#
# 사용: test/sync-fingerprint-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-sync-fp-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() {   # <이름> <조건 셸 식> [실패 때 보일 것]
  if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -n "${3:-}" ] && echo "      $3"; FAIL=1; fi
}

# 임시 본체: 스크립트 사본 + 설정 + 레포 둘(good: origin/dev 있음 · norem: 원격 없음)
BODY="$TMP/body"; mkdir -p "$BODY/repos"
cp -R "$SRC/scripts" "$BODY/scripts"
cat > "$BODY/athena.config.json" <<'JSON'
{"repos":[
  {"name":"good","branch":"dev","kind":"single","appDir":"app","agents":["good-fe"]},
  {"name":"norem","branch":"dev","kind":"single","appDir":"app","agents":["norem-fe"]}
]}
JSON
GIT="git -c user.name=t -c user.email=t@t"
git init -q -b dev "$TMP/origin.git" --bare
git init -q -b dev "$BODY/repos/good"
echo '{"name":"good","version":"1.0.0"}' > "$BODY/repos/good/package.json"
$GIT -C "$BODY/repos/good" add -A && $GIT -C "$BODY/repos/good" commit -q -m init
git -C "$BODY/repos/good" remote add origin "$TMP/origin.git"
git -C "$BODY/repos/good" push -q origin dev
git init -q -b dev "$BODY/repos/norem"
run() { (cd "$BODY" && node scripts/sync-fingerprint.mjs "$@" 2>&1); }

echo "기준 ref 없는 레포가 섞여 있을 때"
OUT="$(run --no-fetch)"; CODE=$?
check "예외로 죽지 않는다(종료 0)" '[ "$CODE" = 0 ]' "$OUT"
check "스택 트레이스가 없다" '! echo "$OUT" | grep -q "node:internal\|    at "'
check "없는 ref 와 할 일을 알린다" 'echo "$OUT" | grep -q "⚠️ 기준 ref .origin/dev. 를 읽을 수 없어" && echo "$OUT" | grep -q "원격(origin)을 연결"'
check "읽을 수 있는 레포는 지문이 만들어진다" '[ -f "$BODY/.sync/pending/good.json" ] && [ ! -f "$BODY/.sync/pending/norem.json" ]'
check "마지막 줄이 건너뛴 레포를 알린다" 'echo "$OUT" | tail -1 | grep -q "건너뛴 레포 1개(norem)"'
check "마지막 줄이 \"모든 레포가 baseline 과 동일\" 이 아니다" '! echo "$OUT" | tail -1 | grep -q "모든 레포가 baseline 과 동일"'

echo "앞 실행의 pending 이 남아 있을 때"
echo '{"repo":"norem","sha":"stale"}' > "$BODY/.sync/pending/norem.json"
run --no-fetch >/dev/null
check "못 읽은 레포의 옛 pending 을 지운다(--accept 가 확정하지 않게)" '[ ! -f "$BODY/.sync/pending/norem.json" ]'
run --accept >/dev/null
check "--accept 는 읽은 레포만 확정한다" '[ -f "$BODY/.sync/snapshots/good.json" ] && [ ! -f "$BODY/.sync/snapshots/norem.json" ]'

echo "모든 레포를 못 읽을 때"
OUT="$(run --no-fetch --repo norem)"; CODE=$?
check "종료 0 · 읽은 레포가 없다고 알린다" '[ "$CODE" = 0 ] && echo "$OUT" | tail -1 | grep -q "읽은 레포가 없다"' "$OUT"

echo
[ "$FAIL" = 0 ] && echo "✅ 모두 통과" || echo "❌ 실패 있음"
exit "$FAIL"
