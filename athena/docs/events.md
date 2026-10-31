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
| `plan.status` | 현황판(`scripts/board/server.mjs`) — 훑을 때 지난번 본 Status 와 다르면 | `plan` · `grade`(light · formal) · `from`(새로 생겼으면 null) · `to` |
| `verify` | `scripts/verify/_lib.sh` — 검증 스크립트가 실제로 돌았을 때(`reuse.sh` 의 재사용은 안 남김) | `repo` · `branch` · `sha` · `ok` · `strict` · `failed`(실패 단계, `\|` 구분) · `args` · `plan`(환경 `ATHENA_PLAN` — `delegate.sh` 가 pane 에, `commit.sh` 가 검증 호출에 넘긴다 · 없으면 빈 값) · `ms`(소요 — `_lib.sh` 를 source 한 때부터 사건을 남길 때까지 · `heavy.sh` 줄서기는 들어가지 않는다) · `scope`(scoped · full) |
| `commit` | `scripts/commit.sh` — 커밋한 뒤 | `plan` · `repo` · `branch` · `sha` · `verified` · `verify` |
| `review` | `scripts/review-result.sh` — 리뷰 결론을 적은 뒤 · `scripts/pr-auto.mjs` — PR 자동 리뷰 결론마다(`by: auto`) | `plan` · `verdict`(승인 · 수정 필요 · 자동 리뷰는 결정 필요도) · `repo` · `branch` · `sha` · `dirty` · 자동이면 `pr` · `by` · `reviewers`(`claude:approve,codex:changes` 꼴 · 앞 리뷰 승인을 이어받은 자리는 `claude:inherited` · Codex 대신 돈 Claude 는 `claude-<모델>:…`) |
| `auto.fix` | `scripts/pr-auto.mjs` — 수정 지시를 작업 pane 에 보낸 뒤 | `plan` · `repo` · `branch` · `sha` · `pr` · `pane` · `reviewers` |
| `auto.push` | `scripts/ship.sh --auto-push` — 고친 커밋을 그 PR 브랜치에 올린 뒤(또는 `--body-file` 로 본문만 바꾼 뒤) | `plan` · `repo` · `branch` · `sha` · `pr` · 본문을 바꿨으면 `body`(1) |
| `auto.decide` | `scripts/pr-auto.mjs` — 구현 세부 결정을 추천안으로 자동 확정한 뒤(계획서 Decisions 에 적고) | `plan` · `repo` · `branch` · `sha` · `pr` · `count` · `reviewers` |
| `auto.takeover` | `scripts/pr-auto.mjs` — 리뷰 상한 뒤 이어받은 HEAD 를 리뷰 없이 머지 단계로 넘길 때 | `plan` · `repo` · `branch` · `sha` · `pr` |
| `auto.stop` | `scripts/pr-auto.mjs` — 머지로 가지 못하고 멈출 때 | `plan` · `repo` · `pr` · `sha` · `reason`(reviewers · rounds — 상한을 넘었는데 이어받을 수정이 없음 · verify · decisions — 결정 콘솔에 안 정한 결정) · `why` |
| `auto.merge` | `scripts/pr-auto.mjs` — 머지 확인 답을 처리한 뒤(확인 없는 레포는 승인 뒤 바로) | `plan` · `repo` · `pr` · `sha` · `ok` · 실패면 `reason`(held — 보류 · recheck — 직전 확인 실패 · 확인 없는 머지 전에 PR · 설정이 바뀜 · gh) · 확인 없이 머지한 것(레포 `autoMergeConfirm: false`)이면 `confirm: false` |

`verify` 의 계획서는 환경 `ATHENA_PLAN` 으로 온다 — `delegate.sh` 로 띄운 pane 과 `commit.sh` 의 커밋 전 검증은 `plan` 이 차고, 사람이 pane 밖에서 직접 돌린 검증은 빈 값이다. `plan` 이 없는 줄(옛 기록 포함)은 같은 `repo` · `branch` 의 `commit` · `review` 로 잇는다. `ms` · `scope` 도 같은 때 생겼으니 옛 기록에는 없다 — 지표는 그 줄의 검증 소요를 모르는 것(null)으로 둔다.

## 계획서 상태의 한계

에이전트가 계획서 md 를 직접 고치므로 Status 변화는 고치는 쪽에서 남길 수 없다. 현황판이 훑을 때(켜져 있을 때만) 지난번 본 상태(`state/plan-status.json`)와 비교해 남긴다.
- 현황판이 꺼져 있던 동안의 변화는 다음에 켜졌을 때의 시각으로 찍힌다 — 그사이 여러 번 바뀌었으면 마지막 것만
- 처음(본 기록이 없을 때)은 지금 상태만 적어 두고 사건은 남기지 않는다

## 보기 — 현황판 [지표] 탭 · scripts/metrics.mjs

계산은 `scripts/lib/metrics.mjs` 하나(시험 `test/metrics-test.sh`) — 현황판 [지표] 탭(`/api/metrics?days=7|30|all`)과 명령이 같이 쓴다.

```sh
node scripts/metrics.mjs              # 최근 7일 · 지난 7일과 비교
node scripts/metrics.mjs --days 30    # --all 전체 · --json
```

| 숫자 | 뜻 |
|---|---|
| 완료 | 그 기간에 done 이 된 계획서(done 뒤 다시 열렸으면 빼고) |
| 평균 소요 | 처음 본 때(`plan.status` from null) → done. 기록 전에 시작한 계획서는 뺀다(칸에 "시작 기록 N개 기준") |
| 작업당 질문 | 완료한 작업마다 요청이 open 이 된 횟수의 평균 — 열린 채로 고친 것은 세지 않는다 |
| 평균 답 대기 | 그 기간에 답이 온 요청의 open → answered · delivered |
| 검증 실패율 · 리뷰 반려율 | 그 기간의 `verify` 중 실패 · `review` 중 수정 필요 |
| 구간 평균 — 작업 · 검증 · 리뷰 · 머지 대기 | 그 기간에 done 이 된 계획서 중 그 구간을 아는 것만의 평균(모르는 것이 있으면 "N개 기준"). 작업 = 처음 본 때 → 첫 ready_for_review · 검증 = 그 계획서 `verify` 의 `ms` 합(`plan` · `ms` 가 있는 줄만 — 옛 기록은 모름) · 리뷰 = 첫 리뷰 결론 → 마지막 리뷰 결론(PR 올림 사건이 없어 첫 리뷰까지의 대기는 안 들어간다 · 리뷰 1번이면 0) · 머지 대기 = 마지막 리뷰 결론 → `auto.merge` ok(없으면 done) |
| 리뷰 라운드 평균 | done 계획서 중 자동 리뷰가 있는 것의 `review`(`by: auto`) 수 평균 |
| 머지당 수정 | 그 기간의 `auto.fix` 수 ÷ `auto.merge`(ok) 수 — 머지가 없으면 — |
| 되돌림 | 머지 뒤 되돌린 수 — 되돌림 사건이 아직 없어 "기록 없음"(커밋 메시지 `revert` 로 세지 않는다) |

계획서 표는 그 기간에 무슨 사건이든 있었던 계획서다(최근 것부터). 검증은 `plan` 칸으로 붙고, 없으면 같은 레포 · 브랜치의 커밋 · 리뷰가 있어야 붙는다. 계획서 줄의 막대는 아는 구간만 토막(작업 · 검증 · 리뷰 · 머지 대기)으로 — 다 모르면 전체 소요 한 토막.

## 셸에서 남기기

```sh
node scripts/lib/events.mjs <type> 키=값 …     # 값 true · false 는 참거짓으로 · ms 는 숫자로, 나머지는 글자
```
