#!/usr/bin/env node
/**
 * 다이어그램 테마 — archify 가 deliver 로 만든 HTML 에 아테나 테마(scripts/diagram-theme.css)를 덧씌운다.
 * </head> 바로 앞에 글꼴 링크 + <style id="studio-theme"> 를 넣는다. 이미 입혀져 있으면 바꿔 끼운다(여러 번 돌려도 같다).
 * archify 의 SVG · 배치 · 뷰어 기능(확대 · 검색 · 내보내기)은 건드리지 않는다. archify 결과가 아닌 HTML(목록 index.html 등)은 건너뛴다
 *
 *   node scripts/diagram-theme.mjs <html>…        deliver 직후 · 번들(build-bundle.py)을 만들기 전에
 *   node scripts/diagram-theme.mjs --check <html>…  입혀져 있는지만(안 입힌 것이 있으면 1)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const check = args.includes('--check')
const files = args.filter((arg) => arg !== '--check')
if (!files.length) {
  console.error('사용: node scripts/diagram-theme.mjs [--check] <html>…')
  process.exit(2)
}

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'diagram-theme.css'), 'utf8')
const BLOCK = [
  '<!-- studio-theme -->',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap">',
  `<style id="studio-theme">\n${css}</style>`,
  '<!-- /studio-theme -->',
].join('\n')
const OLD_BLOCK = /<!-- studio-theme -->[\s\S]*?<!-- \/studio-theme -->\n?/
// archify 결과인가 — deliver 가 만든 SVG 에는 data-quality-profile 이 붙는다
const isArchify = (html) => /<svg[^>]*data-quality-profile=/.test(html)

let missing = 0
for (const file of files) {
  const html = readFileSync(file, 'utf8')
  if (!isArchify(html) || !html.includes('</head>')) {
    console.log(`건너뜀(archify 결과 아님): ${file}`)
    continue
  }
  if (check) {
    const themed = html.match(OLD_BLOCK)?.[0] === `${BLOCK}\n`
    if (!themed) missing += 1
    console.log(`${themed ? '✔' : '✖ 테마 없음(또는 옛 테마)'} ${file}`)
    continue
  }
  writeFileSync(file, html.replace(OLD_BLOCK, '').replace('</head>', `${BLOCK}\n</head>`))
  console.log(`테마 입힘: ${file}`)
}
process.exit(missing ? 1 : 0)
