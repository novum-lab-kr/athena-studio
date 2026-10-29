#!/usr/bin/env bash
# 역할마다 모델 시험 — 팩 pack.json "models" 읽기(scripts/lib/models.mjs · 파이썬 athena_config.model_of 가 같은 판정) ·
# delegate.sh 가 붙이는 --model(프로필 model: 이 이김 · 이상한 값이면 띄우지 않음 · 경량 → agentLight · 수정 필요 다음 reviewer → reviewerEscalated) · 새 팩 기본값(athena init → learnReview sonnet)
# (PR 자동 리뷰 Claude 쪽 --model 은 test/pr-auto-test.sh 가짜 리뷰어에서 본다) — 임시 폴더 · 진짜 claude 를 부르지 않는다 · 몇 초
#
# 사용: test/models-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-models-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() {   # <이름> <조건 셸 식> [실패 때 보일 것]
  if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -n "${3:-}" ] && echo "      $3"; FAIL=1; fi
}

# 같은 사례를 JS · 파이썬에 똑같이 — 값이면 그 값, 오류면 ERR
CASES='[
  ["models 없음", {}, "agent", ""],
  ["역할 없음", {"models": {"learnReview": "sonnet"}}, "agent", ""],
  ["별칭", {"models": {"learnReview": "sonnet"}}, "learnReview", "sonnet"],
  ["전체 이름 · 긴 문맥 표시", {"models": {"prReview": "claude-sonnet-5-5[1m]"}}, "prReview", "claude-sonnet-5-5[1m]"],
  ["클라우드 이름(점 · 콜론 · @)", {"models": {"reviewer": "us.anthropic.claude-x-v1:0", "agent": "claude-x@2026"}}, "reviewer", "us.anthropic.claude-x-v1:0"],
  ["PR 자동 리뷰 두 번째 자리(Codex 없는 사람)", {"models": {"prReviewSecond": "sonnet"}}, "prReviewSecond", "sonnet"],
  ["athena 는 기록만(읽어도 됨)", {"models": {"athena": "opus"}}, "athena", "opus"],
  ["경량 작업 자리(agentLight)", {"models": {"agentLight": "sonnet"}}, "agentLight", "sonnet"],
  ["다시 리뷰 자리(reviewerEscalated)", {"models": {"reviewerEscalated": "opus"}}, "reviewerEscalated", "opus"],
  ["agentLight 를 읽어도 agent 값으로 대신하지 않음(대신 쓰기는 delegate.sh 몫)", {"models": {"agent": "opus"}}, "agentLight", ""],
  ["reviewerEscalated 이름이 이상하면 실패", {"models": {"reviewerEscalated": "op us"}}, "reviewer", "ERR"],
  ["빈 값", {"models": {"agent": ""}}, "agent", "ERR"],
  ["공백", {"models": {"agent": " sonnet"}}, "agent", "ERR"],
  ["따옴표", {"models": {"agent": "son\"net"}}, "agent", "ERR"],
  ["셸 글자", {"models": {"agent": "sonnet;rm"}}, "agent", "ERR"],
  ["끝 줄바꿈", {"models": {"agent": "sonnet\n"}}, "agent", "ERR"],
  ["문자열 아님", {"models": {"agent": 3}}, "agent", "ERR"],
  ["모르는 역할(오타)", {"models": {"learnreview": "sonnet"}}, "agent", "ERR"],
  ["models 가 배열", {"models": ["sonnet"]}, "agent", "ERR"],
  ["다른 역할 값이 이상해도 실패(몰래 넘기지 않음)", {"models": {"agent": "sonnet", "prReview": "x y"}}, "agent", "ERR"],
  ["모르는 역할 이름으로 읽기", {}, "nobody", "ERR"]
]'
echo "설정 읽기 — JS(models.mjs) · 파이썬(athena_config.model_of) 같은 판정"
JS_OUT="$(CASES="$CASES" node --input-type=module -e "
  const { modelOf, modelArgs } = await import('./scripts/lib/models.mjs')
  for (const [name, config, role] of JSON.parse(process.env.CASES)) {
    let got; try { got = modelOf(config, role) } catch { got = 'ERR' }
    console.log(name + '\t' + got)
  }
  console.log('args-none\t' + JSON.stringify(modelArgs({}, 'prReview')))
  console.log('args-some\t' + JSON.stringify(modelArgs({ models: { prReview: 'haiku' } }, 'prReview')))")"
PY_OUT="$(CASES="$CASES" python3 - "$SRC" <<'PYEOF'
import json, os, sys
sys.path.insert(0, sys.argv[1] + '/scripts/lib'); from athena_config import model_of
for name, config, role, _ in json.loads(os.environ['CASES']):
    try: got = model_of(config, role)
    except ValueError: got = 'ERR'
    print(f'{name}\t{got}')
PYEOF
)"
# 사례 순서대로 줄마다 비교(이름 · 기대 · JS · 파이썬)
WANT_OUT="$(CASES="$CASES" python3 -c 'import json,os; [print(f"{c[0]}\t{c[3]}") for c in json.loads(os.environ["CASES"])]')"
CASE_COUNT="$(printf '%s\n' "$WANT_OUT" | wc -l | tr -d ' ')"
for index in $(seq 1 "$CASE_COUNT"); do
  row="$(printf '%s\n' "$WANT_OUT" | sed -n "${index}p")"; name="${row%%$'\t'*}"; want="${row#*$'\t'}"
  js="$(printf '%s\n' "$JS_OUT" | sed -n "${index}p")"; js="${js#*$'\t'}"
  py="$(printf '%s\n' "$PY_OUT" | sed -n "${index}p")"; py="${py#*$'\t'}"
  check "$name → ${want:-(없음)}" '[ "$js" = "$want" ] && [ "$py" = "$want" ]' "JS '$js' · 파이썬 '$py'"
done
check "modelArgs — 없으면 [] · 있으면 [--model, 값]" 'printf "%s\n" "$JS_OUT" | grep -qx "args-none	\[\]" && printf "%s\n" "$JS_OUT" | grep -qx "args-some	\[\"--model\",\"haiku\"\]"' "$JS_OUT"

# ── delegate.sh — 가짜 본체(코어 scripts 복사 · 화면 밖) 에서 직접 실행 안내 줄로 붙는 --model 을 본다 ─────────
echo; echo "delegate.sh"
CORE="$TMP/core"; mkdir -p "$CORE/plans/task" "$CORE/plans/feature" "$CORE/.claude/agents" && cp -R scripts "$CORE/scripts"
printf '#!/bin/sh\ncase "$1" in inside) exit 1 ;; name) echo 가짜화면 ;; esac\nexit 0\n' > "$CORE/scripts/screen"; chmod +x "$CORE/scripts/screen"
printf -- '---\nname: web-fe\ndescription: 웹\n---\n본문\n' > "$CORE/.claude/agents/web-fe.md"
printf -- '---\nname: reviewer\ndescription: 리뷰\n---\n본문\n' > "$CORE/.claude/agents/reviewer.md"
printf -- '---\nname: own-fe\ndescription: 따로\nmodel: haiku\n---\n본문\n' > "$CORE/.claude/agents/own-fe.md"
printf -- '---\nname: inh-fe\ndescription: 따름\nmodel: inherit\n---\n본문\n' > "$CORE/.claude/agents/inh-fe.md"
printf '# 시험\n\n## Checkpoint\n- Status: in_progress\n' > "$CORE/plans/task/20261026-a.md"
config() { printf '{ "repos": [{ "name": "web", "agents": ["web-fe", "own-fe", "inh-fe"], "prBase": "main" }]%s }\n' "$1" > "$CORE/athena.config.json"; }
run() { (cd "$CORE" && env -u ATHENA_AGENT bash scripts/delegate.sh "$1" --plan plans/task/20261026-a.md 2>&1); }
config ', "models": { "agent": "sonnet", "reviewer": "opus" }'
OUT="$(run web-fe)"; check "담당 에이전트 → models.agent" 'printf "%s" "$OUT" | grep -q "claude --agent web-fe --model sonnet"' "$OUT"
OUT="$(run reviewer)"; check "reviewer → models.reviewer" 'printf "%s" "$OUT" | grep -q "claude --agent reviewer --model opus"' "$OUT"
OUT="$(run own-fe)"; check "프로필 model: 이 이김(팩 값 대신 haiku)" 'printf "%s" "$OUT" | grep -q "claude --agent own-fe --model haiku"' "$OUT"
OUT="$(run inh-fe)"; check "프로필 model: inherit 은 없는 것과 같다(팩 값)" 'printf "%s" "$OUT" | grep -q "claude --agent inh-fe --model sonnet"' "$OUT"
config ''
OUT="$(run web-fe)"; check "models 없음 → --model 안 붙임" 'printf "%s" "$OUT" | grep -q "claude --agent web-fe \"" && ! printf "%s" "$OUT" | grep -q -- "--model"' "$OUT"

# 경량 · 정식(계획서 2026-10-29 D1) — 경량 계획서면 agentLight(없으면 agent) · 정식이면 agent
printf '# 정식\n\n## Checkpoint\n- Status: in_progress\n' > "$CORE/plans/feature/20261029-b.md"
runp() { local agent="$1" plan="$2"; shift 2; (cd "$CORE" && env -u ATHENA_AGENT bash scripts/delegate.sh "$agent" --plan "$plan" "$@" 2>&1); }
config ', "models": { "agent": "opus", "agentLight": "sonnet" }'
OUT="$(runp web-fe plans/task/20261026-a.md)"; check "경량 계획서 → models.agentLight" 'printf "%s" "$OUT" | grep -q "claude --agent web-fe --model sonnet"' "$OUT"
OUT="$(runp web-fe plans/feature/20261029-b.md)"; check "정식 계획서 → models.agent" 'printf "%s" "$OUT" | grep -q "claude --agent web-fe --model opus"' "$OUT"
OUT="$(runp own-fe plans/task/20261026-a.md)"; check "경량이어도 프로필 model: 이 이김" 'printf "%s" "$OUT" | grep -q "claude --agent own-fe --model haiku"' "$OUT"
config ', "models": { "agent": "opus" }'
OUT="$(runp web-fe plans/task/20261026-a.md)"; check "경량인데 agentLight 없음 → models.agent" 'printf "%s" "$OUT" | grep -q "claude --agent web-fe --model opus"' "$OUT"
config ', "models": { "agentLight": "sonnet" }'
OUT="$(runp web-fe plans/feature/20261029-b.md)"; check "정식인데 agent 없음 → --model 안 붙임(agentLight 로 대신하지 않음)" 'printf "%s" "$OUT" | grep -q "claude --agent web-fe \"" && ! printf "%s" "$OUT" | grep -q -- "--model"' "$OUT"

# reviewer — 그 계획서의 같은 레포 · 브랜치 "- Review result:" 가 수정 필요면 reviewerEscalated(계획서 2026-10-29 D2)
# 레포 · 브랜치는 review-result.sh 와 같은 방법(repos/<이름> 링크 · 지금 브랜치)으로 --cwd 트리에서 고른다
WEB="$TMP/web"; mkdir -p "$WEB" "$CORE/repos" && ln -s "$WEB" "$CORE/repos/web"
git -C "$WEB" init -q -b main && git -C "$WEB" -c user.name=t -c user.email=t@t commit -q --allow-empty -m 처음 && git -C "$WEB" checkout -q -b feat/x
review_plan() {   # <Review result 줄들(없으면 빈 값)>
  printf '# 정식\n\n## Checkpoint\n- Status: ready_for_review\n- Review: 띄움\n%s\n' "$1" > "$CORE/plans/feature/20261029-b.md"
}
runr() { runp reviewer plans/feature/20261029-b.md --cwd "$WEB" --here; }
config ', "models": { "reviewer": "sonnet", "reviewerEscalated": "opus" }'
review_plan "- Review result: 수정 필요 @abc1234 · tree 0123456789ab · 📦 web · 🌿 feat/x · 2026-10-29 10:00 · 고칠 것"
OUT="$(runr)"; check "수정 필요 다음 → models.reviewerEscalated" 'printf "%s" "$OUT" | grep -q "claude --agent reviewer --model opus"' "$OUT"
review_plan "- Review result: 승인 @abc1234 · tree 0123456789ab · 📦 web · 🌿 feat/x · 2026-10-29 10:00"
OUT="$(runr)"; check "승인 다음 → models.reviewer" 'printf "%s" "$OUT" | grep -q "claude --agent reviewer --model sonnet"' "$OUT"
review_plan ""
OUT="$(runr)"; check "결론 줄 없음(첫 리뷰) → models.reviewer" 'printf "%s" "$OUT" | grep -q "claude --agent reviewer --model sonnet"' "$OUT"
review_plan "- Review result: 수정 필요 @abc1234 · tree 0123456789ab · 📦 web · 🌿 feat/other · 2026-10-29 10:00
- Review result: 수정 필요 @abc1234 · tree 0123456789ab · 📦 api · 🌿 feat/x · 2026-10-29 10:00"
OUT="$(runr)"; check "다른 브랜치 · 다른 레포의 수정 필요는 안 셈 → models.reviewer" 'printf "%s" "$OUT" | grep -q "claude --agent reviewer --model sonnet"' "$OUT"
config ', "models": { "reviewer": "sonnet" }'
review_plan "- Review result: 수정 필요 @abc1234 · tree 0123456789ab · 📦 web · 🌿 feat/x · 2026-10-29 10:00"
OUT="$(runr)"; check "수정 필요인데 reviewerEscalated 없음 → models.reviewer" 'printf "%s" "$OUT" | grep -q "claude --agent reviewer --model sonnet"' "$OUT"
config ''
OUT="$(runr)"; check "키가 다 없으면(수정 필요여도) → --model 안 붙임(지금과 같다)" 'printf "%s" "$OUT" | grep -q "claude --agent reviewer \"" && ! printf "%s" "$OUT" | grep -q -- "--model"' "$OUT"
OUT="$(runp web-fe plans/task/20261026-a.md)"; check "키가 다 없으면 경량도 → --model 안 붙임(지금과 같다)" 'printf "%s" "$OUT" | grep -q "claude --agent web-fe \"" && ! printf "%s" "$OUT" | grep -q -- "--model"' "$OUT"

config ', "models": { "agent": "son net" }'
OUT="$(run web-fe)"; CODE=$?
check "이상한 값 → 띄우지 않음(종료 2 · 이유)" '[ "$CODE" = 2 ] && printf "%s" "$OUT" | grep -q "models.agent" && ! printf "%s" "$OUT" | grep -q "claude --agent"' "종료 $CODE · $OUT"
config ', "models": { "agnet": "sonnet" }'
OUT="$(run own-fe)"; CODE=$?
check "프로필 model: 이 있어도 팩 models 가 이상하면 띄우지 않음" '[ "$CODE" = 2 ] && printf "%s" "$OUT" | grep -q "agnet" && ! printf "%s" "$OUT" | grep -q "claude --agent"' "종료 $CODE · $OUT"

# ── 새 팩 기본값(결정 D1) — initPack 이 pack.json 에 models.learnReview: sonnet ─────────
echo; echo "새 팩 기본값"
INIT="$TMP/init"; mkdir -p "$INIT"
node --input-type=module -e "
  const { initPack } = await import('$SRC/scripts/lib/init.mjs')
  initPack({ athenaRoot: process.argv[1], company: 'acme', repos: [{ name: 'web', branch: 'main', prBase: 'main', kind: 'single' }] })" "$INIT" >/dev/null 2>&1
check "athena init → models: { learnReview: sonnet } 만" '[ "$(python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[\"models\"]))" "$INIT/packs/acme/pack.json" 2>&1)" = "{\"learnReview\": \"sonnet\"}" ]' "$(cat "$INIT/packs/acme/pack.json" 2>&1 | head -20)"

echo
[ "$FAIL" = 0 ] && echo "models-test: 모두 통과" || echo "models-test: 실패 있음"
exit "$FAIL"
