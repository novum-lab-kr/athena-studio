// ── 앱 업데이트(⚙ 설정 팝업 맨 아래 — 개발 앱 체크아웃 · 결정 D2 / 배포판 · 계획서 5단계) ─────────────
// 배포판(app.isPackaged)이면 lib/release-update.mts — electron-updater 로 공개 레포 최신 Release 의 .zip 을 받아(sha512) Squirrel.Mac 이
// 서명(같은 번들 ID · Team ID)을 확인한 뒤 바꿔 다시 켠다. 아래 git 흐름은 개발 앱 체크아웃만
// main.js 에서 옮겼다(PR3c) — electron(app · dialog) · 화면 문구(say) · 스튜디오 집 자리 · 팩 창 목록은 createAppUpdater 인자로 받는다.
// 앱 레포가 origin/main 보다 뒤처졌으면 창마다 알린다(⚙ 점 · [업데이트] 켜짐). 누르면 main 을 빨리 감기로만 받고(lib/app-update.mts),
// scripts/dev-app.js restart 를 떼어 띄운 뒤 앱을 끈다 — 도우미가 앱이 끝나길 기다려 npm install(필요할 때 · heavy.sh 줄 서기) → 다시 켠다.
// 다시 켜면 코어 번들을 새로 만들고 켤 때 본체를 업데이트한다(데몬 · pane 은 그대로 — 쉬는 세션은 막지 않는다 · D1)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import * as core from '../lib/core.mts'
import * as appUpdate from '../lib/app-update.mts'
import { createReleaseUpdate } from '../lib/release-update.mts'
import type { Logger, Native, Updater } from '../lib/release-update.mts'
import type { PullResult, UpdateStatus } from '../lib/app-update.mts'
import type { Say } from '../lib/pack.mts'

// studio-home · version 은 JS(dev-app.js 가 PATH 의 node 로도 부른다) — main 과 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const studioHome: typeof import('../lib/studio-home.js') = require('../lib/studio-home.js')
const versionModel: typeof import('../lib/version.js') = require('../lib/version.js')

type App = { isPackaged: boolean; getVersion(): string; getPath(name: 'userData'): string; quit(): void }
type Dialog = Pick<typeof import('electron').dialog, 'showMessageBox'>
type ParentWindow = import('electron').BrowserWindow | null | undefined
type PackWindow = { send(channel: string, payload: unknown): void }
// 화면에 보내는 상태 — 처음(아직 확인 전)에는 version · latest 칸이 없다
type Status = Omit<UpdateStatus, 'version' | 'latest'> & Partial<Pick<UpdateStatus, 'version' | 'latest'>>
type Pulled = Extract<PullResult, { ok: true }>

const APP_ROOT = path.join(import.meta.dirname, '..', '..')
export const APP_UPDATE_CHECK_MS = 30 * 60 * 1000
const APP_UPDATE_FETCH_GAP_MS = 60 * 1000 // 팝업을 자주 열어도 origin 은 이만큼에 한 번만 받는다

// app — 앱 정보 · 끄기 · dialog — 알림 창 · say — 화면 문구 · language — 지금 앱 언어(도우미 맥 알림 문구) · studio — 스튜디오 집 자리(heavy.sh) · packWindows — 열린 팩 창(main.mts 의 Set 그대로)
export function createAppUpdater({ app, dialog, say, language, studio, packWindows }: { app: App; dialog: Dialog; say: Say; language: () => string; studio: { core: string }; packWindows: Iterable<PackWindow> }) {
  const appUpdateLogFile = () => path.join(app.getPath('userData'), 'app-update.log')
  let appUpdateStatus: Status = { state: 'unavailable', behind: 0, branch: null, reason: null }
  let appUpdateRunning = false
  let appUpdateFetchedAt = 0
  let appUpdateChecking: Promise<ReturnType<typeof appUpdateView>> | null = null

  // 앱 버전(SemVer 0.x — 정본은 git 태그 · lib/version.js) — 개발 앱 체크아웃은 git describe(0.2.1 · 0.2.1+3), 태그가 없거나 배포판이면 package.json.
  // 켤 때 한 번 정한다(업데이트는 앱을 다시 켠다 · origin 태그는 scripts/dev-app.js start 가 그 전에 받는다). ⚙ 앱 업데이트 줄 · 맥 메뉴 정보 · 코어 번들에 같은 번호 —
  // ⚙ 확인이 나중에 태그를 더 받아도 지금 버전은 바꾸지 않는다(새 번호는 latest 로만)
  let appVersionCache: string | null = null
  function appVersion(): string {
    if (!appVersionCache) appVersionCache = (!app.isPackaged && versionModel.describeVersion({ repoRoot: APP_ROOT, env: studioHome.gitEnv() })) || app.getVersion()
    return appVersionCache
  }
  const appUpdateEnabled = () => !app.isPackaged && appUpdate.isCheckout(APP_ROOT)

  // 배포판 — 처음 부를 때 electron-updater 를 싣는다(개발판에서는 싣지 않는다). 기록은 개발판 업데이트와 같은 app-update.log
  let release: ReturnType<typeof createReleaseUpdate> | null = null
  let releaseCheckedAt = 0
  function releaseUpdate(): ReturnType<typeof createReleaseUpdate> {
    if (release) return release
    const { autoUpdater } = require('electron-updater') as { autoUpdater: Updater }
    const native = (require('electron') as { autoUpdater: Native }).autoUpdater
    release = createReleaseUpdate({ updater: autoUpdater, native, version: appVersion(), onChange: sendAppUpdate, log: fileLogger() })
    return release
  }
  function fileLogger(): Logger {
    const write = (level: string) => (message?: unknown) => {
      try {
        fs.mkdirSync(path.dirname(appUpdateLogFile()), { recursive: true })
        fs.appendFileSync(appUpdateLogFile(), `${new Date().toISOString()} [${level}] ${message instanceof Error ? message.stack || message.message : String(message)}\n`)
      } catch {
        // 기록을 못 남겨도 업데이트는 계속한다
      }
    }
    return { info: write('info'), warn: write('warn'), error: write('error') }
  }

  const appUpdateView = () => (app.isPackaged ? releaseUpdate().view() : { ...appUpdateStatus, version: appVersion(), running: appUpdateRunning })
  function sendAppUpdate(): void {
    for (const each of packWindows) each.send('app-update:status', appUpdateView())
  }

  function checkAppUpdate(): Promise<ReturnType<typeof appUpdateView>> {
    if (app.isPackaged) {
      // 피드(latest-mac.yml)는 작다 — 그래도 팝업을 자주 열면 이만큼에 한 번만 묻는다
      if (Date.now() - releaseCheckedAt < APP_UPDATE_FETCH_GAP_MS) return Promise.resolve(appUpdateView())
      releaseCheckedAt = Date.now()
      return releaseUpdate().check()
    }
    if (!appUpdateEnabled() || appUpdateRunning) return Promise.resolve(appUpdateView())
    if (appUpdateChecking) return appUpdateChecking
    const fetch = Date.now() - appUpdateFetchedAt > APP_UPDATE_FETCH_GAP_MS
    appUpdateChecking = appUpdate
      .checkStatus({ repoRoot: APP_ROOT, fetch })
      .then((status) => {
        if (fetch) appUpdateFetchedAt = Date.now()
        appUpdateStatus = status
        sendAppUpdate()
        return appUpdateView()
      })
      .catch(() => appUpdateView())
      .finally(() => (appUpdateChecking = null))
    return appUpdateChecking
  }

  // [업데이트] — 받기 → 도우미 띄우기 → 앱 끄기. 못 하면 { ok: false, reason } (팝업이 까닭을 보인다)
  async function runAppUpdate(): Promise<{ ok: boolean; reason?: string }> {
    if (app.isPackaged) return releaseUpdate().run()
    if (!appUpdateEnabled()) return { ok: false, reason: 'unavailable' }
    if (appUpdateRunning) return { ok: false, reason: 'running' }
    appUpdateRunning = true
    sendAppUpdate()
    const pulled = await appUpdate.pullMain({ repoRoot: APP_ROOT }).catch(() => ({ ok: false, reason: 'ff-failed' }) as PullResult)
    if (!pulled.ok) {
      appUpdateRunning = false
      appUpdateStatus = await appUpdate.checkStatus({ repoRoot: APP_ROOT, fetch: false }).catch(() => appUpdateStatus)
      sendAppUpdate()
      return pulled
    }
    const nodePath = core.findExecutable('node', process.env.PATH)
    // --lang — 앱이 꺼진 사이 도우미가 띄우는 맥 알림(heavy.sh 대기 · install 포기 · 실패)을 지금 앱 언어로
    const args = [path.join(APP_ROOT, 'scripts', 'dev-app.js'), 'restart', '--after', String(process.pid), '--lang', language()]
    const heavy = path.join(studio.core, 'scripts', 'heavy.sh')
    if (pulled.install) args.push('--install', ...(fs.existsSync(heavy) ? ['--heavy', heavy] : []))
    // 자식 환경은 childEnv 로 — 다시 켜진 앱이 켤 때 읽는 값(격리 실행 ATHENA_STUDIO_HOME 등)만 다시 싣는다(core.relaunchEnv)
    const env = core.relaunchEnv(process.env, { electronAsNode: !nodePath })
    // 도우미가 실제로 떴는지('spawn') 확인한 뒤에만 앱을 끈다 — 실행 파일을 못 여는 등의 실패는 비동기 'error' 로 온다
    const started = await startRestartHelper(nodePath || process.execPath, args, env, pulled)
    if (!started) {
      // 받기는 됐다 — 다시 켜기만 사람 몫
      appUpdateRunning = false
      sendAppUpdate()
      return { ok: false, reason: 'restart-failed' }
    }
    setTimeout(() => app.quit(), 200)
    return { ok: true }
  }

  // 다시 켜기 도우미를 떼어 띄운다 — 떴으면 true, 못 띄웠으면(동기 예외 · 'error' 이벤트) false
  async function startRestartHelper(file: string, args: string[], env: NodeJS.ProcessEnv, pulled: Pulled): Promise<boolean> {
    let out: number | null = null
    try {
      fs.mkdirSync(path.dirname(appUpdateLogFile()), { recursive: true })
      out = fs.openSync(appUpdateLogFile(), 'a')
      fs.writeSync(out, `\n── ${new Date().toISOString()} app update ${pulled.from.slice(0, 12)}..${pulled.to.slice(0, 12)}${pulled.install ? ' · npm install' : ''}\n`)
      const child = spawn(file, args, { cwd: APP_ROOT, env, detached: true, stdio: ['ignore', out, out] })
      const started = await new Promise<boolean>((resolve) => {
        child.once('spawn', () => resolve(true))
        child.once('error', () => resolve(false))
      })
      if (started) child.unref()
      return started
    } catch {
      return false
    } finally {
      if (out !== null) fs.closeSync(out)
    }
  }

  // 지난 업데이트의 npm install · 화면 빌드가 실패했으면(도우미 scripts/dev-app.js 가 알린다) 켤 때 한 번 알린다 — 화면 빌드 실패면 이전 빌드로 켜진 것
  function showAppUpdateNotice(parentWindow: ParentWindow): void {
    const failed = process.env.ATHENA_STUDIO_APP_UPDATE
    if (failed !== 'install-failed' && failed !== 'build-failed') return
    const detailKey = failed === 'install-failed' ? 'dialog.appUpdate.installFailed' : 'dialog.appUpdate.buildFailed'
    const options = { type: 'warning' as const, message: say('dialog.appUpdate.message'), detail: say(detailKey, { path: appUpdateLogFile() }) }
    ;(parentWindow ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options)).catch(() => null)
  }

  return { appVersion, appUpdateView, checkAppUpdate, runAppUpdate, showAppUpdateNotice }
}
