# 사람에게 묻는 요청 (request)

에이전트가 **사람의 판단이 있어야 넘어갈 수 있을 때** 남기는 기록이다. 현황판 · 스튜디오 앱의 "확인 필요" 는 이것만 센다 — Status 글자(`blocked` · `ready_for_review`)나 pane 상태로 "사람 차례"를 짐작하지 않는다. 역할은 현황판 이슈 = 앞으로 할 일 / [작업] = 지금 도는 일과 내 답을 기다리는 일 / 계획서 = 작업 기록 — 열린 요청이 있는 계획서는 [작업] 진행 중에 남는다.

- 코드: `scripts/lib/requests.mjs` · 명령 `bin/athena request …`(아래) · 시험 `test/requests-test.sh`
- 자리: 여러 팩 구조면 **팩 데이터 `state/requests/<id>.json`**(팩마다 따로 · 본체 링크를 늘리지 않는다), 옛 구조 본체면 `.requests/`
- 쓰기는 명령으로만 — 파일을 손으로 고치지 않는다(잠금 · 원자 저장 · `rev` 검사가 명령 안에 있다)
- 백업 · 내보내기에는 담지 않는다 — pane · 세대에 묶인 상태라 다른 컴퓨터 · 다른 세대에서는 뜻이 없다. 결정 내용 자체는 계획서(md · html)에 남는다

## 언제 여는가

| 종류 | 누가 · 언제 |
|---|---|
| `decision` | **결정** — `--html` 이 없으면 앱이 질문과 같은 선택지 화면으로 답을 받는다. `--html` 이 있으면 **결정 콘솔** — `scripts/plan-html.mjs` 가 안 정한 결정이 있으면 계획서마다 하나를 연다(`--key plan:<계획서>`). 사용자가 콘솔에서 [이대로 진행] 을 누르면 현황판(`/api/action` + `plan`)이 답을 적고(answered · by board) 지시 앞에 `[요청 <id>]` 를 붙여 보낸다. 다 정하면(`--decide` · `--data` 에 `decided`) 받은 것으로 닫는다(delivered). 따로 부를 필요 없다 |
| `question` | **모아서 묻기**(`AGENTS.md` 5절 "추측으로 개발하지 않는다") — Blocked 에 적고 사용자에게 묻는 바로 그때 연다. 한 번에 묻는 묶음이 요청 하나다 |

열지 않는 것: 진행 보고 · "리뷰할까요?" 같은 한 줄 확인 · 커밋 · PR 확인(사용자가 말할 때만 하는 일) · 끝났다는 알림 · 고를 것이 없는 PR 자동 리뷰 상태 알림(검증 못 함 · 충돌 · 리뷰어 부족 등 — 아테나 pane 으로 보낸다 · `docs/pr-auto.md` "아테나에 알림").

## 흐름

```
open ──(사람이 답함: 현황판 · 앱)──▶ answered ──(에이전트가 받음: ack)──▶ delivered
  │                                                 
  ├──(대화로 답함: answer --by chat — 묻던 pane 에서)──▶ delivered
  ├──(다른 pane 이 대화로 대신 답함: answer --by chat)──▶ answered(묻던 pane 에 한 줄을 넣는다) ──(ack)──▶ delivered
  ├──(에이전트가 거둠: cancel)──▶ cancelled
  └──(결정 콘솔은 계획서가 done · 없어짐 — list 가 닫는다)──▶ expired
```

- **질문(question)은 계획서가 done 이거나 없어도 닫지 않는다** — 답 전(open)이든 답이 온 뒤(answered)든 에이전트가 ack 하거나 취소할 때까지 [작업] 에 남는다(사라지면 에이전트가 영원히 기다리거나 답을 못 받는다). 콘솔 없는 decision 도 같다. 결정 콘솔에 묶인 decision(`--html` · `plan:<계획서>` 키)만 계획서와 함께 닫힌다. 받을 pane 이 닫혀 ack 가 안 오면 그대로 남으므로 `request cancel <id>` 로 거둔다(answered 도 된다 — 앱 · 현황판에는 취소 버튼이 없다). 닫힌 요청을 기다리던 에이전트는 `request show <id>` 로 상태를 보고 필요하면 새로 연다
- `--plan` 은 본체 안의 절대 경로를 줘도 본체 기준 논리 경로(`plans/…md`)로 저장한다
- 같은 `--key` 로 열린(open · answered) 요청이 있으면 새로 만들지 않고 고친다(`rev` +1). `--option` 을 안 주면 있던 선택지는 그대로다(주면 바뀐다 · 지우는 방법은 없다). 답을 받은 뒤 다시 열면 답을 지우고 open
- 답할 때 `--rev` 를 주면 그사이 바뀐 요청에는 답하지 않는다(`conflict`) · 이미 답한 요청에 또 답하면 `conflict`
- 팩 세대가 바뀐 뒤(가져오기 `--replace` 등) 만든 요청에 온 답은 거절한다(`stale`)
- `ack` 는 두 번 불러도 된다(`already: true`) — 같은 답이 두 번 와도 한 번만 반영한다

## 에이전트가 할 일

- **질문을 열 때** — 사용자에게 묻는 것과 같은 턴에:
  `bin/athena request open --kind question --title '<무엇을 정해야 하나 한 줄>' --body-file <근거 · 확인한 것 · 추천안> [--plan <계획서>] [--option '<라벨> :: <설명>' … --recommend <라벨>]`
  돌려받은 `request.id` 를 계획서 Blocked 줄에 같이 적는다
- **글은 배경부터, 쉬운 말로** — 사용자는 [작업] 팝업의 제목 · 본문 · 선택지만 보고 고른다. 이 일을 처음 듣는 사람이 읽는다고 보고 본문에 아래를 이 순서로 쓴다
  1. **어디서 나온 일인가** — 예: "GitHub 이슈 #134(바깥 사용자 신고)" · "작업 중 발견"
  2. **이미 진행 중인 것과의 관계** — 이 결정을 안 해도 이미 고쳐지는 것이 있으면 그렇다고
  3. **고르면 무엇이 달라지고, 안 하면 어떻게 되는지** — 선택지마다 한 줄. 안 하기 · 보류가 가능하면 그것도 선택지로
  4. **추천과 이유 한 줄**
  - 스크립트 · 변수 · 파일 이름 같은 내부 용어는 쓰지 않거나 괄호로 풀어 쓴다. 제목(`--title`)도 "무엇을 정하는지" 한 줄로, 내부 용어 없이. "#133 결정과 묶인다" 처럼 팝업만으로는 알 수 없는 말도 쓰지 않는다
  - AskUserQuestion 으로 물을 때도 같다 — 훅은 질문 · 선택지 설명을 그대로 옮길 뿐이라 배경은 질문 글(`question`)과 선택지 설명(`description`)에 직접 쓴다
- **고르기 질문은 Claude `AskUserQuestion` · Codex `request_user_input` 으로** — 위임 에이전트 세션은 `scripts/hooks/ask-to-request.py`(PreToolUse)가 두 도구의 `questions` 를 잡아 질문마다 `question` 요청을 열고(계획서 = pane 기록(`state/pane-sessions/<pane>.json`)을 먼저 · 없으면 `ATHENA_PLAN`, pane = 부른 pane · 추천 `(Recommended)` 표시 · 설명 포함) 도구는 막는다. 답은 평소처럼 `[요청 <id>] … 답:` 으로 오니 받자마자 `request ack`. 여러 개 고르기(multiSelect)는 단일 선택 + 메모, 선택지 미리보기는 본문 끝, 직접 입력(Other)은 팝업의 메모칸이 맡는다. **아테나 pane** 은 본체 `.claude/settings.json` · `.codex/hooks.json` 의 같은 훅(`ask-to-request.py lead`)이 맡는다 — 사용자가 그 pane 을 안 보고 있으면(화면 계층 `pane get` 의 `focused` 가 거짓) 에이전트처럼 요청으로 바꾸고 도구는 막는다. **보고 있거나 포커스를 모르면 pane 의 고르기 창은 그대로 두고 [작업] 에도 같이 올린다**(막으면 보던 사람이 바로 못 고른다) — 뒤에서 도는 지킴이(`scripts/lib/pane_request.py close`)가 pane 에서 고르면 요청을 저절로 거두고, [작업] 에서 먼저 고르면 답은 pane 창이 닫힌 뒤에 들어간다(창이 떠 있는 동안 현황판은 글을 넣지 않는다 — `pane-delivery.mjs`). pane 을 모르면 올리지 않는다. 계획서가 없는 대화면 계획서 없는 요청으로 열리고, 답은 같은 `[요청 <id>] … 답:` 으로 그 pane 에 오니 받자마자 `request ack`. 요청을 열지 못하면 막지 않고 원래 고르기 창이 뜬다(이유는 팩 데이터 `state/events.jsonl` 에 `request-hook-failed` 로 남고 에이전트에게도 알린다)
- **권한 확인 창은 알림으로** — Claude Code 가 "Do you want to make this edit…", Codex 가 "Would you like to run the following command?" 처럼 사람에게 허용을 물으면(1 Yes / 2 Yes, always / 3 No) `scripts/hooks/permission-to-request.py`(PermissionRequest · 모든 위임 에이전트 + 아테나 pane `lead`)가 그 pane 에서 "허용 확인 대기" 요청을 연다. 허용 규칙 · 자동 허용 도구는 이 훅까지 오지 않아 안 뜨고, 창이 4초 안에 닫혀도(자동 허용 등) 열지 않는다. 같은 pane 은 요청 하나(`--key perm:<pane>`)를 고쳐 쓴다. 글에는 묻는 일 한 줄(명령 · 파일 경로 — 비밀값은 `mask.mjs` 로 가림, 파일 쓰기 내용은 싣지 않음)만 담고 선택지는 없다. **이 알림 경로에서는 허용 · 거부를 하지 않는다** — 답을 허용으로 바꿔 돌려주거나 pane 에 키를 대신 누르는 길은 만들지 않았다(잘못 허용될 수 있어서). [pane 으로 가기] 로 가서 그 창에서 고르면 요청은 저절로 닫힌다. 훅은 아무 결정도 돌려주지 않아 창은 그대로 뜬다
  - Studio는 훅이 아직 실행되지 않는 Codex 시작 신뢰창과 Browser 권한창도 기존 pane 읽기로 감지해 앱의 [작업]·트레이에 알린다. 화면 감지 알림은 앱 문맥에만 두므로 코어 `request list`에는 저장되지 않으며, 같은 pane의 훅 알림이 있으면 중복을 숨긴다. 알림 제목·설명·이동 버튼은 Studio 선택 언어(ko/en/ja/zh)를 따르고 화면 원문·명령·URL을 새 요청에 수집하지 않는다. 기존 수동 TUI나 시작 신뢰창에는 원래 승인 RPC 연결이 없어 직접 선택을 제공하지 않는다. 일반 질문 답변·재전송으로 우회하지 않으며, 원래 창의 경고와 범위를 읽고 직접 선택한다. 닫힌 화면 두 번 또는 pane 종료를 확인하면 앱 알림을 거두고 옛 코어 권한 알림도 취소한다. 읽기 실패는 닫힘으로 판단하지 않는다.
  - **새 Codex 공식 연결**: 앱 본체 새 실행·재개와 Codex 위임은 `scripts/codex-session.py`가 개별 app-server와 TUI를 전용 Unix 소켓으로 연결한다. `<팩 데이터>/state/codex-connections/<연결 세대>.json`은 소켓 위치와 pane·본체·세대만 보관하고 승인 원문·응답은 프로세스 메모리에만 둔다. 명령/파일/추가 권한과 공식 단일 질문과 MCP 단일 enum 폼의 지원 선택지는 [작업]에서 직접 고른다. 명령은 `availableDecisions`가 있으면 그 범위를 따르고 영구 규칙·네트워크 허용/거부의 원문 범위를 보존한다. 클릭 전 응답0, 원래 envelope ID로 정확히1회, 공식 resolved 뒤 성공이다. 일반 `request answer`·redeliver·PTY 입력은 사용하지 않는다. 종료/연결 교체/turn 완료/취소/중복 선택은 폐기한다. 시작 폴더 신뢰·훅 신뢰는 설치 CLI0.166의 ServerRequest에 대응 RPC가 없어 기존 이동 안내를 유지한다. 인증 URL·자유 입력/복합 폼도 원래 pane에서 처리하며 임의 응답을 만들지 않는다.
- **사용자가 대화로 답하면** — `bin/athena request answer <id> --by chat --text '<답 요약>'`(바로 delivered)
- **아테나가 에이전트 pane 의 질문에 대화로 대신 답하면** — 같은 명령을 아테나 pane 에서 부른다. 부른 pane(`scripts/screen self`)이 요청의 pane 이 아니면 묻던 pane 은 답을 못 본 것이라, 앱과 같은 `[요청 <id>] <제목> — 답: …` 한 줄을 그 pane 에 넣고 answered 로 둔다(에이전트가 ack → delivered). 넣지 못하면 `sent: false` · "넣지 못했다" 를 알리고 answered 로 남는다 — 앱 [작업] 의 다시 보내기로 보낸다. 출력의 `delivered · pane <id>` 는 상태와 묻던 pane 일 뿐 보냈다는 뜻이 아니다 — 보냈는지는 📨 줄(`--json` 이면 `sent`)로 본다(2026-11-02 pm5 — 예전에는 delivered 로만 바뀌고 쉬던 pane 에 아무것도 안 들어갔다)
- **답이 `[요청 <id>]` 를 달고 pane 으로 오면**(현황판 · 앱에서 답한 것) — 받자마자 `bin/athena request ack <id>`
- **더 묻지 않아도 되면** — `bin/athena request cancel <id> --reason '<이유>'`
- 결정 콘솔 요청은 `plan-html.mjs` · 현황판이 맡는다 — 손으로 열거나 닫지 않는다(`[요청 <id>] [작업계획서 결정사항 확정] …` 이 오면 평소처럼 `--decide` 로 확정하면 닫힌다)

## 아테나에게 보내지 못했을 때

에이전트가 아테나 pane 으로 넘길 일은 `scripts/lead-send.py <아테나 pane> '[<나> → 아테나] …'` 로 보낸다(위임 지시문이 알려 준다). 받을 수 없을 때 그 명령이 알아서 갈래를 탄다 — 소식이 반쯤 전달되거나 사라지지 않게(GitHub 이슈 #134):

| 아테나 pane | 하는 일 | 출력 |
|---|---|---|
| 받을 수 있다 | 바로 넣는다(`pane send-text … --enter` 와 같은 길) | `✅` |
| 살아 있는데 지금 못 받는다(질문 · 고르기 창 · 다른 전송 중 — 데몬이 글을 쓰기 전에 거절) | **요청을 열지 않고** 대기열에 둔다. 뒤에서 처리기가 2초마다 보다가 창이 닫히면 들어온 차례대로 넣는다. 앞에 미룬 글이 있으면 새 글도 뒤에 줄 선다 | `⏳` |
| 닫혔다(처음부터 · 기다리는 동안) | 지금 아테나 pane 을 골라 넣는다 — ① 계획서 `- Lead pane:` 줄의 pane 이 살아 있으면 거기 ② 아니면 떠 있는 아테나 pane(본체 루트의 Claude · Codex · `🤖` 이름 아님 — 현황판과 같은 기준)이 하나뿐이면 거기 ③ 여러 개면 사용자가 보고 있는(focused) 것이 하나일 때만 거기 | `✅` · `⏳` |
| 닫혔고 떠 있는 아테나 pane 이 없다 | 대기열에 두고, 아테나 pane 이 생기면 넣는다 | `⏳` |
| 닫혔고 아테나 pane 이 여러 개인데 하나로 못 골랐다 · 6시간 넘게 못 넣었다 · 옛 구조(팩 데이터 없음)에서 못 보냈다 | 아무 데나 넣지 않고 **기록만** — 계획서 결과 절에 글 그대로 한 줄 + `state/events.jsonl` `lead-send-unsent` | `⚠️` |
| 넣었는데 전송을 확인하지 못했다(timeout 등) | 글이 입력칸에 남았을 수 있어 다시 넣지 않고 **기록만**(위와 같다) | `⚠️` |

이 명령은 **요청을 열지 않는다** — [작업]에는 사람이 고를 것이 있을 때만 뜬다(2026-11-03 · 계획서 `plans/task/20261103-athena-studio-fe-에이전트가-아테나에-못-보낸-보고를-작업-질문으로-띄우지-않기.md`). 계획서도 없어 못 적으면 `❌`(글은 사건 기록에 남긴다).

- 기다리는 값은 기존 장치 그대로 — 2초마다 · 최대 6시간(`scripts/lib/pane_request.py` · 끝 알림 훅 `agent-done-notify.py` 와 같다). 대기열은 `<팩 데이터>/state/lead-send/` 파일이라 처리기가 꺼져도 남고 다음 보내기가 다시 띄운다
- 에이전트는 `⏳` · `⚠️` 에 따로 요청을 열지 않는다. 명령 자체가 실패(`❌` · 계획서에도 못 적었다)했을 때만 우회하지 않고 보낼 글을 계획서 Checkpoint(Blocked 또는 결과 절)에 그대로 적고 보고 끝에 한 줄 알린다
- 끝 알림 훅 · PR 자동 리뷰 알림(`docs/pr-auto.md`) · 현황판 지시(`scripts/board/pane-delivery.mjs`)는 각자 같은 방식으로 기다린다 — 이 명령은 에이전트가 손으로 보내는 길이다
- 시험 `test/lead-send-test.sh`

## 명령

`--json` 이면 마지막 줄 하나가 JSON(`{ ok, request }` · 목록은 `{ ok, requests }`), 실패는 `{ ok:false, error, message }` — `error` 는 `usage`(종료 2) · `not-found` · `conflict` · `stale` · `locked` · `contract-mismatch`. 스튜디오는 팩 명령처럼 `--contract` 를 붙인다.

| 명령 | 하는 일 |
|---|---|
| `request open --kind decision\|question --title <글> [--body <글>\|--body-file <파일>] [--option '<라벨>[ :: <설명>]' …] [--recommend <라벨>] [--plan …] [--html …] [--issue …] [--pane <id>] [--key <키>]` | 연다. `--pane` 이 없으면 부른 pane(`scripts/screen self`) · 화면 밖이면 포커스된 pane(`scripts/screen pane current`) |
| (`--kind decision` 인데 `--html` 이 없으면) | decision 그대로 열고 앱이 질문과 같은 선택지 화면으로 답을 받는다 |
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

- 선택 창은 `pane get/list`의 `agent_status: waiting`으로도 확인한다(데몬 코드 6). 최근 출력이나 `esc to interrupt` 작업 표식보다 먼저 판정한다. 현황판·메뉴 막대·모니터·작업 공간은 입력 대기로 표시하고, pane 재사용·자동 닫기는 idle일 때만 한다. 끝 알림은 받는 pane이 waiting이면 미뤘다가 창이 닫히면 전달하며, 보낸 쪽에서 새 입력이 오면 옛 알림은 버린다.
