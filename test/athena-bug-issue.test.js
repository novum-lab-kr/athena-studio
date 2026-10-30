'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../athena/scripts/lib/athena-bug-issue.mjs')

test('FIELD_IDS 가 bug_report.yml 의 실제 필드 id 와 같다', async () => {
  const { FIELD_IDS, TEMPLATE } = await load()
  const yml = readFileSync(join(__dirname, '..', '.github', 'ISSUE_TEMPLATE', TEMPLATE), 'utf8')
  const ids = [...yml.matchAll(/^\s+id:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(FIELD_IDS, ids)
})

test('팩에 athena-studio 레포가 있을 때만 hasStudioRepo', async () => {
  const { hasStudioRepo } = await load()
  assert.equal(hasStudioRepo({ repos: [{ name: 'athena-studio' }] }), true)
  assert.equal(hasStudioRepo({ repos: [{ name: 'syung' }] }), false)
  assert.equal(hasStudioRepo({}), false)
})

test('redact: 경로 · 코드 · 비밀 · 메일 · 주소 · 회사 이름을 가린다', async () => {
  const { redact } = await load()
  const text = [
    'fail at /Users/kim/acme/pack/x.json and ~/work/a',
    '```js\nconst secret = 1\n```',
    'token=abcdef123456 mail a@acme.com git@github.com:acme/api.git https://acme.example/x',
    'Acme broke scripts/new-plan.mjs',
  ].join('\n')
  const out = redact(text, { names: ['acme'], paths: ['/opt/body'] })
  assert.ok(!/kim|acme|abcdef123456|const secret|a@/i.test(out), out)
  assert.ok(out.includes('scripts/new-plan.mjs'))
})

test('buildDraft: 템플릿 필드 id 로 주소를 만들고 길면 줄여 표시한다', async () => {
  const { buildDraft, TRUNCATED_MARK } = await load()
  const short = buildDraft({ title: 'bug', fields: { 'what-happened': 'x', steps: '1. a' } })
  const params = new URL(short.url).searchParams
  assert.equal(params.get('template'), 'bug_report.yml')
  assert.equal(params.get('what-happened'), 'x')
  assert.equal(short.truncated, false)
  const long = buildDraft({ title: 'bug', fields: { 'what-happened': '가'.repeat(5000), logs: 'b'.repeat(3000) } })
  assert.equal(long.truncated, true)
  assert.ok(long.url.length <= 6500)
  assert.ok(long.fields['what-happened'].endsWith(TRUNCATED_MARK) || long.fields.logs.endsWith(TRUNCATED_MARK))
})
