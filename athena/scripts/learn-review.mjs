#!/usr/bin/env node
/**
 * 학습 루프 3단계 — 배우기 전용 검토자. 작업 대화 기록을 Claude 가 따로 읽고 "다음 작업이 다시 밟을 것"을 뽑아 learn 이슈로 제안한다.
 * 학습 루프 3단계 — 배우기 전용 검토자(승인 기반 background review)
 *
 *   node scripts/learn-review.mjs --plan <plans/…md> [--head <sha>] [--dry-run] [--force]
 *        한 계획서를 검토한다. --dry-run 은 줄인 기록 크기·LLM 답·만들 이슈만 보여 주고 파일은 쓰지 않는다
 *   node scripts/learn-review.mjs --enqueue --plan <plans/…md> [--head <표시>]
 *        대기열에 넣고 배우기 검토가 뒤에서 돌고 있게 한다(현황판이 내 계획서의 PR 이 모두 머지된 걸 보면 부른다 — 표시는 merged-<PR번호들>). 바로 끝난다
 *   node scripts/learn-review.mjs --watch
 *        뒤에서 돈다 — 대기열을 차례로 꺼내 검토한다. 검토 프로세스는 하나만(작업마다 늘리지 않는다)
 *
 * 안전
 *   - 검토자 Claude 는 도구 없이(--tools "") 줄인 기록만 읽고 JSON 으로만 답한다. 파일은 이 스크립트가 쓴다
 *   - 기록은 사용자 말·에이전트 답·도구 이름과 짧은 인자·도구 오류 첫 줄만. 도구 결과 본문은 넣지 않고 비밀값 모양은 가린다
 *   - 출력·이슈에 대화 원문을 옮기지 않는다(LLM 이 쓴 규칙·근거 한 줄만)
 *   - 같은 계획서·같은 HEAD 는 한 번만(계획서 Checkpoint "- Learn review:" 줄)
 */
import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { githubOrg, loadConfig, paths, prLinkPattern } from './lib/config.mjs'
import { isDirEntry } from './lib/fs.mjs'
import { releaseLock, updatePlan } from './lib/plan-update.mjs'
import { askJev, jevEnabled, logJev } from './lib/jev.mjs'
import { maskSecrets } from './lib/mask.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 고정 경로 — 세션마다 TMPDIR 이 달라도(샌드박스·pane) 같은 대기열을 보게 한다(heavy.sh 잠금과 같은 방식).
// 체크아웃마다 따로 — 아테나를 두 곳에 받아 두면(회사별) 한 대기열을 섞어 쓰지 않게 체크아웃 경로의 해시를 이름에 붙인다
const REAL_ROOT = realpathSync(ROOT)
// 여러 팩 — 대기열은 팩마다(<팩 데이터>/state/learn-queue · 실제 경로). 이 팩의 세대가 바뀌면(팩 교체 등) 이 프로세스는 옛 설정이라 끝낸다
const BOOT_PATHS = paths(ROOT)
const PACK_KEY = BOOT_PATHS.mode === 'packs' ? `:${BOOT_PATHS.packId}` : ''
const ROOT_KEY = createHash('sha1').update(REAL_ROOT + PACK_KEY).digest('hex').slice(0, 8)
const QUEUE_DIR = process.env.ATHENA_LEARN_QUEUE || (BOOT_PATHS.mode === 'packs' ? join(BOOT_PATHS.packDataReal, 'state', 'learn-queue') : `/tmp/hermes-learn-queue-${ROOT_KEY}`)
const packChanged = () => {
  if (BOOT_PATHS.mode !== 'packs') return false
  const now = paths(ROOT)
  return now.packId !== BOOT_PATHS.packId || now.generation !== BOOT_PATHS.generation
}
// 검토 프로세스는 하나 — mkdir 잠금(안에 pid). 실패한 일은 지우지 않고 failed/ 에 남긴다(MAX_ATTEMPTS 번 다시 해 본 뒤)
const WATCHER_LOCK = join(QUEUE_DIR, '.watcher.lock')
const FAILED_DIR = join(QUEUE_DIR, 'failed')
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 60_000
const LOG_FILE = `/tmp/hermes-learn-review-${ROOT_KEY}.log`
const MAX_TRANSCRIPT_CHARS = 60_000
// 날짜는 한국 시간 — UTC 로 쓰면 아침 9시 전 작업이 어제 날짜가 된다
const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10)

const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] ?? '' : ''
}
const flag = (name) => argv.includes(`--${name}`)

// 첫 실행 전(팩을 아직 안 만듦 — athena.config.json 없음)에 검토가 시작되면 죽지 말고 기다린다.
// 설정이 생기면 같은 인자로 다시 시작한다(설정은 모듈을 읽을 때 한 번만 읽으므로)
// (여러 팩 구조의 빈 팩 자리 — pack new 직후 — 도 같다: pack.json 이 생길 때까지)
const configReady = () => { try { loadConfig(ROOT); return true } catch { return false } }
if (flag('watch') && !configReady()) {
  console.log('📚 배우기 검토 — 팩이 아직 없다. 첫 실행(/setup)이 끝나면 저절로 시작한다')
  while (!configReady()) { if (packChanged()) process.exit(0); await new Promise((done) => setTimeout(done, 10_000)) }
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

// ── 계획서 → 담당 에이전트 → knowledge 폴더 ─────────────────────────────
const config = loadConfig(ROOT)
const ORG = githubOrg(config)
const knowledgeOfAgent = new Map()
for (const repo of config.repos) {
  for (const agent of repo.agents ?? []) knowledgeOfAgent.set(agent, repo.name)
  for (const [app, spec] of Object.entries(repo.apps ?? {})) knowledgeOfAgent.set(spec.agent, `${repo.name}/${app}`)
}
// 모노레포 공통 패키지 담당 — 공책은 <레포>/packages (앱 에이전트 뒤에 둔다)
for (const repo of config.repos) if (repo.packagesAgent) knowledgeOfAgent.set(repo.packagesAgent, `${repo.name}/packages`)

const planAgents = (planText) => [...knowledgeOfAgent.keys()].filter((agent) => new RegExp(`(^|[^\\w-])${agent}([^\\w-]|$)`, 'm').test(planText))
// 아테나 자체 작업(Agent: athena 또는 Work ref 가 athena 체크아웃 — 옛 계획서는 hermes) — 경로마다 "hermes" 가 나오므로 글자 검색이 아니라 줄로 판단한다
const isLeadPlan = (planText) => /^- Agent:\s*(?:athena|hermes)\b/m.test(planText) || /^- Work ref:\s*(?:athena|hermes)\b/m.test(planText)
const planKnowledge = (planText) => [...new Set([...planAgents(planText).map((agent) => knowledgeOfAgent.get(agent)), ...(isLeadPlan(planText) ? ['athena'] : [])])]

// ── 비밀값 가리기 — scripts/lib/mask.mjs(PR 자동 리뷰와 같이 쓴다) · 이 파일을 import 하던 곳을 위해 다시 내보낸다 ─────
export { maskSecrets }

// ── 대화 기록 찾기 — delegate.sh 가 띄운 세션은 첫 지시 맨 앞이 "이 작업의 계획서: <절대경로> —" 또는 "리뷰할 계획서: <절대경로> —" ──
const projectsDir = join(homedir(), '.claude/projects')
const firstUserText = async (path) => {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  let seen = 0
  for await (const line of lines) {
    if (++seen > 40) break
    if (!line.includes('"type":"user"')) continue
    const text = userText(line)
    if (text) {
      lines.close()
      return text
    }
  }
  return ''
}
export const findTranscripts = async (planFile) => {
  const found = []
  const headers = [planFile].flatMap((path) => [`이 작업의 계획서: ${join(ROOT, path)} —`, `리뷰할 계획서: ${join(ROOT, path)} —`])
  if (!existsSync(projectsDir)) return found
  for (const dir of readdirSync(projectsDir)) {
    let files = []
    try { files = readdirSync(join(projectsDir, dir)) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(projectsDir, dir, file)
      const head = await firstUserText(path)
      // 다른 계획서를 언급만 한 세션(예: 리뷰 지시 안의 다른 계획서 경로)은 잡지 않는다
      const start = stripNoise(head)
      if (headers.some((header) => start.startsWith(header))) found.push(path)
    }
  }
  return found
}

// ── 기록 줄이기 ──────────────────────────────────────────────────────────
function userText(line) {
  try {
    const record = JSON.parse(line)
    if (record.type !== 'user') return ''
    const content = record.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')
  } catch {
    // 깨진 줄은 건너뛴다
  }
  return ''
}
const clip = (text, size) => (text.length > size ? `${text.slice(0, size)}…` : text)
// 자르기 전에 가린다 — 잘린 토큰 조각이 길이 하한에 못 미쳐 남지 않게
const safeClip = (text, size) => clip(maskSecrets(text).masked, size)
const stripNoise = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<local-command-[\s\S]*?<\/local-command-[a-z]+>/g, '').trim()

const condense = async (path) => {
  const out = []
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    const content = record.message?.content
    if (record.type === 'user') {
      if (typeof content === 'string') {
        const text = stripNoise(content)
        if (text) out.push(`👤 ${safeClip(text, 1500)}`)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text') {
            const text = stripNoise(block.text ?? '')
            if (text) out.push(`👤 ${safeClip(text, 1500)}`)
          } else if (block?.type === 'tool_result' && block.is_error) {
            // 오류는 첫 줄만 — 반복 오류를 알아보는 데 필요하다
            const raw = typeof block.content === 'string' ? block.content : (block.content ?? []).map((part) => part?.text ?? '').join(' ')
            out.push(`❌ ${safeClip(raw.split('\n').find((row) => row.trim()) ?? '', 300)}`)
          }
        }
      }
    } else if (record.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && block.text?.trim()) out.push(`🤖 ${safeClip(block.text.trim(), 1500)}`)
        else if (block?.type === 'tool_use') {
          const input = block.input ?? {}
          const brief = input.command ?? input.file_path ?? input.pattern ?? input.description ?? ''
          out.push(`🔧 ${block.name}${brief ? `: ${safeClip(String(brief), 200)}` : ''}`)
        }
      }
    }
  }
  return out.join('\n')
}

// 길면 앞(요청·계획)과 뒤(마무리·교정)를 남기고 가운데를 줄인다
const fitBudget = (text) => {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text
  const headSize = Math.floor(MAX_TRANSCRIPT_CHARS * 0.25)
  const tailSize = MAX_TRANSCRIPT_CHARS - headSize
  return `${text.slice(0, headSize)}\n…(중간 ${text.length - MAX_TRANSCRIPT_CHARS}자 생략)…\n${text.slice(-tailSize)}`
}

// ── 검토자 프롬프트·답 형식 ─────────────────────────────────────────────
const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['gotchas', 'skill'] },
          section: { type: 'string', description: '그 knowledge 파일에서 넣을 절 제목(## 제목 글자 그대로, 새 절이면 지을 이름). skill 이면 빈 문자열' },
          knowledge: { type: 'string', description: 'knowledge 폴더(예 <레포> 또는 모노레포 <레포>/<앱>). skill 이면 빈 문자열' },
          scope: { type: 'string', description: '어디에 걸리나 — 레포 어디서든 밟으면 "common", 특정 화면을 만질 때만이면 그 코드 폴더(예 app/orders · pages/auth · src/screens/tabs). 애매하면 common. skill 이면 빈 문자열' },
          skill: { type: 'string', description: 'kind 가 skill 일 때 스킬 이름(소문자·숫자·-). 아니면 빈 문자열' },
          title: { type: 'string', description: '무엇을 학습했는지 쉬운 한 줄(파일명·함수명 대신 무슨 일이 생기나로). 50자 안팎' },
          explain: { type: 'string', description: '무엇을 배웠나 — 그 작업을 모르는 사람도 알게 2~3문장. 배경부터 짧게, 용어는 풀어서. 대화·로그 문장을 그대로 붙이지 않는다' },
          rule: { type: 'string', description: '공책(gotchas)에 실제로 들어갈 한 줄 — 규칙 + 이유 한 마디. 에이전트가 읽고 바로 행동할 수 있게' },
          basis: { type: 'string', enum: ['code', 'run', 'user-said'], description: '근거 종류 — code(코드·설정·문서 파일:줄) · run(에러 메시지·요청 기록·테스트 결과) · user-said(사용자가 그렇게 말한 것뿐). 사용자 말만 있으면 반드시 user-said' },
          evidence: { type: 'string', description: '근거 — basis 가 code 면 파일:줄, run 이면 확인한 실행 결과 한 줄. 비밀값·긴 인용 금지' },
          strengthen: { type: 'string', description: '이미 있는 공책 줄을 고치는 것이면 그 줄을 공책에 적힌 그대로(앞의 "- " 와 <!-- --> 표시는 빼도 된다), 아니면 빈 문자열' },
          ifUnknown: { type: 'string', description: '왜 중요한가 — 모르면 다음 작업에서 구체적으로 무엇이 잘못되나 한 줄(쉬운 말). 구체적으로 못 쓰면 이 항목을 내지 않는다' },
          signal: { type: 'string', enum: ['correction', 'repeat-error', 'done'] },
        },
        required: ['kind', 'knowledge', 'scope', 'section', 'skill', 'title', 'explain', 'rule', 'basis', 'evidence', 'strengthen', 'ifUnknown', 'signal'],
      },
    },
  },
  required: ['items'],
}

const readIf = (path, size) => (existsSync(path) ? clip(readFileSync(path, 'utf8'), size) : '(없음)')
const openLearnIssues = () => {
  const dir = join(ROOT, 'issues')
  return readdirSync(dir)
    .filter((file) => /-learn-/.test(file) && !/-learn-curator\.md$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }))
    .filter(({ text }) => !/^status:\s*(done|wontfix)/m.test(text))
}

// ── 계획서 · 머지된 PR(바뀐 코드 · 리뷰 댓글) — 5단계: PR 이 머지된 뒤 배운다 ─────────────
const MAX_PLAN_CHARS = 6000
const MAX_DIFF_CHARS = 15000
const MAX_REVIEW_CHARS = 6000
const gh = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 60_000 })
  return result.status === 0 ? result.stdout : ''
}
// 계획서의 "- PR:" 줄에 있는 PR 들(<조직>/<레포>/pull/<번호> — 조직은 설정 github.org)
export const planPullRequests = (planText) => [...new Set([...planText.matchAll(prLinkPattern(ORG))].map((match) => `${match[1]}#${match[2]}`))]
  .map((link) => { const [repo, number] = link.split('#'); return { repo, number } })
const pullRequestMaterial = (planText) => {
  const parts = []
  for (const { repo, number } of planPullRequests(planText)) {
    const view = gh(['pr', 'view', number, '--repo', `${ORG}/${repo}`, '--json', 'title,state,baseRefName,mergedAt,body'])
    if (!view) continue
    const info = JSON.parse(view)
    if (info.state !== 'MERGED') continue   // 머지된 것만 — 버려진 시도는 배우지 않는다
    const diff = gh(['pr', 'diff', number, '--repo', `${ORG}/${repo}`])
    // 리뷰 댓글 — 사람 이름은 빼고 위치와 내용만(코드 줄 댓글 + 리뷰 본문)
    const lineComments = gh(['api', `repos/${ORG}/${repo}/pulls/${number}/comments`, '--paginate', '--jq', '.[] | "- " + .path + ":" + ((.line // .original_line) | tostring) + " — " + (.body | gsub("\\n"; " "))'])
    const reviews = gh(['api', `repos/${ORG}/${repo}/pulls/${number}/reviews`, '--paginate', '--jq', '.[] | select(.body != "") | "- (" + .state + ") " + (.body | gsub("\\n"; " "))'])
    parts.push([
      `### ${repo}#${number} → ${info.baseRefName} (머지 ${String(info.mergedAt).slice(0, 10)}) — ${info.title}`,
      `#### 리뷰 댓글\n${clip(`${reviews}${lineComments}`.trim() || '(없음)', MAX_REVIEW_CHARS)}`,
      `#### 바뀐 코드(diff, 길면 앞부분)\n${clip(diff.trim() || '(없음)', MAX_DIFF_CHARS)}`,
    ].join('\n'))
  }
  return parts.join('\n\n')
}

const buildPrompt = (planFile, knowledgeDirs, transcript, planText = '', prMaterial = '') => {
  // 기준은 정본 한 곳 — 에이전트와 같은 문서를 읽는다
  const criteria = readFileSync(join(ROOT, 'docs/knowledge/common/learning.md'), 'utf8')
  const screenNotes = (dir) => {
    const splitDir = join(ROOT, 'docs/knowledge', dir, 'gotchas')
    return existsSync(splitDir) ? readdirSync(splitDir).filter((file) => file.endsWith('.md')).map((file) => `\n### ${dir}/gotchas/${file} (화면)\n${readIf(join(splitDir, file), 3000)}`).join('') : ''
  }
  const knowledge = knowledgeDirs.map((dir) => `### ${dir}/gotchas.md\n${readIf(join(ROOT, 'docs/knowledge', dir, 'gotchas.md'), 8000)}${screenNotes(dir)}\n### ${dir}/patterns.md (앞부분)\n${readIf(join(ROOT, 'docs/knowledge', dir, 'patterns.md'), 2500)}`).join('\n\n')
  const skills = readdirSync(join(ROOT, '.claude/skills')).filter((name) => !name.startsWith('.')).join(', ')
  const issues = openLearnIssues().map(({ file, text }) => `- ${file}: ${(text.match(/^title:\s*(.*)$/m) ?? [])[1] ?? ''}`).join('\n') || '(없음)'
  // 역할은 에이전트 프로필과 같은 꼴의 문서 한 곳 — .claude/agents/learn-reviewer.md (front matter 는 빼고 본문만)
  const role = readFileSync(join(ROOT, '.claude/agents/learn-reviewer.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  return `${role}

---

아래는 이번 검토에 받은 것이다(역할 문서 "받는 것" 표 순서).

## 학습 기준 (정본 — docs/knowledge/common/learning.md)
${criteria}

## 기존 스킬
${skills}

## 기존 knowledge (중복 판단용)
${knowledge || '(대상 레포를 알 수 없음)'}

## 열린 learn 이슈 (중복 판단용)
${issues}

## 계획서 — 요청 내용 · 결정 · 진행 · 검증 · 리뷰 결론 (${planFile})
${clip(maskSecrets(planText).masked, MAX_PLAN_CHARS)}

## 머지된 PR — 팀이 받아들인 최종 변경과 리뷰 지적
${maskSecrets(prMaterial).masked || '(머지된 PR 없음 — 대화와 계획서만 본다)'}

## 작업 대화 기록 — 계획서 ${planFile}
(👤 사용자 · 🤖 에이전트 · 🔧 도구 호출 · ❌ 도구 오류 첫 줄. 비밀값은 *** 로 가려져 있다)
${transcript}
`
}

const askReviewer = (prompt) => {
  // 도구 없이, 세션 저장 없이, 중립 폴더에서(hermes CLAUDE.md·훅을 끌어오지 않게) 한 번 돈다
  const result = spawnSync('claude', ['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(LEARN_SCHEMA)], {
    input: prompt,
    cwd: tmpdir(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  })
  if (result.status !== 0) throw new Error(`claude -p 실패(코드 ${result.status}): ${clip((result.stderr || result.stdout || '').trim(), 300)}`)
  const answer = JSON.parse(result.stdout)
  if (answer.is_error) throw new Error(`검토자 오류: ${clip(String(answer.result ?? ''), 300)}`)
  return { items: answer.structured_output?.items ?? [], cost: answer.total_cost_usd ?? 0 }
}

// ── Jev 나란히 판정(scripts/lib/jev.mjs) — 배우기 검토 거름망 후보. 지금은 건너뛰지 않고 점수만 남긴다 ─────
// 키가 없으면 undefined(기록 안 함) · 실패면 null. 검토자가 받는 것과 같은 재료를 중요한 순서(계획서 → PR → 대화)로 보낸다
const SHADOW_VERSION = 'learn-trap-v1'
const shadowJev = async (planFile, planText, prMaterial, transcript) => {
  if (!jevEnabled()) return undefined
  const state = `끝난 작업 하나의 기록 — 계획서 · 머지된 PR(리뷰 댓글·바뀐 코드) · 작업 대화(비밀값은 *** 로 가림)\n\n## 계획서\n${clip(maskSecrets(planText).masked, MAX_PLAN_CHARS)}\n\n## 머지된 PR\n${maskSecrets(prMaterial).masked || '(없음)'}\n\n## 작업 대화\n${transcript}`
  const answer = await askJev({
    purpose: 'learn-review',
    state,
    questions: { trap: { type: 'noul', instructions: '이 작업에서, 같은 레포의 다음 평범한 작업이 다시 밟을 그 레포 고유의 함정(모르면 실제로 잘못 만들게 되는 것)이 드러났다. 이미 코드로 고쳐져 다시 일어날 수 없는 버그·한 번뿐인 사고·사용자 취향은 해당하지 않는다' } },
    meta: { qv: SHADOW_VERSION, plan: planFile },
    timeoutMs: 30_000,
  })
  if (!answer) return null
  const score = Number(answer.answers.trap?.noul ?? 0)
  console.log(`  Jev 나란히 판정 — 함정 있음 ${Math.round(score * 100)}% (건너뛰지 않음 · 기록만)`)
  return score
}

// ── learn 이슈 쓰기 — 같은 target 열린 이슈면 덧붙인다 ─────────────────────
const slug = (text) => text.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase()
// AGENTS.md 6절과 같은 꼴(파일#절) — 같은 절일 때만 합친다
const issueTarget = (item) => (item.kind === 'skill' ? `skill:${slug(item.skill)}` : `docs/knowledge/${item.knowledge}/${item.kind}.md#${item.section.replace(/^#+\s*/, '').trim() || '기타'}`)
// 카드 제목 — 규칙의 첫 문장만, 길면 자른다(본문에 전체가 있다)
const cardTitle = (rule) => clip((rule.replace(/\n/g, ' ').match(/^.+?(?:다\.|\.\s)/) ?? [rule])[0].replace(/\.\s*$/, '').trim(), 80)

// 공책이 실제로 있는 영역 — 앱(<레포>/<앱>)·레포 공통(<레포>)·athena 모두. learned/ 는 공책이 아니다
const knownKnowledge = new Set()
const collectNotebooks = (dir, prefix = '') => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!isDirEntry(dir, entry) || entry.name === 'learned') continue
    const area = prefix ? `${prefix}/${entry.name}` : entry.name
    if (existsSync(join(dir, entry.name, 'gotchas.md'))) knownKnowledge.add(area)
    collectNotebooks(join(dir, entry.name), area)
  }
}
collectNotebooks(join(ROOT, 'docs/knowledge'))
// 화면 범위 — 코드 폴더 모양(app/x · src/screens/x)만 받는다. 아니면 common(안 읽어서 밟는 것보다 더 읽는 게 낫다)
const scopeOf = (item) => {
  const scope = String(item.scope ?? '').trim().replace(/^\/+|\/+$/g, '')
  return /^[\w.-]+(?:\/[\w.\-[\]()]+)+$/.test(scope) && !scope.includes('..') ? scope : 'common'
}
export const writeIssue = (item, planFile, dryRun) => {
  // 근거가 사용자 말뿐이면 취향일 수 있다 — 공용 공책에 넣지 않는다(learning.md 1-1). LLM 판단이 아니라 여기서 기계적으로 거른다
  if (item.basis !== 'code' && item.basis !== 'run') return `건너뜀 — 근거가 사용자 말뿐(basis: ${item.basis || '없음'}) · 취향일 수 있어 메모리 몫`
  if (item.kind !== 'skill' && !knownKnowledge.has(item.knowledge)) return `건너뜀 — 모르는 knowledge 폴더 "${maskSecrets(item.knowledge).masked}"`
  const target = issueTarget(item)
  const { masked: rule } = maskSecrets(item.rule)
  const { masked: evidence } = maskSecrets(item.evidence)
  const { masked: strengthen } = maskSecrets(item.strengthen ?? '')
  // 합치는 건 스킬 후보(반복 +1)만 — 함정은 절 이름이 같아도 내용이 다를 수 있다. 같은 내용인지는 검토자가 이미 판단해 내지 않는다
  const existing = item.kind === 'skill' ? openLearnIssues().find(({ text }) => (text.match(/^target:\s*(.*)$/m) ?? [])[1]?.trim() === target) : null
  if (existing) {
    const path = join(ROOT, 'issues', existing.file)
    let text = existing.text
    if (item.kind === 'skill') {
      text = `${text.trimEnd()}\n- 반복 +1 (${today} · ${planFile} · 검토자)\n`
      const repeats = (text.match(/^- 반복 \+1/gm) ?? []).length
      if (repeats >= 2 && !/^title:\s*🛠/m.test(text)) text = text.replace(/^title:\s*/m, 'title: 🛠 스킬로 만들까요? ')
    } else {
      text = `${text.trimEnd()}\n\n## 덧붙임 (${today} · ${planFile})\n- ${maskSecrets(item.explain ?? '').masked}\n- 공책 문장 후보: ${rule}${strengthen ? `\n- 기존 줄 강화: ${strengthen}` : ''}\n- 근거: ${evidence}\n`
    }
    if (!dryRun) writeFileSync(path, text)
    return `${dryRun ? '(예정) ' : ''}덧붙임 → issues/${existing.file}`
  }
  const repoSlug = item.kind === 'skill' ? 'athena' : slug(item.knowledge)
  const name = item.kind === 'skill' ? `skill-${slug(item.skill)}` : `${item.kind}-${createHash('sha1').update(rule).digest('hex').slice(0, 6)}`
  const file = `${today.replace(/-/g, '')}-${repoSlug}-learn-${name}.md`
  const body = `---
title: ${item.kind === 'skill' ? `스킬 후보 ${slug(item.skill)} — ` : ''}${clip(maskSecrets(item.title || cardTitle(rule)).masked.replace(/\n/g, ' '), 90)}
status: open
repo: athena
agent:
kind: knowledge
severity: low
signal: review
source: ${planFile} (배우기 검토자 · ${item.signal})
basis: ${item.basis}
target: ${target}${item.kind !== 'skill' && scopeOf(item) !== 'common' ? `\nscope: ${scopeOf(item)}` : ''}${strengthen ? `\nstrengthen: ${strengthen.replace(/\n/g, ' ')}` : ''}
plan:
fix:
reason:
---

## 무엇을 배웠나
${maskSecrets(item.explain ?? '').masked}

## 왜 중요한가
${maskSecrets(item.ifUnknown ?? '').masked}

## 공책에 넣을 문장
${rule}
${strengthen ? `\n(새 줄이 아니라 기존 줄을 고친다: ${strengthen})\n` : ''}
## 어디서 배웠나
- ${planFile} — ${evidence}
${item.kind === 'skill' ? `\n## 절차\n- (검토자가 본 반복 절차 — 스킬로 만들 때 아테나가 대화·계획서를 보고 채운다)\n- 반복 +1 (${today} · ${planFile} · 검토자)\n` : ''}`
  if (!dryRun) writeFileSync(join(ROOT, 'issues', file), body)
  return `${dryRun ? '(예정) ' : ''}새 이슈 → issues/${file}`
}

// ── 한 계획서 검토 ──────────────────────────────────────────────────────
const reviewPlan = async (planArg, { head = '', dryRun = false, force = false } = {}) => {
  let planPath = resolve(ROOT, planArg)
  let planFile = relative(ROOT, planPath)
  // 보관본(archive/<이름>) — 읽기만 한다(--dry-run 만). 대화는 보관 전 계획서 경로(meta.json from.plan)로 찾는다
  if (planFile.startsWith('archive/')) {
    const bundle = planFile.split('/').slice(0, 2).join('/')
    const meta = JSON.parse(readFileSync(join(ROOT, bundle, 'meta.json'), 'utf8'))
    if (!dryRun) throw new Error('보관본은 --dry-run 으로만 검토한다(archive/ 는 git 기록이라 쓰지 않는다)')
    planPath = join(ROOT, bundle, 'plan.md')
    planFile = meta.from?.plan || ''
    if (!planFile || !existsSync(planPath)) throw new Error(`보관본에 계획서가 없다: ${bundle}`)
  } else if (!planFile.startsWith('plans/') || !existsSync(planPath)) throw new Error(`plans/ 안의 계획서가 아니거나 없다: ${planArg}`)
  const planText = readFileSync(planPath, 'utf8')
  const mark = head ? `@${head}` : ''
  if (!force && mark && planText.includes(`- Learn review:`) && planText.match(/^- Learn review:.*$/m)?.[0].includes(mark)) {
    console.log(`⏭  ${planFile} — 같은 HEAD ${head} 는 이미 검토했다(--force 로 다시)`)
    return
  }
  console.log(`📚 ${planFile}${mark ? ` ${mark}` : ''}`)
  const transcripts = await findTranscripts(planFile)
  // 대화가 없어도 머지된 PR 이 있으면 계획서·PR 로 배운다. 둘 다 없으면 건너뛴다
  if (!transcripts.length && !planPullRequests(planText).length) {
    console.log('  대화 기록도 PR 도 없다 — 건너뜀')
    return
  }
  const condensed = (await Promise.all(transcripts.map(condense))).map((text, index) => `### 세션 ${index + 1}\n${text}`).join('\n\n') || '(대화 기록 없음)'
  const { masked, count: maskedCount } = maskSecrets(condensed)
  const transcript = fitBudget(masked)
  const knowledgeDirs = planKnowledge(planText)
  console.log(`  세션 ${transcripts.length}개 · 줄인 기록 ${condensed.length}자 → ${transcript.length}자 · 가린 비밀값 ${maskedCount}개 · knowledge ${knowledgeDirs.join(', ') || '없음'}`)
  const prMaterial = pullRequestMaterial(planText)
  console.log(`  계획서 ${planText.length}자 · 머지된 PR 재료 ${prMaterial.length}자`)
  const jevScore = await shadowJev(planFile, planText, prMaterial, transcript)
  const { items, cost } = askReviewer(buildPrompt(planFile, knowledgeDirs, transcript, planText, prMaterial))
  console.log(`  검토자 답 ${items.length}건 · 비용 $${Number(cost).toFixed(3)}`)
  const written = items.map((item) => writeIssue(item, planFile, dryRun))
  const results = items.map((item, index) => `  - [${item.signal}·${item.kind}${item.kind !== 'skill' ? `·${scopeOf(item)}` : ''}] ${maskSecrets(item.title ?? '').masked}\n    무엇을 배웠나: ${maskSecrets(item.explain ?? '').masked}\n    왜 중요한가: ${maskSecrets(item.ifUnknown ?? '').masked}\n    공책 문장: ${maskSecrets(item.rule).masked}\n    근거(${item.basis}): ${maskSecrets(item.evidence ?? '').masked}\n    ${written[index]}`)
  if (results.length) console.log(results.join('\n'))
  // Jev 나란히 판정의 실제 결과 — 점수가 낮은데 이슈가 나온 작업이 거름망이 놓쳤을 것(node scripts/lib/jev.mjs --report)
  if (jevScore !== undefined) logJev({ purpose: 'learn-review-outcome', plan: planFile, jev: jevScore, items: items.length, written: written.filter((line) => !line.startsWith('건너뜀')).length, dryRun })
  if (dryRun) {
    console.log('  (--dry-run — 이슈·계획서를 쓰지 않았다)')
    return
  }
  // 계획서 Checkpoint 에 한 줄 — 같은 HEAD 는 다시 돌지 않는다
  // 검토자를 기다리는 동안 ship.sh --yes(PR 줄)·리뷰·에이전트가 계획서를 고쳤을 수 있다 — 쓰기 직전에 다시 읽고 이 줄만 바꾼다
  const line = `- Learn review: ${today}${mark ? ` ${mark}` : ''} · ${items.length}건 (배우기 검토자)`
  // 잠금 안에서 지금 내용을 다시 읽어 이 줄만 바꾼다(scripts/lib/plan-update.mjs) · 정식 계획서면 html 의 md 사본도 맞춘다
  updatePlan(planPath, (current) => (/^- Learn review:.*$/m.test(current) ? current.replace(/^- Learn review:.*$/m, line) : current.replace(/^(- Work ref:.*)$/m, `$1\n${line}`)))
}

// ── 대기열 · 검토 ──────────────────────────────────────────────────────
const lockOwner = () => {
  try {
    return Number(readFileSync(join(WATCHER_LOCK, 'pid'), 'utf8')) || 0
  } catch {
    return 0
  }
}
const isAlive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const watcherAlive = () => isAlive(lockOwner())

// 잠금 잡기 — pid 를 넣은 임시 폴더를 잠금 이름으로 옮긴다(rename 은 원자적이라 둘이 동시에 잡지 못하고, pid 없는 잠금이 보이는 틈도 없다).
// 주인이 죽은 잠금은 고유한 이름으로 옮겨 치운다 — 옮긴 것이 살아 있는 주인의 것이면(그 사이 다른 쪽이 새로 잡았다) 되돌리고 물러난다
function acquireWatcher() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staging = mkdtempSync(join(QUEUE_DIR, '.watcher-new-'))
    writeFileSync(join(staging, 'pid'), String(process.pid))
    try {
      renameSync(staging, WATCHER_LOCK)
      return true
    } catch {
      rmSync(staging, { recursive: true, force: true })
    }
    if (watcherAlive()) return false
    const stale = `${WATCHER_LOCK}.stale-${process.pid}-${attempt}`
    try { renameSync(WATCHER_LOCK, stale) } catch { continue }
    const taken = Number(readFileSync(join(stale, 'pid'), 'utf8').trim()) || 0
    if (isAlive(taken)) {
      try { renameSync(stale, WATCHER_LOCK) } catch { /* 그새 또 잡혔다 */ }
      return false
    }
    rmSync(stale, { recursive: true, force: true })
  }
  return false
}

const enqueue = (planArg, head) => {
  mkdirSync(QUEUE_DIR, { recursive: true })
  const digest = createHash('sha1').update(planArg + head).digest('hex').slice(0, 6)
  // 같은 계획서·표시가 이미 기다리거나 도는 중이면 또 넣지 않는다(현황판이 다시 켜지면 같은 걸 또 넣을 수 있다)
  if (readdirSync(QUEUE_DIR).some((file) => file.includes(`-${digest}`) && /\.json(\.working)?$/.test(file))) return console.log('📚 이미 배우기 검토 대기열에 있다')
  const id = `${Date.now()}-${digest}`
  writeFileSync(join(QUEUE_DIR, `${id}.json`), JSON.stringify({ plan: planArg, head, root: REAL_ROOT, ...(BOOT_PATHS.packId ? { packId: BOOT_PATHS.packId, generation: BOOT_PATHS.generation } : {}), attempts: 0 }))
  if (watcherAlive()) return console.log('📚 배우기 검토 대기열에 넣었다 — 뒤에서 도는 검토가 차례로 처리한다')
  // 방금(30초 안) 다른 요청이 검토를 띄우는 중이면 또 띄우지 않는다 — 여러 개가 한꺼번에 들어올 때 잠금이 생기기 전 틈.
  // 표시 파일은 없을 때만 만든다(wx — 둘이 동시에 만들지 못한다). 오래된 표시는 치우고 다시
  const launching = join(QUEUE_DIR, '.launching')
  for (let attempt = 0; ; attempt += 1) {
    try {
      closeSync(openSync(launching, 'wx'))
      break
    } catch {
      let age = Infinity
      try { age = Date.now() - statSync(launching).mtimeMs } catch { /* 그새 치워졌다 */ }
      if (age < 30_000 || attempt > 0) return console.log('📚 배우기 검토 대기열에 넣었다 — 검토가 뜨는 중')
      rmSync(launching, { force: true })
    }
  }
  // 뒤에서 하나 — pane 은 띄우지 않는다(사용자 결정 2026-10-17: 스튜디오에는 배우기 검토 pane 을 두지 않는다)
  const logFd = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--watch'], { detached: true, stdio: ['ignore', logFd, logFd] })
  child.unref()
  console.log(`📚 배우기 검토를 뒤에서 시작했다 — 기록 ${LOG_FILE}`)
}

// 실패한 일 — 몇 번 다시 해 보고(일시적인 claude·파일 오류), 그래도 안 되면 failed/ 에 이유와 함께 남긴다(지우지 않는다)
function settleFailure(working, job, error) {
  const attempts = (job.attempts ?? 0) + 1
  const base = working.split('/').pop().replace(/\.json\.working$/, '').replace(/-retry\d+$/, '')
  if (attempts < MAX_ATTEMPTS && !job.foreign) {
    writeFileSync(join(QUEUE_DIR, `${base}-retry${attempts}.json`), JSON.stringify({ ...job, attempts, notBefore: Date.now() + RETRY_DELAY_MS * attempts, lastError: error.message }))
    console.log(`  ↻ ${attempts}번째 실패 — ${Math.round((RETRY_DELAY_MS * attempts) / 1000)}초 뒤 다시`)
  } else {
    mkdirSync(FAILED_DIR, { recursive: true })
    writeFileSync(join(FAILED_DIR, `${base}.json`), JSON.stringify({ ...job, attempts, failedAt: new Date().toISOString(), lastError: error.message }, null, 2))
    console.log(`  ✖ 포기 — ${relative(ROOT, FAILED_DIR) || FAILED_DIR}/${base}.json 에 남겼다(다시 하려면 그 파일을 대기열 폴더로 옮긴다)`)
  }
}

const watch = async () => {
  mkdirSync(QUEUE_DIR, { recursive: true })
  if (!acquireWatcher()) {
    console.log('이미 다른 검토가 돌고 있다 — 여기서는 끝낸다')
    return
  }
  // 잠금은 내 것일 때만 치운다(다른 쪽이 주인 없는 잠금으로 보고 새로 잡았을 수 있다)
  const cleanup = () => releaseLock(WATCHER_LOCK)
  process.on('exit', cleanup)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGHUP', () => process.exit(129))   // 터미널을 닫으면 온다
  process.on('SIGTERM', () => process.exit(143))
  rmSync(join(QUEUE_DIR, '.launching'), { force: true })
  // 지난 검토 프로세스가 처리하다 끊긴 요청을 대기열로 되돌린다 — 잠금을 쥔 뒤라 살아 있는 다른 watcher 의 일이 아니다
  for (const file of readdirSync(QUEUE_DIR).filter((name) => name.endsWith('.json.working'))) {
    try { renameSync(join(QUEUE_DIR, file), join(QUEUE_DIR, file.replace(/\.working$/, ''))) } catch { /* 다른 쪽이 먼저 옮겼다 */ }
  }
  console.log('📚 배우기 검토 — 대기열을 기다린다(내 작업의 PR 이 머지되면 현황판이 넣는다). 끄려면 Ctrl-C')
  const readJob = (file) => { try { return JSON.parse(readFileSync(join(QUEUE_DIR, file), 'utf8')) } catch { return {} } }
  for (;;) {
    // 팩을 갈아 끼웠으면 끝낸다 — 이 프로세스의 설정·계획서 읽기는 이전 팩 것이다(새 팩은 세션 시작·현황판이 다시 띄운다)
    if (packChanged()) { console.log('📚 팩을 갈아 끼워 배우기 검토를 끝낸다'); process.exit(0) }
    // 다시 해 볼 시각(notBefore)이 안 된 일은 건너뛴다
    const next = readdirSync(QUEUE_DIR).filter((file) => file.endsWith('.json')).sort().find((file) => !(readJob(file).notBefore > Date.now()))
    if (!next) {
      await new Promise((done) => setTimeout(done, 5000))
      continue
    }
    const working = join(QUEUE_DIR, `${next}.working`)
    try { renameSync(join(QUEUE_DIR, next), working) } catch { continue }
    let job = {}
    try {
      job = JSON.parse(readFileSync(working, 'utf8'))
      // 다른 체크아웃이 넣은 일 — 이 체크아웃의 계획서·팩으로 읽으면 엉뚱한 작업을 배운다.
      // 여러 팩 구조는 대기열이 팩 데이터 안이라 팩이 같으면 내 일이다 — 팩을 새 본체로 옮겨도 이어서 한다
      const foreign = BOOT_PATHS.packId && job.packId
        ? job.packId !== BOOT_PATHS.packId
        : Boolean(job.root && job.root !== REAL_ROOT)
      if (foreign) {
        job.foreign = true
        throw new Error(`다른 체크아웃(${job.root})의 일이다`)
      }
      await reviewPlan(job.plan, { head: job.head })
    } catch (error) {
      console.log(`  ⚠️ ${error.message}`)
      settleFailure(working, job, error)
    }
    rmSync(working, { force: true })
    console.log(`── ${new Date().toLocaleTimeString()} 대기 중`)
  }
}

// ── 시작 (다른 스크립트·테스트가 import 할 때는 돌지 않는다) ──────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (!isMain) {
  // import 만
} else if (flag('watch')) await watch()
else if (flag('enqueue')) enqueue(option('plan'), option('head'))
else if (option('plan')) await reviewPlan(option('plan'), { head: option('head'), dryRun: flag('dry-run'), force: flag('force') })
else {
  console.error('사용: node scripts/learn-review.mjs --plan <plans/…md> [--head <sha>] [--dry-run] [--force] | --enqueue --plan <…> [--head <sha>] | --watch')
  process.exit(1)
}
