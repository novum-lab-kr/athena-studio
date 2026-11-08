// 실측: Codex 0.166.0 은 긴 글 직후 Enter 를 입력칸에 남기기도 한다.
// agent_status 는 입력을 다시 그리기만 해도 working 이므로 전송 확인에 쓰지 않는다.
type Snapshot = { agent: string | null; text: string; waiting?: boolean }
type Transport = { read: () => Promise<Snapshot>; write: (text: string) => void; sleep?: (ms: number) => Promise<void> }

export function inputOf({ agent, text }: Snapshot): string | null {
  const lines = text.split('\n').map((line) => line.trimEnd())
  const mark = agent === 'codex' ? '›' : agent === 'claude' ? '❯' : null
  if (!mark) return null
  const index = lines.findLastIndex((line) => line.trimStart().startsWith(mark))
  if (index < 0) return null
  const rest = lines.slice(index + 1)
  // Claude 입력칸은 가로선, Codex 입력칸은 빈 줄로 끝난다(실제 pane 전·후 화면).
  const end = rest.findIndex((line) => agent === 'claude' ? /^─{3}/.test(line) : !line.trim())
  if (end < 0) return null
  const input = [lines[index]!.trimStart().slice(1), ...rest.slice(0, end)].join('\n').trim()
  // Claude working 중 Enter 를 받으면 본문은 큐로 옮기고 빈 입력칸에 이 안내를 그린다.
  // 실제 입력과 혼동하지 않도록 큐 본문의 전송 안내도 함께 확인한다(2026-11-08 실측).
  if (agent === 'claude' && input === 'Press up to edit queued messages' &&
      lines.some((line) => line.trim() === 'ctrl+x ctrl+s to send now')) return ''
  return input
}

export async function submitText(text: string, transport: Transport): Promise<void> {
  const sleep = transport.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const before = await transport.read()
  if (!before.agent) {
    transport.write(`${text}\r`)
    return
  }
  if (before.waiting) throw Object.assign(new Error('입력을 기다리는 질문이 열려 있다'), { code: 'unavailable' })
  const baseline = inputOf(before)
  // Codex · Claude 양쪽에서 실측한 붙여넣기 경계. 빈 글은 이미 입력한 글의 전송만 확인한다.
  if (text) transport.write(`\x1b[200~${text}\x1b[201~`)
  // 글을 붙여넣는 동안의 Enter 흡수를 피한다. 300ms 간격으로 실제 Codex 전송 확인.
  await sleep(300)
  const pasted = await transport.read()
  if (pasted.waiting || pasted.agent !== before.agent) {
    throw Object.assign(new Error('입력 중 pane 상태가 바뀌었다 — 입력칸을 확인해 주세요'), { code: 'unavailable' })
  }
  const pending = inputOf(pasted)
  transport.write('\r')
  for (let attempt = 0; attempt < 3; attempt++) {
    let last: Snapshot | undefined
    for (let poll = 0; poll < 8; poll++) {
      await sleep(100)
      last = await transport.read()
      if (last.waiting) break
      const input = inputOf(last)
      // /exit 처럼 에이전트가 셸로 돌아오는 명령도 전송 완료다.
      if (!last.agent && text.trim() === '/exit') return
      if (last.agent === before.agent && input !== null && pending !== null && input !== pending &&
          (input === '' || (baseline !== null && input === baseline))) return
    }
    // 같은 입력이 남았을 때만 Enter 를 재시도한다. 질문 · 모르는 화면에는 누르지 않는다.
    if (attempt === 2 || !last || last.waiting) break
    if (pending !== null && (text === '' || pending !== baseline) && inputOf(last) === pending) transport.write('\r')
  }
  throw Object.assign(new Error('입력 전송을 확인하지 못했다 — pane 입력칸을 확인해 주세요'), { code: 'timeout' })
}
