// @ts-check
// 같은 레포 담당 에이전트 pane 이 쉬는 중이면 새 pane 대신 그 pane 에 이어 보내려고 고른다(docs/dispatch.md "이어 보내기").
//
// 사용: node scripts/reuse-pane.mjs --agent <에이전트>     → 쓸 수 있으면 {"pane","cwd","branch"} 한 줄 + exit 0 · 없으면 이유를 stderr 에 쓰고 exit 1
// 고르는 기준(모두 맞아야 한다 — 하나라도 모르면 재사용하지 않고 새로 띄운다):
//   - 이름표가 '🤖 <에이전트>' 로 시작하는 claude pane (delegate.sh 가 붙인 이름 — 에이전트는 레포마다 하나라 같은 레포다)
//   - agent_status 가 idle (일하는 중 · 모름은 제외)
//   - 사용자가 보고 있지 않다(focused 아님) — 쓰던 입력에 끼어들지 않게
//   - 화면 끝에 질문 · 고르기 창이 없다(pane-delivery.mjs menuOpen — 데몬 idle 은 질문 기다리는 것도 idle 로 본다)
//   - 화면을 읽을 수 있다(못 읽으면 창 여부를 모르니 제외)
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { menuOpen } from './board/pane-delivery.mjs'

/**
 * @typedef {{ id: string, label?: string | null, name?: string | null, pane_title?: string | null, agent?: string | null, agent_status?: string | null, cwd?: string | null, focused?: boolean }} ScreenPane
 */

/**
 * 재사용할 pane 하나(없으면 이유) — 순수 함수라 화면 없이 시험한다
 * @param {ScreenPane[]} panes 화면 pane 목록
 * @param {string} agentName 에이전트 이름
 * @param {(paneId: string) => string | null} readText pane 화면 글(못 읽으면 null)
 * @returns {{ pane: ScreenPane } | { reason: string }}
 */
export const pickReusable = (panes, agentName, readText) => {
  const mine = panes.filter((pane) => {
    const name = pane.label || pane.name || pane.pane_title || ''
    const match = name.match(/^🤖\s*(\S+)/)
    return pane.agent === 'claude' && match?.[1] === agentName
  })
  if (!mine.length) return { reason: `쉬는 ${agentName} pane 이 없다` }
  const skipped = []
  for (const pane of mine) {
    if (pane.agent_status !== 'idle') { skipped.push(`${pane.id}: ${pane.agent_status || '상태 모름'}`); continue }
    if (pane.focused) { skipped.push(`${pane.id}: 사용자가 보고 있음`); continue }
    if (!pane.cwd || !existsSync(pane.cwd)) { skipped.push(`${pane.id}: 작업 폴더를 모름`); continue }
    const text = readText(pane.id)
    if (text === null) { skipped.push(`${pane.id}: 화면을 읽지 못함`); continue }
    if (menuOpen(text)) { skipped.push(`${pane.id}: 질문 창이 떠 있음`); continue }
    return { pane }
  }
  return { reason: skipped.join(' · ') }
}

const here = dirname(fileURLToPath(import.meta.url))
const screen = (/** @type {string[]} */ args) => execFileSync(join(here, 'screen'), args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const index = process.argv.indexOf('--agent')
  const agentName = index > 0 ? process.argv[index + 1] : ''
  if (!agentName) { console.error('사용: node scripts/reuse-pane.mjs --agent <에이전트>'); process.exit(2) }
  try {
    /** @type {ScreenPane[]} */
    const panes = JSON.parse(screen(['pane', 'list', '--agent-only'])).panes ?? []
    const picked = pickReusable(panes, agentName, (paneId) => {
      try { return screen(['pane', 'read', paneId, '--lines', '40']) } catch { return null }
    })
    if ('reason' in picked) { console.error(picked.reason); process.exit(1) }
    const branch = (() => { try { return execFileSync('git', ['-C', picked.pane.cwd ?? '', 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return '' } })()
    console.log(JSON.stringify({ pane: picked.pane.id, cwd: picked.pane.cwd, branch }))
  } catch {
    console.error('화면 pane 목록을 읽지 못했다')
    process.exit(1)
  }
}
