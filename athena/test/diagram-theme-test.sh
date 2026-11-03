#!/usr/bin/env bash
# 다이어그램 테마 시험 — scripts/diagram-theme.mjs 가 archify 결과에만 · 한 번만 입히는지(임시 폴더 · 몇 초)
#
# 사용: test/diagram-theme-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
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
sed -i.bak 's/BlinkMacSystemFont, "Apple/BlinkMacSystemFont, "OLD/' "$WORK/a.html"
T --check "$WORK/a.html" > /dev/null; check "옛 테마면 --check → 1(다시 입히라고)" '[ $? -eq 1 ]'
T > /dev/null 2>&1; check "파일 없이 부르면 사용법(2)" '[ $? -eq 2 ]'
for file in "$SRC"/docs/diagrams/*.html; do
  [ -e "$file" ] || continue
  T --check "$file" > /dev/null; check "코어 다이어그램에 지금 테마: $(basename "$file")" '[ $? -eq 0 ]'
done

# 원본/최종 분리와 영수증·캡처 수명은 실제 파일로 검증한다.
node --input-type=module - "$SRC" "$WORK" <<'JS'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [source, work] = process.argv.slice(2)
const raw = join(work, 'source.archify.html')
const final = join(work, 'final.html')
const receiptPath = `${final}.theme.json`
const original = '<html><head></head><body><svg data-quality-profile="showcase"><text>실제 내용</text></svg></body></html>'
writeFileSync(raw, original)
const run = (...args) => spawnSync(process.execPath, [join(source, 'scripts/diagram-theme.mjs'), ...args], { encoding: 'utf8' })
const apply = () => { const result = run('--output', final, raw); assert.equal(result.status, 0, result.stderr) }
const verify = () => run('--check', '--receipt', final).status
const hash = text => createHash('sha256').update(text).digest('hex')
apply()
assert.equal(readFileSync(raw, 'utf8'), original)
const first = readFileSync(final, 'utf8')
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
assert.equal(receipt.evidenceKind, 'athena-theme')
assert.equal(receipt.source.digest.sha256, hash(original))
assert.equal(receipt.artifact.sha256, hash(first))
assert.notEqual(receipt.source.digest.sha256, receipt.artifact.sha256)
assert.equal(receipt.artifact.bytes, Buffer.byteLength(first))
assert.equal(verify(), 0)
const suffixes = ['json', 'html', '1440x900.light.png', '1440x900.dark.png', '2048x1320.light.png', '2048x1320.dark.png']
const sidecars = suffixes.map(suffix => join(work, `final.visual-check.${suffix}`))
for (const path of sidecars) writeFileSync(path, '이전 증거')
apply()
assert.equal(readFileSync(final, 'utf8'), first)
assert.ok(sidecars.every(path => existsSync(path)), '같은 최종 바이트의 증거는 유지')
writeFileSync(raw, original.replace('실제 내용', '바뀐 내용'))
assert.equal(verify(), 1, '원본 변경 감지')
apply()
assert.ok(sidecars.every(path => !existsSync(path)), '최종 변경 때 stale 증거 전부 제거')
assert.equal(verify(), 0)
writeFileSync(final, readFileSync(final, 'utf8').replace('바뀐 내용', '최종 변조'))
assert.equal(verify(), 1, '최종 변경 감지')
apply()
const altered = JSON.parse(readFileSync(receiptPath, 'utf8'))
altered.theme.sha256 = 'old'
writeFileSync(receiptPath, JSON.stringify(altered))
assert.equal(verify(), 1, '테마 변경 감지')
apply()
const current = readFileSync(final, 'utf8')
const block = current.match(/<!-- studio-theme -->[\s\S]*?<!-- \/studio-theme -->\n?/)[0]
writeFileSync(final, current.replace('</head>', `${block}</head>`))
assert.equal(verify(), 1, '중복 테마 감지')
apply()
assert.equal(readFileSync(final, 'utf8'), current, '다시 생성하면 중복 없이 일관적')
assert.equal(verify(), 0)
assert.equal(run('--output', raw, raw).status, 1, '원본 덮어쓰기 거부')
const alias = join(work, 'alias.html')
symlinkSync(raw, alias)
assert.equal(run('--output', alias, raw).status, 1, '심볼릭 링크로도 원본 덮어쓰기 거부')
assert.equal(run('--output', join(work, 'bad.html'), final).status, 1, '테마 최종본을 원본으로 위장하지 않음')
assert.equal(run('--output', join(work, 'bad.html'), join(work, 'index.html')).status, 1)
assert.equal(run('--check', '--receipt', join(work, 'a.html')).status, 1, '영수증 없는 파일은 서비스 검증 실패')
console.log('  ✔ 원본/최종 해시·변조·중복·재생성·캡처 무효화·원본 보존')
JS
check "원본/최종 전달 회귀" '[ $? -eq 0 ]'

printf '\n통과 %s · 실패 %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
