#!/usr/bin/env bash
# 요청(request) 시험 — 작업 트리를 임시 폴더에 복사한 본체 + 임시 데이터 폴더에서 bin/athena request 명령을 끝까지 돌린다.
# 진짜 스튜디오 집(~/.athena-studio) · 이 체크아웃은 건드리지 않는다(임시 폴더만 · 끝나면 지운다).
#
# 사용: test/requests-test.sh            → 항목마다 ✔/✖, 하나라도 ✖ 면 1
#       KEEP=1 test/requests-test.sh     → 임시 폴더를 남긴다
#
# 보는 것(docs/requests.md): 열기 · 자리(팩 데이터 state/requests) · 같은 키는 고치기 · rev 충돌 · 두 번 답하기 거절 · ack(두 번 불러도 됨) ·
# 대화로 답하면 바로 delivered · 취소 · 다른 세대 답 거절 · 계획서 done/없어지면 expired · 결정 콘솔(plan-html.mjs)이 요청을 열고 닫기 ·
# 결정 콘솔 [이대로 진행](현황판 /api/action + plan)이 답을 적기 · 사용법 오류
. "$(dirname "$0")/_lib.sh"   # 통과 줄 숨기기 — ATHENA_TEST_VERBOSE=1 이면 전부
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/requests-test.XXXXXX")" && pwd -P)"
[ "${KEEP:-}" = 1 ] || trap 'pkill -f "$WORK/body/scripts/board/server.mjs" 2>/dev/null; rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✔ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✖ %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2" | head -c 600 && echo; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
section() { printf '\n%s\n' "$1"; }
unset ATHENA_AGENT ATHENA_STUDIO ATHENA_BOARD_PORT ATHENA_PACK_FAIL_AT
export ATHENA_SCREEN=none ATHENA_BOARD_NO_BROWSER=1 ATHENA_DATA_DIR="$WORK/test-data" ATHENA_HEAVY_LOCK="$WORK/heavy.lock"

B="$WORK/body"
git clone -q "$SRC" "$B" 2>/dev/null || { mkdir -p "$B"; git -C "$B" init -q; }
rsync -a --delete --exclude .git --exclude .omc --exclude /plans --exclude /issues --exclude /repos --exclude /.worktrees --exclude /pack --exclude /packs \
  --exclude /archive --exclude /.sync --exclude /.pack-data --exclude /athena.config.json --exclude __pycache__ --exclude '/.board-*' --exclude '/.qa-*' \
  --exclude /.requests --exclude /.jev-log.jsonl --exclude /.events.jsonl --exclude /.migrate-* --exclude node_modules "$SRC/" "$B/"
cd "$B" || exit 1
A() { node scripts/athena.mjs "$@" --json 2>/dev/null | tail -1; }
field() { python3 -c 'import json,sys
d=json.loads(sys.stdin.read() or "{}")
for k in sys.argv[1].split("."):
    if isinstance(d, list): d = d[int(k)] if k.isdigit() and int(k) < len(d) else None
    else: d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else (json.dumps(d) if isinstance(d,(dict,list)) else d))' "$1"; }
printf '{ "boardPort": 47730 }\n' > athena.config.json
A pack test-setup > /dev/null
DIR="$(cd .pack-data/state && pwd -P)/requests"

section "열기 · 자리"
R="$(A request open --kind decision --title '결정 하나' --option 'A :: 첫째' --option B --recommend A --key k1 --pane p1)"
ID="$(echo "$R" | field request.id)"
check "열림 · rev 1 · 팩 acme · pane p1" '[ "$(echo "$R" | field request.state)" = open ] && [ "$(echo "$R" | field request.rev)" = 1 ] && [ "$(echo "$R" | field request.pack)" = acme ] && [ "$(echo "$R" | field request.pane)" = p1 ]' "$R"
check "--html 없는 decision 도 --html 있는 decision 도 decision 그대로" '[ "$(echo "$R" | field request.kind)" = decision ] && HK="$(A request open --kind decision --title 콘솔 --html plans/x.html --key kh)"; [ "$(echo "$HK" | field request.kind)" = decision ] && A request cancel "$(echo "$HK" | field request.id)" >/dev/null' "$R"
check "선택지 · 추천 · 설명" '[ "$(echo "$R" | field request.options.0.recommended)" = True ] && [ "$(echo "$R" | field request.options.0.desc)" = 첫째 ] && [ "$(echo "$R" | field request.options.1.label)" = B ]' "$R"
check "팩 데이터 state/requests/<id>.json · 잠금은 남지 않음" '[ -f "$DIR/$ID.json" ] && [ ! -e "$DIR/.lock" ]'
R="$(A request open --kind decision --title '결정 하나(고침)' --key k1)"
check "같은 키 → 같은 요청을 고친다(rev 2)" '[ "$(echo "$R" | field request.id)" = "$ID" ] && [ "$(echo "$R" | field reused)" = True ] && [ "$(echo "$R" | field request.rev)" = 2 ]' "$R"
check "목록에 하나" '[ "$(A request list | field requests | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")" = 1 ]'
KR="$(A request open --kind question --title '옵션 그대로?' --option 'A :: 첫째' --option B --recommend A --key k-options)"
KID="$(echo "$KR" | field request.id)"
KR="$(A request open --kind question --title '옵션 그대로?(고침)' --key k-options)"
check "옵션 있는 요청을 옵션 없이 다시 열기 → 옵션 유지 · 제목은 고침(rev +1 · reused)" '[ "$(echo "$KR" | field request.id)" = "$KID" ] && [ "$(echo "$KR" | field reused)" = True ] && [ "$(echo "$KR" | field request.rev)" = 2 ] && [ "$(echo "$KR" | field request.title)" = "옵션 그대로?(고침)" ] && [ "$(echo "$KR" | field request.options.0.label)" = A ] && [ "$(echo "$KR" | field request.options.0.recommended)" = True ] && [ "$(echo "$KR" | field request.options.1.label)" = B ]' "$KR"
check "다시 연 뒤 파일에도 옵션이 남는다" '[ "$(A request show "$KID" | field request.options.1.label)" = B ]'
KR="$(A request open --kind question --title '옵션 바꿈' --option C --key k-options)"
check "옵션을 새로 주면 바뀐다(rev +1)" '[ "$(echo "$KR" | field request.rev)" = 3 ] && [ "$(echo "$KR" | field request.options.0.label)" = C ] && [ -z "$(echo "$KR" | field request.options.1.label)" ]' "$KR"
A request answer "$KID" --by app --choice C > /dev/null
KR="$(A request open --kind question --title '답 뒤 다시' --key k-options)"
check "답을 받은 뒤 옵션 없이 다시 열어도 → open · 답 지움 · 옵션 유지" '[ "$(echo "$KR" | field request.state)" = open ] && [ -z "$(echo "$KR" | field request.answer)" ] && [ "$(echo "$KR" | field request.options.0.label)" = C ]' "$KR"
A request cancel "$KID" > /dev/null

section "답하기 · 받기"
check "옛 rev 로 답하면 conflict" '[ "$(A request answer "$ID" --by board --choice A --rev 1 | field error)" = conflict ]'
R="$(A request answer "$ID" --by board --choice A --rev 2)"
check "답함 → answered · 답 기록" '[ "$(echo "$R" | field request.state)" = answered ] && [ "$(echo "$R" | field request.answer.choice)" = A ] && [ "$(echo "$R" | field request.answer.by)" = board ]' "$R"
check "두 번 답하면 conflict" '[ "$(A request answer "$ID" --by app --choice B | field error)" = conflict ]'
check "answered 는 아직 목록에(전달 전)" '[ "$(A request list | field requests.0.id)" = "$ID" ]'
check "ack → delivered" '[ "$(A request ack "$ID" | field request.state)" = delivered ]'
check "ack 두 번 → already" '[ "$(A request ack "$ID" | field already)" = True ]'
check "delivered 는 목록에서 빠지고 --all 에는 있다" '[ -z "$(A request list | field requests.0.id)" ] && [ "$(A request list --all | field requests.0.id)" = "$ID" ]'
check "같은 키로 다시 열면 새 요청" '[ "$(A request open --kind decision --title 다시 --key k1 | field request.id)" != "$ID" ]'

section "질문 · 대화로 답 · 취소"
Q="$(A request open --kind question --title '이 필드가 있나요?' --body '근거 …' | field request.id)"
R="$(A request answer "$Q" --by chat --text '있다')"
check "대화로 답 → 바로 delivered" '[ "$(echo "$R" | field request.state)" = delivered ] && [ -n "$(echo "$R" | field request.deliveredAt)" ]' "$R"
C="$(A request open --kind question --title 취소할것 | field request.id)"
check "취소 → cancelled · 이유" '[ "$(A request cancel "$C" --reason 필요없음 | field request.closedReason)" = 필요없음 ]'
check "취소한 것 다시 취소 → conflict" '[ "$(A request cancel "$C" | field error)" = conflict ]'

section "세대 · 계획서"
S="$(A request open --kind question --title 옛세대 | field request.id)"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["generation"]=d["generation"]-1; json.dump(d,open(p,"w"))' "$DIR/$S.json"
check "다른 세대 요청에 답 → stale" '[ "$(A request answer "$S" --by board --choice x | field error)" = stale ]'
mkdir -p plans/task
printf '# 일\n\n## Checkpoint\n- Status: in_progress\n' > plans/task/20261021-x.md
P="$(A request open --kind question --title 계획서질문 --plan plans/task/20261021-x.md | field request.id)"
check "계획서 진행 중이면 열린 채" 'A request list | grep -q "$P"'
sed -i.bak 's/in_progress/done/' plans/task/20261021-x.md
A request list > /dev/null
check "계획서 done 이어도 답 기다리는 질문(open)은 그대로 열린 채" '[ "$(A request show "$P" | field request.state)" = open ] && A request list | grep -q "$P"'
A request answer "$P" --by app --choice x > /dev/null
A request list > /dev/null
check "답이 온 질문(answered)도 계획서 done 이어도 ack 까지 유지" '[ "$(A request show "$P" | field request.state)" = answered ] && A request list | grep -q "$P"'
DEC="$(A request open --kind decision --title 결정콘솔 --html plans/x.html --key kd --plan plans/task/20261021-x.md | field request.id)"
A request answer "$DEC" --by board --choice x > /dev/null
A request list > /dev/null
check "결정 콘솔(answered)은 계획서 done → expired" '[ "$(A request show "$DEC" | field request.state)" = expired ] && [ "$(A request show "$DEC" | field request.closedReason)" = "계획서가 done" ]'
NOHTML="$(A request open --kind decision --title 콘솔없음 --option A --plan plans/task/20261021-x.md | field request.id)"
A request list > /dev/null
check "콘솔 없는 decision 은 계획서 done 이어도 답을 기다린다" '[ "$(A request show "$NOHTML" | field request.state)" = open ]'
A request cancel "$NOHTML" --reason 시험 > /dev/null
PLANKEY="$(A request open --kind decision --title 콘솔등록실패 --key plan:plans/task/20261021-x.md --plan plans/task/20261021-x.md | field request.id)"
A request list > /dev/null
check "plan:<계획서> 키 decision(자동 리뷰 대체 요청)은 html 이 없어도 계획서 done → expired" '[ "$(A request show "$PLANKEY" | field request.state)" = expired ]'
check "유지된 answered 질문은 사람이 cancel 로 거둘 수 있다" '[ "$(A request cancel "$P" --reason 받을-pane-없음 | field request.state)" = cancelled ]'
MISSING="$(A request open --kind question --title 없는계획서 --plan plans/task/없음.md | field request.id)"
A request list > /dev/null
check "계획서가 없어도 답 기다리는 질문은 열린 채" '[ "$(A request show "$MISSING" | field request.state)" = open ]'
printf '# 일\n\n## Checkpoint\n- Status: in_progress\n' > plans/task/20261021-abs.md
ABS="$(A request open --kind question --title 절대경로 --plan "$B/plans/task/20261021-abs.md" | field request.id)"
check "절대 경로 --plan 은 본체 기준 논리 경로로 저장된다" '[ "$(A request show "$ABS" | field request.links.plan)" = plans/task/20261021-abs.md ]'
A request answer "$ABS" --by app --choice x > /dev/null
A request list > /dev/null
check "논리 경로라 계획서를 찾는다(진행 중이면 answered 그대로)" '[ "$(A request show "$ABS" | field request.state)" = answered ]'
BIG="$WORK/big"; mkdir -p "$BIG"
for n in $(seq 1 60); do A request open --kind question --title "채우기 $n $(printf 'x%.0s' $(seq 1 2000))" > /dev/null; done
node scripts/athena.mjs request list --all --json 2>/dev/null | wc -c | tr -d ' ' > "$BIG/pipe"
node scripts/athena.mjs request list --all --json > "$BIG/file" 2>/dev/null
check "--json 출력이 파이프로도 끝까지 나온다(64KB 넘는 목록)" '[ "$(wc -c < "$BIG/file" | tr -d " ")" -gt 70000 ] && [ "$(cat "$BIG/pipe")" = "$(wc -c < "$BIG/file" | tr -d " ")" ]' "파이프 $(cat "$BIG/pipe") · 파일 $(wc -c < "$BIG/file")"

section "결정 콘솔(plan-html.mjs)"
mkdir -p plans/feature
printf '# 기능\n\n## Checkpoint\n- Status: planned\n' > plans/feature/20261021-y.md
printf '{"title":"기능 Y","type":"feature","scope":"-","summary":"-","decisions":[{"id":"D1","title":"하나","type":"single","required":true,"options":[{"label":"가"},{"label":"나"}]},{"id":"D2","title":"둘","type":"single","required":true,"options":[{"label":"다"}]}]}' > "$WORK/plan.json"
node scripts/plan-html.mjs plans/feature/20261021-y.md --data "$WORK/plan.json" --pane p9 > /dev/null 2>&1
R="$(A request list)"
check "안 정한 결정 → decision 요청(키 plan:<경로> · html · pane)" 'echo "$R" | python3 -c "import json,sys; r=[x for x in json.load(sys.stdin)[\"requests\"] if x[\"dedupeKey\"]==\"plan:plans/feature/20261021-y.md\"]; sys.exit(0 if len(r)==1 and r[0][\"kind\"]==\"decision\" and r[0][\"links\"][\"html\"]==\"plans/feature/20261021-y.html\" and r[0][\"pane\"]==\"p9\" else 1)"' "$R"
node scripts/plan-html.mjs plans/feature/20261021-y.md --decide D1='가' > /dev/null 2>&1
check "하나만 정하면 열린 채" 'A request list | grep -q "plan:plans/feature/20261021-y.md"'
node scripts/plan-html.mjs plans/feature/20261021-y.md --decide D2='다' > /dev/null 2>&1
check "다 정하면 delivered(답 기록)" 'A request list --all | python3 -c "import json,sys; r=[x for x in json.load(sys.stdin)[\"requests\"] if x[\"dedupeKey\"]==\"plan:plans/feature/20261021-y.md\"]; sys.exit(0 if r and r[-1][\"state\"]==\"delivered\" and \"D1=가\" in r[-1][\"answer\"][\"choice\"] else 1)"'

section "결정 콘솔 [이대로 진행] → 현황판이 답을 적는다"
printf '# 기능 Z\n\n## Checkpoint\n- Status: planned\n' > plans/feature/20261021-z.md
node scripts/plan-html.mjs plans/feature/20261021-z.md --data "$WORK/plan.json" --pane p9 > /dev/null 2>&1
bash scripts/board.sh >/dev/null 2>&1
TOKEN="$(A pack board-token | field token)"
HDR=(-H "Origin: http://localhost:47730" -H "x-board-token: $TOKEN" -H "content-type: application/json")
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${HDR[@]}" -d '{"pane":"p-없음","plan":"plans/feature/20261021-z.md","text":"[작업계획서 결정사항 확정] 기능 Z"}' http://127.0.0.1:47730/api/action)"
R="$(A request list)"
check "pane 이 없어 보내지는 못해도(400) 답은 적힘(answered · by board)" '[ "$CODE" = 400 ] && echo "$R" | python3 -c "import json,sys; r=[x for x in json.load(sys.stdin)[\"requests\"] if x[\"dedupeKey\"]==\"plan:plans/feature/20261021-z.md\"]; sys.exit(0 if r and r[0][\"state\"]==\"answered\" and r[0][\"answer\"][\"by\"]==\"board\" else 1)"' "$CODE $R"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${HDR[@]}" -d '{"pane":"p-없음","plan":"../etc/x.md","text":"x"}' http://127.0.0.1:47730/api/action)"
check "plans/ 밖 경로는 요청을 건드리지 않는다" '[ "$CODE" = 400 ]'
node scripts/plan-html.mjs plans/feature/20261021-z.md --decide D1='가' D2='다' > /dev/null 2>&1
check "확정하면 delivered(콘솔 답은 그대로)" 'A request list --all | python3 -c "import json,sys; r=[x for x in json.load(sys.stdin)[\"requests\"] if x[\"dedupeKey\"]==\"plan:plans/feature/20261021-z.md\"]; sys.exit(0 if r and r[-1][\"state\"]==\"delivered\" and r[-1][\"answer\"][\"by\"]==\"board\" else 1)"'

section "사건 기록(docs/events.md)"
EV="$(cd .pack-data/state && pwd -P)/events.jsonl"
states() { python3 -c 'import json,sys
print(" ".join(e["state"] for e in map(json.loads, open(sys.argv[1])) if e["type"]=="request" and e["id"]==sys.argv[2]))' "$EV" "$1"; }
check "팩 데이터 state/events.jsonl 에 남는다" '[ -s "$EV" ]'
check "요청 흐름이 그대로(열기 · 고쳐 열기 · 답 · 받음 — ack 두 번째는 안 남음)" '[ "$(states "$ID")" = "open open answered delivered" ]' "$(states "$ID")"
check "대화로 답 → delivered 한 줄(by chat)" '[ "$(states "$Q")" = "open delivered" ] && grep "\"id\":\"$Q\"" "$EV" | tail -1 | grep -q "\"by\":\"chat\""'
check "취소(답 온 질문 취소 포함)도 남는다" '[ "$(states "$C")" = "open cancelled" ] && [ "$(states "$P")" = "open answered cancelled" ]'
check "줄마다 형식 · 시각 · 팩" 'python3 -c "import json,sys; es=[json.loads(l) for l in open(sys.argv[1])]; sys.exit(0 if all(e[\"v\"]==1 and e[\"at\"] and e[\"pack\"]==\"acme\" for e in es) else 1)" "$EV"'
node scripts/lib/events.mjs verify repo=r1 ok=false strict=true failed='lint|test'
check "셸에서 남기기 — 참거짓은 참거짓으로" 'tail -1 "$EV" | python3 -c "import json,sys; e=json.load(sys.stdin); sys.exit(0 if e[\"type\"]==\"verify\" and e[\"ok\"] is False and e[\"strict\"] is True and e[\"failed\"]==\"lint|test\" else 1)"' "$(tail -1 "$EV")"
M="$(curl -s 'http://127.0.0.1:47730/api/metrics?days=7')"
check "현황판 /api/metrics — 요청 사건을 세고 계획서에 제목을 붙인다" 'echo "$M" | python3 -c "import json,sys; m=json.load(sys.stdin); p=[x for x in m[\"plans\"] if x[\"plan\"]==\"plans/task/20261021-x.md\"]; sys.exit(0 if m[\"events\"]>0 and m[\"current\"][\"asks\"]>=5 and p and p[0][\"title\"]==\"일\" and p[0][\"exists\"] else 1)"' "$M"
check "현황판 /api/state — 주 본체라 [정비] 탭을 보인다(maintenance)" '[ "$(curl -s http://127.0.0.1:47730/api/state | field maintenance)" = True ]'
check "scripts/metrics.mjs — 요약을 찍는다" 'node scripts/metrics.mjs | grep -q "작업당 질문" && [ "$(node scripts/metrics.mjs --all --json | field days)" = "" ]'
# 위에서 띄운 현황판도 훑을 때마다 같은 일을 한다 — 끄고 본 기록을 지운 뒤 처음부터
pkill -f "$WORK/body/scripts/board/server.mjs" 2>/dev/null; sleep 1
rm -f .pack-data/state/plan-status.json
BEFORE="$(wc -l < "$EV")"
observe() { node --input-type=module -e "import { observePlanStatus } from './scripts/lib/events.mjs'; observePlanStatus(process.cwd(), JSON.parse(process.argv[1]))" "$1"; }
observe '[{"id":"plans/task/a.md","grade":"light","status":"planned"}]'
check "계획서 상태 — 처음 볼 때는 적어 두기만" '[ "$(wc -l < "$EV")" = "$BEFORE" ] && [ -f .pack-data/state/plan-status.json ]'
observe '[{"id":"plans/task/a.md","grade":"light","status":"in_progress"},{"id":"plans/task/b.md","grade":"light","status":"planned"}]'
observe '[{"id":"plans/task/a.md","grade":"light","status":"in_progress"},{"id":"plans/task/b.md","grade":"light","status":"planned"}]'
check "바뀐 것 · 새로 생긴 것만 한 번씩(같으면 안 남김)" 'python3 -c "import json,sys; es=[json.loads(l) for l in open(sys.argv[1])][int(sys.argv[2]):]; sys.exit(0 if [(e[\"plan\"],e[\"from\"],e[\"to\"]) for e in es]==[(\"plans/task/a.md\",\"planned\",\"in_progress\"),(\"plans/task/b.md\",None,\"planned\")] else 1)" "$EV" "$BEFORE"' "$(tail -2 "$EV")"

section "에이전트 고르기 질문(scripts/hooks/ask-to-request.py)"
ASK_EVENT='{"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"어느 방식으로 할까요?","header":"방식","multiSelect":true,"options":[{"label":"A 안 (Recommended)","description":"작게 고친다","preview":"diff A"},{"label":"B 안","description":"크게 고친다"}]},{"question":"브랜치는?","header":"브랜치","multiSelect":false,"options":[{"label":"main","description":"기준"},{"label":"dev","description":"개발"}]}]}}'
BEFORE_ASK="$(ls "$DIR" | wc -l)"
ATHENA_AGENT= python3 scripts/hooks/ask-to-request.py <<< "$ASK_EVENT" > "$WORK/ask-athena.out"
check "아테나 세션(ATHENA_AGENT 없음)은 그대로 — 요청도 안 열고 막지도 않는다" '[ ! -s "$WORK/ask-athena.out" ] && [ "$(ls "$DIR" | wc -l)" = "$BEFORE_ASK" ]'
ATHENA_AGENT=athena-studio-fe ATHENA_PLAN=plans/task/20261021-x.md python3 scripts/hooks/ask-to-request.py <<< "$ASK_EVENT" > "$WORK/ask-agent.out"
check "에이전트 세션 — 질문마다 요청이 열린다(2개)" '[ "$(( $(ls "$DIR" | wc -l) - BEFORE_ASK ))" = 2 ]'
check "도구는 막고 요청 번호를 안내한다(deny)" 'python3 -c "import json,sys; o=json.load(open(sys.argv[1]))[\"hookSpecificOutput\"]; sys.exit(0 if o[\"permissionDecision\"]==\"deny\" and o[\"permissionDecisionReason\"].count(\"r-20\")==2 and \"ack\" in o[\"permissionDecisionReason\"] else 1)" "$WORK/ask-agent.out"' "$(cat "$WORK/ask-agent.out")"
AQ="$(python3 -c 'import json,sys,re; print(re.findall(r"r-\d{8}-\d{6}-\w{4}", json.load(open(sys.argv[1]))["hookSpecificOutput"]["permissionDecisionReason"])[0])' "$WORK/ask-agent.out")"
check "질문 · 선택지(설명 · 추천 표시 · 미리보기) · 계획서가 요청에 담긴다" 'A request show "$AQ" | python3 -c "import json,sys; r=json.load(sys.stdin)[\"request\"]; o=r[\"options\"]; sys.exit(0 if r[\"kind\"]==\"question\" and r[\"state\"]==\"open\" and r[\"title\"]==\"어느 방식으로 할까요?\" and [x[\"label\"] for x in o]==[\"A 안\",\"B 안\"] and o[0].get(\"recommended\") and o[0][\"desc\"]==\"작게 고친다\" and \"diff A\" in r[\"body\"] and \"여러 개\" in r[\"body\"] and r[\"links\"][\"plan\"]==\"plans/task/20261021-x.md\" else 1)"'
check "[작업] 팝업 답 경로 그대로 — 고르면 answered, 받으면 ack → delivered" '[ "$(A request answer "$AQ" --by app --choice "A 안" --text "B 도 같이" | field request.state)" = answered ] && [ "$(A request ack "$AQ" | field request.state)" = delivered ]'
# 이어 보낸 pane — pane 기록의 계획서가 환경 ATHENA_PLAN(옛 계획서)보다 먼저
printf '# 새\n\n## Checkpoint\n- Status: in_progress\n' > plans/task/20261021-new.md
mkdir -p .pack-data/state/pane-sessions
printf '{"plan":"plans/task/20261021-new.md"}\n' > .pack-data/state/pane-sessions/pt1.json
ATHENA_AGENT=athena-studio-fe ATHENA_PLAN=plans/task/20261021-x.md python3 -c "
import sys; sys.path.insert(0,'scripts/hooks'); import importlib.util
spec=importlib.util.spec_from_file_location('hook','scripts/hooks/ask-to-request.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.plan_of('pt1'), m.plan_of('pnone'))" > "$WORK/plan-of.out"
check "계획서는 pane 기록이 먼저, 기록이 없으면 환경 ATHENA_PLAN" '[ "$(cat "$WORK/plan-of.out")" = "plans/task/20261021-new.md plans/task/20261021-x.md" ]' "$(cat "$WORK/plan-of.out")"
check "deny 안내 — 닫힌 요청은 다시 열라고 알린다(영원히 기다리지 않게)" 'grep -q "expired" "$WORK/ask-agent.out"'
# 요청을 못 열면(여기서는 bin/athena 를 가짜로 바꿔) 흔적이 남고 에이전트에게 알린다
mv bin/athena bin/athena.real; printf '#!/bin/sh\necho nope >&2; exit 1\n' > bin/athena; chmod +x bin/athena
ATHENA_AGENT=athena-studio-fe python3 scripts/hooks/ask-to-request.py <<< "$ASK_EVENT" > "$WORK/ask-fail.out"
mv bin/athena.real bin/athena
check "요청을 못 열면 막지 않고 알린다 + events.jsonl 에 request-hook-failed" 'grep -q additionalContext "$WORK/ask-fail.out" && ! grep -q permissionDecision "$WORK/ask-fail.out" && grep request-hook-failed "$EV" | tail -1 | grep -q "pack.:.acme"' "$(cat "$WORK/ask-fail.out")"
ATHENA_AGENT=athena-studio-fe python3 scripts/hooks/ask-to-request.py <<< '{"tool_input":{"questions":[]}}' > "$WORK/ask-empty.out"
check "질문이 없으면 건드리지 않는다" '[ ! -s "$WORK/ask-empty.out" ]'

section "사용법 · 약속"
node scripts/athena.mjs request open --title x --json > /dev/null 2>&1; check "종류 없으면 사용법 오류(2)" '[ $? -eq 2 ]'
node scripts/athena.mjs request ack nope --json > /dev/null 2>&1; check "번호 모양이 아니면 사용법 오류(2)" '[ $? -eq 2 ]'
check "없는 요청 → not-found" '[ "$(A request ack r-20200101-000000-abcd | field error)" = not-found ]'
check "답 없이 answer → 사용법 오류" '! node scripts/athena.mjs request answer "$Q" --by board --json > /dev/null 2>&1'
check "--contract 1 → contract-mismatch" '[ "$(A request list --contract 1 | field error)" = contract-mismatch ]'

printf '\n통과 %s · 실패 %s\n' "$PASS" "$FAIL"
[ "${KEEP:-}" = 1 ] && echo "남김: $WORK"
[ "$FAIL" -eq 0 ]
