// pane [상세] 토큰 — Claude Code 대화 기록(~/.claude/projects/<폴더>/<세션>.jsonl)의 assistant 줄 message.usage 를 더한다.
// 모델을 부르지 않고 파일만 읽는다. 3초마다 다시 물어도 파일마다 읽은 자리(바이트)를 기억해 늘어난 부분만 읽는다.
// 한 답(message.id)은 내용 조각(thinking · text · tool_use)마다 줄이 나뉘어 같은 usage 로 여러 번 적힌다(2026-10-27 실제 기록 확인) — id 마다 한 번만 센다
const fs = require('node:fs')
const path = require('node:path')

const HEAD_LINES = 40
const CHUNK_BYTES = 8 * 1024 * 1024
const SCAN_MS = 15000

// ── 기록 한 파일 따라 읽기 ─────────────────────────────────────────────
const newTally = () => ({ offset: 0, ids: new Map(), loose: { io: 0, cache: 0 } })

// 줄 하나 → 그 답의 { id, io, cache } | null
function usageOf(line) {
  if (!line.includes('"usage"')) return null
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  const message = record && record.type === 'assistant' ? record.message : null
  const usage = message && message.usage
  if (!usage || typeof usage !== 'object') return null
  const count = (key) => (Number.isFinite(usage[key]) ? usage[key] : 0)
  return {
    id: typeof message.id === 'string' && message.id ? message.id : null,
    io: count('input_tokens') + count('output_tokens'),
    cache: count('cache_creation_input_tokens') + count('cache_read_input_tokens'),
  }
}

// 끝까지 적힌 줄들(마지막 줄바꿈까지)을 더한다 — 같은 id 는 마지막 줄 값 하나로
function feedLines(tally, text) {
  for (const line of text.split('\n')) {
    const answer = usageOf(line)
    if (!answer) continue
    if (answer.id) tally.ids.set(answer.id, { io: answer.io, cache: answer.cache })
    else {
      tally.loose.io += answer.io
      tally.loose.cache += answer.cache
    }
  }
}

function totalsOf(tally) {
  const sum = { io: tally.loose.io, cache: tally.loose.cache }
  for (const answer of tally.ids.values()) {
    sum.io += answer.io
    sum.cache += answer.cache
  }
  return sum
}

// 지난번 자리부터 늘어난 부분만 — 마지막 줄바꿈까지만 먹고(쓰다 만 줄은 다음에), 파일이 줄었으면(새로 씀) 처음부터
async function readGrowth(file, tally) {
  const stat = await fs.promises.stat(file)
  if (stat.size < tally.offset) Object.assign(tally, newTally())
  if (stat.size === tally.offset) return tally
  const handle = await fs.promises.open(file, 'r')
  try {
    // 줄바꿈 바이트(0x0A)는 여러 바이트 글자 안에 나오지 않아 여기서 잘라도 글자가 깨지지 않는다.
    // 한 조각에 줄바꿈이 없으면(이미지가 든 아주 긴 줄) 다음 조각과 이어 붙인다
    let position = tally.offset
    let pending = Buffer.alloc(0)
    while (position < stat.size) {
      const length = Math.min(CHUNK_BYTES, stat.size - position)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (!bytesRead) break
      position += bytesRead
      const data = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      const end = data.lastIndexOf(0x0a)
      if (end < 0) {
        pending = data
        continue
      }
      feedLines(tally, data.toString('utf8', 0, end))
      tally.offset += end + 1
      pending = data.subarray(end + 1)
    }
  } finally {
    await handle.close()
  }
  return tally
}

// ── 계획서 → 대화 기록(코어 scripts/learn-review.mjs findTranscripts 와 같은 규칙) ──────────────
// delegate.sh 가 띄운 세션은 첫 지시 맨 앞이 "이 작업의 계획서: <본체>/<계획서> —" 또는 "리뷰할 계획서: <본체>/<계획서> —"
const stripNoise = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<local-command-[\s\S]*?<\/local-command-[a-z]+>/g, '').trim()

function userText(line) {
  if (!line.includes('"type":"user"')) return ''
  try {
    const record = JSON.parse(line)
    if (record.type !== 'user') return ''
    const content = record.message && record.message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('\n')
  } catch {
    // 깨진 줄은 건너뛴다
  }
  return ''
}

// 앞 40줄 안의 첫 사용자 글(잡음 뺀 것). 없으면 ''
async function firstUserText(file) {
  const handle = await fs.promises.open(file, 'r')
  try {
    let text = ''
    let position = 0
    let seen = 0
    let rest = Buffer.alloc(0)
    while (seen < HEAD_LINES) {
      const buffer = Buffer.alloc(1024 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      const data = Buffer.concat([rest, buffer.subarray(0, bytesRead)])
      let start = 0
      for (let end = data.indexOf(0x0a); end >= 0 && seen < HEAD_LINES; end = data.indexOf(0x0a, start)) {
        seen += 1
        const found = userText(data.toString('utf8', start, end))
        start = end + 1
        if (found) {
          text = found
          seen = HEAD_LINES
        }
      }
      rest = data.subarray(start)
    }
    return stripNoise(text)
  } finally {
    await handle.close()
  }
}

const planHeaders = (bodyDirs, planId) => [...new Set(bodyDirs.filter(Boolean))].flatMap((dir) => {
  const full = path.join(dir, planId)
  return [`이 작업의 계획서: ${full} —`, `리뷰할 계획서: ${full} —`]
})

// ── 보기 좋은 숫자 — 42k · 3.1M ──────────────────────────────────────
function formatTokens(count) {
  const value = Math.max(0, Math.round(Number(count) || 0))
  if (value < 1000) return String(value)
  if (value < 1e6) return `${trimZero((value / 1000).toFixed(value < 10000 ? 1 : 0))}k`
  if (value < 1e9) return `${trimZero((value / 1e6).toFixed(value < 1e7 ? 1 : 0))}M`
  return `${trimZero((value / 1e9).toFixed(1))}B`
}
const trimZero = (text) => text.replace(/\.0$/, '')

// ── 묶음 — 기록 폴더 목록 · 파일 머리 · 파일별 합계를 기억한다 ───────────────────
// peekPlan · peekSession 은 기다리지 않는다: 아는 값을 바로 돌려주고(처음엔 null) 뒤에서 새로 읽는다
function createTokenUsage({ projectsDir, scanMs = SCAN_MS, now = Date.now } = {}) {
  const tallies = new Map() // 파일 → 따라 읽는 상태
  const heads = new Map() // 파일 → { mtimeMs, text }
  const known = new Map() // 물음 열쇠 → 값({ io, cache } | null)
  const running = new Set()
  let files = []
  let scannedAt = -Infinity

  // 프로젝트 폴더 바로 아래 <세션>.jsonl 만(서브에이전트 기록은 findTranscripts 처럼 넣지 않는다) · scanMs 마다 한 번
  async function listFiles() {
    if (now() - scannedAt < scanMs) return files
    const next = []
    const dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const entries = await fs.promises.readdir(path.join(projectsDir, dir.name), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.jsonl')) next.push(path.join(projectsDir, dir.name, entry.name))
    }
    files = next
    scannedAt = now()
    return files
  }

  // 첫 사용자 글은 한 번 적히면 바뀌지 않는다 — 찾았으면 계속 쓰고, 못 찾았으면 파일이 바뀔 때 다시 본다
  async function headOf(file) {
    const cached = heads.get(file)
    if (cached && cached.text) return cached.text
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat) return ''
    if (cached && cached.mtimeMs === stat.mtimeMs) return ''
    const text = await firstUserText(file).catch(() => '')
    heads.set(file, { mtimeMs: stat.mtimeMs, text })
    return text
  }

  async function sumFiles(list) {
    if (!list.length) return null
    const sum = { io: 0, cache: 0 }
    let read = 0
    for (const file of list) {
      const tally = tallies.get(file) || newTally()
      tallies.set(file, tally)
      try {
        await readGrowth(file, tally)
      } catch {
        continue
      }
      read += 1
      const part = totalsOf(tally)
      sum.io += part.io
      sum.cache += part.cache
    }
    return read ? sum : null
  }

  async function planUsage(bodyDirs, planId) {
    const headers = planHeaders(bodyDirs, planId)
    const matched = []
    for (const file of await listFiles()) {
      const head = await headOf(file)
      if (head && headers.some((header) => head.startsWith(header))) matched.push(file)
    }
    return sumFiles(matched)
  }

  async function sessionUsage(sessionId) {
    const name = `${sessionId}.jsonl`
    let list = (await listFiles()).filter((file) => path.basename(file) === name)
    // 방금 시작한 세션은 목록이 오래됐을 수 있다 — 한 번 더 훑는다
    if (!list.length) {
      scannedAt = -Infinity
      list = (await listFiles()).filter((file) => path.basename(file) === name)
    }
    return sumFiles(list)
  }

  function peek(key, compute) {
    if (!running.has(key)) {
      running.add(key)
      compute()
        .then((value) => known.set(key, value), () => {})
        .finally(() => running.delete(key))
    }
    return known.has(key) ? known.get(key) : null
  }

  return {
    // 열쇠에 본체까지 — 다른 팩에 같은 상대 경로 계획서가 있어도 값 · 실행이 섞이지 않게
    peekPlan: (bodyDirs, planId) => {
      if (!planId) return null
      const dirs = [...new Set((bodyDirs || []).filter(Boolean).map((dir) => path.resolve(dir)))].sort()
      return peek(`plan:${dirs.join('\n')}\n${planId}`, () => planUsage(dirs, planId))
    },
    peekSession: (sessionId) => (/^[0-9a-fA-F-]{8,64}$/.test(String(sessionId || '')) ? peek(`session:${sessionId}`, () => sessionUsage(sessionId)) : null),
    planUsage,
    sessionUsage,
  }
}

module.exports = { usageOf, newTally, feedLines, totalsOf, readGrowth, firstUserText, planHeaders, formatTokens, createTokenUsage }
