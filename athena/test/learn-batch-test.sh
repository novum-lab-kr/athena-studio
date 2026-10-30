#!/usr/bin/env bash
# 학습 후보 줄이기 · 묶음 넣기 시험 — 임시 폴더에 scripts 를 복사해 돈다(진짜 issues · 공책을 건드리지 않는다) · 몇 초
#   1) scripts/lib/learn-seen.mjs decideGate — run 은 바로 · code 첫 번째는 보류 · 두 번째(repeatOf)는 열기 · 열린 이슈면 반복 +1
#   2) scripts/board/learn.mjs applyBatch — 레포별 묶음 · 같은 문장 합치기 · 넣는 동작은 applyLearn 과 같다
#   3) 묶음 줄 수정(editCandidates) · 삭제(discardMany) — 합쳐진 후보 전부에 적용 · 묶음 대상은 낱개 목록과 겹치지 않음
#
# 사용: test/learn-batch-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-learn-batch-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
cp -R "$SRC/scripts" "$TMP/scripts"
mkdir -p "$TMP/issues" "$TMP/docs/knowledge/alpha" "$TMP/docs/knowledge/beta" "$TMP/docs/knowledge/gamma"
printf '# alpha 함정\n\n- 기존 줄\n' > "$TMP/docs/knowledge/alpha/gotchas.md"
printf '# beta 함정\n' > "$TMP/docs/knowledge/beta/gotchas.md"
printf '# gamma 함정\n\n- 감마 기존 줄\n' > "$TMP/docs/knowledge/gamma/gotchas.md"
issue() {   # <파일> <target> <문장> [scope]
  printf -- '---\ntitle: %s\nstatus: open\nrepo: athena\nkind: knowledge\nsignal: review\nsource: plans/x.md (배우기 검토자 · done)\nbasis: run\ntarget: %s\n%s---\n\n## 무엇을 배웠나\n설명\n\n## 왜 중요한가\n모르면 틀린다\n\n## 공책에 넣을 문장\n%s\n\n## 어디서 배웠나\n- plans/x.md — 근거\n' "$3" "$2" "${4:+scope: $4
}" "$3" > "$TMP/issues/$1"
}
issue 20261030-alpha-learn-a1.md docs/knowledge/alpha/gotchas.md#학습 "규칙 하나는 이렇다."
issue 20261030-alpha-learn-a2.md docs/knowledge/alpha/gotchas.md#학습 "규칙 하나는 이렇다."
issue 20261030-alpha-learn-a3.md docs/knowledge/alpha/gotchas.md#학습 "규칙 둘은 저렇다."
issue 20261030-beta-learn-b1.md docs/knowledge/beta/gotchas.md#학습 "베타 규칙."
issue 20261030-gamma-learn-g1.md docs/knowledge/gamma/gotchas.md#학습 "감마 규칙."
issue 20261030-gamma-learn-g2.md docs/knowledge/gamma/gotchas.md#학습 "감마 규칙."
issue 20261030-gamma-learn-g3.md docs/knowledge/gamma/gotchas.md#학습 "감마 다른 규칙."
printf -- '---\ntitle: 스킬 후보\nstatus: open\nkind: skill\nsignal: review\nsource: s (x · done)\nbasis: run\ntarget: skill:foo\n---\n\n## 공책에 넣을 문장\n스킬 문장\n' > "$TMP/issues/20261030-x-learn-skill.md"
FAIL=0
check() { if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; FAIL=1; fi; }

OUT="$(cd "$TMP" && node --input-type=module -e "
import { decideGate } from './scripts/lib/learn-seen.mjs'
import { readFileSync } from 'node:fs'
import { applyBatch, discardMany, editCandidates, listLearn } from './scripts/board/learn.mjs'
const out = {}
const seen = [{ id: 'seen-aaaaaa', target: 'T' }]
const gate = (item) => decideGate({ item, target: 'T', seen, openIssues: [{ file: 'x-learn-y.md', target: 'T' }] }).action
out.run = gate({ kind: 'gotchas', basis: 'run' })
out.codeFirst = gate({ kind: 'gotchas', basis: 'code' })
out.codeSecond = gate({ kind: 'gotchas', basis: 'code', repeatOf: 'seen-aaaaaa' })
out.openRepeat = gate({ kind: 'gotchas', basis: 'code', repeatOf: 'x-learn-y.md' })
out.unknownRepeat = gate({ kind: 'gotchas', basis: 'code', repeatOf: 'seen-zzzzzz' })
out.runSeen = gate({ kind: 'gotchas', basis: 'run', repeatOf: 'seen-aaaaaa' })
out.otherTarget = decideGate({ item: { kind: 'gotchas', basis: 'code', repeatOf: 'seen-aaaaaa' }, target: 'U', seen, openIssues: [] }).action
out.otherTargetOpen = decideGate({ item: { kind: 'gotchas', basis: 'code', repeatOf: 'x-learn-y.md' }, target: 'U', seen, openIssues: [{ file: 'x-learn-y.md', target: 'T' }] }).action
out.skill = gate({ kind: 'skill', basis: 'code' })
const before = listLearn()
out.batches = before.batches.map((batch) => batch.notebook + ':' + batch.items.length + ':' + batch.items.map((item) => item.dups.length).join(','))
const first = before.batches.find((batch) => batch.notebook.includes('alpha')).items.map((item) => item.id)
out.result = applyBatch(first)
out.after = listLearn().candidates.map((item) => item.id).filter((id) => !id.includes('gamma') && !id.includes('skill'))
const all = listLearn()
const inBatch = new Set(all.batches.flatMap((batch) => batch.items.flatMap((item) => [item.id, ...item.dups])))
out.skillNotBatched = !inBatch.has('issues/20261030-x-learn-skill.md')
out.singleBatch = all.batches.some((batch) => batch.notebook.includes('beta') && batch.items.length === 1)
out.rowInfo = ['explain', 'why', 'where', 'basis', 'signal', 'source'].every((key) => key in all.batches[0].items[0])
const gamma = listLearn().batches.find((batch) => batch.notebook.includes('gamma')).items.find((item) => item.dups.length)
out.edit = editCandidates([gamma.id, ...gamma.dups], { title: '새 제목', explain: '새 설명', why: '새 이유', rule: '감마 규칙 고침.' })
out.editBad = editCandidates(['issues/20261030-x-learn-skill.md'], { title: 'x' })
const edited = listLearn()
out.editedItems = edited.candidates.filter((item) => item.id.includes('gamma')).map((item) => [item.title, item.explain, item.why, item.rule].join('/'))
out.editedBatch = edited.batches.find((batch) => batch.notebook.includes('gamma')).items.map((item) => item.dups.length)
out.noteUntouched = !readFileSync('docs/knowledge/gamma/gotchas.md', 'utf8').includes('learn:')
out.discard = discardMany([gamma.id, ...gamma.dups])
out.afterDiscard = listLearn().candidates.filter((item) => item.id.includes('gamma')).map((item) => item.id)
console.log(JSON.stringify(out))
")"
j() { node -e "const o=JSON.parse(process.argv[1]); console.log(eval(process.argv[2]))" "$OUT" "$1"; }
check "run 근거는 바로 연다" '[ "$(j o.run)" = open ]'
check "code 첫 번째는 보류" '[ "$(j o.codeFirst)" = hold ]'
check "code 두 번째(한 번 본 후보를 가리킴)는 연다" '[ "$(j o.codeSecond)" = repeat-seen ]'
check "열린 이슈를 가리키면 반복 +1" '[ "$(j o.openRepeat)" = repeat-open ]'
check "없는 id 를 가리키면 첫 번째와 같이 보류" '[ "$(j o.unknownRepeat)" = hold ]'
check "run 후보가 한 번 본 후보를 가리켜도 처음 본 곳을 잇는다" '[ "$(j o.runSeen)" = repeat-seen ]'
check "target 이 다르면 같은 문장이어도 한 번 본 후보로 안 친다" '[ "$(j o.otherTarget)" = hold ]'
check "target 이 다르면 열린 이슈에도 반복 +1 을 안 붙인다" '[ "$(j o.otherTargetOpen)" = hold ]'
check "스킬 후보는 기존대로" '[ "$(j o.skill)" = open ]'
check "묶음은 공책별 · 같은 문장은 하나(합친 수 1)" '[ "$(j "o.batches.join(\"|\")")" = "docs/knowledge/alpha/gotchas.md:2:1,0|docs/knowledge/gamma/gotchas.md:2:1,0|docs/knowledge/beta/gotchas.md:1:0" ]'
check "묶음 넣기 — 2개 넣고 1개 합침" '[ "$(j "o.result.applied+\",\"+o.result.merged+\",\"+o.result.errors.length")" = "2,1,0" ]'
check "넣은 뒤 alpha 후보는 모두 사라지고 beta 만 남음" '[ "$(j "o.after.join(\",\")")" = "issues/20261030-beta-learn-b1.md" ]'
check "공책에 한 줄씩 들어감(중복 없음)" '[ "$(grep -c "<!-- learn:" "$TMP/docs/knowledge/alpha/gotchas.md")" = 2 ]'
check "합친 후보는 기록에 덧붙임" 'grep -q "하나로 합쳤어요" "$TMP"/docs/knowledge/learned/*a1*.md'
check "스킬 후보는 묶음에 안 들어감" '[ "$(j o.skillNotBatched)" = true ]'
check "후보 1개뿐인 공책도 묶음으로 나옴" '[ "$(j o.singleBatch)" = true ]'
check "묶음 줄에 내용 · 판단 정보가 실림" '[ "$(j o.rowInfo)" = true ]'
check "수정 — 합쳐진 후보 2개 모두 고침" '[ "$(j o.edit.edited)" = 2 ]'
check "수정 값이 후보 파일에 반영(제목 · 설명 · 이유 · 문장)" '[ "$(j "o.editedItems.filter((x) => x === \"새 제목/새 설명/새 이유/감마 규칙 고침.\").length")" = 2 ]'
check "수정해도 같은 문장 합침이 유지됨" '[ "$(j "o.editedBatch.join(\",\")")" = "1,0" ]'
check "수정은 공책에 넣지 않음" '[ "$(j o.noteUntouched)" = true ]'
check "묶음 대상이 아닌 후보 수정은 거절" '[ -n "$(j o.editBad.error)" ] && [ "$(j o.editBad.error)" != undefined ]'
check "삭제 — 합쳐진 후보 전부 사라짐(남은 후보가 다시 안 나타남)" '[ "$(j "o.afterDiscard.join(\",\")")" = "issues/20261030-gamma-learn-g3.md" ]'
check "삭제한 후보는 휴지통에 있음" '[ "$(find "$TMP/.board-trash" -name "*gamma-learn-g[12]*" | wc -l | tr -d " ")" = 2 ]'
echo
[ "$FAIL" = 0 ] && echo "✔ 모두 통과" || echo "✖ 실패 있음"
exit "$FAIL"
