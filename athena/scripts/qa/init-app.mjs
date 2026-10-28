#!/usr/bin/env node
/**
 * QA 초안 만들기 — 팩에 등록한 화면 레포(앱)의 화면 목록을 운영 기준 ref 에서 읽어
 *   routes/<앱>.json   QA 설정 초안(서버 포트·띄우는 명령·로그인 경로·화면별 설정)
 *   tc/<앱>.md         TC 초안(화면마다 "열린다" 스모크 TC 하나 — 기능 TC 는 사람이 채운다)
 * 을 팩 qa/ 아래에 쓴다(팩이 없으면 코어 scripts/qa/routes · docs/qa/tc). /setup 이 레포마다 부른다.
 *
 *   node scripts/qa/init-app.mjs --app <앱> | --all [--ref <git ref>] [--prefix <TC ID 접두사>] [--dry-run]
 *
 *   --app     QA 대상 앱(scripts/qa/apps.mjs — 단일 레포는 레포 이름, 모노레포는 앱 이름)
 *   --all     등록한 화면 레포의 앱 전부
 *   --ref     읽을 ref(기본 origin/<운영 기준 브랜치>, 없으면 그 로컬 브랜치). 레포는 읽기만 한다(fetch·체크아웃 안 함)
 *   --dry-run 쓰지 않고 무엇을 쓸지만 보여 준다
 *
 * 이미 있는 파일은 덮지 않는다 — 대신 코드에는 있는데 routes 에 없는 동적 화면, routes 에만 있는 화면을 알려 준다.
 * 추정한 값과 사람이 채울 값은 routes 의 "$todo" 에 적는다(run.mjs 는 $ 로 시작하는 키를 읽지 않는다).
 * 로그인 쿠키(server.tokenCookie)는 코드의 쿠키 읽기·쓰기(cookies.get('…') · getCookie('…') 등)에서 후보만 찾아 $todo 에 적고 값은 비워 둔다.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.mjs'
import { listQaApps, inApp, isScreenPath, routeOfPath, ROUTES_DIR } from './apps.mjs'

const HERMES = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] ?? '' : ''
}
const flag = (name) => argv.includes(`--${name}`)
const dryRun = flag('dry-run')

const config = loadConfig(HERMES)
const apps = listQaApps(config)
const wanted = flag('all') ? apps : apps.filter((entry) => entry.app === option('app'))
if (!wanted.length) {
  console.error(`사용: node scripts/qa/init-app.mjs --app <앱> | --all — 등록한 앱: ${apps.map((entry) => entry.app).join(', ') || '(없음 — 팩에 화면 레포가 없다)'}`)
  process.exit(2)
}

// 쓸 곳 — 팩이 있으면 팩 qa/routes · qa/docs/tc(코어 자리는 athena pack link 가 링크로 잇는다)
const routesOut = config.packDir ? join(config.packDir, 'qa', 'routes') : ROUTES_DIR
const tcOut = config.packDir ? join(config.packDir, 'qa', 'docs', 'tc') : join(HERMES, 'docs', 'qa', 'tc')

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim()
const tryGit = (cwd, args) => { try { return git(cwd, args) } catch { return null } }
const showJson = (cwd, ref, path) => { try { return JSON.parse(git(cwd, ['show', `${ref}:${path}`])) } catch { return null } }

// TC ID 접두사 — 앱 이름 낱말의 첫 글자(shop-web → SW). 영문이 아니면 TC
const prefixOf = (app) => {
  const initials = app.split(/[-_.\s]+/).map((word) => word[0] ?? '').join('').toUpperCase().replace(/[^A-Z]/g, '')
  return initials.length >= 2 ? initials : (app.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'TC')
}

// dev 스크립트에서 포트 말고 붙어 있는 옵션(예: --webpack · --turbopack)을 가져온다. next dev 가 아니면 null
function devFlags(script) {
  const match = String(script ?? '').match(/\bnext\s+dev\b(.*)$/)
  if (!match) return null
  return match[1].replace(/(?:-p|--port)[=\s]+\d+/g, '').split(/\s+/).filter((part) => part && !/[&|;]/.test(part))
}

// 로그인 쿠키 이름 후보 — 코드에서 쿠키를 이름(글자)으로 읽고 쓰는 곳. 템플릿 글자(`B_AT_${env}`)는 ${ 앞까지(앞부분)를 이름으로 본다.
// 토큰·세션처럼 보이는 이름을 앞에, 같으면 많이 나온 순. 값은 보지 않는다(이름만)
const COOKIE_CALL = "(cookies(\\(\\))?\\.(get|set|has|delete)|[gs]etCookie|deleteCookie|removeCookie|Cookies\\.(get|set|remove))\\([[:space:]]*['\"`][A-Za-z0-9_.-]+"
const TOKENISH = /token|auth|sess|sid|jwt|access|refresh|(^|[_-])at([_-]|$)|(^|[_-])rt([_-]|$)/i
function cookieCandidates(root, ref, paths) {
  const found = tryGit(root, ['grep', '-h', '-o', '-E', '-I', COOKIE_CALL, ref, '--', ...paths]) ?? ''
  const counts = new Map()
  for (const line of found.split('\n')) {
    const name = line.match(/['"`]([A-Za-z0-9_.-]+)$/)?.[1]
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => Number(TOKENISH.test(right[0])) - Number(TOKENISH.test(left[0])) || right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([name, count]) => `${name}(${count}곳)`)
}

let failed = 0
for (const entry of wanted) {
  const repoDir = join(HERMES, 'repos', entry.repo)
  const label = `${entry.app}${entry.dir ? ` (${entry.repo}/${entry.dir})` : ` (${entry.repo})`}`
  if (!existsSync(repoDir)) {
    console.log(`⏭  ${label} — repos/${entry.repo} 가 없다(scripts/setup.sh 로 링크)`)
    failed += 1
    continue
  }
  const root = realpathSync(repoDir)
  const ref = option('ref') || [`origin/${entry.branch}`, entry.branch].find((candidate) => candidate && tryGit(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]))
  if (!ref) {
    console.log(`⏭  ${label} — 운영 기준 브랜치(${entry.branch || '없음'})를 찾지 못했다 — --ref 로 준다`)
    failed += 1
    continue
  }
  const sha = git(root, ['rev-parse', '--short', ref])
  const pkg = showJson(root, ref, inApp(entry.dir, 'package.json'))
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  if (!deps.next) {
    console.log(`⏭  ${label} — Next.js 앱이 아니다(${inApp(entry.dir, 'package.json')} 에 next 가 없다) — QA 시뮬레이션은 Next 화면 앱만`)
    continue
  }
  const files = (tryGit(root, ['ls-tree', '-r', '--name-only', ref, '--', entry.dir || '.']) ?? '').split('\n').filter(Boolean)
  const routerDir = ['app', 'src/app', 'pages', 'src/pages'].find((dir) => {
    const prefix = `${inApp(entry.dir, dir)}/`
    return files.some((file) => file.startsWith(prefix) && isScreenPath(file.slice(prefix.length), dir.endsWith('app') ? 'app' : 'pages'))
  })
  if (!routerDir) {
    console.log(`⏭  ${label} — ${ref} 에 화면 파일(app/·pages/, src/ 포함)이 없다`)
    continue
  }
  const router = routerDir.endsWith('app') ? 'app' : 'pages'
  const screenRoot = `${inApp(entry.dir, routerDir)}/`
  const screens = files.filter((file) => file.startsWith(screenRoot) && isScreenPath(file.slice(screenRoot.length), router))
    .map((file) => ({ file, route: routeOfPath(file.slice(screenRoot.length), router) }))
    .sort((left, right) => left.route.localeCompare(right.route))
  const dynamic = screens.filter((screen) => screen.route.includes('['))
  const signIn = screens.find((screen) => /\/(sign-?in|log-?in)$/i.test(screen.route))?.route ?? ''
  const signOut = screens.find((screen) => /\/(sign-?out|log-?out)$/i.test(screen.route))?.route ?? ''
  const flags = devFlags(pkg.scripts?.dev)
  const prepareCandidates = Object.keys(pkg.scripts ?? {}).filter((name) => /^(gen|generate|codegen|relay)(:|$)/.test(name))
  // 모노레포는 앱 폴더 + 공통 packages/(로그인 처리가 공통 패키지에 있는 경우가 많다)
  const cookieNames = cookieCandidates(root, ref, entry.dir ? [entry.dir, 'packages'] : ['.'])
  const todo = [
    `server.tokenCookie — 로그인하면 생기는 쿠키 이름(앞부분). 비우면 세션 파일이 있으면 살아 있다고 본다 · ${cookieNames.length ? `코드에서 찾은 후보: ${cookieNames.join(' · ')}` : '코드에서 쿠키 이름을 찾지 못했다 — 로그인 뒤 브라우저 개발자 도구에서 본다'}`,
    'devUrl — 배포된 개발 서버 주소(dev·stg). 운영 주소는 QA 가 거부한다',
    signIn ? `signInPath — 화면 이름으로 추정(${signIn})` : 'signInPath — 로그인 화면 주소를 찾지 못했다',
    'authPaths — 로그인 중에 거치는 경로(간편인증 콜백 등)가 있으면 더한다',
    ...(flags === null ? [`server.dev — dev 스크립트가 next dev 가 아니다(${pkg.scripts?.dev ?? '없음'}) — 띄우는 명령을 적는다`] : []),
    ...(prepareCandidates.length ? [`server.prepare — dev 전에 돌릴 스크립트 후보: ${prepareCandidates.join(', ')}`] : []),
    ...(dynamic.length ? [`routes — 동적 화면 ${dynamic.length}개에 samples(실제 주소)를 적는다`] : []),
    'routes — 열기만 해도 부작용(알림 발송·실조회)이 있는 화면은 skip: true'
  ]
  const routesDraft = {
    $comment: `scripts/qa/init-app.mjs 초안 — ${ref}@${sha} 화면 ${screens.length}개 (${new Date().toISOString().slice(0, 10)}). $todo 를 채우고 지운다`,
    $todo: todo,
    devUrl: '',
    signInPath: signIn,
    ...(signOut ? { signOutPath: signOut } : {}),
    server: {
      port: 3291,
      tokenCookie: '',
      ...(flags?.length ? { dev: ['{exec}', 'next', 'dev', '-p', '{port}', ...flags] } : {}),
      prepare: []
    },
    viewports: [{ name: 'desktop', width: 1280, height: 860 }, { name: 'mobile', width: 390, height: 844 }],
    concurrency: 3,
    timeoutMs: 30000,
    profiles: {
      logout: { session: null, note: '로그인 안 한 상태' },
      ...(signIn ? { login: { session: 'login', note: '로그인한 상태 — 현황판 QA 탭에서 로그인' } } : {})
    },
    routes: Object.fromEntries(dynamic.map((screen) => [screen.route, { samples: [], note: '동적 라우트 — samples 에 실제 주소를 적어 주세요' }]))
  }
  // {exec} — 패키지 관리자 실행 명령(pnpm exec · yarn · npx). 초안에는 lockfile 로 정해 넣는다
  if (routesDraft.server.dev) {
    const lock = tryGit(root, ['ls-tree', '--name-only', ref, '--', 'pnpm-lock.yaml', 'yarn.lock']) ?? ''
    const exec = lock.includes('pnpm-lock.yaml') ? ['pnpm', 'exec'] : lock.includes('yarn.lock') ? ['yarn'] : ['npx', '--no-install']
    routesDraft.server.dev.splice(0, 1, ...exec)
  }

  const prefix = option('prefix') || prefixOf(entry.app)
  const cell = (text) => String(text).replace(/\|/g, '\\|')
  const tcRows = screens.map((screen, index) => {
    const id = `${prefix}-${String(index + 1).padStart(3, '0')}`
    const isDynamic = screen.route.includes('[')
    return `| ${id} | 화면 | ${cell(screen.route)} 화면이 열린다 | logout | 전체 | ${isDynamic ? 'routes samples 에 실제 주소' : '-'} | ${cell(screen.route)} 를 연다 | 깨짐·콘솔 오류 없이 열린다(로그인이 필요하면 로그인 화면으로 이동) | 스모크(전체 검수 화면 검사) | 보통 | \`${cell(screen.file)}\` |`
  })
  const tcDoc = `# ${entry.label} QA TC (초안)

> \`scripts/qa/init-app.mjs\` 가 \`${ref}@${sha}\` 의 화면 목록으로 만든 초안(${new Date().toISOString().slice(0, 10)}).
> 화면마다 "열린다" 스모크 TC 하나씩이다 — 기능 TC(누르고 입력하는 흐름)는 사람이 채우고, 흐름 씬(\`scripts/qa/scenarios/${entry.app}/\`)이 생기면 자동화 칸을 바꾼다.
> 세션 칸은 모두 logout 으로 두었다 — 로그인이 필요한 화면은 전체 검수에서 "로그인 필요" 로 나온다. 확인 필요.

## A) 화면

| 주소 | 파일 |
|---|---|
${screens.map((screen) => `| ${cell(screen.route)} | \`${cell(screen.file)}\` |`).join('\n')}

## B) TC

| ID | 분류 | 제목 | 세션 | 뷰포트 | 사전 조건 | 단계 | 기대 결과 | 자동화 | 우선 | 근거 |
|---|---|---|---|---|---|---|---|---|---|---|
${tcRows.join('\n')}
`

  console.log(`📋 ${label} · ${ref}@${sha} · ${router === 'app' ? 'App Router' : 'Pages Router'}(${screenRoot}) · 화면 ${screens.length}개${dynamic.length ? ` (동적 ${dynamic.length})` : ''}`)
  const outputs = [
    { path: join(routesOut, `${entry.app}.json`), text: `${JSON.stringify(routesDraft, null, 2)}\n`, kind: 'routes' },
    { path: join(tcOut, `${entry.app}.md`), text: tcDoc, kind: 'tc' }
  ]
  let wroteRoutes = false
  for (const output of outputs) {
    const shown = relative(HERMES, output.path)
    if (existsSync(output.path)) {
      // 있는 파일은 덮지 않는다 — routes 면 코드와 어긋난 화면만 알려 준다
      if (output.kind === 'routes') {
        let current = {}
        try { current = JSON.parse(readFileSync(output.path, 'utf8')) } catch { current = {} }
        const known = new Set(Object.keys(current.routes ?? {}))
        const codeRoutes = new Set(screens.map((screen) => screen.route))
        const missing = dynamic.filter((screen) => !known.has(screen.route)).map((screen) => screen.route)
        const gone = [...known].filter((route) => !codeRoutes.has(route))
        console.log(`   = ${shown} 이미 있음 — 덮지 않음${missing.length ? ` · 설정 없는 동적 화면: ${missing.join(', ')}` : ''}${gone.length ? ` · 코드에 없는 화면: ${gone.join(', ')}` : ''}`)
      } else {
        console.log(`   = ${shown} 이미 있음 — 덮지 않음`)
      }
      continue
    }
    if (dryRun) {
      console.log(`   (dry-run) ${shown} — ${output.text.split('\n').length}줄`)
      if (output.kind === 'routes') wroteRoutes = true
      continue
    }
    mkdirSync(dirname(output.path), { recursive: true })
    writeFileSync(output.path, output.text)
    if (output.kind === 'routes') wroteRoutes = true
    console.log(`   + ${shown}`)
  }
  if (wroteRoutes) for (const line of todo) console.log(`   · 확인 필요: ${line}`)
}

// 팩에 qa/ 폴더가 새로 생겼으면 코어 자리(scripts/qa/routes · docs/qa)에 링크를 건다
if (config.packDir && !dryRun) {
  const unlinked = ['scripts/qa/routes', 'docs/qa'].filter((at) => { try { return !lstatSync(join(HERMES, at)).isSymbolicLink() } catch { return true } })
  if (unlinked.length) execFileSync(process.execPath, [join(HERMES, 'scripts', 'athena.mjs'), 'pack', 'link'], { stdio: 'inherit' })
}
process.exit(failed ? 1 : 0)
