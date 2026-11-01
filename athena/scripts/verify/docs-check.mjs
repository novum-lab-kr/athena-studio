#!/usr/bin/env node
// 문서만 고친 수정의 파일 점검 — _lib.sh 의 verify_docs_finish 가 부른다.
//   node docs-check.mjs <트리 맨 위> <바뀐 파일 목록 파일(한 줄에 하나, 트리 기준 상대 경로)>
// 시험·빌드를 건너뛰는 대신 파일이 깨지지 않았는지만 본다: 읽을 수 있는지 · UTF-8 인지 · NUL 바이트 · 합치다 남은 충돌 표시(<<<<<<< · >>>>>>>)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [top, listFile] = process.argv.slice(2)
if (!top || !listFile) { console.error('사용: docs-check.mjs <트리> <목록 파일>'); process.exit(2) }

const files = readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
const decoder = new TextDecoder('utf-8', { fatal: true })
const problems = []
for (const file of files) {
  let bytes
  try { bytes = readFileSync(join(top, file)) } catch (error) { problems.push(`${file}: 읽지 못함 (${error.code ?? error.message})`); continue }
  if (bytes.includes(0)) { problems.push(`${file}: NUL 바이트가 들어 있음`); continue }
  let text
  try { text = decoder.decode(bytes) } catch { problems.push(`${file}: UTF-8 이 아님`); continue }
  const marker = text.split('\n').findIndex((line) => /^(<{7}|>{7})( |$)/.test(line))
  if (marker >= 0) problems.push(`${file}:${marker + 1}: 합치다 남은 충돌 표시`)
}
if (problems.length > 0) { console.log(problems.join('\n')); process.exit(1) }
console.log(`문서 ${files.length}개 정상 (읽기 · UTF-8 · NUL · 충돌 표시)`)
