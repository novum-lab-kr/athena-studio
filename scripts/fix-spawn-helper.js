// node-pty 1.1.0 맥 prebuild 의 spawn-helper 가 실행 권한 없이 풀리면 "posix_spawnp failed" 로 터미널이 안 뜬다.
// 설치 직후 실행 권한을 다시 붙인다(없으면 그냥 지나간다).
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
for (const dir of ['darwin-arm64', 'darwin-x64']) {
  const helper = path.join(root, dir, 'spawn-helper')
  try {
    fs.chmodSync(helper, 0o755)
  } catch {}
}
