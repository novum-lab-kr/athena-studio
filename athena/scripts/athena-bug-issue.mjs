#!/usr/bin/env node
/**
 * 아테나 자체 버그를 어디에 올릴지 정하고, GitHub 이슈 초안 화면을 연다 (docs/issues.md "아테나 자체 이슈").
 *
 *   node scripts/athena-bug-issue.mjs where
 *     → 이 팩에 코어 레포(athena-studio)가 있으면 `board`(현황판 이슈), 없으면 `github`(우리 GitHub 이슈 초안)
 *   node scripts/athena-bug-issue.mjs draft --title <제목> --what <무슨 일> --expected <기대> --steps <재현 절차> [--logs <오류 문구>] [--open]
 *     → 회사 정보를 가린 초안을 출력한다. --open 이면 초안을 채운 GitHub 새 이슈 화면을 scripts/screen open-url 로 연다
 *       (사용자가 화면에서 보고 직접 Submit — gh 로그인 · 권한 불필요, 바로 올리지 않는다). 열기 전에 대화에 초안을 먼저 보여 준다
 *
 * 글은 영어 템플릿(.github/ISSUE_TEMPLATE/bug_report.yml)에 들어가니 영어로 쓰면 좋다(필수 아님).
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { ATHENA_ROOT, loadConfig, paths } from './lib/config.mjs'
import { versionInfo } from './lib/bodies.mjs'
import { openUrlSync } from './lib/screen.mjs'
import { buildDraft, hasStudioRepo, redact } from './lib/athena-bug-issue.mjs'

const [command, ...rest] = process.argv.slice(2)
const option = (name) => {
  const index = rest.indexOf(`--${name}`)
  return index >= 0 ? rest[index + 1] ?? '' : ''
}

const run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

const realpathOr = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const config = loadConfig(ATHENA_ROOT)

if (command === 'where') {
  console.log(hasStudioRepo(config) ? 'board' : 'github')
  process.exit(0)
}

if (command !== 'draft') {
  console.error('사용: node scripts/athena-bug-issue.mjs where | draft --title … --what … --expected … --steps … [--logs …] [--open]')
  process.exit(2)
}
if (hasStudioRepo(config)) {
  console.error('이 팩에는 코어 레포(athena-studio)가 있다 — 현황판 이슈로 올린다(docs/issues.md). 이 초안 화면은 그 레포가 없는 팩만 쓴다')
  process.exit(3)
}

const where = paths(ATHENA_ROOT)
const scrub = {
  names: [
    ...config.repos.flatMap((repo) => [repo.name, repo.displayName, ...(repo.agents ?? [])]),
    config.company, config.name, where.packId, process.env.USER,
  ],
  paths: [ATHENA_ROOT, where.packDir, where.packData, where.packDataReal, where.dataDir, homedir()].flatMap((path) => (path ? [path, realpathOr(path)] : [])),
}
const clean = (text) => redact(text, scrub)

let version = ''
try {
  version = versionInfo(ATHENA_ROOT).version ?? ''
} catch {
  version = ''
}
const chip = run('uname', ['-m']) === 'arm64' ? 'Apple Silicon' : run('uname', ['-m']) ? 'Intel' : ''
const macos = run('sw_vers', ['-productVersion'])

const title = clean(option('title')).trim()
const draft = buildDraft({
  title,
  fields: {
    'what-happened': clean(option('what')),
    expected: clean(option('expected')),
    steps: clean(option('steps')),
    'app-version': version,
    'macos-version': macos ? `macOS ${macos}` : '',
    chip,
    logs: clean(option('logs')),
  },
})

console.log(JSON.stringify({ title: draft.title, fields: draft.fields, truncated: draft.truncated, urlLength: draft.url.length }, null, 2))
if (rest.includes('--open')) {
  openUrlSync(draft.url)
  console.log('GitHub 새 이슈 화면을 열었다 — 내용을 보고 직접 Submit 한다')
}
