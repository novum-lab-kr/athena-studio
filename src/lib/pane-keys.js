// pane(xterm)에 xterm 기본 대신 보낼 키 신호 — 화면(renderer)이 <script> 로 싣는다(space-names.js 와 같은 방식 · 전역 StudioPaneKeys).
//   Shift+Enter → ESC CR(줄바꿈 — Option+Enter 가 macOptionIsMeta 로 보내는 것과 같다). xterm 기본은 Shift 를 무시하고 CR(전송)
//   ⌘Backspace → Ctrl+U(커서 앞 줄 지우기 — 맥 터미널 관례). xterm 기본은 Meta 를 무시하고 DEL(한 글자)
//   ⌘← · ⌘→ → Ctrl+A · Ctrl+E(줄 처음 · 끝). xterm 6.0.0 기본은 아무것도 보내지 않고 막지도 않아서 숨은 입력칸(textarea) 커서만 앞으로 간다 —
//     그 뒤 한글 조합은 커서가 끝에 있다고 보고 글을 잘라 보내 앞 글자만 되풀이된다(2026-10-27 재현: 안녕하세요 ⌘← 반가워 → 요요요)
//   다른 수정키가 섞이면 바꾸지 않는다(null — xterm 기본대로)
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.StudioPaneKeys = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function paneKeyOverride(event) {
    const { shiftKey, ctrlKey, altKey, metaKey } = event
    if (event.key === 'Enter' && shiftKey && !ctrlKey && !altKey && !metaKey) return '\x1b\r'
    if (event.key === 'Backspace' && metaKey && !shiftKey && !ctrlKey && !altKey) return '\x15'
    if (event.key === 'ArrowLeft' && metaKey && !shiftKey && !ctrlKey && !altKey) return '\x01'
    if (event.key === 'ArrowRight' && metaKey && !shiftKey && !ctrlKey && !altKey) return '\x05'
    return null
  }

  return { paneKeyOverride }
})
