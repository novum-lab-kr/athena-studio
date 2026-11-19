// 모바일 브리지 기록 — 터미널에 한 줄씩(개발판 전용 길이라 파일 로그는 없다).
// 앱을 켠 터미널이 닫히면 stdout · stderr 쓰기가 EIO 로 실패한다. Electron main 에서는 그 실패가 console.* 이 돌아온 뒤
// 스트림의 'error' 이벤트로 올라와(try/catch 로 못 잡는다) 듣는 쪽이 없으면 잡히지 않은 예외 → "A JavaScript error occurred in the main process" 창.
// 그래서 쓰기 전에 두 스트림에 'error' 를 듣는 빈 함수를 한 번 걸어 둔다 — 기록을 못 남길 뿐 앱은 그대로 돈다
import type { EventEmitter } from 'node:events'

const ignoreWriteError = () => {}

// 스트림의 쓰기 실패('error')를 삼킨다 — 같은 스트림에 두 번 걸지 않는다
export function quietStream(stream: EventEmitter): void {
  if (!stream.listeners('error').includes(ignoreWriteError)) stream.on('error', ignoreWriteError)
}

function quietTerminal(): void {
  quietStream(process.stdout)
  quietStream(process.stderr)
}

export function mobileLog(line: string): void {
  quietTerminal()
  console.log(line)
}

export function mobileError(...parts: unknown[]): void {
  quietTerminal()
  console.error(...parts)
}

// relay 주소 없이 켜졌는데 짝 지은 기록(<스튜디오 집>/mobile/relay.json)이 있을 때의 맥 로그 — 개발판에서만.
// 업데이트 다시 켜기 등으로 주소가 빠지면 기기에는 '연결 끊김'만 보이고 맥에는 아무 줄도 없어 원인을 못 찾는다(2026-11-19)
export const MOBILE_RELAY_MISSING =
  '[mobile-relay] relay 주소(ATHENA_STUDIO_MOBILE_RELAY) 없이 켜져 모바일 길을 켜지 않아요 — 짝 지은 기기는 연결 끊김으로 보여요. 주소를 넣고 다시 켜면 이어져요'
export function relayMissingNote({ packaged, relay, pairedFileExists }: { packaged: boolean; relay: string | undefined; pairedFileExists: () => boolean }): string | null {
  if (packaged || relay) return null
  return pairedFileExists() ? MOBILE_RELAY_MISSING : null
}
