#!/usr/bin/env node
/**
 * 공책(gotchas) 점검 — 낡은 줄과 길이·화면 몰림을 재서 "정리 후보"로 올린다. 공책 줄은 지우지 않는다.
 * 기준 정본: docs/knowledge/common/learning.md 7절
 *
 *   node scripts/gotchas-check.mjs            # 미리보기 — 표만 출력, 아무것도 쓰지 않는다
 *   node scripts/gotchas-check.mjs --write    # 공책마다 정리 후보 이슈(issues/<날짜>-<영역>-learn-gotchas-tidy.md)를 만들거나 갱신
 *   옵션 --area <일부> : 그 영역만(예 <레포 일부>, <레포>/<앱>)
 *
 * 무엇을 보나
 *   - 낡은 줄: 줄의 백틱 안 파일 경로(`lib/x.ts` 처럼 확장자가 있는 것)를 그 레포의 운영 기준 브랜치(athena.config.json branch,
 *     모노레포 앱은 앱 branch) 파일 목록에서 찾는다. 경로 끝이 같으면 있는 것으로 본다(문서는 경로를 줄여 적는다).
 *     그래도 없으면 파일 이름만으로 모든 담당 레포의 기준 브랜치를 한 번 더 찾는다(다른 레포·소비 앱 파일을 적은 줄, 폴더만 옮긴 파일).
 *     판단하지 않는 것: 경로가 없는 줄 · 경로 바로 뒤에 "없음·삭제·존재하지·만들지 않" 처럼 원래 없다는 말이 붙은 경로 ·
 *     문서와 코드가 어긋난다고 적은 줄(낡·불일치·↔·"라고 하지만" — 그 아래 들여쓴 줄까지) ·
 *     아테나 쪽 파일(athena.config.json · rules.md · scripts/… · issues/… 처럼 아테나에 있는 것) · 별칭(@x/…, @/ 는 떼고 찾는다)
 *     fetch 는 하지 않는다 — /sync 가 막 받아온 origin/<branch> 를 본다(없으면 그 공책은 건너뛴다)
 *   - 길이: 공통 공책(gotchas.md)이 2만 자를 넘으면 "나눌까요?" (화면 파일 gotchas/<폴더>.md 는 그 화면 작업 때만 읽으므로 세지 않는다)
 *   - 화면 몰림: 공통 공책에서 같은 화면(코드 폴더 — 줄 앞 [화면 <폴더>] 표시나 줄의 경로 app/<x>/… 로 판단) 줄이 5개 이상이면 그 화면만 떼자고
 * 이슈에는 공책 줄·경로·숫자만 적는다(코드 내용은 옮기지 않는다).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config.mjs'
import { isDirEntry } from './lib/fs.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KNOWLEDGE = join(ROOT, 'docs/knowledge')
const MAX_CHARS = 20000 // D1
const SCREEN_LINES = 5 // D2
const argv = process.argv.slice(2)
const shouldWrite = argv.includes('--write')
const areaFilter = argv.includes('--area') ? argv[argv.indexOf('--area') + 1] ?? '' : ''
const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10)
const config = loadConfig(ROOT)

// ── 영역 → 레포·기준 ref ────────────────────────────────────────────────
const repoOf = (area) => {
  if (area === 'athena' || area === 'hermes') return { dir: ROOT, ref: 'HEAD' }  // hermes — 이름 변경 전
  const [name, app] = area.split('/')
  const repo = config.repos.find((entry) => entry.name === name)
  if (!repo) return null
  const branch = repo.kind === 'monorepo' && app && repo.apps?.[app] ? repo.apps[app].branch : repo.branch
  return { dir: join(ROOT, 'repos', name), ref: `origin/${branch}`, appPrefix: repo.kind === 'monorepo' && repo.apps?.[app] ? `apps/${app}/` : '' }
}

const treeCache = new Map()
const filesAt = ({ dir, ref }) => {
  const key = `${dir}@${ref}`
  if (!treeCache.has(key)) {
    try {
      const out = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      treeCache.set(key, out.split('\n').filter(Boolean))
    } catch {
      treeCache.set(key, null)
    }
  }
  return treeCache.get(key)
}

// ── 공책 목록 — <영역>/gotchas.md (+ 나뉜 화면 파일 <영역>/gotchas/*.md) ──────
const notebooks = []
const walk = (dir, area = '') => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!isDirEntry(dir, entry) || entry.name === 'learned' || entry.name === 'common' || entry.name === 'gotchas') continue
    const next = area ? `${area}/${entry.name}` : entry.name
    const main = join(dir, entry.name, 'gotchas.md')
    if (existsSync(main)) {
      const splitDir = join(dir, entry.name, 'gotchas')
      const screens = existsSync(splitDir) ? readdirSync(splitDir).filter((file) => file.endsWith('.md')).map((file) => join(splitDir, file)) : []
      notebooks.push({ area: next, main, screens })
    }
    walk(join(dir, entry.name), next)
  }
}
walk(KNOWLEDGE)

// ── 줄 읽기 ─────────────────────────────────────────────────────────────
const PATH_RE = /`([^`\s]+)`/g
const FILE_RE = /^[\w@.\-[\]()]+(?:\/[\w@.\-[\]()]+)*\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|graphql|gql|css|scss|sh|py|plist)$/
// 경로 바로 뒤(다음 백틱·문장부호 전, 15자 안)에 올 때만 — 멀리 떨어진 "없음"은 다른 말을 꾸민다
const ABSENT_AFTER = /^[^`.,;:!?()·—]{0,15}?(없음|없다|없는|존재하지|삭제|사라|잔재|만들지 않)/
// 문서와 코드가 어긋난다고 적은 줄(그 아래 들여쓴 줄 포함)은 없는 경로를 일부러 적는다 — 판단하지 않는다
const MISMATCH = /낡|불일치|라고 하지만|라고 적혀|가리키는|↔/
// 아테나 쪽 파일 — 공책이 아테나 문서·스크립트를 가리키는 경우(레포 파일이 아니다)
const isHermesFile = (path, area) => /^(issues|plans|archive)\//.test(path)
  || [path, `docs/knowledge/${area}/${path}`, `docs/knowledge/${area.split('/')[0]}/${path}`, `docs/knowledge/${path}`].some((candidate) => existsSync(join(ROOT, candidate)))
const isRow = (row) => /^\s*[-*]\s+/.test(row)
// [학습] 탭에서 [그대로 두기] 한 줄(R1) — 같은 공책·같은 줄·사라진 경로가 그대로면 다시 올리지 않는다
const KEEP_FILE = join(ROOT, '.sync/gotchas-keep.json')
const kept = (() => { try { return JSON.parse(readFileSync(KEEP_FILE, 'utf8')) } catch { return [] } })()
const isKept = (file, line, missing) => kept.some((entry) => entry.file === file && entry.line === line && missing.every((path) => entry.missing?.includes(path)))
const pathsIn = (row) => {
  const found = []
  for (const match of row.matchAll(PATH_RE)) {
    const raw = match[1].replace(/^\.\//, '').replace(/^@\//, '').replace(/:\d+(?:-\d+)?$/, '')
    // 별칭(@ui/…, @repo/…)은 어디로 풀리는지 모른다 · .d.ts 처럼 확장자만 적은 것은 파일이 아니다
    if (!FILE_RE.test(raw) || raw.startsWith('/') || raw.startsWith('@') || raw.includes('..') || /^\.[a-z]+(?:\.[a-z]+)?$/.test(raw)) continue
    // 경로 바로 뒤에 "없음·삭제" — 원래 없다는 걸 적은 줄이다
    // `a`·`b` 처럼 나열한 경로는 나열 끝 뒤의 말을 함께 받는다
    const after = row.slice(match.index + match[0].length).replace(/^(?:\s*[·,]\s*`[^`]*`)+/, '')
    if (ABSENT_AFTER.test(after)) continue
    found.push(raw)
  }
  return [...new Set(found)]
}
const existsIn = (files, path, appPrefix) => files.some((file) => file === path || file === `${appPrefix}${path}` || file.endsWith(`/${path}`))
// 파일 이름만으로 — 모든 담당 레포의 기준 브랜치(앱 브랜치 포함)
// page.tsx·index.ts 처럼 흔한 이름(서로 다른 경로 COMMON_NAME 개 넘게)은 이름만으로는 "있음"으로 보지 않는다(R2) — 적힌 폴더가 순서대로 맞아야 한다
const COMMON_NAME = 3
let allNames = null
const nameAnywhere = (path) => {
  if (!allNames) {
    allNames = new Map()
    const refs = config.repos.flatMap((repo) => [repo.branch, ...Object.values(repo.apps ?? {}).map((app) => app.branch)].map((branch) => ({ name: repo.name, dir: join(ROOT, 'repos', repo.name), ref: `origin/${branch}` })))
    for (const target of [...refs, { name: 'athena', dir: ROOT, ref: 'HEAD' }]) {
      for (const file of filesAt(target) ?? []) {
        const name = file.split('/').at(-1)
        if (!allNames.has(name)) allNames.set(name, new Set())
        allNames.get(name).add(`${target.name}/${file}`)
      }
    }
  }
  const places = allNames.get(path.split('/').at(-1))
  if (!places) return false
  if (places.size <= COMMON_NAME) return true
  // 흔한 이름이면 적힌 폴더들이 실제 경로에 순서대로 들어 있을 때만(`ui/X.tsx` ⊂ `frontend/ui/src/…/X.tsx`)
  const wanted = path.split('/').slice(0, -1)
  return wanted.length > 0 && [...places].some((place) => {
    let at = 0
    for (const segment of place.split('/').slice(0, -1)) if (segment === wanted[at]) at += 1
    return at === wanted.length
  })
}

// 줄이 걸리는 화면(코드 폴더) — [화면 x] 표시가 먼저, 없으면 경로의 app/<x>·pages/<x>·src/screens/<x>
const SCREEN_ROOTS = ['app', 'pages', 'src/app', 'src/pages', 'src/screens']
const screensOf = (row) => {
  const tagged = row.match(/\[화면 ([^\]]+)\]/)
  if (tagged) return [tagged[1].trim().replace(/\/$/, '')]
  const screens = new Set()
  for (const match of row.matchAll(PATH_RE)) {
    const segments = match[1].replace(/^\.\//, '').split('/')
    for (const root of SCREEN_ROOTS) {
      const depth = root.split('/').length
      if (segments.slice(0, depth).join('/') !== root || segments.length <= depth + 1) continue
      const folder = segments[depth]
      // 공용 폴더(_components·api)와 라우트 그룹 (x) 은 화면이 아니다
      if (!folder || /^[_(<{[]/.test(folder) || folder === 'api') continue
      screens.add(`${root}/${folder}`)
    }
  }
  return [...screens]
}

// ── 점검 ────────────────────────────────────────────────────────────────
const check = (notebook) => {
  const repo = repoOf(notebook.area)
  const files = repo ? filesAt(repo) : null
  const result = { ...notebook, ref: repo?.ref ?? '', skipped: '', stale: [], chars: readFileSync(notebook.main, 'utf8').length, screenCounts: [] }
  if (!files) result.skipped = repo ? `${repo.ref} 를 읽지 못함(fetch 필요)` : '레포를 모름'
  for (const path of [notebook.main, ...notebook.screens]) {
    let parent = ''
    for (const row of readFileSync(path, 'utf8').split('\n')) {
      if (!isRow(row) || !files) continue
      if (!/^\s/.test(row)) parent = row
      if (MISMATCH.test(row) || (/^\s/.test(row) && MISMATCH.test(parent))) continue
      const missing = pathsIn(row).filter((file) => !isHermesFile(file, notebook.area) && !existsIn(files, file, repo.appPrefix) && !nameAnywhere(file))
      if (missing.length && !isKept(relative(ROOT, path), row, missing)) result.stale.push({ file: relative(ROOT, path), line: row, missing })
    }
  }
  const counts = new Map()
  for (const row of readFileSync(notebook.main, 'utf8').split('\n')) {
    if (!isRow(row)) continue
    for (const screen of screensOf(row)) counts.set(screen, (counts.get(screen) ?? 0) + 1)
  }
  result.screenCounts = [...counts].sort((left, right) => right[1] - left[1])
  result.split = [
    ...(result.chars > MAX_CHARS ? [{ reason: 'chars', chars: result.chars }] : []),
    ...result.screenCounts.filter(([, count]) => count >= SCREEN_LINES).map(([folder, count]) => ({ reason: 'screen', folder, lines: count, to: `gotchas/${folder.replace(/\//g, '-')}.md` })),
  ]
  return result
}

const results = notebooks.filter((notebook) => !areaFilter || notebook.area.includes(areaFilter)).map(check)

// ── 출력 ────────────────────────────────────────────────────────────────
const bare = (row) => row.replace(/^\s*[-*]\s+/, '').replace(/\s*<!-- learn:[^>]+ -->\s*$/, '').trim()
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
console.log(`공책 점검 — 기준: 공통 공책 ${MAX_CHARS.toLocaleString()}자 · 같은 화면 ${SCREEN_LINES}줄 · 낡은 줄 = 가리키는 파일이 운영 브랜치에 없음\n`)
console.log('| 공책 | 글자 | 화면 최다 | 낡은 줄 | 나누기 | 확인한 ref |')
console.log('|---|---:|---|---:|---|---|')
for (const result of results) {
  const top = result.screenCounts[0] ? `${result.screenCounts[0][0]} ${result.screenCounts[0][1]}줄` : '—'
  const split = result.split.map((entry) => (entry.reason === 'chars' ? '길이' : entry.folder)).join(', ') || '—'
  console.log(`| ${result.area} | ${result.chars.toLocaleString()} | ${top} | ${result.skipped ? '건너뜀' : result.stale.length} | ${split} | ${result.skipped || result.ref} |`)
}
const stales = results.flatMap((result) => result.stale.map((entry) => ({ ...entry, area: result.area })))
if (stales.length) {
  console.log('\n낡았을 수 있는 줄')
  for (const entry of stales) console.log(`- [${entry.area}] ${clip(bare(entry.line), 90)}\n    사라진 경로: ${entry.missing.join(', ')}`)
}

// ── 정리 후보 이슈 ───────────────────────────────────────────────────────
const issueSlug = (area) => area.replace(/\//g, '-')
const openTidy = (area) => (existsSync(join(ROOT, 'issues')) ? readdirSync(join(ROOT, 'issues')) : [])
  .filter((file) => file.endsWith(`-${issueSlug(area)}-learn-gotchas-tidy.md`))
  .find((file) => !/^status:\s*(done|wontfix)/m.test(readFileSync(join(ROOT, 'issues', file), 'utf8')))
const issueText = (result) => {
  const target = relative(ROOT, result.main)
  const counts = [result.stale.length ? `낡은 줄 ${result.stale.length}` : '', result.split.length ? `나누기 ${result.split.length}` : ''].filter(Boolean).join(' · ')
  const explain = [
    result.stale.length ? `운영 브랜치(${result.ref})를 보니 이 공책의 줄 ${result.stale.length}개가 가리키는 파일이 더 이상 없다. 코드가 옮겨졌거나 지워졌으면 그 줄은 이제 틀린 안내일 수 있다 — 줄마다 [지우기] 또는 [그대로 두기].` : '',
    ...result.split.map((entry) => (entry.reason === 'chars'
      ? `공통 공책이 ${entry.chars.toLocaleString()}자로 기준(${MAX_CHARS.toLocaleString()}자)을 넘었다. 한 화면에만 걸리는 줄을 화면 파일(gotchas/<폴더>.md)로 떼면 그 화면을 안 만지는 작업은 읽지 않아도 된다.`
      : `화면 \`${entry.folder}\` 함정이 공통 공책에 ${entry.lines}줄 모였다. 그 줄만 \`${entry.to}\` 로 떼면 다른 화면 작업은 읽지 않아도 된다.`)),
  ].filter(Boolean).join('\n\n')
  const machine = { stale: result.stale.map(({ file, line, missing }) => ({ file, line, missing })), split: result.split, ref: result.ref, checked: today }
  return `---
title: 🧹 공책 정리 후보 — ${result.area} (${counts})
status: open
repo: athena
agent:
kind: tidy
severity: low
signal: tidy
source: gotchas-check (${today})
basis: code
target: ${target}
plan:
fix:
reason:
---

## 무엇을 배웠나
${explain}

## 왜 중요한가
에이전트는 작업마다 공책을 읽는다. 틀린 줄은 잘못 이끌고, 공책이 길어지면 정말 중요한 함정이 묻힌다.
${result.stale.length ? `\n## 낡았을 수 있는 줄\n${result.stale.map((entry) => `- ${bare(entry.line)}\n  - 사라진 경로: ${entry.missing.map((file) => `\`${file}\``).join(', ')}${entry.file !== target ? ` · 화면 파일 \`${entry.file}\`` : ''}`).join('\n')}\n` : ''}${result.split.length ? `\n## 나눌까요\n${result.split.map((entry) => (entry.reason === 'chars' ? `- 공통 공책 ${entry.chars.toLocaleString()}자 — 화면별로 떼기` : `- 화면 \`${entry.folder}\` ${entry.lines}줄 → \`${entry.to}\``)).join('\n')}\n- [아테나에게 맡기기]를 누르면 아테나가 줄 내용은 그대로 두고 옮기기만 한다(learning.md 7절)\n` : ''}
## 어디서 배웠나
- \`node scripts/gotchas-check.mjs\` (${today}) — ${result.ref} 파일 목록과 대조

<!-- tidy: ${JSON.stringify(machine).replace(/-->/g, '--\\>')} -->
`
}

if (shouldWrite) {
  const written = []
  for (const result of results) {
    if (result.skipped) continue
    const existing = openTidy(result.area)
    const hasWork = result.stale.length || result.split.length
    if (!hasWork) {
      // 남은 게 없으면 열린 후보를 닫는다(사람이 다 처리했거나 코드가 돌아왔다)
      if (existing) {
        const path = join(ROOT, 'issues', existing)
        writeFileSync(path, readFileSync(path, 'utf8').replace(/^status:\s*open$/m, 'status: done').replace(/^reason:\s*$/m, `reason: ${today} 점검에서 남은 정리 후보 없음`))
        written.push(`닫음 → issues/${existing}`)
      }
      continue
    }
    const file = existing ?? `${today.replace(/-/g, '')}-${issueSlug(result.area)}-learn-gotchas-tidy.md`
    writeFileSync(join(ROOT, 'issues', file), issueText(result))
    written.push(`${existing ? '갱신' : '새 이슈'} → issues/${file}`)
  }
  console.log(`\n${written.length ? written.join('\n') : '정리 후보 없음 — 이슈를 만들지 않았다'}`)
}
