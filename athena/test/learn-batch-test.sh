#!/usr/bin/env bash
# 학습 후보 줄이기 · 묶음 넣기 시험 — 임시 폴더에 scripts 를 복사해 돈다(진짜 issues · 공책을 건드리지 않는다) · 몇 초
#   1) scripts/lib/learn-seen.mjs decideGate — run 은 바로 · code 첫 번째는 보류 · 두 번째(repeatOf)는 열기 · 열린 이슈면 반복 +1
#   2) scripts/board/learn.mjs applyBatch — 레포별 묶음 · 같은 문장 합치기 · 넣는 동작은 applyLearn 과 같다
#
# 사용: test/learn-batch-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-learn-batch-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
cp -R "$SRC/scripts" "$TMP/scripts"
mkdir -p "$TMP/issues" "$TMP/docs/knowledge/alpha" "$TMP/docs/knowledge/beta"
printf '# alpha 함정\n\n- 기존 줄\n' > "$TMP/docs/knowledge/alpha/gotchas.md"
printf '# beta 함정\n' > "$TMP/docs/knowledge/beta/gotchas.md"
issue() {   # <파일> <target> <문장> [scope]
  printf -- '---\ntitle: %s\nstatus: open\nrepo: athena\nkind: knowledge\nsignal: review\nsource: plans/x.md (배우기 검토자 · done)\nbasis: run\ntarget: %s\n%s---\n\n## 무엇을 배웠나\n설명\n\n## 왜 중요한가\n모르면 틀린다\n\n## 공책에 넣을 문장\n%s\n\n## 어디서 배웠나\n- plans/x.md — 근거\n' "$3" "$2" "${4:+scope: $4
}" "$3" > "$TMP/issues/$1"
}
issue 20261030-alpha-learn-a1.md docs/knowledge/alpha/gotchas.md#학습 "규칙 하나는 이렇다."
issue 20261030-alpha-learn-a2.md docs/knowledge/alpha/gotchas.md#학습 "규칙 하나는 이렇다."
issue 20261030-alpha-learn-a3.md docs/knowledge/alpha/gotchas.md#학습 "규칙 둘은 저렇다."
issue 20261030-beta-learn-b1.md docs/knowledge/beta/gotchas.md#학습 "베타 규칙."
FAIL=0
check() { if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; FAIL=1; fi; }

OUT="$(cd "$TMP" && node --input-type=module -e "
import { decideGate } from './scripts/lib/learn-seen.mjs'
import { applyBatch, listLearn } from './scripts/board/learn.mjs'
const out = {}
const seen = [{ id: 'seen-aaaaaa' }]
const gate = (item) => decideGate({ item, seen, openFiles: ['x-learn-y.md'] }).action
out.run = gate({ kind: 'gotchas', basis: 'run' })
out.codeFirst = gate({ kind: 'gotchas', basis: 'code' })
out.codeSecond = gate({ kind: 'gotchas', basis: 'code', repeatOf: 'seen-aaaaaa' })
out.openRepeat = gate({ kind: 'gotchas', basis: 'code', repeatOf: 'x-learn-y.md' })
out.unknownRepeat = gate({ kind: 'gotchas', basis: 'code', repeatOf: 'seen-zzzzzz' })
out.skill = gate({ kind: 'skill', basis: 'code' })
const before = listLearn()
out.batches = before.batches.map((batch) => batch.notebook + ':' + batch.items.length + ':' + batch.items.map((item) => item.dups.length).join(','))
const first = before.batches.find((batch) => batch.notebook.includes('alpha')).items.map((item) => item.id)
out.result = applyBatch(first)
out.after = listLearn().candidates.map((item) => item.id)
console.log(JSON.stringify(out))
")"
j() { node -e "const o=JSON.parse(process.argv[1]); console.log(eval(process.argv[2]))" "$OUT" "$1"; }
check "run 근거는 바로 연다" '[ "$(j o.run)" = open ]'
check "code 첫 번째는 보류" '[ "$(j o.codeFirst)" = hold ]'
check "code 두 번째(한 번 본 후보를 가리킴)는 연다" '[ "$(j o.codeSecond)" = repeat-seen ]'
check "열린 이슈를 가리키면 반복 +1" '[ "$(j o.openRepeat)" = repeat-open ]'
check "없는 id 를 가리키면 첫 번째와 같이 보류" '[ "$(j o.unknownRepeat)" = hold ]'
check "스킬 후보는 기존대로" '[ "$(j o.skill)" = open ]'
check "묶음은 공책별 · 같은 문장은 하나(합친 수 1)" '[ "$(j "o.batches.join(\"|\")")" = "docs/knowledge/alpha/gotchas.md:2:1,0|docs/knowledge/beta/gotchas.md:1:0" ]'
check "묶음 넣기 — 2개 넣고 1개 합침" '[ "$(j "o.result.applied+\",\"+o.result.merged+\",\"+o.result.errors.length")" = "2,1,0" ]'
check "넣은 뒤 alpha 후보는 모두 사라지고 beta 만 남음" '[ "$(j "o.after.join(\",\")")" = "issues/20261030-beta-learn-b1.md" ]'
check "공책에 한 줄씩 들어감(중복 없음)" '[ "$(grep -c "<!-- learn:" "$TMP/docs/knowledge/alpha/gotchas.md")" = 2 ]'
check "합친 후보는 기록에 덧붙임" 'grep -q "하나로 합쳤어요" "$TMP"/docs/knowledge/learned/*a1*.md'
echo
[ "$FAIL" = 0 ] && echo "✔ 모두 통과" || echo "✖ 실패 있음"
exit "$FAIL"
