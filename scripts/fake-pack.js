#!/usr/bin/env node
// 개발용 가짜 팩 명령 — 아테나 본체의 `node scripts/athena.mjs pack …` 과 같은 약속(`--json` 출력 모양)으로 답한다.
// 앱을 ATHENA_STUDIO_FAKE_PACK=1 로 켜면 main 이 본체 대신 이걸 부른다(화면 · 흐름 확인용 — 파일 · 링크는 만지지 않는다).
// 상태는 임시 폴더의 JSON 한 개(athena-studio-fake-pack.json). 팩 id 가 broken 이면 바꾸기가 실패해 되돌린다.
const fs = require('fs')
const os = require('os')
const path = require('path')

const STATE_FILE = process.env.ATHENA_STUDIO_FAKE_PACK_STATE || path.join(os.tmpdir(), 'athena-studio-fake-pack.json')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {
      current: { id: 'acme', packId: 'acme', name: 'acme', generation: 1 },
      packs: [
        { id: 'acme', packId: 'acme', name: 'acme', repos: 2, updatedAt: '2026-10-15', hasWork: true, source: 'local' },
        { id: 'globex', packId: 'globex', name: 'globex', repos: 2, updatedAt: '2026-10-16', hasWork: false, source: 'git', remote: 'git@github.com:example/globex-pack.git' },
        { id: 'broken', packId: 'broken', name: 'broken(바꾸면 실패)', repos: 1, updatedAt: '2026-10-01', hasWork: false, source: 'local' },
      ],
      tokens: {},
      busy: [],
    }
  }
}

const save = (state) => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

// 팩마다 본체(contract 2) 흉내 — 가짜 본체는 ATHENA_FAKE_BODIES(없으면 임시 폴더) 아래 <id>/ 에 아테나 폴더 모양만(CLAUDE.md · 현황판 서버) 만든다.
// 처음 부른 본체(가짜 본체가 아닌 cwd)는 지금 팩의 '주 본체'로 기억한다. 현황판 포트는 ATHENA_BOARD_PORT(없으면 4701) 부터 본체마다 2씩
const BODIES_DIR = process.env.ATHENA_FAKE_BODIES || path.join(os.tmpdir(), 'athena-studio-fake-bodies')
const FAKE_BOARD = `import http from 'node:http'
const pack = JSON.parse(process.env.FAKE_PACK_JSON || '{}')
http.createServer((request, response) => {
  if (request.url.startsWith('/api/state')) { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify({ pack })) }
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end('<body style="background:#1b1c20;color:#ddd;font:14px sans-serif;padding:24px">가짜 현황판 — ' + (pack.id || '?') + '</body>')
}).listen(Number(process.env.ATHENA_BOARD_PORT), '127.0.0.1')
`
function ensureFakeBody(id) {
  const dir = path.join(BODIES_DIR, id)
  fs.mkdirSync(path.join(dir, 'scripts', 'board'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# 가짜 본체 — ${id}\n`)
  // 현황판은 /api/state 에 이 본체 팩을 답한다(스튜디오가 '다른 팩 현황판' 으로 보고 끄지 않게)
  fs.writeFileSync(path.join(dir, 'scripts', 'board', 'server.mjs'), FAKE_BOARD.replace("process.env.FAKE_PACK_JSON || '{}'", `'${JSON.stringify({ id, generation: 1 })}'`))
  return dir
}
const realDir = (dir) => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}
// 부른 본체의 팩 — 가짜 본체 폴더면 그 id, 아니면 상태의 지금 팩(주 본체)
function callerPack(state) {
  const cwd = realDir(process.cwd())
  for (const [id, body] of Object.entries(state.bodies || {})) {
    if (realDir(body) !== cwd) continue
    if (state.current && id === state.current.id) return state.current
    const pack = state.packs.find((item) => item.id === id)
    return pack ? { ...pack, generation: 1 } : state.current // 가짜 본체 현황판도 세대 1 로 답한다
  }
  return state.current
}
function bodyPort(state, id) {
  const base = Number(process.env.ATHENA_BOARD_PORT) || 4701
  const order = Object.keys(state.bodies || {})
  const index = order.indexOf(id)
  return base + 2 * Math.max(0, index)
}
const json = process.argv.includes('--json')
const progress = (step, text) => json && console.log(`progress: ${step} ${text}`)
// 파이프(앱)로 받을 때 process.exit 를 바로 부르면 마지막 줄이 잘린다 — 다 쓴 뒤에 끝낸다
function done(result, code = 0) {
  const text = `${json ? JSON.stringify(result) : result.message || JSON.stringify(result)}\n`
  process.stdout.write(text, () => process.exit(code))
  return new Promise(() => {}) // 끝날 때까지 다음 줄로 가지 않게
}
const FINISHED = Symbol('끝')
const fail = (error, message, extra = {}) => {
  done({ ok: false, error, message, ...extra }, 1)
  throw FINISHED // 부른 쪽이 이어서 돌지 않게(stdout 을 다 쓰면 끝난다)
}
// 이름 · 이미지 검사는 코어(athena/scripts/lib/pack-look.mjs)와 같은 코드 — 규칙 · 오류 코드 · 순서가 어긋나지 않게 가져다 쓴다(2026-10 5c91d3).
// 코어가 던지는 PackError(code · message)를 가짜 답으로 바꾼다
const loadLook = () => import(require('url').pathToFileURL(path.join(__dirname, '..', 'athena', 'scripts', 'lib', 'pack-look.mjs')).href)
const asFail = (run) => {
  try {
    return run()
  } catch (caught) {
    if (caught && caught.code && caught.message !== undefined && caught.extra) fail(caught.code, caught.message, caught.extra)
    throw caught
  }
}
// 이미지 파일 검사 — 코어 setRepoIcon · setIcon 과 같은 순서(파일 있음 → 일반 파일 · 크기 · 형식). 형식(png · jpg · webp)을 돌려준다
const checkImageFile = (look, file) => {
  if (!file || !fs.existsSync(file)) fail('not-found', `이미지 파일이 없다: ${file}`)
  return asFail(() => look.checkImage(file))
}
const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : null
}

async function main() {
  const [command, sub, arg] = process.argv.slice(2)
  // 약속 번호 — ATHENA_FAKE_CONTRACT=1 이면 옛 코어 흉내(version 명령이 없다)
  const fakeContract = Number(process.env.ATHENA_FAKE_CONTRACT) || 3
  if (command === 'version') {
    if (fakeContract === 1) fail('usage', '모르는 명령: version')
    return done({ ok: true, core: 'fake', contract: fakeContract, dirty: false, dataFormats: [1, 1], capabilities: ['open', 'contract'], body: process.cwd(), bodyId: 'fake', deploy: null })
  }
  if (command === 'request') return fakeRequest(sub, arg)
  if (command !== 'pack') fail('usage', '사용: fake-pack.js pack <명령> · request <명령> · version')
  // 새 코어처럼 — --json 인데 약속 번호가 다르거나(있으면) pack use · new 에 없으면 거부
  const contract = process.env.ATHENA_CONTRACT || ''
  if (fakeContract !== 1 && json && ((contract && contract !== String(fakeContract)) || (!contract && ['use', 'new'].includes(sub)))) {
    fail('contract-mismatch', `약속이 다르다(${contract || '없음'}) — 이 코어는 약속 ${fakeContract}`, { contract: fakeContract })
  }
  const state = load()
  // 주 본체 = 처음 불린 본체(가짜 본체 폴더가 아니면)
  state.bodies = state.bodies || {}
  const here = realDir(process.cwd())
  if (state.current && !state.bodies[state.current.id] && !here.startsWith(realDir(BODIES_DIR))) {
    state.bodies[state.current.id] = here
    save(state)
  }
  const mine = callerPack(state)
  const findPack = (id) => state.packs.find((pack) => pack.id === id)
  switch (sub) {
    case 'list': {
      // 팩마다 본체 · 열린 본체 표시 — current 는 부른 본체의 팩
      const packs = state.packs.map((pack) => ({ ...pack, body: state.bodies[pack.id] || null, bodyState: state.bodies[pack.id] ? 'ready' : 'none' }))
      return done({ ok: true, current: mine ? { ...mine, ...(mine.id === (state.current && state.current.id) ? state.current : {}) } : null, switching: false, packs })
    }
    case 'status': {
      // 현황판 포트는 본체가 정한다(5.3) — 가짜는 ATHENA_BOARD_PORT → 4701(스튜디오 기본과 같게)
      const boardPort = Number(process.env.ATHENA_BOARD_PORT) || 4701
      // 데이터 폴더 — 가짜는 ATHENA_DATA_DIR → 임시 폴더(파일은 만들지 않는다)
      const dataDir = process.env.ATHENA_DATA_DIR || path.join(os.tmpdir(), 'athena-studio-fake-data')
      return done({ ok: true, current: mine, switching: false, boardPort: mine ? bodyPort(state, mine.id) : boardPort, dataDir, body: here })
    }
    case 'busy':
      return done({ ok: true, busy: state.busy || [] })
    // 팩 표시 이름 · 이미지 — 가짜는 상태 파일에만 적는다(이미지는 복사하지 않고 고른 파일 경로를 그대로)
    case 'set-name':
    case 'set-icon': {
      const target = findPack(flag('--id') || (state.current && state.current.id))
      if (!target) fail('not-found', '그 팩이 없어요')
      const clear = process.argv.includes('--clear')
      const sameAsCurrent = (patch) => {
        Object.assign(target, patch)
        if (state.current && state.current.id === target.id) Object.assign(state.current, patch)
        save(state)
      }
      if (sub === 'set-name') {
        const look = await loadLook()
        const name = clear ? null : asFail(() => look.normalizeName(arg))
        sameAsCurrent({ displayName: name })
        return done({ ok: true, id: target.id, displayName: name })
      }
      if (clear) {
        sameAsCurrent({ iconPath: null, iconUpdatedAt: new Date().toISOString() })
        return done({ ok: true, id: target.id, iconPath: null })
      }
      checkImageFile(await loadLook(), arg)
      const iconPath = path.resolve(arg)
      sameAsCurrent({ iconPath, iconUpdatedAt: new Date().toISOString() })
      return done({ ok: true, id: target.id, iconPath })
    }
    // 레포별 자동 머지 — 가짜는 부른 본체의 pack/pack.json 이 있을 때만 고친다(가짜 본체에는 없다 → not-found). 글자 보존은 진짜 코어만
    case 'set-auto-merge': {
      const file = path.join(process.cwd(), 'pack', 'pack.json')
      let pack
      try {
        pack = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        fail('not-found', '이 본체 팩에 pack.json 이 없어요')
      }
      const repo = (pack.repos || []).find((item) => item && item.name === arg)
      if (!repo) fail('not-found', `팩에 그런 레포가 없다: ${arg}`)
      if (repo.direct === true) fail('not-applicable', `${arg} 는 main 직접 레포라 PR 이 없다`)
      const auto = flag('--auto')
      const confirm = flag('--confirm')
      if (auto === 'on') repo.autoMerge = true
      if (auto === 'off') delete repo.autoMerge
      if (confirm === 'on') delete repo.autoMergeConfirm
      if (confirm === 'off') repo.autoMergeConfirm = false
      fs.writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`)
      return done({ ok: true, id: (mine && mine.id) || 'fake', repo: arg, autoMerge: repo.autoMerge === true, autoMergeConfirm: repo.autoMergeConfirm !== false })
    }
    // 레포 표시 이름 · 이미지 — 가짜는 부른 본체의 pack/pack.json 이 있을 때만(set-auto-merge 와 같다). 이미지는 형식만 보고 assets/repos/<레포>.<형식> 으로 복사
    case 'set-repo-name':
    case 'set-repo-icon': {
      const look = await loadLook()
      const clear = process.argv.includes('--clear')
      const value = process.argv[5] && !process.argv[5].startsWith('--') ? process.argv[5] : null // pack <명령> <레포> <값>
      // 코어와 같은 순서 — 입력 검사(레포 이름 → 표시 이름 · 이미지)를 먼저 하고, 그다음 팩 · 레포를 본다. 검사에 걸리면 파일은 아무것도 지우지 않는다
      let kind = null
      if (sub === 'set-repo-icon') {
        if (!look.REPO_NAME.test(String(arg ?? ''))) fail('not-found', `이 레포 이름으로는 아이콘 파일을 만들 수 없다(글자·숫자·_ 로 시작하고 . - 만): ${arg}`)
        if (!clear) kind = checkImageFile(look, value)
      }
      let name = null
      if (sub === 'set-repo-name') {
        if (!arg) fail('not-found', '레포 이름이 없다')
        if (!clear) name = asFail(() => look.normalizeName(value))
      }
      const file = path.join(process.cwd(), 'pack', 'pack.json')
      let pack
      try {
        pack = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        fail('not-found', '이 본체 팩에 pack.json 이 없어요')
      }
      const repo = (pack.repos || []).find((item) => item && item.name === arg)
      if (!repo) fail('not-found', `팩에 그런 레포가 없다: ${arg}`)
      const id = (mine && mine.id) || 'fake'
      if (sub === 'set-repo-name') {
        if (name) repo.displayName = name
        else delete repo.displayName
        fs.writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`)
        return done({ ok: true, id, repo: arg, displayName: name })
      }
      const assets = path.join(process.cwd(), 'pack', 'assets', 'repos')
      const dropOld = () => {
        for (const extension of ['png', 'jpg', 'webp']) fs.rmSync(path.join(assets, `${arg}.${extension}`), { force: true })
      }
      if (clear) {
        dropOld()
        delete repo.icon
        fs.writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`)
        return done({ ok: true, id, repo: arg, iconPath: null })
      }
      const bytes = fs.readFileSync(value)
      dropOld() // 검사를 모두 통과한 뒤에만 — 나쁜 이미지면 기존 아이콘이 그대로 남게
      fs.mkdirSync(assets, { recursive: true })
      fs.writeFileSync(path.join(assets, `${arg}.${kind}`), bytes)
      repo.icon = `assets/repos/${arg}.${kind}`
      fs.writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`)
      return done({ ok: true, id, repo: arg, iconPath: path.join(assets, `${arg}.${kind}`) })
    }
    case 'board-token':
      return done({ ok: false, error: 'not-found', message: '가짜 모드에는 현황판 토큰이 없어요' }, 1)
    case 'use': {
      const target = findPack(arg)
      if (!target) fail('not-found', `팩 ${arg} 이 없어요`)
      if ((state.busy || []).length) fail('busy', '작업이 남아 있어요', { busy: state.busy })
      for (const [step, text] of [['lock', '잠금'], ['check', '사전 검사'], ['stop', '현황판 끄기'], ['link', '링크 바꾸기']]) {
        progress(step, text)
        await sleep(400)
      }
      if (target.id === 'broken') {
        progress('rollback', '이전 팩으로 되돌리는 중')
        await sleep(400)
        fail('rollback', '4단계(링크)에서 일부러 실패했어요', { rolledBack: true, current: state.current })
      }
      progress('repos', '레포 연결')
      await sleep(400)
      progress('verify', '새 팩 확인')
      await sleep(300)
      state.current = { id: target.id, packId: target.packId, name: target.name, generation: (state.current ? state.current.generation : 0) + 1 }
      save(state)
      progress('done', '끝')
      return done({ ok: true, current: { id: target.id, generation: state.current.generation }, unlinkedRepos: target.id === 'globex' ? ['globex-api'] : [], boardStopped: [] })
    }
    case 'inspect':
    case 'import-athena': {
      if (!arg) fail('usage', '가져올 것을 주세요')
      progress('check', '임시 위치에서 검사')
      await sleep(800)
      if (/bad|unsafe/i.test(arg)) fail('unsafe', '밖을 가리키는 링크가 있어요')
      const base = path.basename(arg).replace(/\.git$|\.tar\.gz$/g, '').replace(/-pack.*$/, '') || 'newco'
      const name = sub === 'import-athena' ? 'acme' : base.replace(/-?other.*$/, '')
      const token = `t${Date.now()}`
      state.tokens[token] = { name }
      save(state)
      const existing = state.packs.find((pack) => pack.name === name)
      const result = { ok: true, token, pack: { packId: name, name, formatVersion: 1, repos: 3, createdAt: '2026-10-18' } }
      // 5.4 reason — 이름에 other 가 들어가면 이름만 같은 다른 팩(둘 다 둘 수 있음)
      if (existing) result.conflict = { id: existing.id, name: existing.name, repos: existing.repos, updatedAt: existing.updatedAt, hasWork: existing.hasWork, reason: /other/i.test(arg) ? 'name' : 'packId' }
      // R4 A — 폴더 · 압축 이름에 git 이 들어 있으면 .git 을 지운 척(gitRemoved)
      if (sub !== 'import-athena' && /git-folder/i.test(arg)) result.gitRemoved = true
      if (sub === 'import-athena') result.work = { plans: 12, issues: 3, archive: 4, worktrees: [{ path: '/tmp/old/.worktrees/acme-web/feature-x', branch: 'feature-x', dirty: true }] }
      return done(result)
    }
    case 'import': {
      const entry = state.tokens[arg]
      if (!entry) fail('token-expired', '토큰이 없어요')
      delete state.tokens[arg]
      const mode = ['--keep', '--replace', '--new'].find((name) => process.argv.includes(name))
      if (mode === '--keep') {
        save(state)
        return done({ ok: true })
      }
      progress('check', '등록')
      await sleep(400)
      const existing = state.packs.find((pack) => pack.name === entry.name)
      if (existing && mode === '--replace') {
        if (state.current && existing.id === state.current.id && (state.busy || []).length) fail('busy', '지금 팩을 바꾸려면 작업이 끝나야 해요', { busy: state.busy })
        existing.updatedAt = '2026-10-18'
        save(state)
        return done({ ok: true, imported: { id: existing.id, name: existing.name }, backup: `/tmp/${existing.id}-pack-backup.tar.gz` })
      }
      const id = existing ? `${entry.name}-2` : entry.name
      state.packs.push({ id, packId: entry.name, name: entry.name, repos: 3, updatedAt: '2026-10-18', hasWork: false, source: 'local' })
      save(state)
      return done({ ok: true, imported: { id, name: entry.name } })
    }
    case 'export':
    case 'backup': {
      const out = flag('--out') || os.tmpdir()
      progress('check', '파일 모으는 중')
      await sleep(600)
      const file = path.join(out, `${state.current.id}-${sub === 'backup' ? 'backup' : 'pack'}-fake.tar.gz`)
      return done({ ok: true, file, files: sub === 'backup' ? 88 : 41, bytes: sub === 'backup' ? 512000 : 210000 })
    }
    // 팩 지우기 — broken 은 워크트리가 남아 있는 척(--with-worktrees 면 지운다). 가짜는 백업 파일을 만들지 않는다 — 경로만
    case 'delete': {
      const target = findPack(arg)
      if (!target) fail('not-found', `팩 ${arg} 이 없어요`)
      if (mine && mine.id === target.id) fail('unsafe', `이 본체의 팩은 여기서 지우지 않는다`)
      if (target.id === 'broken' && !process.argv.includes('--with-worktrees')) fail('has-worktrees', '워크트리가 2개 있다', { worktrees: [{ name: 'broken-web/feature-x', dirty: 3 }, { name: 'broken-api/fix-y', dirty: 0 }] })
      progress('backup', '백업 만드는 중')
      await sleep(600)
      state.packs = state.packs.filter((pack) => pack.id !== target.id)
      delete state.bodies[target.id]
      save(state)
      return done({ ok: true, id: target.id, name: target.name, backup: path.join(os.tmpdir(), `${target.id}-before-delete-fake.tar.gz`), removedBody: true, worktrees: 0 })
    }
    // 팩 열기 — 본체가 없으면 만든다(가짜는 아테나 폴더 모양만). 이미 있으면 경로만
    case 'open': {
      const target = findPack(arg)
      if (!target) fail('not-found', `팩 ${arg} 이 없어요`)
      const created = !state.bodies[target.id]
      if (created) {
        progress('body', '본체 만들기')
        await sleep(400)
        state.bodies[target.id] = ensureFakeBody(target.id)
        save(state)
      }
      progress('done', '끝')
      return done({ ok: true, id: target.id, packId: target.packId, body: state.bodies[target.id], boardPort: bodyPort(state, target.id), contract: 2, state: 'ready', created, unlinkedRepos: target.id === 'globex' ? ['globex-api'] : [] })
    }
    // 새 팩 — 빈 자리 + 그 본체
    case 'new': {
      const previous = mine && mine.id
      const id = `new-${Date.now() % 100000}`
      state.packs.push({ id, packId: id, name: '(새 팩 — /setup 중)', repos: 0, updatedAt: new Date().toISOString(), hasWork: false, source: 'local' })
      state.bodies[id] = ensureFakeBody(id)
      save(state)
      return done({ ok: true, id, previous, body: state.bodies[id], boardPort: bodyPort(state, id), created: true, contract: 2 })
    }
    default:
      fail('usage', `모르는 명령: ${sub}`)
  }
}

// 사람에게 묻는 요청 흉내(athena/docs/requests.md 와 같은 모양) — 질문 하나 · 결정 하나로 시작. answer → answered, ack → delivered
// ATHENA_FAKE_CONTRACT=1(옛 코어)이면 request 명령이 없다
function fakeRequest(sub, id) {
  if ((Number(process.env.ATHENA_FAKE_CONTRACT) || 3) === 1) fail('usage', '모르는 명령: request')
  const state = load()
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString()
  state.requests = state.requests || [
    { format: 1, id: 'r-20261021-141520-1080', kind: 'question', title: '주문 목록 API 에 취소 사유(cancelReason) 필드가 있나요?', body: '- 응답 타입 OrderListItem 에 없어요\n- 백엔드 orders/dto.ts 에서도 못 찾았어요 — 다른 이름일 수 있어요', options: [{ label: '있다', desc: '필드 이름을 알려 주면 그대로 표시해요' }, { label: '없다', desc: '백엔드에 추가를 요청하고 이 작업은 멈춰요', recommended: true }], links: { plan: 'plans/task/20261021-ord-412.md', html: null, issue: null }, pane: null, pack: 'acme', generation: 1, dedupeKey: null, state: 'open', rev: 1, createdAt: minutesAgo(12), updatedAt: minutesAgo(12), answer: null, deliveredAt: null, closedReason: null },
    { format: 1, id: 'r-20261021-145700-2b3c', kind: 'decision', title: '쿠폰 적용 순서 바꾸기', body: '- D1 할인 계산 순서\n- D2 이미 발급한 쿠폰 처리', options: [], links: { plan: 'plans/feature/20261021-coupon-order.md', html: 'plans/feature/20261021-coupon-order.html', issue: null }, pane: null, pack: 'acme', generation: 1, dedupeKey: 'plan:plans/feature/20261021-coupon-order.md', state: 'open', rev: 1, createdAt: minutesAgo(3), updatedAt: minutesAgo(3), answer: null, deliveredAt: null, closedReason: null },
  ]
  const find = () => state.requests.find((request) => request.id === id) || fail('not-found', `그런 요청이 없다: ${id}`)
  const at = new Date().toISOString()
  switch (sub) {
    case 'list':
      save(state)
      return done({ ok: true, requests: process.argv.includes('--all') ? state.requests : state.requests.filter((request) => ['open', 'answered'].includes(request.state)) })
    case 'answer': {
      const request = find()
      if (request.state !== 'open') fail('conflict', `이미 ${request.state} 인 요청이다`)
      Object.assign(request, { state: 'answered', answer: { choice: flag('--choice'), text: flag('--text'), by: flag('--by') || 'app', at }, rev: request.rev + 1, updatedAt: at })
      save(state)
      return done({ ok: true, request })
    }
    case 'ack': {
      const request = find()
      Object.assign(request, { state: 'delivered', deliveredAt: at, rev: request.rev + 1, updatedAt: at })
      save(state)
      return done({ ok: true, request })
    }
    default:
      fail('usage', `모르는 명령: request ${sub}`)
  }
}

// 예상하지 못한 오류(상태 파일을 못 씀 등)도 약속대로 마지막 줄 JSON 으로(5.4 failed)
main().catch((error) => {
  if (error !== FINISHED) done({ ok: false, error: 'failed', message: error.message }, 1)
})
