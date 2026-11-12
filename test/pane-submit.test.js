const test = require('node:test')
const assert = require('node:assert/strict')
const { submitText, inputOf } = require('../src/lib/pane-submit.mts')

const codex = (input) => ({ agent: 'codex', text: `대화\n› ${input}\n\n  GPT-6.1-Sol medium · /repo\n` })
const paste = (text) => `\x1b[200~${text}\x1b[201~`
const claude = (input) => ({ agent: 'claude', text: `대화\n────────\n❯ ${input}\n────────\n Opus 5.5\n` })

function fake({ ignore = 0, render = codex, after, agent = 'codex', initial = '' } = {}) {
  let snapshot = agent ? render(initial) : { agent: null, text: '$ ' }
  let enters = 0
  const writes = []
  return {
    writes,
    read: async () => snapshot,
    sleep: async () => {},
    write: (value) => {
      writes.push(value)
      if (value !== '\r') snapshot = render(value.replace(/^\x1b\[200~|\x1b\[201~$/g, ''))
      else if (++enters > ignore) snapshot = after || render('')
    },
  }
}

test('Codex · Claude 입력칸을 맺음 줄 전까지만 읽는다', () => {
  assert.equal(inputOf(codex('[Pasted Content 2761 chars]')), '[Pasted Content 2761 chars]')
  assert.equal(inputOf(claude('Try "test"')), 'Try "test"')
  assert.equal(inputOf({ agent: 'codex', text: '확인 못 한 화면' }), null)
})

test('Codex 입력칸 안의 빈 줄은 경계가 아니다 — 맨 아래 단축키 줄 · 상태줄까지 읽는다', () => {
  // 빈 줄로 시작하는 여러 줄 초안 — 첫 빈 줄에서 끊으면 빈 입력칸으로 읽었다(코어 pane-close.mjs · lead-fresh.py 와 같은 규칙)
  const draft = '• 끝났다\n\n› \n\n  초안\n\n  둘째\n\n  GPT-6.1-Sol medium · /repo\n  ? for shortcuts\n'
  assert.equal(inputOf({ agent: 'codex', text: draft }), '초안\n\n  둘째')
  assert.equal(inputOf({ agent: 'codex', text: '• 끝났다\n\n› \n\n  ← for agents · ? for shortcuts\n' }), '')
  assert.equal(inputOf(codex('')), '')
  // 단축키 줄 · 상태줄이 없는 화면은 예전처럼 첫 빈 줄까지
  assert.equal(inputOf({ agent: 'codex', text: '› 같은 글\n\n footer' }), '같은 글')
})

test('첫 Enter 무시 → 글은 한 번만 · Enter 재시도 뒤 입력칸 비움 확인', async () => {
  const pane = fake({ ignore: 1 })
  await submitText('긴 글\n두 번째 줄', pane)
  assert.deepEqual(pane.writes, [paste('긴 글\n두 번째 줄'), '\r', '\r'])
})

test('끝내 전송 실패 → timeout · Enter 는 세 번까지만', async () => {
  const pane = fake({ ignore: Infinity })
  await assert.rejects(submitText('전송 실패', pane), { code: 'timeout' })
  assert.deepEqual(pane.writes, [paste('전송 실패'), '\r', '\r', '\r'])
})

test('화면 재출력 · working 글자만으로는 성공하지 않는다', async () => {
  const pane = fake({ after: { agent: 'codex', text: 'Working · esc to interrupt\n› 같은 글\n\n footer' } })
  await assert.rejects(submitText('같은 글', pane), { code: 'timeout' })
})

test('Claude 전송 · /exit 후 셸 · 셸 한 번 쓰기', async () => {
  const pane = fake({ render: claude })
  await submitText('Claude 시험', pane)
  assert.deepEqual(pane.writes, [paste('Claude 시험'), '\r'])
  await submitText('/exit', fake({ render: claude, after: { agent: null, text: '$ ' } }))
  const shell = fake({ agent: null })
  await submitText('echo ok', shell)
  assert.deepEqual(shell.writes, ['echo ok\r'])
})

test('질문 화면 · 모르는 화면에서는 Enter 를 재시도하지 않는다', async () => {
  for (const after of [{ ...codex('글'), waiting: true }, { agent: 'codex', text: '화면 전환' }]) {
    const pane = fake({ after })
    await assert.rejects(submitText('글', pane), { code: 'timeout' })
    assert.deepEqual(pane.writes, [paste('글'), '\r'])
  }
})

test('기존 입력에 Enter 만 보내도 확인 · 재시도하고 글은 다시 쓰지 않는다', async () => {
  const pane = fake({ initial: '남은 글', ignore: 1 })
  await submitText('', pane)
  assert.deepEqual(pane.writes, ['\r', '\r'])
})

test('처음부터 질문이면 글도 Enter 도 보내지 않는다', async () => {
  const writes = []
  await assert.rejects(submitText('글', {
    read: async () => ({ ...codex('선택'), waiting: true }),
    write: (value) => writes.push(value),
  }), { code: 'unavailable' })
  assert.deepEqual(writes, [])
})

test('/exit 화면이 먼저 사라지고 프로세스 판정이 늦어도 추가 Enter 없이 기다린다', async () => {
  let reads = 0
  const writes = []
  await submitText('/exit', {
    read: async () => {
      const index = reads++
      if (index === 0) return claude('')
      if (index === 1) return claude('/exit')
      return index < 12 ? { agent: 'claude', text: 'Resume this session with:' } : { agent: null, text: '$ ' }
    },
    write: (value) => writes.push(value),
    sleep: async () => {},
  })
  assert.deepEqual(writes, [paste('/exit'), '\r'])
})

// 코어 scripts/lead-send.py 는 이 두 거절(글을 쓰기 전)만 "모아 뒀다 다시 넣기" 로 본다 — 다른 오류는 글이 들어갔을 수 있어 다시 넣지 않는다.
// 데몬 쪽 글을 바꾸면 lead-send.py NOT_WRITTEN 도 같이 바꾼다
test('lead-send.py 가 다시 넣어도 되는 거절로 보는 글이 데몬 글과 같다', async () => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const root = join(__dirname, '..')
  const leadSend = readFileSync(join(root, 'athena/scripts/lead-send.py'), 'utf8')
  const daemon = readFileSync(join(root, 'src/daemon/daemon.mts'), 'utf8')
  const waiting = await submitText('x', { read: async () => ({ ...claude(''), waiting: true }), write: () => {} }).catch((error) => error)
  assert.equal(waiting.code, 'unavailable')
  assert.ok(leadSend.includes(`'${waiting.message}'`))
  const busy = daemon.match(/pane\.submitting\) throw failure\('unavailable', '([^']+)'\)/)?.[1]
  assert.ok(busy)
  assert.ok(leadSend.includes(`'${busy}'`))
})

// 2026-11-08 실제 Claude working pane: Enter 뒤 본문은 큐로 옮겨지고 입력칸은 이 안내로 바뀐다.
const queuedClaude = (text) => ({ agent: 'claude', text: `❯ ${text}\n  ctrl+x ctrl+s to send now\n\n· Cogitating…\n────────\n❯ Press up to edit queued messages\n────────\n Opus 5.5\n` })

test('Claude working 중 큐에 들어간 글은 안내 문구가 남아도 전송 성공이다', async () => {
  const pane = fake({ render: claude, after: queuedClaude('working 전송') })
  await submitText('working 전송', pane)
  assert.equal(inputOf(queuedClaude('working 전송')), '')
  assert.deepEqual(pane.writes, [paste('working 전송'), '\r'])
})

test('큐 안내와 같은 글만 입력한 화면은 빈 입력으로 보지 않는다', () => {
  assert.equal(inputOf(claude('Press up to edit queued messages')), 'Press up to edit queued messages')
})
