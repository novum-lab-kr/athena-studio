// ── 에이전트 모니터 — 팩 창 ──
// main.js 에서 옮겼다(PR3e) — createPackWindow 의 ctx 에 같은 이름으로 붙인다(installAgentMonitor).
// 모니터 상태(monitor — main.mts 가 만들어 팩을 바꿀 때 비운다)와 기록 찾기(findMonitorLogs)는 인자로 받는다
import { MONITOR_MINUTES, MONITOR_KEEP, readNewLines, tailEvents, readSubagentMeta, openTail, monitorSessions } from './monitor-logs.mts'
import type { FoundLog, Monitor, MonitorEvent } from './monitor-logs.mts'
import type { PackCtx } from './daemon-link.mts'
import { fetchBoardJson } from './board.mts'
import { githubIssueEvents } from '../lib/agent-feed.mts'

// 일감 GitHub 이슈 감시가 아테나에 맡긴 것을 읽는 간격 — 일감은 5분마다 확인하니 15초면 넉넉하다
const GITHUB_EVERY_MS = 15000

type FindMonitorLogs = (monitor: Monitor, allSessions: boolean, athenaDir: string | null) => Promise<FoundLog[]>

// monitor — 이 창의 모니터 상태(newMonitor) · findMonitorLogs — 대화 기록 찾기(monitor-logs createMonitorLogs)
export function installAgentMonitor(ctx: PackCtx, { monitor, findMonitorLogs }: { monitor: Monitor; findMonitorLogs: FindMonitorLogs }): void {
  const send = ctx.send

  async function monitorTick() {
    // 창이 숨었으면(메뉴 막대로 내려감) 기록을 읽지 않는다
    if (!monitor.watching || monitor.ticking || !ctx.win || ctx.win.isDestroyed() || !ctx.win.isVisible()) return
    monitor.ticking = true
    try {
      const fresh: MonitorEvent[] = []
      let changed = false
      // 10초마다 새 세션을 찾고, 120분 넘게 조용한 세션은 뺀다
      if (Date.now() - monitor.lastScan > 10000) {
        monitor.lastScan = Date.now()
        const allSessions = Date.now() - monitor.lastFullScan > 60000
        if (allSessions) monitor.lastFullScan = Date.now()
        const found = await findMonitorLogs(monitor, allSessions, ctx.athenaDir)
        for (const item of found) {
          if (monitor.tails.has(item.file)) continue
          fresh.push(...(await openTail(monitor, item)))
          changed = true
        }
        for (const tail of monitor.tails.values()) {
          const before = tail.finished
          await readSubagentMeta(tail)
          if (tail.finished !== before) changed = true
        }
        const since = Date.now() - MONITOR_MINUTES * 60000
        for (const [file, tail] of monitor.tails) {
          if (tail.mtime < since) {
            monitor.tails.delete(file)
            changed = true
          }
        }
      }
      // GitHub 이슈 — 일감(이 창의 본체)이 가져와 아테나에 맡긴 것을 한 줄씩(처음 본 것만 · 일감이 꺼져 있으면 건너뛴다)
      if (Date.now() - monitor.lastGithub > GITHUB_EVERY_MS) {
        monitor.lastGithub = Date.now()
        const reply = (await fetchBoardJson(ctx.boardPortNow(), '/api/github-issues')) as { issues?: unknown } | null
        const since = Math.max(Date.now() - MONITOR_MINUTES * 60000, monitor.floor)
        for (const event of githubIssueEvents(reply?.issues, monitor.githubSeen, since)) fresh.push({ id: ++monitor.seq, session: 'github', ...event })
      }
      for (const tail of monitor.tails.values()) {
        // 한 파일이 사라지거나 못 읽어도 다른 세션은 계속
        try {
          fresh.push(...tailEvents(monitor, tail, await readNewLines(tail)))
        } catch {}
      }
      const events = fresh.sort((left, right) => String(left.at).localeCompare(String(right.at)))
      if (events.length) {
        monitor.events = [...monitor.events, ...events].sort((left, right) => String(left.at).localeCompare(String(right.at)) || left.id - right.id).slice(-MONITOR_KEEP)
        changed = true
      }
      if (changed) send('monitor:update', { sessions: monitorSessions(monitor), events })
    } catch (error) {
      send('monitor:update', { sessions: monitorSessions(monitor), events: [], error: (error as Error).message })
    } finally {
      monitor.ticking = false
    }
  }

  ctx.setMonitorWatch = (on: unknown) => {
    monitor.watching = Boolean(on)
    clearInterval(monitor.timer as NodeJS.Timeout)
    if (!monitor.watching) return
    monitor.lastScan = 0
    monitor.lastFullScan = 0
    // 다시 보이면 지금까지 모은 것을 한 번에 보내고 이어서 따라간다
    send('monitor:update', { reset: true, sessions: monitorSessions(monitor), events: monitor.events })
    monitorTick()
    monitor.timer = setInterval(monitorTick, 1000)
  }
}
