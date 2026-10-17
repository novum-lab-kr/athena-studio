// 팩 링크를 지나는 경로의 git 작업 — git 은 심볼릭 링크 너머를 커밋·조회하지 못한다.
// 경로를 실제 위치로 풀어 그 파일이 든 레포(코어 또는 팩)에서 git 을 부른다.
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const toplevel = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// <root> 기준 상대 경로 → { top: 그 파일이 든 레포, rel: 그 레포 기준 경로 }. 아직 없는 파일은 가장 가까운 있는 부모로 푼다
export const realRepoPath = (root, rel) => {
  let probe = join(root, rel)
  let rest = ''
  while (!existsSync(probe) && probe !== dirname(probe)) {
    rest = rest ? join(probe.split('/').pop(), rest) : probe.split('/').pop()
    probe = dirname(probe)
  }
  const real = join(realpathSync(probe), rest)
  const top = toplevel(existsSync(real) && !rest ? dirname(real) : realpathSync(probe))
  return { top, rel: relative(top, real) }
}

// 경로들을 레포별로 묶는다 → Map<top, rel[]>
export const groupByRepo = (root, rels) => {
  const groups = new Map()
  for (const rel of rels) {
    const { top, rel: inner } = realRepoPath(root, rel)
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top).push(inner)
  }
  return groups
}

// 레포마다 git 을 부른다 — args 안의 '{paths}' 자리에 그 레포의 경로들이 들어간다. 반환: [{ top, out }]
export const gitEach = (root, rels, args, options = {}) => [...groupByRepo(root, rels)].map(([top, paths]) => ({
  top,
  out: execFileSync('git', ['-C', top, ...args.flatMap((arg) => (arg === '{paths}' ? paths : [arg]))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(),
}))
