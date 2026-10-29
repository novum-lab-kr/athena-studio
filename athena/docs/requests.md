# 사람에게 묻는 요청 (request)

에이전트가 **사람의 판단이 있어야 넘어갈 수 있을 때** 남기는 기록이다. 현황판 · 스튜디오 앱의 "확인 필요" 는 이것만 센다 — Status 글자(`blocked` · `ready_for_review`)나 pane 상태로 "사람 차례"를 짐작하지 않는다.

- 코드: `scripts/lib/requests.mjs` · 명령 `bin/athena request …`(아래) · 시험 `test/requests-test.sh`
- 자리: 여러 팩 구조면 **팩 데이터 `state/requests/<id>.json`**(팩마다 따로 · 본체 링크를 늘리지 않는다), 옛 구조 본체면 `.requests/`
- 쓰기는 명령으로만 — 파일을 손으로 고치지 않는다(잠금 · 원자 저장 · `rev` 검사가 명령 안에 있다)
- 백업 · 내보내기에는 담지 않는다 — pane · 세대에 묶인 상태라 다른 컴퓨터 · 다른 세대에서는 뜻이 없다. 결정 내용 자체는 계획서(md · html)에 남는다

## 언제 여는가

| 종류 | 누가 · 언제 |
|---|---|
| `decision` | **결정 콘솔** — `scripts/plan-html.mjs` 가 안 정한 결정이 있으면 계획서마다 하나를 연다(`--key plan:<계획서>`). 사용자가 콘솔에서 [이대로 진행] 을 누르면 현황판(`/api/action` + `plan`)이 답을 적고(answered · by board) 지시 앞에 `[요청 <id>]` 를 붙여 보낸다. 다 정하면(`--decide` · `--data` 에 `decided`) 받은 것으로 닫는다(delivered). 따로 부를 필요 없다 |
| `question` | **모아서 묻기**(`AGENTS.md` 5절 "추측으로 개발하지 않는다") — Blocked 에 적고 사용자에게 묻는 바로 그때 연다. 한 번에 묻는 묶음이 요청 하나다 |

열지 않는 것: 진행 보고 · "리뷰할까요?" 같은 한 줄 확인 · 커밋 · PR 확인(사용자가 말할 때만 하는 일) · 끝났다는 알림 · 고를 것이 없는 PR 자동 리뷰 상태 알림(검증 못 함 · 충돌 · 리뷰어 부족 등 — 아테나 pane 으로 보낸다 · `docs/pr-auto.md` "아테나에 알림").

## 흐름

```
open ──(사람이 답함: 현황판 · 앱)──▶ answered ──(에이전트가 받음: ack)──▶ delivered
  │                                                 
  ├──(대화로 답함: answer --by chat)──────────────▶ delivered
  ├──(에이전트가 거둠: cancel)──▶ cancelled
  └──(계획서가 done · 없어짐 — list 가 닫는다)──▶ expired
```

- 같은 `--key` 로 열린(open · answered) 요청이 있으면 새로 만들지 않고 고친다(`rev` +1). 답을 받은 뒤 다시 열면 답을 지우고 open
- 답할 때 `--rev` 를 주면 그사이 바뀐 요청에는 답하지 않는다(`conflict`) · 이미 답한 요청에 또 답하면 `conflict`
- 팩 세대가 바뀐 뒤(가져오기 `--replace` 등) 만든 요청에 온 답은 거절한다(`stale`)
- `ack` 는 두 번 불러도 된다(`already: true`) — 같은 답이 두 번 와도 한 번만 반영한다

## 에이전트가 할 일

- **질문을 열 때** — 사용자에게 묻는 것과 같은 턴에:
  `bin/athena request open --kind question --title '<무엇을 정해야 하나 한 줄>' --body-file <근거 · 확인한 것 · 추천안> [--plan <계획서>] [--option '<라벨> :: <설명>' … --recommend <라벨>]`
  돌려받은 `request.id` 를 계획서 Blocked 줄에 같이 적는다
- **고르기 질문은 AskUserQuestion 으로** — 위임 에이전트 세션은 `scripts/hooks/ask-to-request.py`(PreToolUse)가 AskUserQuestion 을 잡아 질문마다 `question` 요청을 열고(계획서 = `ATHENA_PLAN` · 추천 `(Recommended)` 표시 · 설명 포함) 도구는 막는다. 답은 평소처럼 `[요청 <id>] … 답:` 으로 오니 받자마자 `request ack`. 여러 개 고르기(multiSelect)는 단일 선택 + 메모, 선택지 미리보기는 본문 끝, 직접 입력(Other)은 팝업의 메모칸이 맡는다. 아테나 pane 은 대상이 아니다. 요청을 열지 못하면 막지 않고 원래 고르기 창이 뜬다
- **사용자가 대화로 답하면** — `bin/athena request answer <id> --by chat --text '<답 요약>'`(바로 delivered)
- **답이 `[요청 <id>]` 를 달고 pane 으로 오면**(현황판 · 앱에서 답한 것) — 받자마자 `bin/athena request ack <id>`
- **더 묻지 않아도 되면** — `bin/athena request cancel <id> --reason '<이유>'`
- 결정 콘솔 요청은 `plan-html.mjs` · 현황판이 맡는다 — 손으로 열거나 닫지 않는다(`[요청 <id>] [작업계획서 결정사항 확정] …` 이 오면 평소처럼 `--decide` 로 확정하면 닫힌다)

## 명령

`--json` 이면 마지막 줄 하나가 JSON(`{ ok, request }` · 목록은 `{ ok, requests }`), 실패는 `{ ok:false, error, message }` — `error` 는 `usage`(종료 2) · `not-found` · `conflict` · `stale` · `locked` · `contract-mismatch`. 스튜디오는 팩 명령처럼 `--contract` 를 붙인다.

| 명령 | 하는 일 |
|---|---|
| `request open --kind decision\|question --title <글> [--body <글>\|--body-file <파일>] [--option '<라벨>[ :: <설명>]' …] [--recommend <라벨>] [--plan …] [--html …] [--issue …] [--pane <id>] [--key <키>]` | 연다. `--pane` 이 없으면 부른 pane(`scripts/screen self`) · 화면 밖이면 포커스된 pane(`scripts/screen pane current`) |
| `request list [--all]` | 열린 것(open · answered) · `--all` 은 닫힌 것까지 |
| `request show <id>` | 하나 |
| `request answer <id> --by board\|app\|chat [--choice <라벨>] [--text <글>] [--rev <n>]` | 사람의 답 |
| `request ack <id>` | 에이전트가 받았다 |
| `request cancel <id> [--reason <글>]` | 거둔다 |

## 파일 모양 (`format` 1)

```json
{
  "format": 1, "id": "r-20261021-153000-a1b2", "kind": "decision",
  "title": "…", "body": "…", "options": [{ "label": "A", "desc": "…", "recommended": true }],
  "links": { "plan": "plans/feature/…md", "html": "plans/feature/…html", "issue": null },
  "pane": "w1:p3", "pack": "acme", "generation": 3, "dedupeKey": "plan:plans/feature/…md",
  "state": "open", "rev": 1, "createdAt": "…", "updatedAt": "…",
  "answer": { "choice": "A", "text": null, "by": "board", "at": "…" }, "deliveredAt": null, "closedReason": null
}
```

`pane` 은 보낼 곳을 찾는 힌트일 뿐이다 — 보낼 때 그 pane 이 아직 있는지 다시 본다.
