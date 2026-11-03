// @ts-check
// 사건에는 원래 계획서 경로가 남는다. 보관 후에도 meta.json 의 from.plan 으로 제목을 찾는다.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** @param {string} path */
const read = (path) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
/** @param {string} text */
const titleOf = (text) => (text.match(/^#\s+(.+)$/m)?.[1] ?? '').replace(/\*\*|`/g, '').trim()
/** @param {string} id */
const safePlan = (id) => /^plans\/[^\0]+\.md$/.test(id) && !id.split('/').includes('..') && !id.includes('\\')

/** @param {string} root @param {string[]} ids */
export const planTitles = (root, ids) => {
  const labels = new Map(ids.map((id) => {
    const text = safePlan(id) ? read(join(root, id)) : ''
    return [id, { title: titleOf(text), exists: Boolean(text), archived: false }]
  }))
  const missing = new Set(ids.filter((id) => safePlan(id) && !labels.get(id)?.exists))
  if (!missing.size) return labels
  let entries
  try { entries = readdirSync(join(root, 'archive'), { withFileTypes: true }) } catch { return labels }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, 'archive', entry.name)
    try {
      const meta = JSON.parse(read(join(dir, 'meta.json')))
      if (!missing.has(meta.from?.plan)) continue
      // 묶음의 meta.title 은 이슈 제목일 수 있으므로 계획서 본문 제목을 먼저 읽는다.
      const title = titleOf(read(join(dir, 'plan.md'))) || (meta.kind === 'plan' && typeof meta.title === 'string' ? meta.title : '')
      if (title) {
        labels.set(meta.from.plan, { title, exists: false, archived: true })
        missing.delete(meta.from.plan)
      }
    } catch { /* 깨진 보관 기록은 다른 계획서 제목 조회를 막지 않는다. */ }
  }
  return labels
}
