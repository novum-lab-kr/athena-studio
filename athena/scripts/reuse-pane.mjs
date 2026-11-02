// @ts-check
// 같은 레포 담당 에이전트 pane 이 쉬는 중이면 새 pane 대신 그 pane 에 이어 보내려고 고른다(docs/dispatch.md "이어 보내기").
//
// 사용: node scripts/reuse-pane.mjs --agent <에이전트>     → 쓸 수 있으면 {"pane","cwd","branch","mainCheckout"} 한 줄 + exit 0 · 없으면 이유를 stderr 에 쓰고 exit 1
//   cwd = pane 이 실제로 일하는 폴더(foreground_cwd — 앞쪽 프로세스 폴더 · 없으면 처음 연 폴더 cwd).
//   새 workspace 의 첫 pane 은 처음 연 폴더가 메인 체크아웃이고 실행기가 워크트리로 cd 해서, cwd 만 보면 메인 체크아웃에 새 브랜치를 땄다(2026-11-02)
//   mainCheckout = 그 폴더가 레포 메인 체크아웃인가(워크트리 아님) — delegate.sh --new-branch 가 보고 거부한다
// 고르는 기준(모두 맞아야 한다 — 하나라도 모르면 재사용하지 않고 새로 띄운다):
//   - 이름표가 '🤖 <에이전트>' 로 시작하는 claude pane (delegate.sh 가 붙인 이름 — 에이전트는 레포마다 하나라 같은 레포다)
//   - agent_status 가 idle (일하는 중 · 입력 대기 · 모름은 제외)
//   - 사용자가 보고 있지 않다(focused 가 명시적으로 false — 필드가 없으면 모르니 제외) — 쓰던 입력에 끼어들지 않게
//   - 화면 끝에 질문 · 고르기 창이 없다(pane-delivery.mjs menuOpen — 데몬 idle 은 질문 기다리는 것도 idle 로 본다)
//   - 화면을 읽을 수 있다(못 읽으면 창 여부를 모르니 제외)
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMainModule } from './lib/is-main.mjs'
import { fileURLToPath } from 'node:url'
import { dispatchEngine } from './dispatch-engine.mjs'
import { menuOpen } from './board/pane-delivery.mjs'

/**
 * @typedef {{ id: string, label?: string | null, name?: string | null, pane_title?: string | null, agent?: string | null, agent_status?: string | null, cwd?: string | null, foreground_cwd?: string | null, focused?: boolean }} ScreenPane
 */

/**
 * 그 폴더가 레포 메인 체크아웃인가 — git 폴더와 공용 git 폴더가 같으면 메인 체크아웃(워크트리는 .git/worktrees/<이름>). git 레포가 아니면 false
 * @param {string} dir
 * @returns {boolean}
 */
export const isMainCheckout = (dir) => {
  try {
    const [gitDir, commonDir] = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')
    return Boolean(gitDir) && gitDir === commonDir
  } catch {
    return false
  }
}

/**
 * 재사용할 pane 하나와 그 작업 폴더(없으면 이유) — 순수 함수라 화면 없이 시험한다
 * @param {ScreenPane[]} panes 화면 pane 목록
 * @param {string} agentName 에이전트 이름
 * @param {(paneId: string) => string | null} readText pane 화면 글(못 읽으면 null)
 * @param {string} engine 엔진(claude · codex)
 * @param {string} role 역할(agent · reviewer) — reviewer 는 재사용하지 않는다
 * @returns {{ pane: ScreenPane, cwd: string } | { reason: string }}
 */
export const pickReusable = (panes, agentName, readText, engine = "claude", role = "agent") => {
  const mine = panes.filter((pane) => {
    const name = pane.label || pane.name || pane.pane_title || ''
    const match = name.match(/^🤖\s*(\S+)/)
    return pane.agent === engine && match?.[1] === agentName && role === 'agent'
  })
  if (!mine.length) return { reason: `쉬는 ${agentName} pane 이 없다` }
  const skipped = []
  for (const pane of mine) {
    if (pane.agent_status !== 'idle') { skipped.push(`${pane.id}: ${pane.agent_status || '상태 모름'}`); continue }
    if (pane.focused !== false) { skipped.push(`${pane.id}: 사용자가 보고 있거나 모름`); continue }
    const cwd = pane.foreground_cwd || pane.cwd
    if (!cwd || !existsSync(cwd)) { skipped.push(`${pane.id}: 작업 폴더를 모름`); continue }
    const text = readText(pane.id)
    if (text === null) { skipped.push(`${pane.id}: 화면을 읽지 못함`); continue }
    // 옛 데몬은 Codex 의 승인·훅 신뢰·모델 선택 창도 idle 로 볼 수 있다. 글+Enter 가 선택지를 누르지 않게 막는다.
    const codexMenu = engine === 'codex' && /(?:press )?enter (?:to (?:confirm|select)|confirm)|esc (?:to )?(?:cancel|skip)|Hooks need review|Would you like to run|Select (?:model|reasoning)/i.test(text.split('\n').slice(-16).join('\n'))
    if (menuOpen(text) || codexMenu) { skipped.push(`${pane.id}: 질문 창이 떠 있음`); continue }
    return { pane, cwd }
  }
  return { reason: skipped.join(' · ') }
}

const here = dirname(fileURLToPath(import.meta.url))
const screen = (/** @type {string[]} */ args) => execFileSync(join(here, 'screen'), args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })

if (isMainModule(import.meta.url)) {
  const index = process.argv.indexOf('--agent')
  const agentName = index > 0 ? process.argv[index + 1] : ''
  if (!agentName) { console.error('사용: node scripts/reuse-pane.mjs --agent <에이전트>'); process.exit(2) }
  const option = (/** @type {string} */ name, /** @type {string} */ fallback) => {
    const at = process.argv.indexOf(name)
    return at < 0 ? fallback : process.argv[at + 1] || ''
  }
  let engine = option('--engine', '')
  const role = option('--role', 'agent')
  if (!engine) {
    try { engine = await dispatchEngine(join(here, '..')) }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2) }
  }
  if (!['claude', 'codex'].includes(engine) || !['agent', 'reviewer'].includes(role)) { console.error('엔진·역할 값이 이상하다'); process.exit(2) }
  try {
    /** @type {ScreenPane[]} */
    const panes = JSON.parse(screen(['pane', 'list', '--agent-only'])).panes ?? []
    const picked = pickReusable(panes, agentName, (paneId) => {
      try { return screen(['pane', 'read', paneId, '--lines', '40']) } catch { return null }
    }, engine, role)
    if ('reason' in picked) { console.error(picked.reason); process.exit(1) }
    const branch = (() => { try { return execFileSync('git', ['-C', picked.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return '' } })()
    console.log(JSON.stringify({ pane: picked.pane.id, cwd: picked.cwd, branch, mainCheckout: isMainCheckout(picked.cwd), engine, role }))
  } catch {
    console.error('화면 pane 목록을 읽지 못했다')
    process.exit(1)
  }
}
