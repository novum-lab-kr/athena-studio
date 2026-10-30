#!/usr/bin/env bash
# 여러 팩 회귀 시험 — 작업 트리를 임시 폴더에 복사한 본체 + 임시 데이터 폴더에서 bin/athena pack 명령을 끝까지 돌린다.
# 진짜 스튜디오 집(~/.athena-studio) · 이 체크아웃의 링크·설정은 건드리지 않는다(임시 폴더만 · 끝나면 지운다).
#
# 사용: test/packs-test.sh            → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#       KEEP=1 test/packs-test.sh     → 임시 폴더를 남긴다(경로를 마지막에 보여 준다)
#
# 보는 것(계획서 7절 "단계별 확인" · 팩마다 본체 이후): test-setup · 이 본체의 팩 열기·계약 확인 · 팩마다 잠금 · busy(claude·codex) ·
# (본체 만들기·업데이트·되돌리기는 test/bodies-test.sh) · 나쁜 팩(형식·pack.json 없음·밖 링크·.env·../·ext::) · 같은 팩 충돌·교체 백업 ·
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
unset ATHENA_AGENT ATHENA_STUDIO ATHENA_BOARD_PORT ATHENA_PACK_FAIL_AT
export ATHENA_SCREEN=none ATHENA_BOARD_NO_BROWSER=1 ATHENA_DATA_DIR="$WORK/test-data" ATHENA_HEAVY_LOCK="$WORK/heavy.lock"
PORT=47710

# ── 본체 사본 ───────────────────────────────────────────────────────────
mkbody() { # mkbody <폴더> — git clone(코어 이력) + 작업 트리 덮기
  git clone -q "$SRC" "$1" 2>/dev/null || { mkdir -p "$1"; git -C "$1" init -q; }
  rsync -a --delete --exclude .git --exclude .omc --exclude /plans --exclude /issues --exclude /repos --exclude /.worktrees --exclude /pack --exclude /packs \
    --exclude /archive --exclude /.sync --exclude /.pack-data --exclude /athena.config.json --exclude __pycache__ --exclude '/.board-*' --exclude '/.qa-*' \
    --exclude /.jev-log.jsonl --exclude /.events.jsonl --exclude /.migrate-* --exclude node_modules "$SRC/" "$1/"
}
B="$WORK/body"; mkbody "$B"; cd "$B" || exit 1
A() { node scripts/athena.mjs "$@" --json 2>/dev/null | tail -1; }
# field a.b.c — 목록이면 그 id 를 가진 항목(packs.acme.displayName)
field() { python3 -c 'import json,sys
d=json.loads(sys.stdin.read() or "{}")
for k in sys.argv[1].split("."):
    if isinstance(d, list): d = next((x for x in d if isinstance(x, dict) and x.get("id") == k), None)
    else: d = d.get(k) if isinstance(d, dict) else None
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
check "스튜디오 데이터 폴더(~/.athena-studio/data)로는 거부" '[ "$(ATHENA_DATA_DIR="$HOME/.athena-studio/data" node scripts/athena.mjs pack test-setup --json | tail -1 | field error)" = unsafe ]'

section "이 본체의 팩 · 열기(같은 본체 — 본체 만들기는 test/bodies-test.sh)"
R="$(A pack use acme --contract 3)"
check "pack use 이 본체 팩 → unchanged · body 는 이 본체" '[ "$(echo "$R" | field unchanged)" = True ] && [ "$(echo "$R" | field body)" = "$B" ] && [ "$(echo "$R" | field bodyChanged)" = False ]' "$R"
check "pack use --json 계약 없이 → contract-mismatch" '[ "$(A pack use acme | field error)" = contract-mismatch ]'
check "pack new --json 계약 없이 → contract-mismatch" '[ "$(A pack new | field error)" = contract-mismatch ]'
check "--contract 1 → contract-mismatch" '[ "$(A pack list --contract 1 | field error)" = contract-mismatch ]'
R="$(A pack open acme)"
check "pack open 이 본체 팩 → created false · 포트 $PORT · state ready" '[ "$(echo "$R" | field created)" = False ] && [ "$(echo "$R" | field boardPort)" = "$PORT" ] && [ "$(echo "$R" | field state)" = ready ] && [ "$(echo "$R" | field contract)" = 3 ]' "$R"
check "레지스트리에 acme 본체·포트 등록" 'python3 -c "import json,sys; d=json.load(open(sys.argv[1]))[\"packs\"][\"acme\"]; sys.exit(0 if d.get(\"body\")==sys.argv[2] and d.get(\"boardPort\")=='"$PORT"' else 1)" "$ATHENA_DATA_DIR/config.json" "$B"'
check "없는 팩 → not-found" '[ "$(A pack open nope | field error)" = not-found ]'
check "이미 묶인 본체에 다른 팩 attach → body-mismatch" '[ "$(A pack attach globex | field error)" = body-mismatch ] && [ "$(basename "$(readlink .pack-data)")" = acme ]'

section "잠금(팩마다) · busy"
mkdir -p "$ATHENA_DATA_DIR/locks/acme.lock"; sleep 60 & LOCKPID=$!; echo "$LOCKPID" > "$ATHENA_DATA_DIR/locks/acme.lock/pid"
check "acme 잠금 중 → pack open acme locked" '[ "$(A pack open acme | field error)" = locked ]'
check "잠금 중 status.switching" '[ "$(A pack status | field switching)" = True ]'
check "잠금 중 delegate 거부" '! bash scripts/delegate.sh acme-web-fe --plan "$(ls plans/task/*.md | head -1)" --here >/dev/null 2>&1'
check "잠금 중 new-branch 거부" '! bash scripts/new-branch.sh T-1 acme-web >/dev/null 2>&1'
check "다른 팩(globex) 잠금은 이 본체를 막지 않음" 'mv "$ATHENA_DATA_DIR/locks/acme.lock" "$ATHENA_DATA_DIR/locks/globex.lock" && [ "$(A pack status | field switching)" = False ]'
kill "$LOCKPID" 2>/dev/null; wait "$LOCKPID" 2>/dev/null; rm -rf "$ATHENA_DATA_DIR/locks/globex.lock"
check "주인이 죽은 잠금은 넘겨받음" 'mkdir -p "$ATHENA_DATA_DIR/locks/acme.lock" && echo 999999 > "$ATHENA_DATA_DIR/locks/acme.lock/pid" && [ "$(A pack open acme | field ok)" = True ] && [ ! -d "$ATHENA_DATA_DIR/locks/acme.lock" ]'
check "pid 없는 부서진 잠금도 넘겨받음" 'mkdir -p "$ATHENA_DATA_DIR/locks/acme.lock" && [ "$(A pack open acme | field ok)" = True ]'
FAKE="$WORK/fakebin"; mkdir -p "$FAKE"; ln -s "$(command -v node)" "$FAKE/claude"; ln -s "$(command -v node)" "$FAKE/codex"
(cd "$B" && exec "$FAKE/claude" -e 'setTimeout(() => {}, 60000)') & C1=$!
# 레포 메인 체크아웃 — 아테나가 띄운 에이전트(--agent 인자)만 센다(결정 D1). 사용자가 직접 켠 claude(인자 없음)는 세지 않는다
(cd "$ATHENA_DATA_DIR/repos-src/acme-web" && exec "$FAKE/claude" -e 'setTimeout(() => {}, 60000)' -- --agent acme-web-fe) & C2=$!
(cd "$B" && exec "$FAKE/codex" -e 'setTimeout(() => {}, 60000)') & C3=$!
(cd "$ATHENA_DATA_DIR/repos-src/acme-web" && exec "$FAKE/claude" -e 'setTimeout(() => {}, 60000)') & C4=$!
sleep 0.5
R="$(A pack busy)"
check "busy: athena · agent · codex · busyKnown" 'echo "$R" | grep -q "\"kind\":\"athena\"" && echo "$R" | grep -q "\"kind\":\"agent\"" && echo "$R" | grep -q "\"kind\":\"codex\"" && [ "$(echo "$R" | field busyKnown)" = True ]' "$R"
check "레포 메인 체크아웃: --agent 붙은 claude 만 agent · 인자 없는 claude 는 안 셈" 'echo "$R" | grep -q "\"pid\":$C2[,}]" && ! echo "$R" | grep -q "\"pid\":$C4[,}]"' "$R"
kill "$C4" 2>/dev/null; wait "$C4" 2>/dev/null
R="$(A pack list)"
check "list: acme bodyBusy · busy[] 있음" '[ "$(echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); p=[x for x in d[\"packs\"] if x[\"id\"]==\"acme\"][0]; print(p[\"bodyBusy\"], len(p[\"busy\"])>=3)")" = "True True" ]' "$R"
check "busy 여도 이 본체 팩 use 는 unchanged" '[ "$(A pack use acme --contract 3 | field unchanged)" = True ]'
kill "$C1" "$C2" "$C3" 2>/dev/null; wait "$C1" "$C2" "$C3" 2>/dev/null
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
# delegate.sh — 본체의 링크(pack · plans · issues)가 가리키는 데이터 폴더 실제 경로도 --add-dir 로(권한 질문으로 멈추지 않게 · 2026-10-25 시험)
LD="$(ATHENA_DIR="$B" ATHENA_REAL="$(cd "$B" && pwd -P)" bash -c 'shq() { printf "%q" "$1"; }; eval "$(awk "/^LINK_DIRS=\"\"/{p=1} p{print} p && /^done\$/{exit}" scripts/delegate.sh)"; echo "$LINK_DIRS"')"
check "delegate — 링크된 pack · plans · issues 의 실제 경로를 --add-dir 로" 'echo "$LD" | grep -qF -- "--add-dir $(cd "$ATHENA_DATA_DIR/packs/acme/pack" && pwd -P)" && echo "$LD" | grep -qF -- "--add-dir $(cd "$ATHENA_DATA_DIR/packs/acme/plans" && pwd -P)" && echo "$LD" | grep -qF -- "--add-dir $(cd "$ATHENA_DATA_DIR/packs/acme/issues" && pwd -P)"' "$LD"

section "옛 pack backup·restore 는 여러 팩에서 멈춤"
mkdir -p "$WORK/oldbk"
OUT="$(node scripts/athena.mjs pack backup --out "$WORK/oldbk" 2>&1)"; CODE=$?
check "pack backup → 실패 · 안내 · 파일 없음" '[ "$CODE" = 1 ] && echo "$OUT" | grep -q "backup --with-work" && [ -z "$(ls "$WORK/oldbk")" ]' "$OUT"
OUT="$(node scripts/athena.mjs pack restore "$SRC/test/fixtures/repos/repos.json" 2>&1)"; CODE=$?
check "pack restore → 실패 · 안내 · 설정에 pack 안 씀" '[ "$CODE" = 1 ] && echo "$OUT" | grep -q "pack import" && [ ! -d packs ] && ! grep -q "\"pack\"" athena.config.json' "$OUT"

section "가져오기 · 내보내기 · 백업"
F="$SRC/test/fixtures"; O="$WORK/out"; mkdir -p "$O"
PRE_EXPORT="$(shasum pack/pack.json)"
R="$(A pack export --out "$O")"; EXPORT="$(echo "$R" | field file)"
check "내보내기 사본 pack.json 에 git 주소 · 원본 팩은 그대로" 'tar -xzOf "$EXPORT" acme/pack.json | grep -q "\"remote\"" && [ "$PRE_EXPORT" = "$(shasum pack/pack.json)" ]'
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
check "폴더 안 .git 폴더 → 지워짐 · gitRemoved" '[ "$(echo "$R" | field gitRemoved)" = True ] && [ ! -e "$ATHENA_DATA_DIR/tmp/$(echo "$R" | field token)/pack/.git" ]' "$R"
A pack import "$(echo "$R" | field token)" --keep >/dev/null
check "git 특수 전송 ext:: → unsafe" '[ "$(A pack inspect "ext::sh -c id" | field error)" = unsafe ]'
check "나쁜 팩 뒤 임시본 없음" '[ -z "$(ls "$ATHENA_DATA_DIR/tmp" 2>/dev/null)" ]'
R="$(A pack backup --with-work --out "$O")"; WB="$(echo "$R" | field file)"
check "작업 기록 백업 — 계획서·이슈 포함" 'tar -tzf "$WB" | grep -q "/plans/" && tar -tzf "$WB" | grep -q "/issues/" && tar -tzf "$WB" | grep -q athena-backup.json' "$R"
check "되살리기(같은 팩) → conflict 안내" '[ "$(A pack restore --with-work "$WB" | field error)" = conflict ]'
check "백업 — 레포 자리(local.json · 실제 경로) · 사본 pack.json 에 git 주소" 'tar -xzOf "$WB" acme/local.json | grep -q "$ATHENA_DATA_DIR/repos-src/acme-web" && tar -xzOf "$WB" acme/pack/pack.json | grep -q "\"remote\""' "$(tar -xzOf "$WB" acme/local.json 2>&1)"
FRESH="$WORK/fresh-test-data"; mkdir -p "$FRESH"
R="$(ATHENA_DATA_DIR="$FRESH" node scripts/athena.mjs pack inspect "$WB" --json 2>/dev/null | tail -1)"
R="$(ATHENA_DATA_DIR="$FRESH" node scripts/athena.mjs pack import "$(echo "$R" | field token)" --new --json 2>/dev/null | tail -1)"
check "빈 데이터에 백업 되살리기(--new) → 레포 자리 그대로 · 계획서 · 이슈" 'grep -q "$ATHENA_DATA_DIR/repos-src/acme-web" "$FRESH/packs/acme/local.json" && ls "$FRESH/packs/acme/plans/task" | grep -q acme && ls "$FRESH/packs/acme/issues" | grep -q acme' "$R"

section "레포 자리 찾기 — 손으로 이은 링크 · git 주소"
SRCS="$ATHENA_DATA_DIR/repos-src"; LOCAL="$ATHENA_DATA_DIR/packs/acme/local.json"; cp "$LOCAL" "$WORK/local.json.bak"; cp pack/pack.json "$WORK/pack.json.bak"
mkdir -p "$SRCS/team" && mv "$SRCS/acme-api" "$SRCS/team/api-moved"
python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); [r.update(remote=sys.argv[2]) for r in p["repos"] if r["name"]=="acme-api"]; json.dump(p,open(sys.argv[1],"w"),indent=2)' pack/pack.json "$(git -C "$SRCS/team/api-moved" config --get remote.origin.url)"
R="$(A pack open acme)"
check "폴더를 옮겨도 git 주소로 찾아 이음 · local.json 에 적음" '[ "$(echo "$R" | field unlinkedRepos)" = "[]" ] && [ "$(readlink repos/acme-api)" = "$SRCS/team/api-moved" ] && grep -q "team/api-moved" "$LOCAL"' "$R"
python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); [r.pop("remote",None) for r in p["repos"]]; json.dump(p,open(sys.argv[1],"w"),indent=2)' pack/pack.json
printf '{ "reposRoot": "%s" }\n' "$SRCS" > "$LOCAL"
R="$(A pack open acme)"
check "설정에 없어도 지금 링크가 레포면 지우지 않고 local.json 에 적음" '[ "$(echo "$R" | field unlinkedRepos)" = "[]" ] && [ "$(readlink repos/acme-api)" = "$SRCS/team/api-moved" ] && grep -q "team/api-moved" "$LOCAL"' "$R"
mv "$SRCS/team/api-moved" "$SRCS/acme-api"; cp "$WORK/local.json.bak" "$LOCAL"; cp "$WORK/pack.json.bak" pack/pack.json; A pack open acme >/dev/null
check "원래대로 — acme-api 다시 이어짐" '[ "$(readlink repos/acme-api)" = "$SRCS/acme-api" ]'

section "되살리기 — 에이전트 대화 · 워크트리(미커밋 · push 안 한 커밋)"
export ATHENA_CLAUDE_HOME="$WORK/claude-home"   # 진짜 ~/.claude 를 건드리지 않게
WT="$ATHENA_DATA_DIR/packs/acme/worktrees/acme-web/feature-T-9"; WTR="$(cd "$WT" && pwd -P)"
SID=11111111-2222-3333-4444-555555555555
check "훅: pane ↔ 대화 기록(state/pane-sessions/p9.json)" 'printf "{\"session_id\":\"%s\",\"cwd\":\"%s\"}" "$SID" "$WTR" | ATHENA_SCREEN=studio ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p9 ATHENA_AGENT=acme-web-fe ATHENA_PLAN="$PLAN" python3 scripts/hooks/pane-session.py && grep -q "$SID" "$ATHENA_DATA_DIR/packs/acme/state/pane-sessions/p9.json"'
SID2=22222222-3333-4444-5555-666666666666; BR="$(pwd -P)"
printf "{\"session_id\":\"%s\",\"cwd\":\"%s\"}" "$SID2" "$BR" | ATHENA_SCREEN=studio ATHENA_STUDIO=1 ATHENA_STUDIO_PANE_ID=p8 python3 scripts/hooks/pane-session.py   # 본체 아테나(ATHENA_AGENT 없음)
PROJ2="$ATHENA_CLAUDE_HOME/.claude/projects/$(printf '%s' "$BR" | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$PROJ2" && printf '{}\n' > "$PROJ2/$SID2.jsonl"
PROJ="$ATHENA_CLAUDE_HOME/.claude/projects/$(printf '%s' "$WTR" | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$PROJ/$SID/subagents" && printf '{"type":"user"}\n' > "$PROJ/$SID.jsonl" && printf '{}\n' > "$PROJ/$SID/subagents/agent-a.jsonl"
(cd "$WT" && git config user.email t@e.invalid && git config user.name t && echo local > local.txt && git add local.txt && git commit -qm local \
  && echo staged >> README.md && git add README.md && echo unstaged >> README.md && echo new > new.txt && echo SECRET=1 > .env) >/dev/null 2>&1
HEAD_BEFORE="$(git -C "$WT" rev-parse HEAD)"
R="$(A pack backup --with-work --panes p9,p8,p404 --out "$O")"; WB2="$(echo "$R" | field file)"
check "백업 — 기록 없는 pane 은 missing(p404)" '[ "$(echo "$R" | field restore.missing)" = "[\"p404\"]" ]' "$R"
check "백업 — 대화 2 · 워크트리 · 대화 기록(하위 에이전트까지)" '[ "$(echo "$R" | field restore.sessions)" = 2 ] && tar -tzf "$WB2" | grep -q "acme/restore/transcripts/$SID.jsonl" && tar -tzf "$WB2" | grep -q "transcripts/$SID/subagents/agent-a.jsonl"' "$R"
check "백업 — staged · unstaged · 추적 안 하는 파일 · push 안 한 커밋 · .env 는 뺌" 'L="$(tar -tzf "$WB2")"; echo "$L" | grep -q "worktrees/[0-9]*/staged.patch" && echo "$L" | grep -q "worktrees/[0-9]*/unstaged.patch" && echo "$L" | grep -q "untracked/new.txt" && echo "$L" | grep -q "commits.bundle" && ! echo "$L" | grep -q "\.env$"'
rm -rf "$WT" "$PROJ"   # 초기화처럼 — 워크트리 폴더 · 대화 기록이 사라짐(레포의 등록 · 브랜치는 남는다)
R="$(A pack inspect "$WB2")"
check "검사 — 되살리기 요약(대화 2 · 에이전트 1 · 아테나 1)" '[ "$(echo "$R" | field restore.sessions)" = 2 ] && [ "$(echo "$R" | field restore.agents)" = 1 ] && [ "$(echo "$R" | field restore.athena)" = 1 ]' "$R"
R="$(A pack import "$(echo "$R" | field token)" --replace)"
check "가져오기 → state/restore 에 둠" '[ -f "$ATHENA_DATA_DIR/packs/acme/state/restore/restore.json" ]' "$R"
check "restore-work --dry-run → 남은 것 있음" '[ "$(A pack restore-work --dry-run | field pending)" = True ]'
R="$(A pack restore-work --no-agents)"
check "워크트리 되살림 — 같은 HEAD · staged · unstaged · 새 파일 · .env 없음" '[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_BEFORE" ] && git -C "$WT" diff --cached | grep -q "+staged" && git -C "$WT" diff | grep -q "+unstaged" && [ -f "$WT/new.txt" ] && [ ! -e "$WT/.env" ]' "$R"
check "대화 기록 되살림 · 에이전트는 건너뜀(--no-agents) · 아테나는 앱에 넘김(ack 전까지 남음)" '[ -f "$PROJ/$SID.jsonl" ] && [ -f "$PROJ/$SID/subagents/agent-a.jsonl" ] && echo "$R" | grep -q "$SID2" && [ "$(echo "$R" | field remaining)" = 2 ] && [ -d "$ATHENA_DATA_DIR/packs/acme/state/restore" ]' "$R"
check "--ack <아테나 세션> → 그것만 끝 · 에이전트는 남음" '[ "$(A pack restore-work --ack "$SID2" | field remaining)" = 1 ]' 
R="$(A pack restore-work --no-agents)"
check "다시 돌려도 워크트리는 그대로(이미 됨)" '[ "$(echo "$R" | field worktrees)" = "[]" ] && [ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_BEFORE" ]' "$R"
# 대화 없는 껍데기 기록(세션이 살아 있는 채로 지워진 뒤 다시 쓴 것)이 있으면 백업 것으로 바꾼다
A pack restore-work --discard >/dev/null; rm -rf "$WT"; printf '{"type":"mode"}\n' > "$PROJ/$SID.jsonl"; R="$(A pack inspect "$WB2")"; A pack import "$(echo "$R" | field token)" --replace >/dev/null
A pack restore-work --no-agents >/dev/null
check "껍데기 기록 → 백업 것으로(옛 것은 .bak)" 'grep -q "\"type\":\"user\"" "$PROJ/$SID.jsonl" && ls "$PROJ" | grep -q "$SID.jsonl.bak-"'
# staged 가 안 되면 그 단계에서 멈추고 · 다시 부르면 거기서 잇는다(unstaged 를 엉뚱한 기준에 얹지 않는다)
A pack restore-work --discard >/dev/null; rm -rf "$WT"; R="$(A pack inspect "$WB2")"; A pack import "$(echo "$R" | field token)" --replace >/dev/null
SP="$(ls "$ATHENA_DATA_DIR"/packs/acme/state/restore/worktrees/*/staged.patch | head -1)"; cp "$SP" "$WORK/staged.ok"; printf 'not a patch\n' > "$SP"
R="$(A pack restore-work --no-agents)"
check "staged 실패 → 멈춤(unstaged 안 얹음) · 다시 할 자리 남음" 'echo "$R" | grep -q patch-staged && ! git -C "$WT" diff | grep -q "+unstaged" && [ -d "$ATHENA_DATA_DIR/packs/acme/state/restore" ]' "$R"
cp "$WORK/staged.ok" "$SP"; R="$(A pack restore-work --no-agents)"
check "고친 뒤 다시 → 그 단계부터 이어서 끝" 'git -C "$WT" diff --cached | grep -q "+staged" && git -C "$WT" diff | grep -q "+unstaged" && [ -f "$WT/new.txt" ]' "$R"
check "--discard → 되살리기 정보 버림" '[ "$(A pack restore-work --discard | field ok)" = True ] && [ ! -d "$ATHENA_DATA_DIR/packs/acme/state/restore" ]'
# 다른 컴퓨터처럼 — push 안 한 커밋이 레포에 아예 없다(브랜치 · 객체 지움) → 백업의 bundle 로 같은 HEAD
REPO_WEB="$(cd repos/acme-web && pwd -P)"
rm -rf "$WT" && git -C "$REPO_WEB" worktree prune && git -C "$REPO_WEB" branch -qD feature/T-9 \
  && git -C "$REPO_WEB" reflog expire --expire=now --all && git -C "$REPO_WEB" gc -q --prune=now
check "(준비) 그 커밋이 레포에 없음" '! git -C "$REPO_WEB" cat-file -e "$HEAD_BEFORE^{commit}" 2>/dev/null'
R="$(A pack inspect "$WB2")"; A pack import "$(echo "$R" | field token)" --replace >/dev/null
R="$(A pack restore-work --no-agents)"
check "push 안 한 커밋 — bundle 에서 받아 같은 HEAD · 브랜치 다시 · 변경 그대로" '[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_BEFORE" ] && [ "$(git -C "$WT" symbolic-ref --short HEAD)" = feature/T-9 ] && git -C "$WT" diff | grep -q "+unstaged"' "$R"
A pack restore-work --discard >/dev/null
mkdir -p "$O/badrestore/acme/restore" && cp -R "$F/packs/acme" "$O/badrestore/acme/pack" && printf '{"kind":"with-work"}\n' > "$O/badrestore/acme/athena-backup.json" \
  && printf '{"version":1,"sessions":[{"agent":"x","session":"11111111-aaaa","plan":"plans/../../etc.md","cwd":"/tmp"}],"worktrees":[]}\n' > "$O/badrestore/acme/restore/restore.json"
check "나쁜 되살리기 정보(계획서 경로에 ..) → unsafe" '[ "$(A pack inspect "$O/badrestore" | field error)" = unsafe ]'
unset ATHENA_CLAUDE_HOME

section "레포 하나 더하기 · 빼기(repo add · remove)"
SRCS="$ATHENA_DATA_DIR/repos-src"; LOCAL="$ATHENA_DATA_DIR/packs/acme/local.json"; cp "$LOCAL" "$WORK/local.add.bak"; cp pack/pack.json "$WORK/pack.add.bak"
mkdir -p "$SRCS/team/new-svc" && git -C "$SRCS/team/new-svc" init -q -b main && (cd "$SRCS/team/new-svc" && echo x > README.md && git add . && git -c user.email=t@e.invalid -c user.name=t commit -qm init && git remote add origin https://u:tok@example.com/acme/new-svc.git)
R="$(A repo add "$SRCS/team/new-svc")"
check "repo add → pack.json 항목(git 주소 · 토큰 뗌) · 자리 · repos/ 링크" '[ "$(echo "$R" | field repo.name)" = new-svc ] && grep -q "\"new-svc\"" pack/pack.json && grep -q "https://example.com/acme/new-svc.git" pack/pack.json && ! grep -q "tok@" pack/pack.json && grep -q "team/new-svc" "$LOCAL" && [ "$(readlink repos/new-svc)" = "$SRCS/team/new-svc" ] && [ "$(echo "$R" | field linked)" = True ]' "$R"
check "repo add → 그 레포 뼈대(에이전트 · 지식 · 검증) · 에이전트 링크" '[ -f pack/agents/new-svc-fe.md ] && [ -f pack/knowledge/new-svc/rules.md ] && [ -x pack/verify/new-svc.sh ] && [ -L .claude/agents/new-svc-fe.md ]' "$R"
check "같은 레포 다시 → already" '[ "$(A repo add "$SRCS/team/new-svc" | field already)" = True ]'
mkdir -p "$SRCS/other/new-svc" && git -C "$SRCS/other/new-svc" init -q -b main
check "같은 이름 · 다른 자리 → exists" '[ "$(A repo add "$SRCS/other/new-svc" | field error)" = exists ]'
check "git 레포가 아니면 → not-repo" '[ "$(A repo add "$WORK" | field error)" = not-repo ]'
mkdir -p "$ATHENA_DATA_DIR/packs/acme/worktrees/new-svc/feature-x"
check "repo remove — 워크트리가 남아 있으면 거부(busy)" '[ "$(A repo remove new-svc | field error)" = busy ] && grep -q "\"new-svc\"" pack/pack.json'
rm -rf "$ATHENA_DATA_DIR/packs/acme/worktrees/new-svc"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' > "$WORK/repo-icon.png"; A pack set-repo-icon new-svc "$WORK/repo-icon.png" >/dev/null
R="$(A repo remove new-svc)"
check "repo remove → 그 레포 아이콘(assets/repos/new-svc.*)도 지움" '[ ! -e pack/assets/repos/new-svc.png ]' "$R"
check "repo remove → 팩 백업 · pack.json · 자리 · 링크 · 에이전트 · 지식 · 검증 지움 · 레포 폴더는 그대로" '[ -f "$(echo "$R" | field backup)" ] && ! grep -q "\"new-svc\"" pack/pack.json && ! grep -q "new-svc" "$LOCAL" && [ ! -e repos/new-svc ] && [ ! -L repos/new-svc ] && [ ! -e pack/agents/new-svc-fe.md ] && [ ! -e pack/knowledge/new-svc ] && [ ! -e pack/verify/new-svc.sh ] && [ ! -L .claude/agents/new-svc-fe.md ] && [ -d "$SRCS/team/new-svc/.git" ]' "$R"
# 아이콘 자리가 링크면(git 으로 받은 팩) 아이콘만 건너뛰고 경고 · 빼기는 이어 간다 · 밖 파일은 그대로
mkdir -p "$SRCS/team/new-svc2" && git -C "$SRCS/team/new-svc2" init -q -b main && A repo add "$SRCS/team/new-svc2" >/dev/null
mkdir -p "$WORK/outside3" && printf 'x' > "$WORK/outside3/new-svc2.png" && rm -rf pack/assets/repos && mkdir -p pack/assets && ln -s "$WORK/outside3" pack/assets/repos
R="$(A repo remove new-svc2)"
check "repo remove — assets/repos 가 링크면 아이콘만 건너뜀(warnings) · 빼기는 됨 · 밖 파일 그대로" '[ "$(echo "$R" | field ok)" = True ] && echo "$R" | grep -q "warnings" && ! grep -q "\"new-svc2\"" pack/pack.json && [ -f "$WORK/outside3/new-svc2.png" ]' "$R"
rm -rf pack/assets
check "없는 레포 → not-found" '[ "$(A repo remove nope | field error)" = not-found ]'
check "다른 레포는 그대로(acme-web · acme-api 링크)" '[ -L repos/acme-web ] && [ -L repos/acme-api ] && [ -L .claude/agents/acme-web-fe.md ]'
cp "$WORK/pack.add.bak" pack/pack.json; cp "$WORK/local.add.bak" "$LOCAL"; A pack open acme >/dev/null

section "팩 표시 이름 · 아이콘(5.7 — 팩 안 · 팀과 공유)"
IMG="$WORK/img"; mkdir -p "$IMG"
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR' > "$IMG/a.png"
printf '\xff\xd8\xff\xe0\x00\x10JFIF' > "$IMG/b-really-jpeg.png"
printf 'RIFF\x10\x00\x00\x00WEBPVP8 ' > "$IMG/c.webp"
printf 'GIF89a\x01\x00' > "$IMG/d.gif"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$IMG/e.svg"
printf 'not an image' > "$IMG/f.png"
{ printf '\x89PNG\r\n\x1a\n'; head -c 1100000 /dev/zero; } > "$IMG/big.png"
R="$(A pack set-name "Acme 팀")"
check "set-name → displayName · pack.json name 그대로" '[ "$(echo "$R" | field displayName)" = "Acme 팀" ] && [ "$(echo "$R" | field id)" = acme ] && [ "$(python3 -c "import json; d=json.load(open(\"pack/pack.json\")); print(d[\"displayName\"], d[\"name\"])")" = "Acme 팀 Acme" ]' "$R"
check "list·status 에 displayName" '[ "$(A pack list | field packs.acme.displayName)" = "Acme 팀" ] && [ "$(A pack status | field current.displayName)" = "Acme 팀" ]'
check "41자 → invalid-name" '[ "$(A pack set-name "$(printf "가%.0s" $(seq 41))" | field error)" = invalid-name ]'
check "줄바꿈 → invalid-name" '[ "$(A pack set-name "$(printf "a\nb")" | field error)" = invalid-name ]'
check "글자 방향 문자(U+202E) → invalid-name" '[ "$(A pack set-name "$(printf "abc\xe2\x80\xaedef")" | field error)" = invalid-name ]'
check "set-name --clear → null" '[ "$(A pack set-name --clear | field displayName)" = "" ] && ! grep -q displayName pack/pack.json'
R="$(A pack set-icon "$IMG/a.png")"
check "set-icon png → assets/icon.png · pack.json icon" '[ "$(echo "$R" | field iconPath)" = "$ATHENA_DATA_DIR/packs/acme/pack/assets/icon.png" ] && grep -q "\"icon\": \"assets/icon.png\"" pack/pack.json' "$R"
check "list 에 iconPath · iconUpdatedAt" '[ "$(A pack list | field packs.acme.iconPath)" = "$ATHENA_DATA_DIR/packs/acme/pack/assets/icon.png" ] && [ -n "$(A pack list | field packs.acme.iconUpdatedAt)" ]'
R="$(A pack set-icon "$IMG/b-really-jpeg.png")"
check "확장자 아닌 앞 바이트로 판별(jpeg) · 이전 icon.png 지움" '[ "$(basename "$(echo "$R" | field iconPath)")" = icon.jpg ] && [ ! -e pack/assets/icon.png ]' "$R"
R="$(A pack set-icon "$IMG/c.webp" --id globex)"
check "--id globex → globex 팩에 webp · acme 는 그대로" '[ "$(echo "$R" | field id)" = globex ] && [ -f "$ATHENA_DATA_DIR/packs/globex/pack/assets/icon.webp" ] && [ -f pack/assets/icon.jpg ]' "$R"
check "GIF → invalid-image" '[ "$(A pack set-icon "$IMG/d.gif" | field error)" = invalid-image ]'
check "SVG → invalid-image" '[ "$(A pack set-icon "$IMG/e.svg" | field error)" = invalid-image ]'
check "이미지 아닌 .png → invalid-image" '[ "$(A pack set-icon "$IMG/f.png" | field error)" = invalid-image ]'
check "1MB 넘음 → image-too-large · 기존 아이콘 그대로" '[ "$(A pack set-icon "$IMG/big.png" | field error)" = image-too-large ] && [ -f pack/assets/icon.jpg ]'
check "없는 팩 --id → not-found" '[ "$(A pack set-name x --id nope | field error)" = not-found ]'
# 레포별 자동 머지 설정(docs/pr-auto.md "켜기") — 그 레포 항목의 두 키만 글자로 고친다
cp pack/pack.json "$WORK/pack.merge.bak"
R="$(A pack set-auto-merge acme-web --auto on --confirm off)"
check "set-auto-merge on · confirm off → autoMerge true · autoMergeConfirm false(불리언)" '[ "$(echo "$R" | field autoMerge)" = True ] && [ "$(echo "$R" | field autoMergeConfirm)" = False ] && [ "$(python3 -c "import json; r=[x for x in json.load(open(\"pack/pack.json\"))[\"repos\"] if x[\"name\"]==\"acme-web\"][0]; print(r[\"autoMerge\"] is True, r[\"autoMergeConfirm\"] is False)")" = "True True" ]' "$R"
check "다른 레포 · 다른 키는 그대로" '[ "$(python3 -c "import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(\"pack/pack.json\")); [r.pop(k,None) for r in b[\"repos\"] for k in (\"autoMerge\",\"autoMergeConfirm\")]; print(a==b)" "$WORK/pack.merge.bak")" = True ]'
A pack set-auto-merge acme-web --auto off --confirm on >/dev/null
check "끄고 묻기로 → 두 키 지움 · 파일이 처음과 글자까지 같다" 'cmp -s pack/pack.json "$WORK/pack.merge.bak"'
R="$(A pack set-auto-merge acme-web --auto on --review off --merge auto)"
check "--review off · --merge auto → autoReview false · autoMergeConfirm false · mergeMode auto" '[ "$(echo "$R" | field autoReview)" = False ] && [ "$(echo "$R" | field mergeMode)" = auto ] && [ "$(echo "$R" | field autoMergeConfirm)" = False ]' "$R"
R="$(A pack set-auto-merge acme-web --merge manual)"
check "--merge manual → autoMergeManual true · autoMergeConfirm 지움" '[ "$(echo "$R" | field mergeMode)" = manual ] && python3 -c "import json,sys; r=[x for x in json.load(open(\"pack/pack.json\"))[\"repos\"] if x[\"name\"]==\"acme-web\"][0]; sys.exit(0 if r[\"autoMergeManual\"] is True and \"autoMergeConfirm\" not in r else 1)"' "$R"
check "--merge 이상한 값 · --merge 와 --confirm 같이 → 사용법 오류(종료 2)" 'node scripts/athena.mjs pack set-auto-merge acme-web --merge later --json >/dev/null 2>&1; [ $? -eq 2 ] && { node scripts/athena.mjs pack set-auto-merge acme-web --merge auto --confirm on --json >/dev/null 2>&1; [ $? -eq 2 ]; }'
# PR 끔(바로 머지) — --auto direct 는 autoMerge true + autoPr false · --auto off 는 옛 뜻 그대로(두 키 지움) · --auto on 은 autoPr 키를 지움
# 앞에서 --review off · --merge manual 로 남은 설정이 있어 처음 모양과 비교하기 전에 먼저 되돌린다
A pack set-auto-merge acme-web --auto off --review on --merge confirm >/dev/null
check "--auto off → 옛 뜻 그대로: autoMerge · autoPr 모두 지움(자동 흐름 없음) · 파일이 처음과 글자까지 같다" 'cmp -s pack/pack.json "$WORK/pack.merge.bak"'
R="$(A pack set-auto-merge acme-web --auto direct)"
check "--auto direct → autoMerge true · autoPr false(불리언) · 결과 autoPr false" '[ "$(echo "$R" | field autoPr)" = False ] && [ "$(python3 -c "import json; r=[x for x in json.load(open(\"pack/pack.json\"))[\"repos\"] if x[\"name\"]==\"acme-web\"][0]; print(r[\"autoMerge\"] is True, r[\"autoPr\"] is False)")" = "True True" ]' "$R"
R="$(A pack set-auto-merge acme-web --auto on)"
check "--auto on → autoPr 키를 지운다(PR 켬)" '[ "$(echo "$R" | field autoPr)" = True ] && [ "$(python3 -c "import json; r=[x for x in json.load(open(\"pack/pack.json\"))[\"repos\"] if x[\"name\"]==\"acme-web\"][0]; print(r[\"autoMerge\"] is True, \"autoPr\" in r)")" = "True False" ]' "$R"
A pack set-auto-merge acme-web --auto direct >/dev/null
A pack set-auto-merge acme-web --auto off >/dev/null
check "direct 다음 off → autoMerge · autoPr 모두 지움 · 파일이 처음과 글자까지 같다" 'cmp -s pack/pack.json "$WORK/pack.merge.bak"'
A pack set-auto-merge acme-web --auto on --review on --merge confirm >/dev/null
A pack set-auto-merge acme-web --auto off --review on --merge confirm >/dev/null
check "모두 되돌리면 파일이 처음과 글자까지 같다" 'cmp -s pack/pack.json "$WORK/pack.merge.bak"'
check "없는 레포 → not-found" '[ "$(A pack set-auto-merge nope --auto on | field error)" = not-found ]'
check "on|off|direct 아닌 값 → 사용법 오류(종료 2)" 'node scripts/athena.mjs pack set-auto-merge acme-web --auto yes --json >/dev/null 2>&1; [ $? -eq 2 ]'
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['repos'][1]['direct']=True; json.dump(d, open(p,'w'), indent=2)" pack/pack.json
check "main 직접 레포 → not-applicable" '[ "$(A pack set-auto-merge acme-api --auto on | field error)" = not-applicable ]'
cp "$WORK/pack.merge.bak" pack/pack.json
A pack set-name "Acme 팀" >/dev/null
R="$(A pack open acme)"
check "open 응답에 displayName · iconPath" '[ "$(echo "$R" | field displayName)" = "Acme 팀" ] && [ "$(basename "$(echo "$R" | field iconPath)")" = icon.jpg ]' "$R"
R="$(A pack export --out "$O")"; EXPORT2="$(echo "$R" | field file)"
check "내보내기에 assets/icon.jpg 포함" 'tar -tzf "$EXPORT2" | grep -q "/assets/icon.jpg"' "$R"
R="$(A pack backup --with-work --out "$O")"
check "내 백업에 assets/ 포함" 'tar -tzf "$(echo "$R" | field file)" | grep -q "/pack/assets/icon.jpg"' "$R"
R="$(A pack inspect "$EXPORT2")"
check "아이콘 든 팩 가져오기 검사 통과(같은 팩 conflict)" '[ "$(echo "$R" | field ok)" = True ] && [ "$(echo "$R" | field conflict.reason)" = packId ]' "$R"
A pack import "$(echo "$R" | field token)" --keep >/dev/null
TMP_BEFORE="$(ls "$ATHENA_DATA_DIR/tmp" 2>/dev/null | sort | tr "\n" " ")"
mkdir -p "$O/iconout" && cp -R "$F/packs/globex/." "$O/iconout/" && python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['icon']='../../../etc/hosts'; json.dump(d, open(p,'w'))" "$O/iconout/pack.json"
check "나쁜 팩: icon 이 밖 경로 → invalid-pack" '[ "$(A pack inspect "$O/iconout" | field error)" = invalid-pack ]'
mkdir -p "$O/icongif/assets" && cp -R "$F/packs/globex/." "$O/icongif/" && cp "$IMG/d.gif" "$O/icongif/assets/icon.png"
check "나쁜 팩: assets 안 GIF → invalid-image" '[ "$(A pack inspect "$O/icongif" | field error)" = invalid-image ]'
mkdir -p "$O/iconlink/assets" && cp -R "$F/packs/globex/." "$O/iconlink/" && ln -s ../pack.json "$O/iconlink/assets/icon.png"
check "나쁜 팩: assets 안 링크 → unsafe" '[ "$(A pack inspect "$O/iconlink" | field error)" = unsafe ]'
check "아이콘 나쁜 팩 뒤 새 임시본 없음" '[ "$(ls "$ATHENA_DATA_DIR/tmp" 2>/dev/null | sort | tr "\n" " ")" = "$TMP_BEFORE" ]'
R="$(A pack set-icon --clear)"
check "set-icon --clear → iconPath null · assets 지움" '[ "$(echo "$R" | field iconPath)" = "" ] && [ ! -e pack/assets ] && ! grep -q "\"icon\"" pack/pack.json' "$R"
mkdir -p "$WORK/outside"; ln -s "$WORK/outside" pack/assets
check "assets 가 링크면 set-icon → unsafe · 밖에 안 씀(git 으로 받은 팩)" '[ "$(A pack set-icon "$IMG/a.png" | field error)" = unsafe ] && [ -z "$(ls -A "$WORK/outside")" ] && ! grep -q "\"icon\"" pack/pack.json'
rm pack/assets

section "레포 표시 이름 · 아이콘(팩과 같은 규칙 · assets/repos/<레포>.*) · 내보내기 · 백업 왕복"
# rj <레포> <키> — pack.json 그 레포 항목의 값(없으면 빈 줄)
rj() { python3 -c 'import json,sys; r=[x for x in json.load(open("pack/pack.json"))["repos"] if x.get("name")==sys.argv[1]]; v=r[0].get(sys.argv[2]) if r else None; print("" if v is None else v)' "$1" "$2"; }
cp pack/pack.json "$WORK/pack.repolook.bak"
R="$(A pack set-repo-name acme-web "쇼핑 웹")"
check "set-repo-name → 그 레포 displayName · 레포 name 그대로" '[ "$(echo "$R" | field displayName)" = "쇼핑 웹" ] && [ "$(echo "$R" | field repo)" = acme-web ] && [ "$(rj acme-web displayName)" = "쇼핑 웹" ] && [ -L repos/acme-web ]' "$R"
check "레포 이름도 41자 · 줄바꿈 → invalid-name" '[ "$(A pack set-repo-name acme-web "$(printf "가%.0s" $(seq 41))" | field error)" = invalid-name ] && [ "$(A pack set-repo-name acme-web "$(printf "a\nb")" | field error)" = invalid-name ]'
cp pack/pack.json "$WORK/pack.dot.bak"
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['repos'].append({'name': '.dot-repo'}); json.dump(d, open(p,'w'), indent=2)" pack/pack.json
check "표시 이름은 레포 이름 규칙 밖(.dot-repo)에도 · 아이콘만 not-found" '[ "$(A pack set-repo-name .dot-repo "점 레포" | field displayName)" = "점 레포" ] && [ "$(A pack set-repo-icon .dot-repo "$IMG/a.png" | field error)" = not-found ] && [ ! -e pack/assets/repos ]'
cp "$WORK/pack.dot.bak" pack/pack.json
check "없는 레포 · 경로 같은 이름 → not-found" '[ "$(A pack set-repo-name nope x | field error)" = not-found ] && [ "$(A pack set-repo-icon ../x "$IMG/a.png" | field error)" = not-found ] && [ ! -e x.png ]'
check "이름 없이 → 사용법 오류(종료 2)" 'node scripts/athena.mjs pack set-repo-name acme-web --json >/dev/null 2>&1; [ $? -eq 2 ]'
R="$(A pack set-repo-icon acme-web "$IMG/a.png")"
check "set-repo-icon png → assets/repos/acme-web.png · 그 레포 icon" '[ "$(echo "$R" | field iconPath)" = "$ATHENA_DATA_DIR/packs/acme/pack/assets/repos/acme-web.png" ] && [ "$(rj acme-web icon)" = assets/repos/acme-web.png ]' "$R"
R="$(A pack set-repo-icon acme-web "$IMG/b-really-jpeg.png")"
check "다시 고르면 앞 바이트로(jpeg) · 이전 png 지움" '[ "$(basename "$(echo "$R" | field iconPath)")" = acme-web.jpg ] && [ ! -e pack/assets/repos/acme-web.png ] && [ "$(rj acme-web icon)" = assets/repos/acme-web.jpg ]' "$R"
check "GIF · SVG → invalid-image · 1MB 넘음 → image-too-large · 기존 그대로" '[ "$(A pack set-repo-icon acme-web "$IMG/d.gif" | field error)" = invalid-image ] && [ "$(A pack set-repo-icon acme-web "$IMG/e.svg" | field error)" = invalid-image ] && [ "$(A pack set-repo-icon acme-web "$IMG/big.png" | field error)" = image-too-large ] && [ -f pack/assets/repos/acme-web.jpg ]'
check "다른 레포 · 다른 키는 그대로" '[ "$(python3 -c "import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(\"pack/pack.json\")); [r.pop(k,None) for r in b[\"repos\"] for k in (\"displayName\",\"icon\")]; print(a==b)" "$WORK/pack.repolook.bak")" = True ]'
# 왕복 — 내보내기 · 내 백업에 실리고, 지운 뒤 가져오면 이름 · 아이콘이 되살아난다
R="$(A pack export --out "$O")"; EXPORT3="$(echo "$R" | field file)"
check "내보내기에 레포 아이콘 · displayName" 'tar -tzf "$EXPORT3" | grep -q "/assets/repos/acme-web.jpg" && tar -xzOf "$EXPORT3" acme/pack.json | grep -q "쇼핑 웹"' "$R"
R="$(A pack backup --with-work --out "$O")"; WB3="$(echo "$R" | field file)"
check "내 백업에 레포 아이콘" 'tar -tzf "$WB3" | grep -q "/pack/assets/repos/acme-web.jpg"' "$R"
A pack set-repo-name acme-web --clear >/dev/null; R="$(A pack set-repo-icon acme-web --clear)"
check "--clear → 이름 · 아이콘 키 · 파일 · 빈 assets 지움 · 파일이 처음과 글자까지 같다" '[ "$(echo "$R" | field iconPath)" = "" ] && [ ! -e pack/assets ] && cmp -s pack/pack.json "$WORK/pack.repolook.bak"' "$R"
R="$(A pack inspect "$EXPORT3")"; R="$(A pack import "$(echo "$R" | field token)" --replace)"
check "내보내기 → 가져오기(--replace) → 레포 이름 · 아이콘 되살아남" '[ "$(echo "$R" | field ok)" = True ] && [ "$(rj acme-web displayName)" = "쇼핑 웹" ] && [ "$(rj acme-web icon)" = assets/repos/acme-web.jpg ] && cmp -s pack/assets/repos/acme-web.jpg "$IMG/b-really-jpeg.png"' "$R"
A pack set-repo-name acme-web --clear >/dev/null; A pack set-repo-icon acme-web --clear >/dev/null
R="$(A pack inspect "$WB3")"; R="$(A pack import "$(echo "$R" | field token)" --replace)"
check "내 백업 → 되살리기(--replace) → 레포 이름 · 아이콘 되살아남" '[ "$(echo "$R" | field ok)" = True ] && [ "$(rj acme-web displayName)" = "쇼핑 웹" ] && cmp -s pack/assets/repos/acme-web.jpg "$IMG/b-really-jpeg.png"' "$R"
# 가져오기 검사 — 레포 icon 은 그 레포 자리만
mkdir -p "$O/repoiconout" && cp -R "$F/packs/globex/." "$O/repoiconout/" && python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['repos'][0]['icon']='../../../etc/hosts'; json.dump(d, open(p,'w'))" "$O/repoiconout/pack.json"
check "나쁜 팩: 레포 icon 이 밖 경로 → invalid-pack" '[ "$(A pack inspect "$O/repoiconout" | field error)" = invalid-pack ]'
mkdir -p "$O/repoicongif/assets/repos" && cp -R "$F/packs/globex/." "$O/repoicongif/" && cp "$IMG/d.gif" "$O/repoicongif/assets/repos/x.png"
check "나쁜 팩: assets/repos 안 GIF → invalid-image" '[ "$(A pack inspect "$O/repoicongif" | field error)" = invalid-image ]'
A pack set-repo-name acme-web --clear >/dev/null; A pack set-repo-icon acme-web --clear >/dev/null
mkdir -p "$WORK/outside2" pack/assets; ln -s "$WORK/outside2" pack/assets/repos
check "assets/repos 가 링크면 set-repo-icon → unsafe · 밖에 안 씀" '[ "$(A pack set-repo-icon acme-web "$IMG/a.png" | field error)" = unsafe ] && [ -z "$(ls -A "$WORK/outside2")" ] && [ -z "$(rj acme-web icon)" ]'
rm -rf pack/assets
cp "$WORK/pack.repolook.bak" pack/pack.json

section "옛 아테나 가져오기 · 옮기기"
OA="$WORK/oldathena"; mkdir -p "$OA/packs/umbrella" "$OA/plans/task" "$OA/issues"
cp -R "$F/packs/acme/." "$OA/packs/umbrella/"; python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop('id'); d['name']='Umbrella'; json.dump(d, open(p,'w'))" "$OA/packs/umbrella/pack.json"
printf '{ "pack": "packs/umbrella", "reposRoot": "..", "screen": "studio" }\n' > "$OA/athena.config.json"
printf '# 옛 계획\n' > "$OA/plans/task/20261001-old.md"; printf '# 옛 이슈\n' > "$OA/issues/20261001-old.md"; printf 'x\n' > "$OA/issues/README.md"
git init -q "$OA/packs/umbrella"   # 내 옛 아테나의 팩이 git 레포면 .git 을 그대로 가져온다
BEFORE="$(cd "$OA" && find . -type f | sort | xargs shasum | shasum)"
R="$(A pack import-athena "$OA")"
check "import-athena → 계획서 1 · 이슈 1 · .git 남김" '[ -d "$ATHENA_DATA_DIR/tmp/$(echo "$R" | field token)/pack/.git" ] && [ -z "$(echo "$R" | field gitRemoved)" ] && [ "$(echo "$R" | field work.plans)" = 1 ] && [ "$(echo "$R" | field work.issues)" = 1 ]' "$R"
R="$(A pack import "$(echo "$R" | field token)" --new)"
check "id 를 써 넣었으면 packJsonUpdated" '[ -n "$(echo "$R" | field packJsonUpdated.id)" ]' "$R"
check "등록 · 원본 그대로" '[ "$(echo "$R" | field imported.id)" = umbrella ] && [ "$BEFORE" = "$(cd "$OA" && find . -type f | sort | xargs shasum | shasum)" ]' "$R"
L="$WORK/legacy"; mkbody "$L"; mkdir -p "$L/packs/demo" "$L/plans/task" "$L/issues"; cp -R "$F/packs/globex/." "$L/packs/demo/"
printf '{ "pack": "packs/demo", "reposRoot": "..", "screen": "studio" }\n' > "$L/athena.config.json"; printf '# 계획\n' > "$L/plans/task/20261001-a.md"; printf '# 이슈\n' > "$L/issues/20261001-a.md"
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
check "/api/state.pack 에 bodyId · core · instance" '[ -n "$(echo "$STATE" | field pack.bodyId)" ] && [ -n "$(echo "$STATE" | field pack.instance)" ]'
GEN() { python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); e=d['packs'][sys.argv[2]]; e['generation']=e.get('generation',0)+int(sys.argv[3]); json.dump(d, open(p,'w'))" "$ATHENA_DATA_DIR/config.json" "$1" "$2"; }
GEN globex 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${HDR[@]}" -d '{"id":"x","column":"done"}' "http://127.0.0.1:$PORT/api/move")"
check "다른 팩 세대가 바뀌어도 409 아님" '[ "$CODE" != 409 ]' "$CODE"
GEN acme 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${HDR[@]}" -d '{"id":"x","column":"done"}' "http://127.0.0.1:$PORT/api/move")"
check "이 팩 세대가 다르면 쓰기 409" '[ "$CODE" = 409 ]' "$CODE"
GEN acme -1
check "같은 팩이면 board.sh 가 다시 안 띄움" 'bash scripts/board.sh 2>&1 | grep -q "이미 떠 있음"'
R="$(A pack use acme --contract 3 --start-board)"
check "pack use --start-board → 이 본체 현황판(포트 $PORT)" '[ "$(echo "$R" | field boardStarted)" = "$PORT" ] && [ "$(curl -s "http://127.0.0.1:$PORT/api/state" | field pack.id)" = acme ]' "$R"
check "ATHENA_BOARD_PORT 가 있어도 레지스트리 포트" '[ "$(ATHENA_BOARD_PORT=4999 node scripts/athena.mjs pack status --json | tail -1 | field boardPort)" = "$PORT" ]'
TOKEN="$(A pack board-token | field token)"; HDR=(-H "Origin: http://localhost:$PORT" -H "x-board-token: $TOKEN" -H "content-type: application/json")
check "POST /api/shutdown → 꺼짐 · 토큰 파일 지움" '[ "$(curl -s -X POST "${HDR[@]}" -d "{}" "http://127.0.0.1:$PORT/api/shutdown" | field ok)" = True ] && sleep 0.5 && [ "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/state")" = 000 ] && [ ! -f "$ATHENA_DATA_DIR/packs/acme/state/board-token" ]'

section "팩 지우기(pack delete)"
check "지금 본체의 팩은 여기서 못 지움 → unsafe" '[ "$(A pack delete acme | field error)" = unsafe ] && [ -d "$ATHENA_DATA_DIR/packs/acme" ]'
mkdir -p "$ATHENA_DATA_DIR/packs/globex/plans/task" && printf '# 글로벡스 계획\n' > "$ATHENA_DATA_DIR/packs/globex/plans/task/20261023-g.md"
R="$(A pack delete globex)"
check "globex 지움 → 백업(팩 + 계획서) · 자리 · 레지스트리에서 빠짐" '[ "$(echo "$R" | field ok)" = True ] && tar -tzf "$(echo "$R" | field backup)" | grep -q "globex/plans/task/20261023-g.md" && [ ! -d "$ATHENA_DATA_DIR/packs/globex" ] && ! grep -q "\"globex\"" "$ATHENA_DATA_DIR/config.json"' "$R"
check "지운 팩 백업은 다시 가져올 수 있다(inspect)" '[ "$(A pack inspect "$(echo "$R" | field backup)" | field ok)" = True ]'
check "없는 팩 → not-found" '[ "$(A pack delete globex | field error)" = not-found ]'

printf '\n통과 %d · 실패 %d%s\n' "$PASS" "$FAIL" "$([ "${KEEP:-}" = 1 ] && echo " · 임시 폴더 $WORK")"
[ "$FAIL" = 0 ]
