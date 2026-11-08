// ── 서버 등록 팝업(main 쪽) — 팩 창 ─────────────────────────────
// 화면 ui/server-add.tsx 가 고른 것(기존 Host 별칭 · 새로 입력한 주소 · 사용자 · 포트 · 키 · 별칭)을 받아:
//   sshKeys        ~/.ssh 안 키 파일 이름 목록(짝 .pub 가 있는 것) — 파일 내용은 읽지 않는다
//   serverHostDetail 기존 Host 를 골랐을 때 칸에 채울 값(ssh -G — 주소 · 사용자 · 포트 · 키) · 고칠 수 있는지(Include · Match · 여러 별칭이면 읽기 전용)
//                  값은 화면 팝업으로만 간다(로그 · 팩에는 별칭만)
//   sshKeyBrowse   다른 곳의 키 파일 고르기(경로만)
//   serverRegister [등록] 한 번 — 검사(칸 · 코어 server add --check) → 접속 1번(BatchMode · 원격 `true` · 10초) → ~/.ssh/config 에 쓰기(새 입력만) → 코어 server add --tested
//                  실패한 단계에서 멈추고 그 단계 · 이유만 돌려준다. 진행 단계는 server:register-step 으로 화면에
//   sshTrustHostKey 접속이 처음 보는 호스트 키로 멈췄을 때 보인 지문 그대로 known_hosts 에 덧붙이기(lib/known-hosts.mts) — 화면은 이어서 [등록] 을 다시 부른다
//   sshKeyUpload   공개 키가 서버에 없을 때 — 앱 pane 에서 ssh-copy-id(비밀번호는 사람이 그 pane 에 직접 · 성공하면 pane 이 닫힌다 · 화면이 pane 끝남을 보고 다시 [등록])
// config 는 팩 쪽 검사와 접속이 모두 통과한 뒤에만 쓴다 — 실패하면 ~/.ssh/config 는 그대로
// 기존 Host 를 고쳤으면 그 Host 블록을 그 자리에서 다시 쓴다(쓰기 전 ~/.ssh/config 백업 · 바꾼 키만 · 안 고쳤으면 쓰지 않는다)
// ssh 오류 원문은 화면에 넘기지 않는다(주소 · 사용자 이름이 섞일 수 있다) — 이유 이름만(src/lib/server-status.mts failReason)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { BrowserWindow, Dialog } from 'electron'
import * as sshConfig from '../lib/ssh-config.mts'
import * as serverModel from '../lib/server-status.mts'
import * as knownHosts from '../lib/known-hosts.mts'
import type { HostEntry, HostInput } from '../lib/ssh-config.mts'

export type SshKey = { path: string; kind: string }
// 기존 Host 는 별칭(+ 고쳤으면 칸 값 — 별칭은 그 Host 이름으로 고정) · 새로 입력은 칸 값 그대로(검사는 여기서)
export type RegisterSource = { kind: 'host'; alias: string; input?: HostInput } | { kind: 'new'; input: HostInput }
// 칸에 채울 값 · 읽기 전용 이유(override — 다른 블록 · Include 의 값이 먼저 적용돼 이 블록을 고쳐도 바뀌지 않는다)
export type HostLockReason = sshConfig.HostLock | 'override'
export type HostDetail = { ok: true; values: HostInput; lock: HostLockReason | null } | { ok: false; error: 'usage' | 'unknown' }
export type RegisterStep = 'check' | 'connect' | 'save'
type CoreReply = { ok: boolean; text?: string; already?: boolean; server?: { name: string; host: string } }
export type SshSetupCtx = {
  win: BrowserWindow | null
  serverHosts?: () => Promise<unknown>
  serverCheck?: (alias: string) => Promise<CoreReply>
  addServer?: (alias: string, options?: { tested?: boolean }) => Promise<unknown>
  openSshPane?: (label: string, text: string) => Promise<{ pane?: string; error?: string }>
  sshKeys?: () => Promise<SshKey[]>
  sshKeyBrowse?: () => Promise<string | null>
  serverHostDetail?: (alias: string) => Promise<unknown>
  serverRegister?: (source: RegisterSource) => Promise<unknown>
  sshTrustHostKey?: (source: RegisterSource, fingerprints: string[]) => Promise<unknown>
  sshKeyUpload?: (source: RegisterSource) => Promise<unknown>
}

const TEST_TIMEOUT = 25000
// 지문을 보인 뒤 이 시간 안에만 [믿고 계속] — 지나면 [등록] 부터 다시(키를 다시 받는다)
const HOST_KEY_FOR = 5 * 60 * 1000
const KEY_KIND = /(ed25519|ecdsa|rsa|dsa)/
const today = () => new Date().toISOString().slice(0, 10)
// pane 셸에 넣을 글자 — 작은따옴표로 감싼다(키 경로는 checkHost 가 따옴표 · 끝 \ 를 막는다)
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

// entry — 새로 입력(config 끝에 블록을 더한다) · edit — 기존 Host 를 고침(base 글을 text 로 바꾼다 · entry 는 고친 칸 값)
type Edit = { base: string; text: string }
type Target = { alias: string; entry: HostEntry | null; edit: Edit | null }
type Resolved = ({ ok: true } & Target) | { ok: false; step: 'check'; problems?: Partial<Record<sshConfig.HostField, sshConfig.HostProblem>>; lock?: HostLockReason }
type GValues = { hostname: string; user: string; port: string; identityfile: string[] }
const G_KEYS = ['hostname', 'user', 'port', 'identityfile'] as const

// 시스템 ssh 설정 — 기본 ssh 는 사용자 config 다음에 이 파일을 읽는데 -F 로 임시 config 를 주면 건너뛴다(그래서 사본을 임시 config 끝에 Include 로 붙인다)
const SYSTEM_CONFIG = '/etc/ssh/ssh_config'
// ssh_config(5) Include 줄(키워드는 대소문자 무관 · `Include=…` 도) · ssh 의 Include 깊이 한도
const INCLUDE_LINE = /^(\s*)include(?:\s*=\s*|\s+)(.*)$/i
const INCLUDE_DEPTH = 16

// home · bins · systemConfig 는 시험이 격리 폴더 · 가짜 명령 · 가짜 시스템 설정을 넣을 때만(앱은 기본값)
export function installSshSetup(ctx: SshSetupCtx, { dialog, sshBin = 'ssh', home, bins = {}, systemConfig = SYSTEM_CONFIG }: { dialog: Dialog; sshBin?: string; home?: string; bins?: knownHosts.Bins; systemConfig?: string }): void {
  const sshDir = () => path.join(home ?? os.homedir(), '.ssh')
  const configFile = () => path.join(sshDir(), 'config')
  const readConfig = () => fs.promises.readFile(configFile(), 'utf8').catch(() => '')
  const tilde = (file: string) => (file.startsWith(`${os.homedir()}/`) ? `~/${file.slice(os.homedir().length + 1)}` : file)
  const expand = (file: string) => (file.startsWith('~/') ? path.join(home ?? os.homedir(), file.slice(2)) : file)
  // ssh 가 실제로 쓸 키 — 푼 IdentityFile 중 파일이 있는 첫 것(없는 파일은 ssh 도 건너뛴다 · 칸 채우기와 바뀜 확인이 같은 규칙)
  const usedKey = (files: string[]) => files.find((file) => fs.existsSync(expand(file))) ?? ''
  // 시스템 설정 사본을 임시 폴더에 쓴다 — 사용자 config(-F 파일)에서 Include 하면 ssh 가 상대 경로를 ~/.ssh 기준으로 풀어 버린다.
  // 그래서 Include 의 상대 경로는 시스템 폴더 기준(ssh 가 시스템 설정을 읽을 때처럼)으로 풀고, 가리킨 파일도 같은 규칙으로 사본을 만들어 그 사본을 가리킨다.
  // 글 · 순서는 그대로(Include 줄만 바뀐다) · 와일드카드는 ssh 처럼 이름 순 · 맞는 파일이 없으면 그 줄은 주석으로
  const copySystemConfig = (dir: string): string | null => {
    const base = path.dirname(systemConfig)
    let count = 0
    const copy = (file: string, depth: number): string | null => {
      if (depth > INCLUDE_DEPTH) return null
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
      const lines = text.split('\n').map((line) => {
        const found = line.match(INCLUDE_LINE)
        if (!found) return line
        // 인자는 ssh 와 같은 따옴표 · \ 규칙으로 나눈다(공백 든 경로) — 닫히지 않은 따옴표면 그 줄 그대로(ssh 도 오류로 본다)
        const words = sshConfig.configArgs(found[2] ?? '')
        if (!words) return line
        const targets = words.flatMap((pattern) => {
          const resolved = pattern.startsWith('~/') || path.isAbsolute(pattern) ? expand(pattern) : path.join(base, pattern)
          const matches = /[*?[]/.test(resolved) ? fs.globSync(resolved).sort() : [resolved]
          return matches.map((match) => copy(match, depth + 1)).filter((copied): copied is string => Boolean(copied))
        })
        // 사본 경로는 임시 폴더 안이라 " 가 없다 — 큰따옴표로 감싼다(임시 폴더 경로에 공백이 있어도)
        return targets.length ? `${found[1] ?? ''}Include ${targets.map((target) => `"${target}"`).join(' ')}` : `${found[1] ?? ''}# ${line.trim()}`
      })
      const target = path.join(dir, `system-${count++}`)
      fs.writeFileSync(target, lines.join('\n'), { mode: 0o600 })
      return target
    }
    return copy(systemConfig, 0)
  }
  // 임시 config 에 쓸 글 — 사용자 config 다음에 시스템 설정(사본)을 기본 ssh 와 같은 순서로(먼저 정한 값이 이긴다 · 앞 블록 조건에 묶이지 않게 Match all 뒤에)
  const sshView = (text: string, dir: string) => {
    const copied = copySystemConfig(dir)
    if (!copied) return text
    const body = text && !text.endsWith('\n') ? `${text}\n` : text
    return `${body}\n# athena-studio temp: system config after user config, like plain ssh\nMatch all\nInclude "${copied}"\n`
  }
  // 이미 쓰는 별칭 — 이 config 의 Host + 코어가 Include 까지 따라간 목록
  const takenAliases = async (): Promise<string[]> => {
    const listed = (ctx.serverHosts ? await ctx.serverHosts() : null) as { ok?: boolean; hosts?: { host: string }[] } | null
    const fromCore = listed && listed.ok && Array.isArray(listed.hosts) ? listed.hosts.map((item) => item.host) : []
    return [...sshConfig.configAliases(await readConfig()), ...fromCore]
  }
  // 칸 검사 — 새 입력은 checkHost + 키 파일이 있는지 · 기존 Host 는 별칭 모양 + 이 컴퓨터 config 에 있는지
  const resolve = async (source: RegisterSource): Promise<Resolved> => {
    if (source.kind === 'host') {
      const taken = await takenAliases()
      const known = taken.some((alias) => alias.toLowerCase() === source.alias.toLowerCase())
      if (!serverModel.SSH_ALIAS.test(source.alias) || !known) return { ok: false, step: 'check', problems: { alias: 'bad' } }
      if (!source.input) return { ok: true, alias: source.alias, entry: null, edit: null }
      return resolveEdit(source.alias, source.input, taken)
    }
    const result = sshConfig.checkHost(source.input, await takenAliases())
    if (!result.ok) return { ok: false, step: 'check', problems: result.problems }
    if (!fs.existsSync(expand(result.entry.key))) return { ok: false, step: 'check', problems: { key: 'missing' } }
    return { ok: true, alias: result.entry.alias, entry: result.entry, edit: null }
  }
  // 기존 Host 를 고친 칸 — 지금 값(ssh -G)과 같으면 그대로 등록(쓰지 않음) · 다르면 블록을 다시 쓴 글을 만든다(아직 파일에는 쓰지 않는다)
  const resolveEdit = async (alias: string, input: HostInput, taken: string[]): Promise<Resolved> => {
    const current = await readConfig()
    const before = await withTempConfig(current, (file) => hostValues(file, alias))
    if (!before) return { ok: false, step: 'check', problems: { alias: 'bad' } }
    const filled = filledInput(alias, before)
    const asked = { ...input, alias }
    const changed = (['host', 'user', 'port', 'key'] as const).filter((name) => asked[name].trim() !== filled[name])
    if (!changed.length) return { ok: true, alias, entry: null, edit: null }
    const result = sshConfig.checkHost(asked, taken.filter((name) => name.toLowerCase() !== alias.toLowerCase()))
    if (!result.ok) return { ok: false, step: 'check', problems: result.problems }
    if (!fs.existsSync(expand(result.entry.key))) return { ok: false, step: 'check', problems: { key: 'missing' } }
    const span = sshConfig.hostSpan(current, alias)
    if (!span.ok) return { ok: false, step: 'check', lock: span.lock }
    const names = { host: 'HostName', user: 'User', port: 'Port', key: 'IdentityFile' } as const
    const changes: sshConfig.HostChanges = {}
    for (const name of changed) changes[names[name]] = name === 'port' ? String(result.entry.port) : result.entry[name]
    const text = sshConfig.rewriteHostBlock(current, span, changes)
    // 다시 쓴 글로 ssh 가 정말 그 값을 쓰는지 본다 — 앞선 Host * · Include 가 먼저 정하면 이 블록을 고쳐도 소용없다
    const after = await withTempConfig(text, (file) => hostValues(file, alias))
    const applied = after && after.hostname === result.entry.host && after.user === result.entry.user && after.port === String(result.entry.port) && usedKey(after.identityfile) === result.entry.key
    if (!applied) return { ok: false, step: 'check', lock: 'override' }
    return { ok: true, alias, entry: result.entry, edit: { base: current, text } }
  }
  const sourceValue = (resolved: Target) => JSON.stringify(resolved.edit ? { alias: resolved.alias, text: resolved.edit.text } : (resolved.entry ?? { alias: resolved.alias }))
  const sendStep = (step: RegisterStep) => {
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('server:register-step', step)
  }
  // 보인 호스트 키(이 창에서만) — [믿고 계속] 은 같은 대상 · 같은 지문일 때만 이 줄을 쓴다(화면이 보낸 키 글자는 받지 않는다)
  let shownKey: { value: string; at: number; pending: knownHosts.HostKeyPending } | null = null

  // 임시 폴더(700)에 config(600 · 시스템 설정 사본 Include 포함)를 쓴다 — 쓰기 전에 ssh 가 볼 모습을 미리 시험한다
  async function tempConfig(text: string): Promise<{ dir: string; file: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'athena-ssh-'))
    const file = path.join(dir, 'config')
    await fs.promises.writeFile(file, sshView(text, dir), { mode: 0o600 })
    return { dir, file }
  }
  // 임시 config 로 무언가 하고 지운다
  async function withTempConfig<T>(text: string, work: (file: string) => Promise<T>): Promise<T> {
    const { dir, file } = await tempConfig(text)
    try {
      return await work(file)
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }
  // ssh -G 가 푼 값(주소 · 사용자 · 포트 · 키 목록) — 설정이 없는 별칭이어도 ssh 는 기본값으로 답한다
  function hostValues(file: string, alias: string): Promise<GValues | null> {
    return new Promise((done) => {
      execFile(sshBin, ['-F', file, '-G', '--', alias], { timeout: 10000 }, (error, stdout) => {
        if (error) return done(null)
        const values: GValues = { hostname: '', user: '', port: '', identityfile: [] }
        for (const line of String(stdout).split('\n')) {
          const space = line.indexOf(' ')
          const key = line.slice(0, space)
          const value = line.slice(space + 1).trim()
          if (key === 'identityfile') values.identityfile.push(value)
          else if ((G_KEYS as readonly string[]).includes(key) && key !== 'identityfile') values[key as 'hostname' | 'user' | 'port'] = value
        }
        done(values)
      })
    })
  }
  // 칸에 채울 모습 — 키는 ssh 가 쓸 키 중 파일이 있는 첫 것(없으면 빈 칸 · 사람이 고른다)
  const filledInput = (alias: string, values: GValues): HostInput => ({
    alias,
    host: values.hostname,
    user: values.user,
    port: values.port,
    key: usedKey(values.identityfile),
  })

  // 접속 1번 — 새 입력은 지금 config 끝에 블록을 붙인 모습, 고친 기존 Host 는 다시 쓴 모습, 그대로면 지금 config 를 임시 파일(600)로
  const connect = async (resolved: Target) => {
    const current = await readConfig()
    let text = current
    if (resolved.edit) text = resolved.edit.text
    else if (resolved.entry) text = sshConfig.appendedText(current, sshConfig.hostBlock(resolved.entry, today()))
    return withTempConfig(text, async (file) => {
      const run = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((done) => {
        execFile(sshBin, ['-F', file, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', resolved.alias, 'true'], { timeout: TEST_TIMEOUT }, (error, _stdout, stderr) => {
          const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
          done({ code: failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0, stderr: String(stderr || ''), timedOut: Boolean(failure && failure.killed) })
        })
      })
      const reason = run.code === 0 ? null : serverModel.failReason(run.stderr, run.timedOut)
      if (reason !== 'host-key') return { reason }
      // 같은 임시 config 로 ssh 가 볼 이름 · known_hosts 를 읽는다 — 처음 보는 키면 지문을 보이고, 이미 다른 키가 있으면 경고만
      const lookup = await knownHosts.lookupHostKey(file, resolved.alias, { sshBin, ...bins })
      if (lookup.state === 'changed') return { reason: 'host-key-changed' as const }
      if (lookup.state !== 'unknown') return { reason }
      shownKey = { value: sourceValue(resolved), at: Date.now(), pending: lookup.pending }
      return { reason, hostKey: { keys: lookup.pending.keys.map((key) => ({ type: knownHosts.keyLabel(key.type), sha256: key.sha256 })) } }
    })
  }
  // 고친 Host 블록 쓰기 — 읽은 뒤 config 가 바뀌었으면 쓰지 않는다 · 쓰기 전 같은 폴더에 백업(600) · 파일 권한은 그대로
  const writeEdit = async (edit: Edit): Promise<boolean> => {
    if ((await readConfig()) !== edit.base) return false
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const backup = path.join(sshDir(), `config.athena-studio-${stamp}.bak`)
    await fs.promises.copyFile(configFile(), backup, fs.constants.COPYFILE_EXCL)
    await fs.promises.chmod(backup, 0o600)
    await fs.promises.writeFile(configFile(), edit.text)
    return true
  }

  ctx.sshKeys = async () => {
    const names = await fs.promises.readdir(sshDir()).catch(() => [] as string[])
    const keys = names.filter((name) => !name.endsWith('.pub') && names.includes(`${name}.pub`))
    keys.sort((left, right) => Number(right.startsWith('id_')) - Number(left.startsWith('id_')) || left.localeCompare(right))
    return keys.map((name) => ({ path: `~/.ssh/${name}`, kind: (name.match(KEY_KIND) ?? [])[1] ?? '' }))
  }
  ctx.sshKeyBrowse = async () => {
    const options = { defaultPath: sshDir(), properties: ['openFile', 'showHiddenFiles'] as Array<'openFile' | 'showHiddenFiles'> }
    const picked = ctx.win ? await dialog.showOpenDialog(ctx.win, options) : await dialog.showOpenDialog(options)
    const file = picked.canceled ? null : picked.filePaths[0]
    if (!file) return null
    // 공개 키(.pub)를 골랐으면 짝 개인 키 경로로 — IdentityFile 은 개인 키를 가리킨다(내용은 읽지 않는다)
    const privateFile = file.endsWith('.pub') && fs.existsSync(file.slice(0, -4)) ? file.slice(0, -4) : file
    return tilde(privateFile)
  }
  ctx.serverHostDetail = async (alias: string): Promise<HostDetail> => {
    if (!serverModel.SSH_ALIAS.test(alias)) return { ok: false, error: 'usage' }
    if (!(await takenAliases()).some((name) => name.toLowerCase() === alias.toLowerCase())) return { ok: false, error: 'unknown' }
    const current = await readConfig()
    const values = await withTempConfig(current, (file) => hostValues(file, alias))
    if (!values) return { ok: false, error: 'unknown' }
    const span = sshConfig.hostSpan(current, alias)
    return { ok: true, values: filledInput(alias, values), lock: span.ok ? null : span.lock }
  }
  ctx.serverRegister = async (source: RegisterSource) => {
    shownKey = null
    sendStep('check')
    const resolved = await resolve(source)
    if (!resolved.ok) return resolved
    // 팩 쪽 검사(이름 규칙 · 이름 · 에이전트 충돌 · 같은 별칭 이미 등록) — 통과해야 접속 · config 쓰기로 간다
    const checked = ctx.serverCheck ? await ctx.serverCheck(resolved.alias) : { ok: false, text: '' }
    if (!checked.ok) return { ok: false, step: 'check', text: checked.text || '' }
    if (checked.already) return { ok: true, already: true, server: checked.server }
    sendStep('connect')
    const tried = await connect(resolved)
    if (tried.reason) return { ok: false, step: 'connect', reason: tried.reason, ...(tried.hostKey ? { hostKey: tried.hostKey } : {}) }
    sendStep('save')
    if (resolved.edit) {
      if (!(await writeEdit(resolved.edit))) return { ok: false, step: 'save', error: 'config-changed' }
    } else if (resolved.entry) {
      const written = sshConfig.writeHostBlock(sshDir(), resolved.entry, today())
      if (!written.ok) return { ok: false, step: 'check', problems: { alias: 'taken' } }
    }
    // D1 — 방금 접속을 확인했으니 코어는 접속 시험을 건너뛴다(ssh -G 로 설정이 있는지는 본다)
    const added = (ctx.addServer ? await ctx.addServer(resolved.alias, { tested: true }) : { ok: false }) as CoreReply
    if (!added.ok) return { ok: false, step: 'save', text: added.text || '', written: Boolean(resolved.entry || resolved.edit) }
    return added
  }
  ctx.sshTrustHostKey = async (source: RegisterSource, fingerprints: string[]) => {
    const resolved = await resolve(source)
    if (!resolved.ok) return resolved
    const shown = shownKey
    shownKey = null
    if (!shown || shown.value !== sourceValue(resolved) || Date.now() - shown.at > HOST_KEY_FOR) return { ok: false, error: 'untested' }
    // 화면이 보고 있던 지문이 main 이 받은 키와 하나라도 다르면 쓰지 않는다
    if (JSON.stringify(fingerprints) !== JSON.stringify(shown.pending.keys.map((key) => key.sha256))) return { ok: false, error: 'mismatch' }
    return knownHosts.trustHostKey(shown.pending, bins)
  }
  // 기존 Host 가 쓸 키 — ssh -G 가 푼 IdentityFile 중 짝 .pub 가 있는 첫 것(없으면 ssh-copy-id 기본값에 맡긴다 · 내용은 읽지 않는다)
  const hostPublicKey = async (alias: string): Promise<string | null> => {
    const values = await withTempConfig(await readConfig(), (file) => hostValues(file, alias))
    if (!values) return null
    return values.identityfile.map((file) => `${expand(file)}.pub`).find((file) => fs.existsSync(file)) ?? null
  }
  ctx.sshKeyUpload = async (source: RegisterSource) => {
    const resolved = await resolve(source)
    if (!resolved.ok) return resolved
    if (!ctx.openSshPane) return { ok: false, error: 'usage' }
    // 성공하면 셸을 닫는다 — pane 이 끝난 알림으로 화면이 다시 [등록]. 실패하면 오류가 보이게 pane 을 남긴다
    if (!resolved.entry) {
      const publicKey = await hostPublicKey(resolved.alias)
      const command = `ssh-copy-id ${publicKey ? `-i ${shellQuote(publicKey)} ` : ''}${resolved.alias}`
      const opened = await ctx.openSshPane(`ssh-key-${resolved.alias}`, `${command} && exit`)
      return opened.pane ? { ok: true, pane: opened.pane } : { ok: false, error: opened.error || 'pane' }
    }
    // 새 입력 · 고친 Host — 아직 config 에 쓰지 않은 모습(붙인 블록 · 다시 쓴 블록)을 임시 config 로 주고 별칭으로 올린다.
    // 그래야 접속 확인과 같은 ProxyJump · ProxyCommand 등을 탄다. 임시 폴더는 pane 의 sh 가 끝날 때(닫혀도) 지운다
    const publicKey = `${expand(resolved.entry.key)}.pub`
    if (!fs.existsSync(publicKey)) return { ok: false, error: 'no-public-key' }
    const current = await readConfig()
    const text = resolved.edit ? resolved.edit.text : sshConfig.appendedText(current, sshConfig.hostBlock(resolved.entry, today()))
    const { dir, file } = await tempConfig(text)
    const script = path.join(dir, 'upload.sh')
    const lines = [
      `trap "rm -rf ${shellQuote(dir)}" EXIT HUP INT TERM`, // dir 은 mkdtemp 가 만든 경로라 " · $ · ` 가 없다
      `ssh-copy-id -F ${shellQuote(file)} -i ${shellQuote(publicKey)} ${resolved.alias}`,
      '',
    ]
    await fs.promises.writeFile(script, lines.join('\n'), { mode: 0o600 })
    const opened = await ctx.openSshPane(`ssh-key-${resolved.alias}`, `sh ${shellQuote(script)} && exit`)
    if (opened.pane) return { ok: true, pane: opened.pane }
    await fs.promises.rm(dir, { recursive: true, force: true })
    return { ok: false, error: opened.error || 'pane' }
  }
}
