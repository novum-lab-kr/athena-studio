// code-mode의 작업 종류·원문 값·개수를 화면 언어로 조합한다. 원문 값은 번역하지 않는다.
export type ExecSummary = { kind: 'command' | 'image' | 'patch' | 'tool' | 'provided'; value: string; count: number }
type Say = (key: string, values?: Record<string, string | number>) => string

export function isExecSummary(value: unknown): value is ExecSummary {
  if (!value || typeof value !== 'object') return false
  const summary = value as Record<string, unknown>
  return ['command', 'image', 'patch', 'tool', 'provided'].includes(String(summary.kind)) &&
    typeof summary.value === 'string' && typeof summary.count === 'number' && Number.isInteger(summary.count) && summary.count > 0
}

export function execSummaryText(say: Say, summary: ExecSummary): string {
  if (summary.kind === 'provided') return summary.value
  let label: string
  switch (summary.kind) {
    case 'command': label = say('monitor.exec.command'); break
    case 'image': label = say('monitor.exec.image'); break
    case 'patch': label = say('monitor.exec.patch'); break
    case 'tool': label = say('monitor.exec.tool'); break
  }
  const text = summary.value ? `${label} · ${summary.value}` : label
  return summary.count > 1 ? say('monitor.exec.more', { text, n: summary.count - 1 }) : text
}
