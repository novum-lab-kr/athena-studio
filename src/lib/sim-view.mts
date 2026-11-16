// 시뮬레이터 칸(src/renderer/ui/sim-bar.tsx)이 무엇을 고르고 · 무슨 안내를 띄울지 — 화면 없이 시험하려고 뺀 판정.
// 화면(.tsx)만 import 한다. 문구는 키만 돌려주고 글은 화면이 i18n 으로 바꾼다.

export type SimDevice = { id: string; booted: boolean }

// 목록을 새로 읽은 뒤 고를 기기 — 고르던 것 → 열어 둔 것 → 켜진 것 → 첫 기기. 목록에 없는 id 는 남기지 않는다
// (열어 둔 기기가 밖에서 꺼져 목록에서 빠지면 그 id 가 남아 막대 버튼이 엉뚱하게 보였다)
export function pickSelected(devices: SimDevice[], selected: string, runningId: string): string {
  const has = (id: string) => Boolean(id) && devices.some((device) => device.id === id)
  if (has(selected)) return selected
  if (has(runningId)) return runningId
  return devices.find((device) => device.booted)?.id || devices[0]?.id || ''
}

export type ScreenState = {
  loaded: boolean
  busy: string
  error: string
  running: boolean
  frameMissing: boolean // Android 를 열었는데 아직 첫 그림이 없다
  devices: SimDevice[]
}

// 칸 가운데 안내 — 'error' 면 화면이 state.error 를 그대로, 빈 글이면 안내 없음
export type ScreenNote = '' | 'loading' | 'starting' | 'error' | 'noDevices' | 'noRunning' | 'pickBooted'

export function screenNote(state: ScreenState): ScreenNote {
  // 첫 목록을 아직 못 읽었다(서랍이 열리기 전 · 읽는 중) — "기기 없음" 으로 보이지 않게
  if (!state.loaded) return 'loading'
  if (state.busy === 'start') return 'starting'
  if (state.error) return 'error'
  if (!state.running) {
    if (state.devices.length === 0) return 'noDevices'
    // 켜진 기기가 있는데 열려 있지 않다(⟳ 는 저절로 열지 않는다) — "켜진 기기가 없어요" 가 아니다
    return state.devices.some((device) => device.booted) ? 'pickBooted' : 'noRunning'
  }
  return state.frameMissing ? 'loading' : ''
}
