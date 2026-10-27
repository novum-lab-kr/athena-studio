// 메뉴 막대 아이콘에 빨간 점 — 템플릿 아이콘은 맥이 흑백으로만 칠해 색을 못 쓴다.
// 그래서 막힘이 있을 때만 로고 비트맵(BGRA)을 메뉴 막대 색(흰색 · 검정)으로 칠하고 오른쪽 아래에 빨간 점을 그린 새 비트맵을 만든다

// [r, g, b] — 0~255
export type Rgb = readonly [number, number, number]

export const RED: Rgb = [255, 59, 48] // 맥 시스템 빨강

// bgra: Buffer(가로×세로×4, B·G·R·A · premultiplied) · tint: [r, g, b] 로고 색 · 돌려줌: 새 Buffer
export function badgeBitmap(bgra: Buffer, width: number, height: number, tint: Rgb): Buffer {
  const out = Buffer.from(bgra)
  // 로고는 알파만 남기고 tint 로 — Electron 비트맵은 premultiplied alpha 라 색에 알파를 곱한다(투명이면 0)
  for (let offset = 0; offset < out.length; offset += 4) {
    const alpha = (out[offset + 3] ?? 0) / 255
    out[offset] = Math.round(tint[2] * alpha)
    out[offset + 1] = Math.round(tint[1] * alpha)
    out[offset + 2] = Math.round(tint[0] * alpha)
  }
  // 오른쪽 아래 점 — 지름은 아이콘의 약 40%, 둘레 1px 은 비워 로고와 떨어져 보이게
  const radius = Math.max(2, Math.round(width * 0.2))
  const centerX = width - radius - 0.5
  const centerY = height - radius - 0.5
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const distance = Math.hypot(col - centerX, row - centerY)
      if (distance > radius + 1) continue
      const offset = (row * width + col) * 4
      if (distance > radius) {
        out.fill(0, offset, offset + 4)
        continue
      }
      out[offset] = RED[2]
      out[offset + 1] = RED[1]
      out[offset + 2] = RED[0]
      out[offset + 3] = 255
    }
  }
  return out
}
