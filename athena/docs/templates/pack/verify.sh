#!/usr/bin/env bash
# {{repo}} 표준 검증 — 지금은 코어 공용 검증(_generic.sh: lint · typecheck · test / ruff · pytest)을 부른다.
# 레포에 맞게 바꾸려면 이 파일을 직접 쓴다(예: scripts/verify/_lib.sh 의 run_step·skip_step·print_summary).
# 사용: scripts/verify/{{repo}}.sh{{appUsage}}
exec "$(cd "$(dirname "$0")" && pwd)/_generic.sh" {{repo}} "$@"
