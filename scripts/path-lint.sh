#!/usr/bin/env bash
# 경로 지킴이 — 계획서·이슈 경로를 실제 경로로 푸는 코드를 잡는다(여러 팩 계획서 4.2 · 1-0 스파이크 S2).
#
# 여러 팩 구조에서 plans/·issues/ 는 지금 팩 데이터(<데이터>/packs/<id>/…)를 가리키는 링크다. 계획서 경로를
# pwd -P · realpath · realpathSync · Path.resolve() 로 풀면 본체 밖 경로가 되어 "plans/ 아래가 아니다" 로 거부되거나,
# 팩을 바꾼 뒤 다른 팩을 가리킨다. 문서 ID 는 본체 기준 논리 경로로 다루고, 바꿔야 하면 scripts/lib/plan-path.sh(plan_rel)를 쓴다.
#
# 같은 줄에 실제 경로 풀기와 plan·issue 가 함께 있으면 실패. 허용 목록은 그 일을 일부러 하는 곳뿐이다.
# 사용: scripts/path-lint.sh   (검증 스크립트가 부른다 · 실패면 1)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
ALLOW='^(scripts/lib/plan-path\.sh|scripts/path-lint\.sh|scripts/screen-check/)'
hits="$(git ls-files -co --exclude-standard -- scripts bin 2>/dev/null | grep -Ev "$ALLOW" | while IFS= read -r file; do
  [ -f "$file" ] && [ ! -L "$file" ] || continue
  grep -nIE '(pwd -P|realpath|realpathSync|\.resolve\(\))' "$file" 2>/dev/null | grep -iE 'plan|issue' | sed "s#^#$file:#"
done)"
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "❌ 계획서·이슈 경로를 실제 경로로 푼다 — 본체 기준 논리 경로로(scripts/lib/plan-path.sh plan_rel)"
  exit 1
fi
echo "✅ 계획서·이슈 경로를 실제 경로로 푸는 코드 없음"
