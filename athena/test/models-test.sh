#!/usr/bin/env bash
# 역할마다 모델 시험 — 팩 pack.json "models" 읽기(scripts/lib/models.mjs · 파이썬 athena_config.model_of 가 같은 판정) ·
# delegate.sh 가 붙이는 --model(프로필 model: 이 이김 · 이상한 값이면 띄우지 않음) · 새 팩 기본값(athena init → learnReview sonnet)
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
  ["athena 는 기록만(읽어도 됨)", {"models": {"athena": "opus"}}, "athena", "opus"],
  ["빈 값", {"models": {"agent": ""}}, "agent", "ERR"],
  ["공백", {"models": {"agent": " sonnet"}}, "agent", "ERR"],
  ["따옴표", {"models": {"agent": "son\"net"}}, "agent", "ERR"],
  ["셸 글자", {"models": {"agent": "sonnet;rm"}}, "agent", "ERR"],
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
CORE="$TMP/core"; mkdir -p "$CORE/plans/task" "$CORE/.claude/agents" && cp -R scripts "$CORE/scripts"
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
config ', "models": { "agent": "son net" }'
OUT="$(run web-fe)"; CODE=$?
check "이상한 값 → 띄우지 않음(종료 2 · 이유)" '[ "$CODE" = 2 ] && printf "%s" "$OUT" | grep -q "models.agent" && ! printf "%s" "$OUT" | grep -q "claude --agent"' "종료 $CODE · $OUT"

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
