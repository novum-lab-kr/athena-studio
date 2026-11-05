#!/usr/bin/env node
// @ts-check
/**
 * 작업 흐름 그림(docs/diagrams/athena-*.html)의 Archify visual-check 결과를 이 그림 구성에 맞춰 다시 판정한다.
 *   node "$A/bin/archify.mjs" visual-check docs/diagrams/athena-flow.html --json   # <그림>.visual-check.json 을 남긴다
 *   node scripts/diagram-visual-judge.mjs docs/diagrams/athena-flow.html          # 0 통과 · 1 실패 · 2 사용법
 * Archify 는 "그림 전체가 한 화면에 들어온다" 를 조건으로 보는데, 이 그림들은 그림 아래 설명 카드가 원래 세로로 스크롤된다
 *   (2026-11-03 경량 2161 · 정식 2913px — issues/20261103-athena-studio-작업-흐름-그림-화면-점검이-세로-스크롤에서-실패.md).
 *   그래서 세로로만 넘친 것(viewer/viewport-overflow 중 overflowX 가 false)만 허용하고, 가로 넘침 · 겹침 · 그 밖의 오류는 그대로 실패다.
 *   Chrome 이 없어 캡처를 못 했으면(skipped) 통과로 세지 않는다 · 결과가 지금 HTML 과 다른 파일 것이면 실패다
 * 서비스 그림(pack/diagrams)은 이 판정을 쓰지 않는다 — Archify 결과 그대로(check-diagrams.mjs --design)
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length || files.some((file) => file.startsWith('--') || !file.endsWith('.html'))) {
  console.error('사용: diagram-visual-judge.mjs <그림.html>…')
  process.exit(2)
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 세로로만 넘친 것 — 이 그림들에서 허용하는 유일한 오류 @param {Record<string, unknown>} diagnostic */
const verticalOnly = (diagnostic) => diagnostic.code === 'viewer/viewport-overflow' && isRecord(diagnostic.evidence) && diagnostic.evidence.overflowX === false

/**
 * @param {string} html
 * @returns {string[]} 실패 이유(비면 통과)
 */
const judge = (html) => {
  /** @type {unknown} */
  let receipt
  try {
    receipt = JSON.parse(readFileSync(html.replace(/\.html$/, '.visual-check.json'), 'utf8'))
  } catch {
    return ['visual-check 결과(.visual-check.json)가 없거나 읽지 못함 — 먼저 archify visual-check 를 돌린다']
  }
  if (!isRecord(receipt) || receipt.command !== 'visual-check' || receipt.evidenceKind !== 'automated-browser') return ['visual-check 결과 모양이 아님']
  const bytes = readFileSync(html)
  const artifact = isRecord(receipt.artifact) ? receipt.artifact : {}
  if (artifact.sha256 !== createHash('sha256').update(bytes).digest('hex') || artifact.bytes !== bytes.length) return ['visual-check 결과가 지금 HTML 것이 아님 — 다시 돌린다']
  const reasons = []
  if (!isRecord(receipt.chrome) || receipt.chrome.status !== 'available') reasons.push('Chrome 이 없어 브라우저 점검을 못 함')
  if (!isRecord(receipt.captures) || receipt.captures.status !== 'pass') reasons.push(`캡처 ${isRecord(receipt.captures) ? String(receipt.captures.status) : '없음'}`)
  const diagnostics = Array.isArray(receipt.diagnostics) ? receipt.diagnostics : []
  for (const diagnostic of diagnostics) {
    if (!isRecord(diagnostic)) reasons.push('모양이 틀린 진단')
    else if (diagnostic.severity === 'error' && !verticalOnly(diagnostic)) reasons.push(`${String(diagnostic.code)} — ${String(diagnostic.message)}`)
  }
  return reasons
}

let failed = 0
for (const html of files) {
  const reasons = judge(html)
  if (reasons.length === 0) {
    console.log(`✅ ${html} — 세로 스크롤 말고는 visual-check 오류 없음(시각 검토는 별도)`)
    continue
  }
  failed += 1
  console.log(`❌ ${html}`)
  for (const reason of reasons) console.log(`   - ${reason}`)
}
process.exit(failed > 0 ? 1 : 0)
