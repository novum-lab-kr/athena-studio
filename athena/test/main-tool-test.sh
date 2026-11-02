#!/usr/bin/env bash
# 공용 주 도구 판정(scripts/lib/main-tool.mjs) — 가짜 CLI만 사용, 인증 출력 폐기.
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticated, readMainTool, writeMainTool, toolDecision } from './scripts/lib/main-tool.mjs'
const root = mkdtempSync(join(tmpdir(), 'athena-main-tool-'))
try {
  for (const available of [[], ['claude'], ['codex'], ['claude', 'codex']]) {
    const decision = toolDecision(available)
    assert.equal(decision.choose, available.length === 2)
    assert.equal(decision.main, available.length === 1 ? available[0] : null)
  }
  for (const main of ['claude', 'codex']) {
    writeMainTool(root, main)
    assert.equal(readMainTool(root), main)
    const d = toolDecision(['claude', 'codex'], readMainTool(root))
    assert.equal(d.main, main)
    assert.notEqual(d.secondary, main)
    for (const status of [0, 1]) {
      const file = join(root, main)
      writeFileSync(file, `#!/bin/sh\necho SECRET\necho SECRET >&2\nexit ${status}\n`, { mode: 0o755 })
      assert.equal(await authenticated(file, main, process.env), status === 0)
    }
  }
  assert.equal(await authenticated(join(root, 'absent'), 'codex', process.env), false)
  console.log('✅ 주 도구 공용 판정 · 기록 · 인증 출력 폐기 통과')
} finally { rmSync(root, { recursive: true, force: true }) }
JS
