#!/usr/bin/env node
// @ts-check
// 대화 원문 찾기 — Claude Code 대화 기록(jsonl)에서 낱말이 든 대목만 짧게 보여 준다
//   압축하면 대화는 요약만 남지만 기록 파일에는 원문이 그대로 남는다. 요약에 없는 사실은 짐작하지 말고 여기서 찾는다
//   기록 파일 경로는 압축 뒤 안내(scripts/hooks/compact-checkpoint.py post)가 알려 준다 — 훅 입력 transcript_path
//   보여 주기 전에 비밀값을 가린다(scripts/lib/mask.mjs maskText — 배우기 검토 · PR 자동 리뷰 · 로그와 같은 기준)
//
// 사용: node scripts/transcript-search.mjs <기록.jsonl> <낱말> [낱말…] [--max 20] [--width 160]
//   낱말이 모두 든 대목만(대소문자 무시) · 맞은 것이 많으면 최근 것 --max 개 · 대목은 첫 낱말 앞뒤 --width 글자
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { maskText } from './lib/mask.mjs'

// 함수 선언이어야 never 로 좁혀진다(화살표 함수는 좁히지 못한다)
/** @returns {never} */
function usage() {
  console.error('사용: node scripts/transcript-search.mjs <기록.jsonl> <낱말> [낱말…] [--max 20] [--width 160]')
  process.exit(2)
}

/** @param {string[]} argv */
const parseArgs = (argv) => {
  const words = []
  let max = 20
  let width = 160
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--max' || arg === '--width') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 1) usage()
      if (arg === '--max') max = value
      else width = value
      index += 1
    } else {
      words.push(arg)
    }
  }
  const [file, ...terms] = words
  if (!file || terms.length === 0) usage()
  return { file, terms: terms.map((term) => term.toLowerCase()), max, width }
}

// 한 줄(기록 한 건)에서 사람이 읽을 글 조각 — 말 · 도구 입력 · 도구 결과. 생각(thinking) · 첨부는 뺀다
/** @param {unknown} content @returns {string[]} */
const pieces = (content) => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'tool_use') return [`[${block.name ?? '도구'}] ${JSON.stringify(block.input ?? {})}`]
    if (block.type === 'tool_result') return pieces(block.content).map((text) => `[결과] ${text}`)
    return []
  })
}

/** @param {string} text @param {string[]} terms @param {number} width */
const snippet = (text, terms, width) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(terms[0] ?? '')
  const start = Math.max(0, at - width)
  const end = Math.min(flat.length, at + (terms[0]?.length ?? 0) + width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

// 기록 시각(UTC)을 이 맥 시각으로 — 리드 기록 · 계획서 시각과 맞춘다
/** @param {number} value */
const pad = (value) => String(value).padStart(2, '0')
/** @param {unknown} value */
const localTime = (value) => {
  const date = new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return '?'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const main = async () => {
  const { file, terms, max, width } = parseArgs(process.argv.slice(2))
  if (!existsSync(file)) {
    console.error(`기록 파일이 없다: ${file}`)
    process.exit(1)
  }
  const hits = []
  let lineNo = 0
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    lineNo += 1
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== 'user' && entry?.type !== 'assistant') continue
    const role = entry.isCompactSummary ? '압축 요약' : entry.type
    for (const text of pieces(entry.message?.content)) {
      const lower = text.toLowerCase()
      if (!terms.every((term) => lower.includes(term))) continue
      hits.push({ lineNo, at: localTime(entry.timestamp), role, text: snippet(text, terms, width) })
    }
  }
  if (hits.length === 0) {
    console.log(`맞는 대목 없음 — 낱말: ${terms.join(' · ')}`)
    return
  }
  const shown = hits.slice(-max)
  if (hits.length > shown.length) console.log(`(맞은 ${hits.length}곳 중 최근 ${shown.length}곳 — 앞 것은 --max 로 늘리거나 낱말을 더해 좁힌다)`)
  for (const hit of shown) console.log(maskText(`#${hit.lineNo} ${hit.at} ${hit.role}: ${hit.text}`))
}

await main()
