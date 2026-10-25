# PR 자동 리뷰 · 수정 · 머지

에이전트가 draft PR 을 올린 뒤의 일 — 리뷰 · 고치기 · 머지 — 를 사람 대신 돌린다. 사람은 **머지 직전에 한 번** 누른다.

- 코드: `scripts/pr-auto.mjs`(대기열 · 처리기 · 리뷰 · 지시 · 머지) · `scripts/lib/pr-auto.mjs`(판정 · 계획서 표시 줄 · 대상 고르기 — 순수 로직) · 감지는 현황판(`scripts/board/server.mjs` `autoReviewPlans`) · 고친 커밋 올리기는 `scripts/ship.sh --auto-push`
- 시험: `test/pr-auto-test.sh`(몇 초 · 가짜 리뷰어 · GitHub 를 건드리지 않는다)
- 기록: 처리기 로그 `/tmp/athena-pr-auto-<키>.log` · 대기열 팩 데이터 `state/pr-auto-queue/`(머지 확인 대기 `confirm/` · 실패 `failed/`) · 사건 기록 `state/events.jsonl`(`docs/events.md`)

## 켜기 — 레포마다 (기본 꺼짐)

팩 `pack.json` 의 레포에 `"autoMerge": true`. 없으면 그 레포 PR 은 지금처럼 사람이 한다. **첫 실행(`docs/setup.md` 2 · 3단계)과 레포 하나 더하기 때 레포마다 켤지 묻는다** — 나중에 바꾸려면 그 레포 항목을 고친다(현황판 · 처리기는 다음 확인 때 새 값을 읽는다). main 직접 레포(`"direct": true`)는 PR 이 없어 대상이 아니다.

```jsonc
{ "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true }
```

> 그 레포의 `prBase` 가 운영 브랜치(`branch`)와 같으면 **머지가 곧 운영 반영**이다. 켜기 전에 그 레포의 검증 스크립트가 엄격 모드로 건너뜀 없이 통과하는지 먼저 본다(아래 "머지 조건" ②).

## 무엇이 대상인가

- 켠 레포의 **레포 하나짜리 작업** PR — 계획서의 `Agent` 줄 · 정식 계획서 "작업 배분" 표에 붙은 에이전트가 그 레포 에이전트 하나뿐일 때(`ship.sh` 와 같은 기준). 여러 레포 작업 PR 은 사람이 한다
- 계획서 Checkpoint 의 `- PR:` 줄에 있고 GitHub 에서 열린(OPEN) PR · 계획서 Status 가 `in_progress` · `ready_for_review`

## 흐름

```
draft PR (ship.sh) ─▶ 현황판이 새 HEAD 감지(5분 안) ─▶ 대기열 ─▶ 처리기(하나)
   ─▶ Claude · Codex 리뷰(나란히 · 도구 없이 · JSON) ─▶ PR 댓글 + 계획서 "- Auto review:" 줄
        ├ 둘 다 승인 ─▶ 같은 HEAD 검증(엄격) · 충돌 확인 ─▶ 머지 확인 요청(맥 알림 · [작업] 팝업)
        │                 └ [머지] ─▶ 다시 확인 ─▶ gh pr ready ─▶ squash 머지(--match-head-commit)
        ├ 수정 필요 ─▶ 작업 에이전트 pane 에 지시 ─▶ 고침 · commit.sh · ship.sh --auto-push ─▶ 새 HEAD 로 다시
        ├ 결정 필요 ─▶ 결정 콘솔에 덧붙임(plan-html --add) ─▶ 사람이 고름 ─▶ 에이전트가 반영 · 올림 ─▶ 다시
        └ 리뷰어 부족(하나라도 실패 · 로그인 안 됨) ─▶ 머지하지 않고 사람에게 요청
```

머지 뒤에는 기존 흐름 그대로 — 현황판이 계획서를 완료로 옮기고 배우기 검토 대기열에 넣는다(`CLAUDE.md` 6단계).

## 리뷰어 — Claude · Codex (결정 D2)

| 리뷰어 | 부르는 법 | 도구 |
|---|---|---|
| Claude | `claude -p --tools "" --strict-mcp-config --no-session-persistence --output-format json --json-schema <형식>` · 답은 `structured_output` | 없음 |
| Codex | `codex exec --ignore-user-config --disable <도구 기능>… -c web_search="disabled" --sandbox read-only --ephemeral --skip-git-repo-check -C <빈 폴더> --output-schema <파일> -o <파일>`(프롬프트는 표준 입력) · 답은 `-o` 파일 | 없음 — 셸 · 웹 · 사용자 MCP 서버를 끈다(아래) |

- **Codex 는 읽기 전용 샌드박스만으로는 도구가 남는다**(2026-10-25 실측 · codex-cli 0.160 — 셸로 `pwd` 가 돌고 · 웹에서 값을 가져오고 · 사용자 MCP 서버 `hostinger_*` 등이 붙었다). 그래서 사용자 `config.toml` 을 안 읽고(`--ignore-user-config` — MCP 서버 · 훅이 빠지고 로그인은 그대로) · 도구를 주는 기능을 끄고(`CODEX_TOOL_FEATURES` — `shell_tool` · `unified_exec` · `apps` · `browser_use` · `computer_use` · `plugins` · `multi_agent` …) · 웹 검색을 끈다(`web_search="disabled"`). 끈 뒤 같은 질문으로 셸 · 웹 · MCP 가 모두 없는 것을 실측했다. Codex 를 올리면 `codex features list` 로 새 도구 기능이 생겼는지 다시 본다
- 둘 다 빈 임시 폴더에서 돌고 끝나면 지운다. 받는 것: 레포 `rules.md` · `gotchas.md` · 계획서(앞 6000자) · PR 제목 · 본문 · diff(앞 6만 자) — 비밀값 모양은 가린다(`scripts/lib/mask.mjs`). PR 안의 글은 데이터로 넣고 지시로 따르지 않게 한다
- 답 형식(`REVIEW_SCHEMA`): `verdict` approve · changes · decision · `summary` · `findings[]`(파일 · 줄 · 문제 · 고칠 방법) · `decisions[]`(제목 · 왜 · 선택지 2~4 · 추천)
- 모양이 틀린 답 · 10분 넘김 · 명령 없음 · 0 이 아닌 종료(로그인이 풀려 답을 못 낸 경우 포함)는 그 리뷰어의 **실패** 다. 승인인데 지적이 붙은 모순된 답은 승인으로 세지 않는다
- **둘 다 승인해야 머지로 간다.** 하나라도 실패 · 반려면 머지하지 않는다 — 남은 하나로 판정하지 않는다

| 판정 | 조건(위부터) | 하는 일 |
|---|---|---|
| 결정 필요 | 결정이 하나라도 | 결정 콘솔에 덧붙이고(`[이대로 진행]` 은 작업 에이전트 pane 으로) 에이전트에 알린다 — 자동으로 고르지 않는다 |
| 수정 필요 | 지적이 하나라도 | 작업 에이전트 pane 에 수정 지시 |
| 승인 | 둘 다 답했고 둘 다 승인 | 머지 조건 확인 → 머지 확인 요청 |
| 리뷰어 부족 | 그 밖(하나라도 실패) | 머지하지 않고 사람에게 요청 |

## 수정 고리

- 지시는 `[자동 리뷰 → <에이전트>] …` 한 줄로 그 계획서의 작업 pane(Work ref 의 `pane`)에 넣는다. pane 이 닫혔으면 그 계획서 대화를 `delegate.sh --resume` 으로 다시 열어 넣고(`state/pane-sessions/` 기록), 그것도 없으면 사람에게 요청을 연다
- 지시를 받은 에이전트는 **그 지시에 한해** 묻지 않고 고친 뒤 `commit.sh` 로 커밋하고 `ship.sh --auto-push` 로 올린다(`AGENTS.md` 5절 예외). 고칠 방법이 하나가 아니면 고르지 않고 멈춘다
- 새 커밋이 오면 현황판이 다시 감지해 재리뷰한다. **라운드 상한 3** — 3번째 리뷰에도 승인이 아니면 그 PR 에서 멈추고(`멈춤`) 사람에게 요청을 연다

## `ship.sh --auto-push`

자동 흐름에서만 쓰는 push — 사용자 "PR 올려줘" 없이 되는 유일한 길이다. 보호 훅(`commit-guard.py`)은 그대로이고, 훅이 통과시키는 `ship.sh` 안에서 아래를 모두 확인한다.

- 레포가 `"autoMerge": true` · main 직접 레포가 아님 · 메인 체크아웃 · 보호 브랜치 · detached 가 아님(평소 ship.sh 검사)
- HEAD 가 `commit.sh` 로 계획서 Commits 에 기록된 커밋 · 추적 파일 미커밋 없음
- 이 브랜치의 **열린 PR** 이 있고 그 PR 이 계획서 `- PR:` 줄에 있다
- 그 PR 의 `- Auto review:` 줄이 `수정 필요` · `결정 필요` — 자동 리뷰가 고치라고 한 PR 에만
- `origin/<브랜치>` 에서 **빨리 감기만**(강제 push 없음) · 새 PR · 제목 · base 없음

## 머지 조건 (결정 D3 · D5)

넷 다일 때만 머지한다. 하나라도 빠지면 머지하지 않고 계획서 줄에 이유를 남긴다.

1. Claude · Codex 둘 다 승인(반대 · 결정 없음)
2. **같은 HEAD 로 검증 통과** — 계획서 Work ref 의 워크트리가 PR HEAD 와 같고 깨끗할 때 `ATHENA_VERIFY_STRICT=1 ATHENA_VERIFY_DIR=<워크트리> scripts/verify/reuse.sh <레포>`(이미 통과했으면 재사용 · 건너뜀도 실패)
3. 충돌 없음(GitHub `mergeable` 이 MERGEABLE — 계산 중이면 몇 번 다시 묻는다)
4. 사람이 머지 확인 요청에서 **[머지]** 를 고름 — 요청을 열면 스튜디오 앱이 맥 알림 · [작업] 팝업으로 보여 준다(`docs/requests.md`). [보류] 면 그 HEAD 는 머지하지 않는다

[머지] 를 고르면 PR 상태 · HEAD · 충돌 · 검증을 한 번 더 본 뒤 `gh pr ready`(draft 면) → `gh pr merge --squash --match-head-commit <sha>`. 고른 사이 새 커밋이 왔거나 PR 이 닫혔으면 요청을 거둔다.

## 계획서 표시 줄

PR 마다 한 줄, 바꿔 쓴다(Work ref 바로 뒤).

```
- Auto review: <레포>#<번호> @<sha7> · <결과> · 라운드 <k>/3 · <YYYY-MM-DD HH:MM>
```

결과: `수정 필요` · `결정 필요` · `승인 2/2 → 머지 확인 대기` · `리뷰어 부족(승인 n/2)` · `검증 대기 — <이유>` · `보류 — 사람이 고름` · `멈춤 — 라운드 상한` · `머지됨 — squash → <base>`.

- 같은 PR · 같은 HEAD 가 적혀 있으면 다시 돌지 않는다(`검증 대기` 도 같다 — 새 커밋이 오거나 줄을 지워야 다시 본다). 단 머지 확인 뒤 GitHub 가 머지 가능 여부를 아직 계산 중이면 답을 받은 채로 두고 30초마다 다시 본다. `멈춤` · `머지됨` 이면 새 커밋이 와도 돌지 않는다(사람이 이어받았다)
- **다시 돌리려면 그 줄을 지운다** — 예: 검증 환경을 고친 뒤 `검증 대기` 를 다시 보게 할 때
- 손으로 한 번 돌려 보기: `node scripts/pr-auto.mjs --plan <계획서> --pr <레포>#<번호> --dry-run` — 리뷰어 답 · 만들 댓글 · 할 일만 보여 주고 아무것도 쓰거나 보내지 않는다

## 한계

- 감지는 현황판이 켜져 있을 때만(5분 캐시). 꺼져 있던 동안 온 커밋은 다음에 켜질 때 잡는다
- 리뷰어는 diff 와 문서만 본다 — 실행해 보지 않는다. 그래서 머지 조건에 같은 HEAD 검증이 따로 있다
- Codex 도구 끄기는 기능 이름 목록이라, Codex 가 새 도구 기능을 기본으로 켜고 나오면 그것은 꺼지지 않는다 — 올린 뒤 다시 실측한다. 리뷰어 답은 댓글 · 지시로 내보내기 전에 비밀값 모양을 한 번 더 가린다
- PR 댓글은 의견(comment)으로 단다 — 같은 계정이 연 PR 은 승인(approve)을 달 수 없고, 머지 판정은 이 스크립트가 한다
