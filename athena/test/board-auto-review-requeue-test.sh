#!/usr/bin/env bash
# 현황판 PR 자동 리뷰 안전망(scripts/board/server.mjs autoReviewPlans) — 같은 HEAD 를 한 번 넣고 처리가 끝난 뒤 사람이 계획서 "- Auto review:" 줄을 지우면
# (다시 돌리기 · docs/pr-auto.md) 현황판이 그 HEAD 를 다시 대기열에 넣는지. 2026-11-27 syung#183 재현 — 현황판 메모리가 넣었던 HEAD 를
# 계속 기억해 줄을 지워도 2시간 넣지 않았다(아테나가 손으로 --enqueue). 임시 코어 사본 · 가짜 gh · 가짜 화면 CLI · 가짜 처리기 잠금 · 몇 초
#
# 사용: test/board-auto-review-requeue-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/athena-board-requeue-test.XXXXXX")" && pwd -P)"
SERVER_PID=''
cleanup() {
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  [ "${KEEP:-0}" = 1 ] || rm -rf "$TMP"
}
trap cleanup EXIT
athena_test_reap "$TMP"   # 전에 SIGKILL 로 끊긴 이 시험의 고아 서버
mkdir -p "$TMP/bin" "$TMP/home"

HEAD_SHA=79b114876187aac2ca959d76fa1e1f38e2b2c6e6
# 가짜 gh — PR 7 은 열림 · HEAD 고정, 그 밖에는 빈 목록
cat > "$TMP/bin/gh" <<SH
#!/bin/sh
case "\$*" in
  'pr view 7 '*) echo '{"state":"OPEN","baseRefName":"main","mergedAt":"","headRefOid":"$HEAD_SHA"}' ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$TMP/bin/gh"
for name in claude codex; do printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/$name"; chmod +x "$TMP/bin/$name"; done
cp "$SRC/scripts/screen-check/fake-bin/athena-studio-cli" "$TMP/bin/"

CORE="$TMP/core"
mkdir -p "$CORE"
rsync -a --exclude .git --exclude node_modules --exclude /repos --exclude /plans --exclude /issues --exclude /archive --exclude /.worktrees \
  --exclude '/.board-*' --exclude '/.requests' --exclude /athena.config.json --exclude /pack --exclude /packs --exclude /.pack-data --exclude '/.pack-data.*' --exclude /test \
  "$SRC/" "$CORE/"
mkdir -p "$CORE/issues" "$CORE/plans/task" "$CORE/testpack"
printf '{ "pack": "./testpack" }\n' > "$CORE/athena.config.json"
printf '{ "id": "acme", "name": "acme", "github": { "org": "acme" }, "repos": [ { "name": "demo", "branch": "main", "prBase": "main", "kind": "single", "agents": ["demo-fe"], "autoMerge": true } ] }\n' > "$CORE/testpack/pack.json"
PLAN="$CORE/plans/task/20261127-requeue.md"
printf '# 다시 넣기\n\n## Checkpoint\n- Status: in_progress\n- Agent: demo-fe\n- Lead pane: p1\n- PR: https://github.com/acme/demo/pull/7\n\n### Progress\n- [ ] 구현\n' > "$PLAN"

# 처리기는 살아 있는 척만 — 잠금 pid 를 이 시험 셸로 두면 --enqueue 는 파일만 쓰고 처리기를 띄우지 않는다(진짜 리뷰를 돌리지 않게)
QUEUE="$TMP/queue"
mkdir -p "$QUEUE/.watcher.lock"
echo $$ > "$QUEUE/.watcher.lock/pid"

mkdir -p "$TMP/fixture"
cp "$SRC/scripts/screen-check/fixtures/studio/"* "$TMP/fixture/"
SCREEN_LOG="$TMP/screen.log"
: > "$SCREEN_LOG"
PORT=$((47900 + RANDOM % 90))
(cd "$CORE" && PATH="$TMP/bin:$PATH" HOME="$TMP/home" ATHENA_PR_AUTO_QUEUE="$QUEUE" ATHENA_LEARN_QUEUE="$TMP/learn-queue" PYTHONDONTWRITEBYTECODE=1 \
  ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p1 ATHENA_STUDIO_TAB_ID=t1 ATHENA_STUDIO_WORKSPACE_ID=w1 ATHENA_STUDIO_SOCKET=/tmp/athena-studio.sock \
  ATHENA_STUDIO_CLI="$TMP/bin/athena-studio-cli" ATHENA_STUDIO_ENDPOINT="$TMP/no-studio/daemon.json" \
  FAKE_SCREEN_FIXTURE="$TMP/fixture" FAKE_SCREEN_LOG="$SCREEN_LOG" FAKE_ATHENA="$CORE" \
  ATHENA_BOARD_PORT=$PORT exec node scripts/board/server.mjs > "$TMP/server.log" 2>&1) &
SERVER_PID=$!
athena_test_guard "$SERVER_PID"

fail=0
check() { if [ "$2" = 0 ]; then echo "  ✔ $1"; else echo "  ✖ $1"; fail=1; [ -n "${3:-}" ] && echo "      $3"; fi; }
queued() { ls "$QUEUE" 2>/dev/null | grep -c '\.json$'; }
wait_queued() {   # <기다릴 초> — 대기열 파일이 생기면 0
  for _ in $(seq 1 $(($1 * 5))); do [ "$(queued)" -gt 0 ] && return 0; sleep 0.2; done
  return 1
}

echo '── 현황판 PR 자동 리뷰 다시 넣기'
wait_queued 20; check '처음 HEAD → 대기열에 넣는다' $? "$(tail -5 "$TMP/server.log")"

# 처리기가 끝낸 것처럼 — 대기열 파일을 치우고 계획서에 같은 HEAD 의 끝난 줄(멈춤)
rm -f "$QUEUE"/*.json
python3 - "$PLAN" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf8').read()
text = text.replace('- Lead pane: p1\n', '- Lead pane: p1\n- Auto review: demo#7 @79b1148 · 멈춤 — 검증 못 함(워크트리에 커밋 안 된 변경) · 라운드 1/3 · 2026-11-27 23:18\n')
open(path, 'w', encoding='utf8').write(text)
PY
sleep 4   # 한 주기(3초) 넘게
check '끝난 줄이 있는 같은 HEAD → 다시 넣지 않는다' "$(queued)" "대기열: $(ls "$QUEUE")"

# 사람이 "- Auto review:" 줄을 지워 다시 돌리기(docs/pr-auto.md) — 같은 HEAD 를 다시 넣어야 한다
python3 - "$PLAN" <<'PY'
import sys
path = sys.argv[1]
lines = open(path, encoding='utf8').read().split('\n')
open(path, 'w', encoding='utf8').write('\n'.join(line for line in lines if not line.startswith('- Auto review:')))
PY
wait_queued 10; check '줄을 지운 같은 HEAD → 다시 넣는다(syung#183 재현)' $? "$(tail -5 "$TMP/server.log")"

[ "$fail" = 0 ] && echo '✅ 통과' || echo '❌ 실패'
exit "$fail"
