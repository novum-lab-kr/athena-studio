#!/usr/bin/env bash
# 서비스 다이어그램 연결 회귀 시험 — 임시 본체·팩·git 레포만 사용한다.
. "$(dirname "$0")/_lib.sh"
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
node --input-type=module - "$SRC" <<'JS'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const source = process.argv[2]
const root = mkdtempSync(join(tmpdir(), 'athena-diagram-'))
const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text) }
const run = (script, ...args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8' })
let failures = 0
const check = (name, test) => { try { test(); console.log(`  ✔ ${name}`) } catch (error) { failures++; console.log(`  ✖ ${name}\n${error.message}`) } }
try {
  cpSync(join(source, 'scripts'), join(root, 'scripts'), { recursive: true })
  cpSync(join(source, '.claude/skills'), join(root, '.claude/skills'), { recursive: true })
  cpSync(join(source, '.agents'), join(root, '.agents'), { recursive: true, verbatimSymlinks: true })
  put('athena.config.json', JSON.stringify({ pack: 'pack' }))
  put('pack/pack.json', JSON.stringify({ repos: [{ name: 'sample', branch: 'main', remote: 'https://example.test/sample.git' }] }))
  put('pack/diagrams/index.json', JSON.stringify({ groups: [{ title: '표본 <서비스>', items: [{ base: 'sample', name: '작은 <표본>', sub: 'sample', desc: '' }, { base: 'absent', name: '없는 장' }, { base: 'mono/web', name: '첫 앱' }, { base: 'other/web', name: '둘째 앱' }] }] }))
  put('pack/diagrams/sample.html', '<html>표본</html>')
  put('pack/diagrams/mono/web.html', '<html>첫 앱</html>')
  put('pack/diagrams/other/web.html', '<html>둘째 앱</html>')
  put('docs/diagrams/athena-flow-light.html', '<html>기존 흐름</html>')
  check('생성된 서비스만 목록에 포함하고 아테나 작업 흐름 카드는 싣지 않는다', () => {
    const result = run('build-diagram-index.mjs')
    assert.equal(result.status, 0, result.stderr)
    const html = readFileSync(join(root, 'docs/diagrams/index.html'), 'utf8')
    assert.match(html, /작은 &lt;표본&gt;/)
    assert.doesNotMatch(html, /없는 장/)
    assert.doesNotMatch(html, /athena-flow-light.html|athena-flow-formal.html|athena-compact.html|작업 흐름/)
    const href = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]).find(href => href.endsWith('sample.html'))
    assert.ok(href)
    assert.ok(existsSync(resolve(root, 'docs/diagrams', href)))
  })
  check('동명 앱의 중첩 산출물 링크가 서로 다른 실제 파일로 이어진다', () => {
    const html = readFileSync(join(root, 'docs/diagrams/index.html'), 'utf8')
    const links = [...html.matchAll(/href="([^"]+web.html)"/g)].map(match => resolve(root, 'docs/diagrams', match[1]))
    assert.equal(new Set(links).size, 2)
    assert.ok(links.every(file => existsSync(file)))
  })
  check('메뉴 이름은 시스템 개요 · 시퀀스 다이어그램 · <기능> — 화면 맵은 남은 파일이 있을 때만 맨 뒤', () => {
    put('pack/diagrams/index.json', JSON.stringify({ groups: [{ title: '서비스', items: [{ base: 'flow', name: '흐름', extra: [{ file: 'flow.route.sequence.html', label: '길찾기' }, { file: 'flow.pay.sequence.html', label: '시퀀스 다이어그램 · 결제' }, { file: 'flow.detail.html', label: '상세' }] }, { base: 'plain', name: '옛 장 없음' }] }] }))
    for (const file of ['flow.html', 'flow.sequence.html', 'flow.route.sequence.html', 'flow.pay.sequence.html', 'flow.detail.html', 'flow.domains.html', 'plain.html']) put(`pack/diagrams/${file}`, '<html></html>')
    const result = run('build-diagram-index.mjs')
    assert.equal(result.status, 0, result.stderr)
    const html = readFileSync(join(root, 'docs/diagrams/index.html'), 'utf8')
    const cards = html.split('<div class="card">')
    const pills = (name) => [...cards.find(card => card.includes(`<div class="t">${name}</div>`)).matchAll(/class="pill"[^>]*>([^<]+)</g)].map(match => match[1])
    assert.deepEqual(pills('흐름'), ['시스템 개요', '시퀀스 다이어그램', '시퀀스 다이어그램 · 길찾기', '시퀀스 다이어그램 · 결제', '상세', '화면 맵'])
    assert.deepEqual(pills('옛 장 없음'), ['시스템 개요'])
    assert.doesNotMatch(html, /요청 흐름|>구조</)
  })
  check('Claude·Codex가 같은 diagram 스킬 탐색', () => {
    assert.equal(realpathSync(join(root, '.agents/skills/diagram/SKILL.md')), realpathSync(join(root, '.claude/skills/diagram/SKILL.md')))
  })
  const { scaffold } = await import(pathToFileURL(join(source, 'scripts/lib/init.mjs')))
  check('새 팩은 단일 레포·앱에서 서비스 표와 카드를 만들고 기존 내용은 보존', () => {
    const packDir = join(root, 'fresh')
    const config = { name: '표본', repos: [{ name: 'one', kind: 'single', agents: [], branch: 'production' }, { name: 'mono', kind: 'monorepo', branch: 'main', apps: { web: { dir: 'products/web', branch: 'release', agent: 'mono-web' } } }, { name: 'other', kind: 'monorepo', branch: 'main', apps: { web: { branch: 'main', agent: 'other-web' } } }] }
    scaffold({ athenaRoot: source, packDir, config })
    const manifest = join(packDir, 'diagrams/index.json')
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).groups[0].items.map(item => item.base), ['one', 'mono/web', 'other/web'])
    assert.match(readFileSync(join(packDir, 'diagrams/SERVICES.md'), 'utf8'), /products\/web/)
    writeFileSync(manifest, '{}')
    scaffold({ athenaRoot: source, packDir, config })
    assert.equal(readFileSync(manifest, 'utf8'), '{}')
  })
  const { plannedLinks, linkOverlay } = await import(pathToFileURL(join(source, 'scripts/lib/overlay.mjs')))
  check('팩 목록·가이드·그림을 overlay에 포함', () => assert.ok(plannedLinks(root, 'legacy', join(root, 'pack')).some(link => link.at === 'docs/diagrams/sample.html')))
  check('기존 팩을 다시 링크해도 코어 diagram 정본을 유지하고 양쪽 도구가 같은 새 규칙을 읽는다', () => {
    put('pack/skills/local/SKILL.md', '# 팩 전용 스킬')
    put('athena.config.json', JSON.stringify({ pack: 'legacy-pack' }))
    cpSync(join(root, 'pack'), join(root, 'legacy-pack'), { recursive: true })
    rmSync(join(root, 'pack'), { recursive: true })
    const result = linkOverlay(root)
    assert.deepEqual(result.clash, [])
    const claude = join(root, '.claude/skills/diagram/SKILL.md')
    assert.equal(readFileSync(claude, 'utf8'), readFileSync(join(source, '.claude/skills/diagram/SKILL.md'), 'utf8'))
    assert.equal(realpathSync(claude), realpathSync(join(root, '.agents/skills/diagram/SKILL.md')))
    assert.equal(realpathSync(join(root, '.agents/skills/local/SKILL.md')), realpathSync(join(root, 'pack/skills/local/SKILL.md')))
  })
  const repo = join(root, 'repos/sample')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', '시험'); git('config', 'user.email', 'test@example.test'); git('remote', 'add', 'origin', 'https://example.test/sample.git')
  put('repos/sample/source.js', 'export const sample = true\n')
  git('add', 'source.js'); git('commit', '-qm', '표본')
  const revision = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', revision)
  const spec = { diagram_type: 'architecture', meta: { repository: { url: 'https://example.test/sample.git', revision } }, components: [{ sources: [{ path: 'source.js', line: 1 }] }] }
  put('pack/diagrams/sample.architecture.json', JSON.stringify(spec))
  check('고정 근거와 현재 운영 ref 일치', () => { const result = run('check-diagrams.mjs', '--strict'); assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /sample.architecture.json/) })
  check('근거가 최신이어도 공통 디자인 증거가 없으면 --design은 실패', () => assert.equal(run('check-diagrams.mjs', '--strict', '--design').status, 1))
  put('pack/diagrams/sample.archify.html', '<html><head></head><body><svg data-quality-profile="showcase"></svg></body></html>')
  assert.equal(run('diagram-theme.mjs', '--output', join(root, 'pack/diagrams/sample.html'), join(root, 'pack/diagrams/sample.archify.html')).status, 0)
  // 브라우저 실행 대신 해시를 가진 시험용 영수증으로 점검기의 결합만 검증한다.
  const artifact = readFileSync(join(root, 'pack/diagrams/sample.html'))
  const browser = { evidenceKind: 'automated-browser', status: 'pass', artifact: { sha256: createHash('sha256').update(artifact).digest('hex'), bytes: artifact.length } }
  put('pack/diagrams/sample.visual-check.json', JSON.stringify(browser))
  check('현재 테마 최종본과 해시가 일치하는 브라우저 증거만 인정', () => assert.equal(run('check-diagrams.mjs', '--strict', '--design').status, 0))
  browser.artifact.sha256 = 'stale'
  put('pack/diagrams/sample.visual-check.json', JSON.stringify(browser))
  check('과거 캡처의 pass 영수증을 최종본 성공으로 재사용하지 않음', () => assert.equal(run('check-diagrams.mjs', '--strict', '--design').status, 1))
  browser.artifact.sha256 = createHash('sha256').update(artifact).digest('hex')
  browser.status = 'skipped'
  put('pack/diagrams/sample.visual-check.json', JSON.stringify(browser))
  check('브라우저 미실행을 디자인 통과로 보고하지 않음', () => assert.equal(run('check-diagrams.mjs', '--strict', '--design').status, 1))
  browser.status = 'pass'
  put('pack/diagrams/sample.visual-check.json', JSON.stringify(browser))
  put('pack/diagrams/sample.sequence.json', JSON.stringify({ diagram_type: 'sequence' }))
  check('sequence는 구조 HTML의 증거를 대신 쓰지 않고 별도 최종 HTML을 요구한다', () => assert.equal(run('check-diagrams.mjs', '--strict', '--design').status, 1))
  rmSync(join(root, 'pack/diagrams/sample.sequence.json'))
  put('pack/pack.json', JSON.stringify({ repos: [{ name: 'sample', branch: 'main' }] }))
  check('remote가 없는 팩은 실제 origin으로 정상 근거를 찾는다', () => { const result = run('check-diagrams.mjs', '--strict'); assert.equal(result.status, 0, result.stdout + result.stderr) })
  put('repos/sample/source.js', 'export const changed = true\n'); git('commit', '-qam', '근거 변경'); git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  check('관련 코드 변경을 최신으로 보고하지 않는다', () => assert.equal(run('check-diagrams.mjs', '--strict').status, 1))
  spec.meta.repository.revision = git('rev-parse', 'HEAD'); spec.components[0].sources[0].path = 'missing.js'
  put('pack/diagrams/sample.architecture.json', JSON.stringify(spec))
  check('같은 커밋이어도 없는 근거는 실패', () => assert.equal(run('check-diagrams.mjs', '--strict').status, 1))
  spec.components[0].sources[0] = { path: 'source.js', line: 99 }
  put('pack/diagrams/sample.architecture.json', JSON.stringify(spec))
  check('현재 커밋의 잘못된 줄 범위도 실패', () => assert.equal(run('check-diagrams.mjs', '--strict').status, 1))
  put('pack/diagrams/sample.architecture.json', '{broken')
  check('깨진 스펙도 실패', () => assert.equal(run('check-diagrams.mjs', '--strict').status, 1))
  rmSync(join(root, 'pack/diagrams/sample.architecture.json'))
  const appConfig = { repos: [{ name: 'sample', kind: 'monorepo', branch: 'main', apps: { web: { dir: 'products/web', branch: 'web-live' }, admin: { branch: 'admin-live' } } }] }
  put('pack/pack.json', JSON.stringify(appConfig))
  put('repos/sample/products/web/page.js', 'export const page = true\n')
  put('repos/sample/apps/admin/page.js', 'export const admin = true\n')
  put('repos/sample/shared.js', 'export const shared = "main"\n')
  git('add', '.'); git('commit', '-qm', '모노레포 공통 기준')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const mainRevision = git('rev-parse', 'HEAD')
  put('repos/sample/shared.js', 'export const shared = "web"\n'); git('commit', '-qam', '웹 운영')
  const webRevision = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/web-live', webRevision)
  git('switch', '-q', '-c', 'admin-live', mainRevision)
  put('repos/sample/shared.js', 'export const shared = "admin"\n'); git('commit', '-qam', '관리 운영')
  const adminRevision = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/admin-live', adminRevision)
  const appSpec = (revision, appPath) => ({ diagram_type: 'architecture', meta: { repository: { url: 'https://example.test/sample.git', revision } }, components: [{ sources: [{ path: appPath, line: 1 }, { path: 'shared.js', line: 1 }] }] })
  put('pack/diagrams/sample/web.architecture.json', JSON.stringify(appSpec(webRevision, 'products/web/page.js')))
  put('pack/diagrams/sample/admin.architecture.json', JSON.stringify(appSpec(adminRevision, 'apps/admin/page.js')))
  check('앱과 공용 코드 모두 해당 앱 운영 ref로 점검한다', () => {
    const result = run('check-diagrams.mjs', '--strict')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /sample\/web.architecture.json — web-live · 최신/)
    assert.match(result.stdout, /sample\/admin.architecture.json — admin-live · 최신/)
  })
  const commonOnly = appSpec(webRevision, 'shared.js')
  put('pack/diagrams/sample/web.domains.architecture.json', JSON.stringify(commonOnly))
  check('앱 폴더 근거가 없어도 서비스 경로로 앱 branch를 확정한다', () => {
    const result = run('check-diagrams.mjs', '--strict')
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
  put('pack/diagrams/legacy.architecture.json', JSON.stringify(appSpec(webRevision, 'products/web/page.js')))
  check('기존 서비스 ID는 유일한 앱 근거로 branch를 정한다', () => {
    const result = run('check-diagrams.mjs', '--strict')
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })
  put('repos/sample/shared.js', 'export const shared = "admin changed"\n'); git('commit', '-qam', '관리 공용 코드 변경'); git('update-ref', 'refs/remotes/origin/admin-live', 'HEAD')
  check('선택한 앱 운영 branch의 공용 코드 변경은 실패한다', () => assert.equal(run('check-diagrams.mjs', '--strict').status, 1))
} finally { rmSync(root, { recursive: true, force: true }) }
if (failures) process.exit(1)
JS
