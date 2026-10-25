#!/usr/bin/env bash
# 다이어그램 테마 시험 — scripts/diagram-theme.mjs 가 archify 결과에만 · 한 번만 입히는지(임시 폴더 · 몇 초)
#
# 사용: test/diagram-theme-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/diagram-theme-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
check() { if eval "$2"; then PASS=$((PASS+1)); printf '  ✔ %s\n' "$1"; else FAIL=$((FAIL+1)); printf '  ✖ %s\n' "$1"; fi; }
T() { node "$SRC/scripts/diagram-theme.mjs" "$@"; }

# archify 결과 모양(deliver 가 SVG 에 data-quality-profile 을 붙인다) · 그 밖의 html
printf '<html><head><title>x</title></head><body><svg viewBox="0 0 10 10" data-quality-profile="showcase"></svg></body></html>' > "$WORK/a.html"
printf '<html><head></head><body>목록</body></html>' > "$WORK/index.html"

T --check "$WORK/a.html" > /dev/null; check "입히기 전 --check → 1" '[ $? -eq 1 ]'
T "$WORK/a.html" "$WORK/index.html" > /dev/null
check "archify 결과에 테마 블록 하나" '[ "$(grep -c "<!-- studio-theme -->" "$WORK/a.html")" = 1 ] && grep -q "id=\"studio-theme\"" "$WORK/a.html"'
check "</head> 바로 앞에 · 본문은 그대로" 'grep -q "<!-- /studio-theme -->" "$WORK/a.html" && grep -q "data-quality-profile=\"showcase\"></svg></body>" "$WORK/a.html"'
check "archify 결과가 아니면 건너뜀" '! grep -q studio-theme "$WORK/index.html"'
cp "$WORK/a.html" "$WORK/once.html"
T "$WORK/a.html" > /dev/null
check "두 번 입혀도 같다" 'cmp -s "$WORK/a.html" "$WORK/once.html"'
T --check "$WORK/a.html" > /dev/null; check "입힌 뒤 --check → 0" '[ $? -eq 0 ]'
sed -i.bak 's/IBM Plex Sans KR", "Apple/IBM Plex Sans KR", "OLD/' "$WORK/a.html"
T --check "$WORK/a.html" > /dev/null; check "옛 테마면 --check → 1(다시 입히라고)" '[ $? -eq 1 ]'
T > /dev/null 2>&1; check "파일 없이 부르면 사용법(2)" '[ $? -eq 2 ]'
for file in "$SRC"/docs/diagrams/*.html; do
  [ -e "$file" ] || continue
  T --check "$file" > /dev/null; check "코어 다이어그램에 지금 테마: $(basename "$file")" '[ $? -eq 0 ]'
done

printf '\n통과 %s · 실패 %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
