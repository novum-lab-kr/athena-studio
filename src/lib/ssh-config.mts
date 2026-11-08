// 서버 추가 팝업 — 입력 검사 · ~/.ssh/config 에 더할 Host 블록 · 덧붙여 쓰기(순수 로직 + 파일 쓰기 · Electron 없이 시험)
// 비밀번호 · 키 내용은 받지 않는다 — 키는 경로만. 칸마다 허용 글자를 좁혀 config 줄 주입(공백 · 줄바꿈 · # · % · 따옴표)을 막는다.
// 기존 config 는 끝에 덧붙이기만 한다(덮어쓰지 않는다). ~/.ssh · config 가 없으면 700 · 600 으로 만든다
import fs from 'node:fs'
import path from 'node:path'

export type HostInput = { alias: string; user: string; host: string; port: string; key: string }
export type HostEntry = { alias: string; user: string; host: string; port: number; key: string }
export type HostField = keyof HostInput
// empty — 비었음 · bad — 쓸 수 없는 글자 · taken — 이미 있는 별칭 · range — 포트 1~65535 밖 · path — 키는 ~/ 나 / 로 시작 · missing — 키 파일이 없음(main 이 본다)
export type HostProblem = 'empty' | 'bad' | 'taken' | 'range' | 'path' | 'missing'
export type HostCheck = { ok: true; entry: HostEntry } | { ok: false; problems: Partial<Record<HostField, HostProblem>> }

// 코어 servers.mjs ALIAS 와 같은 모양 — 팩에 이 별칭이 그대로 들어간다
const ALIAS = /^[A-Za-z0-9_][\w.-]{0,99}$/
const USER = /^[A-Za-z0-9_][\w.-]{0,63}$/
// 이름 · IPv4(글자 · 숫자 · . -) 또는 IPv6(16진수 · : · .) — - 로 시작하면 ssh 옵션으로 읽히니 막는다
const HOST = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9A-Fa-f]*:[0-9A-Fa-f:.]*)$/
// 키 경로 — 줄바꿈 · 제어 글자 · # · % (ssh 가 %u 같은 자리로 푼다) · 따옴표(" ') · 맨 끝 \ 는 안 된다. 공백은 따옴표로 감싸 적는다
// (' · 끝 \ 는 복사용 ssh-copy-id 명령의 셸 따옴표를 깬다 — 보안 검토 L1)
const KEY_BAD = /[\u0000-\u001f\u007f#%"']|\\$/

export function checkHost(input: HostInput, taken: Iterable<string>): HostCheck {
  const problems: Partial<Record<HostField, HostProblem>> = {}
  const alias = input.alias.trim()
  const user = input.user.trim()
  const host = input.host.trim()
  const portText = input.port.trim()
  const key = input.key.trim()
  // ssh 는 Host 이름을 대소문자 없이 맞춘다
  const takenSet = new Set([...taken].map((name) => name.toLowerCase()))
  if (!alias) problems.alias = 'empty'
  else if (!ALIAS.test(alias)) problems.alias = 'bad'
  else if (takenSet.has(alias.toLowerCase())) problems.alias = 'taken'
  if (!user) problems.user = 'empty'
  else if (!USER.test(user)) problems.user = 'bad'
  if (!host) problems.host = 'empty'
  else if (!HOST.test(host)) problems.host = 'bad'
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN
  if (!portText) problems.port = 'empty'
  else if (!(port >= 1 && port <= 65535)) problems.port = 'range'
  if (!key) problems.key = 'empty'
  else if (KEY_BAD.test(key) || key.length > 1024) problems.key = 'bad'
  else if (!key.startsWith('~/') && !key.startsWith('/')) problems.key = 'path'
  if (Object.keys(problems).length) return { ok: false, problems }
  return { ok: true, entry: { alias, user, host, port, key } }
}

const keyValue = (key: string) => (/\s/.test(key) ? `"${key}"` : key)

// ~/.ssh/config 끝에 더할 블록 — 첫 줄은 누가 언제 더했는지(주석)
export function hostBlock(entry: HostEntry, date: string): string {
  return [
    `# Athena Studio · ${date}`,
    `Host ${entry.alias}`,
    `  HostName ${entry.host}`,
    `  User ${entry.user}`,
    `  Port ${entry.port}`,
    `  IdentityFile ${keyValue(entry.key)}`,
    '  IdentitiesOnly yes',
    '',
  ].join('\n')
}

// 기존 글 + 블록 — 기존 글은 그대로 두고 빈 줄 하나를 사이에 둔다
export function appendedText(existing: string, block: string): string {
  if (!existing.trim()) return block
  const tail = existing.endsWith('\n') ? '' : '\n'
  return `${existing}${tail}\n${block}`
}

// config 글의 Host 별칭(* ? ! 패턴 뺌 · HostName 줄은 Host 가 아니다) — Include 는 따라가지 않는다(따라가는 목록은 코어 server hosts)
export function configAliases(text: string): string[] {
  const names = new Set<string>()
  for (const raw of text.split('\n')) {
    const match = raw.replace(/#.*/, '').trim().match(/^host(?:\s*=\s*|\s+)(.*)$/i)
    if (!match) continue
    for (const word of (match[1] ?? '').split(/\s+/)) {
      const name = word.replace(/^"|"$/g, '')
      if (name && !/[*?!]/.test(name)) names.add(name)
    }
  }
  return [...names]
}

// 덧붙여 쓰기 — ~/.ssh 가 없으면 700 으로, config 가 없으면 600 으로 새로 만든다. 있으면 끝에만 붙인다(권한은 건드리지 않는다).
// 쓰기 직전에 별칭을 한 번 더 본다(확인과 쓰기 사이에 다른 곳이 같은 Host 를 더했으면 막는다)
export type WriteResult = { ok: true; created: boolean } | { ok: false; error: 'taken' }
export function writeHostBlock(sshDir: string, entry: HostEntry, date: string): WriteResult {
  const file = path.join(sshDir, 'config')
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  let existing = ''
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const block = hostBlock(entry, date)
    // wx — 그 사이 누가 만들었으면 덮지 않고 실패(아래에서 덧붙이기로 다시)
    try {
      fs.writeFileSync(file, block, { flag: 'wx', mode: 0o600 })
      return { ok: true, created: true }
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== 'EEXIST') throw inner
      existing = fs.readFileSync(file, 'utf8')
    }
  }
  if (configAliases(existing).some((name) => name.toLowerCase() === entry.alias.toLowerCase())) return { ok: false, error: 'taken' }
  const next = appendedText(existing, hostBlock(entry, date))
  fs.appendFileSync(file, next.slice(existing.length))
  return { ok: true, created: false }
}
