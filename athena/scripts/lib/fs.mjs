// 폴더 훑기 — 팩 파일은 코어 자리에 심볼릭 링크로 걸린다(athena pack link).
// readdirSync(…, { withFileTypes: true }) 의 isDirectory() 는 링크를 폴더로 치지 않으니 이걸 쓴다
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const isDirEntry = (dir, entry) => entry.isDirectory() || (entry.isSymbolicLink() && (() => {
  try { return statSync(join(dir, entry.name)).isDirectory() } catch { return false }
})())

// 레포 찾기가 열지 않는 홈 바로 아래 맥 보호 폴더 — 열면 macOS 가 앱에 접근 허락 창을 띄운다.
// 데스크탑 · 문서 · 다운로드는 레포가 있을 수 있어 넣지 않는다
export const PROTECTED_HOME_DIRS = ['Music', 'Movies', 'Pictures', 'Library']

const realOr = (path) => { try { return realpathSync(path) } catch { return resolve(path) } }

// path 가 홈 바로 아래 보호 폴더인가 — 이름을 먼저 보고, 부모가 홈인지는 링크를 풀어서도 본다(/tmp → /private/tmp 같은)
export const isProtectedHomeDir = (path) => {
  if (!PROTECTED_HOME_DIRS.includes(basename(path))) return false
  const parent = dirname(resolve(path))
  const home = resolve(homedir())
  return parent === home || realOr(parent) === realOr(home)
}
