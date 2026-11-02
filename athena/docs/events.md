# 사건 기록 (events)

일이 어떻게 흘렀는지 — 사람이 몇 번 끼어들었나 · 계획서가 언제 어느 상태로 갔나 · 검증이 몇 번 실패했나 · 언제 커밋·리뷰했나 — 를 한 줄씩 남긴다. 아테나가 맨 에이전트보다 일을 잘하는지, 학습이 쌓여 나아지는지를 숫자로 보기 위한 바닥 기록이다.

- 코드: `scripts/lib/events.mjs` · 시험 `test/requests-test.sh` "사건 기록"
- 자리: 여러 팩 구조면 **팩 데이터 `state/events.jsonl`**(팩마다 따로), 옛 구조 본체면 `.events.jsonl`
- 덧붙이기만 한다 — 고치거나 지우지 않는다. 기록에 실패해도 하던 일은 그대로 간다
- 백업 · 내보내기에는 아직 담지 않는다

## 한 줄의 모양

```json
{"v":1,"at":"2026-10-25T03:12:09.120Z","type":"request","pack":"acme", …}
```

| type | 누가 남기나 | 필드 |
|---|---|---|
| `request` | `scripts/lib/requests.mjs` — 요청 상태가 바뀔 때마다(열기 · 고쳐 열기 · 답 · 받음 · 취소 · 닫힘) | `id` · `kind` · `state` · `plan` · `by`(board · app · chat) · `rev` |
| `delegate` | `scripts/delegate.sh` — pane 을 띄우거나 이어 보낸 뒤 | `plan` · `agent` · `pane` · `promptChars`(지시문 글자 수 · 이어 열기는 0) · `contextChars`(시스템 프롬프트 파일 글자 수 · 이어 보내기는 0) |
| `plan.status` | 현황판(`scripts/board/server.mjs`) — 훑을 때 지난번 본 Status 와 다르면 · `scripts/commit.sh` — 커밋 뒤 `ready_for_review` 로 바꾸면 | `plan` · `grade`(light · formal) · `from`(새로 생겼으면 null) · `to` |
| `verify` | `scripts/verify/_lib.sh` — 검증 스크립트가 실제로 돌았을 때(`reuse.sh` 의 재사용은 안 남김) | `repo` · `branch` · `sha` · `ok` · `strict` · `failed`(실패 단계, `\|` 구분) · `args` · `plan`(환경 `ATHENA_PLAN` — `delegate.sh` 가 pane 에, `commit.sh` 가 검증 호출에 넘긴다 · 없으면 빈 값) · `ms`(소요 — `_lib.sh` 를 source 한 때부터 사건을 남길 때까지 · `heavy.sh` 줄서기는 들어가지 않는다) · `scope`(scoped · full · docs — 문서만 바뀌어 시험·빌드를 건너뛰고 파일 점검만 한 것) · `wait_ms`(`heavy.sh` 줄서기로 기다린 시간 — `ms` 와 따로 · 안 기다렸거나 옛 기록은 0/없음) · `wait_why`(마지막 대기 이유 — 누가 자리를 쥐었는지 · 부하) |
| `commit` | `scripts/commit.sh` — 커밋한 뒤 | `plan` · `repo` · `branch` · `sha` · `verified` · `verify` |
| `review` | `scripts/review-result.sh` — 리뷰 결론을 적은 뒤 · `scripts/pr-auto.mjs` — PR 자동 리뷰 결론마다(`by: auto`) | `plan` · `verdict`(승인 · 수정 필요 · 자동 리뷰는 결정 필요도) · `repo` · `branch` · `sha` · `dirty` · 자동이면 `pr` · `by` · `reviewers`(`claude:approve,codex:changes` 꼴 · 앞 리뷰 승인을 이어받은 자리는 `claude:inherited` · Codex 대신 돈 Claude 는 `claude-<모델>:…`) · 빠른 길이면 `fast: true` |
| `auto.fix` | `scripts/pr-auto.mjs` — 수정 지시를 작업 pane 에 보낸 뒤 | `plan` · `repo` · `branch` · `sha` · `pr` · `pane` · `reviewers` · 빠른 길이면 `fast: true` |
| `auto.push` | `scripts/ship.sh --auto-push` — 고친 커밋을 그 PR 브랜치에 올린 뒤(또는 `--body-file` 로 본문만 바꾼 뒤) | `plan` · `repo` · `branch` · `sha` · `pr` · 본문을 바꿨으면 `body`(1) |
| `auto.decide` | `scripts/pr-auto.mjs` — 구현 세부 결정을 추천안으로 자동 확정한 뒤(계획서 Decisions 에 적고) | `plan` · `repo` · `branch` · `sha` · `pr` · `count` · `reviewers` |
| `pr.open` | `scripts/ship.sh` — 새 draft PR 을 만든 직후(이미 열린 PR 에 push 만 할 때는 안 남김) — 리뷰 구간의 시작 | `plan` · `repo` · `pr` · `sha` · `fast`(⚡ 빠른 길 판정 — `docs/pr-auto.md` "빠른 길") |
| `auto.takeover` | `scripts/pr-auto.mjs` — 리뷰 상한 뒤 이어받은 HEAD 를 리뷰 없이 머지 단계로 넘길 때(빠른 길은 1라운드 수정 뒤 고친 HEAD) | `plan` · `repo` · `branch` · `sha` · `pr` · 빠른 길이면 `fast: true` |
| `auto.stop` | `scripts/pr-auto.mjs` — 머지로 가지 못하고 멈출 때 | `plan` · `repo` · `pr` · `sha` · `reason`(reviewers · rounds — 상한을 넘었는데 이어받을 수정이 없음 · verify · decisions — 결정 콘솔에 안 정한 결정) · `why` · 빠른 길이면 `fast: true` |
| `auto.merge` | `scripts/pr-auto.mjs` — 머지 확인 답을 처리한 뒤(확인 없는 레포는 승인 뒤 바로) | `plan` · `repo` · `pr` · `sha` · `ok` · 실패면 `reason`(held — 보류 · recheck — 직전 확인 실패 · 확인 없는 머지 전에 PR · 설정이 바뀜 · gh) · 확인 없이 머지한 것(레포 `autoMergeConfirm: false`)이면 `confirm: false` · 빠른 길이면 `fast: true` · 넘긴 작업은 `handoff: true` · `run` · 성공이면 `mergedAt` · `handoffMs` |
| `handoff` | `scripts/pr-auto.mjs --handoff` — 작업을 Actions 로 넘긴 뒤 | `plan` · `repo` · `branch` · `sha` · `base` |

`verify` 의 계획서는 환경 `ATHENA_PLAN` 으로 온다 — `delegate.sh` 로 띄운 pane 과 `commit.sh` 의 커밋 전 검증은 `plan` 이 차고, 사람이 pane 밖에서 직접 돌린 검증은 빈 값이다. `plan` 이 없는 줄(옛 기록 포함)은 같은 `repo` · `branch` 의 `commit` · `review` 로 잇는다. `ms` · `scope` 도 같은 때 생겼으니 옛 기록에는 없다 — 지표는 그 줄의 검증 소요를 모르는 것(null)으로 둔다.

## 계획서 상태의 한계

에이전트가 계획서 md 를 직접 고치는 Status 변화는 고치는 쪽에서 남길 수 없다(`commit.sh` 가 바꾼 것만 바로 남기고 본 기록도 맞춘다). 나머지는 현황판이 훑을 때(켜져 있을 때만) 지난번 본 상태(`state/plan-status.json`)와 비교해 남긴다.
- 현황판이 꺼져 있던 동안의 변화는 다음에 켜졌을 때의 시각으로 찍힌다 — 그사이 여러 번 바뀌었으면 마지막 것만
- 처음(본 기록이 없을 때)은 지금 상태만 적어 두고 사건은 남기지 않는다

## 보기 — 현황판 [지표] 탭 · scripts/metrics.mjs

계산은 `scripts/lib/metrics.mjs` 하나(시험 `test/metrics-test.sh`) — 현황판 [지표] 탭(`/api/metrics?days=1|7|30|all&since=YYYY-MM-DD&review=with|without`)과 명령이 같이 쓴다. 작업 안쪽은 `scripts/lib/session-work.mjs`(`/api/metrics/work` · 탭만).

```sh
node scripts/metrics.mjs              # 최근 7일 · 지난 7일과 비교
node scripts/metrics.mjs --days 30    # --all 전체 · --since 2026-11-01 · --review with|without · --json
```

| 숫자 | 뜻 |
|---|---|
| 완료 | 그 기간에 끝(첫 머지 · 머지 없으면 done)이 든 계획서 |
| 시작 → 첫 머지 | 대표 소요 — 처음 본 때(`plan.status` from null) → 첫 `auto.merge` ok, 머지 없으면 done. 평균 · 중앙값 · p75(선형 보간). 머지 / done 기준 / 시작 기록 없어 빠진 건수를 같이 적는다 |
| 머지 → 완료 표시 | 마지막 머지 → done. 소요와 따로(첫 머지 뒤 이어 한 일이 있으면 그 시간도 들어 "첫 머지 뒤 커밋 N건" 을 같이 적는다) |
| 작업당 질문 | 완료한 작업마다 요청이 open 이 된 횟수의 평균 — 열린 채로 고친 것은 세지 않는다 |
| 평균 답 대기 | 그 기간에 답이 온 요청의 open → answered · delivered |
| 검증 실패율 · 리뷰 반려율 | 그 기간의 `verify` 중 실패 · `review` 중 수정 필요 |
| 구간 — 작업 · 검증 · 답 대기 · 리뷰 · 머지 대기 | 계획서마다 시작 → 끝을 나눈다(다 알면 합 = 소요). 한 순간은 한 구간에만 — 겹치면 검증 > 리뷰 > 머지 대기 > 답 대기 > 작업. 검증 = `verify` 의 `at - ms - wait_ms` → `at`(줄서기 포함) · 리뷰 = 한 번의 시작 → 결론(시작은 `review.ms` · 없으면 수동은 직전 reviewer `delegate`, 옛 자동은 직전 `commit` · `auto.push` · `pr.open`) · 머지 대기 = 작업 끝(첫 머지 전 마지막 `commit` · ready_for_review) → 첫 머지 · 답 대기 = 요청 open → 닫힘 · 작업 = 나머지. 있었던 건만 집계해 "N건 중 M건". 소요를 모르는 줄이 든 계획서는 그 구간과 작업이 0 이 아니라 모름 |
| 리뷰 라운드 평균 | done 계획서 중 자동 리뷰가 있는 것의 `review`(`by: auto`) 수 평균 |
| 머지당 수정 | 그 기간의 `auto.fix` 수 ÷ `auto.merge`(ok) 수 — 머지가 없으면 — |
| 되돌림 | 머지 뒤 되돌린 수 — 되돌림 사건이 아직 없어 "기록 없음"(커밋 메시지 `revert` 로 세지 않는다) |

계획서 표는 그 기간에 무슨 사건이든 있었던 계획서다(최근 것부터). 검증은 `plan` 칸으로 붙고, 없으면 같은 레포 · 브랜치의 커밋 · 리뷰가 있어야 붙는다. 계획서 줄의 막대는 아는 구간만 토막으로 — 다 모르면 전체 소요 한 토막.

리뷰 있음 · 없음은 끝(첫 머지 · done) 전에 `review` 가 있었나로 가른다. 지난 기간은 같은 길이의 앞 기간이다.

**작업 안쪽** — Claude 세션 기록(`~/.claude/projects/<워크트리 폴더>/*.jsonl`)을 나눈 합계: 생각·작성(응답 하나 — message id 가 같은 줄들과 그 앞 대기 · 파일 고치기 포함) · 검증·커밋 · 끝날 때까지 기다리기(`until` · `while` + `sleep`, 맨 앞 `sleep`, `review-wait.sh`, Monitor) · 그 밖의 명령 · 파일 읽기. 한 세션 안에서는 겹치지 않고 기간 밖은 잘라 낸다. 세션끼리는 더하기만 해 동시에 돌면 실제 경과보다 클 수 있다. 세션은 `delegate.sh` 의 첫머리 지시(`이 작업의 계획서:` · `새 계획서:`)로 계획서에 잇는다 — reviewer · 표시 없는 세션은 건수만, AskUserQuestion(사람 대기) · 서브에이전트 줄 · Codex 세션은 세지 않는다.

## 셸에서 남기기

```sh
node scripts/lib/events.mjs <type> 키=값 …     # 값 true · false 는 참거짓으로 · ms 는 숫자로, 나머지는 글자
```
