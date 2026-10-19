// 잠금 — 폴더 하나(<이름>.lock/{pid,what}). 팩마다 본체(계획서 20261018-팩마다-본체 5.7 · Codex C2)
//
//   잡기: pid·what 을 먼저 적은 임시 폴더를 rename — "잡았지만 pid 를 아직 안 적은" 순간이 없다
//         (rename 은 대상 폴더가 이미 있고 비어 있지 않으면 실패한다 → 먼저 잡은 쪽이 이긴다)
//   주인 없는 잠금: pid 가 죽었으면 옆 이름으로 옮긴 뒤 다시 읽어, 본 주인과 같을 때만 지운다(그새 남이 새로 잡았으면 되돌린다)
//   풀기: 지금 주인이 나일 때만
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 약속의 오류 — code 는 계획서 5.7(locked · busy · not-found …). 명령 입구(athena.mjs)가 { ok:false, error:code } 로 낸다
export class PackError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

export const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// 잠금 주인 — 잠금이 없으면 null. 이 모듈의 잠금은 늘 pid 가 있다(없으면 옛 모양·부서진 것 → 주인 없음)
export const lockOwnerAt = (dir) => {
  if (!existsSync(dir)) return null
  let pid = null; let what = ''
  try { pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim() || 0) || null } catch { /* pid 없음 */ }
  try { what = readFileSync(join(dir, 'what'), 'utf8').trim() } catch { /* 없어도 된다 */ }
  return { pid, alive: alive(pid), what }
}

const tryTake = (dir, what) => {
  mkdirSync(dirname(dir), { recursive: true })
  const temp = `${dir}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  mkdirSync(temp)
  writeFileSync(join(temp, 'pid'), String(process.pid))
  writeFileSync(join(temp, 'what'), what)
  try {
    renameSync(temp, dir)
    return true
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EISDIR'].includes(error.code)) return false
    throw error
  }
}

const clearStale = (dir, seenPid) => {
  const aside = `${dir}.stale.${process.pid}.${randomBytes(3).toString('hex')}`
  try { renameSync(dir, aside) } catch { return }
  const now = lockOwnerAt(aside)
  if ((now?.pid ?? null) !== seenPid) { try { renameSync(aside, dir) } catch { /* 그새 또 다른 쪽이 잡았다 — 옮긴 것은 버린다 */ rmSync(aside, { recursive: true, force: true }) } return }
  rmSync(aside, { recursive: true, force: true })
}

// takeLock(dir, what, { waitMs, allowParent, message }) → release()
//   waitMs      — 잡혀 있으면 이만큼 기다린다(0 이면 바로 locked)
//   allowParent — 주인이 나를 띄운 부모 프로세스면 잡은 것으로 본다(pack open 이 새 본체 코드로 pack attach 를 부를 때)
export const takeLock = (dir, what, { waitMs = 0, allowParent = false, message = (owner) => `다른 작업이 잠금을 쥐고 있다(pid ${owner.pid}${owner.what ? ` · ${owner.what}` : ''})` } = {}) => {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (tryTake(dir, what)) {
      return () => {
        const owner = lockOwnerAt(dir)
        if (owner?.pid !== process.pid) return
        const done = `${dir}.done.${process.pid}.${randomBytes(3).toString('hex')}`
        try { renameSync(dir, done); rmSync(done, { recursive: true, force: true }) } catch { /* 이미 없다 */ }
      }
    }
    const owner = lockOwnerAt(dir)
    if (!owner) continue                                  // 그새 풀렸다
    if (allowParent && owner.pid === process.ppid) return () => {}
    if (!owner.alive) { clearStale(dir, owner.pid); continue }
    if (Date.now() >= deadline) throw new PackError('locked', message(owner), { owner: { pid: owner.pid, what: owner.what } })
    sleepMs(50)
  }
}

// 데이터 폴더의 잠금 자리 — 팩마다 <데이터>/locks/<id>.lock · git 공용 _git · 레지스트리 <데이터>/registry.lock
export const packLockDir = (data, id) => join(data, 'locks', `${id}.lock`)
export const gitLockDir = (data) => join(data, 'locks', '_git.lock')
export const registryLockDir = (data) => join(data, 'registry.lock')
export const packLockOwner = (data, id) => (id ? lockOwnerAt(packLockDir(data, id)) : null)
