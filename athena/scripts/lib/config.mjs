// 아테나 설정 읽기 — 코어 스크립트는 athena.config.json 을 직접 읽지 않고 이걸 쓴다.
//   athena.config.json : 이 컴퓨터 설정(reposRoot · 현황판 포트 · pack 경로)
//   <pack>/pack.json   : 회사 팩(레포 목록 · GitHub 조직 · QA · 추적 의존성 …)
// 합치는 규칙: 팩 값 위에 이 컴퓨터 설정을 덮는다(같은 키면 이 컴퓨터가 이긴다). 단 repos 는 팩 것만.
// pack 이 없으면 athena.config.json 하나가 전부다. 파이썬 쪽 같은 규칙: scripts/lib/athena_config.py
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ATHENA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const loadConfig = (root = ATHENA_ROOT) => {
  const local = JSON.parse(readFileSync(join(root, 'athena.config.json'), 'utf8'))
  if (!local.pack) return local
  const packDir = resolve(root, local.pack)
  const packFile = join(packDir, 'pack.json')
  if (!existsSync(packFile)) throw new Error(`팩이 없다: ${packFile} — athena.config.json 의 pack 경로 확인`)
  const pack = JSON.parse(readFileSync(packFile, 'utf8'))
  return { ...pack, ...local, repos: pack.repos ?? [], packDir }
}

// 레포를 맡은 에이전트 → 레포 이름 (모노레포는 앱 에이전트·packagesAgent 까지)
export const repoOfAgent = (config, agent) => config.repos.find((repo) =>
  (repo.agents ?? []).includes(agent) ||
  Object.values(repo.apps ?? {}).some((app) => app.agent === agent) ||
  repo.packagesAgent === agent)

// 계획서·이슈의 PR 링크(github.com/<조직>/<레포>/pull/<번호>) — 조직은 설정 github.org(없으면 아무 조직)
export const githubOrg = (config) => config.github?.org ?? ''
export const prLinkPattern = (org) => new RegExp(`github\\.com/${org ? org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[\\w.-]+'}/([\\w.-]+)/pull/(\\d+)`, 'g')
