// 새 Codex 세션이 소유한 사용자 전용 Unix 소켓만 읽는다. PTY/일반 질문 응답을 사용하지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

// 새 실행·백업 복원·본체 업데이트 뒤 재개가 같은 실행 경계를 쓰게 한다.
export function codexSessionCommand(body: string | null, command: string | undefined): string | undefined {
  if (!command || !/^codex(?: |$)/.test(command) || !body) return command
  const script = path.join(body, 'scripts/codex-session.py')
  if (!fs.existsSync(script)) return command
  const quoted = "'" + script.replace(/'/g, "'\\''") + "'"
  return `python3 ${quoted}${command.slice('codex'.length)}`
}

export type ApprovalChoice = { key: string; label?: string; description?: string; detail?: unknown }
export type CodexApproval = {
  token: string; generation: string; pane: string; body: string; method: string
  params: Record<string, unknown>; receivedAtMs?: number; item?: unknown; choices: ApprovalChoice[]
}
type Connection = { socket: string; pane: string; body: string; generation: string }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)

function connections(body: string): Connection[] {
  const folder = path.join(body, '.pack-data', 'state', 'codex-connections')
  try {
    return fs.readdirSync(folder).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap((name) => {
      try {
        const file = path.join(folder, name), stat = fs.lstatSync(file)
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 4096 || (stat.mode & 0o077)) return []
        const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!object(value) || value.body !== fs.realpathSync(body) || typeof value.pane !== 'string' || !uuid(value.generation)
          || typeof value.socket !== 'string' || !/^\/tmp\/athena-codex-[^/]+\/rpc\.sock$/.test(value.socket)) return []
        const socket = fs.lstatSync(value.socket), parent = fs.lstatSync(path.dirname(value.socket))
        if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077)
          || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) return []
        return [{ socket: value.socket, pane: value.pane, body: value.body, generation: value.generation }]
      } catch { return [] }
    })
  } catch { return [] }
}

function rpc(connection: Connection, method: 'GET' | 'POST', pathname: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const data = payload === undefined ? '' : JSON.stringify(payload)
    const request = http.request({ socketPath: connection.socket, path: pathname, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (part: string) => {
        text += part
        if (text.length > 1_000_000) { request.destroy(); resolve(null) }
      })
      response.on('error', () => resolve(null))
      response.on('end', () => { try { resolve(JSON.parse(text)) } catch { resolve(null) } })
    })
    request.setTimeout(3500, () => { request.destroy(); resolve(null) })
    request.on('error', () => resolve(null))
    request.end(data)
  })
}

export async function pendingApprovals(body: string, panes: Set<string>): Promise<CodexApproval[]> {
  const found = connections(body).filter((connection) => panes.has(connection.pane))
  const counts = new Map<string, number>()
  for (const connection of found) counts.set(connection.pane, (counts.get(connection.pane) ?? 0) + 1)
  const unique = found.filter((connection) => counts.get(connection.pane) === 1)
  const groups = await Promise.all(unique.map(async (connection) => {
    const result = await rpc(connection, 'GET', '/requests')
    if (!object(result) || result.generation !== connection.generation || !Array.isArray(result.requests)) return []
    return result.requests.filter((value): value is CodexApproval => object(value) && uuid(value.token) && value.generation === connection.generation
      && value.body === connection.body && value.pane === connection.pane && typeof value.method === 'string' && object(value.params)
      && Array.isArray(value.choices) && value.choices.length > 0 && value.choices.every((choice) => object(choice) && typeof choice.key === 'string'))
  }))
  return groups.flat()
}

export async function respondApproval(body: string, approval: CodexApproval, choice: number): Promise<boolean> {
  if (!Number.isInteger(choice) || choice < 0 || choice >= approval.choices.length) return false
  const owned = connections(body).filter((item) => item.pane === approval.pane)
  if (owned.length !== 1) return false
  const connection = owned[0]
  if (!connection || connection.generation !== approval.generation || connection.body !== approval.body) return false
  const result = await rpc(connection, 'POST', '/respond', { token: approval.token, generation: approval.generation, pane: approval.pane, body: approval.body, choice })
  return object(result) && result.ok === true
}
