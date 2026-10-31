// @ts-check
// 레포 규칙 문서 찾기 — 찾는 규칙은 scripts/lib/rule_docs.py 한 곳이다. init · sync-fingerprint 가 이걸로 부른다.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'rule_docs.py')

/**
 * @param {string} tree 레포 폴더
 * @param {{ ref?: string, dirs?: string[], add?: unknown[], exclude?: unknown[] }} [options] ref 가 있으면 작업 트리 대신 그 ref 를 읽는다
 * @returns {{ docs: string[], auto: string[], missing: string[], refused: string[] } | null} python 이 없거나 실패하면 null(부르는 쪽이 경고만 낸다)
 */
export const listRuleDocs = (tree, { ref, dirs = [''], add = [], exclude = [] } = {}) => {
  const args = [SCRIPT, 'list', tree, ...(ref ? ['--ref', ref] : []), '--json', JSON.stringify({ dirs, add, exclude })]
  try {
    return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }))
  } catch {
    return null
  }
}

/**
 * 팩에 적을 목록 — 실을 것 + Claude Code 가 스스로 싣는 것(도구마다 싣는 게 달라 둘 다 적는다)
 * @param {{ docs: string[], auto: string[] }} found
 * @returns {string[]}
 */
export const ruleDocList = (found) => [...new Set([...found.docs, ...found.auto])].sort()
