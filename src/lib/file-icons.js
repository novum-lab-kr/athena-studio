// Explorer 파일·폴더 아이콘 — VSCode Material Icon Theme(material-icon-theme, MIT)의 대응표로 고른다.
// 고르는 일은 main 이 한다(대응표가 1MB 라 화면에 싣지 않는다). 화면은 고른 이름의 SVG 만 그린다.
// 규칙은 VSCode 와 같다 — 파일 이름 통째 → 확장자(긴 것부터: d.ts 가 ts 보다 먼저) → 기본 파일 / 폴더 이름 → 기본 폴더
const path = require('path')

const ICON_DIR = path.join(__dirname, '..', '..', 'node_modules', 'material-icon-theme', 'icons')

let cached = null
function loadManifest() {
  if (!cached) cached = require('material-icon-theme/dist/material-icons.json')
  return cached
}

// 대응표의 아이콘 이름 → SVG 파일 이름(확장자 뺀 것). iconPath 는 './../icons/<이름>.svg'
function iconFile(manifest, id) {
  const definition = manifest.iconDefinitions[id]
  if (!definition) return null
  return path.basename(definition.iconPath, '.svg')
}

// 'a.test.ts' → ['test.ts', 'ts'](긴 것부터). 맨 앞 점은 확장자가 아니다('.bashrc' → [])
function extensionsOf(name) {
  const parts = name.split('.')
  const start = parts[0] === '' ? 2 : 1
  const out = []
  for (let index = start; index < parts.length; index++) out.push(parts.slice(index).join('.'))
  return out
}

// → { icon } (파일) | { icon, iconOpen } (폴더). 아이콘은 SVG 파일 이름(확장자 뺀 것)
function iconFor(manifest, name, isDir) {
  const lower = String(name || '').toLowerCase()
  if (isDir) {
    return {
      icon: iconFile(manifest, manifest.folderNames[lower] || manifest.folder),
      iconOpen: iconFile(manifest, manifest.folderNamesExpanded[lower] || manifest.folderExpanded),
    }
  }
  if (manifest.fileNames[lower]) return { icon: iconFile(manifest, manifest.fileNames[lower]) }
  for (const extension of extensionsOf(lower)) {
    if (manifest.fileExtensions[extension]) return { icon: iconFile(manifest, manifest.fileExtensions[extension]) }
  }
  return { icon: iconFile(manifest, manifest.file) }
}

module.exports = { ICON_DIR, loadManifest, iconFor, extensionsOf }
