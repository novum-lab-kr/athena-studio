// ── 모바일 암호 세션 — relay 길(mobile-relay.mts) · 직접 길(mobile-lan.mts)이 같이 쓰는 hello 답 · 봉인 · 조각 모으기 ──
// 암호 자체는 src/lib/mobile-crypto.mts(계획서 4-7 암호 연결 v1). 여기는 기기 하나와의 세션 한 벌을 묶는다:
// hello 를 받아 일회 열쇠로 답하고 → 안쪽 메시지를 JSON · 조각 · 봉인해 보내고 → 받은 암호문을 열어 조각을 모은다.
// 바깥 봉투(relay msg · 직접 WebSocket 글)는 모른다 — 부르는 쪽이 sendData 로 넘긴 base64 글을 자기 길로 싣는다.
import * as mobileCrypto from '../lib/mobile-crypto.mts'
import type { KeyPair } from '../lib/mobile-crypto.mts'
import type { Transport } from './mobile-bridge.mts'

export type BridgeHandle = { stop(): Promise<void>; openPanes(): string[]; resyncPane(pane: string): Promise<void> }

// 앱 hello → 맥 일회 열쇠로 세션 열쇠를 셈하고 보낼 답(hello)을 만든다. 낮은 차수 점 등으로 셈이 안 되면 null(그 hello 는 버린다)
export function answerHello(macKey: KeyPair, appStatic: Uint8Array, appEphemeral: Uint8Array): { keys: mobileCrypto.SessionKeys; reply: mobileCrypto.Handshake } | null {
  const ephemeralKey = mobileCrypto.newKeyPair()
  try {
    const keys = mobileCrypto.deriveSessionKeys({ role: 'mac', staticKey: macKey, ephemeralKey, peerStatic: appStatic, peerEphemeral: appEphemeral })
    return { keys, reply: mobileCrypto.helloMessage(ephemeralKey.publicKey) }
  } catch {
    return null
  }
}

// 세션 한 벌 — transport 는 브리지에 넘기는 쪽(보내면 봉인해 sendData 로), open 은 받은 암호문 하나를 연다.
// open: 복호화 실패 · 순번 역행(재전송)이면 null — 부르는 쪽이 세션을 버린다. 열렸지만 줄 메시지가 없으면(조각 기다림 · JSON 아님) { message: null }
export function createSecureChannel(keys: mobileCrypto.SessionKeys, sendData: (data: string) => void) {
  const cipher = mobileCrypto.createCipherSession(keys)
  const assembler = mobileCrypto.createAssembler()
  let handler: ((message: unknown) => void) | null = null
  let nextChunkId = 1
  let closed = false

  // 안쪽 메시지 하나 → JSON → 2 MiB 조각(필요하면) → 조각마다 봉인
  function send(message: object) {
    if (closed) return
    const pieces = mobileCrypto.splitMessage(JSON.stringify(message), `m${nextChunkId++}`)
    for (const piece of pieces) sendData(cipher.seal(piece))
  }

  function open(bytes: Uint8Array): { message: unknown } | null {
    const plain = cipher.open(bytes)
    if (plain === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(plain)
    } catch {
      return { message: null }
    }
    return { message: assembler.add(parsed) }
  }

  const transport: Transport = {
    send,
    onMessage: (next) => void (handler = next),
    close: () => {},
  }

  return {
    transport,
    open,
    // 연 메시지를 브리지(onMessage 로 건 쪽)에 넘긴다
    deliver(message: unknown) {
      if (!closed && message !== null && handler) handler(message)
    },
    // 브리지를 거치지 않는 맥 알림(lan.info 등)도 같은 봉인으로
    send,
    close() {
      closed = true
    },
  }
}

export type SecureChannel = ReturnType<typeof createSecureChannel>
