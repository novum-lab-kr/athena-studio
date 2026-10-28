// 배포판 앱 업데이트(⚙ 설정 팝업 맨 아래 · .dmg 로 설치한 앱 — 계획서 5단계 · 2026-10-28 D9 바꿈).
// electron-updater(AppUpdater)를 받아 확인 · 받기 · 설치를 ⚙ 줄 상태 하나로 묶는다. 개발판(git 체크아웃)은 lib/app-update.mts 그대로.
//   확인: 피드(앱 Resources/app-update.yml 이 가리키는 공개 레포 최신 Release 의 latest-mac.yml)만 읽는다 — 받지도 설치 준비도 하지 않는다
//   [업데이트]: 그 칩의 .zip 받기(electron-updater 가 latest-mac.yml 의 sha512 와 맞춘다 — 틀리면 ERR_CHECKSUM_MISMATCH)
//              → quitAndInstall — Squirrel.Mac 이 받은 .app 의 코드 서명을 지금 켜진 앱의 designated requirement(번들 ID · Team ID)로 검사하고
//                 맞을 때만 앱을 끄고 바꿔 다시 켠다. 안 맞으면 'error' — 앱은 그대로
//   자동으로는 아무것도 하지 않는다(autoDownload · autoInstallOnAppQuit 끔 — 맥은 autoInstallOnAppQuit 가 꺼져 있으면 Squirrel 에 넘기기를 quitAndInstall 때만 한다)
// Electron 없이 돈다(test/release-update.test.js — 가짜 updater · native)

export type ReleaseReason = 'check-failed' | 'download-failed' | 'checksum-failed' | 'install-failed'
// 화면에 보내는 모양은 개발판(lib/app-update.mts UpdateStatus)과 같다 — behind · branch 는 배포판에 없어 0 · null
export type ReleaseStatus = { state: 'behind' | 'current' | 'unavailable'; behind: 0; branch: null; reason: ReleaseReason | null; version: string | null; latest: string | null }
export type ReleaseRunResult = { ok: true } | { ok: false; reason: ReleaseReason | 'unavailable' | 'current' | 'running' }

type CheckResult = { isUpdateAvailable?: boolean; updateInfo: { version: string } } | null
export type Logger = { info(message?: unknown): void; warn(message?: unknown): void; error(message?: unknown): void; debug?(message: string): void }
// electron-updater AppUpdater 중 쓰는 것만
export type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableDifferentialDownload: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  logger: Logger | null
  checkForUpdates(): Promise<CheckResult>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: 'error', listener: (error: unknown) => void): unknown
}
// Electron autoUpdater(Squirrel.Mac) — 교체를 시작하면(곧 꺼진다) 'before-quit-for-update'. 서명 검사 실패 같은 오류는 MacUpdater 가 updater 'error' 로 넘긴다
export type Native = {
  once(event: 'before-quit-for-update', listener: () => void): unknown
  removeListener(event: 'before-quit-for-update', listener: () => void): unknown
}

// Squirrel 이 받은 .app 을 풀고 서명을 검사하는 데 걸리는 시간의 넉넉한 끝 — 넘으면 설치 실패로 알리고 [업데이트] 를 다시 누를 수 있게
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

// 받기 실패 까닭 — 체크섬이 틀린 것만 따로(받은 파일이 피드와 다르다 · electron-updater 가 지운다)
export function downloadReason(error: unknown): ReleaseReason {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
  return code === 'ERR_CHECKSUM_MISMATCH' ? 'checksum-failed' : 'download-failed'
}

// version — 지금 앱 버전(app.getVersion) · onChange — 상태가 바뀔 때(창마다 보낸다) · log — 기록 한 줄(app-update.log)
export function createReleaseUpdate({ updater, native, version, onChange, log, installTimeoutMs = INSTALL_TIMEOUT_MS }: { updater: Updater; native: Native; version: string; onChange: () => void; log: Logger; installTimeoutMs?: number }) {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  // 파일 이름에 버전이 없어(고정 주소) 옛 판 blockmap 자리 = 새 판 자리 — 차등 받기를 믿을 수 없어 늘 .zip 전체
  updater.disableDifferentialDownload = true
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  updater.logger = log

  // 첫 확인 전에는 줄을 숨긴다(unavailable) — '최신이에요' 를 미리 보이지 않게
  let status: ReleaseStatus = { state: 'unavailable', behind: 0, branch: null, reason: null, version, latest: null }
  let running = false
  // 설치(quitAndInstall)를 기다리는 중이면 그 끝내기 — 'error' 가 오면 실패로 끝낸다
  let installing: ((result: ReleaseRunResult) => void) | null = null

  // 'error' 를 듣는 쪽이 없으면 EventEmitter 가 던진다 — 늘 듣고 기록 · 설치 중이면 실패로
  updater.on('error', (error) => {
    log.error(error instanceof Error ? error.stack || error.message : String(error))
    if (installing) installing({ ok: false, reason: 'install-failed' })
  })

  const view = () => ({ ...status, running })

  async function check() {
    if (running) return view()
    try {
      const result = await updater.checkForUpdates()
      if (!result) status = { ...status, state: 'unavailable', reason: null, latest: null }
      else if (result.isUpdateAvailable) status = { ...status, state: 'behind', reason: null, latest: result.updateInfo.version }
      else status = { ...status, state: 'current', reason: null, latest: null }
    } catch {
      // 최신인지 모른다 — 앞서 본 새 버전은 그대로 두고 까닭만(기록은 'error' 가 남겼다) · 처음이면 줄을 보이게(current)
      status = { ...status, state: status.state === 'behind' ? 'behind' : 'current', reason: 'check-failed' }
    }
    onChange()
    return view()
  }

  function fail(reason: ReleaseReason): ReleaseRunResult {
    running = false
    status = { ...status, reason }
    onChange()
    return { ok: false, reason }
  }

  // [업데이트] — 받기 → 설치(교체가 시작되면 ok · 곧 앱이 꺼졌다 새 판으로 켜진다). 못 하면 앱은 그대로 · 까닭
  async function run(): Promise<ReleaseRunResult> {
    if (running) return { ok: false, reason: 'running' }
    if (status.state === 'unavailable') return { ok: false, reason: 'unavailable' }
    if (status.state !== 'behind') return { ok: false, reason: 'current' }
    running = true
    status = { ...status, reason: null }
    onChange()
    try {
      await updater.downloadUpdate()
    } catch (error) {
      return fail(downloadReason(error))
    }
    const result = await new Promise<ReleaseRunResult>((resolve) => {
      const done = (value: ReleaseRunResult) => {
        if (!installing) return
        installing = null
        clearTimeout(timer)
        native.removeListener('before-quit-for-update', started)
        resolve(value)
      }
      const started = () => done({ ok: true })
      const timer = setTimeout(() => {
        log.warn(`설치가 ${Math.round(installTimeoutMs / 1000)}초 안에 시작되지 않았다`)
        done({ ok: false, reason: 'install-failed' })
      }, installTimeoutMs)
      installing = done
      native.once('before-quit-for-update', started)
      try {
        updater.quitAndInstall()
      } catch (error) {
        log.error(error instanceof Error ? error.stack || error.message : String(error))
        done({ ok: false, reason: 'install-failed' })
      }
    })
    if (!result.ok) return fail(result.reason as ReleaseReason)
    return result
  }

  return { view, check, run }
}
