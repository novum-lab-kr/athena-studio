#!/usr/bin/env bash
# 레포 규칙 문서 시험 — 찾기(관례 이름 · @ 중복 없음 · add · exclude · 위험 경로) · 세션 글(절 형식 · 상한 · 목록) · 압축 뒤 안내 · init 첫 목록 · sync 리포트 — 임시 폴더 · 몇 초
#
# 사용: test/rule-docs-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-rule-docs-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0
check() {   # <이름> <조건 셸 식> [실패 때 보일 것]
  if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -n "${3:-}" ] && echo "      $3"; FAIL=1; fi
}
GIT="git -c user.name=t -c user.email=t@t"
list() { python3 "$SRC/scripts/lib/rule_docs.py" list "$@"; }
field() { python3 -c 'import json,sys; print(" ".join(json.loads(sys.argv[1])[sys.argv[2]]))' "$1" "$2"; }
has_all() {   # <공백으로 나눈 목록> <이름>… — 모두 있어야 참(check 의 eval 안에서 return 을 쓰면 실패가 숨는다)
  local listed=" $1 " name; shift
  for name in "$@"; do case "$listed" in *" $name "*) ;; *) return 1;; esac; done
}

echo "찾기"
REPO="$TMP/repo"; mkdir -p "$REPO/.ai" "$REPO/.github/agents" "$REPO/.claude/rules" "$REPO/apps/web" "$REPO/apps/shop" "$REPO/docs"
printf '@AGENTS.md\n@docs/imported.md\n`@docs/code.md`\n' > "$REPO/CLAUDE.md"
echo agents > "$REPO/AGENTS.md"; echo imported > "$REPO/docs/imported.md"; echo code > "$REPO/docs/code.md"
echo agreement > "$REPO/WORKING-AGREEMENT.md"; echo contributing > "$REPO/CONTRIBUTING.md"; echo basic > "$REPO/.ai/basic.md"
echo cursor > "$REPO/.cursorrules"; echo copilot > "$REPO/.github/copilot-instructions.md"; echo one > "$REPO/.github/agents/one.agent.md"
echo skip > "$REPO/.github/agents/other.md"; echo rule > "$REPO/.claude/rules/a.md"; echo web > "$REPO/apps/web/AGENTS.md"; echo shop > "$REPO/apps/shop/AGENTS.md"
echo extra > "$REPO/docs/extra.md"; echo 'SECRET=value' > "$REPO/.env"; echo 'outside' > "$TMP/outside.md"
ln -s "$TMP/outside.md" "$REPO/CONTRIBUTING-LINK.md"
OUT="$(list "$REPO" --json '{"dirs":["","apps/web"]}')"; DOCS="$(field "$OUT" docs)"; AUTO="$(field "$OUT" auto)"
check "관례 이름을 찾는다" 'has_all "$DOCS" WORKING-AGREEMENT.md CONTRIBUTING.md .ai/basic.md .cursorrules .github/copilot-instructions.md .github/agents/one.agent.md apps/web/AGENTS.md' "$DOCS"
check "관례 밖 파일 · 대상 밖 앱은 안 찾는다" 'case " $DOCS " in *other.md*|*apps/shop*|*extra.md*) false;; *) true;; esac' "$DOCS"
check "@ 로 끌어온 파일 · rules 는 실을 목록이 아니라 auto" 'case " $DOCS " in *" AGENTS.md "*|*imported.md*|*.claude/rules/a.md*) false;; *) true;; esac && case " $AUTO " in *" AGENTS.md "*) true;; *) false;; esac && case "$AUTO" in *docs/imported.md*) true;; *) false;; esac && case "$AUTO" in *.claude/rules/a.md*) true;; *) false;; esac' "docs=$DOCS auto=$AUTO"
check "코드 표시 안의 @ 는 참조가 아니다" 'case "$AUTO" in *code.md*) false;; *) true;; esac' "$AUTO"
OUT="$(list "$REPO" --json '{"add":["docs/extra.md","docs/none.md","docs/imported.md","WORKING-AGREEMENT.md"],"exclude":["WORKING-AGREEMENT.md",".cursorrules"]}')"; DOCS="$(field "$OUT" docs)"
check "add 로 더한다 · 없는 경로는 missing" 'case " $DOCS " in *" docs/extra.md "*) true;; *) false;; esac && [ "$(field "$OUT" missing)" = docs/none.md ]' "$OUT"
check "exclude 가 관례 이름 · add 보다 먼저" 'case " $DOCS " in *WORKING-AGREEMENT*|*cursorrules*) false;; *) true;; esac' "$DOCS"
check "@ 로 끌어온 파일은 add 에 있어도 실을 목록에 없다" 'case " $DOCS " in *imported.md*) false;; *) true;; esac' "$DOCS"
OUT="$(list "$REPO" --json '{"add":["../outside.md","/etc/hosts",".env","CONTRIBUTING-LINK.md",".git/config",7]}')"; REFUSED="$(field "$OUT" refused)"
check "위험 경로를 거부한다(.. · 절대 · 시크릿 · 레포 밖 링크 · .git · 문자열 아님)" 'has_all "$REFUSED" ../outside.md /etc/hosts .env CONTRIBUTING-LINK.md .git/config 7' "$REFUSED"
check "거부한 경로는 실을 목록에 없다" 'case " $(field "$OUT" docs) " in *outside*|*" .env "*) false;; *) true;; esac'
LINK="$TMP/linkrepo"; mkdir -p "$LINK"; echo body > "$LINK/CLAUDE.md"; ln -s CLAUDE.md "$LINK/AGENTS.md"
OUT="$(list "$LINK" --json '{}')"
check "CLAUDE.md 로 풀리는 심볼릭 링크는 중복으로 안 싣는다" '[ -z "$(field "$OUT" docs)" ]' "$OUT"
LOWER="$TMP/lower"; mkdir -p "$LOWER"; echo x > "$LOWER/agents.md"
OUT="$(list "$LOWER" --json '{}')"
check "대소문자가 다르면 관례 이름이 아니다" '[ -z "$(field "$OUT" docs)" ]' "$OUT"

echo "ref 에서 찾기"
$GIT -C "$REPO" init -q -b main; rm "$REPO/CONTRIBUTING-LINK.md" "$REPO/.env"; $GIT -C "$REPO" add -A; $GIT -C "$REPO" commit -q -m init
echo later > "$REPO/WORKING-AGREEMENT-NEW.md"; mv "$REPO/WORKING-AGREEMENT.md" "$TMP/moved.md"
OUT="$(list "$REPO" --ref main --json '{}')"; DOCS="$(field "$OUT" docs)"
check "작업 트리가 아니라 ref 를 읽는다" 'case " $DOCS " in *" WORKING-AGREEMENT.md "*) true;; *) false;; esac' "$DOCS"
mv "$TMP/moved.md" "$REPO/WORKING-AGREEMENT.md"; rm "$REPO/WORKING-AGREEMENT-NEW.md"

echo "세션 글"
BODY="$TMP/body"; mkdir -p "$BODY/.claude/agents" "$BODY/.claude/rules" "$BODY/scripts/lib" "$BODY/repos"
cp "$SRC/scripts/agent-context.py" "$BODY/scripts/"; cp "$SRC/scripts/lib/agent_hooks.py" "$SRC/scripts/lib/rule_docs.py" "$SRC/scripts/lib/athena_config.py" "$BODY/scripts/lib/"
printf '{}\n' > "$BODY/.claude/settings.json"; echo rules > "$BODY/AGENTS.md"
printf -- '---\nname: web-fe\ndescription: x\n---\nbody\n' > "$BODY/.claude/agents/web-fe.md"
printf -- '---\nname: reviewer\ndescription: x\n---\nbody\n' > "$BODY/.claude/agents/reviewer.md"
ln -s "$REPO" "$BODY/repos/mono"
config() { printf '{"repos":[{"name":"mono","kind":"monorepo","branch":"main","apps":{"web":{"agent":"web-fe"},"shop":{"agent":"shop-fe"}},"packagesAgent":"pkg-fe","ruleDocs":%s}]}\n' "$1" > "$BODY/athena.config.json"; }
context() { python3 "$BODY/scripts/agent-context.py" "$1" "$BODY" "$REPO" "$TMP/a.json" "$TMP/c.md" "$TMP/s.json"; }
config '{"add":["docs/extra.md","apps/shop/AGENTS.md"]}'
NOTES="$(context web-fe)"
check "공통 규칙 뒤에 절 · 파일마다 <레포>/<경로> · 원문 그대로" 'grep -qx "# 레포 규칙 문서" "$TMP/c.md" && grep -qx "## mono/WORKING-AGREEMENT.md" "$TMP/c.md" && grep -qx "agreement" "$TMP/c.md" && [ "$(grep -n "^rules$" "$TMP/c.md" | cut -d: -f1)" -lt "$(grep -n "^# 레포 규칙 문서$" "$TMP/c.md" | cut -d: -f1)" ]' "$(cat "$TMP/c.md")"
check "@ 로 끌어온 AGENTS.md 는 절에 없다" '! grep -qx "## mono/AGENTS.md" "$TMP/c.md" && ! grep -qx "## mono/docs/imported.md" "$TMP/c.md"'
check "담당 앱 문서만 — 다른 앱은 add 에 있어도 뺀다" 'grep -qx "## mono/apps/web/AGENTS.md" "$TMP/c.md" && ! grep -q "apps/shop" "$TMP/c.md" && grep -qx "## mono/docs/extra.md" "$TMP/c.md"' "$(grep '^## ' "$TMP/c.md")"
check "상한 안이면 알릴 줄이 없다" '[ -z "$NOTES" ]' "$NOTES"
context reviewer >/dev/null
check "담당을 모르면(reviewer) 앱 전부" 'grep -qx "## mono/apps/web/AGENTS.md" "$TMP/c.md" && grep -qx "## mono/apps/shop/AGENTS.md" "$TMP/c.md"'
python3 -c 'print("큰"*500)' > "$REPO/docs/big.md"
config '{"add":["docs/big.md"],"maxChars":200}'
NOTES="$(context web-fe)"
check "상한을 넘으면 큰 파일부터 목록으로 · 작은 파일은 전문" '! grep -qx "## mono/docs/big.md" "$TMP/c.md" && grep -q "docs/big.md\` (501자)" "$TMP/c.md" && grep -qx "## mono/WORKING-AGREEMENT.md" "$TMP/c.md"' "$(cat "$TMP/c.md")"
check "상한을 넘으면 보고에 한 줄" '[ "$(printf "%s\n" "$NOTES" | wc -l | tr -d " ")" = 1 ] && case "$NOTES" in *docs/big.md*) true;; *) false;; esac' "$NOTES"
check "목록으로 돌린 경로만 압축 뒤 훅에 넘긴다" 'grep -q "post .*docs/big.md" "$TMP/s.json" && ! grep -q "post .*WORKING-AGREEMENT" "$TMP/s.json"' "$(cat "$TMP/s.json")"
config '{"maxChars":"많이"}'; NOTES="$(context web-fe)"
check "이상한 상한은 기본값 + 알림" 'case "$NOTES" in *maxChars*) true;; *) false;; esac' "$NOTES"
rm -f "$BODY/athena.config.json"; NOTES="$(context web-fe)";
check "설정이 없어도 관례 이름으로 실린다" 'grep -qx "# 레포 규칙 문서" "$TMP/c.md" && grep -qx "## repo/WORKING-AGREEMENT.md" "$TMP/c.md" || grep -qx "## mono/WORKING-AGREEMENT.md" "$TMP/c.md"' "$NOTES"
EMPTY="$TMP/empty"; mkdir -p "$EMPTY"
python3 "$BODY/scripts/agent-context.py" web-fe "$BODY" "$EMPTY" "$TMP/a.json" "$TMP/c.md" "$TMP/s.json" >/dev/null
check "규칙 문서가 없는 레포에는 절이 없다" '! grep -q "레포 규칙 문서" "$TMP/c.md"'
rm "$REPO/docs/big.md"

echo "압축 뒤 안내"
HOOK_BODY="$TMP/hook"; mkdir -p "$HOOK_BODY/scripts/hooks" "$HOOK_BODY/scripts/lib"
cp "$SRC/scripts/hooks/compact-checkpoint.py" "$HOOK_BODY/scripts/hooks/"; cp "$SRC"/scripts/lib/*.py "$HOOK_BODY/scripts/lib/"
OUT="$(echo '{"source":"compact","cwd":"/tmp"}' | env -u ATHENA_AGENT python3 "$HOOK_BODY/scripts/hooks/compact-checkpoint.py" post /w/docs/big.md)"
check "목록 문서를 다시 읽으라고 안내한다" 'case "$OUT" in *"레포 규칙 문서 다시 읽기: /w/docs/big.md"*) true;; *) false;; esac' "$OUT"
OUT="$(echo '{"source":"compact","cwd":"/tmp"}' | env -u ATHENA_AGENT python3 "$HOOK_BODY/scripts/hooks/compact-checkpoint.py" post)"
check "목록 문서가 없으면 그 문장이 없다" 'case "$OUT" in *"다시 읽기"*) false;; *) true;; esac' "$OUT"

echo "init 첫 목록"
INIT="$(cd "$SRC" && node --input-type=module -e "
import { inspectRepo, packEntry } from './scripts/lib/init.mjs'
const entry = packEntry(inspectRepo(process.argv[1]))
console.log(JSON.stringify(entry.ruleDocs))
const empty = packEntry(inspectRepo(process.argv[2]))
console.log('ruleDocs' in empty)
" "$REPO" "$EMPTY" 2>&1)"
check "찾은 목록을 팩 항목 add 에 · 없으면 칸도 없다" 'case "$INIT" in *"\"WORKING-AGREEMENT.md\""*) true;; *) false;; esac && [ "$(printf "%s\n" "$INIT" | tail -1)" = false ]' "$INIT"

echo "sync 리포트"
SYNC="$TMP/sync"; mkdir -p "$SYNC/repos"; cp -R "$SRC/scripts" "$SYNC/scripts"
cat > "$SYNC/athena.config.json" <<'JSON'
{"repos":[{"name":"good","branch":"dev","kind":"single","appDir":"app","agents":["good-fe"]}]}
JSON
git init -q -b dev --bare "$TMP/origin.git"
git init -q -b dev "$SYNC/repos/good"; echo one > "$SYNC/repos/good/AGENTS.md"
$GIT -C "$SYNC/repos/good" add -A; $GIT -C "$SYNC/repos/good" commit -q -m init
git -C "$SYNC/repos/good" remote add origin "$TMP/origin.git"; git -C "$SYNC/repos/good" push -q origin dev
run() { (cd "$SYNC" && node scripts/sync-fingerprint.mjs --no-fetch "$@" 2>&1); }
OUT="$(run)"
check "첫 실행 — 팩 목록 갱신 제안" 'echo "$OUT" | grep -q "ruleDocs.add. 갱신 제안" && echo "$OUT" | grep -q "^+ AGENTS.md$"' "$OUT"
run --accept >/dev/null
OUT="$(run)"
check "커밋이 같아도 팩에 안 적었으면 제안" 'echo "$OUT" | grep -q "변경 없음" && echo "$OUT" | grep -q "갱신 제안"' "$OUT"
cat > "$SYNC/athena.config.json" <<'JSON'
{"repos":[{"name":"good","branch":"dev","kind":"single","appDir":"app","agents":["good-fe"],"ruleDocs":{"add":["AGENTS.md"]}}]}
JSON
OUT="$(run)"
check "목록이 맞으면 제안 없음 · 모두 동일" '! echo "$OUT" | grep -q "갱신 제안" && echo "$OUT" | tail -1 | grep -q "모든 레포가 baseline 과 동일"' "$OUT"
echo agreement > "$SYNC/repos/good/WORKING-AGREEMENT.md"; git -C "$SYNC/repos/good" rm -q AGENTS.md
$GIT -C "$SYNC/repos/good" add -A; $GIT -C "$SYNC/repos/good" commit -q -m docs; git -C "$SYNC/repos/good" push -q origin dev
OUT="$(run)"
check "문서를 더하고 빼면 규칙 문서 변화" 'echo "$OUT" | grep -q "### 규칙 문서 변화" && echo "$OUT" | grep -q "^+ WORKING-AGREEMENT.md$" && echo "$OUT" | grep -q "^- AGENTS.md$"' "$OUT"
check "없어진 add 는 빼라고 · 새 문서는 더하라고 제안" 'echo "$OUT" | grep -q "^- AGENTS.md (레포에 없음)$" && echo "$OUT" | grep -q "갱신 제안"' "$OUT"
check "pack 설정 파일은 스크립트가 고치지 않는다" 'grep -q "\"add\":\[\"AGENTS.md\"\]" "$SYNC/athena.config.json"'

echo "delegate"
ATH="$TMP/ath"; mkdir -p "$ATH/plans/task" "$ATH/repos" "$ATH/packs/t" "$ATH/.claude/agents"
cp -R "$SRC/scripts" "$ATH/"; cp "$SRC/AGENTS.md" "$ATH/AGENTS.md"; cp "$SRC/.claude/settings.json" "$ATH/.claude/settings.json"
printf -- '---\nname: web-fe\ndescription: 웹\n---\n본문\n' > "$ATH/.claude/agents/web-fe.md"
printf '{"pack":"packs/t","reposRoot":".."}\n' > "$ATH/athena.config.json"
DEL="$TMP/delrepo"; git init -q -b main "$DEL"; echo agreement > "$DEL/WORKING-AGREEMENT.md"; python3 -c 'print("큰"*500)' > "$DEL/big.md"
$GIT -C "$DEL" add -A; $GIT -C "$DEL" commit -q -m init; ln -s "$DEL" "$ATH/repos/del"
pack_with() { printf '{"formatVersion":1,"id":"t","name":"t","repos":[{"name":"del","branch":"main","prBase":"main","kind":"single","agents":["web-fe"],"ruleDocs":%s}]}\n' "$1" > "$ATH/packs/t/pack.json"; }
cat > "$ATH/scripts/screen" <<'SH'
#!/bin/sh
case "$1 $2" in
  "inside "*) exit 0 ;;
  "self "*) echo "SCREEN_PANE_ID=lead1"; exit 0 ;;
  "name "*) echo 가짜화면 ;;
  "pane split") echo '{"pane":{"id":"p9"}}' ;;
esac
exit 0
SH
chmod +x "$ATH/scripts/screen"
printf '# d\n\n## Checkpoint\n- Status: in_progress\n- Work ref: 없음\n' > "$ATH/plans/task/d.md"
dispatch() { (cd "$ATH" && env -u ATHENA_AGENT bash scripts/delegate.sh web-fe --plan plans/task/d.md --cwd "$DEL" --here 지시문 2>&1); }
chars_of_last() { grep '"type":"delegate"' "$ATH/.events.jsonl" | tail -1 | sed -E 's/.*"contextChars":([0-9]+).*/\1/'; }
pack_with '{"add":["big.md"]}'; OUT="$(dispatch)"; WHOLE="$(chars_of_last)"
check "상한 안이면 안내 줄 없음 · 마지막 pane 줄 그대로" '! echo "$OUT" | grep -q "📄" && echo "$OUT" | grep -Eq "^p9  \(web-fe"' "$OUT"
pack_with '{"add":["big.md"],"maxChars":100}'; OUT="$(dispatch)"; LISTED="$(chars_of_last)"
check "팩 ruleDocs.maxChars 를 읽어 안내 줄이 pane 줄보다 앞에" '[ "$(echo "$OUT" | grep -n "📄" | head -1 | cut -d: -f1)" -lt "$(echo "$OUT" | grep -n "^p9  " | cut -d: -f1)" ]' "$OUT"
check "사건 contextChars 가 절 크기를 따라간다" '[ "$WHOLE" -gt "$LISTED" ] && [ "$LISTED" -gt 0 ]' "whole=$WHOLE listed=$LISTED"
pack_with '{"exclude":["WORKING-AGREEMENT.md","big.md"]}'; dispatch >/dev/null; NONE="$(chars_of_last)"
check "exclude 로 빼면 그만큼 줄어든다" '[ "$NONE" -lt "$LISTED" ]' "listed=$LISTED none=$NONE"

echo
[ "$FAIL" = 0 ] && echo "✅ 모두 통과" || echo "❌ 실패 있음"
exit "$FAIL"
