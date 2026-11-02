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
