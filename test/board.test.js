const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const board = require('../src/main/board.mts')

// 앱이 띄운 일감은 pane 밖에서 화면 계층으로 pane 목록을 읽는다 — 접속 파일 자리를 넘겨야 개발판(daemon-dev.json)에서도 studio 가 골라진다
test('boardEnvExtra 는 데몬 소켓 · 접속 파일 · CLI · 본체 자리를 넘긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-studio-'))
  const paths = { socket: '/s/daemon.sock', endpoint: '/h/.athena-studio/daemon-dev.json' }
  const extra = board.boardEnvExtra({ port: 4814, paths, athenaDir: dir, nodePath: '/usr/bin/node' })
  assert.equal(extra.ATHENA_BOARD_PORT, '4814')
  assert.equal(extra.ATHENA_STUDIO_SOCKET, paths.socket)
  assert.equal(extra.ATHENA_STUDIO_ENDPOINT, paths.endpoint)
  assert.ok(extra.ATHENA_STUDIO_CLI.endsWith(path.join('bin', 'athena-studio-cli')))
  assert.equal(extra.ATHENA_STUDIO_NODE, process.execPath)
  assert.equal(extra.ATHENA_STUDIO_BODY, fs.realpathSync(dir))
  assert.equal(extra.ELECTRON_RUN_AS_NODE, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('boardEnvExtra 는 node 가 없으면 Electron 을 node 로 돌린다', () => {
  const extra = board.boardEnvExtra({ port: 1, paths: { socket: '/s', endpoint: '/e' }, athenaDir: os.tmpdir(), nodePath: null })
  assert.equal(extra.ELECTRON_RUN_AS_NODE, '1')
})
