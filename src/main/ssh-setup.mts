// ── 서버 추가 팝업(main 쪽) — 팩 창 ─────────────────────────────
// 화면 ui/server-add.tsx 의 칸(별칭 · 사용자 · 호스트 · 포트 · 키 파일)을 받아:
//   sshKeys      ~/.ssh 안 키 파일 이름 목록(짝 .pub 가 있는 것) — 파일 내용은 읽지 않는다
//   sshKeyBrowse 다른 곳의 키 파일 고르기(경로만)
//   sshTest      쓰기 전 확인 — 지금 config + 더할 블록을 임시 파일(600)에 두고 ssh -F 로 BatchMode 접속(원격 `true` · 10초)
//   sshTrustHostKey  [접속 확인] 이 처음 보는 호스트 키로 실패했을 때 보인 지문 그대로 known_hosts 에 덧붙이기(lib/known-hosts.mts)
//   sshCreate    확인을 통과한 같은 값만 — ~/.ssh/config 끝에 덧붙이고(없으면 700 · 600 으로 만든다) 코어 server add(팩에는 별칭만)
// ssh 오류 원문은 화면에 넘기지 않는다(주소 · 사용자 이름이 섞일 수 있다) — 이유 이름만(src/lib/server-status.mts failReason)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { BrowserWindow, Dialog } from 'electron'
import * as sshConfig from '../lib/ssh-config.mts'
import * as serverModel from '../lib/server-status.mts'
import * as knownHosts from '../lib/known-hosts.mts'
import type { HostInput } from '../lib/ssh-config.mts'

export type SshKey = { path: string; kind: string }
export type SshSetupCtx = {
  win: BrowserWindow | null
  serverHosts?: () => Promise<unknown>
  addServer?: (host: string) => Promise<unknown>
  sshKeys?: () => Promise<SshKey[]>
  sshKeyBrowse?: () => Promise<string | null>
  sshTest?: (input: HostInput) => Promise<unknown>
  sshCreate?: (input: HostInput) => Promise<unknown>
  sshTrustHostKey?: (input: HostInput, fingerprints: string[]) => Promise<unknown>
}

const TEST_TIMEOUT = 25000
// 확인한 뒤 이 시간 안에만 [추가] — 오래 열어 둔 팝업은 다시 확인
const TESTED_FOR = 10 * 60 * 1000
// 지문을 보인 뒤 이 시간 안에만 [이 서버 믿기] — 지나면 [접속 확인] 부터 다시(키를 다시 받는다)
const HOST_KEY_FOR = 5 * 60 * 1000
const KEY_KIND = /(ed25519|ecdsa|rsa|dsa)/
const today = () => new Date().toISOString().slice(0, 10)

// home · bins 는 시험이 격리 폴더 · 가짜 명령을 넣을 때만(앱은 기본값)
export function installSshSetup(ctx: SshSetupCtx, { dialog, sshBin = 'ssh', home, bins = {} }: { dialog: Dialog; sshBin?: string; home?: string; bins?: knownHosts.Bins }): void {
  const sshDir = () => path.join(home ?? os.homedir(), '.ssh')
  const readConfig = () => fs.promises.readFile(path.join(sshDir(), 'config'), 'utf8').catch(() => '')
  const tilde = (file: string) => (file.startsWith(`${os.homedir()}/`) ? `~/${file.slice(os.homedir().length + 1)}` : file)
  const expand = (file: string) => (file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file)
  // 이미 쓰는 별칭 — 이 config 의 Host + 코어가 Include 까지 따라간 목록
  const takenAliases = async (): Promise<string[]> => {
    const listed = (ctx.serverHosts ? await ctx.serverHosts() : null) as { ok?: boolean; hosts?: { host: string }[] } | null
    const fromCore = listed && listed.ok && Array.isArray(listed.hosts) ? listed.hosts.map((item) => item.host) : []
    return [...sshConfig.configAliases(await readConfig()), ...fromCore]
  }
  const check = async (input: HostInput) => {
    const result = sshConfig.checkHost(input, await takenAliases())
    if (result.ok && !fs.existsSync(expand(result.entry.key))) return { ok: false as const, problems: { key: 'missing' as const } }
    return result
  }
  // 확인을 통과한 값(이 창에서만) — [추가] 는 같은 값일 때만
  let tested: { value: string; at: number } | null = null
  // 보인 호스트 키(이 창에서만) — [이 서버 믿기] 는 같은 칸 값 · 같은 지문일 때만 이 줄을 쓴다(화면이 보낸 키 글자는 받지 않는다)
  let shownKey: { value: string; at: number; pending: knownHosts.HostKeyPending } | null = null

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
  ctx.sshTest = async (input: HostInput) => {
    tested = null
    shownKey = null
    const result = await check(input)
    if (!result.ok) return result
    const block = sshConfig.hostBlock(result.entry, today())
    // 지금 config 끝에 블록을 붙인 모습 그대로 시험한다(앞쪽 Host * 설정도 같이 먹는다). 임시 파일은 600(ssh 가 넓은 권한을 거절한다)
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'athena-ssh-'))
    const file = path.join(dir, 'config')
    try {
      await fs.promises.writeFile(file, sshConfig.appendedText(await readConfig(), block), { mode: 0o600 })
      const started = Date.now()
      const run = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve) => {
        execFile(sshBin, ['-F', file, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', result.entry.alias, 'true'], { timeout: TEST_TIMEOUT }, (error, _stdout, stderr) => {
          const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
          resolve({ code: failure ? (typeof failure.code === 'number' ? failure.code : -1) : 0, stderr: String(stderr || ''), timedOut: Boolean(failure && failure.killed) })
        })
      })
      const reason = run.code === 0 ? null : serverModel.failReason(run.stderr, run.timedOut)
      if (reason === 'host-key') {
        // 같은 임시 config 로 ssh 가 볼 이름 · known_hosts 를 읽는다 — 처음 보는 키면 지문을 보이고, 이미 다른 키가 있으면 경고만
        const lookup = await knownHosts.lookupHostKey(file, result.entry.alias, { sshBin, ...bins })
        if (lookup.state === 'changed') return { ok: false, reason: 'host-key-changed', block }
        if (lookup.state === 'unknown') {
          shownKey = { value: JSON.stringify(result.entry), at: Date.now(), pending: lookup.pending }
          return { ok: false, reason, block, hostKey: { keys: lookup.pending.keys.map((key) => ({ type: knownHosts.keyLabel(key.type), sha256: key.sha256 })) } }
        }
      }
      if (reason) return { ok: false, reason, block }
      tested = { value: JSON.stringify(result.entry), at: Date.now() }
      return { ok: true, ms: Date.now() - started, block }
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  }
  ctx.sshTrustHostKey = async (input: HostInput, fingerprints: string[]) => {
    const result = await check(input)
    if (!result.ok) return result
    const shown = shownKey
    shownKey = null
    if (!shown || shown.value !== JSON.stringify(result.entry) || Date.now() - shown.at > HOST_KEY_FOR) return { ok: false, error: 'untested' }
    // 화면이 보고 있던 지문이 main 이 받은 키와 하나라도 다르면 쓰지 않는다
    if (JSON.stringify(fingerprints) !== JSON.stringify(shown.pending.keys.map((key) => key.sha256))) return { ok: false, error: 'mismatch' }
    return knownHosts.trustHostKey(shown.pending, bins)
  }
  ctx.sshCreate = async (input: HostInput) => {
    const result = await check(input)
    if (!result.ok) return result
    if (!tested || tested.value !== JSON.stringify(result.entry) || Date.now() - tested.at > TESTED_FOR) return { ok: false, error: 'untested' }
    const written = sshConfig.writeHostBlock(sshDir(), result.entry, today())
    if (!written.ok) return { ok: false, problems: { alias: 'taken' } }
    tested = null
    return ctx.addServer ? ctx.addServer(result.entry.alias) : { ok: false, error: 'usage' }
  }
}
