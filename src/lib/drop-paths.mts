// pane 에 끌어다 놓은 파일 · 폴더 경로 → 입력줄에 넣을 글 — ES 모듈(pane-keys.mts 와 같은 방식 · 화면은 terminal.ts 가 import 한다).
// 맥 터미널 · iTerm 처럼 셸 특수 문자 앞에 역슬래시를 붙이고 여러 개면 공백으로 잇는다(끝에도 공백 하나 — 이어서 치기 좋게).
// 한글 등 ASCII 밖 글자는 그대로 둔다. 줄바꿈 같은 제어 문자가 든 경로만 역슬래시로는 못 싸서 $'…' 로 감싼다

// 역슬래시 없이 둬도 셸이 그대로 읽는 글자 — 나머지 ASCII(공백 · 따옴표 · $ · ! · 괄호 · * · ? · ~ · # …)는 앞에 \ 를 붙인다
const SAFE_ASCII = /[A-Za-z0-9_\-.,/:@%+=]/
// 제어 문자(0x00–0x1f · 0x7f)
const CONTROL = /[\x00-\x1f\x7f]/

function escapeChar(char: string): string {
  if (char.charCodeAt(0) > 0x7f) return char
  return SAFE_ASCII.test(char) ? char : `\\${char}`
}

// $'…' 안에서는 \ 와 ' 만 막고 제어 문자는 \xHH 로
function ansiQuote(path: string): string {
  const body = [...path]
    .map((char) => {
      if (char === '\\' || char === "'") return `\\${char}`
      if (CONTROL.test(char)) return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
      return char
    })
    .join('')
  return `$'${body}'`
}

export function shellEscapePath(path: string): string {
  if (CONTROL.test(path)) return ansiQuote(path)
  return [...path].map(escapeChar).join('')
}

// 빈 경로(경로를 얻지 못한 항목)는 뺀다 — 하나도 없으면 빈 글
export function dropText(paths: readonly string[]): string {
  const escaped = paths.filter((path) => path).map(shellEscapePath)
  return escaped.length ? `${escaped.join(' ')} ` : ''
}
