#!/usr/bin/env bash
# 화면 계층 지킴이 — herdr·Athena Studio 데몬을 직접 부르거나 HERDR_*·ATHENA_STUDIO_* 를 읽는 코드·지시문이 화면 계층(scripts/screen) 밖에 생기지 않았는지 본다.
# 사용: scripts/screen-lint.sh   → 걸린 줄을 보여 주고 1, 없으면 0 (보는 곳: scripts · bin · .claude · .codex)
#
# 걸리는 것: HERDR_<이름> · herdr <pane|tab|workspace|plugin|agent> <하위 명령> · 'herdr' "herdr"(실행 인자) · command -v herdr · which('herdr')
#           ATHENA_STUDIO(_<이름>) · athena-studio-cli · .athena-studio/(데몬 접속 파일) — studio 백엔드도 같은 규칙
#   "herdr pane 에 띄운다" 같은 설명 글은 걸리지 않는다 — herdr 는 사람이 설치하는 제품 이름으로 남는다
#   사용자 안내 글에 화면 이름이 필요하면 "$(scripts/screen name)"(node 는 screenName()) — 지금 백엔드 이름이 들어간다
# 허용(herdr 를 직접 다뤄야 하는 곳):
#   scripts/lib/screen.py           herdr · studio 백엔드
#   scripts/herdr-sidebar-*.sh      herdr 플러그인(사이드바) 자체 — 설치·실행 파일·redeploy, 원본 pane layout JSON 을 사이드바에 넘긴다
#   scripts/screen-check/           가짜 herdr · 가짜 데몬 CLI 회귀 검사
#   scripts/screen-lint.sh          이 파일
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATTERN="HERDR_[A-Z]|ATHENA_STUDIO([^[:alnum:]]|_[A-Z]|$)|athena-studio-cli|\.athena-studio/|(^|[^[:alnum:]_-])herdr[[:space:]]+(pane|tab|workspace|plugin|agent)[[:space:]]+(list|current|get|layout|process-info|neighbor|edges|focus|resize|zoom|read|rename|input|split|swap|move|close|send-text|send-keys|wait-output|run|report-[a-z-]+|release-agent|create|action|install|uninstall|invoke)([^[:alnum:]_-]|$)|['\"]herdr['\"]|command -v herdr|which\\(['\"]herdr"

found="$(cd "$ATHENA_DIR" && git ls-files -co --exclude-standard -z -- scripts bin .claude .codex \
  | grep -zv -e '^scripts/lib/screen\.py$' -e '^scripts/herdr-sidebar-[^/]*\.sh$' -e '^scripts/screen-check/' -e '^scripts/screen-lint\.sh$' \
  | xargs -0 grep -nE "$PATTERN" 2>/dev/null)"
if [ -n "$found" ]; then
  echo "화면 계층 밖에서 herdr·studio 를 직접 다루는 줄 — scripts/screen 으로 옮긴다(docs/extending.md \"화면 계층\"):" >&2
  printf '%s\n' "$found" >&2
  exit 1
fi
echo "✔ screen-lint — herdr·studio 는 화면 계층(scripts/lib/screen.py)과 허용 목록에서만"
