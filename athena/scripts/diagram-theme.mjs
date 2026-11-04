#!/usr/bin/env node
// @ts-check
/**
 * Archify HTML에 공통 테마를 적용한다. 서비스는 원본을 보존하는 --output을 쓴다.
 *   node scripts/diagram-theme.mjs --output final.html original.archify.html
 *   node scripts/diagram-theme.mjs --check --receipt final.html
 * 기존 코어 그림의 제자리 적용: node scripts/diagram-theme.mjs <html>…
 * 자세히 칸: 최종 그림 옆에 <이름>.details.json 이 있거나 --details <파일> 을 주면 "상자를 누르면 옆에 자세히" 칸을 함께 넣는다
 *   (형식 { evidence, nodes: { <상자 id>: { what, code: [{ note, ref }], impact: [{ what, ref? }], tests: [파일] } } } — docs/diagrams/AUTHORING.md).
 *   그림에 없는 상자 id 가 있으면 실패 · --check 도 같은 자세히 파일로 대조한다 · 자세히 파일이 없으면 결과는 테마만 입힌 것과 같다
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const check = args.includes('--check')
const requireReceipt = args.includes('--receipt')
const outputIndex = args.indexOf('--output')
const output = outputIndex < 0 ? undefined : args[outputIndex + 1]
const detailsIndex = args.indexOf('--details')
const detailsArg = detailsIndex < 0 ? undefined : args[detailsIndex + 1]
const valueIndexes = [outputIndex, detailsIndex].filter(index => index >= 0).map(index => index + 1)
const files = args.filter((arg, index) => !['--check', '--receipt', '--output', '--details'].includes(arg) && !valueIndexes.includes(index))
if (!files.length || files.some(file => file.startsWith('--')) || (requireReceipt && !check) || (outputIndex >= 0 && (!output || check || files.length !== 1))
  || (detailsIndex >= 0 && (!detailsArg || detailsArg.startsWith('--') || files.length !== 1))) {
  console.error('사용: diagram-theme.mjs [--check [--receipt]] [--details <자세히.json>] <html>… | --output <최종.html> [--details <자세히.json>] <원본.html>')
  process.exit(2)
}
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'diagram-theme.css'), 'utf8')
// 스타일 상자를 숨겼으니 archify 의 S 키(스타일 돌리기)도 막는다 — archify 단축키 처리는 defaultPrevented 면 건너뛴다.
// 입력 칸 · 수정 키 조합은 그대로 둔다(archify 와 같은 조건). 창에 capture 로 걸어 archify 의 document 처리보다 먼저 돈다
const presetKeyGuard = `<script id="studio-theme-keys">
window.addEventListener('keydown', (event) => {
  if (event.key !== 's' && event.key !== 'S') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  event.preventDefault();
}, true);
</script>`
const block = `<!-- studio-theme -->\n<style id="studio-theme">\n${css}</style>\n${presetKeyGuard}\n<!-- /studio-theme -->`
const oldBlock = /<!-- studio-theme -->[\s\S]*?<!-- \/studio-theme -->\n?/g
// 자세히 칸 — 머리에 모양 블록 · 본문 끝에 칸 · 자료 · 스크립트 블록. 테마 블록처럼 표시 주석으로 감싸 다시 입혀도 하나만 남는다
const oldDetails = /<!-- (studio-details(?:-style)?) -->[\s\S]*?<!-- \/\1 -->\n?/g
/** @param {string} html */
const stripTheme = html => html.replace(oldBlock, '').replace(oldDetails, '')

/** 칸 모양 — 테마 토큰(라이트 · 다크 모두 diagram-theme.css 값)과 시스템 글꼴만 쓴다 · 위 단추 막대 아래(top 76px)부터 */
const detailsStyle = `<!-- studio-details-style -->
<style id="studio-details-style">
.sd-panel { position: fixed; top: max(76px, env(safe-area-inset-top, 0px)); right: max(16px, env(safe-area-inset-right, 0px)); bottom: 16px; width: min(380px, calc(100vw - 32px));
  background: var(--panel); color: var(--text); border: 1px solid var(--panel-border); border-radius: 8px; box-shadow: 0 12px 40px rgb(35 33 29 / 14%);
  padding: 18px 18px 20px; overflow: auto; z-index: 50; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; }
.sd-panel[hidden] { display: none !important; }
body.sd-open #focus-chip { display: none !important; }
.sd-panel h3 { margin: 0 32px 4px 0; font-size: 17px; line-height: 1.35; }
.sd-panel .sd-ctx { color: var(--text-muted); font-size: 12px; margin-bottom: 12px; }
.sd-panel h4 { margin: 16px 0 6px; font-size: 12px; color: var(--arrow-emphasis); }
.sd-panel h4.sd-impact { color: var(--security-stroke); }
.sd-panel p { margin: 0; }
.sd-panel ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.sd-panel code { font: 12px ui-monospace, Menlo, monospace; color: var(--text-muted); overflow-wrap: anywhere; }
.sd-panel .sd-close { position: absolute; top: 10px; right: 10px; border: 0; background: var(--bg); border-radius: 6px; width: 28px; height: 28px; cursor: pointer; font-size: 16px; color: var(--text); }
.sd-panel .sd-empty { color: var(--text-muted); }
.sd-hint { position: fixed; left: 50%; transform: translateX(-50%); bottom: max(16px, env(safe-area-inset-bottom, 0px)); background: var(--text); color: var(--panel);
  border-radius: 999px; padding: 6px 14px; font: 13px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; z-index: 40; }
.sd-hint[hidden] { display: none !important; }
</style>
<!-- /studio-details-style -->`

/** 칸을 여는 스크립트 — 상자 누르기 · Enter 로 열고 Esc · × 로 닫는다. 글자는 모두 escape 해 넣는다 */
const detailsScript = `<script>
(() => {
  const details = JSON.parse(document.getElementById('studio-details-data').textContent);
  const panel = document.getElementById('sd-panel');
  const hint = document.getElementById('sd-hint');
  const escapeText = (text) => String(text ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
  const list = (items, render) => items?.length ? '<ul>' + items.map(render).join('') + '</ul>' : '<p class="sd-empty">근거 있는 항목 없음</p>';
  const hide = () => { panel.hidden = true; document.body.classList.remove('sd-open'); };
  const show = (nodeEl) => {
    const info = details.nodes?.[nodeEl.getAttribute('data-node-id')];
    if (!info) return;
    panel.innerHTML = '<button class="sd-close" type="button" aria-label="닫기">×</button>'
      + '<h3>' + escapeText(nodeEl.getAttribute('data-node-label')) + '</h3>'
      + '<div class="sd-ctx">' + escapeText(nodeEl.getAttribute('data-node-context')) + '</div>'
      + '<h4>하는 일</h4><p>' + escapeText(info.what) + '</p>'
      + '<h4>코드 위치</h4>' + list(info.code, (item) => '<li>' + escapeText(item.note) + '<br><code>' + escapeText(item.ref) + '</code></li>')
      + '<h4 class="sd-impact">변경 영향 범위</h4>' + list(info.impact, (item) => '<li>' + escapeText(item.what) + (item.ref ? '<br><code>' + escapeText(item.ref) + '</code>' : '') + '</li>')
      + (info.tests?.length ? '<h4>확인할 테스트</h4>' + list(info.tests, (item) => '<li><code>' + escapeText(item) + '</code></li>') : '');
    panel.hidden = false;
    document.body.classList.add('sd-open');
    hint.hidden = true;
    panel.querySelector('.sd-close').addEventListener('click', hide);
  };
  document.addEventListener('click', (event) => {
    const nodeEl = event.target.closest?.('[data-node-id]');
    if (nodeEl) show(nodeEl);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
    if (event.key !== 'Enter') return;
    const nodeEl = document.activeElement?.closest?.('[data-node-id]');
    if (nodeEl) show(nodeEl);
  });
})();
</script>`

/**
 * 자세히 자료를 읽고 모양 · 상자 id 를 확인한다
 * @param {string} file @param {string} html
 * @returns {{ text: string, data: Record<string, unknown> }}
 */
function readDetails(file, html) {
  const text = readFileSync(file, 'utf8')
  /** @type {unknown} */
  const data = JSON.parse(text)
  if (!record(data) || !record(data.nodes)) throw new Error(`자세히 형식 오류(nodes 없음): ${file}`)
  const broken = Object.entries(data.nodes).filter(([, info]) => !record(info) || typeof info.what !== 'string').map(([nodeId]) => nodeId)
  if (broken.length) throw new Error(`자세히 형식 오류(what 없음): ${broken.join(', ')}`)
  const missing = Object.keys(data.nodes).filter(nodeId => !html.includes(`data-node-id="${nodeId}"`))
  if (missing.length) throw new Error(`자세히에 그림에 없는 상자: ${missing.join(', ')}`)
  return { text, data }
}

/** @param {string} html @param {{ data: Record<string, unknown> }} [details] */
function applyTheme(html, details) {
  const themed = stripTheme(html).replace('</head>', `${block}\n</head>`)
  if (!details) return themed
  if (!/<\/body>/.test(themed)) throw new Error('</body> 가 없어 자세히 칸을 넣지 못함')
  // </script> 가 자료 안에서 스크립트를 닫지 않게 < 를 바꾼다
  const data = JSON.stringify(details.data).replace(/</g, '\\u003c')
  const body = `<!-- studio-details -->
<aside class="sd-panel" id="sd-panel" hidden aria-live="polite"></aside>
<div class="sd-hint" id="sd-hint">상자를 누르면 하는 일 · 코드 위치 · 변경 영향 범위가 나옵니다</div>
<script id="studio-details-data" type="application/json">${data}</script>
${detailsScript}
<!-- /studio-details -->`
  return themed.replace('</head>', `${detailsStyle}\n</head>`).replace(/<\/body>(?![\s\S]*<\/body>)/, `${body}\n</body>`)
}
/** @param {string} text */
const digest = text => ({ sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) })
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @param {string} text */
const matchesDigest = (value, text) => record(value) && value.sha256 === digest(text).sha256 && value.bytes === digest(text).bytes
/** @param {string} file */
const identity = file => existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(resolve(file))), basename(file))
/** 바뀐 최종본에 이전 캡처가 남지 않게 Archify의 알려진 sidecar만 지운다. @param {string} file */
function clearBrowserEvidence(file) {
  const stem = file.replace(/\.html$/i, '')
  for (const suffix of ['json', 'html', '1440x900.light.png', '1440x900.dark.png', '2048x1320.light.png', '2048x1320.dark.png']) {
    rmSync(`${stem}.visual-check.${suffix}`, { force: true })
  }
}
/** --check 에서 옆 파일이 없을 때 — 영수증에 적힌 자세히 파일(--output 때 --details 로 준 자리) @param {string} receiptPath */
function receiptDetailsPath(receiptPath) {
  if (!existsSync(receiptPath)) return undefined
  try {
    /** @type {unknown} */
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    if (record(receipt) && record(receipt.details) && typeof receipt.details.path === 'string') return resolve(dirname(receiptPath), receipt.details.path)
  } catch {
    // 영수증 형식 오류는 아래 영수증 대조가 알린다
  }
  return undefined
}
let failures = 0
for (const file of files) {
  try {
    const html = readFileSync(file, 'utf8')
    if (!/<svg[^>]*data-quality-profile=/.test(html) || !html.includes('</head>')) {
      if (output || requireReceipt) throw new Error('Archify HTML이 아님')
      console.log(`건너뜀(archify 결과 아님): ${file}`)
      continue
    }
    const final = output ?? file
    const receiptPath = `${final}.theme.json`
    const besideDetails = final.replace(/\.html$/i, '.details.json')
    const detailsPath = detailsArg ?? (existsSync(besideDetails) ? besideDetails : undefined) ?? (check ? receiptDetailsPath(receiptPath) : undefined)
    const details = detailsPath ? readDetails(detailsPath, html) : undefined
    const themed = applyTheme(html, details)
    if (check) {
      if (html !== themed) throw new Error(details ? '테마 · 자세히 칸이 없거나 옛것 · 자세히 파일과 다름' : '테마 없음·옛 테마·중복 테마·자세히 파일 없이 자세히 칸만 남음')
      if (requireReceipt || existsSync(receiptPath)) {
        /** @type {unknown} */
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
        if (!record(receipt) || !record(receipt.source) || typeof receipt.source.path !== 'string') throw new Error('변환 영수증 형식 오류')
        const source = readFileSync(resolve(dirname(final), receipt.source.path), 'utf8')
        if (receipt.evidenceKind !== 'athena-theme' || !matchesDigest(receipt.artifact, html) || !matchesDigest(receipt.theme, css) || !matchesDigest(receipt.source.digest, source) || source !== stripTheme(source)
          || (details ? !record(receipt.details) || !matchesDigest(receipt.details.digest, details.text) : receipt.details !== undefined) || applyTheme(source, details) !== html) {
          throw new Error('원본·최종·테마 영수증 불일치 — 성공한 deliver부터 다시 생성')
        }
      }
      console.log(`✔ ${file}`)
      continue
    }
    if (output && (!/\.html$/i.test(output) || identity(file) === identity(output) || html !== stripTheme(html))) {
      throw new Error('--output은 테마 없는 원본과 다른 .html 경로여야 함')
    }
    const previous = existsSync(final) ? readFileSync(final, 'utf8') : undefined
    if (previous !== themed) {
      clearBrowserEvidence(final)
      rmSync(receiptPath, { force: true })
      writeFileSync(final, themed)
    }
    if (output) {
      // deliver 검증을 주장하지 않는다. 원본 deliver 영수증과 별도로 보관한다.
      const receipt = { evidenceKind: 'athena-theme', source: { path: relative(dirname(resolve(final)), resolve(file)), digest: digest(html) }, artifact: digest(themed), theme: digest(css),
        ...(details && detailsPath ? { details: { path: relative(dirname(resolve(final)), resolve(detailsPath)), digest: digest(details.text) } } : {}) }
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    }
    console.log(details ? `테마 · 자세히 칸 입힘: ${final} (상자 ${Object.keys(/** @type {Record<string, unknown>} */ (details.data.nodes)).length}개)` : `테마 입힘: ${final}`)
  } catch (error) {
    failures++
    console.error(`✖ ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(failures ? 1 : 0)
