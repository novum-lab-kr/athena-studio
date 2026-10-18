#!/usr/bin/env bash
# 여러 팩 회귀 시험 — 작업 트리를 임시 폴더에 복사한 본체 + 임시 데이터 폴더에서 bin/athena pack 명령을 끝까지 돌린다.
# 진짜 ~/athena · ~/athena-data · 이 체크아웃의 링크·설정은 건드리지 않는다(임시 폴더만 · 끝나면 지운다).
#
# 사용: test/packs-test.sh            → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#       KEEP=1 test/packs-test.sh     → 임시 폴더를 남긴다(경로를 마지막에 보여 준다)
#
# 보는 것(계획서 7절 "단계별 확인"): test-setup · 팩 갈아 끼우기 A→B→A(링크·repos·계획서·이슈가 그 팩 것만) · 일부러 실패시키면 이전 팩으로 ·
# 잠금 · 일하는 claude 가 있으면 거부 · 나쁜 팩(형식·pack.json 없음·밖 링크·.env·../·ext::) · 같은 팩 충돌·교체 백업 ·
# 내보내기 허용 목록 · 작업 기록 백업·되살리기 · 옛 아테나 가져오기(원본 그대로) · 옮기기(두 번 돌려도 같음) · 계획서 논리 경로 · 현황판(팩·세대·409·끄기)
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/packs-test.XXXXXX")" && pwd -P)"
[ "${KEEP:-}" = 1 ] || trap 'pkill -f "$WORK/body/scripts/board/server.mjs" 2>/dev/null; rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✔ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✖ %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2" | head -c 600 && echo; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
section() { printf '\n%s\n' "$1"; }
# 화면·에이전트 환경을 비운다 — 이 시험이 부른 쪽의 pane 이름 등을 바꾸지 않게
unset ATHENA_AGENT HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_SOCKET ATHENA_STUDIO ATHENA_BOARD_PORT ATHENA_PACK_FAIL_AT
export ATHENA_SCREEN=none ATHENA_BOARD_NO_BROWSER=1 ATHENA_DATA_DIR="$WORK/test-data" ATHENA_HEAVY_LOCK="$WORK/heavy.lock"
PORT=47710

# ── 본체 사본 ───────────────────────────────────────────────────────────
mkbody() { # mkbody <폴더> — git clone(코어 이력) + 작업 트리 덮기
  git clone -q "$SRC" "$1" 2>/dev/null || { mkdir -p "$1"; git -C "$1" init -q; }
  rsync -a --delete --exclude .git --exclude .omc --exclude /plans --exclude /issues --exclude /repos --exclude /.worktrees --exclude /pack --exclude /packs \
    --exclude /archive --exclude /.sync --exclude /.pack-data --exclude /athena.config.json --exclude __pycache__ --exclude '/.board-*' --exclude '/.qa-*' \
    --exclude /.jev-log.jsonl --exclude /.migrate-* --exclude node_modules "$SRC/" "$1/"
}
B="$WORK/body"; mkbody "$B"; cd "$B" || exit 1
A() { node scripts/athena.mjs "$@" --json 2>/dev/null | tail -1; }
field() { python3 -c 'import json,sys
d=json.loads(sys.stdin.read() or "{}")
for k in sys.argv[1].split("."): d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else (json.dumps(d) if isinstance(d,(dict,list)) else d))' "$1"; }
printf '{ "boardPort": %s }\n' "$PORT" > athena.config.json

section "test-setup"
R="$(A pack test-setup)"
check "acme 가 지금 팩" '[ "$(echo "$R" | field current.id)" = acme ]' "$R"
check "고정 링크(plans·issues·repos·pack)" '[ -L plans ] && [ -L issues ] && [ -L repos ] && [ -L pack ] && [ -L .pack-data ]'
check "acme 에이전트·검증 링크" '[ -L .claude/agents/acme-web-fe.md ] && [ -L scripts/verify/acme-web.sh ]'
check "acme 레포 링크 둘" '[ "$(ls repos | tr "\n" " ")" = "acme-api acme-web " ]'
check "설정에 dataDir·boardPort(screen 없음)" 'python3 -c "import json,sys; d=json.load(open(\"athena.config.json\")); sys.exit(0 if d.get(\"dataDir\") and d.get(\"boardPort\")=='"$PORT"' and \"screen\" not in d else 1)"'
check "status·list 에 dataDir(실제 데이터 폴더)" '[ "$(A pack status | field dataDir)" = "$ATHENA_DATA_DIR" ] && [ "$(A pack list | field dataDir)" = "$ATHENA_DATA_DIR" ]'
check "~/athena-data 로는 거부" '[ "$(ATHENA_DATA_DIR="$HOME/athena-data" node scripts/athena.mjs pack test-setup --json | tail -1 | field error)" = unsafe ]'

section "팩 갈아 끼우기 A→B→A"
R="$(A pack use globex)"
check "globex 로 바뀜(세대 2)" '[ "$(echo "$R" | field current.id)" = globex ] && [ "$(echo "$R" | field current.generation)" = 2 ]' "$R"
check "acme 링크가 사라지고 globex 링크만" '[ ! -e .claude/agents/acme-web-fe.md ] && [ ! -L .claude/agents/acme-web-fe.md ] && [ -L .claude/agents/globex-shop-fe.md ]'
check "repos 는 globex 것만" '[ "$(ls repos | tr "\n" " ")" = "globex-admin globex-shop " ]'
check "계획서·이슈는 globex 것만" '[ "$(ls plans/task issues | grep -c acme)" = 0 ] && ls plans/task | grep -q globex && ls issues | grep -q globex'
check "docs/services.md 가 globex 것" 'grep -q Globex docs/services.md'
R="$(A pack use acme)"
check "다시 acme(세대 3)" '[ "$(echo "$R" | field current.generation)" = 3 ] && ls issues | grep -q acme'
R="$(A pack use acme)"
check "같은 팩이면 그대로(unchanged)" '[ "$(echo "$R" | field unchanged)" = True ] || [ "$(echo "$R" | field unchanged)" = true ]' "$R"
check "없는 팩 → not-found" '[ "$(A pack use nope | field error)" = not-found ]'

section "실패하면 되돌림 · 잠금 · busy"
for step in link repos verify; do
  R="$(ATHENA_PACK_FAIL_AT=$step node scripts/athena.mjs pack use globex --json 2>/dev/null | tail -1)"
  check "$step 단계 실패 → rollback · acme 그대로" '[ "$(echo "$R" | field error)" = rollback ] && [ "$(basename "$(readlink .pack-data)")" = acme ] && [ -L .claude/agents/acme-web-fe.md ] && ls repos | grep -q acme-web' "$R"
done
mkdir "$ATHENA_DATA_DIR/switch.lock"; sleep 60 & LOCKPID=$!; echo "$LOCKPID" > "$ATHENA_DATA_DIR/switch.lock/pid"
check "잠금 중 → locked" '[ "$(A pack use globex | field error)" = locked ]'
check "잠금 중 status.switching" '[ "$(A pack status | field switching)" = True ]'
check "잠금 중 delegate 거부" '! bash scripts/delegate.sh acme-web-fe --plan "$(ls plans/task/*.md | head -1)" --here >/dev/null 2>&1'
check "잠금 중 new-branch 거부" '! bash scripts/new-branch.sh T-1 acme-web >/dev/null 2>&1'
kill "$LOCKPID" 2>/dev/null; wait "$LOCKPID" 2>/dev/null; rm -rf "$ATHENA_DATA_DIR/switch.lock"
check "주인이 죽은 잠금은 넘겨받음" 'mkdir "$ATHENA_DATA_DIR/switch.lock" && echo 999999 > "$ATHENA_DATA_DIR/switch.lock/pid" && [ "$(A pack use acme | field ok)" = True ]'
FAKE="$WORK/fakebin"; mkdir -p "$FAKE"; ln -s "$(command -v node)" "$FAKE/claude"
(cd "$B" && exec "$FAKE/claude" -e 'setTimeout(() => {}, 60000)') & C1=$!
(cd "$ATHENA_DATA_DIR/repos-src/acme-web" && exec "$FAKE/claude" -e 'setTimeout(() => {}, 60000)') & C2=$!
sleep 0.5
R="$(A pack busy)"
check "busy: athena · agent" 'echo "$R" | grep -q "\"kind\":\"athena\"" && echo "$R" | grep -q "\"kind\":\"agent\""' "$R"
check "busy 여도 지금 팩으로 use 는 unchanged" '[ "$(A pack use acme | field unchanged)" = True ]'
check "busy 면 갈아 끼우지 않음" '[ "$(A pack use globex | field error)" = busy ] && [ "$(basename "$(readlink .pack-data)")" = acme ]'
kill "$C1" "$C2" 2>/dev/null; wait "$C1" "$C2" 2>/dev/null
check "끝나면 busy 없음" '[ "$(A pack busy | field busy)" = "[]" ]'

section "계획서 논리 경로(delegate·커밋·리뷰 결론·PR 스크립트)"
PLAN="$(ls plans/task/*.md | head -1)"
. scripts/lib/plan-path.sh
check "본체 절대 경로 → plans/…" '[ "$(plan_rel "$B" "$B/$PLAN")" = "$PLAN" ]'
check "팩 데이터 실제 경로 → plans/…" '[ "$(plan_rel "$B" "$ATHENA_DATA_DIR/packs/acme/$PLAN")" = "$PLAN" ]'
check "다른 팩 실제 경로 → 그대로(거부됨)" 'case "$(plan_rel "$B" "$ATHENA_DATA_DIR/packs/globex/plans/task/x.md")" in plans/*) false ;; *) true ;; esac'
check "review-result 가 절대 경로 계획서를 받음" 'bash scripts/review-result.sh --plan "$B/$PLAN" --dir "$B/repos/acme-web" --verdict 승인 --note 시험 >/dev/null 2>&1 && grep -q "Review result: 승인" "$PLAN"'
R="$(bash scripts/new-branch.sh T-9 acme-web 2>&1)"
check "new-branch 워크트리는 팩 데이터 실제 경로" 'git -C repos/acme-web worktree list | grep -q "$ATHENA_DATA_DIR/packs/acme/worktrees/acme-web/feature-T-9"' "$R"

section "옛 pack backup·restore 는 여러 팩에서 멈춤"
mkdir -p "$WORK/oldbk"
OUT="$(node scripts/athena.mjs pack backup --out "$WORK/oldbk" 2>&1)"; CODE=$?
check "pack backup → 실패 · 안내 · 파일 없음" '[ "$CODE" = 1 ] && echo "$OUT" | grep -q "backup --with-work" && [ -z "$(ls "$WORK/oldbk")" ]' "$OUT"
OUT="$(node scripts/athena.mjs pack restore "$SRC/test/fixtures/repos/repos.json" 2>&1)"; CODE=$?
check "pack restore → 실패 · 안내 · 설정에 pack 안 씀" '[ "$CODE" = 1 ] && echo "$OUT" | grep -q "pack import" && [ ! -d packs ] && ! grep -q "\"pack\"" athena.config.json' "$OUT"

section "가져오기 · 내보내기 · 백업"
F="$SRC/test/fixtures"; O="$WORK/out"; mkdir -p "$O"
R="$(A pack export --out "$O")"; EXPORT="$(echo "$R" | field file)"
check "내보내기 — 허용 목록만(작업 기록·archive 없음)" '[ -f "$EXPORT" ] && ! tar -tzf "$EXPORT" | grep -Eq "plans/|issues/|archive/|local.json"' "$R"
R="$(A pack inspect "$EXPORT")"; TOKEN="$(echo "$R" | field token)"
check "같은 팩 압축 → conflict(packId)" '[ "$(echo "$R" | field conflict.reason)" = packId ]' "$R"
check "같은 packId 를 --new → conflict" '[ "$(A pack import "$TOKEN" --new | field error)" = conflict ]'
R="$(A pack import "$TOKEN" --replace)"
check "--replace → 백업 남기고 교체 · 작업 기록 그대로" '[ -f "$(echo "$R" | field backup)" ] && ls plans/task | grep -q acme' "$R"
R="$(A pack inspect "$EXPORT")"; check "--keep → 임시본 버림" '[ "$(A pack import "$(echo "$R" | field token)" --keep | field ok)" = True ] && [ -z "$(ls "$ATHENA_DATA_DIR/tmp" 2>/dev/null)" ]'
check "나쁜 팩: 모르는 형식 → format-unknown" '[ "$(A pack inspect "$F/bad-packs/future-format" | field error)" = format-unknown ]'
check "나쁜 팩: pack.json 없음 → invalid-pack" '[ "$(A pack inspect "$F/bad-packs/no-pack-json" | field error)" = invalid-pack ]'
check "나쁜 팩: 밖을 가리키는 링크 → unsafe" '[ "$(A pack inspect "$F/bad-packs/outside-link" | field error)" = unsafe ]'
mkdir -p "$O/loop" && cp -R "$F/packs/globex/." "$O/loop/" && ln -s . "$O/loop/d" && rm -rf "$O/loop/knowledge" && ln -s d/d/../.. "$O/loop/knowledge"
check "나쁜 팩: 링크 폴더를 거치는 우회(d → . · knowledge → d/d/../..) → unsafe" '[ "$(A pack inspect "$O/loop" | field error)" = unsafe ]'
mkdir -p "$O/envpack" && cp -R "$F/packs/globex/." "$O/envpack/" && printf 'FAKE=1\n' > "$O/envpack/.env"
check "나쁜 팩: .env → unsafe" '[ "$(A pack inspect "$O/envpack" | field error)" = unsafe ]'
mkdir -p "$O/dd/in" && cp "$F/packs/globex/pack.json" "$O/dd/in/" && (cd "$O/dd/in" && tar -czf "$O/dotdot.tar.gz" ../in/pack.json 2>/dev/null)
check "나쁜 압축: ../ → unsafe" '[ "$(A pack inspect "$O/dotdot.tar.gz" | field error)" = unsafe ]'
mkdir -p "$O/gitlink" && cp -R "$F/packs/globex/." "$O/gitlink/" && ln -s /etc "$O/gitlink/.git"
check "나쁜 팩: 최상위 .git → /etc 링크 → unsafe" '[ "$(A pack inspect "$O/gitlink" | field error)" = unsafe ]'
mkdir -p "$O/gitin/inner" && cp -R "$F/packs/globex/." "$O/gitin/" && printf '[core]\n\tfsmonitor = touch %s/PWNED2\n' "$O" > "$O/gitin/inner/config" && ln -s inner "$O/gitin/.git"
check "나쁜 팩: 최상위 .git → 팩 안 폴더 링크 → unsafe" '[ "$(A pack inspect "$O/gitin" | field error)" = unsafe ] && [ ! -e "$O/PWNED2" ]'
mkdir -p "$O/gitfile" && cp -R "$F/packs/globex/." "$O/gitfile/" && printf 'gitdir: /etc\n' > "$O/gitfile/.git"
R="$(A pack inspect "$O/gitfile")"
check "최상위 .git 파일(gitdir 표시) → 지우고 통과" '[ "$(echo "$R" | field ok)" = True ] && [ ! -e "$ATHENA_DATA_DIR/tmp/$(echo "$R" | field token)/pack/.git" ]' "$R"
A pack import "$(echo "$R" | field token)" --keep >/dev/null
mkdir -p "$O/gitarc/p/.git" && cp -R "$F/packs/globex/." "$O/gitarc/p/" && printf '[core]\n\tfsmonitor = touch %s/PWNED\n' "$O" > "$O/gitarc/p/.git/config" && (cd "$O/gitarc" && tar -czf "$O/gitarc.tar.gz" p)
R="$(A pack inspect "$O/gitarc.tar.gz")"
check "압축 안 .git 폴더(core.fsmonitor) → 지워짐 · gitRemoved" '[ "$(echo "$R" | field ok)" = True ] && [ "$(echo "$R" | field gitRemoved)" = True ] && [ ! -e "$ATHENA_DATA_DIR/tmp/$(echo "$R" | field token)/pack/.git" ] && [ ! -e "$O/PWNED" ]' "$R"
A pack import "$(echo "$R" | field token)" --keep >/dev/null
R="$(A pack inspect "$O/gitarc/p")"
check "폴더 안 .git 폴더 → 지워짐 · gitRemoved(결정 R4 A)" '[ "$(echo "$R" | field gitRemoved)" = True ] && [ ! -e "$ATHENA_DATA_DIR/tmp/$(echo "$R" | field token)/pack/.git" ]' "$R"
A pack import "$(echo "$R" | field token)" --keep >/dev/null
check "git 특수 전송 ext:: → unsafe" '[ "$(A pack inspect "ext::sh -c id" | field error)" = unsafe ]'
check "나쁜 팩 뒤 임시본 없음" '[ -z "$(ls "$ATHENA_DATA_DIR/tmp" 2>/dev/null)" ]'
R="$(A pack backup --with-work --out "$O")"; WB="$(echo "$R" | field file)"
check "작업 기록 백업 — 계획서·이슈 포함" 'tar -tzf "$WB" | grep -q "/plans/" && tar -tzf "$WB" | grep -q "/issues/" && tar -tzf "$WB" | grep -q athena-backup.json' "$R"
check "되살리기(같은 팩) → conflict 안내" '[ "$(A pack restore --with-work "$WB" | field error)" = conflict ]'

section "옛 아테나 가져오기 · 옮기기"
OA="$WORK/oldathena"; mkdir -p "$OA/packs/umbrella" "$OA/plans/task" "$OA/issues"
cp -R "$F/packs/acme/." "$OA/packs/umbrella/"; python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop('id'); d['name']='Umbrella'; json.dump(d, open(p,'w'))" "$OA/packs/umbrella/pack.json"
printf '{ "pack": "packs/umbrella", "reposRoot": "..", "screen": "herdr" }\n' > "$OA/athena.config.json"
printf '# 옛 계획\n' > "$OA/plans/task/20261001-old.md"; printf '# 옛 이슈\n' > "$OA/issues/20261001-old.md"; printf 'x\n' > "$OA/issues/README.md"
git init -q "$OA/packs/umbrella"   # 내 옛 아테나의 팩이 git 레포면 .git 을 그대로 가져온다(결정 R4 A)
BEFORE="$(cd "$OA" && find . -type f | sort | xargs shasum | shasum)"
R="$(A pack import-athena "$OA")"
check "import-athena → 계획서 1 · 이슈 1 · .git 남김" '[ -d "$ATHENA_DATA_DIR/tmp/$(echo "$R" | field token)/pack/.git" ] && [ -z "$(echo "$R" | field gitRemoved)" ] && [ "$(echo "$R" | field work.plans)" = 1 ] && [ "$(echo "$R" | field work.issues)" = 1 ]' "$R"
R="$(A pack import "$(echo "$R" | field token)" --new)"
check "id 를 써 넣었으면 packJsonUpdated" '[ -n "$(echo "$R" | field packJsonUpdated.id)" ]' "$R"
check "등록 · 원본 그대로" '[ "$(echo "$R" | field imported.id)" = umbrella ] && [ "$BEFORE" = "$(cd "$OA" && find . -type f | sort | xargs shasum | shasum)" ]' "$R"
L="$WORK/legacy"; mkbody "$L"; mkdir -p "$L/packs/demo" "$L/plans/task" "$L/issues"; cp -R "$F/packs/globex/." "$L/packs/demo/"
printf '{ "pack": "packs/demo", "reposRoot": "..", "screen": "herdr" }\n' > "$L/athena.config.json"; printf '# 계획\n' > "$L/plans/task/20261001-a.md"; printf '# 이슈\n' > "$L/issues/20261001-a.md"
R="$(cd "$L" && ATHENA_DATA_DIR="$WORK/mig-data" node scripts/athena.mjs pack migrate --json | tail -1)"
check "migrate(계획만) — 바꾸지 않음" '[ "$(echo "$R" | field dryRun)" = True ] && [ ! -L "$L/plans" ]' "$R"
R="$(cd "$L" && ATHENA_DATA_DIR="$WORK/mig-data" node scripts/athena.mjs pack migrate --yes --json | tail -1)"
check "migrate --yes — 링크 전환 · screen 지움 · 원본 팩 남음" '[ "$(echo "$R" | field ok)" = True ] && [ -L "$L/plans" ] && ls "$L/plans/task" | grep -q 20261001-a && ! grep -q screen "$L/athena.config.json" && [ -f "$L/packs/demo/pack.json" ]' "$R"
R="$(cd "$L" && ATHENA_DATA_DIR="$WORK/mig-data" node scripts/athena.mjs pack migrate --yes --json | tail -1)"
check "migrate 두 번째 → already" '[ "$(echo "$R" | field already)" = True ]' "$R"

section "현황판 — 팩·세대 · 토큰 · 409 · 끄기"
printf '{}' > "$ATHENA_DATA_DIR/packs/acme/state/board-token"; chmod 644 "$ATHENA_DATA_DIR/packs/acme/state/board-token"   # 이전 현황판이 남긴 파일이 644 였어도
bash scripts/board.sh >/dev/null 2>&1
STATE="$(curl -s "http://127.0.0.1:$PORT/api/state")"
check "/api/state.pack = acme" '[ "$(echo "$STATE" | field pack.id)" = acme ]' "$(echo "$STATE" | head -c 200)"
check "카드는 acme 것만" 'echo "$STATE" | grep -q acme-sample && ! echo "$STATE" | grep -q globex-sample'
TOKEN="$(A pack board-token | field token)"
check "board-token 은 포트 $PORT" '[ "$(A pack board-token | field port)" = "$PORT" ] && [ -n "$TOKEN" ]'
check "토큰 파일 권한 600" '[ "$(stat -f %Lp "$ATHENA_DATA_DIR/packs/acme/state/board-token" 2>/dev/null || stat -c %a "$ATHENA_DATA_DIR/packs/acme/state/board-token")" = 600 ]'
HDR=(-H "Origin: http://localhost:$PORT" -H "x-board-token: $TOKEN" -H "content-type: application/json")
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['generation']+=1; json.dump(d, open(p,'w'))" "$ATHENA_DATA_DIR/config.json"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${HDR[@]}" -d '{"id":"x","column":"done"}' "http://127.0.0.1:$PORT/api/move")"
check "세대가 다르면 쓰기 409" '[ "$CODE" = 409 ]' "$CODE"
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['generation']-=1; json.dump(d, open(p,'w'))" "$ATHENA_DATA_DIR/config.json"
check "같은 팩이면 board.sh 가 다시 안 띄움" 'bash scripts/board.sh 2>&1 | grep -q "이미 떠 있음"'
R="$(A pack use globex --start-board)"
check "pack use 가 현황판을 끄고(--start-board) 새 팩으로" '[ "$(echo "$R" | field boardStopped)" = "[$PORT]" ] && [ "$(curl -s "http://127.0.0.1:$PORT/api/state" | field pack.id)" = globex ]' "$R"
TOKEN="$(A pack board-token | field token)"; HDR=(-H "Origin: http://localhost:$PORT" -H "x-board-token: $TOKEN" -H "content-type: application/json")
check "POST /api/shutdown → 꺼짐 · 토큰 파일 지움" '[ "$(curl -s -X POST "${HDR[@]}" -d "{}" "http://127.0.0.1:$PORT/api/shutdown" | field ok)" = True ] && sleep 0.5 && [ "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/state")" = 000 ] && [ ! -f "$ATHENA_DATA_DIR/packs/globex/state/board-token" ]'

section "pack new"
R="$(A pack new)"; NEW="$(echo "$R" | field id)"
check "빈 자리가 지금 팩(empty) · 목록(packs)에는 안 보임" '[ "$(basename "$(readlink .pack-data)")" = "$NEW" ] && [ "$(A pack list | field current.empty)" = True ] && ! A pack list | field packs | grep -q "$NEW"' "$R"
R="$(A pack use "$(echo "$R" | field previous)")"
check "취소(use previous) → 빈 자리 지움" '[ "$(echo "$R" | field ok)" = True ] && [ ! -d "$ATHENA_DATA_DIR/packs/$NEW" ]' "$R"

printf '\n통과 %d · 실패 %d%s\n' "$PASS" "$FAIL" "$([ "${KEEP:-}" = 1 ] && echo " · 임시 폴더 $WORK")"
[ "$FAIL" = 0 ]
