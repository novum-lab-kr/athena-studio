#!/usr/bin/env bash
# 에이전트를 **보이는 화면 pane**(Athena Studio — scripts/screen)에서 연다. 아테나가 Agent 도구(백그라운드) 대신 쓴다.
#
# **계획서 없이는 띄우지 않는다** — 모든 작업은 계획서 하나에 묶인다 (AGENTS.md 5절)
#   --plan <plans/…md>          이미 있는 계획서(정식·경량)에 묶는다
#   --plan new "<한 줄 요약>"     경량 계획서를 새로 만들어 묶는다 (scripts/new-plan.mjs → plans/task/…)
# 띄운 뒤 계획서 Checkpoint 의 Work ref 에 워크트리·브랜치·pane 을 적고, 에이전트 지시 맨 앞에 계획서 경로를 넣는다.
#
# 사용:
#   scripts/delegate.sh <에이전트명> --plan <경로>         # 담당 레포 workspace 의 새 탭에 연다 (기본)
#   scripts/delegate.sh <에이전트명> --cwd <워크트리>       # 그 워크트리에서 연다
#   scripts/delegate.sh <에이전트명> --here                # 레포 workspace 로 보내지 않고 지금 탭에 쪼갠다 (단발 조사용)
#   scripts/delegate.sh <에이전트명> --plan <경로> --reuse-pane <pane> [--new-branch <이름>]  # 쉬는 같은 레포 pane 에 새 pane 대신 이어 보낸다(docs/dispatch.md "이어 보내기" · 고르기 node scripts/reuse-pane.mjs --agent <이름>)
#   scripts/delegate.sh <에이전트명> --plan <경로> --resume <세션 id> [--cwd <워크트리>]  # 닫힌 pane 을 그 대화 그대로 다시 연다(지시문은 다시 보내지 않는다)
#
# 배치 규칙 — workspace = 레포 / 그 안의 한 탭에 pane 을 나란히
#   워크트리마다 탭을 가르지 않는다. 한 화면에서 동시 작업 상황이 다 보이는 쪽이 낫다.
#   각 pane 은 "🤖 <에이전트> · <워크트리>" 로 이름이 붙고, 하단 상태바가
#   레포·브랜치·변경 개수를 보여준다 (scripts/statusline.sh).
#   scripts/delegate.sh <에이전트명> "<프롬프트>"           # 프롬프트까지 넣어 바로 시작
#   scripts/delegate.sh <에이전트명> --cwd <경로>          # 워크트리 등 다른 디렉터리에서 연다
#   scripts/delegate.sh <에이전트명> "<프롬프트>" --down    # 아래로 분할(주면 아래 "나눌 자리" 기준을 쓰지 않는다)
#
# 에이전트명은 .claude/agents/<이름>.md 의 name 이다 (reviewer 등).
# 결과는 pane 에서 보고, 아테나는 `scripts/screen pane read <id>` 로 읽는다.
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"   # 실제 경로 — 옛 폴더 이름(hermes 링크)으로 불려도 같은 값
SCREEN="$ATHENA_DIR/scripts/screen"   # 화면 계층 — workspace·탭·pane 은 이걸로만 다룬다
. "$ATHENA_DIR/scripts/lib/shell-line.sh"   # shell_line — pane run 에 넘길 셸 한 줄(띄어쓰기·한글 안전)

AGENT=""; PROMPT=""; DIR="right"; DIR_GIVEN=0; WORKDIR=""; HERE=0; PLAN=""; PLAN_NEW=""; REUSE_PANE=""; NEW_BRANCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan)
      if [ "${2:-}" = new ]; then [ $# -ge 3 ] || { echo "--plan new 에 요약이 없다" >&2; exit 2; }; PLAN_NEW="$3"; shift 3; else [ $# -ge 2 ] || { echo "--plan 에 경로가 없다" >&2; exit 2; }; PLAN="$2"; shift 2; fi ;;
    --down) DIR="down"; DIR_GIVEN=1; shift ;;
    --here) HERE=1; shift ;;
    --reuse-pane) [ $# -ge 2 ] || { echo "--reuse-pane 에 pane id 가 없다" >&2; exit 2; }; REUSE_PANE="$2"; shift 2 ;;   # 쉬는 같은 레포 pane 에 새 pane 대신 이어 보낸다
    --new-branch) [ $# -ge 2 ] || { echo "--new-branch 에 브랜치 이름이 없다" >&2; exit 2; }; NEW_BRANCH="$2"; shift 2 ;;   # --reuse-pane 과 함께 — 그 pane 의 워크트리에서 prBase 로 새 브랜치를 딴다
    --cwd)  [ $# -ge 2 ] || { echo "--cwd 에 경로가 없다" >&2; exit 2; }; WORKDIR="$2"; shift 2 ;;
    --resume) [ $# -ge 2 ] || { echo "--resume 에 세션 id 가 없다" >&2; exit 2; }; RESUME="$2"; shift 2 ;;   # 닫힌 에이전트 pane 을 그 대화 그대로 다시 연다(claude --resume <세션 id>) — 지시문은 다시 보내지 않는다
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) if [ -z "$AGENT" ]; then AGENT="$1"; else PROMPT="$1"; fi; shift ;;
  esac
done

[ -z "$NEW_BRANCH" ] || [ -n "$REUSE_PANE" ] || { echo "--new-branch 는 --reuse-pane 과 같이 쓴다(새 pane 은 이미 --cwd 워크트리에서 뜬다)" >&2; exit 2; }
[ -n "$AGENT" ] || { echo "사용: $0 <에이전트명> --plan <plans/…md | new \"<요약>\"> [\"<프롬프트>\"] [--cwd <경로>] [--here] [--down]"; exit 2; }

# 계획서 필수 — 없으면 띄우지 않는다
if [ -z "$PLAN" ] && [ -z "$PLAN_NEW" ]; then
  echo "계획서 없이는 에이전트를 띄우지 않는다. --plan <plans/…md> 또는 --plan new \"<한 줄 요약>\" 을 준다 (docs/plan-template-light.md)" >&2
  exit 2
fi

# 에이전트 이름 검증 — 오타로 엉뚱한 세션이 뜨는 것을 막는다
if [ ! -f "$ATHENA_DIR/.claude/agents/$AGENT.md" ]; then
  echo "그런 에이전트가 없다: $AGENT"
  echo "가능한 이름: $(ls "$ATHENA_DIR/.claude/agents" | sed 's/\.md$//' | tr '\n' ' ')"
  exit 2
fi

# 이 본체의 팩을 열거나 업데이트하는 중이면 새 작업을 받지 않는다(<데이터>/locks/<팩 id>.lock — bin/athena pack open·update). 팩 ID·세대는 실행기에 넘긴다
PACK_STATE="$(python3 - "$ATHENA_DIR" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import paths, switching
where = paths(sys.argv[1])
print('switching' if switching(sys.argv[1]) else 'ok', where.get('packId') or '', where.get('generation') if where.get('generation') is not None else '', sep='\t')
PYEOF
)"
IFS=$'\t' read -r PACK_SWITCH PACK_ID PACK_GEN <<< "$PACK_STATE"
if [ "$PACK_SWITCH" = switching ]; then
  echo "이 팩을 열거나 업데이트하는 중이라 에이전트를 띄우지 않는다 — 끝난 뒤 다시(bin/athena pack status)" >&2
  exit 1
fi

if [ -n "$PLAN_NEW" ]; then
  PROMPT_TMP="$(mktemp -t hermes-plan-prompt)"; printf '%s' "$PROMPT" > "$PROMPT_TMP"
  PLAN="$(node "$ATHENA_DIR/scripts/new-plan.mjs" --agent "$AGENT" --summary "$PLAN_NEW" --prompt-file "$PROMPT_TMP")" || { rm -f "$PROMPT_TMP"; echo "경량 계획서를 만들지 못했다" >&2; exit 1; }
  rm -f "$PROMPT_TMP"
fi
# 본체 기준 논리 경로로 — 여러 팩 구조에서 plans/ 는 팩 데이터를 가리키는 링크라 실제 경로로 풀면 본체 밖이 된다(scripts/lib/plan-path.sh)
. "$ATHENA_DIR/scripts/lib/plan-path.sh"
PLAN="$(plan_rel "$ATHENA_DIR" "$PLAN")"
case "$PLAN" in plans/*.md) ;; *) echo "계획서는 plans/ 아래 .md 여야 한다: $PLAN" >&2; exit 2 ;; esac
[ -f "$ATHENA_DIR/$PLAN" ] || { echo "계획서가 없다: $PLAN" >&2; exit 2; }
# char_count [파일] — 글자 수(바이트 아님 · 셸 언어 설정과 무관). 못 세면 0
char_count() { python3 -c 'import sys; print(len(open(sys.argv[1] if len(sys.argv) > 1 else 0, encoding="utf-8", errors="replace").read()))' "$@" 2>/dev/null || echo 0; }
# 자동 리뷰는 정식 계획서(plans/{feature,bugfix,refactor}/ — 여러 레포 작업도 정식이다)의 넓은 수정만. 경량(plans/task/)은 넓은 수정일 때 "리뷰할까요?" 한 줄 — 사용자가 "리뷰해줘" 할 때만.
# 리뷰 지적 반영 · 문구 · 문서 · 작은 수정 뒤에는 다시 띄우지도 묻지도 않는다(2026-10-25 사용자 "수정 범위가 넓지 않은 이상 리뷰는 하지 말자")
case "$PLAN" in
  plans/task/*)
    REVIEW_RULE="리뷰는 띄우지 않는다(경량 계획서 — 자동 리뷰는 정식 계획서의 넓은 수정만). 넓은 수정(새 기능 · 구조 변경 · 여러 파일에 걸친 로직 변경 · 보안 · 권한 · 데이터 · 외부 계약에 닿는 코드)을 보고할 때만 끝에 '리뷰할까요?' 한 줄을 붙이고, 작은 수정이면 붙이지 않는다. 사용자가 '리뷰해줘' 라고 하면 언제든 띄운다. "
    REVIEW_AGAIN="고친 뒤에는 다시 묻지 않는다. " ;;
  *)
    REVIEW_RULE="넓은 수정(새 기능 · 구조 변경 · 여러 파일에 걸친 로직 변경 · 보안 · 권한 · 데이터 · 외부 계약에 닿는 코드)을 끝내 보고하면 묻지 않고 바로 리뷰를 띄운다(자동 리뷰 — 정식 계획서). 리뷰 지적 반영 · 문구 · 문서 · 작은 수정이거나 조사만 했거나 마지막 리뷰 승인 뒤 바뀐 게 없으면 띄우지 않는다. 사용자가 '리뷰해줘' 라고 하면 언제든 띄운다. "
    REVIEW_AGAIN="고친 뒤에는 다시 리뷰를 띄우지 않는다(고친 범위가 넓을 때만). " ;;
esac
# 아테나 pane — 에이전트가 넘길 일을 사용자에게 전해 달라고 하지 않고 직접 보내게 지시에 싣는다.
# 아테나 pane 에서 불렀을 때만(에이전트 pane 이 reviewer 를 띄울 때는 그 pane 이 아테나가 아니다)
LEAD_PANE=""
if [ -z "${ATHENA_AGENT:-}" ]; then
  LEAD_PANE="$( (eval "$("$SCREEN" self --format sh 2>/dev/null)"; printf '%s' "${SCREEN_PANE_ID:-}") 2>/dev/null )"
fi
if [ -n "$LEAD_PANE" ]; then
  LEAD_RULE="아테나에게 넘길 일(여러 레포 작업의 push·PR, 보호 훅이 막은 merge·dev 반영, 담당 레포 밖 수정)은 사용자에게 전해 달라고 하지 말고 직접 보낸다: $SCREEN pane send-text $LEAD_PANE '[$AGENT → 아테나] <무엇을·왜 · 계획서 경로 · 사용자 지시면 그 말>' --enter — 보냈다고 한 줄 알린다. "
else
  LEAD_RULE="아테나에게 넘길 일(여러 레포 작업의 push·PR, 보호 훅이 막은 merge·dev 반영, 담당 레포 밖 수정)은 사용자에게 전해 달라고 하지 말고 아테나 pane 에 직접 보낸다($SCREEN pane list 로 아테나 pane 을 찾아 pane send-text <pane> '[$AGENT → 아테나] …' --enter). "
fi
# 아테나에게 보내기가 실패하면 우회하지 않고 요청으로 남긴다(GitHub 이슈 #134) — 반쯤 전달되거나 사라지지 않게
LEAD_RULE="${LEAD_RULE}보내기가 실패하면 우회하지 말고 요청으로 남긴다($ATHENA_DIR/docs/requests.md '아테나에게 보내지 못했을 때' · --plan $PLAN). "
# 끝나면 저절로 PR(결정 D3 · 2026-10-25) — 담당 레포가 "autoMerge": true(PR 켬 · main 직접 레포 제외)일 때만 지시에 싣는다(리뷰 · 머지 설정과 상관없이).
# 켜지 않은 레포는 지금처럼 사용자가 "PR 올려줘" 할 때만
AUTO_SHIP_RULE=""
AUTO_SHIP_REPO="$(python3 - "$ATHENA_DIR" "$AGENT" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
cfg = load(sys.argv[1]); agent = sys.argv[2]
for repo in cfg['repos']:
    mine = agent in (repo.get('agents') or []) or agent == repo.get('packagesAgent') or any(app.get('agent') == agent for app in (repo.get('apps') or {}).values())
    if mine:
        if repo.get('autoMerge') is True and not repo.get('direct'): print(repo['name'] + (' pr-off' if repo.get('autoPr') is False else ''))
        break
PYEOF
)"
if [ "${AUTO_SHIP_REPO#* }" = "pr-off" ]; then
  # PR 끔 — 끝나면 PR 없이 prBase 에 바로 머지(ship.sh --direct-merge). "PR 올려줘" 는 그대로 PR
  AUTO_SHIP_REPO="${AUTO_SHIP_REPO%% *}"
  AUTO_SHIP_RULE="이 레포($AUTO_SHIP_REPO)는 자동 PR 을 껐다(pack.json autoMerge + autoPr:false · docs/pr-auto.md) — 레포 하나짜리 작업이면 요청을 끝내고 검증 스크립트가 통과했을 때 사용자 요청 없이 ① commit.sh 로 커밋 ② $ATHENA_DIR/scripts/ship.sh --plan $ATHENA_DIR/$PLAN --dir <워크트리> --direct-merge 를 돈다(PR · 제목 · base · 본문 · --yes 없음 · 동작은 docs/pr-auto.md). 사용자가 'PR 올려줘' 라고 하면 이 옵션 없이 평소대로 PR 을 만든다. 조사만 했거나 바뀐 게 없으면 올리지 않고, 검증이 실패하면 올리지 않고 보고한다. "
elif [ -n "$AUTO_SHIP_REPO" ]; then
  AUTO_SHIP_RULE="이 레포($AUTO_SHIP_REPO)는 끝나면 PR 올리기를 켰다(pack.json autoMerge · docs/pr-auto.md) — 레포 하나짜리 작업이면 요청을 끝내고 검증 스크립트가 통과했을 때 사용자 'PR 올려줘' 없이 위 'PR 올려줘' 흐름을 묻지 않고 그대로 돈다(이미 열린 PR 이 있으면 ship.sh 가 그 브랜치에 push 만 한다). 조사만 했거나 바뀐 게 없으면 올리지 않고, 검증이 실패하면 올리지 않고 보고한다. "
fi
# 에이전트 지시 맨 앞에 계획서를 박는다 — 프롬프트 없이 열어도 계획서를 읽고 시작하게
# AGENTS.md 5·6절(커밋·push 금지 · 보고 순서 · 비밀값 · heavy.sh)은 agent-context.py 가 이미 싣는다 — 여기서는 되풀이하지 않고 스크립트 경로·절차·5절 원칙(읽을 것 · 범위 커지면 멈춤 · 버그는 재현부터 · 추측 금지)만 둔다('시키지 않은 문구·기능은 더하지 않는다' 는 AGENTS.md · .claude/rules 에 같은 말이 없어 여기 남긴다 — reporting.md 는 자동으로 실리지 않는다)
PLAN_HEADER="이 작업의 계획서: $ATHENA_DIR/$PLAN — 먼저 읽고 Checkpoint 의 Next 부터 한다. 끝나면(또는 막히면) 그 계획서의 Progress(무엇을 했나) · 결과 절(무엇이 달라졌나 · 확인 못 한 것)을 채운다. Validation 줄은 검증 스크립트가, 커밋 뒤 Status ready_for_review 는 commit.sh 가 적는다 — 직접 바꾸는 것은 막히면 blocked · 커밋 없이 끝나면 ready_for_review · PR 없이 끝나는 일(조사·스크린샷처럼 레포 변경이 없는 작업)은 마지막 보고 때 done. 커밋은 사용자가 '커밋해줘' 또는 'PR 올려줘' 라고 할 때만 $ATHENA_DIR/scripts/commit.sh --plan $ATHENA_DIR/$PLAN --dir <워크트리> -m '<레포 관례 메시지>' -- <바꾼 파일>… 로 한다(거부되면 이유를 그대로 전하고 사용자에게 묻는다). 예외 하나 — '[자동 리뷰 → <나>]' 로 시작하는 지시(PR 자동 리뷰 · 레포가 autoMerge 를 켠 경우)는 그 지시대로 묻지 않고 commit.sh 로 커밋하고 그 지시의 ship.sh --auto-push 로 올린다(그 PR 브랜치에 빨리 감기만 · 새 PR 없음 · PR 본문 지적이면 --body-file <파일> 을 붙여 본문도 바꾼다 · docs/pr-auto.md). ${REVIEW_RULE}리뷰 결론이 나오면 사용자에게 보여 준다. reviewer 보고에 '결정 필요'(선택지가 갈리는 항목, R1·R2…)가 있으면 말로 묻지 말고 결정 콘솔로 보여 주고 확정되면 고친다(절차 $ATHENA_DIR/docs/workflow.md 4절 '리뷰 뒤 결정 콘솔'). ${REVIEW_AGAIN}'결정 필요' 없이 수정 필요(고칠 방법이 하나)만 있으면 묻지 않고 고친 뒤 무엇을 고쳤는지 한 줄씩 알린다. 사용자가 '리뷰해줘' 라고 할 때도 같다: $ATHENA_DIR/scripts/delegate.sh reviewer --cwd <워크트리> --here --plan $ATHENA_DIR/$PLAN 로 옆에 reviewer pane 을 띄운다(직접 리뷰하지 않는다 — reviewer 가 결론을 계획서 '- Review result:' 줄에 남기고, ship.sh 미리보기에 나온다). 사용자가 'PR 올려줘' 라고 하면 묻지 않고 끝까지 간다: 안 올린 내 작업을 commit.sh 로 커밋 → $ATHENA_DIR/scripts/ship.sh --plan $ATHENA_DIR/$PLAN --dir <워크트리> 미리보기 → 제목 · 본문 정리(git.md 'PR 올리기') → 같은 명령에 --base <미리보기의 기본 base> --title '…' --yes(리뷰 줄이 ⚠️ 면 --no-review-ok 를 붙이고 본문 '확인 필요' 와 보고에 적는다). 다른 base 는 사용자가 말했을 때만 · main 직접 레포의 push 만 미리보기를 보여 주고 확인받는다 · 거부되면 이유를 그대로 전한다 · 여러 레포 작업은 ship.sh 가 거부하니 아테나에게 직접 요청한다. ${AUTO_SHIP_RULE}추측으로 구현하지 않는다 — 모르는 사실은 확인하고, 그래도 모르면 그 부분만 멈추고 Blocked 에 적어 모아 묻는다(공통 규칙 AGENTS.md 5절). ${LEAD_RULE}시키지 않은 문구·기능은 더하지 않는다. 로그인·인증처럼 사람이 해야 하는 단계면 멈추고 무엇을 어디서 할지 알린다. 요청을 여러 번 주고받는다 — 새 요청을 받을 때마다 작업을 시작하기 전에 Status 를 in_progress 로 되돌린다(끝나면 위대로). Progress 에는 요청마다 한 줄씩 더한다. "
if [ "$AGENT" = reviewer ]; then
  # reviewer 는 커밋·PR·Status 를 다루지 않는다 — 에이전트용 머리말 대신 리뷰 머리말만 싣는다
  PLAN_HEADER="리뷰할 계획서: $ATHENA_DIR/$PLAN — 읽기 전용으로 리뷰한다(코드·계획서 본문을 고치지 않는다). 대상 트리는 지금 작업 디렉토리다. 리뷰를 마치면 결론을 $ATHENA_DIR/scripts/review-result.sh --plan $ATHENA_DIR/$PLAN --dir <리뷰한 트리> --verdict 승인|수정필요 --note '<한 줄 요약>' 로 한 줄 남긴다(ship.sh 가 이 줄과 HEAD 를 대조한다). 그다음 수정 필요(고칠 방법이 하나) / 결정 필요(조사한 뒤에도 사용자가 정해야 하는 것만 — 범위·사용자 동작·외부 계약·제품 정책·데이터가 달라지는 선택. 구현 방법이 여러 개일 뿐이면 하나를 골라 수정 필요로 · R1 <제목> — <영향> 다음 줄부터 A <선택지> ★ — <설명> · B … 형식, 없으면 '결정 필요: 없음') / 제안으로 나눠 보고한다(형식 정본 .claude/agents/reviewer.md 의 보고 형식 절). "
  SKIP_AGENT_HEADER=1
fi
# 지시 없이 띄우면(/call) 사용자가 pane 에서 직접 요청한다 — 첫 요청으로 계획서를 채우게 한다
# (/call 은 아테나가 브랜치를 먼저 묻고 워크트리를 만든 뒤 --cwd 로 띄운다 — Explorer 가 그 워크트리를 따라가게)
if [ -z "${SKIP_AGENT_HEADER:-}" ]; then
# 이슈가 연결된 계획서는 할 일이 이미 정해져 있다 — 지시문이 없어도 기다리지 않고 Next 부터 진행한다
PLAN_ISSUE="$(sed -n 's/^- Issue:[[:space:]]*\(issues\/[^[:space:]]*\.md\).*/\1/p' "$ATHENA_DIR/$PLAN" | head -1)"
if [ -z "$PROMPT" ] && [ -n "$PLAN_ISSUE" ] && [ -f "$ATHENA_DIR/$PLAN_ISSUE" ]; then
  PLAN_HEADER="${PLAN_HEADER}이 계획서는 이슈 $ATHENA_DIR/$PLAN_ISSUE 에 연결돼 있다 — 지시문이 따로 없어도 이슈(근거·할 일)와 계획서 Progress·Next 가 할 일이다. 요청을 기다리지 말고 브랜치·미커밋 상태를 한 줄로 보고한 뒤 곧바로 Next 부터 진행한다. 시작할 때 계획서 '## 지시' 절을 '이슈 $PLAN_ISSUE 처리 — 계획서 Progress·Next 대로' 로 채우고 Status 를 in_progress 로 바꾼다. 계획서에 '확인을 받은 뒤' 라고 적힌 단계(수정안 확정 등)에서는 멈추고 사용자에게 묻는다. 이슈 파일의 status 는 바꾸지 않는다(아테나가 옮긴다). "
elif [ -z "$PROMPT" ]; then
  PLAN_HEADER="${PLAN_HEADER}지금은 지시가 없다. 브랜치·미커밋 상태만 확인해 한 줄로 보고하고 사용자의 요청을 기다린다. 첫 요청을 받으면 계획서의 제목(# 줄)과 '## 지시' 절을 그 요청으로 바꿔 적고 진행한다. "
fi
# 지시가 있든 없든(현황판 [작업 시작]도) — 범위가 커지면 멈춘다
PLAN_HEADER="${PLAN_HEADER}요청이 여러 레포·API·구조 변경으로 커지면 멈추고 정식 계획서가 필요하다고 알린다. 버그 수정이면 AGENTS.md 5절대로 재현부터 확인하고 수정 전·후를 같은 방법으로 비교한다. "
fi
RAW_PROMPT="$PROMPT"   # 이어 보내기(--reuse-pane)는 긴 머리말 없이 이 요청만 싣는다
PROMPT="$PLAN_HEADER${PROMPT}"
[ -n "${RESUME:-}" ] && PROMPT=""   # 이어 열기 — 계획서 안내는 처음 대화에 이미 있다

GIVEN_PROMPT="$PROMPT"
GIVEN_CWD="$WORKDIR"

# 이 에이전트의 담당 레포 경로를 config 에서 찾아 상태바(scripts/statusline.sh)에 넘긴다.
# 매핑의 정본은 athena.config.json 이므로 여기서 다시 적지 않는다. reviewer 처럼 전담 레포가
# 없으면 빈 값이고, 그러면 상태바가 현재 cwd 로 알아서 찾는다.
REPO_DIR="$(python3 - "$ATHENA_DIR" "$AGENT" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
cfg = load(sys.argv[1]); agent = sys.argv[2]
for repo in cfg['repos']:
    if agent in (repo.get('agents') or []) or agent == repo.get('packagesAgent'):
        print(repo['name']); break
    if any(app.get('agent') == agent for app in (repo.get('apps') or {}).values()):
        print(repo['name']); break
PYEOF
)"
[ -n "$REPO_DIR" ] && REPO_DIR="$ATHENA_DIR/repos/$REPO_DIR"
[ -n "$REPO_DIR" ] && [ ! -d "$REPO_DIR" ] && REPO_DIR=""

# reviewer 는 담당 레포가 없다 — 계획서를 보고 **어느 에이전트·레포 작업인지** 정해 그 레포 workspace 에 띄운다.
# Agent: 의 에이전트 → config 의 레포, Work ref: 맨 앞이 실제 폴더면(워크트리) 그곳을 cwd 로 (검증 스크립트도 그걸 본다).
# 아테나 자체 작업(Agent: hermes 등)이면 레포가 없으니 지금 탭에 둔다.
if [ "$AGENT" = reviewer ] && [ "$HERE" = 0 ]; then
  REVIEW_TARGET="$(python3 - "$ATHENA_DIR/$PLAN" "$ATHENA_DIR" <<'PYEOF'
import re, sys, pathlib
sys.path.insert(0, sys.argv[2] + '/scripts/lib'); from athena_config import load
text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'); cfg = load(sys.argv[2])
agent = (re.search(r'^- Agent:\s*(\S+)', text, re.M) or [None, ''])[1]
ref = (re.search(r'^- Work ref:\s*(\S+)', text, re.M) or [None, ''])[1]
repo = ''
for entry in cfg['repos']:
    if agent in (entry.get('agents') or []) or agent == entry.get('packagesAgent') or any(app.get('agent') == agent for app in (entry.get('apps') or {}).values()):
        repo = entry['name']; break
cwd = ref if ref.startswith('/') and pathlib.Path(ref).is_dir() else ''
if not repo and cwd:
    # 정식 계획서는 Agent 줄이 없다 — Work ref 워크트리의 메인 체크아웃으로 레포를 찾는다
    import subprocess, os
    listing = subprocess.run(['git', '-C', cwd, 'worktree', 'list', '--porcelain'], capture_output=True, text=True).stdout
    main = next((row[len('worktree '):] for row in listing.splitlines() if row.startswith('worktree ')), '')
    links = pathlib.Path(sys.argv[2]) / 'repos'   # 본체 repos/ (여러 팩이면 지금 팩의 레포 링크)
    for link in (links.iterdir() if links.is_dir() else []):
        if main and os.path.realpath(link) == os.path.realpath(main):
            repo = link.name; break
print(f'{repo}\t{cwd}')
PYEOF
)"
  REVIEW_REPO="${REVIEW_TARGET%%$'\t'*}"; REVIEW_CWD="${REVIEW_TARGET#*$'\t'}"
  if [ -n "$REVIEW_REPO" ] && [ -d "$ATHENA_DIR/repos/$REVIEW_REPO" ]; then
    REPO_DIR="$ATHENA_DIR/repos/$REVIEW_REPO"
    [ -z "$WORKDIR" ] && WORKDIR="${REVIEW_CWD:-$REPO_DIR}"
  fi
fi

WORKDIR="${WORKDIR:-$ATHENA_DIR}"
[ -d "$WORKDIR" ] || { echo "디렉터리가 없다: $WORKDIR"; exit 2; }
# 상대 경로면 절대 경로로 — 실행기는 pane 의 시작 폴더(이미 그 폴더)에서 다시 cd 하므로 상대 경로는 어긋난다.
# 실제 경로로 푼다 — 본체의 repos/·.worktrees 는 여러 팩 구조에서 지금 팩을 가리키는 링크라, 링크 경로로 Work ref 에 적으면 팩을 갈아 끼운 뒤 다른 팩을 가리킨다
WORKDIR="$(cd "$WORKDIR" && pwd -P)"

# 역할마다 모델(팩 pack.json "models" · scripts/lib/models.mjs · athena_config.agent_model) — 프로필 frontmatter model: 이 있으면 그 값(프로필이 이긴다).
# 그 밖의 에이전트는 경량 계획서(plans/task/…)면 agentLight(값 없으면 agent) · 정식이면 agent. reviewer 는 이 계획서의 같은 레포 · 브랜치
# "- Review result:" 가 수정 필요면 reviewerEscalated(값 없으면 reviewer) · 아니면 reviewer(계획서 2026-10-29 D1 · D2). 레포 · 브랜치는 띄울 작업 트리(WORKDIR)로 고른다.
# 값이 다 없으면 지금처럼 기본 모델 · 형식이 이상하면 띄우지 않는다(기본 모델로 몰래 돌지 않게)
MODEL="$(python3 - "$ATHENA_DIR" "$AGENT" "$PLAN" "$WORKDIR" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import agent_model
try:
    print(agent_model(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]))
except ValueError as error:
    print(error, file=sys.stderr); sys.exit(1)
PYEOF
)" || { echo "모델 설정이 이상해서 띄우지 않는다 — 팩 pack.json \"models\" 를 고친다(docs/pack.md \"pack.json\")" >&2; exit 2; }

if ! "$SCREEN" inside; then
  echo "$("$SCREEN" name) 밖입니다. 직접 실행하세요:"
  MODEL_HINT="${MODEL:+ --model $MODEL}"
  if [ -n "$PROMPT" ]; then echo "  (cd $WORKDIR && claude --agent $AGENT$MODEL_HINT \"$PROMPT\")"
  else echo "  (cd $WORKDIR && claude --agent $AGENT$MODEL_HINT)"; fi
  exit 1
fi

if [ -z "$REUSE_PANE" ]; then   # ── 새 pane 을 띄우는 길 (끝은 아래 else — 쉬는 pane 에 이어 보내는 길)
# 배치: workspace = 레포 / 그 안의 한 탭에 pane 을 나란히.
# 작업(워크트리)마다 탭을 가르지 않는다. 한 화면에서 동시 작업 상황이 다 보이는 쪽이 낫다.
# --here 이거나 담당 레포가 없으면(reviewer 등) 지금 탭에서 쪼갠다.
PLACEMENT=""
PANE=""
if [ "$HERE" = 0 ] && [ -n "$REPO_DIR" ]; then
  REPO_NAME="$(basename "$REPO_DIR")"

  WS="$("$SCREEN" workspace list 2>/dev/null | python3 -c "
import sys, json
try: rows = json.load(sys.stdin)['workspaces']
except Exception: sys.exit()
for w in rows:
    if w.get('label') == '$REPO_NAME': print(w['id']); break
")"

  if [ -z "$WS" ]; then
    # 새로 만들면 기본 탭이 하나 딸려 온다. 그 탭을 그대로 쓴다 (빈 탭을 남기지 않는다)
    # workspace 폴더는 레포 메인 체크아웃(실제 경로) — 이 작업의 워크트리로 만들면 작업이 끝나 워크트리를 지운 뒤
    # 그 workspace 의 Explorer 가 없는 폴더를 본다(2026-10-28 w47). pane 은 실행기가 워크트리로 cd 하니 그대로 워크트리에서 돈다
    WS_DIR="$(cd "$REPO_DIR" && pwd -P)" || WS_DIR="$WORKDIR"
    CREATED="$("$SCREEN" workspace create --label "$REPO_NAME" --cwd "$WS_DIR" --no-focus 2>/dev/null)"
    WS="$(printf '%s' "$CREATED" | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['workspace']['id'])
except Exception: pass
")"
    TAB="$(printf '%s' "$CREATED" | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['workspace']['active_tab_id'])
except Exception: pass
")"
    if [ -n "$TAB" ]; then
      "$SCREEN" tab rename "$TAB" "$REPO_NAME" >/dev/null 2>&1 || true
      PANE="$("$SCREEN" pane list 2>/dev/null | python3 -c "
import sys, json
for p in json.load(sys.stdin)['panes']:
    if p.get('tab_id') == '$TAB': print(p['id']); break
")"
      PLACEMENT="새 workspace '$REPO_NAME'"
    fi
  else
    # 이미 있으면 그 workspace 의 활성 탭에 pane 을 덧붙인다
    TAB="$("$SCREEN" workspace get "$WS" 2>/dev/null | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['workspace']['active_tab_id'])
except Exception: pass
")"
    # 나눌 자리 — 그 탭에서 가장 큰 pane(cols×rows)을 긴 쪽으로 반 나눈다. 늘 첫 pane 만 오른쪽으로 쪼개면
    # 맨 왼쪽만 가늘어지고 아래가 빈다(2026-10-28). 글자 칸은 세로가 가로의 약 2배라(터미널 13px · 줄 높이 1 —
    # D2Coding 반각 0.5em ≈ 6.5px × 줄 ≈ 15px · SF Mono 0.6em ≈ 7.8px) 화면에서 가로가 긴지는 cols 와 rows×2 로 본다.
    # 2개면 좌우 · 3~4개면 바둑판에 가깝다. --down 을 주면 방향은 그것 · 크기를 모르면(옛 데몬) 예전처럼 첫 pane 을 오른쪽으로
    PICK="$("$SCREEN" pane list 2>/dev/null | python3 -c "
import sys, json
try: panes = [p for p in json.load(sys.stdin)['panes'] if p.get('tab_id') == '$TAB']
except Exception: sys.exit()
if not panes: sys.exit()
size = lambda p: (p.get('cols'), p.get('rows'))
known = all(isinstance(c, int) and isinstance(r, int) and c > 0 and r > 0 for c, r in map(size, panes))
if not known:
    print(panes[0]['id'], ''); sys.exit()
best = max(panes, key=lambda p: p['cols'] * p['rows'])   # 같으면 앞의 것
print(best['id'], 'right' if best['cols'] >= best['rows'] * 2 else 'down')
")"
    BASE="${PICK%% *}"; AUTO_DIR="${PICK#* }"
    [ "$DIR_GIVEN" = 0 ] && [ -n "$AUTO_DIR" ] && DIR="$AUTO_DIR"
    if [ -n "$BASE" ]; then
      PANE="$("$SCREEN" pane split --target "$BASE" --direction "$DIR" --ratio 0.5 --cwd "$WORKDIR" --no-focus 2>/dev/null | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['pane']['id'])
except Exception: pass
")"
      COUNT="$("$SCREEN" pane list 2>/dev/null | python3 -c "
import sys, json
print(sum(1 for p in json.load(sys.stdin)['panes'] if p.get('tab_id') == '$TAB'))
")"
      PLACEMENT="workspace '$REPO_NAME' (pane ${COUNT}개째)"
    fi
  fi
fi

# 위에서 못 만들었으면(또는 --here) 지금 탭에서 쪼갠다 — 이 스크립트를 부른 pane 옆(--target self).
# 포커스된 pane 을 쓰면 뒤에서 부른 에이전트의 reviewer 가 사용자가 보던 다른 탭(아테나 탭)에 뜬다(2026-10-26 실측).
# 부른 pane 을 모르면(환경 없음) 화면 계층이 포커스된 pane 으로 대신한다
if [ -z "$PANE" ]; then
  OUT="$("$SCREEN" pane split --target self --direction "$DIR" --ratio 0.5 --cwd "$WORKDIR" --no-focus)" \
    || { echo "pane split 실패: $OUT"; exit 1; }
  PANE="$(printf '%s' "$OUT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pane"]["id"])')" \
    || { echo "pane id 파싱 실패"; exit 1; }
  PLACEMENT="${PLACEMENT:-현재 탭}"
fi
sleep 1

# `pane run`(화면 계층)은 인자를 따옴표 없이 셸 명령줄로 이어붙인다.
# 프롬프트를 그대로 넘기면 공백에서 단어가 쪼개지고 ( ) ! * 가 셸에 먹혀
# 에이전트가 엉뚱한 프롬프트를 받는다(실제로 겪음). 그래서 러너 스크립트 한 개만 넘긴다.
PROMPT_FILE="$(mktemp -t hermes-prompt)" || { echo "mktemp 실패"; exit 1; }
RUNNER="$(mktemp -t hermes-runner)"      || { rm -f "$PROMPT_FILE"; echo "mktemp 실패"; exit 1; }
printf '%s' "$PROMPT" > "$PROMPT_FILE"   || { rm -f "$PROMPT_FILE" "$RUNNER"; echo "프롬프트 쓰기 실패"; exit 1; }

# 워크트리는 별도 git 레포라 Claude Code 가 hermes 의 .claude/agents·rules·AGENTS.md 를 못 찾는다
# (2026-09-23 실측 — `--agent '<이름>' not found`). hermes 밖 git 레포에서 띄울 때는
# 정의·공통 규칙을 직접 넘기고, 상태바·검증 스크립트가 메인 체크아웃 대신 워크트리를 보게 한다.
WORK_TOP="$(git -C "$WORKDIR" rev-parse --show-toplevel 2>/dev/null)"
ATHENA_REAL="$(cd "$ATHENA_DIR" && pwd -P)"
# 실행기에 넣는 값은 모두 printf %q 로 감싼다 — 작은따옴표로 바로 넣으면 경로에 ' 가 있을 때 실행기가 깨진다
shq() { printf '%q' "$1"; }
CLAUDE_ARGS="--agent $(shq "$AGENT")"
[ -n "$MODEL" ] && CLAUDE_ARGS="$CLAUDE_ARGS --model $(shq "$MODEL")"
EXTRA_FILES=""
# 여러 팩 구조 — 본체의 pack · plans · issues 는 데이터 폴더(<데이터>/packs/<id>/…)로 가는 링크라 실제 경로가 본체 밖이다.
# 그 실제 경로도 허용 폴더로 줘야 계획서 쓰기 · 지식(docs/knowledge/<레포> → pack/…) 읽기에서 권한을 묻고 멈추지 않는다(2026-10-25 시험).
# 링크가 아니거나(옛 구조) 본체 안으로 풀리면 더하지 않는다
LINK_DIRS=""
for name in pack plans issues; do
  [ -L "$ATHENA_DIR/$name" ] || continue
  real="$(cd "$ATHENA_DIR/$name" 2>/dev/null && pwd -P)" || continue
  case "$real/" in "$ATHENA_REAL"/*) continue ;; esac
  LINK_DIRS="$LINK_DIRS --add-dir $(shq "$real")"
done
# git 레포가 아닌 폴더도 본체 밖이면 같은 길로 — 그 폴더에서는 본체의 CLAUDE.md · AGENTS.md 가 자동으로 실리지 않아
# 공통 규칙을 직접 넘기지 않으면 에이전트가 계획서 지시문만 보고 일한다(지시문은 공통 규칙에 있는 것을 다시 싣지 않는다 · 2026-10-29)
CTX_TOP="$WORK_TOP"
if [ -z "$CTX_TOP" ]; then
  case "$WORKDIR/" in "$ATHENA_REAL"/*) ;; *) CTX_TOP="$WORKDIR" ;; esac
fi
if [ -n "$CTX_TOP" ] && [ "$(cd "$CTX_TOP" && pwd -P)" != "$ATHENA_REAL" ]; then
  AGENTS_JSON="$(mktemp -t hermes-agents)" && CONTEXT_FILE="$(mktemp -t hermes-context)" && SETTINGS_FILE="$(mktemp -t hermes-settings)" \
    && python3 "$ATHENA_DIR/scripts/agent-context.py" "$AGENT" "$ATHENA_DIR" "$CTX_TOP" "$AGENTS_JSON" "$CONTEXT_FILE" "$SETTINGS_FILE" \
    || { rm -f "$PROMPT_FILE" "$RUNNER" "${AGENTS_JSON:-}" "${CONTEXT_FILE:-}" "${SETTINGS_FILE:-}"; echo "에이전트 컨텍스트 생성 실패"; exit 1; }
  CONTEXT_CHARS="$(char_count "$CONTEXT_FILE")"
  EXTRA_FILES="$(shq "$AGENTS_JSON") $(shq "$CONTEXT_FILE") $(shq "$SETTINGS_FILE")"
  CLAUDE_ARGS="--agents \"\$(cat $(shq "$AGENTS_JSON"))\" $CLAUDE_ARGS --add-dir $(shq "$ATHENA_DIR")$LINK_DIRS --append-system-prompt-file $(shq "$CONTEXT_FILE") --settings $(shq "$SETTINGS_FILE")"
  REPO_DIR="$CTX_TOP"
else
  # hermes 안에서 띄워도 보호 훅을 건다 — FE 는 commit-guard(git commit 직접·add -A → commit.sh, push·gh pr 차단) + secret-guard,
  # reviewer 는 secret-guard 만(토큰·키 값은 어떤 세션에서도 출력하지 않는다)
  SETTINGS_FILE="$(mktemp -t hermes-settings)" || { rm -f "$PROMPT_FILE" "$RUNNER"; echo "mktemp 실패"; exit 1; }
  # 훅 목록은 agent-context.py 와 같은 한 곳 — scripts/lib/agent_hooks.py (보호 훅 · 고르기 질문 → 요청 · pane 기록 · 끝 알림 · 자동 압축 시점. reviewer 는 읽기 전용이라 일부 제외)
  python3 "$ATHENA_DIR/scripts/lib/agent_hooks.py" inline "$SETTINGS_FILE" "$ATHENA_DIR" "$AGENT" \
    || { rm -f "$PROMPT_FILE" "$RUNNER" "$SETTINGS_FILE"; echo "에이전트 훅 설정 생성 실패"; exit 1; }
  EXTRA_FILES="$(shq "$SETTINGS_FILE")"
  CLAUDE_ARGS="$CLAUDE_ARGS$LINK_DIRS --settings $(shq "$SETTINGS_FILE")"
fi
# 에이전트 창은 MCP 서버를 싣지 않는다(--mcp-config 없는 --strict-mcp-config = 사용자 전역 · 플러그인 · claude.ai 커넥터 MCP 모두 제외).
# 창마다 도구 목록 · 서버 안내문이 매 답에 붙는 토큰을 줄인다. 아테나 본체 세션은 이 스크립트를 거치지 않아 그대로.
# reviewer 는 Jira · Confluence(Atlassian 커넥터)를 읽을 수 있어야 해서 제외한다(.claude/agents/reviewer.md tools)
[ "$AGENT" != reviewer ] && CLAUDE_ARGS="$CLAUDE_ARGS --strict-mcp-config"
[ -n "${RESUME:-}" ] && CLAUDE_ARGS="$CLAUDE_ARGS --resume $(shq "$RESUME")"

# 팩 훅(설정 hooks.delegateEnv) — 에이전트마다 실행기에 넣을 export 줄을 팩이 정한다(회사 레포 고유 환경값).
# 인자: <에이전트> <아테나 폴더>. 출력 줄을 그대로 실행기에 넣는다
PACK_ENV=""
DELEGATE_HOOK="$(python3 - "$ATHENA_DIR" <<'PYEOF'
import os, sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
cfg = load(sys.argv[1]); hook = (cfg.get('hooks') or {}).get('delegateEnv', '')
if hook: print(os.path.join(cfg.get('packDir') or sys.argv[1], hook))
PYEOF
)"
[ -n "$DELEGATE_HOOK" ] && [ -x "$DELEGATE_HOOK" ] && PACK_ENV="$("$DELEGATE_HOOK" "$AGENT" "$ATHENA_DIR")"

# exec 를 쓰지 않는다. exec 는 셸을 교체해 EXIT trap 이 돌지 않아 임시 파일이 남는다.
{
  echo '#!/usr/bin/env bash'
  echo "cleanup() { rm -f $(shq "$PROMPT_FILE") $(shq "$RUNNER") $EXTRA_FILES; }"
  echo 'trap cleanup EXIT INT TERM'
  echo "cd $(shq "$WORKDIR") || exit 1"
  [ -n "$REPO_DIR" ] && echo "export ATHENA_REPO_DIR=$(shq "$REPO_DIR")"
  echo "export ATHENA_AGENT=$(shq "$AGENT")"
  # 다음 말 추천(입력 칸의 흐린 글)을 끈다 — 끝난 pane 의 추천 글을 아테나가 사용자가 쓰다 만 글로 봐 닫지 못했다(2026-10-30). Claude Code 공식 환경 변수(env-vars 문서). 사람이 쓰는 아테나 세션은 이 스크립트를 거치지 않아 그대로
  echo "export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false"
  # 계획서 — pane ↔ 대화 기록 훅이 적는다(팩 백업이 되살릴 때 delegate.sh --plan 으로)
  echo "export ATHENA_PLAN=$(shq "$PLAN")"
  # 여러 팩 — 어느 팩·세대에서 띄웠는지(현황판·학습 검토가 이전 팩 작업을 가려낼 때 쓴다)
  [ -n "${PACK_ID:-}" ] && echo "export ATHENA_PACK_ID=$(shq "$PACK_ID") ATHENA_SWITCH_GEN=$(shq "${PACK_GEN:-0}")"
  # git 레포가 아닌 폴더(WORK_TOP 빈 값)는 빈 경로를 넘기지 않는다 — 검증 스크립트는 메인 체크아웃 기본값대로
  [ -n "$EXTRA_FILES" ] && [ -n "$WORK_TOP" ] && echo "export ATHENA_VERIFY_DIR=$(shq "$WORK_TOP")"
  [ -n "$PACK_ENV" ] && printf '%s\n' "$PACK_ENV"
  if [ -n "$PROMPT" ]; then
    echo "claude $CLAUDE_ARGS \"\$(cat $(shq "$PROMPT_FILE"))\""
  else
    echo "claude $CLAUDE_ARGS"
  fi
  echo 'exit $?'
} > "$RUNNER"
chmod +x "$RUNNER" || { rm -f "$PROMPT_FILE" "$RUNNER"; echo "chmod 실패"; exit 1; }

if ! "$SCREEN" pane run "$PANE" "$(shell_line "$RUNNER")" >/dev/null; then   # 셸 한 줄 — TMPDIR 에 띄어쓰기가 있어도
  rm -f "$PROMPT_FILE" "$RUNNER"
  echo "pane 실행 실패 (pane $PANE)"; exit 1
fi
else   # ── 쉬는 같은 레포 pane 에 이어 보내기 (docs/dispatch.md "이어 보내기")
  [ -z "${RESUME:-}" ] || { echo "--reuse-pane 은 --resume 과 같이 쓰지 않는다" >&2; exit 2; }
  [ "$AGENT" != reviewer ] || { echo "reviewer 는 이어 보내지 않는다(리뷰마다 새 pane)" >&2; exit 2; }
  # 보내기 직전에 다시 확인 — 고른 뒤 사용자가 그 pane 을 보기 시작했거나 질문 창이 떴을 수 있다. 같은 pane 이 아니면 보내지 않는다
  PICKED="$(node "$ATHENA_DIR/scripts/reuse-pane.mjs" --agent "$AGENT" 2>&1)" || { echo "이어 보낼 수 없다: $PICKED" >&2; exit 1; }
  PICKED_PANE="$(printf '%s' "$PICKED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pane"])' 2>/dev/null)"
  [ "$PICKED_PANE" = "$REUSE_PANE" ] || { echo "그 pane($REUSE_PANE)은 지금 이어 보낼 수 없다(쉬는 pane: ${PICKED_PANE:-없음}) — 새로 띄우거나 다시 고른다" >&2; exit 1; }
  PANE="$REUSE_PANE"; PLACEMENT="쉬는 pane 에 이어 보냄"
  WORKDIR="$(printf '%s' "$PICKED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["cwd"])')"
  [ -z "$GIVEN_CWD" ] || [ "$(cd "$GIVEN_CWD" 2>/dev/null && pwd -P)" = "$WORKDIR" ] || { echo "--cwd($GIVEN_CWD)가 그 pane 의 작업 폴더($WORKDIR)와 다르다" >&2; exit 2; }
  GIVEN_CWD="$WORKDIR"
  # 앞 작업이 안 끝났을 수 있다 — 미커밋 변경이 있으면 새 브랜치를 따지 않는다(앞 PR 이 열려 있으면 같은 브랜치에 이어 쓴다)
  if [ -n "$NEW_BRANCH" ]; then
    [ -z "$(git -C "$WORKDIR" status --porcelain 2>/dev/null)" ] || { echo "그 워크트리에 미커밋 변경이 있어 새 브랜치를 따지 않는다 — 앞 작업을 먼저 끝낸다" >&2; exit 1; }
    PR_BASE="$(python3 - "$ATHENA_DIR" "$AGENT" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
cfg = load(sys.argv[1]); agent = sys.argv[2]
for repo in cfg['repos']:
    if agent in (repo.get('agents') or []) or agent == repo.get('packagesAgent') or any(app.get('agent') == agent for app in (repo.get('apps') or {}).values()):
        if repo.get('direct'): break
        print(repo.get('prBase') or repo.get('branch') or ''); break
PYEOF
)"
    [ -n "$PR_BASE" ] || { echo "이 레포의 prBase 를 모르거나 main 직접 레포라 새 브랜치를 따지 않는다" >&2; exit 1; }
    git -C "$WORKDIR" fetch origin "$PR_BASE" >/dev/null 2>&1 || { echo "origin/$PR_BASE 를 가져오지 못했다" >&2; exit 1; }
    git -C "$WORKDIR" switch -c "$NEW_BRANCH" "origin/$PR_BASE" >/dev/null 2>&1 || { echo "새 브랜치($NEW_BRANCH)를 만들지 못했다(이미 있는 이름이거나 워크트리 상태 확인)" >&2; exit 1; }
  fi
  BRANCH_NOW="$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  # pane 에는 처음 띄울 때의 긴 지시(커밋 · 리뷰 · 보고 규칙)가 이미 있다 — 새 계획서만 짧게 알린다. 줄바꿈 없이 한 줄(Enter 한 번에 한 지시)
  REUSE_MSG="[아테나${LEAD_PANE:+ $LEAD_PANE} → $AGENT] 새 요청 — 새 계획서: $ATHENA_DIR/$PLAN . 앞 계획서와 별개다: 먼저 읽고 Checkpoint 의 Next 부터, Status·Progress·결과는 이 계획서에 쓰고(Validation 은 검증 스크립트가 이 계획서에 적는다) commit.sh · ship.sh 의 --plan 도 이 계획서다(앞 계획서는 더 고치지 않는다). 작업 폴더 $WORKDIR · 브랜치 ${BRANCH_NOW:-?}. 시작 전에 Status 를 in_progress 로. 커밋 · PR · 보고 규칙은 처음 받은 지시 그대로. ${REVIEW_RULE}"
  if [ -n "$RAW_PROMPT" ]; then REUSE_MSG="${REUSE_MSG}요청: $RAW_PROMPT"; else REUSE_MSG="${REUSE_MSG}계획서 '## 지시' 절이 요청이다 — 비어 있으면 사용자 요청을 기다린다."; fi
  # 한 줄로 — 줄바꿈이 있으면 Enter 로 여러 번 나뉘어 들어간다
  REUSE_MSG="$(printf '%s' "$REUSE_MSG" | tr '\n' ' ')"
  # 묶음 갱신을 먼저 — 지시를 보내면 pane-session.py 훅이 곧바로 돌아 기록을 읽는다(같은 잠금 · scripts/lib/reuse_link.py).
  # pane 기록의 계획서를 새 계획서로(훅이 처음 환경 값으로 덮지 않게 envPlan 을 남긴다). 보내기가 실패하면 되돌린다
  OLD_PLAN="$(python3 - "$ATHENA_DIR" "$PANE" <<'PYEOF'
import json, pathlib, sys
pack_data = pathlib.Path(sys.argv[1]) / '.pack-data'
path = pack_data.resolve() / 'state' / 'pane-sessions' / f'{sys.argv[2]}.json' if pack_data.is_symlink() else None
try:
    print(json.loads(path.read_text(encoding='utf-8')).get('plan') or '')
except Exception:
    print('')
PYEOF
)"
  UNDO="$(python3 "$ATHENA_DIR/scripts/lib/reuse_link.py" link "$ATHENA_DIR" "$PANE" "$PLAN")" || { echo "pane 기록을 새 계획서로 잇지 못해 보내지 않는다" >&2; exit 1; }
  if ! "$SCREEN" pane send-text "$PANE" "$REUSE_MSG" --enter >/dev/null; then
    python3 "$ATHENA_DIR/scripts/lib/reuse_link.py" rollback "$ATHENA_DIR" "$PANE" "$UNDO" || true
    echo "pane $PANE 에 보내지 못했다(pane 기록은 되돌렸다)" >&2; exit 1
  fi
  # 앞 계획서 Work ref 에서 '· pane <id> (<에이전트>)' 꼬리를 뗀다 — 지운 줄은 pane 이 안 적힌 줄이 돼 다시 묶이지 않는다
  if [ -n "$OLD_PLAN" ] && [ "$OLD_PLAN" != "$PLAN" ] && [ -f "$ATHENA_DIR/$OLD_PLAN" ]; then
    python3 - "$ATHENA_DIR" "$PANE" "$AGENT" "$OLD_PLAN" <<'PYEOF'
import pathlib, re, sys
athena, pane, agent, old_plan = sys.argv[1:5]
sys.path.insert(0, athena + '/scripts/lib'); from plan_update import update_plan
update_plan(str(pathlib.Path(athena) / old_plan), lambda text: re.sub(rf' · pane {re.escape(pane)} \({re.escape(agent)}\)', '', text))
PYEOF
  fi
fi
# pane 이름에 실제 브랜치를 적는다. 나란히 놓였을 때 어느 작업인지 이름만 보고 알아야 한다.
# 워크트리 폴더명이 아니라 git 이 말하는 브랜치를 쓴다 — 메인 체크아웃에서 열면
# 폴더명은 레포 이름이라 아무것도 알려주지 않는다.
# 브랜치는 **에이전트가 만질 레포**에서 읽는다.
# --cwd 를 주지 않으면 cwd 가 hermes 루트라, 거기서 읽으면 hermes 의 브랜치가 나온다(엉뚱하다).
# verify 스크립트가 hermes 루트 기준이라 cwd 자체는 그대로 두고 읽는 곳만 바꾼다.
BRANCH_FROM="${GIVEN_CWD:-${REPO_DIR:-$WORKDIR}}"
BRANCH_NAME="$(git -C "$BRANCH_FROM" rev-parse --abbrev-ref HEAD 2>/dev/null)"
PANE_TITLE="🤖 $AGENT"
[ -n "$BRANCH_NAME" ] && [ "$BRANCH_NAME" != "HEAD" ] && PANE_TITLE="$PANE_TITLE · $BRANCH_NAME"
"$SCREEN" pane rename "$PANE" "$PANE_TITLE" >/dev/null 2>&1 || true

# 계획서 Work ref 에 어디서 누가 도는지 적는다 — 현황판이 이 pane 을 카드에 붙인다
# 아테나 pane 에서 띄웠으면 그 pane 도 한 번만 적는다(- Lead pane:) — 앱의 아테나 pane [상세] 가 이 pane 이 맡긴 일을 모은다
ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$WORKDIR" "${BRANCH_NAME:-?}" "$PANE" "$AGENT" "$LEAD_PANE" <<'PYEOF'
import os, sys, re
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, cwd, branch, pane, agent, lead = sys.argv[1:7]
def record(text):
    text = record_ref(text)
    if lead and agent != 'reviewer':
        if not re.search(r'^- Lead pane:', text, re.M):
            text = re.sub(r'^(- Work ref:.*)$', lambda match: f'- Lead pane: {lead}\n' + match.group(1), text, count=1, flags=re.M)
        else:
            # 다시 맡길 때 아테나 pane 이 바뀌었으면 지금 값으로(같으면 그대로)
            text = re.sub(r'^- Lead pane:.*$', lambda match: f'- Lead pane: {lead}', text, count=1, flags=re.M)
    return text
def record_ref(text):
    if agent == 'reviewer':
        # 리뷰는 구현한 쪽의 Work ref 를 덮어쓰지 않는다 — 따로 Review 줄에 적는다(현황판이 이 pane 도 카드에 붙인다)
        # 띄운 시각 — review-wait.sh 가 "이 시각 뒤에 적힌 결론" 을 찾는다(기다리기를 늦게 시작해도 이미 끝난 결론을 놓치지 않게)
        stamp = __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')
        line = f"- Review: {cwd} · 🌿 {branch} · pane {pane} (reviewer) · 띄움 {stamp}"
        if re.search(r'^- Review:', text, re.M):
            text = re.sub(r'^- Review:.*$', line, text, count=1, flags=re.M)
        elif re.search(r'^- Work ref:.*$', text, re.M):
            text = re.sub(r'^(- Work ref:.*)$', lambda match: match.group(1) + '\n' + line, text, count=1, flags=re.M)
    else:
        line = f"- Work ref: {cwd} · 🌿 {branch} · pane {pane} ({agent})"
        # 에이전트마다 한 줄 — 여러 레포 계획서에서 두 번째 에이전트가 첫 에이전트의 워크트리·pane 을 덮지 않게.
        # 같은 에이전트 줄이 있으면 바꾸고, 없으면 아직 pane 이 안 적힌 자리(템플릿 줄)를 채우고, 그것도 없으면 마지막 Work ref 아래에 더한다
        refs = list(re.finditer(r'^- Work ref:.*$', text, re.M))
        mine = next((ref for ref in refs if ref.group(0).endswith(f'({agent})')), None)
        blank = next((ref for ref in refs if not re.search(r'\bpane \S+ \([\w-]+\)$', ref.group(0))), None)
        target = mine or blank
        if target:
            text = text[:target.start()] + line + text[target.end():]
        elif refs:
            text = text[:refs[-1].end()] + '\n' + line + text[refs[-1].end():]
    return text
update_plan(plan, record)
PYEOF

# 지시문 크기 — 토큰을 줄인 효과를 숫자로 본다(docs/events.md · 실패해도 띄우기는 그대로). 이어 보내기는 보낸 글, 이어 열기는 0
node "$ATHENA_DIR/scripts/lib/events.mjs" delegate plan="$PLAN" agent="$AGENT" pane="$PANE" \
  promptChars="$(printf '%s' "${REUSE_MSG:-$PROMPT}" | char_count)" contextChars="${CONTEXT_CHARS:-0}" >/dev/null 2>&1 || true

echo "$PANE  ($AGENT — 계획서 $PLAN · $PLACEMENT · cwd: $WORKDIR)"
# reviewer 결론은 pane 이 아니라 계획서 줄로 기다린다 — 끝난 reviewer pane 은 1분 뒤 저절로 닫힌다(review-result.sh)
if [ "$AGENT" = reviewer ]; then echo "   결론 기다리기: $ATHENA_DIR/scripts/review-wait.sh --plan $PLAN --dir $WORKDIR"; fi
