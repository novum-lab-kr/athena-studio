// 좌측 하단 앱 업데이트 팝업(src/renderer/ui/app-update-corner.tsx)이 뜰지 · 무엇으로 뜰지 — 순수 로직(2026-11-08 사용자 결정)
// - 'ready': 새 판이 준비됐다(phase ready) — 배포판 · 개발판 모두. [재시작하여 업데이트]
// - 'available': 개발판이 origin/main 보다 뒤처졌다(새 커밋 · 새 태그). [업데이트]
//   배포판은 behind 면 뒤에서 받기만 하니(release-update.mts) 띄우지 않는다 — 배포판 상태(ReleaseStatus)는 behind 가 늘 0 이라 커밋 수로 가른다
// [나중에] 기억(localStorage)의 열쇠는 새 판 이름(배포판 · 개발판 새 태그), 태그가 아직 없는 개발판은 뒤처진 커밋 수.
// 'available' 열쇠는 앞에 표시를 붙여 따로 기억한다 — 새 판 안내를 닫아도 설치가 끝난 뒤의 다시 시작 안내는 뜬다('ready' 열쇠는 전과 같다)

export type CornerStatus = { state: 'behind' | 'current' | 'unavailable'; behind: number; latest: string | null; phase?: 'waiting' | 'installing' | 'ready' | null }
export type CornerView = { kind: 'ready' | 'available'; key: string }

function versionKey(status: CornerStatus): string {
  return status.latest || `behind:${status.behind}`
}

export function cornerView(status: CornerStatus | null, dismissed: string | null): CornerView | null {
  if (!status) return null
  const view = pickView(status)
  if (!view || view.key === dismissed) return null
  return view
}

function pickView(status: CornerStatus): CornerView | null {
  if (status.phase === 'ready') return { kind: 'ready', key: versionKey(status) }
  if (status.state === 'behind' && status.behind > 0) return { kind: 'available', key: `available:${versionKey(status)}` }
  return null
}
