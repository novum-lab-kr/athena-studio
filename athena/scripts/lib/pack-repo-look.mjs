// 레포 표시 이름 · 아이콘 이미지 — 팩 pack.json repos[] 항목의 displayName · icon(규칙은 pack-look.mjs 맨 위 · 팩 표시 이름 · 아이콘과 같다)
//
//   레포 name 은 바꾸지 않는다(경로 · 브랜치 · 스크립트 · 작업 공간 이름이 이것으로 찾는다) — 화면에 보일 이름만
//   아이콘 파일은 팩 폴더 assets/repos/<name>.<png|jpg|webp> 하나 — 바꾸면 이전 것을 지우고, 지우면 빈 폴더도 지운다.
//   팩 폴더 안이라 내보내기 · 백업 · 가져오기 · 되살리기에 같이 실린다
//   pack.json 은 글자 단위로 고친다(pack-merge.mjs 와 같다 — 그 레포 항목의 키만 넣고 빼고, 다른 키 · 순서 · 들여쓰기는 그대로)
//
// 명령 입구 scripts/athena.mjs(pack set-repo-name · set-repo-icon) · 스튜디오 앱 사이드바 레포 우클릭이 이 명령을 부른다.
// 팩에서 레포를 빼면(packs.mjs removeRepo) 그 레포 아이콘도 dropRepoIcons 로 지운다
import { isDeepStrictEqual } from 'node:util'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PackError } from './lock.mjs'
import { ICON_MAX_BYTES, REPO_NAME, checkImage, imageKind, lookTarget, normalizeName, withPackLock } from './pack-look.mjs'
import { deleteKey, repoObject, setKey } from './pack-merge.mjs'

const ICON_KINDS = ['png', 'jpg', 'webp']

// 그 레포 항목 — 없으면 not-found
const findRepo = (pack, repo) => {
  const entry = (Array.isArray(pack.repos) ? pack.repos : []).find((item) => item && item.name === repo)
  if (!entry) throw new PackError('not-found', `팩에 그런 레포가 없다: ${repo}`)
  return entry
}
const checkRepoName = (repo) => {
  if (!REPO_NAME.test(String(repo ?? ''))) throw new PackError('not-found', `레포 이름이 올바르지 않다: ${repo}`)
}

// 그 레포 항목의 키 넣기 · 지우기 — [키, 값(null 이면 지우기)]. 글자로 고친 결과가 뜻한 내용과 다르면 쓰지 않는다
const editRepo = (packDir, repo, changes) => {
  const file = join(packDir, 'pack.json')
  let text = readFileSync(file, 'utf8')
  const pack = JSON.parse(text)
  const entry = findRepo(pack, repo)
  for (const [key, value] of changes) {
    const object = repoObject(text, repo)
    text = value === null ? deleteKey(text, object, key) : setKey(text, object, key, JSON.stringify(value))
    if (value === null) delete entry[key]
    else entry[key] = value
  }
  if (!isDeepStrictEqual(JSON.parse(text), pack)) throw new PackError('failed', 'pack.json 을 고치다 모양이 어긋났다 — 쓰지 않았다')
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, file)
}

// assets · assets/repos 가 링크(또는 폴더가 아님)면 쓰기가 팩 밖으로 간다 — 쓰지 않는다(pack-look.mjs setIcon 과 같은 이유)
const checkDirs = (packDir) => {
  for (const dir of [join(packDir, 'assets'), join(packDir, 'assets', 'repos')]) {
    const stat = (() => { try { return lstatSync(dir) } catch { return null } })()
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new PackError('unsafe', `팩의 ${dir.slice(packDir.length + 1)} 가 링크이거나 폴더가 아니다 — 쓰지 않는다: ${dir}`)
  }
}
// 빈 폴더 정리 — assets/repos → assets
const dropEmptyDirs = (packDir) => {
  for (const dir of [join(packDir, 'assets', 'repos'), join(packDir, 'assets')]) {
    if (existsSync(dir) && lstatSync(dir).isDirectory() && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  }
}

// 그 레포 아이콘 파일 지우기(keep 은 남길 상대 경로) — 지운 상대 경로들
export const dropRepoIcons = (packDir, repo, keep = null) => {
  if (!REPO_NAME.test(String(repo ?? ''))) return []
  checkDirs(packDir)
  const removed = []
  for (const kind of ICON_KINDS) {
    const rel = `assets/repos/${repo}.${kind}`
    if (rel === keep || !existsSync(join(packDir, rel))) continue
    rmSync(join(packDir, rel), { force: true })
    removed.push(rel)
  }
  if (!keep) dropEmptyDirs(packDir)
  return removed
}

export const setRepoDisplayName = (where, { id = '', repo = '', name = '', clear = false } = {}) => {
  checkRepoName(repo)
  const target = lookTarget(where, id)
  const value = clear ? null : normalizeName(name)
  return withPackLock(target, `pack set-repo-name ${target.id} ${repo}`, () => {
    editRepo(target.packDir, repo, [['displayName', value]])
    return { ok: true, id: target.id, repo, displayName: value }
  })
}

export const setRepoIcon = (where, { id = '', repo = '', file = '', clear = false } = {}) => {
  checkRepoName(repo)
  const target = lookTarget(where, id)
  let kind = null
  let bytes = null
  if (!clear) {
    if (!file || !existsSync(file)) throw new PackError('not-found', `이미지 파일이 없다: ${file}`)
    kind = checkImage(file)
    bytes = readFileSync(file)
    // 읽는 사이 바뀌었을 때를 위해 읽은 바이트로 한 번 더
    if (bytes.length > ICON_MAX_BYTES) throw new PackError('image-too-large', '이미지가 1MB 를 넘는다')
    if (imageKind(bytes.subarray(0, 16)) !== kind) throw new PackError('invalid-image', '이미지를 읽는 사이 파일이 바뀌었다')
  }
  return withPackLock(target, `pack set-repo-icon ${target.id} ${repo}`, () => {
    // 레포가 있는지 먼저 — 없는 레포에 파일만 남지 않게
    findRepo(JSON.parse(readFileSync(join(target.packDir, 'pack.json'), 'utf8')), repo)
    checkDirs(target.packDir)
    if (clear) {
      dropRepoIcons(target.packDir, repo)
      editRepo(target.packDir, repo, [['icon', null]])
      return { ok: true, id: target.id, repo, iconPath: null }
    }
    const rel = `assets/repos/${repo}.${kind}`
    mkdirSync(join(target.packDir, 'assets', 'repos'), { recursive: true })
    const temp = join(target.packDir, 'assets', 'repos', `.icon.${process.pid}.tmp`)
    writeFileSync(temp, bytes)
    renameSync(temp, join(target.packDir, rel))
    dropRepoIcons(target.packDir, repo, rel)
    editRepo(target.packDir, repo, [['icon', rel]])
    return { ok: true, id: target.id, repo, iconPath: realpathSync.native(join(target.packDir, rel)) }
  })
}
