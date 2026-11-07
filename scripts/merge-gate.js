// @ts-check
// 머지 전 검사 — 코어 자동 머지(athena/scripts/pr-auto.mjs mergeGate)가 gh pr merge 직전에 PR 제목을 넘겨 부르고,
// Actions 넘기기(.github/workflows/athena-handoff.yml verify)가 넘김 머리 제목으로 부른다. 통과 0 · 막으면 1(stderr 첫 줄이 이유)
//   node scripts/merge-gate.js --title "<PR 제목>"
// 지금 하는 것: feat · ! 제목이면 다음 minor 의 CHANGELOG 절 확인(scripts/release-files.js gate — 머지 뒤 release-mac 이 그 절 없이 멈추지 않게)
const path = require('path')
const { execFileSync } = require('child_process')

try {
  execFileSync(process.execPath, [path.join(__dirname, 'release-files.js'), 'gate', ...process.argv.slice(2)], { stdio: 'inherit' })
} catch (error) {
  process.exit(typeof (/** @type {{ status?: unknown }} */ (error).status) === 'number' ? Number(/** @type {{ status: number }} */ (error).status) : 1)
}
