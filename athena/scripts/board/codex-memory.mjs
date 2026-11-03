// @ts-check
// 공식 문서: https://learn.chatgpt.com/docs/customization/memories#memory-storage
// memories와 memories_v2는 생성된 로컬 상태다. 스키마를 추정해 변환하거나 쓰지 않고 Markdown만 보여 준다.
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexHome } from '../lib/codex-local.mjs'

/** @param {string} [home] */
export const codexMemorySources = (home = codexHome()) => ['memories', 'memories_v2'].map((store) => {
  const dir = join(home, store)
  /** @type {{ file: string; title: string; type: string; description: string; updated: string; body: string }[]} */
  const items = []
  /** @param {string} folder @param {string} relative */
  const walk = (folder, relative) => {
    try {
      if (!lstatSync(folder).isDirectory()) return
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const file = join(folder, entry.name)
        const name = relative + entry.name
        if (entry.isDirectory()) walk(file, `${name}/`)
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const stat = lstatSync(file)
          if (stat.size > 2 * 1024 * 1024) continue
          const body = readFileSync(file, 'utf8').trim()
          items.push({ file: name, title: body.match(/^#\s+(.+)$/m)?.[1] || name, type: '', description: '', updated: stat.mtime.toISOString().slice(0, 10), body })
        }
      }
    } catch { /* 없는 저장소나 생성 중인 파일이 다른 출처를 막지 않는다 */ }
  }
  walk(dir, '')
  return { source: 'codex', label: `Codex · ${store}`, dir, items: items.sort((left, right) => left.file.localeCompare(right.file)) }
})
