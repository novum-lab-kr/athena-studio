#!/usr/bin/env bash
# PR 자동 리뷰 시험 — delegate.sh 지시문의 올리는 방식(끝나면 저절로 · --reuse-pane)
. "$(dirname "$0")/_pr-auto-lib.sh"   # 공통 준비 — test/_pr-auto-lib.sh (이 경로 글을 보고 검증 범위가 헬퍼를 따라간다)
# 끝나면 저절로 흐름 지시문(delegate.sh) — PR 끔이면 ship.sh --direct-merge 로, 그냥 켬이면 PR 흐름으로, 키 없음이면 없음
echo; echo "끝나면 저절로 지시문 (delegate.sh)"
ICORE="$(cd "$TMP" && pwd -P)/core-instr"; mkdir -p "$ICORE/plans/task" "$ICORE/.claude/agents" && cp -R scripts "$ICORE/scripts"
cp "$SRC/test/fixtures/lead-screen.py" "$ICORE/scripts/lib/screen.py"   # 사용자 pane 환경 대신 격리한 발신자
printf '#!/bin/sh\ncase "$1" in inside) exit 1 ;; name) echo 가짜화면 ;; esac\nexit 0\n' > "$ICORE/scripts/screen"; chmod +x "$ICORE/scripts/screen"
printf '{"main":"claude"}\n' > "$ICORE/.athena-main-tool.json"
# 위임 도구 판정(dispatch-engine.mjs)이 claude auth status 를 부른다 — 로그인된 claude 가 없는 러너(Actions)에서도 같게 가짜로
IBIN="$TMP/instr-bin"; mkdir -p "$IBIN"; printf '#!/bin/sh\n[ "$1 $2" = "auth status" ] && exit 0\nexit 1\n' > "$IBIN/claude"; chmod +x "$IBIN/claude"
printf -- '---\nname: web-fe\ndescription: 웹\n---\n본문\n' > "$ICORE/.claude/agents/web-fe.md"
printf '# 시험\n\n## Checkpoint\n- Status: in_progress\n' > "$ICORE/plans/task/20261030-a.md"
instr() { printf '{ "repos": [{ "name": "web", "agents": ["web-fe"], "prBase": "dev"%s }] }\n' "$1" > "$ICORE/athena.config.json"; (cd "$ICORE" && env -u ATHENA_AGENT PATH="$IBIN:$PATH" bash scripts/delegate.sh web-fe --plan plans/task/20261030-a.md 2>&1); }
INSTR_OUT="$(instr ', "autoMerge": true, "autoPr": false')"
printf '%s' "$INSTR_OUT" | grep -q "ship.sh --plan $ICORE/plans/task/20261030-a.md --dir <워크트리> --direct-merge" \
  && printf '%s' "$INSTR_OUT" | grep -q "자동 PR 을 껐다" && ! printf '%s' "$INSTR_OUT" | grep -q "끝나면 PR 을 올린다" \
  && echo "  ✔ PR 끔 → 끝나면 ship.sh --direct-merge (PR 흐름 지시 아님)" || { echo "  ✖ PR 끔 지시문"; printf '%s\n' "$INSTR_OUT" | grep -o "이 레포(web).\{0,250\}" | head -3; FAIL=1; }
INSTR_OUT="$(instr ', "autoMerge": true')"
printf '%s' "$INSTR_OUT" | grep -q "끝나면 PR 을 올린다" && ! printf '%s' "$INSTR_OUT" | grep -q -- "--direct-merge" \
  && echo "  ✔ 자동 PR 켬 → 지금처럼 PR 흐름" || { echo "  ✖ 켬 지시문"; FAIL=1; }
# 경량 계획서(plans/task/)도 넓은 수정이면 묻지 않고 리뷰(H8 · 2026-11-26) — "리뷰할까요?" 를 묻는 옛 지시가 없어야 한다
printf '%s' "$INSTR_OUT" | grep -q "pr-auto.mjs --wide --plan plans/task/20261030-a.md --dir <워크트리> 로 넓은 수정인지 본다" && printf '%s' "$INSTR_OUT" | grep -q "'넓은 수정: 예' 면 묻지 않고 바로 리뷰를 띄우고" && printf '%s' "$INSTR_OUT" | grep -q "로직이 하나라도 바뀌었으면 no 를 적지 않고, no 를 적었으면 끝 요약에 그 이유를 한 줄" && ! printf '%s' "$INSTR_OUT" | grep -q "리뷰할까요" \
  && echo "  ✔ 경량 계획서도 --wide 판정이 예면 자동 리뷰 지시" || { echo "  ✖ 경량 리뷰 지시문"; printf '%s\n' "$INSTR_OUT" | grep -o "넓은 수정인지.\{0,160\}" | head -2; FAIL=1; }
# autoMerge 키가 없으면 저절로 흐름 지시가 없다 — autoPr:false 만 있어도 같다(바로 머지 안 함)
LOOSE=""
for piece in '' ', "autoPr": false'; do
  instr "$piece" | grep -q "끝나면 PR 을 올린다\|자동 PR 을 껐다" && LOOSE="$LOOSE [$piece]"
done
expect "autoMerge 키 없음(autoPr:false 만 있어도) → 저절로 흐름 지시 없음" '[ -z "$LOOSE" ]' "지시가 실린 설정:$LOOSE"

# 이어 보내기(--reuse-pane) — 처음 받은 지시가 아니라 지금 설정 기준 올리는 방식이 전송문에 실린다 · 디스패치 결과에 올리는 방식 한 줄
echo; echo "이어 보내기·디스패치 결과의 올리는 방식 (delegate.sh --reuse-pane)"
mkdir -p "$ICORE/.reuse-data/state/pane-sessions" "$TMP/reuse-wd" && ln -sfn "$ICORE/.reuse-data" "$ICORE/.pack-data"
printf '{ "pane": "p5", "agent": "web-fe", "plan": "plans/task/old.md" }\n' > "$ICORE/.reuse-data/state/pane-sessions/p5.json"
printf 'console.log(JSON.stringify({ pane: "p5", cwd: process.env.REUSE_CWD }))\n' > "$ICORE/scripts/reuse-pane.mjs"
# 화면 안인 척하는 가짜 화면 — 새 pane 은 p9, 보낸 글(send-text)은 로그에
cat > "$ICORE/scripts/screen" <<SH
#!/bin/sh
case "\$1" in
  inside) exit 0 ;;
  name) echo 가짜화면 ;;
  self) exit 0 ;;
  pane)
    case "\$2" in
      split) echo '{"pane":{"id":"p9"}}' ;;
      send-text) printf '%s\\n' "\$4" >> "$TMP/reuse-sent.log" ;;
    esac ;;
esac
exit 0
SH
chmod +x "$ICORE/scripts/screen"
reuse() {   # 설정 조각 → 이어 보내기 결과(전송문은 $TMP/reuse-sent.log)
  mkdir -p "$ICORE/pack"   # 여러 팩 구조(.pack-data) — 레포 설정은 팩 pack.json 에서 읽는다
  printf '{ "repos": [{ "name": "web", "agents": ["web-fe"], "prBase": "dev"%s }] }\n' "$1" > "$ICORE/pack/pack.json"
  : > "$TMP/reuse-sent.log"
  (cd "$ICORE" && env -u ATHENA_AGENT PATH="$IBIN:$PATH" REUSE_CWD="$(cd "$TMP/reuse-wd" && pwd -P)" bash scripts/delegate.sh web-fe --plan plans/task/20261030-a.md --reuse-pane p5 2>&1)
}
REUSE_OUT="$(reuse ', "autoMerge": true, "autoPr": false')"; REUSE_SENT="$(cat "$TMP/reuse-sent.log")"
printf '%s' "$REUSE_SENT" | grep -q -- "--direct-merge" && printf '%s' "$REUSE_SENT" | grep -q "지금 설정 기준" && ! printf '%s' "$REUSE_SENT" | grep -q "끝나면 PR 을 올린다" \
  && printf '%s' "$REUSE_OUT" | tail -3 | grep -q "올리는 방식: 바로 머지(PR 끔" \
  && echo "  ✔ 이어 보내기(PR 끔) — 전송문에 최신 규칙(ship.sh --direct-merge) · 디스패치 결과에 올리는 방식 한 줄(바로 머지)" || { echo "  ✖ 이어 보내기 PR 끔 전송문 · 결과 줄"; printf '%s\n' "$REUSE_OUT" | tail -5; FAIL=1; }
REUSE_OUT="$(reuse ', "autoMerge": true')"; REUSE_SENT="$(cat "$TMP/reuse-sent.log")"
printf '%s' "$REUSE_SENT" | grep -q "끝나면 PR 을 올린다" && ! printf '%s' "$REUSE_SENT" | grep -q -- "--direct-merge" && printf '%s' "$REUSE_OUT" | tail -3 | grep -q "올리는 방식: 끝나면 저절로 draft PR" \
  && echo "  ✔ 설정이 바뀌면(PR 켬) 이어 보내기 전송문 · 결과 줄도 바뀐다" || { echo "  ✖ 이어 보내기 PR 켬"; FAIL=1; }
REUSE_OUT="$(reuse ', "autoMerge": true, "autoPr": false, "autoMergeConfirm": false, "actionsHandoff": true')"; REUSE_SENT="$(cat "$TMP/reuse-sent.log")"
printf '%s' "$REUSE_SENT" | grep -q "Actions 로 넘긴다" && printf '%s' "$REUSE_SENT" | grep -q "결과를 기다리지 말고" && printf '%s' "$REUSE_SENT" | grep -q "리뷰와 화면 확인을 먼저" && printf '%s' "$REUSE_OUT" | tail -3 | grep -q "올리는 방식: Actions 로 넘기기" \
  && echo "  ✔ Actions 로 넘기는 레포 — 넘긴 뒤 기다리지 않는다는 규칙 · 결과 줄" || { echo "  ✖ 이어 보내기 Actions 넘기기"; printf '%s\n' "$REUSE_OUT" | tail -4; FAIL=1; }
REUSE_OUT="$(reuse '')"; REUSE_SENT="$(cat "$TMP/reuse-sent.log")"
printf '%s' "$REUSE_OUT" | tail -3 | grep -q "올리는 방식: 사용자가 'PR 올려줘' 라고 할 때만" && ! printf '%s' "$REUSE_SENT" | grep -q "끝나면 PR 을 올린다\|자동 PR 을 껐다" \
  && echo "  ✔ 켜지 않은 레포 — 결과 줄은 사용자가 말할 때만 · 전송문에 저절로 규칙 없음" || { echo "  ✖ 이어 보내기 기본"; FAIL=1; }
# 새 pane(프롬프트 없이 열기) 쪽도 결과에 같은 줄
printf '{ "repos": [{ "name": "web", "agents": ["web-fe"], "prBase": "dev", "autoMerge": true, "autoPr": false }] }\n' > "$ICORE/pack/pack.json"
mkdir -p "$ICORE/.claude" && cp "$SRC/.claude/settings.json" "$ICORE/.claude/settings.json" 2>/dev/null || echo '{}' > "$ICORE/.claude/settings.json"
INSTR_OUT="$(cd "$ICORE" && env -u ATHENA_AGENT PATH="$IBIN:$PATH" bash scripts/delegate.sh web-fe --plan plans/task/20261030-a.md --here 2>&1)"
printf '%s' "$INSTR_OUT" | tail -3 | grep -q "올리는 방식: 바로 머지(PR 끔" \
  && echo "  ✔ 새 pane 결과에도 올리는 방식 한 줄" || { echo "  ✖ 새 pane 결과 줄"; printf '%s\n' "$INSTR_OUT" | tail -3; FAIL=1; }
# --beside — 화면 pane 밖(현황판의 pr-auto)에서도 그 pane 이 있으면 그 옆에 쪼갠다 · 없으면 지금처럼 "밖입니다"(2026-11-12 PR #293)
cat > "$ICORE/scripts/screen" <<SH
#!/bin/sh
echo "screen \$*" >> "$TMP/beside-screen.log"
case "\$1" in
  inside) exit 1 ;;
  name) echo 가짜화면 ;;
  pane)
    case "\$2" in
      get) [ "\$3" = p91 ] && echo '{"pane":{"id":"p91"}}' && exit 0; exit 1 ;;
      split) echo '{"pane":{"id":"p9"}}' ;;
    esac ;;
esac
exit 0
SH
: > "$TMP/beside-screen.log"
BESIDE_OUT="$(cd "$ICORE" && env -u ATHENA_AGENT PATH="$IBIN:$PATH" bash scripts/delegate.sh web-fe --plan plans/task/20261030-a.md --beside p91 2>&1)"
grep -q '^screen pane split --target p91 ' "$TMP/beside-screen.log" && ! printf '%s' "$BESIDE_OUT" | grep -q '밖입니다' \
  && echo "  ✔ --beside p91 — pane 밖에서도 그 pane 옆에 쪼갰다" || { echo "  ✖ --beside 띄우기"; printf '%s\n' "$BESIDE_OUT" | tail -3; cat "$TMP/beside-screen.log"; FAIL=1; }
: > "$TMP/beside-screen.log"
BESIDE_OUT="$(cd "$ICORE" && env -u ATHENA_AGENT PATH="$IBIN:$PATH" bash scripts/delegate.sh web-fe --plan plans/task/20261030-a.md --beside p77 2>&1)"
BAD_ID_OUT="$(cd "$ICORE" && env -u ATHENA_AGENT PATH="$IBIN:$PATH" bash scripts/delegate.sh web-fe --plan plans/task/20261030-a.md --beside 'p1;x' 2>&1)"
printf '%s' "$BESIDE_OUT" | grep -q '가짜화면 밖입니다' && ! grep -q 'pane split' "$TMP/beside-screen.log" && printf '%s' "$BAD_ID_OUT" | grep -q 'pane id 가 이상하다' \
  && echo "  ✔ --beside 의 pane 이 없으면 띄우지 않고 '밖입니다' · 이상한 pane id 는 거른다" || { echo "  ✖ 없는 pane · 이상한 id --beside"; printf '%s\n' "$BESIDE_OUT" "$BAD_ID_OUT" | tail -4; FAIL=1; }


[ $FAIL = 0 ] && echo "✅ 통과" || echo "❌ 실패"
exit $FAIL
