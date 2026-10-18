#!/usr/bin/env bash
# 테스트 fixture 검증 — 레포 링크가 열리는지만 본다
ATHENA_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ATHENA_DIR/scripts/verify/_lib.sh"
REPO=globex-admin
REPO_DIR="$(resolve_repo_dir "$ATHENA_DIR/repos/$REPO")"
cd "$REPO_DIR" || exit 2
run_step "git 레포" git rev-parse --git-dir
print_summary "$REPO" "$REPO_DIR"
