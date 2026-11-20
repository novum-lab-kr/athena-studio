// pane 하나 = 셸 pty 1개 + 화면 버퍼(@xterm/headless) 1개.
// 버퍼가 있어야 앱이 다시 붙을 때 화면을 되살리고(serialize, S1) · pane read 를 글자로 답하고 · agent_status 를 화면으로 본다(S7)
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'

// node-pty · xterm 은 CommonJS 패키지 — require 로 같은 모듈을 쓴다(타입만 import)
const require = createRequire(import.meta.url)
const pty: typeof import('node-pty') = require('node-pty')
const { Terminal }: typeof import('@xterm/headless') = require('@xterm/headless')
// HTMLSerializeHandler 는 내보내지만 타입 선언에 없다 — 문자열 직렬화 클래스를 찾는 데만 쓴다(아래 findStringHandler)
const { SerializeAddon, HTMLSerializeHandler }: typeof import('@xterm/addon-serialize') & { HTMLSerializeHandler?: object } =
  require('@xterm/addon-serialize')
const { Unicode11Addon }: typeof import('@xterm/addon-unicode11') = require('@xterm/addon-unicode11')

export const SCROLLBACK = 5000

// ── 스냅숏에 OSC 8 링크 싣기 ──
// @xterm/addon-serialize(0.14.0 · 0.15 베타까지)는 칸의 링크(OSC 8)를 버리고 밑줄만 남긴다 — 다시 붙은 화면(맥 · 폰)에서 링크가 죽는다.
// 애드온의 문자열 직렬화 클래스(내보내지 않는다)를 상속해 칸의 링크 번호가 바뀌는 곳에 OSC 8 을 끼운다.
// 내부 이름(_nextCell · _currentRow · _serializeString · _serializeBufferByRange · _oscLinkService)은 고정 판(package.json)에 맞춘 것 —
// 못 찾으면 원래 직렬화로 돌아간다(링크만 빠진다). 판을 올리면 test/pane-snapshot-links.test.js 가 링크 복원을 본다
type LinkExtended = { urlId: number; clone(): LinkExtended }
type LinkCell = { fg: number; bg: number; getWidth(): number; hasExtendedAttrs(): number | boolean; extended?: LinkExtended }
type LinkData = { id?: string; uri: string }
type LinkCore = {
  _oscLinkService?: { getLinkData(linkId: number): LinkData | undefined }
  _inputHandler?: { _curAttrData?: LinkCell }
}
type HandlerBase = {
  _currentRow: string
  _nextCell(cell: LinkCell, oldCell: unknown, row: number, col: number): void
  _diffStyle(cell: LinkCell, oldCell: LinkCell): number[]
  _serializeString(excludeFinalCursorPosition?: boolean): string
  serialize(range: unknown, excludeFinalCursorPosition?: boolean): string
}
type HandlerClass = new (buffer: unknown, terminal: unknown) => HandlerBase
type RangeSerializer = (terminal: unknown, buffer: unknown, range: unknown, excludeFinalCursorPosition: boolean) => string

const OSC8_CLOSE = '\x1b]8;;\x1b\\'

// 링크를 여는 OSC 8 — 원래 id 가 있으면 그대로(여러 줄 링크를 하나로 묶는 값)
function osc8Open(link: LinkData): string {
  return `\x1b]8;${link.id ? `id=${link.id}` : ''};${link.uri}\x1b\\`
}

// 칸의 링크 번호 — 확장 속성이 없는 칸은 extended 가 앞 칸 것으로 남아 있을 수 있어 먼저 본다
function linkIdOf(cell: LinkCell | undefined): number {
  if (!cell || !cell.hasExtendedAttrs()) return 0
  return cell.extended?.urlId ?? 0
}

// 링크 번호만 0 으로 본 칸 — 링크가 없는 칸은 그대로(대부분의 칸이라 복사하지 않는다).
// 같은 클래스의 빈 칸(scratch)에 글자 속성(fg · bg · extended)만 옮기고 extended 는 링크를 뺀 복사본으로 —
// 밑줄 판정은 xterm 의 isUnderline 그대로 쓴다(Object.create 로 가리면 링크가 많은 화면에서 직렬화가 8배 느려졌다)
function withoutLink(cell: LinkCell, scratch: LinkCell): LinkCell {
  if (!linkIdOf(cell) || !cell.extended?.clone) return cell
  const extended = cell.extended.clone()
  extended.urlId = 0
  scratch.fg = cell.fg
  scratch.bg = cell.bg
  scratch.extended = extended
  return scratch
}

// 내보내지 않는 문자열 직렬화 클래스 찾기 — 공통 부모(HTMLSerializeHandler 의 부모)의 serialize 를 잠깐 바꿔 끼워
// 빈 터미널을 한 번 직렬화하면 그 this 가 문자열 직렬화 인스턴스다. 바로 원래대로 돌린다
function findStringHandler(): HandlerClass | null {
  const base = HTMLSerializeHandler ? (Object.getPrototypeOf(HTMLSerializeHandler) as { prototype?: HandlerBase }) : null
  const original = base?.prototype?.serialize
  if (!base?.prototype || typeof original !== 'function') return null
  // 콜백 안에서 채우는 값이라 객체 칸에 둔다(지역 변수면 타입 좁히기가 null 로 굳는다)
  const seen: { handler: HandlerClass | null } = { handler: null }
  const probe = new Terminal({ cols: 2, rows: 2, allowProposedApi: true })
  try {
    base.prototype.serialize = function (this: HandlerBase) {
      seen.handler = (Object.getPrototypeOf(this) as { constructor: HandlerClass }).constructor
      return ''
    }
    const addon = new SerializeAddon()
    probe.loadAddon(addon)
    addon.serialize({ excludeAltBuffer: true, excludeModes: true })
  } catch {
    seen.handler = null
  } finally {
    base.prototype.serialize = original
    probe.dispose()
  }
  const handler = seen.handler
  const proto = handler?.prototype
  if (!handler || !proto || [proto._nextCell, proto._diffStyle, proto._serializeString].some((method) => typeof method !== 'function')) return null
  return handler
}

function makeLinkHandler(): HandlerClass | null {
  const StringHandler = findStringHandler()
  if (!StringHandler) return null
  return class LinkSerializeHandler extends StringHandler {
    declare linkTerminal: InstanceType<typeof Terminal>
    declare linkBuffer: unknown
    declare openLink: number
    declare wroteLink: boolean
    declare scratchCell: LinkCell
    declare scratchOld: LinkCell

    constructor(buffer: unknown, terminal: unknown) {
      super(buffer, terminal)
      this.linkTerminal = terminal as InstanceType<typeof Terminal>
      this.linkBuffer = buffer
      this.openLink = 0
      this.wroteLink = false
      const nullCell = () => (buffer as { getNullCell(): LinkCell }).getNullCell()
      this.scratchCell = nullCell()
      this.scratchOld = nullCell()
    }

    linkData(linkId: number): LinkData | undefined {
      return (this.linkTerminal as unknown as { _core?: LinkCore })._core?._oscLinkService?.getLinkData(linkId)
    }

    // 칸을 쓰기 전에 링크가 바뀌었으면 닫고 · 연다(두 칸 글자의 빈 뒤 칸은 건너뛴다 — 원래 _nextCell 도 그 칸은 쓰지 않는다)
    _nextCell(cell: LinkCell, oldCell: unknown, row: number, col: number): void {
      if (cell.getWidth() !== 0) {
        let linkId = linkIdOf(cell)
        const link = linkId ? this.linkData(linkId) : undefined
        if (!link) linkId = 0
        if (linkId !== this.openLink) {
          if (this.openLink) this._currentRow += OSC8_CLOSE
          if (link) this._currentRow += osc8Open(link)
          this.openLink = linkId
          this.wroteLink = true
        }
      }
      super._nextCell(cell, oldCell, row, col)
    }

    // xterm 은 링크 칸의 밑줄을 점선(링크 표시)으로 보고하는데 애드온은 그것을 SGR 4(실선 밑줄)로 옮겨 쓴다 —
    // 되살린 칸에 진짜 밑줄이 붙어 링크를 닫은 뒤에도 남는다. 비교에는 링크를 뺀 칸을 넘겨 프로그램이 준 밑줄만 쓴다
    _diffStyle(cell: LinkCell, oldCell: LinkCell): number[] {
      return super._diffStyle(withoutLink(cell, this.scratchCell), withoutLink(oldCell, this.scratchOld))
    }

    // 끝에서 링크를 닫아 이어지는 출력이 링크로 붙지 않게 한다(뒤 빈 줄을 잘라 닫는 글이 빠졌을 수 있어 한 번이라도 썼으면 닫는다).
    // 지금 보이는 버퍼면 프로그램이 링크를 연 채인지까지 되살린다(애드온이 글자 속성을 되살리는 것과 같은 자리)
    _serializeString(excludeFinalCursorPosition?: boolean): string {
      let content = super._serializeString(excludeFinalCursorPosition)
      if (this.wroteLink) content += OSC8_CLOSE
      if (this.linkBuffer === this.linkTerminal.buffer.active) {
        const core = (this.linkTerminal as unknown as { _core?: LinkCore })._core
        const current = linkIdOf(core?._inputHandler?._curAttrData)
        const link = current ? this.linkData(current) : undefined
        if (link) content += osc8Open(link)
      }
      return content
    }
  }
}

const LinkHandler = makeLinkHandler()

// 애드온이 버퍼 하나를 직렬화하는 자리 — 원래 것과 같고 만드는 클래스만 링크를 아는 쪽이다
const serializeRangeWithLinks: RangeSerializer = (terminal, buffer, range, excludeFinalCursorPosition) => {
  const cols = (terminal as { cols: number }).cols
  const { start, end } = range as { start: number | { line: number }; end: number | { line: number } }
  const handler = new (LinkHandler as HandlerClass)(buffer, terminal)
  return handler.serialize(
    {
      start: { x: 0, y: typeof start === 'number' ? start : start.line },
      end: { x: cols, y: typeof end === 'number' ? end : end.line },
    },
    excludeFinalCursorPosition,
  )
}

// 링크까지 실은 직렬화. 코드 교체 전부터 있던 pane 의 애드온 인스턴스에도 그 자리에서 끼운다(새 코드가 늘 이긴다)
export function serializeWithLinks(serializer: InstanceType<typeof SerializeAddon>, scrollback: number): string {
  const addon = serializer as unknown as { _serializeBufferByRange?: RangeSerializer }
  if (LinkHandler && typeof addon._serializeBufferByRange === 'function') addon._serializeBufferByRange = serializeRangeWithLinks
  return serializer.serialize({ scrollback })
}

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

// 지금 열린 문자 장치 fd → 장치 번호(rdev). 번호만 보면 readdir 자기 fd 가 끼었다가 다시 쓰여 헷갈린다
function charDevices(): Map<number, number> {
  const devices = new Map<number, number>()
  for (const name of fs.readdirSync('/dev/fd')) {
    const fd = Number(name)
    try {
      const stat = fs.fstatSync(fd)
      if (stat.isCharacterDevice()) devices.set(fd, stat.rdev)
    } catch {}
  }
  return devices
}

// node-pty 1.1.0 맥 pty_posix_spawn 은 낮은 fd 를 채우려 연 /dev/ptmx 를 닫지 않는다(1.2.0-beta 에서 고침) — pane 마다 하나씩 쌓여
// kern.tty.ptmx_max 가 바닥나면 posix_spawnp failed. 띄우기 전후를 비교해 새로 생긴 ptmx 중 pane 의 master 가 아닌 것만 닫는다
// (spawn 은 동기라 그 사이 ptmx 를 여는 것은 node-pty 뿐 · 고친 판이면 남는 것이 없어 아무것도 안 한다)
function spawnPty(shell: string, options: Parameters<typeof pty.spawn>[2]): IPty {
  if (process.platform !== 'darwin') return pty.spawn(shell, ['-l'], options)
  let before: Map<number, number> | null = null
  try {
    before = charDevices()
  } catch {}
  const term = pty.spawn(shell, ['-l'], options)
  const master = (term as unknown as { fd?: unknown }).fd
  if (!before || typeof master !== 'number') return term
  try {
    const ptmxMajor = fs.fstatSync(master).rdev >> 24
    for (const [fd, rdev] of charDevices()) {
      if (fd === master || before.get(fd) === rdev || rdev >> 24 !== ptmxMajor) continue
      fs.closeSync(fd)
    }
  } catch {}
  return term
}

// 코드 교체 직후 한 번 — 고치기 전 코드(DAEMON_CODE 12 까지)가 쌓아 둔 고아 /dev/ptmx 를 닫는다(사용자 결정 2026-11-10).
// 데몬 안에서 ptmx 를 여는 것은 node-pty 뿐이라 살아 있는 pane 의 master(masters)가 아닌 ptmx 는 모두 고아다. 닫은 개수를 돌려준다
export function closeOrphanPtmx(masters: Iterable<number>): number {
  if (process.platform !== 'darwin') return 0
  const keep = new Set(masters)
  let closed = 0
  try {
    const ptmxMajor = fs.statSync('/dev/ptmx').rdev >> 24
    for (const [fd, rdev] of charDevices()) {
      if (keep.has(fd) || rdev >> 24 !== ptmxMajor) continue
      try {
        fs.closeSync(fd)
        closed += 1
      } catch {}
    }
  } catch {}
  return closed
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
  declare submitting?: boolean
  declare waiters: Set<Waiter>
  declare ptySize: { cols: number; rows: number }
  declare screen: InstanceType<typeof Terminal>
  declare mouseEncoding?: 1006 | 1016 | null
  declare mouseEncodingReady?: Promise<void>
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
    void this.prepareSnapshot()
    // 화면(renderer)의 xterm 과 같은 폭 규칙 — 이모지를 두 칸으로 센다
    this.screen.loadAddon(new Unicode11Addon())
    this.screen.unicode.activeVersion = '11'
    this.screen.onTitleChange((title) => (this.title = title || null))

    this.pty = spawnPty(shell, { name: 'xterm-256color', cols, rows, cwd, env })
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

  // serialize가 빠뜨리는 마우스 인코딩만 공개 parser API로 관찰한다.
  // xterm 6의 공개 모드 API에는 인코딩이 없다. 실제 parser에 조회를 쓰면 미완성 CSI를 끊으므로
  // 고정된 xterm의 읽기 전용 상태만 읽는다. 의존성 변경 시 복원 회귀가 이 계약을 확인한다.
  prepareSnapshot(): Promise<void> {
    if (this.mouseEncodingReady) return this.mouseEncodingReady
    const terminal = this.screen as unknown as { _core?: { coreMouseService?: { activeEncoding?: unknown } } }
    const encoding = terminal._core?.coreMouseService?.activeEncoding
    this.mouseEncoding = null
    if (encoding === 'SGR') this.mouseEncoding = 1006
    else if (encoding === 'SGR_PIXELS') this.mouseEncoding = 1016
    for (const final of ['h', 'l']) {
      this.screen.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        for (const mode of params) {
          if (mode === 1006 || mode === 1016) this.mouseEncoding = final === 'h' ? mode : null
        }
        return false // xterm의 원래 모드 처리도 계속한다.
      })
    }
    this.screen.parser.registerEscHandler({ final: 'c' }, () => {
      this.mouseEncoding = null
      return false
    })
    this.mouseEncodingReady = Promise.resolve()
    return this.mouseEncodingReady
  }

  // 앱이 다시 붙을 때 보낼 화면(색·커서·대체 화면·OSC 8 링크 포함)
  snapshot(): string {
    const encoding = this.mouseEncoding ? `\x1b[?${this.mouseEncoding}h` : ''
    return serializeWithLinks(this.serializer, SCROLLBACK) + encoding
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
