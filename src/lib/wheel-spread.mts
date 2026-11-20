// ── 폰 휠 묶음 나눠 넣기 — 판정 · 일정 계산(Electron 없이 시험 · test/wheel-spread.test.js) ──
// 폰 앱은 프로그램이 화면을 쥔 pane(Claude Code fullscreen 등)에 손가락 쓸기를 휠 보고 · 화살표 반복으로 바꿔
// 길마다 간격(직접 50ms · relay 120ms — athena-app wheel.ts WHEEL_SEND_GAP_MS · RELAY_WHEEL_SEND_GAP_MS)마다 한 msg 로 묶어 보낸다(최대 32번).
// 한꺼번에 PTY 에 쓰면 Claude 는 한 번만 그린다 — 8번을 한꺼번에 = 그림 1번 · 6ms 간격 = 4~5번 · 15ms 간격 = 8번(2026-11-20 진짜 Claude Code 2.1.329 가짜 터미널 실측).
// 그래서 맥 브리지가 같은 휠 · 화살표 반복으로만 된 입력을 하나씩 쪼개 다음 msg 가 올 간격 안에 고르게 넣는다.

// 휠 한 번 — SGR(`ESC[<64;열;줄M` · 픽셀 모양도 같은 글) · 옛 모양(`ESC[M` + 단추 64/65+32 + 칸 두 글자) · 화살표(일반 · 응용 커서)
const UNIT_PATTERNS = [/^\x1b\[<6[45];\d+;\d+M/, /^\x1b\[M[\x60\x61][\x21-\x7e]{2}/, /^\x1b(?:\[|O)[AB]/]

// 같은 휠 · 화살표가 두 번 이상 되풀이된 입력이면 한 번씩 나눈 목록 · 아니면 null(그대로 한 번에 쓴다)
export function splitWheel(data: string): string[] | null {
  for (const pattern of UNIT_PATTERNS) {
    const found = pattern.exec(data)
    if (!found) continue
    const unit = found[0]
    if (data.length < unit.length * 2 || data.length % unit.length !== 0) return null
    const count = data.length / unit.length
    return unit.repeat(count) === data ? Array.from({ length: count }, () => unit) : null
  }
  return null
}

// count 개를 windowMs 안에 고르게 — 첫 것은 바로(0) · 마지막은 다음 msg 가 오기 전(windowMs 보다 앞)
export function spreadOffsets(count: number, windowMs: number): number[] {
  return Array.from({ length: count }, (_unused, index) => (index * windowMs) / count)
}
