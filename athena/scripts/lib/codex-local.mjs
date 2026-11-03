// @ts-check
// Codex 0.166 로컬 기록. 대화는 이 컴퓨터의 rollout만 확인하고 백업에서 이식하지 않는다.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex')

/** @param {string} session @param {string} [home] */
export const codexSessionExists = (session, home = codexHome()) => {
  if (!/^[0-9a-f][0-9a-f-]{7,63}$/i.test(session)) return false
  /** @param {string} dir @returns {boolean} */
  const find = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).some((entry) => {
        if (entry.isDirectory()) return find(join(dir, entry.name))
        return entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${session}.jsonl`)
      })
    } catch { return false }
  }
  return existsSync(join(home, 'sessions')) && find(join(home, 'sessions'))
}
