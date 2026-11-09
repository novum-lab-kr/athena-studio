// @ts-check
/**
 * 현황판 — 끝난 작업의 워크트리 정리 한 곳(server.mjs 가 쓴다 — 이슈 [아카이브] · 이슈 지우기 · 계획서 자동 완료 · 자동 보관).
 *
 * 2026-11-02 — 팩 워크트리가 ~170개(74GB) 쌓였다. 이슈에서 시작한 작업만 정리하고 대화 · /call 로 시작한 계획서는 자동 완료돼도 남았다.
 * 그래서 계획서 Work ref 의 워크트리도 같은 함수로 판정해 지운다. 하나라도 안 맞으면 지우지 않고 이유를 돌려준다.
 *
 * 판정(계획서 — requireMerged · panes 를 넘길 때):
 *   1. 메인 체크아웃 · main 직접 레포("direct": true) · 워크트리 자리(roots) 밖은 지우지 않는다
 *   2. 미커밋 변경 · 추적 안 된 파일이 없다
 *   3. 그 폴더를 cwd · foreground_cwd 로 쓰는 pane 이 없다(화면 목록을 못 읽으면 모르니 지우지 않는다)
 *   4. 브랜치 변경이 prBase 에 반영됐다 — 머지된 PR 의 head 가 지금 HEAD 이거나 · git cherry origin/<prBase> HEAD 에 + 가 없거나 ·
 *      (squash) 브랜치가 바꾼 파일의 내용이 origin/<prBase> 와 같다
 *   5. push 안 된 커밋이 없다 — 단 4 를 내용(cherry · 파일 비교)으로 확인했으면 그 커밋 내용은 이미 원격 prBase 에 있으니 남겨도 지운다
 *      (PR 끔 바로 머지는 작업 브랜치를 push 하지 않고 squash 커밋만 prBase 에 올린다 — scripts/pr-auto.mjs directMerge)
 * 이슈 워크트리(옛 판정 그대로)는 2 · 5 만 본다.
 * 지우기는 git worktree remove(강제 아님) → 빈 폴더만 남았으면 지움 → git worktree prune. 브랜치는 지우지 않는다.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { basename, dirname, sep } from 'node:path'

/** @param {string} dir @param {string[]} args @param {number} [timeout] @returns {Promise<string | null>} 실패(0 이 아닌 종료)면 null */
const git = (dir, args, timeout = 15_000) =>
  new Promise((resolve) => {
    // 서버는 입력을 받을 수 없다 — 암호를 묻다 멈추지 않게 비대화형으로
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' }
    execFile('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env }, (error, stdout) => resolve(error ? null : stdout))
  })

/** @param {string} path */
const realOf = (path) => {
  try { return realpathSync(path) } catch { return path }
}
/** @param {string} child @param {string} parent */
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

/** 계획서 Work ref 줄들 → 맨 앞이 절대 경로인 것(워크트리 후보 · delegate.sh 가 cwd 로 읽는 자리와 같다) — 겹치면 하나
 * @param {string} workRefs planRefs().workRefs(줄바꿈으로 이은 것) @returns {string[]} */
export const worktreePathsOf = (workRefs) => [...new Set(workRefs.split('\n').map((line) => line.trim().match(/^(\S+)/)?.[1] ?? '').filter((path) => path.startsWith('/')))]

/** 브랜치 변경이 origin/<prBase> 에 반영됐나 — 'pr' 머지된 PR 의 head · 'content' cherry · 파일 내용 · '' 아님
 * @param {string} path @param {string} head @param {string} prBase @param {string[]} mergedHeads @returns {Promise<'pr' | 'content' | ''>} */
const mergedBy = async (path, head, prBase, mergedHeads) => {
  if (mergedHeads.includes(head)) return 'pr'
  if (!prBase) return ''
  // 원격 prBase 를 새로 받는다(Actions 머지 · 다른 맥에서 머지) — 못 받으면 있는 ref 로(옛 ref 면 반영 안 됨으로 보여 남길 뿐이다)
  await git(path, ['fetch', '--quiet', 'origin', prBase], 45_000)
  const base = `origin/${prBase}`
  if ((await git(path, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) === null) return ''
  const cherry = await git(path, ['cherry', base, 'HEAD'])
  if (cherry === null) return ''
  if (!cherry.split('\n').some((line) => line.startsWith('+'))) return 'content'
  // squash 머지 — 커밋은 달라도 브랜치가 바꾼 파일이 지금 prBase 와 같으면 반영된 것(그 뒤 prBase 가 같은 파일을 또 바꿨으면 다르게 보여 남긴다)
  const fork = (await git(path, ['merge-base', base, 'HEAD']))?.trim()
  if (!fork) return ''
  const files = (await git(path, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', fork, 'HEAD']))?.split('\n').filter(Boolean)
  if (!files?.length) return ''
  return (await git(path, ['diff', '--quiet', base, 'HEAD', '--', ...files])) === null ? '' : 'content'
}

/**
 * @typedef {{ id: string, cwd?: string | null, foreground_cwd?: string | null }} ScreenPane
 * @typedef {{ state: 'missing' } | { state: 'kept', reason: string } | { state: 'removed' }} CleanupResult
 * @param {{
 *   path: string,
 *   roots?: string[],
 *   repoOf?: (mainDir: string) => ({ prBase: string, direct: boolean } | null),
 *   requireMerged?: boolean,
 *   mergedHeads?: string[],
 *   panes?: ScreenPane[] | null,
 *   checkPanes?: boolean,
 * }} options
 *   roots — 이 안의 워크트리만(없으면 따지지 않음) · repoOf — 메인 체크아웃 → 팩 레포 설정(requireMerged 일 때 · null 이면 팩 레포 아님) ·
 *   panes — 지금 화면 pane 전부(checkPanes 일 때 · null = 못 읽음)
 * @returns {Promise<CleanupResult>}
 */
export const cleanupWorktree = async ({ path, roots, repoOf, requireMerged = false, mergedHeads = [], panes = null, checkPanes = false }) => {
  if (!existsSync(path)) return { state: 'missing' }
  const real = realOf(path)
  const dirs = (await git(path, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']))?.trim().split('\n')
  if (dirs?.length !== 2) return { state: 'kept', reason: 'git 워크트리가 아니라 지우지 않았어요' }
  const [gitDir = '', commonDir = ''] = dirs.map(realOf)
  if (gitDir === commonDir) return { state: 'kept', reason: '메인 체크아웃이라 지우지 않았어요' }
  if (roots?.length && !roots.some((root) => inside(real, realOf(root)))) return { state: 'kept', reason: '워크트리 자리 밖이라 지우지 않았어요' }
  // 메인 체크아웃 = 공통 .git 의 부모(bare 면 그 폴더) — worktree remove · prune 은 거기서
  const mainDir = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir
  let prBase = ''
  if (requireMerged) {
    const repo = repoOf?.(mainDir) ?? null
    if (!repo) return { state: 'kept', reason: '팩 레포를 찾지 못해 지우지 않았어요' }
    if (repo.direct) return { state: 'kept', reason: 'main 직접 레포라 지우지 않았어요' }
    prBase = repo.prBase
  }
  const status = await git(path, ['status', '--porcelain'])
  if (status === null) return { state: 'kept', reason: 'git 상태를 읽지 못해 지우지 않았어요' }
  if (status.split('\n').some(Boolean)) return { state: 'kept', reason: '커밋하지 않은 변경이 있어서 지우지 않았어요' }
  if (checkPanes) {
    if (!panes) return { state: 'kept', reason: '화면(pane 목록)을 읽지 못해 지우지 않았어요' }
    const user = panes.find((pane) => [pane.cwd, pane.foreground_cwd].some((cwd) => cwd && inside(realOf(cwd), real)))
    if (user) return { state: 'kept', reason: `pane ${user.id} 이 이 폴더에서 쓰는 중이라 지우지 않았어요` }
  }
  let merged = /** @type {'pr' | 'content' | ''} */ ('')
  if (requireMerged) {
    const head = (await git(path, ['rev-parse', 'HEAD']))?.trim() ?? ''
    merged = head ? await mergedBy(path, head, prBase, mergedHeads) : ''
    if (!merged) return { state: 'kept', reason: `브랜치 변경이 ${prBase || 'prBase'} 에 반영되지 않아 지우지 않았어요` }
  }
  // 에이전트가 로컬 커밋을 할 수 있으니, 원격 어디에도 없는 커밋이 있으면 지우지 않는다(내용이 prBase 에 있는 것은 빼고 — 위 5)
  const unpushed = ((await git(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])) ?? '1').trim()
  if (unpushed !== '0' && merged !== 'content') return { state: 'kept', reason: `push 하지 않은 커밋이 ${unpushed}개 있어서 지우지 않았어요` }
  if ((await git(mainDir, ['worktree', 'remove', path], 60_000)) === null) return { state: 'kept', reason: '워크트리를 지우지 못했어요 (git worktree remove 실패)' }
  // 빈 폴더 잔여물만 — 안에 무엇이 남았으면 두고 본다
  try { if (existsSync(path) && !readdirSync(path).length) rmdirSync(path) } catch { /* 남겨 둔다 */ }
  await git(mainDir, ['worktree', 'prune'])
  return { state: 'removed' }
}

/** 계획서에 남기는 한 줄 — 같은 폴더 줄이 있으면 바꾸고, 없으면 마지막 Work ref 줄 아래(없으면 Status 줄 아래)에
 * @param {string} text 계획서 @param {string} path 워크트리 @param {string} note '지움' · '남김 — <이유>' @param {string} when 시각 */
export const withCleanupLine = (text, path, note, when) => {
  const line = `- Worktree cleanup: ${path} ${note} (${when})`
  const lines = text.split('\n')
  const same = lines.findIndex((row) => row.startsWith(`- Worktree cleanup: ${path} `))
  if (same >= 0) {
    lines[same] = line
    return lines.join('\n')
  }
  let anchor = -1
  lines.forEach((row, index) => { if (row.startsWith('- Work ref:')) anchor = index })
  if (anchor < 0) anchor = lines.findIndex((row) => row.startsWith('- Status:'))
  if (anchor < 0) return text
  lines.splice(anchor + 1, 0, line)
  return lines.join('\n')
}
