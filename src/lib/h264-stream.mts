// Android 화면 영상(adb screenrecord --output-format=h264 — Annex B)을 VideoDecoder 에 넣을 프레임으로 나눈다.
// 시뮬레이터 칸(src/renderer/ui/sim-bar.tsx)만 import 한다 — 화면 없이 시험하려고 뺀 순수 로직(test/h264-stream.test.js).
// adb 가 넘기는 조각은 NAL 경계와 맞지 않는다(큰 프레임은 64KB 쯤에서 잘려 몇 ms 뒤 이어 온다 — 2026-11-16 syung36 실측).
// 그래서 NAL 은 다음 시작 코드가 와야 끝난 것으로 보고, 마지막 NAL 은 부르는 쪽이 잠깐 조용할 때 flush 로 끝낸다.
// 프레임 하나 = 앞선 SPS · PPS · SEI 들 + 슬라이스 하나(screenrecord 는 프레임마다 슬라이스 하나 — 같은 실측)

export type AccessUnit = {
  data: Uint8Array // Annex B 그대로(시작 코드 포함) — VideoDecoder 에 description 없이 넣는다
  key: boolean // IDR 슬라이스
  sps: Uint8Array | null // 이 프레임 앞에 온 SPS(NAL 머리부터 · 시작 코드 없이) — 크기 · 프로필이 바뀌면 다시 configure
}

const NAL_SLICE = 1
const NAL_IDR = 5
const NAL_SPS = 7

// 시작 코드(00 00 01 · 00 00 00 01)가 시작하는 자리들
function startCodes(bytes: Uint8Array): number[] {
  const found: number[] = []
  for (let index = 0; index + 2 < bytes.length; index++) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0 || bytes[index + 2] !== 1) continue
    found.push(index > 0 && bytes[index - 1] === 0 ? index - 1 : index)
    index += 2
  }
  return found
}

// 시작 코드 다음 첫 바이트(NAL 머리)의 자리
function headerAt(nal: Uint8Array): number {
  return nal[2] === 1 ? 3 : 4
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

export type H264Splitter = {
  push(chunk: Uint8Array): AccessUnit[] // 끝난 프레임들
  flush(): AccessUnit[] // 남은 마지막 NAL 을 끝난 것으로(조용할 때)
  pending(): boolean // 끝나지 않은 바이트가 남았는지
}

export function createH264Splitter(): H264Splitter {
  let buffer: Uint8Array = new Uint8Array(0)
  let prefix: Uint8Array[] = []
  let sps: Uint8Array | null = null

  const takeNal = (nal: Uint8Array, out: AccessUnit[]) => {
    const header = headerAt(nal)
    if (nal.length <= header) return
    const type = (nal[header] ?? 0) & 0x1f
    if (type === NAL_SPS) sps = nal.slice(header)
    if (type !== NAL_SLICE && type !== NAL_IDR) {
      prefix.push(nal)
      return
    }
    out.push({ data: joinBytes([...prefix, nal]), key: type === NAL_IDR, sps })
    prefix = []
    sps = null
  }

  return {
    push(chunk) {
      buffer = buffer.length ? joinBytes([buffer, chunk]) : chunk.slice()
      const starts = startCodes(buffer)
      const out: AccessUnit[] = []
      if (starts.length === 0) {
        // 시작 코드 없이 쌓이기만 하면(앞이 잘린 쓰레기) 마지막 3바이트만 남긴다 — 다음 조각과 이어 시작 코드가 될 수 있다
        if (buffer.length > 3) buffer = buffer.slice(buffer.length - 3)
        return out
      }
      for (let index = 0; index + 1 < starts.length; index++) takeNal(buffer.subarray(starts[index], starts[index + 1]), out)
      // 첫 시작 코드 앞(잘린 조각)은 버린다 · 마지막 NAL 은 다음 시작 코드를 기다린다
      buffer = buffer.slice(starts[starts.length - 1])
      return out
    },
    flush() {
      const out: AccessUnit[] = []
      if (startCodes(buffer)[0] === 0) takeNal(buffer, out)
      buffer = new Uint8Array(0)
      return out
    },
    pending() {
      return buffer.length > 0
    },
  }
}

// SPS → WebCodecs codec 문자열(avc1.PPCCLL — profile_idc · constraint 깃발 · level_idc)
export function codecFromSps(sps: Uint8Array): string {
  const hex = (value: number | undefined) => (value ?? 0).toString(16).padStart(2, '0')
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
}

// SPS 가 같은지(바뀌면 크기 · 회전이 바뀐 새 녹화 — 다시 configure)
export function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (!left || !right || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}
