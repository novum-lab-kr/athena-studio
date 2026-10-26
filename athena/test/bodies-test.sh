#!/usr/bin/env bash
# 팩마다 본체 시험 — 임시 저장소(bare 원격 + 주 본체 클론 + 같은 저장소의 워크트리 본체)에서 bin/athena 를 끝까지 돌린다.
# 진짜 스튜디오 집(~/.athena-studio)은 건드리지 않는다
# (git worktree·update 는 임시 클론에만 · 데이터는 ATHENA_DATA_DIR 임시 폴더 · 끝나면 지운다).
#
# 사용: test/bodies-test.sh          → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#       KEEP=1 test/bodies-test.sh   → 임시 폴더를 남긴다
#
# 보는 것: pack open 으로 본체 둘(acme = 주 본체 · globex = 워크트리 본체) · 각자 팩만 봄 · 포트 · 동시 열기 · 실패하면 지움 ·
# 자리 충돌 · pack new/discard · list(body·busy·updatePending) · 한 본체가 일해도 다른 본체 열기·busy 는 비어 있음 ·
# 무거운 명령 잠금은 쥔 본체만 · import --replace 는 그 팩 본체 기준(C1) · 경로 검증표(C11) · version ·
# update(일하는 세션이 있어도 올림 · 팩 잠금은 건너뜀 · 주 본체 ff · dirty·diverged) · --rollback(실행 ID 단위) · 링크 실패면 그 본체만 되돌림 ·
# 열 때 따라잡기 · update --panes-state(쉬는 pane 의 세션은 working 에서 뺌) · 도는 commit.sh · ship.sh · 무거운 명령은 잠깐 기다림 ·
# 학습 검토 · QA 는 끄고 올림(일이 남았으면 새 코드로 다시) · 데이터 형식이 바뀌는 업데이트는 모두 비었을 때만
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bodies-test.XXXXXX")" && pwd -P)"
cleanup() { kill $(jobs -p) 2>/dev/null; pkill -f "$WORK/" 2>/dev/null; rm -rf "$WORK"; }
[ "${KEEP:-}" = 1 ] || trap cleanup EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✔ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✖ %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2" | head -c 900 && echo; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
section() { printf '\n%s\n' "$1"; }
unset ATHENA_AGENT ATHENA_STUDIO ATHENA_BOARD_PORT ATHENA_PACK_FAIL_AT ATHENA_CONTRACT ATHENA_RELINK_FAIL_AT
export ATHENA_SCREEN=none ATHENA_BOARD_NO_BROWSER=1 ATHENA_DATA_DIR="$WORK/test-data" ATHENA_HEAVY_LOCK="$WORK/heavy.lock"
export GIT_AUTHOR_NAME=athena-test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=athena-test GIT_COMMITTER_EMAIL=test@example.invalid
PORT_A=47720

# ── 임시 저장소 — 원격(bare) · 주 본체(클론 · main) · 개발용 클론(새 커밋을 올린다) ─────────────
# 주 본체에 지금 작업 트리를 덮어 커밋하고 원격 main 에 올린다 → 원격 main = 배포 커밋 = 이 작업 트리 코드
ORIGIN="$WORK/origin.git"; MAIN="$WORK/athena"; DEV="$WORK/dev"
git clone -q --bare "$SRC" "$ORIGIN" 2>/dev/null || git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$MAIN" 2>/dev/null; git -C "$MAIN" checkout -q -B main 2>/dev/null
# 코어 파일만 — git 이 보는 목록(추적 + 무시 안 된 미추적). 무시 목록의 팩 링크·로컬 산출물은 옮기지 않는다
(cd "$SRC" && git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do [ -e "$file" ] || [ -L "$file" ] && printf '%s\0' "$file"; done) > "$WORK/files.list"
git -C "$MAIN" rm -rq --cached . >/dev/null 2>&1; (cd "$MAIN" && git ls-files -z | xargs -0 rm -f 2>/dev/null; true)
rsync -a --from0 --files-from="$WORK/files.list" "$SRC/" "$MAIN/"
git -C "$MAIN" add -A >/dev/null 2>&1; git -C "$MAIN" commit -qm "test: 작업 트리" >/dev/null 2>&1; git -C "$MAIN" push -q origin main 2>/dev/null
git -C "$MAIN" fetch -q origin
C0="$(git -C "$MAIN" rev-parse HEAD)"
check "원격 main = 주 본체 HEAD" '[ "$C0" = "$(git -C "$ORIGIN" rev-parse main)" ]'
git clone -q "$ORIGIN" "$DEV" 2>/dev/null
# newcommit <설명> [<파일> <내용>] — 개발 클론에 커밋을 하나 올린다(원격 main 이 앞으로 간다)
newcommit() { printf '%s\n' "${3:-$1}" >> "$DEV/${2:-docs/bodies-test-note.md}"; git -C "$DEV" add -A >/dev/null; git -C "$DEV" commit -qm "$1"; git -C "$DEV" push -q origin HEAD:main; git -C "$DEV" rev-parse HEAD; }

# bundle — 원격 main 을 git 번들로(스튜디오 앱이 코어를 들고 오는 방식 · update 는 --from <번들> 로만 받는다)
bundle() { rm -f "$WORK/core.bundle"; git -C "$ORIGIN" bundle create "$WORK/core.bundle" main >/dev/null 2>&1; echo "$WORK/core.bundle"; }
J() { (cd "$1" && shift && node scripts/athena.mjs "$@" --json --contract 3 2>/dev/null | tail -1); }
field() { python3 -c 'import json,sys
d=json.loads(sys.stdin.read() or "{}")
for k in sys.argv[1].split("."):
    if isinstance(d, list): d = next((x for x in d if isinstance(x, dict) and x.get("id") == k), None)
    else: d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else (json.dumps(d) if isinstance(d,(dict,list)) else d))' "$1"; }
FAKE="$WORK/fakebin"; mkdir -p "$FAKE"; ln -s "$(command -v node)" "$FAKE/claude"
# 가짜 claude — 출력은 버린다($(...) 가 끝나길 기다리지 않게)
# fake_claude <폴더> [인자…] — 인자는 ps 에 보이게 그대로 붙인다(레포 메인 체크아웃은 --agent 가 있어야 일로 센다 · 결정 D1)
fake_claude() { local dir="$1"; shift; (cd "$dir" && exec "$FAKE/claude" -e 'setTimeout(() => {}, 120000)' -- "$@") >/dev/null 2>&1 & echo $!; }

section "주 본체 — test-setup(acme)"
printf '{ "boardPort": %s }\n' "$PORT_A" > "$MAIN/athena.config.json"
R="$(J "$MAIN" pack test-setup)"
check "acme 가 주 본체 팩" '[ "$(echo "$R" | field current.id)" = acme ]' "$R"
check "주 본체는 깨끗(추적 파일 변경 없음)" '[ -z "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ]' "$(git -C "$MAIN" status --porcelain --untracked-files=no)"

section "pack open — 워크트리 본체 만들기"
BODY_B="$WORK/athena-globex"
mkdir -p "$BODY_B"
check "자리에 다른 폴더가 있으면 body-conflict(덮지 않음)" '[ "$(J "$MAIN" pack open globex | field error)" = body-conflict ] && [ -d "$BODY_B" ] && [ -z "$(ls -A "$BODY_B")" ]'
rmdir "$BODY_B"
J "$MAIN" pack open globex > "$WORK/open1.json" & P1=$!
J "$MAIN" pack open globex > "$WORK/open2.json" & P2=$!
wait "$P1" "$P2"
R1="$(cat "$WORK/open1.json")"; R2="$(cat "$WORK/open2.json")"
check "동시에 두 번 열어도 본체 하나(하나는 created · 다른 하나는 locked 또는 그대로)" '[ "$(git -C "$MAIN" worktree list | grep -c "athena-globex")" = 1 ] && { [ "$(echo "$R1" | field created)" = True ] || [ "$(echo "$R2" | field created)" = True ]; } && for r in "$R1" "$R2"; do e="$(echo "$r" | field error)"; [ -z "$e" ] || [ "$e" = locked ] || exit 1; done' "$R1 / $R2"
R="$(J "$MAIN" pack open globex)"
check "다시 열면 created false · state ready · 포트 4702" '[ "$(echo "$R" | field created)" = False ] && [ "$(echo "$R" | field state)" = ready ] && [ "$(echo "$R" | field body)" = "$BODY_B" ] && [ "$(echo "$R" | field boardPort)" = 4702 ]' "$R"
check "결과에 bodyId · core · contract · dataDir · generation" '[ -n "$(echo "$R" | field bodyId)" ] && [ "$(echo "$R" | field core)" = "$C0" ] && [ "$(echo "$R" | field contract)" = 3 ] && [ "$(echo "$R" | field dataDir)" = "$ATHENA_DATA_DIR" ] && [ "$(echo "$R" | field generation)" = 1 ]' "$R"
check "본체 B 는 detached · 배포 커밋(origin/main)" '[ "$(git -C "$BODY_B" rev-parse --abbrev-ref HEAD)" = HEAD ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C0" ]'
check "본체 B 설정에 boardPort · dataDir" 'python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d[\"boardPort\"]==4702 and d[\"dataDir\"]==sys.argv[2] else 1)" "$BODY_B/athena.config.json" "$ATHENA_DATA_DIR"'
check "본체 B 가 globex · 주 본체는 acme 그대로" '[ "$(basename "$(readlink "$BODY_B/.pack-data")")" = globex ] && [ "$(basename "$(readlink "$MAIN/.pack-data")")" = acme ]'
check "계획서·이슈·repos 는 각자 팩 것만" 'ls "$MAIN/issues" | grep -q acme && ! ls "$MAIN/issues" | grep -q globex && ls "$BODY_B/issues" | grep -q globex && ! ls "$BODY_B/issues" | grep -q acme && [ "$(ls "$BODY_B/repos" | tr "\n" " ")" = "globex-admin globex-shop " ]'
check "팩 링크도 각자(.claude/agents)" '[ -L "$MAIN/.claude/agents/acme-web-fe.md" ] && [ ! -e "$MAIN/.claude/agents/globex-shop-fe.md" ] && [ -L "$BODY_B/.claude/agents/globex-shop-fe.md" ] && [ ! -e "$BODY_B/.claude/agents/acme-web-fe.md" ]'
isPack() { node --input-type=module -e "import { isPackBody } from '$MAIN/scripts/lib/bodies.mjs'; console.log(isPackBody(process.argv[1]))" "$1"; }
check "팩 본체인가 — 주 본체 false · 본체 B true (일감 [정비] 탭은 주 본체에서만)" '[ "$(isPack "$MAIN")" = false ] && [ "$(isPack "$BODY_B")" = true ]'
check "본체 B 도 깨끗(추적 파일 변경 없음)" '[ -z "$(git -C "$BODY_B" status --porcelain --untracked-files=no)" ]' "$(git -C "$BODY_B" status --porcelain --untracked-files=no)"
EXCL="$(cd "$MAIN" && cd "$(git rev-parse --git-common-dir)" && pwd)/info/exclude"
check "git exclude 는 본체마다 구간(남의 구간을 지우지 않음)" 'grep -q "athena pack links (athena pack link 가 관리) · $MAIN\$" "$EXCL" && grep -q "athena pack links (athena pack link 가 관리) · $BODY_B\$" "$EXCL"'

section "실패하면 만들던 본체를 지움 · pack new · discard"
R="$(cd "$MAIN" && ATHENA_PACK_FAIL_AT=open node scripts/athena.mjs pack new --json --contract 3 2>/dev/null | tail -1)"
check "만들다 실패 → rollback · 본체·자리·워크트리 없음" '[ "$(echo "$R" | field error)" = rollback ] && [ -z "$(ls -d "$WORK"/athena-new-* 2>/dev/null)" ] && [ -z "$(ls "$ATHENA_DATA_DIR/packs" | grep "^new-")" ] && ! git -C "$MAIN" worktree list | grep -q athena-new' "$R"
R="$(J "$MAIN" pack new)"; NEW="$(echo "$R" | field id)"; NEWBODY="$(echo "$R" | field body)"
check "pack new → 빈 자리 + 본체(created · previous=acme)" '[ "$(echo "$R" | field created)" = True ] && [ "$(echo "$R" | field previous)" = acme ] && [ -L "$NEWBODY/.pack-data" ] && [ "$(basename "$(readlink "$NEWBODY/.pack-data")")" = "$NEW" ]' "$R"
check "list: 빈 자리는 emptySlots 에(packs 에는 없음)" '[ "$(J "$MAIN" pack list | field emptySlots | grep -c "$NEW")" = 1 ] && ! J "$MAIN" pack list | field packs | grep -q "$NEW"'
R="$(J "$MAIN" pack open "$NEW")"
check "빈 자리도 open → 그 본체 그대로(다른 팩에서 돌아오기)" '[ "$(echo "$R" | field ok)" = True ] && [ "$(echo "$R" | field body)" = "$NEWBODY" ]' "$R"
check "이 본체에서 자기를 discard → unsafe" '[ "$(J "$NEWBODY" pack discard "$NEW" | field error)" = unsafe ]'
check "팩이 있는 자리 discard → unsafe" '[ "$(J "$MAIN" pack discard globex | field error)" = unsafe ] && [ -d "$BODY_B" ]'
R="$(J "$MAIN" pack discard "$NEW")"
check "discard → 본체·자리·워크트리 등록 지움" '[ "$(echo "$R" | field removedBody)" = "$NEWBODY" ] && [ ! -e "$NEWBODY" ] && [ ! -d "$ATHENA_DATA_DIR/packs/$NEW" ] && ! git -C "$MAIN" worktree list | grep -q "$NEWBODY"' "$R"

section "배포 커밋 — 옛 코어면 거부 · origin/main 없으면 멈춤(리뷰 1차)"
DEPLOY() { python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop('deploy', None) if sys.argv[2]=='-' else d.__setitem__('deploy', {'commit': sys.argv[2]}); json.dump(d, open(p,'w'))" "$ATHENA_DATA_DIR/config.json" "$1"; }
OLD="$(git -C "$MAIN" rev-parse "$C0^" 2>/dev/null)"
if [ -n "$OLD" ]; then
  DEPLOY "$OLD"
  R="$(J "$MAIN" pack new)"
  check "배포 커밋이 팩마다 본체 전 코어 → contract-mismatch · 자리·본체 안 남음" '[ "$(echo "$R" | field error)" = contract-mismatch ] && [ -z "$(ls "$ATHENA_DATA_DIR/packs" | grep "^new-")" ] && [ -z "$(ls -d "$WORK"/athena-new-* 2>/dev/null)" ]' "$R"
  DEPLOY -
fi
git -C "$MAIN" update-ref -d refs/remotes/origin/main
R="$(J "$MAIN" pack new)"
check "deploy·origin/main 없음 → unsafe(주 본체 HEAD 를 쓰지 않음)" '[ "$(echo "$R" | field error)" = unsafe ] && [ -z "$(ls -d "$WORK"/athena-new-* 2>/dev/null)" ]' "$R"
git -C "$MAIN" fetch -q origin

section "pack list · status · version"
R="$(J "$MAIN" pack list)"
check "acme.body = 주 본체 · 포트 $PORT_A · bodyState ready" '[ "$(echo "$R" | field packs.acme.body)" = "$MAIN" ] && [ "$(echo "$R" | field packs.acme.boardPort)" = "$PORT_A" ] && [ "$(echo "$R" | field packs.acme.bodyState)" = ready ]' "$R"
check "globex.body = 워크트리 본체 · 포트 4702 · core" '[ "$(echo "$R" | field packs.globex.body)" = "$BODY_B" ] && [ "$(echo "$R" | field packs.globex.boardPort)" = 4702 ] && [ "$(echo "$R" | field packs.globex.core)" = "$C0" ]' "$R"
check "아무것도 안 돌면 bodyBusy false · busyKnown true" '[ "$(echo "$R" | field packs.acme.bodyBusy)" = False ] && [ "$(echo "$R" | field packs.globex.bodyBusy)" = False ] && [ "$(echo "$R" | field packs.globex.busyKnown)" = True ]' "$R"
R="$(J "$BODY_B" pack list)"
check "본체 B 에서 불러도 같은 body · current 는 globex" '[ "$(echo "$R" | field packs.acme.body)" = "$MAIN" ] && [ "$(echo "$R" | field current.id)" = globex ]' "$R"
check "status.body · boardPort 는 부른 본체" '[ "$(J "$BODY_B" pack status | field body)" = "$BODY_B" ] && [ "$(J "$BODY_B" pack status | field boardPort)" = 4702 ]'
V1="$(J "$MAIN" version)"; V2="$(J "$BODY_B" version)"
check "version — contract 3 · dataFormats · capabilities · core 각 본체" '[ "$(echo "$V1" | field contract)" = 3 ] && [ "$(echo "$V1" | field dataFormats)" = "[1, 1]" ] && echo "$V1" | field capabilities | grep -q update && [ "$(echo "$V2" | field core)" = "$C0" ] && [ "$(echo "$V2" | field body)" = "$BODY_B" ] && [ "$(echo "$V2" | field dirty)" = False ]' "$V1 / $V2"

section "한 본체가 일해도 다른 본체는 열리고 비어 있음"
CB="$(fake_claude "$BODY_B")"; CA="$(fake_claude "$ATHENA_DATA_DIR/repos-src/globex-shop" --agent globex-shop-fe)"; sleep 0.5
check "본체 B busy: athena · agent" 'R="$(J "$BODY_B" pack busy)"; echo "$R" | grep -q "\"kind\":\"athena\"" && echo "$R" | grep -q "\"kind\":\"agent\""'
check "주 본체 busy 는 비어 있음" '[ "$(J "$MAIN" pack busy | field busy)" = "[]" ]'
check "list bodyBusy — globex true · acme false" 'R="$(J "$MAIN" pack list)"; [ "$(echo "$R" | field packs.globex.bodyBusy)" = True ] && [ "$(echo "$R" | field packs.acme.bodyBusy)" = False ]'
check "B 가 일해도 주 본체에서 acme 열기 · B 열기 됨" '[ "$(J "$MAIN" pack open acme | field ok)" = True ] && [ "$(J "$MAIN" pack open globex | field ok)" = True ]'
R="$(J "$MAIN" pack export --out "$WORK/exp")"; R="$(J "$MAIN" pack inspect "$(echo "$R" | field file)")"; TOKEN="$(echo "$R" | field token)"
# acme 를 내보내 globex 로 바꿔치기할 수는 없으니 globex 를 B 에서 내보내 주 본체에서 --replace 한다(그 팩 본체 = B 기준)
R="$(J "$BODY_B" pack export --out "$WORK/exp")"; R="$(J "$MAIN" pack inspect "$(echo "$R" | field file)")"; TOKEN_G="$(echo "$R" | field token)"
J "$MAIN" pack import "$TOKEN" --keep >/dev/null
R="$(J "$MAIN" pack import "$TOKEN_G" --replace)"
check "주 본체에서 globex --replace → B 가 일하면 busy(C1)" '[ "$(echo "$R" | field error)" = busy ] && [ "$(echo "$R" | field body)" = "$BODY_B" ]' "$R"
kill "$CB" "$CA" 2>/dev/null; wait "$CB" "$CA" 2>/dev/null
GEN_BEFORE="$(J "$MAIN" pack list | field packs.globex)"; GEN_BEFORE="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['packs']['globex']['generation'])" "$ATHENA_DATA_DIR/config.json")"
R="$(J "$MAIN" pack import "$TOKEN_G" --replace)"
check "B 가 비면 --replace → B 링크 다시 · globex 세대 +1 · acme 세대 그대로" '[ "$(echo "$R" | field ok)" = True ] && [ "$(echo "$R" | field body)" = "$BODY_B" ] && [ "$(python3 -c "import json,sys; d=json.load(open(sys.argv[1]))[\"packs\"]; print(d[\"globex\"][\"generation\"], d[\"acme\"][\"generation\"])" "$ATHENA_DATA_DIR/config.json")" = "$((GEN_BEFORE+1)) 1" ] && [ -L "$BODY_B/.claude/agents/globex-shop-fe.md" ]' "$R"

section "무거운 명령 잠금 — 잠금에 적힌 본체만(C10)"
mkdir -p "$ATHENA_HEAVY_LOCK"; sleep 60 & H=$!; echo "$H" > "$ATHENA_HEAVY_LOCK/pid"; echo "$BODY_B" > "$ATHENA_HEAVY_LOCK/root"; sleep 0.2
check "본체 B 가 쥔 잠금 → B 만 heavy" 'J "$BODY_B" pack busy | grep -q "\"kind\":\"heavy\"" && ! J "$MAIN" pack busy | grep -q "\"kind\":\"heavy\""'
kill "$H" 2>/dev/null; wait "$H" 2>/dev/null; rm -rf "$ATHENA_HEAVY_LOCK"

section "경로 검증표(C11) — 어디서 불러도 그 본체·그 팩"
mkdir -p "$WORK/pathbin"; ln -s "$BODY_B/bin/athena" "$WORK/pathbin/athena"
check "밖 폴더(/)에서 본체 B 절대 경로로 → B · globex" 'R="$(cd / && node "$BODY_B/scripts/athena.mjs" pack status --json | tail -1)"; [ "$(echo "$R" | field body)" = "$BODY_B" ] && [ "$(echo "$R" | field current.id)" = globex ]'
check "PATH 의 링크(bin/athena → B)로 → B" 'R="$(cd / && PATH="$WORK/pathbin:$PATH" athena pack status --json | tail -1)"; [ "$(echo "$R" | field body)" = "$BODY_B" ]'
check "서비스 레포 폴더에서 → B" 'R="$(cd "$ATHENA_DATA_DIR/repos-src/globex-shop" && node "$BODY_B/scripts/athena.mjs" pack status --json | tail -1)"; [ "$(echo "$R" | field current.id)" = globex ]'
check "파이썬 paths(훅·delegate) → globex · 이 본체 데이터" '[ "$(python3 -c "import sys; sys.path.insert(0, sys.argv[1] + \"/scripts/lib\"); from athena_config import paths; w=paths(sys.argv[1]); print(w[\"packId\"], w[\"plans\"].startswith(sys.argv[1]))" "$BODY_B")" = "globex True" ]'
VOUT="$(bash "$BODY_B/scripts/verify/globex-shop.sh" 2>&1)"
check "팩 링크 검증 스크립트(본체 경로로 부름) → B 의 repos 에서 통과" 'echo "$VOUT" | grep -q "✅ 통과"' "$(echo "$VOUT" | tail -8)"

section "update — 일하는 세션이 있어도 올리고, 팩 작업 잠금은 건너뛴다 · 주 본체는 ff"
check "--from 없이는 usage · 종료 2(원격에서 받는 길 없음)" '(cd "$MAIN" && node scripts/athena.mjs update --json --contract 3 >/dev/null 2>&1); [ $? = 2 ]'
C1="$(newcommit "test: 업데이트 1")"
# 다른 쪽이 globex 팩 작업 잠금을 쥐고 있다(열기 · 바꾸기 중) — 같은 팩 데이터를 두 곳이 동시에 쓰면 깨진다
PLOCK="$ATHENA_DATA_DIR/locks/globex.lock"; mkdir -p "$PLOCK"; sleep 60 & PL=$!; echo "$PL" > "$PLOCK/pid"; echo "pack open globex" > "$PLOCK/what"
R="$(J "$MAIN" update --from "$(bundle)")"; OP1="$(echo "$R" | field operationId)"
check "B 팩이 잠겨 있으면 B 는 skipped(busy · switch) · 주 본체는 ff · status partial" '[ "$(echo "$R" | field status)" = partial ] && [ "$(echo "$R" | field error)" = partial ] && [ "$(echo "$R" | field bodies.globex.reason)" = busy ] && echo "$R" | grep -q "\"kind\":\"switch\"" && [ "$(echo "$R" | field bodies.acme.status)" = updated ] && [ "$(git -C "$MAIN" rev-parse HEAD)" = "$C1" ] && [ "$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)" = main ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C0" ]' "$R"
check "fetched · targetCore · 기록 파일 · 보존 ref" '[ "$(echo "$R" | field targetCore)" = "$C1" ] && [ -f "$ATHENA_DATA_DIR/updates/$OP1.json" ] && [ "$(git -C "$MAIN" rev-parse "refs/athena/rollback/$OP1/acme")" = "$C0" ]' "$R"
check "list: globex updatePending · targetCore" '[ "$(J "$MAIN" pack list | field packs.globex.updatePending)" = True ]'
kill "$PL" 2>/dev/null; wait "$PL" 2>/dev/null; rm -rf "$PLOCK"
R="$(J "$MAIN" pack open globex)"
check "B 가 비면 열 때 따라잡음(updated · boardStopped 포함)" '[ "$(echo "$R" | field updated.to)" = "$C1" ] && [ "$(echo "$R" | field updated.boardStopped)" = "[]" ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C1" ]' "$R"
C2="$(newcommit "test: 업데이트 2")"
CB="$(fake_claude "$BODY_B")"; CA="$(fake_claude "$ATHENA_DATA_DIR/repos-src/globex-shop" --agent globex-shop-fe)"; sleep 0.5
R="$(J "$MAIN" update --from "$(bundle)")"; OP2="$(echo "$R" | field operationId)"
check "B 에서 아테나 · 에이전트가 일해도 바로 올림 · complete · 둘 다 C2" '[ "$(echo "$R" | field status)" = complete ] && [ "$(echo "$R" | field ok)" = True ] && [ "$(git -C "$MAIN" rev-parse HEAD)" = "$C2" ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C2" ]' "$R"
check "B 의 working 에 일하던 세션 2개(athena · agent) · 기록 파일에도" 'W="$(echo "$R" | field bodies.globex.working)"; [ "$(echo "$W" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")" = 2 ] && echo "$W" | grep -q athena && echo "$W" | grep -q agent && grep -q "\"working\"" "$ATHENA_DATA_DIR/updates/$OP2.json"' "$R"
kill "$CB" "$CA" 2>/dev/null; wait "$CB" "$CA" 2>/dev/null
check "B 링크가 새 코드로 다시 맞음(ready)" '[ "$(J "$MAIN" pack list | field packs.globex.bodyState)" = ready ]'
R="$(J "$MAIN" update --from "$(bundle)")"
check "다시 돌리면 same · complete(멱등)" '[ "$(echo "$R" | field status)" = complete ] && [ "$(echo "$R" | field bodies.globex.status)" = same ]' "$R"

section "update --rollback — 그 실행이 바꾼 본체만"
R="$(J "$MAIN" update --rollback "$OP2")"
check "OP2 되돌리기: B 는 C1 로 · 주 본체는 skipped(main)" '[ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C1" ] && [ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(echo "$R" | field bodies.acme.reason)" = main ] && [ "$(echo "$R" | field fetched)" = "" ] && [ "$(git -C "$MAIN" rev-parse HEAD)" = "$C2" ]' "$R"
check "되돌린 뒤 배포 커밋은 OP2 이전(C1)" '[ "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\"deploy\"][\"commit\"])" "$ATHENA_DATA_DIR/config.json")" = "$C1" ]'
R="$(J "$MAIN" update --rollback "$OP2")"
check "같은 실행을 또 되돌리면 B 는 moved(그 실행의 to 에 없음)" '[ "$(echo "$R" | field bodies.globex.reason)" = moved ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C1" ]' "$R"
check "없는 실행 → rollback-unavailable" '[ "$(J "$MAIN" update --rollback upd-nope | field error)" = rollback-unavailable ]'

section "링크 실패면 그 본체만 이전 커밋으로 · dirty · diverged"
C3="$(newcommit "test: 업데이트 3")"
R="$(cd "$MAIN" && ATHENA_RELINK_FAIL_AT="$C3" node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "새 코드 relink 실패 → 둘 다 rolledBack · 커밋 그대로 · status failed" '[ "$(echo "$R" | field status)" = failed ] && [ "$(echo "$R" | field bodies.globex.rolledBack)" = True ] && [ "$(echo "$R" | field bodies.acme.rolledBack)" = True ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C1" ] && [ "$(git -C "$MAIN" rev-parse HEAD)" = "$C2" ] && [ "$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)" = main ]' "$R"
check "모두 실패한 update 는 배포 커밋을 옮기지 않음 · 열어도 따라잡기 안 함" '[ "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\"deploy\"][\"commit\"])" "$ATHENA_DATA_DIR/config.json")" = "$C1" ] && [ -z "$(J "$MAIN" pack open globex | field updated)" ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C1" ]'
OPF="$(echo "$R" | field operationId)"
check "실패한 update 를 지정해 되돌리기 → rollback-unavailable" '[ "$(J "$MAIN" update --rollback "$OPF" | field error)" = rollback-unavailable ]'
R="$(J "$MAIN" update --rollback)"
check "대상 없이 되돌리기 → 실패·바꾼 것 없는 기록은 건너뛰고 OP2(이미 되돌려 moved)" '[ "$(echo "$R" | field rollbackOf)" = "$OP2" ] && [ "$(echo "$R" | field bodies.globex.reason)" = moved ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C1" ]' "$R"
echo "// 로컬 수정" >> "$MAIN/scripts/lib/lock.mjs"
R="$(J "$MAIN" update --from "$(bundle)")"
check "주 본체 추적 파일 미커밋 → skipped(dirty) · B 는 C3" '[ "$(echo "$R" | field bodies.acme.reason)" = dirty ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3" ] && [ "$(echo "$R" | field status)" = partial ]' "$R"
DEPLOY_NOW() { python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('deploy',{}).get('commit',''))" "$ATHENA_DATA_DIR/config.json"; }
R="$(J "$MAIN" update --rollback "$OP2")"
check "옛 실행 되돌리기가 아무것도 못 되돌리면(moved) 배포 커밋 그대로 · 열어도 B 그대로(리뷰 3차)" '[ "$(echo "$R" | field bodies.globex.reason)" = moved ] && [ "$(DEPLOY_NOW)" = "$C3" ] && [ -z "$(J "$MAIN" pack open globex | field updated)" ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3" ]' "$R"
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['deploy']['commit']=sys.argv[2]; json.dump(d, open(p,'w'))" "$ATHENA_DATA_DIR/config.json" "$C1"
check "배포 커밋이 본체보다 옛것이면 열어도 내리지 않음(따라잡기는 앞으로만)" '[ -z "$(J "$MAIN" pack open globex | field updated)" ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3" ]'
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['deploy']['commit']=sys.argv[2]; json.dump(d, open(p,'w'))" "$ATHENA_DATA_DIR/config.json" "$C3"
git -C "$MAIN" checkout -q -- scripts/lib/lock.mjs
echo "로컬 정비" >> "$MAIN/docs/bodies-local.md"; git -C "$MAIN" add docs/bodies-local.md; git -C "$MAIN" commit -qm "test: 로컬 정비 커밋"
LOCAL="$(git -C "$MAIN" rev-parse HEAD)"
R="$(J "$MAIN" update --from "$(bundle)")"
check "주 본체가 갈라짐(로컬 커밋) → skipped(diverged) · 그대로" '[ "$(echo "$R" | field bodies.acme.reason)" = diverged ] && [ "$(git -C "$MAIN" rev-parse HEAD)" = "$LOCAL" ]' "$R"

section "update --panes-state — 입력을 기다리는 pane 의 세션은 working 에서 뺀다(결정 D1)"
C3B="$(newcommit "test: 업데이트 3b")"
# pane 셸 흉내 — sh 가 claude 의 부모(exec 하지 않는다). 그 sh pid 가 데몬 pane pids 의 pane 셸
(cd "$BODY_B" && sh -c '"$1" -e "setTimeout(() => {}, 120000)"; true' sh "$FAKE/claude") >/dev/null 2>&1 & PSH=$!; sleep 0.5
panes_state() { python3 -c 'import json,sys,datetime
at=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=int(sys.argv[3]))).isoformat()
json.dump({"at": at, "panes": [{"id": "p1", "label": "🧭 아테나", "pid": int(sys.argv[1]), "agent": sys.argv[5], "status": sys.argv[2]}]}, open(sys.argv[4], "w"))' "$PSH" "$1" "${2:-0}" "$WORK/panes.json" "${3:-claude}"; echo "$WORK/panes.json"; }
R="$(J "$MAIN" update --from "$(bundle)" --panes-state "$(panes_state working)")"
check "일하는 pane(working) 의 세션 → 그래도 올림 · B 는 C3B · working 에 pane 이름" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3B" ] && echo "$R" | grep -q "\"pane\":\"🧭 아테나\""' "$R"
# 아래는 B 가 이미 C3B — status same 이어도 working 은 남는다
R="$(J "$MAIN" update --from "$(bundle)" --panes-state "$(panes_state idle 600)")"
check "오래된(2분 넘은) 상태 파일 → 버림 · 세션은 working(pane 이름 없음)" '[ "$(echo "$R" | field bodies.globex.status)" = same ] && echo "$R" | grep -q "\"kind\":\"athena\"" && ! echo "$R" | grep -q "\"pane\":"' "$R"
R="$(J "$MAIN" update --from "$(bundle)")"
check "상태 파일 없으면 세션은 working" '[ "$(echo "$R" | field bodies.globex.status)" = same ] && echo "$R" | grep -q "\"kind\":\"athena\""' "$R"
R="$(J "$MAIN" update --from "$(bundle)" --panes-state "$(panes_state idle 0 codex)")"
check "pane 은 idle 이어도 에이전트 종류가 다르면(codex pane 안 claude) → working · paneStatus idle" '[ "$(echo "$R" | field bodies.globex.status)" = same ] && echo "$R" | grep -q "\"paneStatus\":\"idle\""' "$R"
check "pack busy 는 그대로 athena 를 센다(업데이트만 바뀜)" 'J "$BODY_B" pack busy | grep -q "\"kind\":\"athena\""'
R="$(J "$MAIN" update --from "$(bundle)" --panes-state "$(panes_state idle)")"
check "입력을 기다리는 pane(idle) 의 세션 → working 없음" '[ "$(echo "$R" | field bodies.globex.status)" = same ] && [ -z "$(echo "$R" | field bodies.globex.working)" ]' "$R"
check "version capabilities 에 idle-panes · update-busy · repo-look" 'V="$(J "$MAIN" version)"; echo "$V" | grep -q "\"idle-panes\"" && echo "$V" | grep -q "\"update-busy\"" && echo "$V" | grep -q "\"repo-look\""'
pkill -P "$PSH" 2>/dev/null; kill "$PSH" 2>/dev/null; wait "$PSH" 2>/dev/null
# pane 셸 흉내 아래 가짜 claude 가 남으면 뒤 절에서 B 가 계속 일하는 것으로 보인다 — 남김없이 끈다
pkill -f "^$FAKE/claude" 2>/dev/null; sleep 0.3

section "update — 학습 검토는 끄고 올린다(일하는 중이어도) · 일이 남았으면 새 코드로 다시 띄운다"
# 앱 · 일감이 띄우는 것과 같은 모양(절대 경로 · --watch). 대기열은 그 팩 데이터의 state/learn-queue
LEARN_Q="$ATHENA_DATA_DIR/packs/globex/state/learn-queue"
watcher() { (cd "$BODY_B" && exec node "$BODY_B/scripts/learn-review.mjs" --watch) >/dev/null 2>&1 & LW=$!; for _ in $(seq 1 50); do [ -f "$LEARN_Q/.watcher.lock/pid" ] && break; sleep 0.1; done; }
lock_pid() { cat "$LEARN_Q/.watcher.lock/pid" 2>/dev/null; }
C3C="$(newcommit "test: 업데이트 3c")"
watcher
# 검토 중인 일 — 다른 체크아웃의 일이라 새 감시자는 claude 를 부르지 않고 실패로 남긴다
echo '{"plan":"plans/x.md","head":"x","root":"/nonexistent-checkout","attempts":0}' > "$LEARN_Q/0-test.json.working"
R="$(J "$MAIN" update --from "$(bundle)")"
for _ in $(seq 1 50); do [ -n "$(lock_pid)" ] && [ "$(lock_pid)" != "$LW" ] && break; sleep 0.1; done
check "검토 중인 감시자 → 끄고 올림 · B 는 C3C · learnStopped · 일이 남아 새 감시자가 뜸(learnKicked)" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3C" ] && ! kill -0 "$LW" 2>/dev/null && [ "$(echo "$R" | field bodies.globex.services.learnStopped)" = "[$LW]" ] && [ "$(echo "$R" | field bodies.globex.services.learnKicked)" = True ] && [ -n "$(lock_pid)" ] && [ "$(lock_pid)" != "$LW" ] && kill -0 "$(lock_pid)" 2>/dev/null' "$R"
NEWW="$(lock_pid)"; kill "$NEWW" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$NEWW" 2>/dev/null || break; sleep 0.1; done
rm -rf "$LEARN_Q"/*.json "$LEARN_Q"/*.json.working "$LEARN_Q/failed"
C3D="$(newcommit "test: 업데이트 3d")"
LP="$(node -e 'setTimeout(() => {}, 120000)' "$BODY_B/scripts/learn-review.mjs" --plan plans/x.md >/dev/null 2>&1 & echo $!)"; sleep 0.3
R="$(J "$MAIN" update --from "$(bundle)")"
check "한 번 검토(--plan) 도는 중 → 끄고 올림 · 대기열이 비어 감시자는 안 띄움" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3D" ] && ! kill -0 "$LP" 2>/dev/null && ! { [ -n "$(lock_pid)" ] && kill -0 "$(lock_pid)" 2>/dev/null; }' "$R"
check "pack busy 는 그대로 학습 검토를 센다(업데이트만 바뀜)" 'watcher; J "$BODY_B" pack busy | grep -q "\"kind\":\"learn-review\""'
C3E="$(newcommit "test: 업데이트 3e")"
R="$(J "$MAIN" update --from "$(bundle)")"
check "빈 대기열만 기다리는 감시자 → 끄고 올림 · 다시 띄우지 않음" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3E" ] && ! kill -0 "$LW" 2>/dev/null && ! { [ -n "$(lock_pid)" ] && kill -0 "$(lock_pid)" 2>/dev/null; }' "$R"
kill "$LW" 2>/dev/null; wait "$LW" 2>/dev/null
# 새 코드 relink 가 실패해 이전 커밋으로 되돌려도 — 꺼 둔 학습 검토는 그때 본체 코드로 다시 뜬다(꺼진 채 남지 않게 · 자동 리뷰 1차)
C3E2="$(newcommit "test: 업데이트 3e2")"
watcher
echo '{"plan":"plans/x.md","head":"y","root":"/nonexistent-checkout","attempts":0}' > "$LEARN_Q/0-fail.json"
R="$(cd "$MAIN" && ATHENA_RELINK_FAIL_AT="$C3E2" node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
for _ in $(seq 1 50); do [ -n "$(lock_pid)" ] && [ "$(lock_pid)" != "$LW" ] && break; sleep 0.1; done
check "relink 실패로 되돌림(rolledBack) → 학습 검토는 다시 뜸(learnKicked) · B 는 C3E" '[ "$(echo "$R" | field bodies.globex.error)" = verify-failed ] && [ "$(echo "$R" | field bodies.globex.rolledBack)" = True ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3E" ] && [ "$(echo "$R" | field bodies.globex.services.learnKicked)" = True ] && ! kill -0 "$LW" 2>/dev/null && [ -n "$(lock_pid)" ] && [ "$(lock_pid)" != "$LW" ] && kill -0 "$(lock_pid)" 2>/dev/null' "$R"
NEWW="$(lock_pid)"; kill "$NEWW" 2>/dev/null; for _ in $(seq 1 30); do kill -0 "$NEWW" 2>/dev/null || break; sleep 0.1; done
rm -rf "$LEARN_Q"/*.json "$LEARN_Q"/*.json.working "$LEARN_Q/failed"

section "update — 도는 커밋 · 올리기(commit.sh · ship.sh) · 무거운 명령은 잠깐 기다린 뒤 올린다"
# 셸 흉내 — 인자에 그 본체 스크립트 경로가 보이는 bash(명령이 하나면 bash 가 exec 해 버리니 ; true 를 붙인다)
fake_script() { local dir="$1" secs="$2" script="$3"; (cd "$dir" && exec bash -c "sleep $secs; true" "$script") >/dev/null 2>&1 & echo $!; }
C3F="$(newcommit "test: 업데이트 3f")"
FS="$(fake_script "$WORK" 2 "$BODY_B/scripts/commit.sh")"; sleep 0.3
START=$(date +%s)
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=15000 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "곧 끝나는 커밋(절대 경로) → 끝날 때까지 기다린 뒤 올림 · B 는 C3F" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3F" ] && [ $(( $(date +%s) - START )) -ge 1 ]' "$R"
wait "$FS" 2>/dev/null
C3G="$(newcommit "test: 업데이트 3g")"
FS="$(fake_script "$BODY_B" 60 scripts/ship.sh)"; sleep 0.3
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=1500 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "상한까지 안 끝나는 올리기(상대 경로 · 본체 안) → skipped(busy · commit) · B 그대로" '[ "$(echo "$R" | field bodies.globex.reason)" = busy ] && echo "$R" | grep -q "\"kind\":\"commit\"" && echo "$R" | grep -q "ship.sh" && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3F" ]' "$R"
kill "$FS" 2>/dev/null; wait "$FS" 2>/dev/null
# scripts 폴더 안에서 bash commit.sh — 작업 폴더 기준으로 풀면 이 본체 스크립트(자동 리뷰 1차)
FS="$(fake_script "$BODY_B/scripts" 60 commit.sh)"; sleep 0.3
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=1500 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "scripts 폴더에서 bash commit.sh → skipped(busy · commit) · B 그대로" '[ "$(echo "$R" | field bodies.globex.reason)" = busy ] && echo "$R" | grep -q "commit.sh 실행 중" && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3F" ]' "$R"
kill "$FS" 2>/dev/null; wait "$FS" 2>/dev/null
# 본체 밖 폴더에서 ../<본체>/scripts/ship.sh(자동 리뷰 1차)
mkdir -p "$WORK/elsewhere"; REL_B="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$BODY_B" "$WORK/elsewhere")"
FS="$(fake_script "$WORK/elsewhere" 60 "$REL_B/scripts/ship.sh")"; sleep 0.3
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=1500 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "본체 밖에서 ../<본체>/scripts/ship.sh → skipped(busy · commit) · B 그대로" '[ "$(echo "$R" | field bodies.globex.reason)" = busy ] && echo "$R" | grep -q "ship.sh 실행 중" && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3F" ]' "$R"
kill "$FS" 2>/dev/null; wait "$FS" 2>/dev/null
FS="$(fake_script "$WORK" 60 scripts/ship.sh)"; sleep 0.3
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=1500 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "본체 밖 폴더의 scripts/ship.sh 는 세지 않음 → 올림 · B 는 C3G" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3G" ]' "$R"
kill "$FS" 2>/dev/null; wait "$FS" 2>/dev/null
# 공백이 든 상대 경로 — bash "../my body/scripts/commit.sh"(본체로 가는 링크 이름에 공백 · 자동 리뷰 2차). 끝날 때까지 기다린 뒤 올린다
C3G2="$(newcommit "test: 업데이트 3g2")"
ln -s "$BODY_B" "$WORK/my body"
FS="$(fake_script "$WORK/elsewhere" 8 "../my body/scripts/commit.sh")"; sleep 0.3
START=$(date +%s)
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=1500 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "공백 든 상대 경로의 commit.sh 도 찾음 → 상한(1.5초) 안 끝나면 skipped(busy · commit) · B 그대로" '[ "$(echo "$R" | field bodies.globex.reason)" = busy ] && echo "$R" | grep -q "commit.sh 실행 중" && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3G" ]' "$R"
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=15000 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "그 실행이 끝날 때까지 기다린 뒤 올림 · B 는 C3G2" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3G2" ] && ! kill -0 "$FS" 2>/dev/null && [ $(( $(date +%s) - START )) -ge 2 ]' "$R"
wait "$FS" 2>/dev/null; rm -f "$WORK/my body"
C3H="$(newcommit "test: 업데이트 3h")"
mkdir -p "$ATHENA_HEAVY_LOCK"; sleep 60 & H=$!; echo "$H" > "$ATHENA_HEAVY_LOCK/pid"; echo "$BODY_B" > "$ATHENA_HEAVY_LOCK/root"; sleep 0.2
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=1500 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "B 가 쥔 무거운 명령 잠금이 상한까지 안 풀림 → skipped(busy · heavy) · B 그대로" '[ "$(echo "$R" | field bodies.globex.reason)" = busy ] && echo "$R" | grep -q "\"kind\":\"heavy\"" && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3G2" ]' "$R"
(sleep 2; kill "$H" 2>/dev/null) &
R="$(cd "$MAIN" && ATHENA_UPDATE_WAIT_MS=15000 node scripts/athena.mjs update --from "$(bundle)" --json --contract 3 2>/dev/null | tail -1)"
check "잠금이 상한 안에 풀림 → 기다린 뒤 올림 · B 는 C3H" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3H" ]' "$R"
wait "$H" 2>/dev/null; rm -rf "$ATHENA_HEAVY_LOCK"
C3I="$(newcommit "test: 업데이트 3i")"
sleep 60 & QP=$!; mkdir -p "$BODY_B/.qa-runs/t1"; echo "{\"pid\": $QP}" > "$BODY_B/.qa-runs/t1/run.json"; sleep 0.2
R="$(J "$MAIN" update --from "$(bundle)")"
check "도는 QA 실행 → 끄고 올림 · qaStopped · B 는 C3I" '[ "$(echo "$R" | field bodies.globex.status)" = updated ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3I" ] && [ "$(echo "$R" | field bodies.globex.services.qaStopped)" = "[$QP]" ] && ! kill -0 "$QP" 2>/dev/null' "$R"
wait "$QP" 2>/dev/null; rm -rf "$BODY_B/.qa-runs/t1"
C3C="$C3I"   # 아래 데이터 형식 절은 B 의 마지막 커밋을 C3C 로 본다

section "데이터 형식이 바뀌는 업데이트 — 모든 본체가 비었을 때만(D10)"
sed -i.bak 's/export const DATA_FORMATS = \[1, 1\]/export const DATA_FORMATS = [2, 2]/' "$DEV/scripts/lib/config.mjs" && rm -f "$DEV/scripts/lib/config.mjs.bak"
C4="$(newcommit "test: 데이터 형식 2")"
CB="$(fake_claude "$BODY_B")"; sleep 0.5
R="$(J "$MAIN" update --from "$(bundle)")"
check "B 가 일하면 data-incompatible · 아무 본체도 안 옮김" '[ "$(echo "$R" | field error)" = data-incompatible ] && [ "$(git -C "$BODY_B" rev-parse HEAD)" = "$C3C" ]' "$R"
kill "$CB" 2>/dev/null; wait "$CB" 2>/dev/null
python3 -c "import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['formatVersion']=9; json.dump(d, open(p,'w'))" "$ATHENA_DATA_DIR/config.json"
check "데이터 형식이 범위 밖이면 쓰기 명령 data-incompatible" '[ "$(J "$MAIN" pack open globex | field error)" = data-incompatible ] && [ "$(J "$MAIN" pack list | field ok)" = True ]'

printf '\n통과 %d · 실패 %d%s\n' "$PASS" "$FAIL" "$([ "${KEEP:-}" = 1 ] && echo " · 임시 폴더 $WORK")"
[ "$FAIL" = 0 ]
