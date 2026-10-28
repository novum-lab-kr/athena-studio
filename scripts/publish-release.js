// @ts-check
// 맥 배포판을 공개 레포(novum-lab-kr/athena-studio-releases)에 올린다 — 로컬에서 사용자 gh 로그인으로(토큰 Secret 을 두지 않는다 · 계획서 Decisions)
//   node scripts/publish-release.js --run <release-mac 실행 id> [--dry-run]
//   node scripts/publish-release.js --from <이미 받은 artifact 폴더> [--dry-run]
//     1. 실행 확인 — release-mac 워크플로 · main · 끝남 · 성공(--run 일 때)
//     2. artifact Athena-Studio-mac 받기(gh run download) → .dmg 2 · .zip 2 · latest.json · release-notes.md
//     3. 다시 확인 — 이름 · 크기 · sha256 을 latest.json 과 맞추고 version · date · minMacOS 모양
//     3-1. .dmg 를 이 맥에서 staple — CI 가 CloudKit 연결 끊김으로 못 붙였을 수 있다(staple.json · scripts/notarize-mac.js).
//          stapler validate 가 이미 통과면 그대로 · 아니면 staple(티켓만 받는다 — 자격 증명 필요 없음) → validate →
//          spctl 이 'accepted · Notarized Developer ID' 여야 올린다. staple 로 파일이 바뀌면 latest.json 의 size · sha256 을 다시 쓴다
//          .zip 안 .app 은 CI 에서 못 붙였으면 그대로 올리고 알린다(손님 맥이 처음 켤 때 온라인으로 공증을 확인한다)
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
const notarizeMac = require('./notarize-mac')

const SOURCE_REPO = 'novum-lab-kr/athena-studio'
const RELEASES_REPO = 'novum-lab-kr/athena-studio-releases'
const WORKFLOW = 'release-mac'
const ARTIFACT = 'Athena-Studio-mac'
const MANIFEST = 'latest.json'
const NOTES = 'release-notes.md'
// 이 맥에서 staple — 집 네트워크라 짧게(10초 간격 3번)
const LOCAL_RETRY = { tries: 3, delayMs: 10_000 }

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

/**
 * staple 로 바뀐 .dmg 크기 · sha256 을 latest.json 에 반영한 새 객체와 바뀐 파일 이름들 — 받은 manifest 는 바꾸지 않는다
 * @template {{ files: { arch: string, name: string, size: number, sha256: string }[] }} T
 * @param {T} manifest
 * @param {Measured[]} measured
 * @returns {{ manifest: T, changed: string[] }}
 */
function updateManifest(manifest, measured) {
  /** @type {string[]} */
  const changed = []
  const byName = new Map(measured.map((item) => [item.name, item]))
  const listed = manifest.files.map((entry) => {
    const real = byName.get(entry.name)
    if (!real?.exists || (real.size === entry.size && real.sha256 === entry.sha256)) return entry
    changed.push(entry.name)
    return { ...entry, size: /** @type {number} */ (real.size), sha256: /** @type {string} */ (real.sha256) }
  })
  return { manifest: { ...manifest, files: listed }, changed }
}

// CI 가 .app staple 을 못 한 .zip 이름들 — staple.json 이 없으면(옛 artifact) null = 모름
/** @param {Record<string, boolean> | null} status */
function unstapledZips(status) {
  if (!status) return null
  return files.ARCHES.map((arch) => packageMac.artifactName(arch, 'zip')).filter((name) => status[name] !== true)
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

// .dmg 마다 — 이미 붙어 있으면 그대로 · 아니면 staple(+ validate) · 그다음 Gatekeeper 가 공증된 Developer ID 로 받는지
/** @param {string} dir */
async function stapleDmgs(dir) {
  for (const arch of files.ARCHES) {
    const file = path.join(dir, packageMac.artifactName(arch, 'dmg'))
    const name = path.basename(file)
    const validated = await notarizeMac.run('xcrun', ['stapler', 'validate', file], { echo: false })
    if (validated.code === 0) console.log(`[publish] ${name} — 이미 staple 됨`)
    else {
      console.log(`[publish] ${name} — staple 안 됨 · 이 맥에서 붙인다`)
      const ok = await notarizeMac.staple(file, { ...LOCAL_RETRY, log: (line) => console.log(`[publish] ${line}`) })
      if (!ok) throw new Error(`${name} 에 staple 하지 못했다 — 네트워크를 보고 다시(공증 티켓을 애플 CloudKit 에서 받는다)`)
    }
    const gatekeeper = await notarizeMac.run('spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', file], { echo: false })
    process.stdout.write(gatekeeper.output)
    if (gatekeeper.code !== 0 || !/source=Notarized Developer ID/.test(gatekeeper.output)) throw new Error(`${name} 를 Gatekeeper 가 공증된 Developer ID 로 받지 않는다(spctl) — 올리지 않는다`)
  }
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
  if (process.platform !== 'darwin') throw new Error('맥에서 돌린다 — 올리기 전에 .dmg 를 xcrun stapler · spctl 로 확인한다')
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

  // 받은 파일이 CI 가 만든 그대로임을 본 뒤에 staple — 파일이 바뀌면 latest.json 을 다시 쓰고 한 번 더 맞춘다
  await stapleDmgs(dir)
  const updated = updateManifest(manifest, await measure(dir))
  if (updated.changed.length) {
    fs.writeFileSync(manifestFile, `${JSON.stringify(updated.manifest, null, 2)}\n`)
    console.log(`[publish] staple 로 바뀐 파일 — latest.json size · sha256 다시 씀: ${updated.changed.join(' · ')}`)
    const again = checkFiles({ manifest: updated.manifest, notes, measured: await measure(dir) })
    if (again.length) throw new Error(`staple 뒤 latest.json 이 맞지 않는다:\n  - ${again.join('\n  - ')}`)
  }
  const zips = unstapledZips(notarizeMac.readStaple(dir))
  if (zips === null) console.log(`[publish] .zip 안 .app staple 여부 모름(${notarizeMac.STATUS_FILE} 없음 — 옛 실행) · 그대로 올린다`)
  else if (zips.length) console.log(`[publish] 주의: ${zips.join(' · ')} 안 .app 은 미staple(공증은 됨 — 손님 맥이 처음 켤 때 온라인으로 확인) · 그대로 올린다`)

  const appVersion = String(updated.manifest.version)
  const tag = `v${appVersion}`
  console.log(`[publish] 확인 통과 — ${appVersion} · ${manifest.date} · 최소 macOS ${manifest.minMacOS}`)
  for (const entry of updated.manifest.files) console.log(`[publish]   ${entry.name} ${entry.size} ${entry.sha256}`)

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

module.exports = { SOURCE_REPO, RELEASES_REPO, checkRun, assetNames, checkFiles, updateManifest, unstapledZips, createArgs }
