// 앱 업데이트(개발 앱 — npm start 로 켠 레포 체크아웃) — ⚙ 설정 팝업 맨 아래 [업데이트] (결정 D2 · 2026-10-26).
// origin/main 보다 뒤처졌는지 보고, 누르면 main 을 빨리 감기로만 받는다. 남의 변경을 덮지 않게 —
// 체크아웃이 main 이 아니거나 · 추적 파일 변경이 있거나 · 로컬 커밋이 있어 빨리 감기가 안 되면 진행하지 않고 까닭을 돌려준다.
// 받은 뒤 package.json · lockfile 이 바뀌었으면 install: true — npm install · 다시 켜기는 scripts/dev-app.js restart 가 앱이 끝난 뒤에 한다.
// Electron 없이 돈다(test/app-update.test.js). git 은 셸을 거치지 않고 부른다
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { gitEnv } = require('./studio-home')

const BRANCH = 'main'
const REMOTE = 'origin'
const FETCH_TIMEOUT_MS = 60000
const INSTALL_FILES = ['package.json', 'package-lock.json']

// git 하나 — 성공이면 stdout(앞뒤 공백 뗌), 실패면 Error(code: 'git')
function runGit(args, { cwd, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnv(), timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(Object.assign(error, { code: 'git' }))
      return resolve(String(stdout || '').trim())
    })
  })
}

// 앱 레포가 git 체크아웃인가(배포판 · 압축본이면 업데이트 줄을 보이지 않는다)
function isCheckout(repoRoot) {
  return Boolean(repoRoot) && fs.existsSync(path.join(repoRoot, '.git'))
}

// → { state: 'behind' | 'current' | 'unavailable', behind, branch, reason }
//   reason(진행하지 못하는 까닭 · 없으면 null): not-main · dirty · diverged · fetch-failed
//   fetch: origin main 을 먼저 받는다(실패해도 이미 받은 origin/main 으로 센다 — 까닭에 fetch-failed)
async function checkStatus({ repoRoot, fetch = true, git = runGit }) {
  if (!isCheckout(repoRoot)) return { state: 'unavailable', behind: 0, branch: null, reason: null }
  const run = (args, options = {}) => git(args, { cwd: repoRoot, ...options })
  let fetchFailed = false
  if (fetch) fetchFailed = !(await run(['fetch', '--quiet', '--no-tags', REMOTE, BRANCH], { timeout: FETCH_TIMEOUT_MS }).then(() => true, () => false))
  const upstream = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${BRANCH}`]).catch(() => '')
  if (!upstream) return { state: 'unavailable', behind: 0, branch: null, reason: fetchFailed ? 'fetch-failed' : null }
  const branch = await run(['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')
  const behind = Number(await run(['rev-list', '--count', `HEAD..${upstream}`]).catch(() => '0')) || 0
  const ahead = Number(await run(['rev-list', '--count', `${upstream}..HEAD`]).catch(() => '0')) || 0
  const dirty = Boolean(await run(['status', '--porcelain', '--untracked-files=no']).catch(() => 'unknown'))
  const reason = pickReason({ branch, dirty, ahead, fetchFailed })
  return { state: behind > 0 ? 'behind' : 'current', behind, branch: branch || null, reason }
}

// 진행하지 못하는 까닭 — 앞의 것이 먼저(main 이 아니면 나머지는 뜻이 없다)
function pickReason({ branch, dirty, ahead, fetchFailed }) {
  if (branch !== BRANCH) return 'not-main'
  if (dirty) return 'dirty'
  if (ahead > 0) return 'diverged'
  if (fetchFailed) return 'fetch-failed'
  return null
}

// main 받기 — 다시 확인(받기 포함)하고 빨리 감기만. → { ok: true, from, to, install } | { ok: false, reason, branch }
//   reason: 위 까닭 · current(받을 것 없음) · unavailable · ff-failed
async function pullMain({ repoRoot, git = runGit }) {
  const status = await checkStatus({ repoRoot, fetch: true, git })
  if (status.state === 'unavailable') return { ok: false, reason: 'unavailable', branch: null }
  if (status.reason) return { ok: false, reason: status.reason, branch: status.branch }
  if (status.state !== 'behind') return { ok: false, reason: 'current', branch: status.branch }
  const run = (args) => git(args, { cwd: repoRoot })
  const from = await run(['rev-parse', 'HEAD'])
  const merged = await run(['merge', '--ff-only', '--quiet', `${REMOTE}/${BRANCH}`]).then(() => true, () => false)
  if (!merged) return { ok: false, reason: 'ff-failed', branch: status.branch }
  const to = await run(['rev-parse', 'HEAD'])
  const changed = await run(['diff', '--name-only', from, to, '--', ...INSTALL_FILES]).catch(() => INSTALL_FILES.join('\n'))
  return { ok: true, from, to, install: Boolean(changed) }
}

module.exports = { BRANCH, INSTALL_FILES, isCheckout, checkStatus, pickReason, pullMain }
