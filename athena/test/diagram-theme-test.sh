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

# 자세히 칸 — 옆 <이름>.details.json · --details · 없는 상자 id · 다시 입히기 · escape · 영수증 대조 · 없으면 테마만과 같은 바이트
node --input-type=module - "$SRC" "$WORK" <<'JS'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [source, base] = process.argv.slice(2)
const work = join(base, 'details')
mkdirSync(work)
const run = (...args) => spawnSync(process.execPath, [join(source, 'scripts/diagram-theme.mjs'), ...args], { encoding: 'utf8' })
const raw = join(work, 'flow.archify.html')
const final = join(work, 'flow.html')
const beside = join(work, 'flow.details.json')
writeFileSync(raw, '<html><head></head><body><svg data-quality-profile="standard"><g data-node-id="pick" data-node-label="출발 고르기" data-node-context="화면" tabindex="0"><rect/></g><g data-node-id="calc" data-node-label="길 계산"></g></svg></body></html>')
// 자세히 없이 만든 결과 — 자세히를 붙였다 떼면 이 바이트로 돌아와야 한다
assert.equal(run('--output', final, raw).status, 0)
const plain = readFileSync(final, 'utf8')
const plainReceipt = readFileSync(`${final}.theme.json`, 'utf8')
assert.ok(!plain.includes('studio-details'), '자세히 파일이 없으면 칸을 넣지 않음')
const details = { evidence: '시험', nodes: { pick: { what: '<b>누름</b> </script><script>alert(1)</script>', code: [{ note: '단추', ref: 'web/a.ts:1' }], impact: [{ what: '목록', ref: 'web/b.ts:2' }], tests: ['test/a.test.ts'] } } }
writeFileSync(beside, JSON.stringify(details))
const applied = run('--output', final, raw)
assert.equal(applied.status, 0, applied.stderr)
const withDetails = readFileSync(final, 'utf8')
for (const mark of ['<!-- studio-details-style -->', '<!-- studio-details -->']) assert.equal(withDetails.split(mark).length, 2, `${mark} 하나`)
assert.ok(!withDetails.includes('</script><script>alert(1)'), '자료 속 </script> 는 스크립트를 닫지 않음')
assert.ok(withDetails.indexOf('<!-- /studio-details -->') < withDetails.lastIndexOf('</body>'), '칸은 본문 끝에')
const receipt = JSON.parse(readFileSync(`${final}.theme.json`, 'utf8'))
assert.equal(receipt.details.path, 'flow.details.json', '영수증에 자세히 경로')
assert.equal(run('--check', '--receipt', final).status, 0, '자세히 든 그림 --check 통과')
assert.equal(run('--output', final, raw).status, 0)
assert.equal(readFileSync(final, 'utf8'), withDetails, '다시 입혀도 같다')
// 원본으로 최종본(자세히 든 것)을 넘기면 거절 · 자세히가 바뀌면 --check 실패
assert.equal(run('--output', join(work, 'other.html'), final).status, 1, '자세히 든 최종본은 원본이 아님')
writeFileSync(beside, JSON.stringify({ ...details, evidence: '바뀜' }))
assert.equal(run('--check', '--receipt', final).status, 1, '자세히 파일이 바뀌면 다시 만들라고')
assert.equal(run('--check', final).status, 1, '영수증 없이도 자세히 내용 대조')
// 그림에 없는 상자 id · 형식 오류는 실패하고 최종본을 건드리지 않음
writeFileSync(beside, JSON.stringify({ nodes: { pick: { what: '누름' }, ghost: { what: '없는 상자' } } }))
const missing = run('--output', final, raw)
assert.equal(missing.status, 1)
assert.match(missing.stderr, /ghost/)
assert.equal(run('--check', final).status, 1, '--check 도 없는 id 면 실패')
writeFileSync(beside, JSON.stringify({ nodes: { pick: { code: [] } } }))
assert.equal(run('--output', final, raw).status, 1, 'what 없으면 실패')
// --details 로 다른 자리의 파일
const elsewhere = join(base, 'elsewhere.details.json')
writeFileSync(elsewhere, JSON.stringify(details))
rmSync(beside)
assert.equal(run('--output', final, '--details', elsewhere, raw).status, 0)
assert.equal(readFileSync(final, 'utf8'), withDetails, '--details 결과는 옆 파일과 같음')
assert.equal(run('--check', '--receipt', final).status, 0, '영수증의 자세히 경로로 대조')
rmSync(`${final}.theme.json`)
assert.equal(run('--check', final).status, 1, '자세히 파일 · 영수증 없이 칸만 남으면 실패')
assert.equal(run('--details', elsewhere, final, join(work, 'x.html')).status, 2, '--details 는 그림 하나만')
// 자세히를 떼면 테마만 입힌 결과와 바이트가 같다
assert.equal(run('--output', final, raw).status, 0)
assert.equal(readFileSync(final, 'utf8'), plain, '자세히 없으면 지금과 같은 결과')
assert.equal(readFileSync(`${final}.theme.json`, 'utf8'), plainReceipt, '영수증도 같음')
// 실제 브라우저 — 상자를 누르면 칸이 뜨고 글자는 escape · Esc 로 닫힘
writeFileSync(beside, JSON.stringify(details))
assert.equal(run('--output', final, raw).status, 0)
const candidates = [process.env.ARCHIFY_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
const chrome = candidates.find(file => file && existsSync(file))
if (!chrome) {
  console.log('  ✔ 자세히 칸 파일 회귀(⏭ 브라우저 확인은 Chrome/Chromium 없어 실행 못 함)')
  process.exit(0)
}
const probe = join(work, 'probe.html')
const html = readFileSync(final, 'utf8')
const steps = `<pre id="result"></pre><script>window.addEventListener('load', () => {
 const panel = document.getElementById('sd-panel'), hint = document.getElementById('sd-hint'), row = {}
 row.closedAtStart = panel.hidden && !hint.hidden
 document.querySelector('[data-node-id="calc"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
 row.noDetailsStaysClosed = panel.hidden
 document.querySelector('[data-node-id="pick"] rect').dispatchEvent(new MouseEvent('click', { bubbles: true }))
 row.open = !panel.hidden && document.body.classList.contains('sd-open') && hint.hidden
 row.title = panel.querySelector('h3').textContent
 row.escaped = !panel.querySelector('b') && panel.textContent.includes('<b>누름</b>')
 row.code = panel.querySelector('code').textContent
 row.impactTitle = panel.querySelector('h4.sd-impact')?.textContent
 document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
 row.closedByEsc = panel.hidden
 document.querySelector('[data-node-id="pick"]').focus()
 document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
 row.openByEnter = !panel.hidden
 panel.querySelector('.sd-close').click()
 row.closedByButton = panel.hidden
 document.getElementById('result').textContent = JSON.stringify(row)
})</script>`
writeFileSync(probe, html.slice(0, html.lastIndexOf('</body>')) + steps + html.slice(html.lastIndexOf('</body>')))
const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(work, 'chrome-profile')}`, '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(probe).href]
if (process.getuid?.() === 0) flags.unshift('--no-sandbox')
const result = spawnSync(chrome, flags, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
assert.equal(result.status, 0, 'Chrome 자세히 칸 확인 실행 실패')
const json = result.stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1]
assert.ok(json, '브라우저 결과 없음')
assert.deepEqual(JSON.parse(json), { closedAtStart: true, noDetailsStaysClosed: true, open: true, title: '출발 고르기', escaped: true, code: 'web/a.ts:1', impactTitle: '변경 영향 범위', closedByEsc: true, openByEnter: true, closedByButton: true })
console.log('  ✔ 자세히 칸 — 파일 회귀 · 브라우저 열기/닫기 · escape')
JS
check "자세히 칸 회귀" '[ $? -eq 0 ]'

# 흐름 그림 visual-check 판정 — 세로로만 넘친 것만 허용하고 가로 넘침 · 겹침 · 캡처 못 함 · 옛 결과는 실패
J() { node "$SRC/scripts/diagram-visual-judge.mjs" "$@" > /dev/null 2>&1; }
printf '<html><body>그림</body></html>' > "$WORK/v.html"
receipt() {   # $1 진단 JSON 배열 · $2 captures.status · $3 chrome.status
  node -e '
    const [html, diagnostics, captures, chrome] = process.argv.slice(1)
    const fs = require("fs"), bytes = fs.readFileSync(html)
    const sha256 = require("crypto").createHash("sha256").update(bytes).digest("hex")
    fs.writeFileSync(html.replace(/\.html$/, ".visual-check.json"), JSON.stringify({ command: "visual-check", evidenceKind: "automated-browser", status: "fail",
      artifact: { sha256, bytes: bytes.length }, chrome: { status: chrome }, captures: { status: captures }, diagnostics: JSON.parse(diagnostics) }))
  ' "$WORK/v.html" "$1" "${2:-pass}" "${3:-available}"
}
TALL='{"code":"viewer/viewport-overflow","severity":"error","message":"tall","evidence":{"overflowX":false,"overflowY":true}}'
WIDE='{"code":"viewer/viewport-overflow","severity":"error","message":"wide","evidence":{"overflowX":true,"overflowY":true}}'
DOCK='{"code":"viewer/chrome-stage-clearance","severity":"error","message":"dock","evidence":{}}'
J; check "판정: 파일 없이 부르면 사용법(2)" '[ $? -eq 2 ]'
J "$WORK/v.html"; check "판정: 결과 파일 없음 → 1" '[ $? -eq 1 ]'
receipt "[$TALL,$TALL]"; J "$WORK/v.html"; check "판정: 세로로만 넘침 → 0" '[ $? -eq 0 ]'
receipt "[$TALL,{\"code\":\"x/info\",\"severity\":\"warning\"}]"; J "$WORK/v.html"; check "판정: 오류 아닌 진단은 보지 않음 → 0" '[ $? -eq 0 ]'
receipt "[$TALL,$WIDE]"; J "$WORK/v.html"; check "판정: 가로 넘침 → 1" '[ $? -eq 1 ]'
receipt "[$TALL,$DOCK]"; J "$WORK/v.html"; check "판정: 도크 겹침 → 1" '[ $? -eq 1 ]'
receipt "[$TALL]" skipped; J "$WORK/v.html"; check "판정: 캡처 못 함 → 1" '[ $? -eq 1 ]'
receipt "[]" pass unavailable; J "$WORK/v.html"; check "판정: Chrome 없음 → 1" '[ $? -eq 1 ]'
receipt "[$TALL]"; printf ' ' >> "$WORK/v.html"; J "$WORK/v.html"; check "판정: HTML 이 바뀐 옛 결과 → 1" '[ $? -eq 1 ]'

printf '\n통과 %s · 실패 %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
