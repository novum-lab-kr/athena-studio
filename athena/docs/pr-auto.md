# PR 자동 리뷰 · 수정 · 머지

에이전트가 draft PR 을 올린 뒤의 일 — 리뷰 · 고치기 · 머지 — 를 사람 대신 돌린다. 사람은 **머지 직전에 한 번** 누른다(레포가 `"autoMergeConfirm": false` 면 그것도 없이 바로 — 아래 "켜기").

- 코드: `scripts/pr-auto.mjs`(대기열 · 처리기 · 리뷰 · 지시 · 머지) · `scripts/lib/pr-auto.mjs`(판정 · 계획서 표시 줄 · 대상 고르기 · 리뷰어 구성 · 앞 리뷰 이어받기 — 순수 로직) · 대기열 넣기는 `scripts/ship.sh`(push 하자마자) · 놓친 것은 현황판(`scripts/board/server.mjs` `autoReviewPlans` — 5분 안전망) · 고친 커밋 올리기는 `scripts/ship.sh --auto-push`
- 시험: `test/pr-auto-test.sh`(몇 초 · 가짜 리뷰어 · GitHub 를 건드리지 않는다)
- 기록: 처리기 로그 `/tmp/athena-pr-auto-<키>.log` · 대기열 팩 데이터 `state/pr-auto-queue/`(머지 확인 대기 `confirm/` · 실패 `failed/`) · 사건 기록 `state/events.jsonl`(`docs/events.md`)

## 켜기 — 레포마다 (기본 꺼짐)

팩 `pack.json` 의 레포에 `"autoMerge": true`. 없으면 그 레포 PR 은 지금처럼 사람이 한다. **첫 실행(`docs/setup.md` 2 · 3단계)과 레포 하나 더하기 때 레포마다 켤지 묻는다** — 나중에 바꾸려면 Athena Studio 앱 탭 줄 ⚙ 설정에서 레포마다 켜고 끄거나(아래 머지 전 확인도 같은 곳) `bin/athena pack set-auto-merge <레포> --auto on|off [--confirm on|off]` · 그 레포 항목을 직접 고친다(현황판 · 처리기는 다음 확인 때 새 값을 읽는다). main 직접 레포(`"direct": true`)는 PR 이 없어 대상이 아니다.

```jsonc
{ "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true }
```

**머지 직전 확인을 끄기** — 같은 레포 항목에 `"autoMergeConfirm": false` 를 더하면 머지 조건 ①~③(둘 다 승인 · 같은 HEAD 검증 · 충돌 없음)이 채워졌을 때 머지 확인 요청을 열지 않고 바로 머지한다. 머지 경로는 [머지] 를 고른 것과 같다(다시 확인 → `gh pr ready` → `squash --match-head-commit`). 키가 없거나 `true` 면 지금처럼 묻는다 · `"autoMerge": true` 인 레포에만 뜻이 있다 · 값은 글자 `"false"` 가 아니라 `false` 여야 한다.

```jsonc
{ "name": "web", "agents": ["web-fe"], "branch": "main", "prBase": "main", "autoMerge": true, "autoMergeConfirm": false }
```

- 머지 뒤 남는 것은 확인하는 경우와 같다 — 계획서 `- Auto review:` 줄(`머지됨 — squash → <base>`) · 사건 기록 `auto.merge`(`confirm: false` 가 붙는다) · PR 리뷰 댓글 · 작업 pane 에 머지 결과 한 줄(아래 "흐름" — pane 이 살아 있을 때만). **머지했다는 맥 알림 · 요청은 따로 없다**(요청은 사람이 답해야 할 때만 연다 — `docs/requests.md` "열지 않는 것"). 현황판은 머지된 PR 의 계획서를 평소처럼 완료로 옮긴다
- 확인을 끈 사이 다시 켜거나(`autoMergeConfirm` 을 지우거나 `true`) 자동 머지를 끄면, 아직 머지하지 않은 대기 건(GitHub 가 계산 중이던 것)은 머지하지 않고 `검증 대기 — 머지 전에 설정이 바뀜` 으로 남긴다. 그 줄을 지우면 지금 설정으로 다시 돈다
- 확인 없는 대기 건은 처리기가 이름을 바꿔(`confirm/<레포>-<번호>.json.<pid>`) 잡고 머지한다 — 처리기 하나와 손으로 돌린 한 번이 같은 PR 을 두 번 머지하지 않게. 잡은 파일은 머지 직전 확인 · 머지 결과를 계획서 줄에 적은 뒤에 지운다(도중에 꺼지면 남아 있다가 되돌려진다). 잡은 쪽(처리기 · 손으로 돌린 한 번)이 잡은 채로 끝나면 — 그 pid 가 살아 있지 않으면 — 처리기 시작 · `--kick` · 돌고 있는 처리기의 머지 확인 보기(30초마다) 때 원래 이름으로 돌려놓는다

> 그 레포의 `prBase` 가 운영 브랜치(`branch`)와 같으면 **머지가 곧 운영 반영**이다. 켜기 전에 그 레포의 검증 스크립트가 엄격 모드로 건너뜀 없이 통과하는지 먼저 본다(아래 "머지 조건" ②).

## 끝나면 저절로 PR (결정 D3 · 2026-10-25)

켠 레포의 레포 하나짜리 작업은 에이전트가 요청을 끝내고 검증 스크립트가 통과하면 **사용자 "PR 올려줘" 없이** 지금의 "PR 올려줘" 흐름(`commit.sh` → `ship.sh` 미리보기 → 제목 · 본문 정리 → draft PR)을 묻지 않고 돈다. 그 draft PR 을 아래 자동 리뷰가 받는다.

- 이미 열린 PR 이 있으면 `ship.sh` 가 그 브랜치에 새 커밋을 push 만 한다(새 HEAD 를 자동 리뷰가 다시 본다)
- 조사만 했거나 바뀐 게 없으면 올리지 않는다 · 검증이 실패하면 올리지 않고 보고한다
- 위임 지시문(`delegate.sh`)은 담당 레포가 켜져 있을 때만 이 문장을 싣는다 — 켜지 않은 레포는 지금처럼 사용자가 말할 때만

## 무엇이 대상인가

- 켠 레포의 **레포 하나짜리 작업** PR — 계획서의 `Agent` 줄 · 정식 계획서 "작업 배분" 표에 붙은 에이전트가 그 레포 에이전트 하나뿐일 때(`ship.sh` 와 같은 기준). 여러 레포 작업 PR 은 사람이 한다
- 계획서 Checkpoint 의 `- PR:` 줄에 있고 GitHub 에서 열린(OPEN) PR · 계획서 Status 가 `in_progress` · `ready_for_review`

## 흐름

```
draft PR · push (ship.sh) ─▶ 그 자리에서 대기열(현황판은 놓친 것을 5분 안에) ─▶ 처리기(하나)
   ─▶ Claude · Codex 리뷰(나란히 · 도구 없이 · JSON — Codex 를 못 쓰면 다른 모델 Claude · 앞 리뷰 승인이 같은 내용이면 Claude 는 이어받음)
   ─▶ PR 댓글 + 계획서 "- Auto review:" 줄
        ├ 둘 다 승인 ─▶ 같은 HEAD 검증(엄격) · 충돌 확인 ─▶ 머지 확인 요청(맥 알림 · [작업] 팝업)
        │                 └ [머지] ─▶ 다시 확인 ─▶ gh pr ready ─▶ squash 머지(--match-head-commit)
        │                 (레포가 autoMergeConfirm: false 면 요청 없이 바로 [머지] 와 같은 길로)
        ├ 수정 필요 ─▶ 작업 에이전트 pane 에 지시 ─▶ 고침 · commit.sh · ship.sh --auto-push [--body-file] ─▶ 새 HEAD(본문만이면 같은 HEAD)로 다시
        ├ 결정 필요 ─▶ 결정 콘솔에 덧붙임(plan-html --add) ─▶ 사람이 고름 ─▶ 에이전트가 반영 · 올림 ─▶ 다시
        └ 리뷰어 부족(하나라도 실패 · 로그인 안 됨) ─▶ 머지하지 않고 사람에게 요청
```

**언제 시작하나** — `ship.sh` 가 켠 레포의 PR 브랜치에 push 하면(새 draft PR · 이미 열린 PR 에 push · `--auto-push`) 그 자리에서 그 PR · 새 HEAD 를 대기열에 넣는다(대상은 아래 "무엇이 대상인가" 와 같다 — 레포 하나짜리 · Status `in_progress` · `ready_for_review`). push 직후 GitHub 가 PR HEAD 를 아직 옛 커밋으로 답하면 처리기가 몇 번(5초 간격 3번) 다시 묻는다. 현황판의 PR 감지(5분 캐시)는 놓친 것(대기열 넣기 실패 · 다른 곳에서 push)을 잡는 안전망으로 남는다. **같은 HEAD 는 한 번만** — 대기 · 처리 중인 같은 일(계획서 · PR · HEAD)은 `--enqueue` 가 막고, 처리기는 하나가 차례로 돌며 끝난 HEAD 는 계획서 `- Auto review:` 줄로 건너뛴다. 그래서 `ship.sh` 와 현황판이 둘 다 넣어도 리뷰는 한 번이다.

머지 확인 답을 처리한 결과(머지됨 · 보류 · 머지 직전 확인 실패 · draft 풀기 · 머지 실패)는 계획서 줄 · 사건 기록과 함께 작업 pane(Work ref 의 `pane`)에도 `[자동 리뷰 → <에이전트>] PR <레포>#<번호> @<sha> — <결과>. 알림만 …` 한 줄로 간다. pane 이 살아 있을 때만 — 닫혔으면 보내지 않는다(머지 결과로 닫힌 세션을 다시 열지 않는다).

머지 뒤에는 기존 흐름 그대로 — 현황판이 계획서를 완료로 옮기고 배우기 검토 대기열에 넣는다(`CLAUDE.md` 6단계).

## 리뷰어 — Claude · Codex (결정 D2)

| 리뷰어 | 부르는 법 | 도구 |
|---|---|---|
| Claude | `claude -p [--model <models.prReview>] --tools "" --strict-mcp-config --no-session-persistence --output-format json --json-schema <형식>` · 답은 `structured_output` | 없음 |
| Codex | `codex exec --ignore-user-config --disable <도구 기능>… -c web_search="disabled" --sandbox read-only --ephemeral --skip-git-repo-check -C <빈 폴더> --output-schema <파일> -o <파일>`(프롬프트는 표준 입력) · 답은 `-o` 파일 | 없음 — 셸 · 웹 · 사용자 MCP 서버를 끈다(아래) |

- **Codex 는 읽기 전용 샌드박스만으로는 도구가 남는다**(2026-10-25 실측 · codex-cli 0.160 — 셸로 `pwd` 가 돌고 · 웹에서 값을 가져오고 · 사용자 MCP 서버 `hostinger_*` 등이 붙었다). 그래서 사용자 `config.toml` 을 안 읽고(`--ignore-user-config` — MCP 서버 · 훅이 빠지고 로그인은 그대로) · 도구를 주는 기능을 끄고(`CODEX_TOOL_FEATURES` — `shell_tool` · `unified_exec` · `apps` · `browser_use` · `computer_use` · `plugins` · `multi_agent` …) · 웹 검색을 끈다(`web_search="disabled"`). 끈 뒤 같은 질문으로 셸 · 웹 · MCP 가 모두 없는 것을 실측했다. Codex 를 올리면 `codex features list` 로 새 도구 기능이 생겼는지 다시 본다
- 둘 다 빈 임시 폴더에서 돌고 끝나면 지운다. 받는 것: 레포 `rules.md` · `gotchas.md` · 계획서(앞 6000자) · PR 제목 · 본문 · diff(앞 6만 자) — 비밀값 모양은 가린다(`scripts/lib/mask.mjs`). PR 안의 글은 데이터로 넣고 지시로 따르지 않게 한다
- 답 형식(`REVIEW_SCHEMA`): `verdict` approve · changes · decision · `summary` · `findings[]`(파일 · 줄 · 문제 · 고칠 방법) · `decisions[]`(제목 · 왜 · 선택지 2~4 · 추천)
- 모양이 틀린 답 · 10분 넘김 · 명령 없음 · 0 이 아닌 종료(로그인이 풀려 답을 못 낸 경우 포함)는 그 리뷰어의 **실패** 다. 승인인데 지적이 붙은 모순된 답은 승인으로 세지 않는다
- Claude 쪽 모델은 팩 pack.json `"models": { "prReview": "<모델>" }`(`docs/pack.md` "pack.json") — 없으면 기본 모델. 이름이 이상하면 Claude 리뷰어가 실패해 리뷰어 부족이 된다(기본 모델로 다시 하지 않는다). Codex 쪽은 `~/.codex/config.toml` 의 모델 그대로
- **둘 다 승인해야 머지로 간다.** 하나라도 실패 · 반려면 머지하지 않는다 — 남은 하나로 판정하지 않는다

### Codex 가 없는 사람 — Claude 두 번(2026-10-26 사용자 결정)

Codex 유무는 팩이 아니라 사람(기기)마다 다르다. 리뷰 전에 `codex` 명령이 있는지 · 로그인됐는지(`codex login status` 종료 코드 — 출력은 보지 않는다)를 보고, **처음부터** 못 쓰면 두 번째 자리를 Claude 가 **다른 모델로** 따로 한 번 더 리뷰한다. "둘 다 승인" 규칙은 그대로다.

| | 첫 자리 | 두 번째 자리 |
|---|---|---|
| Codex 를 쓸 수 있음 | Claude — `models.prReview`, 없으면 기본 모델(지금과 같다) | Codex |
| Codex 없음 · 로그인 안 됨 | Claude — `models.prReview`, 없으면 `opus` | Claude — `models.prReviewSecond`, 없으면 `sonnet` |

- 팩 `models` 에 적힌 값이 먼저다(`docs/pack.md` "models"). 두 자리가 같은 모델이 되면 대신하지 않고 **리뷰어 부족**(같은 모델 두 번은 합의가 아니다)
- Codex 가 **돌다가 실패**(오류 · 시간 넘김 · 답 모양 틀림)한 것은 바꾸지 않는다 — 지금처럼 리뷰어 부족(조용히 Claude 로 바꾸지 않는다)
- 팩 `models` 가 이상하면 기본값으로 덮지 않는다 — 첫 자리 Claude 가 실패해 리뷰어 부족으로 드러난다(앞 리뷰 승인을 이어받을 때도 · 두 번째 자리를 기본 모델 Claude 로 대신하지도 않는다)
- 어떤 구성으로 돌았는지 PR 댓글 · 계획서 줄에 남는다 — `리뷰어 claude(opus) + claude(sonnet) — Codex 로그인 안 됨` · `리뷰어 claude + codex`

### 앞 리뷰 승인 이어받기(2026-10-26 사용자 결정)

PR 전에 reviewer pane 이 돌아(정식 계획서 · 넓은 수정) 계획서 `- Review result:` 가 **같은 내용으로 승인**이면, 첫 자리 Claude 는 다시 돌리지 않고 그 승인을 Claude 몫으로 쓴다. 두 번째 자리(Codex 또는 다른 모델 Claude)는 늘 새로 돈다.

- 같은 내용 판정은 `ship.sh` 의 리뷰 판정과 같다 — 그 줄의 `tree`(reviewer 가 본 워크트리 전체 · 커밋 전 변경 포함 — `review-result.sh`)로 PR HEAD 커밋의 tree 가 시작할 때. `tree` 가 없는 옛 줄은 커밋 sha 로. 줄은 이 레포 · 이 PR 브랜치 줄(없으면 표시 없는 옛 줄)의 마지막을 본다. PR HEAD tree 는 작업 워크트리에서, 없으면 GitHub 에서 읽고 못 읽으면 이어받지 않는다
- HEAD(tree)가 다르거나 결론이 수정 필요면 지금처럼 둘 다 돈다 — 수정 고리의 다음 라운드는 내용이 바뀌니 보통 둘 다 돈다
- PR 댓글 · 계획서 줄에 `Claude: 앞 리뷰 승인 이어받음 @<sha>` · 사건 기록 `reviewers` 에 `claude:inherited`

| 판정 | 조건(위부터) | 하는 일 |
|---|---|---|
| 결정 필요 | 결정이 하나라도 | 결정 콘솔에 덧붙이고(`[이대로 진행]` 은 작업 에이전트 pane 으로) 에이전트에 알린다 — 자동으로 고르지 않는다 |
| 수정 필요 | 지적이 하나라도 | 작업 에이전트 pane 에 수정 지시 |
| 승인 | 둘 다 답했고 둘 다 승인 | 머지 조건 확인 → 머지 확인 요청(레포가 `autoMergeConfirm: false` 면 요청 없이 바로 머지) |
| 리뷰어 부족 | 그 밖(하나라도 실패) | 머지하지 않고 사람에게 요청 |

## 수정 고리

- 지시는 `[자동 리뷰 → <에이전트>] …` 한 줄로 그 계획서의 작업 pane(Work ref 의 `pane`)에 넣는다. pane 이 닫혔으면 그 계획서 대화를 `delegate.sh --resume` 으로 다시 열어 넣고(`state/pane-sessions/` 기록), 그것도 없으면 사람에게 요청을 연다
- 지시를 받은 에이전트는 **그 지시에 한해** 묻지 않고 고친 뒤 `commit.sh` 로 커밋하고 `ship.sh --auto-push` 로 올린다(`AGENTS.md` 5절 예외). 고칠 방법이 하나가 아니면 고르지 않고 멈춘다
- **PR 본문 지적**이면 본문 파일을 고쳐 `ship.sh --auto-push --body-file <파일>` 로 본문도 바꾼다(아래) — 코드도 고쳤으면 같은 명령이 커밋 push 와 본문을 함께, 본문만이면 커밋 없이
- 새 커밋이 오면 현황판이 다시 감지해 재리뷰한다. 본문만 고쳤으면(같은 HEAD) `ship.sh` 가 계획서 줄을 `본문 고침 — 다시 리뷰 대기` 로 바꾸고 대기열에 직접 넣어 같은 HEAD 를 다시 본다(라운드 하나를 쓴다). **라운드 상한 3** — 3번째 리뷰에도 승인이 아니면 그 PR 에서 멈추고(`멈춤`) 사람에게 요청을 연다

## `ship.sh --auto-push`

자동 흐름에서만 쓰는 push — 사용자 "PR 올려줘" 없이 되는 유일한 길이다. 보호 훅(`commit-guard.py`)은 그대로이고, 훅이 통과시키는 `ship.sh` 안에서 아래를 모두 확인한다.

- 레포가 `"autoMerge": true` · main 직접 레포가 아님 · 메인 체크아웃 · 보호 브랜치 · detached 가 아님(평소 ship.sh 검사)
- HEAD 가 `commit.sh` 로 계획서 Commits 에 기록된 커밋 · 추적 파일 미커밋 없음
- 이 브랜치의 **열린 PR** 이 있고 그 PR 이 계획서 `- PR:` 줄에 있다
- 그 PR 의 `- Auto review:` 줄이 `수정 필요` · `결정 필요` — 자동 리뷰가 고치라고 한 PR 에만
- `origin/<브랜치>` 에서 **빨리 감기만**(강제 push 없음) · 새 PR · 제목 · base 없음
- `--body-file <파일>` — 위를 모두 통과한 뒤 그 PR 본문을 `gh pr edit --body-file` 로 바꾼다(제목 · base 는 그대로 · 본문 검사는 새 PR 과 같다 — 필수 절 · 로컬 경로 · 내부 주소 · 비밀값). 본문을 먼저 바꾸고 커밋을 올린다. 올릴 커밋이 없으면 본문만(그때만 `--body-file` 없이는 거절)

## 머지 조건 (결정 D3 · D5)

넷 다일 때만 머지한다(레포가 `"autoMergeConfirm": false` 면 ④ 없이 ①~③). 하나라도 빠지면 머지하지 않고 계획서 줄에 이유를 남긴다.

1. Claude · Codex 둘 다 승인(반대 · 결정 없음)
2. **같은 HEAD 로 검증 통과** — 계획서 Work ref 의 워크트리가 PR HEAD 와 같고 깨끗할 때 `ATHENA_VERIFY_STRICT=1 ATHENA_VERIFY_DIR=<워크트리> scripts/verify/reuse.sh <레포>`(이미 통과했으면 재사용 · 건너뜀도 실패)
3. 충돌 없음(GitHub `mergeable` 이 MERGEABLE — 계산 중이면 몇 번 다시 묻는다)
4. 사람이 머지 확인 요청에서 **[머지]** 를 고름 — 요청을 열면 스튜디오 앱이 맥 알림 · [작업] 팝업으로 보여 준다(`docs/requests.md`). [보류] 면 그 HEAD 는 머지하지 않는다. 레포가 `"autoMergeConfirm": false` 면 이 단계를 건너뛴다(요청을 열지 않는다)

[머지] 를 고르면 PR 상태 · HEAD · 충돌 · 검증을 한 번 더 본 뒤 `gh pr ready`(draft 면) → `gh pr merge --squash --match-head-commit <sha>`. 고른 사이 새 커밋이 왔거나 PR 이 닫혔으면 요청을 거둔다. 확인 없는 레포도 승인 직후 같은 다시 확인 · 머지를 거친다 — 그새 새 커밋 · 닫힘 · 충돌 · 검증 실패면 머지하지 않는다.

## 계획서 표시 줄

PR 마다 한 줄, 바꿔 쓴다(Work ref 바로 뒤).

```
- Auto review: <레포>#<번호> @<sha7> · <결과> · 리뷰어 <구성> [· Claude: 앞 리뷰 승인 이어받음 @<sha7> …] · 라운드 <k>/3 · <YYYY-MM-DD HH:MM>
```

결과 뒤의 메모(리뷰어 구성 · 이어받음)는 판정에 쓰지 않는다 — 결과는 앞부분으로만 읽어서 같은 HEAD 판정 · `ship.sh --auto-push` 확인이 그대로다.

결과: `수정 필요` · `결정 필요` · `승인 2/2 → 머지 확인 대기` · `승인 2/2 → 바로 머지(확인 없음)`(확인 없는 레포 — GitHub 가 계산 중이면 이 줄로 30초마다 다시 본다) · `리뷰어 부족(승인 n/2)` · `검증 대기 — <이유>` · `보류 — 사람이 고름` · `멈춤 — 라운드 상한` · `머지됨 — squash → <base>`.

- 같은 PR · 같은 HEAD 가 적혀 있으면 다시 돌지 않는다(`검증 대기` 도 같다 — 새 커밋이 오거나 줄을 지워야 다시 본다). 단 머지 확인 뒤 GitHub 가 머지 가능 여부를 아직 계산 중이면 답을 받은 채로 두고 30초마다 다시 본다. `멈춤` · `머지됨` 이면 새 커밋이 와도 돌지 않는다(사람이 이어받았다)
- **다시 돌리려면 그 줄을 지운다** — 예: 검증 환경을 고친 뒤 `검증 대기` 를 다시 보게 할 때
- 손으로 한 번 돌려 보기: `node scripts/pr-auto.mjs --plan <계획서> --pr <레포>#<번호> --dry-run` — 리뷰어 답 · 만들 댓글 · 할 일만 보여 주고 아무것도 쓰거나 보내지 않는다

## 한계

- 바로 시작은 `ship.sh` 로 push 할 때만 — 그 밖의 push(사람이 직접 · 다른 기기)는 현황판이 켜져 있을 때 5분 캐시로 잡고, 꺼져 있던 동안 온 커밋은 다음에 켜질 때 잡는다
- 두 번째 Claude 자리는 모델 이름 글자로만 다른지 본다 — 별칭과 전체 이름(`sonnet` · `claude-sonnet-…`)이 같은 모델이어도 다르다고 본다. 팩 값은 별칭끼리 적는다
- 리뷰어는 diff 와 문서만 본다 — 실행해 보지 않는다. 그래서 머지 조건에 같은 HEAD 검증이 따로 있다
- Codex 도구 끄기는 기능 이름 목록이라, Codex 가 새 도구 기능을 기본으로 켜고 나오면 그것은 꺼지지 않는다 — 올린 뒤 다시 실측한다. 리뷰어 답은 댓글 · 지시로 내보내기 전에 비밀값 모양을 한 번 더 가린다
- PR 댓글은 의견(comment)으로 단다 — 같은 계정이 연 PR 은 승인(approve)을 달 수 없고, 머지 판정은 이 스크립트가 한다
