#!/usr/bin/env bash
# PR 자동 리뷰 시험 — PR 끔 바로 머지(ship.sh --direct-merge) · 넓은 수정 리뷰 문 · 보안 검토 문 · Actions 넘기기
. "$(dirname "$0")/_pr-auto-lib.sh"   # 공통 준비 — test/_pr-auto-lib.sh (이 경로 글을 보고 검증 범위가 헬퍼를 따라간다)
# ── PR 끔: PR 없이 바로 머지(autoMerge + "autoPr": false) — 가짜 원격(bare) · gh 없음 · 진짜 GitHub 를 건드리지 않는다 ─────────
# 안전 조건은 PR 머지와 같다 — 같은 HEAD 엄격 검증은 어떤 설정에서도 돈다(끄는 설정이 없다): 검증 스크립트가 없거나 · 실패하거나 · 건너뛰면 머지하지 않고 실패로 알린다
echo; echo "PR 끔: 바로 머지(ship.sh --direct-merge → pr-auto.mjs --direct-merge)"
DCORE="$(cd "$TMP" && pwd -P)/core-direct"; mkdir -p "$DCORE/plans/task"
cp -R "$SRC/scripts" "$DCORE/scripts"
write_fake_screen "$DCORE/scripts/screen"
DENVLOG="$TMP/direct-verify-env.log"
# 가짜 검증 — 부른 환경을 남기고 FAKE_VERIFY_FAIL 이면 실패(엄격 모드의 건너뜀도 종료 비0 이라 같은 길)
printf '#!/bin/sh\necho "STRICT=$ATHENA_VERIFY_STRICT ALLOW=[$ATHENA_VERIFY_ALLOW_SKIP]" >> "%s"\n[ -z "$FAKE_VERIFY_FAIL" ]\n' "$DENVLOG" > "$DCORE/scripts/verify/reuse.sh"; chmod +x "$DCORE/scripts/verify/reuse.sh"
DORIGIN="$TMP/d-origin.git"; DWT="$TMP/d-wt"
git init -q --bare "$DORIGIN" && git init -q "$DWT"
DG() { git -C "$DWT" -c user.name=t -c user.email=t@t "$@"; }
DG checkout -q -b main && echo base > "$DWT/f.txt" && DG add f.txt && DG commit -q -m base
DG remote add origin "$DORIGIN" && DG push -q origin main 2>/dev/null
DBASE="$(DG rev-parse HEAD)"
DG checkout -q -b feat/x && echo feat > "$DWT/feat.txt" && DG add feat.txt && DG commit -q -m feat
DSHA="$(DG rev-parse HEAD)"
direct_case() {   # <이름> <레포 JSON 조각> <머지 기대 yes|no> <종료 기대> <계획서 줄 기대(정규식)> [환경…]
  local name="$1" extra="$2" want="$3" wantcode="$4" line="$5"; shift 5
  rm -rf "$DCORE/.requests" "$DCORE/.events.jsonl" "$TMP/queue-direct" "$DCORE/plans/task/"*; : > "$DENVLOG"
  mkdir -p "$TMP/queue-direct/.watcher.lock" && echo $$ > "$TMP/queue-direct/.watcher.lock/pid"   # 처리기가 돌고 있는 것처럼
  rm -f "$DORIGIN/hooks/pre-receive"; [ "${REJECT_PUSH:-0}" = 1 ] && printf '#!/bin/sh\necho "protected branch" >&2\nexit 1\n' > "$DORIGIN/hooks/pre-receive" && chmod +x "$DORIGIN/hooks/pre-receive"
  git -C "$DORIGIN" update-ref refs/heads/main "$DBASE"   # 매번 처음 base 로
  DG checkout -q "${DBRANCH:-feat/x}"   # DBRANCH — 넓은 수정 사례는 feat/wide
  printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main"%s }, { "name": "api", "agents": ["api-be"], "branch": "main", "prBase": "main" } ] }\n' "$extra" > "$DCORE/athena.config.json"
  printf '# 시험 제목\n## Checkpoint\n- Status: in_progress\n- Agent: %s\n- Work ref: %s · 🌿 %s · pane p3 (web-fe)\n%s' "${PLAN_AGENT:-web-fe}" "$DWT" "${DBRANCH:-feat/x}" "${PLAN_EXTRA:-}" > "$DCORE/plans/task/x.md"
  [ "${PENDING:-0}" = 1 ] && (cd "$DCORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
    const { openRequest } = await import('./scripts/lib/requests.mjs')
    openRequest('.', { kind: 'decision', title: 'x', body: '- R1', links: { plan: 'plans/task/x.md' }, pane: null, dedupeKey: 'plan:plans/task/x.md' })" >/dev/null)
  [ "${DIRTY:-0}" = 1 ] && echo dirty >> "$DWT/feat.txt"
  env PATH="/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-direct" "$@" \
    "$(command -v node)" "$DCORE/scripts/pr-auto.mjs" --direct-merge --plan plans/task/x.md --repo web --dir "$DWT" > "$TMP/direct.out" 2>&1
  local code=$?
  [ "${DIRTY:-0}" = 1 ] && DG checkout -q -- feat.txt
  local tip merged=no; tip="$(git -C "$DORIGIN" rev-parse refs/heads/main)"
  [ "$tip" != "$DBASE" ] && git -C "$DORIGIN" cat-file -e "$tip:feat.txt" 2>/dev/null && merged=yes
  local got; got="$(grep -o '^- Auto merge: .*' "$DCORE/plans/task/x.md")"
  if [ "$merged" = "$want" ] && [ "$code" = "$wantcode" ] && { { [ "$line" = '^$' ] && [ -z "$got" ]; } || printf '%s' "$got" | grep -Eq "$line"; }; then echo "  ✔ $name — ${got#- Auto merge: }"
  else echo "  ✖ $name — 머지 기대 $want · 실제 $merged · 종료 기대 $wantcode · 실제 $code · 줄: $got"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; fi
}
direct_requests() { ls "$DCORE/.requests" 2>/dev/null | grep -c json; }
{
direct_case "자동 머지 → 검증 · 충돌 확인 뒤 PR 없이 squash 로 base 에 push" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' yes 0 '머지됨 — squash → main @[0-9a-f]{7}\(PR 없음\)'
[ "$(git -C "$DORIGIN" rev-list --count refs/heads/main)" = 2 ] && [ "$(git -C "$DORIGIN" rev-parse refs/heads/main^)" = "$DBASE" ] && git -C "$DORIGIN" cat-file -e refs/heads/main:f.txt \
  && echo "  ✔ 머지 커밋은 base 위의 하나(squash) · 작업 브랜치는 원격에 올리지 않음" || { echo "  ✖ squash 커밋 모양"; FAIL=1; }
[ -z "$(git -C "$DORIGIN" for-each-ref refs/heads/feat 2>/dev/null)" ] && grep -q 'STRICT=1 ALLOW=\[\]' "$DENVLOG" \
  && echo "  ✔ 검증은 엄격 모드 · 건너뜀 허용 없음으로 돌았다" || { echo "  ✖ 검증 환경(STRICT=1 ALLOW=[]) — $(cat "$DENVLOG")"; FAIL=1; }
grep -q '"auto.merge".*"direct":true.*"ok":true\|"auto.merge".*"ok":true.*"direct":true' "$DCORE/.events.jsonl" && echo "  ✔ 사건 기록 auto.merge(direct)" || { echo "  ✖ 사건 기록 없음"; FAIL=1; }
# 같은 HEAD 재실행 — direct_case 는 base 와 계획서를 처음으로 되돌리므로 쓰지 않고, 바로 위 머지 결과 그대로 한 번 더 돌린다
DTIP="$(git -C "$DORIGIN" rev-parse refs/heads/main)"; : > "$DENVLOG"
env PATH="/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-direct" \
  "$(command -v node)" "$DCORE/scripts/pr-auto.mjs" --direct-merge --plan plans/task/x.md --repo web --dir "$DWT" > "$TMP/direct.out" 2>&1; DCODE=$?
[ "$DCODE" = 0 ] && grep -q '이미 머지됨' "$TMP/direct.out" && [ "$(git -C "$DORIGIN" rev-parse refs/heads/main)" = "$DTIP" ] && [ ! -s "$DENVLOG" ] \
  && echo "  ✔ 같은 HEAD 를 다시 돌리면 이미 머지됨으로 넘김 · base 그대로 · 검증 다시 안 돎" || { echo "  ✖ 같은 HEAD 재실행 — 종료 $DCODE · 검증 $(cat "$DENVLOG")"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
direct_case "건너뜀 허용 환경(ATHENA_VERIFY_ALLOW_SKIP)을 줘도 검증에는 넘기지 않는다" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' yes 0 '머지됨' ATHENA_VERIFY_ALLOW_SKIP=all
grep -q 'STRICT=1 ALLOW=\[\]' "$DENVLOG" && ! grep -q 'ALLOW=\[all\]' "$DENVLOG" && echo "  ✔ 건너뜀 허용 환경이 비워져 검증에 넘어갔다" || { echo "  ✖ 건너뜀 허용이 새어 들어감 — $(cat "$DENVLOG")"; FAIL=1; }
} > "$GRP"; grp_end "바로 머지 — squash 커밋 하나 · 엄격 검증(건너뜀 허용 안 넘김) · 사건 direct:true · 같은 HEAD 다시 돌면 이미 머지됨"
{
direct_case "확인 후(기본) → 검증 통과 뒤 [머지] 요청만 · 머지 안 함" ', "autoMerge": true, "autoPr": false' no 0 '머지 확인 대기'
[ "$(direct_requests)" -ge 1 ] && echo "  ✔ 확인 후 → [작업] 요청이 열림" || { echo "  ✖ 확인 후인데 요청이 없다"; FAIL=1; }
direct_case "직접 → 브랜치까지만 · 요청 없음" ', "autoMerge": true, "autoPr": false, "autoMergeManual": true' no 0 '브랜치까지만'
[ "$(direct_requests)" = 0 ] && echo "  ✔ 직접 → 요청 없음" || { echo "  ✖ 직접인데 요청이 열렸다"; FAIL=1; }
direct_case "호환 — autoMerge 키 없음 + autoPr false → 바로 머지 안 함(자동 흐름 없음)" ', "autoPr": false, "autoMergeConfirm": false' no 1 '^$'
direct_case "호환 — autoMerge 만(autoPr 키 없음) → 바로 머지 안 함(PR 흐름)" ', "autoMerge": true, "autoMergeConfirm": false' no 1 '^$'
direct_case "main 직접 레포는 바로 머지 대상 아님" ', "autoMerge": true, "autoPr": false, "direct": true, "autoMergeConfirm": false' no 1 '^$'
PLAN_AGENT='web-fe, api-be' direct_case "여러 레포 계획서는 대상 아님" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' no 1 '^$'
} > "$GRP"; grp_end "바로 머지 대상 — 확인 후는 요청만 · 직접은 브랜치까지 · 호환 둘 · main 직접 · 여러 레포는 아님"
{
PENDING=1 direct_case "안 정한 결정이 있으면 머지 안 함" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' no 1 '결정 필요'
direct_case "검증 실패 → 머지 안 함 · 실패로 알림(줄 · 요청)" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' no 1 '검증 대기 — 검증 실패' FAKE_VERIFY_FAIL=1
[ "$(direct_requests)" -ge 1 ] && echo "  ✔ 검증 실패 → [작업] 요청이 열림" || { echo "  ✖ 검증 실패인데 요청이 없다"; FAIL=1; }
} > "$GRP"; grp_end "안 정한 결정 · 검증 실패 → 머지 안 함(실패는 줄 · 요청)"
# 바로 머지 확인 — [머지] 답 뒤 검증 도중 처리기가 꺼져도 대기 파일이 남아 이어받는다(같은 트리는 빈 커밋을 밀지 않는다)
{
direct_run() {   # [환경…]
  env PATH="/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-direct" "$@" "$(command -v node)" --input-type=module -e "
    const { checkConfirms } = await import('$DCORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/direct.out" 2>&1
}
direct_answered() {   # 확인 대기 → [머지] 답
  direct_case "이어받기 준비 — 바로 머지 확인" ', "autoMerge": true, "autoPr": false' no 0 '머지 확인 대기' >/dev/null
  (cd "$DCORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
    const { listRequests, answerRequest } = await import('./scripts/lib/requests.mjs')
    for (const request of listRequests('.').requests) answerRequest('.', request.id, { choice: '머지', by: 'board' })" >/dev/null)
}
direct_line() { grep -o '^- Auto merge: .*' "$DCORE/plans/task/x.md"; }
direct_confirm_files() { ls "$TMP/queue-direct/confirm" 2>/dev/null; }
cp "$DCORE/scripts/verify/reuse.sh" "$TMP/direct-reuse.keep"
printf '#!/bin/sh\n[ -n "$FAKE_VERIFY_KILL" ] && kill -9 $PPID && sleep 1\nexit 0\n' > "$DCORE/scripts/verify/reuse.sh"
direct_answered
( direct_run FAKE_VERIFY_KILL=1; true ) 2>/dev/null
[ -n "$(direct_confirm_files)" ] && [ "$(git -C "$DORIGIN" rev-parse refs/heads/main)" = "$DBASE" ] && echo "  ✔ 바로 머지 — 답 뒤 끊겨도 대기 파일이 남는다" || { echo "  ✖ 바로 머지 — 답한 뒤 끊기면 대기 파일이 사라졌다"; FAIL=1; }
direct_run
DTIP="$(git -C "$DORIGIN" rev-parse refs/heads/main)"
[ "$DTIP" != "$DBASE" ] && direct_line | grep -q '머지됨 — squash → main' && [ -z "$(direct_confirm_files)" ] \
  && echo "  ✔ 바로 머지 — 새 처리기가 이어서 머지 · 파일 없음" || { echo "  ✖ 바로 머지 이어받기 — $(direct_line)"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
# 줄을 적었는데 파일을 못 지우고 끊김 — 다시 보면 또 밀지 않고 파일만 치운다
direct_answered
direct_run; DTIP="$(git -C "$DORIGIN" rev-parse refs/heads/main)"
printf '{"plan":"plans/task/x.md","repo":"web","branch":"feat/x","sha":"%s","base":"main","worktree":"%s","root":"%s","packId":null,"direct":true,"request":"%s"}\n' "$DSHA" "$DWT" "$DCORE" "$(cd "$DCORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
  const { listRequests } = await import('./scripts/lib/requests.mjs'); process.stdout.write(listRequests('.', { all: true }).requests.find((each) => each.state === 'delivered')?.id ?? '')")" > "$TMP/queue-direct/confirm/web-direct-x.json"
direct_run
[ "$(git -C "$DORIGIN" rev-parse refs/heads/main)" = "$DTIP" ] && [ -z "$(direct_confirm_files)" ] && direct_line | grep -q '머지됨' \
  && echo "  ✔ 바로 머지 — 줄이 머지됨이면 다시 밀지 않고 파일만 치움" || { echo "  ✖ 바로 머지 재진입 — $(direct_line) · 파일 $(direct_confirm_files)"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
# push 는 됐는데 줄을 못 적고 끊김 — 합친 트리가 base 와 같으면 빈 커밋을 밀지 않고 머지됨으로
direct_answered
direct_run; DTIP="$(git -C "$DORIGIN" rev-parse refs/heads/main)"
sed -i.bak 's/^- Auto merge: .*/- Auto merge: web feat\/x @'"${DSHA:0:7}"' 머지 확인 대기/' "$DCORE/plans/task/x.md"; rm -f "$DCORE/plans/task/x.md.bak"
printf '{"plan":"plans/task/x.md","repo":"web","branch":"feat/x","sha":"%s","base":"main","worktree":"%s","root":"%s","packId":null,"direct":true,"request":"%s"}\n' "$DSHA" "$DWT" "$DCORE" "$(cd "$DCORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
  const { listRequests } = await import('./scripts/lib/requests.mjs'); process.stdout.write(listRequests('.', { all: true }).requests.find((each) => each.state === 'delivered')?.id ?? '')")" > "$TMP/queue-direct/confirm/web-direct-x.json"
direct_run
[ "$(git -C "$DORIGIN" rev-parse refs/heads/main)" = "$DTIP" ] && [ -z "$(direct_confirm_files)" ] && direct_line | grep -q '머지됨' \
  && echo "  ✔ 바로 머지 — 이미 들어간 내용이면 빈 커밋을 밀지 않고 머지됨" || { echo "  ✖ 바로 머지 — 빈 커밋 — $(direct_line) · base $(git -C "$DORIGIN" rev-list --count refs/heads/main)개"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
} > "$GRP"; grp_end "바로 머지 확인 — 끊긴 뒤 이어 머지 · 줄 적은 뒤 파일만 치움 · 이미 들어간 내용은 빈 커밋 없이 머지됨"
cp "$TMP/direct-reuse.keep" "$DCORE/scripts/verify/reuse.sh"
mv "$DCORE/scripts/verify/reuse.sh" "$DCORE/scripts/verify/reuse.sh.off"
{
direct_case "검증 스크립트가 없으면 머지 안 함 · 실패로 알림" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' no 1 '검증 대기'
direct_case "검증 스크립트가 없으면 확인 후 설정도 요청을 열지 않고 실패로" ', "autoMerge": true, "autoPr": false' no 1 '검증 대기'
mv "$DCORE/scripts/verify/reuse.sh.off" "$DCORE/scripts/verify/reuse.sh"
DIRTY=1 direct_case "워크트리에 커밋 안 된 변경이 있으면 머지 안 함" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' no 1 '검증 대기 — 워크트리에 커밋 안 된 변경'
# 충돌 — base 가 같은 파일을 다르게 고쳐 둠
DG checkout -q -b conflict-base "$DBASE" && echo "other" > "$DWT/feat.txt" && DG add feat.txt && DG commit -q -m other
DCONFLICT="$(DG rev-parse HEAD)"; DG push -q origin conflict-base; DG checkout -q feat/x   # 충돌 커밋 객체가 원격에 있어야 base 로 옮길 수 있다
conflict_origin() { git -C "$DORIGIN" update-ref refs/heads/main "$DCONFLICT"; }
rm -rf "$DCORE/.requests" "$DCORE/.events.jsonl" "$DCORE/plans/task/"*
printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoPr": false, "autoMergeConfirm": false } ] }\n' > "$DCORE/athena.config.json"
printf '# 시험 제목\n## Checkpoint\n- Status: in_progress\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p3 (web-fe)\n' "$DWT" > "$DCORE/plans/task/x.md"
conflict_origin
env PATH="/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-direct" "$(command -v node)" "$DCORE/scripts/pr-auto.mjs" --direct-merge --plan plans/task/x.md --repo web --dir "$DWT" > "$TMP/direct.out" 2>&1; DCODE=$?
[ "$(git -C "$DORIGIN" rev-parse refs/heads/main)" = "$DCONFLICT" ] && [ "$DCODE" = 1 ] && grep -q '^- Auto merge: .*충돌' "$DCORE/plans/task/x.md" && [ "$(direct_requests)" -ge 1 ] \
  && echo "  ✔ base 와 충돌 → 머지 안 함 · base 그대로 · 줄 · 요청" || { echo "  ✖ 충돌 처리 — 종료 $DCODE"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
REJECT_PUSH=1 direct_case "base 에 push 가 거부되면(브랜치 보호) 머지 안 함 · 강제 push 없이 실패로 알림" ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false' no 1 'push 가 거부됨'
[ "$(direct_requests)" -ge 1 ] && [ "$(git -C "$DORIGIN" rev-parse refs/heads/main)" = "$DBASE" ] && echo "  ✔ push 거부 → [작업] 요청이 열림 · 원격 base 그대로" || { echo "  ✖ push 거부 요청 · base"; FAIL=1; }
} > "$GRP"; grp_end "머지 안 함 — 검증 스크립트 없음(확인 후도) · 미커밋 · base 충돌 · push 거부(강제 안 함)"
rm -f "$DORIGIN/hooks/pre-receive"

# ── 바로 머지 앞의 리뷰 문(2026-11-04 결정) — 넓은 수정이면 같은 HEAD 의 "- Review result: 승인" 이 있을 때만 머지 · 없으면 reviewer 를 띄우고 기다린다 ─────
echo; echo "PR 끔: 넓은 수정이면 리뷰 문(directReviewGate)"
# 가짜 reviewer — delegate.sh 자리에서 부른 인자를 남기고 계획서에 '- Review:' 줄 + FAKE_REVIEW(approve · changes · none)대로 결론 줄을 적는다(review-result.sh 와 같은 모양)
DLOG="$TMP/direct-delegate.log"
DWTN="$(printf '%s' "$DWT" | sed 's#//*#/#g')"   # pr-auto.mjs 는 경로를 정규화해 적는다 — TMPDIR 이 / 로 끝나면 $DWT 에 // 가 남는다
cat > "$DCORE/scripts/delegate.sh" <<'SH'
#!/bin/sh
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
printf 'delegate %s\n' "$*" >> "$FAKE_DELEGATE_LOG"
WHO="$1"; CWD=""; PLAN=""
while [ $# -gt 0 ]; do case "$1" in --cwd) CWD="$2"; shift 2 ;; --plan) PLAN="$2"; shift 2 ;; *) shift ;; esac; done
BRANCH="$(git -C "$CWD" symbolic-ref --short -q HEAD)"
# security-reviewer — '- Security review:' 줄 + FAKE_SECURITY(high · clean · none)대로 결과 줄(review-result.sh --security 와 같은 모양)
case "$WHO" in security-reviewer)
  printf -- '- Security review: %s · 📦 web · 🌿 %s · pane p8 (security-reviewer) · 띄움 %s\n' "$CWD" "$BRANCH" "$(date '+%Y-%m-%d %H:%M')" >> "$ROOT/$PLAN"
  case "${FAKE_SECURITY:-none}" in high) HIGH=1 ;; clean) HIGH=0 ;; *) exit 0 ;; esac
  printf -- '- Security result: 높음 %s · 중간 0 @%s · tree %s · 📦 web · 🌿 %s · %s · 가짜\n' "$HIGH" "$(git -C "$CWD" rev-parse --short HEAD)" "$(git -C "$CWD" rev-parse 'HEAD^{tree}' | cut -c1-12)" "$BRANCH" "$(date '+%Y-%m-%d %H:%M')" >> "$ROOT/$PLAN"
  exit 0 ;;
esac
printf -- '- Review: %s · 🌿 %s · pane p9 (reviewer) · 띄움 %s\n' "$CWD" "$BRANCH" "$(date '+%Y-%m-%d %H:%M')" >> "$ROOT/$PLAN"
case "${FAKE_REVIEW:-none}" in
  approve) V=승인 ;; changes) V='수정 필요' ;; *) exit 0 ;;
esac
SHA="$(git -C "$CWD" rev-parse --short HEAD)"; TREE="$(git -C "$CWD" rev-parse 'HEAD^{tree}' | cut -c1-12)"
printf -- '- Review result: %s @%s · tree %s · 📦 web · 🌿 %s · 🧠 claude · %s · 가짜\n' "$V" "$SHA" "$TREE" "$BRANCH" "$(date '+%Y-%m-%d %H:%M')" >> "$ROOT/$PLAN"
SH
chmod +x "$DCORE/scripts/delegate.sh"
# 넓은 수정 브랜치 — feat/x 위에 코드 파일 5개(기준 5개 이상) · feat.txt 가 있어 머지 판정(direct_case)은 그대로
DG checkout -q -b feat/wide feat/x
for n in 1 2 3 4 5; do printf 'export const f%s = () => %s\n' "$n" "$n" > "$DWT/f$n.mjs"; done
DG add . && DG commit -q -m wide; DWIDE="$(DG rev-parse HEAD)"; DWIDE_TREE="$(DG rev-parse 'HEAD^{tree}' | cut -c1-12)"
# 위험한 수정 브랜치 — feat/x 위에 명령 실행 줄 하나(넓은 수정은 아니라 reviewer 는 안 뜬다 · 보안 검토 문만)
DG checkout -q -b feat/sec feat/x
printf "import { spawnSync } from 'node:child_process'\nexport const run = (args) => spawnSync('git', args)\n" > "$DWT/run.mjs"
DG add run.mjs && DG commit -q -m sec
DG checkout -q feat/x
DPANE="{\"id\":\"p50\",\"agent\":\"claude\",\"cwd\":\"$DCORE\",\"label\":\"🧭 아테나\"}"
DSLOG="$TMP/direct-screen.log"
AUTO=', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false'
GATE_ENV=(FAKE_DELEGATE_LOG="$DLOG" FAKE_SCREEN_LOG="$DSLOG" ATHENA_DIRECT_REVIEW_POLL_MS=100 ATHENA_DIRECT_REVIEW_TIMEOUT_MS=1500)
gate_reset() { : > "$DLOG"; : > "$DSLOG"; }
# ③ 문서만 · 작은 수정 → 리뷰 없이 지금처럼(feat/x 는 feat.txt 한 줄)
{
gate_reset; direct_case "③ 작은 수정(문서 파일 1개) → reviewer 안 띄우고 지금처럼 머지" "$AUTO" yes 0 '머지됨' "${GATE_ENV[@]}"
[ ! -s "$DLOG" ] && grep -q '리뷰 없이 — 넓은 수정 아님(문서만 1개)' "$TMP/direct.out" && echo "  ✔ reviewer 를 띄우지 않았다 · 판정 '문서만 1개'" || { echo "  ✖ 작은 수정인데 reviewer 를 띄움 — $(cat "$DLOG")"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
# ① 넓은 수정 + 같은 HEAD 승인 없음 → reviewer 띄움 · 결론 없으면(시간 초과) 머지 안 함
gate_reset; DBRANCH=feat/wide direct_case "① 넓은 수정 + 승인 없음 + reviewer 결론 없음 → reviewer 띄움 · 머지 안 함 · 아테나에 알림" "$AUTO" no 1 '리뷰 때문에 멈춤 — [0-9]+분 안에 reviewer 결론이 없음 · 리뷰 1회' "${GATE_ENV[@]}" FAKE_REVIEW=none FAKE_PANES="$DPANE"
grep -q "delegate reviewer --cwd $DWTN --here --plan plans/task/x.md .*넓은 수정(코드 파일 5개 ≥ 5).*diff origin/main...HEAD" "$DLOG" && ! grep -q '짧은 리뷰' "$DLOG" \
  && echo "  ✔ reviewer 를 이 pane 옆에(--here) 전체 diff 지시로 띄움 · 판정 '코드 파일 5개 ≥ 5'" || { echo "  ✖ reviewer 지시 — $(cat "$DLOG")"; FAIL=1; }
grep -q 'pane send-text p50 .*\[자동 리뷰 → 아테나\] 바로 머지 앞 리뷰에서 멈춤' "$DSLOG" && echo "  ✔ 결론 없음 → 아테나 pane 에 알림" || { echo "  ✖ 아테나 알림 없음 — $(cat "$DSLOG")"; FAIL=1; }
[ "$(direct_requests)" = 0 ] && echo "  ✔ 리뷰 멈춤은 [작업] 요청을 열지 않는다" || { echo "  ✖ 리뷰 멈춤인데 요청이 열렸다"; FAIL=1; }
# ① 넓은 수정 → 리뷰 수정 필요 → 머지 안 함 · 고친 뒤 다시 오라고(아테나 알림 없음 — 에이전트 몫)
gate_reset; DBRANCH=feat/wide direct_case "① 넓은 수정 → reviewer 수정 필요 → 머지 안 함 · 고친 뒤 같은 명령으로" "$AUTO" no 1 "리뷰 때문에 멈춤 — 수정 필요 @${DWIDE:0:7} · 리뷰 1회\(고친 뒤 같은 명령으로 다시" "${GATE_ENV[@]}" FAKE_REVIEW=changes FAKE_PANES="$DPANE"
! grep -q 'send-text' "$DSLOG" && grep -q 'reviewer pane p9 보고에' "$TMP/direct.out" && echo "  ✔ 첫 수정 필요는 아테나에 알리지 않고 reviewer pane 을 가리킨다" || { echo "  ✖ 첫 수정 필요 처리 — $(cat "$DSLOG")"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
# 같은 HEAD 에 수정 필요 그대로 다시 오면 reviewer 를 또 띄우지 않는다
gate_reset; DBRANCH=feat/wide PLAN_EXTRA="- Auto merge: web feat/wide @${DWIDE:0:7} · 리뷰 때문에 멈춤 — 수정 필요 @${DWIDE:0:7} · 리뷰 1회(고친 뒤 같은 명령으로 다시) · 2026-11-04 10:01
- Review result: 수정 필요 @${DWIDE:0:7} · tree $DWIDE_TREE · 📦 web · 🌿 feat/wide · 🧠 claude · 2026-11-04 10:00 · 앞 지적
" direct_case "같은 HEAD 에 수정 필요가 이미 있으면 다시 띄우지 않고 멈춤 · 리뷰 횟수는 줄에 남는다" "$AUTO" no 1 '리뷰 때문에 멈춤 — 수정 필요 @[0-9a-f]{7} 그대로\(고친 뒤 같은 명령으로 다시\) · 리뷰 1회' "${GATE_ENV[@]}" FAKE_REVIEW=approve
[ ! -s "$DLOG" ] && echo "  ✔ reviewer 를 또 띄우지 않았다" || { echo "  ✖ 같은 HEAD 인데 또 띄움"; FAIL=1; }
# ① 넓은 수정 → 리뷰 승인 → 머지
gate_reset; DBRANCH=feat/wide direct_case "① 넓은 수정 → reviewer 승인 → 머지" "$AUTO" yes 0 '머지됨 — squash' "${GATE_ENV[@]}" FAKE_REVIEW=approve
grep -q 'delegate reviewer' "$DLOG" && grep -q "리뷰 승인 @${DWIDE:0:7} · 🧠 claude" "$TMP/direct.out" && echo "  ✔ reviewer 승인 뒤 머지" || { echo "  ✖ 승인 뒤 머지 — $(cat "$DLOG")"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
# ② 같은 HEAD 승인이 이미 있음 → 띄우지 않고 머지
gate_reset; DBRANCH=feat/wide PLAN_EXTRA="- Review result: 승인 @${DWIDE:0:7} · tree $DWIDE_TREE · 📦 web · 🌿 feat/wide · 🧠 claude · 2026-11-04 10:00
" direct_case "② 같은 HEAD 승인이 있으면 reviewer 안 띄우고 머지" "$AUTO" yes 0 '머지됨 — squash' "${GATE_ENV[@]}" FAKE_REVIEW=changes
[ ! -s "$DLOG" ] && grep -q "같은 내용 리뷰 승인 @${DWIDE:0:7}" "$TMP/direct.out" && echo "  ✔ 앞 승인을 이어받아 reviewer 안 띄움" || { echo "  ✖ 같은 HEAD 승인 — $(cat "$DLOG")"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
# ④ 승인 뒤 커밋이 더해짐 → 같은 HEAD 가 아니니 고친 부분만 짧게 다시 리뷰(승인 sha 뒤 diff) · 승인이면 머지
DG checkout -q feat/wide && printf 'export const f6 = () => 6\n' > "$DWT/f6.mjs" && DG add f6.mjs && DG commit -q -m more; DMORE="$(DG rev-parse HEAD)"; DG checkout -q feat/x
gate_reset; DBRANCH=feat/wide PLAN_EXTRA="- Review result: 승인 @${DWIDE:0:7} · tree $DWIDE_TREE · 📦 web · 🌿 feat/wide · 🧠 claude · 2026-11-04 10:00
" direct_case "④ 승인 뒤 커밋이 더해짐 → 고친 부분만 짧은 리뷰 → 승인이면 머지" "$AUTO" yes 0 '머지됨 — squash' "${GATE_ENV[@]}" FAKE_REVIEW=approve
grep -q "짧은 리뷰 — 앞 리뷰(@${DWIDE:0:7} 승인) 뒤에 바뀐 부분만 본다: git -C $DWTN diff ${DWIDE:0:7}...HEAD" "$DLOG" \
  && echo "  ✔ 승인 sha 뒤의 차이만 보는 짧은 리뷰 지시" || { echo "  ✖ 짧은 리뷰 지시 — $(cat "$DLOG")"; FAIL=1; }
# 수정 필요 → 고침 → 짧은 리뷰도 수정 필요 → 멈추고 아테나가 이어받음(리뷰 2회)
gate_reset; DBRANCH=feat/wide PLAN_EXTRA="- Auto merge: web feat/wide @${DWIDE:0:7} · 리뷰 때문에 멈춤 — 수정 필요 @${DWIDE:0:7} · 리뷰 1회(고친 뒤 같은 명령으로 다시) · 2026-11-04 10:01
- Review result: 수정 필요 @${DWIDE:0:7} · tree $DWIDE_TREE · 📦 web · 🌿 feat/wide · 🧠 claude · 2026-11-04 10:00 · 앞 지적
" direct_case "수정 필요 뒤 고친 HEAD 의 짧은 리뷰도 수정 필요 → 멈춤 · 아테나가 이어받음" "$AUTO" no 1 "리뷰 때문에 멈춤 — 짧은 리뷰에서도 수정 필요 @${DMORE:0:7} · 리뷰 2회 · 아테나가 이어받음" "${GATE_ENV[@]}" FAKE_REVIEW=changes FAKE_PANES="$DPANE"
grep -q '짧은 리뷰' "$DLOG" && grep -q 'pane send-text p50 .*바로 머지 앞 리뷰에서 멈춤' "$DSLOG" && echo "  ✔ 두 번째 수정 필요 → 아테나 pane 에 알림" || { echo "  ✖ 두 번째 수정 필요 — $(cat "$DLOG") / $(cat "$DSLOG")"; FAIL=1; }
# 리뷰 2회를 다 쓴 뒤 또 오면 띄우지 않고 멈춤 — 아테나가 승인 줄을 남기면(같은 HEAD) 다시 통과한다
gate_reset; DBRANCH=feat/wide PLAN_EXTRA="- Auto merge: web feat/wide @${DMORE:0:7} · 리뷰 때문에 멈춤 — 짧은 리뷰에서도 수정 필요 · 리뷰 2회 · 아테나가 이어받음 · 2026-11-04 10:02
- Review result: 수정 필요 @${DWIDE:0:7} · tree $DWIDE_TREE · 📦 web · 🌿 feat/wide · 🧠 claude · 2026-11-04 10:00
" direct_case "리뷰 2회를 다 쓴 뒤는 reviewer 를 또 띄우지 않고 멈춤" "$AUTO" no 1 '리뷰 때문에 멈춤 — 리뷰 2회를 다 썼다' "${GATE_ENV[@]}" FAKE_REVIEW=approve FAKE_PANES="$DPANE"
[ ! -s "$DLOG" ] && echo "  ✔ 상한 뒤에는 reviewer 를 띄우지 않는다" || { echo "  ✖ 상한 뒤에 또 띄움"; FAIL=1; }
# 확인 후 머지(confirm) 도 리뷰 문을 먼저 — 수정 필요면 [머지] 요청을 열지 않는다
gate_reset; DBRANCH=feat/wide direct_case "확인 후 머지 레포도 넓은 수정이면 리뷰 먼저 — 수정 필요면 [머지] 요청 없음" ', "autoMerge": true, "autoPr": false' no 1 '리뷰 때문에 멈춤 — 수정 필요' "${GATE_ENV[@]}" FAKE_REVIEW=changes
[ "$(direct_requests)" = 0 ] && echo "  ✔ 리뷰 전에는 [머지] 요청을 열지 않는다" || { echo "  ✖ 리뷰 막혔는데 [머지] 요청이 열림"; FAIL=1; }
} > "$GRP"; grp_end "넓은 수정 리뷰 문 — 작은 수정은 그대로 · 결론 없음 · 수정 필요 · 다시 안 띄움 · 승인 · 이미 승인 · 짧은 리뷰 · 상한 · 확인 후도 먼저"
# 민감 경로 · 에이전트 표시 · 줄 수 — 판정 함수(스크립트 기준값의 근거는 lib 주석 · 계획서 Decisions)
node --input-type=module -e "
  const { wideChangeVerdict, planWideMark, planWideOff, directReviewRounds, WIDE_MIN_CODE_FILES, WIDE_MIN_CODE_LINES } = await import('$DCORE/scripts/lib/pr-auto.mjs')
  const file = (path, added = 1, deleted = 0) => ({ path, added, deleted })
  const checks = [
    [wideChangeVerdict({ files: [file('docs/a.md', 500), file('README.md', 50)] }), false, '문서만'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 10)] }), false, '코드 파일 1개 · 10줄'],
    [wideChangeVerdict({ files: [1, 2, 3, 4].map((n) => file('src/f' + n + '.mjs', 5)) }), false, '코드 파일 4개'],
    [wideChangeVerdict({ files: [1, 2, 3, 4, 5].map((n) => file('src/f' + n + '.mjs', 5)) }), true, '코드 파일 5개 ≥ ' + WIDE_MIN_CODE_FILES],
    [wideChangeVerdict({ files: [file('src/a.mjs', 100, 49)] }), false, '149줄'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 100, 50)] }), true, '코드 150줄 ≥ ' + WIDE_MIN_CODE_LINES],
    [wideChangeVerdict({ files: [file('src/a.mjs', 1), file('package.json', 1)] }), true, '민감 경로 package.json'],
    [wideChangeVerdict({ files: [file('scripts/hooks/x.py', 1)] }), true, '민감 경로 scripts/hooks/x.py'],
    [wideChangeVerdict({ files: [file('src/lib/auth-token.mjs', 1)] }), true, '민감 경로 src/lib/auth-token.mjs'],
    [wideChangeVerdict({ files: [file('.env.example', 1)] }), true, '민감 경로 .env.example'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 1)], flagged: ['보안'] }), true, '1절에 보안'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 1)], marked: '새 기능' }), true, '에이전트 표시(새 기능)'],
    [wideChangeVerdict({ files: [file('docs/a.md', 1)], marked: '새 기능' }), true, '에이전트 표시(새 기능)'],
    [wideChangeVerdict({ files: [] }), false, '바뀐 파일 없음'],
    // 끄는 표시(- Wide change: no (<이유>) · 2026-11-26) — 파일 수 · 줄 수 기준만 건너뛴다. 민감 경로 · 1절 표시 · yes 표시는 그대로 넓은 수정
    [wideChangeVerdict({ files: [1, 2, 3, 4, 5].map((n) => file('src/f' + n + '.mjs', 50)), off: '문구만' }), false, '에이전트 표시(no — 문구만)'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 1), file('scripts/hooks/x.py', 1)], off: '문구만' }), true, '민감 경로 scripts/hooks/x.py'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 1), file('package.json', 1)], off: '문구만' }), true, '민감 경로 package.json'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 1)], flagged: ['외부 계약'], off: '문구만' }), true, '1절에 외부 계약'],
    [wideChangeVerdict({ files: [file('src/a.mjs', 1)], marked: '새 기능', off: '문구만' }), true, '에이전트 표시(새 기능)'],
    [wideChangeVerdict({ files: [1, 2, 3, 4, 5].map((n) => file('src/f' + n + '.mjs', 5)), off: '' }), true, '코드 파일 5개 ≥ ' + WIDE_MIN_CODE_FILES],
    [wideChangeVerdict({ files: [file('athena/scripts/board/index.html', 150, 50)] }), true, '코드 200줄 ≥ ' + WIDE_MIN_CODE_LINES],
    [wideChangeVerdict({ files: [1, 2, 3, 4, 5].map((n) => file('src/renderer/v' + n + '.htm', 1)) }), true, '코드 파일 5개 ≥ ' + WIDE_MIN_CODE_FILES],
    [wideChangeVerdict({ files: [file('src/renderer/tray.html', 10)] }), false, '코드 파일 1개 · 10줄'],
    [wideChangeVerdict({ files: [file('athena/docs/diagrams/flow.html', 150, 50), file('docs/plan.htm', 300)] }), false, '문서만 2개'],
  ]
  let bad = 0
  for (const [got, wide, why] of checks) if (got.wide !== wide || !got.why.includes(why)) { bad += 1; console.log('  ✖ 판정 — 기대 ' + wide + ' (' + why + ') · 실제 ' + JSON.stringify(got)) }
  if (planWideMark('## Checkpoint\n- Wide change: yes (구조 변경)\n## 1.') !== '구조 변경') { bad += 1; console.log('  ✖ Checkpoint 의 Wide change 줄을 못 읽음') }
  if (planWideMark('## 1.\n- Wide change: yes (예시)\n## Checkpoint\n- Status: x') !== '') { bad += 1; console.log('  ✖ Checkpoint 밖의 Wide change 줄을 읽음') }
  if (planWideMark('## Checkpoint\n- Wide change: no') !== '') { bad += 1; console.log('  ✖ Wide change: no 를 표시로 읽음') }
  if (planWideOff('## Checkpoint\n- Wide change: no (번역만)\n## 1.') !== '번역만') { bad += 1; console.log('  ✖ Wide change: no (이유) 를 못 읽음') }
  if (planWideOff('## Checkpoint\n- Wide change: no\n- Wide change: no ()') !== '') { bad += 1; console.log('  ✖ 이유 없는 no 를 받음') }
  if (planWideOff('## Checkpoint\n- Wide change: no (문구만)\n- Wide change: yes (새 기능)') !== '' || planWideMark('## Checkpoint\n- Wide change: no (문구만)\n- Wide change: yes (새 기능)') !== '새 기능') { bad += 1; console.log('  ✖ yes 와 no 가 둘 다 있으면 yes 가 이겨야 한다') }
  if (planWideOff('## 1.\n- Wide change: no (예시)\n## Checkpoint\n- Status: x') !== '') { bad += 1; console.log('  ✖ Checkpoint 밖의 no 줄을 읽음') }
  if (directReviewRounds('- Auto merge: web feat/x @abc1234 · 리뷰 때문에 멈춤 — 수정 필요 · 리뷰 1회 · 2026-11-04 10:00', 'web', 'feat/x') !== 1) { bad += 1; console.log('  ✖ 리뷰 횟수') }
  if (directReviewRounds('- Auto merge: web feat/x @abc1234 · 머지됨 — squash · 리뷰 1회 · 2026-11-04 10:00', 'web', 'feat/x') !== 0) { bad += 1; console.log('  ✖ 머지됨 줄의 리뷰 횟수는 0') }
  if (bad) process.exit(1)
  console.log('  ✔ 넓은 수정 판정 — 코드 파일 ≥ ' + WIDE_MIN_CODE_FILES + ' · 코드 줄 ≥ ' + WIDE_MIN_CODE_LINES + ' · 민감 경로 · 1절 표시 · 에이전트 표시(Checkpoint 안에서만) · 끄는 표시(no + 이유 — 민감 경로 · 1절 · yes 는 못 끔) · 문서는 세지 않음 · html 은 docs/ 밖이면 코드')
" || FAIL=1
# 보안 검토 문(security-reviewer · 2026-11-08) — "- Security result:" 에 높음이 남으면 바로 머지 · 넘기기 · PR 머지를 막고 담당 pane 에 고칠 것을 보낸다. 중간 이하는 통과
echo; echo "보안 검토 문(securityGate)"
{
NOW_STAMP="$(date '+%Y-%m-%d %H:%M')"
P3PANE="{\"id\":\"p3\",\"agent\":\"claude\",\"cwd\":\"$DWT\",\"label\":\"🤖 web-fe\"}"
FX_SHA="$(DG rev-parse --short feat/x)"
gate_reset; PLAN_EXTRA="- Security result: 높음 1 · 중간 0 @$FX_SHA · tree 000000000000 · 📦 web · 🌿 feat/x · $NOW_STAMP · 가짜
" direct_case "보안 높음 1 → 바로 머지 안 함" "$AUTO" no 1 '보안 검토 때문에 멈춤 — 보안 검토 높음 1개' "${GATE_ENV[@]}" FAKE_PANES="$P3PANE"
grep -q 'pane send-text p3 .*보안 검토 높음 1개' "$DSLOG" && echo "  ✔ 담당 pane(p3)에 고칠 것을 보냈다" || { echo "  ✖ 담당 pane 알림 — $(cat "$DSLOG")"; FAIL=1; }
gate_reset; PLAN_EXTRA="- Security result: 높음 0 · 중간 2 @$FX_SHA · tree 000000000000 · 📦 web · 🌿 feat/x · $NOW_STAMP · 가짜
" direct_case "보안 높음 0 · 중간 2 → 보고만 · 머지" "$AUTO" yes 0 '머지됨' "${GATE_ENV[@]}"
gate_reset; PLAN_EXTRA="- Security result: 높음 1 · 중간 0 @$FX_SHA · tree 000000000000 · 📦 api · 🌿 feat/x · $NOW_STAMP · 다른 레포
" direct_case "다른 레포의 보안 높음은 이 레포를 막지 않음" "$AUTO" yes 0 '머지됨' "${GATE_ENV[@]}"
# 위험한 수정(feat/sec — 명령 실행 줄)이면 이 HEAD 의 결과가 있어야 지나간다 — 없으면 security-reviewer 를 띄우고 기다린다
gate_reset; DBRANCH=feat/sec direct_case "위험한 수정 · 결과 없음 → security-reviewer 띄우고 기다리다 멈춤(머지 안 함)" "$AUTO" no 1 '보안 검토 기다리는 중 — 위험한 수정\(명령 실행\)' "${GATE_ENV[@]}" FAKE_SELF_PANE=p0
grep -q '^delegate security-reviewer --cwd .* --here --plan plans/task/x.md' "$DLOG" && echo "  ✔ 위험한 수정 — security-reviewer 를 띄웠다(--here)" || { echo "  ✖ security-reviewer 안 띄움 — $(cat "$DLOG")"; FAIL=1; }
gate_reset; DBRANCH=feat/sec direct_case "위험한 수정 · 띄운 결과 높음 0 → 머지" "$AUTO" yes 0 '머지됨' "${GATE_ENV[@]}" FAKE_SELF_PANE=p0 FAKE_SECURITY=clean
gate_reset; DBRANCH=feat/sec direct_case "위험한 수정 · 띄운 결과 높음 1 → 머지 안 함" "$AUTO" no 1 '보안 검토 때문에 멈춤 — 보안 검토 높음 1개' "${GATE_ENV[@]}" FAKE_SELF_PANE=p0 FAKE_SECURITY=high
gate_reset; DBRANCH=feat/sec PLAN_EXTRA="- Security review: $DWT · 📦 web · 🌿 feat/sec · pane p8 (security-reviewer) · 띄움 $NOW_STAMP
" direct_case "위험한 수정 · 이미 띄워 결과 기다리는 중 → 다시 안 띄우고 기다리다 멈춤" "$AUTO" no 1 '보안 검토 기다리는 중' "${GATE_ENV[@]}" FAKE_SELF_PANE=p0 FAKE_PANES='{"id":"p8","agent":"claude","label":"🤖 security-reviewer"}'
! grep -q 'security-reviewer' "$DLOG" && echo "  ✔ 이미 띄웠으면(그 pane 이 살아 있으면) 다시 띄우지 않는다" || { echo "  ✖ 두 번 띄움 — $(cat "$DLOG")"; FAIL=1; }
# 결과 없이 남은 띄움 줄 — 그 pane 이 닫혔으면 만료하고 다시 띄운다(PR #260 자동 리뷰 지적)
gate_reset; DBRANCH=feat/sec PLAN_EXTRA="- Security review: $DWT · 📦 web · 🌿 feat/sec · pane p8 (security-reviewer) · 띄움 $NOW_STAMP
" direct_case "위험한 수정 · 띄운 pane 이 닫힘 → 다시 띄움 · 결과 높음 0 → 머지" "$AUTO" yes 0 '머지됨' "${GATE_ENV[@]}" FAKE_SELF_PANE=p0 FAKE_SECURITY=clean
grep -q '^delegate security-reviewer --cwd .* --here --plan plans/task/x.md' "$DLOG" && echo "  ✔ 닫힌 pane 의 띄움 줄은 만료 — 다시 띄웠다" || { echo "  ✖ 다시 안 띄움 — $(cat "$DLOG")"; FAIL=1; }
gate_reset; direct_case "위험하지 않은 수정 · 결과 없음 → 지금처럼 머지" "$AUTO" yes 0 '머지됨' "${GATE_ENV[@]}"
! grep -q 'security-reviewer' "$DLOG" && echo "  ✔ 위험하지 않은 수정 — security-reviewer 안 띄움" || { echo "  ✖ 위험하지 않은데 띄움 — $(cat "$DLOG")"; FAIL=1; }
SEC_PLAN="$TMP/security-plan.md"
printf -- '- Security result: 높음 2 · 중간 0 @abc1234 · tree abcdef123456 · 📦 web · 🌿 feat/x · 2026-11-08 10:00\n' > "$SEC_PLAN"
node "$DCORE/scripts/security-gate.mjs" check --plan "$SEC_PLAN" --repo web --branch feat/x >/dev/null; SEC_CODE=$?
node "$DCORE/scripts/security-gate.mjs" check --plan "$SEC_PLAN" --repo web --branch feat/y >/dev/null; SEC_OTHER=$?
[ "$SEC_CODE" = 3 ] && [ "$SEC_OTHER" = 0 ] && echo "  ✔ security-gate.mjs check — 높음이면 3(ship.sh 가 멈춘다) · 다른 브랜치는 0" || { echo "  ✖ security-gate.mjs check — $SEC_CODE · $SEC_OTHER"; FAIL=1; }
} > "$GRP"; grp_end "보안 검토 문 — 높음이면 막고 담당 pane 에 · 결과 없으면 띄움 · 닫힌 띄움은 다시 · 위험하지 않으면 안 띄움 · check 종료 코드"
node --input-type=module -e "
  const { securityDiffParts, securityGate, securityPending, securityResultFor, securityRiskVerdict } = await import('$DCORE/scripts/lib/pr-auto.mjs')
  const at = { repo: 'web', branch: 'feat/x' }
  const result = (high, stamp = '2026-11-08 10:05', repo = 'web') => '- Security result: 높음 ' + high + ' · 중간 1 @abc1234 · tree abcdef123456 · 📦 ' + repo + ' · 🌿 feat/x · ' + stamp
  const launch = (stamp, repo = 'web') => '- Security review: /w · 📦 ' + repo + ' · 🌿 feat/x · pane p8 (security-reviewer) · 띄움 ' + stamp
  const local = (stamp) => new Date(stamp.replace(' ', 'T') + ':00').getTime()
  const sha = { repo: 'web', branch: 'feat/x', sha: 'abc1234def' }
  const risk = (path, line) => securityRiskVerdict({ files: [{ path }], added: line ? [line] : [] })
  const checks = [
    [securityGate('', at).block, false, '기록 없음 → 통과'],
    [securityGate(result(1), at).block, true, '높음 1 → 막음'],
    [securityGate(result(0), at).block, false, '높음 0 → 통과'],
    [securityGate([result(1), result(0, '2026-11-08 11:00')].join('\n'), at).block, false, '다시 검토해 높음 0 → 통과(마지막 줄)'],
    [securityGate(result(1, '2026-11-08 10:05', 'api'), at).block, false, '다른 레포 → 통과'],
    [securityPending(launch('2026-11-08 10:00'), at), true, '띄움 · 결과 없음 → 기다림'],
    [securityPending([launch('2026-11-08 10:00'), result(0)].join('\n'), at), false, '띄운 뒤 결과 → 기다리지 않음'],
    [securityPending([result(0), launch('2026-11-08 10:10')].join('\n'), at), true, '옛 결과 뒤 다시 띄움 → 기다림'],
    [securityPending(launch('2026-11-08 10:00', 'api'), at), false, '다른 레포의 띄움 줄 → 기다리지 않음'],
    [securityPending(launch('2026-11-08 10:00'), { ...at, now: local('2026-11-08 10:19'), maxAgeMs: 20 * 60_000 }), true, '띄운 지 19분 → 기다림'],
    [securityPending(launch('2026-11-08 10:00'), { ...at, now: local('2026-11-08 10:20'), maxAgeMs: 20 * 60_000 }), false, '띄운 지 20분 → 만료(다시 띄움)'],
    [securityPending(launch('2026-11-08 10:00'), { ...at, livePanes: new Set(['p8']) }), true, '띄운 pane 이 살아 있음 → 기다림'],
    [securityPending(launch('2026-11-08 10:00'), { ...at, livePanes: new Set(['p3']) }), false, '띄운 pane 이 닫힘 → 만료(다시 띄움)'],
    [securityPending(launch('2026-11-08 10:00'), { ...at, livePanes: null }), true, '화면 목록을 못 읽음 → pane 으로는 만료 안 함'],
    [Boolean(securityResultFor(result(0), { ...sha, tree: 'abcdef123456789' })), true, '같은 tree → 이 HEAD 결과'],
    [Boolean(securityResultFor(result(0), { ...sha, tree: '999999999999999' })), false, 'SHA 같아도 tree 다름 → 이 HEAD 결과 아님'],
    [Boolean(securityResultFor(result(0), { ...sha, tree: '' })), false, 'tree 를 모름 · 결과엔 tree → 아님'],
    [Boolean(securityResultFor('- Security result: 높음 0 · 중간 0 @abc1234 · 📦 web · 🌿 feat/x · 2026-11-08 10:05', { ...sha, tree: '999999999999' })), true, 'tree 없는 결과 → 같은 커밋이면 인정'],
    [securityRiskVerdict(securityDiffParts('diff --git a/scripts/ssh-run.sh b/scripts/ssh-run.sh\ndeleted file mode 100755\n--- a/scripts/ssh-run.sh\n+++ /dev/null\n@@ -1 +0,0 @@\n-echo hi\n')).risky, true, '민감 경로 파일을 지움 → 위험'],
    [securityRiskVerdict(securityDiffParts('diff --git a/docs/a.md b/docs/a.md\ndeleted file mode 100644\n--- a/docs/a.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n')).risky, false, '보안에 닿지 않는 파일을 지움 → 위험 아님'],
    [risk('src/a.mjs', 'const out = spawnSync(\"git\", args)').risky, true, '명령 실행'],
    [risk('src/a.mjs', 'await writeFile(target, text)').risky, true, '파일 쓰기'],
    [risk('src/a.mjs', 'const token = read()').risky, true, '비밀값'],
    [risk('scripts/ssh-run.sh', '').risky, true, '민감 경로 ssh'],
    [risk('src/a.mjs', 'const label = name + 1').risky, false, '보안에 닿지 않는 줄'],
  ]
  let bad = 0
  for (const [got, want, why] of checks) if (got !== want) { bad += 1; console.log('  ✖ ' + why + ' — 기대 ' + want + ' · 실제 ' + got) }
  if (bad) process.exit(1)
  console.log('  ✔ 보안 판정 — 높음만 막음 · 레포 · 브랜치마다 · 마지막 줄 · 띄움 뒤 결과 기다림(시간 · 닫힌 pane 이면 만료) · tree 일치 · 지운 파일 · 위험한 수정 갈래')
" || FAIL=1
# Actions 로 넘기기 길도 같은 문 — 넓은 수정이면 넘기기 전에 리뷰 · 승인 없이는 handoff/<브랜치> 를 밀지 않는다
{
handoff_case() {   # <이름> <기대 종료> <줄 정규식> [환경…]
  local name="$1" wantcode="$2" line="$3"; shift 3
  rm -rf "$DCORE/.requests" "$DCORE/.events.jsonl" "$DCORE/plans/task/"* "$TMP/data/state/handoff"; gate_reset
  git -C "$DORIGIN" update-ref -d refs/heads/handoff/feat/wide 2>/dev/null; DG checkout -q feat/wide
  printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoPr": false, "autoMergeConfirm": false, "actionsHandoff": true } ] }\n' > "$DCORE/athena.config.json"
  printf '# 시험 제목\n## Checkpoint\n- Status: in_progress\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/wide · pane p3 (web-fe)\n%s' "$DWT" "${PLAN_EXTRA:-}" > "$DCORE/plans/task/x.md"
  env PATH="/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-direct" "$@" \
    "$(command -v node)" "$DCORE/scripts/pr-auto.mjs" --handoff --plan plans/task/x.md --repo web --dir "$DWT" > "$TMP/direct.out" 2>&1
  local code=$?; DG checkout -q feat/x
  local got; got="$(grep -o '^- Auto merge: .*' "$DCORE/plans/task/x.md")"
  if [ "$code" = "$wantcode" ] && [ -z "$(git -C "$DORIGIN" for-each-ref refs/heads/handoff 2>/dev/null)" ] && printf '%s' "$got" | grep -Eq "$line"; then echo "  ✔ $name — ${got#- Auto merge: }"
  else echo "  ✖ $name — 종료 기대 $wantcode · 실제 $code · 줄: $got · 원격 $(git -C "$DORIGIN" for-each-ref refs/heads/handoff)"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; fi
}
handoff_case "넘기기 — 넓은 수정 + 수정 필요 → 넘기지 않음" 1 '리뷰 때문에 멈춤 — 수정 필요' "${GATE_ENV[@]}" FAKE_REVIEW=changes
PLAN_EXTRA="- Security result: 높음 1 · 중간 0 @${DWIDE:0:7} · tree $DWIDE_TREE · 📦 web · 🌿 feat/wide · $NOW_STAMP · 가짜
" handoff_case "넘기기 — 리뷰 승인이어도 보안 높음 1 → 넘기지 않음" 1 '보안 검토 때문에 멈춤' "${GATE_ENV[@]}" FAKE_REVIEW=approve
grep -q 'delegate reviewer' "$DLOG" && echo "  ✔ 넘기기 전에 reviewer 를 띄웠다" || { echo "  ✖ 넘기기 전 reviewer 없음"; FAIL=1; }
handoff_case "넘기기 — 넓은 수정 + 승인 → 리뷰 문을 지나 넘기기 단계로(이 시험 커밋엔 workflow 파일이 없어 거기서 멈춤)" 1 '리뷰 기다리는 중 — 넓은 수정' "${GATE_ENV[@]}" FAKE_REVIEW=approve
grep -q "리뷰 승인 @${DMORE:0:7}" "$TMP/direct.out" && grep -q 'athena-handoff.yml 가 없다' "$TMP/direct.out" && echo "  ✔ 승인 뒤 넘기기 단계(workflow 확인)까지 갔다" || { echo "  ✖ 승인 뒤 넘기기 단계"; sed 's/^/      /' "$TMP/direct.out"; FAIL=1; }
} > "$GRP"; grp_end "Actions 넘기기도 같은 리뷰 문 — 승인 없이는 handoff 안 밂"


# ── 넓은 수정 판정만 보기(--wide · 2026-11-26) — 작업자가 끝낼 때 부른다 · 리뷰 문과 같은 기준 · 미커밋 변경 · 새 파일까지 센다 · 아무것도 쓰지 않는다 ─────
echo; echo "넓은 수정 판정만 보기(pr-auto.mjs --wide)"
wide_of() {   # <브랜치> [계획서에 붙일 줄] → 출력 한 줄(끝 코드는 WIDE_RC)
  DG checkout -q "$1"
  printf '{ "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main" } ] }\n' > "$DCORE/athena.config.json"
  printf '# 시험 제목\n## Checkpoint\n- Status: in_progress\n%s' "${2:-}" > "$DCORE/plans/task/x.md"
  WIDE_OUT="$(env PATH="/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" "$DCORE/scripts/pr-auto.mjs" --wide --plan plans/task/x.md --repo "${WIDE_REPO:-web}" --dir "$DWT" 2>&1)"; WIDE_RC=$?
}
{
wide_of feat/x; WIDE_BEFORE="$(cat "$DCORE/plans/task/x.md")"
expect "작은 수정(문서 1개) → 아니오" '[ "$WIDE_OUT" = "넓은 수정: 아니오(문서만 1개)" ] && [ $WIDE_RC = 0 ]' "$WIDE_OUT"
expect "계획서에 아무것도 쓰지 않는다" '[ "$(cat "$DCORE/plans/task/x.md")" = "$WIDE_BEFORE" ]'
wide_of feat/wide
expect "커밋된 코드 파일 5개 이상 → 예" 'printf "%s" "$WIDE_OUT" | grep -Eq "^넓은 수정: 예\(코드 파일 [0-9]+개 ≥ 5\)$" && [ $WIDE_RC = 0 ]' "$WIDE_OUT"   # feat/wide 는 위 사례들이 커밋을 더해 5개 이상
# 미커밋 — 추적 파일 고침 1 + 새 파일 4(안 올린 것) = 코드 파일 5개
DG checkout -q feat/sec; printf 'export const more = 1\n' >> "$DWT/run.mjs"
for n in 1 2 3 4; do printf 'export const n%s = %s\n' "$n" "$n" > "$DWT/new$n.mjs"; done
wide_of feat/sec
expect "미커밋 변경 + 새 파일까지 센다 → 예" '[ "$WIDE_OUT" = "넓은 수정: 예(코드 파일 5개 ≥ 5)" ]' "$WIDE_OUT"
rm -f "$DWT"/new[1-4].mjs; DG checkout -q -- run.mjs
wide_of feat/wide '- Wide change: no (문구만 바꿈)
'
expect "코드 파일 5개 이상 + Wide change: no (이유) → 아니오" '[ "$WIDE_OUT" = "넓은 수정: 아니오(에이전트 표시(no — 문구만 바꿈))" ]' "$WIDE_OUT"
wide_of feat/wide '- Wide change: no
'
expect "이유 없는 no 는 무시 → 숫자 기준대로 예" 'printf "%s" "$WIDE_OUT" | grep -q "^넓은 수정: 예(코드 파일"' "$WIDE_OUT"
wide_of feat/x '- Wide change: yes (새 기능)
'
expect "계획서 Wide change: yes 표시 → 예" '[ "$WIDE_OUT" = "넓은 수정: 예(에이전트 표시(새 기능))" ]' "$WIDE_OUT"
WIDE_REPO=nope wide_of feat/x
expect "prBase 를 모르는 레포 → 판정 못 함 · 끝 코드 2" 'printf "%s" "$WIDE_OUT" | grep -q "^넓은 수정: 판정 못 함(nope 의 prBase" && [ $WIDE_RC = 2 ]' "$WIDE_OUT"
DG checkout -q feat/x
} > "$GRP"; grp_end "--wide — 문서만 아니오 · 코드 5개 예 · 미커밋 · 새 파일 · 표시 줄 · 판정 못 함"

[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
