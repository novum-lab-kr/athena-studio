#!/usr/bin/env bash
# PR 자동 리뷰 시험 — 가짜 리뷰어 실행(scripts/pr-auto.mjs runReviewers · 주 도구 · codex 설정) · 직접 실행 판정(is-main)
. "$(dirname "$0")/_pr-auto-lib.sh"   # 공통 준비 — test/_pr-auto-lib.sh (이 경로 글을 보고 검증 범위가 헬퍼를 따라간다)
# 리뷰어 하나(2026-11-08 사용자 결정 · docs/pr-auto.md "리뷰어 하나") — 주 도구 반대쪽 · 하나만 쓸 수 있으면 그것 · 같은 엔진 두 모델로 채우지 않는다
# 소스 폴더에는 주 도구 기록이 없다 → claude 를 주 도구로 보고 codex 하나
echo; echo "가짜 리뷰어(리뷰어 하나)"
CLAUDE_CALLS="$TMP/claude-calls"; : > "$CLAUDE_CALLS"
RC_ALSO='[ ! -s "$CLAUDE_CALLS" ]' run_case "기록 없음 · 둘 다 씀 → codex 하나 승인 · claude 는 부르지 않음" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok FAKE_CLAUDE_ARGS="$CLAUDE_CALLS"
run_case "codex 하나가 수정 필요 → 수정 필요(claude 승인으로 덮지 않음)" "$BIN:/usr/bin:/bin" changes
run_case "codex 하나가 돌다가 실패(시간 넘김) → Claude 로 바꾸지 않고 리뷰어 부족" "$BIN:/usr/bin:/bin" insufficient FAKE_CODEX=slow
ONLY="$TMP/only-claude"; mkdir -p "$ONLY"; cp "$BIN/claude" "$ONLY/"
run_case "codex 로그인 안 됨 → claude 하나(수정 필요)" "$BIN:/usr/bin:/bin" changes FAKE_CODEX_LOGIN=out FAKE_CLAUDE=changes
run_case "codex 로그인 안 됨 · claude 답 모양이 틀림 → 그 리뷰어 실패 → 리뷰어 부족" "$BIN:/usr/bin:/bin" insufficient FAKE_CODEX_LOGIN=out FAKE_CLAUDE=bad
run_case "둘 다 명령 없음 → 리뷰어 부족(둘 다 로그인 안 됨도 같은 길 — 쓸 수 있는 리뷰어 없음)" "/usr/bin:/bin" insufficient
PAIR_LOG="$TMP/claude-one"; : > "$PAIR_LOG"
cat > "$ONLY/claude" <<'SH'
#!/bin/sh
if [ "$1 $2" = "auth status" ]; then [ "${FAKE_CLAUDE_LOGIN:-in}" = in ]; exit $?; fi
cat > /dev/null
echo "$*" >> "$FAKE_CLAUDE_ARGS"
echo '{"is_error":false,"structured_output":{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}}'
SH
chmod +x "$ONLY/claude"
RC_ALSO='[ "$(wc -l < "$PAIR_LOG" | tr -d " ")" = 1 ] && ! grep -q -- --model "$PAIR_LOG"' \
  run_case "codex 명령 없음 → claude 하나 승인 · 한 번 · models 없으면 --model 안 붙임(같은 엔진 두 번째 모델 없음)" "$ONLY:/usr/bin:/bin" approve FAKE_CLAUDE_ARGS="$PAIR_LOG"
: > "$PAIR_LOG"
RC_ALSO='grep -q -- "-p --model sonnet " "$PAIR_LOG" && ! grep -q haiku "$PAIR_LOG" && [ "$(wc -l < "$PAIR_LOG" | tr -d " ")" = 1 ]' \
  run_case "models.prReview → claude 에 --model sonnet 한 번 · prReviewSecond(haiku)는 쓰지 않음" "$ONLY:/usr/bin:/bin" approve FAKE_CLAUDE_ARGS="$PAIR_LOG" FAKE_CONFIG='{"models":{"prReview":"sonnet","prReviewSecond":"haiku"}}'
run_case "모델 이름에 '/' 가 있어도(클라우드 이름) 임시 폴더가 경로로 안 풀림 → 승인" "$ONLY:/usr/bin:/bin" approve FAKE_CLAUDE_ARGS="$PAIR_LOG" FAKE_CONFIG='{"models":{"prReview":"vendor/claude-x"}}'
# models 이름 검사는 엔진과 상관없이 planReviewers 의 같은 modelOf · catch 를 지난다 — codex 쪽(models.prReview.codex)은 같은 길이라 하나만
run_case "claude 리뷰어 · models.prReview 이름이 이상함 → 기본 모델로 다시 하지 않고 리뷰어 부족" "$ONLY:/usr/bin:/bin" insufficient FAKE_CLAUDE_ARGS="$PAIR_LOG" FAKE_CONFIG='{"models":{"prReview":"bad name"}}'
INH_OUT="$(env PATH="$ONLY:/usr/bin:/bin" FAKE_CLAUDE_ARGS="$PAIR_LOG" "$(command -v node)" --input-type=module -e "
  const { runReviewers } = await import('./scripts/pr-auto.mjs')
  const { aggregate, inheritedResult, reviewerBrief } = await import('./scripts/lib/pr-auto.mjs')
  const results = await runReviewers('리뷰해 줘', { models: { prReview: 'x y' } }, [inheritedResult({ sha: '1234567', tree: 'abc', engine: 'claude' }, '1234567')])
  console.log(aggregate(results).verdict + ' ' + reviewerBrief(results))" 2>&1 | tail -1)"
case "$INH_OUT" in "insufficient claude:failed") echo "  ✔ models 설정 오류면 앞 리뷰 승인을 이어받아도 리뷰어 실패 → 리뷰어 부족 — $INH_OUT" ;; *) echo "  ✖ 설정 오류 + 이어받기 — $INH_OUT"; FAIL=1 ;; esac
# #29 — models.prReview.codex 가 Codex 리뷰어 모델(docs/pack.md "엔진별 값" · 고치기 전: config.toml 모델만 붙었다)
CODEX_ARGS29="$TMP/codex-args-29"; rm -f "$CODEX_ARGS29"
RC_ALSO='case " $(cat "$CODEX_ARGS29" 2>/dev/null) " in *" -m gpt-test-first "*) true ;; *) false ;; esac' \
  run_case "#29 models.prReview.codex → codex 인자에 -m gpt-test-first" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok FAKE_CODEX_ARGS="$CODEX_ARGS29" FAKE_CONFIG='{"models":{"prReview":{"codex":"gpt-test-first"}}}'
# #18 — 본체 주 도구 기록(.athena-main-tool.json) 반대쪽(임시 코어 사본 — 소스 폴더에 기록을 만들지 않는다)
MCORE="$TMP/core-main"; mkdir -p "$MCORE" && cp -R scripts "$MCORE/scripts"
main_order() { env PATH="$BIN:/usr/bin:/bin" "$@" "$(command -v node)" --input-type=module -e "
  const { planReviewers } = await import('$MCORE/scripts/pr-auto.mjs')
  const lineup = planReviewers({})
  console.log(lineup.slots.length + ' ' + lineup.note)" 2>&1 | tail -1; }
ORDER_NONE="$(main_order)"
printf '{"main":"codex"}\n' > "$MCORE/.athena-main-tool.json"; ORDER_CODEX="$(main_order)"; ORDER_CODEX_DOWN="$(main_order FAKE_CLAUDE_LOGIN=out)"
printf '{"main":"claude"}\n' > "$MCORE/.athena-main-tool.json"; ORDER_CLAUDE="$(main_order)"; ORDER_CLAUDE_DOWN="$(main_order FAKE_CODEX_LOGIN=out)"
[ "$ORDER_NONE" = "1 리뷰어 codex 하나" ] && [ "$ORDER_CLAUDE" = "$ORDER_NONE" ] && [ "$ORDER_CODEX" = "1 리뷰어 claude 하나" ] \
  && [ "$ORDER_CODEX_DOWN" = "1 리뷰어 codex 하나 — Claude 로그인 안 됨" ] && [ "$ORDER_CLAUDE_DOWN" = "1 리뷰어 claude 하나 — Codex 로그인 안 됨" ] \
  && echo "  ✔ #18 주 도구 claude · 기록 없음 → codex 하나 · codex → claude 하나 · 반대쪽을 못 쓰면 남은 하나(이유 기록)" \
  || { echo "  ✖ #18 주 도구 반대쪽 — 없음[$ORDER_NONE] claude[$ORDER_CLAUDE] codex[$ORDER_CODEX] codex·claude 못 씀[$ORDER_CODEX_DOWN] claude·codex 못 씀[$ORDER_CLAUDE_DOWN]"; FAIL=1; }
# 주 도구 codex → claude 리뷰어 — 가짜 claude 판정이 그대로 결과 · codex 는 부르지 않는다
printf '{"main":"codex"}\n' > "$MCORE/.athena-main-tool.json"
CODEX_CALLED="$TMP/codex-called"; rm -f "$CODEX_CALLED"
RC_CORE="$MCORE" RC_ALSO='[ ! -e "$CODEX_CALLED" ]' run_case "주 도구 codex → claude 하나 수정 필요 · codex 는 부르지 않음" "$BIN:/usr/bin:/bin" changes FAKE_CLAUDE=changes FAKE_CODEX=ok FAKE_CODEX_CALLED="$CODEX_CALLED"
# #3 — 주 도구 codex 라 claude 가 리뷰어인데 사용량 한도로 실패하면 로그인 안 됐을 때와 같은 길 — codex 하나로 다시 짠다
LIMIT_OUT="$(env PATH="$BIN:/usr/bin:/bin" ATHENA_PR_AUTO_TIMEOUT_MS=1500 FAKE_CLAUDE=limit FAKE_CODEX=ok "$(command -v node)" --input-type=module -e "
  const { planReviewers, runReviewers } = await import('$MCORE/scripts/pr-auto.mjs')
  const { aggregate, reviewerBrief } = await import('$MCORE/scripts/lib/pr-auto.mjs')
  const first = await runReviewers('리뷰', {})
  const lineup = planReviewers({}, { claude: 'limited' })
  const again = await runReviewers('리뷰', {}, [], lineup.slots)
  console.log(JSON.stringify({ limited: first.some((result) => result.limited), first: reviewerBrief(first), brief: reviewerBrief(again), verdict: aggregate(again).verdict, note: lineup.note }))" 2>&1 | tail -1)"
case "$LIMIT_OUT" in *'"limited":true'*'"first":"claude:failed"'*'"brief":"codex:approve"'*'"verdict":"approve"'*'리뷰어 codex 하나 — Claude 사용량 한도'*) echo "  ✔ #3 Claude 한도 → 한도 표시 · codex 하나로 다시 짜서 승인 — $LIMIT_OUT" ;; *) echo "  ✖ #3 Claude 한도 전환 — $LIMIT_OUT"; FAIL=1 ;; esac
rm -f "$MCORE/.athena-main-tool.json"

# Codex 모델 · 생각 강도 — config.toml 맨 위 두 값만 -m · -c 로 넘긴다(--ignore-user-config 는 그대로)
CODEX_ARGS="$TMP/codex-args"; CODEX_HOME_DIR="$TMP/codex-home"; mkdir -p "$CODEX_HOME_DIR"
printf 'model = "gpt-test"\nmodel_reasoning_effort = "high"\n[mcp_servers.x]\nmodel = "other"\n' > "$CODEX_HOME_DIR/config.toml"
RC_ALSO='case " $(cat "$CODEX_ARGS" 2>/dev/null) " in *" --ignore-user-config "*"-m gpt-test "*model_reasoning_effort=\"high\"" "*) true ;; *) false ;; esac' \
  run_case "config.toml 있음 → codex 승인 · 인자에 -m gpt-test · effort high · --ignore-user-config 유지" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok CODEX_HOME="$CODEX_HOME_DIR" FAKE_CODEX_ARGS="$CODEX_ARGS"
rm -f "$CODEX_ARGS"; mkdir -p "$TMP/codex-empty"
RC_ALSO='case " $(cat "$CODEX_ARGS" 2>/dev/null) " in *" -m "*|*model_reasoning_effort*) false ;; *" --ignore-user-config "*) true ;; *) false ;; esac' \
  run_case "config.toml 없음 → codex 승인 · -m · -c 안 붙임" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok CODEX_HOME="$TMP/codex-empty" FAKE_CODEX_ARGS="$CODEX_ARGS"
CODEX_PURE="$(node --input-type=module -e "
  const { codexModelArgs, codexUserSettings } = await import('./scripts/lib/pr-auto.mjs')
  const top = codexUserSettings('# c\nmodel = \"m-1\" # x\n[a]\nmodel_reasoning_effort = \"low\"\n')
  const bad = codexUserSettings('model = \"a b\"\nmodel_reasoning_effort = \"x\\\\\"\"')
  console.log(JSON.stringify([top, codexModelArgs(top), bad, codexModelArgs(bad)]))")"
# 여러 줄 문자열(''' · """) 안의 model · [표] 는 설정이 아니다 — 파일로 만들어 읽는다
cat > "$TMP/multi.toml" <<'TOML'
# example = '''
# notes = """
model = "real"
developer_instructions = '''
model = "other"
[table]
model_reasoning_effort = "low"
'''
notes = """one
[x]
"""
model_reasoning_effort = "high"
[t]
model = "late"
TOML
MULTI_PURE="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  const { codexUserSettings } = await import('./scripts/lib/pr-auto.mjs')
  console.log(JSON.stringify(codexUserSettings(readFileSync(process.argv[1], 'utf8'))))" "$TMP/multi.toml")"
expect "codexUserSettings — 첫 [표] 앞 두 값만 · 이상한 값 무시 · 여러 줄 문자열 안의 model · [표] 는 무시(문자열 뒤 최상위 값은 읽음)" \
  "[ '$CODEX_PURE' = '[{\"model\":\"m-1\",\"effort\":\"\"},[\"-m\",\"m-1\"],{\"model\":\"\",\"effort\":\"\"},[]]' ] && [ '$MULTI_PURE' = '{\"model\":\"real\",\"effort\":\"high\"}' ]" "해석[$CODEX_PURE] 여러 줄[$MULTI_PURE]"

# 심볼릭 링크(맥 /var → /private/var) · `//` 가 든 경로로 직접 실행해도 import 로 오인하지 않는다(b051a7) — 인자 없이 부르면 사용법이 나와야 한다
mkdir -p "$TMP/ismain" && ln -s "$SRC" "$TMP/ismain/link"
MISSED=""
for script in pr-auto.mjs learn-review.mjs; do
  [ -n "$(node "$TMP/ismain/link/scripts/$script" 2>&1 </dev/null | head -1)" ] || MISSED="$MISSED $script(링크)"
done
[ -n "$(node "$TMP//ismain//link/scripts/pr-auto.mjs" 2>&1 </dev/null | head -1)" ] || MISSED="$MISSED pr-auto.mjs(//)"
expect "직접 실행 판정 — pr-auto.mjs · learn-review.mjs 를 심볼릭 링크 경로 · // 든 경로로 실행해도 직접 실행으로 인식" '[ -z "$MISSED" ]' "출력 없이 끝남(import 로 오인):$MISSED"

[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
