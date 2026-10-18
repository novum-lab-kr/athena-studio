#!/usr/bin/env node
// 개발용 가짜 팩 명령 — 아테나 본체의 `node scripts/athena.mjs pack …` 과 같은 약속(계획서 5절)으로 답한다.
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
const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : null
}

async function main() {
  const [command, sub, arg] = process.argv.slice(2)
  if (command !== 'pack') fail('usage', '사용: fake-pack.js pack <명령>')
  const state = load()
  const findPack = (id) => state.packs.find((pack) => pack.id === id)
  switch (sub) {
    case 'list':
      return done({ ok: true, current: state.current, switching: false, packs: state.packs })
    case 'status': {
      // 현황판 포트는 본체가 정한다(5.3) — 가짜는 ATHENA_BOARD_PORT → 4701(스튜디오 기본과 같게)
      const boardPort = Number(process.env.ATHENA_BOARD_PORT) || 4701
      // 데이터 폴더(R1) — 가짜는 ATHENA_DATA_DIR → 임시 폴더(파일은 만들지 않는다)
      const dataDir = process.env.ATHENA_DATA_DIR || path.join(os.tmpdir(), 'athena-studio-fake-data')
      return done({ ok: true, current: state.current, switching: false, boardPort, dataDir })
    }
    case 'busy':
      return done({ ok: true, busy: state.busy || [] })
    // 팩 표시 이름 · 이미지(아테나 계획서 20261018-팩마다-본체 5.7) — 가짜는 상태 파일에만 적는다(이미지는 복사하지 않고 고른 파일 경로를 그대로)
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
        const name = clear ? null : String(arg || '').trim()
        if (!clear && (name.length < 1 || name.length > 40)) fail('invalid-name', '이름은 1~40자')
        sameAsCurrent({ displayName: name })
        return done({ ok: true, id: target.id, displayName: name })
      }
      if (clear) {
        sameAsCurrent({ iconPath: null, iconUpdatedAt: new Date().toISOString() })
        return done({ ok: true, id: target.id, iconPath: null })
      }
      let bytes
      try {
        bytes = fs.readFileSync(arg)
      } catch {
        fail('invalid-image', '이미지 파일을 읽지 못했어요')
      }
      const head = bytes.subarray(0, 12)
      const isPng = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const isJpeg = head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      const isWebp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP'
      if (!isPng && !isJpeg && !isWebp) fail('invalid-image', 'png · jpeg · webp 만')
      if (bytes.length > 1024 * 1024) fail('image-too-large', '1MB 이하만')
      const iconPath = path.resolve(arg)
      sameAsCurrent({ iconPath, iconUpdatedAt: new Date().toISOString() })
      return done({ ok: true, id: target.id, iconPath })
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
    case 'new': {
      if ((state.busy || []).length) fail('busy', '작업이 남아 있어요', { busy: state.busy })
      const previous = state.current && state.current.id
      const id = `new-${Date.now() % 100000}`
      state.current = { id, packId: id, name: '(새 팩 — /setup 중)', generation: (state.current ? state.current.generation : 0) + 1 }
      save(state)
      return done({ ok: true, id, previous })
    }
    default:
      fail('usage', `모르는 명령: ${sub}`)
  }
}

// 예상하지 못한 오류(상태 파일을 못 씀 등)도 약속대로 마지막 줄 JSON 으로(5.4 failed)
main().catch((error) => {
  if (error !== FINISHED) done({ ok: false, error: 'failed', message: error.message }, 1)
})
