#!/usr/bin/env node
// @ts-check
// 고정 커밋의 근거와 팩 운영 ref를 비교한다. 내용을 출력하거나 자동으로 revision을 바꾸지 않는다.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, paths } from './lib/config.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')
const config = loadConfig(root)
const pack = paths(root).packDir
const directory = join(pack ?? join(root, 'docs'), 'diagrams')
/** @param {string} repo @param {string[]} args */
const git = (repo, args) => {
  try { return execFileSync('git', ['--no-replace-objects', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd() } catch { return null }
}
/** @param {string} directory @returns {string[]} */
const specs = (directory) => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = join(directory, entry.name)
  if (entry.isDirectory()) return specs(full)
  return /\.(architecture|workflow|sequence|dataflow|lifecycle)\.json$/.test(entry.name) ? [full] : []
}) : []
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @returns {Record<string, unknown>[]} */
const sourcesOf = (value) => {
  if (Array.isArray(value)) return value.flatMap(sourcesOf)
  if (!record(value)) return []
  return [...(Array.isArray(value.sources) ? value.sources.filter(record) : []), ...Object.entries(value).filter(([key]) => key !== 'sources').flatMap(([, child]) => sourcesOf(child))]
}
/** @param {unknown} url */
const identity = (url) => String(url ?? '').trim().replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.git$/, '')
// 고정된 진단 문구만 외부로 내보낸다. JSON·git 원문은 출력하지 않는다.
class EvidenceError extends Error {}
let failures = 0
let count = 0
for (const file of specs(directory)) {
  count++
  const issues = []
  try {
    /** @type {unknown} */
    const spec = JSON.parse(readFileSync(file, 'utf8'))
    if (!record(spec)) throw new EvidenceError('스펙 객체가 필요하다')
    if (spec.diagram_type !== file.split('.').at(-2)) throw new EvidenceError('파일명과 diagram_type이 다르다')
    const meta = record(spec.meta) ? spec.meta : {}
    const repository = record(meta.repository) ? meta.repository : null
    const sources = sourcesOf(spec)
    // sequence 등은 Archify가 repository 필드를 지원하지 않는다. 코드 대조는 가이드에 남긴다.
    if (!repository && spec.diagram_type !== 'architecture') {
      console.log(`➖ ${relative(directory, file)} — 자동 근거 점검 미지원(가이드의 코드 대조 필요)`)
      continue
    }
    if (!repository || typeof repository.url !== 'string' || !repository.url || typeof repository.revision !== 'string' || !/^[a-fA-F0-9]{40}$/.test(repository.revision) || !sources.length) throw new EvidenceError('architecture에 고정 커밋과 sources가 필요하다')
    const repo = config.repos.find((/** @type {{name: string, remote?: string}} */ candidate) => {
      const remote = candidate.remote || git(join(root, 'repos', candidate.name), ['remote', 'get-url', 'origin'])
      return remote && identity(remote) === identity(repository.url)
    })
    if (!repo) throw new EvidenceError('repository.url에 대응하는 팩 레포가 없다')
    const repoDir = join(root, 'repos', repo.name)
    if (git(repoDir, ['rev-parse', '--verify', `${repository.revision}^{commit}`]) === null) throw new EvidenceError('고정 커밋을 읽을 수 없다')
    const branches = new Set()
    for (const source of sources) {
      if (typeof source.path !== 'string' || !source.path || source.path.startsWith('/') || source.path.includes('\\') || source.path.split('/').includes('..')) throw new EvidenceError('근거 경로는 레포 안 상대 경로여야 한다')
      const app = Object.entries(repo.apps ?? {}).find(([name, app]) => {
        const prefix = app.dir ?? `apps/${name}`
        return source.path === prefix || String(source.path).startsWith(`${prefix}/`)
      })?.[1]
      const branch = app?.branch ?? repo.branch
      if (typeof branch !== 'string' || !branch) throw new EvidenceError('팩 운영 기준 branch가 없다')
      branches.add(branch)
      const target = git(repoDir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])
      if (!target) throw new EvidenceError('운영 ref를 읽을 수 없다 — fetch 후 재시도')
      const blob = git(repoDir, ['show', `${repository.revision}:${source.path}`])
      if (blob === null) throw new EvidenceError('고정 커밋에 근거 파일이 없다')
      const lines = blob.split('\n').length
      for (const key of ['line', 'end_line']) {
        const line = source[key]
        if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > lines)) throw new EvidenceError('근거 줄 범위가 유효하지 않다')
      }
      if (typeof source.line === 'number' && typeof source.end_line === 'number' && source.end_line < source.line) throw new EvidenceError('근거 끝 줄이 시작 줄보다 앞선다')
      if (git(repoDir, ['merge-base', '--is-ancestor', repository.revision, target]) === null) issues.push('고정 커밋이 운영 ref의 조상이 아님')
      if (git(repoDir, ['diff', '--quiet', repository.revision, target, '--', source.path]) === null) issues.push('근거 파일 변경 — 코드 대조·재생성 필요')
      else if (target !== repository.revision) issues.push('커밋 뒤처짐 — 파일은 같지만 의미 대조·재생성 필요')
    }
    console.log(`${issues.length ? '🟡' : '✅'} ${relative(directory, file)} — ${[...branches].join(', ')}${issues.length ? ` · ${[...new Set(issues)].join(' · ')}` : ' · 최신'}`)
    if (issues.length) failures++
  } catch (error) {
    failures++
    // 파서·git 오류 원문에는 사용자 코드나 비밀값이 들어갈 수 있어 출력하지 않는다.
    console.log(`❌ ${relative(directory, file)} — ${error instanceof EvidenceError ? error.message : '스펙·팩·근거 읽기 실패'}`)
  }
}
console.log(`점검 ${count} · 확인 필요 ${failures} (Archify validate·deliver와 별도)`)
if (strict && (!count || failures)) process.exitCode = 1
