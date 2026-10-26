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
#   scripts/delegate.sh <에이전트명> --plan <경로> --resume <세션 id> [--cwd <워크트리>]  # 닫힌 pane 을 그 대화 그대로 다시 연다(지시문은 다시 보내지 않는다)
#
# 배치 규칙 — workspace = 레포 / 그 안의 한 탭에 pane 을 나란히
#   워크트리마다 탭을 가르지 않는다. 한 화면에서 동시 작업 상황이 다 보이는 쪽이 낫다.
#   각 pane 은 "🤖 <에이전트> · <워크트리>" 로 이름이 붙고, 하단 상태바가
#   레포·브랜치·변경 개수를 보여준다 (scripts/statusline.sh).
#   scripts/delegate.sh <에이전트명> "<프롬프트>"           # 프롬프트까지 넣어 바로 시작
#   scripts/delegate.sh <에이전트명> --cwd <경로>          # 워크트리 등 다른 디렉터리에서 연다
#   scripts/delegate.sh <에이전트명> "<프롬프트>" --down    # 오른쪽 대신 아래로 분할
#
# 에이전트명은 .claude/agents/<이름>.md 의 name 이다 (reviewer 등).
# 결과는 pane 에서 보고, 아테나는 `scripts/screen pane read <id>` 로 읽는다.
set -uo pipefail
ATHENA_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"   # 실제 경로 — 옛 폴더 이름(hermes 링크)으로 불려도 같은 값
SCREEN="$ATHENA_DIR/scripts/screen"   # 화면 계층 — workspace·탭·pane 은 이걸로만 다룬다
. "$ATHENA_DIR/scripts/lib/shell-line.sh"   # shell_line — pane run 에 넘길 셸 한 줄(띄어쓰기·한글 안전)

AGENT=""; PROMPT=""; DIR="right"; WORKDIR=""; HERE=0; PLAN=""; PLAN_NEW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan)
      if [ "${2:-}" = new ]; then [ $# -ge 3 ] || { echo "--plan new 에 요약이 없다" >&2; exit 2; }; PLAN_NEW="$3"; shift 3; else [ $# -ge 2 ] || { echo "--plan 에 경로가 없다" >&2; exit 2; }; PLAN="$2"; shift 2; fi ;;
    --down) DIR="down"; shift ;;
    --here) HERE=1; shift ;;
    --cwd)  [ $# -ge 2 ] || { echo "--cwd 에 경로가 없다" >&2; exit 2; }; WORKDIR="$2"; shift 2 ;;
    --resume) [ $# -ge 2 ] || { echo "--resume 에 세션 id 가 없다" >&2; exit 2; }; RESUME="$2"; shift 2 ;;   # 닫힌 에이전트 pane 을 그 대화 그대로 다시 연다(claude --resume <세션 id>) — 지시문은 다시 보내지 않는다
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) if [ -z "$AGENT" ]; then AGENT="$1"; else PROMPT="$1"; fi; shift ;;
  esac
done

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
  LEAD_RULE="아테나에게 넘길 일(여러 레포 작업의 push·PR, 보호 훅이 막은 merge·dev 반영, 담당 레포 밖 수정)은 사용자에게 전해 달라고 하지 말고 직접 보낸다: $SCREEN pane send-text $LEAD_PANE '[$AGENT → 아테나] <무엇을·왜 · 계획서 경로 · 사용자 지시면 그 말>' 다음 $SCREEN pane send-keys $LEAD_PANE Enter — 보냈다고 한 줄 알린다. "
else
  LEAD_RULE="아테나에게 넘길 일(여러 레포 작업의 push·PR, 보호 훅이 막은 merge·dev 반영, 담당 레포 밖 수정)은 사용자에게 전해 달라고 하지 말고 아테나 pane 에 직접 보낸다($SCREEN pane list 로 아테나 pane 을 찾아 pane send-text '[$AGENT → 아테나] …' 다음 pane send-keys Enter). 못 찾을 때만 사용자에게 알린다. "
fi
# 끝나면 저절로 PR(결정 D3 · 2026-10-25) — 담당 레포가 "autoMerge": true(main 직접 레포 제외)일 때만 지시에 싣는다.
# 켜지 않은 레포는 지금처럼 사용자가 "PR 올려줘" 할 때만
AUTO_SHIP_RULE=""
AUTO_SHIP_REPO="$(python3 - "$ATHENA_DIR" "$AGENT" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import load
cfg = load(sys.argv[1]); agent = sys.argv[2]
for repo in cfg['repos']:
    mine = agent in (repo.get('agents') or []) or agent == repo.get('packagesAgent') or any(app.get('agent') == agent for app in (repo.get('apps') or {}).values())
    if mine:
        if repo.get('autoMerge') is True and not repo.get('direct'): print(repo['name'])
        break
PYEOF
)"
if [ -n "$AUTO_SHIP_REPO" ]; then
  AUTO_SHIP_RULE="이 레포($AUTO_SHIP_REPO)는 자동 머지를 켰다(pack.json autoMerge · docs/pr-auto.md) — 레포 하나짜리 작업이면 요청을 끝내고 검증 스크립트가 통과했을 때 사용자 'PR 올려줘' 없이 위 'PR 올려줘' 흐름(①~④ — commit.sh 커밋 포함)을 묻지 않고 그대로 돈다(이미 열린 PR 이 있으면 ship.sh 가 그 브랜치에 push 만 한다). 조사만 했거나 바뀐 게 없으면 올리지 않고, 검증이 실패하면 올리지 않고 보고한다. "
fi
# 에이전트 지시 맨 앞에 계획서를 박는다 — 프롬프트 없이 열어도 계획서를 읽고 시작하게
PLAN_HEADER="이 작업의 계획서: $ATHENA_DIR/$PLAN — 먼저 읽고 Checkpoint 의 Next 부터 한다. 끝나면(또는 막히면) 그 계획서의 Status·Progress·Validation·결과 절을 채운다(Status 는 끝나면 ready_for_review, 막히면 blocked). 커밋은 사용자가 '커밋해줘' 또는 'PR 올려줘' 라고 할 때만 $ATHENA_DIR/scripts/commit.sh --plan $ATHENA_DIR/$PLAN --dir <워크트리> -m '<레포 관례 메시지>' -- <바꾼 파일>… 로 한다(git commit 직접·git add -A 금지, 거부되면 이유를 그대로 전하고 사용자에게 묻는다). 예외 하나 — '[자동 리뷰 → <나>]' 로 시작하는 지시(PR 자동 리뷰 · 레포가 autoMerge 를 켠 경우)는 그 지시대로 묻지 않고 commit.sh 로 커밋하고 그 지시의 ship.sh --auto-push 로 올린다(그 PR 브랜치에 빨리 감기만 · 새 PR 없음 · PR 본문 지적이면 --body-file <파일> 을 붙여 본문도 바꾼다 · docs/pr-auto.md). ${REVIEW_RULE}리뷰 결론이 나오면 사용자에게 보여 준다. reviewer 보고에 '결정 필요'(선택지가 갈리는 항목, R1·R2…)가 있으면 말로 묻지 말고 결정 콘솔로 보여 준다 — 계획서 md 에 '## 리뷰 뒤 결정' 절(항목·선택지·추천)을 적고, 결정 JSON 을 만들어 node $ATHENA_DIR/scripts/plan-html.mjs <계획서> --add <JSON> → $ATHENA_DIR/scripts/board.sh open <계획서> 로 연 뒤 기다린다. JSON 은 배열 [{ id:'r1', title:'R1 <제목>', desc:'<영향>', type:'single', required:true, options:[{ label:'A <선택지>', desc:'<설명>', recommended:true }, { label:'B …', desc:'…' }] }] — reviewer 의 'A <선택지>' 를 label 로 그대로 옮긴다(형식 정본 docs/plan-template.html 헤더 주석). id 가 이미 있으면 --add 가 다음 번호(r3…)로 바꿔 알려 준다. 사용자가 [이대로 진행] 하면 '[작업계획서 결정사항 확정]' 프롬프트가 이 pane 으로 온다(사용자가 대화로 '추천대로'·'R1 은 B' 처럼 답해도 같다 — 콘솔을 다시 누르라고 하지 않는다) → md '리뷰 뒤 결정' 절에 확정값을 적고 node $ATHENA_DIR/scripts/plan-html.mjs <계획서> --decide r1='<고른 label>' [r2='…'] 로 콘솔에 확정을 기록한다(--data 로 PLAN 전체를 바꾸지 않는다 — 기존 결정이 지워진다). 그다음 고치고, ${REVIEW_AGAIN}'결정 필요' 없이 수정 필요(고칠 방법이 하나)만 있으면 묻지 않고 고친 뒤 무엇을 고쳤는지 한 줄씩 알린다. 사용자가 '리뷰해줘' 라고 할 때도 같다: $ATHENA_DIR/scripts/delegate.sh reviewer --cwd <워크트리> --here --plan $ATHENA_DIR/$PLAN 로 옆에 reviewer pane 을 띄운다(직접 리뷰하지 않는다 — reviewer 가 결론을 계획서 '- Review result:' 줄에 남기고, ship.sh 미리보기에 나온다). 사용자가 'PR 올려줘' 라고 하면 한 번에 끝까지 간다 — 묻지 않는다: ① 커밋 안 된 내 작업 파일이 있으면 commit.sh 로 먼저 커밋 ② $ATHENA_DIR/scripts/ship.sh --plan $ATHENA_DIR/$PLAN --dir <워크트리> 미리보기로 초안을 받고 ③ 작업 내용(계획서 · diff)을 보고 제목(type(범위): 티켓 요약)과 본문 초안 파일을 정리한 뒤 ④ --base <미리보기의 기본 base(prBase) 하나> --title '…' --yes 로 보낸다(리뷰 줄이 ⚠️ 면 --no-review-ok 를 붙이고 그 사실을 본문 '확인 필요' 와 보고에 적는다). 다른 base 는 사용자가 말했을 때만. main 직접 레포(PR 없이 기준 브랜치에 바로 push)는 지금처럼 미리보기를 보여 주고 확인받는다. git push·gh pr create 직접 금지, 거부되면 이유를 그대로 전한다. 여러 레포에 걸친 작업이면 ship.sh 가 거부한다 — 아테나에게 직접 요청한다(아래). ${AUTO_SHIP_RULE}추측으로 구현하지 않는다 — 코드만 보고는 알 수 없는 사실(외부 계약·API 응답 모양·필드·제품 정책·기본 동작)은 먼저 코드를 읽고 돌려 보며 확인하고, 그래도 모르면 그 부분만 멈추고 계획서 Blocked 에 적은 뒤 모르는 것을 모아 한 번에 묻는다(무엇을 모르는지 · 어디까지 확인했는지 · 필요한 것 · 추천안 — 더 할 일이 없으면 Status 를 blocked 로). 그럴듯한 임시값을 넣고 나중에 알리지 않는다. 기존 패턴·코딩 규칙에서 나오는 평범한 선택(이름·스타일 값·문구 표현·테스트용 가짜 데이터)은 묻지 않고, 계약은 다른 팩 레포(백엔드 등)라도 읽어서 확인한다(고치는 것만 담당 밖 금지). 사용자가 추천대로·알아서 해라고 하면 사용자가 정할 선택(표시 형식·문구·제품 동작)만 그 말로 정하고 계획서에 적는다 — 사실(필드가 있는지·이름·단위)은 그 말로 확인되지 않으니 확인하고, 추천안을 확인 안 된 사실 위에 세우지 않는다. ${LEAD_RULE}보고는 무엇이 달라졌나 · 어디서 확인하나 · 검증 결과 · 남은 일 순으로 짧고 쉬운 말로(검증 표는 계획서 Validation 에), 시키지 않은 문구·기능은 더하지 않는다. 로그인·인증처럼 사람이 해야 하는 단계면 멈추고 무엇을 어디서 할지 알린다. 요청을 여러 번 주고받는다 — 새 요청을 받을 때마다 작업을 시작하기 전에 Status 를 in_progress 로 되돌리고, 그 요청이 끝나면 다시 ready_for_review 로 바꾼다. Progress 에는 요청마다 한 줄씩 더한다. 토큰·키·비밀번호 값은 무조건 출력 금지 — .npmrc·.env·키 파일 읽기(git show/diff 포함)·npm/pnpm config get·printenv·echo \$…TOKEN·gh auth token 모두. 확인은 있는지·참조 형태·HTTP 상태 코드만, 봐야 하면 sed 로 가린 뒤. 노출되면 즉시 멈추고 알린다(AGENTS.md 5절, secret-guard 훅). 무거운 명령(pnpm install·next build·next dev·tsc·test·relay·pkg:link·docker build)은 앞에 $ATHENA_DIR/scripts/heavy.sh 를 붙여 한 대에 하나씩, 부하를 보며 돌린다(검증 스크립트·commit.sh 는 알아서 줄을 선다). 기다리는 동안은 코드 작업을 먼저 하고, next dev 는 확인이 끝나면 바로 끈다. "
if [ "$AGENT" = reviewer ]; then
  # reviewer 는 커밋·PR·Status 를 다루지 않는다 — 에이전트용 머리말 대신 리뷰 머리말만 싣는다
  PLAN_HEADER="리뷰할 계획서: $ATHENA_DIR/$PLAN — 읽기 전용으로 리뷰한다(코드·계획서 본문을 고치지 않는다). 대상 트리는 지금 작업 디렉토리다. 리뷰를 마치면 결론을 $ATHENA_DIR/scripts/review-result.sh --plan $ATHENA_DIR/$PLAN --dir <리뷰한 트리> --verdict 승인|수정필요 --note '<한 줄 요약>' 로 한 줄 남긴다(ship.sh 가 이 줄과 HEAD 를 대조한다). 그다음 수정 필요(고칠 방법이 하나) / 결정 필요(조사한 뒤에도 사용자가 정해야 하는 것만 — 범위·사용자 동작·외부 계약·제품 정책·데이터가 달라지는 선택. 구현 방법이 여러 개일 뿐이면 하나를 골라 수정 필요로 · R1 <제목> — <영향> 다음 줄부터 A <선택지> ★ — <설명> · B … 형식, 없으면 '결정 필요: 없음') / 제안으로 나눠 보고한다(형식 정본 .claude/agents/reviewer.md 의 보고 형식 절). 토큰·키·비밀번호 값은 무조건 출력 금지 — .npmrc·.env·키 파일 읽기(git show/diff 포함)·npm/pnpm config get·printenv·echo \$…TOKEN·gh auth token 모두. 확인은 있는지·참조 형태·HTTP 상태 코드만, 봐야 하면 sed 로 가린 뒤. 노출되면 즉시 멈추고 알린다(AGENTS.md 5절, secret-guard 훅). 무거운 명령(pnpm install·next build·next dev·tsc·test·relay·pkg:link·docker build)은 앞에 $ATHENA_DIR/scripts/heavy.sh 를 붙여 한 대에 하나씩, 부하를 보며 돌린다(검증 스크립트·commit.sh 는 알아서 줄을 선다). 기다리는 동안은 코드 작업을 먼저 하고, next dev 는 확인이 끝나면 바로 끈다. "
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
# 지시가 있든 없든(현황판 [처리 시작]도) — 범위가 커지면 멈춘다
PLAN_HEADER="${PLAN_HEADER}요청이 여러 레포·API·구조 변경으로 커지면 멈추고 정식 계획서가 필요하다고 알린다. 버그 수정이면 AGENTS.md 5절대로 재현부터 확인하고 수정 전·후를 같은 방법으로 비교한다. "
fi
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

# 역할마다 모델(팩 pack.json "models" · scripts/lib/models.mjs) — reviewer 는 reviewer, 그 밖은 agent. 프로필 frontmatter model: 이 있으면 그 값(프로필이 이긴다 · athena_config.agent_model).
# 값이 없으면 지금처럼 기본 모델 · 형식이 이상하면 띄우지 않는다(기본 모델로 몰래 돌지 않게)
MODEL="$(python3 - "$ATHENA_DIR" "$AGENT" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import agent_model
try:
    print(agent_model(sys.argv[1], sys.argv[2]))
except ValueError as error:
    print(error, file=sys.stderr); sys.exit(1)
PYEOF
)" || { echo "모델 설정이 이상해서 띄우지 않는다 — 팩 pack.json \"models\" 를 고친다(docs/pack.md \"pack.json\")" >&2; exit 2; }

WORKDIR="${WORKDIR:-$ATHENA_DIR}"
[ -d "$WORKDIR" ] || { echo "디렉터리가 없다: $WORKDIR"; exit 2; }
# 상대 경로면 절대 경로로 — 실행기는 pane 의 시작 폴더(이미 그 폴더)에서 다시 cd 하므로 상대 경로는 어긋난다.
# 실제 경로로 푼다 — 본체의 repos/·.worktrees 는 여러 팩 구조에서 지금 팩을 가리키는 링크라, 링크 경로로 Work ref 에 적으면 팩을 갈아 끼운 뒤 다른 팩을 가리킨다
WORKDIR="$(cd "$WORKDIR" && pwd -P)"

if ! "$SCREEN" inside; then
  echo "$("$SCREEN" name) 밖입니다. 직접 실행하세요:"
  MODEL_HINT="${MODEL:+ --model $MODEL}"
  if [ -n "$PROMPT" ]; then echo "  (cd $WORKDIR && claude --agent $AGENT$MODEL_HINT \"$PROMPT\")"
  else echo "  (cd $WORKDIR && claude --agent $AGENT$MODEL_HINT)"; fi
  exit 1
fi

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
    CREATED="$("$SCREEN" workspace create --label "$REPO_NAME" --cwd "$WORKDIR" --no-focus 2>/dev/null)"
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
    BASE="$("$SCREEN" pane list 2>/dev/null | python3 -c "
import sys, json
for p in json.load(sys.stdin)['panes']:
    if p.get('tab_id') == '$TAB': print(p['id']); break
")"
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

# 위에서 못 만들었으면(또는 --here) 지금 탭에서 쪼갠다 — 포커스된 pane 옆(--target focused)
if [ -z "$PANE" ]; then
  OUT="$("$SCREEN" pane split --target focused --direction "$DIR" --ratio 0.5 --cwd "$WORKDIR" --no-focus)" \
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
if [ -n "$WORK_TOP" ] && [ "$(cd "$WORK_TOP" && pwd -P)" != "$ATHENA_REAL" ]; then
  AGENTS_JSON="$(mktemp -t hermes-agents)" && CONTEXT_FILE="$(mktemp -t hermes-context)" && SETTINGS_FILE="$(mktemp -t hermes-settings)" \
    && python3 "$ATHENA_DIR/scripts/agent-context.py" "$AGENT" "$ATHENA_DIR" "$WORK_TOP" "$AGENTS_JSON" "$CONTEXT_FILE" "$SETTINGS_FILE" \
    || { rm -f "$PROMPT_FILE" "$RUNNER" "${AGENTS_JSON:-}" "${CONTEXT_FILE:-}" "${SETTINGS_FILE:-}"; echo "에이전트 컨텍스트 생성 실패"; exit 1; }
  EXTRA_FILES="$(shq "$AGENTS_JSON") $(shq "$CONTEXT_FILE") $(shq "$SETTINGS_FILE")"
  CLAUDE_ARGS="--agents \"\$(cat $(shq "$AGENTS_JSON"))\" $CLAUDE_ARGS --add-dir $(shq "$ATHENA_DIR")$LINK_DIRS --append-system-prompt-file $(shq "$CONTEXT_FILE") --settings $(shq "$SETTINGS_FILE")"
  REPO_DIR="$WORK_TOP"
else
  # hermes 안에서 띄워도 보호 훅을 건다 — FE 는 commit-guard(git commit 직접·add -A → commit.sh, push·gh pr 차단) + secret-guard,
  # reviewer 는 secret-guard 만(토큰·키 값은 어떤 세션에서도 출력하지 않는다)
  SETTINGS_FILE="$(mktemp -t hermes-settings)" || { rm -f "$PROMPT_FILE" "$RUNNER"; echo "mktemp 실패"; exit 1; }
  GUARD_HOOKS=()
  [ "$AGENT" != reviewer ] && GUARD_HOOKS+=("$ATHENA_DIR/scripts/hooks/commit-guard.py")
  GUARD_HOOKS+=("$ATHENA_DIR/scripts/hooks/secret-guard.py")
  # 훅 명령도 셸이 읽으므로 경로를 셸 따옴표로 감싼다
  # pane ↔ 대화 기록(팩 백업이 되살릴 때 --resume) — 첫 인자
  python3 -c 'import json,shlex,sys; command=lambda path: {"type":"command","command":"python3 "+shlex.quote(path)}; json.dump({"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[command(path) for path in sys.argv[3:]]}],"SessionStart":[{"hooks":[command(sys.argv[2])]}],"UserPromptSubmit":[{"hooks":[command(sys.argv[2])]}]}}, open(sys.argv[1],"w"))' \
    "$SETTINGS_FILE" "$ATHENA_DIR/scripts/hooks/pane-session.py" "${GUARD_HOOKS[@]}"
  EXTRA_FILES="$(shq "$SETTINGS_FILE")"
  CLAUDE_ARGS="$CLAUDE_ARGS$LINK_DIRS --settings $(shq "$SETTINGS_FILE")"
fi
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
  # 계획서 — pane ↔ 대화 기록 훅이 적는다(팩 백업이 되살릴 때 delegate.sh --plan 으로)
  echo "export ATHENA_PLAN=$(shq "$PLAN")"
  # 여러 팩 — 어느 팩·세대에서 띄웠는지(현황판·학습 검토가 이전 팩 작업을 가려낼 때 쓴다)
  [ -n "${PACK_ID:-}" ] && echo "export ATHENA_PACK_ID=$(shq "$PACK_ID") ATHENA_SWITCH_GEN=$(shq "${PACK_GEN:-0}")"
  [ -n "$EXTRA_FILES" ] && echo "export ATHENA_VERIFY_DIR=$(shq "$WORK_TOP")"
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
ATHENA_DIR="$ATHENA_DIR" python3 - "$ATHENA_DIR/$PLAN" "$WORKDIR" "${BRANCH_NAME:-?}" "$PANE" "$AGENT" <<'PYEOF'
import os, sys, re
sys.path.insert(0, os.environ['ATHENA_DIR'] + '/scripts/lib'); from plan_update import update_plan
plan, cwd, branch, pane, agent = sys.argv[1:6]
def record(text):
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

echo "$PANE  ($AGENT — 계획서 $PLAN · $PLACEMENT · cwd: $WORKDIR)"
# reviewer 결론은 pane 이 아니라 계획서 줄로 기다린다 — 끝난 reviewer pane 은 1분 뒤 저절로 닫힌다(review-result.sh)
if [ "$AGENT" = reviewer ]; then echo "   결론 기다리기: $ATHENA_DIR/scripts/review-wait.sh --plan $PLAN --dir $WORKDIR"; fi
