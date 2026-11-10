// 배포판 앱 업데이트(⚙ 설정 팝업 맨 아래 · .dmg 로 설치한 앱 — 계획서 5단계 · 2026-10-28 D9 바꿈).
// electron-updater(AppUpdater)를 받아 확인 · 받기 · 설치를 ⚙ 줄 상태 하나로 묶는다. 개발판(git 체크아웃)은 lib/app-update.mts 그대로.
//   확인: 피드(앱 Resources/app-update.yml 이 가리키는 공개 레포 최신 Release 의 latest-mac.yml)를 읽고, 새 버전이면 뒤에서 받아 둔다(autoDownload · 2026-11-07 사용자 결정)
//         → electron-updater 가 받은 .zip 을 Squirrel.Mac 에 넘기고(autoInstallOnAppQuit) Squirrel 이 받은 앱의 서명을 검사한 뒤 native 'update-downloaded'
//         → phase 'ready'(좌하단 팝업 · ⚙ [다시 시작]). 그 뒤 사용자가 앱을 끄면 Squirrel 이 바꿔 둔다(다시 켜지는 않는다 — 다음에 켜면 새 판)
//   [업데이트](받기 실패 뒤 다시) · [다시 시작]: 그 칩의 .zip 받기(electron-updater 가 latest-mac.yml 의 sha512 와 맞춘다 — 틀리면 ERR_CHECKSUM_MISMATCH)
//              → quitAndInstall — Squirrel.Mac 이 받은 .app 의 코드 서명을 지금 켜진 앱의 designated requirement(번들 ID · Team ID)로 검사하고
//                 맞을 때만 앱을 끄고 바꿔 다시 켠다. 안 맞으면 'error' — 앱은 그대로
//   ready 뒤에도 확인(30분 · ⚙ 열 때 · [다시 시작])은 피드를 다시 본다 — 받아 둔 판보다 새 판이 나왔으면 새로 받아 그 판을 ready 로(2026-11-10 제보 —
//     60.14 를 받아 둔 사이 60.15 가 나왔는데 60.14 를 설치해 두 번 다시 켬). Squirrel.Mac 은 받아 둔 판이 있어도(AwaitingRelaunch) 다시 받으면
//     ShipItState 를 새 판으로 덮고 'update-downloaded' 를 다시 낸다(SQRLUpdater prepareUpdateForInstallation). 새 판이 없으면 받기 없이 바로 quitAndInstall
// Electron 없이 돈다(test/release-update.test.js — 가짜 updater · native)

export type ReleaseReason = 'check-failed' | 'download-failed' | 'checksum-failed' | 'install-failed'
// 화면에 보내는 모양은 개발판(lib/app-update.mts UpdateStatus)과 같다 — behind · branch 는 배포판에 없어 0 · null
export type ReleaseStatus = { state: 'behind' | 'current' | 'unavailable'; behind: 0; branch: null; reason: ReleaseReason | null; version: string | null; latest: string | null }
// 받아 둔 새 판이 설치 준비됐다(Squirrel 서명 검사까지 끝) — 개발판의 phase 'ready'(설치 끝 · 다시 시작 대기)와 같은 칸
export type ReleasePhase = 'ready' | null
export type ReleaseRunResult = { ok: true } | { ok: false; reason: ReleaseReason | 'unavailable' | 'current' | 'running' }

// downloadPromise — autoDownload 면 확인이 시작한 받기(electron-updater AppUpdater.doCheckForUpdates)
type CheckResult = { isUpdateAvailable?: boolean; updateInfo: { version: string }; downloadPromise?: Promise<unknown> | null } | null
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
// Electron autoUpdater(Squirrel.Mac) — 받아서 서명 검사까지 끝나면 'update-downloaded' · 교체를 시작하면(곧 꺼진다) 'before-quit-for-update'.
// 서명 검사 실패 같은 오류는 MacUpdater 가 updater 'error' 로 넘긴다
export type Native = {
  on(event: 'update-downloaded', listener: () => void): unknown
  once(event: 'before-quit-for-update', listener: () => void): unknown
  removeListener(event: 'before-quit-for-update', listener: () => void): unknown
}

// 받아 둔 판보다 피드 판이 새로운가 — 배포판 번호는 x.y.z(시험판은 끔 · allowPrerelease false). 받아 둔 판을 모르면 새로 친다
export function newerThan(version: string, than: string | null): boolean {
  if (than === null) return true
  const parts = (value: string) => value.split('-')[0]!.split('.').map(Number)
  const left = parts(version)
  const right = parts(than)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

// Squirrel 이 받은 .app 을 풀고 서명을 검사하는 데 걸리는 시간의 넉넉한 끝 — 넘으면 설치 실패로 알리고 [업데이트] 를 다시 누를 수 있게
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

// 응용 프로그램 폴더 밖에서 켠 배포판(디스크 이미지 창 · 다운로드 폴더 · App Translocation) — Squirrel.Mac 이 앱을 바꾸지 못해(읽기 전용 자리) 설치가 실패한다.
// 켤 때 묻지 않고 옮긴다(2026-11-10 사용자 결정). 옮기기는 Electron app.moveToApplicationsFolder — 성공하면 Electron 이 스스로 앱을 끄고 옮긴 자리에서 다시 켠다
export type MoveApp = { isPackaged: boolean; isInApplicationsFolder(): boolean; moveToApplicationsFolder(): boolean }
export type MoveResult = 'skip' | 'moved' | 'not-moved' | 'failed'

export function outsideApplications(app: MoveApp, platform: string): boolean {
  return platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder()
}

// 'moved' 면 앱이 곧 꺼진다(창을 열지 않는다). 'not-moved' · 'failed' 면 그대로 켠다 — ⚙ 업데이트 줄이 옮긴 뒤 다시 켜라고 알린다
export function moveToApplications({ app, platform, log }: { app: MoveApp; platform: string; log: Logger }): MoveResult {
  if (!outsideApplications(app, platform)) return 'skip'
  try {
    if (app.moveToApplicationsFolder()) {
      log.info('응용 프로그램 폴더 밖에서 켜져 옮겼다 — 다시 켠다')
      return 'moved'
    }
    log.warn('응용 프로그램 폴더로 옮기지 못했다(moveToApplicationsFolder false)')
    return 'not-moved'
  } catch (error) {
    // 관리자 암호 창 취소 · 복사 실패 · 있던 앱을 휴지통에 못 넣음 — Electron 이 던진다
    log.error(`응용 프로그램 폴더로 옮기지 못했다: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}

// 받기 실패 까닭 — 체크섬이 틀린 것만 따로(받은 파일이 피드와 다르다 · electron-updater 가 지운다)
export function downloadReason(error: unknown): ReleaseReason {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
  return code === 'ERR_CHECKSUM_MISMATCH' ? 'checksum-failed' : 'download-failed'
}

// version — 지금 앱 버전(app.getVersion) · onChange — 상태가 바뀔 때(창마다 보낸다) · log — 기록 한 줄(app-update.log)
export function createReleaseUpdate({ updater, native, version, onChange, log, installTimeoutMs = INSTALL_TIMEOUT_MS }: { updater: Updater; native: Native; version: string; onChange: () => void; log: Logger; installTimeoutMs?: number }) {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  // 파일 이름에 버전이 없어(고정 주소) 옛 판 blockmap 자리 = 새 판 자리 — 차등 받기를 믿을 수 없어 늘 .zip 전체
  updater.disableDifferentialDownload = true
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  updater.logger = log

  // 첫 확인 전에는 줄을 숨긴다(unavailable) — '최신이에요' 를 미리 보이지 않게
  let status: ReleaseStatus = { state: 'unavailable', behind: 0, branch: null, reason: null, version, latest: null }
  let running = false
  let phase: ReleasePhase = null
  // Squirrel 이 들고 있는 판(phase ready 일 때) — 다음 확인이 피드와 맞춰 본다
  let readyVersion: string | null = null
  // 도는 확인 하나(30분 · ⚙ 열 때가 겹쳐도 한 번만 묻는다)
  let checking: Promise<void> | null = null
  // [다시 시작] 이 더 새 판 받기를 기다리는 중이면 그 끝내기 — 준비되면 true · 실패하면 false
  let waitReady: ((ready: boolean) => void) | null = null
  // 뒤에서 받은 .zip 을 Squirrel 이 가져가 서명을 검사하는 중 — 이때 온 'error' 는 그 검사 실패
  let verifying = false
  // 설치(quitAndInstall)를 기다리는 중이면 그 끝내기 — 'error' 가 오면 실패로 끝낸다
  let installing: ((result: ReleaseRunResult) => void) | null = null

  // 'error' 를 듣는 쪽이 없으면 EventEmitter 가 던진다 — 늘 듣고 기록 · 설치 중이면 실패로
  updater.on('error', (error) => {
    log.error(error instanceof Error ? error.stack || error.message : String(error))
    if (installing) installing({ ok: false, reason: 'install-failed' })
    else if (verifying) {
      verifying = false
      fail('install-failed')
    }
  })
  // Squirrel 이 받은 앱의 서명까지 확인했다 — 끄면 바뀌고, [다시 시작] 이면 바로 바꾼다
  native.on('update-downloaded', () => {
    verifying = false
    phase = 'ready'
    readyVersion = status.latest
    if (!installing && !waitReady) running = false
    status = { ...status, reason: null }
    onChange()
    waitReady?.(true)
  })

  const view = () => ({ ...status, running, phase })

  async function check() {
    // 받는 중에는 다시 묻지 않는다
    if (running) return view()
    await look()
    onChange()
    return view()
  }

  function look(): Promise<void> {
    checking ??= ask().finally(() => {
      checking = null
    })
    return checking
  }

  async function ask(): Promise<void> {
    const ready = phase === 'ready'
    // 받아 둔 판이 있으면 저절로 받지 않게 묻는다 — 같은 판을 다시 받지 않고, 더 새 판일 때만 받는다(AppUpdater 는 확인 때 autoDownload 를 본다)
    if (ready) updater.autoDownload = false
    try {
      const result = await updater.checkForUpdates()
      if (ready) {
        const version = result?.isUpdateAvailable ? result.updateInfo.version : null
        if (version !== null && phase === 'ready' && newerThan(version, readyVersion)) {
          log.info(`받아 둔 ${readyVersion} 보다 새 ${version} 이 나왔다 — 새로 받는다`)
          phase = null
          status = { ...status, state: 'behind', reason: null, latest: version }
          background(updater.downloadUpdate())
        } else status = { ...status, reason: null }
      } else if (!result) status = { ...status, state: 'unavailable', reason: null, latest: null }
      else if (result.isUpdateAvailable) {
        status = { ...status, state: 'behind', reason: null, latest: result.updateInfo.version }
        if (result.downloadPromise) background(result.downloadPromise)
      } else status = { ...status, state: 'current', reason: null, latest: null }
    } catch {
      // 최신인지 모른다 — 앞서 본 새 버전은 그대로 두고 까닭만(기록은 'error' 가 남겼다) · 처음이면 줄을 보이게(current)
      status = { ...status, state: status.state === 'behind' ? 'behind' : 'current', reason: 'check-failed' }
    } finally {
      if (ready) updater.autoDownload = true
    }
  }

  // 확인이 시작한 뒤 받기 — 받는 동안 running(⚙ '받는 중…'). 다 받으면 Squirrel 의 서명 검사를 기다린다(native 'update-downloaded' 또는 'error').
  // 실패하면 까닭을 남기고 [업데이트] 로 다시 · 다음 확인(30분)이 다시 받는다
  function background(download: Promise<unknown>): void {
    running = true
    download.then(
      () => {
        if (phase !== 'ready') verifying = true
      },
      (error: unknown) => {
        if (phase !== 'ready') fail(downloadReason(error))
      },
    )
  }

  function fail(reason: ReleaseReason): ReleaseRunResult {
    running = false
    status = { ...status, reason }
    onChange()
    waitReady?.(false)
    return { ok: false, reason }
  }

  // [업데이트] — 받기 → 설치(교체가 시작되면 ok · 곧 앱이 꺼졌다 새 판으로 켜진다). 받아 둔 판이 있으면(ready) 피드를 한 번 더 보고 설치 —
  // 그 사이 더 새 판이 나왔으면 그 판을 받아 Squirrel 이 넘겨받은 뒤 설치(한 번 눌러 최신으로). 못 하면 앱은 그대로 · 까닭
  async function run(): Promise<ReleaseRunResult> {
    if (running) return { ok: false, reason: 'running' }
    if (phase === 'ready') {
      running = true
      status = { ...status, reason: null }
      onChange()
      await look()
      if (phase !== 'ready') {
        // 기다리기 전에 이미 받기가 실패했으면(fail 이 running 을 풀었다) 그 까닭으로 끝낸다
        if (!running) return { ok: false, reason: status.reason ?? 'download-failed' }
        const ready = await new Promise<boolean>((resolve) => {
          waitReady = resolve
        })
        waitReady = null
        if (!ready) return { ok: false, reason: status.reason ?? 'download-failed' }
      }
      return install()
    }
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
    return install()
  }

  // 받아 둔 판으로 바꾸기 — quitAndInstall(Squirrel 이 아직 서명 검사 중이면 MacUpdater 가 끝나길 기다렸다 바꾼다)
  async function install(): Promise<ReleaseRunResult> {
    running = true
    status = { ...status, reason: null }
    onChange()
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
