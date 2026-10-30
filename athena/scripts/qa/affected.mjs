#!/usr/bin/env node
// @ts-check
/**
 * 바뀐 코드가 닿는 흐름 찾기 — /sync 가 흐름 문서 · TC 를 고칠 대상을 고른다(근거 코드 `파일:줄` 과 대조).
 *   node scripts/qa/affected.mjs --service <이름> --from <이전 커밋> [--to <커밋 — 기본 origin/<branch>>]
 * 출력: 층/흐름마다 한 줄 + 닿은 파일. 없으면 "없음". 문서에 적히지 않은 새 화면 · 엔드포인트는 여기 잡히지 않는다(/sync 가 커밋 목록으로 본다)
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.mjs'
import { affectedFlows, flowsOfFiles, flowsPath, listFlowFiles, listServices } from './flows.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const option = (/** @type {string} */ name) => { const at = argv.indexOf(`--${name}`); return at < 0 ? '' : argv[at + 1] ?? '' }

const service = listServices(loadConfig(ROOT)).find((entry) => entry.name === option('service'))
if (!service || !option('from')) {
  console.error('사용: node scripts/qa/affected.mjs --service <이름> --from <이전 커밋> [--to <커밋>]')
  process.exit(2)
}
const repoDir = join(ROOT, 'repos', service.repo)
const ref = `origin/${service.branch}`
const git = (/** @type {string[]} */ args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
const changed = git(['diff', '--name-only', `${option('from')}..${option('to') || ref}`]).split('\n').filter(Boolean)
const docs = flowsOfFiles(listFlowFiles(ROOT, service).files).map((item) => ({
  layer: item.layer,
  flow: item.flow,
  text: git(['show', `${ref}:${flowsPath(service)}/${item.doc}`]),
}))
const hits = affectedFlows(changed, docs)
if (!hits.length) console.log(`${service.name}: 닿는 흐름 없음 (바뀐 파일 ${changed.length}개 · 흐름 ${docs.length}개)`)
for (const hit of hits) console.log(`${service.name} ${hit.layer}/${hit.flow}: ${hit.files.join(' · ')}`)
