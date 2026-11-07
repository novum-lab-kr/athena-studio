// 앱 업데이트 알림 — 창 좌측 하단 팝업(⚙ 설정의 앱 업데이트 줄과 같은 상태 · 같은 [다시 시작]).
// 상태는 settings-pop.tsx appUpdateStore(main 이 보내는 값 — 바닐라 work.ts applyAppUpdate 가 넣는다).
// 새 판이 준비됐을 때(phase ready)만 뜬다 — 배포판은 뒤에서 받아 Squirrel 서명 검사까지 끝났을 때, 개발판은 npm install 이 끝나 다시 시작만 남았을 때(2026-11-07 사용자 결정).
// [나중에] 면 같은 새 판에는 다시 뜨지 않는다(localStorage) · [재시작하여 업데이트] 는 ⚙ [다시 시작] 과 같은 restartAppUpdate
import { useState } from 'react'
import { mountIsland, useSay, useStore } from './bridge.ts'
import { appUpdateStore, restartAppUpdate, updateNote } from './settings-pop.tsx'

const DISMISSED_KEY = 'studio.appUpdateDismissed'
const UP_ICON = ['M12 19V5', 'M6 11l6-6 6 6']

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
  if (!status || status.phase !== 'ready') return null
  const key = dismissKey(status)
  if (dismissed === key) return null
  const later = () => {
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
          <span className="app-update-corner-title">{say('appUpdateCorner.title')}</span>
          <span className="app-update-corner-message">{say('appUpdateCorner.body')}</span>
          {/* 바꾸기를 못 했을 때만 — ⚙ 줄과 같은 까닭 */}
          {failure && <span className="app-update-corner-note">{updateNote(say, status, failure)}</span>}
        </span>
      </div>
      <div className="app-update-corner-actions">
        <button className="settings-app-button app-update-corner-later" type="button" onClick={later}>
          {say('appUpdateCorner.later')}
        </button>
        <button className="settings-app-button" type="button" disabled={status.running} onClick={() => void restartAppUpdate()}>
          {say('appUpdateCorner.restart')}
        </button>
      </div>
    </div>
  )
}
