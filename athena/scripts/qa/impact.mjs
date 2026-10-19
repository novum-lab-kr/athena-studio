#!/usr/bin/env node
/**
 * 영향 화면 산출 — 변경 파일에서 import 를 거꾸로 따라가 그 파일을 쓰는 화면(라우트)을 모두 찾는다.
 * dependency-cruiser 로 import 를 거꾸로 따라간다 · 가까운 화면부터
 *
 *   node scripts/qa/impact.mjs --cwd <레포 또는 워크트리> --app <앱> [--base <ref>] [--files a,b] [--json]
 *
 *   --cwd    그 앱의 레포 루트(또는 그 안 아무 곳). 워크트리면 워크트리 경로. 없으면 repos/<레포>
 *   --app    팩에 등록한 앱(scripts/qa/apps.mjs — 단일 레포는 레포 이름, 모노레포는 앱 이름). 설정이 있는 앱이 하나면 생략 가능
 *            Pages Router·App Router 둘 다(앱 폴더의 app/·pages/·src/app/·src/pages/)
 *            App Router 는 화면 = app/…/page.tsx, 라우트 그룹 (x) 는 주소에서 뺀다. layout·template·loading·error·not-found 는
 *            import 로 이어지지 않으므로 "그 폴더 아래 화면 전부" 로 친다(루트 layout 이 바뀌면 화면 전부)
 *   --base   비교 기준 ref. 기본은 그 앱의 prBase(origin/<prBase>) — merge-base 부터의 변경 + 미커밋 + 추적 안 된 파일
 *   --files  변경 파일을 직접 준다(모노레포 루트 기준, 쉼표). 주면 git 을 보지 않는다
 *   --all    변경과 무관하게 화면 전부(전체 검수 — run.mjs --suite)
 *   --json   결과를 JSON 으로 (runner·현황판이 읽는다). 없으면 사람이 읽는 표
 *   --events 화면마다 코드에 있는 트래킹 이벤트 목록(events) 을 덧붙인다 — 화면 파일에서 import 를 앞으로 따라가며
 *            sendViewEvent·sendClickEvent·sendScrollEvent('이름') 과 ScrollEventWrapper sectionId 를 모은다.
 *            순수 재수출 파일(barrel index.ts)은 건너뛴다(안 쓰는 컴포넌트까지 붙지 않게) — 그래서 근사치다
 */
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cruise } from 'dependency-cruiser'
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config'
import { loadConfig } from '../lib/config.mjs'
import { listQaApps, findQaApp, defaultQaApp, readRoutes, inApp, routerDirOf, isScreenPath, routeOfPath, codeConventions } from './apps.mjs'

const HERMES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] ?? '' : ''
}
const flag = (name) => argv.includes(`--${name}`)

const config = loadConfig(HERMES)
const appName = option('app') || defaultQaApp(config) || ''
const qaApp = findQaApp(config, appName)
if (!qaApp) {
  console.error(`⚠️  ${appName ? `QA 대상 앱이 아니다: ${appName}` : 'QA 대상 앱을 골라 주세요(--app)'} — ${listQaApps(config).map((entry) => entry.app).join(', ') || '팩에 등록한 화면 레포가 없다'}`)
  process.exit(2)
}
const routesConfig = readRoutes(appName) ?? {}
// 로그인 가드·트래킹 함수 이름 — routes authGuard·tracking(없으면 기본값)
let conventions
try {
  conventions = codeConventions(appName, routesConfig)
} catch (error) {
  console.error(`⛔ ${error.message}`)
  process.exit(2)
}
const cwdOption = option('cwd') || join(HERMES, 'repos', qaApp.repo)
if (!existsSync(cwdOption)) {
  console.error(`⚠️  --cwd 경로가 없다: ${cwdOption}`)
  process.exit(2)
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// 심볼릭 링크(repos/…)를 실제 경로로 — dependency-cruiser 는 링크 경로와 실제 경로가 섞이면 패키지를 못 읽는다
const repoRoot = realpathSync(git(['rev-parse', '--show-toplevel'], cwdOption))
// 앱 폴더(레포 루트 기준) — 모노레포 apps/<앱>, 단일 레포는 '' (레포 루트)
const appDir = qaApp.dir
const appAbs = join(repoRoot, appDir)
// 라우터 — app/ 이 있으면 App Router, 아니면 pages/(Pages Router). src/ 아래도 본다
const routerDir = routerDirOf(appAbs)
if (!routerDir) {
  console.error(`⚠️  ${appDir || repoRoot} 에 app/·pages/(src/ 포함)가 없다 — Next.js 화면 앱이 아니면 QA 대상이 아니다`)
  process.exit(2)
}
const router = routerDir.endsWith('app') ? 'app' : 'pages'
const screenRoot = `${inApp(appDir, routerDir)}/`

if (!existsSync(join(repoRoot, 'node_modules'))) {
  console.error(`⚠️  ${repoRoot} 에 node_modules 가 없다 — tsconfig·workspace 패키지를 읽으려면 먼저 의존성 설치가 필요하다 (run.mjs 는 알아서 한다)`)
  process.exit(2)
}

const prBase = qaApp.prBase

// 이 앱 전체에 닿는 파일 — 바뀌면 모든 화면이 영향 범위. 레포마다 더 있으면 routes/<앱>.json globalPaths(레포 루트 기준 경로 앞부분)
const GLOBAL_FILES = [
  ...(router === 'pages' ? ['_app', '_document', '_error'].flatMap((name) => ['tsx', 'jsx', 'ts', 'js'].map((extension) => `${screenRoot}${name}.${extension}`)) : []),
  ...['next.config.js', 'next.config.mjs', 'next.config.ts', 'proxy.ts', 'middleware.ts', 'src/middleware.ts', 'instrumentation.ts', 'src/instrumentation.ts',
    'tailwind.config.ts', 'tailwind.config.js', 'postcss.config.mjs', 'postcss.config.js', 'package.json', 'tsconfig.json'].map((file) => inApp(appDir, file)),
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json'
]
const GLOBAL_PATHS = routesConfig.globalPaths ?? []
const isGlobalFile = (file) => GLOBAL_FILES.includes(file) || GLOBAL_PATHS.some((prefix) => file.startsWith(prefix))

// ── 1) 변경 파일 ─────────────────────────────────────────
function changedFiles() {
  const given = option('files')
  if (given) return given.split(',').map((file) => file.trim()).filter(Boolean)
  const baseRef = option('base') || `origin/${prBase}`
  const mergeBase = git(['merge-base', baseRef, 'HEAD'], repoRoot)
  const lists = [
    git(['diff', '--name-only', `${mergeBase}...HEAD`], repoRoot),
    git(['diff', '--name-only', 'HEAD'], repoRoot),
    git(['ls-files', '--others', '--exclude-standard'], repoRoot)
  ]
  return [...new Set(lists.join('\n').split('\n').filter(Boolean))]
}

// ── 2) 화면 목록 (Pages Router · App Router) ─────────────
// App Router 에서 import 없이 Next 가 화면을 감싸는 파일 — 바뀌면 그 폴더 아래 화면 전부
const SEGMENT_FILES = new Set(['layout', 'template', 'loading', 'error', 'not-found', 'default', 'global-error'])
const CODE_FILE = /\.(tsx|ts|jsx|js)$/
// 화면 파일 → 주소(라우트) · 화면인가 — 규칙은 apps.mjs(init-app.mjs 와 같이 쓴다)
const routeOf = (pageFile) => routeOfPath(pageFile.slice(screenRoot.length), router)
const isScreen = (file) => file.startsWith(screenRoot) && isScreenPath(file.slice(screenRoot.length), router)
// App Router 의 layout 등 — 그 파일이 있는 폴더(app/ 기준)
function segmentDirOf(file) {
  if (router !== 'app' || !file.startsWith(screenRoot) || !CODE_FILE.test(file)) return null
  const baseName = file.split('/').pop().replace(/\.\w+$/, '')
  return SEGMENT_FILES.has(baseName) ? dirname(file) : null
}
const isUnder = (file, dir) => file.startsWith(`${dir}/`)

// ── 3) 의존 그래프 ───────────────────────────────────────
async function buildGraph() {
  const tsConfigFile = join(appAbs, 'tsconfig.json')
  const previousCwd = process.cwd()
  process.chdir(repoRoot)
  try {
    const result = await cruise(
      [screenRoot.slice(0, -1)],
      {
        baseDir: repoRoot,
        tsPreCompilationDeps: true,
        combinedDependencies: true,
        // @repo/* 는 workspace 패키지라 따라간다. 외부 node_modules 는 끊는다
        doNotFollow: { path: 'node_modules/(?!@repo/)' },
        exclude: { path: '\\.(svg|png|jpe?g|gif|webp|ico|woff2?)$' },
        enhancedResolveOptions: {
          exportsFields: ['exports'],
          conditionNames: ['import', 'require', 'node', 'default', 'types'],
          extensions: ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.json']
        },
        tsConfig: { fileName: tsConfigFile }
      },
      undefined,
      { tsConfig: extractTSConfig(tsConfigFile) }
    )
    return result.output.modules
  } finally {
    process.chdir(previousCwd)
  }
}

// ── 4) 역추적 — 변경 파일에서 위로 BFS (가까운 화면부터 · D9) ──
function traceScreens(modules, changed) {
  const importers = new Map() // 파일 → 그 파일을 import 하는 파일들
  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (dependency.couldNotResolve) continue
      if (!importers.has(dependency.resolved)) importers.set(dependency.resolved, [])
      importers.get(dependency.resolved).push(module.source)
    }
  }
  const known = new Set(modules.map((module) => module.source))
  const allScreens = modules.map((module) => module.source).filter(isScreen).sort()

  // 전체 검수 — 바뀐 파일과 무관하게 화면 전부
  if (flag('all')) {
    return { global: [], screens: allScreens.map((file) => ({ file, route: routeOf(file), distance: 0, changed: '(전체 검수)', via: [file] })) }
  }
  const globalHits = changed.filter(isGlobalFile)
  if (globalHits.length) {
    return {
      global: globalHits,
      screens: allScreens.map((file) => ({ file, route: routeOf(file), distance: 0, changed: globalHits[0], via: [globalHits[0], file] }))
    }
  }

  // 여러 시작점 BFS — 각 파일에 처음 닿은 경로가 최단 경로
  const parent = new Map()
  const origin = new Map()
  const distance = new Map()
  const queue = []
  for (const file of changed.filter((file) => known.has(file))) {
    distance.set(file, 0)
    origin.set(file, file)
    queue.push(file)
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    // layout 등은 import 하는 쪽이 없다 — 그 폴더 아래 화면들이 "쓰는" 것으로 친다
    const segmentDir = segmentDirOf(current)
    const wrapped = segmentDir ? allScreens.filter((file) => isUnder(file, segmentDir)) : []
    for (const importer of [...(importers.get(current) ?? []), ...wrapped]) {
      if (distance.has(importer)) continue
      distance.set(importer, distance.get(current) + 1)
      parent.set(importer, current)
      origin.set(importer, origin.get(current))
      queue.push(importer)
    }
  }

  const chainOf = (file) => {
    const chain = [file]
    while (parent.has(chain[0])) chain.unshift(parent.get(chain[0]))
    return chain
  }
  const screens = [...distance.keys()]
    .filter(isScreen)
    .map((file) => ({ file, route: routeOf(file), distance: distance.get(file), changed: origin.get(file), via: chainOf(file) }))
    .sort((left, right) => left.distance - right.distance || left.route.localeCompare(right.route))
  return { global: [], screens }
}

// 로그인 필요 화면 표시용 — 화면 파일(App Router 는 감싸는 layout 까지)이 로그인 가드(routes authGuard, 기본 …AuthGuard)를 쓰는지만 본다(실제 판정은 runner 가 이동 여부로)
const AUTH_GUARD = conventions.authGuard
function usesAuthGuard(file) {
  const read = (path) => {
    try {
      return readFileSync(join(repoRoot, path), 'utf8')
    } catch {
      return ''
    }
  }
  if (AUTH_GUARD.test(read(file))) return true
  if (router !== 'app') return false
  for (let dir = dirname(file); dir.length >= screenRoot.length - 1; dir = dirname(dir)) {
    for (const extension of ['tsx', 'ts', 'jsx', 'js']) {
      if (AUTH_GUARD.test(read(`${dir}/layout.${extension}`))) return true
    }
  }
  return false
}

// ── 5) 트래킹 이벤트 목록(--events) ───────────────────────
// 함수 이름·컴포넌트 이름은 routes tracking(없으면 sendViewEvent… · ScrollEventWrapper · PageViewEventLogger) — 식별자만 받으므로 정규식에 그대로 넣는다
const EVENT_SUFFIX = conventions.calls
const EVENT_CALL = new RegExp(`\\b(${Object.keys(EVENT_SUFFIX).map((name) => name.replaceAll('$', '\\$')).join('|')})\\(\\s*(?:(['"\`])((?:(?!\\2)[^\\\\]|\\\\.)*)\\2|([\\w.]+))`, 'g')
const SECTION_USE = new RegExp(`<${conventions.section.tag}[^>]*?${conventions.section.prop}=\\{?\\s*['"\`]([^'"\`]+)['"\`]`, 'g')
// 화면을 열면 반드시 나가는 화면 보기 이벤트 — <PageViewEventLogger pageName={'more'}> → more_viewed (이름이 글자로 적힌 것만)
const PAGE_VIEW_USE = new RegExp(`<${conventions.pageView.tag}[^>]*?${conventions.pageView.prop}=\\{?\\s*(['"\`])([^'"\`$]+)\\1`, 'g')
const sourceCache = new Map()
const sourceOf = (file) => {
  if (!sourceCache.has(file)) {
    let text = ''
    try {
      text = readFileSync(join(repoRoot, file), 'utf8')
    } catch {
      text = ''
    }
    sourceCache.set(file, text)
  }
  return sourceCache.get(file)
}
// 줄마다 export … from 만 있는 파일 — 안 쓰는 것까지 끌고 오므로 따라가지 않는다
const isBarrel = (file) => /\/index\.tsx?$/.test(file) && sourceOf(file).split('\n').every((line) => !line.trim() || /^(export\s.*\sfrom\s|export\s\*|\/\/|\/\*|\*)/.test(line.trim()))
function eventsIn(file) {
  const text = sourceOf(file)
  const found = []
  const lineAt = (index) => text.slice(0, index).split('\n').length
  for (const match of text.matchAll(EVENT_CALL)) {
    const [, call, , literal, variable] = match
    const kind = EVENT_SUFFIX[call].slice(1)
    if (literal !== undefined && !literal.includes('${')) found.push({ kind, name: `${literal}${EVENT_SUFFIX[call]}`, at: `${file}:${lineAt(match.index)}` })
    else found.push({ kind, name: null, dynamic: (literal ?? variable).slice(0, 60), at: `${file}:${lineAt(match.index)}` })
  }
  for (const match of text.matchAll(SECTION_USE)) found.push({ kind: 'scroll', section: match[1], name: null, at: `${file}:${lineAt(match.index)}` })
  for (const match of text.matchAll(PAGE_VIEW_USE)) found.push({ kind: 'viewed', name: `${match[2]}_viewed`, pageView: true, at: `${file}:${lineAt(match.index)}` })
  return found
}
function eventInventory(modules, screenFiles) {
  const dependencies = new Map(modules.map((module) => [module.source, module.dependencies.filter((dependency) => !dependency.couldNotResolve).map((dependency) => dependency.resolved)]))
  const inventory = {}
  for (const page of screenFiles) {
    // 가까운 파일부터(BFS) — 화면 보기 이벤트는 화면 파일·바로 쓰는 컴포넌트(2단계 안)에 있을 때만 "필수"(더 깊으면 조건부일 수 있다)
    const depth = new Map([[page, 0]])
    const queue = [page]
    const events = []
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const file = queue[cursor]
      events.push(...eventsIn(file).map((event) => (event.pageView ? { ...event, required: depth.get(file) <= 2 } : event)))
      for (const next of dependencies.get(file) ?? []) {
        if (depth.has(next) || next.includes('node_modules/') && !next.includes('@repo/') || isBarrel(next)) continue
        // 다른 화면 파일은 그 화면 몫이다
        if (isScreen(next)) continue
        depth.set(next, depth.get(file) + 1)
        queue.push(next)
      }
    }
    // 같은 이벤트가 여러 곳에 있으면 하나로(처음 위치)
    const unique = new Map()
    for (const event of events) {
      const key = `${event.kind}:${event.name ?? event.section ?? event.dynamic}`
      if (!unique.has(key)) unique.set(key, event)
    }
    inventory[routeOf(page)] = [...unique.values()]
  }
  return inventory
}

const changed = flag('all') ? [] : changedFiles()
const modules = await buildGraph()
const { global, screens } = traceScreens(modules, changed)
const known = new Set(modules.map((module) => module.source))
const result = {
  app: appName,
  repoRoot,
  head: git(['rev-parse', '--short', 'HEAD'], repoRoot),
  base: option('files') ? null : option('base') || `origin/${prBase}`,
  changed: changed.map((file) => ({ file, inGraph: known.has(file), global: isGlobalFile(file) })),
  global,
  totalScreens: modules.map((module) => module.source).filter(isScreen).length,
  screens: screens.map((screen) => ({ ...screen, auth: usesAuthGuard(screen.file) }))
}
if (flag('events')) result.events = eventInventory(modules, screens.map((screen) => screen.file))

if (flag('json')) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else {
  console.log(`📍 ${appName} · ${relative(HERMES, repoRoot) || repoRoot} @ ${result.head} · 기준 ${result.base ?? '(--files)'}`)
  console.log(`변경 파일 ${changed.length}개 (그래프 안 ${result.changed.filter((item) => item.inGraph).length}개)`)
  if (global.length) console.log(`⚠️  공통 파일 변경 — 화면 전부: ${global.join(', ')}`)
  console.log(`영향 화면 ${screens.length} / ${result.totalScreens}`)
  for (const screen of result.screens) {
    const hops = screen.distance === 0 ? '직접' : `${screen.distance}단계`
    console.log(`  ${screen.route.padEnd(48)} ${hops.padEnd(5)} ${screen.auth ? '🔒' : '  '} ← ${screen.changed}`)
  }
}
