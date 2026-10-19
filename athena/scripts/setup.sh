#!/usr/bin/env bash
# 팀원 최초 설정: athena.config.json 의 레포들을 repos/<name> 심볼릭 링크로 연결하고 도구를 점검한다.
# 사용: scripts/setup.sh [--root <레포들이 있는 폴더>] [--links-only]   (기본: athena.config.json 의 reposRoot, 보통 hermes 상위 폴더)
#   --links-only  레포 링크만 — 도구 점검·QA 의존성·Chromium 설치는 하지 않는다
#                 (세션 시작 훅 setup-check.py 가 빠진 링크를 이어 줄 때 쓴다 — 공용 도구를 말없이 바꾸지 않게)
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ATHENA_DIR"
ROOT_OVERRIDE=""; LINKS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT_OVERRIDE="${2:-}"; shift 2 ;;
    --links-only) LINKS_ONLY=1; shift ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
done

CONFIG_ROOT="$(python3 -c 'import sys; sys.path.insert(0, "scripts/lib"); from athena_config import load; print(load(".")["reposRoot"])')"
REPOS_ROOT="${ROOT_OVERRIDE:-$CONFIG_ROOT}"
case "$REPOS_ROOT" in /*) ;; *) REPOS_ROOT="$ATHENA_DIR/$REPOS_ROOT" ;; esac
REPOS_ROOT="$(cd "$REPOS_ROOT" 2>/dev/null && pwd)" || { echo "❌ 레포 루트가 없습니다: ${ROOT_OVERRIDE:-$CONFIG_ROOT}"; exit 1; }

mkdir -p repos
echo "레포 루트: $REPOS_ROOT"
missing=0
# 레포 위치 — 보통 <레포 루트>/<이름>. 폴더로 묶여 있으면 athena.config.json 의 repoPaths(이 컴퓨터 설정 · /setup 이 적는다)
while IFS=$'\t' read -r name rel; do
  [ -n "$name" ] || continue
  target="$REPOS_ROOT/${rel:-$name}"
  link="repos/$name"
  if [ -d "$target/.git" ] || [ -f "$target/.git" ]; then
    [ -L "$link" ] && rm "$link"
    ln -s "$target" "$link"
    printf '  ✔ %-22s → %s\n' "$name" "$target"
  else
    printf '  ✖ %-22s 없음 (%s) — clone 후 다시 실행\n' "$name" "$target"
    missing=$((missing+1))
  fi
done < <(python3 -c 'import sys; sys.path.insert(0, "scripts/lib"); from athena_config import load; c = load("."); paths = c.get("repoPaths") or {}; print("\n".join(r["name"] + "\t" + paths.get(r["name"], "") for r in c["repos"]))')

if [ "$LINKS_ONLY" = 1 ]; then
  [ "$missing" -gt 0 ] && exit 1
  exit 0
fi

failed=0
echo
echo "도구 점검:"
for tool in git node pnpm claude; do
  if command -v "$tool" >/dev/null 2>&1; then
    ver="$("$tool" --version 2>/dev/null | head -1)"
    printf '  ✔ %-7s %s\n' "$tool" "$ver"
  else
    printf '  ✖ %-7s 없음\n' "$tool"
  fi
done


echo
echo "QA 시뮬레이션 도구 (scripts/qa — Playwright·dependency-cruiser):"
if [ -d "$ATHENA_DIR/scripts/qa/node_modules" ]; then
  echo "  ✔ 의존성 있음"
elif command -v npm >/dev/null 2>&1 && (cd "$ATHENA_DIR/scripts/qa" && "$ATHENA_DIR/scripts/heavy.sh" npm ci --silent >/dev/null 2>&1); then
  echo "  ✔ 의존성 설치 (npm ci)"
else
  echo "  ✖ 설치 실패 — cd scripts/qa && npm ci"; failed=$((failed+1))
fi
if [ -d "$ATHENA_DIR/scripts/qa/node_modules/playwright" ]; then
  if (cd "$ATHENA_DIR/scripts/qa" && npx --no-install playwright install chromium >/dev/null 2>&1); then echo "  ✔ Chromium 준비"
  else echo "  ✖ Chromium 설치 실패 — cd scripts/qa && npx playwright install chromium"; failed=$((failed+1)); fi
fi
echo "  · 로그인 세션은 각자 한 번: node scripts/qa/login.mjs (이메일 로그인 — docs/knowledge/common/verify.md \"QA 시뮬레이션\")"

echo
if [ "$missing" -gt 0 ]; then echo "⚠️  레포 $missing 개가 연결되지 않았습니다. 해당 에이전트는 동작하지 않습니다."; fi
if [ "$failed" -gt 0 ]; then echo "⚠️  도구 설치·패치 $failed 개가 실패했습니다(위 ✖ 줄). 고친 뒤 다시 실행하세요."; fi
if [ "$missing" -eq 0 ] && [ "$failed" -eq 0 ]; then echo "✅ 준비 완료. athena 폴더에서 claude 를 실행하세요."; else exit 1; fi
