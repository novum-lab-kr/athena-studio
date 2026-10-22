# 팩 백업 → 가져오기로 "그대로" 되살리기 — 화면 배치 · 에이전트 대화 · 작업 중이던 코드

## Checkpoint
- Updated: 2026-10-22 / Claude — 1~3단계 구현 · Codex 구현 검토 8건 반영 · 코어 시험 118 통과
- Status: in_progress
- Owner: Mason
- Scope: athena-studio — 앱 `src/` + 코어 `athena/`
- Work ref: main f9b0b7f
- Approved scope: 2026-10-22 대화 — "팩 저장해 두고 가져오기 하면 그대로 다" · 범위 = 화면 배치 + 에이전트 대화 이어 하기 + 작업 중이던 코드(사용자 선택)

### Progress
- [x] 현황 조사
- [x] Codex 검토 — 5절
- [x] ① 확인 — 대화 기록(jsonl)을 다른 cwd 의 프로젝트 폴더(`~/.claude/projects/<cwd 의 / . → ->`)로 옮기고 그 cwd 에서 `claude --resume <id>` → 이어짐(2026-10-22 실측 · 기억시킨 단어를 답함)
- [x] 1단계 — pane ↔ 대화 기록(코어 훅 `scripts/hooks/pane-session.py` · SessionStart + UserPromptSubmit · 본체 · delegate · agent-context 세 설정)
- [x] 2단계 — 백업에 담기(코어 `lib/restore.mjs` captureRestore · 앱이 claude 도는 pane 을 `--panes` 로)
- [x] 3단계 — 가져온 뒤 되살리기(코어 `pack restore-work` · 앱 [열고 작업 되살리기] · 아테나 `claude --resume` + `--ack`)
  - 설계 바꿈: 화면 배치는 데몬 상태를 담지 않고 delegate.sh 의 배치 규칙(작업 공간 = 레포 · 한 탭에 나란히)으로 다시 놓는다 — 원래도 delegate 가 놓은 배치라 같은 모양이 된다(분할 비율은 기본값)
- [ ] 4단계 — 시험 · 문서 (코어 시험 · docs/pack.md · README 끝 — 손 확인 남음)

## 1. 지금
- 백업(`pack backup --with-work`)은 팩 · 계획서 · 이슈 · 레포 자리(local.json)만. 초기화하면 사라지는 것:
  - **화면** — 데몬의 작업 공간 · 탭 · pane(분할 비율) · 이름. 데몬은 pane 마다 `cwd` · 도는 프로그램(`agent: claude`)을 안다. 대화(세션) id 는 모른다
  - **대화** — Claude 기록은 `~/.claude/projects/<cwd 를 - 로 바꾼 이름>/<세션>.jsonl` — 스튜디오 집 **밖**이라 초기화돼도 남는다. 같은 팩 id 로 되살리면 워크트리 경로(`<데이터>/packs/<id>/worktrees/<레포>/<브랜치>`)가 같아 `--resume` 이 그대로 된다. 본체 경로(`bodies/<…>`)는 바뀔 수 있다(이번에 `new-…` → `novum-lab`)
  - **코드** — 워크트리(`<데이터>/packs/<id>/worktrees/…`)는 폴더째 지워진다. 커밋은 레포(`repos/<레포>` 가 가리키는 사용자 레포)의 브랜치에 남고, **미커밋 변경만** 잃는다. 레포 쪽 `.git/worktrees/<이름>` 은 prunable 로 남는다
- 이미 있는 손잡이: `delegate.sh <에이전트> --plan <계획서> --resume <세션> --cwd <워크트리>` — 닫힌 에이전트 pane 을 그 대화로 다시 연다. 계획서 Work ref 에 워크트리 · 브랜치 · pane 이 적힌다

## 2. 설계

### 2-1. pane ↔ 대화 기록 (코어 훅 · 새로)
- SessionStart 훅 `scripts/hooks/pane-session.py` — `ATHENA_STUDIO_PANE_ID` 가 있으면 `<팩 데이터>/state/pane-sessions.json` 에 `{ paneId: { session, cwd, agent(ATHENA_AGENT · 없으면 athena), plan(있으면), at } }` 를 쓴다(덮어쓰기 · 원자적). 아테나 본체 세션 · delegate 에이전트 세션 모두(delegate 설정 파일에도 같은 훅)
- 데몬 pane id 는 데몬을 다시 띄우면 처음부터라 **백업 시점의 살아 있는 pane** 과 (id · cwd) 둘 다 맞을 때만 쓴다

### 2-2. 백업에 담기
- 코어 `pack backup --with-work [--screen <json 파일>]`
  - `worktrees/` — 워크트리마다 `{ repo, path(팩 데이터 기준), branch, head }` + 미커밋 변경 `<이름>.patch`(`git diff --binary HEAD`) + 추적 안 하는 파일 목록 · 내용(비밀 이름 · `.env*` · 키 · `node_modules` 빼고 · 크기 한도). `worktrees.json`
  - `screen.json` — 앱이 넘긴 화면 상태를 그대로(검사만): 작업 공간(라벨 · cwd 를 `{body}` · `{pack}` 자리표로) · 탭 · 분할 트리 · pane 마다 `{ cwd(자리표), agent, session, plan }`
  - `sessions/` — 화면에 나온 세션의 기록(`.jsonl` · 하위 에이전트 폴더) 사본 — 다른 컴퓨터 · 기록이 지워진 경우용
- 앱 — [내보내기 → 팩 + 내 작업 기록] 때 데몬 상태 + `pane-sessions.json` 으로 `screen.json` 을 만들어 `--screen` 으로 넘긴다(지금 창 · 이 팩 본체의 작업 공간만)

### 2-3. 가져온 뒤 되살리기
- 코어 `pack import --new|--replace` — 백업에 `worktrees/` · `screen.json` · `sessions/` 가 있으면 `<팩 데이터>/state/restore/` 에 그대로 둔다(바로 실행하지 않는다)
- 코어 `pack restore-work <id>`(새 명령 · 본체에서) — 워크트리 되살리기: 레포가 이어져 있으면 `git worktree prune` → 브랜치가 있으면 `worktree add <path> <branch>`(없으면 `head` 로 새 브랜치 — 다른 컴퓨터에서 push 안 한 커밋은 없다고 알림) → patch · 추적 안 하는 파일. 이미 폴더가 있으면 건너뜀. 결과 `{ restored, skipped[{ path, reason }] }`
- 앱 — 팩을 열었는데 `state/restore/screen.json` 이 있으면 한 번 묻는다: "백업 때 화면을 되살릴까요? — 작업 공간 N · pane M(에이전트 K)" → [되살리기] [나중에] [버리기]
  - 되살리기: `restore-work` → 화면(작업 공간 · 탭 · 분할) 만들기 → pane 마다: 아테나는 본체에서 `claude --resume <세션>` · 에이전트는 `delegate.sh <에이전트> --plan <계획서> --resume <세션> --cwd <워크트리>`. 세션 기록이 없으면 `sessions/` 사본을 새 cwd 이름 폴더로 복사해 넣고 잇는다
  - 끝나면 `state/restore/` 를 지운다(버리기도)

## 3. 위험 · 정할 것
- 데몬 통신 — 화면을 한 번에 만드는 요청이 없으면 기존 요청(workspace create · pane split · run)을 여러 번 — PROTOCOL 은 그대로
- 비밀 — 추적 안 하는 파일은 비밀 이름 거르기(export 와 같은 규칙) · patch 안의 비밀은 못 거른다(커밋하지 않은 `.env` 수정 등은 추적 파일이면 담긴다) → 알림 문구
- 크기 — patch · 추적 안 하는 파일 · 대화 기록이 클 수 있다 — 한도(예: 합계 200MB)를 넘으면 담지 않고 알림
- `--resume` 은 Claude Code 동작에 기댄다 — 기록 폴더 이름 규칙(경로의 `/` · `.` → `-`)이 바뀌면 깨진다
- 같은 컴퓨터가 기본. 다른 컴퓨터는 push 안 한 커밋 · 레포 위치가 다르면 일부만

## 4. 검증
- 코어 `test/packs-test.sh` — 워크트리 patch 담기 · 되살리기(같은 브랜치 · 미커밋 · 추적 안 함 · 비밀 빠짐) · screen.json 검사
- 앱 `test/` — screen.json 만들기 · 자리표 바꾸기 · 되살리기 순서(순수 로직)
- 손 — 백업 → 초기화 → 가져오기 → [되살리기] → pane 배치 · 대화 이어짐 · 워크트리 미커밋 그대로

## 5. Codex 검토 반영(2026-10-22)
- **화면 먼저 만들고 delegate 를 부르면 다시 분할된다**(`delegate.sh:244 · 259`) → delegate 에 "기존 pane 에서 실행"(`--pane <id>`) 경로를 더하고, 설정 · 보호 훅 만들기는 그대로 재사용
- **pane id 는 데몬을 다시 띄워도 이어진다**(카운터를 파일로 — `daemon/main.js:48`) — 1절의 "처음부터" 는 틀림. 그래도 백업 때 (id · cwd) 를 같이 본다
- **같은 팩 id 로 돌아온다는 보장 없음**(`--new` 는 `pack.name` 으로 자리 — `packs.mjs:954`) → 경로는 자리표(`{body}` · `{pack}` · `{repo:<이름>}`)로 담고 되살릴 때 푼다. 세션 기록을 새 폴더로 옮겨 `--resume` 이 되는지는 **먼저 실제로 확인**
- **워크트리는 저장한 HEAD 기준** — 브랜치가 그 뒤로 움직였으면 HEAD 로 새 브랜치(`<브랜치>-restored`)를 따고 알림. staged / unstaged 를 나눠 담는다(`git diff --cached` · `git diff`). 폴더가 있으면 건너뛰지 말고 HEAD · 변경을 비교해 이미 되살린 것인지 판단 · 실패한 항목은 남겨 다시 시도
- **세션 원장** — 공유 JSON 하나 대신 pane 마다 파일(`state/pane-sessions/<paneId>.json`) · delegate 는 계획서를 환경(`ATHENA_PLAN`)으로 넘긴다 · 세 설정 경로(본체 · delegate 일반 · 외부 워크트리)에 훅
- **가져오기 경로 전체** — `finishInspect`(`packs.mjs:809`) · `importToken`(`:957 · :1006`) 이 plans · issues 말고는 버린다 → 백업 형식 버전(`athena-backup.json` `version: 2`) · 검사 · new / replace 정책
- **완료 판정** — `pane run` 성공은 글자를 보낸 것뿐 → 되살린 세션의 SessionStart 훅이 같은 세션 id 를 쓰면 그 항목을 완료로
- **보안** — 대화 기록(JSONL)은 소스 · 도구 출력 · 토큰이 섞일 수 있다(이름으로 못 거른다) · 가져온 cwd · session · plan · branch 는 셸 글로 이어 붙이지 않는다(검사 후 인자로) · 되살리기는 **가져온 팩의 코드(delegate 훅 등)를 실행**하는 것 — 묻는 글에 밝힌다 · 레포 전체 `worktree prune` 대신 그 자리만
- **순서** — ① 임시 환경에서 cwd 가 바뀐 뒤 `--resume` + 기존 pane 실행 확인 ② 백업 형식 · 자리표 · 부분 성공 · 다시 시도 약속 ③ HEAD 기준 워크트리 되살리기 ④ 세션 훅 · inspect / import 보존 ⑤ 창(ctx) 화면 담기 · 되살리기 ⑥ 초기화 왕복 · 브랜치 이동 · patch 실패 다시 시도 · 두 창 · 나쁜 경로 시험

## 6. 사용자 결정(2026-10-22 확정)
- D1 대화 기록(JSONL)을 백업 파일에 **담는다** — 다른 컴퓨터에서도 이어지게. 비밀이 섞일 수 있다는 것을 내보내기 창에 밝힌다
- D2 **다른 컴퓨터까지** — push 안 한 커밋도 담는다(워크트리 브랜치의 원격에 없는 커밋 → git bundle) · 레포 위치는 레포 연결(local.json · git 주소)로 푼다

## 7. 구현 검토(Codex · 2026-10-22) 반영
- 되살리기 환경에 `ATHENA_STUDIO=1`(delegate 의 screen inside) · 워크트리는 단계별 progress(HEAD 만으로 끝 판정 안 함 · staged 실패면 멈춤) · 아테나 대화는 앱이 켠 뒤 `--ack` · repo 이름은 워크트리 이름 앞부분 + `repos/` 링크만 · 부모 링크 거부 · 추적 안 하는 파일은 하나씩(링크 폴더 거치지 않게 · 덮지 않음) · 큰 patch 는 `incomplete` · 예약은 팩 id 에 묶고 다른 창이면 그 창에서 · 훅은 UserPromptSubmit 에도(이미 켠 세션) · 기록 없는 pane 은 `restore.missing`

## Validation
- 코어 `test/packs-test.sh` 118/118 — 되살리기 절: 훅 · missing · 대화 2(에이전트 · 아테나) · staged/unstaged/추적 안 함/.env 뺌/bundle · 검사 요약 · state/restore · dry-run · 워크트리 같은 HEAD · 대화 기록 · ack · 다시 돌림 · staged 실패 멈춤 → 고친 뒤 이어서 · discard · 다른 컴퓨터(커밋 없음 → bundle) · 나쁜 경로 거부
- 앱 `npm test` 142/142 · skip 0
