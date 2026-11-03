#!/usr/bin/env bash
# 팀 리드 규칙·스킬의 공통 정본과 Claude·Codex 리드 분류. 사용자 본체·프로세스는 건드리지 않는다.
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
node --input-type=module - "$SRC" <<'JS'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.argv[2]
const { boardPaneOf } = await import(pathToFileURL(join(source, 'scripts/board/plan-bind.mjs')))
const { busyScan, settleIdleSessions } = await import(pathToFileURL(join(source, 'scripts/lib/packs.mjs')))
const { packLinks } = await import(pathToFileURL(join(source, 'scripts/lib/overlay.mjs')))
const temporary = mkdtempSync(join(tmpdir(), 'athena-lead-parity-'))
let failures = 0
const check = (name, run) => {
  try { run(); console.log(`  ✔ ${name}`) } catch (error) { failures += 1; console.log(`  ✖ ${name}\n      ${error.message}`) }
}
try {
  const root = join(temporary, 'body')
  mkdirSync(root)
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.agents', '.claude/skills', 'docs/team-lead.md']) {
    cpSync(join(source, name), join(root, name), { recursive: true, verbatimSymlinks: true })
  }
  const common = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  const lead = readFileSync(join(root, 'docs/team-lead.md'), 'utf8')
  check('Claude와 Codex가 같은 리드 정본을 읽고 위임 컨텍스트에서는 빠진다', () => {
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /@docs\/team-lead\.md/)
    assert.match(common, /먼저 `docs\/team-lead.md`와 `pack\/ROUTING.md`를 읽고/)
    assert.doesNotMatch(common.replace(/<!-- lead-only\b[\s\S]*?<!-- \/lead-only -->\n?/g, ''), /docs\/team-lead.md/)
    for (const section of ['갈래', '일하는 방식', 'Plan-First', '1단계:', '6단계:']) assert.ok(lead.includes(section))
    assert.ok(Buffer.byteLength(common) < 32768, '기본 프로젝트 지침 크기 한도')
    const routingImport = lead.match(/^@(.+ROUTING\.md)$/m)?.[1]
    assert.ok(routingImport, 'Claude 라우팅 import')
    assert.equal(resolve(root, 'docs', routingImport), join(root, 'pack/ROUTING.md'))
  })
  check('복사된 본체에서도 일곱 Codex 스킬은 Claude 정본을 가리킨다', () => {
    assert.ok(lstatSync(join(root, '.agents/skills')).isSymbolicLink())
    for (const name of ['call', 'monitor', 'board', 'sync', 'guide', 'setup', 'diagram']) {
      assert.equal(realpathSync(join(root, '.agents/skills', name, 'SKILL.md')), realpathSync(join(root, '.claude/skills', name, 'SKILL.md')))
    }
  })
  check('팩 스킬 링크 추가·제거가 Codex에도 보이고 공통 스킬 링크는 팩 정리 대상이 아니다', () => {
    const company = join(root, 'pack/skills/company')
    mkdirSync(company, { recursive: true })
    writeFileSync(join(company, 'SKILL.md'), '---\nname: company\ndescription: 시험\n---\n')
    symlinkSync('../../pack/skills/company', join(root, '.claude/skills/company'))
    assert.equal(realpathSync(join(root, '.agents/skills/company/SKILL.md')), realpathSync(join(company, 'SKILL.md')))
    assert.ok(packLinks(root).includes('.claude/skills/company'))
    assert.ok(!packLinks(root).includes('.agents/skills'))
    rmSync(join(root, '.claude/skills/company'))
    assert.throws(() => realpathSync(join(root, '.agents/skills/company/SKILL.md')))
  })
  for (const engines of [['claude'], ['codex'], ['claude', 'codex']]) {
    for (const engine of engines) {
      check(`${engines.join('+')} — ${engine} 본체 리드 · 위임 · 다른 폴더 구분`, () => {
        const pane = { id: 'p1', agent: engine, cwd: root, agent_status: 'waiting' }
        assert.equal(boardPaneOf(pane, root, temporary).role, 'hermes')
        assert.equal(boardPaneOf(pane, root, temporary).agent, '아테나')
        assert.equal(boardPaneOf(pane, root, temporary).tool, engine)
        assert.equal(boardPaneOf(pane, root, temporary).status, 'waiting')
        assert.equal(boardPaneOf({ ...pane, label: '🤖 fe · feat/test' }, root, temporary).role, 'agent')
        assert.equal(boardPaneOf({ ...pane, cwd: join(root, 'repos/web') }, root, temporary).role, 'other')
      })
    }
    check(`${engines.join('+')} — 팩 리드 분류와 같은 도구 idle 제외 · waiting 유지`, () => {
      const agents = engines.map((engine, index) => ({ comm: engine, pid: 900000 + index, ppid: 800000 + index }))
      const table = agents.map((row, index) => [row, { comm: 'zsh', pid: row.ppid, ppid: 1 }]).flat()
      const scan = { table, mine: new Set(), agents, cwds: new Map(agents.map((row) => [row.pid, root])), known: true }
      const { busy, known } = busyScan(root, scan)
      assert.equal(known, true)
      assert.equal(busy.length, engines.length)
      assert.ok(busy.every((item) => item.kind === 'athena'))
      const panes = agents.map((row) => ({ id: `p${row.pid}`, pid: row.ppid, agent: row.comm, status: 'idle' }))
      assert.equal(settleIdleSessions(busy, table, panes).length, 0)
      assert.equal(settleIdleSessions(busy, table, panes.map((pane) => ({ ...pane, status: 'waiting' }))).length, engines.length)
      assert.equal(settleIdleSessions(busy, table, panes.map((pane) => ({ ...pane, agent: 'other' }))).length, engines.length)
      const legacy = { ...scan, cwds: new Map(agents.map((row) => [row.pid, join(root, '.worktrees/feat/test')])) }
      assert.deepEqual(busyScan(root, legacy).busy.map((item) => item.kind), engines.map((engine) => engine === 'codex' ? 'codex' : 'agent'))
    })
  }
  check('옛 engine 없는 기록도 지금과 같이 idle을 제외한다', () => {
    for (const [kind, engine] of [['athena', 'claude'], ['agent', 'claude'], ['codex', 'codex']]) {
      assert.equal(settleIdleSessions([{ kind, pid: 201 }], [{ pid: 201, ppid: 200 }], [{ pid: 200, agent: engine, status: 'idle' }]).length, 0)
    }
  })
  const guide = readFileSync(join(source, 'scripts/guide-menu.sh'), 'utf8')
  const launch = guide.slice(guide.indexOf('ask_agent() {'), guide.indexOf('\n# 마크다운 뷰어:'))
  const binary = join(temporary, 'bin')
  mkdirSync(binary)
  mkdirSync(join(root, 'scripts/lib'), { recursive: true })
  for (const name of ['dispatch-engine.mjs', 'lib/main-tool.mjs', 'lib/is-main.mjs', 'lib/shell-line.sh']) {
    cpSync(join(source, 'scripts', name), join(root, 'scripts', name))
  }
  symlinkSync(process.execPath, join(binary, 'node'))
  const executable = (file, text) => { writeFileSync(file, `#!/bin/bash\n${text}\n`); chmodSync(file, 0o700) }
  executable(join(root, 'scripts/screen'), `case "$1 $2" in
    'inside ') exit 0;;
    'pane split') printf '{"pane":{"id":"p-test"}}';;
    'pane run') printf '%s' "$4" > "$GUIDE_CAPTURE";;
    'pane rename') exit 0;;
    *) exit 2;;
  esac`)
  for (const [available, remembered, expected] of [
    [['claude'], null, 'claude'], [['codex'], null, 'codex'],
    [['claude', 'codex'], null, 'claude'], [['claude', 'codex'], 'codex', 'codex'],
    [[], null, null],
  ]) {
    check(`가이드 스킬 실행 — ${available.join('+') || '없음'} · 주 도구 ${remembered || '기록 없음'}`, () => {
      for (const engine of ['claude', 'codex']) executable(join(binary, engine), `exit ${available.includes(engine) ? 0 : 1}`)
      if (remembered) writeFileSync(join(root, '.athena-main-tool.json'), JSON.stringify({ main: remembered }))
      else rmSync(join(root, '.athena-main-tool.json'), { force: true })
      const capture = join(temporary, 'guide-capture')
      rmSync(capture, { force: true })
      const env = { ...process.env, ATHENA_DIR: root, GUIDE_CAPTURE: capture, PATH: `${binary}:/usr/bin:/bin` }
      const script = `. "$ATHENA_DIR/scripts/lib/shell-line.sh"\n${launch}\nask_agent 'guide 설명'`
      if (!expected) { assert.throws(() => execFileSync('/bin/bash', ['-c', script], { env, stdio: 'pipe' })); return }
      execFileSync('/bin/bash', ['-c', script], { env, stdio: 'pipe' })
      const command = readFileSync(capture, 'utf8')
      const actual = execFileSync('/bin/bash', ['-c', `function ${expected}() { printf '%s' "$1"; }\n${command}`], { encoding: 'utf8', env })
      assert.equal(actual, `${expected === 'codex' ? '$' : '/'}guide 설명`)
    })
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
JS
