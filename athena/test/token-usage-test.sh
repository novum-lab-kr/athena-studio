#!/usr/bin/env bash
# 토큰 사용량 측정 시험 — 가짜 대화 기록(jsonl)으로 scripts/token-usage.mjs 의 숫자를 본다(진짜 ~/.claude 를 읽지 않는다 · 몇 초)
#
# 사용: test/token-usage-test.sh    → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#
# 보는 것: 역할 가르기(작업자 머리 · 리뷰어 머리 · 본체 루트 = 아테나 · 본체 하위 폴더 = 기타 · 워크트리 = 작업자) · 한 응답이 여러 줄이어도 한 턴 ·
# 이어 쓰기로 복사된 응답 · 받은 글은 한 번만 · 기간 밖 줄 빼기 · Bash 하나만 턴과 종류(lead-log · sleep · pane 읽기) · 답 끝 📝 줄 리드 기록 ·
# 받은 글(바로 받음 + 대기열)과 끝 알림 · 서브에이전트는 부모 역할 · 가중 비용 비중 · 예상 절감 네 갈래 셈 · 대화 본문을 찍지 않음
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$TMP"' EXIT
STUDIO="$TMP/studio"; PROJ="$TMP/projects"
mkdir -p "$STUDIO/bodies/b1/scripts/qa" "$STUDIO/data/packs/acme/worktrees/app/feat-x" "$PROJ/lead" "$PROJ/worker" "$PROJ/other"
node --input-type=module - "$STUDIO" "$PROJ" <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [studio, proj] = process.argv.slice(2)
const body = join(studio, 'bodies/b1')
const tree = join(studio, 'data/packs/acme/worktrees/app/feat-x')
const at = (day, hour = 12) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`
const ts = (day, hour) => new Date(at(day, hour)).toISOString()   // 이 컴퓨터 시간대의 날짜로
const usage = (input, write, read, output, write1h = 0) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write - write1h } })
const user = (cwd, text, day, uuid) => ({ type: 'user', cwd, uuid, timestamp: ts(day), message: { role: 'user', content: text } })
const reply = (cwd, id, day, use, tools = [], text = '') => ({ type: 'assistant', cwd, timestamp: ts(day), message: { id, role: 'assistant', usage: use, content: [...(text ? [{ type: 'text', text }] : []), ...tools.map((command, index) => ({ type: 'tool_use', id: `${id}-${index}`, name: command === 'READ' ? 'Read' : 'Bash', input: { command } }))] } })
const queued = (cwd, text, day, uuid) => ({ type: 'attachment', cwd, uuid, timestamp: ts(day), attachment: { type: 'queued_command', prompt: text } })
const write = (path, rows) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n') }
// 아테나 — 본체 루트 · 응답 L1 은 두 줄(같은 id · 마지막 줄 usage 가 최종) · L2 lead-log · L3 sleep · L4 pane 읽기 · L5 Bash 둘 · L6 기간 밖
write(join(proj, 'lead/s-lead.jsonl'), [
  user(body, '비밀 본문 SECRET-TEXT', 20, 'u0'),
  reply(body, 'L1', 20, usage(1, 0, 0, 1), ['READ']),
  reply(body, 'L1', 20, usage(10, 100, 1000, 20), ['READ']),
  reply(body, 'L2', 20, usage(0, 0, 1000, 10), ['node scripts/lead-log.mjs 사실 "x"']),
  reply(body, 'L3', 21, usage(0, 0, 1000, 10), ['sleep 30']),
  reply(body, 'L4', 21, usage(0, 0, 1000, 10), ['scripts/screen pane read p1l4 --lines 30']),
  reply(body, 'L5', 21, usage(0, 0, 1000, 10), ['ls', 'pwd']),
  reply(body, 'L6', 10, usage(0, 0, 99999, 10), ['sleep 5']),
  user(body, '[athena-studio-fe → 아테나] 끝 · p1l4 · 계획서 plans/task/a.md — 요약: x', 21, 'r1'),
  queued(body, '[reviewer → 아테나] ⏸ 멈춤 · p2', 21, 'r2'),
  user(body, '[현황판 → 아테나] 자동 완료', 10, 'r3'),
  user(body, '그냥 사용자 말', 21, 'u1'),
])
// 같은 아테나를 이어 쓴 파일 — L1 · r1 이 복사돼 있다(한 번만 센다) · 서브에이전트 기록은 부모(아테나) 역할로
write(join(proj, 'lead/s-lead2.jsonl'), [
  reply(body, 'L1', 20, usage(10, 100, 1000, 20), ['READ']),
  user(body, '[athena-studio-fe → 아테나] 끝 · p1l4 · 계획서 plans/task/a.md — 요약: x', 21, 'r1'),
  // L7 — 답 끝 📝 줄 2(정정 · 전각 콜론 사실) · 코드 블록 안 예시 · 모르는 종류는 안 센다
  reply(body, 'L7', 22, usage(0, 0, 0, 0), [], '끝냈습니다.\n```\n📝 결정: 예시\n```\n📝 정정: 금요일 배포 안 함\n  📝 사실： 태그가 다시 생김\n📝 아무거나: x'),
  // 예상 절감 — 쉬던 아테나를 깨운 끝 알림 r4 → L8 send-text(p2a1) → 확인 턴 L9 sleep · L10 내 pane 읽기 → L11 Read → L12 남의 pane(p9z1) 읽기
  user(body, '[athena-studio-fe → 아테나] 끝 · p3b1 · 계획서 plans/task/b.md', 22, 'r4'),
  reply(body, 'L8', 22, usage(0, 0, 0, 10), ["scripts/screen pane send-text p2a1 '[아테나 → fe] 고쳐' --enter"]),
  reply(body, 'L9', 22, usage(0, 0, 1000, 0), ['sleep 20']),
  reply(body, 'L10', 22, usage(0, 0, 1200, 0), ['scripts/screen pane read p2a1 --lines 20']),
  reply(body, 'L11', 22, usage(0, 0, 2000, 0), ['READ']),
  reply(body, 'L12', 22, usage(0, 0, 2000, 0), ['scripts/screen pane read p9z1 --lines 20']),
])
write(join(proj, 'lead/s-lead2/subagents/agent-1.jsonl'), [reply(body, 'S1', 22, usage(0, 10, 0, 0), ['READ'])])
// 작업자 — 머리로(cwd 가 본체여도) · 리뷰어 머리 · 머리 없이 워크트리에서 새로 시작한 작업자
write(join(proj, 'worker/s-w1.jsonl'), [
  user(body, `이 작업의 계획서: ${body}/plans/task/a.md — 먼저 읽고`, 20, 'w0'),
  reply(body, 'W1', 20, usage(0, 0, 0, 100), ['sleep 10 && echo ok']),
  reply(body, 'W2', 20, usage(0, 0, 0, 100), ['npm test']),
])
write(join(proj, 'worker/s-r1.jsonl'), [
  user(tree, `리뷰할 계획서: ${body}/plans/task/a.md — 읽기 전용으로`, 20, 'v0'),
  reply(tree, 'R1', 20, usage(0, 0, 0, 100), ['READ']),
])
write(join(proj, 'worker/s-w2.jsonl'), [
  user(tree, '이어서 — Checkpoint 부터', 20, 'w9'),
  reply(tree, 'W3', 20, usage(0, 0, 0, 100), ['git status'], '📝 결정: 작업자 답은 리드 기록이 아니다'),
])
// 기타 — 본체 하위 폴더 · 스튜디오 밖
write(join(proj, 'other/s-o1.jsonl'), [reply(join(body, 'scripts/qa'), 'O1', 20, usage(0, 0, 0, 100), [])])
write(join(proj, 'other/s-o2.jsonl'), [reply('/somewhere/else', 'O2', 20, usage(0, 0, 0, 100), [])])
JS
FAIL=0
ok() { echo "  ✔ $1"; }
bad() { echo "  ✖ $1"; FAIL=1; }
JSON="$(node "$SRC/scripts/token-usage.mjs" --since 2026-11-19 --until 2026-11-22 --projects "$PROJ" --studio "$STUDIO" --json)" || bad "--json 종료 코드"
TABLE="$(node "$SRC/scripts/token-usage.mjs" --since 2026-11-19 --until 2026-11-22 --projects "$PROJ" --studio "$STUDIO")" || bad "표 종료 코드"
check() {   # check '<설명>' '<JS 식 — r 이 결과>'
  if node -e "const r = JSON.parse(process.argv[1]); process.exit(($2) ? 0 : 1)" "$JSON"; then ok "$1"; else bad "$1"; fi
}
echo "▶ 역할 가르기"
check "아테나 세션 2 · 턴 12(L1 두 줄은 한 턴 · 복사된 L1 한 번 · 기간 밖 L6 뺌 · 서브에이전트 S1 포함)" "r.roles.lead.sessions === 2 && r.roles.lead.turns === 12"
check "작업자 = 머리 있는 세션(cwd 가 본체여도) + 머리 없는 워크트리 세션 · 턴 3" "r.roles.worker.sessions === 2 && r.roles.worker.turns === 3"
check "리뷰어 머리 → 리뷰어" "r.roles.reviewer.sessions === 1 && r.roles.reviewer.turns === 1"
check "본체 하위 폴더 · 스튜디오 밖 → 기타" "r.roles.other.sessions === 2 && r.roles.other.turns === 2"
echo "▶ 토큰 · 비용"
check "아테나 토큰 합(L1 마지막 줄 값 · S1 캐시 쓰기)" "r.roles.lead.input === 10 && r.roles.lead.cacheWrite === 110 && r.roles.lead.cacheRead === 11200 && r.roles.lead.output === 70"
check "비용 비중 합 ≈ 100 · 기간 11-19 ~ 11-22" "Math.abs(Object.values(r.roles).reduce((a, x) => a + x.costShare, 0) - 100) < 0.5 && r.since === '2026-11-19' && r.until === '2026-11-22'"
echo "▶ 단독 턴"
check "아테나 Bash 하나만 7 = lead-log 1 · sleep 2 · pane 읽기 3(Bash 둘인 L5 는 아님)" "r.roles.lead.bashOnly.turns === 7 && r.roles.lead.bashOnlyKinds.leadLog.turns === 1 && r.roles.lead.bashOnlyKinds.sleep.turns === 2 && r.roles.lead.bashOnlyKinds.paneRead.turns === 3"
check "작업자 Bash 하나만 3 · 그중 sleep 1(sleep 10 && …)" "r.roles.worker.bashOnly.turns === 3 && r.roles.worker.bashOnlyKinds.sleep.turns === 1"
echo "▶ 받은 글"
check "아테나가 받은 글 3(바로 받음 r1 · r4 · 대기열 r2 · 복사된 r1 한 번 · 기간 밖 r3 뺌) · 끝 알림 2" "r.roles.lead.received === 3 && r.roles.lead.doneNotices === 2"
check "답 끝 📝 줄 리드 기록 2(코드 블록 · 모르는 종류 빼고) · 작업자 답의 📝 줄은 안 센다" "r.roles.lead.replyLogs === 2 && r.roles.worker.replyLogs === 0"
echo "▶ 예상 절감(가중 토큰)"
# r4: 글자 수 × 0.5 토큰 × 캐시 읽기 0.1 × 뒤 응답 5 + 깨어난 L8 비용 50 · r1 은 뒤 응답이 없어 0
check "끝 알림 2건 = r4 글 크기 × 뒤 5턴 + 깨운 턴" "r.savings.kinds.doneNotice.count === 2 && r.savings.kinds.doneNotice.weighted === Math.round('[athena-studio-fe → 아테나] 끝 · p3b1 · 계획서 plans/task/b.md'.length * 0.5 * 0.1 * 5 + 50)"
# L9: 비용 100 + 문맥 늘어난 200 × 0.1 × 뒤 3턴 = 160 · L10: 120 + 800 × 0.1 × 2 = 280
check "보낸 뒤 확인 턴 2(L9 sleep · L10 pane 읽기) = 440" "r.savings.kinds.confirmAfterSend.count === 2 && r.savings.kinds.confirmAfterSend.weighted === 440"
check "lead-log 만 한 턴 1 = 그 턴 비용 150" "r.savings.kinds.leadLogOnly.count === 1 && r.savings.kinds.leadLogOnly.weighted === 150"
check "남의 pane 읽기 1(p9z1 · 알림 받은 p1l4 는 아님) = 200" "r.savings.kinds.foreignPaneRead.count === 1 && r.savings.kinds.foreignPaneRead.weighted === 200"
check "합 · 비중" "r.savings.estimate === true && r.savings.weighted === Object.values(r.savings.kinds).reduce((a, x) => a + x.weighted, 0) && r.savings.shareOfLead > r.savings.shareOfAll"
echo "▶ 출력"
if printf '%s\n%s' "$JSON" "$TABLE" | grep -q 'SECRET-TEXT\|요약: x\|lead-log.mjs 사실\|고쳐\|금요일 배포'; then bad "대화 본문 · 명령 글이 출력에 나옴"; else ok "대화 본문 · 명령 글을 찍지 않음"; fi
printf '%s' "$TABLE" | grep -q '^| 아테나 | 2 | 12 |' && printf '%s' "$TABLE" | grep -q '아테나가 받은 글 3건 · 그중 끝 알림 2건' && printf '%s' "$TABLE" | grep -q '답 끝 📝 줄로 남긴 리드 기록 2줄' && printf '%s' "$TABLE" | grep -q '덜 씀 — 추정' && ok "표 줄" || bad "표 줄: $TABLE"
node "$SRC/scripts/token-usage.mjs" --since 2026-11-22 --until 2026-11-19 --projects "$PROJ" >/dev/null 2>&1; [ $? -eq 2 ] && ok "기간이 거꾸로면 종료 2" || bad "기간 거꾸로 종료 코드"
exit $FAIL
