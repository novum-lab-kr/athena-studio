// pane 하나 = 셸 pty 1개 + 화면 버퍼(@xterm/headless) 1개.
// 버퍼가 있어야 앱이 다시 붙을 때 화면을 되살리고(serialize, S1) · pane read 를 글자로 답하고 · agent_status 를 화면으로 본다(S7)
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize')
const { Unicode11Addon } = require('@xterm/addon-unicode11')

const SCROLLBACK = 5000

class Pane {
  // onData(data) · onExit(code) · onTitle(title) — 데몬이 앱에 흘려보내고 배치를 고친다
  constructor({ id, tabId, cwd, env, shell, cols, rows, onData, onExit }) {
    this.id = id
    this.tabId = tabId
    this.cwd = cwd
    this.label = null
    this.title = null
    this.lastOutputAt = 0
    this.exited = false
    this.waiters = new Set()

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

  write(text) {
    if (!this.exited) this.pty.write(text)
  }

  resize(cols, rows) {
    if (this.exited || cols < 2 || rows < 2) return
    if (cols === this.screen.cols && rows === this.screen.rows) return
    try {
      this.pty.resize(cols, rows)
    } catch {}
    this.screen.resize(cols, rows)
  }

  get size() {
    return { cols: this.screen.cols, rows: this.screen.rows }
  }

  // SIGHUP — 셸과 그 아래 프로그램이 끝난다(터미널을 닫은 것과 같다)
  close() {
    if (this.exited) return
    try {
      this.pty.kill('SIGHUP')
    } catch {}
  }

  // 앱이 다시 붙을 때 보낼 화면(색·커서·대체 화면 포함)
  snapshot() {
    return this.serializer.serialize({ scrollback: SCROLLBACK })
  }

  // 버퍼 줄들 — recent 는 scrollback 포함 전부, visible 은 지금 화면
  lines(source = 'recent') {
    const buffer = this.screen.buffer.active
    const start = source === 'visible' ? buffer.viewportY : 0
    const end = source === 'visible' ? buffer.viewportY + this.screen.rows : buffer.length
    const out = []
    for (let index = start; index < end; index++) {
      const line = buffer.getLine(index)
      out.push(line ? line.translateToString(true) : '')
    }
    return out
  }

  // wait-output 용 — check() 가 true 를 돌려주면 끝. 출력이 올 때마다 다시 본다
  addWaiter(waiter) {
    this.waiters.add(waiter)
    return () => this.waiters.delete(waiter)
  }

  wakeWaiters() {
    for (const waiter of [...this.waiters]) {
      if (waiter.check()) this.waiters.delete(waiter)
    }
  }
}

module.exports = { Pane, SCROLLBACK }
