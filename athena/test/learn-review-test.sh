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
echo '✅ 통과'
