// ── 팩 본체 따라잡기 — 팩 창 ──
// main.js 에서 옮겼다(PR3e) — createPackWindow 의 ctx 에 같은 이름으로 붙인다(installCatchUp). 데몬 요청은 ctx.daemonCall(daemon-link) 로.
// 쓰는 것(스튜디오 집 자리 · 팩 명령 · 팩 로그 자리)은 인자로 받는다
import fs from 'node:fs'
import path from 'node:path'
import * as core from '../lib/core.mts'
import { runGit } from './files.mts'
import type { DaemonPane, PackCtx } from './daemon-link.mts'

// 코어 pack busy · open 결과 — 읽는 칸만
type PackReply = { ok?: boolean; busyKnown?: boolean; busy?: { kind?: string }[]; updated?: unknown; error?: string }
type RunPack = (args: string[], options: { dir: string | null }) => Promise<PackReply>

// studio — 스튜디오 집 자리(주 본체 · 레지스트리) · runPack — 팩 명령(pack busy · open) · packLogFile — 팩 로그 자리
export function installCatchUp(ctx: PackCtx, { studio, runPack, packLogFile }: { studio: { core: string; data: string }; runPack: RunPack; packLogFile: () => string }): void {
  const send = ctx.send
  const daemonCall = ctx.daemonCall

  // 팩 본체가 주 본체 코어보다 뒤처졌으면 따라잡는다 — 앱 업데이트는 일하는 본체를 건너뛰고, 그 뒤에는 앱이 새 번들을 들고 오지 않는 한 다시 하지 않는다.
  // 30초에 한 번 HEAD 둘만 본다. 뒤처졌을 때: 본체 안 에이전트(워크트리)가 있거나 아테나가 일하는 중이면 기다린다.
  // 아테나가 쉬는 중이면 그 대화를 기억하고 잠깐 끄고(/exit) → pack open(본체 따라잡기) → 같은 대화로 다시 켠다(claude --resume) — 사용자가 손댈 일 없게
  let catchUpAt = 0
  let catchUpBackoff = 0 // 해 봤는데 못 옮겼으면 10분 쉰다 — 아테나를 30초마다 껐다 켜지 않게
  let catchingUp = false
  // 코어가 보는 바쁨(pack busy — 본체 · 레포 · 워크트리 안 claude · codex · 무거운 명령 …) — 코어가 옮길지 말지를 이걸로 정한다
  const coreBusy = async () => {
    const result = await runPack(['busy'], { dir: ctx.athenaDir })
    return result.ok && result.busyKnown !== false ? result.busy || [] : null
  }
  // force — 사용자가 고른 일(레포 더하기 · 빼기)이 새 코어 명령을 써야 할 때: 30초 · 10분 쉬기를 건너뛴다(나머지 안전 검사는 그대로).
  // 돌려주는 것: { ok, same } 이미 같음 · { ok:false, reason } working(누가 일하는 중 · 질문 창 · 쓰다 만 글) | unknown-session | still-busy | failed
  ctx.catchUpBody = async (panes: DaemonPane[] | null, { force = false }: { force?: boolean } = {}) => {
    // 자동 따라잡기가 도는 중이면 — 사용자가 고른 일은 끝날 때까지(최대 1분) 기다렸다 다시 본다(이미 옮겼으면 same)
    for (let tries = 0; force && catchingUp && tries < 60; tries += 1) await new Promise((resolve) => setTimeout(resolve, 1000))
    if (catchingUp) return { ok: false, reason: 'working' }
    if (!force && (!panes || Date.now() - catchUpAt < 30000 || Date.now() < catchUpBackoff)) return null
    if (!force) catchUpAt = Date.now()
    if (!panes) return { ok: false, reason: 'failed' }
    const body = ctx.athenaDir
    const packId = ctx.packState.current && ctx.packState.current.id
    if (!body || !packId || (!force && ctx.packBusy) || core.sameDir(body, studio.core) || !fs.existsSync(path.join(body, '.pack-data'))) return { ok: true, same: true }
    // 기준은 코어와 같다(bodies.mjs catchUpBody) — 레지스트리 deploy.commit 이 이 본체 커밋의 후손일 때만(주 본체 HEAD 가 아니다 · 정비 커밋으로 앞서도 옮기지 않는다)
    const registry: { deploy?: { commit?: string } } | null = await fs.promises.readFile(path.join(studio.data, 'config.json'), 'utf8').then(JSON.parse, () => null)
    const target = registry && registry.deploy && registry.deploy.commit
    const mine = ((await runGit(body, ['rev-parse', 'HEAD'])) || '').trim()
    if (!target || !mine || mine === target) return { ok: true, same: true }
    if ((await runGit(studio.core, ['merge-base', '--is-ancestor', mine, target])) === null) return { ok: true, same: true }
    const realBody = core.realDir(body)
    const packData = core.realDir(path.join(body, '.pack-data'))
    const under = (dir: string | undefined, root: string) => Boolean(dir) && core.isInside(core.realDir(dir as string), root)
    const inBody = panes.filter((pane) => pane.agent && (under(pane.foreground_cwd || pane.cwd, realBody) || under(pane.foreground_cwd || pane.cwd, packData)))
    const athenaPanes = inBody.filter((pane) => under(pane.foreground_cwd || pane.cwd, realBody))
    // force(사용자가 고른 일) — 일하는 중이어도 이 팩의 에이전트를 모두 멈추고 옮긴다(화면이 미리 알린다). 아래 기다리기 검사는 건너뛴다
    // 워크트리 에이전트가 있거나 · 누가 일하는 중이거나 · claude 가 아니면(되살릴 수 없다) 다음에
    if (!force && (inBody.length !== athenaPanes.length || athenaPanes.some((pane) => pane.agent !== 'claude' || pane.agent_status !== 'idle'))) return { ok: false, reason: 'working' }
    // 화면으로도 — 질문 · 고르기 창이 떠 있거나 쓰다 만 글이 있으면 건드리지 않는다
    for (const pane of force ? [] : athenaPanes) {
      const read = await daemonCall<{ text?: unknown }>('pane read', { pane: pane.id, lines: 40 })
      if (!read.result || !core.claudeAtEmptyPrompt(read.result.text)) return { ok: false, reason: 'working' }
    }
    // 코어 기준으로도 아테나 말고 바쁜 것이 없어야 시작한다(레포 · 워크트리 에이전트 · 무거운 명령)
    const before = await coreBusy()
    if (!force && (!before || before.some((item) => item.kind !== 'athena'))) return { ok: false, reason: 'working' }
    const sessions: { pane: string; session: string | null }[] = []
    for (const pane of force ? inBody : athenaPanes) {
      const record: { session?: string } | null = await fs.promises.readFile(path.join(packData, 'state', 'pane-sessions', `${pane.id}.json`), 'utf8').then(JSON.parse, () => null)
      // 어느 대화인지 모르면 끄지 않는다 — force 면 끄고 다시 켜지는 않는다
      if (!record || !record.session) {
        if (!force) return { ok: false, reason: 'unknown-session' }
        sessions.push({ pane: pane.id, session: null })
      } else sessions.push({ pane: pane.id, session: record.session })
    }
    catchingUp = true
    try {
      for (const item of sessions) {
        if (force) {
          // 일하는 중이면 /exit 가 줄만 선다 — 멈추고(Esc) 입력 창을 비우고(C-c) 끈다(C-c 두 번)
          await daemonCall('pane send-keys', { pane: item.pane, keys: ['Escape'] })
          await new Promise((resolve) => setTimeout(resolve, 300))
          await daemonCall('pane send-keys', { pane: item.pane, keys: ['C-c'] })
          await new Promise((resolve) => setTimeout(resolve, 300))
          await daemonCall('pane send-keys', { pane: item.pane, keys: ['C-c'] })
          continue
        }
        await daemonCall('pane send-text', { pane: item.pane, text: '/exit' })
        await daemonCall('pane send-keys', { pane: item.pane, keys: ['Enter'] })
      }
      // 코어가 보기에 다 끝날 때까지(최대 30초) — pane 은 셸로 돌아와도 claude 의 딸린 프로세스가 잠깐 남는다(2026-10-23 실측)
      let quiet = false
      for (let tries = 0; tries < 30; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const busy = await coreBusy()
        if (busy && !busy.length) {
          quiet = true
          break
        }
      }
      const opened: PackReply = quiet ? await runPack(['open', packId], { dir: studio.core }) : { ok: false, error: 'still-busy' }
      if (!opened.ok || !opened.updated) catchUpBackoff = Date.now() + 10 * 60000
      fs.appendFile(packLogFile(), `\n── ${new Date().toISOString()} catch-up ${packId} ${JSON.stringify({ ok: opened.ok, updated: opened.updated || null, error: opened.error || null })}\n`, () => {})
      for (const item of sessions) if (item.session) await daemonCall('pane run', { pane: item.pane, text: core.resumeCommand(item.session) })
      if (opened.ok && opened.updated) send('pack:caught-up', { pack: (ctx.packState.current as { displayName?: string; name?: string }).displayName || (ctx.packState.current as { name?: string }).name || packId })
      return opened.ok && opened.updated ? { ok: true } : { ok: false, reason: opened.error === 'still-busy' ? 'still-busy' : 'failed' }
    } finally {
      catchingUp = false
    }
  }
}
