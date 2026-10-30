const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { socketPath } = require('../src/daemon/cli')

// 격리 실행(ATHENA_STUDIO_HOME)에서도 pane 셸에 남은 ATHENA_STUDIO_SOCKET 이 사용자 데몬을 부르던 것(isolated-cli-socket)
const homeWith = (fileName, socket) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-cli-socket-'))
  fs.writeFileSync(path.join(home, fileName), JSON.stringify({ socket }))
  return home
}

test('ATHENA_STUDIO_HOME 이 있으면 pane 의 ATHENA_STUDIO_SOCKET 보다 그 집의 접속 파일(개발 앱 daemon-dev.json)이 먼저', () => {
  const home = homeWith('daemon-dev.json', '/iso/dev.sock')
  assert.equal(socketPath({ ATHENA_STUDIO_SOCKET: '/user/real.sock', ATHENA_STUDIO_HOME: home }), '/iso/dev.sock')
})

test('ATHENA_STUDIO_HOME — 배포판 daemon.json 도 읽고 개발 앱 파일이 있으면 그쪽이 먼저', () => {
  const home = homeWith('daemon.json', '/iso/release.sock')
  assert.equal(socketPath({ ATHENA_STUDIO_HOME: home }), '/iso/release.sock')
  fs.writeFileSync(path.join(home, 'daemon-dev.json'), JSON.stringify({ socket: '/iso/dev.sock' }))
  assert.equal(socketPath({ ATHENA_STUDIO_HOME: home }), '/iso/dev.sock')
})

test('ATHENA_STUDIO_HOME 의 접속 파일이 없으면 사용자 데몬(ATHENA_STUDIO_SOCKET)으로 돌아가지 않고 못 찾음', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-cli-socket-'))
  assert.equal(socketPath({ ATHENA_STUDIO_SOCKET: '/user/real.sock', ATHENA_STUDIO_HOME: home }), null)
})

test('ATHENA_STUDIO_ENDPOINT 를 따로 주면 그 파일이 먼저(HOME 이 있어도)', () => {
  const home = homeWith('daemon-dev.json', '/iso/dev.sock')
  const endpoint = path.join(homeWith('x.json', '/explicit/e.sock'), 'x.json')
  assert.equal(socketPath({ ATHENA_STUDIO_HOME: home, ATHENA_STUDIO_ENDPOINT: endpoint }), '/explicit/e.sock')
})

test('격리하지 않으면 지금처럼 ATHENA_STUDIO_SOCKET 이 먼저', () => {
  assert.equal(socketPath({ ATHENA_STUDIO_SOCKET: '/user/real.sock' }), '/user/real.sock')
})
