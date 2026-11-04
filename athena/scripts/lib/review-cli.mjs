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
  '--color', 'never', '-C', workDir, '--output-schema', schemaFile, '-o', outFile,
]

/** 공개 모델 목록만 읽는다. 사용자 설정과 모델의 설명·지시문은 출력하지 않는다.
 * @returns {{ models: string[], reason: string }} */
export const codexReviewModels = () => {
  const result = spawnSync('codex', ['debug', 'models'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
  if (result.status !== 0) return { models: [], reason: 'Codex 모델 목록을 읽지 못함' }
  try {
    const catalog = JSON.parse(result.stdout)
    if (!Array.isArray(catalog.models)) throw new Error('목록 형식')
    const models = catalog.models.filter((/** @type {{visibility?: unknown, slug?: unknown}} */ model) => model?.visibility === 'list' && typeof model.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(model.slug))
      .map((/** @type {{slug: string}} */ model) => model.slug)
    return { models, reason: models.length ? '' : 'Codex 공개 모델 목록이 비어 있음' }
  } catch { return { models: [], reason: 'Codex 모델 목록 형식이 올바르지 않음' } }
}
