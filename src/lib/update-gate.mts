// 코어 업데이트 대기 문 — 창을 먼저 열고 코어 업데이트를 뒤에서 돌릴 때, 옛 코어로 도는 일이 업데이트와 부딪히지 않게 한다.
// run(task): 업데이트를 돌리는 동안 문이 닫힌다. 성공 · 실패(예외) · 멈춤 모두 문이 다시 열린다.
//   - 끝나면(finally) 연다
//   - maxMs 가 지나도 안 끝나면 일은 그대로 두고 기다리던 쪽만 풀어 준다(창이 묶이지 않게)
// wait(): 문이 열려 있으면 바로, 닫혀 있으면 열릴 때까지 기다린다. 기다리다 실패하지 않는다(늘 resolve)
// Electron 없이 시험한다(test/update-gate.test.js)

export type UpdateGate = {
  active(): boolean
  wait(): Promise<void>
  run<T>(task: () => Promise<T>): Promise<T>
}

// onChange — 닫힘 · 열림이 바뀔 때(true = 업데이트 중) · timers — 시험에서 시계를 바꿔 끼운다
export function createUpdateGate({ maxMs = 6 * 60000, onChange = () => {}, timers = { setTimeout, clearTimeout } }: { maxMs?: number; onChange?: (running: boolean) => void; timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } } = {}): UpdateGate {
  let waiters: (() => void)[] = []
  let running = 0

  const release = () => {
    const current = waiters
    waiters = []
    for (const resolve of current) resolve()
  }

  const setRunning = (value: number) => {
    const before = running > 0
    running = value
    if (before !== running > 0) onChange(running > 0)
  }

  return {
    active: () => running > 0,
    wait: () => (running > 0 ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()),
    async run<T>(task: () => Promise<T>): Promise<T> {
      setRunning(running + 1)
      // 멈췄을 때 — 기다리던 쪽만 풀고 표시도 내린다(일 자체는 두고 끝나면 정리)
      let gaveUp = false
      const timer = timers.setTimeout(() => {
        gaveUp = true
        setRunning(Math.max(0, running - 1))
        // 다른 업데이트가 아직 돌고 있으면 문은 그대로 닫아 둔다(그쪽이 끝나거나 시간 초과될 때 푼다)
        if (running === 0) release()
      }, maxMs)
      try {
        return await task()
      } finally {
        timers.clearTimeout(timer)
        if (!gaveUp) setRunning(Math.max(0, running - 1))
        if (running === 0) release()
      }
    },
  }
}
