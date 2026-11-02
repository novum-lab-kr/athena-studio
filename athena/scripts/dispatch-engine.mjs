// @ts-check
// 주 도구 기록과 설치·로그인 상태로 위임 엔진을 고른다. 역할·모델은 별도로 정한다.
import { authenticated, readMainTool, toolDecision, TOOLS } from './lib/main-tool.mjs'
import { isMainModule } from './lib/is-main.mjs'

/** @param {string} root @param {string} requested */
export async function dispatchEngine(root, requested = '') {
  if (requested && !TOOLS.includes(/** @type {'claude' | 'codex'} */ (requested))) throw new Error('--engine 은 claude · codex 만 쓴다')
  const candidates = requested ? TOOLS.filter((tool) => tool === requested) : TOOLS
  const ready = await Promise.all(candidates.map((tool) => authenticated(tool, tool, process.env)))
  const available = candidates.filter((_, index) => ready[index])
  // 업데이트 뒤 아직 주 도구 기록이 없는 본체는 기존 Claude 우선 동작을 유지한다.
  // 실제 주 도구 기록은 SessionStart 몫이며, 위임만으로 기록을 새로 쓰지 않는다.
  const decision = toolDecision(available, readMainTool(root) ?? 'claude')
  if (!decision.main) throw new Error('설치·로그인된 위임 도구가 없다')
  return decision.main
}

if (isMainModule(import.meta.url)) {
  try { console.log(await dispatchEngine(process.argv[2] || '.', process.argv[3] || '')) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2 }
}
