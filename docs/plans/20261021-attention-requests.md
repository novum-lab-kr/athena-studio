# 현황판 개편 — "내 판단이 필요해요" 를 명시적 요청으로

## Checkpoint
- Updated: 2026-10-21 / Claude — 결정 확정
- Status: in_progress
- Owner: Mason
- Scope: athena-studio — 코어 `athena/` + 앱 `src/`
- Work ref: main 50190f2
- Approved scope: 방향(입구는 앱 · 현황판은 판단 근거와 응답 · 명시적 요청)은 2026-10-21 대화에서 승인. 결정 D1–D5 는 2026-10-21 결정 콘솔로 확정(모두 추천안)

### Progress
- [x] 현황 조사 · Codex 논의(진단 · 방향 · 순서 합의)
- [x] 결정 D1–D5 확정 — 모두 추천안
- [x] 1단계 — 요청 약속 · 코어 명령 · 아테나 규칙
  - `athena/scripts/lib/requests.mjs` · `bin/athena request open|list|show|answer|ack|cancel` · `plan-html.mjs` 가 계획서마다 decision 요청을 열고 닫음 · `docs/requests.md` · `AGENTS.md` 5절 · `CLAUDE.md` · `docs/pack.md` · `.gitignore`(`/.requests`)
  - 설계 조정 ①: 자리는 팩 데이터 **`state/requests/`** — 고정 링크(`FIXED_LINKS`)를 늘리면 기존 본체가 모두 "링크 고치기 필요"가 된다
  - 설계 조정 ②: 백업 · 내보내기에 **담지 않는다** — pane · 세대에 묶인 상태라 되살려도 뜻이 없고, 결정 내용은 계획서에 남는다(필요하면 다시 더한다)
  - 설계 조정 ③: 결정 콘솔 요청은 결정마다가 아니라 **계획서마다 하나**(`plan:<경로>`) — [이대로 진행] 이 한 번에 보내는 단위와 같게
- [x] 시안 — 앱 팝업으로 방향 바꿈(5절 머리말) · spaces `?` 뺌
- [x] 2단계 — 앱이 데이터를 받기(요청 폴더 감시 + 30초 · CONTRACT 는 올리지 않음 — 옛 코어는 요청 없음)
- [x] 3단계 — [작업] 버튼(점만 · 숫자 없음 — 사용자) · 목록 · 상세 · 답하기 · 현황판 메뉴 · 트레이 확인 필요 = 요청만 · 새 요청 맥 알림
- [x] 4단계 — 앱 답 → pane 에 [요청 <id>] · 결정 콘솔 [이대로 진행] 이 답 기록(50190f2)
- [ ] 5단계 — 남은 흔적 정리

### Next
1. 5단계: `main.js` `openUrl({fromBoard})` · `ui:tab 'board'` · `renderer.js:1` 주석 정리
2. 메뉴 막대가 보지 않는 창의 새 요청도 맥 알림
3. 데몬 통합 시험 시간 초과(main 에서도 남) 원인 보기

### Blocked
- 없음

### Validation
- 1단계: `test/requests-test.sh` 27/27 · `test/packs-test.sh` 95/95 · `scripts/screen-check/check.sh` 35/35(plan_html · studio_plan_html golden 에 요청 줄 추가 · 요청 번호는 `r-<ID>` 로 고정) · `screen-lint` · `path-lint` 통과. `bodies-test` · `bundle-test` 는 안 돌림(본체 · 번들 코드는 안 건드림)

### Decisions
- D1 팩 데이터 `requests/` · D2 코어 명령 `athena request list --json` · D3 결정 콘솔 + 질문 · D4 pane 입력 + 요청 번호 · ack 로 닫기 · D5 트레이 "확인 필요" 는 요청만 — 상세 3절

## 1. 개요
- 작업 유형: feature (여러 단계)
- 요청 사항: 현황판이 내용 · 코드 · 디자인 모두 불편해 잘 안 보게 된다 → 다시 쓴다
- 진단(Claude · Codex 공통, 코드 근거 — 실제 사용 관찰로는 아직 확인 안 함)
  - 칸반은 에이전트가 옮기고 일은 pane 에서 끝난다 → 현황판은 이미 아는 걸 다시 읽는 곳
  - 카드 순서는 파일 mtime, 칸은 업무 단계와 터미널 상태(working 이면 진행 중으로 덮음 — `server.mjs:723`)가 섞임
  - 사람 판단이 필요한 화면(결정 콘솔 · QA 승인 · 학습)이 흩어져 있다
  - 브라우저 탭은 일부러 열어야 한다 — 밀어 주지 않으면 안 연다
  - "사람 차례"를 상태 글자로 추측한다(트레이 `tray-model.js:55` — blocked pane + blocked 카드 중복 · `ready_for_review` 를 승인 대기로 해석)
- 방향: **입구는 앱(탭 줄 배지 · pane 표시 · 맥 알림), 현황판은 판단 근거를 보고 답하는 곳.** 그 바탕은 **명시적 요청** — 아테나가 사람 판단이 필요할 때 요청을 남기고, 답하면 닫힌다. 상태 추측은 버린다
- 사용자 결정 사항
  - D1 요청 저장 자리: **팩 데이터 `requests/`**
  - D2 앱이 요청을 읽는 길: **코어 명령 `athena request list --json`**
  - D3 처음 다룰 요청 종류: **결정 콘솔 + 질문**
  - D4 답 전달: **pane 입력 유지 + 요청 id 로 받음 확인**
  - D5 트레이 "확인 필요" 세기: **요청만**

## 2. 현재 상태
- 현황판 서버 `athena/scripts/board/server.mjs`(1790줄) · 화면 `index.html`(2170줄 단일 파일) · 3초 폴링 → SSE
- 결정 콘솔: 정식 계획서의 `.html`(`plan-html.mjs` · `PLAN.decisions[]` · `leadPane`) → [이대로 진행] 이 `/api/action` → `sendToPane`(`server.mjs:880`)으로 pane 에 글자를 친다. 보낸 뒤 결과를 기록하지 않는다
- 질문: 아테나 규칙(`athena/CLAUDE.md:25`)은 "모르면 Blocked 에 적고 모아서 한 번에 묻는다" — 대화로만 묻고 남는 기록은 계획서 Blocked 줄뿐
- 앱 알림: `tray-model.js` `Notifier` 가 pane 상태 변화 · 카드 상태 변화로 맥 알림(`main.js:2156`), 클릭하면 pane 포커스 또는 계획서 html. 카드는 현황판 `/api/state` 를 15초마다(`main.js:2007`) — **현황판 서버가 꺼져 있으면 카드 정보가 없다**
- 팩 데이터 링크: `packs.mjs` `FIXED_LINKS`(plans · issues · repos · .worktrees · state/…)
- 현황판 `collect()` 는 보기만 하지 않는다 — PR 머지 자동 완료(`autoDonePlans` `:361`) · 학습 대기열 넣기 · Jev 학습 점검. 서버를 줄이거나 끄면 이것도 멈춘다

## 3. 결정 사항

### D1 요청 저장 자리
- **A. 팩 데이터 `requests/<id>.json`, `FIXED_LINKS` 에 `requests` 추가 (추천)** — 팩마다 따로 · pane 이 닫히거나 데몬이 다시 떠도 남는다. `backup --with-work` · `restore` · `import-athena` 는 plans · issues 처럼 담고, `export`(팀 공유)는 뺀다
- B. 본체 `state/` 아래 — 링크 추가가 없지만 팩 백업 · 옮기기에서 빠진다
- C. 데몬 메모리 + 프로토콜 요청 — 빠르지만 데몬이 다시 뜨면 사라지고 PROTOCOL 을 올려야 해 pane 이 닫힌다

### D2 앱이 요청을 읽는 길
- **A. 코어 명령 `athena request list --json` (추천)** — 현황판이 꺼져 있어도 된다. 앱은 파일 형식이 아니라 명령 출력에 묶인다(팩 명령처럼 `CONTRACT` 로 맞춘다). `requests/` 를 `fs.watch` 로 보다가 바뀌면 부르고, 놓칠 때를 대비해 30초마다 한 번
- B. 현황판 `/api/state` 에 실어서 — 지금 트레이와 같은 길이지만 서버가 꺼지면 배지가 빈다
- C. 앱이 파일을 직접 읽기 — 가장 빠르지만 형식이 코어 · 앱 두 곳에 박힌다

### D3 처음 다룰 요청 종류
- **A. 결정 콘솔 + 질문 (추천)** — 결정 콘솔은 이미 화면 · 전달 경로가 있어 옮기기 쉽고, 질문은 "모아서 묻기" 규칙(`dc34c00`)을 기록으로 남긴다
- B. 결정 콘솔만 — 가장 작다. 질문은 대화에만 남는다
- C. + QA 기준 승인까지 — QA 쪽 흐름까지 바꿔 1단계가 커진다(4단계로 미루는 게 낫다)

### D4 답 전달
- **A. 지금처럼 pane 에 입력 + 요청 id 를 붙이고, 에이전트가 `athena request ack <id>` 로 받았다고 닫는다 (추천)** — "답함"과 "전달됨"이 갈린다. 전달이 실패하면 `answered` 로 남아 다시 보낼 수 있고, 같은 id 로 두 번 와도 에이전트가 무시한다
- B. 답 저장만 하고 에이전트가 요청을 주기적으로 읽기 — pane 입력이 없어 깔끔하지만 에이전트가 쉬는 동안은 못 받는다
- C. 지금처럼 입력만, 기록 없음 — 이번 문제를 그대로 둔다

### D5 트레이 "확인 필요"
- **A. 요청만 센다 (추천)** — blocked pane 알림은 "에이전트 상태"로 따로 두고, `ready_for_review` · blocked 카드는 "확인 필요"에서 뺀다. 숫자를 믿을 수 있게
- B. 요청 + 지금 추측을 같이 — 놓치는 건 적지만 중복 · 오탐이 남는다

## 4. 요청 형식 (D1 · D3 · D4 추천 기준 초안)
```json
{
  "format": 1,
  "id": "r-20261021-1530-a1b2",
  "kind": "decision | question",
  "title": "한 줄 — 무엇을 정하는지",
  "body": "자세히 · 근거(마크다운)",
  "options": [{ "id": "A", "label": "…", "recommended": true }],
  "links": { "plan": "plans/feature/…md", "html": "plans/feature/…html", "issue": null },
  "pane": "<만든 pane id — 이동 힌트일 뿐 · 보낼 때 다시 확인>",
  "pack": "<팩 id>", "generation": 3,
  "dedupeKey": "plan:<경로>:D2",
  "state": "open | answered | delivered | cancelled | expired",
  "rev": 4,
  "createdAt": "…", "answer": { "choice": "A", "text": "", "at": "…", "by": "board | app | chat" },
  "deliveredAt": null
}
```
- 쓰기는 코어 명령으로만: `athena request open|answer|ack|cancel|list|show [--json]` — 잠금 + 원자 저장 + `rev` 검사(에이전트 취소와 사용자 답이 서로 덮지 않게)
- 같은 `dedupeKey` 로 열린 요청이 있으면 새로 만들지 않고 고친다
- 팩 세대가 바뀐 뒤(`generation`) 온 답은 거절 — 현황판 쓰기의 409 와 같은 규칙

## 5. 단계

> **2026-10-21 방향 바꿈(시안 검토 뒤)** — 현황판 **첫 화면을 없애고** 앱 작업 창의 팝업이 맡는다. 시안: `docs/plans/20261021-attention-requests-mockup.html`
> - 탭 줄 **[작업 N · 기다림 M]** 버튼 → 작업 목록 팝업(나를 기다리는 것 · 진행 중 · 최근 끝난 것) → 작업 상세 팝업(왜 · 정한 것 · 진행 · 검증 · 결과 · 다음) / 질문이면 **앱 안에서 바로 답하기**
> - 현황판 아이콘 → 메뉴(QA · 학습 · 아카이브 · 전체 칸반) — 고르면 지금처럼 브라우저 페이지
> - 현황판 **서버는 그대로** 뒤에서 돈다(자동 완료 · 학습 대기열 · 트레이 · 팝업 데이터)
> - spaces 목록에는 `?` 를 넣지 않는다(사용자 결정) · 결정 콘솔(정식 계획서)은 지금처럼 브라우저

### 1단계 — 약속 · 코어 명령 · 아테나 규칙 (코어) — 끝
- 위 Progress 참고

### 2단계 — 앱이 데이터를 받기
- 앱 `src/lib/requests.js`(요청 출력 해석 · 정렬) + `test/requests.test.js` · 창 `ctx` 마다 팩 데이터 `state/requests` 감시 → `athena request list --json`(놓칠 때 30초마다)
- 작업 목록: 현황판 서버 `/api/state` 의 계획서 카드(트레이가 이미 읽는 것)를 목록 · 상세 모양으로 — `src/lib/work-model.js` + 테스트. 상세에 필요한데 `/api/state` 에 없는 것(왜 · 정한 것 · 다음)은 서버 `/api/card` 또는 계획서 Checkpoint 를 읽는다 — 만들 때 확인
- 팩 명령 `CONTRACT` 2 → 3(`request` 명령이 생겼다): `src/lib/pack.js` · `bodies.mjs` · `scripts/fake-pack.js`(가짜 요청 · 작업 몇 개) · `test/pack.test.js` · `pack.md`

### 3단계 — 화면
- 탭 줄 [작업] 버튼 · 작업 목록 팝업 · 상세 팝업 · 답하기 팝업 — 기존 앱 팝업 틀(d7ab6c0) · 문구 네 언어(`src/i18n/*.json`, `test/i18n*.test.js`)
- 현황판 아이콘 → 메뉴(QA · 학습 · 아카이브 · 전체 칸반) · ⌘2 는 메뉴 열기로
- 맥 알림: 새 요청 한 번(창이 여럿이어도 한 번) → 누르면 답하기 팝업 · 트레이 "확인 필요" = 요청만(D5) · `tray-model.js` 정리
- README "화면"

### 4단계 — 답 전달
- 앱에서 답 → `athena request answer --by app` → 그 pane 에 `[요청 <id>] <답>` 입력(pane 이 없으면 answered 로 남고 목록에 [다시 보내기]) → 에이전트가 `ack` → 목록에서 빠짐
- 결정 콘솔 [이대로 진행] 도 같은 길로(현황판 서버 `/api/action` 이 answer → 전달)

### 5단계 — 현황판 정리
- 현황판 첫 화면(서비스 탭 칸반)은 "전체 칸반" 페이지로 남기고 기본 주소는 메뉴가 고르는 페이지로 · QA · 학습 · 아카이브는 그대로
- `index.html` 모듈 나누기는 이번 범위에서 뺀다(첫 화면을 안 쓰니 급하지 않다) — 필요해지면 따로
- 남은 흔적 정리: `README.md:46` · `main.js` `openUrl({fromBoard})` · `ui:tab 'board'` · `renderer.js:1` 주석

## 6. 위험
- 현황판 서버를 줄이거나 끄면 자동 완료 · 학습 대기열도 멈춘다 — 4단계 전까지 서버 시작 방식은 그대로
- 요청을 아테나가 안 쓰면 배지가 비어 "조용하다"로 오해한다 — 1단계에서 결정 콘솔 요청은 `plan-html.mjs` 가 자동으로 연다(규칙에만 기대지 않는다)
- 오래 열린 브라우저의 답이 다른 팩 · 재사용된 pane 으로 가면 안 된다 — 세대 검사 · 보낼 때 pane 다시 확인
- 요청이 쌓이면 이슈 56개 때와 같다 — 만료(예: 계획서가 done · 아카이브되면 그 요청 자동 `expired`)
- 개발 앱과 배포판이 같은 스튜디오 집을 쓴다 — CONTRACT 를 올리면 옛 앱이 새 코어에 붙을 때 `contract-mismatch`

## 7. 검증 방법
- 각 단계: `[단계] → 확인: [방법] → 성공 조건`
  - 1 → `requests-test.sh` → 열기 · 같은 키 중복 없음 · rev 충돌 거절 · 다른 세대 답 거절 · ack 후 `delivered`
  - 2 → 격리 실행(`ATHENA_STUDIO_HOME=<임시>`)에서 현황판을 끈 채 요청 열기 → 앱이 목록을 받음 · 결정 콘솔 답 → 요청 `delivered`, pane 이 없으면 `answered` 로 남고 다시 보내기
  - 3 → 요청 열기 → 배지 · 맥 알림 한 번 · 클릭 → 상세 · 창 두 개여도 알림 한 번
  - 4 → 첫 화면에서 요청 · 진행 중 · 최근 결과만 · 자동 완료가 계속 도는지(PR 머지된 계획서 → done)
- 성공 기준(쓰면서): 요청을 알아차리고 답하기까지 걸린 시간 · 중복 알림 · 전달 실패 수
