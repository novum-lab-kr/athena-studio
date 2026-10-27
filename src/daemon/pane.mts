// pane 하나 = 셸 pty 1개 + 화면 버퍼(@xterm/headless) 1개.
// 버퍼가 있어야 앱이 다시 붙을 때 화면을 되살리고(serialize, S1) · pane read 를 글자로 답하고 · agent_status 를 화면으로 본다(S7)
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'

// node-pty · xterm 은 CommonJS 패키지 — require 로 같은 모듈을 쓴다(타입만 import)
const require = createRequire(import.meta.url)
const pty: typeof import('node-pty') = require('node-pty')
const { Terminal }: typeof import('@xterm/headless') = require('@xterm/headless')
const { SerializeAddon }: typeof import('@xterm/addon-serialize') = require('@xterm/addon-serialize')
const { Unicode11Addon }: typeof import('@xterm/addon-unicode11') = require('@xterm/addon-unicode11')

export const SCROLLBACK = 5000

// wait-output 이 거는 것 — check() 가 true 면 끝 · fail 은 pane 이 끝났을 때
export type Waiter = { check: () => boolean; fail: (code: string, text: string) => void }

export type PaneOptions = {
  id: string
  tabId: string | null
  cwd: string
  env: Record<string, string | undefined>
  shell: string
  cols: number
  rows: number
  onData: (data: string) => void
  onExit: (code: number) => void
}

export class Pane {
  // declare — 타입만 적는다(실행 코드에 칸을 만들지 않아 JS 때와 같은 객체 · 값은 constructor 가 넣는다)
  declare id: string
  declare tabId: string | null
  declare cwd: string
  declare label: string | null
  declare title: string | null
  declare lastOutputAt: number
  declare exited: boolean
  declare waiters: Set<Waiter>
  declare ptySize: { cols: number; rows: number }
  declare screen: InstanceType<typeof Terminal>
  declare serializer: InstanceType<typeof SerializeAddon>
  declare pty: IPty
  declare pid: number
  // 고정 칸(dock)일 때만 데몬이 채운다(Daemon.ensureDock)
  declare dock?: string
  declare dockKey?: string
  declare body?: string | null

  // onData(data) · onExit(code) · onTitle(title) — 데몬이 앱에 흘려보내고 배치를 고친다
  constructor({ id, tabId, cwd, env, shell, cols, rows, onData, onExit }: PaneOptions) {
    this.id = id
    this.tabId = tabId
    this.cwd = cwd
    this.label = null
    this.title = null
    this.lastOutputAt = 0
    this.exited = false
    this.waiters = new Set()
    this.ptySize = { cols, rows } // pty 크기 — 화면 버퍼(screen)는 앞 출력을 다 읽은 뒤에 따라온다

    this.screen = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    // 화면(renderer)의 xterm 과 같은 폭 규칙 — 이모지를 두 칸으로 센다
    this.screen.loadAddon(new Unicode11Addon())
    this.screen.unicode.activeVersion = '11'
    this.screen.onTitleChange((title) => (this.title = title || null))

    this.pty = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env })
    this.pid = this.pty.pid
    this.pty.onData((data) => {
      this.lastOutputAt = Date.now()
      // 버퍼가 글을 다 읽은 뒤에 기다리는 쪽을 깨운다(read 가 방금 출력을 보게)
      this.screen.write(data, () => this.wakeWaiters())
      onData(data)
    })
    this.pty.onExit(({ exitCode }) => {
      this.exited = true
      for (const waiter of this.waiters) waiter.fail('not_found', `pane ${this.id} 이 끝났다`)
      this.waiters.clear()
      onExit(exitCode)
    })
  }

  write(text: string): void {
    if (!this.exited) this.pty.write(text)
  }

  resize(cols: number, rows: number): void {
    if (this.exited || cols < 2 || rows < 2) return
    if (cols === this.ptySize.cols && rows === this.ptySize.rows) return
    this.ptySize = { cols, rows }
    try {
      this.pty.resize(cols, rows)
    } catch {}
    // 화면 버퍼는 앞서 받은 출력을 다 읽은 뒤에(write 는 비동기 큐) — 앱 화면도 같은 순서로 바꾼다(main.js ctx.resizePane)
    this.screen.write('', () => {
      if (!this.exited) this.screen.resize(cols, rows)
    })
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.screen.cols, rows: this.screen.rows }
  }

  // SIGHUP — 셸과 그 아래 프로그램이 끝난다(터미널을 닫은 것과 같다)
  close(): void {
    if (this.exited) return
    try {
      this.pty.kill('SIGHUP')
    } catch {}
  }

  // 앱이 다시 붙을 때 보낼 화면(색·커서·대체 화면 포함)
  snapshot(): string {
    return this.serializer.serialize({ scrollback: SCROLLBACK })
  }

  // 버퍼 줄들 — recent 는 scrollback 포함 전부, visible 은 지금 화면
  lines(source: string = 'recent'): string[] {
    const buffer = this.screen.buffer.active
    const start = source === 'visible' ? buffer.viewportY : 0
    const end = source === 'visible' ? buffer.viewportY + this.screen.rows : buffer.length
    const out: string[] = []
    for (let index = start; index < end; index++) {
      const line = buffer.getLine(index)
      out.push(line ? line.translateToString(true) : '')
    }
    return out
  }

  // wait-output 용 — check() 가 true 를 돌려주면 끝. 출력이 올 때마다 다시 본다
  addWaiter(waiter: Waiter): () => boolean {
    this.waiters.add(waiter)
    return () => this.waiters.delete(waiter)
  }

  wakeWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.check()) this.waiters.delete(waiter)
    }
  }
}
