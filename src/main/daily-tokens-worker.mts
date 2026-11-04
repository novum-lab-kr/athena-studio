// 메뉴 막대 패널의 최근 7일 토큰 — 대화 기록 읽기를 메인 프로세스 밖(워커 스레드)에서.
// 처음 한 번은 7일치를 다 읽어 오래 걸린다(4GB 남짓에 십몇 초 — 2026-11-04 실측). 그 뒤로는 1분마다 늘어난 부분만 읽고 날짜별 합을 보낸다
import { parentPort, workerData } from 'node:worker_threads'
import { DailyTokens, lastDays, startOfDay } from '../lib/daily-tokens.mts'

const SCAN_MS = 60000
const { claudeDir, codexDir } = workerData as { claudeDir: string | null; codexDir: string | null }
const tally = new DailyTokens()

async function scanLoop(): Promise<void> {
  const days = lastDays(Date.now())
  try {
    await tally.scan({ claudeDir, codexDir, since: startOfDay(days[0] ?? '') })
    parentPort?.postMessage({ at: Date.now(), days: tally.totals(days) })
  } catch {
    // 못 읽은 번은 건너뛴다 — 다음 번에 다시
  }
  setTimeout(scanLoop, SCAN_MS)
}

scanLoop()
