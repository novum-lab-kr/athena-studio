// 메뉴 막대 패널의 '일한 시간 · 3일' 그림 — 산 능선(사용자 2026-11-05 확정 시안).
// 앞 산 = 오늘(지금까지) · 바로 뒤 겹 = 어제 · 그 뒤 겹 = 그저께(하루 전체 · 같은 산 모양을 흐리게만). 높이 = 10분 칸마다 일한 시간(에이전트·분)의 30분 이동 평균,
// 세 날이 같은 기준(3일 중 가장 큰 평균이 꼭대기). 하늘은 지금 시각 하나로 — 06:00~18:00 낮(구름이 흐름) · 그 밖은 밤(별이 반짝임).
// 마우스를 올려도 아무것도 뜨지 않는다(재미로 보는 산). 숫자 · 글자는 제목 줄(tray.ts)이 맡는다.

export type ActivityDays = { today: number[]; yesterday: number[] | null; before: number[] | null }

type Point = [number, number]
type Palette = {
  skyTop: string
  skyBottom: string
  litTop: string
  litBottom: string
  shade: string
  rim: string
  grain: string
  gully: string
  snow: string
  future: string
  now: string
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const WIDTH = 285 // 패널 안쪽 폭(tray.css · 309px − 좌우 12px) — 화면에서는 폭에 맞춰 늘고 준다
const HEIGHT = 84
const SLOTS = 144
const BASE = HEIGHT - 2
const PEAK = HEIGHT - 26 // 가장 큰 값이 닿는 높이(px) — 위 하늘을 남긴다
const STEP = WIDTH / SLOTS
const HOUR_TICKS = [0, 6, 12, 18]
// 뒤 겹 — 같은 산을 공기 원근으로(멀수록 하늘색에 묻힌다) · haze = 하늘색 쪽으로 섞는 정도 · seed 는 바위 굴곡 · 눈 자리가 날마다 다르게
const BACK = { yesterday: { haze: 0.45, seed: 1000 }, before: { haze: 0.7, seed: 2000 } } as const

const PALETTE: Record<'day' | 'night', Palette> = {
  day: {
    skyTop: '#3d78bd',
    skyBottom: '#a7cdea',
    litTop: '#8b9db3',
    litBottom: '#3a4b61',
    shade: 'rgba(18,28,48,0.5)',
    rim: 'rgba(255,255,255,0.55)',
    grain: 'rgba(25,35,55,0.45)',
    gully: 'rgba(20,30,48,0.5)',
    snow: '#f5f9ff',
    future: 'rgba(20,30,45,0.12)',
    now: '#ffffff',
  },
  night: {
    skyTop: '#050817',
    skyBottom: '#17244c',
    litTop: '#2f4170',
    litBottom: '#0b1224',
    shade: 'rgba(0,0,8,0.55)',
    rim: 'rgba(150,180,255,0.55)',
    grain: 'rgba(0,0,8,0.55)',
    gully: 'rgba(0,0,10,0.6)',
    snow: '#b9c6e2',
    future: 'rgba(0,0,0,0.25)',
    now: '#bcd4ff',
  },
}

// 색 읽기 — '#rrggbb' · 'rgba(r,g,b,a)'(팔레트에 쓰는 두 꼴만)
function rgba(text: string): [number, number, number, number] {
  if (text.startsWith('#')) return [0, 2, 4].map((at) => parseInt(text.slice(1 + at, 3 + at), 16)).concat(1) as [number, number, number, number]
  const [red = 0, green = 0, blue = 0, alpha = 1] = (text.match(/[\d.]+/g) ?? []).map(Number)
  return [red, green, blue, alpha]
}
const css = ([red, green, blue, alpha]: number[]) => `rgba(${[red, green, blue].map((value) => Math.round(value ?? 0)).join(',')},${(alpha ?? 1).toFixed(3)})`
// 하늘색 쪽으로 amount 만큼 섞기(투명도는 그대로)
function toward(text: string, sky: string, amount: number): string {
  const from = rgba(text)
  const to = rgba(sky)
  return css(from.map((value, index) => (index < 3 ? value + ((to[index] ?? 0) - value) * amount : value)))
}
// 먼 겹 색 — 채우기는 불투명하게 하늘색 쪽으로 섞고, 그늘 · 결 · 골 · 능선 빛은 대비만 낮춘다(투명도를 줄인다)
function hazed(color: Palette, amount: number): Palette {
  const fade = (text: string) => {
    const [red, green, blue, alpha] = rgba(text)
    return css([red, green, blue, alpha * (1 - amount)])
  }
  return { ...color, litTop: toward(color.litTop, color.skyBottom, amount), litBottom: toward(color.litBottom, color.skyBottom, amount), snow: toward(color.snow, color.skyBottom, amount), shade: fade(color.shade), grain: fade(color.grain), gully: fade(color.gully), rim: fade(color.rim) }
}

function add(parent: Element, tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  if (text !== undefined) node.textContent = text
  parent.append(node)
  return node
}

// 늘 같은 모양이 나오는 0~1 값(바위 굴곡 · 별 · 구름 자리) — 다시 그려도 산 · 별이 흔들리지 않게
function hash(index: number): number {
  const value = Math.sin(index * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

const line = (points: Point[]) => points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')

// 30분 이동 평균 — 앞뒤 칸과 섞는다(last 칸까지만 · 끝 칸은 있는 칸만)
function moving(values: number[], last: number): number[] {
  return values.map((_, index) => {
    const near = [index - 1, index, index + 1].filter((other) => other >= 0 && other <= last)
    return near.reduce((sum, other) => sum + (values[other] ?? 0), 0) / near.length
  })
}

// 움직임의 시작점을 벽시계로 — 4초마다 다시 그려도 구름 · 별이 처음 자리로 튀지 않고 이어진다
function phaseDelay(duration: number, offset: number, now: number): string {
  return `${(-(((now / 1000) + offset * duration) % duration)).toFixed(2)}s`
}

type Spot = { index: number; x: number; y: number; height: number }
type Mountain = { ridge: Point[]; end: number; endY: number; spots: Spot[]; ridgeY: (x: number) => number }

// 능선 — 칸 가운데 점 · 칸 사이에 작은 바위 굴곡(seed 로 날마다 다르게).
// 오늘(nowX 있음)은 지금 칸까지 그리고 그 뒤로 비탈만 · 어제 · 그저께는 하루 끝까지
function buildMountain(averages: number[], last: number, top: number, seed: number, nowX: number | null): Mountain {
  const heightAt = (index: number) => ((averages[index] ?? 0) / top) * PEAK
  const ridge: Point[] = [[0, BASE - heightAt(0)]]
  for (let index = 0; index <= last; index++) {
    const x = (index + 0.5) * STEP
    const y = BASE - heightAt(index) * (1 + (hash(index + 800 + seed) - 0.5) * 0.1)
    if (index > 0) {
      const mid = ((ridge[ridge.length - 1]?.[1] ?? BASE) + y) / 2
      ridge.push([x - STEP / 2, mid - (heightAt(index) > 3 ? (hash(index + 700 + seed) - 0.4) * 1.4 : 0)])
    }
    ridge.push([x, y])
  }
  const endY = ridge[ridge.length - 1]?.[1] ?? BASE
  let end = WIDTH
  if (nowX === null) ridge.push([WIDTH, endY])
  else {
    const endHeight = BASE - endY
    end = nowX + endHeight * 0.75
    ridge.push([nowX, endY], [nowX + endHeight * 0.35, BASE - endHeight * 0.45], [end, BASE])
  }
  const ridgeY = (x: number) => {
    for (let index = 1; index < ridge.length; index++) {
      const [x1, y1] = ridge[index] as Point
      if (x1 >= x) {
        const [x0, y0] = ridge[index - 1] as Point
        return y0 + ((y1 - y0) * (x - x0)) / Math.max(0.001, x1 - x0)
      }
    }
    return BASE
  }
  const spots: Spot[] = []
  for (let index = 0; index <= last; index++) spots.push({ index, x: (index + 0.5) * STEP, y: ridgeY((index + 0.5) * STEP), height: heightAt(index) })
  return { ridge, end, endY, spots, ridgeY }
}

// 산 하나 — 빛은 왼쪽 위에서 · 그늘 · 눈 · 골 · 바위 결 · 빛 받는 능선. 세 날 모두 같은 모양으로(뒤 겹은 부르는 쪽이 흐리게 감싼다)
function drawMountain(parent: Element, defs: Element, mountain: Mountain, color: Palette, lit: string, name: string, seed: number): void {
  const { ridge, end, spots, ridgeY } = mountain
  const outline = `${line(ridge)} L${end.toFixed(2)} ${HEIGHT} L0 ${HEIGHT} Z`
  add(add(defs, 'clipPath', { id: `mt-${name}` }), 'path', { d: outline })
  add(parent, 'path', { d: outline, fill: lit })
  const detail = add(parent, 'g', { 'clip-path': `url(#mt-${name})` })
  // 봉우리(좌우 4칸 중 가장 높고 · 평평하면 오른쪽 끝) · 골짜기(좌우 2칸 중 가장 낮고 6칸 안에 7px 넘게 높은 곳이 있는 곳)
  const peaks = spots.filter((spot, at) => spot.height > 5 && spots.slice(Math.max(0, at - 4), at + 5).every((other) => other.height <= spot.height) && spots[at + 1]?.height !== spot.height)
  const valleys = spots.filter((spot, at) => at > 0 && at < spots.length - 1 && spots.slice(Math.max(0, at - 2), at + 3).every((other) => other.height >= spot.height) && spots.slice(Math.max(0, at - 6), at + 7).some((other) => other.height > spot.height + 7))
  const maxHeight = Math.max(0, ...spots.map((spot) => spot.height))
  // 그늘 — 봉우리 오른쪽 비탈이 다음 골짜기까지 · 경계는 봉우리에서 오른쪽 아래로 들쭉날쭉
  for (const spot of peaks) {
    const valley = valleys.find((other) => other.x > spot.x) ?? { x: end }
    const shade: Point[] = []
    for (let x = spot.x; x <= valley.x; x += 0.5) shade.push([x, ridgeY(x) - 0.3])
    shade.push([valley.x, BASE + 2])
    const foot = Math.min(valley.x, spot.x + spot.height * 0.5)
    for (let y = BASE + 2, tooth = 0; y > spot.y; y -= 2.2, tooth++) shade.push([spot.x + ((y - spot.y) / (BASE - spot.y)) * (foot - spot.x) + (hash(spot.index * 13 + tooth + seed) - 0.5) * 1.8, y])
    add(detail, 'path', { d: `${line(shade)} Z`, fill: color.shade })
  }
  // 눈 — 가장 높은 봉우리 셋까지(그 산 가장 높은 값의 75% 이상) · 봉우리 좌우 9px · 4~6px 아래까지 · 그늘 쪽은 어둡게
  const snowy = peaks.filter((spot) => spot.height >= Math.max(16, maxHeight * 0.75)).sort((first, second) => second.height - first.height).slice(0, 3)
  for (const spot of snowy) {
    const snowLine = spot.y + 4 + hash(spot.index + 300 + seed) * 2
    let left = spot.x
    let right = spot.x
    while (left > spot.x - 9 && ridgeY(left - 0.5) < snowLine) left -= 0.5
    while (right < spot.x + 9 && ridgeY(right + 0.5) < snowLine) right += 0.5
    const cap: Point[] = []
    for (let x = left; x <= right; x += 0.5) cap.push([x, ridgeY(x) - 0.2])
    for (let x = right, tooth = 0; x >= left; x -= 1.4, tooth++) cap.push([x, Math.min(snowLine, ridgeY(x) + 4) + (tooth % 2 ? 1.6 : -0.6) * (0.6 + hash(spot.index * 9 + tooth + seed) * 0.8)])
    add(detail, 'path', { d: `${line(cap)} Z`, fill: color.snow })
    const shadeCap = cap.filter(([x]) => x >= spot.x)
    if (shadeCap.length > 2) add(detail, 'path', { d: `M${spot.x} ${spot.y} ${line(shadeCap).replace('M', 'L')} Z`, fill: color.shade, opacity: 0.55 })
  }
  // 골 — 깊은 골짜기에서만 · 아래로 짧게 흔들리며
  for (const spot of valleys.slice(0, 6)) {
    const gully: Point[] = [[spot.x, spot.y + 0.6]]
    const depth = Math.min(14, (BASE - spot.y) * 0.55)
    for (let drop = 2.5, tooth = 0; drop < depth; drop += 2.5, tooth++) gully.push([spot.x + (hash(spot.index * 7 + tooth + seed) - 0.5) * 1.6 + tooth * 0.3, spot.y + drop])
    add(detail, 'path', { d: line(gully), fill: 'none', stroke: color.gully, 'stroke-width': 0.7, 'stroke-linecap': 'round', opacity: 0.45 })
  }
  // 바위 결 — 비탈에 짧은 빗금(내려가는 비탈은 오른쪽 아래로, 오르는 비탈은 왼쪽 아래로)
  for (let index = 1; index < spots.length - 1; index++) {
    const spot = spots[index] as Spot
    if (spot.height < 9 || hash(index + 400 + seed) < 0.6) continue
    const slope = (spots[index + 1]?.height ?? 0) - (spots[index - 1]?.height ?? 0)
    const direction = slope < 0 ? 1 : -1
    const length = 2.5 + hash(index + 500 + seed) * Math.min(6, spot.height * 0.25)
    const startY = spot.y + 3 + hash(index + 600 + seed) * Math.min(10, spot.height * 0.45)
    add(detail, 'path', { d: `M${spot.x} ${startY} l${direction * length * 0.5} ${length}`, stroke: color.grain, 'stroke-width': 0.55, 'stroke-linecap': 'round', fill: 'none', opacity: 0.7 })
  }
  add(parent, 'path', { d: line(ridge), fill: 'none', stroke: color.rim, 'stroke-width': 0.9, 'stroke-linejoin': 'round' })
}

// days — 오늘 · 어제 · 그저께 칸 144개(어제 · 그저께는 기록이 없으면 null) · slot — 지금 칸(0~143) · now — 지금 시각(ms)
export function mountainGraph(days: ActivityDays, slot: number, now: number): HTMLElement {
  const hour = new Date(now).getHours()
  const color = PALETTE[hour >= 6 && hour < 18 ? 'day' : 'night']
  const night = color === PALETTE.night
  const nowX = (slot + 1) * STEP
  const averages = moving(days.today, slot)
  const backDays = (['yesterday', 'before'] as const)
    .map((key) => ({ key, values: days[key] }))
    .filter((day): day is { key: 'yesterday' | 'before'; values: number[] } => Array.isArray(day.values))
    .map((day) => ({ key: day.key, averages: moving(day.values, SLOTS - 1) }))
  // 세 날이 같은 기준 — 3일 중 가장 큰 30분 평균이 꼭대기(일한 시간이 0 이어도 나누지 않게 1)
  const top = Math.max(1, ...averages.slice(0, slot + 1), ...backDays.flatMap((day) => day.averages))
  const today = buildMountain(averages, slot, top, 0, nowX)
  const backs = backDays.map((day) => ({ key: day.key, mountain: buildMountain(day.averages, SLOTS - 1, top, BACK[day.key].seed, null) }))

  const box = document.createElement('div')
  box.className = 'mt'
  const svg = add(box, 'svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT + 14}`, 'aria-hidden': 'true' })
  const defs = add(svg, 'defs')
  // 패널에 그림은 하나 — 다시 그릴 때 옛 것은 빠지니 id 가 겹치지 않는다
  const gradient = (name: string, stops: [number, string][]) => {
    const node = add(defs, 'linearGradient', { id: `mt-${name}`, x1: 0, y1: 0, x2: 0, y2: 1 })
    for (const [offset, stopColor] of stops) add(node, 'stop', { offset, 'stop-color': stopColor })
    return `url(#mt-${name})`
  }
  add(add(defs, 'clipPath', { id: 'mt-frame' }), 'rect', { x: 0, y: 0, width: WIDTH, height: HEIGHT, rx: 6 })
  const scene = add(svg, 'g', { 'clip-path': 'url(#mt-frame)' })
  add(scene, 'rect', { x: 0, y: 0, width: WIDTH, height: HEIGHT, fill: gradient('sky', [[0, color.skyTop], [1, color.skyBottom]]) })
  const lit = (name: string, tone: Palette) => gradient(`lit-${name}`, [[0, tone.litTop], [1, tone.litBottom]])
  const skyline = (x: number) => Math.min(today.ridgeY(x), ...backs.map((day) => day.mountain.ridgeY(x)))

  if (night) {
    // 별 — 산보다 위에만 · 별마다 박자(--dur) · 시작(--delay) · 가장 어두울 때(--lo)가 다르다
    const stars = add(scene, 'g')
    let placed = 0
    for (let index = 0; placed < 44 && index < 400; index++) {
      const x = 3 + hash(index * 3 + 1) * (WIDTH - 6)
      const y = 3 + hash(index * 3 + 2) ** 1.3 * (HEIGHT - 16)
      if (y > skyline(x) - 5) continue
      placed++
      const size = hash(index * 3 + 3)
      const radius = 0.45 + size * size * 1.1
      const duration = 2.2 + hash(index + 50) * 3.4
      const star = add(stars, 'g', { class: 'tw' })
      star.style.setProperty('--dur', `${duration.toFixed(2)}s`)
      star.style.setProperty('--delay', phaseDelay(duration, hash(index + 90), now))
      star.style.setProperty('--lo', (0.15 + hash(index + 130) * 0.35).toFixed(2))
      if (size > 0.72) add(star, 'circle', { cx: x, cy: y, r: radius * 3, fill: '#cfe0ff', opacity: 0.12 })
      if (size > 0.9) add(star, 'path', { d: `M${x - 3.2} ${y}H${x + 3.2}M${x} ${y - 3.2}V${y + 3.2}`, stroke: '#e6eeff', 'stroke-width': 0.5, opacity: 0.7 })
      add(star, 'circle', { cx: x, cy: y, r: radius, fill: size > 0.8 ? '#fff4d6' : '#e6eeff' })
    }
  } else {
    // 구름 — 둥근 덩어리 몇 개 · 높이 · 크기 · 속도가 다르다 · 움직임을 줄이면 --rest 자리에 멈춘다
    const clouds = add(scene, 'g')
    for (let index = 0; index < 4; index++) {
      const width = 24 + hash(index + 11) * 22
      const y = 10 + hash(index + 21) * 20
      const duration = 45 + hash(index + 31) * 35
      const progress = (index + hash(index + 41) * 0.6) / 4
      const drift = add(clouds, 'g', { class: 'drift' })
      drift.style.setProperty('--dur', `${duration.toFixed(1)}s`)
      drift.style.setProperty('--delay', phaseDelay(duration, progress, now))
      drift.style.setProperty('--rest', `${(-70 + progress * 425).toFixed(1)}px`)
      const cloud = add(drift, 'g', { opacity: (0.75 + hash(index + 51) * 0.2).toFixed(2) })
      const puffs = 4 + Math.floor(hash(index + 61) * 3)
      for (let puff = 0; puff < puffs; puff++) {
        const ratio = puff / (puffs - 1)
        const radius = (width / puffs) * (0.75 + Math.sin(ratio * Math.PI) * 0.7)
        add(cloud, 'circle', { cx: ratio * width, cy: y - Math.sin(ratio * Math.PI) * radius * 0.45, r: radius, fill: '#ffffff' })
      }
      // 아래는 납작하게 — 둥근 덩어리 밑을 같은 색 띠로 메운다
      const band = (width / puffs) * 0.9
      add(cloud, 'rect', { x: 0, y: y - band / 2, width, height: band, rx: band / 2, fill: '#ffffff' })
    }
  }

  // 뒤 겹 — 앞 산과 같은 모양 · 같은 높이 기준 · 먼 겹부터(그저께 → 어제) · 불투명하게 하늘색 쪽으로 섞어 멀어 보이게(가장자리는 또렷)
  for (const day of [...backs].reverse()) {
    const tone = hazed(color, BACK[day.key].haze)
    drawMountain(add(scene, 'g'), defs, day.mountain, tone, lit(day.key, tone), day.key, BACK[day.key].seed)
  }
  // 앞 산 발치에 하늘색 옅은 안개 한 겹 — 뒤 겹과 앞 산 층이 나뉜다
  const haze = (alpha: number) => css([...rgba(color.skyBottom).slice(0, 3), alpha])
  if (backs.length) add(scene, 'rect', { x: 0, y: BASE - 28, width: WIDTH, height: 30, fill: gradient('mist', [[0, haze(0)], [1, haze(0.55)]]) })

  // 앞 산(오늘)
  drawMountain(add(scene, 'g'), defs, today, color, lit('today', color), 'today', 0)

  // 지금 — 그 뒤는 아직 오지 않은 시간(옅게 어둡게) · 앞 산 끝에 작은 점
  // 지금 자리에서 경계선이 서지 않게 24px 동안 서서히 어두워진다
  const future = add(defs, 'linearGradient', { id: 'mt-future', x1: nowX, y1: 0, x2: nowX + 24, y2: 0, gradientUnits: 'userSpaceOnUse' })
  add(future, 'stop', { offset: 0, 'stop-color': color.future, 'stop-opacity': 0 })
  add(future, 'stop', { offset: 1, 'stop-color': color.future })
  add(scene, 'rect', { x: nowX, y: 0, width: Math.max(0, WIDTH - nowX), height: HEIGHT, fill: 'url(#mt-future)' })
  add(scene, 'circle', { cx: nowX, cy: today.endY, r: 3.6, fill: color.now, opacity: 0.3 })
  add(scene, 'circle', { cx: nowX, cy: today.endY, r: 1.7, fill: color.now })

  // 시 눈금 0 · 6 · 12 · 18
  for (const tick of HOUR_TICKS) add(svg, 'text', { class: 'tick', x: tick * 6 * STEP + 1, y: HEIGHT + 12 }, String(tick))
  return box
}
