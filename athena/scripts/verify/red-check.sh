#!/usr/bin/env bash
# red-check — 이번 변경의 테스트가 구현 없이(base)도 통과하는지 본다(가짜 테스트 거르기 · 계획서 2026-10-29 red-check).
# 테스트를 base 에서 한 번 더 돌리니 무거운 명령이다 — heavy.sh 로 한 대에 하나씩 줄을 선다. 내용은 scripts/red-check.mjs · 결과 뜻은 docs/knowledge/common/verify.md "red-check"
#
# 사용: scripts/verify/red-check.sh --dir <워크트리> [--repo <레포>] [--base <ref>] [--committed] [--json]
#   → 검증 표와 같은 모양 한 줄(| `red-check` | <결과> | <초> |). ship.sh 가 PR 올릴 때(미리보기 포함) 부른다
#   exit 0 = ok · no-tests · test-only · 건너뜀(팩에 redCheck 칸 없음) / 1 = non-discriminating · unsupported · error(경고 — 막지 않는다) / 2 = 사용법
[ -z "${ATHENA_HEAVY_HELD:-}" ] && exec "$(cd "$(dirname "$0")/.." && pwd)/heavy.sh" "$0" "$@"
exec node "$(cd "$(dirname "$0")/.." && pwd)/red-check.mjs" "$@"
