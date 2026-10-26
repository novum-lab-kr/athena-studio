#!/usr/bin/env bash
# 에이전트 push·PR — 사용자가 pane 에서 "PR 올려줘" 라고 했을 때만, 이 스크립트로만 한다.
# "PR 올려줘" 한 마디로 끝까지 간다(2026-10-25) — 에이전트가 커밋 안 된 작업을 commit.sh 로 커밋 → 미리보기 → 제목 · 본문 정리 → 묻지 않고 --yes(base 는 prBase).
# main 직접 레포의 push 만 지금처럼 사용자에게 확인받는다.
# 레포 하나짜리 작업만 받는다(여러 레포에 걸친 작업은 아테나가 순서를 정해 올린다).
# main 직접 레포(팩 direct: true)는 PR 대신 메인 체크아웃의 작업 브랜치를 origin 에 빨리 감기로 push 한다 — 미리보기 → --yes 는 같다(제목·base·본문 없음)
#
# 사용 (두 번 부른다):
#   1) 미리보기 — 아무것도 보내지 않는다
#      scripts/ship.sh --plan <plans/…md> --dir <워크트리>
#      → 브랜치 · base 후보 · 올라갈 커밋 · 검증·리뷰 기록 · 제목 제안 · 본문 초안 파일 경로를 출력
#   2) 에이전트가 작업 내용으로 제목 · 본문 초안을 정리한 뒤(묻지 않는다 · base 는 prBase — main 직접 레포만 사용자 확인 뒤)
#      scripts/ship.sh --plan <plans/…md> --dir <워크트리> --base <브랜치> [--base <브랜치2>] \
#        --title "<type(범위): 티켓 요약>" [--body-file <본문.md>] [--no-review-ok] --yes
#
# 옵션:
#   --base <브랜치>      PR 대상. 여러 번 주면 PR 을 각각 연다(레포 설정 extraPrBases — 예: 앱의 prd·dev 양쪽 관례)
#   --title "<제목>"     형식: type(범위): [티켓 ]요약 — 규칙은 docs/knowledge/common/git.md "PR 제목·본문"
#   --body-file <파일>   본문. 없으면 미리보기가 만든 초안을 쓴다. 필수 절(작업 내용·변경 사항·검증·확인 필요)이 있어야 한다
#   --no-review-ok       리뷰 승인이 없거나 지금 커밋된 내용과 달라도 올린다(리뷰는 선택이다). PR 은 묻지 않고 붙이고
#                        본문 "확인 필요" · 보고에 "리뷰 승인 전" 을 적는다. main 직접 레포의 push 는 사용자가 확인했을 때만
#   --repo-agent <이름>  (아테나 전용) 여러 에이전트가 붙은 계획서에서 이 에이전트의 레포 몫만 올린다.
#                        FE 세션에서는 보호 훅이 이 옵션을 막는다 — 순서 조율은 아테나가 한다
#   --yes                실제로 보낸다. 없으면 미리보기만
#   --auto-push          (PR 자동 리뷰 흐름 전용 — docs/pr-auto.md) 자동 리뷰가 수정 · 결정을 보낸 PR 의 브랜치에 고친 커밋만 빨리 감기로 push 한다.
#                        사용자 "PR 올려줘" 없이 되는 유일한 push — 미리보기 · 제목 · base · 새 PR 없음. 조건: 레포 "autoMerge": true ·
#                        이 브랜치의 열린 PR 이 계획서 PR 줄에 있다 · 그 PR 의 "- Auto review:" 줄이 수정 필요 · 결정 필요 · 충돌로 검증 대기(CONFLICTING) ·
#                        HEAD 가 commit.sh 로 기록된 커밋(충돌이면 base 를 합친 merge 커밋)
#                        --body-file <파일> 을 같이 주면 그 PR 본문도 바꾼다(gh pr edit --body-file · 제목 · base 는 그대로 · 본문 검사는 새 PR 과 같다) —
#                        자동 리뷰가 본문을 지적했을 때. 올릴 커밋이 없어도 되고(본문만), 그러면 같은 HEAD 를 자동 리뷰가 다시 본다(라운드 하나 · "본문 고침")
#
# 확인하는 것 (하나라도 걸리면 아무것도 보내지 않는다)
#   - <워크트리> 가 등록된 워크트리이고 메인 체크아웃이 아니다 · 브랜치에 붙어 있다 · 보호 브랜치가 아니다
#   - 추적 파일의 미커밋 변경이 없다 (미추적 파일은 경고만)
#   - 계획서가 레포 하나짜리 작업이다 (Agent 줄·작업 배분표의 에이전트가 하나 — 아테나는 --repo-agent 로 그중 하나)
#   - HEAD 가 계획서 Commits 에 commit.sh 로 기록된 커밋이다 (검증 기록이 있는 커밋만 나간다)
#   - base 가 원격에 있고, base 에 없는 커밋이 하나 이상 있다
#   - 제목 형식 · 본문 필수 절 · 본문에 로컬 경로(plans/… · /Users/… · .worktrees/)·내부 주소·비밀값 흔적이 없다
#   - 본문은 미리보기가 만든 초안(또는 --body-file) 그대로 — --yes 때 초안을 다시 만들지 않는다(에이전트가 정리한 그대로 나간다)
# 그다음: git push -u origin <브랜치> → base 마다 draft PR (이미 열린 PR 이 있으면 push 만 하고 링크를 알린다)
#         → 계획서 Commits 의 해당 줄 "push 안 함" 을 PR 링크로 바꾸고 Checkpoint 에 "- PR:" 줄을 남긴다
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"   # 실제 경로 — 옛 폴더 이름(hermes 링크)으로 불려도 같은 값
git() { command git -c core.quotePath=false "$@"; }

PLAN=""; DIR=""; TITLE=""; BODY_FILE=""; REVIEW_OK=0; YES=0; BASES=(); REPO_AGENT=""; AUTO_PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --base) BASES+=("${2:-}"); shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --body-file) BODY_FILE="${2:-}"; shift 2 ;;
    --no-review-ok) REVIEW_OK=1; shift ;;
    --yes) YES=1; shift ;;
    --auto-push) AUTO_PUSH=1; shift ;;
    --repo-agent) REPO_AGENT="${2:-}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "모르는 옵션: $1" >&2; exit 2 ;;
  esac
done
fail() { echo "❌ 보내지 않았다: $*" >&2; exit 1; }
# PR 본문 검사 — 새 PR(--yes) · 자동 흐름 본문 고침(--auto-push --body-file)이 같이 쓴다
check_body() {
  local body="$1" heading
  for heading in '## 작업 내용' '## 변경 사항' '## 검증' '## 확인 필요'; do
    grep -qxF "$heading" "$body" || fail "본문에 \"$heading\" 절이 없다(docs/knowledge/common/git.md \"PR 제목·본문\")"
  done
  grep -qE '(^|[^[:alnum:]])plans/|/Users/|/private/|\.worktrees/|(HERMES|ATHENA)_[A-Z_]+=' "$body" && fail "본문에 로컬 경로(plans/… · /Users/… · .worktrees/ · ATHENA_*=·HERMES_*=)가 있다 — 빼고 다시"
  grep -qiE 'https?://(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)|https?://[^/[:space:]]*\.(internal|local)([:/[:space:]]|$)' "$body" && fail "본문에 내부 주소로 보이는 URL 이 있다 — 확인하고 빼기"
  grep -qiE '(api[_-]?key|secret|token|password)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY' "$body" && fail "본문에 비밀값으로 보이는 줄이 있다 — 확인하고 빼기"
  return 0
}

[ -n "$PLAN" ] && [ -n "$DIR" ] || { echo "사용: $0 --plan <plans/…md> --dir <워크트리> [--base … --title … --yes]" >&2; exit 2; }
# 본체 기준 논리 경로로 — 여러 팩 구조에서 plans/ 는 팩 데이터를 가리키는 링크라 실제 경로로 풀면 본체 밖이 된다(scripts/lib/plan-path.sh)
. "$ATHENA_DIR/scripts/lib/plan-path.sh"
PLAN="$(plan_rel "$ATHENA_DIR" "$PLAN")"
[ -f "$ATHENA_DIR/$PLAN" ] && case "$PLAN" in plans/*.md) true ;; *) false ;; esac || fail "계획서가 없다: $PLAN"
command -v gh >/dev/null 2>&1 || fail "gh CLI 가 없다"

# ── 1. 워크트리·브랜치 (commit.sh 와 같은 규칙) ─────────────────────────────
TOP="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)" || fail "git 레포가 아니다: $DIR"
TOP="$(cd "$TOP" && pwd -P)"
MAIN="$(git -C "$TOP" worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
MAIN="$(cd "$MAIN" && pwd -P)"
REPO="$(basename "$MAIN")"
for link in "$ATHENA_DIR"/repos/*; do [ "$(cd "$link" 2>/dev/null && pwd -P)" = "$MAIN" ] && REPO="$(basename "$link")"; done
# main 직접 레포(팩 direct: true)는 PR 없이 메인 체크아웃의 작업 브랜치를 origin 에 빨리 감기로 push 한다(아래 "main 직접" · docs/pack.md)
DIRECT="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import load, is_direct, direct_branch; c=load(sys.argv[1]); print(direct_branch(c, sys.argv[2]) if is_direct(c, sys.argv[2]) else "")' "$ATHENA_DIR" "$REPO")" || fail "설정을 읽지 못했다(main 직접 확인)"
# PR 자동 리뷰를 켠 레포인가(팩 "autoMerge": true · main 직접 레포는 대상 아님 — docs/pr-auto.md)
AUTO_ON=0
if [ -z "$DIRECT" ]; then
  AUTO_ON="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import load, repo_entry; print(1 if repo_entry(load(sys.argv[1]), sys.argv[2]).get("autoMerge") is True else 0)' "$ATHENA_DIR" "$REPO")" || fail "설정을 읽지 못했다(autoMerge 확인)"
fi
# push 한 PR 을 자동 리뷰 대기열에 바로 넣는다 — 새 PR · 열린 PR 에 push · --auto-push 모두. 현황판의 PR 감지(5분 캐시)는 놓친 것을 잡는 안전망으로 남는다.
# 대상은 현황판과 같다 — 켠 레포 · 레포 하나짜리(아테나의 --repo-agent 는 아님) · 계획서 Status 가 in_progress · ready_for_review.
# 같은 HEAD 는 한 번만 — pr-auto.mjs --enqueue 가 대기 · 처리 중인 같은 일을 막고, 끝난 HEAD 는 처리기가 계획서 "- Auto review:" 줄로 건너뛴다
auto_review_now() {   # <PR 번호>
  [ "$AUTO_ON" = 1 ] && [ -z "$REPO_AGENT" ] || return 0
  grep -qE '^- Status:[[:space:]]*(in_progress|ready_for_review)([^[:alnum:]_]|$)' "$ATHENA_DIR/$PLAN" || return 0
  (cd "$ATHENA_DIR" && node scripts/pr-auto.mjs --enqueue --plan "$PLAN" --pr "$REPO#$1" --head "$HEAD_FULL") \
    || echo "⚠️ PR #$1 을 자동 리뷰 대기열에 바로 넣지 못했다 — 현황판이 5분 안에 잡는다" >&2
}
[ "$TOP" != "$MAIN" ] || [ -n "$DIRECT" ] || fail "메인 체크아웃(repos/$REPO)이다. 워크트리에서 작업한 브랜치만 올린다"
BRANCH="$(git -C "$TOP" symbolic-ref --short -q HEAD)" || fail "detached HEAD 다"
# 보호 브랜치 — 흔한 운영·개발 이름 + 팩에 적힌 이 레포의 branch·prBase·extraPrBases(scripts/lib/athena_config.py)
PROTECTED="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts/lib"); from athena_config import load, is_protected; print(1 if is_protected(load(sys.argv[1]), sys.argv[2], sys.argv[3]) else 0)' "$ATHENA_DIR" "$REPO" "$BRANCH")" || fail "설정을 읽지 못했다(보호 브랜치 확인)"
[ "$PROTECTED" = 0 ] || fail "보호 브랜치($BRANCH)는 올리지 않는다"
[ -z "$(git -C "$TOP" status --porcelain --untracked-files=no)" ] || fail "커밋하지 않은 변경이 있다 — 먼저 scripts/commit.sh 로 커밋한다(\"PR 올려줘\" 면 내 작업 파일은 묻지 않고 · 내가 만들지 않은 변경이면 사용자에게 확인)"
UNTRACKED="$(git -C "$TOP" ls-files --others --exclude-standard | wc -l | tr -d ' ')"
HEAD_SHA="$(git -C "$TOP" rev-parse --short HEAD)"

# ── 2. 계획서 — 레포 하나짜리인지, HEAD 가 기록된 커밋인지, 리뷰 기록 ────────────
HEAD_FULL="$(git -C "$TOP" rev-parse HEAD)"
HEAD_TREE="$(git -C "$TOP" rev-parse 'HEAD^{tree}')"
PLAN_INFO="$(python3 - "$ATHENA_DIR/$PLAN" "$ATHENA_DIR" "$HEAD_FULL" "$BRANCH" "$HEAD_TREE" "$REPO" <<'PYEOF'
import json, re, sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'); head, branch, head_tree, repo = sys.argv[3:7]
sys.path.insert(0, sys.argv[2] + '/scripts/lib'); from athena_config import load; cfg = load(sys.argv[2])
agents = set()
for entry in cfg['repos']:   # repo(레포 이름 인자)를 덮어쓰지 않게 — 덮이면 아래 "📦 <레포>" 리뷰 줄을 못 찾는다
    agents.update(entry.get('agents') or [])
    if entry.get('packagesAgent'): agents.add(entry['packagesAgent'])
    agents.update(app['agent'] for app in (entry.get('apps') or {}).values())
found = set()
line = re.search(r'^- Agent:\s*(.+)$', text, re.M)
if line: found.update(name for name in agents if re.search(rf'(?<![\w-]){re.escape(name)}(?![\w-])', line.group(1)))
# 정식 계획서의 작업 배분표 — "| 담당 |" 표의 첫 칸
section = re.search(r'^## \d*\.?\s*작업 배분\s*\n(.*?)(?=^## |\Z)', text, re.M | re.S)
if section:
    for row in re.findall(r'^\|\s*([^|]+?)\s*\|', section.group(1), re.M):
        found.update(name for name in agents if re.search(rf'(?<![\w-]){re.escape(name)}(?![\w-])', row))
commits = re.search(r'^#{2,3} Commits\s*\n(.*?)(?=^#{1,3} |\Z)', text, re.M | re.S)
recorded = ''
if commits:
    for entry in commits.group(1).splitlines():
        sha = re.search(r'`([0-9a-f]{6,40})`', entry)
        if sha and head.startswith(sha.group(1)) and branch in entry:
            recorded = entry.strip()
# reviewer 가 끝에 남기는 결론 줄 — "- Review result: 승인 @<sha> · tree <리뷰한 내용> …". 마지막 줄을 본다
# 승인은 **리뷰한 파일 내용(tree)** 에 묶는다 — 리뷰 → 커밋 순서여도 커밋된 내용(HEAD^{tree})이 같으면 승인이다.
# tree 가 없는 옛 줄은 커밋 SHA 로 본다
# 여러 레포 계획서는 레포·브랜치마다 한 줄 — 이 레포·브랜치 줄만 본다(다른 레포의 같은 이름 브랜치 승인을 쓰지 않는다).
# 레포 표시가 없는 옛 줄은 이 브랜치 줄, 그것도 없으면 브랜치 표시도 없는 옛 줄
lines = re.findall(r'^- Review result:.*$', text, re.M)
mine = ([row for row in lines if f'📦 {repo} · 🌿 {branch} ' in row + ' ']
        or [row for row in lines if '📦' not in row and f'🌿 {branch} ' in row + ' ']
        or [row for row in lines if '📦' not in row and '🌿' not in row])
results = []
for row in mine:
    hit = re.match(r'^- Review result:\s*(.+?)\s*@\s*([0-9a-f]{6,40})', row)
    if hit:
        tree = re.search(r'· tree ([0-9a-f]{6,40})', row)
        results.append((hit.group(1), hit.group(2), tree.group(1) if tree else ''))
if not results:
    review = 'none' if not re.search(r'^- Review:', text, re.M) else 'pending'
else:
    verdict, sha, tree = results[-1]
    same = head_tree.startswith(tree) if tree else head.startswith(sha)
    if not verdict.startswith('승인'):
        review = 'changes'
    elif same:
        review = 'ok'
    else:
        review = 'stale'

title = (re.search(r'^# (.+)$', text, re.M) or [None, ''])[1].strip()
print(len(found)); print(','.join(sorted(found))); print(recorded); print(review); print(title)
PYEOF
)" || fail "계획서를 읽지 못했다"
AGENT_COUNT="$(sed -n 1p <<<"$PLAN_INFO")"; AGENT_NAMES="$(sed -n 2p <<<"$PLAN_INFO")"
RECORDED="$(sed -n 3p <<<"$PLAN_INFO")"; REVIEWED="$(sed -n 4p <<<"$PLAN_INFO")"; PLAN_TITLE="$(sed -n 5p <<<"$PLAN_INFO")"
if [ -n "$REPO_AGENT" ]; then
  grep -qxF "$REPO_AGENT" <<<"${AGENT_NAMES//,/$'\n'}" || fail "--repo-agent $REPO_AGENT 가 계획서의 에이전트($AGENT_NAMES)에 없다"
  AGENT_REPO="$(python3 -c "import sys; sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load; c=load(sys.argv[1]); a=sys.argv[2]; print(next((r['name'] for r in c['repos'] if a in (r.get('agents') or []) or r.get('packagesAgent')==a or any(x.get('agent')==a for x in (r.get('apps') or {}).values())), ''))" "$ATHENA_DIR" "$REPO_AGENT")"
  [ "$AGENT_REPO" = "$REPO" ] || fail "--repo-agent $REPO_AGENT 의 레포(${AGENT_REPO:-?})와 --dir 의 레포($REPO)가 다르다"
elif [ "${AGENT_COUNT:-0}" -gt 1 ]; then
  fail "여러 에이전트가 붙은 작업이다($AGENT_NAMES) — 순서 조율이 필요해 아테나가 올린다. 사용자에게 \"아테나에게 PR 을 요청해 달라\" 고 알린다"
fi
[ -n "$RECORDED" ] || fail "HEAD($HEAD_SHA)가 계획서 Commits 에 없다 — scripts/commit.sh 로 커밋한 것만 올린다(검증 기록이 있어야 한다)"
case "$RECORDED" in *"검증 생략"*) VERIFY_WARN="⚠️ 이 커밋은 검증 없이 커밋됐다(사용자 지시)";; *) VERIFY_WARN="";; esac
# 승인이 아닐 때 할 일 — PR 은 "PR 올려줘" 한 마디로 묻지 않고 올리고(본문 · 보고에 적는다), main 직접 레포의 push 만 사용자에게 묻는다(git.md "PR 올리기")
if [ -n "$DIRECT" ]; then REVIEW_ACT="이대로 올릴지 사용자에게 확인(올리면 --no-review-ok)"
else REVIEW_ACT="묻지 않고 --no-review-ok 로 올리고 PR 본문 \"확인 필요\" · 보고에 \"리뷰 승인 전\" 을 적는다"; fi
case "$REVIEWED" in
  ok) REVIEW_NOTE="reviewer 승인 — 리뷰한 내용과 커밋된 내용이 같다" ;;
  stale) REVIEW_NOTE="⚠️ reviewer 가 승인한 뒤 내용이 바뀌었다(리뷰 뒤 수정·다른 파일 커밋) — $REVIEW_ACT" ;;
  changes) REVIEW_NOTE="⚠️ reviewer 결론이 승인이 아니다(수정 필요) — $REVIEW_ACT" ;;
  pending) REVIEW_NOTE="⚠️ reviewer 를 띄웠지만 결론 기록(- Review result:)이 없다 — $REVIEW_ACT" ;;
  *) REVIEW_NOTE="⚠️ reviewer 기록 없음 — $REVIEW_ACT" ;;
esac

# ── main 직접 — PR 없이 origin/<작업 브랜치> 에 빨리 감기로 push 한다(팩 direct: true) ─────────────
if [ -n "$DIRECT" ]; then
  [ "$BRANCH" = "$DIRECT" ] || fail "main 직접 레포는 $DIRECT 에서만 올린다(지금 $BRANCH)"
  git -C "$TOP" fetch --quiet origin 2>/dev/null || echo "⚠️ fetch 실패 — 로컬의 origin 참조로 본다" >&2
  git -C "$TOP" merge-base --is-ancestor "origin/$DIRECT" HEAD 2>/dev/null || fail "origin/$DIRECT 에 여기 없는 커밋이 있다 — 먼저 받아서(git pull --ff-only 또는 rebase) 다시 커밋·검증한다"
  OUTGOING="$(git -C "$TOP" log --oneline "origin/$DIRECT"..HEAD)"
  [ -n "$OUTGOING" ] || fail "origin/$DIRECT 에 없는 커밋이 없다 — 올릴 게 없다"
  if [ $YES = 0 ]; then
    echo "── main 직접 push 미리보기 (아직 아무것도 보내지 않았다)"
    echo "레포     $REPO · 🌿 $DIRECT · HEAD $HEAD_SHA — PR 없이 origin/$DIRECT 에 빨리 감기로 push"
    echo "올라갈 커밋 (origin/$DIRECT..HEAD):"; sed 's/^/  /' <<<"$OUTGOING"
    echo "검증     ${RECORDED:-?}"; [ -n "$VERIFY_WARN" ] && echo "         $VERIFY_WARN"
    echo "리뷰     $REVIEW_NOTE"
    [ "$UNTRACKED" = 0 ] || echo "미추적   ⚠️ 커밋 안 된 새 파일 ${UNTRACKED}개 — 올라가지 않는다"
    echo "──"
    echo "사용자에게 확인받은 뒤 --yes 로 다시 실행한다(제목·base·본문은 쓰지 않는다)"
    exit 0
  fi
  [ "$REVIEWED" = ok ] || [ $REVIEW_OK = 1 ] || fail "${REVIEW_NOTE#⚠️ }"
  LOCK="$(git -C "$TOP" rev-parse --git-dir)/hermes-commit.lock"
  mkdir "$LOCK" 2>/dev/null || fail "커밋이 진행 중이다($LOCK) — 끝난 뒤 미리보기부터 다시"
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  [ "$(git -C "$TOP" rev-parse HEAD)" = "$HEAD_FULL" ] || fail "확인하는 동안 HEAD 가 바뀌었다 — 미리보기부터 다시"
  [ -z "$(git -C "$TOP" status --porcelain --untracked-files=no)" ] || fail "확인하는 동안 커밋하지 않은 변경이 생겼다 — 미리보기부터 다시"
  PUSHED="$(git -C "$TOP" log --pretty=%H "origin/$DIRECT".."$HEAD_FULL" | tr '\n' ' ')"
  # 빨리 감기만 — 원격이 그사이 움직였으면 git 이 거절한다(강제 push 하지 않는다)
  git -C "$TOP" push origin "$HEAD_FULL:refs/heads/$DIRECT" || fail "push 실패 — 원격이 그사이 움직였으면 받아서(pull --ff-only) 다시"
  ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$DIRECT" "$PUSHED" <<'PYEOF'
import os, sys, re
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, branch, pushed = sys.argv[1:4]
shas = set(pushed.split())
def mark(match):
    entry = match.group(0)
    hit = re.search(r'`([0-9a-f]{6,})`', entry)
    return entry.replace('push 안 함', f'push → {branch}(main 직접)') if hit and any(full.startswith(hit.group(1)) for full in shas) else entry
update_plan(plan, lambda text: re.sub(r'^- .*push 안 함.*$', mark, text, flags=re.M))
PYEOF
  [ $? = 0 ] || echo "⚠️ push 는 됐지만 계획서 기록에 실패했다 — Commits 줄의 'push 안 함' 을 손으로 고친다" >&2
  echo "✅ push: $REPO · $HEAD_SHA → origin/$DIRECT (main 직접 · PR 없음)"
  exit 0
fi

# ── PR 자동 리뷰 흐름 — 고친 커밋을 그 PR 브랜치에 빨리 감기로만 push 한다(scripts/pr-auto.mjs 가 보낸 지시에서만 · docs/pr-auto.md) ──────────
if [ $AUTO_PUSH = 1 ]; then
  # 여기 오기 전에 평소 검사를 모두 지났다 — 워크트리 · 보호 브랜치 · 추적 파일 미커밋 · 레포 하나짜리 · HEAD 가 계획서 Commits 에 commit.sh 로 기록된 커밋(위 [ -n "$RECORDED" ])
  [ -z "$DIRECT" ] || fail "main 직접 레포는 자동 흐름 대상이 아니다"
  [ "$AUTO_ON" = 1 ] || fail "$REPO 는 자동 머지를 켜지 않았다(pack.json 레포 \"autoMerge\": true) — 사용자가 \"PR 올려줘\" 라고 할 때 미리보기부터"
  PR_NUMBER="$(cd "$TOP" && gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null)"
  [ -n "$PR_NUMBER" ] || fail "$BRANCH 의 열린 PR 이 없다 — 자동 흐름은 이미 열린 PR 에만 push 한다"
  AUTO_STATE="$(python3 - "$ATHENA_DIR/$PLAN" "$REPO" "$PR_NUMBER" <<'PYEOF'
import re, sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'); repo, number = sys.argv[2:4]
pr_line = re.search(rf'^- PR:\s*\S*/{re.escape(repo)}/pull/{number}\b', text, re.M)
auto = re.search(rf'^- Auto review:\s*{re.escape(repo)}#{number}\s+@[0-9a-f]+\s+·\s+(.+?)\s+·', text, re.M)
# 수정 · 결정 요청, 또는 base 와 충돌해 머지 못 한 "검증 대기"(pr-auto.mjs prepareMerge · 머지 직전 확인) — 충돌은 base 를 합친 merge 커밋으로 푼다
wants = auto and (re.match(r'(수정 필요|결정 필요)', auto.group(1)) or re.match(r'검증 대기 — .*충돌.*CONFLICTING', auto.group(1)))
print('no-pr' if not pr_line else ('ok' if wants else 'no-request'))
PYEOF
)"
  case "$AUTO_STATE" in
    ok) ;;
    no-pr) fail "PR #$PR_NUMBER 이 계획서 PR 줄에 없다 — 이 계획서의 PR 이 아니다" ;;
    *) fail "PR #$PR_NUMBER 에 자동 리뷰의 수정 · 결정 요청(또는 충돌로 검증 대기)이 없다(계획서 \"- Auto review:\" 줄) — 자동 흐름 밖의 push 는 사용자가 \"PR 올려줘\" 할 때" ;;
  esac
  if [ -n "$BODY_FILE" ]; then [ -f "$BODY_FILE" ] || fail "본문 파일이 없다: $BODY_FILE"; check_body "$BODY_FILE"; fi
  git -C "$TOP" fetch --quiet origin "$BRANCH" 2>/dev/null || fail "fetch 실패 — origin/$BRANCH 를 확인하지 못했다"
  git -C "$TOP" merge-base --is-ancestor "origin/$BRANCH" HEAD 2>/dev/null || fail "origin/$BRANCH 에 여기 없는 커밋이 있다 — 빨리 감기가 아니라 올리지 않는다(강제 push 하지 않는다)"
  # 올릴 커밋이 없으면 본문만 고칠 때(--body-file)만 계속한다
  BODY_ONLY=0
  if [ -z "$(git -C "$TOP" rev-list "origin/$BRANCH"..HEAD)" ]; then
    [ -n "$BODY_FILE" ] || fail "origin/$BRANCH 에 없는 커밋이 없다 — 올릴 게 없다(본문만 고치려면 --body-file)"
    BODY_ONLY=1
  fi
  LOCK="$(git -C "$TOP" rev-parse --git-dir)/hermes-commit.lock"
  mkdir "$LOCK" 2>/dev/null || fail "커밋이 진행 중이다($LOCK) — 끝난 뒤 다시"
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  [ "$(git -C "$TOP" rev-parse HEAD)" = "$HEAD_FULL" ] || fail "확인하는 동안 HEAD 가 바뀌었다 — 다시"
  [ -z "$(git -C "$TOP" status --porcelain --untracked-files=no)" ] || fail "확인하는 동안 커밋하지 않은 변경이 생겼다 — 다시"
  PUSHED="$(git -C "$TOP" log --pretty=%H "origin/$BRANCH".."$HEAD_FULL" | tr '\n' ' ')"
  # 본문 먼저 — 새 커밋을 올리면 자동 리뷰가 그 커밋을 볼 때 고친 본문을 같이 본다
  if [ -n "$BODY_FILE" ]; then
    (cd "$TOP" && gh pr edit "$PR_NUMBER" --body-file "$BODY_FILE" >/dev/null) || fail "PR #$PR_NUMBER 본문을 바꾸지 못했다(gh pr edit)"
    echo "✅ PR #$PR_NUMBER 본문을 바꿨다"
  fi
  if [ $BODY_ONLY = 1 ]; then
    # 커밋 없이 본문만 — 같은 HEAD 라 현황판이 다시 감지하지 않는다. 계획서 줄을 "본문 고침" 으로 바꾸고 대기열에 직접 넣는다(라운드 하나)
    node --input-type=module -e '
      const [lib, update, plan, repo, number, stamp] = process.argv.slice(1)
      const { autoLines, withAutoLine, BODY_EDITED } = await import(lib)
      const { updatePlan } = await import(update)
      updatePlan(plan, (text) => { const known = autoLines(text).get(`${repo}#${number}`); return known ? withAutoLine(text, { ...known, result: `${BODY_EDITED} — 다시 리뷰 대기`, stamp }) : text })
    ' "$ATHENA_DIR/scripts/lib/pr-auto.mjs" "$ATHENA_DIR/scripts/lib/plan-update.mjs" "$ATHENA_DIR/$PLAN" "$REPO" "$PR_NUMBER" "$(date '+%Y-%m-%d %H:%M')" \
      || echo "⚠️ 본문은 바꿨지만 계획서 \"- Auto review:\" 줄을 바꾸지 못했다 — 자동 리뷰가 같은 HEAD 를 다시 보지 않는다. 사용자에게 알린다" >&2
    (cd "$ATHENA_DIR" && node scripts/pr-auto.mjs --enqueue --plan "$PLAN" --pr "$REPO#$PR_NUMBER" --head "$HEAD_FULL") \
      || echo "⚠️ 자동 리뷰 대기열에 넣지 못했다 — 현황판이 다시 켜지면 계획서 줄로 잡는다" >&2
    node "$ATHENA_DIR/scripts/lib/events.mjs" auto.push plan="$PLAN" repo="$REPO" branch="$BRANCH" sha="$HEAD_SHA" pr="$PR_NUMBER" body=1 >/dev/null 2>&1 || true
    echo "✅ 자동 수정(본문만): $REPO PR #$PR_NUMBER @$HEAD_SHA — 자동 리뷰가 같은 HEAD 를 다시 본다"
    exit 0
  fi
  # 빨리 감기만 — 원격이 그사이 움직였으면 git 이 거절한다(강제 push 하지 않는다)
  git -C "$TOP" push origin "$HEAD_FULL:refs/heads/$BRANCH" || fail "push 실패 — 원격이 그사이 움직였으면 받아서 다시"
  ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$BRANCH" "$PUSHED" "$PR_NUMBER" <<'PYEOF'
import os, sys, re
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, branch, pushed, number = sys.argv[1:5]
shas = set(pushed.split())
def mark(match):
    entry = match.group(0)
    hit = re.search(r'`([0-9a-f]{6,})`', entry)
    return entry.replace('push 안 함', f'push → PR #{number}(자동 수정)') if hit and any(full.startswith(hit.group(1)) for full in shas) and branch in entry else entry
update_plan(plan, lambda text: re.sub(r'^- .*push 안 함.*$', mark, text, flags=re.M))
PYEOF
  [ $? = 0 ] || echo "⚠️ push 는 됐지만 계획서 기록에 실패했다 — Commits 줄의 'push 안 함' 을 손으로 고친다" >&2
  node "$ATHENA_DIR/scripts/lib/events.mjs" auto.push plan="$PLAN" repo="$REPO" branch="$BRANCH" sha="$HEAD_SHA" pr="$PR_NUMBER"${BODY_FILE:+ body=1} >/dev/null 2>&1 || true
  auto_review_now "$PR_NUMBER"
  echo "✅ 자동 수정 push: $REPO · $HEAD_SHA → origin/$BRANCH (PR #$PR_NUMBER) — 자동 리뷰가 새 커밋을 바로 다시 본다"
  exit 0
fi

# ── 3. base 후보 · 제목 범위 ─────────────────────────────────────────────
git -C "$TOP" fetch --quiet origin 2>/dev/null || echo "⚠️ fetch 실패 — 로컬의 origin 참조로 본다" >&2
REPO_SPEC="$(python3 - "$ATHENA_DIR" "$REPO" <<'PYEOF'
import json, sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load; cfg = load(sys.argv[1])
repo = next((entry for entry in cfg['repos'] if entry['name'] == sys.argv[2]), {})
base = repo.get('prBase') or next((app.get('prBase') for app in (repo.get('apps') or {}).values() if app.get('prBase')), '')
print(base or 'dev')
print(' '.join(repo.get('extraPrBases') or []))
print(1 if repo.get('requireChangeset') else 0)
print(json.dumps({'prScope': repo.get('prScope'), 'layer': repo.get('layer', '')}))
PYEOF
)"
PR_BASE="$(sed -n 1p <<<"$REPO_SPEC")"; REQUIRE_CHANGESET="$(sed -n 3p <<<"$REPO_SPEC")"; SCOPE_SPEC="$(sed -n 4p <<<"$REPO_SPEC")"
CANDIDATES=("$PR_BASE")
# shellcheck disable=SC2207
CANDIDATES+=($(sed -n 2p <<<"$REPO_SPEC"))   # 레포 관례로 함께 올리는 base(예: 앱은 prd·dev 양쪽)
# 최근 30일 안에 움직인 원격 release/* — 기능 PR 을 릴리즈 브랜치로 모으는 경우
while IFS= read -r ref; do [ -n "$ref" ] && CANDIDATES+=("$ref"); done < <(
  git -C "$TOP" for-each-ref --sort=-committerdate --format='%(committerdate:unix) %(refname:strip=3)' 'refs/remotes/origin/release/*' \
    | awk -v since="$(( $(date +%s) - 30*86400 ))" '$1 >= since {print $2}' | head -3)

CHANGED_FROM="origin/$PR_BASE"
git -C "$TOP" rev-parse -q --verify "$CHANGED_FROM" >/dev/null || CHANGED_FROM="$(git -C "$TOP" merge-base HEAD "origin/${BASES[0]:-$PR_BASE}" 2>/dev/null || echo HEAD~1)"
CHANGED="$(git -C "$TOP" diff --name-status "$CHANGED_FROM"...HEAD 2>/dev/null)"
SCOPES="$(SCOPE_SPEC="$SCOPE_SPEC" python3 -c '
import json, os, re, sys
spec = json.loads(os.environ["SCOPE_SPEC"] or "{}"); files = [line.split("\t")[-1] for line in sys.stdin.read().splitlines() if line.strip()]
rules = spec.get("prScope")
if rules is None and spec.get("layer") == "be":
    # 백엔드 기본 — 바뀐 src/<모듈>(기능 폴더가 있으면 src/features/<기능>)을 범위로 제안한다
    rules = [{"match": "^src/features/([^/]+)/", "scope": "$1"}, {"match": "^src/([^/]+)/", "scope": "$1"}]
scopes = []
if isinstance(rules, str):
    scopes = [rules]
elif rules:
    for path in files:
        for rule in rules:
            hit = re.match(rule["match"], path)
            if not hit: continue
            name = re.sub(r"\$(\d)", lambda ref: hit.group(int(ref.group(1))), rule["scope"])
            if name not in scopes: scopes.append(name)
            break
print(",".join(scopes))
' <<<"$CHANGED")"
TICKET="$(grep -oE '[A-Z][A-Z0-9]+-[0-9]+' <<<"$BRANCH" | head -1)"
LAST_TYPE="$(git -C "$TOP" log -1 --pretty=%s | grep -oE '^(feat|fix|refactor|chore|docs|style|test)' || echo feat)"
SUMMARY="$(sed -E 's/^\[?[A-Z][A-Z0-9]+-[0-9]+\]?[ :—-]*//' <<<"$PLAN_TITLE")"
SUGGESTED="${LAST_TYPE}(${SCOPES:-범위}): ${TICKET:+$TICKET }${SUMMARY}"

# ── 4. 본문 초안 ─────────────────────────────────────────────────────────
DRAFT="$(git -C "$TOP" rev-parse --absolute-git-dir)/hermes-pr-body.md"
[ $YES = 1 ] || printf '%s\n' "$HEAD_FULL" > "$DRAFT.head"
[ $YES = 1 ] || CHANGED="$CHANGED" python3 - "$ATHENA_DIR/$PLAN" "$DRAFT" "$TICKET" <<'PYEOF'
import os, re, sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'); out = pathlib.Path(sys.argv[2]); ticket = sys.argv[3]
def section(names):
    for name in names:
        hit = re.search(rf'^#{{2,3}} (?:\d+\.\s*)?{name}\s*\n(.*?)(?=^#{{1,3}} |\Z)', text, re.M | re.S)
        if hit and hit.group(1).strip():
            return hit.group(1).strip()
    return ''
def clean(block):
    lines = [re.sub(r'^>\s?', '', line) for line in block.splitlines()]
    # hermes 로컬 경로는 PR 에 싣지 않는다
    return '\n'.join(line for line in lines if 'plans/' not in line and line.strip() not in ('', '---')).strip()
what = clean(section(['지시', '개요'])) or '- (작업 내용을 적는다)'
result = clean(section(['결과']))
validation = clean(section(['Validation'])) or '(검증 결과를 붙인다)'
kinds = {'A': '추가', 'M': '수정', 'D': '삭제', 'R': '이름 변경', 'C': '복사'}
changed = []
for row in os.environ.get('CHANGED', '').splitlines():
    cols = row.split('\t')
    if len(cols) >= 2:
        changed.append(f"- {kinds.get(cols[0][:1], cols[0])} `{cols[-1]}`")
body = f"""## 작업 내용
{what}

## 변경 사항
{chr(10).join(changed) or '- (변경 파일)'}
{result}

## 검증
{validation}

## 확인 필요
- 없음

---
{'티켓: ' + ticket + chr(10) if ticket else ''}🤖 Generated with [Claude Code](https://claude.com/claude-code)
"""
out.write_text(body, encoding='utf-8')
PYEOF

# ── 5. 미리보기 ──────────────────────────────────────────────────────────
if [ $YES = 0 ]; then
  echo "── PR 미리보기 (아직 아무것도 보내지 않았다)"
  echo "레포     $REPO · 🌿 $BRANCH · HEAD $HEAD_SHA"
  echo "base 후보 ${CANDIDATES[*]}   (기본: $PR_BASE — athena.config.json prBase)"
  echo "올라갈 커밋 ($CHANGED_FROM..HEAD):"
  git -C "$TOP" log --oneline "$CHANGED_FROM"..HEAD 2>/dev/null | sed 's/^/  /'
  echo "검증     $RECORDED"
  [ -n "$VERIFY_WARN" ] && echo "         $VERIFY_WARN"
  echo "리뷰     $REVIEW_NOTE"
  [ "$UNTRACKED" = 0 ] || echo "미추적   ⚠️ 커밋 안 된 새 파일 ${UNTRACKED}개 — PR 에 안 들어간다"
  [ "$REQUIRE_CHANGESET" = 1 ] && ! grep -q '\.changeset/.*\.md' <<<"$CHANGED" && echo "changeset ⚠️ .changeset/*.md 가 없다 — 머지가 막힌다(pnpm changeset)"
  echo "제목 제안 $SUGGESTED"
  echo "본문 초안 $DRAFT  (고치려면 이 파일을 편집하거나 --body-file — --yes 때 다시 만들지 않는다)"
  echo "──"
  echo "묻지 않고 — 작업 내용으로 제목과 본문 초안 파일을 정리한 뒤 --base $PR_BASE(다른 base 는 사용자가 말했을 때만) --title \"…\" [--no-review-ok] --yes 로 다시 실행한다"
  exit 0
fi

# ── 6. 보내기 전 확인 ────────────────────────────────────────────────────
[ ${#BASES[@]} -gt 0 ] || fail "--base 가 없다"
[ -n "$TITLE" ] || fail "--title 이 없다"
[ "$REVIEWED" = ok ] || [ $REVIEW_OK = 1 ] || fail "${REVIEW_NOTE#⚠️ }"
TYPE_RE='(feat|fix|refactor|chore|docs|style|test)'
[[ "$TITLE" =~ ^$TYPE_RE\(([^\)]+)\):\ .+ ]] || fail "제목 형식이 아니다: \"$TITLE\" — type(범위): 티켓 요약. 제안: $SUGGESTED"
TITLE_SCOPE="${BASH_REMATCH[2]}"
if [ -n "$SCOPES" ]; then
  for part in ${TITLE_SCOPE//,/ }; do
    grep -qxF "$part" <<<"${SCOPES//,/$'\n'}" || fail "제목의 범위($part)가 이 변경의 범위($SCOPES)에 없다. 제안: $SUGGESTED"
  done
fi
[ -z "$TICKET" ] || grep -qF "$TICKET" <<<"$TITLE" || fail "브랜치의 티켓($TICKET)이 제목에 없다. 제안: $SUGGESTED"
BODY="${BODY_FILE:-$DRAFT}"
[ -f "$BODY" ] || fail "본문 파일이 없다: $BODY — 미리보기(--yes 없이)부터 돌린다"
if [ -z "$BODY_FILE" ] && [ "$(cat "$DRAFT.head" 2>/dev/null)" != "$HEAD_FULL" ]; then
  fail "미리보기 뒤에 HEAD 가 바뀌었다 — 초안이 지금 커밋과 맞지 않는다. 미리보기부터 다시"
fi
check_body "$BODY"
for base in "${BASES[@]}"; do
  git -C "$TOP" ls-remote --exit-code --heads origin "$base" >/dev/null 2>&1 || fail "원격에 base 브랜치가 없다: $base"
  [ -n "$(git -C "$TOP" rev-list "origin/$base"..HEAD 2>/dev/null)" ] || fail "origin/$base 에 없는 커밋이 없다 — 올릴 게 없다"
done

# ── 7. push → draft PR ───────────────────────────────────────────────────
# 검사한 커밋만 보낸다 — commit.sh 와 같은 워크트리 잠금을 쥐고(그동안 커밋이 끼어들지 않게) HEAD·미커밋 변경을 다시 본 뒤,
# 브랜치 이름이 아니라 검사한 SHA 를 push 한다(fetch·확인을 기다리는 사이 다른 커밋이 생겨도 검사 안 된 커밋이 나가지 않게)
LOCK="$(git -C "$TOP" rev-parse --git-dir)/hermes-commit.lock"
mkdir "$LOCK" 2>/dev/null || fail "커밋이 진행 중이다($LOCK) — 끝난 뒤 미리보기부터 다시"
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
[ "$(git -C "$TOP" rev-parse HEAD)" = "$HEAD_FULL" ] || fail "확인하는 동안 HEAD 가 바뀌었다(${HEAD_SHA} → $(git -C "$TOP" rev-parse --short HEAD)) — 미리보기부터 다시"
[ -z "$(git -C "$TOP" status --porcelain --untracked-files=no)" ] || fail "확인하는 동안 커밋하지 않은 변경이 생겼다 — 미리보기부터 다시"
git -C "$TOP" push origin "$HEAD_FULL:refs/heads/$BRANCH" || fail "push 실패"
git -C "$TOP" branch --quiet --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true
# base 가 여러 개면 하나가 실패해도 앞에서 만든 PR 은 계획서에 남긴다(그다음에 실패를 알린다 — 다시 돌리면 열린 PR 은 건너뛴다)
PR_LINES=""; PR_FAILED=""
for base in "${BASES[@]}"; do
  URL="$(cd "$TOP" && gh pr list --head "$BRANCH" --base "$base" --state open --json url --jq '.[0].url' 2>/dev/null)"
  if [ -n "$URL" ]; then
    echo "ℹ️ 이미 열린 PR 이 있다 — push 만 했다: $URL"
  elif URL="$(cd "$TOP" && gh pr create --draft --base "$base" --head "$BRANCH" --title "$TITLE" --body-file "$BODY")"; then
    URL="$(tail -1 <<<"$URL")"
    echo "✅ draft PR: $URL ($BRANCH → $base)"
  else
    echo "❌ PR 생성 실패(base $base) — push 는 됐다" >&2
    PR_FAILED="$PR_FAILED $base"
    continue
  fi
  PR_LINES="$PR_LINES$base $URL"$'\n'
done

# ── 8. 계획서에 기록 ─────────────────────────────────────────────────────
PUSHED="$(for base in "${BASES[@]}"; do git -C "$TOP" log --pretty=%H "origin/$base"..$HEAD_FULL 2>/dev/null; done | sort -u | tr '\n' ' ')"
ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$(date '+%Y-%m-%d %H:%M')" "$BRANCH" "$PUSHED" "$PR_LINES" <<'PYEOF'
import os, sys, re
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, stamp, branch, pushed, pr_lines = sys.argv[1:6]
prs = [line.split(' ', 1) for line in pr_lines.strip().splitlines() if ' ' in line]
note = ' · '.join(f'push → {base} PR {url}' for base, url in prs)
shas = set(pushed.split())
def mark(match):
    entry = match.group(0)
    hit = re.search(r'`([0-9a-f]{6,})`', entry)
    return entry.replace('push 안 함', note) if hit and any(full.startswith(hit.group(1)) for full in shas) and branch in entry else entry
def record(text):
    text = re.sub(r'^- .*push 안 함.*$', mark, text, flags=re.M)
    for base, url in prs:
        line = f'- PR: {url} ({branch} → {base}, draft · {stamp})'
        if f'- PR: {url}' not in text:
            anchor = re.search(r'^- (Review|Work ref):.*$', text, re.M)
            text = text[:anchor.end()] + '\n' + line + text[anchor.end():] if anchor else text.rstrip('\n') + '\n' + line + '\n'
    return text
# 잠금 안에서 지금 내용을 다시 읽어 바꾼다 · 정식 계획서면 html 의 md 사본도 맞춘다
update_plan(plan, record)
PYEOF
[ $? = 0 ] || echo "⚠️ PR 은 올라갔지만 계획서 기록에 실패했다 — 계획서에 PR 링크를 손으로 적는다" >&2
while read -r _ url; do [ -n "${url:-}" ] && auto_review_now "${url##*/pull/}"; done <<<"$PR_LINES"
if [ -n "$PR_FAILED" ]; then
  echo "⚠️ push 는 됐고${PR_LINES:+ 연 PR 은 계획서에 적었지만,} base${PR_FAILED} 의 PR 을 만들지 못했다 — 사용자에게 알린다(같은 명령을 다시 돌리면 열린 PR 은 건너뛰고 나머지만 만든다)" >&2
  exit 1
fi
echo "   draft 다. 리뷰어 지정·Ready 전환은 GitHub 에서"
