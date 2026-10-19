// 폴더 훑기 — 팩 파일은 코어 자리에 심볼릭 링크로 걸린다(athena pack link).
// readdirSync(…, { withFileTypes: true }) 의 isDirectory() 는 링크를 폴더로 치지 않으니 이걸 쓴다
import { statSync } from 'node:fs'
import { join } from 'node:path'

export const isDirEntry = (dir, entry) => entry.isDirectory() || (entry.isSymbolicLink() && (() => {
  try { return statSync(join(dir, entry.name)).isDirectory() } catch { return false }
})())
