// 닫히는 pane 을 알아볼 수 있게 — 옛 버전 안내 창(화면 pack-dialogs.ts showOldPanes)에 보여 줄 줄
import { paneRow } from './space-names.mts'

// 데몬 pane list 에서 읽는 칸만
type ListedPane = { id: string; label?: string | null; title?: string | null; agent?: string | null; cwd?: string | null; foreground_cwd?: string | null }
export type OldPaneRow = { name: string; who: string; folder: string; tip: string }
export type OldPanesView = { total: number; rows: OldPaneRow[]; more: number }

const SHOWN_LIMIT = 8

const shortFolder = (folder: string, home: string): string => (home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder)

// 안내할 것이 있을 때만 화면 값 — 닫을 pane 이 진짜 0개이거나 목록을 읽지 못했으면 null(못 읽은 것을 0개로 치지 않는다)
export async function oldPanesNotice(listPanes: () => Promise<unknown>, home: string): Promise<OldPanesView | null> {
  const listed = await listPanes().catch(() => null)
  const panes = (listed as { panes?: unknown } | null)?.panes
  return Array.isArray(panes) && panes.length ? oldPanesView(panes as ListedPane[], home) : null
}

// 에이전트가 도는 pane 을 앞에 — 많아서 잘려도 꺼지면 아쉬운 것이 먼저 보이게
export function oldPanesView(panes: ListedPane[], home: string, limit: number = SHOWN_LIMIT): OldPanesView {
  const ordered = [...panes.filter((pane) => pane.agent), ...panes.filter((pane) => !pane.agent)]
  const rows = ordered.slice(0, limit).map((pane) => {
    const row = paneRow(pane)
    const folder = pane.foreground_cwd || pane.cwd || ''
    return { name: row.branch, who: row.role || pane.agent || '', folder: shortFolder(folder, home), tip: [row.tip, folder].filter(Boolean).join('\n') }
  })
  return { total: panes.length, rows, more: Math.max(0, panes.length - limit) }
}
