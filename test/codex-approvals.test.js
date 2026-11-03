// 공식 승인 앱 클라이언트: 사용자 전용 Unix 연결·팩/pane/세대·클릭 결과를 검증한다.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { randomUUID } = require('node:crypto')
const { pendingApprovals, respondApproval, codexSessionCommand } = require('../src/lib/codex-approvals.mts')

async function fixture(t) {
  const root = fs.mkdtempSync('/tmp/athena-codex-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const body = path.join(root, 'body'), data = path.join(root, 'data')
  fs.mkdirSync(body); fs.mkdirSync(data)
  fs.symlinkSync(data, path.join(body, '.pack-data'))
  const registry = path.join(data, 'state', 'codex-connections')
  fs.mkdirSync(registry, { recursive: true, mode: 0o700 })
  const generation = randomUUID(), token = randomUUID(), socket = path.join(root, 'rpc.sock')
  const record = { socket, pane: 'p1', body: fs.realpathSync(body), generation }
  const approval = { token, generation, pane: 'p1', body: record.body, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread1', turnId: 'turn1', itemId: 'item1', command: 'echo fixture' }, choices: [{ key: 'accept' }, { key: 'decline' }] }
  const answers = []
  let active = true
  const server = http.createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    if (request.url === '/respond') {
      const answer = JSON.parse(text)
      const ok = active && answer.token === token && answer.generation === generation && answer.pane === 'p1' && answer.body === record.body
      if (ok) { active = false; answers.push(answer) }
      response.end(JSON.stringify({ ok }))
    } else response.end(JSON.stringify({ generation, requests: active ? [approval] : [] }))
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  fs.chmodSync(socket, 0o600)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const file = path.join(registry, generation + '.json')
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 })
  return { body, record, approval, answers, file, registry }
}

test('앱: 읽기/닫기는 응답 0 · 명시 선택은 같은 원래 연결에 1회', async (t) => {
  const item = await fixture(t)
  const pending = await pendingApprovals(item.body, new Set(['p1']))
  assert.equal(pending.length, 1)
  assert.deepEqual(item.answers, [])
  assert.equal(await respondApproval(item.body, pending[0], 1), true)
  assert.equal(await respondApproval(item.body, pending[0], 0), false)
  assert.equal(item.answers.length, 1)
  assert.equal(item.answers[0].choice, 1)
  assert.deepEqual(await pendingApprovals(item.body, new Set(['p1'])), [])
})

test('앱: 다른 pane·팩·세대·없는 선택지·동시 연결·느슨한 파일 권한은 거절', async (t) => {
  const item = await fixture(t)
  assert.deepEqual(await pendingApprovals(item.body, new Set(['other'])), [])
  assert.equal(await respondApproval(item.body, { ...item.approval, generation: randomUUID() }, 0), false)
  assert.equal(await respondApproval(item.body, { ...item.approval, body: '/other' }, 0), false)
  assert.equal(await respondApproval(item.body, { ...item.approval, pane: 'other' }, 0), false)
  for (const choice of [-1, 2, 0.5, NaN]) assert.equal(await respondApproval(item.body, item.approval, choice), false)
  const other = randomUUID()
  fs.writeFileSync(path.join(item.registry, other + '.json'), JSON.stringify({ ...item.record, generation: other }), { mode: 0o600 })
  assert.deepEqual(await pendingApprovals(item.body, new Set(['p1'])), [])
  assert.equal(await respondApproval(item.body, item.approval, 0), false)
  fs.unlinkSync(path.join(item.registry, other + '.json'))
  fs.chmodSync(item.file, 0o644)
  assert.deepEqual(await pendingApprovals(item.body, new Set(['p1'])), [])
  assert.deepEqual(item.answers, [])
})


test('새 실행·resume·따라잡기 명령은 같은 wrapper · 옛 본체/Claude 경로 보존', (t) => {
  const root = fs.mkdtempSync('/tmp/codex-command-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const body = path.join(root, "body with ' quote")
  fs.mkdirSync(path.join(body, 'scripts'), { recursive: true })
  assert.equal(codexSessionCommand(body, 'codex --no-daemon'), 'codex --no-daemon')
  fs.writeFileSync(path.join(body, 'scripts/codex-session.py'), '')
  for (const command of ['codex', 'codex --no-daemon', 'codex resume fixture', 'codex --no-daemon resume fixture']) {
    const wrapped = codexSessionCommand(body, command)
    assert.ok(wrapped.startsWith('python3 '))
    assert.ok(wrapped.endsWith(command.slice('codex'.length)))
    assert.equal(codexSessionCommand(body, wrapped), wrapped)
  }
  assert.equal(codexSessionCommand(body, 'claude --resume fixture'), 'claude --resume fixture')
})
