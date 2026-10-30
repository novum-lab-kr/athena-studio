// @ts-check
// 흐름 문서 · TC 를 찾고 읽고 검사한다 · 지난 결과를 모은다 — 실행기(run.mjs) · 현황판(board/server.mjs)이 같이 쓴다.
// 형식 정본: docs/knowledge/common/qa-flows.md
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const LAYERS = /** @type {const} */ (['fe', 'be', 'app'])
export const RUN_LAYERS = /** @type {const} */ (['fe', 'be'])   // 앱은 체크리스트 문서만 — 실행 없음(결정 D1)
export const FLOWS_DIR = 'docs/flows'

const FE_STEPS = ['goto', 'click', 'fill', 'press', 'expectVisible', 'expectHidden', 'expectText', 'expectUrl', 'mock']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** @typedef {{ name: string, repo: string, dir: string, branch: string, remote: string }} Service */
/** @typedef {{ repos?: any[] }} PackConfig */

/**
 * 팩 레포 → 서비스. 단일 레포 = 서비스 하나(레포 뿌리), 모노레포 = 앱마다, 발행 패키지는 뺀다
 * @param {PackConfig} config
 * @returns {Service[]}
 */
export function listServices(config) {
  /** @type {Service[]} */
  const services = []
  for (const repo of config.repos ?? []) {
    if (repo.kind === 'packages') continue
    if (repo.kind === 'monorepo') {
      for (const [app, settings] of Object.entries(repo.apps ?? {})) {
        const spec = /** @type {any} */ (settings)
        services.push({ name: app, repo: repo.name, dir: spec.dir ?? `apps/${app}`, branch: spec.branch ?? repo.branch, remote: repo.remote ?? '' })
      }
      continue
    }
    services.push({ name: repo.name, repo: repo.name, dir: '', branch: repo.branch, remote: repo.remote ?? '' })
  }
  return services
}

/** @param {Service} service */
export const flowsPath = (service) => (service.dir ? `${service.dir}/${FLOWS_DIR}` : FLOWS_DIR)

/**
 * 파일 이름 목록 → 층별 흐름 [{ layer, flow, doc, tc }]. tc 는 실행 층에만 본다
 * @param {string[]} files 서비스 흐름 폴더 기준 상대 경로(예: fe/02-journey.md)
 */
export function flowsOfFiles(files) {
  const present = new Set(files)
  const flows = []
  for (const file of files) {
    const match = file.match(/^(fe|be|app)\/([^/]+)\.md$/)
    if (!match || match[2]?.toLowerCase() === 'readme') continue
    const layer = /** @type {string} */ (match[1])
    const flow = /** @type {string} */ (match[2])
    const tc = `${layer}/${flow}.tc.json`
    flows.push({ layer, flow, doc: file, tc: layer !== 'app' && present.has(tc) ? tc : null })
  }
  return flows
}

/**
 * TC 파일 하나를 검사한다 — 오류 문구 목록(비면 통과). 분기 이름이 흐름 문서에 있어야 짝이 맞는다
 * @param {any} tc @param {string} layer @param {string} docText
 */
export function checkTc(tc, layer, docText) {
  const errors = []
  if (!Array.isArray(tc?.cases) || !tc.cases.length) return ['cases 가 비어 있어요']
  const seen = new Set()
  for (const item of tc.cases) {
    const label = item?.id ?? '(id 없음)'
    if (!item?.id) errors.push('id 가 없는 TC 가 있어요')
    if (seen.has(item?.id)) errors.push(`${label}: id 가 겹쳐요`)
    seen.add(item?.id)
    if (!item?.branch) errors.push(`${label}: branch(분기 이름)가 없어요`)
    else if (!docText.includes(item.branch)) errors.push(`${label}: 분기 "${item.branch}" 가 흐름 문서에 없어요`)
    if (item?.manual) continue   // 사람이 봐야 하는 TC — 이유만 있으면 된다
    if (layer === 'fe') errors.push(...checkFeCase(item, label))
    if (layer === 'be') errors.push(...checkBeCase(item, label))
  }
  return errors
}

/** @param {any} item @param {string} label */
function checkFeCase(item, label) {
  if (!Array.isArray(item.steps) || !item.steps.length) return [`${label}: steps 가 비어 있어요`]
  const errors = []
  for (const step of item.steps) {
    const kind = Object.keys(step ?? {}).find((key) => FE_STEPS.includes(key))
    if (!kind) errors.push(`${label}: 모르는 단계 ${JSON.stringify(step)}`)
    if (kind === 'goto' && !String(step.goto).startsWith('/')) errors.push(`${label}: goto 는 / 로 시작하는 경로만 돼요`)
    if (kind === 'fill' && typeof step.value !== 'string') errors.push(`${label}: fill 에는 value 가 있어야 해요`)
    if (kind === 'mock' && typeof step.status !== 'number') errors.push(`${label}: mock 에는 status 가 있어야 해요`)
  }
  return errors
}

/** @param {any} item @param {string} label */
function checkBeCase(item, label) {
  const errors = []
  if (!String(item.request?.path ?? '').startsWith('/')) errors.push(`${label}: request.path 는 / 로 시작해야 해요`)
  if (typeof item.expect?.status !== 'number') errors.push(`${label}: expect.status 가 있어야 해요`)
  return errors
}

/**
 * qa.json 한 층 설정을 검사한다 — 대상은 로컬 서버뿐이다(결정 D6)
 * @param {any} settings @param {string} layer
 */
export function checkLayerSettings(settings, layer) {
  if (!settings) return `${FLOWS_DIR}/qa.json 에 ${layer} 설정이 없어요`
  if (typeof settings.start !== 'string' || !settings.start) return `${FLOWS_DIR}/qa.json ${layer}.start 가 없어요`
  let url
  try { url = new URL(settings.url) } catch { return `${FLOWS_DIR}/qa.json ${layer}.url 이 올바르지 않아요` }
  if (!LOCAL_HOSTS.has(url.hostname)) return `${layer}.url 은 로컬 서버만 돼요(지금 ${url.hostname})`
  return ''
}

/**
 * GitHub 에서 흐름 문서를 볼 주소(GitHub 가 Mermaid 를 그대로 그린다). GitHub 레포가 아니면 null
 * @param {Service} service @param {string} doc
 */
export function docUrl(service, doc) {
  const match = service.remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/)
  if (!match) return null
  const path = `${flowsPath(service)}/${doc}`.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${match[1]}/blob/${encodeURIComponent(service.branch)}/${path}`
}

/** @param {number | undefined} pid */
export const pidAlive = (pid) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 실행 폴더를 잡는다 — 같은 초에 시작한 실행이 앞 실행의 결과를 덮지 않게 이름이 겹치면 번호를 붙인다(이름순 = 시작 순서)
 * @param {string} runsDir @param {string} stamp
 */
export function claimRunId(runsDir, stamp) {
  mkdirSync(runsDir, { recursive: true })
  for (let attempt = 1; ; attempt += 1) {
    const id = attempt === 1 ? `${stamp}-qa` : `${stamp}-qa-${String(attempt).padStart(3, '0')}`
    try {
      mkdirSync(join(runsDir, id))
      return id
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error
    }
  }
}

/**
 * .qa-runs/ 의 실행 기록 — 최신부터
 * @param {string} runsDir
 * @returns {any[]}
 */
export function readRuns(runsDir) {
  if (!existsSync(runsDir)) return []
  const runs = []
  for (const name of readdirSync(runsDir).sort().reverse()) {
    try {
      const run = JSON.parse(readFileSync(join(runsDir, name, 'run.json'), 'utf8'))
      if (Array.isArray(run.flows)) runs.push(run)
    } catch { /* 쓰는 중이거나 옛 형식 — 건너뛴다 */ }
  }
  return runs
}

/**
 * 흐름마다 마지막 결과. 끝나지 않았는데 프로세스가 죽은 실행의 도는 흐름은 오류로 본다
 * @param {any[]} runs 최신부터
 * @returns {Map<string, any>} `<서비스>/<층>/<흐름>` → 결과
 */
export function latestResults(runs) {
  /** @type {Map<string, any>} */
  const latest = new Map()
  for (const run of runs) {
    const dead = !run.finishedAt && !pidAlive(run.pid)
    for (const entry of run.flows) {
      const key = `${entry.service}/${entry.layer}/${entry.flow}`
      if (latest.has(key)) continue
      latest.set(key, dead && entry.status === 'running' ? { ...entry, status: 'error', error: '실행이 중간에 끊겼어요' } : entry)
    }
  }
  return latest
}

/**
 * 현황판 QA 탭 자료 — 서비스 → 층 → 흐름. 문서 목록은 운영 기준 ref 에서, 결과는 지난 실행에서.
 * 아직 머지 전 흐름은 결과만 있어서 링크 없이 보인다
 * @param {PackConfig} config @param {string} root 본체 @param {string} runsDir
 */
export function overview(config, root, runsDir) {
  const runs = readRuns(runsDir)
  const latest = latestResults(runs)
  const services = listServices(config).map((service) => {
    const files = listFlowFiles(root, service)
    const layers = LAYERS.map((layer) => ({ layer, flows: /** @type {any[]} */ ([]) }))
    const place = (/** @type {string} */ layer, /** @type {any} */ item) => layers.find((entry) => entry.layer === layer)?.flows.push(item)
    const shown = new Set()
    for (const item of flowsOfFiles(files.files)) {
      const key = `${service.name}/${item.layer}/${item.flow}`
      shown.add(key)
      place(item.layer, { flow: item.flow, doc: item.doc, docUrl: docUrl(service, item.doc), hasTc: Boolean(item.tc), result: latest.get(key) ?? null })
    }
    for (const [key, result] of latest) {
      if (result.service !== service.name || shown.has(key)) continue
      place(result.layer, { flow: result.flow, doc: result.doc, docUrl: null, hasTc: true, result })
    }
    for (const entry of layers) entry.flows.sort((left, right) => left.flow.localeCompare(right.flow))
    return { name: service.name, repo: service.repo, error: files.error, layers: layers.filter((entry) => entry.flows.length) }
  })
  const active = runs.find((run) => !run.finishedAt && pidAlive(run.pid))
  return { services, running: active ? { id: active.id, startedAt: active.startedAt, request: active.request } : null }
}

/**
 * 운영 기준 ref 의 흐름 폴더 파일(메인 체크아웃은 브랜치가 제각각이라 읽지 않는다)
 * @param {string} root @param {Service} service
 */
export function listFlowFiles(root, service) {
  const repoDir = join(root, 'repos', service.repo)
  if (!existsSync(repoDir)) return { files: [], error: `repos/${service.repo} 링크가 없어요` }
  const prefix = `${flowsPath(service)}/`
  try {
    const out = execFileSync('git', ['-C', repoDir, 'ls-tree', '-r', '--name-only', `origin/${service.branch}`, '--', prefix], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return { files: out.split('\n').filter(Boolean).map((line) => line.slice(prefix.length)), error: '' }
  } catch {
    return { files: [], error: `origin/${service.branch} 를 읽지 못했어요` }
  }
}

/**
 * 작업 트리의 흐름 폴더 파일 — 실행기가 고른 트리(qa-base · --cwd)에서
 * @param {string} flowsRoot
 */
export function listTreeFiles(flowsRoot) {
  const files = []
  for (const layer of LAYERS) {
    const dir = join(flowsRoot, layer)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) files.push(`${layer}/${name}`)
  }
  return files
}

/**
 * 바뀐 파일이 닿는 흐름 — 문서에 적힌 근거 코드(`경로:줄` · `경로`)와 대조한다. 흐름 문서 · TC 자체가 바뀐 것은 뺀다
 * @param {string[]} changed 레포 기준 경로 @param {{ flow: string, layer: string, text: string }[]} docs
 */
export function affectedFlows(changed, docs) {
  const code = changed.filter((path) => !path.includes(`${FLOWS_DIR}/`))
  return docs.flatMap((doc) => {
    const cited = new Set([...doc.text.matchAll(/`([\w@./()[\]-]+\/[\w@./()[\]-]+?)(?::\d+(?:-\d+)?)?`/g)].map((match) => /** @type {string} */ (match[1])))
    const hits = code.filter((path) => cited.has(path))
    return hits.length ? [{ layer: doc.layer, flow: doc.flow, files: hits }] : []
  })
}
