#!/usr/bin/env bash
# 임시 본체·가짜 CLI로 학습 검토와 Codex 기록을 확인한다.
. "$(dirname "$0")/_lib.sh"
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
TASK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-learn-review-test.XXXXXX")"
trap 'rm -rf "$TASK_TMP"' EXIT
cp -R "$SRC/scripts" "$TASK_TMP/scripts"
printf '{"repos":[],"models":{"learnReview":{"claude":"sonnet","codex":"gpt-test-learn"}}}' > "$TASK_TMP/athena.config.json"
mkdir -p "$TASK_TMP/docs/knowledge" "$TASK_TMP/bin" "$TASK_TMP/codex/sessions/2026/11/03" "$TASK_TMP/claude-only" "$TASK_TMP/codex-only"
cat > "$TASK_TMP/bin/claude" <<'CLI'
#!/bin/sh
if [ "$1 $2" = 'auth status' ]; then [ "${FAKE_CLAUDE_LOGIN:-in}" = in ]; exit $?; fi
cat >/dev/null
printf '%s\n' "$*" >> "$REVIEW_LOG"
# 사용량 한도 — 2026-11-03 PR 235~240 자동 리뷰 Claude 실행 기록의 모양(api_error usage_limit_reached · 글 · 종료 1)
if [ "${FAKE_CLAUDE:-}" = limit ]; then printf '%s' '{"type":"result","is_error":true,"api_error":"usage_limit_reached","result":"You'"'"'ve hit your weekly limit · resets 4am (Asia/Seoul)"}'; exit 1; fi
printf '{"structured_output":{"items":[]},"total_cost_usd":0.01}'
CLI
cat > "$TASK_TMP/bin/codex" <<'CLI'
#!/bin/sh
if [ "$1 $2" = 'login status' ]; then [ "${FAKE_CODEX_LOGIN:-in}" = in ]; exit $?; fi
cat >/dev/null
printf '%s\n' "$*" >> "$REVIEW_LOG"
schema=''; out=''
while [ $# -gt 0 ]; do
  case "$1" in --output-schema) schema="$2";; -o) out="$2";; esac
  shift
done
"$TASK_NODE" --input-type=module -e 'import { readFileSync } from "node:fs"; const schema=JSON.parse(readFileSync(process.argv[1])); if(schema.additionalProperties!==false || schema.properties.items.items.additionalProperties!==false) process.exit(1)' "$schema" || exit 9
printf '{"items":[]}' > "$out"
CLI
chmod +x "$TASK_TMP/bin/claude" "$TASK_TMP/bin/codex"
cp "$TASK_TMP/bin/claude" "$TASK_TMP/claude-only/claude"
cp "$TASK_TMP/bin/codex" "$TASK_TMP/codex-only/codex"
TASK_NODE="$(command -v node)"; export TASK_NODE
export CODEX_HOME="$TASK_TMP/codex" REVIEW_LOG="$TASK_TMP/calls"
cd "$TASK_TMP"
for tools in bin claude-only codex-only; do
  : > "$REVIEW_LOG"
  env PATH="$TASK_TMP/$tools:/usr/bin:/bin" "$TASK_NODE" --input-type=module -e 'import assert from "node:assert/strict"; import { askReviewer } from "./scripts/learn-review.mjs"; assert.deepEqual(askReviewer("후보 없음").items, [])'
  if [ "$tools" = codex-only ]; then
    grep -q -- '-m gpt-test-learn' "$REVIEW_LOG"
    grep -q -- '--disable shell_tool' "$REVIEW_LOG"
    grep -q -- '--ignore-user-config' "$REVIEW_LOG"
  else grep -q -- '--tools' "$REVIEW_LOG"; fi
  echo "  ✔ $tools 학습 검토 — 같은 items 형식"
done
: > "$REVIEW_LOG"
env PATH="$TASK_TMP/bin:/usr/bin:/bin" FAKE_CLAUDE_LOGIN=out "$TASK_NODE" --input-type=module -e 'import { askReviewer } from "./scripts/learn-review.mjs"; askReviewer("후보 없음")'
grep -q -- '-m gpt-test-learn' "$REVIEW_LOG"
echo '  ✔ Claude 로그인 안 됨 → Codex 학습 검토'
env PATH="$TASK_TMP/bin:/usr/bin:/bin" FAKE_CLAUDE_LOGIN=out FAKE_CODEX_LOGIN=out "$TASK_NODE" --input-type=module -e 'import assert from "node:assert/strict"; import { askReviewer } from "./scripts/learn-review.mjs"; assert.throws(()=>askReviewer("x"), /로그인된/)'
echo '  ✔ 둘 다 로그인 안 됨 → 명시적 실패'
# #19 — Claude 사용량 한도면 Codex 로 이어 간다(고치기 전: '학습 검토 실패' 로 멈췄다) · Codex 가 없으면 한도라고 밝혀 실패
: > "$REVIEW_LOG"
env PATH="$TASK_TMP/bin:/usr/bin:/bin" FAKE_CLAUDE=limit "$TASK_NODE" --input-type=module -e 'import assert from "node:assert/strict"; import { askReviewer } from "./scripts/learn-review.mjs"; assert.deepEqual(askReviewer("후보 없음").items, [])' >/dev/null
grep -q -- '--tools' "$REVIEW_LOG" && grep -q -- '-m gpt-test-learn' "$REVIEW_LOG" || { echo '  ✖ Claude 한도 → Codex 로 안 넘어감'; exit 1; }
echo '  ✔ Claude 사용량 한도 → Codex 학습 검토'
env PATH="$TASK_TMP/bin:/usr/bin:/bin" FAKE_CLAUDE=limit FAKE_CODEX_LOGIN=out "$TASK_NODE" --input-type=module -e 'import assert from "node:assert/strict"; import { askReviewer } from "./scripts/learn-review.mjs"; assert.throws(()=>askReviewer("x"), /사용량 한도/)'
echo '  ✔ Claude 한도 · Codex 없음 → 한도라고 밝혀 실패'
# #18 — 본체 주 도구가 codex 면 Codex 먼저(Claude 는 부르지 않음) · 기록이 없으면 Claude 먼저(위 bin 경우)
: > "$REVIEW_LOG"; printf '{"main":"codex"}\n' > "$TASK_TMP/.athena-main-tool.json"
env PATH="$TASK_TMP/bin:/usr/bin:/bin" "$TASK_NODE" --input-type=module -e 'import { askReviewer } from "./scripts/learn-review.mjs"; askReviewer("후보 없음")'
grep -q -- '-m gpt-test-learn' "$REVIEW_LOG" && ! grep -q -- '--tools' "$REVIEW_LOG" || { echo '  ✖ 주 도구 codex 인데 Claude 를 먼저 불렀다'; exit 1; }
rm -f "$TASK_TMP/.athena-main-tool.json"
echo '  ✔ 주 도구 codex → Codex 먼저'
"$TASK_NODE" --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findTranscripts, condense } from './scripts/learn-review.mjs'
const file = join(process.env.CODEX_HOME, 'sessions/2026/11/03/rollout-test.jsonl')
const header = `이 작업의 계획서: ${process.cwd()}/plans/task/test.md — 계속`
const records = [
  {type:'session_meta',payload:{cwd:process.cwd()}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions\n<INSTRUCTIONS>규칙</INSTRUCTIONS>'}]}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>작업 자리</environment_context>'}]}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:header}]}},
  {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'결과 확인'}]}},
  {type:'event_msg',payload:{type:'agent_message',message:'중복 금지'}},
  {type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'node --check scripts/x.mjs'})}},
  {type:'response_item',payload:{type:'function_call_output',output:'결과 본문 금지'}},
]
writeFileSync(file, records.map(record=>JSON.stringify(record)).join('\n')+'\n')
assert.ok((await findTranscripts('plans/task/test.md')).includes(file))
assert.ok(!(await findTranscripts('plans/task/other.md')).includes(file))
const text = await condense(file)
assert.ok(text.includes('👤 '+header) && text.includes('🤖 결과 확인'))
assert.ok(text.includes('🔧 exec_command: node --check'))
assert.ok(!text.includes('중복 금지') && !text.includes('결과 본문 금지'))
console.log('  ✔ Codex 기록 검색·요약 — 계획서 구분, 중복·도구 결과 제외')
JS
mkdir -p "$TASK_TMP/docs/knowledge/athena" "$TASK_TMP/issues" "$TASK_TMP/.claude/skills"
echo '# 함정' > "$TASK_TMP/docs/knowledge/athena/gotchas.md"
"$TASK_NODE" --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeIssue } from './scripts/learn-review.mjs'
import { listLearn, applyLearn } from './scripts/board/learn.mjs'
const item = { kind: 'guard', knowledge: 'athena', section: '직접 커밋', scope: 'app/x', skill: '', title: '직접 커밋 막기', explain: '설명', rule: 'commit-guard.py 에 직접 커밋을 막고 commit.sh 를 안내', basis: 'run', evidence: '직접 커밋됨', strengthen: '옛 줄', repeatOf: '', ifUnknown: '또 직접 커밋', signal: 'done' }
const file = writeIssue(item, 'plans/task/t.md', false).match(/issues\/(\S+\.md)/)[1]
const text = readFileSync(`issues/${file}`, 'utf8')
assert.match(text, /^target: guard:athena#직접 커밋$/m)
assert.match(text, /^## 정비할 곳\n.*commit-guard/m)
assert.ok(!/^scope:|^strengthen:|## 공책에 넣을 문장/m.test(text))
const card = listLearn().candidates.find((candidate) => candidate.id === `issues/${file}`)
assert.equal(card.guard, true)
assert.equal(card.rule, item.rule)
assert.match(applyLearn(`issues/${file}`).error, /정비 후보/)
console.log('  ✔ 정비 후보(guard) — 이슈 쓰기 · [학습] 탭 읽기 · 공책에 넣기 거부')
JS
echo '✅ 통과'
