#!/usr/bin/env bash
# commit-guard 훅 시험 — commit.sh 를 잘못 막지 않는지, 막아야 할 것은 여전히 막는지. 훅에 글자만 넣어 종료 코드를 본다(2 = 막힘, 0 = 통과) · 몇 초
#
# 사용: test/commit-guard-test.sh
#       HOOK=<다른 훅 파일> test/commit-guard-test.sh   (고치기 전 훅과 비교할 때)
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="${HOOK:-$SRC/scripts/hooks/commit-guard.py}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT   # 다른 레포의 워크트리인 척하는 cwd
# 훅은 자기 파일 기준 athena 루트의 scripts/ 를 허용한다 — 비교용 훅을 다른 곳에 두면 그 루트를 따로 준다
ROOT="${GUARD_ROOT:-$SRC}"
export COMMIT_GUARD_TEST_ROOT="$ROOT"   # $VAR 로 부르는 경로 시험용
FAIL=0
run() {   # <명령 글자> → 훅 종료 코드
  CMD="$1" CWD="$WORK" python3 -c 'import json,os,sys; json.dump({"cwd":os.environ["CWD"],"tool_input":{"command":os.environ["CMD"]}}, sys.stdout)' | python3 "$HOOK" >/dev/null 2>&1
  echo $?
}
check() {   # <기대: pass|block> <이름> <명령>
  local want=0 got; [ "$1" = block ] && want=2
  got="$(run "$3")"
  if [ "$got" = "$want" ]; then echo "  ✔ [$1] $2"; else echo "  ✖ [$1] $2 (종료 코드 $got)"; FAIL=1; fi
}

echo "아테나 레포의 commit.sh · ship.sh — 통과"
check pass "절대 경로" "$ROOT/scripts/commit.sh --plan p -m 'fix: a' -- a.txt"
check pass "\$VAR 경로" '$COMMIT_GUARD_TEST_ROOT/scripts/commit.sh -m m -- a'
check pass "\${VAR} 경로" '${COMMIT_GUARD_TEST_ROOT}/scripts/ship.sh --plan p'
check pass "heredoc 메시지 안 commit.sh 줄" "$ROOT/scripts/commit.sh -m \"\$(cat <<'EOF'
fix: 훅

scripts/commit.sh 가 막히던 문제
git commit 직접은 계속 막는다
EOF
)\" -- a"
check pass "따옴표 메시지에 줄바꿈" "$ROOT/scripts/commit.sh -m 'fix: x
commit.sh 로 커밋' -- a"

check pass "큰따옴표로 감싼 \$VAR 경로" '"$COMMIT_GUARD_TEST_ROOT"/scripts/commit.sh -m m'
case "$ROOT" in "$HOME"/*) check pass "~ 경로" "~${ROOT#"$HOME"}/scripts/commit.sh -m m" ;; esac
check pass "본문의 공백 종료자 모양 줄(' EOF' · 'EOF ' · 'EOF)')은 종료자가 아니다" $'cat <<\'EOF\'\n EOF\nEOF \nEOF)\ngit commit -m x\nEOF'
check pass "<<- 의 탭 들여쓴 종료자 앞 본문" $'cat <<-\'EOF\'\n\tgit push\n\tEOF'
check pass "따옴표 없는 heredoc 의 \\\$( 는 글자" "cat <<EOF
\\\$(git commit -m x)
EOF"
check pass "따옴표 없는 heredoc 의 \\\` 는 글자" "cat <<EOF
\\\`git push\\\`
EOF"

echo "막아야 할 것 — 계속 막힘"
check block "export 로 바꾼 \$VAR 경로" 'export COMMIT_GUARD_TEST_ROOT=/tmp/evil; $COMMIT_GUARD_TEST_ROOT/scripts/commit.sh -m m'
check block "대입한 \$VAR 경로" 'COMMIT_GUARD_TEST_ROOT=/tmp/evil; $COMMIT_GUARD_TEST_ROOT/scripts/commit.sh -m m'
check block "HOME 을 바꾼 ~ 경로" 'HOME=/tmp/evil; ~/x/scripts/commit.sh -m m'
check block "작은따옴표로 보호된 \$VAR 는 글자" "'\$COMMIT_GUARD_TEST_ROOT/scripts/commit.sh' -m m"
check block "역슬래시로 보호된 \$VAR 는 글자" "\\\$COMMIT_GUARD_TEST_ROOT/scripts/commit.sh -m m"
check block "큰따옴표 안 ~ 는 글자" '"~/x/scripts/commit.sh" -m m'
check block "산술식 안 << 뒤의 git push" "echo \$((a<<b))
git push
b"
check block "<<- 종료자 뒤의 git push" $'cat <<-\'EOF\'\nx\n\tEOF\ngit push'
check block "따옴표 없는 heredoc 의 \\\\\$( 는 실행" "cat <<EOF
\\\\\$(git commit -m x)
EOF"
check block "상대 경로 commit.sh" "scripts/commit.sh -m m"
check block "다른 위치 commit.sh" "/tmp/commit.sh -m m"
check block "없는 \$VAR 경로" '$NOPE_UNSET_VAR/scripts/commit.sh -m m'
check block "git commit 직접" "git commit -m x"
check block "git add -A" "git add -A"
check block "git push" "git push"
check block "heredoc 안 \$( ) 치환의 git commit" "cat <<EOF
\$(git commit -m x)
EOF"
check block "heredoc 뒤의 git commit" "cat <<'EOF'
hi
EOF
git commit -m x"
check block "주석 안 << 뒤의 git push" "# <<'EOF'
git push
EOF"
check block "빈 heredoc 뒤의 git commit" "cat <<'EOF'
EOF
git commit -m test
EOF"
check pass "종료자가 아닌 줄(EOF extra) 뒤도 본문(글)이다" "cat <<'EOF'
text
EOF extra
git push
EOF"
check block "따옴표 안 << 뒤의 git push" "echo '<<EOF'
git push
EOF"
check block "ship.sh --repo-agent" "$ROOT/scripts/ship.sh --repo-agent x"

[ "$FAIL" = 0 ] && echo "모두 통과" || echo "실패 있음"
exit "$FAIL"
