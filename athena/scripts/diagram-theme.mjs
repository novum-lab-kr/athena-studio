#!/usr/bin/env node
// @ts-check
/**
 * Archify HTML에 공통 테마를 적용한다. 서비스는 원본을 보존하는 --output을 쓴다.
 *   node scripts/diagram-theme.mjs --output final.html original.archify.html
 *   node scripts/diagram-theme.mjs --check --receipt final.html
 * 기존 코어 그림의 제자리 적용: node scripts/diagram-theme.mjs <html>…
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
const files = args.filter((arg, index) => !['--check', '--receipt', '--output'].includes(arg) && (outputIndex < 0 || index !== outputIndex + 1))
if (!files.length || files.some(file => file.startsWith('--')) || (requireReceipt && !check) || (outputIndex >= 0 && (!output || check || files.length !== 1))) {
  console.error('사용: diagram-theme.mjs [--check [--receipt]] <html>… | --output <최종.html> <원본.html>')
  process.exit(2)
}
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'diagram-theme.css'), 'utf8')
const block = `<!-- studio-theme -->\n<style id="studio-theme">\n${css}</style>\n<!-- /studio-theme -->`
const oldBlock = /<!-- studio-theme -->[\s\S]*?<!-- \/studio-theme -->\n?/g
/** @param {string} html */
const stripTheme = html => html.replace(oldBlock, '')
/** @param {string} html */
const applyTheme = html => stripTheme(html).replace('</head>', `${block}\n</head>`)
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
    const themed = applyTheme(html)
    if (check) {
      if (html !== themed) throw new Error('테마 없음·옛 테마·중복 테마')
      if (requireReceipt || existsSync(receiptPath)) {
        /** @type {unknown} */
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
        if (!record(receipt) || !record(receipt.source) || typeof receipt.source.path !== 'string') throw new Error('변환 영수증 형식 오류')
        const source = readFileSync(resolve(dirname(final), receipt.source.path), 'utf8')
        if (receipt.evidenceKind !== 'athena-theme' || !matchesDigest(receipt.artifact, html) || !matchesDigest(receipt.theme, css) || !matchesDigest(receipt.source.digest, source) || source !== stripTheme(source) || applyTheme(source) !== html) {
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
      const receipt = { evidenceKind: 'athena-theme', source: { path: relative(dirname(resolve(final)), resolve(file)), digest: digest(html) }, artifact: digest(themed), theme: digest(css) }
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    }
    console.log(`테마 입힘: ${final}`)
  } catch (error) {
    failures++
    console.error(`✖ ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(failures ? 1 : 0)
