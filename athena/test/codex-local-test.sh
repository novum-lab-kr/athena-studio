#!/usr/bin/env bash
# Codex 로컬 재개·백업·개인 메모리 — 임시 폴더만 사용한다.
. "$(dirname "$0")/_lib.sh"
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexSessionExists } from './scripts/lib/codex-local.mjs'
import { codexMemorySources } from './scripts/board/codex-memory.mjs'
import { captureRestore, checkRestore, restoreWork } from './scripts/lib/restore.mjs'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-test-'))
const before = process.env.CODEX_HOME
process.env.CODEX_HOME = path.join(temp, 'codex')
let passed = 0
const check = (label, work) => { work(); passed++; console.log(`  ✔ ${label}`) }
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
try {
  const home = process.env.CODEX_HOME
  check('메모리 저장소가 없어도 두 출처는 비어 있음', () => assert.deepEqual(codexMemorySources(home).map(source => source.items), [[], []]))
  write(path.join(home, 'memories/MEMORY.md'), '# 기억\n\n작업 규칙')
  write(path.join(home, 'memories_v2/entries/a.md'), '# 다른 기억\n\n다른 규칙')
  write(path.join(home, 'memories_v2/ignore.json'), '{}')
  write(path.join(temp, 'outside.md'), '# 읽으면 안 되는 링크')
  fs.symlinkSync(path.join(temp, 'outside.md'), path.join(home, 'memories/link.md'))
  fs.symlinkSync(path.join(temp), path.join(home, 'memories/link-dir'))
  check('두 저장소 Markdown만 읽고 링크는 따라가지 않음', () => {
    const sources = codexMemorySources(home)
    assert.deepEqual(sources.map(source => source.items.map(item => item.file)), [['MEMORY.md'], ['entries/a.md']])
    assert.equal(sources[0].items[0].body, '# 기억\n\n작업 규칙')
  })
  const session = '12345678-abcd-1234-abcd-123456789abc'
  const rollout = path.join(home, `sessions/2026/11/03/rollout-2026-11-03-${session}.jsonl`)
  check('다른 컴퓨터의 세션 id만으로는 재개하지 않음', () => assert.equal(codexSessionExists(session, home), false))
  write(rollout, JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: temp } })+'\n')
  check('같은 컴퓨터의 실제 기록은 찾음', () => assert.equal(codexSessionExists(session, home), true))
  const root = path.join(temp, 'body'), pack = path.join(temp, 'pack'), top = path.join(temp, 'backup')
  fs.mkdirSync(root)
  write(path.join(pack, 'state/pane-sessions/p1.json'), JSON.stringify({ session, engine: 'codex', agent: 'athena', cwd: root }))
  const capture = captureRestore(root, pack, top, { panes: ['p1','p404'] })
  check('백업은 Codex 엔진·세션을 보존하고 이식할 transcript는 담지 않음', () => {
    assert.equal(capture.sessions, 1)
    assert.deepEqual(capture.missing, ['p404'])
    const data = JSON.parse(fs.readFileSync(path.join(top, 'restore/restore.json')))
    assert.equal(data.version, 2)
    assert.equal(data.sessions[0].engine, 'codex')
    assert.equal(data.sessions[0].transcript, false)
    assert.equal(fs.existsSync(path.join(top, 'restore/transcripts')), false)
    assert.equal(checkRestore(path.join(top, 'restore')).athena, 1)
  })
  fs.cpSync(path.join(top, 'restore'), path.join(pack, 'state/restore'), { recursive: true })
  check('로컬 Codex 대화는 앱에 같은 엔진으로 넘기고 ack 전에는 남김', () => {
    const result = restoreWork(root, pack, { agents: false })
    assert.equal(result.athena[0].engine, 'codex')
    assert.equal(result.athena[0].session, session)
    assert.equal(result.pending, true)
  })
  fs.unlinkSync(rollout)
  check('로컬 대화가 없어졌으면 아테나 재개도 건너뛰고 기록을 보존', () => {
    const result = restoreWork(root, pack, { agents: false })
    assert.equal(result.athena.length, 0)
    assert.equal(result.sessions[0].reason, 'local-session-missing')
    assert.equal(result.pending, true)
  })
  const file = path.join(top, 'restore/restore.json'), data = JSON.parse(fs.readFileSync(file))
  data.sessions[0].engine = 'bad'
  write(file, JSON.stringify(data))
  check('백업의 미지원 엔진은 거부', () => assert.throws(() => checkRestore(path.join(top, 'restore'))))
  delete data.sessions[0].engine
  data.version = 1
  write(file, JSON.stringify(data))
  check('엔진 없는 예전 Claude 백업은 계속 허용', () => assert.equal(checkRestore(path.join(top, 'restore')).sessions, 1))
  console.log(`✅ ${passed}개 통과`)
} finally {
  if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before
  fs.rmSync(temp, { recursive: true, force: true })
}
JS
