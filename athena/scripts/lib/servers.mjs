// @ts-check
// 서버(SSH 호스트) 등록 — bin/athena server hosts · add · remove (docs/setup.md "서버 하나 더하기" · docs/pack.md "servers")
//   sshHosts      이 컴퓨터 ~/.ssh/config 의 Host 별칭 목록(* ? ! 가 든 패턴은 뺀다 · Include 는 ~/.ssh 기준으로 따라간다)
//   addServer     ssh -G 로 설정이 있는지 → BatchMode 로 비밀번호 없이 들어가지는지 시험 → pack.json servers[] · 에이전트 · 지식 뼈대 · ROUTING 한 줄
//   removeServer  팩 자동 백업 → pack.json 항목 · 에이전트 · 지식 · ROUTING 줄 지우기
// 팩에는 **별칭만** 적는다 — 주소 · 사용자 · 키 경로는 이 컴퓨터 ~/.ssh/config 에만 있다(팀원은 자기 설정에 같은 별칭을 둔다).
// ssh 가 낸 글(stderr)은 주소가 섞일 수 있어 결과 · 오류 문장에 넣지 않는다 — 종류(키 · 호스트 키 · 연결)로만 가른다.
// 시험용: ATHENA_SSH_BIN(가짜 ssh) · ATHENA_SSH_CONFIG(읽을 설정 파일)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { paths } from './config.mjs'
import { PackError, tarPack } from './packs.mjs'

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const ALIAS = /^[\w][\w.-]{0,99}$/
const sshBin = () => process.env.ATHENA_SSH_BIN || 'ssh'
const sshConfigFile = () => process.env.ATHENA_SSH_CONFIG || join(homedir(), '.ssh', 'config')

/** @param {string} path */
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
/** @param {string} path @param {unknown} value */
const writeJsonAtomic = (path, value) => {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}

// ── ~/.ssh/config 별칭 ─────────────────────────────────────────────
// Include 의 와일드카드는 마지막 조각(파일 이름)의 * 만 푼다 — 흔한 `Include config.d/*` 모양. 더 복잡한 패턴은 건너뛴다
/** @param {string} pattern @returns {string[]} */
const includeFiles = (pattern) => {
  const full = isAbsolute(pattern) ? pattern : join(homedir(), '.ssh', pattern.replace(/^~\//, '../'))
  if (!full.includes('*')) return [full]
  const dir = dirname(full)
  const name = basename(full)
  if (dir.includes('*')) return []
  const matcher = new RegExp(`^${name.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  try { return readdirSync(dir).filter((item) => matcher.test(item)).sort().map((item) => join(dir, item)) } catch { return [] }
}

/** @param {string} file @param {Set<string>} seen @param {Set<string>} hosts @param {number} depth */
const collectHosts = (file, seen, hosts, depth) => {
  if (depth > 5 || seen.has(file)) return
  seen.add(file)
  let text = ''
  try { if (statSync(file).isFile()) text = readFileSync(file, 'utf8') } catch { return }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const match = line.match(/^(\w+)\s*=?\s*(.*)$/)
    if (!match) continue
    const [, key = '', rest = ''] = match
    const words = rest.split(/\s+/).map((word) => word.replace(/^"|"$/g, '')).filter(Boolean)
    if (key.toLowerCase() === 'include') for (const pattern of words) for (const inner of includeFiles(pattern)) collectHosts(inner, seen, hosts, depth + 1)
    if (key.toLowerCase() !== 'host') continue
    for (const word of words) if (!/[*?!]/.test(word) && ALIAS.test(word)) hosts.add(word)
  }
}

// 이 컴퓨터의 SSH 별칭 — 앱 "서버 추가" 목록(server hosts --json). 이미 등록한 별칭은 registered 로 표시
/** @param {string} root */
export const sshHosts = (root) => {
  const hosts = new Set()
  collectHosts(sshConfigFile(), new Set(), hosts, 0)
  const registered = new Set(serversOf(root).map((server) => server.host))
  return { ok: true, hosts: [...hosts].map((host) => ({ host, registered: registered.has(host) })) }
}

// ── 팩 ────────────────────────────────────────────────────────────
/** @param {string} root */
const packDirOf = (root) => {
  const where = paths(root)
  if (where.mode !== 'packs' || !where.packDataReal) throw new PackError('not-found', '여러 팩 본체가 아니다 — 팩 데이터가 없다', { reason: 'repo-not-packs-body' })
  const packDir = join(where.packDataReal, 'pack')
  const pack = readJson(join(packDir, 'pack.json'))
  if (!pack) throw new PackError('not-found', '지금 팩에 pack.json 이 없다 — /setup 을 먼저 끝낸다', { reason: 'repo-pack-not-set-up' })
  return { where, packDir, pack }
}
/** @param {string} root @returns {{ name: string, host: string, agents?: string[] }[]} */
const serversOf = (root) => {
  try { return packDirOf(root).pack.servers ?? [] } catch { return [] }
}

// ssh 가 이 별칭을 아는가 — ssh -G 는 설정이 없어도 0 으로 끝나니(hostname = 별칭 그대로) config 의 Host 목록에 있거나 hostname 이 바뀐 것만 안다고 본다.
// hostname 값 자체는 어디에도 내보내지 않는다
/** @param {string} alias */
const sshKnows = (alias) => {
  const hosts = new Set()
  collectHosts(sshConfigFile(), new Set(), hosts, 0)
  const run = spawnSync(sshBin(), ['-G', '--', alias], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (run.status !== 0) return false
  const hostname = (run.stdout.match(/^hostname\s+(\S+)/m) ?? [])[1] ?? ''
  return hosts.has(alias) || (hostname !== '' && hostname.toLowerCase() !== alias.toLowerCase())
}

// 비밀번호 없이 들어가지는지 — BatchMode(묻는 창이 없다) · 10초. 실패 종류만 돌려준다. 원격 명령 `true` 는 서버 허용 목록(server_allow.py) 안이다
/** @param {string} alias @returns {'ok' | 'server-key-needed' | 'server-host-key' | 'server-unreachable'} */
const tryLogin = (alias) => {
  const run = spawnSync(sshBin(), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', alias, 'true'], { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'ignore', 'pipe'] })
  if (run.status === 0) return 'ok'
  const said = run.stderr ?? ''
  if (/Permission denied|publickey|password/i.test(said)) return 'server-key-needed'
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(said)) return 'server-host-key'
  return 'server-unreachable'
}

const FAIL_TEXT = {
  'server-key-needed': '비밀번호 없이 들어가지지 않는다 — 이 컴퓨터의 공개 키를 서버에 등록한 뒤 다시(ssh-copy-id <별칭>)',
  'server-host-key': '서버 호스트 키를 아직 믿지 않았다 — 터미널에서 ssh <별칭> 으로 한 번 들어가 지문을 확인한 뒤 다시',
  'server-unreachable': '서버에 닿지 않는다 — 네트워크 · ~/.ssh/config 의 그 Host 설정을 확인한 뒤 다시',
}

// ROUTING.md "서버" 절 — 없으면 끝에 만든다. 줄은 그 절 안에서만 `| <이름> | ssh 별칭 ...` 로 찾아 넣고 뺀다
// (서버 이름이 레포 이름과 같아도 레포 표의 줄은 건드리지 않는다)
const ROUTING_HEAD = '## 서버'
/** @param {string} name @param {string} host @param {string} agent */
const routingRow = (name, host, agent) => `| \`${name}\` | \`${host}\` | \`${agent}\` | 확인 필요 — 등록 뒤 분석이 채운다 |`
// 서버 절의 [머리, 끝) — 끝은 다음 "## " 줄(없으면 문서 끝). 절이 없으면 null
/** @param {string[]} lines @returns {[number, number] | null} */
const serverSection = (lines) => {
  const head = lines.findIndex((line) => line.trim() === ROUTING_HEAD)
  if (head < 0) return null
  const next = lines.findIndex((line, index) => index > head && line.startsWith('## '))
  return [head, next < 0 ? lines.length : next]
}
/** @param {string} packDir @param {string} name @param {string | null} row */
const editRouting = (packDir, name, row) => {
  const file = join(packDir, 'ROUTING.md')
  if (!existsSync(file)) return false
  const lines = readFileSync(file, 'utf8').split('\n')
  const found = serverSection(lines)
  const kept = found ? [...lines.slice(0, found[0]), ...lines.slice(found[0], found[1]).filter((line) => !line.startsWith(`| \`${name}\` |`)), ...lines.slice(found[1])] : [...lines]
  if (row) {
    if (!serverSection(kept)) {
      while (kept.length && kept[kept.length - 1] === '') kept.pop()
      kept.push('', ROUTING_HEAD, '', '서버 담당 에이전트는 `scripts/ssh-run.sh <서버>` 로만 접속한다(docs/setup.md "서버 하나 더하기"). 접속 정보는 각자 `~/.ssh/config` — 팩에는 별칭만.', '', '| 서버 | ssh 별칭 | 에이전트 | 무엇이 도나 |', '|---|---|---|---|', '')
    }
    const [head, end] = serverSection(kept) ?? [kept.length, kept.length]
    // 그 절 표의 마지막 줄 뒤에 — 표가 없으면 머리 바로 뒤
    let at = head + 1
    for (let index = head + 1; index < end; index += 1) if ((kept[index] ?? '').startsWith('|')) at = index + 1
    kept.splice(at, 0, row)
  }
  const next = kept.join('\n')
  if (next === lines.join('\n')) return false
  writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`)
  return true
}

/** @param {string} template @param {Record<string, string>} values */
const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '')
/** @param {string} path @param {string} text @param {string[]} made */
const writeIfMissing = (path, text, made) => {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  made.push(path)
}

// 서버 뼈대 — 에이전트 · 지식(rules · structure · gotchas). 있는 파일은 그대로
/** @param {string} athenaRoot @param {string} packDir @param {{ name: string, host: string, agent: string }} server */
const scaffoldServer = (athenaRoot, packDir, server) => {
  const templates = join(athenaRoot, 'docs/templates/pack')
  /** @param {string} file */
  const read = (file) => readFileSync(join(templates, file), 'utf8')
  const values = { name: server.name, host: server.host, agent: server.agent, today: new Date().toISOString().slice(0, 10) }
  /** @type {string[]} */
  const made = []
  writeIfMissing(join(packDir, 'agents', `${server.agent}.md`), fill(read('server-agent.md'), values), made)
  for (const file of ['rules', 'structure', 'gotchas']) writeIfMissing(join(packDir, 'knowledge', 'servers', server.name, `${file}.md`), fill(read(`server-${file}.md`), values), made)
  return made
}

// 이 팩에서 이미 쓰는 에이전트 이름 — 레포 담당 · 다른 서버
/** @param {{ repos?: Record<string, unknown>[], servers?: { name: string, agents?: string[] }[] }} pack @param {string} except */
const agentsInUse = (pack, except) => {
  const names = new Set()
  for (const repo of pack.repos ?? []) {
    for (const agent of /** @type {string[]} */ (repo.agents ?? [])) names.add(agent)
    if (typeof repo.packagesAgent === 'string') names.add(repo.packagesAgent)
    for (const app of Object.values(/** @type {Record<string, { agent?: string }>} */ (repo.apps ?? {}))) if (app?.agent) names.add(app.agent)
  }
  for (const server of pack.servers ?? []) if (server.name !== except) for (const agent of server.agents ?? []) names.add(agent)
  return names
}

/** @param {string} alias */
const nameFromAlias = (alias) => alias.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

// 서버 등록 — 접속 시험을 통과해야 pack.json 에 쓴다(실패면 팩 그대로)
/** @param {string} root @param {{ host: string, name?: string, report?: (step: string, text: string) => void }} input */
export const addServer = (root, { host, name = '', report = () => {} }) => {
  if (!host || !ALIAS.test(host)) throw new PackError('invalid-name', `ssh 별칭이 올바르지 않다: ${host || '(없음)'} — ~/.ssh/config 의 Host 이름(글자 · 숫자 · . _ -)`, { reason: 'server-bad-host' })
  const serverName = name || nameFromAlias(host)
  if (!NAME.test(serverName)) throw new PackError('invalid-name', `서버 이름이 올바르지 않다: ${serverName} — 영문 소문자 · 숫자 · -(--name)`, { reason: 'server-bad-name', reasonArgs: { name: serverName } })
  const { packDir, pack } = packDirOf(root)
  const servers = Array.isArray(pack.servers) ? pack.servers : []
  const existing = servers.find((/** @type {{ name: string }} */ server) => server.name === serverName)
  if (existing && existing.host === host) return { ok: true, already: true, server: existing, scaffolded: [], routing: false }
  if (existing) throw new PackError('exists', `같은 이름의 서버가 이미 팩에 있다: ${serverName} — 다른 이름으로(--name)`, { reason: 'server-exists', reasonArgs: { name: serverName } })
  const sameHost = servers.find((/** @type {{ host: string }} */ server) => server.host === host)
  if (sameHost) throw new PackError('exists', `그 별칭은 이미 서버 ${sameHost.name} 으로 등록돼 있다`, { reason: 'server-host-registered', reasonArgs: { name: sameHost.name } })
  const agent = `${serverName}-ops`
  if (agentsInUse(pack, serverName).has(agent)) throw new PackError('exists', `에이전트 이름 ${agent} 를 팩이 이미 쓴다 — 다른 서버 이름으로(--name)`, { reason: 'server-exists', reasonArgs: { name: serverName } })
  report('check', `ssh 설정 확인 — ${host}`)
  if (!sshKnows(host)) throw new PackError('not-found', `~/.ssh/config 에 ${host} 가 없다 — 먼저 그 Host 를 적는다`, { reason: 'server-not-configured', reasonArgs: { host } })
  report('login', `비밀번호 없이 들어가지는지 시험 — ${host}`)
  const login = tryLogin(host)
  if (login !== 'ok') throw new PackError('failed', FAIL_TEXT[login].replace('<별칭>', host), { reason: login, reasonArgs: { host } })
  // paths · repos 는 등록 뒤 분석(서버 에이전트)이 채운다 — 배포 경로 · 그 서버에 올라간 팩 레포
  const entry = { name: serverName, host, agents: [agent], paths: [], repos: [] }
  writeJsonAtomic(join(packDir, 'pack.json'), { ...pack, servers: [...servers, entry] })
  const made = scaffoldServer(root, packDir, { name: serverName, host, agent })
  const routing = editRouting(packDir, serverName, routingRow(serverName, host, agent))
  report('done', `등록했다 — ${serverName}`)
  return { ok: true, server: entry, scaffolded: made.map((path) => path.slice(packDir.length + 1)), routing }
}

// 서버 빼기 — 팩 백업 뒤 pack.json 항목 · 에이전트(다른 곳이 안 쓰면) · 지식 · ROUTING 줄. 서버 자체 · 원격 백업(~/.athena-backups)은 건드리지 않는다
/** @param {string} root @param {string} serverName @param {{ report?: (step: string, text: string) => void }} [options] */
export const removeServer = (root, serverName, { report = () => {} } = {}) => {
  const { where, packDir, pack } = packDirOf(root)
  const servers = Array.isArray(pack.servers) ? pack.servers : []
  const entry = servers.find((/** @type {{ name: string }} */ server) => server.name === serverName)
  if (!entry) throw new PackError('not-found', `팩에 그런 서버가 없다: ${serverName}`, { reason: 'server-missing', reasonArgs: { name: serverName } })
  report('backup', `팩 백업 — ${where.packId}`)
  const backup = tarPack(packDir, join(where.dataDir, 'backups'), `${where.packId}-pack-before-server-remove`)
  const others = agentsInUse({ ...pack, servers: servers.filter((/** @type {unknown} */ server) => server !== entry) }, '')
  /** @type {string[]} */
  const removed = []
  /** @param {string} rel */
  const drop = (rel) => { const path = join(packDir, rel); if (existsSync(path)) { rmSync(path, { recursive: true, force: true }); removed.push(rel) } }
  for (const agent of /** @type {string[]} */ (entry.agents ?? [])) if (/^[\w-]+$/.test(agent) && !others.has(agent)) drop(`agents/${agent}.md`)
  if (NAME.test(serverName)) drop(`knowledge/servers/${serverName}`)
  const rest = servers.filter((/** @type {unknown} */ server) => server !== entry)
  const { servers: _gone, ...without } = pack
  writeJsonAtomic(join(packDir, 'pack.json'), rest.length ? { ...pack, servers: rest } : without)
  const routing = editRouting(packDir, serverName, null)
  report('done', `뺐다 — ${serverName}`)
  return { ok: true, removed: serverName, backup, files: removed, routing }
}
