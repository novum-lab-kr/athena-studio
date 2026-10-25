#!/usr/bin/env bash
# PR 자동 리뷰 시험 — scripts/lib/pr-auto.mjs 의 판정 · 계획서 표시 줄 · 대상 고르기와 scripts/pr-auto.mjs 의 리뷰어 실행을
# 가짜 claude · codex 로 본다(GitHub · 진짜 LLM · 본체를 건드리지 않는다 · 몇 초)
#
# 사용: test/pr-auto-test.sh     → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#
# 보는 것(docs/pr-auto.md): 둘 다 승인해야 승인 · 하나라도 실패 · 없음 · 반려면 머지 안 함 · 모순된 답(승인인데 지적)은 승인으로 안 셈 ·
# 같은 HEAD 는 한 번만 · 멈춤 · 머지됨은 다시 안 돎 · 표시 줄 바꿔 쓰기 · 레포 하나짜리만 · 켠 레포만(main 직접 제외) · 댓글의 비밀값 가림 ·
# 가짜 리뷰어 — 둘 다 답 · 명령 없음 · 시간 넘김 · 모양이 틀린 답
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC" || exit 1
TMP="$(mktemp -d "${TMPDIR:-/tmp}/athena-pr-auto-test.XXXXXX")"
[ "${KEEP:-0}" = 1 ] || trap 'rm -rf "$TMP"' EXIT
FAIL=0

node --input-type=module - <<'EOF' || FAIL=1
import { aggregate, autoLines, autoMergeRepos, needsReview, reviewComment, singleRepoPlan, validReview, withAutoLine, workRefOf, REVIEWERS } from './scripts/lib/pr-auto.mjs'
import { maskSecrets } from './scripts/lib/mask.mjs'
let pass = 0, fail = 0
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ✔ ${name}`) } else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ''}`) } }
const approve = { verdict: 'approve', summary: '좋다', findings: [], decisions: [] }
const changes = { verdict: 'changes', summary: '고칠 것', findings: [{ file: 'a.js', line: 3, problem: 'p', fix: 'f' }], decisions: [] }
const decision = { verdict: 'decision', summary: '정할 것', findings: [], decisions: [{ title: 't', why: 'w', options: [{ label: 'A', desc: '' }, { label: 'B', desc: '' }], recommended: 'A' }] }
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
  && !validReview({ ...changes, findings: [...changes.findings, { problem: 'p' }] })
  && !validReview({ ...decision, decisions: [{ ...decision.decisions[0], options: [{ label: 'A', desc: '' }] }] }))

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
const ref = workRefOf(plan)
check('Work ref 에서 워크트리 · 브랜치 · pane · 에이전트', ref.worktree === '/tmp/wt/web-x' && ref.branch === 'feat/x' && ref.pane === 'p3' && ref.agent === 'web-fe', JSON.stringify(ref))

console.log('\n대상(결정 D4 — 켠 레포의 레포 하나짜리 PR 만)')
const config = { repos: [
  { name: 'web', agents: ['web-fe'], autoMerge: true },
  { name: 'api', agents: ['api-be'] },
  { name: 'app', agents: ['app-fe'], autoMerge: true, direct: true },
] }
check('autoMerge: true 인 레포만 · main 직접 레포는 빼고 · 기본 꺼짐', JSON.stringify([...autoMergeRepos(config)]) === '["web"]')
check('Agent 줄이 이 레포 에이전트 하나 → 대상', singleRepoPlan('- Agent: web-fe\n', config, 'web'))
const formal = '## 6. 작업 배분\n\n| 담당 | 작업 |\n|---|---|\n| api-be | x |\n| web-fe | y |\n| reviewer | z |\n'
check('작업 배분 표에 다른 레포 에이전트가 있으면 → 대상 아님', !singleRepoPlan(formal, config, 'web'))
check('에이전트가 없거나 다른 레포 것이면 → 대상 아님', !singleRepoPlan('- Agent: api-be\n', config, 'web') && !singleRepoPlan('본문만\n', config, 'web'))

console.log('\n댓글')
const comment = reviewComment({ sha: 'abcdef123', round: 1, results: [ok('claude', { ...changes, summary: '토큰 ghp_' + 'a'.repeat(30) + ' 이 보인다' }), { name: 'codex', status: 'failed', reason: '시간 넘김' }], summary: aggregate([ok('claude', changes), { name: 'codex', status: 'failed' }]) })
check('결론 · 리뷰어마다 줄 · 실패 이유', comment.includes('결론: 수정 필요') && comment.includes('**codex** — 실패(시간 넘김)') && comment.includes('`a.js:3`'), comment)
check('비밀값 모양은 가린 뒤 보낸다(pr-auto.mjs 가 maskSecrets 로 감쌈)', !maskSecrets(comment).masked.includes('a'.repeat(30)))
console.log(`\n${pass + fail}개 중 실패 ${fail}`)
process.exit(fail ? 1 : 0)
EOF

# ── 가짜 리뷰어로 실행 ───────────────────────────────────────────────────
BIN="$TMP/bin"; mkdir -p "$BIN"
# claude -p --output-format json --json-schema … — structured_output 에 답(learn-review 가 쓰는 꼴)
cat > "$BIN/claude" <<'SH'
#!/bin/sh
cat > /dev/null
case "${FAKE_CLAUDE:-approve}" in
  approve) echo '{"is_error":false,"structured_output":{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}}' ;;
  bad) echo '{"is_error":false,"structured_output":{"verdict":"maybe"}}' ;;
esac
SH
# codex exec … -o <파일> — 마지막 답을 그 파일에
cat > "$BIN/codex" <<'SH'
#!/bin/sh
cat > /dev/null
# 도구 없이 돌리는 옵션(사용자 설정 · 셸 · 웹 끄기)이 빠지면 실패한다 — docs/pr-auto.md "리뷰어"
case " $* " in *" --ignore-user-config "*) ;; *) echo "도구 끄기 옵션 없음" >&2; exit 9 ;; esac
case " $* " in *" --disable shell_tool "*) ;; *) echo "셸 끄기 없음" >&2; exit 9 ;; esac
case " $* " in *'web_search="disabled"'*) ;; *) echo "웹 끄기 없음" >&2; exit 9 ;; esac
[ "${FAKE_CODEX:-approve}" = slow ] && sleep 30
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
if [ "${FAKE_CODEX:-}" = ok ]; then echo '{"verdict":"approve","summary":"좋다","findings":[],"decisions":[]}' > "$out"
else echo '{"verdict":"changes","summary":"고칠 것","findings":[{"file":"a.js","line":1,"problem":"p","fix":"f"}],"decisions":[]}' > "$out"; fi
SH
chmod +x "$BIN/claude" "$BIN/codex"
run_case() {   # <이름> <PATH> <기대 판정> [환경…]
  local name="$1" path="$2" want="$3"; shift 3
  local got
  got="$(env PATH="$path" ATHENA_PR_AUTO_TIMEOUT_MS=1500 "$@" "$(command -v node)" --input-type=module -e "
    const { runReviewers } = await import('./scripts/pr-auto.mjs')
    const { aggregate, reviewerBrief } = await import('./scripts/lib/pr-auto.mjs')
    const results = await runReviewers('리뷰해 줘')
    console.log(aggregate(results).verdict + ' ' + reviewerBrief(results))" 2>&1 | tail -1)"
  if [ "${got%% *}" = "$want" ]; then echo "  ✔ $name — $got"; else echo "  ✖ $name — 기대 $want · 실제 $got"; FAIL=1; fi
}
echo; echo "가짜 리뷰어"
run_case "둘 다 승인 → 승인" "$BIN:/usr/bin:/bin" approve FAKE_CODEX=ok
run_case "둘 다 답함(claude 승인 · codex 수정 필요) → 수정 필요" "$BIN:/usr/bin:/bin" changes
ONLY="$TMP/only-claude"; mkdir -p "$ONLY"; cp "$BIN/claude" "$ONLY/"
run_case "codex 명령 없음 → 리뷰어 부족(claude 승인만으로 머지 안 함)" "$ONLY:/usr/bin:/bin" insufficient
run_case "codex 시간 넘김 → 리뷰어 부족" "$BIN:/usr/bin:/bin" insufficient FAKE_CODEX=slow
run_case "claude 답 모양이 틀림 → 그 리뷰어는 실패" "$BIN:/usr/bin:/bin" changes FAKE_CLAUDE=bad

[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
