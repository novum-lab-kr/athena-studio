// @ts-check
// 본체별 주 도구. 앱 · 현황판 · pr-auto 는 이 모듈을 공유한다.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/** @typedef {'claude' | 'codex'} Tool */
/** @type {Tool[]} */
export const TOOLS = ['claude', 'codex']
/** @param {string} root */
export function readMainTool(root) {
  try {
    const saved = JSON.parse(readFileSync(join(root, '.athena-main-tool.json'), 'utf8'))
    return TOOLS.includes(saved.main) ? /** @type {Tool} */ (saved.main) : null
  } catch { return null }
}
/** @param {string} root @param {Tool} main */
export function writeMainTool(root, main) {
  if (!TOOLS.includes(main)) throw new Error('Invalid main tool')
  const file = join(root, '.athena-main-tool.json')
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ main }) + '\n', { mode: 0o600 })
  renameSync(temp, file)
}
/** 출력에는 인증 정보가 있을 수 있다. 파이프에도 담지 않고 버린다.
 * @param {string} executable @param {Tool} tool @param {NodeJS.ProcessEnv} env
 * @returns {Promise<boolean>} */
export function authenticated(executable, tool, env) {
  return new Promise((resolve) => {
    const child = spawn(executable, tool === 'claude' ? ['auth', 'status'] : ['login', 'status'],
      { env, stdio: 'ignore', timeout: 10000 })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}
/** 설치·로그인된 도구에서만 주/부 도구를 정한다. 저장한 도구가 없어졌으면 남은 하나로.
 * @param {Tool[]} available @param {Tool | null} remembered */
export function toolDecision(available, remembered = null) {
  const main = available.length === 1 ? available[0] : remembered && available.includes(remembered) ? remembered : null
  return { main: main || null, secondary: main ? available.find((tool) => tool !== main) || null : null,
    choose: available.length > 1 && !main }
}
