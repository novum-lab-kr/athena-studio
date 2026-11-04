// 새 팩 창 자리 — Electron 은 x · y 를 주지 않으면 창마다 화면 가운데에 띄워, 같은 크기의 팩 창이 정확히 겹친다.
// 맥 기본 계단식처럼 기준 창(앞에 있던 창)에서 오른쪽 아래로 한 칸씩 비켜 띄운다. 크기는 정하지 않는다(main/pack-window.mts)

export type Rect = { x: number; y: number; width: number; height: number }
export type Point = { x: number; y: number }

export const CASCADE_STEP = 28 // 한 칸 — 맥 제목 줄 높이쯤

// reference: 기준 창 · taken: 이미 열린 창들(기준 창 포함) · area: 기준 창이 있는 화면의 작업 영역 · size: 새 창 크기
// 돌려줌: 새 창 왼쪽 위. 열린 창이 없으면 null — 지금처럼 가운데에 띄운다
export function cascadePosition(reference: Rect | null, taken: Rect[], area: Rect, size: { width: number; height: number }): Point | null {
  if (!reference) return null
  // 창이 작업 영역 안에 다 들어가는 가장 먼 왼쪽 위 — 넘으면 작업 영역 왼쪽 위로 돌아간다
  const maxX = Math.max(area.x, area.x + area.width - size.width)
  const maxY = Math.max(area.y, area.y + area.height - size.height)
  const occupied = (spot: Point) => taken.some((rect) => rect.x === spot.x && rect.y === spot.y)
  let spot: Point = { x: reference.x, y: reference.y }
  for (let tries = 0; tries <= taken.length; tries++) {
    spot = { x: spot.x + CASCADE_STEP, y: spot.y + CASCADE_STEP }
    if (spot.x > maxX || spot.y > maxY) spot = { x: area.x, y: area.y }
    if (!occupied(spot)) return spot
  }
  // 화면이 좁아 작업 영역 안에 빈자리가 없다 — 기준 창에서 한 칸씩 더 가며 빈자리를 찾는다(아래 · 오른쪽이 조금 넘쳐도 맥은 그대로 둔다).
  // 열린 창이 n 개면 n + 1 칸 안에 반드시 빈자리가 있다
  for (let steps = 1; ; steps++) {
    spot = { x: reference.x + CASCADE_STEP * steps, y: reference.y + CASCADE_STEP * steps }
    if (!occupied(spot)) return spot
  }
}
