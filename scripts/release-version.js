// main 에 머지된 커밋에 버전 태그 vX.Y.Z 를 달고 GitHub Release 를 만든다(결정 D2 · D4) — .github/workflows/release.yml 이 부른다.
// 사람이 GitHub 에서 머지해도 · 자동 머지 흐름이 머지해도 같은 push → main 이라 똑같이 걸린다. main 에 파일을 고치는 커밋은 만들지 않는다.
//   node scripts/release-version.js [--sha <커밋>] [--dry-run]
//     그 커밋까지 아직 태그가 없는 main 커밋(first-parent)을 오래된 순으로 모두 처리한다 — 머지가 몰려 앞 실행이 취소돼도
//     (워크플로 concurrency 는 대기 실행을 하나만 남긴다) 다음 실행이 빠진 커밋을 차례로 채운다. 커밋마다 자기 PR 제목으로 올린다
//     기준: 그 커밋에서 닿는 가장 높은 v* 태그 · 태그가 하나도 없으면 package.json version 에서 그 커밋 하나만(옛 기록 전체에 달지 않는다)
//     올리기: PR 제목(gh api · 못 찾으면 커밋 제목) — src/lib/version.js
//     이미 v* 태그가 있는 커밋은 건너뛴다(같은 커밋에 두 번 걸려도 태그는 하나)
//     --dry-run: 무엇을 할지만 찍는다(태그 · Release 를 만들지 않는다)
// 필요: git(태그까지 받은 체크아웃 — fetch-depth: 0 · 지금 폴더) · gh(GH_TOKEN) · GITHUB_REPOSITORY(owner/name)
const path = require('path')
const { execFileSync } = require('child_process')
const version = require('../src/lib/version')

const ROOT = path.join(__dirname, '..')

function run(file, args, options = {}) {
  return String(execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }) || '').trim()
}

const lines = (text) => text.split('\n').filter(Boolean)

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

// → { base, commits: [sha…](오래된 순) } — 기준 태그 뒤 main 커밋 중 태그가 없는 것
function pending(sha) {
  const base = version.latestTag(lines(run('git', ['tag', '--merged', sha, '--list', version.TAG_PATTERN])))
  if (!base) return { base: require(path.join(ROOT, 'package.json')).version, commits: [sha] }
  const range = lines(run('git', ['rev-list', '--first-parent', '--reverse', `v${base}..${sha}`]))
  return { base, commits: range.filter((commit) => !lines(run('git', ['tag', '--points-at', commit, '--list', version.TAG_PATTERN])).length) }
}

function main(args) {
  const dryRun = args.includes('--dry-run')
  const sha = run('git', ['rev-parse', '--verify', `${argValue(args, '--sha') || process.env.GITHUB_SHA || 'HEAD'}^{commit}`])
  const repository = process.env.GITHUB_REPOSITORY || ''
  const already = version.latestTag(lines(run('git', ['tag', '--points-at', sha, '--list', version.TAG_PATTERN])))
  if (already) {
    console.log(`이미 태그가 있어요 — v${already} (${sha.slice(0, 7)})`)
    return
  }
  const { base, commits } = pending(sha)
  if (!version.parseVersion(base)) throw new Error(`기준 버전을 읽지 못했어요: ${base}`)
  const details = commits.map((commit) => {
    const pull = pullRequestOf(repository, commit)
    const title = pull ? pull.title : run('git', ['log', '-1', '--format=%s', commit])
    const commitUrl = repository ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repository}/commit/${commit}` : null
    return { sha: commit, title, notes: version.releaseNotes(pull || { title, url: commitUrl }) }
  })
  let previous = base
  for (const entry of version.releasePlan(base, details)) {
    console.log(`v${previous} → v${entry.version} (${entry.kind}) · ${entry.sha.slice(0, 7)} · ${entry.title}`)
    previous = entry.version
    if (dryRun) continue
    // 태그 · Release 를 한 번에 — gh 가 그 커밋(--target)에 태그를 만든다. 실패하면 멈춘다(다음 실행이 이 커밋부터 다시)
    run('gh', ['release', 'create', `v${entry.version}`, '--target', entry.sha, '--title', `v${entry.version}`, '--notes', entry.notes], { stdio: ['ignore', 'inherit', 'inherit'] })
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(`[release-version] ${error.message}`)
  process.exit(1)
}
