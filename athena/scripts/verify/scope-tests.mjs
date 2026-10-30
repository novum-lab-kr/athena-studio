#!/usr/bin/env node
// @ts-check
// 바뀐 파일에 닿는 시험만 고른다 — athena-studio 같이 "시험 파일이 코드를 가져다 쓰는" 레포용(팩 검증 스크립트가 부른다).
//   node scripts/verify/scope-tests.mjs <레포 맨 위> <바뀐 파일 목록(트리 기준 상대 경로, 한 줄에 하나)>
// 출력(한 줄에 하나):  JS <test/….test.js>  ·  SH <athena/test/….sh>
// 종료 코드: 0 = 골랐다(출력이 없으면 닿는 시험이 없다) · 2 = 못 읽었다(부르는 쪽이 전체를 돈다)
//
// 시험 = test/*.test.js(node:test) · athena/test/*.sh. 목록을 손으로 적지 않고 코드에서 찾는다:
//   ① 코드 파일이 다른 파일을 가리키는 줄을 모두 모은다 — import · require 의 상대 경로(모든 코드), 글 속의 경로(`scripts/board/server.mjs`)는 시험 파일에 적힌 것만,
//      시험 파일은 폴더 경로(바로 아래 파일)와 앞에 변수가 붙은 경로의 뒤쪽도, 파일 이름만 적은 것(같은 이름이 3개 이하일 때)
//   ② 시험에서 ①을 따라 닿는 파일에 바뀐 파일이 있으면(또는 바뀐 파일이 그 시험 자체면) 그 시험을 돌린다
// 한계 — 스크립트가 다른 스크립트를 부르는 것(셸 → 셸)은 따라가지 않고, 문자열을 이어 붙여 만든 경로 · 실행 중에 정해지는 의존도 못 따라간다(그래서 설정 파일이 바뀌면 부르는 쪽이 전체를 돈다)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'

const [tree, changedListPath] = process.argv.slice(2)
if (!tree || !changedListPath) {
  console.error('사용: scope-tests.mjs <레포 맨 위> <바뀐 파일 목록>')
  process.exit(2)
}

// 다른 파일을 가리키는 쪽(코드)만 읽는다 — json · html · css · md 는 문구 속 경로가 연결로 잡혀 전부 이어지니 끝점으로만 둔다
const TEXT_EXT = /\.(?:js|mjs|cjs|mts|ts|tsx|jsx|sh|py)$/
const SOURCE_EXT = ['.js', '.mjs', '.cjs', '.mts', '.ts', '.tsx', '.jsx', '.json']
const MAX_BYTES = 1_000_000

/** @param {string} text */
const lines = (text) => text.split('\n').filter(Boolean)

const tracked = lines(
  execFileSync('git', ['-c', 'core.quotePath=false', '-C', tree, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
).filter((path) => existsSync(join(tree, path)))
const fileSet = new Set(tracked)
const changed = lines(readFileSync(changedListPath, 'utf8'))

// 지워지거나 이름이 바뀐 파일은 트리에 없어 연결을 못 따라간다 — 그 파일을 쓰던 시험을 놓칠 수 있으니 전체를 돌리게 한다
const missing = changed.filter((path) => !fileSet.has(path))
if (missing.length > 0) {
  console.error(`트리에 없는 바뀐 파일(삭제 · 이름 바꿈): ${missing.slice(0, 5).join(', ')} → 전체`)
  process.exit(2)
}

/** 폴더 → 그 아래 파일들 */
const filesUnder = new Map()
/** 파일 이름 → 경로들 */
const byName = new Map()
for (const path of tracked) {
  const name = basename(path)
  byName.set(name, [...(byName.get(name) ?? []), path])
  for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) filesUnder.set(dir, [...(filesUnder.get(dir) ?? []), path])
}

/** @param {string} directory 폴더 바로 아래 파일(하위 폴더 제외) — 40개 넘는 큰 폴더는 시험이 그 폴더 전체에 기대는 게 아니라고 보고 건너뛴다 */
const directChildren = (directory) => {
  const inside = (filesUnder.get(directory) ?? []).filter((/** @type {string} */ path) => dirname(path) === directory)
  return inside.length <= 40 ? inside : []
}

/** @param {string} candidate 트리 기준 경로 → 파일이면 그 경로, 확장자 · index 를 붙여 찾기 */
const resolveFile = (candidate) => {
  const path = normalize(candidate).replace(/^\.\//, '')
  if (fileSet.has(path)) return path
  for (const ext of SOURCE_EXT) if (fileSet.has(path + ext)) return path + ext
  for (const ext of SOURCE_EXT) if (fileSet.has(join(path, `index${ext}`))) return join(path, `index${ext}`)
  return null
}

const RELATIVE = /['"`](\.{1,2}\/[^'"`\s)]+)['"`]/g
const PATHLIKE = /[A-Za-z0-9_@.$-]+(?:\/[A-Za-z0-9_@.$-]+)+\/?/g
const BARE_FILE = /(?<![A-Za-z0-9_./$-])([A-Za-z0-9_-]+\.(?:js|mjs|cjs|mts|ts|sh|py))(?![A-Za-z0-9_-])/g

/** @type {Map<string, string[]>} */
const edgeCache = new Map()
/** @param {string} file 이 파일이 가리키는 파일들 */
const edgesOf = (file) => {
  const cached = edgeCache.get(file)
  if (cached) return cached
  /** @type {Set<string>} */
  const found = new Set()
  edgeCache.set(file, [])
  let text = ''
  try {
    if (TEXT_EXT.test(file) && statSync(join(tree, file)).size <= MAX_BYTES) text = readFileSync(join(tree, file), 'utf8')
  } catch {
    text = ''
  }
  const dir = dirname(file)
  // 글 속 경로를 따라갈지 — 시험 파일만(`$SRC/scripts/x.sh` 처럼 앞이 변수라 뒤쪽 경로까지 본다).
  // 다른 코드는 주석 · 도움말 속 경로가 많아 따라가면 시험이 전부 이어지니 import · require 의 상대 경로만 따라간다
  const isTest = /^(?:test\/|athena\/test\/)/.test(file)
  const wide = isTest
  for (const match of text.matchAll(RELATIVE)) {
    const target = resolveFile(join(dir, match[1] ?? ''))
    if (target) found.add(target)
  }
  for (const match of text.matchAll(PATHLIKE)) {
    const token = (match[0] ?? '').replace(/\/$/, '')
    if (token.includes('..') || token.startsWith('http')) continue
    // 레포 맨 위 · 코어(athena/) 맨 위 · 이 파일이 있는 폴더 기준으로 본다. 코어를 복사해 도는 시험은 `$SRC/scripts/…` 처럼 앞에 변수가 붙는다 → 뒤쪽 경로로도 본다
    const segments = token.split('/')
    if (!wide) break
    for (let start = 0; start < segments.length - 1; start++) {
      const tail = segments.slice(start).join('/')
      for (const base of ['', 'athena/', `${dir}/`]) {
        const target = resolveFile(`${base}${tail}`)
        if (target) found.add(target)
        else if (isTest) for (const inner of directChildren(normalize(`${base}${tail}`))) found.add(inner)
      }
    }
  }
  if (wide) {
    for (const match of text.matchAll(BARE_FILE)) {
      const same = byName.get(match[1] ?? '') ?? []
      if (same.length > 0 && same.length <= 3) for (const target of same) found.add(target)
    }
  }
  found.delete(file)
  const result = [...found]
  edgeCache.set(file, result)
  return result
}

/** @param {string} start 시험에서 따라 닿는 파일 전부 */
const reach = (start) => {
  const seen = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.pop() ?? ''
    for (const next of edgesOf(current)) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

const tests = [
  ...tracked.filter((path) => /^test\/[^/]+\.test\.js$/.test(path)).map((path) => ['JS', path]),
  ...tracked.filter((path) => /^athena\/test\/[^/]+\.sh$/.test(path)).map((path) => ['SH', path]),
]
const changedSet = new Set(changed)
/** 바뀐 파일 중 어떤 시험이 닿았는지 */
const covered = new Set()
for (const [kind, test] of tests) {
  const reached = reach(test ?? '')
  const hits = changed.filter((path) => path === test || reached.has(path))
  if (hits.length === 0) continue
  for (const path of hits) covered.add(path)
  console.log(`${kind} ${test}`)
}
// 앱 소스(src · scripts · bin 의 코드)가 바뀌었는데 어떤 시험도 닿지 않으면 고르지 못한 것 — 전체를 돌리게 한다
const uncovered = changed.filter((path) => /^(?:src|scripts|bin)\/.+\.(?:js|mjs|cjs|mts|ts|tsx|jsx)$/.test(path) && !covered.has(path))
if (uncovered.length > 0) {
  console.error(`닿는 시험을 못 찾은 앱 소스: ${uncovered.slice(0, 5).join(', ')} → 전체`)
  process.exit(2)
}
