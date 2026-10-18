/**
 * 현황판 [학습] 탭 — 학습 후보(issues/*-learn-*.md)와 학습한 내용(docs/knowledge/learned/*.md)을 다룬다.
 * 기준·흐름 정본: docs/knowledge/common/learning.md · plans/feature/20261008-학습-루프-4단계-학습-탭-쉬운-기록.md
 *
 *   넣기      후보 → 공책(target 파일) 끝 "## 학습" 절에 한 줄(<!-- learn:<id> -->) + 기록 docs/knowledge/learned/<id>.md
 *             strengthen(기존 줄 강화)이면 그 줄을 바꾸고 원래 줄을 기록에 남긴다(삭제하면 되돌린다)
 *   버리기    후보 → 휴지통(.board-trash/<날짜>/), 수만 센다
 *   수정      학습한 내용 → 기록과 공책 줄을 표시(id)로 찾아 같이 고친다
 *   삭제      학습한 내용 → 공책 줄을 빼고(강화였으면 원래 줄로 되돌림) 기록은 휴지통으로
 *   화면 범위  후보 scope(코드 폴더)가 있으면 — 그 화면 파일(gotchas/<폴더>.md)이 있으면 거기, 없으면 공통 공책에 "[화면 <폴더>]" 를 붙여 넣는다
 *             (나중에 gotchas-check 가 같은 화면 줄을 세어 떼자고 한다). 수정·삭제는 공책 묶음(gotchas.md + gotchas/*.md)에서 표시로 찾는다
 *   정리 후보  kind: tidy (scripts/gotchas-check.mjs) — 낡은 줄 [지우기]·[그대로 두기], 다 처리하면 닫는다. 넣기·버리기 수에 세지 않는다
 *   Jev 중복  checkLearnWithJev — 후보가 공책 기존 줄에 이미 담겼는지 Jev 가 본다(키가 있을 때만, scripts/lib/jev.mjs).
 *             아주 높으면(JEV_DISCARD_MIN) 휴지통으로 — 기존 줄은 공책에 그대로라 잃는 것이 없다. 중간이면 카드에 "겹쳐 보여요" 만.
 *             넣기·고치기·지우기는 Jev 가 하지 않는다(공책은 모든 에이전트가 작업마다 읽는다)
 * 커밋은 하지 않는다 — 사용자가 "커밋해줘" 할 때 아테나가 모아서.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gitEach } from '../lib/git.mjs'
import { askJev, logJev } from '../lib/jev.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ISSUES = join(ROOT, 'issues')
const LEARNED = join(ROOT, 'docs/knowledge/learned')
const STATS = join(ROOT, '.board-learn-stats.json')
const SECTION = '## 학습'
const SECTION_NOTE = '학습 루프로 들어온 줄 — 현황판 [학습] 탭에서 수정·삭제한다. 쉬운 설명은 `docs/knowledge/learned/`'

const today = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10)
export const isLearnIssue = (path) => /-learn-[^/]*\.md$/.test(path) && !/-learn-curator\.md$/.test(path)  // curator 정리 목록은 후보가 아니다

// ── 읽기 ────────────────────────────────────────────────────────────────
const parse = (text) => {
  const front = text.match(/^---\n([\s\S]*?)\n---\n?/)
  const meta = Object.fromEntries((front?.[1] ?? '').split('\n').map((line) => line.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim()]))
  const body = front ? text.slice(front[0].length) : text
  const sections = {}
  let current = '_intro'
  for (const line of body.split('\n')) {
    const heading = line.match(/^## (.+)$/)
    if (heading) {
      current = heading[1].trim()
      continue
    }
    sections[current] = `${sections[current] ?? ''}${line}\n`
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key].trim()
  return { meta, sections, body: body.trim() }
}

const tidyData = (text) => {
  try { return JSON.parse((text.match(/<!-- tidy: (.*) -->/) ?? [])[1]?.replace(/--\\>/g, '-->') ?? 'null') } catch { return null }
}
const firstSection = (sections, ...names) => names.map((name) => sections[name]).find(Boolean) ?? ''
// 1단계 형식(본문 한 줄 + 근거)도 읽는다
const view = (id, text, extra = {}) => {
  const { meta, sections, body } = parse(text)
  const rule = firstSection(sections, '공책에 넣을 문장') || sections._intro?.split('\n')[0] || ''
  return {
    id,
    title: meta.title || basename(id, '.md'),
    target: meta.target || '',
    notebook: (meta.target || '').split('#')[0],
    source: meta.source || '',
    signal: meta.signal || '',
    basis: meta.basis || '',
    skill: (meta.target || '').startsWith('skill:'),
    scope: meta.scope && meta.scope !== 'common' ? meta.scope : '',
    tidy: meta.kind === 'tidy' ? tidyData(text) : null,
    explain: firstSection(sections, '무엇을 배웠나') || (sections._intro && sections._intro !== rule ? sections._intro : ''),
    why: firstSection(sections, '왜 중요한가', '모르면').replace(/^- /, ''),
    rule: rule.replace(/\n\(새 줄이 아니라 기존 줄을 고친다: [\s\S]*\)$/, '').trim(),
    strengthen: meta.strengthen || (firstSection(sections, '공책에 넣을 문장').match(/\(새 줄이 아니라 기존 줄을 고친다: ([\s\S]*)\)$/) ?? [])[1] || '',
    where: firstSection(sections, '어디서 배웠나', '근거').replace(/<!--[\s\S]*?-->/g, '').trim(),
    extra: Object.entries(sections).filter(([key]) => key.startsWith('덧붙임') || key === '절차').map(([key, value]) => `## ${key}\n${value}`).join('\n\n'),
    body,
    ...extra,
  }
}

const readStats = () => {
  try { return JSON.parse(readFileSync(STATS, 'utf8')) } catch { return { applied: 0, discarded: 0 } }
}
const bumpStat = (key) => {
  const stats = readStats()
  stats[key] = (stats[key] ?? 0) + 1
  try { writeFileSync(STATS, JSON.stringify(stats)) } catch { /* 수만 못 셀 뿐 */ }
}

// 공책·기록에 커밋 안 된 변경이 몇 개인지 — "커밋해줘" 안내용
const uncommitted = () => {
  try {
    // docs/knowledge 안의 레포 공책·learned 는 팩 링크일 수 있다 — 코어와 팩 레포를 각각 본다
    const dirs = ['docs/knowledge', ...readdirSync(join(ROOT, 'docs/knowledge')).map((name) => `docs/knowledge/${name}`).filter((path) => lstatSync(join(ROOT, path)).isSymbolicLink())]
    const lines = gitEach(ROOT, dirs, ['status', '--porcelain', '-uall', '--', '{paths}']).flatMap((repo) => repo.out.split('\n'))
    return lines.filter((line) => /(^|\/)(learned\/|[^ ]*gotchas(\.md|\/[^/]+\.md))/.test(line)).length
  } catch {
    return 0
  }
}

export const listLearn = () => {
  const checked = readJevChecks()
  const candidates = existsSync(ISSUES)
    ? readdirSync(ISSUES).filter((file) => isLearnIssue(file))
      .map((file) => ({ file, text: readFileSync(join(ISSUES, file), 'utf8') }))
      .filter(({ text }) => !/^status:\s*(done|wontfix)/m.test(text))
      .map(({ file, text }) => view(`issues/${file}`, text, { created: statSync(join(ISSUES, file)).mtime.toISOString().slice(0, 10), jev: jevHintOf(checked[`issues/${file}`]) }))
      .sort((left, right) => right.created.localeCompare(left.created))
    : []
  const learned = existsSync(LEARNED)
    ? readdirSync(LEARNED).filter((file) => file.endsWith('.md') && file !== 'README.md')
      .map((file) => {
        const text = readFileSync(join(LEARNED, file), 'utf8')
        const { meta } = parse(text)
        return view(`docs/knowledge/learned/${file}`, text, { applied: meta.applied || '', by: meta.approved_by || '', original: (parse(text).sections['원래 줄'] || '') })
      })
      .sort((left, right) => right.applied.localeCompare(left.applied))
    : []
  return { candidates, learned, stats: readStats(), uncommitted: uncommitted() }
}

// ── 안전한 경로 ──────────────────────────────────────────────────────────
const inside = (rel, dir) => {
  const path = normalize(join(ROOT, rel))
  return path.startsWith(join(ROOT, dir) + sep) && existsSync(path) ? path : null
}
// 공책은 이미 있는 docs/knowledge/<영역>/gotchas.md(+ 나뉜 화면 파일 gotchas/<폴더>.md) 만 — learned/ 기록·규칙 문서·없는 폴더에 쓰지 않는다
const notebookPath = (target) => {
  // 이름 변경(2026-10) 전 학습 후보는 옛 폴더(knowledge 의 hermes)를 가리킨다
  const file = (target || '').split('#')[0].replace(/^docs\/knowledge\/hermes\//, 'docs/knowledge/athena/')
  if (!/^docs\/knowledge\/[\w.-]+(?:\/[\w.-]+)*\/gotchas(?:\.md|\/[\w.-]+\.md)$/.test(file) || file.includes('..') || file.startsWith('docs/knowledge/learned/')) return null
  const path = join(ROOT, file)
  return existsSync(path) ? path : null
}
// 공책 묶음 — 공통 gotchas.md 와 화면 파일들. 줄이 화면 파일로 옮겨져도 표시(learn:id)로 찾는다
const mainOf = (path) => (basename(dirname(path)) === 'gotchas' ? join(dirname(dirname(path)), 'gotchas.md') : path)
const familyOf = (path) => {
  const main = mainOf(path)
  const splitDir = join(dirname(main), 'gotchas')
  return [main, ...(existsSync(splitDir) ? readdirSync(splitDir).filter((file) => file.endsWith('.md')).map((file) => join(splitDir, file)) : [])].filter((file) => existsSync(file))
}
const screenSlug = (scope) => scope.replace(/^\/+|\/+$/g, '').replace(/\//g, '-').replace(/[^\w.-]/g, '')
const toTrash = (path) => {
  const to = join(ROOT, '.board-trash', today(), relative(ROOT, path))
  mkdirSync(dirname(to), { recursive: true })
  renameSync(path, existsSync(to) ? `${to}.${Date.now()}` : to)
}
const oneLine = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim()
const marker = (id) => `<!-- learn:${id} -->`

// ── 공책 줄 넣기·바꾸기·빼기 ─────────────────────────────────────────────
// 줄 비교용 — 앞의 "- " 와 뒤의 학습 표시를 떼고 공백을 하나로
const bare = (row) => oneLine(row).replace(/^[-*]\s+/, '').replace(/\s*<!-- learn:[^>]+ -->\s*$/, '').trim()
const markerOf = (row) => (row.match(/<!-- learn:([^>]+) -->/) ?? [])[1] ?? ''
// 강화할 기존 줄 — 정확히 같은 줄만(부분 일치로 다른 줄을 덮지 않는다)
const findStrengthen = (path, strengthen) => {
  const needle = bare(strengthen)
  if (!needle) return null
  // 화면 표시 [화면 x] 는 비교에서 뗀다 · 공책 묶음(공통 + 화면 파일) 전체에서
  const plain = (row) => bare(row).replace(/^\[화면 [^\]]+\] /, '')
  for (const file of familyOf(path)) {
    const rows = readFileSync(file, 'utf8').split('\n')
    const index = rows.findIndex((row) => plain(row) === needle.replace(/^\[화면 [^\]]+\] /, ''))
    if (index >= 0) return { file, index, row: rows[index], learnedId: markerOf(rows[index]) }
  }
  return null
}
const insertLine = (path, id, rule, found) => {
  let text = readFileSync(path, 'utf8')
  const line = `- ${oneLine(rule)} ${marker(id)}`
  if (found) {
    const rows = readFileSync(found.file, 'utf8').split('\n')
    rows[found.index] = `- ${screenTag(found.row)}${oneLine(rule).replace(/^\[화면 [^\]]+\] /, '')} ${marker(id)}`
    writeFileSync(found.file, rows.join('\n'))
    return found.row
  }
  if (!text.includes(`\n${SECTION}\n`)) text = `${text.trimEnd()}\n\n${SECTION}\n\n${SECTION_NOTE}\n`
  text = `${text.trimEnd()}\n${line}\n`
  writeFileSync(path, text)
  return ''
}
// 표시가 있는 줄 — 공책 묶음 어디에 있든
const findMarked = (path, id) => {
  for (const file of familyOf(path)) {
    const rows = readFileSync(file, 'utf8').split('\n')
    const index = rows.findIndex((row) => row.includes(marker(id)))
    if (index >= 0) return { file, rows, index }
  }
  return null
}
// 화면 표시 [화면 x] 는 수정해도 유지한다
const screenTag = (row) => (row.match(/^\s*[-*]\s+(\[화면 [^\]]+\] )/) ?? [])[1] ?? ''
const replaceLine = (path, id, rule) => {
  const found = findMarked(path, id)
  if (!found) return false
  const tag = screenTag(found.rows[found.index])
  found.rows[found.index] = `- ${tag}${oneLine(rule).replace(/^\[화면 [^\]]+\] /, '')} ${marker(id)}`
  writeFileSync(found.file, found.rows.join('\n'))
  return true
}
const removeLine = (path, id, original) => {
  const found = findMarked(path, id)
  if (!found) return false
  if (original) found.rows[found.index] = original
  else found.rows.splice(found.index, 1)
  writeFileSync(found.file, found.rows.join('\n'))
  return true
}

// 누가 넣었나 — 이 컴퓨터의 git 사용자 이름(학습한 내용 목록 오른쪽에 보인다)
const gitUser = () => {
  try { return execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return '' }
}
const ledgerText = (item, { applied, original, by }) => `---
id: ${item.lid}
title: ${oneLine(item.title)}
target: ${item.target}
source: ${item.source}
signal: ${item.signal}
basis: ${item.basis || ''}${item.scope ? `\nscope: ${item.scope}` : ''}
applied: ${applied}
approved_by: ${by || ''}
---

## 무엇을 배웠나
${item.explain.trim()}

## 왜 중요한가
${item.why.trim()}

## 공책에 넣을 문장
${oneLine(item.rule)}

## 어디서 배웠나
${item.where.trim()}
${original ? `\n## 원래 줄\n${original}\n` : ''}${item.extra ? `\n${item.extra}\n` : ''}`

// ── 동작 ────────────────────────────────────────────────────────────────
export const applyLearn = (id, edits = {}) => {
  const path = inside(id, 'issues')
  if (!path || !isLearnIssue(path)) return { error: '학습 후보를 찾지 못했어요' }
  const item = view(id, readFileSync(path, 'utf8'))
  if (item.skill) return { error: '스킬 후보는 [아테나에게 맡기기]로 — 아테나가 스킬 파일을 만든다' }
  Object.assign(item, Object.fromEntries(Object.entries(edits).filter(([key, value]) => ['title', 'explain', 'why', 'rule'].includes(key) && typeof value === 'string' && value.trim())))
  if (!item.rule.trim()) return { error: '공책에 넣을 문장이 비어 있어요' }
  const notebook = notebookPath(item.target)
  if (!notebook) return { error: `공책 위치가 올바르지 않아요: ${item.target || '(없음)'}` }
  let found = null
  if (item.strengthen) {
    found = findStrengthen(notebook, item.strengthen)
    if (!found) return { error: '강화할 기존 줄을 공책에서 찾지 못했어요 — [고쳐서 넣기]에서 "공책에 넣을 문장"을 확인하거나, 후보의 strengthen 줄을 공책 줄과 똑같이 맞춰 주세요' }
  }
  // 이미 학습된 줄을 강화 — 그 학습(X)을 이어받는다: 표시는 X 그대로, X 기록의 문장을 바꾸고 이 후보는 덧붙임으로(R2=A)
  if (found?.learnedId) {
    const ledgerPath = join(LEARNED, `${found.learnedId}.md`)
    if (!existsSync(ledgerPath)) return { error: `이어받을 학습 기록(${found.learnedId})이 없어요 — [학습한 내용]을 확인해 주세요` }
    replaceLine(notebook, found.learnedId, item.rule)
    const ledger = readFileSync(ledgerPath, 'utf8')
      .replace(/(## 공책에 넣을 문장\n)[^\n]*/, `$1${oneLine(item.rule)}`)
    writeFileSync(ledgerPath, `${ledger.trimEnd()}\n\n## 덧붙임 (${today()} · ${item.source})\n- ${oneLine(item.explain)}\n- 이전 문장: ${bare(found.row)}\n`)
    toTrash(path)
    bumpStat('applied')
    return { ok: true, notebook: relative(ROOT, notebook), inherited: found.learnedId }
  }
  // 같은 id 가 이미 있으면(같은 날 같은 문장) 접미사를 붙여 기존 기록·줄을 덮지 않는다
  let lid = basename(path, '.md')
  for (let suffix = 2; existsSync(join(LEARNED, `${lid}.md`)) || readFileSync(notebook, 'utf8').includes(marker(lid)); suffix += 1) lid = `${basename(path, '.md')}-${suffix}`
  item.lid = lid
  // 화면 범위 — 화면 파일이 있으면 그리로, 없으면 공통 공책에 [화면 x] 를 붙여서(강화는 원래 줄 자리 그대로)
  let destination = notebook
  let rule = item.rule
  if (item.scope && !found) {
    const screenFile = join(dirname(mainOf(notebook)), 'gotchas', `${screenSlug(item.scope)}.md`)
    if (existsSync(screenFile)) destination = screenFile
    else rule = `[화면 ${item.scope}] ${oneLine(item.rule).replace(/^\[화면 [^\]]+\] /, '')}`
  }
  const original = insertLine(destination, item.lid, rule, found)
  mkdirSync(LEARNED, { recursive: true })
  writeFileSync(join(LEARNED, `${item.lid}.md`), ledgerText(item, { applied: today(), original, by: gitUser() }))
  toTrash(path)
  bumpStat('applied')
  return { ok: true, notebook: relative(ROOT, destination), strengthened: Boolean(original) }
}

export const discardLearn = (id) => {
  const path = inside(id, 'issues')
  if (!path || !isLearnIssue(path)) return { error: '학습 후보를 찾지 못했어요' }
  const tidy = /^kind:\s*tidy\s*$/m.test(readFileSync(path, 'utf8'))
  toTrash(path)
  if (!tidy) bumpStat('discarded')
  return { ok: true }
}

// ── 정리 후보(kind: tidy) — 낡은 줄 하나를 지우거나 그대로 둔다 ───────────────
const tidyStaleSection = (stale) => (stale.length
  ? `## 낡았을 수 있는 줄\n${stale.map((entry) => `- ${bare(entry.line)}\n  - 사라진 경로: ${entry.missing.map((file) => `\`${file}\``).join(', ')}`).join('\n')}\n`
  : '')
// [그대로 두기] 한 줄 — gotchas-check 가 같은 줄·같은 경로면 다시 올리지 않는다(줄이 바뀌면 다시 올라온다)
const KEEP_FILE = join(ROOT, '.sync/gotchas-keep.json')
const rememberKeep = ({ file, line, missing }) => {
  let kept = []
  try { kept = JSON.parse(readFileSync(KEEP_FILE, 'utf8')) } catch { kept = [] }
  if (!kept.some((entry) => entry.file === file && entry.line === line)) kept.push({ file, line, missing, kept: today() })
  mkdirSync(dirname(KEEP_FILE), { recursive: true })
  writeFileSync(KEEP_FILE, `${JSON.stringify(kept, null, 2)}\n`)
}
export const tidyLine = (id, index, act, line) => {
  const path = inside(id, 'issues')
  if (!path || !isLearnIssue(path)) return { error: '정리 후보를 찾지 못했어요' }
  let text = readFileSync(path, 'utf8')
  const data = tidyData(text)
  const entry = data?.stale?.[index]
  // 화면을 연 뒤 점검이 후보를 다시 썼으면 번호가 다른 줄을 가리킨다 — 줄 원문이 같을 때만
  if (!entry || entry.line !== line) return { error: '그 줄을 후보에서 찾지 못했어요 — 새로고침해 주세요' }
  let notebookUpdated = null
  if (act === 'remove') {
    const learnedId = markerOf(entry.line)
    if (learnedId && existsSync(join(LEARNED, `${learnedId}.md`))) {
      // 학습으로 들어온 줄 — 학습한 내용 삭제와 같게(기록은 휴지통, 강화였으면 원래 줄로)
      notebookUpdated = removeLearned(`docs/knowledge/learned/${learnedId}.md`).notebookUpdated
    } else {
      const notebook = notebookPath(entry.file)
      const rows = notebook ? readFileSync(notebook, 'utf8').split('\n') : []
      const at = rows.findIndex((row) => row === entry.line)
      notebookUpdated = at >= 0
      if (at >= 0) {
        // 그 줄보다 깊게 들여쓴 하위 줄만 같이 — 그 줄에 딸린 설명이다(형제 줄은 남긴다)
        const depth = entry.line.match(/^\s*/)[0].length
        let end = at + 1
        while (end < rows.length && /^\s+[-*]\s+/.test(rows[end]) && rows[end].match(/^\s*/)[0].length > depth) end += 1
        rows.splice(at, end - at)
        writeFileSync(notebook, rows.join('\n'))
      }
    }
  }
  if (act === 'keep') rememberKeep(entry)
  data.stale.splice(index, 1)
  text = text.replace(/## 낡았을 수 있는 줄\n[\s\S]*?(?=\n## |\n<!-- tidy:)/, tidyStaleSection(data.stale).trimEnd())
    .replace(/<!-- tidy: .* -->/, `<!-- tidy: ${JSON.stringify(data).replace(/-->/g, '--\\>')} -->`)
  const done = !data.stale.length && !data.split?.length
  if (done) text = text.replace(/^status:\s*open$/m, 'status: done').replace(/^reason:\s*$/m, `reason: ${today()} [학습] 탭에서 정리 끝`)
  writeFileSync(path, text)
  return { ok: true, notebookUpdated, done }
}

export const editLearned = (id, edits = {}) => {
  const path = inside(id, 'docs/knowledge/learned')
  if (!path) return { error: '학습한 내용을 찾지 못했어요' }
  const text = readFileSync(path, 'utf8')
  const item = view(id, text)
  const { meta, sections } = parse(text)
  Object.assign(item, Object.fromEntries(Object.entries(edits).filter(([key, value]) => ['title', 'explain', 'why', 'rule'].includes(key) && typeof value === 'string' && value.trim())))
  item.lid = meta.id || basename(path, '.md')
  const notebook = notebookPath(item.target)
  const moved = notebook ? replaceLine(notebook, item.lid, item.rule) : false
  writeFileSync(path, ledgerText(item, { applied: meta.applied || today(), original: sections['원래 줄'] || '', by: meta.approved_by || gitUser() }))
  return { ok: true, notebookUpdated: moved }
}

export const removeLearned = (id) => {
  const path = inside(id, 'docs/knowledge/learned')
  if (!path) return { error: '학습한 내용을 찾지 못했어요' }
  const { meta, sections } = parse(readFileSync(path, 'utf8'))
  const notebook = notebookPath(meta.target)
  const removed = notebook ? removeLine(notebook, meta.id || basename(path, '.md'), sections['원래 줄'] || '') : false
  toTrash(path)
  return { ok: true, notebookUpdated: removed }
}

// ── Jev 중복 점검 — 후보가 공책 기존 줄에 이미 담겼는가(scripts/lib/jev.mjs, 키가 있을 때만) ─────────────
// 점검 기록: 후보 id → { hash, score, line, model, at } — 후보 문장이나 공책이 바뀌면(hash) 다시 본다
const JEV_FILE = join(ROOT, '.board-jev-learn.json')
// 처음엔 아주 높게 — 실제 기록(node scripts/lib/jev.mjs --report)을 보고 낮춘다
const JEV_DISCARD_MIN = 0.95
const JEV_HINT_MIN = 0.6
// 줄마다 질문 하나(noul) — 너무 많으면 후보와 낱말이 많이 겹치는 줄부터 이만큼만
const JEV_MAX_LINES = 60
// 한 번에 점검할 후보 수(현황판이 1분에 한 번 부른다)
const JEV_PER_RUN = 3
const JEV_VERSION = 'learn-dedupe-v1'

const readJevChecks = () => {
  try { return JSON.parse(readFileSync(JEV_FILE, 'utf8')) } catch { return {} }
}
const jevHintOf = (check) => (check && check.score >= JEV_HINT_MIN ? { score: check.score, line: check.line } : null)
const words = (text) => new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((word) => word.length > 1))
// 공책 묶음의 줄 — "- " 로 시작하는 맨 앞 줄만(학습 표시는 뗀다)
const notebookRows = (path) => [...new Set(familyOf(path).flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((row) => /^[-*]\s+\S/.test(row)).map(bare)).filter(Boolean))]
const closestRows = (rows, text) => {
  if (rows.length <= JEV_MAX_LINES) return rows
  const own = words(text)
  return rows.map((row) => ({ row, shared: [...words(row)].filter((word) => own.has(word)).length }))
    .sort((left, right) => right.shared - left.shared).slice(0, JEV_MAX_LINES).map((entry) => entry.row)
}

// 점검할 만한 후보 — 공책 함정(스킬·정리 후보 제외), 기존 줄 강화가 아닌 것(강화는 원래 기존 줄과 닮았다)
const jevTargets = () => (existsSync(ISSUES) ? readdirSync(ISSUES).filter((file) => isLearnIssue(file)) : [])
  .map((file) => ({ id: `issues/${file}`, text: readFileSync(join(ISSUES, file), 'utf8') }))
  .filter(({ text }) => !/^status:\s*(done|wontfix)/m.test(text))
  .map(({ id, text }) => ({ id, item: view(id, text) }))
  .filter(({ item }) => !item.skill && !item.tidy && !item.strengthen && item.rule && notebookPath(item.target))

const recordJevDiscard = (entry) => {
  const stats = readStats()
  stats.jevDiscarded = (stats.jevDiscarded ?? 0) + 1
  stats.jevRecent = [entry, ...(stats.jevRecent ?? [])].slice(0, 10)
  try { writeFileSync(STATS, JSON.stringify(stats)) } catch { /* 수만 못 셀 뿐 */ }
}

// 현황판이 부른다 — 돌려주는 것은 서버 로그용 한 줄들
export const checkLearnWithJev = async () => {
  const checked = readJevChecks()
  const done = []
  let asked = 0
  for (const { id, item } of jevTargets()) {
    if (asked >= JEV_PER_RUN) break
    const candidateText = `${item.title}\n${item.explain}\n${item.rule}`
    const rows = closestRows(notebookRows(notebookPath(item.target)), candidateText)
    const hash = createHash('sha1').update(`${JEV_VERSION}\n${candidateText}\n${rows.join('\n')}`).digest('hex').slice(0, 12)
    if (checked[id]?.hash === hash) continue
    if (!rows.length) {
      checked[id] = { hash, score: 0, line: '', at: today() }
      continue
    }
    asked += 1
    const answer = await askJev({
      purpose: 'learn-dedupe',
      state: `공책(에이전트가 작업 전에 읽는 함정 목록)에 새로 넣으려는 학습 후보\n제목: ${item.title}\n무엇을 배웠나: ${item.explain}\n공책에 넣을 문장: ${item.rule}`,
      questions: Object.fromEntries(rows.map((row, index) => [`same_${index}`, { type: 'noul', instructions: `이 후보가 알려 주는 함정·규칙이 다음 공책 줄에 이미 담겨 있다(후보를 넣어도 에이전트가 새로 알게 되는 것이 없다): ${row}` }])),
      meta: { qv: JEV_VERSION, id, rows: rows.length },
    })
    if (!answer) continue   // 실패 — 기록하지 않고 다음에 다시 본다
    const scores = rows.map((row, index) => ({ row, score: Number(answer.answers[`same_${index}`]?.noul ?? 0) }))
    const best = scores.reduce((top, entry) => (entry.score > top.score ? entry : top), { row: '', score: 0 })
    if (best.score >= JEV_DISCARD_MIN) {
      // 왜 버렸는지 후보 파일 끝에 남긴 뒤 휴지통으로 — 되살리면(issues/ 로 옮기면) 이 절을 보고 판단할 수 있다
      const path = join(ROOT, id)
      // Jev 를 기다리는 사이 사람이 [넣기]·[버리기] 했으면 손대지 않는다
      if (!existsSync(path)) continue
      writeFileSync(path, `${readFileSync(path, 'utf8').trimEnd()}\n\n## Jev 자동 버림 (${today()})\n- 공책 기존 줄에 이미 담긴 내용으로 판단(${Math.round(best.score * 100)}% · ${answer.model}): ${best.row}\n- 잘못 버렸으면 .board-trash/<날짜>/${id} 를 ${id} 로 옮긴다\n`)
      toTrash(path)
      recordJevDiscard({ id, title: item.title, line: best.row, score: best.score, at: today() })
      logJev({ purpose: 'learn-dedupe-discard', id, score: best.score, model: answer.model })
      delete checked[id]
      done.push(`학습 후보 자동 버림 ${id} — 기존 줄과 같음 ${Math.round(best.score * 100)}%`)
      continue
    }
    checked[id] = { hash, score: best.score, line: best.row, model: answer.model, at: today() }
    if (best.score >= JEV_HINT_MIN) done.push(`학습 후보 ${id} — 기존 줄과 겹쳐 보임 ${Math.round(best.score * 100)}%`)
  }
  // 없어진 후보(넣기·버리기로 닫힘)의 기록은 지운다
  const open = new Set(jevTargets().map(({ id }) => id))
  for (const id of Object.keys(checked)) if (!open.has(id)) delete checked[id]
  try { writeFileSync(JEV_FILE, JSON.stringify(checked)) } catch { /* 다음에 다시 본다 */ }
  return done
}
