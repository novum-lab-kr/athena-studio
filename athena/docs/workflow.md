# 아테나 작업 흐름 — 자세히

> `CLAUDE.md` "작업 흐름" 이 매번 지킬 요지이고, 이 문서는 단계마다의 자세한 판이다(2026-10-29 `CLAUDE.md` 에서 옮김 — 뜻은 그대로). **읽을 때**: 그 단계를 처음 하거나 헷갈릴 때 · 현황판 자동 완료 · 보관 · 학습이 왜 그렇게 움직이는지 볼 때 · 명령 설명이 필요할 때. 다이어그램 `docs/diagrams/athena-flow-{light,formal}.html` 카드도 이 내용이다 — 고치면 같이 고친다(`docs/diagrams/README.md`).

## 1. 요청 · 계획서
- **요청은 세 갈래로 들어온다.** ① 대화 — 담당자를 모르거나 여러 레포 · 기능 · 버그 원인 찾기면 그냥 말한다(아테나가 라우팅 · 계획서) ② `/call <에이전트>` — 담당자를 알 때. pane 을 먼저 띄우고 요청은 그 pane 에서 ③ 현황판 이슈 카드의 [작업 시작] — 기본은 아테나가 받아 처리한다(팝업에서 "담당 에이전트로 바로(조사만)" 도 고를 수 있다)
- sync · 리뷰 작업에서 찾았지만 그 자리에서 고치지 않은 것은 `docs/issues.md` "등록 기준"대로 — 보안 · 버그(high)만 바로 `issues/*.md`, 나머지는 "이슈 후보"로 보여 주고 사용자가 고른다
- 시작 줄: `📋 경량으로 진행합니다 — <이유> · <계획서 경로>`(정식으로 하려면 "정식으로") / `📋 정식으로 진행합니다 — <이유> · 결정 N개 · <경로>`. `/call` 은 경량으로 시작하고 브랜치를 물을 때 같은 줄을 붙인다
- 새 기능 · API · 구조 변경은 대개 정할 것이 있어 정식이 되지만, 이름이 아니라 "사용자가 정할 것이 있나 · 여러 레포 · 담당을 맞추나" 로 판단한다. 경량으로 하다 정할 것이 생기면 같은 작업을 정식으로 옮긴다(경량판에 그 경로)
- **정식** — `plans/{feature,bugfix,refactor}/YYYYMMDD-제목.md`(`docs/plan-template.md`) + 같은 이름 `.html` 결정 콘솔(`node scripts/plan-html.mjs` — `docs/plan-template.html` 복사, `PLAN.decisions[]` · `leadPane` · `plan-md`). 개요 다음에 **Checkpoint**(Status / Work ref / Progress / Next / Blocked / Validation / Decisions / Commits)
- **경량** — `plans/task/…md` 하나(`scripts/new-plan.mjs`, `docs/plan-template-light.md`). 사용자 지시가 곧 승인

## 2. 사용자 승인
- 정식: 결정 콘솔을 **현황판 주소로 연다**(`scripts/board.sh open <md>` — 현황판이 꺼져 있으면 띄운다). 대화에는 `.md` 경로와 결정마다 제목 · 추천 한 줄씩만(자세한 비교는 콘솔). 사용자가 **[이대로 진행]** 을 누르면 결정이 그 계획서를 만든 아테나 pane(`PLAN.leadPane`)에 입력된다 → `.md` "사용자 결정 사항" · Checkpoint `Decisions` 와 html `decisions[].decided` 를 같은 턴에 채우고(`plan-html.mjs`) "✅ 확정" 한 줄. 대화로 답해도("추천대로", "D2 는 B") 같다. 보낼 수 없으면 콘솔이 [프롬프트로 복사] 로 바뀐다. 결정 콘솔의 요청("확인 필요" 에 뜬다)은 `plan-html.mjs` 가 열고 닫는다 — 따로 부르지 않는다
- 수정 요청이면 `.md` · `.html` 갱신 후 콘솔을 다시 열어 재승인

## 3. 작업 브랜치 → 디스패치
- 브랜치 · 워크트리 절차는 `docs/knowledge/common/git.md` "작업 브랜치 만들기"(`scripts/new-branch.sh` 가 `prBase` 에서 `.worktrees/<레포>/<슬러그>` 로). 브랜치가 이미 있으면(로컬 · 원격) 상태를 알려 주고 "그대로 이어 쓸까요?" → `--reuse`
- `/call` 은 띄우기 전에 아테나가 브랜치를 선택지로 묻고(최근 작업 브랜치 후보 · 새 브랜치 — `scripts/call-branch-info.sh`) 워크트리를 만든 뒤 `--cwd` 로 띄운다. 에이전트를 athena 루트에서 띄우면 pane 의 작업 폴더가 워크트리를 따라가지 못한다
- `delegate.sh` 는 계획서 경로를 지시 맨 앞에 넣고 Work ref 에 워크트리 · 브랜치 · pane 을 적는다. FE 세션 보호 훅: git commit · push · `gh pr create` 직접, `add -A` 차단(`commit.sh` · `ship.sh` 로만)
- 배치 · 프롬프트 구성 · 결과 수신은 `docs/dispatch.md`

## 4. 작업 · 커밋 (pane 에서 반복)
- 에이전트는 요청마다 시작할 때 Status `in_progress` 로 바꾸고 계획서 `## 지시` · Progress · 결과를 쌓는다. **스크립트가 적는 칸은 손대지 않는다** — Validation 한 줄(`- <시각> <레포> @<sha> 통과|실패 N (<범위> · <초>초) — <인자>`)은 검증 스크립트가(`ATHENA_PLAN` 이 있을 때 · 바로 위가 같은 레포 · sha · 결과면 안 적는다 · 이어 보낸 pane 은 지금 계획서로 · `reuse.sh` 재사용은 안 적는다), `in_progress` · `planned` → `ready_for_review` 는 `commit.sh` 가 커밋 뒤에(`plan.status` 사건도). 직접 바꾸는 것은 막힘(`blocked`) · 커밋 없이 끝남(`ready_for_review`) · PR 없이 끝나는 일(`done`)뿐 → 현황판 카드가 **진행 중 ↔ 리뷰** 를 오간다(에이전트가 working 이면 진행 중)
- `commit.sh`: 지정 파일만 스테이징 → 엄격 검증(같은 트리로 이미 통과했으면 `♻️ 재사용` — `scripts/verify/reuse.sh`) → 검증 전후가 같을 때만 커밋 → 계획서 `## Commits` 기록. 메인 체크아웃 · 보호 브랜치 · 남의 스테이징 · 검증 실패면 **거부**하고 이유를 전해 사용자에게 묻는다
- **레포 하나짜리 작업은(경량 · 정식 무관) pane 에서 끝까지** — 작업 → 리뷰 → 커밋 → PR. 리뷰는 커밋 전 변경까지 포함한 내용을 기록하므로 커밋 전후 어느 쪽이어도 되고, 승인이 없어도 커밋 · PR 이 막히지는 않는다(승인 전이면 묻지 않고 올리되 PR 본문 "확인 필요" · 보고에 적는다). 아테나로 돌아오지 않는다
- 리뷰 기준(넓은 수정에만 · 2026-10-25 사용자): 자동 리뷰는 정식 계획서(여러 레포 포함)의 넓은 수정만 — 에이전트가 보고하면 묻지 않고 바로 띄운다(리뷰 지적 반영 · 문구 · 문서 · 작은 수정 · 조사뿐 · 승인 뒤 바뀐 게 없으면 생략). 경량은 넓은 수정일 때만 보고 끝에 "리뷰할까요?"(`delegate.sh` 가 계획서 종류로 지시를 고른다). 리뷰어는 같은 트리로 통과한 검증을 다시 돌리지 않고 재사용한다
- 리뷰에서 **결정 필요**(선택지가 갈림)가 나오면 그 에이전트가 같은 계획서에 덧붙여 결정 콘솔로 보여 준다(`plan-html.mjs --add` → `board.sh open`, [이대로 진행] 은 그 에이전트 pane 으로 — 경량 계획서도 이때 html 이 생긴다). **수정 필요**(고칠 방법이 하나)는 묻지 않고 고친 뒤 한 줄씩 알린다(고친 뒤 다시 리뷰를 띄우지도 묻지도 않는다 — 고친 범위가 넓을 때만)
- **리뷰 뒤 결정 콘솔** — reviewer 보고의 "결정 필요"(R1 · R2…)는 말로 묻지 않는다:
  1. 계획서 md 에 `## 리뷰 뒤 결정` 절(항목 · 선택지 · 추천)을 적는다
  2. 결정 JSON 을 만든다 — 배열 `[{ id:'r1', title:'R1 <제목>', desc:'<영향>', type:'single', required:true, options:[{ label:'A <선택지>', desc:'<설명>', recommended:true }, { label:'B …', desc:'…' }] }]`. reviewer 의 `A <선택지>` 를 label 로 그대로 옮긴다(형식 정본 `docs/plan-template.html` 헤더 주석)
  3. `node scripts/plan-html.mjs <계획서> --add <JSON>` → `scripts/board.sh open <계획서>` 로 열고 기다린다. id 가 이미 있으면 `--add` 가 다음 번호(r3…)로 바꿔 알려 준다
  4. 사용자가 [이대로 진행] 하면 `[작업계획서 결정사항 확정]` 프롬프트가 이 pane 으로 온다. 대화로 "추천대로" · "R1 은 B" 처럼 답해도 같다 — 콘솔을 다시 누르라고 하지 않는다
  5. md `리뷰 뒤 결정` 절에 확정값을 적고 `node scripts/plan-html.mjs <계획서> --decide r1='<고른 label>' [r2='…']` 로 콘솔에 확정을 기록한다. `--data` 로 PLAN 전체를 바꾸지 않는다 — 기존 결정이 지워진다
  6. 그다음 고친다. 고친 뒤 다시 리뷰는 위 기준대로(경량은 다시 묻지 않고, 정식은 고친 범위가 넓을 때만)
- 리뷰 띄우기: `delegate.sh reviewer --cwd <워크트리> --here` → 결론은 `review-result.sh` 로 계획서에 · 기다리기는 `review-wait.sh --plan <계획서> --dir <워크트리>`
- "PR 올려줘" 한 마디 → 커밋 안 된 작업을 `commit.sh` 로 커밋 → `scripts/ship.sh` 미리보기 초안 → 제목 · 본문 정리 → **묻지 않고** `prBase` 로 draft PR(보고 끝에 📚 배운 것 — `learning.md` 8절 · `git.md` "PR 올리기" · "PR 제목·본문")
- **PR 자동 리뷰 · 수정 · 머지**(`"autoMerge": true` 레포의 레포 하나짜리 PR · 기본 꺼짐): 켠 레포는 검증이 통과하면 "PR 올려줘" 없이 draft PR 까지 가고, 현황판이 감지해 Claude · Codex 가 리뷰한다. 리뷰 · 머지는 레포마다 끄거나 고를 수 있다. 자동 PR 을 끄면(`autoPr: false`) PR 없이 `ship.sh --direct-merge` 로 `prBase` 에 바로 머지한다(검증은 어느 설정에서도 필수). 라운드 · 상한 · 막는 지적 · 머지 확인은 `docs/pr-auto.md`

## 5. 검증 · 보고 · push/PR
- 자동 리뷰가 고를 것 없이 멈추면(리뷰어 부족 · 라운드 상한 · 잘린 diff 승인 · 검증 대기 · 충돌 · 지시를 보낼 pane 없음) `[자동 리뷰 → 아테나] …` 한 줄로 아테나 pane 에 온다 — 아테나가 이어받는다(계획서 `- Auto review:` 줄 · PR 댓글로 원인을 보고 작업 pane 에 지시 · 환경을 고친 뒤 그 줄을 지워 다시 돌리기 · 아테나 pane 이 없으면 요청으로 남는다 — `docs/pr-auto.md` "아테나에 알림")
- 보고는 무엇이 달라졌나 · 어디서 확인하나(화면 주소 · PR · 파일) · 검증 결과 · 남은 일 순. 변경 파일 목록 · 검증 표 · `## Commits` 는 계획서에 있으니 필요한 것만 옮긴다
- 정식이면 Checkpoint 를 고칠 때 html `plan-md` 도 같은 턴에 맞춘다(`node scripts/plan-html.mjs <md>` · `commit.sh` · 현황판도 맞춘다)

## 6. 정리
- **자동 보관** — 계획서 PR 이 모두 머지돼 완료(PR 없는 계획서는 완료) + 배우기 검토 끝(또는 대상 아님) + 그 계획서에 묶인 에이전트 pane 이 모두 닫히면 현황판이 그 자리에서 보관한다(2026-10-26 결정 D4). 묶인 pane = Work ref · Review 줄의 pane 과 그 계획서로 띄운 pane 전부(`state/pane-sessions` 기록 — 같은 계획서로 여러 번 띄워 Work ref 가 바뀌어도). 이슈는 연결 계획서와 함께, 계획서 없는 이슈는 완료되면
- 보관 자리 — 이슈 · 계획서를 **`archive/<이름>/` 한 폴더**(`issue.md` · `plan.md` · `meta.json`)로 묶어 **git 에 커밋**한다(`archive/` 는 팩 링크라 팩 레포에 커밋된다). **공유되는 건 `archive/` 뿐** — 진행 중 · 리뷰 · 완료의 이슈(`issues/*.md`) · 계획서(`plans/**`)는 각자 로컬(`.gitignore`). 이슈 워크트리도 정리(미커밋 · push 안 된 커밋이 있으면 남긴다). 지나간 일은 현황판 **[아카이브]** 탭
- **자동 완료** — 계획서 `PR:` 줄의 PR 이 모두 머지되면(어느 base 든 — GitHub `MERGED`) 현황판이 그 계획서를 `Status: done — 자동 — PR #N 이 <base> 에 머지됨` 으로 옮긴다(진행 중 · 리뷰 계획서만 · 5분마다 `gh pr view`). 완료된 계획서에 이어 PR 을 올리면 켠 레포는 `ship.sh` · 현황판이 리뷰로 되돌려 자동 리뷰를 태운다(`docs/pr-auto.md` "무엇이 대상인가"). 머지 없이 닫힌 PR(`CLOSED`)은 판정에서 빼고, 머지된 PR 이 하나도 없으면 옮기지 않는다. **Progress 에 빈 칸(`- [ ]` — 맨 앞이든 들여 쓴 하위 칸이든)이 있으면 옮기지 않는다**(단계 PR 사이 틈에 완료 · 보관되지 않게 · 2026-10-27 · 하위 칸은 2026-10-29부터). PR 자동 리뷰가 머지한 PR 도 같다
- 이슈 완료 — `docs/issues.md` "완료 기준"(확인 결과 · 후속 정리 · fix 커밋 · 계획 done + PR MERGED)이 채워지면 `완료 가능` 배지 → 아테나가 완료로 옮긴다. 덜 찼으면 남은 것을 알린다
- **학습** — 에이전트(작업 끝 · 교정 · 같은 오류 3회)와 배우기 검토자(내 작업 PR 이 머지되면)가 올린 후보는 현황판 **[학습] 탭**(기준 `learning.md`). 사용자가 [넣기] · [고쳐서 넣기] · [버리기] — 넣으면 공책(`gotchas.md`) 끝 `## 학습` 절에 한 줄, 쉬운 설명은 `docs/knowledge/learned/`. 학습한 내용도 그 탭에서 수정 · 삭제. 스킬 후보는 [아테나에게 맡기기] → 아테나가 만든다(`docs/extending.md` "학습으로 스킬 만들기"). 팀 공유는 사용자가 "커밋해줘" 할 때 main 에. `/sync` 끝에 `scripts/learn-curator.mjs --write` 가 30일 넘게 안 쓴 스킬을, `scripts/gotchas-check.mjs --write` 가 운영 코드에서 사라진 파일을 가리키는 공책 줄과 나눌 때가 된 공책(공통 2만 자 · 같은 화면 5줄 → `gotchas/<폴더>.md`)을 정리 후보로 올린다(지우지 않는다 — 줄마다 [지우기] · [그대로 두기], 나누기는 [아테나에게 맡기기])
- 후속 작업이 남았으면 그대로 둔다. 안전망: `scripts/archive-plans.sh`(30일 이상 + 최근 git log 미언급 plan 일괄 이동)

## 명령 (슬래시 커맨드 자세히)
| 명령 | 용도 |
|---|---|
| `/call` | `/call <에이전트>` — 담당 에이전트를 그 레포 workspace 에 pane 으로 바로 띄운다. 브랜치를 먼저 물어 워크트리를 만들고 그 폴더에서 띄운다. 요청 · 커밋 · 리뷰 · PR 은 pane 에서 직접(빈 지시 경량 계획서) |
| `/monitor` | 백그라운드 서브에이전트 · 워크트리 pane 에이전트 로그를 어디서 보는지 — Athena Studio 는 앱 아래 AGENT MONITOR 칸, 화면 밖이면 직접 실행할 명령(`/monitor 30` = 최근 30분) |
| `/board` | 현황판 — 로컬 서버를 띄워 브라우저에서 실시간으로. 첫 화면은 **해결할 이슈 목록**(`issues/` — 학습 후보 제외 · 열린 이슈는 [작업 시작] · 시작한 이슈는 맡은 pane) · **[QA]**(서비스 → 층 → 흐름별 TC 결과 · 실패 원문 · 문서 링크 · [실행]) · **[학습]**(아테나 학습: 후보 넣기 · 버리기 · 학습한 내용 수정 · 삭제 / 클로드 학습: Claude Code 메모리) · **[아카이브]** · **[지표]**(완료 · 평균 소요 · 작업당 질문 · 평균 답 대기 · 검증 실패율 · 리뷰 반려율 — `docs/events.md`). 계획서 칸반 · [정비] 탭은 없다(2026-10-26) — 계획서 진행은 Studio [작업] 팝업과 pane [상세]. 서버는 화면을 안 열어도 PR 머지 자동 완료 · 끝난 일 자동 보관 · 학습 대기열을 맡는다(`/board stop`) |
| `/sync` | 담당 레포의 운영 기준 브랜치를 훑어 지문을 만들고 사실마다 정한 정본(knowledge · config · 지문)만 갱신. 파생 문서는 `node scripts/build-derived.mjs`, 바뀐 코드에 닿는 흐름 찾기는 `node scripts/qa/affected.mjs` · 확정(`--accept`)하면 바뀐 서비스의 TC 가 뒤에서 돈다 |
| (회사 스킬) | 팩 `pack/ROUTING.md` "회사 스킬" 표 — 팩 `skills/` 가 `.claude/skills/` 에 링크된다 |
| `/guide` | 오른쪽 pane 에 가이드 메뉴(문서 · 스킬 목록 · 실행 · 에이전트 · 라우팅). `/guide <파일>` 은 뷰어, `/guide 설명` 은 아테나 구조 설명 HTML, `/guide 열기` 는 플레이북, `/guide 시작하기` 는 시작하기 가이드, `/guide 그림` 은 **다이어그램 목록**(작업 흐름 경량 · 정식 + 팩 서비스 × 구조 · 화면 맵 · 요청 흐름) |

## 말로 하는 일 (커맨드가 없는 것)
- QA — "<서비스> QA 돌려줘" → `scripts/heavy.sh node scripts/qa/run.mjs --service <서비스>`(현황판 QA 탭 [실행] 도 같다 · 형식과 옵션 `docs/knowledge/common/qa-flows.md`)
- 기능 · 버그 → 1단계 · 리뷰("리뷰해줘") → 5단계 `delegate.sh reviewer` · 현황("현황 알려줘") → `git.md` "현황 점검" · 브랜치 → 3단계(`git.md` "작업 브랜치 만들기")
- 팩 백업("팩 백업해줘") → `bin/athena pack backup` · 되살리기 `bin/athena pack restore <파일>` — 여러 팩 구조면 `pack backup --with-work` · `pack restore --with-work <파일>`(팩만은 `pack export`) — `docs/pack.md` "백업 · 되살리기"
- 여러 팩("팩 목록" · "팩 열어줘 <id>") → `bin/athena pack list` · `pack open <id>` — 팩마다 본체(`~/.athena-studio/bodies/<id>`)가 따로라 동시에 켠다. 열린 본체 폴더에서 아테나를 켠다(스튜디오는 창마다 팩)
- 코어 업데이트("아테나 업데이트해줘") → 코어는 Athena Studio 앱과 함께 온다 — 앱을 업데이트하면 켜질 때 `bin/athena update --from <번들>` 로 본체마다 맞춘다(일하는 본체는 건너뛰고 표시 · 되돌리기 `update --rollback`)
- 정비(코어 고치기) → 코어 담당 에이전트가 코어 정본 레포(Athena Studio 레포 `athena/`)에서 브랜치 · PR 로 — 주 본체 · 팩 본체(설치본)에서는 고치거나 커밋하지 않는다(`docs/pack.md` "여러 팩")
- Jev 키("Jev 키 등록해줘" · "바꿔줘" · "지워줘") → `docs/setup.md` 7-2 — 키는 옆 입력 창에 사용자가 직접, 대화로 받지 않는다
