// @ts-check
// 맥 배포판을 공개 레포(novum-lab-kr/athena-studio-releases)에 올린다 — 로컬에서 사용자 gh 로그인으로(토큰 Secret 을 두지 않는다 · 계획서 Decisions)
//   node scripts/publish-release.js --run <release-mac 실행 id> [--dry-run]
//   node scripts/publish-release.js --from <이미 받은 artifact 폴더> [--dry-run]
//     1. 실행 확인 — release-mac 워크플로 · main · 끝남 · 성공(--run 일 때)
//     2. artifact Athena-Studio-mac 받기(gh run download) → .dmg 2 · .zip 2 · latest.json · release-notes.md
//     3. 다시 확인 — 이름 · 크기 · sha256 을 latest.json 과 맞추고 version · date · minMacOS 모양
//     4. 공개 레포에 같은 태그(Release · 초안 · git 태그)가 이미 있으면 멈춘다 — 덮지 않는다
//     5. --dry-run 이면 여기까지 하고 올릴 명령만 찍는다
//     6. gh release create v<버전> --draft(파일 5개 · 본문 release-notes.md) → 다 올라가면 공개 · --latest
//        (중간에 끊겨도 releases/latest 가 반쪽 Release 를 가리키지 않게. 남은 초안은 찍어 주는 명령으로 지운 뒤 다시)
//     7. 고정 주소 확인 — releases/latest/download/<.dmg> 가 받아지고 latest.json 이 이번 버전(계획서 7절)
// gh 는 셸을 거치지 않고 부른다. 순수 부분(checkRun · checkFiles · createArgs)은 test/publish-release.test.js
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const files = require('./release-files')
const packageMac = require('./package-mac')

const SOURCE_REPO = 'novum-lab-kr/athena-studio'
const RELEASES_REPO = 'novum-lab-kr/athena-studio-releases'
const WORKFLOW = 'release-mac'
const ARTIFACT = 'Athena-Studio-mac'
const MANIFEST = 'latest.json'
const NOTES = 'release-notes.md'

/** @typedef {{ status?: string, conclusion?: string, workflowName?: string, headBranch?: string }} RunInfo */
/** @typedef {{ name: string, exists: boolean, size?: number, sha256?: string }} Measured */

// 올려도 되는 실행인지 — 아니면 이유
/** @param {RunInfo} run */
function checkRun(run) {
  if (run.workflowName !== WORKFLOW) return `${WORKFLOW} 실행이 아니다(${run.workflowName || '알 수 없음'})`
  if (run.headBranch !== 'main') return `main 에서 돈 실행이 아니다(${run.headBranch || '알 수 없음'})`
  if (run.status !== 'completed') return `아직 끝나지 않았다(${run.status || '알 수 없음'})`
  if (run.conclusion !== 'success') return `성공한 실행이 아니다(${run.conclusion || '알 수 없음'})`
  return null
}

/** 올릴 파일 이름 — .dmg 2 · .zip 2 · latest.json */
function assetNames() {
  return [
    ...files.ARCHES.map((arch) => packageMac.artifactName(arch, 'dmg')),
    ...files.ARCHES.map((arch) => packageMac.artifactName(arch, 'zip')),
    MANIFEST,
  ]
}

/**
 * 받은 파일과 latest.json 이 맞는지 — 틀린 것마다 한 줄(비면 통과)
 * @param {{ manifest: unknown, notes: string, measured: Measured[] }} options
 * @returns {string[]}
 */
function checkFiles({ manifest, notes, measured }) {
  /** @type {string[]} */
  const errors = []
  const byName = new Map(measured.map((item) => [item.name, item]))
  for (const name of assetNames().filter((each) => each !== MANIFEST)) {
    if (!byName.get(name)?.exists) errors.push(`${name} 가 없다`)
  }
  if (!notes.trim()) errors.push(`${NOTES} 가 비었다`)
  if (!manifest || typeof manifest !== 'object') return [...errors, `${MANIFEST} 가 객체가 아니다`]
  const data = /** @type {Record<string, unknown>} */ (manifest)
  if (!files.releaseVersion({ explicit: typeof data.version === 'string' ? data.version : '' })) errors.push(`version 이 X.Y.Z 가 아니다: ${String(data.version)}`)
  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) errors.push(`date 가 YYYY-MM-DD 가 아니다: ${String(data.date)}`)
  if (data.minMacOS !== packageMac.MINIMUM_MACOS) errors.push(`minMacOS 가 ${packageMac.MINIMUM_MACOS} 가 아니다: ${String(data.minMacOS)}`)
  const listed = Array.isArray(data.files) ? data.files : []
  if (listed.length !== files.ARCHES.length) errors.push(`files 가 ${files.ARCHES.length}개가 아니다: ${listed.length}개`)
  for (const arch of files.ARCHES) {
    const name = packageMac.artifactName(arch, 'dmg')
    const entry = listed.find((item) => item && typeof item === 'object' && item.arch === arch)
    if (!entry) {
      errors.push(`files 에 ${arch} 가 없다`)
      continue
    }
    if (entry.name !== name) errors.push(`${arch} 이름이 ${name} 가 아니다: ${String(entry.name)}`)
    const real = byName.get(name)
    if (!real?.exists) continue
    if (entry.size !== real.size) errors.push(`${name} 크기가 다르다 — latest.json ${String(entry.size)} · 받은 파일 ${real.size}`)
    if (entry.sha256 !== real.sha256) errors.push(`${name} sha256 이 다르다 — latest.json ${String(entry.sha256)} · 받은 파일 ${real.sha256}`)
  }
  return errors
}

// gh release create 인자 — 초안으로 만들고(파일 다 올린 뒤 공개) 본문은 파일로
/** @param {{ appVersion: string, dir: string, repo?: string }} options */
function createArgs({ appVersion, dir, repo = RELEASES_REPO }) {
  return [
    'release', 'create', `v${appVersion}`,
    '--repo', repo,
    '--draft',
    '--title', `Athena Studio ${appVersion}`,
    '--notes-file', path.join(dir, NOTES),
    ...assetNames().map((name) => path.join(dir, name)),
  ]
}

/** @param {string[]} args @param {{ quiet?: boolean }} [options] */
function gh(args, { quiet = false } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'], maxBuffer: 16 * 1024 * 1024 })
}

// gh api 가 404 면 false · 있으면 true · 그 밖의 오류는 그대로 던진다(로그인 · 권한 문제를 '없음' 으로 읽지 않게)
/** @param {string} endpoint */
function ghExists(endpoint) {
  try {
    gh(['api', endpoint], { quiet: true })
    return true
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr || '')
    if (/HTTP 404|Not Found/.test(stderr)) return false
    throw new Error(`gh api ${endpoint} 실패 — ${stderr.trim() || String(error)}`)
  }
}

/** @param {string[]} args @param {string} name */
function argValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || '' : ''
}

/** @param {string} dir @returns {Promise<Measured[]>} */
async function measure(dir) {
  /** @type {Measured[]} */
  const result = []
  for (const name of assetNames().filter((each) => each !== MANIFEST)) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) {
      result.push({ name, exists: false })
      continue
    }
    result.push({ name, exists: true, size: fs.statSync(file).size, sha256: name.endsWith('.dmg') ? await files.sha256Of(file) : undefined })
  }
  return result
}

/** @param {string} url */
async function rangeStatus(url) {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
  await response.body?.cancel()
  return response.status
}

/** @param {string} appVersion */
async function checkFixedUrls(appVersion) {
  const base = `https://github.com/${RELEASES_REPO}/releases/latest/download`
  for (const arch of files.ARCHES) {
    const url = `${base}/${packageMac.artifactName(arch, 'dmg')}`
    const status = await rangeStatus(url)
    console.log(`[publish] ${url} → ${status}`)
    if (status !== 200 && status !== 206) throw new Error(`고정 주소가 ${status}: ${url}`)
  }
  const response = await fetch(`${base}/${MANIFEST}`, { redirect: 'follow' })
  const latest = response.ok ? /** @type {{ version?: unknown }} */ (await response.json()) : {}
  console.log(`[publish] ${base}/${MANIFEST} → ${response.status} · version ${String(latest.version)}`)
  if (latest.version !== appVersion) throw new Error(`latest.json 이 이번 버전 ${appVersion} 이 아니다: ${String(latest.version)}`)
}

/** @param {string[]} args */
async function main(args) {
  const runId = argValue(args, '--run')
  const from = argValue(args, '--from')
  const dryRun = args.includes('--dry-run')
  if (Boolean(runId) === Boolean(from)) throw new Error('--run <실행 id> 또는 --from <폴더> 중 하나')
  if (runId && !/^\d+$/.test(runId)) throw new Error(`--run 은 숫자 실행 id: ${runId}`)

  let dir = from ? path.resolve(from) : ''
  if (runId) {
    const run = /** @type {RunInfo} */ (JSON.parse(gh(['run', 'view', runId, '--repo', SOURCE_REPO, '--json', 'status,conclusion,workflowName,headBranch,headSha,url'])))
    const reason = checkRun(run)
    if (reason) throw new Error(`실행 ${runId}: ${reason}`)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-studio-release-'))
    console.log(`[publish] 실행 ${runId} artifact ${ARTIFACT} 받기 → ${dir}`)
    gh(['run', 'download', runId, '--repo', SOURCE_REPO, '--name', ARTIFACT, '--dir', dir])
  }
  const manifestFile = path.join(dir, MANIFEST)
  if (!fs.existsSync(manifestFile)) throw new Error(`${MANIFEST} 가 없다 — release 를 켜고 돈 실행인지 본다: ${dir}`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const notesFile = path.join(dir, NOTES)
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : ''
  const errors = checkFiles({ manifest, notes, measured: await measure(dir) })
  if (errors.length) throw new Error(`받은 파일이 맞지 않는다:\n  - ${errors.join('\n  - ')}`)
  const appVersion = String(manifest.version)
  const tag = `v${appVersion}`
  console.log(`[publish] 확인 통과 — ${appVersion} · ${manifest.date} · 최소 macOS ${manifest.minMacOS}`)
  for (const entry of manifest.files) console.log(`[publish]   ${entry.name} ${entry.size} ${entry.sha256}`)

  if (ghExists(`repos/${RELEASES_REPO}/releases/tags/${tag}`)) throw new Error(`${RELEASES_REPO} 에 Release ${tag} 가 이미 있다 — 덮지 않는다`)
  if (ghExists(`repos/${RELEASES_REPO}/git/ref/tags/${tag}`)) throw new Error(`${RELEASES_REPO} 에 태그 ${tag} 가 이미 있다 — 덮지 않는다`)
  // 초안 Release 는 태그 이름으로 찾아지지 않을 수 있어 목록으로 한 번 더 본다
  const drafts = JSON.parse(gh(['release', 'list', '--repo', RELEASES_REPO, '--json', 'tagName,isDraft', '--limit', '100']))
  if (drafts.some((/** @type {{ tagName: string }} */ item) => item.tagName === tag)) throw new Error(`${RELEASES_REPO} 에 ${tag} 초안이 남아 있다 — gh release delete ${tag} --repo ${RELEASES_REPO} --yes 로 지운 뒤 다시`)

  const create = createArgs({ appVersion, dir })
  console.log(`[publish] 올릴 명령: gh ${create.join(' ')}`)
  console.log(`[publish]           gh release edit ${tag} --repo ${RELEASES_REPO} --draft=false --latest`)
  if (dryRun) {
    console.log('[publish] --dry-run — 올리지 않았다')
    return
  }
  gh(create)
  gh(['release', 'edit', tag, '--repo', RELEASES_REPO, '--draft=false', '--latest'])
  console.log(`[publish] 공개함 — https://github.com/${RELEASES_REPO}/releases/tag/${tag}`)
  await checkFixedUrls(appVersion)
  console.log('[publish] 고정 주소 확인 통과 — 홈페이지 창에 알린다(첫 배포판이면 버튼 켜기)')
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[publish] 실패: ${error && error.message ? error.message : error}`)
    process.exit(1)
  })
}

module.exports = { SOURCE_REPO, RELEASES_REPO, checkRun, assetNames, checkFiles, createArgs }
