const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const icons = require('../src/lib/file-icons')

// 규칙만 보는 작은 대응표(실제 표 모양 그대로)
const manifest = {
  iconDefinitions: {
    file: { iconPath: './../icons/file.svg' },
    folder: { iconPath: './../icons/folder.svg' },
    'folder-open': { iconPath: './../icons/folder-open.svg' },
    'folder-src': { iconPath: './../icons/folder-src.svg' },
    'folder-src-open': { iconPath: './../icons/folder-src-open.svg' },
    typescript: { iconPath: './../icons/typescript.svg' },
    'typescript-def': { iconPath: './../icons/typescript-def.svg' },
    nodejs: { iconPath: './../icons/nodejs.svg' },
  },
  file: 'file',
  folder: 'folder',
  folderExpanded: 'folder-open',
  folderNames: { src: 'folder-src' },
  folderNamesExpanded: { src: 'folder-src-open' },
  fileNames: { 'package.json': 'nodejs' },
  fileExtensions: { ts: 'typescript', 'd.ts': 'typescript-def' },
}

test('확장자: 긴 것부터 · 맨 앞 점은 확장자가 아님', () => {
  assert.deepEqual(icons.extensionsOf('a.test.ts'), ['test.ts', 'ts'])
  assert.deepEqual(icons.extensionsOf('.bashrc'), [])
  assert.deepEqual(icons.extensionsOf('.eslintrc.json'), ['json'])
  assert.deepEqual(icons.extensionsOf('Makefile'), [])
})

test('파일: 이름 통째 → 긴 확장자 → 짧은 확장자 → 기본 · 대소문자 무시', () => {
  assert.deepEqual(icons.iconFor(manifest, 'package.json', false), { icon: 'nodejs' })
  assert.deepEqual(icons.iconFor(manifest, 'index.d.ts', false), { icon: 'typescript-def' })
  assert.deepEqual(icons.iconFor(manifest, 'Main.TS', false), { icon: 'typescript' })
  assert.deepEqual(icons.iconFor(manifest, 'weird.xyz', false), { icon: 'file' })
})

test('폴더: 이름별 닫힘·열림 · 그 밖은 기본', () => {
  assert.deepEqual(icons.iconFor(manifest, 'src', true), { icon: 'folder-src', iconOpen: 'folder-src-open' })
  assert.deepEqual(icons.iconFor(manifest, 'Anything', true), { icon: 'folder', iconOpen: 'folder-open' })
})

test('실제 대응표: 흔한 것들이 진짜 SVG 로 이어진다', () => {
  const real = icons.loadManifest()
  for (const [name, isDir] of [['index.ts', false], ['README.md', false], ['package.json', false], ['main.js', false], ['src', true], ['weird.xyz', false]]) {
    const icon = icons.iconFor(real, name, isDir)
    for (const file of [icon.icon, icon.iconOpen].filter(Boolean)) {
      assert.ok(fs.existsSync(path.join(icons.ICON_DIR, `${file}.svg`)), `${name} → ${file}.svg 가 없다`)
    }
  }
  assert.equal(icons.iconFor(real, 'index.ts', false).icon, 'typescript')
})
