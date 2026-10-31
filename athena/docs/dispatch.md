# 디스패치 프로토콜

> 아테나가 에이전트를 띄우기(`scripts/delegate.sh`) **전에** 읽는다. 2026-10-29 늘 실리던 `.claude/rules/dispatch-protocol.md` 에서 옮겼다(뜻은 그대로 · 매번 지킬 요지는 `CLAUDE.md` 3단계).

## 전제
**모든 디스패치는 계획서 하나에 묶인다.** 사용자가 정할 것이 있거나 여러 레포·담당을 맞춰야 하면 정식 계획서(md + html 결정 콘솔, 결정은 콘솔의 [이대로 진행] 으로 확정)를 승인받은 뒤, 아니면 경량 계획서(`plans/task/…`, `docs/plan-template-light.md`)로 — 경량판은 사용자 지시가 곧 승인이다. **계획서 없이 디스패치하는 예외는 없다.** `scripts/delegate.sh` 는 `--plan <경로>` 또는 `--plan new "<요약>"` 없이는 띄우지 않는다

## 디스패치 전에 — 작업 브랜치부터

`scripts/new-branch.sh <티켓> <대상...>` 으로 작업 브랜치·워크트리를 만들고 시작한다(절차 `docs/knowledge/common/git.md` "작업 브랜치 만들기"). 로컬 트리는 브랜치가 제각각이라 확인 없이 보내면 남의 작업 브랜치나 미커밋 변경 위에 얹힌다. base 는 `athena.config.json` 의 `prBase`(개발 브랜치)이고 문서 기준(`branch`, 운영 반영분)과 다르다.

기본이 **워크트리**(`.worktrees/<레포>/<슬러그>`)라 메인 체크아웃을 건드리지 않는다. 레포가 지저분해도 시작할 수 있고 여러 작업을 동시에 돌릴 수 있다. 만든 경로로 `scripts/delegate.sh <에이전트> --cwd <워크트리> --plan <계획서>` 한다. **건너뛴 레포에는 디스패치하지 않는다.**

## 방식
**배치**: workspace = 레포 / 그 안의 **한 탭에 pane 을 나란히**.

- 담당 레포의 workspace 를 `label` 로 찾아 없으면 만든다. 그 workspace 의 활성 탭에 pane 을 덧붙인다
- **워크트리마다 탭을 가르지 않는다.** 한 화면에서 동시 작업 상황이 다 보이는 쪽이 낫다
- 각 pane 은 `🤖 <에이전트> · <브랜치>` 로 이름이 붙는다. 브랜치는 **에이전트가 만질 레포**에서 읽으므로 나란히 놓여도 어느 작업인지 이름만 보고 안다
- 담당 레포가 없는 에이전트(`reviewer`)나 단발 조사는 `--here` 로 지금 탭에서 쪼갠다. 워크트리 작업을 리뷰할 때는 `scripts/delegate.sh reviewer --cwd <워크트리> --here --plan <리뷰할 계획서>` — 그래야 검증 스크립트가 워크트리를 본다
- **레포를 넘는 작업은 순차로 보낸다.** 공유 패키지를 먼저 끝내고 그 결과를 소비 레포 에이전트에 넘긴다. 두 workspace 를 동시에 띄우지 않는다
- 어느 workspace·탭에 띄웠는지 사용자에게 한 줄 알린다

**기본은 보이는 pane**: `scripts/delegate.sh <에이전트명> --plan <계획서>` 으로 화면(Athena Studio) pane 에 `claude --agent <이름>` 세션을 띄운다(사용자가 진행 과정을 볼 수 있다). **프롬프트 없이 열어 그 pane 안에서 작업을 지시하는 것이 기본**이다 — 대화를 이어가며 범위를 좁힐 수 있다. 한 번에 끝나는 조사라면 두 번째 인자로 프롬프트를 실어 보낸다. 워크트리에서 작업하면 `--cwd <경로>`. 여러 에이전트를 병렬로 보낼 때는 pane 을 여러 개 연다. 결과는 `scripts/screen pane read <id>` 로 읽고, 완료 대기는 `scripts/screen pane wait-output <id> --match <글자>` 또는 사용자에게 알린다. **reviewer 결론은 pane 이 아니라 `scripts/review-wait.sh --plan <계획서> --dir <트리>` 로 기다린다** — reviewer 를 띄운 직후 부르면 계획서의 `- Review result:` 줄이 새로 적힐 때 그 줄을 출력하고 끝난다(끝난 reviewer pane 은 1분 뒤 저절로 닫히고, 그 줄은 새로 더해지지 않고 바꿔 써진다 — pane 화면·줄 수를 기다리는 반복을 직접 짜지 않는다)(pane 은 화면 계층 `scripts/screen` 으로만 다룬다 — 데몬 CLI 를 직접 부르지 않는다).

부득이 Agent 도구(백그라운드, `subagent_type`)를 쓸 때는 `scripts/monitor-pane.sh`(사용자는 `/monitor`) 를 부른다. Athena Studio 화면이면 pane 을 띄우지 않는다(앱 아래 AGENT MONITOR 칸이 실시간 로그를 보여 준다 — 알릴 pane 도 없다). 화면 밖이면 직접 실행할 명령을 알려 준다.

레포 → `subagent_type` 표는 팩 `pack/ROUTING.md` "에이전트"(기계 정본 `pack.json` repos[].agents · 모노레포 apps[].agent · packagesAgent). 교차 리뷰(읽기 전용)는 `reviewer`.

모노레포(`kind: monorepo`)는 한 레포지만 앱마다 에이전트가 다르다. 같은 레포의 두 앱을 동시에 디스패치할 때는 **서로 다른 파일만 만지는지**(공통 `packages/**` 는 packagesAgent 단독, 앱 작업용 루트 `package.json`·lockfile 은 그 앱 에이전트 — 앱마다 브랜치·워크트리가 다르면 겹치지 않는다. 한 워크트리에 두 앱이면 루트는 한 에이전트만) 계획서에서 확인한 뒤 병렬로 보낸다. 발행 패키지 레포(`kind: packages`) 변경이 소비 레포 작업과 함께 필요하면 그 담당을 **먼저** 끝내고 버전·스냅샷 태그를 소비 측 에이전트에 넘긴다(회사별 세부 순서는 팩 `ROUTING.md` "순서 규칙"). 백엔드와 프론트가 함께 바뀌면 `*-be` 를 **먼저** 끝내고 그 보고의 "계약 변경"(엔드포인트·필드·하위 호환)을 프론트 에이전트에 넘긴다.

서로 독립적인 서비스 작업은 **한 응답에서 동시에 호출**해 병렬로 돌린다. 무거운 명령(install·build·dev·tsc·test)은 에이전트가 `scripts/heavy.sh` 로 한 대에 2개까지만 돌리므로(AGENTS.md 5절) 병렬로 띄워도 된다 — 아테나가 직접 무거운 명령을 돌릴 때도 같다.

## 이어 보내기 — 쉬는 같은 레포 pane 이 있으면 새로 띄우지 않는다

작은 수정마다 계획서 · 브랜치 · pane 을 새로 띄우면 토큰이 많이 든다(2026-10-30 홈페이지 수정). 디스패치 전에 한 번 확인한다.

```bash
node scripts/reuse-pane.mjs --agent <에이전트>   # 쓸 수 있으면 {"pane","cwd","branch"} · 없으면 이유(stderr)와 exit 1
```
고르는 기준은 모두 맞아야 한다 — 이름표가 `🤖 <에이전트>`(에이전트는 레포마다 하나라 같은 레포) · `agent_status` idle · 사용자가 보고 있지 않음(focused 아님) · 화면 끝에 질문·고르기 창이 없음(데몬 idle 은 질문 기다리는 것도 idle 이라 화면을 읽어 따로 본다) · 화면을 읽을 수 있음. 하나라도 모르면 지금처럼 새로 띄운다.

- **보내기**: `scripts/delegate.sh <에이전트> --plan <새 계획서> --reuse-pane <pane> ["<요청>"]`. 새 pane · 실행기를 만들지 않고 짧은 지시(새 계획서 경로 · 리뷰 규칙 · 요청)를 그 pane 에 한 줄로 넣는다. 처음 받은 긴 지시(커밋 · PR · 보고 규칙)는 그 pane 에 이미 있다. 보내기 직전에 `reuse-pane.mjs` 를 다시 돌려 같은 pane 이 아니면 보내지 않는다
- **브랜치**: 앞 PR 이 아직 열려 있으면 같은 브랜치에 이어 쓴다(`--new-branch` 없음). 머지됐으면 `--new-branch <이름>` — 같은 워크트리에서 `git switch -c <이름> origin/<prBase>`. 미커밋 변경이 있으면 거부한다(앞 작업을 먼저 끝낸다). main 직접 레포는 새 브랜치를 따지 않는다
- **계획서**: 같은 작업의 추가 요청이면 그 계획서에 이어 쌓는다(새로 만들지 않고 pane 에 그냥 보낸다). 다른 작업이면 새 경량 계획서를 만들어 `--reuse-pane` 으로
- **묶음**: 보낼 때 delegate.sh 가 ① 새 계획서 Work ref · Lead pane 을 적고 ② pane 기록(`state/pane-sessions/<pane>.json`)의 `plan` 을 새 계획서로 바꾸고 처음 환경 값을 `envPlan` 에 남기며(훅 `pane-session.py` 가 매 메시지마다 처음 환경 값으로 되돌리지 않는다) ③ 앞 계획서 Work ref 에서 `· pane <id> (<에이전트>)` 를 뗀다. 그래서 끝난 앞 계획서가 이 pane 이 일한다고 다시 진행 중으로 돌아가지 않는다. 자동 완료는 pane 상태를 보지 않고 PR · Progress 로 판정하니, **열린 PR 을 같은 브랜치로 이어 쓰는 두 계획서**는 한쪽이 먼저 끝나지 않게 Progress 를 같이 본다
- reviewer 는 이어 보내지 않는다(리뷰마다 새 pane). 시험 `test/reuse-pane-test.sh`

## 프롬프트 필수 포함 사항
- 승인된 계획서 경로 (`plans/유형/YYYYMMDD-제목.md`)
- 해당 에이전트가 담당할 작업 범위 (계획서의 작업 배분표 중 자기 행)
- 관련 파일 경로 (파악된 경우)
- 사용하는 API 엔드포인트·응답 타입 (신규/변경이 있으면 spec 그대로)
- 다른 서비스 작업과의 연관성 (공통 UI 패턴 맞추기 등)
- "커밋은 사용자 요청 시 `scripts/commit.sh` 로만·push/PR 은 요청 시 `scripts/ship.sh` 로만(레포 하나짜리)", "담당 레포 밖 수정 금지" 리마인드

### 지시문은 되풀이하지 않는다 (`delegate.sh` `PLAN_HEADER`)
`delegate.sh` 가 지시 맨 앞에 박는 머리말은 **스크립트 경로 · 절차 · 5절 원칙**만 싣는다 — 계획서 읽기 · Status/Progress/Validation 채우기 · `commit.sh` · `ship.sh` · 자동 리뷰 예외 · 결정 콘솔 절차 · "PR 올려줘" ①~④ · "추측으로 구현하지 않는다" · "범위가 커지면 멈춘다" · "버그는 재현부터". AGENTS.md 5 · 6절(커밋 · push 직접 금지 · 보고 순서 · 시키지 않은 것 안 더함 · 비밀값 · `heavy.sh`)과 `.claude/rules/*.md` 는 `scripts/agent-context.py` 가 `--append-system-prompt-file` 로 이미 모든 위임 에이전트(reviewer 포함)에 싣는다 — 머리말에 같은 문장을 다시 넣지 않는다(2026-10-31 2단계 빠른 길에서 뺐다 · 지시문이 길면 에이전트가 앞부분을 놓친다). 경량 · 정식 구분 없이 같은 머리말. 바꾸면 `scripts/screen-check/check.sh --record` 로 golden(`delegate_outside` · `studio_delegate_outside`)을 다시 쓰고 diff 가 그 문장뿐인지 본다

## 결과 수신
- **끝 알림 — 기다리는 루프를 걸지 않는다.** 위임 에이전트(reviewer 제외)가 한 차례(턴)를 끝내면 Stop 훅(`scripts/hooks/agent-done-notify.py`)이 계획서 Checkpoint 의 `- Lead pane:`(아테나 pane)에 `[<에이전트> → 아테나] 끝 · <pane> · 계획서 <경로> · Status <값> · PR #<번호> <상태>`(PR 은 있을 때만) 한 줄을 입력한다. `pane get` 의 `agent_status` 를 `until` 로 기다리는 루프는 일하는 중에 일찍 풀리거나 끝을 놓쳐 사용자가 물어야 알게 됐다 — 이 알림을 받으면 그 pane 의 계획서 · 결과를 읽고 다음 일을 한다. 아테나 pane 이 없거나 닫혔으면 알림은 조용히 건너뛴다(그때는 `scripts/screen pane list` 로 본다)
- 같은 줄은 사용자 입력이 새로 오기 전에는 다시 가지 않는다. **알림에 답해 에이전트에 글을 보낼 때는 `[아테나 → <에이전트>] 끝 알림 확인 — …` 로 시작한다** — 그 입력으로 시작한 차례는 다시 알리지 않는다(알림만 오가는 왕복 방지). 새 일을 맡기는 글에는 "끝 알림" 이라는 말을 쓰지 않는다
- 에이전트 pane 은 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` 로 뜬다(다음 말 추천 — 입력 칸의 흐린 글 — 끔). 끝난 pane 입력 칸에 남은 글을 사용자가 쓰다 만 글로 오인하지 않게. 사람이 쓰는 아테나 세션은 그대로

## 결과 수신 후
- 에이전트 보고에서 변경 파일 목록, 검증 명령 결과(lint/typecheck/test), 남은 위험을 확인
- 검증 실패나 범위 밖 수정 필요 사항은 사용자에게 그대로 전달 (숨기지 않음)
- 리뷰 수정 필요·다음 레포에 넘길 계약 변경처럼 승인된 범위 안의 후속 지시는 묻지 않고 그 pane 에 직접 보낸다(`scripts/screen pane send-text <pane> '<글>' --enter`) — 사용자를 전달 창구로 쓰지 않는다
- 에이전트가 막혀 넘긴 요청(`[<에이전트> → 아테나]` — 보호 훅이 막은 merge, 여러 레포 작업의 push·PR)은 사용자 지시가 담겨 있으면 아테나가 처리하고 결과를 그 pane 에 돌려준다
- 여러 서비스에 걸친 작업은 `reviewer`로 교차 정합성 확인
