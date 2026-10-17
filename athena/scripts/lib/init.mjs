// athena init · scaffold — 새 회사 첫 실행(/setup)의 기계적인 부분. 판단이 필요한 내용 채우기는 /setup 스킬(Claude)이 한다.
//   scanRepos   reposRoot 아래(기본 3단계 깊이) git 레포를 훑어 이름·기준 브랜치·작업 base·종류(single·monorepo·packages)·층(fe·be)·언어·앱을 추정(읽기 전용, fetch 없음)
//   initPack    고른 레포로 빈 팩(pack.json · ROUTING.md · 폴더)과 athena.config.json 을 만든다
//   scaffold    pack.json 의 레포마다 에이전트 프로필 · 지식 뼈대(rules·structure·gotchas) · 검증 스크립트를 템플릿으로 만든다(있는 파일은 건드리지 않는다)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

const git = (dir, args) => {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const isDir = (path) => { try { return statSync(path).isDirectory() } catch { return false } }

const BRANCH_ORDER = ['prd', 'production', 'prod', 'main', 'master']
const BASE_ORDER = ['dev', 'develop', 'development', 'main', 'master']
const pick = (order, names) => order.find((name) => names.includes(name)) ?? ''

// 레포 하나를 읽어 추정한다 — 추정은 /setup 이 사용자에게 확인받는다
export const inspectRepo = (dir) => {
  const name = basename(dir)
  const remote = git(dir, ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin']).split('\n').filter((ref) => ref && ref !== 'HEAD')
  const local = git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean)
  const branches = remote.length ? remote : local
  const pkg = readJson(join(dir, 'package.json')) ?? {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const python = existsSync(join(dir, 'pyproject.toml'))
  const pyText = python ? readFileSync(join(dir, 'pyproject.toml'), 'utf8') : ''
  const appsDir = join(dir, 'apps')
  const apps = isDir(appsDir) ? readdirSync(appsDir).filter((app) => existsSync(join(appsDir, app, 'package.json'))).sort() : []
  const workspace = existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, 'turbo.json')) || Array.isArray(pkg.workspaces) || Boolean(pkg.workspaces?.packages)
  let kind = 'single'
  if (workspace && apps.length) kind = 'monorepo'
  else if (workspace && existsSync(join(dir, '.changeset'))) kind = 'packages'
  const backend = existsSync(join(dir, 'nest-cli.json')) || Boolean(deps['@nestjs/core']) || Boolean(deps.express && !deps.react) || /fastapi|django|flask/i.test(pyText)
  const mobile = Boolean(deps['react-native'] || deps.expo)
  // 설정값 그대로(insteadOf 로 바꿔 쓰기 전) — 조직 이름을 읽는다
  const origin = git(dir, ['config', '--get', 'remote.origin.url'])
  const org = origin.match(/github\.com[:/]([^/]+)\//)?.[1] ?? ''
  const prBase = pick(BASE_ORDER, branches) || branches[0] || ''
  // 모노레포 — 레포 기준은 작업 base(공통 packages/* 가 따라간다), 앱마다 prd-<앱>·<앱 이름>-prd 같은 운영 브랜치가 있으면 앱 기준으로
  const appBranch = (app) => {
    const short = app.replace(/-(web|app)$/, '')
    return [`prd-${short}`, `prd-${app}`, `${short}-prd`, `production-${short}`].find((name) => branches.includes(name)) ?? (pick(BRANCH_ORDER, branches) || prBase)
  }
  return {
    name,
    branch: kind === 'monorepo' ? prBase : (pick(BRANCH_ORDER, branches) || branches[0] || ''),
    prBase,
    appBranches: Object.fromEntries(apps.map((app) => [app, appBranch(app)])),
    kind,
    layer: backend ? 'be' : 'fe',
    lang: python ? 'python' : (existsSync(join(dir, 'package.json')) ? 'node' : 'unknown'),
    mobile,
    apps,
    appDir: ['app', 'src', 'pages'].find((sub) => isDir(join(dir, sub))) ?? '',
    org,
    branches: branches.slice(0, 30),
  }
}

// reposRoot 아래를 depth 단계까지 내려가며 git 레포를 찾는다(회사·팀 폴더로 묶어 둔 경우). 레포를 찾으면 그 안으로는 더 내려가지 않는다.
// 숨김 폴더·node_modules·아테나 자신은 건너뛴다. 같은 레포의 워크트리(.git 이 파일)는 원래 레포와 하나로 친다.
// 이름(=팩 레포 이름)은 폴더 이름 — 겹치면 위 폴더 이름을 붙여 가른다. path 는 reposRoot 기준 상대 경로(이름과 다르면 설정 repoPaths 로 남긴다)
export const scanRepos = (root, athenaRoot, depth = 3) => {
  const base = resolve(athenaRoot, root)
  const self = realpathSync(athenaRoot)
  const found = []
  const walk = (dir, level) => {
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names.sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const path = join(dir, name)
      if (!isDir(path)) continue
      let real = ''
      try { real = realpathSync(path) } catch { continue }
      if (real === self || real.startsWith(self + '/')) continue
      if (existsSync(join(path, '.git'))) {
        const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        found.push({ path, common: common ? realpathSync(common) : real, worktree: !isDir(join(path, '.git')) })
        continue
      }
      if (level < depth) walk(path, level + 1)
    }
  }
  walk(base, 1)
  // 같은 레포(같은 git common dir) — 원래 체크아웃(.git 이 폴더)을 남긴다
  const byCommon = new Map()
  for (const entry of found) {
    const kept = byCommon.get(entry.common)
    if (!kept || (kept.worktree && !entry.worktree)) byCommon.set(entry.common, entry)
  }
  const repos = [...byCommon.values()].map((entry) => ({ ...inspectRepo(entry.path), path: relative(base, entry.path) }))
  const counts = repos.reduce((map, repo) => map.set(repo.name, (map.get(repo.name) ?? 0) + 1), new Map())
  for (const repo of repos) {
    if (counts.get(repo.name) > 1) repo.name = `${basename(dirname(repo.path)) || 'root'}-${repo.name}`
  }
  return repos
}

// 기본 에이전트 이름 — 레포(또는 앱) 이름 + -fe/-be. /setup 이 사용자에게 바꿀 기회를 준다
export const defaultAgents = (repo) => {
  const role = repo.layer === 'be' ? 'be' : 'fe'
  if (repo.kind === 'monorepo') {
    return {
      apps: Object.fromEntries(repo.apps.map((app) => [app, { agent: `${app.replace(/-(web|app)$/, '')}-fe`, branch: repo.appBranches?.[app] ?? repo.branch, prBase: repo.prBase }])),
      packagesAgent: `${repo.name}-packages-fe`,
    }
  }
  return { agents: [repo.mobile ? `${repo.name}-app` : `${repo.name}-${role}`] }
}

const routingDoc = (company, repos) => {
  const rows = repos.flatMap((repo) => {
    if (repo.kind === 'monorepo') {
      return [
        ...Object.entries(repo.apps).map(([app, spec]) => `| \`repos/${repo.name}/apps/${app}\` | \`${spec.agent}\` | 확인 필요 | \`origin/${spec.branch}\` |`),
        `| \`repos/${repo.name}/packages/*\` | \`${repo.packagesAgent}\` | 공통 패키지 | \`origin/${repo.branch}\` |`,
      ]
    }
    return [`| \`repos/${repo.name}\` | ${repo.agents.map((agent) => `\`${agent}\``).join(' · ')} | ${repo.layer === 'be' ? '**백엔드** ' : ''}확인 필요 | \`origin/${repo.branch}\` |`]
  })
  return `# ${company} 팩 — 담당 레포·에이전트·라우팅

> 회사 팩의 라우팅 정본. 코어 문서는 회사 레포를 모르고 이 문서를 가리킨다(\`pack/ROUTING.md\`). 기계 정본은 \`pack.json\`.
> \`athena init\` 이 만든 뼈대 — "확인 필요" 는 /setup 이 레포 코드를 읽고 채운다.

## 1. 담당 레포와 기준 브랜치

| 레포 | 에이전트 | 담당 범위 | 기준 브랜치 |
|---|---|---|---|
${rows.join('\n')}

## 2. 어느 레포인지 고르기
- 확인 필요 — 요청에 어떤 말(서비스 이름·화면·도메인)이 나오면 어느 레포인지. 같은 말이 여러 레포를 가리키면 반드시 되묻는다

## 3. 에이전트
레포 담당 에이전트는 위 표. 프로필은 팩 \`agents/<이름>.md\`(코어 \`.claude/agents/\` 에 링크).

## 4. 검증 스크립트

\`\`\`bash
${repos.map((repo) => `scripts/verify/${repo.name}.sh${repo.kind === 'monorepo' ? ' <앱>' : ''}`).join('\n')}
\`\`\`

## 5. 회사 스킬

| 명령 | 용도 |
|------|------|
| (없음) | 회사 전용 스킬은 팩 \`skills/<이름>/SKILL.md\` 에 둔다 |
`
}

// 이름과 다른 위치의 레포 → { 이름: reposRoot 기준 경로 } (기존 설정 것 위에). 없으면 null
const repoPaths = (current, repos) => {
  const paths = { ...(current?.repoPaths ?? {}) }
  for (const repo of repos) if (repo.path && repo.path !== repo.name) paths[repo.name] = repo.path
  return Object.keys(paths).length ? paths : null
}

// 고른 레포(스캔 결과 + 에이전트 이름)로 팩을 만든다
export const initPack = ({ athenaRoot, company, repos, names = [], org = '', reposRoot = '..' }) => {
  const packRel = `packs/${company}`
  const pack = resolve(athenaRoot, packRel)
  if (existsSync(join(pack, 'pack.json'))) throw new Error(`이미 팩이 있다: ${packRel}/pack.json`)
  const configPath = join(athenaRoot, 'athena.config.json')
  const current = readJson(configPath)
  if (current?.pack) throw new Error(`athena.config.json 이 이미 팩(${current.pack})을 가리킨다`)
  const entries = repos.map((repo) => {
    // 기본 에이전트 이름 — 사용자가 고친 값(agents · appsSpec · packagesAgent)이 있으면 그것
    const defaults = defaultAgents(repo)
    const entry = { name: repo.name, branch: repo.branch, prBase: repo.prBase, kind: repo.kind }
    if (repo.kind === 'monorepo') {
      entry.apps = repo.appsSpec ?? defaults.apps
      entry.packagesAgent = repo.packagesAgent ?? defaults.packagesAgent
    } else {
      entry.agents = repo.agents ?? defaults.agents
    }
    if (repo.layer === 'be') entry.layer = 'be'
    if (repo.lang === 'python') entry.lang = 'python'
    if (repo.appDir) entry.appDir = repo.appDir
    return entry
  })
  // 하나라도 실패하면 이번에 만든 파일·폴더를 지워 처음 상태로 되돌린다(반쯤 만든 팩이 "이미 팩이 있다" 로 다시 못 돌게 막지 않게).
  // 설정(athena.config.json)은 맨 마지막에 쓴다 — 팩이 다 만들어진 뒤에만 팩을 가리킨다
  const created = []
  const makeDir = (path) => { if (!existsSync(path)) { mkdirSync(path, { recursive: true }); created.push(path) } }
  const write = (path, text) => { const existed = existsSync(path); writeFileSync(path, text); if (!existed) created.push(path) }
  try {
    makeDir(pack)
    for (const sub of ['agents', 'skills', 'knowledge', 'verify', 'docs', 'sync', 'archive']) makeDir(join(pack, sub))
    const packJson = {
      $comment: `${company} 회사 팩 — 형식은 코어 docs/pack.md. athena init 이 만들었다`,
      name: company,
      names: [...new Set([company, ...names])],
      ...(org ? { github: { org } } : {}),
      worktreeCopy: { include: ['.env', '.env.*', '.claude/settings.local.json'] },
      repos: entries,
    }
    write(join(pack, 'ROUTING.md'), routingDoc(company, entries))
    write(join(pack, 'archive', '.gitkeep'), '')
    write(join(pack, 'pack.json'), JSON.stringify(packJson, null, 2) + '\n')
    writeFileSync(configPath, JSON.stringify({
      $comment: '이 컴퓨터 설정 — pack: 회사 팩 폴더 · reposRoot: 담당 레포 클론이 있는 폴더. 회사 값은 팩에 있다',
      ...(current ?? {}),
      pack: packRel,
      reposRoot: current?.reposRoot ?? reposRoot,
      // reposRoot 바로 아래가 아닌 레포(폴더로 묶여 있거나 이름이 겹쳐 바꾼 것)는 이 컴퓨터의 위치를 적는다 — setup.sh 가 repos/<이름> 링크에 쓴다
      ...(repoPaths(current, repos) ? { repoPaths: repoPaths(current, repos) } : {}),
    }, null, 2) + '\n')
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { recursive: true, force: true })
    throw new Error(`팩을 만들다 실패해 되돌렸다 — ${error.message}`)
  }
  return { pack, entries }
}

// 템플릿 채우기 — {{key}}
const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '')
const writeIfMissing = (path, text, made) => {
  if (existsSync(path)) return
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, text)
  made.push(path)
}

// 서비스 = 화면·API 단위 — 단일 레포는 레포 하나, 모노레포는 앱마다. 발행 패키지(kind packages)는 화면이 없어 뺀다
const servicesOf = (config) => config.repos.flatMap((repo) => {
  if (repo.kind === 'packages') return []
  if (repo.kind === 'monorepo') {
    return Object.entries(repo.apps ?? {}).map(([app, spec]) => ({ name: app, repo: repo.name, path: `${repo.name}/${spec.dir ?? `apps/${app}`}`, branch: spec.branch ?? repo.branch, agent: spec.agent ?? '' }))
  }
  return [{ name: repo.name, repo: repo.name, path: repo.name, branch: repo.branch, agent: (repo.agents ?? []).join(', ') }]
})

// 팩 단위 문서 — 서비스 소개(docs/services.md) · 다이어그램 서비스 표(diagrams/SERVICES.md) · 다이어그램 목록 카드(diagrams/index.json).
// 표의 사실(스택·브랜치)은 /sync 뒤 build-derived 가 채우고, 소개는 /setup 이 레포 코드를 읽어 채운다(모르면 "확인 필요")
const packDocs = (config, packDir, made) => {
  const company = config.name ?? basename(packDir)
  const services = servicesOf(config)
  const packages = config.repos.filter((repo) => repo.kind === 'packages').map((repo) => repo.name)
  writeIfMissing(join(packDir, 'docs', 'services.md'), [
    `# ${company} 서비스`,
    '',
    '> 담당 레포·앱 한 장 요약. "스택" 표는 `node scripts/build-derived.mjs` 가 지문(/sync)으로 채운다 — 손으로 고치지 않는다.',
    '> "서비스 소개" 는 /setup 이 레포 코드(운영 기준 ref)를 읽어 채운다. 확인 안 된 것은 "확인 필요".',
    '',
    '## 스택 (자동)',
    '',
    '<!-- BEGIN:generated:stack-table -->',
    '(아직 지문 없음 — node scripts/sync-fingerprint.mjs → --accept → node scripts/build-derived.mjs)',
    '<!-- END:generated:stack-table -->',
    '',
    '## 서비스 소개',
    '',
    '| 서비스 | 레포 · 경로 | 기준 ref | 무엇을 하나 | 주요 화면 · API | 담당 에이전트 |',
    '|---|---|---|---|---|---|',
    ...services.map((service) => `| ${service.name} | ${service.path} | \`${service.branch ?? '?'}\` | 확인 필요 | 확인 필요 | ${service.agent || '확인 필요'} |`),
    ...(packages.length ? ['', `발행 패키지(${packages.join(', ')})는 화면이 없어 표에서 뺐다 — 소비 레포 쪽에 적는다.`] : []),
    '',
  ].join('\n'), made)
  writeIfMissing(join(packDir, 'diagrams', 'SERVICES.md'), [
    '# 다이어그램 서비스 표',
    '',
    '/diagram 이 읽는다(서비스 · 레포 · 기준 ref · 가이드 · 심층 폴더). 기준 ref 의 정본은 pack.json — 다르면 pack.json 을 따르고 이 표를 고친다.',
    '묶음 순서는 위에서부터(한 번에 작업자 5개). 가이드(`docs/diagrams/guides/<서비스>.md`)는 처음 그릴 때 작업자가 만든다(형식 `docs/diagrams/AUTHORING.md` 10절).',
    '',
    '| 서비스 | 레포 | 기준 ref | 가이드 | 심층 폴더 |',
    '|---|---|---|---|---|',
    ...services.map((service) => `| ${service.name} | ${service.path} | \`${service.branch ?? '?'}\` | \`docs/diagrams/guides/${service.name}.md\` (아직 없음) | — |`),
    ...(packages.length ? ['', `발행 패키지(${packages.join(', ')})는 화면이 없어 뒤로 미룬다(docs/diagrams/README.md).`] : []),
    '',
  ].join('\n'), made)
  writeIfMissing(join(packDir, 'diagrams', 'index.json'), `${JSON.stringify({
    $comment: '다이어그램 목록(docs/diagrams/index.html) 카드 — node scripts/build-diagram-index.mjs 가 읽는다. 그린 장이 있는 서비스만 카드가 보인다',
    groups: [{ title: '서비스', items: services.map((service) => ({ base: service.name, name: service.name, sub: service.path, desc: '' })) }],
  }, null, 2)}\n`, made)
}

// pack.json 의 레포마다 뼈대 — 있는 파일은 그대로(덮지 않는다)
export const scaffold = ({ athenaRoot, packDir, config, only = [] }) => {
  const templates = join(athenaRoot, 'docs/templates/pack')
  const read = (name) => readFileSync(join(templates, name), 'utf8')
  const today = new Date().toISOString().slice(0, 10)
  const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'AskUserQuestion', ...(config.agentTools ?? [])].join(', ')
  const made = []
  for (const repo of config.repos) {
    if (only.length && !only.includes(repo.name)) continue
    const targets = repo.kind === 'monorepo'
      ? [
          ...Object.entries(repo.apps ?? {}).map(([app, spec]) => ({ agent: spec.agent, knowledge: `${repo.name}/${app}`, repoPath: `${repo.name}/apps/${app}`, branch: spec.branch, prBase: spec.prBase, verifyCmd: `${repo.name}.sh ${app}`, appScope: `의 apps/${app}` })),
          ...(repo.packagesAgent ? [{ agent: repo.packagesAgent, knowledge: `${repo.name}/packages`, repoPath: `${repo.name}/packages`, branch: repo.branch, prBase: repo.prBase ?? '', verifyCmd: `${repo.name}.sh <앱>`, appScope: '의 packages/*' }] : []),
        ]
      : (repo.agents ?? []).map((agent) => ({ agent, knowledge: repo.name, repoPath: repo.name, branch: repo.branch, prBase: repo.prBase, verifyCmd: `${repo.name}.sh`, appScope: '' }))
    for (const target of targets) {
      const values = {
        ...target, repo: repo.name, today, tools,
        repoLabel: target.repoPath,
        knowledgeLabel: target.knowledge,
        stackLine: [repo.layer === 'be' ? '백엔드' : '프론트엔드', repo.lang === 'python' ? 'Python' : 'Node'].join(' · '),
        roleWord: repo.layer === 'be' ? '백엔드' : '프론트엔드',
      }
      writeIfMissing(join(packDir, 'agents', `${target.agent}.md`), fill(read('agent.md'), values), made)
      writeIfMissing(join(packDir, 'knowledge', target.knowledge, 'rules.md'), fill(read('rules.md'), values), made)
      writeIfMissing(join(packDir, 'knowledge', target.knowledge, 'structure.md'), fill(read('structure.md'), values), made)
      writeIfMissing(join(packDir, 'knowledge', target.knowledge, 'gotchas.md'), fill(read('gotchas.md'), values), made)
    }
    const verify = join(packDir, 'verify', `${repo.name}.sh`)
    const before = made.length
    writeIfMissing(verify, fill(read('verify.sh'), { repo: repo.name, appUsage: repo.kind === 'monorepo' ? ' <앱>' : '' }), made)
    if (made.length > before) execFileSync('chmod', ['+x', verify])
  }
  packDocs(config, packDir, made)
  return made
}
