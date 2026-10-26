// main 에 머지된 커밋에 버전 태그 vX.Y.Z 를 달고 GitHub Release 를 만든다(결정 D2 · D4) — .github/workflows/release.yml 이 부른다.
// 사람이 GitHub 에서 머지해도 · 자동 머지 흐름이 머지해도 같은 push → main 이라 똑같이 걸린다. main 에 파일을 고치는 커밋은 만들지 않는다.
//   node scripts/release-version.js [--sha <커밋>] [--dry-run]
//     기준: 가장 높은 v* 태그(없으면 package.json version) · 올리기: 그 커밋의 PR 제목(gh api · 못 찾으면 커밋 제목) — src/lib/version.js
//     이미 v* 태그가 그 커밋에 있으면 아무것도 하지 않는다(같은 커밋에 두 번 걸려도 태그는 하나)
//     --dry-run: 무엇을 할지만 찍는다(태그 · Release 를 만들지 않는다)
// 필요: git(태그까지 받은 체크아웃 — fetch-depth: 0) · gh(GH_TOKEN) · GITHUB_REPOSITORY(owner/name)
const path = require('path')
const { execFileSync } = require('child_process')
const version = require('../src/lib/version')

const ROOT = path.join(__dirname, '..')

function run(file, args, options = {}) {
  return String(execFileSync(file, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }) || '').trim()
}

function argValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || '' : ''
}

// 그 커밋을 만든 PR — { title, number, url } · 못 찾으면 null(gh 가 없거나 API 실패)
function pullRequestOf(repository, sha) {
  if (!repository) return null
  try {
    const list = JSON.parse(run('gh', ['api', `repos/${repository}/commits/${sha}/pulls`]))
    const merged = (Array.isArray(list) ? list : []).find((pull) => pull && pull.merged_at) || null
    return merged ? { title: String(merged.title || ''), number: merged.number, url: merged.html_url || null } : null
  } catch {
    return null
  }
}

function main(args) {
  const dryRun = args.includes('--dry-run')
  const sha = run('git', ['rev-parse', '--verify', `${argValue(args, '--sha') || process.env.GITHUB_SHA || 'HEAD'}^{commit}`])
  const repository = process.env.GITHUB_REPOSITORY || ''
  const already = version.latestTag(run('git', ['tag', '--points-at', sha, '--list', version.TAG_PATTERN]).split('\n').filter(Boolean))
  if (already) {
    console.log(`이미 태그가 있어요 — v${already} (${sha.slice(0, 7)})`)
    return
  }
  const tags = run('git', ['tag', '--list', version.TAG_PATTERN]).split('\n').filter(Boolean)
  const base = version.latestTag(tags) || require(path.join(ROOT, 'package.json')).version
  if (!version.parseVersion(base)) throw new Error(`기준 버전을 읽지 못했어요: ${base}`)
  const pull = pullRequestOf(repository, sha)
  const title = pull ? pull.title : run('git', ['log', '-1', '--format=%s', sha])
  const next = version.nextVersion(base, title)
  const commitUrl = repository ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repository}/commit/${sha}` : null
  const notes = version.releaseNotes(pull ? pull : { title, url: commitUrl })
  console.log(`v${base} → v${next} (${version.bumpKind(title)}) · ${sha.slice(0, 7)} · ${title}`)
  if (dryRun) {
    console.log(notes)
    return
  }
  // 태그 · Release 를 한 번에 — gh 가 그 커밋(--target)에 태그를 만든다
  run('gh', ['release', 'create', `v${next}`, '--target', sha, '--title', `v${next}`, '--notes', notes], { stdio: ['ignore', 'inherit', 'inherit'] })
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(`[release-version] ${error.message}`)
  process.exit(1)
}
