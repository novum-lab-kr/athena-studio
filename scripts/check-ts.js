// @ts-check
// .mts 문법 검사 — node --check 는 타입을 지우지 않아서 .mts 를 못 읽는다(Node 24 실측).
// Node 가 실행할 때와 같은 타입 지우기(node:module stripTypeScriptTypes)를 거친 뒤 ES 모듈로 문법 검사한다.
// 지울 수 없는 문법(enum · namespace · 매개변수 속성 · import =)이면 여기서 실패한다 — 타입 검사는 npm run typecheck
//   node scripts/check-ts.js <파일.mts>…
const fs = require('node:fs')
const { stripTypeScriptTypes } = require('node:module')
const { spawnSync } = require('node:child_process')

let failed = 0
for (const file of process.argv.slice(2)) {
  let code
  try {
    code = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
    continue
  }
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8' })
  if (checked.status !== 0) {
    console.error(`${file}:\n${checked.stderr}`)
    failed += 1
  }
}
process.exitCode = failed ? 1 : 0
