// pane 스냅숏의 OSC 8 링크 — 스냅숏을 새 터미널에 쓰면 같은 칸이 같은 주소의 링크여야 한다(맥 앱 · 폰이 다시 붙을 때 같은 스냅숏을 쓴다)
// @xterm/addon-serialize 는 링크를 버린다 — 판을 올려 내부 이름이 바뀌면 여기서 링크 복원이 깨진다
const test = require('node:test')
const assert = require('node:assert/strict')

const PANE_MODULE = process.env.PANE_SNAPSHOT_MODULE || '../src/daemon/pane.mts'
const { Pane, SCROLLBACK } = require(PANE_MODULE)
const { Terminal } = require('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize')

const write = (term, data) => new Promise((resolve) => term.write(data, resolve))
const link = (uri, text, id) => `\x1b]8;${id ? `id=${id}` : ''};${uri}\x1b\\${text}\x1b]8;;\x1b\\`

// 코드 교체 전부터 있던 pane 처럼 — 화면 버퍼와 애드온만 가진 Pane
function makePane(cols, rows) {
  const screen = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  return Object.assign(Object.create(Pane.prototype), { screen, serializer })
}

// 칸마다 글자 · 폭 · 글자 속성 · 링크 주소(와 같은 링크끼리 묶임) — 두 터미널을 비교한다
function cells(term, which, { groups: keepGroups = true } = {}) {
  const buffer = term.buffer[which]
  const service = term._core._oscLinkService
  const groups = new Map()
  const out = []
  const cell = buffer.getNullCell()
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    for (let col = 0; col < term.cols; col++) {
      line.getCell(col, cell)
      const urlId = cell.hasExtendedAttrs() ? cell.extended.urlId : 0
      let uri = ''
      if (urlId) {
        if (!groups.has(urlId)) groups.set(urlId, groups.size)
        uri = service.getLinkData(urlId).uri + (keepGroups ? `#${groups.get(urlId)}` : '')
      }
      const style = [cell.getFgColor(), cell.getBgColor(), cell.isBold(), cell.isUnderline(), cell.isInverse(), cell.isItalic()]
      out.push(`${row}:${col} ${JSON.stringify(cell.getChars())} w${cell.getWidth()} ${style.join(',')} ${uri}`)
    }
  }
  return out
}

function linkAt(term, row, col) {
  const cell = term.buffer.active.getLine(row).getCell(col)
  const urlId = cell.hasExtendedAttrs() ? cell.extended.urlId : 0
  return urlId ? term._core._oscLinkService.getLinkData(urlId).uri : null
}

async function restore(pane) {
  const restored = new Terminal({ cols: pane.screen.cols, rows: pane.screen.rows, scrollback: SCROLLBACK, allowProposedApi: true })
  await write(restored, pane.snapshot())
  return restored
}

test('재현: printf 한 OSC 8 링크가 스냅숏에 실리고 새 터미널에서 같은 칸이 같은 주소의 링크다', async () => {
  const pane = makePane(80, 10)
  await write(pane.screen, '\x1b]8;;https://expo.dev\x1b\\link\x1b]8;;\x1b\\\r\n')
  const snapshot = pane.snapshot()
  assert.ok(snapshot.includes('\x1b]8;;https://expo.dev\x1b\\'), `스냅숏에 OSC 8 이 없다: ${JSON.stringify(snapshot)}`)
  const restored = await restore(pane)
  assert.deepEqual(cells(restored, 'normal'), cells(pane.screen, 'normal'))
  for (let col = 0; col < 4; col++) assert.equal(linkAt(restored, 0, col), 'https://expo.dev')
  assert.equal(linkAt(restored, 0, 4), null)
  pane.screen.dispose()
  restored.dispose()
})

test('여러 줄 · 지난 출력 · 색 · 두 칸 글자 · id 있는 링크를 칸 그대로 되살린다', async () => {
  const pane = makePane(30, 5)
  const long = `https://example.com/${'a'.repeat(40)}`
  let text = ''
  text += `앞 ${link('https://one.dev', 'one')} 사이 \x1b[31m${link('https://two.dev', 'red')}\x1b[0m 끝\r\n`
  text += `${link(long, long)}\r\n` // 줄을 넘겨 이어지는 링크 — 한 링크로 묶여야 한다
  text += `${link('https://wide.dev', '한글링크')} ${link('https://id.dev', 'A', 'grp')}x${link('https://id.dev', 'B', 'grp')}\r\n`
  for (let index = 0; index < 12; index++) text += `줄 ${index}\r\n` // 위 링크들을 지난 출력으로 밀어 올린다
  text += `마지막 ${link('https://last.dev', 'last')}`
  await write(pane.screen, text)
  const restored = await restore(pane)
  assert.deepEqual(cells(restored, 'normal'), cells(pane.screen, 'normal'))
  assert.equal(restored.buffer.active.cursorX, pane.screen.buffer.active.cursorX)
  assert.equal(restored.buffer.active.cursorY, pane.screen.buffer.active.cursorY)
  // 이어지는 출력은 링크가 아니다
  await write(restored, 'tail')
  await write(pane.screen, 'tail')
  assert.deepEqual(cells(restored, 'normal'), cells(pane.screen, 'normal'))
  pane.screen.dispose()
  restored.dispose()
})

test('대체 화면의 링크도 되살린다', async () => {
  const pane = makePane(40, 6)
  await write(pane.screen, `셸 ${link('https://normal.dev', 'n')}\r\n\x1b[?1049h\x1b[H`)
  await write(pane.screen, `전체 화면 ${link('https://alt.dev', 'alt')} 뒤`)
  const restored = await restore(pane)
  assert.equal(restored.buffer.active.type, 'alternate')
  assert.deepEqual(cells(restored, 'alternate'), cells(pane.screen, 'alternate'))
  assert.deepEqual(cells(restored, 'normal'), cells(pane.screen, 'normal'))
  pane.screen.dispose()
  restored.dispose()
})

test('프로그램이 링크를 연 채면 이어 쓴 글도 같은 주소, 닫은 뒤에는 링크가 아니다', async () => {
  const pane = makePane(40, 6)
  await write(pane.screen, `앞 ${link('https://before.dev', 'b')} \x1b]8;;https://open.dev\x1b\\열림`)
  const restored = await restore(pane)
  assert.deepEqual(cells(restored, 'normal'), cells(pane.screen, 'normal'))
  await write(restored, 'X\x1b]8;;\x1b\\Y')
  await write(pane.screen, 'X\x1b]8;;\x1b\\Y')
  // id 없는 링크를 스냅숏 끝에서 다시 열면 xterm 이 새 링크로 등록한다 — 주소 · 밑줄만 같으면 된다(호버 묶음만 나뉜다)
  assert.deepEqual(cells(restored, 'normal', { groups: false }), cells(pane.screen, 'normal', { groups: false }))
  pane.screen.dispose()
  restored.dispose()
})

test('링크가 없는 화면은 스냅숏이 애드온 그대로다', async () => {
  const pane = makePane(40, 6)
  await write(pane.screen, '\x1b[1;32m초록\x1b[0m 일반\r\n\x1b[44m  배경  \x1b[0m')
  // 비교는 따로 붙인 애드온으로 — pane 의 애드온은 snapshot() 이 링크 직렬화를 끼운다
  const plain = new SerializeAddon()
  pane.screen.loadAddon(plain)
  assert.equal(pane.snapshot(), plain.serialize({ scrollback: SCROLLBACK }))
  pane.screen.dispose()
})
