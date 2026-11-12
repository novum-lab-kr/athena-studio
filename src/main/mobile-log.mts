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
