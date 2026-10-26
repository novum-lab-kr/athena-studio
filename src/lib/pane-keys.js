// pane(xterm)에 xterm 기본 대신 보낼 키 신호 — 화면(renderer)이 <script> 로 싣는다(space-names.js 와 같은 방식 · 전역 StudioPaneKeys).
//   Shift+Enter → ESC CR(줄바꿈 — Option+Enter 가 macOptionIsMeta 로 보내는 것과 같다). xterm 기본은 Shift 를 무시하고 CR(전송)
//   ⌘Backspace → Ctrl+U(커서 앞 줄 지우기 — 맥 터미널 관례). xterm 기본은 Meta 를 무시하고 DEL(한 글자)
//   다른 수정키가 섞이면 바꾸지 않는다(null — xterm 기본대로)
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.StudioPaneKeys = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function paneKeyOverride(event) {
    const { shiftKey, ctrlKey, altKey, metaKey } = event
    if (event.key === 'Enter' && shiftKey && !ctrlKey && !altKey && !metaKey) return '\x1b\r'
    if (event.key === 'Backspace' && metaKey && !shiftKey && !ctrlKey && !altKey) return '\x15'
    return null
  }

  return { paneKeyOverride }
})
