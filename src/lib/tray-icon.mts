// 메뉴 막대 아이콘 — 부엉이 눈으로 상태를 보인다: 일하는 에이전트가 있으면 눈을 꽉 찬 초록 원으로 켜고 은은한 빛 번짐, 없으면 로고와 같은 색 눈(main 이 tint 를 넘긴다).
// 템플릿 아이콘은 맥이 흑백으로만 칠해 색을 못 쓴다. 그래서 로고 비트맵(BGRA)을 메뉴 막대 색(흰색 · 검정)으로 칠하고 눈 자리만 눈 색으로 다시 칠한 새 비트맵을 만든다

// [r, g, b] — 0~255
export type Rgb = readonly [number, number, number]

export const GREEN: Rgb = [52, 199, 89] // 맥 시스템 초록 — 일하는 에이전트 있음

// 눈 자리 — 로고 크기에 대한 비율. 로고(athena-white-*.png) 눈 고리 안쪽 회오리의 가운데 · 반지름(16 · 32px 알파 지도로 맞춤 — 바깥 고리 · 부리는 들지 않는다)
const EYES: readonly (readonly [number, number])[] = [
  [0.305, 0.39],
  [0.695, 0.39],
]
// 켠 눈 반지름 — 회오리는 빈 틈이 많아 로고 픽셀만 칠하면 16px 에서 초록이 눈마다 1px 남짓이라 안 보인다.
// 켤 때는 이 원 안을 로고 모양과 상관없이 꽉 채운다(32px 로 눈마다 약 30px · 16px 로 약 8px)
const LIT_EYE_RADIUS = 0.105
// 끈 눈(로고 색) — 로고 픽셀만 칠하니 모양은 원본 그대로
const EYE_RADIUS = 0.08
// 빛 번짐 — 눈 가운데에서 이 반지름까지 옅어지며 로고 밑(빈 픽셀)에만 깔린다
const GLOW_RADIUS = 0.17
const GLOW_ALPHA = 0.55

// bgra: Buffer(가로×세로×4, B·G·R·A · premultiplied) · tint: 로고 색 · eye: 눈 색 · glow: 켠 눈(꽉 찬 원 + 빛 번짐) · 돌려줌: 새 Buffer
export function owlBitmap(bgra: Buffer, width: number, height: number, tint: Rgb, eye: Rgb, glow: boolean): Buffer {
  const out = Buffer.from(bgra)
  const eyeRadius = EYE_RADIUS * width
  const litRadius = LIT_EYE_RADIUS * width
  const glowRadius = GLOW_RADIUS * width
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const offset = (row * width + col) * 4
      // 가장 가까운 눈 가운데까지(픽셀 가운데 기준)
      const distance = Math.min(...EYES.map(([eyeX, eyeY]) => Math.hypot(col + 0.5 - eyeX * width, row + 0.5 - eyeY * height)))
      // 로고는 알파만 남기고 색을 입힌다 — Electron 비트맵은 premultiplied alpha 라 색에 알파를 곱한다(투명이면 0)
      const logoAlpha = (out[offset + 3] ?? 0) / 255
      // 켠 눈이 덮는 정도 — 원 가장자리 한 픽셀은 반만 덮어 계단을 줄인다
      const litCover = glow ? Math.min(1, Math.max(0, litRadius - distance + 0.5)) : 0
      const logoColor = !glow && distance <= eyeRadius ? eye : tint
      // 로고 위에 켠 눈을 덮는다
      let blue = logoColor[2] * logoAlpha * (1 - litCover) + eye[2] * litCover
      let green = logoColor[1] * logoAlpha * (1 - litCover) + eye[1] * litCover
      let red = logoColor[0] * logoAlpha * (1 - litCover) + eye[0] * litCover
      let total = logoAlpha * (1 - litCover) + litCover
      // 빛 번짐은 로고 · 켠 눈 밑에 깐다(덮인 만큼 가려진다)
      if (glow && distance < glowRadius) {
        const fade = 1 - distance / glowRadius
        const glowAlpha = GLOW_ALPHA * fade * fade * (1 - total)
        blue += eye[2] * glowAlpha
        green += eye[1] * glowAlpha
        red += eye[0] * glowAlpha
        total += glowAlpha
      }
      out[offset] = Math.round(blue)
      out[offset + 1] = Math.round(green)
      out[offset + 2] = Math.round(red)
      out[offset + 3] = Math.round(total * 255)
    }
  }
  return out
}
