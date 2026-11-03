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

# CSS 문구 대신 실제 브라우저의 SVG computed fill로 8px/9px 라벨을 확인한다.
node --input-type=module - "$SRC" "$WORK" <<'JS'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [source, work] = process.argv.slice(2)
const candidates = [process.env.ARCHIFY_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
const chrome = candidates.find(file => file && existsSync(file))
if (!chrome) {
  console.log('  ⏭ SVG 라벨 computed style 실행 못 함 — Chrome/Chromium 없음')
  process.exit(77)
}
const css = readFileSync(join(source, 'scripts/diagram-theme.css'), 'utf8')
const fixture = join(work, 'labels.html')
writeFileSync(fixture, `<html><head><style>.t-backend { fill: var(--backend-stroke); } ${css}</style></head><body>
<svg><text id="eight" class="t-backend" font-size="8">구조 요청</text><text id="nine" class="t-backend" font-size="9">pane:split invoke</text></svg><span id="accent" style="color:var(--arrow-emphasis)"></span><pre id="result"></pre>
<script>
const results = ['light','dark'].map(theme => {
 document.documentElement.dataset.theme = theme;
 return {theme, expected:getComputedStyle(document.getElementById('accent')).color, labels:['eight','nine'].map(id=>({id,fill:getComputedStyle(document.getElementById(id)).fill,size:getComputedStyle(document.getElementById(id)).fontSize,weight:getComputedStyle(document.getElementById(id)).fontWeight}))};
});
document.getElementById('result').textContent = JSON.stringify(results);
</script></body></html>`)
const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(work, 'chrome-label-profile')}`, '--dump-dom', pathToFileURL(fixture).href]
if (process.getuid?.() === 0) flags.unshift('--no-sandbox')
const result = spawnSync(chrome, flags, { encoding:'utf8', timeout:30000, maxBuffer:2*1024*1024 })
assert.equal(result.status, 0, 'Chrome 라벨 회귀 실행 실패')
const json = result.stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1]
assert.ok(json, 'computed style 결과 없음')
for (const row of JSON.parse(json)) {
 for (const label of row.labels) assert.equal(label.fill, row.expected, `${row.theme} ${label.id}: 요청 라벨은 강조 읽기색이어야 함`)
 assert.equal(row.labels[1].size, '9px', '9px 메시지는 크기 유지')
 assert.equal(row.labels[1].weight, '400', '9px 메시지는 굵기 유지')
}
console.log('  ✔ 밝음/어두움 8px·9px SVG 요청 라벨 computed fill')
JS
BROWSER_STATUS=$?
if [ "$BROWSER_STATUS" -ne 77 ]; then
  check "실제 브라우저 SVG 라벨 색 회귀" '[ "$BROWSER_STATUS" -eq 0 ]'
fi

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
