#!/usr/bin/env bash
# 화면 계층 지킴이 — Athena Studio 데몬을 직접 부르거나 ATHENA_STUDIO_* 를 읽는 코드·지시문이 화면 계층(scripts/screen) 밖에 생기지 않았는지 본다.
# 사용: scripts/screen-lint.sh   → 걸린 줄을 보여 주고 1, 없으면 0 (보는 곳: scripts · bin · .claude · .codex)
#
# 걸리는 것: ATHENA_STUDIO(_<이름>) · athena-studio-cli · .athena-studio/daemon.json(데몬 접속 파일)
#   사용자 안내 글에 화면 이름이 필요하면 "$(scripts/screen name)"(node 는 screenName()) — 지금 백엔드 이름이 들어간다
# 허용(데몬을 직접 다뤄야 하는 곳):
#   scripts/lib/screen.py           studio 백엔드
#   scripts/screen-check/           가짜 데몬 CLI 회귀 검사
#   scripts/screen-lint.sh          이 파일
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATTERN="ATHENA_STUDIO([^[:alnum:]]|_[A-Z]|$)|athena-studio-cli|\.athena-studio/daemon\.json"

found="$(cd "$ATHENA_DIR" && git ls-files -co --exclude-standard -z -- scripts bin .claude .codex \
  | grep -zv -e '^scripts/lib/screen\.py$' -e '^scripts/screen-check/' -e '^scripts/screen-lint\.sh$' \
  | xargs -0 grep -nE "$PATTERN" 2>/dev/null)"
if [ -n "$found" ]; then
  echo "화면 계층 밖에서 Studio 데몬을 직접 다루는 줄 — scripts/screen 으로 옮긴다(docs/extending.md \"화면 계층\"):" >&2
  printf '%s\n' "$found" >&2
  exit 1
fi
echo "✔ screen-lint — Studio 데몬은 화면 계층(scripts/lib/screen.py)에서만"
