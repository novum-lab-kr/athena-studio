#!/usr/bin/env bash
# 새 워크트리 준비 — 코어 new-branch.sh 가 워크트리를 만든 뒤 부른다(수동으로 다시 돌려도 된다).
# 왜: 워크트리에는 node_modules 가 없어 검증의 화면 빌드가 실패하고, npm 11 allow-scripts 때문에 electron · node-pty 설치 스크립트가
#     돌지 않아 Electron 실행 파일 · .dev-app 이 없다. 데몬 통합 테스트도 node-pty 가 없으면 실패가 아니라 skip 으로 넘어가 검증이 ✅ 로 보인다.
# 앞에 scripts/heavy.sh 를 붙여 부른다(new-branch.sh 가 붙인다).
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci
# npm 11 이 막은 설치 스크립트를 손으로 — 이미 됐으면 건너뛰는 동작이라 다시 돌려도 안전하다
[ -e node_modules/electron/path.txt ] || node node_modules/electron/install.js
node scripts/fix-spawn-helper.js
if [ "$(uname)" = Darwin ]; then node scripts/dev-app.js make; fi
echo "worktree-setup: 끝"
