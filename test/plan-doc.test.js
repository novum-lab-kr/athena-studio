// 계획서 md → 화면 조각(src/lib/plan-doc.mts) — [작업] 계획서 화면이 그리는 절 · 목록 · 표 · 코드 · 꾸밈
const test = require('node:test')
const assert = require('node:assert/strict')
const { planSteps, planCommits, planBlocks, planSections, inlineParts } = require('../src/lib/plan-doc.mts')
const { planDetail } = require('../src/lib/work-model.mts')

const PLAN = [
  '# 계획서 보기',
  '',
  '## Checkpoint',
  '- Status: in_progress',
  '',
  '### Progress',
  '- [x] 1단계 **브리지** → 확인: `시험`',
  '  - 구현 메모(체크 칸 아님)',
  '- [ ] 2단계 화면',
  '- [ ] (작업) → 확인: (방법) → 성공 조건: (기대 결과)',
  '',
  '### Next',
  '1. 다음 일',
  '',
  '## 지시',
  '요청: 줄을 누르면 계획서 (←1)',
  '- 할 것: 6절',
  '  - 멈춤: 화면 확인',
  '',
  '## 3. API',
  '| 요청 | 받는 값 |',
  '|---|---|',
  '| `a|b` 읽기 | md 전문 |',
  '',
  '```bash',
  '## 제목이 아니다',
  'npm test',
  '```',
  '> 근거: 코드',
].join('\n')
const TEMPLATE = ['- [ ] (작업) → 확인: (방법) → 성공 조건: (기대 결과)']

test('planSteps — Progress 의 체크 줄을 순서대로 · 꾸밈은 걷고 · 템플릿 자리 줄 · 체크 칸 아닌 줄은 뺀다', () => {
  assert.deepEqual(planSteps(PLAN, TEMPLATE), [
    { done: true, text: '1단계 브리지 → 확인: 시험' },
    { done: false, text: '2단계 화면' },
  ])
  assert.deepEqual(planSteps('', TEMPLATE), [])
  assert.deepEqual(planSteps(null), [])
})

test('planSteps — 줄 수 · 끝난 수가 [작업] 요약(planDetail progress)과 같다', () => {
  const steps = planSteps(PLAN, TEMPLATE)
  const { progress } = planDetail(PLAN, TEMPLATE)
  assert.equal(steps.length, progress.total)
  assert.equal(steps.filter((step) => step.done).length, progress.checked)
})

test('planCommits — Commits 절의 줄(### · ## 둘 다) · 템플릿 자리 글 · 없는 절은 빈 목록', () => {
  assert.deepEqual(planCommits('## Checkpoint\n### Commits\n- (scripts/commit.sh 가 적는다)\n\n## 지시\n- 다른 절'), [])
  assert.deepEqual(planCommits('### Commits\n- 2026-11-21 10:00 · athena-studio · `abc1234` — feat: 화면\n- 둘째\n## 지시\n- 다른 절'), ['2026-11-21 10:00 · athena-studio · `abc1234` — feat: 화면', '둘째'])
  assert.deepEqual(planCommits('## Commits\n- 경량 줄'), ['경량 줄'])
  assert.deepEqual(planCommits('## 지시\n- 없음'), [])
})

test('planSections — "## " 마다 절 · skip 한 절은 빼고 · 코드 블록 안의 ## 는 제목이 아니다', () => {
  const sections = planSections(PLAN, ['Checkpoint'])
  assert.deepEqual(sections.map((section) => section.title), ['지시', '3. API'])
  assert.deepEqual(planSections(PLAN).map((section) => section.title), ['Checkpoint', '지시', '3. API'])
  const [order, api] = sections
  assert.deepEqual(order.blocks, [
    { kind: 'para', text: '요청: 줄을 누르면 계획서 (←1)' },
    { kind: 'list', items: [
      { text: '할 것: 6절', check: null, depth: 0, ordered: false },
      { text: '멈춤: 화면 확인', check: null, depth: 1, ordered: false },
    ] },
  ])
  assert.deepEqual(api.blocks, [
    { kind: 'table', head: ['요청', '받는 값'], rows: [['`a|b` 읽기', 'md 전문']] },
    { kind: 'code', text: '## 제목이 아니다\nnpm test' },
    { kind: 'quote', text: '근거: 코드' },
  ])
})

test('planSections — 첫 절 앞의 글은 제목 없는 절로 · 문서 제목 줄은 뺀다 · 빈 글은 빈 목록', () => {
  assert.deepEqual(planSections('# 제목\n머리글\n\n## 절\n본문'), [
    { title: '', blocks: [{ kind: 'para', text: '머리글' }] },
    { title: '절', blocks: [{ kind: 'para', text: '본문' }] },
  ])
  assert.deepEqual(planSections(''), [])
  assert.deepEqual(planSections(undefined), [])
})

test('planBlocks — 체크 목록 · 번호 목록 · ### 작은 제목 · 닫지 않은 코드 블록 · 표 모양이 아닌 | 줄', () => {
  assert.deepEqual(planBlocks(['### 작은 **제목**', '- [x] 끝', '- [ ] 남음', '1. 첫째', '', '| 표 아님 |', '```', '끝까지 코드']), [
    { kind: 'heading', text: '작은 제목' },
    { kind: 'list', items: [
      { text: '끝', check: true, depth: 0, ordered: false },
      { text: '남음', check: false, depth: 0, ordered: false },
      { text: '첫째', check: null, depth: 0, ordered: true },
    ] },
    { kind: 'para', text: '| 표 아님 |' },
    { kind: 'code', text: '끝까지 코드' },
  ])
})

test('inlineParts — 코드 · 굵게 · 링크 · 맨 주소 · 코드 안 꾸밈은 그대로 · http(s) 아닌 링크는 글자로', () => {
  assert.deepEqual(inlineParts('앞 `a **b**` 와 **굵게** [문서](https://example.com/a) https://github.com/a/b/pull/1 끝'), [
    { kind: 'text', text: '앞 ' },
    { kind: 'code', text: 'a **b**' },
    { kind: 'text', text: ' 와 ' },
    { kind: 'bold', text: '굵게' },
    { kind: 'text', text: ' ' },
    { kind: 'link', text: '문서', href: 'https://example.com/a' },
    { kind: 'text', text: ' ' },
    { kind: 'link', text: 'https://github.com/a/b/pull/1', href: 'https://github.com/a/b/pull/1' },
    { kind: 'text', text: ' 끝' },
  ])
  assert.deepEqual(inlineParts('[위험](javascript:alert(1)) [파일](file:///etc/passwd)'), [{ kind: 'text', text: '[위험](javascript:alert(1)) [파일](file:///etc/passwd)' }])
  assert.deepEqual(inlineParts(''), [])
})
