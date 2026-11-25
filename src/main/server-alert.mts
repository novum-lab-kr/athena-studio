// ── 서버 문제 알림 — 맥 알림 · 폰 푸시(계획서 plans/feature/20261125-서버-문제-알림.md) ──
// 읽기 · 판정을 화면이 아니라 여기(main)서 맡는다 — 화면 타이머는 창이 가려지면 늦춰지고, 맥 알림 · 폰 푸시 · 팩 창 목록이 모두 main 에 있다.
// 서버 칸이 닫혀 있어도 본체마다 5분에 한 번 읽는다(결정 D3 — 칸이 열려 있으면 화면이 3분마다 읽고, 그 읽기도 여기로 온다).
// 실제로 읽은 때마다(server-status.mts onRead) 판정(src/lib/server-alert.mts) → 새 문제 · 회복마다 맥 알림 한 장 + 짝 기기 폰에 push.send kind:'server'.
// 알림 글에는 서버 이름 · 서비스 이름 · 마운트 · 숫자 · 이유 이름의 문구만 — 주소 · 사용자 이름 · ssh 오류 원문은 넣지 않는다(서버 칸 화면과 같은 규칙).
// 같은 문제를 한 번만 알리도록 본체마다 기억을 파일에 둔다(<본체>/.pack-data/state/server-alerts.json — 서버 이름 · 종류 · 대상 · 시각 · 값만). 팩 데이터가 없는 본체는 메모리에만
// 메뉴 막대 [알림 끄기] 동안은 맥 알림 · 폰 푸시 모두 내지 않는다(기억은 그대로 — 풀려도 그 사이 것을 몰아 보내지 않는다 · 메뉴 막대 알림과 같다)
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Notification } from 'electron'
import * as core from '../lib/core.mts'
import { alertText, memoryFrom, observe } from '../lib/server-alert.mts'
import { BODY_MAX, TITLE_MAX, clipText } from '../lib/push-model.mts'
import type { AlertEvent, AlertMemory, AlertSay } from '../lib/server-alert.mts'
import type { PushEvent, PushGate } from '../lib/push-model.mts'
import type { ServerStatusReply } from './server-status.mts'

export type ServerAlertCtx = {
  athenaDir: string | null
  serverStatus?: () => Promise<ServerStatusReply>
  send(channel: string, ...args: unknown[]): void
  show(tab?: string): void
}
type ServerAlertDeps = {
  say: AlertSay
  packWindows: ReadonlySet<ServerAlertCtx>
  gate: () => PushGate // 메뉴 막대 거르기(tray.mts pushGate)
  push: (events: readonly PushEvent[], gate: PushGate) => void // 폰 푸시(mobile-dev serverAlerts · 모바일 길이 꺼져 있으면 아무것도)
}

export const BACKGROUND_MS = 5 * 60 * 1000 // 칸이 닫혀 있어도(D3)
const TICK_MS = 60 * 1000 // 이만큼마다 본체마다 마지막 실제 읽기가 BACKGROUND_MS 지났는지 본다
const hash = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\n')).digest('base64url').slice(0, 22)

export function setupServerAlerts(deps: ServerAlertDeps) {
  const memories = new Map<string, AlertMemory>() // 본체 → 기억
  const lastRead = new Map<string, number>() // 본체 → 마지막 실제 읽기 시각
  let timer: ReturnType<typeof setInterval> | null = null

  const memoryFile = (dir: string) => {
    const packData = path.join(dir, '.pack-data')
    return fs.existsSync(packData) ? path.join(packData, 'state', 'server-alerts.json') : null
  }
  const memoryOf = (dir: string): AlertMemory => {
    const known = memories.get(dir)
    if (known) return known
    const file = memoryFile(dir)
    let loaded: unknown = null
    try {
      loaded = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    } catch {
      loaded = null
    }
    const memory = memoryFrom(loaded)
    memories.set(dir, memory)
    return memory
  }
  const saveMemory = async (dir: string, memory: AlertMemory) => {
    const file = memoryFile(dir)
    if (!file) return
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(temp, `${JSON.stringify(memory)}\n`)
    await fs.promises.rename(temp, file)
  }

  const ctxOfDir = (dir: string) => [...deps.packWindows].find((ctx) => ctx.athenaDir && core.sameDir(ctx.athenaDir, dir)) || null

  // 누르면 그 본체 창의 서버 칸이 그 서버로 열린다(창이 닫혔으면 아무것도)
  function notify(dir: string, event: AlertEvent, text: { title: string; body: string }) {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: text.title, body: text.body, silent: true })
    notification.on('click', () => {
      const ctx = ctxOfDir(dir)
      if (!ctx) return
      ctx.show('work')
      ctx.send('server:open', event.server)
    })
    notification.show()
  }

  // 사건 하나 → 폰 푸시 하나 · id 는 사건마다 다르게(relay 10분 중복 거르기) · collapse 는 같은 본체 · 서버 · 문제면 같게(폰에서 문제 → 회복이 한 장으로 바뀐다)
  // relay 가 알 수 있는 것은 해시뿐 — 서버 이름은 암호 안에만
  const pushEvent = (dir: string, event: AlertEvent, text: { title: string; body: string }, now: number): PushEvent => ({
    kind: 'server',
    id: hash('server', dir, event.server, event.kind, event.target, event.type, String(now)),
    collapse: hash('server-collapse', dir, event.server, event.kind, event.target),
    title: clipText(text.title, TITLE_MAX),
    body: clipText(text.body, BODY_MAX),
    server: event.server,
  })

  // 실제 읽기 하나(server-status.mts onRead) — 같은 본체 창 화면에도 넘긴다(칸이 닫혀 있어도 버튼 점이 맞게)
  function read(ctx: ServerAlertCtx, reply: ServerStatusReply) {
    const dir = ctx.athenaDir
    if (!dir) return
    const now = Date.now()
    lastRead.set(dir, now)
    for (const each of deps.packWindows) if (each.athenaDir && core.sameDir(each.athenaDir, dir)) each.send('server:read', reply)
    const memory = memoryOf(dir)
    const before = JSON.stringify(memory)
    const events = observe(memory, reply.servers, now)
    if (JSON.stringify(memory) !== before) void saveMemory(dir, memory).catch(() => {})
    if (!events.length) return
    const gate = deps.gate()
    if (gate.muted) return
    const pushes: PushEvent[] = []
    for (const event of events) {
      const text = alertText(event, deps.say)
      notify(dir, event, text)
      pushes.push(pushEvent(dir, event, text, now))
    }
    try {
      deps.push(pushes, gate)
    } catch {
      // 폰에 못 보내도 맥 알림은 이미 나갔다
    }
  }

  // 본체마다 한 창만 읽는다(같은 본체 창이 둘이어도) — 마지막 실제 읽기가 BACKGROUND_MS 지났을 때
  function tick() {
    const seen: string[] = []
    const now = Date.now()
    for (const ctx of deps.packWindows) {
      const dir = ctx.athenaDir
      if (!dir || !ctx.serverStatus || seen.some((other) => core.sameDir(other, dir))) continue
      seen.push(dir)
      if (now - (lastRead.get(dir) ?? 0) < BACKGROUND_MS) continue
      // 읽기가 끝나면 onRead 가 lastRead 를 적는다 — 실패해도 이번 차례는 친다(1분마다 다시 시도하지 않게)
      lastRead.set(dir, now)
      ctx.serverStatus().catch(() => {})
    }
  }

  return {
    read,
    start() {
      if (!timer) timer = setInterval(tick, TICK_MS)
    },
  }
}
