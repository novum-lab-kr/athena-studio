// @ts-check
// 팩 ROUTING.md 의 레포 줄 — 첫 실행(init.mjs routingDoc)이 만들고, 뒤에 더하고 빼는 레포(bin/athena repo add · remove)가 같은 모양으로 맞춘다.
//   repoRows       "1. 담당 레포와 기준 브랜치" 표의 그 레포 줄(모노레포는 앱마다 + packages/*)
//   verifyLine     "4. 검증 스크립트" 목록의 그 레포 줄
//   addRepoRouting · removeRepoRouting  있는 ROUTING.md 의 두 자리만 고친다 — 사람이 채운 다른 줄 · 절은 그대로. 절 · 표 · 목록이 없으면 그 자리는 건너뛴다
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {{ agent?: string, branch?: string }} AppSpec
 * @typedef {{ name: string, kind?: string, branch?: string, layer?: string, agents?: string[], apps?: Record<string, AppSpec>, packagesAgent?: string }} RepoEntry
 */

/** @param {RepoEntry} repo @returns {string[]} */
export const repoRows = (repo) => {
  if (repo.kind === 'monorepo') {
    return [
      ...Object.entries(repo.apps ?? {}).map(([app, spec]) => `| \`repos/${repo.name}/apps/${app}\` | \`${spec.agent ?? ''}\` | 확인 필요 | \`origin/${spec.branch ?? repo.branch ?? ''}\` |`),
      `| \`repos/${repo.name}/packages/*\` | \`${repo.packagesAgent ?? ''}\` | 공통 패키지 | \`origin/${repo.branch ?? ''}\` |`,
    ]
  }
  return [`| \`repos/${repo.name}\` | ${(repo.agents ?? []).map((agent) => `\`${agent}\``).join(' · ')} | ${repo.layer === 'be' ? '**백엔드** ' : ''}확인 필요 | \`origin/${repo.branch ?? ''}\` |`]
}

/** @param {RepoEntry} repo */
export const verifyLine = (repo) => `scripts/verify/${repo.name}.sh${repo.kind === 'monorepo' ? ' <앱>' : ''}`

// 절 [머리, 끝) — 머리는 맞는 "## " 줄, 끝은 다음 "## " 줄(없으면 문서 끝). 없으면 null
/** @param {string[]} lines @param {(line: string) => boolean} isHead @returns {[number, number] | null} */
const section = (lines, isHead) => {
  const head = lines.findIndex((line) => line.startsWith('## ') && isHead(line))
  if (head < 0) return null
  const next = lines.findIndex((line, index) => index > head && line.startsWith('## '))
  return [head, next < 0 ? lines.length : next]
}
/** @param {string} line */
const isTableHead = (line) => /^## 1\.\s/.test(line)
/** @param {string} line */
const isVerifyHead = (line) => line.includes('검증 스크립트')
/** @param {string} name */
const rowOf = (name) => (/** @type {string} */ line) => line.startsWith(`| \`repos/${name}\` |`) || line.startsWith(`| \`repos/${name}/`)
/** @param {string} name */
const verifyOf = (name) => (/** @type {string} */ line) => line === `scripts/verify/${name}.sh` || line.startsWith(`scripts/verify/${name}.sh `)

// 검증 목록 — 절 안 첫 코드 블록의 [여는 줄, 닫는 줄]. 없으면 null
/** @param {string[]} lines @param {[number, number]} range @returns {[number, number] | null} */
const fence = (lines, [head, end]) => {
  const open = lines.findIndex((line, index) => index > head && index < end && line.startsWith('```'))
  if (open < 0) return null
  const close = lines.findIndex((line, index) => index > open && index < end && line.startsWith('```'))
  return close < 0 ? null : [open, close]
}

/** @param {string} packDir @param {(lines: string[]) => string[]} change @returns {boolean} 고쳤으면 true */
const editRouting = (packDir, change) => {
  const file = join(packDir, 'ROUTING.md')
  if (!existsSync(file)) return false
  const before = readFileSync(file, 'utf8')
  const after = change(before.split('\n')).join('\n')
  if (after === before) return false
  writeFileSync(file, after)
  return true
}

// 레포 하나 더하기 — 표 끝 · 검증 목록 끝에 그 레포 줄. 이미 그 레포 줄이 있으면 그 자리는 그대로
/** @param {string} packDir @param {RepoEntry} repo */
export const addRepoRouting = (packDir, repo) => editRouting(packDir, (lines) => {
  const kept = [...lines]
  const table = section(kept, isTableHead)
  if (table && !kept.slice(table[0], table[1]).some(rowOf(repo.name))) {
    let at = -1
    for (let index = table[0] + 1; index < table[1]; index += 1) if ((kept[index] ?? '').startsWith('|')) at = index + 1
    if (at > 0) kept.splice(at, 0, ...repoRows(repo))
  }
  const verify = section(kept, isVerifyHead)
  const block = verify && fence(kept, verify)
  if (block && !kept.slice(block[0] + 1, block[1]).some(verifyOf(repo.name))) kept.splice(block[1], 0, verifyLine(repo))
  return kept
})

// 레포 하나 빼기 — 두 자리에서 그 레포 줄만 지운다(다른 절의 같은 이름 줄 — 서버 절 등 — 은 그대로)
/** @param {string} packDir @param {string} name */
export const removeRepoRouting = (packDir, name) => editRouting(packDir, (lines) => {
  /** @type {Set<number>} */
  const drop = new Set()
  const table = section(lines, isTableHead)
  if (table) for (let index = table[0] + 1; index < table[1]; index += 1) if (rowOf(name)(lines[index] ?? '')) drop.add(index)
  const verify = section(lines, isVerifyHead)
  const block = verify && fence(lines, verify)
  if (block) for (let index = block[0] + 1; index < block[1]; index += 1) if (verifyOf(name)(lines[index] ?? '')) drop.add(index)
  return lines.filter((_line, index) => !drop.has(index))
})
