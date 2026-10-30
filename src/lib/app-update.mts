// 앱 업데이트(개발 앱 — npm start 로 켠 레포 체크아웃) — ⚙ 설정 팝업 맨 아래 [업데이트] (결정 D2 · 2026-10-26).
// origin/main 보다 뒤처졌는지 보고, 누르면 main 을 빨리 감기로만 받는다. 남의 변경을 덮지 않게 —
// 체크아웃이 main 이 아니거나 · 추적 파일 변경이 있거나 · 로컬 커밋이 있어 빨리 감기가 안 되면 진행하지 않고 까닭을 돌려준다.
// 받은 뒤 lockfile 이 바뀌었거나 package.json 의 설치에 닿는 부분(일반 scripts 제외)이 바뀌었으면 install: true — npm install · 다시 켜기는 scripts/dev-app.js restart 가 앱이 끝난 뒤에 한다.
// Electron 없이 돈다(test/app-update.test.js). git 은 셸을 거치지 않고 부른다
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

// studio-home · version 은 JS(dev-app.js 가 PATH 의 node 로도 부른다) — main 과 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const { gitEnv }: typeof import('./studio-home.js') = require('./studio-home.js')
const version: typeof import('./version.js') = require('./version.js')

// git 을 부르는 함수 — 테스트는 가짜를 넘긴다
export type Git = (args: string[], options: { cwd: string; timeout?: number }) => Promise<string>
export type UpdateReason = 'not-main' | 'dirty' | 'diverged' | 'fetch-failed'
export type UpdateStatus = { state: 'behind' | 'current' | 'unavailable'; behind: number; branch: string | null; reason: UpdateReason | null; version: string | null; latest: string | null }
export type PullResult = { ok: true; from: string; to: string; install: boolean } | { ok: false; reason: UpdateReason | 'current' | 'unavailable' | 'ff-failed'; branch: string | null }
type Run = (args: string[], options?: { timeout?: number }) => Promise<string>

export const BRANCH = 'main'
const REMOTE = 'origin'
const FETCH_TIMEOUT_MS = 60000
export const LOCK_FILE = 'package-lock.json'
// npm install 이 스스로 도는 생명주기 스크립트 — package.json 비교에서 일반 scripts 는 빼도 이 넷은 넣는다
export const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

// git 하나 — 성공이면 stdout(앞뒤 공백 뗌), 실패면 Error(code: 'git')
function runGit(args: string[], { cwd, timeout = 30000 }: { cwd: string; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnv(), timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(Object.assign(error, { code: 'git' }))
      return resolve(String(stdout || '').trim())
    })
  })
}

// 앱 레포가 git 체크아웃인가(배포판 · 압축본이면 업데이트 줄을 보이지 않는다)
export function isCheckout(repoRoot: string | null | undefined): boolean {
  return Boolean(repoRoot) && fs.existsSync(path.join(repoRoot as string, '.git'))
}

// → { state: 'behind' | 'current' | 'unavailable', behind, branch, reason, version, latest }
//   reason(진행하지 못하는 까닭 · 없으면 null): not-main · dirty · diverged · fetch-failed
//   version: 지금 체크아웃 버전(0.2.1 · 0.2.1+3 — 태그가 없으면 null · 부르는 쪽이 package.json 값으로)
//   latest: origin/main 버전 — 지금보다 새 태그가 있을 때만(없으면 null · 화면은 커밋 수를 보인다)
//   fetch: origin main 과 v* 태그를 먼저 받는다(실패해도 이미 받은 origin/main 으로 센다 — 까닭에 fetch-failed)
export async function checkStatus({ repoRoot, fetch = true, git = runGit }: { repoRoot: string; fetch?: boolean; git?: Git }): Promise<UpdateStatus> {
  if (!isCheckout(repoRoot)) return { state: 'unavailable', behind: 0, branch: null, reason: null, version: null, latest: null }
  const run: Run = (args, options = {}) => git(args, { cwd: repoRoot, ...options })
  let fetchFailed = false
  if (fetch) fetchFailed = !(await run(['fetch', '--quiet', '--no-tags', REMOTE, BRANCH, '+refs/tags/v*:refs/tags/v*'], { timeout: FETCH_TIMEOUT_MS }).then(() => true, () => false))
  const current = await describe(run, 'HEAD')
  const upstream = await run(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${BRANCH}`]).catch(() => '')
  if (!upstream) return { state: 'unavailable', behind: 0, branch: null, reason: fetchFailed ? 'fetch-failed' : null, version: current, latest: null }
  const branch = await run(['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')
  const behind = Number(await run(['rev-list', '--count', `HEAD..${upstream}`]).catch(() => '0')) || 0
  const ahead = Number(await run(['rev-list', '--count', `${upstream}..HEAD`]).catch(() => '0')) || 0
  const dirty = Boolean(await run(['status', '--porcelain', '--untracked-files=no']).catch(() => 'unknown'))
  const reason = pickReason({ branch, dirty, ahead, fetchFailed })
  const latest = behind > 0 ? newerVersion(current, await describe(run, upstream)) : null
  return { state: behind > 0 ? 'behind' : 'current', behind, branch: branch || null, reason, version: current, latest }
}

// 그 ref 의 버전(0.2.1 · 0.2.1+3) · 태그가 없으면 null
async function describe(run: Run, ref: string): Promise<string | null> {
  const output = await run(['describe', '--tags', '--long', '--match', version.TAG_PATTERN, ref]).catch(() => '')
  return version.formatDescribe(output)
}

// origin/main 쪽 태그가 지금 것보다 높을 때만 그 버전 — 새 태그가 아직 없으면 null
export function newerVersion(current: string | null, upstream: string | null): string | null {
  const next = version.splitDisplay(upstream)
  if (!next) return null
  const now = version.splitDisplay(current)
  return !now || version.compareVersions(next.tag, now.tag) > 0 ? upstream : null
}

// 진행하지 못하는 까닭 — 앞의 것이 먼저(main 이 아니면 나머지는 뜻이 없다)
export function pickReason({ branch, dirty, ahead, fetchFailed }: { branch: string; dirty: boolean; ahead: number; fetchFailed: boolean }): UpdateReason | null {
  if (branch !== BRANCH) return 'not-main'
  if (dirty) return 'dirty'
  if (ahead > 0) return 'diverged'
  if (fetchFailed) return 'fetch-failed'
  return null
}

// main 받기 — 다시 확인(받기 포함)하고 빨리 감기만. → { ok: true, from, to, install } | { ok: false, reason, branch }
//   reason: 위 까닭 · current(받을 것 없음) · unavailable · ff-failed
export async function pullMain({ repoRoot, git = runGit }: { repoRoot: string; git?: Git }): Promise<PullResult> {
  const status = await checkStatus({ repoRoot, fetch: true, git })
  if (status.state === 'unavailable') return { ok: false, reason: 'unavailable', branch: null }
  if (status.reason) return { ok: false, reason: status.reason, branch: status.branch }
  if (status.state !== 'behind') return { ok: false, reason: 'current', branch: status.branch }
  const run = (args: string[]) => git(args, { cwd: repoRoot })
  const from = await run(['rev-parse', 'HEAD'])
  const merged = await run(['merge', '--ff-only', '--quiet', `${REMOTE}/${BRANCH}`]).then(() => true, () => false)
  if (!merged) return { ok: false, reason: 'ff-failed', branch: status.branch }
  const to = await run(['rev-parse', 'HEAD'])
  return { ok: true, from, to, install: await needsInstall(run, from, to) }
}

// 받은 변경에 npm install 이 필요한가 — lockfile 이 바뀌었거나 · package.json 의 설치에 닿는 부분이 바뀌었을 때.
// 읽거나 파싱하지 못하면 안전하게 true
async function needsInstall(run: (args: string[]) => Promise<string>, from: string, to: string): Promise<boolean> {
  try {
    if (await run(['diff', '--name-only', from, to, '--', LOCK_FILE])) return true
    if (!(await run(['diff', '--name-only', from, to, '--', 'package.json']))) return false
    const before = await run(['show', `${from}:package.json`])
    const after = await run(['show', `${to}:package.json`])
    return installRelevantChanged(before, after)
  } catch {
    return true
  }
}

// package.json 두 본문을 설치 기준으로 비교 — 일반 scripts 는 빼고(INSTALL_SCRIPTS 넷은 남김) 나머지가 다르면 true.
// 파싱하지 못하면 throw(부르는 쪽이 설치로 처리)
export function installRelevantChanged(before: string, after: string): boolean {
  return JSON.stringify(installView(JSON.parse(before))) !== JSON.stringify(installView(JSON.parse(after)))
}

// 키 순서와 상관없이 같은 모양이 되도록 정렬한 뒤, scripts 는 설치 스크립트만 남긴다
function installView(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((item) => installView(item, false))
  if (value === null || typeof value !== 'object') return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (top && key === 'scripts') {
      const kept: Record<string, unknown> = {}
      if (child && typeof child === 'object') for (const name of INSTALL_SCRIPTS) if (name in child) kept[name] = (child as Record<string, unknown>)[name]
      sorted[key] = kept
    } else sorted[key] = installView(child, false)
  }
  return sorted
}
