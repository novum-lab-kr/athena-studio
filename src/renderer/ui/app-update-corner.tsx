// 앱 업데이트 알림 — 창 좌측 하단 팝업(⚙ 설정의 앱 업데이트 줄과 같은 상태 · 같은 [업데이트]).
// 상태는 settings-pop.tsx appUpdateStore(main 이 보내는 값 — 바닐라 work.ts applyAppUpdate 가 넣는다).
// 가벼운 두 줄(새 버전 안내 · 지금 → 새 버전) + [업데이트] · 닫기만 — 변경 내역은 싣지 않는다. 새 버전이 있을 때(behind)만 보이고, ✕ 로 닫으면 같은 새 버전에는 다시 뜨지 않는다(localStorage). 설치가 끝난 뒤(다시 시작)는 설정에만 둔다
import { useState } from 'react'
import { mountIsland, useSay, useStore } from './bridge.ts'
import { appUpdateStore, runAppUpdate, updateNote } from './settings-pop.tsx'

const DISMISSED_KEY = 'studio.appUpdateDismissed'
const UP_ICON = ['M12 19V5', 'M6 11l6-6 6 6']
const CLOSE_ICON = ['M6 6l12 12', 'M18 6L6 18']

// 켤 때 한 번 — 칸(#app-update-corner)에 띄운다(내리지 않는다)
export function mount(box: HTMLElement): void {
  mountIsland(box, <AppUpdateCorner />)
}

// 닫은 기억의 열쇠 — 새 버전 이름(배포판 · 개발판 새 태그), 태그가 아직 없는 개발판은 뒤처진 커밋 수
function dismissKey(status: AppUpdateView): string {
  return status.latest || `behind:${status.behind}`
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function Icon({ paths }: { paths: string[] }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

function AppUpdateCorner() {
  const say = useSay()
  const { status, failure } = useStore(appUpdateStore)
  const [dismissed, setDismissed] = useState(readDismissed)
  if (!status || status.state !== 'behind' || status.phase === 'ready') return null
  const key = dismissKey(status)
  if (dismissed === key) return null
  const close = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, key)
    } catch {
      // 기억하지 못해도 이번에는 닫는다
    }
    setDismissed(key)
  }
  return (
    <div className="app-update-corner" role="status">
      <div className="app-update-corner-head">
        <span className="toast-icon" aria-hidden="true">
          <Icon paths={UP_ICON} />
        </span>
        <span className="app-update-corner-main">
          <span className="app-update-corner-title">{say('settings.appUpdateAvailable')}</span>
          <span className="app-update-corner-note">{updateNote(say, status, failure)}</span>
        </span>
        <button className="settings-app-button" type="button" disabled={status.running} onClick={() => void runAppUpdate()}>
          {say('settings.appUpdateButton')}
        </button>
        <button className="toast-close" type="button" aria-label={say('common.close')} onClick={close}>
          <Icon paths={CLOSE_ICON} />
        </button>
      </div>
    </div>
  )
}
