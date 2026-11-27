# PR 자동 리뷰 시험 공통 준비 — 주제별 시험 여덟 개(unit · diff · reviewers · ship · merge · rounds · direct · delegate — pr-auto-output-test.sh 는 따로)가 맨 위에서 source 한다(이 파일은 이름이 _ 로 시작해 시험으로 따로 돌지 않는다)
#   머리(_lib.sh · SRC · TMP · FAIL) · expect · G · 가짜 리뷰어(claude · codex → $BIN) · 가짜 화면 · 머지 확인용 임시 코어(confirm_core) ·
#   기대값 라벨(scripts/lib/pr-auto.mjs 상수에서 읽는다 — 리뷰 횟수 · 마지막 차수가 바뀌어도 시험 글을 고치지 않게)
#   보는 코드: scripts/pr-auto.mjs · scripts/lib/pr-auto.mjs (이 경로 글을 보고 검증 범위가 pr-auto 를 고친 수정에 이 시험들을 고른다)
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-$(basename "$0" .sh).XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0

G() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
expect() {   # <이름> <조건(eval)> [자세히]
  if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -n "${3:-}" ] && echo "$3" | sed 's/^/      /'; FAIL=1; fi
}
# 같은 사례의 여러 실행을 ✔ 하나로 — { …expect · run_case · merge_case… } > "$GRP"; grp_end <이름>
#   안에 ✖ 가 없으면 ✔ 하나 · 있으면 ✖ <이름> 아래 잡힌 출력 전체(어느 소검사인지 · 자세히 — │ 를 붙여 통과 줄 세기에 안 들어가게). 중괄호는 subshell 이 아니라 변수 · FAIL 이 그대로 남는다
GRP="$TMP/group.out"
grp_end() {   # <이름>
  if grep -q '✖' "$GRP"; then echo "  ✖ $1"; sed 's/^/    │/' "$GRP"; FAIL=1; else echo "  ✔ $1"; fi
  : > "$GRP"
}

# 기대값 라벨 — lib 상수 그대로(⚡ 빠른 길 · 리뷰 최대 횟수 · 마지막 차수 · 옛 2차)
{ read -r FAST_PATH; read -r FAST_REVIEWS; read -r FAST_MAX_ROUNDS; read -r FAST_LAST; read -r LEGACY_FAST_SECOND; } < <(node --input-type=module -e "
  const lib = await import('./scripts/lib/pr-auto.mjs')
  console.log([lib.FAST_PATH, lib.FAST_REVIEWS, lib.FAST_MAX_ROUNDS, lib.FAST_LAST, lib.LEGACY_FAST_SECOND].join('\n'))")
[ -n "${LEGACY_FAST_SECOND:-}" ] || { echo "  ✖ scripts/lib/pr-auto.mjs 상수를 읽지 못함"; exit 1; }
FAST_LINEUP="$FAST_PATH — 최대 ${FAST_REVIEWS}번"   # 계획서 줄 · 사건의 리뷰어 구성 앞머리

# ── 가짜 리뷰어로 실행 ───────────────────────────────────────────────────
BIN="$TMP/bin"; mkdir -p "$BIN"
# claude -p --output-format json --json-schema … — structured_output 에 답(learn-review 가 쓰는 꼴)
cat > "$BIN/claude" <<'SH'
#!/bin/sh
if [ "$1 $2" = "auth status" ]; then [ "${FAKE_CLAUDE_LOGIN:-in}" = in ]; exit $?; fi
if [ -n "${FAKE_PROMPT:-}" ]; then cat > "$FAKE_PROMPT"; else cat > /dev/null; fi
[ -n "${FAKE_CLAUDE_ARGS:-}" ] && echo "$*" > "$FAKE_CLAUDE_ARGS"
case "${FAKE_CLAUDE:-approve}" in
  approve) echo '{"is_error":false,"structured_output":{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}}' ;;
  bad) echo '{"is_error":false,"structured_output":{"verdict":"maybe"}}' ;;
  # 사용량 한도 — 2026-11-03 PR 235~240 실행 기록의 모양(api_error usage_limit_reached · 글 · 종료 1 — /tmp/athena-pr-auto-26676d3c.log "claude: failed(종료 1: {…")
  limit) echo '{"type":"result","subtype":"success","is_error":true,"api_error":"usage_limit_reached","duration_api_ms":0,"stop_reason":"stop_sequence","result":"You'"'"'ve hit your weekly limit · resets 4am (Asia/Seoul)"}'; exit 1 ;;
  changes) echo '{"is_error":false,"structured_output":{"verdict":"changes","summary":"고칠 것","findings":[{"file":"b.js","line":2,"problem":"p","fix":"f","severity":"blocking"}],"decisions":[]}}' ;;
esac
SH
# codex exec … -o <파일> — 마지막 답을 그 파일에
cat > "$BIN/codex" <<'SH'
#!/bin/sh
# 돌리기 전 로그인 확인(codex login status — 종료 코드만 본다) · FAKE_CODEX_LOGIN=out 이면 로그인 안 됨
if [ "$1 $2" = "login status" ]; then [ "${FAKE_CODEX_LOGIN:-in}" = in ]; exit $?; fi
# 리뷰어가 codex 하나여도 프롬프트를 볼 수 있게(가짜 claude 와 같은 FAKE_PROMPT)
if [ -n "${FAKE_PROMPT:-}" ]; then cat > "$FAKE_PROMPT"; else cat > /dev/null; fi
[ -n "${FAKE_CODEX_ARGS:-}" ] && echo "$*" > "$FAKE_CODEX_ARGS"
# 도구 없이 돌리는 옵션(사용자 설정 · 셸 · 웹 끄기)이 빠지면 실패한다 — docs/pr-auto.md "리뷰어"
case " $* " in *" --ignore-user-config "*) ;; *) echo "도구 끄기 옵션 없음" >&2; exit 9 ;; esac
case " $* " in *" --disable shell_tool "*) ;; *) echo "셸 끄기 없음" >&2; exit 9 ;; esac
case " $* " in *'web_search="disabled"'*) ;; *) echo "웹 끄기 없음" >&2; exit 9 ;; esac
[ "${FAKE_CODEX:-approve}" = slow ] && sleep 30
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
[ -n "${FAKE_CODEX_CALLED:-}" ] && echo called > "$FAKE_CODEX_CALLED"
decision_of() { echo '{"verdict":"decision","summary":"정할 것","findings":[],"decisions":[{"title":"아이콘 자리","why":"w","options":[{"label":"A 왼쪽","desc":""},{"label":"B 오른쪽","desc":""}],"recommended":"A 왼쪽","kind":"'"$1"'"}]}'; }
if [ "${FAKE_CODEX:-}" = ok ]; then echo '{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}' > "$out"
elif [ "${FAKE_CODEX:-}" = impl ]; then decision_of implementation > "$out"
elif [ "${FAKE_CODEX:-}" = product ]; then decision_of product > "$out"
elif [ "${FAKE_CODEX:-}" = product-changes ]; then decision_of product | sed 's/"findings":\[\]/"findings":[{"file":"b.js","line":2,"problem":"p","fix":"f","severity":"blocking"}]/' > "$out"
elif [ "${FAKE_CODEX:-}" = advisory ]; then echo '{"verdict":"changes","summary":"권장","findings":[{"file":"c.js","line":5,"problem":"이름이 길다","fix":"줄인다","severity":"advisory"}],"decisions":[]}' > "$out"
else echo '{"verdict":"changes","summary":"고칠 것","findings":[{"file":"a.js","line":1,"problem":"p","fix":"f","severity":"blocking"}],"decisions":[]}' > "$out"; fi
SH
chmod +x "$BIN/claude" "$BIN/codex"
# 사용자 진짜 ~/.codex/config.toml 이 구성 메모 · 인자에 섞이지 않게 기본은 빈 CODEX_HOME
export CODEX_HOME="$TMP/codex-default"; mkdir -p "$CODEX_HOME"
run_case() {   # <이름> <PATH> <기대 판정> [환경…] · RC_CORE=<코어 사본> 이면 그 사본의 pr-auto.mjs 로(주 도구 기록을 소스 폴더에 만들지 않는다)
  #   RC_ALSO=<조건(eval)> 이면 판정과 함께 그 조건도 봐서 하나로 센다(부른 인자 · 안 부른 도구 같은 같은 실행의 확인)
  local name="$1" path="$2" want="$3"; shift 3
  local got core="${RC_CORE:-$PWD}"
  got="$(env PATH="$path" ATHENA_PR_AUTO_TIMEOUT_MS=1500 "$@" "$(command -v node)" --input-type=module -e "
    const { runReviewers } = await import('$core/scripts/pr-auto.mjs')
    const { aggregate, reviewerBrief } = await import('$core/scripts/lib/pr-auto.mjs')
    const results = await runReviewers('리뷰해 줘', JSON.parse(process.env.FAKE_CONFIG || '{}'))
    console.log(aggregate(results).verdict + ' ' + reviewerBrief(results))" 2>&1 | tail -1)"
  if [ "${got%% *}" != "$want" ]; then echo "  ✖ $name — 기대 $want · 실제 $got"; FAIL=1
  elif [ -n "${RC_ALSO:-}" ] && ! eval "$RC_ALSO"; then echo "  ✖ $name — 판정은 $got · 덧붙인 조건 실패: $RC_ALSO"; FAIL=1
  else echo "  ✔ $name — $got"; fi
}

# 가짜 화면 — FAKE_PANES(JSON 조각)를 pane 목록으로 · 부른 것은 FAKE_SCREEN_LOG 에(없으면 버림)
write_fake_screen() {   # <만들 파일>
cat > "$1" <<'SH'
#!/bin/sh
[ -n "$FAKE_SCREEN_LOG" ] && echo "screen $*" >> "$FAKE_SCREEN_LOG"
if [ "$1 $2" = "pane list" ]; then echo "{\"panes\":[${FAKE_PANES:-}]}"
elif [ "$1 $2" = "pane read" ]; then printf '%s\n' "${FAKE_PANE_TEXT:-}"   # 화면 글 — 질문 창 흉내
elif [ "$1" = self ] && [ -n "${FAKE_SELF_PANE:-}" ]; then echo "{\"inside\":true,\"pane_id\":\"$FAKE_SELF_PANE\"}"   # pane 안 흉내(없으면 화면 밖)
elif [ "$1" = self ]; then echo '{"inside":false,"pane_id":""}'   # 화면 밖 — 진짜 screen.py self 와 같은 모양(빈 답은 "못 읽음"이라 옛 --here 로 간다)
# 공통 전송 경로 실패 흉내 — refuse: 데몬이 쓰기 전에 거절 · lost: 전송을 확인 못 함(scripts/screen 이 stderr 에 적는 모양)
elif [ "$1 $2" = "pane send-text" ] && [ "${FAKE_SEND_FAIL:-}" = refuse ]; then echo '{"error": "unavailable", "message": "studio pane run: 입력을 기다리는 질문이 열려 있다"}' >&2; exit 1
elif [ "$1 $2" = "pane send-text" ] && [ "${FAKE_SEND_FAIL:-}" = lost ]; then echo '{"error": "timeout", "message": "studio pane run: 입력 전송을 확인하지 못했다 — pane 입력칸을 확인해 주세요"}' >&2; exit 1
else echo '{}'; fi
SH
chmod +x "$1"
}

# 머지 확인용 임시 코어(core-confirm) — 가짜 gh · 가짜 검증 · 워크트리 여럿 · merge_case · confirm_run 등(merge · rounds 시험이 부른다)
confirm_core() {
# 실제 경로로 — 맥 임시 폴더(/var → /private/var · TMPDIR 끝의 //)면 pr-auto.mjs 의 "직접 실행" 판정이 어긋나 아무것도 안 한다
CORE="$(cd "$TMP" && pwd -P)/core-confirm"; mkdir -p "$CORE/plans/task"
cp -R "$SRC/scripts" "$CORE/scripts"
write_fake_screen "$CORE/scripts/screen"
# FAKE_VERIFY_KILL — 검증 도중 부른 쪽(node)을 죽인다(머지 직전 확인 중에 처리기가 꺼진 경우)
# FAKE_VERIFY_LOG — 검증 시작 · 끝을 적는다(리뷰 ‖ 검증 순서 · 멈춤 확인) · FAKE_VERIFY_SLEEP — 검증이 그만큼 걸리는 것처럼
printf '#!/bin/sh\n[ -n "$FAKE_VERIFY_KILL" ] && kill -9 $PPID && sleep 1\n[ -n "$FAKE_VERIFY_LOG" ] && echo verify-start >> "$FAKE_VERIFY_LOG"\n[ -n "$FAKE_VERIFY_SLEEP" ] && sleep "$FAKE_VERIFY_SLEEP"\n[ -n "$FAKE_VERIFY_LOG" ] && echo verify-end >> "$FAKE_VERIFY_LOG"\n[ -z "$FAKE_VERIFY_FAIL" ] && exit 0\ncat "$(dirname "$0")/fake-fail.txt"\nexit 1\n' > "$CORE/scripts/verify/reuse.sh"; chmod +x "$CORE/scripts/verify/reuse.sh"
# 가짜 검증이 실패할 때 찍는 출력 — scripts/verify/_lib.sh print_summary 모양(실패 단계 표 줄 · 로그 블록)
cat > "$CORE/scripts/verify/fake-fail.txt" <<'FAKEOUT'
## 검증 결과 — web (feat/x @ abc1234, 2026-11-27 10:00)

| 단계 | 결과 | 소요 |
|---|---|---|
| `npm run check` | ✅ 통과 | 2s |
| `npm test` | ❌ 실패 (exit 1) | 3s |

### ❌ npm test 로그 (마지막 40줄)
```
ok 1 - 더하기
not ok 2 - 합계
AssertionError: 3 !== 4
```

전체 로그: /tmp/x
FAKEOUT
# 워크트리 — origin(bare) 의 main 위에 커밋 하나(부모 하나 · squash). 머지 방식은 워크트리에서 origin/main..HEAD 의 부모 수로 정한다
G init -q --bare "$TMP/origin-confirm.git"
G clone -q "$TMP/origin-confirm.git" "$TMP/wt-confirm" 2>/dev/null
WT="$(cd "$TMP/wt-confirm" && pwd -P)"
G -C "$WT" commit -q --allow-empty -m init && G -C "$WT" push -q origin HEAD:main 2>/dev/null
G -C "$WT" checkout -q -b feat/x && G -C "$WT" commit -q --allow-empty -m x
SHA="$(git -C "$WT" rev-parse HEAD)"
# merge 커밋이 든 PR — 갈래 하나를 merge 커밋으로 합친 뒤 일반 커밋 하나(merge 커밋이 맨 끝이 아니어도 잡는지)
G clone -q "$TMP/origin-confirm.git" "$TMP/wt-merge" 2>/dev/null
WT_MERGE="$(cd "$TMP/wt-merge" && pwd -P)"
G -C "$WT_MERGE" checkout -q -b side && G -C "$WT_MERGE" commit -q --allow-empty -m side
G -C "$WT_MERGE" checkout -q -b feat/m main && G -C "$WT_MERGE" commit -q --allow-empty -m a
G -C "$WT_MERGE" merge -q --no-ff -m merge side && G -C "$WT_MERGE" commit -q --allow-empty -m b
SHA_MERGE="$(git -C "$WT_MERGE" rev-parse HEAD)"
# 위험한 수정 PR 워크트리 — 보안 판정은 워크트리의 origin/main...HEAD 를 먼저 읽는다(gh pr diff 는 못 읽을 때만)
G clone -q "$TMP/origin-confirm.git" "$TMP/wt-risky" 2>/dev/null
WT_RISKY="$(cd "$TMP/wt-risky" && pwd -P)"
G -C "$WT_RISKY" checkout -q -b feat/x && printf 'export const run = (args) => spawnSync("git", args)\n' > "$WT_RISKY/run.mjs"
G -C "$WT_RISKY" add run.mjs && G -C "$WT_RISKY" commit -q -m risky
SHA_RISKY="$(git -C "$WT_RISKY" rev-parse HEAD)"
# base 를 못 받는 워크트리 — origin 이 없는 자리(HEAD 는 그대로라 검증 · 워크트리 확인은 통과)
G clone -q "$TMP/origin-confirm.git" "$TMP/wt-nofetch" 2>/dev/null
WT_NOFETCH="$(cd "$TMP/wt-nofetch" && pwd -P)"
G -C "$WT_NOFETCH" fetch -q "$WT" feat/x && G -C "$WT_NOFETCH" checkout -q -b feat/x FETCH_HEAD
G -C "$WT_NOFETCH" remote set-url origin "$TMP/없는-origin.git"
GH_LOG="$TMP/gh.log"
cat > "$BIN/gh" <<'SH'
#!/bin/sh
echo "$*" >> "$GH_LOG"
head="$FAKE_SHA"
if [ "$1 $2" = "pr view" ]; then
  echo x >> "$GH_LOG.views"
  # FAKE_GH_HEAD_AFTER — 두 번째 pr view(머지 직전 다시 확인)부터 다른 HEAD 를 답한다(그새 새 커밋)
  [ -n "$FAKE_GH_HEAD_AFTER" ] && [ "$(wc -l < "$GH_LOG.views")" -ge 2 ] && head="ffffffffffffffffffffffffffffffffffffffff"
fi
case "$1 $2" in
  # FAKE_PR_STATE — PR 상태(기본 OPEN) · FAKE_MERGE_LANDED — pr merge 는 실패로 끝나지만 PR 은 머지됐다(앞서 남겨 둔 gh 가 먼저 머지함)
  "pr view") state="${FAKE_PR_STATE:-OPEN}"; [ -f "$GH_LOG.landed" ] && state=MERGED; printf '{"state":"%s","isDraft":true,"headRefOid":"%s","headRefName":"feat/x","baseRefName":"main","mergeable":"MERGEABLE","title":"t","body":""}\n' "$state" "$head" ;;
  "pr diff") if [ -n "${FAKE_PR_DIFF:-}" ]; then cat "$FAKE_PR_DIFF"; else echo "diff --git a/a.js b/a.js"; fi ;;
  "pr merge") [ -n "$FAKE_MERGE_LANDED" ] && : > "$GH_LOG.landed" && exit 1 ;;
esac
exit 0
SH
chmod +x "$BIN/gh"
merge_case() {   # <이름> <autoMergeConfirm JSON 조각> <머지 기대 yes|no> <계획서 줄 기대(정규식)> [환경…]
  local name="$1" extra="$2" want="$3" line="$4"; shift 4
  rm -rf "$CORE/.requests" "$CORE/.events.jsonl" "$TMP/queue-confirm" "$GH_LOG.views" "$CORE/plans/task/"*; : > "$GH_LOG"
  # WATCHER_HELD=1 — 처리기가 이미 도는 것처럼(미룬 알림이 진짜 처리기를 띄우지 않게)
  [ "${WATCHER_HELD:-0}" = 1 ] && mkdir -p "$TMP/queue-confirm/.watcher.lock" && echo $$ > "$TMP/queue-confirm/.watcher.lock/pid"
  printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true%s } ] }\n' "$extra" > "$CORE/athena.config.json"
  printf '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p3 (web-fe)\n%s- PR: https://github.com/acme/web/pull/7\n%s' "$WT" "${AUTO_LINE:+$AUTO_LINE
}" "${EXTRA_PLAN:-}" > "$CORE/plans/task/x.md"
  # BLOCK_REQUESTS=1 — 요청 폴더 자리에 파일을 둬 요청을 하나도 못 열게(결정 콘솔 · 대체 요청 둘 다 실패)
  [ "${BLOCK_REQUESTS:-0}" = 1 ] && : > "$CORE/.requests"
  # PENDING=1 — 결정 콘솔에 안 정한 결정이 있는 것처럼(plan-html.mjs 가 여는 계획서 결정 요청)
  [ "${PENDING:-0}" = 1 ] && (cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
    const { openRequest } = await import('./scripts/lib/requests.mjs')
    openRequest('.', { kind: 'decision', title: 'x', body: '- R1', links: { plan: 'plans/task/x.md' }, pane: null, dedupeKey: 'plan:plans/task/x.md' })" >/dev/null)
  env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" "$@" \
    "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 ${PR_AUTO_FLAG:-} > "$TMP/merge.out" 2>&1
  local merged=no; grep -q "^pr merge 7 --repo acme/web --${WANT_METHOD:-squash} --match-head-commit $SHA" "$GH_LOG" && merged=yes
  local got; got="$(grep -o '^- Auto review: .*' "$CORE/plans/task/x.md")"
  if [ "$merged" = "$want" ] && printf '%s' "$got" | grep -Eq "$line"; then echo "  ✔ $name — ${got#- Auto review: }"
  else echo "  ✖ $name — 머지 기대 $want · 실제 $merged · 줄: $got"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; fi
}
confirm_run() {   # [환경…] — 처리기의 머지 확인 보기 한 번
  env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$@" "$(command -v node)" --input-type=module -e "
    const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
}
confirm_answer() {   # <고른 것> — 머지 확인 요청 하나에 답한다
  (cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
    const { listRequests, answerRequest } = await import('./scripts/lib/requests.mjs')
    for (const request of listRequests('.').requests) answerRequest('.', request.id, { choice: process.argv[1], by: 'board' })" "$1" >/dev/null)
}
confirm_killed() {   # 머지 확인 대기 → [머지] 답 → 검증 도중 처리기 죽음
  merge_case "이어받기 준비 — 확인 대기" '' no '머지 확인 대기' >/dev/null
  confirm_answer 머지
  : > "$GH_LOG"; rm -f "$GH_LOG.views"
  ( confirm_run FAKE_VERIFY_KILL=1; true ) 2>/dev/null
}
auto_line() { grep -o '^- Auto review: .*' "$CORE/plans/task/x.md"; }
}
