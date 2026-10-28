// ⚙ 설정 팝업 몸통(settings-pop-body) — 이 창 팩의 레포별 PR 자동 리뷰 · 머지 + 앱 업데이트 줄
// 첫 React 화면(PR-R4). 팝업 껍데기(열기 · 닫기 · 머리줄 팩 이름 · Esc · 바깥 누르기)는 바닐라 work.ts, 몸통만 여기서 그린다
// 읽기는 main 이 pack.json 을 바로, 바꾸기는 코어 pack set-auto-merge. 바꿀 때마다 pack.json 을 다시 읽어 그린다(파일이 정본)
import { useCallback, useEffect, useRef, useState } from 'react'
import { createStore, mountIsland, showToast, useSay, useStore } from './bridge.ts'
import type { Say } from './bridge.ts'

// 앱 업데이트 상태 — main 이 보내는 값(onAppUpdate)을 바닐라가 넣는다. failure 는 방금 누른 [업데이트] 가 못 한 까닭(다음 상태가 오면 지운다)
const appUpdateStore = createStore<{ status: AppUpdateView | null; failure: string | null }>({ status: null, failure: null })

export function setAppUpdate(next: AppUpdateView | null): void {
  appUpdateStore.set({ status: next, failure: null })
}

let unmount: (() => void) | null = null

// 팝업이 열릴 때 — 열 때마다 새로 그린다(읽는 중부터)
export function open(container: HTMLElement): void {
  close()
  unmount = mountIsland(container, <SettingsBody container={container} />)
  void studio.checkAppUpdate() // 상태는 onAppUpdate 로 온다
}

export function close(): void {
  if (!unmount) return
  unmount()
  unmount = null
}

// rows: null — 읽는 중 · false — pack.json 을 못 읽음
type Rows = MergeRepo[] | null | false

function SettingsBody({ container }: { container: HTMLElement }) {
  const say = useSay()
  const [rows, setRows] = useState<Rows>(null)
  const [focusKey, setFocusKey] = useState<{ key: string | undefined } | null>(null)
  const saving = useRef(false)
  const alive = useRef(true)

  // 다시 읽어 그리고, 누르던 스위치에 포커스를 돌려준다(처음 열 때는 첫 버튼)
  const load = useCallback(async (key?: string) => {
    const result = await studio.mergeSettings()
    if (!alive.current) return // 그사이 팝업이 닫혔다
    setRows(result && result.ok ? result.repos : false)
    setFocusKey({ key })
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  useEffect(() => {
    if (!focusKey) return
    const target = [...container.querySelectorAll('button')].find((node) => !focusKey.key || node.dataset.key === focusKey.key)
    if (target) target.focus({ preventScroll: true })
  }, [focusKey, container])

  const save = async (repo: MergeRepo, values: { autoMerge?: boolean; confirm?: boolean }, key: string) => {
    if (saving.current) return
    saving.current = true
    const result = await studio.setAutoMerge(repo.name, values)
    saving.current = false
    if (!result || !result.ok) showToast(say('settings.saveFailed', { message: (result && result.text) || '' }))
    await load(key)
  }

  return (
    <>
      <MergeSection rows={rows} say={say} save={save} />
      <AppUpdate say={say} />
    </>
  )
}

type SaveMerge = (repo: MergeRepo, values: { autoMerge?: boolean; confirm?: boolean }, key: string) => void

function MergeSection({ rows, say, save }: { rows: Rows; say: Say; save: SaveMerge }) {
  if (rows === null) return <p className="work-empty">{say('work.loading')}</p>
  if (rows === false) return <p className="work-empty">{say('settings.unreadable')}</p>
  if (!rows.length) return <p className="work-empty">{say('settings.empty')}</p>
  return (
    <>
      <div className="settings-intro">
        <h3 className="settings-intro-title">{say('settings.mergeTitle')}</h3>
        <p className="settings-intro-desc">{say('settings.mergeDesc')}</p>
      </div>
      {rows.map((repo) => <RepoSection key={repo.name} repo={repo} say={say} save={save} />)}
    </>
  )
}

// 레포 묶음 — 레포 이름 줄이 자동 머지 스위치, 들여쓴 하위 줄이 머지 전 확인(자동 머지가 꺼지면 뜻이 없어 숨긴다)
function RepoSection({ repo, say, save }: { repo: MergeRepo; say: Say; save: SaveMerge }) {
  return (
    <section className="settings-repo">
      <Switch id={`${repo.name}:auto`} kind="repo" label={repo.name} checked={repo.autoMerge} onClick={() => save(repo, { autoMerge: !repo.autoMerge }, `${repo.name}:auto`)} />
      {repo.autoMerge && <Switch id={`${repo.name}:confirm`} kind="sub" label={say('settings.confirm')} checked={repo.confirm} onClick={() => save(repo, { confirm: !repo.confirm }, `${repo.name}:confirm`)} />}
      {/* 작업 base 가 운영 브랜치와 같은데 확인을 끄면 머지가 곧 그 브랜치 반영 */}
      {repo.autoMerge && !repo.confirm && repo.releaseOnMerge && <p className="settings-note">{say('settings.releaseWarn', { branch: repo.prBase })}</p>}
    </section>
  )
}

function Switch({ id, kind, label, checked, onClick }: { id: string; kind: 'repo' | 'sub'; label: string; checked: boolean; onClick: () => void }) {
  return (
    <button className={`settings-switch ${kind}`} type="button" data-key={id} role="switch" aria-checked={String(checked) as 'true' | 'false'} onClick={onClick}>
      <span className="settings-switch-label">{label}</span>
      <span className="settings-switch-track" />
    </button>
  )
}

// ── 앱 업데이트(설정 맨 아래) — 개발 앱 체크아웃은 origin/main 보다 뒤처졌을 때 · 배포판은 공개 레포에 새 버전이 있을 때만 [업데이트] 가 켜진다(⚙ 의 점은 work.ts)
// 개발판: main 받기(빨리 감기만) → 필요하면 npm install → 앱 다시 켜기 / 배포판: .zip 받기(sha512) → 서명 확인 · 바꾸기 · 다시 켜기(main runAppUpdate). 못 하면 까닭을 회색 한 줄로
function reasonText(say: Say, reason: string | null, branch: string | null): string {
  if (reason === 'not-main') return say('settings.appUpdateNotMain', { branch: branch || '-' })
  if (reason === 'dirty') return say('settings.appUpdateDirty')
  if (reason === 'diverged') return say('settings.appUpdateDiverged')
  if (reason === 'fetch-failed') return say('settings.appUpdateFetchFailed')
  if (reason === 'ff-failed') return say('settings.appUpdateFfFailed')
  if (reason === 'restart-failed') return say('settings.appUpdateRestartFailed')
  // 배포판(src/lib/release-update.mts)
  if (reason === 'check-failed') return say('settings.appUpdateCheckFailed')
  if (reason === 'download-failed') return say('settings.appUpdateDownloadFailed')
  if (reason === 'checksum-failed') return say('settings.appUpdateChecksumFailed')
  if (reason === 'install-failed') return say('settings.appUpdateInstallFailed')
  return ''
}

function updateNote(say: Say, status: AppUpdateView, failure: string | null): string {
  if (status.running) return say('settings.appUpdateRunning')
  if (failure) return reasonText(say, failure, status.branch) || say('settings.appUpdateCurrent')
  if (status.reason && status.state === 'behind') return reasonText(say, status.reason, status.branch)
  // origin(개발판) · 피드(배포판)에서 못 받았으면 최신인지 모른다 — '최신이에요' 대신 까닭
  if (status.reason === 'fetch-failed' || status.reason === 'check-failed') return reasonText(say, status.reason, status.branch)
  // origin/main 에 새 버전 태그가 있으면 '0.2.1 → 0.3.0' · 아직 없으면 커밋 수
  if (status.state === 'behind' && status.latest) return say('settings.appUpdateNewVersion', { current: status.version || '-', next: status.latest })
  if (status.state === 'behind') return say('settings.appUpdateBehind', { count: status.behind })
  return say('settings.appUpdateCurrent')
}

async function runAppUpdate() {
  const { status } = appUpdateStore.get()
  if (!status || status.running) return
  const result = await studio.runAppUpdate()
  if (result && result.ok) return // 앱이 곧 꺼졌다 다시 켜진다
  appUpdateStore.set({ ...appUpdateStore.get(), failure: (result && result.reason) || 'ff-failed' })
}

function AppUpdate({ say }: { say: Say }) {
  const { status, failure } = useStore(appUpdateStore)
  if (!status || status.state === 'unavailable') return null
  return (
    <section className="settings-app-update">
      <div className="settings-app-row">
        <span className="settings-app-label">
          {say('settings.appUpdate')}
          {/* 지금 버전 — 늘 */}
          {status.version && <span className="settings-app-version">{say('settings.appUpdateVersion', { version: status.version })}</span>}
        </span>
        <button className="settings-app-button" type="button" data-key="app-update" disabled={status.state !== 'behind' || status.running} onClick={runAppUpdate}>
          {say('settings.appUpdateButton')}
        </button>
      </div>
      <p className="settings-note settings-app-note">{updateNote(say, status, failure)}</p>
    </section>
  )
}
