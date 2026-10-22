// 오른쪽 Explorer 의 순수 로직 — 정렬 · git status 읽기 · 작업 공간 기준 경로 · 루트 안 판정.
// 파일을 읽는 일은 main 이 한다(화면은 파일에 손대지 않는다). 여기는 Electron·fs 없이 테스트한다
const path = require('path')

const HIDDEN_NAMES = ['.git', '.DS_Store']
const PREVIEW_LIMIT = 512 * 1024

// 폴더 먼저, 그다음 이름(대소문자 무시) — VSCode 와 같은 순서. .git 같은 것은 뺀다
function sortEntries(entries) {
  return entries
    .filter((entry) => !HIDDEN_NAMES.includes(entry.name))
    .sort((left, right) => {
      if (left.dir !== right.dir) return left.dir ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    })
}

// `git status --porcelain=v1 -z` → [{path, code}]. 새 폴더는 `dir/` 한 줄로 온다.
// 경로는 git 최상위 기준이다. 이름 바꾸기(R·C)는 새 이름 뒤에 옛 이름이 한 칸 더 온다
function parseGitStatus(output) {
  const parts = String(output).split('\0')
  const changes = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part.length < 4) continue
    const code = part.slice(0, 2)
    changes.push({ path: part.slice(3), code: statusCode(code) })
    if (code[0] === 'R' || code[0] === 'C') index++ // 옛 이름 건너뛰기
  }
  return changes
}

// 두 글자 상태 → 화면에 보일 한 글자(VSCode 처럼): U 새 파일 · A 추가 · D 삭제 · R 이름 바꿈 · M 수정 · ! 충돌
function statusCode(code) {
  if (code === '??') return 'U'
  if (code.includes('U') || code === 'AA' || code === 'DD') return '!'
  if (code.includes('D')) return 'D'
  if (code[0] === 'R') return 'R'
  if (code.includes('A')) return 'A'
  return 'M'
}

// git 최상위 기준 경로 → 작업 공간 폴더 기준. 작업 공간 밖 변경은 뺀다(prefix 는 최상위에서 작업 공간까지, 없으면 '')
function relativeToWorkspace(changes, prefix) {
  const head = prefix ? `${prefix.replace(/\/+$/, '')}/` : ''
  return changes.filter((change) => change.path.startsWith(head)).map((change) => ({ ...change, path: change.path.slice(head.length) }))
}

// realpath 로 푼 target 이 root 안인가(root 자신 포함) — 심볼릭 링크·.. 로 루트 밖을 읽지 못하게
function isInside(root, target) {
  const relative = path.relative(root, target)
  // '..foo' 같은 이름은 안이다 — 위로 가는 것만 밖
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

// 팩 본체(여러 팩 구조 — .pack-data 가 있다)에서 사용자에게 보일 맨 위 항목 — 팩 내용만.
// 코어(scripts · docs · CLAUDE.md …)와 본체 설정 · 상태, 링크 폴더(repos · .worktrees · .pack-data)는 숨긴다
const PACK_BODY_NAMES = ['pack', 'plans', 'issues', 'archive']
const packBodyEntries = (entries) => entries.filter((entry) => PACK_BODY_NAMES.includes(entry.name))
const packBodyChanges = (changes) => changes.filter((change) => PACK_BODY_NAMES.includes(change.path.split('/')[0]))

// 여러 루트 중 하나 안인가 — 작업 공간 폴더 + 여러 팩 본체의 지금 팩 데이터(plans · issues · archive 가 그리로 가는 링크다)
function isInsideAny(roots, target) {
  return roots.some((root) => isInside(root, target))
}

// 화면이 보낸 상대 경로를 검사 — 절대 경로·NUL 은 거절(풀린 실제 경로 검사는 isInside 가 한다)
function cleanRelative(relative) {
  const value = typeof relative === 'string' ? relative : ''
  if (value.includes('\0') || path.isAbsolute(value)) return null
  return path.posix.normalize(value || '.')
}

// 앞부분에 NUL 이 있으면 바이너리로 본다(git 과 같은 어림)
function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0)
}

module.exports = {
  PREVIEW_LIMIT,
  sortEntries,
  parseGitStatus,
  statusCode,
  relativeToWorkspace,
  isInside,
  isInsideAny,
  PACK_BODY_NAMES,
  packBodyEntries,
  packBodyChanges,
  cleanRelative,
  looksBinary,
}
