#!/usr/bin/env bash
# 에이전트 로컬 커밋 — 사용자가 pane 에서 "커밋해줘" 또는 "PR 올려줘" 라고 했을 때만, 이 스크립트로만 커밋한다.
# push·PR 은 하지 않는다 — "PR 올려줘" 면 이 커밋 뒤에 scripts/ship.sh 로 이어 간다.
#
# 사용:
#   scripts/commit.sh --plan <plans/…md> --dir <워크트리> -m "<커밋 메시지>" [--verify "<검증 인자>"] -- <파일> [<파일>…]
#
# 옵션:
#   --verify "<인자>"          검증 스크립트 인자. 모노레포(kind: monorepo)는 바뀐 파일에서 앱을 찾는다(apps/<앱>/, packages/<pkg>/),
#                              발행 패키지 레포(kind: packages)는 패키지명을 준다
#   --allow-skip "이름|이름"    검증에서 건너뛰어도 되는 단계 — 사용자가 확인한 것만
#   --allow-main-checkout      메인 체크아웃(repos/<레포>)에 커밋 — 사용자가 명시했을 때만
#                              (main 직접 레포 — 팩 direct: true — 는 옵션 없이 메인 체크아웃의 작업 브랜치에 커밋한다)
#   --no-verify                검증 없이 — 사용자가 명시했을 때만. 계획서 기록에 남긴다
#   --merge-base               base 합치기 — 이 레포 prBase(origin/<prBase>)를 그 워크트리 브랜치에 merge --no-ff --no-commit 으로 건다(다른 ref 는 못 준다).
#                              커밋하지 않고 충돌 파일 · 다음 명령을 알린다 — 충돌을 푼 뒤 commit.sh -m … -- <푼 파일>… 가 merge 커밋을 만든다.
#                              -m · 파일 없이 · 미커밋 변경이 없을 때만 · main 직접 레포 · 이미 merge 중이면 거부(PR 충돌 풀기 · docs/pr-auto.md)
#
# 확인하는 것 (하나라도 걸리면 아무것도 바꾸지 않고 멈춘다)
#   - <워크트리> 가 등록된 git 워크트리이고 메인 체크아웃이 아니다(허용 옵션 제외)
#   - HEAD 가 브랜치에 붙어 있다(detached 아님) · 보호 브랜치(dev·main·master·stg·frz·prd*·release/*·dev-*)가 아니다
#   - 원래 스테이징돼 있던 변경이 없다 — 남의 변경이 섞이지 않게(스테이징된 경로가 전부 지정 파일이면 받는다 — git mv 한 이름 바꾸기는 옛 이름 · 새 이름을 둘 다 지정)
#     예외 — merge 진행 중(MERGE_HEAD 있음)이면 merge 가 스테이징한 변경을 받아 merge 커밋을 만든다(base 를 합쳐 충돌을 푼 뒤 · docs/pr-auto.md).
#     이때는 파일 없이(-- 만) 불러도 되고, HEAD 와 같은 내용으로 푼 파일도 받는다(merge 결과가 HEAD 와 같아도 merge 커밋).
#     지정 파일(푼 파일)에 충돌 표시가 남았거나, 스테이징한 뒤 미병합 파일이 남았거나, 커밋될 스테이징 전체에 비밀 파일 · 내용 · 충돌 표시가 있으면 거부. 실패해도 스테이징은 되돌리지 않는다(merge 결과라 되돌리면 base 쪽 변경이 빠진다)
#   - 파일은 글자 그대로의 경로만(디렉터리·glob 금지), 워크트리 안이고, 실제로 바뀐 파일이다
# 그다음: 지정 파일만 스테이징 → 그 상태로 엄격 검증(같은 트리로 이미 통과했으면 재사용 — scripts/verify/reuse.sh) → 검증 전후 스테이징·파일 내용·HEAD 가 같을 때만 커밋
#         → 계획서 "## Commits" 에 SHA·검증 결과를 한 줄 기록
# 실패하면 이 스크립트가 스테이징한 파일만 되돌린다(남의 스테이징은 애초에 없다).
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"   # 실제 경로 — 옛 폴더 이름(hermes 링크)으로 불려도 같은 값
# 이 스크립트의 git 호출에만(export 하지 않는다 — 검증 스크립트·lint-staged 가 :(glob) 으로 설정을 찾다 못 찾는다)
#   GIT_LITERAL_PATHSPECS=1  경로는 글자 그대로 — Next 동적 라우트(app/[id]/page.tsx)의 [ ] 를 패턴으로 읽지 않게
#   core.quotePath=false     한글 경로가 "\355…" 로 인용되지 않게
git() { GIT_LITERAL_PATHSPECS=1 command git -c core.quotePath=false "$@"; }
# 파일 목록은 NUL 구분(-z)으로 받아 줄로 바꾼다 — " \ 공백이 든 이름도 인용되지 않은 그대로 (줄바꿈이 든 이름은 다루지 않는다)
untracked_names() { git -C "$TOP" ls-files -z --others --exclude-standard | tr '\0' '\n'; }
# .npmrc 내용(표준 입력)에 토큰 값이 글자 그대로 있나 — _authToken 값을 떼어(공백 · 따옴표 걷고) 비었거나 ${이름} 하나면 괜찮다. 값은 출력하지 않는다
npmrc_literal_token() {
  # 맥 awk 는 정규식의 \x27 · {n} 을 모른다 — 작은따옴표는 -v 로, 이름은 글자 하나씩
  awk -v sq="'" '{ line = $0; sub(/^[ \t]+/, "", line); if (line ~ /^[#;]/) next
         at = index(line, "_authToken"); if (!at) next
         rest = substr(line, at + 10); if (rest !~ /^[ \t]*=/) next
         sub(/^[ \t]*=/, "", rest); sub(/[ \t\r]+$/, "", rest); sub(/^[ \t]+/, "", rest)
         if (substr(rest, 1, 1) == "\"" || substr(rest, 1, 1) == sq) { quote = substr(rest, 1, 1); if (substr(rest, length(rest), 1) == quote) rest = substr(rest, 2, length(rest) - 2) }
         if (rest == "" || rest ~ /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/) next
         found = 1 } END { exit found ? 0 : 1 }'
}

PLAN=""; DIR=""; MESSAGE=""; VERIFY_ARGS=""; ALLOW_SKIP=""; ALLOW_MAIN=0; NO_VERIFY=0; MERGE_BASE=0; FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    -m|--message) MESSAGE="${2:-}"; shift 2 ;;
    --verify) VERIFY_ARGS="${2:-}"; shift 2 ;;
    --allow-skip) ALLOW_SKIP="${2:-}"; shift 2 ;;
    --allow-main-checkout) ALLOW_MAIN=1; shift ;;
    --no-verify) NO_VERIFY=1; shift ;;
    --merge-base) MERGE_BASE=1; shift ;;
    --) shift; FILES=("$@"); break ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
done
fail() { echo "❌ 커밋하지 않았다: $*" >&2; exit 1; }

# 파일은 merge 진행 중일 때만 없어도 된다 — 아래에서 MERGE_HEAD 를 본 뒤 다시 확인한다
[ -n "$PLAN" ] && [ -n "$DIR" ] && { [ $MERGE_BASE = 1 ] || [ -n "$MESSAGE" ]; } \
  || { echo "사용: $0 --plan <plans/…md> --dir <워크트리> -m \"<메시지>\" [--verify …] -- <파일>…   |   $0 --plan … --dir … --merge-base" >&2; exit 2; }
# 본체 기준 논리 경로로 — 여러 팩 구조에서 plans/ 는 팩 데이터를 가리키는 링크라 실제 경로로 풀면 본체 밖이 된다(scripts/lib/plan-path.sh)
. "$ATHENA_DIR/scripts/lib/plan-path.sh"
PLAN="$(plan_rel "$ATHENA_DIR" "$PLAN")"
[ -f "$ATHENA_DIR/$PLAN" ] && case "$PLAN" in plans/*.md) true ;; *) false ;; esac || fail "계획서가 없다: $PLAN"

# ── 1. 워크트리·브랜치 ──────────────────────────────────────────────────
TOP="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)" || fail "git 레포가 아니다: $DIR"
TOP="$(cd "$TOP" && pwd -P)"
MAIN="$(git -C "$TOP" worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
MAIN="$(cd "$MAIN" && pwd -P)"
REPO="$(basename "$MAIN")"
# 메인 체크아웃의 이름은 athena.config.json 의 레포 이름과 다를 수 있다 — repos/ 링크로 찾는다
for link in "$ATHENA_DIR"/repos/*; do [ "$(cd "$link" 2>/dev/null && pwd -P)" = "$MAIN" ] && REPO="$(basename "$link")"; done
# 레포 종류(설정 kind) — monorepo 는 바뀐 파일에서 앱을 찾아 앱마다 검증, packages 는 검증할 패키지 이름이 필요하다
REPO_KIND="$(python3 - "$ATHENA_DIR" "$REPO" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
print(next((repo.get('kind', 'single') for repo in load(sys.argv[1])['repos'] if repo['name'] == sys.argv[2]), 'single'))
PYEOF
)"
# main 직접 레포(팩 direct: true)는 메인 체크아웃의 작업 브랜치에서 바로 커밋한다(docs/pack.md) — 기록에는 "main 직접" 으로 남긴다
DIRECT="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import load, is_direct; print(1 if is_direct(load(sys.argv[1]), sys.argv[2]) else 0)' "$ATHENA_DIR" "$REPO")" || fail "설정을 읽지 못했다(main 직접 확인)"
[ "$DIRECT" = 1 ] && [ "$TOP" = "$MAIN" ] && [ $ALLOW_MAIN = 0 ] && ALLOW_MAIN=2
if [ "$TOP" = "$MAIN" ] && [ $ALLOW_MAIN = 0 ]; then
  fail "메인 체크아웃(repos/$REPO)이다. 워크트리에서 커밋하거나, 사용자가 명시하면 --allow-main-checkout"
fi
git -C "$TOP" worktree list --porcelain | grep -qxF "worktree $TOP" || [ "$TOP" = "$MAIN" ] || fail "등록된 워크트리가 아니다: $TOP"
BRANCH="$(git -C "$TOP" symbolic-ref --short -q HEAD)" || fail "detached HEAD 다 — 브랜치를 만든 워크트리에서 커밋한다(scripts/new-branch.sh)"
# 보호 브랜치 — 흔한 운영·개발 이름 + 팩에 적힌 이 레포의 branch·prBase·extraPrBases(scripts/lib/athena_config.py)
PROTECTED="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import load, is_protected; print(1 if is_protected(load(sys.argv[1]), sys.argv[2], sys.argv[3]) else 0)' "$ATHENA_DIR" "$REPO" "$BRANCH")" || fail "설정을 읽지 못했다(보호 브랜치 확인)"
[ "$PROTECTED" = 0 ] || fail "보호 브랜치($BRANCH)에는 커밋하지 않는다"

# ── base 합치기(--merge-base) — 이 레포 prBase(origin/<prBase>)만 merge 를 건다. 커밋은 하지 않는다 ─────────────
# 다른 ref 는 받지 않는다(옵션에 값이 없다). 충돌을 푼 뒤 commit.sh -m … -- <푼 파일>… 로 merge 커밋을 만든다(아래 merge 진행 중 예외)
if [ $MERGE_BASE = 1 ]; then
  mbfail() { echo "❌ base 를 합치지 않았다: $*" >&2; exit 1; }
  [ "$DIRECT" = 0 ] || mbfail "main 직접 레포는 base 합치기 대상이 아니다"
  { [ -z "$MESSAGE" ] && [ ${#FILES[@]} = 0 ]; } || mbfail "--merge-base 는 -m · 파일을 받지 않는다 — merge 를 건 뒤 충돌을 풀고 commit.sh -m … -- <푼 파일>… 로 커밋한다"
  # PR base — ship.sh 와 같은 자리(레포 prBase · 모노레포면 앱 prBase)
  PR_BASE="$(python3 - "$ATHENA_DIR" "$REPO" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
repo = next((entry for entry in load(sys.argv[1])['repos'] if entry['name'] == sys.argv[2]), {})
print(repo.get('prBase') or next((app.get('prBase') for app in (repo.get('apps') or {}).values() if app.get('prBase')), ''))
PYEOF
)"
  [ -n "$PR_BASE" ] || mbfail "$REPO 의 prBase 가 설정에 없다"
  [ "$PR_BASE" != "$BRANCH" ] || mbfail "지금 브랜치가 prBase($PR_BASE)다"
  LOCK="$(git -C "$TOP" rev-parse --git-dir)/hermes-commit.lock"
  mkdir "$LOCK" 2>/dev/null || mbfail "다른 커밋·push 가 진행 중이다($LOCK)"
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  ! git -C "$TOP" rev-parse -q --verify MERGE_HEAD >/dev/null || mbfail "이미 merge 중이다 — 충돌을 풀고 commit.sh -m … -- <푼 파일>… 로 merge 커밋"
  [ -z "$(git -C "$TOP" status --porcelain --untracked-files=no)" ] || mbfail "커밋하지 않은 변경이 있다 — merge 에 섞이지 않게 먼저 커밋한다"
  git -C "$TOP" fetch --quiet origin "$PR_BASE" || mbfail "fetch 실패 — origin/$PR_BASE 를 받지 못했다"
  BASE_SHA="$(git -C "$TOP" rev-parse -q --verify "refs/remotes/origin/$PR_BASE")" || mbfail "origin/$PR_BASE 가 없다"
  if git -C "$TOP" merge-base --is-ancestor "$BASE_SHA" HEAD; then echo "✅ 합칠 게 없다 — origin/$PR_BASE(${BASE_SHA:0:7})가 이미 $BRANCH 에 들어 있다"; exit 0; fi
  # 메시지는 git 기본(Merge remote-tracking branch …) — 커밋할 때 commit.sh -m 이 정한다
  git -C "$TOP" merge --no-ff --no-commit "$BASE_SHA" >/dev/null 2>&1
  git -C "$TOP" rev-parse -q --verify MERGE_HEAD >/dev/null || mbfail "merge 를 걸지 못했다(미추적 파일이 덮일 자리일 수 있다) — git -C $TOP status 로 확인"
  UNMERGED="$(git -C "$TOP" diff --name-only --diff-filter=U)"
  echo "── origin/$PR_BASE(${BASE_SHA:0:7})를 $BRANCH 에 합치는 중(merge --no-ff --no-commit · 커밋은 아직)"
  if [ -n "$UNMERGED" ]; then
    echo "   충돌 $(printf '%s\n' "$UNMERGED" | wc -l | tr -d ' ')개 — 풀고 나서 그 파일들을 -- 뒤에 준다:"; printf '%s\n' "$UNMERGED" | sed 's/^/     /'
  else
    echo "   충돌 없음 — 파일 없이(-- 만) 커밋해도 된다(merge 결과가 이미 스테이징돼 있다)"
  fi
  echo "   다음: $0 --plan $PLAN --dir $TOP -m '<메시지>' -- [<푼 파일>…]   (merge 커밋 · 엄격 검증 · 계획서 기록 · 파일 없이도 된다)"
  exit 0
fi

# ── 2. 스테이징·파일 ────────────────────────────────────────────────────
# 워크트리마다 한 번에 하나만 — 스테이징을 보기 전에 잡는다(둘이 같이 "스테이징 없음" 을 보고 들어오지 않게 · ship.sh 의 push 도 같은 잠금)
LOCK="$(git -C "$TOP" rev-parse --git-dir)/hermes-commit.lock"
mkdir "$LOCK" 2>/dev/null || fail "다른 커밋·push 가 진행 중이다($LOCK)"
STAGED=0; COMMITTED=0
# merge 진행 중이면 스테이징은 merge 결과다 — 되돌리면(HEAD 로 reset) base 쪽 변경이 빠진 채 다음 커밋이 될 수 있어 그대로 둔다
MERGING=0; MERGE_SHA=""
if MERGE_SHA="$(git -C "$TOP" rev-parse -q --verify MERGE_HEAD 2>/dev/null)"; then MERGING=1; fi
unstage() {
  if [ $MERGING = 1 ]; then echo "   (merge 중이라 스테이징은 되돌리지 않았다 — 그대로 고친 뒤 다시)" >&2; STAGED=0; return; fi
  git -C "$TOP" reset -q -- ${FILES[@]+"${FILES[@]}"} 2>/dev/null; STAGED=0
}
# 어떤 이유로 끝나든(실패·Ctrl+C·TERM·예상 못 한 오류) 커밋 전이면 이 스크립트가 올린 스테이징을 되돌린다
cleanup() { [ $STAGED = 1 ] && [ $COMMITTED = 0 ] && unstage; rmdir "$LOCK" 2>/dev/null; rm -f "${UNTRACKED_LIST:-}" 2>/dev/null; }
trap cleanup EXIT
trap 'echo "❌ 중단됐다 — 스테이징을 되돌렸다" >&2; exit 130' INT TERM

# 이미 스테이징된 변경은 남의 것일 수 있어 거부한다. 단 스테이징된 경로가 전부 지정 파일이면 받는다 — git mv 로 이름을 바꾸면 옛 이름 · 새 이름이 바로 스테이징되는데,
# 이름 바꾸기는 옛 이름 · 새 이름을 둘 다 지정하는 것으로 충분하다(스테이징을 풀 필요 없음 · 이름 바꾸기를 --no-renames 로 풀어 두 경로를 모두 본다)
if [ $MERGING = 0 ] && ! git -C "$TOP" diff --cached --quiet; then
  PRESTAGED_EXTRA="$(git -C "$TOP" diff --cached --no-renames --name-only | grep -vxF -f <(printf '%s\n' ${FILES[@]+"${FILES[@]}"}) || true)"
  [ -z "$PRESTAGED_EXTRA" ] || fail "원래 스테이징돼 있던 변경이 있다(남의 변경일 수 있다). git -C $TOP diff --cached --stat 으로 확인 — 이 스크립트는 건드리지 않는다. 지정 파일의 변경이면 파일 목록에 같이 넣는다(이름 바꾸기는 옛 이름 · 새 이름 둘 다): $PRESTAGED_EXTRA"
fi
# 파일 없이 부르는 것은 merge 커밋일 때만(merge 결과가 이미 다 스테이징돼 있다 — 충돌 파일을 지금 브랜치 내용으로 풀어 HEAD 와 차이가 없을 때 등)
[ ${#FILES[@]} -gt 0 ] || [ $MERGING = 1 ] || { echo "사용: $0 --plan <plans/…md> --dir <워크트리> -m \"<메시지>\" [--verify …] -- <파일>…" >&2; exit 2; }
for file in ${FILES[@]+"${FILES[@]}"}; do
  # 글자 그대로 쓰므로 [ ] 는 받는다(동적 라우트). * ? 는 셸 glob 이 덜 펼쳐진 것일 수 있어 거부
  case "$file" in *'*'*|*'?'*|/*|../*|*/../*) fail "파일은 워크트리 기준 글자 그대로의 상대 경로만: $file" ;; esac
  [ -d "$TOP/$file" ] && fail "디렉터리는 받지 않는다: $file"
  # merge 중에는 merge 가 이미 스테이징한 파일(base 쪽 변경 · 푼 파일)도 받는다 — status 가 HEAD 와 다르면 바뀐 것
  # merge 중에는 HEAD 와 같은 내용으로 푼 파일(지금 브랜치 쪽을 고른 충돌)도 받는다 — 아래 미병합 · 스테이징 전체 검사가 본다
  [ $MERGING = 1 ] || [ -n "$(git -C "$TOP" status --porcelain -- "$file")" ] || fail "바뀐 게 없는 파일이다: $file"
  # 비밀 파일은 커밋하지 않는다 — 이름(.env·키·인증서)과 내용(개인키 · .npmrc 의 글자 그대로 토큰)으로 본다. 값은 읽어도 출력하지 않는다
  name="${file##*/}"
  case "$name" in
    .env.example|.env.sample|.env.template|*.env.example) ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|.netrc)
      fail "비밀 파일로 보인다: $file — 커밋하지 않는다(필요하면 사용자가 직접 확인하고 커밋)" ;;
  esac
  if [ -f "$TOP/$file" ]; then
    grep -qE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$TOP/$file" 2>/dev/null && fail "개인키가 들어 있다: $file — 커밋하지 않는다"
    [ "$name" = .npmrc ] && npmrc_literal_token < "$TOP/$file" \
      && fail "토큰 값이 글자 그대로 들어 있다: $file — \${NPM_TOKEN} 같은 참조로 바꾼 뒤 커밋"
  fi
done
HEAD_BEFORE="$(git -C "$TOP" rev-parse HEAD)"

if [ $MERGING = 1 ]; then
  # 충돌 표시가 남은 파일은 스테이징하기 전에 거부한다 — git add 하면 미병합 표시가 사라져 다음에 알아보기 어렵다
  for file in ${FILES[@]+"${FILES[@]}"}; do
    [ -f "$TOP/$file" ] && grep -qE '^(<<<<<<<|>>>>>>>) ' "$TOP/$file" 2>/dev/null && fail "충돌 표시(<<<<<<< · >>>>>>>)가 남은 파일이다: $file — 충돌을 다 푼 뒤 다시"
  done
fi
STAGED=1
# 디스크에도 인덱스에도 없는 경로(이름 바꾸기의 옛 이름 — 이미 삭제로 스테이징됨)는 git add 가 pathspec 오류를 내므로 뺀다
ADD_FILES=()
for file in ${FILES[@]+"${FILES[@]}"}; do
  if [ -e "$TOP/$file" ] || [ -L "$TOP/$file" ] || git -C "$TOP" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then ADD_FILES+=("$file"); fi
done
[ ${#ADD_FILES[@]} = 0 ] || git -C "$TOP" add -- "${ADD_FILES[@]}" || { unstage; fail "git add 실패"; }
if [ $MERGING = 1 ]; then
  # merge 커밋 — 스테이징은 merge 결과 전체(base 쪽 변경 + 푼 파일). 미병합 파일이 남았으면 커밋하지 않는다
  UNMERGED="$(git -C "$TOP" diff --name-only --diff-filter=U | tr '\n' ' ')"
  [ -z "$UNMERGED" ] || fail "merge 중 아직 풀지 않은 파일이 있다: ${UNMERGED}— 충돌을 풀고 그 파일도 -- 뒤에 준다"
  # merge 커밋에는 지정하지 않은 스테이징 파일도 들어간다 — 비밀 파일 · 내용 · 충돌 표시 검사를 커밋될 스테이징 전체(인덱스 내용)에 한다(값은 출력하지 않는다)
  while IFS= read -r staged; do
    [ -n "$staged" ] || continue
    sname="${staged##*/}"
    case "$sname" in
      .env.example|.env.sample|.env.template|*.env.example) ;;
      .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|.netrc) fail "merge 결과에 비밀 파일로 보이는 것이 스테이징돼 있다: $staged — 커밋하지 않는다" ;;
    esac
    git -C "$TOP" show ":$staged" 2>/dev/null | grep -qE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' && fail "merge 결과에 개인키가 든 파일이 있다: $staged — 커밋하지 않는다"
    [ "$sname" = .npmrc ] && git -C "$TOP" show ":$staged" 2>/dev/null | npmrc_literal_token \
      && fail "merge 결과의 $staged 에 토큰 값이 글자 그대로 들어 있다 — 커밋하지 않는다"
    git -C "$TOP" show ":$staged" 2>/dev/null | grep -qE '^(<<<<<<<|>>>>>>>) ' && fail "merge 결과에 충돌 표시(<<<<<<< · >>>>>>>)가 남은 파일이 있다: $staged — 충돌을 다 푼 뒤 다시"
  done < <(git -C "$TOP" diff --cached --name-only --diff-filter=ACMR)
  echo "── merge 커밋: MERGE_HEAD ${MERGE_SHA:0:7} 를 합친다(스테이징된 merge 결과 전체 · 지정 파일 ${#FILES[@]}개)"
else
  # 지정한 파일 말고는 스테이징에 없어야 한다
  EXTRA="$(git -C "$TOP" diff --cached --name-only | grep -vxF -f <(printf '%s\n' "${FILES[@]}") || true)"
  [ -z "$EXTRA" ] || { unstage; fail "지정하지 않은 파일이 스테이징됐다: $EXTRA"; }
fi
TREE_BEFORE="$(git -C "$TOP" write-tree)"
# 검증은 작업 트리 전체에서 돈다 — 전후 비교도 지정 파일만이 아니라 트리 전체를 본다
#   스테이징 diff · 추적 파일 diff · 추적 파일 상태 · **검증 전부터 있던** 미추적 파일의 내용
# 검증 중 **새로** 생긴 미추적 파일(storybook-static 같은 gitignore 안 된 산출물)은 커밋에 안 들어가므로 거부하지 않고 알리고 기록만 한다
UNTRACKED_LIST="$(mktemp -t hermes-commit-untracked)"
untracked_names > "$UNTRACKED_LIST"
# 파일마다 git 을 부르면 미추적 파일이 수천 개일 때 몇 분씩 걸린다 — 존재 확인은 셸 내장, 해시는 git 한 번(--stdin-paths)
untracked_state() {
  {
    while IFS= read -r path; do [ -f "$TOP/$path" ] && printf '%s\n' "$path"; done < "$UNTRACKED_LIST" | git -C "$TOP" hash-object --stdin-paths
    while IFS= read -r path; do [ -f "$TOP/$path" ] || printf 'gone %s\n' "$path"; done < "$UNTRACKED_LIST"
  } | shasum | cut -c1-12
}
tree_state() { printf '%s|%s|%s|%s' "$(git -C "$TOP" diff --cached | shasum | cut -c1-12)" "$(git -C "$TOP" diff | shasum | cut -c1-12)" "$(git -C "$TOP" status --porcelain --untracked-files=no | shasum | cut -c1-12)" "$(untracked_state)"; }
STATE_BEFORE="$(tree_state)"
# 지정 밖 미커밋 변경 — 검증 결과에 섞였을 수 있다. 막지는 않고 알리고 기록한다(docs/knowledge/common/git.md)
#   merge 중이면 merge 가 스테이징한 파일(merge 커밋에 들어간다)은 지정 밖으로 세지 않는다
COMMITTING="$(printf '%s\n' ${FILES[@]+"${FILES[@]}"}; [ $MERGING = 0 ] || git -C "$TOP" diff --cached --name-only)"
OUTSIDE="$(git -C "$TOP" status --porcelain -z --untracked-files=all | tr '\0' '\n' | cut -c4- | grep -vxF -f <(printf '%s\n' "$COMMITTING") | wc -l | tr -d ' ')"
[ "$OUTSIDE" = 0 ] || echo "⚠️ 지정하지 않은 미커밋 변경이 ${OUTSIDE}개 있다 — 검증은 작업 트리 전체에서 돌아 그 변경이 결과에 섞였을 수 있다(커밋에는 안 들어간다)" >&2

# ── 3. 엄격 검증 ────────────────────────────────────────────────────────
VERIFY_NOTE="검증 생략(사용자 지시)"; RESULTS=""
if [ $NO_VERIFY = 0 ]; then
  SCRIPT="$ATHENA_DIR/scripts/verify/$REPO.sh"
  [ -x "$SCRIPT" ] || { unstage; fail "검증 스크립트가 없다: scripts/verify/$REPO.sh"; }
  if [ -z "$VERIFY_ARGS" ] && [ "$REPO_KIND" = monorepo ]; then
    # 바뀐 파일에서 앱·패키지를 찾는다
    # merge 커밋은 스테이징 전체(base 쪽 변경 포함)에서 앱을 찾는다
    VERIFY_ARGS="$({ printf '%s\n' ${FILES[@]+"${FILES[@]}"}; [ $MERGING = 0 ] || git -C "$TOP" diff --cached --name-only; } | sed -nE 's#^apps/([^/]+)/.*#\1#p; s#^(packages/[^/]+)/.*#\1#p' | sort -u | tr '\n' ' ')"
  fi
  [ "$REPO_KIND" = packages ] && [ -z "$VERIFY_ARGS" ] && { unstage; fail "$REPO 는 --verify \"<패키지명>\" 이 필요하다"; }
  RESULTS=""
  # 모노레포는 앱마다 한 번씩
  # shellcheck disable=SC2206
  if [ "$REPO_KIND" = monorepo ]; then TARGETS=($VERIFY_ARGS); else TARGETS=("$VERIFY_ARGS"); fi
  # 모노레포 루트 파일만 넘기면 앱을 못 찾아 대상이 빈다 — 검증 0회로 "통과"가 되지 않게 멈춘다(bash 3.2 는 빈 배열에서 죽기도 한다)
  [ ${#TARGETS[@]} -gt 0 ] || { unstage; fail "검증할 앱을 파일에서 찾지 못했다 — --verify \"<앱|packages/<pkg>>\" 를 준다"; }
  for target in "${TARGETS[@]}"; do
    echo "── 검증: scripts/verify/$REPO.sh $target (엄격 모드, 대상 $TOP)"
    # 같은 트리 내용·스크립트·인자로 이미 통과했으면 다시 돌리지 않는다(scripts/verify/reuse.sh — 계획서 기록에 "재사용(@시각)")
    REUSE_NOTE="$(mktemp -t hermes-commit-reuse)"
    # shellcheck disable=SC2086
    # ATHENA_PLAN — 검증 사건(verify)에 계획서를 남긴다(_lib.sh verify_event_fields · 지표의 검증 구간). pane 환경 값보다 --plan 이 먼저
    if ! ATHENA_VERIFY_STRICT=1 ATHENA_VERIFY_ALLOW_SKIP="$ALLOW_SKIP" ATHENA_VERIFY_DIR="$TOP" ATHENA_VERIFY_REUSE_NOTE="$REUSE_NOTE" ATHENA_PLAN="$PLAN" \
        "$ATHENA_DIR/scripts/verify/reuse.sh" "$REPO" $target; then
      rm -f "$REUSE_NOTE"
      unstage; fail "검증을 통과하지 못했다(${target:-전체}). 위 표를 보고 고친 뒤 다시 — 건너뛴 단계를 허용하려면 사용자 확인 후 --allow-skip"
    fi
    REUSED="$(cat "$REUSE_NOTE" 2>/dev/null)"; rm -f "$REUSE_NOTE"
    RESULTS="$RESULTS${target:-전체}${REUSED:+ $REUSED} "
  done
  VERIFY_NOTE="엄격 검증 통과 — $RESULTS${ALLOW_SKIP:+(건너뜀 허용: $ALLOW_SKIP)}"
fi
[ "$OUTSIDE" = 0 ] || VERIFY_NOTE="$VERIFY_NOTE (지정 밖 미커밋 변경 ${OUTSIDE}개가 있는 트리)"
[ $MERGING = 1 ] && VERIFY_NOTE="merge 커밋(${MERGE_SHA:0:7} 합침) · $VERIFY_NOTE"

# ── 4. 검증 전후가 같을 때만 커밋 ──────────────────────────────────────────
[ "$(git -C "$TOP" rev-parse HEAD)" = "$HEAD_BEFORE" ] || { unstage; fail "검증하는 동안 HEAD 가 바뀌었다"; }
[ "$(git -C "$TOP" write-tree)" = "$TREE_BEFORE" ] || { unstage; fail "검증하는 동안 스테이징이 바뀌었다"; }
[ $MERGING = 0 ] || [ "$(git -C "$TOP" rev-parse -q --verify MERGE_HEAD)" = "$MERGE_SHA" ] || fail "검증하는 동안 merge 상태가 바뀌었다(MERGE_HEAD)"
[ "$(tree_state)" = "$STATE_BEFORE" ] || { unstage; fail "검증하는 동안 작업 트리가 바뀌었다(추적 파일·지정 파일·원래 있던 미추적 파일) — 검증한 내용과 커밋할 내용이 다를 수 있다"; }
NEW_UNTRACKED="$(untracked_names | grep -vxF -f "$UNTRACKED_LIST" | wc -l | tr -d ' ')"
if [ "$NEW_UNTRACKED" != 0 ]; then
  echo "⚠️ 검증 중 새 미추적 파일 ${NEW_UNTRACKED}개가 생겼다(빌드 산출물 등, gitignore 안 됨) — 커밋에는 안 들어간다" >&2
  VERIFY_NOTE="$VERIFY_NOTE (검증 중 새 미추적 파일 ${NEW_UNTRACKED}개)"
fi
# merge 중이면 git commit 이 MERGE_HEAD 를 두 번째 부모로 붙인다
git -C "$TOP" commit -q -m "$MESSAGE" || { unstage; fail "git commit 실패"; }
COMMITTED=1
if [ $MERGING = 1 ] && [ "$(git -C "$TOP" rev-parse -q --verify HEAD^2)" != "$MERGE_SHA" ]; then
  echo "⚠️ merge 커밋이 아니다(두 번째 부모가 MERGE_HEAD 가 아님) — git -C $TOP log -1 로 확인한다" >&2
fi
SHA="$(git -C "$TOP" rev-parse --short HEAD)"

# ── 5. 계획서에 기록 ────────────────────────────────────────────────────
ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$(date '+%Y-%m-%d %H:%M')" "$REPO" "$BRANCH" "$SHA" "$MESSAGE" "$VERIFY_NOTE" "$TOP" "$ALLOW_MAIN" <<'PYEOF'
import os, sys, re
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, stamp, repo, branch, sha, message, note, top, allow_main = sys.argv[1:10]
main_note = {'1': ' · 메인 체크아웃(사용자 허용)', '2': ' · main 직접'}.get(allow_main, '')   # 2 = main 직접 레포(팩 direct)
line = f"- {stamp} · {repo} · 🌿 {branch} · `{sha}` — {message.splitlines()[0]} · {note}{main_note} · push 안 함"
def add_commit(text):
    # 끝 개행이 없으면 마지막 줄이 절 끝 매칭에서 빠진다 — 먼저 보정
    if not text.endswith('\n'):
        text += '\n'
    # 경량 템플릿은 "## Commits", 정식 템플릿은 Checkpoint 아래 "### Commits"
    head = re.search(r'^(#{2,3}) Commits\s*$', text, re.M)
    if head:
        level = len(head.group(1))
        # 같은 수준 이상의 다음 제목(또는 끝)까지가 이 절
        pattern = r'(^#{%d} Commits\s*\n(?:.*\n)*?)(?=^#{1,%d} |\Z)' % (level, level)
        updated = re.sub(pattern, lambda m: m.group(1).rstrip('\n') + '\n' + line + '\n\n', text, count=1, flags=re.M)
    else:
        updated = text.rstrip('\n') + '\n\n## Commits\n' + line + '\n'
    return updated if line in updated else None
# 잠금 안에서 지금 내용을 다시 읽어 더한다(다른 스크립트의 기록을 덮지 않게) · 정식 계획서면 html 의 md 사본도 맞춘다
if not update_plan(plan, add_commit):
    sys.exit(1)   # 기록이 안 됐다 — 아래에서 경고
PYEOF
[ $? = 0 ] || echo "⚠️ 커밋은 됐지만 계획서 기록에 실패했다 — 다시 커밋하지 말고 계획서 ## Commits 에 손으로 적는다: $SHA" >&2
# 측정용 사건 기록(docs/events.md) — 실패해도 커밋은 그대로
node "$ATHENA_DIR/scripts/lib/events.mjs" commit plan="$PLAN" repo="$REPO" branch="$BRANCH" sha="$SHA" verified="$([ "$NO_VERIFY" = 1 ] && echo false || echo true)" verify="$VERIFY_NOTE" >/dev/null 2>&1 || true

# 끝난 일의 Status — in_progress · planned 면 ready_for_review 로(이미 ready_for_review · done · blocked 는 그대로 · docs/workflow.md 4절). 실패해도 커밋은 그대로
OLD_STATUS="$(python3 "$ATHENA_DIR/scripts/lib/plan_autofill.py" status "$ATHENA_DIR" "$PLAN" 2>/dev/null || true)"
if [ -n "$OLD_STATUS" ]; then
  case "$PLAN" in plans/task/*) PLAN_GRADE=light ;; *) PLAN_GRADE=formal ;; esac
  node "$ATHENA_DIR/scripts/lib/events.mjs" plan.status plan="$PLAN" grade="$PLAN_GRADE" from="$OLD_STATUS" to=ready_for_review >/dev/null 2>&1 || true
fi

echo "✅ 커밋했다: $SHA ($REPO · $BRANCH) — $VERIFY_NOTE"
[ -z "$OLD_STATUS" ] || echo "   계획서 Status: $OLD_STATUS → ready_for_review"
echo "   push·PR 은 하지 않았다. \"PR 올려줘\" 면 이어서 scripts/ship.sh --plan $PLAN --dir $TOP 미리보기 → 제목 · 본문 정리 → --yes"
