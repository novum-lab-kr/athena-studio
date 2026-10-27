// pane(xterm)에 xterm 기본 대신 보낼 키 신호 — ES 모듈(space-names.mts 와 같은 방식 · 화면은 진입점이 전역 StudioPaneKeys 로 넣는다).
//   Shift+Enter → ESC CR(줄바꿈 — Option+Enter 가 macOptionIsMeta 로 보내는 것과 같다). xterm 기본은 Shift 를 무시하고 CR(전송)
//   ⌘Backspace → Ctrl+U(커서 앞 줄 지우기 — 맥 터미널 관례). xterm 기본은 Meta 를 무시하고 DEL(한 글자)
//   ⌘← · ⌘→ → Ctrl+A · Ctrl+E(줄 처음 · 끝). xterm 6.0.0 기본은 아무것도 보내지 않고 막지도 않아서 숨은 입력칸(textarea) 커서만 앞으로 간다 —
//     그 뒤 한글 조합은 커서가 끝에 있다고 보고 글을 잘라 보내 앞 글자만 되풀이된다(2026-10-27 재현: 안녕하세요 ⌘← 반가워 → 요요요)
//   다른 수정키가 섞이면 바꾸지 않는다(null — xterm 기본대로)
// 키 이벤트에서 읽는 칸만(화면의 KeyboardEvent · 테스트의 가짜 객체)
export type KeyLike = { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }
type Defer = (run: () => void, ms: number) => unknown

export function paneKeyOverride(event: KeyLike): string | null {
  const { shiftKey, ctrlKey, altKey, metaKey } = event
  if (event.key === 'Enter' && shiftKey && !ctrlKey && !altKey && !metaKey) return '\x1b\r'
  if (event.key === 'Backspace' && metaKey && !shiftKey && !ctrlKey && !altKey) return '\x15'
  if (event.key === 'ArrowLeft' && metaKey && !shiftKey && !ctrlKey && !altKey) return '\x01'
  if (event.key === 'ArrowRight' && metaKey && !shiftKey && !ctrlKey && !altKey) return '\x05'
  return null
}

// 한글 조합 중에 눌러도 xterm 에 맡기지 않을 신호 — 줄 처음 · 끝(⌘← · ⌘→). 맡기면 숨은 입력칸 커서가 그대로 움직인다.
// 조합 중 Enter · ⌘⌫ 같은 나머지는 지금처럼 xterm(입력기)에 맡긴다
const MOVE_SIGNALS = new Set(['\x01', '\x05'])
export const holdWhileComposing = (data: string): boolean => MOVE_SIGNALS.has(data)

// 조합 중 누른 이동 키 — 기본 커서 이동은 화면이 막고(preventDefault), 신호는 조합이 확정돼 xterm 이 확정 글자를 보낸 뒤에 보낸다.
// compositionEnd 는 xterm 보다 늦게 건 compositionend 처리에서 부른다 — xterm 이 확정 글자를 setTimeout(0) 뒤에 보내니 그 뒤로 줄 선다.
// 시간이 지났다고 먼저 보내지 않는다 — 조합이 길게 이어질 때 먼저 보내면 확정 안 된 글자가 옮긴 자리에 들어간다.
// 조합은 끝날 때(확정 · 취소 · 포커스 잃음) 늘 compositionend 를 낸다
export function createComposingKeys({ send, defer = setTimeout }: { send: (data: string) => void; defer?: Defer }) {
  let pending = ''
  const flush = () => {
    if (!pending) return
    const data = pending
    pending = ''
    send(data)
  }
  return {
    hold(data: string) {
      pending += data
    },
    compositionEnd() {
      if (pending) defer(flush, 0)
    },
  }
}
