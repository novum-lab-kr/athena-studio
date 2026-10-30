// ── 아테나 폴더 · 스튜디오 코어 준비 · 코어 · 팩 명령 실행 — 공용 ─────────────────
// main.js 에서 옮겼다(PR3c) — electron(app · dialog) · 화면 문구(say) · 지금 언어 · 스튜디오 집 자리 · 코어 번들 · 데몬 자리 · 팩 로그 자리는
// createCoreRunner 인자로 받는다
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import * as core from '../lib/core.mts'
import * as packModel from '../lib/pack.mts'
import * as i18n from '../lib/i18n.mts'
import * as daemonClient from '../daemon-client.mts'
import * as releaseNotes from '../lib/release-notes.mts'
import type { PackResult, Say } from '../lib/pack.mts'
import type { CoreUpdateRow, CoreUpdateView } from '../lib/release-notes.mts'

// studio-home · screen-model 은 JS — main 과 같은 require 캐시의 것을 쓴다
const require = createRequire(import.meta.url)
const studioHome: typeof import('../lib/studio-home.js') = require('../lib/studio-home.js')
const screenModel: typeof import('../lib/screen-model.js') = require('../lib/screen-model.js')

type App = { getPath(name: 'home' | 'userData'): string }
type Shell = Pick<typeof import('electron').shell, 'openPath'>
type ParentWindow = import('electron').BrowserWindow | null | undefined
type Layout = ReturnType<typeof studioHome.studioLayout>
// 켤 때 코어 업데이트 결과(studio-home updateCore) — 읽는 칸만
type CoreUpdate = { state: string; head?: string | null; target?: string | null; fromVersion?: string | null; error?: unknown; summary?: ReturnType<typeof studioHome.summarizeUpdate> }
// prepareCore 결과 — 읽는 칸만(풀기 · 설정 실패 결과와 성공 결과가 섞인다)
type Prepared = { ok: boolean; created?: boolean; error?: string; message?: string; file?: string; update?: CoreUpdate | null }
export type Progress = { step: string; text: string }
export type RunCoreOptions = { dir?: string | null; onProgress?: ((step: Progress) => void) | null; signal?: AbortSignal | null; extraEnv?: Record<string, string> | null; contract?: boolean }

export const PACK_TIMEOUTS: Record<string, number> = { repo: 120000, 'restore-work': 300000, update: 300000, list: 20000, status: 20000, busy: 30000, use: 180000, inspect: 300000, 'import-athena': 300000, import: 180000, export: 180000, backup: 300000, delete: 300000, new: 180000, open: 180000, version: 15000, 'board-token': 15000, request: 15000 }

// ATHENA_STUDIO_FAKE_PACK=1 이면 본체 대신 scripts/fake-pack.js(같은 약속의 가짜)를 부른다 — 화면 확인용
function packScript(dir: string): string {
  if (process.env.ATHENA_STUDIO_FAKE_PACK === '1') return path.join(import.meta.dirname, '..', '..', 'scripts', 'fake-pack.js')
  return path.join(dir, 'scripts', 'athena.mjs')
}

// 내역 번역 파일(src/changelog/<언어>.json) 자리 · 내역 원문(CHANGELOG.md — 개발 앱은 레포 뿌리, 배포판은 Resources 에 실린다)
const CHANGELOG_DIR = path.join(import.meta.dirname, '..', 'changelog')
export const changelogFile = (packaged: boolean, resourcesPath: string): string => (packaged ? path.join(resourcesPath, 'CHANGELOG.md') : path.join(import.meta.dirname, '..', '..', 'CHANGELOG.md'))

function readJson(file: string): Record<string, string> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
  } catch {
    return null
  }
}

// app — 홈 · 앱 데이터 자리 · shell — 폴더 열기 · changelog — 내역 원문 파일 · say — 화면 문구 · language — 지금 언어 · studio — 스튜디오 집 자리 · coreBundle — 앱이 들고 온 코어 번들 ·
// daemonPaths — 데몬 소켓 자리 · packLogFile — 팩 로그 자리(main.mts)
export function createCoreRunner({ app, shell, changelog, say, language, studio, coreBundle, daemonPaths, packLogFile }: { app: App; shell: Shell; changelog: string; say: Say; language: () => string; studio: Layout; coreBundle: string; daemonPaths: () => ReturnType<typeof core.daemonPaths>; packLogFile: () => string }) {
  // ── 아테나 폴더 — 공용 ──────────────────────────────────────
  // 새로 만드는 athena.config.json 의 reposRoot — 스튜디오 집 안 본체면 홈(회사 레포 클론 · 두 앱이 같이 쓴다), 직접 고른 폴더면 ..
  const athenaReposRoot = (dir: string) => core.reposRootFor(dir, { studioRoot: studio.root, home: app.getPath('home') })

  // 스튜디오 코어 준비 — 없으면 들고 온 번들에서 ~/.athena-studio/core 로 풀고, 본체 설정(dataDir · screen) · 레지스트리 손잡이(bodiesDir · portBase)를 채운다.
  // update: 이미 있던 본체면 번들이 앞일 때 업데이트(켤 때만 — 창을 열기 전, 아무 창도 본체를 쓰지 않을 때). 결과 기록은 pack.log
  let coreUpdateNotice: CoreUpdate | null = null // 켤 때 업데이트에서 알릴 것(건너뛴 본체 · 백업 · 실패) — 첫 창이 뜬 뒤 보여 준다
  // 예외(git 이 없음 · 쓰기 실패 등)도 결과로 — 켤 때 창이 안 뜨는 일이 없게
  async function prepareStudioCore({ update }: { update: boolean }): Promise<Prepared> {
    let result: Prepared
    try {
      result = (await studioHome.prepareCore({
        layout: studio,
        bundle: coreBundle,
        home: app.getPath('home'),
        update,
        // 업데이트 경로는 약속 번호를 싣지 않는다(studio-home updateCore 가 { contract: false } 를 넘긴다)
        runCore: (argv, options) => runCore(argv, { ...options, dir: studio.core }),
        panesStateFile: writePanesState,
      })) as Prepared
    } catch (error) {
      result = { ok: fs.existsSync(studio.core), error: 'prepare-failed', message: (error as Error).message, update: null }
    }
    logCore(`prepare ${JSON.stringify({ ok: result.ok, created: result.created, error: result.error, update: result.update && { state: result.update.state, head: result.update.head, target: result.update.target, error: result.update.error } })}`)
    const updated = result.update
    if (updated && updated.summary && updated.summary.notify) coreUpdateNotice = updated
    else if (updated && ['unsupported', 'ff-failed', 'diverged', 'fetch-failed'].includes(updated.state)) coreUpdateNotice = updated
    return result
  }

  // 켤 때 업데이트 전 — 떠 있는 데몬의 pane 상태를 파일로(코어 update --panes-state · 쉬는 세션은 막지 않는다 · 결정 D1).
  // 데몬이 없거나(띄우지 않는다) 옛 프로토콜이거나 못 읽으면 null — 코어는 지금처럼 모든 세션을 막는다.
  // 데몬이 idle 로 본 에이전트 pane 도 화면을 읽어 비어 있는 입력칸일 때만 idle 로 남긴다 — 질문 · 고르기 창 · 쓰던 글 · 뒤에서 도는 하위 작업 · 못 읽음은 막는 쪽(waiting)
  async function writePanesState(): Promise<string | null> {
    const connection = await daemonClient.peekDaemon({ paths: daemonPaths() }).catch(() => null)
    if (!connection) return null
    try {
      // 데몬 답 — 읽는 칸만(모양 검사는 하지 않는다)
      const listed = (await connection.call('pane list')) as { panes?: { id: string; agent?: string; agent_status?: string }[] } | null
      const shells = (await connection.call('pane pids')) as { pids?: Record<string, unknown> } | null
      const panes = (listed && listed.panes) || []
      const busy: string[] = []
      for (const pane of panes) {
        if (!pane.agent || pane.agent_status !== 'idle') continue
        const read = (await connection.call('pane read', { pane: pane.id, lines: 40, source: 'visible' }).catch(() => null)) as { text?: unknown } | null
        const text = read && typeof read.text === 'string' ? read.text : null
        const empty = text !== null && !screenModel.waitingForInput(text) && (pane.agent !== 'claude' || core.claudeAtEmptyPrompt(text))
        if (!empty) busy.push(pane.id)
      }
      const state = studioHome.panesState({ panes, pids: (shells && shells.pids) || {}, waiting: busy })
      const file = path.join(app.getPath('userData'), 'panes-state.json')
      await fs.promises.writeFile(file, `${JSON.stringify(state)}\n`)
      return file
    } catch {
      return null
    } finally {
      connection.destroy()
    }
  }

  // 켤 때 업데이트 결과 팝업에 보일 줄 — 본체를 건너뛰었거나 · 일하는 세션이 있었지만 바로 올렸거나 · 고친 코어 파일을 백업했거나 · 못 했으면
  function noticeRows(notice: CoreUpdate): CoreUpdateRow[] {
    const summary = notice.summary
    if (!summary) return [{ kind: notice.state === 'unsupported' ? 'unsupported' : 'notMoved', params: { reason: String(notice.error || notice.state) }, chips: [] }]
    const rows: CoreUpdateRow[] = []
    // 무엇이 막았는지 — 짝지은 pane 이름(없으면 코어 설명). 모르면 까닭(busy · dirty …)
    if (summary.skipped.length) rows.push({ kind: 'skipped', params: {}, chips: summary.skipped.map((entry) => ((entry.blockers || []).length ? `${entry.id} · ${entry.blockers.join(', ')}` : `${entry.id} · ${entry.reason}`)) })
    for (const entry of summary.working || []) rows.push({ kind: 'working', params: { count: Number(entry.count) }, chips: [String(entry.id), ...(entry.sessions || []).map(String)] })
    for (const entry of summary.backedUp) rows.push({ kind: 'backedUp', params: {}, chips: [String(entry.id)], dir: entry.dir ? String(entry.dir) : undefined })
    if (summary.failed.length) rows.push({ kind: 'failed', params: {}, chips: summary.failed.map((entry) => `${entry.id} · ${entry.error}`) })
    return rows
  }

  // 새 코어의 사람이 읽는 버전 — 코어 version --json 의 version(태그가 없으면 null)
  async function currentCoreVersion(): Promise<string | null> {
    const result = (await runCore(['version'], { dir: studio.core, contract: false }).catch(() => null)) as { version?: unknown } | null
    return result && typeof result.version === 'string' ? result.version : null
  }

  // 이전 → 새 버전 사이 내역 — CHANGELOG.md 의 절을 고르고 지금 언어 번역(없으면 영어)으로. 읽지 못하거나 해당 절이 없으면 null
  function notesFor(from: string | null, to: string | null): CoreUpdateView['notes'] {
    let text: string
    try {
      text = fs.readFileSync(changelog, 'utf8')
    } catch {
      return null
    }
    // 언어는 보낼 때 고정하지 않는다 — 언어별 번역을 모두 실어 보내고 화면이 지금 언어로 고른다(팝업이 떠 있는 동안 언어를 바꿔도 따라간다)
    const tables = Object.fromEntries(['ko', 'ja', 'zh'].map((lang) => [lang, readJson(path.join(CHANGELOG_DIR, `${lang}.json`))]))
    const picked = releaseNotes.pickNotes(releaseNotes.notesBetween(releaseNotes.parseChangelog(text), from, to), (line) => line)
    return releaseNotes.withTranslations(picked, tables)
  }

  // 알릴 백업 폴더 — 화면이 [폴더 열기] 로 부를 수 있는 것은 이 팝업이 보인 폴더뿐
  const revealable = new Set<string>()
  async function revealCoreUpdateBackup(dir: string): Promise<boolean> {
    if (!revealable.has(dir)) return false
    return (await shell.openPath(dir)) === ''
  }

  // 켤 때 업데이트 결과 — 알릴 것이 있으면 첫 창에 한 번 보낸다(앱 안 팝업 · 화면은 core-update:show 를 받는다). 알릴 것이 없으면 띄우지 않는다
  async function showCoreUpdateNotice(parentWindow: ParentWindow): Promise<void> {
    const notice = coreUpdateNotice
    coreUpdateNotice = null
    if (!notice) return
    const rows = noticeRows(notice)
    if (!rows.length) return
    // 제목 · 버전 · 내역은 실제로 새 코어로 바뀐 본체가 있을 때만
    const changed = Boolean(notice.summary && notice.summary.updated.length > 0)
    const from = changed ? notice.fromVersion || null : null
    const to = changed ? await currentCoreVersion() : null
    const showVersions = Boolean(from && to && from !== to)
    const view: CoreUpdateView = { changed, from: showVersions ? from : null, to: showVersions ? to : null, notes: showVersions ? notesFor(from, to) : null, rows, releasesUrl: releaseNotes.RELEASES_URL }
    for (const row of rows) if (row.dir) revealable.add(row.dir)
    if (!parentWindow || parentWindow.isDestroyed()) return
    const contents = parentWindow.webContents
    // 화면이 아직 읽는 중이면 다 읽은 뒤에(화면 진입점이 core-update:show 를 받을 준비를 마친다)
    if (contents.isLoading()) contents.once('did-finish-load', () => contents.send('core-update:show', view))
    else contents.send('core-update:show', view)
  }

  // 코어를 풀지 못한 까닭 — 화면 문구로
  function coreInstallError(prepared: Prepared): string {
    if (prepared.error === 'bundle-missing') return say('error.coreBundleMissing', { path: coreBundle })
    return say('error.coreInstall', { message: prepared.message || prepared.file || prepared.error })
  }

  function logCore(line: string): void {
    fs.mkdir(path.dirname(packLogFile()), { recursive: true }, () => fs.appendFile(packLogFile(), `\n── ${new Date().toISOString()} studio-core ${line}\n`, () => {}))
  }

  // ── 회사 팩 — 본체 명령(공용) ────────────────────────────────
  // 셸을 거치지 않고 실행 · progress 줄은 그때그때 화면에 · 원문(stderr)은 화면에 넘기지 않고 pack.log 에만
  // 본체 명령 — `athena.mjs <argv…> --json`. 약속 번호를 알린다(ATHENA_CONTRACT — 다르면 본체가 contract-mismatch).
  // contract: false — 코어 업데이트 경로(version · update --from)만. 약속이 오른 앱이 옛 코어를 올릴 수 있게(studio-home updateCore)
  // dir = 그 명령을 부를 본체(창마다 다르다 — '지금 팩' 은 부른 본체의 팩)
  // extraEnv — 화면 계층(데몬)을 써야 하는 명령(restore-work 가 delegate.sh 로 pane 을 띄운다)만 데몬 접속 값을 넘긴다
  // 옛 코어가 모르는 명령이면 사용법만 찍고 끝나 "알 수 없는 답"(bad-output)이 된다 — 그때만 같은 본체에 version 을 물어
  // 약속 번호 · capabilities 로 옛 코어인지 가려 core-old 로 바꾼다(packModel.coreTooOld · 2026-10-26 pack set-repo-icon)
  async function runCore(argv: string[], options: RunCoreOptions = {}): Promise<PackResult> {
    const result = await runCoreOnce(argv, options)
    if (!result || result.error !== 'bad-output' || argv[0] === 'version' || !options.dir) return result
    const version = await runCoreOnce(['version'], { dir: options.dir, contract: false })
    return packModel.coreTooOld(argv, version) ? { ok: false, error: 'core-old' } : result
  }

  function runCoreOnce(argv: string[], { dir, onProgress = null, signal = null, extraEnv = null, contract = true }: RunCoreOptions = {}): Promise<PackResult> {
    return new Promise((resolve) => {
      if (!dir) return resolve({ ok: false, error: 'not-found', message: say('error.athenaCoreUnset') })
      const nodePath = core.findExecutable('node', process.env.PATH)
      const env = core.childEnv(process.env, { ...(contract ? { ATHENA_CONTRACT: String(packModel.CONTRACT) } : {}), ...(nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' }), ...(extraEnv || {}) })
      if (!contract) delete env.ATHENA_CONTRACT // 앱을 켤 때 물려받은 값도 싣지 않는다
      let child: ChildProcess
      try {
        child = spawn(nodePath || process.execPath, [packScript(dir), ...argv, '--json'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        return resolve({ ok: false, error: 'bad-output', message: (error as Error).message })
      }
      let output = ''
      let rest = ''
      let errors = ''
      let settled = false
      const finish = (result: PackResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(timer)
        if (errors.trim()) fs.appendFile(packLogFile(), `\n── ${new Date().toISOString()} ${argv.slice(0, 2).join(' ')}\n${errors.slice(-20000)}`, () => {})
        resolve(result)
      }
      // 시간 초과 · 취소는 SIGTERM — 본체가 임시본을 지우거나 되돌리고 끝낸다. 결과는 프로세스가 실제로 끝난 뒤에(그 전에 다음 단계로 가지 않게).
      // 15초 안에 안 끝나면 SIGKILL
      let forced: PackResult | null = null
      const stop = (reason: string) => {
        if (forced) return
        forced = { ok: false, error: reason }
        child.kill('SIGTERM')
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 15000).unref()
      }
      // R3 — 팩을 바꾸거나 본체를 만들거나 옮기는 명령(use · new · open · import --replace · update)은 시간이 넘어도 끄지 않는다(중간에 끊으면 반쯤 바뀐다). "오래 걸려요" 만 알리고 기다린다
      const sub = (argv[0] === 'pack' ? argv[1] : argv[0]) as string // 시간 초과는 pack 하위 명령(또는 version 같은 최상위 명령) 이름으로
      // restore-work 도 — 워크트리를 만들고 pane 을 띄우는 중에 끊으면 반쯤 된다
      const changesPack = ['use', 'new', 'open', 'update', 'restore-work', 'delete'].includes(sub) || (sub === 'import' && argv.includes('--replace'))
      const slow = () => onProgress && onProgress({ step: 'slow', text: say('pack.step.slow') })
      const timer = changesPack ? setInterval(slow, PACK_TIMEOUTS[sub] || 60000) : setTimeout(() => stop('timeout'), PACK_TIMEOUTS[sub] || 60000)
      if (signal) signal.addEventListener('abort', () => stop('canceled'), { once: true })
      // stdio 가 pipe 라 stdout · stderr 가 있다
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        output += chunk
        const split = packModel.splitLines(rest, chunk)
        rest = split.rest
        for (const line of split.lines) {
          const step = packModel.parseProgressLine(line, say)
          // 본체 설명은 한국어(번역 범위 밖) — 한국어가 아니면 아는 단계는 사전 이름으로 보인다
          if (step && language() !== i18n.FALLBACK_LANGUAGE) step.text = packModel.stepLabel(step.step, say) || step.text
          if (step && onProgress) onProgress(step)
        }
      })
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (chunk: string) => (errors += chunk))
      child.on('error', (error) => finish({ ok: false, error: 'bad-output', message: error.message }))
      child.on('close', () => {
        const parsed = packModel.parsePackOutput(output, say)
        if (!forced && parsed.result.error === 'bad-output' && parsed.raw) errors += `\n[JSON 이 아닌 마지막 줄] ${parsed.raw}`
        finish(forced || parsed.result)
      })
    })
  }

  const runPack = (args: string[], options: RunCoreOptions) => runCore(['pack', ...args], options)

  // 본체의 약속 번호 — `version --json`. 명령이 없으면(옛 코어 · 사용법 오류) 1 · 일시 실패면 null.
  // 본체를 업데이트하면 바뀌므로 기억하지 않고 부를 때마다 묻는다(팩을 열거나 만들거나 가져올 때만 — 가볍다)
  async function coreContract(dir: string | null | undefined): Promise<{ contract: number | null; core: string | null }> {
    if (!dir) return { contract: null, core: null }
    return packModel.contractOf(await runCore(['version'], { dir }))
  }

  // 옛 코어(약속 1 · version 명령 없음)면 팩을 열거나 · 만들거나 · 가져오는 일은 막고 업데이트를 안내한다.
  // 본체를 바꾸는 명령보다 **먼저** 부른다
  async function contractBlock(dir: string | null | undefined) {
    const known = await coreContract(dir)
    if (known.contract === packModel.CONTRACT) return null
    if (known.contract === null) return { ok: false, error: 'contract-unknown', text: say('pack.contract.unknown') } // 확인 못 함 — 옛 코어라고 단정하지 않는다
    // 본체 약속이 낮으면 본체 업데이트 안내 · 높으면 스튜디오 업데이트 안내
    return { ok: false, error: 'contract-mismatch', contract: known.contract, text: say(known.contract < packModel.CONTRACT ? 'pack.contract.old' : 'pack.contract.other', { contract: known.contract }) }
  }

  return { athenaReposRoot, prepareStudioCore, showCoreUpdateNotice, revealCoreUpdateBackup, coreInstallError, runCore, runPack, contractBlock }
}
