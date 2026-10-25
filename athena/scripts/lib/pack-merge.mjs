// 레포별 PR 자동 리뷰 · 머지 설정 — 팩 pack.json 레포 항목의 두 키(뜻의 정본 docs/pr-auto.md "켜기")
//
//   "autoMerge": true            켬 · 끄면 키를 지운다(없으면 꺼짐)
//   "autoMergeConfirm": false    머지 전에 묻지 않음 · 묻기로 돌리면 키를 지운다(없으면 묻는다)
//
// main 직접 레포("direct": true)는 PR 이 없어 대상이 아니다(not-applicable).
// 파일은 글자 단위로 고친다 — 그 레포 항목의 두 키만 넣고 빼고, 다른 키 · 순서 · 들여쓰기 · 한 줄로 쓴 항목 모양은 그대로 둔다.
// 명령 입구 scripts/athena.mjs(pack set-auto-merge) · 스튜디오 앱 ⚙ 설정이 이 명령을 부른다.
// 현황판 · pr-auto.mjs 는 확인할 때마다 pack.json 을 새로 읽으므로 다시 띄울 필요가 없다
import { isDeepStrictEqual } from 'node:util'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PackError, packLockDir, takeLock } from './lock.mjs'
import { lookTarget } from './pack-look.mjs'

// on|off → true|false · 없으면 null(바꾸지 않음)
const onOff = (value, name) => {
  if (value === '' || value === undefined || value === null) return null
  if (value === 'on') return true
  if (value === 'off') return false
  throw new PackError('usage', `--${name} 는 on 또는 off`)
}

// ── JSON 글자 위치 읽기 — JSON.parse 를 통과한 글만 넣는다(모양 검사는 하지 않는다) ─────────────
const skipSpace = (text, index) => {
  let at = index
  while (at < text.length && /\s/.test(text[at])) at += 1
  return at
}
const stringEnd = (text, index) => {
  let at = index + 1
  while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1
  return at + 1
}
// 값 하나의 끝 위치 — 객체면 멤버(키 · 값 위치), 배열이면 항목 위치도
const scanValue = (text, index) => {
  const start = skipSpace(text, index)
  const head = text[start]
  if (head === '"') return { start, end: stringEnd(text, start) }
  if (head === '{') {
    const members = []
    let at = skipSpace(text, start + 1)
    if (text[at] === '}') return { start, end: at + 1, members }
    for (;;) {
      const keyStart = at
      const keyEnd = stringEnd(text, keyStart)
      const value = scanValue(text, skipSpace(text, keyEnd) + 1)
      members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), keyStart, value })
      at = skipSpace(text, value.end)
      if (text[at] === '}') return { start, end: at + 1, members }
      at = skipSpace(text, at + 1)
    }
  }
  if (head === '[') {
    const items = []
    let at = skipSpace(text, start + 1)
    if (text[at] === ']') return { start, end: at + 1, items }
    for (;;) {
      const item = scanValue(text, at)
      items.push(item)
      at = skipSpace(text, item.end)
      if (text[at] === ']') return { start, end: at + 1, items }
      at = skipSpace(text, at + 1)
    }
  }
  let end = start
  while (end < text.length && !/[\s,\]}]/.test(text[end])) end += 1
  return { start, end }
}

// 그 레포 항목(객체)의 위치
const repoObject = (text, repo) => {
  const root = scanValue(text, 0)
  const repos = (root.members || []).find((member) => member.key === 'repos')
  for (const item of (repos && repos.value.items) || []) {
    const name = (item.members || []).find((member) => member.key === 'name')
    if (name && JSON.parse(text.slice(name.value.start, name.value.end)) === repo) return item
  }
  return null
}

// 키 하나 넣기 · 바꾸기 — 없으면 마지막 멤버 뒤에, 그 항목의 멤버 사이 모양(", " · ",\n    ")을 따라
const setKey = (text, object, key, literal) => {
  const { members } = object
  const found = members.find((member) => member.key === key)
  if (found) return text.slice(0, found.value.start) + literal + text.slice(found.value.end)
  const last = members[members.length - 1]
  let separator = ', '
  if (members.length >= 2) separator = text.slice(members[members.length - 2].value.end, last.keyStart)
  else if (text.slice(object.start + 1, members[0].keyStart).includes('\n')) separator = `,${text.slice(object.start + 1, members[0].keyStart)}`
  return text.slice(0, last.value.end) + separator + JSON.stringify(key) + ': ' + literal + text.slice(last.value.end)
}
// 키 하나 지우기 — 그 멤버와 앞(맨 앞이면 뒤)의 쉼표까지
const deleteKey = (text, object, key) => {
  const { members } = object
  const index = members.findIndex((member) => member.key === key)
  if (index < 0) return text
  if (index > 0) return text.slice(0, members[index - 1].value.end) + text.slice(members[index].value.end)
  if (members.length > 1) return text.slice(0, members[0].keyStart) + text.slice(members[1].keyStart)
  return text.slice(0, members[0].keyStart) + text.slice(members[0].value.end)
}

// --id 가 있으면 그 팩, 없으면 부른 본체의 팩(pack-look.mjs lookTarget 과 같은 기준)
export const setAutoMerge = (where, { id = '', repo = '', auto = '', confirm = '' } = {}) => {
  const autoMerge = onOff(auto, 'auto')
  const ask = onOff(confirm, 'confirm')
  if (!repo) throw new PackError('usage', '사용: athena pack set-auto-merge <레포> [--auto on|off] [--confirm on|off] [--id <팩>] [--json]')
  if (autoMerge === null && ask === null) throw new PackError('usage', '--auto 또는 --confirm 중 하나는 있어야 한다')
  const target = lookTarget(where, id)
  const work = () => {
    const file = join(target.packDir, 'pack.json')
    let text = readFileSync(file, 'utf8')
    const pack = JSON.parse(text)
    const entry = (Array.isArray(pack.repos) ? pack.repos : []).find((item) => item && item.name === repo)
    if (!entry) throw new PackError('not-found', `팩에 그런 레포가 없다: ${repo}`)
    if (entry.direct === true) throw new PackError('not-applicable', `${repo} 는 main 직접 레포라 PR 이 없다 — 자동 머지 대상이 아니다`)
    // 바꿀 것 — [키, 넣을 값(null 이면 지우기)]
    const changes = []
    if (autoMerge !== null) changes.push(['autoMerge', autoMerge ? 'true' : null])
    if (ask !== null) changes.push(['autoMergeConfirm', ask ? null : 'false'])
    for (const [key, literal] of changes) {
      const object = repoObject(text, repo)
      text = literal === null ? deleteKey(text, object, key) : setKey(text, object, key, literal)
      if (literal === null) delete entry[key]
      else entry[key] = JSON.parse(literal)
    }
    // 글자로 고친 결과가 뜻한 내용과 같은지 — 다르면 쓰지 않는다
    if (!isDeepStrictEqual(JSON.parse(text), pack)) throw new PackError('failed', 'pack.json 을 고치다 모양이 어긋났다 — 쓰지 않았다')
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, text)
    renameSync(temp, file)
    return { ok: true, id: target.id, repo, autoMerge: entry.autoMerge === true, autoMergeConfirm: entry.autoMergeConfirm !== false }
  }
  // 여러 팩 구조 — 팩 작업 잠금 안에서(열기 · 업데이트 · 이름 바꾸기와 겹치지 않게)
  if (!target.data) return work()
  const release = takeLock(packLockDir(target.data, target.id), `pack set-auto-merge ${target.id}`, { waitMs: 5_000, message: (owner) => `그 팩(${target.id})에 다른 작업이 진행 중이다(pid ${owner.pid})` })
  try { return work() } finally { release() }
}
