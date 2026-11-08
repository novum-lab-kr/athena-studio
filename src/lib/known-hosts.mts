// 서버 추가 팝업의 호스트 키 믿기 — 처음 보는 서버의 키를 받아 지문(SHA256)을 보이고, 사람이 [이 서버 믿기] 를 누르면 known_hosts 에 덧붙인다.
// 지키는 것(2026-11-08 사용자 결정 · 아테나 보안 지시):
//   - 어디에 무엇을 쓸지는 ssh 가 정한 대로 — `ssh -G` 의 hostname · port · userknownhostsfile · globalknownhostsfile · hashknownhosts
//   - 이미 그 이름의 키가 known_hosts 에 있으면(키가 바뀜) 믿기를 내지 않는다 — 덮어쓰거나 지우지 않는다
//   - 쓰는 것은 받은 그 줄 그대로(main 이 기억) · 덧붙이기만 · 새 파일은 600 · 22 가 아니면 [host]:port
//   - HashKnownHosts yes 면 ssh-keygen -H 로 해시해 쓴다(ssh 가 직접 더할 때와 같은 |1| 꼴 — 2026-11-08 OpenSSH 10.2 로 돌려 확인)
//   - StrictHostKeyChecking=no · accept-new 는 쓰지 않는다. 외부 명령은 execFile 인자 배열 · 이름 앞 --
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

export type ScannedKey = { type: string; line: string; sha256: string }
export type SshView = { hostname: string; port: number; userFiles: string[]; globalFiles: string[]; hash: boolean; hostKeyAlias: string | null; proxied: boolean }
export type HostKeyPending = { name: string; file: string; hash: boolean; keys: ScannedKey[]; others: string[] }
export type HostKeyLookup = { state: 'unknown'; pending: HostKeyPending } | { state: 'changed' } | { state: 'failed' }
export type Bins = { sshBin?: string; keyscanBin?: string; keygenBin?: string }
type Run = { code: number; stdout: string }

// 받는 키 종류 — ssh-keyscan 이 내는 것 중 known_hosts 에 쓰는 것만
const KEY_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'])
// ssh -G 가 푼 HostName — 팝업 칸 검사(ssh-config.mts HOST)와 같은 글자만. 맨 앞 - 는 안 된다
const HOSTNAME = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9A-Fa-f]*:[0-9A-Fa-f:.]*)$/
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/
const RUN_TIMEOUT = 15000

function run(bin: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: RUN_TIMEOUT, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null
      resolve({ code: failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0, stdout: String(stdout || '') })
    })
  })
}

// `ssh -G` 출력에서 필요한 칸만. 파일 목록은 ssh 가 이미 ~ 를 풀어 둔다(2026-11-08 확인)
export function parseSshG(text: string): SshView | null {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^(\S+) (.*)$/)
    if (match?.[1] && match[2] !== undefined && !values.has(match[1])) values.set(match[1], match[2].trim())
  }
  const hostname = values.get('hostname') ?? ''
  const port = Number(values.get('port'))
  if (!HOSTNAME.test(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const files = (key: string) => (values.get(key) ?? '').split(/\s+/).filter((file) => file && file !== 'none')
  // ProxyJump · ProxyCommand — 설정이 없거나 none 이면 ssh -G 가 그 줄을 내지 않는다(2026-11-08 OpenSSH 10.2 확인)
  const proxied = ['proxyjump', 'proxycommand'].some((key) => (values.get(key) ?? 'none') !== 'none')
  return { hostname, port, userFiles: files('userknownhostsfile'), globalFiles: files('globalknownhostsfile'), hash: values.get('hashknownhosts') === 'yes', hostKeyAlias: values.get('hostkeyalias') ?? null, proxied }
}

// known_hosts · ssh-keyscan 이 쓰는 이름 — 22 가 아니면 [host]:port
export function knownName(hostname: string, port: number): string {
  return port === 22 ? hostname : `[${hostname}]:${port}`
}

// ssh-keygen -l 과 같은 지문 — SHA256 · base64 끝 = 없앰
export function fingerprint(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

// ssh-keyscan 출력 → 키 줄. 이름이 다르거나 · 모르는 종류거나 · 안의 종류 이름이 줄과 다르면 버린다. 같은 키는 한 번만
export function parseScan(text: string, name: string): ScannedKey[] {
  const keys: ScannedKey[] = []
  for (const raw of text.split('\n')) {
    const match = raw.trim().match(/^(\S+) (\S+) ([A-Za-z0-9+/]+={0,2})$/)
    if (!match?.[1] || !match[2] || !match[3] || match[1] !== name || !KEY_TYPES.has(match[2])) continue
    const blob = Buffer.from(match[3], 'base64')
    if (blob.length < 8 || blob.toString('base64') !== match[3]) continue
    const typeLength = blob.readUInt32BE(0)
    if (blob.subarray(4, 4 + typeLength).toString('latin1') !== match[2]) continue
    if (keys.some((key) => key.line.endsWith(` ${match[3]}`))) continue
    keys.push({ type: match[2], line: `${name} ${match[2]} ${match[3]}`, sha256: fingerprint(blob) })
  }
  return keys
}

// 보이는 종류 이름(ED25519 · ECDSA · RSA) — ssh 가 터미널에 보이는 꼴
export function keyLabel(type: string): string {
  if (type.includes('ed25519')) return 'ED25519'
  if (type.includes('ecdsa')) return 'ECDSA'
  return 'RSA'
}

// 그 이름이 known_hosts 파일들 중 하나에 있나 — 해시 · 패턴 줄도 ssh-keygen -F 가 ssh 와 같은 규칙으로 찾는다.
// 없는 파일은 건너뛰고, 못 읽는 파일 · 모르는 종료 코드는 null(믿기를 내지 않는다)
async function anyKnown(name: string, files: string[], keygenBin: string): Promise<boolean | null> {
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    try {
      fs.accessSync(file, fs.constants.R_OK)
    } catch {
      return null
    }
    const found = await run(keygenBin, ['-F', name, '-f', file])
    if (found.code === 0) return true
    if (found.code !== 1) return null
  }
  return false
}

// [접속 확인] 이 호스트 키로 실패했을 때 — config 파일(시험용 임시 config)의 별칭으로 ssh 가 볼 이름 · 파일을 읽고 키를 받는다
export async function lookupHostKey(config: string, alias: string, bins: Bins = {}): Promise<HostKeyLookup> {
  const { sshBin = 'ssh', keyscanBin = 'ssh-keyscan', keygenBin = 'ssh-keygen' } = bins
  if (!ALIAS.test(alias)) return { state: 'failed' }
  const shown = await run(sshBin, ['-F', config, '-G', '--', alias])
  const view = shown.code === 0 ? parseSshG(shown.stdout) : null
  // HostKeyAlias 를 쓰는 설정은 이름 규칙이 달라 앱이 쓰지 않는다(터미널 안내로).
  // 점프 서버 · ProxyCommand 를 거치는 설정도 — keyscan 은 hostname 에 직접 붙어 다른 기계의 키를 받을 수 있다
  const file = view?.userFiles[0]
  if (!view || view.hostKeyAlias || view.proxied || !file) return { state: 'failed' }
  const name = knownName(view.hostname, view.port)
  const known = await anyKnown(name, [...view.userFiles, ...view.globalFiles], keygenBin)
  if (known === null) return { state: 'failed' }
  if (known) return { state: 'changed' }
  const scanned = await run(keyscanBin, ['-p', String(view.port), '-T', '10', '--', view.hostname])
  const keys = parseScan(scanned.stdout, name)
  if (!keys.length) return { state: 'failed' }
  return { state: 'unknown', pending: { name, file, hash: view.hash, keys, others: [...view.userFiles.slice(1), ...view.globalFiles] } }
}

// 해시해 쓸 줄 — 임시 파일(600)에 두고 ssh-keygen -H(그 파일만 바꾼다 · .old 도 같은 폴더) · 줄 수가 같아야
async function hashedLines(lines: string[], keygenBin: string): Promise<string[] | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'athena-kh-'))
  const file = path.join(dir, 'known_hosts')
  try {
    await fs.promises.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 })
    if ((await run(keygenBin, ['-H', '-f', file])).code !== 0) return null
    const hashed = (await fs.promises.readFile(file, 'utf8')).split('\n').filter((line) => line.startsWith('|1|'))
    return hashed.length === lines.length ? hashed : null
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

export type TrustResult = { ok: true; created: boolean } | { ok: false; error: 'changed' | 'failed' }

// [이 서버 믿기] — 기억해 둔 줄만 쓴다. 쓰기 직전에 다시 찾아 그 사이 다른 키가 생겼으면 쓰지 않는다
export async function trustHostKey(pending: HostKeyPending, bins: Bins = {}): Promise<TrustResult> {
  const { keygenBin = 'ssh-keygen' } = bins
  const known = await anyKnown(pending.name, [pending.file, ...pending.others], keygenBin)
  if (known === null) return { ok: false, error: 'failed' }
  if (known) return { ok: false, error: 'changed' }
  const plain = pending.keys.map((key) => key.line)
  const lines = pending.hash ? await hashedLines(plain, keygenBin) : plain
  if (!lines) return { ok: false, error: 'failed' }
  const created = !fs.existsSync(pending.file)
  try {
    if (created) fs.mkdirSync(path.dirname(pending.file), { recursive: true, mode: 0o700 })
    const before = created ? '' : fs.readFileSync(pending.file, 'utf8')
    const lead = before && !before.endsWith('\n') ? '\n' : ''
    // 'a' 는 끝에만 쓴다 · mode 는 새로 만들 때만 먹는다(기존 권한 그대로)
    fs.appendFileSync(pending.file, `${lead}${lines.join('\n')}\n`, { mode: 0o600, flag: 'a' })
  } catch {
    return { ok: false, error: 'failed' }
  }
  return { ok: true, created }
}
