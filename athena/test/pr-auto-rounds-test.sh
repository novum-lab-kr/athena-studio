#!/usr/bin/env bash
# PR 자동 리뷰 시험 — 리뷰 라운드(앞 리뷰 승인 이어받기 · 사람에게 넘기지 않기 A · B · C · ⚡ 빠른 길 1차 → 2차 → 3차 짧은 리뷰 · 옛 줄 · 옛 job 읽기 · 지적은 한 번에)
. "$(dirname "$0")/_pr-auto-lib.sh"   # 공통 준비 — test/_pr-auto-lib.sh (이 경로 글을 보고 검증 범위가 헬퍼를 따라간다)
confirm_core
# 앞 리뷰 승인 이어받기(지시 2) — 계획서 "- Review result:" 가 같은 내용(tree)으로 승인이고 그 엔진이 리뷰어 엔진이면 리뷰어를 부르지 않고 그 승인을 쓴다
# 가짜 본체에는 주 도구 기록이 없다 → 리뷰어 codex 하나(docs/pr-auto.md "리뷰어 하나")
echo; echo "앞 리뷰 승인 이어받기"
{
TREE="$(git -C "$WT" rev-parse 'HEAD^{tree}')"
CLAUDE_LOG="$TMP/claude-called"; CODEX_CALLED4="$TMP/codex-called-4"; rm -f "$CLAUDE_LOG" "$CODEX_CALLED4"
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree ${TREE:0:12} · 📦 web · 🌿 feat/x · 🧠 codex · 2026-10-26 10:00
" merge_case "같은 tree 로 Codex 승인 → Codex 안 부름 · 줄에 '앞 리뷰 승인 이어받음'" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 codex 하나 · Codex: 앞 리뷰 승인 이어받음 @${SHA:0:7}" FAKE_CLAUDE_ARGS="$CLAUDE_LOG" FAKE_CODEX_CALLED="$CODEX_CALLED4"
[ ! -e "$CODEX_CALLED4" ] && [ ! -s "$CLAUDE_LOG" ] && grep -q '"reviewers":"codex:inherited"' "$CORE/.events.jsonl" \
  && echo "  ✔ Codex · Claude 둘 다 안 불림 · 사건 기록 codex:inherited" || { echo "  ✖ 이어받기 자리"; grep -o '"reviewers":"[^"]*"' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
grep -q "^pr review 7 " "$GH_LOG" && grep -q "앞 리뷰 승인 이어받음" "$GH_LOG" && echo "  ✔ PR 댓글에 이어받음" || { echo "  ✖ PR 댓글에 이어받음이 없다"; FAIL=1; }
# #4 — 다른 엔진(claude) 승인은 리뷰어(codex) 몫으로 쓰지 않는다(PR 239 재현: 엔진이 다른 승인이 자리를 채웠다)
rm -f "$CLAUDE_LOG" "$CODEX_CALLED4"
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree ${TREE:0:12} · 📦 web · 🌿 feat/x · 🧠 claude · 2026-10-26 10:00
" merge_case "#4 Claude 승인 → 리뷰어 codex 가 리뷰 · 이어받지 않음" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 codex 하나 · 라운드" FAKE_CLAUDE_ARGS="$CLAUDE_LOG" FAKE_CODEX_CALLED="$CODEX_CALLED4"
[ -e "$CODEX_CALLED4" ] && [ ! -s "$CLAUDE_LOG" ] && grep -q '"reviewers":"codex:approve"' "$CORE/.events.jsonl" && ! grep -q "앞 리뷰 승인 이어받음" "$CORE/plans/task/x.md" \
  && echo "  ✔ #4 Codex 는 불리고 Claude 는 안 불림 · 사건 기록 codex:approve" || { echo "  ✖ #4 다른 엔진 승인"; grep -o '"reviewers":"[^"]*"' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
rm -f "$CODEX_CALLED4"
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree ${TREE:0:12} · 📦 web · 🌿 feat/x · 2026-10-26 10:00
" merge_case "#4 엔진 없는 옛 승인 → 이어받지 않고 리뷰" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 codex 하나 · 라운드" FAKE_CODEX_CALLED="$CODEX_CALLED4"
[ -e "$CODEX_CALLED4" ] && ! grep -q "앞 리뷰 승인 이어받음" "$CORE/plans/task/x.md" && echo "  ✔ #4 엔진 없는 옛 승인은 이어받지 않음" || { echo "  ✖ #4 엔진 없는 옛 승인을 이어받았다"; FAIL=1; }
# #3 처리기 한 번 — 주 도구 codex 라 리뷰어가 claude 인데 사용량 한도면 사람 손 없이 codex 하나로 이어 가 머지(고치기 전: 리뷰어 부족 → auto.stop · PR 235~240)
printf '{"main":"codex"}\n' > "$CORE/.athena-main-tool.json"
EXTRA_PLAN='' merge_case "#3 Claude 한도 → codex 하나로 머지 · 줄에 사용량 한도" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 codex 하나 — Claude 사용량 한도" FAKE_CLAUDE=limit FAKE_CODEX=ok
! grep -q '"type":"auto.stop"' "$CORE/.events.jsonl" && grep -q '"reviewers":"codex:approve"' "$CORE/.events.jsonl" \
  && echo "  ✔ #3 멈춤 없음 · 사건 기록 codex:approve" || { echo "  ✖ #3 처리기 한도 전환"; grep -o '"type":"[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
rm -f "$CORE/.athena-main-tool.json" "$CODEX_CALLED4"
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree 0000ffff0000 · 📦 web · 🌿 feat/x · 🧠 codex · 2026-10-26 10:00
" merge_case "tree 가 다르면 → Codex 도 다시 리뷰" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 codex 하나 · 라운드" FAKE_CODEX_CALLED="$CODEX_CALLED4"
[ -e "$CODEX_CALLED4" ] && echo "  ✔ Codex 리뷰어가 불렸다" || { echo "  ✖ tree 가 다른데 Codex 가 안 불렸다"; FAIL=1; }
} > "$GRP"; grp_end "앞 리뷰 승인 이어받기 — 같은 tree · 같은 엔진만(다른 엔진 · 엔진 없는 옛 승인 · tree 다름은 리뷰) · #3 한도면 codex 하나로"
echo; echo "사람에게 넘기지 않기(결정 A · B · C)"
{
OLD7="0000000"
CALLED="$TMP/codex-called"; rm -f "$CALLED"
# C 절은 주 도구 codex — 리뷰어 claude 하나(가짜 claude 판정으로 본다 · codex 는 불리지 않는다) · B 앞에서 지운다
printf '{"main":"codex"}\n' > "$CORE/.athena-main-tool.json"
rm -f "$CLAUDE_LOG"
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 상한 뒤 이어받은 새 HEAD → 짧은 리뷰 승인 → 바로 머지(확인 없음 레포)" ', "autoMergeConfirm": false' yes "머지됨 — squash → main\(⚡ 빠른 길 · ${FAST_LAST} — 바뀐 부분 짧은 리뷰 후 머지\) · 짧은 리뷰 — 리뷰어 claude 하나 · 라운드 3/${FAST_REVIEWS}" FAKE_CODEX_CALLED="$CALLED" FAKE_CLAUDE_ARGS="$CLAUDE_LOG"
[ ! -e "$CALLED" ] && [ -s "$CLAUDE_LOG" ] && grep -q "^pr review 7 .*⚡ 빠른 길 · ${FAST_LAST} · 짧은 리뷰 · 라운드 3/${FAST_REVIEWS}" "$GH_LOG" && grep -q '"type":"auto.takeover".*"review":"승인"' "$CORE/.events.jsonl" && grep '"type":"review"' "$CORE/.events.jsonl" | grep -q '"short":true' \
  && echo "  ✔ C — 리뷰어는 Claude 하나만 · PR 댓글에 짧은 리뷰 · auto.takeover(승인) · review 사건 short:true" || { echo "  ✖ C — 짧은 리뷰 리뷰어 · 댓글 · 사건"; grep -o '"type":"[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 짧은 리뷰에 막는 지적 → 머지 안 함 · 멈춤(다시 고치게 하지 않음)" ', "autoMergeConfirm": false' no "멈춤 — ${FAST_LAST} 짧은 리뷰에서 막는 지적 1개 · 짧은 리뷰 — 리뷰어 claude 하나 · 라운드 3/${FAST_REVIEWS}" FAKE_CLAUDE=changes FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"type":"auto.stop".*"reason":"short-review"' "$CORE/.events.jsonl" && grep -q '"type":"auto.takeover".*"review":"막음"' "$CORE/.events.jsonl" && ! grep -q "수정 지시를 보낼 pane" "$CORE/.requests"/*.json 2>/dev/null && grep -q "짧은 리뷰 막음" "$TMP/merge.out" "$CORE/.requests"/*.json 2>/dev/null \
  && echo "  ✔ C — 짧은 리뷰 막음: auto.stop(short-review) · 수정 지시 없음 · 아테나에 알림" || { echo "  ✖ C — 짧은 리뷰 막음 처리"; grep -o '"type":"[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
AUTO_LINE="- Auto review: web#7 @$OLD7 · 멈춤 — 상한 뒤 이어받음 짧은 리뷰에서 막는 지적 1개 · 라운드 4/3 · 2026-10-26 10:00" \
  merge_case "C — 짧은 리뷰 멈춤 뒤 또 커밋 → 자동 흐름이 다시 돌지 않음(사람이 이어받음)" ', "autoMergeConfirm": false' no '멈춤 — 상한 뒤 이어받음 짧은 리뷰에서 막는 지적 1개' FAKE_CODEX_CALLED="$CALLED"
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 짧은 리뷰어가 답하지 못함 → 머지 안 함 · 멈춤" ', "autoMergeConfirm": false' no '멈춤 — '"${FAST_LAST}"' 짧은 리뷰 실패\(리뷰어가 답하지 못함\) · 짧은 리뷰 — 리뷰어 claude 하나 · '"라운드 3/${FAST_REVIEWS}" FAKE_CLAUDE=bad FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"type":"auto.stop".*"reason":"reviewers"' "$CORE/.events.jsonl" && grep -q '"type":"auto.takeover".*"review":"실패"' "$CORE/.events.jsonl" \
  && echo "  ✔ C — 짧은 리뷰 실패: auto.stop(reviewers) · auto.takeover(실패)" || { echo "  ✖ C — 짧은 리뷰 실패 처리"; grep -o '"type":"[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
# --dry-run — 짧은 리뷰도 할 일만 보여 준다(PR 댓글 · 계획서 줄 · 머지 없음)
SHORT_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00"
for verdict in approve changes; do
  printf '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p3 (web-fe)\n%s\n- PR: https://github.com/acme/web/pull/7\n' "$WT" "$SHORT_LINE" > "$CORE/plans/task/x.md"; : > "$GH_LOG"
  OUT="$(env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok FAKE_CLAUDE="$verdict" GH_LOG="$GH_LOG" "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 --dry-run 2>&1)"
  if [ "$verdict" = approve ]; then want="── 할 일: ${FAST_LAST} 짧은 리뷰 승인 → 안 정한 결정"; else want="── 할 일: 머지하지 않음 — 멈춤 — ${FAST_LAST} 짧은 리뷰에서 막는 지적 1개"; fi
  if echo "$OUT" | grep -qF -- "$want" && echo "$OUT" | grep -q "⚡ 빠른 길 · ${FAST_LAST} · 짧은 리뷰 · 라운드 3/${FAST_REVIEWS}" && grep -qF -- "$SHORT_LINE" "$CORE/plans/task/x.md" && ! grep -q "^pr review\|^pr merge" "$GH_LOG"; then
    echo "  ✔ C — --dry-run 짧은 리뷰($verdict): 할 일 · 댓글 머리만 · 계획서 · PR 그대로"
  else echo "  ✖ C — --dry-run 짧은 리뷰($verdict)"; echo "$OUT" | sed 's/^/      /'; FAIL=1; fi
done
} > "$GRP"; grp_end "C — 3차 짧은 리뷰: 승인 → 머지 · 막는 지적 → 멈춤 · 멈춤 뒤 커밋 · 리뷰어 실패 · --dry-run(승인 · 수정)"
# 옛 문구로 남은 상한 줄도 이어받는다(머리만 본다)
{
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — 상한 뒤 이어받음(다음 커밋은 리뷰 없이 검증만) · 라운드 2/2 · 2026-10-26 10:00" \
  merge_case "C — 옛 상한 줄(리뷰 없이 검증만)도 이어받아 짧은 리뷰 → 머지" ', "autoMergeConfirm": false' yes "머지됨 — squash → main\(⚡ 빠른 길 · ${FAST_LAST} — 바뀐 부분 짧은 리뷰 후 머지\) · 짧은 리뷰 — 리뷰어 claude 하나 · 라운드 3/${FAST_REVIEWS}"
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 이어받은 HEAD · 확인 켠 레포 → 짧은 리뷰 승인 뒤 머지 확인 요청(autoMergeConfirm 그대로)" '' no "${FAST_LAST}"'\(바뀐 부분 짧은 리뷰 후 머지\) → 머지 확인 대기'
grep -q "\"shortReviewed\":\"$SHA\"" "$TMP/queue-confirm/confirm/web-7.json" 2>/dev/null \
  && echo "  ✔ C — 머지 대기 파일에 그 HEAD 의 짧은 리뷰 표식(shortReviewed)" || { echo "  ✖ C — 대기 파일에 짧은 리뷰 표식이 없다"; cat "$TMP/queue-confirm/confirm/web-7.json" 2>/dev/null; FAIL=1; }
# 짧은 리뷰는 같은 tree 의 앞 리뷰 승인(- Review result:)도 이어받지 않는다 — 상한 라운드 지적을 리뷰어가 실제로 다시 본다(2026-11-03 리뷰 지적)
rm -f "$CLAUDE_LOG"
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree ${TREE:0:12} · 📦 web · 🌿 feat/x · 🧠 claude · 2026-10-26 10:00
" AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00" merge_case "C — 짧은 리뷰는 같은 tree 앞 승인이 있어도 Claude 가 본다(승인 → 머지)" ', "autoMergeConfirm": false' yes "머지됨 — squash → main\(⚡ 빠른 길 · ${FAST_LAST} — 바뀐 부분 짧은 리뷰 후 머지\) · 짧은 리뷰 — 리뷰어 claude 하나 · 라운드 3/${FAST_REVIEWS} · [0-9]" FAKE_CLAUDE_ARGS="$CLAUDE_LOG"
[ -s "$CLAUDE_LOG" ] && ! grep -q "앞 리뷰 승인 이어받음" "$CORE/plans/task/x.md" && echo "  ✔ C — 짧은 리뷰에서 Claude 가 불렸다 · 이어받음 없음" || { echo "  ✖ C — 짧은 리뷰가 앞 승인을 이어받았다"; FAIL=1; }
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree ${TREE:0:12} · 📦 web · 🌿 feat/x · 🧠 claude · 2026-10-26 10:00
" AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00" merge_case "C — 짧은 리뷰는 같은 tree 앞 승인이 있어도 막는 지적이면 멈춤" ', "autoMergeConfirm": false' no "멈춤 — ${FAST_LAST} 짧은 리뷰에서 막는 지적 1개" FAKE_CLAUDE=changes
} > "$GRP"; grp_end "C — 옛 상한 줄도 이어받음 · 확인 켠 레포는 머지 확인 · 짧은 리뷰는 앞 리뷰 승인을 이어받지 않음"
# 업데이트 전에 생긴 이어받음 머지 대기(짧은 리뷰 표식 없음)는 머지하지 않는다 — 지난 리뷰 기록이 맞으면 상한 줄을 되살려 짧은 리뷰로 돌리고, 아니면 멈춤(2026-11-03 리뷰 지적)
{
legacy_job() {   # <지난 리뷰 기록 yes|no>
  rm -rf "$TMP/queue-confirm" "$CORE/.events.jsonl" "$CORE/.requests"; mkdir -p "$TMP/queue-confirm/confirm" "$TMP/queue-confirm/history" "$TMP/queue-confirm/.watcher.lock"; echo $$ > "$TMP/queue-confirm/.watcher.lock/pid"; : > "$GH_LOG"; rm -f "$GH_LOG.views"
  printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoMergeConfirm": false } ] }\n' > "$CORE/athena.config.json"
  printf '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p3 (web-fe)\n- Auto review: web#7 @%s · 상한 뒤 이어받음(리뷰 없이 검증만) → 바로 머지(확인 없음) · 라운드 4/3 · 2026-10-26 10:00\n- PR: https://github.com/acme/web/pull/7\n' "$WT" "${SHA:0:7}" > "$CORE/plans/task/x.md"
  [ "$1" = yes ] && printf '{"sha":"%s","round":3,"findings":[{"file":"b.js","line":2,"problem":"p","fix":"f"}],"autoDecisions":[],"missed":[]}' "${OLD7}aaaa" > "$TMP/queue-confirm/history/web-7.json"
  printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":4,"max":3,"note":"","takeover":true,"worktree":"%s","base":"main","root":"%s","packId":null,"request":null,"noConfirm":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json"
  [ "${LEGACY_PREPARE_ONLY:-0}" = 1 ] && return 0
  env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
    const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
}
legacy_job yes
if ! grep -q '^pr merge' "$GH_LOG" && grep -q "^- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · 라운드 3/3" "$CORE/plans/task/x.md" \
  && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] && grep -lq "\"head\":\"$SHA\"" "$TMP/queue-confirm/"*.json 2>/dev/null; then echo "  ✔ C — 옛 이어받음 대기(표식 없음) → 머지 안 함 · 상한 줄 되살림 · 짧은 리뷰 대기열에"
else echo "  ✖ C — 옛 이어받음 대기 → 짧은 리뷰로"; grep -o '^- Auto review: .*' "$CORE/plans/task/x.md"; ls "$TMP/queue-confirm"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; fi
rm -f "$CLAUDE_LOG"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" FAKE_CLAUDE_ARGS="$CLAUDE_LOG" "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1
if grep -q "^pr merge 7 --repo acme/web --squash --match-head-commit $SHA" "$GH_LOG" && [ -s "$CLAUDE_LOG" ] && grep -q "· 짧은 리뷰 — 리뷰어 claude 하나 · 라운드 4/3" "$CORE/plans/task/x.md"; then echo "  ✔ C — 되살린 상한 줄로 다시 돌면 짧은 리뷰(Claude) 승인 뒤 머지"
else echo "  ✖ C — 되살린 뒤 짧은 리뷰 · 머지"; grep -o '^- Auto review: .*' "$CORE/plans/task/x.md"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; fi
legacy_job no
if ! grep -q '^pr merge' "$GH_LOG" && grep -q "^- Auto review: web#7 @${SHA:0:7} · 멈춤 — 상한 뒤 이어받음 짧은 리뷰 없음" "$CORE/plans/task/x.md" && grep -q '"type":"auto.stop".*"reason":"short-review"' "$CORE/.events.jsonl" \
  && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] && ! ls "$TMP/queue-confirm/"*.json >/dev/null 2>&1; then echo "  ✔ C — 옛 이어받음 대기 · 지난 리뷰 기록 없음 → 머지 안 함 · 멈춤 · auto.stop(short-review)"
else echo "  ✖ C — 옛 이어받음 대기 · 기록 없음"; grep -o '^- Auto review: .*' "$CORE/plans/task/x.md"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; fi
} > "$GRP"; grp_end "옛 이어받음 머지 대기(표식 없음) — 기록 맞으면 짧은 리뷰로 · 아니면 멈춤"
# 옛 확인 요청에 이미 온 보류(answered · delivered)는 전환보다 먼저 처리한다.
{
legacy_request() {   # <open|answered|delivered> <답>
  (cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
    import fs from 'node:fs'
    const { openRequest, answerRequest, ackRequest } = await import('./scripts/lib/requests.mjs')
    const request = openRequest('.', { kind: 'question', title: '옛 머지 확인', options: [{ label: '머지' }, { label: '보류' }], links: { plan: 'plans/task/x.md' } }).request
    if (process.argv[1] !== 'open') answerRequest('.', request.id, { choice: process.argv[2], by: 'board' })
    if (process.argv[1] === 'delivered') ackRequest('.', request.id)
    const file = '$TMP/queue-confirm/confirm/web-7.json'
    const job = JSON.parse(fs.readFileSync(file)); job.noConfirm = false; job.request = request.id
    fs.writeFileSync(file, JSON.stringify(job))
    const config = JSON.parse(fs.readFileSync('athena.config.json')); config.repos[0].autoMergeConfirm = true
    fs.writeFileSync('athena.config.json', JSON.stringify(config))
  " "$1" "${2:-}" >/dev/null)
}
for state in answered delivered; do
  LEGACY_PREPARE_ONLY=1 legacy_job yes
  legacy_request "$state" 보류
  confirm_run
  if ! grep -q '^pr merge' "$GH_LOG" && grep -q '보류 — 사람이 고름(보류)' "$CORE/plans/task/x.md" \
    && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] && ! ls "$TMP/queue-confirm/"*.json >/dev/null 2>&1 \
    && grep -q '"type":"auto.merge".*"reason":"held"' "$CORE/.events.jsonl"; then echo "  ✔ C — 옛 이어받음 $state 보류 → 보류로 끝냄 · 짧은 리뷰 재진입 없음"
  else echo "  ✖ C — 옛 이어받음 $state 보류"; cat "$TMP/merge.out"; FAIL=1; fi
done
for state in open answered; do
  LEGACY_PREPARE_ONLY=1 legacy_job yes
  legacy_request "$state" 머지
  confirm_run
  if ! grep -q '^pr merge' "$GH_LOG" && grep -q "@$OLD7 · 수정 필요 — ${FAST_LAST}(" "$CORE/plans/task/x.md" \
    && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] && ls "$TMP/queue-confirm/"*.json >/dev/null 2>&1; then echo "  ✔ C — 옛 이어받음 $state 머지 요청 → 취소 뒤 짧은 리뷰 대기열로"
  else echo "  ✖ C — 옛 이어받음 $state 전환"; cat "$TMP/merge.out"; FAIL=1; fi
done
} > "$GRP"; grp_end "옛 확인 요청 — 이미 온 보류가 전환보다 먼저 · 열린 · 답한 요청 전환"
# 요청 취소 뒤 계획서 쓰기를 실패시킨다. 별도 node 실행으로 재시작하면 죽은 pid 의 claim 과 cancelled 요청에서도 전환을 마쳐야 한다.
{
for history in yes no; do
  LEGACY_PREPARE_ONLY=1 legacy_job "$history"
  legacy_request open
  env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (String(to) === '$CORE/plans/task/x.md') throw new Error('injected plan write failure')
      return rename(from, to)
    }
    syncBuiltinESMExports()
    const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()
  " > "$TMP/merge.out" 2>&1
  failed=$?
  if [ "$failed" != 0 ] && grep -q 'injected plan write failure' "$TMP/merge.out" \
    && grep -lq '"legacyShortReview":true' "$TMP/queue-confirm/confirm/"*.json.* \
    && grep -lq '"state": *"cancelled"' "$CORE/.requests"/*/request.json "$CORE/.requests"/*.json 2>/dev/null; then echo "  ✔ C — 옛 전환 중 계획서 쓰기 실패(기록 $history) → 취소된 요청 · 영속 전환 표식 · claim 보존"
  else echo "  ✖ C — 옛 전환 중 실패 복구 정보(기록 $history)"; cat "$TMP/merge.out"; FAIL=1; fi
  confirm_run
  recovered=no
  if [ "$history" = yes ]; then
    grep -q "@$OLD7 · 수정 필요 — ${FAST_LAST}(" "$CORE/plans/task/x.md" && ls "$TMP/queue-confirm/"*.json >/dev/null 2>&1 && recovered=yes
  else
    grep -q '멈춤 — 상한 뒤 이어받음 짧은 리뷰 없음' "$CORE/plans/task/x.md" && grep -q '"type":"auto.stop".*"reason":"short-review"' "$CORE/.events.jsonl" && recovered=yes
  fi
  if [ "$recovered" = yes ] && ! grep -q '^pr merge' "$GH_LOG" && [ -z "$(ls "$TMP/queue-confirm/confirm")" ]; then echo "  ✔ C — 전환 중 실패 후 재시작(기록 $history) → 재등록 또는 멈춤 기록 뒤 원본 삭제"
  else echo "  ✖ C — 전환 중 실패 후 재시작(기록 $history)"; cat "$TMP/merge.out"; FAIL=1; fi
done
} > "$GRP"; grp_end "옛 job 전환 — 계획서 쓰기 실패 뒤 재시작해도 마침(history 있음 · 없음)"
rm -rf "$TMP/queue-confirm"
{
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 이어받은 HEAD 가 검증 실패 → 머지 안 함 · 사람에게(자동 재시도 없음)" ', "autoMergeConfirm": false' no '검증 대기' FAKE_VERIFY_FAIL=1
AUTO_LINE="- Auto review: web#7 @$OLD7 · 리뷰어 부족(승인 1/2) · 라운드 3/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 상한을 넘었는데 직전이 이어받기가 아님 → 멈춤(짧은 리뷰도 안 돎)" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한'
merge_case "C — 1차에서 수정 필요 → 이어받기 없이 수정 지시(다음은 평소 2차)" ', "autoMergeConfirm": false' no "^- Auto review: web#7 @[0-9a-f]+ · 수정 필요 · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 1/${FAST_REVIEWS}" FAKE_CLAUDE=changes
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 1/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 상한 라운드(2차)에서 수정 필요 → 멈추지 않고 수정 지시 · 줄에 ${FAST_LAST}" ', "autoMergeConfirm": false' no '^- Auto review: web#7 @[0-9a-f]+ · 수정 필요 — '"${FAST_LAST}"'\(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지\) · '"${FAST_LINEUP}"' · 리뷰어 claude 하나 · '"라운드 2/${FAST_REVIEWS}" FAKE_CLAUDE=changes
AUTO_LINE="- Auto review: web#7 @$OLD7 · 상한 뒤 이어받음(바뀐 부분 짧은 리뷰 후 머지) → 머지 확인 대기 · 라운드 4/3 · 2026-10-26 10:00" \
  merge_case "C — 이어받은 HEAD 가 머지 단계로 간 뒤 또 커밋 → 멈춤(다시 이어받지 않음)" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한' FAKE_CODEX_CALLED="$CALLED"
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 1/${FAST_REVIEWS} · 2026-10-26 10:00" \
  merge_case "C — 상한 라운드(2차)에 리뷰어가 실패 → 리뷰어 부족 · 이어받지 않음" ', "autoMergeConfirm": false' no '· 리뷰어 부족\(승인 0/1\) · '"${FAST_LINEUP}"' · 리뷰어 claude 하나 · '"라운드 2/${FAST_REVIEWS}" FAKE_CLAUDE=bad
! grep -q -- "— ${FAST_LAST}" "$CORE/plans/task/x.md" && echo "  ✔ C — 리뷰어 부족 상한 라운드는 이어받기를 주지 않음" || { echo "  ✖ C — 리뷰어 부족인데 이어받음"; FAIL=1; }
} > "$GRP"; grp_end "C — 이어받기 경계: 검증 실패 · 직전 이어받기 아님 · 1차 · 2차 수정 필요 · 머지 단계 뒤 커밋 · 리뷰어 실패"
rm -f "$CORE/.athena-main-tool.json"   # B · A · D 는 기록 없음 — 리뷰어 codex 하나(가짜 codex 결정 응답으로 본다)
{
merge_case "B — 구현 세부 결정 + 추천 → 자동 확정 · 수정 필요(결정 콘솔 없음)" ', "autoMergeConfirm": false' no "· 수정 필요 · ${FAST_LINEUP} · 리뷰어 codex 하나 · 라운드 1/${FAST_REVIEWS}" FAKE_CODEX=impl
grep -q '^- 추천안으로 자동 확정(자동 리뷰 · codex · web#7 @.* · 구현 세부): 아이콘 자리 → A 왼쪽$' "$CORE/plans/task/x.md" && [ ! -e "$CORE/plans/task/x.html" ] && grep -q "추천안으로 자동 확정" "$GH_LOG" \
  && echo "  ✔ B — 계획서 Decisions · PR 댓글에 추천안으로 자동 확정" || { echo "  ✖ B — 계획서 · 댓글 기록"; sed 's/^/      /' "$CORE/plans/task/x.md"; FAIL=1; }
merge_case "A — 제품 결정 + 수정 지적 → 결정 필요 · 수정 지시도 만듦" ', "autoMergeConfirm": false' no "· 결정 필요 · ${FAST_LINEUP} · 리뷰어 codex 하나 · 라운드 1/${FAST_REVIEWS}" FAKE_CODEX=product-changes
grep -q '"title": "자동 리뷰 수정 지시를 보낼 pane 이 없다' "$CORE/.requests"/*.json 2>/dev/null && grep -q 'b.js:2' "$CORE/.requests"/*.json \
  && echo "  ✔ A — 결정이 있어도 수정 지시(b.js:2)를 보냄(가짜 화면엔 pane 이 없어 사람 요청으로)" || { echo "  ✖ A — 수정 지시가 없다"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
# 가짜 본체엔 docs/plan-template.html 이 없어 plan-html --add 가 실패한다 — 그래도 결정 콘솔과 같은 키의 결정 요청이 열려 머지를 막는다
grep -l '"dedupeKey": "plan:plans/task/x.md"' "$CORE/.requests"/*.json 2>/dev/null | xargs grep -q '결정 콘솔 등록 실패' 2>/dev/null \
  && echo "  ✔ A — 결정 콘솔 등록 실패 → 같은 키(plan:<계획서>)로 결정 요청을 대신 엶" || { echo "  ✖ A — 등록 실패 뒤 결정 요청이 없다"; FAIL=1; }
(cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
  const { writeFileSync } = await import('node:fs')
  writeFileSync('plans/task/x.md', '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: $WT · 🌿 feat/x · pane p3 (web-fe)\n- Auto review: web#7 @0000000 · 결정 필요 — 상한 뒤 이어받음(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · 승인 1/1이지만 결정 콘솔에 안 정한 결정이 있어 머지 대기 · ⚡ 빠른 길 — 최대 3번 · 리뷰어 codex 하나 · 라운드 2/3 · s\n- PR: https://github.com/acme/web/pull/7\n')")
: > "$GH_LOG"; rm -f "$GH_LOG.views"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" \
  "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1
! grep -q '^pr merge' "$GH_LOG" && grep -q '결정 필요 — 이어받은 HEAD이지만 결정 콘솔에 안 정한 결정' "$CORE/plans/task/x.md" \
  && echo "  ✔ A — 그 요청이 남아 있으면 다음 라운드가 승인이어도 머지 안 함" || { echo "  ✖ A — 등록 실패 뒤 머지가 막히지 않음"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
PENDING=1 merge_case "A — 승인이어도 결정 콘솔에 안 정한 결정 → 머지 안 함" ', "autoMergeConfirm": false' no '결정 필요 — .*승인 1/1이지만 결정 콘솔에 안 정한 결정' FAKE_CODEX=ok
} > "$GRP"; grp_end "A · B — 구현 결정 자동 확정 · 제품 결정은 결정 필요 + 수정 지시 · 등록 실패면 대체 요청 · 안 정한 결정은 머지 안 함"
# (옛 3라운드 흐름의 '이어받은 HEAD 도 결정이면 다음 커밋도 이어받음'은 리뷰 켠 PR 에선 안 돈다 — 빠른 길 절 '이어받은 HEAD 에 안 정한 결정' 이 본다)
{
merge_case "E — 권장만 남은 수정 필요 → 승인으로 보고 머지 단계(바로 머지)" ', "autoMergeConfirm": false' yes '머지됨 — squash → main' FAKE_CODEX=advisory
grep -q "권장 1개는 머지를 막지 않는다" "$GH_LOG" && ! grep -q "수정 지시를 보낼 pane" "$CORE/.requests"/*.json 2>/dev/null \
  && echo "  ✔ E — 권장은 PR 댓글에만(에이전트 지시 없음)" || { echo "  ✖ E — 권장 처리"; FAIL=1; }
ADV_ISSUE="$(ls "$CORE"/issues/*-web-pr7-리뷰-권장.md 2>/dev/null | head -1)"
[ -n "$ADV_ISSUE" ] && grep -q '^- \[ \] c.js:5 — 이름이 길다 → 줄인다' "$ADV_ISSUE" && grep -q '^pr: 7$' "$ADV_ISSUE" \
  && echo "  ✔ E — 권장 지적은 PR 당 이슈 하나(issues/<날짜>-web-pr7-리뷰-권장.md)" || { echo "  ✖ E — 권장 묶음 이슈 없음"; ls "$CORE/issues" 2>&1 | sed 's/^/      /'; FAIL=1; }
} > "$GRP"; grp_end "E — 권장만이면 승인으로 머지 · 댓글에만 · PR 당 이슈 하나"
rm -f "$CORE"/issues/*-web-pr7-리뷰-권장.md

echo; echo "⚡ 빠른 길(2026-10-31 D1 · D2 — 리뷰 켠 PR 은 모두 상한 2 · 리뷰는 최대 ${FAST_REVIEWS}번 · 리뷰어는 평소와 같은 하나)"
# 2026-11-25 — '- Fast path:' 줄은 더 읽지 않는다 · 옛 계획서에 no 가 남아 있어도 빠른 길 그대로
{
FAST_PLAN="- Fast path: no (옛 줄 — 읽지 않음)
"
rm -f "$CALLED"
# 빠른 길 절도 주 도구 codex — 리뷰어 claude 하나 · 절 끝에서 지운다
printf '{"main":"codex"}\n' > "$CORE/.athena-main-tool.json"
EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 승인 → 바로 머지(리뷰어 하나 · 라운드 1/${FAST_REVIEWS})" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 1/${FAST_REVIEWS}" FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"type":"auto.merge".*"fast":true' "$CORE/.events.jsonl" && grep -q "⚡ 빠른 길 · 라운드 1/${FAST_REVIEWS}" "$GH_LOG" \
  && echo "  ✔ 빠른 길 — Codex 는 안 부름 · auto.merge 사건 fast:true · PR 댓글 ⚡" || { echo "  ✖ 빠른 길 — Codex 호출 · 사건 · 댓글"; grep -o '"type":"auto[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
rm -f "$CALLED"
EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 1차 수정 필요 → 지시 · 이어받기 없음(라운드 1/${FAST_REVIEWS})" ', "autoMergeConfirm": false' no "^- Auto review: web#7 @[0-9a-f]+ · 수정 필요 · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 1/${FAST_REVIEWS}" FAKE_CLAUDE=changes FAKE_CODEX_CALLED="$CALLED"
# 가짜 화면엔 pane 이 없어 수정 지시는 사람 요청으로 간다(auto.fix 사건은 pane 에 보냈을 때만) — review 사건에 fast:true
[ ! -e "$CALLED" ] && grep -q 'b.js:2' "$CORE/.requests"/*.json 2>/dev/null && grep '"type":"review"' "$CORE/.events.jsonl" | grep '"fast":true' | grep -q '"verdict":"수정 필요"' \
  && echo "  ✔ 빠른 길 — 지적(b.js:2)은 보냄 · Codex 안 부름 · review 사건 fast:true" || { echo "  ✖ 빠른 길 — 수정 지시 · 사건"; grep -o '"type":"[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
rm -f "$CALLED" "$CLAUDE_LOG"
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — 상한 뒤 이어받음(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ⚡ 빠른 길 — 상한 1 · 리뷰어 claude 하나 · 라운드 1/1 · 2026-10-31 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 옛 줄(상한 뒤 이어받음 · 1/1) 뒤 고친 새 HEAD → 이제 평소 2차 리뷰 승인 → 머지(라운드 2/3)" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS}" FAKE_CODEX_CALLED="$CALLED" FAKE_CLAUDE_ARGS="$CLAUDE_LOG"
[ ! -e "$CALLED" ] && [ -s "$CLAUDE_LOG" ] && ! grep -q '"type":"auto.takeover"' "$CORE/.events.jsonl" && grep -q '"type":"auto.merge".*"fast":true' "$CORE/.events.jsonl" \
  && echo "  ✔ 빠른 길 — 옛 줄 뒤 2차는 Claude 하나 · 이어받기 아님 · auto.merge 사건 fast:true" || { echo "  ✖ 빠른 길 — 옛 줄 뒤 2차 사건"; grep -o '"type":"auto[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
AUTO_LINE="- Auto review: web#7 @$OLD7 · ⚡ 빠른 길 · 상한 뒤 이어받음(바뀐 부분 짧은 리뷰 후 머지) → 머지 확인 대기 · 라운드 2/1 · 2026-10-31 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 두 번째 수정(머지 단계 뒤 또 커밋) → 멈춤 · 아테나가 이어받음" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한' FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"type":"auto.stop".*"fast":true' "$CORE/.events.jsonl" && grep -q '"reason":"rounds"' "$CORE/.events.jsonl" \
  && echo "  ✔ 빠른 길 — auto.stop(rounds) 사건 fast:true" || { echo "  ✖ 빠른 길 — 멈춤 사건"; grep -o '"type":"auto[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
rm -f "$CALLED"
# 이어받은 HEAD 에 안 정한 결정이 남아도 빠른 길은 이어받기를 다시 주지 않는다(옛 흐름은 '결정 필요 — 상한 뒤 이어받음…' 으로 다음 커밋도 이어받음) → 그다음 커밋은 라운드 상한 멈춤
PENDING=1 AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-10-31 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 이어받은 HEAD 에 안 정한 결정 → 머지 대기 · 이어받기는 다시 안 줌" ', "autoMergeConfirm": false' no '결정 필요 — 이어받은 HEAD이지만 결정 콘솔에 안 정한 결정이 있어 머지 대기\(⚡ 빠른 길 — 다음 커밋은 이어받지 않음\) · 짧은 리뷰 — 리뷰어 claude 하나 · '"라운드 3/${FAST_REVIEWS}"''
AUTO_LINE="- Auto review: web#7 @$OLD7 · 결정 필요 — 이어받은 HEAD이지만 결정 콘솔에 안 정한 결정이 있어 머지 대기(⚡ 빠른 길 — 다음 커밋은 이어받지 않음) · 라운드 3/${FAST_REVIEWS} · 2026-10-31 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 결정 뒤 또 커밋(두 번째 수정) → 멈춤 · 아테나가 이어받음" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한' FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"type":"auto.stop".*"fast":true' "$CORE/.events.jsonl" && grep -q '"reason":"rounds"' "$CORE/.events.jsonl" \
  && echo "  ✔ 빠른 길 — 결정 뒤 커밋은 리뷰도 머지도 하지 않음 · auto.stop(rounds)" || { echo "  ✖ 빠른 길 — 결정 뒤 커밋 멈춤"; grep -o '"type":"auto[^}]*' "$CORE/.events.jsonl" | sed 's/^/      /'; FAIL=1; }
rm -f "$CALLED"
} > "$GRP"; grp_end "⚡ 빠른 길 — 승인 · 수정 필요 · 옛 줄 뒤 2차 · 상한 멈춤 · 이어받은 HEAD 결정 뒤 멈춤"
{
# 2026-11-09 줄(2차 · n/2 — 리뷰가 최대 2번이던 때) — 이제 다음 커밋은 평소 2차 리뷰(라운드 2/3 · 이어받기 아님)
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — 2차(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ⚡ 빠른 길 — 최대 2번 · 리뷰어 claude 하나 · 라운드 1/2 · 2026-11-09 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 옛 줄(2차 · 1/2) 뒤 고친 새 HEAD → 평소 2차 리뷰 승인 → 머지(라운드 2/3)" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS}" FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && ! grep -q '"type":"auto.takeover"' "$CORE/.events.jsonl" && echo "  ✔ 옛 2차 줄 — 이어받기 사건 없음(평소 리뷰)" || { echo "  ✖ 옛 2차 줄 — 이어받기로 갔다"; FAIL=1; }
rm -f "$CALLED"
AUTO_LINE="- Auto review: web#7 @$OLD7 · ⚡ 빠른 길 · 2차(바뀐 부분 짧은 리뷰 후 머지) → 머지 확인 대기 · 라운드 2/2 · 2026-11-09 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 옛 줄(2차 머지 단계 · 2/2) 뒤 또 커밋 → 멈춤" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한' FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"reason":"rounds"' "$CORE/.events.jsonl" && echo "  ✔ 옛 2차 머지 단계 뒤 멈춤 — auto.stop(rounds)" || { echo "  ✖ 옛 2차 머지 단계 뒤 멈춤 사건"; FAIL=1; }
rm -f "$CALLED"
# 2026-11-25 — 새 줄(3차 · n/3): 2차 수정 필요 줄 → 3차 짧은 리뷰 → 머지 · 3차 머지 단계 줄 뒤 또 커밋 → 멈춤(리뷰 4번째 없음)
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — ${FAST_LAST}(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · ${FAST_LINEUP} · 리뷰어 claude 하나 · 라운드 2/${FAST_REVIEWS} · 2026-11-25 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 새 줄(${FAST_LAST} · 2/3) 뒤 고친 새 HEAD → 짧은 리뷰 승인 → 머지(라운드 3/${FAST_REVIEWS})" ', "autoMergeConfirm": false' yes "머지됨 — squash → main\(⚡ 빠른 길 · ${FAST_LAST} — 바뀐 부분 짧은 리뷰 후 머지\) · 짧은 리뷰 — 리뷰어 claude 하나 · 라운드 3/${FAST_REVIEWS}" FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"type":"auto.takeover".*"fast":true' "$CORE/.events.jsonl" && echo "  ✔ 새 줄 — ${FAST_LAST} 이어받기 사건 fast:true" || { echo "  ✖ 새 줄 — ${FAST_LAST} 이어받기 사건"; FAIL=1; }
rm -f "$CALLED"
AUTO_LINE="- Auto review: web#7 @$OLD7 · ⚡ 빠른 길 · ${FAST_LAST}(바뀐 부분 짧은 리뷰 후 머지) → 머지 확인 대기 · 라운드 3/${FAST_REVIEWS} · 2026-11-25 10:00" \
  EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 — 새 줄(${FAST_LAST} 머지 단계 · 3/3) 뒤 또 커밋 → 멈춤(리뷰 4번째 없음)" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한' FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q '"reason":"rounds"' "$CORE/.events.jsonl" && echo "  ✔ 새 줄 ${FAST_LAST} 뒤 멈춤 — auto.stop(rounds)" || { echo "  ✖ 새 줄 ${FAST_LAST} 뒤 멈춤 사건"; FAIL=1; }
rm -f "$CALLED"
EXTRA_PLAN="$FAST_PLAN" merge_case "빠른 길 + 리뷰 끔 레포 → 지금처럼 리뷰 없이 머지(빠른 길 표시 없음)" ', "autoReview": false, "autoMergeConfirm": false' yes '머지됨 — squash → main\(리뷰 끔'
! grep -q '"fast":true' "$CORE/.events.jsonl" && echo "  ✔ 리뷰 끔 — 사건에 fast 없음" || { echo "  ✖ 리뷰 끔 — 사건에 fast 가 붙음"; FAIL=1; }

rm -f "$CORE/.athena-main-tool.json"
} > "$GRP"; grp_end "옛 2차 줄 · 새 3차 줄 읽기 — 평소 2차 · 머지 단계 뒤 멈춤 · 3차 이어받기 · 리뷰 끔엔 fast 없음"
# 결정 콘솔 · 대체 요청이 둘 다 실패해도 — 계획서 "- Auto decisions:" 줄(등록 실패)이 남아 머지를 막는다(PR #20 2라운드 지적)
{
BLOCK_REQUESTS=1 merge_case "A — 콘솔 · 요청 둘 다 실패 → 결정 필요 · 계획서에 결정 대기(등록 실패)" ', "autoMergeConfirm": false' no "· 결정 필요 · ${FAST_LINEUP} · 리뷰어 codex 하나 · 라운드 1/${FAST_REVIEWS}" FAKE_CODEX=product
MARK="$(grep '^- Auto decisions:' "$CORE/plans/task/x.md")"
case "$MARK" in "- Auto decisions: web#7 @"*" · 1개 · 등록 실패 · "*) echo "  ✔ A — 결정 대기 줄: $MARK" ;; *) echo "  ✖ A — 결정 대기 줄이 없다: $MARK"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1 ;; esac
rm -f "$CORE/.requests"
pending_plan() {   # <결정 대기 줄> — 지난 라운드 줄 · 결정 대기 줄을 둔 계획서
  printf '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p3 (web-fe)\n- Auto review: web#7 @0000000 · 결정 필요 — 상한 뒤 이어받음(다음 커밋은 바뀐 부분 짧은 리뷰 후 머지) · 승인 1/1이지만 결정 콘솔에 안 정한 결정이 있어 머지 대기 · ⚡ 빠른 길 — 최대 3번 · 리뷰어 codex 하나 · 라운드 2/3 · s\n%s\n- PR: https://github.com/acme/web/pull/7\n' "$WT" "$1" > "$CORE/plans/task/x.md"
}
run_handle() { : > "$GH_LOG"; rm -f "$GH_LOG.views"; env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" "$@" "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1; }
printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoMergeConfirm": false } ] }\n' > "$CORE/athena.config.json"
rm -rf "$CORE/.requests"; pending_plan "$MARK"; run_handle
! grep -q '^pr merge' "$GH_LOG" && grep -q '결정 필요 — 이어받은 HEAD이지만' "$CORE/plans/task/x.md" && grep -q '^- Auto decisions: .*등록 실패' "$CORE/plans/task/x.md" \
  && echo "  ✔ A — 요청이 하나도 없어도 등록 실패 줄이 있으면 승인돼도 머지 안 함 · 줄 그대로" || { echo "  ✖ A — 등록 실패 줄로 머지가 막히지 않음"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
rm -rf "$CORE/.requests"; pending_plan "- Auto decisions: web#7 @0000000 · 1개 · 등록됨 · 결정 콘솔에서 다 정하면 저절로 지워진다 · s"; run_handle
grep -q "^pr merge 7 --repo acme/web --squash --match-head-commit $SHA" "$GH_LOG" && ! grep -q '^- Auto decisions:' "$CORE/plans/task/x.md" \
  && echo "  ✔ A — 등록됨 · 결정 요청이 닫혔으면 해결 — 줄을 지우고 머지" || { echo "  ✖ A — 등록됨 해결"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
# 리뷰어가 실패한 라운드는 지난 리뷰 기록(history)을 덮지 않는다(PR #20 2라운드 지적)
merge_case "D — 리뷰어가 실패한 라운드 → 리뷰어 부족" ', "autoMergeConfirm": false' no '· 리뷰어 부족\(승인 0/1\) · '"${FAST_LINEUP}"' · 리뷰어 codex 하나 · '"라운드 1/${FAST_REVIEWS}" FAKE_CODEX=slow ATHENA_PR_AUTO_TIMEOUT_MS=1500
[ ! -e "$TMP/queue-confirm/history/web-7.json" ] && echo "  ✔ D — 리뷰어가 실패한 라운드는 history 를 남기지 않음" || { echo "  ✖ D — 실패한 라운드가 history 를 썼다"; FAIL=1; }

} > "$GRP"; grp_end "A · D — 등록 실패 줄이 머지를 막음 · 닫히면 지우고 머지 · 리뷰어 실패 라운드는 history 안 남김"
# 결정 D — 1라운드 지적을 기록해 두고, 2라운드 프롬프트에는 지난 지적 + 지난 리뷰 HEAD 이후 바뀐 diff 만
echo; echo "지적은 한 번에(결정 D)"
{
PROMPT="$TMP/prompt.txt"
merge_case "D — 1라운드: 수정 필요 · 지난 지적 기록" ', "autoMergeConfirm": false' no "· 수정 필요 · ${FAST_LINEUP} · 리뷰어 codex 하나 · 라운드 1/${FAST_REVIEWS}" FAKE_PROMPT="$PROMPT" FAKE_CODEX=changes
grep -q "찾을 수 있는 지적을 이번 리뷰에서 모두 낸다" "$PROMPT" && ! grep -q "지난 리뷰 지적" "$PROMPT" && grep -q '"file": "a.js"' "$TMP/queue-confirm/history/web-7.json" \
  && echo "  ✔ D — 1라운드 프롬프트는 '모두 한 번에' · history 에 보낸 지적" || { echo "  ✖ D — 1라운드"; sed 's/^/      /' "$PROMPT" | head -20; FAIL=1; }
S1="$SHA"; echo 'fixed' > "$WT/a.js"; git -C "$WT" add a.js && git -C "$WT" -c user.name=t -c user.email=t@t commit -q -m fix
S2="$(git -C "$WT" rev-parse HEAD)"; : > "$GH_LOG"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$S2" GH_LOG="$GH_LOG" FAKE_PROMPT="$PROMPT" \
  "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1
grep -q "이번은 2번째 리뷰다" "$PROMPT" && grep -q "지난 리뷰 지적 (@${S1:0:7}" "$PROMPT" && grep -q "1) a.js:1 — p → f" "$PROMPT" \
  && grep -q "지난 리뷰 HEAD @${S1:0:7} 이후 바뀐 것만" "$PROMPT" && grep -q "^+fixed" "$PROMPT" \
  && ! grep -q "^pr diff" "$GH_LOG" && grep -q "· 라운드 2/${FAST_REVIEWS}" "$CORE/plans/task/x.md" \
  && echo "  ✔ D — 2라운드 프롬프트: 지난 지적 · 지난 HEAD 이후 diff 만(gh pr diff 안 부름)" || { echo "  ✖ D — 2라운드"; sed 's/^/      /' "$PROMPT" | tail -25; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
} > "$GRP"; grp_end "D — 지적은 한 번에: 1라운드 모두 · 2라운드는 지난 지적 + 그 뒤 diff 만"


[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
