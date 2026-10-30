// @ts-check
// 이 모듈이 `node 파일` 로 직접 실행됐는지 — argv[1] 과 import.meta.url 을 둘 다 실제 경로로 풀어 견준다.
// 글자 그대로 견주면 맥의 /var → /private/var 심볼릭 링크나 TMPDIR 끝의 `//` 처럼 같은 파일이 다른 글자로 올 때
// 직접 실행했는데도 import 로 보고 아무 일도 안 하고 끝난다(2026-10 b051a7)
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} metaUrl 부르는 파일의 import.meta.url */
export const isMainModule = (metaUrl) => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}
