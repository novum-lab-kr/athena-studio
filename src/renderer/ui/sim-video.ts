// Android 화면 영상 — main 이 보내는 H.264 조각(sim:video)을 프레임으로 나눠(src/lib/h264-stream.mts) WebCodecs 로 풀고 canvas 에 그린다.
// 켜고 끄는 때는 sim-bar.tsx 가 정한다(칸이 보이고 Android 가 열려 있을 때만 하나). VideoDecoder 는 안전한 문맥(file://)에만 있다.
// 화면이 안 바뀌면 조각이 안 온다 — 마지막 장이 그대로 남는다. SPS 가 바뀌면(회전 · 해상도 — sim.mjs 가 새로 녹화) 다시 configure 하고 키 프레임을 기다린다
import { codecFromSps, createH264Splitter, sameBytes } from '../../lib/h264-stream.mts'
import type { AccessUnit, H264Splitter } from '../../lib/h264-stream.mts'

// 마지막 NAL 은 다음 시작 코드가 와야 끝난다 — 이만큼 조용하면 끝난 것으로(큰 프레임의 나뉜 조각은 몇 ms 사이로 온다 — 2026-11-16 실측)
const IDLE_FLUSH_MS = 40

export type VideoEvents = {
  drawn: (width: number, height: number) => void // 첫 장 · 크기가 바뀐 장을 그렸다
  ended: (reason: string) => void // 영상이 끝났다(main 의 이유 · 'no-stream' = 옛 코어 · 'decode' = 풀기 실패)
}

type Session = {
  token: number
  splitter: H264Splitter
  decoder: VideoDecoder | null
  sps: Uint8Array | null
  needKey: boolean
  flushTimer: number | null
  width: number
  height: number
  timestamp: number
  events: VideoEvents
}

let canvas: HTMLCanvasElement | null = null
let session: Session | null = null
let nextToken = 1
let listening = false

// 칸의 canvas(React ref) — 없으면 풀기만 하고 버린다
export function setCanvas(element: HTMLCanvasElement | null): void {
  canvas = element
}

export function videoSupported(): boolean {
  return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function'
}

export function videoRunning(): boolean {
  return session !== null
}

function closeDecoder(current: Session): void {
  if (current.decoder && current.decoder.state !== 'closed') current.decoder.close()
  current.decoder = null
}

function end(current: Session, reason: string): void {
  if (session !== current) return
  session = null
  clearTimeout(current.flushTimer ?? undefined)
  closeDecoder(current)
  current.events.ended(reason)
}

function draw(current: Session, frame: VideoFrame): void {
  try {
    if (session !== current || !canvas) return
    const width = frame.displayWidth
    const height = frame.displayHeight
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    canvas.getContext('2d')?.drawImage(frame, 0, 0, width, height)
    if (current.width !== width || current.height !== height) {
      current.width = width
      current.height = height
      current.events.drawn(width, height)
    }
  } finally {
    frame.close()
  }
}

function configure(current: Session, sps: Uint8Array): void {
  closeDecoder(current)
  const decoder = new VideoDecoder({
    output: (frame) => draw(current, frame),
    error: () => end(current, 'decode'),
  })
  decoder.configure({ codec: codecFromSps(sps), optimizeForLatency: true })
  current.decoder = decoder
  current.sps = sps
  current.needKey = true
}

function decode(current: Session, units: AccessUnit[]): void {
  for (const unit of units) {
    if (session !== current) return
    if (unit.sps && !sameBytes(unit.sps, current.sps)) configure(current, unit.sps)
    const decoder = current.decoder
    if (!decoder || decoder.state !== 'configured') continue
    // 새로 configure 했으면 키 프레임부터
    if (current.needKey && !unit.key) continue
    current.needKey = false
    // 시각은 순서만 맞으면 된다(바로 그린다) — 마이크로초
    current.timestamp += 16_000
    try {
      decoder.decode(new EncodedVideoChunk({ type: unit.key ? 'key' : 'delta', timestamp: current.timestamp, data: unit.data }))
    } catch {
      end(current, 'decode')
    }
  }
}

function receive(token: number, chunk: Uint8Array): void {
  const current = session
  if (!current || current.token !== token) return
  clearTimeout(current.flushTimer ?? undefined)
  current.flushTimer = null
  decode(current, current.splitter.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)))
  if (session !== current || !current.splitter.pending()) return
  current.flushTimer = setTimeout(() => {
    current.flushTimer = null
    if (session === current) decode(current, current.splitter.flush())
  }, IDLE_FLUSH_MS)
}

function listen(): void {
  if (listening) return
  listening = true
  studio.onSimVideo(receive)
  studio.onSimVideoEnd((token, reason) => {
    if (session?.token === token) end(session, String(reason || ''))
  })
}

// 영상 켜기 — 앞의 것은 끈다. main 이 바로 거절하면(기기 id · 옛 본체) 그 이유로 ended
export function startVideo(id: string, events: VideoEvents): void {
  listen()
  stopVideo()
  const current: Session = { token: nextToken++, splitter: createH264Splitter(), decoder: null, sps: null, needKey: true, flushTimer: null, width: 0, height: 0, timestamp: 0, events }
  session = current
  void studio.simStream(id, current.token).then((reply) => {
    if (!reply.ok) end(current, String(reply.error || ''))
  })
}

// 영상 끄기 — main 이 sim.mjs 를 끄고(기기 안 녹화까지) 끝 알림은 보내지 않는다
export function stopVideo(): void {
  const current = session
  if (!current) return
  session = null
  clearTimeout(current.flushTimer ?? undefined)
  closeDecoder(current)
  studio.simStreamStop()
}
