#!/usr/bin/env bash
# PR 자동 리뷰 시험 — ship.sh · commit.sh 와 이어지는 곳(본문 고침 · 머지 결과 알림 · 충돌 풀기 · 이어 올린 PR · PR 끔 레포의 일반 PR 차단)
. "$(dirname "$0")/_pr-auto-lib.sh"   # 공통 준비 — test/_pr-auto-lib.sh (이 경로 글을 보고 검증 범위가 헬퍼를 따라간다)

# ── 가짜 본체로 — ship.sh --auto-push --body-file(결정 D2) · 머지 결과 pane 알림 ─────────────────────
# 코어 scripts/ 를 임시 폴더에 복사하고 화면(scripts/screen) · gh · 검증(reuse.sh)을 가짜로 바꾼다. origin 은 로컬 bare 레포
echo; echo "가짜 본체(ship.sh 본문 고침 · 머지 결과 알림)"
CORE="$TMP/core"; mkdir -p "$CORE/plans/task"; cp -R scripts "$CORE/scripts"
printf '{ "github": { "org": "acme" }, "repos": [{ "name": "web", "agents": ["web-fe"], "autoMerge": true, "prBase": "dev" }] }\n' > "$CORE/athena.config.json"
FLOG="$TMP/fake.log"; : > "$FLOG"
cat > "$CORE/scripts/screen" <<'SH'
#!/bin/sh
echo "screen $*" >> "$FAKE_LOG"
if [ "$1 $2" = "pane list" ]; then echo "{\"panes\":[${FAKE_PANES:-}]}"
elif [ "$1" = self ] && [ -n "${FAKE_SELF_PANE:-}" ]; then echo "{\"inside\":true,\"pane_id\":\"$FAKE_SELF_PANE\"}"   # pane 안 흉내
elif [ "$1" = self ]; then echo '{"inside":false,"pane_id":""}'   # 화면 밖 — 진짜 screen.py self 와 같은 모양(빈 답은 "못 읽음"이라 옛 --here 로 간다)
else echo '{}'; fi
SH
printf '#!/bin/sh\nexit 0\n' > "$CORE/scripts/verify/reuse.sh"
cat > "$BIN/gh" <<'SH'
#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "pr list") echo 7 ;;
  "pr view") printf '{"state":"OPEN","isDraft":false,"headRefOid":"%s","headRefName":"feat/x","mergeable":"%s","baseRefName":"dev"}\n' "$FAKE_HEAD" "${FAKE_MERGEABLE:-MERGEABLE}" ;;
  "pr diff") [ -n "${FAKE_DIFF:-}" ] && cat "$FAKE_DIFF" || exit 1 ;;
  "pr edit"|"pr merge"|"pr ready") ;;
  *) exit 1 ;;
esac
SH
chmod +x "$CORE/scripts/screen" "$CORE/scripts/verify/reuse.sh" "$BIN/gh"
G init -q --bare "$TMP/origin.git"
G clone -q "$TMP/origin.git" "$TMP/web" 2>/dev/null
G -C "$TMP/web" commit -q --allow-empty -m init && G -C "$TMP/web" push -q origin HEAD:main HEAD:dev 2>/dev/null
mkdir -p "$CORE/repos" && ln -s "$TMP/web" "$CORE/repos/web"
G -C "$TMP/web" worktree add -q -b feat/x "$TMP/wt" 2>/dev/null
WT="$(cd "$TMP/wt" && pwd -P)"
echo hi > "$WT/a.txt" && G -C "$WT" add a.txt && G -C "$WT" commit -q -m x && G -C "$WT" push -q origin feat/x 2>/dev/null
SHA="$(git -C "$WT" rev-parse HEAD)"; S7="${SHA:0:7}"
PLANF="plans/task/20261025-web-fe-x.md"
write_plan() {   # <Auto review 결과> <pane>
  printf '# 시험\n\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane %s (web-fe)\n- Auto review: web#7 @%s · %s · '"라운드 1/${FAST_REVIEWS}"' · 2026-10-25 10:00\n- PR: https://github.com/acme/web/pull/7 (feat/x → dev, draft · 2026-10-25 09:00)\n\n## Commits\n- `%s` feat/x · 시험 · push → dev PR https://github.com/acme/web/pull/7\n' "$WT" "$2" "$S7" "$1" "$S7" > "$CORE/$PLANF"
}
printf '## 작업 내용\n시험\n\n## 변경 사항\n- a\n\n## 검증\n- 통과\n\n## 확인 필요\n- 없음\n' > "$TMP/body.md"
printf '## 작업 내용\n시험\n' > "$TMP/bad-body.md"
QUEUE="$TMP/queue"; mkdir -p "$QUEUE/.watcher.lock"; echo $$ > "$QUEUE/.watcher.lock/pid"   # 처리기가 이미 도는 것처럼 — 대기열에만 넣고 진짜 리뷰어를 띄우지 않는다
ENVS=(env PATH="$BIN:$PATH" FAKE_LOG="$FLOG" FAKE_HEAD="$SHA" ATHENA_PR_AUTO_QUEUE="$QUEUE" ATHENA_DATA_DIR="$TMP/data")
ship() { (cd "$CORE" && "${ENVS[@]}" bash scripts/ship.sh --plan "$PLANF" --dir "$WT" --auto-push "$@" 2>&1); }

write_plan '수정 필요' p3; : > "$FLOG"
OUT="$(ship --body-file "$TMP/bad-body.md")"; CODE=$?
{
expect "본문 필수 절이 없으면 거절 · gh pr edit 안 부름" '[ $CODE != 0 ] && ! grep -q "gh pr edit" "$FLOG"' "$OUT"
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"
OUT="$(ship --body-file "$TMP/body.md")"; CODE=$?
expect "자동 리뷰의 수정 요청이 없으면 거절 · gh pr edit 안 부름" '[ $CODE != 0 ] && ! grep -q "gh pr edit" "$FLOG"' "$OUT"
write_plan '수정 필요' p3; : > "$FLOG"
OUT="$(ship)"; CODE=$?
expect "--body-file 없이 올릴 커밋도 없으면 거절" '[ $CODE != 0 ] && echo "$OUT" | grep -q "body-file"' "$OUT"
} > "$GRP"; grp_end "본문 고침 거절 — 필수 절 없음 · 수정 요청 없음 · body-file 도 커밋도 없음(gh pr edit 안 부름)"
: > "$FLOG"
OUT="$(ship --body-file "$TMP/body.md")"; CODE=$?
{
expect "조건이 다 차면 본문만 — gh pr edit 7 --body-file · push 없음" '[ $CODE = 0 ] && grep -q "gh pr edit 7 --body-file $TMP/body.md" "$FLOG" && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$SHA" ]' "$OUT"
expect "계획서 줄은 본문 고침(같은 HEAD · 라운드 그대로) · 대기열에 같은 HEAD" 'grep -q "^- Auto review: web#7 @$S7 · 본문 고침 — 다시 리뷰 대기 · '"라운드 1/${FAST_REVIEWS}"'" "$CORE/$PLANF" && grep -lq "$SHA" "$QUEUE"/*.json' "$(grep 'Auto review' "$CORE/$PLANF"; ls "$QUEUE")"
} > "$GRP"; grp_end "본문 고침 — gh pr edit 만 · push 없음 · 계획서 줄 같은 HEAD · 대기열"
rm -f "$QUEUE"/*.json

# 머지 결과 알림 — 머지 확인 답(머지 · 보류)을 처리한 뒤 Work ref pane 이 살아 있으면 한 줄 · 없으면 보내지 않는다
confirm() {   # <답> — 요청을 열고 답한 뒤 머지 확인 대기 파일을 둔다
  (cd "$CORE" && "${ENVS[@]}" node --input-type=module -e "
    const { openRequest, answerRequest } = await import('./scripts/lib/requests.mjs')
    const { writeFileSync, mkdirSync, realpathSync } = await import('node:fs')
    const request = openRequest('.', { kind: 'question', title: '머지할까요?', options: [{ label: '머지' }, { label: '보류' }], links: { plan: '$PLANF' } }).request
    answerRequest('.', request.id, { choice: process.argv[1], by: 'board' })
    mkdirSync('$QUEUE/confirm', { recursive: true })
    writeFileSync('$QUEUE/confirm/web-7.json', JSON.stringify({ plan: '$PLANF', repo: 'web', number: '7', sha: '$SHA', round: 1, request: request.id, worktree: '$WT', base: 'dev', root: realpathSync('.'), packId: null }))" "$1")
}
run_confirms() { (cd "$CORE" && "${ENVS[@]}" FAKE_PANES="$1" node --input-type=module -e "await (await import('./scripts/pr-auto.mjs')).checkConfirms()" 2>&1); }
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"; confirm 머지
OUT="$(run_confirms '{"id":"p3"}')"
{
expect "머지 → squash · 머지됨은 pane 에 넣지 않고 계획서 줄에만(할 일 없는 알림)" 'grep -q "gh pr merge 7 .*--squash" "$FLOG" && ! grep -q "send-text" "$FLOG" && ! grep -q "send-keys" "$FLOG" && grep -q "· 머지됨 — squash → dev ·" "$CORE/$PLANF"' "$OUT
$(cat "$FLOG")"
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"; confirm 보류
OUT="$(run_confirms '{"id":"p3"}')"
expect "보류 → 머지 안 함 · pane p3 에 '… 보류' 한 줄(머지됨이 아닌 결과는 그대로 넣는다)" '! grep -q "gh pr merge" "$FLOG" && grep -q "screen pane send-text p3 \[자동 리뷰 → web-fe\] PR web#7 @$S7 — 보류" "$FLOG" && grep -q -e "--enter\$" "$FLOG"' "$OUT
$(cat "$FLOG")"
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"; confirm 머지
OUT="$(run_confirms '')"
expect "pane 이 없으면 보내지 않는다(닫힌 세션을 다시 열지 않음) · 계획서 줄은 머지됨" '! grep -q "send-text" "$FLOG" && ! grep -q "delegate" "$FLOG" && grep -q "· 머지됨 — squash → dev ·" "$CORE/$PLANF"' "$OUT
$(cat "$FLOG")"
} > "$GRP"; grp_end "머지 결과 알림 — 머지됨은 pane 에 안 넣음 · 보류는 넣음 · pane 없으면 안 보냄"

# push 하자마자 대기열에(지시 1) — --auto-push 로 새 커밋을 올리면 그 HEAD 가 바로 대기열에 · 같은 HEAD 를 또 넣어도(현황판 안전망) 하나만
echo more > "$WT/b.txt" && G -C "$WT" add b.txt && G -C "$WT" commit -q -m y
SHA2="$(git -C "$WT" rev-parse HEAD)"
write_plan '수정 필요' p3; printf -- '- `%s` feat/x · 시험2 · push 안 함\n' "${SHA2:0:7}" >> "$CORE/$PLANF"; : > "$FLOG"
OUT="$(ship)"; CODE=$?
{
expect "--auto-push 새 커밋 → push · 그 HEAD 가 바로 대기열에(5분 감지를 기다리지 않음)" '[ $CODE = 0 ] && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$SHA2" ] && [ "$(grep -l "$SHA2" "$QUEUE"/*.json 2>/dev/null | wc -l | tr -d " ")" = 1 ]' "$OUT
$(ls "$QUEUE")"
OUT="$(cd "$CORE" && "${ENVS[@]}" node scripts/pr-auto.mjs --enqueue --plan "$PLANF" --pr web#7 --head "$SHA2" 2>&1)"
expect "현황판이 같은 HEAD 를 또 넣어도 하나만(이미 대기열에 있다)" 'echo "$OUT" | grep -q "이미" && [ "$(ls "$QUEUE"/*.json | wc -l | tr -d " ")" = 1 ]' "$OUT"
} > "$GRP"; grp_end "--auto-push — 새 커밋 push · 바로 대기열 · 같은 HEAD 는 하나만"
rm -f "$QUEUE"/*.json

# 충돌 풀기(2026-10-26 · PR #21 재현) — base 를 합친 merge 중이면 commit.sh 가 merge 커밋을 만들고, ship.sh --auto-push 가 충돌로 검증 대기인 PR 에 올린다
echo; echo "충돌 풀기(commit.sh merge 커밋 · ship.sh --auto-push 충돌 검증 대기)"
printf '#!/bin/sh\nexit 0\n' > "$CORE/scripts/verify/web.sh"; chmod +x "$CORE/scripts/verify/web.sh"
git -C "$TMP/web" config user.name t && git -C "$TMP/web" config user.email t@t
G clone -q "$TMP/origin.git" "$TMP/dev-side" 2>/dev/null
G -C "$TMP/dev-side" checkout -q dev && echo dev > "$TMP/dev-side/a.txt" && echo base > "$TMP/dev-side/c.txt" \
  && G -C "$TMP/dev-side" add a.txt c.txt && G -C "$TMP/dev-side" commit -q -m dev && G -C "$TMP/dev-side" push -q origin dev 2>/dev/null
commit() { (cd "$CORE" && "${ENVS[@]}" bash scripts/commit.sh --plan "$PLANF" --dir "$WT" -m "merge dev" -- "$@" 2>&1); }
merge_base() { (cd "$CORE" && "${ENVS[@]}" bash scripts/commit.sh --plan "$PLANF" --dir "$WT" "$@" --merge-base 2>&1); }
write_plan '검증 대기 — 충돌 확인 CONFLICTING' p3
OUT="$(merge_base -m x)"; CODE=$?
{
expect "--merge-base 에 -m 을 주면 거부(merge 안 걺)" '[ $CODE != 0 ] && ! git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null' "$OUT"
echo dirty >> "$WT/b.txt"
OUT="$(merge_base)"; CODE=$?
expect "--merge-base — 커밋 안 한 변경이 있으면 거부" '[ $CODE != 0 ] && echo "$OUT" | grep -q "커밋하지 않은 변경" && ! git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null' "$OUT"
G -C "$WT" checkout -q -- b.txt
OUT="$(merge_base)"; CODE=$?
DEV_SHA="$(git -C "$WT" rev-parse origin/dev)"
expect "--merge-base — prBase(origin/dev)를 merge --no-ff --no-commit 으로 걺 · 충돌 파일(a.txt)과 다음 명령을 알림 · 커밋은 안 함" '[ $CODE = 0 ] && [ "$(git -C "$WT" rev-parse MERGE_HEAD)" = "$DEV_SHA" ] && [ "$(git -C "$WT" rev-parse HEAD)" = "$SHA2" ] && echo "$OUT" | grep -q "a.txt" && echo "$OUT" | grep -q "다음:"' "$OUT"
OUT="$(merge_base)"; CODE=$?
expect "--merge-base — 이미 merge 중이면 거부" '[ $CODE != 0 ] && echo "$OUT" | grep -q "이미 merge 중"' "$OUT"
expect "merge 중 · 충돌이 남음(시험 준비)" '[ -n "$(git -C "$WT" diff --name-only --diff-filter=U)" ] && git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null'
} > "$GRP"; grp_end "--merge-base — -m · 미커밋 거부 · prBase 를 걺 · 이미 merge 중 거부"
OUT="$(commit c.txt)"; CODE=$?
{
expect "merge 중 풀지 않은 파일(a.txt)이 남으면 거부 · 스테이징된 merge 결과는 그대로" '[ $CODE != 0 ] && echo "$OUT" | grep -q "풀지 않은 파일이 있다: a.txt" && git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null && [ "$(git -C "$WT" diff --cached --name-only --diff-filter=A)" = c.txt ]' "$OUT"
OUT="$(commit a.txt)"; CODE=$?
expect "충돌 표시가 남은 파일은 거부" '[ $CODE != 0 ] && echo "$OUT" | grep -q "충돌 표시" && git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null' "$OUT"
printf 'hi\ndev\n' > "$WT/a.txt"
OUT="$(commit a.txt)"; CODE=$?
MERGE_COMMIT="$(git -C "$WT" rev-parse HEAD)"
expect "충돌을 풀면 merge 커밋 — 두 번째 부모가 origin/dev · base 쪽 c.txt 도 들어감 · 계획서 Commits 에 merge 커밋 기록" '[ $CODE = 0 ] && [ "$(git -C "$WT" rev-parse HEAD^2)" = "$DEV_SHA" ] && git -C "$WT" cat-file -e HEAD:c.txt && ! git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null && grep -q "${MERGE_COMMIT:0:7}\` — merge dev · merge 커밋(${DEV_SHA:0:7} 합침)" "$CORE/$PLANF"' "$OUT
$(grep -A3 '## Commits' "$CORE/$PLANF")"
echo z > "$WT/z.txt" && G -C "$WT" add z.txt && echo y > "$WT/y.txt"
OUT="$(commit y.txt)"; CODE=$?
expect "merge 가 아니면 남의 스테이징 거부는 그대로" '[ $CODE != 0 ] && echo "$OUT" | grep -q "원래 스테이징돼 있던 변경이 있다"' "$OUT"
} > "$GRP"; grp_end "merge 커밋 — 풀지 않은 파일 · 충돌 표시 거부 · 풀면 merge 커밋 · merge 가 아니면 남의 스테이징 거부"
G -C "$WT" reset -q -- z.txt; rm -f "$WT/z.txt" "$WT/y.txt"
# athena-studio#97 — 줄이 다른 이유(워크트리 HEAD 다름)로 검증 대기인 사이 base 와 충돌이 생기면 줄은 그대로다. GitHub 가 지금 CONFLICTING 이면 merge 커밋을 받는다
write_plan "검증 대기 — 워크트리 HEAD 가 PR HEAD(${SHA2:0:7})와 다름" p3; printf -- '- `%s` feat/x · merge dev · push 안 함\n' "${MERGE_COMMIT:0:7}" >> "$CORE/$PLANF"; : > "$FLOG"
OUT="$(FAKE_MERGEABLE=CONFLICTING ship)"; CODE=$?
{
expect "줄이 충돌이 아니어도 GitHub 가 CONFLICTING 이면 base 를 합친 merge 커밋을 빨리 감기 push(#97)" '[ $CODE = 0 ] && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$MERGE_COMMIT" ]' "$OUT"
# 요청 줄이 없어도 이 계획서의 열린 PR 에 기록된 커밋을 빨리 감기로 올리는 것은 받는다(옆 reviewer · 아테나 지시로 고친 커밋)
echo plain > "$WT/plain.txt" && G -C "$WT" add plain.txt && G -C "$WT" commit -q -m plain; PLAIN="$(git -C "$WT" rev-parse HEAD)"
write_plan '승인 — 머지 대기' p3; : > "$FLOG"
OUT="$(ship)"; CODE=$?
expect "요청 줄 없음 + 열린 PR + 기록 없는 커밋은 거절" '[ $CODE != 0 ] && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$MERGE_COMMIT" ]' "$OUT"
printf -- '- `%s` feat/x · plain · push 안 함\n' "${PLAIN:0:7}" >> "$CORE/$PLANF"
OUT="$(ship)"; CODE=$?
expect "요청 줄 없음 + 열린 PR + 기록된 커밋 → 빨리 감기 push" '[ $CODE = 0 ] && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$PLAIN" ]' "$OUT"
G -C "$WT" reset -q --hard "$MERGE_COMMIT"; G -C "$TMP/web" fetch -q origin 2>/dev/null
G -C "$TMP/origin.git" update-ref refs/heads/feat/x "$MERGE_COMMIT"; G -C "$WT" fetch -q origin 2>/dev/null
git -C "$TMP/origin.git" update-ref refs/heads/feat/x "$SHA2"; rm -f "$QUEUE"/*.json   # 아래 시험은 push 전 상태에서
write_plan '검증 대기 — 충돌 확인 CONFLICTING' p3; printf -- '- `%s` feat/x · merge dev · push 안 함\n' "${MERGE_COMMIT:0:7}" >> "$CORE/$PLANF"; : > "$FLOG"
OUT="$(ship)"; CODE=$?
expect "충돌로 검증 대기면 merge 커밋을 빨리 감기 push · 그 HEAD 가 대기열에" '[ $CODE = 0 ] && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$MERGE_COMMIT" ] && grep -lq "$MERGE_COMMIT" "$QUEUE"/*.json' "$OUT"
} > "$GRP"; grp_end "빨리 감기 push — CONFLICTING merge 커밋 · 기록 없는 커밋 거절 · 기록된 커밋 · 충돌 검증 대기"
rm -f "$QUEUE"/*.json
# base 합침 merge 커밋은 라운드를 올리지 않는다 — 지난 줄이 상한 라운드(2/3)여도 멈추거나 이어받지 않고 그 라운드로 한 번 리뷰(--dry-run 으로 할 일만)
sed -i.bak "s|^- Auto review: .*|- Auto review: web#7 @${SHA2:0:7} · 검증 대기 — 충돌 확인 CONFLICTING · 라운드 2/2 · 2026-10-26 10:00|" "$CORE/$PLANF" && rm -f "$CORE/$PLANF.bak"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MERGE_COMMIT" FAKE_CODEX=ok node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
{
expect "base 합침 — 라운드 2 그대로 · 멈춤 · 이어받음 아님 · 리뷰를 돈다" 'echo "$OUT" | grep -q "'"라운드 2/${FAST_REVIEWS}"' · ⚡ 빠른 길 · base 합침" && ! echo "$OUT" | grep -q "멈춤" && ! echo "$OUT" | grep -q "'"${FAST_LAST}"' 짧은 리뷰 —"' "$OUT"
# athena-studio#97 모양 — 계획서 하나에 PR 이 여럿이라 Work ref 가 다른 PR 의 (지워진) 워크트리 · 줄은 "검증 대기 — 워크트리 HEAD 다름 · 2/2".
# PR 브랜치(feat/x)를 체크아웃한 워크트리를 레포 워크트리 목록에서 찾아 base 합침으로 본다
GONEF="plans/task/20261025-web-fe-gone.md"
sed -e "s|^- Work ref: [^ ]*|- Work ref: $TMP/gone-wt|" -e "s|^- Auto review: .*|- Auto review: web#7 @${SHA2:0:7} · 검증 대기 — 워크트리 HEAD 가 PR HEAD(${SHA2:0:7})와 다름 · 라운드 2/2 · 2026-10-26 10:00|" "$CORE/$PLANF" > "$CORE/$GONEF"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MERGE_COMMIT" FAKE_CODEX=ok node scripts/pr-auto.mjs --plan "$GONEF" --pr web#7 --dry-run 2>&1)"
expect "Work ref 가 지워진 다른 워크트리여도 PR 브랜치 워크트리로 base 합침(#97 — 라운드 2 그대로 · 멈춤 아님)" 'echo "$OUT" | grep -q "'"라운드 2/${FAST_REVIEWS}"' · ⚡ 빠른 길 · base 합침" && echo "$OUT" | grep -q "PR 브랜치 feat/x 의 워크트리 $WT" && ! echo "$OUT" | grep -q "멈춤"' "$OUT"
rm -f "$CORE/$GONEF"
sed -i.bak "s|^- Auto review: web#7 @[0-9a-f]* |- Auto review: web#7 @${SHA:0:7} |" "$CORE/$PLANF" && rm -f "$CORE/$PLANF.bak"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MERGE_COMMIT" FAKE_CODEX=ok node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "첫 부모가 지난번 본 HEAD 가 아니면 base 합침 아님 — 평소처럼 라운드 3(멈춤)" 'echo "$OUT" | grep -q "'"라운드 3/${FAST_REVIEWS}"'" && echo "$OUT" | grep -q "할 일: 멈춤" && ! echo "$OUT" | grep -q "base 합침"' "$OUT"
# 충돌 풀기 밖의 수정을 섞은 merge 커밋은 base 합침이 아니다(내용 검사 — PR #22 라운드 1) — dev 에 새 커밋 → --merge-base(충돌 없음) → b.txt 도 고쳐 같이 커밋
echo dev2 > "$TMP/dev-side/d.txt" && G -C "$TMP/dev-side" add d.txt && G -C "$TMP/dev-side" commit -q -m dev2 && G -C "$TMP/dev-side" push -q origin dev 2>/dev/null
OUT="$(merge_base)"
echo mixed >> "$WT/b.txt"
OUT="$OUT
$(commit b.txt)"; CODE=$?
MIXED="$(git -C "$WT" rev-parse HEAD)"
expect "(시험 준비) 다른 수정을 섞은 merge 커밋" '[ $CODE = 0 ] && [ "$(git -C "$WT" rev-parse -q --verify HEAD^2)" = "$(git -C "$WT" rev-parse origin/dev)" ]' "$OUT"
sed -i.bak "s|^- Auto review: .*|- Auto review: web#7 @${MERGE_COMMIT:0:7} · 검증 대기 — 충돌 확인 CONFLICTING · 라운드 2/2 · 2026-10-26 10:00|" "$CORE/$PLANF" && rm -f "$CORE/$PLANF.bak"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "충돌 풀기 밖의 수정(b.txt)이 섞이면 base 합침 아님 — 평소처럼 라운드 3(멈춤)" 'echo "$OUT" | grep -q "'"라운드 3/${FAST_REVIEWS}"'" && echo "$OUT" | grep -q "할 일: 멈춤" && ! echo "$OUT" | grep -q "base 합침"' "$OUT"
} > "$GRP"; grp_end "base 합침 판정 — 라운드 그대로 · 지워진 Work ref(#97) · 첫 부모 다름 · 섞인 수정은 아님"
# 큰 diff(syung#23) — 생성물은 빼고 · 코드 파일이 넘치면 승인이어도 "잘린 diff 승인" 으로 머지하지 않음(--dry-run 으로 할 일만)
node -e '
const line = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n${body}\n`
const code = (path) => line(path, Array.from({ length: 900 }, (_, index) => `+const v${index} = ${index} // ${"x".repeat(40)}`).join("\n"))
require("fs").writeFileSync(process.argv[1], line("data/fare/bus_km.json", `+{${"\"1\":2,".repeat(300000)}}`) + code("src/a.mjs") + code("src/b.mjs"))
require("fs").writeFileSync(process.argv[2], line("data/fare/bus_km.json", `+{${"\"1\":2,".repeat(300000)}}`) + line("src/fare.mjs", "+export const fare = 1"))
require("fs").writeFileSync(process.argv[3], line("src/huge.mjs", Array.from({ length: 1300 }, (_, index) => `+const v${index} = ${index} // ${"x".repeat(40)}`).join("\n")))
' "$TMP/big.diff" "$TMP/gen.diff" "$TMP/huge.diff"
# 2026-11-25 — 리뷰는 최대 3번이라 1차 수정 필요 뒤 2라운드는 평소 증분 리뷰(짧은 리뷰도 같은 diff 길)
cp "$CORE/$PLANF" "$TMP/plan.keep"; write_plan '수정 필요' p3
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/big.diff" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
{
expect "큰 diff — 생성물(bus_km.json)은 뺐다고 알림 · 코드 파일이 넘치면 2조각으로 나눠 다 보고 평소 승인 길(잘린 diff 멈춤 없음 · #267)" 'echo "$OUT" | grep -q "생성물 1개는 diff 본문에서 뺐다: data/fare/bus_km.json" && echo "$OUT" | grep -q "2조각으로 나눠 리뷰" && echo "$OUT" | grep -q "할 일: 안 정한 결정 · 같은 HEAD 검증" && ! echo "$OUT" | grep -q "잘린 diff 승인"' "$OUT"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/huge.diff" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "파일 하나가 한 조각보다 크면 나눠도 못 봄 — 승인이어도 머지하지 않음(잘린 diff 승인 · 사람에게)" 'echo "$OUT" | grep -q "할 일: 머지하지 않음 — 잘린 diff 승인(못 본 코드 파일 1개)" && echo "$OUT" | grep -q "다 넣지 못했다" && ! echo "$OUT" | grep -q "조각으로 나눠"' "$OUT"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/gen.diff" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "큰 생성물 + 작은 코드 — 생성물만 빼고 다 넣었으면 평소 승인 길(머지 확인 요청)" 'echo "$OUT" | grep -q "생성물 1개는 diff 본문에서 뺐다" && echo "$OUT" | grep -q "할 일: 안 정한 결정 · 같은 HEAD 검증" && ! echo "$OUT" | grep -q "잘린 diff 승인"' "$OUT"
# PR 이 스스로 .gitattributes 에 "src/** linguist-generated" 를 더해도 판별은 base(origin/dev) 쪽 — src 코드는 그대로 리뷰(PR #62 자동 리뷰 지적 1)
ATTR_BLOB="$(printf 'src/** linguist-generated\n' | git -C "$WT" hash-object -w --stdin)"
ATTR_TREE="$(printf '100644 blob %s\t.gitattributes\n' "$ATTR_BLOB" | git -C "$WT" mktree)"
ATTR_HEAD="$(G -C "$WT" commit-tree "$ATTR_TREE" -p "$MIXED" -m attrs)"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$ATTR_HEAD" FAKE_CODEX=ok FAKE_DIFF="$TMP/gen.diff" FAKE_PROMPT="$TMP/prompt.txt" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "PR HEAD 의 .gitattributes 는 쓰지 않음 — src/fare.mjs 는 생성물로 안 빠지고 본문이 프롬프트에" 'grep -q "export const fare" "$TMP/prompt.txt" && ! grep -q "src/fare.mjs\` · .*생성물이라 생략" "$TMP/prompt.txt" && echo "$OUT" | grep -q "생성물 1개는 diff 본문에서 뺐다: data/fare/bus_km.json$"' "$OUT"
# 지난 라운드가 코드 파일을 다 못 봤으면(history missed) 2라운드는 증분이 아니라 PR 전체 diff 를 다시(지적 2) — 다시 넣어도 넘치면 또 잘린 승인
mkdir -p "$QUEUE/history"; printf '{"sha":"%s","round":1,"findings":[],"autoDecisions":[],"missed":["src/b.mjs"]}' "$SHA" > "$QUEUE/history/web-7.json"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/gen.diff" FAKE_PROMPT="$TMP/prompt.txt" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "지난 라운드 못 본 파일 있음 → 2라운드는 PR 전체 diff(증분 아님) · 프롬프트에 그렇게" 'grep -q "지난 리뷰가 diff 일부만 봐서 전체를 다시 넣었다" "$TMP/prompt.txt" && grep -q "export const fare" "$TMP/prompt.txt" && echo "$OUT" | grep -q "라운드 2/"' "$OUT"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/huge.diff" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "전체를 다시 넣어도 넘치면 2라운드 승인도 잘린 diff 승인(머지 안 함)" 'echo "$OUT" | grep -q "할 일: 머지하지 않음 — 잘린 diff 승인"' "$OUT"
printf '{"sha":"%s","round":1,"findings":[],"autoDecisions":[],"missed":[]}' "$SHA" > "$QUEUE/history/web-7.json"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/big.diff" FAKE_PROMPT="$TMP/prompt.txt" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "지난 라운드가 다 봤으면 2라운드는 지금처럼 증분 diff(gh pr diff 안 씀)" 'grep -q "이후 바뀐 것만" "$TMP/prompt.txt" && ! grep -q "전체를 다시" "$TMP/prompt.txt"' "$OUT"
rm -f "$QUEUE/history/web-7.json"
# 코드로 보이는 긴 줄(압축 코드)을 줄인 PR — 승인이어도 잘린 diff 승인(R1 · 지적 3) · 데이터 모양 긴 줄만이면 평소 승인
node -e '
const line = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n${body}\n`
require("fs").writeFileSync(process.argv[1], line("web/app.js", "+" + "function a(b){return b.map(c=>c*2)};".repeat(60)))
require("fs").writeFileSync(process.argv[2], line("web/index.html", "+<script>const stationData=" + "[1,2],".repeat(2000) + "</script>"))
' "$TMP/code-long.diff" "$TMP/data-long.diff"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/code-long.diff" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "코드 긴 줄을 줄인 PR — 승인이어도 잘린 diff 승인(못 본 코드 파일 1개 · 머지 안 함)" 'echo "$OUT" | grep -q "할 일: 머지하지 않음 — 잘린 diff 승인(못 본 코드 파일 1개)"' "$OUT"
OUT="$(cd "$CORE" && "${ENVS[@]}" FAKE_HEAD="$MIXED" FAKE_CODEX=ok FAKE_DIFF="$TMP/data-long.diff" node scripts/pr-auto.mjs --plan "$PLANF" --pr web#7 --dry-run 2>&1)"
expect "데이터 모양 긴 줄만 줄인 PR(syung#12) — 평소 승인 길" 'echo "$OUT" | grep -q "할 일: 안 정한 결정 · 같은 HEAD 검증" && ! echo "$OUT" | grep -q "잘린 diff 승인"' "$OUT"
} > "$GRP"; grp_end "큰 diff — 조각 나누기 · 한 파일 넘침 · 생성물 · base 의 .gitattributes · 못 본 파일 다시 · 긴 줄"
cp "$TMP/plan.keep" "$CORE/$PLANF"   # 뒤 시험은 앞의 계획서 줄(충돌 검증 대기)을 그대로 쓴다
# merge 커밋은 스테이징 전체를 검사한다(지정 파일만이 아니라) — 충돌 표시가 남은 파일을 미리 스테이징하고 인자에서 빼도 거부
echo dev3 > "$TMP/dev-side/b.txt" && G -C "$TMP/dev-side" add b.txt && G -C "$TMP/dev-side" commit -q -m dev3 && G -C "$TMP/dev-side" push -q origin dev 2>/dev/null
echo side > "$WT/e.txt" && G -C "$WT" add e.txt && G -C "$WT" commit -q -m e
merge_base >/dev/null
G -C "$WT" add b.txt; echo more >> "$WT/e.txt"
OUT="$(commit e.txt)"; CODE=$?
{
expect "merge 커밋 — 지정하지 않은 스테이징 파일(b.txt)에 충돌 표시가 남았으면 거부" '[ $CODE != 0 ] && echo "$OUT" | grep -q "merge 결과에 충돌 표시" && echo "$OUT" | grep -q "b.txt"' "$OUT"
# 충돌을 지금 브랜치 내용으로 풀어 HEAD 와 차이가 없는 merge 결과도 merge 커밋이 된다 — 파일 없이도 · HEAD 와 같은 파일을 줘도(PR #22 라운드 2)
# 앞 시험이 실패하며 스테이징한 e.txt(merge 중 실패는 스테이징을 되돌리지 않는다)도 HEAD 로
G -C "$WT" show HEAD:b.txt > "$WT/b.txt" && G -C "$WT" add b.txt && G -C "$WT" reset -q -- e.txt && G -C "$WT" checkout -q -- e.txt
expect "(시험 준비) merge 결과가 HEAD 와 같다" '[ -z "$(git -C "$WT" diff --cached --name-only HEAD)" ] && git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null' "$(git -C "$WT" status --short; git -C "$WT" diff --cached --stat HEAD)"
OUT="$(cd "$CORE" && "${ENVS[@]}" bash scripts/commit.sh --plan "$PLANF" --dir "$WT" -m "merge dev" -- b.txt 2>&1)"; CODE=$?
expect "HEAD 와 같은 내용으로 푼 파일을 줘도 merge 커밋(두 번째 부모 = origin/dev)" '[ $CODE = 0 ] && [ "$(git -C "$WT" rev-parse HEAD^2)" = "$(git -C "$WT" rev-parse origin/dev)" ]' "$OUT"
echo dev4 > "$TMP/dev-side/f.txt" && G -C "$TMP/dev-side" add f.txt && G -C "$TMP/dev-side" commit -q -m dev4 && G -C "$TMP/dev-side" push -q origin dev 2>/dev/null
merge_base >/dev/null
OUT="$(cd "$CORE" && "${ENVS[@]}" bash scripts/commit.sh --plan "$PLANF" --dir "$WT" -m "merge dev" -- 2>&1)"; CODE=$?
expect "merge 중이면 파일 없이(-- 만)도 merge 커밋 · base 쪽 f.txt 포함" '[ $CODE = 0 ] && [ "$(git -C "$WT" rev-parse HEAD^2)" = "$(git -C "$WT" rev-parse origin/dev)" ] && git -C "$WT" cat-file -e HEAD:f.txt' "$OUT"
OUT="$(cd "$CORE" && "${ENVS[@]}" bash scripts/commit.sh --plan "$PLANF" --dir "$WT" -m "x" -- 2>&1)"; CODE=$?
expect "merge 중이 아니면 파일 없는 호출은 거부(사용법)" '[ $CODE = 2 ]' "$OUT"
} > "$GRP"; grp_end "merge 커밋 — 스테이징 전체 검사 · HEAD 와 같은 결과 · 파일 없이 · merge 아니면 사용법 거부"
# 충돌로 검증 대기인 PR 의 --auto-push 는 base 를 합친 merge 커밋 하나만(PR #22 라운드 3) — 줄은 지금 충돌 검증 대기(origin/feat/x = MERGE_COMMIT)
PUSHED_BEFORE="$(git -C "$TMP/origin.git" rev-parse feat/x)"; : > "$FLOG"
OUT="$(ship)"; CODE=$?
{
expect "충돌 검증 대기 — merge 커밋이어도 첫 부모가 origin/feat/x 가 아니면 거절(그 사이 커밋이 더 있음)" '[ $CODE != 0 ] && echo "$OUT" | grep -q "첫 부모가 origin/feat/x 가 아니다" && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$PUSHED_BEFORE" ]' "$OUT"
echo g > "$WT/g.txt" && G -C "$WT" add g.txt && G -C "$WT" commit -q -m g
printf -- '- `%s` feat/x · g · push 안 함\n' "$(git -C "$WT" rev-parse --short HEAD)" >> "$CORE/$PLANF"
OUT="$(ship)"; CODE=$?
expect "충돌 검증 대기 — merge 커밋이 아닌 커밋은 거절" '[ $CODE != 0 ] && echo "$OUT" | grep -q "merge 커밋이 아니다" && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$PUSHED_BEFORE" ]' "$OUT"
} > "$GRP"; grp_end "충돌 검증 대기 --auto-push — 첫 부모 다름 · merge 커밋 아님은 거절"
# .npmrc 토큰 검사 — ${이름} 참조 · 빈 값은 커밋 · 값이 글자 그대로면 거부(PR #22 라운드 3 · 가짜 값)
printf '//registry.npmjs.org/:_authToken="${NPM_TOKEN}"\n//npm.example.com/:_authToken=\n' > "$WT/.npmrc"
OUT="$(commit .npmrc)"; CODE=$?
{
expect ".npmrc — \${NPM_TOKEN} 참조(따옴표 포함) · 빈 값은 커밋" '[ $CODE = 0 ] && git -C "$WT" cat-file -e HEAD:.npmrc' "$OUT"
printf '//registry.npmjs.org/:_authToken=fake-not-a-real-token\n' >> "$WT/.npmrc"
OUT="$(commit .npmrc)"; CODE=$?
expect ".npmrc — 값이 글자 그대로 적혀 있으면 거부(값은 출력 안 함)" '[ $CODE != 0 ] && echo "$OUT" | grep -q "토큰 값이 글자 그대로" && ! echo "$OUT" | grep -q "fake-not-a-real-token"' "$OUT"
} > "$GRP"; grp_end ".npmrc — 참조 · 빈 값은 커밋 · 글자 그대로 값은 거부"
G -C "$WT" checkout -q -- .npmrc

# 완료(done)된 계획서에 이어 올린 PR(2026-10-26 · PR #28 재현) — #27 이 머지돼 계획서가 done 이 된 뒤 같은 계획서에서 새 PR 을 올리면
# ship.sh 가 Status 를 ready_for_review 로 되돌리고 대기열에 넣는다 · 열린 PR 에 push 도 같다 · blocked 는 그대로(대상 아님)
echo; echo "완료된 계획서에 이어 올린 PR(PR #28 재현)"
FBIN="$TMP/followup-bin"; mkdir -p "$FBIN"
cat > "$FBIN/gh" <<'SH'
#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "pr list") if [ -n "${FAKE_PR_NUMBER:-}" ]; then echo "$FAKE_PR_NUMBER"; else [ -z "${FAKE_OPEN_URL:-}" ] || echo "$FAKE_OPEN_URL"; fi ;;
  "pr create") echo "https://github.com/acme/web/pull/8" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$FBIN/gh"
printf '{ "github": { "org": "acme" }, "repos": [{ "name": "web", "agents": ["web-fe"], "autoMerge": true, "prBase": "dev" }] }\n' > "$CORE/athena.config.json"
G -C "$TMP/web" fetch -q origin 2>/dev/null
G -C "$TMP/web" worktree add -q -b feat/y "$TMP/wt-y" origin/dev 2>/dev/null
WTY="$(cd "$TMP/wt-y" && pwd -P)"
FPLAN="plans/task/20261026-web-fe-followup.md"
FQUEUE="$TMP/queue-followup"; mkdir -p "$FQUEUE/.watcher.lock"; echo $$ > "$FQUEUE/.watcher.lock/pid"
followup_plan() {   # <Status 줄 값> <커밋 sha> [추가 PR 줄]
  printf '# 시험 이어 올림\n\n## Checkpoint\n- Status: %s\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/y · pane p3 (web-fe)\n- Auto review: web#7 @1234567 · 머지됨 — squash → dev · '"라운드 1/${FAST_REVIEWS}"' · 2026-10-26 10:00\n- PR: https://github.com/acme/web/pull/7 (feat/x → dev, draft · 2026-10-26 09:00)\n%s\n## Commits\n- `%s` feat/y · 이어서 · push 안 함\n' "$1" "$WTY" "${3:-}" "${2:0:7}" > "$CORE/$FPLAN"
}
fship() { (cd "$CORE" && env PATH="$FBIN:$PATH" FAKE_LOG="$FLOG" ATHENA_PR_AUTO_QUEUE="$FQUEUE" ATHENA_DATA_DIR="$TMP/data" "$@" bash scripts/ship.sh --plan "$FPLAN" --dir "$WTY" --base dev --title 'feat(web): 이어서' --body-file "$TMP/body.md" --no-review-ok --yes 2>&1); }
echo y1 > "$WTY/y.txt" && G -C "$WTY" add y.txt && G -C "$WTY" commit -q -m y1
FS1="$(git -C "$WTY" rev-parse HEAD)"
followup_plan 'done — 자동 — PR #7 이 dev 에 머지됨(2026-10-26 10:30)' "$FS1"; : > "$FLOG"
OUT="$(fship)"; CODE=$?
{
expect "done 계획서에 새 PR(#8) → Status ready_for_review 로 되돌림 · 그 PR · HEAD 가 대기열에" '[ $CODE = 0 ] && grep -q "gh pr create" "$FLOG" && grep -q "^- Status: ready_for_review" "$CORE/$FPLAN" && grep -l "web#8" "$FQUEUE"/*.json 2>/dev/null | xargs grep -lq "$FS1"' "$OUT
$(grep '^- Status' "$CORE/$FPLAN"; ls "$FQUEUE")"
rm -f "$FQUEUE"/*.json
echo y2 >> "$WTY/y.txt" && G -C "$WTY" add y.txt && G -C "$WTY" commit -q -m y2
FS2="$(git -C "$WTY" rev-parse HEAD)"
followup_plan 'done' "$FS2" '- PR: https://github.com/acme/web/pull/8 (feat/y → dev, draft · 2026-10-26 11:00)'; : > "$FLOG"
OUT="$(fship FAKE_OPEN_URL=https://github.com/acme/web/pull/8)"; CODE=$?
expect "done 계획서의 열린 PR 에 push → 새 PR 없이 push 만 · ready_for_review · 새 HEAD 가 대기열에" '[ $CODE = 0 ] && ! grep -q "gh pr create" "$FLOG" && [ "$(git -C "$TMP/origin.git" rev-parse feat/y)" = "$FS2" ] && grep -q "^- Status: ready_for_review" "$CORE/$FPLAN" && grep -l "web#8" "$FQUEUE"/*.json 2>/dev/null | xargs grep -lq "$FS2"' "$OUT
$(grep '^- Status' "$CORE/$FPLAN"; ls "$FQUEUE")"
rm -f "$FQUEUE"/*.json
echo y3 >> "$WTY/y.txt" && G -C "$WTY" add y.txt && G -C "$WTY" commit -q -m y3
FS3="$(git -C "$WTY" rev-parse HEAD)"
followup_plan 'blocked — 사용자 답 기다림' "$FS3" '- PR: https://github.com/acme/web/pull/8 (feat/y → dev, draft · 2026-10-26 11:00)'; : > "$FLOG"
OUT="$(fship FAKE_OPEN_URL=https://github.com/acme/web/pull/8)"; CODE=$?
expect "blocked 계획서는 push 만 · Status 그대로 · 대기열에 안 넣음" '[ $CODE = 0 ] && grep -q "^- Status: blocked — 사용자 답 기다림" "$CORE/$FPLAN" && ! ls "$FQUEUE"/*.json >/dev/null 2>&1' "$OUT
$(grep '^- Status' "$CORE/$FPLAN"; ls "$FQUEUE")"
} > "$GRP"; grp_end "done 계획서에 이어 올림 — 새 PR · 열린 PR push · blocked 는 그대로"

# PR 끔 레포의 일반 PR 차단 — push 전에 막고(오류에 현재 방식 · --direct-merge 명령, 별도 옵션 이름은 없음), 설정은 실행마다 다시 읽는다
echo; echo "PR 끔 레포의 일반 PR 차단 (--user-pr)"
echo g1 > "$WTY/g.txt" && G -C "$WTY" add g.txt && G -C "$WTY" commit -q -m g1
GS1="$(git -C "$WTY" rev-parse HEAD)"
guard_config() {   # <레포 설정에 더할 조각>
  printf '{ "github": { "org": "acme" }, "repos": [{ "name": "web", "agents": ["web-fe"], "prBase": "dev"%s }] }\n' "$1" > "$CORE/athena.config.json"
}
guard_ship() {   # [ship.sh 추가 인자…] — 미리보기가 아니라 --yes 까지 준 일반 PR 명령
  (cd "$CORE" && env PATH="$FBIN:$PATH" FAKE_LOG="$FLOG" ATHENA_PR_AUTO_QUEUE="$FQUEUE" ATHENA_DATA_DIR="$TMP/data" bash scripts/ship.sh --plan "$FPLAN" --dir "$WTY" --base dev --title 'feat(web): 가드' --body-file "$TMP/body.md" --no-review-ok --yes "$@" 2>&1)
}
guard_ship_preview() { (cd "$CORE" && env PATH="$FBIN:$PATH" FAKE_LOG="$FLOG" ATHENA_PR_AUTO_QUEUE="$FQUEUE" ATHENA_DATA_DIR="$TMP/data" bash scripts/ship.sh --plan "$FPLAN" --dir "$WTY" "$@" 2>&1); }
followup_plan 'in_progress' "$GS1"
guard_config ', "autoMerge": true, "autoPr": false'; : > "$FLOG"
OUT="$(guard_ship)"; CODE=$?
{
expect "PR 끔 + 일반 PR(--yes) → push 전에 실패 · 현재 방식과 --direct-merge 명령 · 별도 옵션 이름은 적지 않음" '[ $CODE != 0 ] && echo "$OUT" | grep -q "PR 을 끈 레포" && echo "$OUT" | grep -q -- "--direct-merge" && ! echo "$OUT" | grep -q -- "--user-pr" && ! grep -q "gh pr create" "$FLOG" && [ "$(git -C "$TMP/origin.git" rev-parse --verify -q refs/heads/feat/y)" != "$GS1" ]' "$OUT"
OUT="$(guard_ship_preview)"; CODE=$?
expect "PR 끔 + 미리보기도 막힌다(자동 변환 없음 — 머지하지 않음)" '[ $CODE != 0 ] && echo "$OUT" | grep -q "PR 을 끈 레포" && ! grep -q "gh pr create" "$FLOG" && ! grep -q "^- Auto merge:" "$CORE/$FPLAN"' "$OUT"
OUT="$(guard_ship --user-pr)"; CODE=$?
expect "PR 끔 + 별도 옵션(--user-pr) → 일반 PR 이 만들어진다" '[ $CODE = 0 ] && grep -q "gh pr create" "$FLOG"' "$OUT"
echo g2 > "$WTY/g.txt" && G -C "$WTY" add g.txt && G -C "$WTY" commit -q -m g2
followup_plan 'in_progress' "$(git -C "$WTY" rev-parse HEAD)"
guard_config ', "autoMerge": true'; : > "$FLOG"
OUT="$(guard_ship)"; CODE=$?
expect "설정을 PR 켬으로 바꾼 뒤 같은 명령 → 통과(실행마다 설정을 다시 읽는다)" '[ $CODE = 0 ] && grep -q "gh pr create" "$FLOG"' "$OUT"
echo g3 > "$WTY/g.txt" && G -C "$WTY" add g.txt && G -C "$WTY" commit -q -m g3
followup_plan 'in_progress' "$(git -C "$WTY" rev-parse HEAD)"
guard_config ', "autoMerge": true, "autoPr": false'; : > "$FLOG"
OUT="$(guard_ship)"; CODE=$?
expect "다시 PR 끔으로 바꾸면 같은 명령이 막힌다" '[ $CODE != 0 ] && ! grep -q "gh pr create" "$FLOG"' "$OUT"
guard_config ', "autoPr": false'; : > "$FLOG"
OUT="$(guard_ship)"; CODE=$?
expect "autoMerge 키 없이 autoPr:false 만 → PR 끔이 아니다(막지 않음)" '[ $CODE = 0 ] && grep -q "gh pr create" "$FLOG"' "$OUT"
guard_config ', "autoMerge": true, "autoPr": false'; : > "$FLOG"
OUT="$(guard_ship --auto-push)"; CODE=$?
expect "PR 끔 + --auto-push 도 같은 가드(PR 이 없는 레포라 올릴 곳이 없다)" '[ $CODE != 0 ] && echo "$OUT" | grep -q "PR 을 끈 레포"' "$OUT"
OUT="$(guard_ship --repo-agent web-fe)"; CODE=$?
expect "PR 끔 + --repo-agent(여러 레포 경로)도 일반 PR 이면 막힌다" '[ $CODE != 0 ] && ! grep -q "gh pr create" "$FLOG"' "$OUT"
} > "$GRP"; grp_end "PR 끔 가드 — 일반 PR · 미리보기 막힘 · --user-pr · 설정 다시 읽기 · autoPr 만 · --auto-push · --repo-agent"

# --auto-push 중 red-check 를 기다리는 사이 설정이 PR 끔으로 바뀌면 실제 push 직전에 다시 막는다(2026-11-01 Codex 리뷰)
echo g4 > "$WTY/g.txt" && G -C "$WTY" add g.txt && G -C "$WTY" commit -q -m g4
GS4="$(git -C "$WTY" rev-parse HEAD)"
followup_plan 'in_progress' "$GS4"
sed -i.bak 's/머지됨 — squash → dev/수정 필요/' "$CORE/$FPLAN" && rm -f "$CORE/$FPLAN.bak"
guard_config ', "autoMerge": true, "redCheck": { "tests": ["**/*.test.js"] }'; : > "$FLOG"
cp "$CORE/scripts/verify/red-check.sh" "$TMP/red-check.sh.orig"
cat > "$CORE/scripts/verify/red-check.sh" <<SH
#!/bin/sh
printf '{ "github": { "org": "acme" }, "repos": [{ "name": "web", "agents": ["web-fe"], "prBase": "dev", "autoMerge": true, "autoPr": false, "redCheck": { "tests": ["**/*.test.js"] } }] }\n' > "$CORE/athena.config.json"
echo '{"result":"pass","text":"✅ pass — 시험용"}'
SH
OUT="$(FAKE_PR_NUMBER=7 guard_ship --auto-push)"; CODE=$?
expect "--auto-push 중 red-check 도중 PR 끔으로 바뀌면 push 직전에 막힌다" '[ $CODE != 0 ] && echo "$OUT" | grep -q "PR 을 끈 레포" && [ "$(git -C "$TMP/origin.git" rev-parse --verify -q refs/heads/feat/y)" != "$GS4" ]' "$OUT"
cp "$TMP/red-check.sh.orig" "$CORE/scripts/verify/red-check.sh"


[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
