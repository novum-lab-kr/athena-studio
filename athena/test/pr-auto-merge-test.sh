#!/usr/bin/env bash
# PR 자동 리뷰 시험 — 머지 확인(autoMergeConfirm · --no-merge · 리뷰 ‖ 검증 · 보안 · 알림 · 처리기가 끊긴 뒤 이어받기)
. "$(dirname "$0")/_pr-auto-lib.sh"   # 공통 준비 — test/_pr-auto-lib.sh (이 경로 글을 보고 검증 범위가 헬퍼를 따라간다)

# ── 머지 확인 — 레포가 "autoMergeConfirm": false 면 묻지 않고 바로 · 키가 없으면 지금처럼 확인 요청 ─────────
# 임시 코어 사본(옛 구조 본체 · athena.config.json)에서 가짜 gh · 가짜 리뷰어(승인) · 가짜 검증(reuse.sh 통과)으로 handle 을 끝까지 돌린다
echo; echo "머지 확인(autoMergeConfirm)"
confirm_core
{
merge_case "키 없음 → 머지 확인 요청만(머지 안 함)" "" no '머지 확인 대기'
[ -n "$(ls "$CORE/.requests" 2>/dev/null)" ] && echo "  ✔ 키 없음 → 확인 요청이 열림" || { echo "  ✖ 키 없음인데 확인 요청이 없다"; FAIL=1; }
merge_case "autoMergeConfirm: true → 지금처럼 확인 요청" ', "autoMergeConfirm": true' no '머지 확인 대기'
} > "$GRP"; grp_end "머지 확인 — 키 없음 · true 면 확인 요청(머지 안 함)"
# --no-merge(2026-11-08 아테나 요청) — 확인 없는 레포라도 승인 · 같은 HEAD 검증 · 충돌 확인 뒤 머지하지 않고 측정값을 찍는다 · 리뷰는 실제로(댓글 · 사건)
{
PR_AUTO_FLAG=--no-merge merge_case "--no-merge — 승인이어도 머지 바로 앞에서 멈춤" ', "autoMergeConfirm": false' no '승인 1/1 → 머지 안 함\(--no-merge\)'
grep -q '머지 안 함(--no-merge)' "$TMP/merge.out" && grep -q '측정: web#7 · .* · 리뷰 1번 · 검증 0번 · 토큰 모름 · 이 처리의 검증 실행 1번' "$TMP/merge.out" \
  && grep -q '^pr review 7' "$GH_LOG" && grep -q '"reason":"no-merge"' "$CORE/.events.jsonl" && [ ! -e "$TMP/queue-confirm/confirm/web-7.json" ] \
  && echo "  ✔ --no-merge — 댓글은 달고 · 측정값 출력 · 머지 job 없음 · auto.stop(no-merge)" || { echo "  ✖ --no-merge — 출력 · 사건"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
PR_AUTO_FLAG=--no-merge merge_case "--no-merge — 수정 필요면 수정 지시까지는 평소대로" ', "autoMergeConfirm": false' no '수정 필요' FAKE_CODEX=changes
} > "$GRP"; grp_end "--no-merge — 승인이어도 머지 앞에서 멈춤(댓글 · 측정 · auto.stop) · 수정 필요는 평소대로"
# 리뷰 ‖ 검증(2026-11-08 #267) — 같은 HEAD 검증이 리뷰 댓글보다 먼저 시작하고(동시) 머지 앞에서 한 번만 돈다 · 승인이 아니면 도는 검증을 멈춘다
{
VLOG="$TMP/verify-order.log"; : > "$VLOG"
merge_case "리뷰 ‖ 검증 — 승인 → 바로 머지 · 검증은 한 번" ', "autoMergeConfirm": false' yes '머지됨' FAKE_VERIFY_LOG="$VLOG"
[ "$(grep -c verify-start "$VLOG")" = 1 ] && grep -q '같은 HEAD 검증을 리뷰와 동시에 시작' "$TMP/merge.out" \
  && echo "  ✔ 리뷰 ‖ 검증 — 리뷰어 앞에서 띄움 · 머지 앞 검증은 같은 약속(한 번)" || { echo "  ✖ 리뷰 ‖ 검증 — 횟수 $(grep -c verify-start "$VLOG")"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
: > "$VLOG"; started="$(date +%s)"
merge_case "리뷰 ‖ 검증 — 수정 필요 → 도는 검증을 멈춤(끝까지 기다리지 않음)" ', "autoMergeConfirm": false' no '수정 필요' FAKE_VERIFY_LOG="$VLOG" FAKE_VERIFY_SLEEP=20 FAKE_CODEX=changes
took=$(( $(date +%s) - started ))
grep -q verify-start "$VLOG" && ! grep -q verify-end "$VLOG" && [ "$took" -lt 15 ] \
  && echo "  ✔ 수정 필요 — 검증 멈춤(${took}초 · 끝 줄 없음)" || { echo "  ✖ 수정 필요 — 검증이 멈추지 않음(${took}초 · $(tr '\n' ' ' < "$VLOG"))"; FAIL=1; }
} > "$GRP"; grp_end "리뷰 ‖ 검증 — 승인이면 검증 한 번 뒤 머지 · 수정 필요면 도는 검증을 멈춤"
# 리뷰 · 머지 나누기(docs/pr-auto.md "켜기") — FAKE_CODEX=ok 라도 리뷰 끔이면 리뷰어를 부르지 않는다(PR 댓글 없음)
no_comment() { if grep -q '^pr comment' "$GH_LOG"; then echo "  ✖ $1 — 리뷰 댓글이 달렸다"; FAIL=1; else echo "  ✔ $1 — 리뷰 댓글 없음"; fi; }
no_request() { if [ -n "$(ls "$CORE/.requests" 2>/dev/null)" ]; then echo "  ✖ $1 — 요청이 열렸다"; FAIL=1; else echo "  ✔ $1 — 요청 없음"; fi; }
{
merge_case "켬/끔/확인 → 리뷰 없이 머지 확인 요청" ', "autoReview": false' no '리뷰 끔.* → 머지 확인 대기'
no_comment "켬/끔/확인"
[ -n "$(ls "$CORE/.requests" 2>/dev/null)" ] && echo "  ✔ 켬/끔/확인 → [머지] 요청이 열림" || { echo "  ✖ 켬/끔/확인인데 요청이 없다"; FAIL=1; }
merge_case "켬/끔/자동 → 검증 · 충돌 뒤 바로 squash" ', "autoReview": false, "autoMergeConfirm": false' yes '머지됨 — squash → main\(리뷰 끔'
no_comment "켬/끔/자동"; no_request "켬/끔/자동"
} > "$GRP"; grp_end "리뷰 끔 — 확인이면 요청만 · 자동이면 바로 squash(둘 다 리뷰 댓글 없음)"
# 머지 전 검사(docs/pr-auto.md "머지 전 검사") — 워크트리에 scripts/merge-gate.js 가 있으면 PR 제목으로 돌고, 실패면 머지하지 않는다
mkdir -p "$WT/scripts"
cat > "$WT/scripts/merge-gate.js" <<'JS'
require('fs').appendFileSync(process.env.GH_LOG + '.gate', process.argv.slice(2).join(' ') + '\n')
if (process.env.FAKE_GATE_FAIL) { console.error('feat 제목인데 CHANGELOG 절이 없다'); process.exit(1) }
JS
rm -f "$GH_LOG.gate"
{
FAKE_GATE_FAIL=1 merge_case "머지 전 검사 실패 → 머지 안 함 · 줄에 이유" ', "autoReview": false, "autoMergeConfirm": false' no '검증 대기 — 머지 전 검사 실패 — feat 제목인데 CHANGELOG 절이 없다'
merge_case "머지 전 검사 통과 → 머지" ', "autoReview": false, "autoMergeConfirm": false' yes '머지됨 — squash → main'
grep -qx -- '--title t' "$GH_LOG.gate" && echo "  ✔ 머지 전 검사에 PR 제목을 넘긴다" || { echo "  ✖ 머지 전 검사 인자: $(cat "$GH_LOG.gate" 2>/dev/null)"; FAIL=1; }
} > "$GRP"; grp_end "머지 전 검사 — 실패면 머지 안 함 · 통과면 머지 · PR 제목을 넘김"
rm -rf "$WT/scripts" "$GH_LOG.gate"
{
merge_case "켬/켬/직접 → 리뷰 승인까지 · 머지 요청 없음" ', "autoMergeManual": true' no '승인 1/1 → 사람이 직접 머지'
no_request "켬/켬/직접"
merge_case "직접 + autoMergeConfirm false → 직접이 먼저" ', "autoMergeManual": true, "autoMergeConfirm": false' no '사람이 직접 머지'
PENDING=1 merge_case "켬/끔/자동 + 안 정한 결정 → 머지 안 함" ', "autoReview": false, "autoMergeConfirm": false' no '결정'
} > "$GRP"; grp_end "사람이 직접 · 안 정한 결정 → 머지 안 함"
# 대기 중에 설정이 바뀜 — 켬/끔/확인 건의 [머지] 요청이 열린 채 사람이 직접으로 돌리면 머지하지 않고 요청을 닫는다
{
merge_case "켬/끔/확인 대기" ', "autoReview": false' no '머지 확인 대기'
printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoReview": false, "autoMergeManual": true } ] }\n' > "$CORE/athena.config.json"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
  const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
if ! grep -q '^pr merge' "$GH_LOG" && grep -q '검증 대기 — 머지 전에 설정이 바뀜' "$CORE/plans/task/x.md" && [ -z "$(ls "$TMP/queue-confirm/confirm" 2>/dev/null)" ]; then echo "  ✔ 대기 중 사람이 직접으로 → 머지 안 함 · 줄 남김 · 대기 파일 없음"; else echo "  ✖ 대기 중 사람이 직접으로"; cat "$TMP/merge.out"; FAIL=1; fi
# 대기 중에 PR base 가 바뀜 — 확인한 대상과 다르니 머지하지 않는다(가짜 gh 는 base main 으로 답한다 · 대기 파일을 dev 로 바꿔 흉내)
merge_case "base 변경 시험 — 확인 대기" '' no '머지 확인 대기'
BASE_JOB="$(ls "$TMP/queue-confirm/confirm/"*.json | head -1)"
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['base']='dev'; json.dump(d, open(p,'w'))" "$BASE_JOB"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
  const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
if ! grep -q '^pr merge' "$GH_LOG" && grep -q '검증 대기 — 머지 전에 base 가 바뀜(dev → main)' "$CORE/plans/task/x.md" && [ -z "$(ls "$TMP/queue-confirm/confirm" 2>/dev/null)" ] && grep -lq '"state": *"cancelled"' "$CORE/.requests"/*/request.json "$CORE/.requests"/*.json 2>/dev/null; then echo "  ✔ 확인 대기 중 base 변경 → 머지 안 함 · 요청 닫음 · 줄에 이유"; else echo "  ✖ 확인 대기 중 base 변경"; grep -o '^- Auto review: .*' "$CORE/plans/task/x.md"; ls -R "$CORE/.requests" | head; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; fi
# 확인 없는 머지도 같다
rm -rf "$TMP/queue-confirm"; mkdir -p "$TMP/queue-confirm/confirm"; : > "$GH_LOG"; rm -f "$GH_LOG.views"
printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoMergeConfirm": false } ] }\n' > "$CORE/athena.config.json"
printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":1,"worktree":"%s","base":"dev","root":"%s","packId":null,"request":null,"noConfirm":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
  const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
if ! grep -q '^pr merge' "$GH_LOG" && grep -q '검증 대기 — 머지 전에 base 가 바뀜(dev → main)' "$CORE/plans/task/x.md" && [ -z "$(ls "$TMP/queue-confirm/confirm" 2>/dev/null)" ]; then echo "  ✔ 확인 없는 대기 중 base 변경 → 머지 안 함 · 줄에 이유"; else echo "  ✖ 확인 없는 대기 중 base 변경"; grep -o '^- Auto review: .*' "$CORE/plans/task/x.md"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; fi
# 위임 뒤 설정을 바꾸어도 실행 단계는 현재 설정으로 다시 판정한다(가짜 gh · 실제 머지는 없음).
for CHANGED_SETTING in '"autoMerge": false' '"autoMerge": true, "autoMergeManual": true, "autoMergeConfirm": false' '"autoMerge": true, "autoMergeConfirm": true' '"autoMerge": true, "autoMergeConfirm": false, "autoReview": true'; do
  rm -rf "$TMP/queue-confirm"; mkdir -p "$TMP/queue-confirm/confirm"; : > "$GH_LOG"; rm -f "$GH_LOG.views"
  printf '{ "github": { "org": "acme" }, "repos": [{ "name": "web", "prBase": "main", %s }] }\n' "$CHANGED_SETTING" > "$CORE/athena.config.json"
  printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":1,"worktree":"%s","base":"main","root":"%s","packId":null,"request":null,"noConfirm":true,"reviewOff":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json"
  env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
    const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
  expect "실행 시 최신 설정 재확인: $CHANGED_SETTING" '! grep -q "^pr merge" "$GH_LOG" && grep -q "검증 대기 — 머지 전에 설정이 바뀜" "$CORE/plans/task/x.md" && [ ! -f "$TMP/queue-confirm/confirm/web-7.json" ]' "$(cat "$TMP/merge.out")"
done
} > "$GRP"; grp_end "대기 중 설정 · base 가 바뀌면 머지 안 함(확인 · 확인 없음 · 실행 때 최신 설정)"
{
merge_case "autoMergeConfirm: false → 요청 없이 draft 풀고 squash 머지" ', "autoMergeConfirm": false' yes '머지됨 — squash → main'
# PR 안에 merge 커밋(부모 2개)이 있으면 --merge — squash 하면 그 merge 커밋이 base 기록에서 빠져 다음 합치기에 같은 충돌(athena-studio#324)
WANT_METHOD=merge WT="$WT_MERGE" SHA="$SHA_MERGE" merge_case "PR 안에 merge 커밋(끝이 아님) → --merge 로 머지 · 줄에 merge 커밋" ', "autoMergeConfirm": false' yes '머지됨 — merge 커밋 → main'
! grep -q -e "--squash" "$GH_LOG" && ! grep -q "^api " "$GH_LOG" \
  && echo "  ✔ merge 커밋 PR — squash 를 부르지 않고 GitHub 커밋 목록(250개 상한)에 기대지 않음" || { echo "  ✖ merge 커밋 PR — gh 호출"; sed 's/^/      /' "$GH_LOG"; FAIL=1; }
# base 를 못 받으면(전체 커밋을 못 셈) squash 로 넘어가지 않고 머지하지 않는다
WT="$WT_NOFETCH" merge_case "base 를 못 받음 → 머지 안 함 · 줄에 이유" ', "autoMergeConfirm": false' no '머지 방식을 정하지 못함'
} > "$GRP"; grp_end "autoMergeConfirm false 머지 — squash · PR 안 merge 커밋은 --merge · base 못 받으면 머지 안 함"
# 보안 검토 문(PR 머지) — 위험한 수정 PR 이면 리뷰어와 함께 security-reviewer 를 띄우고, 이 HEAD 결과가 없으면 머지하지 않는다
printf 'diff --git a/run.mjs b/run.mjs\n--- a/run.mjs\n+++ b/run.mjs\n@@ -0,0 +1 @@\n+export const run = (args) => spawnSync("git", args)\n' > "$TMP/risky.diff"
cp "$CORE/scripts/delegate.sh" "$TMP/delegate.sh.real"
cat > "$CORE/scripts/delegate.sh" <<'SH'
#!/bin/sh
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
printf 'delegate %s\n' "$*" >> "$FAKE_DELEGATE_LOG"
PLAN=""; while [ $# -gt 0 ]; do case "$1" in --plan) PLAN="$2"; shift 2 ;; *) shift ;; esac; done
printf -- '- Security review: /w · 📦 web · 🌿 feat/x · pane p8 (security-reviewer) · 띄움 %s\n' "$(date '+%Y-%m-%d %H:%M')" >> "$ROOT/$PLAN"
# 가짜 PR 은 워크트리 tree 를 모른다 — tree 없는 결과 줄(같은 커밋으로만 본다)
[ "${FAKE_SECURITY:-none}" = clean ] && printf -- '- Security result: 높음 0 · 중간 0 @%s · 📦 web · 🌿 feat/x · %s · 가짜\n' "$FAKE_SHA" "$(date '+%Y-%m-%d %H:%M')" >> "$ROOT/$PLAN"
exit 0
SH
chmod +x "$CORE/scripts/delegate.sh"; cp "$CORE/scripts/delegate.sh" "$TMP/delegate.sh.fake"; PDLOG="$TMP/pr-delegate.log"
{
: > "$PDLOG"; FAKE_PANES='{"id":"p8"}' WT="$WT_RISKY" SHA="$SHA_RISKY" merge_case "보안 — 위험한 수정 PR · 결과 없음 → 머지 안 함" ', "autoMergeConfirm": false' no '보안 검토 기다리는 중 — 위험한 수정\(명령 실행\)' FAKE_SELF_PANE=p0 FAKE_PR_DIFF="$TMP/risky.diff" FAKE_DELEGATE_LOG="$PDLOG" ATHENA_DIRECT_REVIEW_POLL_MS=100 ATHENA_DIRECT_REVIEW_TIMEOUT_MS=1500
[ "$(grep -c '^delegate security-reviewer --cwd .* --here --plan plans/task/x.md' "$PDLOG")" = 1 ] && echo "  ✔ 위험한 수정 PR — security-reviewer 를 한 번 띄웠다" || { echo "  ✖ PR 보안 띄우기 — $(cat "$PDLOG")"; FAIL=1; }
: > "$PDLOG"; WT="$WT_RISKY" SHA="$SHA_RISKY" merge_case "보안 — 위험한 수정 PR · 이 HEAD 결과 높음 0 → 머지" ', "autoMergeConfirm": false' yes '머지됨 — squash → main' FAKE_SELF_PANE=p0 FAKE_PR_DIFF="$TMP/risky.diff" FAKE_DELEGATE_LOG="$PDLOG" FAKE_SECURITY=clean ATHENA_DIRECT_REVIEW_POLL_MS=100 ATHENA_DIRECT_REVIEW_TIMEOUT_MS=1500
: > "$PDLOG"; merge_case "보안 — 위험하지 않은 PR → 띄우지 않고 머지" ', "autoMergeConfirm": false' yes '머지됨 — squash → main' FAKE_DELEGATE_LOG="$PDLOG"
[ ! -s "$PDLOG" ] && echo "  ✔ 위험하지 않은 PR — security-reviewer 안 띄움" || { echo "  ✖ 위험하지 않은데 띄움 — $(cat "$PDLOG")"; FAIL=1; }
} > "$GRP"; grp_end "보안 — 위험한 PR 은 security-reviewer 한 번 · 결과 없으면 멈춤 · 높음 0 이면 머지 · 위험하지 않으면 안 띄움"
cp "$TMP/delegate.sh.real" "$CORE/scripts/delegate.sh"
{
grep -q '^pr ready 7 --repo acme/web' "$GH_LOG" && [ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] && [ -z "$(ls "$TMP/queue-confirm/confirm" 2>/dev/null)" ] \
  && echo "  ✔ autoMergeConfirm: false → gh pr ready 뒤 머지 · 요청 · 대기 파일 남지 않음" || { echo "  ✖ draft 풀기 · 요청 · 대기 파일 확인 실패"; FAIL=1; }
grep -q '"auto.merge".*"confirm":false' "$CORE/.events.jsonl" 2>/dev/null \
  && echo "  ✔ 사건 기록 auto.merge 에 confirm:false" || { echo "  ✖ 사건 기록에 확인 없는 머지가 없다"; FAIL=1; }
} > "$GRP"; grp_end "확인 없는 머지 — gh pr ready · 요청 · 대기 파일 안 남음 · 사건 confirm:false"
cp "$CORE/scripts/delegate.sh" "$TMP/delegate.sh.real"
cp "$TMP/delegate.sh.fake" "$CORE/scripts/delegate.sh"
# 화면 pane 밖(현황판의 pr-auto)에서도 띄운다 — 계획서 Lead pane 옆(delegate.sh --beside · 2026-11-12 PR #293 — "Athena Studio 밖입니다" 로 못 띄워 머지가 멈췄다)
{
: > "$PDLOG"; EXTRA_PLAN="- Lead pane: p91
" WT="$WT_RISKY" SHA="$SHA_RISKY" merge_case "보안 — pane 밖 · Lead pane 있음 → 그 옆에 띄우고 기다림" ', "autoMergeConfirm": false' no '보안 검토 기다리는 중' FAKE_PR_DIFF="$TMP/risky.diff" FAKE_DELEGATE_LOG="$PDLOG" ATHENA_DIRECT_REVIEW_POLL_MS=100 ATHENA_DIRECT_REVIEW_TIMEOUT_MS=1500
grep -q '^delegate security-reviewer --cwd .* --beside p91 --plan plans/task/x.md' "$PDLOG" && echo "  ✔ pane 밖 — Lead pane(p91) 옆에 security-reviewer 를 띄웠다(--beside)" || { echo "  ✖ pane 밖 띄우기 — $(cat "$PDLOG")"; FAIL=1; }
: > "$PDLOG"; WT="$WT_RISKY" SHA="$SHA_RISKY" merge_case "보안 — pane 밖 · Lead pane 없음 → 못 띄움 · 머지 안 함" ', "autoMergeConfirm": false' no '보안 검토 못 함 — security-reviewer 를 띄울 자리가 없음' FAKE_PR_DIFF="$TMP/risky.diff" FAKE_DELEGATE_LOG="$PDLOG"
[ ! -s "$PDLOG" ] && { grep -q '보안 검토 못 띄움' "$TMP/merge.out" || grep -rq '보안 검토 못 띄움' "$CORE/.requests" 2>/dev/null; } && echo "  ✔ 못 띄우면 아테나에 알린다(손으로 띄우면 이어서 머지)" || { echo "  ✖ 못 띄움 알림 — $(cat "$PDLOG")"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
} > "$GRP"; grp_end "보안 — pane 밖이면 Lead pane 옆(--beside) · 없으면 못 띄움 알림"
# 보안 검토로 멈춘 같은 HEAD 에 결과(높음 0)가 그 뒤 남으면 — 리뷰를 다시 하지 않고 같은 라운드에서 머지(줄을 지우면 라운드 1 부터 다시 리뷰했다)
WT_KEEP="$WT" SHA_KEEP="$SHA"; WT="$WT_RISKY" SHA="$SHA_RISKY"   # 아래 멈춘 HEAD 묶음은 위험한 수정 워크트리로
STOP_LINE="- Auto review: web#7 @${SHA:0:7} · 보안 검토 때문에 멈춤 — 승인 1/1이지만 보안 검토 못 함 — x · 라운드 1/${FAST_REVIEWS} · $(date '+%Y-%m-%d') 00:00"
{
: > "$PDLOG"; AUTO_LINE="$STOP_LINE" EXTRA_PLAN="- Security result: 높음 0 · 중간 1 @$SHA · 📦 web · 🌿 feat/x · $(date '+%Y-%m-%d %H:%M') · 가짜
" merge_case "보안 — 멈춘 HEAD 에 결과 높음 0 → 리뷰 없이 같은 라운드에서 머지" ', "autoMergeConfirm": false' yes "머지됨 — squash → main.*라운드 1/${FAST_REVIEWS}" FAKE_PR_DIFF="$TMP/risky.diff" FAKE_DELEGATE_LOG="$PDLOG"
grep -q '머지 단계를 이어 간다' "$TMP/merge.out" && ! grep -q '리뷰어 구성\|↪ 리뷰어' "$TMP/merge.out" && [ ! -s "$PDLOG" ] && echo "  ✔ 리뷰를 다시 돌리지 않고 이어 갔다 · security-reviewer 도 다시 안 띄움" || { echo "  ✖ 이어 가기 — $(cat "$PDLOG")"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
: > "$PDLOG"; AUTO_LINE="$STOP_LINE" EXTRA_PLAN="- Security result: 높음 1 · 중간 0 @$SHA · 📦 web · 🌿 feat/x · $(date '+%Y-%m-%d %H:%M') · 가짜
" merge_case "보안 — 멈춘 HEAD 결과가 높음 1 → 이어 가지 않음(고친 커밋을 기다린다)" ', "autoMergeConfirm": false' no '보안 검토 때문에 멈춤' FAKE_PR_DIFF="$TMP/risky.diff" FAKE_DELEGATE_LOG="$PDLOG"
grep -q '이미 봤거나' "$TMP/merge.out" && echo "  ✔ 높음이 남은 결과면 같은 HEAD 를 다시 돌지 않는다" || { echo "  ✖ 높음 결과에 다시 돎"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
# 같은 HEAD 에 옛 높음 0 뒤 새 높음 1 이 오면 마지막 줄로 판정 — 이어 가지 않는다(PR #294 리뷰 — some() 이 옛 결과를 골랐다)
: > "$PDLOG"; AUTO_LINE="$STOP_LINE" EXTRA_PLAN="- Security result: 높음 0 · 중간 0 @$SHA · 📦 web · 🌿 feat/x · $(date '+%Y-%m-%d %H:%M') · 옛 결과
- Security result: 높음 1 · 중간 0 @$SHA · 📦 web · 🌿 feat/x · $(date '+%Y-%m-%d %H:%M') · 새 결과
" merge_case "보안 — 같은 HEAD 옛 높음 0 · 새 높음 1 → 마지막 줄로 이어 가지 않음" ', "autoMergeConfirm": false' no '보안 검토 때문에 멈춤' FAKE_PR_DIFF="$TMP/risky.diff" FAKE_DELEGATE_LOG="$PDLOG"
WT="$WT_KEEP" SHA="$SHA_KEEP"
grep -q '이미 봤거나' "$TMP/merge.out" && ! grep -q '머지 단계를 이어 간다' "$TMP/merge.out" && echo "  ✔ 마지막 결과(높음 1)로 판정 — 옛 높음 0 을 고르지 않는다" || { echo "  ✖ 옛 결과로 이어 감"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
} > "$GRP"; grp_end "보안 — 멈춘 HEAD 결과 높음 0 이면 같은 라운드 머지 · 높음 1 · 마지막 줄이 높음이면 이어 가지 않음"
cp "$TMP/delegate.sh.real" "$CORE/scripts/delegate.sh"
# 처리기가 잡은 채로 죽은 파일(<이름>.json.<죽은 pid>)은 원래 이름으로 돌려놓는다(산 pid 것은 그대로) — 처리기 시작 · --kick 이 부른다
{
mkdir -p "$TMP/queue-confirm/confirm"; echo '{}' > "$TMP/queue-confirm/confirm/web-8.json.999999"; echo '{}' > "$TMP/queue-confirm/confirm/web-9.json.$$"
env ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" "$(command -v node)" --input-type=module -e "
  const { restoreClaims } = await import('$CORE/scripts/pr-auto.mjs'); restoreClaims()" >/dev/null 2>&1
[ -f "$TMP/queue-confirm/confirm/web-8.json" ] && [ ! -e "$TMP/queue-confirm/confirm/web-8.json.999999" ] && [ -f "$TMP/queue-confirm/confirm/web-9.json.$$" ] \
  && echo "  ✔ 죽은 처리기가 잡은 파일은 되돌림 · 산 처리기 것은 그대로" || { echo "  ✖ 잡은 파일 되돌리기"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 돌고 있는 처리기도 — 다른 실행이 잡은 채로 끝난 확인 없는 대기 파일(죽은 pid)을 머지 확인 보기(checkConfirms)에서 되돌려 이어서 머지한다
rm -rf "$TMP/queue-confirm"; mkdir -p "$TMP/queue-confirm/confirm"; : > "$GH_LOG"; rm -f "$GH_LOG.views"
printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":1,"worktree":"%s","base":"main","root":"%s","packId":null,"request":null,"noConfirm":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json.999999"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
  const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
grep -q "^pr merge 7 --repo acme/web --squash --match-head-commit $SHA" "$GH_LOG" && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ 돌고 있는 처리기가 남의 잡은 파일(죽은 pid)을 되돌려 머지 · 파일 남지 않음" || { echo "  ✖ 처리기의 잡은 파일 되돌리기 · 머지"; sed 's/^/      /' "$TMP/merge.out"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 머지 직전 검증 도중 처리기가 죽어도 — 잡은 파일이 남아(지우지 않음) 되돌리면 다시 볼 수 있다
rm -rf "$TMP/queue-confirm"; mkdir -p "$TMP/queue-confirm/confirm"; : > "$GH_LOG"; rm -f "$GH_LOG.views"
printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":1,"worktree":"%s","base":"main","root":"%s","packId":null,"request":null,"noConfirm":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json"
( env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" FAKE_VERIFY_KILL=1 "$(command -v node)" --input-type=module -e "
  const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > /dev/null 2>&1; true ) 2>/dev/null   # 셸의 "Killed" 알림까지 숨긴다
claimed="$(ls "$TMP/queue-confirm/confirm" | grep -E '^web-7\.json\.[0-9]+$')"
env ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" "$(command -v node)" --input-type=module -e "
  const { restoreClaims } = await import('$CORE/scripts/pr-auto.mjs'); restoreClaims()" >/dev/null 2>&1
[ -n "$claimed" ] && [ -f "$TMP/queue-confirm/confirm/web-7.json" ] && ! grep -q '^pr merge' "$GH_LOG" \
  && echo "  ✔ 검증 도중 처리기가 죽으면 잡은 파일이 남고(머지 안 함) 되돌려 다시 본다" || { echo "  ✖ 검증 도중 죽은 뒤 잡은 파일 남기기 — 남은 것: $(ls "$TMP/queue-confirm/confirm")"; FAIL=1; }
} > "$GRP"; grp_end "잡은 파일 되돌리기 — 죽은 pid 만 · 도는 처리기도 이어 머지 · 검증 도중 죽으면 파일 남김"
{
merge_case "autoMergeConfirm: false 라도 머지 직전에 새 커밋 → 머지 안 함" ', "autoMergeConfirm": false' no '바로 머지' FAKE_GH_HEAD_AFTER=1
merge_case "autoMergeConfirm: false 라도 검증 실패 → 머지 안 함" ', "autoMergeConfirm": false' no '검증 대기' FAKE_VERIFY_FAIL=1
grep -q '"title": "자동 리뷰 승인 · 검증 못 함' "$CORE/.requests"/*.json 2>/dev/null && echo "  ✔ 아테나 pane 이 없으면 검증 못 함도 지금처럼 요청으로 남긴다" || { echo "  ✖ 아테나 pane 이 없는데 요청이 없다"; FAIL=1; }
} > "$GRP"; grp_end "확인 없음이라도 머지 직전 새 커밋 · 검증 실패면 머지 안 함(아테나 pane 없으면 요청)"

# 고를 것 없는 상태 알림은 요청으로 열지 않고 아테나 pane 에(2026-10-28 사용자) — 요청은 머지 확인 · 결정 콘솔만
SLOG="$TMP/screen.log"
ATHENA_PANE="{\"id\":\"p50\",\"agent\":\"claude\",\"cwd\":\"$CORE\",\"label\":\"🧭 아테나\"},{\"id\":\"p3\",\"agent\":\"claude\",\"cwd\":\"$CORE\",\"label\":\"🤖 web-fe · feat/x\"}"
{
: > "$SLOG"
merge_case "검증 못 함 + 아테나 pane 있음 → 요청 없이 아테나 pane 에" ', "autoMergeConfirm": false' no '검증 대기' FAKE_VERIFY_FAIL=1 FAKE_PANES="$ATHENA_PANE" FAKE_SCREEN_LOG="$SLOG"
[ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] && grep -q "^screen pane send-text p50 \[자동 리뷰 → 아테나\] 자동 리뷰 승인 · 검증 못 함 — web#7 — .* --enter$" "$SLOG" && ! grep -q "send-keys" "$SLOG" && ! grep -q "send-text p3 " "$SLOG" \
  && echo "  ✔ 요청 없음 · 살아 있는 아테나 pane(p50)에 한 줄 · 작업 pane(🤖)에는 안 보냄" || { echo "  ✖ 아테나 pane 알림"; ls "$CORE/.requests" 2>/dev/null; sed 's/^/      /' "$SLOG"; FAIL=1; }
# 다시 돌린 결과는 다시 알린다(결정 R1) — 계획서 줄을 지우고 다시 돌리면 그 PR 의 .notified 기록을 지우고 같은 HEAD · 제목도 다시 보낸다
: > "$SLOG"
sed -i.bak '/^- Auto review:/d' "$CORE/plans/task/x.md" && rm -f "$CORE/plans/task/x.md.bak"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" FAKE_VERIFY_FAIL=1 FAKE_PANES="$ATHENA_PANE" FAKE_SCREEN_LOG="$SLOG" \
  "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1
grep -q "^screen pane send-text p50 \[자동 리뷰 → 아테나\] 자동 리뷰 승인 · 검증 못 함" "$SLOG" && [ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] && ! grep -q "이미 알렸다" "$TMP/merge.out" \
  && echo "  ✔ 줄을 지워 다시 돌리면 기록을 지우고 같은 HEAD · 제목도 다시 알림(R1 · 요청은 안 엶)" || { echo "  ✖ 다시 돌린 결과를 다시 알리지 않았다"; sed 's/^/      /' "$SLOG" "$TMP/merge.out"; FAIL=1; }
} > "$GRP"; grp_end "상태 알림 — 아테나 pane 에 한 줄(요청 없음) · 다시 돌리면 다시 알림"
# 아테나 pane 에 질문 · 고르기 창이 떠 있으면 넣지 않고 미룬다(#100 — 글이 창에 먹히고 Enter 가 1번을 고른다) · 처리기가 창이 닫히면 넣는다
{
: > "$SLOG"
MENU='  ❯ 1. 예
    2. 아니오
  Enter to select · ↑/↓ to navigate · Esc to cancel'
WATCHER_HELD=1 merge_case "검증 못 함 + 아테나 pane 에 질문 창 → 미룸" ', "autoMergeConfirm": false' no '검증 대기' FAKE_VERIFY_FAIL=1 FAKE_PANES="$ATHENA_PANE" FAKE_SCREEN_LOG="$SLOG" FAKE_PANE_TEXT="$MENU"
[ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] && ! grep -q "send-text\|send-keys" "$SLOG" && [ "$(ls "$TMP/queue-confirm/notices" 2>/dev/null | wc -l | tr -d ' ')" = 1 ] && grep -q "pr-auto:web#7" "$TMP/queue-confirm/.notified" \
  && echo "  ✔ 질문 창이 떠 있으면 글 · Enter 를 넣지 않고 미룬 대기열(notices/)에 · 중복 방지는 받은 뒤에 기록" || { echo "  ✖ 질문 창 미루기"; sed 's/^/      /' "$SLOG" "$TMP/merge.out"; FAIL=1; }
flush_notices() { (cd "$CORE" && env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_PANES="$ATHENA_PANE" FAKE_SCREEN_LOG="$SLOG" FAKE_PANE_TEXT="$1" \
  "$(command -v node)" --input-type=module -e "await (await import('./scripts/pr-auto.mjs')).flushNotices()" > "$TMP/flush.out" 2>&1); }
: > "$SLOG"; flush_notices "$MENU"
! grep -q "send-text" "$SLOG" && [ -n "$(ls "$TMP/queue-confirm/notices" 2>/dev/null)" ] \
  && echo "  ✔ 창이 아직 떠 있으면 처리기도 넣지 않고 기다린다" || { echo "  ✖ 창이 떠 있는데 넣었다"; sed 's/^/      /' "$SLOG"; FAIL=1; }
: > "$SLOG"; flush_notices "> "
grep -q "^screen pane send-text p50 \[자동 리뷰 → 아테나\] 자동 리뷰 승인 · 검증 못 함.* --enter$" "$SLOG" && ! grep -q "send-keys" "$SLOG" && [ -z "$(ls "$TMP/queue-confirm/notices" 2>/dev/null)" ] && [ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] \
  && echo "  ✔ 창이 닫히면 처리기가 미룬 알림을 넣고 대기열에서 지운다" || { echo "  ✖ 미룬 알림 넣기"; sed 's/^/      /' "$SLOG" "$TMP/flush.out"; FAIL=1; }
# 공통 전송 경로의 실패 갈래 — 데몬이 쓰기 전에 거절하면(질문 창 · 다른 전송 중) 미룬 알림을 남겨 두고, 전송을 확인 못 하면 다시 넣지 않고 요청으로
mkdir -p "$TMP/queue-confirm/notices"
printf '%s' '{"plan":"plans/task/x.md","key":"pr-auto:web#7:send","mark":"m","title":"전송 실패 흉내","body":"본문","text":"[자동 리뷰 → 아테나] 전송 실패 흉내 — 본문","pane":"p50"}' > "$TMP/queue-confirm/notices/1-send.json"
: > "$SLOG"; FAKE_SEND_FAIL=refuse flush_notices "> "
[ -n "$(ls "$TMP/queue-confirm/notices" 2>/dev/null)" ] && [ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] && grep -q "^screen pane send-text p50 .* --enter$" "$SLOG" \
  && echo "  ✔ 데몬이 쓰기 전에 거절하면 미룬 알림을 남겨 둔다(요청 안 엶)" || { echo "  ✖ 쓰기 전 거절"; sed 's/^/      /' "$SLOG" "$TMP/flush.out"; FAIL=1; }
: > "$SLOG"; FAKE_SEND_FAIL=lost flush_notices "> "
[ -z "$(ls "$TMP/queue-confirm/notices" 2>/dev/null)" ] && grep -q '"title": "전송 실패 흉내"' "$CORE/.requests"/*.json 2>/dev/null && [ "$(grep -c "send-text" "$SLOG")" = 1 ] \
  && echo "  ✔ 전송을 확인 못 하면 다시 넣지 않고 요청으로 남긴다" || { echo "  ✖ 확인 못 한 전송"; sed 's/^/      /' "$SLOG" "$TMP/flush.out"; ls "$CORE/.requests" 2>/dev/null; FAIL=1; }
} > "$GRP"; grp_end "아테나 pane 질문 창 — 미룸 · 떠 있으면 기다림 · 닫히면 넣음 · 쓰기 전 거절은 남김 · 확인 못 한 전송은 요청"
rm -rf "$CORE/.requests"
# 중복 방지 기록(.notified)은 리뷰 작업이 아니다 — 대기열에 그것만 있으면 --kick 이 처리기를 띄우지 않는다(PR #103 라운드 2)
KQ="$TMP/queue-kick"; rm -rf "$KQ"; mkdir -p "$KQ"; cp "$TMP/queue-confirm/.notified" "$KQ/"
(cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$KQ" "$(command -v node)" scripts/pr-auto.mjs --kick > "$TMP/kick.out" 2>&1)
[ -s "$KQ/.notified" ] && [ ! -e "$KQ/.launching" ] && ! grep -q "처리기를 뒤에서 시작" "$TMP/kick.out" && [ -z "$(ls "$KQ" | grep '\.json$')" ] \
  && echo "  ✔ 기록 파일만 있으면 --kick 이 처리기를 띄우지 않는다(*.json 모양이 아님)" || { echo "  ✖ 기록 파일을 작업으로 봤다"; ls -a "$KQ"; cat "$TMP/kick.out"; FAIL=1; }
# 사람이 [머지] 를 고른 뒤 검증 · 머지 도중 처리기가 꺼져도(코어 갱신) 대기 파일이 남아 새 처리기가 이어받는다 — 같은 HEAD 는 다시 돌지 않으니 여기서 놓치면 끝
{
confirm_killed
[ -n "$(ls "$TMP/queue-confirm/confirm")" ] && ! grep -q '^pr merge' "$GH_LOG" && grep -lq '"state": *"delivered"' "$CORE/.requests"/*.json "$CORE/.requests"/*/request.json 2>/dev/null && echo "  ✔ [머지] 답 뒤 검증 도중 처리기가 죽어도 대기 파일이 남는다" || { echo "  ✖ 답한 뒤 끊기면 대기 파일이 사라졌다"; FAIL=1; }
confirm_run
grep -q "^pr merge 7 --repo acme/web --squash --match-head-commit $SHA" "$GH_LOG" && auto_line | grep -q '머지됨 — squash → main' && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ 새 처리기가 이어서 머지 · 줄 머지됨 · 파일 없음" || { echo "  ✖ 끊긴 뒤 이어서 머지 — $(auto_line)"; sed 's/^/      /' "$TMP/merge.out"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 끊긴 사이 base 가 바뀌었으면 답을 받았어도 머지하지 않는다
confirm_killed
for claimed_file in "$TMP/queue-confirm/confirm/"*; do python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['base']='dev'; json.dump(d, open(p,'w'))" "$claimed_file"; done
confirm_run
! grep -q '^pr merge' "$GH_LOG" && auto_line | grep -q '머지 전에 base 가 바뀜(dev → main)' && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ 끊긴 사이 base 변경 → 머지 안 함 · 줄에 이유" || { echo "  ✖ 끊긴 사이 base 변경 — $(auto_line)"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 끊긴 사이 새 커밋이 왔으면 머지하지 않는다
confirm_killed
confirm_run FAKE_SHA=ffffffffffffffffffffffffffffffffffffffff
[ -n "$(cat "$TMP/merge.out")$(cat "$GH_LOG")" ] && ! grep -q '^pr merge' "$GH_LOG" && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] && ! auto_line | grep -q '머지됨' \
  && echo "  ✔ 끊긴 사이 새 커밋 → 머지 안 함 · 파일 없음" || { echo "  ✖ 끊긴 사이 새 커밋 — $(auto_line)"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 머지는 끝났는데 줄을 못 적고 끊김 — 다시 보면 줄을 머지됨으로 맞춘다
confirm_killed
confirm_run FAKE_PR_STATE=MERGED
! grep -q '^pr merge' "$GH_LOG" && auto_line | grep -q '머지됨 — squash → main' && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ 이미 머지된 채 다시 보면 줄을 머지됨으로" || { echo "  ✖ 이미 머지된 PR 줄 맞추기 — $(auto_line)"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 남겨 둔 gh 가 먼저 머지해 이번 pr merge 가 실패해도 — PR 이 머지됐으면 실패로 적지 않는다
confirm_killed
confirm_run FAKE_MERGE_LANDED=1; rm -f "$GH_LOG.landed"
auto_line | grep -q '머지됨 — squash → main' && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ pr merge 가 실패해도 PR 이 머지됐으면 줄은 머지됨" || { echo "  ✖ 먼저 머지된 PR 줄 — $(auto_line)"; FAIL=1; }
# 확인 없는 건도 — 잡은 파일로 다시 봤을 때 이미 머지됐으면 줄을 맞춘다
merge_case "이어받기 준비 — 확인 없음" ', "autoMergeConfirm": false' yes '머지됨' >/dev/null
sed -i.bak 's/^- Auto review: .*/- Auto review: web#7 @'"${SHA:0:7}"' 라운드 1 · 승인 → 바로 머지(확인 없음)/' "$CORE/plans/task/x.md"; rm -f "$CORE/plans/task/x.md.bak"
mkdir -p "$TMP/queue-confirm/confirm"; : > "$GH_LOG"
printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":1,"worktree":"%s","base":"main","root":"%s","packId":null,"request":null,"noConfirm":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json.999999"
confirm_run FAKE_PR_STATE=MERGED
! grep -q '^pr merge' "$GH_LOG" && auto_line | grep -q '머지됨 — squash → main' && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ 확인 없는 건도 이미 머지됐으면 줄을 머지됨으로" || { echo "  ✖ 확인 없는 건 이미 머지 — $(auto_line)"; FAIL=1; }
# 보류를 고른 건은 줄을 적은 뒤 파일이 없다
merge_case "이어받기 준비 — 보류" '' no '머지 확인 대기' >/dev/null
confirm_answer 보류; : > "$GH_LOG"; confirm_run
! grep -q '^pr merge' "$GH_LOG" && auto_line | grep -q '보류 — 사람이 고름(보류)' && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ 보류 → 줄 남김 · 파일 없음" || { echo "  ✖ 보류 — $(auto_line)"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
} > "$GRP"; grp_end "끊긴 뒤 이어받기 — 이어 머지 · base 변경 · 새 커밋 · 이미 머지 · pr merge 실패해도 머지됨 · 확인 없음 · 보류"
# 리뷰하다 끊긴 일(*.json.working)은 작업이다 — 처리기가 꺼져 있으면 --kick 이 다시 띄운다(코어 갱신이 끈 뒤 · 안 띄우면 같은 HEAD 는 영영 다시 안 돈다)
KQW="$TMP/queue-kick-working"; rm -rf "$KQW"; mkdir -p "$KQW"
printf '{"plan":"plans/x.md","pr":"web#1","head":"abc1234","root":"/nonexistent-checkout"}' > "$KQW/0-x.json.working"
(cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$KQW" "$(command -v node)" scripts/pr-auto.mjs --kick > "$TMP/kick.out" 2>&1)
for _ in $(seq 1 50); do [ -f "$KQW/.watcher.lock/pid" ] && break; sleep 0.1; done
grep -q "처리기를 뒤에서 시작" "$TMP/kick.out" && [ -f "$KQW/.watcher.lock/pid" ] \
  && echo "  ✔ 끊긴 일(*.json.working)만 있어도 --kick 이 처리기를 띄운다" || { echo "  ✖ 끊긴 일이 있는데 처리기를 안 띄웠다"; ls -a "$KQW"; cat "$TMP/kick.out"; FAIL=1; }
[ -f "$KQW/.watcher.lock/pid" ] && kill "$(cat "$KQW/.watcher.lock/pid")" 2>/dev/null
# 계획서 Lead pane 이 살아 있으면 그쪽이 먼저
{
: > "$SLOG"
EXTRA_PLAN="- Lead pane: p91
" merge_case "Lead pane(p91)이 살아 있으면 그 pane 에" ', "autoMergeConfirm": false' no '검증 대기' FAKE_VERIFY_FAIL=1 FAKE_PANES="{\"id\":\"p91\"},$ATHENA_PANE" FAKE_SCREEN_LOG="$SLOG"
grep -q "^screen pane send-text p91 \[자동 리뷰 → 아테나\]" "$SLOG" && ! grep -q "send-text p50 " "$SLOG" && [ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] \
  && echo "  ✔ Lead pane 에 보냄(다른 아테나 pane 이 아니라)" || { echo "  ✖ Lead pane 알림"; sed 's/^/      /' "$SLOG"; FAIL=1; }
# 머지 확인(고를 것 있음)은 아테나 pane 이 있어도 지금처럼 요청
: > "$SLOG"
merge_case "머지 확인은 아테나 pane 이 있어도 요청으로" "" no '머지 확인 대기' FAKE_PANES="$ATHENA_PANE" FAKE_SCREEN_LOG="$SLOG"
grep -lq '"label": "머지"' "$CORE/.requests"/*.json 2>/dev/null && ! grep -q "send-text p50 " "$SLOG" \
  && echo "  ✔ 머지 확인 요청([머지]/[보류])은 그대로 · 아테나 pane 에 안 보냄" || { echo "  ✖ 머지 확인 요청"; FAIL=1; }
} > "$GRP"; grp_end "알림 대상 — Lead pane 먼저 · 머지 확인은 요청으로"


[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
