// 팩 표시 이름 · 아이콘 이미지 — 팩 안(팀과 공유)에 저장한다
//
//   pack.json displayName   화면에 보이는 이름(1~40자 · 줄바꿈·제어 문자 없음). 팩 id · name · packId 는 바꾸지 않는다(name 은 같은 팩 판단용)
//   pack.json icon          늘 "assets/icon.<png|jpg|webp>" — 팩 폴더 assets/ 에 하나만(바꾸면 이전 것 지움)
//   이미지                   png · jpeg · webp 만(앞 바이트로 확인 · 확장자 믿지 않음) · 1MB 이하. SVG(안에 스크립트) · GIF(움직임) 거부
//
// 명령 입구 scripts/athena.mjs(pack set-name · set-icon). 가져오기 검사·목록은 scripts/lib/packs.mjs 가 이 파일을 쓴다
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { PackError, packLockDir, takeLock } from './lock.mjs'

export const ICON_MAX_BYTES = 1024 * 1024
export const ICON_PATH = /^assets\/icon\.(png|jpg|webp)$/
const NAME_MAX = 40

// 파일 앞 바이트로 형식 판별 → 'png' | 'jpg' | 'webp' | null
export const imageKind = (head) => {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}
const readHead = (path) => {
  const handle = openSync(path, 'r')
  try { const buffer = Buffer.alloc(16); const read = readSync(handle, buffer, 0, 16, 0); return buffer.subarray(0, read) } finally { closeSync(handle) }
}
// 이미지 파일 검사 — 일반 파일 · 1MB 이하 · png/jpeg/webp. 통과하면 형식(확장자)
export const checkImage = (path, label = path) => {
  const stat = statSync(path)
  if (!stat.isFile()) throw new PackError('invalid-image', `이미지 파일이 아니다: ${label}`)
  if (stat.size > ICON_MAX_BYTES) throw new PackError('image-too-large', `이미지가 1MB 를 넘는다(${Math.ceil(stat.size / 1024)}KB): ${label}`, { bytes: stat.size, maxBytes: ICON_MAX_BYTES })
  const kind = imageKind(readHead(path))
  if (!kind) throw new PackError('invalid-image', `png · jpeg · webp 이미지만 받는다(SVG·GIF 는 안 된다): ${label}`)
  return kind
}

// 표시 이름 검사 — 앞뒤 공백을 지우고 1~40자(글자 수) · 줄바꿈·제어 문자 없음
export const normalizeName = (text) => {
  const name = String(text ?? '').trim()
  if (!name) throw new PackError('invalid-name', '표시 이름이 비어 있다 — 지우려면 --clear')
  if ([...name].length > NAME_MAX) throw new PackError('invalid-name', `표시 이름은 ${NAME_MAX}자까지다(${[...name].length}자)`)
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(name)) throw new PackError('invalid-name', '표시 이름에 줄바꿈·제어 문자를 넣을 수 없다')
  // 글자 방향을 바꾸는 보이지 않는 문자 — 화면에서 이름이 뒤집혀 보이게 할 수 있다(리뷰 5차)
  if (/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name)) throw new PackError('invalid-name', '표시 이름에 글자 방향 문자를 넣을 수 없다')
  return name
}

// 팩 폴더에서 표시 이름·아이콘 읽기 — 목록·열기 응답용. 아이콘은 형식이 맞고 팩 안의 일반 파일일 때만(아니면 null)
export const packLook = (packDir, pack) => {
  const displayName = typeof pack?.displayName === 'string' && (() => { try { return normalizeName(pack.displayName) } catch { return null } })() || null
  let iconPath = null
  let iconUpdatedAt = null
  if (typeof pack?.icon === 'string' && ICON_PATH.test(pack.icon)) {
    const path = join(packDir, pack.icon)
    try {
      const real = realpathSync.native(path)
      if (!lstatSync(path).isSymbolicLink() && real.startsWith(realpathSync.native(packDir) + sep) && statSync(real).isFile()) {
        iconPath = real
        iconUpdatedAt = statSync(real).mtime.toISOString()
      }
    } catch { /* 파일이 없다 */ }
  }
  return { displayName, iconPath, iconUpdatedAt }
}

// 가져오기 검사 — pack.json 의 icon 은 정해진 모양만(밖을 가리키는 경로 거부) · assets/ 안 파일은 모두 이미지 검사
export const inspectLook = (packRoot, pack) => {
  const warnings = []
  if (pack.icon !== undefined && (typeof pack.icon !== 'string' || !ICON_PATH.test(pack.icon))) throw new PackError('invalid-pack', `pack.json 의 icon 은 assets/icon.<png|jpg|webp> 만 — ${JSON.stringify(pack.icon)}`)
  if (pack.displayName !== undefined) {
    try { if (typeof pack.displayName !== 'string') throw new Error('문자열 아님'); normalizeName(pack.displayName) } catch (error) { warnings.push(`pack.json 의 displayName 을 쓰지 않는다 — ${error.message}`) }
  }
  const assets = join(packRoot, 'assets')
  if (existsSync(assets)) {
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const stat = lstatSync(path)
        if (stat.isDirectory()) { walk(path); continue }
        if (stat.isSymbolicLink()) throw new PackError('unsafe', `assets/ 안에 링크가 있다: ${path.slice(packRoot.length + 1)}`)
        checkImage(path, path.slice(packRoot.length + 1))
      }
    }
    if (!lstatSync(assets).isDirectory()) throw new PackError('invalid-pack', 'assets 가 폴더가 아니다')
    walk(assets)
  }
  if (pack.icon && !existsSync(join(packRoot, pack.icon))) warnings.push(`pack.json 의 icon 파일이 없다: ${pack.icon}`)
  return warnings
}

// ── 바꾸기 ──────────────────────────────────────────────────────────────
const writeJsonAtomic = (path, value) => {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}
// 대상 팩 — --id 가 있으면 <데이터>/packs/<id>/pack, 없으면 부른 본체의 팩
export const lookTarget = (where, id) => {
  if (id) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new PackError('not-found', `팩 id 가 올바르지 않다: ${id}`)
    const packDir = join(where.dataDir, 'packs', id, 'pack')
    if (!existsSync(join(packDir, 'pack.json'))) throw new PackError('not-found', `그런 팩이 없다: ${id}`)
    return { id, packDir, data: where.dataDir }
  }
  if (where.mode === 'packs') {
    const packDir = join(where.packDataReal, 'pack')
    if (!existsSync(join(packDir, 'pack.json'))) throw new PackError('not-found', `이 본체 팩에 pack.json 이 아직 없다(/setup 전): ${where.packId}`)
    return { id: where.packId, packDir, data: where.dataDir }
  }
  if (where.packDir && existsSync(join(where.packDir, 'pack.json'))) return { id: where.packDir.split(sep).pop(), packDir: where.packDir, data: null }
  throw new PackError('not-found', '팩이 없다')
}
// 팩 작업 잠금 안에서(여러 팩 구조) — 열기·업데이트·다른 이름 바꾸기와 겹치지 않게
const withPackLock = (target, what, work) => {
  if (!target.data) return work()
  const release = takeLock(packLockDir(target.data, target.id), what, { waitMs: 5_000, message: (owner) => `그 팩(${target.id})에 다른 작업이 진행 중이다(pid ${owner.pid})` })
  try { return work() } finally { release() }
}

export const setDisplayName = (where, { id = '', name = '', clear = false } = {}) => {
  const target = lookTarget(where, id)
  const value = clear ? null : normalizeName(name)
  return withPackLock(target, `pack set-name ${target.id}`, () => {
    const file = join(target.packDir, 'pack.json')
    const pack = JSON.parse(readFileSync(file, 'utf8'))
    if (value) pack.displayName = value
    else delete pack.displayName
    writeJsonAtomic(file, pack)
    return { ok: true, id: target.id, displayName: value }
  })
}

export const setIcon = (where, { id = '', file = '', clear = false } = {}) => {
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
  return withPackLock(target, `pack set-icon ${target.id}`, () => {
    const assets = join(target.packDir, 'assets')
    const packFile = join(target.packDir, 'pack.json')
    // assets 가 링크(또는 폴더가 아님)면 쓰기가 팩 밖으로 간다 — git 으로 받은 팩은 가져오기 검사를 거치지 않으니 여기서 끊는다(리뷰 5차)
    const assetsStat = (() => { try { return lstatSync(assets) } catch { return null } })()
    if (assetsStat && (assetsStat.isSymbolicLink() || !assetsStat.isDirectory())) throw new PackError('unsafe', `팩의 assets 가 링크이거나 폴더가 아니다 — 쓰지 않는다: ${assets}`)
    const pack = JSON.parse(readFileSync(packFile, 'utf8'))
    const oldIcons = existsSync(assets) ? readdirSync(assets).filter((name) => /^icon\.(png|jpg|webp)$/.test(name)) : []
    if (clear) {
      for (const name of oldIcons) rmSync(join(assets, name), { force: true })
      if (existsSync(assets) && readdirSync(assets).length === 0) rmSync(assets, { recursive: true, force: true })
      delete pack.icon
      writeJsonAtomic(packFile, pack)
      return { ok: true, id: target.id, iconPath: null }
    }
    mkdirSync(assets, { recursive: true })
    const rel = `assets/icon.${kind}`
    const temp = join(assets, `.icon.${process.pid}.tmp`)
    writeFileSync(temp, bytes)
    renameSync(temp, join(target.packDir, rel))
    for (const name of oldIcons) if (`assets/${name}` !== rel) rmSync(join(assets, name), { force: true })
    pack.icon = rel
    writeJsonAtomic(packFile, pack)
    return { ok: true, id: target.id, iconPath: realpathSync.native(join(target.packDir, rel)) }
  })
}

