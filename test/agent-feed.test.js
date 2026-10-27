const test = require('node:test')
const assert = require('node:assert/strict')
const feed = require('../src/lib/agent-feed')

test('기록 한 줄 → 이벤트: 도구 · 말 · 사용자 지시(시스템 메시지는 뺀다)', () => {
  const tool = {
    type: 'assistant',
    timestamp: '2026-10-17T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: '테스트 돌리기' } }, { type: 'text', text: '확인할게요\n다음' }] },
  }
  assert.deepEqual(feed.eventsFromRecord(tool), [
    { kind: 'tool', icon: '⚙', name: 'Bash', text: '테스트 돌리기', at: '2026-10-17T12:00:00.000Z' },
    { kind: 'say', icon: '💬', name: '', text: '확인할게요 다음', at: '2026-10-17T12:00:00.000Z' },
  ])
  assert.equal(feed.eventsFromRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.js' } }] } })[0].text, '/a/b.js')
  assert.equal(feed.eventsFromRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Zap', input: { q: 1 } }] } })[0].icon, '•')
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', message: { content: '  버그 고쳐줘 ' } }).map((event) => event.text), ['버그 고쳐줘'])
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }), [])
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', isMeta: true, message: { content: '메타' } }), [])
  // 도구 결과(사용자 쪽 목록)와 짧은 말 · 이상한 값은 건너뛴다
  assert.deepEqual(feed.eventsFromRecord({ type: 'user', message: { content: [{ type: 'tool_result', content: '...' }] } }), [])
  assert.deepEqual(feed.eventsFromRecord({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }), [])
  assert.deepEqual(feed.eventsFromRecord(null), [])
  // 요청 본문 기록은 같은 content 를 담아도 건너뛴다
  assert.deepEqual(feed.eventsFromRecord({ type: 'api-request-blob', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }), [])
})

test('세션 이름표 · 줄 읽기 · 폴더 이름', () => {
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/athena/.worktrees/web/feature-x/src', gitBranch: 'feature/x' }), 'web·feature/x')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/novum-lab/athena-studio', gitBranch: 'main' }), 'athena-studio·main')
  // 여러 팩 구조 — 워크트리는 스튜디오 집 데이터 폴더(packs/<팩>/worktrees/<레포>/<슬러그>) · 하위 폴더에서 연 세션도 같은 레포
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/data/packs/novum-lab/worktrees/athena-studio/feat-modern-code-rules', gitBranch: 'feat/modern-code-rules' }), 'athena-studio·feat/modern-code-rules')
  assert.equal(feed.sessionLabel({ cwd: '/Users/me/.athena-studio/data/packs/novum-lab/worktrees/athena-studio/feat-modern-code-rules/src/lib', gitBranch: 'feat/modern-code-rules' }), 'athena-studio·feat/modern-code-rules')
  assert.equal(feed.sessionLabel({}), null)
  assert.deepEqual(feed.subagentInfo({ description: 'Fill skeleton: web', agentType: 'general-purpose', finished: true }), { label: '🤖 Fill skeleton: web', finished: true })
  assert.deepEqual(feed.subagentInfo({ agentType: 'reviewer' }), { label: '🤖 reviewer', finished: false })
  assert.deepEqual(feed.subagentInfo(null), { label: null, finished: false })
  assert.equal(feed.parseLine('{"a":1}').a, 1)
  assert.equal(feed.parseLine('{깨짐'), null)
  assert.equal(feed.projectDirName('/Users/me/Library/Application Support/Athena Studio/athena'), '-Users-me-Library-Application-Support-Athena-Studio-athena')
})
