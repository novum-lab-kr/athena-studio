// 파일 뷰어의 순수 로직 — 파일 이름 → 언어 · 이미지 종류 · diff 를 줄(번호 포함)로 · 색칠 결과를 줄에 나눠 싣기.
// 색칠(Shiki, VSCode Dark+)은 main 이 하고, 화면은 줄과 글자 조각만 받아 그린다(HTML 을 그대로 꽂지 않는다)
const path = require('path')

// 확장자 이름이 Shiki 언어 이름과 다른 것 · 통째 이름으로 정하는 것
const NAME_LANGS = { dockerfile: 'docker', makefile: 'make', '.gitignore': 'text', '.npmrc': 'ini', '.nvmrc': 'text', '.env': 'dotenv' }
const EXT_LANGS = { mdx: 'mdx', yml: 'yaml', zsh: 'shellscript', bash: 'shellscript', sh: 'shellscript', h: 'c', hpp: 'cpp', lock: 'text', txt: 'text', log: 'text' }

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp' }
const IMAGE_LIMIT = 10 * 1024 * 1024
// 이보다 크면 색을 칠하지 않는다(문법 분석이 몇 초씩 걸린다)
const HIGHLIGHT_LIMIT = 300 * 1024

function extensionOf(name) {
  const lower = String(name || '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

// → Shiki 언어 이름(없으면 'text'). known 은 Shiki 가 아는 이름·별칭 집합
function languageFor(name, known) {
  const base = path.basename(String(name || '')).toLowerCase()
  if (NAME_LANGS[base]) return NAME_LANGS[base]
  if (base.startsWith('.env')) return 'dotenv'
  const extension = extensionOf(base)
  const mapped = EXT_LANGS[extension] || extension
  return mapped && known.has(mapped) ? mapped : 'text'
}

function imageType(name) {
  return IMAGE_TYPES[extensionOf(name)] || null
}

// 파일 내용 → 줄. 끝의 빈 줄 하나(마지막 줄바꿈)는 줄로 치지 않는다
function fileRows(text) {
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((code, index) => ({ kind: 'context', newNo: index + 1, code: code.replace(/\r$/, '') }))
}

// `git diff` → 줄. 머리(diff · index · --- · +++)는 빼고, @@ 는 구분 줄로, 나머지는 옛·새 줄 번호를 단다
function diffRows(text) {
  const rows = []
  let oldNo = 0
  let newNo = 0
  for (const line of String(text).split('\n')) {
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      rows.push({ kind: 'hunk', code: line })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', newNo: newNo++, code: line.slice(1) })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo: oldNo++, code: line.slice(1) })
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, code: line.slice(1) })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'hunk', code: line }) // "\ No newline at end of file"
    }
  }
  return rows
}

// 색칠할 글: 구분 줄(@@)을 뺀 코드 줄을 순서대로 잇는다 — 줄마다 따로 칠하면 여러 줄 주석·문자열 색이 끊긴다
function codeOf(rows) {
  return rows.filter((row) => row.kind !== 'hunk').map((row) => row.code).join('\n')
}

// Shiki 줄별 토큰을 코드 줄에 돌려 싣는다. 토큰은 [글, 색, 글꼴 모양(1 기울임 · 2 굵게 · 4 밑줄)] 로 줄인다
function attachTokens(rows, tokenLines) {
  let index = 0
  return rows.map((row) => {
    if (row.kind === 'hunk') return row
    const line = tokenLines[index++] || []
    return { ...row, tokens: line.map((token) => [token.content, token.color || null, token.fontStyle || 0]) }
  })
}

module.exports = { IMAGE_LIMIT, HIGHLIGHT_LIMIT, languageFor, imageType, fileRows, diffRows, codeOf, attachTokens }
