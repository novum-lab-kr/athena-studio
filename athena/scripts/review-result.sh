#!/usr/bin/env bash
# reviewer 결론을 계획서에 한 줄 남긴다 — reviewer 가 리뷰를 끝낼 때 부른다(코드는 건드리지 않는다).
# ship.sh 는 이 줄의 tree(리뷰한 파일 내용)와 커밋된 내용(HEAD^{tree})이 같은지 본다 — 리뷰 → 커밋 순서여도 된다.
#
# 사용: scripts/review-result.sh --plan <plans/…md> --dir <리뷰한 워크트리> --verdict 승인|수정필요 [--note "<한 줄>"]
# 기록: "- Review result: 승인 @<HEAD 짧은 SHA> · tree <…> · 📦 <레포> · 🌿 <브랜치> · <날짜> · <메모>" 를 Checkpoint 의 "- Review:" 줄 아래에
#       (같은 레포·브랜치 줄이 있으면 바꾸고, 다른 줄은 남긴다 — 여러 레포 계획서는 브랜치 이름이 같을 수 있어 레포까지 본다)
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"   # 실제 경로 — 옛 폴더 이름(hermes 링크)으로 불려도 같은 값
PLAN=""; DIR=""; VERDICT=""; NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --verdict) VERDICT="${2:-}"; shift 2 ;;
    --note) NOTE="${2:-}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PLAN" ] && [ -n "$DIR" ] && [ -n "$VERDICT" ] || { echo "사용: $0 --plan <계획서> --dir <워크트리> --verdict 승인|수정필요 [--note …]" >&2; exit 2; }
case "$VERDICT" in 승인) ;; 수정필요|"수정 필요") VERDICT="수정 필요" ;; *) echo "verdict 는 승인 또는 수정필요" >&2; exit 2 ;; esac
case "$PLAN" in /*) [ -d "$(dirname "$PLAN")" ] && PLAN="$(cd "$(dirname "$PLAN")" && pwd -P)/$(basename "$PLAN")" ;; esac   # 옛 경로(~/…/hermes 링크)로 와도 실제 경로로 맞춘 뒤 자른다
PLAN="${PLAN#"$ATHENA_DIR"/}"
[ -f "$ATHENA_DIR/$PLAN" ] && case "$PLAN" in plans/*.md) true ;; *) false ;; esac || { echo "계획서가 없다: $PLAN" >&2; exit 1; }
SHA="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null)" || { echo "git 레포가 아니다: $DIR" >&2; exit 1; }
BRANCH="$(git -C "$DIR" symbolic-ref --short -q HEAD || echo detached)"
# 레포 이름 — 워크트리의 메인 체크아웃을 가리키는 repos/<이름> 링크(ship.sh 와 같은 방법). 못 찾으면 메인 체크아웃 폴더 이름
MAIN="$(git -C "$DIR" worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
MAIN="$(cd "$MAIN" 2>/dev/null && pwd -P)"
REPO="$(basename "${MAIN:-$DIR}")"
for link in "$ATHENA_DIR"/repos/*; do [ -n "$MAIN" ] && [ "$(cd "$link" 2>/dev/null && pwd -P)" = "$MAIN" ] && REPO="$(basename "$link")"; done
DIRTY="$(git -C "$DIR" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
# 리뷰한 파일 내용 — 커밋 안 된 변경·새 파일까지 포함한 워크트리 전체의 git tree. 임시 인덱스라 실제 스테이징은 건드리지 않는다
TMP_INDEX="$(mktemp -t hermes-review-index)"
cp "$(git -C "$DIR" rev-parse --path-format=absolute --git-path index)" "$TMP_INDEX" 2>/dev/null || true
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git -C "$DIR" add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$TMP_INDEX" git -C "$DIR" write-tree)"
rm -f "$TMP_INDEX"
[ -n "$TREE" ] || { echo "리뷰한 내용(tree)을 계산하지 못했다: $DIR" >&2; exit 1; }
ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$VERDICT" "$SHA" "$(date '+%Y-%m-%d %H:%M')" "$NOTE" "$DIRTY" "$BRANCH" "$TREE" "$REPO" <<'PYEOF'
import os, re, sys
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, verdict, sha, stamp, note, dirty, branch, tree, repo = sys.argv[1:10]
extra = f' · 커밋 전 변경 {dirty}개 포함' if dirty != '0' else ''
line = f"- Review result: {verdict} @{sha} · tree {tree[:12]} · 📦 {repo} · 🌿 {branch} · {stamp}{extra}{' · ' + note if note else ''}"
# 레포·브랜치마다 한 줄 — 여러 레포 계획서에서 서로 덮어쓰지 않게(레포가 달라도 브랜치 이름은 같을 수 있다). 레포 표시가 없는 옛 줄은 건드리지 않는다
same = re.compile(rf'^- Review result:.*📦 {re.escape(repo)} · 🌿 {re.escape(branch)} .*$', re.M)
def record(text):
    if same.search(text):
        return same.sub(lambda m: line, text, count=1)
    if re.search(r'^- Review result:.*$', text, re.M):
        last = list(re.finditer(r'^- Review result:.*$', text, re.M))[-1]
        return text[:last.end()] + '\n' + line + text[last.end():]
    anchor = re.search(r'^- (Review|Work ref):.*$', text, re.M)
    return text[:anchor.end()] + '\n' + line + text[anchor.end():] if anchor else text.rstrip('\n') + '\n' + line + '\n'
update_plan(plan, record)
print(line)
PYEOF

# 리뷰를 끝낸 reviewer pane 은 쉬기 시작한 뒤 1분 뒤 닫는다 — 결론은 위에서 계획서에 남았다. 화면 계층으로만 다룬다(밖이면 아무것도 안 한다)
if [ "${ATHENA_REVIEW_AUTOCLOSE:-1}" != 0 ] && "$ATHENA_DIR/scripts/screen" inside 2>/dev/null; then
  SELF="$("$ATHENA_DIR/scripts/screen" self --format sh 2>/dev/null | sed -n 's/^SCREEN_PANE_ID=//p' | tr -d "'\"")"
  LABEL="$("$ATHENA_DIR/scripts/screen" pane get "$SELF" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['pane'].get('label') or '')" 2>/dev/null)"
  case "$LABEL" in
    "🤖 reviewer"*)
      SECS="${ATHENA_REVIEW_AUTOCLOSE_SECS:-60}"
      # 결론을 적은 뒤에도 reviewer 는 보고를 쓰느라 한동안 일한다 — 한 번만 보면 그때 working 이라 놓친다(2026-10-17 pane 4개가 남았다).
      # 5초마다 보고, 쉬기 시작한 뒤 SECS 초 동안 계속 쉬면 닫는다. 다시 일하면(사용자가 말을 걸었다) 처음부터 센다. 30분이 지나도 안 쉬면 그만둔다
      nohup bash -c '
        idle_since=""; waited=0
        while [ "$waited" -lt 1800 ]; do
          status="$("$0/scripts/screen" pane get "$2" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)[\"pane\"].get(\"agent_status\") or \"\")" 2>/dev/null)"
          [ -n "$status" ] || exit 0   # pane 이 없어졌다
          now=$(date +%s)
          if [ "$status" = idle ]; then
            [ -n "$idle_since" ] || idle_since=$now
            [ $((now - idle_since)) -ge "$1" ] && { "$0/scripts/screen" pane close "$2" >/dev/null 2>&1; exit 0; }
          else
            idle_since=""
          fi
          sleep 5; waited=$((waited + 5))
        done
      ' "$ATHENA_DIR" "$SECS" "$SELF" >/dev/null 2>&1 &
      echo "🧹 리뷰가 끝났다 — 이 reviewer pane($SELF)은 쉬기 시작한 뒤 ${SECS}초 동안 계속 쉬면 닫는다" ;;
  esac
fi
