#!/usr/bin/env bash
# 번들 코어 시험 — 앱이 코어를 git 번들로 들고 와 자기 데이터 폴더에서 도는 경우(스튜디오).
# 진짜 스튜디오 집(~/.athena-studio)은 건드리지 않는다
# (모든 것이 임시 폴더 안 · ATHENA_DATA_DIR 대신 주 본체 athena.config.json 의 dataDir · 끝나면 지운다).
#
# 사용: test/bundle-test.sh          → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#       KEEP=1 test/bundle-test.sh   → 임시 폴더를 남긴다
#
# 보는 것: 번들 → 주 본체 clone · 레지스트리 bodiesDir(상대 경로는 데이터 폴더 기준)로 팩 본체 자리 · portBase 포트 범위 ·
# update --from <번들>(전체 · 앞 커밋을 전제로 한 얇은 번들) · deploy.source · 업데이트 전후 사용자 데이터(<데이터>/packs) 해시 동일 ·
# 본체 안 진짜 파일(설정·상태 파일·.migrate-*)이 업데이트에 안 건드려짐 · dirty 는 기본 건너뜀 · --backup-dirty 는 사본 뒤 교체(backedUp) ·
# 되돌리기 · 팩 작업 중인 본체 건너뜀(일하는 세션은 올림 — bodies-test) · 백업 기본 자리(<데이터>/backups/packs) · 일감 포트·로그 이름
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/bundle-test.XXXXXX")" && pwd -P)"
cleanup() { kill $(jobs -p) 2>/dev/null; pkill -f "$WORK/" 2>/dev/null; rm -rf "$WORK"; }
[ "${KEEP:-}" = 1 ] || trap cleanup EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✔ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✖ %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2" | head -c 900 && echo; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
section() { printf '\n%s\n' "$1"; }
unset ATHENA_AGENT ATHENA_STUDIO ATHENA_BOARD_PORT ATHENA_PACK_FAIL_AT ATHENA_CONTRACT ATHENA_RELINK_FAIL_AT ATHENA_DATA_DIR
export ATHENA_SCREEN=none ATHENA_BOARD_NO_BROWSER=1 ATHENA_HEAVY_LOCK="$WORK/heavy.lock"
export GIT_AUTHOR_NAME=athena-test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=athena-test GIT_COMMITTER_EMAIL=test@example.invalid
PORT_BASE=48600

# ── 앱이 들고 올 코어 — 개발 저장소(지금 작업 트리 코드) → git 번들 ─────────────
# 앱 데이터 폴더 모양: <앱>/core(주 본체) · <앱>/bodies/<id>(팩 본체) · <앱>/data-test(데이터 — test-setup 이 이름에 test 를 요구)
DEV="$WORK/dev"; APP="$WORK/app"; CORE="$APP/core"; DATA="$APP/data-test"
git init -q -b main "$DEV"
(cd "$SRC" && git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do [ -e "$file" ] || [ -L "$file" ] && printf '%s\0' "$file"; done) > "$WORK/files.list"
rsync -a --from0 --files-from="$WORK/files.list" "$SRC/" "$DEV/"
git -C "$DEV" add -A >/dev/null 2>&1; git -C "$DEV" commit -qm "test: 작업 트리" >/dev/null 2>&1
C0="$(git -C "$DEV" rev-parse HEAD)"
# newcommit <설명> — 개발 저장소에 커밋을 하나 올린다
newcommit() { printf '%s\n' "$1" >> "$DEV/docs/bundle-test-note.md"; git -C "$DEV" add -A >/dev/null; git -C "$DEV" commit -qm "$1"; git -C "$DEV" rev-parse HEAD; }
git -C "$DEV" bundle create -q "$WORK/core-1.bundle" main 2>/dev/null

J() { (cd "$1" && shift && node scripts/athena.mjs "$@" --json --contract 3 2>/dev/null | tail -1); }
field() { python3 -c 'import json,sys
d=json.loads(sys.stdin.read() or "{}")
for k in sys.argv[1].split("."):
    if isinstance(d, list): d = next((x for x in d if isinstance(x, dict) and x.get("id") == k), None)
    else: d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else (json.dumps(d) if isinstance(d,(dict,list)) else d))' "$1"; }
REG() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else d)' "$DATA/config.json" "$1"; }
# 사용자 데이터 해시 — <데이터>/packs 아래 모든 파일·링크(경로 + 내용 · 링크는 가리키는 곳)
datahash() { python3 -c 'import hashlib,os,sys
root=sys.argv[1]; h=hashlib.sha256()
for base, dirs, files in sorted(os.walk(root)):
    dirs.sort()
    for name in sorted(files + [d for d in dirs if os.path.islink(os.path.join(base, d))]):
        path=os.path.join(base, name); rel=os.path.relpath(path, root)
        h.update(rel.encode())
        h.update(("->" + os.readlink(path)).encode() if os.path.islink(path) else open(path, "rb").read())
print(h.hexdigest())' "$DATA/packs"; }
# 본체 안 진짜 파일(무시 목록) 해시 — 업데이트가 건드리지 않아야 한다
LOCALFILES="athena.config.json .board-usage.json .claude/settings.local.json .migrate-20261019-000000/athena.config.json"
localhash() { (cd "$1" && for file in $LOCALFILES; do printf '%s ' "$file"; cat "$file" 2>/dev/null | shasum | cut -c1-12; done); }

section "번들 → 주 본체(clone) · 데이터 폴더는 본체 설정 dataDir"
mkdir -p "$APP"
git clone -q "$WORK/core-1.bundle" "$CORE" 2>/dev/null
check "주 본체는 main · 번들 커밋" '[ "$(git -C "$CORE" rev-parse --abbrev-ref HEAD)" = main ] && [ "$(git -C "$CORE" rev-parse HEAD)" = "$C0" ]'
printf '{ "dataDir": "%s" }\n' "$DATA" > "$CORE/athena.config.json"
R="$(J "$CORE" pack test-setup)"
check "test-setup(acme) — ATHENA_DATA_DIR 없이 본체 설정 dataDir 로" '[ "$(echo "$R" | field current.id)" = acme ] && [ "$(echo "$R" | field dataDir)" = "$DATA" ]' "$R"
# 앱이 정하는 손잡이 — 본체 자리(상대 경로 → 데이터 폴더 기준)·포트 기준. 본체 설정의 boardPort 는 지운다(레지스트리 portBase 가 정한다)
python3 -c 'import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["bodiesDir"]="../bodies"; d["portBase"]=int(sys.argv[2]); json.dump(d, open(p,"w"), indent=2)
c=sys.argv[3]; d=json.load(open(c)); d.pop("boardPort", None); json.dump(d, open(c,"w"), indent=2)' "$DATA/config.json" "$PORT_BASE" "$CORE/athena.config.json"

section "bodiesDir · portBase — 팩 본체는 <앱>/bodies/<id>, 포트는 $PORT_BASE 대"
R="$(J "$CORE" pack open acme)"
check "주 본체(acme) 포트 = portBase" '[ "$(echo "$R" | field body)" = "$CORE" ] && [ "$(echo "$R" | field boardPort)" = "$PORT_BASE" ]' "$R"
R="$(J "$CORE" pack open globex)"; BODY_G="$APP/bodies/globex"
check "globex 본체 = <앱>/bodies/globex · created · 포트 portBase+2" '[ "$(echo "$R" | field body)" = "$BODY_G" ] && [ "$(echo "$R" | field created)" = True ] && [ "$(echo "$R" | field boardPort)" = "$((PORT_BASE+2))" ]' "$R"
check "<주 본체>-globex 는 만들지 않음 · 같은 저장소 워크트리" '[ ! -e "$APP/core-globex" ] && git -C "$CORE" worktree list | grep -q "$BODY_G"'
check "globex 본체는 detached · 번들 커밋(origin/main = 번들)" '[ "$(git -C "$BODY_G" rev-parse --abbrev-ref HEAD)" = HEAD ] && [ "$(git -C "$BODY_G" rev-parse HEAD)" = "$C0" ]'
check "일감 포트·로그 이름(board.sh url · 파이썬 board_port)" '[ "$("$BODY_G/scripts/board.sh" url)" = "http://localhost:$((PORT_BASE+2))" ] && [ "$("$CORE/scripts/board.sh" url)" = "http://localhost:$PORT_BASE" ] && grep -q "hermes-board-\$PORT.log" "$CORE/scripts/board.sh"'
R="$(J "$CORE" pack new)"; NEW="$(echo "$R" | field id)"; NEWBODY="$(echo "$R" | field body)"
check "pack new 도 bodiesDir 안(포트 portBase+4)" '[ "$NEWBODY" = "$APP/bodies/$NEW" ] && [ -d "$NEWBODY" ] && [ "$(echo "$R" | field boardPort)" = "$((PORT_BASE+4))" ]' "$R"
R="$(J "$CORE" pack discard "$NEW")"
check "discard → bodiesDir 의 본체 지움" '[ "$(echo "$R" | field removedBody)" = "$NEWBODY" ] && [ ! -e "$NEWBODY" ]' "$R"

section "update --from 번들 — 사용자 데이터·본체 안 진짜 파일은 그대로"
for body in "$CORE" "$BODY_G"; do
  printf '{"at":1}\n' > "$body/.board-usage.json"
  mkdir -p "$body/.claude" "$body/.migrate-20261019-000000"; printf '{"x":1}\n' > "$body/.claude/settings.local.json"; printf '{"old":true}\n' > "$body/.migrate-20261019-000000/athena.config.json"
done
check "본체 안 진짜 파일은 git 이 무시(추적 파일 변경 없음)" '[ -z "$(git -C "$CORE" status --porcelain)" ] && [ -z "$(git -C "$BODY_G" status --porcelain)" ]' "$(git -C "$CORE" status --porcelain; git -C "$BODY_G" status --porcelain)"
H0="$(datahash)"; L_CORE="$(localhash "$CORE")"; L_G="$(localhash "$BODY_G")"; PACKS0="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))["packs"]; print(json.dumps(d, sort_keys=True))' "$DATA/config.json")"
C1="$(newcommit "test: 번들 업데이트 1")"
git -C "$DEV" bundle create -q "$WORK/core-2.bundle" main 2>/dev/null
R="$(J "$CORE" update --from "$WORK/core-2.bundle")"; OP1="$(echo "$R" | field operationId)"
check "complete · 둘 다 C1 · source bundle · fetched = 번들 main" '[ "$(echo "$R" | field status)" = complete ] && [ "$(git -C "$CORE" rev-parse HEAD)" = "$C1" ] && [ "$(git -C "$BODY_G" rev-parse HEAD)" = "$C1" ] && [ "$(echo "$R" | field source)" = bundle ] && [ "$(echo "$R" | field fetched)" = "$C1" ] && [ "$(git -C "$CORE" rev-parse --abbrev-ref HEAD)" = main ]' "$R"
check "레지스트리 deploy = C1 · source bundle · version 에도(capabilities 에 손잡이 이름)" '[ "$(REG deploy.commit)" = "$C1" ] && [ "$(REG deploy.source)" = bundle ] && [ "$(J "$BODY_G" version | field deploy.source)" = bundle ] && J "$BODY_G" version | field capabilities | grep -q update-from-bundle'
check "사용자 데이터(<데이터>/packs) 해시 동일" '[ "$(datahash)" = "$H0" ]'
check "레지스트리 packs 그대로(deploy 만 바뀜)" '[ "$(python3 -c "import json,sys; d=json.load(open(sys.argv[1]))[\"packs\"]; print(json.dumps(d, sort_keys=True))" "$DATA/config.json")" = "$PACKS0" ]'
check "본체 안 진짜 파일(설정·상태·.migrate-*) 그대로" '[ "$(localhash "$CORE")" = "$L_CORE" ] && [ "$(localhash "$BODY_G")" = "$L_G" ]' "$(localhash "$BODY_G")"
check "두 본체 다 ready · 깨끗" '[ "$(J "$CORE" pack list | field packs.globex.bodyState)" = ready ] && [ -z "$(git -C "$BODY_G" status --porcelain --untracked-files=no)" ]'
R="$(J "$CORE" update --from "$WORK/core-2.bundle")"
check "같은 번들을 다시 → same · complete(멱등)" '[ "$(echo "$R" | field status)" = complete ] && [ "$(echo "$R" | field bodies.globex.status)" = same ]' "$R"
check "옛 번들(버전 ref 없음) → version null" '[ -z "$(J "$BODY_G" version | field version)" ]'
git -C "$DEV" update-ref refs/athena/version/0.9.0 "$C1"
git -C "$DEV" bundle create -q "$WORK/core-2v.bundle" main refs/athena/version/0.9.0 2>/dev/null
git -C "$DEV" update-ref -d refs/athena/version/0.9.0
R="$(J "$CORE" update --from "$WORK/core-2v.bundle")"
check "버전 ref 를 실은 번들 → 두 본체 version 0.9.0 · 텍스트에도" '[ "$(J "$CORE" version | field version)" = 0.9.0 ] && [ "$(J "$BODY_G" version | field version)" = 0.9.0 ] && (cd "$BODY_G" && node scripts/athena.mjs version --contract 3 2>/dev/null | grep -q "버전 0.9.0")' "$R"
check "없는 번들 → not-found · 번들 아닌 파일 → fetch-failed" '[ "$(J "$CORE" update --from "$WORK/nope.bundle" | field error)" = not-found ] && [ "$(J "$CORE" update --from "$WORK/files.list" | field error)" = fetch-failed ]'

section "얇은 번들(앞 커밋 전제) · dirty 는 기본 건너뜀"
C2="$(newcommit "test: 번들 업데이트 2")"
git -C "$DEV" bundle create -q "$WORK/core-3.bundle" "$C1..main" 2>/dev/null
echo "// 사용자가 고친 코어" >> "$BODY_G/scripts/lib/lock.mjs"
echo "사용자 메모" >> "$CORE/docs/pack.md"; echo "새 파일" > "$CORE/docs/local-new.md"; git -C "$CORE" add docs/local-new.md
R="$(J "$CORE" update --from "$WORK/core-3.bundle")"
check "--backup-dirty 없으면 둘 다 skipped(dirty) · 그대로" '[ "$(echo "$R" | field bodies.globex.reason)" = dirty ] && [ "$(echo "$R" | field bodies.acme.reason)" = dirty ] && [ "$(git -C "$BODY_G" rev-parse HEAD)" = "$C1" ] && [ -z "$(echo "$R" | field backedUp)" ] && tail -1 "$BODY_G/scripts/lib/lock.mjs" | grep -q "사용자가 고친"' "$R"

section "update --from --backup-dirty — 사본 두고 교체(D4)"
R="$(J "$CORE" update --from "$WORK/core-3.bundle" --backup-dirty)"; OP3="$(echo "$R" | field operationId)"
BK="$DATA/backups/core-edits/$OP3"
check "complete · 둘 다 C2(얇은 번들로)" '[ "$(echo "$R" | field status)" = complete ] && [ "$(git -C "$CORE" rev-parse HEAD)" = "$C2" ] && [ "$(git -C "$BODY_G" rev-parse HEAD)" = "$C2" ]' "$R"
check "결과 backedUp — 본체마다 dir · files" '[ "$(echo "$R" | field backedUp | python3 -c "import json,sys; print(sorted((e[\"id\"], tuple(e[\"files\"])) for e in json.load(sys.stdin)))")" = "[('"'"'acme'"'"', ('"'"'docs/local-new.md'"'"', '"'"'docs/pack.md'"'"')), ('"'"'globex'"'"', ('"'"'scripts/lib/lock.mjs'"'"',))]" ] && [ "$(echo "$R" | field bodies.globex.backupDir)" = "$BK/globex" ]' "$R"
check "사본 — 고친 내용 · 스테이징한 새 파일 · changes.patch · meta.json" 'tail -1 "$BK/globex/files/scripts/lib/lock.mjs" | grep -q "사용자가 고친" && tail -1 "$BK/acme/files/docs/pack.md" | grep -q "사용자 메모" && grep -q "새 파일" "$BK/acme/files/docs/local-new.md" && grep -q "사용자가 고친" "$BK/globex/changes.patch" && [ "$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\"head\"])" "$BK/globex/meta.json")" = "$C1" ]'
check "교체 뒤 본체는 깨끗 · 새 코어 내용" '[ -z "$(git -C "$BODY_G" status --porcelain --untracked-files=no)" ] && [ -z "$(git -C "$CORE" status --porcelain --untracked-files=no)" ] && ! grep -q "사용자가 고친" "$BODY_G/scripts/lib/lock.mjs" && [ ! -e "$CORE/docs/local-new.md" ]'
check "업데이트 기록에 backedUp · 사용자 데이터 해시 그대로 · 진짜 파일 그대로" 'grep -q "\"backedUp\"" "$DATA/updates/$OP3.json" && [ "$(datahash)" = "$H0" ] && [ "$(localhash "$BODY_G")" = "$L_G" ] && [ "$(localhash "$CORE")" = "$L_CORE" ]'

section "되돌리기 · 팩 작업 중인 본체"
R="$(J "$CORE" update --rollback "$OP3")"
# 배포 커밋은 그 실행 이전 값 — 모두 dirty 로 건너뛴 앞 실행(partial)이 이미 C2 로 옮겨 두었다(기존 규칙 · 열 때 따라잡기용)
check "--rollback: globex 는 C1 로 · 주 본체 skipped(main) · deploy 는 실행 이전(C2 · source bundle)" '[ "$(git -C "$BODY_G" rev-parse HEAD)" = "$C1" ] && [ "$(echo "$R" | field bodies.acme.reason)" = main ] && [ "$(REG deploy.commit)" = "$C2" ] && [ "$(REG deploy.source)" = bundle ]' "$R"
# 다른 쪽이 globex 팩 작업 잠금을 쥐고 있다(열기 · 바꾸기 중) — 일하는 세션과 달리 업데이트가 건너뛴다
PLOCK="$DATA/locks/globex.lock"; mkdir -p "$PLOCK"; sleep 60 & PL=$!; echo "$PL" > "$PLOCK/pid"; echo "pack open globex" > "$PLOCK/what"
R="$(J "$CORE" update --from "$WORK/core-3.bundle" --backup-dirty)"
check "globex 팩이 잠겨 있으면 skipped(busy) · 그대로" '[ "$(echo "$R" | field bodies.globex.reason)" = busy ] && [ "$(git -C "$BODY_G" rev-parse HEAD)" = "$C1" ]' "$R"
kill "$PL" 2>/dev/null; wait "$PL" 2>/dev/null; rm -rf "$PLOCK"
R="$(J "$CORE" pack open globex)"
check "비면 열 때 따라잡음(C2)" '[ "$(echo "$R" | field updated.to)" = "$C2" ] && [ "$(git -C "$BODY_G" rev-parse HEAD)" = "$C2" ]' "$R"

section "백업 기본 자리 — <데이터>/backups/packs"
R="$(J "$BODY_G" pack backup --with-work)"
check "pack backup --with-work(--out 없음) → <데이터>/backups/packs" 'case "$(echo "$R" | field file)" in "$DATA/backups/packs/"*) [ -f "$(echo "$R" | field file)" ] ;; *) false ;; esac' "$R"
check "기본 데이터 폴더(~/.athena-studio/data)도 <데이터>/backups/packs" '[ "$(cd "$CORE" && node -e "import(\"./scripts/lib/config.mjs\").then((m) => console.log(m.defaultBackupDir(m.DEFAULT_DATA_DIR)))")" = "$HOME/.athena-studio/data/backups/packs" ]'
check "portBase 가 없거나 이상하면 4700(js · 파이썬 같은 판정)" '[ "$(cd "$CORE" && node -e "import(\"./scripts/lib/config.mjs\").then((m) => console.log([m.portBaseOf({}), m.portBaseOf({ portBase: \"4800\" }), m.portBaseOf({ portBase: 80 }), m.portBaseOf({ portBase: 4800 })].join(\" \")))")" = "4700 4700 4700 4800" ] && [ "$(python3 -c "import sys; sys.path.insert(0, sys.argv[1] + \"/scripts/lib\"); from athena_config import port_base; print(port_base({}), port_base({\"portBase\": \"4800\"}), port_base({\"portBase\": 80}), port_base({\"portBase\": 4800}))" "$CORE")" = "4700 4700 4700 4800" ]'

printf '\n통과 %d · 실패 %d%s\n' "$PASS" "$FAIL" "$([ "${KEEP:-}" = 1 ] && echo " · 임시 폴더 $WORK")"
[ "$FAIL" = 0 ]
