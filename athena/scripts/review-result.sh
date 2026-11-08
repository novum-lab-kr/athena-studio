#!/usr/bin/env bash
# reviewer 결론을 계획서에 한 줄 남긴다 — reviewer 가 리뷰를 끝낼 때 부른다(코드는 건드리지 않는다).
# ship.sh 는 이 줄의 tree(리뷰한 파일 내용)와 커밋된 내용(HEAD^{tree})이 같은지 본다 — 리뷰 → 커밋 순서여도 된다.
#
# 사용: scripts/review-result.sh --plan <plans/…md> --dir <리뷰한 워크트리> --verdict 승인|수정필요 [--note "<한 줄>"]
# 기록: "- Review result: 승인 @<HEAD 짧은 SHA> · tree <…> · 📦 <레포> · 🌿 <브랜치> · 🧠 <엔진> · <날짜> · <메모>" 를 Checkpoint 의 "- Review:" 줄 아래에
#       엔진(claude · codex)은 이 pane 기록(<팩 데이터>/state/pane-sessions/<pane>.json engine)에서, 없으면 ATHENA_ENGINE(delegate.sh 가 넣는다).
#       둘 다 없으면 적지 않는다 — pr-auto 는 엔진이 없는 승인을 이어받지 않는다(docs/pr-auto.md "앞 리뷰 승인 이어받기")
#       (같은 레포·브랜치 줄이 있으면 바꾸고, 다른 줄은 남긴다 — 여러 레포 계획서는 브랜치 이름이 같을 수 있어 레포까지 본다)
# 보안: scripts/review-result.sh --security --plan <…> --dir <…> --high <높음 수> --medium <중간 수> [--note "<한 줄>"] — security-reviewer 가 부른다
#       "- Security result: 높음 N · 중간 M @<SHA> · tree <…> · 📦 · 🌿 · …" 를 따로 남긴다(머리가 달라 Review result 판정과 섞이지 않는다)
#       높음이 1 이상이면 ship.sh · 자동 머지 · Actions 넘기기가 멈춘다(scripts/lib/pr-auto.mjs securityGate)
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"   # 실제 경로 — 옛 폴더 이름(hermes 링크)으로 불려도 같은 값
PLAN=""; DIR=""; VERDICT=""; NOTE=""; SECURITY=0; HIGH=""; MEDIUM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --verdict) VERDICT="${2:-}"; shift 2 ;;
    --note) NOTE="${2:-}"; shift 2 ;;
    --security) SECURITY=1; shift ;;
    --high) HIGH="${2:-}"; shift 2 ;;
    --medium) MEDIUM="${2:-}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
done
if [ "$SECURITY" = 1 ]; then
  [ -n "$PLAN" ] && [ -n "$DIR" ] && [ -n "$HIGH" ] && [ -n "$MEDIUM" ] || { echo "사용: $0 --security --plan <계획서> --dir <워크트리> --high <수> --medium <수> [--note …]" >&2; exit 2; }
  case "$HIGH$MEDIUM" in *[!0-9]*) echo "--high · --medium 은 0 이상의 수" >&2; exit 2 ;; esac
  HIGH=$((10#$HIGH)); MEDIUM=$((10#$MEDIUM))
  VERDICT="높음 $HIGH · 중간 $MEDIUM"
else
  [ -n "$PLAN" ] && [ -n "$DIR" ] && [ -n "$VERDICT" ] || { echo "사용: $0 --plan <계획서> --dir <워크트리> --verdict 승인|수정필요 [--note …]" >&2; exit 2; }
  case "$VERDICT" in 승인) ;; 수정필요|"수정 필요") VERDICT="수정 필요" ;; *) echo "verdict 는 승인 또는 수정필요" >&2; exit 2 ;; esac
fi
# 본체 기준 논리 경로로 — 여러 팩 구조에서 plans/ 는 팩 데이터를 가리키는 링크라 실제 경로로 풀면 본체 밖이 된다(scripts/lib/plan-path.sh)
. "$ATHENA_DIR/scripts/lib/plan-path.sh"
PLAN="$(plan_rel "$ATHENA_DIR" "$PLAN")"
[ -f "$ATHENA_DIR/$PLAN" ] && case "$PLAN" in plans/*.md) true ;; *) false ;; esac || { echo "계획서가 없다: $PLAN" >&2; exit 1; }
SHA="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null)" || { echo "git 레포가 아니다: $DIR" >&2; exit 1; }
BRANCH="$(git -C "$DIR" symbolic-ref --short -q HEAD || echo detached)"
# 레포 이름 — 워크트리의 메인 체크아웃을 가리키는 repos/<이름> 링크(ship.sh 와 같은 방법). 못 찾으면 메인 체크아웃 폴더 이름
MAIN="$(git -C "$DIR" worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
MAIN="$(cd "$MAIN" 2>/dev/null && pwd -P)"
REPO="$(basename "${MAIN:-$DIR}")"
for link in "$ATHENA_DIR"/repos/*; do [ -n "$MAIN" ] && [ "$(cd "$link" 2>/dev/null && pwd -P)" = "$MAIN" ] && REPO="$(basename "$link")"; done
# 리뷰한 엔진 — pane 기록이 먼저(scripts/hooks/pane-session.py 가 claude · codex 를 적는다 · 화면 계층 밖이면 건너뛴다)
SELF_PANE=""
"$ATHENA_DIR/scripts/screen" inside 2>/dev/null && SELF_PANE="$("$ATHENA_DIR/scripts/screen" self --format sh 2>/dev/null | sed -n 's/^SCREEN_PANE_ID=//p' | tr -d "'\"")"
ENGINE="$(python3 - "$ATHENA_DIR" "$SELF_PANE" "${ATHENA_ENGINE:-}" <<'PYEOF'
import json, pathlib, sys
root, pane, env_engine = sys.argv[1:4]
engine = ''
pack_data = pathlib.Path(root) / '.pack-data'
if pane and pack_data.is_symlink():
    try:
        engine = json.loads((pack_data.resolve() / 'state' / 'pane-sessions' / f'{pane}.json').read_text(encoding='utf-8')).get('engine') or ''
    except Exception:
        engine = ''
engine = engine or env_engine
print(engine if engine in ('claude', 'codex') else '')
PYEOF
)"
DIRTY="$(git -C "$DIR" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
# 리뷰한 파일 내용 — 커밋 안 된 변경·새 파일까지 포함한 워크트리 전체의 git tree. 임시 인덱스라 실제 스테이징은 건드리지 않는다
TMP_INDEX="$(mktemp -t hermes-review-index)"
cp "$(git -C "$DIR" rev-parse --path-format=absolute --git-path index)" "$TMP_INDEX" 2>/dev/null || true
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git -C "$DIR" add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$TMP_INDEX" git -C "$DIR" write-tree)"
rm -f "$TMP_INDEX"
[ -n "$TREE" ] || { echo "리뷰한 내용(tree)을 계산하지 못했다: $DIR" >&2; exit 1; }
ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$VERDICT" "$SHA" "$(date '+%Y-%m-%d %H:%M')" "$NOTE" "$DIRTY" "$BRANCH" "$TREE" "$REPO" "$ENGINE" "$SECURITY" <<'PYEOF'
import os, re, sys
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, verdict, sha, stamp, note, dirty, branch, tree, repo, engine, security = sys.argv[1:12]
head = 'Security result' if security == '1' else 'Review result'
extra = f' · 커밋 전 변경 {dirty}개 포함' if dirty != '0' else ''
who = f' · 🧠 {engine}' if engine else ''
line = f"- {head}: {verdict} @{sha} · tree {tree[:12]} · 📦 {repo} · 🌿 {branch}{who} · {stamp}{extra}{' · ' + note if note else ''}"
# 레포·브랜치마다 한 줄 — 여러 레포 계획서에서 서로 덮어쓰지 않게(레포가 달라도 브랜치 이름은 같을 수 있다). 레포 표시가 없는 옛 줄은 건드리지 않는다
same = re.compile(rf'^- {head}:.*📦 {re.escape(repo)} · 🌿 {re.escape(branch)} .*$', re.M)
def record(text):
    if same.search(text):
        return same.sub(lambda m: line, text, count=1)
    if re.search(rf'^- {head}:.*$', text, re.M):
        last = list(re.finditer(rf'^- {head}:.*$', text, re.M))[-1]
        return text[:last.end()] + '\n' + line + text[last.end():]
    # 보안 결과는 띄운 줄(Security review) 아래가 먼저 · 없으면 리뷰 줄 아래
    anchor = (re.search(r'^- (Security review|Review result):.*$', text, re.M) if security == '1' else None) or re.search(r'^- (Review|Work ref):.*$', text, re.M)
    return text[:anchor.end()] + '\n' + line + text[anchor.end():] if anchor else text.rstrip('\n') + '\n' + line + '\n'
update_plan(plan, record)
print(line)
PYEOF
# 측정용 사건 기록(docs/events.md) — 실패해도 리뷰 기록은 그대로
[ "$SECURITY" = 1 ] || node "$ATHENA_DIR/scripts/lib/events.mjs" review plan="$PLAN" verdict="$VERDICT" repo="$REPO" branch="$BRANCH" sha="$SHA" dirty="$DIRTY" >/dev/null 2>&1 || true

# 리뷰를 끝낸 reviewer pane 은 쉬기 시작한 뒤 1분 뒤 닫는다 — 결론은 위에서 계획서에 남았다. 화면 계층으로만 다룬다(밖이면 아무것도 안 한다)
if [ "${ATHENA_REVIEW_AUTOCLOSE:-1}" != 0 ] && "$ATHENA_DIR/scripts/screen" inside 2>/dev/null; then
  SELF="$SELF_PANE"
  LABEL="$("$ATHENA_DIR/scripts/screen" pane get "$SELF" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['pane'].get('label') or '')" 2>/dev/null)"
  case "$LABEL" in
    "🤖 reviewer"*|"🤖 security-reviewer"*)
      SECS="${ATHENA_REVIEW_AUTOCLOSE_SECS:-60}"
      # 결론을 적은 뒤에도 reviewer 는 보고를 쓰느라 한동안 일한다 — 한 번만 보면 그때 working 이라 놓친다(2026-10-17 pane 4개가 남았다).
      # 5초마다 보고, 쉬기 시작한 뒤 SECS 초 동안 계속 쉬면 닫는다. 다시 일하면(사용자가 말을 걸었다) 처음부터 센다. 30분이 지나도 안 쉬면 그만둔다
      # Codex 는 명령이 끝나면 같은 실행 그룹의 자식을 정리한다. nohup 만으로는
      # 감시가 남지 않으므로 기존 훅 지킴이처럼 새 세션으로 분리하고 입출력을 끊는다.
      python3 - "$ATHENA_DIR" "$SECS" "$SELF" <<'PYWATCH'
import pathlib, subprocess, sys
root, seconds, pane = sys.argv[1:]
subprocess.Popen(['bash', str(pathlib.Path(root) / 'scripts/lib/reviewer-autoclose.sh'), root, seconds, pane],
                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                 start_new_session=True, close_fds=True)
PYWATCH
      echo "🧹 리뷰가 끝났다 — 이 reviewer pane($SELF)은 쉬기 시작한 뒤 ${SECS}초 동안 계속 쉬면 닫는다" ;;
  esac
fi
