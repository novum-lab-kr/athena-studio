// @ts-check
// PR 자동 리뷰와 학습 검토가 같은 도구 차단·인증·모델 인자를 쓴다.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { codexModelArgs, codexUserSettings } from './pr-auto.mjs'

// Codex 에서 끄는 도구 기능(codex features list 에서 켜져 있던 것 중 도구를 주는 것 — 2026-10-25 · codex-cli 0.160)
export const CODEX_TOOL_FEATURES = [
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'in_app_browser', 'plugins', 'remote_plugin', 'multi_agent', 'image_generation', 'view_image', 'hooks', 'skill_search',
  'skill_mcp_dependency_install', 'tool_suggest', 'code_mode_host', 'sleep_tool', 'goals', 'worktrees', 'in_app_local_automation',
]

export const readCodexSettings = () => {
  try { return codexUserSettings(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8')) } catch { return codexUserSettings('') }
}
/** @param {'claude' | 'codex'} tool */
export const reviewToolState = (tool) => {
  if (spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status !== 0) return 'missing'
  return spawnSync(tool, tool === 'claude' ? ['auth', 'status'] : ['login', 'status'], { stdio: 'ignore', timeout: 30_000 }).status === 0 ? 'ready' : 'logged-out'
}
// Claude 사용량 한도 — claude -p --output-format json 결과로만 가른다(종료 코드는 1 · 다른 실패와 같아 쓰지 않는다).
// 근거: 2026-11-03 PR 235 · 236 · 237 · 238 · 240 자동 리뷰 실행의 Claude 대화 기록(~/.claude/projects · 작업 폴더 athena-pr-auto-claude-*)이
// error "rate_limit" · apiError "usage_limit_reached" · 글 "You've hit your weekly limit · resets 4am (Asia/Seoul)" 였고,
// claude CLI 2.1.318 결과 형식이 is_error · api_error(같은 종류 값 — usage_limit_reached = 계정 · 플랜 사용량 한도)를 싣는다.
// api_error_status(429 등)는 기록에서 확인하지 못해 보지 않는다. JSON 이 아니면 한도로 보지 않는다(일반 실패 그대로)
export const CLAUDE_LIMIT_ERROR = 'usage_limit_reached'
const CLAUDE_LIMIT_TEXT = /^You've hit your .*limit/
/** @param {string} stdout */
export const claudeLimited = (stdout) => {
  try {
    const answer = JSON.parse(String(stdout ?? ''))
    if (!answer || answer.is_error !== true) return false
    return answer.api_error === CLAUDE_LIMIT_ERROR || CLAUDE_LIMIT_TEXT.test(String(answer.result ?? ''))
  } catch { return false }
}

/** @param {string} workDir @param {string} schemaFile @param {string} outFile @param {string} [model] */
export const codexReviewArgs = (workDir, schemaFile, outFile, model = '') => [
  'exec', '--ignore-user-config', ...codexModelArgs({ ...readCodexSettings(), ...(model ? { model } : {}) }),
  ...CODEX_TOOL_FEATURES.flatMap((feature) => ['--disable', feature]),
  '-c', 'web_search="disabled"', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
  '--color', 'never', '--json', '-C', workDir, '--output-schema', schemaFile, '-o', outFile,
]

// 토큰 — 앱 일별 토큰(src/lib/daily-tokens.mts)과 같은 셈: input + cache_creation + output, cache_read 는 뺀다. 없으면 모름(null)
/** @param {string} stdout */
export const claudeTokens = (stdout) => {
  try {
    const usage = JSON.parse(stdout)?.usage
    if (!usage || typeof usage !== 'object') return null
    const count = (/** @type {string} */ key) => (Number.isFinite(usage[key]) ? usage[key] : 0)
    return count('input_tokens') + count('cache_creation_input_tokens') + count('output_tokens')
  } catch { return null }
}

// Codex `exec --json` 의 줄마다 JSON — `turn.completed` 의 usage(2026-11-09 codex-cli 실측: input_tokens · cached_input_tokens · cache_write_input_tokens · output_tokens · reasoning_output_tokens).
// Codex 의 input_tokens 는 cached_input_tokens 를 포함하고 output_tokens 는 reasoning 을 포함한다(codex TokenUsage — non_cached_input) → input - cached + output.
// 위 Claude 셈의 cache_creation 에 해당하는 cache_write_input_tokens 는 input 안에 이미 들어 있어 더하지 않는다. turn 이 여럿이면 합친다 · 하나도 없으면 null
/** @param {string} stdout */
export const codexTokens = (stdout) => {
  let total = null
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.includes('turn.completed')) continue
    try {
      const event = JSON.parse(line)
      const usage = event?.type === 'turn.completed' ? event.usage : null
      if (!usage || typeof usage !== 'object') continue
      const count = (/** @type {string} */ key) => (Number.isFinite(usage[key]) ? usage[key] : 0)
      total = (total ?? 0) + Math.max(0, count('input_tokens') - count('cached_input_tokens')) + count('output_tokens')
    } catch { /* 줄이 JSON 이 아니다 */ }
  }
  return total
}
