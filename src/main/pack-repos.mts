// ── 팩 레포 — 팩 창 ───────────────────────────────────────
// main.js createPackWindow 에서 옮겼다(PR3f) — 화면 문구(say) · 코어 팩 명령(runPack) · 데몬 자리(daemonPaths)는 인자로 받고,
// ctx 에 같은 이름(packRepos · mergeSettings · setAutoMerge · studioEnv · callInfo · callStart)으로 붙인다.
// spaces 에 에이전트 없는 레포도 흐리게 · 누르면 아테나에게 /call
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import * as core from '../lib/core.mts'
import * as packModel from '../lib/pack.mts'
import { CLI } from '../daemon-client.mts'
import { packIconFile } from './files.mts'
import type { PackResult, Say } from '../lib/pack.mts'
import type { RunCoreOptions } from './core-runner.mts'

// pack.json repos[] 의 한 줄 — 읽는 칸만(모양은 이름만 본다 — 옛 main.js 와 같다)
type PackJsonRepo = Parameters<typeof packModel.repoLook>[0] & { name: string }
export type PackRepo = { name: string; agent: string | null; linked: boolean; displayName: string | null; iconPath: string | null; iconUpdatedAt: string | null }
type ScriptRun = { ok: boolean; stdout: string; stderr: string; code: number | string | null | undefined }
type RunPack = (args: string[], options: RunCoreOptions) => Promise<PackResult>

// 팩 창 문맥(main.mts createPackWindow) 중 팩 레포가 읽는 것 · 붙이는 것
export type PackReposCtx = {
  athenaDir: string | null
  packRepos?: () => Promise<PackRepo[]>
  mergeSettings?: unknown
  setAutoMerge?: unknown
  studioEnv?: () => Record<string, string>
  callInfo?: (name: string) => Promise<{ error: string } | ({ agent: string; repo: string } & ReturnType<typeof packModel.parseCallInfo>)>
  callStart?: unknown
}

type PackReposDeps = { say: Say; runPack: RunPack; daemonPaths: () => { socket: string } }

export function installPackRepos(ctx: PackReposCtx, { say, runPack, daemonPaths }: PackReposDeps): void {
  // 레포 목록은 이 본체 팩의 pack.json(여러 팩이면 pack 링크) · 이어졌는지는 본체 repos/<이름> 이 git 레포인지.
  // 표시 이름 · 아이콘(pack set-repo-name · set-repo-icon)도 — 사이드바만 쓴다. 아이콘은 팩 안의 일반 파일일 때만(링크 · 밖이면 null)
  ctx.packRepos = async () => {
    const packDir = path.join(ctx.athenaDir || '', 'pack')
    const pack: { repos?: unknown } | null = await fs.promises.readFile(path.join(packDir, 'pack.json'), 'utf8').then(JSON.parse, () => null)
    if (!pack || !Array.isArray(pack.repos)) return []
    const listed: (PackJsonRepo | null)[] = pack.repos
    const repos = listed.filter((repo): repo is PackJsonRepo => Boolean(repo) && /^[\w.-]+$/.test(String((repo as PackJsonRepo).name || '')))
    return Promise.all(repos.map(async (repo) => {
      const look = packModel.repoLook(repo)
      const icon = look.icon ? await packIconFile(packDir, look.icon) : null
      return {
        name: repo.name,
        agent: packModel.repoAgent(repo),
        linked: fs.existsSync(path.join(ctx.athenaDir as string, 'repos', repo.name, '.git')),
        displayName: look.displayName,
        iconPath: icon ? icon.path : null,
        iconUpdatedAt: icon ? icon.updatedAt : null,
      }
    }))
  }
  // ⚙ 설정 — 이 창 본체 팩의 레포별 자동 머지. 읽기는 pack.json 을 바로(packRepos 와 같은 자리), 쓰기는 코어 명령(pack set-auto-merge)으로만.
  // 현황판 · pr-auto 는 확인할 때마다 pack.json 을 새로 읽으므로 따로 알리지 않는다
  ctx.mergeSettings = async () => {
    // 읽기 실패 · 망가진 JSON 모두 null — 팝업이 '읽지 못했어요' 를 보이게(then 의 두 번째 인자는 JSON.parse 오류를 못 잡는다)
    const pack: { repos?: unknown } | null = await fs.promises.readFile(path.join(ctx.athenaDir || '', 'pack', 'pack.json'), 'utf8').then(JSON.parse).catch(() => null)
    return { ok: Boolean(pack), repos: packModel.mergeSettings(pack) }
  }
  ctx.setAutoMerge = async (repo: string, { auto, review, merge }: { auto?: unknown; review?: unknown; merge?: unknown }) => {
    if (!/^[\w.-]+$/.test(repo)) return { ok: false, error: 'not-found', text: packModel.packErrorText({ ok: false, error: 'not-found' }, say) }
    const args = ['set-auto-merge', repo]
    if (auto === 'on' || auto === 'off' || auto === 'direct') args.push('--auto', auto)
    if (typeof review === 'boolean') args.push('--review', review ? 'on' : 'off')
    if (typeof merge === 'string') args.push('--merge', merge)
    const result = await runPack(args, { dir: ctx.athenaDir })
    if (!result.ok) return { ...result, text: packModel.packErrorText(result, say) }
    return result
  }
  // 데몬 접속 값 — 본체 스크립트(delegate.sh)가 화면 계층으로 pane 을 띄울 때(현황판과 같은 값 + studio · pane 안 표시)
  ctx.studioEnv = () => {
    const paths = daemonPaths()
    return { ATHENA_SCREEN: 'studio', ATHENA_STUDIO: '1', ATHENA_STUDIO_SOCKET: paths.socket, ATHENA_STUDIO_CLI: CLI, ATHENA_STUDIO_NODE: process.execPath, ATHENA_STUDIO_BODY: core.realDir(ctx.athenaDir as string) }
  }
  // 본체 스크립트 하나 — 셸을 거치지 않고 인자로만
  const runBodyScript = (script: string, args: string[], { studioEnv = false, timeout = 120000 }: { studioEnv?: boolean; timeout?: number } = {}) => new Promise<ScriptRun>((resolve) => {
    const env = core.childEnv(process.env, studioEnv ? (ctx.studioEnv as NonNullable<PackReposCtx['studioEnv']>)() : {})
    execFile('bash', [path.join(ctx.athenaDir as string, 'scripts', script), ...args], { cwd: ctx.athenaDir as string, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', code: error ? error.code : 0 }),
    )
  })
  // 레포 에이전트 부르기 1 — 브랜치 정보(scripts/call-branch-info.sh — /call 스킬과 같은 것): 메인 체크아웃 상태 · 최근 작업 브랜치 · main 직접이면 그 자리
  ctx.callInfo = async (name: string) => {
    const repo = (await (ctx.packRepos as NonNullable<PackReposCtx['packRepos']>)()).find((item) => item.name === name)
    if (!repo || !repo.agent) return { error: say('spaces.callNoAgent', { repo: name }) }
    const run = await runBodyScript('call-branch-info.sh', [repo.agent])
    if (!run.ok) return { error: (run.stderr || run.stdout).trim().slice(-300) || say('spaces.callFailed') }
    return { agent: repo.agent, repo: name, ...packModel.parseCallInfo(run.stdout) }
  }
  // 레포 에이전트 부르기 2 — 고른 브랜치로 워크트리(new-branch.sh · 이어 쓰기면 --reuse) → 그 자리에 에이전트 pane(delegate.sh · 빈 지시 경량 계획서)
  ctx.callStart = async (name: string, { branch = '', reuse = false }: { branch?: string; reuse?: boolean } = {}) => {
    const info = await (ctx.callInfo as NonNullable<PackReposCtx['callInfo']>)(name)
    if ('error' in info) return info
    let worktree = info.direct || ''
    if (!worktree) {
      if (!packModel.validBranchInput(branch)) return { error: say('spaces.callBadBranch') }
      const made = await runBodyScript('new-branch.sh', [branch, info.target, ...(reuse ? ['--reuse'] : [])])
      const parsed = packModel.parseNewBranch(made.stdout)
      if (parsed.exists) return { exists: true, branch, message: parsed.message }
      if (!parsed.worktree) return { error: (parsed.message || made.stderr || made.stdout).trim().slice(-300) || say('spaces.callFailed') }
      worktree = parsed.worktree
    }
    const run = await runBodyScript('delegate.sh', [info.agent, '--cwd', worktree, '--plan', 'new', say('spaces.callPlanTitle', { agent: info.agent })], { studioEnv: true })
    if (!run.ok) return { error: (run.stdout + run.stderr).trim().slice(-300) || say('spaces.callFailed') }
    const pane = (run.stdout.match(/^(\S+)\s+\(/m) || [])[1] || null
    return { ok: true, agent: info.agent, pane, worktree, branch: info.direct ? null : branch }
  }
}
