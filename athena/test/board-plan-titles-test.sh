#!/usr/bin/env bash
# 보관 뒤에도 사건의 원래 계획서 경로로 제목을 찾는지 확인한다.
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
node --input-type=module - <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planTitles } from './scripts/board/plan-titles.mjs'
const root = mkdtempSync(join(tmpdir(), 'board-plan-titles-'))
const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
const check = (name, test) => { test(); console.log(`  ✔ ${name}`) }
try {
  put('plans/task/current.md', '# **진행 중 계획**\n')
  put('archive/old/meta.json', JSON.stringify({ title: '묶인 이슈 제목', from: { plan: 'plans/task/old.md' } }))
  put('archive/old/plan.md', '# 보관된 계획서 제목\n')
  put('archive/broken/meta.json', '{')
  put('archive/metadata-only/meta.json', JSON.stringify({ kind: 'plan', title: '옛 계획 제목', from: { plan: 'plans/task/meta.md' } }))
  const result = planTitles(root, ['plans/task/current.md', 'plans/task/old.md', 'plans/task/meta.md', 'plans/task/missing.md', 'plans/../../private.md'])
  check('현재 계획서는 본문 제목과 존재 여부를 반환', () => assert.deepEqual(result.get('plans/task/current.md'), { title: '진행 중 계획', exists: true, archived: false }))
  check('보관된 계획서는 원래 경로로 본문 제목을 복원(이슈 제목보다 우선)', () => assert.deepEqual(result.get('plans/task/old.md'), { title: '보관된 계획서 제목', exists: false, archived: true }))
  check('본문 없는 옛 보관 기록은 메타 제목 사용', () => assert.equal(result.get('plans/task/meta.md').title, '옛 계획 제목'))
  check('원본과 보관 기록이 없으면 제목을 만들어 내지 않음', () => assert.deepEqual(result.get('plans/task/missing.md'), { title: '', exists: false, archived: false }))
  check('상위 경로 조회 차단', () => assert.equal(result.get('plans/../../private.md').title, ''))
  put('plans/task/old.md', '# 새 원본 제목\n')
  check('같은 경로가 다시 생기면 현재 원본 우선', () => assert.equal(planTitles(root, ['plans/task/old.md']).get('plans/task/old.md').title, '새 원본 제목'))
  put('archive/bundle/meta.json', JSON.stringify({ kind: 'issue', title: '연결 이슈 제목', from: { issue: 'issues/a.md', plan: 'plans/task/bundle.md' } }))
  check('이슈 묶음은 계획서 본문이 없으면 이슈 제목으로 대체하지 않음', () => assert.equal(planTitles(root, ['plans/task/bundle.md']).get('plans/task/bundle.md').title, ''))
  put('archive/bundle/plan.md', '## 제목 없는 본문\n')
  check('이슈 묶음 계획서에 제목이 없어도 이슈 제목은 쓰지 않음', () => assert.equal(planTitles(root, ['plans/task/bundle.md']).get('plans/task/bundle.md').title, ''))
  put('archive/bundle/plan.md', '# 실제 계획서 제목\n')
  check('이슈 묶음도 계획서 본문 제목이 있으면 복원', () => assert.equal(planTitles(root, ['plans/task/bundle.md']).get('plans/task/bundle.md').title, '실제 계획서 제목'))
  console.log('✅ 통과')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
