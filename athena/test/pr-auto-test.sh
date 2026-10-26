#!/usr/bin/env bash
# PR 자동 리뷰 시험 — scripts/lib/pr-auto.mjs 의 판정 · 계획서 표시 줄 · 대상 고르기와 scripts/pr-auto.mjs 의 리뷰어 실행을
# 가짜 claude · codex 로 본다(GitHub · 진짜 LLM · 본체를 건드리지 않는다 · 몇 초)
#
# 사용: test/pr-auto-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#
# 보는 것(docs/pr-auto.md): 둘 다 승인해야 승인 · 하나라도 실패 · 없음 · 반려면 머지 안 함 · 모순된 답(승인인데 지적)은 승인으로 안 셈 ·
# 같은 HEAD 는 한 번만 · 멈춤 · 머지됨은 다시 안 돎 · 표시 줄 바꿔 쓰기 · 레포 하나짜리만 · 켠 레포만(main 직접 제외) · 댓글의 비밀값 가림 ·
# 머지 확인 — 키 없음 · true 면 확인 요청 · false 면 요청 없이 바로 머지(그새 새 커밋 · 검증 실패면 안 함 · 가짜 gh) ·
# 가짜 리뷰어 — 둘 다 답 · 명령 없음 · 시간 넘김 · 모양이 틀린 답 · 모델(models.prReview → --model) ·
# 사람에게 넘기지 않기(2026-10-26 결정 A · B · C) — 결정이 있어도 수정은 보냄 · 구현 세부 결정은 추천안으로 자동 확정 · 상한 뒤 이어받아 검증만으로 머지 ·
# 안 정한 결정이 결정 콘솔에 있으면 머지 안 함 · 지적은 한 번에(결정 D — 2라운드는 지난 지적 + 지난 HEAD 이후 diff) · 막는 지적만 막기(결정 E — 권장만이면 승인)
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-pr-auto-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0

node --input-type=module - <<'EOF' || FAIL=1
import { aggregate, autoLines, autoMergeRepos, inheritedResult, lineupNote, mergeNotice, needsReview, nextRound, priorApproval, reviewComment, reviewerBrief, reviewerSlots, singleRepoPlan, skipsMergeConfirm, validReview, withAutoLine, workRefOf, BODY_EDITED, REVIEWERS, autoDecisionLine, fixInstruction, grantsTakeover, isTakeoverRound, pendingDecisionLine, takeoverEligible, withPendingDecisionLine, withoutPendingDecisionLine, takeoverComment, withDecisionLines, MAX_ROUNDS, TAKEOVER } from './scripts/lib/pr-auto.mjs'
import { maskSecrets } from './scripts/lib/mask.mjs'
let pass = 0, fail = 0
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✔ ${name}`) } else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ''}`) } }
const approve = { verdict: 'approve', summary: '좋다', findings: [], decisions: [] }
const changes = { verdict: 'changes', summary: '고칠 것', findings: [{ file: 'a.js', line: 3, problem: 'p', fix: 'f', severity: 'blocking' }], decisions: [] }
const advisory = { verdict: 'changes', summary: '권장', findings: [{ file: 'c.js', line: 5, problem: '이름이 길다', fix: '줄인다', severity: 'advisory' }], decisions: [] }
const decision = { verdict: 'decision', summary: '정할 것', findings: [], decisions: [{ title: 't', why: 'w', options: [{ label: 'A', desc: '' }, { label: 'B', desc: '' }], recommended: 'A', kind: 'product' }] }
const implDecision = (extra = {}) => ({ ...decision, decisions: [{ ...decision.decisions[0], title: '아이콘 자리', kind: 'implementation', ...extra }] })
const ok = (name, review) => ({ name, status: 'ok', review: validReview(review) })

console.log('\n판정(결정 D2 — Claude · Codex 둘 다 승인)')
check('리뷰어는 claude · codex 둘', JSON.stringify(REVIEWERS) === '["claude","codex"]')
check('둘 다 승인 → 승인', aggregate([ok('claude', approve), ok('codex', approve)]).verdict === 'approve')
check('하나 실패 → 리뷰어 부족(남은 하나로 판정하지 않음)', aggregate([ok('claude', approve), { name: 'codex', status: 'failed', reason: 'x' }]).verdict === 'insufficient')
check('하나 설치 안 됨 → 리뷰어 부족', aggregate([ok('claude', approve), { name: 'codex', status: 'unavailable', reason: '설치 안 됨' }]).verdict === 'insufficient')
check('하나 반려 → 수정 필요', aggregate([ok('claude', approve), ok('codex', changes)]).verdict === 'changes')
check('결정이 하나라도 → 결정 필요(수정보다 먼저)', aggregate([ok('claude', changes), ok('codex', decision)]).verdict === 'decision')
check('반려 + 실패 → 수정 필요(고칠 건 보낸다)', aggregate([ok('claude', changes), { name: 'codex', status: 'failed', reason: 'x' }]).verdict === 'changes')
check('승인인데 지적이 있으면 수정 필요로', validReview({ ...approve, findings: changes.findings }).verdict === 'changes')
check('모양이 틀린 답은 버림(모르는 결론 · 지적 없는 수정 필요 · 선택지 없는 결정)', !validReview({ verdict: 'ok', summary: '' }) && !validReview({ ...changes, findings: [] }) && !validReview({ ...decision, decisions: [] }))
check('빠지거나 틀린 칸이 하나라도 있으면 버림 — 승인으로 세지 않음(배열 없음 · 항목 칸 빠짐 · 선택지 하나)',
  !validReview({ verdict: 'approve', summary: '좋다' })
  && !validReview({ ...approve, findings: [{ file: 'a.js', line: 1, problem: 'p' }] })
  && !validReview({ ...changes, findings: [{ ...changes.findings[0], severity: undefined }] })
  && !validReview({ ...changes, findings: [{ ...changes.findings[0], severity: 'minor' }] })
  && !validReview({ ...changes, findings: [...changes.findings, { problem: 'p' }] })
  && !validReview({ ...decision, decisions: [{ ...decision.decisions[0], options: [{ label: 'A', desc: '' }] }] }))
check('결정에 kind 가 없거나 모르는 값이면 버림', !validReview({ ...decision, decisions: [{ ...decision.decisions[0], kind: undefined }] }) && !validReview({ ...decision, decisions: [{ ...decision.decisions[0], kind: 'ux' }] }))

console.log('\n막는 지적만 막기(2026-10-26 결정 E)')
const advSum = aggregate([ok('claude', approve), ok('codex', advisory)])
check('E — 권장(advisory)만 남으면 승인 · 보낼 지적 없음 · 권장은 따로', advSum.verdict === 'approve' && advSum.approvals === 2 && advSum.findings.length === 0 && advSum.advisories.length === 1, JSON.stringify(advSum))
check('E — 승인 + 권장 지적은 승인 그대로 · 승인 + 막는 지적은 수정 필요', validReview({ ...approve, findings: advisory.findings }).verdict === 'approve' && validReview({ ...approve, findings: changes.findings }).verdict === 'changes')
const both = aggregate([ok('claude', changes), ok('codex', advisory)])
check('E — 막음 + 권장 → 수정 필요 · 보낼 지적은 막음만', both.verdict === 'changes' && both.findings.length === 1 && both.findings[0].severity === 'blocking' && both.advisories.length === 1)
const advComment = reviewComment({ sha: 'abcdef1', round: 1, results: [ok('claude', changes), ok('codex', advisory)], summary: both })
check('E — 댓글에 ⛔ 막음 · 💡 권장 표시 · 권장은 머지를 막지 않는다는 줄', advComment.includes('⛔ 막음 `a.js:3`') && advComment.includes('💡 권장 `c.js:5`') && advComment.includes('권장 1개는 머지를 막지 않는다'), advComment)
const advInstr = fixInstruction({ agent: 'web-fe', org: 'acme', repo: 'web', number: '7', sha: 'abcdef1', round: 1, findings: both.findings, plan: 'p', worktree: '/wt', athenaDir: '/a' })
check('E — 수정 지시에 권장은 없다', advInstr.includes('a.js:3') && !advInstr.includes('c.js'), advInstr)

console.log('\n사람에게 넘기지 않기(2026-10-26 결정 A · B · C)')
const autoSum = aggregate([ok('claude', approve), ok('codex', implDecision())])
check('B — 구현 세부 + 추천이 선택지에 있음 → 자동 확정 · 수정 필요(사람 결정 없음)', autoSum.verdict === 'changes' && autoSum.autoDecisions.length === 1 && autoSum.decisions.length === 0, JSON.stringify(autoSum))
check('B — 제품 · 계약 결정 · 추천 없음 · 추천이 선택지에 없음 → 사람(결정 필요)',
  aggregate([ok('claude', approve), ok('codex', decision)]).verdict === 'decision'
  && aggregate([ok('claude', approve), ok('codex', implDecision({ recommended: '' }))]).verdict === 'decision'
  && aggregate([ok('claude', approve), ok('codex', implDecision({ recommended: 'C' }))]).verdict === 'decision')
const mixed = aggregate([ok('claude', changes), ok('codex', { ...decision, decisions: [...decision.decisions, implDecision().decisions[0]] })])
check('A — 결정 필요여도 findings · 자동 확정 결정은 그대로 남는다(보낼 것)', mixed.verdict === 'decision' && mixed.findings.length === 1 && mixed.autoDecisions.length === 1 && mixed.decisions.length === 1, JSON.stringify(mixed))
const instr = fixInstruction({ agent: 'web-fe', org: 'acme', repo: 'web', number: '7', sha: 'abcdef123', round: MAX_ROUNDS, findings: mixed.findings, autoDecisions: mixed.autoDecisions, humanDecisions: 1, takeover: true, plan: 'plans/task/x.md', worktree: '/wt', athenaDir: '/a' })
check('수정 지시 — 지적 · 자동 확정 결정 · 결정 콘솔 안내 · 상한 이어받기 안내 · commit/ship', instr.startsWith('[자동 리뷰 → web-fe] PR web#7 @abcdef1 라운드 3/3 — 수정 필요: 1) a.js:3') && instr.includes('자동 확정한 결정') && instr.includes('아이콘 자리 → A') && instr.includes('결정 1개는 결정 콘솔') && instr.includes(TAKEOVER) && instr.includes('--auto-push'), instr)
const onlyAuto = fixInstruction({ agent: 'web-fe', org: 'acme', repo: 'web', number: '7', sha: 'abcdef123', round: 1, findings: [], autoDecisions: autoSum.autoDecisions, plan: 'p', worktree: '/wt', athenaDir: '/a' })
check('수정 지시 — 지적 없이 자동 확정 결정만 · 상한 전이면 이어받기 안내 없음', !onlyAuto.includes('수정 필요:') && onlyAuto.includes('아이콘 자리 → A') && !onlyAuto.includes(TAKEOVER), onlyAuto)
const autoComment = reviewComment({ sha: 'abcdef1', round: MAX_ROUNDS, results: [ok('claude', approve), ok('codex', implDecision())], summary: autoSum })
check('댓글 — 추천안으로 자동 확정 · 상한 뒤 이어받음', autoComment.includes('추천안으로 자동 확정') && autoComment.includes('아이콘 자리 → **A**') && autoComment.includes(TAKEOVER), autoComment)
check('댓글 — 상한 전 · 승인이면 이어받음 줄 없음', !reviewComment({ sha: 'a', round: 1, results: [ok('claude', changes)], summary: aggregate([ok('claude', changes)]) }).includes(TAKEOVER)
  && !reviewComment({ sha: 'a', round: 3, results: [ok('claude', approve), ok('codex', approve)], summary: aggregate([ok('claude', approve), ok('codex', approve)]) }).includes(TAKEOVER))
check('C — 이어받기는 상한 라운드가 쓴 줄(수정 · 결정 필요 — 상한 뒤 이어받음…)로 시작할 때만 · 머지 단계로 간 뒤의 줄은 아님',
  grantsTakeover(`수정 필요 — ${TAKEOVER}(다음 커밋은 리뷰 없이 검증만)`) && grantsTakeover(`결정 필요 — ${TAKEOVER}(다음 커밋은 리뷰 없이 검증만) · 승인 2/2이지만 …`)
  && !grantsTakeover(`${TAKEOVER}(리뷰 없이 검증만으로 머지) → 머지 확인 대기`) && !grantsTakeover(`${TAKEOVER}(리뷰 없이 검증만으로 머지) → 바로 머지(확인 없음)`) && !grantsTakeover('검증 대기 — x') && !grantsTakeover(undefined))
const partial = aggregate([ok('claude', changes), { name: 'codex', status: 'failed', reason: 'x' }])
check('C — 리뷰어가 하나라도 실패한 상한 라운드는 이어받기를 주지 않음(지적은 그대로 보냄)', partial.verdict === 'changes' && partial.findings.length === 1 && !takeoverEligible(partial, MAX_ROUNDS) && takeoverEligible(aggregate([ok('claude', changes), ok('codex', approve)]), MAX_ROUNDS) && !takeoverEligible(aggregate([ok('claude', changes), ok('codex', approve)]), MAX_ROUNDS - 1))
const partialInstr = fixInstruction({ agent: 'web-fe', org: 'acme', repo: 'web', number: '7', sha: 'abcdef1', round: MAX_ROUNDS, findings: partial.findings, takeover: false, plan: 'p', worktree: '/wt', athenaDir: '/a' })
const partialComment = reviewComment({ sha: 'abcdef1', round: MAX_ROUNDS, results: [ok('claude', changes), { name: 'codex', status: 'failed', reason: 'x' }], summary: partial })
check('C — 리뷰어 부족 상한 라운드: 지시 · 댓글에 이어받지 않음', partialInstr.includes('이어받지 않는다') && !partialInstr.includes(`(${TAKEOVER})`) && partialComment.includes('이어받지 않음') && !partialComment.includes(`**${TAKEOVER}**`), partialInstr)
check('C — 상한을 넘은 라운드만 이어받기 · 댓글에 "리뷰 없이 검증만으로 머지"', !isTakeoverRound(MAX_ROUNDS) && isTakeoverRound(MAX_ROUNDS + 1) && takeoverComment({ sha: 'abcdef1', round: 4 }).includes('리뷰 없이 검증만으로 머지'))
const dLine = autoDecisionLine({ decision: autoSum.autoDecisions[0], repo: 'web', number: '7', sha: 'abcdef123' })
const light = '# x\n\n## Checkpoint\n- Status: in_progress\n\n### Blocked\n- 없음\n\n## 지시\n본문\n'
const lightOut = withDecisionLines(light, [dLine])
check('계획서 Decisions — 절이 없으면 Checkpoint 끝에 만든다 · 같은 줄은 다시 안 넣음', /### Blocked\n- 없음\n\n### Decisions\n- 추천안으로 자동 확정\(자동 리뷰 · codex · web#7 @abcdef1 · 구현 세부\): 아이콘 자리 → A\n\n## 지시/.test(lightOut) && withDecisionLines(lightOut, [dLine]) === lightOut, lightOut)
const formalPlan = '## Checkpoint\n### Decisions\n- D1 기존\n\n### Commits\n- c\n'
const pendingBase = '# 시험\n## Checkpoint\n- Work ref: /tmp/wt · 🌿 feat/x · pane p3 (web-fe)\n- PR: x\n'
const withAuto = withAutoLine(pendingBase, { repo: 'web', number: '7', sha: 'abcdef1', result: '결정 필요', round: 1, stamp: 's' })
const marked = withPendingDecisionLine(withAuto, { repo: 'web', number: '7', sha: 'abcdef123', count: 2, registered: false, stamp: 's' })
check('결정 대기 줄 — 그 PR 의 Auto review 줄 바로 뒤 · 등록 실패 읽기', /- Auto review: web#7 .*\n- Auto decisions: web#7 @abcdef1 · 2개 · 등록 실패 · /.test(marked) && pendingDecisionLine(marked, 'web', '7')?.registered === false && pendingDecisionLine(marked, 'web', '8') === null, marked)
const remarked = withPendingDecisionLine(marked, { repo: 'web', number: '7', sha: 'bbbbbbb', count: 1, registered: true, stamp: 's' })
check('결정 대기 줄 — 같은 PR 은 바꿔 쓰기 · 등록됨 · 지우기', (remarked.match(/^- Auto decisions:/gm) ?? []).length === 1 && pendingDecisionLine(remarked, 'web', '7')?.registered === true && pendingDecisionLine(withoutPendingDecisionLine(remarked, 'web', '7'), 'web', '7') === null && withoutPendingDecisionLine(remarked, 'web', '7') === withAuto)
check('계획서 Decisions — 절이 있으면 그 끝에 덧붙임', withDecisionLines(formalPlan, [dLine]) === `## Checkpoint\n### Decisions\n- D1 기존\n${dLine}\n\n### Commits\n- c\n`, withDecisionLines(formalPlan, [dLine]))

console.log('\n계획서 표시 줄')
const plan = `# 시험\n## Checkpoint\n- Status: in_progress\n- Work ref: /tmp/wt/web-x · 🌿 feat/x · pane p3 (web-fe)\n- PR: https://github.com/acme/web/pull/7 (feat/x → dev, draft · 2026-10-25 10:00)\n`
const once = withAutoLine(plan, { repo: 'web', number: '7', sha: 'abcdef1234567', result: '수정 필요', round: 1, stamp: '2026-10-25 11:00' })
check('없으면 Work ref 바로 뒤에', /- Work ref:.*\n- Auto review: web#7 @abcdef1 · 수정 필요 · 라운드 1\/3 · 2026-10-25 11:00\n/.test(once), once)
const twice = withAutoLine(once, { repo: 'web', number: '7', sha: '1234567abcdef', result: '승인 2/2 → 머지 확인 대기', round: 2, stamp: '2026-10-25 12:00' })
check('같은 PR 은 그 줄을 바꿔 쓴다(줄이 늘지 않음)', (twice.match(/^- Auto review:/gm) ?? []).length === 1 && autoLines(twice).get('web#7').round === 2)
check('같은 HEAD 는 다시 안 봄 · 새 HEAD 는 봄', !needsReview(twice, 'web', '7', '1234567abcdef0000') && needsReview(twice, 'web', '7', 'ffff000'))
check('표시 줄이 없으면 봄', needsReview(plan, 'web', '7', 'abc1234'))
const stopped = withAutoLine(twice, { repo: 'web', number: '7', sha: '1234567', result: '멈춤 — 라운드 상한(수정 필요)', round: 3, stamp: 's' })
const merged = withAutoLine(twice, { repo: 'web', number: '7', sha: '1234567', result: '머지됨 — squash → dev', round: 2, stamp: 's' })
check('멈춤 · 머지됨이면 새 HEAD 가 와도 안 봄(사람이 이어받음)', !needsReview(stopped, 'web', '7', 'ffff000') && !needsReview(merged, 'web', '7', 'ffff000'))
const edited = withAutoLine(twice, { repo: 'web', number: '7', sha: '1234567', result: `${BODY_EDITED} — 다시 리뷰 대기`, round: 2, stamp: 's' })
check('본문 고침이면 같은 HEAD 도 다시 봄 · 라운드 하나 올림', needsReview(edited, 'web', '7', '1234567abcdef') && nextRound(autoLines(edited).get('web#7'), '1234567abcdef') === 3)
check('라운드 — 새 HEAD 면 +1 · 같은 HEAD 면 그대로 · 처음이면 1', nextRound(autoLines(twice).get('web#7'), 'ffff000') === 3 && nextRound(autoLines(twice).get('web#7'), '1234567abc') === 2 && nextRound(undefined, 'abc') === 1)
const notice = mergeNotice({ agent: 'web-fe', repo: 'web', number: '7', sha: '1234567abc', result: '머지됨 — squash → dev' })
check('머지 결과 알림 — [자동 리뷰 → 에이전트] · PR · 결과 · 할 일 없음', notice.startsWith('[자동 리뷰 → web-fe] PR web#7 @1234567 — 머지됨 — squash → dev') && notice.includes('할 일은 없다'), notice)
const ref = workRefOf(plan)
check('Work ref 에서 워크트리 · 브랜치 · pane · 에이전트', ref.worktree === '/tmp/wt/web-x' && ref.branch === 'feat/x' && ref.pane === 'p3' && ref.agent === 'web-fe', JSON.stringify(ref))

console.log('\n대상(결정 D4 — 켠 레포의 레포 하나짜리 PR 만)')
const config = { repos: [
  { name: 'web', agents: ['web-fe'], autoMerge: true },
  { name: 'api', agents: ['api-be'] },
  { name: 'app', agents: ['app-fe'], autoMerge: true, direct: true },
] }
check('autoMerge: true 인 레포만 · main 직접 레포는 빼고 · 기본 꺼짐', JSON.stringify([...autoMergeRepos(config)]) === '["web"]')
const confirmConfig = { repos: [
  { name: 'web', agents: ['web-fe'], autoMerge: true, autoMergeConfirm: false },
  { name: 'api', agents: ['api-be'], autoMerge: true },
  { name: 'off', agents: ['off-fe'], autoMergeConfirm: false },
  { name: 'app', agents: ['app-fe'], autoMerge: true, autoMergeConfirm: false, direct: true },
  { name: 'str', agents: ['str-fe'], autoMerge: true, autoMergeConfirm: 'false' },
] }
check('확인 없이 머지는 autoMerge 를 켠 레포의 autoMergeConfirm: false 만(키 없음 · 자동 머지 꺼짐 · main 직접 · 글자 "false" 는 확인)',
  skipsMergeConfirm(confirmConfig, 'web') && !['api', 'off', 'app', 'str', 'none'].some((name) => skipsMergeConfirm(confirmConfig, name)))
check('Agent 줄이 이 레포 에이전트 하나 → 대상', singleRepoPlan('- Agent: web-fe\n', config, 'web'))
const formal = '## 6. 작업 배분\n\n| 담당 | 작업 |\n|---|---|\n| api-be | x |\n| web-fe | y |\n| reviewer | z |\n'
check('작업 배분 표에 다른 레포 에이전트가 있으면 → 대상 아님', !singleRepoPlan(formal, config, 'web'))
check('에이전트가 없거나 다른 레포 것이면 → 대상 아님', !singleRepoPlan('- Agent: api-be\n', config, 'web') && !singleRepoPlan('본문만\n', config, 'web'))

console.log('\n댓글')
const comment = reviewComment({ sha: 'abcdef123', round: 1, results: [ok('claude', { ...changes, summary: '토큰 ghp_' + 'a'.repeat(30) + ' 이 보인다' }), { name: 'codex', status: 'failed', reason: '시간 넘김' }], summary: aggregate([ok('claude', changes), { name: 'codex', status: 'failed' }]) })
check('결론 · 리뷰어마다 줄 · 실패 이유', comment.includes('결론: 수정 필요') && comment.includes('**codex** — 실패(시간 넘김)') && comment.includes('`a.js:3`'), comment)
check('비밀값 모양은 가린 뒤 보낸다(pr-auto.mjs 가 maskSecrets 로 감쌈)', !maskSecrets(comment).masked.includes('a'.repeat(30)))

console.log('\n앞 리뷰 승인 이어받기(같은 내용 — ship.sh 와 같은 판정)')
const tree = 'aaaabbbbccccdddd0000111122223333444455556'
const reviewed = (verdict, extra = '') => `- Review: pane p9\n- Review result: ${verdict} @1234567 · tree ${tree.slice(0, 12)} · 📦 web · 🌿 feat/x · 2026-10-26 10:00${extra}\n`
check('승인 · tree 같음 → 이어받음', Boolean(priorApproval(reviewed('승인'), { repo: 'web', branch: 'feat/x', sha: 'ffff999', tree })))
check('승인 · tree 다름 → 안 이어받음(새로 리뷰)', !priorApproval(reviewed('승인'), { repo: 'web', branch: 'feat/x', sha: '1234567', tree: '9999' + tree.slice(4) }))
check('tree 를 못 구하면 → 안 이어받음', !priorApproval(reviewed('승인'), { repo: 'web', branch: 'feat/x', sha: '1234567', tree: '' }))
check('수정 필요 → 안 이어받음', !priorApproval(reviewed('수정 필요'), { repo: 'web', branch: 'feat/x', sha: '1234567', tree }))
check('다른 레포 · 브랜치 줄은 안 봄', !priorApproval(reviewed('승인'), { repo: 'api', branch: 'feat/x', sha: '1234567', tree }) && !priorApproval(reviewed('승인'), { repo: 'web', branch: 'feat/y', sha: '1234567', tree }))
check('tree 없는 옛 줄은 커밋 sha 로', Boolean(priorApproval('- Review result: 승인 @1234567 · 2026-10-01\n', { repo: 'web', branch: 'feat/x', sha: '1234567abc', tree })) && !priorApproval('- Review result: 승인 @1234567 · 2026-10-01\n', { repo: 'web', branch: 'feat/x', sha: 'ffff000', tree }))
check('같은 레포 · 브랜치 줄이 여럿이면 마지막(승인 뒤 수정 필요 → 안 이어받음)', !priorApproval(reviewed('승인') + reviewed('수정 필요').split('\n')[1] + '\n', { repo: 'web', branch: 'feat/x', sha: '1234567', tree }))
const taken = inheritedResult({ sha: '1234567', tree: tree.slice(0, 12) }, 'abcdef0123')
check('이어받은 Claude + Codex 승인 → 승인 · Codex 반려 → 수정 필요', aggregate([taken, ok('codex', approve)]).verdict === 'approve' && aggregate([taken, ok('codex', changes)]).verdict === 'changes')
check('이어받은 자리는 사건 기록에 inherited · 댓글에 "앞 리뷰 승인 이어받음 @sha"', reviewerBrief([taken, ok('codex', approve)]) === 'claude:inherited,codex:approve'
  && reviewComment({ sha: 'abcdef0123', round: 1, results: [taken, ok('codex', approve)], summary: aggregate([taken, ok('codex', approve)]) }).includes('Claude: 앞 리뷰 승인 이어받음 @abcdef0'))
const noted = withAutoLine(plan, { repo: 'web', number: '7', sha: 'abcdef0123', result: '승인 2/2 → 머지 확인 대기', note: taken.review.summary, round: 1, stamp: 's' })
const parsed = autoLines(noted).get('web#7')
check('계획서 줄에 메모가 붙어도 결과 · 라운드 · 같은 HEAD 판정은 그대로', parsed.result.startsWith('승인 2/2 → 머지 확인 대기 · Claude: 앞 리뷰 승인 이어받음 @abcdef0') && parsed.round === 1 && !needsReview(noted, 'web', '7', 'abcdef0123'), noted)

console.log('\n리뷰어 구성(두 번째 자리 — Codex 없는 사람은 다른 모델 Claude · 사용자 결정 b)')
const ready = reviewerSlots({ codex: 'ready', firstModel: '' })
check('Codex 를 쓸 수 있으면 지금과 같다(claude + codex · 첫 자리 모델은 팩 값 그대로)', ready.second.name === 'codex' && !ready.second.unavailable && ready.first.model === '' && reviewerSlots({ codex: 'ready', firstModel: 'haiku' }).first.model === 'haiku')
const pair = reviewerSlots({ codex: 'logged-out' })
check('로그인 안 됨 · 팩 값 없음 → 기본 opus + sonnet', pair.first.model === 'opus' && pair.second.kind === 'claude' && pair.second.model === 'sonnet' && pair.second.name === 'claude-sonnet')
const custom = reviewerSlots({ codex: 'missing', firstModel: 'sonnet', secondModel: 'haiku' })
check('설치 안 됨 · 팩 값이 먼저(sonnet + haiku)', custom.first.model === 'sonnet' && custom.second.model === 'haiku')
const same = reviewerSlots({ codex: 'missing', firstModel: 'sonnet' })
check('두 자리가 같은 모델이 되면 대신하지 않음(→ 리뷰어 부족)', same.second.name === 'codex' && Boolean(same.second.unavailable) && Boolean(reviewerSlots({ codex: 'missing', firstModel: 'x', secondModel: 'x' }).second.unavailable))
check('구성 메모 — 계획서 줄 · 댓글용', lineupNote(pair) === '리뷰어 claude(opus) + claude(sonnet) — Codex 로그인 안 됨' && lineupNote(ready) === '리뷰어 claude + codex', `${lineupNote(pair)} / ${lineupNote(ready)}`)
check('Claude 두 자리 둘 다 승인 → 승인(둘 다 승인 규칙 그대로)', aggregate([ok('claude', approve), ok('claude-sonnet', approve)]).verdict === 'approve')

console.log(`\n${pass + fail}개 중 실패 ${fail}`)
process.exit(fail ? 1 : 0)
EOF

# ── 가짜 리뷰어로 실행 ───────────────────────────────────────────────────
BIN="$TMP/bin"; mkdir -p "$BIN"
# claude -p --output-format json --json-schema … — structured_output 에 답(learn-review 가 쓰는 꼴)
cat > "$BIN/claude" <<'SH'
#!/bin/sh
if [ -n "${FAKE_PROMPT:-}" ]; then cat > "$FAKE_PROMPT"; else cat > /dev/null; fi
[ -n "${FAKE_CLAUDE_ARGS:-}" ] && echo "$*" > "$FAKE_CLAUDE_ARGS"
case "${FAKE_CLAUDE:-approve}" in
  approve) echo '{"is_error":false,"structured_output":{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}}' ;;
  bad) echo '{"is_error":false,"structured_output":{"verdict":"maybe"}}' ;;
  changes) echo '{"is_error":false,"structured_output":{"verdict":"changes","summary":"고칠 것","findings":[{"file":"b.js","line":2,"problem":"p","fix":"f","severity":"blocking"}],"decisions":[]}}' ;;
esac
SH
# codex exec … -o <파일> — 마지막 답을 그 파일에
cat > "$BIN/codex" <<'SH'
#!/bin/sh
# 돌리기 전 로그인 확인(codex login status — 종료 코드만 본다) · FAKE_CODEX_LOGIN=out 이면 로그인 안 됨
if [ "$1 $2" = "login status" ]; then [ "${FAKE_CODEX_LOGIN:-in}" = in ]; exit $?; fi
cat > /dev/null
# 도구 없이 돌리는 옵션(사용자 설정 · 셸 · 웹 끄기)이 빠지면 실패한다 — docs/pr-auto.md "리뷰어"
case " $* " in *" --ignore-user-config "*) ;; *) echo "도구 끄기 옵션 없음" >&2; exit 9 ;; esac
case " $* " in *" --disable shell_tool "*) ;; *) echo "셸 끄기 없음" >&2; exit 9 ;; esac
case " $* " in *'web_search="disabled"'*) ;; *) echo "웹 끄기 없음" >&2; exit 9 ;; esac
[ "${FAKE_CODEX:-approve}" = slow ] && sleep 30
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
[ -n "${FAKE_CODEX_CALLED:-}" ] && echo called > "$FAKE_CODEX_CALLED"
decision_of() { echo '{"verdict":"decision","summary":"정할 것","findings":[],"decisions":[{"title":"아이콘 자리","why":"w","options":[{"label":"A 왼쪽","desc":""},{"label":"B 오른쪽","desc":""}],"recommended":"A 왼쪽","kind":"'"$1"'"}]}'; }
if [ "${FAKE_CODEX:-}" = ok ]; then echo '{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}' > "$out"
elif [ "${FAKE_CODEX:-}" = impl ]; then decision_of implementation > "$out"
elif [ "${FAKE_CODEX:-}" = product ]; then decision_of product > "$out"
elif [ "${FAKE_CODEX:-}" = advisory ]; then echo '{"verdict":"changes","summary":"권장","findings":[{"file":"c.js","line":5,"problem":"이름이 길다","fix":"줄인다","severity":"advisory"}],"decisions":[]}' > "$out"
else echo '{"verdict":"changes","summary":"고칠 것","findings":[{"file":"a.js","line":1,"problem":"p","fix":"f","severity":"blocking"}],"decisions":[]}' > "$out"; fi
SH
chmod +x "$BIN/claude" "$BIN/codex"
run_case() {   # <이름> <PATH> <기대 판정> [환경…]
  local name="$1" path="$2" want="$3"; shift 3
  local got
  got="$(env PATH="$path" ATHENA_PR_AUTO_TIMEOUT_MS=1500 "$@" "$(command -v node)" --input-type=module -e "
    const { runReviewers } = await import('./scripts/pr-auto.mjs')
    const { aggregate, reviewerBrief } = await import('./scripts/lib/pr-auto.mjs')
    const results = await runReviewers('리뷰해 줘', JSON.parse(process.env.FAKE_CONFIG || '{}'))
    console.log(aggregate(results).verdict + ' ' + reviewerBrief(results))" 2>&1 | tail -1)"
  if [ "${got%% *}" = "$want" ]; then echo "  ✔ $name — $got"; else echo "  ✖ $name — 기대 $want · 실제 $got"; FAIL=1; fi
}
echo; echo "가짜 리뷰어"
run_case "둘 다 승인 → 승인" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok
run_case "둘 다 답함(claude 승인 · codex 수정 필요) → 수정 필요" "$BIN:/usr/bin:/bin" changes
ONLY="$TMP/only-claude"; mkdir -p "$ONLY"; cp "$BIN/claude" "$ONLY/"
# Codex 를 처음부터 못 쓰면 두 번째 자리를 다른 모델 Claude 가(사용자 결정 b — 기본 opus + sonnet · 팩 값이 먼저 · 같으면 리뷰어 부족)
PAIR_LOG="$TMP/claude-pair"; : > "$PAIR_LOG"
cat > "$ONLY/claude" <<'SH'
#!/bin/sh
cat > /dev/null
echo "$*" >> "$FAKE_CLAUDE_ARGS"
echo '{"is_error":false,"structured_output":{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}}'
SH
chmod +x "$ONLY/claude"
run_case "codex 명령 없음 → claude(opus) + claude(sonnet) 둘 다 승인 → 승인" "$ONLY:/usr/bin:/bin" approve FAKE_CLAUDE_ARGS="$PAIR_LOG"
grep -q -- '-p --model opus ' "$PAIR_LOG" && grep -q -- '-p --model sonnet ' "$PAIR_LOG" && [ "$(wc -l < "$PAIR_LOG" | tr -d ' ')" = 2 ] \
  && echo "  ✔ Claude 두 번 — --model opus 한 번 · --model sonnet 한 번" || { echo "  ✖ Claude 두 번 모델: $(cat "$PAIR_LOG")"; FAIL=1; }
: > "$PAIR_LOG"
run_case "codex 로그인 안 됨 · 팩 models 값이 먼저(sonnet + haiku)" "$ONLY:$BIN:/usr/bin:/bin" approve FAKE_CODEX_LOGIN=out FAKE_CODEX=ok FAKE_CLAUDE_ARGS="$PAIR_LOG" FAKE_CONFIG='{"models":{"prReview":"sonnet","prReviewSecond":"haiku"}}'
grep -q -- '-p --model sonnet ' "$PAIR_LOG" && grep -q -- '-p --model haiku ' "$PAIR_LOG" \
  && echo "  ✔ 팩 값 — --model sonnet · --model haiku" || { echo "  ✖ 팩 값 모델: $(cat "$PAIR_LOG")"; FAIL=1; }
run_case "두 번째 모델 이름에 '/' 가 있어도(클라우드 이름) 임시 폴더가 경로로 안 풀림 → 승인" "$ONLY:/usr/bin:/bin" approve FAKE_CLAUDE_ARGS="$PAIR_LOG" FAKE_CONFIG='{"models":{"prReview":"opus","prReviewSecond":"vendor/claude-x"}}'
run_case "codex 없음 · models 설정 오류 → 기본 sonnet 으로 대신하지 않고 리뷰어 부족" "$ONLY:/usr/bin:/bin" insufficient FAKE_CLAUDE_ARGS="$PAIR_LOG" FAKE_CONFIG='{"models":{"prReviewSecond":"x y"}}'
INH_OUT="$(env PATH="$ONLY:/usr/bin:/bin" FAKE_CLAUDE_ARGS="$PAIR_LOG" "$(command -v node)" --input-type=module -e "
  const { runReviewers } = await import('./scripts/pr-auto.mjs')
  const { aggregate, inheritedResult, reviewerBrief } = await import('./scripts/lib/pr-auto.mjs')
  const results = await runReviewers('리뷰해 줘', { models: { prReviewSecond: 'x y' } }, [inheritedResult({ sha: '1234567', tree: 'abc' }, '1234567')])
  console.log(aggregate(results).verdict + ' ' + reviewerBrief(results))" 2>&1 | tail -1)"
case "$INH_OUT" in "insufficient claude:failed,"*) echo "  ✔ models 설정 오류면 앞 리뷰 승인을 이어받아도 첫 자리 실패 → 리뷰어 부족 — $INH_OUT" ;; *) echo "  ✖ 설정 오류 + 이어받기 — $INH_OUT"; FAIL=1 ;; esac
run_case "codex 없음 · 두 자리가 같은 모델(prReview sonnet · 두 번째 기본 sonnet) → 리뷰어 부족" "$ONLY:/usr/bin:/bin" insufficient FAKE_CLAUDE_ARGS="$PAIR_LOG" FAKE_CONFIG='{"models":{"prReview":"sonnet"}}'
run_case "codex 가 돌다가 실패(시간 넘김)는 Claude 로 바꾸지 않음 → 리뷰어 부족" "$BIN:/usr/bin:/bin" insufficient FAKE_CODEX=slow
run_case "claude 답 모양이 틀림 → 그 리뷰어는 실패" "$BIN:/usr/bin:/bin" changes FAKE_CLAUDE=bad
# 모델(팩 pack.json models.prReview · docs/pack.md) — 있으면 claude 에 --model · 없으면 안 붙임 · 이상하면 claude 리뷰어 실패 → 리뷰어 부족
ARGS_LOG="$TMP/claude-args"
run_case "models.prReview → claude 에 --model 붙임" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok FAKE_CLAUDE_ARGS="$ARGS_LOG" FAKE_CONFIG='{"models":{"prReview":"sonnet"}}'
case " $(cat "$ARGS_LOG" 2>/dev/null) " in *" -p --model sonnet "*) echo "  ✔ claude 인자에 --model sonnet" ;; *) echo "  ✖ claude 인자에 --model sonnet 없음: $(cat "$ARGS_LOG" 2>/dev/null)"; FAIL=1 ;; esac
rm -f "$ARGS_LOG"
run_case "models 없음 → --model 안 붙임" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok FAKE_CLAUDE_ARGS="$ARGS_LOG"
case " $(cat "$ARGS_LOG" 2>/dev/null) " in *" --model "*) echo "  ✖ models 없는데 --model 이 붙음"; FAIL=1 ;; *" -p "*) echo "  ✔ claude 인자에 --model 없음" ;; *) echo "  ✖ claude 가 불리지 않음"; FAIL=1 ;; esac
run_case "models.prReview 이름이 이상함 → 리뷰어 부족(기본 모델로 다시 하지 않음)" "$BIN:/usr/bin:/bin" insufficient FAKE_CODEX=ok FAKE_CONFIG='{"models":{"prReview":"bad name"}}'

# ── 가짜 본체로 — ship.sh --auto-push --body-file(결정 D2) · 머지 결과 pane 알림 ─────────────────────
# 코어 scripts/ 를 임시 폴더에 복사하고 화면(scripts/screen) · gh · 검증(reuse.sh)을 가짜로 바꾼다. origin 은 로컬 bare 레포
echo; echo "가짜 본체(ship.sh 본문 고침 · 머지 결과 알림)"
CORE="$TMP/core"; mkdir -p "$CORE/plans/task"; cp -R scripts "$CORE/scripts"
printf '{ "github": { "org": "acme" }, "repos": [{ "name": "web", "agents": ["web-fe"], "autoMerge": true, "prBase": "dev" }] }\n' > "$CORE/athena.config.json"
FLOG="$TMP/fake.log"; : > "$FLOG"
cat > "$CORE/scripts/screen" <<'SH'
#!/bin/sh
echo "screen $*" >> "$FAKE_LOG"
if [ "$1 $2" = "pane list" ]; then echo "{\"panes\":[${FAKE_PANES:-}]}"; else echo '{}'; fi
SH
printf '#!/bin/sh\nexit 0\n' > "$CORE/scripts/verify/reuse.sh"
cat > "$BIN/gh" <<'SH'
#!/bin/sh
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "pr list") echo 7 ;;
  "pr view") printf '{"state":"OPEN","isDraft":false,"headRefOid":"%s","mergeable":"MERGEABLE","baseRefName":"dev"}\n' "$FAKE_HEAD" ;;
  "pr edit"|"pr merge"|"pr ready") ;;
  *) exit 1 ;;
esac
SH
chmod +x "$CORE/scripts/screen" "$CORE/scripts/verify/reuse.sh" "$BIN/gh"
G() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
G init -q --bare "$TMP/origin.git"
G clone -q "$TMP/origin.git" "$TMP/web" 2>/dev/null
G -C "$TMP/web" commit -q --allow-empty -m init && G -C "$TMP/web" push -q origin HEAD:main HEAD:dev 2>/dev/null
mkdir -p "$CORE/repos" && ln -s "$TMP/web" "$CORE/repos/web"
G -C "$TMP/web" worktree add -q -b feat/x "$TMP/wt" 2>/dev/null
WT="$(cd "$TMP/wt" && pwd -P)"
echo hi > "$WT/a.txt" && G -C "$WT" add a.txt && G -C "$WT" commit -q -m x && G -C "$WT" push -q origin feat/x 2>/dev/null
SHA="$(git -C "$WT" rev-parse HEAD)"; S7="${SHA:0:7}"
PLANF="plans/task/20261025-web-fe-x.md"
write_plan() {   # <Auto review 결과> <pane>
  printf '# 시험\n\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane %s (web-fe)\n- Auto review: web#7 @%s · %s · 라운드 1/3 · 2026-10-25 10:00\n- PR: https://github.com/acme/web/pull/7 (feat/x → dev, draft · 2026-10-25 09:00)\n\n## Commits\n- `%s` feat/x · 시험 · push → dev PR https://github.com/acme/web/pull/7\n' "$WT" "$2" "$S7" "$1" "$S7" > "$CORE/$PLANF"
}
printf '## 작업 내용\n시험\n\n## 변경 사항\n- a\n\n## 검증\n- 통과\n\n## 확인 필요\n- 없음\n' > "$TMP/body.md"
printf '## 작업 내용\n시험\n' > "$TMP/bad-body.md"
QUEUE="$TMP/queue"; mkdir -p "$QUEUE/.watcher.lock"; echo $$ > "$QUEUE/.watcher.lock/pid"   # 처리기가 이미 도는 것처럼 — 대기열에만 넣고 진짜 리뷰어를 띄우지 않는다
ENVS=(env PATH="$BIN:$PATH" FAKE_LOG="$FLOG" FAKE_HEAD="$SHA" ATHENA_PR_AUTO_QUEUE="$QUEUE" ATHENA_DATA_DIR="$TMP/data")
ship() { (cd "$CORE" && "${ENVS[@]}" bash scripts/ship.sh --plan "$PLANF" --dir "$WT" --auto-push "$@" 2>&1); }
expect() {   # <이름> <조건(eval)> [자세히]
  if eval "$2"; then echo "  ✔ $1"; else echo "  ✖ $1"; [ -n "${3:-}" ] && echo "$3" | sed 's/^/      /'; FAIL=1; fi
}

write_plan '수정 필요' p3; : > "$FLOG"
OUT="$(ship --body-file "$TMP/bad-body.md")"; CODE=$?
expect "본문 필수 절이 없으면 거절 · gh pr edit 안 부름" '[ $CODE != 0 ] && ! grep -q "gh pr edit" "$FLOG"' "$OUT"
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"
OUT="$(ship --body-file "$TMP/body.md")"; CODE=$?
expect "자동 리뷰의 수정 요청이 없으면 거절 · gh pr edit 안 부름" '[ $CODE != 0 ] && ! grep -q "gh pr edit" "$FLOG"' "$OUT"
write_plan '수정 필요' p3; : > "$FLOG"
OUT="$(ship)"; CODE=$?
expect "--body-file 없이 올릴 커밋도 없으면 거절" '[ $CODE != 0 ] && echo "$OUT" | grep -q "body-file"' "$OUT"
: > "$FLOG"
OUT="$(ship --body-file "$TMP/body.md")"; CODE=$?
expect "조건이 다 차면 본문만 — gh pr edit 7 --body-file · push 없음" '[ $CODE = 0 ] && grep -q "gh pr edit 7 --body-file $TMP/body.md" "$FLOG" && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$SHA" ]' "$OUT"
expect "계획서 줄은 본문 고침(같은 HEAD · 라운드 그대로) · 대기열에 같은 HEAD" 'grep -q "^- Auto review: web#7 @$S7 · 본문 고침 — 다시 리뷰 대기 · 라운드 1/3" "$CORE/$PLANF" && grep -lq "$SHA" "$QUEUE"/*.json' "$(grep 'Auto review' "$CORE/$PLANF"; ls "$QUEUE")"
rm -f "$QUEUE"/*.json

# 머지 결과 알림 — 머지 확인 답(머지 · 보류)을 처리한 뒤 Work ref pane 이 살아 있으면 한 줄 · 없으면 보내지 않는다
confirm() {   # <답> — 요청을 열고 답한 뒤 머지 확인 대기 파일을 둔다
  (cd "$CORE" && "${ENVS[@]}" node --input-type=module -e "
    const { openRequest, answerRequest } = await import('./scripts/lib/requests.mjs')
    const { writeFileSync, mkdirSync, realpathSync } = await import('node:fs')
    const request = openRequest('.', { kind: 'question', title: '머지할까요?', options: [{ label: '머지' }, { label: '보류' }], links: { plan: '$PLANF' } }).request
    answerRequest('.', request.id, { choice: process.argv[1], by: 'board' })
    mkdirSync('$QUEUE/confirm', { recursive: true })
    writeFileSync('$QUEUE/confirm/web-7.json', JSON.stringify({ plan: '$PLANF', repo: 'web', number: '7', sha: '$SHA', round: 1, request: request.id, worktree: '$WT', base: 'dev', root: realpathSync('.'), packId: null }))" "$1")
}
run_confirms() { (cd "$CORE" && "${ENVS[@]}" FAKE_PANES="$1" node --input-type=module -e "await (await import('./scripts/pr-auto.mjs')).checkConfirms()" 2>&1); }
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"; confirm 머지
OUT="$(run_confirms '{"id":"p3"}')"
expect "머지 → squash · pane p3 에 '[자동 리뷰 → web-fe] … 머지됨' 한 줄" 'grep -q "gh pr merge 7 .*--squash" "$FLOG" && grep -q "screen pane send-text p3 \[자동 리뷰 → web-fe\] PR web#7 @$S7 — 머지됨" "$FLOG" && grep -q "screen pane send-keys p3 Enter" "$FLOG"' "$OUT
$(cat "$FLOG")"
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"; confirm 보류
OUT="$(run_confirms '{"id":"p3"}')"
expect "보류 → 머지 안 함 · pane p3 에 '… 보류' 한 줄" '! grep -q "gh pr merge" "$FLOG" && grep -q "screen pane send-text p3 .*— 보류" "$FLOG"' "$OUT
$(cat "$FLOG")"
write_plan '승인 2/2 → 머지 확인 대기' p3; : > "$FLOG"; confirm 머지
OUT="$(run_confirms '')"
expect "pane 이 없으면 보내지 않는다(닫힌 세션을 다시 열지 않음) · 계획서 줄은 머지됨" '! grep -q "send-text" "$FLOG" && ! grep -q "delegate" "$FLOG" && grep -q "· 머지됨 — squash → dev ·" "$CORE/$PLANF"' "$OUT
$(cat "$FLOG")"

# push 하자마자 대기열에(지시 1) — --auto-push 로 새 커밋을 올리면 그 HEAD 가 바로 대기열에 · 같은 HEAD 를 또 넣어도(현황판 안전망) 하나만
echo more > "$WT/b.txt" && G -C "$WT" add b.txt && G -C "$WT" commit -q -m y
SHA2="$(git -C "$WT" rev-parse HEAD)"
write_plan '수정 필요' p3; printf -- '- `%s` feat/x · 시험2 · push 안 함\n' "${SHA2:0:7}" >> "$CORE/$PLANF"; : > "$FLOG"
OUT="$(ship)"; CODE=$?
expect "--auto-push 새 커밋 → push · 그 HEAD 가 바로 대기열에(5분 감지를 기다리지 않음)" '[ $CODE = 0 ] && [ "$(git -C "$TMP/origin.git" rev-parse feat/x)" = "$SHA2" ] && [ "$(grep -l "$SHA2" "$QUEUE"/*.json 2>/dev/null | wc -l | tr -d " ")" = 1 ]' "$OUT
$(ls "$QUEUE")"
OUT="$(cd "$CORE" && "${ENVS[@]}" node scripts/pr-auto.mjs --enqueue --plan "$PLANF" --pr web#7 --head "$SHA2" 2>&1)"
expect "현황판이 같은 HEAD 를 또 넣어도 하나만(이미 대기열에 있다)" 'echo "$OUT" | grep -q "이미" && [ "$(ls "$QUEUE"/*.json | wc -l | tr -d " ")" = 1 ]' "$OUT"
rm -f "$QUEUE"/*.json

# ── 머지 확인 — 레포가 "autoMergeConfirm": false 면 묻지 않고 바로 · 키가 없으면 지금처럼 확인 요청 ─────────
# 임시 코어 사본(옛 구조 본체 · athena.config.json)에서 가짜 gh · 가짜 리뷰어(둘 다 승인) · 가짜 검증(reuse.sh 통과)으로 handle 을 끝까지 돌린다
echo; echo "머지 확인(autoMergeConfirm)"
# 실제 경로로 — 맥 임시 폴더(/var → /private/var · TMPDIR 끝의 //)면 pr-auto.mjs 의 "직접 실행" 판정이 어긋나 아무것도 안 한다
CORE="$(cd "$TMP" && pwd -P)/core-confirm"; mkdir -p "$CORE/plans/task"
cp -R "$SRC/scripts" "$CORE/scripts"
printf '#!/bin/sh\n[ "$1 $2" = "pane list" ] && echo '"'"'{"panes":[]}'"'"' || echo '"'"'{}'"'"'\n' > "$CORE/scripts/screen"; chmod +x "$CORE/scripts/screen"
# FAKE_VERIFY_KILL — 검증 도중 부른 쪽(node)을 죽인다(머지 직전 확인 중에 처리기가 꺼진 경우)
printf '#!/bin/sh\n[ -n "$FAKE_VERIFY_KILL" ] && kill -9 $PPID && sleep 1\n[ -z "$FAKE_VERIFY_FAIL" ]\n' > "$CORE/scripts/verify/reuse.sh"; chmod +x "$CORE/scripts/verify/reuse.sh"
WT="$TMP/wt-confirm"; mkdir -p "$WT"
git -C "$WT" init -q && git -C "$WT" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
SHA="$(git -C "$WT" rev-parse HEAD)"
GH_LOG="$TMP/gh.log"
cat > "$BIN/gh" <<'SH'
#!/bin/sh
echo "$*" >> "$GH_LOG"
head="$FAKE_SHA"
if [ "$1 $2" = "pr view" ]; then
  echo x >> "$GH_LOG.views"
  # FAKE_GH_HEAD_AFTER — 두 번째 pr view(머지 직전 다시 확인)부터 다른 HEAD 를 답한다(그새 새 커밋)
  [ -n "$FAKE_GH_HEAD_AFTER" ] && [ "$(wc -l < "$GH_LOG.views")" -ge 2 ] && head="ffffffffffffffffffffffffffffffffffffffff"
fi
case "$1 $2" in
  "pr view") printf '{"state":"OPEN","isDraft":true,"headRefOid":"%s","headRefName":"feat/x","baseRefName":"main","mergeable":"MERGEABLE","title":"t","body":""}\n' "$head" ;;
  "pr diff") echo "diff --git a/a.js b/a.js" ;;
esac
exit 0
SH
chmod +x "$BIN/gh"
merge_case() {   # <이름> <autoMergeConfirm JSON 조각> <머지 기대 yes|no> <계획서 줄 기대(정규식)> [환경…]
  local name="$1" extra="$2" want="$3" line="$4"; shift 4
  rm -rf "$CORE/.requests" "$CORE/.events.jsonl" "$TMP/queue-confirm" "$GH_LOG.views" "$CORE/plans/task/"*; : > "$GH_LOG"
  printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true%s } ] }\n' "$extra" > "$CORE/athena.config.json"
  printf '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p3 (web-fe)\n%s- PR: https://github.com/acme/web/pull/7\n%s' "$WT" "${AUTO_LINE:+$AUTO_LINE
}" "${EXTRA_PLAN:-}" > "$CORE/plans/task/x.md"
  # BLOCK_REQUESTS=1 — 요청 폴더 자리에 파일을 둬 요청을 하나도 못 열게(결정 콘솔 · 대체 요청 둘 다 실패)
  [ "${BLOCK_REQUESTS:-0}" = 1 ] && : > "$CORE/.requests"
  # PENDING=1 — 결정 콘솔에 안 정한 결정이 있는 것처럼(plan-html.mjs 가 여는 계획서 결정 요청)
  [ "${PENDING:-0}" = 1 ] && (cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
    const { openRequest } = await import('./scripts/lib/requests.mjs')
    openRequest('.', { kind: 'decision', title: 'x', body: '- R1', links: { plan: 'plans/task/x.md' }, pane: null, dedupeKey: 'plan:plans/task/x.md' })" >/dev/null)
  env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" "$@" \
    "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1
  local merged=no; grep -q "^pr merge 7 --repo acme/web --squash --match-head-commit $SHA" "$GH_LOG" && merged=yes
  local got; got="$(grep -o '^- Auto review: .*' "$CORE/plans/task/x.md")"
  if [ "$merged" = "$want" ] && printf '%s' "$got" | grep -Eq "$line"; then echo "  ✔ $name — ${got#- Auto review: }"
  else echo "  ✖ $name — 머지 기대 $want · 실제 $merged · 줄: $got"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; fi
}
merge_case "키 없음 → 머지 확인 요청만(머지 안 함)" "" no '머지 확인 대기'
[ -n "$(ls "$CORE/.requests" 2>/dev/null)" ] && echo "  ✔ 키 없음 → 확인 요청이 열림" || { echo "  ✖ 키 없음인데 확인 요청이 없다"; FAIL=1; }
merge_case "autoMergeConfirm: true → 지금처럼 확인 요청" ', "autoMergeConfirm": true' no '머지 확인 대기'
merge_case "autoMergeConfirm: false → 요청 없이 draft 풀고 squash 머지" ', "autoMergeConfirm": false' yes '머지됨 — squash → main'
grep -q '^pr ready 7 --repo acme/web' "$GH_LOG" && [ -z "$(ls "$CORE/.requests" 2>/dev/null)" ] && [ -z "$(ls "$TMP/queue-confirm/confirm" 2>/dev/null)" ] \
  && echo "  ✔ autoMergeConfirm: false → gh pr ready 뒤 머지 · 요청 · 대기 파일 남지 않음" || { echo "  ✖ draft 풀기 · 요청 · 대기 파일 확인 실패"; FAIL=1; }
grep -q '"auto.merge".*"confirm":false' "$CORE/.events.jsonl" 2>/dev/null \
  && echo "  ✔ 사건 기록 auto.merge 에 confirm:false" || { echo "  ✖ 사건 기록에 확인 없는 머지가 없다"; FAIL=1; }
# 처리기가 잡은 채로 죽은 파일(<이름>.json.<죽은 pid>)은 원래 이름으로 돌려놓는다(산 pid 것은 그대로) — 처리기 시작 · --kick 이 부른다
mkdir -p "$TMP/queue-confirm/confirm"; echo '{}' > "$TMP/queue-confirm/confirm/web-8.json.999999"; echo '{}' > "$TMP/queue-confirm/confirm/web-9.json.$$"
env ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" "$(command -v node)" --input-type=module -e "
  const { restoreClaims } = await import('$CORE/scripts/pr-auto.mjs'); restoreClaims()" >/dev/null 2>&1
[ -f "$TMP/queue-confirm/confirm/web-8.json" ] && [ ! -e "$TMP/queue-confirm/confirm/web-8.json.999999" ] && [ -f "$TMP/queue-confirm/confirm/web-9.json.$$" ] \
  && echo "  ✔ 죽은 처리기가 잡은 파일은 되돌림 · 산 처리기 것은 그대로" || { echo "  ✖ 잡은 파일 되돌리기"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 돌고 있는 처리기도 — 다른 실행이 잡은 채로 끝난 확인 없는 대기 파일(죽은 pid)을 머지 확인 보기(checkConfirms)에서 되돌려 이어서 머지한다
rm -rf "$TMP/queue-confirm"; mkdir -p "$TMP/queue-confirm/confirm"; : > "$GH_LOG"; rm -f "$GH_LOG.views"
printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":1,"worktree":"%s","base":"main","root":"%s","packId":null,"request":null,"noConfirm":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json.999999"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" "$(command -v node)" --input-type=module -e "
  const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > "$TMP/merge.out" 2>&1
grep -q "^pr merge 7 --repo acme/web --squash --match-head-commit $SHA" "$GH_LOG" && [ -z "$(ls "$TMP/queue-confirm/confirm")" ] \
  && echo "  ✔ 돌고 있는 처리기가 남의 잡은 파일(죽은 pid)을 되돌려 머지 · 파일 남지 않음" || { echo "  ✖ 처리기의 잡은 파일 되돌리기 · 머지"; sed 's/^/      /' "$TMP/merge.out"; ls "$TMP/queue-confirm/confirm"; FAIL=1; }
# 머지 직전 검증 도중 처리기가 죽어도 — 잡은 파일이 남아(지우지 않음) 되돌리면 다시 볼 수 있다
rm -rf "$TMP/queue-confirm"; mkdir -p "$TMP/queue-confirm/confirm"; : > "$GH_LOG"; rm -f "$GH_LOG.views"
printf '{"plan":"plans/task/x.md","repo":"web","number":"7","sha":"%s","round":1,"worktree":"%s","base":"main","root":"%s","packId":null,"request":null,"noConfirm":true}\n' "$SHA" "$WT" "$CORE" > "$TMP/queue-confirm/confirm/web-7.json"
( env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" GH_LOG="$GH_LOG" FAKE_VERIFY_KILL=1 "$(command -v node)" --input-type=module -e "
  const { checkConfirms } = await import('$CORE/scripts/pr-auto.mjs'); await checkConfirms()" > /dev/null 2>&1; true ) 2>/dev/null   # 셸의 "Killed" 알림까지 숨긴다
claimed="$(ls "$TMP/queue-confirm/confirm" | grep -E '^web-7\.json\.[0-9]+$')"
env ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" "$(command -v node)" --input-type=module -e "
  const { restoreClaims } = await import('$CORE/scripts/pr-auto.mjs'); restoreClaims()" >/dev/null 2>&1
[ -n "$claimed" ] && [ -f "$TMP/queue-confirm/confirm/web-7.json" ] && ! grep -q '^pr merge' "$GH_LOG" \
  && echo "  ✔ 검증 도중 처리기가 죽으면 잡은 파일이 남고(머지 안 함) 되돌려 다시 본다" || { echo "  ✖ 검증 도중 죽은 뒤 잡은 파일 남기기 — 남은 것: $(ls "$TMP/queue-confirm/confirm")"; FAIL=1; }
merge_case "autoMergeConfirm: false 라도 머지 직전에 새 커밋 → 머지 안 함" ', "autoMergeConfirm": false' no '바로 머지' FAKE_GH_HEAD_AFTER=1
merge_case "autoMergeConfirm: false 라도 검증 실패 → 머지 안 함" ', "autoMergeConfirm": false' no '검증 대기' FAKE_VERIFY_FAIL=1

# 앞 리뷰 승인 이어받기(지시 2) — 계획서 "- Review result:" 가 같은 내용(tree)으로 승인이면 Claude 를 부르지 않고 그 승인을 쓴다(Codex 는 돈다)
echo; echo "앞 리뷰 승인 이어받기"
TREE="$(git -C "$WT" rev-parse 'HEAD^{tree}')"
CLAUDE_LOG="$TMP/claude-called"; rm -f "$CLAUDE_LOG"
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree ${TREE:0:12} · 📦 web · 🌿 feat/x · 2026-10-26 10:00
" merge_case "같은 tree 로 승인 → Claude 안 부름 · 줄에 '앞 리뷰 승인 이어받음'" ', "autoMergeConfirm": false' yes "머지됨 — squash → main · 리뷰어 claude \\+ codex · Claude: 앞 리뷰 승인 이어받음 @${SHA:0:7}" FAKE_CLAUDE_ARGS="$CLAUDE_LOG"
[ ! -s "$CLAUDE_LOG" ] && echo "  ✔ Claude 리뷰어는 불리지 않았다" || { echo "  ✖ 이어받았는데 Claude 가 불렸다"; FAIL=1; }
grep -q "^pr review 7 " "$GH_LOG" && grep -q "앞 리뷰 승인 이어받음" "$GH_LOG" && echo "  ✔ PR 댓글에 이어받음" || { echo "  ✖ PR 댓글에 이어받음이 없다"; FAIL=1; }
EXTRA_PLAN="- Review result: 승인 @${SHA:0:7} · tree 0000ffff0000 · 📦 web · 🌿 feat/x · 2026-10-26 10:00
" merge_case "tree 가 다르면 → Claude 도 다시 리뷰" ', "autoMergeConfirm": false' yes '머지됨 — squash → main · 리뷰어 claude \+ codex · 라운드' FAKE_CLAUDE_ARGS="$CLAUDE_LOG"
[ -s "$CLAUDE_LOG" ] && echo "  ✔ Claude 리뷰어가 불렸다" || { echo "  ✖ tree 가 다른데 Claude 가 안 불렸다"; FAIL=1; }
echo; echo "사람에게 넘기지 않기(결정 A · B · C)"
OLD7="0000000"
CALLED="$TMP/codex-called"; rm -f "$CALLED"
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — 상한 뒤 이어받음(다음 커밋은 리뷰 없이 검증만) · 라운드 3/3 · 2026-10-26 10:00" \
  merge_case "C — 상한 뒤 이어받은 새 HEAD → 리뷰 없이 검증만으로 바로 머지(확인 없음 레포)" ', "autoMergeConfirm": false' yes "머지됨 — squash → main\(상한 뒤 이어받음 — 리뷰 없이 검증만으로 머지\) · 라운드 4/3" FAKE_CODEX_CALLED="$CALLED"
[ ! -e "$CALLED" ] && grep -q "^pr review 7 .*상한 뒤 이어받음" "$GH_LOG" \
  && echo "  ✔ C — 리뷰어를 부르지 않음 · PR 댓글에 상한 뒤 이어받음" || { echo "  ✖ C — 리뷰어가 불렸거나 댓글이 없다"; FAIL=1; }
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — 상한 뒤 이어받음(다음 커밋은 리뷰 없이 검증만) · 라운드 3/3 · 2026-10-26 10:00" \
  merge_case "C — 이어받은 HEAD · 확인 켠 레포 → 머지 확인 요청(autoMergeConfirm 그대로)" '' no '상한 뒤 이어받음\(리뷰 없이 검증만으로 머지\) → 머지 확인 대기'
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — 상한 뒤 이어받음(다음 커밋은 리뷰 없이 검증만) · 라운드 3/3 · 2026-10-26 10:00" \
  merge_case "C — 이어받은 HEAD 가 검증 실패 → 머지 안 함 · 사람에게(자동 재시도 없음)" ', "autoMergeConfirm": false' no '검증 대기' FAKE_VERIFY_FAIL=1
AUTO_LINE="- Auto review: web#7 @$OLD7 · 리뷰어 부족(승인 1/2) · 라운드 3/3 · 2026-10-26 10:00" \
  merge_case "C — 상한을 넘었는데 직전이 이어받기가 아님 → 멈춤(리뷰 없이 머지 안 함)" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한'
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 · 라운드 2/3 · 2026-10-26 10:00" \
  merge_case "C — 상한 라운드(3/3)에서 수정 필요 → 멈추지 않고 수정 지시 · 줄에 이어받음" ', "autoMergeConfirm": false' no '^- Auto review: web#7 @[0-9a-f]+ · 수정 필요 — 상한 뒤 이어받음' FAKE_CODEX=changes
AUTO_LINE="- Auto review: web#7 @$OLD7 · 상한 뒤 이어받음(리뷰 없이 검증만으로 머지) → 머지 확인 대기 · 라운드 4/3 · 2026-10-26 10:00" \
  merge_case "C — 이어받은 HEAD 가 머지 단계로 간 뒤 또 커밋 → 멈춤(다시 이어받지 않음)" ', "autoMergeConfirm": false' no '멈춤 — 라운드 상한' FAKE_CODEX_CALLED="$CALLED"
AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 · 라운드 2/3 · 2026-10-26 10:00" \
  merge_case "C — 상한 라운드에 리뷰어 하나 실패 → 지적은 보내고 이어받지 않음" ', "autoMergeConfirm": false' no '· 수정 필요 — 리뷰어 부족이라 이어받지 않음 · 리뷰어 claude \+ codex · 라운드 3/3' FAKE_CODEX=slow FAKE_CLAUDE=changes ATHENA_PR_AUTO_TIMEOUT_MS=1500
grep -q 'b.js:2' "$CORE/.requests"/*.json 2>/dev/null && echo "  ✔ C — 리뷰어 부족 상한 라운드도 지적(b.js:2)은 보냄" || { echo "  ✖ C — 리뷰어 부족 상한 라운드 지적"; FAIL=1; }
merge_case "B — 구현 세부 결정 + 추천 → 자동 확정 · 수정 필요(결정 콘솔 없음)" ', "autoMergeConfirm": false' no '· 수정 필요 · 리뷰어 claude \+ codex · 라운드 1/3' FAKE_CODEX=impl
grep -q '^- 추천안으로 자동 확정(자동 리뷰 · codex · web#7 @.* · 구현 세부): 아이콘 자리 → A 왼쪽$' "$CORE/plans/task/x.md" && [ ! -e "$CORE/plans/task/x.html" ] && grep -q "추천안으로 자동 확정" "$GH_LOG" \
  && echo "  ✔ B — 계획서 Decisions · PR 댓글에 추천안으로 자동 확정" || { echo "  ✖ B — 계획서 · 댓글 기록"; sed 's/^/      /' "$CORE/plans/task/x.md"; FAIL=1; }
merge_case "A — 제품 결정 + 수정 지적 → 결정 필요 · 수정 지시도 만듦" ', "autoMergeConfirm": false' no '· 결정 필요 · 리뷰어 claude \+ codex · 라운드 1/3' FAKE_CODEX=product FAKE_CLAUDE=changes
grep -q '"title": "자동 리뷰 수정 지시를 보낼 pane 이 없다' "$CORE/.requests"/*.json 2>/dev/null && grep -q 'b.js:2' "$CORE/.requests"/*.json \
  && echo "  ✔ A — 결정이 있어도 수정 지시(b.js:2)를 보냄(가짜 화면엔 pane 이 없어 사람 요청으로)" || { echo "  ✖ A — 수정 지시가 없다"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
# 가짜 본체엔 docs/plan-template.html 이 없어 plan-html --add 가 실패한다 — 그래도 결정 콘솔과 같은 키의 결정 요청이 열려 머지를 막는다
grep -l '"dedupeKey": "plan:plans/task/x.md"' "$CORE/.requests"/*.json 2>/dev/null | xargs grep -q '결정 콘솔 등록 실패' 2>/dev/null \
  && echo "  ✔ A — 결정 콘솔 등록 실패 → 같은 키(plan:<계획서>)로 결정 요청을 대신 엶" || { echo "  ✖ A — 등록 실패 뒤 결정 요청이 없다"; FAIL=1; }
(cd "$CORE" && env ATHENA_DATA_DIR="$TMP/data" "$(command -v node)" --input-type=module -e "
  const { writeFileSync } = await import('node:fs')
  writeFileSync('plans/task/x.md', '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: $WT · 🌿 feat/x · pane p3 (web-fe)\n- Auto review: web#7 @0000000 · 결정 필요 · 라운드 1/3 · s\n- PR: https://github.com/acme/web/pull/7\n')")
: > "$GH_LOG"; rm -f "$GH_LOG.views"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" \
  "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1
! grep -q '^pr merge' "$GH_LOG" && grep -q '결정 필요 — 승인 2/2이지만 결정 콘솔에 안 정한 결정' "$CORE/plans/task/x.md" \
  && echo "  ✔ A — 그 요청이 남아 있으면 다음 라운드가 승인이어도 머지 안 함" || { echo "  ✖ A — 등록 실패 뒤 머지가 막히지 않음"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
PENDING=1 merge_case "A — 둘 다 승인이어도 결정 콘솔에 안 정한 결정 → 머지 안 함" ', "autoMergeConfirm": false' no '결정 필요 — 승인 2/2이지만 결정 콘솔에 안 정한 결정' FAKE_CODEX=ok
PENDING=1 AUTO_LINE="- Auto review: web#7 @$OLD7 · 수정 필요 — 상한 뒤 이어받음(다음 커밋은 리뷰 없이 검증만) · 라운드 3/3 · 2026-10-26 10:00" \
  merge_case "A · C — 이어받은 HEAD 도 안 정한 결정이 있으면 머지 안 함(다음 커밋도 이어받음)" ', "autoMergeConfirm": false' no '결정 필요 — 상한 뒤 이어받음.*머지 대기'
merge_case "E — 권장만 남은 수정 필요 → 승인으로 보고 머지 단계(바로 머지)" ', "autoMergeConfirm": false' yes '머지됨 — squash → main' FAKE_CODEX=advisory
grep -q "권장 1개는 머지를 막지 않는다" "$GH_LOG" && ! grep -q "수정 지시를 보낼 pane" "$CORE/.requests"/*.json 2>/dev/null \
  && echo "  ✔ E — 권장은 PR 댓글에만(에이전트 지시 없음)" || { echo "  ✖ E — 권장 처리"; FAIL=1; }

# 결정 콘솔 · 대체 요청이 둘 다 실패해도 — 계획서 "- Auto decisions:" 줄(등록 실패)이 남아 머지를 막는다(PR #20 2라운드 지적)
BLOCK_REQUESTS=1 merge_case "A — 콘솔 · 요청 둘 다 실패 → 결정 필요 · 계획서에 결정 대기(등록 실패)" ', "autoMergeConfirm": false' no '· 결정 필요 · 리뷰어 claude \+ codex · 라운드 1/3' FAKE_CODEX=product
MARK="$(grep '^- Auto decisions:' "$CORE/plans/task/x.md")"
case "$MARK" in "- Auto decisions: web#7 @"*" · 1개 · 등록 실패 · "*) echo "  ✔ A — 결정 대기 줄: $MARK" ;; *) echo "  ✖ A — 결정 대기 줄이 없다: $MARK"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1 ;; esac
rm -f "$CORE/.requests"
pending_plan() {   # <결정 대기 줄> — 지난 라운드 줄 · 결정 대기 줄을 둔 계획서
  printf '# 시험\n## Checkpoint\n- Status: ready_for_review\n- Agent: web-fe\n- Work ref: %s · 🌿 feat/x · pane p3 (web-fe)\n- Auto review: web#7 @0000000 · 결정 필요 · 라운드 1/3 · s\n%s\n- PR: https://github.com/acme/web/pull/7\n' "$WT" "$1" > "$CORE/plans/task/x.md"
}
run_handle() { : > "$GH_LOG"; rm -f "$GH_LOG.views"; env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$SHA" FAKE_CODEX=ok GH_LOG="$GH_LOG" "$@" "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1; }
printf '{ "github": { "org": "acme" }, "repos": [ { "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoMergeConfirm": false } ] }\n' > "$CORE/athena.config.json"
rm -rf "$CORE/.requests"; pending_plan "$MARK"; run_handle
! grep -q '^pr merge' "$GH_LOG" && grep -q '결정 필요 — 승인 2/2이지만' "$CORE/plans/task/x.md" && grep -q '^- Auto decisions: .*등록 실패' "$CORE/plans/task/x.md" \
  && echo "  ✔ A — 요청이 하나도 없어도 등록 실패 줄이 있으면 승인돼도 머지 안 함 · 줄 그대로" || { echo "  ✖ A — 등록 실패 줄로 머지가 막히지 않음"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
rm -rf "$CORE/.requests"; pending_plan "- Auto decisions: web#7 @0000000 · 1개 · 등록됨 · 결정 콘솔에서 다 정하면 저절로 지워진다 · s"; run_handle
grep -q "^pr merge 7 --repo acme/web --squash --match-head-commit $SHA" "$GH_LOG" && ! grep -q '^- Auto decisions:' "$CORE/plans/task/x.md" \
  && echo "  ✔ A — 등록됨 · 결정 요청이 닫혔으면 해결 — 줄을 지우고 머지" || { echo "  ✖ A — 등록됨 해결"; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }
# 리뷰어가 하나라도 실패한 라운드는 지난 리뷰 기록(history)을 덮지 않는다(PR #20 2라운드 지적)
merge_case "D — 리뷰어 하나 실패한 라운드 → 수정 필요(지적은 보냄)" ', "autoMergeConfirm": false' no '· 수정 필요 · 리뷰어 claude \+ codex · 라운드 1/3' FAKE_CODEX=slow FAKE_CLAUDE=changes ATHENA_PR_AUTO_TIMEOUT_MS=1500
[ ! -e "$TMP/queue-confirm/history/web-7.json" ] && echo "  ✔ D — 리뷰어가 실패한 라운드는 history 를 남기지 않음" || { echo "  ✖ D — 실패한 라운드가 history 를 썼다"; FAIL=1; }

# 결정 D — 1라운드 지적을 기록해 두고, 2라운드 프롬프트에는 지난 지적 + 지난 리뷰 HEAD 이후 바뀐 diff 만
echo; echo "지적은 한 번에(결정 D)"
PROMPT="$TMP/prompt.txt"
merge_case "D — 1라운드: 수정 필요 · 지난 지적 기록" ', "autoMergeConfirm": false' no '· 수정 필요 · 리뷰어 claude \+ codex · 라운드 1/3' FAKE_PROMPT="$PROMPT" FAKE_CODEX=changes
grep -q "찾을 수 있는 지적을 이번 리뷰에서 모두 낸다" "$PROMPT" && ! grep -q "지난 리뷰 지적" "$PROMPT" && grep -q '"file": "a.js"' "$TMP/queue-confirm/history/web-7.json" \
  && echo "  ✔ D — 1라운드 프롬프트는 '모두 한 번에' · history 에 보낸 지적" || { echo "  ✖ D — 1라운드"; sed 's/^/      /' "$PROMPT" | head -20; FAIL=1; }
S1="$SHA"; echo 'fixed' > "$WT/a.js"; git -C "$WT" add a.js && git -C "$WT" -c user.name=t -c user.email=t@t commit -q -m fix
S2="$(git -C "$WT" rev-parse HEAD)"; : > "$GH_LOG"
env PATH="$BIN:/usr/bin:/bin" ATHENA_DATA_DIR="$TMP/data" ATHENA_PR_AUTO_QUEUE="$TMP/queue-confirm" FAKE_SHA="$S2" GH_LOG="$GH_LOG" FAKE_PROMPT="$PROMPT" \
  "$(command -v node)" "$CORE/scripts/pr-auto.mjs" --plan plans/task/x.md --pr web#7 > "$TMP/merge.out" 2>&1
grep -q "이번은 2번째 리뷰다" "$PROMPT" && grep -q "지난 리뷰 지적 (@${S1:0:7}" "$PROMPT" && grep -q "1) a.js:1 — p → f" "$PROMPT" \
  && grep -q "지난 리뷰 HEAD @${S1:0:7} 이후 바뀐 것만" "$PROMPT" && grep -q "^+fixed" "$PROMPT" \
  && ! grep -q "^pr diff" "$GH_LOG" && grep -q "· 라운드 2/3" "$CORE/plans/task/x.md" \
  && echo "  ✔ D — 2라운드 프롬프트: 지난 지적 · 지난 HEAD 이후 diff 만(gh pr diff 안 부름)" || { echo "  ✖ D — 2라운드"; sed 's/^/      /' "$PROMPT" | tail -25; sed 's/^/      /' "$TMP/merge.out"; FAIL=1; }

[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
