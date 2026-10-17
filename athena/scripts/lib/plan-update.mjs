/**
 * 계획서 고치기(node) — scripts/lib/plan_update.py 와 같은 잠금(<계획서>.lock 폴더)·같은 방식.
 * 읽기 → 바꾸기 → 쓰기를 잠금 안에서, 쓰기는 임시 파일 → 바꿔치기. 정식 계획서의 html md 사본(<script id="plan-md">)도 맞춘다.
 *
 *   updatePlan(path, (text) => text.replace(…))            바꿀 게 없으면(null·같음) false
 *   withPlanLock(path, () => { … })                         잠금만(html 을 따로 고칠 때)
 *   acquirePlanLock(path) → lock … releaseLock(lock)        콜백으로 감쌀 수 없는 스크립트 본문용(plan-html.mjs)
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const LOCK_WAIT_MS = 15_000
const STALE_MS = 120_000
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const ownerOf = (lock) => {
  try {
    return Number(readFileSync(join(lock, 'pid'), 'utf8').trim()) || 0
  } catch {
    return 0
  }
}
const isAlive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function acquirePlanLock(path) {
  const lock = `${resolve(path)}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    // pid 를 넣은 임시 폴더를 잠금 이름으로 옮긴다(원자적 — python 쪽과 같다)
    const staging = mkdtempSync(join(dirname(lock), '.plan-lock-'))
    writeFileSync(join(staging, 'pid'), String(process.pid))
    try {
      renameSync(staging, lock)
      break
    } catch {
      rmSync(staging, { recursive: true, force: true })
    }
    let age = 0
    try { age = Date.now() - statSync(lock).mtimeMs } catch { continue }
    if (!isAlive(ownerOf(lock)) || age > STALE_MS) {
      const stale = `${lock}.stale-${process.pid}`
      try {
        renameSync(lock, stale)
        rmSync(stale, { recursive: true, force: true })
      } catch { /* 다른 쪽이 먼저 치웠다 */ }
      continue
    }
    if (Date.now() > deadline) throw new Error(`계획서 잠금을 ${LOCK_WAIT_MS / 1000}초 기다려도 풀리지 않았다: ${lock}`)
    sleep(100)
  }
  return lock
}

export function withPlanLock(path, work) {
  const lock = acquirePlanLock(path)
  try {
    return work()
  } finally {
    releaseLock(lock)
  }
}

// 잠금 풀기 — 내 것일 때만, 다른 이름으로 먼저 옮긴 뒤 지운다(안의 pid 를 먼저 지우면 빈 폴더가 된 틈에 다른 쪽의 rename 이 그 자리를 차지한다)
export function releaseLock(lock) {
  if (ownerOf(lock) !== process.pid) return
  const released = `${lock}.released-${process.pid}-${Date.now()}`
  try {
    renameSync(lock, released)
    rmSync(released, { recursive: true, force: true })
  } catch { /* 이미 없다 */ }
}

export function writeAtomic(path, text) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  writeFileSync(temp, text)
  renameSync(temp, path)
}

const PLAN_MD_BLOCK = /(<script id="plan-md" type="text\/markdown">)([\s\S]*?)(<\/script>)/
export function syncHtml(path, text) {
  const htmlPath = path.replace(/\.md$/, '.html')
  if (!existsSync(htmlPath)) return
  const page = readFileSync(htmlPath, 'utf8')
  if (!PLAN_MD_BLOCK.test(page)) return
  const body = text.replace(/<\/(script)/gi, '<\\/$1')
  writeAtomic(htmlPath, page.replace(PLAN_MD_BLOCK, (match, open, inner, close) => `${open}\n${body}${close}`))
}

export function updatePlan(path, change) {
  return withPlanLock(path, () => {
    const text = readFileSync(path, 'utf8')
    const updated = change(text)
    if (updated == null || updated === text) return false
    writeAtomic(path, updated)
    syncHtml(path, updated)
    return true
  })
}
